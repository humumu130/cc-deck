export function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

export function fmtClock(ts: number): string {
  if (!ts) return "--:--";
  const t = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

export function sessionElapsed(s: { status: string; duration_ms?: number; historical?: boolean; started_at: number; updated_at: number }): number {
  if (s.status === "DONE" && s.duration_ms) return s.duration_ms;
  if (s.historical || s.status === "ERROR") return s.updated_at - s.started_at;
  return Date.now() - s.started_at;
}

export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
