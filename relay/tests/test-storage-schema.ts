// M11-B1 基线 schema 测试：v1 迁移落地 15 表 6 索引 + FK/CHECK/唯一键逐项对冻结件
// （docs/v2-m10-freeze.md §2）。范式沿用 test-storage（mkdtemp+env 全清+assert 计数+两轮连跑）。
// 本套只验 v1 基线（migrations.slice(0, 1)）——v2 导入台账（import_checkpoint/import_loss）
// 归 M11-B2 测试（test-storage-checkpoint.ts）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations, STORAGE_TABLES, STORAGE_INDEXES } from "../src/storage/schema.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function expectThrow(op: () => void, name: string): void {
  try { op(); fail++; console.error(`  ✗ ${name}（未按预期拒绝）`); }
  catch { pass++; console.log(`  ✓ ${name}`); }
}
function expectOk(op: () => void, name: string): void {
  try { op(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}（意外拒绝：${e instanceof Error ? e.message.split("\n")[0] : String(e)}）`); }
}

// ---------- 0. 启动前纪律（验收 3） ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-schema-"));
process.env.CCR_DATA_DIR = dataDir;
const orgDir = join(dataDir, "org");
process.env.CCR_ORG_DIR = orgDir;
console.log("临时目录纪律:");
assert(process.env.CCR_DATA_DIR === dataDir && process.env.CCR_ORG_DIR === orgDir, "CCR_DATA_DIR/CCR_ORG_DIR 均指向临时目录");
assert(dataDir.startsWith(tmpdir()) && orgDir.startsWith(tmpdir()), "两 env 落 tmpdir 前缀下（零生产写入前提）");

const port = createSqlitePort({ dataDir, filename: "schema.sqlite3" });
port.open();
assert(port.path.startsWith(dataDir), "库文件路径落临时目录内");

function versionOf(p: typeof port): number {
  return p.query<{ user_version: number }>("PRAGMA user_version")[0]?.user_version ?? -1;
}

// ---------- 1. v1 迁移落地 15 表 + 6 索引（验收 1） ----------
console.log("v1 基线落地:");
const r1 = runMigrations(port, migrations.slice(0, 1));
assert(r1.from === 0 && r1.to === 1 && r1.applied.length === 1 && r1.applied[0] === 1, "fresh 库 v1 一次执行（applied=[1]）");
assert(versionOf(port) === 1, "user_version=1");
const tables = port.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
assert(tables.length === 15, `15 表全数落地（实测 ${tables.length}）`);
assert(JSON.stringify(tables) === JSON.stringify([...STORAGE_TABLES].sort()), "表名清单与冻结件一致");
const namedIndexes = port.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").map((r) => r.name);
assert(namedIndexes.length === 6, `命名索引恰 6 个（实测 ${namedIndexes.length}）`);
assert(STORAGE_INDEXES.every((i) => namedIndexes.includes(i)), "6 索引名全在（含部分索引 idx_confirm_pending）");
const EXPECTED_INDEX_SQL: Record<string, string> = {
  idx_task_ready: "CREATE INDEX idx_task_ready ON task(group_id,status,gate_reason)",
  idx_dispatch_open: "CREATE INDEX idx_dispatch_open ON dispatch(group_id,status)",
  idx_confirm_pending: "CREATE INDEX idx_confirm_pending ON org_confirm(status) WHERE status='pending'",
  idx_artifact_attr: "CREATE INDEX idx_artifact_attr ON artifact(project_id,group_id,session_id,task_id)",
  idx_notification_action: "CREATE INDEX idx_notification_action ON notification(level,resolved_at,handled_at)",
  idx_acceptance_task: "CREATE INDEX idx_acceptance_task ON acceptance_sheet(task_id,group_id)",
};
for (const [name, sql] of Object.entries(EXPECTED_INDEX_SQL)) {
  const row = port.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?", [name])[0];
  assert((row?.sql ?? "").replace(/\s+/g, " ").trim() === sql, `索引 ${name} 定义（列序/部分 WHERE）与冻结件一致`);
}
const gmCols = port.query<{ name: string }>('PRAGMA table_info("group")').map((r) => r.name);
const gmmCols = port.query<{ name: string }>("PRAGMA table_info(group_member)").map((r) => r.name);
assert(gmmCols.includes("command_role") && gmmCols.includes("task_participation"), "group_member 组内角色覆盖列在（command_role/task_participation，可空=回落 member 定义）");

// ---------- 2. FK 声明与执行（验收 2a） ----------
console.log("外键:");
const EXPECTED_FKS: Record<string, string[]> = {
  project: [], member: [],
  group: ["project_id->project.id"],
  group_member: ["group_id->group.id", "member_id->member.id"],
  session: ["group_id->group.id", "member_id->member.id"],
  task: ["project_id->project.id", "group_id->group.id", "session_id->session.id", "parent_task_id->task.id", "assignee_id->member.id"],
  dispatch: ["task_id->task.id", "group_id->group.id", "target_member_id->member.id", "source_session_id->session.id", "parent_dispatch_id->dispatch.id"],
  lesson: ["group_id->group.id", "task_id->task.id", "source_dispatch_id->dispatch.id"],
  org_confirm: ["group_id->group.id"],
  acceptance_sheet: ["task_id->task.id", "group_id->group.id"],
  acceptance_item: ["sheet_id->acceptance_sheet.id"],
  acceptance_result: ["item_id->acceptance_item.id"],
  artifact: ["project_id->project.id", "group_id->group.id", "session_id->session.id", "task_id->task.id"],
  notification: [],
  notification_client_state: ["notification_id->notification.id"],
};
function fksOf(table: string): string[] {
  return port.query<{ from: string; table: string; to: string }>(`PRAGMA foreign_key_list("${table}")`)
    .map((r) => `${r.from}->${r.table}.${r.to}`).sort();
}
for (const t of STORAGE_TABLES) {
  assert(JSON.stringify(fksOf(t)) === JSON.stringify([...EXPECTED_FKS[t]].sort()), `FK 声明 ${t}：${EXPECTED_FKS[t].length} 条与冻结件一致`);
}
const fkTotal = Object.values(EXPECTED_FKS).reduce((n, a) => n + a.length, 0);
assert(fksOf("task").length === 5 && fkTotal === 28, `FK 总量 28（task 最多 5 条）与冻结件一致`);
// FK 执行证明（驱动 open 已落 foreign_keys=ON）：悬空引用写入被拒
expectThrow(() => port.exec(`INSERT INTO "group" (id, project_id, name, anchor_dir, status, tier, single_card, created_at, updated_at) VALUES ('gx','p-missing','grp-x','/x','active','正经立项',0,1,1)`), "FK 执行：group.project_id 悬空被拒");
expectThrow(() => port.exec("INSERT INTO dispatch (id, task_id, group_id, tier, actor, status, created_at, updated_at) VALUES ('dx','t-missing','g1','正经立项','leader-a','dispatched',1,1)"), "FK 执行：dispatch.task_id 悬空被拒");
expectThrow(() => port.exec("INSERT INTO task (id, project_id, group_id, origin, task_ref, title, status, assignee_id, ts) VALUES ('tx','p1','g1','leader','ref-tx','task-x','backlog','m-missing',1)"), "FK 执行：task.assignee_id 悬空被拒");
expectThrow(() => port.exec("INSERT INTO notification_client_state (notification_id, client_id) VALUES ('n-missing','client-x')"), "FK 执行：notification_client_state.notification_id 悬空被拒");

// ---------- 3. 合法种子：15 表全部写入 + CHECK 词表全值正检（验收 2b 正向面） ----------
console.log("合法值正检:");
expectOk(() => {
  port.exec("INSERT INTO project (id, name, dir_fingerprint, anchor_dir, ts) VALUES ('p1','proj-a','fp-1','/tmp/proj-a',1)");
  port.exec("INSERT INTO member (id, stable_identity, display_name, business_role, command_role, task_participation, joined_at, status, ts) VALUES ('m1','sid-m1','member-a','dev','worker','implementer',1,'active',1)");
  port.exec(`INSERT INTO "group" (id, project_id, name, anchor_dir, status, tier, single_card, created_at, updated_at) VALUES ('g1','p1','grp-a','/tmp/proj-a','active','正经立项',0,1,1)`);
  port.exec("INSERT INTO group_member (group_id, member_id, joined_at) VALUES ('g1','m1',1)");
  port.exec("INSERT INTO session (id, group_id, member_id, cwd, status, started_at, updated_at) VALUES ('s1','g1','m1','/tmp/proj-a','open',1,1)");
  port.exec("INSERT INTO task (id, project_id, group_id, session_id, origin, task_ref, title, status, ts) VALUES ('t1','p1','g1','s1','leader','ref-t1','task-a','backlog',1)");
  port.exec("INSERT INTO dispatch (id, task_id, group_id, tier, target_member_id, source_session_id, actor, status, created_at, updated_at) VALUES ('d1','t1','g1','正经立项','m1','s1','leader-a','dispatched',1,1)");
  port.exec("INSERT INTO lesson (id, group_id, task_id, text, created_at) VALUES ('l1','g1','t1','lesson-text',1)");
  port.exec("INSERT INTO org_confirm (id, kind, group_id, title, reason, status, created_at) VALUES ('oc1','archive','g1','title-a','reason-a','pending',1)");
  port.exec("INSERT INTO acceptance_sheet (id, task_id, group_id, title, created_at) VALUES ('as1','t1','g1','sheet-a',1)");
  port.exec("INSERT INTO acceptance_item (id, sheet_id, item_index, task, item, criteria) VALUES ('ai1','as1',1,'task-a','item-1','criteria-1')");
  port.exec("INSERT INTO acceptance_result (id, item_id, verdict, actor, created_at) VALUES ('ar1','ai1','pass','worker-a',1)");
  port.exec("INSERT INTO artifact (source_id, normalized_path, project_id, group_id, session_id, task_id, kind, existence_state, created_at, updated_at) VALUES ('src-1','/tmp/proj-a/a.txt','p1','g1','s1','t1','file','exists',1,1)");
  port.exec("INSERT INTO notification (id, level, category, payload_json, created_at) VALUES ('n1','info','test','{}',1)");
  port.exec("INSERT INTO notification_client_state (notification_id, client_id) VALUES ('n1','client-a')");
}, "15 表合法种子全部写入（NOT NULL/FK 正向全通过）");
expectOk(() => { for (const s of ["claimed", "submitted", "ready_to_install", "done", "backlog"]) port.exec("UPDATE task SET status = ? WHERE id = 't1'", [s]); }, "task 五态全词表合法（backlog/claimed/submitted/ready_to_install/done）");
expectOk(() => { for (const s of ["parked", "archived", "pending", "active"]) port.exec(`UPDATE "group" SET status = ? WHERE id = 'g1'`, [s]); }, "group 四态全词表合法（pending/active/parked/archived）");
expectOk(() => { port.exec(`UPDATE "group" SET tier = ? WHERE id = 'g1'`, ["轻立项"]); port.exec(`UPDATE "group" SET tier = ? WHERE id = 'g1'`, ["正经立项"]); }, "group tier 双值合法（轻立项/正经立项）");
expectOk(() => { for (const s of ["running", "done", "failed", "dispatched"]) port.exec("UPDATE dispatch SET status = ? WHERE id = 'd1'", [s]); }, "dispatch 四态全词表合法（dispatched/running/done/failed）");
expectOk(() => { for (const s of ["approved", "rejected", "pending"]) port.exec("UPDATE org_confirm SET status = ? WHERE id = 'oc1'", [s]); }, "org_confirm 三态全词表合法（pending/approved/rejected）");
expectOk(() => { for (const s of ["missing", "unknown", "exists"]) port.exec("UPDATE artifact SET existence_state = ? WHERE source_id = 'src-1'", [s]); }, "artifact existence_state 三态全词表合法（exists/missing/unknown）");
expectOk(() => { for (const s of ["pending", "passed", "not_required"]) port.exec("UPDATE task SET review_status = ? WHERE id = 't1'", [s]); port.exec("UPDATE task SET review_status = NULL WHERE id = 't1'"); }, "task review_status 三态+NULL 合法（pending/passed/not_required）");
expectOk(() => { port.exec("UPDATE acceptance_result SET verdict = ? WHERE id = 'ar1'", ["fail"]); port.exec("UPDATE acceptance_result SET verdict = NULL WHERE id = 'ar1'"); port.exec("UPDATE acceptance_result SET verdict = ? WHERE id = 'ar1'", ["pass"]); }, "acceptance_result verdict pass/fail/NULL 合法（OR verdict IS NULL）");

// ---------- 4. CHECK/NOT NULL 拒非法值（验收 2b；派单点名 task 状态/existence_state/org_confirm status） ----------
console.log("非法值拒绝:");
expectThrow(() => port.exec("UPDATE task SET status = 'doing' WHERE id = 't1'"), "CHECK 拒 task 状态 'doing'（legacy 值须导入期翻译，不得直落）");
expectThrow(() => port.exec("UPDATE task SET status = 'blocked' WHERE id = 't1'"), "CHECK 拒 task 状态 'blocked'（冻结件注：不入 status，gate_reason 表达）");
expectThrow(() => port.exec("UPDATE task SET review_status = 'approved' WHERE id = 't1'"), "CHECK 拒 review_status 'approved'");
expectThrow(() => port.exec(`UPDATE "group" SET status = 'dead' WHERE id = 'g1'`), "CHECK 拒 group 状态 'dead'");
expectThrow(() => port.exec(`UPDATE "group" SET tier = '正规立项' WHERE id = 'g1'`), "CHECK 拒 group tier '正规立项'");
expectThrow(() => port.exec("UPDATE dispatch SET status = 'queued' WHERE id = 'd1'"), "CHECK 拒 dispatch 状态 'queued'");
expectThrow(() => port.exec("UPDATE org_confirm SET status = 'canceled' WHERE id = 'oc1'"), "CHECK 拒 org_confirm 状态 'canceled'");
expectThrow(() => port.exec("UPDATE artifact SET existence_state = 'gone' WHERE source_id = 'src-1'"), "CHECK 拒 existence_state 'gone'");
expectThrow(() => port.exec("UPDATE acceptance_result SET verdict = 'maybe' WHERE id = 'ar1'"), "CHECK 拒 verdict 'maybe'");
expectThrow(() => port.exec("INSERT INTO task (id, origin, task_ref, title, ts) VALUES ('tn','leader','ref-tn','task-n',1)"), "NOT NULL 拒 task.status 缺省写入");

// ---------- 5. 唯一键：声明（PRAGMA index_list）+ 执行（验收 2c） ----------
console.log("唯一键:");
const EXPECTED_UNIQUE: Record<string, number> = {
  project: 1, member: 1, group: 0, group_member: 0, session: 0, task: 1, dispatch: 0,
  lesson: 0, org_confirm: 0, acceptance_sheet: 0, acceptance_item: 1, acceptance_result: 0,
  artifact: 0, notification: 0, notification_client_state: 0,
};
let uniqueMismatch = "";
for (const t of STORAGE_TABLES) {
  const observed = port.query<{ origin: string; unique: number }>(`PRAGMA index_list("${t}")`)
    .filter((r) => r.unique === 1 && r.origin === "u").length;
  if (observed !== EXPECTED_UNIQUE[t]) uniqueMismatch += `${t}:${observed}≠${EXPECTED_UNIQUE[t]} `;
}
assert(uniqueMismatch === "", `UNIQUE 约束逐表与冻结件一致（dir_fingerprint/stable_identity/task_ref/(sheet_id,item_index)）${uniqueMismatch}`);
expectThrow(() => port.exec("INSERT INTO project (id, name, dir_fingerprint, anchor_dir, ts) VALUES ('p-dup','proj-dup','fp-1','/x',1)"), "唯一键执行：project.dir_fingerprint 重复被拒");
expectThrow(() => port.exec("INSERT INTO member (id, stable_identity, display_name, business_role, command_role, task_participation, joined_at, status, ts) VALUES ('m-dup','sid-m1','dup','dev','worker','x',1,'active',1)"), "唯一键执行：member.stable_identity 重复被拒");
expectThrow(() => port.exec("INSERT INTO task (id, project_id, group_id, origin, task_ref, title, status, ts) VALUES ('t-dup','p1','g1','leader','ref-t1','dup','backlog',1)"), "唯一键执行：task.task_ref 重复被拒");
expectThrow(() => port.exec("INSERT INTO acceptance_item (id, sheet_id, item_index, task, item, criteria) VALUES ('ai-dup','as1',1,'t','i','c')"), "唯一键执行：acceptance_item(sheet_id,item_index) 重复被拒");
expectThrow(() => port.exec("INSERT INTO group_member (group_id, member_id, joined_at) VALUES ('g1','m1',2)"), "唯一键执行：group_member 复合主键重复被拒");
expectThrow(() => port.exec("INSERT INTO artifact (source_id, normalized_path, kind, existence_state, created_at, updated_at) VALUES ('src-1','/tmp/proj-a/a.txt','file','exists',2,2)"), "唯一键执行：artifact 复合主键重复被拒");
expectThrow(() => port.exec("INSERT INTO notification_client_state (notification_id, client_id) VALUES ('n1','client-a')"), "唯一键执行：notification_client_state 复合主键重复被拒");

// ---------- 6. 幂等 + 重开持久性（验收 1/3 补证） ----------
console.log("幂等与重开:");
const r2 = runMigrations(port, migrations.slice(0, 1));
assert(r2.applied.length === 0, "v1 幂等重跑零执行");
port.close();
const port2 = createSqlitePort({ dataDir, filename: "schema.sqlite3" });
port2.open();
assert(versionOf(port2) === 1, "重开库 user_version=1（重启持久）");
const reopened = port2.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0]?.n;
assert(reopened === 15, "重开库 15 表仍在");
const r3 = runMigrations(port2, migrations.slice(0, 1));
assert(r3.from === 1 && r3.applied.length === 0, "重开库幂等续跑零执行");
port2.close();

rmSync(dataDir, { recursive: true, force: true });

console.log(`Storage schema: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
