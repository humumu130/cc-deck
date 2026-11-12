// alivelamp（t-ccaaca8c，1111 用户实锤）：长工具执行期活性灯判据扩展契约锁。
//   实锤：worker 真在干活（多模态长工具、帧龄 3s、随后 5min 交付）但面板灯灭——
//   mcp 长工具执行中 tool_use 帧龄=工具开始时刻，超 15min 窗判闲。修=isRealWorking
//   双端加第二判据：WORKING+updated_at 心跳新鲜（≤5min，W-SEATALIVE 回合感知心跳
//   持续刷）=真干活。挂起/回合间 idle 心跳停不亮（291 语义保持）。
import { readFileSync } from "node:fs";
import { isRealWorking } from "../../expo-app/src/protocol.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
}
const MIN = 60_000;
const now = 1_000_000_000_000;

console.log("A. 长工具执行期（用户实锤形态）——tool 帧超窗但心跳在");
ok(isRealWorking({ status: "WORKING", last_tool_use_at: now - 20 * MIN, updated_at: now - 30_000 }, now) === true, "A1 tool 帧 20min 超窗+心跳 30s 新鲜 → 灯亮（长工具执行中）");
ok(isRealWorking({ status: "WORKING", last_tool_use_at: now - 20 * MIN, updated_at: now - 4 * MIN }, now) === true, "A2 心跳 4min（窗内）→ 亮");
ok(isRealWorking({ status: "WORKING", last_tool_use_at: now - 20 * MIN, updated_at: now - 6 * MIN }, now) === false, "A3 心跳 6min（超 5min 窗）→ 灭（两判据均不满足）");

console.log("B. 291 原语义保持（新判据不复活挂起/待命形态）");
ok(isRealWorking({ status: "WORKING", last_tool_use_at: 0, updated_at: now - 30_000 }, now) === false, "B1 起手窗（t=0 从未有工具活动）心跳 30s 新鲜→灭（t>0 前置：有过工具活动才认心跳——291 原语义回正，W-P2TAIL2 按审查 P2-② 收敛）");
ok(isRealWorking({ status: "WORKING", last_tool_use_at: 0, updated_at: now - 6 * MIN }, now) === false, "B2 接单未开工+心跳停（挂起/未真开跑）→ 灭（291 原语义）");
ok(isRealWorking({ status: "WORKING", last_tool_use_at: now - 20 * MIN, updated_at: 0 }, now) === false, "B3 心跳字段缺失/0 → 只认 tool 窗（老数据兼容）");
ok(isRealWorking({ status: "DONE", last_tool_use_at: now - 30_000, updated_at: now - 30_000 }, now) === false, "B4 非 WORKING 态恒灭");
ok(isRealWorking(null, now) === false, "B5 空会话");
ok(isRealWorking({ status: "WORKING" }, now) === true, "B6 老 relay 无 last_tool_use_at（降级干活不误伤）");

console.log("C. tool 窗内照旧（第一判据优先语义）");
ok(isRealWorking({ status: "WORKING", last_tool_use_at: now - 3 * MIN, updated_at: 0 }, now) === true, "C1 tool 帧 3min（窗内）无心跳 → 亮（原判据）");

console.log("D. 双端同源锚（web 逐句同源互锁）");
const sd = readFileSync(new URL("../..", import.meta.url).pathname + "web-console/js/session-domain.js", "utf8");
ok(sd.includes("HB_MS = 5 * 60 * 1000") && sd.includes("at - u <= HB_MS"), "D1 web 版第二判据在（同窗值）");
ok(sd.includes("W-ALIVELAMP"), "D2 web 版批次标记锚");

console.log(`\n========== alivelamp 套件：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
