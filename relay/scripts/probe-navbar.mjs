// W-NAVBAR 期一 CDP 探针：历史提问索引轨三证（hover 展开/点击跳转/滚动联动）+双主题截图。
// 骨架复用 probe-fzone-shot（headless Chrome 直开 index-005.html + __ccDeck005Frames 注帧）；
// 夹具=SNAPSHOT 带 5 条 user_message + 5 条 assistant_text 长消息（制造滚动域）。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9860 + Math.floor(Math.random() * 200);
const OUT = "/Users/xdd/.cc-deck/artifacts/navbar-shots";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/navbar-cdp-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
for (let i = 0; i < 8; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await wait(1000); } }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; } if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrs.push(m.params.args?.map(a => a.value ?? a.description).join(" ").slice(0, 160)); if (m.method === "Runtime.exceptionThrown") consoleErrs.push(String(m.params.exceptionDetails?.text).slice(0, 160)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*"] });
await send("Page.reload");
await wait(3200);
for (let i = 0; i < 5; i++) { const st = await ev(`JSON.stringify({ rs: document.readyState, nb: !!document.querySelector(".msg-navbar") })`).catch(() => null); if (st && JSON.parse(st).rs === "complete") break; await wait(1200); }

const now = Date.now();
const logs = [];
for (let i = 1; i <= 5; i++) {
  logs.push({ id: `u${i}`, kind: "user_message", ts: now - (10 - i) * 60_000, text: `第${i}个提问：帮我处理任务编号 ${i} 的${["存储清理", "版本核对", "文档归档", "依赖排查", "日志分析"][i - 1]}，并给出完整结论报告` });
  logs.push({ id: `a${i}`, kind: "assistant_text", ts: now - (10 - i) * 60_000 + 30_000, text: `回答 ${i}：` + "这是较长的回答正文，用于制造滚动域。".repeat(12) });
}
const sess = { session_id: "nav-demo", title: "导航条演示", status: "DONE", engine: "claude", model: "glm-5.3", cwd: "/tmp/nav-demo", updated_at: now, started_at: now - 600_000, duration_ms: 245000, context_usage: 84000, context_limit: 200000, artifacts: [] }; // 消息时间线走 payload.logs 字典（session-domain :803——sessions[].logs 非消费面）
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [sess], logs: { "nav-demo": logs }, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`(() => { try { navigator.clipboard.writeText = () => Promise.resolve(); } catch (_) {} window.addEventListener("error", e => (window.__nbErrs = window.__nbErrs || []).push(String(e.message).slice(0, 80))); window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} }; })()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`document.querySelector('[data-session-card="nav-demo"]').click()`);
await ev(`document.querySelector('[data-session-card="nav-demo"]').classList.add("selected")`);
await wait(1400); // MutationObserver 200ms 去颤+渲染

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ① 门槛渲染：轨在场非 hidden+5 线+aria
const s1 = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar"); if (!nb) return { none: true }; return { hidden: nb.hidden, lines: nb.querySelectorAll(".msg-navbar__line").length, aria: nb.getAttribute("aria-label"), rows: nb.querySelectorAll(".msg-navbar__item").length, bodyScrollable: document.getElementById("session-body").scrollHeight > document.getElementById("session-body").clientHeight + 100 }; })())`));
ok(!s1.none && s1.hidden === false && s1.lines === 5 && s1.rows === 5, `① 门槛渲染：5 条用户消息→轨+面板各 5 行（lines=${s1.lines}/rows=${s1.rows}/hidden=${s1.hidden}）`);
ok(s1.aria === "历史提问" && s1.bodyScrollable, `①b aria=「${s1.aria}」+消息域可滚动（联动有域）`);

// ② hover 展开：mouseenter（原生监听 dispatchEvent 可达）→60ms 防抖→open
await wait(500); // 先过 MutationObserver 200ms 去颤重跑窗（build 会清空重键面板——量在稳态）
const s1b = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar"); return { lines: nb.querySelectorAll(".msg-navbar__line").length, rows: nb.querySelectorAll(".msg-navbar__item").length }; })())`));
ok(s1b.rows === 5, `①c 去颤重跑后稳态：面板 5 行（${s1b.rows}）`);
await ev(`document.querySelector(".msg-navbar").dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }))`);
await wait(450); // 200ms opacity 过渡+防抖余量（180ms 时量在动画中段 op=0.8）
const s2 = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar"); const p = nb.querySelector(".msg-navbar__panel"); const cs = getComputedStyle(p); return { open: nb.classList.contains("open"), ariaExp: nb.getAttribute("aria-expanded"), vis: cs.visibility, op: cs.opacity, firstTxt: (nb.querySelector(".msg-navbar__item .txt")||{}).textContent?.slice(0, 14), role: p.getAttribute("role") }; })())`));
ok(s2.open && s2.ariaExp === "true" && s2.vis === "visible" && Number(s2.op) > 0.9, `② hover 展开（60ms 防抖）：open+aria-expanded+panel 可见（op=${s2.op}）`);
ok(/^第1个提问：帮我处理任务编号/.test(String(s2.firstTxt)) && s2.role === "listbox", `②b 首行文本=${s2.firstTxt}…+panel role=listbox`);
await shot("nav-open-dark");

// ③ 点击跳转：滚到底确认 scrollTop>0 →点第 1 行→smooth 滚回顶部区
const before = await ev(`(() => { const b = document.getElementById("session-body"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return b.scrollTop; })()`);
await wait(300);
const after = await ev(`(async () => { document.querySelector(".msg-navbar.open .msg-navbar__item").click(); await new Promise(r => setTimeout(r, 900)); return document.getElementById("session-body").scrollTop; })()`);
ok(before > 100 && after < before - 200, `③ 点击跳转：底(${Math.round(before)})→点首行→顶区（${Math.round(after)}）smooth scrollIntoView 生效`);

// ④ 滚动联动：滚到中部→active 切到对应行
const midActive = await ev(`(async () => { try { const b = document.getElementById("session-body"); b.scrollTop = b.scrollHeight * 0.55; b.dispatchEvent(new Event("scroll")); await new Promise(r => setTimeout(r, 250)); const act = document.querySelector(".msg-navbar__item--active .txt"); const line = document.querySelector(".msg-navbar__line--active"); return JSON.stringify({ txt: act?.textContent?.slice(0, 6), lineW: line ? getComputedStyle(line).width : "none" }); } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); } })()`);
const ma = JSON.parse(midActive);
ok(ma.txt && /^第\d个提问/.test(ma.txt) && parseFloat(ma.lineW) >= 15, `④ 滚动联动：中部（55%）→active=${ma.txt}…+折叠线加宽（${ma.lineW}，12→20 过渡态≥15 即证双视图同亮）`);

// ⑤ Escape 收起
await ev(`(() => { const nb = document.querySelector(".msg-navbar"); nb.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); })()`);
await wait(320); // 收起向 visibility 有 0s linear .2s 延迟（transition 设计——open 类同步移除、面板淡出后隐藏）
const s5 = await ev(`(() => { const nb = document.querySelector(".msg-navbar"); return JSON.stringify({ open: nb.classList.contains("open"), vis: getComputedStyle(nb.querySelector(".msg-navbar__panel")).visibility }); })()`);
const o5 = JSON.parse(s5);
ok(!o5.open && o5.vis === "hidden", `⑤ Escape 收起（open=${o5.open}/vis=${o5.vis}——open 类移除+panel 隐藏）`);

// ⑦ 折叠线真点击跳转（W-NAVHIT-R1 断言补口——审一 P1 漏网缝：③ 走面板行合成 click()，
//    折叠线点击路径零覆盖；本条走 CDP Input 真坐标点击，命中层（::before 定位层 z 序）
//    若盖线即红——合成 click() 不经 hit-test 测不出此类病）
const foldedClick = await (async () => {
  const b0 = await ev(`(() => { const b = document.getElementById("session-body"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return b.scrollTop; })()`);
  await wait(250);
  const pt = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar"); if (nb.classList.contains("open")) return { err: "open" }; const l = nb.querySelectorAll(".msg-navbar__line")[3]; if (!l) return { err: "noline" }; const r = l.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())`));
  if (pt.err) return { err: pt.err };
  const hit = await ev(`(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y}); return e ? (String(e.className || "").split(" ")[0] || e.tagName) : "null"; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  await wait(900); // smooth scrollIntoView
  const b1 = await ev(`document.getElementById("session-body").scrollTop`);
  return { b0, b1, hit, x: Math.round(pt.x), y: Math.round(pt.y) };
})();
ok(!foldedClick.err && foldedClick.b0 > 100 && foldedClick.b1 < foldedClick.b0 - 200, `⑦ 折叠线真点击跳转：底(${Math.round(foldedClick.b0 ?? -1)})→点线4(${foldedClick.x ?? "?"},${foldedClick.y ?? "?"})→${Math.round(foldedClick.b1 ?? -1)}（elementFromPoint=${foldedClick.hit}——真命中层点击非合成，::before 盖线即红）`);

// ⑥ 亮色主题截图+console 零错
await ev(`document.documentElement.setAttribute("data-theme", "light")`);
await ev(`document.querySelector(".msg-navbar").dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }))`);
await wait(200);
await shot("nav-open-light");
ok(consoleErrs.length === 0, `⑥ 全程 console 零错（${consoleErrs.length} 条${consoleErrs.length ? "：" + consoleErrs[0] : ""}）`);
console.log(`\nnavbar probe：${pass} ok / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
