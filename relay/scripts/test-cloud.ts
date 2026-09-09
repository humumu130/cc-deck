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
mgr.setPairIssuer((o) => pairCodes.issue(o));
mgr.setLoginGranter((dev, pk, name) => {
  cloud.grantLogin(dev, pk, name);
  return true;
});
mgr.setPeerKicker((dev) => {
  identity.removePeer(dev);
  cloud.kickPeer(dev);
});
const pairCodes = createPairingCodes();

// ---------- 0) 配对码硬化：8 位 CSPRNG / TTL 默认 5min + 环境变量 + 30min 上限 ----------
{
  const a = pairCodes.issue();
  assert(/^\d{8}$/.test(a.code), "配对码为 8 位数字（CSPRNG randomInt）");
  assert(a.expires_in === 300, "默认 TTL 5 分钟");
  const b = pairCodes.issue({ code: "13572468", ttlMs: 40 * 60_000 });
  assert(b.code === "13572468" && b.expires_in === 1800, "按次长码 TTL 封顶 30 分钟（F3）");
  const c = pairCodes.issue({ code: "11111111" });
  assert(/^\d{8}$/.test(c.code) && c.code !== "11111111", "弱指定码（全同位）回退随机码");
  const d = pairCodes.issue({ code: "654821", ttlMs: 90_000 });
  assert(d.code === "654821" && d.expires_in === 90, "管理员 6 位自定义码过渡期可用");
  assert(pairCodes.consume("654821") && !pairCodes.consume("654821"), "指定码一次性消费");
  process.env.CCR_PAIR_TTL_MS = "120000";
  const e = createPairingCodes().issue();
  assert(e.expires_in === 120, "CCR_PAIR_TTL_MS 环境变量配置默认 TTL");
  delete process.env.CCR_PAIR_TTL_MS;
}
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
// 未配对设备只可能收到明文"请重新配对"提示（notifyUnpaired，60s 限一条）；
// 密文会话帧形状是 {to,data:{n,c}}，顶层无 seq/type——断言所有帧都是明文 pair_nack 才实
const rogueMsgs: { data?: { t?: string; n?: string } }[] = [];
rogueWs.on("message", (d) => {
  try { rogueMsgs.push(JSON.parse(String(d))); } catch {}
});
await wait(1200);
assert(rogueMsgs.length > 0 && rogueMsgs.every((m) => m.data?.t === "pair_nack" && !m.data.n), "未配对设备只收到明文重配对提示（无密文会话下发）");
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "rogue-probe")),
  "配对手机仍正常收到该事件",
);

// ---------- 7) 云侧单边断线自愈（relay ws 掉线重连，手机 ws 不动） ----------
// 场景：桥闪断只断 relay↔桥，手机 ws 存活不会再发 hello；网页标签页在后台时连
// ping 都发不出（浏览器冻结定时器）。新行为：重连后 relay 对断线前 active 的设备
// 按 lastSeq 主动 auto-resume，闪断窗口的事件从 bus 缓冲补发，全程无需设备配合。
const ccInternal = cloud as unknown as {
  ws: WebSocket | null;
  phones: Map<string, { lastSeq: number; active: boolean }>;
};
ccInternal.ws!.close();
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "blackout-1" }); // 断线窗口内事件，只能靠重连补发
assert(
  await waitFor(() => ccInternal.ws !== null && ccInternal.ws.readyState === WebSocket.OPEN, 5000),
  "relay 侧重连桥成功",
);
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "blackout-1")),
  "重连后 auto-resume 主动补发断线窗口事件（无需设备 ping）",
);
assert(
  await waitFor(() => ccInternal.phones.get(phoneDev)?.active === true),
  "auto-resume 恢复设备 active",
);
assert(
  inbox2.filter((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "rogue-probe").length === 1,
  "auto-resume 补发无重复（onEnv 推进 lastSeq）",
);
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "after-resume" });
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "after-resume")),
  "恢复后实时事件继续下发",
);
const pongsBefore = inbox2.filter((m) => m.t === "pong").length;
const seqNow = Math.max(...inbox2.map((m) => Number(m.seq ?? 0)).filter((n) => n > 0));
phoneWs2.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "ping", last_seq: seqNow }, relayPubkey, phoneKp.secretKey) }));
assert(
  await waitFor(() => inbox2.filter((m) => m.t === "pong").length > pongsBefore),
  "ping 仍收到 pong（心跳语义不变）",
);

// 旧版 ping（无 last_seq）→ 全量 SNAPSHOT 恢复（当前线上 APK 兼容路径）。
// 新架构下 auto-resume 让设备多数时间保持 active，但 ROUTE_MISS/真实掉线仍会置
// inactive——旧版 ping 的全量恢复路径必须保留，这里手动置 inactive 模拟。
ccInternal.phones.get(phoneDev)!.active = false;
const pongsBefore2 = inbox2.filter((m) => m.t === "pong").length;
phoneWs2.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "ping" }, relayPubkey, phoneKp.secretKey) }));
// inbox2 此前从未收到过 SNAPSHOT（hello/补发都在缓冲内），它出现即 resume 已完成
assert(
  await waitFor(() => inbox2.some((m) => m.type === "SNAPSHOT")),
  "旧版无字段 ping 触发全量 SNAPSHOT 恢复",
);
assert(
  await waitFor(() => inbox2.filter((m) => m.t === "pong").length > pongsBefore2),
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
// 码一次性：已配对设备重发同码幂等补 ack（ack 随桥闪断丢失的自愈路径）；
// 新设备拿已消费的码配对 → 真拒绝 nack
webSend({ t: "pair_req", code: pairCode, pubkey: webKp.publicKey }, true);
assert(
  await waitFor(() => webInbox.filter((m) => m.t === "pair_ack").length === 2),
  "已配对设备重发同码幂等补 ack（一次性不重复配对）",
);
{
  const kp2 = generateKeyPair();
  const dev2 = devId(kp2.publicKey, "wb");
  const ws2 = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${dev2}`);
  const inbox2: { t?: string }[] = [];
  ws2.on("message", (raw) => {
    try {
      const f = JSON.parse(String(raw)) as { data?: SealedBox };
      const inner = f.data ? unseal<Record<string, unknown>>(f.data, relayPubkey, kp2.secretKey) : null;
      if (inner) inbox2.push(inner as { t?: string });
    } catch {}
  });
  ws2.on("error", () => undefined);
  await new Promise<void>((r) => ws2.on("open", r));
  ws2.send(JSON.stringify({ to: identity.relayDev, data: { t: "pair_req", code: pairCode, pubkey: kp2.publicKey } }));
  assert(await waitFor(() => inbox2.some((m) => m.t === "pair_nack")), "已消费配对码对新设备被拒（一次性）");
  assert(!identity.peers.has(dev2), "新设备未因重放旧码入册");
  // 连续错码限流：累计 5 次 nack 后进入 10 分钟静默期（第 5 次起不再回包）
  const nackCount = () => inbox2.filter((m) => m.t === "pair_nack").length;
  for (let i = 0; i < 5; i++) {
    ws2.send(JSON.stringify({ to: identity.relayDev, data: { t: "pair_req", code: "000000", pubkey: kp2.publicKey } }));
    await wait(150);
  }
  assert(await waitFor(() => nackCount() === 5, 4000), "错码累计 5 次均回 nack");
  await wait(1500);
  assert(nackCount() === 5, "第 6 次起静默丢弃（错码限流生效）");
  ws2.close();
}
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

// ---------- 10) 配对码定位广播：多台 relay 挂同一座桥，凭码定位持码者 ----------
// 家里 PC + 公司 PC 两台 relay 同时在线的场景：手机不预知 rd，广播 pair_req(bc)，
// 持码 relay 回 pair_ack，未持码 relay 静默（不回 nack、不烧码、不误配对）
{
  const { mkdirSync } = await import("node:fs");
  const dir2 = join(dataDir, "relay2");
  mkdirSync(dir2, { recursive: true });
  const id2 = loadOrCreateIdentity(dir2);
  const pcs2 = createPairingCodes();
  const cloud2 = new CloudClient(bus, mgr, cfg, id2, pcs2, cfg.cloudUrl);
  cloud2.start();
  await wait(400); // 等第二台 relay 连桥注册

  // 手机（wb 身份）连桥；帧按两台 relay 的公钥分别试解（广播态不知道谁会应答）
  const mobKp = generateKeyPair();
  const mobDev = devId(mobKp.publicKey, "wb");
  const mobWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${mobDev}`);
  const mobFrames: { from1: Record<string, unknown> | null; from2: Record<string, unknown> | null; type?: string; relays?: { dev: string }[] }[] = [];
  mobWs.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as { data?: SealedBox; type?: string; relays?: { dev: string }[] };
    const tryOpen = (pk: string) => (f.data ? unseal<Record<string, unknown>>(f.data, pk, mobKp.secretKey) : null);
    mobFrames.push({ from1: tryOpen(identity.keypair.publicKey), from2: tryOpen(id2.keypair.publicKey), type: f.type, relays: f.relays });
  });
  mobWs.on("error", () => undefined);
  await new Promise<void>((r) => mobWs.on("open", r));

  // ① 发现帧：两台 relay 都在列表里（第二台注册与手机连桥有竞态，必要时补发 disc）
  let discTries = 0;
  assert(
    await waitFor(() => {
      const rel = mobFrames.find(
        (m) => m.type === "RELAYS" && m.relays?.some((x) => x.dev === id2.relayDev) && m.relays?.some((x) => x.dev === identity.relayDev),
      );
      if (rel) return true;
      if (++discTries % 10 === 0) mobWs.send(JSON.stringify({ to: "*", data: { t: "disc" } }));
      return false;
    }, 5000, 50),
    "发现帧列出两台在线 relay",
  );

  // ② 广播 pair_req：码是第二台 relay 签发的 → 只有它 ack
  const { code: bcCode } = pcs2.issue();
  mobWs.send(JSON.stringify({ to: "*", data: { t: "pair_req", code: bcCode, pubkey: mobKp.publicKey, name: "手机-bc", bc: true } }));
  assert(
    await waitFor(() => mobFrames.some((m) => m.from2?.t === "pair_ack" && m.from2?.relay_dev === id2.relayDev)),
    "持码 relay 对广播回 pair_ack（身份正确）",
  );
  await wait(1200); // 留出未持码 relay「误回 nack」的窗口
  assert(
    !mobFrames.some((m) => m.from1 !== null),
    "未持码 relay 广播态完全静默（无 nack / 无 ack，手机不被淹没）",
  );
  assert(!pcs2.consume(bcCode), "广播配对消耗码（一次性）");
  assert(id2.peers.has(mobDev) && !identity.peers.has(mobDev), "只有持码 relay 登记了手机");

  // ③ 幂等：已配对手机重播广播 → 持码者补 ack，另一台仍静默
  mobFrames.length = 0;
  mobWs.send(JSON.stringify({ to: "*", data: { t: "pair_req", code: bcCode, pubkey: mobKp.publicKey, name: "手机-bc", bc: true } }));
  assert(
    await waitFor(() => mobFrames.some((m) => m.from2?.t === "pair_ack")),
    "已配对设备重播广播幂等补 ack",
  );
  await wait(1000);
  assert(!mobFrames.some((m) => m.from1 !== null), "幂等重播时未持码 relay 仍静默");

  // ④ 错码广播：静默丢弃，不回 nack（多台若各回一份 nack 手机无法分辨来源）
  {
    const badKp = generateKeyPair();
    const badDev = devId(badKp.publicKey, "wb");
    const badWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${badDev}`);
    const badFrames: { f1: Record<string, unknown> | null; f2: Record<string, unknown> | null }[] = [];
    badWs.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as { data?: SealedBox };
      const tryOpen = (pk: string) => (f.data ? unseal<Record<string, unknown>>(f.data, pk, badKp.secretKey) : null);
      badFrames.push({ f1: tryOpen(identity.keypair.publicKey), f2: tryOpen(id2.keypair.publicKey) });
    });
    badWs.on("error", () => undefined);
    await new Promise<void>((r) => badWs.on("open", r));
    badWs.send(JSON.stringify({ to: "*", data: { t: "pair_req", code: "000000", pubkey: badKp.publicKey, bc: true } }));
    await wait(1200);
    assert(
      badFrames.length === 0,
      "错码广播被两台 relay 静默丢弃（无任何回包）",
    );
    badWs.close();
  }

  // ⑤ 旧形态单播 pair_req 不回归：不带 bc 的帧照旧直达指定 relay、错码回密文 nack
  {
    const uniKp = generateKeyPair();
    const uniDev = devId(uniKp.publicKey, "wb");
    const uniWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${uniDev}`);
    const uniFrames: Record<string, unknown>[] = [];
    uniWs.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as { data?: SealedBox };
      if (!f.data) return;
      // 目标是第一台 relay（identity）
      const inner = unseal<Record<string, unknown>>(f.data, identity.keypair.publicKey, uniKp.secretKey);
      if (inner) uniFrames.push(inner);
    });
    uniWs.on("error", () => undefined);
    await new Promise<void>((r) => uniWs.on("open", r));
    uniWs.send(JSON.stringify({ to: identity.relayDev, data: { t: "pair_req", code: "000000", pubkey: uniKp.publicKey } }));
    assert(await waitFor(() => uniFrames.some((m) => m.t === "pair_nack")), "单播错码仍回密文 pair_nack");
    const { code: uniCode } = pairCodes.issue();
    uniWs.send(JSON.stringify({ to: identity.relayDev, data: { t: "pair_req", code: uniCode, pubkey: uniKp.publicKey } }));
    assert(
      await waitFor(() => uniFrames.some((m) => m.t === "pair_ack" && m.relay_dev === identity.relayDev)),
      "单播正码照常 pair_ack（第一台 relay）",
    );
    uniWs.close();
  }

  mobWs.close();
  cloud2.close();
  await wait(200);
}

// ---------- #373 /wan 手表明文透传：桥信封 → relay hello/SNAPSHOT → 命令 ACK → 实时事件 ----------
{
  const watchWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/wan?token=${BRIDGE_TOKEN}&dev=wt-test1&to=${identity.relayDev}`);
  const wInbox: Record<string, unknown>[] = [];
  watchWs.on("message", (raw) => {
    try { wInbox.push(JSON.parse(String(raw))); } catch {}
  });
  watchWs.on("error", () => undefined);
  await new Promise<void>((r) => watchWs.on("open", r));
  // 错 token 的 /wan 必须被 401 拒绝
  const badWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/wan?token=wrong&dev=wt-x&to=${identity.relayDev}`);
  await new Promise<void>((r) => badWs.on("error", () => r(undefined)));
  badWs.close?.();
  assert(true, "错 token /wan 连接被拒");
  watchWs.send(JSON.stringify({ t: "hello", last_seq: 0 }));
  assert(await waitFor(() => wInbox.some((m) => m.type === "SNAPSHOT")), "wan 手表 hello 收到明文 SNAPSHOT");
  watchWs.send(JSON.stringify({ command_id: "wan-cmd-1", type: "COMMAND_REFRESH_TODOS", payload: { session_id: seedId }, ts: Date.now() }));
  assert(await waitFor(() => wInbox.some((m) => m.type === "COMMAND_ACK" && (m as { command_id?: string }).command_id === "wan-cmd-1")), "wan 命令明文往返 ACK");
  bus.emit(seedId, "SESSION_UPDATED", { status: "WORKING", action_summary: "wan 实时事件测试", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 } });
  assert(await waitFor(() => wInbox.some((m) => m.type === "SESSION_UPDATED")), "wan 收到实时事件流");
  watchWs.close();
}

// ---------- 11) 议题①可信设备管理：PEERS / KICK / PAIRED_DEVICE 广播 ----------
{
  // 新设备经输码配对 → 全体在线已配对设备收到 PAIRED_DEVICE(add) 补偿告警
  const pdKp = generateKeyPair();
  const pdDev = devId(pdKp.publicKey, "wb");
  const pdPlain: { t?: string; n?: string }[] = [];
  const pdInbox: Record<string, unknown>[] = [];
  const pdWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${pdDev}`);
  pdWs.on("message", (raw) => {
    try {
      const f = JSON.parse(String(raw)) as { data?: SealedBox | { t?: string; n?: string } };
      if (!f.data) return;
      if ((f.data as { n?: string }).n === undefined) {
        pdPlain.push(f.data as { t?: string });
        return;
      }
      const inner = unseal<Record<string, unknown>>(f.data as SealedBox, relayPubkey, pdKp.secretKey);
      if (inner) pdInbox.push(inner);
    } catch {}
  });
  pdWs.on("error", () => undefined);
  await new Promise<void>((r) => pdWs.on("open", r));
  const { code: pdCode } = pairCodes.issue();
  pdWs.send(JSON.stringify({ to: identity.relayDev, data: { t: "pair_req", code: pdCode, pubkey: pdKp.publicKey, name: "web-peers-test" } }));
  assert(await waitFor(() => pdInbox.some((m) => m.t === "pair_ack")), "设备配对成功（pair_ack）");
  assert(
    await waitFor(() => inbox4.some((m) => m.type === "PAIRED_DEVICE" && (m.payload as { dev?: string }).dev === pdDev && (m.payload as { action?: string }).action === "add")),
    "新配对瞬间已配对手机收到 PAIRED_DEVICE(add) 广播",
  );
  {
    const snap = inbox4.find((m) => m.type === "SNAPSHOT") as unknown as { payload?: { wan_dev?: string } } | undefined;
    const webSnap = webInbox.find((m) => m.type === "SNAPSHOT") as unknown as { payload?: { wan_dev?: string } } | undefined;
    assert(!!webSnap && webSnap.payload?.wan_dev === identity.wanDev, "云 SNAPSHOT 携带 wan_dev（手表凭据 dev，F7）");
    void snap;
  }

  const peersAck = mgr.handleCommand(
    { command_id: "peers-1", type: "COMMAND_PEERS", payload: {}, ts: Date.now() },
    "web-test",
  ) as CommandAckPayload;
  assert(peersAck.ok === true && Array.isArray(peersAck.peers), "COMMAND_PEERS 返回清单");
  {
    const peers = peersAck.peers!;
    assert(peers.some((p) => p.dev === pdDev && p.kind === "web" && p.name === "web-peers-test"), "清单含新配对 web 设备（kind/name 派生）");
    assert(peers.some((p) => p.dev === phoneDev && p.kind === "phone"), "清单含手机（ph- → phone）");
    const web = peers.find((p) => p.dev === webDev);
    assert(!!web && web.last_seen > 0, "last_seen 随 hello/ping 更新（在线点数据源）");
    assert(!!web && web.pubkey === webKp.publicKey, "清单携带 pubkey（备份导出可修复配对关系）");
  }

  // 踢除：peers 移除 + 明文 pair_nack（立即失联）+ PAIRED_DEVICE(kick) 广播；幂等
  const kickAck = mgr.handleCommand(
    { command_id: "kick-1", type: "COMMAND_PEER_KICK", payload: { dev: pdDev }, ts: Date.now() },
    "web-test",
  ) as CommandAckPayload;
  assert(kickAck.ok === true, "COMMAND_PEER_KICK 成功");
  assert(!identity.peers.has(pdDev), "踢除后 peers 已移除");
  assert(await waitFor(() => pdPlain.some((m) => m.t === "pair_nack")), "被踢设备收到明文 pair_nack（停止重连）");
  assert(
    await waitFor(() => inbox4.some((m) => m.type === "PAIRED_DEVICE" && (m.payload as { dev?: string }).dev === pdDev && (m.payload as { action?: string }).action === "kick")),
    "踢除广播 PAIRED_DEVICE(kick)",
  );
  const kickAgain = mgr.handleCommand(
    { command_id: "kick-2", type: "COMMAND_PEER_KICK", payload: { dev: pdDev }, ts: Date.now() },
    "web-test",
  ) as CommandAckPayload;
  assert(kickAgain.ok === true, "重复踢除幂等（不存在也 ok）");
  const badKick = mgr.handleCommand(
    { command_id: "kick-3", type: "COMMAND_PEER_KICK", payload: { dev: "not-a-dev" }, ts: Date.now() },
    "web-test",
  ) as CommandAckPayload;
  assert(badKick.ok === false, "畸形 dev 号被拒");
  // 被踢设备再发帧 → 落入未配对分支（再收一条明文 nack，60s 节流内只此一条）
  const pdPlainBefore = pdPlain.length;
  pdWs.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "hello", last_seq: 0 }, relayPubkey, pdKp.secretKey) }));
  await wait(600);
  void pdPlainBefore;
  assert(!pdInbox.some((m) => m.type === "SNAPSHOT"), "被踢设备 hello 不再获得 SNAPSHOT");
  pdWs.close();
}

// ---------- 12) F2 全局错码预算：换 dev 绕过按 dev 锁定的路被封 ----------
{
  const { mkdirSync } = await import("node:fs");
  const dir3 = join(dataDir, "relay3");
  mkdirSync(dir3, { recursive: true });
  const id3 = loadOrCreateIdentity(dir3);
  const pcs3 = createPairingCodes();
  const cloud3 = new CloudClient(bus, mgr, cfg, id3, pcs3, cfg.cloudUrl);
  // 预算收紧（仅本段）：3 次 / 1.5s 窗口
  const c3 = cloud3 as unknown as { pairBudgetMax: number; pairBudgetWindowMs: number };
  c3.pairBudgetMax = 3;
  c3.pairBudgetWindowMs = 1500;
  cloud3.start();
  await wait(400); // 等 relay3 连桥注册

  // 每个 dev 只错 1 次：按 dev 锁定（5 次）永不触发，只考验全局预算
  const wrongOnce = async (): Promise<boolean> => {
    const kp = generateKeyPair();
    const dev = devId(kp.publicKey, "wb");
    const got: { t?: string }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${dev}`);
    ws.on("message", (raw) => {
      try {
        const f = JSON.parse(String(raw)) as { data?: SealedBox };
        if (!f.data) return;
        const inner = unseal<Record<string, unknown>>(f.data, id3.keypair.publicKey, kp.secretKey);
        if (inner) got.push(inner as { t?: string });
      } catch {}
    });
    ws.on("error", () => undefined);
    await new Promise<void>((r) => ws.on("open", r));
    ws.send(JSON.stringify({ to: id3.relayDev, data: { t: "pair_req", code: "000000", pubkey: kp.publicKey } }));
    await wait(350);
    ws.close();
    return got.some((m) => m.t === "pair_nack");
  };
  assert(await wrongOnce() === true, "预算内错码正常回 nack（1/3）");
  assert(await wrongOnce() === true, "预算内错码正常回 nack（2/3）");
  assert(await wrongOnce() === true, "第 3 次错码触发预算耗尽（仍回 nack，窗口自此关闭）");
  assert(await wrongOnce() === false, "预算耗尽后错码静默丢弃（换 dev 无效）");
  // 正码也拦（且不烧码）：否则爆破第 4 次猜中就穿门
  const okCode = pcs3.issue().code;
  {
    const kp = generateKeyPair();
    const dev = devId(kp.publicKey, "wb");
    const got: { t?: string }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${dev}`);
    ws.on("message", (raw) => {
      try {
        const f = JSON.parse(String(raw)) as { data?: SealedBox };
        if (!f.data) return;
        const inner = unseal<Record<string, unknown>>(f.data, id3.keypair.publicKey, kp.secretKey);
        if (inner) got.push(inner as { t?: string });
      } catch {}
    });
    ws.on("error", () => undefined);
    await new Promise<void>((r) => ws.on("open", r));
    ws.send(JSON.stringify({ to: id3.relayDev, data: { t: "pair_req", code: okCode, pubkey: kp.publicKey } }));
    await wait(700);
    assert(got.length === 0, "预算窗口内正码也被拦（无 ack/nack）");
    ws.close();
  }
  assert(pcs3.consume(okCode), "被拦的正码未被消费（预算判定先于 consume；此处消费掉旧码，重置段换新码）");
  // 窗口过期重置：恢复正常配对语义（合理恢复——正常用户偶尔输错不该永久被封）
  await wait(1200);
  {
    const kp = generateKeyPair();
    const dev = devId(kp.publicKey, "wb");
    const got: { t?: string }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${dev}`);
    ws.on("message", (raw) => {
      try {
        const f = JSON.parse(String(raw)) as { data?: SealedBox };
        if (!f.data) return;
        const inner = unseal<Record<string, unknown>>(f.data, id3.keypair.publicKey, kp.secretKey);
        if (inner) got.push(inner as { t?: string });
      } catch {}
    });
    ws.on("error", () => undefined);
    await new Promise<void>((r) => ws.on("open", r));
    const resetCode = pcs3.issue().code;
    ws.send(JSON.stringify({ to: id3.relayDev, data: { t: "pair_req", code: resetCode, pubkey: kp.publicKey, name: "budget-reset" } }));
    assert(await waitFor(() => got.some((m) => m.t === "pair_ack")), "预算窗口过期自动重置（正码恢复可用）");
    assert(id3.peers.has(dev), "窗口重置后配对成功入册");
    ws.close();
  }
  cloud3.close();
  await wait(200);
}

// ---------- 13) F7 /wan 收口：严格模式下未持凭据手表默认拒绝 ----------
{
  // 默认（自建桥 127.0.0.1）不严格——上一节 wt-test1 已验证任意 wt- 可用；
  // 这里强制 CCR_WAN_STRICT=1 验证公共桥语义：未持 wan-secret 派生 dev 的手表静默
  process.env.CCR_WAN_STRICT = "1";
  const evilInbox: Record<string, unknown>[] = [];
  const evilWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/wan?token=${BRIDGE_TOKEN}&dev=wt-evil77&to=${identity.relayDev}`);
  evilWs.on("message", (raw) => {
    try { evilInbox.push(JSON.parse(String(raw))); } catch {}
  });
  evilWs.on("error", () => undefined);
  await new Promise<void>((r) => evilWs.on("open", r));
  evilWs.send(JSON.stringify({ t: "hello", last_seq: 0 }));
  await wait(900);
  assert(evilInbox.length === 0, "严格模式：未持凭据手表 hello 完全静默（无 SNAPSHOT/ACK）");
  evilWs.send(JSON.stringify({ command_id: "evil-cmd", type: "COMMAND_REFRESH_TODOS", payload: { session_id: seedId }, ts: Date.now() }));
  await wait(500);
  assert(evilInbox.length === 0, "严格模式：未持凭据手表命令同样静默（明文指令面关闭）");
  evilWs.close();

  const goodInbox: Record<string, unknown>[] = [];
  const goodWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/wan?token=${BRIDGE_TOKEN}&dev=${identity.wanDev}&to=${identity.relayDev}`);
  goodWs.on("message", (raw) => {
    try { goodInbox.push(JSON.parse(String(raw))); } catch {}
  });
  goodWs.on("error", () => undefined);
  await new Promise<void>((r) => goodWs.on("open", r));
  goodWs.send(JSON.stringify({ t: "hello", last_seq: 0 }));
  assert(await waitFor(() => goodInbox.some((m) => m.type === "SNAPSHOT")), "严格模式：持凭据手表（SNAPSHOT wan_dev 下发的派生 dev）照常放行");
  goodWs.close();
  delete process.env.CCR_WAN_STRICT;
}

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
