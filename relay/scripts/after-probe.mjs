// 审查修复稿前置探测：查真实 class/结构（只读，不改）
import WebSocket from "ws";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const tgt = list.find((t) => t.type === "page" && t.url.includes("8823")) || list.find((t) => t.type === "page");
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
const TOKEN = process.env.TOKEN || "a5aa50d0e0f54a0ea7d13f63b26fc068";
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(1200);
await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"${TOKEN}"}])); localStorage.removeItem("ccr_theme"); "ok"`);
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(2600);

console.log("== home ==", await ev(`JSON.stringify({
  empty: !!document.getElementById("empty"),
  emptyText: document.querySelector("#empty > div:not(.logo)")?.textContent,
  connChipCls: document.getElementById("connChip")?.className,
  srcChips: [...document.querySelectorAll("#srcChips *")].slice(0,4).map(x=>x.className+":"+getComputedStyle(x).borderStyle),
  fabs: [...document.querySelectorAll("#sideFabs button")].map(b=>b.id),
  cardSample: document.querySelector("#cards .card")?.className,
  ctxMini: document.querySelector(".ctx-mini-bar")?.outerHTML?.slice(0,120)
})`));

// 进详情
await ev(`document.querySelector("#cards .card")?.click(); "ok"`);
await sleep(1500);
console.log("== detail ==", await ev(`JSON.stringify({
  tabs: [...document.querySelectorAll(".tabs .tab")].map(b=>b.dataset.tab),
  toolRowCls: [...document.querySelectorAll("#timeline .trow, #timeline [class*=tool]")].slice(0,3).map(x=>x.className),
  tresFont: (()=>{const el=document.querySelector("#timeline .tres, #timeline .tname"); return el?getComputedStyle(el).fontFamily.slice(0,60):"none"})(),
  sendBtnBg: getComputedStyle(document.getElementById("sendBtn")).background.slice(0,80),
  imgBtnBg: getComputedStyle(document.getElementById("imgBtn")).backgroundColor,
  cmdbarH: document.getElementById("cmdbar")?.offsetHeight
})`));

// 任务 tab
await ev(`[...document.querySelectorAll(".tabs .tab")].find(x=>x.dataset.tab==="todos")?.click(); "ok"`);
await sleep(800);
console.log("== todos ==", await ev(`JSON.stringify({
  items: [...document.querySelectorAll("#timeline .todo-item .todo-tx")].slice(0,8).map(x=>x.textContent.slice(0,26)),
  grips: document.querySelectorAll(".todo-grip").length,
  gripOpacity: (()=>{const g=document.querySelector(".todo-grip"); return g?getComputedStyle(g).opacity:"-1"})(),
  headHtml: document.querySelector("#timeline .todo-head")?.outerHTML?.slice(0,200)
})`));

// 全部 tab
await ev(`[...document.querySelectorAll(".tabs .tab")].find(x=>x.dataset.tab==="log")?.click(); "ok"`);
await sleep(800);
console.log("== log ==", await ev(`JSON.stringify({
  expandCls: [...document.querySelectorAll("#timeline [class*=xp], #timeline [class*=more], #timeline [class*=fold]")].slice(0,5).map(x=>x.className+":"+x.textContent.slice(0,14)),
  emptyOutSample: [...document.querySelectorAll("#timeline .tres")].filter(x=>!x.textContent.trim()).length
})`));

// 统计 tab
await ev(`[...document.querySelectorAll(".tabs .tab")].find(x=>x.dataset.tab==="stats")?.click(); "ok"`);
await sleep(800);
console.log("== stats ==", await ev(`JSON.stringify({
  rows: [...document.querySelectorAll("#timeline .stats-row")].slice(0,4).map(r=>r.textContent.slice(0,30)),
  statusVal: [...document.querySelectorAll("#timeline .stats-row")].find(r=>r.textContent.includes("状态"))?.textContent
})`));
process.exit(0);
