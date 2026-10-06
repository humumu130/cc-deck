// ---------- 导入 loss 台账 writer（M11-B2） ----------
// 冻结件 §1 口径：缺失 task/group 归因写 NULL，并进入 loss list，禁止造数据补归因。
// 本件只负责「追加 loss 记录」（坏 JSON 行/缺归因/悬空引用三类及任意自由原因），实体行的
// NULL 归因写入由导入器自己做——writer 与实体写入可同事务（A2 范式）原子提交，做到
// 「行照写、归因 NULL、台账有账」三者不裂。绝不生成任何关联数据（不造 id/不补引用）。
// 存储：SQLite import_loss 表（schema.ts migrations v2=import-ledger）。
import type { StoragePort } from "./port.js";

/** 一条 loss 台账记录（sourcePath:lineNo 定位原文，reason 定性，excerpt 存原始行摘要）。 */
export interface LossRecord {
  /** 源文件绝对路径。 */
  sourcePath: string;
  /** 源文件行号（1-based；坏行即该行自身行号）。 */
  lineNo: number;
  /** 失因定性（约定词：bad-json / missing-attribution / dangling-ref；亦接受自由文案）。 */
  reason: string;
  /** 原始行摘要——超长截断至 EXCERPT_MAX（台账是排查线索，不是全文备份）。 */
  excerpt: string;
}

export interface LossEntry extends LossRecord {
  /** 台账自增 id（追加序）。 */
  id: number;
  /** 记录时间（epoch-ms）。 */
  createdAt: number;
}

/** excerpt 截断上限。 */
export const EXCERPT_MAX = 512;

/** 追加一条 loss 记录。excerpt 自动截断（超限以 … 收尾）；不造关联、不抛业务异常。 */
export function appendLoss(port: StoragePort, record: LossRecord): void {
  const excerpt = record.excerpt.length > EXCERPT_MAX
    ? `${record.excerpt.slice(0, EXCERPT_MAX - 1)}…`
    : record.excerpt;
  port.exec(
    "INSERT INTO import_loss (source_path, line_no, reason, excerpt, created_at) VALUES (?, ?, ?, ?, ?)",
    [record.sourcePath, record.lineNo, record.reason, excerpt, Date.now()],
  );
}

/** 读取 loss 台账（可按源文件过滤，id 升序）——对账/loss list 消费用。 */
export function listLoss(port: StoragePort, sourcePath?: string): LossEntry[] {
  const rows = sourcePath === undefined
    ? port.query<{ id: number; source_path: string; line_no: number; reason: string; excerpt: string; created_at: number }>(
      "SELECT id, source_path, line_no, reason, excerpt, created_at FROM import_loss ORDER BY id",
    )
    : port.query<{ id: number; source_path: string; line_no: number; reason: string; excerpt: string; created_at: number }>(
      "SELECT id, source_path, line_no, reason, excerpt, created_at FROM import_loss WHERE source_path = ? ORDER BY id",
      [sourcePath],
    );
  return rows.map((r) => ({
    id: r.id,
    sourcePath: r.source_path,
    lineNo: r.line_no,
    reason: r.reason,
    excerpt: r.excerpt,
    createdAt: r.created_at,
  }));
}
