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

export interface SessionState {
  session_id: string;
  relay_session_id: string;   // SDK/CLI 侧 session_id（用于 resume）
  cwd: string;
  initial_prompt: string;
  title: string;              // 人类可读标题（deriveTitle(initial_prompt)）
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
}

// 时间线历史条目（持久化 & 快照下发用）
export interface LogEntry {
  ts: number;
  kind: SessionLogPayload["kind"];
  text: string;
  tool?: string;
}

// ---------- 事件 payload（Relay -> 客户端） ----------

export interface SessionCreatedPayload {
  cwd: string;
  initial_prompt: string;
  title: string;
  model: string;
}

export interface SessionUpdatedPayload {
  status: SessionStatus;
  action_summary: string;
  stats: FileChangeStats;
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
}

export interface WaitingResolvedPayload {
  request_id: string;
  decision: "allow" | "deny";
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
  kind: "assistant_text" | "tool_use" | "tool_result" | "system" | "user_message";
  text: string;
  tool?: string;
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
  SNAPSHOT: SnapshotPayload;
};

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
  | "COMMAND_REJECT";

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

export type Command =
  | CreateCommand
  | MessageCommand
  | StopCommand
  | ContinueCommand
  | RejectCommand;

// ---------- 命令回执（Relay -> 客户端，确认命令已受理） ----------

export interface CommandAckPayload {
  command_id: string;
  ok: boolean;
  session_id?: string;   // COMMAND_CREATE 成功时返回
  error?: string;
}
