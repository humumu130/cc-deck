// [W-TEAMDISSOLVE-R1] P2-F 补证四截图（本分支 worktree web-console 面——生产 8787 旧 UI
// 无 dissolved 概念不可拍，按任务书口径以本分支面+生产 PRE/POST 数据断言替代）。
// 产物 ~/.cc-deck/artifacts/teamdissolve-shots/r1/*.png
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIR = resolve(dirname(fileURLToPath(import.meta.url)) + "/../../web-console");
const OUT = "/Users/xdd/.cc-deck/artifacts/teamdissolve-shots/r1";
mkdirSync(OUT, { recursive: true });
const PORT = 9951 + Math.floor(Math.random() * 200);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/td-r1-cdp-" + Date.now(), "--window-size=1440,940", "file://" + DIR + "/index-005.html"], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; await wait(500); } }
if (!list) { console.error("CDP 未就绪"); process.exit(2); }
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seqn = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(res => { const id = ++seqn; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result?.value;
const safeEv = async (e, f = "SKIP") => { try { return await ev(e); } catch { return f; } };
const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${n}`); };
await send("Page.enable"); await send("Runtime.enable");
let ready = false;
for (let i = 0; i < 30 && !ready; i++) { ready = Boolean(await safeEv(`!!(window.__ccDeck005Frames && window.ccDeckTeam && document.querySelector('.rail-btn[data-domain="team"]'))`, false)); if (!ready) await wait(400); }
await wait(300);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok " + n); } else { fail++; console.log("  FAIL " + n); } };

// fixture：一组活跃团队（TD-前线组）+一组已解散（TD-观察哨，team.dissolved_at 在）
const now = Date.now();
const mkS = (id, title, ago) => ({ session_id: id, title, status: "DONE", engine: "claude", updated_at: now - ago, cwd: "/Users/u/dev/pcs" });
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, leader_session_id: "", sessions: [mkS("w1", "worker 甲", 3e5), mkS("w2", "worker 乙", 9e5)],
  projects: [
    { id: "pg-front", name: "TD-前线组", status: "active", tier: "正经立项", anchor_dir: "/Users/u/dev/pcs", headcount: [{ session_id: "w1", role: "worker" }], single_card: false, created_at: now - 30 * 86400000, updated_at: now - 3e5, team: { formed_at: now - 20 * 86400000 } },
    { id: "pg-watch", name: "TD-观察哨", status: "parked", tier: "轻立项", anchor_dir: "/Users/u/dev/watch", headcount: [{ session_id: "w2", role: "review" }], single_card: false, created_at: now - 40 * 86400000, updated_at: now - 6e5, team: { formed_at: now - 30 * 86400000, dissolved_at: now - 2 * 86400000 } },
  ], boards: [], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };
for (let i = 0; i < 4; i++) { await safeEv(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`); await safeEv(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`); await safeEv(`window.ccDeckTeam?.onEvent?.({}, { type: "SNAPSHOT", payload: JSON.parse(${JSON.stringify(JSON.stringify(snap.payload))}) })`); await wait(500); }
await safeEv(`document.querySelector('.rail-btn[data-domain="team"]').click()`);
await wait(900);

// ① 前主列表（活跃团队在场+已解散区可辨）
ok(Boolean(await safeEv(`document.body.textContent.includes("TD-前线组")`, false)), "① 前置：活跃团队在主列表");
await shot("01-before-main-list");
// ② 确认弹窗（输组名解锁态）
await safeEv(`document.querySelector('[data-team-dissolve]')?.click()`);
await wait(400);
const dlg = Boolean(await safeEv(`!!document.querySelector('.dissolve-dialog, [data-dissolve-input]')`, false));
ok(dlg, "② 解散确认弹窗打开");
await safeEv(`(() => { const i = document.querySelector('[data-dissolve-input]'); if (i) { i.value = "TD-前线组"; i.dispatchEvent(new Event("input", { bubbles: true })); } })()`);
await wait(250);
const unlocked = String(await safeEv(`document.querySelector('[data-dissolve-go]')?.disabled`, "NONE"));
ok(unlocked === "false", `② 输组名解锁 danger 钮（disabled=${unlocked}）`);
await shot("02-confirm-dialog");
// ③ 已解散区（观察哨入已解散区/折叠开合锚在）
const dissolvedZone = String(await safeEv(`document.body.textContent.includes("已解散") || document.body.textContent.includes("TD-观察哨")`, false));
ok(dissolvedZone === "true", "③ 已解散组可见（已解散区/标记）");
await shot("03-dissolved-zone");
// ④ 关弹窗+后主列表（取消路径——不真解散，fixture 静态）
await safeEv(`document.querySelector('[data-dissolve-cancel]')?.click()`);
await wait(300);
ok(String(await safeEv(`!!document.querySelector('#team-create-pop, [data-dissolve-input]')`, false)) === "false", "④ 弹窗关闭（取消路径净）");
await shot("04-after-main-list");

console.log(fail === 0 ? `\ntd-r1: ${pass} passed, 0 failed` : `\ntd-r1: ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
