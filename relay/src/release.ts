// 发版管理面板 relay 编排（W-CMDIMPL ③，#216；设计 docs/cmdprod-design.md §3）
// 纪律四条（§3.2）：
//   ① script 路径硬编码常量表不进 config（B 路 P0-2：config-set 可写任意路径=远程
//      任意脚本执行面——通道→脚本映射是源码常量，新通道=改代码发版不走配置）
//   ② execFile 参数化对称条款：bash [script, note] argv 数组禁 shell 拼接
//   ③ CF token 不落盘：config 只存 env 变量名引用，spawn 时 process.env 透传
//   ④ 出包纪律不破：脚本内基线守卫/配对闸原样生效，relay 零绕过口子；test 包从分支出
//      不碰 dev 的铁律由前置机械闸对齐（主仓 dev+porcelain 干净才可跑）
// 编排边界：脚本一字不改（既有断言闸+失败即停语义保留）；relay 只 spawn+stdout 解析。
// 部署边界（§3.2）：仅本机语义——主仓/脚本/ECS ssh key 全在本机，云端 relay 返回
// {error:"no_release_env"}+relay_source 供 UI 置灰。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { EventBus } from "./event-bus.js";

/** 通道→脚本映射（源码常量，B 路 P0-2 红线；新通道=改代码发版） */
export const RELEASE_CHANNELS: Record<string, string> = {
  "apk-test": "scripts/build-test-apk.sh",
  "desktop-test": "scripts/build-test-desktop.sh",
};

/** 主仓根：relay 编排的 cwd（脚本内相对路径/基线守卫都锚它）。env 覆盖（测试/非标
 *  安装），缺省 Mac 开发机主仓。 */
export function mainRepoRoot(): string {
  return process.env.CCR_MAIN_REPO || join(homedir(), "dev", "cc-deck");
}

interface ReleaseConfig {
  ecs_host?: string;
  ecs_dir?: string;
  kv_namespace?: string;
  channels: { id: string; enabled: boolean; note?: string }[];
}

interface ReleaseJob {
  run_id: string;
  channel: string;
  started_at: number;
  child: ChildProcess;
}

export interface ReleaseRunRecord {
  run_id: string;
  channel: string;
  note?: string;
  started_at: number;
  finished_at?: number;
  status: "running" | "done" | "failed" | "interrupted";
  exit_code?: number;
  urls?: string[];
  log_file?: string;
}

export class ReleaseModule {
  private jobs = new Map<string, ReleaseJob>(); // 单飞互斥：channel → job
  private progress = new Map<string, string>(); // 段落级最新行（轮询消费——RELEASE_* 事件的 HTTP 快照面）
  private bus: EventBus;
  private dataDir: string;

  constructor(bus: EventBus, dataDir: string) {
    this.bus = bus;
    this.dataDir = dataDir;
  }

  private configPath(): string {
    return join(this.dataDir, "release-config.json");
  }
  private historyPath(): string {
    return join(this.dataDir, "release-history.json");
  }

  /** 发版环境存在性（§3.2 部署边界）：主仓+脚本任一缺席=非本机源 */
  hasReleaseEnv(): boolean {
    const root = mainRepoRoot();
    if (!existsSync(join(root, "VERSION"))) return false;
    return Object.values(RELEASE_CHANNELS).some((s) => existsSync(join(root, s)));
  }

  configGet(): { ok: true; data: Record<string, unknown> } {
    let cfg: ReleaseConfig = { channels: Object.keys(RELEASE_CHANNELS).map((id) => ({ id, enabled: false })) };
    try {
      const raw = JSON.parse(readFileSync(this.configPath(), "utf-8")) as ReleaseConfig;
      // channels 与常量表对齐（脚本映射不在 config——读侧合并展示开关态）
      const byId = new Map((raw.channels ?? []).map((c) => [c.id, c]));
      cfg = {
        ecs_host: raw.ecs_host,
        ecs_dir: raw.ecs_dir,
        kv_namespace: raw.kv_namespace,
        channels: Object.keys(RELEASE_CHANNELS).map((id) => byId.get(id) ?? { id, enabled: false }),
      };
    } catch {}
    let version = "";
    try { version = readFileSync(join(mainRepoRoot(), "VERSION"), "utf-8").trim(); } catch {}
    return {
      ok: true,
      data: {
        ...cfg,
        script_map: RELEASE_CHANNELS, // 只读展示（可执行的通道面=源码常量）
        version,
        main_repo: mainRepoRoot(),
        has_release_env: this.hasReleaseEnv(),
        running: [...this.jobs.values()].map((j) => ({ run_id: j.run_id, channel: j.channel, started_at: j.started_at })),
        progress: Object.fromEntries(this.progress),
        latest: this.listHistory(10),
      },
    };
  }

  configSet(payload: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    // 红线：config 不收 script 字段（P0-2——有也丢弃不落盘，调用方无从注入路径）
    const clean: ReleaseConfig = { channels: [] };
    if (typeof payload.ecs_host === "string") clean.ecs_host = payload.ecs_host;
    if (typeof payload.ecs_dir === "string") clean.ecs_dir = payload.ecs_dir;
    if (typeof payload.kv_namespace === "string") clean.kv_namespace = payload.kv_namespace;
    if (Array.isArray(payload.channels)) {
      for (const c of payload.channels) {
        if (c && typeof c.id === "string" && RELEASE_CHANNELS[c.id]) {
          clean.channels.push({ id: c.id, enabled: c.enabled === true, ...(typeof c.note === "string" ? { note: c.note } : {}) });
        }
      }
    }
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.configPath(), JSON.stringify(clean, null, 2) + "\n", "utf-8");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `配置写入失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 前置机械闸（B 路 P2-2）：主仓当前分支==dev 且 porcelain 干净——多 worktree 并行期
   *  主仓任意分支/脏态=0927 坏包同族风险。不满足拒跑。 */
  precheck(): { ok: true } | { ok: false; error: string } {
    const root = mainRepoRoot();
    try {
      const branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
      if (branch !== "dev") return { ok: false, error: `主仓当前在 ${branch} 分支（发版要求 dev 干净主干）` };
      const dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf-8" });
      if (dirty.trim()) return { ok: false, error: `主仓有未提交改动 ${dirty.trim().split("\n").length} 处（先收口再出包）` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `主仓 git 不可用: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** run 编排：spawn 脚本（一字不改）+ stdout 节流聚合（段落级行进事件流，原始逐行
   *  只落日志文件——desktop CI 轮询千行级 stdout 不灌 events.ndjson，B 路 P2-1） */
  run(payload: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
    if (!this.hasReleaseEnv()) {
      return { ok: false, error: "no_release_env" };
    }
    // 二次确认（拍板 #8：UI confirm + 请求 confirm:true 双保险——推 KV/ECS 不可逆）
    if (payload.confirm !== true) return { ok: false, error: "需二次确认（confirm:true）——出包后已装设备无法撤回" };
    const channel = typeof payload.channel === "string" ? payload.channel : "";
    const script = RELEASE_CHANNELS[channel];
    if (!script) return { ok: false, error: `未知通道: ${channel}` };
    if (this.jobs.has(channel)) return { ok: false, error: "该通道已有出包进行中（单飞互斥）" };
    const pre = this.precheck();
    if (!pre.ok) return pre;
    const note = typeof payload.note === "string" ? payload.note : "";

    const runId = `rel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const histDir = join(this.dataDir, "release-history");
    mkdirSync(histDir, { recursive: true });
    const logFile = join(histDir, `${runId}.log`);
    const record: ReleaseRunRecord = { run_id: runId, channel, ...(note ? { note } : {}), started_at: Date.now(), status: "running", log_file: logFile };

    // env 透传（CF token 只经 env 引用——拍板 #7；argv 数组化——拍板 P0-2 对称条款）
    const child = spawn("bash", [join(mainRepoRoot(), script), note], {
      cwd: mainRepoRoot(),
      env: { ...process.env },
    });
    const job: ReleaseJob = { run_id: runId, channel, started_at: Date.now(), child };
    this.jobs.set(channel, job);
    this.progress.set(channel, `出包启动`);
    this.bus.emitTransient("RELEASE_PROGRESS", { run_id: runId, channel, line: `出包启动：${channel}` });
    this.saveHistory({ ...record });

    const segRe = /^\[\d+\/\d+\]|配对闸|清单|✓|ERR|FAIL|直链|http/i; // 段落级过滤（B 路 P2-1 节流）
    const onLine = (line: string) => {
      appendFileSync(logFile, line + "\n", "utf-8");
      if (segRe.test(line)) {
        this.progress.set(channel, line.slice(0, 200));
        this.bus.emitTransient("RELEASE_PROGRESS", { run_id: runId, channel, line: line.slice(0, 200) });
      }
    };
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    });
    child.stderr?.on("data", (d: Buffer) => {
      appendFileSync(logFile, "[stderr] " + d.toString("utf-8"), "utf-8");
    });
    child.on("close", (code) => {
      if (buf.trim()) onLine(buf);
      const status: ReleaseRunRecord["status"] = code === 0 ? "done" : "failed";
      const urls = extractUrls(logFile);
      this.jobs.delete(channel);
      this.progress.set(channel, status === "done" ? "出包完成" : "出包失败——日志尾部与配对闸原因见历史");
      this.saveHistory({ ...record, status, exit_code: code ?? -1, finished_at: Date.now(), ...(urls.length ? { urls } : {}) });
      this.bus.emitTransient(status === "done" ? "RELEASE_DONE" : "RELEASE_FAILED", {
        run_id: runId, channel, exit_code: code ?? -1, ...(urls.length ? { urls } : {}),
      });
      // FAILED 额外走 notifyConfirm 黄框升级（发版失败=必须被看到的待处理——§3.2）
      if (status === "failed") {
        try {
          const mod = this.notifyConfirmHook;
          if (mod) mod(`出包失败（${channel}）——日志尾部与配对闸原因见发版页`);
        } catch {}
      }
    });
    child.on("error", (e) => {
      this.jobs.delete(channel);
      this.saveHistory({ ...record, status: "failed", exit_code: -1, finished_at: Date.now() });
      this.bus.emitTransient("RELEASE_FAILED", { run_id: runId, channel, error: String(e) });
    });

    return { ok: true, data: { run_id: runId, channel } }; // 立即返回（CI 轮询不占 HTTP 连接）
  }

  /** 发版失败黄框升级钩子（ws-server 注入 mgr.notifyConfirm 兜底选会话链） */
  notifyConfirmHook: ((text: string) => void) | null = null;

  /** relay 重启时进行中 run 标 interrupted（§7：不复活子进程，history 补记） */
  markInterrupted(): void {
    try {
      const hist = this.loadHistory();
      let changed = false;
      for (const r of hist) {
        if (r.status === "running") { r.status = "interrupted"; r.finished_at = Date.now(); changed = true; }
      }
      if (changed) writeFileSync(this.historyPath(), JSON.stringify(hist, null, 2) + "\n", "utf-8");
    } catch {}
  }

  private loadHistory(): ReleaseRunRecord[] {
    try {
      return JSON.parse(readFileSync(this.historyPath(), "utf-8")) as ReleaseRunRecord[];
    } catch {
      return [];
    }
  }
  private saveHistory(rec: ReleaseRunRecord): void {
    try {
      const hist = this.loadHistory().filter((r) => r.run_id !== rec.run_id);
      hist.unshift(rec);
      writeFileSync(this.historyPath(), JSON.stringify(hist.slice(0, 100), null, 2) + "\n", "utf-8"); // 上限 100 条防膨胀
    } catch (e) {
      console.error(`[release] history 落盘失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  listHistory(max = 30): ReleaseRunRecord[] {
    return this.loadHistory().slice(0, max);
  }
}

/** 脚本 stdout 提直链（脚本已打印的 http(s) 行） */
function extractUrls(logFile: string): string[] {
  try {
    const txt = readFileSync(logFile, "utf-8");
    return [...new Set(txt.match(/https?:\/\/[^\s"']+/g) ?? [])].slice(0, 10);
  } catch {
    return [];
  }
}
