import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { EventBus } from "./event-bus.js";
import { AgentSession } from "./agent-adapter.js";
import type { RelayConfig } from "./config.js";
import type { ReplayedSession } from "./history.js";
import { deriveTitle } from "./history.js";
import { truncate } from "./summarizer.js";
import type {
  Command,
  CommandAckPayload,
  LogEntry,
  SessionState,
  WaitingPayload,
} from "./types.js";

interface ManagedSession {
  agent: AgentSession | null;   // null = Relay 重启遗留的历史会话，不可操作
  state: SessionState;
  logs: LogEntry[];             // 供 SNAPSHOT 下发的时间线
  lastUpdateEmit: number;
}

const UPDATE_THROTTLE_MS = 2000;   // 同状态下的 SESSION_UPDATED 节流
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_SESSIONS = 20;

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private processedCommands = new Map<string, true>();

  constructor(
    private bus: EventBus,
    private cfg: RelayConfig,
  ) {
    const t = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    t.unref();
  }

  snapshot(): SessionState[] {
    return [...this.sessions.values()].map((s) => this.cloneState(s));
  }

  snapshotLogs(): Record<string, LogEntry[]> {
    const out: Record<string, LogEntry[]> = {};
    for (const [id, s] of this.sessions) out[id] = s.logs;
    return out;
  }

  // Relay 重启后收养历史会话（agent 为空，仅展示不可操作）
  adopt(replayed: Map<string, ReplayedSession>): number {
    // 新的在前：按 started_at 倒序插入，超出上限丢弃最旧的历史
    const entries = [...replayed.entries()].sort((a, b) => b[1].state.started_at - a[1].state.started_at);
    let adopted = 0;
    for (const [id, rs] of entries) {
      if (this.sessions.size >= MAX_SESSIONS) break;
      rs.state.historical = true;
      this.sessions.set(id, { agent: null, state: rs.state, logs: rs.logs, lastUpdateEmit: 0 });
      adopted++;
    }
    return adopted;
  }

  // ---------- 外部会话（hooks 桥接）----------

  private bridge: {
    resolvePending: (sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string) => boolean;
  } | null = null;

  setBridge(b: {
    resolvePending: (sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string) => boolean;
  }): void {
    this.bridge = b;
  }

  // 不存在则注册外部会话（bridge.ts 调用）；返回当前状态
  ensureExternal(id: string, cwd: string, prompt: string, cliSessionId = ""): SessionState {
    const existing = this.sessions.get(id);
    if (existing) return existing.state;
    const state: SessionState = {
      session_id: id,
      relay_session_id: cliSessionId,
      cwd: cwd || process.cwd(),
      initial_prompt: prompt,
      title: prompt ? deriveTitle(prompt) : (cwd.split(/[\\/]/).pop() ?? "未命名会话") || "未命名会话",
      model: "",
      status: "WORKING",
      action_summary: prompt ? truncate(prompt, 40) : "接入中",
      started_at: Date.now(),
      updated_at: Date.now(),
      stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      external: true,
      remote_mode: false,
    };
    this.sessions.set(id, { agent: null, state, logs: [], lastUpdateEmit: 0 });
    this.bus.emit(id, "SESSION_CREATED", {
      cwd: state.cwd,
      initial_prompt: prompt,
      title: state.title,
      model: "",
      external: true,
    });
    return state;
  }

  getExternal(id: string): SessionState | undefined {
    return this.sessions.get(id)?.state;
  }

  setExternalStatus(id: string, status: SessionState["status"], summary: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const changed = s.state.status !== status;
    s.state.status = status;
    s.state.action_summary = summary;
    s.state.updated_at = Date.now();
    if (changed || status === "WORKING") {
      this.bus.emit(id, "SESSION_UPDATED", {
        status,
        action_summary: summary,
        stats: { ...s.state.stats },
      });
    }
  }

  setExternalWaiting(id: string, payload: WaitingPayload): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.status = "WAITING";
    s.state.waiting_request = payload;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_WAITING", payload);
  }

  finishExternal(id: string, reason: string, durationMs: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.status = "DONE";
    s.state.done_reason = reason;
    s.state.duration_ms = durationMs;
    s.state.waiting_request = undefined;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_DONE", {
      terminal_reason: reason,
      duration_ms: durationMs,
      stats: { ...s.state.stats },
    });
  }

  pushExternalLog(id: string, kind: LogEntry["kind"], text: string, tool?: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const entry: LogEntry = { ts: Date.now(), kind, text, tool };
    s.logs.push(entry);
    if (s.logs.length > 300) s.logs.splice(0, s.logs.length - 300);
    this.bus.emit(id, "SESSION_LOG", entry);
  }

  setRemoteMode(id: string, enabled: boolean): void {
    const s = this.sessions.get(id);
    if (!s || !s.state.external) return;
    s.state.remote_mode = enabled;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      remote_mode: enabled,
    });
  }

  handleCommand(cmd: Command, by: string): CommandAckPayload {
    // 幂等去重：重复 command_id 直接返回已受理
    if (this.processedCommands.has(cmd.command_id)) {
      return { command_id: cmd.command_id, ok: true, error: "duplicate: already processed" };
    }
    this.processedCommands.set(cmd.command_id, true);
    if (this.processedCommands.size > 1000) {
      const first = this.processedCommands.keys().next().value;
      if (first !== undefined) this.processedCommands.delete(first);
    }

    try {
      switch (cmd.type) {
        case "COMMAND_CREATE": {
          const session_id = this.create(cmd.payload.cwd, cmd.payload.prompt);
          return { command_id: cmd.command_id, ok: true, session_id };
        }
        case "COMMAND_MESSAGE": {
          const s = this.requireLive(cmd.payload.session_id);
          if (s.state.status === "ERROR" || s.state.status === "DONE") {
            s.state.status = "WORKING";
          }
          s.agent.sendMessage(cmd.payload.text);
          this.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_STOP": {
          const s = this.requireLive(cmd.payload.session_id);
          void s.agent.stop();
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_CONTINUE": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            if (!this.bridge?.resolvePending(cmd.payload.session_id, cmd.payload.request_id, "allow")) {
              return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
            }
            this.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "allow", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = this.requireLive(cmd.payload.session_id);
          if (!live.agent.allow(cmd.payload.request_id, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_REJECT": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            if (!this.bridge?.resolvePending(cmd.payload.session_id, cmd.payload.request_id, "deny", cmd.payload.reason)) {
              return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
            }
            this.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "deny", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = this.requireLive(cmd.payload.session_id);
          if (!live.agent.deny(cmd.payload.request_id, cmd.payload.reason, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_EXT_MODE": {
          const s = this.require(cmd.payload.session_id);
          if (!s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "not an external session" };
          }
          this.setRemoteMode(cmd.payload.session_id, cmd.payload.enabled);
          return { command_id: cmd.command_id, ok: true };
        }
      }
    } catch (e) {
      return {
        command_id: cmd.command_id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private create(rawCwd: string, prompt: string): string {
    const cwd = resolve(rawCwd || this.cfg.defaultCwd);
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`cwd 不是有效目录: ${cwd}`);
    }
    this.evictOldSessions();

    const managed: ManagedSession = {
      agent: null,
      state: {
        session_id: "",
        relay_session_id: "",
        cwd,
        initial_prompt: prompt,
        title: deriveTitle(prompt),
        model: this.cfg.model,
        status: "WORKING",
        action_summary: "启动中",
        started_at: Date.now(),
        updated_at: Date.now(),
        stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      },
      logs: [],
      lastUpdateEmit: 0,
    };

    const agent = new AgentSession(
      cwd,
      this.cfg.model,
      {
        onInit: (sdkId, model) => {
          managed.state.relay_session_id = sdkId;
          managed.state.model = model;
          this.emitUpdated(managed, true);
        },
        onStatusChange: (status, summary) => {
          const changed = managed.state.status !== status;
          managed.state.status = status;
          managed.state.action_summary = summary;
          this.emitUpdated(managed, changed);
        },
        onWaiting: (p) => {
          managed.state.status = "WAITING";
          managed.state.waiting_request = p;
          managed.state.updated_at = Date.now();
          this.bus.emit(managed.state.session_id, "SESSION_WAITING", p);
        },
        onWaitingResolved: (requestId, decision, resolvedBy) => {
          managed.state.status = "WORKING";
          managed.state.waiting_request = undefined;
          managed.state.updated_at = Date.now();
          this.bus.emit(managed.state.session_id, "SESSION_WAITING_RESOLVED", {
            request_id: requestId,
            decision,
            by: resolvedBy ?? "relay",
          });
        },
        onStats: (stats) => {
          managed.state.stats = stats;
        },
        onLog: (kind, text, tool) => {
          const entry: LogEntry = { ts: Date.now(), kind, text, tool };
          managed.logs.push(entry);
          if (managed.logs.length > 300) managed.logs.splice(0, managed.logs.length - 300);
          this.bus.emit(managed.state.session_id, "SESSION_LOG", entry);
        },
        onTurnEnd: (ok, reason, durationMs) => {
          managed.state.updated_at = Date.now();
          managed.state.duration_ms = durationMs;
          if (ok) {
            managed.state.status = "DONE";
            managed.state.done_reason = reason;
            this.bus.emit(managed.state.session_id, "SESSION_DONE", {
              terminal_reason: reason,
              duration_ms: durationMs,
              stats: { ...managed.state.stats },
            });
          } else {
            managed.state.status = "ERROR";
            managed.state.last_error = reason;
            this.bus.emit(managed.state.session_id, "SESSION_ERROR", { message: reason });
          }
        },
        onSessionEnd: (reason) => {
          if (managed.state.status !== "DONE" && managed.state.status !== "ERROR") {
            managed.state.status = "DONE";
            managed.state.done_reason = reason;
            this.bus.emit(managed.state.session_id, "SESSION_DONE", {
              terminal_reason: reason,
              duration_ms: Date.now() - managed.state.started_at,
              stats: { ...managed.state.stats },
            });
          }
        },
      },
      prompt,
    );

    managed.agent = agent;
    managed.state.session_id = agent.id;
    this.sessions.set(agent.id, managed);
    this.bus.emit(managed.state.session_id, "SESSION_CREATED", {
      cwd,
      initial_prompt: prompt,
      title: managed.state.title,
      model: this.cfg.model,
    });
    return agent.id;
  }

  private require(sessionId: string): ManagedSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在: ${sessionId}`);
    return s;
  }

  private requireLive(sessionId: string): ManagedSession & { agent: AgentSession } {
    const s = this.require(sessionId);
    if (!s.agent) {
      throw new Error(
        s.state.external ? "外部会话不支持该命令（hooks 单向桥接）" : "历史会话不可操作（Relay 重启前遗留）",
      );
    }
    return s as ManagedSession & { agent: AgentSession };
  }

  // 外部会话远程决定后的收尾（清 WAITING、回 WORKING）
  private emitWaitingResolved(sessionId: string, requestId: string, decision: "allow" | "deny", by: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.state.status = "WORKING";
    s.state.waiting_request = undefined;
    s.state.updated_at = Date.now();
    this.bus.emit(sessionId, "SESSION_WAITING_RESOLVED", { request_id: requestId, decision, by });
  }

  private emitUpdated(s: ManagedSession, force: boolean): void {
    const now = Date.now();
    if (!force && now - s.lastUpdateEmit < UPDATE_THROTTLE_MS) return;
    s.lastUpdateEmit = now;
    s.state.updated_at = now;
    this.bus.emit(s.state.session_id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
    });
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.state.status === "WORKING" || s.state.status === "WAITING") {
        this.bus.emit(s.state.session_id, "SESSION_HEARTBEAT", {
          elapsed_ms: now - s.state.started_at,
          action_summary: s.state.action_summary,
        });
      }
    }
  }

  private evictOldSessions(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const finished = [...this.sessions.values()]
      .filter((s) => s.state.status === "DONE" || s.state.status === "ERROR")
      .sort((a, b) => a.state.started_at - b.state.started_at);
    for (const s of finished) {
      if (this.sessions.size < MAX_SESSIONS) break;
      void s.agent?.stop(); // 回收 parked 的 CLI 子进程（历史会话无 agent）
      this.sessions.delete(s.state.session_id);
    }
  }

  private cloneState(s: ManagedSession): SessionState {
    return JSON.parse(JSON.stringify(s.state)) as SessionState;
  }
}
