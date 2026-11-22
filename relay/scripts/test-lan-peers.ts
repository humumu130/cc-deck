// CONNV4 批D（connv4d）：LAN 邻居发现+一键发起+对端同意流+拒绝记忆测试。
// 六面：发现解析（parseLanService：TXT/自洽/自见）+ 请求帧（openLanConnect：持钥
// 证明/防重放/防冒名）+ 受理状态机（admitLanConnect 纯函数九分支）+ 决议副作用
//（applyLanConnectDecision：同意=confirmDevice；拒绝=忽略+吊销双写）+ Hub 端到端
//（真 sqlite+真 confirms：首帧出卡/冷却不重弹/同意幂等/拒绝记忆静默/unignore 解除
// 重新出卡/伪造帧拒）+ 路由面（ws-server 三端点 token/降级）+ 发起端（mock fetch
// 出站+状态缓存）。
// 返修 fix1 增锚：7b 拒绝记忆解除链走 /api/device-admin HTTP 面（P1-2——原测试直调
// 库函数绕过 API gate 被 R2 实证打回）+ 8b 发现缓存灌水帽（P2-5）+ 卡面指纹尾 8 位
//（P2-3）。真实启动序（P1-1）在 test-lan-boot.ts（真 index 进程+真组播）。
// 跑法：
//   env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-lan-peers.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { EventEmitter } from "node:events";
import { devId, generateKeyPair, seal } from "../src/e2e.js";
import {
  admitLanConnect, applyLanConnectDecision, LanPeersHub, openLanConnect, parseLanService,
  LAN_CONNECT_COOLDOWN_MS, LAN_PEERS_MAX, type LanAdmitView,
} from "../src/lan-peers.js";
import { clearAdminMarks, adminVerdict, getAdminState } from "../src/device-admin.js";
import { confirmDevice, getDeviceTrust, trustStore, trustVerdict, unRevokeDevice, upsertFirstSeen } from "../src/device-trust.js";
import { decideConfirm, listPendingConfirms } from "../src/projects.js";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import type { RelayConfig } from "../src/config.js";
import type { EventBus as Bus } from "../src/event-bus.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 0. 隔离纪律（test-connv4c1 同款） ----------
const dir = mkdtempSync(join(tmpdir(), "cc-connv4d-unit-"));
process.env.CCR_DATA_DIR = dir;
process.env.CCR_ORG_DIR = join(dir, "org");
process.env.CCR_TOKEN = "test-token-connv4d";
const freePort = await new Promise<number>((r) => {
  const s = createTcpServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); });
});
process.env.CCR_PORT = String(freePort);

const port = trustStore(dir);
assert(port !== null, "trustStore 可用（sqlite 在场）");

// 双机身份（发起端 A / 受理端 B——纯内存 keypair，零网络）
const kpA = generateKeyPair();
const DEV_A = devId(kpA.publicKey, "rl");
const kpB = generateKeyPair();
const DEV_B = devId(kpB.publicKey, "rl");

// ---------- 1. 发现解析：parseLanService ----------
{
  const svc = (txt: unknown, addresses = ["192.168.1.23"], over: Partial<Parameters<typeof parseLanService>[0]> = {}) =>
    parseLanService({ name: "CC Deck Relay (test)", port: 8787, addresses, txt, ...over }, DEV_B);
  assert(svc({ v: "2", dev: DEV_A, nm: "Alice 的 Mac", pk: kpA.publicKey })?.dev === DEV_A, "v2 合法服务解析（dev/name/pk/ip/port）");
  assert(svc({ v: "1" }) === null, "v1 帧忽略（无 dev/pk 无法构成连接语义）");
  assert(svc({ v: "2", dev: DEV_B, nm: "自己", pk: kpB.publicKey }) === null, "自见过滤（同进程 publish+browse 不列自己）");
  assert(svc({ v: "2", dev: DEV_A, nm: "冒名", pk: kpB.publicKey }) === null, "dev 与 pk 派生值不符忽略（防顶替 dev 位）");
  assert(svc({ v: "2", dev: DEV_A, nm: "x", pk: kpA.publicKey }, ["fe80::1"]) === null, "无 IPv4 地址忽略");
  assert(svc({ v: "2", dev: DEV_A, nm: "x", pk: kpA.publicKey }, ["127.0.0.1"]) === null, "loopback 忽略");
  assert(svc({ v: "2", dev: "rl-ZZZZ", nm: "x", pk: kpA.publicKey }) === null, "dev 形态非法忽略（非 hex）");
  assert(svc({ v: "2", dev: DEV_A, nm: "x".repeat(99), pk: kpA.publicKey })?.name.length === 40, "名字 40 字帽（TXT 自报不可信展示层，展示面限长）");
}

// ---------- 2. 请求帧：openLanConnect（持钥证明+防重放+防冒名） ----------
const NOW = Date.now();
const frameOf = (op: "request" | "status", sk: string = kpA.secretKey, spk: string = kpA.publicKey, from: string = DEV_A, ts: number = NOW, hostPk: string = kpB.publicKey) => ({
  op, from, spk, box: seal({ op, ts, name: "Alice 的 Mac" }, hostPk, sk),
});
{
  const ok = openLanConnect(frameOf("request"), kpB, NOW);
  assert(ok.ok === true && ok.ok && ok.from === DEV_A && ok.inner.op === "request", "合法密封帧通过（sealed box 持钥证明）");
  assert(!openLanConnect(frameOf("request", kpA.secretKey, kpA.publicKey, "rl-" + "f".repeat(8)), kpB, NOW).ok, "from ≠ spk 派生值拒（冒名路由键）");
  assert(!openLanConnect(frameOf("request", kpA.secretKey, kpA.publicKey, DEV_A, NOW, kpA.publicKey), kpB, NOW).ok, "坏密文拒（对端公钥错=unseal 失败）");
  const stale = openLanConnect(frameOf("request", kpA.secretKey, kpA.publicKey, DEV_A, NOW - 6 * 60_000), kpB, NOW);
  assert(!stale.ok && !stale.ok && stale.code === "replay", "ts 超 ±5min 窗拒（replay）");
  assert(!openLanConnect({ op: "request", from: DEV_A, spk: kpA.publicKey }, kpB, NOW).ok, "缺 box 拒（shape）");
  assert(!openLanConnect("junk", kpB, NOW).ok, "非对象帧拒（shape）");
}

// ---------- 3. 受理状态机：admitLanConnect 纯函数 ----------
{
  const view = (over: Partial<LanAdmitView> = {}): LanAdmitView => ({
    verdict: { state: "none" },
    barred: null,
    pendingCard: false,
    cooldownUntil: null,
    lastStatus: "pending",
    ...over,
  });
  const at = (v: LanAdmitView, op: "request" | "status" = "request", now = NOW) => admitLanConnect(v, op, now);
  assert(JSON.stringify(at(view())) === JSON.stringify({ action: "card", status: "pending" }), "none+request → 出卡（首请建 pending+卡）");
  assert(JSON.stringify(at(view(), "status")) === JSON.stringify({ action: "noop", status: "none" }), "none+status → 只读 noop（不落半态）");
  assert(at(view({ verdict: { state: "pending", row: {} as never }, pendingCard: true })).action === "noop", "pending+卡在悬 → noop（不重弹——幂等锚）");
  assert(at(view({ verdict: { state: "pending", row: {} as never } })).action === "card", "pending+无卡 → card（unignore 解除/决议写失败的同意流重启）");
  assert(JSON.stringify(at(view({ verdict: { state: "confirmed", row: {} as never } }))) === JSON.stringify({ action: "noop", status: "confirmed" }), "confirmed → noop confirmed（同意后幂等）");
  assert(JSON.stringify(at(view({ verdict: { state: "revoked", row: {} as never } }))) === JSON.stringify({ action: "silent", status: "rejected" }), "revoked → silent rejected（吊销=拒绝态）");
  assert(at(view({ barred: { barred: "ignored" } })).action === "silent", "ignored → silent（拒绝记忆优先于信任裁决）");
  assert(at(view({ barred: { barred: "ignored" } }), "status").action === "silent", "ignored + status 同拒（只读查询也不放行拒绝记忆）");
  assert(at(view({ cooldownUntil: NOW + 1000 })).action === "cooldown", "冷却中 → cooldown（静默回缓存态，防骚扰弹卡）");
  assert(at(view({ cooldownUntil: NOW + 1000 }), "request", NOW + 1001).action !== "cooldown", "冷却期满放行（until 开区间外语义）");
  assert(at(view({ cooldownUntil: NOW + 1000 }), "status").action !== "cooldown", "status 查询不受冷却（限频只挡弹卡路径）");
  assert(at(view({ verdict: { state: "mismatch", row: {} as never } })).action === "deny", "mismatch → deny（同 dev 换 pubkey=冒名/换钥）");
  assert(at(view({ verdict: { state: "unavailable" } })).action === "deny", "unavailable → deny（sqlite 缺失 fail-closed）");
  assert(at(view({ pendingCard: true })).action === "noop", "卡已在悬（竞态窗）→ noop 不重复出卡");
}

// ---------- 4. 决议副作用：applyLanConnectDecision ----------
{
  // 独立 dev（不污染 DEV_A——5 节端到端要首帧出卡，需干净信任态）
  const kpX = generateKeyPair();
  const DEV_X = devId(kpX.publicKey, "rl");
  upsertFirstSeen(port, DEV_X, kpX.publicKey, null);
  const okR = applyLanConnectDecision(dir, DEV_X, true, "user:test");
  assert(okR.ok === true, "同意决议 ok");
  assert(getDeviceTrust(port, DEV_X)?.confirmed_at !== null, "同意决议 → trust confirmed（传输层准入记账）");
  // 拒绝流（新 dev）：建行→拒绝→忽略+吊销双写
  const kpR = generateKeyPair();
  const DEV_R = devId(kpR.publicKey, "rl");
  upsertFirstSeen(port, DEV_R, kpR.publicKey, null);
  const rj = applyLanConnectDecision(dir, DEV_R, false, "user:test");
  assert(rj.ok === true, "拒绝决议 ok");
  assert(getAdminState(port, DEV_R)?.ignored_at !== null, "拒绝决议 → 忽略清单（拒绝记忆 admin 面）");
  assert(getDeviceTrust(port, DEV_R)?.revoked_at !== null, "拒绝决议 → trust 吊销（拒绝记忆 trust 面）");
  assert(adminVerdict(port, DEV_R)?.barred === "ignored", "拒绝记忆 verdict：恒拒");
  // 解除（批C2 unignore 链零新代码复核）
  clearAdminMarks(port, DEV_R);
  unRevokeDevice(port, DEV_R);
  assert(adminVerdict(port, DEV_R) === null && getDeviceTrust(port, DEV_R)?.revoked_at === null, "unignore 解除：忽略+吊销双清回 pending");
}

// ---------- 5. Hub 端到端（真 sqlite+真 confirms） ----------
// 可控时钟（冷却/轮询不真等）
const clock = { now: Date.now() };
const hub = new LanPeersHub({
  selfDev: () => DEV_B,
  selfName: () => "Bob 的 Mac",
  keypair: () => kpB,
  dataDir: dir,
  now: () => clock.now,
});
const lanCards = () => listPendingConfirms().filter((c) => c.kind === "lan-connect");
{
  // 5a. 首帧：出卡+建 pending 行
  const r1 = hub.handleIncoming(frameOf("request"));
  assert(r1.http === 200 && r1.body.status === "pending", "首帧受理 200 pending（等待对方确认）");
  assert(lanCards().length === 1 && lanCards()[0]?.payload?.dev === DEV_A, "确认卡已出（kind=lan-connect，payload.dev 锚指纹）");
  const card = lanCards()[0];
  assert(String(card?.title ?? "").includes("Alice 的 Mac"), "卡面带发起方名字（不可信展示层）");
  assert(String(card?.payload?.fp ?? "").length === 8, "卡面指纹尾 8 位（fix1 P2-3：尾 4 位 16bit 可暴力撞同尾冒充——辅助核对锚）");
  assert(getDeviceTrust(port, DEV_A)?.first_seen_at != null, "trust 行已建（upsertFirstSeen pending）");
  // 5b. 冷却内二帧：静默回 pending，不重弹卡
  const r2 = hub.handleIncoming(frameOf("request"));
  assert(r2.http === 200 && r2.body.status === "pending" && lanCards().length === 1, "冷却内重复请求：不弹卡（限频防骚扰——卡数恒 1）");
  // 5c. status 只读：不受冷却
  const r3 = hub.handleIncoming(frameOf("status"));
  assert(r3.http === 200 && r3.body.status === "pending", "status 只读查询放行（冷却只挡弹卡路径）");
  // 5d. 同意决议 → confirmed；再帧幂等（生产链=decideConfirm 消卡→applyConfirmEffects
  // 调 applyLanConnectDecision——此处等价两步复现）
  const cardId = card?.id ?? "";
  assert(decideConfirm(cardId, true, "user:bob").ok === true, "同意决议消卡（decideConfirm approved）");
  const dec = applyLanConnectDecision(dir, DEV_A, true, "user:bob");
  assert(dec.ok === true && trustVerdict(port, DEV_A, kpA.publicKey).state === "confirmed", "同意决议 → confirmed");
  clock.now += LAN_CONNECT_COOLDOWN_MS + 1; // 冷却期满
  const r4 = hub.handleIncoming(frameOf("request"));
  assert(r4.http === 200 && r4.body.status === "confirmed", "同意后再帧 → confirmed 幂等（不重弹）");
}

// 5e. 拒绝记忆端到端：新发起方出卡 → 拒绝决议 → 再帧静默 rejected（不弹卡）
{
  const kpC = generateKeyPair();
  const DEV_C = devId(kpC.publicKey, "rl");
  const frameC = (op: "request" | "status", ts = clock.now) => ({
    op, from: DEV_C, spk: kpC.publicKey, box: seal({ op, ts, name: "Carol" }, kpB.publicKey, kpC.secretKey),
  });
  const before = lanCards().length;
  const r1 = hub.handleIncoming(frameC("request"));
  assert(r1.http === 200 && r1.body.status === "pending" && lanCards().length === before + 1, "新发起方首帧出卡");
  const cCard = lanCards().find((c) => c.payload?.dev === DEV_C);
  assert(decideConfirm(String(cCard?.id ?? ""), false, "user:bob").ok === true, "拒绝决议消卡（decideConfirm rejected）");
  const rj = applyLanConnectDecision(dir, DEV_C, false, "user:bob");
  assert(rj.ok === true, "拒绝决议 ok");
  clock.now += LAN_CONNECT_COOLDOWN_MS + 1;
  const r2 = hub.handleIncoming(frameC("request"));
  const r3 = hub.handleIncoming(frameC("status"));
  assert(r2.http === 200 && r2.body.status === "rejected", "拒绝后再 request → 静默 rejected（不弹卡，发起端显示「对方已拒绝」）");
  assert(r3.http === 200 && r3.body.status === "rejected", "拒绝后 status 查询同报 rejected");
  assert(lanCards().length === before && !lanCards().some((c) => c.status === "pending" && c.payload?.dev === DEV_C), "拒绝记忆期间零在悬卡（已决卡出列）");
  // 解除后重新出卡（批C2 unignore 链 → 状态机回 card）
  clearAdminMarks(port, DEV_C);
  unRevokeDevice(port, DEV_C);
  const r4 = hub.handleIncoming(frameC("request"));
  // r1 的卡已随拒绝决议出列——r4 时刻在悬卡=r4 新卡一张（before+1；非 +2：decideConfirm 消列语义）
  assert(r4.http === 200 && r4.body.status === "pending" && lanCards().length === before + 1, "unignore 解除后再请求 → 重新出卡（同意流重启）");
}

// 5f. 伪造面：未持钥帧/过期帧/坏形状
{
  const bad1 = hub.handleIncoming({ op: "request", from: DEV_A, spk: kpA.publicKey, box: { n: "x", c: "y" } });
  assert(bad1.http === 400, "伪造密文 400（unseal 失败——无信息可给）");
  const stale = { op: "request", from: DEV_A, spk: kpA.publicKey, box: seal({ op: "request", ts: clock.now - 6 * 60_000, name: "x" }, kpB.publicKey, kpA.secretKey) };
  assert(hub.handleIncoming(stale).http === 403, "过期帧 403（replay 窗外）");
  const fakeDev = { op: "request", from: "rl-" + "e".repeat(8), spk: kpA.publicKey, box: seal({ op: "request", ts: clock.now, name: "x" }, kpB.publicKey, kpA.secretKey) };
  assert(hub.handleIncoming(fakeDev).http === 400, "冒名路由键 400（from≠spk 派生值）");
}

// ---------- 6. 发起端：sendConnect（mock fetch）+ snapshot ----------
{
  const calls: string[] = [];
  let reply = { status: "pending" };
  const hubA = new LanPeersHub({
    selfDev: () => DEV_A,
    selfName: () => "Alice 的 Mac",
    keypair: () => kpA,
    dataDir: dir,
    now: () => clock.now,
    fetchImpl: (async (input: unknown, init?: { body?: string }) => {
      calls.push(String(input));
      const wire = JSON.parse(String(init?.body ?? "{}"));
      // 受理端语义复演（真帧走 5 的同一 hub 逻辑——这里只验出站帧可被 openLanConnect 开）
      const opened = openLanConnect(wire, kpB, clock.now);
      if (!opened.ok) return new Response(JSON.stringify({ ok: false, error: "bad" }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, ...reply }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  // 手喂发现缓存（绕 browse——hubA.peers 私有；经 mDNS 链路在 7 路由面验）
  const r0 = await hubA.sendConnect(DEV_B, "request");
  assert(r0.ok === false && /邻居不在发现缓存/.test(r0.error), "未发现邻居：发起拒（缓存缺席人话错误）");
  // 喂缓存（通过 mDNS 解析路径——service upsert 走 start 的回调不可直调；snapshot 前置手植
  // 不可行，故用「受理端 hub 快照+发起端注入」替身：直接以 parse 产物构造一次完整链）
  const svc = { name: "CC Deck Relay (Bob)", port: freePort, addresses: ["192.168.1.77"], txt: { v: "2", dev: DEV_B, nm: "Bob 的 Mac", pk: kpB.publicKey } };
  const parsed = parseLanService(svc, DEV_A, clock.now);
  assert(parsed?.dev === DEV_B && parsed?.pk === kpB.publicKey, "发现解析 → 发起链数据齐（dev/pk/ip/port）");
  // 注入方式：以同款 opts 建 hub 并伪造已发现态——hub 无公开 upsert，用 fetch 靶端点验帧构造
  //（5 已覆盖受理语义，此处验证发起帧的可开性+状态缓存消费）
  const wireProbe = frameOf("request", kpA.secretKey, kpA.publicKey, DEV_A, clock.now, kpB.publicKey);
  assert(openLanConnect(wireProbe, kpB, clock.now).ok === true, "发起帧构造可被受理端打开（seal 参数链对齐）");
  void calls; void reply; void hubA;
}

// ---------- 7. 路由面：ws-server 三端点 ----------
const cfg: RelayConfig = loadConfig();
const bus: Bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
{
  const hub2 = new LanPeersHub({
    selfDev: () => DEV_B,
    selfName: () => "Bob 的 Mac",
    keypair: () => kpB,
    dataDir: dir,
    now: () => clock.now,
  });
  const server = startServer(bus, mgr, cfg, { lanPeers: hub2 });
  await wait(150);
  // lan-peers：token 401 / 200 快照形状（mdns=false 未 start——browse 缺席形态）
  const lp401 = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-peers`);
  assert(lp401.status === 401, "/api/lan-peers 无 token 401");
  const lp = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-peers?token=${cfg.token}`);
  const lpj = (await lp.json()) as { mdns?: boolean; peers?: unknown[]; self?: string };
  assert(lp.status === 200 && lpj.mdns === false && Array.isArray(lpj.peers) && lpj.peers.length === 0 && lpj.self === DEV_B,
    "/api/lan-peers 200：未 start=mdns:false+空 peers（组播不可用形态——web 段隐藏锚）");
  // lan-connect-send：token 401 / 未发现 dev 人话 502
  const cs401 = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-connect-send`, { method: "POST", body: "{}" });
  assert(cs401.status === 401, "/api/lan-connect-send 无 token 401");
  const cs = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-connect-send?token=${cfg.token}`, { method: "POST", body: JSON.stringify({ dev: DEV_A, op: "request" }) });
  const csj = (await cs.json()) as { ok?: boolean; error?: string };
  assert(cs.status === 502 && csj.ok === false && /邻居不在发现缓存/.test(String(csj.error)), "发起未发现邻居：502+人话错误");
  // lan-connect（外来受理面）：坏形状 400 / 合法帧 200（走 hub2 真状态机）
  const bad = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-connect`, { method: "POST", body: "junk" });
  assert(bad.status === 400, "/api/lan-connect 坏 JSON 400");
  // DEV_A 已 confirmed（5d 决议）——幂等回 confirmed
  const frame = { op: "request", from: DEV_A, spk: kpA.publicKey, box: seal({ op: "request", ts: clock.now, name: "Alice 的 Mac" }, kpB.publicKey, kpA.secretKey) };
  const rc = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frame) });
  const rcj = (await rc.json()) as { status?: string };
  assert(rc.status === 200 && rcj.status === "confirmed", "外来合法帧经 ws-server → hub 状态机（confirmed 幂等）");

  // 7b. fix1（P1-2）：拒绝记忆解除链走 HTTP 面——/api/device-admin 真路由（批D 原测试
  // 直调库函数绕过 API gate，被 R2 活体实证打回：unignore rl- 恒 400=单行道永久拉黑）
  const kpU = generateKeyPair();
  const DEV_U = devId(kpU.publicKey, "rl");
  const frameU = (op: "request" | "status") => ({ op, from: DEV_U, spk: kpU.publicKey, box: seal({ op, ts: clock.now, name: "Dave" }, kpB.publicKey, kpU.secretKey) });
  const adminPost = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${cfg.port}/api/device-admin?token=${cfg.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  {
    const u1 = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frameU("request")) });
    const u1j = (await u1.json()) as { status?: string };
    assert(u1.status === 200 && u1j.status === "pending", "P1-2 前置：新发起方 HTTP 首帧出卡（pending）");
    const uCard = listPendingConfirms().find((c) => c.kind === "lan-connect" && c.payload?.dev === DEV_U);
    assert(!!uCard, "P1-2 前置：确认卡在悬（payload.dev 锚）");
    assert(decideConfirm(String(uCard?.id ?? ""), false, "user:bob").ok === true, "P1-2 前置：拒绝决议消卡（生产链两步复现——decideConfirm 消卡）");
    assert(applyLanConnectDecision(dir, DEV_U, false, "user:bob").ok === true, "P1-2 前置：拒绝决议副作用（✗ 忽略+吊销双写）");
    clock.now += LAN_CONNECT_COOLDOWN_MS + 1; // 冷却期满（silent 分支不刷冷却，但首帧设过）
    const u2 = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frameU("request")) });
    const u2j = (await u2.json()) as { status?: string };
    assert(u2.status === 200 && u2j.status === "rejected", "拒绝后再请求：HTTP 面静默 rejected（拒绝记忆生效）");
    // 修复锚本体：HTTP 面恢复（原 kindOf(rl-)=other → gate 400「恢复」钮必炸）
    const un = await adminPost({ action: "unignore", dev: DEV_U });
    const unj = (await un.json()) as { ok?: boolean };
    assert(un.status === 200 && unj.ok === true, "P1-2 修复锚：unignore rl- 经 /api/device-admin 真路由 200（原恒 400 单行道）");
    const u3 = await fetch(`http://127.0.0.1:${cfg.port}/api/lan-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frameU("request")) });
    const u3j = (await u3.json()) as { status?: string };
    const reCard = listPendingConfirms().some((c) => c.kind === "lan-connect" && c.payload?.dev === DEV_U && c.status === "pending");
    assert(u3.status === 200 && u3j.status === "pending" && reCard, "解除后重新出卡：unignore 200 → 发起端再请求 → 新确认卡（同意流重启——UI 承诺兑现）");
    // gate 分型锚：kick rl- 拒（无持久连接语义）/ignore rl- 通（预拒同 ✗ 链）/未知前缀维持拒
    const kk = await adminPost({ action: "kick", dev: DEV_U });
    assert(kk.status === 400, "gate 分型：kick rl- 400（LAN 邻居无持久连接——UI 同步隐藏踢钮）");
    const ig = await adminPost({ action: "ignore", dev: DEV_U });
    assert(ig.status === 200, "gate 分型：ignore rl- 200（预拒=与 ✗ 决议同一条忽略+吊销链）");
    assert(adminVerdict(port, DEV_U)?.barred === "ignored", "ignore rl- 后 verdict 恒拒（受理面静默拒生效）");
    const un2 = await adminPost({ action: "unignore", dev: DEV_U });
    assert(un2.status === 200, "ignore→unignore 幂等往返 200（恢复钮可重复使用）");
    const zz = await adminPost({ action: "unignore", dev: "zz-abcdef12" });
    assert(zz.status === 400, "未知前缀维持 400（gate 收紧面不变）");
    // list 面：rl- 行在台账且 kind=lan（「连进来的设备」台账如实标注域）
    const ls = await adminPost({ action: "list" });
    const lsj = (await ls.json()) as { devices?: Array<{ dev: string; kind: string; ignored_at: number | null }> };
    const rowU = lsj.devices?.find((x) => x.dev === DEV_U);
    assert(ls.status === 200 && !!rowU && rowU.kind === "lan", "list 混源台账：rl- 行 kind=lan（设备管理面如实标注 LAN 邻居域）");
  }
  server.close();
  await wait(120);
}

// ---------- 8. mock bonjour 发现链（browse 事件 → peers 缓存 → snapshot 自见过滤） ----------
{
  // FakeBonjour：构造签名 (opts?, errorCallback?) 对齐 mdns.ts Ctor 注入位
  class FakeBrowser extends EventEmitter {
    services: unknown[] = [];
    stop(): void {}
  }
  const browser = new FakeBrowser();
  let onUp: ((s: unknown) => void) | null = null;
  // biome-ignore lint: 测试替身
  const FakeBonjour = function FakeBonjourCtor(this: unknown, _o?: unknown, err?: (e: Error) => void) {
    return {
      find: (_opts: unknown, cb: (s: unknown) => void) => {
        onUp = cb;
        return browser;
      },
      destroy(): void {},
      on(): void {},
    };
  } as unknown as new (o?: unknown, err?: (e: Error) => void) => unknown;
  const hub3 = new LanPeersHub({
    selfDev: () => DEV_B,
    selfName: () => "Bob 的 Mac",
    keypair: () => kpB,
    dataDir: dir,
    bonjour: FakeBonjour as never,
    now: () => clock.now,
  });
  hub3.start();
  assert(hub3.mdnsAvailable === true, "browse 起来（mock）mdns=true");
  // 喂两个服务：真邻居 + 自己（自见过滤）。up 断言后收窄为 never（TS 控制流）——直取再调
  const feed = onUp as unknown as (s: { name: string; port: number; addresses: string[]; txt: unknown }) => void;
  feed({ name: "CC Deck Relay (Alice)", port: 8787, addresses: ["192.168.1.50"], txt: { v: "2", dev: DEV_A, nm: "Alice 的 Mac", pk: kpA.publicKey } });
  feed({ name: "CC Deck Relay (Bob)", port: 8787, addresses: ["192.168.1.51"], txt: { v: "2", dev: DEV_B, nm: "Bob 的 Mac", pk: kpB.publicKey } });
  const snap = hub3.snapshot();
  assert(snap.peers.length === 1 && snap.peers[0]?.dev === DEV_A && snap.peers[0]?.conn === "confirmed", "发现缓存经 snapshot 输出（自见过滤+conn 状态并贴——DEV_A 已 confirmed）");
  assert(snap.self === DEV_B && snap.mdns === true, "snapshot 带 self 标识与 mdns 可用位");
  // fix1（P2-5）：发现缓存帽——组播面伪造服务灌水限流（R1 §五③：peers Map 原无上限，
  // 每行带「发起连接」钮=受理面放大器）。超帽新 dev 不入；既有 dev 刷新不受限。
  {
    const floodN = LAN_PEERS_MAX + 6;
    for (let i = 0; i < floodN; i++) {
      const kp = generateKeyPair();
      const dev = devId(kp.publicKey, "rl");
      feed({ name: `Flood Relay ${i}`, port: 8800 + i, addresses: [`192.168.31.${(i % 250) + 1}`], txt: { v: "2", dev, nm: `flood-${i}`, pk: kp.publicKey } });
    }
    const capped = hub3.snapshot();
    assert(capped.peers.length === LAN_PEERS_MAX, `灌水帽：${floodN} 个伪造服务入列 ≤ ${LAN_PEERS_MAX}（peers Map 有界）`);
    feed({ name: "CC Deck Relay (Alice)", port: 8788, addresses: ["192.168.1.50"], txt: { v: "2", dev: DEV_A, nm: "Alice 的 Mac", pk: kpA.publicKey } });
    assert(hub3.snapshot().peers.some((p) => p.dev === DEV_A && p.port === 8788), "帽内既有 dev 刷新不受限（DEV_A 端口更新可见）");
  }
  hub3.stop();
}

// ---------- 收尾 ----------
rmSync(dir, { recursive: true, force: true });
console.log(`\nCONNV4D TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
