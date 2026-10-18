// W-PUSHPERF 静态锚（#进详情卡顿根修）：渐进上屏+返回保挂载
// 直跑：cd expo-app && node --import tsx scripts/test-pushperf.ts
// @ts-expect-error node:fs 未进 expo tsconfig types 字段
import { readFileSync } from "node:fs";
// @ts-expect-error 同上
import { fileURLToPath } from "node:url";
// @ts-expect-error 同上
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const here = dirname(fileURLToPath(import.meta.url));
const ds = readFileSync(join(here, "../src/screens/DetailScreen.tsx"), "utf8");
const app = readFileSync(join(here, "../App.tsx"), "utf8");

console.log("== W-PUSHPERF：渐进上屏+返回保挂载 ==");
ok(ds.includes("InteractionManager.runAfterInteractions(() => setRevealed(true))"), "P1 渐进上屏：交互空闲后放开全量");
ok(ds.includes("REVEAL_N = 40"), "P2 首帧尾部 40 条闸");
ok(ds.includes("revealed || shownMsg.length <= REVEAL_N ? shownMsg : shownMsg.slice(-REVEAL_N)"), "P3 渐进闸消费（短列表直出）");
ok(ds.includes("h.cancel()"), "P4 句柄清理（sid 切换防晚到放开）");
ok(app.includes("W-PUSHPERF ②：返回不卸载详情"), "P5 返回保挂载（重开同 sid 零重建）");
ok(app.includes("closing 兜底也不卸载"), "P6 兜底定时器同口径");
ok(app.includes("navX.setValue(w)"), "P7 重开重置滑入起点（保挂载态复活）");
console.log(`\npushperf: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
