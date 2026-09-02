// hooks 桥接：用户自开 CLI 会话（外部会话）事件路由 + 远程审批挂起 + 终端按键注入
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { BridgeEvent, PendingInput, WaitingPayload, TodoItem, SubagentInfo, AskQuestion } from "./types.js";
import { injectText, injectEsc, injectEnter, ensureInjector } from "./injector.js";
import {
  addHiddenTodoKey,
} from "./todo-hidden.js";
import {
  buildAnswerMessage,
  detailToolResult,
  detailToolUse,
  diffLines,
  fullText,
  normKey,
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
  questionHoldMs?: number;         // AskUserQuestion 挂起窗口（默认 90s；超时放行 CLI 本地选择器）
}

export interface BridgeDecision {
  decision: "allow" | "deny" | "pass";   // pass = 不干预，CLI 走正常权限流程
  reason?: string;
  updatedInput?: Record<string, unknown>; // allow 时改写工具入参（AskUserQuestion 答案注入）
}

interface Pending {
  sessionId: string;
  requestId: string;
  resolve: (d: BridgeDecision) => void;
  timer: NodeJS.Timeout;
  questions?: AskQuestion[];               // AskUserQuestion：原问题（作答时回显进 updatedInput）
  toolInput?: Record<string, unknown>;     // AskUserQuestion：原始 tool_input
}

// transcript 里一次任务工具操作（use 或已配对的 result）
type TaskOp = { tool?: string; input?: unknown; result?: { task: { id: number } } };

const DEFAULT_HOLD_MS = 590_000;
const QUESTION_HOLD_MS = 90_000;

const CLI_PID_CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "cli-pids.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Bridge {
  private pending = new Map<string, Pending>();   // ext session_id -> 挂起中的一次审批（CLI 工具串行，一会话最多一个）
  private turnStart = new Map<string, number>();  // ext session_id -> 本回合开始时间
  private inputQueue = new Map<string, string[]>(); // ext session_id -> 排队中的输入（忙时攒，回合结束注入）
  private flushing = new Set<string>();           // 正在逐条注入的会话（防并发交错）
  private named = new Set<string>();              // 已取到 CC 会话名的外部会话
  private nameMisses = new Map<string, number>(); // 取名失败计数（超过 8 次放弃，避免每事件扫目录）
  private transcriptPaths = new Map<string, string>();  // ext id -> transcript JSONL（排队消息轮询）
  private recentUserMsgs = new Map<string, Map<string, { ts: number; via: "promote" | "prompt" }>>(); // ext id -> 归一化文本 -> 最近记录（via：晋升回显 / PC 手敲 prompt）
  private escMarkedAt = new Map<string, number>(); // ext id -> 最近一次 Esc 注入成功时间（乐观置 DONE 的自我纠正窗口）
  private queuePollTimer: NodeJS.Timeout | null = null;
  private extFileStats = new Map<string, { files: Set<string>; added: number; deleted: number }>();
  private extUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; model: string }>();
  // 排队消息滞留看门狗：ext id -> { 最近补发时间, 连续补发次数, 是否已放弃 }
  private stuckWatch = new Map<string, { lastTry: number; tries: number; given_up: boolean }>();
  private subagentSeq = 0; // hook 未带 tool_use_id 时的合成 id 序号（ag-N）
  private askFallback = new Map<string, { requestId: string; questions: AskQuestion[] }>(); // 提问超时放行本地选择器后的兜底（手机晚答仍可送达）

  // 看门狗/子 Agent TTL 阈值（env 可调：测试用短值，生产默认 90s/60s/10min/30min）
  private readonly stuckAfterMs: number;
  private readonly stuckRetryMs: number;
  private readonly subagentEndTtlMs: number;
  private readonly subagentRunTtlMs: number;

  constructor(
    private bus: EventBus,
    private mgr: SessionManager,
    private opts: BridgeOptions,
  ) {
    this.stuckAfterMs = Number(process.env.CCR_STUCK_AFTER_MS) > 0 ? Number(process.env.CCR_STUCK_AFTER_MS) : 90_000;
    this.stuckRetryMs = Number(process.env.CCR_STUCK_RETRY_MS) > 0 ? Number(process.env.CCR_STUCK_RETRY_MS) : 60_000;
    this.subagentEndTtlMs = Number(process.env.CCR_SUBAGENT_END_TTL_MS) > 0 ? Number(process.env.CCR_SUBAGENT_END_TTL_MS) : 10 * 60_000;
    this.subagentRunTtlMs = Number(process.env.CCR_SUBAGENT_RUN_TTL_MS) > 0 ? Number(process.env.CCR_SUBAGENT_RUN_TTL_MS) : 30 * 60_000;
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
    if (ev.transcript_path) {
      this.transcriptPaths.set(this.extId(ev), ev.transcript_path);
      this.ensureQueuePoll();
    }
    this.correctEscMark(this.extId(ev), ev);
    return decision;
  }

  // Esc 乐观置 DONE 的自我纠正：Esc 打断不触发 Stop hook，置 DONE 后若仍有工具活动，
  // 说明打断没真生效 → 翻回 WORKING；回合自然翻篇（新 prompt/Stop/SessionEnd）则撤销标记
  private correctEscMark(id: string, ev: BridgeEvent): void {
    const marked = this.escMarkedAt.get(id);
    if (marked === undefined) return;
    if (!this.mgr.getExternal(id)) {
      this.escMarkedAt.delete(id);
      return;
    }
    if (ev.event === "PreToolUse") {
      // 新工具又开跑了：打断未生效（dispatch 已置 WORKING/WAITING，DONE 时补翻）
      if (this.mgr.getExternal(id)?.status === "DONE") {
        this.mgr.setExternalStatus(id, "WORKING", "打断未生效，恢复运行中");
      }
      this.mgr.pushExternalLog(id, "system", "打断未生效，恢复运行中");
      this.escMarkedAt.delete(id);
      return;
    }
    if (ev.event === "PostToolUse") {
      // ≤3s 的视为被打断回合的收尾事件：忽略且不删标记
      if (Date.now() - marked <= 3000) return;
      if (this.mgr.getExternal(id)?.status === "DONE") {
        this.mgr.setExternalStatus(id, "WORKING", "打断未生效，恢复运行中");
        this.mgr.pushExternalLog(id, "system", "打断未生效，恢复运行中");
      }
      this.escMarkedAt.delete(id);
      return;
    }
    if (ev.event === "UserPromptSubmit" || ev.event === "Stop" || ev.event === "SessionEnd") {
      this.escMarkedAt.delete(id); // 回合已自然翻篇
    }
  }

  // 5s 轮询 transcript：PC 端敲字排队（queue-operation enqueue）发生在任意时刻，
  // 只靠 hook 触发的增量读会有长工具调用期间的盲区；同一节拍顺带跑子 Agent TTL 清理
  // 与排队消息滞留看门狗
  private ensureQueuePoll(): void {
    if (this.queuePollTimer) return;
    this.queuePollTimer = setInterval(() => {
      if (this.transcriptPaths.size > 60) this.transcriptPaths.clear();
      for (const [id, p] of this.transcriptPaths) this.pushAssistantTexts(id, p);
      this.sweepSubagents();
      this.sweepStuckInputs();
    }, 5000);
    this.queuePollTimer.unref();
  }

  // 记账"该文本近期已记为正式消息"：transcript 里 enqueue 与晋升可能同批读到，
  // 不去重会把已处理的消息再塞回 pending（手机双气泡）
  private noteUserMsg(id: string, text: string, via: "promote" | "prompt"): void {
    let m = this.recentUserMsgs.get(id);
    if (!m) {
      m = new Map();
      this.recentUserMsgs.set(id, m);
    }
    m.set(normKey(text), { ts: Date.now(), via });
    if (m.size > 40) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, rec] of m) if (rec.ts < cutoff) m.delete(k);
    }
  }

  private recentlyLogged(id: string, text: string): boolean {
    const rec = this.recentUserMsgs.get(id)?.get(normKey(text));
    return rec !== undefined && Date.now() - rec.ts < 60_000;
  }

  // 该文本是否被近期"晋升"记录覆盖（双向包含）：CLI 用合并形态（"A\rB"）重发已按单条
  // 晋升过的消息（或反之）时，任一方向包含即视为同批已展示；只认 promote 来源，
  // PC 手敲 60s 内重发同一句（via=prompt）不吞
  private coveredByRecentPromote(id: string, text: string): boolean {
    const m = this.recentUserMsgs.get(id);
    if (!m) return false;
    const pk = normKey(text);
    const now = Date.now();
    for (const [k, rec] of m) {
      if (rec.via !== "promote" || now - rec.ts >= 60_000 || !k) continue;
      if (k === pk || k.includes(pk) || pk.includes(k)) return true;
    }
    return false;
  }

  // 从 pending 里出队所有被 text 覆盖的条目（单条精确 / 合并形态包含），返回被出队的原文
  private consumePendingTexts(id: string, text: string): string[] {
    const state = this.mgr.getExternal(id);
    const list = state?.pending_inputs ?? [];
    if (!list.length) return [];
    const key = normKey(text);
    const kept = list.filter((p) => !key.includes(normKey(p.text)));
    if (kept.length === list.length) return [];
    this.mgr.setExternalPending(id, kept);
    return list.filter((p) => key.includes(normKey(p.text))).map((p) => p.text);
  }

  // PC 端敲字排队：与手机注入同构地进 pending_inputs，手机立即显示"排队中"
  private onQueueEnqueue(id: string, content: string): void {
    const state = this.mgr.getExternal(id);
    if (!state) return;
    const text = truncate(content.trim(), 300);
    if (!text || this.recentlyLogged(id, text)) return;
    const key = normKey(content);
    const pending = state.pending_inputs ?? [];
    // CLI 会把多条排队消息合并成一条 enqueue（"A\rB"，内部换行折叠）：覆盖任一待发消息
    // 即为同一批的重复表示，不重复入队；手机注入回显（extInput）已进队同样跳过
    if (pending.some((p) => key.includes(normKey(p.text)))) return;
    this.mgr.setExternalPending(id, [...pending, { text, ts: Date.now() }]);
  }

  // steering 中途交付（attachment queued_command，不触发 UserPromptSubmit）：
  // 出 pending + 记正式消息；有钩子的路径仍由 promotePending 处理
  private onSteerDelivered(id: string, prompt: string): void {
    const state = this.mgr.getExternal(id);
    if (!state) return;
    const text = truncate(prompt.trim(), 300);
    if (!text || this.recentlyLogged(id, text) || this.coveredByRecentPromote(id, text)) return;
    // 合并形态（"A\rB"）交付：出队覆盖到的所有 pending，按各自原文各记一条（不记合并稿）
    const consumed = this.consumePendingTexts(id, text);
    if (consumed.length) {
      for (const t of consumed) {
        if (!this.recentlyLogged(id, t)) this.mgr.pushExternalLog(id, "user_message", truncate(t, 300));
        this.noteUserMsg(id, t, "promote");
      }
    } else {
      this.mgr.pushExternalLog(id, "user_message", text);
    }
    this.noteUserMsg(id, text, "promote");
  }

  // 手动撤回排队消息（remove 且无 attachment 配对）：FIFO 出队一条
  private onQueueDiscard(id: string, count: number): void {
    const state = this.mgr.getExternal(id);
    if (!state || count <= 0) return;
    const pending = [...(state.pending_inputs ?? [])];
    while (count-- > 0 && pending.length) pending.shift();
    this.mgr.setExternalPending(id, pending);
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

  // 手机作答 AskUserQuestion：窗口内 allow+updatedInput 把答案注入工具入参（CLI 不再弹本地选择器）；
  // 窗口外（本地选择器已弹出）Esc 关闭它再以消息注入答案——两端任一先答即生效
  answerPending(sessionId: string, requestId: string, answers: string[]): boolean {
    const p = this.pending.get(sessionId);
    if (p && p.requestId === requestId && p.questions?.length && p.toolInput) {
      clearTimeout(p.timer);
      this.pending.delete(sessionId);
      const answersMap: Record<string, string> = {};
      p.questions.forEach((q, i) => {
        if (answers[i]) answersMap[q.question] = answers[i];
      });
      p.resolve({
        decision: "allow",
        updatedInput: { ...p.toolInput, answers: answersMap },
      });
      return true;
    }
    // 超时兜底：CLI 本地选择器已弹出（hook 已放行），手机晚到的作答转为注入送达。
    // relay 重启会清内存兜底表，但 waiting 状态经 events.ndjson 重放仍在——按
    // request_id 从会话状态找回问题定义，晚答不因重启失效
    const fb = this.askFallback.get(sessionId);
    if (fb && fb.requestId !== requestId) return false;
    const st = this.mgr.getExternal(sessionId);
    const wq = st?.waiting_request;
    const questions = fb?.questions ?? (wq?.request_id === requestId ? wq?.questions : undefined);
    if (!questions?.length || !ensureInjector() || !st?.cli_pid) return false;
    if (fb) this.askFallback.delete(sessionId);
    const pid = st.cli_pid;
    const msg = buildAnswerMessage(questions, answers);
    this.mgr.setExternalStatus(sessionId, "WORKING", "手机作答");
    void injectEsc(pid).then(async (r) => {
      if (!r.ok) {
        this.onInjectFail(sessionId, r.error);
        return;
      }
      // 等本地选择器收起、焦点回到输入框
      await sleep(400);
      const pid2 = this.mgr.getExternal(sessionId)?.cli_pid;
      if (!pid2) return;
      const r2 = await injectText(pid2, msg);
      if (!r2.ok) this.onInjectFail(sessionId, r2.error);
    });
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
    // 发送方回显：进会话状态 pending_inputs（客户端显示在工作指示器下方，处理时上浮为正式消息）
    this.mgr.setExternalPending(sessionId, [...(state.pending_inputs ?? []), { text: text.trim(), ts: Date.now() }]);
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

  // UserPromptSubmit 到达：若与排队注入消息同文本 → 晋升该条（出 pending 区、入正式转录），
  // 返回 true 表示已由回显晋升、无需重复记 user_message 日志。
  // 匹配不做 recentlyLogged 门控：pending 条目按次生成，命中即代表这是一次新的注入回显
  // （手机快速重发同一句会各自命中、各记一条，不会被 60s 去重吞掉）
  private promotePending(sessionId: string, prompt: string): boolean {
    const state = this.mgr.getExternal(sessionId);
    const list = state?.pending_inputs ?? [];
    if (!list.length) return false;
    const key = normKey(prompt);
    const i = list.findIndex((p) => normKey(p.text) === key);
    if (i !== -1) {
      const promoted = list.splice(i, 1)[0];
      this.mgr.setExternalPending(sessionId, list);
      this.noteUserMsg(sessionId, promoted.text, "promote");
      this.mgr.pushExternalLog(sessionId, "user_message", truncate(promoted.text, 300));
      return true;
    }
    // CLI 回合结束会把整队排队消息合并成一条 "A\rB" prompt 提交：连续段拼接匹配则整批晋升
    for (let s = 0; s < list.length; s++) {
      const acc: string[] = [];
      for (let e = s; e < list.length; e++) {
        acc.push(normKey(list[e].text));
        const joined = acc.join(" ");
        if (joined.length > key.length) break;
        if (joined === key) {
          const hits = list.splice(s, e - s + 1);
          this.mgr.setExternalPending(sessionId, list);
          for (const h of hits) {
            this.noteUserMsg(sessionId, h.text, "promote");
            this.mgr.pushExternalLog(sessionId, "user_message", truncate(h.text, 300));
          }
          this.noteUserMsg(sessionId, prompt, "promote"); // 合并形态也记账：后续同形态到达直接跳过
          return true;
        }
      }
    }
    return false;
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
      if (!r.ok) {
        this.onInjectFail(sessionId, r.error);
        return;
      }
      // Esc 打断的回合不触发 Stop hook：乐观置 DONE（手机立即看到结束），
      // 若打断没真生效（后续仍有工具活动），correctEscMark 会翻回 WORKING
      const s = this.mgr.getExternal(sessionId);
      if (!s || s.status !== "WORKING") return; // 注入期间回合已自然结束/状态已翻篇
      if (this.escMarkedAt.size > 60) this.escMarkedAt.clear();
      this.escMarkedAt.set(sessionId, Date.now());
      const turn = this.turnStart.get(sessionId) ?? s.started_at;
      this.turnStart.delete(sessionId);
      this.mgr.finishExternal(sessionId, "interrupted", Date.now() - turn);
      this.mgr.pushExternalLog(sessionId, "system", "已打断");
      // 状态已是 DONE：排队的消息照常注入（flushQueue 认 DONE/WORKING）
      if ((this.inputQueue.get(sessionId)?.length ?? 0) > 0) void this.flushQueue(sessionId);
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
    if (this.mgr.getExternal(sessionId)?.pending_inputs?.length) this.mgr.setExternalPending(sessionId, []);
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
    if (!this.promotePending(id, ev.prompt ?? "")) {
      // 晋升未命中：可能是 CLI 回合结束对已晋升排队消息的重复 UserPromptSubmit（合并形态冲刷），
      // 60s 内已被晋升记录覆盖 → 跳过；PC 手敲重发（上一条也走 prompt 记录）不受影响
      if (!this.coveredByRecentPromote(id, ev.prompt ?? "")) {
        this.noteUserMsg(id, ev.prompt ?? "", "prompt");
        this.mgr.pushExternalLog(id, "user_message", truncate(ev.prompt ?? "", 300));
      }
    }
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
      const enqueues: string[] = [];
      const steers: string[] = [];
      const taskOps: TaskOp[] = [];
      const agentNotifs: string[] = []; // 后台子 Agent 完成通知里的 tool-use-id
      const agentUses: { id: string; input: unknown }[] = []; // Agent/Task tool_use 块（真实 call id）
      const creates = this.taskCreateSet(id);
      let removes = 0;
      // token 用量/模型：assistant 条目自带 usage（逐条 API 调用量，累加为会话总量）
      let usageIn = 0;
      let usageOut = 0;
      let usageCr = 0;
      let usageCw = 0;
      let usageSeen = false;
      let model = "";
      for (const line of raw.slice(0, end).split("\n")) {
        // 后台子 Agent 完成通知：作为 user 消息或 attachment 行出现，取 tool-use-id 配对收尾
        //（捕获到 "<" 为止：不受 JSON 对闭合标签斜杠的转义影响）
        if (line.includes("<task-notification>")) {
          const m = /<tool-use-id>([^<]+)/.exec(line);
          if (m && m[1].trim()) agentNotifs.push(m[1].trim());
          continue;
        }
        // 宽容匹配：标准 CLI 转录是紧凑 JSON，但手写/第三方工具可能带空格
        if (/"type":\s*"queue-operation"/.test(line)) {
          try {
            const j = JSON.parse(line) as { operation?: string; content?: string };
            if (j.operation === "enqueue" && typeof j.content === "string" && j.content.trim()) enqueues.push(j.content);
            else if (j.operation === "remove") removes++;
          } catch {}
          continue;
        }
        if (/"type":\s*"attachment"/.test(line)) {
          try {
            const j = JSON.parse(line) as { attachment?: { type?: string; prompt?: string } };
            if (j.attachment?.type === "queued_command" && typeof j.attachment.prompt === "string" && j.attachment.prompt.trim()) {
              steers.push(j.attachment.prompt);
            }
          } catch {}
          continue;
        }
        if (!/"type":\s*"assistant"/.test(line)) {
          // user 行的 tool_result：TaskCreate 的结果文本（"Task #N created successfully"）
          if (line.includes("created successfully")) {
            try {
              const j = JSON.parse(line) as { message?: { content?: unknown[] } };
              if (Array.isArray(j.message?.content)) Bridge.collectTaskOps(j.message.content, taskOps, creates);
            } catch {}
          }
          continue;
        }
        try {
          const j = JSON.parse(line) as { message?: { content?: unknown[]; usage?: Record<string, unknown>; model?: unknown } };
          const mu = j.message?.usage;
          if (mu && typeof mu === "object") {
            const inc = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
            usageIn += inc(mu.input_tokens);
            usageOut += inc(mu.output_tokens);
            usageCr += inc(mu.cache_read_input_tokens);
            usageCw += inc(mu.cache_creation_input_tokens);
            usageSeen = true;
          }
          if (typeof j.message?.model === "string" && j.message.model) model = j.message.model;
          const content = j.message?.content;
          if (!Array.isArray(content)) continue;
          Bridge.collectTaskOps(content, taskOps, creates);
          const texts: string[] = [];
          const thinks: string[] = [];
          for (const b of content) {
            if (!b || typeof b !== "object") continue;
            const blk = b as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown };
            if (blk.type === "text" && typeof blk.text === "string") texts.push(blk.text);
            else if (blk.type === "thinking" && typeof blk.thinking === "string") thinks.push(blk.thinking);
            else if (blk.type === "tool_use" && (blk.name === "Agent" || blk.name === "Task")) {
              agentUses.push({ id: typeof blk.id === "string" ? blk.id : "", input: (b as { input?: unknown }).input });
            }
          }
          // content 顺序上 thinking 在正文之前；每行各合并为一条
          const th = thinks.join("\n").trim();
          if (th) entries.push({ kind: "thinking", text: th });
          const tx = texts.join("\n").trim();
          if (tx) entries.push({ kind: "assistant_text", text: tx });
        } catch {}
      }
      // 首读（relay 重启/新接入）只回放最后一条正文，thinking 不回放避免刷屏；排队台账不回放（陈旧）
      const emit = firstRead ? entries.filter((e) => e.kind === "assistant_text").slice(-1) : entries;
      for (const e of emit) {
        this.mgr.pushExternalLog(id, e.kind, truncate(e.text, 400), undefined, { full: fullText(e.text, 400) });
      }
      if (!firstRead) {
        for (const t of enqueues) this.onQueueEnqueue(id, t);
        for (const t of steers) this.onSteerDelivered(id, t);
        if (removes > steers.length) this.onQueueDiscard(id, removes - steers.length);
      }
      // 子 Agent：先补/升级 tool_use 条目（同批快速完成时通知才有配对目标），再按通知收尾
      for (const u of agentUses) this.observeAgentUse(id, u);
      for (const n of agentNotifs) this.closeSubagentByNotification(id, n);
      // 任务清单：CLI 任务存储目录优先（权威、变更检测防重发），无目录再 transcript 回放/增量
      const storeTodos = this.readTaskStore(id);
      if (storeTodos) {
        const j = JSON.stringify(storeTodos);
        if (this.lastTodos.get(id) !== j) {
          if (this.lastTodos.size > 60) this.lastTodos.clear();
          this.lastTodos.set(id, j);
          this.mgr.setTodos(id, storeTodos);
        }
      } else if (firstRead) {
        this.replayTaskHistory(id, transcriptPath);
      } else if (taskOps.length) {
        const tr = this.ensureTracker(id);
        for (const op of taskOps) {
          const todos = op.result ? tr.feedResult(op.result) : tr.feed(op.tool as string, op.input);
          if (todos) this.mgr.setTodos(id, todos);
        }
      }
      if (usageSeen || model) {
        // 首读以窗口内条目做种子（relay 重启后的近似值）；此后增量累加
        let u = this.extUsage.get(id);
        if (!u || firstRead) {
          if (this.extUsage.size > 60) this.extUsage.clear();
          u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: "" };
          this.extUsage.set(id, u);
        }
        u.input += usageIn;
        u.output += usageOut;
        u.cacheRead += usageCr;
        u.cacheWrite += usageCw;
        if (model) u.model = model;
        this.mgr.setExternalUsage(
          id,
          { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
          u.model || undefined,
        );
      }
    } catch {}
  }

  // 文件改动统计：Edit/Write/MultiEdit/NotebookEdit 结果的 +/- 行累计（统计页数据源）
  private feedFileStats(id: string, ev: BridgeEvent): void {
    const tool = ev.tool_name ?? "";
    if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit" && tool !== "NotebookEdit") return;
    const r = ev.tool_response as
      | { structuredPatch?: unknown; content?: unknown; filePath?: unknown; file_path?: unknown }
      | null
      | undefined;
    if (!r || typeof r !== "object") return;
    let added = 0;
    let deleted = 0;
    if (Array.isArray(r.structuredPatch)) {
      for (const h of r.structuredPatch as { lines?: unknown }[]) {
        if (!h || !Array.isArray(h.lines)) continue;
        for (const l of h.lines as unknown[]) {
          if (typeof l !== "string" || !l) continue;
          if (l.startsWith("+")) added++;
          else if (l.startsWith("-")) deleted++;
        }
      }
    } else if (typeof r.content === "string" && r.content) {
      const lines = r.content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      added += lines.length;
    } else {
      return;
    }
    const input = (ev.tool_input ?? {}) as { file_path?: unknown };
    const file =
      typeof r.filePath === "string" ? r.filePath :
      typeof r.file_path === "string" ? r.file_path :
      typeof input.file_path === "string" ? input.file_path :
      "(未知文件)";
    let st = this.extFileStats.get(id);
    if (!st) {
      st = { files: new Set(), added: 0, deleted: 0 };
      if (this.extFileStats.size > 60) this.extFileStats.clear();
      this.extFileStats.set(id, st);
    }
    st.files.add(file);
    st.added += added;
    st.deleted += deleted;
    this.mgr.setExternalStats(id, { files_changed: st.files.size, lines_added: st.added, lines_deleted: st.deleted });
  }

  // 首见/轮转（firstRead）：全文件回放任务工具调用重建完整清单。
  // 旧方案靠 hook 事件增量累积，relay 每次重启都从零开始（手机端 7/18 ≠ 实际的根因）；
  // transcript 是唯一完整事实源。预过滤 + 分块读，108MB 转录一次性扫描 ~1s。
  // 工具串行执行，use/result 按文件顺序回放即可正确配对（callId 交集做结果匹配）。
  private replayTaskHistory(id: string, path: string): void {
    const ops: TaskOp[] = [];
    const creates = new Set<string>();
    try {
      const size = statSync(path).size;
      const fd = openSync(path, "r");
      const CHUNK = 8 * 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let carry = "";
      for (let pos = 0; pos < size; ) {
        const n = readSync(fd, buf, 0, CHUNK, pos);
        if (n <= 0) break;
        const text = carry + buf.toString("utf-8", 0, n);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.includes("TaskCreate") && !line.includes("TaskUpdate") && !line.includes("TodoWrite") && !line.includes("created successfully")) continue;
          try {
            const j = JSON.parse(line) as { message?: { content?: unknown[] } };
            if (Array.isArray(j.message?.content)) Bridge.collectTaskOps(j.message.content, ops, creates);
          } catch {}
        }
        pos += n;
      }
      closeSync(fd);
    } catch {
      return;
    }
    const tr = new TaskTracker();
    this.trackers.set(id, tr);
    for (const op of ops) {
      const todos = op.result ? tr.feedResult(op.result) : tr.feed(op.tool as string, op.input);
      if (todos) this.mgr.setTodos(id, todos);
    }
  }

  // transcript content 块 → 任务操作序列（tool_use 直接收；tool_result 仅认已见 TaskCreate 的
  // "Task #N created successfully" 文本，经 callId 配对回填真实任务号）
  private static collectTaskOps(content: unknown[], ops: TaskOp[], creates: Set<string>): void {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const blk = b as { type?: string; name?: unknown; input?: unknown; id?: unknown; tool_use_id?: unknown; content?: unknown };
      if (blk.type === "tool_use") {
        const name = typeof blk.name === "string" ? blk.name : "";
        if (name !== "TaskCreate" && name !== "TaskUpdate" && name !== "TodoWrite") continue;
        ops.push({ tool: name, input: blk.input });
        if (name === "TaskCreate" && typeof blk.id === "string") creates.add(blk.id);
      } else if (blk.type === "tool_result" && typeof blk.tool_use_id === "string" && creates.has(blk.tool_use_id)) {
        const c = blk.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? (c as { type?: string; text?: unknown }[]).map((x) => (x && typeof x === "object" && x.type === "text" && typeof x.text === "string" ? x.text : "")).join("")
          : "";
        const m = /Task #(\d+) created successfully/.exec(text);
        if (m) ops.push({ result: { task: { id: Number(m[1]) } } });
      }
    }
  }

  // 增量批次里见过的 TaskCreate callId（跨批次配对 result 用）
  private taskCalls = new Map<string, Set<string>>();

  private taskCreateSet(id: string): Set<string> {
    let set = this.taskCalls.get(id);
    if (!set) {
      if (this.taskCalls.size > 60) this.taskCalls.clear();
      set = new Set();
      this.taskCalls.set(id, set);
    }
    return set;
  }

  // CLI 任务存储目录（~/.claude/tasks/<cli_session>/*.json）：权威清单，与 /tasks 实时一致
  // （会话压缩/任务清理后也对）。目录不存在（旧版 CLI/其他会话形态）返回 null 走 transcript 兜底。
  private lastTodos = new Map<string, string>();

  private readTaskStore(id: string): TodoItem[] | null {
    const cli = id.startsWith("ext-") ? id.slice(4) : id;
    const dir = path.join(homedir(), ".claude", "tasks", cli);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return null;
    }
    if (!files.length) return null;
    const out: (TodoItem & { n: number })[] = [];
    for (const f of files) {
      try {
        const fp = path.join(dir, f);
        const t = JSON.parse(readFileSync(fp, "utf-8")) as { subject?: unknown; status?: unknown; activeForm?: unknown };
        const subject = typeof t.subject === "string" ? t.subject.trim() : "";
        if (!subject) continue;
        const status = t.status === "in_progress" || t.status === "completed" ? t.status : "pending";
        const activeForm = typeof t.activeForm === "string" && t.activeForm.trim() ? { active_form: t.activeForm.trim().slice(0, 120) } : {};
        out.push({ n: Number(f.replace(/[^0-9]/g, "")) || 0, content: subject.slice(0, 120), status, updated_at: statSync(fp).mtimeMs, ...activeForm });
      } catch {}
    }
    if (!out.length) return null;
    out.sort((a, b) => a.n - b.n);
    return out.map(({ n: _n, ...rest }) => rest);
  }

  // 手动刷新：清掉 JSON 变更检测的缓存，强制重读任务存储并重发（绕过"内容没变不推"）
  refreshTodos(sessionId: string): { ok: boolean; error?: string } {
    try {
      const t = this.readTaskStore(sessionId);
      this.lastTodos.delete(sessionId);
      if (t) this.mgr.setTodos(sessionId, t);
      else {
        const cur = this.mgr.getExternal(sessionId)?.todos;
        if (cur) this.mgr.setTodos(sessionId, cur.map((x) => ({ ...x })));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 隐藏任务清单条目：CLI 任务存储无法外部真删——记 normKey 进隐藏集（持久化），
  // 再把当前 todos 重过一遍 setTodos（过滤在 SessionManager.setTodos 咽喉点）触发 SESSION_UPDATED。
  // 重复隐藏幂等；找不到匹配条目也回 ok（手机端有本地乐观过滤）
  hideTodo(sessionId: string, content: string): { ok: boolean; error?: string } {
    try {
      const text = content.trim();
      if (!text) return { ok: false, error: "content 不能为空" };
      addHiddenTodoKey(sessionId, normKey(text));
      const cur = this.mgr.getExternal(sessionId)?.todos;
      if (cur?.length) this.mgr.setTodos(sessionId, cur.map((x) => ({ ...x })));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
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
    // 子 Agent 派生追踪（Agent/Task 双名防御别名）：Pre 到达即建 running 条目
    if (ev.tool_name === "Agent" || ev.tool_name === "Task") this.trackSubagentStart(id, ev);
    // AskUserQuestion：解析结构化问题（门控时客户端渲染选项作答）
    const questions = ev.tool_name === "AskUserQuestion" ? parseAskQuestions(input) : [];
    const summary = questions.length
      ? `提问: ${questions.map((q) => q.header).join(" / ")}`
      : summarizeToolUse(ev.tool_name ?? "tool", input);

    const remote = !!this.mgr.getExternal(id)?.remote_mode;
    const shouldGate =
      // AskUserQuestion 不是权限决策而是必需输入：不要求 remote_mode，手机在线就下发选项
      (questions.length > 0 ||
        (remote &&
          this.opts.gateTools.has(ev.tool_name ?? "") &&
          ev.permission_mode !== "bypassPermissions")) &&   // 权限类：终端切到 skip 模式 = 用户显式放弃门控
      this.opts.hasClients();                                // 手机在线才拦截

    if (!shouldGate) {
      // 提问遇手机离线：CLI 立即弹本地选择器，但仍登记提问横幅——手机稍后重连（SNAPSHOT）
      // 即见横幅可晚答（askFallback 注入送达）；PC 先答由 PostToolUse 收尾。权限类不登记。
      if (questions.length) {
        const requestId = randomUUID();
        this.mgr.setExternalWaiting(id, {
          request_id: requestId,
          tool_name: ev.tool_name ?? "tool",
          input_summary: summary,
          suggestions: [],
          decidable: true,
          questions,
        });
        this.askFallback.set(id, { requestId, questions });
      } else {
        this.mgr.setExternalStatus(id, "WORKING", summary);
      }
      this.mgr.pushExternalLog(id, "tool_use", summary, ev.tool_name, {
        detail: detailToolUse(ev.tool_name ?? "tool", input),
      });
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

    // 权限类长挂起（590s）；提问类 90s 窗口——手机先答则 updatedInput 注入答案（PC 不再弹）；
    // 超时放行 CLI 本地选择器但手机横幅保留（askFallback），晚答仍可送达，两端任一先答即生效
    const holdMs = questions.length
      ? this.opts.questionHoldMs ?? QUESTION_HOLD_MS
      : this.opts.holdMs ?? DEFAULT_HOLD_MS;
    return new Promise<BridgeDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (questions.length) {
          // 提问超时：CLI 弹本地选择器，手机横幅保留可继续作答；PC 先答由 PostToolUse 清横幅
          this.askFallback.set(id, { requestId, questions });
        } else {
          this.mgr.setExternalStatus(id, "WORKING", summary);
          this.bus.emit(id, "SESSION_WAITING_RESOLVED", { request_id: requestId, decision: "timeout", by: "relay" });
        }
        resolve({ decision: "pass" });   // 回退 CLI 正常权限流程（提问=本地选择器）
      }, holdMs);
      timer.unref();
      this.pending.set(id, {
        sessionId: id,
        requestId,
        resolve,
        timer,
        ...(questions.length ? { questions, toolInput: input } : {}),
      });
    });
  }

  private onPostToolUse(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    // 子 Agent 收尾：非后台条目按 tool_use id（或串行兜底）置 ended；后台条目忽略——
    // 后台 spawn 的 PostToolUse 在派生瞬间就返回，真实结束靠 transcript 的 <task-notification>
    if (ev.tool_name === "Agent" || ev.tool_name === "Task") this.trackSubagentEnd(id, ev);
    this.mgr.pushExternalLog(id, "tool_result", summarizeToolResult(ev.tool_response), undefined, {
      detail: detailToolResult(ev.tool_response),
      diff: diffLines(ev.tool_response),
    });
    this.feedFileStats(id, ev);
    this.pushAssistantTexts(id, ev.transcript_path);
    // 清除 passive WAITING（CLI 本地已处理）
    if (state.status === "WAITING" && state.waiting_request?.decidable === false) {
      this.mgr.setExternalStatus(id, "WORKING", state.action_summary);
    }
    // 提问兜底收尾：PC 端已在本地选择器作答/取消 → 手机横幅收起
    //（兜底表被重启清掉时也要收——waiting 状态还在，按状态里的 request_id 结）
    if (ev.tool_name === "AskUserQuestion" && state.status === "WAITING" && state.waiting_request?.decidable) {
      const fb = this.askFallback.get(id);
      this.askFallback.delete(id);
      this.mgr.emitWaitingResolved(id, fb?.requestId ?? state.waiting_request.request_id, "answered", "cli");
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
    // 回合结束：已在回合中消费的 steering 消息（不在注入队列里）晋升为正式消息；
    // 仍在队列里的即将注入，等 CLI 处理时的 UserPromptSubmit 晋升（避免双气泡）
    const avail = [...(this.inputQueue.get(id) ?? [])];
    const kept: PendingInput[] = [];
    for (const p of state.pending_inputs ?? []) {
      const qi = avail.findIndex((t) => normKey(t) === normKey(p.text));
      if (qi === -1) {
        this.noteUserMsg(id, p.text, "promote");
        this.mgr.pushExternalLog(id, "user_message", truncate(p.text, 300));
      } else {
        avail.splice(qi, 1); // 只做匹配记账，不动原队列（flushQueue 随后要注入）
        kept.push(p);
      }
    }
    if ((state.pending_inputs?.length ?? 0) !== kept.length) this.mgr.setExternalPending(id, kept);
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
    this.askFallback.delete(id);
    if (state.pending_inputs?.length) this.mgr.setExternalPending(id, []);
    if (dropped) this.mgr.pushExternalLog(id, "system", `会话结束，弃 ${dropped} 条排队消息`);
    const turn = this.turnStart.get(id) ?? state.started_at;
    this.turnStart.delete(id);
    this.mgr.finishExternal(id, ev.reason ?? "ended", Date.now() - turn);
    return { decision: "pass" };
  }

  // ---------- 子 Agent 工作状态（SessionState.subagents）----------

  private static subagentDesc(input: Record<string, unknown>): string {
    const d = typeof input.description === "string" ? input.description.trim() : "";
    if (d) return truncate(d, 80);
    return truncate(String(input.prompt ?? "").trim(), 80) || "(子代理)";
  }

  // PreToolUse(Agent/Task)：建 running 条目（幂等：同 tool_use id 不重建）
  private trackSubagentStart(id: string, ev: BridgeEvent): void {
    const input = (ev.tool_input ?? {}) as Record<string, unknown>;
    const tuId = typeof ev.tool_use_id === "string" && ev.tool_use_id ? ev.tool_use_id : `ag-${++this.subagentSeq}`;
    const list = [...(this.mgr.getExternal(id)?.subagents ?? [])];
    if (list.some((x) => x.id === tuId)) return;
    const entry: SubagentInfo = {
      id: tuId,
      desc: Bridge.subagentDesc(input),
      kind: typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general",
      bg: input.run_in_background === true,
      started_at: Date.now(),
    };
    list.push(entry);
    if (list.length > 30) list.splice(0, list.length - 30);
    this.mgr.setExternalSubagents(id, list);
  }

  // PostToolUse(Agent/Task)：id 命中或串行兜底（CLI 工具串行）收尾最近的 running 非后台条目；
  // bg 条目忽略（结束靠 task-notification）
  private trackSubagentEnd(id: string, ev: BridgeEvent): void {
    const list = this.mgr.getExternal(id)?.subagents;
    if (!list?.length) return;
    const tuId = typeof ev.tool_use_id === "string" ? ev.tool_use_id : "";
    let i = tuId ? list.findIndex((x) => x.id === tuId) : -1;
    if (i === -1) {
      for (let k = list.length - 1; k >= 0; k--) {
        if (!list[k].ended_at && !list[k].bg) {
          i = k;
          break;
        }
      }
    }
    if (i === -1 || list[i].bg || list[i].ended_at) return;
    // 不可原地改 list：它就是 state.subagents 的引用，先改会让 setExternalSubagents
    // 的 JSON 对比判定"无变化"而不下发（手机端永远收不到 ended）
    this.mgr.setExternalSubagents(id, list.map((x, k) => (k === i ? { ...x, ended_at: Date.now() } : { ...x })));
  }

  // transcript 里的 Agent tool_use 块（真实 call_xxx id）：
  //  - hook 未带 tool_use_id 时 Pre 建的是合成 id（ag-N）——升级为真实 id，后续 task-notification 才能配对
  //  - relay 重启等原因错过 Pre hook 的后台派生：补建条目（结束靠 task-notification）
  private observeAgentUse(id: string, use: { id: string; input: unknown }): void {
    if (!use.id) return;
    const list = this.mgr.getExternal(id)?.subagents;
    if (!list) return;
    if (list.some((x) => x.id === use.id)) return;
    const input = (use.input ?? {}) as Record<string, unknown>;
    const desc = Bridge.subagentDesc(input);
    for (let k = list.length - 1; k >= 0; k--) {
      const x = list[k];
      if (!x.ended_at && x.id.startsWith("ag-") && normKey(x.desc) === normKey(desc)) {
        const next = list.map((y, i2) => (i2 === k ? { ...y, id: use.id } : y));
        this.mgr.setExternalSubagents(id, next);
        return;
      }
    }
    if (input.run_in_background === true) {
      const next = [...list, {
        id: use.id,
        desc,
        kind: typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general",
        bg: true,
        started_at: Date.now(),
      }];
      if (next.length > 30) next.splice(0, next.length - 30);
      this.mgr.setExternalSubagents(id, next);
    }
  }

  // transcript 里 <task-notification> 的 tool-use-id：收尾后台子 Agent
  // （通知可能作为 user 消息或 attachment 行出现，识别在 pushAssistantTexts 的行扫描里做）
  private closeSubagentByNotification(id: string, toolUseId: string): void {
    const list = this.mgr.getExternal(id)?.subagents;
    if (!list?.length) return;
    let i = list.findIndex((x) => x.id === toolUseId);
    if (i === -1) {
      // hook 未带 id、合成条目未升级成功：退而收尾最老的 running 后台条目（合成 id）
      i = list.findIndex((x) => !x.ended_at && x.bg && x.id.startsWith("ag-"));
    }
    if (i === -1 || list[i].ended_at) return;
    // 同上：禁止原地改共享引用，否则变更检测吞掉 ended 下发
    this.mgr.setExternalSubagents(id, list.map((x, k) => (k === i ? { ...x, ended_at: Date.now() } : { ...x })));
  }

  // TTL 清理（每 5s 轮询节拍里跑）：已结束保留 10 分钟；running 30 分钟无事件视为僵尸清除
  private sweepSubagents(): void {
    const now = Date.now();
    for (const s of this.mgr.snapshot()) {
      if (!s.external || !s.subagents?.length) continue;
      const kept = s.subagents.filter((x) =>
        x.ended_at ? now - x.ended_at < this.subagentEndTtlMs : now - x.started_at < this.subagentRunTtlMs,
      );
      if (kept.length !== s.subagents.length) this.mgr.setExternalSubagents(s.session_id, kept);
    }
  }

  // ---------- 排队消息滞留输入框看门狗 ----------

  // 现象：注入的回车在回合切换瞬间被 CLI 界面层吞掉，文字滞留输入框未提交，
  // 直到下一条消息的回车才把两条一起冲出去。补发一个空回车（injectEnter）补救。
  // WAITING 严禁补发——回车会误触权限弹窗。
  private sweepStuckInputs(): void {
    const now = Date.now();
    for (const s of this.mgr.snapshot()) {
      if (!s.external) continue;
      const id = s.session_id;
      const stuck = (s.pending_inputs ?? []).some(
        (p) => now - p.ts > this.stuckAfterMs && !this.recentlyLogged(id, p.text),
      );
      if (
        !stuck ||
        !s.cli_pid ||
        (s.status !== "WORKING" && s.status !== "DONE") ||
        this.flushing.has(id) ||
        (this.inputQueue.get(id)?.length ?? 0) > 0
      ) {
        this.stuckWatch.delete(id); // 不满足条件（含已送达/状态变化）：重置看门狗
        continue;
      }
      const w = this.stuckWatch.get(id);
      if (w?.given_up) continue; // 连续 3 次仍滞留：放弃，防无限打转
      if (w && now - w.lastTry < this.stuckRetryMs) continue; // 每会话限速
      const tries = (w?.tries ?? 0) + 1;
      const pid = s.cli_pid;
      this.stuckWatch.set(id, { lastTry: now, tries, given_up: tries >= 3 });
      if (tries >= 3) {
        this.mgr.pushExternalLog(id, "system", "排队消息疑似滞留输入框，已补发 3 次回车仍滞留，暂停自动补发（下次发送消息时会一并提交）");
      } else {
        this.mgr.pushExternalLog(id, "system", "排队消息疑似滞留输入框，已补发回车");
      }
      void injectEnter(pid).then((r) => {
        if (!r.ok) this.onInjectFail(id, r.error);
      });
    }
  }
}

export function parseGateTools(raw: string | undefined): Set<string> {
  const def = "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch";
  return new Set((raw ?? def).split(",").map((s) => s.trim()).filter(Boolean));
}
