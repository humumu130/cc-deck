// 云桥测试：
//  A) CloudRouter 纯核心单元（无 socket）：路由/ROUTE_MISS/顶替/坏帧
//  B) 真实服务冒烟：鉴权失败、双设备密文帧互通、离线 ROUTE_MISS、同 dev 顶替
import { CloudRouter, type RouterHooks } from "../src/router.js";
import { startCloudServer } from "../src/index.js";
import { bridgeSmoke } from "./smoke.js";

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

// ---------- B) 真实服务冒烟（与 Cloudflare 形态共用 bridgeSmoke） ----------

{
  const port = 8799;
  const token = "testtoken123";
  const srv = startCloudServer(port, token);
  await wait(150);
  assert(srv.router.devs().length === 0, "启动后无设备");
  await bridgeSmoke(`ws://127.0.0.1:${port}`, token, assert);
  await srv.close();
  assert(true, "服务正常关闭");
}

if (failures === 0) console.log("CLOUD-BRIDGE TESTS PASSED");
else {
  console.error(`${failures} failures`);
  process.exit(1);
}
