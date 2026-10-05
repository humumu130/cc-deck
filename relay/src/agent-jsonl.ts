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
}

function numericField(event: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
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
  const errorText = textOf(event.error) ?? textOf(event.message);
  const occurredAt = numericField(event, "occurred_at", "occurredAt", "created_at", "createdAt", "timestamp");
  const receivedAt = numericField(event, "received_at", "receivedAt", "ts") ?? now;
  if (type.includes("error") || event.error !== undefined) {
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
  const resultish = type.includes("tool_result") || type.includes("tool.completed") || type === "function_result";
  const toolish = type.includes("tool") || type.includes("command") || type === "function_call" || type === "function_result" || item?.type === "command_execution";
  const tool = typeof (event.tool ?? event.name ?? event.command ?? item?.command) === "string"
    ? String(event.tool ?? event.name ?? event.command ?? item?.command)
    : undefined;
  const text = textOf(event.delta ?? event.text ?? event.content ?? event.output ?? event.response ?? event.result ?? event.message)
    ?? textOf(item?.text ?? item?.aggregated_output);
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
    if (type.includes("error") || event.error !== undefined) {
      const message = textOf(event.error) ?? textOf(event.message) ?? "引擎返回错误";
      cb.onLog("system", message, { full: message });
      cb.onStatusChange("ERROR", message);
      this.turnTerminal = true;
      cb.onTurnEnd(false, message, 0);
      return;
    }
    if (type.includes("tool") || type.includes("command") || type === "function_call") {
      const name = String(event.name ?? event.tool ?? event.command ?? "工具");
      const detail = textOf(event.input ?? event.arguments ?? event.detail);
      cb.onLog("tool_use", `${name} 调用`, { tool: name, detail });
      cb.onStatusChange("WORKING", `${name} 执行中`);
    }
    const text = textOf(event.delta ?? event.text ?? event.content ?? event.output ?? event.response ?? event.result ?? event.message);
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
  protected readonly opts: EngineSpawnOptions;

  get childPid(): number | undefined { return this.pid; }

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
