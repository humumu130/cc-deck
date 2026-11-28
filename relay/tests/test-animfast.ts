// animfast（#194 常驻无限动画耗电根治）静态锚——三刀真锁：
//   刀1 transform/opacity 化：全 keyframes 无 box-shadow/background-position 重绘帧
//     （注释剥除后解析，防注释文本误报）+四主凶+ndot 伪元素承载结构锚（本体零动画）
//   刀2 hidden 全停：html.app-hidden paused !important 规则在场+index-005 挂点
//     （__appHiddenSync/visibilitychange/初始 sync 三件）
//   刀3 降频：working 3s/standby·breathe 3.6s/blink 2.2s/wait 3s/ndot 3s 逐频锚
//   +退役锚（slimPulseKf/demo-shimmer/demo-skeleton 死代码零残留）+保留清单锚
//     （瞬时/交互类在册防误删）+infinite 全景名单锁（新增 infinite 必须过此单分类）
//
// 直跑：env -u CCR_ORG_DIR npx tsx tests/test-animfast.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");
const html = readFileSync(join(root, "web-console", "index-005.html"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function section(name: string) { console.log(name); }

// 剥 CSS 注释后解析 @keyframes 块（花括号深度配平）
function keyframesBlocks(src: string): Map<string, string> {
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    for (; i < bare.length && depth > 0; i++) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}") depth--;
    }
    out.set(m[1], bare.slice(start, i - 1));
  }
  return out;
}
const kfs = keyframesBlocks(css);
const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");

async function main() {
  section("\nA 刀1 keyframes 零重绘帧（box-shadow/background-position 全退役）：");
  const repaintKfs: string[] = [];
  for (const [name, body] of kfs) {
    if (/box-shadow/.test(body)) repaintKfs.push(name + "(box-shadow)");
    if (/background-position/.test(body)) repaintKfs.push(name + "(background-position)");
  }
  ok(repaintKfs.length === 0, `全 ${kfs.size} 个 keyframes 无重绘帧（残留：${repaintKfs.join(",") || "无"}）`);
  for (const n of ["st-glow-pulse", "st-standby-breathe", "dot-breathe", "conn-wait-blink", "ndot-pulse", "wait-pulse"]) {
    const b = kfs.get(n) ?? "";
    ok(kfs.has(n) && /opacity/.test(b) || (n === "ndot-pulse" && /transform/.test(b)), `${n} 帧体=opacity（ndot=transform+opacity）`);
  }

  section("\nB 刀1 伪元素承载结构（本体零动画，光晕在 ::after）：");
  ok(/\.status-dot\.working::after[^{]*\{[^}]*animation:\s*st-glow-pulse\s+3s/.test(cssBare), "working 灯：::after 承载 st-glow-pulse 3s");
  ok(/\.status-dot\.working-standby::after[^{]*\{[^}]*animation:\s*st-standby-breathe\s+3\.6s/.test(cssBare), "standby 灯：::after 承载 st-standby-breathe 3.6s");
  ok(/\.agdot::after[^{]*\{[^}]*animation:\s*dot-breathe\s+3\.6s/.test(cssBare), "agdot：::after 承载 dot-breathe 3.6s");
  ok(/\.ngrp \.ndot\.r\.np-pulse::after[^{]*\{[^}]*animation:\s*ndot-pulse\s+3s/.test(cssBare), "ndot 未读脉冲：::after 承载 ndot-pulse 3s");
  ok(/\.status-dot\.working::after[^{]*\{[^}]*box-shadow:/.test(cssBare) && /\.ngrp \.ndot\.r\.np-pulse::after[^{]*\{[^}]*background:/.test(cssBare), "伪元素光晕=静态一次性绘制（box-shadow/background 不在帧内）");
  for (const sel of [".status-dot.working {", ".status-dot.working-standby {", ".agdot {", "#d-session .srow-live-dot {", ".team-drawer .roster-row .lamp-dot.working {", ".team-drawer .roster-row .lamp-dot.standby {"]) {
    const i = cssBare.indexOf(sel);
    const block = i >= 0 ? cssBare.slice(i, cssBare.indexOf("}", i)) : "";
    ok(i >= 0 && !/animation:/.test(block), `${sel} 本体块零 animation`);
  }
  ok(/\.status-dot\.working[^{]*position:\s*relative/.test(cssBare) || /\.status-dot\.working,/.test(cssBare), "灯族 position:relative 在场（伪元素定位锚）");

  section("\nC 刀2 hidden 全停（app-hidden 挂摘链）：");
  ok(/html\.app-hidden[^{]*\{[^}]*animation-play-state:\s*paused\s*!important/.test(cssBare), "CSS：html.app-hidden 下一切 animation paused !important");
  ok(/html\.app-hidden[^{]*\*,[^{]*::before[^{]*::after/.test(cssBare), "paused 覆盖伪元素（::before/::after 同停——光晕呼吸本体在伪元素上）");
  ok(/window\.__appHiddenSync\s*=/.test(html), "JS 挂点：window.__appHiddenSync 暴露（探针直调入口）");
  ok(/addEventListener\("visibilitychange",\s*sync\)/.test(html), "JS 挂点：visibilitychange→sync 监听在 index-005（js 域脚本之前，加载即生效）");
  ok(/classList\.toggle\("app-hidden",\s*document\.hidden\)/.test(html), "sync 逻辑=classList.toggle(\"app-hidden\", document.hidden)（真源：document.hidden 非自定义态）");

  section("\nD 刀3 降频锚（呼吸/blink 减半节奏）：");
  ok(/animation:\s*st-glow-pulse\s+3s/.test(cssBare), "working 呼吸 1.5s→3s");
  ok(/animation:\s*st-standby-breathe\s+3\.6s/.test(cssBare), "standby 呼吸 2.4s→3.6s");
  ok(/animation:\s*dot-breathe\s+3\.6s/.test(cssBare), "dot 呼吸 2.4s→3.6s");
  ok(/animation:\s*conn-wait-blink\s+2\.2s/.test(cssBare), "conn blink 1.1s→2.2s");
  ok(/animation:\s*wait-pulse\s+3s/.test(cssBare), "wait-pulse 2s→3s");
  ok(/animation:\s*ndot-pulse\s+3s/.test(cssBare), "ndot-pulse 2.4s→3s");

  section("\nE 退役锚（死代码零残留）：");
  ok(!kfs.has("slimPulseKf"), "slimPulseKf keyframes 已删（续用者 .tc-dot 件K2 已退役，box-shadow 死动画不留口）");
  ok(!kfs.has("demo-shimmer"), "demo-shimmer keyframes 已删（background-position 重绘帧+零 DOM 生成者）");
  ok(!/\.demo-skeleton-line/.test(cssBare), "demo-skeleton-* 死 CSS 已删（index-005/js 零引用，旧壳用自有 .skel-*）");

  section("\nF 保留清单锚（瞬时/交互类在册防误删）：");
  for (const n of ["wrefSpinKf", "ubWait", "stream-bounce", "kbd-pulse", "wx3p-skel", "st-shake-once"]) {
    ok(kfs.has(n), `${n} keyframes 保留（瞬时/交互态）`);
  }
  for (const [pat, label] of [
    [/animation:\s*wrefSpinKf\s+\.8s/, "重连 spinner .8s 保留（transform 旋转合成友好+操作期临时）"],
    [/animation:\s*ubWait\s+1\.2s/, "图片占位呼吸 1.2s 保留（加载完成即撤）"],
    [/animation:\s*stream-bounce\s+1\.1s/, "流式三点 1.1s 保留（仅流式输出期）"],
    [/animation:\s*kbd-pulse\s+1\.1s/, "按键捕获 chip 1.1s 保留（交互期）"],
    [/animation:\s*wx3p-skel\s+1\.4s/, "骨架屏 opacity 呼吸 1.4s 保留（加载期，opacity 帧已合规）"],
  ] as [RegExp, string][]) {
    ok(pat.test(cssBare), label);
  }

  section("\nG infinite 全景名单锁（新增 infinite 动画必须过本单分类）：");
  const animRefs = new Set<string>();
  const reInf = /animation:\s*([\w-]+)\s+[\d.]+s[^;]*infinite/g;
  let mm: RegExpExecArray | null;
  while ((mm = reInf.exec(cssBare)) !== null) animRefs.add(mm[1]);
  const expected = new Set(["wrefSpinKf", "conn-wait-blink", "st-glow-pulse", "st-standby-breathe", "dot-breathe", "ubWait", "stream-bounce", "wait-pulse", "kbd-pulse", "ndot-pulse", "wx3p-skel"]);
  const unexpected = [...animRefs].filter(n => !expected.has(n));
  const missing = [...expected].filter(n => !animRefs.has(n));
  ok(unexpected.length === 0, `infinite 名单无未分类新增（意外：${unexpected.join(",") || "无"}）`);
  ok(missing.length === 0, `infinite 名单完整（缺失：${missing.join(",") || "无"}；共 ${animRefs.size} 类）`);

  console.log(`\nanimfast 静态锚：${pass} ok / ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
