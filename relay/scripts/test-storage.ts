// M11-A2 迁移 runner 测试：顺序一次执行/幂等/失败注入保留前版可重跑/临时目录纪律。
// 范式沿用 test-storage-driver（mkdtemp+env 全清+assert 计数）。假想版本 v1 建表/v2 加列/
// v3 建索引——仅验证迁移机制，真实 15 表 DDL 归 B1。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations, type Migration } from "../src/storage/migrator.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- 0. 启动前纪律（验收 4） ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-migrator-"));
process.env.CCR_DATA_DIR = dataDir;
const orgDir = join(dataDir, "org");
process.env.CCR_ORG_DIR = orgDir;
console.log("临时目录纪律:");
assert(process.env.CCR_DATA_DIR === dataDir && process.env.CCR_ORG_DIR === orgDir, "CCR_DATA_DIR/CCR_ORG_DIR 均指向临时目录");
assert(dataDir.startsWith(tmpdir()) && orgDir.startsWith(tmpdir()), "两 env 落 tmpdir 前缀下（零生产写入前提）");

// 假想三版本（机制验证用；B1 才是真实 DDL）
const migrations: Migration[] = [
  { version: 1, name: "base-table", up: (p) => p.exec("CREATE TABLE mig_scratch (id TEXT PRIMARY KEY, val TEXT)") },
  { version: 2, name: "add-column", up: (p) => p.exec("ALTER TABLE mig_scratch ADD COLUMN note TEXT") },
  { version: 3, name: "aux-index", up: (p) => p.exec("CREATE INDEX idx_mig_scratch_val ON mig_scratch(val)") },
];

function columnsOf(port: StoragePort, table: string): string[] {
  return port.query<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
}
function versionOf(port: StoragePort): number {
  return port.query<{ user_version: number }>("PRAGMA user_version")[0]?.user_version ?? -1;
}

// ---------- 1. 顺序执行一次，逐版本断言（验收 1） ----------
console.log("顺序迁移:");
const port = createSqlitePort({ dataDir, filename: "mig.sqlite3" });
port.open();
const r1 = runMigrations(port, migrations);
assert(r1.from === 0 && r1.to === 3 && JSON.stringify(r1.applied) === "[1,2,3]", "fresh 库一次执行 v1→v2→v3（applied=[1,2,3]）");
assert(JSON.stringify(columnsOf(port, "mig_scratch")) === JSON.stringify(["id", "val", "note"]), "v1 建表+v2 加列 schema 落地（id/val/note）");
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_mig_scratch_val'")[0]?.n === 1, "v3 索引落地");
assert(versionOf(port) === 3, "user_version=3");
port.exec("INSERT INTO mig_scratch (id, val, note) VALUES (?, ?, ?)", ["row-1", "a", "kept"]);

// ---------- 2. 幂等（验收 2） ----------
console.log("幂等:");
const r2 = runMigrations(port, migrations);
assert(r2.from === 3 && r2.to === 3 && r2.applied.length === 0, "已在 v3 重复执行零迁移（applied=[]）");
assert(JSON.stringify(columnsOf(port, "mig_scratch")) === JSON.stringify(["id", "val", "note"]), "重复执行后 schema 不变");
assert(port.query<{ v: string }>("SELECT val AS v FROM mig_scratch WHERE id = 'row-1'")[0]?.v === "a", "重复执行后数据不变");

// ---------- 3. 失败注入：v2→v3 中途失败保留 v2 完整态可重跑（验收 3） ----------
console.log("失败注入:");
// 独立 v2 库（验收场景=「v2→v3 中途」；顺序段库已在 v3 会被幂等跳过，注入须发生在 v2）
const boomPort = createSqlitePort({ dataDir, filename: "boom.sqlite3" });
boomPort.open();
runMigrations(boomPort, migrations.slice(0, 2));
boomPort.exec("INSERT INTO mig_scratch (id, val, note) VALUES (?, ?, ?)", ["row-1", "a", "kept"]);
// 注入方法：换用同版本号的坏迁移（up 抛错）——纯调用方注入，零库文件手术
const boomV3: Migration = { version: 3, name: "boom", up: () => { throw new Error("注入失败"); } };
let boomErr = "";
try { runMigrations(boomPort, [migrations[0], migrations[1], boomV3]); } catch (e) { boomErr = e instanceof Error ? e.message : String(e); }
assert(boomErr.includes("v3(boom)") && boomErr.includes("保留 v2"), `失败报错带版本上下文（${boomErr}）`);
assert(versionOf(boomPort) === 2, "版本号回滚仍 v2（user_version 与 schema 同事务回滚）");
assert(JSON.stringify(columnsOf(boomPort, "mig_scratch")) === JSON.stringify(["id", "val", "note"]), "v2 schema 完整保留");
assert(boomPort.query<{ v: string }>("SELECT note AS v FROM mig_scratch WHERE id = 'row-1'")[0]?.v === "kept", "v2 数据完整保留");
assert(boomPort.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='idx_mig_scratch_val'")[0]?.n === 0, "失败版本的 v3 索引未残留");
// 回滚后事务可复用+重跑成功到 v3
boomPort.begin();
boomPort.exec("INSERT INTO mig_scratch (id, val) VALUES (?, ?)", ["post-rollback", "b"]);
boomPort.commit();
const r3 = runMigrations(boomPort, migrations);
assert(r3.applied.length === 1 && r3.applied[0] === 3 && versionOf(boomPort) === 3, "失败后重跑仅补 v3 成功到最新");
assert(boomPort.query<{ n: number }>("SELECT COUNT(*) AS n FROM mig_scratch")[0]?.n === 2, "重跑不丢既有数据");
boomPort.close();

// ---------- 4. 边界：坏列表/半途库 ----------
console.log("边界:");
assert((() => { try { runMigrations(port, [{ version: 2, name: "gap", up: () => undefined }]); return false; } catch { return true; } })(), "非连续版本列表炸（编程错误）");
const fresh2 = createSqlitePort({ dataDir, filename: "half.sqlite3" });
fresh2.open();
runMigrations(fresh2, migrations.slice(0, 2));
const r4 = runMigrations(fresh2, migrations);
assert(r4.from === 2 && r4.to === 3 && r4.applied.length === 1, "半途库（v2）续跑到 v3 只补差量");
fresh2.close();
port.close();

rmSync(dataDir, { recursive: true, force: true });

console.log(`Storage migrator: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
