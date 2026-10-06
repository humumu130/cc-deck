// #018-W2b 输出物组级失败/不可达 + wait-card 回原 session 静态锚点测试。
// 断言面：组折叠既有锚点（防回退前提面）、组级 outcome 三态、不可达探测重试链、
// 请求失败组尾收口条、waitBind 冻结绑定 + ackVerdict ok:true 严判（W1b 判定门口径）、
// 词汇（新文案无团队级 Leader 词）、结构闸。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-w2b-artifacts.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-console");
const html = readFileSync(join(webDir, "index.html"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function count(hay: string, needle: string) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
function blockOf(startMark: string, endMark: string): string {
  const a = html.indexOf(startMark);
  if (a < 0) return "";
  const b = html.indexOf(endMark, a);
  return b < 0 ? "" : html.slice(a, b);
}
function cssBlock(selector: string): string {
  const i = html.indexOf(selector + " {");
  if (i < 0) return "";
  let depth = 0, j = html.indexOf("{", i);
  const start = j;
  for (; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  return "";
}

console.log("== #018-W2b artifacts group + wait-card: static anchors ==");

// ---- ① 组折叠面（#222 既有锚点防回退——本批前提面） ----
ok(html.includes("const artFoldSt = new Map()"), "artFoldSt fold-state map intact");
ok(/function toggleFgroup\(frow\) \{/.test(html), "toggleFgroup fold flip intact");
ok(html.includes('aria-expanded'), "group head aria-expanded attr present");
ok(/class="afrow frow" role="button" tabindex="0"/.test(html), "group head is an accessible button row");
ok(html.includes('<span class="badge b-cnt">×'), "group head file-count badge intact");
ok(html.includes('grp?.classList.contains("open") ? "收起" : "展开"'), "folder menu keeps collapse toggle item");
ok(html.includes(".fgroup > .fkids { display: none; }") && html.includes(".fgroup.open > .fkids { display: block; }"), "collapsed/expanded CSS pair intact");

// ---- ② 组级 outcome 三态（exists:false 快照投影） ----
ok(/const deadN = g\.files\.filter\(\(t\) => t\.exists === false\)\.length;/.test(html), "deadN counted from exists===false");
ok(/deadN >= g\.files\.length \? "failed" : deadN > 0 \? "partial" : "complete"/.test(html), "outcome tri-state: all-dead failed / partial / complete");
ok(html.includes('" data-artifact-outcome="\' + outcome'), "fgroup emits data-artifact-outcome");
ok(html.includes("'<span class=\"af-deadbadge\">目录不可达</span>'"), "failed badge: 目录不可达");
ok(html.includes("'<span class=\"af-deadbadge\">' + deadN + \" 个失效</span>\""), "partial badge: N 个失效");
ok(cssBlock(".af-deadbadge") !== "", "css rule .af-deadbadge");

// ---- ③ 不可达组重试链（探测语义） ----
ok(/class="af-batch-err' \+ \(outcome === "failed" \? " hard" : ""\)/.test(html), "group retry bar markup (hard variant for failed)");
ok(html.includes('<button class="af-deadretry" data-dir="'), "dead-group retry button carries data-dir");
ok(html.includes("源端已无这些文件——或快照未刷新，可重试核实"), "failed bar copy (not silent)");
ok(html.includes(" 个文件源端已不存在，可重试核实"), "partial bar copy (not silent)");
ok(/async function retryDeadGroup\(ctx, sid, dir\) \{/.test(html), "retryDeadGroup probe fn present");
const retryFn = blockOf("async function retryDeadGroup", "function markArtFetchError");
ok(retryFn.includes("t.exists === false"), "probe targets only dead files");
ok(retryFn.includes("artDirOf(s, t)"), "probe groups by artDirOf key");
ok(retryFn.includes("Math.min(3, dead.length)"), "probe concurrency capped at 3");
ok(retryFn.includes("不存在|不可访问"), "probe verdict: relay dead-file ACK signature");
ok(retryFn.includes("20MB 上限"), "probe verdict: oversize counts as reachable");
ok(retryFn.includes("个已可达 · "), "probe summary toast distinguishes recovered vs unreachable");
// 委托分支在 frow 折叠判断之前（组尾条不在 .afrow 内，但顺序闸防回归）
const deadIdx = html.indexOf('ev.target.closest(".af-deadretry")');
const frowIdx = html.indexOf('ev.target.closest(".frow")');
ok(deadIdx > 0 && frowIdx > deadIdx, "dead-retry delegation registered before frow fold branch");
ok(html.includes("retryDeadGroup(hit.ctx, hit.s.session_id, deadRetry.dataset.dir || \"\")"), "delegation routes current session ctx+sid+dir");

// ---- ④ 请求失败组尾收口条 ----
ok(/function markArtFetchError\(path, retry\) \{/.test(html), "markArtFetchError fn present");
ok(/function clearArtFetchError\(path\) \{/.test(html), "clearArtFetchError fn present");
ok(html.includes('.af-batch-err[data-fetch-err]'), "fetch-fail bar distinguished from outcome bar via data-fetch-err");
const dlFn = blockOf("async function downloadAndOpenArtifact", "// Uint8Array → base64");
ok(dlFn.includes("markArtFetchError(path, () => { downloadAndOpenArtifact(ctx, sid, path); })"), "download catch hangs retry bar with original action");
ok(dlFn.includes("clearArtFetchError(path)"), "download success clears fetch-fail bar");
const pvFn = blockOf("async function previewArtifact", "async function retryDeadGroup");
ok(pvFn.includes("markArtFetchError(path, () => { previewArtifact(ctx, sid, path); })"), "preview catch hangs retry bar with original action");
ok(pvFn.includes("clearArtFetchError(path)"), "preview success clears fetch-fail bar");
for (const sel of [".af-batch-err", ".af-deadretry, .af-retry", ".af-batch-err.hard", ".af-batch-err span"]) {
  ok(cssBlock(sel) !== "", "css rule " + sel);
}

// ---- ⑤ wait-card 回原 session（冻结绑定 + ok:true 严判） ----
ok(/let waitBind = null;/.test(html), "waitBind module-level binding declared");
ok(/waitBind = \{ ctx: sel\.ctx, sid: s\.session_id, rid: s\.waiting_request\.request_id \};/.test(html), "renderDetail freezes {ctx,sid,rid} while waitbox shown");
ok(/wb\.style\.display = "none";\s*\n\s*rmOpenFor = "";/.test(html) && /waitBind = null;/.test(html), "binding cleared when waitbox hides");
ok(/function sendWaitingVerdict\(type, extra, onOk\) \{/.test(html), "sendWaitingVerdict fn present");
const swv = blockOf("function sendWaitingVerdict", '$("allowBtn")');
ok(swv.includes("const b = waitBind;") && swv.includes("if (!b) return;"), "send strictly uses frozen binding");
ok(swv.includes('Object.assign({ session_id: b.sid, request_id: b.rid }, extra || {})'), "payload carries frozen sid+rid (origin session)");
ok(swv.includes("commandAck(b.ctx,"), "send waits for real ACK");
ok(swv.includes("ackVerdict(ack)"), "verdict reuses W1b gate fn");
ok(swv.includes('v.kind === "unconfirmed" ? "，可重试" : ""'), "unconfirmed verdict surfaces retry hint (not silent)");
// 五个发送点全收口（allow / remember / answer / askCancel / reject）
ok(html.includes('$("allowBtn").onclick = () => sendWaitingVerdict("COMMAND_CONTINUE");'), "allowBtn via sendWaitingVerdict");
ok(html.includes('sendWaitingVerdict("COMMAND_CONTINUE", { remember_scope: scope });'), "remember scope via sendWaitingVerdict");
ok(html.includes('sendWaitingVerdict("COMMAND_ANSWER", { answers }, () => toast("已作答"))'), "answer via sendWaitingVerdict (toast gated on ok:true)");
ok(count(html, 'sendWaitingVerdict("COMMAND_REJECT")') === 2, "askCancel + reject both via sendWaitingVerdict");
// 旧「点击时动态取 sel」直发残留为 0——回原 session 硬保证
ok(count(html, 'sendCommandTo(sel.ctx, "COMMAND_CONTINUE"') === 0, "no raw COMMAND_CONTINUE senders left");
ok(count(html, 'sendCommandTo(sel.ctx, "COMMAND_REJECT"') === 0, "no raw COMMAND_REJECT senders left");
ok(count(html, 'sendCommandTo(sel.ctx, "COMMAND_ANSWER"') === 0, "no raw COMMAND_ANSWER senders left");
// W1b 判定门本体未动（复用不重定义）
ok(count(html, "function ackVerdict(ack)") === 1 && html.includes("if (ack.ok === true) return { ok: true"), "ackVerdict ok===true gate intact (single definition)");
// RESOLVED 帧收口链未动（UI 单一收口，不与 ACK 双写）
ok(html.includes('case "SESSION_WAITING_RESOLVED"'), "RESOLVED-frame closeout intact");
ok(html.includes('wb.style.display = "block";'), "waitbox display chain intact");

// ---- ⑦ 行为直跑（正则提取纯函数 + 桩依赖，W1a 先例）：outcome 三态 / 冻结绑定路由 ----
{
  const fnSrc = html.match(/function artFolderHtml\(s, g, open\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const escapeSrc = html.match(/function escapeHtml\(s\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  ok(fnSrc !== "" && escapeSrc !== "", "behavior: artFolderHtml+escapeHtml extractable");
  const run = new Function(
    "artRowHtml", "fmtArtSize", "fmtArtTime", "FDIR_SVG",
    escapeSrc + "\n" + fnSrc + "\nreturn artFolderHtml;",
  )(
    (t: { path: string }) => '<div class="row" data-p="' + t.path + '"></div>',
    () => "1.2 MB", () => "10:00", "<svg></svg>",
  );
  const s = { session_id: "s1" };
  const hFail = run(s, { dir: "/tmp/build", leaf: "build", files: [{ path: "/tmp/build/a.md", exists: false }, { path: "/tmp/build/b.md", exists: false }], at: 1, size: 10 }, true);
  ok(hFail.includes('data-artifact-outcome="failed"'), "behavior: all-dead group marks failed");
  ok(hFail.includes("目录不可达") && hFail.includes("af-deadretry") && hFail.includes("hard"), "behavior: failed group shows badge + hard retry bar");
  const hPartial = run(s, { dir: "/tmp/docs", leaf: "docs", files: [{ path: "/tmp/docs/a.md", exists: false }, { path: "/tmp/docs/b.md", exists: true }], at: 2, size: 10 }, true);
  ok(hPartial.includes('data-artifact-outcome="partial"') && hPartial.includes("1 个失效"), "behavior: partial group marks N 个失效");
  const hClean = run(s, { dir: "/tmp/x", leaf: "x", files: [{ path: "/tmp/x/a.md", exists: true }], at: 3, size: 5 }, true);
  ok(hClean.includes('data-artifact-outcome="complete"') && !hClean.includes("af-deadbadge") && !hClean.includes("af-batch-err"), "behavior: clean group has no error chrome");
}
{
  const fnSrc = html.match(/function sendWaitingVerdict\(type, extra, onOk\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  ok(fnSrc !== "", "behavior: sendWaitingVerdict extractable");
  const calls: { ctx: unknown; type: string; payload: Record<string, unknown> }[] = [];
  const verdict = (ack: { ok?: boolean; error?: string } | null) =>
    ack?.ok === true ? { ok: true, error: null, kind: "ok" } : { ok: false, error: String(ack?.error ?? "未确认"), kind: "rejected" };
  const mkSend = (waitBind: unknown, toasts: string[]) => new Function(
    "waitBind", "commandAck", "ackVerdict", "toast", fnSrc + "\nreturn sendWaitingVerdict;",
  )(
    waitBind,
    (ctx: unknown, type: string, payload: Record<string, unknown>) => { calls.push({ ctx, type, payload }); return Promise.resolve({ ok: true, command_id: "c1" }); },
    verdict,
    (m: string) => toasts.push(m),
  );
  const toasts: string[] = [];
  const send = mkSend({ ctx: { tag: "ctxA" }, sid: "sess-1", rid: "req-9" }, toasts);
  send("COMMAND_CONTINUE", undefined, undefined);
  await new Promise((r) => setTimeout(r, 0));
  ok(calls.length === 1 && calls[0].payload.session_id === "sess-1" && calls[0].payload.request_id === "req-9", "behavior: verdict routed to frozen origin session (sid+rid from bind)");
  ok((calls[0].ctx as { tag: string }).tag === "ctxA", "behavior: ctx from frozen bind, not click-time selection");
  ok(toasts.length === 0, "behavior: ok:true stays silent (RESOLVED frame owns UI closeout)");
  const toasts2: string[] = [];
  const send2 = new Function(
    "waitBind", "commandAck", "ackVerdict", "toast", fnSrc + "\nreturn sendWaitingVerdict;",
  )(
    { ctx: {}, sid: "sess-2", rid: "req-2" },
    () => Promise.resolve({ ok: false, error: "已被更新的请求取代", command_id: "c2" }),
    verdict,
    (m: string) => toasts2.push(m),
  );
  send2("COMMAND_REJECT", undefined, undefined);
  await new Promise((r) => setTimeout(r, 0));
  ok(toasts2.length === 1 && toasts2[0].includes("未确认") && toasts2[0].includes("已被更新的请求取代"), "behavior: rejected verdict toasts error (not silent, no retry storm)");
  const send3 = mkSend(null, []);
  send3("COMMAND_CONTINUE", undefined, undefined);
  await new Promise((r) => setTimeout(r, 0));
  ok(calls.length === 1, "behavior: null binding sends nothing (no stray command)");
}

// ---- ⑥ 词汇（新文案无团队级 Leader 词） + 结构闸 ----
const w2bChunk = retryFn + blockOf("function markArtFetchError", "function clearArtFetchError") + swv +
  blockOf("function artFolderHtml", "function artifactsTabHtml");
ok(!/leader/i.test(w2bChunk), "W2b-new copy/functions carry no Leader wording");
ok(count(html.toLowerCase(), "leader") <= 5, "no new Leader wording beyond 5 pre-existing org-domain spots (W3 scope)");
const endIdx = html.indexOf("</html>");
ok(endIdx > 0 && html.slice(endIdx + 7).trim() === "", "nothing after </html>");
const staticHtml = html.slice(html.indexOf("<body"), html.indexOf("<script", html.indexOf("<body")));
const ids = [...staticHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(ids).size === ids.length && ids.length > 50, "static ids unique (" + ids.length + ")");
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(allIds).size === allIds.length, "all ids unique (" + allIds.length + ")");

console.log(`\nw2b-artifacts: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
