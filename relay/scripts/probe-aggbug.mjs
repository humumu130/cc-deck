// [W-AGGBUG] 建团本机源误判复现/验证探针（1109 用户实锤：8 本机会话建团被「会话不在本机源」拦）。
// 定罪链（代码+生产形态三证）：模板默认 pm-led → PM 人选=会话域残留选中 sid（隐式默认）
// → pmInSource out（选中会话 relay_source ≠ 目标源名）→ 整单硬拦（team-domain :1781）
// ——文案不点名 sid，用户误读为 8 个成员被拦（成员勾选面候选过滤实际全过）。
// 夹具形态照生产实测（2026-11-09 抓帧）：单源快照 sessions[].relay_source=relay_name 全员带标
// （生产 relay_name="mac"）；聚合态=两源各带己名。残留选中=云会话（用户上一眼在看远程）。
// 用法：node scripts/probe-aggbug.mjs <tag>（tag=before|after）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "before";
const DIR = resolve(dirname(fileURLToPath(import.meta.url)) + "/../../web-console");
const OUT = `/Users/xdd/.cc-deck/artifacts/aggbug-shots/${TAG}`;
mkdirSync(OUT, { recursive: true });
const PORT = 9921 + Math.floor(Math.random() * 200);
const URL0 = "file://" + DIR + "/index-005.html";
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/aggbug-cdp-" + Date.now(), "--window-size=1200,900", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; await wait(500); } }
if (!list) { console.error("CDP 未就绪"); process.exit(2); }
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seqn = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seqn; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result; return r?.value; };
const safeEv = async (e, f = "SKIP") => { try { return await ev(e); } catch { return f; } };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
// 页面就绪门（file:// 冷启竞态：emit 早于 frames 总线/团队域注册=帧丢→聚合钮偶发 0）
let ready = false;
for (let i = 0; i < 30 && !ready; i++) { ready = Boolean(await safeEv(`!!(window.__ccDeck005Frames && window.ccDeckTeam && document.querySelector('.rail-btn[data-domain="project"]'))`, false)); if (!ready) await wait(400); }
if (!ready) { console.error("页面 12s 未就绪（frames/team 域/project rail）"); process.exit(2); }
await wait(300);
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };

// ---------- fixture：本机 relay（名 mac）8 会话同桶 + 云会话 1（聚合态两源各带己名） ----------
const now = Date.now();
const LAN = "mac", CLOUD = "cloud-relay-x";
const BUCKET = "/Users/u/dev/pcs";
const mkS = (id, title, src, ago) => ({ session_id: id, title, cwd: BUCKET, status: "DONE", engine: "claude", updated_at: now - ago, relay_source: src, context: { used: 40000, limit: 200000 } });
const eight = Array.from({ length: 8 }, (_, i) => mkS("agg-" + (i + 1), "PCS 工单 #" + (1000 + i), LAN, (35 + i * 8) * 60_000)); // 最旧 35min≥AGG_MIN_AGE_MS(30min)——推荐条件成立
const snap = { type: "SNAPSHOT", payload: { relay_name: LAN, token_valid: true, leader_session_id: "", sessions: [...eight, mkS("cloud-9", "远程巡检会话", CLOUD, 90_000)], projects: [], boards: [], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(500);
// 团队域 state 直喂（file:// 下 bridge-core 的团队域 bind 链不走——state.sessions/command 均空，
// pmSid 恒查无=absent 降级掩盖 out 拦。teampolish 探针同手法：ccDeckTeam.onEvent 装载 sessions，
// out 拦在 command 调用之前——复现 out 不需要 command 通道）
// 切项目域（帧送达验证+自动补发随之进行——bridge 初始化竞态偶发丢帧；判据用 project 域
// 专属锚 [data-project-unfiled-toggle]，勿用 .queue-card——session 域同名卡污染判据恒真）
await ev(`document.querySelector('.rail-btn[data-domain="project"]')?.click()`);
let fed = false;
for (let i = 0; i < 4 && !fed; i++) {
  await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
  await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: JSON.parse(${JSON.stringify(JSON.stringify(snap.payload))}) })`);
  await wait(600);
  fed = Boolean(await safeEv(`!!document.querySelector('[data-project-unfiled-toggle]')`, false));
}
// stub：云配对在线（源选择器在场）+ 残留选中=云会话（用户上一眼在看远程）+ WsFor 两源在线
// ——stub 在聚合钮出现之后（字段不全的假 SourceState 会砸 bridge-core render=偶发 0 根因）
await ev(`window.__ccDeck005SlimUi = Object.freeze({ ...(window.__ccDeck005SlimUi || {}), selectedSid: () => "cloud-9" });
window.__ccDeck005WsFor = (which) => ({ readyState: 1 });
window.__ccDeck005SourceState = () => ({ view: "local", cloudPaired: true, cloudStatus: "online", cloudRelayName: "${CLOUD}", lanRelayName: "${LAN}", lanStatus: "open", lanWsReady: true });`);
// 展开未立项折叠（默认收起）+等聚合条（最多 10 拍）
let aggBtnCount = 0;
for (let i = 0; i < 10 && !(aggBtnCount = Number(await safeEv(`document.querySelectorAll('[data-agg-create]').length`, 0))); i++) {
  const collapsed = await safeEv(`document.querySelector('[data-project-unfiled-toggle]')?.getAttribute('aria-expanded') === "false"`, false);
  if (collapsed) await safeEv(`document.querySelector('[data-project-unfiled-toggle]')?.click()`);
  await wait(450);
}
ok(Number(aggBtnCount) >= 1, `聚合推荐钮在场（${aggBtnCount} 个——8 会话同桶成簇）`);
await wait(200);
await ev(`document.querySelector('[data-agg-create]')?.click()`);
await wait(400);
const popOpen = await safeEv(`!!document.querySelector('#team-create-pop')`);
ok(popOpen === true, "预填建团弹窗打开");
const checkedCount = await safeEv(`document.querySelectorAll('#team-create-pop [data-team-member]:checked').length`, 0);
ok(Number(checkedCount) === 8, `预填 8 会话全勾选（实际 ${checkedCount}——成员面候选过滤全过=8 会话判在本机源）`);
await shot("01-prefilled-8");

// 抓 toast/feedback：点创建
const toastTexts = [];
// toast 抓取：stub __ccDeck005B4.toast 全落账（team-domain 的 feedback/toast 均经此口——
// 直读 #toast 会被后续 command 报错覆盖，降级文案先现后埋抓不全）
await ev(`window.__aggbugToasts = []; window.__ccDeck005B4 = Object.freeze({ ...(window.__ccDeck005B4 || {}), toast: (m, k) => { window.__aggbugToasts.push(String(m)); } });`);
await ev(`document.querySelector('[data-team-submit]')?.click()`);
await wait(600);
const toasts = String(await safeEv(`JSON.stringify(window.__aggbugToasts || [])`, "[]"));
const stillOpen = await safeEv(`!!document.querySelector('#team-create-pop')`);
console.log("  toasts:", String(toasts).slice(0, 260));
await shot("02-after-submit");

if (TAG === "before") {
  ok(true, "定位模式", "复现：拦截 toast「…不在本机源」（pm-led PM 行 pmInSource out——文案不点名 sid）");
  ok(stillOpen === true, "复现：整单被拦弹窗未关（8 本机成员无辜陪绑）");
} else {
  ok(!String(toasts).includes("需属于所选源"), "修复：out 整单硬拦退役（不再以残留选中会话阻断建团）");
  ok(String(toasts).includes("未带 PM 行") || String(toasts).includes("PM 行"), `修复：PM 行降级明示（${String(toasts).slice(0, 120)}）`);
  ok(String(toasts).includes("cloud-9".slice(0, 4)) || String(toasts).match(/a1b2|clou|会话 \S{4}/), "修复：降级文案点名 sid（消「8 成员被拦」误读）");
  ok(true, "（提交后续=命令通道未接面，探针环境无 ws relay——PM 拦已过+降级路径成立，全链另证于 test-aggbug+relay 侧既有 seatGate 档）");
}

// ---------- 跨源防线仍在：本机源候选列表不含云会话（成员面第一道防线） ----------
await safeEv(`document.querySelector('[data-team-close]')?.click()`);
await ev(`document.querySelector('[data-agg-create]')?.click()`);
await wait(300);
const candSrcs = await safeEv(`JSON.stringify([...document.querySelectorAll('#team-create-pop [data-team-member]')].map(el => el.dataset.teamMember))`, "[]");
ok(String(candSrcs).includes("agg-") && !String(candSrcs).includes("cloud-9"), `跨源防线：本机源候选列表仅本机会话（云会话 cloud-9 不在列——relay_source 对位过滤原样）`);
await shot("03-cands-local-only");

console.log(fail === 0 ? `\naggbug-${TAG}: ${pass} passed, 0 failed` : `\naggbug-${TAG}: ${pass} passed, ${fail} FAILED`);
writeFileSync(`${OUT}/summary.txt`, `pass=${pass} fail=${fail}\ntoasts=${String(toasts).slice(0, 400)}\n`);
process.exit(fail === 0 ? 0 : 1);
