// W-UI-ASKRENDER CDP 探针：AskUserQuestion 问卷卡渲染（改后树 vs 改前基线树双跑）。
// 工艺：file:// 直开 index-005.html + SNAPSHOT 帧注入（logs 携时间线）——不起 relay、
// 零 CLI transcript、零生产会话污染（PM 探针防污染口径）。输出 /tmp/w-askrender/<side>-*.png
// 用法：node probe-askrender.mjs <after|before>
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js");

const side = process.argv[2] || "after";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = side === "after" ? 9341 : 9342;
const WTREE = side === "after" ? "/private/tmp/cc-deck-w-ui-askrender" : "/private/tmp/cc-deck-w-approval-timeout"; // before=同基线 commit 干净树（改前对照）
const OUT = "/tmp/w-askrender";
const URL0 = `file://${WTREE}/web-console/index-005.html`;
mkdirSync(OUT, { recursive: true });
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/ask-cdp-" + side, "--window-size=1440,960", URL0], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(2200);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find((t) => t.type === "page" && t.url.includes("index-005"));
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
await send("Page.enable"); await send("Runtime.enable");
await wait(1600);

// ---------- 快照注入：两会话 + 四形态 ask 时间线 + 零回归对照行 ----------
const now = Date.now();
const askDetail = (qs) => "questions: " + JSON.stringify(qs);
const D_MULTI2Q = askDetail([
  { question: "部署目标环境选哪个？", header: "环境", options: [{ label: "测试通道", description: "test tag 出包，验证期不碰 dev" }, { label: "快照通道", description: "snapshot 攒批后发正式" }] },
  { question: "出包后验收单走谁？", header: "验收", options: [{ label: "PM 汇总单" }, { label: "worker 自带", description: "回执里带验收点" }] },
]);
const D_MANYOPT = askDetail([
  { question: "日志输出格式用哪种？", header: "日志", options: [{ label: "JSON 结构化", description: "机器可解析，配 jq 食用" }, { label: "单行文本", description: "人读友好，grep 直查" }, { label: "CSV", description: "表格工具直开" }, { label: "二进制 + 索引", description: "体积最小，需配套读取器" }] },
]);
const D_MULTI_SEL = askDetail([
  { question: "这次发布带上哪些附页？（可多选）", header: "附页", multiSelect: true, options: [{ label: "架构图", description: "archify 出图 @2x" }, { label: "更新说明", description: "军规六条措辞" }, { label: "验收清单", description: "四段结构" }] },
]);
const D_PREVIEW = askDetail([
  { question: "卡片配色方案定哪版？", header: "配色", options: [{ label: "A · 靛蓝主色", description: "现状基线", preview: ":root { --brand: #4f6df5 }" }, { label: "B · 青绿主色", description: "对比度更高", preview: ":root { --brand: #12a594 }" }, { label: "C · 保持不动", description: "本批不改" }] },
]);
const logs = {
  "s-ask": [
    { kind: "user_message", text: "帮我把这次发版的几个决策点问清楚", ts: now - 600e3 },
    { kind: "assistant_text", text: "好，四个问题一次问清。", ts: now - 590e3 },
    { kind: "tool_use", tool: "AskUserQuestion", text: "AskUserQuestion", detail: D_MULTI2Q, ts: now - 580e3 },
    { kind: "tool_result", text: "用户已作答", ts: now - 575e3 },
    { kind: "tool_use", tool: "AskUserQuestion", text: "AskUserQuestion", detail: D_MANYOPT, ts: now - 540e3 },
    { kind: "tool_use", tool: "AskUserQuestion", text: "AskUserQuestion", detail: D_MULTI_SEL, ts: now - 500e3 },
    { kind: "tool_use", tool: "AskUserQuestion", text: "AskUserQuestion", detail: D_PREVIEW, ts: now - 460e3 },
    { kind: "tool_use", tool: "Bash", text: "执行 git status --short", detail: "$ git status --short", ts: now - 420e3 },
    { kind: "tool_use", tool: "Write", text: "写入 docs/plan.md", detail: "docs/plan.md\n# 计划", ts: now - 410e3 },
    { kind: "tool_use", tool: "TaskCreate", text: "新建 发版决策批", ts: now - 400e3 },
    { kind: "assistant_text", text: "问题都问完了，等你拍板。", ts: now - 390e3 },
  ],
};
const wq = [
  { header: "选库", question: "任务表落哪个数据库？", multi: false, options: [{ label: "SQLite", description: "嵌入式零运维，单文件" }, { label: "PostgreSQL", description: "独立服务，并发强" }] },
  { header: "迁移", question: "迁移窗口怎么排？（可多选）", multi: true, options: [{ label: "先双写", description: "灰度期两写对账" }, { label: "直接切换", description: "停机 10 分钟一把过" }] },
];
const snap = {
  type: "SNAPSHOT", payload: {
    relay_name: "ask-probe", token_valid: true, homedir: "/Users/xdd", platform: "darwin",
    sessions: [
      { session_id: "s-ask", title: "发版决策四连问", status: "DONE", engine: "claude", model: "", updated_at: now - 390e3, started_at: now - 610e3, cwd: "/tmp/askprobe" },
      { session_id: "s-wait", title: "等回答的会话", status: "WAITING", engine: "claude", model: "", updated_at: now, started_at: now - 120e3, cwd: "/tmp/askprobe",
        waiting_request: { request_id: "rq-1", tool_name: "AskUserQuestion", input_summary: "", suggestions: [], received_at: now - 5e3, request_started_at: now - 6e3, decidable: true, questions: wq } },
    ],
    logs, logs_truncated: {},
  },
};
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(900);
// 等待卡 preview 借源：s-wait 时间线补一条 ask 条目（题干对齐 wq，带 preview）
const borrow = { type: "SESSION_LOG", session_id: "s-wait", payload: { kind: "tool_use", tool: "AskUserQuestion", text: "AskUserQuestion", detail: askDetail([
  { header: "选库", question: "任务表落哪个数据库？", options: [{ label: "SQLite", description: "嵌入式零运维，单文件" }, { label: "PostgreSQL", description: "独立服务，并发强", preview: "ER 图…" }] },
  { header: "迁移", question: "迁移窗口怎么排？（可多选）", multiSelect: true, options: [{ label: "先双写" }, { label: "直接切换" }] },
]), occurred_at: now - 30e3 } };
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(borrow)} })`);
await wait(600);

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? "  ok " : "  FAIL ") + n); };
const shot = async (name) => { await send("Page.captureScreenshot", { format: "png" }).then((r) => { if (r.result && r.result.data) { require("node:fs").writeFileSync(`${OUT}/${side}-${name}.png`, Buffer.from(r.result.data, "base64")); } }); };

// ---------- 会话域：选中 s-ask，展开时间线 ----------
await ev(`document.querySelector('.rail-btn[data-domain="session"]')?.click()`);
await wait(700);
await ev(`document.querySelector('.queue-card[data-session-card="s-ask"]')?.click()`);
await wait(900);
// proc 开关确保在（默认开；关了就点开）
await ev(`(() => { const b = document.querySelector('[data-conv-toggle="proc"]'); if (b && !b.classList.contains("on")) b.click(); return true; })()`);
await wait(600);
// 过程组展开（连续工具行折叠在 procgrp 里）
await ev(`(() => { document.querySelectorAll(".proc-head").forEach((h) => h.click()); return document.querySelectorAll(".trow").length; })()`);
await wait(600);
const rowCount = await ev(`document.querySelectorAll("#d-session .trow").length`);
ok(rowCount >= 7, `会话时间线渲染 ${rowCount} 行（4 ask + Bash/Write/Task + 组行）`);
await shot("1-ask-collapsed");

// 展开态：逐个点开 ask 行（after 树=.ask-tags 行；before 树=tname 含 AskUserQuestion 的行）
const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll('#d-session .trow')].filter((r) => r.querySelector(".ask-tags") || r.querySelector(".tname")?.textContent.includes("AskUserQuestion"));
  let n = 0;
  rows.forEach((r) => { const x = r.querySelector(".x-full"); if (x) { x.click(); n++; } });
  return n;
})()`);
await wait(700);

if (side === "after") {
  // ---- 断言（改后树）----
  const collapsedOk = await ev(`(() => {
    const rows = [...document.querySelectorAll('#d-session .trow')];
    const askRows = rows.filter((r) => r.querySelector(".ask-tags"));
    const sums = askRows.map((r) => r.querySelector(".tsum")?.textContent || "");
    return askRows.length + "|" + sums.join("／");
  })()`);
  ok(/^\d+\|/.test(collapsedOk) && collapsedOk.split("|")[0] === "4", `折叠态 4 条 ask 行带摘要+标签（${collapsedOk.split("|").slice(1).join(" ／ ")}）`);
  ok(collapsedOk.includes("个问题"), "折叠态友好摘要文案（N 个问题 · 首问截断）");
  const tagsOk = await ev(`document.querySelectorAll('#d-session .ask-tag').length`);
  ok(tagsOk === 5, `header 标签行渲染 ${tagsOk} 枚（环境/验收/日志/附页/配色）`);
  const cards = await ev(`document.querySelectorAll('#d-session .ask-card').length`);
  ok(cards === 4, `展开态 4 张问卷卡（实际 ${cards}）`);
  const optRows = await ev(`document.querySelectorAll('#d-session .wq-opt').length`);
  ok(optRows === 14, `静态选项行 14 条（2+2 + 4 + 3 + 3）（实际 ${optRows}）`);
  const prevMarks = await ev(`[...document.querySelectorAll('#d-session .wo-prev')].filter((e) => e.textContent === "含预览").length`);
  ok(prevMarks === 2, `「含预览」标记 2 枚（A/B 配色项，实际 ${prevMarks}）`);
  const multiTag = await ev(`[...document.querySelectorAll('#d-session .wq-multi-tag')].length`);
  ok(multiTag === 1, `「可多选」标 1 枚（附页题，实际 ${multiTag}）`);
  const descRow = await ev(`[...document.querySelectorAll('#d-session .wo-desc')].some((e) => e.textContent.includes("机器可解析"))`);
  ok(descRow, "选项 description 次行渲染（日志题 JSON 项）");
  // 零回归：Bash/Write/Task 行
  const bashOk = await ev(`(() => { const r = [...document.querySelectorAll('#d-session .trow')].find((x) => x.textContent.includes("执行 git status")); return !!(r && r.querySelector("[data-copy]")); })()`);
  ok(bashOk, "Bash 行零回归（copy 钮+摘要）");
  const taskOk = await ev(`(() => { const r = [...document.querySelectorAll('#d-session .trow')].find((x) => x.getAttribute("data-role") === "task"); return !!(r && r.textContent.includes("新建")); })()`);
  ok(taskOk, "TaskCreate 生命周期行零回归");
  const noJson = await ev(`(() => { const t = [...document.querySelectorAll('#d-session .trow')].filter((x) => x.querySelector(".ask-tags")).map((x) => x.textContent); return t.some((s) => s.includes('"question"') || s.includes("{")); })()`);
  ok(!noJson, "ask 行不再出现拍扁 JSON");
  await shot("2-ask-expanded");
} else {
  // ---- 改前基线：断言旧拍扁形态 + 截图 ----
  // 逐轮重查 DOM 点未展开的 ask 行（replaceWith 后旧引用失效——批量 forEach 会落空）
  for (let round = 0; round < 4; round++) {
    await ev(`(() => { const r = [...document.querySelectorAll('#d-session .trow')].find((x) => (x.querySelector(".tname")?.textContent || "").includes("AskUserQuestion") && !x.querySelector(".tdetail")); const x = r && r.querySelector(".x-full"); if (x) x.click(); return !!x; })()`);
    await wait(250);
  }
  const jsonShown = await ev(`[...document.querySelectorAll('#d-session .tdetail')].filter((e) => e.textContent.includes('questions:')).length`);
  ok(jsonShown === 4, `改前形态锁定：拍扁 JSON detail 块 ${jsonShown}/4 处（丑态证据）`);
  await shot("2-ask-expanded");
}

// ---------- 等待卡（WAITING 会话）----------
await ev(`document.querySelector('.queue-card[data-session-card="s-wait"]')?.click()`);
await wait(900);
if (side === "after") {
  const wc = await ev(`(() => { const c = document.querySelector(".wait-card[data-b2-wait]"); if (!c) return "NO_CARD"; return JSON.stringify({
    groups: c.querySelectorAll(".wait-qgroup").length,
    chips: c.querySelectorAll(".wait-chip.row").length,
    optBtns: c.querySelectorAll("[data-wait-answer]").length,
    submit: !!c.querySelector("[data-wait-submit]"),
    deny: !!c.querySelector("[data-wait-deny]"),
    prevMarks: [...c.querySelectorAll(".wo-prev")].length,
    multiTags: [...c.querySelectorAll(".wq-multi-tag")].length,
    desc: [...c.querySelectorAll(".wo-desc")].map((e) => e.textContent).join(","),
  }); })()`);
  ok(wc !== "NO_CARD", "等待卡渲染");
  const w = (() => { try { return JSON.parse(wc); } catch { return {}; } })();
  ok(w.groups === 2, `等待卡 2 问分组（实际 ${w.groups}）`);
  ok(w.chips === 4 && w.submit === true, `多问题卡整卡 chips 形态（原交互语义：2 问 4 chips）+ 提交回答钮`);
  ok(w.optBtns === 0, `多问题卡无即答钮（单问卡才走 data-wait-answer——原 single 语义保持）（${w.optBtns}）`);
  ok(w.prevMarks === 1, `preview 借源标记 1 枚（PostgreSQL 含预览，实际 ${w.prevMarks}）`);
  ok(w.multiTags === 1 && (w.desc || "").includes("嵌入式零运维"), "多选标+description 次行");
  await shot("3-waitcard");
  // 交互冒烟：多选 toggle + 单选点击样式（不真发命令——commandAck 走 ws 会失败但 UI 态可验）
  await ev(`document.querySelector('.wait-card [data-wait-chip="1:0"]')?.click()`);
  await wait(200);
  const onCls = await ev(`document.querySelector('.wait-card [data-wait-chip="1:0"]')?.classList.contains("on")`);
  ok(onCls === true, "多选 chip toggle 选中态（原交互链）");
  await shot("4-waitcard-interacted");
  // 深色 → 浅色主题再截两张
  await ev(`document.querySelector("[data-theme-toggle]")?.click()`);
  await wait(500);
  const theme = await ev(`document.documentElement.getAttribute("data-theme") || document.body.getAttribute("data-theme") || "unknown"`);
  await shot("5-expanded-light");
  await ev(`document.querySelector('.queue-card[data-session-card="s-ask"]')?.click()`);
  await wait(600);
  await ev(`(() => { document.querySelectorAll(".proc-head").forEach((h) => h.click()); [...document.querySelectorAll('#d-session .trow')].filter((r) => r.querySelector(".ask-tags")).forEach((r) => r.querySelector(".x-full")?.click()); return true; })()`);
  await wait(500);
  await shot("6-askcard-light");
  console.log(`theme=${theme}`);
} else {
  const oldCard = await ev(`(() => { const c = document.querySelector(".wait-card[data-b2-wait]"); if (!c) return "NO_CARD"; return JSON.stringify({ copy: c.querySelector(".wait-copy")?.textContent || "", optBtns: c.querySelectorAll("[data-wait-answer]").length, groups: c.querySelectorAll(".wait-qgroup").length, descs: c.querySelectorAll(".wo-desc").length }); })()`);
  const oc = (() => { try { return JSON.parse(oldCard); } catch { return null; } })();
  ok(!!oc && oc.copy.includes("／") && oc.descs === 0, `改前等待卡形态锁定：题干「／」拼接纯文本+零选项描述行（${(oc && oc.copy || "").slice(0, 40)}…）`);
  await shot("3-waitcard");
}

console.log(`\n[${side}] ${pass} passed, ${fail} failed`);
globalThis.__p.kill();
process.exit(fail > 0 ? 1 : 0);
