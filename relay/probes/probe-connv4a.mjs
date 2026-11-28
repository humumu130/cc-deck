// W-CONNV4A 探针：源列表 UI 重组（五段序+三态+标签+诊断迁位）——probe-connv3 手法
// （真 Chrome headless + CDP + file:// index-005 + 夹具 SNAPSHOT/localStorage）。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9920 + Math.floor(Math.random() * 60);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/connv4a-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
for (let i = 0; i < 8; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await wait(1000); } }
const tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const errs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; } if (m.method === "Runtime.exceptionThrown") errs.push(String(m.params.exceptionDetails?.text).slice(0, 120)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*"] });
// 夹具：配对码源 ×2（localStorage 共享库）+ acct 同账号 ×3（在线2 名字序+离线1 带 ts）
await ev(`localStorage.setItem("ccd_servers", JSON.stringify([
  { id: "srv-a", kind: "cloud", name: "公司中继", wsUrl: "wss://example-a.cc-deck.win/ws", token: "t1", cloud: { paired: true } },
  { id: "srv-b", kind: "cloud", name: "家里 Win", wsUrl: "wss://example-b.cc-deck.win/ws", token: "t2", cloud: { paired: false } }
]))`);
await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ token: "atk-test", user: "xdd" }))`);
const now = Date.now();
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [], logs: {}, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [],
  acct_relays: [
    { dev: "wb-alpha111", name: "Zeta 机", rk: "rk1", online: true },
    { dev: "wb-beta222", name: "Alpha 机", rk: "rk2", online: true },
    { dev: "wb-gamma333", name: "下线机", rk: "rk3", online: false, ts: Date.now() - 5 * 60_000 }
  ] } };
await send("Page.reload"); await wait(2800);
await ev(`window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} };`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(700);
await ev(`(() => { const b = [...document.querySelectorAll("#stage-desktop [data-nav], #stage-desktop button")].find(x => /设置/.test(x.textContent || "")); if (b) b.click(); })()`);
await wait(900);
await ev("window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()");
await new Promise(r => setTimeout(r, 700)); // CONNV4A：refresh 借道+缓冲一拍（acct cache 合并链时序）
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const png = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync("/tmp/connv4a-" + name, Buffer.from(r.result.data, "base64")); };

const g = JSON.parse(await ev(`JSON.stringify((() => {
  const card = document.querySelector('[data-conn-section="sources"]');
  const live = card ? card.querySelector('[data-settings-live="remote-sources"]') : null;
  if (!live) return { none: 1 };
  const rows = [...live.children];
  return {
    none: 0,
    first: rows[0] ? rows[0].textContent : "",
    firstIsLocal: !!(rows[0] && rows[0].classList.contains("src-local-row")),
    order: rows.map(r => { const w = r.querySelector(".v8-swtxt"); if (w) { const first = [...w.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()); if (first) return first.textContent.trim(); } return (r.querySelector("strong") || {}).textContent || r.textContent.slice(0, 10); }),
    tags: rows.map(r => { const t = [...r.querySelectorAll(".tag")].map(x => x.textContent); return t.join("+"); }),
    offlineRow: !!live.querySelector(".src-offline"),
    lastSeen: (live.querySelector(".src-offline .v8-swd") || {}).textContent || "",
    connectBtns: live.querySelectorAll("[data-acct-relay-connect]").length,
    pairRows: live.querySelectorAll("[data-srv-connect], .cloud-cur").length,
    diagInCard: !!card.querySelector("[data-cloud-diag], .conn-diagbar"),
    diagInThisMachine: !!document.querySelector('[data-conn-section="this-machine"] .conn-diagbar'),
    pairForm: !!card.querySelector("[data-cloud-pair-input]")
  };
})())`));
ok(!g.none && g.firstIsLocal, "① 本机行恒置顶（首行=src-local-row）");
ok(/本机/.test(g.first), "①b 首行名称含本机源名：" + g.first.slice(0, 24));
ok(g.order.length >= 6 && g.order[1] === "Alpha 机" && g.order[2] === "Zeta 机", "② 五段序：在线同账号名字序（Alpha→Zeta）——" + g.order.slice(0, 5).join("/"));
ok(g.order[3] === "下线机" && g.offlineRow && /\d+ 分钟前在线/.test(g.lastSeen), "③ 离线同账号灰显+上次在线（" + g.lastSeen.slice(0, 18) + "）");
ok(g.order[4] === "公司中继" && g.order[5] === "家里 Win", "④ 配对码源段在尾（sdel 条目）");
ok(g.tags.slice(1, 4).every(t => String(t).includes("账号")) && String(g.tags[4]).startsWith("配对") && String(g.tags[5]).startsWith("配对"), "⑤ 来源标签三态：账号×3+配对×2（中性灰 .tag，状态 tag 并存）——" + g.tags.join(" | "));
ok(g.connectBtns === 2, "⑥ 在线 acct 行「连接」钮×2（离线行无钮）");
ok(g.diagInCard === false && g.diagInThisMachine, "⑦ 诊断迁位：源列表卡零诊断元素+「这台电脑」卡底在位（负向+正向）");
ok(g.pairForm === false, "⑧ 卡内输码表单零残余（＋添加弹窗唯一路径）");
// ⑨ 本机行点击=切回本机视角（云胶囊切走后首行仍是本机）
await ev(`window.__ccDeck005SourceState && window.__ccDeck005SourceState()`);
const afterGoto = await ev(`(() => { document.querySelector("[data-src-goto-local]").click(); return "clicked"; })()`);
ok(afterGoto === "clicked", "⑨ 本机行点击委托在挂（setSourceView(local) 链）");
if (errs.length) console.log("  errs:", JSON.stringify(errs));
ok(errs.length === 0, "⑩ console 零异常（" + errs.length + "）");
await png("list.png");
console.log(`\nconnv4a probe：${pass} ok / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
