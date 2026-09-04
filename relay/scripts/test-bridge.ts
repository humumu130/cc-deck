// hooks 桥接全链路测试：模拟 bridge-hook.mjs 的 POST 序列 + WS 客户端命令
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import { createPairingCodes } from "../src/pairing.js";
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
// 看门狗/子 Agent TTL 测试短值（Bridge 构造时读取；生产默认 90s/60s/10min/30min）
process.env.CCR_STUCK_AFTER_MS = "2000";
process.env.CCR_STUCK_RETRY_MS = "1500";
process.env.CCR_SUBAGENT_END_TTL_MS = "2000";
process.env.CCR_SUBAGENT_RUN_TTL_MS = "3000";
process.env.CCR_INJECT_CMD = fileURLToPath(new URL("./fake-injector.mjs", import.meta.url));
const INJECT_LOG = fileURLToPath(new URL("../data/test-inject.log", import.meta.url));
process.env.CCR_INJECT_LOG = INJECT_LOG;
rmSync(INJECT_LOG, { force: true });
// 孤儿扫描（34 段）用临时 projects 根，防止测试扫到真实 ~/.claude/projects
const PROOT = fileURLToPath(new URL("../data/test-projects/", import.meta.url));
process.env.CCR_PROJECTS_ROOT = PROOT;
rmSync(PROOT, { recursive: true, force: true });
// 34 段断言删除墓碑：先清上一轮残留，保证测试幂等
rmSync(fileURLToPath(new URL("../data/deleted-ext.json", import.meta.url)), { force: true });
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
let cloudOnline = false; // 33 段置 true：云通道手机计入"在线"门控
const { bridge } = startServer(bus, mgr, cfg, { holdMs: 1200, questionHoldMs: 800, gateToolsRaw: "Bash,Edit", cloudHasPhones: () => cloudOnline });
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

// 27. COMMAND_TODO_HIDE：隐藏条目在 setTodos 咽喉点过滤 + 持久化（模拟重启）仍生效
{
  const { readFileSync: rf, writeFileSync: wf, existsSync: ef, rmSync: rmf } = await import("node:fs");
  const hiddenFile = fileURLToPath(new URL("../data/todo-hidden.json", import.meta.url));
  const orig = ef(hiddenFile) ? rf(hiddenFile, "utf-8") : null;
  const sid = extId("cli-1");
  const todosOf = () => mgr.snapshot().find((s) => s.session_id === sid)?.todos ?? [];
  mgr.setTodos(sid, [{ content: "任务甲", status: "pending" }, { content: "任务乙", status: "in_progress" }]);
  assert(todosOf().length === 2, "27 two todos before hide");
  const hide1 = send("COMMAND_TODO_HIDE", { session_id: sid, content: "任务甲" });
  assert((await waitAck(hide1)).ok, "27 TODO_HIDE acked");
  await wait(150);
  assert(todosOf().length === 1 && todosOf()[0].content === "任务乙", "27 hidden item filtered out");
  assert(events.some((e) => e.type === "SESSION_UPDATED" && Array.isArray((e.payload as { todos?: unknown[] }).todos)), "27 SESSION_UPDATED carries filtered todos");
  // 找不到匹配条目也回 ok；重复隐藏幂等
  const hide2 = send("COMMAND_TODO_HIDE", { session_id: sid, content: "不存在的任务" });
  assert((await waitAck(hide2)).ok, "27 hide non-matching item still ok");
  const hide3 = send("COMMAND_TODO_HIDE", { session_id: sid, content: "  任务甲  " });
  assert((await waitAck(hide3)).ok, "27 duplicate hide (whitespace-normalized) ok");
  assert(todosOf().length === 1, "27 duplicate hide keeps single filtered list");
  // CLI 重发全量清单（hook/transcript 路径）：隐藏依然生效
  mgr.setTodos(sid, [{ content: "任务甲", status: "completed" }, { content: "任务乙", status: "completed" }]);
  assert(todosOf().length === 1, "27 re-pushed todo list still filtered");
  // 持久化：磁盘有键；清内存缓存（模拟 relay 重启）后仍隐藏
  assert(ef(hiddenFile) && rf(hiddenFile, "utf-8").includes("任务甲"), "27 hidden key persisted to disk");
  const { resetHiddenTodoStore } = await import("../src/todo-hidden.js");
  resetHiddenTodoStore();
  mgr.setTodos(sid, [{ content: "任务甲", status: "pending" }, { content: "任务乙", status: "pending" }]);
  assert(todosOf().length === 1, "27 hidden after store reload (simulated relay restart)");
  // 清理：还原隐藏集文件，避免污染生产数据
  if (orig === null) rmf(hiddenFile, { force: true });
  else wf(hiddenFile, orig, "utf-8");
  resetHiddenTodoStore();
}

// 28. 子 Agent 工作状态：Pre/Post 配对、bg 由 <task-notification> 收尾、合成 id 升级、TTL 清理
{
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const T = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T, { force: true });
  writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线28" }] } }) + "\n");
  const sid = extId("cli-1");
  const subs = () => mgr.snapshot().find((s) => s.session_id === sid)?.subagents ?? [];
  await hook({ event: "UserPromptSubmit", prompt: "子代理测试回合", cli_pid: 4321, transcript_path: T });
  // ① 前台：Pre 建 running 条目，Post 按 tool_use_id 收尾
  await hook({ event: "PreToolUse", tool_name: "Agent", tool_use_id: "call_fg1", tool_input: { description: "前台子代理", subagent_type: "general", run_in_background: false }, permission_mode: "default" });
  const fg = subs()[0];
  assert(subs().length === 1 && fg.id === "call_fg1" && fg.desc === "前台子代理" && fg.kind === "general" && fg.bg === false && fg.ended_at === undefined, "28 Pre creates running subagent entry");
  await hook({ event: "PostToolUse", tool_name: "Agent", tool_use_id: "call_fg1", tool_response: "ok" });
  assert(subs()[0].ended_at !== undefined, "28 Post ends foreground subagent");
  // ② 后台：PostToolUse（派生瞬间返回）不收尾，transcript 的 task-notification（user 行）收尾
  await hook({ event: "PreToolUse", tool_name: "Agent", tool_use_id: "call_bg1", tool_input: { description: "后台子代理", run_in_background: true }, permission_mode: "default" });
  assert(subs().length === 2 && subs()[1].bg === true && subs()[1].ended_at === undefined, "28 bg subagent entry created");
  await hook({ event: "PostToolUse", tool_name: "Agent", tool_use_id: "call_bg1", tool_response: "spawned" });
  assert(subs()[1].ended_at === undefined, "28 bg subagent ignores PostToolUse");
  appendFileSync(T, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>call_bg1</tool-use-id>\n<status>completed</status>\n<summary>done</summary>" }] } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(subs().find((x) => x.id === "call_bg1")?.ended_at !== undefined, "28 task-notification (user line) ends bg subagent");
  // ③ hook 未带 tool_use_id → 合成 ag-N；transcript tool_use 块升级为真实 call id，通知配对收尾
  await hook({ event: "PreToolUse", tool_name: "Agent", tool_input: { description: "升级测试", run_in_background: true }, permission_mode: "default" });
  assert(subs().some((x) => x.bg && !x.ended_at && x.id.startsWith("ag-")), "28 synthetic id entry when hook lacks tool_use_id");
  appendFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "call_up1", name: "Agent", input: { description: "升级测试", run_in_background: true } }] } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(subs().some((x) => x.id === "call_up1" && !x.ended_at) && !subs().some((x) => x.id.startsWith("ag-")), "28 synthetic id upgraded to real call id");
  appendFileSync(T, JSON.stringify({ type: "attachment", attachment: { type: "task_notification", text: "<task-notification>\n<tool-use-id>call_up1</tool-use-id>\n<status>completed</status>" } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(subs().find((x) => x.id === "call_up1")?.ended_at !== undefined, "28 notification (attachment line) ends upgraded bg subagent");
  assert(events.some((e) => e.type === "SESSION_UPDATED" && Array.isArray((e.payload as { subagents?: unknown[] }).subagents)), "28 SESSION_UPDATED carries subagents");
  // ④ TTL：测试短值（end 2s / run 3s）+ 5s 轮询节拍 → 全部清空
  assert(subs().length > 0, "28 entries present before TTL sweep");
  await wait(7000);
  assert(subs().length === 0, "28 TTL sweep clears ended and zombie entries");
  rmSync(T, { force: true });
}

// 29. 排队消息滞留输入框看门狗：滞留补发回车、WAITING 严禁、送达后不再触发、连续 3 次后放弃
{
  const { writeFileSync } = await import("node:fs");
  const T = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T, { force: true });
  writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线29" }] } }) + "\n");
  const sid = extId("cli-7");
  const enters = () => fakeLog().filter((a) => a[0] === "7777" && a[1] === "").length;
  await hook({ event: "UserPromptSubmit", prompt: "看门狗回合", session_id: "cli-7", cli_pid: 7777, transcript_path: T });
  // WORKING + pending 滞留（注入成功但回车被吞、未晋升）→ 5s 节拍内补发回车
  const wId = send("COMMAND_EXT_INPUT", { session_id: sid, text: "滞留的消息" });
  assert((await waitAck(wId)).ok, "29 EXT_INPUT acked (WORKING direct inject)");
  await wait(8000);
  assert(enters() >= 1, "29 stuck pending triggers enter re-send");
  assert(events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("已补发回车")), "29 watchdog log emitted");
  const afterTrigger = enters();
  // WAITING（权限弹窗/审批挂起）→ 严禁补发（回车会误触弹窗）
  mgr.setExternalStatus(sid, "WAITING", "权限确认");
  mgr.setExternalPending(sid, [{ text: "滞留的消息", ts: Date.now() - 9000 }]);
  await wait(6500);
  assert(enters() === afterTrigger, "29 no enter re-send while WAITING");
  // 送达（pending 清空）→ 看门狗重置，不再触发
  mgr.setExternalStatus(sid, "DONE", "完成");
  mgr.setExternalPending(sid, []);
  await wait(6500);
  assert(enters() === afterTrigger, "29 no enter re-send after delivered");
  // 再滞留：连续 3 次补发后放弃（防无限打转），之后不再尝试
  mgr.setExternalStatus(sid, "WORKING", "再跑");
  mgr.setExternalPending(sid, [{ text: "滞留的消息", ts: Date.now() - 9000 }]);
  await wait(17000);
  const afterRetry = enters();
  assert(afterRetry - afterTrigger === 3, `29 exactly three retries then give up (got ${afterRetry - afterTrigger})`);
  assert(events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("暂停自动补发")), "29 give-up log emitted");
  await wait(6500);
  assert(enters() === afterRetry, "29 no further attempts after give-up");
  await hook({ event: "SessionEnd", session_id: "cli-7", reason: "clear" });
  rmSync(T, { force: true });
}

// 30. AskUserQuestion 双端任一作答：窗口内 updatedInput 注入；超时兜底横幅保留 + 晚答 Esc+注入；PC 先答清横幅
{
  const qInput = { questions: [{ header: "方案", question: "用哪个库?", options: [{ label: "A" }, { label: "B" }] }] };
  const st = () => mgr.snapshot().find((s) => s.session_id === extId("cli-1"));
  await hook({ event: "UserPromptSubmit", prompt: "提问测试回合", cli_pid: 4321 });

  // 30a. 窗口内手机作答 → allow + updatedInput（CLI 不再弹本地选择器）
  const pA = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  await wait(150);
  const wA = st()?.waiting_request;
  assert(!!wA?.questions?.length, "30 waiting carries questions");
  const aId = send("COMMAND_ANSWER", { session_id: extId("cli-1"), request_id: wA!.request_id, answers: ["A"] });
  assert((await waitAck(aId)).ok, "30 in-window answer acked");
  const rA = await pA;
  const upd = (rA.body as { updatedInput?: { answers?: Record<string, string>; questions?: unknown[] } }).updatedInput;
  assert(rA.body.decision === "allow" && upd?.answers?.["用哪个库?"] === "A" && Array.isArray(upd?.questions), "30 allow + updatedInput carries answer");
  assert(st()?.waiting_request === undefined || st()?.waiting_request === null, "30 waiting cleared after answer");

  // 30b. 超时 → 放行本地选择器，但横幅保留（兜底仍可作答），不发 timeout resolved
  const pB = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  await wait(1200);
  assert((await pB).body.decision === "pass", "30 timeout falls back to local picker (pass)");
  const sB = st();
  assert(sB?.status === "WAITING" && !!sB?.waiting_request, "30 banner kept after timeout");
  const rbId = sB!.waiting_request!.request_id;
  assert(!events.some((e) => e.type === "SESSION_WAITING_RESOLVED" && (e.payload as { request_id: string }).request_id === rbId), "30 no timeout resolved for question");

  // 30c. 晚答（兜底）→ Esc 关本地选择器 + 答案文本注入
  const bId = send("COMMAND_ANSWER", { session_id: extId("cli-1"), request_id: rbId, answers: ["B"] });
  assert((await waitAck(bId)).ok, "30 late answer acked via fallback");
  await wait(1500);
  assert(fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"), "30 esc closes local picker");
  assert(fakeLog().some((a) => a[0] === "4321" && String(a[1]).includes("「B」")), "30 answer text injected");

  // 30d. PC 端先答 → 横幅收起（answered by cli）
  const pC = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  await wait(1200);
  await pC;
  await hook({ event: "PostToolUse", tool_name: "AskUserQuestion", tool_response: { answers: [{ question: "用哪个库?", answer: "A" }] } });
  await wait(200);
  assert(events.some((e) => e.type === "SESSION_WAITING_RESOLVED" && (e.payload as { decision: string }).decision === "answered" && (e.payload as { by: string }).by === "cli"), "30 pc-answered clears banner");
  const sC = st();
  assert(sC?.status === "WORKING" && !sC?.waiting_request, "30 state back to WORKING, waiting cleared");
}

// 31. 手机离线时的提问：立即放行 PC 本地选择器，但仍登记横幅——重连后晚答走兜底注入
{
  const qInput = { questions: [{ header: "方案", question: "离线时的问题?", options: [{ label: "X" }, { label: "Y" }] }] };
  const st = () => mgr.snapshot().find((s) => s.session_id === extId("cli-1"));
  wsCur!.close();
  await wait(500);
  const p = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  const t0 = Date.now();
  assert((await p).body.decision === "pass", "31 offline question passes immediately");
  assert(Date.now() - t0 < 500, "31 no hold when phone offline");
  const s = st();
  assert(s?.status === "WAITING" && !!s?.waiting_request?.questions?.length, "31 banner registered for late phone");
  const second = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
  attach(second);
  await new Promise((r) => second.once("open", r));
  await wait(200);
  const aId = send("COMMAND_ANSWER", { session_id: extId("cli-1"), request_id: s!.waiting_request!.request_id, answers: ["X"] });
  assert((await waitAck(aId)).ok, "31 late answer after reconnect acked");
  await wait(1500);
  assert(fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"), "31 esc injected for late answer");
  assert(fakeLog().some((a) => a[0] === "4321" && String(a[1]).includes("「X」")), "31 answer text injected");
}

// 32. relay 重启丢内存兜底后的晚答恢复：waiting 状态（events 重放）里找回问题定义；
//     PC 本地作答后横幅也收起（fb 已丢不悬死）；云通道手机计入"手机在线"门控
{
  const qInput = { questions: [{ header: "方案", question: "重启后的问题?", options: [{ label: "M" }, { label: "N" }] }] };
  const st = () => mgr.snapshot().find((s) => s.session_id === extId("cli-1"));
  await hook({ event: "UserPromptSubmit", prompt: "重启恢复回合", cli_pid: 4321 });

  // 32a. 提问超时进入兜底 → 模拟重启清空兜底表 → 手机晚答仍可从状态恢复注入
  const pA = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  await wait(1200);
  assert((await pA).body.decision === "pass", "32 question timed out to local picker");
  const sA = st();
  const ridA = sA!.waiting_request!.request_id;
  assert(sA?.status === "WAITING" && !!ridA, "32 banner kept after timeout");
  (bridge as unknown as { askFallback: Map<string, unknown> }).askFallback.clear(); // 模拟 relay 重启
  const aId = send("COMMAND_ANSWER", { session_id: extId("cli-1"), request_id: ridA, answers: ["M"] });
  assert((await waitAck(aId)).ok, "32 late answer recovered after restart-wipe");
  await wait(1500);
  assert(fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"), "32 esc injected via state recovery");
  assert(fakeLog().some((a) => a[0] === "4321" && String(a[1]).includes("「M」")), "32 answer text injected via state recovery");
  assert(events.some((e) => e.type === "SESSION_WAITING_RESOLVED" && (e.payload as { request_id: string }).request_id === ridA), "32 resolved event emitted");

  // 32b. 重启丢兜底后 PC 在本地选择器作答 → 横幅仍收起（按状态里的 request_id 结）
  const pB = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  await wait(1200);
  await pB;
  const ridB = st()!.waiting_request!.request_id;
  (bridge as unknown as { askFallback: Map<string, unknown> }).askFallback.clear();
  await hook({ event: "PostToolUse", tool_name: "AskUserQuestion", tool_response: {} });
  await wait(200);
  const sB = st();
  assert(!sB?.waiting_request && sB?.status !== "WAITING", "32 pc-answered clears banner even without fb");
  assert(events.some((e) => e.type === "SESSION_WAITING_RESOLVED" && (e.payload as { request_id: string }).request_id === ridB && (e.payload as { decision: string }).decision === "answered"), "32 answered-by-cli resolved event");
}

// 33. 云通道手机计入"手机在线"：无 LAN 客户端 + 云手机活跃 → 提问照常挂起（不放行本地）
{
  const qInput = { questions: [{ header: "方案", question: "云手机在线时的问题?", options: [{ label: "P" }, { label: "Q" }] }] };
  const st = () => mgr.snapshot().find((s) => s.session_id === extId("cli-1"));
  await hook({ event: "UserPromptSubmit", prompt: "云门控回合", cli_pid: 4321 });
  cloudOnline = true;
  wsCur!.close();
  await wait(500);
  let settled = false;
  const p = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  p.then(() => { settled = true; });
  await wait(300);
  assert(!settled, "33 cloud-only phone gates question (held, not passed)");
  const rid = st()!.waiting_request!.request_id;
  const cws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
  attach(cws);
  await new Promise((r) => cws.once("open", r));
  await wait(50);
  const aId = send("COMMAND_ANSWER", { session_id: extId("cli-1"), request_id: rid, answers: ["P"] });
  assert((await waitAck(aId)).ok, "33 in-window answer acked while cloud gating");
  const r = await p;
  const upd = (r.body as { updatedInput?: { answers?: Record<string, string> } }).updatedInput;
  assert(r.body.decision === "allow" && upd?.answers?.["云手机在线时的问题?"] === "P", "33 cloud gate in-window answer injects updatedInput");
  // 双端都不在线后恢复旧行为：立即放行本地选择器
  cloudOnline = false;
  cws.close();
  await wait(300);
  const p2 = hook({ event: "PreToolUse", tool_name: "AskUserQuestion", tool_input: qInput });
  const t0 = Date.now();
  assert((await p2).body.decision === "pass", "33 offline cloud passes immediately");
  assert(Date.now() - t0 < 500, "33 no hold when cloud phone gone");
  // 收尾：清掉这次提问的横幅
  await hook({ event: "PostToolUse", tool_name: "AskUserQuestion", tool_response: {} });
  await wait(200);
}

// 34. 孤儿扫描：无 hook 的活跃 transcript 收养为只读会话；陈旧/无 cwd 跳过；删除墓碑防复活
{
  const w34 = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
  attach(w34);
  await new Promise((r) => w34.once("open", r));
  await wait(100);
  const scan = () => (bridge as unknown as { adoptOrphans(): void }).adoptOrphans();
  mkdirSync(join(PROOT, "proj-a"), { recursive: true });
  const sid = "aa11bb22-cc33-dd44-ee55-ff6677889900";
  const orphanId = "ext-" + sid;
  writeFileSync(
    join(PROOT, "proj-a", sid + ".jsonl"),
    JSON.stringify({ type: "user", cwd: "D:\\orphan-test", message: { role: "user", content: "hi" } }) + "\n",
  );
  // 扫描跳过 15s 内的新鲜文件（title-gen 登记竞态防线），测试文件回拨到 60s 前
  const ago = (f: string, ms: number) => utimesSync(f, new Date(Date.now() - ms), new Date(Date.now() - ms));
  ago(join(PROOT, "proj-a", sid + ".jsonl"), 60_000);
  const stale = join(PROOT, "proj-a", "bb11bb22-cc33-dd44-ee55-ff6677889900.jsonl");
  writeFileSync(stale, JSON.stringify({ type: "user", cwd: "D:\\stale" }) + "\n");
  utimesSync(stale, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  writeFileSync(
    join(PROOT, "proj-a", "cc11bb22-cc33-dd44-ee55-ff6677889900.jsonl"),
    JSON.stringify({ type: "x", sessionId: "cc11bb22-cc33-dd44-ee55-ff6677889900" }) + "\n",
  );
  ago(join(PROOT, "proj-a", "cc11bb22-cc33-dd44-ee55-ff6677889900.jsonl"), 60_000);
  scan();
  await wait(300);
  assert(events.some((e) => e.type === "SESSION_CREATED" && e.session_id === orphanId), "34 fresh orphan adopted");
  const st = mgr.getExternal(orphanId);
  assert(st?.status === "DONE" && st?.action_summary === "扫描接入（只读）", "34 orphan read-only DONE");
  assert(!mgr.getExternal("ext-bb11bb22-cc33-dd44-ee55-ff6677889900"), "34 stale transcript skipped");
  assert(!mgr.getExternal("ext-cc11bb22-cc33-dd44-ee55-ff6677889900"), "34 no-cwd transcript skipped");
  // 已注册会话（模拟重启后恢复）重扫：不报错不重复创建，且 transcript 轮询必须（重）挂上
  // ——外部会话的 relay_session_id 也命中 ownsCliSession，分支顺序错了会跳过补挂，
  // 重启后手机只剩系统日志看不到正文（真实踩坑）
  (bridge as unknown as { transcriptPaths: Map<string, string> }).transcriptPaths.delete(orphanId);
  scan();
  await wait(100);
  assert(
    !!mgr.getExternal(orphanId) && events.filter((e) => e.type === "SESSION_CREATED" && e.session_id === orphanId).length === 1,
    "34 rescan keeps existing orphan without duplicates",
  );
  assert(
    (bridge as unknown as { transcriptPaths: Map<string, string> }).transcriptPaths.has(orphanId),
    "34 rescan reattaches transcript polling for existing external",
  );
  // 手机删除 → 墓碑 → 重扫不复活
  const del = send("COMMAND_DELETE", { session_id: orphanId });
  assert((await waitAck(del)).ok, "34 orphan delete acked");
  assert(events.some((e) => e.type === "SESSION_DELETED" && e.session_id === orphanId), "34 SESSION_DELETED emitted");
  scan();
  await wait(200);
  assert(!mgr.getExternal(orphanId), "34 tombstone prevents resurrection");
  w34.close();
  rmSync(PROOT, { recursive: true, force: true });
}

// 35. 配对码领码端点：错 token 403；pairCodes 未下发（云桥未启用）501；配对码单元回合
{
  const r403 = await fetch(`${http}/api/pair-issue`, { method: "POST", headers: { "x-bridge-token": "WRONG" } });
  assert(r403.status === 403, "35 pair-issue wrong token rejected");
  const r501 = await fetch(`${http}/api/pair-issue`, { method: "POST", headers: { "x-bridge-token": cfg.bridgeToken } });
  assert(r501.status === 501, "35 pair-issue 501 without cloud pairing");
  const pcs = createPairingCodes(1);
  const { code, expires_in } = pcs.issue();
  assert(/^\d{6}$/.test(code) && expires_in === 0, "35 issue returns 6-digit code");
  assert(!pcs.consume("000000"), "35 unknown code rejected");
  await wait(20);
  assert(!pcs.consume(code), "35 expired code rejected");
  const pcs2 = createPairingCodes();
  const c2 = pcs2.issue().code;
  assert(pcs2.consume(c2) && !pcs2.consume(c2), "35 code one-time consume");
}

// 36. 无 hook 会话：转录增量增长翻 WORKING（状态/呼吸灯随转录走），静默后回合视作结束
{
  mkdirSync(join(PROOT, "proj-a"), { recursive: true });
  const sid = "dd11bb22-cc33-dd44-ee55-ff6677889900";
  const id36 = "ext-" + sid;
  const f36 = join(PROOT, "proj-a", sid + ".jsonl");
  writeFileSync(f36,
    JSON.stringify({ type: "user", cwd: "D:\\nohook-test", message: { role: "user", content: "hi" } }) + "\n" +
    JSON.stringify({ type: "user", cwd: "D:\\nohook-test", message: { role: "user", content: "turn 2" } }) + "\n");
  utimesSync(f36, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  (bridge as unknown as { adoptOrphans(): void }).adoptOrphans();
  await wait(300);
  assert(mgr.getExternal(id36)?.status === "DONE", "36 adopted as DONE");
  // 等一轮轮询（5s）完成首读建 offset 基线，之后的追加才算增量增长
  await wait(5500);
  // CLI 正在写转录（增量）→ 下一轮轮询（5s）翻 WORKING
  appendFileSync(f36, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "streaming" }] } }) + "\n");
  await wait(6500);
  const st36 = mgr.getExternal(id36);
  assert(st36?.status === "WORKING" && st36?.action_summary === "转录活跃（无 hook 会话）", "36 transcript growth flips WORKING");
  // 转录静默（idle 阈值压到 1s）→ 回合视作结束回落 DONE；再增长能重新翻回 WORKING
  try {
    process.env.CCR_NOHOOK_IDLE_MS = "1000";
    await wait(6500);
    assert(mgr.getExternal(id36)?.status === "DONE", "36 idle falls back to DONE");
    appendFileSync(f36, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "new turn" }] } }) + "\n");
    await wait(6500);
    assert(mgr.getExternal(id36)?.status === "WORKING", "36 regrowth flips WORKING again");
  } finally {
    delete process.env.CCR_NOHOOK_IDLE_MS;
  }
  rmSync(PROOT, { recursive: true, force: true });
}

wsCur!.close();
await wait(300);
console.log("\nBRIDGE TESTS PASSED");
process.exit(0);
