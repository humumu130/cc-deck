export function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

export function fmtTok(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function fmtClock(ts: number): string {
  if (!ts) return "--:--";
  const t = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

// 消息时间戳：HH:mm（无秒，逐条角标用）
export function fmtHM(ts: number): string {
  if (!ts) return "";
  const t = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getHours())}:${p(t.getMinutes())}`;
}

// #300 [待确认] 标记（含全角〔〕【】变体，与全局 hooks/网页端同款正则）：
// CLI 任务标题约定带 "#NNN [待确认] …" 形态——标记与任务号前缀共存，故用包含
// 匹配而非行首。pending + 含标记 = 等用户确认的事项，列表顶部常驻横幅的数据源
const CONFIRM_RE = /[〔\[【]\s*待确认\s*[〕\]】]/;
export function isConfirmTodo(t: { content?: string; status?: string }): boolean {
  return t.status === "pending" && CONFIRM_RE.test(t.content ?? "");
}

// 跨天分隔线标签：MM-DD
export function dayKey(ts: number): string {
  if (!ts) return "";
  const t = new Date(ts);
  return `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

export function sessionElapsed(s: { status: string; duration_ms?: number; historical?: boolean; started_at: number; updated_at: number }): number {
  if (s.status === "DONE" && s.duration_ms) return s.duration_ms;
  if (s.historical || s.status === "ERROR") return s.updated_at - s.started_at;
  return Date.now() - s.started_at;
}

// 上下文水位条：水位与上限均由 relay 下发（context_usage/context_limit），
// 上限按模型在 relay 集中维护（glm-5.x 1M / 其余 200k），端上只兜底缺省
export const CONTEXT_LIMIT_FALLBACK = 200_000;

export function contextPct(used: number, limit: number): number {
  return Math.min(100, Math.round((used / limit) * 100));
}

// 占用分级（配色键）：<60% 正常 / <85% 偏高 / ≥85% 紧张，两端（手机/网页）阈值一致
export function contextLevel(used: number, limit: number): "done" | "working" | "waiting" {
  const p = used / limit;
  if (p < 0.6) return "done";
  if (p < 0.85) return "working";
  return "waiting";
}

// 源显示名（用户规则 2026-09-06，与网页端 srcDisplayName 同款）：
// 自定义名优先；缺省名（hostOf 的 IP:port 样式）显示"源+末段数字"；本机回环显示"本机"。
// #306 起待确认悬浮清单的会话名也走同规则缩写（IP 形态标题同样收短）
export function displaySrcName(name: string | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "?";
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(n)) return "本机";
  const m = n.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d+)?$/);
  if (m) return `源${m[4]}`;
  return n;
}

export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
