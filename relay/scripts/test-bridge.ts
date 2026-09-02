// hooks 桥接全链路测试：模拟 bridge-hook.mjs 的 POST 序列 + WS 客户端命令
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import type { BridgeEvent, Command, CommandAckPayload, Envelope, WaitingPayload } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const fakeLog = (): string[][] => {
  try {
    return readFileSync(INJECT_LOG, "utf-8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

process.env.CCR_PORT = "8798";
process.env.CCR_TOKEN = "test-token-123";
process.env.CCR_BRIDGE_TOKEN = "bridge-token-456";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_INJECT_CMD = fileURLToPath(new URL("./fake-injector.mjs", import.meta.url));
const INJECT_LOG = fileURLToPath(new URL("../data/test-inject.log", import.meta.url));
process.env.CCR_INJECT_LOG = INJECT_LOG;
rmSync(INJECT_LOG, { force: true });
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
startServer(bus, mgr, cfg, { holdMs: 1200, gateToolsRaw: "Bash,Edit" });
await wait(300);

const http = `http://127.0.0.1:${cfg.port}`;
const extId = (cli: string) => "ext-" + cli;

function hook(ev: Partial<BridgeEvent> & { event: string }, token = cfg.bridgeToken): Promise<{ status: number; body: { decision?: string; reason?: string } }> {
  return fetch(`${http}/bridge/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": token },
    body: JSON.stringify({ session_id: "cli-1", cwd: process.cwd(), ...ev }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

// WS 客户端
const events: Envelope[] = [];
const acks: CommandAckPayload[] = [];
let wsCur: WebSocket | undefined;
function attach(ws: WebSocket) {
  wsCur = ws;
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as Envelope | (CommandAckPayload & { type: string });
    if ((m as { type: string }).type === "COMMAND_ACK") acks.push(m as CommandAckPayload);
    else events.push(m as Envelope);
  });
}
const first = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
attach(first);
await new Promise((r) => first.once("open", r));
await wait(200);

function send(type: Command["type"], payload: unknown): string {
  const id = randomUUID();
  wsCur!.send(JSON.stringify({ command_id: id, type, payload, ts: Date.now() }));
  return id;
}
async function waitAck(id: string): Promise<CommandAckPayload> {
  for (let i = 0; i < 20; i++) {
    const a = acks.find((x) => x.command_id === id);
    if (a) return a;
    await wait(100);
  }
  throw new Error("ack timeout");
}
const findEvt = (type: string, sid = extId("cli-1")) => events.find((e) => e.type === type && e.session_id === sid);

// 0. health
assert((await fetch(`${http}/health`)).ok, "server listening");

// 1. 错 token → 403
const forbidden = await hook({ event: "UserPromptSubmit", prompt: "x" }, "WRONG");
assert(forbidden.status === 403, "wrong bridge token rejected");

// 2. UserPromptSubmit → SESSION_CREATED(external)
const r1 = await hook({ event: "UserPromptSubmit", prompt: "帮我修复登录页面的 bug" });
await wait(200);
assert(r1.status === 200 && r1.body.decision === "pass", "UserPromptSubmit pass");
const created = findEvt("SESSION_CREATED") as Envelope<"SESSION_CREATED", { external?: boolean; title: string }> | undefined;
assert(!!created, "SESSION_CREATED emitted");
assert(created?.payload.external === true, "created marked external");
assert(created?.payload.title === "帮我修复登录页面的 bug", "title from prompt");

// 3. remote_mode 关：PreToolUse Bash → 立即 pass
let r2 = await hook({ event: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, permission_mode: "default" });
await wait(150);
assert(r2.body.decision === "pass", "gate off: immediate pass");
assert(events.some((e) => e.type === "SESSION_LOG" && (e.payload as { kind: string }).kind === "tool_use"), "tool_use logged");

// 4. 开远程审批 → EXT_MODE ack + UPDATE(remote_mode)
const ackId = send("COMMAND_EXT_MODE", { session_id: extId("cli-1"), enabled: true });
const ack4 = await waitAck(ackId);
assert(ack4.ok, "EXT_MODE acked");
const upd = events.filter((e) => e.type === "SESSION_UPDATED").at(-1) as Envelope<"SESSION_UPDATED", { remote_mode?: boolean }> | undefined;
assert(upd?.payload.remote_mode === true, "UPDATE carries remote_mode=true");

// 5. PreToolUse Bash → 挂起 + WAITING(decidable) → CONTINUE → allow
const held1 = hook({ event: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, permission_mode: "default" });
await wait(300);
const waiting = findEvt("SESSION_WAITING") as Envelope<"SESSION_WAITING", WaitingPayload> | undefined;
assert(!!waiting, "WAITING emitted while held");
assert(waiting?.payload.decidable === true, "WAITING decidable");
const contId = send("COMMAND_CONTINUE", { session_id: extId("cli-1"), request_id: waiting!.payload.request_id });
assert((await waitAck(contId)).ok, "CONTINUE acked");
assert((await held1).body.decision === "allow", "hook got allow");
assert(!!findEvt("SESSION_WAITING_RESOLVED"), "WAITING_RESOLVED emitted");

// 6. 再来一次 → REJECT → deny + reason
const held2 = hook({ event: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl evil" }, permission_mode: "default" });
await wait(300);
const w2 = events.filter((e) => e.type === "SESSION_WAITING").at(-1) as Envelope<"SESSION_WAITING", WaitingPayload>;
const rejId = send("COMMAND_REJECT", { session_id: extId("cli-1"), request_id: w2.payload.request_id, reason: "不放心这个命令" });
await waitAck(rejId);
const r6 = await held2;
assert(r6.body.decision === "deny" && r6.body.reason === "不放心这个命令", "hook got deny + reason");

// 7. bypassPermissions → 不拦截
let r7 = await hook({ event: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, permission_mode: "bypassPermissions" });
assert(r7.body.decision === "pass", "bypass mode: no gating");

// 8. 非门控工具（Read）→ pass
let r8 = await hook({ event: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" }, permission_mode: "default" });
assert(r8.body.decision === "pass", "non-gated tool: pass");

// 9. 挂起超时 → pass + WAITING_RESOLVED(timeout)
const before9 = events.filter((e) => e.type === "SESSION_WAITING_RESOLVED").length;
const r9 = await hook({ event: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.ts" }, permission_mode: "default" });
assert(r9.body.decision === "pass", "hold timeout: pass");
const resolved = events.filter((e) => e.type === "SESSION_WAITING_RESOLVED");
assert(resolved.length === before9 + 1 && (resolved.at(-1)!.payload as { decision: string }).decision === "timeout", "timeout resolved event");

// 10. 无客户端在线 → 不拦截
wsCur!.close();
await wait(300);
let r10 = await hook({ event: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo x" }, permission_mode: "default" });
assert(r10.body.decision === "pass", "no clients online: pass");
// 重连
const second = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
attach(second);
await new Promise((r) => second.once("open", r));
await wait(200);
const snap = events.filter((e) => e.type === "SNAPSHOT").at(-1) as Envelope<"SNAPSHOT", { sessions: { session_id: string; external?: boolean; remote_mode?: boolean }[] }>;
const extSnap = snap.payload.sessions.find((s) => s.session_id === extId("cli-1"));
assert(!!extSnap && extSnap.external === true && extSnap.remote_mode === true, "snapshot: external session with remote_mode");

// 11. Notification 权限 → passive WAITING
await hook({ event: "Notification", message: "Claude needs your permission to use Bash" });
await wait(150);
const w11 = events.filter((e) => e.type === "SESSION_WAITING").at(-1) as Envelope<"SESSION_WAITING", WaitingPayload>;
assert(w11?.payload.decidable === false, "passive WAITING (not decidable)");

// 12. 外部会话 MESSAGE → 拒绝
const msgId = send("COMMAND_MESSAGE", { session_id: extId("cli-1"), text: "hi" });
const ack12 = await waitAck(msgId);
assert(ack12.ok === false && (ack12.error ?? "").includes("外部会话"), "MESSAGE rejected for external");

// 13. PostToolUse → 清 passive WAITING + tool_result
await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: { stdout: "ok" } });
await wait(150);
const upd13 = events.filter((e) => e.type === "SESSION_UPDATED").at(-1) as Envelope<"SESSION_UPDATED", { status: string }>;
assert(upd13?.payload.status === "WORKING", "passive waiting cleared");

// 14. Stop → DONE
await hook({ event: "Stop" });
await wait(150);
const done = findEvt("SESSION_DONE") as Envelope<"SESSION_DONE", { duration_ms: number }> | undefined;
assert(!!done && done.payload.duration_ms >= 0, "Stop → DONE");

// 15. cli_pid 捕获：事件携带 cli_pid → 状态存储（新回合 WORKING）
await hook({ event: "UserPromptSubmit", prompt: "看看这个目录", cli_pid: 4321 });
await wait(150);
assert(mgr.snapshot().find((s) => s.session_id === extId("cli-1"))?.cli_pid === 4321, "cli_pid captured");

// 16. WORKING 时 EXT_INPUT → 立即注入（CLI 原生排队），带"已注入终端"日志
const busyId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: "忙时直发A" });
assert((await waitAck(busyId)).ok, "EXT_INPUT while WORKING acked");
await wait(800);
const fl16 = fakeLog().filter((a) => a[1] === "忙时直发A");
assert(fl16.length === 1 && fl16[0][0] === "4321" && !fl16[0].includes("noenter"), "busy injection direct with enter");
assert(events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("已注入终端")), "busy injection logged");
const pendOf = (sid: string) => mgr.snapshot().find((s) => s.session_id === sid)?.pending_inputs ?? [];
assert(pendOf(extId("cli-1")).some((p) => p.text === "忙时直发A"), "busy inject echoed in pending_inputs");

// 17. EXT_STOP（WORKING）→ 注入 Esc
const escId = send("COMMAND_EXT_STOP", { session_id: extId("cli-1") });
assert((await waitAck(escId)).ok, "EXT_STOP acked");
await wait(300);
assert(fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"), "esc injected");

// 17.5 WAITING（远程审批挂起）时 EXT_INPUT → relay 侧排队，不注入
const held17 = hook({ event: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" }, permission_mode: "default" });
await wait(300);
const w17 = events.filter((e) => e.type === "SESSION_WAITING").at(-1) as Envelope<"SESSION_WAITING", WaitingPayload>;
assert(!!w17 && w17.payload.decidable === true, "17.5 WAITING(decidable) emitted");
const qId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: "排队消息A" });
assert((await waitAck(qId)).ok, "EXT_INPUT queued acked");
await wait(300);
assert(!fakeLog().some((a) => a[1] === "排队消息A"), "no injection while WAITING");
assert(events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("已排队")), "queue logged");
assert(pendOf(extId("cli-1")).some((p) => p.text === "排队消息A"), "queued msg echoed in pending_inputs");
const cont17 = send("COMMAND_CONTINUE", { session_id: extId("cli-1"), request_id: w17.payload.request_id });
assert((await waitAck(cont17)).ok, "17.5 CONTINUE acked");
assert((await held17).body.decision === "allow", "17.5 hook got allow");

// 18. Stop → DONE 后自动 flush 队列（末条带回车）
//    steering 消息（忙时直发A，已注入）晋升为正式消息；仍在队列的（排队消息A）保留 pending 等 UPS 晋升
await hook({ event: "Stop" });
await wait(800);
const fl18 = fakeLog().filter((a) => a[1] === "排队消息A");
assert(fl18.length === 1 && fl18[0][0] === "4321" && !fl18[0].includes("noenter"), "queued msg flushed with enter");
const umLogs = (t: string) => events.filter((e) => e.type === "SESSION_LOG" && (e.payload as { kind: string; text: string }).kind === "user_message" && (e.payload as { text: string }).text === t).length;
assert(umLogs("忙时直发A") === 1, "steering msg promoted on Stop");
assert(!pendOf(extId("cli-1")).some((p) => p.text === "忙时直发A"), "promoted msg removed from pending");
assert(pendOf(extId("cli-1")).some((p) => p.text === "排队消息A"), "still-queued msg kept in pending");

// 19. 空闲直达：DONE 状态 EXT_INPUT 立即注入
const dId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: "空闲直发" });
assert((await waitAck(dId)).ok, "EXT_INPUT idle acked");
await wait(800);
assert(fakeLog().some((a) => a[1] === "空闲直发"), "idle injection direct");
assert(pendOf(extId("cli-1")).some((p) => p.text === "空闲直发"), "idle inject echoed in pending_inputs");

// 19.5 晋升去重：CLI 处理空闲注入 → UserPromptSubmit 同文本 → pending 移除 + 仅一条 user_message（上浮不重复）
await hook({ event: "UserPromptSubmit", prompt: "空闲直发" });
await wait(200);
assert(umLogs("空闲直发") === 1, "UPS promotes pending into single user_message");
assert(!pendOf(extId("cli-1")).some((p) => p.text === "空闲直发"), "promoted msg removed from pending");

// 20. 无 cli_pid → 拒绝（等该会话下次活动定位）
await hook({ event: "UserPromptSubmit", prompt: "无 pid 会话", session_id: "cli-2" });
await wait(150);
const noPidId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-2"), text: "x" });
const ack20 = await waitAck(noPidId);
assert(ack20.ok === false && (ack20.error ?? "").includes("CLI 进程"), "EXT_INPUT without pid rejected");
const noStopId = send("COMMAND_EXT_STOP", { session_id: extId("cli-2") });
assert((await waitAck(noStopId)).ok === false, "EXT_STOP without pid rejected");
await hook({ event: "SessionEnd", session_id: "cli-2", reason: "clear" });

// 21. 注入失败（attach fail）→ 清 pid + 弃队列 + 日志
await hook({ event: "UserPromptSubmit", prompt: "要失败的会话", session_id: "cli-3", cli_pid: 424242 });
await wait(150);
const fId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-3"), text: "会失败" });
assert((await waitAck(fId)).ok, "EXT_INPUT acked (immediate inject will fail)");
await hook({ event: "Stop", session_id: "cli-3" });
await wait(800);
assert(fakeLog().some((a) => a[0] === "424242"), "inject attempted on dead pid");
assert(mgr.snapshot().find((s) => s.session_id === extId("cli-3"))?.cli_pid === undefined, "pid cleared on failure");
assert(events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("注入失败")), "failure logged");

// 22. SessionEnd → log
await hook({ event: "SessionEnd", reason: "clear" });
await wait(150);
assert(events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("会话结束")), "SessionEnd logged");

// 23. COMMAND_RENAME：改名 + 锁定（title_locked）
const renId = send("COMMAND_RENAME", { session_id: extId("cli-1"), title: "我的会话" });
const ack23 = await waitAck(renId);
assert(ack23.ok, "RENAME acked");
await wait(150);
const upd23 = events.filter((e) => e.type === "SESSION_UPDATED").at(-1) as Envelope<"SESSION_UPDATED", { title?: string; title_locked?: boolean }> | undefined;
assert(upd23?.payload.title === "我的会话" && upd23?.payload.title_locked === true, "UPDATE carries title + title_locked");
assert(mgr.snapshot().find((s) => s.session_id === extId("cli-1"))?.title === "我的会话", "state renamed");

// 24. 空标题 → 拒绝
const ren2Id = send("COMMAND_RENAME", { session_id: extId("cli-1"), title: "   " });
const ack24 = await waitAck(ren2Id);
assert(ack24.ok === false, "empty rename rejected");

// 25. PC 端敲字排队（transcript queue-operation）→ pending 回显；steering 交付（attachment）→ 晋升正式消息；重复 enqueue 去重
{
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const T = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T, { force: true });
  writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线" }] } }) + "\n");
  const umCount = (t: string) =>
    events.filter((e) => e.type === "SESSION_LOG" && (e.payload as { kind?: string; text?: string }).kind === "user_message" && (e.payload as { text: string }).text === t).length;
  const before25 = umCount("PC敲字排队消息");
  // 首个带 transcript 的事件：建立偏移（首读只取最后一条正文）
  await hook({ event: "UserPromptSubmit", prompt: "排队测试回合", cli_pid: 4321, transcript_path: T });
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  // 用户在 PC 终端敲字 → CLI 写 enqueue 台账 → 下一次增量读补进 pending_inputs
  appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "PC敲字排队消息" }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(pendOf(extId("cli-1")).some((p) => p.text === "PC敲字排队消息"), "PC-typed enqueue reflected in pending_inputs");
  // steering 中途交付（remove + attachment，无 UserPromptSubmit）→ 出 pending + 记正式消息
  appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "remove" }) + "\n");
  appendFileSync(T, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "PC敲字排队消息" } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(!pendOf(extId("cli-1")).some((p) => p.text === "PC敲字排队消息"), "steered msg leaves pending on delivery");
  assert(umCount("PC敲字排队消息") === before25 + 1, "steered msg logged as user_message exactly once");
  // 已晋升的文本再次 enqueue（陈旧台账）→ 不回塞 pending
  appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "PC敲字排队消息" }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(!pendOf(extId("cli-1")).some((p) => p.text === "PC敲字排队消息"), "stale enqueue of promoted text not re-queued");
  assert(umCount("PC敲字排队消息") === before25 + 1, "no duplicate user_message from stale enqueue");
  rmSync(T, { force: true });
}

// 26. #126 排队消息晋升双显回归：CLI 会把多条排队消息合并成一条 enqueue / attachment /
//     UserPromptSubmit（"\r" 连接、消息内换行折叠为空格），relay 必须只按原句各记一次
{
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const T = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T, { force: true });
  writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线26" }] } }) + "\n");
  const umCount = (t: string) =>
    events.filter((e) => e.type === "SESSION_LOG" && (e.payload as { kind?: string; text?: string }).kind === "user_message" && (e.payload as { text: string }).text === t).length;
  const pendTexts = () => pendOf(extId("cli-1")).map((p) => p.text);
  // 手机连发两条（A 带内部换行，B 短句），CLI 忙 → 原生排队
  await hook({ event: "UserPromptSubmit", prompt: "双显回归回合一", cli_pid: 4321, transcript_path: T });
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  const A = "任务清单太多了。\n具体显示逻辑你来定，可以参考近一天或前 N 条的方案";
  const B = "侧边栏手势保留现状即可";
  for (const t of [A, B]) {
    const xId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: t });
    assert((await waitAck(xId)).ok, `26 EXT_INPUT queued: ${t.slice(0, 8)}`);
  }
  await wait(1500); // 等 flushQueue 把两条都注入完（每条 400ms 间隔），Stop 时队列为空才走晋升
  assert(pendTexts().length === 2, "26 two phone msgs in pending");
  // ① CLI 合并形态 enqueue（A 折叠空格 + "\r" + B）→ 不得回塞第三条 pending
  appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: A.replace(/\n/g, " ") + "\r" + B }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(pendTexts().length === 2, "26 merged enqueue does not add a 3rd pending");
  // ② Stop 晋升：A、B 各记一条 user_message，pending 清空
  await hook({ event: "Stop", transcript_path: T });
  await wait(200);
  assert(umCount(A) === 1, "26 A logged exactly once on Stop");
  assert(umCount(B) === 1, "26 B logged exactly once on Stop");
  assert(pendTexts().length === 0, "26 pending cleared once");
  // ③ CLI 回合结束把整队合并成一条真 prompt 再提交 → 不得重复记录
  await hook({ event: "UserPromptSubmit", prompt: A.replace(/\n/g, " ") + "\r" + B, transcript_path: T });
  await wait(200);
  assert(umCount(A) === 1 && umCount(B) === 1, "26 joined re-submit logs nothing new");
  // ④ steering 中途交付合并形态（attachment "C\rD"）→ 按原句各记一条，pending 清空；随后 Stop 不再补记
  const C = "我发了两条消息都在排队，上去之后显示了两次";
  const D = "近三天的范围是不是太大了";
  await hook({ event: "UserPromptSubmit", prompt: "双显回归回合二", cli_pid: 4321, transcript_path: T });
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  for (const t of [C, D]) {
    const xId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: t });
    assert((await waitAck(xId)).ok, `26 EXT_INPUT queued: ${t.slice(0, 8)}`);
  }
  await wait(1200);
  appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "remove" }) + "\n");
  appendFileSync(T, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: C + "\r" + D } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  await wait(200);
  assert(umCount(C) === 1 && umCount(D) === 1, "26 merged steer logs each original msg once");
  assert(pendTexts().length === 0, "26 pending cleared by merged steer");
  await hook({ event: "Stop", transcript_path: T });
  await wait(200);
  assert(umCount(C) === 1 && umCount(D) === 1, "26 Stop after merged steer logs nothing new");
  // ⑤ 合并形态直接作为 UserPromptSubmit 先到（pending 未清）→ 整批晋升、各记一条
  const E = "第五条排队消息";
  const F = "第六条排队消息";
  await hook({ event: "UserPromptSubmit", prompt: "双显回归回合三", cli_pid: 4321, transcript_path: T });
  for (const t of [E, F]) {
    const xId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: t });
    await waitAck(xId);
  }
  await wait(1500);
  await hook({ event: "UserPromptSubmit", prompt: E + "\r" + F, transcript_path: T });
  await wait(200);
  assert(umCount(E) === 1 && umCount(F) === 1, "26 joined UserPromptSubmit promotes each pending once");
  assert(pendTexts().length === 0, "26 pending cleared once by joined promote");
  // ⑥ 去重不吞真实重发：PC 手敲同句两次 → 各记一条；手机快速重发同句两次 → Stop 各记一条
  await hook({ event: "UserPromptSubmit", prompt: "手敲重发不吞测试", transcript_path: T });
  await hook({ event: "UserPromptSubmit", prompt: "手敲重发不吞测试", transcript_path: T });
  await wait(200);
  assert(umCount("手敲重发不吞测试") === 2, "26 PC retyped same prompt within 60s logs twice");
  await hook({ event: "UserPromptSubmit", prompt: "双显回归回合四", cli_pid: 4321, transcript_path: T });
  for (let k = 0; k < 2; k++) {
    const xId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: "手机重发同句" });
    await waitAck(xId);
  }
  await wait(1500);
  await hook({ event: "Stop", transcript_path: T });
  await wait(200);
  assert(umCount("手机重发同句") === 2, "26 phone quick-resend logs twice (promote not deduped)");
  await hook({ event: "SessionEnd", reason: "clear" });
  rmSync(T, { force: true });
}

wsCur!.close();
await wait(300);
console.log("\nBRIDGE TESTS PASSED");
process.exit(0);
