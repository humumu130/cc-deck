#!/usr/bin/env node
// [W-SCROLLFIX] 消息面板上滑防顶走——CDP 行为探针（现状定罪 + 修后验收两用）。
// 基于 probe-boardlife-e2e.mjs 骨架（headless Chrome + __ccDeck005Frames 注入，无需真 relay）。
// 场景（任务书验收点 1）：
//   S1 滚到中部 → 注 3 条新消息 → 断言 scrollTop 零位移 + chip「3 条新消息」
//   S2 点 chip → 平滑回底
//   S3 回底后再注消息 → 自动跟随恢复（scrollTop 贴底）
//   S4 边界：会话切换重置 chip
// 直跑：node scripts/probe-scrollfix.mjs [--fixed]（--fixed 才断言 chip/零位移；不加=现状取证模式）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(fileURLToPath(import.meta.url)); // 解析 relay/node_modules（CI npm ci 后在场）
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9901 + Math.floor(Math.random() * 300), TAG = process.argv[2] || "run";
const FIXED = process.argv.includes("--fixed");
const OUT = `/tmp/w-scrollfix-shots/${TAG}-${FIXED ? "fixed" : "before"}`;
mkdirSync(OUT, { recursive: true });
const URL0 = "file://" + fileURLToPath(new URL("../../web-console/index-005.html", import.meta.url));
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/sf-cdp-" + Date.now(), "--window-size=1440,940", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) { await wait(500); try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; } }
if (!list) { console.error("Chrome CDP 未就绪"); process.exit(2); }
const tab = list.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const consoleErrs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === "Runtime.consolePosted" && ["error", "warning"].includes(m.params?.type)) consoleErrs.push(String(m.params?.args?.[0]?.value ?? "").slice(0, 160)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name); } };
const waitFor = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(250); } return await ev(expr); };

// ---------- fixture：SNAPSHOT + 长历史 timeline ----------
const now = Date.now();
const SID = "sf-1";
const hist = [];
// 带图消息：1px×1 PNG data URL 放大到 480×360（FB14 气泡附图链路）——late-load 撑高形态
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
for (let i = 0; i < 40; i++) {
  const e = { ts: now - (40 - i) * 60_000, kind: i % 2 ? "assistant_text" : "user", text: `消息 #${i + 1}：` + "滚动保持探针填充文本， ".repeat(18), id: `sf-h${i}` };
  if (i % 4 === 2) e.images = [{ url: IMG, w: 480, h: 360 }];
  hist.push({ session_id: SID, type: "SESSION_LOG", payload: e });
}
const frame = (f) => ev(`window.__ccDeck005Frames.emit(${JSON.stringify({ kind: "frame", source: "lan", frame: f })})`);
const snap = { type: "SNAPSHOT", payload: { relay_name: "探针 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [
  { session_id: SID, title: "滚动保持探针会话", status: "WORKING", engine: "claude", model: "glm-5.3", updated_at: now, started_at: now - 4e6, cwd: "/Users/u/dev/cc-deck", context_usage: 80000, context_limit: 200000 },
], projects: [], org_confirms: [], notifications: [], acceptances: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await frame(snap);
await wait(600);
for (const f of hist) await frame(f);
await wait(400);

// ---------- 选中会话 ----------
await ev(`document.querySelector('.queue-card[data-session-card="${SID}"]')?.click()`);
await waitFor(`!!document.querySelector('#d-session #session-body .msg-ai, #d-session #session-body .bubble, #d-session #session-body [data-conv-body] > *')`, 8000);
const bodyInfo0 = await ev(`(function(){ const el = document.querySelector('#d-session #session-body'); if (!el) return "null"; return JSON.stringify({ sh: el.scrollHeight, st: el.scrollTop, ch: el.clientHeight, can: el.scrollHeight > el.clientHeight + 200 }); })()`);
console.log("滚动容器初态:", bodyInfo0);
const bi0 = JSON.parse(bodyInfo0 || "{}");
ok(bi0.can, `B0 容器可滚（scrollHeight=${bi0.sh} clientHeight=${bi0.ch}——历史 40 条已渲染）`);

// ---------- S1：滚到中部 → 注 3 条新消息 → 零位移断言 ----------
const topSet = await ev(`(function(){ const el = document.querySelector('#d-session #session-body'); el.scrollTop = Math.floor(el.scrollHeight / 2); return el.scrollTop; })()`);
await wait(400); // 让 onScroll 记账（userPinnedBottom=false）
const top0 = await ev(`document.querySelector('#d-session #session-body').scrollTop`);
console.log(`中部锚定 scrollTop=${top0}（set=${topSet}）`);
let msgN = 0;
for (let i = 0; i < 3; i++) { msgN++; await frame({ session_id: SID, type: "SESSION_LOG", payload: { ts: now + msgN * 1000, kind: "assistant_text", text: `新消息 ${msgN}：顶走复现注入。` + "尾部追加内容 ".repeat(12), id: `sf-n${msgN}` } }); }
await wait(600);
const top1 = await ev(`document.querySelector('#d-session #session-body').scrollTop`);
const drift = Math.abs(top1 - top0);
console.log(`注入 3 条后 scrollTop=${top1}（漂移 ${drift}px）`);
if (FIXED) {
  ok(drift <= 2, `S1a 离底视口零位移（漂移 ${drift}px ≤ 2px）`);
  const chipTxt = await ev(`document.querySelector('#d-session .back-to-bottom .unread-n')?.textContent.trim() || ""`);
  if (!/3\s*条新消息/.test(chipTxt)) {
    const dbg = await ev(`(document.querySelector('.back-to-bottom')?.outerHTML || "无btb").slice(0, 300)`);
    console.log("  [诊断] btb=" + dbg);
  }
  ok(/3\s*条新消息/.test(chipTxt), `S1b chip 计数（"${chipTxt}"）`);
  await shot("s1-chip");
} else {
  console.log(`[现状取证] 漂移 ${drift}px → ${drift > 40 ? "顶走复现 ✅（定罪）" : "未复现（此通道无罪，查其他通道）"}`);
  await shot("s1-before");
}

// ---------- S1.5：全量重建（SNAPSHOT 刷新）× 图片 late-load 通道 ----------
// 周期 SNAPSHOT → renderAll → renderConversation 全量重建：重建瞬间 <img> 重插（late-load
// 高度先 0），scrollHeight 塌缩 → restoreTop clamp 折损 → 图片 onload 撑高后 scrollTop
// 停在 clamp 值=视口跳变（「变高度内容」通道）。
await frame(snap); // 周期 SNAPSHOT 刷新（真实链路同款）
await wait(120);
const topMid = await ev(`document.querySelector('#d-session #session-body').scrollTop`);
await wait(1000);
const topAfter = await ev(`(function(){ const el = document.querySelector('#d-session #session-body'); return JSON.stringify({ st: el.scrollTop, sh: el.scrollHeight }); })()`);
const ta = JSON.parse(topAfter || "{}");
const rebuildDrift = Math.abs((FIXED ? ta.st : ta.st) - top0);
console.log(`SNAPSHOT 重建：瞬时 st=${topMid}（相对锚 ${topMid - top0 > 0 ? "+" : ""}${topMid - top0}）→ 稳定 st=${ta.st}（漂移 ${rebuildDrift}px, sh=${ta.sh}）`);
if (FIXED) ok(rebuildDrift <= 2, `S1c 全量重建（含图片）离底零位移（漂移 ${rebuildDrift}px ≤ 2px）`);
else console.log(`[现状取证] 重建通道漂移 ${rebuildDrift}px → ${rebuildDrift > 40 ? "顶走复现 ✅（定罪：重建×late-load clamp）" : "未复现"}`);

// ---------- S2：点 chip → 回底（修后） ----------
if (FIXED) {
  await ev(`document.querySelector('#d-session .back-to-bottom')?.click()`);
  await wait(700); // smooth 滚动
  const nearB = await ev(`(function(){ const el = document.querySelector('#d-session #session-body'); return el.scrollHeight - el.scrollTop - el.clientHeight; })()`);
  ok(nearB < 40, `S2 chip 点击回底（距底 ${nearB}px）`);
  const chipGone = await ev(`!(document.querySelector('#d-session .back-to-bottom')?.classList.contains("has-unread"))`);
  ok(chipGone, "S2b chip 计数清除（has-unread 摘除）");
  await shot("s2-bottom");
}

// ---------- S3：回底后新消息自动跟随 ----------
if (FIXED) {
  await frame({ session_id: SID, type: "SESSION_LOG", payload: { ts: now + 9999, kind: "assistant_text", text: "回底后跟随验证消息。", id: "sf-follow" } });
  await wait(400);
  const nearB2 = await ev(`(function(){ const el = document.querySelector('#d-session #session-body'); return el.scrollHeight - el.scrollTop - el.clientHeight; })()`);
  ok(nearB2 < 40, `S3 回底后自动跟随（新消息距底 ${nearB2}px）`);
}

// ---------- S4：会话切换重置 ----------
if (FIXED) {
  await ev(`(function(){ const el = document.querySelector('#d-session #session-body'); el.scrollTop = 100; })()`);
  await wait(300);
  await frame({ session_id: SID, type: "SESSION_LOG", payload: { ts: now + 12000, kind: "assistant_text", text: "离底期第二条。", id: "sf-n9" } });
  await wait(300);
  const chipBefore = await ev(`(document.querySelector('#d-session .back-to-bottom')?.classList.contains("has-unread")) === true`);
  await frame({ type: "SNAPSHOT", payload: { ...snap.payload, sessions: [...snap.payload.sessions, { session_id: "sf-2", title: "切换目标会话", status: "DONE", engine: "claude", model: "glm-5.3", updated_at: now, started_at: now, cwd: "/tmp", context_usage: 1, context_limit: 2 }] } });
  await wait(500);
  await ev(`document.querySelector('.queue-card[data-session-card="sf-2"]')?.click()`);
  await wait(600);
  const chipAfter = await ev(`!(document.querySelector('#d-session .back-to-bottom')?.classList.contains("has-unread"))`);
  ok(chipBefore && chipAfter, "S4 会话切换 chip 重置（切前在/切后隐藏）");
  await shot("s4-reset");
}

console.log(`\n${FIXED ? "修后验收" : "现状取证"}：${pass} pass / ${fail} FAIL${consoleErrs.length ? "（console error: " + consoleErrs[0] + "…）" : ""}`);
globalThis.__p.kill();
process.exit(fail ? 1 : 0);
