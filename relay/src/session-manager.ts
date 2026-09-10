import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { devId } from "./e2e.js";
import type { EventBus } from "./event-bus.js";
import { AgentSession } from "./agent-adapter.js";
import type { RelayConfig } from "./config.js";
import type { ReplayedSession } from "./history.js";
import { deriveTitle } from "./history.js";
import { generateTitle } from "./title-gen.js";
import { cronTasksKey, readCronTasks } from "./cron.js";
import { readTaskStoreTodos } from "./task-store.js";
import { normKey, truncate } from "./summarizer.js";
import type { AgentLike } from "./agent-adapter.js";

// 上下文窗口上限按模型区分：集中在此维护并随 context_usage 下发，客户端不存映射表
function contextLimitOf(model: string | undefined): number {
  const m = (model || "").toLowerCase();
  if (/glm[-_]?5/.test(m)) return 1_000_000; // GLM-5.x 系列 1M 窗口
  return 200_000;
}
import { addHiddenTodoKey, hiddenTodoKeys } from "./todo-hidden.js";
import type {
  AgentCallbacks,
} from "./agent-adapter.js";
import type {
  Command,
  CommandAckPayload,
  FileChangeStats,
  LogEntry,
  ManagedPermissionMode,
  PendingInput,
  PeerMeta,
  SessionState,
  SubagentInfo,
  TodoItem,
  TokenUsage,
  WaitingPayload,
  ImportPushEntry,
} from "./types.js";

function isManagedMode(m: unknown): m is ManagedPermissionMode {
  return m === "default" || m === "acceptEdits" || m === "plan";
}

// COMMAND_IMPORT_PUSH 条目校验（relay 不解释语义，只卡形状与尺寸——条目含令牌，
// 长度上限压到防滥用档；cloud 子对象是出码端 pair 所需的全套身份，字段齐才放行）
function sanitizeImportPushEntry(raw: unknown): ImportPushEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const kind = e.kind === "cloud" ? "cloud" : e.kind === "lan" ? "lan" : null;
  if (!kind) return null;
  const wsUrl = typeof e.wsUrl === "string" ? e.wsUrl : "";
  if (!/^wss?:\/\/.{3,200}$/.test(wsUrl)) return null;
  const token = typeof e.token === "string" ? e.token.slice(0, 200) : "";
  if (kind === "lan" && !token) return null;
  let cloud: ImportPushEntry["cloud"];
  if (kind === "cloud") {
    const c = (e.cloud && typeof e.cloud === "object" ? e.cloud : null) as Record<string, unknown> | null;
    if (!c) return null;
    const url = typeof c.url === "string" ? c.url : "";
    const bt = typeof c.token === "string" ? c.token : "";
    const rd = typeof c.rd === "string" ? c.rd : "";
    const rk = typeof c.rk === "string" ? c.rk : "";
    if (!/^(wss?|https?):\/\//.test(url) || !bt || !rd.startsWith("rl-") || rk.length < 40) return null;
    cloud = {
      url: url.slice(0, 200),
      token: bt.slice(0, 200),
      rd: rd.slice(0, 40),
      rk: rk.slice(0, 100),
      paired: true,
      ...(typeof c.code === "string" && /^\d{6,8}$/.test(c.code) ? { code: c.code } : {}),
    };
  }
  return { kind, wsUrl, ...(token ? { token } : {}), ...(cloud ? { cloud } : {}) };
}

// #293 新增会话工作目录三级回落：手机指定目录 → 默认目录（CCR_CWD）→ 用户主目录。
// 目录校验必须 try/catch：目录不存在/不可访问时 statSync 直接抛 ENOENT，旧实现裸调
// 把 errno 原文抛给手机端（Mac 源启动目录失效时"新增会话"必失败且提示不可读）。
// 未配置或校验失败一律回落 homedir（跨平台）并返回人话说明；完全无可用目录时
// cwd 返回空串，由调用方把说明当错误上屏（含建议值）。
export function resolveCreateCwd(
  rawCwd: string,
  defaultCwd: string,
): { cwd: string; fallbackNote: string } {
  const isUsableDir = (p: string): boolean => {
    if (!p) return false;
    try {
      return statSync(p).isDirectory();
    } catch {
      return false; // 不存在/无权访问/非目录：一律视为不可用
    }
  };

  const wanted = (rawCwd || "").trim() || (defaultCwd || "").trim();
  if (wanted) {
    const abs = resolve(wanted);
    if (isUsableDir(abs)) return { cwd: abs, fallbackNote: "" };
  }

  const home = homedir();
  const wantedDesc = wanted
    ? `指定的工作目录 ${resolve(wanted)} 不是有效目录（不存在或无法访问）`
    : "未指定工作目录，且默认目录未配置（CCR_CWD）";
  const suggest =
    '如需固定工作目录，请设置 CCR_CWD 环境变量指向实际项目目录（如 Windows "D:\\projects\\myapp"、macOS/Linux "~/projects/myapp"）后重启 relay';
  if (isUsableDir(home)) {
    return {
      cwd: home,
      fallbackNote: `${wantedDesc}，本次已回落用户主目录 ${home}。${suggest}`,
    };
  }
  return {
    cwd: "",
    fallbackNote: `${wantedDesc}，用户主目录 ${home} 也无法访问，无法创建会话。请在手机端填写有效的工作目录。${suggest}`,
  };
}

const PERM_MODE_ZH: Record<ManagedPermissionMode, string> = {
  default: "标准（每次确认）",
  acceptEdits: "自动接受编辑",
  plan: "规划（只读）",
};

// 图片消息清洗：最多 4 张、单张 8MB base64，剔除非法项
function sanitizeImages(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 8 * 1024 * 1024);
  return list.length > 0 ? list.slice(0, 4) : undefined;
}

// relay 自拉的一次性 SDK 子会话记录（标题生成等），持久化到 <dataDir>/child-sessions.json；
// 孤儿扫描（bridge.adoptOrphans）必须跳过这些 CLI session_id，否则被误收养成垃圾外部会话
const CHILD_SESSIONS_CAP = 200;

function readChildSessions(dataDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "child-sessions.json"), "utf-8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function appendChildSession(dataDir: string, sid: string): void {
  const list = readChildSessions(dataDir);
  if (list.includes(sid)) return;
  list.push(sid);
  try {
    writeFileSync(join(dataDir, "child-sessions.json"), JSON.stringify(list.slice(-CHILD_SESSIONS_CAP)));
  } catch {}
}

// 手机端删除过的外部会话 id：孤儿扫描的墓碑。没有它，transcript 还新鲜（30 分钟内）
// 的已删会话会在下一轮扫描被重新收养，删除永远不生效
function readDeletedExts(dataDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "deleted-ext.json"), "utf-8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function appendDeletedExt(dataDir: string, id: string): void {
  const list = readDeletedExts(dataDir);
  if (list.includes(id)) return;
  list.push(id);
  try {
    writeFileSync(join(dataDir, "deleted-ext.json"), JSON.stringify(list.slice(-300)));
  } catch {}
}

// #49 置顶会话清单：写穿 data/pinned-sessions.json（relay session_id 数组）。
// 置顶 = 跨重启保留：重启后 applyPinned 把清单内托管会话登记为休眠（saved，
// 可见不可操作），用户点卡片发 COMMAND_RESUME_SESSION 才用 transcript resume 拉起
const PINNED_SESSIONS_CAP = 50;

function pinnedSessionsPath(dataDir: string): string {
  return join(dataDir, "pinned-sessions.json");
}

function readPinnedSessions(dataDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(pinnedSessionsPath(dataDir), "utf-8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writePinnedSessions(dataDir: string, ids: string[]): void {
  try {
    writeFileSync(pinnedSessionsPath(dataDir), JSON.stringify(ids.slice(-PINNED_SESSIONS_CAP)));
  } catch {} // 写穿失败静默降级：置顶只影响重启后的休眠登记，运行期状态不受影响
}

interface ManagedSession {
  agent: AgentLike | null;      // null = Relay 重启遗留的历史会话，不可操作
  state: SessionState;
  logs: LogEntry[];             // 供 SNAPSHOT 下发的时间线
  lastUpdateEmit: number;
}

const UPDATE_THROTTLE_MS = 2000;   // 同状态下的 SESSION_UPDATED 节流
const HEARTBEAT_INTERVAL_MS = 5000;
const CRON_POLL_INTERVAL_MS = 30_000; // 定时任务文件轮询（无官方文件监听事件，读文件足够便宜）
const MAX_SESSIONS = 20;

// #408 SNAPSHOT 大帧根治（2026-09-09 事故）：客户端 last_seq 落到事件缓冲窗外走
// 全量 SNAPSHOT，此前 LAN 快照把全部时间线日志塞单帧（随历史线性膨胀，实测 3 会话
// 0.63MiB）、云通道瘦身后逐条密文流式（数千帧洪峰触发 CF 桥限流踢线 → 重连 →
// auto-resume 再补 → 自喂养断连死循环；CF Workers ws 另有 1MiB 单帧硬限）。
// 修法：LAN 与云共用同一预算装配——每会话只带最近 perSessionCap 条，且全帧日志
// JSON 总量 ≤ budgetBytes。512KB 明文 → seal 后 base64 ≈ 4/3 膨胀 ~700KB，连同
// sessions/信封余量充足（<900KB）；条数与字节双帽保证历史再大单帧也确定性有界。
const SNAPSHOT_LOGS_BUDGET_BYTES = 512 * 1024;
const SNAPSHOT_LOGS_PER_SESSION = 50;

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  // 幂等去重存首次回执（0.4.4 起）：旧实现重复固定回 ok:true——失败后的同 id 重试
  //（ACK 丢失重发等）会拿到假成功；缓存真实结果重放，语义对全部命令成立
  private processedCommands = new Map<string, CommandAckPayload>();
  private titleRequested = new Set<string>();   // 已请求过自动命名的会话
  // relay 自拉的一次性 SDK 子会话（标题生成）的 CLI session_id：
  // 无 hook 但 transcript 活跃，孤儿扫描必须排除，否则被误收养成垃圾外部会话
  private childSdkIds: Set<string>;
  private deletedExtIds: Set<string>;

  /** #388 供 ws-server 读默认模型（快照 payload.models 聚合用） */
  readonly cfg: RelayConfig;

  // #49 测试缝：托管 AgentSession 工厂。生产恒为 null（直接 new AgentSession，
  // 行为与从前逐字节一致）；test-bridge/test-cloud 注入假 agent 验证置顶/按需恢复
  // 与休眠登记路径，免拉真 CLI 子进程
  private agentFactory: ((cwd: string, model: string, cb: AgentCallbacks, initialPrompt: string | undefined, opts?: { resume?: string; permissionMode?: ManagedPermissionMode; images?: string[] }) => AgentLike) | null = null;

  setAgentFactory(
    fn: ((cwd: string, model: string, cb: AgentCallbacks, initialPrompt: string | undefined, opts?: { resume?: string; permissionMode?: ManagedPermissionMode; images?: string[] }) => AgentLike) | null,
  ): void {
    this.agentFactory = fn;
  }

  private newAgent(
    cwd: string,
    model: string,
    cb: AgentCallbacks,
    initialPrompt: string | undefined,
    opts?: { resume?: string; permissionMode?: ManagedPermissionMode; images?: string[] },
  ): AgentLike {
    return this.agentFactory
      ? this.agentFactory(cwd, model, cb, initialPrompt, opts)
      : new AgentSession(cwd, model, cb, initialPrompt, opts);
  }

  constructor(
    private bus: EventBus,
    cfg: RelayConfig,
  ) {
    this.cfg = cfg;
    this.childSdkIds = new Set(readChildSessions(cfg.dataDir));
    this.deletedExtIds = new Set(readDeletedExts(cfg.dataDir));
    const t = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    t.unref();
    const c = setInterval(() => {
      this.pollCronTasks();
      this.pollTaskStore();
    }, CRON_POLL_INTERVAL_MS);
    c.unref();
  }

  // 该 CLI session_id 是否归 relay 自己管（托管会话的 relay_session_id / 一次性子会话）
  ownsCliSession(cliSid: string): boolean {
    if (this.childSdkIds.has(cliSid)) return true;
    for (const s of this.sessions.values()) if (s.state.relay_session_id === cliSid) return true;
    return false;
  }

  isDeletedExt(id: string): boolean {
    return this.deletedExtIds.has(id);
  }

  snapshot(): SessionState[] {
    return [...this.sessions.values()].map((s) => this.cloneState(s));
  }

  // 自动命名：一次轻量模型调用把首条 prompt 变成短标题（托管/外部会话通用）
  // CC 自带的 session name 在本环境基本不生成，这里兜底；已有 CC 名时外部会话由 bridge 跳过
  requestSmartTitle(sessionId: string, task: string): void {
    if (process.env.CCR_NO_TITLE_GEN === "1") return;
    if (this.titleRequested.has(sessionId)) return;
    this.titleRequested.add(sessionId);
    // 子会话 cwd 指到数据目录下的 .tmp-titlegen：转录不落用户项目区（.tmp- 前缀段
    // 被 bridge 孤儿扫描/事件双护栏排除，#283）
    const titleCwd = join(this.cfg.dataDir, ".tmp-titlegen");
    try { mkdirSync(titleCwd, { recursive: true }); } catch {}
    void generateTitle(task, this.cfg.model, (sid) => {
      // 子会话 id 一到手就登记（不等 result：超时丢 sid 会让孤儿扫描误收养它）
      this.childSdkIds.add(sid);
      appendChildSession(this.cfg.dataDir, sid);
    }, titleCwd).then(({ title: t }) => {
      if (!t) return;
      const s = this.sessions.get(sessionId);
      if (!s || s.state.title === t || s.state.title_locked) return;
      s.state.title = t;
      s.state.updated_at = Date.now();
      this.bus.emit(sessionId, "SESSION_UPDATED", {
        status: s.state.status,
        action_summary: s.state.action_summary,
        stats: { ...s.state.stats },
        title: t,
      });
    });
  }

  snapshotLogs(): Record<string, LogEntry[]> {
    const out: Record<string, LogEntry[]> = {};
    for (const [id, s] of this.sessions) out[id] = s.logs;
    return out;
  }

  // #408 快照日志预算装配（LAN ws-server 与云通道 cloud-client 共用，双端同语义）：
  // 每会话取最近 perSessionCap 条，总量超 budgetBytes 时优先从条目最多的会话逐条
  // 丢最旧（每会话保底 1 条），保证单帧确定性有界。返回被截断会话的省略条数——
  // 客户端时间线接受截断语义（无更早分页拉取通道），标记仅供 UI 提示用。
  buildSnapshotLogs(
    budgetBytes: number = SNAPSHOT_LOGS_BUDGET_BYTES,
    perSessionCap: number = SNAPSHOT_LOGS_PER_SESSION,
  ): { logs: Record<string, LogEntry[]>; logs_truncated: Record<string, number> } {
    const logs: Record<string, LogEntry[]> = {};
    const logsTruncated: Record<string, number> = {};
    // 每条字节量先算一次，预算裁剪纯算术推进，不反复整体序列化
    const kept: { id: string; entries: { e: LogEntry; b: number }[] }[] = [];
    let total = 0;
    for (const [id, s] of this.sessions) {
      const slice = s.logs.length > perSessionCap ? s.logs.slice(s.logs.length - perSessionCap) : s.logs;
      if (slice.length < s.logs.length) logsTruncated[id] = s.logs.length - slice.length;
      const entries = slice.map((e) => ({ e, b: Buffer.byteLength(JSON.stringify(e)) + 1 }));
      if (entries.length) {
        kept.push({ id, entries });
        total += entries.reduce((acc, x) => acc + x.b, 0);
      }
    }
    while (total > budgetBytes) {
      // 条目最多的会话先丢最旧一条：活跃会话（条目已被 K 帽截到同量级）相对公平
      let big: (typeof kept)[number] | null = null;
      for (const k of kept) if (k.entries.length > 1 && (!big || k.entries.length > big.entries.length)) big = k;
      if (!big) break; // 每会话只剩 1 条：物理下限（MAX_SESSIONS 条单条日志远小于预算）
      const dropped = big.entries.shift();
      if (!dropped) break;
      total -= dropped.b;
      logsTruncated[big.id] = (logsTruncated[big.id] ?? 0) + 1;
    }
    for (const k of kept) logs[k.id] = k.entries.map((x) => x.e);
    return { logs, logs_truncated: logsTruncated };
  }

  // Relay 重启后收养历史会话（agent 为空，仅展示不可操作）
  adopt(replayed: Map<string, ReplayedSession>): number {
    // 活跃度优先：按 updated_at 倒序收养，超出上限丢最久未动的
    //（按 started_at 会把"创建早但一直在用"的长期会话挤出去，重启即丢整条时间线）
    const entries = [...replayed.entries()].sort((a, b) => b[1].state.updated_at - a[1].state.updated_at);
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
    answerPending: (sessionId: string, requestId: string, answers: string[]) => string | null;
    extInput: (sessionId: string, text: string) => { ok: boolean; error?: string };
    extStop: (sessionId: string) => { ok: boolean; error?: string };
    refreshTodos: (sessionId: string) => { ok: boolean; error?: string };
    hideTodo: (sessionId: string, content: string) => { ok: boolean; error?: string };
  } | null = null;

  setBridge(b: {
    resolvePending: (sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string) => boolean;
    answerPending: (sessionId: string, requestId: string, answers: string[]) => string | null;
    extInput: (sessionId: string, text: string) => { ok: boolean; error?: string };
    extStop: (sessionId: string) => { ok: boolean; error?: string };
    refreshTodos: (sessionId: string) => { ok: boolean; error?: string };
    hideTodo: (sessionId: string, content: string) => { ok: boolean; error?: string };
  }): void {
    this.bridge = b;
  }

  // 云桥身份（index.ts 在云桥启用时注入；PAIR_START/PEERS 依赖）。meta 为 #42 设备
  // 自报身份元数据（可选，与 CloudIdentity.PeerEntry 对应字段同构）
  private cloud: {
    keypair: { publicKey: string };
    relayDev: string;
    peers: Map<string, { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number; last_seen?: number }>;
    addPeer: (dev: string, entry: { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number }) => void;
  } | null = null;

  setCloud(c: {
    keypair: { publicKey: string };
    relayDev: string;
    peers: Map<string, { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number; last_seen?: number }>;
    addPeer: (dev: string, entry: { pubkey: string; name?: string; meta?: PeerMeta; paired_at: number }) => void;
  }): void {
    this.cloud = c;
  }

  // 配对码签发器（index.ts 注入，与 /api/pair-code 同源）：COMMAND_PAIR_CODE 依赖。
  // opts.ttlMs = 按次长码（≤30min，pairing.ts 夹逼；F4）
  private pairIssuer: ((opts?: { ttlMs?: number }) => { code: string; expires_in: number }) | null = null;

  setPairIssuer(fn: (opts?: { ttlMs?: number }) => { code: string; expires_in: number }): void {
    this.pairIssuer = fn;
  }

  // 议题①踢除执行器（index.ts 注入：identity.removePeer + 各桥 CloudClient.kickPeer
  // 发 pair_nack 停其重连）：COMMAND_PEER_KICK 依赖
  private peerKicker: ((dev: string) => void) | null = null;

  setPeerKicker(fn: (dev: string) => void): void {
    this.peerKicker = fn;
  }

  // #325 扫码登录授权器（index.ts 注入，转发各云桥客户端 grantLogin）
  private loginGranter: ((dev: string, pubkey: string, name: string) => boolean) | null = null;
  // 0.4.4 跨网回传执行器（云层注册）：密封 payload 投给目标 dev，目标离线返回 false
  private importPusher: ((dev: string, pubkey: string, payload: Record<string, unknown>) => boolean) | null = null;

  setLoginGranter(fn: (dev: string, pubkey: string, name: string) => boolean): void {
    this.loginGranter = fn;
  }

  setImportPusher(fn: (dev: string, pubkey: string, payload: Record<string, unknown>) => boolean): void {
    this.importPusher = fn;
  }

  // 不存在则注册外部会话（bridge.ts 调用）；startedAt：真实起点（孤儿收养时取自
  // transcript 首条时间戳，#321——否则收养时刻会冒充会话时长起点，老会话显示 55s）
  ensureExternal(id: string, cwd: string, prompt: string, cliSessionId = "", startedAt = 0): SessionState {
    const existing = this.sessions.get(id);
    if (existing) {
      // Relay 重启后 adopt 为 historical 的外部会话：真实 hook 事件回来了，恢复可操作
      existing.state.historical = false;
      if (!existing.state.relay_session_id && cliSessionId) existing.state.relay_session_id = cliSessionId;
      return existing.state;
    }
    const state: SessionState = {
      session_id: id,
      relay_session_id: cliSessionId,
      cwd: cwd || process.cwd(),
      initial_prompt: prompt,
      title: prompt ? deriveTitle(prompt) : (cwd.split(/[\\/]/).pop() ?? "未命名会话") || "未命名会话",
      model: "",
      status: "WORKING",
      action_summary: prompt ? truncate(prompt, 40) : "接入中",
      started_at: startedAt || Date.now(),
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
      started_at: state.started_at,
    });
    return state;
  }

  getExternal(id: string): SessionState | undefined {
    return this.sessions.get(id)?.state;
  }

  setExternalStatus(id: string, status: SessionState["status"], summary: string, turnStartedAt?: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const changed = s.state.status !== status;
    s.state.status = status;
    s.state.action_summary = summary;
    if (status === "WORKING" && turnStartedAt) s.state.turn_started_at = turnStartedAt;
    s.state.updated_at = Date.now();
    if (changed || status === "WORKING") {
      this.bus.emit(id, "SESSION_UPDATED", {
        status,
        action_summary: summary,
        stats: { ...s.state.stats },
        ...(s.state.turn_started_at ? { turn_started_at: s.state.turn_started_at } : {}),
        historical: !!s.state.historical,
      });
    }
  }

  // #363 上下文压缩状态：PreCompact 置位（压缩期转录静默，端上据此区分"卡死"与
  // "压缩中"）；8 分钟兜底自动清——清位事件丢失时不永久卡标志
  setExternalCompacting(id: string, on: boolean): void {
    const s = this.sessions.get(id);
    if (!s || s.state.compacting === on) return;
    s.state.compacting = on;
    s.state.updated_at = Date.now();
    if (on) {
      const t = setTimeout(() => {
        if (s.state.compacting) this.setExternalCompacting(id, false);
      }, 480_000);
      t.unref?.();
    }
    this.bus.emit(id, "SESSION_UPDATED", { compacting: on });
  }

  // pid 对账/解锁等纯状态修复后强制下发：emitUpdated 携带 historical 等字段，
  // 否则客户端要等下次 SNAPSHOT 才摘掉"仅可查看"
  emitExternalSync(id: string): void {
    const s = this.sessions.get(id);
    if (s) this.emitUpdated(s, true);
  }

  // #393 手动通知注入（/api/notify）：把一段文字作为 TASK_DONE 汇报推给指定/最新会话，
  // 悬浮框当即弹出（拖图原理答疑/联调实测用）；同时落 last_task_done 供断线恢复
  notifyDone(sessionId: string, done: string[], remainingCount: number): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const report = { done: done.slice(0, 10), remaining_count: remainingCount, ts: Date.now() };
    s.state.last_task_done = report;
    this.bus.emit(sessionId, "TASK_DONE", {
      done: done.slice(0, 10),
      remaining: [],
      ts: report.ts,
    });
    return true;
  }

  // #393 黄色 [待确认] 悬浮框推送（/api/notify mode=confirm）：往目标会话 todos
  // 追加一条 pending [待确认] 条目——客户端 #300/#306 确认提醒链路天然接住（弹黄框，
  // 用户逐条 ✕ / 全部已读即消，会话任务面板同步可见）
  notifyConfirm(sessionId: string, text: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const todos = [...(s.state.todos ?? []), { content: `[待确认] ${text}`, status: "pending" as const }];
    this.setTodos(sessionId, todos);
    return true;
  }

  // 任务清单更新（TodoWrite；managed 与 external 两条路径共用）。
  // 单一咽喉点：hook 路径 / transcript 轮询 / COMMAND_REFRESH_TODOS 重发全部经此，
  // 隐藏条目（COMMAND_TODO_HIDE 记入 todo-hidden.json）在这里统一过滤
  setTodos(id: string, todos: TodoItem[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const hidden = hiddenTodoKeys(id);
    const list = hidden.size ? todos.filter((t) => !hidden.has(normKey(t.content))) : todos;
    s.state.todos = list;
    s.state.updated_at = Date.now();
    this.emitUpdated(s, true);
  }

  // external 会话子 Agent 工作状态：仅 subagents 实际变化时下发 SESSION_UPDATED
  // （运行中条目的"秒数走动"由客户端本地计时，relay 不逐秒推）
  setExternalSubagents(id: string, list: SubagentInfo[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const prev = JSON.stringify(s.state.subagents ?? []);
    const next = JSON.stringify(list);
    if (prev === next) return;
    s.state.subagents = list.length ? list : undefined;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      subagents: list,
    });
  }

  // 外部会话标题升级（CC 会话名 / 首个 prompt 摘要）；initialPrompt 只在缺失时补记。
  // #347：title_locked（用户手动命名）在此兜底——bridge 的首个 prompt 升级路径
  //（relay 重启后 initial_prompt 已丢、named 集合清空）会带着派生标题进来，
  // 无条件覆盖会把用户改的名冲掉（"几小时后恢复原名"根因）
  setExternalTitle(id: string, title: string, initialPrompt?: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.state.external) return;
    if (initialPrompt && !s.state.initial_prompt) s.state.initial_prompt = initialPrompt;
    if (s.state.title_locked) return;
    s.state.title = title;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      title,
    });
  }

  // external 会话排队注入消息（已发送、CLI 尚未处理）：随状态下发，
  // 客户端显示在工作指示器下方；UserPromptSubmit 匹配 / Stop 回合结束时晋升为正式 user_message
  setExternalPending(id: string, list: PendingInput[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.pending_inputs = list.length ? list : undefined;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      pending_inputs: list,
    });
  }

  // 外部会话文件改动统计（bridge 从 Edit/Write 结果累计）
  setExternalStats(id: string, stats: FileChangeStats): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.stats = stats;
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...stats },
    });
  }

  // 外部会话 token 用量 / 模型（bridge 从 transcript assistant 条目累计提取）
  // 上下文窗口上限按模型区分（集中维护，随 context_usage 一起下发；换模型只改这里）
  setExternalUsage(id: string, usage: TokenUsage, model?: string, contextUsage?: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state.usage = usage;
    if (model) s.state.model = model;
    if (contextUsage !== undefined) {
      s.state.context_usage = contextUsage;
      s.state.context_limit = contextLimitOf(model ?? s.state.model);
    }
    s.state.updated_at = Date.now();
    this.bus.emit(id, "SESSION_UPDATED", {
      status: s.state.status,
      action_summary: s.state.action_summary,
      stats: { ...s.state.stats },
      usage,
      ...(model ? { model } : {}),
      ...(contextUsage !== undefined ? { context_usage: contextUsage, context_limit: contextLimitOf(model ?? s.state.model) } : {}),
    });
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

  pushExternalLog(
    id: string,
    kind: LogEntry["kind"],
    text: string,
    tool?: string,
    meta?: { full?: string; detail?: string; diff?: string[] },
  ): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const entry: LogEntry = { ts: Date.now(), kind, text, tool, ...meta };
    s.logs.push(entry);
    if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500);
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

  setExternalCliPid(id: string, pid: number): void {
    const s = this.sessions.get(id);
    if (!s || s.state.cli_pid === pid) return;
    s.state.cli_pid = pid;
  }

  clearExternalCliPid(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.state.cli_pid = undefined;
  }

  handleCommand(cmd: Command, by: string): CommandAckPayload {
    // 幂等去重：重复 command_id 重放首次回执（防失败后同 id 重试假成功）
    const seen = this.processedCommands.get(cmd.command_id);
    if (seen) {
      return seen;
    }
    const ack = this.execCommand(cmd, by);
    this.processedCommands.set(cmd.command_id, ack);
    if (this.processedCommands.size > 1000) {
      const first = this.processedCommands.keys().next().value;
      if (first !== undefined) this.processedCommands.delete(first);
    }
    return ack;
  }

  private execCommand(cmd: Command, by: string): CommandAckPayload {
    try {
      switch (cmd.type) {
        case "COMMAND_CREATE": {
          const session_id = this.create(cmd.payload.cwd, cmd.payload.prompt);
          return { command_id: cmd.command_id, ok: true, session_id };
        }
        case "COMMAND_MESSAGE": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话请使用 COMMAND_EXT_INPUT" };
          }
          // agent 已死（Relay 重启遗留 / stop 收尾）：有 SDK 会话 id 就地 resume 复活
          if (!s.agent || s.agent.ended) {
            this.resumeAgent(s, cmd.payload.text, sanitizeImages(cmd.payload.images));
            return { command_id: cmd.command_id, ok: true };
          }
          if (s.state.status === "ERROR" || s.state.status === "DONE") {
            s.state.status = "WORKING";
          }
          s.agent.sendMessage(cmd.payload.text, sanitizeImages(cmd.payload.images));
          this.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_MODEL": {
          // #388 模型切换：注入 CLI 原生 /model slash 命令（托管 sendMessage / 外部 EXT_INPUT，
          // CLI 下一回合生效）；state.model 立即更新供端上显示（以 CLI 实际回报为准）
          const sid = String(cmd.payload.session_id ?? "");
          const model = String(cmd.payload.model ?? "").replace(/\[1m\]$/, "").trim();
          if (!model || !/^[\w.\/-]{1,80}$/.test(model)) {
            return { command_id: cmd.command_id, ok: false, error: "无效模型名" };
          }
          const s = this.sessions.get(sid) ?? this.sessions.get(`ext-${sid}`);
          if (!s) return { command_id: cmd.command_id, ok: false, error: "会话不存在" };
          if (s.state.external) {
            if (!this.bridge) return { command_id: cmd.command_id, ok: false, error: "外部会话通道未就绪" };
            const r = this.bridge.extInput(s.state.session_id, `/model ${model}`);
            if (!r.ok) return { command_id: cmd.command_id, ok: false, error: r.error ?? "注入失败" };
          } else if (s.agent && !s.agent.ended) {
            s.agent.sendMessage(`/model ${model}`);
          } else {
            return { command_id: cmd.command_id, ok: false, error: "会话不可操作（已结束）" };
          }
          s.state.model = model;
          s.state.updated_at = Date.now();
          this.pushExternalLog(s.state.session_id, "system", `模型切换: ${model}`);
          this.emitUpdated(s, true);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_PERM": {
          const live = this.requireLive(cmd.payload.session_id);
          if (live.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话不支持权限模式切换" };
          }
          const mode = cmd.payload.mode;
          if (!isManagedMode(mode)) {
            return { command_id: cmd.command_id, ok: false, error: `未知权限模式: ${mode}` };
          }
          void live.agent.setPermissionMode(mode)
            .then(() => {
              live.state.permission_mode = mode;
              this.pushExternalLog(live.state.session_id, "system", `权限模式切换: ${PERM_MODE_ZH[mode]}`);
              this.emitUpdated(live, true);
            })
            .catch((e) => {
              this.pushExternalLog(live.state.session_id, "system", `权限模式切换失败: ${e instanceof Error ? e.message : String(e)}`);
            });
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
        case "COMMAND_ANSWER": {
          const answers = cmd.payload.answers.map((a) => a.trim()).filter(Boolean).slice(0, 4);
          if (!answers.length) {
            return { command_id: cmd.command_id, ok: false, error: "answers 不能为空" };
          }
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            // 外部会话：allow+updatedInput 把答案注入工具入参，CLI 视为已作答不再弹本地选择器
            const ansErr = this.bridge?.answerPending(cmd.payload.session_id, cmd.payload.request_id, answers);
            if (ansErr) {
              return { command_id: cmd.command_id, ok: false, error: ansErr };
            }
            this.emitWaitingResolved(cmd.payload.session_id, cmd.payload.request_id, "answer", by);
            return { command_id: cmd.command_id, ok: true };
          }
          const live = this.requireLive(cmd.payload.session_id);
          if (!live.agent.answer(cmd.payload.request_id, answers, by)) {
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
        case "COMMAND_EXT_INPUT": {
          const s = this.require(cmd.payload.session_id);
          if (!s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "托管会话请使用 COMMAND_MESSAGE" };
          }
          if (!this.bridge) {
            return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
          }
          const r = this.bridge.extInput(cmd.payload.session_id, cmd.payload.text);
          return { command_id: cmd.command_id, ok: r.ok, error: r.error };
        }
        case "COMMAND_EXT_STOP": {
          const s = this.require(cmd.payload.session_id);
          if (!s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "托管会话请使用 COMMAND_STOP" };
          }
          if (!this.bridge) {
            return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
          }
          const r = this.bridge.extStop(cmd.payload.session_id);
          return { command_id: cmd.command_id, ok: r.ok, error: r.error };
        }
        case "COMMAND_REFRESH_TODOS": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            if (!this.bridge) {
              return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
            }
            const r = this.bridge.refreshTodos(cmd.payload.session_id);
            return { command_id: cmd.command_id, ok: r.ok, error: r.error };
          }
          // 托管会话：任务目录是权威源（#206）。force 重读磁盘强制重发可见集，
          // 不删轮询缓存——diff 仍与上轮比较，恰逢完成项照样发 TASK_DONE
          this.pollTaskStore(true);
          if (s.state.todos) this.setTodos(cmd.payload.session_id, s.state.todos.map((t) => ({ ...t })));
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_TODO_HIDE": {
          const s = this.require(cmd.payload.session_id);
          const content = cmd.payload.content.trim();
          if (!content) return { command_id: cmd.command_id, ok: false, error: "content 不能为空" };
          if (s.state.external) {
            if (!this.bridge) {
              return { command_id: cmd.command_id, ok: false, error: "bridge 未就绪" };
            }
            const r = this.bridge.hideTodo(cmd.payload.session_id, content);
            return { command_id: cmd.command_id, ok: r.ok, error: r.error };
          }
          // 托管会话：SDK feed 后续重推也被 setTodos 过滤兜住
          addHiddenTodoKey(cmd.payload.session_id, normKey(content));
          if (s.state.todos) this.setTodos(cmd.payload.session_id, s.state.todos.map((t) => ({ ...t })));
          // 删除闭环：让会话本体同步删掉本地任务条目（显示层过滤≠源头删除）
          s.agent?.sendMessage(
            `[移动端删除任务] 用户删除了任务清单条目：「${truncate(content.trim(), 120)}」。请将该条目从你的本地任务列表同步删除（任务工具置 deleted 或移除），不要重新创建或继续处理它。本条为系统通知，简短确认即可。`,
          );
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_DELETE": {
          const s = this.require(cmd.payload.session_id);
          if (s.state.status === "WORKING" || s.state.status === "WAITING") {
            return { command_id: cmd.command_id, ok: false, error: "会话运行中，不能删除" };
          }
          this.sessions.delete(cmd.payload.session_id);
          this.lastStoreTodos.delete(cmd.payload.session_id);
          if (s.state.external) {
            this.deletedExtIds.add(cmd.payload.session_id);
            appendDeletedExt(this.cfg.dataDir, cmd.payload.session_id);
          }
          // #49 删除置顶会话同步摘除清单（否则重启后被当作休眠卡登记回来）
          if (s.state.pinned) {
            writePinnedSessions(
              this.cfg.dataDir,
              readPinnedSessions(this.cfg.dataDir).filter((x) => x !== cmd.payload.session_id),
            );
          }
          this.bus.emit(cmd.payload.session_id, "SESSION_DELETED", { session_id: cmd.payload.session_id });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_RENAME": {
          const s = this.require(cmd.payload.session_id);
          const title = cmd.payload.title.trim().slice(0, 40);
          if (!title) return { command_id: cmd.command_id, ok: false, error: "标题不能为空" };
          s.state.title = title;
          s.state.title_locked = true;
          s.state.updated_at = Date.now();
          this.bus.emit(cmd.payload.session_id, "SESSION_UPDATED", {
            status: s.state.status,
            action_summary: s.state.action_summary,
            stats: { ...s.state.stats },
            title,
            title_locked: true,
          });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_PAIR_START": {
          // 云桥配对：信任锚 = LAN 信道的 token 鉴权（与现状同威胁模型）
          if (!this.cloud || !this.cfg.cloudUrl) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const { pubkey } = cmd.payload;
          if (typeof pubkey !== "string" || !/^[A-Za-z0-9+/]{43}={0,2}$/.test(pubkey)) {
            return { command_id: cmd.command_id, ok: false, error: "bad pubkey" };
          }
          const dev = devId(pubkey, "ph");
          const name = cmd.payload.name || "手机";
          this.cloud.addPeer(dev, { pubkey, name, paired_at: Date.now() });
          // 议题①：手机扫码配对同样是新设备入册（全权）——广播提醒其余在线设备
          this.bus.emitTransient("PAIRED_DEVICE", { dev, name, action: "add" });
          return {
            command_id: cmd.command_id,
            ok: true,
            cloud: {
              url: this.cfg.cloudUrl,
              token: this.cfg.cloudToken,
              relay_dev: this.cloud.relayDev,
              relay_pubkey: this.cloud.keypair.publicKey,
            },
          };
        }
        case "COMMAND_PAIR_CODE": {
          // 信任设备（已配对手机，LAN token / 云 E2E 任一信道）为网页端新设备签发一次性配对码。
          // ttl_ms 可选：按次长码（F4；签发端夹逼 60s~30min，见 pairing.ts）
          if (!this.cloud || !this.pairIssuer) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const ttlRaw = (cmd.payload as { ttl_ms?: unknown }).ttl_ms;
          const opts =
            typeof ttlRaw === "number" && Number.isFinite(ttlRaw) && ttlRaw > 0 ? { ttlMs: ttlRaw } : undefined;
          return { command_id: cmd.command_id, ok: true, pair_code: this.pairIssuer(opts) };
        }
        case "COMMAND_PEERS": {
          // 议题①可信设备清单：kind 按 dev 前缀派生（rl- 是 relay 自己，不在 peers）；
          // 云桥未启用时 peers 恒空，返回空清单而非报错（网页端 UI 直接显示「暂无」。
          // #42 e.meta 自报身份元数据随条目下发，存量设备无该字段 → 端上降级「未知设备」）
          const peers = this.cloud
            ? [...this.cloud.peers.entries()].map(([dev, e]) => ({
                dev,
                name: e.name || dev.slice(0, 11),
                pubkey: e.pubkey,
                kind: dev.startsWith("ph-") ? ("phone" as const) : dev.startsWith("wb-") ? ("web" as const) : dev.startsWith("wt-") ? ("watch" as const) : ("other" as const),
                paired_at: e.paired_at,
                last_seen: e.last_seen ?? 0,
                ...(e.meta ? { meta: e.meta } : {}),
              }))
            : [];
          return { command_id: cmd.command_id, ok: true, peers };
        }
        case "COMMAND_PEER_KICK": {
          // 议题①踢除：幂等（dev 不存在也回 ok）；先广播 kick 让在线设备刷新清单，
          // 再执行移除（peers 写穿落盘 + 各桥发 pair_nack 令其立即停止重连）
          if (!this.cloud || !this.peerKicker) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          const dev = String((cmd.payload as { dev?: unknown }).dev ?? "");
          if (!/^[a-z]{2}-[0-9a-f]{6,64}$/.test(dev)) {
            return { command_id: cmd.command_id, ok: false, error: "无效的设备号" };
          }
          const name = this.cloud.peers.get(dev)?.name || dev.slice(0, 11);
          this.peerKicker(dev);
          this.bus.emitTransient("PAIRED_DEVICE", { dev, name, action: "kick" });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_CLOUD_INFO": {
          // #25b（2026-09-10 移动网络场景）：本机 relay 的云桥身份自述——控制台据此
          // 给手机发「本机 relay 的云码」（手机在任何网络可连）。LAN token 鉴权内含
          //（能发命令即受信端）。bt 只给首桥（多桥并发码留待需要时再扩）
          if (!this.cloud) {
            return { command_id: cmd.command_id, ok: true, cloudInfo: { cloud: false } };
          }
          return {
            command_id: cmd.command_id,
            ok: true,
            cloudInfo: {
              cloud: true,
              bridge: (this.cfg.cloudUrls[0] ?? "").replace(/\/$/, "").replace(/^http/, "ws"),
              bt: this.cfg.cloudToken,
              rd: this.cloud.relayDev,
              rk: this.cloud.keypair.publicKey,
            },
          };
        }
        case "COMMAND_LOGIN_GRANT": {
          // #325 扫码登录：手机（信任信道）授权网页端出示的会话公钥，relay 配对并回 ack。
          // dev 必须与公钥派生值一致（与 pair_req 路径同款校验，防冒名占位）
          const p = cmd.payload as { session_dev?: string; session_pk?: string; name?: string };
          const dev = String(p.session_dev ?? "");
          const pk = String(p.session_pk ?? "");
          if (!this.cloud || !this.loginGranter) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          if (!/^wb-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pk) || devId(pk, "wb") !== dev) {
            return { command_id: cmd.command_id, ok: false, error: "会话参数格式无效" };
          }
          this.loginGranter(dev, pk, String(p.name ?? "web").slice(0, 32) || "web");
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_IMPORT_PUSH": {
          // 0.4.4 合并扫码跨网回传：手机把一条连接条目推给出示合并码的网页/exe 端。
          // 校验后交云层密封投递；pusher 返回 false = 目标端离线（码浮层已关/断线）
          const p = cmd.payload as { target_dev?: string; target_pk?: string; entry?: unknown; note?: unknown };
          const dev = String(p.target_dev ?? "");
          const pk = String(p.target_pk ?? "");
          if (!this.cloud || !this.importPusher) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          if (!/^wb-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pk) || devId(pk, "wb") !== dev) {
            return { command_id: cmd.command_id, ok: false, error: "目标设备参数无效" };
          }
          const entry = sanitizeImportPushEntry(p.entry);
          if (!entry) {
            return { command_id: cmd.command_id, ok: false, error: "回传条目格式无效" };
          }
          if (!this.importPusher(dev, pk, { t: "ccdeck-import-resp", entry, ...(p.note ? { note: String(p.note).slice(0, 80) } : {}) })) {
            return { command_id: cmd.command_id, ok: false, error: "电脑端不在线（二维码可能已关闭）" };
          }
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_PIN_SESSION": {
          // #49 置顶/取消置顶：写穿 pinned-sessions.json。托管会话专用（外部 CLI 会话
          // 生命周期由用户终端自管，重启后 hooks 重新接入，无需休眠恢复）。休眠态
          // （saved）也可 unpin——摘掉 saved 让卡片退回普通历史会话
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话不支持置顶（由 CLI 自身维护）" };
          }
          const pinned = cmd.payload.pinned === true;
          s.state.pinned = pinned || undefined;
          if (!pinned) s.state.saved = undefined;
          s.state.updated_at = Date.now();
          writePinnedSessions(
            this.cfg.dataDir,
            [...readPinnedSessions(this.cfg.dataDir).filter((x) => x !== cmd.payload.session_id), ...(pinned ? [cmd.payload.session_id] : [])],
          );
          // 显式带 pinned/saved 布尔（含 false）：端上据此直接改卡片，不等快照
          this.bus.emit(cmd.payload.session_id, "SESSION_UPDATED", {
            status: s.state.status,
            action_summary: s.state.action_summary,
            stats: { ...s.state.stats },
            pinned,
            saved: !!s.state.saved,
          });
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_RESUME_SESSION": {
          // #49 按需恢复：点击「已保存」休眠卡触发。已在线会话幂等成功（顺手清残留
          // 休眠标记）；失败同步抛错回 ACK，异步失败（流断/超时）走 SESSION_ERROR，
          // saved 保留可重试
          const s = this.require(cmd.payload.session_id);
          if (s.state.external) {
            return { command_id: cmd.command_id, ok: false, error: "外部会话不支持恢复" };
          }
          if (s.agent && !s.agent.ended) {
            if (s.state.saved) {
              s.state.saved = undefined;
              this.emitUpdated(s, true);
            }
            return { command_id: cmd.command_id, ok: true };
          }
          this.reviveSaved(s);
          return { command_id: cmd.command_id, ok: true };
        }
        case "COMMAND_WATCH_GRANT":
          // #316 手表配对授权在 ws-server 层处理（持有待配对连接池）；云信道走到这里
          // 说明命令被路由错了——明确报错而非静默
          return { command_id: cmd.command_id, ok: false, error: "手表配对授权仅限局域网信道" };
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
    // #293 三级回落：指定/默认目录无效时回落用户主目录（说明进时间线），完全无可用目录才报错
    const { cwd, fallbackNote } = resolveCreateCwd(rawCwd, this.cfg.defaultCwd);
    if (!cwd) throw new Error(fallbackNote);
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
        turn_started_at: Date.now(),
        updated_at: Date.now(),
        stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      },
      logs: [],
      lastUpdateEmit: 0,
    };

    const agent = this.newAgent(
      cwd,
      this.cfg.model,
      this.agentCallbacks(managed),
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
    // 目录回落说明进时间线：手机端能看到会话为何落在用户主目录，relay 日志同步留痕
    if (fallbackNote) {
      const entry: LogEntry = { ts: Date.now(), kind: "system", text: fallbackNote };
      managed.logs.push(entry);
      this.bus.emit(managed.state.session_id, "SESSION_LOG", entry);
      console.log(`[create-cwd] ${agent.id.slice(0, 8)} ${fallbackNote}`);
    }
    this.requestSmartTitle(agent.id, prompt);
    return agent.id;
  }

  // AgentSession 回调：create 与 resume 共用（状态机与事件下发完全一致）
  private agentCallbacks(managed: ManagedSession): AgentCallbacks {
    return {
        onInit: (sdkId, model, permissionMode) => {
          // #307：托管子会话 sid 即时落盘 child-sessions.json——relay 在此刻之后
          // 任意时点重启，孤儿扫描都认得它是自己的（不再被收养成"relay"垃圾会话）
          if (!this.childSdkIds.has(sdkId)) {
            this.childSdkIds.add(sdkId);
            appendChildSession(this.cfg.dataDir, sdkId);
          }
          managed.state.relay_session_id = sdkId;
          managed.state.model = model;
          if (isManagedMode(permissionMode)) managed.state.permission_mode = permissionMode;
          this.emitUpdated(managed, true);
        },
        onStatusChange: (status, summary) => {
          const changed = managed.state.status !== status;
          // 回合起点：非 WORKING → WORKING 的跳变时刻（手机/手表状态行计时用）
          if (changed && status === "WORKING") managed.state.turn_started_at = Date.now();
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
        onTodos: (todos) => {
          // 经 setTodos 咽喉点：托管会话的隐藏条目同样被过滤
          this.setTodos(managed.state.session_id, todos);
        },
        onUsage: (u) => {
          // result 消息是每回合一条，usage 为回合量：累计成会话总量
          const cur = managed.state.usage;
          managed.state.usage = {
            input_tokens: (cur?.input_tokens ?? 0) + u.input_tokens,
            output_tokens: (cur?.output_tokens ?? 0) + u.output_tokens,
            cache_read_input_tokens: (cur?.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: (cur?.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          };
          // 当回合水位（CLI 上下文占用口径）：覆盖不累计
          managed.state.context_usage =
            (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          managed.state.context_limit = contextLimitOf(managed.state.model);
          this.emitUpdated(managed, true);
        },
        onLog: (kind, text, meta) => {
          const entry: LogEntry = { ts: Date.now(), kind, text, ...meta };
          // 同 id 流式块原地替换，避免时间线被增量刷屏
          const i = meta?.id ? managed.logs.findIndex((e) => e.id === meta.id) : -1;
          if (i >= 0) managed.logs[i] = entry;
          else {
            managed.logs.push(entry);
            if (managed.logs.length > 500) managed.logs.splice(0, managed.logs.length - 500);
          }
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
    };
  }

  // 死会话复活：用 SDK resume 在同一 relay 会话上重建 agent（时间线/状态保留）
  private resumeAgent(s: ManagedSession, firstMessage: string, images?: string[]): void {
    const sdkId = s.state.relay_session_id;
    if (!sdkId) {
      throw new Error("会话已结束且无 SDK 会话记录，无法恢复（模型尚未完成初始化）");
    }
    const agent = this.newAgent(
      s.state.cwd,
      s.state.model,
      this.agentCallbacks(s),
      firstMessage,
      { resume: sdkId, permissionMode: s.state.permission_mode ?? "default", images },
    );
    s.agent = agent;
    // resume 的子 sid 同样经 onInit 回调登记（见 agentCallbacks.onInit 的 #307 落盘）
    s.state.status = "WORKING";
    s.state.historical = false;
    s.state.saved = undefined;
    s.state.done_reason = undefined;
    s.state.last_error = undefined;
    s.state.turn_started_at = Date.now();
    const marker = images && images.length > 0 ? `（+${images.length} 图）` : "";
    this.pushExternalLog(s.state.session_id, "user_message", truncate(firstMessage, 200) + marker);
    this.pushExternalLog(s.state.session_id, "system", `已恢复 SDK 会话（resume ${sdkId.slice(0, 8)}…）`);
    this.emitUpdated(s, true);
  }

  // #49 按需拉起（COMMAND_RESUME_SESSION）：不带首条消息的 parked resume——
  // transcript 重放完成后 CLI 停在等待输入，首个回合由后续 COMMAND_MESSAGE 开启。
  // 成功判定 = init 消息到达（SDK 会话就绪）；init 前流关闭 / 30s 超时 = 恢复失败
  // （ERROR + last_error，saved 保留让卡片可重试）。回调包裹仅在此路径生效，
  // resumeAgent（消息驱动）行为保持原样不动
  private reviveSaved(s: ManagedSession): void {
    const sdkId = s.state.relay_session_id;
    if (!sdkId) {
      throw new Error("无 SDK 会话记录（首次回合未完成即中断），无法恢复");
    }
    let inited = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const base = this.agentCallbacks(s);
    const fail = (reason: string): void => {
      if (inited) return;
      inited = true; // 流关闭与超时可能先后到，双触发只记一次
      if (timer) clearTimeout(timer);
      s.state.status = "ERROR";
      s.state.last_error = `恢复失败: ${reason}`;
      s.state.done_reason = undefined;
      s.state.action_summary = "恢复失败";
      s.state.saved = true; // 休眠卡保留：端上标「恢复失败」，可重试
      s.state.updated_at = Date.now();
      this.pushExternalLog(s.state.session_id, "system", s.state.last_error);
      this.bus.emit(s.state.session_id, "SESSION_ERROR", { message: s.state.last_error });
      this.emitUpdated(s, true);
    };
    const cb: AgentCallbacks = {
      ...base,
      onInit: (sdkIdNew, model, permissionMode) => {
        inited = true;
        if (timer) clearTimeout(timer);
        // 先清休眠标记再走 base 的 emitUpdated，让首帧就带最终状态
        s.state.saved = undefined;
        s.state.historical = false;
        base.onInit(sdkIdNew, model, permissionMode);
        s.state.status = "DONE";
        s.state.done_reason = "已恢复（等待输入）";
        s.state.action_summary = "已恢复，等待输入";
        s.state.turn_started_at = undefined;
        this.pushExternalLog(s.state.session_id, "system", `已恢复 SDK 会话（resume ${sdkId.slice(0, 8)}…）`);
        this.emitUpdated(s, true);
      },
      onSessionEnd: (reason) => {
        if (!inited) {
          fail(reason);
          return;
        }
        base.onSessionEnd(reason);
      },
    };
    // 初始化看门狗：CLI 卡住不吐 init 时不让会话永远吊在「恢复中」
    timer = setTimeout(() => {
      timer = null;
      fail("初始化超时（30s）");
      void s.agent?.stop();
    }, 30_000);
    timer.unref?.();
    const agent = this.newAgent(s.state.cwd, s.state.model, cb, undefined, {
      resume: sdkId,
      permissionMode: s.state.permission_mode ?? "default",
    });
    s.agent = agent;
    s.state.status = "WORKING";
    s.state.action_summary = "恢复中";
    s.state.done_reason = undefined;
    s.state.last_error = undefined;
    s.state.updated_at = Date.now();
    this.emitUpdated(s, true);
  }

  // #49 开机置顶登记（不自动拉起，2026-09-09 用户拍板）：pinned-sessions.json 是
  // 权威清单（历史事件里的 pinned 可能过时——unpin 落盘后重启的兜底，一律按文件
  // 归一）。清单内托管会话标 pinned+saved 休眠（可见、状态 DONE「已保存」、不可
  // 操作，点卡走 COMMAND_RESUME_SESSION）；查无会话的条目（压缩丢失/已删）静默清理
  applyPinned(): { saved: number } {
    const file = readPinnedSessions(this.cfg.dataDir);
    const keep: string[] = [];
    let saved = 0;
    for (const s of this.sessions.values()) {
      const pinned = file.includes(s.state.session_id);
      if (pinned && !s.state.external) {
        keep.push(s.state.session_id);
        const was = s.state.pinned;
        s.state.pinned = true;
        if (!s.agent) {
          // 休眠登记：relay 刚启动，置顶会话一律无 agent
          s.state.saved = true;
          s.state.status = "DONE";
          s.state.done_reason = "已保存（重启休眠）";
          s.state.action_summary = "已保存，点击恢复";
          s.state.last_error = undefined;
          s.state.waiting_request = undefined;
          saved++;
        }
        if (!was) this.emitUpdated(s, true);
      } else if (s.state.pinned) {
        // 文件已无此 id（unpin 已落盘但历史事件仍带 pinned=true）
        s.state.pinned = undefined;
        this.emitUpdated(s, true);
      }
    }
    if (keep.length !== file.length) writePinnedSessions(this.cfg.dataDir, keep);
    return { saved };
  }

  private require(sessionId: string): ManagedSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在: ${sessionId}`);
    return s;
  }

  private requireLive(sessionId: string): ManagedSession & { agent: AgentLike } {
    const s = this.require(sessionId);
    if (!s.agent) {
      throw new Error(
        s.state.external ? "外部会话不支持该命令（hooks 单向桥接）" : "历史会话不可操作（Relay 重启前遗留）",
      );
    }
    return s as ManagedSession & { agent: AgentLike };
  }

  // 外部会话远程决定后的收尾（清 WAITING、回 WORKING）；answered = PC 端本地已作答
  emitWaitingResolved(sessionId: string, requestId: string, decision: "allow" | "deny" | "answer" | "answered", by: string): void {
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
      ...(s.state.turn_started_at ? { turn_started_at: s.state.turn_started_at } : {}),
      ...(s.state.usage ? { usage: { ...s.state.usage } } : {}),
      ...(s.state.context_usage !== undefined ? { context_usage: s.state.context_usage, context_limit: s.state.context_limit ?? contextLimitOf(s.state.model) } : {}),
      ...(s.state.todos ? { todos: s.state.todos.map((t) => ({ ...t })) } : {}),
      ...(s.state.subagents ? { subagents: s.state.subagents.map((x) => ({ ...x })) } : {}),
      ...(s.state.relay_session_id ? { relay_session_id: s.state.relay_session_id } : {}),
      ...(s.state.permission_mode ? { permission_mode: s.state.permission_mode } : {}),
      ...(s.state.cron_tasks ? { cron_tasks: s.state.cron_tasks.map((t) => ({ ...t })) } : {}),
      ...(s.state.compacting ? { compacting: true } : {}),
      // #49 置顶/休眠标记恒随增量帧显式携带布尔：saved 的清除点（恢复成功 onInit/
      // 幂等恢复）不在命令回执路径上，只在为真时携带会让其他在线端一直挂着休眠卡
      //（SNAPSHOT 恒为全量权威，这里保证增量也能实时收口）
      pinned: !!s.state.pinned,
      saved: !!s.state.saved,
      // last_task_done 不随增量帧下发（#254）：手机/网页都不消费该路径，只在
      // SNAPSHOT 里用于断线恢复，增量携带纯属带宽浪费
      // historical 增删必须实时下发：转录自愈/pid 对账解锁后，已连接的客户端
      // 要等到下次 SNAPSHOT 才能摘掉"仅可查看"——期间用户以为发不了消息
      historical: !!s.state.historical,
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

  // 定时任务轮询：读各会话 cwd 下 .claude/scheduled_tasks.json，变化才下发。
  // 文件消失但此前有任务 → 视为清空（CLI 移除任务时可能直接删文件而非留空数组）；
  // "bad"（读到半截 JSON 等解析失败）→ 保留旧值等下一轮，避免误发清空再回填的闪烁
  private pollCronTasks(): void {
    for (const s of this.sessions.values()) {
      const tasks = readCronTasks(s.state.cwd);
      if (tasks === "bad") continue;
      const next = tasks ?? (s.state.cron_tasks ? [] : undefined);
      if (next === undefined) continue;
      const prev = s.state.cron_tasks ?? [];
      if (prev.length === 0 && next.length === 0) continue;
      if (cronTasksKey(prev) === cronTasksKey(next)) continue;
      s.state.cron_tasks = next;
      this.emitUpdated(s, true);
    }
  }

  // 权威任务清单轮询（#206）：直读 CLI 任务存储 ~/.claude/tasks/<cli_sid>/，
  // 托管（sdkId）与外部（hook session_id）统一覆盖；JSON 变更检测防重发。
  // bridge 的 transcript 旁路 tracker 降级为无目录时的回退，本轮询是主路径——
  // 陈旧快照/跨会话污染从源头消除（目录天然按会话隔离）
  private pollTaskStore(force = false): void {
    for (const s of this.sessions.values()) {
      if (s.state.historical) continue; // 历史会话无活跃目录，读到的只能是陈旧/噪音
      const sid = s.state.relay_session_id || (s.state.external ? s.state.session_id.slice(4) : "");
      if (!sid) continue;
      // last_task_done 2h TTL 清扫（#254）：与手机端恢复窗口同口径，过期摘除
      // 不再随快照携带（手表转发整 sessions，常驻大包白占帧）
      const ltd = s.state.last_task_done;
      if (ltd && Date.now() - ltd.ts > 2 * 3600_000) s.state.last_task_done = undefined;
      const todos = readTaskStoreTodos(sid);
      if (todos === null) continue;
      // 与 setTodos 同口径先滤隐藏条目：缓存/diff/TASK_DONE 都基于可见集，被隐藏任务完成不弹汇报
      const hidden = hiddenTodoKeys(s.state.session_id);
      const visible = hidden.size ? todos.filter((t) => !hidden.has(normKey(t.content))) : todos;
      const next = JSON.stringify(visible);
      const prevStr = this.lastStoreTodos.get(s.state.session_id);
      if (!force && prevStr === next) continue;
      this.lastStoreTodos.set(s.state.session_id, next);
      // 任务完成汇报（#204）：前快照未完成 → 后快照已完成的项即本次完成。
      // 首见（prevStr 空，冷启动/SNAPSHOT 重建）不报，避免重启刷一屏假完成。
      // #393 补充：创建+完成落在同一轮询窗（30s）内的任务，首见时已是 completed——
      // 此前被上面"首见不报"一并吞掉，TASK_DONE 几乎不触发（悬浮框长期沉默根因）。
      // 会话已在轮询中（prevStr 存在）时，本轮新出现且已完成、且 updated_at 距今
      // 10 分钟内的条目按完成上报；无近期 mtime 的历史完成条目（resume 场景）仍不报
      if (prevStr) {
        try {
          const prev = JSON.parse(prevStr) as TodoItem[];
          const prevByContent = new Set(prev.map((t) => t.content));
          const prevOpen = new Set(prev.filter((t) => t.status !== "completed").map((t) => t.content));
          const done = visible
            .filter(
              (t) =>
                t.status === "completed" &&
                (prevOpen.has(t.content) ||
                  (!prevByContent.has(t.content) && typeof t.updated_at === "number" && Date.now() - t.updated_at < 10 * 60_000)),
            )
            .map((t) => t.content);
          if (done.length) {
            // 汇报同时记入会话状态（#254）：TASK_DONE 瞬态事件在客户端断线/进程被杀时
            // 丢失，落状态后 SNAPSHOT 可恢复未读汇报（端上按 ts 与已清除位去重）。
            // 状态里 done 截断 10 条与手机队列口径一致（事件 payload 保持全量供网页展示）
            const report = {
              done: done.slice(0, 10),
              remaining_count: visible.filter((t) => t.status !== "completed").length,
              ts: Date.now(),
            };
            s.state.last_task_done = report;
            this.bus.emit(s.state.session_id, "TASK_DONE", {
              done,
              remaining: visible.filter((t) => t.status !== "completed"),
              ts: report.ts,
            });
          }
        } catch {}
      }
      this.setTodos(s.state.session_id, todos);
    }
  }

  private lastStoreTodos = new Map<string, string>();

  private evictOldSessions(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const finished = [...this.sessions.values()]
      // #49 置顶会话豁免驱逐：置顶的意义就是跨重启存活，容量满时先挤普通会话
      .filter((s) => (s.state.status === "DONE" || s.state.status === "ERROR") && !s.state.pinned)
      .sort((a, b) => a.state.started_at - b.state.started_at);
    for (const s of finished) {
      if (this.sessions.size < MAX_SESSIONS) break;
      void s.agent?.stop(); // 回收 parked 的 CLI 子进程（历史会话无 agent）
      this.sessions.delete(s.state.session_id);
      this.lastStoreTodos.delete(s.state.session_id);
    }
  }

  private cloneState(s: ManagedSession): SessionState {
    return JSON.parse(JSON.stringify(s.state)) as SessionState;
  }
}
