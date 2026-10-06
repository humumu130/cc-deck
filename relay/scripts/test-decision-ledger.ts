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
  mergeReloadedLedger,
  normalizeDecisionNotification,
  normalizeSourceContext,
  projectLedgerNotifications,
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

  // ---------- #018-B3a 扩展面：sourceContext 持久化 / ledger→投影 / 离线重载幂等 ----------
  console.log("B3a sourceContext persistence:");
  const sc = { domain: "org-confirm", entityId: "cf-9", alertId: "org-confirm:cf-9:1", returnPath: "/org/confirm/cf-9", sessionId: "s9" };
  const scOk = normalizeSourceContext(sc);
  assert(!!scOk && scOk.entityId === "cf-9" && scOk.sessionId === "s9", "sourceContext 齐全保留（含可选 sessionId）");
  assert(normalizeSourceContext({ ...sc, returnPath: undefined }) === undefined, "sourceContext 必填缺→整块丢（不炸不猜）");
  assert(normalizeSourceContext("bad") === undefined && normalizeSourceContext(null) === undefined, "sourceContext 非 object→undefined");
  const scRow = normalizeDecisionNotification({ ...ledgerItem({ key: "org-confirm:cf-9:1" }), source_context: { domain: "x" } });
  assert(scRow !== null && scRow.source_context === undefined, "坏 source_context 行保留但快照块丢弃（行级容错）");
  const scPath = join(root, "sc.json");
  writeDecisionNotificationLedger(scPath, { notifications: [{ ...ledgerItem({ key: "org-confirm:cf-9:1" }), source_context: sc! }] });
  assert(readDecisionNotificationLedger(scPath).notifications[0]?.source_context?.returnPath === "/org/confirm/cf-9", "source_context 写穿并离线重载还原");
  const mergedSc = mergeDecisionNotifications(
    [ledgerItem({ key: "org-confirm:cf-9:1", first_sent_at: 100 })],
    [ledgerItem({ key: "org-confirm:cf-9:1", handled_at: 200, source_context: sc! })],
  );
  assert(mergedSc.length === 1 && mergedSc[0]?.source_context?.entityId === "cf-9" && mergedSc[0]?.handled_at === 200, "合并保留 sourceContext 与生命周期字段（去重不丢溯源）");

  console.log("B3a ledger projection:");
  const projInput: DecisionNotification[] = [
    ledgerItem({ key: "org-confirm:cf-2:1", created_at: 2_000 }),
    ledgerItem({ key: "org-confirm:cf-1:1", created_at: 2_000, handled_at: 3_000 }),
    ledgerItem({ key: "system:relay-1", kind: "system", group: "activity", actionable: false, created_at: 1_000 }),
    ledgerItem({ key: "waiting:s1:req-9", kind: "waiting", created_at: 3_000, resolved_at: 4_000 }),
  ];
  const projected = projectLedgerNotifications(projInput);
  assert(projected.length === 4 && projected[0]?.key === "system:relay-1", "投影输出按 created_at 升序");
  assert(projected[1]?.key === "org-confirm:cf-1:1" && projected[2]?.key === "org-confirm:cf-2:1", "同 ts 按 key 字典序（排序稳定）");
  assert(projected[3]?.severity === "done" && projected[3]?.resolved_at === 4_000, "resolved → done（携带 resolved_at）");
  assert(projected[1]?.severity === "waiting", "actionable handled 但未 resolved → 仍 waiting");
  assert(projected.every((p) => p.sourceContext.domain !== undefined && typeof p.sourceContext.alertId === "string"), "投影逐项携带 sourceContext（合成降级不静默丢）");
  const legacy = projectLedgerNotifications([{ ...ledgerItem({ key: "waiting:s1:req-1", kind: "waiting" }) }])[0]!;
  assert(legacy.sourceContext.entityId === "s1" && legacy.sourceContext.alertId === "waiting:s1:req-1" && legacy.sourceContext.returnPath === "",
    "旧行（无 source_context）从 key+session 合成降级（alertId=key 可回查）");
  assert(projectLedgerNotifications(projInput, { includeHandled: false }).length === 2, "includeHandled:false 过滤 handled/resolved（dismissed 同口径）");
  assert(projectLedgerNotifications([]).length === 0 && projectLedgerNotifications([]).length === projectLedgerNotifications([]).length, "空输入→空输出（确定性）");
  const groupedProj = groupNotifications(projected);
  assert(groupedProj.action.count === 3 && groupedProj.activity.count === 1, "投影→分组全链计数稳定");
  assert(groupedProj.badgeCount === 1, "投影→badge 链：handled 行不计 badge");

  console.log("B3a offline reload idempotency:");
  const dupLedger = readDecisionNotificationLedger(join(process.cwd(), "tests", "fixtures", "notification-ledger-dup.json"));
  assert(dupLedger.notifications.length === 2, "dup fixture 两行同 identity 在位");
  const deduped = mergeReloadedLedger([], dupLedger.notifications);
  assert(deduped.length === 1, "重复 decision 合并为一条");
  assert(deduped[0]?.first_sent_at === 1_100 && deduped[0]?.handled_at === 1_300, "合并字段保留（first_sent_at+handled_at 各取有值侧）");
  const reloadOnce = mergeReloadedLedger([ledgerItem({ key: "org-confirm:cf-dup:1", first_sent_at: 900 })], deduped);
  const reloadTwice = mergeReloadedLedger([ledgerItem({ key: "org-confirm:cf-dup:1", first_sent_at: 900 })], reloadOnce);
  assert(JSON.stringify(reloadOnce) === JSON.stringify(reloadTwice), "离线重载幂等：二次合并深度相等（不重发不翻态）");
  assert(reloadOnce[0]?.created_at === 1_000 && reloadOnce[0]?.first_sent_at === 1_100 && reloadOnce[0]?.handled_at === 1_300, "重载以盘上台账权威：created_at 取 min、盘上 first_sent/handled 不被内存回滚");
  const emptyLedger = readDecisionNotificationLedger(join(process.cwd(), "tests", "fixtures", "notification-ledger-empty.json"));
  assert(emptyLedger.notifications.length === 0 && mergeReloadedLedger([], emptyLedger.notifications).length === 0, "空台账读空+重载空合并空");
  const corruptLedger = readDecisionNotificationLedger(join(process.cwd(), "tests", "fixtures", "notification-ledger-corrupt.json"));
  assert(corruptLedger.notifications.length === 0, "坏 JSON（半截文件）→ 空台账不炸");
  const mixedLedger = readDecisionNotificationLedger(join(process.cwd(), "tests", "fixtures", "notification-ledger-mixed.json"));
  assert(mixedLedger.notifications.length === 3, "mixed fixture：3 好行保留 2 坏行丢（未知 kind+非 string session）");
  const mixedKept = mixedLedger.notifications.find((x) => x.key === "org-confirm:cf-m1:1");
  const mixedDroppedSc = mixedLedger.notifications.find((x) => x.key === "waiting:s-m2:req-2");
  assert(!!mixedKept?.source_context && mixedKept.source_context.sessionId === "s-leader", "齐全快照保留");
  assert(mixedDroppedSc !== undefined && mixedDroppedSc.source_context === undefined, "缺必填的快照块丢弃但行保留（逐条可判定）");
  const mixedProjected = projectLedgerNotifications(mixedLedger.notifications);
  const mixedSynth = mixedProjected.find((p) => p.key === "waiting:s-m3:req-3")!;
  assert(mixedSynth.sourceContext.domain === "waiting" && mixedSynth.sourceContext.entityId === "s-m3" && mixedSynth.sourceContext.sessionId === "s-m3",
    "无快照行投影合成降级（domain=kind、entityId 取 key 中段、sessionId 透传）");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`B3a notification ledger: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
