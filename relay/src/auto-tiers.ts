// ---------- observe3（1104 用户令·架构升级期一②）：自主动作三档 off/observe/auto ----------
// 移植自 DeepSeek Super-agent「主动性三档」（off/observe/auto，observe=研判通过也只记
// 「would do」不执行——干跑）+「注意力经济学」（面板只显需人处理项，健康态零占位）。
// 证据链：w-dsagent-vscc.md §五 #3/#6（A 级=Super-agent docs/000-philosophy+Policy accept mode）。
//
// 【挂档纪律——新增自主动作必须挂档（验收点 5 的注释锚）】
// 凡 relay 侧「无人触发、自主研判、自主执行」的动作（巡检告警/板面自愈/会话拉活等）
// 新增时**必须**过本模块单点读取 `autoTierOf("<family>")` 判档：
//   off     = 连研判都停（完全黑）；observe = 研判照常、动作只 recordWouldDo 不执行；
//   auto    = 照常执行（现网默认，见下方默认映射）。
// 静态锁：relay/scripts/test-observe3.ts 断言三族调用点均引用 autoTierOf——新增族请同步
// AUTO_FAMILIES 与该锁，绕过单点直连执行=审查打回项。
//
// 三族三键（任务书拍板：不搞一个总开关一锅端，DS「少设置」与细粒度平衡）：
//   patrol 族   = 巡检（runLight/runFull 全部告警与清理动作；键 autoPatrol）
//   converge 族 = 板卡台账收敛扫（72h 强翻/断链残留自愈；键 autoConverge）
//   revive 族   = 待办驱动自动拉活（autoReviveManaged；键 autoRevive）
// 【边界声明】以下自主动作面**不入族**（R1 A-7 补全，各带豁免理由）：
// · #PMRESUME（PM 席位续跑）与 #36（中断 WORKING 重启自愈）：用户 1101/1102 实锤点名要
//   的状态恢复（非自主研判动作），有自己的逃生阀（CCR_RESUME_ON_REBOOT）。
// · scanNeedsAuthSessions 探测类：只读不拉，不入族。
// · recoverEngineAfterAuth（ERROR+auth_hint 登录后自动 resume，revive.ts）：auth 恢复链=
//   用户完成登录动作的后续（用户意图已显式），同状态恢复面——挂账待用户口径是否入族。
// · reviveManagedSession（agent-activator 事件驱动复活，revive.ts）：激活器=会话侧 agent
//   自主复活链（非 relay 巡检面），与 autoReviveManaged（待办驱动）不同源——挂账待口径。
//
// 默认值迁移：旧 boolean 键 patrol 存在时按其值映射（true→auto/**false→模块不实例化，
// observe 映射生产不可达**——见 LEGACY_BOOL 注释 R1 口径修正）；三族现网缺省全启用
// →无任何配置时全族 auto（行为零变）。环境变量 CCR_AUTO_TIER_<FAMILY> 最高优先（测试/
// 紧急覆盖，CCR_NO_AUTOREVIVE 逃生阀仍先于 revive 族档位生效——逃生阀恒最高）。
//
// observe 账本：dataDir/observe-log.ndjson append-only（{ts,family,key,action,detail}）
// ——干跑证据链（时序证据落盘），web 面可见性由各动作面的 upsertNotification observe
// 行承载（通知账 day-bucket 防刷屏，revive-stale-todos 先例同款）。
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AutoTier = "off" | "observe" | "auto";
export const AUTO_FAMILIES = ["patrol", "converge", "revive"] as const;
export type AutoFamily = (typeof AUTO_FAMILIES)[number];

const CFG_KEY: Record<AutoFamily, string> = { patrol: "autoPatrol", converge: "autoConverge", revive: "autoRevive" };
/** 旧 boolean 键 → 档位迁移源。**R1 口径修正（A-2a/B-3.2 双认）**：patrol=false 时
 *  PatrolModule 在 index.ts 实例化闸即不启动（CCR_PATROL!==0 && patrol），autoTierOf
 *  无人调用——false→observe 映射**生产不可达**（保留仅防御：未来实例化闸与布尔键解耦时
 *  生效）；实际行为=旧 false 用户维持完全关（安全向：从未启用者不会被动开启自主动作）。 */
const LEGACY_BOOL: Partial<Record<AutoFamily, string>> = { patrol: "patrol" };
const DEFAULT_TIER: Record<AutoFamily, AutoTier> = { patrol: "auto", converge: "auto", revive: "auto" };

function isTier(v: unknown): v is AutoTier {
  return v === "off" || v === "observe" || v === "auto";
}

/** 档位单点读取（验收点 5：一处读取函数）。优先级 env > 配置字符串键 > 旧布尔键迁移 > 缺省。 */
export function autoTierOf(family: AutoFamily): AutoTier {
  const envV = process.env["CCR_AUTO_TIER_" + family.toUpperCase()];
  if (isTier(envV)) return envV;
  try {
    const raw = JSON.parse(readFileSync(process.env.CCR_CONFIG_FILE ?? join(homedir(), ".cc-deck", "config.json"), "utf-8")) as Record<string, unknown>;
    const v = raw[CFG_KEY[family]];
    if (isTier(v)) return v;
    const legacyKey = LEGACY_BOOL[family];
    if (legacyKey && typeof raw[legacyKey] === "boolean") return raw[legacyKey] ? "auto" : "observe"; // 已启用→auto，未启用→observe
  } catch { /* 无配置文件/坏 JSON → 缺省 */ }
  return DEFAULT_TIER[family];
}

/** observe 干跑记账：本会做什么（不执行）。落 dataDir/observe-log.ndjson（append-only 时序证据）。 */
export function recordWouldDo(dataDir: string, family: AutoFamily, key: string, action: string, detail: string): void {
  try {
    appendFileSync(join(dataDir, "observe-log.ndjson"), JSON.stringify({ ts: Date.now(), family, key, action, detail }) + "\n");
  } catch { /* 记账失败不阻断研判路径（observe 面尽力而为） */ }
}

/** observe 通知的 day-bucket revision 键（防刷屏：revive-stale-todos 先例同款按天分桶） */
export function observeBucket(): string {
  return String(Math.floor(Date.now() / 86_400_000));
}
