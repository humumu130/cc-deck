// P81-1 多引擎权限策略核心（纯函数模块）——specs/081-multi-engine-permission.md
// §4.4「案 A 统一档位外层 + 案 B 引擎原生 detail」+§5「角色/tier 合法组合」+2026-10-06
// 用户拍板（混编团队新卡缺省请求 bypassPermissions）。
//
// **接线状态**：P81-2 已接三入口（SNAPSHOT 摘要/COMMAND_CREATE 闸/dispatchWorker 闸）；
// P81-3/4 落目录/环境两维输入位+环境闸（§6.1）；P81-5 落写面（审计经 StoragePort+spawn
// 传值收口+真实 cwd/env 判定接线，7ab05ba）；P81-6（本批）落旧值规范化
// normalizeLegacyPermissionMode（§5.3.2 旧值映射+§6.3 不声称 bypass）。import type 零
// 运行时依赖不变，wire/协议/存储/UI 零碰。
//
// 归一四档词表（案 A）：ask < plan < edit-auto < full-auto（保守序单向，只准降不准升）。
// 输出形=081 :84-95 落库最小结构八字段全齐（requested/normalized/effective/native/
// capability_state/engine/reason/policy_source）——审计主轴（§4.3「A 更强」）。
// effective_mode 五值：四档+forbidden（**forbidden=拒绝决策非档位**，ACK 层须映射
// ok:false，§5.3.2「显式请求越过允许上限时必须 forbidden，不静默接受」/§6.1 统一拒绝）。
//
// 求值序（fail-closed 铁则贯穿：未知引擎/未知档位/未知角色/矩阵外 tier/capability 缺失
// →保守档或 forbidden，绝不静默升权）：
//   1. engine 词表验：zcode 恒 forbidden（081 :100「ZCode 永远 fail-closed，不能通过
//      手工传 native_mode 绕过 preflight」——本模块输入无 native_mode 位，requested 伪装
//      同样拒）；未知引擎→forbidden。
//   2. role/tier 验：§5.2 矩阵外 tier→forbidden+reason=tier_not_in_policy_matrix
//      （轻立项/看门狗两行已随 P81-2 按 Leader 裁定正式入表——现矩阵六 tier 全覆盖）；
//      未知 role→forbidden。
//   3. requested 归一：显式 wire 值（归一四档+Claude native 兼容值 default/acceptEdits/
//      bypassPermissions——§5.3.1 requested 物化形即 bypassPermissions）→归一档；未知值
//      →forbidden（客户端错/攻击面，不猜）。
//   4. requested 缺席按 policy_source 物化（§5.3.1：混编新卡服务端物化 requested_mode=
//      bypassPermissions 并写审计，不能只依赖端上勾选）：mixed_team_default→PM/worker
//      物化 full-auto（reason 备案物化），review_pm 例外不继承（§5.3.3→plan）；
//      tier_default→§5.2「默认」列；explicit 而 requested 缺席=矛盾输入→ask 保守；
//      未知 policy_source→ask 保守+reason。
//   5. ceiling 校验（§5.2「可用上限」）：normalized 高于 (role,tier) 上限→forbidden
//      above_role_tier_ceiling（不静默降——越权是拒绝面不是降级面）。
//   5.5 环境闸（§6.1，P81-3/4）：full-auto 显式请求遇 production/unknown→统一
//      forbidden（*_bypass_denied）；物化请求→安全降 edit-auto+reason 备案（requested
//      记录不伪装 effective）；unknown×edit-auto→降 ask；ask/plan 只读面不压；双
//      sandbox 开放（§6.1 沙盒按 tier/capability 开放 full-auto）。两维缺席=未启用。
//   6. engine×capability 求值 effective（§4.4 :97-99）：confirmed→effective=normalized
//      （仅 claude 填 native_mode——§4.4「native_mode 只有适配器确认后才填」；JSONL 引擎
//      native 词表恒空 §7.1，native_mode 恒 null）；unverified→auto 档逐级降保守（full-auto
//      →edit-auto、edit-auto→ask，reason=native_permission_not_confirmed——「不得将
//      full-auto 伪装成真实审批绕过」；plan/ask 只读/审批面不受累）；unsupported→auto 档
//      降 ask（reason=engine_permission_unsupported）；capability 缺失/未知→ask 保守。
// Claude full-auto→bypassPermissions 须角色+tier+目录+环境四维（§4.4）——四维已全齐
//（角色+tier 即 ceiling 校验；目录+环境=P81-3/4 环境闸）。**中间态解除（2026-10-06
// P81-3/4 定案）**：native=bypassPermissions 仅可出自 sandbox×sandbox+ceiling 内+
// confirmed 全过路径（正式放行）；production/unknown 下 full-auto 恒拒或降，effective
// ≠full-auto 时 native 恒 null（effectiveFor 结构保证）——「不得创建一个声称已 bypass
// 的会话状态」（§6.3 审计铁律）由此成立。真实 cwd/env 判定接线=P81-5；两维缺席=未启用
//（P81-2 接线闸兼容路径），届时判定缺位须显式传 "unknown" 走 fail-closed。
export type NormalizedMode = "ask" | "plan" | "edit-auto" | "full-auto";
export type EffectiveMode = NormalizedMode | "forbidden";
export type CapabilityState = "confirmed" | "unverified" | "unsupported";
export type PolicyRole = "team_pm" | "worker" | "review_pm";

import type { ManagedPermissionMode, PermissionCapabilitySummary } from "./types.js";

/** wire 兼容请求值→归一档（归一四档直过+Claude native 三兼容值——§5.3.1 物化形
 * bypassPermissions 即走此表归一 full-auto）。表外值=未知档位。 */
const WIRE_TO_NORMALIZED: Record<string, NormalizedMode> = {
  ask: "ask",
  plan: "plan",
  "edit-auto": "edit-auto",
  "full-auto": "full-auto",
  default: "ask",
  acceptEdits: "edit-auto",
  bypassPermissions: "full-auto",
};

/** claude native 映射（§7.1 native_modes；仅 confirmed 且 effective 非 forbidden 时填）。 */
const NATIVE_CLAUDE: Record<NormalizedMode, string> = {
  ask: "default",
  plan: "plan",
  "edit-auto": "acceptEdits",
  "full-auto": "bypassPermissions",
};

/** effective 归一档→spawn 实参（ManagedPermissionMode）映射（P81-5 spawn 传值收口）：
 * 与 NATIVE_CLAUDE 同构（claude 的 native 即 MANAGED 词表值）——JSONL 引擎 native_mode
 * 恒 null（适配器未确认），但 spawn 实参仍按 effective 的 CLI 等价档传（降级后 CLI 收
 * acceptEdits 而非伪装 bypass——「不得将 full-auto 伪装成真实审批绕过」落到实参面）。
 * 纯数据映射零逻辑。 */
export const EFFECTIVE_TO_MANAGED: Record<NormalizedMode, ManagedPermissionMode> = {
  ask: "default",
  plan: "plan",
  "edit-auto": "acceptEdits",
  "full-auto": "bypassPermissions",
};

/** P81-6 旧值规范化类别：identity=新词表内恒等；bypass_demoted=旧 bypass 降档；
 * unknown_reset=词表外未知值 fail-closed 回 default；missing_default=缺字段安全回退。 */
export type LegacyPermKind = "identity" | "bypass_demoted" | "unknown_reset" | "missing_default";

export interface LegacyPermNormalization {
  mode: ManagedPermissionMode;
  kind: LegacyPermKind;
}

/** 存量 state.permission_mode 旧值规范化（P81-6，§5.3.2 旧值映射+§6.3「不得创建声称
 * 已 bypass 的会话状态」）。只降不升铁律：
 * - 词表内三档（default/acceptEdits/plan）恒等——P81-5 后 create 收口写的就是这些；
 * - bypassPermissions→acceptEdits（保守降档，与 §5.3.2「安全降级到 edit-auto/ask」及
 *   环境闸物化降档全库同档）——**调用方须先做 engine 分型**：claude（confirmed 族）
 *   native 真实生效过（spawn 实参真收了 bypass）应保留本函数不适用；JSONL/未知引擎
 *   的 state bypass 从未真实生效（适配器 setPermissionMode no-op+旧直传伪装）才降；
 * - 缺字段/null/空串→default（ask 档语义，native 不设 bypass——映射失败安全回退）；
 * - 词表外任意串（历史 JSONL 污染/external 自报 auto/manual 混入）→default fail-closed
 *   （未知值绝不映射到 bypass——不升权铁断言）。
 * 纯函数零 IO；审计与回写由调用方（session-manager resume 读点）落。 */
export function normalizeLegacyPermissionMode(value: string | null | undefined): LegacyPermNormalization {
  if (value === undefined || value === null || value === "") return { mode: "default", kind: "missing_default" };
  if (value === "default" || value === "acceptEdits" || value === "plan") return { mode: value, kind: "identity" };
  if (value === "bypassPermissions") return { mode: "acceptEdits", kind: "bypass_demoted" };
  return { mode: "default", kind: "unknown_reset" };
}

const ENGINES = ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"] as const;
const ROLES: readonly PolicyRole[] = ["team_pm", "worker", "review_pm"];
const CAPS: readonly CapabilityState[] = ["confirmed", "unverified", "unsupported"];
const CONSERV: Record<NormalizedMode, number> = { ask: 0, plan: 1, "edit-auto": 2, "full-auto": 3 };

/** §5.2 tier×角色「可用上限」矩阵（081 表四行原样；轻立项/看门狗两行=P81-2 接线批按
 * P81-1 验收 Leader 裁定增补——轻立项对齐随手办、看门狗对齐暂缓，裁定溯源
 * docs/reviews/2026-10-06-p811-worker-k.md「裁定」节，081 §5.2 已同步正式增补）。 */
const CEILING: Record<PolicyRole, Record<string, NormalizedMode>> = {
  team_pm: { 咨询: "edit-auto", 随手办: "full-auto", 轻立项: "full-auto", 正经立项: "full-auto", 暂缓: "plan", 看门狗: "plan" },
  worker: { 咨询: "edit-auto", 随手办: "full-auto", 轻立项: "full-auto", 正经立项: "full-auto", 暂缓: "ask", 看门狗: "ask" },
  review_pm: { 咨询: "plan", 随手办: "edit-auto", 轻立项: "edit-auto", 正经立项: "edit-auto", 暂缓: "plan", 看门狗: "plan" },
};

/** §5.2 tier×角色「默认」列（policy_source=tier_default 时物化 requested；轻立项/看门狗
 * 两行同 P81-2 裁定增补——轻立项=随手办值、看门狗=暂缓值）。 */
const TIER_DEFAULT: Record<PolicyRole, Record<string, NormalizedMode>> = {
  team_pm: { 咨询: "plan", 随手办: "edit-auto", 轻立项: "edit-auto", 正经立项: "edit-auto", 暂缓: "plan", 看门狗: "plan" },
  worker: { 咨询: "ask", 随手办: "edit-auto", 轻立项: "edit-auto", 正经立项: "edit-auto", 暂缓: "ask", 看门狗: "ask" },
  review_pm: { 咨询: "plan", 随手办: "plan", 轻立项: "plan", 正经立项: "plan", 暂缓: "plan", 看门狗: "plan" },
};

export interface PolicyInput {
  /** wire 请求值（归一四档或 claude native 兼容值）；缺席=policy_source 物化路径。 */
  requested_mode?: string | null;
  engine: string;
  /** 业务角色（§5.1 team_pm/worker/review_pm；org CommandRole 是另一维，组织写权不经本模块）。 */
  role: string;
  /** §5.2 矩阵四 tier（咨询/随手办/正经立项/暂缓）；矩阵外 fail-closed。 */
  tier: string;
  capability_state?: string | null;
  policy_source?: string | null;
  /** 目录域（§6.1 会话级）：cwd 所属域。**缺席=环境维未启用**（P81-2 接线闸兼容路径——
   * P81-5 接真实 cwd 判定后必传，届时判定缺位须显式传 "unknown" 走 fail-closed）；
   * 显式 "unknown"=判不出→fail-closed 不猜。 */
  dir_scope?: "production" | "sandbox" | "unknown";
  /** 运行环境（§6.1 进程级）：relay 运行环境域。缺席语义同 dir_scope（未启用≠unknown）。 */
  env?: "production" | "sandbox" | "unknown";
}

/** 081 :84-95 落库最小结构（八字段全齐=审计字段锁）。forbidden=拒绝决策非档位。 */
export interface PolicyResult {
  requested_mode: string | null;
  normalized_mode: NormalizedMode | null;
  effective_mode: EffectiveMode;
  native_mode: string | null;
  capability_state: CapabilityState | null;
  engine: string | null;
  reason: string;
  policy_source: string | null;
}

/** forbidden 快捷出口（fail-closed 统一形：effective=forbidden+reason 定位）。 */
function denied(requested: string | null, engine: string | null, cap: CapabilityState | null, source: string | null, reason: string): PolicyResult {
  return { requested_mode: requested, normalized_mode: null, effective_mode: "forbidden", native_mode: null, capability_state: cap, engine, reason, policy_source: source };
}

/** engine×capability→effective 降级链（§4.4 :97-99；降级只向保守单向）。 */
function effectiveFor(engine: string, cap: CapabilityState, normalized: NormalizedMode): { effective: NormalizedMode; native: string | null; reason: string } {
  if (cap === "confirmed") {
    // claude 有已注册 native 词表；JSONL 引擎 native 词表恒空（§7.1）——native_mode 只有适配器确认后才填
    const native = engine === "claude" ? NATIVE_CLAUDE[normalized] : null;
    return { effective: normalized, native, reason: "ok" };
  }
  if (cap === "unverified") {
    // native 未确认不得伪装审批绕过：auto 档逐级降保守；plan/ask 无审批面不受累
    if (normalized === "full-auto") return { effective: "edit-auto", native: null, reason: "native_permission_not_confirmed" };
    if (normalized === "edit-auto") return { effective: "ask", native: null, reason: "native_permission_not_confirmed" };
    return { effective: normalized, native: null, reason: "ok" };
  }
  // unsupported：auto 档无权限管理能力→ask 最保守可用档（仍需人审批，§6.2 引擎无 capability 行）
  if (normalized === "full-auto" || normalized === "edit-auto") return { effective: "ask", native: null, reason: "engine_permission_unsupported" };
  return { effective: normalized, native: null, reason: "ok" };
}

/** 归一档位求值（纯函数：同输入恒同输出，零副作用零 IO——幂等性测试锁）。 */
export function evaluatePermission(input: PolicyInput): PolicyResult {
  const requestedRaw = input.requested_mode ?? null;
  const source = input.policy_source ?? "explicit"; // 缺省=wire 既有显式路径语义
  const capRaw = input.capability_state ?? null;

  // 1. engine 词表+zcode 恒 fail-closed（081 :100，先于一切——手工构造任何请求都拒）
  if (!(ENGINES as readonly string[]).includes(input.engine)) return denied(requestedRaw, input.engine, null, source, "unknown_engine");
  if (input.engine === "zcode") return denied(requestedRaw, input.engine, null, source, "zcode_fail_closed");
  // 2. role/tier 验（§5.2 矩阵外 fail-closed——轻立项/看门狗矩阵行待后续批，备案见头注）
  if (!(ROLES as readonly string[]).includes(input.role)) return denied(requestedRaw, input.engine, null, source, "unknown_role");
  const ceiling = CEILING[input.role as PolicyRole][input.tier];
  if (!ceiling) return denied(requestedRaw, input.engine, null, source, "tier_not_in_policy_matrix");
  // 3. capability 验（§3.2.4 词表 confirmed/unverified/unsupported；缺失/未知→保守不猜）
  const cap: CapabilityState | null = capRaw !== null && (CAPS as readonly string[]).includes(capRaw) ? (capRaw as CapabilityState) : null;
  // 3.5 policy_source 词表验（explicit/tier_default/mixed_team_default；未知→保守 ask 出口
  // 不猜——source 是元数据非权限事实，requested 仍归一留审计，effective 恒保守）
  if (!["explicit", "tier_default", "mixed_team_default"].includes(source)) {
    const nUnknown = requestedRaw !== null ? WIRE_TO_NORMALIZED[requestedRaw] ?? null : null;
    if (requestedRaw !== null && nUnknown === null) return denied(requestedRaw, input.engine, cap, source, "unknown_requested_mode");
    return { requested_mode: requestedRaw, normalized_mode: nUnknown, effective_mode: "ask", native_mode: null, capability_state: cap, engine: input.engine, reason: "unknown_policy_source", policy_source: source };
  }

  // 4. requested 归一/物化（§5.3）
  let requested = requestedRaw;
  let normalized: NormalizedMode;
  let materialized = "";
  if (requested === null) {
    if (source === "mixed_team_default") {
      // §5.3.1/§5.2 混编新开卡：PM/worker 服务端物化 bypassPermissions（=full-auto）写审计；
      // review_pm 例外不继承（§5.3.3→plan）
      if (input.role === "review_pm") {
        requested = "plan";
        normalized = "plan";
        materialized = "mixed_team_default_review_pm_excluded";
      } else {
        requested = "bypassPermissions";
        normalized = "full-auto";
        materialized = "mixed_team_default_materialized";
      }
    } else if (source === "tier_default" || source === "explicit") {
      // tier_default=§5.2「默认」列；explicit 而 requested 缺席=矛盾输入→保守 ask 不猜
      if (source === "explicit") {
        requested = "ask";
        normalized = "ask";
        materialized = "explicit_source_missing_request";
      } else {
        normalized = TIER_DEFAULT[input.role as PolicyRole][input.tier];
        requested = normalized;
      }
    } else {
      return denied(null, input.engine, cap, source, "unknown_policy_source");
    }
  } else {
    const n = WIRE_TO_NORMALIZED[requested];
    if (!n) return denied(requested, input.engine, cap, source, "unknown_requested_mode");
    normalized = n;
  }

  // 5. ceiling 校验（降级面≠越权面）：显式请求越上限必须 forbidden（§5.3.2 不静默接受）；
  // 混编默认是「请求」非显式越权——物化后超 tier 上限时走服务端裁决安全降级到上限档
  //（§5.3.2「按配置选择安全降级到 edit-auto/ask，或返回 forbidden」，本批定降级可用性分支，
  // reason 备案；forbidden 分支留给 P81-3/4 环境维度裁决）
  if (CONSERV[normalized] > CONSERV[ceiling]) {
    if (materialized.startsWith("mixed_team_default")) {
      normalized = ceiling;
      materialized = "mixed_team_default_demoted_to_ceiling";
    } else {
      return denied(requested, input.engine, cap, source, "above_role_tier_ceiling");
    }
  }

  // 5.5 环境闸（§6.1 环境护栏，P81-3/4 落地）。两维**缺席=未启用**短路（P81-2 接线闸
  // 兼容路径，真实 cwd/env 判定接线=P81-5）；显式 "unknown"=fail-closed。威胁优先级
  // production > unknown > sandbox：任一维 production 按 production 规则**单轮裁决**
  //（降级后不再叠 unknown 二次降）；否则任一 unknown 同理；双 sandbox 开放不压。
  //   full-auto 显式请求（非物化）→统一 forbidden（§6.1「显式 bypass 请求若无用户授权
  //   与生产策略许可，返回统一 forbidden ACK」——本批输入位无授权位=无许可）；
  //   full-auto 物化请求→记 requested 不伪装 effective（§6.1「混编默认请求可记录为
  //   requested，但不得伪装为 effective」）→安全降 edit-auto（§5.3.2 降级目标档，生产
  //   禁列仅 full-auto=生产允许档 edit-auto）；
  //   edit-auto：production 不压；unknown 降 ask（信息不足连自动编辑也收——显式/物化
  //   同待遇，§5.3.2「安全降级到 edit-auto/ask」ask 侧）；
  //   ask/plan 只读面不受环境维压制（§6.1 禁列不含此二者）。
  const dScope = input.dir_scope ?? null;
  const eScope = input.env ?? null;
  if (dScope !== null || eScope !== null) {
    const prod = dScope === "production" || eScope === "production";
    const unk = dScope === "unknown" || eScope === "unknown";
    if (prod || unk) {
      const threat = prod ? "production" : "env_unknown";
      if (normalized === "full-auto") {
        if (materialized === "") {
          return denied(requested, input.engine, cap, source, `${threat}_bypass_denied`);
        }
        normalized = "edit-auto";
        materialized = `${threat}_demoted_from_full_auto`;
      } else if (normalized === "edit-auto" && !prod) {
        normalized = "ask";
        materialized = "env_unknown_demoted_from_edit_auto";
      }
    }
  }

  // 6. engine×capability 求值 effective（capability 缺失/未知→ask 保守，native 恒 null）
  if (cap === null) {
    return { requested_mode: requested, normalized_mode: normalized, effective_mode: "ask", native_mode: null, capability_state: null, engine: input.engine, reason: "capability_state_missing", policy_source: source };
  }
  const ev = effectiveFor(input.engine, cap, normalized);
  // reason 优先级：降级/拒绝事实 > 物化备案（物化已由 requested_mode+policy_source 承载）
  const reason = ev.reason !== "ok" ? ev.reason : materialized !== "" ? materialized : "ok";
  return {
    requested_mode: requested,
    normalized_mode: normalized,
    effective_mode: ev.effective,
    native_mode: ev.native,
    capability_state: cap,
    engine: input.engine,
    reason,
    policy_source: source,
  };
}

// ---------- P81-2 只读摘要面（SNAPSHOT source_capabilities.permission 数据源） ----------

/** 引擎→capability_state 静态事实映射（081 §3.1 表+§7.1「必须真实反映当前代码」）：
 * claude=SDK 内嵌恒 confirmed；JSONL 四引擎 approval=false/native 未确认=unverified；
 * zcode=未进 Registry 恒 unsupported。纯静态不跑 preflight 动态探测（「从既有面读出，
 * 不新算」——M12-5 preflight 是 spawn 前检查非 profile 源）。词表外引擎=unsupported 保守。 */
export function engineCapabilityState(engine: string): CapabilityState {
  if (engine === "claude") return "confirmed";
  if (engine === "codex" || engine === "trae" || engine === "qwen-code" || engine === "codebuddy") return "unverified";
  return "unsupported"; // zcode 及未知引擎（fail-closed 保守标注）
}

/** 该 capability_state 下保证按请求档生效的归一档集（P75 引擎选择器「上限」读数）：
 * confirmed=四档全；unverified=auto 档会降级（full-auto→edit-auto、edit-auto→ask）只剩
 * ask/plan 恒真；unsupported（注册表内仅 zcode，evaluatePermission 恒 forbidden）=空集。 */
function guaranteedModes(cap: CapabilityState): NormalizedMode[] {
  if (cap === "confirmed") return ["ask", "plan", "edit-auto", "full-auto"];
  if (cap === "unverified") return ["ask", "plan"];
  return []; // unsupported=zcode fail-closed，全拒无可用档
}

/** 六注册引擎权限能力只读摘要（SNAPSHOT 组装数据源，ws-server :950/cloud-client :440
 * 两出口同发——#117 双发教训）。零 IO 零动态探测，纯静态表投影。 */
export function permissionCapabilitiesSummary(): PermissionCapabilitySummary[] {
  return (ENGINES as readonly string[]).map((engine) => {
    const cap = engineCapabilityState(engine);
    return { engine: engine as PermissionCapabilitySummary["engine"], capability_state: cap, modes: guaranteedModes(cap) };
  });
}

// ---------- P81-9 kill-switch（specs/081 §8.2.4 发布闸门与回滚） ----------

/** P81 权限策略总开关（env 单点，CCR_* 惯例）。回退契约 §8.2.4「P81 实施失败：保留
 * 现有四档 wire 契约，关闭新 normalized policy 入口」——off = 完整回 P81 前行为：
 * 开卡求值走旧直通、四闸跳过、forbidden 面缺席、SNAPSHOT 摘要停发（端上经 P81-8
 * 双端 undefined 降级面自动隐藏=三端自动还原）、旧卡续跑原值直读。
 * 词表：未设/空/on/1/true（大小写不敏感）=开；off/0/false=关；**未知值 fail-safe
 * 当关**并 console.warn——回退场景宁可多退，不可该退没退成。默认=开（新 policy 生效）。
 * 纯函数零副作用（warn 除外），每求值点现读 env——测试可逐断言翻转。 */
export function permissionPolicyEnabled(): boolean {
  const raw = process.env.CCR_PERMISSION_POLICY;
  if (raw === undefined || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return true;
  if (v === "off" || v === "0" || v === "false") return false;
  console.warn(`[p81-kill-switch] CCR_PERMISSION_POLICY 未知值 "${raw}"——按 off（回退 P81 前）处理`);
  return false;
}
