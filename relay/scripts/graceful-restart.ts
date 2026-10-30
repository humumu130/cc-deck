// M4 claim barrier 优雅更新窗（multica 深研卷一 T3「跟随替换」/ synthesis M4，2026-10-29 批）：
// 热部署换新前过派单屏障——现状「launchctl kickstart -k 硬杀 + 人肉避让窗口」改为机制内化：
//   Phase 0 预检：新 bundle 存在 + node --check 语法闸（半写/截断 bundle 是真实事故形态：
//                热部署成对拷教训/-m2 旧 bundle 降级事故——此刻未杀进程，失败=原进程无损）
//   Phase 1 claim barrier：读派单台账（readDispatchLog 真源收敛），dispatched/running 非零
//                → 轮询等待（默认 5min，CCR_GRACEFUL_WINDOW 秒可配）→ 窗内归零自动续；
//                窗满仍有活 → **不硬杀**：打印活单清单+人工决策指引，退出码 3（进程不动）
//   Phase 2 换新：备份旧 bundle → 拷新 → kickstart -k（此刻无活单，杀=安全）
//   Phase 3 探活+失败回退：端口轮询（默认 30s）→ 不通=自动回滚备份 bundle + 二次 kickstart
//                → 二轮探活通=「旧版继续服务」（launchd KeepAlive 架构下「原进程继续」
//                的等价实现：进程换壳、服务与版本不回退中断）；仍不通=告警人工（退出码 5）
// multica T3 教训照搬：等待/超时是**纯诊断可见状态**，不引入 pending 状态机不 gate 任何
// 东西（防半死态）；queued 排队单不算活单（重启后 reloadDispatchQueue 回内存恢复，非在跑
// 任务）；探活失败不当「版本变化」处理——回滚动作幂等。
//
// 主逻辑命令注入式（exec/copy/probe 皆可替换）——test-m-graceful 断言调用序列不碰真
// launchd；CLI 入口（tsx 直跑）用真实现。薄壳 deploy/mac-relay-launchd/graceful-restart.sh
// 定位仓内 tsx 调本文件。
//
// 直跑：cd relay && npx tsx scripts/graceful-restart.ts <新bundle路径> [--window 秒]
// env：CCR_GRACEFUL_WINDOW（等待窗秒，默认 300）｜CCR_PROBE_TIMEOUT（探活窗秒，默认 30）
//      CCR_PORT（探活端口，默认 8787）｜CCR_RELAY_LABEL｜APP_RELAY（目标 bundle 路径）

import { existsSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as net from "node:net";
import { readDispatchLog } from "../src/org.js";

const RELAY_LABEL = "online.humumu.ccdeck.relay";
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 501);

/** 活派单判定（纯函数）：台账收敛末行 status ∈ {dispatched, running} = 有 worker 活在跑。
 * queued 排除（受理未派发，重启 reloadDispatchQueue 安全恢复——非在跑任务）；
 * done/failed/审计单行（无 dispatched·running 前行）在收敛视图天然排除。 */
export function activeDispatches(rows: { id: string; status: string; target?: string; title?: string }[]): { id: string; status: string; target?: string; title?: string }[] {
  const byId = new Map<string, { id: string; status: string; target?: string; title?: string }>();
  for (const r of rows) byId.set(r.id, { id: r.id, status: r.status, target: r.target, title: r.title });
  return [...byId.values()].filter((r) => r.status === "dispatched" || r.status === "running");
}

/** 注入面（测试替身入口）：全部副作用经此——断言调用序列不碰真 launchd/端口。
 * readRows 默认 readDispatchLog 真源（orgDir() 调用时求值——沙盒 env 后设仍生效）。 */
export interface GracefulDeps {
  readRows: () => { id: string; status: string; target?: string; title?: string }[];
  exec: (cmd: string, args: string[]) => void;
  copy: (from: string, to: string) => void;
  probe: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export const defaultDeps = (): GracefulDeps => ({
  readRows: () => readDispatchLog(),
  exec: (cmd, args) => { execFileSync(cmd, args, { stdio: "inherit" }); },
  copy: (from, to) => { copyFileSync(from, to); },
  probe: (port) => new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(300, () => { s.destroy(); resolve(false); });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => { console.log(line); },
});

export interface GracefulResult {
  outcome: "restarted" | "timeout-keep-running" | "rolled-back" | "rollback-failed" | "preflight-failed";
  waitedMs: number;
  activeAtExit?: { id: string; status: string }[];
}

/** 主链（纯编排，副作用全走 deps——测试注入断言；文件存在性检查用真 fs：测试传真实临时文件）。 */
export async function gracefulRestart(opts: {
  newBundle: string; targetBundle: string; port: number;
  windowMs: number; probeMs: number; label: string;
  deps: GracefulDeps; nodeCheck?: boolean;
}): Promise<GracefulResult> {
  const d = opts.deps;
  const started = Date.now();
  // Phase 0 预检：新 bundle 存在 + 语法闸（失败时进程未动=无损）
  if (!existsSync(opts.newBundle)) {
    d.log(`✗ 预检失败：新 bundle 不存在 ${opts.newBundle}（原进程未动，无损退出）`);
    return { outcome: "preflight-failed", waitedMs: 0 };
  }
  if (opts.nodeCheck !== false) {
    try { d.exec("node", ["--check", opts.newBundle]); } catch {
      d.log(`✗ 预检失败：node --check 未过（bundle 半写/截断？）——原进程未动，无损退出`);
      return { outcome: "preflight-failed", waitedMs: 0 };
    }
  }
  // Phase 1 claim barrier：等活派单归零（multica T3：等待是诊断状态，不 gate 任何东西）
  let active = activeDispatches(d.readRows());
  if (active.length > 0) {
    d.log(`⏳ claim barrier：${active.length} 个活派单在跑，等待窗 ${Math.round(opts.windowMs / 1000)}s（CCR_GRACEFUL_WINDOW 可配）——不硬杀`);
    while (Date.now() - started < opts.windowMs) {
      await d.sleep(50);
      active = activeDispatches(d.readRows());
      if (active.length === 0) break;
    }
    if (active.length > 0) {
      d.log(`⚠️ 等待窗满仍有 ${active.length} 个活派单——不硬杀，原进程继续服务。人工决策：`);
      for (const a of active) d.log(`   · ${a.id} [${a.status}] ${a.title ?? ""} → ${a.target ?? ""}`);
      d.log(`   ① 确认可杀：CCR_GRACEFUL_WINDOW=0 重跑本命令（跳过等待）`);
      d.log(`   ② 或直接强杀：launchctl kickstart -k gui/$(id -u)/${opts.label}（自担在跑单损失）`);
      return { outcome: "timeout-keep-running", waitedMs: Date.now() - started, activeAtExit: active };
    }
    d.log(`✓ 活派单已归零（等待 ${Math.round((Date.now() - started) / 1000)}s）——进入换新`);
  }
  // Phase 2 备份+换新+kickstart（此刻无活单；备份/拷新失败会抛→CLI 层退出码 1，原进程未动）
  const backup = `${opts.targetBundle}.pre-graceful.${started}`;
  d.copy(opts.targetBundle, backup);
  d.copy(opts.newBundle, opts.targetBundle);
  d.exec("launchctl", ["kickstart", "-k", `gui/${uid()}/${opts.label}`]);
  // Phase 3 探活+失败回退（回滚幂等：再失败只告警，不循环）
  const up = async (budget: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
      if (await d.probe(opts.port)) return true;
      await d.sleep(50);
    }
    return false;
  };
  if (await up(opts.probeMs)) {
    d.log(`✓ 换新完成并探活通过（port ${opts.port}）——旧版备份：${backup}`);
    return { outcome: "restarted", waitedMs: Date.now() - started };
  }
  d.log(`⚠️ 新 bundle 起不来（探活 ${Math.round(opts.probeMs / 1000)}s 不通）——自动回滚旧 bundle 恢复服务`);
  d.copy(backup, opts.targetBundle);
  d.exec("launchctl", ["kickstart", "-k", `gui/${uid()}/${opts.label}`]);
  if (await up(opts.probeMs)) {
    d.log(`✓ 已回滚旧版继续服务（故障新 bundle 留档待查；服务未中断）`);
    return { outcome: "rolled-back", waitedMs: Date.now() - started };
  }
  d.log(`✗ 回滚后仍探活不通——需人工介入：launchctl print gui/${uid()}/${opts.label} 与 relay-service.log`);
  return { outcome: "rollback-failed", waitedMs: Date.now() - started };
}

// ---------- CLI 入口 ----------
if (process.argv[1] && process.argv[1].endsWith("graceful-restart.ts")) {
  const args = process.argv.slice(2);
  const newBundle = args[0];
  const winIdx = args.indexOf("--window");
  const windowS = winIdx >= 0 ? Number(args[winIdx + 1]) : Number(process.env.CCR_GRACEFUL_WINDOW ?? 300);
  if (!newBundle) {
    console.error("用法：npx tsx scripts/graceful-restart.ts <新bundle路径> [--window 秒]\nenv：CCR_GRACEFUL_WINDOW/CCR_PROBE_TIMEOUT/CCR_PORT/CCR_RELAY_LABEL/APP_RELAY（目标 bundle）");
    process.exit(2);
  }
  const targetBundle = process.env.APP_RELAY ?? "/Applications/CC Deck.app/Contents/Resources/resources/relay.mjs";
  gracefulRestart({
    newBundle, targetBundle,
    port: Number(process.env.CCR_PORT ?? 8787),
    windowMs: Math.max(0, windowS) * 1000,
    probeMs: Number(process.env.CCR_PROBE_TIMEOUT ?? 30) * 1000,
    label: process.env.CCR_RELAY_LABEL ?? RELAY_LABEL,
    deps: defaultDeps(),
  }).then((r) => {
    process.exit(r.outcome === "restarted" ? 0 : r.outcome === "timeout-keep-running" ? 3 : r.outcome === "rolled-back" ? 4 : 5);
  }).catch((e) => { console.error("graceful-restart 异常（原进程未动）：", e instanceof Error ? e.message : e); process.exit(1); });
}
