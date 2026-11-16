// W-FZONE-R6 + NAVR7 CDP 探针（1116 用户六条反馈全链自测）：
//  A. fzone 无壳分支：sash 纯占比拖动（窗口宽恒定+面板↔chat 此消彼长+W_KEY 记忆）
//  B. tabpage 入阅读列（padding=calc((100%-COL)/2) 宽窗>22px 地板）+C. 工作区字号（fz-md 14/fz-code 12.5）
//  D. navbar：lift 基线 44/展开行高 26/hover 行字号 14/wheel 滚动 scrollTop>0/inspector-expand 32%
//  E. console 零错误。骨架复用 probe-navbar.mjs。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9860 + Math.floor(Math.random() * 200);
const OUT = "/Users/xdd/.cc-deck/artifacts/r6-shots";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/r6-cdp-" + Date.now(), "--window-size=1512,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
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
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mousePressed" || type === "mouseReleased" ? "left" : "none", buttons: extra.buttons ?? (type === "mousePressed" ? 1 : 0), clickCount: 0, ...extra });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*"] });
await send("Page.reload");
await wait(3200);
for (let i = 0; i < 5; i++) { const st = await ev(`JSON.stringify({ rs: document.readyState })`).catch(() => null); if (st && JSON.parse(st).rs === "complete") break; await wait(1200); }

// ---------- 夹具：40 组问答（navbar 全量滚动域）+artifacts 一项（fzone 打开链） ----------
const now = Date.now();
const logs = [];
for (let i = 1; i <= 40; i++) {
  logs.push({ id: `u${i}`, kind: "user_message", ts: now - (41 - i) * 60_000, text: `第${i}个提问：帮我处理任务编号 ${i} 的存储清理，并给出完整结论报告` });
  logs.push({ id: `a${i}`, kind: "assistant_text", ts: now - (41 - i) * 60_000 + 30_000, text: `回答 ${i}：` + "这是较长的回答正文，用于制造滚动域。".repeat(8) });
}
const sess = { session_id: "nav-demo", title: "R6 演示", status: "DONE", engine: "claude", model: "glm-5.3", cwd: "/tmp/nav-demo", updated_at: now, started_at: now - 600_000, duration_ms: 245000, context_usage: 84000, context_limit: 200000, artifacts: [{ path: "/tmp/nav-demo/report.md", kind: "file", delivered_at: now }] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [sess], logs: { "nav-demo": logs }, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`(() => { try { navigator.clipboard.writeText = () => Promise.resolve(); } catch (_) {} window.addEventListener("error", e => (window.__r6Errs = window.__r6Errs || []).push(String(e.message).slice(0, 80))); window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} }; })()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`document.querySelector('[data-session-card="nav-demo"]').click()`);
await wait(900);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const geom = () => ev(`JSON.stringify((() => { const fz = document.getElementById("fzone"), sash = document.querySelector("#d-session .fz-sash"), chat = document.querySelector("#d-session .session-detail"); return { iw: window.innerWidth, fzW: Math.round(fz.getBoundingClientRect().width), chatW: Math.round(chat.getBoundingClientRect().width), sashX: Math.round(sash.getBoundingClientRect().x + 2), fzOpen: !fz.hidden }; })())`).then(JSON.parse);

// ---------- A. fzone：开区（无壳=挤压护栏）→ sash 纯占比拖动 ----------
await ev(`window.ccDeckFzone.open("nav-demo", "/tmp/nav-demo/report.md")`);
await wait(600);
const g0 = await geom();
ok(g0.fzOpen && g0.fzW >= 340, `A1 开工作区（无壳挤压护栏）：面板宽=${g0.fzW}px`);
const iw0 = g0.iw, chat0 = g0.chatW;
// 拖 sash 向左 90px（加宽）——CDP 真实输入链（pointerdown→pointermove→pointerup+capture）
const hitInfo = JSON.parse(await ev(`JSON.stringify((() => { const el = document.elementFromPoint(${g0.sashX}, 400); return { tag: el ? el.className : "none" }; })())`));
console.log(`  · A-hit: sashX=${g0.sashX} hit=${JSON.stringify(hitInfo)}`);
await mouse("mouseMoved", g0.sashX, 400);
await mouse("mousePressed", g0.sashX, 400);
await wait(120);
const dragging = await ev(`document.querySelector("#d-session .fz-sash").classList.contains("dragging")`);
console.log(`  · A-down: dragging=${dragging}`);
for (let dx = 15; dx <= 90; dx += 15) { await mouse("mouseMoved", g0.sashX - dx, 400, { buttons: 1 }); await wait(40); } // 拖拽期按住态（buttons:1）；悬停探测用 0——按住态不驱动 :hover
await wait(200);
await mouse("mouseReleased", g0.sashX - 90, 400);
await wait(300);
const g1 = await geom();
ok(g1.iw === iw0, `A2 纯占比：窗口宽恒定 ${g1.iw}（无 setSize）`);
ok(g1.fzW > g0.fzW + 60, `A3 拖宽：面板 ${g0.fzW}→${g1.fzW}px（+${g1.fzW - g0.fzW}）`);
ok(Math.abs((g1.chatW + g1.fzW) - (chat0 + g0.fzW)) <= 2, `A4 此消彼长：chat ${chat0}→${g1.chatW}（和恒等 Δ=${(g1.chatW + g1.fzW) - (chat0 + g0.fzW)}）`);
const wKey = await ev(`localStorage.getItem("ccd_fzone_w")`);
ok(Number(wKey) >= 340 && Number(wKey) <= 800, `A5 记忆写入 W_KEY=${wKey}`);
await shot("a-sash-drag");

// 拖回右 60px（收窄）——chat 还位
await mouse("mouseMoved", g1.sashX, 400);
await mouse("mousePressed", g1.sashX, 400);
for (let dx = 10; dx <= 60; dx += 10) await mouse("mouseMoved", g1.sashX + dx, 400, { buttons: 1 });
await wait(150);
await mouse("mouseReleased", g1.sashX + 60, 400);
await wait(250);
const g2 = await geom();
ok(g2.fzW < g1.fzW - 40 && g2.chatW > g1.chatW + 40, `A6 拖窄还 chat：面板 ${g1.fzW}→${g2.fzW}，chat ${g1.chatW}→${g2.chatW}`);

// ---------- B. tabpage 入阅读列（segment-bar tabs[1]；两档都验：fzone 开=地板档 / fzone 收=留白档） ----------
// fzone 开着 tabpage 宽 771<COL 1028 → calc 负被 max() 地板回 22px（窄窗零回归=正确行为）；
// 收起 fzone 面板宽 >COL 才验得出留白档
await ev(`(() => { const tabs = [...document.querySelectorAll("#d-session .segment-bar button")]; if (tabs[1]) tabs[1].click(); })()`);
await wait(500);
const bFloor = JSON.parse(await ev(`(() => { const p = document.querySelector(".tabpage-pane.active .tabpage-scroll"); return JSON.stringify(p ? { pl: getComputedStyle(p).paddingLeft, w: Math.round(p.getBoundingClientRect().width) } : { none: 1 }); })()`));
await ev(`window.ccDeckFzone.toggle()`); // 收起 fzone（chat 域回满宽）
await wait(400);
const tp = JSON.parse(await ev(`(() => { const p = document.querySelector(".tabpage-pane.active .tabpage-scroll"); if (!p) return JSON.stringify({ none: 1 }); const cs = getComputedStyle(p); return JSON.stringify({ pl: cs.paddingLeft, pr: cs.paddingRight, w: Math.round(p.getBoundingClientRect().width) }); })()`));
const colW = Math.max(900, Math.min(1180, 1512 * 0.68));
ok(bFloor && parseFloat(bFloor.pl) === 22, `B0 地板档（fzone 开=窄于阅读列）：padding=${bFloor && bFloor.pl}（calc 负值地板回 22px=窄窗零回归）`);
ok(!tp.none && parseFloat(tp.pl) > 22, `B1 tabpage 入阅读列（fzone 收=宽于阅读列）：padding=${tp.pl}（列宽 ${Math.round(colW)}，面板宽 ${tp.w}——两侧留白 ${(parseFloat(tp.pl) - 22).toFixed(0)}px）`);
ok(tp.pl === tp.pr, `B2 左右对称（${tp.pl}/${tp.pr}）`);
await shot("b-tabpage-pad");

// ---------- C. 工作区字号（生产 CSS 规则计算值——.fzone 作用域真实链） ----------
const fsz = JSON.parse(await ev(`(() => { const b = document.querySelector("[data-fz-body]"); const md = document.createElement("div"); md.className = "fz-md"; md.textContent = "字号探针"; b.appendChild(md); const mdFs = getComputedStyle(md).fontSize; const code = document.createElement("div"); code.className = "fz-code"; code.innerHTML = "<pre>x</pre>"; b.appendChild(code); const cFs = getComputedStyle(code).fontSize; md.remove(); code.remove(); return JSON.stringify({ md: mdFs, code: cFs }); })()`));
ok(parseFloat(fsz.md) >= 14 && parseFloat(fsz.md) < 15, `C1 fz-md=${fsz.md}（--fs-A 14px 档）`);
ok(parseFloat(fsz.code) >= 12.5 && parseFloat(fsz.code) < 13, `C2 fz-code=${fsz.code}（--fs-D 12.5px 档）`);

// ---------- D. navbar 四件（回对话 tab——segment-bar tabs[0]） ----------
await ev(`(() => { const tabs = [...document.querySelectorAll("#d-session .segment-bar button")]; if (tabs[0]) tabs[0].click(); })()`);
await wait(800); // 回对话后 MO 200ms 去颤 rebuild + navbar 重建
const lift = await ev(`getComputedStyle(document.querySelector(".msg-navbar")).getPropertyValue("--msg-navbar-lift") || document.querySelector(".msg-navbar").style.getPropertyValue("--msg-navbar-lift")`);
ok(parseFloat(lift) >= 100, `D1 lift 基线=底栈全距+44（--msg-navbar-lift=${lift.trim()}）`);
const nbVisible = await ev(`!document.querySelector(".msg-navbar").hidden`);
ok(nbVisible, `D0 tab 切回对话后导航条复活（NAVR7-⑥ rebuild 补活——探针实锤修复）`);
// hover 展开：DOM 级 mouseenter（bubbles:false 同生产语义——headless CDP mouseMoved 不派发 mouseenter，probe-navbar 先例）
await ev(`(() => { const nb = document.querySelector(".msg-navbar"); const r = nb.getBoundingClientRect(); nb.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: r.right - 20, clientY: r.top + r.height / 2 })); })()`);
await wait(900); // enter 60ms + .543s 展开过渡
const dOpen = JSON.parse(await ev(`(() => { const p = document.querySelector(".msg-navbar__panel"); const r = p.querySelector(".msg-navbar__item"); return JSON.stringify({ rows: p.querySelectorAll(".msg-navbar__item").length, rowH: r ? Math.round(r.getBoundingClientRect().height) : 0, sh: Math.round(p.scrollHeight), ch: Math.round(p.clientHeight) }); })()`));
ok(dOpen.rowH >= 26 && dOpen.rowH <= 27, `D2 展开行高 26px 态分档（实测 ${dOpen.rowH}——折叠轨 16px 密档不连坐）`);
ok(dOpen.rows === 40, `D3 展开全量 40 行（${dOpen.rows}）`);
ok(dOpen.sh > dOpen.ch, `D4 可滚域：scrollHeight ${dOpen.sh} > clientHeight ${dOpen.ch}`);
await shot("d-navbar-open");
// wheel 滚动（DOM 级 WheelEvent——cancelable 承载 preventDefault 链）
const st0 = await ev(`document.querySelector(".msg-navbar__panel").scrollTop`);
await ev(`document.querySelector(".msg-navbar__panel").dispatchEvent(new WheelEvent("wheel", { deltaY: 240, cancelable: true, bubbles: true }))`);
await wait(250);
const st1 = await ev(`document.querySelector(".msg-navbar__panel").scrollTop`);
ok(st1 > st0 + 60, `D5 wheel 滚动生效：scrollTop ${st0}→${st1}（显式兜底链）`);
// hover 行字号 +2（先滚回顶——wheel 后 items[3] 已滚出视口会打空）
await ev(`document.querySelector(".msg-navbar__panel").scrollTop = 0`);
await wait(120);
const rows = JSON.parse(await ev(`(() => { const p = document.querySelector(".msg-navbar__panel"); const items = [...p.querySelectorAll(".msg-navbar__item")]; const rc = items[10].getBoundingClientRect(); return JSON.stringify({ x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + rc.height / 2) }); })()`));
await mouse("mouseMoved", rows.x, rows.y);
await wait(350); // font-size .18s 过渡
const d6dbg = await ev(`(() => { const el = document.elementFromPoint(${rows.x}, ${rows.y}); const p = document.querySelector(".msg-navbar__panel"); const items = [...p.querySelectorAll(".msg-navbar__item")]; const hov = items.find(i => i.matches(":hover")); return JSON.stringify({ hit: el ? String(el.className).slice(0, 30) : "none", hovIdx: hov ? items.indexOf(hov) : -1 }); })()`);
console.log(`  · D6-debug @(${rows.x},${rows.y}) ${d6dbg}`);
const hovFs = await ev(`(() => { const p = document.querySelector(".msg-navbar__panel"); const items = [...p.querySelectorAll(".msg-navbar__item")]; const hov = items.find(i => i.matches(":hover")); return hov ? getComputedStyle(hov.querySelector(".txt")).fontSize : "no-hover"; })()`);
ok(parseFloat(hovFs) >= 14 && parseFloat(hovFs) < 15, `D6 hover 行字号=${hovFs}（+2 号动效档 12→14px）`);
await shot("d-hover-row");
// inspector-expand 上移
const ieTop = await ev(`(() => { const b = document.querySelector(".inspector-expand"); if (!b) return "none"; return b.getBoundingClientRect().top < window.innerHeight * 0.45 ? "up" : "mid"; })()`);
ok(ieTop === "up", `D7 inspector-expand 呼出钮上移（top 32%<45% 中线——避让消息滚动条）`);

// ---------- E. 错误面 ----------
const pageErrs = await ev(`JSON.stringify(window.__r6Errs || [])`);
ok(consoleErrs.length === 0 && JSON.parse(pageErrs).length === 0, `E console/页面零错误（cdp=${consoleErrs.length} page=${JSON.parse(pageErrs).length}${consoleErrs.length ? " → " + consoleErrs.slice(0, 3).join(" | ") : ""}）`);

console.log(`\n§R6+NAVR7：${pass} ok / ${fail} FAIL`);
ws.close(); globalThis.__p.kill(); process.exit(fail ? 1 : 0);
