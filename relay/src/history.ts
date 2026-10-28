// 会话历史持久化：events.ndjson 追加写 + 重启时重放重建
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope, EventType, LogEntry, SessionEngine, SessionState } from "./types.js";
import { contextLimitOfEffective, REPLAY_CONTEXT_MAX } from "./context-limit.js";

const MAX_SESSIONS_KEPT = 30;
// W-INJECT 问题④：300→1500。300 条对活跃会话只覆盖 1~3 小时（流式帧供给下实测 4 个
// 会话恰好卡死 300），重启重放/面板重建的转录窗口起点被推进数小时=用户看到的「历史
// 回滚」（2026-10-11 深夜生产实锤：2c5a9c26 等 4 会话 log_count 恰=300、末条 LOG 落后
// 末条 UPD 2~7 小时）。1500 ≈ 数天常规量；文件量级 8.5MB→~25MB，远低于压缩触发阈
//（CCR_EVENTS_COMPACT_MB 默认 64MB），boot 解析无感
const MAX_LOGS_PER_SESSION = 1500;
const MAX_STATE_EVENTS_PER_SESSION = 50;

// ---------- 加载 ----------

export function loadEvents(path: string): Envelope[] {
  if (!existsSync(path)) return [];
  const out: Envelope[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const env = JSON.parse(t) as Envelope;
      if (typeof env.seq === "number" && typeof env.type === "string") out.push(env);
    } catch {
      // 损坏行跳过（追加写被中断等）
    }
  }
  return out;
}

// ---------- 压缩：保留每会话关键事件，丢弃心跳与过旧日志 ----------

const STATE_TYPES = new Set<EventType>([
  "SESSION_CREATED",
  "SESSION_UPDATED",
  "SESSION_WAITING",
  "SESSION_WAITING_RESOLVED",
  "SESSION_ERROR",
  "SESSION_DONE",
]);

export function compactEvents(events: Envelope[]): Envelope[] {
  const bySession = new Map<string, { states: Envelope[]; logs: Envelope[] }>();
  for (const e of events) {
    if (e.type === "SESSION_DELETED") {
      bySession.delete(e.session_id); // 已删除会话：整组丢弃
      continue;
    }
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, { states: [], logs: [] });
    const bucket = bySession.get(e.session_id)!;
    if (e.type === "SESSION_LOG") bucket.logs.push(e);
    else if (STATE_TYPES.has(e.type as EventType)) bucket.states.push(e);
  }

  const sessions = [...bySession.entries()]
    .sort((a, b) => lastTs(b[1]) - lastTs(a[1]))
    .slice(0, MAX_SESSIONS_KEPT);

  const kept: Envelope[] = [];
  for (const [, bucket] of sessions) {
    // CREATED 必保（重放建状态的起点），其余状态事件留最后 N 条
    const created = bucket.states.filter((e) => e.type === "SESSION_CREATED");
    const rest = bucket.states.filter((e) => e.type !== "SESSION_CREATED");
    const keptStates = [...created, ...tail(rest, MAX_STATE_EVENTS_PER_SESSION)];
    const keptLogs = tail(bucket.logs, MAX_LOGS_PER_SESSION);
    // 按 seq 恢复原始顺序；重放时"每个类型的最后一条生效"，丢中间事件不影响结果
    kept.push(...[...keptStates, ...keptLogs].sort((a, b) => a.seq - b.seq));
  }
  return kept.sort((a, b) => a.seq - b.seq);
}

function lastTs(b: { states: Envelope[]; logs: Envelope[] }): number {
  return Math.max(b.states.at(-1)?.ts ?? 0, b.logs.at(-1)?.ts ?? 0);
}

function tail<T>(arr: T[], n: number): T[] {
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

// #25-P1 原子重写：tmp+rename——boot 场景无并发无所谓，运行期压缩（compactEventsFile）
// 场景下直接覆盖写若中途崩溃（盘满/被杀）会留下截断文件；rename 同文件系统原子，
// 崩溃只会留下可清理的 .tmp 残件，正文件要么旧要么新
export function rewriteFile(path: string, events: Envelope[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  renameSync(tmp, path);
}

// #25-P1 运行期压缩（长跑治理）：此前压缩只在 boot 一次，运行期纯追加（心跳每
// 5s/忙会话一条 + 流式帧每帧落盘），生产实证 121MB/84k 行、不重启月增 ~100MB——
// boot 越来越慢 + 重启 loadEvents 内存尖峰。语义与 boot 压缩完全同款（重放等价：
// 「每类型最后一条生效」）；客户端断线重连走 EventBus 内存 replay 不读文件，压缩
// 零感知。同步整段执行：单线程事件循环内 emit 不会交错进来；低频触发（定时+阈值）
// 数秒阻塞可接受。失败静默返回 null——审计面动作绝不影响主流程，下次再试
export function compactEventsFile(path: string, minBytes: number): { before: number; after: number } | null {
  try {
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    if (size < minBytes) return null;
    const prior = loadEvents(path);
    const kept = compactEvents(prior);
    if (prior.length === kept.length) return null; // 已是最简，不白写一遍
    rewriteFile(path, kept);
    return { before: size, after: statSync(path).size };
  } catch {
    return null;
  }
}

export function appendLine(path: string, env: Envelope): void {
  mkdirSync(dirname(path), { recursive: true });
  // 同步追加：量级低（事件已是摘要级），简单优先
  writeFileSync(path, JSON.stringify(env) + "\n", { flag: "a" });
}

// ---------- 重放：事件流 -> 会话状态 + 时间线 ----------

export interface ReplayedSession {
  state: SessionState;
  logs: LogEntry[];
}

export function reduceHistory(events: Envelope[]): Map<string, ReplayedSession> {
  const out = new Map<string, ReplayedSession>();
  for (const e of events) {
    let rs = out.get(e.session_id);
    if (!rs && e.type === "SESSION_CREATED") {
      const p = e.payload as { cwd: string; initial_prompt: string; model: string; title?: string; external?: boolean; employee?: boolean; employee_home?: string; engine?: SessionEngine; provider?: string; started_at?: number; last_tool_use_at?: number };
      rs = {
        state: {
          session_id: e.session_id,
          relay_session_id: "",
          cwd: p.cwd,
          initial_prompt: p.initial_prompt,
          title: p.title || deriveTitle(p.initial_prompt),
          model: p.model,
          status: "WORKING",
          action_summary: "（历史）",
          // 孤儿收养等场景的 started_at 与事件落盘时刻不同步：载荷显式带了就优先（#321）
          started_at: p.started_at && p.started_at > 0 ? p.started_at : e.ts,
          updated_at: e.ts,
          stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
          // #291 审查 A-P2-2：CREATED 帧带键则回放归一落 0（新 relay 帧）；老帧缺省
          // undefined=降级档（过渡期可接受，首个工具帧即起算）
          ...(p.last_tool_use_at !== undefined ? { last_tool_use_at: p.last_tool_use_at } : {}),
        },
        logs: [],
      };
      // #148：ext- 前缀 = 外部会话铁证 id 形态（ensureExternal 唯一这么起 id）。
      // 存量事件流里部分历史 CREATED 帧缺 external 字段（旧版本写入），回放后 external
      // 缺失 → 重启收养把外部会话误判为不可注入的纯历史卡（web「仅可查看」锁死）。
      // 前缀兜底治全部存量帧，无需数据迁移。
      if (p.external || e.session_id.startsWith("ext-")) rs.state.external = true;
      // #17 雇员标记随首帧流经事件流：重启回放后 transcript/任务清单读取路径
      // 按此选家（雇员独立家），resume 也据此传 CLAUDE_CONFIG_DIR
      if (p.employee) rs.state.employee = true;
      // #17 第二批：创建时落定的家随首帧回放——开关翻转后存量会话按记录走
      if (typeof p.employee_home === "string" && p.employee_home) rs.state.employee_home = p.employee_home;
      // #27 引擎标记随首帧回放：不还原 = 重启后 codex 卡被当 claude 收养（resume
      // 走 AgentSession + thread_id，会话静默换引擎）——三角度审查 P1-2 实测缺口
      if (p.engine) rs.state.engine = p.engine;
      if (p.provider) rs.state.engine_provider = p.provider;
      out.set(e.session_id, rs);
      continue;
    }
    if (!rs) {
      if (e.type === "SESSION_DELETED") out.delete(e.session_id);
      continue; // 缺 CREATED 的残缺事件（压缩裁掉了），跳过
    }
    if (e.type === "SESSION_DELETED") {
      out.delete(e.session_id);
      continue;
    }
    const s = rs.state;
    s.updated_at = e.ts;
    switch (e.type) {
      case "SESSION_UPDATED": {
        const p = e.payload as { status: SessionState["status"]; action_summary: string; stats: SessionState["stats"]; remote_mode?: boolean; title?: string; title_locked?: boolean; turn_started_at?: number; usage?: SessionState["usage"]; todos?: SessionState["todos"]; subagents?: SessionState["subagents"]; model?: string; engine?: SessionEngine; provider?: string; updated_at?: number };
        // #157 起 UPDATED 载荷恒带显式 updated_at（水合帧≠活动时刻，下发侧注释明说
        // 客户端以它为准）——重放侧同口径消费；旧版帧/异常缺载回落信封 ts（上方默认）。
        // 不消费则水合时刻被固化为活跃时刻，二次重启后闲置置灰
        //（memberActivity/sweepIdleArchive）用漂移时间误判
        if (typeof p.updated_at === "number" && p.updated_at > 0) s.updated_at = p.updated_at;
        s.status = p.status;
        s.action_summary = p.action_summary;
        if (p.stats) s.stats = p.stats;
        if (p.remote_mode !== undefined) s.remote_mode = p.remote_mode;
        if (p.title) s.title = p.title;
        if (p.title_locked) s.title_locked = true;
        if (p.model) s.model = p.model;
        if (p.engine) s.engine = p.engine;
        if (p.provider) s.engine_provider = p.provider;
        if (p.turn_started_at) s.turn_started_at = p.turn_started_at;
        if (p.usage) s.usage = p.usage;
        // #72 水位跨重启还原：热替换/重启清空内存态后，此前不回放 context_usage/
        // context_limit，导致 mid-turn 与 idle 会话的水位条全部消失（只有恰逢回合
        // 完成的会话重新拿到）。载荷显式携带才还原，与下发侧 spread 语义一致。
        // follow-up（同夜实弹验证）：limit 不信任历史帧（旧映射 bug 写过 1M），一律
        // 按模型名重算（W-CTXFIX B1 起 = contextLimitOfEffective）；usage 超
        // REPLAY_CONTEXT_MAX 的按旧聚合污染丢弃（真值由新回合首个 message_delta 写回）
        // W-CTXFIX B1（2026-10-10）：托管会话存档 model 是有意裸名、CLI 实按 [1m]
        // 重挂名跑——重算走 effective 口径（context-limit.ts 头注释），同 onContext
        const cu = (p as { context_usage?: unknown }).context_usage;
        if (typeof cu === "number" && cu > 0 && cu <= REPLAY_CONTEXT_MAX) {
          s.context_usage = cu;
          s.context_limit = contextLimitOfEffective(s.model);
        }
        if (p.todos) s.todos = p.todos;
        if (p.subagents) s.subagents = p.subagents;
        // W-CTXFIX B3：压缩前摘要跨重启还原（任务书要求 resume/revive 后保留可查）
        if ((p as { pre_compact_summary?: string }).pre_compact_summary) {
          s.pre_compact_summary = (p as { pre_compact_summary?: string }).pre_compact_summary!;
        }
        if ((p as { relay_session_id?: string }).relay_session_id) s.relay_session_id = (p as { relay_session_id?: string }).relay_session_id!;
        if ((p as { permission_mode?: SessionState["permission_mode"] }).permission_mode) s.permission_mode = (p as { permission_mode?: SessionState["permission_mode"] }).permission_mode;
        // W-INJECT：pid 帧回放还原（setExternalCliPid 现随 pid 变更落帧）。cli_pid 在册
        // 才能让下方「外部会话非终态收殓」的活体判定真正走到活分支（保持 WORKING 不标
        // historical）；存量事件流无 pid 帧 → 恒空走旧路径，由 bridge 存活自愈兜底
        {
          const cp = (p as { cli_pid?: unknown }).cli_pid;
          if (typeof cp === "number" && Number.isInteger(cp) && cp > 0) s.cli_pid = cp;
        }
        break;
      }
      case "SESSION_WAITING": {
        s.status = "WAITING";
        s.waiting_request = e.payload as SessionState["waiting_request"];
        s.waiting_started_at = e.ts;
        break;
      }
      case "SESSION_WAITING_RESOLVED": {
        s.status = "WORKING";
        s.waiting_request = undefined;
        s.waiting_started_at = undefined;
        const d = (e.payload as { decision: string }).decision;
        rs.logs.push({ ts: e.ts, kind: "system", text: `已${d === "allow" ? "允许" : d === "answer" ? "作答" : "拒绝"}` });
        break;
      }
      case "SESSION_ERROR": {
        s.status = "ERROR";
        s.turn_started_at = undefined; // #291：终态清算与 transition 同口径（回放面）
        s.last_error = (e.payload as { message: string }).message;
        rs.logs.push({ ts: e.ts, kind: "system", text: `错误: ${s.last_error}` });
        break;
      }
      case "SESSION_DONE": {
        s.status = "DONE";
        s.turn_started_at = undefined; // #291：终态清算与 transition 同口径（回放面）
        const p = e.payload as { terminal_reason: string; duration_ms: number; stats: SessionState["stats"] };
        s.done_reason = p.terminal_reason;
        s.duration_ms = p.duration_ms;
        if (p.stats) s.stats = p.stats;
        rs.logs.push({ ts: e.ts, kind: "system", text: `完成: ${p.terminal_reason}` });
        break;
      }
      case "SESSION_LOG": {
        const p = e.payload as LogEntry & { kind: LogEntry["kind"] };
        // streaming 不回放：历史条目都是终态，残留光标会卡住 "▌"
        const entry: LogEntry = {
          ts: e.ts, kind: p.kind, text: p.text, tool: p.tool,
          full: p.full, id: p.id, detail: p.detail, diff: p.diff, occurred_at: p.occurred_at,
        };
        // #73 同 id 原地替换（与运行期语义一致）：托管流式块/外部转录增长链每帧
        // 都落盘，重放逐条 push 会把同一条消息的中间快照全部复活成重复条目
        const li = p.id ? rs.logs.findIndex((x) => x.id === p.id) : -1;
        if (li >= 0) rs.logs[li] = entry;
        else rs.logs.push(entry);
        // #291 帧分类判活（回放恢复）：工具帧恢复最近工具活动时刻——重启后
        // last_tool_use_at 不归零（老卡 undefined→首个工具帧起算，降级窗内不误伤）
        if (p.kind === "tool_use" || p.kind === "tool_result") s.last_tool_use_at = e.ts;
        if (rs.logs.length > 1500) rs.logs.splice(0, rs.logs.length - 1500); // W-INJECT④：对齐 MAX_LOGS_PER_SESSION
        break;
      }
      default:
        break; // HEARTBEAT 等
    }
  }

  // #82 存量矫正（2026-09-13 用户再报）：旧版重放误标的 ERROR 已成事件流终态，忠实
  // 重放永远复活它们——ERROR 且无 last_error（真错误路径 hook 会报 error 消息进来）
  // 的外部会话一律归 DONE：正常收工形态（有 SESSION_DONE 取其 reason，缺省 ended）
  for (const rs of out.values()) {
    if (rs.state.external && rs.state.status === "ERROR" && !rs.state.last_error) {
      rs.state.status = "DONE";
      if (!rs.state.done_reason) rs.state.done_reason = "ended";
      rs.logs.push({ ts: Date.now(), kind: "system", text: "历史误标错误已自动矫正为完成" });
    }
  }

  // 非终态会话：Relay 重启时被中断。托管会话 agent 真随 relay 死了——ERROR 合理；
  // 外部 CLI 是独立进程：pid 还活就保持 WORKING（hook/转录随后自会收敛），pid 已死
  // 也只是「CLI 先于 relay 退出」（claude -p 收工即此形态，转录尾巴还常把 DONE 翻回
  // WORKING），归 DONE 而非 ERROR——#82（2026-09-12 Mac 实录 6 个假 error：每轮
  // 构建装机 pkill App → 内嵌 relay 重启重放，把转录尾巴翻转的 WORKING 全误标）
  for (const rs of out.values()) {
    if (rs.state.status === "WORKING" || rs.state.status === "WAITING") {
      if (rs.state.external) {
        let alive = false;
        if (rs.state.cli_pid) {
          try { process.kill(rs.state.cli_pid, 0); alive = true; } catch { alive = false; }
        }
        if (alive) {
          // #49 口径：服务端重启对用户是"服务更新"，不暴露 Relay/CLI 内部机制字眼
          rs.logs.push({ ts: Date.now(), kind: "system", text: "服务更新重启 · 会话继续跟踪中" });
        } else {
          // #247 W-READONLY-KILL（用户铁口径 2026-10-24）：pid 判死不再降级 historical——
          // relay 记的 cli_pid 会过期（CLI 自己重启换 pid/压缩挤掉 pid 帧/kill(0) 对他人
          // 进程 EPERM），而 transcript 在=可注入（EXT_INPUT 链）的铁证；误标 historical
          // 曾把用户本机活跃终端会话（rea/修图）锁成只读三次实锤。状态落 DONE（进程态
          // 未知不再报 WORKING），historical 保持 false——发送即自动注入
          rs.state.status = "DONE";
          rs.state.done_reason = "ended";
          rs.state.historical = false;
          rs.logs.push({ ts: Date.now(), kind: "system", text: "服务更新重启 · 发送消息即可继续" });
        }
      } else if (rs.state.relay_session_id) {
        // #52 批：托管会话带 SDK 会话号即可靠 resume 恢复——归 DONE 中性态而非
        // ERROR 红条（DONE 不发包、只在启动重标，不会触发"任务完成"通知卡）
        rs.state.status = "DONE";
        rs.state.done_reason = "服务更新重启，会话已中断";
        rs.state.historical = true;
        rs.logs.push({ ts: Date.now(), kind: "system", text: "服务更新重启，会话已中断 · 发送消息即可继续" });
      } else {
        rs.state.status = "ERROR";
        rs.state.last_error = "服务更新重启，会话已中断";
        rs.state.historical = true;
        rs.logs.push({ ts: Date.now(), kind: "system", text: "服务更新重启，会话已中断" });
      }
    }
    // 重放后不存在仍可决的等待（进程已随重启断开）：残留 waiting_request 会让
    // 手机端给死会话渲染可操作的审批面板；外部会话重连后会重新下发真实状态
    rs.state.waiting_request = undefined;
  }
  return out;
}

// ---------- 标题 ----------

export function deriveTitle(prompt: string): string {
  // 跳过代码围栏等纯标记行，取第一条有意义内容
  const firstLine =
    prompt
      .trim()
      .split("\n")
      .find((l) => !l.trim().startsWith("```") && l.replace(/^[#>`\s*-]+/, "").trim().length > 0) ?? "";
  const cleaned = firstLine
    .replace(/^[#>`\s*-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  // 中英文混合按字符数截断（中文 24 字足够表意）
  const t = [...cleaned].length > 24 ? [...cleaned].slice(0, 24).join("") + "…" : cleaned;
  return t || "未命名会话";
}

// ---------- W-P0-FIX P0-3：boot 单遍流式重放（三放大器架构修） ----------
// 三放大器 = boot 路径串联的三遍全量扫描：loadEvents（全量 parse+驻留 prior 数组）→
// compactEvents（第二遍分桶）→ reduceHistory(kept)（第三遍状态机）。41MB 级 events 下
// 三遍 parse + prior 全量驻留是 boot 内存尖峰与时延主源。本函数一遍流式（readline 逐行
// 单次 parse）同时产出压缩集与重放态：内存只驻留每会话尾窗桶（kept 等价物），prior 全量
// 数组不落内存。
// 等价契约（test-history-stream.ts 锁死）：bootReplayFile(p) 的 kept ===
// compactEvents(loadEvents(p))、sessions === reduceHistory(kept)、compacted 判定 ===
// (prior.length !== kept.length)——三步语义逐字节不动，只是消除重复扫描。
import { createReadStream } from "node:fs";
import * as readline from "node:readline";

export interface BootReplayResult {
  /** 压缩后事件集（= compactEvents 产物；EventBus preload 与重写共用） */
  kept: Envelope[];
  /** 重放态（= reduceHistory(kept) 产物） */
  sessions: Map<string, ReplayedSession>;
  /** 是否需要重写文件（= prior.length !== kept.length） */
  compacted: boolean;
}

interface SessionBucket {
  created: Envelope[];
  states: Envelope[]; // 非 CREATED 状态事件（保尾 MAX_STATE_EVENTS_PER_SESSION）
  logs: Envelope[]; // 保尾 MAX_LOGS_PER_SESSION
  lastTs: number;
  deleted: boolean; // 尾见 SESSION_DELETED：compact 语义=整组丢弃
  deletedAtSeq: number;
}

export async function bootReplayFile(path: string): Promise<BootReplayResult> {
  // fresh 安装（data 目录尚无 events.ndjson）：空重放直达——createReadStream 对缺失
  // 文件异步 reject 会以 uncaught 崩掉整个 relay（冒烟闸 1013 逮住：新装机必崩级）
  if (!existsSync(path)) return { kept: [], sessions: new Map(), compacted: false };
  const buckets = new Map<string, SessionBucket>();
  let priorCount = 0;
  let keptCount = 0;
  const touch = (b: SessionBucket, e: Envelope): void => {
    b.lastTs = Math.max(b.lastTs, e.ts);
  };
  const rl = readline.createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let env: Envelope;
    try {
      env = JSON.parse(t) as Envelope;
    } catch {
      continue; // 损坏行跳过（loadEvents 同口径）
    }
    if (typeof env.seq !== "number" || typeof env.type !== "string") continue;
    priorCount++;
    if (env.type === "SESSION_DELETED") {
      // compact 语义：删除即整组丢弃；重放语义：终结该会话。两路一致按「桶标记删」
      const b = buckets.get(env.session_id);
      if (b) {
        b.deleted = true;
        b.deletedAtSeq = env.seq;
        b.created = [];
        b.states = [];
        b.logs = [];
      }
      // 未建桶的孤儿 DELETE（压缩残件）：两侧同忽略
      continue;
    }
    let b = buckets.get(env.session_id);
    if (b && b.deleted) {
      // 复活语义（compactEvents bySession.delete 后新事件重建桶的等价物）：删后
      // 同 sid 新事件 = 新桶，旧删除标记与残桶一并作废
      b = { created: [], states: [], logs: [], lastTs: 0, deleted: false, deletedAtSeq: 0 };
      buckets.set(env.session_id, b);
    }
    if (!b) {
      b = { created: [], states: [], logs: [], lastTs: 0, deleted: false, deletedAtSeq: 0 };
      buckets.set(env.session_id, b);
    }
    if (env.type === "SESSION_CREATED") {
      b.created.push(env); // CREATED 必保（compact 语义）
      touch(b, env);
    } else if (env.type === "SESSION_LOG") {
      b.logs.push(env);
      if (b.logs.length > MAX_LOGS_PER_SESSION) b.logs.splice(0, b.logs.length - MAX_LOGS_PER_SESSION);
      touch(b, env);
    } else if (STATE_TYPES.has(env.type as EventType)) {
      b.states.push(env);
      if (b.states.length > MAX_STATE_EVENTS_PER_SESSION) b.states.splice(0, b.states.length - MAX_STATE_EVENTS_PER_SESSION);
      touch(b, env);
    } else {
      // 其余类型 compact 丢弃（compactEvents 只保 STATE_TYPES/LOG/CREATED），
      // 但 lastTs 参与会话活跃度排序（compactEvents lastTs 取 states/logs 尾 ts——
      // 非 STATE/LOG 帧不触碰，此处同口径不 touch）
    }
  }
  // 会话活跃度排序（compactEvents 同款：lastTs 降序取前 MAX_SESSIONS_KEPT）
  const ranked = [...buckets.entries()]
    .filter(([, b]) => !b.deleted && (b.created.length > 0 || b.states.length > 0 || b.logs.length > 0))
    .sort((a, b) => b[1].lastTs - a[1].lastTs)
    .slice(0, MAX_SESSIONS_KEPT);
  const kept: Envelope[] = [];
  for (const [, b] of ranked) {
    kept.push(...[...b.created, ...b.states, ...b.logs].sort((x, y) => x.seq - y.seq));
  }
  kept.sort((x, y) => x.seq - y.seq);
  keptCount = kept.length;
  return {
    kept,
    sessions: reduceHistory(kept),
    compacted: priorCount !== keptCount,
  };
}
