// W-SUBFANOUT（架构升级期一①，1104 用户令，DS Subscription fan-out 对位）：
// 订阅直通层——「已订阅」= dispatch-log 在途单（dispatched/running/queued，读侧
// 同 id 末行收敛 = org 读账口径，不建第二本账）。面向在途单的消息/确认/审查意见
// 按 dispatch_id→session_id 直投承接会话（承接会话以台账为权威，不信入参自带），
// 不再过 PM 分诊跳；单终态（done/failed）/无归属 → 返回 null，调用方回落既有
// 分诊路径（PM 分诊不删，终态回落保留——DS「executor 不在 → 消息回 Eval」对位）。
// 直通≠不留账：送达留痕走 notifyConfirm 既有 user-note 账（调用方），路由决策
// 留痕由 SessionManager.noteSubFanout 落审计条目（DS 账本纪律）。
// 本模块纯判定零副作用：只依赖 org 纯底座（readDispatchLogFile），不 import
// session-manager/ws-server（无环）。判定单点化：下位改路由只动 subFanTarget。
import { readDispatchLogFile, type DispatchEntry } from "./org.js";

/** 在途态白名单（与 org.ts 活单口径同源：closeHungDispatchRows / appendDispatch
 * 拒重派扫描都按 dispatched|running|queued 三态——改词表两处同步） */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["dispatched", "running", "queued"]);

export interface SubFanTarget {
  /** 归属单全 id（审计关联用，勿截断） */
  dispatchId: string;
  /** 承接会话 relay session id（台账权威） */
  sessionId: string;
  /** 同 id 末行收敛后的 status（切换日志观测用） */
  status: DispatchEntry["status"];
}

/** 直通判定单点（同类绝迹机制）：dispatch_id 显式在途 → 直投目标。
 * - 末行收敛（org 读账口径）：同 id 多行取最后一行（dispatched→running→done 收敛终态）
 * - 在途且承接会话非空 → SubFanTarget；终态（done/failed）/无此单/非串值/裸调用 → null
 * - 不猜归属：无 dispatch_id 时一律 null（DS 语义按订阅关系路由，从不推断——
 *   调用方带 session_id 的显式直投是既有能力，不经本层也不留直通痕） */
export function subFanTarget(dispatchId: unknown, dir?: string): SubFanTarget | null {
  const did = typeof dispatchId === "string" ? dispatchId.trim() : "";
  if (!did) return null;
  let row: DispatchEntry | undefined;
  for (const e of readDispatchLogFile(dir)) {
    if (e.id === did) row = e; // 末行赢（ndjson append-only 状态机）
  }
  if (!row || !ACTIVE_STATUSES.has(row.status) || !row.session_id) return null;
  return { dispatchId: row.id, sessionId: row.session_id, status: row.status };
}
