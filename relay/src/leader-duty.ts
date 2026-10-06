export type DutyCandidateKind = "receipt" | "dispatch" | "todo" | "stale_doing";
export type DutyRisk = "known" | "unknown";

export interface DutyPendingReceipt {
  sid: string;
  receipt_path: string;
  mtime: number;
  status?: "done" | "failed";
  reviewed?: boolean;
}

export interface DutyDispatchCandidate {
  dispatch_id: string;
  status: "failed" | "hanging" | "dispatched" | "running";
  hanging_ms?: number;
  source_session_id?: string;
  playbook?: string;
  risk?: DutyRisk;
  token_estimate?: number;
  time_estimate_ms?: number;
}

export interface DutyUnlockedTodo {
  todo_id: string;
  content?: string;
  source_session_id?: string;
  playbook?: string;
  risk?: DutyRisk;
  token_estimate?: number;
  time_estimate_ms?: number;
}

export interface DutyStaleDoing {
  session_id: string;
  doing_ms: number;
  dispatch_id?: string;
  playbook?: string;
  risk?: DutyRisk;
  token_estimate?: number;
  time_estimate_ms?: number;
}

export interface DutyRunningSession {
  session_id: string;
  status: "running" | "WORKING" | "WAITING" | "done" | "error";
  updated_at?: number;
  last_progress_at?: number;
  recent_progress?: boolean;
}

export type DutyBlockedReason = "user_confirm" | "external" | "permission" | "unknown";

export interface DutyBlockedItem {
  id: string;
  reason: DutyBlockedReason;
}

export interface DutyPolicy {
  enabled?: boolean;
  allowed_playbooks?: string[];
  per_action_token_budget?: number;
  per_action_time_budget_ms?: number;
  overnight_budget?: number;
  overnight_budget_used?: number;
  unknown_risk?: "allow" | "review_only" | "deny";
  auto_dispatch_enabled?: boolean;
}

export interface DutyQueueSnapshot {
  pending_receipts?: DutyPendingReceipt[];
  failed_or_hanging_dispatches?: DutyDispatchCandidate[];
  unlocked_todos?: DutyUnlockedTodo[];
  stale_doing?: DutyStaleDoing[];
  running_sessions?: DutyRunningSession[];
  blocked?: DutyBlockedItem[];
  duty_policy?: DutyPolicy;
  now?: number;
  progress_window_ms?: number;
}

export interface DutyCandidate {
  kind: DutyCandidateKind;
  id: string;
  source_session_id?: string;
  age_ms?: number;
  playbook?: string;
  risk?: DutyRisk;
  token_estimate?: number;
  time_estimate_ms?: number;
}

export type DutyActionableReason = "actionable" | "all_running" | "blocked" | "empty";

export interface DutyActionableResult {
  actionable: boolean;
  candidates: DutyCandidate[];
  reason: DutyActionableReason;
  blocked: DutyBlockedItem[];
}

function receiptCandidates(snapshot: DutyQueueSnapshot, now: number): DutyCandidate[] {
  return (snapshot.pending_receipts ?? [])
    .filter((receipt) => receipt.reviewed !== true)
    .map((receipt) => ({
      kind: "receipt" as const,
      id: receipt.sid,
      source_session_id: receipt.sid,
      age_ms: Math.max(0, now - receipt.mtime),
    }));
}

function dispatchCandidates(snapshot: DutyQueueSnapshot): DutyCandidate[] {
  return (snapshot.failed_or_hanging_dispatches ?? [])
    .filter((dispatch) => dispatch.status !== "running" || (dispatch.hanging_ms ?? 0) > 0)
    .filter((dispatch) => dispatch.status === "failed" || dispatch.status === "hanging" || dispatch.status === "dispatched" || (dispatch.hanging_ms ?? 0) > 0)
    .map((dispatch) => ({
      kind: "dispatch" as const,
      id: dispatch.dispatch_id,
      source_session_id: dispatch.source_session_id,
      age_ms: dispatch.hanging_ms,
      playbook: dispatch.playbook,
      risk: dispatch.risk,
      token_estimate: dispatch.token_estimate,
      time_estimate_ms: dispatch.time_estimate_ms,
    }));
}

function todoCandidates(snapshot: DutyQueueSnapshot): DutyCandidate[] {
  return (snapshot.unlocked_todos ?? []).map((todo) => ({
    kind: "todo" as const,
    id: todo.todo_id,
    source_session_id: todo.source_session_id,
    playbook: todo.playbook,
    risk: todo.risk,
    token_estimate: todo.token_estimate,
    time_estimate_ms: todo.time_estimate_ms,
  }));
}

function staleDoingCandidates(snapshot: DutyQueueSnapshot): DutyCandidate[] {
  return (snapshot.stale_doing ?? []).map((doing) => ({
    kind: "stale_doing" as const,
    id: doing.dispatch_id ?? doing.session_id,
    source_session_id: doing.session_id,
    age_ms: doing.doing_ms,
    playbook: doing.playbook,
    risk: doing.risk,
    token_estimate: doing.token_estimate,
    time_estimate_ms: doing.time_estimate_ms,
  }));
}

function hasRecentRunningProgress(session: DutyRunningSession, now: number, windowMs: number): boolean {
  if (session.recent_progress !== undefined) return session.recent_progress;
  const progressAt = session.last_progress_at ?? session.updated_at;
  return progressAt !== undefined && now - progressAt <= windowMs;
}

export function evaluateLeaderActionableWork(snapshot: DutyQueueSnapshot): DutyActionableResult {
  const now = snapshot.now ?? Date.now();
  const candidates = [
    ...receiptCandidates(snapshot, now),
    ...dispatchCandidates(snapshot),
    ...todoCandidates(snapshot),
    ...staleDoingCandidates(snapshot),
  ];
  const blocked = [...(snapshot.blocked ?? [])];
  if (candidates.length > 0) return { actionable: true, candidates, reason: "actionable", blocked };
  if (blocked.length > 0) return { actionable: false, candidates, reason: "blocked", blocked };
  const running = (snapshot.running_sessions ?? []).filter((session) => session.status === "running" || session.status === "WORKING");
  const progressWindow = snapshot.progress_window_ms ?? 60 * 60 * 1000;
  if (running.length > 0 && running.every((session) => hasRecentRunningProgress(session, now, progressWindow))) {
    return { actionable: false, candidates, reason: "all_running", blocked };
  }
  return { actionable: false, candidates, reason: "empty", blocked };
}

export interface DutyContinuationPlan {
  delay_min_ms: number;
  delay_max_ms: number;
  wake_once: true;
  auto_renew: false;
}

export interface DutyFeedCountState {
  consecutive_feeds: number;
}

export interface DutyFeedTransition {
  state: DutyFeedCountState;
  shouldSleep: boolean;
  continuation?: DutyContinuationPlan;
}

export type DutyFeedSignal = "feed" | "idle" | "natural_sleep";

export function transitionDutyFeedCount(
  state: DutyFeedCountState = { consecutive_feeds: 0 },
  signal: DutyFeedSignal,
  k = 3,
): DutyFeedTransition {
  if (signal === "idle" || signal === "natural_sleep") {
    return { state: { consecutive_feeds: 0 }, shouldSleep: false };
  }
  const consecutive = Math.max(0, state.consecutive_feeds) + 1;
  if (consecutive >= k) {
    return {
      state: { consecutive_feeds: consecutive },
      shouldSleep: true,
      continuation: {
        delay_min_ms: 5 * 60 * 1000,
        delay_max_ms: 15 * 60 * 1000,
        wake_once: true,
        auto_renew: false,
      },
    };
  }
  return { state: { consecutive_feeds: consecutive }, shouldSleep: false };
}

export const advanceDutyFeed = transitionDutyFeedCount;

export type DutyReceiptActionKind = "accept" | "dispatch" | "board" | "notify" | "none";
export type DutyNextTrigger = "event" | "turn_end" | "user";

export interface DutyReceiptAction {
  kind: DutyReceiptActionKind;
  ids: string[];
}

export interface DutyReceipt {
  v: 1;
  feed_id: string;
  actions: DutyReceiptAction[];
  blocked: DutyBlockedItem[];
  next_trigger: DutyNextTrigger;
}

export interface DutyReceiptValidation {
  ok: boolean;
  errors: string[];
}

const dutyActionKinds: readonly DutyReceiptActionKind[] = ["accept", "dispatch", "board", "notify", "none"];
const dutyNextTriggers: readonly DutyNextTrigger[] = ["event", "turn_end", "user"];
const dutyBlockedReasons: readonly DutyBlockedReason[] = ["user_confirm", "external", "permission", "unknown"];

export function validateDutyReceipt(value: unknown): DutyReceiptValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["receipt must be an object"] };
  const receipt = value as Partial<DutyReceipt>;
  if (receipt.v !== 1) errors.push("v must be 1");
  if (typeof receipt.feed_id !== "string" || receipt.feed_id.length === 0) errors.push("feed_id is required");
  if (!Array.isArray(receipt.actions) || receipt.actions.length === 0) errors.push("actions must be non-empty");
  if (!Array.isArray(receipt.blocked)) errors.push("blocked must be an array");
  if (!dutyNextTriggers.includes(receipt.next_trigger as DutyNextTrigger)) errors.push("next_trigger is invalid");
  const actions = Array.isArray(receipt.actions) ? receipt.actions : [];
  for (const action of actions) {
    if (!action || typeof action !== "object" || !dutyActionKinds.includes((action as DutyReceiptAction).kind)) {
      errors.push("action kind is invalid");
      continue;
    }
    const typed = action as DutyReceiptAction;
    if (!Array.isArray(typed.ids) || typed.ids.some((id) => typeof id !== "string" || id.length === 0)) errors.push("action ids must be strings");
    if (typed.kind !== "none" && Array.isArray(typed.ids) && typed.ids.length === 0) errors.push("non-none action requires ids");
    if (typed.kind === "none" && Array.isArray(typed.ids) && typed.ids.length > 0) errors.push("none action cannot contain ids");
  }
  const blocked = Array.isArray(receipt.blocked) ? receipt.blocked : [];
  for (const item of blocked) {
    if (!item || typeof item !== "object" || typeof (item as DutyBlockedItem).id !== "string" || !(dutyBlockedReasons as readonly string[]).includes((item as DutyBlockedItem).reason)) {
      errors.push("blocked item is invalid");
    }
  }
  const hasNone = actions.some((action) => (action as DutyReceiptAction)?.kind === "none");
  if (hasNone && blocked.length === 0 && !receipt.next_trigger) errors.push("none action lacks blocked or next_trigger explanation");
  return { ok: errors.length === 0, errors };
}

export function serializeDutyReceipt(receipt: DutyReceipt): string {
  const validation = validateDutyReceipt(receipt);
  if (!validation.ok) throw new Error(`invalid DUTY_RECEIPT: ${validation.errors.join("; ")}`);
  return JSON.stringify(receipt);
}

export function parseDutyReceipt(line: string): DutyReceipt | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return validateDutyReceipt(parsed).ok ? parsed as DutyReceipt : null;
  } catch {
    return null;
  }
}

export function isValidDutyReceipt(value: unknown): value is DutyReceipt {
  return validateDutyReceipt(value).ok;
}

export interface DutyPolicyDecision {
  mode: "allow" | "notify" | "blocked";
  action: "accept" | "dispatch" | "board" | "notify";
  reason: string;
  auto_dispatch_enabled: boolean;
}

function automaticCandidate(candidate: DutyCandidate): boolean {
  return candidate.kind === "dispatch" || candidate.kind === "todo" || candidate.kind === "stale_doing";
}

function candidateAction(candidate: DutyCandidate): DutyPolicyDecision["action"] {
  if (candidate.kind === "receipt") return "accept";
  if (candidate.kind === "stale_doing") return "board";
  return "dispatch";
}

export function evaluateDutyPolicy(candidate: DutyCandidate, policy: DutyPolicy = {}): DutyPolicyDecision {
  const autoDispatch = policy.auto_dispatch_enabled ?? true;
  const action = candidateAction(candidate);
  if (policy.enabled === false) return { mode: "blocked", action, reason: "policy_disabled", auto_dispatch_enabled: autoDispatch };
  if (!automaticCandidate(candidate)) return { mode: "allow", action, reason: "fact_source_action", auto_dispatch_enabled: autoDispatch };
  if (autoDispatch === false) return { mode: "notify", action: "notify", reason: "auto_dispatch_disabled", auto_dispatch_enabled: autoDispatch };
  if (candidate.playbook && policy.allowed_playbooks && !policy.allowed_playbooks.includes(candidate.playbook)) {
    return { mode: "notify", action: "notify", reason: "playbook_not_allowed", auto_dispatch_enabled: autoDispatch };
  }
  if (candidate.risk === "unknown" && (policy.unknown_risk ?? "review_only") === "deny") {
    return { mode: "blocked", action: "notify", reason: "unknown_risk", auto_dispatch_enabled: autoDispatch };
  }
  if (candidate.risk === "unknown" && (policy.unknown_risk ?? "review_only") === "review_only") {
    return { mode: "notify", action: "notify", reason: "unknown_risk_review_only", auto_dispatch_enabled: autoDispatch };
  }
  if (policy.per_action_token_budget !== undefined && candidate.token_estimate !== undefined && candidate.token_estimate > policy.per_action_token_budget) {
    return { mode: "notify", action: "notify", reason: "per_action_token_budget", auto_dispatch_enabled: autoDispatch };
  }
  if (policy.per_action_time_budget_ms !== undefined && candidate.time_estimate_ms !== undefined && candidate.time_estimate_ms > policy.per_action_time_budget_ms) {
    return { mode: "notify", action: "notify", reason: "per_action_time_budget", auto_dispatch_enabled: autoDispatch };
  }
  if (policy.overnight_budget !== undefined && (policy.overnight_budget_used ?? 0) >= policy.overnight_budget) {
    return { mode: "notify", action: "notify", reason: "overnight_budget_exhausted", auto_dispatch_enabled: autoDispatch };
  }
  return { mode: "allow", action, reason: "policy_allows", auto_dispatch_enabled: autoDispatch };
}
