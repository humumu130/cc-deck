// #005-UI 会话列表微信式通栏行 + 通知列表优化：静态锚点 + 纯函数直跑 + 结构闸。
// 靶子 specs/005-prototype-a.html（唯一产品靶子；旧版 web-console 零触碰，
// test-wechat-rows.ts 是旧版 #78 的同族先例，命名体系断言不共用）。
// 覆盖：srow 三段行骨架/密度三档行变量循环/行间零分隔线/hover 选中淡底与呼吸灯/
// 新增块 token 零裸色值/通知分组统计+三段结构化摘要+轻动作内联/功能保留面/走秒直更链/
// notifyCopyRows·sessionSourceColor·sessionSideMarkup·renderSessionCard 行为直跑（W3 范式）/
// 结构闸（div 平衡·id 唯一·</html> 收尾·旧版 q-* 零泄漏·script 编译）。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-ui-rows.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "specs", "005-prototype-a.html"), "utf-8");

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
// 提取 CSS 规则块（选择器开头 → 对应平衡花括号；test-wechat-rows.ts 同范式）
function blockAt(needle: string): string {
  const i = html.indexOf(needle);
  if (i < 0) return "";
  let depth = 0;
  const j = html.indexOf("{", i);
  if (j < 0) return "";
  const start = j;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(start, k + 1); }
  }
  return "";
}
function cssBlock(selector: string): string {
  return blockAt(selector + " {");
}
// 提取单行 JS const 声明（005 渲染函数全部单行书写）
function jsConst(name: string): string {
  const i = html.indexOf(`const ${name} = `);
  if (i < 0) return "";
  const end = html.indexOf("\n", i);
  return html.slice(i, end);
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
// 裸色值检查：剥注释后零 hex 与零 rgb/rgba 字面量（新块纪律：颜色只走 var()）
const BARE_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
function noBareColor(block: string): boolean {
  return !BARE_COLOR.test(stripComments(block));
}

console.log("== #005-UI rows: wechat-style session rows + notification absorption ==");

// ---- ① 行结构：srow 三段骨架（CSS 规则在位 + render 组装串产出） ----
ok(cssBlock("#d-session .srow-ava") !== "", "css rule .srow-ava");
ok(/color-mix\(in srgb, var\(--srow-ava-c, var\(--source\)\) 16%/.test(cssBlock("#d-session .srow-ava")), "ava tints source color via color-mix 16%");
ok(cssBlock("#d-session .srow-ava .status-dot").includes("right: -3px") && cssBlock("#d-session .srow-ava .status-dot").includes("bottom: -3px"), "status dot overlays ava corner");
ok(cssBlock("#d-session .srow-main").includes("flex-direction: column"), "srow-main stacks r1/r2");
ok(cssBlock("#d-session .srow-r1") !== "" && cssBlock("#d-session .srow-r2") !== "", "css rules .srow-r1/.srow-r2");
const r1Strong = cssBlock("#d-session .srow-r1 strong");
ok(r1Strong.includes("text-overflow: ellipsis") && r1Strong.includes("white-space: nowrap") && r1Strong.includes("min-width: 0"), "r1 title truncates with ellipsis (narrow column safe)");
ok(cssBlock("#d-session .srow-r2-t").includes("text-overflow: ellipsis"), "r2 summary truncates with ellipsis");
ok(cssBlock("#d-session .srow-side").includes("justify-content: flex-end") && cssBlock("#d-session .srow-side:empty").includes("display: none"), "srow-side right-aligned, hidden when empty");
ok(cssBlock("#d-session .srow-n").includes("border-radius: 999px"), "srow-n is round badge");
ok(cssBlock("#d-session .srow-cta").includes("display: none"), "srow-cta hidden by default (hover-only)");
ok(html.includes("#d-session .queue-card:hover .srow-side:has(.srow-cta) .srow-n { display: none; }") && html.includes("#d-session .queue-card:hover .srow-cta { display: inline-flex; }"), "badge/cta mutex on hover (:has pair)");
const cardJs = jsConst("renderSessionCard");
for (const cls of ['class="srow-ava"', 'class="srow-main"', 'class="srow-r1"', 'class="srow-r2"', 'class="srow-side"', "--srow-ava-c:"]) ok(cardJs.includes(cls), "render emits " + cls);
ok(cardJs.includes('<i class="status-dot ${item.status}"></i>'), "status dot rides inside ava");
ok(cardJs.indexOf("srow-r2-t") < cardJs.indexOf("engineBadgeMarkup(item)") && cardJs.indexOf("engineBadgeMarkup(item)") < cardJs.indexOf("srow-sec"), "engine badge sits at r2 tail (title breathing room)");
ok(html.includes("#d-session .srow-r2 .engine-badge { flex: none; }"), "engine badge never shrinks in r2");
ok(cardJs.includes('<span class="srow-sec" data-work-sec="${item.workSecs || 0}">'), "working row emits .srow-sec with data-work-sec base");

// ---- ② 密度三档：行变量循环（卡变量改行变量，档位键不变） ----
const rowBlock = cssBlock("#d-session .queue-card");
ok(blockAt("body { --srow-pad-block").includes("--srow-ava:") && blockAt('body[data-card-density="compact"] { --srow-pad-block').includes("--srow-ava:") && blockAt('body[data-card-density="relaxed"] { --srow-pad-block').includes("--srow-ava:"), "srow row vars defined for all three density tiers");
function avaSize(block: string): number {
  const m = block.match(/--srow-ava:\s*(\d+)px/);
  return m ? Number(m[1]) : 0;
}
const sCompact = avaSize(blockAt('body[data-card-density="compact"] { --srow-pad-block'));
const sStandard = avaSize(blockAt("body { --srow-pad-block"));
const sRelaxed = avaSize(blockAt('body[data-card-density="relaxed"] { --srow-pad-block'));
ok(sCompact === 26 && sStandard === 34 && sRelaxed === 38, `ava size steps up across tiers (${sCompact}<${sStandard}<${sRelaxed})`);
ok(html.includes('["compact", "standard", "relaxed"]'), "density tier loop keys unchanged");
ok(count(html, "data-card-density-option=") === 6, "three density buttons x2 panels (settings + general)");
ok(rowBlock.includes("var(--srow-pad-block)") && !rowBlock.includes("--density-card-"), "row form consumes new row vars, not old --density-card-* card vars");

// ---- ③ 行间零分隔线（#78 拍板延续：分行靠留白，不画线） ----
ok(rowBlock.includes("border: 0") && !rowBlock.includes("border-bottom"), "queue-card row has no box and no hairline");
const rowFormCss = html.slice(html.indexOf("body { --srow-pad-block:"), html.indexOf("#d-session .session-list .queue-group") + 200);
ok(!/\bborder-bottom\b/.test(rowFormCss) && !/\bborder-top\b/.test(rowFormCss), "row-form css region draws zero separators");
ok(!html.includes("hairline") && count(html, ".row-divider") === 0 && count(html, ".q-row-line") === 0, "no hairline/divider classes anywhere");

// ---- ④ hover 瞬时淡底 / 选中持续淡底 / working 呼吸灯（暗亮双值 token） ----
ok(rowBlock.includes("transition: background .06s linear"), "hover tint transitions in .06s");
ok(cssBlock("#d-session .queue-card:hover").includes("background: var(--q-row-hov)"), "hover uses --q-row-hov token");
ok(cssBlock("#d-session .queue-card.selected").includes("background: var(--q-row-sel)"), "selected uses --q-row-sel token");
const hovDefs = html.match(/--q-row-hov:\s*rgba\([^)]*,\s*(0?\.\d+)\)/g) || [];
const selDefs = html.match(/--q-row-sel:\s*rgba\([^)]*,\s*(0?\.\d+)\)/g) || [];
ok(hovDefs.length === 2 && selDefs.length === 2, "--q-row-hov/sel each defined twice (dark+light)");
ok(hovDefs.every((d) => Number(d.match(/(0?\.\d+)\)$/)?.[1]) <= 0.2) && selDefs.every((d) => Number(d.match(/(0?\.\d+)\)$/)?.[1]) <= 0.2), "tint values are low-alpha (<= .2)");
ok(count(html, "--status-working-glow:") === 2, "--status-working-glow defined for dark+light");
ok(cssBlock(".status-dot.working").includes("animation: dot-breathe"), "working dot breathes");
ok(cssBlock("@keyframes dot-breathe").includes("var(--status-working-glow)") && noBareColor(cssBlock("@keyframes dot-breathe")), "breathe glow via token only");

// ---- ⑤ token 纪律：本批新增/改造块剥注释后零裸色值（颜色只走 var()） ----
const newBlocks = [
  "#d-session .queue-card", "#d-session .queue-card[hidden]", "#d-session .queue-card:hover",
  "#d-session .queue-card.selected", "#d-session .queue-card[data-session-card=\"mobile\"]",
  "#d-session .srow-ava", "#d-session .srow-ava .status-dot", "#d-session .srow-main",
  "#d-session .srow-r1", "#d-session .srow-r1 strong", "#d-session .srow-r1 .tag",
  "#d-session .srow-r1 .engine-badge, #d-session .srow-r1 .source-badge",
  "#d-session .srow-r2", "#d-session .srow-r2 .engine-badge", "#d-session .srow-r2-t",
  "#d-session .srow-sec", "#d-session .srow-side", "#d-session .srow-side:empty",
  "#d-session .srow-n", "#d-session .srow-cta", "#d-session .srow-cta:hover",
  "#d-session .queue-card:hover .srow-side:has(.srow-cta) .srow-n", "#d-session .queue-card:hover .srow-cta",
  "#d-session .session-list .queue-group",
  ".status-dot.working", "@keyframes dot-breathe",
  ".notify-source-group + .notify-source-group", ".notify-source-group-head",
  ".notify-source-group:first-child .notify-source-group-head", ".notify-source-group-name",
  ".notify-source-group-stat", ".notify-source-group-stat b",
  ".notify-copy", ".notify-copy-row", ".notify-copy-row b",
];
let bareHits: string[] = [];
for (const sel of newBlocks) {
  const b = cssBlock(sel);
  if (b === "") { bareHits.push(sel + " <missing>"); continue; }
  if (!noBareColor(b)) bareHits.push(sel);
}
ok(bareHits.length === 0, `new/rewritten css blocks: zero bare color literals, colors via var() only${bareHits.length ? " — hits: " + bareHits.join(", ") : ""} (${newBlocks.length} blocks)`);
ok(html.includes('body[data-source-mode="single"] #d-session .queue-card .source-badge'), "single-source mode still hides row source badge");

// ---- ⑥ 通知优化吸收：源分组头+统计 / 三段结构化摘要 / 轻动作内联 ----
const groupJs = jsConst("renderNotificationSourceCards");
ok(groupJs.includes("[...new Set(notificationData.map((item) => item.source))]"), "notifications grouped by unique source");
ok(groupJs.includes("notify-source-group-head") && groupJs.includes("<b>${activeN}</b> 项需行动 · ") && groupJs.includes("条动态"), "group head shows name + action-count stat with brand highlight");
ok(cssBlock(".notify-source-group-stat b").includes("color: var(--brand)"), "stat action count highlighted via brand token");
ok(jsConst("notifyCopyRows").includes('split(" · ")') && jsConst("notifyCopyRows").includes('indexOf("：")') && jsConst("notifyCopyRows").includes("<b>"), "desktop copy splits into lead-labeled rows (谁/什么事/等什么)");
ok(cssBlock(".notify-copy-row") !== "", "notify-copy-row css rule exists");
ok(jsConst("notificationSourceCard").includes('class="notify-light-action"') && jsConst("notificationSourceCard").includes("data-notify-action="), "light action inlined on desktop card");
ok(jsConst("renderMobileNotificationCards").includes('class="notify-light-action"'), "light action inlined on mobile card too");
for (const attr of ["data-notify-jump", "data-notify-domain=", "data-notify-session=", "data-notify-team-action=", "data-notify-team-action=\"confirm\""]) {
  ok(jsConst("notificationSourceCard").includes(attr), "jump/confirm chain keeps " + attr);
}
ok(cssBlock(".notify-source-card.resolved") !== "" && html.includes('classList.add("resolved")') && html.includes('status.textContent = "需行动"'), "resolved state chain intact (css + flip logic)");
ok(html.includes('createDemoEmptyState("暂无需要你行动的通知")') && html.includes('createDemoEmptyState("暂无待你处理"'), "empty states preserved (notify + session)");

// ---- ⑦ 功能保留面（零回退） ----
ok(html.includes('document.querySelectorAll("#d-session .queue-card, #m-inbox .mobile-card")') && html.includes('card.querySelector(".source-badge")'), "syncSourceVisibility still filters rows by .source-badge text");
ok(cardJs.includes("data-session-card=") && cardJs.includes('${item.selected ? " selected" : ""}'), "rows keep data-session-card + selected assembly");
ok(cssBlock("#d-session .queue-card[hidden]") === "{ display: none; }", "[hidden] beats row display:flex (source filter chain)");
ok(cssBlock('#d-session .queue-card[data-session-card="mobile"]').includes("var(--danger-bg)"), "danger card keeps danger background");
ok(jsConst("engineBadgeMarkup").includes("<svg") && jsConst("engineBadgeMarkup").includes("#icon-"), "engine badge keeps svg icon");
for (const st of [".status-dot.done", ".status-dot.waiting", ".status-dot.error", ".status-dot.working"]) ok(cssBlock(st) !== "", "status family rule " + st);
ok(cardJs.includes('<span class="tag ${item.tagClass}">${item.tag}</span>'), "tag badge kept in r1");
ok(cardJs.includes('variant === "mobile"') && cardJs.includes('class="mobile-card') && cardJs.includes("identityMarkup(item)"), "mobile card variant untouched (phone mode safe)");
ok(jsConst("sessionPendingItems").includes("sessionQueueData.action.slice(0, 3)") && jsConst("renderSessionQueue").includes("其他会话"), "queue render keeps pending slice + other grouping");

// ---- ⑧ 走秒直更链（#78 语义移植：摘要行走秒每秒直更） ----
ok(html.includes("const srowTickStart = Date.now();") && html.includes('document.querySelectorAll("#d-session .srow-sec[data-work-sec]")') && html.includes("}, 1000);"), "per-second tick reads all .srow-sec rows");
ok(html.includes("Number(el.dataset.workSec) + elapsed + \"s\""), "tick adds elapsed to data-work-sec base");

// ---- ⑨ 行为直跑（W3 范式：单行 const 提取 → new Function 构造体内 return 调用） ----
const helperNames = ["engineIconFor", "engineBadgeMarkup", "identityMarkup", "sessionSourceColor", "sessionSideMarkup", "renderSessionCard", "notifyCopyRows"];
const helperSrc = helperNames.map((n) => jsConst(n)).join("\n");
ok(helperNames.every((n) => jsConst(n) !== ""), "all helper consts extracted for direct run");
const harness = new Function(`${helperSrc}; return { engineIconFor, engineBadgeMarkup, identityMarkup, sessionSourceColor, sessionSideMarkup, renderSessionCard, notifyCopyRows };`)() as {
  sessionSourceColor: (s: string) => string;
  sessionSideMarkup: (i: { tagClass?: string }) => string;
  renderSessionCard: (i: Record<string, unknown>, v: string) => string;
  notifyCopyRows: (s: string) => string;
};
ok(harness.sessionSourceColor("家里 iMac") === "var(--source-home)" && harness.sessionSourceColor("公司电脑") === "var(--source-company)", "sessionSourceColor maps both sources to tokens");
ok(harness.sessionSideMarkup({ tagClass: "action" }).includes('class="srow-n"') && harness.sessionSideMarkup({ tagClass: "action" }).includes('class="srow-cta"'), "action row yields badge + cta pair");
ok(harness.sessionSideMarkup({ tagClass: "done" }) === "", "settled row yields no side cluster");
const copyHtml = harness.notifyCopyRows("谁：worker-web · 什么事：T-13 独立出包 · 等什么：确认收单");
ok(count(copyHtml, 'class="notify-copy-row"') === 3, "copy rows: three segments in");
ok(copyHtml.startsWith('<div class="notify-copy-row"><b>谁：</b>') && copyHtml.includes("<b>什么事：</b>") && copyHtml.includes("<b>等什么：</b>"), "each row leads with bold label up to ：");
ok(!harness.notifyCopyRows("纯文本段没有冒号").includes("<b>"), "colonless segment renders as plain text");
const fixture: Record<string, unknown> = {
  id: "fx1", title: "0.6.0-test.19 出包", status: "working", workSecs: 96,
  summary: "验收单已回填 2/3", source: "公司电脑", tag: "待收单", tagClass: "action",
  engine: "Claude", engineClass: "claude", selected: true, time: "12 分钟前",
};
const row = harness.renderSessionCard(fixture, "desktop");
ok(row.includes('class="queue-card selected"') && row.includes('data-session-card="fx1"'), "desktop row assembles selected card shell");
ok(row.includes("srow-ava") && row.includes("srow-r1") && row.includes("srow-r2") && row.includes("srow-side"), "desktop row carries three-section skeleton");
ok(row.includes('data-work-sec="96"') && row.includes(">96s<"), "working row renders ticking seconds with base");
ok(row.includes('<strong title="0.6.0-test.19 出包">0.6.0-test.19 出包</strong>'), "full title in r1 with hover title fallback");
const mrow = harness.renderSessionCard(fixture, "mobile");
ok(mrow.includes('class="mobile-card"') && mrow.includes('data-open-detail="fx1"') && !mrow.includes("srow-"), "mobile variant stays legacy mobile-card form");

// ---- ⑩ 结构闸 ----
ok(count(html, "<div") === count(html, "</div"), `div balance (${count(html, "<div")}/${count(html, "</div")})`);
// 静态标记区 id 严格唯一；JS 串里的 icon symbol 是懒注入（全带 querySelector 守卫，运行时 DOM 唯一）
const bodyStart = html.indexOf("<body");
const scriptStart = html.indexOf("<script");
const staticIds = [...html.slice(bodyStart, scriptStart).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(staticIds).size === staticIds.length && staticIds.length >= 40, `static ids unique (${staticIds.length})`);
const jsSymbolDefs = [...html.slice(scriptStart).matchAll(/symbol id="(icon-[a-z-]+)"/g)].map((m) => m[1]);
const guardedDefs = [...html.slice(scriptStart).matchAll(/if \(!sprite\.querySelector\("#(icon-[a-z-]+)"\)\) sprite\.insertAdjacentHTML\("beforeend", .<symbol id="(icon-[a-z-]+)"/g)].map((m) => m[1]);
ok(jsSymbolDefs.length > 0 && jsSymbolDefs.length === guardedDefs.length && jsSymbolDefs.every((id, i) => guardedDefs[i] === id), `lazy icon defs all guard-injected (${jsSymbolDefs.length})`);
const endIdx = html.indexOf("</html>");
ok(endIdx > 0 && html.slice(endIdx + 7).trim() === "", "nothing after </html>");
ok(count(html, 'class="q-') === 0 && !/class=\\?"q-/.test(html) && !/\.q-(ava|main|r1|r2|side|n|cta)\b/.test(html), "no legacy q-* naming leak (005 naming system only)");
const scriptSrc = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
let compiled = true;
try { new Function(scriptSrc); } catch { compiled = false; }
ok(compiled, "inline script compiles (syntax gate, not executed)");

console.log(`\n005-ui-rows: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
