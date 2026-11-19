// CONNV4C1 批C-件一（t-49e6102c 模块三）：桥侧设备管理命令面测试。
// 四面：数据层（device-admin/device-trust 两表解耦语义）+ 重启持久（独立第二连接读回
// ——createSqlitePort 直开同库文件，绕过 ensureStore 进程内缓存）+ 路由面（POST
// /api/device-admin 四动作，LAN token 鉴权）+ 拒入口面（cloud-client pair_req
// adminVerdict 静默拒：含 sa=1 免码分支封锁与 30s 限频日志——onFrame 直驱，无需真桥）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-connv4c1.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { generateKeyPair, devId } from "../src/e2e.js";
import {
  adminVerdict, clearAdminMarks, getAdminState, KICK_COOLDOWN_MS, listAdminState, setCooldown, setIgnored,
} from "../src/device-admin.js";
import {
  confirmDevice, getDeviceTrust, listDeviceTrust, revokeDevice, trustStore, unRevokeDevice, upsertFirstSeen,
} from "../src/device-trust.js";
import { DEVICE_TRUST_TABLES, migrations } from "../src/storage/schema.js";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { CloudClient } from "../src/cloud-client.js";
import { createPairingCodes } from "../src/pairing.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 0. 隔离纪律（test-xmsg 同款） ----------
const dir = mkdtempSync(join(tmpdir(), "cc-connv4c1-unit-"));
process.env.CCR_DATA_DIR = dir;
process.env.CCR_ORG_DIR = join(dir, "org");
process.env.CCR_TOKEN = "test-token-connv4c1";
const freePort = await new Promise<number>((r) => {
  const s = createTcpServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); });
});
process.env.CCR_PORT = String(freePort);

const port = trustStore(dir);
assert(port !== null, "trustStore 可用（sqlite 驱动在场，v12 迁移随建库跑通）");

// ---------- 1. 数据层：device_admin_state 语义 ----------
const phKp = generateKeyPair();
const wbKp = generateKeyPair();
const PH = devId(phKp.publicKey, "ph");
const WB = devId(wbKp.publicKey, "wb");

{
  // 冷却：until 内拒、过期放行
  const until = Date.now() + KICK_COOLDOWN_MS;
  setCooldown(port, WB, until, "kick 测试");
  assert(getAdminState(port, WB)?.cooldown_until === until, "setCooldown 落行（until 精确回读）");
  assert(adminVerdict(port, WB)?.barred === "cooldown", "冷却期内 verdict=cooldown");
  assert(adminVerdict(port, WB, until + 1) === null, "冷却期满 verdict 放行（until 语义=开区间外）");
  // 忽略：恒拒（与时刻无关）；与冷却并存一行（upsert 保另一字段）
  setIgnored(port, WB, "ignore 测试");
  const row = getAdminState(port, WB);
  assert(row?.ignored_at !== null && row?.ignored_at !== undefined, "setIgnored 落 ignored_at");
  assert(row?.cooldown_until === until, "忽略与冷却并存一行（upsert 单字段不清另一字段）");
  assert(adminVerdict(port, WB, Date.now() + 10 * KICK_COOLDOWN_MS)?.barred === "ignored", "忽略恒拒（冷却早已过期仍拒）");
  // 全清：双清 + note 留痕；无行幂等直过（不落空行）
  assert(clearAdminMarks(port, WB) === true, "clearAdminMarks 成功");
  const cleared = getAdminState(port, WB);
  assert(cleared?.cooldown_until === null && cleared?.ignored_at === null, "unignore 联动双清（冷却+忽略皆空）");
  assert(clearAdminMarks(port, "wb-0000ffff") === true && listAdminState(port).length === 1, "全清无行幂等直过（不建空行）");
}

// ---------- 2. 数据层：两表联动（trust 生命周期 / 不自动复活） ----------
{
  assert(upsertFirstSeen(port, PH, phKp.publicKey, null) === "created", "ph 首见登记 pending");
  assert(confirmDevice(port, PH, "测试员").ok === true, "确认 → confirmed");
  revokeDevice(port, PH, "ignore 联动吊销");
  assert(getDeviceTrust(port, PH)?.revoked_at !== null, "吊销落 revoked_at");
  assert(unRevokeDevice(port, PH).ok === true, "unRevokeDevice 成功");
  const t = getDeviceTrust(port, PH);
  assert(t?.revoked_at === null, "unignore 清吊销标记");
  assert(t?.confirmed_at === null && t?.confirmed_by === null, "不自动复活：confirmed 一并清空回 pending（重走配对/首联确认）");
  assert(unRevokeDevice(port, "wb-0000fffe").ok === true, "unRevoke 无行幂等直过（纯身份面配对设备无 trust 行）");
}

// ---------- 3. 重启持久：独立第二连接读回（同库文件，绕过进程内缓存） ----------
{
  setCooldown(port, WB, Date.now() + KICK_COOLDOWN_MS);
  setIgnored(port, "wb-0000fffd", "重启前忽略");
  const p2 = createSqlitePort({ dataDir: dir });
  p2.open();
  runMigrations(p2, migrations); // 重启形态：新连接重跑迁移（已应用版本 no-op）
  const adminBack = listAdminState(p2);
  assert(adminBack.some((r) => r.dev === WB && r.cooldown_until !== null), "重启读回：冷却行持久（device_admin_state 断电不丢）");
  assert(adminBack.some((r) => r.dev === "wb-0000fffd" && r.ignored_at !== null), "重启读回：忽略行持久（常驻拉黑语义跨重启）");
  assert(listDeviceTrust(p2).some((r) => r.dev === PH), "重启读回：trust 行持久（吊销清空后的 pending 态同存）");
  assert(DEVICE_TRUST_TABLES.includes("device_admin_state" as const) && DEVICE_TRUST_TABLES.includes("device_trust" as const),
    "同库同域清单双向（DEVICE_TRUST_TABLES 含两表）");
}

// ---------- 4. 路由面：POST /api/device-admin ----------
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const pairCodes = createPairingCodes();
// 假 identity 面：cloudPeers 注入 + peerKicker 记录（镜像 index.ts 语义：kicker=removePeer）
const fakePeers = new Map<string, { dev: string; name: string; paired_at: number; last_seen: number; online: boolean }>();
const kickerCalls: string[] = [];
mgr.setPeerKicker((dev) => { fakePeers.delete(dev); kickerCalls.push(dev); });
// 台账种子：ph pending+在线 / wbA confirmed+冷却 / wbB confirmed+peer（kick·ignore 靶）/ wbC 纯 admin 行
const WB_A = "wb-" + "a".repeat(8);
const WB_B = "wb-" + "b".repeat(8);
const WB_C = "wb-" + "c".repeat(8);
upsertFirstSeen(port, PH, phKp.publicKey, null);
upsertFirstSeen(port, WB_A, wbKp.publicKey, null);
confirmDevice(port, WB_A, "路由测试");
upsertFirstSeen(port, WB_B, wbKp.publicKey, null);
confirmDevice(port, WB_B, "路由测试");
setIgnored(port, WB_C, "纯 admin 行");
fakePeers.set(PH, { dev: PH, name: "测试手机", paired_at: Date.now() - 1000, last_seen: Date.now(), online: true });
fakePeers.set(WB_B, { dev: WB_B, name: "测试网页", paired_at: Date.now() - 2000, last_seen: Date.now() - 500, online: false });
const server = startServer(bus, mgr, cfg, { cloudPeers: () => [...fakePeers.values()] });
await wait(150);
const base = `http://127.0.0.1:${cfg.port}/api/device-admin`;
const post = async (body: unknown, token = cfg.token) => {
  const r = await fetch(`${base}?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

{
  const noAuth = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"list"}' });
  assert(noAuth.status === 401, "无 token 401（relay-name 口径）");
  // list 混源台账
  const { status, json } = await post({ action: "list" });
  const devices = (json.devices as Array<Record<string, unknown>>) ?? [];
  const ph = devices.find((d) => d.dev === PH);
  const wbA = devices.find((d) => d.dev === WB_A);
  const wbC = devices.find((d) => d.dev === WB_C);
  assert(status === 200 && json.ok === true, "list 200");
  assert(ph?.kind === "phone" && ph?.name === "测试手机" && ph?.online === true && ph?.trust === "pending",
    "list 混源：peer 源字段（kind/name/online）+trust 态 pending 合并");
  assert(wbA?.kind === "web" && wbA?.trust === "confirmed" && wbA?.cooldown_until === null && wbA?.name === "" && wbA?.online === false,
    "list 混源：trust 源行（confirmed）无 peer 时 name 空/online false");
  assert(wbC?.trust === "none" && wbC?.ignored_at !== null, "list 混源：纯 admin 行也入台账（trust=none+ignored_at）");
  const expectDevs = new Set([...listDeviceTrust(port).map((r) => r.dev), ...listAdminState(port).map((r) => r.dev), ...fakePeers.keys()]);
  assert(devices.length === expectDevs.size && new Set(devices.map((d) => d.dev)).size === devices.length,
    "list 三源并集无重行（trust ⊕ admin ⊕ peers，逐 dev 唯一）");
  // kick ph-：作废配对信任 + 断连
  const k1 = await post({ action: "kick", dev: PH });
  assert(k1.status === 200 && k1.json.kind === "phone", "kick ph- 200（kind=phone 分型）");
  assert(getDeviceTrust(port, PH)?.revoked_at !== null, "kick ph-：trust 吊销（作废配对信任，重入需重新配对）");
  assert(kickerCalls[kickerCalls.length - 1] === PH && !fakePeers.has(PH), "kick ph-：断连走 peerKicker（removePeer 等价实现）");
  // kick wb-：24h 冷却，不动 trust
  const before = kickerCalls.length;
  const k2 = await post({ action: "kick", dev: WB_B });
  const cd = getAdminState(port, WB_B)?.cooldown_until ?? 0;
  assert(k2.status === 200 && k2.json.kind === "web" && typeof k2.json.cooldown_until === "number",
    "kick wb- 200（kind=web 分型+cooldown_until 回显）");
  assert(cd > Date.now() + 23 * 3600_000 && cd < Date.now() + 25 * 3600_000, "kick wb-：冷却≈24h（KICK_COOLDOWN_MS）");
  const tB = getDeviceTrust(port, WB_B);
  assert(tB?.revoked_at === null && tB?.confirmed_at !== null, "kick wb-：不动 trust（confirmed 原样）");
  assert(kickerCalls.length === before + 1 && kickerCalls[kickerCalls.length - 1] === WB_B, "kick wb-：同样断连（peerKicker）");
  // ignore：吊销+忽略清单常驻；幂等（二次 ignore 单行不炸）
  await post({ action: "ignore", dev: WB_B });
  await post({ action: "ignore", dev: WB_B, note: "再忽略" });
  const rowsB = listAdminState(port).filter((r) => r.dev === WB_B);
  const rowB = rowsB[0];
  assert(rowsB.length === 1 && rowB?.ignored_at !== null && rowB?.cooldown_until !== null,
    "ignore 幂等：单行且与既有冷却并存（先 kick 后 ignore 形态）");
  assert(getDeviceTrust(port, WB_B)?.revoked_at !== null, "ignore：trust 吊销");
  // unignore：清忽略+清冷却+清吊销回 pending；不自动复活、不触发断连
  const beforeU = kickerCalls.length;
  const u1 = await post({ action: "unignore", dev: WB_B });
  assert(u1.status === 200 && u1.json.ok === true, "unignore 200");
  const afterRow = getAdminState(port, WB_B);
  const afterTrust = getDeviceTrust(port, WB_B);
  assert(afterRow?.ignored_at === null && afterRow?.cooldown_until === null, "unignore：清忽略+清冷却（管理标记全清）");
  assert(afterTrust?.revoked_at === null && afterTrust?.confirmed_at === null, "unignore：清吊销回 pending（不自动复活 confirmed）");
  assert(kickerCalls.length === beforeU, "unignore：不触发断连（设备已被断，恢复靠设备侧重走配对）");
  // 校验面
  const bad1 = await post({ action: "kick", dev: "rl-1234abcd" });
  assert(bad1.status === 400, "dev 前缀不可识别 400（rl- 非管理面设备）");
  const bad2 = await post({ action: "explode", dev: PH });
  assert(bad2.status === 400, "未知 action 400");
  const badTok = await post({ action: "list" }, "wrong-token-x");
  assert(badTok.status === 401, "错 token 401");
}

// ---------- 5. 拒入口面：cloud-client pair_req 静默拒（onFrame 直驱） ----------
{
  const identity = loadOrCreateIdentity(cfg.dataDir);
  const cloud = new CloudClient(bus, mgr, cfg, identity, pairCodes);
  const frame = (o: unknown) => (cloud as unknown as { onFrame: (t: string) => void }).onFrame(JSON.stringify(o));
  const webKp = generateKeyPair();
  const webDev = devId(webKp.publicKey, "wb");
  const watchKp = generateKeyPair();
  const watchDev = devId(watchKp.publicKey, "wt");
  // 冷却封锁：正码 pair_req 静默拒（码不烧、peers 不进）
  setCooldown(port, webDev, Date.now() + KICK_COOLDOWN_MS);
  const code1 = pairCodes.issue().code;
  frame({ from: webDev, to: identity.relayDev, data: { t: "pair_req", code: code1, pubkey: webKp.publicKey, name: "被踢网页" } });
  assert(!identity.peers.has(webDev), "冷却期正码 pair_req 静默拒：peers 不进");
  assert(pairCodes.consume(code1) === true, "冷却期拒帧不烧码（静默拒先于 consume）");
  // 30s 限频日志：模拟上一条已过窗（-31s），连发 3 帧只 1 条 admin-barred
  (cloud as unknown as { adminBarLoggedAt: number }).adminBarLoggedAt = Date.now() - 31_000;
  const origLog = console.log;
  let barLogs = 0;
  console.log = (...a: unknown[]) => { if (String(a[0]).includes("admin-barred")) barLogs++; };
  for (let i = 0; i < 3; i++) frame({ from: webDev, to: identity.relayDev, data: { t: "pair_req", code: code1, pubkey: webKp.publicKey } });
  console.log = origLog;
  assert(barLogs === 1, "静默拒日志 30s 限频（3 帧仅 1 条，wanDropLoggedAt 样板）");
  // sa=1 免码分支同样封锁（账号类被踢后不得免码直入）
  frame({ from: webDev, to: identity.relayDev, sa: 1, data: { t: "pair_req", code: "", pubkey: webKp.publicKey, name: "同账号" } });
  assert(!identity.peers.has(webDev), "sa=1 免码直入同样封锁（gate 先于 sa 分支）");
  // 忽略封锁：wt- 忽略后正码拒
  setIgnored(port, watchDev);
  const code2 = pairCodes.issue().code;
  frame({ from: watchDev, to: identity.relayDev, data: { t: "pair_req", code: code2, pubkey: watchKp.publicKey, client_type: "watch" } });
  assert(!identity.peers.has(watchDev), "忽略清单常驻拒：wt- 正码 pair_req 拒");
  // 解封恢复链：unignore 后同设备正码可配对（端到端 gate 释放）
  clearAdminMarks(port, webDev);
  unRevokeDevice(port, webDev);
  const code3 = pairCodes.issue().code;
  frame({ from: webDev, to: identity.relayDev, data: { t: "pair_req", code: code3, pubkey: webKp.publicKey, name: "回归网页" } });
  assert(identity.peers.has(webDev), "unignore 解封：正码 pair_req 恢复配对（gate 释放端到端）");
  assert(pairCodes.consume(code3) === false, "解封配对真实消费了码（非旁路）");
  // 缺库降级备案：驱动缺失=无管理态可查，verdict 放行（整库降级面，与 trust 侧 fail-closed 分工）
  assert(adminVerdict(null, webDev) === null, "port=null verdict 放行（缺库降级备案——不因管理面拖垮配对主链）");
}

// ---------- 收尾 ----------
server.close(); // fetch keep-alive 句柄会拖住 close 回调——不强等，wait 后强制退出（test-artifacts 同款）
await wait(150);
rmSync(dir, { recursive: true, force: true });
console.log(`\nCONNV4C1 TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
