// [W-BOARDLIFE R2] chip 点击跳会话 E2E（web·CDP 注入 fixture）+slim 态兜底（R2-P1）+泳道头词表（R2-2）。review-w-boardlife-a-1103 取证脚本增补入库
// 基于 relay/scripts/probe-boardlife-shot.mjs 骨架（worker 探针），补：
//   1) waitFor 轮询替代固定 sleep（防首跑渲染竞态）
//   2) 真点击 owner-jump / reviewer chip → 断言 selectSessionCard 落点（session 域选中卡）
//   3) 键盘 Enter 激活探针（role=button tabindex=0 承诺核验——预期 FAIL，a11y 缺口取证）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire("/private/tmp/cc-deck-w-boardlife/relay/node_modules/ws/package.json");
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9901 + Math.floor(Math.random() * 300), TAG = process.argv[2] || "e2e";
const OUT = `/Users/xdd/.cc-deck/artifacts/boardlife-shots/${TAG}`;
const URL0 = "file:///private/tmp/cc-deck-w-boardlife/web-console/index-005.html";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/bl-cdp2-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) { await wait(500); try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; } }
if (!list) { console.error("Chrome CDP 未就绪"); process.exit(2); }
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.consolePosted" && ["error", "warning"].includes(m.params?.type)) consoleErrs.push(String(m.params?.args?.[0]?.value ?? "").slice(0, 160)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(2000);
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };
const waitFor = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(250); } return await ev(expr); };

const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 80000, context_limit: 200000 });
const DAY = 86_400_000;
const board = { gid: "pg-bl", entries: [
  { id: "t-bl1", text: "待认领单（未指派——无 chip 优雅降级）", status: "backlog", ts: now - 3e6, updated_at: now - 3e6 },
  { id: "t-bl2", text: "进行中单：板卡生命周期接线（执行者 chip 可点跳）", status: "claimed", owner_session: "bl-w1", dispatch_id: "dbl1", ts: now - 4e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4e6 }] },
  { id: "t-bl3", text: "待审查单：worker 已交付（处理者 chip=审查中·PM）", status: "submitted", owner_session: "bl-w1", dispatch_id: "dbl2", review_required: true, ts: now - 5e6, updated_at: now - 8e5, transitions: [{ status: "claimed", ts: now - 5e6 }, { status: "submitted", ts: now - 8e5 }] },
  { id: "t-bl4", text: "已收割单（过审完成——done 泳道）", status: "done", owner_session: "bl-w2", dispatch_id: "dbl3", ts: now - 2 * DAY, updated_at: now - 6e5, transitions: [{ status: "claimed", ts: now - 2 * DAY }, { status: "submitted", ts: now - 1e6 }, { status: "done", ts: now - 6e5 }] },
] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  mkS("bl-w1", "worker·阿禾（进行中）", "WORKING", 3e5),
  mkS("bl-w2", "worker·小满（已交付）", "DONE", 8e5),
  mkS("bl-pm", "PM（值守）", "WAITING", 2e5),
], projects: [
  { id: "pg-bl", name: "CC Deck", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount: [{ session_id: "bl-w1", role: "worker", nick: "阿禾" }, { session_id: "bl-w2", role: "worker", nick: "小满" }, { session_id: "bl-pm", role: "pm", nick: "值班PM" }], created_at: now - 30 * DAY, updated_at: now - 3e5 },
], boards: [board], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };

await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`);
await ev(`document.querySelector('.rail-btn[data-domain="team"]')?.click()`);
await ev(`window.ccDeckTeam?.select?.("pg-bl")`);
// 看板 pane：轮询到 board 出现为止
await waitFor(`!!document.querySelector('#d-team .board')`, 8000);
const paneBtn = await ev(`[...document.querySelectorAll('#d-team button')].find(b => /看板/.test(b.textContent))?.click()`);
await waitFor(`document.querySelectorAll('#d-team .lane').length >= 5`, 8000);
const laneN = await ev(`document.querySelectorAll('#d-team .lane').length`);
const cardN = await ev(`document.querySelectorAll('#d-team .task-card').length`);
ok(laneN >= 5, `L0 看板五泳道渲染（实 ${laneN} 泳道/${cardN} 卡）`);

// ---------- chip 渲染断言（worker 探针 B1-B6 同款） ----------
const ownerJump = await ev(`document.querySelectorAll('#d-team .tchip.owner-jump').length`);
ok(ownerJump >= 2, `B1 执行者 chip 可点态在场（${ownerJump} 枚）`);
const jumpAttr = await ev(`document.querySelector('#d-team .tchip.owner-jump')?.dataset.teamMemberSession || ""`);
ok(jumpAttr === "bl-w1", `B2 执行者 chip 挂 sid（${jumpAttr}）`);
const reviewerTxt = await ev(`document.querySelector('#d-team .tchip.reviewer')?.textContent.trim() || ""`);
ok(reviewerTxt.includes("审查中") && reviewerTxt.includes("值班PM"), `B4 处理者 chip 文案（${reviewerTxt}）`);
const revAttr = await ev(`document.querySelector('#d-team .tchip.reviewer')?.dataset.teamMemberSession || ""`);
ok(revAttr === "bl-pm", `B5 处理者 chip 挂 PM sid（${revAttr}）`);

// ---------- E2E 点击链①：claimed 卡执行者 chip → 落点 bl-w1 会话 ----------
await ev(`[...document.querySelectorAll('#d-team .tchip.owner-jump')].find(el => el.dataset.teamMemberSession === 'bl-w1')?.click()`);
await wait(900);
const landedOwner = await ev(`(function(){ const c = document.querySelector('#d-session .queue-card.selected[data-session-card="bl-w1"]'); const rail = document.querySelector('.rail-btn[data-domain="session"]'); return JSON.stringify({ landed: !!c, railActive: !!(rail && rail.classList.contains("active")) }); })()`);
const lo = JSON.parse(landedOwner || "{}");
ok(lo.landed === true, `E1 执行者 chip 点击 → 会话域 bl-w1 卡选中（landed=${lo.landed}）`);
ok(lo.railActive === true, `E2 rail 跳到会话域（railActive=${lo.railActive}）`);
const detailTxt = await ev(`(document.querySelector('#d-session')?.textContent || "").includes("阿禾")`);
ok(detailTxt === true, `E3 落点会话详情可见执行者（阿禾在场=${detailTxt}）`);
await shot("e2e-01-owner-chip-landing");

// ---------- E2E 点击链②：回团队域，submitted 卡处理者 chip → 落点 bl-pm 会话 ----------
await ev(`document.querySelector('.rail-btn[data-domain="team"]')?.click()`);
await waitFor(`!!document.querySelector('#d-team .tchip.reviewer')`, 6000);
await ev(`document.querySelector('#d-team .tchip.reviewer')?.click()`);
await wait(900);
const landedPm = await ev(`(function(){ const c = document.querySelector('#d-session .queue-card.selected[data-session-card="bl-pm"]'); return !!c; })()`);
ok(landedPm === true, `E4 处理者 chip 点击 → 会话域 bl-pm（PM）卡选中（landed=${landedPm}）`);
await shot("e2e-02-reviewer-chip-landing");

// ---------- R2-2 泳道头词表（用户 1103 点名「甬道为什么叫待审查」） ----------
const laneHeads = await ev(`[...document.querySelectorAll('#d-team .lane-head > span:first-child')].map(el => el.textContent.trim())`);
ok(laneHeads.includes("审查中") && !laneHeads.includes("待审查"), `R1 泳道头「审查中」（实 ${JSON.stringify(laneHeads)}——待审查绝迹）`);

// ---------- R2-P1 slim 态兜底（A 审主锤：roster worker 被瘦身收起→DOM 无卡→点击落空） ----------
await ev(`document.querySelector('.rail-btn[data-domain="session"]')?.click()`);
await waitFor(`!!document.querySelector('#d-session [data-session-card="bl-w1"]')`, 6000);
// 模拟 slimIsHidden 收起：DOM 移除 worker 卡（S.sessions 快照仍在——slim 真实形态）
await ev(`document.querySelector('#d-session [data-session-card="bl-w1"]')?.remove()`);
const domGone = await ev(`!document.querySelector('#d-session [data-session-card="bl-w1"]')`);
ok(domGone === true, "E6⓪ slim 形态就位（worker 卡 DOM 移除——快照仍在）");
await ev(`document.querySelector('.rail-btn[data-domain="team"]')?.click()`);
await waitFor(`!!document.querySelector('#d-team .tchip.owner-jump')`, 6000);
await ev(`[...document.querySelectorAll('#d-team .tchip.owner-jump')].find(el => el.dataset.teamMemberSession === 'bl-w1')?.click()`);
await wait(900);
const slimLanded = await ev(`(function(){ const sel = window.__ccDeck005SlimUi?.selectedSid?.() || ""; const card = document.querySelector('#d-session [data-session-card="bl-w1"]'); return JSON.stringify({ sel, reexpanded: !!card }); })()`);
const sl = JSON.parse(slimLanded || "{}");
ok(sl.sel === "bl-w1", `E6 slim 态点执行者 chip → SlimUi.open 直选（selectedSid=${sl.sel}——R2-P1 兜底生效，不再 toast 落空）`);
ok(sl.reexpanded === true, `E7 会话临时出列回显（renderMyList——卡 DOM 复现=${sl.reexpanded}）`);
await shot("e2e-03-slim-fallback-landing");

// ---------- 键盘激活探针（a11y 缺口取证——预期 FAIL） ----------
await ev(`document.querySelector('.rail-btn[data-domain="team"]')?.click()`);
await waitFor(`!!document.querySelector('#d-team .tchip.owner-jump')`, 6000);
await ev(`document.querySelector('#d-team .tchip.owner-jump')?.focus()`);
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
await wait(700);
const kbLanded = await ev(`!!document.querySelector('#d-session .queue-card.selected[data-session-card="bl-w1"]')`);
ok(kbLanded === true, `E5 键盘 Enter 激活 chip（landed=${kbLanded}——P3 a11y 取证位）`);

ok(consoleErrs.length === 0, `Z 零控制台报错（${JSON.stringify(consoleErrs.slice(0, 3))}）`);
globalThis.__p.kill();
console.log(`\n===== boardlife E2E 点击链：${pass} ok / ${fail} FAIL =====`);
process.exit(fail > 0 ? 1 : 0);
