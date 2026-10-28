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
// 迁移备案（M11-UTIL/UTIL2/FIX-B 如实口径）：六导入器中五件消费本件（org/notification/
// session-task/acceptance/artifact，M11-UTIL 迁四件 + M11-UTIL2 回迁 import-org.ts，其 observe
// 即定稿序出处、原处留指引注释指向本头注），dispatch-lesson 于 M11-FIX-B 入面（observeNdjson）。
// 领域特化豁免（有意不迁，非遗漏）：
//   · session-task observeTasksDir：只 stat 不读内容（行数走 wc 面），无 read 半边可共享；
//   · acceptance observeAcceptanceDir：stat 失败跳件 vs read 失败落账，异常域分段，骨架单层
//     裸调无法表达（头注「容错边界」所引先例即此）；
//   · artifact observeInline：内容指纹替代 mtime，无 stat 面可共享。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** sha1 前 12 hex——导入器确定性短 id 词根。 */
export function sha12(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** 单文件观测产物：mtime 已 Math.round（checkpoint 五元组 mtime 位口径）。 */
export interface ObservedFile {
  mtimeMs: number;
  /** #292-B2（B 路审查真根修）：纳秒失效腿直出——checkpoint 比较键升级用（ms 取整在
   * 同毫秒二次写+等长覆盖形态下假有效=投影陈旧=写回抹写，import-util 头注早已论证）。 */
  mtimeNs: string;
  text: string;
  /** #292-cutover-P1（C-C2）：大源（>SIZE_MEMO_MAX_BYTES）双未变短路标记——text 为
   * 空串（不承载内容），lineCount 复用基线值；显式认该旗的调用方（observeNdjson）
   * 据此免全文处理，不认的旧调用方对大源只会看到「内容为空」——大源面目前仅
   * events.ndjson 一个消费者，见 observeNdjson 承接注释。 */
  unchanged?: boolean;
  lineCount?: number;
}

/** 单文件观测骨架：stat 先于 read（定稿序，理由见头注）。裸调不吞 IO 异常（容错边界见头注）。
 *
 * **stat 短路 memo（STAT-SHORTCUT，READMODE-FIX 性能报忧转单）**：ensureStore 每次调用全源
 * observe（READMODE-FIX 起 portCache 命中也跑导入聚合），checkpoint 全命中时 observe 拿到的
 * mtime/lineCount 只为判定快进，text 用完即弃——同内容反复全文读是纯税（1MB 源实测 1.4ms/次）。
 * memo 按 (mtimeNs, size) 判定：双未变⇒内容未变⇒直接复用上次 text（skip readFileSync）；
 * 任一变⇒照常全文读并刷新 memo。正确性锚：
 *   · mtime 推进是 OS 写路径保证（writeFileSync/appendFileSync 必推）；失效腿用 **mtimeNs 纳秒
 *     精度**（bigint stat）——ms 粒度在同毫秒内二次写不推进（等长覆盖写对抗形态，测试探针实锤
 *     误命中），ns 腿堵死该缝（APFS/ext4 均纳秒；秒级精度 FS 退化为现行为，安全侧）；
 *   · 定稿序不变：命中路径只有 stat 无 read（无竞态窗口），miss 路径 stat 后 read 原样；
 *   · SIZE_MEMO_MAX_BYTES 上限防大源常驻内存（events.ndjson 生产持续增长，超限源退化为
 *     现行为=每次全文读，安全侧）。
 */
const OBS_MEMO = new Map<string, { mtimeNs: string; size: number; text: string }>();
const SIZE_MEMO_MAX_BYTES = 2 * 1024 * 1024;

export function statThenRead(file: string): ObservedFile {
  const st = statSync(file);
  const mtimeMs = Math.round(st.mtimeMs);
  const mtimeNs = statSync(file, { bigint: true }).mtimeNs.toString(); // 纳秒失效腿（ms 同粒度写也能区分）
  const hit = OBS_MEMO.get(file);
  if (hit !== undefined && hit.mtimeNs === mtimeNs && hit.size === st.size) {
    return { mtimeMs, mtimeNs, text: hit.text }; // 双未变短路：跳过全文读
  }
  // #292-cutover-P1（C-C2 events observe 短路）：超 memo 上限的大源（events.ndjson
  // 生产 35MB 且 2.47MB/天增长）此前每次全文读 ~90ms 纯税（checkpoint 全命中也付）。
  // 大源短路层：size+mtimeNs 双未变（与 memo 同判据）→unchanged:true + text 空串 +
  // lineCount 复用基线。显式认旗的调用方（observeNdjson）免全文处理；首见大源
  // （无基线）仍全文读一次建基线。真变更（append/压缩）mtimeNs 已变→不命中短路。
  if (st.size > SIZE_MEMO_MAX_BYTES) {
    const sc = LARGE_SHORTCIRC.get(file);
    if (sc !== undefined && sc.mtimeNs === mtimeNs && sc.size === st.size) {
      return { mtimeMs, mtimeNs, text: "", unchanged: true, lineCount: sc.lineCount };
    }
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const lineCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    LARGE_SHORTCIRC.set(file, { mtimeNs, size: st.size, lineCount });
    OBS_MEMO.delete(file); // 超限源不 memo 全文（防大源常驻内存），短路层只记三元组
    return { mtimeMs, mtimeNs, text };
  }
  const text = readFileSync(file, "utf8");
  OBS_MEMO.set(file, { mtimeNs, size: st.size, text });
  return { mtimeMs, mtimeNs, text };
}

/** #292-cutover-P1（C-C2）：大源（>SIZE_MEMO_MAX_BYTES）短路三元组——不存 text
 * （防 35MB 常驻内存），只记 mtimeNs+size+lineCount 供双未变判快进。 */
const LARGE_SHORTCIRC = new Map<string, { mtimeNs: string; size: number; lineCount: number }>();
