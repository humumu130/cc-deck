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
import { devId, generateKeyPair } from "../src/e2e.js";
import type { BridgeEvent, Command, CommandAckPayload, Envelope, LogEntry, SessionState, WaitingPayload } from "../src/types.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// 等注入落盘用轮询而非固定 wait：高负载下 fake-injector 子进程 spawn 可达秒级，
// 固定窗口（800/1500ms）反复偶发假阴性（18/21/30/31/32 段连续 flake 实录）
const waitLog = async (pred: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await wait(100);
};

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
await waitLog(() => fakeLog().some((a) => a[1] === "忙时直发A"));
const fl16 = fakeLog().filter((a) => a[1] === "忙时直发A");
assert(fl16.length === 1 && fl16[0][0] === "4321" && !fl16[0].includes("noenter"), "busy injection direct with enter");
assert(events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("已注入终端")), "busy injection logged");
const pendOf = (sid: string) => mgr.snapshot().find((s) => s.session_id === sid)?.pending_inputs ?? [];
assert(pendOf(extId("cli-1")).some((p) => p.text === "忙时直发A"), "busy inject echoed in pending_inputs");

// 17. EXT_STOP（WORKING）→ 注入 Esc
const escId = send("COMMAND_EXT_STOP", { session_id: extId("cli-1") });
assert((await waitAck(escId)).ok, "EXT_STOP acked");
await waitLog(() => fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"));
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
await waitLog(() => fakeLog().some((a) => a[1] === "排队消息A"));
const fl18 = fakeLog().filter((a) => a[1] === "排队消息A");
assert(fl18.length === 1 && fl18[0][0] === "4321" && !fl18[0].includes("noenter"), "queued msg flushed with enter");
const umLogs = (t: string) => events.filter((e) => e.type === "SESSION_LOG" && (e.payload as { kind: string; text: string }).kind === "user_message" && (e.payload as { text: string }).text === t).length;
assert(umLogs("忙时直发A") === 1, "steering msg promoted on Stop");
assert(!pendOf(extId("cli-1")).some((p) => p.text === "忙时直发A"), "promoted msg removed from pending");
assert(pendOf(extId("cli-1")).some((p) => p.text === "排队消息A"), "still-queued msg kept in pending");

// 19. 空闲直达：DONE 状态 EXT_INPUT 立即注入
const dId = send("COMMAND_EXT_INPUT", { session_id: extId("cli-1"), text: "空闲直发" });
assert((await waitAck(dId)).ok, "EXT_INPUT idle acked");
await waitLog(() => fakeLog().some((a) => a[1] === "空闲直发"));
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
await waitLog(() => fakeLog().some((a) => a[0] === "424242"));
assert(fakeLog().some((a) => a[0] === "424242"), "inject attempted on dead pid");
// 注入尝试落盘后失败清理链（clearPid + 失败日志）异步一拍——高负载下同拍断言偶发假阴性
await waitLog(() => mgr.snapshot().find((s) => s.session_id === extId("cli-3"))?.cli_pid === undefined);
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
  // ① CLI 合并形态 enqueue（A 折叠空格 + "\r" + B）→ 不得回塞第三条 pending；
  // #43 起 enqueue=CLI 已收到的回执，直接晋升出队（不再等 UPS）——两条 pending 全清
  appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: A.replace(/\n/g, " ") + "\r" + B }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(pendTexts().length === 0, "26 merged enqueue promotes (no 3rd pending, queue cleared)");
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
  // 30b.5 #47：超时放行后 CLI 对本地选择器发 permission 通知——不得把 questions
  // 横幅覆盖成 passive（真实事故：手机/桌面从可作答塌缩成「请在电脑上处理」，
  // 晚答兜底断链）。横幅原样保留（request_id 与 questions 都不变）
  await hook({ event: "Notification", message: "Claude needs your permission to use AskUserQuestion" });
  await wait(150);
  const sB5 = st();
  assert(
    sB5?.status === "WAITING" && sB5?.waiting_request?.request_id === rbId && !!sB5?.waiting_request?.questions?.length && sB5?.waiting_request?.decidable === true,
    "30 permission notification does not override question banner (#47)",
  );

  // 30c. 晚答（兜底）→ Esc 关本地选择器 + 答案文本注入
  const bId = send("COMMAND_ANSWER", { session_id: extId("cli-1"), request_id: rbId, answers: ["B"] });
  assert((await waitAck(bId)).ok, "30 late answer acked via fallback");
  await waitLog(() => fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"));
  assert(fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"), "30 esc closes local picker");
  await waitLog(() => fakeLog().some((a) => a[0] === "4321" && String(a[1]).includes("「B」")));
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
  await waitLog(() => fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"));
  assert(fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"), "31 esc injected for late answer");
  await waitLog(() => fakeLog().some((a) => a[0] === "4321" && String(a[1]).includes("「X」")));
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
  await waitLog(() => fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"));
  assert(fakeLog().some((a) => a[0] === "4321" && a[1] === "--esc"), "32 esc injected via state recovery");
  await waitLog(() => fakeLog().some((a) => a[0] === "4321" && String(a[1]).includes("「M」")));
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
    JSON.stringify({ type: "user", cwd: "D:\\orphan-test", message: { role: "user", content: "hi" } }) + "\n" +
      JSON.stringify({ type: "user", cwd: "D:\\orphan-test", message: { role: "user", content: "second turn" } }) + "\n",
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
  // 单回合探针转录（一次性 print 模式 CLI）：有 cwd 也不收养（测试探针垃圾过滤）
  writeFileSync(
    join(PROOT, "proj-a", "ee11bb22-cc33-dd44-ee55-ff6677889900.jsonl"),
    JSON.stringify({ type: "user", cwd: "D:\\probe", message: { role: "user", content: "请直接回复两个字：收到" } }) + "\n",
  );
  ago(join(PROOT, "proj-a", "ee11bb22-cc33-dd44-ee55-ff6677889900.jsonl"), 60_000);
  scan();
  await wait(300);
  assert(events.some((e) => e.type === "SESSION_CREATED" && e.session_id === orphanId), "34 fresh orphan adopted");
  const st = mgr.getExternal(orphanId);
  assert(st?.status === "DONE" && st?.action_summary === "扫描接入（只读）", "34 orphan read-only DONE");
  assert(!mgr.getExternal("ext-bb11bb22-cc33-dd44-ee55-ff6677889900"), "34 stale transcript skipped");
  assert(!mgr.getExternal("ext-cc11bb22-cc33-dd44-ee55-ff6677889900"), "34 no-cwd transcript skipped");
  assert(!mgr.getExternal("ext-ee11bb22-cc33-dd44-ee55-ff6677889900"), "34 single-turn probe transcript skipped");
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
  assert(/^\d{8}$/.test(code) && expires_in === 0, "35 issue returns 8-digit code（2026-09-09 P0-B）");
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
  // CLI 正在写转录（增量）→ 下一轮轮询（5s）翻 WORKING（等两个轮询窗：单窗只有
  // 一拍余量，轮询相位漂移时偶发假阴性——2026-09-07 连续两天在 36 段 flaky）
  appendFileSync(f36, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "streaming" }] } }) + "\n");
  await wait(11500);
  const st36 = mgr.getExternal(id36);
  assert(st36?.status === "WORKING" && st36?.action_summary === "转录活跃（无 hook 会话）", "36 transcript growth flips WORKING");
  // 转录静默（idle 阈值压到 1s）→ 回合视作结束回落 DONE；再增长能重新翻回 WORKING
  try {
    process.env.CCR_NOHOOK_IDLE_MS = "1000";
    await wait(6500);
    assert(mgr.getExternal(id36)?.status === "DONE", "36 idle falls back to DONE");
    appendFileSync(f36, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "new turn" }] } }) + "\n");
    // regrowth 的 WORKING 窗口很短：idle=1s + 末条 end 形态 → 下一拍 sweep（≤5s）即回落
    // DONE，单点断言碰相位（2026-09-07 连续 flaky 根因）——轮询采样：窗口内出现过即过
    let sawWorking = false;
    for (let i = 0; i < 22; i++) {
      if (mgr.getExternal(id36)?.status === "WORKING") { sawWorking = true; break; }
      await wait(500);
    }
    assert(sawWorking, "36 regrowth flips WORKING again");
    // 末条为 tool_use（工具执行中）：静默超过 idle 阈值也不回落——真实转录整条落盘，
    // 工具/长思考静默分钟级，短窗必误判（曾致 WORKING→DONE 来回跳 + 刷系统日志）
    appendFileSync(f36, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] } }) + "\n");
    await wait(6500);
    assert(mgr.getExternal(id36)?.status === "WORKING", "36 dangling tool_use keeps WORKING");
    // tool_result 落地后下一条消息生成中（gen）同样长窗豁免
    appendFileSync(f36, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }) + "\n");
    await wait(6500);
    assert(mgr.getExternal(id36)?.status === "WORKING", "36 awaiting generation keeps WORKING");
    // 纯文本收尾才是回合结束信号 → 回落 DONE（等待需覆盖最坏对齐：读取 tick 5s + 回落 tick 5s）
    appendFileSync(f36, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "final answer" }] } }) + "\n");
    await wait(11_500);
    assert(mgr.getExternal(id36)?.status === "DONE", "36 text ending falls to DONE");
  } finally {
    delete process.env.CCR_NOHOOK_IDLE_MS;
  }
  rmSync(PROOT, { recursive: true, force: true });
}

// 37. pid 对账自愈：cli-pids.json 缺失（hook 死亡/dataDir 换代窗口）时，
// ~/.claude/sessions/<pid>.json 是 hook 无关的 pid 权威源——重启后按会话 id 对上即补定位，
// 顺带清 historical（活 pid 即会话存活证明）。2026-09-04 下午 2h40m"发不出去"事故的根治
{
  const SROOT = fileURLToPath(new URL("../data/test-sessions/", import.meta.url));
  process.env.CCR_SESSIONS_ROOT = SROOT;
  rmSync(SROOT, { recursive: true, force: true });
  mkdirSync(SROOT, { recursive: true });
  const sid37 = "aa11bb22-" + "7".repeat(12);
  const id37 = "ext-" + sid37;
  await bridge.handleEvent({
    event: "UserPromptSubmit",
    session_id: sid37,
    cwd: "D:\\pid-reconcile-test",
    prompt: "pid test",
    transcript_path: undefined,
  });
  // 模拟 relay 重启后的锁死态：pid 丢失 + historical=true
  const st37 = mgr.getExternal(id37)!;
  st37.cli_pid = undefined;
  st37.historical = true;
  // CLI 自写的会话信息文件：文件名 = pid（用测试进程自身 pid 保证存活）
  writeFileSync(join(SROOT, `${process.pid}.json`), JSON.stringify({ sessionId: sid37, name: "pid test" }));
  (bridge as unknown as { reconcilePidsFromSessions(): void }).reconcilePidsFromSessions();
  assert(mgr.getExternal(id37)?.cli_pid === process.pid, "37 pid reconciled from sessions dir");
  assert(mgr.getExternal(id37)?.historical === false, "37 historical cleared by live pid");
  // 死 pid 的 sessions 文件不得覆盖（无 pid 会话保持无 pid，防陈旧文件误定位）
  rmSync(join(SROOT, `${process.pid}.json`));
  const sid37b = "bb22cc33-" + "8".repeat(12);
  await bridge.handleEvent({
    event: "UserPromptSubmit",
    session_id: sid37b,
    cwd: "D:\\pid-reconcile-test",
    prompt: "dead pid",
    transcript_path: undefined,
  });
  const st37b = mgr.getExternal("ext-" + sid37b)!;
  st37b.cli_pid = undefined;
  const deadPid = 9999999;
  writeFileSync(join(SROOT, `${deadPid}.json`), JSON.stringify({ sessionId: sid37b }));
  (bridge as unknown as { reconcilePidsFromSessions(): void }).reconcilePidsFromSessions();
  assert(mgr.getExternal("ext-" + sid37b)?.cli_pid === undefined, "37 dead pid not adopted");
  delete process.env.CCR_SESSIONS_ROOT;
  rmSync(SROOT, { recursive: true, force: true });
}

// 38. transcript 用户行晋升 pending（hook 死亡时 UserPromptSubmit 断流的根治路径）：
//     CLI 把排队消息提交成 transcript user 行，轮询/事件增量读出即晋升，
//     消息不再滞留 pending 闪烁；无 pending 命中的手敲/工具结果行不产生 user_message（防双记）
{
  const w38 = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
  attach(w38);
  await new Promise((r) => w38.once("open", r));
  await wait(100);
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const T = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T, { force: true });
  writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线38" }] } }) + "\n");
  const sid = extId("cli-1");
  const umCount = (t: string) =>
    events.filter((e) => e.type === "SESSION_LOG" && (e.payload as { kind?: string; text?: string }).kind === "user_message" && (e.payload as { text: string }).text === t).length;
  const pendTexts = () => pendOf(sid).map((p) => p.text);
  await hook({ event: "UserPromptSubmit", prompt: "转录晋升回合", cli_pid: 4321, transcript_path: T });
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  // 模拟 hook 死亡：状态 DONE + pending 滞留（不经 extInput，避免真注入）
  mgr.setExternalStatus(sid, "DONE", "回合结束");
  mgr.setExternalPending(sid, [{ text: "转录晋升消息", ts: Date.now() }]);
  // CLI 把排队消息提交为 user 行 → 增量读出 → 晋升（无任何 UserPromptSubmit 事件）
  appendFileSync(T, JSON.stringify({ type: "user", isMeta: false, message: { role: "user", content: "转录晋升消息" } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(umCount("转录晋升消息") === 1, "38 user line promotes stuck pending");
  assert(!pendTexts().includes("转录晋升消息"), "38 promoted msg leaves pending");
  // 纯手敲（无 pending 命中）：不记 user_message（hook 在时由 UPS 记，防双记）
  appendFileSync(T, JSON.stringify({ type: "user", message: { role: "user", content: "纯手敲消息" } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(umCount("纯手敲消息") === 0, "38 unmatched user line logs nothing");
  // tool_result 回填的 user 行不当用户输入
  appendFileSync(T, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Task #1 created successfully" }] } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(umCount("Task #1 created successfully") === 0, "38 tool_result line not treated as user input");
  // isMeta 行（系统注入）不晋升
  mgr.setExternalPending(sid, [{ text: "Caveat: 注入", ts: Date.now() }]);
  appendFileSync(T, JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: 注入" } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
  assert(umCount("Caveat: 注入") === 0, "38 isMeta line skipped");
  w38.close();
  rmSync(T, { force: true });
}

// 39. 发送可靠性：已进 CLI 队列的 pending 不补发回车；晋升后同文本重发再滞留恢复补发
{
  const { appendFileSync, writeFileSync } = await import("node:fs");
  const T = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T, { force: true });
  writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线39" }] } }) + "\n");
  const sid = extId("cli-8");
  const enters = () => fakeLog().filter((a) => a[0] === "8888" && a[1] === "").length;
  await hook({ event: "UserPromptSubmit", prompt: "看门狗39", session_id: "cli-8", cli_pid: 8888, transcript_path: T });
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", session_id: "cli-8", transcript_path: T });
  // CLI 忙时把注入消息捕获进队（queue-operation enqueue 行）→ pending 保留但看门狗跳过
  mgr.setExternalStatus(sid, "WORKING", "跑");
  mgr.setExternalPending(sid, [{ text: "进队消息", ts: Date.now() - 9000 }]);
  appendFileSync(T, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "进队消息" }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", session_id: "cli-8", transcript_path: T });
  await wait(8000);
  assert(enters() === 0, "39 enqueued pending does not trigger enter re-send");
  // 回合结束 CLI 提交该消息（user 行）→ 晋升 + 移除进队标记
  mgr.setExternalStatus(sid, "DONE", "结束");
  appendFileSync(T, JSON.stringify({ type: "user", isMeta: false, message: { role: "user", content: "进队消息" } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", session_id: "cli-8", transcript_path: T });
  assert(!(mgr.getExternal(sid)?.pending_inputs ?? []).some((p) => p.text === "进队消息"), "39 promoted by user line, pending cleared");
  // 同文本再次滞留（未进队的新注入条目，时间晚于晋升记录）→ 看门狗恢复补发。
  // 等 5ms 确保 p.ts 严格晚于晋升记录：同步 stretch 内两处 Date.now() 可能同毫秒，
  // 相等时 rec.ts >= p.ts 判定为残留跳过，看门狗永远不补发（历史 flake 根因）
  await wait(5);
  mgr.setExternalStatus(sid, "WORKING", "再跑");
  mgr.setExternalPending(sid, [{ text: "进队消息", ts: Date.now() }]);
  await wait(12000);
  assert(enters() >= 1, "39 same text re-stuck after promotion triggers re-send");
  await hook({ event: "SessionEnd", session_id: "cli-8", reason: "clear" });
  rmSync(T, { force: true });
}

// 40. #292 系统通知块污染过滤：后台任务通知/命令回显以 UserPromptSubmit 形态到达时
//     不产生 user_message、不污染标题与状态摘要；含机器输出路径的变体同拦；
//     assistant 块首系统包装块剥离后正文保留；正文中间的正常尖括号不受影响
{
  const { isMachineUserText, stripLeadingSystemBlocks } = await import("../src/summarizer.js");
  // 单元规则：块首标签 / 机器路径（Win 反斜杠、Unix、引号前缀变体）/ 正文尖括号不误伤
  assert(isMachineUserText("<task-notification>\n<task-id>b</task-id>\n</task-notification>"), "40 unit: task-notification prefix detected");
  assert(isMachineUserText("<command-name>/model</command-name>"), "40 unit: command echo prefix detected");
  assert(isMachineUserText("<system-reminder>注入</system-reminder>"), "40 unit: system-reminder prefix detected");
  assert(isMachineUserText('“<task-notification> <output-file>C:\\Users\\u\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\b1.output</output-file>'), "40 unit: quoted variant caught by output path");
  assert(isMachineUserText("/tmp/claude/proj/sid/tasks/xx.output 已生成，请查看"), "40 unit: unix task output path caught");
  assert(!isMachineUserText("帮我看看 transcript 里的 <task-notification> 块是什么"), "40 unit: mid-text angle brackets not harmed");
  assert(!isMachineUserText("普通用户消息"), "40 unit: normal prompt passes");
  assert(stripLeadingSystemBlocks("<system-reminder>\n图片占位\n</system-reminder>好的，已确认。") === "好的，已确认。", "40 unit: leading system block stripped, body kept");
  assert(stripLeadingSystemBlocks("<command-name>/model</command-name>\n<command-message>model</command-message>") === "", "40 unit: stacked command blocks fully stripped");
  assert(stripLeadingSystemBlocks("正文里的 <system-reminder>x</system-reminder> 保留") === "正文里的 <system-reminder>x</system-reminder> 保留", "40 unit: mid-text tag untouched");

  const { appendFileSync, writeFileSync } = await import("node:fs");
  const T = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T, { force: true });
  // 事件断言需要在线 WS 客户端（此前测试段的 socket 已全部关闭）
  const w40 = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
  attach(w40);
  await new Promise((r) => w40.once("open", r));
  await wait(100);
  writeFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线40" }] } }) + "\n");
  const sid = extId("cli-40");
  const um40 = () => events.filter((e) => e.type === "SESSION_LOG" && e.session_id === sid && (e.payload as { kind?: string }).kind === "user_message");
  const at40 = () => events.filter((e) => e.type === "SESSION_LOG" && e.session_id === sid && (e.payload as { kind?: string }).kind === "assistant_text");
  const notif =
    '<task-notification>\n<task-id>bx1</task-id>\n<tool-use-id>call_1</tool-use-id>\n' +
    '<output-file>C:\\Users\\u\\AppData\\Local\\Temp\\claude\\D--dev-cc-watch\\sid40\\tasks\\bx1.output</output-file>\n' +
    '<status>completed</status>\n<summary>Background command "build" completed (exit code 0)</summary>\n</task-notification>';
  // ① hook 携带通知原文（后台任务完成以此形态泄漏）：无 user_message、摘要/标题不污染、状态照常 WORKING
  await hook({ event: "UserPromptSubmit", prompt: notif, session_id: "cli-40", cli_pid: 4040, transcript_path: T });
  await wait(200);
  const st40 = mgr.getExternal(sid);
  assert(um40().length === 0, "40 task-notification prompt yields no user_message");
  assert(!!st40 && st40.status === "WORKING" && !(st40.action_summary ?? "").includes("<"), "40 action_summary not polluted, still WORKING");
  assert(!(st40?.title ?? "").includes("task-notification"), "40 title not polluted");
  assert(events.some((e) => e.type === "SESSION_LOG" && e.session_id === sid && (e.payload as { kind?: string }).kind === "system" && String((e.payload as { text?: string }).text).includes("已过滤")), "40 filter trace logged as system kind");
  // ② slash 命令回显 / ③ 引号前缀变体（CLI 重发形态，靠路径规则兜住）
  await hook({ event: "UserPromptSubmit", prompt: "<command-name>/model</command-name>\n<command-message>model</command-message>", session_id: "cli-40", transcript_path: T });
  await hook({ event: "UserPromptSubmit", prompt: '“<task-notification> <task-id>b2</task-id> <output-file>C:\\Users\\u\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\b2.output</output-file> done', session_id: "cli-40", transcript_path: T });
  await wait(200);
  assert(um40().length === 0, "40 command echo & quoted variant yield no user_message");
  // ④ 正常 prompt 不受过滤影响（回归护栏）
  await hook({ event: "UserPromptSubmit", prompt: "正常消息回归检查", session_id: "cli-40", transcript_path: T });
  await wait(200);
  assert(um40().length === 1 && (um40()[0].payload as { text?: string }).text === "正常消息回归检查", "40 normal prompt still logged as user_message");
  // ⑤ transcript 侧：user 行系统块不入用户文本；assistant 块首系统块剥离保留正文、纯块不产生消息
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", session_id: "cli-40", transcript_path: T });
  await wait(200);
  appendFileSync(T, JSON.stringify({ type: "user", isMeta: false, message: { role: "user", content: "<system-reminder>机器注入内容</system-reminder>" } }) + "\n");
  appendFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "<system-reminder>\n图片占位提醒\n</system-reminder>好的，已确认图内容。" }] } }) + "\n");
  appendFileSync(T, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "<system-reminder>纯系统块无正文</system-reminder>" }] } }) + "\n");
  await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", session_id: "cli-40", transcript_path: T });
  await wait(200);
  assert(um40().length === 1, "40 transcript system-reminder user line yields no user_message");
  assert(at40().some((e) => (e.payload as { text?: string }).text === "好的，已确认图内容。"), "40 assistant body kept after leading block strip");
  assert(at40().every((e) => !String((e.payload as { text?: string }).text).includes("<system-reminder>")), "40 no system-reminder leaks into assistant_text");
  await hook({ event: "SessionEnd", session_id: "cli-40", reason: "clear" });
  w40.close();
  rmSync(T, { force: true });
}

// 41. #293 新增会话默认目录回落：未配置 CCR_CWD 时默认 homedir；指定/默认目录无效
//     （不存在/是文件/statSync 抛错）回落 homedir 且说明含原目录与 CCR_CWD 建议值；
//     有效指定目录 > 配置默认目录的优先级不变
{
  const { resolveCreateCwd } = await import("../src/session-manager.js");
  const { homedir } = await import("node:os");
  const { resolve } = await import("node:path");
  const home = homedir();
  mkdirSync(PROOT, { recursive: true });

  // ① 无指定 + 无默认 → homedir，说明含 CCR_CWD 建议值
  const r1 = resolveCreateCwd("", "");
  assert(r1.cwd === home && r1.fallbackNote.includes("CCR_CWD"), "41 no cwd & no default falls back to homedir with CCR_CWD hint");

  // ② Mac 源事故形态：默认目录指向已删除的启动目录（statSync 抛 ENOENT 而非返回 false）→ 回落
  const gone = join(PROOT, "gone-cwd");
  mkdirSync(gone, { recursive: true });
  rmSync(gone, { recursive: true, force: true });
  const r2 = resolveCreateCwd("", gone);
  assert(r2.cwd === home && r2.fallbackNote.includes("gone-cwd"), "41 deleted default cwd falls back to homedir, note names it");

  // ③ 指定路径是文件（存在但非目录）→ 回落
  const aFile = join(PROOT, "not-a-dir.txt");
  writeFileSync(aFile, "x");
  assert(resolveCreateCwd(aFile, "").cwd === home, "41 file path as cwd falls back to homedir");
  rmSync(aFile, { force: true });

  // ④ 有效指定目录优先于默认目录；⑤ 配置的默认目录（CCR_CWD 形态）直接采用不回落
  assert(resolveCreateCwd(PROOT, "Z:/definitely-missing").cwd === resolve(PROOT), "41 valid raw cwd wins over default");
  assert(resolveCreateCwd("", PROOT).cwd === resolve(PROOT), "41 configured default cwd used as-is");

  // ⑥ 配置层：未设 CCR_CWD → defaultCwd 即 homedir（不再拿启动目录当默认）；设置后优先级不变
  const hadCwd = process.env.CCR_CWD;
  delete process.env.CCR_CWD;
  assert(loadConfig().defaultCwd === home, "41 config: absent CCR_CWD defaults to homedir");
  process.env.CCR_CWD = PROOT;
  assert(loadConfig().defaultCwd === PROOT, "41 config: CCR_CWD keeps priority");
  if (hadCwd === undefined) delete process.env.CCR_CWD;
  else process.env.CCR_CWD = hadCwd;
  rmSync(PROOT, { recursive: true, force: true });
}

// 42. #305 macOS 注入器（第七轮 Terminal do script）：按 pid 反查 tty 定位标签页后
//     `do script (...) in selected tab` 打字（不经 System Events / 无需辅助功能 / 不抢焦点，
//     自带 Return 提交）。测试跑在 Windows：CCR_TEST_PLATFORM=darwin + 假 osascript 记 argv
{
  const { injectText, injectEsc, injectEnter, mapAppleError } = await import("../src/injector.js");
    const savedCmd = process.env.CCR_INJECT_CMD;
    delete process.env.CCR_INJECT_CMD;
    process.env.CCR_TEST_PLATFORM = "darwin";
    process.env.CCR_OSASCRIPT_CMD = fileURLToPath(new URL("./fake-injector.mjs", import.meta.url));
    const appleLog = () => fakeLog().filter((a) => a[0] === "-e").map((a) => String(a[1]));
    try {
      // ① 短文本：tty 定位 + do script 整段字面量（转义引号/反斜杠）+ 无 System Events
      assert((await injectText(5555, String.raw`带"引号"与\反斜杠`)).ok, "42 darwin injectText ok via fake osascript");
      const s1 = appleLog().at(-1)!;
      assert(s1.includes("ps -o tty= -p 5555"), "42 resolves tty by pid");
      assert(s1.includes("tty of t ends with targetTty"), "42 selects tab by tty");
      assert(s1.includes(String.raw`do script ("带\"引号\"与\\反斜杠") in t`), "42 do script literal escapes quotes and backslashes");
      assert(!s1.includes("System Events") && !s1.includes("keystroke"), "42 no System Events / keystroke");
      assert(!s1.includes("frontmost") && !s1.includes("activate"), "42 no focus stealing");
      // ② 换行折叠为单行 do script
      assert((await injectText(5555, "第一行\n第二行")).ok, "42 multiline inject ok");
      assert(appleLog().at(-1)!.includes('do script ("第一行 第二行") in t'), "42 newlines folded to single do script");
      // ③ 超长文本单次注入（do script 无 keystroke 的可靠性切分问题）
      const before3 = appleLog().length;
      assert((await injectText(5555, "长".repeat(801) + "尾")).ok, "42 long text inject ok");
      assert(appleLog().length - before3 === 1, "42 long text stays single do script call");
      // ④ Esc（ASCII 27 表达式）/ 纯回车（空串表达式），均为 do script
      assert((await injectEsc(5555)).ok, "42 darwin injectEsc ok");
      assert(appleLog().at(-1)!.includes("do script (ASCII character 27)"), "42 esc maps to ASCII 27 expression");
      assert((await injectEnter(5555)).ok, "42 darwin injectEnter ok");
      assert(appleLog().at(-1)!.includes('do script ("")'), "42 enter maps to empty do script");
    } finally {
      delete process.env.CCR_TEST_PLATFORM;
      delete process.env.CCR_OSASCRIPT_CMD;
      if (savedCmd !== undefined) process.env.CCR_INJECT_CMD = savedCmd;
    }
  // ⑤ 纯函数：错误翻译（-25211/-1743 → Terminal 宿主提示；-1719 旧辅助功能兜底；其他透传）
  assert((mapAppleError("execution error: ... not allowed assistive access (-25211)") ?? "").includes("Terminal"), "42 -25211 translated to Terminal-host hint");
  assert((mapAppleError("execution error: ... (-1743)") ?? "").includes("Terminal"), "42 -1743 translated to Terminal-host hint");
  assert((mapAppleError("execution error: ... (-1719)") ?? "").includes("辅助功能"), "42 -1719 keeps legacy accessibility hint");
  assert(mapAppleError("execution error: other (-1750)") === undefined, "42 other osascript errors pass through");
}

// ── 43 段：#325 扫码登录 COMMAND_LOGIN_GRANT——devId 一致性 / 格式上界 / name 截断 / 云桥未启用
{
  const grants: Array<{ dev: string; pk: string; name: string }> = [];
  mgr.setCloud({ keypair: { publicKey: "stub" }, relayDev: "rl-stub", peers: new Map(), addPeer: () => {} });
  mgr.setLoginGranter((dev, pk, name) => { grants.push({ dev, pk, name }); return true; });
  const call = (payload: unknown) =>
    mgr.handleCommand({ command_id: randomUUID(), type: "COMMAND_LOGIN_GRANT", ts: Date.now(), payload } as Command, "t43");
  const kp = generateKeyPair();
  const dev = devId(kp.publicKey, "wb");
  assert(call({ session_dev: "wb-deadbeefdeadbeef", session_pk: kp.publicKey }).ok === false, "43 dev/pk mismatch rejected");
  assert(call({ session_dev: dev, session_pk: "short" }).ok === false, "43 malformed pk rejected");
  assert(call({ session_dev: dev, session_pk: kp.publicKey, name: "长".repeat(50) }).ok === true, "43 valid grant ok");
  assert(grants.at(-1)!.dev === dev && grants.at(-1)!.name.length === 32, "43 granter got dev + name truncated to 32");
  (mgr as unknown as { cloud: unknown }).cloud = null;
  const off = call({ session_dev: dev, session_pk: kp.publicKey });
  assert(off.ok === false && (off.error ?? "").includes("云桥未启用"), "43 cloud-off rejected with hint");
}

// ── 44 段：#316 手表配对信道——PAIR_PENDING 同码广播、待配对连接不收事件、
// 授权后手表拿 token、PAIR_RESOLVED 广播、未知 request_id 拒绝。
// 手机侧用新鲜 token 连接（同 40 段先例：不依赖前面段落遗留的 socket 存活）
{
  const w44 = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
  const phoneFrames: Array<{ type?: string; payload?: { code?: string; decision?: string } }> = [];
  w44.on("message", (d) => phoneFrames.push(JSON.parse(String(d))));
  attach(w44);
  await new Promise((r) => w44.once("open", r));
  await wait(200);
  const wframes: Array<{ type?: string; code?: string; token?: string; request_id?: string; seq?: number }> = [];
  const watch = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?pair=1&name=${encodeURIComponent("测试表")}`);
  watch.on("message", (d) => wframes.push(JSON.parse(String(d))));
  await new Promise((r) => watch.once("open", r));
  await wait(400);
  const pend = wframes.find((f) => f.type === "PAIR_PENDING");
  assert(!!pend && /^\d{6}$/.test(pend.code ?? ""), "44 watch got PAIR_PENDING with 6-digit code");
  const reqEv = phoneFrames.find((f) => f.type === "PAIR_REQUEST");
  assert(!!reqEv && reqEv.payload?.code === pend?.code, "44 LAN clients got PAIR_REQUEST with same code");
  assert(!wframes.some((f) => f.type === "SNAPSHOT" || (f.seq ?? 0) > 0), "44 pairing socket receives no session events");
  const idBad = send("COMMAND_WATCH_GRANT", { request_id: randomUUID(), allow: true });
  assert((await waitAck(idBad)).ok === false, "44 unknown request_id rejected");
  const idOk = send("COMMAND_WATCH_GRANT", { request_id: pend?.request_id ?? "", allow: true });
  assert((await waitAck(idOk)).ok === true, "44 grant ack ok");
  await wait(700);
  assert(wframes.some((f) => f.type === "PAIR_OK" && f.token === cfg.token), "44 watch got token after allow");
  assert(
    phoneFrames.some((f) => f.type === "PAIR_RESOLVED" && f.payload?.decision === "allow"),
    "44 PAIR_RESOLVED allow broadcast",
  );
  try { watch.close(); } catch {}
}

// ── 45 段：防抢发（type guard）——看门狗补发回车前快照 CLI 输入框：
//     框内只有滞留消息→照常补发；有疑似人工输入→等停手再补；持续输入→本轮放弃；
//     框内已无滞留消息→跳过；快照不可用→fail-open 直接补发；CCR_TYPE_GUARD=off→不快照。
//     纯逻辑部分用真实 CLI 控制台快照样本（Windows Terminal + Claude CLI 2.1.x 实测采集）
{
  const { extractInputBox, foreignResidual, anyKnownPresent, guardCompensateEnter, guardConfig } = await import("../src/type-guard.js");

  // 样本：空闲 CLI + 输入框里有滞留消息（边框为全宽 ─ 行，此处截短为 40 列）
  const B = "─".repeat(40);
  const MSG1 = "手机排队消息：请继续上面的任务";
  const CAP_TEXT = [
    "  … +36 completed",
    "                          new task? /clear to save 186.7k tokens",
    B,
    `❯ ${MSG1}`,
    B,
    "  [glm-5.3[1m]] ██░░░░░░░░ 18%",
    "  ⏵⏵ bypass permissions on · 1 shell",
  ];
  // 样本：长消息折行（CJK 无空格断行）——干净版与带人工追加输入版
  const MSG2 = "其次这条是很长的排队消息用来测试输入框换行渲染的场景请务必撑开到多行我们看看CLI如何折叠长文本";
  const FOREIGN = "另外我手动补一句";
  const wrapRows = (tail: string) => [
    `❯ ${MSG1}其次这条是很长的排队消息用来测试输入框换行渲染`,
    `  的场景请务必撑开到多行我们看看CLI如何折叠长文本${tail}`,
  ];
  const CAP_WRAP_CLEAN = ["✶ Embellishing…", B, ...wrapRows(""), B, "  ⏵⏵ bypass permissions on · 1 shell"];
  const CAP_WRAP = ["✶ Embellishing…", B, ...wrapRows(FOREIGN), B, "  ⏵⏵ bypass permissions on · 1 shell"];
  // 样本：框空（消息已被提交/清空）；busy 时 spinner 在边框外，框内只剩 ❯
  const CAP_EMPTY = [B, "❯", B, "  ⏵⏵ bypass permissions on · 1 shell"];

  // ① 框提取：边框对之间含 ❯ 的内容行；spinner/状态行不进框
  const box1 = extractInputBox(CAP_TEXT)!;
  assert(box1.length === 1 && box1[0] === `❯ ${MSG1}`, "45 extract box rows between borders");
  const boxW = extractInputBox(CAP_WRAP)!;
  assert(boxW.length === 2, "45 extract keeps wrapped continuation rows");
  // ② 框内只有我们的消息 → 无外来内容（含折行跨行拼接形态）
  assert(foreignResidual(box1, [MSG1]) === "", "45 own message only → no residual");
  assert(foreignResidual(extractInputBox(CAP_WRAP_CLEAN)!, [MSG1, MSG2]) === "", "45 wrapped CJK join removes known texts");
  assert(anyKnownPresent(box1, [MSG1]), "45 known text detected present");
  // ③ 人工输入（含折行尾部追加）→ 检出外来内容
  const res = foreignResidual(boxW, [MSG1, MSG2]);
  assert(res.includes(FOREIGN), `45 foreign typing detected across wrap (residual=${res})`);
  // ④ 右侧 n/m 计数与 ❯ 是渲染噪音，不算人工输入
  assert(foreignResidual(["❯ 继续执行 2/3"], ["继续执行"]) === "", "45 n/m counter masked as noise");
  // ⑤ 框空 → 滞留消息不在（skip 判定）；busy 的 spinner 不误伤
  assert(!anyKnownPresent(extractInputBox(CAP_EMPTY)!, [MSG1, MSG2]), "45 empty box → known absent");
  assert(extractInputBox(["✶ Working…", B, "❯", B])!.length === 1, "45 busy spinner row stays outside box");
  // ⑥ 无法识别（无边框对/无 ❯，如权限弹窗盖住）→ null → fail-open
  assert(extractInputBox(["  ? Allow Bash", "  1. Yes  2. No"]) === null, "45 unrecognizable screen → null");

  // ⑦ 守门判定（快照序列注入，短时钟）：干净→enter；人工→停手后 enter-after-wait；
  //    持续变化→timeout；框空→skip-absent；快照不可用→unknown；等待中状态变化→aborted
  const cfg45 = { enabled: true, pollMs: 10, stableMs: 60, maxMs: 400 };
  const cap = (rows: string[] | null) => async () => rows;
  assert((await guardCompensateEnter([MSG1], cap(CAP_TEXT), { cfg: cfg45 })).kind === "enter", "45 clean box → enter now");
  const vWait = await guardCompensateEnter([MSG1, MSG2], cap(CAP_WRAP), { cfg: cfg45 });
  assert(vWait.kind === "enter-after-wait", "45 typing then idle → enter after wait");
  let i = 0;
  const CHAOS_A = ["✶ Working…", B, `❯ ${MSG1}人工输入甲`, B];
  const CHAOS_B = ["✶ Working…", B, `❯ ${MSG1}人工输入乙`, B];
  const vChaos = await guardCompensateEnter([MSG1], async () => (i++ % 2 ? CHAOS_A : CHAOS_B), { cfg: cfg45 });
  assert(vChaos.kind === "timeout", "45 continuously changing box → give up this round");
  assert((await guardCompensateEnter([MSG1], cap(CAP_EMPTY), { cfg: cfg45 })).kind === "skip-absent", "45 known absent → skip");
  assert((await guardCompensateEnter([MSG1], cap(null), { cfg: cfg45 })).kind === "unknown", "45 capture unavailable → unknown (fail-open)");
  let aborted = false;
  assert(
    (await guardCompensateEnter([MSG1, MSG2], cap(CAP_WRAP), { cfg: cfg45, abort: () => aborted })).kind === "enter-after-wait",
    "45 abort=false does not interfere",
  );
  aborted = true;
  assert((await guardCompensateEnter([MSG1, MSG2], cap(CAP_WRAP), { cfg: cfg45, abort: () => aborted })).kind === "aborted", "45 abort during wait → aborted");
  const savedOff = process.env.CCR_TYPE_GUARD;
  process.env.CCR_TYPE_GUARD = "off";
  assert(guardConfig().enabled === false, "45 CCR_TYPE_GUARD=off disables guard");
  process.env.CCR_TYPE_GUARD = "0";
  assert(guardConfig().enabled === false, "45 CCR_TYPE_GUARD=0 disables guard");
  if (savedOff === undefined) delete process.env.CCR_TYPE_GUARD;
  else process.env.CCR_TYPE_GUARD = savedOff;

  // ⑧ macOS 快照通道：Terminal contents 走 stdout（假 osascript 回 CCR_FAKE_PEEK_FILE）
  {
    const savedCmd = process.env.CCR_INJECT_CMD;
    delete process.env.CCR_INJECT_CMD;
    process.env.CCR_TEST_PLATFORM = "darwin";
    process.env.CCR_OSASCRIPT_CMD = fileURLToPath(new URL("./fake-injector.mjs", import.meta.url));
    const PEEK8 = fileURLToPath(new URL("../data/test-peek.txt", import.meta.url));
    process.env.CCR_FAKE_PEEK_FILE = PEEK8;
    writeFileSync(PEEK8, Array.from({ length: 30 }, (_, k) => `row${k}`).join("\n"));
    try {
      const { captureConsoleBottom, buildCaptureScript } = await import("../src/injector.js");
      const cap8 = await captureConsoleBottom(5555, 5);
      assert(cap8?.length === 5 && cap8[0] === "row25" && cap8[4] === "row29", "45 mac capture takes tail rows via contents");
      assert(buildCaptureScript(5555).includes("return contents of t") && buildCaptureScript(5555).includes("tty of t"), "45 mac capture script locates tab by tty");
    } finally {
      delete process.env.CCR_TEST_PLATFORM;
      delete process.env.CCR_OSASCRIPT_CMD;
      delete process.env.CCR_FAKE_PEEK_FILE;
      if (savedCmd !== undefined) process.env.CCR_INJECT_CMD = savedCmd;
      rmSync(PEEK8, { force: true });
    }
  }

  // ⑨ 看门狗集成（真 Bridge 节拍 + 假注入器/假快照，短阈值）
  const PEEK = fileURLToPath(new URL("../data/test-peek.txt", import.meta.url));
  const T45 = fileURLToPath(new URL("../data/test-transcript.jsonl", import.meta.url));
  rmSync(T45, { force: true });
  writeFileSync(T45, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "基线45" }] } }) + "\n");
  const sid = extId("cli-10");
  const enters45 = () => fakeLog().filter((a) => a[0] === "12121" && a[1] === "").length;
  const peeks45 = () => fakeLog().filter((a) => a[0] === "12121" && a[1] === "--peek").length;
  const logs45 = () => events.filter((e) => e.type === "SESSION_LOG" && e.session_id === sid).map((e) => String((e.payload as { text: string }).text));
  await hook({ event: "UserPromptSubmit", prompt: "看门狗45", session_id: "cli-10", cli_pid: 12121, transcript_path: T45 });
  process.env.CCR_TYPE_GUARD_POLL_MS = "60";
  process.env.CCR_TYPE_GUARD_STABLE_MS = "250";
  process.env.CCR_FAKE_PEEK_FILE = PEEK;
  const settle = async () => {
    mgr.setExternalPending(sid, []);
    await wait(5600); // 一个 5s 节拍看到 pending 清空 → 看门狗重置
  };
  try {
    // a. 框内只有滞留消息 → 守门通过立即补发（文案同旧版）
    mgr.setExternalStatus(sid, "WORKING", "跑");
    mgr.setExternalPending(sid, [{ text: MSG1, ts: Date.now() - 9000 }]);
    writeFileSync(PEEK, CAP_TEXT.join("\n"));
    await wait(8000);
    assert(enters45() >= 1, "45a clean box still gets compensating enter");
    assert(logs45().some((t) => t.includes("已补发回车") && !t.includes("等停手")), "45a legacy enter log preserved");
    assert(peeks45() > 0, "45a watchdog peeks the console before enter");
    await settle();
    // b. 框内有疑似人工输入（静止=已停手）→ 等停手窗口后补发
    const before = enters45();
    mgr.setExternalPending(sid, [{ text: MSG1, ts: Date.now() - 9000 }, { text: MSG2, ts: Date.now() - 9000 }]);
    writeFileSync(PEEK, CAP_WRAP.join("\n"));
    await wait(8000);
    assert(enters45() > before, "45b typing detected then idle → enter after wait");
    assert(logs45().some((t) => t.includes("等停手")), "45b enter-after-wait log emitted");
    await settle();
    // c. 持续人工输入（快照内容不断变化）→ 本轮放弃、不补发
    //    假注入器 CHAOS 模式：%T% 每次快照替换为当前时间戳，确定性模拟"一直在打字"
    process.env.CCR_TYPE_GUARD_MAX_MS = "400";
    process.env.CCR_FAKE_PEEK_CHAOS = "1";
    const beforeC = enters45();
    mgr.setExternalPending(sid, [{ text: MSG1, ts: Date.now() - 9000 }]);
    writeFileSync(PEEK, ["✶ Working…", "─".repeat(40), `❯ ${MSG1}人工输入%T%`, "─".repeat(40)].join("\n"));
    await wait(8000);
    delete process.env.CCR_FAKE_PEEK_CHAOS;
    assert(enters45() === beforeC, "45c continuous typing → no enter this round");
    assert(logs45().some((t) => t.includes("本轮暂缓补发回车")), "45c defer log emitted");
    delete process.env.CCR_TYPE_GUARD_MAX_MS;
    await settle();
    // d. 框内已无滞留消息（被人工提交/清空）→ 跳过补发
    const beforeD = enters45();
    mgr.setExternalPending(sid, [{ text: MSG1, ts: Date.now() - 9000 }]);
    writeFileSync(PEEK, CAP_EMPTY.join("\n"));
    await wait(8000);
    assert(enters45() === beforeD, "45d message gone from box → skip enter");
    assert(logs45().some((t) => t.includes("跳过本次补发回车")), "45d skip log emitted");
    await settle();
    // e. 快照不可用（旧注入器/识别失败）→ fail-open 维持旧行为直接补发
    const beforeE = enters45();
    delete process.env.CCR_FAKE_PEEK_FILE;
    mgr.setExternalPending(sid, [{ text: MSG1, ts: Date.now() - 9000 }]);
    await wait(8000);
    assert(enters45() > beforeE, "45e capture unavailable → legacy direct enter (fail-open)");
    process.env.CCR_FAKE_PEEK_FILE = PEEK;
    await settle();
    // f. CCR_TYPE_GUARD=off → 不快照直接补发
    process.env.CCR_TYPE_GUARD = "off";
    const beforeF = enters45();
    const pkF = peeks45();
    mgr.setExternalPending(sid, [{ text: MSG1, ts: Date.now() - 9000 }]);
    writeFileSync(PEEK, CAP_WRAP.join("\n")); // 有"人工输入"也不该拦
    await wait(8000);
    assert(enters45() > beforeF, "45f guard off → enter despite foreign content");
    assert(peeks45() === pkF, "45f guard off → no console peek");
    await hook({ event: "SessionEnd", session_id: "cli-10", reason: "clear" });
  } finally {
    delete process.env.CCR_TYPE_GUARD;
    delete process.env.CCR_TYPE_GUARD_POLL_MS;
    delete process.env.CCR_TYPE_GUARD_STABLE_MS;
    delete process.env.CCR_TYPE_GUARD_MAX_MS;
    delete process.env.CCR_FAKE_PEEK_FILE;
    delete process.env.CCR_FAKE_PEEK_CHAOS;
    rmSync(T45, { force: true });
    rmSync(PEEK, { force: true });
  }
}

// 46. #49 置顶会话：pin 命令往返 / 写穿 pinned-sessions.json / SNAPSHOT 带 pinned /
//     重启休眠登记（saved，不拉起）/ 按需恢复（COMMAND_RESUME_SESSION）/ 失败与重试
{
  const PIN_FILE = join(cfg.dataDir, "pinned-sessions.json");
  rmSync(PIN_FILE, { force: true });

  // 假 agent 工厂（测试缝）：不拉真 CLI。initMode 在构造时刻读取——
  // init = 20ms 后回 onInit（正常 ready）；noinit = 永不 ready（无 relay_session_id）；
  // die = 10ms 后流关闭（恢复失败路径）
  let initMode: "init" | "noinit" | "die" = "init";
  const created: { prompt: string | undefined; resume?: string; cb: AgentCallbacks }[] = [];
  const makeFakeFactory = () => (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { resume?: string }): AgentLike => {
    const rec = { prompt, resume: opts?.resume, cb };
    created.push(rec);
    const mode = initMode;
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    if (mode === "init") {
      setTimeout(() => {
        if (a.ended) return;
        cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
        // 有首条消息（create/消息式 resume）才有回合；parked 恢复停在等待输入
        if (prompt !== undefined) setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 12); }, 10);
      }, 20);
    } else if (mode === "noinit") {
      // 不回 init（无 relay_session_id）但回合完成 → 终态 DONE：真实世界里这是
      // "init 前被杀" 的会话（重启后会被重放标 ERROR），这里用于可删除路径
      setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 8); }, 20);
    } else if (mode === "die") setTimeout(() => { if (!a.ended) { a.ended = true; cb.onSessionEnd("stream closed"); } }, 10);
    return a;
  };
  const readPinnedForTest = (p: string): string[] => {
    try { return JSON.parse(readFileSync(p, "utf-8")) as string[]; } catch { return []; }
  };
  const waitFor2 = async (fn: () => boolean, ms = 3000, every = 25): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await wait(every); }
    return fn();
  };

  // a) 创建两个托管会话：A 正常 init；B 不 init（无 relay_session_id 的恢复拒绝路径）
  mgr.setAgentFactory(makeFakeFactory());
  const createA = send("COMMAND_CREATE", { cwd: process.cwd(), prompt: "#49 置顶会话 A" });
  const ackA = await waitAck(createA);
  assert(ackA.ok === true && typeof ackA.session_id === "string", "46a 托管会话 A 创建（工厂缝，无真 CLI）");
  const sidA = ackA.session_id!;
  assert(await waitFor2(() => events.some((e) => e.type === "SESSION_UPDATED" && e.session_id === sidA && typeof (e.payload as { relay_session_id?: string }).relay_session_id === "string")), "46a onInit 落 relay_session_id（SESSION_UPDATED 可见）");
  const sdkA = mgr.snapshot().find((s) => s.session_id === sidA)!.relay_session_id!;
  assert(!!sdkA, "46a relay_session_id 已登记");

  initMode = "noinit";
  const createB = send("COMMAND_CREATE", { cwd: process.cwd(), prompt: "#49 置顶会话 B" });
  const ackB = await waitAck(createB);
  assert(ackB.ok === true && typeof ackB.session_id === "string", "46b 托管会话 B 创建（不 init 形态）");
  const sidB = ackB.session_id!;
  initMode = "init";

  // b) pin 往返：on → 写穿文件 + 事件带 pinned；off → 文件移除 + 事件带 pinned:false
  assert((await waitAck(send("COMMAND_PIN_SESSION", { session_id: sidA, pinned: true }))).ok, "46b pin A ack ok");
  assert(
    (() => { try { return (JSON.parse(readFileSync(PIN_FILE, "utf-8")) as string[]).includes(sidA); } catch { return false; } })(),
    "46b pinned-sessions.json 写穿含 A",
  );
  assert(events.some((e) => e.type === "SESSION_UPDATED" && e.session_id === sidA && (e.payload as { pinned?: boolean }).pinned === true), "46b SESSION_UPDATED 带 pinned:true");
  // SNAPSHOT 带 pinned（新客户端全量路径）
  {
    const snapWs = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
    const snap = (await new Promise<Record<string, unknown>>((resolve) => snapWs.once("message", (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>))));
    snapWs.close();
    const sessions = (snap.payload as { sessions?: { session_id: string; pinned?: boolean }[] }).sessions ?? [];
    assert(snap.type === "SNAPSHOT" && sessions.find((s) => s.session_id === sidA)?.pinned === true, "46b SNAPSHOT 会话携带 pinned");
  }
  assert((await waitAck(send("COMMAND_PIN_SESSION", { session_id: sidA, pinned: false }))).ok, "46b unpin A ack ok");
  assert(
    (() => { try { return !(JSON.parse(readFileSync(PIN_FILE, "utf-8")) as string[]).includes(sidA); } catch { return true; } })(),
    "46b unpin 后文件移除 A",
  );
  assert(events.some((e) => e.type === "SESSION_UPDATED" && e.session_id === sidA && (e.payload as { pinned?: boolean }).pinned === false), "46b SESSION_UPDATED 带 pinned:false");
  // 外部会话 pin → 拒绝
  assert((await waitAck(send("COMMAND_PIN_SESSION", { session_id: extId("cli-1"), pinned: true }))).ok === false, "46b 外部会话 pin 被拒");

  // c) 重启休眠登记：新 mgr（同 dataDir）收养历史 → applyPinned 只标 saved 不拉起
  assert((await waitAck(send("COMMAND_PIN_SESSION", { session_id: sidA, pinned: true }))).ok, "46c 重新 pin A（供重启模拟）");
  assert((await waitAck(send("COMMAND_PIN_SESSION", { session_id: sidB, pinned: true }))).ok, "46c pin B（无 sdk id 形态）");
  const replayedFor = (source: SessionManager): Map<string, { state: SessionState; logs: LogEntry[] }> => {
    const m = new Map<string, { state: SessionState; logs: LogEntry[] }>();
    for (const st of source.snapshot()) m.set(st.session_id, { state: JSON.parse(JSON.stringify(st)) as SessionState, logs: [] });
    return m;
  };
  // 先污染一个失联条目：applyPinned 应清理
  writeFileSync(PIN_FILE, JSON.stringify([...readPinnedForTest(PIN_FILE), "ghost-session-id"]));
  const bus2 = new EventBus();
  const mgr2 = new SessionManager(bus2, cfg);
  let created2 = 0;
  mgr2.setAgentFactory((cwd, model, cb, prompt, opts) => { created2++; return makeFakeFactory()(cwd, model, cb, prompt, opts); });
  mgr2.adopt(replayedFor(mgr));
  const applied = mgr2.applyPinned();
  assert(applied.saved === 2, "46c applyPinned 休眠登记 2 个置顶会话（不拉起）");
  assert(created2 === 0, "46c 重启登记零 SDK 拉起（工厂未被调用）");
  const stA2 = mgr2.snapshot().find((s) => s.session_id === sidA)!;
  assert(stA2.pinned === true && stA2.saved === true, "46c 休眠卡 pinned+saved");
  assert(stA2.status === "DONE" && stA2.done_reason === "已保存（重启休眠）", "46c 休眠状态 DONE/已保存");
  assert(stA2.historical === true, "46c 休眠卡保留 historical（旧端仅可查看语义）");
  assert(
    (() => { try { return !(JSON.parse(readFileSync(PIN_FILE, "utf-8")) as string[]).includes("ghost-session-id"); } catch { return true; } })(),
    "46c 失联条目（无会话）从清单清理",
  );

  // d) 按需恢复：RESUME A → resume 原 sdk id、不注入消息、saved/historical 清除
  const ackResume = mgr2.handleCommand({ command_id: "resume-a1", type: "COMMAND_RESUME_SESSION", payload: { session_id: sidA }, ts: Date.now() }, "test") as CommandAckPayload;
  assert(ackResume.ok === true, "46d COMMAND_RESUME_SESSION 受理");
  assert(created[created.length - 1].resume === sdkA, "46d resume 引用原 SDK 会话 id");
  assert(created[created.length - 1].prompt === undefined, "46d 恢复不注入用户消息（parked）");
  assert(await waitFor2(() => {
    const st = mgr2.snapshot().find((s) => s.session_id === sidA);
    return st?.status === "DONE" && st?.saved === undefined && !st?.historical;
  }), "46d init 后 saved/historical 清除、停在等待输入（DONE）");
  // 已在线幂等：再 RESUME 不新建 agent
  const before2 = created2;
  assert((mgr2.handleCommand({ command_id: "resume-a2", type: "COMMAND_RESUME_SESSION", payload: { session_id: sidA }, ts: Date.now() }, "test") as CommandAckPayload).ok === true, "46d 在线会话 RESUME 幂等 ok");
  assert(created2 === before2, "46d 幂等 RESUME 不重复拉起");

  // e) 无 SDK 记录的休眠卡：RESUME 同步拒绝（ack error）
  const ackResumeB = mgr2.handleCommand({ command_id: "resume-b1", type: "COMMAND_RESUME_SESSION", payload: { session_id: sidB }, ts: Date.now() }, "test") as CommandAckPayload;
  assert(ackResumeB.ok === false && (ackResumeB.error ?? "").includes("无 SDK 会话记录"), "46e 无 relay_session_id 的休眠卡恢复被拒（可读错误）");

  // f) 恢复失败（流 pre-init 关闭）→ ERROR「恢复失败」+ saved 保留 → 换好工厂重试成功
  const bus3 = new EventBus();
  const mgr3 = new SessionManager(bus3, cfg);
  let factory3 = "die";
  mgr3.setAgentFactory((cwd, model, cb, prompt, opts) => { const f = makeFakeFactory(); initMode = factory3 as "init" | "noinit" | "die"; const a = f(cwd, model, cb, prompt, opts); initMode = "init"; return a; });
  mgr3.adopt(replayedFor(mgr));
  mgr3.applyPinned();
  assert((mgr3.handleCommand({ command_id: "resume-a3", type: "COMMAND_RESUME_SESSION", payload: { session_id: sidA }, ts: Date.now() }, "test") as CommandAckPayload).ok === true, "46f 恢复命令受理（异步成败走事件）");
  assert(await waitFor2(() => {
    const st = mgr3.snapshot().find((s) => s.session_id === sidA);
    return st?.status === "ERROR" && (st?.last_error ?? "").startsWith("恢复失败") && st?.saved === true;
  }), "46f init 前流关闭 → ERROR 恢复失败 + saved 保留（可重试）");
  factory3 = "init";
  assert((mgr3.handleCommand({ command_id: "resume-a4", type: "COMMAND_RESUME_SESSION", payload: { session_id: sidA }, ts: Date.now() }, "test") as CommandAckPayload).ok === true, "46f 重试受理");
  assert(await waitFor2(() => {
    const st = mgr3.snapshot().find((s) => s.session_id === sidA);
    return st?.status === "DONE" && st?.saved === undefined;
  }), "46f 重试恢复成功");

  // g) 休眠态 unpin：saved 摘除 + 文件移除
  assert((mgr3.handleCommand({ command_id: "unpin-a", type: "COMMAND_PIN_SESSION", payload: { session_id: sidA, pinned: false }, ts: Date.now() }, "test") as CommandAckPayload).ok === true, "46g 休眠态 unpin ack ok");
  assert(mgr3.snapshot().find((s) => s.session_id === sidA)?.saved === undefined, "46g unpin 摘除 saved（卡片回普通历史态）");

  // h) 删除置顶会话联动清单（先等 B 的假回合完成 → DONE 才可删）
  assert((await waitAck(send("COMMAND_PIN_SESSION", { session_id: sidB, pinned: true }))).ok, "46h 重 pin B（走 mgr）");
  assert(await waitFor2(() => mgr.snapshot().find((s) => s.session_id === sidB)?.status === "DONE"), "46h B 假回合完成（DONE 可删除）");
  assert((await waitAck(send("COMMAND_DELETE", { session_id: sidB }))).ok, "46h 删除 B");
  assert(
    (() => { try { return !(JSON.parse(readFileSync(PIN_FILE, "utf-8")) as string[]).includes(sidB); } catch { return true; } })(),
    "46h 删除置顶会话同步摘除清单",
  );

  mgr.setAgentFactory(null);
  rmSync(PIN_FILE, { force: true });
}

// 47. #52 插入问答通知全端化：/api/notify mode=confirm → [待确认] todo 照旧 + USER_NOTE 瞬态事件
{
  const r = await fetch(`${http}/api/notify?token=${cfg.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "confirm", session_id: extId("cli-1"), text: "#52 通知通路测试" }),
  });
  assert(r.ok, "47 notify confirm 200");
  const note = events.find((e) => e.type === "USER_NOTE") as Envelope<"USER_NOTE", { text?: string; ts?: number }> | undefined;
  assert(!!note, "47 USER_NOTE 事件下发（ws 客户端实时收到）");
  assert(note!.payload.text === "#52 通知通路测试" && typeof note!.payload.ts === "number", "47 USER_NOTE payload {text, ts}");
  assert(note!.seq === 0, "47 USER_NOTE 为瞬态（seq:0，不占总线序号）");
  // 既有行为不回归：[待确认] todo 仍注入目标会话
  assert(
    events.some((e) => e.type === "SESSION_UPDATED" && e.session_id === extId("cli-1") && (e.payload as { todos?: { content?: string }[] }).todos?.some((t) => t.content === "[待确认] #52 通知通路测试")),
    "47 [待确认] todo 照旧注入目标会话",
  );
}

// 48. #50 compact 换代归档：CLI /compact 开新 session_id（进程不变）→ 同 cli_pid
//     新 ext 会话出现时旧身立即归档（DONE+historical+系统日志），不再双显示
//（2026-09-11 用户实测：「CC-watch-ba」+「0.4.3 memory 恢复点接力」同进程两条）
{
  const oldId = extId("cli-9");
  const newId = extId("cli-9b");
  await hook({ event: "UserPromptSubmit", prompt: "旧世代会话", session_id: "cli-9", cli_pid: 999001 });
  await wait(150);
  assert(!!mgr.getExternal(oldId), "48 old-gen session established");
  await hook({ event: "UserPromptSubmit", prompt: "压缩后新世代", session_id: "cli-9b", cli_pid: 999001 });
  await wait(200);
  const old = mgr.getExternal(oldId);
  assert(old?.status === "DONE" && old?.historical === true, "48 old-gen archived (DONE + historical)");
  const cur = mgr.getExternal(newId);
  assert(!!cur && cur.historical !== true && cur.cli_pid === 999001, "48 new-gen active with pid");
  await hook({ event: "SessionEnd", session_id: "cli-9b", reason: "clear" });
  await hook({ event: "SessionEnd", session_id: "cli-9", reason: "clear" });
}

wsCur!.close();
await wait(300);
console.log("\nBRIDGE TESTS PASSED");
process.exit(0);
