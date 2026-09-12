// #85 待验证分组 web 渲染验证
import WebSocket from "ws";
const CDP = process.argv[2];
const ws = new WebSocket(CDP);
let seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(1500);
await send("Runtime.evaluate", { expression: `localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"${process.env.TOKEN}"}])); "ok"` });
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(2500);
// 打开第一张卡（本会话）→ 任务 tab
await send("Runtime.evaluate", { expression: `document.querySelector("#cards .card")?.click(); "ok"` });
await sleep(1200);
await send("Runtime.evaluate", { expression: `[...document.querySelectorAll(".dtab, .tab")].find(x=>x.textContent.includes("任务"))?.click(); "ok"` });
await sleep(1000);
const heads = await send("Runtime.evaluate", { expression: `JSON.stringify([...document.querySelectorAll(".todo-gt")].map(x=>x.textContent))`, returnByValue: true });
console.log("组头:", heads.result.value);
const img = (await send("Page.captureScreenshot", { format: "png" })).data;
(await import("node:fs")).writeFileSync("D:/dev/cc-watch/.tmp-043/85-verify.png", Buffer.from(img, "base64"));
console.log("shot ok");
process.exit(0);
