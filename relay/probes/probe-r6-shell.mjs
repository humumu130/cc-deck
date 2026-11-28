// Review probe 6: verify c367bc64 fixes on new HEAD (fake shell + viewport sync).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire("/Users/xdd/dev/cc-deck/relay/node_modules/ws/package.json");
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9760 + Math.floor(Math.random() * 100);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/r6rev6-" + Date.now(), "--window-size=1512,940", "file:///Users/xdd/dev/cc-deck/web-console/index-005.html"], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
for (let i = 0; i < 8; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await wait(1000); } }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Page.reload");
await wait(3000);
const now = Date.now();
const logs = [];
for (let i = 1; i <= 6; i++) logs.push({ id: `u${i}`, kind: "user_message", ts: now - (7 - i) * 60000, text: `问 ${i}` });
const sess = { session_id: "rev6", title: "R6-6", status: "DONE", engine: "claude", model: "glm", cwd: "/tmp/r6x", updated_at: now, started_at: now - 600000, duration_ms: 245000, context_usage: 84000, context_limit: 200000, artifacts: [{ path: "/tmp/r6x/report.md", kind: "file", delivered_at: now }] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "r", token_valid: true, homedir: "/Users/u", sessions: [sess], logs: { rev6: logs }, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`(() => { try { navigator.clipboard.writeText = () => Promise.resolve(); } catch (_) {} window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} }; })()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`document.querySelector('[data-session-card="rev6"]').click()`);
await wait(900);
await ev(`(() => {
  const state = { winW: 1512, winX: 0, ops: [] };
  const SCALE = 1, SCREEN_W = 2560;
  window.__TAURI__ = { window: { getCurrentWindow: () => ({
    isMaximized: async () => !!state.maxed,
    isFullscreen: async () => false,
    scaleFactor: async () => SCALE,
    innerSize: async () => ({ width: Math.round(state.winW * SCALE), height: 940 * SCALE }),
    outerSize: async () => ({ width: Math.round(state.winW * SCALE), height: 940 * SCALE }),
    outerPosition: async () => ({ x: Math.round(state.winX * SCALE), y: 0 }),
    setPosition: async (p) => { state.ops.push(["pos", Math.round(p.x / SCALE)]); state.winX = p.x / SCALE; },
    setSize: async (s) => { state.ops.push(["size", Math.round(s.width)]); state.winW = s.width; },
  }), currentMonitor: async () => ({ position: { x: 0, y: 0 }, size: { width: SCREEN_W * SCALE, height: 1440 * SCALE } }) }, dpi: {} };
  window.__shellState = state;
  localStorage.setItem("ccd_fzone_w", "440");
})()`);
const syncVp = async () => { const w = await ev(`window.__shellState.winW`); await send("Emulation.setDeviceMetricsOverride", { width: w, height: 940, deviceScaleFactor: 1, mobile: false }); await wait(250); };
const geom = () => ev(`JSON.stringify((() => { const fz = document.getElementById("fzone"), chat = document.querySelector("#d-session .session-detail"); return { iw: window.innerWidth, winW: window.__shellState.winW, fzW: Math.round(fz.getBoundingClientRect().width), fzHidden: fz.hidden, fzStyle: fz.style.width, chatW: Math.round(chat.getBoundingClientRect().width), ops: window.__shellState.ops.slice() }; })())`).then(JSON.parse);
const toggle = () => ev(`(() => { (document.querySelector("[data-fz-collapse]") || document.querySelector("[data-fzone-toggle]")).click(); })()`);
const resetOps = () => ev(`(() => { window.__shellState.ops = []; })()`);

console.log("=== S1 wide room: open should give panel=755 (surplus 315) ===");
console.log("before:", JSON.stringify(await geom()));
await toggle(); await wait(700);
console.log("open:", JSON.stringify(await geom()), "expect fz=755 win->2271");
await syncVp();
await toggle(); await wait(700);
await syncVp();
console.log("closed:", JSON.stringify(await geom()), "expect win back 1512 chat 1215");

console.log("=== S2 SCREEN-FULL (winW==screenW 2560 at vp 2560): panel=800(cap) chat floor ===");
await ev(`(() => { window.__shellState.winW = 2560; })()`);
await send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 940, deviceScaleFactor: 1, mobile: false });
await wait(300);
resetOps();
const b2 = await geom();
console.log("before2:", JSON.stringify(b2));
await toggle(); await wait(700);
console.log("open2:", JSON.stringify(await geom()), "expect fz=800 chat=1459, no size op");
await toggle(); await wait(700);
console.log("closed2:", JSON.stringify(await geom()));

console.log("=== S3 screen-full 1512 (surplus 315, cap not binding): panel=755 chat=456 ===");
await ev(`(() => { window.__shellState.winW = 1512; window.__TAURI__.window; })()`);
await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 940, deviceScaleFactor: 1, mobile: false });
// patch monitor screen to 1512 for this scenario
await ev(`(() => { const m = window.__TAURI__.window.currentMonitor; window.__TAURI__.window.currentMonitor = async () => ({ position: { x: 0, y: 0 }, size: { width: 1512, height: 1440 } }); })()`);
await wait(300);
resetOps();
await toggle(); await wait(700);
console.log("open3:", JSON.stringify(await geom()), "expect fz=755 chat=456 winW stays 1512");
await toggle(); await wait(700);
console.log("closed3:", JSON.stringify(await geom()), "expect no shrink, chat 1215");

console.log("=== S4 open->drag->close identity (viewport synced) ===");
await ev(`(() => { window.__shellState.winW = 1512; })()`);
await ev(`(() => { window.__TAURI__.window.currentMonitor = async () => ({ position: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } }); })()`);
resetOps();
await toggle(); await wait(700);
await syncVp();
const o4 = await geom();
console.log("open4:", JSON.stringify(o4));
await ev(`(() => { document.getElementById("fzone").style.width = "540px"; })()`);
await toggle(); await wait(700);
await syncVp();
console.log("closed4:", JSON.stringify(await geom()), "expect win 1512 chat 1215 (identity)");

console.log("=== S5 open -> manual narrow 1300 -> close: keep user window (no shrink, no over-shrink) ===");
await toggle(); await wait(700);
await syncVp();
await ev(`(() => { window.__shellState.winW = 1300; })()`);
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 940, deviceScaleFactor: 1, mobile: false });
await wait(400);
const mid5 = await geom();
console.log("narrowed5:", JSON.stringify(mid5));
await toggle(); await wait(700);
console.log("closed5:", JSON.stringify(await geom()), "expect win stays 1300, NO shrink op below 1300");

console.log("=== S6 maximized open: fallback applyW(readW()) re-clamps preApply ===");
await ev(`(() => { window.__shellState.maxed = true; window.__shellState.winW = 2560; })()`);
await send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 940, deviceScaleFactor: 1, mobile: false });
await wait(300);
resetOps();
await toggle(); await wait(900);
console.log("open6(maxed):", JSON.stringify(await geom()), "expect NO size op, fz clamped by avail/72vw guard (<=769), chat >=442");
await toggle(); await wait(500);
await ev(`(() => { window.__shellState.maxed = false; })()`);
await syncVp();

console.log("=== S7 quick open->close race: window should not stay grown (known residual?) ===");
resetOps();
await ev(`window.ccDeckFzone && (() => { const t = document.querySelector("[data-fz-collapse]") || document.querySelector("[data-fzone-toggle]"); t.click(); t.click(); })()`);
await wait(900);
console.log("after race:", JSON.stringify(await geom()));
ws.close(); globalThis.__p.kill(); process.exit(0);
