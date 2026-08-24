import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CommandAck, Envelope, LogEntry, SessionState } from "./protocol";
import { uuid } from "./fmt";

export interface ConnConfig {
  wsUrl: string;
  token: string;
}

export interface ServerEntry {
  id: string;
  name: string;
  wsUrl: string;
  token: string;
}

export interface Snapshot {
  version: number;
  connected: boolean;
  connText: string;
  sessions: SessionState[];
  lastErrorCmd: string | null;
}

const emptySnapshot: Snapshot = {
  version: 0,
  connected: false,
  connText: "未配置",
  sessions: [],
  lastErrorCmd: null,
};

class RelayStore {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snap: Snapshot = emptySnapshot;
  private sessions = new Map<string, SessionState>();
  private timelines = new Map<string, LogEntry[]>();
  private cfg: ConnConfig | null = null;
  private servers: ServerEntry[] = [];

  onWaiting: ((s: SessionState) => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  timelineOf(sid: string): LogEntry[] {
    return this.timelines.get(sid) ?? [];
  }

  private emit(patch: Partial<Snapshot> = {}) {
    this.snap = {
      ...this.snap,
      ...patch,
      version: this.snap.version + 1,
      sessions: [...this.sessions.values()],
    };
    for (const fn of this.listeners) fn();
  }

  // ---------- 多服务器配置（ccr_conns 列表 + ccr_active 指针；旧 ccr_conn 自动迁移） ----------

  private async readServers(): Promise<ServerEntry[]> {
    try {
      const raw = await AsyncStorage.getItem("ccr_conns");
      if (raw !== null) {
        const list = JSON.parse(raw) as ServerEntry[];
        if (Array.isArray(list)) return list.filter((e) => e && e.wsUrl);
      }
    } catch {}
    // 旧单条配置迁移
    try {
      const raw = await AsyncStorage.getItem("ccr_conn");
      if (raw) {
        const cfg = JSON.parse(raw) as ConnConfig;
        if (cfg.wsUrl && cfg.token) {
          const entry: ServerEntry = { id: uuid(), name: hostOf(cfg.wsUrl), wsUrl: cfg.wsUrl, token: cfg.token };
          await AsyncStorage.setItem("ccr_conns", JSON.stringify([entry]));
          await AsyncStorage.setItem("ccr_active", entry.id);
          await AsyncStorage.removeItem("ccr_conn");
          return [entry];
        }
      }
    } catch {}
    return [];
  }

  async loadServers(): Promise<ServerEntry[]> {
    this.servers = await this.readServers();
    return this.servers;
  }

  async activeServerId(): Promise<string | null> {
    return (await AsyncStorage.getItem("ccr_active")) ?? null;
  }

  // entry 持久化（token 可为空 = 不记住令牌）；connectToken = 本次实际连接用的令牌
  async connectServer(entry: ServerEntry, connectToken?: string): Promise<void> {
    const list = await this.readServers();
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.servers = list;
    await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
    await AsyncStorage.setItem("ccr_active", entry.id);
    const tk = connectToken ?? entry.token;
    if (tk) this.applyConfig({ wsUrl: entry.wsUrl, token: tk });
  }

  async deleteServer(id: string): Promise<void> {
    const list = (await this.readServers()).filter((e) => e.id !== id);
    this.servers = list;
    await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
    if ((await AsyncStorage.getItem("ccr_active")) === id) {
      const next = list[0];
      await AsyncStorage.setItem("ccr_active", next ? next.id : "");
      if (next) this.applyConfig({ wsUrl: next.wsUrl, token: next.token });
    }
  }

  async loadConfig(): Promise<ConnConfig | null> {
    const list = await this.readServers();
    this.servers = list;
    const activeId = await AsyncStorage.getItem("ccr_active");
    const active = list.find((e) => e.id === activeId) ?? list[0];
    // 活动服务器没记令牌（勾了不记住）：停在设置页，列表里点它补输令牌
    if (!active || !active.token) return null;
    this.cfg = { wsUrl: active.wsUrl, token: active.token };
    return this.cfg;
  }

  private applyConfig(cfg: ConnConfig) {
    this.cfg = cfg;
    this.lastSeq = 0;
    this.sessions.clear();
    this.timelines.clear();
    this.disconnect();
    this.connect();
  }

  disconnect() {
    this.reconnectDelay = 1000;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {}
  }

  connect() {
    if (!this.cfg || !this.cfg.token) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const url =
      this.cfg.wsUrl +
      "?token=" + encodeURIComponent(this.cfg.token) +
      (this.lastSeq > 0 ? "&last_seq=" + this.lastSeq : "");
    this.emit({ connText: "连接中" });
    try {
      this.ws?.close();
    } catch {}
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return; // 竞态：已是更新的连接
      this.reconnectDelay = 1000;
      this.emit({ connected: true, connText: "已连接" });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // 旧连接的关闭事件（切换服务器），忽略
      this.emit({ connected: false, connText: "已断开" });
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      let msg: Envelope | CommandAck;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if ((msg as CommandAck).type === "COMMAND_ACK") {
        const ack = msg as CommandAck;
        if (!ack.ok && ack.error && !ack.error.startsWith("duplicate")) {
          this.emit({ lastErrorCmd: ack.error });
        }
        return;
      }
      const env = msg as Envelope;
      if (env.seq !== undefined) this.lastSeq = Math.max(this.lastSeq, env.seq);
      this.onEvent(env);
      this.emit();
    };
  }

  private scheduleReconnect() {
    if (!this.cfg) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    this.emit({ connText: `${Math.round(delay / 1000)}s后重连` });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onEvent(msg: Envelope) {
    const sid = msg.session_id;
    switch (msg.type) {
      case "SNAPSHOT": {
        this.sessions.clear();
        this.timelines.clear();
        for (const s of msg.payload.sessions as SessionState[]) {
          this.sessions.set(s.session_id, s);
          this.timelines.set(s.session_id, msg.payload.logs[s.session_id] ?? []);
        }
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
        break;
      }
      case "SESSION_CREATED": {
        this.sessions.set(sid, {
          session_id: sid,
          relay_session_id: "",
          cwd: msg.payload.cwd,
          initial_prompt: msg.payload.initial_prompt,
          title: msg.payload.title || msg.payload.initial_prompt.slice(0, 24),
          model: msg.payload.model,
          status: "WORKING",
          action_summary: "启动中",
          external: msg.payload.external || false,
          remote_mode: false,
          started_at: msg.ts,
          updated_at: msg.ts,
          stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
        });
        this.timelines.set(sid, []);
        this.pushLog(sid, { ts: msg.ts, kind: "system", text: msg.payload.external ? "外部会话接入 (hooks)" : "会话创建" });
        break;
      }
      case "SESSION_UPDATED": {
        const s = this.sessions.get(sid);
        if (!s) break;
        s.status = msg.payload.status;
        s.action_summary = msg.payload.action_summary;
        if (msg.payload.stats) s.stats = msg.payload.stats;
        if (msg.payload.remote_mode !== undefined) s.remote_mode = msg.payload.remote_mode;
        if (msg.payload.title) s.title = msg.payload.title;
        if (msg.payload.turn_started_at) s.turn_started_at = msg.payload.turn_started_at;
        if (msg.payload.usage) s.usage = msg.payload.usage;
        s.updated_at = msg.ts;
        break;
      }
      case "SESSION_HEARTBEAT": {
        const s = this.sessions.get(sid);
        if (!s) break;
        s.elapsed_hint = msg.payload.elapsed_ms;
        break;
      }
      case "SESSION_WAITING": {
        const s = this.sessions.get(sid);
        if (!s) break;
        s.status = "WAITING";
        s.waiting_request = { ...msg.payload, received_at: msg.ts };
        if (msg.payload.decidable !== false && this.onWaiting) this.onWaiting(s);
        break;
      }
      case "SESSION_WAITING_RESOLVED": {
        const s = this.sessions.get(sid);
        if (!s) break;
        s.status = "WORKING";
        s.waiting_request = null;
        const d = msg.payload.decision;
        const dText = d === "allow" ? "已允许" : d === "deny" ? "已拒绝" : "远程审批超时，回退本地";
        this.pushLog(sid, { ts: msg.ts, kind: "system", text: dText + (d === "timeout" ? "" : ` (by ${msg.payload.by})`) });
        break;
      }
      case "SESSION_ERROR": {
        const s = this.sessions.get(sid);
        if (!s) break;
        s.status = "ERROR";
        s.last_error = msg.payload.message;
        this.pushLog(sid, { ts: msg.ts, kind: "system", text: "错误: " + msg.payload.message });
        break;
      }
      case "SESSION_DONE": {
        const s = this.sessions.get(sid);
        if (!s) break;
        s.status = "DONE";
        s.done_reason = msg.payload.terminal_reason;
        s.duration_ms = msg.payload.duration_ms;
        if (msg.payload.stats) s.stats = msg.payload.stats;
        this.pushLog(sid, { ts: msg.ts, kind: "system", text: `完成: ${msg.payload.terminal_reason} · ${(msg.payload.duration_ms / 1000).toFixed(1)}s` });
        break;
      }
      case "SESSION_LOG": {
        this.pushLog(sid, msg.payload);
        break;
      }
      case "SESSION_DELETED": {
        this.sessions.delete(sid);
        this.timelines.delete(sid);
        break;
      }
    }
  }

  private pushLog(sid: string, entry: LogEntry) {
    if (!this.timelines.has(sid)) this.timelines.set(sid, []);
    const list = this.timelines.get(sid)!;
    list.push({ ts: entry.ts || Date.now(), kind: entry.kind, text: entry.text, tool: entry.tool });
    if (list.length > 300) list.splice(0, list.length - 300);
  }

  send(type: string, payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ command_id: uuid(), type, payload, ts: Date.now() }));
    return true;
  }

  clearCmdError() {
    if (this.snap.lastErrorCmd) this.emit({ lastErrorCmd: null });
  }
}

export const store = new RelayStore();

// ws://192.168.0.105:8787/ws -> 192.168.0.105
function hostOf(wsUrl: string): string {
  try {
    return new URL(wsUrl).host;
  } catch {
    return wsUrl;
  }
}

export function useRelay(): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
