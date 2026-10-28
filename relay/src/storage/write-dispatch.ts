// ---------- #292 cutover 批1 v2：dispatch 写路径经 StoragePort 同步落库 ----------
// org.ts 台账 append 后立即触发 ensureStore 导入面：刚 append 的行在同一事务批内
// 经 StoragePort 落库（段链语义由 importer 权威执行——restoreSegs 从库恢复段态，
// 直写 UPSERT 会在重投段链上腐蚀已冻结的终态根行，故不经直写 SQL）。
// 文件保留为审计原始账；导入 checkpoint 与 append 同步推进=库即写源。
// v1 教训：ensureStore() 需传 dirs（resolveDirs()），不存在 loadSqliteDriver 导出——
// v1 对想象 API 编码，import 即 SyntaxError，test-brm→org.ts 链 8/8 崩（幸未构建上线）。

import { ensureStore, resolveDirs, currentReadMode } from "./read-mode.js";

/** dispatch 台账 append 后调用：导入面把该行落库。失败不炸调用方（文件已写成功=降级安全）。
 * #292-cutover-P1（C-C1/P2-A5）：①json 读档短路（钉 json 回退档时不再建库+导入，
 *   维持「json 档零 SQLite 参与」承诺——此前违反 read-mode 头注）；②追赶改
 *   deferred 合并（C-C2 同 tick 去抖——派单热路径每 append 一次全量 observe 税
 *   ~100ms，同 tick 批量派单合并一赶）；③降级 warn 加一次性闸（#158 坏二进制
 *   机器上每次 appendDispatch 刷一条）。 */
let dispatchSyncWarned = false;
export function writeDispatchToDb(): void {
  if (currentReadMode() === "json") return; // json 档零 SQLite 参与
  try {
    const dirs = resolveDirs();
    setImmediate(() => {
      try {
        ensureStore(dirs);
      } catch (err) {
        if (!dispatchSyncWarned) {
          dispatchSyncWarned = true;
          console.warn("[write-dispatch] 同步落库降级（一次性告警，文件账保留，读前触发兜底）：", err instanceof Error ? err.message : err);
        }
      }
    });
  } catch (err) {
    if (!dispatchSyncWarned) {
      dispatchSyncWarned = true;
      console.warn("[write-dispatch] 同步落库降级，文件账保留：", err instanceof Error ? err.message : err);
    }
  }
}
