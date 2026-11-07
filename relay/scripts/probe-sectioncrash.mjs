#!/usr/bin/env node
// [W-SECTIONCRASH] P0 热修探针——设置域 rsRender 作用域越界崩（用户实锤
// ReferenceError: Can't find variable: section @settings-domain.js:1660，表象
// Mac 连不上 relay）。engineslim 挪动把 rsRender 挪出 render 闭包（const section
// :1491 于 :1647 闭合）→ 越界引用。静态 node --check（语法级）与既有 probe（只断
// provider 面板、不执行评审席路径）均拦不住——本探针补行为级断言：
//   SC1 设置域 connections 面板评审席卡真渲染（rsRender 首调不炸——崩则 :1674 抛
//      ReferenceError 布线中断，box 恒空/无评审池字样）
//   SC2 REVIEW_SEAT_UPDATED 增量帧重渲不炸（subscribe 链 rsRender 二次执行）+数据真变
//   SC3 页面 console error 计数零（Runtime.consoleAPICalled error 级旁路收集——
//      「连不上」表象=布线区崩，本断言直击）
//   SC4 静态作用域断言（防再犯·源码级）：rsRender 函数段内 section 必自取
//      （const section = document.querySelector("#d-settings")）——未来删自取即红
// 窗口 1280 桌面档：评审席卡在桌面壳 #d-settings（connections 面板）——460 移动档
// #d-settings display:none，DOM 断言过但视觉证据截不到（首跑实锤）。
// 直跑：node scripts/probe-sectioncrash.mjs <tag> [--before]（--before=基线取证：改动前
// 跑新断言红=预期证据）。卫生：Chrome 四钩清场+tab 归属校验（W-TEAMTOPOLISH-R1 范式）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(fileURLToPath(import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "run";
const BEFORE = process.argv.includes("--before");
const OUT = `/Users/xdd/.cc-deck/artifacts/sectioncrash-shots/${TAG}`;
mkdirSync(OUT, { recursive: true });
const URL0 = "file://" + fileURLToPath(new URL("../../web-console/index-005.html", import.meta.url));
const PORT = 9841 + Math.floor(Math.random() * 300);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/sc-cdp-" + Date.now(), "--window-size=1280,900", URL0], { stdio: "ignore" });
const killChrome = () => { try { globalThis.__p.kill(); } catch {} };
process.on("exit", killChrome);
process.on("SIGINT", () => { killChrome(); process.exit(130); });
process.on("SIGTERM", () => { killChrome(); process.exit(143); });
process.on("uncaughtException", (e) => { console.error("uncaught:", e?.message ?? e); killChrome(); process.exit(1); });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 30 && !list; i++) { await wait(500); try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { list = null; } }
if (!list) { console.error("Chrome CDP 15s 未就绪，退出"); process.exit(2); }
const tab = list.find(t => t.type === "page" && String(t.url || "").includes("web-console/index-005.html"));
if (!tab) { console.error("CDP tab 归属校验失败：无 index-005 页"); process.exit(2); }
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
const consoleErrors = []; // SC3 旁路收集：Runtime.consoleAPICalled error 级
ws.on("message", d => {
  const m = JSON.parse(d);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d2 = m.params?.exceptionDetails;
    consoleErrors.push(String(d2?.text ?? "") + " " + String(d2?.exception?.description ?? "").slice(0, 200));
  }
});
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else if (BEFORE) { pass++; console.log("  (baseline-red) " + name); } else { fail++; console.log("  FAIL " + name); } };

// ---------- fixture：SNAPSHOT 带 review_seat（评审池在编+团队 override 席） ----------
const snap = { type: "SNAPSHOT", payload: { relay_name: "探针 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [], projects: [], models: ["glm-5.3"],
  source_capabilities: { engine_catalog: [{ id: "claude", label: "Claude", state: "ready", models: ["glm-5.3"] }] },
  review_seat: { enabled: true, default_size: 2, pool: { size: 3, engine_dist: { claude: 2, codex: 1 } }, teams: [{ gid: "g-probe", name: "探针组", declared: 1, actual: 1 }] },
  org_confirms: [], notifications: [], acceptances: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(600);

// ---------- SC1 设置域 connections 面板：评审席卡真渲染 ----------
await ev(`document.querySelector('.rail-btn[data-domain="settings"]').click()`);
await wait(500);
const sc1 = await ev(`(() => { const box = document.querySelector('[data-review-seat-live]'); return JSON.stringify({ hasBox: !!box, html: box?.innerHTML ?? "", txt: box?.textContent ?? "" }); })()`);
const s1 = JSON.parse(sc1);
ok(s1.hasBox === true, "SC1a 评审席容器在（connections 面板）");
ok((s1.txt || "").includes("评审池"), `SC1b rsRender 真渲染（含「评审池」——首调不炸则布线完整；实「${(s1.txt || "").slice(0, 30)}」）`);
ok((s1.txt || "").includes("探针组") && (s1.txt || "").includes("claude×2"), `SC1c 池/团队数据真渲（探针组 override 席+引擎分布）`);
await shot("01-settings-review-seat");

// ---------- SC2 REVIEW_SEAT_UPDATED 增量帧重渲不炸+数据真变 ----------
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "REVIEW_SEAT_UPDATED", payload: { enabled: false, default_size: 4, pool: { size: 3, engine_dist: { claude: 3 } }, teams: [] } } })`);
await wait(400);
const sc2 = await ev(`(() => { const box = document.querySelector('[data-review-seat-live]'); const t = box?.textContent ?? ""; return JSON.stringify({ has4: t.includes("4"), stopped: t.includes("已停用"), noTeam: !t.includes("探针组") }); })()`);
const s2 = JSON.parse(sc2);
ok(s2.has4 === true && s2.stopped === true, "SC2a 增量帧重渲真变（size 4+已停用——rsRender 二次执行不炸）");
ok(s2.noTeam === true, "SC2b teams 清空跟随（subscribe 链数据通）");
await shot("02-after-increment");

// ---------- SC3 页面 console error 零（「连不上」表象=布线区崩，此处直击） ----------
ok(consoleErrors.length === 0, `SC3 页面零 console error/异常（${consoleErrors.length} 条${consoleErrors.length ? "：" + consoleErrors[0].slice(0, 80) : ""}）`);

// ---------- SC4 静态作用域断言（防再犯·源码级） ----------
const src = readFileSync(fileURLToPath(new URL("../../web-console/js/settings-domain.js", import.meta.url)), "utf8");
const rsM = src.match(/const rsRender = \(\) => \{[\s\S]*?\n\s*\};/);
ok(!!rsM, "SC4a rsRender 函数段可提取（源码锚在）");
if (rsM) {
  ok(/const section = document\.querySelector\("#d-settings"\)/.test(rsM[0]), "SC4b rsRender 段内 section 自取在场（删自取=回崩态即红——防再犯）");
  const selfIdx = rsM[0].indexOf("const section =");
  const boxIdx = rsM[0].indexOf('section.querySelector("[data-review-seat-live]")');
  ok(selfIdx !== -1 && boxIdx !== -1 && selfIdx < boxIdx, "SC4c 自取先于首次使用（顺序守卫）");
}

console.log(BEFORE ? `\n${TAG}(before 基线): ${pass} passed（baseline-red=改动面证据）` : `\n${TAG}: ${pass} passed, ${fail} failed`);
writeFileSync(`${OUT}/summary.txt`, `pass=${pass} fail=${fail}\n`);
killChrome();
process.exit(fail ? 1 : 0);
