// prchip（1104 用户问「pr 审查在泳道里有体现吗」）板卡 PR 徽章探针（probe-boardlife-shot
// 骨架复用：Chrome headless + CDP + 注入 SNAPSHOT.boards 携带 pr_url/pr_state）。
// 用法：node scripts/probe-prchip-shot.mjs
// 产物：~/.cc-deck/artifacts/prchip-shots/*.png + 断言清单（绿/红两态对照+旧卡零渲染+点击直达）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400);
const OUT = "/Users/xdd/.cc-deck/artifacts/prchip-shots";
mkdirSync(OUT, { recursive: true });
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/pc-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
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

// ---------- fixture：submitted 三卡（PR 绿/PR 红/无 PR 旧卡）+ PM 席位 ----------
const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 80000, context_limit: 200000 });
const board = { gid: "pg-pc", entries: [
  { id: "t-pc1", text: "半连接自愈批（CI 全绿——draft PR）", status: "submitted", owner_session: "pc-w1", dispatch_id: "dpc1", review_required: true, pr_url: "https://github.com/humumu130/cc-deck/pull/8", pr_state: "ci_green", ts: now - 5e6, updated_at: now - 8e5, transitions: [{ status: "claimed", ts: now - 5e6 }, { status: "submitted", ts: now - 8e5 }] },
  { id: "t-pc2", text: "prreview 互审链（CI 红——待修复重推）", status: "submitted", owner_session: "pc-w1", dispatch_id: "dpc2", review_required: true, pr_url: "https://github.com/humumu130/cc-deck/pull/9", pr_state: "ci_red", ts: now - 4.6e6, updated_at: now - 4e5, transitions: [{ status: "claimed", ts: now - 4.6e6 }, { status: "submitted", ts: now - 4e5 }] },
  { id: "t-pc3", text: "旧交付卡（prreview 链之前的存量——无 PR）", status: "submitted", owner_session: "pc-w1", dispatch_id: "dpc3", review_required: true, ts: now - 6e6, updated_at: now - 2e6, transitions: [{ status: "claimed", ts: now - 6e6 }, { status: "submitted", ts: now - 2e6 }] },
] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  mkS("pc-w1", "worker·阿禾（已交付）", "DONE", 4e5),
  mkS("pc-pm", "PM（值守）", "WAITING", 2e5),
], projects: [
  { id: "pg-pc", name: "CC Deck", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount: [{ session_id: "pc-w1", role: "worker", nick: "阿禾" }, { session_id: "pc-pm", role: "pm", nick: "值班PM" }], created_at: now - 30 * 86_400_000, updated_at: now - 3e5 },
], boards: [board], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };

await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(700);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(500);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`);
await ev(`window.ccDeckTeam?.select?.("pg-pc")`);
await wait(700);
await ev(`[...document.querySelectorAll('#d-team [data-pane]')].find(b => /看板/.test(b.textContent))?.click() || [...document.querySelectorAll('#d-team button')].find(b => /看板/.test(b.textContent))?.click()`);
await wait(600);

// ---------- 断言：三态渲染（绿/红/旧卡零渲染） ----------
const chipCount = await ev(`document.querySelectorAll('#d-team .pr-chip').length`);
ok(chipCount === 2, "① 带 pr_url 的 submitted 卡渲 chip（恰 2 枚——第三张旧卡无 PR）", "n=" + chipCount);
const greenDot = await ev(`document.querySelectorAll('#d-team .pr-chip .pr-dot.ok').length`);
const redDot = await ev(`document.querySelectorAll('#d-team .pr-chip .pr-dot.bad').length`);
ok(greenDot === 1 && redDot === 1, "② CI 红/绿两态角标对照（ok 绿=ci_green/bad 红=ci_red 各 1）", `g=${greenDot} r=${redDot}`);
const chipText = await ev(`[...document.querySelectorAll('#d-team .pr-chip')].map(el => el.textContent.trim()).join(" | ")`);
ok(/PR#8/.test(chipText) && /PR#9/.test(chipText), "③ chip 文本 PR#N（PR 号从 URL 提取）", chipText);
const dotColorGreen = await ev(`getComputedStyle(document.querySelector('#d-team .pr-chip .pr-dot.ok')).backgroundColor`);
const dotColorRed = await ev(`getComputedStyle(document.querySelector('#d-team .pr-chip .pr-dot.bad')).backgroundColor`);
ok(dotColorGreen !== dotColorRed, "④ 两态色值可区分（绿点 " + dotColorGreen + " ≠ 红点 " + dotColorRed + "）");
const oldCardChipless = await ev(`(() => { const card = [...document.querySelectorAll('#d-team .task-card')].find(c => c.textContent.includes("旧交付卡")); return card ? !card.querySelector(".pr-chip") : false; })()`);
ok(oldCardChipless, "⑤ 旧卡（无 pr_url）零 chip 渲染（降级零破坏）");
await shot("01-prchip-lanes");

// ---------- 点击直达（拦截统一开链） ----------
await ev(`window.__pcOpenLog = []; const orig = window.__ccDeck005OpenUrl; window.__ccDeck005OpenUrl = (u) => { window.__pcOpenLog.push(String(u)); return Promise.resolve(); }; window.__pcOpenOrig = orig;`);
await ev(`document.querySelector('#d-team .pr-chip').click()`);
await wait(150);
const opened = await ev(`JSON.stringify(window.__pcOpenLog)`);
ok(JSON.parse(opened)[0] === "https://github.com/humumu130/cc-deck/pull/8", "⑥ 点击 chip 走 __ccDeck005OpenUrl 统一开链（URL 原样直达 GitHub）", opened);

// ---------- BOARD_UPDATED 增量链（relay pr-report 后的实时上屏形态） ----------
const delta = { gid: "pg-pc", board: { gid: "pg-pc", entries: board.entries.map((e) => e.id === "t-pc3" ? { ...e, pr_url: "https://github.com/humumu130/cc-deck/pull/10", pr_state: "merged", updated_at: now - 1e5 } : e) }, entity_refs: ["t-pc3"], delta: { entries: { upserts: [{ id: "t-pc3", text: "旧交付卡（prreview 链之前的存量——无 PR）", status: "submitted", owner_session: "pc-w1", dispatch_id: "dpc3", review_required: true, pr_url: "https://github.com/humumu130/cc-deck/pull/10", pr_state: "merged", ts: now - 6e6, updated_at: now - 1e5, transitions: [{ status: "claimed", ts: now - 6e6 }, { status: "submitted", ts: now - 2e6 }] }], removes: [] }, lessons: { upserts: [], removes: [] }, meta: { frozen: false, updated_at: now - 1e5 } } };
// 注入走 ccDeckTeam.onEvent（Team 的 BOARD_UPDATED 消费口=onEvent 内分发 :1312——board
// 全量形态权威覆盖；总线帧只进 session-domain 面，Team 不挂总线订阅）
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "BOARD_UPDATED", payload: ${JSON.stringify(delta)} })`);
await wait(500);
const mergedChip = await ev(`[...document.querySelectorAll('#d-team .pr-chip')].some(el => el.textContent.includes("PR#10") && el.textContent.includes("✓"))`);
ok(mergedChip, "⑦ BOARD_UPDATED delta.upserts 携带 pr_url→chip 增量上屏（merged ✓ 态）");
const chipCount2 = await ev(`document.querySelectorAll('#d-team .pr-chip').length`);
ok(chipCount2 === 3, "⑧ 增量后 chip=3（旧卡补 PR 即显——数据驱动不限态）", "n=" + chipCount2);
await shot("02-prchip-merged");

console.log("");
console.log(fail === 0 ? `PASS ${pass}（prchip：三态渲染/红绿对照/旧卡零渲染/点击直达/增量上屏）` : `FAIL ${pass}`);
console.log("console errors: " + (consoleErrs.length ? JSON.stringify(consoleErrs.slice(0, 5)) : "无"));
try { globalThis.__p.kill(); } catch {}
process.exit(fail === 0 ? 0 : 1);
