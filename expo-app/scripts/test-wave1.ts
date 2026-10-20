// W-WAVE1 三件锁锚（体验批波次 1）：#93 引擎徽（主线已有，锚防回退）#97 PM 归属徽
// #95 成员卡动态排序。直跑：node --import <tsx>/dist/loader.mjs scripts/test-wave1.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ls = readFileSync(join(here, "../src/screens/ListScreen.tsx"), "utf8");
const td = readFileSync(join(here, "../src/screens/TeamDetailPage.tsx"), "utf8");

let pass = 0, fail = 0;
const ok = (c: boolean, n: string) => { if (c) { pass++; console.log("  ok " + n); } else { fail++; console.log("  FAIL " + n); } };

console.log("== W-WAVE1：引擎标签+PM 归属+成员排序 ==");
// 件①#93：会话卡引擎徽（W-MV8A 已落——防回退锚）
ok(ls.includes("<EngineBadge engine={s.engine} size=\"sm\" />"), "W1① 会话卡 r3 引擎小徽（#93，主线 W-MV8A 落地锚防回退）");
ok(ls.includes("engineBadgeable(s.engine)"), "W1①' 词表外引擎不渲染（engineBadgeable 门控）");
// 件②#97：PM 归属徽
ok(ls.includes("pmSessionIds"), "W1② PM 反查表在场（headcount role 词表）");
ok(ls.includes("`PM · ${base}`"), "W1②' orgTag 融合 PM 前缀（单口继承双密度档形态）");
ok(/\/\^\(pm\|leader\|产品经理\|项目经理\|领队\)\$\/i/.test(ls), "W1②'' 角色词表与桌面 SLIM_KEEP_ROLE 同源五值");
// 件③#95：成员动态排序
ok(td.includes("const inOffice = (st?: string) => st === \"WORKING\" || st === \"WAITING\""), "W1③ 在岗判定（WORKING/WAITING 置顶——WAITING 需人确认更该置顶）");
ok(td.includes("return bu - au; // 同档：最近活跃倒序（静止自然沉底——updated 旧）"), "W1③' 同档最近活跃倒序（静止沉底）");
ok(td.includes("return a.i - b.i; // 编制序稳定器"), "W1③'' 编制序末位稳定器（同态同时不乱跳）");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
