// [W-BOARDPOLISH] 泳道横向收窄折叠+分段条完成剥离探针（probe-boardlife-shot 骨架复用）。
// 断言：折叠 44px 竖条+默认态（done 折/planned 开）+条内无 done 段+✓ N 徽章+图例同步+
// 段 title 计数+min-width 2px+横向释放数字+localStorage 键沿用+1280/990 窄窗协同。
// 产物：~/.cc-deck/artifacts/boardpolish-shots/<tag>/*.png
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = process.argv[2] || "after";
const OUT = `/Users/xdd/.cc-deck/artifacts/boardpolish-shots/${TAG}`;
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/bp-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) {
  await wait(500);
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; }
}
if (!list) { console.error("Chrome CDP 15s 未就绪，退出"); process.exit(2); }
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * Math.max(64, 1024) * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

// mock 板：实产碾压形态——done 120 张 vs 活跃 9 张（用户实测口径复刻）
const now = Date.now(), DAY = 86400000;
const mkDone = (i) => ({ id: "t-d" + i, text: "已收割任务 #" + i, status: "done", owner_session: "bp-w2", dispatch_id: "dd" + i, ts: now - 2 * DAY - i * 6e5, updated_at: now - 6e5 - i * 6e5, transitions: [{ status: "done", ts: now - 6e5 - i * 6e5 }] });
const entries = [
  { id: "t-pl1", text: "规划中：缓做想法（攒批待评估）", status: "planned", ts: now - 9e6, updated_at: now - 9e6 },
  { id: "t-bl1", text: "待认领单甲", status: "backlog", ts: now - 3e6, updated_at: now - 3e6 },
  { id: "t-bl2", text: "待认领单乙", status: "backlog", ts: now - 3.1e6, updated_at: now - 3e6 },
  { id: "t-c1", text: "进行中单一", status: "claimed", owner_session: "bp-w1", dispatch_id: "dc1", ts: now - 4e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4e6 }] },
  { id: "t-c2", text: "进行中单二", status: "claimed", owner_session: "bp-w1", dispatch_id: "dc2", ts: now - 4.1e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4.1e6 }] },
  { id: "t-c3", text: "进行中单三", status: "claimed", owner_session: "bp-w1", dispatch_id: "dc3", ts: now - 4.2e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4.2e6 }] },
  { id: "t-s1", text: "审查中单一", status: "submitted", owner_session: "bp-w1", dispatch_id: "ds1", review_required: true, ts: now - 5e6, updated_at: now - 8e5, transitions: [{ status: "submitted", ts: now - 8e5 }] },
  { id: "t-s2", text: "审查中单二", status: "submitted", owner_session: "bp-w1", dispatch_id: "ds2", review_required: true, ts: now - 5.1e6, updated_at: now - 8e5, transitions: [{ status: "submitted", ts: now - 8e5 }] },
  { id: "t-r1", text: "待收单单", status: "ready_to_install", owner_session: "bp-w1", dispatch_id: "dr1", ts: now - 6e6, updated_at: now - 7e5, transitions: [{ status: "ready_to_install", ts: now - 7e5 }] },
];
for (let i = 0; i < 120; i++) entries.push(mkDone(i));
const board = { gid: "pg-bp", entries };
const mkS = (id, name, st, act) => ({ id, name, status: st, engine: "claude", last_active_at: now - act, context: { used: 40000, limit: 200000 } });
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  mkS("bp-w1", "worker·阿禾", "WORKING", 3e5), mkS("bp-w2", "worker·小满", "DONE", 8e5), mkS("bp-pm", "PM", "WAITING", 2e5),
], projects: [
  { id: "pg-bp", name: "CC Deck", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount: [{ session_id: "bp-w1", role: "worker", nick: "阿禾" }, { session_id: "bp-w2", role: "worker", nick: "小满" }, { session_id: "bp-pm", role: "pm", nick: "值班PM" }], created_at: now - 30 * DAY, updated_at: now - 3e5 },
], boards: [board], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };

await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(700);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(500);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`);
await ev(`window.ccDeckTeam?.select?.("pg-bp")`);
await wait(900);
// 清 localStorage 折叠记忆（默认态断言前提）
await ev(`Object.keys(localStorage).filter(k => k.startsWith("lanefold:")).forEach(k => localStorage.removeItem(k))`);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`);
await wait(800);

console.log("A. 分段条完成剥离（done 段/徽章/图例/title/min-width）");
{
  const segDone = await ev(`document.querySelectorAll('#d-team .board-progress i.done').length`);
  ok(segDone === 0, `条内无 done 段（实=${segDone}——修前 120 张碾压全绿）`);
  const badge = await ev(`(document.querySelector('#d-team .ov-done') || {}).textContent || ""`);
  ok(badge.includes("120"), `✓ N 完成徽章独立在场（"${badge.trim()}"）`);
  const legendDone = await ev(`[...document.querySelectorAll('#d-team .board-legend span')].some(s => s.textContent.includes("完成"))`);
  ok(!legendDone, "图例同步无完成行（信息归 ✓ N 徽章）");
  const segN = await ev(`document.querySelectorAll('#d-team .board-progress i').length`);
  ok(segN === 5, `条内恰五活跃段（实=${segN}：planned/backlog/claimed/submitted/ready——活跃分布可辨）`);
  const title = await ev(`(document.querySelector('#d-team .board-progress i.claimed') || {}).title || ""`);
  ok(/进行中\s*3/.test(title), `段 hover title 带计数（claimed title="${title}"）`);
  const minWidth = await ev(`(function(){ const i = document.querySelector('#d-team .board-progress i'); return i ? getComputedStyle(i).minWidth : ""; })()`);
  ok(minWidth === "2px", `每段 min-width 2px 防消失（实=${minWidth}）`);
}

console.log("B. lanehide：列头 ⋯ 菜单隐藏 done 列→列退出列序+停靠条在场");
let widthAll = 0, widthHidden = 0;
{
  // 前置：清 lanehide 记忆（全列形态基线）
  await ev(`Object.keys(localStorage).filter(k => k.startsWith("lanehide:")).forEach(k => localStorage.removeItem(k))`);
  await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap.payload)} })`);
  await wait(700);
  const menuBtn = await ev(`!!document.querySelector('#d-team .lane-done .lane-menu-btn')`);
  ok(menuBtn === true, "done 列头 ⋯ 菜单钮在场（hover 显）");
  const coreMenuAbsent = await ev(`!!document.querySelector('#d-team .lane-backlog .lane-menu-btn')`);
  ok(coreMenuAbsent === false, "四核心列无菜单（只 done/planned 可隐藏）");
  widthAll = await ev(`(function(){ const ls = [...document.querySelectorAll('#d-team .board .lane')].filter(l => !["done","planned"].some(c => l.classList.contains("lane-" + c))); const ws = ls.map(l => l.getBoundingClientRect().width); return ws.length ? Math.round(ws.reduce((a,b)=>a+b,0)/ws.length) : -1; })()`);
  // 隐藏 done：⋯ 开菜单→点「隐藏此列」
  await ev(`document.querySelector('#d-team .lane-done .lane-menu-btn').click()`);
  await wait(200);
  const menuItem = await ev(`!!document.querySelector('#d-team .lane-done .lane-menu-item[data-lane-hide="done"]')`);
  ok(menuItem === true, "菜单项「隐藏此列」在场（⋯ 点击展开）");
  await ev(`document.querySelector('#d-team .lane-done .lane-menu-item[data-lane-hide="done"]').click()`);
  await wait(700);
  const doneGone = await ev(`!document.querySelector('#d-team .board .lane-done')`);
  ok(doneGone === true, "done 整列退出列序（含 120 卡渲染量一并省）");
  const dock = await ev(`(document.querySelector('#d-team .lane-dock .dock-chip[data-lane-unhide="done"]') || {}).textContent || ""`);
  ok(dock.includes("已隐藏") && dock.includes("120"), `板尾停靠条在场（"${dock.trim()}"——计数直达）`);
  widthHidden = await ev(`(function(){ const ls = [...document.querySelectorAll('#d-team .board .lane')].filter(l => !["done","planned"].some(c => l.classList.contains("lane-" + c))); const ws = ls.map(l => l.getBoundingClientRect().width); return ws.length ? Math.round(ws.reduce((a,b)=>a+b,0)/ws.length) : -1; })()`);
  ok(widthHidden > widthAll + 15, `四核心列宽度回收（均宽 ${widthAll}px → ${widthHidden}px，+${Math.round((widthHidden-widthAll)/widthAll*100)}%——dock 在板外不占列宽）`);
  const key = await ev(`Object.keys(localStorage).find(k => k.startsWith("lanehide:") && k.includes("done")) || ""`);
  ok(key === "lanehide:pg-bp:done", `localStorage 记忆键 lanehide:(boardId,status)（"${key}"）`);
  await shot("01-hide-done-dock-1440");
}

console.log("C. lanehide：停靠条临时展开→收起（临时态内存集，刷新还原）");
{
  await ev(`document.querySelector('#d-team .lane-dock .dock-chip[data-lane-unhide="done"]').click()`);
  await wait(700);
  const tempShown = await ev(`!!document.querySelector('#d-team .board .lane-done.lane-temp-shown')`);
  ok(tempShown === true, "点击停靠条→done 临时展开（lane-temp-shown 虚线提示）");
  const dockGone = await ev(`!document.querySelector('#d-team .lane-dock .dock-chip[data-lane-unhide="done"]')`);
  ok(dockGone === true, "临时展开后停靠条该 chip 撤（列已在板）");
  await ev(`document.querySelector('#d-team .lane-done .lane-menu-btn').click()`);
  await wait(200);
  const collapseItem = await ev(`!!document.querySelector('#d-team .lane-done .lane-menu-item[data-lane-collapse="done"]')`);
  ok(collapseItem === true, "临时列菜单项=「⟨ 收起（保持隐藏）」（记忆不动）");
  await ev(`document.querySelector('#d-team .lane-done .lane-menu-item[data-lane-collapse="done"]').click()`);
  await wait(700);
  const backToDock = await ev(`!!document.querySelector('#d-team .lane-dock .dock-chip[data-lane-unhide="done"]')`);
  ok(backToDock === true, "收起→回停靠条（隐藏记忆保持——刷新仍隐藏）");
  const keyAlive = await ev(`localStorage.getItem("lanehide:pg-bp:done")`);
  ok(keyAlive === "1", "临时展开/收起全流程零写记忆（恒 \"1\"）");
}

console.log("D. 停靠条形态对比（横条 default vs 竖窄条备选）+窄窗零溢出");
{
  await shot("02-dock-bar-1440");
  await ev(`document.body.classList.add("lane-dock-rail")`);
  await wait(300);
  await shot("03-dock-rail-1440");
  const railWm = await ev(`(function(){ const c = document.querySelector('#d-team .lane-dock .dock-chip'); return c ? getComputedStyle(c).writingMode : ""; })()`);
  ok(railWm.includes("vertical"), `竖窄条备选形态可切（body.lane-dock-rail——writing-mode=${railWm}，用户挑形态用）`);
  await ev(`document.body.classList.remove("lane-dock-rail")`);
  await wait(300);
  for (const [w, tag] of [[1280, "1280"], [990, "990"]]) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 2, mobile: false });
    await wait(600);
    const overflow = await ev(`(function(){ const b = document.querySelector('#d-team .board-pane') || document.body; return b.scrollWidth - b.clientWidth; })()`);
    ok(overflow <= 0, `${tag} 档（done 隐藏态）无横向溢出（scrollWidth-clientWidth=${overflow}px）`);
    await shot(`04-hide-${tag}`);
  }
  await send("Emulation.clearDeviceMetricsOverride");
}

console.log(`\n===== boardpolish 探针：${pass} ok / ${fail} FAIL =====`);
console.log(`WIDTHS 四核心列均宽: 全列=${widthAll}px 隐藏done=${widthHidden}px`);
globalThis.__p.kill();
process.exit(fail > 0 ? 1 : 0);
