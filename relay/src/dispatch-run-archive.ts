// M1 run 机器留档（multica 深研卷四·借① keystone / synthesis 排产 M1，2026-10-29 批）：
// dispatch 终态自动归档三件套到 <artifacts>/dispatch-runs/<id>/——worker 回执是自述
// 单证（件十-B 虚报事故实证其脆弱），机器档让收割核验「抽查 diff+行号+自测证据」
// 有据可对质（虚报双证解）：
//   ① task-brief.md          派单时 prompt 全文快照（dispatchWorker dispatched 侧显式归档）
//   ② events-slice.ndjson.gz 本单承接会话的事件切片（末次 dispatched ts → 终态 ts 窗，
//                             两侧放宽 -60s/+5s 防边界丢首尾帧，gzip 落盘）
//   ③ terminal-stats.json    终态时间戳/时长/终态 usage 读数（自切片 SESSION_UPDATED
//                             末值提取——单一数据源零注入）/failure_reason
// 台账终态行由 appendDispatch 咽喉回填 run_ref（相对 artifacts 根的目录名）。
//
// 无环纪律（org.ts 同款）：本模块只依赖 node 内置 + config.resolveDataDir +
// artifacts.artifactsDir；不 import org（org 单向依赖本模块）/session-manager/storage。
// 全部尽力而为：归档失败只 warn 不抛——台账与派单主路径绝不因留档降级（审计面语义）。
//
// 归档范围闸（终态钩子内过滤，防审计/演练行污染 run 目录）：
//   · drill=true（链路演练假任务）不归档
//   · 同 id 无 dispatched/running 前行（org-command 审计单行/经验申报等）不归档
//   · queued-only 段（编制排队后未真正派出）不归档——无 run 语义
// 重投/自动重试（同 id 再 dispatched→终态）：task-brief 与 terminal-stats 按「最后一
// run」覆盖写（新 run 的 prompt/终态为权威）；事件窗起点取同 id 最后一次 dispatched 行 ts。

import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "./config.js";
import { artifactsDir } from "./artifacts.js";

/** 台账行最小形状（DispatchEntry 子集——本模块不 import org.ts 防环，结构耦合由
 * test-m-observ 断言锁：appendDispatch 写入的终态行字段名与此处一致） */
export interface ArchiveDispatchRow {
  id: string;
  tier: string;
  status: string;
  session_id: string;
  receipt?: string;
  title?: string;
  drill?: boolean;
  failure_reason?: string;
  ts: number;
}

/** terminal-stats.json 形状（终态读数——收割抽查与回执对质的机器面） */
export interface TerminalStats {
  dispatch_id: string;
  status: string;
  tier: string;
  title?: string;
  target_session: string;
  /** 本 run 首行（末次 dispatched）时间戳 */
  dispatched_ts: number;
  terminal_ts: number;
  duration_ms: number;
  failure_reason?: string;
  /** 切片内最后一条 SESSION_UPDATED 的 usage（Claude 路径 onUsage 累计下发的会话
   * 总量末值）。未接线引擎（jsonl/codex）无此帧=不带键（not-wired 口径与 M3 一致） */
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  /** 切片收录事件条数（跨会话行被滤后的本单窗口行数） */
  events_sliced: number;
  archived_at: number;
}

/** run 目录名（run_ref 值）：相对 artifacts 根 */
export function dispatchRunRef(id: string): string {
  return `dispatch-runs/${id}`;
}

function runDir(id: string): string {
  return join(artifactsDir(), "dispatch-runs", id);
}

/** ① 任务书快照：dispatchWorker 组装 prompt 后（dispatched 台账行同刻）调用。
 * 头部带派单元信息便于 cat 直接读；正文 = prompt 全文（不截断——机器档口径）。 */
export function archiveDispatchPrompt(id: string, prompt: string, meta: { tier: string; title?: string; target?: string }): void {
  try {
    const dir = runDir(id);
    mkdirSync(dir, { recursive: true });
    const head = [
      `# 派单任务书快照（dispatch ${id}）`,
      `- 档位：${meta.tier}${meta.title ? `｜标题：${meta.title}` : ""}${meta.target ? `｜承接：${meta.target}` : ""}`,
      `- 归档时刻：${new Date().toISOString()}`,
      "",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(dir, "task-brief.md"), head + prompt + "\n", "utf-8");
  } catch (err) {
    console.warn(`[run-archive] 任务书快照失败（尽力而为不阻断派单）: ${err instanceof Error ? err.message : err}`);
  }
}

/** 台账同 id 段回读（archive 自解析文件——不 import org 防环；坏行跳过同 loadEvents 口径） */
function readDispatchSegments(orgD: string, id: string): ArchiveDispatchRow[] {
  const p = join(orgD, "dispatch-log.ndjson");
  if (!existsSync(p)) return [];
  const rows: ArchiveDispatchRow[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as ArchiveDispatchRow;
      if (e.id === id) rows.push(e);
    } catch { /* 损坏行跳过 */ }
  }
  return rows;
}

interface SliceRow { seq: number; session_id: string; ts: number; type: string; payload: unknown }

/** ②+③ 终态归档：appendDispatch 咽喉在 done/failed 行写入前调用。
 * @returns run_ref（终态行回填用）或 null（不归档：非终态/演练/审计/queued-only/切片源缺失不炸） */
export function archiveDispatchTerminal(e: ArchiveDispatchRow, orgD: string): string | null {
  if (e.status !== "done" && e.status !== "failed") return null;
  if (e.drill === true) return null; // 演练假任务无 run 语义
  try {
    const segs = readDispatchSegments(orgD, e.id);
    // 终态行尚未落盘（咽喉在写文件前调用）——段内找末次 dispatched/running 定窗
    const liveRows = segs.filter((r) => r.status === "dispatched" || r.status === "running");
    if (liveRows.length === 0) return null; // 审计单行 / queued-only：非 run，不归档
    const lastDispatched = [...liveRows].reverse().find((r) => r.status === "dispatched");
    const windowStart = (lastDispatched ?? liveRows[0]).ts - 60_000;
    const windowEnd = e.ts + 5_000;

    // ② 事件切片：承接会话 + 时间窗（跨会话行滤除；坏行跳过）
    const eventsPath = join(resolveDataDir(), "events.ndjson");
    const sliced: SliceRow[] = [];
    if (existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const env = JSON.parse(t) as SliceRow;
          if (env.session_id === e.session_id && env.ts >= windowStart && env.ts <= windowEnd) sliced.push(env);
        } catch { /* 损坏行跳过（loadEvents 同口径） */ }
      }
    }
    const dir = runDir(e.id);
    mkdirSync(dir, { recursive: true });
    // gzip 同步落盘（单 run 窗口行数 S 级；zlib.gzipSync——不引子进程/流式回调）
    writeFileSync(join(dir, "events-slice.ndjson.gz"), gzipSync(Buffer.from(sliced.map((r) => JSON.stringify(r) + "\n").join(""), "utf-8")));

    // ③ 终态 stats：usage 取切片内末条 SESSION_UPDATED 的 usage（onUsage 累计口径末值）
    let usage: TerminalStats["usage"];
    for (const env of sliced) {
      if (env.type !== "SESSION_UPDATED") continue;
      const u = (env.payload as { usage?: TerminalStats["usage"] } | null)?.usage;
      if (u && typeof u.input_tokens === "number") usage = u;
    }
    const stats: TerminalStats = {
      dispatch_id: e.id,
      status: e.status,
      tier: e.tier,
      ...(e.title ? { title: e.title } : {}),
      target_session: e.session_id,
      dispatched_ts: (lastDispatched ?? liveRows[0]).ts,
      terminal_ts: e.ts,
      duration_ms: e.ts - (lastDispatched ?? liveRows[0]).ts,
      ...(e.failure_reason ? { failure_reason: e.failure_reason } : {}),
      ...(usage ? { usage } : {}),
      events_sliced: sliced.length,
      archived_at: Date.now(),
    };
    const dir2 = runDir(e.id);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "terminal-stats.json"), JSON.stringify(stats, null, 2) + "\n", "utf-8");
    return dispatchRunRef(e.id);
  } catch (err) {
    console.warn(`[run-archive] 终态归档失败（尽力而为，台账照写）: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
