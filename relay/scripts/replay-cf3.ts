// 日志回放（tsx 转译）：僵尸 park→停推→换桥停→hello 复活
import { CloudClient } from "../src/cloud-client.ts";
const c = Object.create(CloudClient.prototype) as any;
c.phones = new Map([["ph-9ba39", { lastSeq: 100, active: true }], ["wb-40d555", { lastSeq: 200, active: true }], ["ph-neverhello", { lastSeq: 50, active: true }]]);
c.lastHelloAt = new Map([["wb-40d555", Date.now() - 1000], ["ph-9ba39", Date.now() - 1000]]); // ph-9ba39 近期有 hello（场景①验证 park 路径）；neverhello 无
c.wanWatches = new Map();
c.routeRetryTimers = new Map();
c.routeMissStreak = 0; c.lastMissKickAt = 0;
c.deviceMissCount = new Map(); c.parkedDevices = new Set(); c.wbSightings = new Map(); c.unpairedNotice = new Map();
let rotated = 0;
c.ws = { readyState: 1, terminate: () => rotated++ };
const miss = (to: string) => { try { CloudClient.prototype.onFrame.call(c, JSON.stringify({ type: "ROUTE_MISS", to })); } catch (e: any) { console.log("onFrame err:", String(e.message).slice(0, 80)); } };
for (let i = 1; i <= 5; i++) { c.lastMissKickAt = 0; miss("ph-9ba39"); }
console.log("① 僵尸 5 miss：parked=", c.parkedDevices.has("ph-9ba39"), "rotated=", rotated);
const rotBefore = rotated;
c.lastMissKickAt = 0; miss("ph-9ba39"); miss("ph-9ba39");
console.log("② parked 后 2 miss：rotated 增量=", rotated - rotBefore, "（应 0）");
const blockedZombie = c.sendSealed("ph-9ba39", {}) === false;
console.log("③ sendSealed 僵尸拦=", blockedZombie);
c.parkedDevices.delete("ph-9ba39"); c.deviceMissCount.delete("ph-9ba39");
// unpark 后门放行验证：delete 后 parkedDevices 不含即门已开（真 seal 需 32B 密钥不在此跑）
const resumed = !c.parkedDevices.has("ph-9ba39");
console.log("④ unpark 后门放行=", resumed);
// W-ZOMBIEX ⑤：5min 零 hello 僵尸（从未 hello 过=lastHelloAt 空）——miss 不进风暴不计数
const rotZ = rotated;
c.lastMissKickAt = 0;
miss("ph-neverhello"); // 从未 hello 的 dev（真僵尸重装前身份常见态）
console.log("⑤ 5min 零 hello 僵尸 miss：rotated 增量=", rotated - rotZ, "计数=", c.deviceMissCount.get("ph-neverhello") ?? 0, "（应 0/0——hello 过滤在计数前）");
const zOk = (rotated - rotZ) === 0 && (c.deviceMissCount.get("ph-neverhello") ?? 0) === 0;
const pass = c.parkedDevices.has("ph-9ba39") === false && rotated >= 1 && (rotated - rotBefore) === 0 && blockedZombie && zOk;
console.log(pass ? "== 回放 PASS ==" : "== FAIL ==");
process.exit(pass ? 0 : 1);
// W-ZOMBIEx 增量场景⑤：5min 零 hello 僵尸——miss 不进风暴（未 park 也静默）
// （追加执行体：独立小节，不破坏原四场景）
