// [W-PROJTEAM1 期一]（t-27bae93c，1109 拍板「项目⊇团队」）探针：
//   P1 项目卡团队区两态（有团队=编制摘要+去团队跳转 / 无团队=组建团队入口）
//   P2 两步入口（主钮「立为项目（并组队）」+副钮「仅立项目」）
//   P3 预填链保持（主钮→弹窗预勾全桶成员+锚=桶目录——AGGBUG 源判定零影响面）
//   P4 挂靠预填（无团队项目卡组建团队→gid 预填走 create+gid 挂靠分支）
//   P5 团队域 head 所属项目胶囊（项目：{name} · {锚尾段}）
// 产物：~/.cc-deck/artifacts/projteam1-shots/*.png
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL0 = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname);
const OUT = "/Users/xdd/.cc-deck/artifacts/projteam1-shots";
mkdirSync(OUT, { recursive: true });
const PORT = 9950 + Math.floor(Math.random() * 200);
globalThis.__p = spawn0();
function spawn0() { const { spawn } = require("node:child_process"); return spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/pt1-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" }); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2500);
let list = null;
for (let i = 0; i < 90 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; await wait(500); } } // 冷启窗 45s（本机多 worktree 并行时 Chrome 偶超 15s——扩窗非缩检）
if (!list) { console.error("CDP 45s 未就绪"); process.exit(2); }
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
const waitFor = async (expr, tries = 40, ms = 500) => { for (let i = 0; i < tries; i++) { if (await ev(expr)) return true; await wait(ms); } return false; };
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

// fixture：两项目组（有团队/仅立项目）+未立项桶 3 会话
const now = Date.now(), MIN = 60_000;
const RB = "/Users/u/work/redbook", SOLO = "/Users/u/work/solo-proj", PCS = "/Users/u/work/pcs-order";
const mkS = (id, title, cwd, st, ago) => ({ session_id: id, title, cwd, status: st, engine: "claude", updated_at: now - ago, context: { used: 40000, limit: 200000 } });
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, leader_session_id: "",
  sessions: [
    mkS("r-1", "红书封面图生成", RB, "WORKING", 3 * MIN),
    mkS("r-2", "红书文案打磨", RB, "DONE", 30 * MIN),
    mkS("s-1", "独立项目笔记整理", SOLO, "DONE", 15 * MIN),
    mkS("p-1", "PCS 工单 201 处理", PCS, "DONE", 40 * MIN),
    mkS("p-2", "PCS 工单 202 修复", PCS, "DONE", 25 * MIN),
    mkS("p-3", "查 PCS 库表口径", PCS, "DONE", 10 * MIN),
  ],
  projects: [
    { id: "pg-teamdemo", name: "红书推广", anchor_dir: RB, status: "active", tier: "轻立项", single_card: false, headcount: [{ session_id: "r-1", role: "worker" }, { session_id: "r-2", role: "pm" }], created_at: now - 90 * MIN, updated_at: now - 5 * MIN },
    { id: "pg-solo", name: "独立项目", anchor_dir: SOLO, status: "active", tier: "轻立项", single_card: true, headcount: [], team: { formed_at: 0 }, created_at: now - 60 * MIN, updated_at: now - 20 * MIN },
  ] } };
for (let i = 0; i < 60 && !(await ev(`!!window.__ccDeck005Frames && document.readyState === "complete"`)); i++) await wait(300);
await wait(600);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
const emitSnap = `window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`;
await ev(emitSnap);
// 冷启竞态加固（aggregatev2 A1 同族：早发=订阅未挂帧即丢）：验证落地（B4 桥吃满 6 会话），
// 未落地幂等重发（SNAPSHOT 重放语义——丢帧窗口最多一次重发即可闭环）
for (let i = 0; i < 20 && !(await ev(`(window.__ccDeck005B4 && window.__ccDeck005B4.sessions ? window.__ccDeck005B4.sessions.size : 0) >= 6`)); i++) { await wait(500); if (i === 10) await ev(emitSnap); }
await wait(1200);
await ev(`document.querySelector('.rail-btn[data-domain="project"]').click()`);
await wait(900);
await ev(`document.querySelector('[data-project-unfiled-toggle]')?.click()`);
await waitFor(`!!document.querySelector('[data-project-key="g:pg-teamdemo"] .pc3-team-sum') && !!document.querySelector("[data-agg-create]")`, 40, 500);

console.log("P1 项目卡团队区两态:");
const teamCard = `document.querySelector('[data-project-key="g:pg-teamdemo"]')`;
const soloCard = `document.querySelector('[data-project-key="g:pg-solo"]')`;
ok((await ev(`(${teamCard}?.querySelector(".pc3-team-sum")||{textContent:""}).textContent`)).includes("团队 2 席"), "有团队卡：编制摘要「团队 2 席」在");
ok((await ev(`(${teamCard}?.querySelector(".pc3-team-sum")||{textContent:""}).textContent`)).includes("1 在跑"), "有团队卡：在跑数随摘要（1 在跑——r-1 WORKING）");
ok(await ev(`!!${teamCard}?.querySelector("[data-team-go='pg-teamdemo']")`) === true, "有团队卡：「去团队 →」跳转钮在");
ok((await ev(`(${soloCard}?.querySelector(".pc3-team-sum")||{textContent:""}).textContent`)).includes("暂无团队"), "仅立项目卡：「暂无团队（项目可独立）」在");
ok(await ev(`!!${soloCard}?.querySelector("[data-team-form]")`) === true, "仅立项目卡：「组建团队 →」入口在");
await shot("01-projpage-teamrows-dark");

console.log("P2 两步入口（聚合推荐行）:");
ok((await ev(`(document.querySelector("[data-agg-create]")||{textContent:""}).textContent`)).includes("立为项目（并组队）"), "主钮文案=「立为项目（并组队）→」（原「聚合为团队 →」退役）");
ok(await ev(`!!document.querySelector("[data-agg-solo]")`) === true, "副钮「仅立项目」在（轻立项基座可无团队）");

console.log("P3 预填链保持（主钮→弹窗）:");
await ev(`document.querySelector("[data-agg-create]")?.click()`);
await wait(600);
ok(await ev(`!!document.getElementById("team-create-pop")`) === true, "弹窗开");
ok(await ev(`document.querySelectorAll("#team-create-pop [data-team-member]:checked").length`) === 3, "全桶 3 成员预勾（预填链行为保持——AGGBUG 源判定零影响）");
ok(await ev(`(document.querySelector('#team-create-pop [data-team-field="anchor"]')||{value:""}).value`) === PCS, "主锚=桶目录");
ok(await ev(`!document.getElementById("team-create-pop")?.dataset.teamGid`) === true, "桶入口不带 gid（新建项目+团队原链路）");
await ev(`document.querySelector("[data-team-close]")?.click()`); await wait(300);

console.log("P4 挂靠预填（仅立项目卡组建团队）:");
await ev(`${soloCard}?.querySelector("[data-team-form]")?.click()`);
await wait(600);
ok(await ev(`document.getElementById("team-create-pop")?.dataset.teamGid === "pg-solo"`) === true, "gid 预填在（提交走 create+gid 挂靠分支=零一锚一组冲突）");
ok(await ev(`(document.querySelector('#team-create-pop [data-team-field="anchor"]')||{value:""}).value`) === SOLO, "锚=项目主锚");
ok((await ev(`(document.querySelector("[data-team-origin-note]")||{textContent:""}).textContent`)).includes("来自项目页"), "origin 溯源=「来自项目页 · 为此项目组建团队」");
await ev(`document.querySelector("[data-team-close]")?.click()`); await wait(300);
await ev(`document.documentElement.setAttribute('data-theme', 'light')`); await wait(450);
await shot("02-projpage-light");
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await wait(300);

console.log("P5 团队域 head 所属项目胶囊:");
await ev(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
// 团队域懒挂载+onEvent 视角门：先等域挂载（ccDeckTeam 在），再幂等重喂快照，等侧栏
// 团队卡真渲染（snapshot 落地实证）才 select——最后等胶囊（全链轮询零裸 wait）
await waitFor(`!!window.ccDeckTeam`, 30, 500);
await wait(300);
// 团队域喂入=transport 锚定（总线单向 fan-out 不回流——probe-teampolish 先例）：
// ccDeckTeam.onEvent 直喂 SNAPSHOT（含 projects 字段——团队侧栏/编制/meta 的数据源）
await ev(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: JSON.parse(${JSON.stringify(JSON.stringify(snap.payload))}) })`);
await waitFor(`document.querySelectorAll("[data-team-project]").length >= 2`, 30, 500);
await ev(`window.ccDeckTeam?.select?.("pg-teamdemo")`);
await waitFor(`!!document.querySelector("[data-team-meta] .head-proj-pill")`, 30, 500);
const metaHtml = await ev(`(document.querySelector("[data-team-meta]")||{innerHTML:""}).innerHTML`);
ok(metaHtml.includes("head-proj-pill") && metaHtml.includes("项目：红书推广") && metaHtml.includes("redbook"), `项目胶囊在（项目：红书推广 · redbook——实 ${metaHtml.slice(0, 120)}）`);
ok(metaHtml.includes("编制 2 席"), "既有 meta 段零回归（编制段仍在）");
await shot("03-teamhead-pill-dark");

console.log(`\nprojteam1 probe: ${pass} ok / ${fail} FAIL`);
try { globalThis.__p.kill(); } catch {}
process.exit(fail ? 1 : 0);
