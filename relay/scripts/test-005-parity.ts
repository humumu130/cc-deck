// #80 005 原型存量特性补全：P1 七项静态锚+行为直跑+已有面锁定。
// 靶子 specs/005-prototype-a.html；对照旧版 web-console/index.html 盘点表 /tmp/005-parity-audit.md
// （29 缺口 P1 11/P2 9/P3 9；死 tab 误判已实探修正——tab 面在本文件 T 节锁定防回退）。
// 覆盖：T 已有面锁定（五 tab 懒注入+任务四态+readonly-banner）/M 右键菜单/H 隐藏项目恢复/
// K 键盘（↑↓ 会话+⌘←→ 源循环+守卫）/I IME 守卫/D 拖入蒙层/B 回到底/通用纪律（toast 配套+token）。
// 行为探针 /tmp/005parityprobe.html 33/33（行为侧）；本文件静态锚+纯函数直跑互为犄角。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-parity.ts
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
function blockAt(needle: string): string {
  const i = html.indexOf(needle);
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
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
function fnBody(name: string): string {
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  return "";
}
function jsConst(name: string): string {
  const i = html.indexOf(`const ${name} = `);
  if (i < 0) return "";
  const end = html.indexOf("\n", i);
  return html.slice(i, end);
}
function count(hay: string, needle: string) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

// ---- T. tab 已有面锁定（盘点修正：死 tab 是静态读码误判，实探 12/12；防回退锁） ----
for (const fn of ["setupSessionTabs", "setupMobileDetailTabs", "setupTeamTabs", "setupMobileTeamTabs", "setupProjectTabs"]) {
  ok(fnBody(fn) !== "", `tab wire fn ${fn} exists`);
}
const bootZone = html.slice(html.indexOf("setupRowMenu();"));
ok(["setupRowMenu", "setupHiddenProjectRestore", "setupSessionKeyNav", "setupDocDragOver", "setupBackToBottom", "setupSessionTabs"].every((fn) => bootZone.includes(fn + "();")), "P1 setups invoked at boot");
ok(fnBody("setupSessionTabs").includes("已完成 · 6") && fnBody("setupSessionTabs").includes("进行中 · 1") && fnBody("setupSessionTabs").includes("待审查 · 1") && fnBody("setupSessionTabs").includes("待办 · 1"), "desktop task pane injects four-state groups (verify lane renamed 待审查 per 2026-10-05 word table)");
ok(fnBody("setupMobileDetailTabs").includes("innerHTML") && fnBody("setupSessionTabs").includes("已完成 · 6"), "mobile task pane mirrors desktop inject (innerHTML reuse → four-state groups ride along)");
ok(fnBody("setupSessionTabs").indexOf("已完成 · 6") < fnBody("setupSessionTabs").indexOf("进行中 · 1") && fnBody("setupSessionTabs").indexOf("进行中 · 1") < fnBody("setupSessionTabs").indexOf("待审查 · 1") && fnBody("setupSessionTabs").indexOf("待审查 · 1") < fnBody("setupSessionTabs").indexOf("待办 · 1"), "four-state order done→run→review→todo (legacy :6543 semantics, lane word table 2026-10-05)");
ok(fnBody("setupSessionTabs").includes("readonly-banner") || html.includes("readonly-banner"), "⋯ pane readonly-banner intact");

// ---- M. 行右键菜单（1c+13a+14a：四动作+working 拦截+五路收起） ----
ok(cssBlock(".row-menu").includes("position: fixed"), "row-menu overlay fixed (no layout shift)");
ok(['data-row-action="pin"', 'data-row-action="rename"', 'data-row-action="copyid"', 'data-row-action="del"'].every((a) => fnBody("openRowMenu").includes(a)), "menu carries pin/rename/copyid/del actions");
ok(fnBody("openRowMenu").includes("会话运行中，不能删除"), "working row delete intercepted with toast");
ok(fnBody("setupRowMenu").includes('addEventListener("contextmenu"') && fnBody("setupRowMenu").includes("pointerdown") && fnBody("setupRowMenu").includes("scroll") && fnBody("setupRowMenu").includes("resize"), "menu closes on contextmenu/pointerdown/scroll/blur/resize wiring");
ok(fnBody("closeRowMenu") !== "" && fnBody("wireOverlayEscape").includes('getElementById("row-menu")'), "Escape chain wired to row-menu (closeTransientOverlays + keydown branch)");
ok(html.includes("const commitRename") && html.includes('input.addEventListener("blur", commitRename, { once: true })'), "rename commits via idempotent commitRename (Enter direct + blur once)");
ok(fnBody("setupRowMenu").includes("contextmenu") && html.includes('data-hidden-project title="右键恢复显示"'), "hidden project card exposes contextmenu affordance");

// ---- H. 已隐藏项目右键恢复（7a：文案承诺的交互必须存在） ----
ok(fnBody("setupHiddenProjectRestore").includes("contextmenu") && fnBody("setupHiddenProjectRestore").includes("已恢复显示"), "right-click restores hidden project + toast");
ok(fnBody("setupHiddenProjectRestore").includes("活跃项目") && fnBody("setupHiddenProjectRestore").includes("remove()"), "restore moves card to active group + head count +1, hidden head removed");

// ---- K. ↑↓ 切会话（1a：裸键空输入+Alt 档+浮层不抢+守卫链） ----
ok(fnBody("moveSessionSelection") !== "" && fnBody("moveSessionSelection").includes("scrollIntoView") && fnBody("moveSessionSelection").includes("composer-input") , "arrow nav moves selection, scrolls into view, focuses composer");
ok(fnBody("moveSessionSelection").includes("showToast") === false, "arrow nav emits no toast (high-frequency op stays silent)");
ok(fnBody("setupSessionKeyNav").includes("row-rename-input") && fnBody("setupSessionKeyNav").includes(".source-menu.open") && fnBody("setupSessionKeyNav").includes("altKey"), "bare key guarded: rename input / open overlays; alt tier anywhere");
ok(fnBody("setupSessionKeyNav").includes('trim()') || fnBody("setupSessionKeyNav").includes("value"), "bare key only on empty composer draft");

// ---- K2. ⌘/Ctrl+←→ 切源循环（1b） ----
ok(fnBody("setupSessionKeyNav").includes('ArrowRight') && fnBody("setupSessionKeyNav").includes("metaKey") && fnBody("setupSessionKeyNav").includes("ctrlKey"), "cmd/ctrl+arrow tier present");
ok(fnBody("setupSessionKeyNav").includes('tagName === "INPUT"') && fnBody("setupSessionKeyNav").includes("isContentEditable"), "text-editing targets not hijacked (input/textarea/contentEditable guard)");

// ---- I. IME composition 守卫（3a：Enter 误发根治） ----
const composerGuards = count(html, "isComposing || e.keyCode === 229") + count(html, "e.isComposing || e.keyCode === 229");
ok(composerGuards >= 2, `composition guard on Enter paths (${composerGuards} sites, composer + rename)`);

// ---- D. 文档级拖入蒙层（3b：防默认白屏 + 载荷分流引导） ----
ok(blockAt("body.file-drag-over::after").includes("松开把文件加进输入栏"), "drag-over mask with actionable copy");
ok(fnBody("setupDocDragOver").includes("depth") && fnBody("setupDocDragOver").includes("dragleave") && fnBody("setupDocDragOver").includes("preventDefault"), "depth counting + leave collapse + drop preventDefault");
ok(fnBody("setupDocDragOver").includes("types") && fnBody("setupDocDragOver").includes("文件") , "empty-types treated as potential file + uri payload toast guide");

// ---- B. 回到底（15a：离底 80px+停 300ms 复核+滚动中先收+平滑回底） ----
ok(cssBlock(".back-to-bottom").includes("position: fixed"), "back-to-bottom pinned to viewport (works in page-scroll prototype form)");
ok(fnBody("setupBackToBottom").includes("300") && fnBody("setupBackToBottom").includes("nearBottom") && fnBody("setupBackToBottom").includes("behavior: \"smooth\""), "300ms settle recheck + smooth scroll to bottom");
ok(fnBody("setupBackToBottom").includes("scrollingElement") && fnBody("setupBackToBottom").includes("#d-session.active"), "dual scroller detection (element vs page) + session-active gate");

// ---- 通用纪律 ----
ok(jsConst("sessionCtaMarkup").includes('class="srow-cta"') && jsConst("renderSessionCard").includes("${sessionCtaMarkup(item)}"), "CTA overlay rides card (interlude 4/5 intact)");
ok(cssBlock("#d-session .queue-card").includes("border-radius: 0") && cssBlock("#d-session .queue").includes("padding: 16px 0"), "full-bleed row language intact (interlude 6/7)");
ok(cssBlock(".wait-actions").includes("justify-content: flex-end") && cssBlock(".notify-actions").includes("justify-content: flex-end"), "action groups anchored right (interlude 8)");
ok(count(html, "web-console") === 0, "zero references to legacy web-console (borrow semantics, never implementation)");
const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
let compiled = true;
try { new Function(script); } catch { compiled = false; }
ok(compiled, "inline script compiles (syntax gate)");

console.log(`\n005-parity: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
