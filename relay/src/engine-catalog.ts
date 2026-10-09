// ---------- #75 引擎目录投影（engine_catalog，PM-75 提案 §4.3 契约） ----------
// 源级引擎选择器数据源：六枚举全覆盖投影为 catalog 条目数组，随 SNAPSHOT 下发
//（ws-server/cloud-client 两出口同源引用本函数，#117 教训）。**不另建事实源**：
// state/capabilities/preflight 全部现算自既有面（registry 实况/引擎能力常量/listModels/
// org role_defaults 反查），本件是纯投影零状态。
//
// 投影规则（六枚举逐个有确定分支——提案 §4.3/§5.1）：
//   trae/qwen-code/codebuddy  registry 注册引擎：preflight 实况（共享 preflightEngine
//                             CLI 探测）→ pass=ready / fail=unavailable+reason；能力取
//                             EngineCapabilities 三键；models 恒 []（无源级清单，端上显示
//                             「使用引擎默认」，严禁冒充）。
//   claude                    自证可用（relay 进程即 claude SDK）：state=ready、
//                             preflight=pass、capabilities 全 true（resume 锚/审批挂起/
//                             artifacts 输出面皆实况）；models=listModels（SNAPSHOT.models
//                             同源——claude 专属清单，不跨引擎复用）。
//   codex                     已接入专用分支（thread_id 锚 resume 真）：state=ready、
//                             preflight=codex CLI 存在性探测（复用 preflightEngine——
//                             每回合 spawn codex exec 的前提）；capabilities 按 Codex 会
//                             话实况静态投影（resume=true/approval=false/artifacts=false；
//                             remoteDecisionChannel 是会话级运行时位不进源级 catalog）。
//   zcode                     枚举占位未接入编排：unsupported+灰显原因（提案 §6.1「可在
//                             能力盘点中出现，但不可选」）。
// default_for_roles：org role_defaults 反查——组模板把该引擎配为某角色缺省 ⇒ 角色名入列
//（跨组去重保序）。无组/无预置 ⇒ 空数组。
import { listModels } from "./models.js";
import { preflightEngine } from "./agent-jsonl.js";
import { getEngineDefinition } from "./engine-registry.js";
import { listGroups } from "./projects.js";
import type { EngineCatalogEntry, SessionEngine } from "./types.js";

const SIX_ENGINES: readonly SessionEngine[] = ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"];

/** 源级引擎目录投影（SNAPSHOT source_capabilities.engine_catalog 数据源；每次调用现算
 * ——snapshot 组装频率低（连接/变更时），六个 which 探测微秒级无需缓存）。
 * claudeModelFallback：relay 当前默认模型（两出口传 mgr.cfg.model），与 SNAPSHOT.models
 * 的 listModels 调用同参同源。 */
export function engineCatalogSummary(claudeModelFallback = ""): EngineCatalogEntry[] {
  // default_for_roles 反查源：组模板 role_defaults[role].engine → 引擎 → 角色集
  const rolesByEngine = new Map<SessionEngine, string[]>();
  try {
    for (const g of listGroups()) {
      for (const [role, dflt] of Object.entries(g.role_defaults ?? {})) {
        const e = dflt?.engine;
        if (!e) continue;
        const list = rolesByEngine.get(e) ?? [];
        if (!list.includes(role)) list.push(role);
        rolesByEngine.set(e, list);
      }
    }
  } catch {
    // org 读失败不炸 SNAPSHOT：default_for_roles 全空降级（目录投影面既有防御口径）
  }
  const rolesFor = (e: SessionEngine): string[] => rolesByEngine.get(e) ?? [];

  return SIX_ENGINES.map((id): EngineCatalogEntry => {
    const roles = rolesFor(id);
    if (id === "claude") {
      return {
        id, label: "Claude", state: "ready",
        capabilities: { resume: true, approval: true, artifacts: true },
        preflight: { state: "pass", reason: "" },
        models: listModels(claudeModelFallback),
        default_for_roles: roles,
      };
    }
    if (id === "codex") {
      const pf = preflightEngine({ command: process.env.CCR_CODEX_PATH ?? "codex" });
      return {
        id, label: "Codex",
        state: pf.ok ? "ready" : "unavailable",
        capabilities: { resume: true, approval: false, artifacts: false },
        preflight: pf.ok ? { state: "pass", reason: "" } : { state: "fail", reason: pf.errors.join("；") },
        models: [], // codex 无源级模型清单——端上显示「使用引擎默认」，不冒充
        default_for_roles: roles,
      };
    }
    if (id === "zcode") {
      return {
        id, label: "ZCode", state: "unsupported",
        capabilities: { resume: false, approval: false, artifacts: false },
        preflight: { state: "unknown", reason: "枚举占位未接入编排（不可选）" },
        models: [],
        default_for_roles: roles,
      };
    }
    // registry 注册引擎（trae/qwen-code/codebuddy）——SIX_ENGINES 分支至此仅剩三注册
    // id，def 理论必有；undefined 兜底走 unknown 态（类型窄化助产，不静默炸）
    const def = getEngineDefinition(id);
    if (!def) {
      return { id, label: id, state: "unknown", capabilities: { resume: false, approval: false, artifacts: false }, preflight: { state: "unknown", reason: "注册表缺定义" }, models: [], default_for_roles: roles };
    }
    const pf = def.preflight();
    return {
      id,
      label: def.label,
      state: pf.ok ? "ready" : "unavailable",
      capabilities: {
        resume: def.capabilities?.resume ?? false,
        approval: def.capabilities?.approval ?? false,
        artifacts: def.capabilities?.artifacts ?? false,
      },
      preflight: pf.ok ? { state: "pass", reason: "" } : { state: "fail", reason: pf.errors.join("；") },
      models: [],
      default_for_roles: roles,
    };
  });
}

/** 创建请求的预置引擎可用性判定（COMMAND_CREATE gid/role 预置降级面）：预置引擎不在
 * catalog ready 态 ⇒ 回退默认+降级原因（提案 §6.1「不静默换引擎」——降级必须显式标记）。
 * 显式手动选择不经此（P81 权限闸+preflight 拒绝面既有语义，零改动）。 */
export function catalogReadyEngines(): Set<SessionEngine> {
  return new Set(engineCatalogSummary().filter((e) => e.state === "ready").map((e) => e.id));
}
