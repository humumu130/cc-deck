// #64 第二遍：右列组放大裁剪 + hover 态 + 已配对组合
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const CDP = "http://127.0.0.1:9223";
const PAGE_URL = "http://127.0.0.1:8823/index.html";
const SERVERS = [
  { id: "v1", name: "本机", kind: "lan", wsUrl: "ws://192.168.0.101:8787/ws", token: "a5aa50d0e0f54a0ea7d13f63b26fc068" },
  // 已配对身份的云桥（徽章应显示「已配对」绿）
  { id: "v2", name: "公司云桥", kind: "cloud", wsUrl: "wss://cc.humumu.online/cloud", token: "x", cloud: { paired: true, rd: "d dummy", rk: "k dummy" } },
];

const list = await (await fetch(CDP + "/json")).json();
const page = list.find((t) => t.type === "page");
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
  if (r.exceptionDetails) throw new Error("eval fail: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frac = (v) => v + 0.0001;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: PAGE_URL + "?v=" + Date.now() });
await sleep(1500);
await evaljs(`localStorage.setItem("ccd_servers", ${JSON.stringify(JSON.stringify(SERVERS))}); "ok"`);
await send("Page.navigate", { url: PAGE_URL + "?v=" + Date.now() });
await sleep(2000);
await evaljs(`document.getElementById("gearBtn").click()`);
await sleep(2500);

const rows = await evaljs(`(() => {
  return [...document.querySelectorAll("#srvList .srv-row")].map((r) => {
    const rr = r.getBoundingClientRect();
    const right = r.querySelector(".srv-right").getBoundingClientRect();
    return { row: { x: rr.x, y: rr.y, w: rr.width, h: rr.height }, right: { x: right.x, y: right.y, w: right.width, h: right.height }, txt: r.innerText.replace(/\\n/g, " | ") };
  });
})()`);
console.log("ROWS:", JSON.stringify(rows, null, 1));

async function shot(file, clip) {
  const r = await send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("saved", file);
}
// 每行右列组 4x 放大
let i = 0;
for (const row of rows) {
  i++;
  await shot(`D:/dev/cc-watch/rev64-z${i}.png`, {
    x: frac(row.right.x - 14), y: frac(row.right.y - 12),
    width: frac(row.right.w + 26), height: frac(row.right.h + 24), scale: 4.0001,
  });
}
// hover 第一行（✕ 浮现）
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rows[0].row.x + 100, y: rows[0].row.y + 20 });
await sleep(400);
await shot("D:/dev/cc-watch/rev64-hover.png", {
  x: frac(rows[0].row.x), y: frac(rows[0].row.y - 2),
  width: frac(rows[0].row.w + 4), height: frac(rows[0].row.h + 4), scale: 3.0001,
});
ws.close();
console.log("DONE");
