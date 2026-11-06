#!/usr/bin/env node
// [W-ENGINESLIM] 引擎列表简洁化——CDP 行为探针（改前/改后对照+断言）。
// 用户令（1106）：「有标签了就不需要名称了，未安装的提示未安装就行了」。
// 断言组：
//   S1 ready 行：无 strong 名称重复（badge 内含名称文字=标签）+ so-solo 状态位 + title 带名
//   S2 unavailable 行：状态=「未安装」二字 + title 含安装命令（INSTALL_HINT 移交）+ 无「需先安装」
//   S3 unsupported 行：状态=「未接入」二字
//   S4 菜单全文无「需先安装」字样；hover title 可获引擎名（可访问性）
// 直跑：node scripts/probe-engineslim.mjs <tag> [--before]（--before=基线取证模式，新断言红=预期证据）
// 卫生：Chrome 四钩清场+tab 归属校验（W-TEAMTOPOLISH-R1 范式——A 审 109 泄漏/假红教训）。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(fileURLToPath(import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAG = process.argv[2] || "run";
const BEFORE = process.argv.includes("--before");
const OUT = `/Users/xdd/.cc-deck/artifacts/engineslim-shots/${TAG}`;
mkdirSync(OUT, { recursive: true });
const URL0 = "file://" + fileURLToPath(new URL("../../web-console/index-005.html", import.meta.url));
const PORT = 9841 + Math.floor(Math.random() * 300);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/es-cdp-" + Date.now(), "--window-size=460,900", URL0], { stdio: "ignore" });
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
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`  📸 ${name}`); };
await send("Page.enable"); await send("Runtime.enable");
await wait(1800);
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ok " + name); } else if (BEFORE) { pass++; console.log("  (baseline-red) " + name); } else { fail++; console.log("  FAIL " + name); } };

// ---------- fixture：四态引擎目录 ----------
const now = Date.now();
const snap = { type: "SNAPSHOT", payload: { relay_name: "探针 relay", token_valid: true, homedir: "/Users/u", leader_session_id: "", sessions: [], projects: [], models: ["glm-5.3"],
  source_capabilities: { engine_catalog: [
    { id: "claude", label: "Claude", state: "ready", models: ["glm-5.3", "glm-5.3-air"] },
    { id: "codex", label: "Codex", state: "unavailable", preflight: { state: "fail", reason: "CLI 未在当前 PATH 探测到" }, models: [] },
    { id: "iFlow", label: "iFlow", state: "unsupported", preflight: { state: "fail", reason: "枚举占位未接入编排" }, models: [] },
  ] }, org_confirms: [], notifications: [], acceptances: [], receipts: [] } };
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(800);
// ---------- 打开新建会话弹 + 引擎下拉 ----------
await ev(`document.querySelector('.rail-btn[data-domain="session"]').click()`);
await wait(400);
await ev(`document.querySelector('#d-session .queue-head button.icon-btn')?.click()`);
await wait(300);
const trigOk = await ev(`!!document.querySelector('#b2-create-pop [data-engine-trigger]')`);
if (!trigOk) { console.error("新建弹/引擎触发器未开"); killChrome(); process.exit(2); }
await ev(`document.querySelector('#b2-create-pop [data-engine-trigger]').click()`);
await wait(300);
const menuOk = await ev(`!!document.getElementById("b2-engine-menu")`);
if (!menuOk) { console.error("引擎下拉未开"); killChrome(); process.exit(2); }
await shot("01-engine-menu");

// ---------- S1 ready 行：无 strong 重复 + title 带名 ----------
const readyRow = await ev(`(() => { const r = document.querySelector('#b2-engine-menu [data-engine-choice="claude"]'); if (!r) return "NOROW"; return JSON.stringify({ hasStrong: !!r.querySelector("strong"), badgeText: r.querySelector(".engine-badge")?.textContent ?? "", solo: !!r.querySelector(".so-copy.so-solo"), small: r.querySelector("small")?.textContent ?? "", title: r.getAttribute("title") ?? "" }); })()`);
const rr = JSON.parse(readyRow === "NOROW" ? "{}" : readyRow);
ok(readyRow !== "NOROW" && rr.hasStrong === false, `S1a ready 行无 strong 名称重复`);
ok((rr.badgeText || "").includes("Claude"), `S1b 徽章含名称文字（标签在场，"${rr.badgeText}"）`);
ok(rr.solo === true, "S1c so-solo 单行状态位形态");
ok((rr.title || "").includes("Claude") && (rr.title || "").includes("模型"), `S1d title 带引擎名+状态（"${rr.title}"）`);

// ---------- S2 unavailable 行：「未安装」二字 + title 安装命令 ----------
const naRow = await ev(`(() => { const rows = [...document.querySelectorAll('#b2-engine-menu .source-option[aria-disabled="true"]')]; const r = rows.find(x => (x.querySelector(".engine-badge")?.textContent || "").includes("Codex")); if (!r) return "NOROW"; return JSON.stringify({ small: r.querySelector("small")?.textContent ?? "", title: r.getAttribute("title") ?? "" }); })()`);
const nr = JSON.parse(naRow === "NOROW" ? "{}" : naRow);
ok(naRow !== "NOROW" && nr.small === "未安装", `S2a Codex 状态=「未安装」二字（"${nr.small}"）`);
ok((nr.title || "").includes("npm i -g @openai/codex"), `S2b title 含安装命令（INSTALL_HINT 移交，"${(nr.title || "").slice(0, 70)}…"）`);
ok((nr.title || "").includes("Codex") && (nr.title || "").includes("原因"), "S2c title 带名+preflight 原因");

// ---------- S3 unsupported 行：「未接入」 ----------
const unsRow = await ev(`(() => { const rows = [...document.querySelectorAll('#b2-engine-menu .source-option[aria-disabled="true"]')]; const r = rows.find(x => (x.querySelector(".engine-badge")?.textContent || "").includes("iFlow")); if (!r) return "NOROW"; return r.querySelector("small")?.textContent ?? ""; })()`);
ok(unsRow === "未接入", `S3 unsupported=「未接入」二字（"${unsRow}"）`);

// ---------- S4 菜单全文「需先安装」绝迹 + 全行 title 可读 ----------
const menuTxt = await ev(`document.getElementById("b2-engine-menu").textContent`);
ok(!menuTxt.includes("需先安装") && !menuTxt.includes("即将支持"), `S4a 菜单全文无「需先安装/即将支持」字样`);
const noNameDup = await ev(`(() => { const rows = [...document.querySelectorAll('#b2-engine-menu .source-option')].filter(r => r.querySelector(".engine-badge") && r.querySelector("button, strong")); return rows.length; })()`);
const strongN = await ev(`document.querySelectorAll('#b2-engine-menu .source-option strong').length`);
const autoStrong = await ev(`(() => { const a = document.querySelector('#b2-engine-menu [data-engine-choice="auto"]'); return a ? !!a.querySelector("strong") : "NOAUTO"; })()`);
ok(strongN === 1 && autoStrong === true, `S4b strong 仅剩 auto 行（跟随源默认=语义说明非引擎名；计 ${strongN} 处）——引擎行零名称重复`);
await shot("02-after-slim");

// ---------- S5 设置→Agent 引擎面（W-ENGINESLIM-R1 A 审 P1：视觉与新建面同款） ----------
// 关闭引擎下拉/新建弹 → 切设置域 → 直切 provider 面板 active（tab 交互链由 CSS 类控制，
// live 容器渲染不依赖 active——SNAPSHOT 时已灌，探针直显断言）
await ev(`document.getElementById("b2-engine-menu")?.remove(); document.getElementById("b2-create-pop")?.closest(".pair-pop-backdrop")?.remove();`);
await ev(`document.querySelector('.rail-btn[data-domain="settings"]').click()`);
await wait(300);
await ev(`window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()`); // 探针形态补触发（生产=连接事件链驱动，mock frames 不走该链）
await wait(400);
await ev(`(() => { document.querySelectorAll(".settings-panel").forEach(p => p.classList.remove("active")); const t = document.querySelector('[data-settings-panel="provider"]'); if (t) t.classList.add("active"); })()`);
await wait(300);
const setRow = await ev(`(() => { const rows = [...document.querySelectorAll('[data-settings-live="provider"] .engine-row')]; const r = rows.find(x => (x.querySelector(".engine-badge")?.textContent || "").includes("Claude")); if (!r) return "NOROW"; const swtxt = r.querySelector(".v8-swtxt"); const swdOnly = swtxt.querySelector(".v8-swd"); return JSON.stringify({ badgeText: r.querySelector(".engine-badge")?.textContent ?? "", swtxtTop: swtxtTop(swtxt, swdOnly), swd: swdOnly?.textContent ?? "", title: r.getAttribute("title") ?? "", aria: r.getAttribute("aria-label") ?? "", soloCls: !!swdOnly?.classList.contains("v8-swd-solo") }); function swtxtTop(sw, swd) { const c = sw.cloneNode(true); const d = c.querySelector(".v8-swd"); if (d) d.remove(); c.querySelectorAll(".eng-auth-dot").forEach(x => x.remove()); return (c.textContent || "").trim(); } })()`);
const sr = JSON.parse(setRow === "NOROW" ? "{}" : setRow);
ok(setRow !== "NOROW", "S5a 设置面引擎行在（provider live 渲染）");
ok((sr.badgeText || "").includes("Claude"), `S5b 徽章含名称文字（标签在场，"${sr.badgeText}"）`);
ok((sr.swtxtTop || "") === "", `S5c swtxt 主体无名称重复（A 审 P1 根治——旧形态 label 双显，实「${sr.swtxtTop}」）`);
ok((sr.swd || "").includes("已接") && (sr.swd || "").includes("模型"), `S5d 单行状态位（"${sr.swd}"）`);
ok(sr.soloCls === true, "S5d2 v8-swd-solo 升主字号形态（视觉重量对齐新建面）");
ok((sr.title || "").includes("Claude") && (sr.aria || "").includes("Claude"), `S5e 行 title/aria 带引擎名（可访问性不丢，"${(sr.title || "").slice(0, 30)}"）`);
const setNA = await ev(`(() => { const rows = [...document.querySelectorAll('[data-settings-live="provider"] .engine-row')]; const r = rows.find(x => (x.querySelector(".engine-badge")?.textContent || "").includes("Codex")); if (!r) return "NOROW"; return JSON.stringify({ swd: r.querySelector(".v8-swd")?.textContent ?? "", title: r.getAttribute("title") ?? "" }); })()`);
const sn = JSON.parse(setNA === "NOROW" ? "{}" : setNA);
ok(setNA !== "NOROW" && sn.swd === "未安装", `S5f 未装行=「未安装」二字（"${sn.swd}"）`);
ok((sn.title || "").includes("Codex"), "S5f2 未装行 title 带名");
const setUns = await ev(`(() => { const rows = [...document.querySelectorAll('[data-settings-live="provider"] .engine-row')]; const r = rows.find(x => (x.querySelector(".engine-badge")?.textContent || "").includes("iFlow")); return r ? (r.querySelector(".v8-swd")?.textContent ?? "") : "NOROW"; })()`);
ok(setUns === "未接入", `S5g unsupported=「未接入」二字（"${setUns}"）`);
const setTxt = await ev(`(document.querySelector('[data-settings-live="provider"]')?.textContent || "")`);
ok(!setTxt.includes("需先安装") && !setTxt.includes("暂不可用"), "S5h 设置面「需先安装/暂不可用」绝迹");
await shot("03-settings-engine");

console.log(BEFORE ? `\n${TAG}(before 基线): ${pass} passed（baseline-red=改动面证据）` : `\n${TAG}: ${pass} passed, ${fail} failed`);
writeFileSync(`${OUT}/summary.txt`, `pass=${pass} fail=${fail}\n`);
killChrome();
process.exit(fail ? 1 : 0);
