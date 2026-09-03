// 云桥端到端测试：真桥（cloud-bridge）+ CloudClient + 假手机（tweetnacl）。
// 覆盖：LAN 信道配对 → 云通道 hello/SNAPSHOT → 命令+ACK 密文往返 → 实时事件
// 加密下发 → 断线后 last_seq 补发 → 未配对设备静默拒收。
// data 目录隔离在临时目录，不污染 relay/data 的真实云身份。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startCloudServer } from "../../cloud-bridge/src/index.js";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { CloudClient } from "../src/cloud-client.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { createPairingCodes } from "../src/pairing.js";
import { devId, generateKeyPair, seal, unseal, type SealedBox } from "../src/e2e.js";
import type { CommandAckPayload, Envelope } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
    process.exitCode = 1;
  } else {
    console.log(`ok - ${msg}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(every);
  }
  return fn();
}

// ---------- 环境 ----------
const BRIDGE_PORT = 8797;
const BRIDGE_TOKEN = "cloud-token-123";
const dataDir = mkdtempSync(join(tmpdir(), "cc-cloud-test-"));
const oldCwd = process.cwd();
process.chdir(dataDir); // loadConfig 的 dataDir = cwd/data，隔离云身份文件
process.env.CCR_CLOUD_URL = `ws://127.0.0.1:${BRIDGE_PORT}/cloud`;
process.env.CCR_CLOUD_TOKEN = BRIDGE_TOKEN;
process.env.CCR_NO_TITLE_GEN = "1";

const bridge = startCloudServer(BRIDGE_PORT, BRIDGE_TOKEN);
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const identity = loadOrCreateIdentity(cfg.dataDir);
mgr.setCloud(identity);
const pairCodes = createPairingCodes();
const cloud = new CloudClient(bus, mgr, cfg, identity, pairCodes);
cloud.start();
await wait(300);

// ---------- 1) 配对（模拟手机经 LAN 发 COMMAND_PAIR_START） ----------
const phoneKp = generateKeyPair();
const phoneDev = devId(phoneKp.publicKey, "ph");
const pairAck = mgr.handleCommand(
  { command_id: "pair-1", type: "COMMAND_PAIR_START", payload: { pubkey: phoneKp.publicKey, name: "测试手机" }, ts: Date.now() },
  "web-test",
) as CommandAckPayload;
assert(pairAck.ok === true && !!pairAck.cloud, "PAIR_START 成功并携带 cloud 配置");
assert(pairAck.cloud?.relay_dev === identity.relayDev && pairAck.cloud?.relay_pubkey === identity.keypair.publicKey, "ACK 携带 relay 设备 id 与公钥");
assert(identity.peers.has(phoneDev), "手机公钥已登记到 peers");

// ---------- 2) 假手机连桥 + hello → SNAPSHOT ----------
const relayPubkey = pairAck.cloud!.relay_pubkey;
const phoneWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${phoneDev}`);
const inbox: Record<string, unknown>[] = [];
phoneWs.on("message", (raw) => {
  const f = JSON.parse(String(raw)) as { data?: SealedBox };
  if (f.data) {
    const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, phoneKp.secretKey);
    if (inner) inbox.push(inner);
  }
});
phoneWs.on("error", () => undefined);
await new Promise<void>((r) => phoneWs.on("open", r));

const sendSealed = (obj: unknown) =>
  phoneWs.send(JSON.stringify({ to: identity.relayDev, data: seal(obj, relayPubkey, phoneKp.secretKey) }));

sendSealed({ t: "hello", last_seq: 0 });
assert(
  await waitFor(() => inbox.some((m) => m.type === "SNAPSHOT")),
  "hello 后收到加密 SNAPSHOT",
);

// ---------- 3) 命令 + ACK 密文往返（错误路径：不存在的会话） ----------
sendSealed({ command_id: "cmd-1", type: "COMMAND_RENAME", payload: { session_id: "nope", title: "x" }, ts: Date.now() });
assert(
  await waitFor(() => {
    const ack = inbox.find((m) => m.type === "COMMAND_ACK" && m.command_id === "cmd-1") as unknown as CommandAckPayload | undefined;
    return !!ack && ack.ok === false && typeof ack.error === "string";
  }),
  "云通道命令往返收到加密 ACK（错误路径）",
);

// ---------- 4) 实时事件加密下发 ----------
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "cloud-test" });
assert(
  await waitFor(() => inbox.some((m) => m.type === "SESSION_LOG")),
  "实时事件经桥加密下发",
);

// ---------- 5) 断线 + last_seq 补发 ----------
const lastSeq = Math.max(...inbox.map((m) => Number(m.seq ?? 0)).filter((n) => n > 0));
phoneWs.close();
await wait(200);
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "offline-1" });
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "offline-2" });
await wait(200);

const inboxBefore = inbox.length;
const phoneWs2 = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${phoneDev}`);
const inbox2: Record<string, unknown>[] = [];
phoneWs2.on("message", (raw) => {
  const f = JSON.parse(String(raw)) as { data?: SealedBox };
  if (f.data) {
    const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, phoneKp.secretKey);
    if (inner) inbox2.push(inner);
  }
});
phoneWs2.on("error", () => undefined);
await new Promise<void>((r) => phoneWs2.on("open", r));
phoneWs2.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "hello", last_seq: lastSeq }, relayPubkey, phoneKp.secretKey) }));
assert(
  await waitFor(() => inbox2.filter((m) => m.type === "SESSION_LOG").length === 2),
  "重连按 last_seq 补发恰好 2 条（无 SNAPSHOT 重建）",
);
assert(
  !inbox2.some((m) => m.type === "SNAPSHOT"),
  "缓冲内 last_seq 不触发 SNAPSHOT",
);
{
  const seqs = inbox2.filter((m) => m.seq).map((m) => Number(m.seq));
  assert(seqs.length === 2 && seqs[0] === lastSeq + 1 && seqs[1] === lastSeq + 2, "补发 seq 连续无洞");
}

// ---------- 6) 未配对设备静默拒收 ----------
const rogueKp = generateKeyPair();
const rogueDev = devId(rogueKp.publicKey, "ph");
const rogueWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${rogueDev}`);
rogueWs.on("error", () => undefined);
await new Promise<void>((r) => rogueWs.on("open", r));
rogueWs.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "hello", last_seq: 0 }, relayPubkey, rogueKp.secretKey) }));
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "rogue-probe" });
let rogueGot = 0;
rogueWs.on("message", () => rogueGot++);
await wait(1200);
assert(rogueGot === 0, "未配对设备收不到任何下发");
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "rogue-probe")),
  "配对手机仍正常收到该事件",
);

// ---------- 7) 云侧单边断线自愈（relay ws 掉线重连，手机 ws 不动） ----------
// 场景：relay 重启/心跳超时只断 relay↔桥，手机 ws 存活不会再发 hello。
// 旧行为：active=false 后下行永久黑洞（上行/ACK/ping-pong 照常，极难察觉）。
const ccInternal = cloud as unknown as { ws: WebSocket | null };
ccInternal.ws!.close();
assert(
  await waitFor(() => ccInternal.ws !== null && ccInternal.ws.readyState === WebSocket.OPEN, 5000),
  "relay 侧重连桥成功",
);
await wait(300);
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "blackout-1" });
await wait(800);
assert(
  !inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "blackout-1"),
  "未 ping 恢复前下行黑洞（旧行为复现）",
);
const seqNow = Math.max(...inbox2.map((m) => Number(m.seq ?? 0)).filter((n) => n > 0));
phoneWs2.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "ping", last_seq: seqNow }, relayPubkey, phoneKp.secretKey) }));
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "blackout-1")),
  "ping 携带 last_seq 触发补发，黑洞自愈",
);
assert(
  await waitFor(() => inbox2.some((m) => m.t === "pong")),
  "ping 仍收到 pong（心跳语义不变）",
);
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "after-resume" });
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "after-resume")),
  "恢复后实时事件继续下发",
);

// 旧版 ping（无 last_seq）→ 全量 SNAPSHOT 恢复（当前线上 APK 兼容路径）
const ccWsBefore = ccInternal.ws;
ccInternal.ws!.close();
assert(
  await waitFor(() => ccInternal.ws !== null && ccInternal.ws !== ccWsBefore && ccInternal.ws.readyState === WebSocket.OPEN, 5000),
  "再次单边断线后 relay 重连",
);
const pongsBefore = inbox2.filter((m) => m.t === "pong").length;
phoneWs2.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "ping" }, relayPubkey, phoneKp.secretKey) }));
// inbox2 此前从未收到过 SNAPSHOT（hello/补发都在缓冲内），它出现即 resume 已完成
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SNAPSHOT")),
  "旧版无字段 ping 触发全量 SNAPSHOT 恢复",
);
assert(
  await waitFor(() => inbox2.filter((m) => m.t === "pong").length > pongsBefore),
  "旧版 ping 仍收到 pong",
);
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "legacy-ping-resume" });
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "legacy-ping-resume")),
  "SNAPSHOT 恢复后实时事件继续下发",
);

// ---------- 8) 全量恢复：瘦身 SNAPSHOT + SESSION_LOG 流式补发 ----------
// 线上事故：时间线日志涨大后全量 SNAPSHOT 密文超桥 1MB 帧上限，桥把 relay 连接
// 1009 踢掉 → 重连循环，手机列表永远为空。现改为 SNAPSHOT 只带会话状态、日志逐条流式。
phoneWs2.close();
const seedId = "ext-stream-test";
mgr.ensureExternal(seedId, "/tmp", "流式补发验证");
const SEED_N = 5;
for (let i = 1; i <= SEED_N; i++) mgr.pushExternalLog(seedId, "assistant_text", `stream-${i}`);

const phoneWs3 = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${phoneDev}`);
const inbox3: Record<string, unknown>[] = [];
let snapFrameLen = 0;
phoneWs3.on("message", (raw) => {
  const f = JSON.parse(String(raw)) as { data?: SealedBox };
  if (!f.data) return;
  const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, phoneKp.secretKey);
  if (!inner) return;
  if (inner.type === "SNAPSHOT") snapFrameLen = String(raw).length;
  inbox3.push(inner);
});
phoneWs3.on("error", () => undefined);
await new Promise<void>((r) => phoneWs3.on("open", r));
phoneWs3.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "hello", last_seq: 0 }, relayPubkey, phoneKp.secretKey) }));

const snap3 = (await waitFor(() => inbox3.some((m) => m.type === "SNAPSHOT")))
  ? (inbox3.find((m) => m.type === "SNAPSHOT") as unknown as { seq: number; payload: { sessions: { session_id: string }[]; logs?: Record<string, unknown[]> } })
  : undefined;
assert(!!snap3, "全量恢复收到 SNAPSHOT");
assert(Object.keys(snap3?.payload.logs ?? {}).length === 0, "SNAPSHOT 已瘦身（不带时间线日志）");
assert(!!snap3?.payload.sessions.some((s) => s.session_id === seedId), "SNAPSHOT 携带会话状态");
assert(
  await waitFor(() => inbox3.filter((m) => m.type === "SESSION_LOG" && m.session_id === seedId).length === SEED_N),
  "时间线以 SESSION_LOG 逐条流式补发",
);
{
  const texts = inbox3
    .filter((m) => m.type === "SESSION_LOG" && m.session_id === seedId)
    .map((m) => (m.payload as { text?: string }).text);
  assert(texts.join(",") === Array.from({ length: SEED_N }, (_, i) => `stream-${i + 1}`).join(","), "流式补发顺序正确");
  assert(snapFrameLen > 0 && snapFrameLen < 256 * 1024, "SNAPSHOT 单帧远低于 1MB 桥上限");
}

// 用流式帧统一过的 seq 重新 hello：bus 补发从该 seq 之后开始，不与已流式的旧日志重复
phoneWs3.close();
await wait(200);
const phoneWs4 = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${phoneDev}`);
const inbox4: Record<string, unknown>[] = [];
phoneWs4.on("message", (raw) => {
  const f = JSON.parse(String(raw)) as { data?: SealedBox };
  if (!f.data) return;
  const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, phoneKp.secretKey);
  if (inner) inbox4.push(inner);
});
phoneWs4.on("error", () => undefined);
await new Promise<void>((r) => phoneWs4.on("open", r));
phoneWs4.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "hello", last_seq: snap3!.seq }, relayPubkey, phoneKp.secretKey) }));
await wait(400);
phoneWs4.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "ping" }, relayPubkey, phoneKp.secretKey) }));
assert(
  await waitFor(() => inbox4.some((m) => m.t === "pong")),
  "重连 hello 已处理（pong 为证）",
);
assert(
  inbox4.filter((m) => m.type === "SESSION_LOG" && m.session_id === seedId).length === 0,
  "last_seq 补发不与流式补发的旧日志重复",
);

// ---------- 9) 网页端一次性配对码（pair_req → pair_ack → hello 可用） ----------
const webKp = generateKeyPair();
const webDev = devId(webKp.publicKey, "wb");
const { code: pairCode } = pairCodes.issue();

// 冒名测试会用同 dev 顶掉本连接（桥按 dev 顶号），所以 ws 可重建、收件箱累积
const webInbox: Record<string, unknown>[] = [];
let webWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${webDev}`);
const attachWeb = (ws: WebSocket) => {
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as { data?: SealedBox };
    if (!f.data) return;
    const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, webKp.secretKey);
    if (inner) webInbox.push(inner);
  });
  ws.on("error", () => undefined);
};
attachWeb(webWs);
await new Promise<void>((r) => webWs.on("open", r));
const webSend = (obj: unknown, plain = false) =>
  webWs.send(JSON.stringify(
    plain
      ? { to: identity.relayDev, data: obj }
      : { to: identity.relayDev, data: seal(obj, relayPubkey, webKp.secretKey) },
  ));

// 错码先来：回 pair_nack
webSend({ t: "pair_req", code: "000000", pubkey: webKp.publicKey, name: "web-test" }, true);
assert(
  await waitFor(() => webInbox.some((m) => m.t === "pair_nack")),
  "错配对码被拒（pair_nack）",
);
// 冒名 dev（连接冒用 webDev 但公钥派生不一致）：静默丢弃且不烧码
{
  const fakeKp = generateKeyPair();
  const rogue2 = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${webDev}`);
  rogue2.on("error", () => undefined);
  await new Promise<void>((r) => rogue2.on("open", r));
  rogue2.send(JSON.stringify({ to: identity.relayDev, data: { t: "pair_req", code: pairCode, pubkey: fakeKp.publicKey } }));
  await wait(400);
  assert(!identity.peers.has(webDev), "冒名 dev 未被登记");
  rogue2.close();
  // 真身连接已被顶号踢断，重建后继续配对
  await wait(100);
  webWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${webDev}`);
  attachWeb(webWs);
  await new Promise<void>((r) => webWs.on("open", r));
}
// 正码：pair_ack 携带 relay 身份，随后 hello 立即可用
webSend({ t: "pair_req", code: pairCode, pubkey: webKp.publicKey, name: "web-test" }, true);
assert(
  await waitFor(() => webInbox.some((m) => m.t === "pair_ack")),
  "正确配对码完成配对（pair_ack，冒名未烧码）",
);
assert(identity.peers.has(webDev), "web 设备已登记 peers");
{
  const ack = webInbox.find((m) => m.t === "pair_ack") as unknown as { relay_dev: string; relay_pubkey: string };
  assert(ack.relay_dev === identity.relayDev && ack.relay_pubkey === identity.keypair.publicKey, "pair_ack 携带 relay dev 与公钥");
}
// 码一次性：同码再用 → nack
webSend({ t: "pair_req", code: pairCode, pubkey: webKp.publicKey }, true);
assert(
  await waitFor(() => webInbox.filter((m) => m.t === "pair_nack").length === 2),
  "配对码一次性（重用被拒）",
);
webSend({ t: "hello", last_seq: 0 });
assert(
  await waitFor(() => webInbox.some((m) => m.type === "SNAPSHOT")),
  "配对后 web 端 hello 收到 SNAPSHOT",
);
webSend({ command_id: "web-cmd-1", type: "COMMAND_REFRESH_TODOS", payload: { session_id: seedId }, ts: Date.now() });
assert(
  await waitFor(() => webInbox.some((m) => m.type === "COMMAND_ACK" && m.command_id === "web-cmd-1")),
  "web 端命令密文往返收到 ACK",
);

// ---------- 清理 ----------
phoneWs4.close();
webWs.close();
rogueWs.close();
cloud.close();
await bridge.close();
process.chdir(oldCwd); // Windows 下 cwd 所在目录无法删除，先切回
rmSync(dataDir, { recursive: true, force: true });

if (failures === 0) console.log("RELAY CLOUD TESTS PASSED");
else {
  console.error(`${failures} failures`);
  process.exit(1);
}
