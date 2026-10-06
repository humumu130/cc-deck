// ---------- 导入 checkpoint（M11-B2）：断点续跑五元组 ----------
// 存储：SQLite import_checkpoint 表（schema.ts migrations v2=import-ledger；冻结件 §4
// M1-1B 验收口径内「checkpoint 表」）。键=五元组 path+mtime_ms+line_count+offset+schema_version：
// 读回时任一元与当前观测不符即判失效返回 null（源文件被追加/改动后错位续跑=数据错乱，从 0 重扫）。
// offset 语义：前 offset 行已成功处理，续跑从 offset+1 行（1-based）起。
// 事务边界归调用方（消费 A2 范式）：writer 只发单条语句，导入器可与实体写入同事务原子提交。
// 本文件不读任何 CCR_* 环境变量、不做 stat/数行（源文件观测归导入器，测试与调用方自传入）。
import type { StoragePort } from "./port.js";

/** checkpoint 键/载荷（五元组；updatedAt 为记录元数据非比对键，writer 自动填充）。 */
export interface CheckpointKey {
  /** 源文件绝对路径（表内主键）。 */
  path: string;
  /** 写入时观测的源文件 mtime（epoch-ms）。 */
  mtimeMs: number;
  /** 写入时观测的源文件总行数。 */
  lineCount: number;
  /** 已成功处理的行数（0..lineCount）；续跑从 offset+1 行起。 */
  offset: number;
  /** 导入映射逻辑版本——映射代码升级后旧 checkpoint 一律失效（防旧逻辑结果混入）。 */
  schemaVersion: number;
}

export interface ImportCheckpoint extends CheckpointKey {
  /** 记录最后写入时间（epoch-ms，仅元数据）。 */
  updatedAt: number;
}

/** 写入/覆盖 checkpoint（UPSERT by path；重扫后回写覆盖旧记录）。offset 越界属编程错误炸。 */
export function writeCheckpoint(port: StoragePort, key: CheckpointKey): void {
  if (!Number.isInteger(key.offset) || key.offset < 0 || key.offset > key.lineCount) {
    throw new Error(`checkpoint.writeCheckpoint: offset(${key.offset}) 越界 [0, lineCount(${key.lineCount})]——编程错误`);
  }
  const now = Date.now();
  port.exec(
    `INSERT INTO import_checkpoint (path, mtime_ms, line_count, line_offset, schema_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms, line_count = excluded.line_count,
       line_offset = excluded.line_offset, schema_version = excluded.schema_version,
       updated_at = excluded.updated_at`,
    [key.path, key.mtimeMs, key.lineCount, key.offset, key.schemaVersion, now],
  );
}

/**
 * 读取有效 checkpoint。五元组中 mtimeMs/lineCount/schemaVersion 与 current 观测任一不符
 * 即失效返回 null（调用方从 0 重扫，禁用旧 offset）；无记录亦 null。仅五元组全等才可续跑。
 */
export function readCheckpoint(
  port: StoragePort,
  path: string,
  current: { mtimeMs: number; lineCount: number; schemaVersion: number },
): ImportCheckpoint | null {
  const row = port.query<{
    path: string; mtime_ms: number; line_count: number; line_offset: number; schema_version: number; updated_at: number;
  }>("SELECT path, mtime_ms, line_count, line_offset, schema_version, updated_at FROM import_checkpoint WHERE path = ?", [path])[0];
  if (!row) return null;
  const checkpoint: ImportCheckpoint = {
    path: row.path,
    mtimeMs: row.mtime_ms,
    lineCount: row.line_count,
    offset: row.line_offset,
    schemaVersion: row.schema_version,
    updatedAt: row.updated_at,
  };
  if (
    checkpoint.mtimeMs !== current.mtimeMs ||
    checkpoint.lineCount !== current.lineCount ||
    checkpoint.schemaVersion !== current.schemaVersion
  ) {
    return null;
  }
  return checkpoint;
}
