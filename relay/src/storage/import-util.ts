// ---------- 导入工具共享件（M11-UTIL） ----------
// 导入线（org/notification/session-task/acceptance/artifact 五件 + 后续导入线）共同面的唯一定点。
// 共享面收敛到三导出（领域观测类型不共享，见尾注）：
//   · sha12：确定性短 id 词根（sha1 前 12 hex）——mem-/proj-/ntf-/task-/itm-/res- 等各域导入 id
//     的公共词根，幂等重灌同源同键不漂移。
//   · statThenRead + ObservedFile：单文件观测骨架，「stat 先于 read」定稿序唯一定点。
//
// **stat 先于 read 定稿序（权威注释，迁自 import-org.ts observe，M11-REVIEW P2-1 / efd06ce 落地）**：
//   stat 后 read 前文件被改 → 本次观测拿旧 mtime 配新内容 → checkpoint 记旧 mtime，下次五元组
//   失效重扫（多扫一次，安全侧）。反序（read 完才 stat）竞态拿新 mtime 配旧内容：若后续修改不换
//   行数，checkpoint 记错位五元组静默续跑 = 数据错乱。故定序不可倒置；本骨架是全导入线唯一定序
//   定点，新导入器一律经此消费，不得再持私有 statSync+readFileSync 对。
//
// 容错边界（备案）：骨架裸调不吞 IO 异常——各导入器的异常域是领域决策（单文件源让它炸出事务
// 回滚 vs 目录遍历 catch continue 跳坏件），骨架只管定序不管容错；需要容错的消费方自行
// try/catch（先例：import-acceptance.ts observeAcceptanceDir）。
//
// 领域观测类型（org/notification 的 ObservedSource、session-task 的 ObservedNdjson、acceptance
// 的 ObservedDir、artifact 的 ObservedSource 等）**不共享**：各自与 checkpoint 五元组消费位/
// loss 源标识/解析段紧耦合，强行统一必牵动主体逻辑（纯重构超界）。各件保留领域类型，仅观测
// 内核（本件）共享。
//
// 迁移备案：六件全数消费本件，私有 sha12/statThenRead 对已清零（M11-UTIL 迁四件 + M11-UTIL2
// 回迁 import-org.ts，其 observe 即定稿序出处、原处留指引注释指向本头注）。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** sha1 前 12 hex——导入器确定性短 id 词根。 */
export function sha12(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** 单文件观测产物：mtime 已 Math.round（checkpoint 五元组 mtime 位口径）。 */
export interface ObservedFile {
  mtimeMs: number;
  text: string;
}

/** 单文件观测骨架：stat 先于 read（定稿序，理由见头注）。裸调不吞 IO 异常（容错边界见头注）。 */
export function statThenRead(file: string): ObservedFile {
  const mtimeMs = Math.round(statSync(file).mtimeMs);
  const text = readFileSync(file, "utf8");
  return { mtimeMs, text };
}
