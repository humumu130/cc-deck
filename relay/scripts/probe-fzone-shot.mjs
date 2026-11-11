// [W-FZONE-B1] 文件工作区批一 CDP 截图+断言探针（1111 拍板 B：tab 骨架+三格式+点击链路）。
// 骨架复用 probe-dockfix-shot（headless Chrome 直开 index-005.html + __ccDeck005Frames 注帧）；
// 零 relay 依赖：本机真 relay（8787/8788）用 Network.setBlockedURLs 断链防真 SNAPSHOT 竞态，
// ARTIFACT_FETCH 回包走假 ws（readyState=1 + send 侦）→ 假 ACK/CHUNK 帧进真 settle 管线
//（fetchArtifact→maybeSettleArt→loadFzoneContent 渲染全真）。直跑：cd relay && node scripts/probe-fzone-shot.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9841 + Math.floor(Math.random() * 300);
const OUT = `/Users/xdd/.cc-deck/artifacts/fzone-shots`;
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/fzone-cdp-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
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
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
// 隔离真 relay（本机 8787/8788 在听——真 SNAPSHOT 与注帧竞态=抖动根，dockfix 探针同坑）：
// 断本机网络源后 reload，页面状态单源由 __ccDeck005Frames 注入驱动
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*"] });
await send("Page.reload");
await wait(3200);
for (let i = 0; i < 5; i++) {
  const st = await ev(`JSON.stringify({ rs: document.readyState, fz: !!document.getElementById("fzone"), url: location.href.slice(0, 60) })`).catch(() => null);
  if (st && JSON.parse(st).fz && JSON.parse(st).rs === "complete") break;
  await wait(1200);
}
// ---------- 夹具（reload 后装，reload 会清早装的一切页内状态）：三格式回包 + clipboard 兜底 + 单源路由 ----------
const b64 = (s) => Buffer.from(s, "utf-8").toString("base64");
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const MD_DOC = "# 批四回执\n\n- 七件全部收单 ✓\n- 磁盘报告已生成\n\n## 明细\n\n```ts\nconst guard = \"strict\"; // 引擎护栏\n```\n\n**完成** · 2026-11-11\n";
const TS_DOC = "// W-ENGSEC：非 claude 引擎统一安全层\nexport const BUILTIN_PATTERNS = [\n  { id: \"rm-recursive\", re: 1 },\n];\n\nexport function match(cmd: string): boolean {\n  return BUILTIN_PATTERNS.some((p) => p.re === 1);\n}\n";
const FIX = {
  "reports/w-p2batch4.md": { mime: "text/markdown", b64: b64(MD_DOC) },
  "src/engine-guard.ts": { mime: "text/plain", b64: b64(TS_DOC) },
  "assets/disk-report.png": { mime: "image/png", b64: PNG_1PX },
  "assets/hero-shot.png": { mime: "image/png", b64: PNG_1PX }, // W-FZONE-B1-R1 P2-②：第二张图（双图并存断言夹具）
};
const FIX_JSON = JSON.stringify(FIX);
const now = Date.now();
const sess = { session_id: "fz-demo", title: "文件工作区演示", status: "DONE", engine: "claude", model: "glm-5.3", cwd: "/tmp/fz-demo", updated_at: now - 3e4, started_at: now - 9e5, duration_ms: 245000, context_usage: 84000, context_limit: 200000, artifacts: [
  { path: "reports/w-p2batch4.md", size: 500, last_at: now - 60e3, first_at: now - 120e3, op: "create", exists: true },
  { path: "src/engine-guard.ts", size: 300, last_at: now - 90e3, first_at: now - 120e3, op: "create", exists: true },
  { path: "assets/disk-report.png", size: 100, last_at: now - 45e3, first_at: now - 120e3, op: "create", exists: true },
  { path: "assets/hero-shot.png", size: 100, last_at: now - 44e3, first_at: now - 120e3, op: "create", exists: true },
  { path: "reports/gone.md", size: 10, last_at: now - 30e3, first_at: now - 120e3, op: "create", exists: true },
] };
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [sess], notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`(() => {
  const FIX = ${FIX_JSON};
  try { navigator.clipboard.writeText = () => Promise.resolve(); } catch (_) {}
  window.addEventListener("error", (e) => { (window.__fzErrs = window.__fzErrs || []).push(String(e.message).slice(0, 80)); });
  window.addEventListener("unhandledrejection", (e) => { (window.__fzErrs = window.__fzErrs || []).push("rej:" + String(e.reason && e.reason.message || e.reason).slice(0, 80)); });
  window.__ccDeck005RouteWs = null; // 探针单源：关双源路由（fz-demo 不在桥 ctx.sessions→RouteWs 恒返 null 卡死拉取），sendCmd 落回下方假 ws
  window.__ccDeck005MainWs = { readyState: 1, send: (str) => {
    const cmd = JSON.parse(str);
    (window.__fzCmdLog = window.__fzCmdLog || []).push(cmd.type + ":" + (cmd.payload && cmd.payload.session_id || ""));
    if (cmd.type !== "COMMAND_ARTIFACT_FETCH") return;
    const fix = FIX[cmd.payload.path];
    setTimeout(() => {
      if (!fix) { window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "COMMAND_ACK", payload: { command_id: cmd.command_id, ok: false, error: "探针无此夹具（模拟拉取失败）" } } }); return; }
      window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "COMMAND_ACK", payload: { command_id: cmd.command_id, ok: true, artifact: { mime: fix.mime, size: fix.b64.length } } } });
      window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: { type: "ARTIFACT_CHUNK", payload: { ref: cmd.command_id, seq: 0, total: 1, b64: fix.b64, done: true } } });
    }, 40);
  } };
})()`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
await ev(`document.querySelector('[data-session-card="fz-demo"]').click()`);
// 断真 relay 后地基选卡链（click→地基→relay→回标 .selected）断裂，S.selected 靠 MutationObserver
// 读 .queue-card.selected 同步（session-domain bindEvents「选中链由地基驱动」）——手动补标记类：
await ev(`document.querySelector('[data-session-card="fz-demo"]').classList.add("selected")`);
await wait(1000);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const fzState = `(() => { const z = document.getElementById("fzone"); if (!z) return null; return { hidden: z.hidden, tabs: window.ccDeckFzone ? window.ccDeckFzone.tabs() : [], active: (z.querySelector(".wtab.on .fname")||{}).textContent || "", w: z.getBoundingClientRect().width, md: !!z.querySelector(".fz-md .md-h1"), code: !!z.querySelector(".fz-code .fz-code-n"), kw: !!z.querySelector(".fz-code .s-kw"), img: ((z.querySelector(".fz-img")||{}).src||"").slice(0,10), urls: [...z.querySelectorAll("[data-fz-pane]")].map((p) => p.dataset.fzUrl || ""), fb: (z.querySelector(".fz-fb span:nth-child(2)")||{}).textContent || "", ghost: !!z.querySelector("[data-fz-empty]") }; })()`;
const fzRead = async () => JSON.parse(await ev(`JSON.stringify(${fzState})`));
// 重试点击：headless 双环境（CDP 注帧+断网单源）下首次点击落在页面 settle 窗内会被吞——
// 贴真实用户语义（无反馈就再点一次），断言只校验终态
const clickRow = async (sel, want) => {
  let st = null;
  for (let i = 0; i < 5; i++) {
    await ev(`(() => { const r = document.querySelector('${sel}'); if (r) r.click(); })()`).catch(() => {});
    await wait(650);
    st = await fzRead();
    if (!want || want(st)) return st;
  }
  return st;
};

// ① 冷启态：面板 hidden + 头部常驻开关钮在场
const tgl = await ev(`!!document.querySelector('#session-head-actions [data-fzone-toggle]')`);
const s0 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(tgl && s0 && s0.hidden, "冷启：面板隐藏 + 头部「▤ 工作区」常驻钮在场");


// ② 点 md 产物行 → 开 tab + md 渲染（消息同款 md-h1/md-code）
const s1 = await (async () => {
  const r = await ev(`(() => {
    const junk = [];
    for (let i = 0; i < 2000; i++) junk.push({ i, s: "x".repeat(20) }); // 纯工作量（无包装器）
    const rr = document.querySelector('.art-row[data-path="reports/w-p2batch4.md"]');
    if (!rr) return { err: "NO ROW" };
    rr.click();
    const z = document.getElementById("fzone");
    return { tabs: window.ccDeckFzone.tabs(), hidden: z.hidden, rowsN: document.querySelectorAll(".art-row").length, attached: rr.isConnected };
  })()`).catch(() => null);
  await wait(700);
  return JSON.parse(await ev(`JSON.stringify(${fzState})`));
})();
ok(!s1.hidden && s1.tabs.length === 1 && s1.active === "w-p2batch4.md", "点行开 tab：1 tab 激活 w-p2batch4.md");
ok(s1.md, "md 预览=mdHtml 同款（.md-h1 渲染锚在场）");
ok(Math.abs(s1.w / 1440 - 0.38) < 0.03, `缺省宽=38%（实测 ${(s1.w / 1440 * 100).toFixed(1)}%）`);
ok(!s1.ghost, "空态提示卡随首 tab 开启退场（display:flex 压 [hidden] 坑已修）");

await shot("fz-1-md-dark");

// ③ 再点 ts 产物行 → 双 tab 并存 + 代码渲染（行号+高亮）
const s2 = await clickRow('.art-row[data-path="src/engine-guard.ts"]', (t) => t.tabs.length >= 2);
ok(s2.tabs.length === 2 && s2.active === "engine-guard.ts", `双 tab 并存：${s2.tabs.join(" + ")}，新开自激活`);
ok(s2.code && s2.kw, "代码预览=行号槽+轻量高亮（.fz-code-n+.s-kw 在场）");

await shot("fz-2-code-dark");

// ④ 同文件重开=聚焦不重复（任务书铁则）
await clickRow('.art-row[data-path="reports/w-p2batch4.md"]', (t) => t.active === "w-p2batch4.md");
const s3 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(s3.tabs.length === 2 && s3.active === "w-p2batch4.md", "同文件重开=聚焦已有 tab 不重复（仍 2 tabs，md 自激活）");


// ⑤ tab 按钮切换 + 图片第三 tab
await ev(`document.querySelector('#fzone [data-fz-tab][title="src/engine-guard.ts"]').click()`); await wait(300);
const s4 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(s4.active === "engine-guard.ts", "点 tab 切换激活");
const s5 = await clickRow('.art-row[data-path="assets/disk-report.png"]', (t) => t.tabs.length >= 3);
ok(s5.tabs.length === 3 && s5.active === "disk-report.png" && s5.img.startsWith("blob:"), "三 tab 并存+图片 blob 加载（file:// 页 blob:null 前缀同义）");

// ⑤b 双图并存（W-FZONE-B1-R1 P2-②）：开第二张图 → 两图 pane 各持独立 blob url（单槽互踩已修）
const s5b = await clickRow('.art-row[data-path="assets/hero-shot.png"]', (t) => t.tabs.length >= 4);
ok(s5b.tabs.length === 4 && s5b.urls.filter(Boolean).length === 2 && new Set(s5b.urls.filter(Boolean)).size === 2, "双图并存 per-tab blob 槽：两图 pane 各持独立 url（开第二张不再 revoke 第一张）");
ok(await ev(`(() => { const a = [...document.querySelectorAll("#fzone .fz-img")]; return a.length === 2 && a.every((i) => i.complete && i.naturalWidth > 0); })()`), "双图均加载成功（naturalWidth>0，首图未被中途撤销）");

await shot("fz-3-img-dark");

// ⑥ 中键关闭 png tab（spec 交互流）
await ev(`(() => { const t = document.querySelector('#fzone [data-fz-tab][title="assets/disk-report.png"]'); t.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })); })()`);
await wait(400);
const s6 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(s6.tabs.length === 3 && !s6.tabs.includes("assets/disk-report.png"), "中键关闭 png tab（剩 3）");

// ⑦ 消息文本路径 token：登记面命中=开/聚焦工作区；未登记=复制兜底零动作
await ev(`(() => { const cp = document.querySelector("#session-body .conversation-pane"); const b = document.createElement("div"); b.className = "md-p"; b.innerHTML = '已改 <span class="fpath" data-p="src/engine-guard.ts">src/engine-guard.ts</span> 与 <span class="fpath" data-p="/etc/hosts">/etc/hosts</span>'; cp.appendChild(b); })()`);
await ev(`document.querySelector('#session-body .fpath[data-p="src/engine-guard.ts"]').click()`); await wait(400);
const s7 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(s7.tabs.length === 3 && s7.active === "engine-guard.ts", "入口②登记命中：消息路径 token 点击=聚焦工作区 tab");

await ev(`document.querySelector('#session-body .fpath[data-p="/etc/hosts"]').click()`); await wait(400);
const s8 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(s8.tabs.length === 3, "入口②未登记路径零动作（/etc/hosts 不开 tab，复制兜底）");

// ⑧ 眼睛钮改道（data-af-view → 工作区 tab，不再 av 模态）
await ev(`document.querySelector('.art-row[data-path="reports/w-p2batch4.md"] [data-af-view]').click()`);
await wait(400);
const noAv = await ev(`!document.getElementById("av-backdrop")`);
const s9 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(noAv && s9.tabs.length === 3 && s9.active === "w-p2batch4.md", "眼睛钮=工作区 tab（av 模态 backdrop 未弹出）");


// ⑨ 逐个关闭：中键关到最后 → 面板自动收起+开合记忆
await ev(`(() => { const t = document.querySelector('#fzone [data-fz-tab][title="src/engine-guard.ts"]'); t.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })); })()`);
await wait(300);
await ev(`(() => { const t = document.querySelector('#fzone [data-fz-tab][title="reports/w-p2batch4.md"]'); t.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })); })()`);
await wait(300);
await ev(`(() => { const t = document.querySelector('#fzone [data-fz-tab][title="assets/hero-shot.png"]'); t.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })); })()`);
await wait(500);
const s10 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
const mem = await ev(`localStorage.getItem("ccd_fzone_open")`);
ok(s10.hidden && s10.tabs.length === 0 && mem === "0", `关最后一个 tab=面板收起+开合记忆（ccd_fzone_open=${mem}）`);

// ⑩ 头部常驻钮再展开（收起后唯一入口）→ 空态提示卡
await ev(`document.querySelector('#session-head-actions [data-fzone-toggle]').click()`); await wait(400);
const s11 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(!s11.hidden && s11.tabs.length === 0 && s11.ghost, "常驻钮再展开+空态提示卡在场");
await shot("fz-4-empty-dark");

// ⑪ 失败态/重试钮面（登记在册但回包 ok:false → tab 内错误卡+重试）+ 拖宽柄在场
await clickRow('.art-row[data-path="reports/gone.md"]', (t) => t.tabs.length >= 1);
const s12 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
const hasRetry = await ev(`!!document.querySelector('#fzone [data-fz-retry]')`);
const hasRz = await ev(`!!document.querySelector('#fzone [data-fz-resize]')`);
ok(s12.tabs.length === 1 && hasRetry && (s12.fb || "").includes("拉取失败"), `失败态=tab 内错误卡+重试钮（「${(s12.fb || "").slice(0, 30)}」）`);
ok(hasRz, "拖宽柄在场（38% 起可拖）");

// ⑪b 切会话清空（W-FZONE-B1-R1 P2-①）：resetForSession 异 sid → tab 全清+开合态不动+空态卡回归；同 sid 重入幂等
const hidB = await ev(`document.getElementById("fzone").hidden`);
await ev(`window.ccDeckFzone.resetForSession("fz-other")`); await wait(250);
const s12b = JSON.parse(await ev(`JSON.stringify(${fzState})`));
await ev(`window.ccDeckFzone.resetForSession("fz-other")`); await wait(150);
const s12c = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(s12b.tabs.length === 0 && s12b.hidden === hidB && s12b.ghost && s12c.tabs.length === 0, "切会话清空：resetForSession 异 sid 清空全部 tab（开合态不动+空态卡回归；同 sid 重入幂等零动作）");

// ⑫ 亮色主题：md 预览对照（重试 gone.md 无妨——再点 md 行看亮色 md 渲染）
await ev(`(() => { const b = document.querySelector('[data-theme-toggle]'); if (b) b.click(); })()`);
await wait(500);
await clickRow('.art-row[data-path="reports/w-p2batch4.md"]', (t) => t.md);
const s13 = JSON.parse(await ev(`JSON.stringify(${fzState})`));
ok(s13.md, "亮色主题 md 预览渲染在场");
await shot("fz-5-md-light");
await ev(`(() => { const b = document.querySelector('[data-theme-toggle]'); if (b) b.click(); })()`); await wait(300);

ok(consoleErrs.length === 0, `console 零错（${consoleErrs.length} 条${consoleErrs.length ? "：" + consoleErrs.slice(0, 2).join(" | ") : ""}）`);
console.log(`\nfzone probe：${pass} ok / ${fail} FAIL`);
writeFileSync(`/tmp/fzone-probe.json`, JSON.stringify({ s0hidden: s0.hidden, s1, s3, s5, s12 }, null, 1));
globalThis.__p.kill(); process.exit(fail ? 1 : 0);
