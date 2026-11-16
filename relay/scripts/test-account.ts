// W-ACCOUNT 件二/件三 E2E：同账号自动互联（brief-account v2 批 A 自测项）。
// 真桥（cloud-bridge，acct/rn 透传=运营者信任模型）+ 三个 relay 客户端（A/B 同账号、
// C 异账号）+ 两个 wb- 浏览器视角（同账号/异账号）。覆盖：
//   1) RELAYS sa:1 信封（桥算标记）→ acctRelays 内存表（dev/rk/name）+ ACCT_RELAYS 增量帧
//   2) rn 名上报 → RELAYS 条目 name（「其他电脑」行免 dev 裸串）
//   3) 同账号 wb- 空码 pair_req → 免码 addPeer（meta.via=account）+ 密封 pair_ack（E2E 不省）
//   4) 反例：异账号 wb- / 无账号 wb- 空码 pair_req → 零登记零 ack（#29 空码信标口径不破）
// data 目录隔离在临时目录，不污染 relay/data 真实云身份。
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
import { devId, generateKeyPair, unseal } from "../src/e2e.js";
import type { Envelope } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
    process.exitCode = 1;
  } else console.log(`ok - ${msg}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 5000, every = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(every);
  }
  return fn();
}

// ---------- 环境（三 dataDir 隔离） ----------
const BRIDGE_PORT = 8799;
const BRIDGE_TOKEN = "cloud-token-acct";
const mkData = () => mkdtempSync(join(tmpdir(), "cc-account-test-"));
const dataA = mkData(), dataB = mkData(), dataC = mkData();
const oldCwd = process.cwd();
process.chdir(dataA);
process.env.CCR_DATA_DIR = dataA;
process.env.CCR_CLOUD_URL = `ws://127.0.0.1:${BRIDGE_PORT}/cloud`;
process.env.CCR_CLOUD_TOKEN = BRIDGE_TOKEN;
process.env.CCR_NO_TITLE_GEN = "1";
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;

const ACCT = "acct-alpha-token";
const ACCT_OTHER = "acct-beta-token";

process.env.CCR_BRIDGE_TRUST_ACCT = "1"; // 审查修（security P2-3）：Node 桥默认剥 acct——测试桥显式信任门（sa 语义=运营者担保=本测试的模拟对象）
const bridge = startCloudServer(BRIDGE_PORT, BRIDGE_TOKEN);

function makeRelay(dataDir: string, accountToken: string, name: string) {
  process.env.CCR_DATA_DIR = dataDir;
  const cfg = loadConfig();
  cfg.accountToken = accountToken; // W-ACCOUNT：账号 token（生产=env/文件三级回退；测试直赋）
  const bus = new EventBus();
  const mgr = new SessionManager(bus, cfg);
  const identity = loadOrCreateIdentity(cfg.dataDir);
  mgr.setCloud(identity);
  const cloud = new CloudClient(bus, mgr, cfg, identity, createPairingCodes(), cfg.cloudUrl, { relayName: () => name });
  return { bus, mgr, identity, cloud, cfg };
}
const A = makeRelay(dataA, ACCT, "MacBook-Pro");
const B = makeRelay(dataB, ACCT, "HomeWin");
const C = makeRelay(dataC, ACCT_OTHER, "OtherBox");

// A 的总线订阅：捕获 ACCT_RELAYS / PAIRED_DEVICE 瞬态帧
const transient: Envelope[] = [];
A.bus.subscribe((env) => { if (env.type === "ACCT_RELAYS" || env.type === "PAIRED_DEVICE") transient.push(env); });

A.cloud.start(); B.cloud.start(); C.cloud.start();
await wait(1200);

// ---------- 1) 同账号互见：acctRelays（dev/rk/name）+ 隔离 ----------
{
  const a = A.cloud.acctRelays;
  const b = B.cloud.acctRelays;
  const c = C.cloud.acctRelays;
  assert(a.size === 1 && a.has(B.identity.relayDev), `A 见 B（sa:1 过滤后仅同账号）size=${a.size}`);
  const eb = a.get(B.identity.relayDev)!;
  assert(eb.rk === B.identity.keypair.publicKey, "A 侧 B 条目 rk=对方公钥（点连免码配对素材齐）");
  assert(eb.name === "HomeWin", `A 侧 B 条目 name=rn 上报名（${eb.name}）`);
  assert(b.size === 1 && b.has(A.identity.relayDev) && b.get(A.identity.relayDev)!.name === "MacBook-Pro", "B 见 A（对向对称）");
  assert(c.size === 0, `C（异账号）零同账号条目 size=${c.size}`);
  assert(!a.has(C.identity.relayDev), "A 不见 C（账号隔离）");
}
assert(await waitFor(() => transient.some((e) => e.type === "ACCT_RELAYS")), "ACCT_RELAYS 增量帧已发（console/手机「其他电脑」数据源）");

// ---------- 2) 同账号 wb- 免码配对：空码 pair_req → addPeer + 密封 ack ----------
const wbKp = generateKeyPair();
const wbDev = devId(wbKp.publicKey, "wb");
let ackBox: unknown = null;
const wbWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${encodeURIComponent(wbDev)}&acct=${encodeURIComponent(ACCT)}`);
await new Promise((r) => wbWs.once("open", r));
wbWs.on("message", (d) => {
  try {
    const f = JSON.parse(d.toString()) as { from?: string; sa?: number; data?: unknown };
    if (f.from === A.identity.relayDev && f.data) ackBox = f.data;
  } catch { /* ignore */ }
});
wbWs.send(JSON.stringify({ to: A.identity.relayDev, data: { t: "pair_req", code: "", pubkey: wbKp.publicKey, name: "web-mac" } }));
assert(await waitFor(() => ackBox !== null, 5000, 50), "同账号空码 pair_req → 密封 pair_ack 到达（免码不省 E2E 密钥交换）");
{
  const inner = unseal(ackBox as never, A.identity.keypair.publicKey, wbKp.secretKey) as { t?: string; relay_dev?: string; relay_pubkey?: string };
  assert(inner?.t === "pair_ack" && inner.relay_dev === A.identity.relayDev && inner.relay_pubkey === A.identity.keypair.publicKey, "ack 可解且身份对位（relay_dev/relay_pubkey）");
}
assert(await waitFor(() => A.identity.peers.has(wbDev)), "A 侧 wb 设备入册 peers（免码 addPeer）");
assert(A.identity.peers.get(wbDev)?.meta?.via === "account", `meta.via=account（${A.identity.peers.get(wbDev)?.meta?.via}）`);
assert(await waitFor(() => transient.some((e) => e.type === "PAIRED_DEVICE")), "PAIRED_DEVICE 广播（持有者屏幕可见）");

// ---------- 3) 反例①：异账号 wb- 空码（sa≠1 → 走 #29 空码信标路径，零登记零 ack） ----------
{
  const kp = generateKeyPair();
  const dev = devId(kp.publicKey, "wb");
  let got = false;
  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${encodeURIComponent(dev)}&acct=${encodeURIComponent(ACCT_OTHER)}`);
  await new Promise((r) => ws.once("open", r));
  ws.on("message", (d) => { try { const f = JSON.parse(d.toString()) as { from?: string }; if (f.from === A.identity.relayDev) got = true; } catch { /* ignore */ } });
  ws.send(JSON.stringify({ to: A.identity.relayDev, data: { t: "pair_req", code: "", pubkey: kp.publicKey, name: "web-rogue" } }));
  await wait(1000);
  assert(!got && !A.identity.peers.has(dev), "异账号空码 pair_req：零 ack 零登记（sa 信封隔离实锤）");
  ws.close();
}
// ---------- 4) 反例②：无账号 wb- 空码（现状路径回归——#29 口径不破） ----------
{
  const kp = generateKeyPair();
  const dev = devId(kp.publicKey, "wb");
  let got = false;
  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${encodeURIComponent(dev)}`);
  await new Promise((r) => ws.once("open", r));
  ws.on("message", (d) => { try { const f = JSON.parse(d.toString()) as { from?: string }; if (f.from === A.identity.relayDev) got = true; } catch { /* ignore */ } });
  ws.send(JSON.stringify({ to: A.identity.relayDev, data: { t: "pair_req", code: "", pubkey: kp.publicKey, name: "web-old" } }));
  await wait(1000);
  assert(!got && !A.identity.peers.has(dev), "无账号空码 pair_req：零 ack 零登记（信标口径现状零回归）");
  ws.close();
}

// ---------- 清理 ----------
wbWs.close();
A.cloud.close(); B.cloud.close(); C.cloud.close();
await bridge.close();
process.chdir(oldCwd);
for (const d of [dataA, dataB, dataC]) rmSync(d, { recursive: true, force: true });

if (failures === 0) console.log("RELAY ACCOUNT TESTS PASSED");
else {
  console.error(`${failures} failures`);
  process.exit(1);
}
