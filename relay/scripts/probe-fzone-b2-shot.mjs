// [W-FZONE-B2] 文件工作区批二 CDP 截图+断言探针（骨架复用 probe-fzone-shot 批一）。
// 场景：①自动推 tab（WORKING→DONE 收口差分新产物→新 tab+「新」角标+不抢焦点）②pdf 原生
// viewer（iframe blob）③音频（audio controls）④树抽屉（目录分组+点文件开 tab）⑤⌘2 直达
// ⑥双主题截图。直跑：cd relay && node scripts/probe-fzone-b2-shot.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9941 + Math.floor(Math.random() * 300);
const OUT = `/Users/xdd/.cc-deck/artifacts/fzone-b2-shots`;
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn$();
function spawn$() { const { spawn } = require("node:child_process"); return spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/fzb2-cdp-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" }); }
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
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*"] });
await send("Page.reload");
await wait(3200);
// ---------- 夹具：md 基线 + 收口新增 pdf/mp3 + 树分组素材 ----------
const b64 = (s) => Buffer.from(s, "utf-8").toString("base64");
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const MD_DOC = "# 批二演示\n\n- 格式矩阵 + 自动推 tab + 树 + ⌘直达\n";
// 最小合法单页 PDF（结构完整即可——Chromium 原生 viewer 能开）
const PDF_1P = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 100 Td (W-FZONE-B2 pdf preview) Tj ET\nendstream\nendobj\nxref\n0 5\ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n0\n%%EOF");
const MP3_FAKE = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // ID3 头（元素在场即可，不赌解码）
const FIX = {
  "reports/demo.md": { mime: "text/markdown", b64: b64(MD_DOC) },
  "reports/w-fzone-b2.pdf": { mime: "application/pdf", b64: PDF_1P.toString("base64") },
  "assets/voice-note.mp3": { mime: "audio/mpeg", b64: MP3_FAKE.toString("base64") },
  "assets/shot.png": { mime: "image/png", b64: PNG_1PX },
};
const now = Date.now();
const artsBase = [
  { path: "reports/demo.md", size: 60, last_at: now - 60e3, first_at: now - 120e3, op: "create", exists: true },
  { path: "assets/shot.png", size: 100, last_at: now - 50e3, first_at: now - 120e3, op: "create", exists: true },
];
const sess = { session_id: "fz-b2", title: "批二演示会话", status: "WORKING", turn_started_at: now - 120e3, engine: "claude", model: "glm-5.3", cwd: "/tmp/fz-b2", updated_at: now - 5e3, started_at: now - 9e5, context_usage: 84000, context_limit: 200000, artifacts: artsBase };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [sess], notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`(() => {
  const FIX = ${JSON.stringify(FIX)};
  try { navigator.clipboard.writeText = () => Promise.resolve(); } catch (_) {}
  window.addEventListener("error", (e) => { (window.__fzErrs = window.__fzErrs || []).push(String(e.message).slice(0, 80)); });
  window.__ccDeck005RouteWs = null;
  window.__ccDeck005MainWs = { readyState: 1, send: (str) => {
    const cmd = JSON.parse(str);
    if (cmd.type !== "COMMAND_ARTIFACT_FETCH") return;
    const fix = FIX[cmd.payload.path];
    setTimeout(() => {
      if (!fix) { window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "COMMAND_ACK", payload: { command_id: cmd.command_id, ok: false, error: "探针无此夹具" } } }); return; }
      window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "COMMAND_ACK", payload: { command_id: cmd.command_id, ok: true, artifact: { mime: fix.mime, size: fix.b64.length } } } });
      window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "ARTIFACT_CHUNK", payload: { ref: cmd.command_id, seq: 0, total: 1, b64: fix.b64, done: true } } });
    }, 40);
  } };
})()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`document.querySelector('[data-session-card="fz-b2"]').click()`);
await ev(`document.querySelector('[data-session-card="fz-b2"]').classList.add("selected")`);
await wait(900);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const fzRead = async () => JSON.parse(await ev(`JSON.stringify((() => { const z = document.getElementById("fzone"); if (!z) return null; return { hidden: z.hidden, tabs: window.ccDeckFzone ? window.ccDeckFzone.tabs() : [], active: (z.querySelector(".wtab.on .fname")||{}).textContent || "", fresh: [...z.querySelectorAll(".fz-badge")].map((b) => b.textContent), md: !!z.querySelector(".fz-md"), pdf: !!z.querySelector("iframe.fz-pdf"), audio: !!z.querySelector("audio.fz-audio"), tree: !!z.querySelector(".fz-tree"), treeDirs: [...z.querySelectorAll(".fz-tree-dir")].map((d) => d.textContent), treeFiles: z.querySelectorAll(".fz-tree-file").length, state: (z.querySelector(".fz-state")||{}).textContent || "" }; })())`));

// ⓪ WORKING 期基线帧（fzAutoTabBase 首见建基：模拟生产「SNAPSHOT→WORKING 期 SESSION_UPDATED→收口」三段时序——跳过本帧则收口帧成首见不推）
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "SESSION_UPDATED", session_id: "fz-b2", payload: ${JSON.stringify({ status: "WORKING", updated_at: Date.now(), artifacts: artsBase })} } })`);
await wait(500);

// ① 手开 md tab（基线：active=demo.md）
await ev(`(() => { const rr = document.querySelector('.art-row[data-path="reports/demo.md"]'); if (rr) rr.click(); })()`);
await wait(700);
const s1 = await fzRead();
ok(!s1.hidden && s1.tabs.length === 1 && s1.active === "demo.md" && s1.md, "① 手开 md tab：面板开+md 渲染+active=demo.md");

// ② 收口自动推：SESSION_UPDATED（WORKING→DONE + artifacts 增 pdf/mp3）→ 新 2 tab+角标+不抢焦点
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "SESSION_UPDATED", session_id: "fz-b2", payload: ${JSON.stringify({ status: "DONE", updated_at: Date.now(), artifacts: [...artsBase, { path: "reports/w-fzone-b2.pdf", size: 800, last_at: Date.now(), first_at: Date.now(), op: "create", exists: true }, { path: "assets/voice-note.mp3", size: 10, last_at: Date.now(), first_at: Date.now(), op: "create", exists: true }] })} } })`);
await wait(1400);
const s2 = await fzRead();
ok(s2.tabs.length === 3 && s2.active === "demo.md", "② 自动推 tab：新 2 tab 入列+active 仍 demo.md（不抢焦点）");
ok(s2.fresh.length === 2 && s2.fresh.every((x) => x === "新"), `② 「新」角标 ×2（实 ${JSON.stringify(s2.fresh)}）`);
ok(/2 新/.test(s2.state), `② 工具行计数带「2 新」（实「${s2.state}」）`);

// ③ 点 pdf 新 tab → 角标清+iframe 原生 viewer
await ev(`(() => { const t = [...document.querySelectorAll(".wtab")].find((w) => w.textContent.includes("w-fzone-b2.pdf")); if (t) t.click(); })()`);
await wait(900);
const s3 = await fzRead();
ok(s3.pdf, "③ pdf：iframe.fz-pdf 在（blob 原生 viewer 零依赖）");
ok(s3.fresh.length === 1, `③ 点聚焦清角标（余 ${s3.fresh.length} 个）`);
await shot("b2-pdf-dark");

// ④ mp3 tab → audio controls
await ev(`(() => { const t = [...document.querySelectorAll(".wtab")].find((w) => w.textContent.includes("voice-note.mp3")); if (t) t.click(); })()`);
await wait(700);
const s4 = await fzRead();
ok(s4.audio, "④ 音频：audio.fz-audio controls 在");

// ⑤ 树抽屉：点 ▤ 树 → 目录分组+点文件开 tab
await ev(`(() => { const b = document.querySelector("[data-fz-tree-btn]"); if (b) b.click(); })()`);
await wait(400);
const s5 = await fzRead();
if (!s5.tree) {
  const dump = await ev(`(() => { const z = document.getElementById("fzone"); return JSON.stringify({ tools: (z.querySelector("[data-fz-tools]")||{}).innerHTML || "", bodyHead: (z.querySelector("[data-fz-body]")||{}).innerHTML || "", errs: window.__fzErrs || [] }); })()`);
  console.error("  ⑤ 现场 dump: " + dump.slice(0, 400));
}
ok(s5.tree && s5.treeDirs.length === 2 && s5.treeFiles >= 4, `⑤ 树抽屉开：2 目录分组（${s5.treeDirs.join("｜")}）≥4 文件`);
await shot("b2-tree-dark");
await ev(`(() => { const f = [...document.querySelectorAll(".fz-tree-file")].find((x) => x.textContent.includes("shot.png")); if (f) f.click(); })()`);
await wait(800);
const s5b = await fzRead();
ok(s5b.tabs.length === 4 && !s5b.tree && s5b.active === "shot.png", "⑤ 树内点 png → 开第 4 tab+树收");

// ⑥ ⌘2 直达第 2 tab
await ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", metaKey: true, bubbles: true, cancelable: true })); })()`);
await wait(300);
const s6 = await fzRead();
ok(s6.active === s6.tabs[1].split("/").pop(), `⑥ ⌘2 直达第 2 tab（active=${s6.active}）`);

// ⑦ 双主题截图（pdf tab 态+亮主题）
await ev(`(() => { const t = [...document.querySelectorAll(".wtab")].find((w) => w.textContent.includes("w-fzone-b2.pdf")); if (t) t.click(); })()`);
await wait(400);
await ev(`document.documentElement.setAttribute("data-theme", "light")`);
await wait(400);
await shot("b2-pdf-light");
await ev(`document.documentElement.setAttribute("data-theme", "dark")`);

const errs = await ev(`JSON.stringify(window.__fzErrs || [])`);
ok(JSON.parse(errs).length === 0 && consoleErrs.length === 0, `⑦ 零页内错误（${errs}｜${JSON.stringify(consoleErrs.slice(0, 2))}）`);
console.log(`\n批二探针：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
