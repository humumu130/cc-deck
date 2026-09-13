// #116 router 多连共存单测：无踢连互撞、下行广播、上限踢旧、relay-online 0→1 单播、unregister 收敛
// 跑法：用 relay 仓库的 tsx 执行（tsx test-router.mjs）
import { CloudRouter } from "./router.ts";

const sent = [];   // {connId, frame}
const closed = []; // {connId, code, reason}
const r = new CloudRouter({
  hooks: {
    send: (connId, frame) => sent.push({ connId, frame }),
    close: (connId, code, reason) => closed.push({ connId, code, reason }),
  },
});
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); };

// ① 同 dev 双连共存不互踢（旧行为：后连踢前连——#116 风暴根因）
r.register("c1", "rl-a", "pk1");
r.register("c2", "rl-a", "pk1");
assert(closed.length === 0, "同 dev 第二条连接不踢第一条");
assert(r.devCount === 1, "dev 计数仍为 1");

// ② relay-online 广播只在 0→1 播一轮（发全体在线连接；二连不重播）
r.register("p1", "wb-phone1");
sent.length = 0;
r.register("z1", "rl-z", "pkz");
const bc1 = sent.filter((s) => s.frame.includes("relay-online"));
assert(bc1.length === 3 && bc1.filter((s) => s.connId === "p1").length === 1, "relay 上线广播一轮（c1/c2/p1 各一份）");
r.register("p2", "wb-phone2");
r.register("z2", "rl-z");
const bc2 = sent.filter((s) => s.frame.includes("relay-online"));
assert(bc2.length === 3, "relay 第二条连接不重播上线广播");

// ③ 下行广播：发给 rl-a 的帧 → c1/c2/c3 都收到
r.register("c3", "rl-a");
sent.length = 0;
r.handleFrame("p1", JSON.stringify({ to: "rl-a", data: { t: "ping" } }));
const got = sent.filter((s) => s.frame.includes("ping")).map((s) => s.connId).sort();
assert(JSON.stringify(got) === JSON.stringify(["c1", "c2", "c3"]), `广播投递全部 3 连（got ${got}）`);

// ④ ROUTE_MISS：目标不在线
sent.length = 0;
r.handleFrame("p1", JSON.stringify({ to: "rl-none", data: {} }));
assert(sent.some((s) => s.frame.includes("ROUTE_MISS")), "离线目标回 ROUTE_MISS");

// ⑤ 每带上限：第 5 连踢最旧（c1）
r.register("c4", "rl-a");
assert(closed.length === 0, "第 4 连在上限内不踢");
r.register("c5", "rl-a");
assert(closed.length === 1 && closed[0].connId === "c1" && closed[0].code === 4000, "第 5 连踢最旧 c1");

// ⑥ unregister 一条后其余照常路由；全撤后 dev 消失
r.unregister("c5");
sent.length = 0;
r.handleFrame("p1", JSON.stringify({ to: "rl-a", data: { t: "x" } }));
assert(sent.filter((s) => s.frame.includes('"x"')).length === 3, "撤一条后其余 3 连照常收");
r.unregister("c2"); r.unregister("c3"); r.unregister("c4");
sent.length = 0;
r.handleFrame("p1", JSON.stringify({ to: "rl-a", data: { t: "y" } }));
assert(sent.some((s) => s.frame.includes("ROUTE_MISS")), "全撤后回 ROUTE_MISS");
assert(r.devCount === 3, "dev 计数收敛（rl-a 释放，剩 rl-z + 两手机）");

// ⑦ pair_req 广播到 rl- 的每条连接
r.register("k1", "rl-b");
r.register("k2", "rl-b");
sent.length = 0;
r.handleFrame("p1", JSON.stringify({ to: "*", data: { t: "pair_req", code: "12345678" } }));
const pairGot = sent.filter((s) => s.frame.includes("pair_req")).map((s) => s.connId).sort();
assert(JSON.stringify(pairGot) === JSON.stringify(["k1", "k2", "z1", "z2"]), `pair_req 投给全部在线 relay 的全部连接（got ${pairGot}）`);

console.log("\nROUTER TESTS PASSED");
