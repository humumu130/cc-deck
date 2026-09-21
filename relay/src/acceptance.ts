// 验收单在线表单（#125，2026-09-21）：发单方（agent 会话）把验收单登记为
// data/acceptances/<id>.json，用户浏览器打开 /acceptance/<id> 勾选提交，
// 结果落同目录 <id>.results.json（历史留痕，可改后重提）。
//
// 安全口径（用户拍板「注意安全，只针对本项目」）：
//   ① id 即凭证：32 hex 随机（128bit 不可枚举），必须命中已登记文件——瞎编 id 404，
//     与 relay 主 token 完全解耦（填表链接绝不携带主 token，避免链接转手泄露钥匙）
//   ② 提交限流：同 id 60s 窗口 10 次（内存 Map，进程级），超限 429
//   ③ body ≤ 64KB + 行数/枚举值/备注长度全量校验，脏数据一律 400
//   ④ 表单页与提交 API 同源，无 CORS 面；登记数据内嵌前做 < 转义（防注入）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";

export interface AcceptanceRow {
  task: string;
  item: string;
  criteria: string;
}
export interface Acceptance {
  id: string;
  title: string;
  created_at: number;
  preface?: string[];
  rows: AcceptanceRow[];
  notes?: string[];
}
export type Verdict = "pass" | "fail" | null;
export interface ResultRow {
  i: number;
  verdict: Verdict;
  note: string;
}

export const ACCEPTANCE_ID_RE = /^[0-9a-f]{32}$/;

export function acceptanceDir(): string {
  return process.env.CCR_ACCEPTANCE_DIR || join(homedir(), ".cc-deck", "data", "acceptances");
}

export function loadAcceptance(id: string): Acceptance | null {
  if (!ACCEPTANCE_ID_RE.test(id)) return null;
  const file = join(acceptanceDir(), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const a = JSON.parse(readFileSync(file, "utf-8")) as Acceptance;
    if (!a || !Array.isArray(a.rows) || a.rows.length === 0) return null;
    return a;
  } catch {
    return null;
  }
}

// ---- 提交限流（进程内存级；relay 单进程足够）----
const hits = new Map<string, number[]>();
export function rateLimited(id: string, limit = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(id, arr);
    return true;
  }
  arr.push(now);
  hits.set(id, arr);
  if (hits.size > 500) {
    // 清理过期键，防长期运行膨胀
    for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  }
  return false;
}

// 校验并落盘一次提交；返回错误串（null=成功）
export function saveResult(id: string, payload: unknown, ua: string): string | null {
  if (typeof payload !== "object" || payload === null) return "bad body";
  const rows = (payload as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) return "rows 非法";
  const clean: ResultRow[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) return "row 非法";
    const { i, verdict, note } = r as { i?: unknown; verdict?: unknown; note?: unknown };
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i > 1_000_000) return "行号非法";
    if (verdict !== "pass" && verdict !== "fail" && verdict !== null) return "判定值非法";
    if (note !== undefined && typeof note !== "string") return "备注非法";
    if (typeof note === "string" && note.length > 600) return "备注过长";
    clean.push({ i, verdict: verdict as Verdict, note: typeof note === "string" ? note : "" });
  }
  const dir = acceptanceDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.results.json`);
  let history: unknown[] = [];
  try {
    history = (JSON.parse(readFileSync(file, "utf-8")) as { history?: unknown[] }).history ?? [];
  } catch {}
  if (!Array.isArray(history)) history = [];
  const counts = {
    pass: clean.filter((r) => r.verdict === "pass").length,
    fail: clean.filter((r) => r.verdict === "fail").length,
    skip: clean.filter((r) => r.verdict === null).length,
  };
  history.push({ at: Date.now(), ua: ua.slice(0, 100), counts, rows: clean });
  writeFileSync(file, JSON.stringify({ id, history }, null, 1));
  return null;
}

// ---- 表单页（自包含单 HTML；勾选交互按用户口径：怎么简单怎么来）----
export function acceptanceHtml(a: Acceptance): string {
  const data = JSON.stringify(a).replace(/</g, "\\u003c");
  const preface = (a.preface ?? []).map((p) => `<p class="pf">${esc(p)}</p>`).join("");
  const notes = (a.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background:#0A0E14; color:#E6EDF3; font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; padding:20px 14px 120px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size:18px; margin-bottom:10px; }
  .pf { color:#9BA8B7; font-size:12.5px; margin:4px 0; }
  .bar { position:sticky; top:0; z-index:5; background:rgba(10,14,20,.92); backdrop-filter:blur(6px);
    display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #1C2430; margin-bottom:12px; }
  .bar b { color:#4D9FFF; font-variant-numeric:tabular-nums; }
  .card { background:#10161F; border:1px solid #1C2430; border-radius:12px; padding:12px 14px; margin-bottom:10px; }
  .r1 { display:flex; align-items:center; gap:8px; }
  .task { color:#4D9FFF; font-weight:700; font-size:12px; flex:none; }
  .item { flex:1; font-weight:600; font-size:14px; }
  .btns { display:flex; gap:8px; flex:none; }
  .vb { width:34px; height:34px; border-radius:50%; border:2px solid #2A3644; background:none;
    color:#5A6B7E; font-size:16px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .vb:active { transform:scale(.92); }
  .vb.on-pass { border-color:#2BD98F; background:#2BD98F; color:#06281B; }
  .vb.on-fail { border-color:#F0524F; background:#F0524F; color:#2B0A09; }
  .crit { color:#7E8B9B; font-size:12px; margin-top:6px; }
  .note { width:100%; margin-top:8px; background:#0A0E14; border:1px solid #1C2430; border-radius:8px;
    color:#E6EDF3; font:inherit; font-size:12.5px; padding:7px 10px; display:none; }
  .note.show { display:block; }
  .foot { position:fixed; left:0; right:0; bottom:0; padding:12px 14px calc(12px + env(safe-area-inset-bottom));
    background:rgba(10,14,20,.95); border-top:1px solid #1C2430; }
  .foot .wrap { display:flex; align-items:center; gap:12px; }
  #submit { flex:1; height:46px; border-radius:12px; border:1px solid #2E5FA3; background:#14314F;
    color:#4D9FFF; font-size:15px; font-weight:700; cursor:pointer; }
  #submit:disabled { opacity:.45; }
  #msg { font-size:12px; color:#9BA8B7; }
  .done { text-align:center; padding:40px 0; }
  .done .n { font-size:34px; font-weight:800; }
  ul.nt { color:#7E8B9B; font-size:12px; margin:12px 0 0 18px; }
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<div class="foot"><div class="wrap"><button id="submit">提交</button><span id="msg"></span></div></div>
<script>
var DATA = ${data};
var state = {};  // 行号 -> "pass"|"fail"|undefined（undefined=未测）
var app = document.getElementById("app");
var h = '<h1>' + esc(DATA.title) + '</h1>' + ${JSON.stringify(preface)} +
  '<div class="bar">已判 <b id="cnt">0</b> / ' + DATA.rows.length + '　<span style="color:#5A6B7E;font-size:12px">✓ 通过　✗ 不通过　不点=未测</span></div>';
for (var i = 0; i < DATA.rows.length; i++) {
  var r = DATA.rows[i];
  h += '<div class="card" id="c' + i + '"><div class="r1">' +
    '<span class="task">' + esc(r.task) + '</span><span class="item">' + esc(r.item) + '</span>' +
    '<span class="btns"><button class="vb" data-i="' + i + '" data-v="pass">✓</button>' +
    '<button class="vb" data-i="' + i + '" data-v="fail">✗</button></span></div>' +
    '<div class="crit">' + esc(r.criteria) + '</div>' +
    '<input class="note" id="n' + i + '" placeholder="问题/现象（选填）"></div>';
}
if (DATA.notes && DATA.notes.length) h += '<ul class="nt">' + ${JSON.stringify(notes)} + '</ul>';
app.innerHTML = h;
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function paint() {
  var n = 0;
  document.querySelectorAll(".vb").forEach(function (b) {
    var on = state[b.dataset.i] === b.dataset.v;
    b.className = "vb" + (on ? " on-" + b.dataset.v : "");
    if (on) n++;
  });
  document.getElementById("cnt").textContent = n;
  document.getElementById("submit").textContent = "提交验收（" + n + "/" + DATA.rows.length + "）";
  for (var i = 0; i < DATA.rows.length; i++) {
    var show = state[i] === "fail" || (document.getElementById("n" + i).value || "") !== "";
    document.getElementById("n" + i).className = "note" + (show ? " show" : "");
  }
}
document.addEventListener("click", function (e) {
  var b = e.target.closest(".vb");
  if (!b) return;
  var i = b.dataset.i;
  state[i] = state[i] === b.dataset.v ? undefined : b.dataset.v;  // 再点一次取消
  if (state[i] === "fail") document.getElementById("n" + i).focus();
  paint();
});
document.addEventListener("input", paint);
paint();
document.getElementById("submit").onclick = function () {
  var rows = [];
  for (var i = 0; i < DATA.rows.length; i++) {
    rows.push({ i: i, verdict: state[i] || null, note: (document.getElementById("n" + i).value || "").trim() });
  }
  document.getElementById("msg").textContent = "提交中…";
  fetch("/api/acceptance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: DATA.id, rows: rows }),
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { document.getElementById("msg").textContent = "提交失败：" + (j.error || "稍后再试"); return; }
    var p = 0, f = 0, s = 0;
    rows.forEach(function (r) { if (r.verdict === "pass") p++; else if (r.verdict === "fail") f++; else s++; });
    app.innerHTML = '<div class="done"><div class="n" style="color:#2BD98F">✓ ' + p + ' 通过</div>' +
      '<div class="n" style="color:#F0524F">' + f + ' 不通过</div>' +
      '<div class="n" style="color:#5A6B7E">' + s + ' 未测</div>' +
      '<p style="color:#9BA8B7;margin-top:16px">已提交（' + new Date().toLocaleTimeString() + '）。页面可以关了。</p></div>';
    document.querySelector(".foot").style.display = "none";
  }).catch(function () {
    document.getElementById("msg").textContent = "网络错误，稍后再试";
  });
};
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export function serveAcceptancePage(id: string, res: ServerResponse): boolean {
  const a = loadAcceptance(id);
  if (!a) return false;
  const html = acceptanceHtml(a);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
  return true;
}
