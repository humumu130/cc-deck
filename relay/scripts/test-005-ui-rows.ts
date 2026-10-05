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
// CTA 浮层化（用户直馈 2026-10-05 两轮：side 容器占 22px 文档流宽挤时间右缘——绝对定位挂卡零布局位移）
const ctaBlock = cssBlock("#d-session .srow-cta");
ok(ctaBlock.includes("position: absolute") && ctaBlock.includes("transform: translateY(-50%)") && ctaBlock.includes("right: 14px"), "cta is absolutely positioned overlay on card (zero layout shift, aligns to row content edge)");
ok(ctaBlock.includes("background: var(--q-row-hov)"), "cta solid bg uses row-hover token (no bleed-through)");
ok(cssBlock("#d-session .srow-time").includes("transition: opacity .06s linear"), "time fades out on hover (.06s, same as row bg)");
ok(html.includes("#d-session .queue-card:hover .srow-time, #d-session .queue-card:focus-within .srow-time { opacity: 0; }"), "hover/focus hides time in place (right edge constant)");
ok(html.includes("#d-session .queue-card:hover .srow-cta, #d-session .queue-card:focus-within .srow-cta { display: inline-flex; }"), "cta appears on hover and focus-within");
ok(cssBlock("#d-session .queue-card").includes("position: relative"), "queue-card anchors overlay (position: relative)");
ok(!html.includes(".srow-side") && !html.includes('class="srow-side"') && !html.includes(".srow-n") && !html.includes('class="srow-n"') && !html.includes(":has(.srow-cta) .srow-n"), "side container fully removed + unread badge srow-n stays removed (zero residue, CSS+render)");
const cardJs = jsConst("renderSessionCard");
for (const cls of ['class="srow-ava"', 'class="srow-main"', 'class="srow-r1"', 'class="srow-r2"', "${sessionCtaMarkup(item)}", "--srow-ava-c:"]) ok(cardJs.includes(cls), "render emits " + cls);
ok(!cardJs.includes("srow-side"), "render emits no side wrapper (cta rides card directly)");
ok(cardJs.includes('<i class="status-dot ${item.status}"></i>'), "status dot rides inside ava");
// 三行制（用户直馈）：r1=标题+时间 / r2=摘要+走秒 / r3=tag+engine+source 徽行（空则不渲染）
ok(cardJs.indexOf("<strong title=") < cardJs.indexOf("srow-time") && cardJs.indexOf('class="srow-r1"') < cardJs.indexOf("srow-r2") && cardJs.indexOf("srow-r2") < cardJs.indexOf("srow-r3"), "rows render r1 title / r2 summary / r3 badge line in order");
ok(cardJs.indexOf('srow-r3">${item.pinned ? `<span class="tag pin-flag">置顶</span>` : ""}${item.tag ?') > -1 && cardJs.indexOf("engineBadgeMarkup(item)", cardJs.indexOf('class="srow-r3"')) > cardJs.indexOf('class="srow-r3"'), "badges emitted inside r3 (pin-flag first, title takes back full width)");
ok(cardJs.includes('${item.tag || item.engine || item.source || item.pinned ? `<span class="srow-r3">') , "r3 renders only when any badge exists (pinned counts, no hollow line)");
ok(html.includes("#d-session .srow-r3 > * { flex: none; margin-top: 0; }"), "r3 badges never shrink");
const timeRule = cssBlock("#d-session .srow-time");
ok(timeRule.includes("margin-left: auto") && timeRule.includes("flex: none") && r1Strong.includes("flex: 1 1 auto"), "srow-time right-aligned via margin-left:auto (strong flex:1 shrinks first)");
ok(cardJs.includes('<span class="srow-sec" data-work-sec="${item.workSecs || 0}">'), "working row emits .srow-sec with data-work-sec base");

// ---- ② 密度三档：行变量循环（卡变量改行变量，档位键不变） ----
const rowBlock = cssBlock("#d-session .queue-card");
ok(blockAt("body { --srow-pad-block").includes("--srow-ava:") && blockAt('body[data-card-density="compact"] { --srow-pad-block').includes("--srow-ava:") && blockAt('body[data-card-density="relaxed"] { --srow-pad-block').includes("--srow-ava:"), "srow row vars defined for all three density tiers");
function avaSize(block: string): number {
  const m = block.match(/--srow-ava:\s*(\d+)px/);
  return m ? Number(m[1]) : 0;
}
function badgeSize(block: string): number {
  const m = block.match(/--srow-badge-size:\s*([\d.]+)px/);
  return m ? Number(m[1]) : 0;
}
const bCompact = badgeSize(blockAt('body[data-card-density="compact"] { --srow-pad-block'));
const bStandard = badgeSize(blockAt("body { --srow-pad-block"));
const bRelaxed = badgeSize(blockAt('body[data-card-density="relaxed"] { --srow-pad-block'));
ok(bCompact === 9 && bStandard === 9.5 && bRelaxed === 10, `r3 badge-size steps across tiers (${bCompact}/${bStandard}/${bRelaxed})`);
ok(bStandard < 10.5 && bCompact < 10 && bRelaxed < 11, "r3 badge-size below summary sub-size across all tiers (footnote level)");
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

// ---- ③b 满宽行（用户直馈 2026-10-05：「左右都浪费横向空间」——蒙版贯穿整列去卡感） ----
const cardBlock = cssBlock("#d-session .queue-card");
ok(cardBlock.includes("border-radius: 0"), "full-bleed row zero radius (user verdict: wechat has no rounded mask, full-width bar)");
ok(cardBlock.includes("padding: var(--srow-pad-block) 14px"), "row content starts 14px in (wider than before, title gains width)");
ok(cardBlock.includes("margin: 0"), "row spans full column width (no horizontal margin)");
ok(cssBlock("#d-session .queue").includes("padding: 16px 0"), "session column horizontal padding zeroed (session domain only, .queue base rule untouched)");
ok(!cssBlock(".queue").includes("padding: 16px 0"), "team/project queue columns keep their padding (no bleed to card domains)");
const groupBlock = cssBlock("#d-session .session-list .queue-group");
ok(groupBlock.includes("margin: 10px 0 6px") && groupBlock.includes("padding: 2px 14px"), "sticky group head full-width bg, text aligns to row content start (14px)");

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
  "#d-session .srow-r1", "#d-session .srow-r1 strong",
  "#d-session .srow-r2", "#d-session .srow-r2-t",
  "#d-session .srow-r3", "#d-session .srow-r3 > *",
  "#d-session .srow-sec", "#d-session .srow-time",
  "#d-session .queue-card:hover .srow-time, #d-session .queue-card:focus-within .srow-time",
  "#d-session .srow-cta", "#d-session .srow-cta:hover",
  "#d-session .queue-card:hover .srow-cta, #d-session .queue-card:focus-within .srow-cta",
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
ok(cardJs.includes('variant === "mobile"') && cardJs.indexOf('class="mobile-card') < cardJs.indexOf('identity-cluster">${item.tag'), "mobile card keeps legacy shell (phone mode safe)");
ok(!/<div class="row">[^`]*class="tag /.test(cardJs), "mobile title row carries no tag badge (three-row semantics)");
ok(jsConst("sessionPendingItems").includes("[...sessionQueueData.action].sort(byPinned).slice(0, 3)") && jsConst("sessionOtherItems").includes(".sort(byPinned)") && jsConst("renderSessionQueue").includes("其他会话"), "queue render keeps pending slice + pinned-first sort + other grouping");

// ---- ⑧ 走秒直更链（#78 语义移植：摘要行走秒每秒直更） ----
ok(html.includes("const srowTickStart = Date.now();") && html.includes('document.querySelectorAll("#d-session .srow-sec[data-work-sec]")') && html.includes("}, 1000);"), "per-second tick reads all .srow-sec rows");
ok(html.includes("Number(el.dataset.workSec) + elapsed + \"s\""), "tick adds elapsed to data-work-sec base");

// ---- ⑨ 行为直跑（W3 范式：单行 const 提取 → new Function 构造体内 return 调用） ----
const helperNames = ["engineIconFor", "engineBadgeMarkup", "identityMarkup", "sessionSourceColor", "sessionCtaMarkup", "renderSessionCard", "notifyCopyRows"];
const helperSrc = helperNames.map((n) => jsConst(n)).join("\n");
ok(helperNames.every((n) => jsConst(n) !== ""), "all helper consts extracted for direct run");
const harness = new Function(`${helperSrc}; return { engineIconFor, engineBadgeMarkup, identityMarkup, sessionSourceColor, sessionCtaMarkup, renderSessionCard, notifyCopyRows };`)() as {
  sessionSourceColor: (s: string) => string;
  sessionCtaMarkup: (i: { tagClass?: string }) => string;
  renderSessionCard: (i: Record<string, unknown>, v: string) => string;
  notifyCopyRows: (s: string) => string;
};
ok(harness.sessionSourceColor("家里 iMac") === "var(--source-home)" && harness.sessionSourceColor("公司电脑") === "var(--source-company)", "sessionSourceColor maps both sources to tokens");
ok(harness.sessionCtaMarkup({ tagClass: "action" }).includes('class="srow-cta"') && !harness.sessionCtaMarkup({ tagClass: "action" }).includes("srow-n"), "action row yields cta only (badge removed)");
ok(harness.sessionCtaMarkup({ tagClass: "done" }) === "", "settled row yields no cta button");
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
ok(row.includes("srow-ava") && row.includes("srow-r1") && row.includes("srow-r2") && row.includes("srow-r3") && !row.includes("srow-side") && row.includes('class="srow-cta"'), "desktop row carries three-row skeleton, cta rides card (no side wrapper)");
const r3Seg = row.slice(row.indexOf('class="srow-r3"'), row.indexOf('class="srow-cta"'));
ok(r3Seg.includes("待收单") && r3Seg.includes("engine-badge") && r3Seg.includes("source-badge"), "r3 holds tag/engine/source badges");
const r12Seg = row.slice(row.indexOf('class="srow-main"'), row.indexOf('class="srow-r3"'));
ok(!r12Seg.includes("class=\"tag ") && !r12Seg.includes("engine-badge") && !r12Seg.includes("source-badge"), "r1/r2 carry no badges (title full width)");
ok(!harness.renderSessionCard({ ...fixture, tag: "", tagClass: "", engine: "", engineClass: "", source: "" }, "desktop").includes("srow-r3"), "badge-less row renders no r3 line");
ok(row.includes('data-work-sec="96"') && row.includes(">96s<"), "working row renders ticking seconds with base");
ok(row.includes('<strong title="0.6.0-test.19 出包">0.6.0-test.19 出包</strong>'), "full title in r1 with hover title fallback");
const mrow = harness.renderSessionCard(fixture, "mobile");
ok(mrow.includes('class="mobile-card"') && mrow.includes('data-open-detail="fx1"') && !mrow.includes("srow-"), "mobile variant stays legacy mobile-card form");

// ---- ⑨c 动作组右对齐（插播 8：弹窗底/卡片底动作组锚定右下，HIG 主操作贴右缘） ----
ok(blockAt(".wait-actions {").includes("justify-content: flex-end"), "wait-actions anchored right (dialog footer)");
ok(blockAt(".notify-actions {").includes("justify-content: flex-end"), "notify-actions anchored right (desktop card + mobile card share class)");
ok(blockAt(".demo-error-actions {").includes("margin-left: auto"), "demo-error-actions trailing right inside banner row");
const waitBtns = html.match(/<div class="wait-actions">.*?<\/div><\/div>/g) || [];
ok(waitBtns.length === 2 && waitBtns.every((seg) => seg.indexOf("拒绝并说明") < seg.indexOf("允许一次")), "allow is rightmost in dialog (reject left, HIG primary-right) x2 desktop+mobile");
const notifTpl = html.slice(html.indexOf('const notificationSourceCard'), html.indexOf('const renderMobileNotificationCards'));
ok(notifTpl.indexOf('notify-light-action') < notifTpl.indexOf('primary-btn') && !notifTpl.slice(notifTpl.indexOf('notify-actions')).includes("notify-state"), "desktop notify actions = light→secondary→primary only (state moved to r3, #80b rows)");
const mobileTpl = html.slice(html.indexOf('const renderMobileNotificationCards'), html.indexOf('const renderMobileNotificationCards') + 900);
ok(mobileTpl.indexOf('notify-light-action') < mobileTpl.indexOf('primary-btn'), "mobile notify order light→primary");

// ---- ⑨d 当前源图标化（插播 9：汉字前缀→icon-desktop，句子/toast 保留文字） ----
ok(html.includes('<symbol id="icon-desktop" viewBox="0 0 24 24"><rect x="2" y="3.5" width="20" height="13.5" rx="2"></rect><path d="M8 21h8"'), "icon-desktop symbol exists (legacy DESK_SVG form: display rect + stand line)");
ok(html.includes('<span data-session-source-label title="当前源 · 公司电脑"><svg class="icon-inline" aria-hidden="true"><use href="#icon-desktop"></use></svg></span>') && !html.includes("data-source-name"), "source label = icon only, name via title tooltip (#df2-A capsule merge retires data-source-name)");
ok(html.includes('node.title = `当前源 · ${') && html.includes('closest(".source-trigger")?.querySelector("[data-current-summary]")'), "label updater keeps icon intact + title-only fallback, summary text merged into trigger (#df2-A)");
ok(html.includes("const kickerMarkup") && count(html, 'kickerMarkup(item.desktopKicker)') === 1 && /k\.startsWith\("来源团队"\) \? `<svg class="icon-inline" aria-hidden="true"><use href="#icon-users"><\/use><\/svg>` : `<svg class="icon-inline" aria-hidden="true"><use href="#icon-chat"><\/use><\/svg>`/.test(html) && html.includes('replace(/^来源会话 · /, "")'), "kicker prefix iconized (chat for sessions / users for teams), entity name kept");
ok(count(html, 'notice-icon">${item.active ? `<svg class="icon-inline" aria-hidden="true"><use href="#icon-alert"></use></svg>` : `<svg class="icon-inline" aria-hidden="true"><use href="#icon-info"></use></svg>`}') === 2, "desktop notice-icon svg in BOTH queue card + detail card (queue was char !/·, #80b completed interlude-9 miss)");
ok(count(html, 'avatar">${item.active ? `<svg class="icon-inline" aria-hidden="true"><use href="#icon-alert') === 1, "mobile notify avatar char !/· replaced by alert/info icons");
ok(html.includes('section.artifact-source .source-badge::before { display: none; }') && html.includes('${source.unreachable ? " unreachable" : ""}') && html.includes('use href="#icon-desktop"></use></svg>${source.label}'), "artifact source badge rides icon-desktop prefix, unreachable tinted working, char ↗ retired there");
ok(html.includes('notify-source-card[data-notify-active="false"] .notice-icon') && html.includes("--dim"), "inactive notify icon dimmed (active keeps error tone)");
ok(html.includes('showToast(`当前源：${state.label}`)') || html.includes('当前源：'), "toast sentences stay textual (icon policy: sentences keep words)");

// ---- ⑨e 会话 header 补偿与工具行精修（插播 10：标题/工具行与行内容同起点 14px，列表满宽不破） ----
ok(cssBlock("#d-session .queue-head, #d-session .session-list-tools").includes("padding-left: 14px") && cssBlock("#d-session .queue-head, #d-session .session-list-tools").includes("padding-right: 14px"), "session head + tools padded to row-content origin (14px)");
ok(cssBlock("#d-session .queue").includes("padding: 16px 0"), "list container stays full-bleed (padding 16px 0 intact)");
ok(html.includes('placeholder="搜索" aria-label="搜索会话、项目或来源"'), "search placeholder shortened, full semantics kept in aria-label");
ok(html.includes('data-session-filter aria-label="筛选会话 · 当前全部">全部</button>'), "filter chip text collapsed to 全部 with aria fallback");
ok(cssBlock(".session-list-tools input:focus").includes("border-color: var(--brand)"), "search focus ring on brand");
ok(cssBlock(".session-list-tools button[data-session-filter]").includes("border-radius: 999px") && cssBlock(".session-list-tools button[data-session-filter]").includes("border: 0"), "filter is a borderless pill chip");

// ---- ⑨f 通知域行化（#80b：#d-notify 迁会话域满宽行语言——列满宽/组头钉顶/行三件套/CTA 浮层/44px 手机） ----
ok(cssBlock("#d-notify .queue").includes("padding: 16px 0"), "notify queue column full-bleed (session queue same law)");
ok(cssBlock("#d-notify .queue-head").includes("padding-left: 14px") && cssBlock("#d-notify .queue-head").includes("padding-right: 14px"), "notify queue-head compensated to 14px origin");
ok(cssBlock("#d-notify .queue .queue-group").includes("position: sticky") && cssBlock("#d-notify .queue .queue-group").includes("padding: 2px 14px"), "notify queue group head sticky at 14px (session group-head law)");
ok(cssBlock("#d-notify .queue .notice").includes("border-bottom: 0") && cssBlock("#d-notify .queue .notice").includes("background: transparent"), "queue card divider removed (zero-separator)");
ok(cssBlock("#d-notify .queue .notice:hover").includes("var(--q-row-hov)"), "queue card hover uses srow instant tint");
ok(cssBlock("#d-notify .workspace-body").includes("padding: 16px 0"), "notify center workspace body sunk (domain-scoped override)");
ok(cssBlock("#d-notify .notify-source-summary").includes("margin: 0 14px 12px"), "summary banner rides 14px row origin");
ok(cssBlock(".notify-source-list").includes("gap: 0"), "notify list zero gap (whitespace-only separation)");
ok(cssBlock(".notify-source-group-head").includes("position: sticky") && cssBlock(".notify-source-group-head").includes("background: var(--bg1)") && !cssBlock(".notify-source-group-head").includes("border-top: 1px"), "source group head sticky full-width with solid cover, top divider retired");
ok(cssBlock(".notify-source-card").includes("position: relative") && cssBlock(".notify-source-card").includes("padding: 10px 14px") && cssBlock(".notify-source-card").includes("border-radius: 0") && cssBlock(".notify-source-card").includes("transition: background .06s linear"), "notify row = srow semantic row (relative anchor / 14px / zero radius / instant tint)");
ok(cssBlock(".notify-source-card.resolved").includes("opacity: .58") && !cssBlock(".notify-source-card.resolved").includes("background: var(--surface1)"), "resolved rows fade at full width (no card shell)");
ok(cssBlock(".notify-source-card .notice-icon").includes("var(--srow-ava)") && cssBlock(".notify-source-card .notice-icon").includes("color-mix"), "notice icon rides srow avatar form (34px color-mix source tint)");
ok(html.includes("#d-notify .notify-source-card:hover .nrow-time, #d-notify .notify-source-card:focus-within .nrow-time { opacity: 0; }"), "row-end time fades on hover (CTA takes the lane)");
ok(cssBlock("#d-notify .notify-actions").includes("position: absolute") && cssBlock("#d-notify .notify-actions").includes("display: none") && cssBlock("#d-notify .notify-actions").includes("right: 14px") && cssBlock("#d-notify .notify-actions").includes("background: var(--bg1)"), "notify action group = floating overlay (absolute 14px, zero layout shift, solid anti-ghosting base)");
const rowCardTpl = html.slice(html.indexOf('const notificationSourceCard'), html.indexOf('const renderNotificationSourceCards'));
ok(rowCardTpl.includes('class="notify-row-main"') && rowCardTpl.includes('class="nrow-r1"') && rowCardTpl.includes('class="nrow-time"') && rowCardTpl.includes('class="nrow-r3"'), "notify row DOM = ava + r1(title+time) + kicker + copy + r3(identity+state)");
ok(rowCardTpl.indexOf('nrow-r3') < rowCardTpl.indexOf('notify-state') && !rowCardTpl.slice(rowCardTpl.indexOf('notify-actions')).includes("notify-state"), "state badge lives in r3 (visible without hover), actions stay button-only");
ok(html.includes(".mobile-notify-card { padding: 8px 14px; margin-bottom: 0; min-height: 44px; border: 0; border-radius: 0;"), "mobile notify card = 44px row gauge, 14px origin, divider removed (#82)");
ok(!html.includes('icon.innerHTML = bell'), "hydrate bell blanket override retired (row identity alert/info survives boot)");

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
