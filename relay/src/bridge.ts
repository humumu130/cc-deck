// hooks 桥接：用户自开 CLI 会话（外部会话）事件路由 + 远程审批挂起 + 终端按键注入
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { BridgeEvent, WaitingPayload } from "./types.js";
import { injectText, injectEsc } from "./injector.js";
import {
  detailToolResult,
  detailToolUse,
  diffLines,
  fullText,
  parseAskQuestions,
  summarizeToolResult,
  summarizeToolUse,
  TaskTracker,
  truncate,
} from "./summarizer.js";
import { deriveTitle } from "./history.js";

export interface BridgeOptions {
  gateTools: Set<string>;          // 远程审批门控的工具名
  hasClients: () => boolean;       // 当前是否有 WS 客户端在线（手机在线才拦截）
  holdMs?: number;                 // PreToolUse 最长挂起（默认 590s，须 < hook 脚本内部 600s < settings timeout 620s）
}

export interface BridgeDecision {
  decision: "allow" | "deny" | "pass";   // pass = 不干预，CLI 走正常权限流程
  reason?: string;
}

interface Pending {
  sessionId: string;
  requestId: string;
  resolve: (d: BridgeDecision) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_HOLD_MS = 590_000;

const CLI_PID_CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "cli-pids.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Bridge {
  private pending = new Map<string, Pending>();   // ext session_id -> 挂起中的一次审批（CLI 工具串行，一会话最多一个）
  private turnStart = new Map<string, number>();  // ext session_id -> 本回合开始时间
  private inputQueue = new Map<string, string[]>(); // ext session_id -> 排队中的输入（忙时攒，回合结束注入）
  private flushing = new Set<string>();           // 正在逐条注入的会话（防并发交错）
  private named = new Set<string>();              // 已取到 CC 会话名的外部会话
  private nameMisses = new Map<string, number>(); // 取名失败计数（超过 8 次放弃，避免每事件扫目录）

  constructor(
    private bus: EventBus,
    private mgr: SessionManager,
    private opts: BridgeOptions,
  ) {
    this.hydratePidsFromCache();
  }

  // Relay 重启后内存里的 cli_pid 丢了，而空闲终端不会有新 hook 事件来恢复；
  // 从 hook 侧缓存文件补回（key=CLI session_id，CLI 存活期不变）
  private hydratePidsFromCache(): void {
    try {
      const cache = JSON.parse(readFileSync(CLI_PID_CACHE, "utf-8")) as Record<string, number>;
      for (const s of this.mgr.snapshot()) {
        if (!s.external || s.cli_pid) continue;
        const pid = cache[s.relay_session_id || s.session_id.slice(4)];
        if (pid) this.mgr.setExternalCliPid(s.session_id, pid);
      }
    } catch {}
  }

  async handleEvent(ev: BridgeEvent): Promise<BridgeDecision> {
    const decision = await this.dispatch(ev);
    // 分发后捕获：新会话的首个事件（UserPromptSubmit/PreToolUse）在 handler 内才 ensureExternal
    if (ev.cli_pid && ev.cli_pid > 0) this.mgr.setExternalCliPid(this.extId(ev), ev.cli_pid);
    return decision;
  }

  private async dispatch(ev: BridgeEvent): Promise<BridgeDecision> {
    switch (ev.event) {
      case "UserPromptSubmit":
        return this.onPrompt(ev);
      case "PreToolUse":
        return this.onPreToolUse(ev);
      case "PostToolUse":
        return this.onPostToolUse(ev);
      case "Notification":
        return this.onNotification(ev);
      case "Stop":
        return this.onStop(ev);
      case "SessionEnd":
        return this.onSessionEnd(ev);
      default:
        return { decision: "pass" };
    }
  }

  // 远程命令决定挂起中的审批（COMMAND_CONTINUE / COMMAND_REJECT）
  resolvePending(sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string): boolean {
    const p = this.pending.get(sessionId);
    if (!p || p.requestId !== requestId) return false;
    clearTimeout(p.timer);
    this.pending.delete(sessionId);
    p.resolve({ decision, reason });
    return true;
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  // ---------- 输入注入（COMMAND_EXT_INPUT / COMMAND_EXT_STOP）----------

  // 空闲（DONE）/运行中（WORKING）立即注入——CLI 对工作中收到的输入会原生排队/steering，
  // 与 PC 终端手敲一致；WAITING（本地权限弹窗/远程审批挂起）注入 Enter 可能误触弹窗，排队等回合结束
  extInput(sessionId: string, text: string): { ok: boolean; error?: string } {
    const state = this.mgr.getExternal(sessionId);
    if (!state) return { ok: false, error: `会话不存在: ${sessionId}` };
    if (!text.trim()) return { ok: false, error: "空消息" };
    if (!state.cli_pid) return { ok: false, error: "尚未定位 CLI 进程，等该会话下次活动后重试" };
    if (state.status === "ERROR") return { ok: false, error: "会话处于错误状态" };

    const q = this.inputQueue.get(sessionId) ?? [];
    q.push(text);
    this.inputQueue.set(sessionId, q);
    if ((state.status === "DONE" || state.status === "WORKING") && !this.flushing.has(sessionId)) {
      if (state.status === "WORKING") {
        this.mgr.pushExternalLog(sessionId, "system", `已注入终端（CLI 运行中，自动排队跟随）：${truncate(text, 80)}`);
      }
      void this.flushQueue(sessionId);
    } else {
      this.mgr.pushExternalLog(sessionId, "system", `已排队（等待确认/回合结束后自动发送）：${truncate(text, 80)}`);
    }
    return { ok: true };
  }

  // 注入 Esc 打断当前回合
  extStop(sessionId: string): { ok: boolean; error?: string } {
    const state = this.mgr.getExternal(sessionId);
    if (!state) return { ok: false, error: `会话不存在: ${sessionId}` };
    if (state.status !== "WORKING") return { ok: false, error: "会话不在运行中" };
    if (!state.cli_pid) return { ok: false, error: "尚未定位 CLI 进程，等该会话下次活动后重试" };
    const pid = state.cli_pid;
    this.mgr.pushExternalLog(sessionId, "system", "发送打断（Esc）");
    void injectEsc(pid).then((r) => {
      if (!r.ok) this.onInjectFail(sessionId, r.error);
    });
    return { ok: true };
  }

  private async flushQueue(sessionId: string): Promise<void> {
    if (this.flushing.has(sessionId)) return;
    this.flushing.add(sessionId);
    try {
      while (true) {
        const state = this.mgr.getExternal(sessionId);
        const q = this.inputQueue.get(sessionId);
        if (!q || q.length === 0) break;
        // 注入的下一条已进 WAITING（权限弹窗/审批挂起）：剩余留给下一次 Stop 后 flush
        if (!state || (state.status !== "DONE" && state.status !== "WORKING")) break;
        if (!state.cli_pid) {
          this.inputQueue.delete(sessionId);
          this.mgr.pushExternalLog(sessionId, "system", "排队消息被弃（进程定位丢失）");
          break;
        }
        const text = q.shift()!;
        const r = await injectText(state.cli_pid, text);
        if (!r.ok) {
          this.onInjectFail(sessionId, r.error);
          return;
        }
        await sleep(400); // 等 UserPromptSubmit 翻状态/给连续注入留节奏
      }
    } finally {
      this.flushing.delete(sessionId);
      // flush 尾部新入队的消息兜底再触发一轮
      const q = this.inputQueue.get(sessionId);
      const state = this.mgr.getExternal(sessionId);
      if (q && q.length > 0 && state?.status === "DONE") void this.flushQueue(sessionId);
    }
  }

  // 注入失败：CLI 进程多半已死/换壳，清定位缓存与队列，等下次 hook 事件重新定位
  private onInjectFail(sessionId: string, error?: string): void {
    this.mgr.clearExternalCliPid(sessionId);
    const dropped = this.inputQueue.get(sessionId)?.length ?? 0;
    this.inputQueue.delete(sessionId);
    this.clearPidCache(sessionId);
    this.mgr.pushExternalLog(
      sessionId,
      "system",
      `注入失败（${error ?? "未知"}），已清除进程定位${dropped ? `并弃 ${dropped} 条排队消息` : ""}；该会话下次活动后可重试`,
    );
  }

  // hook 侧 pid 缓存（relay 会话 id = "ext-" + CLI session_id）
  private clearPidCache(sessionId: string): void {
    try {
      const raw = JSON.parse(readFileSync(CLI_PID_CACHE, "utf-8")) as Record<string, number>;
      delete raw[sessionId.slice(4)];
      writeFileSync(CLI_PID_CACHE, JSON.stringify(raw));
    } catch {}
  }

  // ---------- 事件处理 ----------

  private extId(ev: BridgeEvent): string {
    return "ext-" + ev.session_id;
  }

  private onPrompt(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const turnStartedAt = Date.now();
    this.turnStart.set(id, turnStartedAt);
    const state = this.mgr.ensureExternal(id, ev.cwd, ev.prompt ?? "", ev.session_id);
    // 会话由 PreToolUse 先创建（无 prompt）：首个 prompt 到达时把文件夹名标题升级为 prompt 摘要
    //（已取到 CC 会话名的保留会话名，只补记 initial_prompt）
    if (state.external && !state.initial_prompt && ev.prompt) {
      const title = this.named.has(id) ? state.title : deriveTitle(ev.prompt);
      this.mgr.setExternalTitle(id, title, ev.prompt);
    }
    this.refreshName(id, ev);
    if (!this.named.has(id) && ev.prompt) this.mgr.requestSmartTitle(id, ev.prompt);
    this.mgr.setExternalStatus(id, "WORKING", truncate(ev.prompt ?? "新回合", 60), turnStartedAt);
    this.mgr.pushExternalLog(id, "user_message", truncate(ev.prompt ?? "", 300));
    void state;
    return { decision: "pass" };
  }

  // CC 会话名：~/.claude/sessions/<pid>.json 的 name 字段（CLI 启动数秒后异步写入，非必出现）
  // 命中则升级为标题；未命中继续在后续 prompt/Stop 上重试（有次数上限）
  private refreshName(id: string, ev: BridgeEvent): void {
    if (this.named.has(id)) return;
    if ((this.nameMisses.get(id) ?? 0) >= 8) return;
    if (this.mgr.getExternal(id)?.title_locked) return;
    const name = this.readCcSessionName(ev.session_id);
    if (name) {
      this.named.add(id);
      const state = this.mgr.getExternal(id);
      if (state && state.title !== name) this.mgr.setExternalTitle(id, name);
    } else {
      this.nameMisses.set(id, (this.nameMisses.get(id) ?? 0) + 1);
    }
  }

  private readCcSessionName(cliSessionId: string): string | null {
    try {
      const dir = path.join(homedir(), ".claude", "sessions");
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as { sessionId?: string; name?: string };
          if (d.sessionId === cliSessionId) return d.name?.trim() || null;
        } catch {}
      }
    } catch {}
    return null;
  }

  // 外部会话的任务清单追踪（TodoWrite / TaskCreate / TaskUpdate 增量累积）
  private trackers = new Map<string, TaskTracker>();

  // transcript 已读字节偏移：PostToolUse/Stop 时增量读出助手文本推上时间线
  private transcriptOffsets = new Map<string, number>();

  // hooks 不携带助手输出——从 transcript JSONL 增量提取 assistant 文本块。
  // 首见（或文件变小=轮转）只取最后一条，避免把历史回复全量刷进时间线；
  // 只读到行尾完整处，半行留给下次读（转录文件是追加写）。
  private pushAssistantTexts(id: string, transcriptPath?: string): void {
    if (!transcriptPath) return;
    try {
      const size = statSync(transcriptPath).size;
      const prev = this.transcriptOffsets.get(id);
      let start: number;
      let firstRead = false;
      if (prev === undefined || prev > size) {
        start = Math.max(0, size - 512 * 1024);
        firstRead = true;
      } else if (prev === size) {
        return;
      } else {
        start = prev;
      }
      const fd = openSync(transcriptPath, "r");
      const len = size - start;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      closeSync(fd);
      const raw = buf.toString("utf-8");
      const end = raw.lastIndexOf("\n");
      if (end < 0) return;
      this.transcriptOffsets.set(id, start + Buffer.byteLength(raw.slice(0, end + 1), "utf-8"));
      const entries: { kind: "assistant_text" | "thinking"; text: string }[] = [];
      for (const line of raw.slice(0, end).split("\n")) {
        // 宽容匹配：标准 CLI 转录是紧凑 JSON，但手写/第三方工具可能带空格
        if (!/"type":\s*"assistant"/.test(line)) continue;
        try {
          const j = JSON.parse(line) as { message?: { content?: unknown[] } };
          const content = j.message?.content;
          if (!Array.isArray(content)) continue;
          const texts: string[] = [];
          const thinks: string[] = [];
          for (const b of content) {
            if (!b || typeof b !== "object") continue;
            const blk = b as { type?: string; text?: unknown; thinking?: unknown };
            if (blk.type === "text" && typeof blk.text === "string") texts.push(blk.text);
            else if (blk.type === "thinking" && typeof blk.thinking === "string") thinks.push(blk.thinking);
          }
          // content 顺序上 thinking 在正文之前；每行各合并为一条
          const th = thinks.join("\n").trim();
          if (th) entries.push({ kind: "thinking", text: th });
          const tx = texts.join("\n").trim();
          if (tx) entries.push({ kind: "assistant_text", text: tx });
        } catch {}
      }
      if (!entries.length) return;
      // 首读（relay 重启/新接入）只回放最后一条正文，thinking 不回放避免刷屏
      const emit = firstRead ? entries.filter((e) => e.kind === "assistant_text").slice(-1) : entries;
      for (const e of emit) {
        this.mgr.pushExternalLog(id, e.kind, truncate(e.text, 400), undefined, { full: fullText(e.text, 400) });
      }
    } catch {}
  }

  private feedTaskTracker(id: string, tool: string, input: unknown): void {
    if (tool !== "TodoWrite" && tool !== "TaskCreate" && tool !== "TaskUpdate") return;
    const tr = this.ensureTracker(id);
    const todos = tr.feed(tool, input);
    if (todos) this.mgr.setTodos(id, todos);
  }

  // TaskCreate 的 tool_result（{task:{id,subject}}）：回填真实任务号（CLI taskId 全局递增，
  // 不回填则 TaskUpdate 永远 miss）
  private feedTaskResult(id: string, result: unknown): void {
    const tr = this.trackers.get(id);
    if (!tr) return;
    const todos = tr.feedResult(result);
    if (todos) this.mgr.setTodos(id, todos);
  }

  private ensureTracker(id: string): TaskTracker {
    let tr = this.trackers.get(id);
    if (!tr) {
      if (this.trackers.size > 60) this.trackers.clear(); // 防泄漏兜底
      tr = new TaskTracker();
      // relay 重启后 tracker 丢了：用会话最后已知清单做种子（无任务号，仅保展示不丢）
      tr.seed(this.mgr.getExternal(id)?.todos ?? []);
      this.trackers.set(id, tr);
    }
    return tr;
  }

  private async onPreToolUse(ev: BridgeEvent): Promise<BridgeDecision> {
    const id = this.extId(ev);
    this.mgr.ensureExternal(id, ev.cwd, "", ev.session_id);
    const input = (ev.tool_input ?? {}) as Record<string, unknown>;
    // AskUserQuestion：解析结构化问题（门控时客户端渲染选项作答）
    const questions = ev.tool_name === "AskUserQuestion" ? parseAskQuestions(input) : [];
    const summary = questions.length
      ? `提问: ${questions.map((q) => q.header).join(" / ")}`
      : summarizeToolUse(ev.tool_name ?? "tool", input);

    const shouldGate =
      !!this.mgr.getExternal(id)?.remote_mode &&
      // AskUserQuestion 不是权限决策而是必需输入：bypass 模式也要远程下发（终端本地仍可答，超时回退）
      (questions.length > 0 ||
        (this.opts.gateTools.has(ev.tool_name ?? "") &&
          ev.permission_mode !== "bypassPermissions")) &&   // 权限类：终端切到 skip 模式 = 用户显式放弃门控
      this.opts.hasClients();                                // 手机在线才拦截

    if (!shouldGate) {
      this.mgr.setExternalStatus(id, "WORKING", summary);
      this.mgr.pushExternalLog(id, "tool_use", summary, ev.tool_name, {
        detail: detailToolUse(ev.tool_name ?? "tool", input),
      });
      this.feedTaskTracker(id, ev.tool_name ?? "", ev.tool_input);
      return { decision: "pass" };
    }

    // 挂起等远程决定
    const requestId = randomUUID();
    const payload: WaitingPayload = {
      request_id: requestId,
      tool_name: ev.tool_name ?? "tool",
      input_summary: summary,
      suggestions: [],
      decidable: true,
      ...(questions.length ? { questions } : {}),
    };
    this.mgr.setExternalWaiting(id, payload);
    this.mgr.pushExternalLog(id, "tool_use", summary, ev.tool_name, {
      detail: detailToolUse(ev.tool_name ?? "tool", input),
    });
    this.feedTaskTracker(id, ev.tool_name ?? "", ev.tool_input);

    const holdMs = this.opts.holdMs ?? DEFAULT_HOLD_MS;
    return new Promise<BridgeDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.mgr.setExternalStatus(id, "WORKING", summary);
        this.bus.emit(id, "SESSION_WAITING_RESOLVED", { request_id: requestId, decision: "timeout", by: "relay" });
        resolve({ decision: "pass" });   // 回退 CLI 正常权限流程（本地提示）
      }, holdMs);
      timer.unref();
      this.pending.set(id, { sessionId: id, requestId, resolve, timer });
    });
  }

  private onPostToolUse(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    this.mgr.pushExternalLog(id, "tool_result", summarizeToolResult(ev.tool_response), undefined, {
      detail: detailToolResult(ev.tool_response),
      diff: diffLines(ev.tool_response),
    });
    this.feedTaskResult(id, ev.tool_response);
    this.pushAssistantTexts(id, ev.transcript_path);
    // 清除 passive WAITING（CLI 本地已处理）
    if (state.status === "WAITING" && state.waiting_request?.decidable === false) {
      this.mgr.setExternalStatus(id, "WORKING", state.action_summary);
    }
    return { decision: "pass" };
  }

  private onNotification(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    const msg = ev.message ?? "";
    if (/permission/i.test(msg)) {
      // CLI 在本地等权限确认：通知手机，但远程无法决定（无挂起通道）
      this.mgr.setExternalWaiting(id, {
        request_id: randomUUID(),
        tool_name: "",
        input_summary: msg,
        suggestions: [],
        decidable: false,
      });
    } else if (/waiting for your input/i.test(msg) && state.status === "WORKING") {
      // Esc 打断的回合不触发 Stop hook，CLI 空闲 60s 通知是唯一回退信号：
      // 视作回合结束（状态回落 DONE + flush 排队输入），迟于真实打断 ≤60s
      const turn = this.turnStart.get(id) ?? state.started_at;
      this.turnStart.delete(id);
      this.mgr.finishExternal(id, "completed", Date.now() - turn);
      this.mgr.pushExternalLog(id, "system", "空闲回退：未收到 Stop（回合可能被打断），已标记结束");
      if ((this.inputQueue.get(id)?.length ?? 0) > 0) void this.flushQueue(id);
    } else {
      this.mgr.pushExternalLog(id, "system", truncate(msg, 120));
    }
    return { decision: "pass" };
  }

  private onStop(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    this.refreshName(id, ev);
    this.pushAssistantTexts(id, ev.transcript_path);
    const turn = this.turnStart.get(id) ?? state.started_at;
    this.turnStart.delete(id);
    this.mgr.finishExternal(id, "completed", Date.now() - turn);
    if ((this.inputQueue.get(id)?.length ?? 0) > 0) void this.flushQueue(id);
    return { decision: "pass" };
  }

  private onSessionEnd(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    this.mgr.pushExternalLog(id, "system", "会话结束" + (ev.reason ? ` (${ev.reason})` : ""));
    const dropped = this.inputQueue.get(id)?.length ?? 0;
    this.inputQueue.delete(id);
    if (dropped) this.mgr.pushExternalLog(id, "system", `会话结束，弃 ${dropped} 条排队消息`);
    const turn = this.turnStart.get(id) ?? state.started_at;
    this.turnStart.delete(id);
    this.mgr.finishExternal(id, ev.reason ?? "ended", Date.now() - turn);
    return { decision: "pass" };
  }
}

export function parseGateTools(raw: string | undefined): Set<string> {
  const def = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch";
  return new Set((raw ?? def).split(",").map((s) => s.trim()).filter(Boolean));
}
