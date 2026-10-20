// W-DETAIL2 静态锚（三件精修）
// @ts-expect-error node:fs 未进 expo tsconfig
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
// W-SPLIT-S1B 锚跟改：样式键随工厂外迁——ds 锚失效的样式断言改读 detail-styles.ts
const dsty = readFileSync(join(here, "../src/components/detail-styles.ts"), "utf8");
console.log("== W-DETAIL2：状态栏吸附+tab 去双线降高+图标化裁决 ==");
ok(ds.includes("W-DETAIL2 件一：WORKING 主状态行固定吸附"), "D1 件一：WORKING 主状态行迁底部栈（固定吸附）");
ok(ds.includes("W-DETAIL2 件一：WORKING 主状态行（你在做什么…+计时）迁输入栏上方"), "D2 件一：对话流内主块退役注释");
ok(ds.includes("dockWork"), "D3 dockWork 样式在场");
ok(ds.includes("(s?.subagents?.length ?? 0) > 0 ? (\n          <View style={d.liveRow}>"), "D4 liveRow 仅剩子 Agent 块");
ok(dsty.includes("fixedBar: { paddingHorizontal: 14, paddingTop: 4 }"), "D5 件二：fixedBar 底边框退役");
ok(dsty.includes("paddingVertical: 2, borderBottomWidth: 2"), "D6 件二：tabBtn 降高（指示线保留）");
ok(dsty.includes("marginBottom: 6 }"), "D7 件二：filterRow 收紧"); // S1B 锚跟改（样式键外迁）
ok(dsty.includes("W-DETAIL2 件三裁决=A 纯汉字收紧"), "D8 件三：裁决 A 落地"); // S1B 锚跟改
ok(ds.includes("REVEAL_N = 40") && ds.includes("revealed"), "D9 PUSHPERF 渐进上屏未回退");
console.log(`\ndetail2: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
