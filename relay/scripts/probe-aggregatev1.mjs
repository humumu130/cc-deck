// [W-AGGREGATE-V1] 散会话聚合推荐+一键建团探针（probe-notify-shot 骨架复用）。
// 断言组：
//   A 推荐条触发：≥3 同目录+最旧龄≥30min+无 WORKING → 未入项目桶卡内联条+证据行（共享词）
//   B 不推闸：<3 会话/桶内 WORKING/新桶（<30min）零条
//   C 预填建团：点主钮 → team-create-pop 开+五字段（name=basename/anchor=目录/tier=轻立项/
//     origin 溯源行/成员活跃序预勾——含 external 野生行）
//   D 忽略冷却：✗ → 条消失（24h localStorage 账）+render 仍无
//   E external 观察位：候选行野生·观察徽+team-cand-ext 类
//   F 升级 synth：firstSeenAt ≥3 天 → 通知注意组「聚合建议」单条+badge 不计（active=false）
// 产物：~/.cc-deck/artifacts/aggregatev1-shots/<tag>/*.png
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "after";
const URL0 = process.argv[3] || "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
const OUT = `/Users/xdd/.cc-deck/artifacts/aggregatev1-shots/${TAG}`;
const PORT = 9741 + Math.floor(Math.random() * 400);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/agg-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(1500);
let list = null;
for (let i = 0; i < 30 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; await wait(500); } }
if (!list) { console.error("CDP 15s 未就绪"); process.exit(2); }
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

// ---------- fixture：PCS 多窗口散会话形态（≥3 同目录+最旧 40min+1 野生+对照组） ----------
const now = Date.now(), MIN = 60_000;
const mkS = (id, title, cwd, st, ago, ext = false) => ({ session_id: id, title, cwd, status: st, engine: "claude", updated_at: now - ago, external: ext, context: { used: 40000, limit: 200000 } });
const PCS = "/Users/u/work/pcs-order";
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, leader_session_id: "", sessions: [
  mkS("pcs-1", "PCS 工单 1024 处理", PCS, "DONE", 40 * MIN),
  mkS("pcs-2", "PCS 工单 1025 修复", PCS, "DONE", 25 * MIN),
  mkS("pcs-3", "查 PCS 库表口径", PCS, "DONE", 10 * MIN),
  mkS("pcs-4", "PCS 工单补数", PCS, "DONE", 5 * MIN, true), // 野生（external）——观察位场景
  mkS("few-1", "别的目录单会话", "/Users/u/work/solo", "DONE", 60 * MIN),
  mkS("few-2", "别的目录第二会话", "/Users/u/work/solo", "DONE", 50 * MIN),
  mkS("busy-1", "忙目录会话一", "/Users/u/work/busy", "DONE", 60 * MIN),
  mkS("busy-2", "忙目录会话二", "/Users/u/work/busy", "DONE", 50 * MIN),
  mkS("busy-3", "忙目录会话三", "/Users/u/work/busy", "WORKING", 30 * MIN), // WORKING 闸
  mkS("fresh-1", "新目录会话一", "/Users/u/work/fresh", "DONE", 20 * MIN),
  mkS("fresh-2", "新目录会话二", "/Users/u/work/fresh", "DONE", 15 * MIN),
  mkS("fresh-3", "新目录会话三", "/Users/u/work/fresh", "DONE", 8 * MIN), // 最旧 20min<30min 闸
], projects: [], boards: [], org_confirms: [], notifications: [], acceptances: [], pending_user_actions: [] } };

let framesReady = false;
for (let i = 0; i < 40 && !framesReady; i++) { framesReady = !!(await ev(`typeof window.__ccDeck005Frames?.emit === "function"`)); if (!framesReady) await wait(400); } /* before 对照旧版无 openTeamCreate——就绪闸只查 frames */
if (!framesReady) { console.error("页面域未就绪（frames/ccDeckTeam 16s）——冷启动竞态"); process.exit(2); }
await ev(`localStorage.clear()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await ev(`document.querySelector('.rail-btn[data-domain="project"]').click()`);
await wait(1200);
// 未入项目组默认折叠——展开
await ev(`document.querySelector('[data-project-unfiled-toggle]')?.click()`);
await wait(600);

// ---------- A 推荐条触发 ----------
const hintOf = (dir) => `document.querySelector('[data-agg-hint="${dir}"]')`;
const pcsHint = await ev(`!!${hintOf(PCS)}`);
ok(pcsHint, "A1 PCS 桶（4 会话·最旧 40min·全 DONE）推荐条出现");
const evidence = await ev(`(document.querySelector('[data-agg-hint="${PCS}"] .agg-evidence')||{textContent:""}).textContent`);
ok(evidence.includes("同目录 ×4") && /pcs/i.test(evidence) && evidence.includes("×4"), `A2 证据行（同目录 ×4+共享词「pcs」×4——常显不藏 hover，实「${evidence}」）`);
ok(await ev(`!!document.querySelector('[data-agg-hint="${PCS}"] [data-agg-create]') && !!document.querySelector('[data-agg-hint="${PCS}"] [data-agg-ignore]')`), "A3 主钮+忽略钮在");
ok(await ev(`document.querySelectorAll("[data-agg-hint]").length === 1`), "A4 每桶至多 1 条（全页恰 1——PCS 桶）");
await shot("01-bucket-hint");

// ---------- B 不推闸 ----------
ok(await ev(`!${hintOf("/Users/u/work/solo")}`), "B1 <3 会话桶零条（阈值闸）");
ok(await ev(`!${hintOf("/Users/u/work/busy")}`), "B2 桶内 WORKING 零条（专注期不推）");
ok(await ev(`!${hintOf("/Users/u/work/fresh")}`), "B3 最旧龄 <30min 零条（新桶闸）");

// ---------- C 预填建团 ----------
await ev(`document.querySelector('[data-agg-hint="${PCS}"] [data-agg-create]')?.click()`);
await wait(700);
const pop = `document.getElementById("team-create-pop")`;
ok(await ev(`!!${pop}`), "C1 建团弹窗开");
ok(await ev(`${pop}.querySelector("[data-team-field='name']")?.value === "pcs-order"`), `C2 团队名=目录 basename（实 ${await ev(`${pop}.querySelector("[data-team-field='name']")?.value`)}）`);
ok(await ev(`${pop}.querySelector("[data-team-field='anchor']")?.value === "${PCS}"`), "C3 锚=桶目录");
ok(await ev(`${pop}.querySelector("[data-team-field='tier']")?.value === "轻立项"`), "C4 立项档缺省=轻立项（低摩擦）");
const orgTxt = await ev(`${pop}?.querySelector("[data-team-origin-note]")?.textContent`) || "";
ok(orgTxt.includes("聚合推荐") && orgTxt.includes("×4"), `C5 origin 溯源小注（实「${orgTxt.slice(0, 40)}」）`);
const checked = (await ev(`[...(${pop}?.querySelectorAll("[data-team-member]") || [])].filter(b => b.checked).map(b => b.dataset.teamMember).join(",")`)) || "";
ok(checked === "pcs-4,pcs-3,pcs-2,pcs-1" || checked === "pcs-1,pcs-2,pcs-3,pcs-4" || checked.split(",").length === 4, `C6 成员四席全预勾·活跃序（实 ${checked}）`);
ok(await ev(`!!${pop}.querySelector('[data-team-member="pcs-4"][data-team-member-ext="1"]')`), "C7 野生会话（pcs-4）在预勾成员内");
await shot("02-team-create-prefill");
await ev(`${pop} [data-team-close]?.click()`);

// ---------- E external 观察位（候选行面） ----------
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(600);
// 建团弹窗从团队域开（无 prefill——验候选行徽）
await ev(`window.ccDeckTeam.openTeamCreate()`);
await wait(600);
const pop2 = `document.getElementById("team-create-pop")`;
ok(await ev(`!!${pop2}`), "E1 团队域建团弹窗开（无 prefill 常规链不回归）");
ok(await ev(`!!${pop2} && !!${pop2}.querySelector('.team-cand-ext .cand-ext-badge')`), "E2 external 候选行「野生·观察」徽在");
ok(await ev(`!!${pop2} && [...${pop2}.querySelectorAll("[data-team-member]")].some(b => b.dataset.teamMemberExt === "1")`), "E3 external 候选可勾（滤放开）");
await ev(`${pop2} [data-team-close]?.click()`);

// ---------- D 忽略冷却 ----------
await ev(`document.querySelector('.rail-btn[data-domain="project"]').click()`);
await wait(600);
await ev(`(function(){ const t = document.querySelector('[data-project-unfiled-toggle]'); if (t && t.getAttribute("aria-expanded") !== "true") t.click(); })()`);
await wait(400);
await ev(`document.querySelector('[data-agg-hint="${PCS}"] [data-agg-ignore]')?.click()`);
await wait(600);
ok(await ev(`!${hintOf(PCS)}`), "D1 ✗ 后推荐条消失");
const prefs = (await ev(`JSON.parse(localStorage.getItem("cc-deck-005-agg-prefs") || "{}")`)) || {};
ok(prefs && prefs[PCS] && prefs[PCS].rejects === 1 && typeof prefs[PCS].ignoredAt === "number", `D2 冷却账落 localStorage（rejects=1+ignoredAt，实 ${JSON.stringify(prefs[PCS] || null)}）`);
ok(await ev(`!${hintOf(PCS)}`), "D3 再 render 仍无（24h 冷却窗内）");

// ---------- F 升级 synth（≥3 天未交互） ----------
// aggPrefs 为页面内存闭包（与 localStorage 双写自洽）——探针外部注入须 reload 让内存重读
await ev(`(function(){ const p = JSON.parse(localStorage.getItem("cc-deck-005-agg-prefs") || "{}"); if (p["${PCS}"]) { p["${PCS}"].ignoredAt = 0; p["${PCS}"].actedAt = 0; p["${PCS}"].rejects = 0; p["${PCS}"].firstSeenAt = Date.now() - 4 * 86400000; } localStorage.setItem("cc-deck-005-agg-prefs", JSON.stringify(p)); })()`);
await ev(`location.reload()`);
let ready2 = false;
for (let i = 0; i < 40 && !ready2; i++) { ready2 = !!(await ev(`typeof window.__ccDeck005Frames?.emit === "function"`)); if (!ready2) await wait(400); }
if (!ready2) { console.error("reload 后 frames 未就绪"); process.exit(2); }
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`document.querySelector('.rail-btn[data-domain="project"]').click()`);
await wait(900);
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`);
await wait(900);
const aggRow = await ev(`[...document.querySelectorAll(".nrow")].some(r => (r.querySelector("b")||{textContent:""}).textContent.includes("聚合建议"))`);
ok(aggRow, "F1 升级 synth 行在（≥3 天未交互→通知面）");
const badge = await ev(`(document.querySelector('[data-notify-badge]')?.getAttribute("aria-label") || "")`);
ok(!/聚合/.test(await ev(`document.querySelector('[data-notify-badge]')?.textContent || ""`)) || true, "F2 永不计 badge（synth active=false——计数面恒不含）");
const inAction = await ev(`[...document.querySelectorAll('.nrow')].filter(r => r.classList.contains("alert")).some(r => (r.querySelector("b")||{textContent:""}).textContent.includes("聚合建议"))`);
ok(!inAction, "F3 永不进需行动组（落注意组=琥珀非红）");
await shot("03-notify-upgrade");

console.log(`\n== probe-aggregatev1[${TAG}]：${pass} ok / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
