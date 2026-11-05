// [W-DUTYWIRE]（1105 用户三实锤断档治本）值守唤醒链纯函数底座（org.ts 同纪律：
// 不 import session-manager/EventBus、纯 fs、坏行容忍）。三件事：
//   ① 外部会话活跃度凭证：events.ndjson 尾窗扫描 session_id 最近帧 ts（SDK 会话无
//      CLI pid——「活跃」的唯一可观测证据；R1-B-F3 尾账捞 cli_pid 同款快筛范式）
//   ② 活跃窗环境口：CCR_DUTY_ACTIVITY_MIN（缺省 15，min 1）——claim 资格/席位判活
//      /候选提名三口共用同一窗（同权同窗，防 A 口 15min B 口 5min 的判定分叉）
//   ③ duty feed 审计日志：<orgDir>/duty-feed.ndjson append-only（appendJournal 5MB
//      滚动）——每条唤醒事件一行（投递结果由调用方回写 pending 队列状态承载，日志
//      只记发生不记状态机）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orgDir } from "./org.js";
import { appendJournal } from "./fs-safe.js";

export type DutyFeedKind = "harvest-done" | "review-receipt" | "pm-lost" | "flush"; // flush=补投收口审计行

/** 活跃窗（分钟）：claim 资格判定与 pid=0 席位判活共用 */
export function dutyActivityWindowMin(): number {
  const v = Number(process.env.CCR_DUTY_ACTIVITY_MIN);
  return Number.isFinite(v) && v >= 1 ? v : 15;
}

/** events.ndjson 尾窗扫描：session_id 最近帧 ts（无帧=null）。尾窗 bytes 缺省 2MB——
 *  PM 会话心跳 5s/帧，2MB≈数千帧≈数小时覆盖，远超 15min 窗；快筛（行含 sid 才
 *  parse）保热路径便宜。读失败容错 null（=无凭证，判定侧保守拒绝）。 */
export function lastFrameAtFromEvents(dataDir: string, sessionId: string, tailBytes = 2 * 1024 * 1024): number | null {
  if (!sessionId) return null;
  const p = join(dataDir, "events.ndjson");
  let raw = "";
  try {
    const fd = readFileSync(p); // 全量读后取尾（events 41MB 级全读偏重——open+read 尾窗）
    raw = fd.length > tailBytes ? fd.subarray(fd.length - tailBytes).toString("utf-8") : fd.toString("utf-8");
  } catch {
    return null;
  }
  let best: number | null = null;
  for (const line of raw.split("\n")) {
    if (!line.includes(sessionId)) continue; // 快筛：无 sid 直跳（parse 前置闸）
    try {
      const e = JSON.parse(line) as { session_id?: unknown; ts?: unknown };
      if (e.session_id !== sessionId || typeof e.ts !== "number") continue;
      if (best === null || e.ts > best) best = e.ts;
    } catch { /* 坏行跳过 */ }
  }
  return best;
}

/** 会话活跃度凭证判定（claim 闸/席位判活/候选提名共用单点） */
export function sessionActiveByEvents(dataDir: string, sessionId: string, now = Date.now(), windowMin = dutyActivityWindowMin()): boolean {
  const at = lastFrameAtFromEvents(dataDir, sessionId);
  return at !== null && now - at <= windowMin * 60_000;
}

export function dutyFeedLogPath(dir?: string): string {
  return join(dir ?? orgDir(), "duty-feed.ndjson");
}

export function appendDutyFeedLog(row: { ts: number; kind: DutyFeedKind; text: string; target?: string; routed: "delivered" | "pending" | "user" }): void {
  try {
    appendJournal(dutyFeedLogPath(), JSON.stringify(row) as unknown as Record<string, unknown>);
  } catch { /* 审计尽力而为 */ }
}
