// ---------- 迁移 runner（M11-A2）：版本态自实现于 PRAGMA user_version ----------
// 消费 M11-A1 StoragePort（begin/commit/rollback 三拍 + exec 多语句 DDL）。语义：
// ①顺序执行一次（v_from+1..v_latest 逐版）；②幂等（已到最新版零执行）；③失败保留前一
// 版本——up 与版本号写入同处一个 IMMEDIATE 事务，rollback 时 schema 与版本号一并回滚，
// 库保持上一完整态可重跑。user_version=0 表示全新库；版本列表须从 1 连续升序。
import type { StoragePort } from "./port.js";

/** 单版本迁移：up 内只做该版本的 schema 变化（exec DDL/数据回填），禁止自行管理事务。 */
export interface Migration {
  /** 目标版本号（1 起连续）。 */
  version: number;
  /** 人类可读名（进错误上下文与报告）。 */
  name: string;
  /** 迁移体。抛错即本版本失败——runner 负责回滚，库保留前一版本完整态。 */
  up(port: StoragePort): void;
}

export interface MigrationRunResult {
  /** 执行前版本号（全新库为 0）。 */
  from: number;
  /** 执行后版本号。 */
  to: number;
  /** 本次实际执行的版本号列表（幂等重跑为空数组）。 */
  applied: number[];
}

function currentVersion(port: StoragePort): number {
  const row = port.query<{ user_version: number }>("PRAGMA user_version")[0];
  const v = row?.user_version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`migrator: user_version 不可判定（${String(v)}）——非本 runner 管理的库？`);
  }
  return v;
}

function setVersion(port: StoragePort, version: number): void {
  port.exec(`PRAGMA user_version = ${version}`);
}

/** 校验迁移列表：版本号从 1 连续升序且唯一（坏列表是编程错误，炸而非静默跳过）。 */
function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migrator: 迁移列表须从 1 连续升序（第 ${i} 项 version=${m.version}）`);
    }
  });
}

/** 执行迁移至最新版。幂等：已在最新版时零执行返回 { applied: [] }。 */
export function runMigrations(port: StoragePort, migrations: readonly Migration[]): MigrationRunResult {
  assertWellFormed(migrations);
  const from = currentVersion(port);
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    port.begin();
    try {
      migration.up(port);
      setVersion(port, migration.version);
      port.commit();
    } catch (err) {
      port.rollback();
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`migrator: v${migration.version}(${migration.name}) 迁移失败，已回滚保留 v${from + applied.length} 完整态——${reason}`);
    }
    applied.push(migration.version);
  }
  return { from, to: currentVersion(port), applied };
}
