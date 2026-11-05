// [W-SIDEBARBAR] 团队侧边栏（会话域团队抽屉）分段条完成剥离探针（probe-boardpolish 骨架复用）。
// 断言：条内无 done 段+✓ N 徽章独立+图例同步剥离+段 title 计数+aria-label 口径+min-width 2px。
// 产物：~/.cc-deck/artifacts/sidebarbar-shots/<tag>/*.png；用法 node scripts/probe-sidebarbar.mjs [after|before] [indexUrl]。
// before 对照：第二参指主仓未改副本（file:///Users/xdd/dev/cc-deck/web-console/index-005.html）。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "after";
const URL0 = process.argv[3] || "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
const OUT = `/Users/xdd/.cc-deck/artifacts/sidebarbar-shots/${TAG}`;
const PORT = 9741 + Math.floor(Math.random() * 400);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/sb-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
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

// mock 板：实产碾压形态复刻（boardpolish 同口径）——done 120 张 vs 活跃 9 张
const now = Date.now(), DAY = 86400000;
const mkDone = (i) => ({ id: "t-d" + i, text: "已收割任务 #" + i, status: "done", owner_session: "sb-w2", dispatch_id: "dd" + i, ts: now - 2 * DAY - i * 6e5, updated_at: now - 6e5 - i * 6e5, transitions: [{ status: "done", ts: now - 6e5 - i * 6e5 }] });
const entries = [
  { id: "t-pl1", text: "规划中：缓做想法", status: "planned", ts: now - 9e6, updated_at: now - 9e6 },
  { id: "t-bl1", text: "待认领单甲", status: "backlog", ts: now - 3e6, updated_at: now - 3e6 },
  { id: "t-bl2", text: "待认领单乙", status: "backlog", ts: now - 3.1e6, updated_at: now - 3e6 },
  { id: "t-c1", text: "进行中单一", status: "claimed", owner_session: "sb-w1", dispatch_id: "dc1", ts: now - 4e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4e6 }] },
  { id: "t-c2", text: "进行中单二", status: "claimed", owner_session: "sb-w1", dispatch_id: "dc2", ts: now - 4.1e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4.1e6 }] },
  { id: "t-c3", text: "进行中单三", status: "claimed", owner_session: "sb-w1", dispatch_id: "dc3", ts: now - 4.2e6, updated_at: now - 3e6, transitions: [{ status: "claimed", ts: now - 4.2e6 }] },
  { id: "t-s1", text: "审查中单一", status: "submitted", owner_session: "sb-w1", dispatch_id: "ds1", review_required: true, ts: now - 5e6, updated_at: now - 8e5, transitions: [{ status: "submitted", ts: now - 8e5 }] },
  { id: "t-s2", text: "审查中单二", status: "submitted", owner_session: "sb-w1", dispatch_id: "ds2", review_required: true, ts: now - 5.1e6, updated_at: now - 8e5, transitions: [{ status: "submitted", ts: now - 8e5 }] },
  { id: "t-r1", text: "待收单单", status: "ready_to_install", owner_session: "sb-w1", dispatch_id: "dr1", ts: now - 6e6, updated_at: now - 7e5, transitions: [{ status: "ready_to_install", ts: now - 7e5 }] },
];
for (let i = 0; i < 120; i++) entries.push(mkDone(i));
const mkS = (id, name, st, act) => ({ id, name, status: st, engine: "claude", last_active_at: now - act, context: { used: 40000, limit: 200000 } });
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  mkS("sb-w1", "worker·阿禾", "WORKING", 3e5), mkS("sb-w2", "worker·小满", "DONE", 8e5), mkS("sb-pm", "PM", "WAITING", 2e5),
], projects: [
  { id: "pg-sb", name: "CC Deck SB", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount: [{ session_id: "sb-w1", role: "worker", nick: "阿禾" }, { session_id: "sb-w2", role: "worker", nick: "小满" }, { session_id: "sb-pm", role: "pm", nick: "值班PM" }], created_at: now - 30 * DAY, updated_at: now - 3e5 },
], boards: [{ gid: "pg-sb", entries }], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };

// 抽屉展开记忆先于 SNAPSHOT 初始化读（:819 localStorage cc-deck-005-slim-drawer）
await ev(`localStorage.setItem("cc-deck-005-slim-drawer", "pg-sb")`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(1200);

// 抽屉在不在
const drawerOpen = await ev(`!!document.querySelector("#d-session [data-slim-drawer].open")`);
ok(drawerOpen, `团队抽屉展开态（localStorage 记忆直入——mock 团队 pg-sb）`);
if (!drawerOpen) { console.error("抽屉未展开，后续断言跳过"); shot("drawer-miss"); process.exit(1); }

// ── 核心断言组 ──
ok(await ev(`!document.querySelector(".team-drawer .lane-bar i.done")`), "条内无 done 段（剥离——活跃态可辨）");
ok(await ev(`!!document.querySelector(".team-drawer .lane-bar-row .ov-done") && document.querySelector(".team-drawer .ov-done").textContent.replace(/\\s+/g," ").includes("✓ 120")`), "✓ 120 徽章独立承载（条尾 lane-bar-row 同行）");
ok(await ev(`(() => { const spans = [...document.querySelectorAll(".team-drawer .lane-legend span")]; return spans.length === 5 && !spans.some(s => (s.getAttribute("style") || "").includes("--p-done") || s.textContent.includes("完成")); })()`), `图例同步剥离 done 行（恰五活跃态——实 ${await ev(`[...document.querySelectorAll(".team-drawer .lane-legend span")].map(s => s.textContent.trim().replace(/\\s+/g, " ")).join("｜")`)}`);
ok(await ev(`[...document.querySelectorAll(".team-drawer .lane-bar i")].length === 5 && [...document.querySelectorAll(".team-drawer .lane-bar i")].every(i => /\\s\\d+$/.test(i.title || ""))`), "条内恰五活跃态段+每段 title 带计数（hover 可辨）");
ok(await ev(`(document.querySelector(".team-drawer .lane-bar").getAttribute("aria-label") || "").includes("完成已移出")`), "aria-label 口径更新（活跃任务分布·完成已移出）");
ok(await ev(`getComputedStyle(document.querySelector(".team-drawer .lane-bar i")).minWidth === "2px"`), "min-width 2px 底可见（段不消失）");
ok(await ev(`(document.querySelector(".team-drawer .ov-done").title || "").includes("120")`), "徽章 title 带全量口径");

await shot("team-drawer");
console.log(`\n== probe-sidebarbar[${TAG}]：${pass} ok / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
