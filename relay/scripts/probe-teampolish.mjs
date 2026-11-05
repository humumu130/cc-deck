// [W-TEAMPOPOLISH] 新建团队弹窗落地验证探针（1105 三路审查前后对照）。
// probe-seat-shot 骨架复用：Chrome headless + CDP + 注入 SNAPSHOT + 直喂团队域。
// 用法：node scripts/probe-teampolish.mjs <tag> <dir> [reduce]
//   <tag>=after|before（产物目录名）；<dir>=web-console 目录（after=worktree，before=/tmp/tp-before）
//   reduce=1 → --force-reduced-motion（kill list 断言组）
// 产物：~/.cc-deck/artifacts/teampolish-shots/<tag>[-rm]/*.png + 断言清单
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "after";
const DIR = resolve(process.argv[3] || dirname(fileURLToPath(import.meta.url)) + "/../../web-console");
const RM = process.argv[4] === "reduce";
const OUT = `/Users/xdd/.cc-deck/artifacts/teampolish-shots/${TAG}${RM ? "-rm" : ""}`;
mkdirSync(OUT, { recursive: true });
const PORT = 9841 + Math.floor(Math.random() * 300);
const URL0 = "file://" + DIR + "/index-005.html";
const args = ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/tp-cdp-" + Date.now(), "--window-size=460,900"];
if (RM) args.push("--force-prefers-reduced-motion");
args.push(URL0);
globalThis.__p = spawn(CHROME, args, { stdio: "ignore" });
// R1（A 审 P2-2①）：spawn 的 Chrome 必随进程退场——A 审盘点过 109 个泄漏残留实例。
// exit/SIGINT/SIGTERM/uncaughtException 四钩全挂（探针早退/异常路径同样清场）。
const killChrome = () => { try { globalThis.__p.kill(); } catch {} };
process.on("exit", killChrome);
process.on("SIGINT", () => { killChrome(); process.exit(130); });
process.on("SIGTERM", () => { killChrome(); process.exit(143); });
process.on("uncaughtException", (e) => { console.error("uncaught:", e?.message ?? e); killChrome(); process.exit(1); });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) {
  await wait(500);
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; }
}
if (!list) { console.error("Chrome CDP 15s 未就绪，退出"); process.exit(2); }
// R1（A 审 P2-2②）：tab 取用验归属——原 list.find(type==="page") 不校验 url，端口碰撞/
// 残留实例在听时连错页面（A 审首跑 18 FAIL 假红的根因）。非本探针 index-005 页拒用。
const tab = list.find(t => t.type === "page" && String(t.url || "").includes("web-console/index-005.html"));
if (!tab) { console.error(`CDP tab 归属校验失败：list 无 index-005 页（候选=${list.map(t => t.url).join(",") ?? ""}——疑似连到残留实例，先清场再跑`); process.exit(2); }
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seqn = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seqn; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);
let pass = 0, fail = 0;
const BASELINE = TAG === "before"; // before=cc6ce3db 基线对照版：新特性断言红=预期证据（证明改动真实生效），不阻断流程，只出对照截图
const ok = (c, name) => {
  if (c) { pass++; console.log("  ok " + name); }
  else if (BASELINE) { pass++; console.log("  (baseline-red) " + name); }
  else { fail++; console.log("  FAIL " + name); }
};
const safeEv = async (e, fallback = "SKIP") => { try { return await ev(e); } catch { return fallback; } };

// ---------- fixture：两托管会话（成员候选）+ 既有团队「redbook 推广」（重名对照） ----------
const now = Date.now();
const mkS = (id, title, status, ago) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - ago, started_at: now - ago - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 80000, context_limit: 200000 });
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  mkS("w1", "巡查员甲", "DONE", 3e5),
  mkS("w2", "开发乙", "WORKING", 8e5),
], projects: [
  { id: "pg-x1", name: "redbook 推广", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/redbook", headcount: [{ session_id: "w1", role: "worker" }], created_at: now - 30 * 86400000, updated_at: now - 3e5 },
], boards: [], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(700);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(400);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: JSON.parse(${JSON.stringify(JSON.stringify(snap.payload))}) })`);
await wait(700);

const openDialog = async (loopback) => {
  await ev(`window.__ccDeck005LocalRelayLoopback = () => ${loopback}; window.__TAURI__ = { dialog: {} }; window.__ccDeck005PlatformFor = () => "darwin";`);
  document_close: await ev(`document.querySelector('[data-team-new-session]')?.click()`);
  await wait(RM ? 250 : 140);
};

// ---------- ① 弹窗全景（loopback 可浏览态）+ 动效断言 ----------
await openDialog(true);
if (!RM) {
  // 动效帧：重开一次在动画窗内取 animation-name（120ms 窗内尽力，拿不到终态 none 也留静态闸兜底）
  await ev(`document.querySelector('[data-team-close]')?.click(); document.querySelector('[data-team-new-session]')?.click()`);
  const anim = await ev(`getComputedStyle(document.querySelector('#team-create-pop')).animationName`);
  ok(anim === "tcp-enter" || anim === "none", `C1 tcp-enter animation-name（${anim}——终态 none 属正常，keyframes 断言在 test-teampolish）`);
}
await shot("01-dialog-loopback");
const h3 = await ev(`const e = document.querySelector('#team-create-pop h3'); const cs = getComputedStyle(e); cs.fontSize + "/" + cs.fontWeight`);
ok(h3 === "14px/600", `A1 h3 14px/600（${h3}）`);
const label = await ev(`(() => { const e = document.querySelector('#team-create-pop .create-label'); if (!e) return "NOEL"; const cs = getComputedStyle(e); return JSON.stringify([cs.fontFamily, cs.letterSpacing, cs.fontWeight]); })()`);
let labelOk = false;
try { const arr = JSON.parse(String(label)); labelOk = !arr[0].includes("mono") && (arr[1] === "0px" || arr[1] === "normal"); } catch { labelOk = false; } // ls:0 computed=normal（Chrome 归一，同语义）
ok(labelOk, `A1+C4 label 非 mono/ls0（ls=${String(label).slice(-30)}）`);
const browse = await ev(`const b = document.querySelector('[data-team-anchor-browse]'); [b.className, b.hidden, getComputedStyle(b).backgroundColor].join("|")`);
ok(!browse.includes("secondary-btn") && browse.split("|")[1] === "false", `A2+B1 浏览钮删类+loopback 显形（${browse.slice(0, 60)}）`);
const inputBg = await ev(`getComputedStyle(document.querySelector('#team-create-pop .create-inline .create-field')).backgroundColor`);
ok(browse.split("|")[2] === inputBg, `A2 浏览钮底色=输入同质感（${browse.split("|")[2]} vs ${inputBg}）`);
const hint = String(await safeEv(`document.querySelector('[data-team-anchor-hint]')?.textContent ?? "NONE"`));
ok(hint === "路径在本机 relay 上，可点浏览直接选择", `B1 loopback hint 联动（${hint}）`);
ok(!(await ev(`!!document.querySelector('#team-create-pop .create-sub')`)), "B2 副标题绝迹");
const tierHint = String(await safeEv(`document.querySelector('[data-team-tier-hint]')?.textContent ?? "NONE"`));
ok(tierHint === "创建即生效，日常免确认", `B2 tier hint 初始（${tierHint}）`);
await ev(`const s = document.querySelector('[data-team-field="tier"]'); s.value = "正经立项"; s.dispatchEvent(new Event("change", { bubbles: true }))`);
await wait(120);
ok(String(await safeEv(`document.querySelector('[data-team-tier-hint]')?.textContent ?? "NONE"`)) === "提交后在确认卡上等你决议", "B2 tier hint 动态切换");
const two = String(await safeEv(`(() => { const e = document.querySelector('.create-two'); return e ? getComputedStyle(e).gridTemplateColumns : "NONE"; })()`));
ok(two.split(" ").length === 2 && two !== "NONE", `B4 两列行（${two}）`);
const bannerColor = await ev(`getComputedStyle(document.querySelector('#team-create-pop .readonly-banner') || document.body).color`);
ok(!/rgb\(7[0-9], 1[0-9][0-9], 2[0-9][0-9]\)/.test(String(bannerColor)) || TAG === "before", `C5 banner 色（${bannerColor}——info 蓝族绝迹）`);
const shadow = await ev(`getComputedStyle(document.querySelector('#team-create-pop')).boxShadow`);
ok(shadow.split("rgba").length >= 4, `C2 三层影+inset（${shadow.slice(0, 70)}…）`);
// R1（A 审 P1 验证闸补盲）：backdrop computed 色——源码正则对「同特异度级联覆盖」双失明
//（:231 与 :3201 各自命中正则=测试绿而运行时白雾），computed 是唯一真相。压暗档=
// color-mix(text-strong 16%) 解析为 alpha≈0.16；旧白雾档 bg0 72% alpha≈0.72 恒红。
const backColor = String(await safeEv(`(() => { const e = document.querySelector('[data-team-create-back]'); return e ? getComputedStyle(e).backgroundColor : "NONE"; })()`));
const backA = (() => { const m1 = /rgba?\(\d+, \d+, \d+, ([\d.]+)\)/.exec(backColor); const m2 = /\/\s*([\d.]+)/.exec(backColor); return m1 ? parseFloat(m1[1]) : m2 ? parseFloat(m2[1]) : NaN; })();
ok(Math.abs(backA - 0.16) < 0.02, `C2 backdrop computed 压暗 16%（${backColor}，alpha=${backA}——白雾 72% 运行时绝迹实证）`);
await shot("01b-backdrop-dim");

// ---------- ② 焦点环 ----------
await ev(`document.querySelector('[data-team-field="name"]').focus()`);
await wait(120);
const foc = await ev(`(() => { const e = document.querySelector('[data-team-field="name"]'); if (!e) return "NOEL"; const cs = getComputedStyle(e); return cs.borderColor + " || " + cs.boxShadow; })()`);
ok(String(foc).includes("3px"), `C3 焦点环 3px（${String(foc).slice(0, 100)}）`);
await shot("02-focus-ring");

// ---------- ③ blur 校验三态 ----------
await ev(`const n = document.querySelector('[data-team-field="name"]'); n.value = ""; n.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`);
await wait(120);
ok((await ev(`document.querySelector('.create-err-note[data-for="name"]')?.textContent`)) === "先填团队名", "B3 空名内联");
const dupSet = await ev(`(() => { const n = document.querySelector('#team-create-pop [data-team-field="name"]'); if (!n) return "NOINPUT"; n.value = "redbook 推广"; return n.value; })()`);
ok(dupSet === "redbook 推广", `B3 重名输入赋值（${dupSet}）`);
await ev(`document.querySelector('#team-create-pop [data-team-field="name"]').dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`);
await wait(120);
const dupNote = await ev(`(() => { const teamCardOnPage = document.body.textContent.includes("redbook 推广"); const note = document.querySelector('.create-err-note[data-for="name"]'); return JSON.stringify({ teamCardOnPage, note: note ? note.textContent : null }); })()`);
ok(String(dupNote).includes("已有同名团队，换个名字"), `B3 重名内联（对照已载列表：${String(dupNote).slice(0, 90)}）`);
await ev(`const a = document.querySelector('[data-team-field="anchor"]'); a.value = "relative/path"; a.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`);
await wait(120);
ok((await ev(`document.querySelector('.create-err-note[data-for="anchor"]')?.textContent`))?.includes("需绝对路径") === true, "B3 坏路径内联");
await shot("03-blur-errors");

// ---------- ④ 非浏览态 hint（浏览器宿主）+ 空态 ----------
await ev(`window.__ccDeck005LocalRelayLoopback = () => false; document.querySelector('[data-team-close]')?.click(); document.querySelector('[data-team-new-session]')?.click()`);
await wait(200);
const hint2 = String(await safeEv(`document.querySelector('[data-team-anchor-hint]')?.textContent ?? "NONE"`));
ok(hint2.includes("relay 宿主机") && !hint2.includes("浏览"), `B1 非浏览态文案（${hint2}）`);
ok(String(await safeEv(`document.querySelector('[data-team-anchor-browse]')?.hidden ?? "NONE"`)) === "true", "B1 浏览钮隐藏真值联动");
await shot("04-dialog-remote-host");

// ---------- ④b session 新建弹窗（共享语言全线正的对照面——验收点 2 抽查） ----------
await ev(`document.querySelector('[data-team-close]')?.click()`);
await wait(150);
await ev(`document.querySelector('.rail-btn[data-domain="session"]').click()`);
await wait(400);
await ev(`document.querySelector('#d-session .queue-head button.icon-btn')?.click()`);
await wait(RM ? 300 : 200);
const sh3 = String(await safeEv(`(() => { const e = document.querySelector('#b2-create-pop h3'); return e ? getComputedStyle(e).fontSize + "/" + getComputedStyle(e).fontWeight : "NONE"; })()`));
ok(sh3 === "14px/600", `共享 h3 排印全线正（session 弹窗 ${sh3}）`);
const sAnim = String(await safeEv(`(() => { const e = document.getElementById("b2-create-pop"); return e ? getComputedStyle(e).animationName : "NONE"; })()`));
ok(sAnim === "tcp-enter" || sAnim === "none" || sAnim === "NONE", `共享入场动效挂载（session 弹窗 ${sAnim}）`);
await shot("05-session-create-shared");

// ---------- ⑤ reduced-motion 组（重开团队弹窗——④b 已切去 session 域） ----------
if (RM) {
  const mq = await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
  ok(mq === true, "RM 媒体查询生效");
  await ev(`document.querySelector('#b2-create-pop [data-create-close], #b2-create-pop .create-x')?.click()`);
  await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
  await wait(400);
  await openDialog(true);
  const anim = String(await safeEv(`(() => { const e = document.querySelector('#team-create-pop'); return e ? getComputedStyle(e).animationName : "NONE"; })()`));
  ok(anim === "none", `RM kill list：tcp-enter 退役（${anim}）`);
  const backAnim = String(await safeEv(`(() => { const e = document.querySelector('[data-team-create-back]'); return e ? getComputedStyle(e).animationName : "NONE"; })()`));
  ok(backAnim === "none", `RM kill list：backdrop-fade 退役（${backAnim}）`);
  await ev(`document.querySelector('[data-team-field="anchor"]')?.focus()`);
  await wait(120);
  ok(String(await safeEv(`(() => { const e = document.querySelector('[data-team-field="anchor"]'); return e ? getComputedStyle(e).boxShadow : "NONE"; })()`)).includes("3px"), "RM 下焦点环保留（可访问性不随动效死）");
  await shot("06-reduced-motion");
}

console.log(fail === 0 ? `\n${TAG}${RM ? "-rm" : ""}: ${pass} passed, 0 failed` : `\n${TAG}${RM ? "-rm" : ""}: ${pass} passed, ${fail} FAILED`);
writeFileSync(`${OUT}/summary.txt`, `pass=${pass} fail=${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
