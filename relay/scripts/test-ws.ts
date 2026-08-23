import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import type { Command, CommandAckPayload, Envelope } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface TestClient {
  ws: WebSocket;
  events: Envelope[];
  acks: CommandAckPayload[];
  opened: Promise<void>;
  closed: Promise<void>;
}

function connect(url: string): TestClient {
  const ws = new WebSocket(url);
  const c: TestClient = {
    ws,
    events: [],
    acks: [],
    opened: new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    }),
    closed: new Promise((res) => ws.once("close", res)),
  };
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Envelope | (CommandAckPayload & { type: string });
    if ((msg as { type?: string }).type === "COMMAND_ACK") c.acks.push(msg as CommandAckPayload);
    else c.events.push(msg as Envelope);
  });
  return c;
}

function send(c: TestClient, partial: Omit<Command, "command_id" | "ts">): string {
  const command_id = randomUUID();
  c.ws.send(JSON.stringify({ ...partial, command_id, ts: Date.now() }));
  return command_id;
}

// ---- 启动被测服务（独立端口，避免与 dev server 冲突） ----
process.env.CCR_PORT = "8799";
process.env.CCR_TOKEN = "test-token-123";
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
startServer(bus, mgr, cfg);
await wait(300);

const base = `ws://127.0.0.1:${cfg.port}/ws`;

// 0. 服务真的在监听（防止连接拒绝被误判为鉴权通过）
const health = await fetch(`http://127.0.0.1:${cfg.port}/health`);
assert(health.ok, `server listening (health ${health.status})`);

// 1. 错误 token → 连接被拒（401）
let rejected = false;
try {
  const bad = connect(`${base}?token=WRONG`);
  await bad.opened;
  await bad.closed; // 若意外连上也应很快被关
  rejected = true; // 连接后立即关闭也算通过（这里 open 就不该成功）
} catch {
  rejected = true;
}
assert(rejected, "wrong token rejected");

// 2. 正确 token 连接 → 收到 SNAPSHOT（当前无会话）
const c1 = connect(`${base}?token=${cfg.token}`);
await c1.opened;
await wait(300);
assert(c1.events.length === 1 && c1.events[0].type === "SNAPSHOT", "fresh client gets SNAPSHOT");
assert(
  (c1.events[0].payload as { sessions: unknown[] }).sessions.length === 0,
  "snapshot empty initially",
);

// 3. 创建一个真实会话（纯文本快速完成）
const createId = send(c1, {
  type: "COMMAND_CREATE",
  payload: { cwd: process.cwd(), prompt: "请直接回复两个字：收到。禁止使用任何工具。" },
});
let sessionId = "";
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  const ack = c1.acks.find((a) => a.command_id === createId);
  if (ack?.session_id) sessionId = ack.session_id;
  const done = c1.events.find(
    (e) => e.session_id === sessionId && e.type === "SESSION_DONE",
  );
  if (done) break;
  await wait(500);
}
assert(sessionId !== "", "COMMAND_CREATE acked with session_id");
assert(
  c1.events.some((e) => e.session_id === sessionId && e.type === "SESSION_CREATED"),
  "c1 saw SESSION_CREATED live",
);
assert(
  c1.events.some((e) => e.session_id === sessionId && e.type === "SESSION_DONE"),
  "c1 saw SESSION_DONE live",
);
const lastSeq = c1.events[c1.events.length - 1].seq;
assert(lastSeq >= 3, `seq progressed (last=${lastSeq})`);

// 4. 重连补发：第二个客户端带 last_seq=1 → 只收 seq>1，连续无丢失
const c2 = connect(`${base}?token=${cfg.token}&last_seq=1`);
await c2.opened;
await wait(500);
assert(!c2.events.some((e) => e.seq <= 1), "replayed events all seq>1");
const seqs = c2.events.map((e) => e.seq).sort((a, b) => a - b);
assert(
  seqs.length > 0 && seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1),
  `replay contiguous from 2 to ${seqs[seqs.length - 1] ?? "?"}`,
);
assert(
  c2.events.some((e) => e.type === "SESSION_DONE" && e.session_id === sessionId),
  "replay contains missed SESSION_DONE",
);

// 5. 幂等：同 command_id 重发 → ack duplicate
const dupId = randomUUID();
c1.ws.send(JSON.stringify({ type: "COMMAND_MESSAGE", command_id: dupId, ts: Date.now(), payload: { session_id: sessionId, text: "x" } }));
c1.ws.send(JSON.stringify({ type: "COMMAND_MESSAGE", command_id: dupId, ts: Date.now(), payload: { session_id: sessionId, text: "x" } }));
await wait(500);
const dupAcks = c1.acks.filter((a) => a.command_id === dupId);
assert(dupAcks.length === 2, "both duplicate sends acked");
assert(
  dupAcks.filter((a) => a.ok).length === 1 || dupAcks.some((a) => a.error?.startsWith("duplicate")),
  "duplicate deduped (second ack marked)",
);

// 6. 非法消息 → 错误 ack 且连接不掉
c1.ws.send("not json");
c1.ws.send(JSON.stringify({ type: "COMMAND_UNKNOWN", command_id: randomUUID(), ts: 1, payload: {} }));
await wait(300);
assert(c1.ws.readyState === WebSocket.OPEN, "connection survives invalid messages");
assert(
  c1.acks.some((a) => a.ok === false),
  "invalid message got error ack",
);

// 清理：STOP 会话 + 关闭
send(c1, { type: "COMMAND_STOP", payload: { session_id: sessionId } });
await wait(2000);
c1.ws.close();
c2.ws.close();
await wait(500);

console.log("\nWS TESTS PASSED");
process.exit(0);
