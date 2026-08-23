// 端到端冒烟：对运行中的 dev server (8787) 走完整浏览器等价流程
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { CommandAckPayload, Envelope, WaitingPayload } from "../src/types.js";

const token = process.argv[2];
if (!token) {
  console.error("用法: tsx scripts/smoke-e2e.ts <token>");
  process.exit(1);
}
const url = `ws://127.0.0.1:8787/ws?token=${token}`;
const events: Envelope[] = [];
let acks: CommandAckPayload[] = [];

const ws = new WebSocket(url);
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
ws.on("message", (d) => {
  const m = JSON.parse(String(d)) as Envelope | (CommandAckPayload & { type: string });
  if ((m as { type: string }).type === "COMMAND_ACK") acks.push(m as CommandAckPayload);
  else events.push(m as Envelope);
});
console.log("connected, got:", events[events.length - 1]?.type);

function send(type: string, payload: unknown) {
  ws.send(JSON.stringify({ command_id: randomUUID(), type, payload, ts: Date.now() }));
}

const tmp = join(process.cwd(), ".tmp-e2e");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

send("COMMAND_CREATE", {
  cwd: tmp,
  prompt: "请用 Bash 工具执行命令 echo e2e-ok > e2e-out.txt（在当前目录写文件），看到命令成功后直接结束。不要使用其他任何工具。",
});

const deadline = Date.now() + 120_000;
let allowed = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const waiting = events.find((e) => e.type === "SESSION_WAITING") as
    | Envelope<"SESSION_WAITING", WaitingPayload>
    | undefined;
  if (waiting && !allowed) {
    allowed = true;
    console.log(`WAITING: ${waiting.payload.tool_name} — ${waiting.payload.input_summary}`);
    send("COMMAND_CONTINUE", { session_id: waiting.session_id, request_id: waiting.payload.request_id });
  }
  const done = events.find((e) => e.type === "SESSION_DONE");
  if (done) {
    console.log("DONE:", JSON.stringify(done.payload));
    break;
  }
  const err = events.find((e) => e.type === "SESSION_ERROR");
  if (err) { console.log("ERROR:", JSON.stringify(err.payload)); process.exit(1); }
}

const sessionId = events.find((e) => e.type === "SESSION_CREATED")?.session_id;
const sawBash = events.some((e) => e.type === "SESSION_WAITING" && (e.payload as WaitingPayload).tool_name === "Bash");
const sawAllow = events.some((e) => e.type === "SESSION_WAITING_RESOLVED");
const sawEcho = events.some((e) => e.type === "SESSION_LOG" && String((e.payload as { text: string }).text).includes("e2e-ok"));

console.log("checks:", {
  sessionCreated: !!sessionId,
  waitingWasBash: sawBash,
  allowResolved: sawAllow,
  echoOutputSeen: sawEcho,
  allowed,
});

send("COMMAND_STOP", { session_id: sessionId });
await new Promise((r) => setTimeout(r, 2500));
ws.close();
await new Promise((r) => setTimeout(r, 500));
rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

const pass = sawBash && sawAllow && sawEcho;
console.log(pass ? "\nE2E SMOKE PASSED" : "\nE2E SMOKE INCOMPLETE (见上方 checks)");
process.exit(pass ? 0 : 1);
