// T1（DEV-43）：wakeup 服务进程内登记口 + HTTP 载荷校验——index.ts 装配、ws-server
// /api/wakeup 消费。WakeupService 实例由 index.ts 在 patrol 同闸内构造（mgr/cfg 在
// 手边），HTTP 面经此单例取用——不把服务塞进 StartServerOptions（装配序：ws-server
// 起在 patrol 之前，opts 传递时服务还不存在）。
import type { ArmWakeupInput, WakeupPredicate, WakeupService } from "./wakeup.js";

let svc: WakeupService | null = null;

export function setWakeupService(s: WakeupService): void {
  svc = s;
}

export function getWakeupService(): WakeupService | null {
  return svc;
}

// 词表单点（types.ts SessionStatus / projects.ts D18 五态——HTTP 面只收已知值，
// 防拼写幽灵键进规则表后永远不满足）
const SESSION_STATUSES = new Set(["WORKING", "WAITING", "ERROR", "DONE"]);
const BOARD_STATUSES = new Set(["planned", "backlog", "claimed", "submitted", "ready_to_install", "done"]);

/** POST /api/wakeup action=arm 载荷校验。合法返回 {ok:true, rule}，否则 {ok:false, error}。 */
export function armWakeupFromHttp(p: Record<string, unknown>): { ok: boolean; rule?: ArmWakeupInput; error?: string } {
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const body = typeof p.body === "string" ? p.body.trim() : "";
  const createdBy = typeof p.createdBy === "string" && p.createdBy.trim() ? p.createdBy.trim().slice(0, 64) : "http";
  if (!title || !body) return { ok: false, error: "title/body 必填" };
  const pr = p.predicate;
  if (!pr || typeof pr !== "object") return { ok: false, error: "predicate 必填" };
  const o = pr as Record<string, unknown>;
  let predicate: WakeupPredicate;
  if (o.kind === "session_status") {
    const status = typeof o.status === "string" ? o.status : "";
    if (!SESSION_STATUSES.has(status)) return { ok: false, error: `session_status.status 必须是 ${[...SESSION_STATUSES].join("/")}` };
    predicate = {
      kind: "session_status",
      status,
      ...(typeof o.sessionId === "string" && o.sessionId ? { sessionId: o.sessionId.slice(0, 64) } : {}),
      ...(o.external === true ? { external: true } : {}),
    };
  } else if (o.kind === "board_entry_status") {
    const status = typeof o.status === "string" ? o.status : "";
    if (!BOARD_STATUSES.has(status)) return { ok: false, error: `board_entry_status.status 必须是 ${[...BOARD_STATUSES].join("/")}` };
    predicate = {
      kind: "board_entry_status",
      status,
      ...(typeof o.textIncludes === "string" && o.textIncludes ? { textIncludes: o.textIncludes.slice(0, 64) } : {}),
    };
  } else if (o.kind === "notification_pending") {
    const n = Number(o.minCount);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return { ok: false, error: "notification_pending.minCount 须为 1..1000 整数" };
    predicate = { kind: "notification_pending", minCount: n };
  } else {
    return { ok: false, error: "predicate.kind 必须是 session_status|board_entry_status|notification_pending" };
  }
  const numField = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const triggerAfterMs = numField(p.triggerAfterMs);
  const expiresInMs = numField(p.expiresInMs);
  const expiresAt = numField(p.expiresAt);
  return {
    ok: true,
    rule: {
      predicate,
      title: title.slice(0, 120),
      body: body.slice(0, 500),
      createdBy,
      ...(typeof p.level === "string" && p.level ? { level: p.level.slice(0, 16) } : {}),
      ...(triggerAfterMs !== undefined ? { triggerAfterMs } : {}),
      ...(expiresInMs !== undefined ? { expiresInMs } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  };
}
