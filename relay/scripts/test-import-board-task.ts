// W-BOARD-FATE-A 板卡域导入测试：boards entries → task 表 origin='board' 分区。
// 范式沿用 C1/C2/D1/D2（mkdtemp+env 钉死+assert 计数+utimesSync 防 mtime 巧合+foreign_key_check）。
// 造态双轨：常态走真写路径（projects.ts upsertBoardEntry/moveBoardEntry/removeBoardEntry，
// dir 注入零生产触达）；「journal 追加+板写失败」窗口/漂移愈合/脏行手搓（写侧无此生产面，
// C2 手搓范式）。
// 归因锚桩（project/group/session 行）：域归 C1/D1，本件 fixture 直插最小行作锚——导入器
// 对这些域只读不写（D2 同款）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importBoardTask, BOARDS_DIR_CP_SUFFIX, BOARD_TASK_IMPORT_SCHEMA_VERSION } from "../src/storage/import-board-task.js";
import { importSessionTask } from "../src/storage/import-session-task.js";
import { boardTaskEntriesFromDb, resetReadModeForTest } from "../src/storage/read-mode.js";
import { listLoss } from "../src/storage/loss-report.js";
import { createGroup, setLightConfirmTrusted, upsertBoardEntry, moveBoardEntry, removeBoardEntry, loadBoardFile, loadBoard } from "../src/projects.js";
import type { ProjectGroup, BoardEntry } from "../src/projects.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
/** 造态守卫：真写路径失败=fixture 坏，直接炸（非断言面）。 */
function entryOf(r: { ok: true; entry: BoardEntry } | { ok: false; error: string }): BoardEntry {
  if (!r.ok) throw new Error(`fixture 造态失败: ${r.error}`);
  return r.entry;
}

// ---------- 0. 纪律 ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-bft-db-"));
process.env.CCR_STORAGE_READ_MODE = "json"; // 显式钉档（直呼导入器的段落不读档；段 9 读切库再显式换档）
process.env.CCR_DATA_DIR = dataDir;
const fx = mkdtempSync(join(tmpdir(), "cc-deck-bft-org-"));
console.log("临时目录纪律:");
assert(dataDir.startsWith(tmpdir()) && fx.startsWith(tmpdir()), "dataDir/fixture orgDir 全落 tmpdir 前缀");
assert(!fx.startsWith(process.env.HOME ?? "~"), "fixture orgDir 不在生产 HOME 下");

const port: StoragePort = createSqlitePort({ dataDir }); // 缺省文件名——段 9 viaReadMode/ensureStore 共库共缓存键
port.open();
runMigrations(port, migrations);

// ---------- 1. 归因锚桩（D2 同款：组走真写路径建 projects.json，库内直插最小行作锚） ----------
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

const journalFile = join(fx, "boards-journal.ndjson");
const boardsDir = join(fx, "boards");
const srcs = { journalFile, boardsDir };
type ImportRes = ReturnType<typeof importBoardTask>;
const run = (): ImportRes => importBoardTask(port, srcs, { schemaVersion: BOARD_TASK_IMPORT_SCHEMA_VERSION });

interface TaskRowShape {
  id: string; origin: string; group_id: string | null; project_id: string | null; session_id: string | null;
  assignee_id: string | null; task_ref: string; title: string; status: string;
  review_required: number; review_status: string; gate_reason: string | null; gate_opened_at: number | null;
  depends_on_json: string; scope_json: string; ts: number; deleted_at: number | null;
}
const qRow = (taskRef: string): TaskRowShape | undefined =>
  port.query<TaskRowShape>("SELECT id, origin, group_id, project_id, session_id, assignee_id, task_ref, title, status, review_required, review_status, gate_reason, gate_opened_at, depends_on_json, scope_json, ts, deleted_at FROM task WHERE task_ref = ?", [taskRef])[0];
const qCount = (where = "origin = 'board'"): number =>
  port.query<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE " + where)[0]?.n ?? -1;
const cpRows = (): { path: string; updated_at: number }[] =>
  port.query<{ path: string; updated_at: number }>("SELECT path, updated_at FROM import_checkpoint WHERE path IN (?, ?)", [journalFile, boardsDir + BOARDS_DIR_CP_SUFFIX]);
const dataVersion = (): number => port.query<{ data_version: number }>("PRAGMA data_version")[0]?.data_version ?? -1;
/** 原始条目读（不走 loadBoardFile——其 migrateBoardStatuses 惰性落盘副作用会提前把旧词
 * 卡迁移掉，旧词映射断言面（段 3 卡E）就测不到导入器自身的映射路径了）。 */
const rawEntries = (gid: string): BoardEntry[] => {
  try {
    const doc = JSON.parse(readFileSync(join(boardsDir, `${gid}.json`), "utf8")) as { entries?: BoardEntry[] };
    return Array.isArray(doc.entries) ? doc.entries : [];
  } catch {
    return [];
  }
};

// ---------- 2. 板卡造态（真写路径） ----------
console.log("板卡造态（真写路径）:");
const cardA = entryOf(upsertBoardEntry(GID, { text: "卡A 派单联动卡", status: "backlog", owner_session: "s-relay-1", dispatch_id: "d-1" }, fx));
const cardB = entryOf(upsertBoardEntry(GID, { text: "卡B 状态轨迹卡", status: "claimed" }, fx));
const cardD = entryOf(upsertBoardEntry(GID, { text: "卡D 依赖+闸门卡", status: "backlog", depends_on: [cardA.id], gate: { reason: "等拍板" } }, fx));
const mvB = moveBoardEntry(GID, cardB.id, "done", fx);
assert(mvB.ok, "卡B 搬 done（transitions 多行）");
// 旧三态映射面：手搓旧词条目直改板文件（importer 内存映射，板文件保持旧词——json 权威不改写）
{
  const p = join(boardsDir, `${GID}.json`);
  const doc = JSON.parse(readFileSync(p, "utf8")) as { entries: BoardEntry[] };
  doc.entries.push({ id: "t-legacy01", text: "卡E 旧三态 todo", status: "todo" as BoardEntry["status"], ts: 111, updated_at: 111, transitions: [{ status: "todo" as BoardEntry["status"], ts: 111 }] });
  writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
}
assert(rawEntries(GID).length === 4, "板文件 4 卡（3 真写+1 手搓旧词）");

// ---------- 3. 首次导入（段 A 全量重灌） ----------
console.log("首次导入:");
const r1 = run();
assert(r1.skipped === false && r1.regranted === true, "首导=全量重灌（regranted）");
assert(r1.count === 4, `行数对齐：板分区 ${r1.count} 行 == 板文件 4 卡`);
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM task")[0]?.n === 4, "task 表全量=板分区（CLI 域 0 行）");

// 抽 3 卡逐字段（验收点 2）
const rowA = qRow(`board/${GID}/${cardA.id}`);
assert(rowA !== undefined && rowA.title === "卡A 派单联动卡" && rowA.status === "backlog", "卡A：title/status 直落");
assert(rowA !== undefined && rowA.group_id === GID && rowA.project_id === "P1", "卡A：group/project 归因链");
assert(rowA !== undefined && rowA.session_id === "s-relay-1" && rowA.assignee_id === "M1", "卡A：owner_session→session→member 归因链");
assert(rowA !== undefined && rowA.origin === "board" && rowA.deleted_at === null && rowA.ts === cardA.ts, "卡A：origin 分区/deleted_at NULL/ts=卡建时间");
const rowB = qRow(`board/${GID}/${cardB.id}`);
assert(rowB !== undefined && rowB.status === "done" && rowB.review_required === 0 && rowB.review_status === "not_required", "卡B：done 终态+复核位收口");
const projB = boardTaskEntriesFromDb(port, GID).find((e) => e.id === cardB.id);
assert(projB !== undefined && Array.isArray(projB.transitions) && projB.transitions.length === 2
  && projB.transitions[1]?.status === "done", "卡B：transitions 经 scope_json 快照逐字段还原（claimed→done 两道）");
const rowD = qRow(`board/${GID}/${cardD.id}`);
assert(rowD !== undefined && rowD.gate_reason === "等拍板" && typeof rowD.gate_opened_at === "number", "卡D：gate 两列落位");
assert(rowD !== undefined && rowD.depends_on_json === JSON.stringify([`board/${GID}/${cardA.id}`]), "卡D：depends_on 升格全局键");
const rowE = qRow(`board/${GID}/t-legacy01`);
assert(rowE !== undefined && rowE.status === "backlog", "卡E：旧三态 todo→backlog 就地映射");
assert(port.query<{ n: number }>("PRAGMA foreign_key_check").length === 0, "外键完整性（foreign_key_check 空）");

// ---------- 4. 幂等快进（验收点 1：重复跑零重写） ----------
console.log("幂等快进:");
const dv0 = dataVersion();
const cps0 = cpRows();
const r2 = run();
assert(r2.skipped === true && r2.count === 4 && r2.journalProcessed === 0, "重复跑=零写入快进（skipped）");
assert(dataVersion() === dv0, "零重写实证：PRAGMA data_version 不变");
const cps1 = cpRows();
assert(cps0.length === 2 && cps1.length === 2 && cps0.every((c, i) => c.updated_at === cps1[i]?.updated_at), "零重写实证：双源 checkpoint updated_at 不变");

// ---------- 5. 分区契约（CLI 域重灌不碾板分区 / 板域重灌不碾 CLI 域） ----------
console.log("分区契约:");
const st = importSessionTask(port, {
  eventsFile: join(dataDir, "events.ndjson"), // 不存在=源不可观测（D1 口径），但 cpEvents null 仍触发 task 域重灌
  tasksDir: join(dataDir, "tasks"),
  acceptanceDir: join(dataDir, "acceptances"),
});
assert(st.skipped === false, "CLI 域导入跑过（task 域重灌触发）");
assert(qCount() === 4 && qCount("origin = 'user'") === 0, "CLI 域重灌后板分区 4 行原样（origin='user' 分区清灌不越界）");
port.exec(`INSERT INTO task (id, project_id, group_id, session_id, origin, task_ref, title, description, depends_on_json, review_required, status, ts)
  VALUES ('task-cli-fake', NULL, NULL, NULL, 'user', 'sid-1/tid-1', 'CLI 假行', '', '[]', 0, 'backlog', 1)`);
const cardF = upsertBoardEntry(GID, { text: "卡F 触发板域重灌", status: "backlog" }, fx);
const r5 = run();
assert(r5.regranted === true && r5.count === 5, "板文件变=板域全量重灌（5 卡）");
assert(qCount("origin = 'user'") === 1, "板域重灌不碾 CLI 域行（origin='user' 生存）");

// ---------- 6. journal 增量追赶（手搓「journal 追加+板写失败」窗口） ----------
console.log("journal 增量追赶:");
/** journal 当前行数（断言锚：五元组范式 append=失效从 0 重放——journalProcessed 恒=全量行数）。 */
const jLines = (): number => readFileSync(journalFile, "utf8").split("\n").filter((l) => l.trim() !== "").length;
// 6a. 追赶窗口：journal 有新行、板文件未变（板写失败形态）——touch 集重读板文件真身 upsert。
// 五元组口径：append 破坏 (mtime,lineCount) = 失效 → 从 0 重放（D1/D2 同款幂等范式），
// 但**不清板分区**（regranted=false）——这就是「追赶」与「重灌」的分界。
appendFileSync(journalFile, JSON.stringify({ ts: Date.now(), gid: GID, action: "update", entry_id: cardA.id, next: { status: "backlog", text: "截断摘要" } }) + "\n");
const r6a = run();
assert(r6a.skipped === false && r6a.regranted === false && r6a.journalProcessed === jLines(), "journal 增长=追赶路径（非重灌，从 0 重放全量行）");
assert(r6a.rescanned.length === 1 && r6a.rescanned[0] === journalFile && r6a.count === 5, "追赶只动 journal 源，板分区快照不动");
const rowA6 = qRow(`board/${GID}/${cardA.id}`);
assert(rowA6 !== undefined && rowA6.title === "卡A 派单联动卡" && rowA6.status === "backlog", "touch 重读板文件真身（不被截 60 摘要污染 title）");
// 6b. 漂移愈合 DELETE 分支：幽灵板行（条目已不在板）随 touch 行删除
port.exec(`INSERT INTO task (id, project_id, group_id, session_id, origin, task_ref, title, description, depends_on_json, review_required, status, ts)
  VALUES ('board-ghost', NULL, ?, NULL, 'board', ?, '幽灵行', '', '[]', 0, 'backlog', 1)`, [GID, `board/${GID}/t-ghost`]);
appendFileSync(journalFile, JSON.stringify({ ts: Date.now(), gid: GID, action: "remove", entry_id: "t-ghost" }) + "\n");
const r6b = run();
assert(r6b.journalProcessed === jLines() && qRow(`board/${GID}/t-ghost`) === undefined, "remove touch：缺席条目=投影行删除（漂移愈合）");
// 6c. 坏行落账不阻断 + 板级行（无 entry_id）只推 offset
appendFileSync(journalFile, "{not-json\n");
appendFileSync(journalFile, JSON.stringify({ ts: Date.now(), gid: GID, action: "freeze" }) + "\n");
appendFileSync(journalFile, JSON.stringify({ ts: Date.now(), action: "missing-gid" }) + "\n");
const r6c = run();
assert(r6c.journalProcessed === jLines(), "坏行/板级行照推 offset（重放全量行含坏行）");
const jLoss = listLoss(port, journalFile);
assert(jLoss.some((l) => l.reason === "bad-json") && jLoss.some((l) => l.reason === "missing-field"), "journal 坏行双因落账");
// 6d. 追赶后幂等
const r6d = run();
assert(r6d.skipped === true && r6d.count === 5, "追赶收敛后回快进（幂等）");

// ---------- 7. removeCard 真路径（段 A 全量重灌对账） ----------
console.log("removeCard 真路径:");
const rm = removeBoardEntry(GID, cardB.id, fx);
assert(rm.ok, "removeBoardEntry 真路径成功（journal remove 行+板文件变）");
const r7 = run();
assert(r7.regranted === true && r7.count === 4, "板文件变=全量重灌，remove 卡行随重灌消失");
assert(qRow(`board/${GID}/${cardB.id}`) === undefined, "卡B 投影行删除");

// ---------- 8. 边角与 loss ----------
console.log("边角与 loss:");
writeFileSync(join(boardsDir, "pg-bad.json"), "{broken\n"); // 坏板 JSON
writeFileSync(join(boardsDir, "pg-dirty.json"), JSON.stringify({
  gid: "pg-dirty",
  entries: [
    { id: "t-ok1", text: "脏板好卡", status: "claimed", ts: 5, updated_at: 5 },
    { id: "t-notext", status: "backlog", ts: 6, updated_at: 6 }, // 缺 text
    { id: "t-badst", text: "越词表状态", status: "wip", ts: 7, updated_at: 7 }, // 状态越词表
    { id: "t-ok1", text: "重复 id 卡", status: "backlog", ts: 8, updated_at: 8 }, // 同板重复 id
    { id: "t-ghost-sess", text: "悬空会话卡", status: "backlog", owner_session: "s-ghost", ts: 9, updated_at: 9 }, // owner 悬空
  ],
}));
writeFileSync(join(boardsDir, "pg-ghostgid.json"), JSON.stringify({
  gid: "pg-ghostgid",
  entries: [{ id: "t-nogrp", text: "悬空组卡", status: "backlog", ts: 10, updated_at: 10 }],
}));
const r8 = run();
assert(r8.regranted === true, "板目录变（新文件）=全量重灌");
const bLoss = listLoss(port, boardsDir);
assert(bLoss.some((l) => l.reason === "bad-json" && l.excerpt.includes("pg-bad")), "坏板 JSON 整板账");
assert(bLoss.some((l) => l.reason === "missing-field") && bLoss.some((l) => l.reason === "bad-field"), "缺 text/越词表落账");
assert(bLoss.filter((l) => l.reason === "duplicate-id").length === 1, "同板重复 id 保首行落账");
const rowOk1 = qRow("board/pg-dirty/t-ok1");
assert(rowOk1 !== undefined && rowOk1.title === "脏板好卡", "脏板好卡照入");
const rowGhostSess = qRow("board/pg-dirty/t-ghost-sess");
assert(rowGhostSess !== undefined && rowGhostSess.session_id === null && bLoss.some((l) => l.reason === "dangling-ref"), "owner_session 悬空=NULL+dangling-ref（不造关联）");
const rowNoGrp = qRow("board/pg-ghostgid/t-nogrp");
assert(rowNoGrp !== undefined && rowNoGrp.group_id === null, "悬空组卡照导（group_id NULL 不丢事实）");
assert(qCount() === 7, `行数对齐（重灌后 7 卡：g1 3+legacy+pg-dirty 2+pg-ghost 1——脏行拒入）`);
assert(port.query<{ n: number }>("PRAGMA foreign_key_check").length === 0, "外键完整性（边角轮）");
assert(cpRows().length === 2, "checkpoint 双源落位（journal+bare 目录分键 #board-task-view）");

// ---------- 9. 读切库（viaReadMode 三档） ----------
console.log("读切库（viaReadMode）:");
resetReadModeForTest();
process.env.CCR_STORAGE_READ_MODE = "sqlite";
const viaBoard = loadBoard(GID, fx); // sqlite 档：ensureStore 聚合追赶 + task 表板分区投影
const fileB = loadBoardFile(GID, fx);
assert(viaBoard.entries.length === (fileB?.entries.length ?? -1), `sqlite 读=文件行数（${viaBoard.entries.length} 卡）`);
const byId = new Map(viaBoard.entries.map((e) => [e.id, e]));
assert((fileB?.entries ?? []).every((fe) => {
  const pe = byId.get(fe.id);
  return pe !== undefined && JSON.stringify({ ...pe }) === JSON.stringify({ ...fe });
}), "sqlite 读=文件逐卡逐字段（含 transitions/owner_session/dispatch_id/gate 等 scope_json 快照面）");
const projLegacy = byId.get("t-legacy01");
assert(projLegacy !== undefined && projLegacy.status === "backlog", "sqlite 读旧词卡=映射后值（与 json 路径 migrateBoardStatuses 等价）");
assert(viaBoard.frozen === false, "envelope 有损备案：frozen 恒 false（freeze 执锁在写侧文件面）");
process.env.CCR_STORAGE_READ_MODE = "json";
const jsonBoard = loadBoard(GID, fx);
assert(jsonBoard.entries.length === (fileB?.entries.length ?? -1), "json 档读切库后行为零变化（文件直读原样）");

// ---------- 10. 收尾 ----------
port.close();
resetReadModeForTest();
rmSync(dataDir, { recursive: true, force: true });
rmSync(fx, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
