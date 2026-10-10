// FB14 气泡附图 relay 数据腿专项测试：managed 回显槽消费 / external 晋升随行 /
// COMMAND_ARTIFACT_FETCH img 引用分支（归属校验+穿越拒绝）/ SNAPSHOT 引用透传。
// harness 装配与 test-bridge.ts 同款（in-process mgr+bridge，端口/数据目录全隔离）
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import { resolveUploadImage, imageRefsOf } from "../src/uploads.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { Command, CommandAckPayload, Envelope, LogEntry } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

process.env.CCR_PORT = "8799";
process.env.CCR_TOKEN = "fb14-token";
process.env.CCR_BRIDGE_TOKEN = "fb14-bridge";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_LEADER = "1";
process.env.CCR_DEAD_SWEEP = "0";
process.env.CCR_NO_TERM_LINE = "1";
const TDATA = fileURLToPath(new URL("../data/test-fb14-datadir/", import.meta.url));
process.env.CCR_DATA_DIR = TDATA;
rmSync(TDATA, { recursive: true, force: true });
const TORG = fileURLToPath(new URL("../data/test-fb14-orgdir/", import.meta.url));
process.env.CCR_ORG_DIR = TORG;
rmSync(TORG, { recursive: true, force: true });
const CCFG = fileURLToPath(new URL("../data/test-fb14-claude-cfg/", import.meta.url));
rmSync(CCFG, { recursive: true, force: true });
process.env.CLAUDE_CONFIG_DIR = CCFG;

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const { bridge } = startServer(bus, mgr, cfg, { gateToolsRaw: "" });
await wait(300);

const http = `http://127.0.0.1:${cfg.port}`;
const TMPIMG = join(cfg.dataDir, "..", "tmp");

// 最小合法 PNG（魔数嗅探判 .png）与 JPEG 头样本
const PNG_B64 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000d4944415478da63fccf00f60300030301003b9d40e20000000049454e44ae426082",
  "hex",
).toString("base64");
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const JPG_B64 = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex").toString("base64");

// WS 客户端
const events: Envelope[] = [];
const acks: CommandAckPayload[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
ws.on("message", (d) => {
  const m = JSON.parse(String(d)) as Envelope | (CommandAckPayload & { type: string });
  if ((m as { type: string }).type === "COMMAND_ACK") acks.push(m as CommandAckPayload);
  else events.push(m as Envelope);
});
await new Promise((r) => ws.once("open", r));
await wait(200);

let sock: WebSocket = ws; // 当前命令出口（② 后换 ws2——原 socket 已关）
function send(type: Command["type"], payload: unknown): string {
  const id = randomUUID();
  sock.send(JSON.stringify({ command_id: id, type, payload, ts: Date.now() }));
  return id;
}
async function waitAck(id: string): Promise<CommandAckPayload> {
  for (let i = 0; i < 30; i++) {
    const a = acks.find((x) => x.command_id === id);
    if (a) return a;
    await wait(100);
  }
  throw new Error("ack timeout");
}
const waitFor = async (fn: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await wait(50);
  return fn();
};
const logsOf = (sid: string, kind?: string): LogEntry[] =>
  events
    .filter((e) => e.type === "SESSION_LOG" && e.session_id === sid && (!kind || (e.payload as LogEntry).kind === kind))
    .map((e) => e.payload as LogEntry);

// 回显型 fake agent：sendMessage 同步发 user_message echo（模拟 agent-adapter 真实
// 行为——这正是 refs 槽位消费链的驱动方；test-bridge 的静默 fake 驱不动它）
let factoryCalls = 0;
mgr.setAgentFactory((cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
  factoryCalls++;
  const a: AgentLike = {
    id: randomUUID(),
    startedAt: Date.now(),
    ended: false,
    sendMessage: (text: string, images?: string[]) => {
      const marker = images && images.length > 0 ? `（+${images.length} 图）` : "";
      cb.onLog("user_message", String(text).slice(0, 200) + marker, { full: String(text) + marker });
      setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 10); }, 20);
    },
    allow: () => false,
    deny: () => false,
    answer: () => false,
    stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
    setPermissionMode: async () => {},
  };
  setTimeout(() => {
    if (a.ended) return;
    cb.onInit("sdk-fb14-" + a.id.slice(0, 8), model, "default");
    if (prompt !== undefined) setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 10); }, 10);
  }, 20);
  return a;
});

// ---------- ① managed 发送腿：回显 LogEntry 随行 refs ----------
const createAck = await waitAck(send("COMMAND_CREATE", { cwd: process.cwd(), prompt: "FB14 managed" }));
assert(createAck.ok === true && typeof createAck.session_id === "string", "1 managed session created");
const sidA = createAck.session_id!;
await waitFor(() => (mgr.snapshot().find((s) => s.session_id === sidA)?.relay_session_id ?? "") !== "");

rmSync(TMPIMG, { recursive: true, force: true });
const ackImg = await waitAck(send("COMMAND_MESSAGE", { session_id: sidA, text: "看这两张图", images: [PNG_B64, JPG_B64] }));
assert(ackImg.ok === true, "1 COMMAND_MESSAGE with images acked");
assert(await waitFor(() => logsOf(sidA, "user_message").some((e) => (e.text ?? "").startsWith("看这两张图"))), "1 user_message echo logged");
const um = logsOf(sidA, "user_message").find((e) => (e.text ?? "").startsWith("看这两张图"))!;
assert(Array.isArray(um.images) && um.images.length === 2, "1 echo LogEntry carries images refs (2)");
const refs = um.images!;
assert(refs.every((r) => /^img-[a-z0-9]{1,8}-\d{13}-[12]\.(png|jpg)$/i.test(r)), `1 refs are bare img-* basenames (${refs.join(",")})`);
assert(!refs.some((r) => r.includes("/")), "1 refs contain no path separators");
const saved = readdirSync(TMPIMG).filter((f) => f.startsWith("img-"));
assert(saved.length === 2, "1 two images saved to shared tmp");
assert(refs.every((r) => saved.includes(r)), "1 refs match saved files");

// 发图后第二条纯文本：槽位已消费，不串图
const ackTxt = await waitAck(send("COMMAND_MESSAGE", { session_id: sidA, text: "纯文本跟进" }));
assert(ackTxt.ok === true, "1 follow-up text ok");
assert(await waitFor(() => logsOf(sidA, "user_message").some((e) => (e.text ?? "").startsWith("纯文本跟进"))), "1 follow-up echo logged");
const um2 = logsOf(sidA, "user_message").find((e) => (e.text ?? "").startsWith("纯文本跟进"))!;
assert(um2.images === undefined, "1 text-only echo carries no images (slot consumed, no bleed)");

// ---------- ② SNAPSHOT：logs 里的 user_message 带引用（快照体积恒小） ----------
ws.close();
await wait(200);
let snapLogs: LogEntry[] = [];
const ws2 = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
ws2.on("message", (d) => {
  const m = JSON.parse(String(d)) as Envelope;
  if (m.type === "SNAPSHOT") {
    const logs = (m.payload as { logs?: Record<string, LogEntry[]> }).logs ?? {};
    snapLogs = logs[sidA] ?? [];
  }
});
await new Promise((r) => ws2.once("open", r));
assert(await waitFor(() => snapLogs.length > 0), "2 snapshot logs received");
const snapUm = snapLogs.find((e) => e.kind === "user_message" && (e.text ?? "").startsWith("看这两张图"));
assert(!!snapUm && Array.isArray(snapUm.images) && snapUm.images.length === 2, "2 snapshot user_message carries refs");

// ---------- ③ COMMAND_ARTIFACT_FETCH img 引用分支 ----------
sock = ws2;
const chunkAcks: CommandAckPayload[] = [];
const chunks: { ref: string; seq?: number; total?: number; b64?: string; done?: boolean }[] = [];
ws2.on("message", (d) => {
  const m = JSON.parse(String(d)) as { type: string; session_id?: string; payload?: Record<string, unknown> } & Partial<CommandAckPayload>;
  if (m.type === "COMMAND_ACK") { chunkAcks.push(m as CommandAckPayload); acks.push(m as CommandAckPayload); } // waitAck 双口共用
  else if (m.type === "ARTIFACT_CHUNK") chunks.push(m.payload as { ref: string; seq?: number; total?: number; b64?: string; done?: boolean });
  else events.push(m as unknown as Envelope); // ④ 段日志断言共用 events（ws1 已关）
});
const fetchId = send("COMMAND_ARTIFACT_FETCH", { session_id: sidA, path: refs[0] });
let ack3: CommandAckPayload | undefined;
for (let i = 0; i < 30 && !ack3; i++) { await wait(100); ack3 = chunkAcks.find((x) => x.command_id === fetchId); }
assert(ack3?.ok === true, "3 img-ref fetch acked");
assert(await waitFor(() => chunks.some((c) => c.ref === fetchId && c.done === true)), "3 chunk stream done frame");
const b64join = chunks.filter((c) => c.ref === fetchId && typeof c.b64 === "string").sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0)).map((c) => c.b64).join("");
assert(Buffer.compare(Buffer.from(b64join, "base64"), PNG_BYTES) === 0, "3 assembled bytes identical to original png");

// 归属校验：把 ref 伪装成别的会话的图（sidKey 前缀不符）→ 拒
const ackForeign = await waitAck(send("COMMAND_ARTIFACT_FETCH", { session_id: "ext-zzz9zz9z-aaaa-bbbb-cccc-ddddeeeeffff", path: refs[0] }));
assert(ackForeign.ok === false, "3 foreign-session img ref rejected");
// 穿越/乱形态 → 拒
for (const bad of ["../secret.png", "img-../etc-passwd-123-1.png", "not-an-img.jpg", "file-x-123-1.txt"]) {
  const a = await waitAck(send("COMMAND_ARTIFACT_FETCH", { session_id: sidA, path: bad }));
  assert(a.ok === false, `3 malformed ref rejected: ${bad}`);
}
// 不存在（已清扫形态合法但无文件）→ 拒（幂等错误文案）
const ghost = "img-" + sidA.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() + "-1111111111111-1.png";
const ackGhost = await waitAck(send("COMMAND_ARTIFACT_FETCH", { session_id: sidA, path: ghost }));
assert(ackGhost.ok === false, "3 missing file (legal shape) rejected");

// resolveUploadImage 单元口径
assert(resolveUploadImage(TDATA, sidA, refs[0]) !== null, "3 unit: valid ref resolves");
assert(resolveUploadImage(TDATA, "ext-other", refs[0]) === null, "3 unit: cross-session ref null");
assert(resolveUploadImage(TDATA, sidA, "../../etc/passwd") === null, "3 unit: traversal null");
assert(imageRefsOf([]).length === 0, "3 unit: imageRefsOf empty");

// ---------- ④ external 腿：extInput 落盘 → 晋升随行 refs ----------
const extSid = "ext-cli-fb14";
mgr.ensureExternal(extSid, "/tmp", "fb14 ext", "cli-fb14");
mgr.setExternalCliPid(extSid, process.pid);
mgr.setExternalStatus(extSid, "WORKING", "测试中");
const rExt = bridge.extInput(extSid, "带图的外部消息", [PNG_B64]);
assert(rExt.ok === true, "4 extInput with image ok");
const pend = mgr.getExternal(extSid)?.pending_inputs?.at(-1);
assert(!!pend && Array.isArray(pend.refs) && pend.refs.length === 1, "4 pending entry carries refs");
// 晋升：UPS hook 以注入全文提交 → promote 写 user_message 随行
const ups = await fetch(`${http}/bridge/hook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-bridge-token": cfg.bridgeToken },
  body: JSON.stringify({ session_id: "cli-fb14", cwd: "/tmp", cli_pid: process.pid, event: "UserPromptSubmit", prompt: pend!.body ?? pend!.text }),
});
assert(ups.ok, "4 UPS hook posted");
assert(await waitFor(() => logsOf(extSid, "user_message").some((e) => (e.text ?? "").includes("带图的外部消息"))), "4 promoted user_message logged");
const umExt = logsOf(extSid, "user_message").find((e) => (e.text ?? "").includes("带图的外部消息"))!;
assert(Array.isArray(umExt.images) && umExt.images.length === 1 && umExt.images[0] === pend!.refs?.[0], "4 promoted LogEntry carries same ref");

// ---------- ⑤ FB4 建团腿：COMMAND_ORG_ACTION create + 随团 headcount ----------
const anchor5 = join(TDATA, "team-anchor");
mkdirSync(anchor5, { recursive: true });
const ackNoAnchor = await waitAck(send("COMMAND_ORG_ACTION", { action: "create", name: "坏锚团队", anchor_dir: "relative/path", tier: "轻立项" }));
assert(ackNoAnchor.ok === false, "5 relative anchor rejected");
const ackBadSid = await waitAck(send("COMMAND_ORG_ACTION", { action: "create", name: "坏席团队", anchor_dir: anchor5, tier: "轻立项", headcount: [{ session_id: "sess-not-exist", role: "worker" }] }));
assert(ackBadSid.ok === false, "5 unknown-session headcount rejected");
const ackExtSid = await waitAck(send("COMMAND_ORG_ACTION", { action: "create", name: "外席团队", anchor_dir: anchor5, tier: "轻立项", headcount: [{ session_id: extSid, role: "worker" }] }));
assert(ackExtSid.ok === false, "5 external-session headcount rejected");
const ackTeam = await waitAck(send("COMMAND_ORG_ACTION", { action: "create", name: "FB14 测试团", anchor_dir: anchor5, tier: "轻立项", headcount: [{ session_id: sidA, role: "worker" }] }));
assert(ackTeam.ok === true, "5 team create with headcount acked");
const group5 = (ackTeam.data as { group?: { headcount?: { session_id: string; role: string }[] } })?.group;
assert(!!group5 && Array.isArray(group5.headcount) && group5.headcount.length === 1 && group5.headcount[0].session_id === sidA && group5.headcount[0].role === "worker", "5 group carries seeded headcount (sid+role)");
const ackDup = await waitAck(send("COMMAND_ORG_ACTION", { action: "create", name: "同锚团队", anchor_dir: anchor5, tier: "轻立项" }));
assert(ackDup.ok === false, "5 same-anchor second team rejected (one anchor one group)");

ws2.close();
console.log("FB14 all assertions passed");
process.exit(0);
