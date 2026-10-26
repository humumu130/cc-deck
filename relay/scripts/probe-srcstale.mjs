// #274 复现+修复证探针：新 LAN 帧→切源重放旧 cloud 帧（#268 半开族形态）——
// 改前 timelines 被旧帧整体拉回（消息停旧时点=用户症状）；改后新者胜保本地。
// 跑法：node scripts/probe-srcstale.mjs（headless Chrome :9338）
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js");
const PORT = 9338, URL0 = "file:///private/tmp/cc-deck-w-srcstale/web-console/index-005.html";
globalThis.__p = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/ss-cdp2", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(4000);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page" && t.url.includes("index-005"));
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);
const T_OLD = Date.now() - 3600_000, T_NEW = Date.now();
const mkSnap = (relayName, logTs, logText) => ({ type: "SNAPSHOT", payload: {
  relay_name: relayName, token_valid: true,
  sessions: [{ session_id: "pm-d2f797de", title: "PM 会话", status: "DONE", engine: "", model: "glm-5.3", updated_at: logTs, cwd: "/tmp/p" }],
  logs: { "pm-d2f797de": [{ kind: "assistant_text", text: logText, ts: logTs }] } } });
const emit = (frame, src) => `window.__ccDeck005Frames.emit({ kind: "frame", source: ${JSON.stringify(src)}, frame: ${JSON.stringify(frame)} })`;
// ①聚合视角 + 新 LAN 帧（15:08 之后的消息）
await ev(`window.__ccDeck005SetSourceView && window.__ccDeck005SetSourceView("aggregate")`);
await wait(300);
await ev(emit(mkSnap("本机-LAN", T_NEW, "17:42 的新消息（LAN 完整流）"), "lan"));
await wait(800);
let pass = 0, fail = 0; const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? "  ok " : "  FAIL ") + n); };
const r1 = await ev(`(() => { const S = (window.__ccDeck005DebugTimelines && window.__ccDeck005DebugTimelines()) || (() => { const el = document.querySelector('[data-session-card="pm-d2f797de"]'); return el ? el.title : "no-card"; })(); return typeof S === "string" ? S : JSON.stringify(S); })()`);
// 直接读页面渲染面：选中会话后消息流文本
await ev(`document.querySelector('[data-session-card="pm-d2f797de"]')?.click()`);
await wait(700);
const msg1 = await ev(`[...document.querySelectorAll("#session-body .message-ai, #session-body .bubble, #session-body .msg-user-row")].map(x => x.textContent).join("|").slice(0, 120)`);
ok(msg1.includes("17:42"), `①新 LAN 帧消息在流（实测 ${JSON.stringify(msg1.slice(0, 50))}）`);
// ②切源重放：旧 cloud 陈旧帧（15:08 时点，模拟 #268 半开族滞留缓存经 replaySnapshots 注入）
await ev(`window.__ccDeck005SetSourceView("cloud")`); await wait(400);
await ev(`window.__ccDeck005SetSourceView("aggregate")`); await wait(400);
await ev(emit(mkSnap("云桥-陈旧", T_OLD, "15:08 的旧消息（陈旧快照）"), "cloud"));
await wait(900);
const msg2 = await ev(`[...document.querySelectorAll("#session-body .message-ai, #session-body .bubble, #session-body .msg-user-row")].map(x => x.textContent).join("|").slice(0, 120)`);
ok(msg2.includes("17:42"), `②陈旧 cloud 帧不能拉回消息流（仍见 17:42——改后新者胜；实测 ${JSON.stringify(msg2.slice(0, 50))}）【主锚：改前此处停 15:08】`);
ok(!msg2.includes("15:08 的旧消息独占") || msg2.includes("17:42"), `③本地缓冲优先（旧消息即使入流也不清掉新消息）`);
// ③缺口补拉：另一会话本地无缓冲→快照份直接采用（冷启动语义）
await ev(emit({ type: "SNAPSHOT", payload: { relay_name: "本机-LAN", token_valid: true,
  sessions: [{ session_id: "w-cold", title: "冷会话", status: "DONE", engine: "claude", updated_at: T_NEW, cwd: "/tmp/p" }],
  logs: { "w-cold": [{ kind: "assistant_text", text: "冷启动补拉的消息", ts: T_NEW }] } } }, "lan"));
await wait(800);
await ev(`document.querySelector('[data-session-card="w-cold"]')?.click()`);
await wait(600);
const msg3 = await ev(`[...document.querySelectorAll("#session-body .message-ai, #session-body .bubble, #session-body .msg-user-row")].map(x => x.textContent).join("|").slice(0, 120)`);
ok(msg3.includes("冷启动补拉的消息"), `④缺口/冷启动=快照份被采用（补拉语义保留）`);
console.log(`\nSRCSTALE probe: ${pass} passed, ${fail} failed`);
try { ws.close(); } catch {}
try { globalThis.__p.kill(); } catch {}
process.on("exit", () => { try { globalThis.__p.kill(); } catch {} });
process.exit(fail ? 1 : 0);
