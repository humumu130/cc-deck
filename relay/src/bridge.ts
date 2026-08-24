// hooks 桥接：用户自开 CLI 会话（外部会话）事件路由 + 远程审批挂起 + 终端按键注入
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { BridgeEvent, WaitingPayload } from "./types.js";
import { injectText, injectEsc } from "./injector.js";
import { summarizeToolResult, summarizeToolUse, truncate } from "./summarizer.js";
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

  // 空闲（DONE）立即注入；WORKING/WAITING/注入中排队，Stop 后自动 flush
  extInput(sessionId: string, text: string): { ok: boolean; error?: string } {
    const state = this.mgr.getExternal(sessionId);
    if (!state) return { ok: false, error: `会话不存在: ${sessionId}` };
    if (!text.trim()) return { ok: false, error: "空消息" };
    if (!state.cli_pid) return { ok: false, error: "尚未定位 CLI 进程，等该会话下次活动后重试" };
    if (state.status === "ERROR") return { ok: false, error: "会话处于错误状态" };

    const q = this.inputQueue.get(sessionId) ?? [];
    q.push(text);
    this.inputQueue.set(sessionId, q);
    if (state.status === "DONE" && !this.flushing.has(sessionId)) {
      void this.flushQueue(sessionId);
    } else {
      this.mgr.pushExternalLog(sessionId, "system", `已排队（回合结束后自动发送）：${truncate(text, 80)}`);
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
        // 注入的下一条已开新回合（UserPromptSubmit 到达）：剩余留给下一次 Stop 后 flush
        if (!state || state.status !== "DONE") break;
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
        await sleep(400); // 等 UserPromptSubmit 把状态翻成 WORKING
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

  private async onPreToolUse(ev: BridgeEvent): Promise<BridgeDecision> {
    const id = this.extId(ev);
    this.mgr.ensureExternal(id, ev.cwd, "", ev.session_id);
    const input = (ev.tool_input ?? {}) as Record<string, unknown>;
    const summary = summarizeToolUse(ev.tool_name ?? "tool", input);

    const shouldGate =
      !!this.mgr.getExternal(id)?.remote_mode &&
      this.opts.gateTools.has(ev.tool_name ?? "") &&
      ev.permission_mode !== "bypassPermissions" &&   // 终端切到 skip 模式 = 用户显式放弃门控
      this.opts.hasClients();                          // 手机在线才拦截

    if (!shouldGate) {
      this.mgr.setExternalStatus(id, "WORKING", summary);
      this.mgr.pushExternalLog(id, "tool_use", summary, ev.tool_name);
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
    };
    this.mgr.setExternalWaiting(id, payload);
    this.mgr.pushExternalLog(id, "tool_use", summary, ev.tool_name);

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
    this.mgr.pushExternalLog(id, "tool_result", summarizeToolResult(ev.tool_response));
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
