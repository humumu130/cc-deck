// ---------- #292-B2 org 域写口三拍事务（批2：组/板/确认三域写路径经 StoragePort） ----------
// 口径（任务书拍板，保守双轨）：文件照写（审计账保留，org 目录=用户可见资产）+
// StoragePort 三拍事务（begin/commit/rollback）。事务的双重作用：
//   1. 互斥域——BEGIN IMMEDIATE 写锁把「读（文件直读）→校验→写文件」整段串行化，
//      根除 test-brm 实测的读改写竞态（2.8% flake「任务板已冻结」）；
//   2. 写后同步导入追赶——commit 后 ensureStore 触发导入面（批1 write-dispatch 同款），
//      「写文件→库（读面投影）可见」的窗口收进锁域，写口返回即读面一致。
// 竞态真根（批2 勘查实锤）：写口的「读」原走 viaReadMode sqlite 投影——库为导入器
// 镜像（读前触发追赶），追赶窗口内读到陈旧态→改→写回=抹掉并发新写（S0 建组被抹→
// S1 upsert「已冻结」）。故本模块配套要求：**事务内读写口一律文件直读**（jsonBypass
// 语义——调用方接线见 projects.ts 三口），文件=真相源，库=读穿投影。
//
// 嵌套铁律：锁内不得调 ensureStore/importAllForShadow（org 重扫联动自持 begin，
// 嵌套=编程错误）——本模块用 ensureStoreQuiet 取端口，导入追赶严格在 commit 之后。
//
// 降级语义（#158 同族）：SQLite 不可用（驱动缺失/建库失败/json 读档）时整段落回纯
// 文件账 + console.warn 一次——relay 主流程零影响（文件账本就是完整真相）。
//
// 可重入性：不可重入（port.begin 已有事务=编程错误）。**只在三域出口函数包**
// （setGroupStatus/upsertBoardEntry/decideConfirm），低层（saveGroup/saveBoardFile/
// writeConfirms）不包——出口互调低层安全，出口互调出口（嵌套）是接线错误。

import { homedir } from "node:os";
import { join } from "node:path";
import { isDataDirIsolated } from "../config.js";
import { currentReadMode, ensureStore, ensureStoreQuiet, resolveDirs, type ReadModeDirs } from "./read-mode.js";

/** 写口 dir 参数（org 目录）→ ReadModeDirs：dataDir/tasksDir 走 resolveDirs 缺省。
 * orgDir 缺省解析**必须**与 org.ts orgDir() 同口径（A 路审查 P2-4：read-mode 的
 * resolveDirs 缺省不带 isDataDirIsolated 分支——CCR_DATA_DIR 隔离态下 tx 写
 * <dataDir>/org 而追赶导入盯 ~/.cc-deck/org，写后不可见承诺失效）。不直接 import
 * org.ts（org→projects→本文件=环依赖），同款逻辑复制于此并锚 org.ts:118。 */
export function dirsForOrgDir(dir?: string): ReadModeDirs {
  const base = resolveDirs();
  if (dir) return { ...base, orgDir: dir };
  if (process.env.CCR_ORG_DIR) return base;
  if (isDataDirIsolated()) return { ...base, orgDir: join(process.env.CCR_DATA_DIR as string, "org") };
  return { ...base, orgDir: join(homedir(), ".cc-deck", "org") };
}

let txDegraded = false;
let txDepth = 0; // #292-B2 A-P2-2/B-A6：嵌套防护——出口互调出口（接线错误）时内层把外层
// 活事务误清场误降级；depth 标记 OWN 事务，嵌套直接抛类型化编程错误（fail-fast 好过静默错杀）

/** org 域写事务：三拍包裹 fn（读改写整段，文件直读）。fn 抛错→rollback 后原样上抛
 * （文件态由 fn 自身原子写保证；库锁释放）；正常→commit+导入追赶（追赶失败 warn
 * 降级——文件账在，下次读前触发兜底）。SQLite 不可用→fn 纯文件执行（降级一次告警）。 */
export function withOrgWriteTx<T>(dir: string | undefined, fn: () => T): T {
  // json 读档=零 SQLite 参与口径（read-mode #158 头注）：事务整段短路，纯文件执行
  if (currentReadMode() === "json") return fn();
  let port;
  try {
    port = ensureStoreQuiet(dirsForOrgDir(dir));
  } catch (err) {
    if (!txDegraded) {
      txDegraded = true;
      console.warn("[org-write-tx] ⚠️  SQLite 不可用，org 写口降级纯文件账（#158 语义）：", err instanceof Error ? err.message : err);
    }
    return fn();
  }
  // 嵌套防护：本模块活事务内再入=出口互调出口的接线错误——抛类型化错误（不静默清场
  // 外层事务，A-P2-2：清场会误杀合法外层+外层 commit 报错=状态失真）
  if (txDepth > 0 && port.inTransaction) {
    throw new Error("[org-write-tx] 嵌套写事务=编程错误（出口互调出口）——内层不降级不清场，请检查三口接线");
  }
  // 自愈清场（#292-B2 首跑实锤）：导入器偶发遗留未结事务（遗留路径待专项审计——回执
  // 备案；txDepth=0 保证清的只可能是遗留，非本模块活事务）
  if (port.inTransaction) {
    try { port.rollback(); } catch { /* 连接死：走 begin 降级 */ }
    console.warn("[org-write-tx] 检测到导入器遗留未结事务，已回滚清场（导入器异常路径疑点，备案待专项）");
  }
  try {
    port.begin(); // BEGIN IMMEDIATE：写锁前置=跨写口互斥域
    txDepth++;
  } catch (err) {
    try { port.rollback(); } catch { /* noop */ }
    if (!txDegraded) {
      txDegraded = true;
      console.warn("[org-write-tx] ⚠️  写锁获取失败，org 写口降级纯文件账：", err instanceof Error ? err.message : err);
    }
    return fn();
  }
  let result: T;
  try {
    result = fn();
    port.commit();
  } catch (err) {
    try { port.rollback(); } catch { /* 连接已死：锁随连接释放 */ }
    throw err;
  } finally {
    txDepth = Math.max(0, txDepth - 1);
  }
  // 导入追赶（锁外）：把刚写的文件态灌库，读面（sqlite 投影）立即可见。失败不炸
  // 调用方（文件账已成功=降级安全；读前触发会在下次读时兜底追赶）
  try {
    ensureStore(dirsForOrgDir(dir));
  } catch (err) {
    console.warn("[org-write-tx] 导入追赶降级（文件账在，读前触发兜底）：", err instanceof Error ? `${err.message}
${err.stack}` : err);
  }
  return result;
}
