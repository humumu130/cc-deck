// W-AGGREGATE-V2 刀1（t-1c86f110，PCS 多 clone 场景）：git remote 探测器——
// 「同项目 clone 在多个目录」的归一信号源（tech-B §二方案：git remote 同源是唯一
// 能归一多 clone 的信号；cwd 只聚同目录，关键词只做加分项）。
//
// 形态（调研定档）：
//   - execFile("git", ["-C", cwd, "remote", "get-url", "origin"], {timeout:2500}) 异步
//    （勿仿 session-manager :8919 同步 execSync——那是单次派单口，扫描口是批量）；
//   - 无 origin 回退 `git remote` 列首个；非 git/失败=无信号（null）不告警（常态）；
//   - normDir(cwd) 去重 + TTL 24h 缓存（落 dataDir/dir-origins.json，纯 fs 原子写）；
//   - 并发帽 4（信号量）；入队标记（ensureExternal 入编边沿）→ 探测延迟到扫描拍
//    （patrol 全巡 30min）执行——热路径零子进程。
// 纯模块无环（org.ts 纪律）：不 import session-manager/patrol。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN_TTL_MS = 24 * 3600_000;
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 2500;

/** URL 归一（tech-B 确认口径）：去协议/去 .git 尾/去尾斜杠/host 小写——比 host+path。
 *  ssh 形态 git@host:path → host/path（与 https 同源可归一）。 */
export function normalizeRemoteUrl(raw: string): string {
  let u = String(raw || "").trim();
  if (!u) return "";
  u = u.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // https:// http:// ssh://
  u = u.replace(/\/+$/, ""); // 尾斜杠
  if (u.endsWith(".git")) u = u.slice(0, -4);
  const scp = u.match(/^([^@/]+)@([^:]+):(.+)$/); // git@host:path
  if (scp) u = `${scp[2].toLowerCase()}/${scp[3]}`;
  else {
    const i = u.indexOf("/");
    if (i > 0) u = u.slice(0, i).toLowerCase() + u.slice(i); // 仅 host 小写（path 大小写敏感）
  }
  return u;
}

/** 路径归一（端上 normDir 同口径：反斜杠→正斜杠+去尾斜杠）——缓存键/快照键统一。 */
export function normDirKey(dir: string): string {
  return String(dir || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
}

interface DirOriginStore {
  [normDir: string]: { origin: string | null; at: number };
}

let dataDirPath = "";
let cache: DirOriginStore = {};
const pending = new Set<string>();
let inFlight = 0;

function storePath(): string {
  return join(dataDirPath, "dir-origins.json");
}

export function initDirOriginStore(dataDir: string): void {
  dataDirPath = dataDir;
  try {
    if (existsSync(storePath())) cache = JSON.parse(readFileSync(storePath(), "utf-8")) as DirOriginStore;
  } catch { cache = {}; }
}

function persist(): void {
  try {
    mkdirSync(dataDirPath, { recursive: true });
    const tmp = storePath() + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache), "utf-8");
    renameSync(tmp, storePath());
  } catch { /* 缓存持久化尽力而为（丢缓存只损一次探测） */ }
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? "" : String(stdout || "").trim());
    });
  });
}

/** 单目录探测（含缓存命中）：origin 归一 URL；null=无信号（非 git/无 remote/超时——常态不告警）。 */
export async function probeDirOrigin(cwd: string, now = Date.now()): Promise<string | null> {
  const key = normDirKey(cwd);
  if (!key) return null;
  const hit = cache[key];
  if (hit && typeof hit.at === "number" && now - hit.at < ORIGIN_TTL_MS) return hit.origin;
  let origin: string | null = null;
  const direct = await execGit(cwd, ["remote", "get-url", "origin"]);
  if (direct) origin = normalizeRemoteUrl(direct);
  else {
    const list = await execGit(cwd, ["remote"]); // 无 origin（可能叫 upstream）回退列首个
    const first = list.split("\n").map((x) => x.trim()).filter(Boolean)[0];
    if (first) {
      const url = await execGit(cwd, ["remote", "get-url", first]);
      origin = url ? normalizeRemoteUrl(url) : null;
    }
  }
  cache[key] = { origin, at: now };
  persist();
  return origin;
}

/** 入编边沿标记（ensureExternal 后）：只入队零子进程——探测延迟到扫描拍。 */
export function enqueueDirOriginProbe(cwd: string): void {
  const key = normDirKey(cwd);
  if (key && !cache[key]) pending.add(key);
}

/** 扫描拍排水（patrol 全巡调）：pending 全量 + 显式补充（如全量未探测 cwd），并发帽 4。 */
export async function drainDirOriginProbes(extraDirs: string[] = []): Promise<number> {
  for (const d of extraDirs) enqueueDirOriginProbe(d);
  const batch = [...pending];
  pending.clear();
  let probed = 0;
  const queue = [...batch];
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const cwd = queue.shift()!;
      if (inFlight >= PROBE_CONCURRENCY) { /* worker 数即帽——恒不越 */ }
      inFlight++;
      try { await probeDirOrigin(cwd); probed++; } finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(batch.length, 1)) }, worker));
  return probed;
}

/** 快照面：normDir → origin（仅非 null——端上桶元数据消费；null 无信号不下发减噪）。 */
export function dirOriginsMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cache)) if (v && v.origin) out[k] = v.origin;
  return out;
}

/** 测试面：直接写缓存（stub execFile 之外的最短夹具路径）+清场。 */
export function __testSeed(entries: DirOriginStore): void { cache = { ...entries }; }
export function __testReset(): void { cache = {}; pending.clear(); inFlight = 0; }
