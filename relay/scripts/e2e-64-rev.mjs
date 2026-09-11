// #64 设置→连接列表右侧图标组布局审查：CDP 截图脚本（桌面 + 手机视口）
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const CDP = "http://127.0.0.1:9223";
const PAGE_URL = "http://127.0.0.1:8823/index.html";
const SERVERS = [
  { id: "v1", name: "本机", kind: "lan", wsUrl: "ws://192.168.0.101:8787/ws", token: "a5aa50d0e0f54a0ea7d13f63b26fc068" },
  { id: "v2", name: "公司云桥", kind: "cloud", wsUrl: "wss://cc.humumu.online/cloud", token: "x" },
];

const list = await (await fetch(CDP + "/json")).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

let seq = 0;
const pend = new Map();
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pend.set(id, (m) => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result))));
}
async function evaljs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval fail: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: PAGE_URL + "?v=" + Date.now() });
await sleep(1500);

// 预置双源后重载
await evaljs(`localStorage.setItem("ccd_servers", ${JSON.stringify(JSON.stringify(SERVERS))}); "ok"`);
await send("Page.navigate", { url: PAGE_URL + "?v=" + Date.now() });
await sleep(2000);

// 打开设置抽屉
await evaljs(`(() => { const b = document.getElementById("gearBtn"); if (!b) throw new Error("no gearBtn"); b.click(); return "clicked"; })()`);
await sleep(2500); // 等连接尝试/渲染

// 连接区几何信息（含 gearPop 定位），供裁剪
const geo = await evaljs(`(() => {
  const pop = document.getElementById("gearPop");
  const box = document.getElementById("srvList");
  const pr = pop.getBoundingClientRect(), br = box.getBoundingClientRect();
  const rows = [...document.querySelectorAll("#srvList .srv-row")].map(r => { const rr = r.getBoundingClientRect(); return { x: rr.x, y: rr.y, w: rr.width, h: rr.height }; });
  return { pop: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, list: { x: br.x, y: br.y, w: br.width, h: br.height }, rows, open: pop.classList.contains("open") };
})()`);
console.log("GEO:", JSON.stringify(geo, null, 1));

async function shot(file, clip) {
  const r = await send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("saved", file);
}

const pad = 10;
const frac = (v) => v + 0.0001; // CDP clip 的 double 字段拒绝整数字面量，加微不可见的 epsilon
const listClip = {
  x: frac(Math.max(0, geo.list.x - pad)), y: frac(Math.max(0, geo.list.y - pad - 24)),
  width: frac(geo.list.w + pad * 2), height: frac(geo.list.h + pad * 2 + 34), scale: 2.0001,
};
await shot("D:/dev/cc-watch/rev64-1.png", listClip);           // 桌面：连接列表区（含小节标题）
await shot("D:/dev/cc-watch/rev64-1-full.png");                // 桌面：整窗上下文

// 右列组逐元素测量（供间距/对齐诊断）
const meas = await evaljs(`(() => {
  const out = [];
  document.querySelectorAll("#srvList .srv-row").forEach((row) => {
    const rr = row.getBoundingClientRect();
    const grab = (sel) => [...row.querySelectorAll(sel)].map((el) => { const b = el.getBoundingClientRect(); return { sel, x: +(b.x - rr.x).toFixed(1), y: +(b.y - rr.y).toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +(rr.right - b.right).toFixed(1) }; });
    out.push({ rowH: +rr.height.toFixed(1), main: grab(".srv-main"), chan: grab(".srv-chan"), badge: grab(".srv-pbadge"), plug: grab(".plug"), svg: grab(".plug svg"), right: grab(".srv-right") });
  });
  const cs = getComputedStyle(document.querySelector(".srv-chan"));
  const cs2 = getComputedStyle(document.querySelector(".srv-pbadge"));
  return { rows: out, chan: { fs: cs.fontSize, pad: cs.padding, lh: cs.lineHeight }, badge: { fs: cs2.fontSize, pad: cs2.padding, lh: cs2.lineHeight } };
})()`);
console.log("MEAS:", JSON.stringify(meas, null, 1));

// 手机视口
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
const open2 = await evaljs(`document.getElementById("gearPop").classList.contains("open")`);
if (!open2) { await evaljs(`document.getElementById("gearBtn").click()`); await sleep(1500); }
const geo2 = await evaljs(`(() => { const b = document.getElementById("srvList").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
const clip2 = {
  x: frac(Math.max(0, geo2.x - pad)), y: frac(Math.max(0, geo2.y - pad - 24)),
  width: frac(Math.min(390, geo2.w + pad * 2)), height: frac(geo2.h + pad * 2 + 34), scale: 2.0001,
};
await shot("D:/dev/cc-watch/rev64-2.png", clip2);
await shot("D:/dev/cc-watch/rev64-2-full.png");

ws.close();
console.log("DONE");
