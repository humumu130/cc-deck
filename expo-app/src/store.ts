import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getRandomBytes } from "expo-crypto";
import type { CloudPairInfo, CommandAck, Envelope, LogEntry, SessionState } from "./protocol";
import { uuid } from "./fmt";
import { devId, generateKeyPair, seal, unseal, setRandomBytes, type BoxKeyPair, type SealedBox } from "./e2e";

export interface ConnConfig {
  wsUrl: string;
  token: string;
}

// 云桥配置（配对成功后落盘，LAN 不可达时走这条通道）
export interface CloudConfig {
  url: string;
  token: string;
  relayDev: string;
  relayPubkey: string;
}

export interface ServerEntry {
  id: string;
  name: string;
  wsUrl: string;
  token: string;
  cloud?: CloudConfig | null;
}

export interface Snapshot {
  version: number;
  connected: boolean;
  connText: string;
  channel: "lan" | "cloud" | null;
  sessions: SessionState[];
  lastErrorCmd: string | null;
  cloudBusy: boolean;
  cloudMsg: string | null;
  pairCode: { code: string; expiresAt: number } | null;
}

const emptySnapshot: Snapshot = {
  version: 0,
  connected: false,
  connText: "未配置",
  channel: null,
  sessions: [],
  lastErrorCmd: null,
  cloudBusy: false,
  cloudMsg: null,
  pairCode: null,
};

const LAN_PROBE_MS = 4000;

class RelayStore {
  private ws: WebSocket | null = null;
  private channel: "lan" | "cloud" | null = null;
  private lastSeq = 0;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastDownAt = 0;
  private listeners = new Set<() => void>();
  private snap: Snapshot = emptySnapshot;
  private sessions = new Map<string, SessionState>();
  private timelines = new Map<string, LogEntry[]>();
  private cfg: ConnConfig | null = null;
  private cloudCfg: CloudConfig | null = null;
  private servers: ServerEntry[] = [];
  private devKeys: BoxKeyPair | null = null;
  private epoch = 0;

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

  // ---------- 设备密钥（AsyncStorage 设备级，云通道 E2E 身份） ----------

  private async deviceKeys(): Promise<BoxKeyPair> {
    if (this.devKeys) return this.devKeys;
    setRandomBytes(getRandomBytes); // Hermes 无全局 crypto，注入 expo-crypto
    try {
      const raw = await AsyncStorage.getItem("ccr_device_keys");
      if (raw) {
        const kp = JSON.parse(raw) as BoxKeyPair;
        if (kp.publicKey && kp.secretKey) {
          this.devKeys = kp;
          return kp;
        }
      }
    } catch {}
    const kp = generateKeyPair();
    this.devKeys = kp;
    try {
      await AsyncStorage.setItem("ccr_device_keys", JSON.stringify(kp));
    } catch {}
    return kp;
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
    if (tk) this.applyConfig({ wsUrl: entry.wsUrl, token: tk }, entry.cloud);
  }

  async deleteServer(id: string): Promise<void> {
    const list = (await this.readServers()).filter((e) => e.id !== id);
    this.servers = list;
    await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
    if ((await AsyncStorage.getItem("ccr_active")) === id) {
      const next = list[0];
      await AsyncStorage.setItem("ccr_active", next ? next.id : "");
      if (next) this.applyConfig({ wsUrl: next.wsUrl, token: next.token }, next.cloud);
    }
  }

  // 编辑服务器条目（名称/地址/令牌/云桥）：不切活动指针；改的是当前活动服务器且连接相关字段变化时重连
  async updateServer(
    id: string,
    patch: { name?: string; wsUrl?: string; token?: string; cloud?: CloudConfig | null },
  ): Promise<void> {
    const list = await this.readServers();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return;
    const before = list[idx];
    list[idx] = { ...before, ...patch };
    this.servers = list;
    await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
    const changed =
      (patch.wsUrl !== undefined && patch.wsUrl !== before.wsUrl) ||
      (patch.token !== undefined && patch.token !== before.token) ||
      (patch.cloud !== undefined && JSON.stringify(patch.cloud ?? null) !== JSON.stringify(before.cloud ?? null));
    if (changed && (await AsyncStorage.getItem("ccr_active")) === id) {
      const tk = list[idx].token;
      if (tk) this.applyConfig({ wsUrl: list[idx].wsUrl, token: tk }, list[idx].cloud);
    }
  }

  async loadConfig(): Promise<ConnConfig | null> {
    const list = await this.readServers();
    this.servers = list;
    const activeId = await AsyncStorage.getItem("ccr_active");
    const active = list.find((e) => e.id === activeId) ?? list[0];
    // 活动服务器没记令牌（勾了不记住）：停在设置页，列表里点它补输令牌
    if (!active || !active.token) return null;
    this.cloudCfg = active.cloud ?? null;
    this.cfg = { wsUrl: active.wsUrl, token: active.token };
    return this.cfg;
  }

  private applyConfig(cfg: ConnConfig, cloud?: CloudConfig | null) {
    this.cfg = cfg;
    this.cloudCfg = cloud ?? null;
    this.lastSeq = 0;
    this.sessions.clear();
    this.timelines.clear();
    this.disconnect();
    this.connect();
  }

  disconnect() {
    this.epoch++;
    this.reconnectDelay = 1000;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.channel = null;
  }

  // 连接周期：先 LAN 直连（探测超时），失败且已配对云桥则本轮转云通道
  connect() {
    if (!this.cfg || !this.cfg.token) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ep = ++this.epoch;
    this.emit({ connText: "连接中" });
    if (this.cloudCfg && !this.devKeys) void this.deviceKeys();
    void this.connectCycle(ep);
  }

  private async connectCycle(ep: number) {
    const cfg = this.cfg!;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.channel = null;
    const lanWs = await this.probeLan(cfg);
    if (ep !== this.epoch) {
      try {
        lanWs?.close();
      } catch {}
      return;
    }
    if (lanWs) {
      this.adoptLan(lanWs);
      return;
    }
    if (this.cloudCfg && this.devKeys) {
      this.openCloud(this.cloudCfg, ep);
      return;
    }
    this.emit({ connected: false, connText: "已断开", channel: null });
    this.scheduleReconnect();
  }

  // LAN 探测：open 即成功（返回活连接，由调用方接管）；超时/出错返回 null
  private probeLan(cfg: ConnConfig): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      const url =
        cfg.wsUrl +
        "?token=" + encodeURIComponent(cfg.token) +
        (this.lastSeq > 0 ? "&last_seq=" + this.lastSeq : "");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => done(null), LAN_PROBE_MS);
      const done = (result: WebSocket | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result) {
          try {
            ws.onopen = ws.onerror = ws.onclose = null;
            ws.close();
          } catch {}
        }
        resolve(result);
      };
      ws.onopen = () => done(ws);
      ws.onerror = () => done(null);
      ws.onclose = () => done(null);
    });
  }

  private adoptLan(ws: WebSocket) {
    this.ws = ws;
    this.channel = "lan";
    this.reconnectDelay = 1000;
    this.emit({ connected: true, connText: "已连接", channel: "lan" });
    this.startHb(ws);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopHb();
      this.emit({ connected: false, connText: "已断开", channel: null });
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (this.ws !== ws) return;
      this.lastDownAt = Date.now();
      let msg: Envelope | CommandAck;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
  }

  private openCloud(cloud: CloudConfig, ep: number) {
    const keys = this.devKeys!;
    const dev = devId(keys.publicKey, "ph");
    const url =
      cloud.url +
      (cloud.url.includes("?") ? "&" : "?") +
      "token=" + encodeURIComponent(cloud.token) +
      "&dev=" + encodeURIComponent(dev);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.emit({ connected: false, connText: "已断开", channel: null });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.channel = "cloud";
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = 1000;
      this.emit({ connected: true, connText: "已连接 ☁", channel: "cloud" });
      this.startHb(ws, cloud, keys);
      ws.send(
        JSON.stringify({
          to: cloud.relayDev,
          data: seal({ t: "hello", last_seq: this.lastSeq }, cloud.relayPubkey, keys.secretKey),
        }),
      );
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopHb();
      this.emit({ connected: false, connText: "已断开", channel: null });
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (this.ws !== ws) return;
      this.lastDownAt = Date.now();
      let frame: { type?: string; data?: SealedBox };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === "ROUTE_MISS") {
        // relay 暂时掉线：断开走重连循环（每轮仍先试 LAN）
        try {
          ws.close();
        } catch {}
        return;
      }
      if (!frame.data) return;
      const inner = unseal<Envelope | CommandAck>(frame.data, cloud.relayPubkey, keys.secretKey);
      if (!inner) return;
      this.onMessage(inner);
    };
  }

  // 应用层心跳：15s 一拍保持链路流量（防公司网络 idle 掐 NAT），55s 无任何下行
  // 判半开强制断开重连（否则要等 TCP 重传超时，分钟级黑洞）
  private startHb(ws: WebSocket, cloud?: CloudConfig, keys?: BoxKeyPair) {
    this.stopHb();
    this.lastDownAt = Date.now();
    this.hbTimer = setInterval(() => {
      if (this.ws !== ws) {
        this.stopHb();
        return;
      }
      if (Date.now() - this.lastDownAt > 55_000) {
        try { ws.close(); } catch {}
        return;
      }
      try {
        ws.send(cloud && keys
          ? JSON.stringify({ to: cloud.relayDev, data: seal({ t: "ping", last_seq: this.lastSeq }, cloud.relayPubkey, keys.secretKey) })
          : JSON.stringify({ type: "PING" }));
      } catch {}
    }, 15_000);
  }

  private stopHb() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  private scheduleReconnect() {    if (!this.cfg) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    this.emit({ connText: `${Math.round(delay / 1000)}s后重连` });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // LAN 与云通道共用的下行处理（云侧已解密）
  private onMessage(msg: Envelope | CommandAck) {
    if ((msg as CommandAck).type === "COMMAND_ACK") {
      const ack = msg as CommandAck;
      if (ack.cloud) void this.saveCloudPairing(ack.cloud);
      if (ack.pair_code) {
        this.emit({ pairCode: { code: ack.pair_code.code, expiresAt: Date.now() + ack.pair_code.expires_in * 1000 } });
      }
      if (!ack.ok && ack.error && !ack.error.startsWith("duplicate")) {
        this.emit({ lastErrorCmd: ack.error });
      }
      return;
    }
    const env = msg as Envelope;
    if (env.seq !== undefined) this.lastSeq = Math.max(this.lastSeq, env.seq);
    this.onEvent(env);
    this.emit();
  }

  // 配对 ACK：relay 经可信 LAN 信道回传云桥参数，落盘到当前服务器条目
  private async saveCloudPairing(info: CloudPairInfo) {
    const cloud: CloudConfig = {
      url: info.url,
      token: info.token,
      relayDev: info.relay_dev,
      relayPubkey: info.relay_pubkey,
    };
    this.cloudCfg = cloud;
    try {
      const list = await this.readServers();
      const entry = list.find((e) => e.wsUrl === this.cfg?.wsUrl && e.token === this.cfg?.token);
      if (entry) {
        entry.cloud = cloud;
        this.servers = list;
        await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
      }
    } catch {}
    this.emit({ cloudBusy: false, cloudMsg: "云桥配对成功，外出时自动经云通道连接" });
  }

  // 在已连接的 LAN 信道上发起云桥配对（信任锚 = LAN token）
  async pairCloud(): Promise<void> {
    this.clearCloudMsg();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.channel !== "lan") {
      this.emit({ cloudMsg: "请先在同一局域网内连接" });
      return;
    }
    this.emit({ cloudBusy: true });
    let keys: BoxKeyPair;
    try {
      keys = await this.deviceKeys();
    } catch {
      this.emit({ cloudBusy: false, cloudMsg: "设备密钥生成失败" });
      return;
    }
    const sent = this.send("COMMAND_PAIR_START", { pubkey: keys.publicKey, name: "手机" });
    if (!sent) this.emit({ cloudBusy: false, cloudMsg: "配对命令发送失败" });
  }

  clearCloudMsg() {
    if (this.snap.cloudBusy || this.snap.cloudMsg) {
      this.emit({ cloudBusy: false, cloudMsg: null });
    }
  }

  // 为网页端等新设备签发一次性配对码（LAN/云任一已连接信道均可）
  async requestPairCode(): Promise<string | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return "请先连接服务器";
    if (this.send("COMMAND_PAIR_CODE", {})) return null;
    return "命令发送失败";
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
        // 状态离开 WAITING 却没等来 RESOLVED 事件（relay 重启重放等场景）：清掉残留的审批面板数据
        if (msg.payload.status !== "WAITING") s.waiting_request = null;
        if (msg.payload.stats) s.stats = msg.payload.stats;
        if (msg.payload.remote_mode !== undefined) s.remote_mode = msg.payload.remote_mode;
        if (msg.payload.title) s.title = msg.payload.title;
        if (msg.payload.title_locked !== undefined) s.title_locked = msg.payload.title_locked;
        if (msg.payload.turn_started_at) s.turn_started_at = msg.payload.turn_started_at;
        if (msg.payload.usage) s.usage = msg.payload.usage;
        if (msg.payload.context_usage !== undefined) s.context_usage = msg.payload.context_usage;
        if (msg.payload.context_limit !== undefined) s.context_limit = msg.payload.context_limit;
        if (msg.payload.model) s.model = msg.payload.model;
        if (msg.payload.todos) s.todos = msg.payload.todos;
        if (msg.payload.relay_session_id) s.relay_session_id = msg.payload.relay_session_id;
        if (msg.payload.permission_mode) s.permission_mode = msg.payload.permission_mode;
        if (msg.payload.pending_inputs) s.pending_inputs = msg.payload.pending_inputs.length ? msg.payload.pending_inputs : undefined;
        if (msg.payload.subagents) s.subagents = msg.payload.subagents;
        if (msg.payload.cron_tasks) s.cron_tasks = msg.payload.cron_tasks;
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
        const dText = d === "allow" ? "已允许" : d === "deny" ? "已拒绝" : d === "answer" ? "已作答" : d === "answered" ? "电脑端已作答" : "远程审批超时，回退本地";
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
        if (msg.payload.kind === "user_message") this.consumePendingByUserMsg(sid, msg.payload.text ?? "");
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

  // 兜底：user_message 晋升日志到达时本地移除被覆盖的排队条目
  // （正常路径靠 SESSION_UPDATED.pending_inputs 清空；该帧丢失/旧版 relay 不发时由此兜底，
  // 排队气泡才不会在消息已处理后一直闪烁）
  private consumePendingByUserMsg(sid: string, text: string) {
    const s = this.sessions.get(sid);
    if (!s?.external || !s.pending_inputs?.length) return;
    const key = text.trim().replace(/\s+/g, " ");
    if (!key) return;
    const kept = s.pending_inputs.filter((p) => {
      const pk = (p.text ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
      return !(pk && key.includes(pk));
    });
    if (kept.length !== s.pending_inputs.length) {
      s.pending_inputs = kept.length ? kept : undefined;
      this.emit();
    }
  }

  // 时间线不可变更新：数组引用一变，渲染层的 useMemo/依赖比较才能感知新条目
  private pushLog(sid: string, entry: LogEntry) {
    const list = this.timelines.get(sid) ?? [];
    const e: LogEntry = {
      ts: entry.ts || Date.now(),
      kind: entry.kind,
      text: entry.text,
      tool: entry.tool,
      full: entry.full,
      id: entry.id,
      streaming: entry.streaming,
      detail: entry.detail,
      diff: entry.diff,
    };
    if (e.id) {
      const i = list.findIndex((x) => x.id === e.id);
      if (i >= 0) {
        const next = [...list];
        next[i] = e;
        this.timelines.set(sid, next);
        return;
      }
    }
    const next = [...list, e];
    if (next.length > 500) next.splice(0, next.length - 500);
    this.timelines.set(sid, next);
  }

  // 当前连接参数（slash 联想 fetch /api/commands 等只读 HTTP 端点用）
  get connInfo(): { wsUrl: string; token: string } | null {
    return this.cfg ? { ...this.cfg } : null;
  }

  send(type: string, payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emit({ lastErrorCmd: "未连接，命令未发送" });
      return false;
    }
    const cmd = { command_id: uuid(), type, payload, ts: Date.now() };
    if (this.channel === "cloud" && this.cloudCfg && this.devKeys) {
      this.ws.send(
        JSON.stringify({
          to: this.cloudCfg.relayDev,
          data: seal(cmd, this.cloudCfg.relayPubkey, this.devKeys.secretKey),
        }),
      );
    } else {
      this.ws.send(JSON.stringify(cmd));
    }
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
