// M9 探测：找「展开」链接真实节点
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
const TOKEN = process.env.TOKEN || "a5aa50d0e0f54a0ea7d13f63b26fc068";
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(1200);
await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"${TOKEN}"}])); localStorage.removeItem("ccr_theme"); "ok"`);
await send("Page.navigate", { url: "http://127.0.0.1:8823/index.html" });
await sleep(2600);
await ev(`(function(){var cs=[...document.querySelectorAll("#cards .card")];(cs.find(x=>x.textContent.includes("0.4.3"))||cs[0]).click();return "ok";})()`);
await sleep(1500);
await ev(`[...document.querySelectorAll(".tabs .tab")].find(x=>x.dataset.tab==="log")?.click(); "ok"`);
await sleep(900);
console.log(await ev(`(function(){
  var xp=document.querySelector(".tl-expand");
  var out={tlExpand: xp?xp.outerHTML.slice(0,200):null, tlExpandParent: xp?xp.parentElement.className+"|"+xp.parentElement.outerHTML.slice(0,260):null};
  // 找含「展开」文本的元素
  var all=[...document.querySelectorAll("#timeline *")].filter(x=>x.children.length===0&&x.textContent.trim()==="展开");
  out.zk = all.slice(0,3).map(x=>x.tagName+"."+x.className+" :: parent="+x.parentElement.tagName+"."+x.parentElement.className+" :: gp="+x.parentElement.parentElement.tagName+"."+x.parentElement.parentElement.className);
  var row=all[0]?.closest(".trow");
  out.rowHtml = row?row.outerHTML.slice(0,400):null;
  return JSON.stringify(out,null,1);
})()`));
process.exit(0);
