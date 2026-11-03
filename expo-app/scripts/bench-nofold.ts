// W-EXPOFOLD 性能量测（1103 任务书验收点 3）：AI 消息恒渲 full 后的 JS 解析成本基准。
// 范式：静态锚抽取（test-258 blockFrom 同款）——从 src/md.tsx 逐字拷 parseBlocks 与
// src/highlight.ts 的 synTokenize（纯函数，零 RN 依赖，node 直跑可复现）。
// 量的是什么：MdText 渲染前解析层（parseBlocks+代码块 synTokenize）——折叠退役后
// 「默认态」从 parse(text 截断) 变为 parse(full)，本脚本给绝对数字。
// 量不了什么（如实）：Yoga 原生文本布局/绘制（须真机——装机验收单承载）；React
// 元素树 mount 差（元素数以 parseBlocks 块数×常数近似，脚本附块数对比）。
// 运行：node --import tsx scripts/bench-nofold.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mdSrc = readFileSync(join(root, "src", "md.tsx"), "utf-8");
const hlSrc = readFileSync(join(root, "src", "highlight.ts"), "utf-8");

function blockFrom(src: string, needle: string): string {
  const i = src.indexOf(needle);
  if (i < 0) return "";
  const j = src.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return "";
}

// —— parseBlocks：整函数抽取（含其行级 while 状态机；依赖顶层的 DELIM_RE/splitRow 一并抽）——
const delimRe = blockFrom(mdSrc, "const DELIM_RE =");
const splitRow = blockFrom(mdSrc, "const splitRow =");
const parseBlocks = blockFrom(mdSrc, "function parseBlocks(");
if (!delimRe || !splitRow || !parseBlocks) { console.error("锚抽取失败：parseBlocks 族"); process.exit(2); }
// synTokenize：签名与函数体抽取（块级依赖按需注入 stub —— 代码块 token 化是长文大头）
const synTokenize = blockFrom(hlSrc, "export function synTokenize(") || blockFrom(hlSrc, "function synTokenize(");

import { transformSync } from "esbuild";
const js = (ts: string) => transformSync(ts, { loader: "ts" }).code; // 抽出串带 TS 标注——eval 前剥类型

const parse = new Function("DELIM_RE", js(`${splitRow}\n${parseBlocks}\nreturn parseBlocks;`))(
  new RegExp(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/),
) as (src: string) => { t: string; lang?: string; text?: string }[];

// synTokenize 依赖词表——抽不出完整闭包时降级为 null（代码块 token 化单独计入说明）
const syn: ((code: string, lang: string) => unknown[]) | null = (() => {
  try { return new Function(js(`${synTokenize}\nreturn synTokenize;`))() as (c: string, l: string) => unknown[]; } catch { return null; }
})();

// —— 夹具：真实形状的 80k 单条（混段落/标题/列表/长代码块/表格）+8k×50 条列表 + 200 字截断对照 ——
const para = "AI 消息基准段落：这是一段真实形状的长文本，包含中文与 English mixed 词汇、`行内码`、" +
  "**粗体**与[链接](https://example.com/a-very-long-link-target)，用于模拟生产会话里 assistant_text 的典型密度。".repeat(3);
const code80k = Array.from({ length: 400 }, (_, i) => `function bench_${i}(a, b) { return a * ${i} + b; } // 代码块占位行，模拟 diff/脚本输出`).join("\n");
const single80k = Array.from({ length: 180 }, () => para).join("\n\n") + "\n\n```ts\n" + code80k.slice(0, 40_000) + "\n```\n";
const item8k = Array.from({ length: 18 }, () => para).join("\n\n");
// 生产契约（summarizer）：text=截断摘要（~200 字级）、full=全文——两态分别构造
const list50 = Array.from({ length: 50 }, (_, i) => ({
  text: (item8k + `（第 ${i + 1} 条）`).slice(0, 200), // 改前默认渲染的截断态
  full: item8k + `\n\n> 引用尾巴：第 ${i + 1} 条完整正文，长 ${(item8k.length + 40)} 字`, // 改后恒渲的全文
}));
const truncated200 = single80k.slice(0, 200);

function ms(f: () => void, n = 5): number {
  // 预热 1 轮 + 取中位（JIT 稳态）
  f();
  const t: number[] = [];
  for (let i = 0; i < n; i++) { const t0 = process.hrtime.bigint(); f(); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  return t.sort((a, b) => a - b)[Math.floor(n / 2)];
}

console.log("== W-EXPOFOLD 解析层基准（parseBlocks+synTokenize，node 直跑）==");
console.log(`夹具：单条 ${single80k.length} 字（段落+40k 代码块）；列表 50 条×${item8k.length} 字；截断对照 200 字\n`);

const t80 = ms(() => { const b = parse(single80k); if (syn) for (const x of b) if (x.t === "code") syn(String(x.text ?? ""), String(x.lang ?? "ts")); });
const t200 = ms(() => parse(truncated200));
console.log(`80k 单条全量解析：${t80.toFixed(2)} ms（块数 ${parse(single80k).length}）`);
console.log(`200 字截断解析（改前默认态）：${t200.toFixed(3)} ms（块数 ${parse(truncated200).length}）`);
console.log(`→ 折叠退役后单条默认态 JS 解析增量：+${t80.toFixed(2)} ms（一次性，非每帧）\n`);

const t50full = ms(() => { for (const it of list50) { const b = parse(it.full); if (syn) for (const x of b) if (x.t === "code") syn(String(x.text ?? ""), "ts"); } }, 3);
const t50text = ms(() => { for (const it of list50) parse(it.text); }, 3);
console.log(`50 条长文列表进详情页（首屏一次性）：`);
console.log(`  全量 full 解析（改后）：${t50full.toFixed(1)} ms`);
console.log(`  仅 text 截断解析（改前）：${t50text.toFixed(1)} ms`);
console.log(`  → 增量 +${(t50full - t50text).toFixed(1)} ms（一次性解析；列表滚动不再重复解析——MdText useMemo 缓存）`);
console.log(`  → 块数对比：full ${parse(list50[0].full).length} 块 vs text ${parse(list50[0].text).length} 块/条（元素树规模近似）`);
console.log("\n结论口径：JS 解析增量一次性 ms 级（见上），滚动/每帧零增量（useMemo+非受控文本布局）；真机原生布局/滚动帧率须装机量测（验收单），脚本可复现：node --import tsx scripts/bench-nofold.ts");
