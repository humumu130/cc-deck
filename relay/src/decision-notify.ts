import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgConfirm } from "./projects.js";
import type { AcceptanceSummary } from "./acceptance.js";
import type { NotificationGroup, NotificationItem, NotificationSourceContext, SessionState } from "./types.js";

export type DecisionNotificationKind = "org-confirm" | "waiting" | "dispatch" | "acceptance" | "system";
export const DECISION_NOTIFICATION_KINDS = ["org-confirm", "waiting", "dispatch", "acceptance", "system"] as const;

export function isDecisionNotificationKind(value: unknown): value is DecisionNotificationKind {
  return typeof value === "string" && (DECISION_NOTIFICATION_KINDS as readonly string[]).includes(value);
}

// 019 leader-duty 预留：后续 D3 只需在此常量与文案映射扩展，不改变 ledger 形状。

export type NotificationLifecycleItem = NotificationItem & { dismissed_at?: number };

export interface DecisionNotification {
  key: string;
  kind: DecisionNotificationKind;
  source_session_id: string;
  created_at: number;
  first_sent_at?: number;
  reminded_at?: number;
  resolved_at?: number;
  handled_at?: number;
  dismissed_at?: number;
  /** [W-AWAITUSER] 用户推送限频锚：userPush 成功时刻（持久跨重启——同项只推一次的
   * 事实源）。与 first_sent_at（PM 注入）分轨：PM 注入依赖目标会话存活，用户推送
   * 只依赖阈值与本项目。 */
  user_pushed_at?: number;
  group: NotificationGroup;
  actionable: boolean;
  revision: string;
  /** #018-B3a：产生源快照（离线重载后 sourceContext 不丢——重启前已发出的通知项溯源
   * 与回跳路径可还原）。坏形状整块丢弃不炸（normalize 洗刷，任一必填字段缺=不可判定）。 */
  source_context?: NotificationSourceContext;
}

export interface NotificationGroupBucket {
  items: NotificationItem[];
  count: number;
  badgeItems: NotificationItem[];
  badgeCount: number;
}

export interface GroupedNotifications {
  action: NotificationGroupBucket;
  attention: NotificationGroupBucket;
  activity: NotificationGroupBucket;
  groups: Record<NotificationGroup, NotificationGroupBucket>;
  badgeItems: NotificationItem[];
  badgeCount: number;
}

function emptyNotificationBucket(): NotificationGroupBucket {
  return { items: [], count: 0, badgeItems: [], badgeCount: 0 };
}

function isHandled(item: NotificationLifecycleItem): boolean {
  return item.handled_at !== undefined || item.dismissed_at !== undefined || item.resolved_at !== undefined;
}

export function groupNotifications(items: NotificationItem[]): GroupedNotifications {
  const action = emptyNotificationBucket();
  const attention = emptyNotificationBucket();
  const activity = emptyNotificationBucket();
  const groups = { action, attention, activity } satisfies Record<NotificationGroup, NotificationGroupBucket>;
  for (const item of items) {
    const bucket = groups[item.group];
    if (!bucket) continue;
    bucket.items.push(item);
    bucket.count++;
    const lifecycle = item as NotificationLifecycleItem;
    if (item.group === "action" && item.actionable && !isHandled(lifecycle)) {
      bucket.badgeItems.push(item);
      bucket.badgeCount++;
    }
  }
  const badgeItems = action.badgeItems;
  return { action, attention, activity, groups, badgeItems, badgeCount: badgeItems.length };
}

export type NotificationLifecycleAction =
  | "opened"
  | "browsed"
  | "reconnected"
  | "source_succeeded"
  | "dismissed"
  | "resolved";

export function transitionNotification<T extends NotificationLifecycleItem>(
  item: T,
  action: NotificationLifecycleAction,
  at: number,
): T {
  const next = { ...item } as T;
  if (action === "source_succeeded" && next.handled_at === undefined) next.handled_at = at;
  if (action === "dismissed") {
    if (next.dismissed_at === undefined) next.dismissed_at = at;
    if (next.handled_at === undefined) next.handled_at = at;
  }
  if (action === "resolved" && next.resolved_at === undefined) next.resolved_at = at;
  return next;
}

export function markNotificationHandled<T extends NotificationLifecycleItem>(item: T, at: number): T {
  return transitionNotification(item, "source_succeeded", at);
}

export function markNotificationDismissed<T extends NotificationLifecycleItem>(item: T, at: number): T {
  return transitionNotification(item, "dismissed", at);
}

export function markNotificationResolved<T extends NotificationLifecycleItem>(item: T, at: number): T {
  return transitionNotification(item, "resolved", at);
}

export function stableKey(kind: DecisionNotificationKind, entityId: string, revision?: string | number): string {
  if (!isDecisionNotificationKind(kind)) throw new Error(`unsupported notification kind: ${String(kind)}`);
  if (kind === "dispatch") return `${kind}:${entityId}`;
  if (revision === undefined || String(revision).length === 0) return `${kind}:${entityId}`;
  return `${kind}:${entityId}:${String(revision)}`;
}

function keyIdentity(item: DecisionNotification): string {
  const parts = item.key.split(":");
  if (item.kind === "org-confirm" || item.kind === "acceptance") return `${item.kind}:${parts[1] ?? item.key}`;
  return item.key;
}

function mergeNotificationPair(current: DecisionNotification, incoming: DecisionNotification): DecisionNotification {
  return {
    ...current,
    ...incoming,
    created_at: Math.min(current.created_at, incoming.created_at),
    first_sent_at: current.first_sent_at ?? incoming.first_sent_at,
    reminded_at: current.reminded_at ?? incoming.reminded_at,
    resolved_at: current.resolved_at ?? incoming.resolved_at,
    handled_at: current.handled_at ?? incoming.handled_at,
    dismissed_at: current.dismissed_at ?? incoming.dismissed_at,
    user_pushed_at: current.user_pushed_at ?? incoming.user_pushed_at,
    source_context: current.source_context ?? incoming.source_context,
  };
}

export function mergeDecisionNotifications(
  current: DecisionNotification[],
  incoming: DecisionNotification[],
): DecisionNotification[] {
  const merged = new Map<string, DecisionNotification>();
  for (const item of [...current, ...incoming]) {
    const identity = keyIdentity(item);
    const existing = merged.get(identity);
    merged.set(identity, existing ? mergeNotificationPair(existing, item) : { ...item });
  }
  return [...merged.values()];
}

export interface DecisionNotificationLedger {
  notifications: DecisionNotification[];
}

export interface DecisionNotificationWatcherOptions {
  dataDir?: string;
  ledgerPath?: string;
  intervalMs?: number;
  waitMin?: number;
  remindHours?: number;
  enabled?: boolean;
  listConfirms: () => OrgConfirm[];
  snapshotSessions: () => SessionState[];
  leaderSessionId: () => string | null | undefined;
  notify: (sessionId: string, text: string) => boolean;
  /** [W-AWAITUSER] 源③：未回填验收单清单（listAcceptances）。缺席=验收不入推送扫描
   * （旧接线/部分测试形态兼容），聚合清单面不受影响（那是 pending-user-actions 单口）。 */
  listAcceptances?: () => AcceptanceSummary[];
  /** [W-AWAITUSER] 用户推送通道（USER_NOTE 全端弹系统通知；index 接线=
   * mgr.emitUserNote）。返回 false=未投出，不记 user_pushed_at 下轮重试——
   * R1（A审P1-1）起契约真兑现：emitUserNote 按在线端真值回报（mgr.liveFrontends，
   * ws-server 注回：wss OPEN 非 pairing ∨ 云手机 active），零端在线=false——
   * USER_NOTE 是 seq:0 瞬态不补发，推送时刻不在线若记锚=永久吞没（1104「没人
   * 盯」形态），不记锚=端恢复后同 key 下轮扫描重推。 */
  userPush?: (text: string) => boolean;
  now?: () => number;
}

const DEFAULT_WAIT_MIN = 10;
const DEFAULT_REMIND_HOURS = 24;
const DEFAULT_INTERVAL_MS = 20_000;

function numberEnv(name: string, fallback: number, min: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function enabledEnv(): boolean {
  return process.env.CCR_DECISION_NOTIFY !== "0";
}

function ledgerPathOf(options: Pick<DecisionNotificationWatcherOptions, "dataDir" | "ledgerPath">): string {
  const override = options.ledgerPath ?? process.env.CCR_DECISION_NOTIFY_LEDGER_PATH ??
    process.env.CCR_DECISION_NOTIFY_LEDGER ?? process.env.CCR_DECISION_LEDGER_PATH ?? process.env.CCR_DECISION_LEDGER;
  if (override) return override;
  const dataDir = options.dataDir ?? process.env.CCR_DATA_DIR ?? join(process.cwd(), "data");
  return join(dataDir, "decision-notifications.json");
}

function defaultNotificationGroup(kind: DecisionNotificationKind): NotificationGroup {
  return kind === "system" ? "activity" : "action";
}

function defaultActionable(kind: DecisionNotificationKind, group: NotificationGroup): boolean {
  return group === "action" && kind !== "system";
}

/** #018-B3a sourceContext 洗刷：domain/entityId/alertId/returnPath 必填 string——任一缺
 * =整块不可判定，丢弃（返回 undefined）不炸不猜；sessionId/segment 可选，类型对才带。 */
export function normalizeSourceContext(value: unknown): NotificationSourceContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const x = value as Partial<NotificationSourceContext>;
  if (typeof x.domain !== "string" || !x.domain ||
      typeof x.entityId !== "string" || !x.entityId ||
      typeof x.alertId !== "string" || !x.alertId ||
      typeof x.returnPath !== "string") return undefined;
  return {
    domain: x.domain,
    entityId: x.entityId,
    alertId: x.alertId,
    returnPath: x.returnPath,
    ...(typeof x.sessionId === "string" ? { sessionId: x.sessionId } : {}),
    ...(typeof x.segment === "string" ? { segment: x.segment } : {}),
  };
}

export function normalizeDecisionNotification(item: unknown): DecisionNotification | null {
  if (!item || typeof item !== "object") return null;
  const x = item as Partial<DecisionNotification>;
  if (typeof x.key !== "string" || !isDecisionNotificationKind(x.kind) ||
      typeof x.source_session_id !== "string" || typeof x.created_at !== "number" ||
      typeof x.revision !== "string") return null;
  const group = x.group === "action" || x.group === "attention" || x.group === "activity"
    ? x.group
    : defaultNotificationGroup(x.kind);
  const sourceContext = normalizeSourceContext(x.source_context);
  return {
    key: x.key,
    kind: x.kind,
    source_session_id: x.source_session_id,
    created_at: x.created_at,
    ...(typeof x.first_sent_at === "number" ? { first_sent_at: x.first_sent_at } : {}),
    ...(typeof x.reminded_at === "number" ? { reminded_at: x.reminded_at } : {}),
    ...(typeof x.resolved_at === "number" ? { resolved_at: x.resolved_at } : {}),
    ...(typeof x.handled_at === "number" ? { handled_at: x.handled_at } : {}),
    ...(typeof x.dismissed_at === "number" ? { dismissed_at: x.dismissed_at } : {}),
    ...(typeof x.user_pushed_at === "number" ? { user_pushed_at: x.user_pushed_at } : {}),
    group,
    actionable: typeof x.actionable === "boolean" ? x.actionable : defaultActionable(x.kind, group),
    revision: x.revision,
    ...(sourceContext ? { source_context: sourceContext } : {}),
  };
}

export function readDecisionNotificationLedger(path: string): DecisionNotificationLedger {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { notifications?: unknown }).notifications)
        ? (raw as { notifications: unknown[] }).notifications
        : [];
    const notifications = list.map(normalizeDecisionNotification).filter((item): item is DecisionNotification => item !== null);
    return { notifications };
  } catch {
    return { notifications: [] };
  }
}

export function writeDecisionNotificationLedger(path: string, ledger: DecisionNotificationLedger): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger.notifications, null, 2) + "\n", "utf-8");
}

// ---------- #018-B3a 扩展面：ledger→通知投影 / 离线重载幂等（纯函数，接线归 R1） ----------

const LEDGER_KIND_LABELS: Record<DecisionNotificationKind, string> = {
  "org-confirm": "确认单",
  waiting: "审批",
  dispatch: "派单",
  acceptance: "验收",
  system: "系统",
};

function ledgerEntityId(item: DecisionNotification): string {
  const parts = item.key.split(":");
  return parts[1] ?? item.key;
}

/** ledger 行 → 通知项投影（groupNotifications 的上一环，R1 接线出口）。确定性：
 * 同输入恒同输出——severity 按 actionable/resolved 判（非 actionable 或 system→info、
 * resolved→done、否则→waiting）、sourceContext 优先还原持久化快照、旧行（无
 * source_context）从 key+source_session_id 合成降级（不静默丢溯源）；
 * 输出按 created_at 升序、同 ts 按 key 字典序（分组视图与组计数稳定）。 */
export function projectLedgerNotifications(
  items: DecisionNotification[],
  options: { includeHandled?: boolean } = {},
): NotificationItem[] {
  const includeHandled = options.includeHandled ?? true;
  const projected = items
    .filter((item) => includeHandled || (item.handled_at === undefined && item.dismissed_at === undefined && item.resolved_at === undefined))
    .map((item): NotificationItem => ({
      key: item.key,
      kind: item.kind,
      group: item.group,
      severity: !item.actionable || item.kind === "system"
        ? "info"
        : (item.resolved_at !== undefined ? "done" : "waiting"),
      title: `${LEDGER_KIND_LABELS[item.kind]} ${ledgerEntityId(item)}`,
      body: item.source_session_id ? `来源会话 ${item.source_session_id.slice(0, 12)}` : LEDGER_KIND_LABELS[item.kind],
      sourceContext: item.source_context ?? {
        domain: item.kind,
        entityId: ledgerEntityId(item),
        alertId: item.key,
        returnPath: "",
        ...(item.source_session_id ? { sessionId: item.source_session_id } : {}),
      },
      actionable: item.actionable,
      created_at: item.created_at,
      ...(item.resolved_at !== undefined ? { resolved_at: item.resolved_at } : {}),
      ...(item.handled_at !== undefined ? { handled_at: item.handled_at } : {}),
    }));
  return projected.sort((a, b) => (a.created_at - b.created_at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 离线重载合并（进程重启幂等入口）：盘上台账（权威——可能含离线期间其他写面的进展）
 * 与内存态合并，同 identity 重复 decision 去重且生命周期字段保留（mergeNotificationPair
 * 语义）。幂等：对同一对 (内存, 盘) 重复调用结果深度相等——重载不重发、不翻已处置态。 */
export function mergeReloadedLedger(
  inMemory: DecisionNotification[],
  onDisk: DecisionNotification[],
): DecisionNotification[] {
  return mergeDecisionNotifications(onDisk, inMemory)
    .sort((a, b) => (a.created_at - b.created_at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function confirmRevision(confirm: OrgConfirm): string {
  const revision = (confirm as OrgConfirm & { revision?: unknown }).revision;
  return typeof revision === "string" || typeof revision === "number" ? String(revision) : String(confirm.created_at);
}

function confirmKey(confirm: OrgConfirm): string {
  return stableKey("org-confirm", confirm.id, confirmRevision(confirm));
}

function confirmSourceSession(confirm: OrgConfirm): string {
  for (const key of ["source_session_id", "session_id", "source_session"]) {
    const value = confirm.payload?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function waitingKey(session: SessionState): string {
  return stableKey("waiting", session.session_id, session.waiting_request!.request_id);
}

/** [W-AWAITUSER] 秒级时戳归一（canonical 单口=pending-user-actions.ts normMs；此处
 * 内联同式避免与该件互引成环——stableKey 已被它引，运行时环宁少不多） */
function msOf(v: number): number {
  const n = Number(v) || 0;
  return n > 0 && n < 1e11 ? n * 1000 : n;
}

function allowWaiting(session: SessionState): boolean {
  const request = session.waiting_request;
  return session.status === "WAITING" && !!request && request.decidable !== false && !request.questions?.length;
}

function kindLabel(kind: OrgConfirm["kind"]): string {
  switch (kind) {
    case "project-create": return "新建项目确认"; // W-WINPAIR-R9 文案件：「立项」口语词治理（用户点名）
    case "tier-change": return "档位变更";
    case "suggest-hold": return "暂缓建议";
    case "archive": return "结项确认";
    case "revive": return "复活确认";
    case "rule-append": return "规则提案"; // W-RULES1：团队规则确认卡通知标签
    case "member-join": return "入队申请"; // X0 件2：org join 自荐入编确认卡通知标签
    case "device-trust": return "跨机首联"; // X1 多机编排：设备级 first-contact 确认卡通知标签
    case "headcount-trim-first": return "首次编制清理"; // [W-SEAT-SEMANTICS] 首裁确认卡通知标签
    case "role-upsert": return "建岗提案"; // W-ROLE-BUILDER：AI Builder 对话建岗确认卡通知标签
    case "patrol-suggest": return "巡查阈值建议"; // W-WATCHAGENT：巡查员阈值调整确认卡通知标签
  }
}

function compact(text: string, max = 160): string {
  const oneLine = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function confirmText(confirm: OrgConfirm, sourceSessionId: string): string {
  const source = sourceSessionId ? ` · 来源会话 ${sourceSessionId.slice(0, 12)}` : " · 来源：Leader 控制会话";
  const summary = confirm.reason ? `：${compact(confirm.reason)}` : "";
  return `[拍板] ${compact(confirm.title, 70)} · ${kindLabel(confirm.kind)}${source}${summary}`;
}

function waitingText(session: SessionState): string {
  const tool = compact(session.waiting_request?.tool_name || "操作", 60);
  return `[审批] 当前会话等待允许 ${tool} · 来源会话 ${session.session_id.slice(0, 12)}`;
}

export class DecisionNotificationWatcher {
  private readonly path: string;
  private readonly intervalMs: number;
  private readonly waitMs: number;
  private readonly remindMs: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly options: DecisionNotificationWatcherOptions;
  private ledger: DecisionNotificationLedger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DecisionNotificationWatcherOptions) {
    this.options = options;
    this.path = ledgerPathOf(options);
    this.intervalMs = options.intervalMs ?? numberEnv("CCR_DECISION_NOTIFY_INTERVAL_MS", DEFAULT_INTERVAL_MS, 1000);
    this.waitMs = (options.waitMin ?? numberEnv("CCR_DECISION_WAIT_MIN", DEFAULT_WAIT_MIN, 0)) * 60_000;
    this.remindMs = (options.remindHours ?? numberEnv("CCR_DECISION_REMIND_HOURS", DEFAULT_REMIND_HOURS, 0)) * 3_600_000;
    this.enabled = options.enabled ?? enabledEnv();
    this.now = options.now ?? (() => Date.now());
    this.ledger = readDecisionNotificationLedger(this.path);
  }

  get ledgerPath(): string { return this.path; }

  snapshotLedger(): DecisionNotification[] {
    return this.ledger.notifications.map((item) => ({ ...item }));
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scan(now = this.now()): void {
    if (!this.enabled) return;
    const confirms = this.options.listConfirms();
    const sessions = this.options.snapshotSessions();
    const acceptances = this.options.listAcceptances?.() ?? [];
    const byKey = new Map(this.ledger.notifications.map((item) => [item.key, item]));
    const activeConfirmKeys = new Set<string>();
    const activeWaitingKeys = new Set<string>();
    const activeAcceptanceKeys = new Set<string>();
    // [W-AWAITUSER] userPush 滞留起点（per-key；秒级时戳在此归一——canonical 归一口
    // 在 pending-user-actions.ts normMs，此处内联同式避免运行时环引）
    const startedAtOf = new Map<string, number>();
    let changed = false;

    for (const confirm of confirms) {
      const key = confirmKey(confirm);
      const existing = byKey.get(key);
      if (confirm.status === "pending") {
        activeConfirmKeys.add(key);
        startedAtOf.set(key, msOf(confirm.created_at));
        const item = existing ?? {
          key,
          kind: "org-confirm" as const,
          source_session_id: confirmSourceSession(confirm),
          created_at: confirm.created_at,
          group: "action" as const,
          actionable: true,
          revision: confirmRevision(confirm),
        };
        if (!existing) {
          this.ledger.notifications.push(item);
          byKey.set(key, item);
          changed = true;
        }
        if (!item.source_session_id) {
          const source = confirmSourceSession(confirm);
          if (source) item.source_session_id = source;
        }
        const target = this.targetSession(item.source_session_id, sessions);
        if (!item.first_sent_at && target && this.options.notify(target, confirmText(confirm, target))) {
          item.source_session_id = target;
          item.first_sent_at = now;
          changed = true;
        } else if (item.first_sent_at && !item.reminded_at && this.remindMs > 0 && now - item.first_sent_at >= this.remindMs && target && this.options.notify(target, confirmText(confirm, target))) {
          item.reminded_at = now;
          changed = true;
        }
      } else if (existing && !existing.resolved_at) {
        existing.resolved_at = confirm.decided_at ?? now;
        changed = true;
      }
    }

    for (const session of sessions) {
      // [W-AWAITUSER] waiting 全形态入账（status=WAITING×waiting_request 即在等用户）：
      // 生命周期与滞留起点覆盖 AskUserQuestion（questions）与 decidable=false 仅通知
      // 形态——1104 实锤正是四问窗口无人知超时，用户推送腿不排除这些形态。PM 注入
      // 腿（first_sent_at）维持 allowWaiting 原口径（PM 无法代答四问，注入无意义）
      if (!(session.status === "WAITING" && session.waiting_request)) continue;
      const key = waitingKey(session);
      activeWaitingKeys.add(key);
      startedAtOf.set(key, session.waiting_started_at ?? session.updated_at);
      const existing = byKey.get(key);
      const item = existing ?? {
        key,
        kind: "waiting" as const,
        source_session_id: session.session_id,
        created_at: session.waiting_started_at ?? session.updated_at,
        group: "action" as const,
        actionable: true,
        revision: session.waiting_request!.request_id,
      };
      if (!existing) {
        this.ledger.notifications.push(item);
        byKey.set(key, item);
        changed = true;
      }
      if (!allowWaiting(session)) continue; // PM 注入口径不变：仅可决议形态注入
      const startedAt = session.waiting_started_at ?? session.updated_at;
      if (!item.first_sent_at && now - startedAt >= this.waitMs && this.options.notify(session.session_id, waitingText(session))) {
        item.first_sent_at = now;
        changed = true;
      } else if (item.first_sent_at && !item.reminded_at && this.remindMs > 0 && now - item.first_sent_at >= this.remindMs && this.options.notify(session.session_id, waitingText(session))) {
        item.reminded_at = now;
        changed = true;
      }
    }

    // [W-AWAITUSER] 源③：未回填验收单（#195 生命周期语义：submitted=已处理出扫描）。
    // 只入账+用户推送，不做 PM 注入（验收单是用户填的表，PM 代催无意义）；
    // revision=created_at（同 confirm 口径：重登记同 id 新单=新 key 自然区分）
    const acceptanceTitle = new Map(acceptances.map((a) => [stableKey("acceptance", a.id), a.title]));
    for (const acceptance of acceptances) {
      if (acceptance.submitted) continue;
      const key = stableKey("acceptance", acceptance.id);
      activeAcceptanceKeys.add(key);
      startedAtOf.set(key, msOf(acceptance.created_at));
      const existing = byKey.get(key);
      const item = existing ?? {
        key,
        kind: "acceptance" as const,
        source_session_id: "",
        created_at: msOf(acceptance.created_at),
        group: "action" as const,
        actionable: true,
        revision: String(acceptance.created_at),
      };
      if (!existing) {
        this.ledger.notifications.push(item);
        byKey.set(key, item);
        changed = true;
      }
    }

    // [W-AWAITUSER] 用户推送（1104 用户令）：三源滞留≥waitMs 各推一次（USER_NOTE 全端
    // 弹系统通知——通知中心顶格是「看见」面，这是「错过 N 分钟后仍无人理」的升级腿；
    // 含 AskUserQuestion/waiting 全形态——PM 注入腿的 allowWaiting 排除 questions，
    // 用户腿不排除：1104 实锤正是四问窗口无人知超时）。限频=user_pushed_at 持久锚，
    // 同 key 只推一次（跨重启不重推）；回调 false=未投出不记锚下轮重试
    if (this.options.userPush) {
      const sessionsById = new Map(sessions.map((s) => [s.session_id, s]));
      const confirmTitle = new Map(confirms.filter((c) => c.status === "pending").map((c) => [confirmKey(c), c.title]));
      for (const [key, startedAt] of startedAtOf) {
        if (now - startedAt < this.waitMs) continue;
        const item = byKey.get(key);
        if (!item || item.resolved_at !== undefined || item.user_pushed_at !== undefined) continue;
        const minutes = Math.max(1, Math.round((now - startedAt) / 60_000));
        let text: string;
        if (item.kind === "org-confirm") {
          text = `[等你拍板] 确认卡《${compact(confirmTitle.get(key) ?? "", 24) || "未命名确认"}》已等 ${minutes} 分钟`;
        } else if (item.kind === "waiting") {
          const s = sessionsById.get(item.source_session_id);
          const w = s?.waiting_request;
          const verb = w?.questions?.length ? "等你作答" : `等你批准 ${compact(w?.tool_name || "", 16) || "操作"}`;
          text = `[等你拍板] 会话「${compact(s?.title || s?.initial_prompt || item.source_session_id.slice(0, 8), 20)}」${verb}已等 ${minutes} 分钟`;
        } else {
          text = `[等你拍板] 验收单《${compact(acceptanceTitle.get(key) ?? "", 24) || "未命名单"}》待回填已等 ${minutes} 分钟`;
        }
        if (this.options.userPush(compact(text, 120))) {
          item.user_pushed_at = now;
          changed = true;
        }
      }
    }

    for (const item of this.ledger.notifications) {
      if (item.resolved_at) continue;
      if (item.kind === "org-confirm" && !activeConfirmKeys.has(item.key)) {
        item.resolved_at = now;
        changed = true;
      }
      if (item.kind === "waiting" && !activeWaitingKeys.has(item.key)) {
        item.resolved_at = now;
        changed = true;
      }
      if (item.kind === "acceptance" && !activeAcceptanceKeys.has(item.key)) {
        item.resolved_at = now;
        changed = true;
      }
    }

    if (changed) writeDecisionNotificationLedger(this.path, this.ledger);
  }

  private targetSession(preferred: string, sessions: SessionState[]): string | null {
    if (preferred && sessions.some((session) => session.session_id === preferred)) return preferred;
    const leader = this.options.leaderSessionId();
    if (leader && sessions.some((session) => session.session_id === leader)) return leader;
    return sessions[0]?.session_id ?? null;
  }
}
