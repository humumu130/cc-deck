// org 数据落盘安全底座（W-CMDIMPL T0a，#216；设计 docs/cmdprod-design.md §5.3 案甲）
// org 数据是「用户可见资产」（org.ts 头注明示）——projects.json 写穿全量重写、
// 三无（无 journal 无备份无 .1 档），崩溃窗口（断电/kill -9 半写）是主敌（生产单实例
// 已隔离并发面）。本模块提供三件套的共享原语，projects.ts / org.ts 共用，零环：
//   ① atomicWriteJson —— tmp+rename 原子写（同目录 rename = POSIX 原子，消除半写窗口）
//   ② appendJournal  —— append-only 审计行（W-BJOURNAL 三纪律同款：失败不阻断主写 /
//                       超 5MB 滚动 / 摘要截断由调用方负责）
//   ③ lastGoodJournalSnapshot —— 坏文件自动回放：从 journal 末尾向前找最近一行可解析
//                       的快照（T0a 第三件「坏 JSON 拒绝空态写回」的恢复面）
import { appendFileSync, closeSync, existsSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 原子写：先写同目录临时文件再 rename 覆盖。返回 false 时已清理残留 tmp。 */
export function atomicWriteJson(file: string, data: string): boolean {
  const tmp = join(dirname(file), `.${String(file.split("/").pop() || "file")}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error(`[fs-safe] 原子写失败 ${file}: ${e instanceof Error ? e.message : String(e)}`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    return false;
  }
}

/** append-only 审计行。三纪律：①失败绝不阻断主写（stderr——审计面静默降级不可接受）
 *  ②有界：超 5MB 滚动为 <file>.<ts> ③行内容由调用方构造（大字段截断是调用方责任）。 */
export function appendJournal(journalFile: string, row: Record<string, unknown>): void {
  try {
    try {
      const st = statSync(journalFile);
      if (st.size > 5 * 1024 * 1024) renameSync(journalFile, `${journalFile}.${Date.now()}`);
    } catch {} // 无文件 = 首次追加，滚动检查跳过
    appendFileSync(journalFile, JSON.stringify(row) + "\n", "utf-8");
  } catch (e) {
    console.error(`[fs-safe] journal 追加失败（不阻断主写）${journalFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 从 journal（NDJSON，每行含 snapshot 字段）末尾向前找最近一行可解析快照并返回其
 *  snapshot 字段值；无可恢复行返回 null。供「坏 JSON 拒绝空态写回」的自动回放。 */
export function lastGoodJournalSnapshot(journalFile: string, maxScan = 200): unknown {
  if (!existsSync(journalFile)) return null;
  let raw = "";
  try {
    raw = readTextTail(journalFile, 8 * 1024 * 1024); // 回放扫描最多读尾部 8MB（滚动后单文件 ≤5MB+余量）
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let scanned = 0;
  for (let i = lines.length - 1; i >= 0 && scanned < maxScan; i--, scanned++) {
    try {
      const row = JSON.parse(lines[i]) as { snapshot?: unknown };
      if (row && row.snapshot !== undefined) return row.snapshot;
    } catch {} // 半写行/坏行跳过继续向前
  }
  return null;
}

/** 尾部读取（避免全量读大文件）。 */
function readTextTail(file: string, maxBytes: number): string {
  const st = statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const fh = openSync(file, "r");
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    readSync(fh, buf, 0, len, start);
    return buf.toString("utf-8");
  } finally {
    closeSync(fh);
  }
}
