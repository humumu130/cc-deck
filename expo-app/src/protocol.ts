// Relay <-> 客户端协议子集（与 relay/src/types.ts 保持同步）
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
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  active_form?: string;
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
  waiting_request?: WaitingPayload | null;
  stats: FileChangeStats;
  last_error?: string;
  done_reason?: string;
  duration_ms?: number;
  historical?: boolean;
  external?: boolean;
  remote_mode?: boolean;
  cli_pid?: number;
  elapsed_hint?: number;
  turn_started_at?: number;
  usage?: TokenUsage;
  todos?: TodoItem[];
  title_locked?: boolean;
  permission_mode?: "default" | "acceptEdits" | "plan"; // 托管会话权限模式
  pending_inputs?: PendingInput[]; // 外部会话已发送未处理的注入消息（显示在工作指示器下方，处理时上浮为正式消息）
}

export interface PendingInput {
  text: string;
  ts: number;
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
}

export interface Envelope {
  seq: number;
  session_id: string;
  ts: number;
  type: string;
  payload: any;
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
  | "COMMAND_PERM";

// 云桥配对信息：relay 经可信 LAN 信道下发，手机落盘后即可走云通道
export interface CloudPairInfo {
  url: string;
  token: string;
  relay_dev: string;
  relay_pubkey: string;
}

export interface CommandAck {
  type: "COMMAND_ACK";
  command_id: string;
  ok: boolean;
  session_id?: string;
  error?: string;
  cloud?: CloudPairInfo;
}
