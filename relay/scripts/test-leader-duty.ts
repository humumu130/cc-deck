import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advanceDutyFeed,
  evaluateDutyPolicy,
  evaluateLeaderActionableWork,
  isValidDutyReceipt,
  parseDutyReceipt,
  serializeDutyReceipt,
  transitionDutyFeedCount,
  validateDutyReceipt,
  type DutyCandidate,
  type DutyQueueSnapshot,
  type DutyReceipt,
} from "../src/leader-duty.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures", name), "utf8")) as T;
let pass = 0;
let fail = 0;
function check(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
function finish(): never {
  console.log(`leader duty: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

const candidates = fixture<DutyQueueSnapshot>("duty-candidates.json");
const candidateResult = evaluateLeaderActionableWork(candidates);
check(candidateResult.actionable === true && candidateResult.reason === "actionable", "candidate snapshot is actionable");
check(candidateResult.candidates.length === 4, "four candidate classes are collected");
check(candidateResult.candidates.map((item) => item.kind).join(">") === "receipt>dispatch>todo>stale_doing", "candidate order is receipt, dispatch, todo, stale doing");
check(candidateResult.candidates.map((item) => item.id).join(",") === "sid-receipt,dispatch-hanging,todo-unlocked,dispatch-stale", "candidate ids preserve fixed order");

const allRunning = evaluateLeaderActionableWork(fixture<DutyQueueSnapshot>("duty-all-running.json"));
check(!allRunning.actionable && allRunning.reason === "all_running" && allRunning.candidates.length === 0, "all healthy running workers permit true sleep");

const blocked = evaluateLeaderActionableWork(fixture<DutyQueueSnapshot>("duty-blocked.json"));
check(!blocked.actionable && blocked.reason === "blocked", "blocked-only snapshot has no action bit");
check(blocked.blocked.length === 2 && blocked.blocked[0]?.reason === "user_confirm", "blocked items are retained for notification projection");
const empty = evaluateLeaderActionableWork({});
check(!empty.actionable && empty.reason === "empty" && empty.blocked.length === 0, "empty snapshot is idle");

let count = { consecutive_feeds: 0 };
const feed1 = transitionDutyFeedCount(count, "feed");
count = feed1.state;
const feed2 = advanceDutyFeed(count, "feed");
count = feed2.state;
const feed3 = advanceDutyFeed(count, "feed");
check(feed1.state.consecutive_feeds === 1 && !feed1.shouldSleep, "first feed increments without sleeping");
check(feed2.state.consecutive_feeds === 2 && !feed2.shouldSleep, "second feed increments without sleeping");
check(feed3.state.consecutive_feeds === 3 && feed3.shouldSleep === true, "K=3 requests natural sleep");
check(feed3.continuation?.delay_min_ms === 300000 && feed3.continuation.delay_max_ms === 900000, "continuation backs off 5-15 minutes");
check(feed3.continuation?.wake_once === true && feed3.continuation.auto_renew === false, "continuation is one-shot and non-renewing");
check(transitionDutyFeedCount(feed3.state, "natural_sleep").state.consecutive_feeds === 0, "natural sleep resets the chain");
check(transitionDutyFeedCount(feed3.state, "idle").state.consecutive_feeds === 0, "idle resets the chain");

const receipt = fixture<DutyReceipt>("duty-receipt.json");
const serialized = serializeDutyReceipt(receipt);
check(!serialized.includes("\n") && serialized.startsWith("{"), "DUTY_RECEIPT serializes as one-line JSON");
const parsed = parseDutyReceipt(serialized);
check(parsed?.v === 1 && parsed.feed_id === "feed-1" && parsed.actions.length === 2, "valid DUTY_RECEIPT parses");
check(isValidDutyReceipt(parsed), "valid DUTY_RECEIPT passes type guard");
check(validateDutyReceipt(receipt).ok, "valid DUTY_RECEIPT passes explicit validation");
check(validateDutyReceipt({ ...receipt, actions: [{ kind: "none", ids: [] }] }).ok, "none action with a next trigger is valid");
const forgedNone = fixture<unknown>("duty-none-invalid.json");
check(parseDutyReceipt(JSON.stringify(forgedNone)) === null, "kind=none without blocked/next_trigger explanation is rejected");
check(!validateDutyReceipt({ ...receipt, actions: [{ kind: "dispatch", ids: [] }] }).ok, "non-none action requires ids");
check(!validateDutyReceipt({ ...receipt, actions: [{ kind: "none", ids: ["fake"] }] }).ok, "none action cannot claim ids");

const knownTodo: DutyCandidate = candidateResult.candidates[2]!;
const unknownTodo: DutyCandidate = { ...knownTodo, id: "todo-unknown", risk: "unknown" };
const defaultPolicy = evaluateDutyPolicy(knownTodo);
check(defaultPolicy.mode === "allow" && defaultPolicy.action === "dispatch" && defaultPolicy.auto_dispatch_enabled === true, "auto dispatch defaults true");
check(evaluateDutyPolicy(unknownTodo, { unknown_risk: "review_only" }).mode === "notify", "review_only unknown risk downgrades to notify");
check(evaluateDutyPolicy(unknownTodo, { unknown_risk: "deny" }).mode === "blocked", "deny unknown risk blocks automatic action");
check(evaluateDutyPolicy(knownTodo, { auto_dispatch_enabled: false }).mode === "notify", "disabled auto dispatch downgrades to notify");
check(evaluateDutyPolicy(knownTodo, { allowed_playbooks: ["other"] }).mode === "notify", "unapproved playbook downgrades to notify");
check(evaluateDutyPolicy(knownTodo, { overnight_budget: 1, overnight_budget_used: 1 }).reason === "overnight_budget_exhausted", "overnight budget exhaustion is enforced");
check(evaluateDutyPolicy(candidateResult.candidates[0]!, { auto_dispatch_enabled: false }).mode === "allow", "receipt acceptance remains a fact-source action");
check(evaluateDutyPolicy(knownTodo, { enabled: false }).mode === "blocked", "disabled duty policy blocks action");
const nightSnapshot = fixture<DutyQueueSnapshot>("duty-night-budget.json");
const nightCandidate = evaluateLeaderActionableWork(nightSnapshot).candidates[0]!;
check(evaluateDutyPolicy(nightCandidate, nightSnapshot.duty_policy).mode === "notify", "night budget fixture prevents automatic dispatch");

finish();
