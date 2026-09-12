// 补拍：M4（chips 收敛 v2）、M1（选有内容的会话）、M5（注入 chip 字形修正）
import WebSocket from "ws";
import fs from "node:fs";
const OUT = "D:/dev/cc-watch/.tmp-043/after/";
const TOKEN = "a5aa50d0e0f54a0ea7d13f63b26fc068";
const URL = "http://127.0.0.1:8823/index.html";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const tgt = list.find((t) => t.type === "page" && t.url.includes("8823")) || list.find((t) => t.type === "page");
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let seq = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
const style = async (css) => ev(`(function(){document.getElementById("patch")?.remove();var s=document.createElement("style");s.id="patch";s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return "ok";})()`);
const shot = async (name) => {
  const img = (await send("Page.captureScreenshot", { format: "png" })).data;
  fs.writeFileSync(OUT + name + ".png", Buffer.from(img, "base64"));
  console.log("shot:", name);
};
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
const reload = async () => {
  await send("Page.navigate", { url: URL });
  await sleep(1000);
  await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"${TOKEN}"}])); localStorage.removeItem("ccr_theme"); "ok"`);
  await send("Page.navigate", { url: URL });
  await sleep(2800);
  await ev(`document.getElementById("toast")?.classList.remove("show"); "ok"`);
};
const openDetail = async (cardSub, tab) => {
  const ok = await ev(`(function(){var cs=[...document.querySelectorAll("#cards .card")];var c=cs.find(x=>x.textContent.includes(${JSON.stringify(cardSub)}))||cs[0];if(!c)return "nocard";c.click();return "ok";})()`);
  if (ok !== "ok") return false;
  await sleep(1500);
  if (tab) { await ev(`[...document.querySelectorAll(".tabs .tab")].find(x=>x.dataset.tab===${JSON.stringify(tab)})?.click(); "ok"`); await sleep(900); }
  return true;
};

// M4 v2：收敛对象=虚线 chips（列表工具钮 + tabs mini 钮）
await reload();
await style(`.hbtn,.tabs button.mini,#dctxcell button.mini{border-style:solid;opacity:.85}`);
await sleep(500); await shot("M4");

// M1：挑消息最多的会话（活动 tab 子元素数）
await reload();
const pick = await ev(`(function(){
  var best=null,bn=-1;
  return (async function(){ return "eval-unsupported"; })();
})()`);
// 逐个候选探测：调研一下 / 0.4.3
const countFor = async (sub) => {
  if (!(await openDetail(sub, "activity"))) return -1;
  const n = await ev(`document.getElementById("timeline").children.length`);
  return n;
};
const n1 = await countFor("调研一下");
console.log("调研一下 activity children:", n1);
let m1card = n1 >= 4 ? "调研一下" : null;
if (!m1card) {
  const n2 = await countFor("0.4.3");
  console.log("0.4.3 activity children:", n2);
  m1card = "0.4.3";
}
// openDetail 已把会话点开且停在 activity；直接补丁截图（若刚 countFor 已重开，无需再点）
await style(`#timeline{max-width:760px;margin:0 auto}`);
await sleep(500); await shot("M1");

// M5：0.4.3（终端可控会话）+ 注入 chip 字形由 ⏹ 换 ■（文本渲染，随 color 走灰）
await reload();
await openDetail("0.4.3", "activity");
await style(`#sendBtn{background:#D97757 !important;color:#fff !important;border:none} #stopBtn{background:#21262d !important;color:#8b949e !important;border:none !important;box-shadow:none} #imgBtn{background:#21262d !important;color:#8b949e !important;border:none !important}`);
await ev(`(function(){var b=document.getElementById("stopBtn");if(b&&b.firstChild&&b.firstChild.nodeType===3)b.firstChild.textContent="■ ";return "ok";})()`);
await sleep(500); await shot("M5");

ws.close();
process.exit(0);
