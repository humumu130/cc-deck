// [W-DOCKFIX] 工作状态行方案 A 截图+断言探针（修前修后同针复用——MODE=before|after 命名输出；
// 断言仅 after 档生效，before 档录旧行为文本供回执对照）。骨架复用 probe-awaituser-shot。
// 直跑：cd relay && node scripts/probe-dockfix-shot.mjs [before|after]
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const MODE = (process.argv[2] === "before") ? "before" : "after";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9841 + Math.floor(Math.random() * 300);
const OUT = `/Users/xdd/.cc-deck/artifacts/dockfix-shots`;
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/dockfix-cdp-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
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
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);

// ---------- fixture：值守座（用户样本复刻：pm 238h/↓1.7m）+ 真跑（命令类 summary 复刻）+ WAITING + DONE ----------
const now = Date.now();
const mkS = (id, title, status, extra = {}) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - 3e4, started_at: now - 9e5, cwd: "/Users/xdd/dev/cc-deck", context_usage: 84000, context_limit: 200000, ...extra });
const sessions = [
  mkS("df-duty", "pm", "WORKING", { started_at: now - 859_000_000, turn_started_at: 0, action_summary: "", last_tool_use_at: now - 40 * 60e3, usage: { output_tokens: 1_700_000, input_tokens: 8e6 } }),
  mkS("df-run", "正经任务单", "WORKING", { started_at: now - 7200e3, turn_started_at: now - 1044e3, last_tool_use_at: now - 30e3, action_summary: "执行 CCR_ORG_DIR=/Users/xdd/dev/cc-deck ~/.cc-deck/bin/org status --all --json 输出聚合", usage: { output_tokens: 1_700_000, input_tokens: 8e6 } }),
  mkS("df-wait", "等批准的会话", "WAITING", { waiting_request: { request_id: "rq-9", tool_name: "Bash", input_summary: "rm -rf build/ && npm run build" }, waiting_started_at: now - 90e3 }),
  mkS("df-done", "收尾的会话", "DONE", { duration_ms: 245000, action_summary: "收割完成 test.102 出包" }),
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(800);

const dockOf = `(() => { const d = document.querySelector('#session-state-dock'); if (!d) return null; return { state: d.dataset.sessionState, duty: d.dataset.duty || "", live: d.hasAttribute("data-live-line"), op: (d.querySelector('[data-session-state-operation]')||{}).textContent || "", title: (d.querySelector('[data-session-state-operation]')||{}).title || "", elapsed: (d.querySelector('[data-session-state-elapsed]')||{}).textContent || "", tokHidden: (d.querySelector('[data-session-state-tokens]')||{}).hidden, sub: !!d.querySelector('[data-dock-sub]'), subText: (d.querySelector('[data-dock-sub]')||{}).textContent || "" }; })()`;
const clickCard = async (id) => { await ev(`document.querySelector('[data-session-card="${id}"]').click()`); await wait(600); return JSON.parse(await ev(`JSON.stringify(${dockOf})`)); };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ① 未选择（默认未点卡）
await shot(`${MODE}-0-unselected-dark`);
const unsel = JSON.parse(await ev(`JSON.stringify(${dockOf})`));
console.log(`  未选择: state=${unsel.state} op="${unsel.op}"`);
if (MODE === "after") { ok(unsel.state === "standby" && unsel.op === "未选择", "未选择=standby ◌ 静态中性（黄星灭迹）"); } else { ok(unsel.op === "未选择", "before: 未选择文案在"); }

// ② 值守座（用户空闲样本复刻）
const duty = await clickCard("df-duty");
await shot(`${MODE}-1-duty-dark`);
console.log(`  值守: state=${duty.state} duty=${duty.duty} op="${duty.op}" elapsed="${duty.elapsed}" sub=${duty.sub} subText="${duty.subText}"`);
if (MODE === "after") {
  ok(duty.state === "standby" && duty.duty === "1", "值守=standby+duty 半透明");
  ok(duty.op === "值守待命" && duty.elapsed === "" && !duty.sub, "值守文案=值守待命·不计时·无次行（会话名/238h/↓ 三病灭迹）");
} else {
  ok(duty.op === "pm" && /\(\d+h\d+m\d+s · ↓1\.7m\)/.test(duty.elapsed) && !duty.subText, `before: 值守行复刻用户样本「pm (238h…m…s · ↓1.7m)」`);
}

// ③ 真跑（命令类 summary）
const run = await clickCard("df-run");
await shot(`${MODE}-2-run-dark`);
console.log(`  真跑: state=${run.state} op="${run.op}" title="${run.title.slice(0, 50)}…" elapsed="${run.elapsed}" sub=${run.sub} tokHidden=${run.tokHidden}`);
if (MODE === "after") {
  ok(run.op === "org status 输出聚合", `语义摘要=「${run.op}」（剥 执行/env/路径→basename/flag，首三词）`);
  ok(run.title.includes("CCR_ORG_DIR=") && run.title.includes("org status --all --json"), "命令原文降级 title 全文在（debug 可达）");
  ok(/^\d+m\d+s$/.test(run.elapsed) && /^17m2[0-9]s$/.test(run.elapsed), `回合计时=${run.elapsed}（MmSSs 人类档）`);
  ok(!run.sub && run.tokHidden, "次行退役+tokens 段恒隐（head 胶囊唯一权威）");
} else {
  ok(run.op === "正经任务单" && run.subText.startsWith("⚙ Running 执行 CCR_ORG_DIR=") && /\d+s$/.test(run.subText) && /\(\d+h\d+m\d+s · ↓1\.7m\)/.test(run.elapsed), "before: 运行行复刻用户样本（双时长/env 命令/原始秒三病同屏）");
}

// ④ WAITING
const wt = await clickCard("df-wait");
await shot(`${MODE}-3-wait-dark`);
console.log(`  等待: state=${wt.state} op="${wt.op}" elapsed="${wt.elapsed}"`);
if (MODE === "after") { ok(wt.op === "等你批准 Bash" && wt.elapsed === "1m" && !!wt.title, "WAITING=等你批准 Bash · 等待计时（明细走 title）"); } else { ok(/Bash · /.test(wt.op), "before: WAITING=工具名 · 摘要"); }

// ⑤ DONE
const dn = await clickCard("df-done");
await shot(`${MODE}-4-done-dark`);
console.log(`  完成: state=${dn.state} op="${dn.op}" elapsed="${dn.elapsed}"`);
if (MODE === "after") { ok(dn.op === "收割完成 test.102 出包" && dn.elapsed === "4m", "DONE=语义摘要+时长（8s 淡出语义在 watch）"); } else { ok(dn.op.includes("收割完成"), "before: DONE 摘要直出"); }

// ⑥ 亮色主题两主态
await ev(`document.querySelector('#session-state-dock') && document.querySelector('[data-theme-toggle]').click()`);
await wait(500);
let r2 = await clickCard("df-run"); await shot(`${MODE}-5-run-light`);
let d2 = await clickCard("df-duty"); await shot(`${MODE}-6-duty-light`);
console.log(`  亮色: run op="${r2.op}" elapsed="${r2.elapsed}" / duty op="${d2.op}" duty=${d2.duty}`);
await ev(`document.querySelector('[data-theme-toggle]').click()`); await wait(300);

ok(consoleErrs.length === 0, `console 零错（${consoleErrs.length} 条${consoleErrs.length ? "：" + consoleErrs.slice(0, 2).join(" | ") : ""}）`);
console.log(`\ndockfix probe [${MODE}]：${pass} ok / ${fail} FAIL`);
writeFileSync(`/tmp/dockfix-probe-${MODE}.json`, JSON.stringify({ unsel, duty, run, wt, dn, r2, d2 }, null, 1));
globalThis.__p.kill(); process.exit(fail ? 1 : 0);
