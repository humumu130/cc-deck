// 通知面板视觉审查截图探针（用户 1101 令：通知面板丑+弹窗动画缺失）
// 复用 probe-uiv3 骨架：Chrome headless + CDP + __ccDeck005Frames.emit 注入快照
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = process.argv[2] || "v1";
const OUT = `/tmp/notify-shot/${TAG}`;
const URL0 = process.argv[3] || "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/notify-cdp-" + Date.now(), `--window-size=1440,940`, URL0], { stdio: "ignore" });
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

// ---------- 通知 fixture：三组全覆盖（r 需行动 / y 注意 / n 动态）× 五类 kind ----------
const now = Date.now();
const mkS = (id, title, status) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - 3e5, started_at: now - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000 });
const n = (key, kind, group, severity, title, body, ago, extra = {}) => ({ key, kind, group, severity, title, body, sourceContext: { domain: "org", sessionId: "a-w-1" }, actionable: group === "action", created_at: now - ago, ...extra });
const notifs = [
  // 需你行动（r 组）：五类 kind 各一 + 一条超长标题 + 一条无 body
  n("r1", "waiting", "action", "waiting", "会话等待你的确认（AskUser 问卷卡：发布通道选 test 还是 snap？多行文案超长截断测试「这是一条非常长的标题用来检验截断与省略号的形态」", "请在会话内选择后继续", 4e4),
  n("r2", "org-confirm", "action", "waiting", "组织确认：worker 成员入编审批（会话 3c74…申请加入 pg-7cb58ab4）", "", 12e4),
  n("r3", "dispatch", "action", "waiting", "派单收割待办：W-XXX 交付回执已到，等 Leader 核验", "", 26e4),
  n("r4", "acceptance", "action", "waiting", "验收单 b39a9193 第 ④ 项待装机回填（Windows NSIS 安装）", "", 61e4),
  n("r5", "system", "action", "waiting", "系统：relay 版本错配横幅触发（壳 v0.7.0-test.74 旧于界面）", "", 91e4),
  // 注意（y 组）：三条，含超长 body
  n("y1", "dispatch", "attention", "info", "worker 连败 3 单升级：建议处置", "会话 8f3a21ab 连续失败 3 单（成功 0），已不再自动派单。建议：查看该会话失败回执后 member-retire 除名或换人重派。", 3e5),
  n("y2", "system", "attention", "info", "聚合源连接恢复（云桥）", "", 8e5),
  n("y3", "waiting", "attention", "info", "会话标题生成中（子会话防收养护栏生效）", "", 17e5),
  // 动态（n 组）：六条（滚动形态）
  n("n1", "dispatch", "info", "info", "派单成功：review-duo → 会话 2f15…", "", 22e5),
  n("n2", "system", "info", "info", "relay 快照完成（18 会话/4 项目）", "", 25e5),
  n("n3", "acceptance", "info", "info", "验收单 a3d61105 全部通过", "", 3e6),
  n("n4", "dispatch", "info", "info", "收割完成：ui-v3-visual squash 入 dev", "", 36e5),
  n("n5", "system", "info", "info", "备份完成：remote-branches bundle 104M", "", 45e5),
  n("n6", "dispatch", "info", "info", "心跳正常（30 分钟无停帧）", "", 54e5),
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u",
  sessions: [mkS("a-w-1", "在跑审查批", "WORKING"), mkS("a-w-2", "等确认", "WAITING")],
  projects: [], notifications: notifs, acceptances: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(600);
// 开面板（rail 🔔）
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`);
await wait(900);
// 面板 rect 截图（含 mask 全页 + 面板特写 + 浅色）
await shot("01-notify-open-fullpage-dark");
const pRect = await ev(`(() => { const r = document.querySelector('[data-notify-panel]').getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: Math.min(r.height + 24, 900), scale: 1 }; })()`);
await shot("02-notify-panel-dark", pRect);
await ev(`document.documentElement.setAttribute('data-theme', 'light')`);
await wait(400);
await shot("03-notify-panel-light", pRect);
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
// 手机端通知屏
await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
await wait(400);
await ev(`document.getElementById('stage-desktop').classList.remove('active'); document.getElementById('stage-mobile').classList.add('active')`);
await ev(`document.querySelector('.mobile-nav [data-mobile-root="notify"]')?.click()`);
await wait(900);
await shot("04-mobile-notify", { x: 0, y: 0, width: 420, height: 900, scale: 1 });
// 桌面面板行数断言（供回执）
const rows = await ev(`document.querySelectorAll('[data-notify-panel-body] .nrow, [data-notify-panel-body] [data-notify-row]').length`);
console.log(`  面板行数=${rows}；badge=${await ev(`document.querySelector('[data-notify-badge]')?.textContent`)}`);
try { globalThis.__p.kill(); } catch {}
console.log("DONE " + OUT);
process.exit(0);
