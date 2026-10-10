// M11-D2 派单与经验导入测试：dispatch-log.ndjson + boards lessons → dispatch/lesson 双表。
// 范式沿用 C1/C2/D1（mkdtemp+env 钉死+assert 计数+utimesSync 防 mtime 巧合+foreign_key_check）。
// 造态双轨：常态行走真写路径（org.ts appendDispatch / projects.ts addLesson，均带 dir 注入零
// 生产触达）；重投轨迹与脏行手搓（写侧无重投重投行生产面、坏行本就不可经真写路径产生——
// 手搓 ndjson 行与板文件 JSON，C2 手搓范式）。
// 归因锚桩（project/group/member/session 四行）：域归 C1（组）与 D1（会话），本单 fixture 直插
// 最小行作 anchor/会话/成员映射锚——导入器对这些域只读不写。
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, statSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importDispatchLesson } from "../src/storage/import-dispatch-lesson.js";
import { listLoss } from "../src/storage/loss-report.js";
import { appendDispatch, dispatchLogPath } from "../src/org.js";
import { addLesson, createGroup, setLightConfirmTrusted } from "../src/projects.js";
import type { ProjectGroup } from "../src/projects.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- 0. 纪律 ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-d2-db-"));
process.env.CCR_STORAGE_READ_MODE = "json"; // 显式钉档（SQLITE-FLIP 后缺省=sqlite，fixture 是 json 形态——缺省读空库；75-R 回归发现的漏网连带面）
process.env.CCR_DATA_DIR = dataDir;
const fx = mkdtempSync(join(tmpdir(), "cc-deck-d2-org-"));
console.log("临时目录纪律:");
assert(dataDir.startsWith(tmpdir()) && fx.startsWith(tmpdir()), "dataDir/fixture orgDir 全落 tmpdir 前缀");
assert(!fx.startsWith(process.env.HOME ?? "~"), "fixture orgDir 不在生产 HOME 下");

const port: StoragePort = createSqlitePort({ dataDir, filename: "d2.sqlite3" });
port.open();
runMigrations(port, migrations);

// ---------- 1. 归因锚桩 ----------
// 组走真写路径（addLesson 板可写校验在 projects.ts 组域——桩组不在 projects.json 会被拒，
// C2 同款 createGroup 信任态直通 active）；组行同步桩进 SQLite 作 anchor 映射锚。
// project/member/session 域归 C1/D1，直插最小行作会话/成员映射锚。
function groupOf(r: { ok: boolean; group?: ProjectGroup }): ProjectGroup {
  if (!r.ok || !r.group) throw new Error("fixture 造态失败");
  return r.group;
}
setLightConfirmTrusted(true, fx);
const GID = groupOf(createGroup({ name: "g1", anchor_dir: "/px/g1", tier: "轻立项" }, fx)).id;
port.exec(`INSERT INTO project (id, name, dir_fingerprint, anchor_dir, is_default, is_hidden, ts)
  VALUES ('P1', 'proj', 'fp-p1', '/px/p1', 0, 0, 1)`);
port.exec(`INSERT INTO "group" (id, project_id, name, anchor_dir, status, tier, single_card, created_at, updated_at)
  VALUES (?, 'P1', 'g1', '/px/g1', 'active', '轻立项', 1, 1, 1)`, [GID]);
port.exec(`INSERT INTO member (id, stable_identity, display_name, business_role, command_role, task_participation, joined_at, status, ts)
  VALUES ('M1', 'ident-m1', '成员一', 'dev', 'dev', 'dev', 1, 'active', 1)`);
port.exec(`INSERT INTO session (id, group_id, member_id, cwd, status, started_at, updated_at)
  VALUES ('s-relay-1', ?, 'M1', '/px/g1', 'WORKING', 1, 1)`, [GID]);

const logFile = dispatchLogPath(fx);
const boardsDir = join(fx, "boards");

// ---------- 2. dispatch-log 造态 ----------
console.log("dispatch-log 造态:");
// d-ok 常态三行链：dispatched→running→done（真写路径 appendDispatch，同 id 状态机轨迹）
appendDispatch({ ts: 1000, id: "d-ok", tier: "轻立项", target: "s-relay-1", status: "dispatched", session_id: "s-relay-1", actor: "leader" }, fx);
appendDispatch({ ts: 2000, id: "d-ok", tier: "轻立项", target: "s-relay-1", status: "running", session_id: "s-relay-1", project_anchor: "/px/g1", actor: "leader" }, fx);
appendDispatch({ ts: 3000, id: "d-ok", tier: "轻立项", target: "s-relay-1", status: "done", receipt: "完成回执", session_id: "s-relay-1", project_anchor: "/px/g1", actor: "leader" }, fx);
// d-retry 重投四行链：done 前置 failed 终态后再投（同 id 重投轨迹，写侧无此生产面、手搓轨迹）
appendDispatch({ ts: 1100, id: "d-retry", tier: "随手办", target: "org-leader", status: "dispatched", session_id: "", actor: "leader" }, fx);
appendDispatch({ ts: 1200, id: "d-retry", tier: "随手办", target: "org-leader", status: "failed", receipt: "首次失败", session_id: "", actor: "leader" }, fx);
appendDispatch({ ts: 1300, id: "d-retry", tier: "随手办", target: "org-leader", status: "dispatched", session_id: "", actor: "leader" }, fx);
appendDispatch({ ts: 1400, id: "d-retry", tier: "随手办", target: "org-leader", status: "failed", receipt: "再败", session_id: "", actor: "leader" }, fx);
// 归因边角（单行单）——排位在复现块之前：r3 续跑窗口（offset 快进线后）不得含终态行
// （行序状态机语义：重遇终态行=再现行=重投推进），watchdog（done）故殿后至行16
appendDispatch({ ts: 4100, id: "d-anchor-ghost", tier: "正经立项", target: "org-leader", status: "dispatched", session_id: "s-relay-1", project_anchor: "/px/ghost", actor: "leader" }, fx);
appendDispatch({ ts: 4200, id: "d-sess-ghost", tier: "咨询", target: "org-leader", status: "running", session_id: "s-ghost", actor: "user" }, fx);
appendDispatch({ ts: 4400, id: "d-noactor", tier: "随手办", target: "org-leader", status: "running", session_id: "" }, fx); // 旧数据无 actor
appendDispatch({ ts: 4500, id: "d-badactor", tier: "随手办", target: "org-leader", status: "running", session_id: "", actor: 123 as unknown as string }, fx); // actor 类型坏
// 派生段 id 撞名复现（REVIEW3 P2-1 / FIX-B ①）：行12 独立 root id 恰带 "#r2" 尾开段；
// 行13/14 root x 常态收敛 done；行15 x 终态后再现行=重投 → 派生 "x#r2" 撞行12 → duplicate-id 账拒行
appendDispatch({ ts: 5, id: "x#r2", tier: "咨询", target: "x", status: "dispatched", session_id: "" }, fx);
appendDispatch({ ts: 6, id: "x", tier: "咨询", target: "x", status: "dispatched", session_id: "" }, fx);
appendDispatch({ ts: 7, id: "x", tier: "咨询", target: "x", status: "done", session_id: "" }, fx);
appendDispatch({ ts: 8, id: "x", tier: "咨询", target: "x", status: "dispatched", session_id: "" }, fx);
appendDispatch({ ts: 4300, id: "d-watchdog", tier: "看门狗", target: "org-leader", status: "done", receipt: "自愈动作", session_id: "", actor: "leader" }, fx);
// 脏行手搓（真写路径不可产）：bad-json / 缺 id / status 词表外
appendFileSync(logFile, "这不是json\n", "utf8");
appendFileSync(logFile, JSON.stringify({ ts: 1, tier: "咨询", target: "x", status: "running", session_id: "" }) + "\n", "utf8"); // 缺 id
appendFileSync(logFile, JSON.stringify({ ts: 2, id: "d-flying", tier: "咨询", target: "x", status: "flying", session_id: "" }) + "\n", "utf8"); // status 越词表
assert(existsSync(logFile) && readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim() !== "").length === 19, "dispatch-log fixture：19 行落盘（12 真+3 脏+4 复现）");

// ---------- 3. boards lessons 造态 ----------
console.log("boards lessons 造态:");
addLesson(GID, { text: "经验一", tags: ["rust", "rust", ""], source_dispatch_id: "d-ok" }, fx); // tags 洗刷+sdi 合法
addLesson(GID, { text: "经验二", tags: ["deploy"] }, fx); // 无 sdi
addLesson(GID, { text: "经验三", tags: [], source_dispatch_id: "d-ghost" }, fx); // sdi 悬空
// G1 板手搓脏 lessons（读板→push→写回；addLesson 真写路径拒收的形态）
const g1BoardFile = join(boardsDir, `${GID}.json`);
const g1Board = JSON.parse(readFileSync(g1BoardFile, "utf8")) as { lessons: unknown[] };
g1Board.lessons.push({ text: "   ", tags: [], ts: 500 }); // 空 text→missing-field
g1Board.lessons.push({ id: "ls-dup", text: "重复甲", tags: [], ts: 501 });
g1Board.lessons.push({ id: "ls-dup", text: "重复乙", tags: [], ts: 502 }); // 同 id 二遇→duplicate-id
g1Board.lessons.push({ id: "ls-badtags", text: "tags 坏型", tags: "nope", ts: 503 }); // tags 非数组→bad-field+落 []
writeFileSync(g1BoardFile, JSON.stringify(g1Board, null, 2) + "\n", "utf8");
// 悬空组板：合法 lesson 但 gid 在 group 表无行（照导 NULL+账）
writeFileSync(join(boardsDir, "g-ghost.json"), JSON.stringify({
  entries: [], lessons: [{ id: "ls-ghost", text: "幽灵组经验", tags: ["x"], ts: 600 }],
}) + "\n", "utf8");
// 坏板 JSON + lessons 非数组板
writeFileSync(join(boardsDir, "bad.json"), "{oops\n", "utf8");
writeFileSync(join(boardsDir, "noarr.json"), JSON.stringify({ entries: [], lessons: "nope" }) + "\n", "utf8");
assert(readFileSync(g1BoardFile, "utf8").includes("经验一") && existsSync(join(boardsDir, "g-ghost.json")), "boards fixture：真写 3 lesson+手搓 4 脏+悬空组板+坏板×2");

// ---------- 4. 首轮导入+逐面断言 ----------
console.log("首轮导入:");
const r1 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: boardsDir });
assert(r1.skipped === false && r1.rescanned.length === 2, "首轮两源全重扫");

const dRows = port.query<{ id: string; group_id: string | null; tier: string; target_member_id: string | null;
  source_session_id: string | null; actor: string; status: string; receipt: string | null;
  attempt_no: number; parent_dispatch_id: string | null; created_at: number; updated_at: number }>(
  "SELECT * FROM dispatch ORDER BY id, attempt_no");
assert(dRows.length === 10, `dispatch 行数=10（9 id，d-retry 拆 2 段）——实测 ${dRows.length}`);
const row = (id: string, attempt = 1) => dRows.find((r) => r.id === id && r.attempt_no === attempt)!;

// S1 常态链收敛：一行状态机（终态行收敛、首末 ts、receipt 末个非空、归因全列）
const ok1 = row("d-ok");
assert(ok1.status === "done" && ok1.attempt_no === 1 && ok1.parent_dispatch_id === null
  && ok1.created_at === 1000 && ok1.updated_at === 3000 && ok1.receipt === "完成回执",
  "S1 常态链收敛：同 id 三行→1 行终态 done、created_at=首行 ts、updated_at=末行 ts、receipt=终态回执");
assert(ok1.group_id === GID && ok1.source_session_id === "s-relay-1" && ok1.target_member_id === "M1"
  && ok1.actor === "leader" && ok1.tier === "轻立项",
  "S1 归因全列：anchor→group_id、session_id→source_session_id、target→session→member 链、actor/tier 直落");

// S2 重投链：前段终态固化（不删）、新段 attempt+1 parent 指前段
const rt1 = row("d-retry", 1);
const rt2 = dRows.find((r) => r.id === "d-retry#r2"); // 段 2 行 id 已派生，按派生 id 查
assert(rt1.status === "failed" && rt1.receipt === "首次失败" && rt1.created_at === 1100 && rt1.updated_at === 1200,
  "S2 重投段 1 固化：failed 终态保留（旧终态行永不删除）、首末 ts 对号");
assert(rt2 !== undefined && rt2.attempt_no === 2 && rt2.parent_dispatch_id === "d-retry"
  && rt2.status === "failed" && rt2.receipt === "再败" && rt2.created_at === 1300 && rt2.updated_at === 1400,
  "S2 重投段 2：id=<id>#r2、attempt_no+1、parent_dispatch_id 指父、终态与 ts 对号");

// S3 归因两分法：常态 NULL 不落账 / 显式悬空 NULL+落账
const ag = row("d-anchor-ghost");
const sg = row("d-sess-ghost");
assert(ag.group_id === null && sg.source_session_id === null && sg.group_id === null,
  "S3 悬空归因 NULL：anchor 悬空→group_id NULL、session 悬空→source_session_id NULL（零造关联）");
const na = row("d-noactor");
const ba = row("d-badactor");
assert(na.actor === "" && ba.actor === "" && row("d-watchdog").tier === "看门狗",
  "S3 actor 缺省/类型坏→'' 落行（读侧缺省不降级口径）；tier 第六档「看门狗」直落");
assert(row("d-sess-ghost").target_member_id === null && row("d-retry").target_member_id === null,
  "S3 target 占位符（org-leader）非会话 id→target_member_id NULL 不落账");

// S4 坏行 loss 对号（dispatch 源：bad-json 1 + missing-field 2（缺 id/actor 类型坏）+ bad-field 1（status 词表外）+ dangling-ref 2（anchor/session 悬空）+ duplicate-id 1（行15 派生撞行12））
const lossLog = listLoss(port, logFile);
const reasonsLog = lossLog.map((l) => `${l.lineNo}:${l.reason}`).sort().join();
assert(lossLog.length === 7 && reasonsLog === ["8:dangling-ref", "9:dangling-ref", "17:bad-json", "18:missing-field", "11:missing-field", "19:bad-field", "15:duplicate-id"].sort().join(),
  `S4 dispatch 源 7 账对号（bad-json/missing-field×2/bad-field/dangling-ref×2/duplicate-id，物理行号）——实测 ${reasonsLog}`);
assert((lossLog.find((l) => l.reason === "bad-json")?.excerpt ?? "").includes("这不是"), "S4 bad-json excerpt=行原文截 200");
const dupLoss = lossLog.find((l) => l.reason === "duplicate-id");
assert(dupLoss !== undefined && dupLoss.lineNo === 15 && (dupLoss.excerpt ?? "").includes('"id":"x"'),
  "P2 复现：行15 派生 id 撞既有行 → duplicate-id 账拒行（excerpt 带涉事行 root id，不炸批不阻断）");

// P2-1 复现断言（FIX-B ①）：撞名拒行后域导入完成、行12/14 各归其位
const xr2 = row("x#r2");
assert(xr2 !== undefined && xr2.attempt_no === 1 && xr2.status === "dispatched" && xr2.parent_dispatch_id === null,
  "P2 复现：行12 x#r2 独立段原样在库（attempt=1 parent=NULL，未被行15 派生覆盖）");
const xRoot = row("x");
assert(xRoot !== undefined && xRoot.status === "done" && xRoot.attempt_no === 1 && xRoot.parent_dispatch_id === null,
  "P2 复现：行13/14 x 常态收敛 done（行15 重投被拒后段状态保持终态不推进）");

// S5 lesson 面 —— **W-EXPP1 停灌口径（2026-10-10）**：经验域已被团队经验库接管
//（relay/src/experience.ts migrateLessonsToExperience 一次性迁移），lesson 段灌装口
// no-op——lesson 表停灌不删表（空投影即退役终态），boards 源 loss 也不再产 lesson 账。
// 板文件里的 lessons fixture 保留在场（迁移器按 source lesson id 幂等重读的依据），
// 原行级落库断言（tags 洗刷/悬空归因/dup 保首行等）随停灌作废，历史实现见
// retiredImportBoardLessons。
const lRows = port.query<{ id: string }>("SELECT * FROM lesson ORDER BY id");
assert(lRows.length === 0, `W-EXPP1 停灌：lesson 表空投影（不删表、零新灌）——实测 ${lRows.length}`);
const lossBoards = listLoss(port, boardsDir);
assert(lossBoards.length === 0, `W-EXPP1 停灌：boards 源零 loss 账（lesson 段不再产账）——实测 ${lossBoards.length}`);
assert(port.query("PRAGMA foreign_key_check").length === 0, "全库零悬空 FK");
const cps = port.query<{ path: string; line_offset: number; line_count: number }>("SELECT path, line_offset, line_count FROM import_checkpoint ORDER BY path");
assert(cps.length === 2 && cps.every((c) => c.line_offset === c.line_count), "两源 checkpoint 落位（offset=lineCount 全处理）");

// ---------- 5. 幂等快进 / 中断续跑 / 失效重放不残留 ----------
console.log("幂等与时间维度:");
const r2 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: boardsDir });
assert(r2.skipped === true && r2.counts.dispatch === 10 && r2.counts.lesson === 0 && r2.dispatchProcessed === 0,
  "同源重跑快进：skipped=true、行数不增、零处理（lesson 停灌恒 0）");

// 续跑：构造真实批间崩现场——先追加 d-ok 重投两行（21 行），再把 checkpoint 拨回批间态
// （mtime=当前观测、line_count=21、line_offset=16：五元组自洽仅 offset 落后=崩在批尾）。
// offset 快进线（16）刻意罩住全部终态行（行序状态机语义：重遇终态行=再现行=重投推进，
// 快进线后不得有终态行）——余行 17-21 = 脏行重遇（dup 守卫不叠）+d-ok 重投轨迹（恢复段
// 状态开段 2）。直接 append 不拨 cp 会因 lineCount 变化失效重放——那是「源变」语义。
appendDispatch({ ts: 3100, id: "d-ok", tier: "轻立项", target: "s-relay-1", status: "dispatched", session_id: "s-relay-1", project_anchor: "/px/g1", actor: "leader" }, fx);
appendDispatch({ ts: 3200, id: "d-ok", tier: "轻立项", target: "s-relay-1", status: "failed", receipt: "重投失败", session_id: "s-relay-1", project_anchor: "/px/g1", actor: "leader" }, fx);
port.exec("UPDATE import_checkpoint SET mtime_ms = ?, line_count = 21, line_offset = 16 WHERE path = ?",
  [Math.round(statSync(logFile).mtimeMs), logFile]);
const r3 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: boardsDir });
assert(r3.skipped === false && r3.dispatchProcessed === 5 && r3.rescanned.length === 1,
  "批间中断续跑：cp 有效+余 5 行→仅续 5 行（boards 不重扫，rescanned 单源）");
const ok2 = port.query<{ id: string; attempt_no: number; parent_dispatch_id: string | null; status: string; receipt: string | null }>(
  "SELECT id, attempt_no, parent_dispatch_id, status, receipt FROM dispatch WHERE id = 'd-ok#r2'")[0];
assert(ok2 !== undefined && ok2.attempt_no === 2 && ok2.parent_dispatch_id === "d-ok" && ok2.status === "failed" && ok2.receipt === "重投失败",
  "续跑重投链：恢复段状态（段 1 已终态）→开段 2 attempt=2 parent 指父");
assert(r3.counts.dispatch === 11 && listLoss(port, logFile).length === 7,
  "续跑零重复零叠加：已导行 UPDATE 幂等（10+#r2=11）、脏行/撞名行重遇 dup 守卫 loss 不叠（仍 7）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "续跑后仍零悬空 FK");

// 失效重放：mtime 推进（源变语义）→两域联动重灌、行数不残留
utimesSync(logFile, new Date(Date.now() + 5), new Date(Date.now() + 5));
const r4 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: boardsDir });
assert(r4.skipped === false && r4.rescanned.length === 2 && r4.counts.dispatch === 11 && r4.counts.lesson === 0,
  "dispatch 失效重放：两域联动重灌、行数与重放前一致（lesson 停灌恒 0）");
assert(port.query<{ id: string }>("SELECT id FROM dispatch WHERE id = 'd-ok#r2' AND attempt_no = 2 AND parent_dispatch_id = 'd-ok'").length === 1,
  "重放后重投链确定性重建（同输入同输出，幂等）");
assert(listLoss(port, logFile).length === 7 && listLoss(port, boardsDir).length === 0, "重放后 dispatch 源 loss 重建同数、boards 源零 loss（lesson 停灌）");

// 小批事务：batchSize=2 逐批 flush（重放清域单次+跨批段链父行保留）——批间边界正确性
utimesSync(logFile, new Date(Date.now() + 10), new Date(Date.now() + 10)); // 先失效（r4 后 cp 已命中，否则快进）
const r5 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: boardsDir }, { batchSize: 2 });
assert(r5.counts.dispatch === 11 && r5.counts.lesson === 0 && r5.dispatchProcessed === 21,
  "小批重放（batchSize=2，21 行/11 批）：批间 flush 行数不变（lesson 停灌恒 0）");

// 残留面：ndjson 截断重写（源变短）→失效重放→dispatch 域收敛到新内容；boards 删坏文件→其账消失
const cpB2 = port.query<{ mtime_ms: number }>("SELECT mtime_ms FROM import_checkpoint WHERE path = ?", [logFile])[0]!.mtime_ms;
writeFileSync(logFile, readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim() !== "").slice(0, 3).join("\n") + "\n", "utf8");
utimesSync(logFile, new Date(cpB2 + 1), new Date(cpB2 + 1));
const r6 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: boardsDir });
assert(r6.counts.dispatch === 1, `源截断重放：前 3 行（d-ok 同 id 链）收敛 1 行，旧 10 行零残留——实测 ${r6.counts.dispatch}`);
unlinkSync(join(boardsDir, "bad.json"));
const r7 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: boardsDir });
assert(r7.counts.lesson === 0 && !listLoss(port, boardsDir).some((l) => l.reason === "bad-json"),
  "boards 删坏文件→count 变失效→重灌后零账（lesson 停灌空投影不变）");
assert(r7.rescanned.length === 1 && r7.rescanned[0] === boardsDir,
  "boards 失效轮 rescanned 单源：dispatch 跑完态零处理不虚报（P3-5 条件 push）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "终态零悬空 FK");

port.close();
rmSync(dataDir, { recursive: true, force: true });
rmSync(fx, { recursive: true, force: true });

console.log(`Import dispatch-lesson: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
