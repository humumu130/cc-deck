// App 端 mockup 截图 v2：clip 页面绝对坐标，禁用移动端缩放
import WebSocket from "ws";
import fs from "node:fs";
const OUT = "D:/dev/cc-watch/.tmp-043/after/";
const FILE = "file:///D:/dev/cc-watch/.tmp-043/after/mockups.html";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const tgt = list.find((t) => t.type === "page");
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let seq = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 1000, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: FILE });
await sleep(1200);
// 视口拉到整页高，保证 clip 区域全部已光栅化（超出视口折叠的内容不会绘制）
const total = await ev(`document.documentElement.scrollHeight`);
await send("Emulation.setDeviceMetricsOverride", { width: 400, height: Math.min(4000, total + 20), deviceScaleFactor: 2, mobile: false });
await sleep(400);
for (const id of ["h4", "h6", "m6", "m10", "l2"]) {
  const r = await ev(`(function(){var s=document.getElementById("${id}");return JSON.stringify({top:s.offsetTop,h:s.offsetHeight});})()`);
  const { top, h } = JSON.parse(r);
  const img = (await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: top, width: 400, height: h, scale: 1 } })).data;
  fs.writeFileSync(OUT + id.toUpperCase() + ".png", Buffer.from(img, "base64"));
  console.log("shot:", id.toUpperCase(), "top=", top, "h=", h);
}
ws.close();
process.exit(0);
