// P81-1 多引擎权限策略核心（纯函数模块）——specs/081-multi-engine-permission.md
// §4.4「案 A 统一档位外层 + 案 B 引擎原生 detail」+§5「角色/tier 合法组合」+2026-10-06
// 用户拍板（混编团队新卡缺省请求 bypassPermissions）。
//
// **本模块是 P81-1 纯核心，未接线**：接线批=P81-2（摘要投影挂 source_capabilities）、
// P81-3/4（目录/环境维度）、P81-5（写面）——后续单做。本批只 import type 零依赖，
// 不碰 relay 既有源（session-manager/types/projects 等他人域）；wire/协议/存储/UI 零碰。
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
//   2. role/tier 验：§5.2 矩阵外 tier（轻立项/看门狗——081 只列咨询/随手办/正经立项/
//      暂缓冻结四行）→forbidden+reason=tier_not_in_policy_matrix（**备案请裁**：轻立项/
//      看门狗矩阵行待 P81 后续批补）；未知 role→forbidden。
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
//   6. engine×capability 求值 effective（§4.4 :97-99）：confirmed→effective=normalized
//      （仅 claude 填 native_mode——§4.4「native_mode 只有适配器确认后才填」；JSONL 引擎
//      native 词表恒空 §7.1，native_mode 恒 null）；unverified→auto 档逐级降保守（full-auto
//      →edit-auto、edit-auto→ask，reason=native_permission_not_confirmed——「不得将
//      full-auto 伪装成真实审批绕过」；plan/ask 只读/审批面不受累）；unsupported→auto 档
//      降 ask（reason=engine_permission_unsupported）；capability 缺失/未知→ask 保守。
// Claude full-auto→bypassPermissions 须角色+tier+目录+环境四维（§4.4）——**本批只落
// 角色+tier 两维（ceiling 校验即此），目录/环境留 P81-3/4 补**，输入位不设（防半实现
// 假放行：本批 claude+confirmed+ceiling 内→native=bypassPermissions 属中间态，接线批
// 前不得投产，头注钉死）。
export type NormalizedMode = "ask" | "plan" | "edit-auto" | "full-auto";
export type EffectiveMode = NormalizedMode | "forbidden";
export type CapabilityState = "confirmed" | "unverified" | "unsupported";
export type PolicyRole = "team_pm" | "worker" | "review_pm";

import type { PermissionCapabilitySummary } from "./types.js";

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
