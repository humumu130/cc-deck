// ---------- #292 cutover 批1：dispatch 直写 SQLite（双写模式） ----------
// org.ts 台账 append 时同步直写库——文件保留为审计原始账+导入器兜底。
// 导入器 checkpoint 检测同 id 已在库→跳过（不重复导入）。
// 语义：UPSERT（同 id 状态推进覆盖，新 id INSERT）——与 import-dispatch-lesson 的段链
// 语义兼容但简化（直写不走段链拆分，直接按 root id UPSERT）。

import { ensureStore, loadSqliteDriver } from "./read-mode.js";

/** 直写一条 dispatch 到 SQLite（UPSERT 语义）。失败不炸调用方（文件已写成功=降级安全）。 */
export function writeDispatchToDb(e: {
  id: string;
  status?: string;
  tier?: string;
  gid?: string;
  target?: string;
  source_session_id?: string;
  actor?: string;
  receipt?: string;
  ts?: number;
  receipt_missing?: boolean;
}): void {
  const store = ensureStore();
  if (!store || !store.isOpen) return;
  const drv = loadSqliteDriver();
  if (!drv) return;

  const status = String(e.status ?? "dispatched");
  const tier = String(e.tier ?? "正经立项");
  const groupId = e.gid ?? null;
  const targetMemberId = e.target ?? null;
  const sourceSid = e.source_session_id ?? null;
  const actor = e.actor ?? "user";
  const receipt = typeof e.receipt === "string" ? e.receipt : "";
  const ts = e.ts ?? Date.now();
  const rm = e.receipt_missing === true ? 1 : 0;

  // UPSERT：存在=推进状态（updated_at/receipt/receipt_missing 覆盖），不存在=INSERT
  store.exec(
    `INSERT INTO dispatch (id, task_id, group_id, tier, target_member_id, source_session_id, actor, command_id,
       status, receipt, attempt_no, parent_dispatch_id, created_at, updated_at, receipt_missing)
     VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULLIF(?, ''), 1, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       receipt = COALESCE(NULLIF(excluded.receipt, ''), dispatch.receipt),
       receipt_missing = excluded.receipt_missing,
       updated_at = excluded.updated_at`,
    [e.id, groupId, tier, targetMemberId, sourceSid, actor, status, receipt, ts, ts, rm],
  );
}
