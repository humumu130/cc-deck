import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import type { CloudPairInfo, CommandAck, Envelope, LogEntry, SessionState } from "./protocol";
import { uuid } from "./fmt";
import { currentVersion } from "./updates";
import { devId, generateKeyPair, seal, unseal, setRandomBytes, type BoxKeyPair, type SealedBox } from "./e2e";

// #42 设备实名上报（配对时）：expo-constants 的 deviceName（Android = Build.MODEL，
// 如 "Find X8"）优先，回落 RN Platform.constants.Model；都无 → "手机"。
// 旧版硬编码「手机」是设备列表无实名的根因
export function deviceDisplayName(): string {
  const dn = (Constants as { deviceName?: string | null }).deviceName;
  if (dn && dn.trim()) return dn.trim();
  const model = (Platform.constants as { Model?: string } | undefined)?.Model;
  return (model && model.trim()) || "手机";
}

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
  // 本机在桥上的设备 id（relay peers 里的键）。relay 对 pair_req 有防冒名校验
  //（from 必须 = devId(pubkey,"wb")），凭配对码远程配对的条目以 "wb-" 身份入列，
  // openCloud 必须用同一身份 hello 才会被认；LAN 配对（COMMAND_PAIR_START）落的是
  // "ph-" 身份，缺省回落之（旧条目无此字段 = "ph-"，行为不变）
  dev?: string;
}

export interface ServerEntry {
  id: string;
  name: string;
  wsUrl: string;
  token: string;
  cloud?: CloudConfig | null;
  // LAN 直连身份标记（#401 补强）：从 SNAPSHOT relay_dev 学到的 relay 设备 id（与
  // cloud.relayDev 同源同值）。纯 LAN 条目（从未配对云桥）也能凭它与云桥条目密码学
  // 对上同一台 relay。单源模式下闲置 LAN 条目永不建连、收不到快照，靠身份探测补盖
  relayDev?: string | null;
}

// 源运行态（#294 批1，对齐网页端 ensureCtx 的 ctx）：单连接状态机按源实例化。
// conn.cfg = 该源最后一次实际建连参数（幂等比较基准；区别于 entry 持久化字段——
// 勾了"不记住令牌"时 entry.token 为空而 cfg.token 是本次连接用的令牌）
export interface SourceConn {
  id: string;            // = ServerEntry.id
  name: string;
  entry: ServerEntry;    // 最新条目（saveCloudPairing 回写 / 建连参数来源）
  cfg: ConnConfig | null;
  cloudCfg: CloudConfig | null; // 取自 entry.cloud
  ws: WebSocket | null;
  channel: "lan" | "cloud" | null;
  state: Snapshot["connState"];
  stateText: string | null; // 单源模式下透出的动态文案（"重试中…下次 5s"），非 reconnecting 时为 null
  // 失败诊断备注（三态拆分 ④）：最近一轮失败的原因（桥不可达/电脑端 relay 离线/未配对
  // 原因等），连上即清。UI 据此给诊断文案，而非一律引导输码
  failNote: string | null;
  lastSeq: number;
  models: string[];    // #388 该源 SNAPSHOT.models 携带的可用模型清单
  sessions: Map<string, SessionState>;
  timelines: Map<string, LogEntry[]>;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  // 自动重试倒计时（③）：reconnecting 期间每秒刷新 stateText（"重试中…下次 Ns"）
  countdownTimer: ReturnType<typeof setInterval> | null;
  retryAt: number; // 下次自动重试时刻（倒计时基准）
  hbTimer: ReturnType<typeof setInterval> | null;
  probeTimer: ReturnType<typeof setTimeout> | null;
  lastDownAt: number;
  epoch: number;
  pendingCmds: Map<string, PendingCmd>;
  // #34 待唤醒（云通道专属）：桥通但 relay 离线（ROUTE_MISS）——不断桥 ws、停重连
  // 循环，等桥广播 relay-online（rd 匹配）再在同连接补发 hello 恢复；桥 ws 断开
  // （onclose）才回落旧重连。心跳照跑（ROUTE_MISS 回帧兼当桥活性探测，55s 无
  // 任何下行=桥死 → 自动断开走重连）。wakePings 为待唤醒期心跳计数（旧桥无广播
  // 的混跑兜底：40 拍无唤醒强制断开回落重连）
  awaitWake?: boolean;
  wakePings?: number;
  // F7（2026-09-09）手表 /wan 透传凭据 dev（wt-<hash>，随 SNAPSHOT wan_dev 下发）：
  // 手表网关拼手表连接配置用（旧 relay 无字段 = 回落 wt-app1，自建宽松桥不受影响）
  wanDev?: string | null;
}

// 已发出未回执的命令（ACK 追踪，按源隔离）：断开时静默清空，靠重连快照对账
interface PendingCmd {
  type: string;
  tries: number;
  timer: ReturnType<typeof setTimeout>;
  wire: () => boolean;
  // 0.4.4 跨网回传等需要结果语义的调用方注入（send 第 4 参）：ACK 到达/超时收摊时回调，
  // 断连清场不回调（调用方自带兜底超时）
  onAck?: (r: { ok: boolean; err: string | null }) => void;
}

// 按源连接状态（#294 批1：聚合视图数据源；单源模式仅活动源在连，UI 暂不消费）
export interface SourceStatus {
  id: string;
  name: string;
  state: Snapshot["connState"];
  channel: "lan" | "cloud" | null;
  // 跨端稳定配色键（#294 审查修复）：云源 = relay 设备 id（cloud.relayDev）、LAN 源
  // = wsUrl——同一台服务器在手机/网页两端取到同色（本地 uuid 两端各异不可用）
  colorKey: string;
}

export interface Snapshot {
  version: number;
  connected: boolean;
  connText: string;
  // 连接阶段（供 UI 配色/文案判断，不靠 connText 字符串匹配）。
  // 三态拆分（④）：connecting/reconnecting/offline 都是传输层问题（杀网/断桥/断电），
  // 自动重试自愈，绝不引导输码；unpaired = relay 明确回 pair_nack（未配对/被踢/
  // 身份失效），是唯一该进配对引导的态，且不再自动重试（重试只会反复吃 nack）
  connState: "idle" | "connecting" | "online" | "reconnecting" | "offline" | "unpaired";
  channel: "lan" | "cloud" | null;
  // 活动源失败诊断（④）：reconnecting/unpaired 时的原因备注（桥不可达/电脑端 relay
  // 离线/配对失效原因），online/idle 为 null——失败 UI 据此分流诊断文案 vs 配对引导
  failNote: string | null;
  sources: SourceStatus[];
  // 活动源 id（#294 批3）：单源 = 唯一在连源；聚合 = 当前"主"源（无 sid 命令的
  // 默认去向、配对/connInfo 口径）。NewSessionModal 选源默认值，批4 空态提示可复用
  activeSourceId: string | null;
  // 聚合模式开关透出（#294 批2）：UI 据此切换聚合口径（源角标/统计行/空态提示）；
  // 持久化键 cc.display.aggregate，抽屉开关（批4）经 display-settings 写入、
  // loadConfig 启动读取
  aggregate: boolean;
  // #388 可用模型清单（活动源 SNAPSHOT.models：厂商配置聚合，详情页下拉切换）
  models: string[];
  sessions: SessionState[];
  lastErrorCmd: string | null;
  cloudBusy: boolean;
  cloudMsg: string | null;
  pairCode: { code: string; expiresAt: number } | null;
  taskDoneQueue: TaskDoneReport[];
  // #300/#306 [待确认] 已读记忆（内存级）：已读条目指纹集合（U+0001 控制字符分隔）拼接存
  // 此字段（fp = sid + status + encodeURIComponent(content)）。条目内容一变
  // （新增/完成/去标记）指纹不匹配即自动重现。不落盘——进程重启后重新提醒，
  // 符合"常驻提醒直到确认"语义
  confirmDismissedKey: string | null;
  // #316 手表配对请求（LAN 源瞬态事件）：非空 = 全局弹窗显示名称+6 位比对码
  watchPair: { requestId: string; name: string; code: string; sourceId: string } | null;
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
  failNote: null,
  sources: [],
  activeSourceId: null,
  aggregate: false,
  models: [],
  sessions: [],
  lastErrorCmd: null,
  cloudBusy: false,
  cloudMsg: null,
  pairCode: null,
  taskDoneQueue: [],
  confirmDismissedKey: null,
  watchPair: null,
};

const LAN_PROBE_MS = 4000;

// 自动重试退避（连接状态机 ③）：失败后 3s 起步、指数 ×2、30s 封顶；连上即归零。
// 覆盖杀网/断桥/电脑端断电的长故障窗口，低频重试也避免与桥侧限流互相放大成风暴
const RECONNECT_BASE_MS = 3000;
// #33（2026-09-10 用户反馈重连太频）：上限 30s→300s——云通道断的是「桥 ws」，
// relay 长时间关机（下班/合盖）时 30s 一轮纯属空转；300s 对齐 relay 云客户端口径
const RECONNECT_MAX_MS = 300000;

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
  COMMAND_MODEL: "模型切换",
  COMMAND_REFRESH_TODOS: "任务刷新",
  COMMAND_TODO_HIDE: "任务隐藏",
  COMMAND_PAIR_CODE: "配对码",
  COMMAND_PAIR_START: "云桥配对",
  COMMAND_WATCH_GRANT: "手表配对",
  COMMAND_LOGIN_GRANT: "扫码授权",
  COMMAND_IMPORT_PUSH: "连接回传",
};

class RelayStore {
  // #294 批1：单连接状态机按源实例化（conns），activeId 单源模式下唯一在连源；
  // aggregate=false 时行为与旧单源逐字节等价。sidIndex 维护 sid→源路由（send/timelineOf）
  private conns = new Map<string, SourceConn>();
  private sidIndex = new Map<string, SourceConn>();
  private activeId: string | null = null;
  private aggregate = false;
  private listeners = new Set<() => void>();
  private snap: Snapshot = emptySnapshot;
  private servers: ServerEntry[] = [];
  private devKeys: BoxKeyPair | null = null; // 设备级共用（同网页端 ckp 跨源共用）
  private taskDoneSeq = 0;
  // 任务汇报去重/防复活（#254）：reported=已入队最新 ts（内存，挡 replay+SNAPSHOT 双投递）；
  // taskSeen=用户已清除的最新 ts（AsyncStorage 持久，挡进程重启后 SNAPSHOT 复活旧汇报）；
  // taskViewed=用户点开看过的最新 ts（持久，挡重启后已看过项重新计未读）。
  // 均按 sid 键，sid 为 uuid 全局唯一，跨源无碰撞
  private reportedTaskTs = new Map<string, number>();
  // 已被 user_message 回显消费的排队消息指纹（sid → keys）：拦截 SESSION_UPDATED 状态帧灌回（#323）
  private consumedPending = new Map<string, Set<string>>();
  private taskSeen: Record<string, number> = {};
  private taskViewed: Record<string, number> = {};
  private taskDoneQueue: TaskDoneReport[] = [];

  onWaiting: ((s: SessionState) => void) | null = null;
  onTaskDone: ((r: TaskDoneReport) => void) | null = null;
  // 议题①/④补偿告警（2026-09-09）：relay 侧新设备配对成功（输码/扫码/手机授权）时
  // 经 PAIRED_DEVICE 瞬态帧广播，App 弹本地通知——公共桥广播定位的 race 攻击即便
  // 得手，攻击设备立刻出现在持有者手机上。kick 动作不回调（无需打扰）
  onPairedDevice: ((p: { dev: string; name: string }) => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  timelineOf(sid: string): LogEntry[] {
    const conn = this.sidIndex.get(sid) ?? this.activeConn();
    return conn?.timelines.get(sid) ?? [];
  }

  private emit(patch: Partial<Snapshot> = {}) {
    // 直接 emit 意味着全部状态（含已写入 timelines 的流式块）对监听者可见：
    // 取消挂起的日志合帧补发，避免随后再多通知一次（后续流式块会按新窗口重排）
    if (this.logEmitTimer) {
      clearTimeout(this.logEmitTimer);
      this.logEmitTimer = null;
    }
    const active = this.activeConn();
    this.snap = {
      ...this.snap,
      ...patch,
      version: this.snap.version + 1,
      // #294 批2：聚合时平铺全部源会话并写 src（源 id，角标/详情页标注/批3 路由用）；
      // 单源仍只装活动源且不写 src（watch 网关直发 sessions，保持快照字节不变）
      sessions: this.snapshotSessions(active),
      ...this.connStatusPatch(),
    };
    for (const fn of this.listeners) fn();
  }

  // 快照会话装配（#294 批2）：聚合 = 全源平铺（源内/源间排序由 ListScreen 同一比较器
  // 完成——活跃置顶 + updated_at 倒序作用于合并列表即全局混排）；单源 = 活动源直出。
  // src 懒盖章：仅缺失/不符时就地写入，对象引用跨 emit 稳定——SessionCard memo 的
  // 行级重渲（#282）依赖"未变会话引用不变"，逐对象展开会让每次 emit 全列表重渲
  private snapshotSessions(active: SourceConn | null): SessionState[] {
    if (!this.aggregate) return active ? [...active.sessions.values()] : [];
    const out: SessionState[] = [];
    for (const conn of this.conns.values()) {
      for (const s of conn.sessions.values()) {
        if (s.src !== conn.id) s.src = conn.id;
        out.push(s);
      }
    }
    return out;
  }

  // 连接状态聚合（#294 批1）：单源 = 活动源直出（既有文案/字段逐字不变）；
  // 聚合 = any-online 派生，connText `${online}/${total} 在线`（connected/connState 供
  // App.tsx 通知权限/前台服务/回前台重连取此口径，调用方零改动）
  private connStatusPatch(): Pick<Snapshot, "connected" | "connText" | "connState" | "channel" | "failNote" | "sources" | "activeSourceId" | "aggregate" | "models"> {
    const sources: SourceStatus[] = [...this.conns.values()].map((c) => ({
      id: c.id,
      name: c.name,
      state: c.state,
      channel: c.channel,
      colorKey: c.entry.cloud?.relayDev || c.entry.wsUrl,
    }));
    // #388 模型清单取活动源口径（模型切换命令无 sid 路由也走活动源）
    const activeModels = this.activeConn()?.models ?? [];
    const inPlay: SourceConn[] = this.aggregate
      ? [...this.conns.values()]
      : this.activeId
        ? [this.conns.get(this.activeId)].filter((c): c is SourceConn => !!c)
        : [];
    if (!inPlay.length) return { connected: false, connText: "未配置", connState: "idle", channel: null, failNote: null, sources, activeSourceId: this.activeId, aggregate: this.aggregate, models: [] };
    if (this.aggregate) {
      const online = inPlay.filter((c) => c.state === "online");
      const connState = online.length
        ? "online"
        : inPlay.some((c) => c.state === "connecting")
          ? "connecting"
          : inPlay.some((c) => c.state === "reconnecting")
            ? "reconnecting"
            : inPlay.some((c) => c.state === "unpaired")
              ? "unpaired"
              : "offline";
      const ref = online.find((c) => c.id === this.activeId) ?? online[0] ?? null;
      return {
        connected: online.length > 0,
        connText: `${online.length}/${inPlay.length} 在线`,
        connState,
        channel: ref ? ref.channel : null,
        failNote: (inPlay.find((c) => c.state !== "online") ?? null)?.failNote ?? null,
        sources,
        activeSourceId: this.activeId,
        aggregate: this.aggregate,
        models: activeModels,
      };
    }
    const c = inPlay[0];
    return {
      connected: c.state === "online",
      connText: c.stateText ?? singleConnText(c),
      connState: c.state,
      channel: c.state === "online" ? c.channel : null,
      failNote: c.failNote,
      sources,
      activeSourceId: this.activeId,
      aggregate: this.aggregate,
      models: c.models,
    };
  }

  // 流式日志合帧（#282）：SESSION_LOG 流式块高频到达，逐块 emit 会让列表/详情整树
  // 重渲占满 JS 线程——bridgeless 下硬件 back 事件异步排队后无超时兜底，被持续挤压
  // 即表现为详情页连按返回无响应/积压齐发塌缩退出。数据仍同步写入 timelines
  // （不丢块、不乱序），仅通知按窗口合并：距上次通知 ≥LOG_FRAME_MS 的首块立即发
  // （保住首块跟手），窗口内的后续块合并为窗口末的一次补发（末帧 flush）。
  // 多源共用全局一个合帧窗口，通知频率反而更低
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

  // ---------- 设备密钥（AsyncStorage 设备级，云通道 E2E 身份，跨源共用） ----------

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

  // entry 持久化（token 可为空 = 不记住令牌）；connectToken = 本次实际连接用的令牌。
  // #398 同目标归并（addCloudByInvite 落盘也经此入口）：id 命中照旧整条替换；
  // id 未命中但目标等价（127.0.0.1/localhost/内网 IP 写法差异、同机重复添加/重复
  // 扫码）时复用既有条目——刷新名称/token/cloud 并沿用旧 id，不再 push 新条目，
  // 连接缓存与活动指针因 id 不变天然连续
  async connectServer(entry: ServerEntry, connectToken?: string): Promise<void> {
    const list = await this.readServers();
    let target = entry;
    const idx = list.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      list[idx] = entry;
    } else {
      const dup = list.findIndex((e) => sameTargetEntry(e, entry));
      if (dup >= 0) {
        const old = list[dup];
        // 身份等价但地址形态不同（桥地址 ↔ 内网直连）：wsUrl/token 是配套对（内网地址
        // 配 LAN 令牌、桥地址配桥令牌），保留既有地址对、只吸收名称与云桥配置，防
        // 「LAN 地址挂桥令牌」的错配；同地址（写法差异/重复添加）则照旧 token 互补
        const la = lanTargetOf(entry.wsUrl);
        const lb = lanTargetOf(old.wsUrl);
        const crossKind = !(la && lb && la.host === lb.host && la.port === lb.port);
        target = {
          ...old,
          name: entry.name || old.name,
          ...(crossKind ? {} : { token: entry.token || old.token }),
          cloud: entry.cloud ?? old.cloud ?? null,
        };
        list[dup] = target;
      } else {
        list.push(entry);
      }
    }
    this.servers = list;
    await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
    await AsyncStorage.setItem("ccr_active", target.id);
    this.activeId = target.id;
    const tk = connectToken ?? target.token;
    const conn = this.ensureConn(target);
    if (tk || target.cloud) {
      // 纯云桥条目（公共桥 token 留空）也在此建连：tk 为空串但 target.cloud 存在，
      // applyConfig→connConnect 按 cloudCfg 走云通道（connConnect 门控同步放行）。
      // 聚合时只建/换该源不拆其他源并设 active（applyConfig 天然满足）；活动源
      // 目标一致且在连则被幂等跳过，不拆重建
      this.applyConfig(conn, target, tk);
      // #27（2026-09-10 用户定则）：单源模式切源不再拆旧源连接——「单源」是视图
      // 过滤（列表只显示选中源），不是连接独占。旧实现（#291/#294 防僵尸）拆掉
      // 其他源致用户切源后家里失连；僵尸风险由 deleteServer/换绑地址的显式
      // connDisconnect 兜底，普通切源留下的连接是活跃 socket 不是僵尸
    }
  }

  async deleteServer(id: string): Promise<void> {
    const list = (await this.readServers()).filter((e) => e.id !== id);
    this.servers = list;
    await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
    // 聚合时销毁该源（killWs + 清缓存 + 出 Map）；其余源不受扰
    this.destroyConn(id);
    if ((await AsyncStorage.getItem("ccr_active")) === id) {
      const next = list[0];
      await AsyncStorage.setItem("ccr_active", next ? next.id : "");
      this.activeId = next ? next.id : null;
      if (next) {
        const nc = this.ensureConn(next);
        if (next.token || next.cloud) this.applyConfig(nc, next, next.token);
      } else {
        // 删光全部服务器：清空全局汇报状态，避免列表空了却仍显示"已连接"的幽灵连接
        this.taskDoneQueue = [];
        this.reportedTaskTs.clear();
        this.emit({ taskDoneQueue: [] });
        return;
      }
    }
    this.emit();
  }

  // 编辑服务器条目（名称/地址/令牌/云桥）：不切活动指针；连接相关字段变化时只重连被改的源
  async updateServer(
    id: string,
    patch: { name?: string; wsUrl?: string; token?: string; cloud?: CloudConfig | null; relayDev?: string | null },
  ): Promise<void> {
    const list = await this.readServers();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return;
    const before = list[idx];
    // 改地址 = 可能换指另一台 relay：旧 LAN 身份标记随之失效，清掉防凭旧身份误并（#401）
    const eff: typeof patch =
      patch.wsUrl !== undefined && patch.wsUrl !== before.wsUrl ? { ...patch, relayDev: null } : patch;
    list[idx] = { ...before, ...eff };
    this.servers = list;
    await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
    const conn = this.conns.get(id);
    if (conn) {
      conn.entry = list[idx];
      conn.name = list[idx].name;
    }
    const changed =
      (patch.wsUrl !== undefined && patch.wsUrl !== before.wsUrl) ||
      (patch.token !== undefined && patch.token !== before.token) ||
      (patch.cloud !== undefined && JSON.stringify(patch.cloud ?? null) !== JSON.stringify(before.cloud ?? null));
    if (!changed || !conn) return;
    // 单源模式只重连活动源（非活动源本就不在连）；聚合模式重连被改源
    if (!this.aggregate && id !== this.activeId) return;
    const tk = list[idx].token;
    if (tk || list[idx].cloud) this.applyConfig(conn, list[idx], tk);
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
    // 聚合开关（#294 批4）：抽屉「显示」区开关经 display-settings.setAggregate 持久化，
    // 这里启动读取（早于 connect 分发，见 display-settings 同键注释）
    try {
      this.aggregate = (await AsyncStorage.getItem("cc.display.aggregate")) === "1";
    } catch {}
    // #398 启动归并清理（同目标：历史多写法/重复添加）+ #401 补强同源身份归并（跨
    // LAN/云桥双条目）：先按身份合一——「云桥条目 + 曾连过的 LAN 条目」凭 relay_dev
    // 等价追溯合并（在线/已配对者优先保留，字段互补）；再走同目标归并。结果一次
    // 落盘，活动指针指向被并条目时改指幸存者
    const read = await this.readServers();
    const ident = mergeByIdentity(read);
    const dedup = dedupeServers(ident.list);
    const remap = new Map([...ident.remap, ...dedup.remap]);
    const list = dedup.list;
    if (list !== read) {
      await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
      const aid = await AsyncStorage.getItem("ccr_active");
      const fixed = aid ? remap.get(aid) : undefined;
      if (fixed) await AsyncStorage.setItem("ccr_active", fixed);
    }
    this.servers = list;
    const activeId = await AsyncStorage.getItem("ccr_active");
    const active = list.find((e) => e.id === activeId) ?? list[0];
    this.activeId = active ? active.id : null;
    // 无标记的 LAN 闲置条目主动补身份（同一 WiFi 下即能把「云桥 + LAN 直连」存量双条目并掉；
    // 探测异步进行，不阻塞启动连接）
    this.probeIdleLanIdentity();
    // 活动服务器没记令牌（勾了不记住）：单源停在设置页，列表里点它补输令牌；
    // 已配对云桥的条目例外——桥 token 本就允许留空（公共桥），cloud 配置即建连凭据。
    // 聚合模式回落任一可连源（#294 审查修复——聚合本就逐源建连，不能因活动源
    // 缺令牌把整个 App 卡在设置页；活动指针仍指向用户选的源）
    const connectable = (e: ServerEntry) => !!e.token || !!e.cloud;
    if (!active || !connectable(active)) {
      if (!this.aggregate) return null;
      const any = list.find(connectable);
      if (!any) return null;
      const fc = this.ensureConn(any);
      fc.cfg = { wsUrl: any.wsUrl, token: any.token };
      fc.cloudCfg = any.cloud ?? null;
      return fc.cfg;
    }
    const conn = this.ensureConn(active);
    conn.cfg = { wsUrl: active.wsUrl, token: active.token };
    conn.cloudCfg = active.cloud ?? null;
    return conn.cfg;
  }

  // 聚合开关切换（#294）：true→逐源建连（活动源目标一致且在连，被幂等跳过不拆重建）；
  // false→其余源拆连接清 timer，保留 sessions/timelines/lastSeq 内存缓存——再开时按
  // last_seq 续传无感恢复，只有 deleteServer 才彻底清
  setAggregate(v: boolean) {
    if (this.aggregate === v) return;
    this.aggregate = v;
    if (v) {
      for (const e of this.servers) {
        if (!e.token && !e.cloud) continue;
        this.applyConfig(this.ensureConn(e), e, e.token);
      }
    } else {
      for (const conn of this.conns.values()) {
        if (conn.id === this.activeId) continue;
        this.connDisconnect(conn);
      }
    }
    this.emit();
  }

  // ---------- 源连接管理 ----------

  private ensureConn(entry: ServerEntry): SourceConn {
    let conn = this.conns.get(entry.id);
    if (!conn) {
      conn = {
        id: entry.id,
        name: entry.name,
        entry,
        cfg: null,
        cloudCfg: entry.cloud ?? null,
        ws: null,
        channel: null,
        state: "idle",
        stateText: null,
        failNote: null,
        lastSeq: 0,
        models: [],
        sessions: new Map(),
        timelines: new Map(),
        reconnectDelay: RECONNECT_BASE_MS,
        reconnectTimer: null,
        countdownTimer: null,
        retryAt: 0,
        hbTimer: null,
        probeTimer: null,
        lastDownAt: 0,
        epoch: 0,
        pendingCmds: new Map(),
      };
      this.conns.set(entry.id, conn);
    } else {
      conn.entry = entry;
      conn.name = entry.name;
    }
    return conn;
  }

  private activeConn(): SourceConn | null {
    return this.activeId ? this.conns.get(this.activeId) ?? null : null;
  }

  // 换连入口（#291 纪律：所有重建路径必经 connDisconnect→killWs，含 probeLan 失败分支）。
  // 幂等降级为 conn 级：目标与该源最后建连参数一致且 connecting/online → 跳过重建；
  // 目标一致但已断 → 保留缓存直接续连（last_seq 续传）；目标变化 → 清缓存全量重建
  private applyConfig(conn: SourceConn, entry: ServerEntry, token: string) {
    const sameTarget =
      !!conn.cfg &&
      conn.cfg.wsUrl === entry.wsUrl &&
      conn.cfg.token === token &&
      sameCloud(conn.cloudCfg, entry.cloud ?? null);
    if (sameTarget && (conn.state === "connecting" || conn.state === "online")) return;
    if (sameTarget && conn.state === "unpaired") {
      // 未配对终态下的显式重连（重新配对完成/用户点选连接）：强制重走连接周期验证
      // 身份——connDisconnect 把状态复位 offline，connConnect 的 unpaired 门放行
      this.connDisconnect(conn);
      this.connConnect(conn);
      return;
    }
    if (!sameTarget) {
      for (const sid of conn.sessions.keys()) {
        if (this.sidIndex.get(sid) === conn) this.sidIndex.delete(sid);
      }
      conn.sessions.clear();
      conn.timelines.clear();
      conn.lastSeq = 0;
      conn.cfg = { wsUrl: entry.wsUrl, token };
      conn.cloudCfg = entry.cloud ?? null;
    }
    this.connDisconnect(conn);
    this.connConnect(conn);
  }

  // 拆单个源：掐周期/timer/在途命令 + killWs；不动 sessions/timelines/lastSeq 缓存。
  // hbTimer 不在此清（对齐旧 disconnect）：残留一拍后由 startHb 的 ws 守卫自清
  private connDisconnect(conn: SourceConn) {
    conn.epoch++;
    conn.reconnectDelay = RECONNECT_BASE_MS;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.clearCountdown(conn);
    if (conn.probeTimer) {
      clearTimeout(conn.probeTimer);
      conn.probeTimer = null;
    }
    this.clearPendingCmds(conn);
    killWs(conn.ws);
    conn.ws = null;
    conn.channel = null;
    conn.state = "offline";
    conn.stateText = null;
    conn.failNote = null;
  }

  private clearCountdown(conn: SourceConn) {
    if (conn.countdownTimer) {
      clearInterval(conn.countdownTimer);
      conn.countdownTimer = null;
    }
  }

  // 彻底销毁（仅 deleteServer 触达）：拆连接 + 清缓存 + 出 Map + 摘 sidIndex
  private destroyConn(id: string) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.connDisconnect(conn);
    for (const sid of conn.sessions.keys()) {
      if (this.sidIndex.get(sid) === conn) this.sidIndex.delete(sid);
    }
    conn.sessions.clear();
    conn.timelines.clear();
    conn.lastSeq = 0;
    this.conns.delete(id);
  }

  // 断开即静默清空该源在途命令：结果靠重连快照对账，残留 timer 只会在
  // 离线窗口误报「未确认」、甚至把重发打到新连接上
  private clearPendingCmds(conn: SourceConn) {
    for (const p of conn.pendingCmds.values()) clearTimeout(p.timer);
    conn.pendingCmds.clear();
  }

  // 对外连接入口（启动自动连/回前台重连/手动重连按钮共用）：内部按 aggregate 分发
  // 聚合逐源建连 / 单源只连活动源。unpaired 终态不自动重试（relay 已明确不认此
  // 身份，重试只会反复吃 pair_nack）——重配对走 applyConfig 的强制重连分支
  connect() {
    if (this.aggregate) {
      for (const e of this.servers) {
        if (!e.token && !e.cloud) continue;
        if (this.conns.get(e.id)?.state === "unpaired") continue;
        this.applyConfig(this.ensureConn(e), e, e.token);
      }
      return;
    }
    const conn = this.activeConn();
    if (conn && conn.state !== "unpaired") this.connConnect(conn);
  }

  // 手动重试（②：失败态「立即重试」按钮）：重置退避到起步值并立刻重走连接周期，
  // 之后失败仍按 3s→30s 指数退避续跑。unpaired 终态不受理——配对问题重试无解，
  // UI 在该态显示重新配对引导而非重试钮
  retryNow() {
    if (this.aggregate) {
      for (const e of this.servers) {
        if (!e.token && !e.cloud) continue;
        const conn = this.ensureConn(e);
        conn.reconnectDelay = RECONNECT_BASE_MS;
        if (conn.state === "unpaired") continue;
        this.applyConfig(conn, e, e.token);
      }
      return;
    }
    const conn = this.activeConn();
    if (!conn || conn.state === "unpaired") return;
    conn.reconnectDelay = RECONNECT_BASE_MS;
    this.connConnect(conn);
  }

  disconnect() {
    if (this.logEmitTimer) {
      clearTimeout(this.logEmitTimer);
      this.logEmitTimer = null;
    }
    if (this.aggregate) {
      for (const conn of this.conns.values()) this.connDisconnect(conn);
      return;
    }
    const conn = this.activeConn();
    if (conn) this.connDisconnect(conn);
  }

  // 连接周期：先 LAN 直连（探测超时），失败且已配对云桥则本轮转云通道。每源独立循环。
  // unpaired 门：未配对终态不再发起（自动路径 connect/scheduleReconnect 均已拦；
  // 显式重连经 applyConfig→connDisconnect 先复位 offline 再进来，不受影响）
  private connConnect(conn: SourceConn) {
    if (!conn.cfg) return;
    // 无令牌的纯云桥条目（公共桥 token 留空）也放行：凭 cloudCfg 走云通道；
    // 既无令牌也无云桥配置才无从建连
    if (!conn.cfg.token && !conn.cloudCfg) return;
    if (conn.state === "unpaired") return;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.clearCountdown(conn);
    const ep = ++conn.epoch;
    conn.state = "connecting";
    conn.stateText = null;
    this.emit();
    if (conn.cloudCfg && !this.devKeys) void this.deviceKeys();
    void this.connCycle(conn, ep);
  }

  private async connCycle(conn: SourceConn, ep: number) {
    const cfg = conn.cfg!;
    killWs(conn.ws);
    conn.ws = null;
    conn.channel = null;
    // 纯云桥条目（wsUrl 即桥地址，非内网直连）跳过 LAN 探测：桥 upgrade 强制要求
    // dev 参数，探它必 401，白耗一轮握手；LAN 直连地址照旧先探（同一 WiFi 下低延迟）
    const lanWs = conn.cloudCfg && !isLanUrl(cfg.wsUrl) ? null : await this.probeLan(conn, cfg);
    if (ep !== conn.epoch) {
      try {
        lanWs?.close();
      } catch {}
      return;
    }
    if (lanWs) {
      this.adoptLan(conn, lanWs);
      return;
    }
    if (conn.cloudCfg && !this.devKeys) {
      // 冷启动首轮 keys 还没从 AsyncStorage 就绪（connConnect 里是 fire-and-forget 预取，
      // 微任务级）：等一拍再判，消除「首轮必 offline」的假失败（旧版靠下一轮重连兜底，
      // 退避起步 3s 后这个空窗会被放大成可见的假诊断）
      await this.deviceKeys();
      if (ep !== conn.epoch) return;
    }
    if (conn.cloudCfg && this.devKeys) {
      this.openCloud(conn, conn.cloudCfg);
      return;
    }
    conn.state = "offline";
    conn.stateText = null;
    // LAN 探测失败且无云通道可转：纯 LAN 条目不可达（PC 离线/不在同一 WiFi）
    conn.failNote = conn.cloudCfg ? "云桥凭据未就绪，稍后自动重试" : "直连失败：确认 PC 在线且与手机同一 WiFi，远程请用云桥";
    this.emit();
    this.scheduleReconnect(conn);
  }

  // LAN 探测：open 即成功（返回活连接，由调用方接管）；超时/出错返回 null
  private probeLan(conn: SourceConn, cfg: ConnConfig): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      const url =
        cfg.wsUrl +
        "?token=" + encodeURIComponent(cfg.token) +
        (conn.lastSeq > 0 ? "&last_seq=" + conn.lastSeq : "");
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

  private adoptLan(conn: SourceConn, ws: WebSocket) {
    conn.ws = ws;
    conn.channel = "lan";
    conn.reconnectDelay = RECONNECT_BASE_MS;
    conn.state = "online";
    conn.stateText = null;
    conn.failNote = null;
    this.emit();
    this.startHb(conn, ws);
    ws.onclose = () => {
      if (conn.ws !== ws) return;
      this.stopHb(conn);
      this.clearPendingCmds(conn);
      conn.state = "offline";
      conn.stateText = null;
      conn.channel = null;
      this.emit();
      this.scheduleReconnect(conn);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (conn.ws !== ws) return;
      conn.lastDownAt = Date.now();
      let msg: Envelope | CommandAck;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onMessage(conn, msg);
    };
  }

  private openCloud(conn: SourceConn, cloud: CloudConfig) {
    const keys = this.devKeys!;
    // 本机在桥上的身份须与 relay peers 里的登记一致（relay 按 dev 查 peers 取公钥
    // 验密）：配对码远程配对落的是 "wb-" 身份（见 CloudConfig.dev），LAN 配对落
    // "ph-"。旧条目无 dev 字段回落 "ph-"，行为不变
    const dev = cloud.dev ?? devId(keys.publicKey, "ph");
    const url =
      cloud.url +
      (cloud.url.includes("?") ? "&" : "?") +
      "token=" + encodeURIComponent(cloud.token) +
      "&dev=" + encodeURIComponent(dev);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      conn.state = "offline";
      conn.stateText = null;
      conn.failNote = "云桥地址无效";
      this.emit();
      this.scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    conn.channel = "cloud";
    // 开门标记：区分「桥都连不上」（地址错/断网/封锁 → 传输层，自动重试）与开门后的
    // 各种断开（relay 离线/桥闪断）。三态拆分 ④c 的诊断依据
    let opened = false;
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      opened = true;
      conn.reconnectDelay = RECONNECT_BASE_MS;
      // #33 假在线修正：桥 ws 开门 ≠ relay 在线（手机云通道连的是桥，relay 关机时
      // 桥照样开门）。真在线 = 收到 relay 首帧（SNAPSHOT/pong，onMessage 置位）；
      // 开门态标 connecting + 「等待电脑端响应」，用户不再看到关机电脑「在线」
      conn.state = "connecting";
      conn.stateText = "等待电脑端响应";
      conn.failNote = null;
      this.emit();
      this.startHb(conn, ws, cloud, keys);
      ws.send(
        JSON.stringify({
          to: cloud.relayDev,
          data: seal({ t: "hello", last_seq: conn.lastSeq }, cloud.relayPubkey, keys.secretKey),
        }),
      );
      // #401 补强：云通道在线（自身身份已知）即主动为无标记的 LAN 闲置条目补身份——
      // 同一 WiFi 时探测可达，「云桥 + LAN 直连」双条目无需用户点选即自动合一
      this.probeIdleLanIdentity();
    };
    ws.onclose = () => {
      if (conn.ws !== ws) return;
      this.stopHb(conn);
      this.clearPendingCmds(conn);
      conn.awaitWake = false; // #34 桥 ws 断了：待唤醒作废，回落旧重连循环
      conn.state = "offline";
      conn.stateText = null;
      // 从未开过门 = 桥不可达（桥地址错/网络断/封锁），不是配对问题——继续自动重试
      if (!opened) conn.failNote = "连不上云桥：检查网络或桥地址";
      conn.channel = null;
      this.emit();
      this.scheduleReconnect(conn);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (conn.ws !== ws) return;
      conn.lastDownAt = Date.now();
      let frame: { type?: string; data?: SealedBox };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === "ROUTE_MISS") {
        // #34 待唤醒：桥通、relay 离线。旧版断 ws 盲目重连（每轮开门→hello→
        // ROUTE_MISS→断开循环空耗，relay 关机整夜手机跟着跑整夜）。现保持桥连接
        // 置待唤醒，等桥广播 relay-online 再补 hello 恢复；桥 ws 自身断开才走
        // 旧重连。心跳照跑——ROUTE_MISS 回帧刷新 lastDownAt 兼当桥活性探测。
        // P2：仅首次进入重置计数——每 15s ping 都会回一条 ROUTE_MISS 走到这里，
        // 重复进待唤醒不能把 wakePings 累穿（否则二次窗口被首次已计拍数挤占）
        if (!conn.awaitWake) {
          conn.awaitWake = true;
          conn.wakePings = 0;
        }
        conn.state = "offline";
        conn.stateText = null;
        conn.failNote = "已连上云桥，电脑端离线（上线后自动恢复）";
        this.emit();
        return;
      }
      // #34 桥广播 relay 上线：待唤醒态且 rd 匹配本源 relay → 同连接补发 hello
      // 恢复（非待唤醒态忽略——在线连接由 relay 侧 auto-resume 补帧，无需动作）
      if (frame.type === "relay-online") {
        const rd = (frame as { rd?: unknown }).rd;
        if (conn.awaitWake && rd === cloud.relayDev) {
          conn.awaitWake = false;
          conn.state = "connecting";
          conn.stateText = "等待电脑端响应";
          conn.failNote = null;
          this.emit();
          try {
            ws.send(
              JSON.stringify({
                to: cloud.relayDev,
                data: seal({ t: "hello", last_seq: conn.lastSeq }, cloud.relayPubkey, keys.secretKey),
              }),
            );
          } catch {}
        }
        return;
      }
      if (!frame.data) return;
      // 明文 pair_nack（无 n 字段 = 未密封）：relay 明确不认本机身份——未配对/被踢/
      // relay 侧配对信息丢失（判定同 pairViaBridge 的 nack 处理）。进未配对终态并停
      // 止重试：这是三态里唯一该输码解决的态，网络类失败永远到不了这里
      const plain = frame.data as { t?: unknown; error?: unknown; n?: unknown };
      if (typeof plain === "object" && plain.t === "pair_nack" && plain.n === undefined) {
        this.markUnpaired(conn, typeof plain.error === "string" && plain.error ? plain.error : "设备不在 relay 配对列表中");
        return;
      }
      const inner = unseal<Envelope | CommandAck>(frame.data, cloud.relayPubkey, keys.secretKey);
      if (!inner) return;
      // 密文 nack（防御位：现行 relay 对已建连设备只发明文，预留同判定）
      const sealedNack = inner as { t?: unknown; error?: unknown };
      if (sealedNack.t === "pair_nack") {
        this.markUnpaired(conn, typeof sealedNack.error === "string" && sealedNack.error ? sealedNack.error : "设备不在 relay 配对列表中");
        return;
      }
      this.onMessage(conn, inner);
    };
  }

  // 未配对终态（④b）：relay 明确回 pair_nack（新装未配对用例不会走到这——那是没
  // 配置；这里是「曾有身份但 relay 不认了」= 被踢/relay 侧丢失）。停自动重试、拆
  // 连接置 unpaired，等用户重新配对（addCloudManual/点选连接会经 applyConfig 复位）
  private markUnpaired(conn: SourceConn, reason: string) {
    conn.epoch++;
    conn.state = "unpaired";
    conn.stateText = "未配对";
    conn.failNote = reason;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.clearCountdown(conn);
    if (conn.probeTimer) {
      clearTimeout(conn.probeTimer);
      conn.probeTimer = null;
    }
    this.stopHb(conn);
    this.clearPendingCmds(conn);
    killWs(conn.ws);
    conn.ws = null;
    conn.channel = null;
    this.emit();
  }

  // 应用层心跳：15s 一拍保持链路流量（防公司网络 idle 掐 NAT），55s 无任何下行
  // 判半开强制断开重连（否则要等 TCP 重传超时，分钟级黑洞）。每源独立计时
  private startHb(conn: SourceConn, ws: WebSocket, cloud?: CloudConfig, keys?: BoxKeyPair) {
    this.stopHb(conn);
    conn.lastDownAt = Date.now();
    conn.wakePings = 0;
    conn.hbTimer = setInterval(() => {
      if (conn.ws !== ws) {
        this.stopHb(conn);
        return;
      }
      if (Date.now() - conn.lastDownAt > 55_000) {
        try { ws.close(); } catch {}
        return;
      }
      // #34 旧桥兼容兜底：待唤醒态下 ROUTE_MISS 回帧会持续刷新 lastDownAt，
      // 55s 判死永不触发；桥不升级就没有 relay-online 广播 → 永久卡待唤醒。
      // 待唤醒累计 40 拍（≈10 分钟）无唤醒即强制断开，回落旧重连循环（新版
      // 桥下正常秒级唤醒，此路径只在混跑期走到）
      if (conn.awaitWake && ++conn.wakePings! >= 40) {
        conn.awaitWake = false;
        try { ws.close(); } catch {}
        return;
      }
      try {
        ws.send(cloud && keys
          ? JSON.stringify({ to: cloud.relayDev, data: seal({ t: "ping", last_seq: conn.lastSeq }, cloud.relayPubkey, keys.secretKey) })
          : JSON.stringify({ type: "PING" }));
      } catch {}
    }, 15_000);
  }

  private stopHb(conn: SourceConn) {
    if (conn.hbTimer) {
      clearInterval(conn.hbTimer);
      conn.hbTimer = null;
    }
  }

  // 回前台即时体检（#258）：后台冻结/断网期间 socket 可能已被系统杀死而
  // connected 仍真——AppState active 不能只信 connected 干等 15s 心跳拍。
  // 先按心跳同口径判死（>55s 无下行直接断开），否则补发一拍 PING 等 4s，
  // 仍无任何下行（PONG 也算）即判死。断开走既有 onClose→重连→replay/SNAPSHOT
  // 恢复链，错过的 TASK_DONE 由 last_task_done 状态兜回。
  // 聚合模式遍历 conns 逐个体检
  resumeProbe() {
    for (const conn of this.conns.values()) {
      if (!this.aggregate && conn.id !== this.activeId) continue;
      this.connResumeProbe(conn);
    }
    // #401 补强：回前台顺带为无标记的 LAN 闲置条目补身份（到家抬腕即触发归并，
    // 10 分钟冷却防反复探测）
    this.probeIdleLanIdentity();
  }

  private connResumeProbe(conn: SourceConn) {
    const ws = conn.ws;
    // readyState 守卫：disconnect 后 hbTimer 残留 ≤15s（下一拍自清）+ 新 socket
    // 尚在 CONNECTING 的窗口内，hbTimer 判存活不可靠，只探已 OPEN 的连接
    if (!ws || !conn.hbTimer || ws.readyState !== WebSocket.OPEN) return;
    if (conn.probeTimer) {
      clearTimeout(conn.probeTimer);
      conn.probeTimer = null;
    }
    const t0 = conn.lastDownAt;
    if (Date.now() - t0 > 55_000) {
      try { ws.close(); } catch {}
      return;
    }
    const cloud = conn.channel === "cloud" && conn.cloudCfg ? conn.cloudCfg : undefined;
    const keys = this.devKeys;
    try {
      ws.send(cloud && keys
        ? JSON.stringify({ to: cloud.relayDev, data: seal({ t: "ping", last_seq: conn.lastSeq }, cloud.relayPubkey, keys.secretKey) })
        : JSON.stringify({ type: "PING" }));
    } catch {
      try { ws.close(); } catch {}
      return;
    }
    conn.probeTimer = setTimeout(() => {
      conn.probeTimer = null;
      if (conn.ws === ws && conn.lastDownAt === t0) {
        try { ws.close(); } catch {}
      }
    }, 4000);
  }

  // 失败后自动重试调度（③）：3s 起指数退避至 30s 封顶，重试等待期每秒刷新倒计时
  // 文案（"重试中…下次 Ns"）——用户能看到系统在自愈，而不是误以为要去输码。
  // 连上（adoptLan/openCloud onopen）即把 reconnectDelay 归零重来
  private scheduleReconnect(conn: SourceConn) {
    if (!conn.cfg) return;
    if (conn.state === "unpaired") return;
    const delay = conn.reconnectDelay;
    conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX_MS);
    conn.state = "reconnecting";
    conn.retryAt = Date.now() + delay;
    conn.stateText = `重试中…下次 ${Math.round(delay / 1000)}s`;
    this.emit();
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = setTimeout(() => this.connConnect(conn), delay);
    this.clearCountdown(conn);
    conn.countdownTimer = setInterval(() => {
      if (conn.state !== "reconnecting") {
        this.clearCountdown(conn);
        return;
      }
      const left = Math.ceil((conn.retryAt - Date.now()) / 1000);
      if (left <= 0) {
        // 计时归零：重试定时器已触发/即将触发，等状态翻 connecting 由 connConnect 清理
        this.clearCountdown(conn);
        return;
      }
      const text = `重试中…下次 ${left}s`;
      if (text !== conn.stateText) {
        conn.stateText = text;
        this.emit();
      }
    }, 1000);
  }

  // ---------- 下行处理（LAN 与云通道共用，云侧已解密；按源隔离） ----------

  private onMessage(conn: SourceConn, msg: Envelope | CommandAck) {
    // #33：relay 首帧 = 真在线（云通道开门只标 connecting）。LAN adoptLan 无此问题
    // （ws 直连 relay，开门即在线），只在云通道补位
    if (conn.channel === "cloud" && conn.state !== "online") {
      conn.state = "online";
      conn.stateText = null;
      // #34 P1：relay 首帧也是"已恢复在线"的证明（旧桥无广播时靠 ping-pong 自愈
      // 走到这里）——清待唤醒标记与计数，否则 wakePings 继续累计会在 40 拍后
      // 把一条已恢复健康的连接强断（白挨一次断连+重连+快照重建）
      if (conn.awaitWake) {
        conn.awaitWake = false;
        conn.wakePings = 0;
        conn.failNote = null;
      }
    }
    if ((msg as CommandAck).type === "COMMAND_ACK") {
      const ack = msg as CommandAck;
      const p = conn.pendingCmds.get(ack.command_id);
      if (p) {
        clearTimeout(p.timer);
        conn.pendingCmds.delete(ack.command_id);
      }
      // 0.4.4 结果语义回调：duplicate（重发命中幂等去重=早已执行过）按成功口径回，
      // 其余按 ACK 原样；p 不存在（已被超时收摊）则丢弃
      if (p?.onAck) {
        const dup = !ack.ok && !!ack.error && ack.error.startsWith("duplicate");
        try { p.onAck({ ok: ack.ok === true || dup, err: ack.ok || dup ? null : String(ack.error ?? "未知错误") }); } catch {}
      }
      if (ack.cloud) void this.saveCloudPairing(conn, ack.cloud);
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
    if (env.seq !== undefined) conn.lastSeq = Math.max(conn.lastSeq, env.seq);
    this.onEvent(conn, env);
    // 流式日志走合帧通知；其余事件（状态/快照/汇报等）照常即时通知——
    // 即时 emit 同时会把窗口内积着的流式块一并冲出（会话切换天然 flush）
    if (env.type === "SESSION_LOG") this.emitLogFrame();
    else this.emit();
  }

  // 配对 ACK：relay 经可信 LAN 信道回传云桥参数，按 conn.entry 定位条目落盘
  private async saveCloudPairing(conn: SourceConn, info: CloudPairInfo) {
    const cloud: CloudConfig = {
      url: info.url,
      token: info.token,
      relayDev: info.relay_dev,
      relayPubkey: info.relay_pubkey,
    };
    conn.cloudCfg = cloud;
    try {
      const list = await this.readServers();
      const entry = list.find((e) => e.id === conn.id);
      if (entry) {
        entry.cloud = cloud;
        this.servers = list;
        conn.entry = entry;
        await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
      }
    } catch {}
    this.emit({ cloudBusy: false, cloudMsg: "云桥配对成功，外出时自动经云通道连接" });
  }

  // ---------- #401 补强：同源身份归并（规则化，无论条目何时产生） ----------
  // relay 启用云桥时把自身设备 id（devId(relayPubkey,"rl")，= CloudConfig.relayDev
  // 同源值）随 SNAPSHOT 下发（LAN 快照 0.3.30+，云通道快照 0.3.32+）。条目身份 =
  // cloud.relayDev ?? relayDev 标记：同身份 = 同一台 relay 的密码学证明 → 合一。
  // 旧实现只在「本连接快照 relay_dev 与另一条目 cloud.relayDev 相同」时合并，漏了
  // 两个场景：a) 单源模式下闲置 LAN 条目永不建连，收不到快照、标记无从盖章；
  // b) 云通道快照此前不带 relay_dev，云在线时证据链断裂。这里改为规则化归并 +
  // 主动身份探测补盖

  // SNAPSHOT 学到 relay_dev：盖章本源条目并按身份归并（preferId=本在线源，保留其
  // 连接/会话上下文连续）。快照重复到达时 applyIdentity 幂等（已盖章且无组可并即
  // 空转）。合并可能销毁别的源连接，须在 conn.sessions 清空重建前发起（调用点保证）
  private learnRelayDev(conn: SourceConn, relayDev: string): void {
    void this.applyIdentity(conn.id, relayDev, conn.id);
    // 在线身份确认后顺手为无标记的 LAN 闲置条目补身份（同一 WiFi 下即自动合并双条目）
    this.probeIdleLanIdentity();
  }

  private onlineConnId(): string | null {
    for (const c of this.conns.values()) if (c.state === "online") return c.id;
    return null;
  }

  // 身份盖章 + 归并公共尾巴：给条目记下 relay 身份（必要时），再按身份合一（无论
  // 条目何时产生——加载/快照/探测三处共用）。落盘一次；活动指针与被并条目的连接
  // 上下文重映射到幸存者；幸存连接刷新条目（LAN 源并入云桥后 cloudCfg 即时生效：
  // 掉线当轮即可转云通道，不必等重连读 entry）
  private async applyIdentity(entryId: string, relayDev: string, preferId: string | null): Promise<void> {
    let stamped = false;
    const stampedList = this.servers.map((e) => {
      if (e.id !== entryId || e.relayDev === relayDev) return e;
      stamped = true;
      return { ...e, relayDev };
    });
    const { list, remap } = mergeByIdentity(stampedList, preferId);
    if (list === stampedList && !stamped) return;
    this.servers = list;
    try {
      await AsyncStorage.setItem("ccr_conns", JSON.stringify(list));
      const aid = await AsyncStorage.getItem("ccr_active");
      const fixed = aid ? remap.get(aid) : undefined;
      if (fixed) await AsyncStorage.setItem("ccr_active", fixed);
    } catch {}
    if (this.activeId && remap.has(this.activeId)) this.activeId = remap.get(this.activeId)!;
    for (const gone of remap.keys()) this.destroyConn(gone);
    for (const c of this.conns.values()) {
      const ent = this.servers.find((e) => e.id === c.id);
      if (!ent) continue;
      if (c.entry !== ent) {
        c.entry = ent;
        c.name = ent.name;
      }
      if (ent.cloud && !c.cloudCfg) c.cloudCfg = ent.cloud;
    }
    this.emit();
    const pairs = [...remap.entries()].map(([from, to]) => `${from}→${to}`).join("、");
    console.log(`[merge] relay_dev=${relayDev} 同源归并${pairs ? `：${pairs}` : "（仅盖章）"}`);
  }

  // 主动身份探测入口（启动/云在线/快照学身份后调用）：扫「无 cloud、无标记、有令牌、
  // 内网直连」且当前不在连的条目——它们在单源模式下永不建连、快照身份永不到达（旧
  // 机制漏盖根因）。每条目 10 分钟冷却，防重连风暴下反复探测
  private probeTriedAt = new Map<string, number>();

  probeIdleLanIdentity(): void {
    for (const e of this.servers) {
      if (e.cloud || e.relayDev || !e.token || !isLanUrl(e.wsUrl)) continue;
      const c = this.conns.get(e.id);
      if (c?.ws && c.ws.readyState === WebSocket.OPEN) continue; // 在连：它自己的快照会盖章
      if (Date.now() - (this.probeTriedAt.get(e.id) ?? 0) < 600_000) continue;
      this.probeTriedAt.set(e.id, Date.now());
      void this.probeLanIdentity(e.id, e.wsUrl, e.token);
    }
  }

  // 一次性身份探测：连目标条目的 LAN 地址，等首帧 SNAPSHOT（服务端连上即推）读
  // relay_dev 后立即断开——不建 SourceConn、不进事件装配。同身份即归并（preferId=
  // 当前在线源），不同只落标记，连不上（非同一网络/旧版 relay 无字段）静默
  private async probeLanIdentity(id: string, wsUrl: string, token: string): Promise<void> {
    const relayDev = await new Promise<string | null>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl + "?token=" + encodeURIComponent(token));
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => done(null), LAN_PROBE_MS);
      const done = (v: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killWs(ws);
        resolve(v);
      };
      ws.onerror = () => done(null);
      ws.onclose = () => done(null);
      ws.onmessage = (ev: WebSocketMessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as { type?: string; payload?: { relay_dev?: unknown } };
          if (m.type === "SNAPSHOT") {
            const rd = m.payload?.relay_dev;
            done(typeof rd === "string" && rd ? rd : null);
          }
        } catch {}
      };
    });
    if (relayDev) void this.applyIdentity(id, relayDev, this.onlineConnId());
  }

  // 在已连接的 LAN 信道上发起云桥配对（信任锚 = LAN token）。配对是 per-server
  // 行为：走活动源，语义与单源时代一致
  async pairCloud(): Promise<void> {
    this.clearCloudMsg();
    const conn = this.activeConn();
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN || conn.channel !== "lan") {
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
    const sent = this.send("COMMAND_PAIR_START", { pubkey: keys.publicKey, name: deviceDisplayName() });
    if (!sent) this.emit({ cloudBusy: false, cloudMsg: "配对命令发送失败" });
  }

  clearCloudMsg() {
    if (this.snap.cloudBusy || this.snap.cloudMsg) {
      this.emit({ cloudBusy: false, cloudMsg: null });
    }
  }

  // 为网页端等新设备签发一次性配对码（LAN/云任一已连接信道均可）：走活动源
  async requestPairCode(): Promise<string | null> {
    const conn = this.activeConn();
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return "请先连接服务器";
    if (this.send("COMMAND_PAIR_CODE", {})) return null;
    return "命令发送失败";
  }

  // #316 手表配对授权：回给发 PAIR_REQUEST 的那个源（多源下不串台），发完收弹窗
  decideWatchPair(allow: boolean): void {
    const w = this.snap.watchPair;
    if (!w) return;
    const sent = this.send("COMMAND_WATCH_GRANT", { request_id: w.requestId, allow }, w.sourceId);
    this.emit({ watchPair: null });
    if (!sent) this.emit({ lastErrorCmd: "未能回复手表配对（连接已断开）" });
  }

  // #329 扫码登录路由：找 relayDev 与登录码 rd 匹配的已连接云源（授权发给目标服务器
  // 本体而非凑合活动源）；找不到返回 undefined 由调用方回落活动源——扫码即登录，不阻断
  sourceIdForRelay(rd: string): string | undefined {
    for (const [id, conn] of this.conns) {
      if (conn.entry.cloud?.relayDev === rd && conn.ws && conn.ws.readyState === WebSocket.OPEN) return id;
    }
    return undefined;
  }

  // ---------- 云桥配对码远程接入（输码 / 扫邀请码共用链路） ----------
  // 临时连桥完成 pair_req → pair_ack：手机以 "wb-" 身份注册（relay 对 pair_req 有
  // 防冒名校验：帧 from 必须 = devId(pubkey,"wb")，"ph-" 身份会被静默丢弃——手机旧
  // 实现栽在这里）；rd/rk 未知时先发发现帧（{to:"*",t:"disc"} → 桥回在线 relay 列表）
  // 运行时定位目标 relay。pair_req 6s 一拍最多发 3 次（pair_ack 随桥闪断丢失时 relay
  // 幂等补 ack，重发即自愈），~24s 无果报超时。成功返回 {rd, rk, dev}（dev = 本次
  // 配对身份，落 CloudConfig.dev 供 openCloud 沿用），失败返回错误文案。
  // 码只在 relay 校验通过时才消耗：输错可改码重试；连续错 5 次进 relay 侧 10 分钟静默期。
  // 多台 relay 同时在线且无可信 rd 时走「配对码即定位凭据」：pair_req 以 to:"*" 广播
  //（data 带 bc:true），持码 relay 才回 pair_ack、其余静默——不再要求扫码。
  // 广播态不知道目标公钥，ack 用发现列表里的 rk 逐个试解，且 ack 身份必须落在列表内。
  private async pairViaBridge(o: {
    bridge: string; bt: string; code: string; rd?: string; rk?: string;
  }): Promise<{ rd: string; rk: string; dev: string } | string> {
    const keys = await this.deviceKeys();
    const dev = devId(keys.publicKey, "wb");
    const url =
      o.bridge + (o.bridge.includes("?") ? "&" : "?") +
      "token=" + encodeURIComponent(o.bt) + "&dev=" + encodeURIComponent(dev);
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        resolve("云桥地址无效");
        return;
      }
      let settled = false;
      let rd = o.rd ?? "";
      let rk = o.rk ?? "";
      // 广播定位态：在线 relay 候选（ack 试解公钥 + 身份核对），进入即不再猜单一目标
      let bc = false;
      let cands: { dev: string; rk: string }[] = [];
      let timer: ReturnType<typeof setInterval> | null = null;
      let beat = 0;
      const done = (r: { rd: string; rk: string; dev: string } | string) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        try { ws.close(); } catch {}
        resolve(r);
      };
      const sendPairReq = () => {
        // #42 设备身份元数据自报（可选字段，旧 relay 忽略未知字段天然兼容）：
        // platform=OS+型号（"android·Pixel 8"），app=应用+版本（"CC Deck 0.3.35"），
        // name=服务器条目名（配对落库后条目就叫这个，hostOf(bridge) 同源）。relay 校验
        // 各字段 ≤120 字符后随 addPeer 持久化，设备清单据此展示型号/版本
        const ver = currentVersion();
        const meta = {
          name: hostOf(o.bridge),
          platform: [Platform.OS, Constants.deviceName].filter(Boolean).join("·"),
          app: ver ? "CC Deck " + ver : "CC Deck",
        };
        ws.send(JSON.stringify({
          to: rd || "*",
          data: rd
            ? { t: "pair_req", code: o.code, pubkey: keys.publicKey, name: "手机-" + dev.slice(3, 9), meta }
            // bc 标记：未持码 relay 静默（码不归它管），持码者照常 ack
            : { t: "pair_req", code: o.code, pubkey: keys.publicKey, name: "手机-" + dev.slice(3, 9), bc: true, meta },
        }));
      };
      const sendDisc = () => {
        ws.send(JSON.stringify({ to: "*", data: { t: "disc" } }));
      };
      // 看门狗：缺 rd/rk 补发现帧，齐了补发 pair_req；广播态持续广播并刷新候选
      //（晚连上的 relay 也要能收到/应答）；换目标时 kick() 重置拍数
      const kick = () => {
        beat = 0;
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
          if (settled) return;
          if (++beat > 3) {
            done(
              rd ? "云桥长时间无应答，请重试"
                : bc ? "未找到持有该配对码的 relay：请核对配对码，或确认目标电脑已连上云桥"
                  : "未能定位电脑端的 relay，请重试",
            );
            return;
          }
          if (rd && rk) sendPairReq();
          else if (bc) {
            sendPairReq();
            sendDisc();
          } else sendDisc();
        }, 6000);
      };
      ws.onopen = () => {
        if (!rd || !rk) sendDisc();
        else sendPairReq();
        kick();
      };
      ws.onerror = () => done("连不上云桥（检查网络与云桥令牌）");
      ws.onclose = () => done("连接中断，请重试");
      ws.onmessage = (ev: WebSocketMessageEvent) => {
        let f: {
          type?: string;
          relays?: unknown;
          data?: SealedBox | { t?: unknown; error?: unknown; n?: unknown };
        };
        try {
          f = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (f.type === "ROUTE_MISS") {
          // pair_req 目标不在线：码未被 relay 消费，可稍后原码重试
          done("目标 relay 不在线（配对码未消耗），确认电脑端 CC Deck 已连上云桥后再试");
          return;
        }
        if (f.type === "RELAYS") {
          // 发现回包：桥下发在线 relay {dev, rk}。可信 rd 命中或唯一在线即采信；
          // 多台且无可信 rd 时不再拒绝——配对码即定位凭据，广播 pair_req 由持码者应答
          const all = (Array.isArray(f.relays) ? f.relays : []).filter(
            (x): x is { dev: string; rk?: string } =>
              !!x && typeof (x as { dev?: unknown }).dev === "string" &&
              String((x as { dev?: unknown }).dev).startsWith("rl-"),
          );
          const pick = all.find((x) => x.dev === rd) ?? (all.length === 1 ? all[0] : null);
          if (!pick) {
            if (all.length > 1) {
              // 广播定位态：记候选（ack 试解 + 身份核对），立即广播一拍；仅首次进入
              // 时 kick()——后续发现刷新若再 kick 会把看门狗拍数清零、永不超时
              const fresh = !bc;
              bc = true;
              cands = all.filter((x): x is { dev: string; rk: string } => !!x.rk);
              sendPairReq();
              if (fresh) kick();
              return;
            }
            done("云桥上没有在线的 relay（电脑端离线）");
            return;
          }
          const changed = pick.dev !== rd || (!!pick.rk && pick.rk !== rk);
          rd = pick.dev;
          rk = pick.rk || rk;
          bc = false; // 拿到确定目标即回单播路径
          // 无条件立即发 pair_req（relay 幂等，多发无害）——别让首次发现也干等一拍
          sendPairReq();
          if (changed) kick();
          return;
        }
        if (!f.data) return;
        // 明文 nack（无 n 字段）：码无效/过期——relay 不知道我方公钥无法加密。
        // 广播态忽略：新 relay 未持码时静默、旧 relay 的密文 nack 此处本就解不开，
        // 真到得了明文 nack 的只有单播态
        if (typeof f.data === "object" && (f.data as { t?: unknown }).t === "pair_nack" && (f.data as { n?: unknown }).n === undefined) {
          if (!rd) return;
          const err = (f.data as { error?: unknown }).error;
          done(typeof err === "string" && err ? `配对失败：${err}` : "配对码无效或已过期");
          return;
        }
        // 广播态不知道 ack 由哪台 relay 密封（rk 未知），拿候选公钥逐个试解
        let inner: { t?: string; relay_dev?: string; relay_pubkey?: string; error?: string } | null =
          rk ? unseal(f.data as SealedBox, rk, keys.secretKey) : null;
        if (!inner && !rd) {
          for (const c of cands) {
            inner = unseal(f.data as SealedBox, c.rk, keys.secretKey);
            if (inner) break;
          }
        }
        if (!inner) return;
        if (inner.t === "pair_ack" && inner.relay_dev && inner.relay_pubkey) {
          // 身份比对（与网页端同款）：能解开封 ≠ 目标 relay（公共桥假 relay 可自演自唱），
          // 回执身份须与配对目标一致，错位丢弃；广播态无 rd 可比，至少要求 ack 来自
          // 发现列表内的 relay（只有桥上 rl- 收得到广播）
          if (rd && inner.relay_dev !== rd) return;
          if (!rd && !cands.some((c) => c.dev === inner!.relay_dev)) return;
          done({ rd: inner.relay_dev, rk: inner.relay_pubkey, dev });
          return;
        }
        if (inner.t === "pair_nack") {
          // 广播态的密文 nack 全是噪音：未持码 relay（含旧版）的例行拒绝，不是错码
          if (!rd) return;
          done(inner.error ? `配对失败：${inner.error}` : "配对失败，请重新领码");
        }
      };
    });
  }

  // 配对成功后的统一落库：桥地址即条目地址（纯云源，无 LAN 前置），cloud 携全量
  // 身份（rd/rk/dev），connectServer 负责落盘 + 设活动指针 + 立即建连
  private async saveCloudEntry(
    bridge: string, bt: string, id: string | undefined, r: { rd: string; rk: string; dev: string },
  ): Promise<string | null> {
    // #26：扫码接入新源时若单源模式，自动转聚合——旧实现 connectServer 单源切源会
    // 同步拆掉原活动源（家里被下线，用户实测）。扫码接入的本质是"多加一台电脑"，
    // 多源并存才是预期；聚合开启后 connectServer 不再拆其他源
    if (!id && !this.aggregate) {
      const list = await this.readServers();
      if (list.length > 0) {
        await AsyncStorage.setItem("cc.display.aggregate", "1");
        this.aggregate = true;
      }
    }
    try {
      await this.connectServer({
        id: id ?? uuid(),
        name: hostOf(bridge),
        wsUrl: bridge,
        token: bt,
        cloud: {
          url: bridge,
          token: bt,
          relayDev: r.rd,
          relayPubkey: r.rk,
          dev: r.dev,
        },
      });
      return null;
    } catch {
      return "已配对，但连接失败（稍后自动重连）";
    }
  }

  // #330 云源扫码接入：扫电脑端 ccdeck-add 码——码里已带桥地址/桥 token/relay 身份
  //（rd/rk），pairViaBridge 配对后落成云源条目自动连接。
  // 返回 null=成功；字符串=错误文案（码错/过期 relay 回 pair_nack）
  async addCloudByInvite(inv: {
    bridge: string; bt: string; rd: string; rk: string; code: string;
  }): Promise<string | null> {
    const r = await this.pairViaBridge({
      bridge: inv.bridge, bt: inv.bt, code: inv.code, rd: inv.rd, rk: inv.rk,
    });
    if (typeof r === "string") return r;
    return this.saveCloudEntry(inv.bridge, inv.bt, undefined, r);
  }

  // 纯远程添加云桥（无「同一 WiFi」前置）：手机直接填桥地址 + 电脑端 CC Deck 领取的 6 位配对码。
  // rd/rk 未知 → pairViaBridge 先向桥发现在线 relay 身份。reuseId = 编辑模式复用既有
  // 条目（原 id 整条替换，不另起新条目）。返回 null=成功；字符串=错误文案
  async addCloudManual(bridge: string, bt: string, code: string, reuseId?: string): Promise<string | null> {
    const r = await this.pairViaBridge({ bridge, bt, code });
    if (typeof r === "string") return r;
    return this.saveCloudEntry(bridge, bt, reuseId, r);
  }

  private onEvent(conn: SourceConn, msg: Envelope) {
    const sid = msg.session_id;
    switch (msg.type) {
      case "SNAPSHOT": {
        // relay_dev（云桥设备 id，云桥启用的 relay 随快照下发，LAN/云通道均携）：
        // 盖章本源条目身份并按身份归并同机重复条目——先归并再装配会话（合并可能
        // 销毁别的源连接，须在 conn.sessions 清空重建前发起）
        const relayDev = (msg.payload as { relay_dev?: unknown } | undefined)?.relay_dev;
        if (typeof relayDev === "string" && relayDev) this.learnRelayDev(conn, relayDev);
        // F7 手表凭据 dev：仅云桥启用的 relay 携带；LAN/云快照同源同值，学到即存
        const wanDev = (msg.payload as { wan_dev?: unknown } | undefined)?.wan_dev;
        if (typeof wanDev === "string" && wanDev) conn.wanDev = wanDev;
        for (const old of conn.sessions.keys()) {
          if (this.sidIndex.get(old) === conn) this.sidIndex.delete(old);
        }
        conn.sessions.clear();
        conn.timelines.clear();
        // #388 模型清单随快照携带（旧版 relay 无此字段 = 空表，UI 藏入口）
        conn.models = Array.isArray(msg.payload.models)
          ? msg.payload.models.filter((m: unknown): m is string => typeof m === "string" && !!m)
          : [];
        for (const s of msg.payload.sessions as SessionState[]) {
          conn.sessions.set(s.session_id, s);
          conn.timelines.set(s.session_id, msg.payload.logs[s.session_id] ?? []);
          this.sidIndex.set(s.session_id, conn);
        }
        conn.lastSeq = Math.max(conn.lastSeq, msg.seq);
        this.recoverTaskDone(msg.payload.sessions as SessionState[]);
        break;
      }
      case "SESSION_CREATED": {
        conn.sessions.set(sid, {
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
        conn.timelines.set(sid, []);
        this.sidIndex.set(sid, conn);
        this.pushLog(conn, sid, { ts: msg.ts, kind: "system", text: msg.payload.external ? "外部会话接入 (hooks)" : "会话创建" });
        break;
      }
      case "SESSION_UPDATED": {
        const s = conn.sessions.get(sid);
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
        // 排队消息：已被 user_message 回显消费过的不再被状态帧灌回（#323 底部闪烁根因——
        // relay 侧 pending 直到 CLI 晋升才清，期间每个 WORKING 状态帧都会把本地刚删的条目复原）
        if (msg.payload.pending_inputs) {
          const eaten = this.consumedPending.get(sid);
          const list = eaten?.size
            ? msg.payload.pending_inputs.filter((p: { text?: string }) => !eaten.has((p.text ?? "").trim().replace(/\s+/g, " ").slice(0, 200)))
            : msg.payload.pending_inputs;
          s.pending_inputs = list.length ? list : undefined;
        }
        if (msg.payload.subagents) s.subagents = msg.payload.subagents;
        if (msg.payload.cron_tasks) s.cron_tasks = msg.payload.cron_tasks;
        if (msg.payload.compacting !== undefined) s.compacting = msg.payload.compacting;
        s.updated_at = msg.ts;
        break;
      }
      case "SESSION_HEARTBEAT": {
        const s = conn.sessions.get(sid);
        if (!s) break;
        s.elapsed_hint = msg.payload.elapsed_ms;
        break;
      }
      case "SESSION_WAITING": {
        const s = conn.sessions.get(sid);
        if (!s) break;
        s.status = "WAITING";
        s.waiting_request = { ...msg.payload, received_at: msg.ts };
        if (msg.payload.decidable !== false && this.onWaiting) this.onWaiting(s);
        break;
      }
      case "SESSION_WAITING_RESOLVED": {
        const s = conn.sessions.get(sid);
        if (!s) break;
        s.status = "WORKING";
        s.waiting_request = null;
        const d = msg.payload.decision;
        const dText = d === "allow" ? "已允许" : d === "deny" ? "已拒绝" : d === "answer" ? "已作答" : d === "answered" ? "电脑端已作答" : "远程审批超时，回退本地";
        this.pushLog(conn, sid, { ts: msg.ts, kind: "system", text: dText + (d === "timeout" ? "" : ` (by ${msg.payload.by})`) });
        break;
      }
      case "SESSION_ERROR": {
        const s = conn.sessions.get(sid);
        if (!s) break;
        s.status = "ERROR";
        s.last_error = msg.payload.message;
        this.pushLog(conn, sid, { ts: msg.ts, kind: "system", text: "错误: " + msg.payload.message });
        break;
      }
      case "SESSION_DONE": {
        const s = conn.sessions.get(sid);
        if (!s) break;
        s.status = "DONE";
        s.done_reason = msg.payload.terminal_reason;
        s.duration_ms = msg.payload.duration_ms;
        if (msg.payload.stats) s.stats = msg.payload.stats;
        this.pushLog(conn, sid, { ts: msg.ts, kind: "system", text: `完成: ${msg.payload.terminal_reason} · ${(msg.payload.duration_ms / 1000).toFixed(1)}s` });
        break;
      }
      case "SESSION_LOG": {
        if (msg.payload.kind === "user_message") this.consumePendingByUserMsg(conn, sid, msg.payload.text ?? "");
        this.pushLog(conn, sid, msg.payload);
        break;
      }
      case "TASK_DONE": {
        const s = conn.sessions.get(sid);
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
        conn.sessions.delete(sid);
        conn.timelines.delete(sid);
        if (this.sidIndex.get(sid) === conn) this.sidIndex.delete(sid);
        break;
      }
      // #316 手表配对（瞬态帧，不落 seq 账本）：请求 → 全局弹窗比对 6 位码；
      // 结果（allow/deny/timeout，含手表放弃断开）→ 收弹窗
      case "PAIR_REQUEST": {
        const p = msg.payload as { request_id?: unknown; name?: unknown; code?: unknown; expires_in?: unknown };
        if (typeof p.request_id === "string" && typeof p.code === "string" && /^\d{6}$/.test(p.code)) {
          const rid = p.request_id;
          this.emit({
            watchPair: {
              requestId: rid,
              name: typeof p.name === "string" ? p.name.slice(0, 24) : "手表",
              code: p.code,
              sourceId: conn.entry.id,
            },
          });
          // 本地过期兜底：瞬态帧不重放，断线瞬间的 PAIR_RESOLVED 丢了弹窗会滞留——
          // 到 relay 给的过期时间自行收起（只清同 id，新请求顶旧计时）
          const ttl = typeof p.expires_in === "number" ? p.expires_in * 1000 : 120_000;
          setTimeout(() => {
            if (this.snap.watchPair?.requestId === rid) this.emit({ watchPair: null });
          }, ttl + 3000);
        }
        break;
      }
      case "PAIR_RESOLVED": {
        const p = msg.payload as { request_id?: unknown };
        // 严格匹配当前弹窗才清：畸形帧（缺 request_id）不响应，别的请求的结果不误伤
        if (typeof p.request_id === "string" && this.snap.watchPair?.requestId === p.request_id) {
          this.emit({ watchPair: null });
        }
        break;
      }
      // 议题①（2026-09-09）配对设备变更（瞬态帧，seq:0 不补发）：add = 新设备获得
      // 全权的瞬间，回调通知持有者；kick = 管理员移除设备，手机端无需动作
      case "PAIRED_DEVICE": {
        const p = msg.payload as { dev?: unknown; name?: unknown; action?: unknown };
        if (p.action === "add" && typeof p.dev === "string" && p.dev) {
          this.onPairedDevice?.({ dev: p.dev, name: typeof p.name === "string" ? p.name : "" });
        }
        break;
      }
    }
  }

  // 兜底：user_message 晋升日志到达时本地移除被覆盖的排队条目
  // （正常路径靠 SESSION_UPDATED.pending_inputs 清空；该帧丢失/旧版 relay 不发时由此兜底，
  // 排队气泡才不会在消息已处理后一直闪烁）
  private consumePendingByUserMsg(conn: SourceConn, sid: string, text: string) {
    const s = conn.sessions.get(sid);
    if (!s?.external || !s.pending_inputs?.length) return;
    const key = text.trim().replace(/\s+/g, " ");
    if (!key) return;
    const eaten = this.consumedPending.get(sid) ?? new Set<string>();
    const kept = s.pending_inputs.filter((p) => {
      const pk = (p.text ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
      if (pk && key.includes(pk)) {
        eaten.add(pk);
        return false;
      }
      return true;
    });
    if (eaten.size) {
      if (eaten.size > 60) for (const k of eaten) { eaten.delete(k); break; } // 粗截断防膨胀
      this.consumedPending.set(sid, eaten);
    }
    if (kept.length !== s.pending_inputs.length) {
      s.pending_inputs = kept.length ? kept : undefined;
      this.emit();
    }
  }

  // 时间线不可变更新：数组引用一变，渲染层的 useMemo/依赖比较才能感知新条目
  private pushLog(conn: SourceConn, sid: string, entry: LogEntry) {
    const list = conn.timelines.get(sid) ?? [];
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
        conn.timelines.set(sid, next);
        return;
      }
    }
    const next = [...list, e];
    if (next.length > 500) next.splice(0, next.length - 500);
    conn.timelines.set(sid, next);
  }

  // 当前连接参数（slash 联想 fetch /api/commands 等只读 HTTP 端点用）：活动源口径
  get connInfo(): { wsUrl: string; token: string } | null {
    const conn = this.activeConn();
    return conn?.cfg ? { ...conn.cfg } : null;
  }

  // 按源查连接参数与通道（#294 审查修复）：slash 联想等按"会话所属源"取数，
  // 不再一律走活动源口径（聚合下活动源走云时会误判会话源不可拉命令表）；
  // 源未知/从未建连（无 cfg）返回 null
  sourceInfoOf(srcId: string): { wsUrl: string; token: string; channel: "lan" | "cloud" | null; cloudUrl?: string; cloudToken?: string; relayDev?: string; wanDev?: string } | null {
    const conn = this.conns.get(srcId);
    if (!conn?.cfg) return null;
    const c = conn.cloudCfg;
    return {
      wsUrl: conn.cfg.wsUrl, token: conn.cfg.token, channel: conn.channel,
      ...(c ? { cloudUrl: c.url, cloudToken: c.token, relayDev: c.relayDev } : {}),
      ...(conn.wanDev ? { wanDev: conn.wanDev } : {}),
    };
  }

  // 命令路由（#294 批1/批3）：按 payload.session_id 经 sidIndex 定位源（sid 为 uuid
  // 全局唯一，可作跨源主键）——会话命令永远发往该会话的源，不改协议；无 sid 时取
  // 显式 sourceId（批3 新建会话选目标源），再退活动源（COMMAND_CREATE / PAIR_*）。
  // ACK 追踪按源隔离（pendingCmds 在 conn 上）：超时重发同源同 command_id，
  // relay 幂等去重兜底，不跨源串扰。onAck（0.4.4）：需要结果语义的调用方注入
  send(type: string, payload: Record<string, unknown>, sourceId?: string, onAck?: (r: { ok: boolean; err: string | null }) => void): boolean {
    const sid = typeof payload.session_id === "string" ? (payload.session_id as string) : null;
    // sid 已给但 sidIndex 未命中（#294 审查修复：会话已删/所属源换目标清缓存）：
    // 明确报"会话不存在"，不再回落活动源——回落会把命令发给另一台服务器
    if (sid && !this.sidIndex.has(sid)) {
      this.emit({ lastErrorCmd: "会话不存在，命令未发送" });
      return false;
    }
    const conn =
      (sid ? this.sidIndex.get(sid) : undefined) ??
      (sourceId ? this.conns.get(sourceId) : undefined) ??
      this.activeConn();
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      this.emit({ lastErrorCmd: "未连接，命令未发送" });
      return false;
    }
    const cmd = { command_id: uuid(), type, payload, ts: Date.now() };
    const wire = (): boolean => {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return false;
      if (conn.channel === "cloud" && conn.cloudCfg && this.devKeys) {
        conn.ws.send(
          JSON.stringify({
            to: conn.cloudCfg.relayDev,
            data: seal(cmd, conn.cloudCfg.relayPubkey, this.devKeys.secretKey),
          }),
        );
      } else {
        conn.ws.send(JSON.stringify(cmd));
      }
      return true;
    };
    const id = cmd.command_id;
    const entry: PendingCmd = {
      type,
      tries: 0,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      wire,
      ...(onAck ? { onAck } : {}),
    };
    entry.timer = setTimeout(() => this.onCmdTimeout(conn, id), ACK_TIMEOUT_MS);
    conn.pendingCmds.set(id, entry);
    return true;
  }

  // 回执超时：先重发一次同 id（幂等）；再超时才报失败。连接中途断开由 disconnect 清场
  private onCmdTimeout(conn: SourceConn, id: string) {
    const p = conn.pendingCmds.get(id);
    if (!p) return;
    if (p.tries === 0 && p.wire()) {
      p.tries = 1;
      p.timer = setTimeout(() => this.onCmdTimeout(conn, id), ACK_RETRY_TIMEOUT_MS);
      return;
    }
    conn.pendingCmds.delete(id);
    if (p.onAck) {
      try { p.onAck({ ok: false, err: "服务器未确认，可能未送达" }); } catch {}
    }
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

  // #306 待确认已读：调用方把当前已读指纹集合（U+0001 分隔）拼好传入——逐条 ✕
  // 与"全部已读"都走这里；条目数据变化后指纹不匹配自动重现
  dismissConfirm(key: string) {
    if (this.snap.confirmDismissedKey === key) return;
    this.emit({ confirmDismissedKey: key });
  }
}

export const store = new RelayStore();

// 单源模式连接文案（conn.state → connText，逐字保持旧版语义；unpaired 新增）
function singleConnText(c: SourceConn): string {
  switch (c.state) {
    case "online":
      // #37 云通道指示去 emoji：文案统一「已连接」，云图标（线条云）由连接 chip 呈现
      return "已连接";
    case "connecting": return "连接中";
    case "reconnecting": return "重连中"; // stateText 缺失时的兜底（理论不达）
    case "offline": return "已断开";
    case "unpaired": return "未配对"; // stateText 常态已有「未配对」，此为兜底
    default: return "未配置";
  }
}

// 弃用旧 socket 统一走这里（#291 泄漏根因）：RN Android 原生侧只把已完成 onOpen 的
// socket 登记进连接表，CONNECTING 期调 close() 是静默 no-op——握手照样完成，旧连接
// 开门后无人再关，表现为切源后双连接并存、旧连接持续收事件。除立即 close 外，
// 摘掉全部 handlers，并留一个「晚开门就补刀」的 onopen 哨兵（届时已在原生表内，close 生效）
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

// ---------- 服务器条目归并（#398 同目标写法归并 + #401 补强同源身份归并） ----------

// wsUrl → LAN 目标（host 归一化：localhost / ::1 / [::1] 与 127.0.0.1 视为同一回环；
// 端口缺省按协议补齐，ws://x 与 ws://x:80 等价）。解析失败返回 null（不可比）
function lanTargetOf(wsUrl: string): { host: string; port: string } | null {
  try {
    const u = new URL(wsUrl);
    const host =
      u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]"
        ? "127.0.0.1"
        : u.hostname;
    return { host, port: u.port || (u.protocol === "wss:" ? "443" : "80") };
  } catch {
    return null;
  }
}

// 条目的 relay 身份：云桥配对 id 优先（配对即证明），LAN 直连标记（SNAPSHOT
// relay_dev 学到，见 ServerEntry.relayDev 注释）次之。两者同源同值——relay 设备
// id 全局唯一，等价即可断定同一台 relay（跨 LAN/云桥双条目合并的密码学依据）
function identityOf(e: ServerEntry): string | null {
  return e.cloud?.relayDev || e.relayDev || null;
}

// 内网直连地址（身份探测/归并取 LAN 写法用）：RFC1918 + 回环 + localhost
function isLanUrl(wsUrl: string): boolean {
  return /^wss?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/i.test(wsUrl);
}

// 两个条目是否指向同一台服务器（名称不参与——同机改名/换写法仍算重复）：
// - 双方身份已知（云桥配对或 LAN 标记）→ relay 设备 id 相同即同源（最强证据）
// - 否则按 LAN 口径：wsUrl 的 host+port 相同（回环三写法归一后比较）
// - 一方只有 LAN、另一方只有云桥：无法证明同一台机器，不算等价（宁漏勿误删；
//   LAN 条目连上/被探测拿到标记后，connectServer/启动清理即能并掉）
function sameTargetEntry(a: ServerEntry, b: ServerEntry): boolean {
  const rdA = identityOf(a);
  const rdB = identityOf(b);
  if (rdA && rdB) return rdA === rdB;
  const la = lanTargetOf(a.wsUrl);
  const lb = lanTargetOf(b.wsUrl);
  return !!la && !!lb && la.host === lb.host && la.port === lb.port;
}

// 同源身份归并（规则化，无论条目何时产生；加载/快照/探测三处执行）：identityOf
// 相同的条目合一。幸存者优先级 = preferId 命中（在线方，保连接/会话连续）> 已配对
// 云桥者 > 组内先出现。字段合成：wsUrl/token 取 LAN 直连写法（同一 WiFi 下走 LAN 低延迟，
// 跨网落云通道——桥地址条目的 wsUrl 本探不了 LAN）；cloud 取幸存者优先的组内
// 首个非空；幸存者名是自动 host 名而组内另有具名时取具名。remap 记录被并条目
// id → 幸存者 id；无归并时原样返回同一引用（调用方据此跳过落盘）
function mergeByIdentity(list: ServerEntry[], preferId?: string | null): { list: ServerEntry[]; remap: Map<string, string> } {
  const remap = new Map<string, string>();
  const survivorOf = new Map<string, ServerEntry>();
  const dropped = new Set<string>();
  const groups = new Map<string, ServerEntry[]>();
  for (const e of list) {
    const id = identityOf(e);
    if (!id) continue;
    const g = groups.get(id);
    if (g) g.push(e);
    else groups.set(id, [e]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const prefer =
      (preferId ? g.find((e) => e.id === preferId) : undefined) ??
      g.find((e) => !!e.cloud) ??
      g[0];
    const lanSrc = isLanUrl(prefer.wsUrl) ? prefer : g.find((e) => isLanUrl(e.wsUrl)) ?? prefer;
    const cloud = prefer.cloud ?? g.find((e) => e.cloud)?.cloud ?? null;
    const autoNamed = !prefer.name || prefer.name === hostOf(prefer.wsUrl);
    const named = autoNamed ? g.find((e) => e.name && e.name !== hostOf(e.wsUrl)) : undefined;
    survivorOf.set(prefer.id, {
      ...prefer,
      name: named?.name ?? prefer.name,
      wsUrl: lanSrc.wsUrl,
      token: lanSrc.token,
      cloud,
      relayDev: identityOf(prefer),
    });
    for (const e of g) {
      if (e.id === prefer.id) continue;
      dropped.add(e.id);
      remap.set(e.id, prefer.id);
    }
  }
  if (!dropped.size) return { list, remap };
  const out: ServerEntry[] = [];
  for (const e of list) {
    if (dropped.has(e.id)) continue;
    out.push(survivorOf.get(e.id) ?? e);
  }
  return { list: out, remap };
}

// 启动归并清理：同目标重复条目只保留先出现的（列表序稳定），后出现的 token/cloud
// 补进幸存者（幸存者已有值不覆盖）后丢弃。remap 记录被并条目 id → 幸存者 id，
// 供调用方修正 ccr_active 指针；无重复时原样返回同一引用（调用方据此跳过落盘）
function dedupeServers(list: ServerEntry[]): { list: ServerEntry[]; remap: Map<string, string> } {
  const out: ServerEntry[] = [];
  const remap = new Map<string, string>();
  for (const e of list) {
    const hit = out.find((x) => sameTargetEntry(x, e));
    if (!hit) {
      out.push(e);
      continue;
    }
    remap.set(e.id, hit.id);
    if (!hit.token) hit.token = e.token;
    if (!hit.cloud) hit.cloud = e.cloud ?? null;
  }
  return { list: out.length === list.length ? list : out, remap };
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
