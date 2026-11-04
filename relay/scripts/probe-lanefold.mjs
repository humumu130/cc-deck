// W-LANEFOLD 探针 v4（1104 用户令三修）：去横向滚动+标题贴边+低频泳道抽屉折叠。
// 本地 http server（file:// 禁 localStorage——记忆断言需可写）；点真组卡 [data-team-project]
// 并等板数据到位（badge 非 0，防空壳板时序假象——v1-v3 实锤）；断言 A-H+双主题截图。
// 用法：node probe-lanefold.mjs <after|before>（before 基线回退改动后跑，只截图）。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9641 + Math.floor(Math.random() * 300), TAG = process.argv[2] || "after";
const OUT = `/tmp/w-lanefold/${TAG}`;
mkdirSync(OUT, { recursive: true });
const HTTP_PORT = 8790 + Math.floor(Math.random() * 60);
const wcDir = decodeURIComponent(new URL("../../web-console/", import.meta.url).pathname);
globalThis.__srv = spawn("python3", ["-m", "http.server", String(HTTP_PORT), "--bind", "127.0.0.1", "--directory", wcDir], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 400));
const URL0 = `http://127.0.0.1:${HTTP_PORT}/index-005.html`;
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/lanefold-" + TAG + "-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const __cleanup = () => { try { globalThis.__p.kill("SIGKILL"); } catch {} try { globalThis.__srv.kill("SIGKILL"); } catch {} };
await wait(2500);
let list;
for (let i = 0; i < 6; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; } catch { await wait(1500); } }
if (!list) { console.error("CDP 不可达"); __cleanup(); process.exit(2); }
const tab = list.find(t => t.type === "page" && t.url.includes("index-005"));
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip;
  for (let i = 0; i < 3; i++) { const r = await send("Page.captureScreenshot", params); if (r?.result?.data) { writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  shot ${name}`); return; } await wait(200); }
  console.log(`  shot ${name} SKIP`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1500);

// ---------- fixture：一组六态板卡 ----------
const now = Date.now();
const mk = (id, status, text, ago) => ({ id, text, status, ts: now - ago, updated_at: now - ago });
const entries = [
  mk("p1", "planned", "想法：手机端泳道折叠形态单独设计", 40e6), mk("p2", "planned", "想法：板卡到期提醒", 30e6),
  mk("b1", "backlog", "看板泳道三修（本单）", 3600e3), mk("b2", "backlog", "团队页源徽章聚合", 7200e3), mk("b3", "backlog", "通知域空态文案", 9e6),
  mk("c1", "claimed", "lanefold 泳道折叠", 1800e3), mk("c2", "claimed", "探针 harness 维护", 2600e3),
  mk("s1", "submitted", "topbar36 顶栏收档", 5400e3),
  mk("r1", "ready_to_install", "test.97 装机验收", 4200e3),
  mk("d1", "done", "boardlife R4 七锚跟形", 20e6), mk("d2", "done", "expofold 手机壳不折叠", 22e6), mk("d3", "done", "prbackflow R2 CI 定罪", 60e6), mk("d4", "done", "dsagent 调研三路", 90e6),
];
const snap = { type: "SNAPSHOT", payload: { sessions: [], projects: [{ id: "pg-lane", name: "泳道组", anchor_dir: "/d/lane", tier: "轻立项", status: "active", created_at: 1, updated_at: 1, headcount: [] }], boards: [{ gid: "pg-lane", entries }], confirmations: [], notifications: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: ${JSON.stringify(snap.payload)} })`); // team 域真入口（probe-boardlife 先例：frames.emit 不路由团队域）
await wait(400);
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(900);
await ev(`(() => { const c = document.querySelector('#d-team [data-team-project]'); if (c) c.click(); return !!c; })()`); // 真组卡（.team-card 不存在）
// 板数据到位复核：done 徽章=4 才继续（最多 5 轮×700ms——空壳板时序防线）
let ready = false;
for (let i = 0; i < 5; i++) {
  const badge = await ev(`(() => { const b = document.querySelector('#d-team [data-team-project].selected'); if (!b) return "nosel"; const bd = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .lane-done .lane-badge, #d-team .board-pane .lane-done .lane-badge'); return bd ? bd.textContent : "nobadge"; })()`);
  if (badge === "4") { ready = true; break; }
  if (badge === "nosel") await ev(`document.querySelector('#d-team [data-team-project]')?.click()`);
  await wait(700);
}
if (!ready) { const b = await ev(`(() => { const sel = document.querySelector("#d-team [data-team-project].selected"); const bd = document.querySelector("#d-team .lane-done .lane-badge"); const pane = document.querySelector("#d-team .workspace-body > .workspace-pane.board-pane.active"); return JSON.stringify({ sel: !!sel, selN: document.querySelectorAll("#d-team [data-team-project]").length, badge: bd ? bd.textContent : "nobadge", paneActive: !!pane, cards: document.querySelectorAll("#d-team .lane-done .task-card").length }); })()`); console.log("WARN: 板数据未到位 →", b); }

const boardClip = await ev(`(() => { const r = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .board, #d-team .board-pane .board')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 840), scale: 1 } : null; })()`);
if (TAG === "before") {
  if (boardClip) { await shot("before-board-dark", boardClip); await ev(`document.documentElement.setAttribute("data-theme","light")`); await wait(300); await shot("before-board-light", boardClip); }
  __cleanup(); process.exit(0);
}

// ---------- 断言 ----------
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? "  ok " : "  FAIL ") + n); };
const m = JSON.parse(await ev(`(() => {
  const board = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .board') || document.querySelector('#d-team .board-pane .board, #d-team .board');
  if (!board) return JSON.stringify({ err: "board 未渲染" });
  const laneOf = (st) => board.querySelector('.lane-' + st);
  const rect = (el) => el ? el.getBoundingClientRect() : null;
  const doneL = laneOf('done'), plannedL = laneOf('planned'), claimedL = laneOf('claimed');
  const doneHead = doneL?.querySelector('.lane-fold-head'), doneDrawer = doneL?.querySelector('.lane-drawer-in');
  const cs = (el, p) => el ? getComputedStyle(el)[p] : null;
  return JSON.stringify({
    err: null, laneN: board.querySelectorAll(':scope > .lane').length,
    boardScrollX: board.scrollWidth - board.clientWidth, boardOverflowX: cs(board, "overflowX"),
    coreHeights: ["backlog", "claimed", "submitted", "ready_to_install"].map(st => Math.round(rect(laneOf(st))?.height || 0)),
    plannedCls: plannedL?.className || "", doneCls: doneL?.className || "",
    doneHeadH: Math.round(rect(doneHead)?.height || 0), doneDrawerH: doneDrawer ? Math.round(doneDrawer.getBoundingClientRect().height) : -1,
    doneBadge: doneHead?.querySelector('.lane-badge')?.textContent || "", plannedBadge: plannedL?.querySelector('.lane-badge')?.textContent || "",
    coreHeadTopGap: Math.round((rect(claimedL?.querySelector('.lane-head'))?.top ?? -9) - (rect(claimedL)?.top ?? -9)),
    doneHeadTopGap: Math.round((rect(doneHead)?.top ?? -9) - (rect(doneL)?.top ?? -9)),
    coreHeadBg: cs(claimedL?.querySelector('.lane-head'), "backgroundColor"),
    chevRot: cs(doneHead?.querySelector('.lane-chev'), "transform"),
    drawerTrans: cs(doneL?.querySelector('.lane-drawer'), "transitionDuration") + " " + cs(doneL?.querySelector('.lane-drawer'), "transitionTimingFunction"),
    ariaExp: doneHead?.getAttribute("aria-expanded"),
  });
})()`));
if (m.err) { console.log("FAIL: " + m.err); __cleanup(); process.exit(1); }
ok(m.laneN === 6, `B 六泳道在场（${m.laneN}）`);
ok(m.boardScrollX <= 1, `A 横向滚动消失（scrollWidth-clientWidth=${m.boardScrollX}）`);
ok(m.boardOverflowX === "hidden", `A board overflowX=hidden（${m.boardOverflowX}）`);
ok(m.coreHeights.every(h => h > 200), `B 四核心泳道完整可见（${m.coreHeights.join("/")} >200）`);
ok(m.doneCls.includes("lane-closed") && m.plannedCls.includes("lane-open"), `H 默认态：done 收起/planned 展开（${m.doneCls}｜${m.plannedCls}）`);
ok(m.doneHeadH >= 28 && m.doneHeadH <= 44, `C done 细头高≈32px 档（${m.doneHeadH}）`);
ok(m.doneDrawerH === 0, `D 收起态抽屉腔高 0（${m.doneDrawerH}）`);
ok(m.doneBadge === "4" && m.plannedBadge === "2", `E 徽章=卡数（done=${m.doneBadge} planned=${m.plannedBadge}）`);
ok(m.coreHeadTopGap <= 1 && m.doneHeadTopGap <= 1, `C 标题贴边零缝隙（核心 ${m.coreHeadTopGap}/done ${m.doneHeadTopGap}——≤1 为 lane 边框线非缝隙）`);
ok(m.coreHeadBg && m.coreHeadBg !== "rgba(0, 0, 0, 0)", `C 头部实色遮底（${m.coreHeadBg}）`);
ok(/(240ms|0\.24s)/.test(m.drawerTrans || ""), `D 抽屉动画 240ms（${m.drawerTrans}）`);

// 开合交互：点 done 头 → 展开+过渡帧+chevron 旋转；再点回收起+记忆
const sel = `#d-team .workspace-body > .workspace-pane.board-pane.active .lane-done .lane-fold-head, #d-team .lane-done .lane-fold-head`;
await ev(`document.querySelector('${sel}').click()`);
await wait(120);
const midClip = await ev(`(() => { const el = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .lane-done') || document.querySelector('#d-team .lane-done'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height + 220, 760), scale: 1 }; })()`);
if (midClip) await shot("04-done-open-midframe", midClip);
await wait(320);
const m2 = JSON.parse(await ev(`(() => { const l = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .lane-done') || document.querySelector('#d-team .lane-done'); return JSON.stringify({ cls: l.className, drawerH: Math.round(l.querySelector('.lane-drawer-in').getBoundingClientRect().height), rot: getComputedStyle(l.querySelector('.lane-chev')).transform, ls: localStorage.getItem("lanefold:pg-lane:done") }); })()`));
ok(m2.cls.includes("lane-open"), "D 点击展开（lane-open）");
ok(m2.drawerH > 100, `D 展开态抽屉腔高恢复（${m2.drawerH}）`);
ok(m2.rot !== "none" && m2.rot !== m.chevRot, `D chevron 随展开旋转（${m2.rot}）`);
ok(m2.ls === "1", `D localStorage 记忆展开（${m2.ls}）`);
await ev(`document.querySelector('${sel}').click()`);
await wait(320);
const m3 = JSON.parse(await ev(`(() => { const l = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .lane-done') || document.querySelector('#d-team .lane-done'); return JSON.stringify({ cls: l.className, h: Math.round(l.querySelector('.lane-drawer-in').getBoundingClientRect().height), ls: localStorage.getItem("lanefold:pg-lane:done") }); })()`));
ok(m3.cls.includes("lane-closed") && m3.h === 0 && m3.ls === "0", `D 再点收起+记忆（h=${m3.h} ls=${m3.ls}）`);

// reduced-motion：全局 .01ms 闸钳制
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await wait(300);
const rm = await ev(`(() => { const l = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .lane-done .lane-drawer') || document.querySelector('#d-team .lane-done .lane-drawer'); return getComputedStyle(l).transitionDuration; })()`);
ok((parseFloat(rm) || 1) <= 0.05, `F reduced-motion 动画退化成立即显隐（transition=${rm}——全局闸钳制）`);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

// ---------- 截图 ----------
if (boardClip) await shot("01-board-dark", boardClip);
const headClip = await ev(`(() => { const el = document.querySelector('#d-team .workspace-body > .workspace-pane.board-pane.active .lane-done') || document.querySelector('#d-team .lane-done'); const r = el.getBoundingClientRect(); return { x: r.x - 4, y: r.y - 6, width: r.width + 8, height: 130, scale: 1 }; })()`);
await shot("02-done-head-dark", headClip);
await ev(`document.documentElement.setAttribute("data-theme","light")`);
await wait(350);
if (boardClip) await shot("03-board-light", boardClip);
await shot("05-done-head-light", headClip);

console.log(`\nlanefold probe: ${pass} ok / ${fail} FAIL`);
__cleanup();
process.exit(fail ? 1 : 0);
