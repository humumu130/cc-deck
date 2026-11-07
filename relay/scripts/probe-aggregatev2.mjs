// [W-AGGREGATE-V2] 跨目录簇归一探针（probe-aggregatev1 骨架复用——PCS 多 clone 场景）。
// 断言组：
//   A 簇卡：两目录同 origin（dir_origins 夹具）→ 最大桶挂归一卡+证据行三证据
//     （同目录×N+同 origin×M+共享词）+clone 目录数披露
//   B 降级：无 origin 目录（非 git 形态）→ V1 同目录卡原样（单目录证据行）；无信号桶不炸
//   C 簇预填：点主钮 → 建团弹窗五字段+附锚注（data-team-anchor-dirs）+全簇成员预勾
//   D 簇忽略：✗ → 条消失（o:origin 指纹——localStorage 账）
// 产物：~/.cc-deck/artifacts/aggregatev2-shots/<tag>/*.png
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "after";
const URL0 = process.argv[3] || "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
const OUT = `/Users/xdd/.cc-deck/artifacts/aggregatev2-shots/${TAG}`;
const PORT = 9841 + Math.floor(Math.random() * 300);
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/agg2-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
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

// ---------- fixture：两 clone 目录同 origin（主桶 4 会话+附桶 2 会话）+无信号对照 ----------
const now = Date.now(), MIN = 60_000;
const mkS = (id, title, cwd, st, ago, ext = false) => ({ session_id: id, title, cwd, status: st, engine: "claude", updated_at: now - ago, external: ext, context: { used: 40000, limit: 200000 } });
const PCS_A = "/Users/u/work/pcs-order", PCS_B = "/Users/u/work/pcs-order-b", NOGIT = "/Users/u/work/legacy-docs";
const ORIGIN = "github.com/acme/pcs";
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, leader_session_id: "",
  dir_origins: { [PCS_A]: ORIGIN, [PCS_B]: ORIGIN }, // 刀2 簇信号（NOGIT 无键=非 git 形态）
  sessions: [
  mkS("a-1", "PCS 工单 1024 处理", PCS_A, "DONE", 40 * MIN),
  mkS("a-2", "PCS 工单 1025 修复", PCS_A, "DONE", 25 * MIN),
  mkS("a-3", "查 PCS 库表口径", PCS_A, "DONE", 10 * MIN),
  mkS("a-4", "PCS 工单补数", PCS_A, "DONE", 5 * MIN, true),
  mkS("b-1", "PCS 工单 1030 对账", PCS_B, "DONE", 35 * MIN),
  mkS("b-2", "PCS 反馈单梳理", PCS_B, "DONE", 12 * MIN),
  mkS("n-1", "旧文档整理 1", NOGIT, "DONE", 50 * MIN),
  mkS("n-2", "旧文档整理 2", NOGIT, "DONE", 45 * MIN),
  mkS("n-3", "旧文档归档", NOGIT, "DONE", 20 * MIN),
] } };
// 冷启加固：等帧总线+页面 complete 再 emit（早发=订阅未挂帧即丢——A1 间歇红根）
for (let i = 0; i < 40 && !(await ev(`!!window.__ccDeck005Frames && document.readyState === "complete"`)); i++) await wait(300);
await wait(600);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
// fresh user-data-dir 每轮新档（localStorage 天然零残留——勿 reload 清账：re-emit 竞态会丢快照）
await wait(1200);
// 域激活（V1 探针同款：project 域懒渲染——不点域钮 queue 不渲）+展开未立项折叠组
await ev(`localStorage.clear()`);
await ev(`document.querySelector('.rail-btn[data-domain="project"]').click()`);
await wait(900);
await ev(`document.querySelector('[data-project-unfiled-toggle]')?.click()`);
await wait(600);
// 冷启加固：等桥就绪再取断言（页面脚本晚载=首 emit 落空的窗口）
for (let i = 0; i < 20 && !(await ev(`!!document.querySelector("[data-agg-hint], .queue-card")`)); i++) await wait(300);
await wait(400);

// ---------- A 簇卡 ----------
console.log("A 簇卡（两目录同 origin）：");
const evA = await ev(`(document.querySelector('[data-agg-hint="${PCS_A}"] .agg-evidence')||{textContent:""}).textContent`);
ok(evA.includes("同目录 ×4") && evA.includes("同 origin ×6") && evA.includes("2 个 clone 目录"), `A1 主桶挂归一卡+三证据（实「${evA}」）`);
ok(await ev(`!!document.querySelector('[data-agg-hint="${PCS_A}"] [data-agg-create]')`) === true, "A2 簇卡主钮在");
ok(await ev(`!document.querySelector('[data-agg-hint="${PCS_B}"]')`) === true, "A3 附桶不重复挂卡（簇单卡挂最大桶）");
ok(await ev(`(document.querySelector('[data-agg-hint="${PCS_A}"] [data-agg-ignore]')||{dataset:{}}).dataset.aggIgnore === "o:${ORIGIN}"`) === true, "A4 簇忽略指纹=o:origin（与目录指纹分轨）");

// ---------- B 降级 ----------
console.log("B 无信号降级（V1 同目录路径）：");
const evB = await ev(`(document.querySelector('[data-agg-hint="${NOGIT}"] .agg-evidence')||{textContent:""}).textContent`);
ok(evB.startsWith("同目录 ×3") && !evB.includes("origin"), `B1 无 origin 目录=V1 同目录卡原样（实「${evB}」）`);
ok(await ev(`document.querySelectorAll("[data-agg-hint]").length === 2`) === true, "B2 全页恰 2 条（簇卡+V1 降级卡——无信号不炸）");

// ---------- C 簇预填 ----------
console.log("C 簇预填：");
await ev(`document.querySelector('[data-agg-hint="${PCS_A}"] [data-agg-create]')?.click()`);
await wait(600);
ok(await ev(`!!document.getElementById("team-create-pop")`) === true, "C1 建团弹窗开");
const dirNote = await ev(`(document.querySelector("[data-team-anchor-dirs]")||{textContent:""}).textContent`);
ok(dirNote.includes("附锚") && dirNote.includes(PCS_B), `C2 附锚注含附锚目录（实「${dirNote.slice(0, 60)}」）`);
const checked = await ev(`document.querySelectorAll("#team-create-pop [data-team-member]:checked").length`);
ok(checked === 6, `C3 全簇成员预勾（主桶 4+附桶 2=${checked}）`);
ok(await ev(`(document.querySelector('#team-create-pop [data-team-field="anchor"]')||{value:""}).value === "${PCS_A}"`) === true, "C4 主锚=锚字段（主锚恒首）");
await shot("01-cluster-prefill");
await ev(`document.querySelector("[data-team-close]")?.click()`); await wait(300);

// ---------- D 簇忽略 ----------
console.log("D 簇忽略：");
await ev(`document.querySelector('[data-agg-hint="${PCS_A}"] [data-agg-ignore]')?.click()`);
await wait(500);
ok(await ev(`!document.querySelector('[data-agg-hint="${PCS_A}"]')`) === true, "D1 ✗ 后簇卡消失");
ok(await ev(`!!localStorage.getItem("cc-deck-005-agg-prefs") && localStorage.getItem("cc-deck-005-agg-prefs").includes("o:${ORIGIN}")`) === true, "D2 冷却账落 o:origin 指纹（24h 不再推——语义沿用）");
ok(await ev(`!!document.querySelector('[data-agg-hint="${NOGIT}"]')`) === true, "D3 V1 降级卡不受簇忽略影响（指纹分轨）");
await shot("02-after-ignore");

console.log(`\naggregatev2 probe: ${pass} ok / ${fail} FAIL`);
try { globalThis.__p.kill(); } catch {}
process.exit(fail ? 1 : 0);
