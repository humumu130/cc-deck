// 验证 M2 等宽字体已生效（log tab .tres 计算样式）
import WebSocket from "ws";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const tgt = list.find((t) => t.type === "page" && t.url.includes("8823")) || list.find((t) => t.type === "page");
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let seq = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(1000);
await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"a5aa50d0e0f54a0ea7d13f63b26fc068"}])); "ok"`);
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(2600);
await ev(`(function(){var cs=[...document.querySelectorAll("#cards .card")];(cs.find(x=>x.textContent.includes("0.4.3"))||cs[0]).click();return "ok";})()`);
await sleep(1500);
await ev(`[...document.querySelectorAll(".tabs .tab")].find(x=>x.dataset.tab==="log")?.click(); "ok"`);
await sleep(900);
await ev(`(function(){var s=document.createElement("style");s.textContent=".trow .tname,.trow .tres,.trow .tico,.tdetail,.diff{font-family:'Cascadia Code','JetBrains Mono',Consolas,monospace}";document.head.appendChild(s);return "ok";})()`);
await sleep(300);
console.log(await ev(`JSON.stringify({
  tres: getComputedStyle(document.querySelector(".trow .tres, .tdetail") || document.body).fontFamily,
  tname: getComputedStyle(document.querySelector(".tname") || document.body).fontFamily
})`));
process.exit(0);
