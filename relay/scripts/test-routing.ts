// #26 矩阵式 M3 —— routing.ts 单元测试：记账/排序（bad 沉底+熟练降序）/评鉴/标签/
// 坏 JSON 容忍/随手办豁免（无 gid 不入账）
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRoutingResult, routingFor, listRouting, rateRouting, tagRouting,
} from "../src/routing.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), "cc-deck-routing-"));

// ---------- 空态与坏 JSON ----------
console.log("空态:");
assert(routingFor("g1", dir).length === 0, "无文件 → 空");
assert(listRouting(dir).length === 0, "全量清单 → 空");
writeFileSync(join(dir, "routing.json"), "{not json", "utf-8");
assert(routingFor("g1", dir).length === 0, "坏 JSON → 空（读侧防御）");

// ---------- 收口记账 ----------
console.log("记账:");
const e1 = recordRoutingResult("g1", "sess-A", "done", "第一批活干完", dir);
assert(!!e1 && e1.count === 1 && e1.failed === 0 && e1.last_ts > 0, "done → count=1 last_ts 落");
assert(routingFor("g1", dir).length === 1, "落盘可回读（routingFor 现场重 load）");
recordRoutingResult("g1", "sess-A", "done", "第二批", dir);
const e1b = recordRoutingResult("g1", "sess-A", "failed", "第三批干砸了：编译不过", dir);
assert(!!e1b && e1b.count === 2 && e1b.failed === 1, "再 done×1 failed×1 → count=2 failed=1");
assert(e1b?.last_receipt === "第三批干砸了：编译不过", "last_receipt 更新");
const long = "回".repeat(120);
const e1c = recordRoutingResult("g1", "sess-A", "done", long, dir);
assert(e1c?.last_receipt?.length === 80, "回执截 80 字");
assert(recordRoutingResult("", "sess-A", "done", "x", dir) === null, "无 gid（随手办）不入账 → null");
assert(recordRoutingResult("g1", "", "done", "x", dir) === null, "无 sid 不入账 → null");
assert(routingFor("g1", dir).length === 1 && listRouting(dir).length === 1, "豁免两笔未产生新条目");

// ---------- 排序：bad 沉底 / 熟练降序 ----------
console.log("排序:");
recordRoutingResult("g1", "sess-B", "done", "B 一次", dir);
recordRoutingResult("g1", "sess-C", "done", "C 一次", dir);
recordRoutingResult("g1", "sess-C", "done", "C 两次", dir);
rateRouting("g1", "sess-C", "bad", dir); // C 最熟但评 bad
const order = routingFor("g1", dir).map((x) => x.session_id);
assert(order[0] === "sess-A", "最熟（count=3）A 居首");
assert(order[1] === "sess-B", "次熟 B 居中");
assert(order[2] === "sess-C", "bad 评价沉底（不删记录，调度侧避开）");
assert(order.length === 3, "三熟手齐");
// gid 隔离
recordRoutingResult("g2", "sess-A", "done", "另一项目", dir);
assert(routingFor("g2", dir).length === 1 && routingFor("g2", dir)[0].count === 1, "同 worker 跨项目独立记账");
assert(routingFor("g1", dir).length === 3, "g1 不受 g2 影响");

// ---------- 评鉴/标签 ----------
console.log("评鉴/标签:");
const rr = rateRouting("g1", "sess-A", "good", dir);
assert(rr.ok && rr.entry.rating === "good", "rate good 落盘");
const rBad = rateRouting("g1", "sess-B", "bad", dir);
assert(rBad.ok && routingFor("g1", dir).find((x) => x.session_id === "sess-B")?.rating === "bad", "rate bad 回读一致");
const rMiss = rateRouting("g1", "sess-NONE", "good", dir);
assert(!rMiss.ok, "无合作记录不可评（评价跟着记录走）");
const tg = tagRouting("g1", "sess-A", ["rust", " rust ", "", "cli", "rust"], dir);
assert(tg.ok && tg.entry.tags.join(",") === "rust,cli", "tag 去空去重整组替换");
// 审查修正（#26 补章三家同报）：写侧小写归一——skills 查询侧已 lowercase，写侧
// 不归一时自然书写标签（Rust/TypeScript）永不被命中，技能臂静默失效
const tgCase = tagRouting("g1", "sess-A", ["  Rust ", "TypeScript"], dir);
assert(tgCase.ok && tgCase.entry.tags.join(",") === "rust,typescript", "tag 小写归一（与 skills 查询侧对偶）");
const tMiss = tagRouting("g1", "sess-NONE", ["x"], dir);
assert(!tMiss.ok, "无记录不可打标");
const many = tagRouting("g1", "sess-A", "a b c d e f g h i j".split(" "), dir);
assert(many.ok && many.entry.tags.length === 8, "标签上限 8");

// ---------- 持久化形状 ----------
console.log("持久化:");
const raw = JSON.parse(readFileSync(join(dir, "routing.json"), "utf-8"));
assert(Array.isArray(raw.entries) && raw.entries.length === 4, "写穿全量：g1×3 + g2×1");
assert(raw.entries.every((x: { tags?: unknown }) => Array.isArray(x.tags)), "条目 tags 恒为数组");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
