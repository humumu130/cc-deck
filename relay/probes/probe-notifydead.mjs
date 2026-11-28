// [W-NOTIFYDEAD] 1127 用户实锤复现定罪探针（probe-notifyfix 骨架复用）：
// 通知面板「去团队确认」（org-confirm）与「打开验收单」（acceptance）两钮死钮二现。
// 双态：before=定罪（现状缺陷可见）/ after=修后对照（全程可见反馈兑现）。
//   H 健康形态：团队钮跳域+toast；验收钮活连接（mainWs 兜底）→openExternal 收 relay 真源 URL+成功 toast
//   D1 openExternal 悬挂（WebView2 IPC 不结算——#268 Canceled 前科族）：before=零反馈死钮 / after=6s 超时 toast+复制兜底
//   D2 #toast 节点缺席：before=bridge.toast 静默 / after=节点自挂回+toast 可见
//   D3 OpenUrl 未定义：同步 throw→catch→toast（既有 W-NOTIFYFIX 防线回归锚，双态同断言）
//   D4 focusSource 异常注入：before=handler 中断无 toast / after=跳转失败 toast+面板不收（可重试）
// 用法：node probes/probe-notifydead.mjs [before|after] [indexUrl]
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "before";
const AFTER = TAG === "after";
const URL0 = process.argv[3] || "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
const OUT = `/Users/xdd/.cc-deck/artifacts/notifydead-shots/${TAG}`;
const PORT = 9800 + Math.floor(Math.random() * 300);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/nd-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2400);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
const consoleLog = [];
ws.on("message", d => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") consoleLog.push(`[console.${m.params.type}] ` + (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 160));
  if (m.method === "Runtime.exceptionThrown") consoleLog.push("[exception] " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "?").slice(0, 200));
});
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); require("node:fs").writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

// ---------- fixture：复刻 1127 用户实锤（org-confirm 值守PM/入队 + test.34/28/27/26 验收卡） ----------
const now = Date.now(), DAY = 86400000;
const mkS = (id, title, status) => ({ session_id: id, title, status, engine: "claude", updated_at: now - 3e5, context: { used: 40000, limit: 200000 } });
const N = (key, kind, title, ago, actionable = true, extra = {}) => ({ key, kind, title, body: "", actionable, created_at: now - ago, done_at: undefined, sourceContext: { domain: "org", sessionId: "nd-w-1" }, ...extra });
const notifs = [
  N("oc1", "org-confirm", "值守 PM 任务卡 · 待确认", 2 * 3600e3),
  N("oc2", "org-confirm", "入队申请 · pg-7cb58ab4", 1.5 * 3600e3),
];
const accepts = [
  { id: "nd-acc-34", title: "test.34 装机验收单（v0.7.1-test.34，2026-11-24）", created_at: Math.floor((now - 0.2 * DAY) / 1000), total: 12, judged: 0 },
  { id: "nd-acc-28", title: "test.28 装机验收单（v0.7.1-test.28，2026-11-22）", created_at: Math.floor((now - 1.1 * DAY) / 1000), total: 5, judged: 0 },
  { id: "nd-acc-27", title: "test.27 装机验收单（v0.7.1-test.27，2026-11-21）", created_at: Math.floor((now - 2.2 * DAY) / 1000), total: 8, judged: 0 },
  { id: "nd-acc-26", title: "test.26 装机验收单（v0.7.1-test.26，2026-11-20）", created_at: Math.floor((now - 3.3 * DAY) / 1000), total: 6, judged: 0 },
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, leader_session_id: "", sessions: [mkS("nd-w-1", "worker·nd", "WORKING"), mkS("nd-pm", "PM", "WAITING")], projects: [], boards: [], org_confirms: [{ id: "cf-1", title: "值守 PM 任务卡 · 待确认", payload: { gid: "pg-x" } }], notifications: notifs, acceptances: accepts, pending_user_actions: [], acceptances_supported: true } };

await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(1500);
// 桌面活连接形态模拟：主 WS 实址在场（file:// 页 cfg.wsUrl 恒空——HttpOrigin 活连接兜底的靶面）
await ev(`window.__ccDeck005MainWs = { url: "ws://127.0.0.1:8787/ws?token=probe", readyState: 1 }`);

// ---------- 工具 ----------
const toastText = async () => await ev(`(() => { const t = document.getElementById("toast"); return t && t.classList.contains("show") ? t.textContent : ""; })()`);
const clearToast = async () => await ev(`(() => { const t = document.getElementById("toast"); if (t) { t.classList.remove("show"); t.textContent = ""; } })()`);
const panelOpen = async () => await ev(`document.getElementById("d-notify")?.classList.contains("on") ?? false`);
const openPanel = async () => { await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`); await wait(700); };
const activeDomain = async () => await ev(`document.querySelector('.rail-btn.active')?.dataset?.domain || ""`);

// ---------- H 健康基线 ----------
console.log("H 健康形态基线:");
await ev(`window.ccDeck = { openExternal: (u) => { window.__ndOpened = u; return Promise.resolve(true); } }`);
await openPanel();
ok(await ev(`!!document.querySelector('#d-notify [data-notify-jump][data-notify-domain="team"]')`), "H1 面板渲染出「去团队确认」钮（org-confirm 行）");
ok(await ev(`!!document.querySelector('#d-notify [data-notify-open-acceptance]')`), "H2 面板渲染出「打开验收单」钮（acceptance 行）");
await clearToast();
await ev(`document.querySelector('#d-notify [data-notify-jump][data-notify-domain="team"]').click()`);
await wait(600);
ok((await activeDomain()) === "team", `H3a 去团队确认→rail 跳 team 域`);
ok((await toastText()).includes("团队") || (await toastText()).length > 0, `H3b 团队钮 toast 在`);
await openPanel();
await clearToast();
await ev(`document.querySelector('#d-notify [data-notify-open-acceptance]').click()`);
await wait(700);
const h4url = await ev(`window.__ndOpened || ""`);
if (AFTER) {
  ok(/^http:\/\/127\.0\.0\.1:8787\/acceptance\/nd-acc-/.test(h4url), `H4a(after) 活连接兜底→openExternal 收 relay 真源 URL（实 ${h4url.slice(0, 60) || "无"}——before 形态为死源 file:/tauri.localhost）`);
  ok(/已打开验收单链接/.test(await toastText()), `H4b(after) 成功路径可见 toast（实「${(await toastText()).slice(0, 30)}」——before resolve 静默=死钮感）`);
} else {
  ok(!/^http:\/\/127\.0\.0\.1:8787\//.test(h4url), `H4a(before) 定罪：cfg 空窗形态 URL 走死源（实 ${h4url.slice(0, 50) || "file:/ 形态拒绝"}）——用户侧=浏览器不可达/协议拒`);
}

// ---------- D1 openExternal 悬挂 ----------
console.log("D1 openExternal 悬挂（IPC 永不结算）:");
await ev(`window.ccDeck = { openExternal: () => new Promise(() => {}) }`);
await openPanel();
await clearToast();
await ev(`document.querySelector('#d-notify [data-notify-open-acceptance]').click()`);
await wait(1200);
const d1early = await toastText();
await wait(5600); // 6s 竞速窗（after 形态）
const d1late = await toastText();
if (AFTER) ok(/打开超时|已复制|被拦截/.test(d1late), `D1a(after) 悬挂→6s 超时可见 toast+复制兜底（实「${d1late.slice(0, 40)}」）`);
else ok(d1early === "" && d1late === "", `D1a(before) 定罪：悬挂=永久零反馈死钮（1.2s/6.8s toast 均「${d1early || "无"}」「${d1late || "无"}」）`);
await shot("01-d1-hang");

// ---------- D2 #toast 缺席 ----------
console.log("D2 #toast 节点缺席:");
await ev(`window.ccDeck = { openExternal: (u) => Promise.reject(new Error("shell denied")) }`);
await ev(`document.getElementById("toast")?.remove()`);
await openPanel();
await clearToast();
await ev(`document.querySelector('#d-notify [data-notify-jump][data-notify-domain="team"]').click()`);
await wait(500);
const d2node = await ev(`!!document.getElementById("toast")`);
const d2txt = await toastText();
if (AFTER) ok(d2node && d2txt.length > 0, `D2a(after) #toast 缺席→桥面自挂回+toast 可见（实「${d2txt.slice(0, 30)}」）`);
else ok(!d2node, `D2a(before) 定罪：#toast 移除后 toast 全链静默（节点未自挂）`);

// ---------- D3 OpenUrl 未定义（既有防线回归锚） ----------
console.log("D3 __ccDeck005OpenUrl 未定义:");
await ev(`delete window.__ccDeck005OpenUrl; delete window.ccDeck; delete window.__ccDeck005MainWs`);
await openPanel();
await clearToast();
await ev(`document.querySelector('#d-notify [data-notify-open-acceptance]').click()`);
await wait(500);
ok((await toastText()).includes("失败"), `D3a OpenUrl 缺席→同步 throw 被 catch→toast（W-NOTIFYFIX 既有防线保持，实「${(await toastText()).slice(0, 40)}」）`);

// ---------- D4 focusSource 异常注入 ----------
console.log("D4 focusSource 异常注入（railJump 抛）:");
await ev(`window.__ccDeck005MainWs = { url: "ws://127.0.0.1:8787/ws?token=probe", readyState: 1 }`);
await openPanel();
await clearToast();
await ev(`(() => { const b = document.querySelector('.rail-btn[data-domain="team"]'); if (b) { const orig = b.click; b.click = () => { throw new Error("injected click failure"); }; window.__ndRestore = () => { b.click = orig; }; } })()`);
await ev(`document.querySelector('#d-notify [data-notify-jump][data-notify-domain="team"]').click()`);
await wait(500);
const d4toast = await toastText();
const d4panel = await panelOpen();
if (AFTER) ok(/跳转失败/.test(d4toast) && d4panel, `D4a(after) 注入异常→失败 toast+面板保持可重试（实「${d4toast.slice(0, 30)}」panel=${d4panel}）`);
else ok(d4toast === "", `D4a(before) 定罪：异常=handler 中断零 toast（实「${d4toast || "无"}」）——PM 线索③坐实`);
await ev(`window.__ndRestore && window.__ndRestore()`);

console.log(`\n== probe-notifydead[${TAG}]：${pass} ok / ${fail} FAIL ==`);
console.log(`== console 证据面（尾部 6 条） ==`);
for (const l of consoleLog.slice(-6)) console.log("  " + l);
process.exit(fail ? 1 : 0);
