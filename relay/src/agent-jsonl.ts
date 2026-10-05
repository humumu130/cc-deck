import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { childEnv, mapActivityState, type ActivityMapperInput, type ActivityTaskSources, type AgentCallbacks, type AgentLike, type MappedStatusDock } from "./agent-adapter.js";
import { killTree } from "./proc-tree.js";
import type { FileChangeStats, TodoItem, TokenUsage } from "./types.js";

export type { MappedStatusDock } from "./agent-adapter.js";

export type JsonLineEvent = Record<string, unknown>;

export interface EngineCapabilities {
  resume: false;
  reinjection: true;
  approval: false;
  images: false;
  usage: boolean;
  todos: boolean;
  artifacts: boolean;
  streaming: boolean;
}

export interface ProviderProfile {
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  baseUrlEnv?: string;
}

export interface EngineSpawnOptions {
  cwd: string;
  model: string;
  provider?: string;
  cb: AgentCallbacks;
  initialPrompt?: string;
  contextPacket?: string;
  command?: string;
  args?: (prompt: string) => string[];
  env?: NodeJS.ProcessEnv;
  providerProfile?: ProviderProfile;
  label: string;
}

export interface EngineConfig {
  command: string;
  provider?: ProviderProfile;
}

export interface PreflightResult {
  ok: boolean;
  command: string;
  errors: string[];
  warnings: string[];
}

export interface JsonlActivityOptions {
  capabilities: ActivityMapperInput["capabilities"];
  now?: number;
  task?: ActivityTaskSources;
  // B1a：引擎形态档位（ENGINE_JSONL_PROFILES 键）。批量流解析（mapJsonlStream）
  // 据此分档：structured=false 引擎（trae）的纯文本行是合法正文而非畸形
  profileId?: string;
}

// ---------------------------------------------------------------------------
// B1a 引擎 JSONL 形态档位表：各引擎行格式的显式备案（显式档位而非散落 if）。
// 样本来源口径（018 B1a「真 CLI 样本不凭想象」）：
//   - trae：006 §3.1 一手 help 核实——无 JSON/JSONL 输出开关（仅 -ct/--console-type
//     simple|rich），stdout 只有纯文本 → structured=false，工具/时间字段不伪造
//   - qwen-code：006 §3.2 基线 `qwen -p <prompt> --output-format json`（单对象
//     文档，whole-document 回落已兜）；是否支持 stream-json 待真机冒烟 → 宽容两吃
//   - codebuddy：006 §3.3 一手 help 核实 `--output-format text|json|stream-json`
//     实存（Claude Code 协议同构族）；事件字段词汇待真回合冒烟（§3.4 欠账）→
//     按家族同构宽容解析，不提前写成稳定契约
//   - codex：不走本表（agent-codex.ts 专用 mapper，词汇表为 0.154.0 一手实测，
//     见 docs/codex-integration-research.md 附录）
//   - zcode：unsupported 主档（agent-zcode.ts preflightZCode 显式拒绝，不进映射）
// ---------------------------------------------------------------------------
export interface EngineJsonlProfile {
  /** 引擎是否声明结构化输出开关；false = 纯文本路径（stdout 行不作事件解析） */
  structured: boolean;
  /** occurred_at 候选字段（顶层按序探测） */
  timeFields: string[];
  /** 备案注记：样本来源与冒烟欠账 */
  note: string;
}

export const ENGINE_JSONL_PROFILES: Record<string, EngineJsonlProfile> = {
  trae: {
    structured: false,
    timeFields: [],
    note: "006 §3.1 help 核实无 JSONL 开关，纯文本路径；工具/时间不伪造（§3.4.6）",
  },
  "qwen-code": {
    structured: true,
    timeFields: ["created_at", "createdAt", "timestamp"],
    note: "006 §3.2 基线 -p --output-format json 单对象；JSONL/stream 形态待冒烟，宽容两吃",
  },
  codebuddy: {
    structured: true,
    timeFields: ["occurred_at", "occurredAt", "created_at", "createdAt", "timestamp"],
    note: "006 §3.3 help 核实 stream-json 实存（Claude 协议同构族）；事件字段真回合冒烟欠账（§3.4），宽容解析",
  },
};

function numericField(event: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

// 018 :260 口径：引擎原生产生时间优先透传；没有则空（relay 侧落 relay_received
// 接收时间）。时间值兼容数字毫秒与 ISO8601 字符串（Claude 协议族 stream-json 的
// 行级 timestamp 为 ISO 字符串；既有 numericField 只吃数字，B1a 补齐）
function occurredAtOf(event: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

// Claude 协议族 stream-json 形态（codebuddy 同构；relay 自身 AgentSession 消费的
// 即同款家族）：assistant/user 行的事件体在 event.message.content（块数组或纯
// 字符串）。宽容提取为块列表，不命中返回 undefined——未知形态仍走顶层探测
function messageBlocksOf(event: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return undefined;
  return content.filter(
    (b): b is Record<string, unknown> => Boolean(b) && typeof b === "object" && !Array.isArray(b),
  );
}

function blockOf(blocks: Record<string, unknown>[] | undefined, blockType: string): Record<string, unknown> | undefined {
  return blocks?.find((b) => String(b.type ?? "").toLowerCase() === blockType);
}

function blockTextOf(blocks: Record<string, unknown>[] | undefined): string | undefined {
  if (!blocks) return undefined;
  const text = blocks
    .filter((b) => String(b.type ?? "").toLowerCase() === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text || undefined;
}

function nestedItem(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return event.item && typeof event.item === "object" && !Array.isArray(event.item)
    ? event.item as Record<string, unknown>
    : undefined;
}

export function mapJsonlActivity(raw: unknown, options: JsonlActivityOptions): MappedStatusDock {
  const now = options.now ?? Date.now();
  if (typeof raw === "string") {
    const text = raw.trim();
    return mapActivityState({
      state: "WORKING",
      activityKind: text ? "assistant_text" : undefined,
      activityText: text || undefined,
      now,
      task: options.task,
      capabilities: options.capabilities,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return mapActivityState({ state: "WORKING", now, task: options.task, capabilities: options.capabilities });
  }
  const event = raw as Record<string, unknown>;
  const item = nestedItem(event);
  const rawType = event.type ?? event.event ?? event.kind ?? item?.type;
  const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
  // B1a：Claude 协议族 stream-json（codebuddy 同构）的事件体在 message.content
  // 块数组——顶层探测不命中时按块补位；未知形态维持宽容跳过，不伪造
  const blocks = messageBlocksOf(event);
  const errorText = textOf(event.error) ?? textOf(event.message) ?? textOf(event.result);
  const occurredAt = occurredAtOf(event, ["occurred_at", "occurredAt", "created_at", "createdAt", "timestamp"]);
  const receivedAt = numericField(event, "received_at", "receivedAt", "ts") ?? now;
  // is_error（Claude 协议族 result 行的失败终态）：fail-closed 转 ERROR，不落 DONE
  const isErrorFlag = event.is_error === true || event.isError === true;
  if (type.includes("error") || event.error !== undefined || isErrorFlag) {
    return mapActivityState({
      state: "ERROR",
      activityKind: "system",
      activityText: errorText ?? "引擎返回错误",
      ts: receivedAt,
      occurred_at: occurredAt,
      now,
      task: options.task,
      capabilities: options.capabilities,
    });
  }
  const blockToolUse = blockOf(blocks, "tool_use");
  const blockToolResult = blockOf(blocks, "tool_result");
  const resultish = type.includes("tool_result") || type.includes("tool.completed") || type === "function_result" || Boolean(blockToolResult);
  const toolish = type.includes("tool") || type.includes("command") || type === "function_call" || type === "function_result" || item?.type === "command_execution" || Boolean(blockToolUse);
  const tool = typeof (event.tool ?? event.name ?? event.command ?? item?.command) === "string"
    ? String(event.tool ?? event.name ?? event.command ?? item?.command)
    : typeof blockToolUse?.name === "string"
      ? blockToolUse.name
      : undefined;
  const text = textOf(event.delta ?? event.text ?? event.content ?? event.output ?? event.response ?? event.result ?? event.message)
    ?? textOf(item?.text ?? item?.aggregated_output)
    ?? blockTextOf(blocks)
    ?? (blockToolResult ? textOf(blockToolResult.content) : undefined);
  const terminal = type.includes("done") || type.includes("complete") || type === "result" || type === "finish" || event.done === true;
  return mapActivityState({
    state: terminal ? "DONE" : "WORKING",
    activityKind: resultish ? "tool_result" : toolish ? "tool_use" : text ? "assistant_text" : undefined,
    activityText: text ?? (toolish ? `${tool ?? "工具"} 执行中` : undefined),
    tool,
    ts: receivedAt,
    occurred_at: occurredAt,
    now,
    task: options.task,
    capabilities: options.capabilities,
  });
}

export interface JsonlStreamOutcome {
  /** 每个成功解析（或纯文本档合法正文）行的映射结果，按行序 */
  docks: MappedStatusDock[];
  /** 成功解析为事件的行数 */
  parsed: number;
  /** 畸形行数（JSONL 档单行解析失败）：跳过并计数，不中断流（018 B1a 验收口径） */
  malformed: number;
  /** 纯文本档（structured=false）按正文处理的行数 */
  textLines: number;
}

// B1a 批量纯函数面：逐行 parse → mapJsonlActivity，fixture 直跑断言用
//（JsonProcessAgentSession 流式路径的同一口径在 execTurn close 兜底处落地）。
// profileId 缺省按 JSONL 保守档（解析失败计 malformed）；structured=false 档
//（trae）纯文本行是合法正文——走 mapJsonlActivity string 分支不计数为畸形。
// 空行不计（分帧噪声，非事件）。
export function mapJsonlStream(lines: string[], options: JsonlActivityOptions): JsonlStreamOutcome {
  const structured = options.profileId
    ? ENGINE_JSONL_PROFILES[options.profileId]?.structured !== false
    : true;
  const docks: MappedStatusDock[] = [];
  let parsed = 0;
  let malformed = 0;
  let textLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      if (!structured) {
        textLines += 1;
        docks.push(mapJsonlActivity(trimmed, options));
        continue;
      }
      malformed += 1;
      continue;
    }
    parsed += 1;
    docks.push(mapJsonlActivity(event, options));
  }
  return { docks, parsed, malformed, textLines };
}

export function splitUtf8Lines(): {
  push(chunk: Buffer): string[];
  flush(): string[];
} {
  let pending = Buffer.alloc(0);
  const take = (): string[] => {
    const lines: string[] = [];
    let at = pending.indexOf(0x0a);
    while (at >= 0) {
      const line = pending.subarray(0, at).toString("utf8").trim();
      pending = pending.subarray(at + 1);
      if (line) lines.push(line);
      at = pending.indexOf(0x0a);
    }
    return lines;
  };
  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      return take();
    },
    flush() {
      const tail = pending.toString("utf8").trim();
      pending = Buffer.alloc(0);
      return tail ? [tail] : [];
    },
  };
}

export function parseJsonDocument(lines: string[]): unknown[] {
  if (lines.length === 0) return [];
  const parsed: unknown[] = [];
  let failed = false;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      failed = true;
      break;
    }
  }
  if (!failed && parsed.length === lines.length) return parsed;
  const whole = lines.join("\n").trim();
  if (!whole) return [];
  try {
    return [JSON.parse(whole)];
  } catch {
    return [];
  }
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map(textOf).filter((x): x is string => Boolean(x)).join("");
    return text || undefined;
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const key of ["text", "content", "output", "response", "result", "message"]) {
      const text = textOf(v[key]);
      if (text) return text;
    }
  }
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageOf(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const input = numberOf(u.input_tokens ?? u.inputTokens);
  const output = numberOf(u.output_tokens ?? u.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    cache_read_input_tokens: numberOf(u.cache_read_input_tokens ?? u.cacheReadInputTokens) ?? 0,
    cache_creation_input_tokens: numberOf(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens) ?? 0,
  };
}

export class GenericJsonEventMapper {
  turnTerminal = false;
  private textSequence = 0;
  private initialized = false;

  handle(raw: unknown, cb: AgentCallbacks): void {
    if (Array.isArray(raw)) {
      for (const item of raw) this.handle(item, cb);
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const event = raw as JsonLineEvent;
    const type = String(event.type ?? event.event ?? event.kind ?? "").toLowerCase();
    const sessionId = [event.session_id, event.sessionId, event.thread_id, event.threadId, event.id]
      .find((x): x is string => typeof x === "string" && x.length > 0);
    const model = typeof event.model === "string" ? event.model : undefined;
    if (!this.initialized && (sessionId || type === "init" || type === "session.started" || type === "session_start")) {
      this.initialized = true;
      cb.onInit(sessionId ?? "external", model ?? "unknown");
    }
    // B1a：is_error（Claude 协议族 result 行失败终态）与顶层 error 同档 fail-closed
    const isErrorFlag = event.is_error === true || event.isError === true;
    if (type.includes("error") || event.error !== undefined || isErrorFlag) {
      const message = textOf(event.error) ?? textOf(event.message) ?? textOf(event.result) ?? "引擎返回错误";
      cb.onLog("system", message, { full: message });
      cb.onStatusChange("ERROR", message);
      this.turnTerminal = true;
      cb.onTurnEnd(false, message, 0);
      return;
    }
    // B1a：Claude 协议族 stream-json（codebuddy 同构）块形态补位——tool_use/
    // tool_result 块在 message.content 里，与顶层探测两吃（块缺失零行为变化）
    const blocks = messageBlocksOf(event);
    const blockToolUse = blockOf(blocks, "tool_use");
    const blockToolResult = blockOf(blocks, "tool_result");
    if (type.includes("tool") || type.includes("command") || type === "function_call" || blockToolUse) {
      const name = String(event.name ?? event.tool ?? event.command ?? blockToolUse?.name ?? "工具");
      const detail = textOf(event.input ?? event.arguments ?? event.detail ?? blockToolUse?.input);
      cb.onLog("tool_use", `${name} 调用`, { tool: name, detail });
      cb.onStatusChange("WORKING", `${name} 执行中`);
    }
    if (blockToolResult) {
      const resultText = textOf(blockToolResult.content) ?? "工具结果";
      cb.onLog("tool_result", resultText.slice(0, 400), { full: resultText });
      cb.onStatusChange("WORKING", "工具结果");
    }
    const text = textOf(event.delta ?? event.text ?? event.content ?? event.output ?? event.response ?? event.result ?? event.message) ?? blockTextOf(blocks);
    if (text) {
      const id = `jsonl-${++this.textSequence}`;
      cb.onLog("assistant_text", text.slice(0, 400), { full: text, id });
      cb.onStatusChange("WORKING", "生成回复");
    } else if (!type || type === "log" || type === "progress" || type === "status") {
      cb.onStatusChange("WORKING", "引擎运行中");
    }
    const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : undefined;
    const usage = usageOf(event.usage ?? message?.usage ?? event.stats);
    if (usage) {
      cb.onUsage(usage);
      cb.onContext?.(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens);
    }
    const todos = Array.isArray(event.todos) ? event.todos as TodoItem[] : undefined;
    if (todos) cb.onTodos(todos);
    const terminal = type.includes("done") || type.includes("complete") || type === "result" || type === "finish" || event.done === true;
    if (terminal && !this.turnTerminal) {
      this.turnTerminal = true;
      cb.onTurnEnd(true, textOf(event.message) ?? "success", 0);
    }
  }
}

function safeProviderEnv(profile: ProviderProfile | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (profile?.apiKeyEnv) env[profile.apiKeyEnv] = process.env[profile.apiKeyEnv];
  if (profile?.baseUrlEnv) env[profile.baseUrlEnv] = process.env[profile.baseUrlEnv];
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

export function preflightEngine(config: EngineConfig): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!config.command.trim()) errors.push("未配置 CLI 命令");
  if (config.command.includes("/") || config.command.includes("\\")) {
    try {
      accessSync(config.command, constants.X_OK);
    } catch {
      errors.push("CLI 命令不存在或不可执行");
    }
  } else if (config.command.trim()) {
    const probe = spawnSync("which", [config.command], { stdio: "ignore" });
    if (probe.status !== 0) errors.push("CLI 未在当前 PATH 探测到");
  }
  if (config.provider?.baseUrl) {
    try {
      new URL(config.provider.baseUrl);
    } catch {
      errors.push("base URL 无法解析");
    }
  }
  if (config.provider?.apiKeyEnv && !process.env[config.provider.apiKeyEnv]) {
    errors.push(`provider 密钥环境变量未设置: ${config.provider.apiKeyEnv}`);
  }
  if (config.provider?.baseUrlEnv && !process.env[config.provider.baseUrlEnv]) {
    errors.push(`provider base URL 环境变量未设置: ${config.provider.baseUrlEnv}`);
  }
  if (!config.command.includes("/") && !config.command.includes("\\")) {
    warnings.push("命令存在性需在目标运行环境 PATH 中核验");
  }
  return { ok: errors.length === 0, command: config.command, errors, warnings };
}

export abstract class JsonProcessAgentSession implements AgentLike {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly stats: FileChangeStats = { files_changed: 0, lines_added: 0, lines_deleted: 0 };
  ended = false;
  protected proc: ChildProcess | null = null;
  protected pid: number | undefined;
  private queued: string[] = [];
  private stopping = false;
  private initialized = false;
  private contextPacket: string;
  private stderrTail = "";
  private mapper = new GenericJsonEventMapper();
  private jsonCandidateLines: string[] = [];
  // B1a 畸形行计数：JSONL 档单行解析失败跳过并计数（不中断流）。批量纯函数面
  // mapJsonlStream 同口径供 fixture 直跑断言；此处是流式会话侧的落地
  private malformedLines = 0;
  protected readonly opts: EngineSpawnOptions;

  get childPid(): number | undefined { return this.pid; }

  /** 本会话累计的畸形行数（单行解析失败被跳过的行；诊断面用，不影响流） */
  get malformedLineCount(): number {
    return this.malformedLines;
  }

  constructor(opts: EngineSpawnOptions) {
    this.opts = opts;
    this.contextPacket = opts.contextPacket ?? `CC Deck context packet\nengine=${opts.label}\ncwd=${opts.cwd}`;
    if (opts.initialPrompt !== undefined) this.execTurn(opts.initialPrompt);
  }

  protected abstract buildArgs(prompt: string): string[];

  sendMessage(text: string, _images?: string[], echo?: string): void {
    if (this.ended) return;
    this.opts.cb.onLog("user_message", echo ?? text.slice(0, 200), { full: echo ?? text });
    if (this.proc) {
      this.queued.push(text);
      return;
    }
    this.execTurn(text);
  }

  allow(): boolean { return false; }
  deny(): boolean { return false; }
  answer(): boolean { return false; }
  hasPending(): boolean { return false; }
  async setPermissionMode(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.ended) return;
    this.stopping = true;
    this.ended = true;
    this.queued = [];
    const pid = this.pid;
    this.proc = null;
    this.pid = undefined;
    this.opts.cb.onSessionEnd("stopped");
    if (pid) await killTree(pid).catch(() => {});
  }

  private promptFor(text: string): string {
    return `${this.contextPacket}\n\n当前用户消息:\n${text}`;
  }

  private execTurn(text: string): void {
    const prompt = this.promptFor(text);
    const command = this.opts.command ?? this.opts.label;
    const args = this.buildArgs(prompt);
    const env = {
      ...childEnv(),
      ...safeProviderEnv(this.opts.providerProfile),
      ...this.opts.env,
      CCR_ENGINE: this.opts.label,
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      this.fail(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.proc = child;
    this.pid = child.pid;
    this.stderrTail = "";
    this.mapper = new GenericJsonEventMapper();
    this.jsonCandidateLines = [];
    if (!this.initialized) {
      queueMicrotask(() => {
        if (this.initialized || this.ended) return;
        this.initialized = true;
        this.opts.cb.onInit(this.id, this.opts.model);
      });
    }
    this.opts.cb.onStatusChange("WORKING", `${this.opts.label} 启动中`);
    const framer = splitUtf8Lines();
    const lines: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of framer.push(chunk)) {
        lines.push(line);
        this.handleLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-500);
    });
    child.on("error", (error) => this.fail(`进程错误: ${error.message}`));
    child.on("close", (code) => {
      for (const line of framer.flush()) {
        lines.push(line);
        this.handleLine(line);
      }
      if (this.jsonCandidateLines.length > 1) {
        const fallback = parseJsonDocument(this.jsonCandidateLines);
        if (fallback.length === 1) {
          this.mapper.handle(fallback[0], this.mapperCallbacks());
        } else if (fallback.length === 0) {
          // B1a 畸形行口径：候选行整体解析失败 = 单行解析失败跳过并计数，
          // 留痕可见但不中断流（进程已退，此处在 close 收尾里补记）
          this.malformedLines += this.jsonCandidateLines.length;
          this.opts.cb.onLog(
            "system",
            `${this.opts.label}: ${this.jsonCandidateLines.length} 行无法解析为 JSON，已跳过`,
            { full: this.jsonCandidateLines.map((l) => l.slice(0, 120)).join("\n") },
          );
        }
      }
      this.proc = null;
      this.pid = undefined;
      if (this.stopping) return;
      if (!this.mapper.turnTerminal) {
        if (code === 0) {
          this.mapper.turnTerminal = true;
          this.opts.cb.onTurnEnd(true, "success", 0);
        } else {
          const detail = this.stderrTail.trim().split("\n").at(-1) || `退出码 ${code ?? "unknown"}`;
          this.opts.cb.onLog("system", `${this.opts.label}: ${detail}`, { full: detail });
          this.opts.cb.onStatusChange("ERROR", detail);
          this.mapper.turnTerminal = true;
          this.opts.cb.onTurnEnd(false, `${this.opts.label}: ${detail}`, 0);
        }
      }
      if (!this.initialized) {
        this.initialized = true;
        this.opts.cb.onInit(this.id, this.opts.model);
      }
      if (this.queued.length > 0 && !this.ended) {
        const next = this.queued.shift()!;
        this.execTurn(next);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt, "utf8");
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (this.jsonCandidateLines.length > 0 || line.startsWith("{") || line.startsWith("[")) {
        this.jsonCandidateLines.push(line);
        return;
      }
      this.opts.cb.onLog("assistant_text", line.slice(0, 400), { full: line });
      this.opts.cb.onStatusChange("WORKING", "引擎输出中");
      return;
    }
    this.jsonCandidateLines = [];
    this.mapper.handle(parsed, this.mapperCallbacks());
  }

  private mapperCallbacks(): AgentCallbacks {
    return {
      ...this.opts.cb,
      onInit: (id, model, permission) => {
        this.initialized = true;
        this.opts.cb.onInit(id === "external" ? this.id : id, model === "unknown" ? this.opts.model : model, permission);
      },
    };
  }

  private fail(message: string): void {
    if (this.stopping || this.ended) return;
    this.mapper.turnTerminal = true;
    this.opts.cb.onLog("system", message, { full: message });
    this.opts.cb.onStatusChange("ERROR", message);
    this.opts.cb.onTurnEnd(false, message, 0);
  }
}

/** 用户声明命令/argv 模板时使用的冷门 CLI 兜底，不进入预置引擎白名单。 */
export class GenericJsonlAgentSession extends JsonProcessAgentSession {
  protected buildArgs(prompt: string): string[] {
    return this.opts.args?.(prompt) ?? [];
  }
}
