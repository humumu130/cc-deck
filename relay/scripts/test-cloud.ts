// 云桥端到端测试：真桥（cloud-bridge）+ CloudClient + 假手机（tweetnacl）。
// 覆盖：LAN 信道配对 → 云通道 hello/SNAPSHOT → 命令+ACK 密文往返 → 实时事件
// 加密下发 → 断线后 last_seq 补发 → 未配对设备静默拒收。
// data 目录隔离在临时目录，不污染 relay/data 的真实云身份。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

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
// 0.4.4 跨网回传接线（对齐 index.ts：pusher 交给云层按 phones/sighting 判定投递）
mgr.setImportPusher((dev, pk, payload) => cloud.pushImportTo(dev, pk, payload));
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
const bare2: { type?: string; rd?: string }[] = []; // 桥直发裸帧（#34 relay-online 广播等）
phoneWs2.on("message", (raw) => {
  const f = JSON.parse(String(raw)) as { data?: SealedBox; type?: string; rd?: string };
  if (f.type) bare2.push(f);
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

// ---------- 7.5) #34 relay 上线广播唤醒 ----------
// relay 重连桥（register rl-*）→ 在线手机收到桥直发 {type:"relay-online", rd}——
// App 待唤醒态（桥通 relay 离线，不再盲目断连重试）靠此帧在同连接补发 hello 恢复。
// 幂等 register（同 dev 同 connId 重挂，DO 每请求/poll touch 形态）不重播。
assert(
  await waitFor(() => bare2.some((f) => f.type === "relay-online" && f.rd === identity.relayDev)),
  "relay 重连桥时手机收到 relay-online 广播（rd 匹配）",
);
{
  // 第 7 段 relay 重连只发生一次，此刻广播帧恰有一条；幂等重挂不再播
  const cnt = () => bare2.filter((f) => f.type === "relay-online" && f.rd === identity.relayDev).length;
  assert(cnt() === 1, "relay-online 恰好广播一次（重连一次性）");
  // 幂等/顶替语义用假 relay dev 直捣 router（不经适配器）：不碰真 relay 连接，
  // 后续段（8+）依赖它在桥上
  const routerInternal = bridge.router as unknown as {
    register: (connId: string, dev: string, rk?: string) => void;
  };
  const fakeCnt = () => bare2.filter((f) => f.type === "relay-online" && f.rd === "rl-fake-34").length;
  routerInternal.register("fake-34-a", "rl-fake-34");
  assert(
    await waitFor(() => fakeCnt() >= 1, 2000),
    "另一台 relay 上线也广播（新 dev 首连）",
  );
  const fakeBase = fakeCnt();
  routerInternal.register("fake-34-a", "rl-fake-34"); // 同 connId 幂等（DO 每请求重挂/poll touch 形态）
  await wait(200);
  assert(fakeCnt() === fakeBase, "幂等 register（同 connId）不重复广播");
  routerInternal.register("fake-34-b", "rl-fake-34"); // 顶替式重连（新 connId 同 dev）
  assert(
    await waitFor(() => fakeCnt() > fakeBase, 2000),
    "顶替式重连（新 connId）再次广播",
  );
}

// ---------- 8) 全量恢复：预算内单帧 SNAPSHOT（#408 大帧根治） ----------
// 线上事故：① 全量 SNAPSHOT 日志内联，密文超 1MB 帧上限（桥 1009 踢线 / CF
// Workers ws 单帧硬限）→ 重连循环；② 瘦身改逐条密文流式后，历史涨到数千条又成
// 洪峰触发 CF 桥限流踢线 → 重连 → auto-resume 再补 → 自喂养断连死循环。现改为
// SNAPSHOT 单帧携带预算内日志（每会话最近 50 条 + 全帧日志 ≤512KB，与 LAN 的
// ws-server 同一构建）：无流式洪峰、单帧确定性有界。
phoneWs2.close();
// 播种前把手机置 inactive：播种的 1500 条 live 事件经 onEnv 灌进旧 dev 连接的管道，
// 同 dev 换线（ws3 注册顶替 ws2）后未排空的尾巴帧会改道投给新连接，污染下方
// "无流式补发"断言（生产语义无害：live 事件本就该送达该 dev 的当前连接）
ccInternal.phones.get(phoneDev)!.active = false;
const seedId = "ext-stream-test";
mgr.ensureExternal(seedId, "/tmp", "流式补发验证");
for (let i = 1; i <= 5; i++) mgr.pushExternalLog(seedId, "assistant_text", `stream-${i}`);
// 构造 >1MiB 场景：每会话 500 条（内存上限）× ~4KB 文本 × 3 会话 ≈ 6MB 原始日志，
// 50 条 K 帽后仍 ≈ 600KB > 512KB 预算——K 帽与字节预算两道裁剪都被触发
const bigIds = ["ext-snap-big1", "ext-snap-big2", "ext-snap-big3"];
const PAD = "x".repeat(4000);
for (const sid of bigIds) {
  mgr.ensureExternal(sid, "/tmp", `大帧验证 ${sid}`);
  for (let i = 1; i <= 500; i++) mgr.pushExternalLog(sid, "assistant_text", `log-${i} ${PAD}`);
}

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
  ? (inbox3.find((m) => m.type === "SNAPSHOT") as unknown as {
      seq: number;
      payload: {
        sessions: { session_id: string }[];
        logs?: Record<string, { text?: string }[]>;
        logs_truncated?: Record<string, number>;
      };
    })
  : undefined;
assert(!!snap3, "全量恢复收到 SNAPSHOT");
assert(!!snap3?.payload.sessions.some((s) => s.session_id === seedId), "SNAPSHOT 携带会话状态");
{
  const pl = snap3!.payload;
  // 单帧有界：原始桥帧（信封 + 密文 base64 ~4/3 膨胀）< 900KB（CF 1MiB 硬限留余量）
  assert(snapFrameLen > 0 && snapFrameLen < 900 * 1024, "SNAPSHOT 单帧 < 900KB（1MiB 硬限余量，修复前该场景单帧 >6MB）");
  // 日志随帧携带：客户端按 payload.logs 重建时间线（原始内联语义回归，旧 APK 天然兼容）
  assert(Object.keys(pl.logs ?? {}).length > 0, "SNAPSHOT 携带预算内时间线日志");
  for (const sid of bigIds) {
    const arr = pl.logs?.[sid] ?? [];
    assert(arr.length > 0 && arr.length <= 50, `${sid} 日志 ≤ 50 条（K 帽生效）`);
    assert((pl.logs_truncated ?? {})[sid] >= 450, `${sid} logs_truncated 标记省略条数（≥450）`);
    assert(String(arr[arr.length - 1]?.text ?? "").startsWith("log-500"), `${sid} 保留最新后缀（截断语义：丢旧留新）`);
  }
  // 预算生效：全帧日志 JSON 总量 ≤ 512KB（K 帽后 ~600KB，预算二道裁剪压回）
  assert(Buffer.byteLength(JSON.stringify(pl.logs ?? {})) <= 512 * 1024 + 1024, "日志总量在 512KB 预算内");
  // 洪峰根除：全量恢复不再有逐条 SESSION_LOG 流式补发
  assert(!inbox3.some((m) => m.type === "SESSION_LOG"), "无逐条 SESSION_LOG 流式补发（断连死循环根因拔除）");
}

// 用快照 seq 重新 hello：bus 补发从该 seq 之后开始，不会与快照内联的旧日志重复
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
  "last_seq 补发不与快照内联的旧日志重复",
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

// ---------- 14) #42 设备身份元数据：pair_req meta 自报 → 入册 / PEERS 回显 / 截断 / 兼容 ----------
{
  // 配对一个小工具：带/不带 meta 的 pair_req，返回 dev（配对成功断言内置）
  const pairWithMeta = async (
    meta: Record<string, unknown> | undefined,
    label: string,
  ): Promise<string> => {
    const kp = generateKeyPair();
    const dv = devId(kp.publicKey, "wb");
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${dv}`);
    const got: { t?: string }[] = [];
    ws.on("message", (raw) => {
      try {
        const f = JSON.parse(String(raw)) as { data?: SealedBox };
        if (!f.data) return;
        const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, kp.secretKey);
        if (inner) got.push(inner as { t?: string });
      } catch {}
    });
    ws.on("error", () => undefined);
    await new Promise<void>((r) => ws.on("open", r));
    const { code } = pairCodes.issue();
    const req: Record<string, unknown> = { t: "pair_req", code, pubkey: kp.publicKey, name: "手机-meta" };
    if (meta !== undefined) req.meta = meta;
    ws.send(JSON.stringify({ to: identity.relayDev, data: req }));
    assert(await waitFor(() => got.some((m) => m.t === "pair_ack")), `pair_req 配对成功（${label}）`);
    ws.close();
    return dv;
  };

  // ① 新客户端带 meta：四字段齐全入库
  const metaDev = await pairWithMeta(
    { name: "cc.example.com", platform: "android·Pixel 8", app: "CC Deck 0.3.35", ua: "" },
    "带 meta",
  );
  // ② 脏 meta：ua 超长（300 字符）截到 120；platform 非字符串、app 纯空白 → 丢弃
  const truncDev = await pairWithMeta(
    { ua: "x".repeat(300), platform: 123, app: "   " },
    "超长/非字符串 meta",
  );
  // ③ 旧客户端不带 meta：照常配对，条目无 meta
  const plainDev = await pairWithMeta(undefined, "无 meta（旧客户端）");

  const peersAck = mgr.handleCommand(
    { command_id: "peers-meta-1", type: "COMMAND_PEERS", payload: {}, ts: Date.now() },
    "web-test",
  ) as CommandAckPayload;
  assert(peersAck.ok === true && Array.isArray(peersAck.peers), "COMMAND_PEERS 返回清单（meta 场景）");
  {
    const peers = peersAck.peers!;
    const m = peers.find((p) => p.dev === metaDev);
    assert(
      !!m && m.meta?.name === "cc.example.com" && m.meta?.platform === "android·Pixel 8" && m.meta?.app === "CC Deck 0.3.35" && m.meta?.ua === undefined,
      "meta 随 PEERS 回显（name/platform/app 入库，空白 ua 丢弃）",
    );
    const t = peers.find((p) => p.dev === truncDev);
    assert(
      !!t && t.meta?.ua?.length === 120 && t.meta?.platform === undefined && t.meta?.app === undefined,
      "超长 ua 截到 120 字符，非字符串/空白字段丢弃",
    );
    const p = peers.find((x) => x.dev === plainDev);
    assert(!!p && p.meta === undefined, "无 meta 的旧客户端照常配对（meta 缺省）");
  }

  // 写穿落盘：addPeer 持久化进 cloud-peers.json（重启后 meta 仍在）
  {
    const { readFileSync } = await import("node:fs");
    const disk = JSON.parse(readFileSync(identity.peersPath, "utf-8")) as Record<
      string,
      { meta?: { platform?: string; app?: string } }
    >;
    assert(disk[metaDev]?.meta?.platform === "android·Pixel 8", "meta 随 addPeer 写穿落盘（cloud-peers.json）");
  }

  // 存量文件兼容：无 meta 的 cloud-peers.json 照常加载（读取旧格式不炸、meta 缺省）
  {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir4 = join(dataDir, "relay4");
    mkdirSync(dir4, { recursive: true });
    const oldPk = generateKeyPair().publicKey;
    writeFileSync(
      join(dir4, "cloud-peers.json"),
      JSON.stringify({ "wb-0123456789abcdef": { pubkey: oldPk, name: "旧设备", paired_at: 1 } }),
    );
    const id4 = loadOrCreateIdentity(dir4);
    const e4 = id4.peers.get("wb-0123456789abcdef");
    assert(!!e4 && e4.name === "旧设备" && e4.meta === undefined, "存量 cloud-peers.json 无 meta 照常加载（读取兼容）");
  }
}

// ---------- 21) #49 置顶会话经云通道：pin 实时帧 + SNAPSHOT 携带 pinned ----------
// ---------- 22) #52 USER_NOTE 瞬态事件：云通道实时直播 + 重连不补发 ----------
{
  // 假 agent 工厂（测试缝）：托管会话免拉真 CLI；20ms 后回 init 模拟 CLI ready
  mgr.setAgentFactory((_cwd: string, model: string, cb: AgentCallbacks, _prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; },
      setPermissionMode: async () => {},
    };
    setTimeout(() => { if (!a.ended) cb.onInit("sdk-cloud-" + a.id.slice(0, 8), model, "default"); }, 10);
    return a;
  });
  const createAck = mgr.handleCommand(
    { command_id: "pin-create-1", type: "COMMAND_CREATE", payload: { cwd: dataDir, prompt: "#49 云通道置顶测试" }, ts: Date.now() },
    "cloud-test",
  ) as CommandAckPayload;
  assert(createAck.ok === true && typeof createAck.session_id === "string", "21 托管会话创建（工厂缝，无真 CLI）");
  const sid = createAck.session_id!;
  assert(
    await waitFor(() => typeof mgr.snapshot().find((s) => s.session_id === sid)?.relay_session_id === "string"),
    "21 onInit 落 relay_session_id",
  );
  const pinAck = mgr.handleCommand(
    { command_id: "pin-1", type: "COMMAND_PIN_SESSION", payload: { session_id: sid, pinned: true }, ts: Date.now() },
    "cloud-test",
  ) as CommandAckPayload;
  assert(pinAck.ok === true, "21 COMMAND_PIN_SESSION 受理（云侧与 LAN 同一 handleCommand）");
  // 手机（inbox4，已 hello active）实时收到 pinned 帧
  assert(
    await waitFor(() => inbox4.some((m) => m.type === "SESSION_UPDATED" && m.session_id === sid && (m.payload as { pinned?: boolean }).pinned === true)),
    "21 云通道实时收到 pinned:true SESSION_UPDATED",
  );

  // #52 USER_NOTE：瞬态事件经云通道实时下发到在线手机（seq:0 不回拨 lastSeq）
  inbox4.length = 0;
  bus.emitTransient("USER_NOTE", { text: "#52 云通道通知测试", ts: Date.now() });
  assert(
    await waitFor(() => inbox4.some((m) => m.type === "USER_NOTE" && typeof (m.payload as { ts?: number }).ts === "number")),
    "22 USER_NOTE 瞬态事件实时下发云通道手机",
  );
  assert(
    (inbox4.find((m) => m.type === "USER_NOTE") as unknown as { seq?: number } | undefined)?.seq === 0,
    "22 USER_NOTE seq:0（瞬态，不占总线序号、不回拨 lastSeq）",
  );

  // 重连（hello last_seq=0 → 全量 SNAPSHOT）：SNAPSHOT 携带 pinned；瞬态事件不补发。
  // 先断 phoneWs4（同 dev 顶号会踢旧连接，沿用本文件既有换班模式）
  phoneWs4.close();
  await wait(300);
  const phoneWs5 = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${phoneDev}`);
  const inbox5: Record<string, unknown>[] = [];
  phoneWs5.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as { data?: SealedBox };
    if (f.data) {
      const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, phoneKp.secretKey);
      if (inner) inbox5.push(inner);
    }
  });
  phoneWs5.on("error", () => undefined);
  await new Promise<void>((r) => phoneWs5.on("open", r));
  phoneWs5.send(JSON.stringify({ to: identity.relayDev, data: seal({ t: "hello", last_seq: 0 }, relayPubkey, phoneKp.secretKey) }));
  assert(
    await waitFor(() => {
      const snap = inbox5.find((m) => m.type === "SNAPSHOT") as unknown as { seq?: number; payload?: { sessions?: { session_id: string; pinned?: boolean }[] } } | undefined;
      return snap?.payload?.sessions?.some((s) => s.session_id === sid && s.pinned === true) === true;
    }),
    "21 重连全量 SNAPSHOT 携带 pinned 会话",
  );
  await wait(600); // 留出补发窗口
  assert(!inbox5.some((m) => m.type === "USER_NOTE"), "22 USER_NOTE 不随重连补发（瞬态语义，防重复弹通知）");
  phoneWs5.close();
  mgr.setAgentFactory(null);
}

// ---------- 23) 0.4.4 COMMAND_IMPORT_PUSH 跨网回传：云中转密封投递 ----------
{
  // 新手机连接（22 号已关 phoneWs4）：密封命令 → relay 校验+投递 → 双端断言
  const phoneWs6 = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${phoneDev}`);
  const inbox6: Record<string, unknown>[] = [];
  phoneWs6.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as { data?: SealedBox };
    if (f.data) {
      const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, phoneKp.secretKey);
      if (inner) inbox6.push(inner);
    }
  });
  phoneWs6.on("error", () => undefined);
  await new Promise<void>((r) => phoneWs6.on("open", r));
  const phoneCmd = (obj: Record<string, unknown>) =>
    phoneWs6.send(JSON.stringify({ to: identity.relayDev, data: seal(obj, relayPubkey, phoneKp.secretKey) }));

  // 目标 = 已配对网页端 webDev：早段的 pair_req sighting 已过 30s 窗口，先补发一次
  // pair_req 刷新在场证明（已配对设备错码走幂等 ack 分支，无副作用）。条目带全套 cloud 身份
  webInbox.length = 0;
  webSend({ t: "pair_req", code: "000000", pubkey: webKp.publicKey, name: "web-test" }, true);
  await wait(200);
  const cmdId = "import-push-1";
  const entry = {
    kind: "cloud",
    wsUrl: "wss://cc.humumu.online/cloud",
    token: "bt-test",
    cloud: { url: "https://cc.humumu.online", token: "bt-test", rd: `rl-${"a".repeat(16)}`, rk: relayPubkey, paired: true, code: "123456" },
  };
  phoneCmd({ command_id: cmdId, type: "COMMAND_IMPORT_PUSH", payload: { target_dev: webDev, target_pk: webKp.publicKey, entry }, ts: Date.now() });
  assert(
    await waitFor(() => inbox6.some((m) => m.type === "COMMAND_ACK" && (m as { command_id?: string }).command_id === cmdId && (m as { ok?: boolean }).ok === true)),
    "23 IMPORT_PUSH ACK ok（sighting 在线判定放行）",
  );
  assert(
    await waitFor(() => webInbox.some((m) => m.t === "ccdeck-import-resp" && ((m as { entry?: { kind?: string } }).entry?.kind === "cloud"))),
    "23 目标网页端收到密封 ccdeck-import-resp（含 cloud 条目）",
  );

  // 主路径补验（H1/L5）：未配对出码端（生产真实形态）——连桥发空码 pair_req 信标
  //（不计错/不回 nack/sighting 放行），随后推送成功且目标收到密封帧
  {
    const kpU = generateKeyPair();
    const devU = devId(kpU.publicKey, "wb");
    const wsU = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${devU}`);
    const inU: Record<string, unknown>[] = [];
    wsU.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as { data?: SealedBox };
      if (f.data) {
        const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, kpU.secretKey);
        if (inner) inU.push(inner);
      }
    });
    wsU.on("error", () => undefined);
    await new Promise<void>((r) => wsU.on("open", r));
    // 空码信标（明文单播）：relay 应只记 sighting、静默——绝不回 pair_nack
    wsU.send(JSON.stringify({ to: identity.relayDev, data: { t: "pair_req", code: "", pubkey: kpU.publicKey, name: "unpaired-issuer" } }));
    await wait(400);
    assert(!inU.some((m) => m.t === "pair_nack"), "23 空码信标不回 pair_nack（防杀 pendingPair）");
    const cmdIdU = "import-push-u";
    phoneCmd({ command_id: cmdIdU, type: "COMMAND_IMPORT_PUSH", payload: { target_dev: devU, target_pk: kpU.publicKey, entry }, ts: Date.now() });
    assert(
      await waitFor(() => inbox6.some((m) => m.type === "COMMAND_ACK" && (m as { command_id?: string }).command_id === cmdIdU && (m as { ok?: boolean }).ok === true)),
      "23 未配对出码端经空码信标放行投递（主路径）",
    );
    assert(
      await waitFor(() => inU.some((m) => m.t === "ccdeck-import-resp")),
      "23 未配对出码端收到密封回传帧",
    );
    wsU.close();
  }

  // 反例1 目标离线：合法身份对（公钥派生一致）但从未上线 → ACK 人话错误
  const offKp = generateKeyPair();
  const cmdId2 = "import-push-2";
  phoneCmd({ command_id: cmdId2, type: "COMMAND_IMPORT_PUSH", payload: { target_dev: devId(offKp.publicKey, "wb"), target_pk: offKp.publicKey, entry }, ts: Date.now() });
  assert(
    await waitFor(() => inbox6.some((m) => m.type === "COMMAND_ACK" && (m as { command_id?: string }).command_id === cmdId2 && (m as { ok?: boolean }).ok !== true)),
    "23 离线目标 ACK 失败",
  );
  assert(
    (inbox6.find((m) => m.type === "COMMAND_ACK" && (m as { command_id?: string }).command_id === cmdId2) as { error?: string } | undefined)?.error?.includes("不在线") === true,
    "23 离线目标错误文案含「不在线」",
  );

  // 反例2 dev 与 pk 派生不一致（冒名）→ 格式拒绝
  const cmdId3 = "import-push-3";
  phoneCmd({ command_id: cmdId3, type: "COMMAND_IMPORT_PUSH", payload: { target_dev: webDev, target_pk: offKp.publicKey, entry }, ts: Date.now() });
  assert(
    await waitFor(() => inbox6.some((m) => m.type === "COMMAND_ACK" && (m as { command_id?: string }).command_id === cmdId3 && (m as { ok?: boolean }).ok !== true)),
    "23 冒名 dev/pk 不一致 ACK 拒绝",
  );

  // 反例3 条目形状坏（lan 缺 token）→ 校验拒绝
  const cmdId4 = "import-push-4";
  phoneCmd({ command_id: cmdId4, type: "COMMAND_IMPORT_PUSH", payload: { target_dev: webDev, target_pk: webKp.publicKey, entry: { kind: "lan", wsUrl: "ws://1.2.3.4:8787/ws" } }, ts: Date.now() });
  assert(
    await waitFor(() => inbox6.some((m) => m.type === "COMMAND_ACK" && (m as { command_id?: string }).command_id === cmdId4 && (m as { ok?: boolean }).ok !== true)),
    "23 坏条目（lan 缺 token）ACK 拒绝",
  );
  phoneWs6.close();
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
