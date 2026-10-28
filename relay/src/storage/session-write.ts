// ---------- #292-B4 终批：session 热态直写（影子模式起步，三步灰度） ----------
// 口径（总图 P7/R1/R4/R5 + 任务书）：
//   · session 表从「导入器 events 快照投影」升格为「帧处理口增量直写」——挂点=
//     SessionManager.emitUpdated（全会话状态变更唯一收口，每帧一小事务：R4 单帧一
//     事务禁跨帧长事务）。events.ndjson append-only 审计流一字不动（R5：审计≠实体）。
//   · 与导入器并存语义（批1 v2 教训的对偶）：直写与投影同 id 同表，双方都
//     INSERT OR REPLACE 全列覆盖（同构语句 SESSION_INSERT 列序）——影子期投影
//     重灌覆盖直写=安全（events 终态=更权威快照）；翻转后（B4c）导入器 session
//     域停灌，直写为唯一写者。无段链/冻结行（session 无重投语义），REPLACE 幂等。
//   · 灰度开关（每步可独立回退，env 三态）：
//       CCR_SESSION_WRITE_MODE = shadow（缺省，B4a：写库+影子比对，不影响任何读）
//                             | db   （B4c：正式态，与 shadow 同行为，语义位）
//                             | off  （回退：完全旁路直写，回到纯投影）
//     boot 读源独立开关（B4b）：CCR_BOOT_FROM = events（缺省）| db | auto（库在则库）。
//   · 性能（R4 预算）：quiet 端口直取（不 ensureStore——追赶的全量重灌会覆盖直写且
//     27MB events observe 不可入热路径）；begin/commit 微秒级三拍；单帧 P95<5ms 断言。
//   · 降级：SQLite 不可用/json 档=off 同款旁路（warn 一次，帧链零影响）。

import type { SessionState } from "../types.js";
import { ensureStoreQuiet, currentReadMode } from "./read-mode.js";
import type { StoragePort } from "./port.js";
import { resolveDirs } from "./read-mode.js";

export type SessionWriteMode = "shadow" | "db" | "off";

export function sessionWriteMode(): SessionWriteMode {
  const raw = process.env.CCR_SESSION_WRITE_MODE;
  if (raw === "db") return "db";
  if (raw === "off") return "off";
  return "shadow"; // B4a 缺省：影子（写库比对，不动读面）
}

/** 与导入器 SESSION_INSERT 同构（import-session-task.ts:249 列序）——直写复用
 *  同语句=列序单源漂移面最小；REPLACE 全列覆盖，投影/直写互覆盖皆幂等。 */
const SESSION_UPSERT = `INSERT OR REPLACE INTO session
  (id, relay_session_id, group_id, member_id, external_sid, engine, provider, model, cwd, status, runtime_state_json, started_at, updated_at, deleted_at)
  VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`;

function rowOf(s: SessionState, gidSafe: string | null): unknown[] {
  // 列序对齐 SESSION_UPSERT（=导入器 SESSION_INSERT）：id/relay_session_id/group_id
  // +[member_id/external_sid/engine/provider=SQL 字面 NULL]+model/cwd/status/
  // runtime_state_json/started_at/updated_at/deleted_at——10 个占位
  return [
    s.session_id,
    s.relay_session_id ?? null,
    gidSafe,
    s.model ?? null,
    s.cwd ?? "",
    s.status,
    JSON.stringify({
      title: s.title ?? "",
      action_summary: s.action_summary ?? "",
      last_error: s.last_error ?? null,
      done_reason: s.done_reason ?? null,
      duration_ms: s.duration_ms ?? null,
      historical: s.historical === true,
      external: s.external === true,
      cli_pid: s.cli_pid ?? null,
      pinned: s.pinned === true,
      saved: s.saved === true,
    }),
    s.started_at ?? s.updated_at ?? Date.now(),
    s.updated_at ?? Date.now(),
    null,
  ];
}

let warned = false;

/** 帧处理口直写（emitUpdated 挂点调用）。同步小事务；off/json 档/库不可用=旁路。 */
export function shadowWriteSession(state: SessionState): void {
  const mode = sessionWriteMode();
  if (mode === "off" || currentReadMode() === "json") return;
  if (!state || typeof state.session_id !== "string" || !state.session_id) return;
  let port: StoragePort;
  try {
    port = ensureStoreQuiet(resolveDirs());
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn("[session-write] ⚠️  SQLite 不可用，session 直写旁路（#158 语义，帧链不受影响）：", err instanceof Error ? err.message : err);
    }
    return;
  }
  try {
    // #292-B4 PM 审查 FK 陷阱处置：session.group_id REFERENCES "group"(id)——quiet
    // 端口建库不导入（冷启新库无 group 行），直写带 project_gid 必撞 FK 且被 warned
    // 一次性标志锁成全灭（B4c 翻转后 boot-from-db 必踩）。处置=写前 gid 轻查（indexed
    // 主键查微秒级），组不在库=写 NULL（对齐导入器语义「会话不在组内是常态非数据
    // 损失」，投影重灌/后续组在位后 REPLACE 自愈归因）
    const gid = state.project_gid ?? null;
    const gidSafe = gid && port.query<{ n: number }>('SELECT COUNT(*) AS n FROM "group" WHERE id = ?', [gid])[0]?.n ? gid : null;
    port.begin();
    try {
      port.exec(SESSION_UPSERT, rowOf(state, gidSafe));
      port.commit();
    } catch (err) {
      try { port.rollback(); } catch { /* 连接死 */ }
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // FK 先序类错误不锁 warned 标志（数据先序问题非库故障——组行落库后下一帧自愈；
    // 锁死会把可自愈的瞬态放大成永久旁路，PM 审查指出的实雷）
    const isFk = /FOREIGN KEY/i.test(msg);
    if (!warned || isFk) {
      if (!isFk) warned = true;
      console.warn(`[session-write] 直写降级${isFk ? "（FK 先序，组行落库后自愈不锁标志）" : ""}（帧链不受影响，投影兜底）：`, msg);
    }
  }
}

/** 影子比对（test-c4 用）：直写行 vs 库现行（投影重灌或直写后）在「可比列」上的差异。
 *  可比列口径：投影（事件流终态）与直写（内存态）语义一致的列——status/updated_at/
 *  cwd/engine/model/relay_session_id。不比 member_id/external_sid（投影恒 NULL=已知
 *  限制）、不比 runtime_state_json（投影是事件增量收编、直写是内存全量，形状天然异构
 *  ——B4c 撤旧后直写为唯一形状，届时可比）。返回差异描述数组（空=零差异）。 */
export function shadowSessionDiff(
  port: StoragePort,
  state: SessionState,
): string[] {
  const row = port.query<{ status: string; updated_at: number; cwd: string; relay_session_id: string | null }>(
    "SELECT status, updated_at, cwd, relay_session_id FROM session WHERE id = ?",
    [state.session_id],
  )[0];
  if (!row) return [`会话 ${state.session_id} 无行（直写未落或被域清）`];
  const out: string[] = [];
  if (row.status !== state.status) out.push(`status: 库=${row.status} 内存=${state.status}`);
  if (row.updated_at !== state.updated_at) out.push(`updated_at: 库=${row.updated_at} 内存=${state.updated_at}`);
  if ((row.cwd ?? "") !== (state.cwd ?? "")) out.push(`cwd: 库=${row.cwd} 内存=${state.cwd}`);
  if ((row.relay_session_id ?? null) !== (state.relay_session_id ?? null)) out.push(`relay_session_id: 库=${row.relay_session_id} 内存=${state.relay_session_id}`);
  return out;
}

/** 测试面：重置一次性降级标志。 */
export function resetSessionWriteWarnForTest(): void {
  warned = false;
}
