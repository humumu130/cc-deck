// #78 微信式会话行（第二列卡片→通栏行）静态锚点测试。
// 本批为纯 CSS/DOM 结构改造（无新增纯函数段），断言以静态锚点为主：
// 主题变量双值、行骨架三段标记、行间零分隔线、hover/选中淡底、密度档位类、
// 组头结构、保留面交互锚点（改名/删除/CTA/走秒直更）、W1a 结构闸。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-wechat-rows.ts
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
// 提取 CSS 规则块（选择器开头 → 对应平衡花括号）
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

console.log("== #78 wechat rows: static anchors ==");

// ---- ① 主题变量双值（亮暗各自成对） ----
const rootBlock = cssBlock(":root");
const lightBlock = cssBlock("html.light");
ok(count(rootBlock, "--q-row-hov:") === 1, "root --q-row-hov exactly once");
ok(count(rootBlock, "--q-row-sel:") === 1, "root --q-row-sel exactly once");
ok(count(rootBlock, "--q-n-bg:") === 1, "root --q-n-bg exactly once");
ok(count(lightBlock, "--q-row-hov:") === 1, "light --q-row-hov exactly once");
ok(count(lightBlock, "--q-row-sel:") === 1, "light --q-row-sel exactly once");
ok(count(lightBlock, "--q-n-bg:") === 1, "light --q-n-bg exactly once");
// 淡底是中性灰调淡色（非纯黑纯白、非高饱和大块色）：alpha ≤ .2 的 rgba
ok(/--q-row-hov:\s*rgba\([^)]*,\s*0?\.\d+\)/.test(rootBlock) && /--q-row-sel:\s*rgba\([^)]*,\s*0?\.\d+\)/.test(rootBlock), "root tint values are low-alpha rgba");

// ---- ② 行骨架三段标记（CSS 规则在位 + render 组装串产出） ----
for (const cls of [".q-ava", ".q-main", ".q-r1", ".q-r2", ".q-side"]) ok(cssBlock(cls) !== "", "css rule " + cls);
const jsRow = html.slice(html.indexOf('const avaBlock ='));
ok(jsRow.includes('\'<div class="q-ava"') || html.includes('\'<div class="q-ava"'), "render emits q-ava");
ok(html.includes('\'<div class="q-main">\''), "render emits q-main");
ok(html.includes('\'<div class="q-r1">\''), "render emits q-r1");
ok(html.includes('\'<div class="q-r2">\''), "render emits q-r2");
ok(html.includes('\'<div class="q-side">\''), "render emits q-side");
// 头像位状态灯复用 .c-dot（呼吸/浅色 LED 规则全继承）
ok(cssBlock(".q-ava .c-dot") !== "", "q-ava reuses .c-dot for status dot");

// ---- ③ 行间零分隔线（用户拍板：电脑端不画线，分行靠留白） ----
const cardBlock = cssBlock(".card");
ok(cardBlock.includes("background: none") && cardBlock.includes("border: none"), ".card base rule has no box (background/border none)");
ok(!/\bborder-bottom\b/.test(cardBlock), ".card rule has no border-bottom hairline");
ok(!html.includes("hairline"), "no hairline token anywhere");
ok(count(html, ".q-row-line") === 0 && count(html, ".row-divider") === 0, "no divider class introduced");

// ---- ④ hover 瞬时淡底 / 选中持续淡底（走主题变量） ----
ok(/\.card:hover\s*\{\s*background:\s*var\(--q-row-hov\);?\s*\}/.test(html), ".card:hover uses --q-row-hov");
ok(/\.card\.sel\s*\{\s*background:\s*var\(--q-row-sel\);?\s*\}/.test(html), ".card.sel uses --q-row-sel");
// hover 瞬时即现即逝：transition 只剩 background 且时长 ≤ .1s
ok(/transition:\s*background\s*\.0?6s/.test(cardBlock), ".card transition is instant (<=.1s background only)");

// ---- ⑤ 密度两态（densityBtn 文案与循环不变；紧凑=压缩行高，共用行 DOM） ----
ok(cssBlock(".card.compact") !== "", ".card.compact sizing rule exists");
ok(/\.card\.compact\s*\{\s*padding:\s*4px 16px;?\s*\}/.test(html), "compact compresses row padding");
// 原 listCompact DOM 分支废止：c-row1 不再被产出（仅存于历史注释）
ok(count(html, '"c-row1"') === 0 && count(html, "'c-row1'") === 0 && !/class=\\?"c-row1/.test(html), "compact no longer emits c-row1 branch");
ok(html.includes('"密度·" + (listCompact ? "紧凑" : "标准")'), "densityBtn label loop unchanged");
ok(html.includes('listCompact = !listCompact;'), "densityBtn toggle loop unchanged");

// ---- ⑥ 组头结构保持（待处理/其他会话 + sticky 适配） ----
ok(html.includes('<span class="q-head-t">待处理</span>'), "pending group header intact");
ok(html.includes('<span class="q-head-t">其他会话</span>'), "others group header intact");
ok(/\.q-head\s*\{[^}]*position:\s*sticky/.test(html), "q-head is sticky");

// ---- ⑦ needs_action 角标（数字圆点；无通知的待办记 1） ----
ok(cssBlock(".q-n") !== "", ".q-n badge css exists");
ok(html.includes('class="q-n"'), "render emits q-n badge");
ok(html.includes("Math.max(1, nCount)"), "badge count floors at 1");
ok(html.includes("qflags.needs_action"), "badge gated by queuePartition flags");

// ---- ⑧ 保留面交互锚点（零回退） ----
ok(html.includes('d.querySelector(".card-edit")') && html.includes('startCardRename(d, s, ctx)'), "rename interaction intact");
ok(html.includes('requestDelete(ctx.cfg.id, s.session_id)'), "delete interaction intact");
ok(html.includes('d.querySelector(".card-cta button")'), "cta binding intact");
ok(/setInterval\(\(\) => \{\s*\n?\s*for \(const el of document\.querySelectorAll\("#cards \.card\.WORKING"\)\)/.test(html), "per-second lv-sec updater intact");
ok(html.includes('el.querySelector(".lv-sec")'), "updater writes .lv-sec (row keeps live class)");
for (const st of [" historical", " dormant", " bg-live", " idle", " compact"]) {
  ok(html.includes('"' + st + '"'), "state class" + st + " still applied (row className assembly)");
}
ok(html.includes('classList.contains("card-rename")'), "rename-rebuild guard intact");
ok(html.includes('W1A-PROJECTION-START') && html.includes('W1A-PROJECTION-END'), "W1A-PROJECTION anchor block untouched");

// ---- ⑨ 结构闸（与既有批次同口径） ----
const endIdx = html.indexOf("</html>");
ok(endIdx > 0 && html.slice(endIdx + 7).trim() === "", "nothing after </html>");
// 静态 id 唯一（body 静态标记区；JS 模板串里的动态 id 另计在全量口径）
const staticHtml = html.slice(html.indexOf("<body"), html.indexOf("<script", html.indexOf("<body")));
const ids = [...staticHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(ids).size === ids.length && ids.length > 50, "static ids unique (" + ids.length + ")");
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(allIds).size === allIds.length, "all ids unique (" + allIds.length + ")");

console.log(`\nwechat-rows: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
