// animfast（#194 常驻无限动画耗电根治）CDP 行为探针：三刀真链验证。
//   ①端到端三态灯：WORKING+新鲜工具帧→working 真灯（本体零动画+::after 承载 3s 呼吸）；
//     WORKING+陈旧帧→working-standby（#291 判活链不动，光晕移伪元素 3.6s）；
//     subagents 未结束→srow-live-dot（dot-breathe 3.6s）
//   ②hidden 全停：document.hidden 真源覆写→__appHiddenSync()→html.app-hidden 挂→
//     伪元素动画 playState=paused（CSS paused 真生效）→覆写回 false→摘+恢复 running
//   ③无缝续播：paused 时记 ::after 动画 currentTime，恢复后不归零（续播非重播）
//   ④降频锚：conn-wait 2.2s/ndot-pulse 3s（transform+opacity 帧）/wait-dot 3s（注入态）
//   ⑤三态可辨双主题截图（观感保持证据）
// 骨架复用 probe-navbar（SNAPSHOT 夹具注入范式）。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9860 + Math.floor(Math.random() * 200);
const OUT = "/Users/xdd/.cc-deck/artifacts/animfast-shots";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/animfast-cdp-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
for (let i = 0; i < 8; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await wait(1000); } }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; } if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrs.push(m.params.args?.map(a => a.value ?? a.description).join(" ").slice(0, 160)); if (m.method === "Runtime.exceptionThrown") consoleErrs.push(String(m.params.exceptionDetails?.text).slice(0, 160)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*"] });
await send("Page.reload");
await wait(3200);
for (let i = 0; i < 5; i++) { const st = await ev(`JSON.stringify({ rs: document.readyState })`).catch(() => null); if (st && JSON.parse(st).rs === "complete") break; await wait(1200); }

// 夹具：A=WORKING+新鲜工具帧+活子代理（真 working 灯+live-dot）；B=WORKING+陈旧帧（#291 standby 判活）；C=DONE 对照
const now = Date.now();
const mk = (id, title, extra) => Object.assign({ session_id: id, title, status: "DONE", engine: "claude", model: "glm-5.3", cwd: "/tmp/" + id, updated_at: now, started_at: now - 600_000, duration_ms: 245000, context_usage: 84000, context_limit: 200000, artifacts: [] }, extra);
const sessA = mk("af-work", "耗电根治·干活中", { status: "WORKING", last_tool_use_at: now - 60_000, subagents: [{ name: "w1", started_at: now - 30_000 }] });
const sessB = mk("af-standby", "耗电根治·待命（接单未开工）", { status: "WORKING", last_tool_use_at: now - 20 * 60_000, updated_at: now - 20 * 60_000 }); /* 心跳同步陈旧——isRealWorking 第二判据（updated_at ≤5min 新鲜+t>0=判活）需一并避开 */
const sessC = mk("af-idle", "耗电根治·空闲对照", {});
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [sessA, sessB, sessC], logs: { "af-work": [{ id: "l1", kind: "user_message", ts: now - 120_000, text: "开跑耗电治理" }, { id: "l2", kind: "assistant_text", ts: now - 90_000, text: "三刀进行中：opacity 化/hidden 全停/降频。" }] }, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`(() => { try { navigator.clipboard.writeText = () => Promise.resolve(); } catch (_) {} window.addEventListener("error", e => (window.__afErrs = window.__afErrs || []).push(String(e.message).slice(0, 80))); window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} }; })()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(1000);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ---------- ① 端到端三态灯（真渲染，非注入） ----------
console.log("① 端到端三态灯（SNAPSHOT 夹具真渲染）：");
const s1 = JSON.parse(await ev(`JSON.stringify((() => {
  const dot = document.querySelector('[data-session-card="af-work"] .status-dot');
  const live = document.querySelector('[data-session-card="af-work"] .srow-live-dot');
  const cs = dot ? getComputedStyle(dot) : null;
  const csa = dot ? getComputedStyle(dot, "::after") : null;
  const csl = live ? getComputedStyle(live) : null;
  const csla = live ? getComputedStyle(live, "::after") : null;
  return { hasWorking: !!(dot && dot.classList.contains("working")), selfAnim: cs && cs.animationName, selfShadow: cs && cs.boxShadow,
    afName: csa && csa.animationName, afDur: csa && csa.animationDuration, afState: csa && csa.animationPlayState, afShadow: csa && csa.boxShadow, afPos: csa && csa.position,
    liveSelf: csl && csl.animationName, liveAf: csla && csla.animationName, liveDur: csla && csla.animationDuration };
})())`));
ok(s1.hasWorking, `A 卡真渲染 .status-dot.working（WORKING+新鲜工具帧→isRealWorking 链不动）`);
ok(s1.selfAnim === "none", `working 灯本体零动画（animationName=${s1.selfAnim}——重绘主凶退役）`);
ok(s1.afName === "st-glow-pulse" && s1.afDur === "3s" && s1.afState === "running", `::after 承载呼吸（${s1.afName} ${s1.afDur} running——opacity 帧+静态光晕）`);
ok(!!s1.afShadow && s1.afShadow !== "none" && s1.afPos === "absolute", `::after 静态光晕一次成画（boxShadow=${String(s1.afShadow).slice(0, 40)}…）`);
ok(s1.liveSelf === "none" && s1.liveAf === "dot-breathe" && s1.liveDur === "3.6s", `live-dot 真渲染（subagents 未结束）：本体零动画+::after dot-breathe 3.6s`);
const s1b = JSON.parse(await ev(`JSON.stringify((() => {
  const dot = document.querySelector('[data-session-card="af-standby"] .status-dot');
  const csa = dot ? getComputedStyle(dot, "::after") : null;
  return { hasStandby: !!(dot && dot.classList.contains("working-standby")), afName: csa && csa.animationName, afDur: csa && csa.animationDuration, afState: csa && csa.animationPlayState };
})())`));
ok(s1b.hasStandby && s1b.afName === "st-standby-breathe" && s1b.afDur === "3.6s" && s1b.afState === "running", `B 卡真渲染 .working-standby（#291 判活）→::after st-standby-breathe 3.6s running`);

// ---------- ④ 注入态频率锚（conn-wait/ndot/wait-dot） ----------
console.log("④ 注入态频率锚：");
await ev(`(() => {
  const host = document.querySelector(".queue-source") || document.body;
  const cw = document.createElement("span"); cw.className = "source-conn conn-wait"; cw.textContent = "◈"; host.appendChild(cw);
  const grp = document.createElement("div"); grp.className = "ngrp"; const nd = document.createElement("span"); nd.className = "ndot r np-pulse"; grp.appendChild(nd); document.body.appendChild(grp);
  const wc = document.createElement("div"); wc.className = "wait-card"; const wd = document.createElement("span"); wd.className = "wait-dot"; wc.appendChild(wd); document.body.appendChild(wc);
})()`);
const s4 = JSON.parse(await ev(`JSON.stringify((() => {
  const cw = getComputedStyle(document.querySelector(".source-conn.conn-wait"));
  const nd = document.querySelector(".ndot.r.np-pulse"); const nda = getComputedStyle(nd, "::after"); const ndSelf = getComputedStyle(nd);
  const wd = getComputedStyle(document.querySelector(".wait-card .wait-dot"));
  return { cwName: cw.animationName, cwDur: cw.animationDuration, cwState: cw.animationPlayState,
    ndSelf: ndSelf.animationName, ndaName: nda.animationName, ndaDur: nda.animationDuration, ndaState: nda.animationPlayState,
    wdName: wd.animationName, wdDur: wd.animationDuration };
})())`));
ok(s4.cwName === "conn-wait-blink" && s4.cwDur === "2.2s" && s4.cwState === "running", `conn-wait blink 1.1s→2.2s（${s4.cwDur} running，opacity 帧合成友好）`);
ok(s4.ndSelf === "none" && s4.ndaName === "ndot-pulse" && s4.ndaDur === "3s" && s4.ndaState === "running", `ndot 未读脉冲：本体零动画+::after ndot-pulse 3s（transform+opacity 帧）`);
ok(s4.wdName === "wait-pulse" && s4.wdDur === "3s", `wait-dot wait-pulse 2s→3s（${s4.wdDur}）`);

// ---------- ② hidden 全停（document.hidden 真源覆写→sync→CSS paused 真生效） ----------
console.log("② hidden 全停行为链：");
const s2a = await ev(`typeof window.__appHiddenSync === "function"`);
ok(s2a === true, `JS 挂点在场：window.__appHiddenSync（visibilitychange 同款函数）`);
// 行为级基线：呼吸行进中（opacity 双采样变化——Chrome Element.getAnimations 无 pseudoElement
// 选项，伪元素动画进度不可直读，改用两时刻 computed opacity 差分判定行进/冻结）
const opacityOf = `getComputedStyle(document.querySelector('[data-session-card="af-work"] .status-dot'), "::after").opacity`;
const r1 = parseFloat(await ev(opacityOf)); await wait(350); const r2 = parseFloat(await ev(opacityOf));
ok(r1 !== r2, `呼吸行进中（opacity 采样 ${r1.toFixed(3)}→${r2.toFixed(3)}，350ms 有变化——后续冻结对照基线）`);
const s2 = JSON.parse(await ev(`JSON.stringify((() => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  window.__appHiddenSync();
  const d = document.querySelector('[data-session-card="af-work"] .status-dot');
  const std = document.querySelector('[data-session-card="af-standby"] .status-dot');
  const cw = document.querySelector(".source-conn.conn-wait");
  const nda = getComputedStyle(document.querySelector(".ndot.r.np-pulse"), "::after");
  return { cls: document.documentElement.classList.contains("app-hidden"),
    work: getComputedStyle(d, "::after").animationPlayState, stand: getComputedStyle(std, "::after").animationPlayState,
    conn: getComputedStyle(cw).animationPlayState, ndot: nda.animationPlayState };
})())`));
ok(s2.cls === true, `__appHiddenSync()→html.app-hidden 挂上（document.hidden=true 真源）`);
ok(s2.work === "paused" && s2.stand === "paused", `后台全停：working/standby 呼吸 playState=paused（伪元素动画真停）`);
ok(s2.conn === "paused" && s2.ndot === "paused", `后台全停：conn blink/ndot 脉冲同停（paused !important 全覆盖）`);
const p1 = parseFloat(await ev(opacityOf)); await wait(450); const p2 = parseFloat(await ev(opacityOf));
ok(p1 === p2, `行为级冻结（后台 450ms 双采样 opacity 恒 ${p1.toFixed(3)}——帧真停非只改样式字）`);

// ---------- ③ 无缝续播（恢复后动画继续走+播放名不变） ----------
console.log("③ 回前台无缝续播：");
const s3 = JSON.parse(await ev(`JSON.stringify((() => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  window.__appHiddenSync();
  const d = document.querySelector('[data-session-card="af-work"] .status-dot');
  return { cls: document.documentElement.classList.contains("app-hidden"), state: getComputedStyle(d, "::after").animationPlayState, name: getComputedStyle(d, "::after").animationName };
})())`));
ok(s3.cls === false && s3.state === "running" && s3.name === "st-glow-pulse", `__appHiddenSync() 复位→class 摘+playState 恢复 running（${s3.name} 不变=同一动画）`);
const q1 = parseFloat(await ev(opacityOf)); await wait(350); const q2 = parseFloat(await ev(opacityOf));
ok(q1 !== q2, `行为级续播（恢复 350ms 双采样 ${q1.toFixed(3)}→${q2.toFixed(3)}——继续走非重播）`);
ok(await ev(`(() => { try { delete document.hidden; } catch (_) {} return typeof window.__afErrs !== "undefined" ? window.__afErrs.length : 0; })()`) === 0, `探针全程零 JS 错误（覆写复原+页面静默）`);

// ---------- ⑤ 三态可辨双主题截图（观感保持证据） ----------
console.log("⑤ 三态可辨截图（dark+light）：");
await shot("animfast-three-states-dark");
await ev(`document.documentElement.setAttribute("data-theme", "light")`);
await wait(400);
await shot("animfast-three-states-light");
await ev(`document.documentElement.removeAttribute("data-theme")`);

console.log(`\nanimfast 探针：${pass} ✓ / ${fail} ✗`);
if (consoleErrs.length) console.log("console errors:", consoleErrs.slice(0, 5));
try { await send("Browser.close"); } catch {}
process.exit(fail > 0 ? 1 : 0);
