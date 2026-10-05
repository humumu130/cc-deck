import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISION_NOTIFICATION_KINDS,
  groupNotifications,
  isDecisionNotificationKind,
  markNotificationDismissed,
  markNotificationHandled,
  markNotificationResolved,
  mergeDecisionNotifications,
  readDecisionNotificationLedger,
  stableKey,
  transitionNotification,
  writeDecisionNotificationLedger,
  type DecisionNotification,
  type NotificationLifecycleItem,
} from "../src/decision-notify.js";

let pass = 0;
let fail = 0;
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}

const root = mkdtempSync(join(tmpdir(), "cc-deck-notification-ledger-"));
const sourceContext = { domain: "session", entityId: "s1", alertId: "a1", returnPath: "/session/s1" };
function item(overrides: Partial<NotificationLifecycleItem> = {}): NotificationLifecycleItem {
  return {
    key: "org-confirm:cf-1:1",
    kind: "org-confirm",
    group: "action",
    severity: "waiting",
    title: "需要确认",
    body: "确认项目立项",
    sourceContext,
    actionable: true,
    created_at: 1_000,
    ...overrides,
  };
}
function ledgerItem(overrides: Partial<DecisionNotification> = {}): DecisionNotification {
  return {
    key: "org-confirm:cf-1:1",
    kind: "org-confirm",
    source_session_id: "s1",
    created_at: 1_000,
    group: "action",
    actionable: true,
    revision: "1",
    ...overrides,
  };
}

try {
  console.log("kind validator and stable keys:");
  assert(DECISION_NOTIFICATION_KINDS.join("|") === "org-confirm|waiting|dispatch|acceptance|system", "五类 kind 常量冻结");
  assert(DECISION_NOTIFICATION_KINDS.every(isDecisionNotificationKind), "五类 kind 全部通过 validator");
  assert(!isDecisionNotificationKind("leader-duty"), "leader-duty 仅预留未启用");
  assert(stableKey("org-confirm", "cf-1", "r2") === "org-confirm:cf-1:r2", "org-confirm stable key");
  assert(stableKey("waiting", "s1", "req-2") === "waiting:s1:req-2", "waiting stable key 使用 request_id");
  assert(stableKey("dispatch", "d-7", "ignored") === "dispatch:d-7", "dispatch stable key 不附加 revision");
  assert(stableKey("acceptance", "a-1", "r2") === "acceptance:a-1:r2" && stableKey("system", "relay-1") === "system:relay-1", "acceptance/system stable key 可扩展");

  console.log("group and badge projection:");
  const grouped = groupNotifications([
    item(),
    item({ key: "org-confirm:cf-2:1", actionable: false }),
    item({ key: "dispatch:d-1", kind: "dispatch", group: "attention", actionable: true }),
    item({ key: "system:s-1", kind: "system", group: "activity", actionable: true }),
  ]);
  assert(grouped.action.count === 2 && grouped.attention.count === 1 && grouped.activity.count === 1, "分组头计数等于当前渲染 item 数");
  assert(grouped.badgeCount === 1 && grouped.action.badgeCount === 1, "badge 只计 action+actionable");
  assert(groupNotifications([item({ handled_at: 2_000 })]).badgeCount === 0, "handled item 不再计 badge");

  console.log("lifecycle transitions:");
  const opened = transitionNotification(item(), "opened", 2_000);
  const browsed = transitionNotification(opened, "browsed", 3_000);
  const reconnected = transitionNotification(browsed, "reconnected", 4_000);
  assert(!opened.handled_at && !browsed.handled_at && !reconnected.resolved_at, "打开/浏览/重连不清零");
  const handled = markNotificationHandled(item(), 5_000);
  assert(handled.handled_at === 5_000 && handled.resolved_at === undefined, "来源动作成功只置 handled_at");
  const dismissed = markNotificationDismissed(item(), 6_000);
  assert(dismissed.dismissed_at === 6_000 && dismissed.handled_at === 6_000, "明确 dismiss 同时置 handled/dismissed");
  const resolved = markNotificationResolved(item({ handled_at: 5_000 }), 7_000);
  assert(resolved.resolved_at === 7_000 && resolved.handled_at === 5_000, "resolved_at 只由来源事实置位且与 handled 独立");

  console.log("revision merge and offline ledger:");
  const merged = mergeDecisionNotifications(
    [ledgerItem({ first_sent_at: 2_000 })],
    [ledgerItem({ key: "org-confirm:cf-1:2", revision: "2", handled_at: 8_000 })],
  );
  assert(merged.length === 1 && merged[0]?.key === "org-confirm:cf-1:2", "同确认单升 revision 合并为一条");
  assert(merged[0]?.first_sent_at === 2_000 && merged[0]?.handled_at === 8_000, "revision 合并保留生命周期字段");
  const waitingMerged = mergeDecisionNotifications(
    [ledgerItem({ kind: "waiting", key: "waiting:s1:req-1", revision: "req-1" })],
    [ledgerItem({ kind: "waiting", key: "waiting:s1:req-2", revision: "req-2" })],
  );
  assert(waitingMerged.length === 2, "不同 waiting instance 不被错误去重");

  const oldPath = join(process.cwd(), "tests", "fixtures", "notification-old.json");
  const oldLedgerPath = join(root, "old.json");
  writeFileSync(oldLedgerPath, readFileSync(oldPath));
  const oldLedger = readDecisionNotificationLedger(oldLedgerPath);
  assert(oldLedger.notifications.length === 2, "旧数组 ledger 可离线重载");
  assert(oldLedger.notifications.every((x) => x.group === "action" && x.actionable), "旧 ledger 缺字段按 action/actionable 降级");
  const newLedgerPath = join(root, "new.json");
  writeDecisionNotificationLedger(newLedgerPath, { notifications: merged });
  const roundTrip = readDecisionNotificationLedger(newLedgerPath);
  assert(roundTrip.notifications[0]?.handled_at === 8_000, "新字段全量写穿并可重载");
  const invalidPath = join(process.cwd(), "tests", "fixtures", "notification-invalid.json");
  assert(readDecisionNotificationLedger(invalidPath).notifications.length === 0, "未知 kind/坏字段安全丢弃");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`B3a notification ledger: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
