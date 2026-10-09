// ---------- M1-1 地基收口：全生命周期故障注入套件（M11-H1） ----------
// 七场景轴（任务书对号）：①建库冷启动 ②迁移幂等 ③events 断点续跑逐字节等价 ④重启幂等
// skipped 零重写 ⑤断电模拟事务原子性（events 批+acceptance 域清重灌两处）⑥loss 台账全生命
// 周期不丢不重 ⑦六域投影重建金值。
//
// 建库主路径纪律：冷启动/续跑恢复/重启幂等全走 read-mode.ts 聚合入口 ensureStore
// （open→migrate→importAllForShadow）——不自拼导入序列。故障注入无法经 ensureStore（其内部
// createSqlitePort 不可注入）——按任务书钦定手法 wrap port 实例（FaultPort，测试侧手段，
// 源件零触碰）直接驱动导入器构造「断电现场」，恢复后回到 ensureStore 主路径收口。
//   · 断点续跑现场（轴③）：独立 dataDir 副本上先直跑 importOrg 预置归因锚（否则续跑侧
//     session 归因与金值结构不等），再以 batchSize=4 小批驱动 importSessionTask、FaultPort
//     在批 3 首行（s-3 INSERT）引爆→批 3 整体回滚=「首跑中途终止」真实崩现场（checkpoint
//     停批 2 尾）→关闭连接模拟进程死亡→重开 ensureStore 续跑→终态与一次性全量导入
//     （主库金值快照）逐字节等价。
//   · 断电原子性现场（轴⑤）：events 批=上同一处（批 3 行全不在=无半批态）；acceptance 域清
//     重灌=改源失效后 FaultPort 在第 2 张 sheet INSERT 引爆→单事务整体回滚（DELETE+重灌+
//     loss 清+checkpoint 全在同一事务）→旧快照完好→恢复重跑采新源。
// 金值口径：snapshotData=15 数据表全行 SELECT * ORDER BY rowid（插入序确定→rowid 确定）；
// loss 台账比元组集（created_at 是 Date.now() 墙钟，跨库排除；同库重启幂等断言含 created_at
// ——被重写即变，是「零重写」的最强证词）；checkpoint 比五元组（路径归一根目录）。
// 跑法：env -u CCR_TOKEN -u CCR_PORT -u CCR_DATA_DIR -u CCR_ORG_DIR npx tsx scripts/test-m1-foundation.ts
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import type { StoragePort } from "../src/storage/port.js";
import { ensureStore, importAllForShadow, projectGroupsFromDb, dispatchEntriesFromDb, resetReadModeForTest, type ReadModeDirs } from "../src/storage/read-mode.js";
import { importOrg } from "../src/storage/import-org.js";
import { importSessionTask } from "../src/storage/import-session-task.js";
import { importAcceptance } from "../src/storage/import-acceptance.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ---------- 故障注入端口：wrap StoragePort，trip 命中即抛（测试侧手段，源件零触碰） ----------
class FaultPort implements StoragePort {
  constructor(private inner: StoragePort, private trip: (sql: string, params: unknown[] | undefined) => boolean) {}
  get path(): string { return this.inner.path; }
  get isOpen(): boolean { return this.inner.isOpen; }
  open(): void { this.inner.open(); }
  close(): void { this.inner.close(); }
  begin(): void { this.inner.begin(); }
  commit(): void { this.inner.commit(); }
  rollback(): void { this.inner.rollback(); }
  query<T>(sql: string, params?: unknown[]): T[] { return this.inner.query<T>(sql, params); }
  exec(sql: string, params?: unknown[]): void {
    if (this.trip(sql, params)) throw new Error(`[FaultPort] 注入故障引爆（测试侧 wrap）: ${sql.slice(0, 50)}`);
    this.inner.exec(sql, params);
  }
}

// ---------- 0. 启动前纪律（env 五清+显式注入——G1 教训：未注入时 resolveDirs 兜底 cwd/data） ----------
const root = mkdtempSync(join(tmpdir(), "cc-m1-foundation-"));
delete process.env.CCR_STORAGE_READ_MODE; // 本套件直调 ensureStore/importAllForShadow，读模式档位不参与
const dataDir = join(root, "data");
const orgDir = join(root, "org");
const dataDirC = join(root, "dataC"); // 断点续跑实验库（fixture 副本）
const tasksDir = join(dataDir, "tasks");
const accDir = join(dataDir, "acceptances");
const boardsDir = join(orgDir, "boards");
for (const d of [dataDir, orgDir, join(tasksDir, "s-1"), accDir, boardsDir]) mkdirSync(d, { recursive: true });
process.env.CCR_DATA_DIR = dataDir;
process.env.CCR_ORG_DIR = orgDir;
console.log("临时目录纪律:");
assert(root.startsWith(tmpdir()) && !root.startsWith(process.env.HOME ?? "~"), "fixture 根落 tmpdir 且不在生产 HOME 下（零生产触达前提）");
assert(process.env.CCR_DATA_DIR === dataDir && process.env.CCR_ORG_DIR === orgDir, "CCR_DATA_DIR/CCR_ORG_DIR 显式注入 fixture（resolveDirs 兜底不落 cwd/data）");
assert(!existsSync(join(dataDir, "cc-deck.sqlite3")), "冷启动前提：dataDir 无库文件（真·零库）");

// ---------- fixture（G2 六域造态形态复用；events 扩 12 行供小批分批） ----------
const T = 1760000000000;
const hex = (ch: string): string => ch.repeat(32);
const ev = (seq: number, sid: string, ts: number, type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ seq, session_id: sid, ts, type, payload });

writeFileSync(join(orgDir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "s-leader", created_at: T }, null, 2) + "\n");
const g1 = { id: "g-1", name: "serious", anchor_dir: "/fx/serious", status: "active", tier: "正经立项", headcount: [{ session_id: "s-1", role: "coder" }], role_defaults: { coder: { model: "sonnet" } }, single_card: false, created_at: T + 1, updated_at: T + 2 };
const gBad = { id: "g-bad", name: "bad", anchor_dir: "/fx/bad", status: "zombie", tier: "正经立项", headcount: [], single_card: false, created_at: T + 3, updated_at: T + 4 };
writeFileSync(join(orgDir, "projects.json"), JSON.stringify({ trust_light: false, groups: [g1, gBad] }, null, 2) + "\n");
writeFileSync(join(orgDir, "confirms.json"), JSON.stringify({ confirms: [] }, null, 2) + "\n");

// events 12 行：坏行行 3（bad-json，批 1）/行 8（缺 session_id，批 2）；s-3 的 CREATED 在行 9=批 3 首行（FaultPort 引爆点）
writeFileSync(join(dataDir, "events.ndjson"), [
  ev(1, "s-1", T + 1, "SESSION_CREATED", { cwd: "/fx/serious", model: "sonnet", relay_session_id: "rs-1", initial_prompt: "p" }),
  ev(2, "s-1", T + 2, "SESSION_WAITING", {}),
  '{"broken',
  ev(4, "s-1", T + 4, "SESSION_DONE", { done_reason: "finish" }),
  ev(5, "s-2", T + 5, "SESSION_CREATED", { cwd: "/fx/serious", model: "sonnet" }),
  ev(6, "s-2", T + 6, "SESSION_LOG", { kind: "tool_use", text: "x", tool: "Read" }),
  ev(7, "s-2", T + 7, "SESSION_WAITING", {}),
  JSON.stringify({ seq: 8, ts: T + 8, type: "SESSION_CREATED", payload: {} }), // 缺 session_id
  ev(9, "s-3", T + 9, "SESSION_CREATED", { cwd: "/fx/serious", model: "sonnet" }),
  ev(10, "s-3", T + 10, "SESSION_DONE", { done_reason: "ok" }),
  ev(11, "s-4", T + 11, "SESSION_CREATED", { cwd: "/fx/serious", model: "sonnet" }),
  ev(12, "s-4", T + 12, "SESSION_WAITING", {}),
].join("\n") + "\n");

const taskDoc = (id: string, subject: string | undefined, status: string): string =>
  JSON.stringify(subject === undefined ? { id, description: "d", status, blocks: [], blockedBy: [] } : { id, subject, description: "d", status, blocks: [], blockedBy: [] });
writeFileSync(join(tasksDir, "s-1", "t1.json"), taskDoc("1", "任务一", "pending") + "\n");
writeFileSync(join(tasksDir, "s-1", "t2.json"), taskDoc("2", "任务二", "in_progress") + "\n");
writeFileSync(join(tasksDir, "s-1", "t3.json"), taskDoc("3", "任务三", "completed") + "\n");
writeFileSync(join(tasksDir, "s-1", "t6.json"), taskDoc("6", "词表外", "blocked") + "\n");
writeFileSync(join(tasksDir, "s-1", "t8.json"), taskDoc("8", undefined, "pending") + "\n");

writeFileSync(join(orgDir, "dispatch-log.ndjson"), [
  { ts: T + 50, id: "disp-1", tier: "正经立项", target: "s-1", status: "dispatched", session_id: "s-leader", actor: "user" },
  { ts: T + 51, id: "disp-1", tier: "正经立项", target: "s-1", status: "running", session_id: "s-leader" },
  { ts: T + 52, id: "disp-1", tier: "正经立项", target: "s-1", status: "done", receipt: "收口ok", session_id: "s-leader", actor: "user" },
  { ts: T + 53, id: "disp-2", tier: "咨询", target: "s-leader", status: "dispatched", session_id: "s-leader" },
  { ts: T + 60, id: "disp-3", tier: "正经立项", target: "s-1", status: "done", session_id: "s-leader" },
  { ts: T + 70, id: "disp-3", tier: "正经立项", target: "s-1", status: "dispatched", session_id: "s-leader", actor: "user" },
  { ts: T + 71, id: "disp-3", tier: "正经立项", target: "s-1", status: "running", session_id: "s-leader" },
  { ts: T + 80, status: "dispatched", tier: "咨询", target: "s-x", session_id: "s-leader" },
].map((l) => JSON.stringify(l)).join("\n") + "\n");

writeFileSync(join(boardsDir, "g-1.json"), JSON.stringify({
  gid: "g-1",
  entries: [
    { id: "e-done", text: "已完成卡", ts: T + 43, updated_at: T + 43, title: "已完成卡", status: "done" },
    { id: "e-a", text: "无依赖卡", ts: T + 43, updated_at: T + 43, title: "无依赖卡", status: "todo" },
    { id: "e-b", text: "依赖全 done", ts: T + 43, updated_at: T + 43, title: "依赖全 done", status: "doing", depends_on: ["e-done"] },
  ],
  lessons: [
    { id: "l-1", text: "经验一", tags: ["react", "p1"], ts: T + 40 },
    { id: "l-2", text: "经验二", tags: ["p2"], ts: T + 41, source_dispatch_id: "disp-1" },
  ],
  frozen: false, updated_at: T + 42,
}, null, 2) + "\n");

writeFileSync(join(dataDir, "notifications.json"), JSON.stringify({ notifications: [
  { key: "k-1", kind: "org-confirm", group: "action", severity: "waiting", title: "确认单等批", body: "b1",
    sourceContext: { domain: "org", entityId: "g-1", sessionId: "s-1" }, actionable: true, created_at: T + 90,
    client_states: [{ client_id: "phone", read_at: T + 91 }, { client_id: "desktop", read_at: T + 92, dismissed_at: T + 93 }] },
  { key: "k-2", kind: "org-confirm", group: "action", severity: "waiting", title: "确认单二", body: "b2",
    sourceContext: { domain: "org", entityId: "g-1" }, actionable: true, created_at: T + 94 },
  { key: "k-bad", created_at: T + 95 },
] }, null, 2) + "\n");
writeFileSync(join(dataDir, "decision-notifications.json"), JSON.stringify([
  { key: "k-1", kind: "decision", source_session_id: "s-1", created_at: T + 96, first_sent_at: T + 96, group: "action", actionable: true, revision: 1 },
  { key: "k-4", kind: "decision", source_session_id: "s-1", created_at: T + 97, first_sent_at: T + 97, group: "action", actionable: true, revision: 1 },
], null, 2) + "\n");

writeFileSync(join(accDir, `${hex("a")}.json`), JSON.stringify({
  id: hex("a"), title: "验收单一", created_at: T + 100, cwd: "/fx/serious",
  rows: [{ task: "t1", item: "项一", criteria: "标准一" }, { task: "t2", item: "项二", criteria: "标准二" }],
}, null, 2) + "\n");
writeFileSync(join(accDir, `${hex("b")}.json`), JSON.stringify({
  id: hex("c"), title: "doc.id 优先单", created_at: T + 101, cwd: "/fx/serious",
  rows: [{ task: "t3", item: "项三", criteria: "标准三" }],
}, null, 2) + "\n");
writeFileSync(join(accDir, `${hex("d")}.json`), "{oops 坏 json\n");
writeFileSync(join(accDir, `${hex("c")}.results.json`), JSON.stringify({
  history: [{ at: T + 110, ua: "user-x", rows: [{ i: 0, verdict: "pass", note: "ok" }] }],
}, null, 2) + "\n");

writeFileSync(join(dataDir, "deliverables.json"), JSON.stringify([
  { sid: "s-1", path: "/repo/out/deck.html", ts: T + 120 },
  { sid: "s-1", path: "/repo/out/notes.md", ts: T + 121 },
  { sid: "s-1", path: "/repo/other/x.md", ts: T + 122 },
  { path: "/repo/orphan/y.md", ts: T + 123 },
], null, 2) + "\n");

const dirsA: ReadModeDirs = { dataDir, orgDir, tasksDir };
const tasksDirC = join(dataDirC, "tasks");
const accDirC = join(dataDirC, "acceptances");
const dirsC: ReadModeDirs = { dataDir: dataDirC, orgDir, tasksDir: tasksDirC };
const eventsC = join(dataDirC, "events.ndjson");

// ---------- 快照/金值工具 ----------
const DATA_TABLES = [
  "project", "member", "group", "group_member", "session", "task", "dispatch", "lesson", "org_confirm",
  "acceptance_sheet", "acceptance_item", "acceptance_result", "artifact", "notification", "notification_client_state",
] as const;
const ALL_18 = [...DATA_TABLES, "import_checkpoint", "import_loss", "permission_audit"]; // v3+permission_audit（P81-5）
function tableNames(port: StoragePort): string[] {
  return port.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
}
function snapshotData(port: StoragePort): string {
  const out: Record<string, unknown> = {};
  for (const t of DATA_TABLES) out[t] = port.query(`SELECT * FROM "${t}" ORDER BY rowid`);
  return JSON.stringify(out);
}
function normPath(p: string, base: string): string { return p.startsWith(base) ? `<fx>${p.slice(base.length)}` : p; }
/** 跨库归一：dataC 实验副本与主库同构 fixture——路径/内嵌 excerpt 里的 dataC 段先折回 data 再比。 */
function crossDbNorm(s: string, base: string, dataC: string, data: string): string {
  return normPath(s.split(join(dataC, "x")).join(join(data, "x")).split(dataC).join(data), base);
}
function lossSet(port: StoragePort, base: string): string[] {
  return port.query<{ source_path: string; line_no: number; reason: string; excerpt: string }>(
    "SELECT source_path, line_no, reason, excerpt FROM import_loss",
  ).map((l) => JSON.stringify([crossDbNorm(l.source_path, base, dataDirC, dataDir), l.line_no, l.reason, crossDbNorm(l.excerpt, base, dataDirC, dataDir)])).sort();
}
function lossWithTs(port: StoragePort): string[] {
  return port.query<{ source_path: string; line_no: number; reason: string; excerpt: string; created_at: number }>(
    "SELECT source_path, line_no, reason, excerpt, created_at FROM import_loss",
  ).map((l) => JSON.stringify([l.source_path, l.line_no, l.reason, l.excerpt, l.created_at])).sort();
}
function cpSet(port: StoragePort, base: string): string[] {
  return port.query<{ path: string; mtime_ms: number; line_count: number; line_offset: number; schema_version: number }>(
    "SELECT path, mtime_ms, line_count, line_offset, schema_version FROM import_checkpoint",
  ).map((r) => JSON.stringify([crossDbNorm(r.path, base, dataDirC, dataDir), r.mtime_ms, r.line_count, r.line_offset, r.schema_version])).sort();
}
function throwOf(run: () => unknown): string {
  try { run(); } catch (err) { return err instanceof Error ? err.message : String(err); }
  return "";
}

try {
  // ---------- 轴① 建库冷启动：零库 dataDir → ensureStore 聚合入口 → 18 表+六域+checkpoint ----------
  console.log("轴① 建库冷启动:");
  const port = ensureStore(dirsA);
  assert(port.isOpen && port.path === join(dataDir, "cc-deck.sqlite3"), `ensureStore 打开聚合库 ${port.path.split("/").pop()}`);
  assert(ensureStore(dirsA) === port, "ensureStore 单例缓存：同 dirs 二次调用返回同 port（不重开）");
  const tabs = tableNames(port);
  assert(ALL_18.every((t) => tabs.includes(t)), `18 表全在（15 baseline+checkpoint+loss+permission_audit；缺=${ALL_18.filter((t) => !tabs.includes(t)).join(",") || "无"}）`);
  const n = (sql: string, params?: unknown[]): number => port.query<{ n: number }>(sql, params)[0]?.n ?? -1;
  const gN = n(`SELECT COUNT(*) AS n FROM "group"`);
  const pN = n("SELECT COUNT(*) AS n FROM project");
  assert(gN === 1 && pN === 1 && n("SELECT COUNT(*) AS n FROM org_confirm") === 0, `org 域落库：1 组 1 项目（confirms 空源零行；实际组=${gN} 项目=${pN}）`);
  assert(n("SELECT COUNT(*) AS n FROM member") === 2 && n("SELECT COUNT(*) AS n FROM group_member") === 1, `成员面落库：headcount 1 条+Leader 自动建行→member 2 行/group_member 1 行（g-bad 拒入；实际 member=${n("SELECT COUNT(*) AS n FROM member")} gm=${n("SELECT COUNT(*) AS n FROM group_member")}）`);
  assert(n("SELECT COUNT(*) AS n FROM session") === 4 && n("SELECT COUNT(*) AS n FROM task") === 3, "session-task 域落库：4 会话（12 行事件收敛）+3 任务（t6/t8 拒入）");
  assert(n("SELECT COUNT(*) AS n FROM dispatch") === 4 && n("SELECT COUNT(*) AS n FROM lesson") === 2, "dispatch/lesson 域落库：disp-1×1+disp-2×1+disp-3 两段=4 行；lesson 2 条");
  assert(n("SELECT COUNT(*) AS n FROM notification") === 3 && n("SELECT COUNT(*) AS n FROM notification_client_state") === 2, "notification 域落库：k-1 归并+k-2+k-4=3 行+client_state 2 行");
  assert(n("SELECT COUNT(*) AS n FROM acceptance_sheet") === 2 && n("SELECT COUNT(*) AS n FROM acceptance_item") === 3 && n("SELECT COUNT(*) AS n FROM acceptance_result") === 1, "acceptance 域落库：2 单 3 项 1 判定（坏 JSON 单拒入）");
  assert(n("SELECT COUNT(*) AS n FROM artifact") === 3, "artifact 域落库：deliverables 3 好行（orphan 拒入）");
  const cps = cpSet(port, root);
  const wantCp = [join(orgDir, "org.json"), join(orgDir, "projects.json"), join(orgDir, "confirms.json"), join(dataDir, "events.ndjson"), tasksDir, accDir, join(orgDir, "dispatch-log.ndjson"), boardsDir, join(dataDir, "notifications.json"), join(dataDir, "decision-notifications.json"), join(dataDir, "deliverables.json")];
  assert(wantCp.every((p) => cps.some((c) => (JSON.parse(c) as [string])[0] === normPath(p, root))), "checkpoint 全写：org3+events+tasks+accept+dispatch+boards+通知双源+deliverables ≥11 源全落位");

  // 金值快照（轴③④⑤⑥ 的等价基准=一次性全量导入终态）
  const gold = snapshotData(port);
  const goldLoss = lossSet(port, root);
  const goldCpA = cpSet(port, root);

  // ---------- 轴② 迁移幂等：已迁库重跑零变化 + 空库直跑全量 DDL ----------
  console.log("轴② 迁移幂等:");
  const masterBefore = JSON.stringify(port.query("SELECT name, sql FROM sqlite_master ORDER BY name"));
  const re = runMigrations(port, migrations);
  assert(re.applied.length === 0 && re.from === 3 && re.to === 3, `已迁库重跑零迁移（applied=[]，from/to=3，实际 applied=${JSON.stringify(re.applied)}）`);
  assert(JSON.stringify(port.query("SELECT name, sql FROM sqlite_master ORDER BY name")) === masterBefore && (port.query<Record<string, number>>("PRAGMA user_version")[0]?.user_version) === 3, "重跑后 schema 零变化（sqlite_master 全等+user_version=3）");
  const emptyPort = createSqlitePort({ dataDir, filename: "empty-migrate.sqlite3" });
  emptyPort.open();
  const reEmpty = runMigrations(emptyPort, migrations);
  assert(JSON.stringify(reEmpty.applied) === "[1,2,3]" && ALL_18.every((t) => tableNames(emptyPort).includes(t)), "空库直跑全量 DDL：applied=[1,2,3] 且 18 表全建");
  emptyPort.close();

  // ---------- 轴③+⑤a 断点续跑+events 批原子性（独立库实验场，恢复走 ensureStore 主路径） ----------
  console.log("轴③+⑤a 断点续跑与批原子性:");
  resetReadModeForTest(); // 关缓存连接（G2 发现⑤）——实验库独立于主库文件
  cpSync(dataDir, dataDirC, { recursive: true, preserveTimestamps: true, filter: (s) => !s.endsWith(".sqlite3") && !s.includes(".sqlite3-") }); // 只拷源文件不拷库；保 mtime（task 行 ts=源文件 mtime，副本失时戳即快照不等）
  const portC = createSqlitePort({ dataDir: dataDirC });
  portC.open();
  runMigrations(portC, migrations);
  importOrg(portC, orgDir); // 预置归因锚（否则续跑侧 session 归因与金值结构不等——实验场 setup）
  let sheetInserts = 0;
  const fault = new FaultPort(portC, (sql, params) => sql.startsWith("INSERT OR REPLACE INTO session") && params?.[0] === "s-3");
  const boomMsg = throwOf(() => importSessionTask(fault, { eventsFile: eventsC, tasksDir: tasksDirC, acceptanceDir: accDirC }, { batchSize: 4 }));
  assert(boomMsg.includes("批处理失败已回滚"), `FaultPort 引爆：批 3 首行（s-3）抛错→importSessionTask 回滚上抛（${boomMsg.slice(0, 40)}…）`);
  // 断电原子性（轴⑤a）：批 3（行 9-12）整体不在=无半批态；批 1/2 已提交行在
  const q = <T>(sql: string, params?: unknown[]): T[] => portC.query<T>(sql, params);
  const cn = (sql: string, params?: unknown[]): number => q<{ n: number }>(sql, params)[0]?.n ?? -1;
  assert(cn("SELECT COUNT(*) AS n FROM session") === 2, "批事务原子性：崩批整体缺席（s-1/s-2 在=前两批已提交，s-3/s-4 全不在=批 3 四行全回滚，无半批态）");
  const cpRow = q<{ line_offset: number; line_count: number }>("SELECT line_offset, line_count FROM import_checkpoint WHERE path = ?", [eventsC])[0];
  assert(cpRow !== undefined && cpRow.line_offset === 8 && cpRow.line_count === 12, `checkpoint 停批 2 尾（offset=8/lineCount=12，实际 offset=${cpRow?.line_offset}）——中断态=真崩现场`);
  assert(cn("SELECT COUNT(*) AS n FROM import_loss WHERE source_path = ? AND line_no IN (3, 8)", [eventsC]) === 2, "崩前两批坏行账已提交在案（行 3 bad-json+行 8 missing-field）");
  // 恢复：关闭连接（模拟进程死亡）→重开 ensureStore 续跑（checkpoint 五元组自洽仅 offset 落后→增量续行）
  portC.close();
  resetReadModeForTest();
  const portCr = ensureStore(dirsC);
  assert(cn2(portCr, "SELECT COUNT(*) AS n FROM session") === 4, "重开 ensureStore 续跑：余下行 9-12 增量续入（4 会话齐）");
  const snapC = snapshotData(portCr);
  if (snapC !== gold) {
    for (const t of DATA_TABLES) {
      const a = (JSON.parse(gold) as Record<string, unknown>)[t];
      const b = (JSON.parse(snapC) as Record<string, unknown>)[t];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const ra = a as Record<string, unknown>[];
        const rb = b as Record<string, unknown>[];
        console.error(`  [diag] 表 ${t} 行数 gold=${ra.length} C=${rb.length}`);
        const sa = JSON.stringify(a);
        const sb = JSON.stringify(b);
        let di = 0;
        while (di < Math.min(sa.length, sb.length) && sa[di] === sb[di]) di++;
        console.error(`    首异@${di}: gold[±90]=${sa.slice(Math.max(0, di - 90), di + 90)}\n              C库[±90]=${sb.slice(Math.max(0, di - 90), di + 90)}`);
        for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
          if (JSON.stringify(ra[i]) !== JSON.stringify(rb[i])) {
            const keys = [...new Set([...Object.keys(ra[i] ?? {}), ...Object.keys(rb[i] ?? {})])];
            const diff = keys.filter((k) => JSON.stringify(ra[i]?.[k]) !== JSON.stringify(rb[i]?.[k]));
            console.error(`    行${i} 差异列 ${JSON.stringify(diff)}: gold=${JSON.stringify(diff.map((k) => [k, ra[i]?.[k]]))} C=${JSON.stringify(diff.map((k) => [k, rb[i]?.[k]]))}`);
          }
        }
      }
    }
  }
  assert(snapC === gold, "轴③ 收口：续跑终态与一次性全量导入逐字节等价（15 表全行快照=金值）");
  const lossC = lossSet(portCr, root);
  if (JSON.stringify(lossC) !== JSON.stringify(goldLoss)) {
    console.error(`  [diag] loss 差异: gold=${JSON.stringify(goldLoss)}\n         C库=${JSON.stringify(lossC)}`);
  }
  assert(JSON.stringify(lossC) === JSON.stringify(goldLoss), "轴⑥ 前哨：断点续跑后 loss 元组集=金值（崩前两账+续跑零重复）");

  // ---------- 轴⑤b acceptance 域清重灌事务原子性（主库，改源失效+批中引爆+恢复采新） ----------
  console.log("轴⑤b 域清重灌原子性:");
  resetReadModeForTest();
  const portA = ensureStore(dirsA);
  const aSheetFile = join(accDir, `${hex("a")}.json`);
  writeFileSync(aSheetFile, JSON.stringify({
    id: hex("a"), title: "验收单一", created_at: T + 100, cwd: "/fx/serious",
    rows: [{ task: "t1", item: "项一", criteria: "标准一" }, { task: "t2", item: "项二", criteria: "标准二" }, { task: "t3", item: "项三改", criteria: "标准三改" }],
  }, null, 2) + "\n");
  utimesSync(aSheetFile, new Date(statSync(aSheetFile).mtimeMs + 5000), new Date(statSync(aSheetFile).mtimeMs + 5000)); // bump 5s：远超 mtime 精度/落盘竞态窗——bump 后观测值必须稳定
  const cpAcceptBefore = portA.query<{ line_count: number }>("SELECT line_count FROM import_checkpoint WHERE path = ?", [accDir])[0];
  const lossTsBefore = lossWithTs(portA);
  const portA2 = createSqlitePort({ dataDir, filename: "cc-deck.sqlite3" });
  portA2.open();
  let sheetInsertsB = 0;
  const faultB = new FaultPort(portA2, (sql) => { if (sql.startsWith("INSERT INTO acceptance_sheet")) { sheetInsertsB++; return sheetInsertsB === 2; } return false; });
  const boomB = throwOf(() => importAcceptance(faultB, accDir));
  assert(boomB.includes("注入故障引爆"), `第二张 sheet INSERT 处引爆（事务内 DELETE 域清+首单 INSERT 已执行后，${boomB.slice(0, 30)}…）`);
  portA2.close();
  assert(cn2(portA, "SELECT COUNT(*) AS n FROM acceptance_sheet") === 2 && cn2(portA, "SELECT COUNT(*) AS n FROM acceptance_item") === 3
    && cn2(portA, "SELECT COUNT(*) AS n FROM acceptance_result") === 1, "域清重灌原子性：引爆后旧快照完好（2 单 3 项 1 判定零变化=DELETE+半程 INSERT 全回滚，无半灌态）");
  assert(JSON.stringify(lossWithTs(portA)) === JSON.stringify(lossTsBefore), "loss 账未被重写（含 created_at 逐条全等——账清也在同一回滚事务内）");
  const cpAcceptAfter = portA.query<{ line_count: number }>("SELECT line_count FROM import_checkpoint WHERE path = ?", [accDir])[0];
  assert(cpAcceptAfter?.line_count === cpAcceptBefore?.line_count, "checkpoint 写入同被回滚（旧五元组原样）");
  resetReadModeForTest();
  const portAr = ensureStore(dirsA);
  assert(cn2(portAr, "SELECT COUNT(*) AS n FROM acceptance_item") === 4, "故障恢复重跑：失效域重灌采新源（验收单甲第三行入 item=4）");
  const it3 = portAr.query<{ task: string; item: string }>("SELECT task, item FROM acceptance_item WHERE sheet_id = ? AND item_index = 3", [hex("a")])[0];
  assert(it3?.task === "t3" && it3?.item === "项三改", "重灌内容精确（item_index=3=t3/项三改，数组序口径）");
  assert(cn2(portAr, "SELECT COUNT(*) AS n FROM acceptance_sheet") === 2 && cn2(portAr, "SELECT COUNT(*) AS n FROM acceptance_result") === 1, "重灌无残留面（单/判定行数不增，坏 JSON 单仍拒入）");
  const lossAfterB = lossSet(portAr, root);
  assert(JSON.stringify(lossAfterB) === JSON.stringify(goldLoss), "轴⑥ 前哨：域清重灌+恢复后 loss 元组集仍=金值（清旧重落不丢不重）");

  // ---------- 轴④ 重启幂等：close→重开 ensureStore→skipped 零重写 ----------
  console.log("轴④ 重启幂等:");
  const dataBefore = snapshotData(portAr);
  const lossTsBefore4 = lossWithTs(portAr);
  resetReadModeForTest();
  const portR = ensureStore(dirsA);
  const fails = importAllForShadow(portR, dirsA); // 幂等双调：聚合面再跑一轮（checkpoint 全命中=近零开销）
  assert(fails.length === 0, `聚合入口重跑零域失败（checkpoint 全命中，实际 ${JSON.stringify(fails)}）`);
  const dataAfter = snapshotData(portR);
  if (dataAfter !== dataBefore) {
    for (const t of DATA_TABLES) {
      const a = JSON.stringify((JSON.parse(dataBefore) as Record<string, unknown>)[t]);
      const b = JSON.stringify((JSON.parse(dataAfter) as Record<string, unknown>)[t]);
      if (a !== b) console.error(`  [diag] 表 ${t} 重启差异:\n    前=${a.slice(0, 300)}\n    后=${b.slice(0, 300)}`);
    }
  }
  assert(dataAfter === dataBefore, "重启后 15 表全行快照逐字节不变（skipped 路径零重写实证——重放同源同值数据面不变）");
  // 零重写分两层断言。单消费者六源（events/org×3/dispatch/boards/notifications×2/deliverables
  // ——checkpoint 行只归一家导入器读写）loss 含 created_at 逐字节不变=skipped 真·零重写。
  // tasks/acceptances 双域原受发现清单 D1（已修复，M11-D1FIX checkpoint 分键）：import_checkpoint
  // 的 accDir 行曾被两个导入器共用，而两家的 observeAcceptanceDir 观测口径不同——import-session-task
  // 内部版排除 *.results.json（count=3），import-acceptance 版包含（fileCount=4）→同 path 互写
  // 五元组互使对方失效→每次 ensureStore 恒双域重写。分键（session-task 侧 #tasks-view 后缀）后
  // 两域各保原判定语义、互不干扰——重启幂等对双域恢复。
  const SINGLE_CONSUMER = ["events.ndjson", "org.json", "projects.json", "confirms.json", "dispatch-log.ndjson", "boards", "notifications.json", "decision-notifications.json", "deliverables.json"];
  const inStable = (s: string): boolean => SINGLE_CONSUMER.some((f) => s.includes(`/${f}"`));
  const lossStableBefore = lossTsBefore4.filter(inStable);
  const lossStableAfter = lossWithTs(portR).filter(inStable);
  // D1 位移量=重启后双域账与重启前快照的差集（串含 created_at，清重落即刷新=串变=位移；
  // 修复前每次重启 3 条全位移，分键后零位移）——账本身持久在库，不能数存量条数
  const inD1 = (s: string): boolean => s.includes(`"${tasksDir}"`) || s.includes(`"${accDir}"`);
  const d1After = lossWithTs(portR).filter(inD1);
  const d1Touched = d1After.filter((s) => !lossTsBefore4.includes(s)).length;
  assert(JSON.stringify(lossStableAfter) === JSON.stringify(lossStableBefore),
    `单消费者六源 loss 含 created_at 逐字节不变（${lossStableAfter.length} 条）——零重写最强证词（被重写即变）`);
  assert(d1Touched === 0 && d1After.length > 0, `发现清单 D1 重启幂等恢复：tasks/acceptances 双域账 created_at 零位移（${d1After.length} 条全等——修复前每次重启 3 条位移，checkpoint 分键后双域恒重写消除）`);

  // ---------- 轴⑥ loss 台账全生命周期：首跑/断点续跑/断电重试三路径不丢不重 ----------
  console.log("轴⑥ loss 全生命周期:");
  const evLoss = portR.query<{ line_no: number; reason: string }>("SELECT line_no, reason FROM import_loss WHERE source_path = ?", [join(dataDir, "events.ndjson")])
    .map((l) => `${l.line_no}:${l.reason}`).sort();
  assert(JSON.stringify(evLoss) === JSON.stringify(["3:bad-json", "8:missing-field"]), `events 源坏行账全生命周期精确（${JSON.stringify(evLoss)}——行 3/8 跨批内存活）`);
  const allLoss = lossWithTs(portR);
  assert(new Set(allLoss).size === allLoss.length, `全库 loss 零重复落账（${allLoss.length} 条唯一）`);
  const lossA = lossSet(portR, root);
  const portCr2 = ensureStore(dirsC); // 轴④ 的 reset 已清 C 项缓存——此处直接新开活连接，portR 不受扰
  const stageB = lossSet(portCr2, root); // 轴③ 续跑库
  assert(JSON.stringify(stageB) === JSON.stringify(lossA), "跨库三路径 loss 元组集全等（首跑金值=断点续跑=断电重试+恢复，两库同 fixture）");
  assert(allLoss.length >= 6, `坏行面覆盖广度（${allLoss.length} 条：org/task/events/dispatch/notification/acceptance/artifact 各域坏行在案）`);

  // ---------- 轴⑦ 六域投影重建金值（SQLite current state → 三端读面） ----------
  console.log("轴⑦ 六域投影重建:");
  // 组列表：projectGroupsFromDb（web/console 组卡读面）
  const groups = projectGroupsFromDb(portR);
  assert(groups.length === 1 && groups[0]?.id === "g-1" && groups[0]?.tier === "正经立项" && groups[0]?.status === "active"
    && groups[0]?.single_card === false && JSON.stringify(groups[0]?.headcount) === JSON.stringify([{ session_id: "s-1", role: "coder" }]),
    "组列表投影：g-1 全字段金值（tier/status/single_card/headcount 直还），g-bad 不投影");
  // 派单流：dispatchEntriesFromDb（段链收敛+receipt）
  const disp = dispatchEntriesFromDb(portR);
  const d1 = disp.find((d) => d.id === "disp-1");
  const d3 = disp.find((d) => d.id === "disp-3");
  assert(disp.length === 3 && d1?.status === "done" && d1?.receipt === "收口ok" && d1?.ts === T + 52, "派单流投影：disp-1 三行链收敛单条（done+receipt=收口ok@T+52）");
  assert(d3?.status === "running" && d3?.ts === T + 71 && d3?.receipt === undefined, "派单流投影：disp-3 终态后重投收敛=末段末行（running@T+71，无 receipt 不带键）");
  assert(portR.query<{ n: number }>("SELECT COUNT(*) AS n FROM dispatch WHERE id LIKE 'disp-3%'")[0]?.n === 2, "段链存储语义：disp-3 表侧两段（原段+重投段）——投影收敛不销毁审计面");
  // 任务板语义锁（G2 computeReady 已覆盖板读面——此处引用口径锁表侧 status/review 映射不重复造）
  const t3row = portR.query<{ status: string; review_required: number }>("SELECT status, review_required FROM task WHERE external_task_file_id = 't3'")[0];
  assert(portR.query<{ status: string }>("SELECT status FROM task WHERE external_task_file_id = 't1'")[0]?.status === "backlog"
    && portR.query<{ status: string }>("SELECT status FROM task WHERE external_task_file_id = 't2'")[0]?.status === "claimed"
    && t3row?.status === "submitted" && t3row?.review_required === 1,
    "任务板表侧语义锁（G2 computeReady 口径引用）：pending→backlog/in_progress→claimed/completed+验收命中→submitted+review_required=1");
  // 通知（含 client_state）
  const k1 = portR.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification WHERE condition_key = 'k-1'")[0]?.n;
  const csK1 = portR.query<{ client_id: string; read_at: number; dismissed_at: number | null }>(
    "SELECT s.client_id, s.read_at, s.dismissed_at FROM notification_client_state s JOIN notification n ON s.notification_id = n.id WHERE n.condition_key = 'k-1' ORDER BY s.client_id");
  assert(k1 === 1 && csK1.length === 2 && csK1[0]?.client_id === "desktop" && csK1[0]?.dismissed_at === T + 93 && csK1[1]?.client_id === "phone" && csK1[1]?.read_at === T + 91,
    "通知投影：k-1 跨源归并单行+client_state 双设备（desktop dismissed@T+93/phone read@T+91）");
  // 验收单
  const sheetA = portR.query<{ title: string; created_at: number }>("SELECT title, created_at FROM acceptance_sheet WHERE id = ?", [hex("a")])[0];
  assert(sheetA?.title === "验收单一" && sheetA?.created_at === T + 100
    && portR.query<{ n: number }>("SELECT COUNT(*) AS n FROM acceptance_sheet WHERE id = ?", [hex("b")])[0]?.n === 0
    && portR.query<{ verdict: string; actor: string }>("SELECT r.verdict, r.actor FROM acceptance_result r JOIN acceptance_item i ON r.item_id = i.id WHERE i.sheet_id = ?", [hex("c")])[0]?.verdict === "pass",
    "验收单投影：sheet A 字段金值+doc.id 优先（b stem 不入库）+history 判定 pass 可查");
  // 输出物
  const arts = portR.query<{ normalized_path: string }>("SELECT normalized_path FROM artifact WHERE source_id = 'deliverables' ORDER BY normalized_path").map((r) => r.normalized_path);
  assert(JSON.stringify(arts) === JSON.stringify(["/repo/other/x.md", "/repo/out/deck.html", "/repo/out/notes.md"]), "输出物投影：deliverables 3 行 normalized_path 金值（orphan 拒入）");
  assert(portR.query("PRAGMA foreign_key_check").length === 0, "全库零悬空 FK（生命周期终态）");
} finally {
  resetReadModeForTest();
  delete process.env.CCR_DATA_DIR;
  delete process.env.CCR_ORG_DIR;
  delete process.env.CCR_STORAGE_READ_MODE;
  rmSync(root, { recursive: true, force: true });
}

function cn2(port: StoragePort, sql: string, ...p: unknown[]): number {
  return port.query<{ n: number }>(sql, p)[0]?.n ?? -1;
}

console.log(`M1 foundation: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
