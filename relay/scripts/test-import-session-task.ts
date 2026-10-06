// M11-D1 会话与任务导入测试：fixture 驱动（自制小样 events.ndjson + tasks 目录 + acceptances 目录，零生产触达）。
// 范式沿用存储线四件（mkdtemp+env 全清+assert 计数+两轮一致）；组织域 fixture 先经 C1 importOrg
// 建好 project/group（D1 归因链依赖），C1 本体回归归 test-import-org.ts。
// 断言面（对应验收点 1-4）：
//   A 全量首跑：session 重放终态（CREATED 建/WAITING·RESOLVED·ERROR·DONE 推进/DELETED 落
//     deleted_at 不删行/LOG 正文零入库=updated_at 不被推进+行数不变）；task 双词表映射+
//     review_required 推断（cwd 命中）+submitted 生成+depends_on；坏行三场景 loss+悬空归因 NULL。
//   B 幂等重跑：三源快进零写入行数不增。
//   C 行级断点续跑：回拨 offset 模拟中断→只处理余下行（eventsProcessed=N-offset）零重复。
//   D task 域重灌：task 文件 mtime 变→域清重灌行数不增（防残留面）。
//   E events 失效重放：追加行→从 0 重放（upsert 覆盖）+task 域联动重灌。
//   F 多批重放：batchSize=4 小批×坏行跨批，loss 账不被批间误删（M11-REVIEW2 P1-1 回归锁）。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importOrg } from "../src/storage/import-org.js";
import { importSessionTask, SESSION_TASK_IMPORT_SCHEMA_VERSION } from "../src/storage/import-session-task.js";
import { writeCheckpoint, readCheckpoint } from "../src/storage/checkpoint.js";
import { listLoss } from "../src/storage/loss-report.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- 0. 启动前纪律（零生产触达前提） ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-d1-"));
process.env.CCR_DATA_DIR = dataDir;
const orgDir = join(dataDir, "org");
process.env.CCR_ORG_DIR = orgDir;
console.log("临时目录纪律:");
assert(process.env.CCR_DATA_DIR === dataDir && process.env.CCR_ORG_DIR === orgDir, "CCR_DATA_DIR/CCR_ORG_DIR 均指向临时目录");
assert(dataDir.startsWith(tmpdir()) && orgDir.startsWith(tmpdir()), "两 env 落 tmpdir 前缀下");
assert(!existsSync(join(process.env.HOME ?? "", ".cc-deck", "cc-deck.sqlite3")), "生产目录无本测试库文件（未触碰 ~/.cc-deck）");

// ---------- fixture 构造 ----------
const S1 = "sess-1111";
const S2 = "sess-2222";
const GHOST = "sess-ghost";
const eventsFile = join(dataDir, "events.ndjson");
const tasksDir = join(dataDir, "tasks");
const acceptDir = join(dataDir, "acceptances");

const EVENTS: [string, Record<string, unknown>][] = [
  ["SESSION_CREATED", { cwd: "/fx/proj-a", model: "glm-5.3", relay_session_id: "relay-s1", initial_prompt: "p1" }],
  ["SESSION_CREATED", { cwd: "/fx/solo", model: "glm-5.3" }],
  ["SESSION_LOG", { kind: "tool_use", text: "正文绝不入库", tool: "Edit" }],
  ["SESSION_WAITING", {}],
  ["SESSION_UPDATED", { status: "WORKING" }],
  ["SESSION_ERROR", { last_error: "boom" }],
  ["SESSION_WAITING_RESOLVED", {}],
  ["SESSION_DONE", { done_reason: "finish", duration_ms: 5000 }],
  ["SESSION_DELETED", {}],
  ["SESSION_WAITING", {}], // 未见 sid（S3）——首见非 CREATED 拒行落账
];
function writeEvents(): void {
  const rows = [
    ev(1, S1, 1001, EVENTS[0][0], EVENTS[0][1]),
    ev(2, S2, 1002, EVENTS[1][0], EVENTS[1][1]),
    ev(3, S1, 1003, EVENTS[2][0], EVENTS[2][1]),
    ev(4, S1, 1004, EVENTS[3][0], EVENTS[3][1]),
    '{"broken', // 行 5：坏 JSON
    ev(6, S2, 1006, EVENTS[4][0], EVENTS[4][1]),
    ev(7, S2, 1007, EVENTS[5][0], EVENTS[5][1]),
    ev(8, S1, 1008, EVENTS[6][0], EVENTS[6][1]),
    ev(9, S2, 1009, EVENTS[7][0], EVENTS[7][1]),
    ev(10, S2, 1010, EVENTS[8][0], EVENTS[8][1]),
    ev(11, "sess-3333", 1011, EVENTS[9][0], EVENTS[9][1]),
  ];
  writeFileSync(eventsFile, rows.join("\n") + "\n");
}
function ev(seq: number, sid: string, ts: number, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ seq, session_id: sid, ts, type, payload });
}

function writeTask(sid: string, tid: string, doc: Record<string, unknown>): string {
  const sub = join(tasksDir, sid);
  mkdirSync(sub, { recursive: true });
  const file = join(sub, `${tid}.json`);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

function writeFixtures(): void {
  writeEvents();
  // tasks：S1（cwd 在验收集）/S2（solo，无验收单）/GHOST（session 表无行）
  writeTask(S1, "1", { id: "1", subject: "任务一", description: "d1", status: "pending", blocks: [], blockedBy: [] });
  writeTask(S1, "2", { id: "2", subject: "任务二", description: "", status: "in_progress", blocks: [], blockedBy: [] });
  writeTask(S1, "3", { id: "3", subject: "任务三", description: "", status: "completed", blocks: [], blockedBy: [] });
  writeTask(S1, "5", { id: "5", subject: "任务五", description: "", status: "doing", blocks: ["1"], blockedBy: ["1"] });
  writeTask(S1, "6", { id: "6", subject: "任务六", description: "", status: "blocked", blocks: [], blockedBy: [] }); // 词表外拒入
  writeTask(S1, "8", { id: "8", description: "无 subject", status: "todo", blocks: [], blockedBy: [] }); // 缺 subject 拒入
  writeTask(S2, "9", { id: "9", subject: "solo 任务", description: "", status: "completed", blocks: [], blockedBy: [] });
  writeTask(GHOST, "7", { id: "7", subject: "孤魂任务", description: "", status: "todo", blocks: [], blockedBy: [] });
  // acceptances：一个有效 sheet（cwd=/fx/proj-a）+ 一个 .results.json（排除面）+ 一个坏 JSON
  mkdirSync(acceptDir, { recursive: true });
  writeFileSync(join(acceptDir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"),
    JSON.stringify({ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "验收单甲", created_at: 1000, cwd: "/fx/proj-a", rows: [{ task: "#1", item: "i", criteria: "c" }] }));
  writeFileSync(join(acceptDir, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.results.json"), JSON.stringify({ id: "b", history: [] }));
  writeFileSync(join(acceptDir, "cccccccccccccccccccccccccccccccc.json"), "{bad json");
  // org fixture（C1 导入建 project/group，D1 归因链依赖）
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(orgDir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "lead-sess", created_at: 1000 }));
  writeFileSync(join(orgDir, "projects.json"), JSON.stringify({
    groups: [{ id: "g1", name: "grp-a", anchor_dir: "/fx/proj-a", status: "active", tier: "正经立项", single_card: false, headcount: [], created_at: 1000, updated_at: 1000 }],
  }));
  writeFileSync(join(orgDir, "confirms.json"), "[]");
}
writeFixtures();

const port: StoragePort = createSqlitePort({ dataDir, filename: "d1.sqlite3" });
port.open();
runMigrations(port, migrations);
const orgResult = importOrg(port, orgDir);
assert(orgResult.counts.group === 1 && orgResult.counts.project === 1, "前置：C1 组织域 fixture 导入（1 组 1 项目）");

const sources = { eventsFile, tasksDir, acceptanceDir: acceptDir };
function sess(id: string): Record<string, unknown> | undefined {
  return port.query<Record<string, unknown>>("SELECT * FROM session WHERE id = ?", [id])[0];
}
function taskByRef(ref: string): Record<string, unknown> | undefined {
  return port.query<Record<string, unknown>>("SELECT * FROM task WHERE task_ref = ?", [ref])[0];
}
function lossCount(): number {
  return listLoss(port).filter((l) => [eventsFile, tasksDir, acceptDir].includes(l.sourcePath)).length;
}

// ---------- A. 全量首跑 ----------
console.log("全量首跑:");
const r1 = importSessionTask(port, sources);
assert(r1.skipped === false && r1.eventsProcessed === 11, `首跑处理 11 行 events（实际 ${r1.eventsProcessed}）`);
assert(r1.counts.session === 2, `session 表 2 行（S1/S2；S3 未建行，实际 ${r1.counts.session}）`);
const s1 = sess(S1);
assert(s1 !== undefined && s1.status === "WORKING", "S1 重放终态 WORKING（WAITING→RESOLVED 推进链）");
assert(s1?.group_id === "g1", "S1 group 归因：cwd 精确匹配 anchor_dir→g1");
assert(s1?.started_at === 1001 && s1?.relay_session_id === "relay-s1", "S1 首帧字段（started_at/relay_session_id）入行");
assert(s1?.updated_at === 1008, "S1 updated_at=1008：SESSION_LOG(行3) 零效果未推进（正文零入库证词）");
const s2 = sess(S2);
assert(s2 !== undefined && s2.status === "DONE" && s2.deleted_at === 1010, "S2 终态 DONE + DELETED 落 deleted_at 不删行");
const s2Runtime = JSON.parse(String(s2?.runtime_state_json ?? "{}")) as Record<string, unknown>;
assert(s2Runtime.last_error === "boom" && s2Runtime.done_reason === "finish" && s2Runtime.duration_ms === 5000, "S2 runtime_state_json 收编 last_error/done_reason/duration_ms");
assert(sess("sess-3333") === undefined, "首见非 CREATED 的 sid 不建骨架行（拒行落账）");

assert(r1.counts.task === 6, `task 表 6 行（拒入 2 行不计，实际 ${r1.counts.task}）`);
const t1 = taskByRef(`${S1}/1`);
assert(t1 !== undefined && t1.status === "backlog", "todo|pending→backlog（双词表映射）");
const t2 = taskByRef(`${S1}/2`);
assert(t2 !== undefined && t2.status === "claimed", "doing|in_progress→claimed");
const t3 = taskByRef(`${S1}/3`);
assert(t3 !== undefined && t3.status === "submitted" && t3.review_required === 1 && t3.review_status === "pending",
  "completed+验收单命中→submitted（review_required=1，review_status=pending）");
assert(t3?.project_id !== null && t3?.group_id === "g1" && t3?.session_id === S1, "task 归因链：session.cwd→group→project 全链落");
const t5 = taskByRef(`${S1}/5`);
assert(t5 !== undefined && t5.status === "claimed" && t5.depends_on_json === JSON.stringify([`${S1}/1`]), "blockedBy→depends_on_json（稳定迁移 ref 串）");
const t9 = taskByRef(`${S2}/9`);
assert(t9 !== undefined && t9.status === "done" && t9.review_required === 0 && t9.review_status === "not_required",
  "completed 无验收单→done（review_required=0 保守缺省）");
const t7 = taskByRef(`${GHOST}/7`);
assert(t7 !== undefined && t7.session_id === null && t7.project_id === null && t7.group_id === null, "悬空 task：session/project/group 归因全 NULL");

const d1Loss = listLoss(port);
const d1Mine = d1Loss.filter((l) => [eventsFile, tasksDir, acceptDir].includes(l.sourcePath));
assert(d1Mine.length === 6, `loss 恰 6 条（events 2 + tasks 3 + accept 1，实际 ${d1Mine.length}）`);
assert(d1Mine.filter((l) => l.sourcePath === eventsFile).map((l) => `${l.lineNo}:${l.reason}`).join() === "5:bad-json,11:missing-field", "events 源两账：行5 bad-json + 行11 missing-field");
assert(d1Mine.some((l) => l.sourcePath === tasksDir && l.reason === "dangling-ref" && (l.excerpt as string).includes(GHOST)), "悬空归因落账 dangling-ref（GHOST/7，source_path=tasksDir）");
assert(d1Mine.some((l) => l.sourcePath === tasksDir && l.reason === "bad-field"), "状态词表外（blocked）拒入落账 bad-field");
assert(d1Mine.some((l) => l.sourcePath === tasksDir && l.reason === "missing-field"), "缺 subject 拒入落账 missing-field");
assert(d1Mine.some((l) => l.sourcePath === acceptDir && l.reason === "bad-json"), "坏验收单落账 bad-json");
assert(d1Mine.every((l) => !l.sourcePath.endsWith("results.json")), ".results.json 排除面未误入");

// ---------- B. 幂等重跑 ----------
console.log("幂等重跑:");
const r2 = importSessionTask(port, sources);
assert(r2.skipped === true && r2.eventsProcessed === 0 && r2.rescanned.length === 0, "三源命中→快进零写入");
assert(r2.counts.session === 2 && r2.counts.task === 6, "快进后行数不增（2/6）");
assert(listLoss(port).filter((l) => [eventsFile, tasksDir, acceptDir].includes(l.sourcePath)).length === 6, "快进后 loss 不增（仍 6）");

// ---------- C. 行级断点续跑（回拨 offset 模拟中断） ----------
console.log("行级断点续跑:");
writeCheckpoint(port, { path: eventsFile, mtimeMs: Math.round(statSync(eventsFile).mtimeMs), lineCount: 11, offset: 4, schemaVersion: SESSION_TASK_IMPORT_SCHEMA_VERSION });
const r3 = importSessionTask(port, sources);
assert(r3.skipped === false && r3.eventsProcessed === 7, `续跑只处理余下行 5..11（实际 ${r3.eventsProcessed}）`);
assert(r3.counts.session === 2 && r3.counts.task === 6, "续跑后行数不增零重复");
assert(sess(S1)?.status === "WORKING" && sess(S2)?.deleted_at === 1010, "续跑后重放终态与全量一致（增量无缺位）");
assert(listLoss(port).filter((l) => [eventsFile, tasksDir, acceptDir].includes(l.sourcePath)).length === 6, "续跑后 loss 不增（行 5/11 的账不重复落）");
const cp3 = readCheckpoint(port, eventsFile, { mtimeMs: Math.round(statSync(eventsFile).mtimeMs), lineCount: 11, schemaVersion: SESSION_TASK_IMPORT_SCHEMA_VERSION });
assert(cp3 !== null && cp3.offset === 11, "续跑完 checkpoint 推进到 lineCount（offset=11）");

// ---------- D. task 域重灌（task 文件变化→域清重灌防残留） ----------
console.log("task 域重灌:");
writeTask(S1, "2", { id: "2", subject: "任务二改", description: "", status: "completed", blocks: [], blockedBy: [] });
const t2File = join(tasksDir, S1, "2.json");
utimesSync(t2File, new Date(statSync(t2File).mtimeMs + 10), new Date(statSync(t2File).mtimeMs + 10)); // APFS 同毫秒保护
const r4 = importSessionTask(port, sources);
assert(r4.skipped === false && r4.eventsProcessed === 0, "events checkpoint 有效→events 零重放");
assert(r4.counts.task === 6, "task 域重灌后行数不增（DELETE+重灌防残留）");
const t2b = taskByRef(`${S1}/2`);
assert(t2b !== undefined && t2b.status === "submitted" && t2b.title === "任务二改", "重灌采新内容（completed+验收单→submitted，title 更新）");
assert(sess(S1)?.status === "WORKING", "task 重灌不碰 session 域（S1 保持）");

// ---------- D2. accDir 失效→段 2 重放（checkpoint 分键后失效响应语义保留——M11-H1 D1 修复回归面） ----------
console.log("accDir 失效重放:");
const accSheet = join(acceptDir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json");
utimesSync(accSheet, new Date(statSync(accSheet).mtimeMs + 10), new Date(statSync(accSheet).mtimeMs + 10)); // APFS 同毫秒保护
const r4b = importSessionTask(port, sources);
assert(r4b.skipped === false && r4b.eventsProcessed === 0, "accDir 失效→段 2 触发且 events 仍零重放（分键后 events cp 独立）");
assert(r4b.counts.task === 6, "accDir 失效→task 域重灌行数不增");
const t3b = taskByRef(`${S1}/2`);
assert(t3b !== undefined && t3b.review_required === 1 && t3b.status === "submitted", "accDir 失效→review_required 重推（sheet 集重读，submitted 保持）");
const r4c = importSessionTask(port, sources);
assert(r4c.skipped === true && r4c.rescanned.length === 0, "分键 checkpoint 命中→快进（#tasks-view 新键稳态，acceptance 域口径互踩消除）");

// ---------- E. events 失效重放（追加行→从 0 重放+task 联动重灌） ----------
console.log("events 失效重放:");
{
  const rows = [
    ev(12, S1, 1020, "SESSION_DONE", { done_reason: "all-done", duration_ms: 9000 }),
    ev(13, S1, 1021, "SESSION_WAITING", {}),
  ];
  writeFileSync(eventsFile, (() => {
    const prev: string[] = [];
    // 追加到原 11 行后（重写全文件：原样 + 2 新行）
    const base = [
      ev(1, S1, 1001, EVENTS[0][0], EVENTS[0][1]),
      ev(2, S2, 1002, EVENTS[1][0], EVENTS[1][1]),
      ev(3, S1, 1003, EVENTS[2][0], EVENTS[2][1]),
      ev(4, S1, 1004, EVENTS[3][0], EVENTS[3][1]),
      '{"broken',
      ev(6, S2, 1006, EVENTS[4][0], EVENTS[4][1]),
      ev(7, S2, 1007, EVENTS[5][0], EVENTS[5][1]),
      ev(8, S1, 1008, EVENTS[6][0], EVENTS[6][1]),
      ev(9, S2, 1009, EVENTS[7][0], EVENTS[7][1]),
      ev(10, S2, 1010, EVENTS[8][0], EVENTS[8][1]),
      ev(11, "sess-3333", 1011, EVENTS[9][0], EVENTS[9][1]),
    ];
    prev.push(...base, ...rows);
    return prev.join("\n") + "\n";
  })());
  utimesSync(eventsFile, new Date(statSync(eventsFile).mtimeMs + 10), new Date(statSync(eventsFile).mtimeMs + 10));
}
const r5 = importSessionTask(port, sources);
assert(r5.skipped === false && r5.eventsProcessed === 13, `失效→从 0 全量重放 13 行（实际 ${r5.eventsProcessed}）`);
assert(sess(S1)?.status === "WAITING", "重放终态：S1 行12 DONE→行13 WAITING（顺序重放正确）");
const s1Runtime = JSON.parse(String(sess(S1)?.runtime_state_json ?? "{}")) as Record<string, unknown>;
assert(s1Runtime.done_reason === "all-done", "重放 runtime 增量覆盖式收编（done_reason 在）");
assert(r5.counts.task === 6, "task 域联动重灌行数不增（归因链依赖 session 全量）");
assert(sess(S2)?.status === "DONE" && sess(S2)?.deleted_at === 1010, "重放对既有行 upsert 覆盖同值（幂等终态）");
assert(listLoss(port).filter((l) => [eventsFile, tasksDir, acceptDir].includes(l.sourcePath)).length === 6, "重放后 loss 不增（失效路径先清旧账再落，无重复）");

// ---------- F. 多批重放：batchSize=4 小批 × 坏行跨批（M11-REVIEW2 P1-1 回归锁） ----------
// 修复缺陷：flushBatch 内 `if (fromLine === 0) DELETE loss` 每批执行——批 2 删掉批 1 已提交
// 的账、坏行已 splice 永不重落→只有末批账存活（修复前本 fixture 三笔账全丢=0 残留）。
// 修法：DELETE 移出批循环，段 1 开始前一次性执行（参照 D2 清域单次 cleared 先例）。
console.log("多批重放 loss 不误删:");
{
  const rowsF: string[] = [
    ev(1, "sess-4444", 2001, "SESSION_CREATED", { cwd: "/fx/solo2", model: "glm-5.3" }),
    ev(2, "sess-4444", 2002, "SESSION_WAITING", {}),
    '{"broken-3', // 行 3：批 1 坏 JSON（batchSize=4 → 行 1-4 批 1）
    ev(4, "sess-4444", 2004, "SESSION_DONE", { done_reason: "f" }),
    ev(5, "sess-5555", 2005, "SESSION_CREATED", { cwd: "/fx/solo3", model: "glm-5.3" }),
    ev(6, "sess-5555", 2006, "SESSION_LOG", { kind: "tool_use", text: "x", tool: "Read" }),
    ev(7, "sess-5555", 2007, "SESSION_WAITING", {}),
    ev(8, "sess-5555", 2008, "SESSION_WAITING_RESOLVED", {}),
    JSON.stringify({ seq: 9, ts: 2009, type: "SESSION_CREATED", payload: {} }), // 行 9：批 3 缺 session_id
    ev(10, "sess-5555", 2010, "SESSION_DONE", { done_reason: "g" }),
    ev(11, "sess-6666", 2011, "SESSION_CREATED", { cwd: "/fx/solo4", model: "glm-5.3" }),
    ev(12, "sess-6666", 2012, "SESSION_UPDATED", { status: "WORKING" }),
    ev(13, "sess-6666", 2013, "SESSION_DONE", { done_reason: "h" }),
    ev(14, "sess-7777", 2014, "SESSION_CREATED", { cwd: "/fx/solo5", model: "glm-5.3" }),
    '{"broken-15', // 行 15：批 4 坏 JSON
    ev(16, "sess-7777", 2016, "SESSION_WAITING", {}),
    ev(17, "sess-7777", 2017, "SESSION_DONE", { done_reason: "i" }),
    ev(18, "sess-4444", 2018, "SESSION_LOG", { kind: "tool_use", text: "y", tool: "Edit" }),
    ev(19, "sess-6666", 2019, "SESSION_DELETED", {}),
    ev(20, "sess-7777", 2020, "SESSION_UPDATED", { status: "ERROR" }),
  ];
  writeFileSync(eventsFile, rowsF.join("\n") + "\n");
  utimesSync(eventsFile, new Date(statSync(eventsFile).mtimeMs + 10), new Date(statSync(eventsFile).mtimeMs + 10)); // APFS 同毫秒保护
}
const rF1 = importSessionTask(port, sources, { batchSize: 4 });
assert(rF1.skipped === false && rF1.eventsProcessed === 20, `多批首跑处理 20 行（batchSize=4×5 批，实际 ${rF1.eventsProcessed}）`);
const fLoss1 = listLoss(port, eventsFile);
assert(fLoss1.length === 3 && JSON.stringify(fLoss1.map((l) => `${l.lineNo}:${l.reason}`)) === JSON.stringify(["3:bad-json", "9:missing-field", "15:bad-json"]),
  `首跑全量坏行账都在（批 1/3/4 各一笔跨批存活，修复前批间互删只剩 0 笔，实际 ${JSON.stringify(fLoss1.map((l) => `${l.lineNo}:${l.reason}`))}）`);
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM session")[0]?.n === 6, "session 2 旧 + 4 新（坏行不建行不阻断后续行）");
// ② 失效重放：mtime 变→从 0 重放（段前清账一次+三批重落），账仍全在同位
utimesSync(eventsFile, new Date(statSync(eventsFile).mtimeMs + 10), new Date(statSync(eventsFile).mtimeMs + 10));
const rF2 = importSessionTask(port, sources, { batchSize: 4 });
assert(rF2.skipped === false && rF2.eventsProcessed === 20, "源变失效→全量重放 20 行");
const fLoss2 = listLoss(port, eventsFile);
assert(fLoss2.length === 3 && fLoss2.every((l) => [3, 9, 15].includes(l.lineNo)), `重放后坏行账仍全在（3 笔同位，修复前重放批间互删同病，实际 ${fLoss2.length}）`);
// ③ 快进不重复
const rF3 = importSessionTask(port, sources, { batchSize: 4 });
assert(rF3.skipped === true && rF3.eventsProcessed === 0 && listLoss(port, eventsFile).length === 3, "三源命中→快进零写入，loss 不重复落（仍 3）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "多批重放后零悬空 FK");

port.close();
rmSync(dataDir, { recursive: true, force: true });

console.log(`Import session-task: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
