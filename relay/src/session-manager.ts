import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { EventBus } from "./event-bus.js";
import { AgentSession } from "./agent-adapter.js";
import type { RelayConfig } from "./config.js";
import type {
  Command,
  CommandAckPayload,
  SessionState,
} from "./types.js";

interface ManagedSession {
  agent: AgentSession;
  state: SessionState;
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
          const s = this.require(cmd.payload.session_id);
          if (s.state.status === "ERROR" || s.state.status === "DONE") {
            s.state.status = "WORKING";
          }
          s.agent.sendMessage(cmd.payload.text);
          this.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_STOP": {
          const s = this.require(cmd.payload.session_id);
          void s.agent.stop();
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_CONTINUE": {
          const s = this.require(cmd.payload.session_id);
          if (!s.agent.allow(cmd.payload.request_id, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_REJECT": {
          const s = this.require(cmd.payload.session_id);
          if (!s.agent.deny(cmd.payload.request_id, cmd.payload.reason, by)) {
            return { command_id: cmd.command_id, ok: false, error: "no such pending request" };
          }
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
      agent: null as never,
      state: {
        session_id: "",
        relay_session_id: "",
        cwd,
        initial_prompt: prompt,
        model: this.cfg.model,
        status: "WORKING",
        action_summary: "启动中",
        started_at: Date.now(),
        updated_at: Date.now(),
        stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      },
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
          this.bus.emit(managed.state.session_id, "SESSION_LOG", { kind, text, tool });
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
      model: this.cfg.model,
    });
    return agent.id;
  }

  private require(sessionId: string): ManagedSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在: ${sessionId}`);
    return s;
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
      void s.agent.stop(); // 回收 parked 的 CLI 子进程
      this.sessions.delete(s.state.session_id);
    }
  }

  private cloneState(s: ManagedSession): SessionState {
    return JSON.parse(JSON.stringify(s.state)) as SessionState;
  }
}
