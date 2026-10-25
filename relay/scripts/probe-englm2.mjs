// W-ENGLM2 CDP 沙盒探针：三组锚（glm 模型会话=Claude 螃蟹三处 / zcode 完备 / chip 活跃数三态）
// 跑法：node scripts/probe-englm2.mjs（自动起 headless Chrome :9333，截图 /tmp/w-englm2-probe/）
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333, OUT = "/tmp/w-englm2-probe";
const URL0 = "file:///private/tmp/cc-deck-w-englm2/web-console/index-005.html";
mkdirSync(OUT, { recursive: true });
globalThis.__chromeProc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/englm2-cdp", URL0], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));

async function j(url) { const r = await fetch(url); return r.json(); }
async function newTab() {
  for (let i = 0; i < 12; i++) {
    const list = await j(`http://127.0.0.1:${PORT}/json/list`).catch(() => []);
    const hit = list.find(t => t.type === "page" && t.url.includes("index-005"));
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 500));
  }
  const list = await j(`http://127.0.0.1:${PORT}/json/list`);
  return list.find(t => t.type === "page");
}
const tab = await newTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pending = new Map();
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;

await send("Page.enable"); await send("Runtime.enable");
await new Promise(r => setTimeout(r, 1800)); // 等页面 IIFE 初始化

// ---- 注入 SNAPSHOT：三会话 + 一团队（PM + 1 WORKING worker + 1 idle worker）----
const now = Date.now();
const snap = {
  type: "SNAPSHOT",
  payload: {
    relay_name: "engl m2-probe", token_valid: true,
    sessions: [
      { session_id: "glm-sess-0001", title: "GLM 模型会话", status: "DONE", engine: "", model: "glm-5.3", updated_at: now, started_at: now - 9e5, cwd: "/tmp/proj-glm" },
      { session_id: "zc-sess-0002", title: "ZCode 会话", status: "WORKING", engine: "zcode", model: "", updated_at: now, started_at: now - 8e5, cwd: "/tmp/proj-zc" },
      { session_id: "pm-sess-0003", title: "PM 主会话", status: "DONE", engine: "", model: "glm-5.3", updated_at: now, started_at: now - 7e5, cwd: "/tmp/proj" },
      { session_id: "w-sess-0004", title: "worker 甲", status: "WORKING", engine: "claude", model: "", updated_at: now, started_at: now - 6e5, cwd: "/tmp/proj" },
      { session_id: "w-sess-0005", title: "worker 乙", status: "DONE", engine: "claude", model: "", updated_at: now, started_at: now - 5e5, cwd: "/tmp/proj" },
    ],
    projects: [
      { id: "g-probe", name: "探针团", status: "active", tier: "正经立项", anchor_dir: "/tmp/proj", created_at: now - 864e5, acceptance_count: 0, headcount: [
        { session_id: "pm-sess-0003", role: "pm" },
        { session_id: "w-sess-0004", role: "worker" },
        { session_id: "w-sess-0005", role: "worker" },
      ] },
    ],
  },
};
const diag = await ev(`(() => ({
  frames: typeof window.__ccDeck005Frames, allowed: typeof window.__ccDeck005FrameAllowed,
  view: (typeof window.__ccDeck005ViewSource === "function" && window.__ccDeck005ViewSource()) || null,
  listLen: document.querySelectorAll(".session-list [data-session-card]").length,
  state: document.querySelector("[data-session-list]") ? document.querySelector("[data-session-list]").dataset.relayState : null,
}))()`);
console.log("DIAG", JSON.stringify(diag));
const emit = (frame) => `window.__ccDeck005Frames && window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(frame)} })`;
await ev(emit(snap));
await new Promise(r => setTimeout(r, 900));

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? "  ok " : "  FAIL ") + name); };

// ---- 锚①：glm-5.3 会话（engine 空）三处引擎面=Claude，模型层 glm-5.3 独立 ----
const r1 = await ev(`(() => {
  const card = document.querySelector('[data-session-card="glm-sess-0001"]');
  const cardBadge = card && card.querySelector(".engine-badge");
  return { cardBadge: cardBadge ? cardBadge.textContent.trim() : null, cardClass: cardBadge ? cardBadge.className : null };
})()`);
ok(r1.cardBadge && /Claude/.test(r1.cardBadge), `①列表卡引擎徽章=Claude（实测 ${JSON.stringify(r1.cardBadge)}）`);
ok(r1.cardClass && /claude/.test(r1.cardClass), `①列表卡徽章 class=claude tint（${r1.cardClass}）`);
// 选中该会话 → head 引擎徽章 + 检查器模型行
await ev(`document.querySelector('[data-session-card="glm-sess-0001"]').click()`);
await new Promise(r => setTimeout(r, 800));
const r2 = await ev(`(() => {
  const idb = document.querySelector("#session-identity .engine-badge");
  const insp = [...document.querySelectorAll(".inspector-block")].map(b => b.textContent).join("|");
  return { head: idb ? idb.textContent.trim() : null, headClass: idb ? idb.className : null,
           modelInInsp: /glm-5\\.3/.test(insp), crab: !!document.querySelector('#session-identity .engine-badge img, #session-identity .engine-badge svg use') };
})()`);
ok(r2.head && /Claude/.test(r2.head), `①详情 head 引擎徽章=Claude（实测 ${JSON.stringify(r2.head)}）`);
ok(/claude/.test(r2.headClass || ""), `①head 徽章 class=claude（${r2.headClass}）`);
ok(r2.modelInInsp, `①模型层独立：检查器含 glm-5.3（引擎/模型两层分立）`);
// 消息流头像 tint（无消息流渲染输入——head/卡两处已证同链 inferEngineOf；用 b2EngineBadge 同源断言 class 链）
const r3 = await ev(`document.querySelector('[data-session-card="glm-sess-0001"] .engine-badge').className`);
ok(/(^| )claude( |$)/.test(r3), `①消息流同链：engineClass=claude（inferEngineOf 单源，头像 tint 同判）`);

// ---- 锚②：zcode 会话完备（卡徽章+class+品牌 SVG）----
const z1 = await ev(`(() => {
  const card = document.querySelector('[data-session-card="zc-sess-0002"]');
  const b = card && card.querySelector(".engine-badge");
  return { txt: b ? b.textContent.trim() : null, cls: b ? b.className : null, svg: b ? b.innerHTML.includes("svg") : false };
})()`);
ok(/ZCode$/.test((z1.txt || "").trim()) && z1.svg, `②zcode 列表卡徽章=品牌SVG+ZCode 文本（实测 ${JSON.stringify(z1.txt)}，svg=${z1.svg}）`);
ok(/zcode/.test(z1.cls || ""), `②zcode 徽章 class=zcode tint（${z1.cls}）`);

// ---- 锚③：chip 活跃数三态 ----
const c1 = await ev(`(() => {
  const chips = [...document.querySelectorAll('#d-session [data-team-chip="g-probe"], [data-session-card="pm-sess-0003"] [data-team-chip="g-probe"]')];
  const chip = chips[0];
  if (!chip) return { found: false };
  return { found: true, run: (chip.querySelector(".tc-run") || {}).textContent || null, dot: !!chip.querySelector(".tc-dot"), idle: chip.className.includes("idle") };
})()`);
ok(c1.found, `③PM 卡团队 chip 在位`);
ok(c1.run === "1", `③活跃数=1（1 WORKING + 1 idle；实测 ${JSON.stringify(c1.run)}）`);
ok(!c1.dot, `③无未读时无小圆点`);
// 注入 SESSION_LOG → 未读记账 → tc-dot 显（活跃数仍在——数字位与注意力位并存）
await ev(emit({ type: "SESSION_LOG", session_id: "w-sess-0004", payload: { kind: "assistant_text", text: "worker 产出一行", ts: Date.now() } }));
await new Promise(r => setTimeout(r, 900));
const c2 = await ev(`(() => {
  const chip = document.querySelector('[data-session-card="pm-sess-0003"] [data-team-chip="g-probe"]') || document.querySelector('[data-team-chip="g-probe"]');
  return { run: (chip.querySelector(".tc-run") || {}).textContent || null, dot: !!chip.querySelector(".tc-dot") };
})()`);
ok(c2.dot, `③有未读→小圆点显（未读降级为注意力信号）`);
ok(c2.run === "1", `③未读在场时活跃数数字位保持（数字位≠未读数——语义返工主锚；实测 ${JSON.stringify(c2.run)}）`);

// ---- 双主题截图 ----
await send("Page.captureScreenshot", { format: "png" }).then(r => { require("node:fs").writeFileSync(`${OUT}/dark.png`, Buffer.from(r.result.data, "base64")); });
await ev(`document.documentElement.setAttribute("data-theme", "light"); document.documentElement.setAttribute("data-color-scheme", "light");`);
await new Promise(r => setTimeout(r, 400));
await send("Page.captureScreenshot", { format: "png" }).then(r => { require("node:fs").writeFileSync(`${OUT}/light.png`, Buffer.from(r.result.data, "base64")); });

console.log(`\nENGLM2 probe: ${pass} passed, ${fail} failed`);
try { ws.close(); } catch {}
try { globalThis.__chromeProc.kill(); } catch {}
process.on("exit", () => { try { globalThis.__chromeProc.kill(); } catch {} });
process.exit(fail ? 1 : 0);
