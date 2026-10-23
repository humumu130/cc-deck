// W-CMDIMPL T6（#216，设计 §2.4）——链路演练注入器断言：全链六跳走通/drill 标记贯穿/
// 部署闸模拟灵敏度/断点台账落盘/自动触发判据。直跑：
// cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-drill.ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runDrill, gateManifestPairing, drillDue, DRILL_WATCH_FILES } from "../src/drill.js";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

const root = mkdtempSync(join(tmpdir(), "cc-deck-drilltest-"));
const dataD = join(root, "data");
const orgD = join(root, "org");
mkdirSync(dataD, { recursive: true });
mkdirSync(orgD, { recursive: true });
process.env.CCR_ORG_DIR = orgD;
process.env.CCR_DATA_DIR = dataD;

console.log("部署闸模拟（纯函数）:");
assert(gateManifestPairing("1.2.3", '{"version":"1.2.3"}').ok === true, "配对正例过");
assert(gateManifestPairing("1.2.3", '{"version":"9.9.9"}').ok === false, "错配拒");
assert(gateManifestPairing("1.2.3", "{bad") .ok === false, "坏清单拒");

console.log("全链六跳:");
const r = runDrill(dataD);
assert(r.ok === true, `全链通（断点 ${r.failed_hop ?? "无"}）`);
assert(r.hops.length === 6, `六跳齐（实得 ${r.hops.length}）`);
assert(r.hops.map((h) => h.hop).join(",") === "dispatch,worker-claim,receipt,harvest,release-gate,acceptance-close", "跳序正确");
assert(r.hops.every((h) => h.ok), "每跳断言全过");
// drill 标记贯穿：台账 drill 行可辨（统计面对账面可排除）
const drillRows = readFileSync(join(orgD, "dispatch-log.ndjson"), "utf-8").trim().split("\n")
  .map((l) => JSON.parse(l) as { drill?: boolean; id?: string }).filter((x) => x.drill === true);
assert(drillRows.length === 3, `drill 标记行贯穿台账（派单/承接/闭环三行，实得 ${drillRows.length}）`);
// 断点台账
assert(existsSync(join(dataD, "drill-log.ndjson")), "drill-log.ndjson 落盘");
const logRows = readFileSync(join(dataD, "drill-log.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { hop?: string; ok?: boolean; ms?: number });
assert(logRows.some((x) => x.hop === "summary" && x.ok === true), "summary 行在");
assert(logRows.filter((x) => x.hop !== "summary").every((x) => typeof x.ms === "number"), "每跳含耗时");
// drill-last 记账
assert(JSON.parse(readFileSync(join(dataD, "drill-last.json"), "utf-8")).ok === true, "drill-last 记账更新");

console.log("自动触发判据:");
assert(DRILL_WATCH_FILES.length >= 5, "链路文件集 ≥5");
assert(drillDue(join(root, "no-repo"), dataD) === false, "主仓不可达 → false（云端静默跳过）");
// 真仓：链路文件 commit 时间 > drill-last（刚写）→ 需造更晚 commit
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const g = (a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8" });
g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
for (const f of DRILL_WATCH_FILES) { const p = join(repo, f); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "x"); }
await new Promise((res) => setTimeout(res, 1100)); // %ct 秒级粒度——等新秒再 commit 保证 commit 时间 > drill-last
g(["add", "-A"]); g(["commit", "-qm", "chain files"]);
assert(drillDue(repo, dataD) === true, "链路文件 commit 时间 > 上次 drill → due（补跑判据）");

rmSync(root, { recursive: true, force: true });
console.log(`\n== drill: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
