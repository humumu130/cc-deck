// [W-AWAITUSER] 待拍板可见性三面截图探针（验收点 2 前后对照 + DOM 断言双证——
// 复用 probe-notify-shot 骨架：Chrome headless + CDP + __ccDeck005Frames.emit 注入）。
// 三面：①会话列表等拍板浮顶+chip（处理后恢复原位）②通知中心待拍板顶格 chip
// ③团队域检查器「等你拍板」入口。断言走 DOM（卡序/chip 在场/入口计数），截图供目验。
// 直跑：cd relay && node scripts/probe-awaituser-shot.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = "awaituser";
const OUT = `/tmp/awaituser-shot/${TAG}`;
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/awaituser-cdp-" + Date.now(), `--window-size=1440,940`, URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); require("node:fs").writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);

// ---------- fixture：①置顶 DONE 卡（验证等拍板压过 pin）②WAITING 四问卡（等拍板）
// ③WORKING 老卡（验证恢复位回落）；pending_user_actions 三源各一 ----------
const now = Date.now();
const mkS = (id, title, status, extra = {}) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - 3e5, started_at: now - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000, ...extra });
const sessions = [
  mkS("au-pin", "置顶的参考会话", "DONE", { pinned: true }),
  mkS("au-wait", "等拍板的会话（四问）", "WAITING", {
    waiting_request: { request_id: "rq-1", tool_name: "AskUserQuestion", input_summary: "选发布通道", suggestions: [], questions: [{ header: "通道", question: "test 还是 snap？", options: [{ label: "test" }, { label: "snap" }] }] },
    waiting_started_at: now - 8e5,
  }),
  mkS("au-work", "在跑的旧会话", "WORKING"),
];
const pending = [
  { key: "waiting:au-wait:rq-1", kind: "waiting", entity_id: "au-wait", title: "等你作答 · test 还是 snap？", created_at: now - 8e5, session_id: "au-wait" },
  { key: "org-confirm:cf1:1", kind: "org-confirm", entity_id: "cf1", title: "升档确认：轻立项→正式项目", created_at: now - 12e5 },
  { key: "acceptance:acc1", kind: "acceptance", entity_id: "acc1", title: "test.98 装机验收", created_at: now - 3e6 },
];
const n = (key, kind, group, severity, title, body, ago, extra = {}) => ({ key, kind, group, severity, title, body, sourceContext: { domain: "org", sessionId: "au-wait" }, actionable: group === "action", created_at: now - ago, ...extra });
const notifs = [
  n("r2", "org-confirm", "action", "waiting", "组织确认：升档确认（cf1）", "", 12e5),
  n("r3", "dispatch", "action", "waiting", "派单收割待办：W-XXX 交付回执已到", "", 26e4),
  n("y1", "dispatch", "attention", "info", "worker 连败 3 单升级：建议处置", "会话 8f3a21ab 连续失败 3 单。", 3e5),
  n("n1", "dispatch", "info", "info", "派单成功：review-duo → 会话 2f15…", "", 22e5),
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u",
  sessions, notifications: notifs, pending_user_actions: pending,
  org_confirms: [{ id: "cf1", kind: "tier-change", title: "升档确认：轻立项→正式项目", reason: "", status: "pending", created_at: Math.floor((now - 12e5) / 1000), payload: {} }],
  acceptances: [{ id: "acc1", title: "test.98 装机验收", created_at: Math.floor((now - 3e6) / 1000), total: 4, judged: 0, submitted: false, done: false }],
  projects: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(700);

// ---------- ① 会话列表：浮顶+chip（前） ----------
const listClip = await ev(`(() => { const r = document.querySelector('#d-session .queue').getBoundingClientRect(); return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, 460), height: Math.min(700, 940), scale: 1 }; })()`);
await shot("01-session-before", listClip);
const cardOrder = await ev(`[...document.querySelectorAll('#d-session [data-session-card]')].map(c => c.getAttribute('data-session-card')).join(",")`);
const chipOn = await ev(`!!document.querySelector('#d-session [data-session-card="au-wait"] .tag.awaitu-flag')`);
console.log(`  断言①卡序=[${cardOrder}]（au-wait 应首位，压过 au-pin）chip=${chipOn}`);
await ev(`window.__s1 = ${cardOrder.includes("au-wait,au-pin") ? "true" : "false"}`);

// ---------- ② 通知中心：顶格 chip ----------
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`);
await wait(900);
const panelRect = await ev(`(() => { const r = document.querySelector('[data-notify-panel]').getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: Math.min(r.height + 24, 900), scale: 1 }; })()`);
await shot("02-notify-top", panelRect);
const firstRow = await ev(`(() => { const rows = [...document.querySelectorAll('[data-notify-panel-body] .nrow')]; const r = rows[0]; return r ? (r.getAttribute('data-notify-key') + "|" + !!r.querySelector('.awaitu-chip')) : "none"; })()`);
const chipCount = await ev(`document.querySelectorAll('[data-notify-panel-body] .awaitu-chip').length`);
console.log(`  断言②面板首行=${firstRow}（r2 顶格带 chip）chip 总数=${chipCount}`);
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`);
await wait(400);

// ---------- ③ 团队域检查器：等你拍板入口 ----------
await ev(`window.ccDeckTeam?.onEvent({ relayName: "本机 relay" }, ${JSON.stringify(snap)})`);
await wait(300);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(700);
await shot("03-team-entry-fullpage"); // 整页（检查器折叠态下元素 rect 可能失真，整页为准）
const dbg = await ev(`JSON.stringify({ panes: document.querySelectorAll('#d-team .workspace-body > .workspace-pane').length, pua: (window.__ccDeck005B4?.pendingUserActions || []).length, puaNull: window.__ccDeck005B4?.pendingUserActions === null, teamState: document.getElementById('d-team')?.dataset.teamState || "none", stub: document.getElementById('d-team')?.hasAttribute('data-stub') })`);
console.log("  DEBUG " + dbg);
const entry = await ev(`(() => { const b = document.querySelector('[data-awaituser-block]'); if (!b || b.hidden) return "hidden"; const cnt = b.querySelector('[data-awaituser-count]')?.textContent; const rows = [...b.querySelectorAll('[data-awaitu-jump]')].map(r => r.dataset.awaituJump + (r.dataset.awaituAcc ? "(acc)" : "")); return cnt + "|" + rows.join(","); })()`);
console.log(`  断言③团队入口=${entry}（3 项三跳转行）`);

// ---------- ④ 处理完：帧驱动减项 + 恢复原位（后） ----------
await ev(`document.querySelector('.rail-btn[data-domain="session"]').click()`);
await wait(300);
// 模拟：四问会话翻回 WORKING（waiting_request 清） + confirm 决议 + 验收回填 → 聚合帧清空
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify({ type: "SESSION_UPDATED", session_id: "au-wait", ts: now, payload: { status: "WORKING", waiting_request: null, updated_at: now } })} })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify({ type: "PENDING_USER_ACTIONS_UPDATED", ts: now, payload: { items: [] } })} })`);
await ev(`window.ccDeckTeam?.onEvent({ relayName: "本机 relay" }, ${JSON.stringify({ type: "PENDING_USER_ACTIONS_UPDATED", payload: { items: [] } })})`); // 团队域喂口（生产=settings 地基 Team.onFrame 透传）
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify({ type: "ORG_CONFIRM_UPDATED", ts: now, payload: { pending: [] } })} })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify({ type: "ACCEPTANCES_UPDATED", ts: now, payload: { acceptances: [{ id: "acc1", title: "test.98 装机验收", created_at: Math.floor((now - 3e6) / 1000), total: 4, judged: 4, submitted: true, done: true }] } })} })`);
await wait(800);
await shot("04-session-after", listClip);
const orderAfter = await ev(`[...document.querySelectorAll('#d-session [data-session-card]')].map(c => c.getAttribute('data-session-card')).join(",")`);
const chipAfter = await ev(`document.querySelectorAll('#d-session .tag.awaitu-flag').length`);
console.log(`  断言④处理后卡序=[${orderAfter}]（au-wait 出首位移回自然位）chip=${chipAfter}（应 0）`);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(500);
const entryAfter = await ev(`(() => { const b = document.querySelector('[data-awaituser-block]'); return !b || b.hidden ? "hidden" : "visible"; })()`);
console.log(`  断言⑤处理后团队入口=${entryAfter}（应 hidden）`);
await shot("05-team-after-fullpage");

try { globalThis.__p.kill(); } catch {}
console.log("DONE " + OUT);
process.exit(0);
