// 云桥测试：
//  A) CloudRouter 纯核心单元（无 socket）：路由/ROUTE_MISS/顶替/坏帧
//  B) 真实服务冒烟：鉴权失败、双设备密文帧互通、离线 ROUTE_MISS、同 dev 顶替
//  C) T1a 租户：服务单元（strict 矩阵/FileStore 持久往返/邀请时效钟）+ 全链矩阵
//    （tenantSmoke 与 CF 形态同一矩阵=同构断言）
import { CloudRouter, type RouterHooks } from "../src/router.js";
import { startCloudServer } from "../src/index.js";
import { bridgeSmoke, tenantSmoke } from "./smoke.js";
import { TenantService, MemoryStore } from "../src/tenant.js";
import { FileStore } from "../src/store-file.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
    process.exitCode = 1;
  } else {
    console.log(`ok - ${msg}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- A) router 单元 ----------

interface Recorded {
  sent: [string, string][];
  closed: [string, number, string][];
}
function makeRouter(): { router: CloudRouter; rec: Recorded } {
  const rec: Recorded = { sent: [], closed: [] };
  const hooks: RouterHooks = {
    send: (connId, frame) => rec.sent.push([connId, frame]),
    close: (connId, code, reason) => rec.closed.push([connId, code, reason]),
  };
  return { router: new CloudRouter({ hooks }), rec };
}

{
  const { router, rec } = makeRouter();
  router.register("c1", "relay1");
  router.register("c2", "phone1");
  assert(router.devs().length === 2, "两个设备登记");

  router.handleFrame("c1", JSON.stringify({ to: "phone1", data: { n: "AA", c: "BB" } }));
  assert(
    rec.sent.length === 1 && rec.sent[0][0] === "c2" &&
      JSON.parse(rec.sent[0][1]).from === "relay1",
    "帧按 dev 路由并带 from",
  );

  router.handleFrame("c2", JSON.stringify({ to: "ghost", data: {} }));
  const miss = rec.sent.filter(([, f]) => f.includes("ROUTE_MISS"));
  assert(miss.length === 1 && JSON.parse(miss[0][1]).to === "ghost", "目标离线回 ROUTE_MISS");

  router.handleFrame("c2", "not-json");
  assert(rec.sent.some(([, f]) => f.includes('"ERROR"')), "坏 JSON 回 ERROR 且连接存活");

  router.handleFrame("c2", JSON.stringify({ wrong: 1 }));
  assert(
    rec.sent.filter(([, f]) => f.includes("bad frame")).length === 1,
    "缺 to/data 回 bad frame",
  );

  router.register("c3", "phone1"); // 同 dev 顶替
  assert(rec.closed.some(([id, code]) => id === "c2" && code === 4000), "同 dev 新连接踢掉旧连接");

  router.unregister("c2"); // 已被顶替的旧连接 close 事件后到，不应误删新映射
  assert(router.devOfConn("c3") === "phone1", "顶替后的映射不被旧连接 close 破坏");

  // #29（B-P2）：connOfDev 反查（适配器区分「旧 poll 可顶替」与「活跃 WS 不可踢」用）
  assert(router.connOfDev("phone1") === "c3" && router.connOfDev("ghost") === undefined, "connOfDev 反查占用连接");

  router.unregister("c3");
  assert(router.devs().length === 1, "注销后设备移除");
}

// ---------- A2) 发现帧与 rk 记账（网页 relay 指纹自愈） ----------
{
  const { router, rec } = makeRouter();
  router.register("r1", "rl-abc", "RK1"); // relay 连接上报公钥
  router.register("w1", "wb-1", "RK-WB"); // 浏览器连接即使带 rk 也不该被下发
  router.handleFrame("w1", JSON.stringify({ to: "*", data: { t: "disc" } }));
  const relays = rec.sent.filter(([, f]) => f.includes('"RELAYS"'));
  assert(relays.length === 1, "发现帧回 RELAYS");
  const parsed = JSON.parse(relays[0][1]);
  assert(
    Array.isArray(parsed.relays) && parsed.relays.length === 1 &&
      parsed.relays[0].dev === "rl-abc" && parsed.relays[0].rk === "RK1",
    "RELAYS 只列 relay 前缀设备并带其上报公钥",
  );

  router.handleFrame("w1", JSON.stringify({ to: "*", data: { t: "other" } }));
  assert(rec.sent.some(([, f]) => f.includes("bad frame")), "非 disc 发现帧回 bad frame");

  // relay 重连不带 rk（老版本 relay）：旧公钥必须清掉，不能残留给发现帧下发
  router.register("r2", "rl-abc");
  router.handleFrame("w1", JSON.stringify({ to: "*", data: { t: "disc" } }));
  const again = rec.sent.filter(([, f]) => f.includes('"RELAYS"'));
  assert(
    again.length === 2 && JSON.parse(again[1][1]).relays[0].rk === "",
    "relay 重连未上报 rk 时清空旧公钥",
  );
}

// ---------- A3) 配对码定位广播路由（多 relay 桥凭码定位） ----------
{
  const { router, rec } = makeRouter();
  router.register("ra", "rl-a", "RKA");
  router.register("rb", "rl-b", "RKB");
  router.register("w1", "wb-1");
  router.register("p1", "ph-1");
  router.handleFrame("w1", JSON.stringify({ to: "*", data: { t: "pair_req", code: "123456", pubkey: "PK1", name: "m", bc: true } }));
  const fwd = rec.sent
    .map(([, f]) => JSON.parse(f) as { to?: string; from?: string; data?: { t?: string; code?: string; bc?: boolean } })
    .filter((p) => p.data?.t === "pair_req");
  assert(fwd.length === 2, "广播 pair_req 转发给所有在线 rl-（恰好 2 份）");
  assert(
    fwd.every((p) => p.from === "wb-1" && p.data?.code === "123456" && p.data?.bc === true && (p.to === "rl-a" || p.to === "rl-b")),
    "广播帧 to=各 relay / from=发送者 / data 原样透传",
  );
  assert(
    !rec.sent.some(([, f]) => f.includes('"ERROR"')) && !rec.sent.some(([, f]) => f.includes("RELAYS")),
    "广播 pair_req 不回 ERROR / 不触发 RELAYS",
  );

  // 旧形态单播 pair_req 不回归：仍按 to 直达单一目标，不扩散
  rec.sent.length = 0;
  router.handleFrame("w1", JSON.stringify({ to: "rl-a", data: { t: "pair_req", code: "1", pubkey: "PK1" } }));
  const uni = rec.sent.map(([, f]) => JSON.parse(f) as { to?: string; data?: { t?: string } }).filter((p) => p.data?.t === "pair_req");
  assert(uni.length === 1 && uni[0].to === "rl-a", "单播 pair_req 仍直达单一目标（不回归）");

  // 零 relay 在线：广播无接收者，也不报错（手机侧靠看门狗超时）
  router.unregister("ra");
  router.unregister("rb");
  rec.sent.length = 0;
  router.handleFrame("w1", JSON.stringify({ to: "*", data: { t: "pair_req", code: "9", pubkey: "PK1", bc: true } }));
  assert(rec.sent.length === 0, "无在线 relay 时广播静默（无 ERROR/无投递）");

  // 通配未知类型仍拒：disc/pair_req 之外的 to:"*" 不放行
  router.handleFrame("w1", JSON.stringify({ to: "*", data: { t: "other" } }));
  assert(rec.sent.some(([, f]) => f.includes("bad frame")), "其他通配帧仍回 bad frame");
}

// ---------- B) 真实服务冒烟（与 Cloudflare 形态共用 bridgeSmoke） ----------

{
  const port = 8799;
  const token = "testtoken123";
  const srv = startCloudServer(port, token);
  await wait(150);
  assert(srv.router.devs().length === 0, "启动后无设备");
  // #29（B-P3）：/health 只回计数不回 dev 列表（与 CF 形态对齐，防在线设备踩点）
  const hr = await fetch(`http://127.0.0.1:${port}/health`);
  const h = (await hr.json()) as { devices: unknown };
  assert(typeof h.devices === "number" && h.devices === 0, "/health 回计数（0）不回 dev 列表");
  // #29 残留备案转正：托管页/JSON 出口统一补安全头（HSTS 除外——本形态裸 HTTP）
  assert(hr.headers.get("x-content-type-options") === "nosniff"
    && hr.headers.get("referrer-policy") === "no-referrer"
    && hr.headers.get("x-frame-options") === "SAMEORIGIN"
    && !hr.headers.get("strict-transport-security"),
    "/health 带安全响应头（nosniff/referrer/frame，无 HSTS）");
  // 托管页只存在于部署布局（/opt/cc-cloud-bridge/web-console/；仓库内该路径无文件
  // → 503 是预期形态）。部署形态锁 200+安全头，仓库形态锁 503 干净回退
  const page = await fetch(`http://127.0.0.1:${port}/`);
  if (page.status === 200) {
    assert(page.headers.get("content-type")?.startsWith("text/html")
      && page.headers.get("x-content-type-options") === "nosniff",
      "托管控制台页 200 + 安全响应头（部署布局）");
  } else {
    assert(page.status === 503, "仓库布局无托管页 → 503 提示（不裸崩）");
  }
  await bridgeSmoke(`ws://127.0.0.1:${port}`, token, assert);
  await srv.close();
  assert(true, "服务正常关闭");
}

// ---------- C) T1a 租户地基 ----------

// C1 单元：strict 矩阵（截止日形态——窗口互通/strict 隔离/null-null 恒互通）
{
  const sent: [string, string][] = [];
  const hooks: RouterHooks = { send: (c, f) => sent.push([c, f]), close: () => undefined };
  let fakeNow = Date.now();
  let strict = false;
  const svc = new TenantService({ store: new MemoryStore(), adminKey: "unit-admin-key-0123456789", strict: () => strict, now: () => fakeNow, send: () => undefined });
  const router = new CloudRouter({ hooks, tenant: svc });
  await svc.ready;
  // 直接往名册塞三设备（绕登录流——登录链在 C3 wire 层测）
  const db = (svc as unknown as { db: { tenants: Record<string, { name: string; created_at: number; sealed: boolean; owner_dev: string | null }>; devices: Record<string, { pubkey: string; tenant: string; joined_at: number; exp: number; revoked_at: number | null }> } }).db;
  db.tenants["t-a"] = { name: "A", created_at: fakeNow, sealed: false, owner_dev: null };
  db.tenants["t-b"] = { name: "B", created_at: fakeNow, sealed: false, owner_dev: null };
  db.devices["x1"] = { pubkey: "k1", tenant: "t-a", joined_at: fakeNow, exp: 0, revoked_at: null };
  db.devices["x2"] = { pubkey: "k2", tenant: "t-a", joined_at: fakeNow, exp: 0, revoked_at: null };
  db.devices["y1"] = { pubkey: "k3", tenant: "t-b", joined_at: fakeNow, exp: 0, revoked_at: null };
  db.devices["n1"] = { pubkey: "k4", tenant: "t-none", joined_at: fakeNow, exp: 0, revoked_at: null };
  delete db.devices["n1"]; // n1 走真 null（不在名册）
  router.register("cx1", "x1");
  router.register("cx2", "x2");
  router.register("cy1", "y1");
  router.register("cn1", "n1");
  assert(svc.visible("x1", "x2") && !svc.visible("x1", "y1") && svc.visible("n1", "x1"), "C1 窗口矩阵：同租户见/跨租户不见/null 互通");
  strict = true;
  assert(!svc.visible("n1", "x1") && !svc.visible("x1", "n1") && svc.visible("n1", "n2"), "C1 strict 矩阵：null 隔离（截止日形态）、null-null 仍互通");
  strict = false;
  // revoked：register 拒（同钥拒重入）
  db.devices["x2"].revoked_at = fakeNow;
  let threw = false;
  try { router.register("cx2b", "x2"); } catch { threw = true; }
  assert(threw, "C1 revoked 设备 register 拒绝（触点①）");
  // 跨租户定向=笼统 ROUTE_MISS（在线也不可探测）
  sent.length = 0;
  router.handleFrame("cx1", JSON.stringify({ to: "y1", data: { t: "p" } }));
  assert(sent.some(([, f]) => f.includes("ROUTE_MISS")), "C1 跨租户定向=笼统 ROUTE_MISS");
}

// C2 单元：邀请时效钟（15min）+ FileStore 持久往返（重启不丢名册）
{
  const dir = mkdtempSync(join(tmpdir(), "t1a-store-"));
  const path = join(dir, "tenants.json");
  let fakeNow = Date.now();
  const svc = new TenantService({ store: new FileStore(path), adminKey: "unit-admin-key-0123456789", now: () => fakeNow, send: () => undefined });
  await svc.ready;
  const replies: Record<string, unknown>[] = [];
  const svc2 = new TenantService({ store: new FileStore(path), adminKey: "unit-admin-key-0123456789", now: () => fakeNow, send: (_c, f) => replies.push(JSON.parse(f)) });
  await svc2.ready;
  await svc2.onFrame("cx", "admin-dev", { t: "tenant_op", op: "tenant-create", args: { name: "持久" }, auth: { admin: "unit-admin-key-0123456789" } } as unknown as Record<string, unknown>);
  await wait(200);
  const created = replies.find((r) => r.type === "tenant_op_ok" && r.op === "tenant-create") as { tid: string; invite: string };
  assert(!!created && created.invite.length >= 24, "C2 tenant-create 经 FileStore 落盘");
  // 邀请时效：把时钟推过 15min → 同码登录被拒
  const rk = Buffer.alloc(32, 0x66).toString("base64");
  const devRl = "rl-" + [...Buffer.from(rk, "base64").subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  fakeNow += 16 * 60 * 1000;
  replies.length = 0;
  await svc2.onFrame("cx2", devRl, { t: "login_req", invite: created.invite, dev: devRl, pubkey: rk });
  await wait(150);
  assert(replies.some((r) => r.type === "login_err"), "C2 邀请 15min 时效过期被拒（注入钟）");
  // 重启往返：新服务实例同文件见名册（tenant-create 落的租户还在）
  const svc3 = new TenantService({ store: new FileStore(path), adminKey: "unit-admin-key-0123456789", send: () => undefined });
  await svc3.ready;
  replies.length = 0;
  const svc3Send = (svc3 as unknown as { opts: { send: (c: string, f: string) => void } }).opts.send;
  (svc3 as unknown as { opts: { send: (c: string, f: string) => void } }).opts.send = (_c, f) => replies.push(JSON.parse(f));
  await svc3.onFrame("cx3", "admin-dev", { t: "tenant_op", op: "tenant-list", auth: { admin: "unit-admin-key-0123456789" } } as unknown as Record<string, unknown>);
  await wait(150);
  void svc3Send;
  const listed = replies.find((r) => r.type === "tenant_op_ok" && r.op === "tenant-list") as { tenants?: { tid: string }[] };
  assert(!!listed && listed.tenants!.some((t) => t.tid === created.tid), "C2 FileStore 重启往返名册不丢（持久同构面）");
  rmSync(dir, { recursive: true, force: true });
}

// C3 全链：tenantSmoke 矩阵（与 CF 形态同一矩阵=同构断言；FileStore 真文件）
{
  const port = 8796;
  const token = "testtoken123";
  const adminKey = "wire-admin-key-0123456789abcdef";
  const dir = mkdtempSync(join(tmpdir(), "t1a-wire-"));
  const srv = startCloudServer(port, token, [], { adminKey, store: new FileStore(join(dir, "tenants.json")) });
  await wait(150);
  assert(srv.tenant !== null, "C3 tenantOpts 注入=租户服务在位");
  await srv.tenant!.ready;
  await tenantSmoke(`ws://127.0.0.1:${port}`, token, adminKey, assert);
  // 重启往返（wire 层）：同文件再起一座——上一轮登录的 RLB 名册仍在（revoked RLA 仍拒）
  await srv.close();
  await wait(400); // 端口释放缓冲（套件负载下 close 回调与 TIME_WAIT 的时序容差）
  const srv2 = startCloudServer(port, token, [], { adminKey, store: new FileStore(join(dir, "tenants.json")) });
  await wait(250);
  await srv2.tenant!.ready;
  // dev/rk 同源派生（与 smoke 的 RLA/RLB 同向量 0x11/0x22）：tryConn 必须带 rk——
  // 不带会先撞 #29 rl- 自洽闸（挂在自洽而非租户层，断言语义就漂了）
  const rkA = Buffer.alloc(32, 0x11).toString("base64");
  const rkB = Buffer.alloc(32, 0x22).toString("base64");
  const rlA = "rl-" + [...Buffer.from(rkA, "base64").subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rlB = "rl-" + [...Buffer.from(rkB, "base64").subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { WebSocket: Ws } = await import("ws");
  const tryConn = (dev: string, rk: string, extra: string): Promise<boolean> =>
    new Promise((resolve) => {
      const ws = new Ws(`ws://127.0.0.1:${port}/cloud?token=${token}&dev=${dev}&rk=${encodeURIComponent(rk)}${extra}`);
      const done = (v: boolean) => { try { ws.terminate(); } catch { /* */ } resolve(v); };
      ws.on("open", () => done(true));
      ws.on("error", () => done(false));
      ws.on("close", () => done(false));
      setTimeout(() => done(false), 3000);
    });
  assert(!(await tryConn(rlA, rkA, "")), "C3 重启后 revoked RLA 仍拒（带 rk 过自洽闸——拒因=租户吊销持久）");
  let rlBOk = await tryConn(rlB, rkB, "");
  if (!rlBOk) { await wait(800); rlBOk = await tryConn(rlB, rkB, ""); } // 时序容差：重试一次（准入幂等）
  assert(rlBOk, "C3 重启后 RLB（在册）准入（名册持久）");
  await srv2.close();
  rmSync(dir, { recursive: true, force: true });
  assert(true, "C3 租户全链+重启往返关闭");
}

if (failures === 0) console.log("CLOUD-BRIDGE TESTS PASSED");
else {
  console.error(`${failures} failures`);
  process.exit(1);
}
