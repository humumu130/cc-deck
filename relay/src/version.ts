// ---------- relay 版本单源 + 通道序比较 + 让位决策（#296 relay 单通道收敛：谁新谁赢+版本可见） ----------
// 版本链（高→低）：CCR_RELAY_VERSION 显式 env（壳 spawn 内嵌 relay 时注入壳版本——
// Resources 不打包 plugin.json 时文件链落空，env 是内嵌形态主路径；测试注入同口）>
// bundle 邻位 plugin.json（插件形态：relay.mjs 与 plugin.json 同根，build-plugin 从
// 仓库根 VERSION 烙印=与插件清单同源）> 仓库根 VERSION（dev/tsx 直跑）> "0.0.0-dev"
// 兜底（探测链全空——比较时恒为最旧，让位协议天然倾向占用者，保守方向安全）。
//
// semver 移植自 expo-app/src/updates.ts（仓库既有唯一实现，铁律「复用不重写」；
// 跨包 import 不现实故函数体等价移植，语义锚保持一致）：core 三段数值优先；core
// 相等正式 > 预发布（0.7.0 > 0.7.0-test.72）；同为预发布比通道序号（test.73 >
// test.9）；壳通道烙印后缀（-nova/-mac）透明不参与比较（test.27-nova ≡ test.27）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** 本 relay 版本（进程内缓存——部署面文件不热变） */
export function resolveRelayVersion(): string {
  if (cached !== null) return cached;
  cached = doResolve();
  return cached;
}

/** 测试口：清缓存（env 注入后重算） */
export function resetRelayVersionCacheForTest(): void {
  cached = null;
}

function doResolve(): string {
  const fromEnv = (process.env.CCR_RELAY_VERSION ?? "").trim();
  if (fromEnv) return fromEnv;
  // 候选探测（webRoot 同款纪律）：dist/relay.mjs → 插件根 plugin.json；
  // src/ 直跑 → 仓库根 VERSION。谁的先用谁，全空落兜底。
  const candidates = [
    fileURLToPath(new URL("../", import.meta.url)),
    fileURLToPath(new URL("../../", import.meta.url)),
  ];
  for (const dir of candidates) {
    try {
      const p = join(dir, "plugin.json");
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, "utf-8")) as { version?: unknown };
      const v = typeof raw.version === "string" ? raw.version.trim() : "";
      if (v) return v;
    } catch { /* 坏文件落下一档 */ }
  }
  try {
    const v = readFileSync(join(candidates[1]!, "VERSION"), "utf-8").trim();
    if (v) return v;
  } catch { /* dev 兜底 */ }
  return "0.0.0-dev";
}

// ---------- semver（与 expo-app/src/updates.ts 等价移植，断言锚见文件头） ----------
// #130 同源修正：pre 段允许连字符（-nova 壳通道烙印），否则 0.7.0-test.27-nova
// 整串落 core [0,0,0] 被任意 0.7.x 判大。
export function parseSemver(v: string): { core: number[]; pre: string | null } {
  const m = String(v).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/);
  if (!m) return { core: [0, 0, 0], pre: String(v) || null };
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** 通道后缀透明化：pre 首个 "-" 后缀不参与比较（test.27-nova ≡ test.27） */
export function preKey(pre: string | null): string | null {
  return pre === null ? null : pre.split("-")[0];
}

/** candidate 是否比 baseline 新（core 相等正式>预发；同预发比通道序号；全等=false） */
export function isRelayNewer(candidate: string, baseline: string): boolean {
  const c = parseSemver(candidate);
  const b = parseSemver(baseline);
  for (let i = 0; i < 3; i++) {
    if ((c.core[i] ?? 0) !== (b.core[i] ?? 0)) return (c.core[i] ?? 0) > (b.core[i] ?? 0);
  }
  const cp = preKey(c.pre);
  const bp = preKey(b.pre);
  if (!cp && bp) return true; // 正式 > 预发布
  if (cp && !bp) return false;
  if (cp && bp) {
    const cn = Number((cp.match(/\d+/g) ?? ["0"]).pop());
    const bn = Number((bp.match(/\d+/g) ?? ["0"]).pop());
    if (cn !== bn) return cn > bn;
    return cp > bp;
  }
  return false;
}

// ---------- 占用者探测 + 让位决策（纯函数，沙盒断言覆盖三态） ----------
export type OccupantProbe =
  | { kind: "version"; version: string }
  | { kind: "no-interface" }  // 有 HTTP 应答但无版本口（老 relay：403/404/非 JSON）
  | { kind: "unreachable" };  // 连不通（非 HTTP 占用者/防火墙）——按旧处置

/** 探测 127.0.0.1:port 的占用者 /api/version（带 bridge-token；同 dataDir 同 token
 *  互探可达，异 dataDir 403 → no-interface——跨目录本就无权互探，按旧提示用户） */
export async function probeOccupant(port: number, bridgeToken: string, timeoutMs = 1_500): Promise<OccupantProbe> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
      headers: { "x-bridge-token": bridgeToken },
      signal: ac.signal,
    });
    if (res.status !== 200) return { kind: "no-interface" };
    const body = (await res.json().catch(() => null)) as { relay?: unknown } | null;
    const v = body && typeof body.relay === "string" ? body.relay.trim() : "";
    if (!v) return { kind: "no-interface" };
    return { kind: "version", version: v };
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export type YieldDecision = { action: "yield"; reason: string } | { action: "contend"; reason: string };

/** 让位决策（谁新谁赢）：占用者 ≥ 本版 → yield（先到先得保持，同版不互抢）；
 *  更旧/无版本口/探不通 → contend（warn 指引+延迟退——relay 永不杀同行，仲裁权
 *  在壳一键接管与用户）。纯函数：文案在这里单源，ws-server 只消费。 */
export function decideYield(own: string, probe: OccupantProbe): YieldDecision {
  if (probe.kind === "version") {
    if (!isRelayNewer(own, probe.version)) {
      return { action: "yield", reason: `端口已被 v${probe.version} 占用（本版 ${own}，占用者 ≥ 本版）` };
    }
    return { action: "contend", reason: `端口被旧版 v${probe.version} 占用（本版 ${own}）。建议：重启 Claude Code（插件 relay 随会话更新）或让 CC Deck 壳一键接管` };
  }
  if (probe.kind === "no-interface") {
    return { action: "contend", reason: `端口被旧版 relay（无版本接口）占用（本版 ${own}）。建议：重启 Claude Code 或让 CC Deck 壳一键接管` };
  }
  return { action: "contend", reason: `端口被未知进程占用（本版 ${own}，探测不通）。建议：让 CC Deck 壳一键接管或手动排查 8787` };
}
