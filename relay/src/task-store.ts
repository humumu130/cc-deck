// Claude Code 任务存储直读：单一事实源 ~/.claude/tasks/<cli_session_id>/<id>.json
//（按会话目录天然隔离）。旧旁路（transcript 解析 TodoWrite/TaskCreate 的 TaskTracker）
// 降级为兼容回退——跨会话聚合/陈旧快照污染的根治点（#206）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TodoItem } from "./types.js";

// 返回 null = 该会话无任务目录（旧版 CLI/其他形态），调用方走 transcript 回退；
// [] = 目录存在但为空（任务全删/清空）——权威空态，直接清空而非回退
export function readTaskStoreTodos(cliSessionId: string): TodoItem[] | null {
  const dir = path.join(homedir(), ".claude", "tasks", cliSessionId);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const out: TodoItem[] = [];
  for (const f of files) {
    try {
      const fp = path.join(dir, f);
      const t = JSON.parse(readFileSync(fp, "utf-8")) as { id?: unknown; subject?: unknown; status?: unknown; activeForm?: unknown };
      if (t.status === "deleted") continue; // 显式删除的任务不复活成 pending
      const subject = typeof t.subject === "string" ? t.subject.trim() : "";
      if (!subject) continue;
      const status = t.status === "in_progress" || t.status === "completed" ? t.status : "pending";
      const activeForm = typeof t.activeForm === "string" && t.activeForm.trim() ? { active_form: t.activeForm.trim().slice(0, 120) } : {};
      // 任务号优先取文件内 id 字段；不可解析（缺失/非数字/0）回退文件名数字
      const parsed = Number(t.id);
      const id = ((Number.isFinite(parsed) && parsed > 0 ? parsed : 0) || Number(f.replace(/[^0-9]/g, "")) || 0);
      out.push({ id: id || undefined, content: subject.slice(0, 120), status, updated_at: statSync(fp).mtimeMs, ...activeForm });
    } catch {}
  }
  out.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return out;
}
