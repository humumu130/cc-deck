// 会话历史持久化：events.ndjson 追加写 + 重启时重放重建
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope, EventType, LogEntry, SessionState } from "./types.js";

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

export function rewriteFile(path: string, events: Envelope[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
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
      const p = e.payload as { cwd: string; initial_prompt: string; model: string; title?: string; external?: boolean; started_at?: number };
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
      if (p.external) rs.state.external = true;
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
        const p = e.payload as { status: SessionState["status"]; action_summary: string; stats: SessionState["stats"]; remote_mode?: boolean; title?: string; title_locked?: boolean; turn_started_at?: number; usage?: SessionState["usage"]; todos?: SessionState["todos"]; subagents?: SessionState["subagents"] };
        s.status = p.status;
        s.action_summary = p.action_summary;
        if (p.stats) s.stats = p.stats;
        if (p.remote_mode !== undefined) s.remote_mode = p.remote_mode;
        if (p.title) s.title = p.title;
        if (p.title_locked) s.title_locked = true;
        if (p.turn_started_at) s.turn_started_at = p.turn_started_at;
        if (p.usage) s.usage = p.usage;
        if (p.todos) s.todos = p.todos;
        if (p.subagents) s.subagents = p.subagents;
        if ((p as { relay_session_id?: string }).relay_session_id) s.relay_session_id = (p as { relay_session_id?: string }).relay_session_id!;
        if ((p as { permission_mode?: SessionState["permission_mode"] }).permission_mode) s.permission_mode = (p as { permission_mode?: SessionState["permission_mode"] }).permission_mode;
        break;
      }
      case "SESSION_WAITING": {
        s.status = "WAITING";
        s.waiting_request = e.payload as SessionState["waiting_request"];
        break;
      }
      case "SESSION_WAITING_RESOLVED": {
        s.status = "WORKING";
        s.waiting_request = undefined;
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
        rs.logs.push({
          ts: e.ts, kind: p.kind, text: p.text, tool: p.tool,
          full: p.full, id: p.id, detail: p.detail, diff: p.diff,
        });
        if (rs.logs.length > 500) rs.logs.splice(0, rs.logs.length - 500);
        break;
      }
      default:
        break; // HEARTBEAT 等
    }
  }

  // 非终态会话：Relay 重启时被中断，标记 ERROR
  for (const rs of out.values()) {
    if (rs.state.status === "WORKING" || rs.state.status === "WAITING") {
      rs.state.status = "ERROR";
      rs.state.last_error = "Relay 重启，会话中断";
      rs.state.historical = true;
      rs.logs.push({ ts: Date.now(), kind: "system", text: "Relay 重启，会话中断" });
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
