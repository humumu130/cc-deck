import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, join } from "node:path";
import { resolveClaudeCliPath } from "./cli-path.js";
import type {
  FileChangeStats,
  SessionLogPayload,
  SessionStatus,
  TodoItem,
  TokenUsage,
  WaitingPayload,
} from "./types.js";
import {
  buildAnswerMessage,
  detailToolResult,
  detailToolUse,
  diffLines,
  extractDiffStats,
  fileEditMetrics,
  fullText,
  parseAskQuestions,
  summarizeToolResult,
  summarizeToolUse,
  TaskTracker,
  truncate,
  capDetail,
  zaiToolName,
  isZaiOutput,
  zaiBridgePrefix,
  splitZaiText,
} from "./summarizer.js";

// 会话子进程环境（M0，2026-09-18）：relay 守护进程常由 Finder/launchd/Tauri 拉起，
// PATH 仅 /usr/bin:/bin:/usr/sbin:/sbin——会话里 hook 报 node: command not found、
// gradle 报 Cannot run program "node"（当日实证），每个会话被迫手动补 PATH。spawn 时
// 统一补常见安装目录（不存在的目录在 PATH 里无害），CCR_EXTRA_PATH 可追加自定义位。
export function childEnv(): NodeJS.ProcessEnv {
  const extra = [
    join(homedir(), "node/bin"),       // 用户级 node（本机实证位置）
    "/usr/local/bin",                  // macOS Intel / 惯装位
    "/opt/homebrew/bin",               // macOS Apple Silicon (homebrew)
    join(homedir(), ".npm-global/bin"), // npm 全局自定义前缀惯用位
    ...(process.env.CCR_EXTRA_PATH ? process.env.CCR_EXTRA_PATH.split(pathDelimiter) : []),
  ];
  const cur = (process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  const merged = [...cur, ...extra.filter((d) => d && !cur.includes(d))];
  return {
    ...process.env,
    PATH: merged.join(pathDelimiter),
    CCR_RELAY_CHILD: "1",
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
  };
}

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
  onInit(sdkSessionId: string, model: string, permissionMode?: string): void;
  onStatusChange(status: SessionStatus, actionSummary: string): void;
  onWaiting(p: WaitingPayload): void;
  // superseded = CLI 已自行越过权限门（新输入打断/回合推进），relay 清扫孤儿 pending 补发
  onWaitingResolved(requestId: string, decision: "allow" | "deny" | "answer" | "superseded", by?: string): void;
  onStats(stats: FileChangeStats): void;
  // #35 输出物：Edit/Write 类工具单条产出（tool_use/tool_result 配对后回调；
  // 可选——非会话级实现方（标题生成等）无需关心）
  onArtifacts?(item: { path: string; tool: string; adds: number; dels: number; created: boolean; ts: number }): void;
  // 每回合 result 消息携带的 token 用量（累计口径由调用方决定）
  onUsage(usage: TokenUsage): void;
  // TodoWrite 工具调用：最新任务清单全量替换
  onTodos(todos: TodoItem[]): void;
  onLog(
    kind: SessionLogPayload["kind"],
    text: string,
    meta?: { tool?: string; full?: string; id?: string; streaming?: boolean; detail?: string; diff?: string[] },
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

// SessionManager 依赖的最小 agent 形状（#49）：AgentSession 结构性满足；测试可注入
// 假实现验证置顶/按需恢复路径，免拉真 CLI 子进程
export interface AgentLike {
  readonly id: string;
  readonly startedAt: number;
  ended: boolean;
  // echo（#62）：客户端回显文本（文件消息正文合成路径指令后传原文本短回显，不露临时
  // 路径）；不传则回显 = 截断正文 + 图片计数
  sendMessage(text: string, images?: string[], echo?: string): void;
  allow(requestId: string, by?: string): boolean;
  deny(requestId: string, reason?: string, by?: string): boolean;
  answer(requestId: string, answers: string[], by?: string): boolean;
  stop(): Promise<void>;
  setPermissionMode(mode: "default" | "acceptEdits" | "plan" | "bypassPermissions"): Promise<void>;
  // 可选：是否仍有未决议的权限请求——session-manager 的 WAITING 保持判定用；
  // 测试假 agent 未实现时按"无挂起"处理（hasPending?.() ?? false）
  hasPending?(): boolean;
  // 可选：CLI 子进程 pid——#7 看门狗的进程树 CPU 采样与杀树用；假 agent/非进程
  // 实现（云通道等）没有，看门狗采不到就退化为"纯时间窗判定"（不杀，只放弃）
  readonly childPid?: number;
}

// 单个 Agent 会话 = 一次 query() streaming 调用。
// 注意：result 消息是"每回合"一条，不是会话终局——DONE 语义 = 当前任务完成，
// 之后 sendMessage 可再开新回合（会话保持打开直到 stop()）。
export class AgentSession {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly stats: FileChangeStats = { files_changed: 0, lines_added: 0, lines_deleted: 0 };
  // 流已关闭（stop/进程退出）：此后 sendMessage 不可用，调用方走 resume 重建
  ended = false;
  // #7 看门狗：CLI 子进程 pid（spawnClaudeCodeProcess 包装时捕获）。SDK 默认 spawn
  // 的行为逐项镜像（stdio 三 pipe + cwd/env/signal），仅多记一个 pid
  readonly childPid: number | undefined;
  private filesTouched = new Set<string>();
  // #35 输出物配对账：Edit/Write 类 tool_use 的 callId → { 工具名, file_path }，
  // 同消息流的 tool_result（tool_use_id）命中即产出一条（未配对的被打断调用自然丢弃）
  private pendingFileUses = new Map<string, { tool: string; path: string }>();
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
    // undefined = 不注入任何用户消息：#49 按需恢复的 parked 形态（resume 拉起后停在
    // 等待输入，首个回合由后续 sendMessage 开启）。空串与 undefined 语义不同：
    // 空串照旧推送（保持既有 create/resume 调用行为逐字节不变）
    initialPrompt: string | undefined,
    opts?: { resume?: string; permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions"; images?: string[] },
  ) {
    if (initialPrompt !== undefined || (opts?.images?.length ?? 0) > 0) {
      this.pushUserMessage(initialPrompt ?? "", opts?.images);
    }
    // 单文件 bundle 部署后 SDK 找不到包内平台二进制（见 cli-path.ts 头注释），
    // 解析失败时给出可行动的中文报错（直通 create 的 ack.error → 客户端 toast）
    const cliPath = resolveClaudeCliPath();
    if (!cliPath) {
      throw new Error(
        "未找到可用的 Claude Code CLI：请先安装 Claude Code，或设置环境变量 CC_DECK_CLAUDE_PATH 指向 claude 可执行文件后重启",
      );
    }
    this.q = query({
      prompt: this.queue.iterable,
      options: {
        model: this.model,
        cwd: this.cwd,
        pathToClaudeCodeExecutable: cliPath,
        // 标记为 Relay 子进程：全局 bridge hook 据此跳过上报（避免与 managed 会话双注册）
        // CLAUDE_CODE_ENABLE_TODO_TOOLS：CLI 按模型身份门控任务工具（TaskCreate/Get/Update/
        // List 仅对 Claude 系模型默认提供），GLM 等其它模型一律裁剪→任务面板恒空。官方
        // 逃生门即此 env——托管会话必须注入，与模型无关（用户级 settings 兜底见 todo-tools-env.ts）
        // PATH 补全：见 childEnv()（M0）
        env: childEnv(),
        permissionMode: opts?.permissionMode ?? "default",
        ...(opts?.resume ? { resume: opts.resume } : {}),
        // #7 看门狗：包一层默认 spawn 记 pid（SDK 默认行为 = spawn(cmd, args,
        // {stdio 三 pipe, cwd, env, signal})，这里逐项镜像）。杀树/CPU 采样都要 pid
        spawnClaudeCodeProcess: (o) => {
          if (process.env.CCR_DEBUG) {
            process.stderr.write(`[spawn-hook] command=${o.command} args=${JSON.stringify(o.args)} cwd=${o.cwd ?? ""}\n`);
          }
          const child = spawn(o.command, o.args, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: o.cwd,
            env: o.env,
            signal: o.signal,
          });
          (this as { childPid: number | undefined }).childPid = child.pid ?? undefined;
          return child;
        },
        includePartialMessages: true,
        canUseTool: (toolName, input, opts2) =>
          this.handlePermission(toolName, input, opts2 as CanUseToolOpts),
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
      this.ended = true;
      this.denyAllPending("session closed");
      this.cb.onSessionEnd(this.stopping ? "stopped" : "stream closed");
    }
  }

  private handleMessage(msg: SDKMessage): void {
    // 审批弹窗死锁根治②：CLI 出现真实推进（模型生成 / 工具结果 / 回合结束）却仍有
    // 未决议的权限请求 = CLI 已自行越过该权限门（典型：WAITING 中用户又发了新消息，
    // CLI 打断当前工具调用），请求作废——补发 RESOLVED(superseded) 收起各端残留的
    // 审批面板并清掉孤儿 pending（否则 promise 与 Map 条目双双泄漏）。
    // 只在"能证明 CLI 没阻塞在 canUseTool"的消息上清扫：assistant/stream_event/result；
    // user 消息仅在含 tool_result 时算证明（纯文本回显不能——CLI 可能仍阻塞，排队
    // 消息恰在此时到达）；子代理消息（parent_tool_use_id 非空）不算——主流程的
    // pending 与子代理生成可并存，误清会把活请求 deny 掉
    const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (
      !parent &&
      (msg.type === "assistant" || msg.type === "stream_event" || msg.type === "result" ||
        (msg.type === "user" && this.msgHasToolResult(msg)))
    ) {
      this.sweepStalePending();
    }
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.cb.onInit(msg.session_id, msg.model ?? this.model, msg.permissionMode);
        }
        break;

      case "assistant": {
        let ti = 0;
        for (const block of msg.message.content) {
          if ((block as { type?: string }).type === "thinking") {
            const raw = (block as { thinking?: unknown }).thinking;
            const th = typeof raw === "string" ? raw.trim() : "";
            if (th) this.cb.onLog("thinking", truncate(th, 400), { full: fullText(th, 400) });
          } else if (block.type === "text" && !block.text.trim()) {
            // 空白 text 块：content_block_start 已登记 streamOrder 槽位，终态跳过不消费
            // 会让后续正文错拿前块 id，流式气泡残留成孤儿——消费掉
            ti += 1;
          } else if (block.type === "text") {
            // z.ai 内置工具桥的展示文本（过程噪声）：归工具类日志，不进"消息"视图
            const zn = zaiToolName(block.text);
            if (zn) {
              // 消费该块在流式期间登记的 streamOrder 槽位（emitStreamBlock 静默未下发，id 作废），
              // 否则同消息后续正文会错拿本块的流式 id，终态找不到同 id 替换 → 正文双气泡
              ti += 1;
              this.lastSummary = `zai 内置 ${zn.slice(4)}`;
              this.cb.onLog("tool_use", this.lastSummary, { tool: zn, detail: capDetail(block.text, 2000) });
              this.cb.onStatusChange("WORKING", this.lastSummary);
            } else if (isZaiOutput(block.text)) {
              ti += 1; // 同上：消费静默块的流式槽位
              this.cb.onLog("tool_result", "zai 内置工具结果", { tool: "zai", detail: capDetail(block.text, 2000) });
            } else {
              // #265 混合形态：正文尾部被 z.ai append 桥调用/输出——拆段，桥段归
              // 工具日志，正文复用流式 id 原地替换（流式期间已只下发正文部分）
              const { body, segs } = splitZaiText(block.text);
              const id = this.streamOrder[ti++] ?? `t${++this.blockSeq}`;
              if (body) {
                this.cb.onLog("assistant_text", truncate(body, 400), {
                  full: fullText(body, 400),
                  id,
                });
              }
              for (const sg of segs) {
                if (sg.kind === "tool_use") this.lastSummary = `zai 内置 ${sg.tool.slice(4)}`;
                this.cb.onLog(sg.kind, sg.kind === "tool_use" ? `zai 内置 ${sg.tool.slice(4)} 调用` : "zai 内置工具结果", {
                  tool: sg.kind === "tool_use" ? sg.tool : "zai",
                  detail: capDetail(sg.raw, 2000),
                });
              }
              this.cb.onStatusChange("WORKING", this.lastSummary);
            }
          } else if (block.type === "tool_use") {
            this.lastSummary = summarizeToolUse(block.name, block.input as Record<string, unknown>);
            this.cb.onLog("tool_use", this.lastSummary, {
              tool: block.name,
              detail: detailToolUse(block.name, block.input as Record<string, unknown>),
            });
            // #35 输出物：四类文件工具登记待配对（结果帧按 tool_use_id 回取路径）
            if (
              (block.name === "Write" || block.name === "Edit" || block.name === "MultiEdit" || block.name === "NotebookEdit") &&
              typeof (block.input as { file_path?: unknown } | null)?.file_path === "string" &&
              typeof (block as { id?: unknown }).id === "string"
            ) {
              this.pendingFileUses.set((block as { id: string }).id, {
                tool: block.name,
                path: (block.input as { file_path: string }).file_path,
              });
              if (this.pendingFileUses.size > 64) {
                // 防泄漏上限：串行执行下账目应近实时清空，异常堆积丢最旧
                this.pendingFileUses.delete(this.pendingFileUses.keys().next().value as string);
              }
            }
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
            // #35 输出物：tool_use_id 回取登记的文件工具调用，产出一条（无 diff 数据
            // 的失败/中断调用 metrics 为 null 自然跳过；命中即清账防重复配对）
            const callId = (b as { tool_use_id?: unknown }).tool_use_id;
            if (typeof callId === "string" && this.pendingFileUses.has(callId)) {
              const use = this.pendingFileUses.get(callId)!;
              this.pendingFileUses.delete(callId);
              const m = fileEditMetrics(structured ?? tr.content);
              if (m) {
                this.cb.onArtifacts?.({
                  path: use.path,
                  tool: use.tool,
                  adds: m.adds,
                  dels: m.dels,
                  created: m.created,
                  ts: Date.now(),
                });
              }
            }
            this.cb.onLog("tool_result", summarizeToolResult(tr.content), {
              detail: detailToolResult(structured ?? tr.content),
              diff: diffLines(structured),
            });
            const todos = this.tasks.feedResult(structured);
            if (todos) this.cb.onTodos(todos);
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
    // zai 工具桥展示文本流式期间静默：完整 assistant 消息到达时在上方分支归类为工具日志。
    // 只挡前缀会漏 "**Output:**" 块——其流式条目带 id 下发后终态重分类不复用该 id，
    // relay 与客户端均只按 id 替换不删除，会永久残留超长 JSON。
    // #265 混合形态（正文+桥文本同块）：前缀判定不命中，拆段后只下发正文部分，
    // 桥段（含半截锚，Built-in 行起吞到尾）静默——终态到达时归类补全
    if (zaiBridgePrefix(text)) return;
    const { body, segs } = splitZaiText(text);
    if (segs.length && !body) return;
    this.lastStreamEmit = Date.now();
    this.cb.onLog("assistant_text", truncate(body || text, 400), {
      full: fullText(body || text, 400),
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
    // AskUserQuestion：结构化问题下发，客户端渲染选项作答
    const questions = toolName === "AskUserQuestion" ? parseAskQuestions(input) : [];
    const summary = questions.length
      ? `提问: ${questions.map((q) => q.header).join(" / ")}`
      : opts.title ?? summarizeToolUse(toolName, input);
    this.lastSummary = summary;
    this.cb.onWaiting({
      request_id: requestId,
      tool_name: toolName,
      input_summary: summary,
      suggestions: [],
      ...(questions.length ? { questions } : {}),
    });
    this.cb.onLog("system", questions.length ? summary : `等待确认: ${summary}`);
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

  private pushUserMessage(text: string, images?: string[]): void {
    this.resultSeenForTurn = false;
    let content: string | SDKUserMessage["message"]["content"];
    if (images && images.length > 0) {
      content = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...images.map((data) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/jpeg" as const, data },
        })),
      ];
    } else {
      content = text;
    }
    this.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  }

  sendMessage(text: string, images?: string[], echo?: string): void {
    this.pushUserMessage(text, images);
    const marker = images && images.length > 0 ? `（+${images.length} 图）` : "";
    if (echo !== undefined) {
      // #62 文件消息：回显/展开都用调用方给的短文本（正文含临时路径，不对账展示）
      this.cb.onLog("user_message", echo, { full: fullText(echo, 200) });
    } else {
      const full = fullText(text, 200);
      this.cb.onLog("user_message", truncate(text, 200) + marker, { full: full === undefined ? undefined : full + marker });
    }
    // 审批弹窗死锁根治①：WAITING 中用户再发消息时，这里不能乐观报 WORKING——CLI 仍
    // 阻塞在 canUseTool 上（新消息排队等权限放行），假报会把 status 翻成 WORKING 而
    // waiting_request 没人清，端上"卡片处理按钮在、审批弹窗永不出现"。状态保持 WAITING，
    // 等真实活动（stream/assistant）或权限决议再翻
    if (this.pending.size === 0) this.cb.onStatusChange("WORKING", this.lastSummary);
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

  // AskUserQuestion 作答：deny-message 机制回传答案（见 summarizer.buildAnswerMessage 注释）
  answer(requestId: string, answers: string[], by?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.resolve({ behavior: "deny", message: buildAnswerMessage(parseAskQuestions(p.input), answers), interrupt: false });
    this.cb.onWaitingResolved(requestId, "answer", by);
    return true;
  }

  private denyAllPending(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      p.resolve({ behavior: "deny", message: reason, interrupt: false });
      this.cb.onWaitingResolved(id, "deny");
    }
  }

  // 根治②清扫体：pending 里未被 allow/deny/answer 决议过的条目 = CLI 已越过的孤儿
  // （正常决议路径当场删条目，走到这里的只剩被 CLI 抛弃的）。补 resolve 落地无害
  //（CLI 侧早已不等待该控制请求），决策标 superseded 供端上显示"请求已失效"
  private sweepStalePending(): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.resolve({ behavior: "deny", message: "请求已失效（CLI 已继续）", interrupt: false });
      this.cb.onWaitingResolved(id, "superseded");
    }
  }

  // 会话状态机查询：是否仍有未决议的权限请求（session-manager 状态收口用）
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  private msgHasToolResult(msg: SDKMessage): boolean {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    return (
      Array.isArray(content) &&
      content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result")
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ended = true;
    this.denyAllPending("会话被停止");
    // deny 的 control 响应还没写完就立刻 interrupt，实测会把 CLI 的权限控制通道打坏
    // （resume 后所有门控工具 "AbortError: Stream closed" 六连挂）。留 250ms 让
    // deny 响应先落地再打断
    await new Promise((r) => setTimeout(r, 250));
    await this.q.interrupt();
    this.queue.end();
  }

  // 会话中途切换权限模式（SDK 控制通道，CLI 的 /permissions 同款能力）。
  // 四档全放开：bypassPermissions 此前被类型窄化挡掉——skip 会话被误切后就回不去了
  async setPermissionMode(mode: "default" | "acceptEdits" | "plan" | "bypassPermissions"): Promise<void> {
    await this.q.setPermissionMode(mode);
  }
}
