// #W-BLANKSET P0 防回归（静态锚）：1016 用户 Windows WebView2 旧内核实锤——设置域
// 整域不可见（文字透明+布局塌陷=CSS 声明被旧解析器丢弃形态）+ 手机模式 b2Api 悬空
// 引用炸断 refreshMobile 初始化链（窄视口/DPI 缩放四屏动态全空）。
//
// 矩阵（三段）：
//   B1  color-mix 渐进增强守卫：<style> 内每条 color-mix 声明前必有同属性静态声明
//      （transparent/var/none——旧内核丢 modern 声明时回退到前条，不再裸奔到继承链）
//   B2  b2Api 访问器锚：手机 IIFE 内定义存在（真身 __ccDeck005B2；#150 R2 并轨时
//      定义被删而 10 处调用悬空的 1016 实锤不再复发）
//   B3  初始化链兜底锚：setupMobileSettings/setupMobileDetail/refreshMobile/subscribe
//      四段 safeInit 包裹（单点炸不断全链）
//
// 跑法：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-blankset.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-console", "index-005.html"), "utf-8");
let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("== W-BLANKSET P0 守卫：WebView2 旧内核 CSS 兜底 + b2Api/初始化链 ==");

// ---- B1 color-mix 渐进增强守卫 ----
{
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const css = styleBlocks.join("\n");
  const declRe = /([a-zA-Z-]+)\s*:\s*([^;{}]*color-mix\([^;{}]*\)[^;{}]*)/g;
  let total = 0;
  const bare: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(css))) {
    total++;
    const prop = m[1];
    const before = css.slice(Math.max(0, m.index - 240), m.index);
    // 同属性静态声明紧邻在前：取前文中最后一段声明（以 ; { } 共同为界——压缩行内
    // `prop: static; prop: color-mix(...)` 的 tail 即前条）
    const segs = before.split(/[;{}]/).filter((s) => s.trim());
    const tail = segs[segs.length - 1] ?? "";
    if (!new RegExp("^\\s*" + prop + "\\s*:\\s*(transparent|none|var\\(--[\\w-]+\\)|#)[^;]*$").test(tail)) bare.push(prop + ": " + m[2].slice(0, 60));
  }
  ok(total >= 90, `B1① color-mix 声明规模在册（${total} 条 ≥90——兜底覆盖面不缩水）`);
  ok(bare.length === 0, `B1② 每条 color-mix 声明前有同属性静态兜底（裸奔 ${bare.length} 条${bare.length ? "：" + bare.slice(0, 3).join(" / ") : ""}）`);
  // box-shadow 全兜底 none（旧内核 shadow 色丢=整条丢，兜底必须整条静态）
  const shadowBare = [...css.matchAll(/box-shadow\s*:\s*[^;{}]*color-mix/g)].filter((s) => !/box-shadow\s*:\s*none;\s*$/.test(css.slice(Math.max(0, s.index - 60), s.index)));
  ok(shadowBare.length === 0, `B1③ box-shadow 色混声明前置 none 兜底（${shadowBare.length} 条缺）`);
}

// ---- B2 b2Api 访问器锚 ----
{
  ok(/const b2Api = \(\) => window\.__ccDeck005B2 \|\| null;/.test(html), "B2① b2Api 访问器定义在场（真身 __ccDeck005B2，缺桥 null 走 fallback）");
  const defIdx = html.indexOf("const b2Api = () => window.__ccDeck005B2");
  const calls = [...html.matchAll(/\bb2Api\(\)/g)].map((c) => c.index);
  ok(defIdx > 0 && calls.length >= 8 && calls.every((i) => i > defIdx), `B2② b2Api 调用（${calls.length} 处）全部晚于定义（悬空引用形态不再复发）`);
  ok(/window\.__ccDeck005B2 = \{/.test(html), "B2③ __ccDeck005B2 导出面在场（⑥c-3 B2 会话世界真身）");
}

// ---- B3 初始化链兜底锚 ----
{
  ok(/const safeInit = \(name, fn\) => \{ try \{ fn\(\); \} catch \(err\) \{ console\.warn/.test(html), "B3① safeInit 兜底包装器在场（炸段 warn 留痕不中断）");
  for (const seg of ["setupMobileSettings", "setupMobileDetail", "refreshMobile"]) {
    ok(new RegExp('safeInit\\("' + seg + '"').test(html), `B3② ${seg} 经 safeInit 包裹`);
  }
  ok(/bridge\.subscribe\(\(\) => refreshMobile\(\)\)/.test(html) && /safeInit\("subscribe"/.test(html), "B3③ 桥订阅经 safeInit（炸段不再断手机动态刷新链）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
