// #W-BLANKSET P0 防回归（静态锚）：1016 用户 Windows WebView2 旧内核实锤——设置域
// 整域不可见（文字透明+布局塌陷=CSS 声明被旧解析器丢弃形态）+ 手机模式 b2Api 悬空
// 引用炸断 refreshMobile 初始化链（窄视口/DPI 缩放四屏动态全空）。
//
// 矩阵（三段）：
//   B1  color-mix 渐进增强守卫（@supports 形态，DEV-41 P1-1 返修后军规）：每条 color-mix
//      声明必须在 @supports (color: color-mix(in srgb, red, blue)) 块内，块外同选择器
//      必有同属性静态兜底且旧内核真实合法可计算（简单色 var() 引用/直接静态色/none/
//      transparent/静态层阴影/stop 替换渐变）。机制依据：含 var() 的未知函数声明在旧内核
//      走 IACVT（computed-value 时整条 unset），「前条静态＋后条 color-mix」双写不回退
//      （css-variables 经典陷阱，1016 实锤根因面）——只有 parse 期 @supports 特性检测
//      才能把 modern 声明整块挡在旧内核之外，让块外静态真实生效。
//      B1④ 内联面（js/ 里 style="..." 属性）：@supports 不可用于 style 属性，等价军规
//      =同属性静态声明紧邻在前（无 var() 的 color-mix parse 期即丢，前条真实回退）。
//   B2  b2Api 访问器锚：手机 IIFE 内定义存在（真身 __ccDeck005B2；#150 R2 并轨时
//      定义被删而 10 处调用悬空的 1016 实锤不再复发）
//   B3  初始化链兜底锚：setupMobileSettings/setupMobileDetail/refreshMobile/subscribe
//      四段 safeInit 包裹（单点炸不断全链）
//
// 跑法：env -u CCR_ORG_DIR node --import tsx/esm tests/test-005-blankset.ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-console");
  const html = readFileSync(join(webDir, "index-005.html"), "utf-8") + readFileSync(join(webDir, "css", "base.css"), "utf-8") + readFileSync(join(webDir, "css", "tokens.css"), "utf-8")
    + readdirSync(join(webDir, "js")).map((f) => readFileSync(join(webDir, "js", f), "utf-8")).join("\n"); // W-SPLIT-S4b：JS 外置后锚面=html+js 并集
let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("== W-BLANKSET P0 守卫：WebView2 旧内核 CSS 兜底 + b2Api/初始化链 ==");

// ---- B1 color-mix 渐进增强守卫（@supports 形态）----
{
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const cssSources = [...styleBlocks, readFileSync(join(webDir, "css", "base.css"), "utf-8"), readFileSync(join(webDir, "css", "tokens.css"), "utf-8")]; // W-SPLIT-S4a/b：CSS 外置两件并入守卫面（逐文件独立——拼接边界假阳防护）
  const SUP = "@supports (color: color-mix(in srgb, red, blue))";
  const mask = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, (s) => " ".repeat(s.length)); // 注释盲化（同长保偏移）
  // 静态兜底合法性：旧内核真实可计算——括号平衡、var() 首参 --ident、无函数外裸 %（残片特征）
  const legalStatic = (v: string) => {
    if (!v.trim()) return false;
    let d = 0;
    for (const c of v) { if (c === "(") d++; if (c === ")") { d--; if (d < 0) return false; } }
    if (d !== 0) return false;
    for (const vm of v.matchAll(/var\(([^()]*)\)/g)) {
      if (!/^\s*--[\w-]+\s*(,.*)?$/.test(vm[1])) return false;
    }
    let t = v;
    while (/\([^()]*\)/.test(t)) t = t.replace(/\([^()]*\)/, (s) => " ".repeat(s.length));
    return !/(^|[\s,])\d+(\.\d+)?%/.test(t);
  };
  let totalModern = 0;
  const bare: string[] = [];        // @supports 块外的 color-mix（裸奔）
  const noBase: string[] = [];      // @supports 内声明在块外无「同选择器＋同属性」合法静态兜底
  const strayInSup: string[] = [];  // @supports 块内混入的非 color-mix 声明（块内只装 modern）
  const baseProps = new Map<string, Set<string>>(); // sel -> 同属性静态已检合法的属性集
  const baseKfs = new Set<string>();
  for (const raw of cssSources) {
    const t = mask(raw);
    // 1) 枚举 @supports 块（brace 配对定界）
    const supSpans: Array<[number, number, string]> = [];
    let si = 0;
    while ((si = t.indexOf(SUP, si)) !== -1) {
      const ob = t.indexOf("{", si);
      let d = 1, j = ob + 1;
      while (j < t.length && d > 0) { if (t[j] === "{") d++; else if (t[j] === "}") d--; j++; }
      supSpans.push([si, j, t.slice(ob + 1, j - 1)]);
      si = j;
    }
    const inSup = (p: number) => supSpans.some(([s, e]) => p >= s && p < e);
    // 2) 块外 color-mix 全禁（含 @keyframes 同名包裹形态的基名收集）
    let ci = 0;
    while ((ci = t.indexOf("color-mix(", ci)) !== -1) {
      if (!inSup(ci)) bare.push(t.slice(Math.max(0, t.lastIndexOf("\n", ci) + 1), ci + 30).trim());
      ci += 10;
    }
    for (const km of t.matchAll(/@keyframes\s+([\w-]+)/g)) if (!inSup(km.index ?? 0)) baseKfs.add(km[1]);
    // 3) 块外基础规则收集：同属性静态声明（多行/单行规则通用——brace 配对叶子遍历）
    const leafRe = /([^{}]+)\{([^{}]*)\}/g;
    let lm: RegExpExecArray | null;
    while ((lm = leafRe.exec(t))) {
      if (inSup(lm.index + lm[1].length)) continue;
      const sel = lm[1].trim();
      if (sel.startsWith("@")) continue;
      let props = baseProps.get(sel);
      if (!props) { props = new Set(); baseProps.set(sel, props); }
      for (const dcl of lm[2].split(";")) {
        const c = dcl.indexOf(":");
        if (c < 0) continue;
        const p = dcl.slice(0, c).trim();
        const v = dcl.slice(c + 1).trim();
        if (p && legalStatic(v) && !v.includes("color-mix(")) props.add(p);
      }
    }
    // 4) @supports 块内：modern 声明计数＋块外同选择器同属性静态兜底核验
    for (const [, , inner] of supSpans) {
      const kf = inner.match(/^\s*@keyframes\s+([\w-]+)/);
      if (kf) {
        totalModern += (inner.match(/color-mix\(/g) || []).length;
        if (!baseKfs.has(kf[1])) noBase.push(`@keyframes ${kf[1]} 块外无同名基座`);
        continue;
      }
      const rr = /([^{}]+)\{([^{}]*)\}/g;
      let m2: RegExpExecArray | null;
      while ((m2 = rr.exec(inner))) {
        const sel = m2[1].trim();
        for (const dcl of m2[2].split(";")) {
          const c = dcl.indexOf(":");
          if (c < 0) continue;
          const p = dcl.slice(0, c).trim();
          const v = dcl.slice(c + 1).trim();
          if (!p || !v) continue;
          if (!v.includes("color-mix(")) { strayInSup.push(`${sel} ${p}`); continue; }
          totalModern++;
          if (!baseProps.get(sel)?.has(p)) noBase.push(`${sel} ${p}`);
        }
      }
    }
  }
  ok(totalModern >= 180, `B1① color-mix modern 声明规模在册（${totalModern} 条 ≥180——兜底覆盖面不缩水）`);
  ok(bare.length === 0, `B1② color-mix 全部入 @supports 块（块外裸奔 ${bare.length} 处${bare.length ? "：" + bare.slice(0, 3).join(" / ") : ""}）`);
  ok(noBase.length === 0, `B1③ 每条 modern 声明块外有同选择器同属性合法静态兜底（缺 ${noBase.length} 处${noBase.length ? "：" + noBase.slice(0, 3).join(" / ") : ""}）`);
  ok(strayInSup.length === 0, `B1③b @supports 块内只装 color-mix modern 声明（混入 ${strayInSup.length} 条${strayInSup.length ? "：" + strayInSup.slice(0, 3).join(" / ") : ""}）`);
  // B1④ 内联面：js/ 里 style 属性中的 color-mix 必须前置同属性静态声明（var-free → parse 期丢、前条回退成立）
  const inlineBare: string[] = [];
  for (const f of readdirSync(join(webDir, "js"))) {
    const js = readFileSync(join(webDir, "js", f), "utf-8");
    for (const sm of js.matchAll(/style="([^"]*)"/g)) {
      const attr = sm[1];
      const cm = attr.match(/([a-zA-Z-]+)\s*:\s*color-mix\(/);
      if (!cm) continue;
      const prop = cm[1];
      const head = attr.slice(0, cm.index);
      if (!new RegExp(prop + "\\s*:\\s*[^;]+;\\s*$").test(head)) inlineBare.push(`${f} ${prop}`);
    }
  }
  ok(inlineBare.length === 0, `B1④ 内联 style 属性 color-mix 前置静态兜底（裸奔 ${inlineBare.length} 处${inlineBare.length ? "：" + inlineBare.slice(0, 3).join(" / ") : ""}）`);
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
  ok(/bridge\.subscribe/.test(html) && /safeInit\("subscribe"/.test(html), "B3③ 桥订阅经 safeInit（rAF 合帧后订阅体非直接调 refreshMobile——W-MOBILE-PERF 审查P1-1 断言随结构更新）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
