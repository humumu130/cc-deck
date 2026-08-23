// hooks 桥接：用户自开 CLI 会话（外部会话）事件路由 + 远程审批挂起
import { randomUUID } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { BridgeEvent, WaitingPayload } from "./types.js";
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

export class Bridge {
  private pending = new Map<string, Pending>();   // ext session_id -> 挂起中的一次审批（CLI 工具串行，一会话最多一个）
  private turnStart = new Map<string, number>();  // ext session_id -> 本回合开始时间

  constructor(
    private bus: EventBus,
    private mgr: SessionManager,
    private opts: BridgeOptions,
  ) {}

  async handleEvent(ev: BridgeEvent): Promise<BridgeDecision> {
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

  // ---------- 事件处理 ----------

  private extId(ev: BridgeEvent): string {
    return "ext-" + ev.session_id;
  }

  private onPrompt(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    this.turnStart.set(id, Date.now());
    const state = this.mgr.ensureExternal(id, ev.cwd, ev.prompt ?? "", ev.session_id);
    this.mgr.setExternalStatus(id, "WORKING", truncate(ev.prompt ?? "新回合", 60));
    this.mgr.pushExternalLog(id, "user_message", truncate(ev.prompt ?? "", 300));
    void state;
    return { decision: "pass" };
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
    const turn = this.turnStart.get(id) ?? state.started_at;
    this.turnStart.delete(id);
    this.mgr.finishExternal(id, "completed", Date.now() - turn);
    return { decision: "pass" };
  }

  private onSessionEnd(ev: BridgeEvent): BridgeDecision {
    const id = this.extId(ev);
    const state = this.mgr.getExternal(id);
    if (!state) return { decision: "pass" };
    this.mgr.pushExternalLog(id, "system", "会话结束" + (ev.reason ? ` (${ev.reason})` : ""));
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
