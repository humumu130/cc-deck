// DEV-43 / P0-3/T1：桥直推告警 POST /alert（Node 形态）——集成回归：
//   A) 鉴权：错 token 401；GET 不放行
//   B) 投递：假手机 ws（ph-*）在线 → 200 {ok,delivered} + ws 收到 bridge_alert 帧
//      （title/body/level 透传 + ts 在场）
//   C) 定向语义：目标离线 → 404 {ok:false,error:"target offline"}；缺 to → 400
//   D) 限流：同 IP 连打超突发（5）→ 429
// 直跑：cd cloud-bridge && npx tsx scripts/test-alert.ts
import { startCloudServer } from "../src/index.js";
import { createServer } from "node:net";
import WebSocket from "ws";

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

// 自选空闲口（startCloudServer 返回请求 port 而非实际 listen 口——0 不回填）
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const TOKEN = "alert-test-token";
const port = await freePort();
const srv = startCloudServer(port, TOKEN, []);
const base = `http://127.0.0.1:${port}`;

// 假手机：注册后收帧记账
const frames: unknown[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${port}/cloud?token=${TOKEN}&dev=ph-alerttest01`);
ws.on("message", (data) => frames.push(JSON.parse(String(data))));
await new Promise<void>((r) => (ws.on("open", () => r()), ws.on("error", () => r())));
await new Promise((r) => setTimeout(r, 300));

const post = (body: unknown, token = TOKEN): Promise<{ status: number; json: any }> =>
  fetch(`${base}/alert`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));

// A) 鉴权
{
  const r1 = await post({ to: "ph-alerttest01", title: "t", body: "b" }, "wrong-token");
  assert(r1.status === 401, `A1 错 token 401（实得 ${r1.status}）`);
  const r2 = await fetch(`${base}/alert`);
  assert(r2.status === 404, `A2 GET /alert 不放行（实得 ${r2.status}——POST-only 路由外的回落）`);
}

// B) 投递 + 帧断言
{
  const r = await post({ to: "ph-alerttest01", title: "⚠️ relay 无响应", body: "已连续 2 拍 HTTP=000", level: "critical" });
  assert(r.status === 200 && r.json?.ok === true && r.json?.delivered === true, `B1 200 {ok,delivered}（实得 ${r.status} ${JSON.stringify(r.json)}）`);
  await new Promise((r2) => setTimeout(r2, 300));
  const hit = frames.find((f) => (f as { type?: string }).type === "bridge_alert") as { title?: string; body?: string; level?: string; ts?: number } | undefined;
  assert(!!hit, "B2 手机侧收到 bridge_alert 帧");
  assert(hit?.title === "⚠️ relay 无响应" && hit?.body?.includes("HTTP=000"), `B3 title/body 透传（实得 ${JSON.stringify(hit)}）`);
  assert(hit?.level === "critical" && typeof hit?.ts === "number", "B4 level/ts 在场");
}

// C) 定向语义
{
  const r1 = await post({ to: "ph-notonline0000", title: "t", body: "b" });
  assert(r1.status === 404 && r1.json?.ok === false && r1.json?.error === "target offline", `C1 目标离线 404（实得 ${r1.status} ${JSON.stringify(r1.json)}）`);
  const r2 = await post({ title: "无 to", body: "b" });
  assert(r2.status === 400, `C2 缺 to 400（实得 ${r2.status}）`);
  const r3 = await post({ to: "ph-alerttest01", title: "", body: "b" });
  assert(r3.status === 400, `C3 空 title 400（实得 ${r3.status}）`);
}

// D) 限流（前面已耗 4 个令牌：B×1 + C×3 → 剩 1；连打 3 发：第 1 发过、第 2/3 发 429）
{
  const seq = await Promise.all([
    post({ to: "ph-alerttest01", title: "rl1", body: "b" }),
    post({ to: "ph-alerttest01", title: "rl2", body: "b" }),
    post({ to: "ph-alerttest01", title: "rl3", body: "b" }),
  ]);
  const codes = seq.map((x) => x.status).sort().join(",");
  assert(seq.some((x) => x.status === 429), `D1 超突发（5）后 429（实得 ${codes}）`);
}

ws.close();
await srv.close();
console.log(failures === 0 ? "test-alert: ALL OK" : `test-alert: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
