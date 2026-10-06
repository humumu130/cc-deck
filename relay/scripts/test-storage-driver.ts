// M11-A1 驱动测试：mkdtemp 临时库 + WAL/FK PRAGMA + 事务提交/回滚（含真·新进程重开）+ 临时目录纪律断言。
// 范式仿 test-org（mkdtemp+env 覆盖+assert 计数）。scratch 表仅建于测试临时库，验证驱动
// 能力用——schema 交付归 B1（schema.ts），本单零 DDL 交付。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort, DEFAULT_DB_FILENAME } from "../src/storage/sqlite.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function throws(fn: () => void): boolean {
  try { fn(); return false; } catch { return true; }
}

// ---------- 0. 启动前纪律：CCR_DATA_DIR/CCR_ORG_DIR 均指向临时目录（验收 4） ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-storage-"));
process.env.CCR_DATA_DIR = dataDir;
const orgDir = join(dataDir, "org");
process.env.CCR_ORG_DIR = orgDir;
console.log("临时目录纪律:");
assert(process.env.CCR_DATA_DIR === dataDir && process.env.CCR_ORG_DIR === orgDir, "CCR_DATA_DIR/CCR_ORG_DIR 已覆盖指向临时目录");
assert(dataDir.startsWith(tmpdir()) && orgDir.startsWith(tmpdir()), "两 env 均落在 tmpdir 前缀下（零生产目录写入前提）");
assert(!existsSync(join(process.env.HOME ?? "", ".cc-deck", DEFAULT_DB_FILENAME)), "生产目录无本测试库文件（未触碰 ~/.cc-deck）");

// ---------- 1. 建库并打开（验收 1） ----------
console.log("建库与打开:");
const port: StoragePort = createSqlitePort({ dataDir });
assert(port.path === join(dataDir, DEFAULT_DB_FILENAME), "默认库文件名 cc-deck.sqlite3 在 dataDir 下");
assert(!port.isOpen && port.path !== "", "构造后未连接（open 前置语义）");
port.open();
assert(port.isOpen && existsSync(port.path), "open 后连接在且库文件已创建");

// ---------- 2. 冻结 PRAGMA（验收 2） ----------
console.log("冻结 PRAGMA:");
const jm = port.query<{ journal_mode: string }>("PRAGMA journal_mode")[0]?.journal_mode;
const fk = port.query<{ foreign_keys: number }>("PRAGMA foreign_keys")[0]?.foreign_keys;
const sync = port.query<{ synchronous: number }>("PRAGMA synchronous")[0]?.synchronous;
assert(jm === "wal", `journal_mode=wal（实际 ${jm}）`);
assert(fk === 1, `foreign_keys=1（实际 ${fk}）`);
assert(sync === 1, `synchronous=NORMAL(1)（实际 ${sync}）`);

// ---------- 3. 事务提交/回滚 + 重启可重开（验收 3） ----------
console.log("事务与重启:");
port.exec("CREATE TABLE driver_scratch (k TEXT PRIMARY KEY, v INTEGER)"); // scratch：驱动能力验证，非 schema 交付
port.exec("INSERT INTO driver_scratch (k, v) VALUES (?, ?)", ["committed", 1]);
port.begin();
port.exec("INSERT INTO driver_scratch (k, v) VALUES (?, ?)", ["rollback-me", 2]);
port.rollback();
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM driver_scratch WHERE k = 'rollback-me'")[0]?.n === 0, "回滚后数据无");
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM driver_scratch WHERE k = 'committed'")[0]?.n === 1, "事务外写入在");
port.begin();
port.exec("INSERT INTO driver_scratch (k, v) VALUES (?, ?)", ["tx", 3]);
port.commit();
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM driver_scratch WHERE k = 'tx'")[0]?.n === 1, "事务提交后当前连接可见");
port.begin();
port.exec("INSERT INTO driver_scratch (k, v) VALUES (?, ?)", ["tx2", 4]);
port.commit();
assert(throws(() => port.commit()), "无未结事务时 commit 视为编程错误（炸）");
port.close();
assert(!port.isOpen, "close 后 isOpen=false");

// 真·新进程重开：独立 node 进程读同一库文件——WAL 提交数据跨进程存活（验收 3 硬证）
const probe = spawnSync(process.execPath, ["-e", `
  const D = require("better-sqlite3");
  const db = new D(${JSON.stringify(port.path)}, { readonly: true });
  const rows = db.prepare("SELECT k FROM driver_scratch ORDER BY k").all();
  console.log(JSON.stringify(rows.map((r) => r.k)));
  db.close();
`], { cwd: process.cwd(), encoding: "utf-8" });
let reopened: string[] = [];
try { reopened = JSON.parse(probe.stdout.trim()) as string[]; } catch { /* keep [] */ }
assert(probe.status === 0 && reopened.includes("committed") && reopened.includes("tx") && reopened.includes("tx2") && !reopened.includes("rollback-me"),
  `新进程重开库：提交数据全在、回滚数据无（实际 ${JSON.stringify(reopened)}）`);

// 重开可写续用
const port2: StoragePort = createSqlitePort({ dataDir, filename: "reopen.sqlite3" });
port2.open();
port2.exec("CREATE TABLE t (x)");
port2.exec("INSERT INTO t VALUES (?)", [42]);
port2.close();
const port2b: StoragePort = createSqlitePort({ dataDir, filename: "reopen.sqlite3" });
port2b.open();
assert(port2b.query<{ n: number }>("SELECT COUNT(*) AS n FROM t")[0]?.n === 1, "同名库重开数据仍在（重启可重开）");
let execUsable = true;
try { port2b.exec("SELECT 1"); } catch { execUsable = false; }
assert(execUsable, "重开后 exec 可用");

// ---------- 4. 边界与编程错误面 ----------
console.log("边界:");
assert(throws(() => createSqlitePort({ dataDir }).exec("SELECT 1")), "未 open 直接 exec 炸");
assert(throws(() => { const p = createSqlitePort({ dataDir, filename: "dup.sqlite3" }); p.open(); p.open(); }), "重复 open 炸");
assert(throws(() => { port2b.begin(); port2b.begin(); }), "嵌套 begin 炸（IMMEDIATE 单事务语义）");
const multi = createSqlitePort({ dataDir, filename: "multi.sqlite3" });
multi.open();
multi.exec("CREATE TABLE a (x); CREATE TABLE b (y);");
multi.exec("INSERT INTO a VALUES (?)", [7]);
assert(multi.query<{ n: number }>("SELECT COUNT(*) AS n FROM a")[0]?.n === 1, "多语句 exec（B1 DDL 消费形态）+ 参数绑定读写通");
multi.close();

rmSync(dataDir, { recursive: true, force: true });

console.log(`Storage driver: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
