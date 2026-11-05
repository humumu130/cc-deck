// [W-NOTIFYFIX] 通知死钮根修+验收单治理+间距收档探针（probe-notify-shot 骨架复用）。
// 断言组：
//   A 开链降级全可见：ccDeck reject→复制兜底 toast；clipboard reject→拦截 toast；无效协议→响亮 toast
//   B 开链健康不回归：ccDeck resolve→无 toast 静默成功
//   C 验收单治理：同 title 4 张异 id 只留最新（余 dup 过时）+旧版单 version 过时+当前版单现行
//     +7 天陈年通知 aged 过时+计数=未过时未处理（before/after 数字对照）
//   D 间距：queue-head margin-bottom 8px
// 产物：~/.cc-deck/artifacts/notifyfix-shots/<tag>/*.png
// 用法：node scripts/probe-notifyfix.mjs [after|before] [indexUrl]（before 指未改副本）
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "after";
const URL0 = process.argv[3] || "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
const OUT = `/Users/xdd/.cc-deck/artifacts/notifyfix-shots/${TAG}`;
const PORT = 9741 + Math.floor(Math.random() * 400);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/nf-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2400);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); require("node:fs").writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

// ---------- 通知 fixture：复刻用户实锤形态（陈年累计+同单重复+版本退役面） ----------
const now = Date.now(), DAY = 86400000;
const mkS = (id, title, status) => ({ session_id: id, title, status, engine: "claude", updated_at: now - 3e5, context: { used: 40000, limit: 200000 } });
const N = (key, kind, title, ago, actionable = true, extra = {}) => ({ key, kind, title, body: "", actionable, created_at: now - ago, done_at: undefined, sourceContext: { domain: "org", sessionId: "nf-w-1" }, ...extra });
const notifs = [
  N("a1", "dispatch", "今日派单：W-AAA 回执已到", 2 * 3600e3),
  N("a2", "system", "今日系统：relay 已恢复", 1 * 3600e3),
  N("old1", "system", "陈年系统通知（10-19 遗留）", 17 * DAY),
  N("old2", "waiting", "陈年问询（10-19 AskUser 遗留）", 17 * DAY),
  N("old3", "dispatch", "陈年派单（10 月遗留）", 9 * DAY),
];
const accepts = [
  { id: "nf-acc-97a", title: "test.97 装机验收单（v0.7.0-test.97-nova，2026-11-04）", created_at: Math.floor((now - 1 * DAY) / 1000), total: 17, judged: 0 },
  { id: "nf-acc-97b", title: "test.97 装机验收单（v0.7.0-test.97-nova，2026-11-04）", created_at: Math.floor((now - 1.2 * DAY) / 1000), total: 17, judged: 0 },
  { id: "nf-acc-97c", title: "test.97 装机验收单（v0.7.0-test.97-nova，2026-11-04）", created_at: Math.floor((now - 1.5 * DAY) / 1000), total: 17, judged: 0 },
  { id: "nf-acc-97d", title: "test.97 装机验收单（v0.7.0-test.97-nova，2026-11-04）", created_at: Math.floor((now - 2 * DAY) / 1000), total: 17, judged: 0 },
  { id: "nf-acc-96", title: "test.96 装机验收单（v0.7.0-test.96-nova，2026-11-03）", created_at: Math.floor((now - 3 * DAY) / 1000), total: 12, judged: 0 },
  { id: "nf-acc-cur", title: "0.7.1 装机验收单（v0.7.1-test.1-nova，2026-11-05）", created_at: Math.floor((now - 0.1 * DAY) / 1000), total: 6, judged: 0 },
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, leader_session_id: "", sessions: [mkS("nf-w-1", "worker·nf", "WORKING"), mkS("nf-pm", "PM", "WAITING")], projects: [], boards: [], org_confirms: [], notifications: notifs, acceptances: accepts, pending_user_actions: [], acceptances_supported: true } };

await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(1500);

// ---------- A/B 开链降级可见性（直接驱动 __ccDeck005OpenUrl + 捕 toast 文本） ----------
const toastText = async () => await ev(`(() => { const t = document.getElementById("toast"); return t && t.classList.contains("show") ? t.textContent : ""; })()`);
const clearToast = async () => await ev(`(() => { const t = document.getElementById("toast"); if (t) { t.classList.remove("show"); t.textContent = ""; } window.__sbClipOK = true; })()`);
await ev(`window.ccDeck = { openExternal: (u) => Promise.reject(new Error("blocked non-http(s) url: ftp://x")) }`); // mock 壳 Err 形态（本批 main.rs 改后）
await clearToast();
await ev(`window.__ccDeck005OpenUrl("http://127.0.0.1:8787/acceptance/nf-acc-97a")`);
await wait(400);
let t1 = await toastText();
ok(/系统浏览器打开失败|链接已复制|打开被拦截/.test(t1), `A1 ccDeck reject→降级链可见反馈（toast 单节点两级接力，实「${t1.slice(0, 40)}」）`);
await wait(600); // 复制 toast 接力
t1 = await toastText();
ok(t1.includes("链接已复制") || t1.includes("被拦截"), `A2 降级终点反馈在（复制成功或拦截明示，实「${t1.slice(0, 30)}」）`);
await clearToast();
await ev(`navigator.clipboard.writeText = () => Promise.reject(new Error("denied"))`);
await ev(`window.__ccDeck005OpenUrl("http://127.0.0.1:8787/acceptance/nf-acc-97a")`);
await wait(500);
t1 = await toastText();
ok(t1.includes("被拦截") || t1.includes("失败"), `A3 clipboard reject→拦截明示（不静默，实「${t1.slice(0, 40)}」）`);
await clearToast();
await ev(`window.__ccDeck005OpenUrl("ftp://evil.example/x")`);
await wait(300);
t1 = await toastText();
ok((t1.includes("无效链接") || t1 === "") === false || t1.includes("无效"), `A4 无效协议响亮拒绝（实「${t1.slice(0, 30)}」）`);
await clearToast();
// B 开链健康：resolve 形态零 toast
await clearToast();
await ev(`window.ccDeck = { openExternal: () => Promise.resolve(true) }`);
const rb = (await send("Runtime.evaluate", { expression: `window.__ccDeck005OpenUrl("http://127.0.0.1:8787/acceptance/nf-acc-cur")`, awaitPromise: true, returnByValue: true })).result.result.value;
await wait(300);
const tb1 = await toastText();
ok(rb === true, `B1a 开链健康 resolve=true（实 ${rb}）`);
ok(tb1 === "", `B1b resolve 静默成功零多余 toast（实「${tb1.slice(0, 30)}」）`);

// ---------- C 治理断言（开面板读 DOM） ----------
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`);
await wait(900);
// 展开历史动态组：stale 行落折叠组（observe3 健康态默认折叠）——组头空白区点击 toggle
await ev(`document.querySelector('.ngrp[data-notify-grp="n"]')?.click()`);
await wait(600);
// W-NOTIFYPOLISH-R1：展开全部聚合簇再计数（双保险——C2/C4/C6 按行计数语义恒真：
// P1-2 后 stale 行豁免聚合本就逐行在场，活跃同题簇若折叠会让按行 DOM 计数漏项；
// 先展开再计数，断言语义零改）
await ev(`[...document.querySelectorAll('[data-notify-agg-toggle]')].forEach(b => b.click())`);
await wait(600);
const badge = await ev(`document.querySelector('.rail-btn[data-domain="notify"] [data-notify-badge]')?.textContent || document.querySelector('[data-notify-badge]')?.textContent || "?"`);
const staleChips = await ev(`document.querySelectorAll('.nrow .stale-chip').length`);
const staleTitles = await ev(`[...document.querySelectorAll('.nrow')].filter(r => r.querySelector('.stale-chip')).map(r => (r.querySelector('b')||{}).textContent?.slice(0, 26) || '?').slice(0, 8).join('｜')`);
ok(Number(badge) <= 3, `C1 计数收敛=未处理未过时（badge=${badge}——今日 dispatch+system+现行验收单口径，843/全量累计不再）`);
ok(staleChips >= 6, `C2 过时行归档在册（stale 徽章 ${staleChips} 枚——重复/版本/陈年三因）`);
ok(staleTitles.includes("test.97") && staleTitles.includes("test.96"), `C3 旧版验收单 version 退役（实 ${staleTitles}）`);
const staleVerChips = await ev(`[...document.querySelectorAll('.nrow .stale-chip')].filter(c => (c.title||"").includes("版本")).length`);
const staleDupChips = await ev(`[...document.querySelectorAll('.nrow .stale-chip')].filter(c => (c.title||"").includes("重复")).length`);
const staleAgedChips = await ev(`[...document.querySelectorAll('.nrow .stale-chip')].filter(c => (c.title||"").includes("陈年")).length`);
ok(staleVerChips >= 1 && staleDupChips >= 3 && staleAgedChips >= 3, `C4 三因分立（version=${staleVerChips}/dup=${staleDupChips}/aged=${staleAgedChips}）`);
const curRow = await ev(`[...document.querySelectorAll('.nrow b')].some(b => (b.textContent||"").includes("0.7.1")) ? "yes" : "no"`);
const curStale = await ev(`[...document.querySelectorAll('.nrow')].filter(r => (r.querySelector('b')||{}).textContent?.includes("0.7.1")).every(r => !r.querySelector('.stale-chip'))`);
ok(curRow === "yes" && curStale, `C5 当前版验收单现行不过时（0.7.1-test.1 行在且无 stale 徽章）`);
const staleActionBtn = await ev(`[...document.querySelectorAll('.nrow')].filter(r => r.querySelector('.stale-chip')).filter(r => r.querySelector('[data-notify-open-acceptance]')).length`);
ok(staleActionBtn >= 5, `C6 过时验收单保留可查（stale 行打开按钮 ${staleActionBtn} 枚——jumpOf 旁路口兑现）`);
await shot("01-notify-panel");

// ---------- D 间距 ----------
const mb = await ev(`getComputedStyle(document.querySelector('#d-session .queue-head') || document.querySelector('.queue-head')).marginBottom`);
ok(mb === "8px", `D1 queue-head 间距 13→8px（实 ${mb}）`);
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`); // 关面板
await wait(400);
await shot("02-session-spacing");

console.log(`\n== probe-notifyfix[${TAG}]：${pass} ok / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
