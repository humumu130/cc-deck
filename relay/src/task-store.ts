// Claude Code 任务存储直读：单一事实源 ~/.claude/tasks/<cli_session_id>/<id>.json
//（按会话目录天然隔离）。旧旁路（transcript 解析 TodoWrite/TaskCreate 的 TaskTracker）
// 降级为兼容回退——跨会话聚合/陈旧快照污染的根治点（#206）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TodoItem } from "./types.js";

// 返回 null = 该会话无任务目录（旧版 CLI/其他形态），调用方走 transcript 回退
export function readTaskStoreTodos(cliSessionId: string): TodoItem[] | null {
  const dir = path.join(homedir(), ".claude", "tasks", cliSessionId);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const out: (TodoItem & { n: number })[] = [];
  for (const f of files) {
    try {
      const fp = path.join(dir, f);
      const t = JSON.parse(readFileSync(fp, "utf-8")) as { subject?: unknown; status?: unknown; activeForm?: unknown };
      const subject = typeof t.subject === "string" ? t.subject.trim() : "";
      if (!subject) continue;
      const status = t.status === "in_progress" || t.status === "completed" ? t.status : "pending";
      const activeForm = typeof t.activeForm === "string" && t.activeForm.trim() ? { active_form: t.activeForm.trim().slice(0, 120) } : {};
      out.push({ n: Number(f.replace(/[^0-9]/g, "")) || 0, content: subject.slice(0, 120), status, updated_at: statSync(fp).mtimeMs, ...activeForm });
    } catch {}
  }
  if (!out.length) return null;
  out.sort((a, b) => a.n - b.n);
  return out.map(({ n: _n, ...rest }) => rest);
}
