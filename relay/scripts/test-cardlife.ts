// W-CARDLIFE 套件（原 28 断言）——R4 薄壳化：r2 起 harvest --merge/--reject 退役为
// 降级路径（relay pr-report MERGED 事件内建状态机自动翻当轮+同链前代卡），旧 28 断言
// 全锚已退役的脚本路径（CI 29 键并集后必红）——权威断言在 test:cardlifer2（26 断言
// 真链：状态机翻卡/资格位/400 窗/converge/幂等）。本壳保三层仍在面：降级声明在位/
// relay 状态机在位/键与权威件注册在位。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
let pass = 0, fail = 0;
const assert = (cond: boolean, name: string) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };
const root = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");
const harvest = readFileSync(join(root, "cc-plugins/plugins/cc-deck/bin/leader-harvest"), "utf-8");
const sm = readFileSync(join(root, "relay/src/session-manager.ts"), "utf-8");
assert(harvest.includes("--merge 同链翻/--reject/退出码守卫=**降级路径**"), "C1 harvest 降级声明在位（r2 语义——自动翻主体移交 relay 状态机）");
assert(harvest.includes("cardlife-pr-merged"), "C2 降级路径指向 relay 状态机（cardlife-pr-merged/chain-close）");
assert(sm.includes("cardlife-pr-merged") && sm.includes("chain-close"), "C3 relay 状态机在位（MERGED 事件自动翻当轮+同链前代）");
assert(readFileSync(join(root, "relay/scripts/test-cardlifer2.ts"), "utf-8").length > 1000, "C4 权威件 test-cardlifer2 在（26 断言真链——CI test:cardlifer2 键）");
assert(readFileSync(join(root, "relay/package.json"), "utf-8").includes('"test:cardlife"'), "C5 test:cardlife 键注册在（29 键并集——覆盖不丢，断言随 r2 语义演进）");
console.log(`\n========== cardlife 套件（R4 薄壳）：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
