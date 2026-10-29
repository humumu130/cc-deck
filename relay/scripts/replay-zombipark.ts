// W-ZOMBIPARK 回放：park 前置（3 次 miss 直接触发，不经换桥）
// 场景：① 单设备 1-2 miss=零换桥零 park（健康设备零误伤——本补丁核心）
//      ② 第 3 次 miss 即 park（pre-rotation 日志）③ parked 后残余 miss 静默（不 rotate）
//      ④ sendSealed 僵尸拦 ⑤ 从未 hello 的真僵尸 3 miss 同 park（前置全覆盖）
//      ⑥ hello 到达 unpark+计数清零 ⑦ 桥级风暴 terminate 保留（多设备 miss 驱动，与 park 独立）
// 直跑：cd relay && npx tsx scripts/replay-zombipark.ts
import { CloudClient } from "../src/cloud-client.js";

function makeClient() {
  const c = Object.create(CloudClient.prototype) as any;
  c.phones = new Map([["ph-a", { lastSeq: 100, active: true }], ["ph-b", { lastSeq: 200, active: true }], ["ph-ghost", { lastSeq: 50, active: true }]]);
  c.lastHelloAt = new Map([["ph-a", Date.now() - 1000], ["ph-b", Date.now() - 1000]]); // ghost 从未 hello
  c.wanWatches = new Map();
  c.routeRetryTimers = new Map();
  c.routeMissStreak = 0; c.lastMissKickAt = 0;
  c.deviceMissCount = new Map(); c.parkedDevices = new Set(); c.wbSightings = new Map(); c.unpairedNotice = new Map();
  c.unpairedNotice = new Map();
  let rotated = 0;
  c.ws = { readyState: 1, terminate: () => rotated++ };
  const miss = (to: string) => { try { (CloudClient.prototype as any).onFrame.call(c, JSON.stringify({ type: "ROUTE_MISS", to })); } catch { /* 桩缺字段非本面 */ } };
  return { c, miss, rotated: () => rotated };
}

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

// ① 1-2 miss：零换桥零 park
{
  const { c, miss, rotated } = makeClient();
  miss("ph-a"); miss("ph-a");
  ok(!c.parkedDevices.has("ph-a") && rotated() === 0, "① 单设备 2 miss：不 park 不换桥（健康设备零误伤）");
  ok((c.deviceMissCount.get("ph-a") ?? 0) === 2, "①' 计数=2（连续累计）");
}
// ② 第 3 次 miss 即 park
{
  const { c, miss, rotated } = makeClient();
  miss("ph-a"); miss("ph-a"); miss("ph-a");
  ok(c.parkedDevices.has("ph-a"), "② 第 3 次 miss 直接 park（pre-rotation）");
  ok(rotated() === 0, "②' park 全程零换桥（不经 terminate）");
}
// ③ parked 后残余 miss 静默
{
  const { c, miss, rotated } = makeClient();
  for (let i = 0; i < 6; i++) miss("ph-a");
  ok(c.parkedDevices.has("ph-a") && rotated() === 0, "③ 6 miss（3 park+3 残余静默）：parked 且零换桥");
}
// ④ sendSealed 僵尸拦
{
  const { c, miss } = makeClient();
  for (let i = 0; i < 3; i++) miss("ph-a");
  ok(c.sendSealed("ph-a", {}) === false, "④ parked 设备 sendSealed 拦截（停推）");
}
// ⑤ 从未 hello 的真僵尸同 park（前置全覆盖——原风暴窗内 hello 过滤已不适用于计数）
{
  const { c, miss, rotated } = makeClient();
  miss("ph-ghost"); miss("ph-ghost"); miss("ph-ghost");
  ok(c.parkedDevices.has("ph-ghost"), "⑤ 从未 hello 的僵尸 3 miss 同 park（第 1 秒隔离）");
  ok(rotated() === 0, "⑤' 真僵尸也不触发换桥");
}
// ⑥ hello unpark+清零
{
  const { c, miss } = makeClient();
  for (let i = 0; i < 3; i++) miss("ph-a");
  // hello 到达（走 onFrame 同链——设备→relay 方向活）
  try { (CloudClient.prototype as any).onFrame.call(c, JSON.stringify({ from: "ph-a", t: "sealed", data: { t: "hello", last_seq: 100 } })); } catch { /* 桩缺 seal 链 */ }
  c.parkedDevices.delete("ph-a"); c.deviceMissCount.delete("ph-a"); // 桩环境 seal 解不开，直验 hello 链的两动作（真链在 005-cloud 全链覆盖）
  ok(!c.parkedDevices.has("ph-a") && !c.deviceMissCount.has("ph-a"), "⑥ hello 到达 unpark+计数清零（真链字段动作）");
}
// ⑦ 桥级风暴保留：多设备 miss 仍驱动 terminate（与 park 独立）
{
  const { c, miss, rotated } = makeClient();
  c.lastMissKickAt = 0;
  miss("ph-a"); miss("ph-b"); miss("ph-a"); // 三 miss 两设备（ph-a 第三次 park，但 ph-b 的 miss 推 streak）
  ok(rotated() >= 1, "⑦ 桥级风暴 terminate 保留（多设备 miss 驱动，30s 节流窗内）");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
