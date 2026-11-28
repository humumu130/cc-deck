// [DEV-40·T4] 状态词汇表截图探针：六态卡面 + 检查器状态胶囊（l02 收敛对照）。
// 复用 probe-awaituser-shot 骨架：Chrome headless + CDP + __ccDeck005Frames.emit 注入。
// 断言走 computed style（dot 底色/胶囊类）——数字证据随截图落盘。
// 直跑：cd relay && node probes/probe-statusvocab-shot.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = "statusvocab";
const OUT = `/tmp/dev40-shots/${TAG}`;
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/dev40-cdp-" + Date.now(), `--window-size=1440,940`, "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// 端口就绪轮询（至多 ~15s）：夜间机群高载时 Chrome 开调试口可超固定 2.2s 窗
// （实勘 ECONNREFUSED 两连——改轮询后自愈），固定睡=竞态赌运
let list;
for (let i = 0; i < 30; i++) {
  await wait(500);
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; } catch { /* 端口未就绪，续轮 */ }
}
if (!list) { globalThis.__p.kill("SIGKILL"); console.error(`Chrome 调试口 ${PORT} 15s 未就绪`); process.exit(1); }
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

// ---------- fixture：六态各一卡（词表 §一）----------
const now = Date.now();
const mkS = (id, title, status, extra = {}) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - 3e5, started_at: now - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000, ...extra });
const sessions = [
  mkS("sv-work", "运行中（真活动）", "WORKING", { last_tool_use_at: now - 20e3 }),
  mkS("sv-standby", "待命（接单未开工）", "WORKING", { last_tool_use_at: now - 40 * 60e3 }),
  mkS("sv-wait", "等你拍板（四问）", "WAITING", {
    waiting_request: { request_id: "rq-1", tool_name: "AskUserQuestion", input_summary: "选发布通道", suggestions: [], questions: [{ header: "通道", question: "test 还是 snap？", options: [{ label: "test" }, { label: "snap" }] }] },
    waiting_started_at: now - 8e5,
  }),
  mkS("sv-done", "已完成（鲜亮期）", "DONE", { updated_at: now - 5 * 60e3 }),
  mkS("sv-error", "出错的会话", "ERROR", { last_error: "引擎退出码 1" }),
  mkS("sv-idle", "空闲超时（置灰）", "DONE", { updated_at: now - 3 * 3600e3 }),
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);

// ---------- ① 会话列表六态 ----------
const listClip = await ev(`(() => { const r = document.querySelector('#d-session .queue').getBoundingClientRect(); return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, 460), height: Math.min(700, 940), scale: 1 }; })()`);
await shot("01-list-six-states", listClip);
const dotInfo = await ev(`(() => {
  const out = {};
  for (const c of document.querySelectorAll('#d-session [data-session-card]')) {
    const id = c.getAttribute('data-session-card');
    const dot = c.querySelector('.srow-ava .status-dot');
    const cs = getComputedStyle(dot);
    out[id] = { cls: dot.className.replace('status-dot ', ''), bg: cs.backgroundColor, shadow: cs.boxShadow.slice(0, 60) };
  }
  return JSON.stringify(out);
})()`);
console.log("  断言①六卡灯 computed：");
for (const [id, v] of Object.entries(JSON.parse(dotInfo))) console.log(`    ${id}: cls=${v.cls} bg=${v.bg}${v.shadow && v.shadow !== "none" ? " ring=" + v.shadow : ""}`);
const awaituChip = await ev(`!!document.querySelector('#d-session [data-session-card="sv-wait"] .tag.awaitu-flag')`);
console.log(`  断言①b 等你拍板 chip 在场=${awaituChip}`);

// ---------- ② 检查器状态胶囊（l02：运行中=st-working 黄，非旧 done 绿） ----------
// 检查器 overlay 缺省 collapsed（translateX 隐于右缘）；开关钮随选中会话挂出——先选卡再开再截
await ev(`document.querySelector('[data-session-card="sv-work"]').click()`);
await wait(600);
await ev(`(() => { const b = document.querySelector('[data-inspector-toggle], .inspector-toggle'); if (b && document.querySelector('.inspector')?.classList.contains('collapsed')) b.click(); })()`);
await wait(900);
const inspClip = await ev(`(() => { const r = document.querySelector('.inspector-block').getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: Math.min(r.height + 24, 480), scale: 1 }; })()`);
await shot("02-inspector-working", inspClip);
const tagWork = await ev(`(() => { const t = document.querySelector('.inspector-block .tag'); const cs = getComputedStyle(t); return t.className + ' | text=' + cs.color + ' | bg=' + cs.backgroundColor; })()`);
console.log(`  断言② 运行中胶囊：${tagWork}`);

await ev(`document.querySelector('[data-session-card="sv-wait"]').click()`);
await wait(700);
await shot("03-inspector-waiting", inspClip);
const tagWait = await ev(`(() => { const t = document.querySelector('.inspector-block .tag'); const cs = getComputedStyle(t); return t.className + ' | text=' + cs.color + ' | bg=' + cs.backgroundColor; })()`);
console.log(`  断言③ 待处理胶囊：${tagWait}`);

await ev(`document.querySelector('[data-session-card="sv-error"]').click()`);
await wait(700);
await shot("04-inspector-error", inspClip);
const tagErr = await ev(`(() => { const t = document.querySelector('.inspector-block .tag'); return t.className; })()`);
console.log(`  断言④ 错误胶囊类：${tagErr}`);

globalThis.__p.kill("SIGKILL");
console.log(`\nDONE → ${OUT}`);
process.exit(0);
