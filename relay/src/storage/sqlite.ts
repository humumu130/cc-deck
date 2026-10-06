// ---------- SQLite 驱动实现（M1-1A，冻结件选型 better-sqlite3） ----------
// 冻结口径（docs/v2-m10-freeze.md §1）：WAL/外键/CHECK。WAL 与外键在本层 open 时落
// PRAGMA；CHECK 属表约束，归 B1（schema.ts DDL），本层不建任何表。
// 本文件不读 CCR_* 环境变量：dataDir 由调用方显式传入（生产=上层配置解析，测试=临时目录）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { StoragePort, StoragePortOptions } from "./port.js";

export const DEFAULT_DB_FILENAME = "cc-deck.sqlite3";

class SqliteStorage implements StoragePort {
  private db: Database.Database | null = null;
  private _path = "";
  private _open = false;

  get path(): string {
    return this._path;
  }

  get isOpen(): boolean {
    return this._open;
  }

  open(): void {
    if (this._open) throw new Error(`StoragePort.open: 已打开（${this._path}）——重复 open 属编程错误`);
    mkdirSync(this.dir, { recursive: true });
    this.db = new Database(this._path);
    // 冻结 PRAGMA：WAL（journal_mode 持久化进库文件）+ 外键（连接级，每次 open 重设）。
    // synchronous=NORMAL 是 WAL 常规配套（checkpoint 时才 fsync），写吞吐与持久性平衡。
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    this._open = true;
  }

  close(): void {
    if (!this.db || !this._open) throw new Error("StoragePort.close: 未打开——close 前须 open");
    this.db.close();
    this.db = null;
    this._open = false;
  }

  begin(): void {
    // IMMEDIATE：begin 即取写锁，事务升级死锁在源头消除（迁移 runner 单写者语义）。
    this.requireDb("begin").exec("BEGIN IMMEDIATE");
  }

  commit(): void {
    this.requireDb("commit").exec("COMMIT");
  }

  rollback(): void {
    this.requireDb("rollback").exec("ROLLBACK");
  }

  exec(sql: string, params?: unknown[]): void {
    const db = this.requireDb("exec");
    if (params === undefined) {
      db.exec(sql);
      return;
    }
    db.prepare(sql).run(...params);
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const db = this.requireDb("query");
    if (params === undefined) return db.prepare(sql).all() as T[];
    return db.prepare(sql).all(...(params as unknown[])) as T[];
  }

  /** 取已打开的连接句柄；未打开抛错（TS 收窄靠返回值而非断言）。 */
  private requireDb(op: string): Database.Database {
    if (!this.db || !this._open) throw new Error(`StoragePort.${op}: 未打开——open 前置`);
    return this.db;
  }

  constructor(private readonly dir: string, filename: string) {
    this._path = join(dir, filename);
  }
}

/** 创建 SQLite StoragePort（仅构造，不连接；连接须显式 open()）。 */
export function createSqlitePort(options: StoragePortOptions): StoragePort {
  return new SqliteStorage(options.dataDir, options.filename ?? DEFAULT_DB_FILENAME);
}
