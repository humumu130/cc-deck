// 审批弹窗死锁回归测试（fake agent 直驱 SessionManager，不拉真 CLI）
//
// 用户报障：WAITING 中再发一条消息 → 弹窗消失，但卡片【处理】按钮还在，
// 且审批窗永远出不来。根因是 status 与 waiting_request 脱钩：
//   - agent.sendMessage 乐观报 WORKING（CLI 实际仍阻塞在 canUseTool）
//   - onStatusChange 无条件覆盖 status，waiting_request 无人清
//   - 端上卡片按钮只看 waiting_request、详情弹窗只看 status → 按钮在、弹窗永不出现
// 修复后约定：
//   ① sendMessage 在有未决议权限请求时不报 WORKING（adapter 侧）；manager 侧对
//      hasPending 的会话保持 WAITING（双保险）
//   ② CLI 真实推进（stream/assistant/result/tool_result）时清扫孤儿 pending，
//      补发 SESSION_WAITING_RESOLVED(decision=superseded)
//   ③ SESSION_UPDATED 恒带 waiting_request 权威值（null = 已清）
//   ④ RESOLVED 仅在 request_id 匹配当前挂起请求时才收口状态（防时序窗口打掉新请求）
import { randomUUID } from "node:crypto";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import { loadConfig } from "../src/config.js";
import type { Command, WaitingPayload } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

function cmd(c: Omit<Command, "command_id" | "ts">): Command {
  return { ...c, command_id: randomUUID(), ts: Date.now() } as Command;
}

// 假 agent：镜像真实 AgentSession 的关键语义（根治①后 sendMessage 不假报 WORKING）
class FakeAgent implements AgentLike {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  ended = false;
  sent: string[] = [];
  private pendingIds = new Set<string>();
  constructor(private cb: AgentCallbacks) {}

  sendMessage(text: string): void {
    this.sent.push(text);
    // 根治①语义：仍有未决议权限请求时不翻状态（CLI 阻塞在 canUseTool）
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
  answer(requestId: string, answers: string[]): boolean {
    if (!this.pendingIds.delete(requestId)) return false;
    this.cb.onWaitingResolved(requestId, "answer", "tester");
    void answers;
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

  // ---- 测试驱动 ----
  fireWaiting(p: WaitingPayload): void {
    this.pendingIds.add(p.request_id);
    this.cb.onWaiting(p);
  }
  // CLI 越过权限门（新输入打断）：孤儿请求补发 superseded + 真实活动翻 WORKING
  supersede(requestId: string): void {
    this.pendingIds.delete(requestId);
    this.cb.onWaitingResolved(requestId, "superseded");
    this.cb.onStatusChange("WORKING", "继续生成");
  }
  // 外部误报状态（旧版 adapter 行为复刻）：绕过 sendMessage 的 pending 守卫直发
  forceStatus(status: "WORKING" | "WAITING" | "ERROR" | "DONE", summary: string): void {
    this.cb.onStatusChange(status, summary);
  }
  // 晚到的孤儿决议（时序窗口复刻）
  lateSupersede(requestId: string): void {
    this.pendingIds.delete(requestId);
    this.cb.onWaitingResolved(requestId, "superseded");
  }
  turnEnd(ok: boolean, reason: string): void {
    this.cb.onTurnEnd(ok, reason, 1234);
  }
}

const bus = new EventBus();
const cfg = loadConfig();
const mgr = new SessionManager(bus, cfg);

const frames: { type: string; payload: Record<string, unknown> }[] = [];
bus.subscribe((e) => {
  frames.push({ type: e.type, payload: e.payload as Record<string, unknown> });
});

let live: FakeAgent | null = null;
mgr.setAgentFactory((_cwd, _model, cb) => {
  live = new FakeAgent(cb);
  return live;
});

const ack = mgr.handleCommand(
  cmd({ type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "测试会话" } }),
  "tester",
);
assert(ack.ok, `session created (${ack.session_id})`);
const sid = ack.session_id!;
const agent = () => live as unknown as FakeAgent;

const snap = () => mgr.snapshot().find((s) => s.session_id === sid);
const updates = () => frames.filter((f) => f.type === "SESSION_UPDATED");
const resolved = () => frames.filter((f) => f.type === "SESSION_WAITING_RESOLVED");

// ---- 场景 1：WAITING 中发消息（用户报障主路径）----
const reqA: WaitingPayload = { request_id: "req-A", tool_name: "Bash", input_summary: "跑脚本", suggestions: [] };
agent().fireWaiting(reqA);
{
  const s = snap()!;
  assert(s.status === "WAITING" && s.waiting_request?.request_id === "req-A", "WAITING 挂起 req-A");
}
frames.length = 0;

// 用户发消息：真实 adapter 语义 = sendMessage 不报 WORKING；这里再叠加"假报 WORKING"
// 的旧版行为做双保险验证——manager 必须靠 hasPending 保持 WAITING
agent().sendMessage("再帮我看看");
{
  const s = snap()!;
  assert(s.status === "WAITING", `发消息后仍 WAITING（CLI 阻塞在审批上，got ${s.status}）`);
  assert(s.waiting_request?.request_id === "req-A", "waiting_request 不丢（弹窗可再出）");
  assert(agent().sent.length === 1, "消息已入队");
}
// 旧版坏路径直击：pending 未清时外部误报 WORKING，manager 必须拒收
agent().forceStatus("WORKING", "误报");
assert(snap()!.status === "WAITING", "pending 未清时 WORKING 误报被拒收（双保险）");

// ---- 场景 2：正常决议（允许）----
// 决议路径只发 SESSION_WAITING_RESOLVED（不发 UPDATE，端上由 RESOLVED 帧自行翻状态）
frames.length = 0;
agent().allow("req-A");
{
  const s = snap()!;
  assert(s.status === "WORKING" && !s.waiting_request, "允许后 WORKING 且 waiting_request 已清");
  assert(resolved().some((r) => (r.payload as { decision: string }).decision === "allow"), "RESOLVED(allow) 已广播");
}

// ---- 场景 3：CLI 越过权限门（孤儿清扫 superseded）----
frames.length = 0;
const reqB: WaitingPayload = { request_id: "req-B", tool_name: "Bash", input_summary: "又来一个", suggestions: [] };
agent().fireWaiting(reqB);
agent().supersede("req-B");
{
  const s = snap()!;
  assert(s.status === "WORKING" && !s.waiting_request, "孤儿清扫后 WORKING 且 waiting_request 已清");
  const upd = updates().find((u) => (u.payload as { status?: string }).status === "WORKING");
  assert(!!upd && upd.payload.waiting_request === null, "WORKING 状态帧恒带 waiting_request:null（权威自愈通道）");
  assert(resolved().some((r) => (r.payload as { decision: string }).decision === "superseded"), "RESOLVED(superseded) 已广播");
}

// ---- 场景 4：superseded 晚到时序窗口（不得打掉更新的 WAITING）----
const reqC: WaitingPayload = { request_id: "req-C", tool_name: "Bash", input_summary: "第三个", suggestions: [] };
agent().fireWaiting(reqC);
const reqD: WaitingPayload = { request_id: "req-D", tool_name: "Bash", input_summary: "第四个", suggestions: [] };
agent().fireWaiting(reqD); // C 被 D 顶替但 C 的 superseded 补发晚到
agent().lateSupersede("req-C");
{
  const s = snap()!;
  assert(s.status === "WAITING" && s.waiting_request?.request_id === "req-D", "晚到的 superseded 不打掉新请求 D 的 WAITING");
}

// ---- 场景 5：回合收口清残留（打断等待中的请求）----
agent().turnEnd(true, "interrupted");
{
  const s = snap()!;
  assert(s.status === "DONE" && !s.waiting_request, "回合结束清残留 waiting_request（终态不脱钩）");
}

console.log("\nWAITING DEADLOCK TESTS PASSED");
process.exit(0);
