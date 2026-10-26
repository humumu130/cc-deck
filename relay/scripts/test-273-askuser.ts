// #273 AskUserQuestion 云回传——套件测试（快通道，无真 CLI）
//
// 覆盖四断言域：
//   ① 超时：AskUserHold arm 到点触发 + 触发后进入迟到可注入窗（injectable 命中）
//   ② 撤销/过期：settle 后不触发；迟到窗越界 injectable 返回 undefined
//   ③ 幂等：COMMAND_ANSWER 首答 ok，重复答/未知 rid 均 ok:false 且 SESSION_WAITING_RESOLVED
//      帧该 request_id 只发一条（不二次写）
//   ④ 回收：decision=timeout 决议广播 → 端上 waiting_request 清空（「已失效」回收链）
// 转发/回写（waiting 卡 questions 下发 + deny-message 回写 CLI 续跑）由
// test-273-askuser-e2e.ts 真 CLI 双端实测覆盖（回执证据件）。
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { AskUserHold, LATE_INJECT_WINDOW_MS } from "../src/ask-user-hold.js";
import type { AskQuestion } from "../src/types.js";
import { loadConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { Command, WaitingPayload } from "../src/types.js";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`FAIL - ${msg}`);
    return;
  }
  passed++;
  console.log(`ok - ${msg}`);
}
function done(): void {
  if (failed > 0) {
    console.error(`\n${failed} FAILED, ${passed} passed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed`);
}

const Q: AskQuestion[] = [
  { header: "午餐", question: "今天吃什么？", multi: false, options: [{ label: "饺子" }, { label: "面条" }] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- ①② AskUserHold 单元 ----------
{
  const h = new AskUserHold(LATE_INJECT_WINDOW_MS);
  let fired = 0;
  const rid = randomUUID();
  h.arm(rid, Q, () => fired++, 40);
  await sleep(90);
  assert(fired === 1, `① 超时触发：arm(40ms) 后到点回调一次（实际 ${fired}）`);
  assert(JSON.stringify(h.injectable(rid)) === JSON.stringify(Q), "① 迟到窗：触发后 injectable 返回原问题集");
  assert(h.injectable(randomUUID()) === undefined, "② 未知 rid：injectable 返回 undefined");

  const h2 = new AskUserHold(30); // 迟到窗 30ms，验过期
  let fired2 = 0;
  const rid2 = randomUUID();
  h2.arm(rid2, Q, () => fired2++, 20);
  await sleep(120);
  assert(fired2 === 1, "② h2 触发一次");
  assert(h2.injectable(rid2) === undefined, "② 迟到窗过期：越界后 injectable 返回 undefined");

  let fired3 = 0;
  const rid3 = randomUUID();
  h.arm(rid3, Q, () => fired3++, 40);
  h.settle(rid3);
  await sleep(90);
  assert(fired3 === 0, "② settle 撤销：决议先到则超时不触发");
  h.clear();
}

// ---------- ③④ manager 级（FakeAgent 直驱） ----------
// 沙盒铁律（test-waiting-deadlock 同款）：钉死数据目录防生产泄漏
const dataDir = mkdtempSync(join(tmpdir(), "ccr-273-"));
process.env.CCR_DATA_DIR = dataDir;
process.env.CCR_PORT = "18973"; // 显式错开（worker 会话自带 CCR_PORT=8787，||= 不覆盖已继承值）
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);

const frames: { type: string; payload: Record<string, unknown> }[] = [];
bus.subscribe((e) => frames.push({ type: e.type, payload: e.payload as Record<string, unknown> }));

class FakeAgent implements AgentLike {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  sent: string[] = [];
  private pendingIds = new Set<string>();
  ended = false;
  constructor(private cb: AgentCallbacks) {}
  sendMessage(text: string): void {
    this.sent.push(text);
    if (this.pendingIds.size === 0) this.cb.onStatusChange("WORKING", "收到消息");
  }
  allow(requestId: string): boolean {
    if (!this.pendingIds.delete(requestId)) return false;
    this.cb.onWaitingResolved(requestId, "allow", "tester");
    return true;
  }
  deny(requestId: string): boolean {
    if (!this.pendingIds.delete(requestId)) return false;
    this.cb.onWaitingResolved(requestId, "deny", "tester");
    return true;
  }
  answer(requestId: string): boolean {
    if (!this.pendingIds.delete(requestId)) return false;
    this.cb.onWaitingResolved(requestId, "answer", "tester");
    return true;
  }
  async stop(): Promise<void> {
    this.ended = true;
    for (const id of [...this.pendingIds]) this.deny(id);
  }
  async setPermissionMode(): Promise<void> {}
  hasPending(): boolean {
    return this.pendingIds.size > 0;
  }
  fireWaiting(p: WaitingPayload): void {
    this.pendingIds.add(p.request_id);
    this.cb.onWaiting(p);
  }
  timeout(requestId: string): void {
    if (!this.pendingIds.delete(requestId)) return;
    this.cb.onWaitingResolved(requestId, "timeout", "relay");
    this.cb.onStatusChange("WORKING", "超时放行继续");
  }
}

let live: FakeAgent | null = null;
mgr.setAgentFactory((_cwd, _model, cb) => {
  live = new FakeAgent(cb);
  return live;
});

function cmd(c: Omit<Command, "command_id" | "ts">): Command {
  return { ...c, command_id: randomUUID(), ts: Date.now() } as Command;
}

const ack = mgr.handleCommand(cmd({ type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "测试会话" } }), "tester");
assert(ack.ok, `会话建立（${ack.session_id}）`);
const sid = ack.session_id!;
const agent = () => live as unknown as FakeAgent;

const rid = randomUUID();
agent().fireWaiting({
  request_id: rid,
  tool_name: "AskUserQuestion",
  input_summary: "提问: 午餐",
  suggestions: [],
  received_at: Date.now(),
  questions: Q,
});

// ③ 幂等：首答 ok → 重复答与未知 rid 均 ok:false，resolved 帧唯一
const a1 = mgr.handleCommand(cmd({ type: "COMMAND_ANSWER", payload: { session_id: sid, request_id: rid, answers: ["饺子"] } }), "tester");
assert(a1.ok, "③ 首次作答 ack ok");
const a2 = mgr.handleCommand(cmd({ type: "COMMAND_ANSWER", payload: { session_id: sid, request_id: rid, answers: ["饺子"] } }), "tester");
assert(!a2.ok, `③ 重复作答幂等拒绝（${a2.error}）`);
const a3 = mgr.handleCommand(cmd({ type: "COMMAND_ANSWER", payload: { session_id: sid, request_id: randomUUID(), answers: ["饺子"] } }), "tester");
assert(!a3.ok, `③ 未知 request_id 拒绝（${a3.error}）`);
const resolvedFrames = frames.filter((f) => f.type === "SESSION_WAITING_RESOLVED" && f.payload.request_id === rid);
assert(resolvedFrames.length === 1 && resolvedFrames[0].payload.decision === "answer", "③ 该 rid 的 SESSION_WAITING_RESOLVED 恰一条（answer）");

// ④ 回收：timeout 决议 → 广播 + waiting_request 清空
const rid2 = randomUUID();
agent().fireWaiting({
  request_id: rid2,
  tool_name: "AskUserQuestion",
  input_summary: "提问: 午餐",
  suggestions: [],
  received_at: Date.now(),
  questions: Q,
});
const snapDuringWait = mgr.snapshot().find((s) => s.session_id === sid);
assert(snapDuringWait?.waiting_request?.request_id === rid2, "④ 挂起中快照 waiting_request 在场");
agent().timeout(rid2);
const toFrames = frames.filter((f) => f.type === "SESSION_WAITING_RESOLVED" && f.payload.request_id === rid2);
assert(toFrames.length === 1 && toFrames[0].payload.decision === "timeout", "④ timeout 决议广播恰一条（decision=timeout，端上「已失效」回收锚）");
const snapAfter = mgr.snapshot().find((s) => s.session_id === sid);
assert(snapAfter?.waiting_request == null, "④ 决议后快照 waiting_request 清空（卡片回收）");

rmSync(dataDir, { recursive: true, force: true });
done();
