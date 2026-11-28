// [DEV-50·W-DISPATCHFIX 验收③] liveness 端上消费截图探针：三值卡面 + 心跳入账 + 陈标清算。
// 复用 probe-statusvocab-shot 骨架：Chrome headless + CDP + __ccDeck005Frames.emit 注入。
// 断言走 computed style（dot 底色/类名/蒙层透明度/活信号压制）——数字证据随截图落盘。
// 词表依据：docs/design/status-vocabulary.md §七（alive=零覆核 / between-turns=S2 灰呼吸
// 仅 WORKING / dead=S6 灰实点不呼吸+置灰，waiting 等你 chip 不受蒙层影响）。
// 直跑：cd relay && node probes/probe-liveness-shot.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9741 + Math.floor(Math.random() * 400), TAG = "liveness";
const OUT = `/tmp/dev50-shots/${TAG}`;
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/dev50-cdp-" + Date.now(), `--window-size=1440,940`, "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// 端口就绪轮询（至多 ~15s）：夜间机群高载时 Chrome 开调试口可超固定窗（同 statusvocab 探针教训）
let list;
for (let i = 0; i < 30; i++) {
  await wait(500);
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; } catch { /* 端口未就绪，续轮 */ }
}
if (!list) { globalThis.__p.kill("SIGKILL"); console.error(`Chrome 调试口 ${PORT} 15s 未就绪`); process.exit(1); }
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);

// ---------- fixture：三值×两态 + 旧 relay 对照（词表 §七映射矩阵） ----------
const now = Date.now();
const mkS = (id, title, status, extra = {}) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - 3e5, started_at: now - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000, ...extra });
const wr = { request_id: "rq-lv", tool_name: "AskUserQuestion", input_summary: "选发布通道", suggestions: [], questions: [{ header: "通道", question: "test 还是 snap？", options: [{ label: "test" }, { label: "snap" }] }] };
const sessions = [
  mkS("lv-work-alive", "运行中×alive（零覆核）", "WORKING", { liveness: "alive", last_tool_use_at: now - 20e3 }),
  mkS("lv-work-bt", "运行中×between-turns（S2 灰呼吸）", "WORKING", { liveness: "between-turns", last_tool_use_at: now - 60e3 }),
  mkS("lv-work-dead", "运行中×dead（S6 停摆置灰）", "WORKING", { liveness: "dead", last_tool_use_at: now - 60e3, updated_at: now - 8e3 }),
  mkS("lv-wait-alive", "等你×alive（S3 橙环）", "WAITING", { liveness: "alive", waiting_request: wr, waiting_started_at: now - 8e5 }),
  mkS("lv-wait-dead", "等你×dead（S6+chip 保留）", "WAITING", { liveness: "dead", waiting_request: wr, waiting_started_at: now - 8e5 }),
  mkS("lv-work-old", "运行中·旧 relay 无键（零变化）", "WORKING", { last_tool_use_at: now - 20e3 }),
];
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);

// ---------- ① 三值卡面（列表整屏） ----------
const listClip = await ev(`(() => { const r = document.querySelector('#d-session .queue').getBoundingClientRect(); return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, 470), height: Math.min(700, 940), scale: 1 }; })()`);
await shot("01-list-three-values", listClip);
const cardInfo = await ev(`(() => {
  const out = {};
  for (const c of document.querySelectorAll('#d-session [data-session-card]')) {
    const id = c.getAttribute('data-session-card');
    const dot = c.querySelector('.srow-ava .status-dot');
    const cs = getComputedStyle(dot);
    const ccs = getComputedStyle(c);
    const sec = c.querySelector('.srow-sec');
    out[id] = {
      cls: dot.className.replace('status-dot ', ''),
      bg: cs.backgroundColor,
      anim: cs.animationName,
      afterAnim: getComputedStyle(dot, '::after').animationName,
      cardOpacity: ccs.opacity,
      stalledCls: c.classList.contains('stalled'),
      secShown: sec ? getComputedStyle(sec).display !== 'none' : null,
      awaituChip: !!c.querySelector('.tag.awaitu-flag'),
    };
  }
  return JSON.stringify(out);
})()`);
console.log("  断言①六卡灯 computed（cls/bg/anim/cardOpacity/sec/awaitu）：");
const cards = JSON.parse(cardInfo);
for (const [id, v] of Object.entries(cards)) console.log(`    ${id}: cls=${v.cls} bg=${v.bg} anim=${v.anim} op=${v.cardOpacity} sec=${v.secShown} chip=${v.awaituChip}`);

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };
// alive=零覆核：黄实点呼吸（st-working 系）+ 无蒙层
ok(cards["lv-work-alive"]?.cls === "working" && cards["lv-work-alive"]?.afterAnim === "st-glow-pulse" && !cards["lv-work-alive"]?.stalledCls, "①a working×alive 零覆核（working 黄呼吸=::after st-glow-pulse，无 stalled）");
// between-turns：working-standby 灰呼吸（S2），无蒙层、走秒保留（机器在）
ok(cards["lv-work-bt"]?.cls === "working-standby" && !cards["lv-work-bt"]?.stalledCls && cards["lv-work-bt"]?.secShown !== false, "①b working×between-turns 降 S2 灰呼吸（standby 形，不走蒙层不灭走秒）");
// dead：liveness-dead 灰实点+零动画+卡面置灰+走秒压制
ok(cards["lv-work-dead"]?.cls === "liveness-dead" && cards["lv-work-dead"]?.afterAnim === "none" && cards["lv-work-dead"]?.stalledCls && Number(cards["lv-work-dead"]?.cardOpacity) < 1 && cards["lv-work-dead"]?.secShown === false, "①c working×dead 停摆形（灰实点::after 不呼吸+置灰+走秒灭）");
// waiting×alive：橙环保留
ok(cards["lv-wait-alive"]?.cls === "waiting" && cards["lv-wait-alive"]?.awaituChip, "①d waiting×alive S3 橙环保留+等你 chip");
// waiting×dead：灰实点+置灰，chip 仍在（行动指向层不受蒙层）
ok(cards["lv-wait-dead"]?.cls === "liveness-dead" && cards["lv-wait-dead"]?.stalledCls && cards["lv-wait-dead"]?.awaituChip, "①e waiting×dead S6 形+等你 chip 保留");
// 旧 relay 无键：零变化（working 黄）
ok(cards["lv-work-old"]?.cls === "working" && !cards["lv-work-old"]?.stalledCls, "①f 旧 relay 无 liveness 键零渲染（working 原样）");

// ---------- ② 心跳入账：dead→alive 翻转（onHeartbeat 存 p.liveness + 值变重渲） ----------
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify({ type: "SESSION_HEARTBEAT", session_id: "lv-work-dead", payload: { elapsed_ms: 12000, liveness: "alive" } })} })`);
await wait(500);
const revived = await ev(`(() => { const c = document.querySelector('#d-session [data-session-card="lv-work-dead"]'); const dot = c.querySelector('.srow-ava .status-dot'); return JSON.stringify({ cls: dot.className.replace('status-dot ', ''), stalled: c.classList.contains('stalled') }); })()`);
const rv = JSON.parse(revived);
ok(rv.cls === "working" && !rv.stalled, "②a 心跳 dead→alive 入账翻面（黄呼吸回归，蒙层撤）");
await shot("02-heartbeat-revived", listClip);

// ---------- ③ 陈标清算：翻终态清 liveness，回 WORKING 不残留 between-turns 形 ----------
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify({ type: "SESSION_UPDATED", session_id: "lv-work-bt", payload: { status: "DONE", updated_at: now } })} })`);
await wait(400);
const doneDot = await ev(`(() => { const dot = document.querySelector('#d-session [data-session-card="lv-work-bt"] .srow-ava .status-dot'); return dot.className.replace('status-dot ', ''); })()`);
ok(doneDot === "done", "③a 翻终态收殓（between-turns 卡→done 绿，活性覆核随态门消失）");
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify({ type: "SESSION_UPDATED", session_id: "lv-work-bt", payload: { status: "WORKING", updated_at: now + 1 } })} })`);
await wait(400);
const reWork = await ev(`(() => { const dot = document.querySelector('#d-session [data-session-card="lv-work-bt"] .srow-ava .status-dot'); return dot.className.replace('status-dot ', ''); })()`);
ok(reWork === "working", "③b 回 WORKING 陈活性不残留（无 between-turns 形=翻终态已清键，等下一拍心跳真值）");

// ---------- ④ §W 快照字段 ⊆ MERGE_KEYS 对账（DEV-45 新发现②通用陷阱的探针级锚） ----------
// 「下发在跑、端上零消费」的机械根因=MERGE_KEYS 白名单丢键。CI 矩阵锚（test-fc 面）
// 归 DEV-42 锚批接手（本批 ci.json 冲突面禁碰）；此处探针级对账先立可复跑证据：
// relay SessionState 全字段（快照 cloneState 全量下发面）必须 ∈ MERGE_KEYS ∪ 豁免清单，
// 豁免逐字段带理由（web 消费面缺席/专口合并/快照-only），新增字段不进两处任一即红。
{
  const ts = readFileSync(new URL("../src/types.ts", import.meta.url), "utf-8");
  const i0 = ts.indexOf("export interface SessionState {");
  const iface = ts.slice(i0, ts.indexOf("\n}", i0));
  const fields = [...iface.matchAll(/^\s{2}([a-z_]+)[?]?:/gm)].map((m) => m[1]);
  const webSrc = readFileSync(new URL("../../web-console/js/session-domain.js", import.meta.url), "utf-8");
  const mk = webSrc.match(/const MERGE_KEYS = \[([^\]]+)\]/)[1].match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1));
  const exempt = {
    session_id: "身份键（Map 键承载，不走 payload merge）",
    initial_prompt: "建卡定值不可变，快照-only",
    activity: "web 不消费（expo 活动舱数据面，ACTIVITY 帧链）",
    waiting_request: "专口合并（hasOwnProperty 显式 null 清除语义）",
    stats: "web 不消费（expo 统计面）",
    done_reason: "终态细节，web 走 DONE 帧 terminal_reason",
    pm_standby: "快照派生专用（#287 实时帧不带）",
    pre_reboot_status: "boot 瞬态不入 SNAPSHOT",
    idle_archived: "web 不消费",
    cli_pid: "web 不消费（relay 侧探活用）",
    turn_count: "web 不消费",
    cron_tasks: "web 不消费",
    compacting: "web 不消费",
    project_gid: "web 走 projects 表派生（getSessionProject）",
    dispatch_tier: "web 不消费",
    employee: "web 不消费",
    employee_home: "web 不消费",
    engine_provider: "web 不消费（桥/expo 消费）",
    engine_role: "web 不消费",
    org_parked: "web 不消费",
    last_task_done: "快照-only（#254 增量帧不携带）",
  };
  const mkSet = new Set(mk);
  const missing = fields.filter((f) => !mkSet.has(f) && !(f in exempt));
  const ghost = mk.filter((k) => !new Set(fields).has(k));
  console.log(`\n§W 对账：SessionState ${fields.length} 字段 = MERGE_KEYS ${mk.length} ＋豁免 ${Object.keys(exempt).length}`);
  ok(missing.length === 0, `④a 快照字段全覆盖（陷阱面零残留${missing.length ? "，漏: " + missing.join(",") : ""}）`);
  ok(ghost.length === 0, `④b MERGE_KEYS 零幽灵键（白名单拼错即红${ghost.length ? "，幽灵: " + ghost.join(",") : ""}）`);
  ok(mkSet.has("liveness"), "④c liveness 在白名单（本批机械根因修复在位）");
}

console.log(`\n探针（含§W 对账）：${pass} ok / ${fail} FAIL`);
globalThis.__p.kill("SIGKILL");
process.exit(fail > 0 ? 1 : 0);
