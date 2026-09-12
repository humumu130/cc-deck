// #89 补充素材：web 剩余 tab + 设置全部子页（深色为主，抽查浅色）
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
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(1500);
await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"${process.env.TOKEN}"}])); "ok"`);
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(2500);
await ev(`document.querySelector("#cards .card")?.click(); "ok"`);
await sleep(1400);
// 剩余三 tab
for (const t of ["全部", "定时", "统计"]) {
  await ev(`[...document.querySelectorAll(".dtab, .tab")].find(x=>x.textContent.includes("${t}"))?.click(); "ok"`);
  await sleep(800);
  await shot(`web-dark-tab-${t === "全部" ? "all" : t === "定时" ? "cron" : "stats"}`);
}
// 设置子页（relay/快捷键/插件/关于）
await ev(`document.getElementById("backBtn")?.click(); "ok"`);
await sleep(600);
await ev(`document.querySelector('#sideFabs [title*="设置"]')?.click() || document.querySelectorAll('#sideFabs button')[1]?.click(); "ok"`);
await sleep(900);
for (const sec of ["relay", "kb", "plug", "about"]) {
  await ev(`document.querySelector('[data-sec="${sec}"]')?.click(); "ok"`);
  await sleep(700);
  await shot(`web-dark-gear-${sec}`);
}
process.exit(0);
