// #290 源切换弹窗锚点越界——断言套件。
// 覆盖（任务书口径：任意页面点开完整可见+文字无切）：
//   U1 clampMenuLeft 纯函数直跑四态：
//      a) 标题行左侧形态（用户实锤形态：触发器 x=60、菜单 208 向左展开原 -148 出屏）
//         → 左溢出改左对齐，菜单左缘 ≥8 屏内完整可见
//      b) 右上锚形态（原设计场景：触发器 x=screenW-60）→ 右对齐保持（回归）
//      c) 双溢出（触发器近左缘+菜单超宽）→ 夹屏内
//      d) wrap 偏移换算正确（返回 wrap 相对坐标）
//   A  静态锚：measure 链（measureInWindow 双 ref）+onLayout 实宽回测+回落 right:0
// 直跑：cd relay && env -u CCR_ORG_DIR npx tsx scripts/test-spa.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// 从源文件抽 clampMenuLeft 函数体直跑（ts 源——用正则截取函数体字符串再 eval）
const src = readFileSync(join(root, "expo-app", "src", "screens", "source-switch.tsx"), "utf-8");
const m = src.match(/export function clampMenuLeft\([^)]*\): number \{[\s\S]*?\n\}/);
ok(!!m, "A0 clampMenuLeft 导出在档");
if (!m) process.exit(1);
const fnBody = m![0]
  .replace(/^export /, "")
  .replace(/clampMenuLeft\(([^)]*)\): number/, "clampMenuLeft($1)") // 去 TS 类型注解头
  .replace(/: number/g, ""); // 去体内类型标注
const clampMenuLeft = new Function(`${fnBody}; return clampMenuLeft;`)() as (tx: number, tw: number, menuW: number, screenW: number, wrapX: number) => number;

console.log("§U clampMenuLeft 纯函数：");
const SCREEN = 390; // iPhone 常见宽（实锤截图 22 机型档）
{
  // U1a 用户实锤形态：标题行内联（W-HEAD6）触发器 x≈60、wrap≈60、菜单 208
  // 校验口径=屏坐标：screenLeft = left + wrapX（原 right:0 时 screenLeft=-104 出屏）
  const left = clampMenuLeft(60, 44, 208, SCREEN, 60);
  const scr = left + 60;
  ok(scr >= 8 && scr + 208 <= SCREEN, `U1a 左侧形态屏内完整可见（screenLeft=${scr}，右缘 ${scr + 208}——原 right:0 时 -104 出屏切字）`);
  // U1b 右上锚回归（原设计场景：触发器贴屏右）
  const leftR = clampMenuLeft(SCREEN - 60, 44, 208, SCREEN, SCREEN - 60);
  const scrR = leftR + (SCREEN - 60);
  ok(Math.abs(scrR + 208 - (SCREEN - 16)) <= 1, `U1b 右上锚右对齐保持（screenLeft=${scrR}——右缘贴触发器右缘）`);
  // U1c 近全宽菜单右夹（触发器 x=0、菜单 376 近屏宽——右溢出支触发）
  const leftC = clampMenuLeft(0, 40, 376, SCREEN, 0);
  const scrC = leftC + 0;
  ok(scrC + 376 <= SCREEN && scrC >= 0, `U1c 近全宽右夹屏内（screenLeft=${scrC}，右缘 ${scrC + 376} ≤ ${SCREEN}）`);
  // U1d wrap 偏移换算（wrap 与触发器不同位——PageHead sourcePill 槽位形态）
  const leftD = clampMenuLeft(100, 40, 150, SCREEN, 80);
  const scrD = leftD + 80;
  ok(scrD >= 8 && scrD + 150 <= SCREEN, `U1d wrap 偏移屏坐标正确（screenLeft=${scrD}）`);
}

console.log("§A 静态锚：");
{
  ok(/wrapRef\.current\?\.measureInWindow/.test(src) && /trigRef\.current\?\.measureInWindow/.test(src), "A1 双 ref measureInWindow（触发器+wrap 屏坐标）");
  ok(/onLayout=\{\(e\) => setMenuW\(Math\.max\(208, e\.nativeEvent\.layout\.width\)\)\}/.test(src), "A2 菜单 onLayout 实宽回测（宽高自适应）");
  ok(/anchor \? \{ right: "auto", left: clampMenuLeft\(/.test(src), "A3 测到锚后 clamp 接管 left（right:auto 退役右锚）");
  ok(src.includes("right: 0, minWidth: 208") && src.includes("首开未测到锚时的回落"), "A4 首开未测到回落 right:0（measure 异步窗）");
  ok(/useWindowDimensions/.test(src), "A5 屏宽活读（旋转/分屏不写死）");
}

console.log(`\n§U-§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#290 源切换弹窗锚定（左对齐展开/右锚回归/双溢出夹屏）");
process.exit(fail > 0 ? 1 : 0);
