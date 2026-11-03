// [W-BOARDLIFE] 板卡生命周期审查态+双 chip 演示探针（probe-seat-shot 骨架复用：
// Chrome headless + CDP + 注入 SNAPSHOT）。用法：node scripts/probe-boardlife-shot.mjs [tag]
// 产物：~/.cc-deck/artifacts/boardlife-shots/<tag>/*.png + 断言清单
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = process.argv[2] || "after";
const OUT = `/Users/xdd/.cc-deck/artifacts/boardlife-shots/${TAG}`;
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/bl-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) {
  await wait(500);
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; }
}
if (!list) { console.error("Chrome CDP 15s 未就绪，退出"); process.exit(2); }
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.consolePosted" && ["error", "warning"].includes(m.params?.type)) consoleErrs.push(String(m.params?.args?.[0]?.value ?? "").slice(0, 120)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };

// ---------- fixture：三泳道各卡 + PM 席位在岗（chip 数据源） ----------
const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 80000, context_limit: 200000 });
const DAY = 86_400_000;
const board = { gid: "pg-bl", entries: [
  { id: "t-bl1", text: "待认领单（未指派——无 chip 优雅降级）", status: "backlog", ts: now - 3e6, updated_at: now - 3e6 },
  { id: "t-bl2", text: "进行中单：板卡生命周期接线（执行者 chip 可点跳）", status: "claimed", owner_session: "bl-w1", dispatch_id: "dbl1", ts: now - 4e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4e6 }] },
  { id: "t-bl3", text: "审查中单：worker 已交付（处理者 chip=审查中·PM）", status: "submitted", owner_session: "bl-w1", dispatch_id: "dbl2", review_required: true, ts: now - 5e6, updated_at: now - 8e5, transitions: [{ status: "claimed", ts: now - 5e6 }, { status: "submitted", ts: now - 8e5 }] },
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
await wait(700);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(500);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`);
await ev(`window.ccDeckTeam?.select?.("pg-bl")`);
await wait(700);
await ev(`[...document.querySelectorAll('#d-team [data-pane]')].find(b => /看板/.test(b.textContent))?.click() || [...document.querySelectorAll('#d-team button')].find(b => /看板/.test(b.textContent))?.click()`);
await wait(600);

// ---------- 断言：②执行者 chip ③处理者 chip ----------
const ownerJump = await ev(`document.querySelectorAll('#d-team .tchip.owner-jump').length`);
ok(ownerJump >= 2, "B1 执行者 chip 可点态在场（" + ownerJump + " 枚——claimed/submitted 有主卡）");
const jumpAttr = await ev(`document.querySelector('#d-team .tchip.owner-jump')?.dataset.teamMemberSession || ""`);
ok(!!jumpAttr, "B2 跳转属性挂 sid（" + jumpAttr.slice(0, 12) + "——同一委托链）");
const unass = await ev(`[...document.querySelectorAll('#d-team .tchip.owner')].some(el => el.textContent.includes("未指派") && !el.dataset.teamMemberSession)`);
ok(unass === true, "B3 未指派降级（无挂牌无跳转属性不炸）");
const reviewer = await ev(`[...document.querySelectorAll('#d-team .tchip.reviewer')].map(el => el.textContent.trim())`);
ok(reviewer.length >= 1 && reviewer[0].includes("审查中") && reviewer[0].includes("值班PM"), "B4 submitted 处理者 chip（" + JSON.stringify(reviewer) + "——PM 席位在岗显示昵称）");
const revAttr = await ev(`document.querySelector('#d-team .tchip.reviewer')?.dataset.teamMemberSession || ""`);
ok(!!revAttr, "B5 处理者 chip 可点跳 PM 会话（" + revAttr.slice(0, 12) + "）");
// 灰牌形态：剥离 PM 行重注入（无在岗 PM）
const snapNoPm = JSON.parse(JSON.stringify(snap));
snapNoPm.payload.projects[0].headcount = snapNoPm.payload.projects[0].headcount.filter((h) => h.role !== "pm");
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snapNoPm.payload)} })`);
await wait(600);
const greyBadge = await ev(`[...document.querySelectorAll('#d-team .tchip.reviewer-none')].map(el => el.textContent.trim())`);
ok(greyBadge.includes("待指派审查"), "B6 无 PM 灰牌（" + JSON.stringify(greyBadge) + "——数据缺席优雅降级）");
// 回注入完整版再截
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`);
await wait(600);
const bb = JSON.parse(await ev(`(function(){ const r = (document.querySelector('#d-team .board') || document.querySelector('#d-team .workspace-body') || document.body).getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height}); })()`) || "{}");
await shot("01-board-three-lanes", { x: bb.x, y: bb.y, width: bb.width, height: bb.height, scale: 1.6 });
const claimedCard = await ev(`(function(){ const el = [...document.querySelectorAll('#d-team .task-card')].find(c => c.textContent.includes('板卡生命周期接线')); if (!el) return '{}'; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height}); })()`);
const cb = JSON.parse(claimedCard || "{}");
if (cb.width) await shot("02-claimed-owner-chip", { x: cb.x - 6, y: cb.y - 6, width: cb.width + 12, height: cb.height + 12, scale: 2.4 });
const subCard = await ev(`(function(){ const el = [...document.querySelectorAll('#d-team .task-card')].find(c => c.textContent.includes('worker 已交付')); if (!el) return '{}'; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height}); })()`);
const sb = JSON.parse(subCard || "{}");
if (sb.width) await shot("03-submitted-reviewer-chip", { x: sb.x - 6, y: sb.y - 6, width: sb.width + 12, height: sb.height + 12, scale: 2.4 });
ok(consoleErrs.length === 0, "Z 零控制台报错（" + JSON.stringify(consoleErrs.slice(0, 3)) + "）");
globalThis.__p.kill();
console.log(`\n===== boardlife 探针：${pass} ok / ${fail} FAIL =====`);
process.exit(fail > 0 ? 1 : 0);
