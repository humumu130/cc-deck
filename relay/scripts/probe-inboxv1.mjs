// W-INBOX-V1 探针（收件箱最小切片三刀验收）：×双钮+行键归一+已归档分区（不丢账语义修正）。
// 夹具：active actionable（双钮靶/无 jump 形态）+handled 行（账面归档靶）+snoozed 行
// （relay 锚隐藏靶）+pendingConfirms/acceptances+pua（synth 键归一靶）。
// 断言：A 双钮形态/B synth 键归一/C snooze 隐藏+到点回箱（wake timer 真 2s e2e）/
//       D 稍后点击本地隐藏/E 归档分区账面行/F 本地 × 可找回（恢复钮）。
// 用法：node probe-inboxv1.mjs（复用 probe-notify-shot 骨架：CDP+SNAPSHOT 注入）。
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9941 + Math.floor(Math.random() * 300);
const OUT = "/tmp/inbox-v1";
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/inboxv1-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page");
const tab = list.find(t => t.url.includes("index-005")) || list[0];
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name, clip) => { const params = { format: "png" }; if (clip) params.clip = clip; const r = await send("Page.captureScreenshot", params); const { writeFileSync } = await import("node:fs"); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  shot ${name}`); };
await send("Page.enable"); await send("Runtime.enable");

// ---------- fixture ----------
const now = Date.now();
const mkS = (id, title, status) => ({ session_id: id, title, status, engine: "claude", model: "glm-5.3", updated_at: now - 3e5, started_at: now - 9e5, cwd: "/Users/u/dev/cc-deck", context_usage: 84000, context_limit: 200000 });
const ctx = { domain: "org", sessionId: "a-w-1" };
const notifs = [
  // A 靶①：actionable 有 jump（dispatch+session）——稍后在/× 不在
  { key: "a1", kind: "dispatch", group: "action", severity: "waiting", title: "派单收割待办：W-DBL97 交付回执已到", body: "", actionable: true, created_at: now - 3 * 60_000, sourceContext: ctx },
  // A 靶②：actionable 无 jump（system 无 session）——「知道了+稍后」双钮纯形态
  { key: "a2", kind: "system", group: "action", severity: "waiting", title: "系统：迁移演练需你确认窗口", body: "", actionable: true, created_at: now - 6 * 60_000, sourceContext: { domain: "org" } },
  // C 靶：relay snooze 锚未到点——整行隐藏（不进组不计数）
  { key: "sn1", kind: "dispatch", group: "action", severity: "waiting", title: "派单收割待办：W-SNO77 交付回执已到", body: "", actionable: true, created_at: now - 120_000, snoozed_until: now + 25 * 60_000, sourceContext: ctx },
  // E 靶：账面 handled 未 resolved——已归档分区数据源
  { key: "h1", kind: "dispatch", group: "action", severity: "info", title: "派单收割待办：W-ARC88 交付回执已到", body: "", actionable: true, created_at: now - 3600_000, handled_at: now - 1800_000, sourceContext: ctx },
  // F 靶：非 active 瞬态行（动态组）——× 在场
  { key: "d1", kind: "system", group: "activity", severity: "info", title: "系统：relay 快照完成（18 会话/4 项目）", body: "", actionable: false, created_at: now - 22e5, sourceContext: { domain: "org" } },
];
// B 靶：synth 行键归一——pua[].key（stableKey 同口径）落 DOM data-notify-key
const CONFIRM_ID = "cf-901", confTs = now - 5 * 60_000;
const confirmPuaKey = `org-confirm:${CONFIRM_ID}:${confTs}`;
const ACC_ID = "ac-77", accTs = now - 10 * 60_000;
const accPuaKey = `acceptance:${ACC_ID}:${accTs}`;
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u",
  sessions: [mkS("a-w-1", "在跑收件箱批", "WORKING")],
  projects: [], notifications: notifs, acceptances: [
    { id: ACC_ID, title: "inbox-v1 装机验收单", total: 5, judged: 0, submitted: false, created_at: Math.floor(accTs / 1000) },
  ], receipts: [],
  org_confirms: [{ id: CONFIRM_ID, title: "组织确认：worker 成员入编审批（inbox-v1 靶）", reason: "夹具", created_at: Math.floor(confTs / 1000), status: "pending" }],
  pending_user_actions: [
    { key: confirmPuaKey, kind: "org-confirm", entity_id: CONFIRM_ID, title: "组织确认：worker 成员入编审批（inbox-v1 靶）", created_at: confTs },
    { key: accPuaKey, kind: "acceptance", entity_id: ACC_ID, title: "验收单待填：inbox-v1 装机验收单", created_at: accTs },
  ] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
// 冷启加固：等 rail 钮在场再开面板（偶发 Chrome 慢启=注入早于 DOM 就绪→全断言连坐红）
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('.rail-btn[data-domain="notify"]')`)); i++) await wait(200);
await wait(600);
await ev(`document.querySelector('.rail-btn[data-domain="notify"]').click()`);
await wait(900);
// 展开动态组（d1 靶行所在——observe3 默认折叠）
await ev(`document.querySelector('.ngrp[data-notify-grp="n"]')?.click()`); await wait(400);
const pRect = async () => ev(`(() => { const r = document.querySelector('[data-notify-panel]').getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: Math.min(r.height + 24, 880), scale: 1 }; })()`);

// ---------- 断言 ----------
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "  ok " : "  FAIL ") + name); };

// A 双钮形态：active 行 稍后在+× 不在；非 active 行 × 在+稍后不在
const a1Btns = await ev(`(() => { const r = document.querySelector('[data-notify-key="a1"]'); return JSON.stringify({ snooze: !!r?.querySelector(".act-snooze"), x: !!r?.querySelector(".x"), jump: !!r?.querySelector(".act") }); })()`);
const a1 = JSON.parse(a1Btns);
ok(a1.snooze === true && a1.x === false && a1.jump === true, `A1 active 行（有 jump）稍后在+× 退役（snooze=${a1.snooze} x=${a1.x} act=${a1.jump}）`);
const a2Btns = await ev(`(() => { const r = document.querySelector('[data-notify-key="a2"]'); return JSON.stringify({ ack: !!r?.querySelector('[data-notify-ack]'), snooze: !!r?.querySelector(".act-snooze"), x: !!r?.querySelector(".x") }); })()`);
const a2 = JSON.parse(a2Btns);
ok(a2.ack === true && a2.snooze === true && a2.x === false, `A2 active 行（无 jump）「知道了+稍后」双钮（ack=${a2.ack} snooze=${a2.snooze} x=${a2.x}）`);
const d1Btns = await ev(`(() => { const r = document.querySelector('[data-notify-key="d1"]'); return JSON.stringify({ x: !!r?.querySelector(".x"), snooze: !!r?.querySelector(".act-snooze") }); })()`);
const d1 = JSON.parse(d1Btns);
ok(d1.x === true && d1.snooze === false, `A3 非 active 行 × 保留+稍后不在（x=${d1.x} snooze=${d1.snooze}）`);

// B synth 行键归一：DOM key=pua[].key（stableKey 同口径）；旧本地键形态绝迹
ok(await ev(`!!document.querySelector('[data-notify-key="${confirmPuaKey}"]')`) === true, `B1 org-confirm synth 行键=pua key（${confirmPuaKey.slice(0, 24)}…）`);
ok(await ev(`!!document.querySelector('[data-notify-key="${accPuaKey}"]')`) === true, "B2 acceptance synth 行键=pua key");
ok(await ev(`!document.querySelector('[data-notify-key="confirm:cf-901"]') && !document.querySelector('[data-notify-key="acceptance:ac-77"]')`) === true, "B3 旧本地键形态绝迹（无 revision 段的裸 confirm:/acceptance: 键零行——stableKey 命名空间不含混淆）");

// C snooze 锚隐藏+计数排除
ok(await ev(`!document.querySelector('[data-notify-key="sn1"]')`) === true, "C1 snoozed 行（relay 锚未到点）整行隐藏");
const badge0 = await ev(`document.querySelector('.rail-btn[data-domain="notify"] [data-notify-badge]')?.textContent || "?"`);
ok(badge0 === "4", `C2 rail 计数排除 snoozed/archived（=${badge0}——a1/a2+两 synth 行，sn1 隐藏 h1 归档不计）`);

// E 归档分区（账面 handled）：组头默认折叠+展开后行在场
ok(await ev(`!!document.querySelector(".ngrp-arch")`) === true, "E1 已归档分区组头在场（默认折叠）");
const archCnt = await ev(`document.querySelector(".ngrp-arch .cnt")?.textContent || "?"`);
ok(archCnt === "1", `E2 归档计数=账面 handled 行数（${archCnt}）`);
await ev(`document.querySelector("[data-notify-arch-toggle]")?.click()`); await wait(400);
ok(await ev(`!!document.querySelector('.ngrp-arch ~ * [data-notify-key="h1"], .np-body [data-notify-key="h1"]')`) === true, "E3 展开后 handled 行可查（W-ARC88 在归档分区）");
ok(await ev(`(() => { const r = document.querySelector('[data-notify-key="h1"]'); return r ? !r.querySelector("[data-notify-restore]") : false; })()`) === true, "E4 账面终态行无恢复钮（留档可查——反账重开不在 V1 词表）");

// D 稍后点击：本地隐藏 → 短锚到点 wake timer 真回箱（2s e2e）
await ev(`document.querySelector('[data-notify-key="a2"] .act-snooze')?.click()`); await wait(400);
ok(await ev(`!document.querySelector('[data-notify-key="a2"]')`) === true, "D1 稍后点击后行即时隐藏（本地 Map）");
ok(await ev(`document.querySelector('.rail-btn[data-domain="notify"] [data-notify-badge]')?.textContent`) === "3", "D2 隐藏后 rail 计数 -1（=3）");
// 短锚改期：本地 Map 写 1.2s 后 + 重发同帧触发 render（#sn: 签名含 until 值——锚值
// 变化必真重渲+重挂唤醒钟；不重发帧则旧 30min 钟不重挂=测不到点）
await ev(`window.__ccDeck005SnoozedNotifyKeys.set("a2", Date.now() + 1200)`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(600);
ok(await ev(`!document.querySelector('[data-notify-key="a2"]')`) === true, "D3 短锚期内仍隐藏");
await wait(1800); // wake timer 到点（+300ms 容差）
ok(await ev(`!!document.querySelector('[data-notify-key="a2"]')`) === true, "D4 到点自动回箱（wake timer 重渲——稍后承诺兑现）");

// F 本地 × 可找回：× 动态行 → 归档分区出现+恢复钮 → 恢复回主分组
const archCntBefore = await ev(`document.querySelector(".ngrp-arch .cnt")?.textContent`);
await ev(`document.querySelector('[data-notify-key="d1"] .x')?.click()`); await wait(400);
const archCntAfter = await ev(`document.querySelector(".ngrp-arch .cnt")?.textContent`);
ok(Number(archCntAfter) === Number(archCntBefore) + 1, `F1 × 后进归档分区（${archCntBefore}→${archCntAfter}）`);
ok(await ev(`(() => { const r = document.querySelector('[data-notify-key="d1"]'); return r ? !!r.querySelector("[data-notify-restore]") : false; })()`) === true, "F2 本地 × 行带「恢复」钮");
await ev(`document.querySelector('[data-notify-key="d1"] [data-notify-restore]')?.click()`); await wait(400);
const archCntRestored = await ev(`document.querySelector(".ngrp-arch .cnt")?.textContent`);
ok(Number(archCntRestored) === Number(archCntBefore), `F4 恢复后归档计数回落（${archCntRestored}=${archCntBefore}）`);
ok(await ev(`!!document.querySelector('[data-notify-key="d1"]')`) === true, "F5 恢复后行回到面板（动态组可查——真丢面消除）");

// 截图：双钮暗/光+归档分区展开
await shot("01-inbox-dualbtn-dark", await pRect());
await ev(`document.documentElement.setAttribute('data-theme', 'light')`); await wait(400);
await shot("02-inbox-dualbtn-light", await pRect());
await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await wait(300);
await shot("03-inbox-archive-dark", await pRect());
// R1 教训重演预防：归档分区在滚动区下部（880 截高帽切镜外）——滚到底补一张专项镜
await ev(`(() => { const b = document.querySelector('[data-notify-panel-body]'); if (b) b.scrollTop = b.scrollHeight; return 1; })()`);
await wait(300);
await shot("04-inbox-archive-scrolled-dark", await pRect());

console.log(`\ninboxv1 probe: ${pass} ok / ${fail} FAIL`);
try { globalThis.__p.kill(); } catch {}
process.exit(fail ? 1 : 0);
