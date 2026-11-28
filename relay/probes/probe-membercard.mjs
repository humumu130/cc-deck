// #264 CDP 探针：成员卡两列等高+排序+头像（注入 SNAPSHOT→切团队域成员 tab→双主题截图）
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9335, OUT = "/tmp/w-membercard-probe";
const URL0 = "file:///private/tmp/cc-deck-w-membercard/web-console/index-005.html";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/mc-cdp", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2000);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page" && t.url.includes("index-005"));
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);
const now = Date.now();
const snap = { type: "SNAPSHOT", payload: { relay_name: "mc-probe", token_valid: true,
  sessions: [
    { session_id: "pm-01", title: "PM 主会话", status: "DONE", engine: "", model: "glm-5.3", updated_at: now - 1e5, started_at: now - 9e5, cwd: "/tmp/p" },
    { session_id: "w-working", title: "在跑 worker", status: "WORKING", engine: "claude", model: "", updated_at: now, started_at: now - 6e5, cwd: "/tmp/p" },
    { session_id: "w-waiting", title: "等待 worker", status: "WAITING", engine: "codex", model: "", updated_at: now - 2e5, started_at: now - 6e5, cwd: "/tmp/p" },
    { session_id: "w-queued", title: "排队 worker", status: "DONE", engine: "trae", model: "", updated_at: now - 3e5, started_at: now - 6e5, cwd: "/tmp/p" },
    { session_id: "w-idle1", title: "闲置甲", status: "DONE", engine: "claude", model: "", updated_at: now - 4e5, started_at: now - 6e5, cwd: "/tmp/p" },
    { session_id: "w-idle2", title: "闲置乙（长名字测试截断）", status: "DONE", engine: "claude", model: "", updated_at: now - 5e5, started_at: now - 6e5, cwd: "/tmp/p" },
  ],
  projects: [{ id: "g1", name: "探针团", status: "active", tier: "正经立项", anchor_dir: "/tmp/p", created_at: now - 864e5, acceptance_count: 0, headcount: [
    { session_id: "pm-01", role: "pm" }, { session_id: "w-working", role: "worker" }, { session_id: "w-waiting", role: "worker" },
    { session_id: "w-queued", role: "worker" }, { session_id: "w-idle1", role: "worker" }, { session_id: "w-idle2", role: "worker" },
  ] }],
  receipts: [{ id: "d1", ts: now, session_id: "w-queued", status: "dispatched", consumed: false }] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(600);
// team 域消费面=桥分发制（ccDeckTeam.snapshot 导出口），非帧总线——mount+snapshot 直调
await ev(`window.ccDeckTeam && (window.ccDeckTeam.mount(), window.ccDeckTeam.snapshot(${JSON.stringify(snap.payload)}, { relayName: "mc-probe" }))`);
await wait(1200);
// 切团队域 + 成员 tab
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(600);
await ev(`[...document.querySelectorAll('#d-team .segment-bar button')].find(b => b.textContent.includes("成员"))?.click()`);
await wait(900);
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? "  ok " : "  FAIL ") + n); };
const r = await ev(`(() => {
  const cards = [...document.querySelectorAll('#d-team .workspace-pane .member-list .member-card')];
  const grid = document.querySelector('#d-team .member-list');
  const gs = grid ? getComputedStyle(grid) : null;
  const rect = (el) => el.getBoundingClientRect();
  const rows = cards.map(c => rect(c));
  const byRow = {};
  rows.forEach((r, i) => { const k = Math.round(r.top); (byRow[k] = byRow[k] || []).push(Math.round(r.height)); });
  const rowEven = Object.values(byRow).every(hs => hs.every(h => Math.abs(h - hs[0]) <= 1)); // 同行等高（±1px 渲染容差）
  const heights = Object.entries(byRow).map(([top, hs]) => "y" + top + ":[" + hs + "]");
  const order = cards.map(c => c.querySelector(".member-role") ? c.querySelector("strong").textContent : "");
  const crabs = [...document.querySelectorAll('#d-team .workspace-pane .member-list .member-card .ava-crab')];
  const crowns = [...document.querySelectorAll('#d-team .workspace-pane .member-list .member-card .ava-crown')];
  return { rowEven, n: cards.length, cols: gs ? gs.gridTemplateColumns.split(" ").length : 0, heights, order, crabs: crabs.length, crowns: crowns.length,
           firstTitles: cards.slice(0, 4).map(c => c.querySelector("strong").textContent) };
})()`);
ok(r.n === 6, `成员卡 6 张在位（实测 ${r.n}）`);
ok(r.cols >= 2, `两列网格（轨道数 ${r.cols}）`);
ok(r.rowEven, `同行内等高（各行的卡高一致，±1px 容差；逐行实测 ${r.heights.join(" ")}）`);
ok(r.firstTitles[0] === "PM 主会话", `PM 恒首·不受活跃态影响（PM=闲置 DONE vs 次位=WORKING 在跑仍居首；实测首位 ${r.firstTitles[0]}）`);
ok(r.firstTitles[1] === "在跑 worker" && r.firstTitles[2] === "等待 worker" && r.firstTitles[3] === "排队 worker", `活跃置顶序 WORKING>WAITING>排队（实测 ${r.firstTitles.slice(1,4)}）`);
ok(r.crabs === 1 && r.crowns === 0, `PM(engine 空视同 claude)=角色蟹整头非金冠（蟹 ${r.crabs}/冠 ${r.crowns}）`);
ok(await (async () => { const r2 = await ev(`(() => { const avs = [...document.querySelectorAll('#d-team .workspace-pane .member-list .member-card .avatar.m-ava')]; const brand = avs.filter(a => (a.querySelector('svg') || a.querySelector('img:not(.ava-crab)')) && !a.querySelector('.ava-crab')).length; return { brand }; })()`); return r2.brand >= 2; })(), `非 claude 成员=本引擎品牌图标（svg/img 皆计，codex/trae ≥2 实证）`);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/dark.png`, Buffer.from(shot.result.data, "base64"));
await ev(`document.documentElement.setAttribute("data-theme", "light")`);
await wait(400);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/light.png`, Buffer.from(shot2.result.data, "base64"));
console.log(`\nMEMBERCARD probe: ${pass} passed, ${fail} failed`);
try { ws.close(); } catch {}
try { globalThis.__p.kill(); } catch {}
process.on("exit", () => { try { globalThis.__p.kill(); } catch {} });
process.exit(fail ? 1 : 0);
