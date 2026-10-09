// 005 云桥链协议测试（B批）：真本地桥 + 真 SessionManager/CloudClient + 「005 网页端」模拟。
// 005 侧身份与密封不是另写一份——直接从 web-console/index-005.html 的密封层标记段抽取
// 在 Node 直跑（与浏览器同一份实现：壳内密封层被改动即红，测试即回归）。
// 覆盖：① 密封层与 relay/src/e2e.ts 双向互操作 ② 输码配对（明文 pair_req+pubkey → 密封
// pair_ack）③ 密封 hello → SNAPSHOT ④ 密封命令 → COMMAND_ACK ⑤ 断线 last_seq 恰量补发
// ⑥ 未配对 rogue 仅收明文 pair_nack。
// 端口 8798（与 test-cloud.ts 的 8797 错开，可并行）；数据目录临时隔离，不碰 relay/data。
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import nacl from "tweetnacl";
import { startCloudServer } from "../../cloud-bridge/src/index.js";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { CloudClient } from "../src/cloud-client.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { createPairingCodes } from "../src/pairing.js";
import { devId, generateKeyPair, seal as relaySeal, unseal as relayUnseal, type SealedBox } from "../src/e2e.js";
import type { CommandAckPayload } from "../src/types.js";

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

// ---------- 0) 抽取 005 壳内密封层标记段（test-005-cloud 抽取直跑的契约锚） ----------
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html005 = readFileSync(join(root, "web-console", "index-005.html"), "utf-8");
const SEAL_START = "// ---------- 云桥 E2E 密封层（";
const SEAL_END = "// ---------- 云桥 E2E 密封层结束 ----------";
const sealStart = html005.indexOf(SEAL_START);
const sealEnd = html005.indexOf(SEAL_END, sealStart);
assert(sealStart >= 0 && sealEnd > sealStart, "005 壳内密封层标记段存在（test-005-cloud 抽取锚）");
const sealCode = sealStart >= 0 && sealEnd > sealStart ? html005.slice(sealStart, sealEnd + SEAL_END.length) : "";
assert(sealCode.includes("function unseal") && sealCode.includes("function seal") && sealCode.includes("function devId"), "密封段含 seal/unseal/devId 全套");
// head 阻塞加载 nacl.js（坑 6：密封依赖在云链模块前就绪）
assert(/<script src="\/nacl\.js"><\/script>/.test(html005), "壳 head 含 /nacl.js 根相对引用");
// 与 relay/src/e2e.ts 同构：B64 字母表逐字符一致（互操作的地基）
const W = (function () {
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function("nacl", `"use strict";\n${sealCode}\n;return { toB64: (typeof toB64 === "function") ? toB64 : null, fromB64: (typeof fromB64 === "function") ? fromB64 : null, genKp: (typeof genKp === "function") ? genKp : null, devId: (typeof devId === "function") ? devId : null, seal: (typeof seal === "function") ? seal : null, unseal: (typeof unseal === "function") ? unseal : null };`);
    return factory(nacl) as {
      toB64: (b: Uint8Array) => string;
      fromB64: (s: string) => Uint8Array;
      genKp: () => { publicKey: string; secretKey: string };
      devId: (pk: string, prefix: string) => string;
      seal: (obj: unknown, theirPk: string, mySk: string) => SealedBox;
      unseal: <T>(box: SealedBox, theirPk: string, mySk: string) => T | null;
    };
  } catch { return null; }
})();
assert(!!W && !!W.seal && !!W.unseal && !!W.genKp && !!W.devId, "密封段在 Node 可直跑（new Function 求值成活）");

// base64 往返 + 与 relay 实现互通（005 加密 → relay 解密；relay 加密 → 005 解密）
{
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const b64 = W.toB64(bytes);
  assert(b64.length === 344 && b64.endsWith("=="), "toB64 输出带 padding 的标准 base64");
  assert(Buffer.from(W.fromB64(b64)).equals(Buffer.from(bytes)), "fromB64 完整往返 256 字节");
  const relayKp = generateKeyPair();
  const kp = W.genKp();
  const boxed1 = W.seal({ hello: "005" }, relayKp.publicKey, kp.secretKey);
  assert(relayUnseal<{ hello: string }>(boxed1, kp.publicKey, relayKp.secretKey)?.hello === "005", "005 seal → relay unseal 互通");
  const boxed2 = relaySeal({ ok: 2 }, kp.publicKey, relayKp.secretKey);
  assert(W.unseal<{ ok: number }>(boxed2, relayKp.publicKey, kp.secretKey)?.ok === 2, "relay seal → 005 unseal 互通");
  assert(W.devId(kp.publicKey, "wb") === devId(kp.publicKey, "wb") && W.devId(kp.publicKey, "wb").startsWith("wb-"), "devId 与 relay 派生一致（wb- 前缀）");
}

// ---------- 环境（沙盒铁律：临时 dataDir + 钉 env，绝不连生产桥） ----------
const BRIDGE_PORT = 8798;
const BRIDGE_TOKEN = "cloud-token-005";
const dataDir = mkdtempSync(join(tmpdir(), "cc-005-cloud-test-"));
const oldCwd = process.cwd();
process.chdir(dataDir);
process.env.CCR_DATA_DIR = dataDir;
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
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
mgr.setPairIssuer((o) => pairCodes.issue(o));
mgr.setLoginGranter((dev, pk, name) => { cloud.grantLogin(dev, pk, name); return true; });
mgr.setPeerKicker((dev) => { identity.removePeer(dev); cloud.kickPeer(dev); });
const cloud = new CloudClient(bus, mgr, cfg, identity, pairCodes);
cloud.start();
await wait(300);

// 005 网页端身份（与浏览器同款：wb- 设备号 + 005 密封层）
const webKp = W!.genKp();
const webDev = W!.devId(webKp.publicKey, "wb");

// ---------- 1) 输码配对：明文 pair_req(码+pubkey+#42 meta) → 密封 pair_ack ----------
const webInbox: Record<string, unknown>[] = [];
let webWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${webDev}`);
const attachWeb = (ws: WebSocket) => {
  ws.on("message", (raw) => {
    try {
      const f = JSON.parse(String(raw)) as { data?: SealedBox };
      if (!f.data) return;
      // 未配对期回包按 005 的试解链：relay 公钥 → 密封 ack
      const inner = W!.unseal<Record<string, unknown>>(f.data, identity.keypair.publicKey, webKp.secretKey);
      if (inner) webInbox.push(inner);
    } catch {}
  });
  ws.on("error", () => undefined);
};
attachWeb(webWs);
await new Promise<void>((r) => webWs.on("open", r));
const webSendSealed = (obj: unknown) =>
  webWs.send(JSON.stringify({ to: identity.relayDev, data: W!.seal(obj, identity.keypair.publicKey, webKp.secretKey) }));

const { code: pairCode } = pairCodes.issue();
// 005 现行口径（#29 C-P0-1）：带码帧携 pubkey；#42 meta 自报平台摘要
webWs.send(JSON.stringify({
  to: identity.relayDev,
  data: { t: "pair_req", code: pairCode, pubkey: webKp.publicKey, name: "web-" + webDev.slice(3, 11), meta: { platform: "Chrome·macOS", ua: "005-cloud-test" } },
}));
assert(
  await waitFor(() => webInbox.some((m) => m.t === "pair_ack")),
  "输码配对收到密封 pair_ack",
);
{
  const ack = webInbox.find((m) => m.t === "pair_ack") as unknown as { relay_dev: string; relay_pubkey: string };
  assert(ack.relay_dev === identity.relayDev && ack.relay_pubkey === identity.keypair.publicKey, "pair_ack 携带 relay dev 与公钥（005 换代/锚定校验的数据源）");
}
assert(identity.peers.has(webDev), "005 web 设备已登记 peers");

// ---------- 2) 密封 hello → SNAPSHOT ----------
webSendSealed({ t: "hello", last_seq: 0 });
assert(
  await waitFor(() => webInbox.some((m) => m.type === "SNAPSHOT")),
  "配对后密封 hello 收到 SNAPSHOT（005 刷新空会话→last_seq=0 全量重建语义）",
);
{
  const snap = webInbox.find((m) => m.type === "SNAPSHOT") as unknown as { seq?: number; payload?: { sessions?: unknown[] } };
  assert(Array.isArray(snap?.payload?.sessions), "SNAPSHOT 携带 sessions 数组");
}

// ---------- 3) 密封命令 → COMMAND_ACK（错误路径：不存在的会话） ----------
webSendSealed({ command_id: "cmd-005-1", type: "COMMAND_RENAME", payload: { session_id: "nope", title: "x" }, ts: Date.now() });
assert(
  await waitFor(() => {
    const ack = webInbox.find((m) => m.type === "COMMAND_ACK" && m.command_id === "cmd-005-1") as unknown as CommandAckPayload | undefined;
    return !!ack && ack.ok === false && typeof ack.error === "string";
  }),
  "密封命令往返收到 ACK（command_id 结算，不锚 socket）",
);

// ---------- 4) 断线 + last_seq 恰量补发 ----------
// 铺垫：先吃一条实时事件把总线 seq 推起来（否则快照 seq=0，last_seq=0 的 hello 按
// 005 语义就是全量重建——那是另一条已验证路径，不是本段要测的增量补发）
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "005-live-1" });
assert(
  await waitFor(() => webInbox.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "005-live-1")),
  "在线期实时事件密封下发",
);
const lastSeq = Math.max(...webInbox.map((m) => Number(m.seq ?? 0)).filter((n) => n > 0));
assert(lastSeq > 0, "last_seq 已从实时事件推进（增量补发的前提）");
webWs.close();
await wait(200);
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "005-offline-1" });
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "005-offline-2" });
await wait(200);

webWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${webDev}`);
webInbox.length = 0; // 新连接新收件箱：断言只看补发窗口
attachWeb(webWs);
await new Promise<void>((r) => webWs.on("open", r));
webSendSealed({ t: "hello", last_seq: lastSeq });
assert(
  await waitFor(() => webInbox.filter((m) => m.type === "SESSION_LOG").length === 2),
  "重连按 last_seq 补发恰好 2 条",
);
assert(!webInbox.some((m) => m.type === "SNAPSHOT"), "缓冲内 last_seq 不触发 SNAPSHOT 重建");
{
  const seqs = webInbox.filter((m) => m.seq).map((m) => Number(m.seq));
  assert(seqs.length === 2 && seqs[0] === lastSeq + 1 && seqs[1] === lastSeq + 2, "补发 seq 连续无洞（005 持久化 last_seq 的语义基础）");
}

// ---------- 5) 未配对 rogue：只收明文 pair_nack，无密文会话下发 ----------
const rogueKp = W!.genKp();
const rogueDev = W!.devId(rogueKp.publicKey, "wb");
const rogueWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${rogueDev}`);
const rogueMsgs: { data?: { t?: string; n?: string } }[] = [];
rogueWs.on("message", (d) => { try { rogueMsgs.push(JSON.parse(String(d))); } catch {} });
rogueWs.on("error", () => undefined);
await new Promise<void>((r) => rogueWs.on("open", r));
rogueWs.send(JSON.stringify({ to: identity.relayDev, data: W!.seal({ t: "hello", last_seq: 0 }, identity.keypair.publicKey, rogueKp.secretKey) }));
bus.emit("sess-cloud", "SESSION_LOG", { kind: "system", text: "005-rogue-probe" });
await wait(1200);
assert(rogueMsgs.length > 0 && rogueMsgs.every((m) => m.data?.t === "pair_nack" && !m.data.n), "未配对设备只收明文 pair_nack（005 侧据此回落未配对态引导输码）");
assert(
  await waitFor(() => webInbox.some((m) => m.type === "SESSION_LOG" && (m.payload as { text?: string })?.text === "005-rogue-probe")),
  "已配对 005 端仍正常收到该事件",
);

// ---------- 清理 ----------
rogueWs.close();
webWs.close();
cloud.close();
await bridge.close();
process.chdir(oldCwd);
rmSync(dataDir, { recursive: true, force: true });

if (failures === 0) console.log("005 CLOUD TESTS PASSED");
else {
  console.error(`${failures} failures`);
  process.exit(1);
}
