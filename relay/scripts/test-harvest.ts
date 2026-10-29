// W-CMDIMPL ①（#216，设计 §1）——harvest-check 收割机器闸断言：
// 六 gate（回执/必需节/尾行/新提交/dirty/验收单 warning）+ 两本账寻址 + 账外单指路 +
// stages 断点续办扫描 + squash_plan 打印不执行（永不写红线）。直跑：
// cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-harvest.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestCheck } from "../src/harvest.js";
import { appendDispatch } from "../src/org.js";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

const root = mkdtempSync(join(tmpdir(), "cc-deck-harvest-"));
const orgD = join(root, "org");
const dataD = join(root, "data");
mkdirSync(orgD, { recursive: true });
mkdirSync(dataD, { recursive: true });
process.env.CCR_ORG_DIR = orgD;
process.env.CCR_DATA_DIR = dataD;
mkdirSync(join(root, "artifacts"), { recursive: true });
process.env.CCR_ARTIFACTS_DIR = join(root, "artifacts"); // 隔离家目录真验收单（闸⑥可测）

const gitRun = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });

// 环境准备：假 worktree 仓（base 提交+新提交）+ 台账行 + 回执文件
const wt = join(root, "wt-demo");
mkdirSync(wt, { recursive: true });
gitRun(wt, ["init", "-q"]);
gitRun(wt, ["config", "user.email", "t@t"]); gitRun(wt, ["config", "user.name", "t"]);
writeFileSync(join(wt, "a.txt"), "1");
gitRun(wt, ["add", "-A"]); gitRun(wt, ["commit", "-qm", "base"]);
const baseSha = gitRun(wt, ["rev-parse", "HEAD"]).trim();
writeFileSync(join(wt, "b.txt"), "2");
gitRun(wt, ["add", "-A"]); gitRun(wt, ["commit", "-qm", "[正经立项] worker 提交一"]);

const receiptOk = join(root, "receipt-ok.md");
writeFileSync(receiptOk, "## 根因\nx\n## 自测\ny\n## 验收点\nz\n\n结果：做完｜改动文件：a.md\n", "utf-8");

const did = "dp-harvest-1";
appendDispatch({ ts: Date.now(), id: did, tier: "正经立项", target: "w1", status: "running", session_id: "sess-1", title: "演示单" }, orgD);
// 派单账（worktree/branch/base/receipt 字段全）
writeFileSync(join(dataD, "leader-dispatches.ndjson"), JSON.stringify({ id: did, title: "演示单", session_id: "sess-1", receipt: receiptOk, worktree: wt, branch: "fix/demo", base_sha: baseSha }) + "\n", "utf-8");

console.log("寻址与请求面:");
const miss = harvestCheck({});
assert(!miss.ok && !!miss.error?.includes("dispatch_id 必填"), "dispatch_id 缺失拒");
const outofbook = harvestCheck({ dispatch_id: "dp-none" });
assert(!outofbook.ok && !!outofbook.error?.includes("两本账"), "账外单无指路拒");

console.log("六 gate（全绿单）:");
const r = harvestCheck({ dispatch_id: did });
assert(r.ok === true, "ok:true");
assert(r.fails === 0, `机器闸零 fail（实得 ${r.fails}）`);
assert(r.checks.find((c) => c.gate === "receipt")?.pass === true, "闸①回执存在");
assert(r.checks.find((c) => c.gate === "sections")?.pass === true, "闸②必需节全在");
assert(r.checks.find((c) => c.gate === "tail")?.pass === true, "闸③尾行摘要在");
assert(r.checks.find((c) => c.gate === "commits")?.pass === true && (r.checks.find((c) => c.gate === "commits")?.log?.length ?? 0) === 1, "闸④新提交 1 笔");
assert(r.checks.find((c) => c.gate === "dirty")?.pass === true, "闸⑤无未提交");
const acc = r.checks.find((c) => c.gate === "acceptance");
assert(acc?.severity === "warning" && acc.pass === false, "闸⑥验收单 warning 不计 fail");
assert(r.fails === 0, "warning 不进 fails");
assert(r.title === "演示单" && r.session_id === "sess-1" && r.ledger_status === "running", "标题/会话/台账终态回带");
assert(r.relay_source !== undefined, "relay_source 恒带（§1.4 UI 置灰依据）");
assert(r.squash_plan.some((s) => s.includes("merge --squash")) && r.squash_plan.some((s) => s.includes("worktree remove")), "squash_plan 三步建议（打印不执行）");
// 红线：跑完 harvest 后台账/分支账零写入
const logAfter = readFileSync(join(orgD, "dispatch-log.ndjson"), "utf-8").trim().split("\n").length;
assert(logAfter === 1, "永不写红线：台账行数不变");

console.log("拒写面（部分 ✗）:");
const receiptBad = join(root, "receipt-bad.md");
writeFileSync(receiptBad, "结果：缺根因与验收点｜改动文件：无\n", "utf-8");
appendFileSync(join(dataD, "leader-dispatches.ndjson"), JSON.stringify({ id: "dp-bad", title: "坏单", receipt: receiptBad, worktree: wt, branch: "fix/bad", base_sha: baseSha }) + "\n", "utf-8"); // append——覆盖写会丢 did 行（末行赢寻址按 id 各自独立）
const rb = harvestCheck({ dispatch_id: "dp-bad" });
assert(rb.ok === true && rb.fails === 1, `坏回执 fails=1（仅 sections 缺；尾行在不计）实得 ${rb.fails}`);
assert(rb.checks.find((c) => c.gate === "sections")?.pass === false, "必需节缺检出（「结果：缺根因」尾行不误命中节头）");
// dirty 面
writeFileSync(join(wt, "dirty.txt"), "unstaged");
const rd = harvestCheck({ dispatch_id: did, receipt: receiptOk });
assert(rd.checks.find((c) => c.gate === "dirty")?.pass === false, "未提交改动检出");
rd.fails; void rd;
// worktree 缺席降级（§1.4 不炸 500）
const rw = harvestCheck({ dispatch_id: did, receipt: receiptOk, worktree: join(root, "no-such-wt"), branch: "fix/x" });
assert(rw.ok === true, "worktree 缺席 → 结构化降级不炸");
assert(rw.checks.find((c) => c.gate === "commits")?.pass === false && !!rw.checks.find((c) => c.gate === "commits")?.detail.includes("不存在"), "commits 闸降级占位");
// 基线不可解析退化
const ru = harvestCheck({ dispatch_id: did, receipt: receiptOk, worktree: wt, branch: "fix/demo", base: "deadbeef" });
assert(!!ru.checks.find((c) => c.gate === "commits")?.detail.includes("退最近 10 条"), "基线不可解析退最近 10 条（leader-harvest 语义）");

console.log("stages 断点续办（§1.5）:");
appendDispatch({ ts: Date.now(), id: did, tier: "正经立项", target: "w1", status: "running", session_id: "sess-1", title: "演示单", stage: "merged", stage_detail: "squash 进 dev" }, orgD);
appendDispatch({ ts: Date.now(), id: did, tier: "正经立项", target: "w1", status: "running", session_id: "sess-1", title: "演示单", stage: "custom.review-passed" }, orgD);
const rs = harvestCheck({ dispatch_id: did, receipt: receiptOk });
assert(rs.stages.length === 2, "stage 历史两行扫出");
assert(rs.stages[0].stage === "merged" && rs.stages[0].detail === "squash 进 dev", "stage+detail 带出");
assert(rs.ledger_status === "running", "stage 事件不改终态语义");
// 词表外 stage 被 reducer 拒（写严格联动）
const rejected = !appendDispatch({ ts: Date.now(), id: did, tier: "正经立项", target: "w1", status: "running", session_id: "sess-1", stage: "made-up" }, orgD);
assert(rejected === true, "词表外 stage 拒写（拍板 #9 reducer 联动）");

rmSync(root, { recursive: true, force: true });
console.log(`\n== harvest: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
