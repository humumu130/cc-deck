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
  // 连接阶段（供 UI 配色/文案判断，不靠 connText 字符串匹配）
  connState: "idle" | "connecting" | "online" | "reconnecting" | "offline";
  channel: "lan" | "cloud" | null;
  sessions: SessionState[];
  lastErrorCmd: string | null;
  cloudBusy: boolean;
  cloudMsg: string | null;
  pairCode: { code: string; expiresAt: number } | null;
  taskDoneQueue: TaskDoneReport[];
}

// 任务完成汇报（#204/#254）：relay TASK_DONE 事件驱动，悬浮框 + 系统通知共用。
// 队列化：未读报告累积（按钮计数=未点开的完成项总数），点开标 viewed、清除/查看才出队
export interface TaskDoneReport {
  id: number;        // 报告标识（新报告 id 变，驱动浮层动画）
  sid: string;
  title: string;
  done: string[];    // 本次完成的任务
  remaining: number; // 完成后剩余未完数
  ts: number;
  viewed?: boolean;  // false = 尚未点开（计入按钮计数）
}

const emptySnapshot: Snapshot = {
  version: 0,
  connected: false,
  connText: "未配置",
  connState: "idle",
  channel: null,
  sessions: [],
  lastErrorCmd: null,
  cloudBusy: false,
  cloudMsg: null,
  pairCode: null,
  taskDoneQueue: [],
};

const LAN_PROBE_MS = 4000;

// 命令 ACK 追踪：无回执超时（首等 4s）→ 重发同 id 一次（relay 按 command_id 幂等去重，
// 重复送达回 ok:true "duplicate"，不会双执行）→ 再等 6s 仍无回执才报失败。
// LAN 回执 <100ms、云链路 <1s，4s 已是宽裕值，避免把慢处理误判成丢包。
const ACK_TIMEOUT_MS = 4000;
const ACK_RETRY_TIMEOUT_MS = 6000;

const CMD_LABEL: Record<string, string> = {
  COMMAND_MESSAGE: "消息",
  COMMAND_EXT_INPUT: "注入消息",
  COMMAND_EXT_STOP: "打断",
  COMMAND_STOP: "停止",
  COMMAND_CONTINUE: "允许",
  COMMAND_REJECT: "拒绝",
  COMMAND_ANSWER: "作答",
  COMMAND_CREATE: "新建会话",
  COMMAND_RENAME: "重命名",
  COMMAND_DELETE: "删除",
  COMMAND_PERM: "权限切换",
  COMMAND_REFRESH_TODOS: "任务刷新",
  COMMAND_TODO_HIDE: "任务隐藏",
  COMMAND_PAIR_CODE: "配对码",
  COMMAND_PAIR_START: "云桥配对",
};

class RelayStore {
  private ws: WebSocket | null = null;
  private channel: "lan" | "cloud" | null = null;
  private lastSeq = 0;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
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
  private taskDoneSeq = 0;
  // 任务汇报去重/防复活（#254）：reported=已入队最新 ts（内存，挡 replay+SNAPSHOT 双投递）；
  // taskSeen=用户已清除的最新 ts（AsyncStorage 持久，挡进程重启后 SNAPSHOT 复活旧汇报）；
  // taskViewed=用户点开看过的最新 ts（持久，挡重启后已看过项重新计未读）
  private reportedTaskTs = new Map<string, number>();
  private taskSeen: Record<string, number> = {};
  private taskViewed: Record<string, number> = {};
  private taskDoneQueue: TaskDoneReport[] = [];
  // 已发出未回执的命令（ACK 追踪）：断开时静默清空，靠重连快照对账
  private pendingCmds = new Map<
    string,
    { type: string; tries: number; timer: ReturnType<typeof setTimeout>; wire: () => boolean }
  >();

  onWaiting: ((s: SessionState) => void) | null = null;
  onTaskDone: ((r: TaskDoneReport) => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  timelineOf(sid: string): LogEntry[] {
    return this.timelines.get(sid) ?? [];
  }

  private emit(patch: Partial<Snapshot> = {}) {
    // 直接 emit 意味着全部状态（含已写入 timelines 的流式块）对监听者可见：
    // 取消挂起的日志合帧补发，避免随后再多通知一次（后续流式块会按新窗口重排）
    if (this.logEmitTimer) {
      clearTimeout(this.logEmitTimer);
      this.logEmitTimer = null;
    }
    this.snap = {
      ...this.snap,
      ...patch,
      version: this.snap.version + 1,
      sessions: [...this.sessions.values()],
    };
    for (const fn of this.listeners) fn();
  }

  // 流式日志合帧（#282）：SESSION_LOG 流式块高频到达，逐块 emit 会让列表/详情整树
  // 重渲占满 JS 线程——bridgeless 下硬件 back 事件异步排队后无超时兜底，被持续挤压
  // 即表现为详情页连按返回无响应/积压齐发塌缩退出。数据仍同步写入 timelines
  // （不丢块、不乱序），仅通知按窗口合并：距上次通知 ≥LOG_FRAME_MS 的首块立即发
  // （保住首块跟手），窗口内的后续块合并为窗口末的一次补发（末帧 flush）
  private static readonly LOG_FRAME_MS = 200;
  private logEmitAt = 0;
  private logEmitTimer: ReturnType<typeof setTimeout> | null = null;

  private emitLogFrame() {
    const now = Date.now();
    const elapsed = now - this.logEmitAt;
    if (elapsed >= RelayStore.LOG_FRAME_MS) {
      this.logEmitAt = now;
      this.emit();
      return;
    }
    if (!this.logEmitTimer) {
      this.logEmitTimer = setTimeout(() => {
        this.logEmitTimer = null;
        this.logEmitAt = Date.now();
        this.emit();
      }, RelayStore.LOG_FRAME_MS - elapsed);
    }
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
      else {
        // 删光全部服务器：断开并清空状态，避免列表空了却仍显示"已连接"的幽灵连接
        this.cfg = null;
        this.cloudCfg = null;
        this.lastSeq = 0;
        this.sessions.clear();
        this.timelines.clear();
        this.taskDoneQueue = [];
        this.reportedTaskTs.clear();
        this.disconnect();
        this.emit({ connected: false, connText: "未配置", connState: "idle", channel: null, taskDoneQueue: [] });
      }
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
    // 启动时先读"已清除/已看过汇报"水位（#254）：SNAPSHOT 恢复要用它们挡复活与重复计数，
    // 须赶在首次快照前就绪
    try {
      const v = await AsyncStorage.getItem("ccr_task_seen");
      if (v) this.taskSeen = JSON.parse(v) as Record<string, number>;
      const v2 = await AsyncStorage.getItem("ccr_task_viewed");
      if (v2) this.taskViewed = JSON.parse(v2) as Record<string, number>;
    } catch {}
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
    // 幂等：目标与当前一致且正在建连/已在线 → 跳过，免一次拆了重连
    // （每次重建都要过 CONNECTING 窗口，正是旧连接泄漏的高危期）
    if (
      this.cfg &&
      this.cfg.wsUrl === cfg.wsUrl &&
      this.cfg.token === cfg.token &&
      sameCloud(this.cloudCfg, cloud ?? null) &&
      (this.snap.connState === "connecting" || this.snap.connState === "online")
    ) {
      return;
    }
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
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.logEmitTimer) {
      clearTimeout(this.logEmitTimer);
      this.logEmitTimer = null;
    }
    this.clearPendingCmds();
    killWs(this.ws);
    this.ws = null;
    this.channel = null;
  }

  // 断开即静默清空在途命令：结果靠重连快照对账，残留 timer 只会在
  // 离线窗口误报「未确认」、甚至把重发打到新连接上
  private clearPendingCmds() {
    for (const p of this.pendingCmds.values()) clearTimeout(p.timer);
    this.pendingCmds.clear();
  }

  // 连接周期：先 LAN 直连（探测超时），失败且已配对云桥则本轮转云通道
  connect() {
    if (!this.cfg || !this.cfg.token) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ep = ++this.epoch;
    this.emit({ connText: "连接中", connState: "connecting" });
    if (this.cloudCfg && !this.devKeys) void this.deviceKeys();
    void this.connectCycle(ep);
  }

  private async connectCycle(ep: number) {
    const cfg = this.cfg!;
    killWs(this.ws);
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
    this.emit({ connected: false, connText: "已断开", connState: "offline", channel: null });
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
        if (!result) killWs(ws);
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
    this.emit({ connected: true, connText: "已连接", connState: "online", channel: "lan" });
    this.startHb(ws);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopHb();
      this.clearPendingCmds();
      this.emit({ connected: false, connText: "已断开", connState: "offline", channel: null });
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
      this.emit({ connected: false, connText: "已断开", connState: "offline", channel: null });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.channel = "cloud";
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = 1000;
      this.emit({ connected: true, connText: "已连接 ☁", connState: "online", channel: "cloud" });
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
      this.clearPendingCmds();
      this.emit({ connected: false, connText: "已断开", connState: "offline", channel: null });
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

  // 回前台即时体检（#258）：后台冻结/断网期间 socket 可能已被系统杀死而
  // connected 仍真——AppState active 不能只信 connected 干等 15s 心跳拍。
  // 先按心跳同口径判死（>55s 无下行直接断开），否则补发一拍 PING 等 4s，
  // 仍无任何下行（PONG 也算）即判死。断开走既有 onClose→重连→replay/SNAPSHOT
  // 恢复链，错过的 TASK_DONE 由 last_task_done 状态兜回
  resumeProbe() {
    const ws = this.ws;
    // readyState 守卫：disconnect 后 hbTimer 残留 ≤15s（下一拍自清）+ 新 socket
    // 尚在 CONNECTING 的窗口内，hbTimer 判存活不可靠，只探已 OPEN 的连接
    if (!ws || !this.hbTimer || ws.readyState !== WebSocket.OPEN) return;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    const t0 = this.lastDownAt;
    if (Date.now() - t0 > 55_000) {
      try { ws.close(); } catch {}
      return;
    }
    const cloud = this.channel === "cloud" && this.cloudCfg ? this.cloudCfg : undefined;
    const keys = this.devKeys;
    try {
      ws.send(cloud && keys
        ? JSON.stringify({ to: cloud.relayDev, data: seal({ t: "ping", last_seq: this.lastSeq }, cloud.relayPubkey, keys.secretKey) })
        : JSON.stringify({ type: "PING" }));
    } catch {
      try { ws.close(); } catch {}
      return;
    }
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.ws === ws && this.lastDownAt === t0) {
        try { ws.close(); } catch {}
      }
    }, 4000);
  }

  private scheduleReconnect() {    if (!this.cfg) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    this.emit({ connText: `${Math.round(delay / 1000)}s后重连`, connState: "reconnecting" });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // LAN 与云通道共用的下行处理（云侧已解密）
  private onMessage(msg: Envelope | CommandAck) {
    if ((msg as CommandAck).type === "COMMAND_ACK") {
      const ack = msg as CommandAck;
      const p = this.pendingCmds.get(ack.command_id);
      if (p) {
        clearTimeout(p.timer);
        this.pendingCmds.delete(ack.command_id);
      }
      if (ack.cloud) void this.saveCloudPairing(ack.cloud);
      if (ack.pair_code) {
        this.emit({ pairCode: { code: ack.pair_code.code, expiresAt: Date.now() + ack.pair_code.expires_in * 1000 } });
      }
      if (!ack.ok && ack.error && ack.error.startsWith("duplicate")) {
        // 重发命中 relay 幂等去重：命令早已执行过，但结果数据（云桥参数）不随
        // duplicate 回传。云桥配对首条回执丢失时会永远转圈，这里解除并提示重试
        if (p && p.type === "COMMAND_PAIR_START") {
          this.emit({ cloudBusy: false, cloudMsg: "配对回执丢失，请重新配对" });
        }
        return;
      }
      if (!ack.ok && ack.error) {
        this.emit({ lastErrorCmd: ack.error });
      }
      return;
    }
    const env = msg as Envelope;
    if (env.seq !== undefined) this.lastSeq = Math.max(this.lastSeq, env.seq);
    this.onEvent(env);
    // 流式日志走合帧通知；其余事件（状态/快照/汇报等）照常即时通知——
    // 即时 emit 同时会把窗口内积着的流式块一并冲出（会话切换天然 flush）
    if (env.type === "SESSION_LOG") this.emitLogFrame();
    else this.emit();
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
        this.recoverTaskDone(msg.payload.sessions as SessionState[]);
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
      case "TASK_DONE": {
        const s = this.sessions.get(sid);
        if (!s) break;
        const tdTs = typeof msg.payload.ts === "number" ? msg.payload.ts : msg.ts;
        if (tdTs <= (this.reportedTaskTs.get(sid) ?? 0)) break; // 重连 replay 重复投递
        this.reportedTaskTs.set(sid, tdTs);
        if (tdTs <= (this.taskSeen[sid] ?? 0)) break; // 用户已清除过的汇报不再入队
        const r: TaskDoneReport = {
          id: ++this.taskDoneSeq,
          sid,
          title: s.title || s.action_summary || "会话",
          done: Array.isArray(msg.payload.done) ? msg.payload.done.slice(0, 10) : [],
          remaining: Array.isArray(msg.payload.remaining) ? msg.payload.remaining.length : 0,
          ts: tdTs,
          viewed: tdTs <= (this.taskViewed[sid] ?? 0),
        };
        this.taskDoneQueue = [...this.taskDoneQueue, r].slice(-8);
        this.emit({ taskDoneQueue: this.taskDoneQueue });
        if (this.onTaskDone) this.onTaskDone(r);
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
    const wire = (): boolean => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
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
    };
    const id = cmd.command_id;
    const entry: { type: string; tries: number; timer: ReturnType<typeof setTimeout>; wire: () => boolean } = {
      type,
      tries: 0,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      wire,
    };
    entry.timer = setTimeout(() => this.onCmdTimeout(id), ACK_TIMEOUT_MS);
    this.pendingCmds.set(id, entry);
    return true;
  }

  // 回执超时：先重发一次同 id（幂等）；再超时才报失败。连接中途断开由 disconnect 清场
  private onCmdTimeout(id: string) {
    const p = this.pendingCmds.get(id);
    if (!p) return;
    if (p.tries === 0 && p.wire()) {
      p.tries = 1;
      p.timer = setTimeout(() => this.onCmdTimeout(id), ACK_RETRY_TIMEOUT_MS);
      return;
    }
    this.pendingCmds.delete(id);
    this.emit({ lastErrorCmd: `${CMD_LABEL[p.type] ?? "命令"}重发后仍未确认，可能未送达` });
  }

  clearCmdError() {
    if (this.snap.lastErrorCmd) this.emit({ lastErrorCmd: null });
  }

  // 快照恢复未读汇报（#254）：瞬态 TASK_DONE 在断线/进程被杀期间丢失，relay 把最近
  // 汇报随会话状态下发；仅恢复 2h 内、未入过队、未被用户清除过的（防重启翻旧账）
  private recoverTaskDone(list: SessionState[]): void {
    const now = Date.now();
    let changed = false;
    for (const s of list) {
      const td = s.last_task_done;
      if (!td || !Array.isArray(td.done) || td.done.length === 0) continue;
      if (typeof td.ts !== "number" || now - td.ts > 2 * 3600_000) continue;
      if (td.ts <= (this.reportedTaskTs.get(s.session_id) ?? 0)) continue;
      if (td.ts <= (this.taskSeen[s.session_id] ?? 0)) continue;
      this.reportedTaskTs.set(s.session_id, td.ts);
      this.taskDoneQueue = [
        ...this.taskDoneQueue,
        {
          id: ++this.taskDoneSeq,
          sid: s.session_id,
          title: s.title || s.action_summary || "会话",
          done: td.done.slice(0, 10),
          remaining: typeof td.remaining_count === "number" ? td.remaining_count : 0,
          ts: td.ts,
          viewed: td.ts <= (this.taskViewed[s.session_id] ?? 0),
        },
      ].slice(-8);
      changed = true;
    }
    if (changed) this.emit({ taskDoneQueue: this.taskDoneQueue });
  }

  // 点开悬浮按钮 = 已读：计数清零，报告留在卡里直到清除/查看会话。
  // viewed 落水位持久化：进程重启后 SNAPSHOT 恢复不再把已看过的项重新计未读
  markTaskDoneViewed() {
    if (!this.taskDoneQueue.some((r) => !r.viewed)) return;
    this.taskDoneQueue = this.taskDoneQueue.map((r) => {
      if (!r.viewed && (this.taskViewed[r.sid] ?? 0) < r.ts) this.taskViewed[r.sid] = r.ts;
      return { ...r, viewed: true };
    });
    this.taskViewed = this.pruneWatermark(this.taskViewed);
    void AsyncStorage.setItem("ccr_task_viewed", JSON.stringify(this.taskViewed));
    this.emit({ taskDoneQueue: this.taskDoneQueue });
  }

  // 清除汇报并落"已清除"水位。带 sid 时只清该会话的报告（查看会话跳转用，
  // 其他会话的未读汇报保留），不带 sid 清全部（清除按钮）
  clearTaskDone(sid?: string) {
    const out = sid ? this.taskDoneQueue.filter((r) => r.sid === sid) : this.taskDoneQueue;
    if (!out.length) return;
    for (const r of out) {
      if ((this.taskSeen[r.sid] ?? 0) < r.ts) this.taskSeen[r.sid] = r.ts;
    }
    this.taskDoneQueue = sid ? this.taskDoneQueue.filter((r) => r.sid !== sid) : [];
    this.taskSeen = this.pruneWatermark(this.taskSeen);
    void AsyncStorage.setItem("ccr_task_seen", JSON.stringify(this.taskSeen));
    this.emit({ taskDoneQueue: this.taskDoneQueue });
  }

  // 水位表裁剪：按 ts 留最新 60 条防无限增长（被挤出的旧水位仅在 2h 恢复窗口内
  // 有理论复活风险，会话数超 60 且近期全有汇报时才可能触发）
  private pruneWatermark(m: Record<string, number>): Record<string, number> {
    const entries = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 60);
    return Object.fromEntries(entries);
  }
}

export const store = new RelayStore();

// 弃用旧 socket 统一走这里（#291 泄漏根因）：RN Android 原生侧只把已完成 onOpen 的
// socket 登记进连接表，CONNECTING 期调 close() 是静默 no-op——握手照样完成，旧连接
// 开门后无人再关，表现为切源后双连接并存、旧连接持续收事件。除立即 close 外，
// 摘掉全部 handler，并留一个「晚开门就补刀」的 onopen 哨兵（届时已在原生表内，close 生效）
function killWs(ws: WebSocket | null | undefined) {
  if (!ws) return;
  try {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
  } catch {}
  try {
    ws.close();
  } catch {}
  ws.onopen = () => {
    try {
      ws.close();
    } catch {}
  };
}

function sameCloud(a: CloudConfig | null, b: CloudConfig | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.url === b.url && a.token === b.token && a.relayDev === b.relayDev && a.relayPubkey === b.relayPubkey)
  );
}

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
