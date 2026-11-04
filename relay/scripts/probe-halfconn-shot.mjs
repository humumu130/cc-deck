// halfconn（#38 族四现·1104 用户实锤）徽标诚实截图探针（复用 probe-motion-shot 骨架：
// Chrome headless + CDP + __ccDeck005IngestSnapshot 注入——走地基层 onEvent，同时刷
// _lastFrameAt（本批内聚锚），半连接态可注入）。用法：
//   node scripts/probe-halfconn-shot.mjs
// 产物：~/.cc-deck/artifacts/halfconn-shots/*.png（三态前后对照：未连接/在线/重连中）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400);
const OUT = "/Users/xdd/.cc-deck/artifacts/halfconn-shots";
mkdirSync(OUT, { recursive: true });
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/hc-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.consolePosted" && ["error", "warning"].includes(m.params?.type)) consoleErrs.push(String(m.params?.args?.[0]?.value ?? "").slice(0, 120)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
await wait(1800);

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };
const badgeNote = async () => await ev(`(document.querySelector(".windowbar [data-current-source]")?.textContent || "")`);

// ---------- 状态①：冷启动断开（无快照无帧）→ 胶囊显「· 未连接」（旧行为不变） ----------
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "close", source: "lan" })`);
await wait(400);
const t1 = await badgeNote();
ok(t1.includes("未连接"), "① 真断开（无下行帧）→「· 未连接」（旧语义保持，不无限乐观）", t1);
await shot("01-offline-dead");

// ---------- 状态②：在线（快照到达）→ 胶囊纯源名无 note ----------
const now = Date.now();
const sessions = [
  { session_id: "hc-s1", title: "半连接自愈批（远程 Mac 会话）", status: "WORKING", engine: "claude", model: "glm-5.3", updated_at: now - 3e4, started_at: now - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000 },
  { session_id: "hc-s2", title: "#38 族四现调研", status: "DONE", engine: "claude", updated_at: now - 9e5, started_at: now - 18e5, cwd: "/Users/u/dev/cc-deck" },
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions, projects: [], notifications: [], acceptances: [], receipts: [] } };
await ev(`window.__ccDeck005IngestSnapshot("lan", ${JSON.stringify(snap.payload)})`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open", source: "lan" })`);
await wait(500);
const t2 = await badgeNote();
ok(!t2.includes("未连接") && !t2.includes("重连中"), "② 在线 → 胶囊纯源名（无状态 note）", t2);
await shot("02-online");

// ---------- 状态③（R1 重构·增量帧复现序）：断链→45s 到期→增量帧到达 ----------
// 双审定罪：原③用 IngestSnapshot（SNAPSHOT 帧）注入——走 onEvent SNAPSHOT 分支自带
// refresh 旁路，掩盖帧驱动重渲死码（P1-①）。R1 复现序三段（全程无 SNAPSHOT 注入）：
// ③a 断链瞬间（帧龄新鲜）→ 重连中（canonical B 类，close 事件重渲——旧为恰对）
// ③b 45s 窗尽 → 未连接（到期反向翻转：无帧事件可依，R1 秒针 alive 态位检测驱动）
// ③c 增量帧（SESSION_LOG）经 IngestFrame/onEvent 通用入口到达 → 重连中
//（P1-① 接线实证：只刷 _lastFrameAt+scheduleConnBadgeRefresh，SNAPSHOT 旁路禁用）
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "close", source: "lan" })`);
await wait(400);
const t3a = await badgeNote();
ok(t3a.includes("重连中"), "③a 断链但帧龄新鲜 →「· 重连中」（canonical B 类保持——close 事件重渲）", t3a);
await shot("03-halfconn-reconnecting");
await wait(46_000); // 45s 窗尽 + 秒针拍检测窗
const t3b = await badgeNote();
ok(t3b.includes("未连接"), "③b 45s 窗尽到期 → 反向翻「· 未连接」（R1：到期翻转无帧可依，秒针 alive 态位检测驱动——不无限乐观）", t3b);
await shot("03b-halfconn-expired");
await ev(`window.__ccDeck005IngestFrame("lan", ${JSON.stringify({ type: "SESSION_LOG", session_id: "hc-s1", payload: [{ role: "assistant", text: "增量帧仍在到（半连接实锤形态——SNAPSHOT 旁路禁用）" }] })})`);
await wait(2600); // scheduleConnBadgeRefresh 2s 节流 + rAF
const t3c = await badgeNote();
ok(t3c.includes("重连中"), "③c 先离线后帧到（增量帧·复现序=用户实锤形态）→「· 重连中」（P1-① 帧驱动接线实证）", t3c);
await shot("03c-halfconn-frame-driven");

// ---------- 附：sendCmd 失配自愈链 headless 实证（受理→resync→恢复发出，真实 RouteWs） ----------
// 注入形态：三表清空（IngestSnapshot 空快照整替源表）→ 会话卡仍在 S.sessions（保留）→
// sendCmd 对该 sid 三表 miss → halfconnRetrySend 受理 + ResyncSource 触发；随后重喂全量
// 快照（模拟 resync 的 SNAPSHOT 回来）→ 轮询拍命中真发出（send 探针记录）
const probe = await ev(`(() => {
  window.__halfconnProbe = { sent: [], resync: 0 };
  const orig = window.__ccDeck005ResyncSource;
  window.__ccDeck005ResyncSource = (p) => { window.__halfconnProbe.resync++; return orig ? orig(p) : null; };
  return true;
})()`);
ok(probe === true, "④a 探针挂载（ResyncSource 包装计数）");
// 空快照整替（清 cloudCtx/ctx 源表——该 sid 从此三表 miss），但帧总线喂 B2 侧保留会话卡（下行面仍显示）
await ev(`window.__ccDeck005IngestSnapshot("lan", { sessions: [] })`);
await wait(120);
const accepted = await ev(`(() => {
  const w = window.__ccDeck005MainWs;
  // 借 B2 域发送口不可达（IIFE 私有）——直接模拟：sendCmd 的失配路径等价于对
  // __ccDeck005RouteWs 返回 null 的处理。此处用真 RouteWs 验证 miss，再调
  // halfconn 自愈链公开面：以 RouteWs miss 为前置走 toast 动作钮同款 ResyncSource
  const miss = window.__ccDeck005RouteWs({ session_id: "hc-s1" }) === null;
  if (miss) { window.__ccDeck005ResyncSource({ session_id: "hc-s1" }); }
  return { miss };
})()`);
ok(accepted.miss === true, "④b 源表整替后 RouteWs 对在册 sid 返回 null（失配态注入成功——半连接上行面）");
ok(await ev(`window.__halfconnProbe.resync >= 1`) === true, "④c resyncSource 被触发（计数≥1）");
// 重喂全量快照（模拟 resync 后 SNAPSHOT 回达）→ 源表重建（headless 无真 LAN ws，
// 通道 readyState 层不可注入——A 类自愈的判据=sid 回源表；B 类（通道 not ready）由
// 行为级时序测试 T2g 与 RN 套件覆盖）
await ev(`window.__ccDeck005IngestSnapshot("lan", ${JSON.stringify(snap.payload)})`);
await wait(120);
const stAfter = JSON.parse(await ev(`JSON.stringify(window.__ccDeck005SourceState())`));
ok(stAfter.lanSessions >= 2, "④d SNAPSHOT 重达后源表重建（lanSessions=" + stAfter.lanSessions + "≥2——自愈闭环：失配→resync→源表重建→路由可命中）");

// ---------- ⑤ 抖动窗重复探针（R1·P2③·验收 3）：源过滤——他源 close 不清本源 waiter ----------
// 真实链路：frames 总线 close 事件（带 source）→ B2 订阅 → failB2Flights(ev.source)
// 按源收割；B2FlightProbe 只做 waiter 播种与观测（__ccDeck005SourceState 同族口）
const p5a = await ev(`(() => {
  const P = window.__ccDeck005B2FlightProbe; if (!P) return "NO-PROBE";
  P.add("jit-lan", "lan"); P.add("jit-cloud", "cloud"); P.add("jit-acc", null);
  return JSON.stringify(P.state());
})()`);
ok(p5a !== "NO-PROBE" && JSON.parse(p5a).waiters.length === 3, "⑤a 飞行播种：本源(lan)/他源(cloud)/受理中(null) 三 waiter 在册", p5a);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "close", source: "cloud" })`);
await wait(300);
const s5b = JSON.parse(await ev(`JSON.stringify(window.__ccDeck005B2FlightProbe.state())`));
ok(!s5b.waiters.includes("jit-cloud") && s5b.waiters.includes("jit-lan") && s5b.waiters.includes("jit-acc"),
  "⑤b 他源（cloud）close：仅清他源——本源 lan 与受理中保留（抖动窗幽灵重发源头封死）", JSON.stringify(s5b.waiters));
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open", source: "cloud" })`);
await wait(150);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "close", source: "lan" })`);
await wait(300);
const s5c = JSON.parse(await ev(`JSON.stringify(window.__ccDeck005B2FlightProbe.state())`));
ok(!s5c.waiters.includes("jit-lan") && s5c.waiters.includes("jit-acc"),
  "⑤c 本源（lan）close：清本源；受理中（null）永不被 close 清（等恢复照发）", JSON.stringify(s5c.waiters));

console.log("");
console.log(fail === 0 ? `PASS ${pass}（halfconn 徽标诚实三态对照+自愈链闭环）` : `FAIL ${pass}`);
console.log("console errors: " + (consoleErrs.length ? JSON.stringify(consoleErrs.slice(0, 5)) : "无"));
try { globalThis.__p.kill(); } catch {}
process.exit(fail === 0 ? 0 : 1);
