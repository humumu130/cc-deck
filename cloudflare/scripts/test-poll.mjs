// poll 路径专项验证：基础收发 / 每 dev 会话上限 / 续命 GET 不限流 / CL 预检 / health 计数
// 用法：先 npm run dev（wrangler dev :8791），再 node scripts/test-poll.mjs
const BASE = "http://127.0.0.1:8791";
const TOKEN = "changeme-cloudtoken";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("ok - " + name); }
  else { fail++; console.log("FAIL - " + name); }
}

async function post(dev, sid, body) {
  const r = await fetch(`${BASE}/cloud-poll?token=${TOKEN}&dev=${dev}&sid=${sid}`, {
    method: "POST", body,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function get(dev, sid) {
  // wait=1：queue 空最多挂 1s（0 会被 worker 的 || 20 变成 20s 长挂）
  const r = await fetch(`${BASE}/cloud-poll?token=${TOKEN}&dev=${dev}&sid=${sid}&wait=1`);
  return { status: r.status, json: await r.json().catch(() => null) };
}

// 1. health 返回计数（number）而非列表
const h = await (await fetch(`${BASE}/health`)).json();
ok(typeof h.devices === "number", `/health devices 为计数（got ${JSON.stringify(h.devices)}）`);

// 2. 先 GET 建 pollB 会话并挂住，再 POST pollA 发帧 → pollB GET 拿到
const pollBfirst = get("pollB", "sid-b1"); // 在途长挂，等 POST 帧到达即返回
await new Promise((r) => setTimeout(r, 300));
await post("pollA", "sid-a1", JSON.stringify({ to: "pollB", data: { n: "x", c: "hi" } }));
const g = await pollBfirst;
const got = (g.json?.frames ?? []).some((f) => String(f).includes("pollA"));
ok(g.status === 200 && got, `POST→GET 帧转发（pollA→pollB，frames=${(g.json?.frames ?? []).length}）`);

// 3. 同 sid 重复 GET 幂等（会话复用不炸）
const g2 = await get("pollB", "sid-b1");
ok(g2.status === 200, `同 sid 重复 GET 幂等（${g2.status}）`);

// 4. 同 dev 轮换 sid = 顶替：新 sid 的请求把旧 sid 会话踢关闭（占坑自愈），
//    不同 dev 的会话互不影响。旧 sid 必须有在途挂着的 GET 才能观察到 closed
const oldPending = get("pollC", "sid-c-old"); // wait=1 挂住
await new Promise((r) => setTimeout(r, 300));
await post("pollC", "sid-c-new", JSON.stringify({ to: "nobody", data: {} })); // 新 sid 顶替
const oldGet = await oldPending;
ok(oldGet.status === 200 && oldGet.json?.closed === true, `同 dev 新 sid 顶替旧会话（closed=${oldGet.json?.closed}）`);
const otherGet = await get("pollA", "sid-a1");
ok(otherGet.status === 200 && otherGet.json?.closed !== true, "不同 dev 会话不受顶替影响");

// 5. 已存在会话的 GET 快速连打不吃限流
let limited = false;
for (let i = 0; i < 10; i++) {
  const r = await get("pollA", "sid-a1");
  if (r.status !== 200) { limited = true; console.log("  got status " + r.status); }
}
ok(!limited, "续命 GET 不吃限流");

// 6. 真发 >8MB body → 413
const big = await fetch(`${BASE}/cloud-poll?token=${TOKEN}&dev=pollD&sid=sid-d1`, {
  method: "POST", body: "x".repeat((8 << 20) + 1024),
});
ok(big.status === 413, `超大 body 413（got ${big.status}）`);

console.log(fail === 0 ? `POLL TESTS PASSED (${pass})` : `POLL TESTS FAILED (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
