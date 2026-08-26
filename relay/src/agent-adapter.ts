import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type {
  FileChangeStats,
  SessionLogPayload,
  SessionStatus,
  TodoItem,
  TokenUsage,
  WaitingPayload,
} from "./types.js";
import {
  extractDiffStats,
  fullText,
  summarizeToolResult,
  summarizeToolUse,
  TaskTracker,
  truncate,
} from "./summarizer.js";

// streaming input 模式的 prompt 源：push 用户消息 / end 收尾
export class AsyncQueue<T> {
  private values: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("queue closed");
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  get iterable(): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = self.values.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
            if (self.closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise<IteratorResult<T>>((resolve) => self.resolvers.push(resolve));
          },
        };
      },
    };
  }
}

interface PendingPermission {
  input: Record<string, unknown>;
  resolve: (r: PermissionResult) => void;
  created_at: number;
}

export interface AgentCallbacks {
  onInit(sdkSessionId: string, model: string): void;
  onStatusChange(status: SessionStatus, actionSummary: string): void;
  onWaiting(p: WaitingPayload): void;
  onWaitingResolved(requestId: string, decision: "allow" | "deny", by?: string): void;
  onStats(stats: FileChangeStats): void;
  // 每回合 result 消息携带的 token 用量（累计口径由调用方决定）
  onUsage(usage: TokenUsage): void;
  // TodoWrite 工具调用：最新任务清单全量替换
  onTodos(todos: TodoItem[]): void;
  onLog(
    kind: SessionLogPayload["kind"],
    text: string,
    meta?: { tool?: string; full?: string; id?: string; streaming?: boolean },
  ): void;
  // 每回合结束（result 消息）：ok=true → DONE；ok=false → ERROR
  onTurnEnd(ok: boolean, reason: string, durationMs: number): void;
  // 底层流关闭（进程退出/输入收尾）
  onSessionEnd(reason: string): void;
}

interface CanUseToolOpts {
  suggestions?: PermissionUpdate[];
  toolUseID: string;
  requestId: string;
  title?: string;
  displayName?: string;
}

// 单个 Agent 会话 = 一次 query() streaming 调用。
// 注意：result 消息是"每回合"一条，不是会话终局——DONE 语义 = 当前任务完成，
// 之后 sendMessage 可再开新回合（会话保持打开直到 stop()）。
export class AgentSession {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly stats: FileChangeStats = { files_changed: 0, lines_added: 0, lines_deleted: 0 };
  private filesTouched = new Set<string>();
  private queue = new AsyncQueue<SDKUserMessage>();
  private pending = new Map<string, PendingPermission>();
  private stopping = false;
  private resultSeenForTurn = true;
  private lastSummary = "启动中";
  // 流式文本块：index->id 映射 + id->累计文本 + 当前消息内文本块 id 顺序表
  // （完整 assistant 消息的 content 数组可能重排/剔除 thinking，不能按 index 对齐，按文本块出现顺序对齐）
  private blockSeq = 0;
  private streamIdx = new Map<number, string>();
  private streamBufs = new Map<string, string>();
  private streamOrder: string[] = [];
  private lastStreamEmit = 0;
  private tasks = new TaskTracker();
  private q: Query;

  constructor(
    readonly cwd: string,
    private readonly model: string,
    private readonly cb: AgentCallbacks,
    initialPrompt: string,
  ) {
    this.pushUserMessage(initialPrompt);
    this.q = query({
      prompt: this.queue.iterable,
      options: {
        model: this.model,
        cwd: this.cwd,
        // 标记为 Relay 子进程：全局 bridge hook 据此跳过上报（避免与 managed 会话双注册）
        env: { ...process.env, CCR_RELAY_CHILD: "1" },
        permissionMode: "default",
        includePartialMessages: true,
        canUseTool: (toolName, input, opts) =>
          this.handlePermission(toolName, input, opts as CanUseToolOpts),
        stderr: (s) => {
          if (process.env.CCR_DEBUG) {
            process.stderr.write(`[cli:${this.id.slice(0, 8)}] ${s}`);
          }
        },
      },
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) this.handleMessage(msg);
      // 流正常关闭但本回合没收到 result（不应发生，防御）
      if (!this.resultSeenForTurn && !this.stopping) {
        this.cb.onTurnEnd(false, "stream closed without result", Date.now() - this.startedAt);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!this.resultSeenForTurn) {
        this.cb.onTurnEnd(this.stopping, this.stopping ? "interrupted" : message, Date.now() - this.startedAt);
      }
    } finally {
      this.denyAllPending("session closed");
      this.cb.onSessionEnd(this.stopping ? "stopped" : "stream closed");
    }
  }

  private handleMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.cb.onInit(msg.session_id, msg.model ?? this.model);
        }
        break;

      case "assistant": {
        let ti = 0;
        for (const block of msg.message.content) {
          if ((block as { type?: string }).type === "thinking") {
            const raw = (block as { thinking?: unknown }).thinking;
            const th = typeof raw === "string" ? raw.trim() : "";
            if (th) this.cb.onLog("thinking", truncate(th, 400), { full: fullText(th, 400) });
          } else if (block.type === "text" && block.text.trim()) {
            // 按出现顺序对齐流式期间的同 id 条目做替换；未经流式（如缓存命中）则新 id 追加
            const id = this.streamOrder[ti++] ?? `t${++this.blockSeq}`;
            this.cb.onLog("assistant_text", truncate(block.text, 400), {
              full: fullText(block.text, 400),
              id,
            });
            this.cb.onStatusChange("WORKING", this.lastSummary);
          } else if (block.type === "tool_use") {
            this.lastSummary = summarizeToolUse(block.name, block.input as Record<string, unknown>);
            this.cb.onLog("tool_use", this.lastSummary, { tool: block.name });
            const todos = this.tasks.feed(block.name, block.input);
            if (todos) this.cb.onTodos(todos);
            this.cb.onStatusChange("WORKING", this.lastSummary);
          }
        }
        // 完整消息已到，本条消息的流式状态作废（下一条 assistant 重新开始）
        this.streamIdx.clear();
        this.streamBufs.clear();
        this.streamOrder = [];
        break;
      }

      case "stream_event":
        this.handleStreamEvent(msg);
        break;

      case "user": {
        const content = msg.message.content;
        const blocks = Array.isArray(content) ? content : [];
        for (const b of blocks) {
          if (b && typeof b === "object" && (b as { type?: string }).type === "tool_result") {
            const tr = b as { content?: unknown };
            const structured = (msg as { tool_use_result?: unknown }).tool_use_result;
            if (process.env.CCR_DEBUG) {
              process.stderr.write(
                `[debug] tool_use_result: ${truncate(JSON.stringify(structured ?? null), 500)}\n`,
              );
            }
            extractDiffStats(structured ?? tr.content, this.stats, this.filesTouched);
            this.cb.onStats({ ...this.stats });
            this.cb.onLog("tool_result", summarizeToolResult(tr.content));
            this.cb.onStatusChange("WORKING", this.lastSummary);
          }
        }
        break;
      }

      case "result": {
        this.resultSeenForTurn = true;
        const dur = msg.duration_ms;
        const u = (msg as { usage?: TokenUsage }).usage;
        if (u && typeof u.input_tokens === "number") this.cb.onUsage(u);
        if (this.stopping) {
          this.cb.onTurnEnd(true, "interrupted", dur);
        } else if (msg.subtype === "success" && !msg.is_error) {
          this.cb.onTurnEnd(true, msg.terminal_reason ?? "success", dur);
        } else {
          const detail = (msg as { result?: string }).result ?? "";
          this.cb.onTurnEnd(false, `${msg.subtype}: ${truncate(detail, 160)}`, dur);
        }
        break;
      }

      default:
        break; // status 等次要消息忽略
    }
  }

  // 流式增量：只跟踪正文 text 块（thinking / tool input 的 delta 不下发），节流 ~200ms
  private handleStreamEvent(
    msg: SDKMessage & { type: "stream_event"; parent_tool_use_id: string | null },
  ): void {
    if (msg.parent_tool_use_id) return; // 子代理正文默认不转发
    const ev = msg.event as {
      type: string;
      index?: number;
      content_block?: { type: string };
      delta?: { type: string; text?: string };
    };
    const idx = ev.index ?? -1;
    if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
      const id = `t${++this.blockSeq}`;
      this.streamIdx.set(idx, id);
      this.streamBufs.set(id, "");
      this.streamOrder.push(id);
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const id = this.streamIdx.get(idx);
      if (!id) return;
      this.streamBufs.set(id, (this.streamBufs.get(id) ?? "") + (ev.delta.text ?? ""));
      if (Date.now() - this.lastStreamEmit >= 200) this.emitStreamBlock(id, true);
    } else if (ev.type === "content_block_stop") {
      const id = this.streamIdx.get(idx);
      if (id) this.emitStreamBlock(id, false);
    }
  }

  private emitStreamBlock(id: string, streaming: boolean): void {
    const text = this.streamBufs.get(id) ?? "";
    if (!text.trim()) return;
    this.lastStreamEmit = Date.now();
    this.cb.onLog("assistant_text", truncate(text, 400), {
      full: fullText(text, 400),
      id,
      streaming,
    });
    this.cb.onStatusChange("WORKING", this.lastSummary);
  }

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: CanUseToolOpts,
  ): Promise<PermissionResult> {
    const requestId = opts.requestId ?? opts.toolUseID;
    const summary = opts.title ?? summarizeToolUse(toolName, input);
    this.lastSummary = summary;
    this.cb.onWaiting({
      request_id: requestId,
      tool_name: toolName,
      input_summary: summary,
      suggestions: [],
    });
    this.cb.onLog("system", `等待确认: ${summary}`);
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, {
        input,
        created_at: Date.now(),
        resolve: (r) => {
          this.pending.delete(requestId);
          resolve(r);
        },
      });
    });
  }

  private pushUserMessage(text: string): void {
    this.resultSeenForTurn = false;
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  }

  sendMessage(text: string): void {
    this.pushUserMessage(text);
    this.cb.onLog("user_message", truncate(text, 200), { full: fullText(text, 200) });
    this.cb.onStatusChange("WORKING", this.lastSummary);
  }

  allow(requestId: string, by?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.resolve({ behavior: "allow", updatedInput: p.input });
    this.cb.onWaitingResolved(requestId, "allow", by);
    return true;
  }

  deny(requestId: string, reason?: string, by?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.resolve({ behavior: "deny", message: reason ?? "用户拒绝", interrupt: false });
    this.cb.onWaitingResolved(requestId, "deny", by);
    return true;
  }

  private denyAllPending(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      p.resolve({ behavior: "deny", message: reason, interrupt: false });
      this.cb.onWaitingResolved(id, "deny");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.denyAllPending("会话被停止");
    await this.q.interrupt();
    this.queue.end();
  }
}
