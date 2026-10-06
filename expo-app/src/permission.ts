// P81-8E 权限摘要 expo 呈现纯函数（expo 域）。
// 零依赖纯 TS（不 import react/react-native）——SettingsDrawer/NewSessionModal/
// DetailScreen 消费 + scripts/test-e-permission-summary.ts 直跑断言共用同一条映射
// 路径（notify-jump.ts / artpool.ts 同范式：测的就是跑的）。
//
// 数据源（只读，端上零求值零 policy 复制——求值权威在 relay P81-3/5 evaluatePermission，
// 端上只做人话映射与存在性降级）：
// - SNAPSHOT source_capabilities.permission[]（P81-2）：{engine, capability_state,
//   confirmed|unverified|unsupported, modes[]}——静态投影，端上不判能力只呈现；
// - COMMAND_CREATE ACK（P81-5）：成功带 permission{normalized,effective,native_mode,
//   reason}（effective≠normalized=发生降级）；forbidden 拒绝走 ok:false +
//   error="forbidden: <reason 码>"（relay session-manager :2083 构造形）。
//
// 三端统一词表（钉死，与 web 半同段——勿改字面）：capability_state 三态 / 档位五档
// / forbidden reason 码人话九条。词表外 reason 码兜底「已拒绝（<原码>）」不吞不猜。

// ---------- capability_state 三态词 ----------
export const PERM_CAP_STATE_LABEL = {
  confirmed: "完整支持",
  unverified: "未验证 · 请求档可能降级",
  unsupported: "不支持 · 不可开卡",
} as const;
export type PermCapState = keyof typeof PERM_CAP_STATE_LABEL;

// ---------- 档位词（五档含 forbidden——forbidden 只出现在拒绝面，不是运行档） ----------
export const PERM_MODE_LABEL: Record<string, string> = {
  default: "每次询问",
  acceptEdits: "自动接受编辑",
  plan: "计划模式",
  bypassPermissions: "完全自动",
  forbidden: "已拒绝",
};

// ---------- forbidden reason 码人话（九条钉死） ----------
export const PERM_FORBIDDEN_REASON: Record<string, string> = {
  capability_state_missing: "引擎能力未确认，已降为每次询问",
  unknown_requested_mode: "未知权限档",
  unknown_engine: "未知引擎",
  zcode_fail_closed: "该引擎不支持权限控制",
  above_role_tier_ceiling: "超出岗位权限上限",
  production_bypass_denied: "生产环境禁止完全自动档",
  env_unknown_bypass_denied: "环境不明，禁止完全自动档",
  unknown_role_mapping: "岗位未映射，已拒绝",
  mixed_engine: "混编引擎，按保守档",
};

// forbidden 错误串 → 人话。非 forbidden 形（网络错/未知命令/其他业务错）返回 null
// 交调用方走原样透传——本函数只接管 forbidden 拒绝面。relay 构造形 =
// "forbidden: <reason>"（session-manager :2083）；容忍前后空白。
export function forbiddenReasonOf(err: unknown): string | null {
  if (typeof err !== "string") return null;
  const m = err.trim().match(/^forbidden:\s*(\S+)\s*$/);
  if (!m) return null;
  const code = m[1]!;
  return PERM_FORBIDDEN_REASON[code] ?? `已拒绝（${code}）`;
}

// ---------- SNAPSHOT permission[] 鸭子收容（旧 relay 降级面） ----------

// 收容形态（与 relay PermissionCapabilitySummary 同构、本地独立定义——expo protocol
// 是独立冻结面不 import relay types）。畸形条目剔除不炸；permission 字段 undefined
// （旧 relay 不发）→ []，调用方以 []/undefined 判摘要隐藏（E 线 artpool 同款降级范式）
export interface PermSummary {
  engine: string;
  capability_state: PermCapState;
  modes: string[];
}

export function permissionSummariesOf(raw: unknown): PermSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: PermSummary[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (typeof o.engine !== "string" || !o.engine) continue;
    if (o.capability_state !== "confirmed" && o.capability_state !== "unverified" && o.capability_state !== "unsupported") continue;
    out.push({
      engine: o.engine,
      capability_state: o.capability_state,
      modes: Array.isArray(o.modes) ? o.modes.filter((m): m is string => typeof m === "string" && !!m) : [],
    });
  }
  return out;
}

// relay 归一档（P81-2 modes 载荷 / P81-5 ACK normalized、effective 的值域）→ 词表
// 档键静态别名——对表 relay permission-policy NATIVE_CLAUDE / EFFECTIVE_TO_MANAGED
//（纯数据映射零求值零 policy 复制：只是把 relay 内部档名译到三端词表键，词表字面
// 本身钉死不动）。词表外值经 ?? m 原样保留不吞——呈现层不猜
const NORMALIZED_MODE_ALIAS: Record<string, string> = {
  ask: "default",
  plan: "plan",
  "edit-auto": "acceptEdits",
  "full-auto": "bypassPermissions",
};

// 单档 → 人话词（别名先行再词表，词表外原样）
function modeWord(m: string): string {
  return PERM_MODE_LABEL[NORMALIZED_MODE_ALIAS[m] ?? m] ?? m;
}

// 档集 → 词表串（「每次询问 / 自动接受编辑」形态）；空档集 → 空串（unsupported 行
// 不显档集只显态词）。modes 里未知档（词表外）原样保留不吞——呈现层不猜
export function permissionModesText(modes: string[]): string {
  return modes.map(modeWord).join(" / ");
}

// ---------- 开卡引擎禁选判定 ----------

// unsupported → 禁选+原因（词表态词）；摘要缺失（旧 relay undefined / 该引擎无条目）
// → 不设防放行（旧 relay 无 P81 面，行为与升级前一致；条目缺失=relay 未注册该引擎，
// 端上不越权代判）。engine 用原串比较（expo 侧 engine 是自由串，无本地枚举）
export function engineCreateBlock(summaries: PermSummary[] | undefined, engine: string): string | null {
  if (!summaries) return null;
  const hit = summaries.find((s) => s.engine === engine);
  if (!hit) return null;
  return hit.capability_state === "unsupported" ? PERM_CAP_STATE_LABEL.unsupported : null;
}

// ---------- ACK 成功降级提示（成功面；forbidden 拒绝面走 forbiddenReasonOf） ----------

// ACK permission{normalized, effective} → 降级提示人话；无降级（effective===normalized
// 或字段缺失）→ null 无提示。ok:false 时调用方绝不消费本函数（forbidden 走错误面）——
// ACK ok:false 绝不造本地成功状态（E2c 判定门既有三态语义保持）
export function effectiveNoteOf(p: { normalized?: unknown; effective?: unknown } | null | undefined): string | null {
  if (!p || typeof p !== "object") return null;
  const { normalized, effective } = p;
  if (typeof normalized !== "string" || typeof effective !== "string" || !normalized || !effective) return null;
  if (effective === normalized) return null;
  const from = modeWord(normalized);
  const to = modeWord(effective);
  if (effective === "forbidden") return `请求的权限档被拒绝（${from}），会话未创建`;
  return `已按「${to}」创建（请求档「${from}」被调整）`;
}
