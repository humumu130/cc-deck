// ---------- domstep1（域图 superagent-domain-v1 §三第一步·I2 入口幂等）：Trigger 键 ----------
// Trigger=审计与幂等的基本单位（DS 域概念 #1）：同一触发二次到达不建新卡新单。
// cc-deck 落位=dispatch-log 行的 trigger_key 字段（显式域位）——「无 Trigger 键不得
// 开单」（域图 §一 #1 定案）。世代 CAS（org.ts generation）防的是收口侧旧引用，本键
// 防的是入口侧双开（1104 超时重发双开实录）——两半合璧才是完整 I2。
//
// 【挂键纪律——新增派单入口必须带 key（验收点 4 的注释锚）】
// 派单入口（orgAction dispatch / dispatch-remote 对端消化 / 未来新入口）必须：
//   ① 调 dispatchTriggerKey(input) 生成键；② 首行台账落 trigger_key；
//   ③ 入口处过 findInFlightByTriggerKey 查重（内部段链 queue_replay/retry_of/
//   redispatch_of 豁免——同 id 续行非新 Trigger）。
// 绕过单点直开单=审查打回项（静态锁 test-domstep1 断言三行落键点）。
// 豁免面（明示不带键不查重）：drill 假任务行（drill.ts）、org-command/exp/rule
// 审计行（终态 randomUUID 行，非派单生命周期）。
//
// 纯 fs 模块（org.ts 同纪律）：只 import org.js 读账，无环。
// domstep1r1（P1-B 审 B ④）：查重读口必须 readDispatchLogFile **文件直读**——
// readDispatchLog 走读档投影，生产缺省 sqlite 档（read-mode.ts resolveReadMode 缺省
// "sqlite"，2026-10-06 SQLITE-FLIP）dispatch 表无 trigger_key 列（import-dispatch-lesson
// INSERT/UPDATE 列清单+read-mode dispatchEntriesFromDb SELECT 均无此列）→ 幂等闸在
// 缺省档静默恒放行（探针实锤 /tmp/domstep1-review/probe-sqlite2.mts：json 档命中、
// sqlite 档恒 null）。「冲突检查文件=真相源」先例：session-manager.ts 同席活单检查
// 即 readDispatchLogFile（org-write-tx 头注铁律同款）。弃选加列三处同步方案：投影列
// 维护面大，且同族 S3-P4 锚闸 org.ts:508 的 project_anchor 失明仍在（备案入单）——
// 本闸不自建在已失明的投影读口上。测试钉缺省档断言（test-domstep1 A 族）防回退。
import { readDispatchLogFile } from "./org.js";

/** FNV-1a 32 位核——同式 ws-server.ts fnv1a（boardfresh 对账公式锚），不 import 防环
 *  （ws-server→session-manager→本模块会成环）；公式同源注释互指，改一处必改两处。 */
function fnv1aLocal(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 锚归一化（domstep1r1 P2-A② 审 A 1c）：与 dispatchWorker S2 目录锁同款口径——
 *  尾斜杠剥+lowercase。重放必同 cwd 归一后仍同值（1104 防线不损）。 */
function normAnchorForkey(p?: string): string {
  return (p ?? "").replace(/\/+$/, "").toLowerCase();
}

/** 意图首行（domstep1r1 顺手修审 A 1d）：title 缺省回落 prompt 首行；首行空白
 *  （prompt 以换行开头等）回退首个非空行——防 intent="" 使同组此类单共用一键。 */
function intentHeadline(prompt: string): string {
  const first = prompt.split("\n")[0]?.slice(0, 60) ?? "";
  if (first.trim()) return first;
  return (prompt.trim().split("\n")[0] ?? "").slice(0, 60);
}

/** Trigger 键生成单点。配方=来源("dispatch")+域+意图归一化指纹：
 *  - 意图=title 缺省 prompt 首行 slice(0,60)（与建卡文本/boardfix 接卡题名键同口径——
 *    三处对称，改必同步）；空白折叠+lowercase（「修复 A」=「修复a」同意图）。
 *  - 域=gid；**no-gid（随手办）面 anchor 入键**（domstep1r1 P2-A② 审 A 1c）：原空串
 *    域会让不同锚目录同首行 prompt 的两单互误拒（跨目录随手办合法并行被拦）——
 *    anchor 入键后跨锚放行、同锚重放仍同键（重放必同 cwd）。gid 面组锚恒定不受影响。
 *  - slug **不**入键：slug 是 title 的派生函数（leader-dispatch 侧），入键会让
 *    「CLI 带 slug」与「API 不带 slug」两入口的同任务互不查重=幂等面穿孔。
 *  - 来源类型入键（"dispatch"）：未来巡检/回流等新来源各有前缀，同意图不同源可区分。 */
export function dispatchTriggerKey(input: { gid?: string; anchor?: string; title?: string; prompt: string }): string {
  const intent = (input.title?.trim() || intentHeadline(input.prompt) || "")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const domain = input.gid ?? normAnchorForkey(input.anchor);
  return "tk-" + fnv1aLocal("dispatch|" + domain + "|" + intent).toString(16).padStart(8, "0");
}

/** 在途状态集（queued 计在途：编制满排队=已受理未派发，同 Trigger 不得再开） */
export const TRIGGER_IN_FLIGHT: ReadonlySet<string> = new Set(["dispatched", "running", "queued"]);

/** 同 trigger_key 在途查重。口径：
 *  - 状态=末行赢（append-only 同 id 多行，末行状态定在途/终态）；
 *  - 键=**末行赢**（domstep1r1 P2-A① 审 A 1b：原「任意行首行赢」把 id 钉死在首段键——
 *    redispatch_of 换题重投后同 root 新段行落**新输入算的键**（K2），首行赢→对重投单
 *    超时重发（K2）查重不命中=返修单双开不拦（I2 目标族换题链残留）。改末行赢后同
 *    root 以最后带键行的键参与查重，换题重投链闭环；终态行不透传键、不带键的行不
 *    参与更新——原「收口路径改行形不静默洗键」防御语义保留且更严）。
 *  返回在途单 id（命中）或 null。旧行无 trigger_key=不参与查重（零迁移宽容）。 */
export function findInFlightByTriggerKey(key: string, dir?: string): string | null {
  const last = new Map<string, { status: string }>();
  const lastKey = new Map<string, string>();
  for (const r of readDispatchLogFile(dir, 20_000)) {
    if (!r.id) continue;
    last.set(r.id, { status: r.status });
    if (r.trigger_key) lastKey.set(r.id, r.trigger_key); // 末行带键赢（无键行不洗）
  }
  for (const [id, v] of last) {
    if (lastKey.get(id) === key && TRIGGER_IN_FLIGHT.has(v.status)) return id;
  }
  return null;
}
