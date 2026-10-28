// ---------- #292 cutover 批1 v2：dispatch 写路径经 StoragePort 同步落库 ----------
// org.ts 台账 append 后立即触发 ensureStore 导入面：刚 append 的行在同一事务批内
// 经 StoragePort 落库（段链语义由 importer 权威执行——restoreSegs 从库恢复段态，
// 直写 UPSERT 会在重投段链上腐蚀已冻结的终态根行，故不经直写 SQL）。
// 文件保留为审计原始账；导入 checkpoint 与 append 同步推进=库即写源。
// v1 教训：ensureStore() 需传 dirs（resolveDirs()），不存在 loadSqliteDriver 导出——
// v1 对想象 API 编码，import 即 SyntaxError，test-brm→org.ts 链 8/8 崩（幸未构建上线）。

import { ensureStore, resolveDirs } from "./read-mode.js";

/** dispatch 台账 append 后调用：同步导入面把该行落库。失败不炸调用方（文件已写成功=降级安全）。 */
export function writeDispatchToDb(): void {
  try {
    ensureStore(resolveDirs());
  } catch (err) {
    // SQLite 降级/原生模块缺失等：文件账仍在，导入器后续读前触发会再追赶
    console.warn("[write-dispatch] 同步落库降级，文件账保留：", err instanceof Error ? err.message : err);
  }
}
