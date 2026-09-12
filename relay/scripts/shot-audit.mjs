// #89 全界面审查素材截图：web 双模式 × 多页面
import WebSocket from "ws";
const CDP = process.argv[2];
const ws = new WebSocket(CDP);
let seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
const shot = async (name) => {
  const img = (await send("Page.captureScreenshot", { format: "png" })).data;
  (await import("node:fs")).writeFileSync(`D:/dev/cc-watch/.tmp-043/audit-${name}.png`, Buffer.from(img, "base64"));
  console.log("shot:", name);
};
for (const mode of ["dark", "light"]) {
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
  await sleep(1500);
  await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"${process.env.TOKEN}"}])); ${mode === "light" ? 'localStorage.setItem("ccr_theme","light")' : 'localStorage.removeItem("ccr_theme")'}; "ok"`);
  await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
  await sleep(2500);
  await shot(`web-${mode}-home`);
  // 设置抽屉（连接页）
  await ev(`document.querySelector('#sideFabs [title*="设置"]')?.click() || document.querySelectorAll('#sideFabs button')[1]?.click(); "ok"`);
  await sleep(900);
  await shot(`web-${mode}-gear-conn`);
  // 设置-显示页
  await ev(`document.querySelector('[data-sec="disp"]')?.click(); "ok"`);
  await sleep(600);
  await shot(`web-${mode}-gear-disp`);
  await ev(`document.getElementById("gearClose")?.click(); "ok"`);
  await sleep(400);
  // 详情页（消息）
  await ev(`document.querySelector("#cards .card")?.click(); "ok"`);
  await sleep(1400);
  await shot(`web-${mode}-detail`);
  // 任务 tab
  await ev(`[...document.querySelectorAll(".dtab, .tab")].find(x=>x.textContent.includes("任务"))?.click(); "ok"`);
  await sleep(900);
  await shot(`web-${mode}-todos`);
}
process.exit(0);
