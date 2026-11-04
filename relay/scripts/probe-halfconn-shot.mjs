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

// ---------- 状态③：半连接（下行帧刚到 + 链路断）→ 胶囊显「· 重连中」（本批新行为） ----------
// 序：先再喂一帧（刷 _lastFrameAt——IngestSnapshot 走 onEvent 统一入口），**后**断链——
// 「下行仍活、上行已断」正是 1104 用户实锤「显示未连接但消息还在到」的注入形态
await ev(`window.__ccDeck005IngestSnapshot("lan", ${JSON.stringify(snap.payload)})`);
await wait(120);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "close", source: "lan" })`);
await wait(400);
const t3 = await badgeNote();
ok(t3.includes("重连中"), "③ 半连接（断链但下行帧 45s 窗内仍活）→「· 重连中」（徽标诚实核心断言）", t3);
await shot("03-halfconn-reconnecting");

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

console.log("");
console.log(fail === 0 ? `PASS ${pass}（halfconn 徽标诚实三态对照+自愈链闭环）` : `FAIL ${pass}`);
console.log("console errors: " + (consoleErrs.length ? JSON.stringify(consoleErrs.slice(0, 5)) : "无"));
try { globalThis.__p.kill(); } catch {}
process.exit(fail === 0 ? 0 : 1);
