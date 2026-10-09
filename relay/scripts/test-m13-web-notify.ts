// M13-6W Web 通知 resolved 分离 + 验收链接回跳：不清零锁（done 行仍渲染）/折叠分区头/
// resolved_at 时间戳 / sourceContext 归因解析（dispatch→台账卡·org→确认卡）+ 降级路径。
// 靶子 web-console/index.html：renderNotifications 主体重写（undone/doneRows 拆分）+
// notifJumpTarget/jumpFlash 纯函数 + nr-donehead 开合 + jr 分支 jgid/jcf 优先跳转。
// 语义权威：任务书两规格（动作不清零 resolved；归因缺失=降级不跳不报错不假造，零协议改动）。
// 手法 = W 线先例（test-w2b-artifacts.ts / test-m13-web-delta.ts）：静态锚 + 正则提取
// 纯函数/rowHtml 箭头体 new Function 直跑，桩依赖注入断言产出 HTML。
// 直跑：cd relay && env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   node --import tsx/esm scripts/test-m13-web-notify.ts
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
function fnSrc(name: string, args: string): string {
  return html.match(new RegExp(`function ${name}\\(${args}\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}
// rowHtml 是 renderNotifications 组回调里的局部 const 箭头函数：抠出箭头体供 new Function 桩跑
function arrowSrcOf(): string {
  const m = html.match(/const rowHtml = \(\{ ctx, item \}\) => \{[\s\S]*?\n    \};/);
  return m ? m[0].replace(/const rowHtml = /, "").replace(/\n    \};$/, "\n    }") : "";
}

// ---- 提取被测件 ----
const jumpTgtSrc = fnSrc("notifJumpTarget", "item, boards, orgConfirms");
const flashSrc = fnSrc("jumpFlash", "el");
const rowArrow = arrowSrcOf();

// ---- ① 静态锚：不清零 / 折叠分区 / 时间戳 / 回跳属性 ----
console.log("== M13-6W notify resolved split + acceptance jump: static anchors ==");
ok(jumpTgtSrc !== "" && count(html, "function notifJumpTarget(") === 1,
  "notifJumpTarget single definition, extractable");
ok(flashSrc.includes("scrollIntoView") && flashSrc.includes('classList.add("jump-flash")') &&
  flashSrc.includes("1600"),
  "jumpFlash: scroll + flash class + 1.6s self-revert");
ok(html.includes("const notifDoneOpen = new Set();"),
  "fold-open memory Set present (per-group, default collapsed)");
ok(html.includes('+ "|dz:"') && jumpKeyHasOpenState(),
  "render key includes done-zone open state (toggle re-renders)");
function jumpKeyHasOpenState() {
  const a = html.indexOf('|dz:"');
  return a >= 0 && html.slice(a, a + 220).includes("notifDoneOpen.has(g)");
}
ok(html.includes('data-donegroup="') && html.includes("aria-expanded=") &&
  html.includes("已处理 ' + doneRows.length"),
  "done-zone head: group handle + aria-expanded + count label (已处理 N)");
ok(html.includes("nrd-chev") && html.includes('"▾"') && html.includes('"▸"'),
  "chevron reflects open state (▾ open / ▸ collapsed)");
// 不清零核心锁：done 行仍由 rowHtml 全量渲染，只是默认收进折叠区
ok(html.includes("(doneOpen ? doneRows.map(rowHtml).join(\"\") : \"\")"),
  "done rows still rendered via rowHtml when expanded (不清零: density only)");
ok(count(html, "doneRows.map(rowHtml)") === 1,
  "done rows mapped exactly at the folded body site (head is count label only)");
ok(html.includes("const doneOf = (item) => !!(item.resolved_at || item.handled_at || item.dismissed_at);"),
  "doneOf tri-state unchanged (resolved/handled/dismissed = settled, never deleted)");
ok(html.includes("undone.map(rowHtml).join(\"\")"),
  "undone rows keep plain in-flow rendering (M13-6W 分离不动未收口行)");
// resolved_at 时间戳
ok(html.includes('const doneTs = doneOf(item) ? (item.resolved_at || item.handled_at || item.dismissed_at) : 0;'),
  "doneTs prefers resolved_at (handled/dismissed fallback)");
ok(html.includes('\'<span class="nr-time">\' + escapeHtml(fmtDT(doneTs))'),
  "resolved_at rendered as nr-time via fmtDT (005 :684 行内时间戳语言)");
// canAck / canJmp 语义不变（动作位与可点面都不扩到 done 行——005 历史动态不可点语义）
ok(html.includes('const canAck = item.actionable === true && !doneOf(item) && !cmdCapBlocked(ctx.cmdCaps, "COMMAND_NOTIFICATION_ACK");'),
  "canAck semantics unchanged (actionable + unsettled + cmd cap)");
ok(html.includes("const canJmp = item.actionable === true && !doneOf(item);"),
  "canJmp semantics unchanged (done rows stay non-clickable, 005 历史动态)");
ok(count(html, "notifJumpTarget(item, ctx.boards, ctx.orgConfirms)") === 1,
  "jump target resolved once per row in rowHtml (per-source ctx scope)");
// CSS 面
ok(html.includes(".notice-row .nr-time {") && html.includes(".nr-donezone {") &&
  html.includes(".nr-donehead {") && html.includes(".nr-donehead:hover {") &&
  html.includes(".nr-donehead:focus-visible {") && html.includes(".nrd-chev"),
  "CSS: nr-time / donezone / donehead (+hover +focus-visible) present");
ok(html.includes("@keyframes jumpFlashKf") && html.includes(".jump-flash {"),
  "CSS: jump-flash keyframes present");
ok(html.includes(".notice-row.nr-done { opacity: .55; }"),
  "005 gray-state language retained (.nr-done opacity, #80b 满宽行口径)");
// 点击/键盘面
const nkIdx = html.indexOf('button[data-nack-key]');
const dhIdx = html.indexOf('e.target.closest(".nr-donehead")');
const jrIdx = html.indexOf('e.target.closest(".notice-row.nr-jmp")');
ok(nkIdx >= 0 && nkIdx < dhIdx && dhIdx < jrIdx,
  "click delegation order: ack button -> donehead toggle -> row jump");
const dhBlock = html.slice(dhIdx, jrIdx);
ok(dhBlock.includes("notifDoneOpen.add(") && dhBlock.includes("notifDoneOpen.delete(") &&
  dhBlock.includes("renderNotifications();"),
  "donehead click toggles fold memory + re-renders");
ok(html.includes('t.classList.contains("nr-jmp") || t.classList.contains("nr-donehead")'),
  "keyboard Enter covers donehead (role=button tabindex=0 可达)");
const jrBlock = html.slice(jrIdx, html.indexOf('filterSrc = c.cfg.id;', jrIdx));
ok(jrBlock.includes("jr.dataset.jgid") && jrBlock.includes("orgOpenDrawer(") &&
  jrBlock.includes(".od-ent[data-eid="),
  "jump task: data-jgid -> orgOpenDrawer -> flash drawer entry (data-eid)");
ok(jrBlock.includes("jr.dataset.jcf") && jrBlock.includes('[data-org-cf="') &&
  jrBlock.includes('.closest(".org-cf")'),
  "jump confirm: data-jcf -> orgzone confirm-card flash (zero markup change)");
ok(count(jrBlock, "CSS.escape") >= 2,
  "attribute selectors use CSS.escape (injection defense)");
ok(html.includes("filterSrc = c.cfg.id;") && html.includes("select(jr.dataset.sid, c.cfg.id);"),
  "degradation fallthrough intact: no jgid/jcf => original session jump");
// entHtml 锚（抽屉台账卡聚焦反查）
ok(html.includes('data-eid="\' + escapeHtml(e.id)') &&
  html.includes('typeof e.id === "string" && e.id'),
  "drawer entry rows carry data-eid (conditional, defensive)");

// ---- ② notifJumpTarget 直跑：归因解析 + 降级 ----
console.log("== notifJumpTarget direct runs ==");
ok(rowArrow !== "", "rowHtml arrow extractable");
const notifJumpTarget = jumpTgtSrc
  ? new Function("return (" + jumpTgtSrc + ");")() as
      (item: unknown, boards: unknown, orgConfirms: unknown) => unknown
  : null;
ok(notifJumpTarget !== null, "notifJumpTarget evaluable");
if (notifJumpTarget) {
  type Board = { entries?: Array<Record<string, unknown>> };
  const boards = new Map<string, Board>([
    ["g1", { entries: [{ id: "e9", dispatch_id: "other" }, { id: "e1", dispatch_id: "d-77" }] }],
    ["g2", { entries: [{ id: "e2", dispatch_id: "d-88" }] }],
  ]);
  const sc = (domain: string, entityId: string, extra: Record<string, unknown> = {}) =>
    ({ sourceContext: { domain, entityId, alertId: "a", returnPath: "web", ...extra } });
  ok(JSON.stringify(notifJumpTarget(sc("dispatch", "d-77"), boards, [])) ===
    JSON.stringify({ kind: "task", gid: "g1", entryId: "e1" }),
    "dispatch hit: dispatch_id -> {task, gid, entryId} (M12-7 board attribution)");
  ok(JSON.stringify(notifJumpTarget(sc("dispatch", "d-88"), boards, [])) ===
    JSON.stringify({ kind: "task", gid: "g2", entryId: "e2" }),
    "dispatch hit scans across boards (second board match)");
  ok(notifJumpTarget(sc("dispatch", "d-none"), boards, []) === null,
    "dispatch miss (attribution not yet written / not synced) => null degrade");
  ok(notifJumpTarget(sc("dispatch", "d-77"), undefined, []) === null,
    "boards not a Map => null (defensive)");
  ok(notifJumpTarget(sc("dispatch", "d-x"), new Map([["g", { entries: [{ dispatch_id: "d-x" }] }]]), []) === null,
    "dispatch entry without string id => null (no fabricated focus)");
  ok(JSON.stringify(notifJumpTarget(sc("org", "c-1"), new Map(), [{ id: "c-1" }])) ===
    JSON.stringify({ kind: "confirm", confirmId: "c-1" }),
    "org hit: confirm_id on record => {confirm} focus");
  ok(notifJumpTarget(sc("org", "c-gone"), new Map(), [{ id: "c-1" }]) === null,
    "org confirm already settled (not on record) => null degrade");
  ok(notifJumpTarget(sc("org", "c-1"), new Map(), "nope") === null,
    "orgConfirms not an array => null (defensive)");
  ok(notifJumpTarget(sc("session", "s-1"), boards, []) === null,
    "domain outside dispatch/org => null (keep original session jump)");
  ok(notifJumpTarget(null, boards, []) === null &&
    notifJumpTarget({}, boards, []) === null &&
    notifJumpTarget({ sourceContext: { domain: "dispatch" } }, boards, []) === null &&
    notifJumpTarget({ sourceContext: { domain: "dispatch", entityId: "" } }, boards, []) === null &&
    notifJumpTarget({ sourceContext: "junk" }, boards, []) === null,
    "malformed items / sourceContext shapes => null, never throw");
}

// ---- ③ rowHtml 直跑：行产出 HTML 断言（不清零 + 回跳属性 + 降级） ----
console.log("== rowHtml direct runs ==");
if (rowArrow && notifJumpTarget) {
  const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  const fmtDT = (_ts: number) => "10-06 12:30"; // 桩：接线断言（fmtDT 本体既有件，非本单靶）
  const srcDisplayName = (cfg: { name: string }) => cfg.name;
  const mkRow = (blocked: boolean) =>
    new Function(
      "escapeHtml", "fmtDT", "srcDisplayName", "cmdCapBlocked", "notifJumpTarget", "doneOf",
      "return (" + rowArrow + ");",
    )(esc, fmtDT, srcDisplayName, (_c: unknown, _k: string) => blocked, notifJumpTarget,
      (it: Record<string, unknown>) => !!(it.resolved_at || it.handled_at || it.dismissed_at));
  const mkCtx = (over: Record<string, unknown> = {}) => ({
    cfg: { id: "srv1", name: "本地" },
    boards: new Map([["g1", { entries: [{ id: "e1", dispatch_id: "d-1" }] }]]),
    orgConfirms: [{ id: "c-1" }],
    cmdCaps: {},
    ...over,
  });
  const rowHtml = mkRow(false);
  ok(!!rowHtml, "rowHtml evaluable with stub deps");

  // 未收口可行动 + dispatch 归因可解 → 回跳属性冻结进行
  const r1 = rowHtml({ ctx: mkCtx(), item: { key: "k1", title: "验收通过", body: "见台账", group: "activity", actionable: true, sourceContext: { domain: "dispatch", entityId: "d-1", sessionId: "w-9" } } });
  ok(r1.includes("nr-jmp") && r1.includes('data-jgid="g1"') && r1.includes('data-jeid="e1"') &&
    r1.includes('data-sid="w-9"') && r1.includes('role="button"') && !r1.includes("nr-done"),
    "undo row + resolvable dispatch attribution => jump attrs frozen into row");
  ok(!r1.includes("nr-time") && r1.includes("知道了"),
    "undo row: no timestamp, ack button present (动作位不变)");

  // 归因不可解 → 降级：仍可点但无 jgid/jcf（不假造），原会话跳转属性在
  const r2 = rowHtml({ ctx: mkCtx({ boards: new Map() }), item: { key: "k2", title: "t", body: "b", group: "activity", actionable: true, sourceContext: { domain: "dispatch", entityId: "d-gone", sessionId: "w-8" } } });
  ok(r2.includes("nr-jmp") && !r2.includes("data-jgid") && !r2.includes("data-jcf") &&
    r2.includes('data-sid="w-8"'),
    "unresolvable attribution => degrade to session jump (row stays interactive, no fake attrs)");

  // 已收口行：灰态 + 时间戳 + 不可点 + 无动作位，但行仍在（不清零锁）
  const r3 = rowHtml({ ctx: mkCtx(), item: { key: "k3", title: "已收口", body: "b", group: "attention", actionable: true, resolved_at: 1759700000000, sourceContext: { domain: "dispatch", entityId: "d-1" } } });
  ok(r3.includes("nr-done") && !r3.includes("nr-jmp") && !r3.includes("nr-ack") &&
    r3.includes('class="nr-time">10-06 12:30<') && r3.includes("已收口"),
    "done row: gray + resolved_at timestamp, no jump/ack, row still fully rendered (不清零)");

  // org 归因 → data-jcf
  const r4 = rowHtml({ ctx: mkCtx(), item: { key: "k4", title: "立项确认", body: "b", group: "action", actionable: true, sourceContext: { domain: "org", entityId: "c-1" } } });
  ok(r4.includes('data-jcf="c-1"') && !r4.includes("data-jgid"),
    "org attribution => confirm-card jump attr (no task attrs mixed)");

  // 不可行动行不可点；cmdCap 封锁只关动作位不关跳转
  const r5 = rowHtml({ ctx: mkCtx(), item: { key: "k5", title: "t", body: "b", group: "activity", actionable: false } });
  ok(!r5.includes("nr-jmp") && !r5.includes("nr-ack"), "non-actionable row: no jump, no ack");
  const r6 = mkRow(true)({ ctx: mkCtx(), item: { key: "k6", title: "t", body: "b", group: "activity", actionable: true } });
  ok(!r6.includes("nr-ack") && r6.includes("nr-jmp"),
    "cmd-cap blocked: ack hidden, local jump unaffected");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
