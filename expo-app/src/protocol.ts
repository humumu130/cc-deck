// Relay <-> 客户端协议子集（与 relay/src/types.ts 保持同步）
export type SessionStatus = "WORKING" | "WAITING" | "ERROR" | "DONE";

export interface FileChangeStats {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
}

export interface WaitingPayload {
  request_id: string;
  tool_name: string;
  input_summary: string;
  suggestions: string[];
  decidable?: boolean;
  received_at?: number;
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
}

export interface LogEntry {
  ts: number;
  kind: "assistant_text" | "tool_use" | "tool_result" | "system" | "user_message";
  text: string;
  tool?: string;
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
  | "COMMAND_DELETE";

export interface CommandAck {
  type: "COMMAND_ACK";
  command_id: string;
  ok: boolean;
  session_id?: string;
  error?: string;
}
