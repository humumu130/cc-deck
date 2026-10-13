// W-ACTIVATOR 测试：事件触发（SESSION_ERROR/派单失败）→复活尝试；同会话冷却窗不重复拉；
// 全局滚动窗上限；liveness 在途去重（resumePending 互斥→skip）；SESSION_DELETED 不触发；
// 复活失败→attention 通知（stableKey 幂等）；CCR_NO_ACTIVATOR 逃生阀。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { attachAgentActivator } from "../src/agent-activator.js";
import type { RelayConfig } from "../src/config.js";
import type { Envelope } from "../src/types.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string, detail = "") {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name + (detail ? " | " + detail : "")); }
}
function section(t: string) { console.log(t); }

const savedEnv: Record<string, string | undefined> = {};
const KEYS = ["CCR_ORG_DIR", "CCR_CONFIG_FILE", "CCR_STORAGE_READ_MODE", "CCR_NO_ACTIVATOR", "CCR_ACTIVATOR_COOLDOWN_MS", "CCR_ACTIVATOR_MAX_PER_HOUR", "CCR_NO_AUTOREVIVE", "CCR_DATA_DIR"] as const;
for (const k of KEYS) savedEnv[k] = process.env[k];
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_DATA_DIR = mkdtempSync(join(tmpdir(), "ccr-act-data-")); // 隔离生产 env（经验条）
process.env.CCR_NO_AUTOREVIVE = "1";

const dirs: string[] = [];
function mk(): { bus: EventBus; mgr: SessionManager } {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-act-org-")); dirs.push(ORG);
  const CFG = mkdtempSync(join(tmpdir(), "ccr-act-cfg-")); dirs.push(CFG);
  // 每节铸新 data dir：构造时 loadNotifications() 会从 <dataDir>/notifications.json
  // 还原通知账——共享一个 dir 会让上一节的 activator 通知漏进下一节的断言（S7 实锤）
  const DATA = mkdtempSync(join(tmpdir(), "ccr-act-data-")); dirs.push(DATA);
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  process.env.CCR_DATA_DIR = DATA;
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  return { bus, mgr: new SessionManager(bus, cfg) };
}
// 造一个「死而可拉」的托管会话：无 agent + relay_session_id + 未完待办
function seedDeadSession(mgr: SessionManager, sid: string): void {
  mgr.ensureExternal(sid, "/tmp/x", "seed", sid, Date.now() - 60_000);
  // external 兜底翻 false（ensureExternal 会设 external）——直接改内存态成托管死会话
  const s = (mgr as unknown as { sessions: Map<string, { state: Record<string, unknown>; agent: unknown }> }).sessions.get(sid)!;
  delete s.state.external;
  s.state.relay_session_id = sid;
  s.state.status = "ERROR";
  s.state.updated_at = Date.now();
}
// 造「死而可拉且有未完待办」的托管会话：独立家 tasks 存储写真文件（过资格链
// 的待办关——readTaskStoreTodos 直读 <employee_home>/tasks/<sid>/*.json，#17 口径）
function seedEligibleSession(mgr: SessionManager, sid: string): void {
  seedDeadSession(mgr, sid);
  const HOME = mkdtempSync(join(tmpdir(), "ccr-act-home-")); dirs.push(HOME);
  const s = (mgr as unknown as { sessions: Map<string, { state: Record<string, unknown> }> }).sessions.get(sid)!;
  s.state.employee_home = HOME;
  mkdirSync(join(HOME, "tasks", sid), { recursive: true });
  writeFileSync(join(HOME, "tasks", sid, "1.json"), JSON.stringify({ id: 1, subject: "未完成任务", status: "pending" }));
}

// ---------- S1 SESSION_ERROR 触发复活尝试 ----------
section("\nS1 SESSION_ERROR 触发");
{
  const { bus, mgr } = mk();
  process.env.CCR_NO_ACTIVATOR = undefined as unknown as string;
  delete process.env.CCR_NO_ACTIVATOR;
  seedDeadSession(mgr, "s-dead1");
  const h = attachAgentActivator(bus, mgr);
  bus.emit("s-dead1", "SESSION_ERROR", { message: "boom" });
  assert(h.stats().triggers === 1, "S1 ERROR 事件→触发一次", JSON.stringify(h.stats()));
  // 无 agent/无 SDK 会话记录 → resumeAgent 走 fresh spawn……不落 fake 会真 spawn！
  // 此处依赖 reviveEligible 先挡：无待办文件 → skip（不触 spawn）
  assert(h.stats().skipped >= 1, "S1 无未完待办→资格链 skip（零 spawn）", JSON.stringify(h.stats()));
  h.detach();
}

// ---------- S2 冷却窗内不重复拉 ----------
section("\nS2 同会话冷却窗");
{
  const { bus, mgr } = mk();
  process.env.CCR_ACTIVATOR_COOLDOWN_MS = "3600000"; // 1h 窗内
  delete process.env.CCR_NO_ACTIVATOR;
  seedDeadSession(mgr, "s-cool");
  const h = attachAgentActivator(bus, mgr);
  bus.emit("s-cool", "SESSION_ERROR", { message: "1" });
  bus.emit("s-cool", "SESSION_ERROR", { message: "2" });
  bus.emit("s-cool", "SESSION_ERROR", { message: "3" });
  const st = h.stats();
  assert(st.triggers === 1 && st.cooldownHits === 2, "S2 连发三事件→一次触发+两次冷却拦截", JSON.stringify(st));
  h.detach();
  process.env.CCR_ACTIVATOR_COOLDOWN_MS = savedEnv.CCR_ACTIVATOR_COOLDOWN_MS;
}

// ---------- S3 全局滚动窗上限 ----------
section("\nS3 全局小时窗上限");
{
  const { bus, mgr } = mk();
  process.env.CCR_ACTIVATOR_COOLDOWN_MS = "1"; // 冷却近零（单会话不挡）
  process.env.CCR_ACTIVATOR_MAX_PER_HOUR = "2";
  delete process.env.CCR_NO_ACTIVATOR;
  const h = attachAgentActivator(bus, mgr);
  for (let i = 0; i < 5; i++) bus.emit(`s-w${i}`, "SESSION_ERROR", { message: "x" });
  const st = h.stats();
  assert(st.triggers === 2 && st.windowHits === 3, "S3 五会话连死→2 次后窗上限拦截 3 次", JSON.stringify(st));
  h.detach();
  process.env.CCR_ACTIVATOR_COOLDOWN_MS = savedEnv.CCR_ACTIVATOR_COOLDOWN_MS;
  process.env.CCR_ACTIVATOR_MAX_PER_HOUR = savedEnv.CCR_ACTIVATOR_MAX_PER_HOUR;
}

// ---------- S4 SESSION_DELETED 不触发 ----------
section("\nS4 删除防护");
{
  const { bus, mgr } = mk();
  delete process.env.CCR_NO_ACTIVATOR;
  seedDeadSession(mgr, "s-del");
  const h = attachAgentActivator(bus, mgr);
  bus.emit("s-del", "SESSION_DELETED", {});
  assert(h.stats().triggers === 0, "S4 DELETED 零触发（显式意图不复活）", JSON.stringify(h.stats()));
  h.detach();
}

// ---------- S5 DISPATCH_DONE(failed) 触发 + liveness 在途去重 ----------
section("\nS5 派单失败触发 + 在途去重");
{
  const { bus, mgr } = mk();
  delete process.env.CCR_NO_ACTIVATOR;
  seedDeadSession(mgr, "s-worker");
  const h = attachAgentActivator(bus, mgr);
  bus.emit("", "DISPATCH_DONE", { dispatch_id: "d1", tier: "正经立项", status: "done", receipt: "ok", worker_session_id: "s-worker", ts: Date.now() });
  assert(h.stats().triggers === 0, "S5 前置：done 态不触发");
  bus.emit("", "DISPATCH_DONE", { dispatch_id: "d2", tier: "正经立项", status: "failed", receipt: "崩了", worker_session_id: "s-worker", ts: Date.now() });
  assert(h.stats().triggers === 1, "S5 failed→worker 复活尝试", JSON.stringify(h.stats()));
  h.detach();
  // liveness 在途去重：resumePending 置位（互斥窗）→ Eligible 返回 resume-in-flight
  const s = (mgr as unknown as { sessions: Map<string, { resumePending?: number }> }).sessions.get("s-worker")!;
  s.resumePending = Date.now();
  const r = mgr.reviveManagedSession("s-worker", "test", "在途测试");
  assert(r.skipped === "resume-in-flight", "S5 在途标记→skip（与 liveness 门互斥，不双拉）", JSON.stringify(r));
}

// ---------- S6 入口三态契约（skip/not-found 不炸） ----------
section("\nS6 入口契约");
{
  const { bus, mgr } = mk();
  delete process.env.CCR_NO_ACTIVATOR;
  seedDeadSession(mgr, "s-notify");
  const r1 = mgr.reviveManagedSession("s-notify", "test", "通知测试");
  assert(r1.ok === false && typeof r1.skipped === "string", "S6 skip 态返回契约（含原因）", JSON.stringify(r1));
  const r2 = mgr.reviveManagedSession("s-none", "test", "不存在会话");
  assert(r2.skipped === "not-found", "S6 不在册→not-found");
  const list = mgr.notificationsList();
  assert(Array.isArray(list) && list.every((n) => !n.key.includes("activator")), "S6 skip/not-found 不产生通知（只有真尝试才发）");
}

// ---------- S6a 复活成功通知（info/attention + stableKey 幂等） ----------
section("\nS6a 成功通知");
{
  const { bus, mgr } = mk();
  delete process.env.CCR_NO_ACTIVATOR;
  seedEligibleSession(mgr, "s-ok");
  // 实例补丁拦截 resumeAgent（私有方法，cast 到达）：隔离真 spawn，成功路径只验
  // revive 入口的通知契约——资格链已过（真 todos 文件），resumeAgent 调用即成功边
  const patch = mgr as unknown as { resumeAgent: (s: unknown, msg: string) => void };
  patch.resumeAgent = () => {};
  const r1 = mgr.reviveManagedSession("s-ok", "test", "成功通知测试");
  assert(r1.ok === true, "S6a 成功路径 ok:true（eligible+resume 拦截）", JSON.stringify(r1));
  const ok1 = mgr.notificationsList().filter((n) => n.key.includes("activator-revive"));
  assert(ok1.length === 1 && ok1[0]!.severity === "info" && ok1[0]!.group === "attention", "S6a 成功通知一行（info/attention）", JSON.stringify(ok1.map((n) => [n.severity, n.group])));
  const r2 = mgr.reviveManagedSession("s-ok", "test", "二次触发");
  assert(r2.ok === true, "S6a 二次调用仍成功（补丁未设 agent，链仍过）");
  const ok2 = mgr.notificationsList().filter((n) => n.key.includes("activator-revive"));
  assert(ok2.length === 1, "S6a stableKey 幂等（重复成功不双发）", String(ok2.length));
}

// ---------- S7 复活失败通知（waiting/attention 可操作） ----------
section("\nS7 失败通知");
{
  const { bus, mgr } = mk();
  delete process.env.CCR_NO_ACTIVATOR;
  seedEligibleSession(mgr, "s-fail");
  const patch = mgr as unknown as { resumeAgent: (s: unknown, msg: string) => void };
  patch.resumeAgent = () => { throw new Error("spawn 拒绝（测试注入）"); };
  const r = mgr.reviveManagedSession("s-fail", "test", "失败通知测试");
  assert(r.ok === false && r.error === "spawn 拒绝（测试注入）", "S7 失败路径 ok:false+error 透传", JSON.stringify(r));
  const f = mgr.notificationsList().filter((n) => n.key.includes("activator-fail"));
  assert(f.length === 1 && f[0]!.severity === "waiting" && f[0]!.actionable === true && f[0]!.group === "attention", "S7 失败通知一行（waiting/attention/actionable）", JSON.stringify(f.map((n) => [n.severity, n.group, n.actionable])));
  assert(!mgr.notificationsList().some((n) => n.key.includes("activator-revive")), "S7 失败不发成功通知（两态互斥）");
}

// ---------- 收尾 ----------
for (const k of KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
console.log(`\nagent-activator: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
void ({} as Envelope);
