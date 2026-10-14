// Relay <-> 客户端协议子集（与 relay/src/types.ts 保持同步）
import { permissionSummariesOf, type PermSummary } from "./permission";

export type SessionStatus = "WORKING" | "WAITING" | "ERROR" | "DONE";

export interface FileChangeStats {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type ActivityKind = "tool_use" | "tool_result" | "assistant_text" | "system";

export interface ActivityCapabilities {
  native_status: boolean;
  operation_summary: boolean;
  native_elapsed: boolean;
  approval: boolean;
}

export interface StatusDockState {
  state: SessionStatus;
  task_summary?: { text: string; source: "todo" | "dispatch" | "board" | "session"; updated_at: number };
  activity?: { kind: ActivityKind; text: string; tool?: string; observed_at: number; occurred_at?: number };
  elapsed_ms?: number;
  capabilities: ActivityCapabilities;
  updated_at: number;
}

export interface SessionActivityPayload {
  session_id: string;
  state: SessionStatus;
  activity_kind: ActivityKind;
  text: string;
  tool?: string;
  observed_at: number;
  occurred_at?: number;
  capabilities: ActivityCapabilities;
  seq_local: number;
}

// P81-2 每引擎权限能力只读摘要（SNAPSHOT source_capabilities.permission 载荷）：
// 端上零求值零 policy 复制——静态投影只呈现（人话映射在 src/permission.ts）。
// 旧 relay 不发 = undefined，摘要区隐藏（字段存在性降级）。类型别名=permission.ts
// PermSummary 单口径（鸭子校验/收容同一把尺，防双定义漂移）
export type PermissionCapabilitySummary = PermSummary;

export interface SourceCapabilities {
  models?: boolean;
  activity?: boolean;
  notifications?: boolean;
  // P81-2 权限能力摘要：六注册引擎逐个只读投影（ws-server/cloud-client 两出口同发）。
  // 旧 relay 不发 = undefined（摘要隐藏不白屏）
  permission?: PermissionCapabilitySummary[];
  // 75-E 引擎目录：源级可用引擎清单（状态/预检/能力/模型），新建会话选择器数据源。
  // 旧 relay（75-R 未落地）不发 = undefined（选择器降级旧默认路径，见 engineSummaryLine）
  engine_catalog?: EngineCatalogEntry[];
  // M13-2：relay 支持 v2 delta 投影协议（LAN/phone 双出口同发，WAN 极简集不带）。
  // 缺席/undefined = 旧 relay，UPDATED 帧按覆盖式消费（不认 delta）。注意语义边界：
  // 「支持 v2 协议」≠「值域已迁五态」——消费侧按值分组，值域迁移前后都不出假泳道
  projection_v2?: boolean;
  commands?: string[];
  [key: string]: boolean | string[] | PermissionCapabilitySummary[] | EngineCatalogEntry[] | undefined;
}

// ─── 75-E 引擎目录（SNAPSHOT source_capabilities.engine_catalog 载荷，三端同构
// 契约，与 PM-75 提案 §4.3 / relay 75-R / web 75-W 同形状同词表） ───

export type EngineCatalogState = "ready" | "unavailable" | "needs_auth" | "unsupported" | "unknown";

export interface EngineCatalogEntry {
  id: string;
  label?: string;
  state: EngineCatalogState;
  capabilities?: { resume: boolean; approval: boolean; artifacts: boolean };
  preflight?: { state: "pass" | "fail" | "unknown"; reason?: string };
  models?: string[];
  default_for_roles?: string[];
  /** #102 批 A/B：state=needs_auth 时的登录指引（relay auth_hint；批 B 起可点行拉起登录卡） */
  auth_hint?: string;
}

// 三端状态词表（钉死，与 75-W/75-R 逐字一致——勿改字面；needs_auth #102 批 A 增补）
export const ENGINE_STATE_LABEL: Record<EngineCatalogState, string> = {
  ready: "可用",
  unavailable: "未安装或校验未过",
  needs_auth: "未登录 · 点此扫码登录",
  unsupported: "不支持 · 不可选",
  unknown: "状态未知",
};

// 固定短语（钉死，跨端同词）：摘要行/浮层/降级提示共用
export const ENGINE_PHRASES = {
  legacyRelayHint: "升级 relay 可选择更多引擎",
  onlyAvailable: "仅可用",
  overrideTag: "已覆盖预置",
  engineDefaultModel: "使用引擎默认",
  preflightFail: "预检未通过",
  basicExec: "基础执行",
  autoSourceDefault: "自动（源默认）",
  downgrade: "已降级",
} as const;

const ENGINE_STATES: readonly EngineCatalogState[] = ["ready", "unavailable", "needs_auth", "unsupported", "unknown"];

function normalizeEngineCatalogEntry(value: unknown): EngineCatalogEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.state !== "string" || !ENGINE_STATES.includes(value.state as EngineCatalogState)) return null;
  const capsSrc = isRecord(value.capabilities) ? value.capabilities : null;
  const preSrc = isRecord(value.preflight) ? value.preflight : null;
  const preState = preSrc !== null && typeof preSrc.state === "string" ? preSrc.state : null;
  const models = Array.isArray(value.models) && value.models.every((x) => typeof x === "string") && value.models.length
    ? (value.models as string[])
    : undefined;
  const roles = Array.isArray(value.default_for_roles) && value.default_for_roles.every((x) => typeof x === "string") && value.default_for_roles.length
    ? (value.default_for_roles as string[])
    : undefined;
  return {
    id: value.id,
    ...(typeof value.label === "string" && value.label ? { label: value.label } : {}),
    state: value.state as EngineCatalogState,
    ...(capsSrc
      ? { capabilities: { resume: capsSrc.resume === true, approval: capsSrc.approval === true, artifacts: capsSrc.artifacts === true } }
      : {}),
    ...(preSrc !== null && (preState === "pass" || preState === "fail" || preState === "unknown")
      ? { preflight: { state: preState, ...(typeof preSrc.reason === "string" && preSrc.reason ? { reason: preSrc.reason } : {}) } }
      : {}),
    ...(models ? { models } : {}),
    ...(roles ? { default_for_roles: roles } : {}),
    ...(typeof value.auth_hint === "string" && value.auth_hint ? { auth_hint: value.auth_hint } : {}),
  };
}

/** engine_catalog 鸭子收容（normalizeSourceCapabilities 特判用，permissionSummariesOf
 * 同一把尺）：非数组/全畸形条目 → undefined（=旧 relay 降级，选择器隐藏不出假清单）；
 * 混入畸形条目剔除其余透出。字段级宽容：label/capabilities/preflight/models/
 * default_for_roles 畸形各自降缺省，id+state 合法即收 */
export function engineCatalogOf(value: unknown): EngineCatalogEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: EngineCatalogEntry[] = [];
  for (const item of value) {
    const entry = normalizeEngineCatalogEntry(item);
    if (entry) out.push(entry);
  }
  return out.length ? out : undefined;
}

/** 引擎名解析（label 缺省回落 id——旧 relay ACK 降级提示等无目录场景 id 原样可读） */
export function engineLabelOf(entry: Pick<EngineCatalogEntry, "id" | "label">): string {
  return entry.label ?? entry.id;
}

/** 引擎可选性判定（NewSessionModal 选择器行灰显+禁选，permission.engineCreateBlock
 * 同思路；端上零求值只读目录）：unsupported / unavailable → 禁选（preflight.reason
 * 在场优先显原因——relay 投影把「枚举占位未接入编排」等具体原因也放 reason（75-R
 * 实测 zcode），无 reason 兜底词表态词）；preflight fail → 原因/固定词；ready /
 * unknown → 放行（unknown 状态未知不禁——relay 创建时兜底校验，端上不探测不代判） */
export function engineSelectable(entry: EngineCatalogEntry): string | null {
  if (entry.state === "unsupported") return entry.preflight?.reason || ENGINE_STATE_LABEL.unsupported;
  if (entry.state === "unavailable") return entry.preflight?.reason || ENGINE_STATE_LABEL.unavailable;
  // #102 批 B：未登录禁选但可点登录（NewSessionModal 行内拉起登录卡，扫码即登录）
  if (entry.state === "needs_auth") return entry.auth_hint || ENGINE_STATE_LABEL.needs_auth;
  if (entry.preflight?.state === "fail") return entry.preflight.reason || ENGINE_PHRASES.preflightFail;
  return null;
}

// ─── #102 批 B 引擎登录引导（AUTH_REQUIRED 瞬态载荷；与 relay types.ts
// AuthRequiredPayload / web LoginCard 同构三端契约） ───

export type EngineLoginFlowState = "starting" | "pending" | "ready" | "timeout" | "error" | "cancelled";

export interface AuthRequiredPayload {
  flow_id: string;
  engine: string;
  state: EngineLoginFlowState;
  mode: "qr" | "browser" | "hint";
  url?: string;
  qr_text?: string;
  hint: string;
  ts?: number;
}

const LOGIN_FLOW_STATES: readonly EngineLoginFlowState[] = ["starting", "pending", "ready", "timeout", "error", "cancelled"];

/** AUTH_REQUIRED 载荷鸭子校验（畸形帧 null——不覆盖既有卡，relay 侧必发合法形状） */
export function normalizeAuthFlow(value: unknown): AuthRequiredPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.engine !== "string" || !value.engine) return null;
  if (typeof value.flow_id !== "string" || !value.flow_id) return null;
  if (typeof value.state !== "string" || !LOGIN_FLOW_STATES.includes(value.state as EngineLoginFlowState)) return null;
  const mode = value.mode === "qr" || value.mode === "browser" || value.mode === "hint" ? value.mode : "hint";
  return {
    flow_id: value.flow_id,
    engine: value.engine,
    state: value.state as EngineLoginFlowState,
    mode,
    ...(typeof value.url === "string" && value.url ? { url: value.url } : {}),
    ...(typeof value.qr_text === "string" && value.qr_text ? { qr_text: value.qr_text } : {}),
    hint: typeof value.hint === "string" ? value.hint : "",
    ...(typeof value.ts === "number" ? { ts: value.ts } : {}),
  };
}

/** 预置引擎推导（目录读侧，零求值）：default_for_roles 非空的第一个条目 = 预置；
 * 无 → null（源默认） */
export function enginePresetOf(catalog: EngineCatalogEntry[]): EngineCatalogEntry | null {
  for (const e of catalog) {
    if (Array.isArray(e.default_for_roles) && e.default_for_roles.length) return e;
  }
  return null;
}

/** 摘要行模型（「引擎 / 模型」行渲染输入）：headline 主句 + sub 副行提示 +
 * overridable 可点开选择器（旧 relay 仍可点——codex 旧偏好取消入口不删，兼容行为
 * 保留；单引擎不可改） */
export interface EngineSummaryLine {
  headline: string;
  sub: string | null;
  overridable: boolean;
}

/** 摘要行三段矩阵（降级面钉死形态，派单作业③）：
 *   旧 relay（catalog undefined）→「默认引擎 | <记忆引擎 id>」+ 升级提示，可点（取消入口）
 *   单引擎 →「仅可用：X」不可改（无更改箭头）
 *   多引擎 auto →「自动（<Role> 预置） · <引擎> · <模型>」/ 无预置 →「自动（源默认）」
 *   手动覆盖 →「<引擎> · <模型 | 使用引擎默认>」+ 副行「已覆盖预置」
 */
export function engineSummaryLine(input: {
  catalog: EngineCatalogEntry[] | undefined;
  selected: string; // "auto" | 引擎 id
  model: string | null;
}): EngineSummaryLine {
  const cat = input.catalog;
  if (!cat || !cat.length) {
    return { headline: input.selected === "auto" ? "默认引擎" : input.selected, sub: ENGINE_PHRASES.legacyRelayHint, overridable: true };
  }
  if (cat.length === 1) {
    return { headline: `${ENGINE_PHRASES.onlyAvailable}：${engineLabelOf(cat[0])}`, sub: null, overridable: false };
  }
  if (input.selected === "auto") {
    const preset = enginePresetOf(cat);
    if (preset) {
      const role = preset.default_for_roles![0];
      const roleCap = role.charAt(0).toUpperCase() + role.slice(1);
      const model = preset.models && preset.models.length ? ` · ${preset.models[0]}` : "";
      return { headline: `自动（${roleCap} 预置） · ${engineLabelOf(preset)}${model}`, sub: null, overridable: true };
    }
    return { headline: ENGINE_PHRASES.autoSourceDefault, sub: null, overridable: true };
  }
  const sel = cat.find((x) => x.id === input.selected);
  if (!sel) return { headline: ENGINE_PHRASES.autoSourceDefault, sub: null, overridable: true }; // 失效 id 兜底回自动
  return { headline: `${engineLabelOf(sel)} · ${input.model ?? ENGINE_PHRASES.engineDefaultModel}`, sub: ENGINE_PHRASES.overrideTag, overridable: true };
}

/** ACK engine 与请求不一致 → 降级 toast 文案（复用 effectiveNoteOf 的 notifyCmdError
 * 通道，不静默；派单作业③）。acked 非 string / 空 / 相等 / requested 为 null（自动档
 * 不指定引擎）→ null 不提示——acked=undefined 是旧 relay ACK（75-R 未落地），字段
 * 存在性消费不误报。labelOf 供调用方传目录 label 查表（缺省 id 原样） */
export function engineDowngradeNote(requested: string | null, acked: unknown, labelOf: (id: string) => string = (id) => id): string | null {
  if (!requested || typeof acked !== "string" || !acked || acked === requested) return null;
  return `${ENGINE_PHRASES.downgrade}：请求引擎 ${labelOf(requested)}，实际 ${labelOf(acked)}`;
}

export interface NotificationItem {
  key: string;
  kind: string;
  group: string;
  severity: string;
  title: string;
  body: string;
  sourceContext: { domain: string; entityId: string; sessionId?: string; segment?: string; alertId: string; returnPath: string };
  actionable: boolean;
  created_at: number;
  resolved_at?: number;
  handled_at?: number;
}

export interface NotificationsUpdatedPayload {
  items: NotificationItem[];
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  header: string;
  question: string;
  multi?: boolean;
  options: AskOption[];
}

export interface WaitingPayload {
  request_id: string;
  tool_name: string;
  input_summary: string;
  suggestions: string[];
  questions?: AskQuestion[]; // AskUserQuestion 结构化问题（存在时渲染选项点选作答）
  decidable?: boolean;
  received_at?: number;
  // #212 允许并记住：存在 = 可记忆（非危险形态），渲染「记住」入口；作答发
  // COMMAND_CONTINUE + remember_scope（relay 落规则）。旧 relay 无此字段
  remember?: { pattern: string; label: string };
}

// #212 记住的规则（relay AllowRule 镜像）：SNAPSHOT.allow_rules / ALLOW_RULES_UPDATED 携带
export interface AllowRule {
  id: string;
  scope: "session" | "global";
  session_id?: string;
  tool: string;
  pattern: string; // Bash=命令前缀；Edit 族=目录前缀；其他="*"（工具级）
  created_at: number;
  created_by: string;
}

// #17 第二批 雇员独立家设置（relay 三层合成镜像）：SNAPSHOT.settings /
// SETTINGS_UPDATED 携带。source = 生效来源（env=环境变量锁定 UI 只读；file=设置项；
// default=新装/存量推导）
export interface EmployeeHomeSettings {
  employee_home: boolean;
  value: string | null;
  source: "env" | "file" | "default";
}

export interface TodoItem {
  id?: number; // CLI 任务库任务号（转录 #NNN 跳转定位；旧 TodoWrite 清单无）
  content: string;
  status: "pending" | "in_progress" | "completed";
  active_form?: string;
  updated_at?: number;
}

// #35 会话输出物（relay ArtifactItem 镜像）：Write/Edit/MultiEdit/NotebookEdit 四类
// 文件工具的产出清单；整表替换语义（SESSION_UPDATED/SNAPSHOT 携带）
export type ArtifactOp = "create" | "edit";

export interface ArtifactItem {
  path: string;        // 绝对路径（相对入参已按会话 cwd 补全）
  op: ArtifactOp;      // 会话内新建过 → "create"（后继 Edit 不降级）
  tools: string[];
  adds: number;
  dels: number;
  first_at: number;
  last_at: number;
  size?: number;       // 最近一次 stat 字节数（缺省不显）
  exists?: boolean;    // false → 「已删除」态
  origin?: "cwd" | "outside";
}

// 定时任务（CLI 会话 .claude/scheduled_tasks.json 的宽容解析快照，relay 30s 轮询下发）
export interface CronTask {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  next_run_at?: number;
  paused?: boolean;
  recurring?: boolean; // false = 一次性
}

export interface SessionState {
  session_id: string;
  relay_session_id: string;
  cwd: string;
  initial_prompt: string;
  title: string;
  model: string;
  status: SessionStatus;
  action_summary: string;
  started_at: number;
  updated_at: number;
  activity?: StatusDockState; // optional: old relay snapshots omit activity
  activity_capabilities?: ActivityCapabilities; // optional: capability-aware downgrade
  waiting_request?: WaitingPayload | null;
  stats: FileChangeStats;
  last_error?: string;
  done_reason?: string;
  duration_ms?: number;
  historical?: boolean;
  external?: boolean;
  pinned?: boolean; // #49 保存恢复：置顶跨重启保留（重启后休眠登记，点卡按需拉起）
  saved?: boolean;  // #49 休眠标记：已保存未拉起；仅非运行态可作休眠卡（恢复入口，#139 口径）
  remote_mode?: boolean;
  cli_pid?: number;
  elapsed_hint?: number;
  turn_started_at?: number;
  usage?: TokenUsage;
  context_usage?: number; // 当前上下文水位 tokens（最后一条 assistant 的 usage；水位条数据源）
  context_limit?: number; // 上下文窗口上限（relay 按模型下发；缺省兜底 200k）
  todos?: TodoItem[];
  title_locked?: boolean;
  permission_mode?: "default" | "acceptEdits" | "plan" | "bypassPermissions"; // 托管会话权限模式（skip 会话 init 即 bypass，切换器四档循环）
  pending_inputs?: PendingInput[]; // 外部会话已发送未处理的注入消息（显示在工作指示器下方，处理时上浮为正式消息）
  subagents?: SubagentEntry[]; // 并行子 Agent（⑂）：运行中/刚结束的后台任务状态
  cron_tasks?: CronTask[]; // 定时任务快照（[] = 已清空）
  artifacts?: ArtifactItem[]; // #35 输出物清单（整表替换；手机端查看路径/统计，不能打开）
  artifacts_truncated?: boolean; // #35 超 200 条截断标记（列表尾提示）
  compacting?: boolean;    // true = CLI 正在压缩上下文（Compacting conversation…），转录静默期防误判卡死
  // 最近一次任务完成汇报（#254）：瞬态 TASK_DONE 断线丢失时，端上从快照恢复未读汇报。
  // remaining_count 是数字（剩余条数）——与 TASK_DONE 事件的 remaining（TodoItem[]）同名异型，故改名区分
  last_task_done?: { done: string[]; remaining_count: number; ts: number };
  // 归属源 id（#294 聚合模式）：纯客户端字段，relay 不下发——store 快照平铺时写入，
  // 列表源角标/详情页源标注用。sid 为 uuid 全局唯一，可作跨源主键；单源模式不写
  // （watch 网关直发 snap.sessions，保持手表快照字节不变）
  src?: string;
  // #26 M2 组织归属：project_gid = 所属项目组（卡徽标 [组名] 与组详情编制的数据源）；
  // dispatch_tier = 派单档位（随手办/轻立项/正经立项）。旧 relay 不带 = 无组织域
  project_gid?: string;
  dispatch_tier?: string;
  // #27 引擎标记：undefined = claude；"codex" = CodexAgentSession（codex exec
  // 驱动）。卡片「托管/Codex」徽标数据源；旧 relay 不带 = claude
  engine?: string;
}

// ---------- #26 M2 组织域（v3.1 矩阵式；relay projects.ts 镜像） ----------
// 项目组（SNAPSHOT.projects / PROJECTS_UPDATED 携带；结项=archived 单向终态）
export interface ProjectGroup {
  id: string;
  name: string;
  anchor_dir: string;
  tier: "轻立项" | "正经立项";
  status: "pending" | "active" | "parked" | "archived";
  created_at: number;
  updated_at: number;
  // 对齐 relay wire（projects.ts ProjectHeadcountEntry）：joined_at 是幽灵字段
  // （relay 全库不存在），engine/model/provider 随条目下发；nick=席位别名
  // （relay sanitizeHeadcount 透传，UIPOLISH3 件十⑤ 成员卡显示名优先级 nick>会话名）
  headcount?: { session_id: string; role: string; engine?: string; model?: string; provider?: string; nick?: string }[];
  // wire 有而 expo 未消费，先补声明防漂移（组挂起/结项/暂缓建议时刻 + 结项一句话）
  parked_at?: number;
  archived_at?: number;
  hold_suggested_at?: number;
  archive_note?: string;
}

// 待决议确认卡（SNAPSHOT.org_confirms / ORG_CONFIRM_UPDATED）：Leader 只提案，
// 用户 ✓/✗ 决议（COMMAND_ORG_CONFIRM）；decided 后不再出现在 pending 清单
export interface OrgConfirm {
  id: string;
  kind: "project-create" | "tier-change" | "suggest-hold" | "archive" | "revive" | "rule-append";
  title: string;
  reason?: string;
  created_at: number;
  status: "pending" | "approved" | "rejected";
  payload?: Record<string, unknown>;
}

// 任务板条目（COMMAND_PROJECT_DETAIL.board 携带；BOARD_UPDATED 增量维护）。
// status 五态词表 = relay projects.ts BoardEntryStatus（D18 freeze v2-m10-freeze §1.2
// 逐字）：backlog/claimed/submitted/ready_to_install/done——此前端侧类型注记的
// todo/doing/done 三态是 D18 迁移前旧形状（wire 早已五态，GroupModal 渲染面即按五态），
// W-EXPODOMAIN v2（design-expo-mobile-v2 A1-2）随团队详情页对齐修正。transitions =
// 泳道迁移时间线（桌面件十九；端上只读消费）
export type BoardEntryStatus = "backlog" | "claimed" | "submitted" | "ready_to_install" | "done";
export interface BoardEntry {
  id: string;
  text: string;
  status: BoardEntryStatus;
  note?: string;
  owner_session?: string;
  dispatch_id?: string;
  created_at: number;
  updated_at: number;
  /** D18 完成候选复核资格位（submitted 生成锁；端上只读） */
  review_required?: boolean;
  /** 泳道迁移时间线（桌面件十九：[{status, ts}]；旧条目无此字段） */
  transitions?: { status: BoardEntryStatus; ts: number }[];
}

// W-RULES2 团队铁律条目（relay team-rules.ts RuleEntry 端侧镜像；只读消费——手机
// 写面在电脑端，rule-append 类实时决议走确认卡）。字段与 relay schema 同构，多出的
// 键端上忽略
export interface RuleEntry {
  id: string;
  /** ≤120 字祈使句 */
  text: string;
  /** 三档：all | leader | role:<P81 词表>（词表外写入即拒 fail-closed） */
  audience: string;
  /** 双值：team | project:<锚点目录绝对路径（尾斜杠归一）> */
  scope: string;
  status: "active" | "retired" | "superseded";
  /** 替代链：被哪条新规则替代 */
  superseded_by?: string;
  /** 升格溯源（由哪条经验复制而来） */
  promoted_from?: string;
  created_by: "user" | "agent";
  confirm_id?: string;
  created_at: number;
  updated_at: number;
}

// #087 经验回流（009 §4 M2）：board lessons 分区（relay projects.ts 镜像）——收口
// 回执写入，端上暂无 UI 消费（M13-4 起随 BOARD_UPDATED delta 维护缓存，注入接线后续单）
export interface LessonEntry {
  id: string;
  text: string;
  /** 项目/角色/引擎 tag（筛选键，AND 语义） */
  tags: string[];
  ts: number;
  /** 来源派单台账 id（可回溯到收口回执） */
  source_dispatch_id?: string;
}

export interface ProjectBoard {
  gid: string;
  frozen: boolean;
  entries: BoardEntry[];
  /** lessons 分区（relay 侧 optional：板升级前旧文件缺省）；append-only，量大了再议归档 */
  lessons?: LessonEntry[];
  /** 板级时间戳（relay 必有；expo 缺省容忍——旧形状覆盖式帧原样透传） */
  updated_at?: number;
}

// ---------- M13-2 delta 投影形状（relay/src/types.ts 镜像，三端同构） ----------
// 设计铁律：差分用「带稳定 id 的完整条目」表达增改，端上按 id upsert（整条替换，
// 不做字段级合并）、removes 忽略未知 id——重复投递二次应用零变化（幂等）。
// 帧级判定：`payload.delta !== undefined` → 增量 merge；缺席 → 覆盖式消费旧字段
// （旧 relay / mgr 重启后首帧，零行为变化）。expo 消费门另叠能力信号
// source_capabilities.projection_v2（见 org-delta.ts）。
export interface EntityDelta<T extends { id: string }> {
  /** 变更实体完整条目（整条替换，含未变字段） */
  upserts: T[];
  /** 移除实体 id（忽略未知 id=幂等；组域 v1 无删边恒空，编码留位） */
  removes: string[];
}

// 板 delta：条目级差分（不带板全量正文）；lessons 按 id upsert（append-only 语义由
// 端上 ts 排序承载）；meta 承载板级元数据（frozen 翻转/时间戳推进——挂起/结项/复活
// 边无条目变化也发帧）
export interface BoardDelta {
  entries: EntityDelta<BoardEntry>;
  lessons: EntityDelta<LessonEntry>;
  meta: { frozen: boolean; updated_at: number };
}

// 派单台账行（COMMAND_PROJECT_DETAIL.receipts 携带，最近 30 条按 anchor 过滤新在前）
export interface DispatchReceipt {
  ts: number;
  id: string;
  tier: string;
  target: string;
  status: string;
  receipt?: string;
  session_id?: string;
  project_anchor?: string;
}

// #26 M3 熟手池条目（COMMAND_PROJECT_DETAIL.pool 携带）：路由表档案（§5 成员卡进化：
// 经验 N 次·上次·评价·标签）join 会话运行态，服务端拼好、端上零 join。
// resumable=false = 退休（会话不在册/无 SDK 句柄，只剩路由表档案）；parked = 随本组
// 挂起休眠（org_parked 指回本组）；busy 口径与派单时 pickVeteran 现场口径一致
export interface RoutingPoolEntry {
  session_id: string;
  count: number;
  failed: number;
  last_ts: number;
  rating?: "good" | "bad";
  tags?: string[];
  title?: string;
  busy: boolean;
  resumable: boolean;
  parked: boolean;
}

export interface PendingInput {
  text: string;
  ts: number;
}

// 子 Agent 运行状态（relay 从 Agent/Task 工具 hook + transcript task-notification 解析）
export interface SubagentEntry {
  id: string;
  desc: string;
  kind: string;
  bg: boolean;
  started_at: number;
  ended_at?: number;
  // #103 活性（HUD 风格）：最近一次工具调用摘要（如 "Bash · npm test"），relay 轮询子
  // Agent 自有 transcript 尾部得出；结束后定格为最后动作，随条目 TTL 清扫。旧 relay 无此字段
  act?: string;
  act_at?: number;
}

export interface LogEntry {
  ts: number;
  kind: "assistant_text" | "thinking" | "tool_use" | "tool_result" | "system" | "user_message";
  text: string;
  tool?: string;
  full?: string; // 原文（relay 仅在 text 被截断时携带）
  id?: string; // 流式块 id：同 id 的时间线条目原地替换
  streaming?: boolean; // true = 该文本块仍在生成中
  detail?: string; // 工具完整入参/输出（展开查看）
  diff?: string[]; // Edit/Write 的 +/- diff 行（着色渲染）
  occurred_at?: number; // optional: old relay only has relay receive time ts
  // FB14 气泡附图：随消息发送图片的落盘文件名引用（relay uploads.ts img-* 命名，仅
  // basename 防路径泄漏）。引用而非 base64——LogEntry 随 SNAPSHOT 每次重连全量重发，
  // 内联大图会把快照/事件流撑爆；端上经 COMMAND_ARTIFACT_FETCH（img 引用分支）按需
  // 拉取。relay tmp 目录 7 天清扫，过期引用拉取失败，端上隐藏缩略即可（旧 relay 无此字段）
  images?: string[];
}

export interface Envelope {
  seq: number;
  session_id: string;
  ts: number;
  type: string;
  payload: any;
}

export type EventType =
  | "SESSION_ACTIVITY"
  | "NOTIFICATIONS_UPDATED"
  | string;

// W-EXPP2 团队经验库条目（relay/src/experience.ts ExperienceEntry 端侧镜像；只读消费
// ——手机不做操作，P2 范围外。字段与 relay schema 同构，多出的键端上忽略）
export interface ExperienceEntry {
  id: string;
  text: string;
  kind: "pitfall" | "practice" | "preference" | "fact";
  role_scope: string;
  project_scope: string;
  tags?: string[];
  status: "active" | "retired";
  use_count?: number;
  created_at?: number;
  last_used_at?: number;
  updated_at?: number;
  merged_from?: string[];
  demoted_at?: number;
  restored_at?: number;
  source?: { actor: "agent" | "user" | "system"; session_id: string; dispatch_id?: string; migrated_lesson_id?: string };
}

export interface SnapshotPayload {
  sessions: SessionState[];
  logs: Record<string, LogEntry[]>;
  server_time: number;
  schema_version?: number;
  models?: string[];
  homedir?: string;
  deliverables?: boolean;
  acceptances?: unknown[];
  relay_dev?: string;
  relay_name?: string;
  projects?: ProjectGroup[];
  boards?: ProjectBoard[];
  org_confirms?: OrgConfirm[];
  // W-EXPP2 经验库（覆盖式锚定；空数组也下发=支持位，缺席=旧 relay）
  experience?: ExperienceEntry[];
  experience_enabled?: boolean;
  // W-RULES2 团队铁律（覆盖式锚定同上；缺席=旧 relay）
  rules?: RuleEntry[];
  rules_enabled?: boolean;
  notifications?: NotificationItem[];
  source_capabilities?: SourceCapabilities;
}

const ACTIVITY_KINDS: readonly ActivityKind[] = ["tool_use", "tool_result", "assistant_text", "system"];
const SESSION_STATUSES: readonly SessionState["status"][] = ["WORKING", "WAITING", "ERROR", "DONE"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function normalizeActivityCapabilities(value: unknown): ActivityCapabilities {
  const raw = isRecord(value) ? value : {};
  return {
    native_status: raw.native_status === true,
    operation_summary: raw.operation_summary === true,
    native_elapsed: raw.native_elapsed === true,
    approval: raw.approval === true,
  };
}

export function hasActivityCapability(session: SessionState, capability: keyof ActivityCapabilities): boolean {
  return session.activity_capabilities?.[capability] === true || session.activity?.capabilities[capability] === true;
}

export function parseSessionActivityPayload(value: unknown): SessionActivityPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.session_id !== "string" || !value.session_id) return null;
  if (typeof value.state !== "string" || !SESSION_STATUSES.includes(value.state as SessionState["status"])) return null;
  if (typeof value.activity_kind !== "string" || !ACTIVITY_KINDS.includes(value.activity_kind as ActivityKind)) return null;
  if (typeof value.text !== "string" || typeof value.observed_at !== "number" || !Number.isFinite(value.observed_at)) return null;
  if (typeof value.seq_local !== "number" || !Number.isInteger(value.seq_local) || value.seq_local < 0) return null;
  if (value.tool !== undefined && typeof value.tool !== "string") return null;
  if (value.occurred_at !== undefined && (typeof value.occurred_at !== "number" || !Number.isFinite(value.occurred_at))) return null;
  return {
    session_id: value.session_id,
    state: value.state as SessionActivityPayload["state"],
    activity_kind: value.activity_kind as ActivityKind,
    text: value.text,
    ...(value.tool === undefined ? {} : { tool: value.tool }),
    observed_at: value.observed_at,
    ...(value.occurred_at === undefined ? {} : { occurred_at: value.occurred_at }),
    capabilities: normalizeActivityCapabilities(value.capabilities),
    seq_local: value.seq_local,
  };
}

export function normalizeSnapshotSession(session: SessionState): SessionState {
  const capabilities = session.activity
    ? normalizeActivityCapabilities(session.activity.capabilities ?? session.activity_capabilities)
    : session.activity_capabilities === undefined
      ? undefined
      : normalizeActivityCapabilities(session.activity_capabilities);
  if (!session.activity && capabilities === undefined) return session;
  if (!session.activity) return { ...session, activity_capabilities: capabilities };
  const activity: StatusDockState = { ...session.activity, capabilities: capabilities! };
  return { ...session, activity, activity_capabilities: capabilities };
}

export function normalizeNotifications(value: unknown): NotificationItem[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is NotificationItem => isRecord(item) && typeof item.key === "string" && !!item.key);
}

function normalizeSourceCapabilities(value: unknown): SourceCapabilities | undefined {
  if (!isRecord(value)) return undefined;
  const out: SourceCapabilities = {};
  for (const [key, entry] of Object.entries(value)) {
    // P81-2 permission[] 特判收容：鸭子校验复用 permission.permissionSummariesOf
    //（单口径，测试件同一把尺）；全部畸形/非数组 → 不设键（=旧 relay 降级隐藏）。
    // 其余键维持既有 boolean/string[] 白名单（未知键忽略语义不变）
    if (key === "permission") {
      const perms = permissionSummariesOf(entry);
      if (perms.length) out.permission = perms;
      continue;
    }
    // 75-E engine_catalog 特判收容：鸭子校验同 permission 一把尺（engineCatalogOf）；
    // 非数组/全畸形 → 不设键（=undefined，选择器降级旧默认路径不出假清单）
    if (key === "engine_catalog") {
      const cat = engineCatalogOf(entry);
      if (cat) out.engine_catalog = cat;
      continue;
    }
    if (typeof entry === "boolean" || (Array.isArray(entry) && entry.every((item) => typeof item === "string"))) out[key] = entry;
  }
  return out;
}

export interface NormalizedSnapshotPayload {
  sessions: SessionState[];
  notifications: NotificationItem[] | null;
  notificationsLegacy: boolean;
  deliverables: boolean;
  schemaVersion?: number;
  sourceCapabilities?: SourceCapabilities;
}

export function normalizeSnapshotPayload(value: unknown): NormalizedSnapshotPayload {
  const payload = isRecord(value) ? value : {};
  const notifications = normalizeNotifications(payload.notifications);
  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions.filter((session): session is SessionState => isRecord(session) && typeof session.session_id === "string").map(normalizeSnapshotSession)
    : [];
  return {
    sessions,
    notifications,
    notificationsLegacy: notifications === null,
    deliverables: payload.deliverables === true,
    ...(typeof payload.schema_version === "number" ? { schemaVersion: payload.schema_version } : {}),
    sourceCapabilities: normalizeSourceCapabilities(payload.source_capabilities),
  };
}

export function reduceSessionActivity(
  sessions: Map<string, SessionState>,
  activitySeq: Map<string, number>,
  value: unknown,
): boolean {
  const activity = parseSessionActivityPayload(value);
  if (!activity) return false;
  const session = sessions.get(activity.session_id);
  if (!session) return false;
  const previousSeq = activitySeq.get(activity.session_id);
  if (previousSeq !== undefined && activity.seq_local <= previousSeq) return false;
  const capabilities = normalizeActivityCapabilities(activity.capabilities);
  const dock: StatusDockState = {
    ...(session.activity ?? {}),
    state: activity.state,
    activity: {
      kind: activity.activity_kind,
      text: activity.text,
      ...(activity.tool === undefined ? {} : { tool: activity.tool }),
      observed_at: activity.observed_at,
      ...(activity.occurred_at === undefined ? {} : { occurred_at: activity.occurred_at }),
    },
    capabilities,
    updated_at: activity.observed_at,
  };
  sessions.set(activity.session_id, { ...session, activity: dock, activity_capabilities: capabilities });
  activitySeq.set(activity.session_id, activity.seq_local);
  return true;
}

export type CommandType =
  | "COMMAND_CREATE"
  | "COMMAND_MESSAGE"
  | "COMMAND_STOP"
  | "COMMAND_CONTINUE"
  | "COMMAND_REJECT"
  | "COMMAND_EXT_MODE"
  | "COMMAND_EXT_INPUT"
  | "COMMAND_EXT_STOP"
  | "COMMAND_DELETE"
  | "COMMAND_RENAME"
  | "COMMAND_ANSWER"
  | "COMMAND_PAIR_START"
  | "COMMAND_LOGIN_GRANT"
  | "COMMAND_WATCH_GRANT"
  | "COMMAND_PERM"
  | "COMMAND_MODEL"
  | "COMMAND_REFRESH_TODOS"
  | "COMMAND_ARTIFACT_FETCH"
  | "COMMAND_ALLOW_RULE_REMOVE"
  | "COMMAND_ORG_CONFIRM" // #26 M2 确认卡决议（✓/✗；relay 单漏斗 orgAction）
  | "COMMAND_PROJECT_DETAIL"
  | "COMMAND_ORG_ACTION"
  | "COMMAND_NOTIFICATION_ACK"
  | "COMMAND_ENGINE_PROFILE_UPDATE"
  | "COMMAND_ARTIFACT_GROUP_FETCH"
  // 议题①可信设备清单/踢除（relay session-manager COMMAND_PEERS/COMMAND_PEER_KICK，
  // LAN token / 云 E2E 已配对信道均可发）；旧 relay 回 ok:false「云桥未启用」
  | "COMMAND_PEERS"
  | "COMMAND_PEER_KICK";

// 云桥配对信息：relay 经可信 LAN 信道下发，手机落盘后即可走云通道
export interface CloudPairInfo {
  url: string;
  token: string;
  relay_dev: string;
  relay_pubkey: string;
}

// ---------- 设备列表（0.7 批 2）：与 relay/src/types.ts PairedDeviceInfo/PeerMeta 同构 ----------
// #42 设备身份元数据：pair_req 帧可选自报字段（名称/平台/UA/应用版本），relay 校验截断后
// 随 addPeer 持久化；存量设备无 meta = 端上降级显示「未知设备」
export interface PeerMeta {
  name?: string;      // 设备自报名（App 用设备实名，浏览器沿用设备名）
  platform?: string;  // App：OS+型号（"android·Pixel 8"）；浏览器：平台（"Windows"）
  ua?: string;        // 浏览器 UA 截断摘要；App 不报
  app?: string;       // 应用标识+版本（"CC Deck 0.3.35" / 网页控制台标识）
}

// COMMAND_PEERS 成功 ACK 携带的设备条目（relay 派生 kind 优先采信 meta 自报身份，
// dev 前缀降级兜底）；last_seen 0 = 未知（relay 重启后清零）
export interface PairedDeviceInfo {
  dev: string;
  name: string;
  pubkey: string;
  kind: "phone" | "web" | "watch" | "other";
  paired_at: number;
  last_seen: number;
  meta?: PeerMeta;
}

export interface CommandAck {
  type: "COMMAND_ACK";
  command_id: string;
  ok: boolean;
  session_id?: string;
  error?: string;
  cloud?: CloudPairInfo;
  pair_code?: { code: string; expires_in: number };
  // #79 仅 COMMAND_ARTIFACT_FETCH 成功 ACK 携带：字节数 + 扩展名推导 MIME
  //（分级预览用；数据本体走 ARTIFACT_CHUNK 瞬态帧，ref=command_id）
  artifact?: { size: number; mime: string };
  // P81-5 仅 COMMAND_CREATE（组织派单）成功 ACK 携带：开卡权限求值回执——
  // effective≠normalized=请求档被降级（端上显调整提示）；forbidden 拒绝走
  // ok:false+error（"forbidden: <reason 码>"）不带本字段
  permission?: { normalized: string; effective: string; native_mode: string | null; reason: string };
  // 75-E 仅 COMMAND_CREATE 成功 ACK 携带（75-R relay 落地）：实际创建引擎——与请求
  // engine 不一致 = 降级（端上 engineDowngradeNote 标「已降级」不静默）；旧 relay
  // 不带 = undefined（不比较不提示，字段存在性消费）
  engine?: string;
  // #26 M2/M3 仅 COMMAND_PROJECT_DETAIL 成功 ACK 携带：{ group, board, receipts, pool }
  data?: unknown;
  // 议题①仅 COMMAND_PEERS 成功 ACK 携带：已配对设备清单（云桥未启用 = ok:true+空数组）
  peers?: PairedDeviceInfo[];
}

// ─── E4a 只读投影（源胶囊副行 / 通知域分组 / 能力卡）：纯函数零依赖，
// test-e4a-setup.ts 直跑 import（同 test-e1-reducer 先例，无需模块桩） ───

/** 通知域分组词表（007 IA B+ 口径）：action=需你行动 / attention=注意 / activity=动态。
 * 与 relay NotificationGroup 同源（relay/src/types.ts），值替换帧只改账不改词表 */
export type NotificationGroup = "action" | "attention" | "activity";

export interface NotificationBucketView {
  group: NotificationGroup;
  count: number;
  badgeCount: number; // 仅 action 组有意义：未决 actionable 计数
}

export interface NotificationProjection {
  legacy: boolean; // true = 旧 relay（无通知账 null/undefined）→ 横幅计数整块不渲染
  total: number;
  badgeCount: number; // 未决 actionable（action 组）——前台通知角标/「需你行动」计数
  buckets: Record<NotificationGroup, NotificationBucketView>;
}

// dismissed_at 为 relay lifecycle 扩展字段、冻结面 NotificationItem 暂无（E3b 回单
// 备案 4，不擅改）——此处防御读取：帧里带了就算已处理，没带不误判
type NotificationLifecycleExtras = { dismissed_at?: number };

function notificationHandled(n: NotificationItem): boolean {
  const x = n as NotificationItem & NotificationLifecycleExtras;
  return n.handled_at !== undefined || x.dismissed_at !== undefined || n.resolved_at !== undefined;
}

/** 通知域只读投影（镜像 relay groupNotifications 读侧语义，单遍 O(n)）：
 * 未知分组条目跳过（畸形防御，同 relay `if (!bucket) continue`）；角标=action 组
 * 且 actionable 且未决（handled/dismissed/resolved 全空）。入参只读不突变（重连
 * 快照/值替换帧反复投影不丢不重） */
export function projectNotifications(items: readonly NotificationItem[] | null | undefined): NotificationProjection {
  const buckets: Record<NotificationGroup, NotificationBucketView> = {
    action: { group: "action", count: 0, badgeCount: 0 },
    attention: { group: "attention", count: 0, badgeCount: 0 },
    activity: { group: "activity", count: 0, badgeCount: 0 },
  };
  if (!items) return { legacy: true, total: 0, badgeCount: 0, buckets };
  let total = 0;
  for (const n of items) {
    const b = buckets[n.group as NotificationGroup];
    if (!b) continue;
    total++;
    b.count++;
    if (n.group === "action" && n.actionable && !notificationHandled(n)) b.badgeCount++;
  }
  return { legacy: false, total, badgeCount: buckets.action.badgeCount, buckets };
}

/** 源胶囊副行输入（结构化最小面，store SourceStatus 天然满足）：018 §2.6 轻量口径
 * 之外，仅当快照带 capability/version 类字段才补一行说明 */
export interface SourceCapsuleInput {
  channel: "lan" | "cloud" | null;
  schemaVersion?: number;
  notificationsLegacy?: boolean;
}

/** 源胶囊副行：`v{schema} · 云桥|直连 ·(通知不可用)`；旧 relay（schema_version 缺省）
 * → null = 不出该行（轻量行保持 状态点+源名+必要异常 原样，不猜字段不造假数据） */
export function capsuleSubline(src: SourceCapsuleInput | null | undefined): string | null {
  if (!src || typeof src.schemaVersion !== "number") return null;
  const parts = [`v${src.schemaVersion}`, src.channel === "cloud" ? "云桥" : "直连"];
  if (src.notificationsLegacy) parts.push("通知不可用");
  return parts.join(" · ");
}

/** 能力卡模型（设置页只读）：快照带 schema_version / source_capabilities 任一才出卡；
 * 旧 relay 两者皆缺 → null = 整卡隐藏（018 §2.7「旧 relay 缺字段按能力隐藏」）。
 * 行级同样按字段在场渲染（缺 key 不出该行，不出假「—」）。隐私红线：本模型只产
 * 文案与计数，绝不携带 token/密钥类字段值——source_capabilities 上的未知键一律
 * 不读（018 §2.5：秘密只存 env/keychain 引用，不进快照更不进渲染树） */
export interface CapabilityRow {
  key: string;
  label: string;
  value: string;
}

export interface CapabilityCardModel {
  rows: CapabilityRow[];
  privacy: string; // profile 非秘密引用文案（静态，不含任何密钥内容）
}

export function capabilityCardModel(input: {
  schemaVersion?: number;
  sourceCapabilities?: SourceCapabilities;
  models?: string[];
}): CapabilityCardModel | null {
  const caps = input.sourceCapabilities;
  if (typeof input.schemaVersion !== "number" && !caps) return null;
  const rows: CapabilityRow[] = [];
  if (typeof input.schemaVersion === "number") {
    rows.push({ key: "schema", label: "协议版本", value: `v${input.schemaVersion}` });
  }
  if (caps) {
    if (caps.activity !== undefined) rows.push({ key: "activity", label: "活动摘要/耗时", value: caps.activity ? "支持" : "不可用" });
    if (caps.models !== undefined) rows.push({ key: "modelsCap", label: "模型清单", value: caps.models ? "支持" : "不可用" });
    if (caps.notifications !== undefined) rows.push({ key: "notifications", label: "通知域", value: caps.notifications ? "支持" : "不可用" });
    if (Array.isArray(caps.commands) && caps.commands.length) rows.push({ key: "commands", label: "已登记命令", value: `${caps.commands.length} 项` });
  }
  if (Array.isArray(input.models) && input.models.length) rows.push({ key: "modelCount", label: "可用模型", value: `${input.models.length} 个` });
  return {
    rows,
    privacy: "引擎凭证只以环境变量或系统密钥引用保存在电脑端，不随快照下发，也不在本页显示。",
  };
}

// ─── E4b 通知 ACK 可见面（Setup 通知区模型 + 双击闸）：接线所需增量，纯函数零依赖 ───

/** 待办通知行（Setup 通知区渲染模型）：key=源域稳定键（ackNotification 定位键），
 * title 单行展示。语义=角标镜像（action 组且 actionable 且未决），与
 * projectNotifications 的 badgeCount 同一口径——乐观 handled_at 一落账（ackNotification
 * 乐观突变）行即刻消失（无再点位），ACK 失败回滚后行回来（重试=重点按钮） */
export interface TodoRow {
  key: string;
  title: string;
}

export interface TodoSurface {
  rows: TodoRow[]; // 有界 ≤TODO_SURFACE_MAX（390 宽不整屏失控）
  overflow: number; // 溢出计数（「还有 N 条」角标行）
}

export const TODO_SURFACE_MAX = 8;

export function todoSurface(items: readonly NotificationItem[] | null | undefined): TodoSurface {
  if (!items || items.length === 0) return { rows: [], overflow: 0 };
  const pending: NotificationItem[] = [];
  for (const n of items) {
    if (n.group !== "action" || !n.actionable) continue;
    if (notificationHandled(n)) continue;
    pending.push(n);
  }
  const rows = pending.slice(0, TODO_SURFACE_MAX).map((n) => ({ key: n.key, title: n.title }));
  return { rows, overflow: pending.length - rows.length };
}

/** ACK 双击闸：飞行中同 key 再点 → skip（不双发命令）；出结果（onDone）后出闸。
 * node 直测锁定「重复点击不双发」的调用面语义 */
export function ackTapGuard(inFlight: ReadonlySet<string>, key: string): "skip" | "go" {
  return inFlight.has(key) ? "skip" : "go";
}

// ─── E2-连接面只读投影（0.7 批 2：服务器卡四态灯 / 配对码错误分层 / 设备卡标签）：
// 纯函数零依赖，test-expo2-devices.ts 直跑 import（e4a 同款先例，无需模块桩） ───

/** 连接状态灯四态（0.7 批 2，对齐桌面 conn 图标语义的色相语言）：
 * online=绿（已连）/ busy=黄（连接中·含重连，UI 层叠加闪烁）/ bad=红（配对失效——
 * 唯一不能自愈、必须人工重新配对的态）/ off=灰（未连接·已断开）。
 * store 六态归四色：connecting|reconnecting 并入 busy，idle|offline 并入 off */
export type ConnTone = "online" | "busy" | "bad" | "off";
export function connStateTone(state: string | null | undefined): ConnTone {
  if (state === "online") return "online";
  if (state === "connecting" || state === "reconnecting") return "busy";
  if (state === "unpaired") return "bad";
  return "off";
}

/** 服务器卡副行状态词（SRC_STATE_TEXT 手机端收敛版 + unpaired 人工引导）：
 * idle 显示「点按连接」行动语义，unpaired 点明「需重新配对」 */
export function connStateNote(state: string | null | undefined): string {
  switch (state) {
    case "online": return "在线";
    case "connecting": return "连接中…";
    case "reconnecting": return "重连中…";
    case "offline": return "已断开 · 点按重连";
    case "unpaired": return "配对失效 · 点按重新配对";
    default: return "点按连接";
  }
}

/** 设备卡类型标签（COMMAND_PEERS 下发 kind 的人话映射，relay peerKind 已按 meta
 * 自报优先派生——端上只翻译不推断） */
export function peerKindLabel(kind: string): string {
  switch (kind) {
    case "phone": return "手机";
    case "web": return "网页";
    case "watch": return "手表";
    default: return "设备";
  }
}

/** 设备卡时间列（last_seen/paired_at 相对时间；0 = 未知——relay 重启后 last_seen
 * 内存态清零，不显示「0 分钟前」假数据） */
export function peerRelTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

/** 配对码输入错误分层文案（0.7 批 2 交付 3）：relay nack 的原文（「配对码无效或已
 * 过期」）按用户动作改写——过期→引导重领；无效→引导核对；连错 ≥3 次（本地计数）
 * 追加锁定预警（relay 侧连续 5 次错码进入 10 分钟静默期，pairFails 语义的端上
 * 预告，relay 零改动）。其余原文透传（网络类错误不包装） */
export function pairErrNote(raw: string | null, fails: number): string {
  if (!raw) return "";
  let head: string;
  if (raw.includes("过期")) head = "配对码已过期 · 请在电脑端重新领取新码再试";
  else if (raw.includes("无效")) head = "配对码无效 · 请核对电脑端弹出的 8 位码";
  else return raw;
  return fails >= 3 ? `${head}\n已连续输错 ${fails} 次 · 连续 5 次将暂停配对 10 分钟` : head;
}
