// org 数据 schema 校验单点（W-CMDIMPL T0b，#216；设计 §5.6 LangGraph reducer 语义）
// 与 T0a 落盘三件套（fs-safe.ts/projects.ts 原子写+journal+只读闸）同一层两面：
//   reducer 管「写入语义」（什么数据允许进账），三件套管「落盘语义」（进账的数据
//   怎么安全呆在盘上）。
// 口径 = 读宽容、写严格：读侧旧行缺字段/未知状态原样容忍（既有惯例不降级）；写侧
// 对**新数据**严格——schema 外字段/类型不符/坏枚举一律拒绝（脏数据不进账本）。
// 形态 = 公共 API 签名不变：createGroup/setGroupHeadcount/upsertBoardEntry/
// appendDispatch 等写入口在构造数据后调用 applyOrgChange 校验，拒写时走各函数
// 既有失败形态（调用方零改）。存量字段全集 = 初始 schema（设计 §5.6 字段集条款）；
// 加字段 = 改本文件 schema + 版本注释，不是绕过校验的理由。

// ---------- 词表（运行时单点） ----------

export const PROJECT_GROUP_STATUSES = ["pending", "active", "parked", "archived"] as const;
export const PROJECT_TIERS = ["轻立项", "正经立项"] as const;
export const SESSION_ENGINE_VALUES = ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"] as const;
// DispatchStatus 与 BOARD_ENTRY_STATUSES（projects.ts）保持各自主定义——此处镜像引用面
// 只做校验，不重复定义权威（board 词表 import 自 projects.ts 有环风险：projects→schema→
// projects；镜像表在本文件头注声明同步责任）
export const DISPATCH_STATUSES = ["dispatched", "running", "done", "failed", "queued"] as const;
// 板状态五态词表权威上移到本文件（W-CMDIMPL T0b）：依赖单向 projects.ts→org-schema.ts，
// projects.ts 保留 re-export 兼容既有消费面（D18 freeze 词表语义不变，权威注释见彼处）
export const BOARD_ENTRY_STATUSES = ["backlog", "claimed", "submitted", "ready_to_install", "done"] as const;
export const DISPATCH_TIERS = ["咨询", "随手办", "轻立项", "正经立项", "暂缓", "看门狗"] as const;
// #G3 板卡富模型：优先级三档（对标 multica）——权威=本文件（BOARD_ENTRY_STATUSES 同款），
// projects.ts re-export。缺省=未标注（不落键，旧行兼容）
export const BOARD_PRIORITIES = ["P0", "P1", "P2"] as const;
// #G5 失败分类学：七枚举镜像（权威=dispatch-retry.ts 分类器伴生 DISPATCH_FAILURE_REASONS，
// 本文件不 import 防依赖面扩散——两处改动需同步，同步责任在本注释。
// zero_output=S1 零产出闸收口侧结构判定值，不经文本分类器）
export const FAILURE_REASONS = ["network_error", "timeout", "tool_crash", "model_overload", "logic_error", "cancelled", "zero_output"] as const;

// ---------- 基础校验原语 ----------

type Dict = Record<string, unknown>;

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isObj = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

function enumOk(v: unknown, table: readonly string[]): boolean {
  return isStr(v) && (table as readonly string[]).includes(v);
}

/** 白名单字段 + 类型表检查：required 缺失拒；declared 字段类型不符拒；**schema 外
 *  字段拒**（写严格核心条款）。返回 null=通过，字符串=拒因。 */
function checkFields(
  data: Dict,
  schema: Record<string, { type: "string" | "number" | "boolean" | "object" | "array" | "enum" | "string-array" | "object-array"; required?: boolean; enumTable?: readonly string[] }>,
): string | null {
  for (const [key, rule] of Object.entries(schema)) {
    const v = data[key];
    if (v === undefined) {
      if (rule.required) return `必需字段 ${key} 缺失`;
      continue;
    }
    switch (rule.type) {
      case "string": if (!isStr(v)) return `字段 ${key} 应为字符串`; break;
      case "number": if (!isNum(v)) return `字段 ${key} 应为有限数字`; break;
      case "boolean": if (!isBool(v)) return `字段 ${key} 应为布尔`; break;
      case "enum": if (!enumOk(v, rule.enumTable ?? [])) return `字段 ${key} 值不在词表`; break;
      case "array":
      case "string-array":
      case "object-array":
        if (!isArr(v)) return `字段 ${key} 应为数组`;
        if (rule.type === "string-array" && !v.every(isStr)) return `字段 ${key} 应为字符串数组`;
        if (rule.type === "object-array" && !v.every(isObj)) return `字段 ${key} 应为对象数组`;
        break;
      case "object": if (!isObj(v)) return `字段 ${key} 应为对象`; break;
    }
  }
  for (const key of Object.keys(data)) {
    if (!(key in schema)) return `schema 外字段 ${key} 拒写（写严格：加字段先改 schema）`;
  }
  return null;
}

// ---------- 三类 schema（存量字段全集 = 初始 schema） ----------

/** ProjectHeadcountEntry（projects.ts:28）：session_id/role 必需，其余可选 */
export const HEADCOUNT_SCHEMA: Record<string, { type: "string" | "number" | "boolean" | "object" | "array" | "enum" | "string-array" | "object-array"; required?: boolean; enumTable?: readonly string[] }> = {
  session_id: { type: "string", required: true },
  role: { type: "string", required: true },
  nick: { type: "string" },
  engine: { type: "enum", enumTable: SESSION_ENGINE_VALUES },
  model: { type: "string" },
  provider: { type: "string" },
};

/** ProjectGroup（projects.ts:46；duty_policy 为深对象走对象级放行——策略内部结构
 *  属 leader-duty 域，写严格边界止于「必须是对象」，内部字段由该域自身演进） */
export const PROJECT_GROUP_SCHEMA: Record<string, { type: "string" | "number" | "boolean" | "object" | "array" | "enum" | "string-array" | "object-array"; required?: boolean; enumTable?: readonly string[] }> = {
  id: { type: "string", required: true },
  name: { type: "string", required: true },
  anchor_dir: { type: "string", required: true },
  status: { type: "enum", required: true, enumTable: PROJECT_GROUP_STATUSES },
  tier: { type: "enum", required: true, enumTable: PROJECT_TIERS },
  headcount: { type: "object-array", required: true },
  role_defaults: { type: "object" },
  single_card: { type: "boolean", required: true },
  created_at: { type: "number", required: true },
  updated_at: { type: "number", required: true },
  parked_at: { type: "number" },
  archived_at: { type: "number" },
  archive_note: { type: "string" },
  hold_suggested_at: { type: "number" },
  duty_policy: { type: "object" },
  mixed_engine: { type: "boolean" },
  headcount_cap: { type: "number" },
};

/** BoardEntry（projects.ts:97；transitions 行内对象数组细化在 board-entry 校验器） */
export const BOARD_ENTRY_SCHEMA: Record<string, { type: "string" | "number" | "boolean" | "object" | "array" | "enum" | "string-array" | "object-array"; required?: boolean; enumTable?: readonly string[] }> = {
  id: { type: "string", required: true },
  text: { type: "string", required: true },
  status: { type: "string", required: true }, // 枚举在 board-entry 分支细查（BOARD_ENTRY_STATUSES 本文件权威）
  owner_session: { type: "string" },
  dispatch_id: { type: "string" },
  ts: { type: "number", required: true },
  updated_at: { type: "number", required: true },
  note: { type: "string" },
  review_required: { type: "boolean" },
  depends_on: { type: "string-array" },
  transitions: { type: "object-array" },
  gate: { type: "object" },
  priority: { type: "enum", enumTable: BOARD_PRIORITIES }, // #G3：词表分支细查
  parent_id: { type: "string" }, // #G3：父子链（坏引用渲染层孤儿容错，depends_on 同口径不炸）
  wakeup_at: { type: "number" }, // M2a 板卡唤醒（到点 patrol 触发后消费清空；毫秒时戳）
};

/** DispatchEntry（org.ts:316；stage/stage_detail 为 T1-STAGE 增量字段——先行入 schema） */
export const DISPATCH_ENTRY_SCHEMA: Record<string, { type: "string" | "number" | "boolean" | "object" | "array" | "enum" | "string-array" | "object-array"; required?: boolean; enumTable?: readonly string[] }> = {
  ts: { type: "number", required: true },
  id: { type: "string", required: true },
  tier: { type: "enum", required: true, enumTable: DISPATCH_TIERS },
  target: { type: "string", required: true },
  project_anchor: { type: "string" },
  status: { type: "enum", required: true, enumTable: DISPATCH_STATUSES },
  receipt: { type: "string" },
  session_id: { type: "string", required: true },
  title: { type: "string" },
  actor: { type: "string" },
  engine: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  /** T1-STAGE（§1.5）：阶段事件增量字段——stage 基表+custom. 前缀（拍板 #9） */
  stage: { type: "string" },
  stage_detail: { type: "string" },
  /** §2.4 链路演练：drill 标记行（读侧宽容忽略） */
  drill: { type: "boolean" },
  /** #G5 失败分类学：failed 行枚举（appendDispatch 咽喉自动落；词表=FAILURE_REASONS 镜像） */
  failure_reason: { type: "enum", enumTable: FAILURE_REASONS },
  /** #G5 瞬态自动重试标记：值=原单 id（链深恒 1） */
  retry_of: { type: "string" },
  /** #G3 板卡富模型透传：派单优先级（P0/P1/P2，板卡词表同源） */
  priority: { type: "enum", enumTable: BOARD_PRIORITIES },
  /** W-SMIMPL ②：回执契约可见化——done 无结果行标记（读侧宽容忽略，旧行缺省=有回执） */
  receipt_missing: { type: "boolean" },
  /** S3 世代 CAS（relfix-s）：dispatched 行世代戳=行 ts；收口侧比对防旧引用覆盖新世代 */
  generation: { type: "number" },
  /** S3 IssueSnapshot 基线（relfix-s）：认领既有板卡派单时的关键字段快照（收口对比用） */
  task_snapshot: { type: "object" },
  /** M1 run 机器留档：终态行自动回填的 run 目录名（dispatch-runs/<id>；读侧宽容透传） */
  run_ref: { type: "string" },
};

// ---------- reducer 门面 ----------

export type OrgChangeKind = "group" | "board-entry" | "dispatch-entry" | "headcount";
export type OrgChangeResult = { ok: true } | { ok: false; error: string };

/** 写严格校验统一入口（reducer 语义）：kind 分发到对应 schema。各写入口在构造/
 *  接收新数据后调用，{ok:false} 时走既有失败形态拒写（不落盘）。 */
export function applyOrgChange(kind: OrgChangeKind, payload: unknown): OrgChangeResult {
  if (!isObj(payload)) return { ok: false, error: "载荷必须是对象" };
  switch (kind) {
    case "group": {
      const err = checkFields(payload, PROJECT_GROUP_SCHEMA);
      if (err) return { ok: false, error: `组记录校验拒写：${err}` };
      const hc = payload.headcount as unknown[];
      for (const m of hc) {
        const r = applyOrgChange("headcount", m);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "headcount": {
      const err = checkFields(payload, HEADCOUNT_SCHEMA);
      if (err) return { ok: false, error: `编制条目校验拒写：${err}` };
      return { ok: true };
    }
    case "board-entry": {
      const err = checkFields(payload, BOARD_ENTRY_SCHEMA);
      if (err) return { ok: false, error: `板卡校验拒写：${err}` };
      const st = payload.status;
      if (!isStr(st)) return { ok: false, error: "板卡 status 应为字符串" };
      if (!(BOARD_ENTRY_STATUSES as readonly string[]).includes(st)) return { ok: false, error: `板卡 status 不在词表：${st}` };
      const tr = payload.transitions;
      if (tr !== undefined && isArr(tr)) {
        for (const row of tr) {
          if (!isObj(row) || !enumOk(row.status, BOARD_ENTRY_STATUSES) || !isNum(row.ts)) return { ok: false, error: "transitions 行应为 {status 词表内, ts 数字}" };
        }
      }
      const gate = payload.gate;
      if (gate !== undefined && gate !== null && (!isObj(gate) || !isStr(gate.reason) || !isNum(gate.opened_at))) return { ok: false, error: "gate 应为 {reason, opened_at}" };
      const pr = payload.priority; // #G3：优先级词表（缺省=未标注合法）
      if (pr !== undefined && (!isStr(pr) || !(BOARD_PRIORITIES as readonly string[]).includes(pr))) return { ok: false, error: `板卡 priority 不在词表（P0/P1/P2）：${pr}` };
      return { ok: true };
    }
    case "dispatch-entry": {
      const err = checkFields(payload, DISPATCH_ENTRY_SCHEMA);
      if (err) return { ok: false, error: `派单台账校验拒写：${err}` };
      const stage = payload.stage;
      if (stage !== undefined && !stageStageOk(stage as string)) return { ok: false, error: `stage 不在词表（基表或 custom. 前缀）：${stage}` };
      const fr = payload.failure_reason; // #G5：失败分类词表
      if (fr !== undefined && (!isStr(fr) || !(FAILURE_REASONS as readonly string[]).includes(fr))) return { ok: false, error: `failure_reason 不在词表：${fr}` };
      const dpr = payload.priority; // #G3：派单优先级词表（板卡同源）
      if (dpr !== undefined && (!isStr(dpr) || !(BOARD_PRIORITIES as readonly string[]).includes(dpr))) return { ok: false, error: `派单 priority 不在词表（P0/P1/P2）：${dpr}` };
      return { ok: true };
    }
  }
}

/** STAGE 词表（§1.5 拍板 #9）：固定基表 + custom. 前缀扩展。基表=发版链+回执链；
 *  基表外一律要求 custom. 前缀（防词表漂移同时留任务类型泛化口）。 */
export const STAGE_BASE = ["merged", "bumped", "tagged", "ci-green", "distributed", "receipt-filed"] as const;
export function stageStageOk(stage: string): boolean {
  if ((STAGE_BASE as readonly string[]).includes(stage)) return true;
  return stage.startsWith("custom.") && stage.length > "custom.".length;
}
