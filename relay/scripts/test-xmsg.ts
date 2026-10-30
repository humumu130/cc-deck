// X1 密封 xmsg 单元测试：域核心（xmsg.ts 账本/校验/限速/标注）+ device_trust 表（schema v7）。
// 纯单元面（无桥无会话）；全链双机沙盒见 test-xmsg-e2e.ts。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-xmsg.ts
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, devId } from "../src/e2e.js";
import {
  annotateBody, isXackWire, isXmsgWire, openXmsgStores, spkMatchesDev, validateXmsgInner,
  XmsgRateGate, XMSG_HELD_MAX_PER_DEV, XMSG_SEEN_WINDOW_MS,
  type XmsgInner,
} from "../src/xmsg.js";
import {
  confirmDevice, getDeviceTrust, listDeviceTrust, revokeDevice, trustStore, trustVerdict, upsertFirstSeen,
} from "../src/device-trust.js";
import { migrations } from "../src/storage/schema.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- 0. 隔离纪律 ----------
const dir = mkdtempSync(join(tmpdir(), "cc-xmsg-unit-"));
process.env.CCR_DATA_DIR = dir;
process.env.CCR_ORG_DIR = join(dir, "org");
const T0 = 1_700_000_000_000;
let fakeNow = T0;
const now = () => fakeNow;

console.log("信封校验（validateXmsgInner 矩阵）:");
const good = (): XmsgInner => ({
  t: "xmsg", v: 1, tenant: "t-1", source: { dev: "rl-aaaaaaaa", session: "sess-1234abcd" }, target: { session: "sess-1234" },
  msg_id: "xm-0011223344556677", ts: T0, ttl: 300_000, ack_req: true, body: "hello",
});
assert(validateXmsgInner(good(), T0 + 1000).ok, "合法信封通过");
assert(!validateXmsgInner({ ...good(), t: "xack" as never }, T0).ok, "type 非 xmsg 拒");
assert(!validateXmsgInner({ ...good(), v: 2 as never }, T0).ok, "version≠1 拒");
assert(validateXmsgInner({ ...good(), tenant: null }, T0).ok, "tenant=null 合法（未登录迁移窗）");
assert(!validateXmsgInner({ ...good(), source: { dev: "ph-aaaa" } }, T0).ok, "source 非 rl- 拒");
assert(!validateXmsgInner({ ...good(), msg_id: "x" }, T0).ok, "msg_id 过短拒");
assert(!validateXmsgInner({ ...good(), msg_id: "x".repeat(65) }, T0).ok, "msg_id 过长拒");
assert(!validateXmsgInner({ ...good(), ttl: 9_000_000 }, T0).ok, "ttl 超上限拒");
assert(!validateXmsgInner({ ...good(), ts: T0 - 301_000, ttl: 300_000 }, T0).ok, "过期拒（ts+ttl<now）");
assert(!validateXmsgInner({ ...good(), ts: T0 + 61_000 }, T0).ok, "未来钟漂 >60s 拒");
assert(!validateXmsgInner({ ...good(), body: "x".repeat(32 * 1024 + 1) }, T0).ok, "body >32KB 拒（D2）");
assert(!validateXmsgInner({ ...good(), body: "" }, T0).ok, "空 body 拒");
assert(validateXmsgInner({ ...good(), target: {} }, T0).ok, "target.session 缺省合法（值班位）");

console.log("来源标注（§4.3 不可剥离前缀）：");
const ann1 = annotateBody(good());
assert(ann1.startsWith("⇄跨机 · 来自 rl-aaaaaaaa 会话 sess-123 · 非本机手输\n"), "带来源会话标注格式（sid8=sess-1234abcd 前 8 位）");
const ann2 = annotateBody({ ...good(), source: { dev: "rl-aaaaaaaa" }, target: {} });
assert(ann2.startsWith("⇄跨机 · 来自 rl-aaaaaaaa（值班位）· 非本机手输\n"), "无来源会话=值班位标注");

console.log("线形状与 dev↔spk 自洽：");
const kpA = generateKeyPair();
const devA = devId(kpA.publicKey, "rl");
assert(spkMatchesDev(kpA.publicKey, devA), "spk 与派生 dev 自洽");
assert(!spkMatchesDev(generateKeyPair().publicKey, devA), "他钥 spk 不自洽");
assert(isXmsgWire({ t: "xmsg", v: 1, spk: kpA.publicKey, env: { n: "n", c: "c" } }), "xmsg 线形状识别");
assert(!isXmsgWire({ t: "xmsg", v: 1, spk: kpA.publicKey }), "缺 env=明文壳 → 非 xmsg 线（即丢路径）");
assert(isXackWire({ t: "xack", v: 1, spk: "k", env: { n: "n", c: "c" } }), "xack 线形状识别");

console.log("outbox（落盘/状态机/ttl 收口/终态修剪）：");
const st = openXmsgStores(dir, now);
st.outbox.append({ msg_id: "xm-o1", dev: "rl-bbbb", body: "m1", tenant: null, ts: T0 });
assert(st.outbox.get("xm-o1")?.state === "pending", "append 后 pending");
st.outbox.mark("xm-o1", "sent");
assert(st.outbox.get("xm-o1")?.tries === 1, "sent 计一次 try");
st.outbox.mark("xm-o1", "injected");
st.outbox.mark("xm-o1", "pending");
assert(st.outbox.get("xm-o1")?.state === "injected", "终态不可回退（幂等）");
assert(st.outbox.due().length === 0, "终态条目不进 due");
st.outbox.append({ msg_id: "xm-o2", dev: "rl-bbbb", body: "m2", tenant: null, ts: T0 });
fakeNow = T0 + 301_000;
const due = st.outbox.due();
assert(due.length === 0 && st.outbox.get("xm-o2")?.state === "failed" && st.outbox.get("xm-o2")?.detail === "ttl-expired", "ttl 过期未决 → failed:ttl-expired");
// 重开=持久（同一文件）
const st2 = openXmsgStores(dir, now);
assert(st2.outbox.get("xm-o1")?.state === "injected", "outbox 落盘往返");

console.log("seen（24h 同窗幂等）：");
fakeNow = T0; // outbox 段把 fakeNow 推到了 +301s——seen 段从 T0 起算（窗内/窗外判定才干净）
st.seen.record("xm-s1", "queued", undefined, { from: "rl-cccc", spk: "pk-1" });
assert(st.seen.hit("xm-s1")?.state === "queued", "命中缓存态");
assert(st.seen.hit("xm-s1")?.from === "rl-cccc" && st.seen.hit("xm-s1")?.spk === "pk-1", "from/spk 元数据携带（injected 升级回执用）");
assert(st.seen.hit("xm-nope") === null, "未见过=null");
st.seen.record("xm-s1", "injected");
assert(st.seen.hit("xm-s1")?.state === "injected" && st.seen.hit("xm-s1")?.from === "rl-cccc", "升级保留 from/spk");
fakeNow = T0 + XMSG_SEEN_WINDOW_MS + 2_000;
st.seen.record("xm-sweep", "queued");
assert(st.seen.hit("xm-s1") === null, "24h 窗外条目被清（同窗语义）");
assert(st.seen.hit("xm-sweep") !== null, "窗内条目保留");
fakeNow = T0;

console.log("held（首联悬置上限）：");
for (let i = 0; i < XMSG_HELD_MAX_PER_DEV; i++) {
  assert(st.held.hold("rl-dddd", { msg_id: `xm-h${i}`, inner: good(), ts: T0 }), `悬置第 ${i + 1} 条`);
}
assert(!st.held.hold("rl-dddd", { msg_id: "xm-overflow", inner: good(), ts: T0 }), "超上限拒（held-overflow 源）");
assert(st.held.count("rl-dddd") === XMSG_HELD_MAX_PER_DEV, "计数吻合");
const drained = st.held.drain("rl-dddd");
assert(drained.length === XMSG_HELD_MAX_PER_DEV && st.held.count("rl-dddd") === 0, "drain 清空");

console.log("限速闸（每对每秒 2 条，§4.8）：");
const gate = new XmsgRateGate(2, 1000, now);
assert(gate.allow("rl-e1") && gate.allow("rl-e1"), "窗内前 2 条过");
assert(!gate.allow("rl-e1"), "第 3 条拒");
assert(gate.allow("rl-e2"), "异对不受影响（per-pair）");
fakeNow = T0 + 1_100;
assert(gate.allow("rl-e1"), "窗口滑动后恢复");

console.log("peer 公钥缓存（disc/来帧双源）：");
st.peers.put("rl-ffff", "pk-ffff");
assert(openXmsgStores(dir, now).peers.get("rl-ffff") === "pk-ffff", "peers 落盘往返");

console.log("device_trust（schema v7 四态生命周期）：");
assert(migrations.some((m) => m.version === 7 && m.name.includes("device-trust")), "v7 迁移在册");
const port = trustStore(dir);
assert(port !== null, "trustStore 可用（sqlite 驱动在场）");
assert(getDeviceTrust(port, devA) === null, "首见前无记录");
assert(upsertFirstSeen(port, devA, kpA.publicKey, "t-1", "xm-f1") === "created", "首见登记 created");
assert(trustVerdict(port, devA, kpA.publicKey).state === "pending", "首见后=pending");
assert(upsertFirstSeen(port, devA, kpA.publicKey, "t-1") === "exists", "幂等 exists");
const kpFake = generateKeyPair();
assert(upsertFirstSeen(port, devA, kpFake.publicKey, "t-1") === "mismatch", "同 dev 换钥=mismatch（钉扎）");
assert(trustVerdict(port, devA, kpFake.publicKey).state === "mismatch", "换钥裁决 mismatch");
assert(confirmDevice(port, devA, "user@e2e").ok, "确认成功");
assert(trustVerdict(port, devA, kpA.publicKey).state === "confirmed", "确认后=confirmed");
assert(confirmDevice(port, devA, "again").ok, "确认幂等");
assert(listDeviceTrust(port).length >= 1, "列表可读");
const devB2 = devId(generateKeyPair().publicKey, "rl");
upsertFirstSeen(port, devB2, generateKeyPair().publicKey, null);
assert(revokeDevice(port, devB2, "测试吊销").ok, "吊销成功");
assert(trustVerdict(port, devB2, getDeviceTrust(port, devB2)!.pubkey).state === "revoked", "吊销后=revoked");
assert(!confirmDevice(port, devB2, "x").ok, "已吊销不可直接确认");
assert(upsertFirstSeen(port, devB2, getDeviceTrust(port, devB2)!.pubkey, null) === "exists", "吊销态不复活（exists 维持 revoked 行）");
// 持久：重开库行仍在
const port2 = trustStore(dir);
assert(port2 !== null && trustVerdict(port2, devA, kpA.publicKey).state === "confirmed", "跨开库信任持久");

rmSync(dir, { recursive: true, force: true });
console.log(`XMSG UNIT: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
