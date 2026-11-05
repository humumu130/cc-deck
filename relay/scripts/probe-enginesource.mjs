// W-ENGINESOURCE 探针（1105 用户实锤）：新建弹「创建到」切源，引擎目录随源切换——
// local 视角下选 cloud，下拉必须显示云源 engine_catalog（远程 Mac 实装 3），不得沿用
// 本机探测（全「未安装」串台形态）；目录不可得时占位「获取中/不可用」绝不冒充。
// 手法：__ccDeck005IngestSnapshot 双源注入（本机=仅 claude ready；云=claude/codex/codebuddy
// ready=PM 核实的远程 Mac 真相）→ 开新建弹 → 断言各源下拉 → 截图。
// 另含 relay 侧静态锁：codebuddy preflight 命令与 npm bin 名一致性（顺带②）。
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WS = require("ws");
const OUT = "/tmp/w-enginesource";
mkdirSync(OUT, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9460 + Math.floor(Math.random() * 30);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-port=" + PORT, "--user-data-dir=/tmp/enginesource-" + Date.now(), "--window-size=1440,940", "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 20 && !list; i++) { await wait(600); try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch {} }
const ws = new WS(list.find(t => t.type === "page").webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`📸 ${name}`); };
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///private/tmp/cc-deck-w-enginesource/web-console/index-005.html" });
await wait(2000);

let pass = 0, fail = 0;
const assert = (c, name) => { if (c) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

// 双源注入：本机=仅 claude（公司电脑实锤形态）；云=3 ready（远程 Mac PM 核实真相）
const now = Date.now();
const mkCatalog = (ready) => [
  { id: "claude", label: "Claude", state: "ready", preflight: { state: "pass", reason: "" }, models: ["m1"] },
  { id: "codex", label: "Codex", state: ready.includes("codex") ? "ready" : "unavailable", preflight: ready.includes("codex") ? { state: "pass", reason: "" } : { state: "fail", reason: "CLI 未在当前 PATH 探测到" }, models: [] },
  { id: "trae", label: "Trae", state: "unavailable", preflight: { state: "fail", reason: "CLI 未在当前 PATH 探测到" }, models: [] },
  { id: "qwen-code", label: "Qwen Code", state: "unavailable", preflight: { state: "fail", reason: "CLI 未在当前 PATH 探测到" }, models: [] },
  { id: "codebuddy", label: "Codebuddy", state: ready.includes("codebuddy") ? "ready" : "unavailable", preflight: ready.includes("codebuddy") ? { state: "pass", reason: "" } : { state: "fail", reason: "CLI 未在当前 PATH 探测到" }, models: [] },
];
const lanSnap = { type: "SNAPSHOT", payload: { relay_name: "公司电脑", token_valid: true, homedir: "/Users/office", sessions: [], projects: [], acceptances: [], notifications: [], receipts: [], source_capabilities: { engine_catalog: mkCatalog([]) } } };
const cloudSnap = { type: "SNAPSHOT", payload: { relay_name: "远程Mac", token_valid: true, homedir: "/Users/xdd", sessions: [], projects: [], acceptances: [], notifications: [], receipts: [], source_capabilities: { engine_catalog: mkCatalog(["codex", "codebuddy"]) } } };
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", state: "open" })`);
await ev(`window.__ccDeck005IngestSnapshot("lan", ${JSON.stringify(lanSnap.payload)})`);
await ev(`window.__ccDeck005IngestSnapshot("cloud", ${JSON.stringify(cloudSnap.payload)})`);
// 探针注入连接态：cloudCtx.status/paired 由真实云 ws 连接驱动，快照注入不动它——
// 「创建到」select 渲染条件（cloudPaired && cloudStatus==="online"）在 headless 无云
// 连接下恒 false。包装 SourceState 口（产品消费面同一函数，IngestSnapshot 同族「页面内
// window 级调用者本具全权」先例）——目录数据本身仍走 lastSnapshotPayload 双槽真值。
await ev(`(() => { const orig = window.__ccDeck005SourceState; window.__ccDeck005SourceState = () => ({ ...orig(), cloudPaired: true, cloudStatus: "online", cloudRelayName: "远程Mac" }); return "patched"; })()`);
await wait(600);

// 前置：SourceState 云目录口在（lastSnapshotPayload 双槽直读）
const stProbe = await ev(`(() => { const st = window.__ccDeck005SourceState(); return { cat: !!(st.cloudEngineCatalog && st.cloudEngineCatalog.length), readyIds: (st.cloudEngineCatalog||[]).filter(e=>e.state==="ready").map(e=>e.id).join(",") }; })()`);
assert(stProbe.cat === true && stProbe.readyIds === "claude,codex,codebuddy", `前置：云目录只读口在（ready=${stProbe.readyIds}——远程 Mac 真相 3）`);

// 开新建弹（真实入口：rail 会话域 → queue-head「＋」——#75 绑定点）
await ev(`document.querySelector('.rail-btn[data-domain="session"]')?.click()`);
await wait(300);
await ev(`document.querySelector('aside.queue .queue-head button.icon-btn')?.click()`);
await wait(500);
const popOpen = await ev(`!!document.getElementById("b2-create-pop")`);
assert(popOpen === true, "新建弹打开（会话域「＋」真实入口）");

// A. 本机源（默认 local）：仅 claude 可用（公司电脑串台形态的正确基线）
const localMenu = await ev(`(() => { const t = document.querySelector('#b2-create-pop [data-engine-trigger]'); if (t) t.click(); return "clicked"; })()`);
await wait(300);
const localRows = await ev(`(() => { const m = document.getElementById("b2-engine-menu"); if (!m) return null; const heads = [...m.querySelectorAll(".source-menu-head")].map(h => h.textContent); const na = [...m.querySelectorAll(".source-option[aria-disabled='true'] small")].map(x => x.textContent); return { heads: heads.join("|"), naCount: na.length, naSample: (na[1] || "").slice(0, 50) }; })()`);
assert(!!localRows && /可用 · 1/.test(localRows.heads) && /不可用 · 4/.test(localRows.heads), `A 本机源：可用1/不可用4（heads=${localRows && localRows.heads}）`);
const naNpm = await ev(`(() => { const m = document.getElementById("b2-engine-menu"); if (!m) return ""; const hit = [...m.querySelectorAll(".source-option[aria-disabled='true'] small")].map(x => x.textContent).find(t => t.includes("npm i -g")); return hit || ""; })()`);
assert(naNpm.includes("npm i -g @openai/codex"), `A2 本机 unavailable 行带安装指引（顺带①——${naNpm}）`);

// B. 切「创建到」→ 远程：下拉随源变（可用 3——用户实锤的期望态）
await ev(`(() => { const m = document.getElementById("b2-engine-menu"); if (m) m.remove(); const sel = document.querySelector('#b2-create-pop [data-create-field="source"]'); if (!sel) return "NO-SEL"; sel.value = "cloud"; sel.dispatchEvent(new Event("change", { bubbles: true })); return "switched"; })()`);
await wait(400);
const cloudMenu = await ev(`(() => { const t = document.querySelector('#b2-create-pop [data-engine-trigger]'); if (t) t.click(); return "ok"; })()`);
await wait(300);
const cloudRows = await ev(`(() => { const m = document.getElementById("b2-engine-menu"); if (!m) return null; const heads = [...m.querySelectorAll(".source-menu-head")].map(h => h.textContent); const readyNames = [...m.querySelectorAll(".source-option:not([aria-disabled]) strong")].map(x => x.textContent); return { heads: heads.join("|"), ready: readyNames.join(",") }; })()`);
assert(!!cloudRows && /可用 · 3/.test(cloudRows.heads), `B 切远程源：可用 3（heads=${cloudRows && cloudRows.heads}——Codex/CodeBuddy 不再误标未安装）`);
assert(!!cloudRows && /不可用 · 2/.test(cloudRows.heads), `B2 远程源：Trae/Qwen 仍不可用 2（真相口径，不反向美化）`);
await shot("01-cloud-source-3ready");

// C. 切回本机：复原（联动对称）
await ev(`(() => { const m = document.getElementById("b2-engine-menu"); if (m) m.remove(); const sel = document.querySelector('#b2-create-pop [data-create-field="source"]'); sel.value = "local"; sel.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
await wait(300);
const backRows = await ev(`(() => { const t = document.querySelector('#b2-create-pop [data-engine-trigger]'); if (t) t.click(); return 1; })()`);
await wait(250);
const backHeads = await ev(`(() => { const m = document.getElementById("b2-engine-menu"); return m ? [...m.querySelectorAll(".source-menu-head")].map(h => h.textContent).join("|") : null; })()`);
assert(!!backHeads && /可用 · 1/.test(backHeads) && /不可用 · 4/.test(backHeads), `C 切回本机复原（heads=${backHeads}）`);
await shot("02-local-source-restored");

// D. 占位态：云目录不可得（清云快照目录）→胶囊「获取中」而非本机冒充
// D：模拟云在线但目录不可得（旧 relay/首帧在途）——包装 SourceState 删目录键后**重取
// select 节点**再触发 change（B 步重绘后旧引用已脱离 DOM，dispatch 不冒泡——实测坑）
await ev(`(() => { const m = document.getElementById("b2-engine-menu"); if (m) m.remove(); const orig = window.__ccDeck005SourceState; window.__ccDeck005SourceState = () => { const s = orig(); delete s.cloudEngineCatalog; return s; }; const sel = document.querySelector('#b2-create-pop [data-create-field="source"]'); if (!sel) return "NO-SEL"; sel.value = "cloud"; sel.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; })()`);
await wait(400);
const placeholder = await ev(`(() => { const meta = document.querySelector('#b2-create-pop .engine-picker .ep-meta'); return meta ? meta.textContent : null; })()`);
assert(!!placeholder && /获取中|不可用/.test(placeholder), `D 云目录不可得=占位文案（${placeholder}——绝不沿用本机数据冒充）`);
await shot("03-placeholder-unknown");

// E. relay 静态锁（顺带②）：codebuddy preflight 命令=npm bin 名 codebuddy-code（装了却
// 探测不到的哑案例防线——preflight 与 spawn 同名单口）
const sm = readFileSync(new URL("../src/agent-codebuddy.ts", import.meta.url), "utf-8");
const cat = readFileSync(new URL("../src/engine-catalog.ts", import.meta.url), "utf-8");
// spawn 面（:77）与 preflight 面（:124）两处命令链同名单口（CCR_CODEBUDDY_PATH ?? "codebuddy-code"）
const spawnOk = sm.includes('command: opts.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code"');
const preflightOk = sm.includes('return preflightEngine({ command: config?.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code"');
assert(spawnOk, "E codebuddy spawn 命令链=codebuddy-code（agent-codebuddy.ts 构造器单口）");
assert(preflightOk, "E2 preflight 命令链同名单口（探测与 spawn 同名——装了却探测不到的哑案例防线）");
assert(!/command[^\n]{0,40}"codebuddy"(?!-)/.test(sm), "E3 无裸 \"codebuddy\" 命令串（bin 名混淆源——label/profileId 的 codebuddy 非命令合法保留）");

console.log(`\nenginesource 探针：${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
process.exit(fail ? 1 : 0);
