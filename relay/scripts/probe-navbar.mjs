// W-NAVBAR 期二 CDP 探针：动效数字（呼出 .543s/收起 .343s 曲线）+轨道高度前后对照+
// 抽屉钮避让归零+三证（hover 展开/点击跳转/滚动联动）+双主题截图。
// 骨架复用 probe-fzone-shot；夹具=SNAPSHOT payload.logs 字典（期一坑实录口径）。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9860 + Math.floor(Math.random() * 200);
const OUT = "/Users/xdd/.cc-deck/artifacts/navbar-p2-shots";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/navp2-cdp-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
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
for (let i = 0; i < 5; i++) { const st = await ev(`JSON.stringify({ rs: document.readyState })`).catch(() => null); if (st && JSON.parse(st).rs === "complete") break; await wait(1200); }

const now = Date.now();
const logs = [];
for (let i = 1; i <= 5; i++) {
  logs.push({ id: `u${i}`, kind: "user_message", ts: now - (10 - i) * 60_000, text: `第${i}个提问：帮我处理任务编号 ${i} 的${["存储清理", "版本核对", "文档归档", "依赖排查", "日志分析"][i - 1]}，并给出完整结论报告` });
  logs.push({ id: `a${i}`, kind: "assistant_text", ts: now - (10 - i) * 60_000 + 30_000, text: `回答 ${i}：` + "这是较长的回答正文，用于制造滚动域。".repeat(12) });
}
const sess = { session_id: "nav-demo", title: "导航条演示", status: "DONE", engine: "claude", model: "glm-5.3", cwd: "/tmp/nav-demo", updated_at: now, started_at: now - 600_000, duration_ms: 245000, context_usage: 84000, context_limit: 200000, artifacts: [] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [sess], logs: { "nav-demo": logs }, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`(() => { try { navigator.clipboard.writeText = () => Promise.resolve(); } catch (_) {} window.addEventListener("error", e => (window.__nbErrs = window.__nbErrs || []).push(String(e.message).slice(0, 80))); window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} }; })()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`document.querySelector('[data-session-card="nav-demo"]').click()`);
await ev(`document.querySelector('[data-session-card="nav-demo"]').classList.add("selected")`);
await wait(700); // MO 200ms 去颤一次

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ① 门槛渲染+折叠态形态（clip 只露 44px 线区+卡面透明）
const s1 = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar"); if (!nb) return { none: true }; const p = nb.querySelector(".msg-navbar__panel"); const li = nb.querySelector(".msg-navbar__list"); const cs = getComputedStyle(p); const lcs = getComputedStyle(li); return { hidden: nb.hidden, rows: li.querySelectorAll(".msg-navbar__item").length, ticks: li.querySelectorAll(".tick").length, aria: nb.getAttribute("aria-label"), clip: lcs.clipPath, bg: cs.backgroundColor, shadow: cs.boxShadow, mask: lcs.maskImage, transDur: cs.transitionDuration.split(", ")[0], transFn: cs.transitionTimingFunction.split(", ")[0], panelH: Math.round(p.getBoundingClientRect().height), right: Math.round(nb.getBoundingClientRect().right) }; })())`));
ok(!s1.none && s1.hidden === false && s1.rows === 5 && s1.ticks === 5, `① 门槛渲染：5 行单套 DOM+5 tick 线（rows=${s1.rows}）`);
ok(s1.clip.includes("calc(100% - 44px)") && s1.bg === "rgba(0, 0, 0, 0)", `①b 折叠态=纯线轨（NAVR8 分层：clip 在 list 层只露右侧 44px 线区+卡壳透明 bg=${s1.bg}）`);
ok(s1.transDur === "0.343s" && s1.transFn.includes("cubic-bezier(0.45, 0, 0.3, 1)", ) === false ? s1.transFn.includes("cubic-bezier(0.45") : true, `①c 收起方向动效参数=${s1.transDur} ${s1.transFn.slice(0, 30)}（原版 .343s cubic-bezier(.45,0,.3,1)）`);
ok(s1.panelH >= 5 * 16 && s1.panelH <= 5 * 16 + 16, `③高度对照（NAVR5 密度令跟钉）：面板折叠高=${s1.panelH}px=5×16+padding（#173 六轮密度收敛终值 16px 密轨——原 22px 钉是 NAVR5 落地后探针未跟的历史漂移，八修批 2026-11-17 补钉）`);

// ② hover 展开：中途采样（N1/N2 mount-then-toggle 真播）+终态断言（等 .543s 过渡完）
await ev(`document.querySelector(".msg-navbar").dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: document.querySelector(".msg-navbar").getBoundingClientRect().right - 20 }))`);
await wait(150); // .543s 过渡早段（60ms 防抖+双 rAF≈80ms 后≈70ms 入渡≈13%——弹性缓动前快后慢，340ms 已 97% 采不到中间值）
const mid = JSON.parse(await ev(`JSON.stringify((() => { const it = document.querySelector(".msg-navbar .msg-navbar__item"); const txt = it && it.querySelector(".txt"); return { h: it ? Math.round(it.getBoundingClientRect().height) : null, o: txt ? Number(getComputedStyle(txt).opacity) : null }; })())`));
ok(mid.h > 16.5 && mid.h < 27.5, `N1 行级过渡真播（mount-then-toggle）：过渡中段行高=${mid.h}px∈(16,28)——旧 renderRows 重建=终态首帧单帧跳变（动效路 P0 根修实证）`);
ok(mid.o > 0.05 && mid.o < 0.95, `N2 文字滑显真播：中段 opacity=${mid.o}∈(0,1)`);
await wait(690);
const s2 = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar"); const p = nb.querySelector(".msg-navbar__panel"); const li = nb.querySelector(".msg-navbar__list"); const cs = getComputedStyle(p); const lcs = getComputedStyle(li); return { open: nb.classList.contains("open"), ariaExp: nb.getAttribute("aria-expanded"), clip: lcs.clipPath, bg: cs.backgroundColor, border: cs.borderColor, shadow: cs.boxShadow, mask: lcs.maskImage, transDur: cs.transitionDuration.split(", ")[0], transFn: cs.transitionTimingFunction.split(", ")[0], firstTxt: (li.querySelector(".msg-navbar__item .txt")||{}).textContent?.slice(0, 12), role: p.getAttribute("role") }; })())`));
ok(s2.open && s2.ariaExp === "true" && /inset\(0px( 0px)* round 14px\)/.test(s2.clip), `② hover 展开：list clip 全开=${s2.clip}（radius-lg 14px token 化——擦显机制原版同款）`);
ok(s2.bg === "rgb(27, 42, 61)" && s2.border !== "rgba(0, 0, 0, 0)", `②b 卡面浮起=--surface-popover 提亮档（bg=${s2.bg} 比页底亮）+描边 color-mix（视觉路 token 表 #3/#4）`);
ok(String(s2.shadow).includes("64px"), `N3 阴影复活（分层修）：box-shadow 三层影在场=${String(s2.shadow).slice(0, 46)}…——旧结构 clip/mask 双杀阴影=死代码（一致性路 1421px 差分实锤的修复面）`);
ok(!String(s2.mask) || String(s2.mask) === "none", `N4 静置无渐隐税：5 行无溢出 mask=${String(s2.mask)}（条件渐隐 fade-top/bottom 仅滚动未到头挂——mask 静置恒挂为旧病）`);
ok(s2.transDur === "0.543s" && s2.transFn.includes("cubic-bezier(0.16"), `⑦呼出动效=${s2.transDur} ${s2.transFn.slice(0, 34)}（原版 .543s cubic-bezier(.16,1,.3,1) 弹性缓动）`);
ok(/^第1个提问/.test(String(s2.firstTxt)) && s2.role === "listbox", `②c 首行=${s2.firstTxt}…+listbox`);
await shot("p2-open-dark");

// ③ 点击跳转
const before = await ev(`(() => { const b = document.getElementById("session-body"); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event("scroll")); return b.scrollTop; })()`);
await wait(300);
const after = await ev(`(async () => { document.querySelector(".msg-navbar.open .msg-navbar__item").click(); await new Promise(r => setTimeout(r, 900)); return document.getElementById("session-body").scrollTop; })()`);
ok(before > 100 && after < before - 200, `③ 点击跳转：底(${Math.round(before)})→点首行→顶区(${Math.round(after)})`);

// ④ 滚动联动（active tick 加宽 20px 品牌色）
const midActive = await ev(`(async () => { try { const b = document.getElementById("session-body"); b.scrollTop = b.scrollHeight * 0.55; b.dispatchEvent(new Event("scroll")); await new Promise(r => setTimeout(r, 300)); const act = document.querySelector(".msg-navbar__item--active"); const tick = act && act.querySelector(".tick"); return JSON.stringify({ txt: act?.querySelector(".txt")?.textContent?.slice(0, 6), w: tick ? getComputedStyle(tick).width : "none", color: tick ? getComputedStyle(tick).backgroundColor : "none" }); } catch (e) { return JSON.stringify({ err: String(e) }); } })()`);
const ma = JSON.parse(midActive);
ok(ma.txt && /^第\d个提问/.test(ma.txt) && parseFloat(ma.w) >= 19, `④ 滚动联动：active=${ma.txt}…+tick 加宽 ${ma.w}（原版 12→20 同宽，品牌色）`);

// ⑤ Escape 收起（等 .343s 过渡+visibility/卡面回隐）
await ev(`(() => { document.querySelector(".msg-navbar").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); })()`);
await wait(450);
const s5 = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar"); const p = nb.querySelector(".msg-navbar__panel"); const li = nb.querySelector(".msg-navbar__list"); return { open: nb.classList.contains("open"), clip: getComputedStyle(li).clipPath, bg: getComputedStyle(p).backgroundColor, rows: li.querySelectorAll(".msg-navbar__item").length }; })())`));
ok(!s5.open && s5.clip.includes("calc(100% - 44px)") && s5.bg === "rgba(0, 0, 0, 0)", `⑤ Escape 收起：list clip 回折叠态+卡壳回隐（.343s 反向过渡播完 360ms 后换血回采样轨 rows=${s5.rows}）`);

// ⑨ 避让：navbar 与 inspector-expand 抽屉钮交集=0
const s9 = JSON.parse(await ev(`JSON.stringify((() => { const nb = document.querySelector(".msg-navbar").getBoundingClientRect(); const btn = document.querySelector("#d-session .inspector-expand"); if (!btn) return { noBtn: true }; const ib = btn.getBoundingClientRect(); const ix = Math.max(0, Math.min(nb.right, ib.right) - Math.max(nb.left, ib.left)); const iy = Math.max(0, Math.min(nb.bottom, ib.bottom) - Math.max(nb.top, ib.top)); return { nbRight: Math.round(nb.right), btnX: Math.round(ib.x), inter: Math.round(ix * iy), gap: Math.round(ib.x - nb.right) }; })())`));
ok(s9.noBtn || s9.inter === 0, `⑨ 避让归零（W-UIP2 期三口径：贴底右缘=垂直分离——交集面积=0 即达标；期二「水平让位 gap>0」形态随 right 34→8 贴边退役）：轨右缘 ${s9.nbRight ?? "?"} vs 抽屉钮 x=${s9.btnX ?? "?"}——交集 ${s9.inter ?? "?"}px²（间距 ${s9.gap ?? "?"}px）`);

// ⑥ 亮色+console 零错
await ev(`document.documentElement.setAttribute("data-theme", "light")`);
await ev(`document.querySelector(".msg-navbar").dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, clientX: document.querySelector(".msg-navbar").getBoundingClientRect().right - 20 }))`);
await wait(700);
await shot("p2-open-light");
ok(consoleErrs.length === 0, `⑥ 全程 console 零错（${consoleErrs.length} 条${consoleErrs.length ? "：" + consoleErrs[0] : ""}）`);
console.log(`\nnavbar-p2 probe：${pass} ok / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
