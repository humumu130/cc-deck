// 协议唯一定义源：Relay <-> 客户端（Web 调试台 / Android / 手表经手机网关）
// 与 design/技术方案评审.md §5 对应

// ---------- 事件信封 ----------

export interface Envelope<T extends string = string, P = unknown> {
  seq: number;          // 全局单调递增
  session_id: string;   // 会话 ID（Relay 生成，非 SDK session_id）
  ts: number;           // Date.now()
  type: T;
  payload: P;
}

// ---------- 会话状态 ----------

export type SessionStatus =
  | "WORKING"   // 推导中/执行工具
  | "WAITING"   // canUseTool 挂起，等用户确认
  | "ERROR"
  | "DONE";

export interface FileChangeStats {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
}

// 托管会话 token 用量（SDK result 消息携带；外部会话无数据）
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// 任务清单（CLI TodoWrite 工具的最新快照；手表/手机进度展示用）
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  active_form?: string;
}

export interface SessionState {
  session_id: string;
  relay_session_id: string;   // SDK/CLI 侧 session_id（用于 resume）
  cwd: string;
  initial_prompt: string;
  title: string;              // 人类可读标题（deriveTitle(initial_prompt)）
  title_locked?: boolean;     // true = 用户手动命名，自动命名（CC name/smart）不再覆盖
  model: string;
  status: SessionStatus;
  action_summary: string;     // 最近动作摘要，如 "修改 src/auth.ts"
  started_at: number;
  updated_at: number;
  waiting_request?: WaitingPayload;   // status===WAITING 时必有
  stats: FileChangeStats;
  last_error?: string;
  done_reason?: string;
  duration_ms?: number;
  historical?: boolean;       // true = Relay 重启前遗留的历史会话，不可操作
  external?: boolean;         // true = 用户自开 CLI 会话（hooks 桥接），仅单向可见 + 远程审批
  remote_mode?: boolean;      // external 会话的远程审批开关（默认关）
  cli_pid?: number;           // external 会话的 CLI 进程 pid（终端按键注入用）
  turn_started_at?: number;   // 当前 WORKING 回合起点（状态行计时用）
  usage?: TokenUsage;         // 托管会话 token 用量
  todos?: TodoItem[];         // 最近一次 TodoWrite 的任务清单
  permission_mode?: ManagedPermissionMode; // 托管会话当前权限模式
}

// 托管会话权限模式（SDK PermissionMode 的安全子集：bypassPermissions 不开放远程切换）
export type ManagedPermissionMode = "default" | "acceptEdits" | "plan";

// 时间线历史条目（持久化 & 快照下发用）
export interface LogEntry {
  ts: number;
  kind: SessionLogPayload["kind"];
  text: string;
  tool?: string;
  full?: string;   // 原文（text 被截断时才有；上限 FULL_TEXT_CAP）
  id?: string;     // 流式块 id：同 id 的 SESSION_LOG 客户端按原地替换（流式更新）
  streaming?: boolean; // true = 该文本块仍在生成中
  detail?: string; // P2 转录：工具完整入参/输出（等宽展开）
  diff?: string[]; // P2 转录：Edit/Write 的 +/- diff 行（着色渲染）
}

// ---------- 事件 payload（Relay -> 客户端） ----------

export interface SessionCreatedPayload {
  cwd: string;
  initial_prompt: string;
  title: string;
  model: string;
  external?: boolean;
}

export interface SessionUpdatedPayload {
  status: SessionStatus;
  action_summary: string;
  stats: FileChangeStats;
  remote_mode?: boolean;       // external 会话切换远程审批时携带
  title?: string;              // 标题升级（外部会话首个 prompt 到达时 / 用户改名）
  title_locked?: boolean;      // 用户命名标记（true 时自动命名跳过）
  turn_started_at?: number;    // 回合起点变化时携带
  usage?: TokenUsage;          // token 用量变化时携带
  todos?: TodoItem[];          // 任务清单变化时携带
  relay_session_id?: string;   // SDK 侧会话 id（重启重放后仍可 resume 的凭证）
  permission_mode?: ManagedPermissionMode; // 权限模式变化时携带
}

export interface SessionHeartbeatPayload {
  elapsed_ms: number;
  action_summary: string;
}

export interface WaitingPayload {
  request_id: string;
  tool_name: string;
  input_summary: string;
  suggestions: string[];
  questions?: AskQuestion[]; // AskUserQuestion 结构化问题（存在时客户端渲染选项点选作答）
  decidable?: boolean;   // false = 仅通知（外部会话 CLI 本地在等，远程无法决定）；默认 true
}

// AskUserQuestion 工具的问题结构（SDK input.questions 防御性清洗后）
export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  header: string;
  question: string;
  multi?: boolean;        // multiSelect
  options: AskOption[];
}

export interface WaitingResolvedPayload {
  request_id: string;
  decision: "allow" | "deny" | "timeout" | "answer";   // answer = AskUserQuestion 作答；timeout = 远程审批超时，回退 CLI 本地流程
  by: string;                 // 哪个客户端做的决定（调试用）
}

export interface SessionErrorPayload {
  message: string;            // 可读摘要，不含原始堆栈全量
}

export interface SessionDonePayload {
  terminal_reason: string;    // SDK result 的 terminal_reason 或 "interrupted"
  duration_ms: number;
  stats: FileChangeStats;
}

export interface SnapshotPayload {
  sessions: SessionState[];
  logs: Record<string, LogEntry[]>;   // session_id -> 时间线（重启用历史补齐）
  server_time: number;
}

// 时间线条目（M1 调试台用；压缩/截断后的一行文本，不推原始日志流）
export interface SessionLogPayload {
  kind: "assistant_text" | "thinking" | "tool_use" | "tool_result" | "system" | "user_message";
  text: string;
  tool?: string;
  detail?: string;
  diff?: string[];
}

export type EventType =
  | "SESSION_CREATED"
  | "SESSION_UPDATED"
  | "SESSION_HEARTBEAT"
  | "SESSION_WAITING"
  | "SESSION_WAITING_RESOLVED"
  | "SESSION_ERROR"
  | "SESSION_DONE"
  | "SESSION_LOG"
  | "SESSION_DELETED"
  | "SNAPSHOT";

export type EventPayloadMap = {
  SESSION_CREATED: SessionCreatedPayload;
  SESSION_UPDATED: SessionUpdatedPayload;
  SESSION_HEARTBEAT: SessionHeartbeatPayload;
  SESSION_WAITING: WaitingPayload;
  SESSION_WAITING_RESOLVED: WaitingResolvedPayload;
  SESSION_ERROR: SessionErrorPayload;
  SESSION_DONE: SessionDonePayload;
  SESSION_LOG: SessionLogPayload;
  SESSION_DELETED: SessionDeletedPayload;
  SNAPSHOT: SnapshotPayload;
};

export interface SessionDeletedPayload {
  session_id: string;
}

export type TypedEnvelope<T extends EventType = EventType> = Envelope<
  T,
  T extends keyof EventPayloadMap ? EventPayloadMap[T] : never
>;

// ---------- 命令（客户端 -> Relay，at-least-once + 幂等去重） ----------

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
  | "COMMAND_PERM";

export interface CommandBase {
  command_id: string;   // 客户端生成（uuid），Relay 按此去重
  type: CommandType;
  ts: number;
}

export interface CreateCommand extends CommandBase {
  type: "COMMAND_CREATE";
  payload: { cwd: string; prompt: string };
}

export interface MessageCommand extends CommandBase {
  type: "COMMAND_MESSAGE";
  payload: { session_id: string; text: string };
}

export interface StopCommand extends CommandBase {
  type: "COMMAND_STOP";
  payload: { session_id: string };
}

export interface ContinueCommand extends CommandBase {
  type: "COMMAND_CONTINUE";
  payload: { session_id: string; request_id: string };
}

export interface RejectCommand extends CommandBase {
  type: "COMMAND_REJECT";
  payload: { session_id: string; request_id: string; reason?: string };
}

// 外部会话（hooks 桥接）远程审批开关
export interface ExtModeCommand extends CommandBase {
  type: "COMMAND_EXT_MODE";
  payload: { session_id: string; enabled: boolean };
}

// 外部会话输入注入（空闲时敲进终端；忙时排队，回合结束自动发送）
export interface ExtInputCommand extends CommandBase {
  type: "COMMAND_EXT_INPUT";
  payload: { session_id: string; text: string };
}

// 外部会话打断（向终端注入 Esc）
export interface ExtStopCommand extends CommandBase {
  type: "COMMAND_EXT_STOP";
  payload: { session_id: string };
}

// 删除会话（仅 DONE/ERROR；从内存与历史中移除）
export interface DeleteCommand extends CommandBase {
  type: "COMMAND_DELETE";
  payload: { session_id: string };
}

// 会话重命名（用户手动命名；锁定后自动命名不再覆盖）
export interface RenameCommand extends CommandBase {
  type: "COMMAND_RENAME";
  payload: { session_id: string; title: string };
}

// AskUserQuestion 作答：answers[i] 对应 questions[i]（选项 label 或自由输入文本）
export interface AnswerCommand extends CommandBase {
  type: "COMMAND_ANSWER";
  payload: { session_id: string; request_id: string; answers: string[] };
}

// 云桥配对：手机经已鉴权的 LAN 信道发起（token 即信任锚，无需扫码），
// 上送手机 box 公钥，relay 回 PAIR_ACK 携带云配置 + relay 公钥
export interface PairStartCommand extends CommandBase {
  type: "COMMAND_PAIR_START";
  payload: { pubkey: string; name?: string };
}

export type Command =
  | CreateCommand
  | MessageCommand
  | StopCommand
  | ContinueCommand
  | RejectCommand
  | ExtModeCommand
  | ExtInputCommand
  | ExtStopCommand
  | DeleteCommand
  | RenameCommand
  | AnswerCommand
  | PairStartCommand
  | PermCommand;

// 托管会话权限模式切换（default=每次确认 / acceptEdits=自动接受编辑 / plan=只读规划）
export interface PermCommand extends CommandBase {
  type: "COMMAND_PERM";
  payload: { session_id: string; mode: ManagedPermissionMode };
}

// hooks 桥接：bridge-hook.mjs -> POST /bridge/hook 的请求体（token 走 x-bridge-token header）
export interface BridgeEvent {
  event: string;               // hook_event_name
  session_id: string;          // CLI 侧 session_id
  cwd: string;
  permission_mode?: string;
  transcript_path?: string;    // CLI 转录 JSONL（assistant 文本提取用）
  prompt?: string;             // UserPromptSubmit
  tool_name?: string;          // Pre/PostToolUse
  tool_input?: unknown;
  tool_response?: unknown;     // PostToolUse
  message?: string;            // Notification
  reason?: string;             // SessionEnd
  cli_pid?: number;            // hook 侧定位的 CLI 进程 pid（祖先解析+按 session_id 缓存）
}

// ---------- 命令回执（Relay -> 客户端，确认命令已受理） ----------

// 云桥配对信息（仅 COMMAND_PAIR_START 成功的 ACK 携带；手机存进 ServerEntry.cloud）
export interface CloudPairInfo {
  url: string;           // 桥地址（CCR_CLOUD_URL 原样）
  token: string;         // 桥层连接 token
  relay_dev: string;     // relay 云设备 id（rl-…，公钥派生）
  relay_pubkey: string;  // relay box 公钥 b64
}

export interface CommandAckPayload {
  command_id: string;
  ok: boolean;
  session_id?: string;   // COMMAND_CREATE 成功时返回
  error?: string;
  cloud?: CloudPairInfo; // 仅 COMMAND_PAIR_START 成功时携带
}
