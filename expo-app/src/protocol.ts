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
  headcount?: { session_id: string; role: string; joined_at: number }[];
  note?: string;
}

// 待决议确认卡（SNAPSHOT.org_confirms / ORG_CONFIRM_UPDATED）：Leader 只提案，
// 用户 ✓/✗ 决议（COMMAND_ORG_CONFIRM）；decided 后不再出现在 pending 清单
export interface OrgConfirm {
  id: string;
  kind: "project-create" | "tier-change" | "suggest-hold" | "archive" | "revive";
  title: string;
  reason?: string;
  created_at: number;
  status: "pending" | "approved" | "rejected";
  payload?: Record<string, unknown>;
}

// 任务板条目（COMMAND_PROJECT_DETAIL.board 携带；BOARD_UPDATED 增量维护）
export interface BoardEntry {
  id: string;
  text: string;
  status: "todo" | "doing" | "done";
  note?: string;
  owner_session?: string;
  dispatch_id?: string;
  created_at: number;
  updated_at: number;
}

export interface ProjectBoard {
  gid: string;
  frozen: boolean;
  entries: BoardEntry[];
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
  | "COMMAND_LOGIN_GRANT"
  | "COMMAND_WATCH_GRANT"
  | "COMMAND_PERM"
  | "COMMAND_MODEL"
  | "COMMAND_REFRESH_TODOS"
  | "COMMAND_ARTIFACT_FETCH"
  | "COMMAND_ALLOW_RULE_REMOVE"
  | "COMMAND_ORG_CONFIRM" // #26 M2 确认卡决议（✓/✗；relay 单漏斗 orgAction）
  | "COMMAND_PROJECT_DETAIL"; // #26 M2 项目组详情 { group, board, receipts } 按需拉取

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
  pair_code?: { code: string; expires_in: number };
  // #79 仅 COMMAND_ARTIFACT_FETCH 成功 ACK 携带：字节数 + 扩展名推导 MIME
  //（分级预览用；数据本体走 ARTIFACT_CHUNK 瞬态帧，ref=command_id）
  artifact?: { size: number; mime: string };
  // #26 M2/M3 仅 COMMAND_PROJECT_DETAIL 成功 ACK 携带：{ group, board, receipts, pool }
  data?: unknown;
}
