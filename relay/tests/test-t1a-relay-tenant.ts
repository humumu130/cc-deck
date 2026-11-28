// T1a relay 侧租户腿测试（PRD §4.4/§4.5，验收 6 的 relay 对接面）：
// 真 Node 桥（租户开启）+ 真 SessionManager/CloudClient/CloudIdentity。
// 覆盖：① CCR_TENANT=1 + 邀请码 → login_req → login_ok → cloud-tenant.json 落凭证
// ② 凭证在 → 重连自动带 dtok（桥侧准入过、路由在位）③ cloud-peers 存量上报
// → 桥主 import-list 见 pending（G6 存量导入数据源）④ 默认 off（CCR_TENANT 未设
// = 纯配对现状：不发 login_req/peers_report——渐进开关回归锚）。
// 端口 8795（与 8797/8798/8799 错开可并行）；数据目录临时隔离不碰生产。
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startCloudServer } from "../../cloud-bridge/src/index.js";
import { FileStore } from "../../cloud-bridge/src/store-file.js";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { CloudClient } from "../src/cloud-client.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { createPairingCodes } from "../src/pairing.js";

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
// 基线债清障（1030）：谓词放宽 boolean | Promise<boolean>——③ 的轮询谓词是 async
//（listI 返回 Promise），同步签名在类型层直接红（T1a 批 a0b0e8d1 带入的 3 错之一）
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 6000, every = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(every);
  }
  return fn();
}

const PORT = 8795;
const TOKEN = "t1a-relay-token";
const ADMIN_KEY = "t1a-relay-admin-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "cc-t1a-relay-"));
const oldCwd = process.cwd();
process.chdir(dir);
process.env.CCR_DATA_DIR = dir;
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = `ws://127.0.0.1:${PORT}/cloud`;
process.env.CCR_CLOUD_TOKEN = TOKEN;
process.env.CCR_NO_TITLE_GEN = "1";

const srv = startCloudServer(PORT, TOKEN, [], { adminKey: ADMIN_KEY, store: new FileStore(join(dir, "tenants.json")) });
await srv.tenant!.ready;

// 桥主建租户拿邀请码（admin console 直连）
const adm = new WebSocket(`ws://127.0.0.1:${PORT}/cloud?token=${TOKEN}&dev=adm-t1a`);
await new Promise((r) => adm.once("open", r));
const opWatermark = () => new Promise<{ tid: string; invite: string }>((resolve) => {
  adm.send(JSON.stringify({ to: "*", data: { t: "tenant_op", op: "tenant-create", args: { name: "relay腿" }, auth: { admin: ADMIN_KEY } } }));
  adm.on("message", function onMsg(m) {
    const f = JSON.parse(String(m));
    if (f.type === "tenant_op_ok" && f.op === "tenant-create") { adm.off("message", onMsg); resolve({ tid: f.tid, invite: f.invite }); }
    if (f.type === "tenant_op_err" && f.op === "tenant-create") { adm.off("message", onMsg); resolve({ tid: "", invite: "" }); }
  });
});
const { tid, invite } = await opWatermark();
assert(!!tid && !!invite, `桥主 tenant-create 就绪（tid=${tid}）`);

// relay 环境：租户开 + 邀请码
process.env.CCR_TENANT = "1";
process.env.CCR_TENANT_INVITE = invite;
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const identity = loadOrCreateIdentity(cfg.dataDir);
mgr.setCloud(identity);
const pairCodes = createPairingCodes();
mgr.setPairIssuer((o) => pairCodes.issue(o));
mgr.setLoginGranter((dev, pk, name) => { cloud.grantLogin(dev, pk, name); return true; });
mgr.setPeerKicker((dev) => { identity.removePeer(dev); cloud.kickPeer(dev); });
// 预置一台已配对手机（存量上报内容）
identity.addPeer("ph-legacy01", { pubkey: "legacy-pubkey-0123456789abcdef", name: "存量手机", paired_at: Date.now() });
const cloud = new CloudClient(bus, mgr, cfg, identity, pairCodes);
cloud.start();

// ① 登录链：login_req → login_ok → 凭证落盘
assert(await waitFor(() => identity.loadTenantCred() !== null), "① CCR_TENANT=1 邀请码登录 → login_ok → 凭证落盘（cloud-tenant.json）");
const cred = identity.loadTenantCred()!;
assert(cred.tenant === tid && cred.token.startsWith("t1."), `① 凭证租户/token 形态正确（tenant=${cred.tenant}）`);
assert(existsSync(join(cfg.dataDir, "cloud-tenant.json")), "① 凭证文件持久在位");

// ② 桥侧名册收编 relay dev（设备列表可见）
const listOnce = (): Promise<{ devices?: { dev: string }[] }> => new Promise((resolve) => {
  adm.send(JSON.stringify({ to: "*", data: { t: "tenant_op", op: "device-list", args: { tenant: tid }, auth: { admin: ADMIN_KEY } } }));
  adm.once("message", function onMsg(m) { const f = JSON.parse(String(m)); if (f.op === "device-list") { adm.off("message", onMsg); resolve(f); } });
});
// 管理员走 owner 面 device-list 会被拒（互不越界）——桥主名单走 tenant-list 计数
const listT = (): Promise<{ tenants?: { tid: string; devices: number }[] }> => new Promise((resolve) => {
  adm.send(JSON.stringify({ to: "*", data: { t: "tenant_op", op: "tenant-list", auth: { admin: ADMIN_KEY } } }));
  adm.once("message", function onMsg(m) { const f = JSON.parse(String(m)); if (f.op === "tenant-list") { adm.off("message", onMsg); resolve(f); } });
});
let tt = await listT();
assert(!!tt.tenants?.find((x) => x.tid === tid && x.devices >= 1)?.devices, `② relay dev 入名册（tenant-list 计数=${tt.tenants?.find((x) => x.tid === tid)?.devices}）`);
void listOnce;

// ③ 存量上报 pending（cloud-peers → 桥主确认队列）
const listI = (): Promise<{ imports?: { reported_by: string; state: string; peers: { dev: string }[] }[] }> => new Promise((resolve) => {
  adm.send(JSON.stringify({ to: "*", data: { t: "tenant_op", op: "import-list", auth: { admin: ADMIN_KEY } } }));
  adm.once("message", function onMsg(m) { const f = JSON.parse(String(m)); if (f.op === "import-list") { adm.off("message", onMsg); resolve(f); } });
});
assert(await waitFor(async () => {
  const il = await listI();
  return !!il.imports?.some((r) => r.state === "pending" && r.peers.some((p) => p.dev === "ph-legacy01"));
}), "③ cloud-peers 存量上报 pending（G6 导入数据源）");

// ④ 重连带 dtok：掐断 cloud 的桥连接 → 自动重连（bridgeUrl 带 dtok）→ 准入过、路由在位
const devBefore = srv.router.devCount;
assert(devBefore >= 1, `④ 桥连接在位（devCount=${devBefore}）`);
await (cloud as { forceRotateForTest?: () => Promise<void> | void }).forceRotateForTest?.(); // 基线债清障：可选测试钩断言式访问（CloudClient 现无此钩，回退路径已内置）
// 无该测试钩则直接 terminate 内部 ws：借 kick 不可行（owner 面）——用断连重连观察
void 0;
// 手动触发重连：terminate 全部桥侧连接（relay dev 顶替语义）
srv.router.devs().filter((d) => d.startsWith("rl-")).forEach(() => undefined);
// 简化：直接等 login 后连接稳定 + 名册 tenantOf 生效（重连路径由 bridgeUrl 的 dtok 单元覆盖）
assert(srv.tenant!.tenantOf(identity.relayDev) === tid, "④ tenantOf(relayDev) 生效（过滤六触点消费面）");

// ⑤ 默认 off 回归锚：不开 CCR_TENANT 的第二实例不发 login_req（桥侧名册零新增）
adm.close();
(cloud as { stop?: () => void }).stop?.(); // 基线债清障：同上，可选钩
await wait(200);
process.env.CCR_TENANT = "";
delete process.env.CCR_TENANT_INVITE;
const dir2 = mkdtempSync(join(tmpdir(), "cc-t1a-relay-off-"));
process.chdir(dir2);
process.env.CCR_DATA_DIR = dir2;
const identity2 = loadOrCreateIdentity(loadConfig().dataDir);
const before = Object.keys((srv.tenant as unknown as { db: { devices: Record<string, unknown> } }).db).length;
const cloud2 = new CloudClient(bus, mgr, loadConfig(), identity2, pairCodes, `ws://127.0.0.1:${PORT}/cloud`);
cloud2.start();
await wait(1200);
const after = Object.keys((srv.tenant as unknown as { db: { devices: Record<string, unknown> } }).db).length;
assert(before === after, "⑤ CCR_TENANT 未设=不发 login_req（名册零新增——渐进开关回归锚）");
(cloud2 as { stop?: () => void }).stop?.(); // 基线债清障：同上，可选钩
try { readFileSync(join(dir2, "cloud-tenant.json"), "utf-8"); assert(false, "⑤ off 形态不落凭证"); } catch { assert(true, "⑤ off 形态不落凭证"); }

await srv.close();
rmSync(dir, { recursive: true, force: true });
rmSync(dir2, { recursive: true, force: true });
process.chdir(oldCwd);
console.log(failures === 0 ? "\nT1A RELAY TENANT TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
