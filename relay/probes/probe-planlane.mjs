// [W-PLANLANE] 规划中泳道 web E2E 探针（CDP 注入 fixture + 命令间谍 + 帧推送回渲）。
// 骨架基于 probe-boardlife-e2e.mjs（worker 探针先例），路径指向本 worktree（团队经验：
// 复用批次探针先查 HTML_PATH/require 指向，勿打他 worktree）。
// 断言面：P1 泳道渲染（规划中最前+计数）P2 planned 卡可见（灰系 stripe）P3 排产/废弃
// 钮只在 planned 卡 P4 排产点击→命令载荷 P5 废弃两步武装→载荷带 note P6 BOARD_UPDATED
// 帧推送→泳道即时迁移 P7 空态文案。产物 /tmp/w-planlane-probe/。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9901 + Math.floor(Math.random() * 300), TAG = process.argv[2] || "after";
const OUT = `/tmp/w-planlane-probe/${TAG}`;
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/planlane-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
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

// ---------- fixture：一组六卡（2 planned 含 [规划] 前缀真形态 + 四态对照）----------
const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 80000, context_limit: 200000 });
const DAY = 86_400_000;
const board = { gid: "pg-pl", entries: [
  { id: "t-plan1", text: "[规划]PM 轻量化：机械面外挂轻执行体，判断面保持强模型", status: "planned", ts: now - 6e6, updated_at: now - 6e6, transitions: [{ status: "planned", ts: now - 6e6 }] },
  { id: "t-plan2", text: "[规划]Router 攒批：量起来再做（高流量打法评估）", status: "planned", ts: now - 5e6, updated_at: now - 5e6, transitions: [{ status: "planned", ts: now - 5e6 }] },
  { id: "t-bl1", text: "待认领单（可派面对照）", status: "backlog", ts: now - 4e6, updated_at: now - 4e6 },
  { id: "t-cl1", text: "进行中单：泳道批实施", status: "claimed", owner_session: "pl-w1", dispatch_id: "dpl1", ts: now - 3e6, updated_at: now - 3e6 },
  { id: "t-dn1", text: "已收割单", status: "done", owner_session: "pl-w2", dispatch_id: "dpl2", ts: now - 2 * DAY, updated_at: now - 6e5 },
] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  mkS("pl-w1", "worker·阿禾（进行中）", "WORKING", 3e5),
  mkS("pl-w2", "worker·小满（已交付）", "DONE", 8e5),
], projects: [
  { id: "pg-pl", name: "CC Deck", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount: [{ session_id: "pl-w1", role: "worker", nick: "阿禾" }, { session_id: "pl-w2", role: "worker", nick: "小满" }], created_at: now - 30 * DAY, updated_at: now - 3e5 },
], boards: [board], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };

await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`);
await ev(`document.querySelector('.rail-btn[data-domain="team"]')?.click()`);
await ev(`window.ccDeckTeam?.select?.("pg-pl")`);
await waitFor(`!!document.querySelector('#d-team .board')`, 8000);
await ev(`[...document.querySelectorAll('#d-team button')].find(b => /看板/.test(b.textContent))?.click()`);
await waitFor(`document.querySelectorAll('#d-team .lane').length >= 6`, 8000);

// ---------- P1 泳道渲染 ----------
const laneHeads = await ev(`[...document.querySelectorAll('#d-team .lane-head > span:first-child')].map(el => el.textContent.trim())`);
ok(laneHeads[0] === "规划中" && laneHeads.join(",").includes("待认领"), `P1a 泳道序规划中最前（实 ${JSON.stringify(laneHeads)}）`);
const planCount = await ev(`(document.querySelector('#d-team .lane .lane-head')?.parentElement.querySelector('.lane-head > span:nth-child(2)')?.textContent) || ""`);
ok(planCount === "2", `P1b 规划中计数=2（实 ${planCount}）`);

// ---------- P2 planned 卡可见（灰系） ----------
const planCards = await ev(`[...document.querySelectorAll('#d-team .lane')].map(l => ({ head: l.querySelector('.lane-head span')?.textContent, cards: [...l.querySelectorAll('.task-card')].map(c => ({ stripe: c.dataset.stripe, text: c.querySelector('.task-title strong')?.textContent?.slice(0, 12) })) }))`);
const planLane = (typeof planCards === "object" ? planCards : []).find((l) => l && l.head === "规划中");
ok(!!planLane && planLane.cards.length === 2, `P2a planned 卡 2 张在规划泳道（实 ${JSON.stringify(planLane?.cards ?? [])}）`);
ok((planLane?.cards ?? []).every((c) => c.stripe === "idle"), `P2b planned 卡 stripe=灰系 idle（实 ${JSON.stringify((planLane?.cards ?? []).map((c) => c.stripe))}）`);
const planTexts = (planLane?.cards ?? []).map((c) => c.text).join("|");
ok(planTexts.includes("PM 轻量化") && planTexts.includes("Router"), `P2c 卡文本可见（${planTexts}）`);

// ---------- P3 操作钮只在 planned 卡 ----------
const schedN = await ev(`document.querySelectorAll('#d-team [data-board-schedule]').length`);
const scrapN = await ev(`document.querySelectorAll('#d-team [data-board-scrap]').length`);
ok(schedN === 2 && scrapN === 2, `P3 排产/废弃钮各 2（排产 ${schedN}/废弃 ${scrapN}——只落在 planned 卡）`);

// ---------- 命令间谍 + P4 排产点击载荷 ----------
await ev(`window.__planlaneSent = []; window.ccDeckTeam.bind({ online: true, command: (type, payload) => { window.__planlaneSent.push({ type, payload }); return Promise.resolve({ ok: true, data: {} }); } })`);
await wait(600); // bind 触发 requestDetail（占用 sent[0]=COMMAND_PROJECT_DETAIL——断言按类型过滤，不占位敏感）
await waitFor(`!!document.querySelector('#d-team [data-board-schedule]')`, 6000);
await ev(`[...document.querySelectorAll('#d-team [data-board-schedule]')].find(b => (b.getAttribute('data-board-schedule') === 't-plan1'))?.click()`);
await waitFor(`window.__planlaneSent.length >= 1`, 4000);
const sent1 = await ev(`JSON.stringify((window.__planlaneSent || []).filter(x => x.type === "COMMAND_ORG_ACTION")[0] || null)`);
const s1 = JSON.parse(sent1 || "null");
ok(s1?.type === "COMMAND_ORG_ACTION" && s1?.payload?.action === "board" && s1.payload.op === "move" && s1.payload.status === "backlog" && s1.payload.entry_id === "t-plan1" && s1.payload.gid === "pg-pl",
  `P4 排产载荷=board move →backlog（实 ${sent1}）`);

// ---------- P5 废弃两步武装+载荷带 note ----------
await ev(`document.querySelector('#d-team [data-board-scrap="t-plan2"]')?.click()`);
await wait(300);
const armedTxt = await ev(`document.querySelector('#d-team [data-board-scrap="t-plan2"]')?.textContent.trim() || ""`);
ok(armedTxt.includes("确认废弃"), `P5a 废弃首点武装（「${armedTxt}」——不裸发）`);
const sentAfterArm = await ev(`(window.__planlaneSent || []).filter(x => x.type === "COMMAND_ORG_ACTION").length`);
ok(sentAfterArm === 1, `P5b 武装态零发送（ORG_ACTION 计 ${sentAfterArm}）`);
await ev(`document.querySelector('#d-team [data-board-scrap="t-plan2"]')?.click()`);
await waitFor(`window.__planlaneSent.length >= 2`, 4000);
const sent2 = await ev(`JSON.stringify((window.__planlaneSent || []).filter(x => x.type === "COMMAND_ORG_ACTION")[1] || null)`);
const s2 = JSON.parse(sent2 || "null");
ok(s2?.payload?.op === "upsert" && s2.payload.status === "done" && (s2.payload.note || "").includes("规划终止") && s2.payload.entry_id === "t-plan2" && typeof s2.payload.text === "string",
  `P5c 废弃载荷=upsert →done 带 note（实 ${sent2}）`);
await shot("planlane-01-lane+buttons");

// ---------- P6 帧推送回渲（BOARD_UPDATED 模拟 relay 广播） ----------
const board2 = JSON.parse(JSON.stringify(board));
board2.entries.find((e) => e.id === "t-plan1").status = "backlog";
board2.entries.find((e) => e.id === "t-plan1").transitions.push({ status: "backlog", ts: Date.now() });
board2.entries.find((e) => e.id === "t-plan2").status = "done";
board2.entries.find((e) => e.id === "t-plan2").note = "[规划废弃] 规划终止（规划中泳道废弃钮）";
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "BOARD_UPDATED", payload: { gid: "pg-pl", board: ${JSON.stringify(board2)} } } })`);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "BOARD_UPDATED", payload: { gid: "pg-pl", board: ${JSON.stringify(board2)} } })`);
await waitFor(`(document.querySelector('#d-team .lane-empty')?.textContent || "").includes("暂无规划")`, 6000);
const emptyTxt = await ev(`[...document.querySelectorAll('#d-team .lane-empty')].map(e => e.textContent.trim()).join("|")`);
ok(emptyTxt.includes("暂无规划——缓做想法"), `P7 规划泳道空态指引（实 ${emptyTxt}）`);
const backLaneRaw = await ev(`(function(){ var out = []; document.querySelectorAll('#d-team .lane').forEach(function(l){ var head = (l.querySelector('.lane-head span') || {}).textContent || ""; var txts = []; l.querySelectorAll('.task-title strong').forEach(function(t){ txts.push((t.textContent || "").slice(0, 20)); }); out.push(head + ":" + txts.join("/")); }); return JSON.stringify(out); })()`);
const bl = JSON.parse(backLaneRaw || "[]");
ok(bl.some((x) => x.startsWith("待认领") && x.includes("轻量化")), `P6a 排产帧推送→待认领泳道即时见（实 ${JSON.stringify(bl)}）`);
ok(bl.some((x) => x.startsWith("完成") && x.includes("Router")), `P6b 废弃帧推送→完成泳道即时见（实 ${JSON.stringify(bl)}）`);
await shot("planlane-02-after-frames");

// ---------- 总览图例含规划中 ----------
const legendTxt = await ev(`(document.querySelector('#d-team .board-legend')?.textContent || "")`);
ok(legendTxt.includes("规划中"), `P8 总览图例含规划中（${legendTxt.slice(0, 80)}…）`);

console.log(`\nplanlane probe: ${pass}/${pass + fail} passed${consoleErrs.length ? `（console 告警 ${consoleErrs.length} 条）` : ""}`);
try { await send("Browser.close"); } catch {}
process.exit(fail > 0 ? 1 : 0);
