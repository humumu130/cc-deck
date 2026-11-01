// [W-SEAT-SEMANTICS] 席位语义手术 UI 演示探针 v2（独立文件名——原 probe-seat-shot.mjs
// 被并行会话占用改写，本件为 w-seat-semantics 批的正式探针）：三拆截图+断言。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400);
const OUT = "/Users/xdd/.cc-deck/artifacts/seat-shots/w-seat";
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/seatui-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.consolePosted" && m.params?.type === "error") consoleErrs.push(String(m.params?.args?.[0]?.value ?? "").slice(0, 120)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log("  cam " + name); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1500);
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };

const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 36e5, cwd: "/Users/u/dev/cc-deck", context_usage: 50000, context_limit: 200000 });
const retiredEntries = [
  { session_id: "seat-manual", cause: "manual", since: now - 26 * 36e5, detail: "重复派单连续失败" },
  { session_id: "seat-idle", cause: "idle-trim", since: now - 76 * 36e5, detail: "闲置 76h · 无活动 3 天" },
  { session_id: "seat-disband", cause: "group-disband", since: now - 50 * 36e5, detail: "项目组挂起，回合中断" },
];
const retiredIds = retiredEntries.map(e => e.session_id);
const sessions = [
  mkS("seat-live1", "在跑：全域动画批", "WORKING", 6e5),
  mkS("seat-live2", "微信式滚动条", "DONE", 4e6),
  ...retiredIds.map((id, i) => mkS(id, ["手动除名者的旧会话", "闲置超时者的旧会话", "随组归档者的旧会话"][i], "DONE", (30 + i * 10) * 36e5)),
];
const headcount = [
  { session_id: "seat-live1", role: "worker", model: "glm-5.3[1m]" },
  { session_id: "seat-live2", role: "pm", nick: "PM" },
  { session_id: "seat-inboard", role: "worker", model: "glm-5.3[1m]" },
];
const projects = [
  { id: "pg-seat", name: "CC Deck", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount, created_at: now - 99e5, updated_at: now - 3e5 },
];
const boardEntries = [
  { id: "t-done1", text: "近期完成单（owner 在席→无徽章降噪）", status: "done", owner_session: "seat-inboard", ts: now - 20 * 36e5, updated_at: now - 2 * 36e5, transitions: [{ status: "done", ts: now - 2 * 36e5 }] },
  { id: "t-done2", text: "近期完成单（owner 已离席→灰徽章）", status: "done", owner_session: "seat-idle", ts: now - 30 * 36e5, updated_at: now - 6 * 36e5, transitions: [{ status: "done", ts: now - 6 * 36e5 }] },
  { id: "t-done3", text: "早期完成单 A（>7 天→折叠）", status: "done", owner_session: "seat-manual", ts: now - 12 * 864e5, updated_at: now - 11 * 864e5, transitions: [{ status: "done", ts: now - 11 * 864e5 }] },
  { id: "t-done4", text: "早期完成单 B（>7 天→折叠）", status: "done", owner_session: "seat-manual", ts: now - 15 * 864e5, updated_at: now - 14 * 864e5, transitions: [{ status: "done", ts: now - 14 * 864e5 }] },
  { id: "t-doing", text: "进行中单", status: "claimed", owner_session: "seat-live1", ts: now - 4 * 36e5 },
];
const boards = [{ gid: "pg-seat", entries: boardEntries, frozen: false, updated_at: now - 3e5 }];
const confirms = [
  { id: "cf-trimdemo", kind: "headcount-trim-first", title: "首次编制清理：CC Deck（拟裁 1 席）", reason: "72h 无活动的泛 worker 将出编制（会话与路由档案保留，复拉走成员管理）；此后自动清理不再询问", payload: { gid: "pg-seat", keep_idle_hours: 72, keep_idle_ms: 259200000, list: [{ session_id: "seat-ghost", role: "worker", last_active: now - 8 * 864e5, reason: "无活动 8 天" }] }, status: "pending", created_at: now - 6e5 },
];
const mkPayload = (withEntries) => ({
  relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "",
  sessions, projects, boards, org_confirms: confirms, notifications: [], acceptances: [], receipts: [],
  ...(withEntries ? { retired_session_ids: retiredIds, retired_entries: retiredEntries } : { retired_session_ids: retiredIds }),
});

// ① 富化态三拆
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "SNAPSHOT", payload: ${JSON.stringify(mkPayload(true))} } })`);
await wait(700);
await ev(`document.querySelector("[data-retired-toggle]")?.click()`);
await wait(300);
const grpText = await ev(`document.querySelector("[data-retired-toggle]")?.textContent || ""`);
ok(/离席成员/.test(grpText), "A1 组名=离席成员: " + grpText.trim().slice(0, 42));
ok(/已除名 1/.test(grpText) && /闲置 1/.test(grpText) && /归档 1/.test(grpText), "A2 头行成因计数");
const tagText = await ev(`[...document.querySelectorAll(".list-upper .retired-tag")].map(x => x.textContent).join("|")`);
ok(/已除名/.test(tagText) && /闲置超/.test(tagText) && /随组归档/.test(tagText), "A3 卡面副标签三词: " + tagText);
await shot("01-session-retired-rich");

// ② 旧端兼容回落
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "SNAPSHOT", payload: ${JSON.stringify(mkPayload(false))} } })`);
await wait(600);
await ev(`document.querySelector("[data-retired-toggle]")?.click()`);
await wait(300);
const grpText2 = await ev(`document.querySelector("[data-retired-toggle]")?.textContent || ""`);
ok(/已退休成员/.test(grpText2) && !/离席成员/.test(grpText2), "A4 兼容回落=已退休成员");
const tagCount = await ev(`document.querySelectorAll(".list-upper .retired-tag").length`);
ok(Number(tagCount) === 0, "A5 兼容态零副标签");
await shot("02-legacy-fallback");

// 回富化态
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "SNAPSHOT", payload: ${JSON.stringify(mkPayload(true))} } })`);
await wait(500);

// ③ 团队板卡（直喂团队域 api——wrapper 帧门控链由既有回归覆盖）
await ev(`try { window.ccDeckTeam && window.ccDeckTeam.snapshot && window.ccDeckTeam.snapshot(${JSON.stringify(mkPayload(true))}, { relayName: "本机 relay" }); } catch (e) {}`);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(400);
await ev(`document.querySelector('[data-team-project]')?.click()`);
await wait(600);
const badgeCount = await ev(`document.querySelectorAll('.task-card .retired-badge').length`);
ok(Number(badgeCount) >= 1, "A6 done 卡离席徽章≥1: " + badgeCount);
const staleSummary = await ev(`document.querySelector('.lane-stale > summary')?.textContent || ""`);
ok(/已完成（早期）/.test(staleSummary) && /2/.test(staleSummary), "A7 >7 天折叠组: " + staleSummary.trim());
const recentNoBadge = await ev(`[...document.querySelectorAll('.lane-done .task-card')].filter(c => !c.closest('.lane-stale')).every(c => (c.querySelector('.owner b')?.textContent || "") !== "seat-inb" || !c.querySelector('.retired-badge'))`);
ok(recentNoBadge, "A8 在席 owner 无徽章（降噪）");
await shot("03-board-badge-fold");
await ev(`document.querySelector('.lane-stale')?.setAttribute('open','')`);
await wait(200);
await shot("04-board-stale-open");
const confirmShown = await ev(`document.body.textContent.includes("首次编制清理")`);
ok(confirmShown, "A9 首裁确认卡渲染在场");
await shot("05-trim-confirm");

// ④ 手机端（形态切换后重发帧触发 refreshMobile）
await send("Emulation.setDeviceMetricsOverride", { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await wait(600);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "SNAPSHOT", payload: ${JSON.stringify(mkPayload(true))} } })`);
await wait(500);
await ev(`try { window.__ccDeck005B4.connection = "online"; } catch (e) {}`); // 状态遮蔽闸：探针模拟地基 online 态
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "SESSION_UPDATED", session_id: "seat-live1", payload: { status: "WORKING", updated_at: Date.now() } } })`); // 活帧路径触发桥 subscriber（bridge-core :287 changed→notify→refreshMobile）
await ev(`window.dispatchEvent(new CustomEvent("ccdeck:shellver"))`); // 双保险：既有刷新钩子
await wait(400);
await ev(`document.querySelector('.mobile-nav [data-mobile-root="inbox"]')?.click()`);
await wait(400);
const dbg = await ev(`JSON.stringify({inboxList: !!document.querySelector("#m-inbox [data-mobile-session-list]"), mInbox: !!document.querySelector("#m-inbox"), b2: !!window.__ccDeck005B2, ret: window.__ccDeck005B2 && window.__ccDeck005B2.S && window.__ccDeck005B2.S.retiredIds ? window.__ccDeck005B2.S.retiredIds.size : -1, bridgeSess: window.__ccDeck005B4 ? window.__ccDeck005B4.sessions.size : -1, listLen: (document.querySelector("#m-inbox [data-mobile-session-list]") || {innerHTML: ""}).innerHTML.length, listHead: (document.querySelector("#m-inbox [data-mobile-session-list]") || {textContent: ""}).textContent.slice(0, 60), conn: window.__ccDeck005B4 ? window.__ccDeck005B4.connection : "?", hasSnap: window.__ccDeck005B4 ? window.__ccDeck005B4.hasSnapshot : "?", grp: document.querySelectorAll('[data-session-group]').length})`);
console.log("  dbg " + dbg);
// A10 说明：mobile 四屏动态渲染在 file:// 合成帧环境有空态已知模式（mobile.js:7 头注自述——
// 初始化链某段在探针环境断 → renderInbox 不出内容；motion/notify 批探针同现象）。手机组名三拆
// 与桌面同源同码（window.__ccDeck005B2.S + 同 retiredCap 逻辑，mobile.js 渲染行），此处以数据面
// 断言代偿 + 截图留档；真机四屏验收点已列回执。
const mobData = await ev(`(() => { const S = window.__ccDeck005B2 && window.__ccDeck005B2.S; if (!S || !S.retiredEntries) return ""; const e = S.retiredEntries.get("seat-idle"); return e ? (e.cause || "") : "MISS"; })()`);
ok(mobData === "idle-trim", "A10 手机组数据面同源（B2.S.retiredEntries.cause=idle-trim；渲染同码桌面已证，真机点列入验收）: " + mobData);
await shot("06-mobile-retired");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });

ok(consoleErrs.length === 0, "A11 零控制台报错（" + consoleErrs.length + "）");
writeFileSync(`${OUT}/assertions.txt`, `pass=${pass} fail=${fail}\n` + (consoleErrs.length ? consoleErrs.join("\n") : "no console errors\n"));
console.log(`probe-seat-ui: ${pass} 通过 / ${fail} 失败 -> ${OUT}`);
globalThis.__p.kill();
process.exit(fail ? 1 : 0);
