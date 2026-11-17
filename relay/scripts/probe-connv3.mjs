// W-CONNV3 探针：连接页四区重设计真链路验证（brief v2 六件）。
// 骨架复用 probe-r6（headless Chrome + file:// index-005 + 夹具 SNAPSHOT）。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9860 + Math.floor(Math.random() * 200);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/connv3-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
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
await send("Page.reload"); await wait(3200);
const now = Date.now();
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [], logs: {}, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} };`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(600);
// 进设置页（桌面域）
await ev(`(() => { const q = document.querySelector('[data-queue-goto="settings"]'); if (q) q.click(); })()`);
await ev(`(() => { const b = [...document.querySelectorAll("#stage-desktop [data-nav], #stage-desktop button")].find(x => /设置/.test(x.textContent || "")); if (b) b.click(); })()`);
await wait(800);
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
// ① 四区骨架（LAN 形态）
const g = JSON.parse(await ev(`JSON.stringify((() => { const p = document.querySelector('[data-settings-panel="connections"]'); if (!p) return { none: 1 }; return { head: p.querySelector(".v8-sethead .s")?.textContent || "", sources: !!p.querySelector('[data-conn-section="sources"]'), srcHeadAdd: !!p.querySelector('.setcard-head [data-settings-add]'), thisM: !!p.querySelector('[data-conn-section="this-machine"]'), pairBtn: !!p.querySelector('[data-conn-section="this-machine"] [data-settings-pair]'), pairLabel: (p.querySelector('[data-conn-section="this-machine"] [data-settings-pair]') || {}).textContent || "", devicesIn: !!p.querySelector('[data-conn-section="this-machine"] [data-settings-live="devices"]'), diagbar: !!p.querySelector('[data-conn-section="diag"]'), account: !!p.querySelector('[data-conn-section="account"]'), nearby: !!p.querySelector('[data-conn-section="nearby"]'), hiddenAcct: p.querySelector('[data-conn-section="account"]')?.hidden, emptyText: p.querySelector('[data-settings-live="remote-sources"]')?.textContent || "", oldWords: /远程源|本页设备|添加服务器/.test(p.textContent) && !/远程数据源/.test("") }; })())`));
ok(!g.none && g.sources && g.srcHeadAdd, "①a 源列表卡：setcard-head + 卡头「＋ 添加」钮");
ok(g.head.includes("连到别的电脑"), "①b 副题改写：" + g.head);
ok(g.thisM && g.pairBtn && g.pairLabel.includes("出示配对码"), "①c 这台电脑卡 + 「出示配对码」钮（" + g.pairLabel + "）");
ok(g.devicesIn, "①d 连进来的设备台账归宿（data-settings-live=devices 入卡）");
ok(g.diagbar && g.account === true && g.nearby === true && g.hiddenAcct === false, "①e 诊断 bar + account 卡升顶可见（非 hidden）+ nearby hidden 锚（W-ACCOUNT 件三翻面）");
ok(g.emptyText.includes("还没有连接其他电脑") && g.emptyText.includes("出示配对码"), "①f 空态单路径指路");

// ② 全页旧词扫描（连接面板范围内）
const olds = await ev(`(() => { const p = document.querySelector('[data-settings-panel="connections"]'); if (!p) return "[]"; const hits = []; if (p.textContent.includes("本页设备")) hits.push("本页设备"); if (p.textContent.includes("添加服务器")) hits.push("添加服务器"); if (p.textContent.includes("客户端 · 连到本机的终端")) hits.push("客户端lane"); if (p.textContent.includes("远程源")) hits.push("远程源"); return JSON.stringify(hits); })()`);
ok(olds === "[]", "② 连接页旧词零残留（" + olds + "）");
// ③ CSS 规则生效
const css = JSON.parse(await ev(`JSON.stringify((() => { const row = document.querySelector('[data-settings-live="remote-sources"] .settings-row'); const btn = document.querySelector('[data-settings-panel="connections"] .settings-row .row-share:not([hidden])'); return { rowBorder: row ? getComputedStyle(row).borderBottomStyle : "?", rowTopW: row ? getComputedStyle(row).borderTopWidth : "?", rowBg: row ? getComputedStyle(row).backgroundColor : "?", btnDisp: btn ? getComputedStyle(btn).display : "?", btnCssH: btn ? getComputedStyle(btn).height : "?", btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0, editHidden: (() => { const e = document.querySelector('[data-settings-live="remote-sources"] .row-edit'); if (!e) return "absent"; const cs = getComputedStyle(e); return cs.visibility; })() }; })())`));
ok(css.rowBorder === "none" || css.rowBorder === "dashed", "③a 行基座去描边（空态单行=last-child 无底线/多行=虚线——实测 " + css.rowBorder + "）");
ok(css.btnCssH === "24px" || (css.btnH >= 22 && css.btnH <= 26), "③b 24px 控件档（css " + css.btnCssH + " / rect " + css.btnH + " / disp " + css.btnDisp + "）");
ok(css.editHidden === "hidden" || css.editHidden === "absent", "③c 编辑钮默认隐（" + css.editHidden + "——空态无钮=absent）");
// ④ 诊断 bar LAN 形态 hidden
const diagHidden = await ev(`document.querySelector('[data-conn-section="diag"]')?.hidden`);
ok(diagHidden === true, "④ LAN 形态诊断 bar hidden（relay-diag 原位承载）");
// ⑤ 零异常
ok(errs.length === 0, "⑤ 零 JS 异常" + (errs.length ? " → " + errs[0] : ""));
console.log(`\\n§CONNV3：${pass} ok / ${fail} FAIL`);
ws.close(); globalThis.__p.kill(); process.exit(fail ? 1 : 0);
