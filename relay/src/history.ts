// 会话历史持久化：events.ndjson 追加写 + 重启时重放重建
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope, EventType, LogEntry, SessionEngine, SessionState } from "./types.js";
import { contextLimitOf, REPLAY_CONTEXT_MAX } from "./context-limit.js";

const MAX_SESSIONS_KEPT = 30;
const MAX_LOGS_PER_SESSION = 300;
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
      const p = e.payload as { cwd: string; initial_prompt: string; model: string; title?: string; external?: boolean; employee?: boolean; employee_home?: string; engine?: SessionEngine; provider?: string; started_at?: number };
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
        const p = e.payload as { status: SessionState["status"]; action_summary: string; stats: SessionState["stats"]; remote_mode?: boolean; title?: string; title_locked?: boolean; turn_started_at?: number; usage?: SessionState["usage"]; todos?: SessionState["todos"]; subagents?: SessionState["subagents"]; model?: string; engine?: SessionEngine; provider?: string };
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
        // 按 contextLimitOf 重算；usage 超 REPLAY_CONTEXT_MAX 的按旧聚合污染丢弃
        // （真值由新回合首个 message_delta 写回）
        const cu = (p as { context_usage?: unknown }).context_usage;
        if (typeof cu === "number" && cu > 0 && cu <= REPLAY_CONTEXT_MAX) {
          s.context_usage = cu;
          s.context_limit = contextLimitOf(s.model);
        }
        if (p.todos) s.todos = p.todos;
        if (p.subagents) s.subagents = p.subagents;
        if ((p as { relay_session_id?: string }).relay_session_id) s.relay_session_id = (p as { relay_session_id?: string }).relay_session_id!;
        if ((p as { permission_mode?: SessionState["permission_mode"] }).permission_mode) s.permission_mode = (p as { permission_mode?: SessionState["permission_mode"] }).permission_mode;
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
        s.last_error = (e.payload as { message: string }).message;
        rs.logs.push({ ts: e.ts, kind: "system", text: `错误: ${s.last_error}` });
        break;
      }
      case "SESSION_DONE": {
        s.status = "DONE";
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
        if (rs.logs.length > 500) rs.logs.splice(0, rs.logs.length - 500);
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
          rs.state.status = "DONE";
          rs.state.done_reason = "ended";
          rs.state.historical = true;
          rs.logs.push({ ts: Date.now(), kind: "system", text: "服务更新重启 · 会话已结束" });
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
