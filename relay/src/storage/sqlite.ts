// ---------- SQLite 驱动实现（M1-1A，冻结件选型 better-sqlite3） ----------
// 冻结口径（docs/v2-m10-freeze.md §1）：WAL/外键/CHECK。WAL 与外键在本层 open 时落
// PRAGMA；CHECK 属表约束，归 B1（schema.ts DDL），本层不建任何表。
// 本文件不读 CCR_* 环境变量：dataDir 由调用方显式传入（生产=上层配置解析，测试=临时目录）。
//
// #158 批1（2026-10-08）：better-sqlite3 由静态 import 改为**可失败的动态加载**。
// 0.7.0-test.3 Windows 包实锤：desktop resources 闭包里的 better_sqlite3.node 是 dev 机
// 汇集的 darwin-arm64 Mach-O，win32 上静态 import 在 bundle 模块加载期即触发 dlopen 抛
// ERR_DLOPEN_FAILED——整个 relay.mjs 起不来，8787 永不监听。改为首次用时 createRequire
// 同步 require + 成败一次缓存（原生模块加载失败同步抛，无需 async import()——
// StoragePort.open 是同步契约）；失败结果由读模式层（read-mode.ts viaReadMode）消费：
// 降级 json 档，进程照常 boot。CI 侧根修见 desktop.yml 的 prebuild-install 步。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type Database from "better-sqlite3"; // type-only：类型面保留，运行时零静态加载（esbuild 剥离）
import type { StoragePort, StoragePortOptions } from "./port.js";

export const DEFAULT_DB_FILENAME = "cc-deck.sqlite3";

/** better-sqlite3 构造器形状（new Database(path, options?)；实例面类型用 Database.Database）。 */
type SqliteConstructor = new (path: string, options?: Database.Options) => Database.Database;

/** 驱动加载结果（成败各一次缓存，进程生命周期内不变——二进制不会中途换）。 */
export interface SqliteDriverLoad {
  ok: boolean;
  ctor: SqliteConstructor | null;
  /** 失败原因（Error.message；成功为 null）。 */
  error: string | null;
  /** 失败错误码（ERR_DLOPEN_FAILED / MODULE_NOT_FOUND 等；无码为 null）。 */
  code: string | null;
}

const requireCjs = createRequire(import.meta.url);
let driverCache: SqliteDriverLoad | undefined;
/** 测试注入位：非 undefined 时 loadSqliteDriver 直接返回（模拟驱动加载失败，不真 require）。 */
let driverOverride: SqliteDriverLoad | undefined;

/**
 * 同步动态加载 better-sqlite3（成败一次缓存，永不抛）：dev/tsx 从 relay/node_modules
 * 解析；bundle 从同目录 node_modules 闭包解析（build-plugin.mjs 汇集）。原生二进制
 * 缺失/平台不匹配在此变成可消费的失败结果，而非进程级异常。
 *
 * 注意 v11 的原生 addon 是**构造器内惰性 require**（lib/database.js 的 DEFAULT_ADDON）
 * ——require 成功≠二进制可载，dlopen 失败（Windows 携 Mach-O 的真实失败点）要到
 * new Database 才现形。故成功路径补 :memory: 开合一次实测 dlopen：ok=true 从此=
 * 「已验证可载」。正常路径一次性毫秒级开销、零副作用（内存库不留文件）。
 */
export function loadSqliteDriver(): SqliteDriverLoad {
  if (driverOverride !== undefined) return driverOverride;
  if (driverCache !== undefined) return driverCache;
  try {
    const mod: unknown = requireCjs("better-sqlite3");
    // CJS class-export（module.exports = Database）为主；兼容 interop 带 .default 的形态
    const ctor = (typeof mod === "function" ? mod : (mod as { default?: unknown }).default) as SqliteConstructor | undefined;
    if (typeof ctor !== "function") {
      driverCache = { ok: false, ctor: null, error: "better-sqlite3 导出形态异常（非构造函数）", code: null };
    } else {
      const throwaway = new ctor(":memory:");
      throwaway.close();
      driverCache = { ok: true, ctor, error: null, code: null };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? null;
    driverCache = { ok: false, ctor: null, error: err instanceof Error ? err.message : String(err), code };
  }
  return driverCache;
}

/** 测试隔离/注入：清缓存；传 override 模拟驱动成败（不真 require）。生产勿调。 */
export function resetSqliteDriverForTest(override?: SqliteDriverLoad): void {
  driverCache = undefined;
  driverOverride = override;
}

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
    const driver = loadSqliteDriver();
    if (!driver.ok || driver.ctor === null) {
      // #158 批1：驱动不可用（原生二进制缺失/平台不匹配）——抛携带错误码的显式错误。
      // 读模式层（viaReadMode）会在到达这里之前预判驱动可用性并降级 json 档；本错误
      // 只兜直接调 ensureStore/open 的旁路调用者（permission-audit 已各自守卫）。
      throw new Error(`StoragePort.open: better-sqlite3 不可用（${driver.code ?? "无错误码"}：${driver.error}）——原生二进制缺失或平台不匹配，读面应降级 json 档`);
    }
    mkdirSync(this.dir, { recursive: true });
    this.db = new driver.ctor(this._path);
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
