// 界面审查「修复后设计稿」v2：每条补丁独立 reload（防串扰），注入运行时 CSS/JS 后截图（刷新即消失）
import WebSocket from "ws";
import fs from "node:fs";
const OUT = "D:/dev/cc-watch/.tmp-043/after/";
const TOKEN = process.env.TOKEN || "a5aa50d0e0f54a0ea7d13f63b26fc068";
const URL = "http://127.0.0.1:8823/index.html";
const CARD = "0.4.3 memory";

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

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

const reload = async (theme) => {
  await send("Page.navigate", { url: URL });
  await sleep(1000);
  await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{id:"v1",name:"本机验收",kind:"lan",wsUrl:"ws://127.0.0.1:8787/ws",token:"${TOKEN}"}])); ${
    theme === "light" ? 'localStorage.setItem("ccr_theme","light")' : 'localStorage.removeItem("ccr_theme")'}; "ok"`);
  await send("Page.navigate", { url: URL });
  await sleep(2800);
  await ev(`document.getElementById("toast")?.classList.remove("show"); "ok"`); // 关掉启动提示，画面干净
};
const style = async (css) => ev(`(function(){document.getElementById("patch")?.remove();var s=document.createElement("style");s.id="patch";s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return "ok";})()`);
const shot = async (name) => {
  const img = (await send("Page.captureScreenshot", { format: "png" })).data;
  fs.writeFileSync(OUT + name + ".png", Buffer.from(img, "base64"));
  console.log("shot:", name);
};
// 每条补丁一个完整流程：reload → 进视图 → 注入 → 截图
const run = async (name, theme, tab, patchCss, patchJs) => {
  await reload(theme);
  if (tab) {
    const ok = await ev(`(function(){var cs=[...document.querySelectorAll("#cards .card")];var c=cs.find(x=>x.textContent.includes(${JSON.stringify(CARD)}))||cs[0];if(!c)return "nocard";c.click();return "ok";})()`);
    if (ok !== "ok") { console.log("WARN no card for", name); return; }
    await sleep(1500);
    await ev(`[...document.querySelectorAll(".tabs .tab")].find(x=>x.dataset.tab===${JSON.stringify(tab)})?.click(); "ok"`);
    await sleep(900);
  }
  if (patchCss) await style(patchCss);
  if (patchJs) console.log("  js:", name, await ev(patchJs));
  await sleep(500);
  await shot(name);
};

/* ---------- 深色 · 主面板 ---------- */
await run("H2", "dark", null,
  `#empty > div:not(.logo){color:#8b949e}`,
  `(function(){document.querySelectorAll("#empty > div:not(.logo)").forEach(e=>e.textContent="选择左侧会话，或新建一个会话");return "ok";})()`);

await run("H5", "dark", null,
  `#cards .ctx-mini{flex:1;margin-left:12px} #cards .ctx-mini-bar{width:100%} #dctxcell .ctx-mini-bar{width:100%}`);

await run("M4", "dark", null,
  `#connChip,#runhint .rh-chip,#srcChips button,.schip{border-style:solid;opacity:.85}`);

await run("M11", "dark", null,
  `#sideFabs button{background:none !important;border:1px solid #30363d;color:#8b949e;box-shadow:none !important;filter:none}`);

await run("H3", "dark", null,
  `#toast{background:#1c2128;border:1px solid #30363d;color:#e6edf3}`,
  `(function(){var t=document.getElementById("toast");t.textContent="已复制连接信息";t.classList.add("show");return "ok";})()`);

await run("L7", "dark", null,
  `#sideToggle{background:var(--bg-soft);border-radius:0 8px 8px 0;padding:6px 2px}`);

/* ---------- 深色 · 详情 ---------- */
await run("M1", "dark", "activity", `#timeline{max-width:760px;margin:0 auto}`);

await run("M2", "dark", "log",
  `.trow .tname,.trow .tres,.trow .tico,.tdetail,.diff,#timeline code,#timeline pre{font-family:'Cascadia Code','JetBrains Mono',Consolas,monospace}`);

await run("M5", "dark", "activity",
  `#sendBtn{background:#D97757 !important;color:#fff !important;border:none} #stopBtn{background:#21262d !important;color:#8b949e !important;border:none !important;box-shadow:none} #imgBtn{background:#21262d !important;color:#8b949e !important;border:none !important}`);

await run("H1", "dark", "todos",
  `#timeline{scroll-padding-top:60px} #dhead{box-shadow:0 16px 18px -14px rgba(0,0,0,.6);position:relative;z-index:2}`,
  `(function(){var t=document.getElementById("timeline");t.scrollTop=170;return "sc:"+t.scrollTop;})()`);

await run("L4", "dark", "todos",
  `.todo-grip{opacity:0;transition:opacity .15s} .todo-item:hover .todo-grip{opacity:1}`,
  `(function(){var n=0;document.querySelectorAll("#timeline .todo-tx").forEach(function(t){if(/\\[P0\\]/.test(t.textContent)){var s=document.createElement("span");s.style.color="#e5534b";s.textContent="● ";t.insertBefore(s,t.firstChild);n++;}});return "p0:"+n;})()`);

await run("M9", "dark", "log",
  `.trow .x-full{visibility:hidden;opacity:0;transition:opacity .15s} .trow:hover .x-full{visibility:visible;opacity:1}`);

await run("L3", "dark", "stats", null,
  `(function(){var n=0;document.querySelectorAll("#timeline .stats-row").forEach(function(r){if(r.textContent.includes("状态")&&r.textContent.includes("WORKING")){var v=r.querySelector(".v");if(v){v.style.color="#e3b341";v.style.fontWeight="600";n++;}}});return "ok:"+n;})()`);

await run("M8", "dark", "stats", `#cmdbar{display:none !important}`);

/* ---------- 浅色 · 主面板 ---------- */
await run("L1", "light", null, `#empty .logo{background:#eaeef2}`);

ws.close();
process.exit(0);
