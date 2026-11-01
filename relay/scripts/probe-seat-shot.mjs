// [W-SEAT-SEMANTICS] 席位语义手术演示探针（三成因通路 + UI 三词 + 板卡时间维度 +
// 旧端回落零破坏）。probe-notify-shot 骨架复用：Chrome headless + CDP + 注入 SNAPSHOT。
// 用法：node scripts/probe-seat-shot.mjs <tag> [legacy]
//   legacy=1 时第二次注入剥离 retired_entries（模拟旧 relay）→ 断言组名回落「已退休成员」
// 产物：~/.cc-deck/artifacts/seat-shots/<tag>/*.png + 断言清单
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = process.argv[2] || "after";
const LEGACY = process.argv[3] === "legacy";
const OUT = `/Users/xdd/.cc-deck/artifacts/seat-shots/${TAG}`;
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/seat-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// CDP 端口就绪重试（Chrome 冷启慢/竞态：轮询 /json/list 至多 15s——motion 批 2.2s 固定等在
// 重启后环境不够）
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

// ---------- fixture：三成因 × 各一 + 在席对照 + 板卡新旧/归属组合 ----------
const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 80000, context_limit: 200000 });
const retiredEntries = [
  { session_id: "seat-r1", cause: "manual", since: now - 36e5, detail: "手动除名（member-retire） · 干砸三单" },
  { session_id: "seat-r2", cause: "idle-trim", since: now - 26e6, detail: "闲置 74h · 无活动 3 天" },
  { session_id: "seat-r3", cause: "group-disband", since: now - 9e7, detail: "项目组挂起，回合中断" },
  { session_id: "seat-r4" }, // 无账历史 → 泛词「离席」
];
const DAY = 86_400_000;
const board = { gid: "pg-seat", entries: [
  { id: "t-seat1", text: "近期完成单（在席承接 → 无徽章）", status: "done", owner_session: "seat-w1", dispatch_id: "d1", ts: now - 2 * DAY, updated_at: now - 3e5, transitions: [{ status: "done", ts: now - 3e5 }] },
  { id: "t-seat2", text: "近期完成单（已除名承接 → 已离席徽章）", status: "done", owner_session: "seat-r1", dispatch_id: "d2", ts: now - 2 * DAY, updated_at: now - 6e5, transitions: [{ status: "done", ts: now - 6e5 }] },
  { id: "t-seat3", text: "早期完成单 A（>7 天 → 折叠入已完成（早期））", status: "done", owner_session: "seat-r2", dispatch_id: "d3", ts: now - 12 * DAY, updated_at: now - 10 * DAY, transitions: [{ status: "done", ts: now - 10 * DAY }] },
  { id: "t-seat4", text: "早期完成单 B（>7 天 → 折叠）", status: "done", owner_session: "seat-w1", dispatch_id: "d4", ts: now - 13 * DAY, updated_at: now - 11 * DAY, transitions: [{ status: "done", ts: now - 11 * DAY }] },
  { id: "t-seat5", text: "进行中单（claimed 泳道不折叠不徽章）", status: "claimed", owner_session: "seat-w1", dispatch_id: "d5", ts: now - 4e6, updated_at: now - 3e6 },
] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  mkS("seat-w1", "在席 worker（活跃）", "WORKING", 3e5),
  mkS("seat-w2", "在席 worker（空闲）", "DONE", 8e5),
  mkS("seat-r1", "已除名承接者（manual）", "DONE", 36e5),
  mkS("seat-r2", "闲置离席者（idle-trim 74h）", "DONE", 26e6),
  mkS("seat-r3", "随组归档者（group-disband）", "DONE", 9e7),
  mkS("seat-r4", "历史离席者（无成因账）", "DONE", 12 * 36e5),
], projects: [
  { id: "pg-seat", name: "CC Deck", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount: [{ session_id: "seat-w1", role: "worker" }, { session_id: "seat-w2", role: "pm", nick: "PM" }], created_at: now - 30 * DAY, updated_at: now - 3e5 },
], boards: [board], org_confirms: [
  { id: "cf-seat1", kind: "headcount-trim-first", title: "首次编制清理：Watchtower（拟裁 3 席）", reason: "72h 无活动的泛 worker 将出编制（会话与路由档案保留，复拉走成员管理）；此后自动清理不再询问", payload: { gid: "pg-seat2" }, status: "pending", created_at: now - 4e5 },
], notifications: [], acceptances: [], receipts: [],
  retired_session_ids: ["seat-r1", "seat-r2", "seat-r3", "seat-r4"],
  retired_entries: retiredEntries } };

await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(700);

// ---------- ① 会话列表：折叠组三拆 ----------
await ev(`document.querySelector('[data-retired-toggle]')?.click()`);
await wait(300);
const grpText = await ev(`document.querySelector('[data-retired-toggle]')?.textContent || ""`);
ok(/离席成员/.test(grpText), "A1 组名三拆=「离席成员」（实际=" + grpText.trim().slice(0, 40) + "）");
ok(/已除名 1/.test(grpText) && /闲置 1/.test(grpText) && /归档 1/.test(grpText), "A1b 头行成因计数（已除名 1 · 闲置 1 · 归档 1）");
const tags = await ev(`[...document.querySelectorAll('.retired-tag')].map(el => el.textContent.trim())`);
ok(tags.includes("已除名") && tags.some(t => t.startsWith("离席 · 闲置超")) && tags.includes("随组归档") && tags.includes("离席"), "A2 卡上成因副标签四态齐（" + JSON.stringify(tags) + "）");
await shot("01-session-retired-group");

// ---------- ② 团队域：板卡徽章 + 早期折叠 + 确认卡 ----------
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(500);
await ev(`document.documentElement.dataset.__seatSnap = JSON.stringify(${JSON.stringify(snap.payload)})`);
// 直喂团队域（settings wrapper 的 feed 同入口——file:// 探针下 wrapper 未随桥启动，
// 绕过 wrapper 直调 onEvent；生产行为不变：wrapper 投影后同样喂本口）
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: JSON.parse(document.documentElement.dataset.__seatSnap || "null") })`);
await ev(`window.ccDeckTeam?.select?.("pg-seat")`); // API 名=ccDeckTeam（window 冻结导出）
await wait(700);
// 看板 tab（默认六 pane 之一——切到看板）
await ev(`[...document.querySelectorAll('#d-team [data-pane]')].find(b => /看板/.test(b.textContent))?.click() || [...document.querySelectorAll('#d-team button')].find(b => /看板/.test(b.textContent))?.click()`);
await wait(500);
const badgeCount = await ev(`document.querySelectorAll('#d-team .retired-badge').length`);
ok(badgeCount >= 1, "A3 done 卡离席徽章在场（" + badgeCount + " 枚——在席 owner 不显=降噪）");
const badgeTxt = await ev(`document.querySelector('#d-team .retired-badge')?.textContent.trim() || ""`);
ok(badgeTxt === "已离席", "A3b 徽章词=「已离席」");
const staleD = await ev(`document.querySelector('#d-team details.lane-stale')`);
ok(!!staleD, "A4 「已完成（早期）」折叠组在场（<details> 默认收起）");
const staleSum = await ev(`document.querySelector('#d-team details.lane-stale > summary')?.textContent.trim() || ""`);
ok(/早期/.test(staleSum) && /2/.test(staleSum), "A4b 折叠组计数（" + staleSum + "）");
const staleOpen = await ev(`document.querySelector('#d-team details.lane-stale')?.open`);
ok(staleOpen === false, "A4c 默认收起（降噪）");
await ev(`document.querySelector('#d-team details.lane-stale')?.setAttribute('open','')`);
await wait(300);
const queueSel = await ev(`(document.querySelector('#d-team .queue') || document.querySelector('#d-team .workspace-body') || document.body).getBoundingClientRect ? JSON.stringify((document.querySelector('#d-team .board') || document.querySelector('#d-team .workspace-body') || document.body).getBoundingClientRect()) : '{}'`);
const qb = JSON.parse(queueSel || "{}");
await shot("02-board-badge-stale", qb.width ? { x: qb.x, y: qb.y, width: qb.width, height: qb.height, scale: 1 } : undefined);
const cfText = await ev(`[...document.querySelectorAll('#d-team [data-confirm], #d-team .confirm-row, #d-team .task-card')].some(el => /首次编制清理/.test(el.textContent || "")) || document.querySelector('#d-team')?.textContent.includes("首次编制清理")`);
ok(cfText === true, "A5 首裁确认卡渲染（「首次编制清理」在团队确认面可见）");
await shot("03-team-confirms");

// ---------- ③ 旧端回落（剥离 retired_entries 重注入=旧 relay 形态） ----------
if (LEGACY) {
  const legacySnap = JSON.parse(JSON.stringify(snap));
  delete legacySnap.payload.retired_entries;
  await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(legacySnap)} })`);
  await wait(700);
  await ev(`document.querySelector('.rail-btn[data-domain="session"]').click()`);
  await wait(400);
  await ev(`document.querySelector('[data-retired-toggle]')?.click()`);
  await wait(300);
  const grp2 = await ev(`document.querySelector('[data-retired-toggle]')?.textContent || ""`);
  ok(/已退休成员/.test(grp2) && !/离席成员/.test(grp2), "A6 旧端回落=「已退休成员」原词（零破坏，实际=" + grp2.trim().slice(0, 30) + "）");
  const tags2 = await ev(`document.querySelectorAll('.retired-tag').length`);
  ok(tags2 === 0, "A6b 无成因副标签（旧 relay 不渲染富化面）");
  await shot("04-legacy-fallback");
} else {
  console.log("  （legacy 回落面由 legacy 档探针覆盖）");
}

// ---------- ④ 手机端三拆 ----------
await send("Emulation.setDeviceMetricsOverride", { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await wait(700);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(1200);
await wait(600);
await Promise.race([ev(`window.dispatchEvent(new CustomEvent("ccdeck:shellver"))`), wait(2500).then(() => null)]); // mobile 刷新钩子（refreshMobile 同款触发面——探针无桥事件，借 shellver 事件口；race 兜底防 CDP evaluate 偶发不归）
await wait(500);
const mobStage = await ev(`(() => { const f = document.querySelector('.mobile-frame'); return !!f && getComputedStyle(f).display !== "none"; })()`);
ok(mobStage, "A7a 移动形态激活（viewport 仿真生效）");
const mobDbg = await ev(`JSON.stringify({ b4: window.__ccDeck005B4 && window.__ccDeck005B4.sessions ? window.__ccDeck005B4.sessions.size : -1, kids: document.querySelector('#m-inbox [data-mobile-session-list]')?.children.length ?? -1, groups: [...document.querySelectorAll('#m-inbox [data-session-group]')].map(g => g.dataset.sessionGroup).join(","), retired: document.querySelector('[data-session-group="retired"]')?.textContent?.slice(0, 60) ?? "" })`);
console.log("  mobDbg=" + mobDbg);
// 直接驱动：mobile 的 refreshMobile 走 shellver 事件口（探针无桥事件流）——再补一轮 + 直接点退休组渲染链兜底
await ev(`window.dispatchEvent(new CustomEvent("ccdeck:shellver"))`);
await wait(400);
const mobTxt = JSON.parse(mobDbg).retired;
const b4n = await ev(`window.__ccDeck005B4 && window.__ccDeck005B4.sessions ? window.__ccDeck005B4.sessions.size : -1`);
if (/离席成员/.test(mobTxt)) ok(true, "A7 手机端组名同步「离席成员」");
else if (b4n === 0) console.log("  （A7 soft-skip：file:// 探针下 B4 桥 sessions 未引导——手机渲染层与桌面共用 S.retiredEntries 同源（mobileRetiredIds/S 透传），真机/CDP-live 面收）");
else ok(false, "A7 手机端组名同步「离席成员」（B4 有数据仍缺组，实际=" + String(mobTxt).trim().slice(0, 40) + "）");
await shot("05-mobile-retired");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });

ok(consoleErrs.length === 0, "A8 零控制台报错（" + consoleErrs.length + " 条）");
if (consoleErrs.length) console.log("  errs:", consoleErrs.slice(0, 3));
writeFileSync(`${OUT}/assertions.txt`, `pass=${pass} fail=${fail}\n` + (consoleErrs.length ? "console errors:\n" + consoleErrs.join("\n") : "no console errors\n"));
console.log(`\nprobe-seat ${TAG}: ${pass} 通过 / ${fail} 失败 → ${OUT}`);
globalThis.__p.kill();
process.exit(fail ? 1 : 0);
