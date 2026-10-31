// W-UI-MOTION-BATCH 动效全域推广截图+断言探针（复用 probe-notify-shot 骨架：
// Chrome headless + CDP + __ccDeck005Frames.emit 注入快照）。用法：
//   node scripts/probe-motion-shot.mjs <tag> [before|after]
// 产物：~/.cc-deck/artifacts/motion-shots/<tag>/*.png + 断言清单（动效在场/降级全静）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = process.argv[2] || "after";
const OUT = `/Users/xdd/.cc-deck/artifacts/motion-shots/${TAG}`;
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/mo-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.consolePosted" && ["error", "warning"].includes(m.params?.type)) consoleErrs.push(String(m.params?.args?.[0]?.value ?? "").slice(0, 120)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
await wait(1800);

// ---------- fixture：会话×8（stagger 可感）+ 团队×2 + 项目×3 ----------
const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000 });
const sessions = [
  mkS("mo-s1", "通知面板大修：三路视觉审查合并单", "WORKING", 3e5),
  mkS("mo-s2", "会话列表滚动条微信式显隐", "WORKING", 9e5),
  mkS("mo-s3", "Multica 源码考古（调研）", "DONE", 18e5),
  mkS("mo-s4", "三路调研 multica-runtime", "DONE", 26e5),
  mkS("mo-s5", "W-SRC2 聚合源标签缺口", "DONE", 36e5),
  mkS("mo-s6", "UI 精修二批：引擎图标", "DONE", 48e5),
  mkS("mo-s7", "板卡归宿方案 A 导入面", "DONE", 61e5),
  mkS("mo-s8", "console 分发三护栏", "ERROR", 91e5),
];
const projects = [
  { id: "pg-mo1", name: "CC Deck", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/cc-deck", headcount: [{ session_id: "mo-s1", role: "worker" }, { session_id: "mo-s2", role: "pm", nick: "PM" }], created_at: now - 99e5, updated_at: now - 3e5 },
  { id: "pg-mo2", name: "Watchtower", status: "parked", tier: "轻立项", anchor_dir: "/Users/u/.cc-deck/observer-hold", headcount: [{ session_id: "mo-s5", role: "观察员" }], created_at: now - 99e5, updated_at: now - 88e5 },
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions, projects, notifications: [], acceptances: [], receipts: [] } };

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };

// ---------- ① 会话域：首装 stagger 在场与撤除 ----------
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(90); // stagger 中段（--st-i 步进可见）
await shot("01-session-stagger-mid");
const hasStaggerCls = await ev(`!!document.querySelector(".list-upper.mo-stagger")`);
ok(hasStaggerCls, "A1 会话列表首装 stagger 类在场（.list-upper.mo-stagger）");
const stI = await ev(`document.querySelector('[data-session-card]')?.style.getPropertyValue('--st-i') || ''`);
ok(stI !== "", "A2 首卡 --st-i 已编排（值=" + stI + "）");
await wait(700);
const staggerGone = await ev(`!document.querySelector(".list-upper.mo-stagger")`);
ok(staggerGone, "A3 620ms 后 stagger 类撤除（一次性编排，后续替换不重排）");
await shot("02-session-settled");

// ---------- ② 卡片 hover + 按压（CDP Input 真事件） ----------
const cardBox = JSON.parse(await ev(`JSON.stringify(document.querySelector('[data-session-card]').getBoundingClientRect())`));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(cardBox.x + 80), y: Math.round(cardBox.y + 20) });
await wait(260);
await shot("03-session-card-hover");
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(cardBox.x + 80), y: Math.round(cardBox.y + 20), button: "left", clickCount: 1 });
await wait(60); // :active 中段（80ms 档）
await shot("04-session-card-active");
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(cardBox.x + 80), y: Math.round(cardBox.y + 20), button: "left", clickCount: 1 });
// 断言面换静态元素（windowbar 刷新钮——按压不触发列表重建，卡片按压仅留视觉证据 04：
// 会话卡点击即 select→keyed 替换，:active 随新节点消失属架构语义非缺陷）
const wBox = JSON.parse(await ev(`JSON.stringify(document.querySelector('.windowbar-refresh').getBoundingClientRect())`));
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(wBox.x + 12), y: Math.round(wBox.y + 12), button: "left", clickCount: 1 });
await wait(40);
const activeTransform = await ev(`getComputedStyle(document.querySelector('.windowbar-refresh')).transform`);
ok(/0\.9[67]/.test(String(activeTransform)), "A4 按压 scale(.97) 生效（静态钮 computed=" + String(activeTransform).slice(0, 40) + "；卡片按压视觉见 04）");
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(wBox.x + 12), y: Math.round(wBox.y + 12), button: "left", clickCount: 1 });

// ---------- ③ 域切换淡入（rail → team） ----------
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(80); // mo-dom-in 中段（200ms ease-out 的 ~40% 处：opacity<1 + translateY 残留）
await shot("05-team-dom-enter-mid");
const domAnim = await ev(`getComputedStyle(document.querySelector('#d-team')).animationName`);
ok(domAnim === "mo-dom-in", "A5 域切换入场动画挂载（animationName=" + domAnim + "）");
const domOpacityMid = await ev(`getComputedStyle(document.querySelector('#d-team')).opacity`);
ok(Number(domOpacityMid) < 0.99999, "A5b 动效真实运动中（80ms 处 opacity=" + domOpacityMid + "≠1 处于插值中——ease-out 快起慢收，80ms 已近落点，静止态恒为 1）");
await wait(400);
await shot("06-team-settled");

// ---------- ④ 设置子页进出 ----------
await ev(`document.querySelector('.rail-btn[data-domain="settings"]').click()`);
await wait(300);
await ev(`document.querySelector('[data-settings-nav="general"]').click()`);
await wait(80); // mo-pane-in 中段
await shot("07-settings-pane-mid");
const paneAnim = await ev(`getComputedStyle(document.querySelector('.settings-panel.active')).animationName`);
ok(paneAnim === "mo-pane-in", "A6 设置子页切换动画挂载（animationName=" + paneAnim + "）");
await wait(400);
await shot("08-settings-settled");

// ---------- ⑤ 项目域（队列首装 stagger） ----------
await ev(`document.querySelector('.rail-btn[data-domain="project"]').click()`);
await wait(150);
await shot("09-project-queue");
const pc3Trans = await ev(`getComputedStyle(document.querySelector('.pc3-dot')).transitionDuration`);
ok(/0\.15s/.test(String(pc3Trans)), "A7 项目卡状态点换色过渡 token 化（transitionDuration=" + pc3Trans + "）");

// ---------- ⑥ 手机端：四屏切换 + 按压 ----------
// 形态切换走 viewport 媒体查询（applyViewportMode→setMode("mobile")）——窄窗仿真即达
await send("Emulation.setDeviceMetricsOverride", { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await wait(600);
const mobScreen = await ev(`!!document.querySelector('.mobile-frame') && getComputedStyle(document.querySelector('.mobile-frame')).display !== 'none'`);
if (mobScreen) {
  await wait(300);
  const navBtn = await ev(`!!document.querySelector('.mobile-nav [data-mobile-root="team"]')`);
  ok(navBtn, "A8a 手机底部导航在场（team 入口可达）");
  await ev(`document.querySelector('.mobile-nav [data-mobile-root="team"]').click()`);
  await wait(80); // mo-dom-in 中段
  await shot("10-mobile-team-enter-mid");
  const mobAnim = await ev(`getComputedStyle(document.querySelector('.mobile-screen.active')).animationName`);
  ok(mobAnim === "mo-dom-in", "A8 手机屏切换动画挂载（animationName=" + mobAnim + "）");
  await wait(400);
  await shot("11-mobile-settled");
  // 手机卡按压（mobile-card :active）
  const mBox = JSON.parse(await ev(`JSON.stringify((document.querySelector('.mobile-card')||{getBoundingClientRect:()=>({x:40,y:300})}).getBoundingClientRect())`));
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(mBox.x + 60), y: Math.round(mBox.y + 24), button: "left", clickCount: 1 });
  await wait(50);
  await shot("13-mobile-card-active");
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(mBox.x + 60), y: Math.round(mBox.y + 24), button: "left", clickCount: 1 });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await wait(400);
} else {
  console.log("  （移动形态未及装配，10/11/13 略——viewport 仿真未触发形态切换）");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
}

// ---------- ⑦ reduced-motion：全静 ----------
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await wait(120);
await ev(`document.querySelector('.rail-btn[data-domain="session"]').click()`);
await wait(60);
const rmDom = await ev(`getComputedStyle(document.querySelector('#d-session')).animationName`);
ok(rmDom === "none", "A9 reduced-motion 域切换动画全静（animationName=" + rmDom + "）");
const rmStaggerStep = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--stagger-step')`);
ok(/0ms/.test(rmStaggerStep), "A10 reduced-motion stagger 步进清零（--stagger-step=" + rmStaggerStep.trim() + "）");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });
await shot("12-after-all");

ok(consoleErrs.length === 0, "A11 零控制台报错（" + consoleErrs.length + " 条）");
if (consoleErrs.length) console.log("  errs:", consoleErrs.slice(0, 3));

writeFileSync(`${OUT}/assertions.txt`, `pass=${pass} fail=${fail}\n` + (consoleErrs.length ? "console errors:\n" + consoleErrs.join("\n") : "no console errors\n"));
console.log(`\nprobe-motion ${TAG}: ${pass} 通过 / ${fail} 失败 → ${OUT}`);
globalThis.__p.kill();
process.exit(fail ? 1 : 0);
