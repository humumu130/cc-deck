// [W-DUTYWIRE]（1105 用户三实锤断档治本）值守唤醒链纯函数底座（org.ts 同纪律：
// 不 import session-manager/EventBus、纯 fs、坏行容忍）。三件事：
//   ① 外部会话活跃度凭证：events.ndjson 尾窗扫描 session_id 最近帧 ts（SDK 会话无
//      CLI pid——「活跃」的唯一可观测证据；R1-B-F3 尾账捞 cli_pid 同款快筛范式）
//   ② 活跃窗环境口：CCR_DUTY_ACTIVITY_MIN（缺省 15，min 1）——claim 资格/席位判活
//      /候选提名三口共用同一窗（同权同窗，防 A 口 15min B 口 5min 的判定分叉）
//   ③ duty feed 审计日志：<orgDir>/duty-feed.ndjson append-only（appendJournal 5MB
//      滚动）——每条唤醒事件一行（投递结果由调用方回写 pending 队列状态承载，日志
//      只记发生不记状态机）
import { closeSync, openSync, readSync, statSync } from "node:fs"; // R1 P2-1：尾窗读三件+statSync 键控缓存（readFileSync 全量读退役）
import { join } from "node:path";
import { orgDir } from "./org.js";
import { appendJournal } from "./fs-safe.js";

export type DutyFeedKind = "harvest-done" | "review-receipt" | "pm-lost" | "flush" | "zombie-card"; // flush=补投收口审计行；zombie-card=板面僵尸卡告警（W-BOARDTRUTH5 刀二——三证全无超 TTL 卡进值守视野，web-console KIND_META 缺省回落 system 安全）

/** 活跃窗（分钟）：claim 资格判定与 pid=0 席位判活共用 */
export function dutyActivityWindowMin(): number {
  const v = Number(process.env.CCR_DUTY_ACTIVITY_MIN);
  return Number.isFinite(v) && v >= 1 ? v : 15;
}

/** events.ndjson 尾窗扫描：session_id 最近帧 ts（无帧=null）。尾窗 bytes 缺省 2MB——
 *  PM 会话心跳 5s/帧，2MB≈数千帧≈数小时覆盖，远超 15min 窗；快筛（行含 sid 才
 *  parse）保热路径便宜。读失败容错 null（=无凭证，判定侧保守拒绝）。
 *  R1 P2-1（A 审）：原 readFileSync 全量读（41MB 级×多候选同步阻塞——审方实测
 *  332ms/轮）改 open+fstat+readSync 尾窗（只读最后 tailBytes）；mtime+size 键控
 *  缓存同轮多候选共享一次读（同文件未变零重读——候选扫描/失联拍同拍多查场景）。 */
const _eventsTailCache = new Map<string, { mtimeMs: number; size: number; raw: string; at: number }>();
export function lastFrameAtFromEvents(dataDir: string, sessionId: string, tailBytes = 2 * 1024 * 1024): number | null {
  if (!sessionId) return null;
  const p = join(dataDir, "events.ndjson");
  let raw = "";
  try {
    const st = statSync(p);
    const hit = _eventsTailCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && Date.now() - hit.at < 60_000) {
      raw = hit.raw; // 同文件未变（60s 防粘滞兜底）：零重读
    } else {
      const fd = openSync(p, "r");
      try {
        const len = Math.min(st.size, tailBytes);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, Math.max(0, st.size - len)); // 只读尾窗
        raw = buf.subarray(0, n).toString("utf-8");
      } finally {
        closeSync(fd);
      }
      _eventsTailCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, raw, at: Date.now() });
    }
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

export function appendDutyFeedLog(row: { ts: number; kind: DutyFeedKind; text: string; target?: string; routed: "delivered" | "pending" | "user" | "skipped-mode" }): void { // R1：skipped-mode=leader 模式零路由留痕（不落 pending——该模式无值守位，积压无消费方）
  try {
    // R1：双层序列化退役——原 JSON.stringify(row) 传入后被 appendJournal 再序列化
    // =每行是「JSON 字符串字面量」而非 ndjson 对象行（读取侧需 parse 两次；本批
    // 审计真值断言因此失明实锤）。传对象本体，行=标准 ndjson。
    appendJournal(dutyFeedLogPath(), row as unknown as Record<string, unknown>);
  } catch { /* 审计尽力而为 */ }
}

// ---------- W-DUTYBACKOFF（1106 用户实锤两连）：值守智能化三刀的数据面 ----------
/** 刀1 数据面：PM 目标会话最近**真实用户消息**时刻——events.ndjson 尾窗扫 SESSION_LOG
 * 行（session_id 命中 + payload.kind==="user_message"），**排除值守注入**（duty 注入的
 * 首条消息以 "[值守喂活]" 前缀回显，非真实用户话语——用户实锤「一直在对话中还巡什么检」
 * 的判据就是真实话语）。返回 null=尾窗内无真实用户消息。 */
export function lastRealUserMessageAt(dataDir: string, sessionId: string, tailBytes = 2 * 1024 * 1024): number | null {
  if (!sessionId) return null;
  const p = join(dataDir, "events.ndjson");
  let raw = "";
  try {
    const st = statSync(p);
    const fd = openSync(p, "r");
    try {
      const len = Math.min(st.size, tailBytes);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      raw = buf.subarray(0, n).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let best: number | null = null;
  for (const line of raw.split("\n")) {
    if (!line.includes(sessionId) || !line.includes("user_message")) continue; // 快筛双词
    try {
      const e = JSON.parse(line) as { session_id?: unknown; ts?: unknown; payload?: { kind?: unknown; text?: unknown } };
      if (e.session_id !== sessionId || typeof e.ts !== "number") continue;
      if (e.payload?.kind !== "user_message" || typeof e.payload.text !== "string") continue;
      if (e.payload.text.startsWith("[值守喂活]")) continue; // duty 注入回显排除（真实话语判据）
      if (best === null || e.ts > best) best = e.ts;
    } catch { /* 坏行跳过 */ }
  }
  return best;
}

/** 刀1 窗口：PM-用户对话活跃窗（缺省 10min；CCR_DUTY_USER_ACTIVE_MIN 覆盖，下限 1）。 */
export function dutyUserActiveMin(): number {
  const v = Number(process.env.CCR_DUTY_USER_ACTIVE_MIN);
  return Number.isFinite(v) && v >= 1 ? v : 10;
}

/** 刀2 退避级数：无进展（同 top 候选不变）连续喂活轮的延迟表 5→15→30→60 封顶（分钟）。
 * 级数从 1 起（首轮即同 top=第 2 次喂活开始退避）。dutyContinuationMs 风格常量族。 */
export function dutyNoProgressDelayMs(streak: number): number {
  const table = [5, 15, 30, 60];
  const i = Math.min(Math.max(streak, 1), table.length) - 1;
  return table[i] * 60_000;
}
