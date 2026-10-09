// M11-B2 导入台账两件套测试：checkpoint 五元组断点续跑 + loss writer 三场景。
// 范式沿用 test-storage（mkdtemp+env 全清+assert 计数+两轮连跑）。
// checkpoint 失效验证用真临时源文件（writeFileSync/utimesSync 模拟源变化），非纯内存假设。
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations, STORAGE_TABLES, IMPORT_LEDGER_TABLES, PERMISSION_AUDIT_TABLES } from "../src/storage/schema.js";
import { writeCheckpoint, readCheckpoint, type CheckpointKey } from "../src/storage/checkpoint.js";
import { appendLoss, listLoss, EXCERPT_MAX, type LossRecord } from "../src/storage/loss-report.js";

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

// ---------- 0. 启动前纪律（验收 4） ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-checkpoint-"));
process.env.CCR_DATA_DIR = dataDir;
const orgDir = join(dataDir, "org");
process.env.CCR_ORG_DIR = orgDir;
console.log("临时目录纪律:");
assert(process.env.CCR_DATA_DIR === dataDir && process.env.CCR_ORG_DIR === orgDir, "CCR_DATA_DIR/CCR_ORG_DIR 均指向临时目录");
assert(dataDir.startsWith(tmpdir()) && orgDir.startsWith(tmpdir()), "两 env 落 tmpdir 前缀下（零生产写入前提）");

const port = createSqlitePort({ dataDir, filename: "ledger.sqlite3" });
port.open();
assert(port.path.startsWith(dataDir), "库文件路径落临时目录内");

function versionOf(p: typeof port): number {
  return p.query<{ user_version: number }>("PRAGMA user_version")[0]?.user_version ?? -1;
}
/** 源文件观测（导入器职责的测试替身）：mtimeMs 取整 + 数行（容许尾随换行）。 */
function statSource(file: string): { mtimeMs: number; lineCount: number } {
  const st = statSync(file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { mtimeMs: Math.round(st.mtimeMs), lineCount: lines.length };
}

// ---------- 1. migrations v1→v3：基线 15 表 + 导入台账 2 表 + 权限审计 1 表（验收 4 选型面） ----------
console.log("迁移落地:");
const r1 = runMigrations(port, migrations);
assert(r1.from === 0 && r1.to === 3 && JSON.stringify(r1.applied) === "[1,2,3]", "fresh 库一次执行 v1→v3（applied=[1,2,3]）");
assert(versionOf(port) === 1 + 2, "user_version=3");
const tables = port.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
assert(tables.length === 18, `18 表全数落地（15 基线 + 2 导入台账 + 1 权限审计，实测 ${tables.length}）`);
assert([...STORAGE_TABLES, ...IMPORT_LEDGER_TABLES, ...PERMISSION_AUDIT_TABLES].sort().join() === [...tables].sort().join(), "表名清单 = 冻结件 15 表 ∪ 导入台账 2 表 ∪ 权限审计 1 表");
assert(
  port.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('import_checkpoint','import_loss')")[0]?.n === 2,
  "import_checkpoint + import_loss 两表在",
);

// ---------- 2. checkpoint 五元组：写入重读全等 + 源变化即失效（验收 1/2） ----------
console.log("checkpoint:");
const SRC_SCHEMA_VERSION = 3; // 导入映射逻辑版本（测试常量）
const srcFile = join(dataDir, "events.ndjson");
const lines10 = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `row-${i + 1}`, text: `t${i + 1}` }));
writeFileSync(srcFile, lines10.join("\n") + "\n");
const obs1 = statSource(srcFile);
assert(obs1.lineCount === 10, "源文件观测：10 行");
const key1: CheckpointKey = { path: srcFile, mtimeMs: obs1.mtimeMs, lineCount: obs1.lineCount, offset: 6, schemaVersion: SRC_SCHEMA_VERSION };
writeCheckpoint(port, key1);
const c1 = readCheckpoint(port, srcFile, { ...obs1, schemaVersion: SRC_SCHEMA_VERSION });
assert(
  c1 !== null && c1.path === key1.path && c1.mtimeMs === key1.mtimeMs && c1.lineCount === key1.lineCount && c1.offset === key1.offset && c1.schemaVersion === key1.schemaVersion,
  "写 checkpoint→重读五元组全等（path/mtime_ms/line_count/offset/schema_version）",
);
assert(readCheckpoint(port, join(dataDir, "no-such.ndjson"), { ...obs1, schemaVersion: SRC_SCHEMA_VERSION }) === null, "无记录路径读得 null");
// 中断续跑：offset=6 → 只处理第 7..10 行，已处理行零重复
const resumeFrom = c1 !== null ? c1.offset + 1 : 1;
const processed: number[] = [];
for (let i = resumeFrom; i <= obs1.lineCount; i++) processed.push(i);
assert(JSON.stringify(processed) === JSON.stringify([7, 8, 9, 10]), "续跑只处理 offset 之后行（7..10）");
assert(new Set(processed).size === processed.length && processed.every((n) => n > 6), "已处理行（1..6）零重复零回扫");
// 源文件变化三路失效：lineCount 变 / mtime 变 / schema_version 变
writeFileSync(srcFile, [...lines10, '{"id":"row-11"}', '{"id":"row-12"}', '{"id":"row-13"}'].join("\n") + "\n");
// 同毫秒内的两次写入在 APFS 上 mtime_ms 可能不动——显式推进 10ms 模拟真实「追加晚于首轮」时序
if (Math.round(statSync(srcFile).mtimeMs) === obs1.mtimeMs) {
  utimesSync(srcFile, new Date(obs1.mtimeMs + 10), new Date(obs1.mtimeMs + 10));
}
const obs2 = statSource(srcFile);
assert(obs2.lineCount === 13 && obs2.mtimeMs !== obs1.mtimeMs, "源文件追加 3 行（lineCount 10→13，mtime 亦变）");
assert(readCheckpoint(port, srcFile, { ...obs2, schemaVersion: SRC_SCHEMA_VERSION }) === null, "lineCount 变化→失效（防错位续跑，从 0 重扫）");
utimesSync(srcFile, new Date(obs2.mtimeMs + 5000), new Date(obs2.mtimeMs + 5000));
const obs3 = statSource(srcFile);
assert(obs3.lineCount === obs2.lineCount && obs3.mtimeMs !== obs2.mtimeMs, "仅 mtime 变（行数不变）");
assert(readCheckpoint(port, srcFile, { ...obs3, schemaVersion: SRC_SCHEMA_VERSION }) === null, "mtime 变化→失效");
assert(readCheckpoint(port, srcFile, { mtimeMs: obs1.mtimeMs, lineCount: 10, schemaVersion: SRC_SCHEMA_VERSION + 1 }) === null, "schema_version 变化→失效（映射逻辑升级不得续跑旧账）");
// 失效后重扫回写覆盖（UPSERT）→ 恢复有效
writeCheckpoint(port, { path: srcFile, mtimeMs: obs3.mtimeMs, lineCount: obs3.lineCount, offset: 0, schemaVersion: SRC_SCHEMA_VERSION });
const c2 = readCheckpoint(port, srcFile, { ...obs3, schemaVersion: SRC_SCHEMA_VERSION });
assert(c2 !== null && c2.offset === 0 && c2.lineCount === 13, "失效重扫回写 offset=0 覆盖旧账（UPSERT）恢复有效");
expectThrow(() => writeCheckpoint(port, { path: srcFile, mtimeMs: obs3.mtimeMs, lineCount: 13, offset: 14, schemaVersion: SRC_SCHEMA_VERSION }), "offset 越界（>lineCount）写入炸（编程错误）");
// 持久：关库重开 checkpoint 仍在
port.close();
const port2 = createSqlitePort({ dataDir, filename: "ledger.sqlite3" });
port2.open();
const c3 = readCheckpoint(port2, srcFile, { ...obs3, schemaVersion: SRC_SCHEMA_VERSION });
assert(c3 !== null && c3.offset === 0, "重开库 checkpoint 仍在（持久）");

// ---------- 3. loss writer：三场景落账 + 字段全等 + 截断 + 过滤（验收 3） ----------
console.log("loss writer:");
const lossSrc = join(dataDir, "org-groups.ndjson");
const three: LossRecord[] = [
  { sourcePath: lossSrc, lineNo: 2, reason: "bad-json", excerpt: '{"id":"g-bad",,}' },
  { sourcePath: lossSrc, lineNo: 5, reason: "missing-attribution", excerpt: '{"id":"g-5","name":"无项目组"}' },
  { sourcePath: lossSrc, lineNo: 9, reason: "dangling-ref", excerpt: '{"id":"g-9","project_id":"p-missing"}' },
];
for (const r of three) appendLoss(port2, r);
const readBack = listLoss(port2, lossSrc);
assert(readBack.length === 3, "三场景各落一账（bad-json/missing-attribution/dangling-ref）");
assert(
  readBack[0]?.lineNo === 2 && readBack[0]?.reason === "bad-json" && readBack[0]?.excerpt === three[0]?.excerpt && readBack[0]?.sourcePath === lossSrc,
  "loss 记录字段全等（source_path+line_no+reason+excerpt）",
);
assert(readBack.map((r) => r.reason).join() === "bad-json,missing-attribution,dangling-ref", "三场景 reason 逐一对应");
const longLine = "x".repeat(EXCERPT_MAX + 100);
appendLoss(port2, { sourcePath: lossSrc, lineNo: 20, reason: "bad-json", excerpt: longLine });
const truncated = listLoss(port2, lossSrc).at(-1);
assert(truncated !== undefined && truncated.excerpt.length === EXCERPT_MAX && truncated.excerpt.endsWith("…"), `超长摘要截断至 ${EXCERPT_MAX}（… 收尾）`);
assert(listLoss(port2, join(dataDir, "other.ndjson")).length === 0 && listLoss(port2).length === 4, "按源文件过滤精确（他源空、全量 4 条）");

// ---------- 4. mini 导入循环：三场景不阻断批次 + 不造关联 + 事务原子（验收 3/4 消费面） ----------
console.log("mini 导入循环:");
port2.exec("INSERT INTO project (id, name, dir_fingerprint, anchor_dir, ts) VALUES ('p1','proj-a','fp-1','/tmp/a',1)");
port2.exec(`INSERT INTO "group" (id, project_id, name, anchor_dir, status, tier, single_card, created_at, updated_at) VALUES ('g1','p1','grp-a','/tmp/a','active','正经立项',0,1,1)`);
const groupCountBefore = port2.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "group"`)[0]?.n ?? -1;
// 5 行源：1 合法 / 2 坏 JSON / 3 悬空 group 引用 / 4 缺 group 归因 / 5 合法
const batch = [
  '{"id":"l1","group_id":"g1","text":"ok-1"}',
  '{"id":"l2",,"text":"broken"}',
  '{"id":"l3","group_id":"g-missing","text":"dangling"}',
  '{"id":"l4","text":"no-attribution"}',
  '{"id":"l5","group_id":"g1","text":"ok-5"}',
];
const batchFile = join(dataDir, "lessons.ndjson");
writeFileSync(batchFile, batch.join("\n") + "\n");
let batchThrew = false;
try {
  const raw = readFileSync(batchFile, "utf8").split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
  raw.forEach((line, idx) => {
    const lineNo = idx + 1;
    let parsed: { id?: string; group_id?: string; text?: string };
    try { parsed = JSON.parse(line) as typeof parsed; } catch {
      appendLoss(port2, { sourcePath: batchFile, lineNo, reason: "bad-json", excerpt: line });
      return; // 坏行落账后批次继续
    }
    const dangling = parsed.group_id !== undefined && parsed.group_id !== null
      && port2.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "group" WHERE id = ?`, [parsed.group_id])[0]?.n === 0;
    if (dangling) {
      // 悬空引用：归因写 NULL + 落账，绝不造关联（不插入假 group、不硬塞悬空 id）
      port2.exec("INSERT INTO lesson (id, group_id, text, created_at) VALUES (?, NULL, ?, ?)", [parsed.id, parsed.text, 1]);
      appendLoss(port2, { sourcePath: batchFile, lineNo, reason: "dangling-ref", excerpt: line });
      return;
    }
    if (parsed.group_id === undefined) {
      // 缺归因：归因写 NULL + 落账（冻结件 §1：缺失 task/group 归因写 NULL 并进入 loss list）
      port2.exec("INSERT INTO lesson (id, group_id, text, created_at) VALUES (?, NULL, ?, ?)", [parsed.id, parsed.text, 1]);
      appendLoss(port2, { sourcePath: batchFile, lineNo, reason: "missing-attribution", excerpt: line });
      return;
    }
    port2.exec("INSERT INTO lesson (id, group_id, text, created_at) VALUES (?, ?, ?, ?)", [parsed.id, parsed.group_id, parsed.text, 1]);
  });
} catch { batchThrew = true; }
assert(batchThrew === false, "含坏行/悬空/缺归因的批次完整跑完（不阻断，其余行继续）");
const lessons = port2.query<{ id: string; group_id: string | null }>("SELECT id, group_id FROM lesson ORDER BY id");
assert(JSON.stringify(lessons.map((l) => l.id)) === JSON.stringify(["l1", "l3", "l4", "l5"]), "合法行 4 条全部写入（1/3/4/5）");
assert(lessons.find((l) => l.id === "l1")?.group_id === "g1" && lessons.find((l) => l.id === "l5")?.group_id === "g1", "合法归因保留原引用（g1）");
assert(lessons.find((l) => l.id === "l3")?.group_id === null && lessons.find((l) => l.id === "l4")?.group_id === null, "悬空/缺归因两行归因列均为 NULL");
assert((port2.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "group"`)[0]?.n ?? -1) === groupCountBefore, "零造关联：group 表行数不变（没补假组）");
const batchLoss = listLoss(port2, batchFile);
assert(
  batchLoss.length === 3 && batchLoss.map((l) => `${l.lineNo}:${l.reason}`).join() === "2:bad-json,3:dangling-ref,4:missing-attribution",
  "loss 台账恰 3 条且 file:line+原因逐一对应（2/3/4 行）",
);
expectThrow(() => port2.exec("INSERT INTO lesson (id, group_id, text, created_at) VALUES ('l-hard','g-missing','hard-ref',1)"), "对照：硬塞悬空 id 被 FK 拒（写 NULL 是唯一正解，坐实绝不造关联）");
// 事务原子（A2 范式消费）：回滚时实体与 loss 台账一起消失，不会台账有账实体没有
port2.begin();
port2.exec("INSERT INTO lesson (id, group_id, text, created_at) VALUES ('l-tx','g1','tx-row',1)");
appendLoss(port2, { sourcePath: batchFile, lineNo: 99, reason: "bad-json", excerpt: "tx" });
port2.rollback();
assert(port2.query<{ n: number }>("SELECT COUNT(*) AS n FROM lesson WHERE id = 'l-tx'")[0]?.n === 0 && listLoss(port2, batchFile).length === 3, "事务回滚：实体行与 loss 记录一并撤销（两账不裂）");
port2.close();

rmSync(dataDir, { recursive: true, force: true });

console.log(`Storage checkpoint: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
