import type { FileChangeStats, TodoItem } from "./types.js";

const MAX_SUMMARY = 80;

export function basename(p: unknown): string {
  if (typeof p !== "string") return "";
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

// 空白归一但保留换行结构：Markdown 表格/列表依赖行首标记，折叠换行会毁掉渲染
function normLines(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(s: string, n = MAX_SUMMARY): string {
  const one = normLines(s);
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

// 全文上限：防单条超长回复撑爆 300 条日志缓冲与 SNAPSHOT
export const FULL_TEXT_CAP = 10_000;

// 原文：仅当摘要会截断（len > summaryCap）时返回，否则 undefined（text 即全文）
export function fullText(s: string, summaryCap: number): string | undefined {
  const one = normLines(s);
  if (one.length <= summaryCap) return undefined;
  return one.length <= FULL_TEXT_CAP ? one : one.slice(0, FULL_TEXT_CAP - 1) + "…";
}

export function summarizeToolUse(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Edit":
      return `修改 ${basename(input.file_path) || "文件"}`;
    case "Write":
      return `写入 ${basename(input.file_path) || "文件"}`;
    case "Read":
      return `读取 ${basename(input.file_path) || "文件"}`;
    case "NotebookEdit":
      return `修改 Notebook ${basename(input.notebook_path) || ""}`;
    case "Bash":
      return `执行 ${truncate(String(input.command ?? ""), 50)}`;
    case "Grep":
      return `搜索 "${truncate(String(input.pattern ?? ""), 40)}"`;
    case "Glob":
      return `匹配 ${truncate(String(input.pattern ?? ""), 40)}`;
    case "WebFetch":
      return `抓取 ${truncate(String(input.url ?? ""), 50)}`;
    case "WebSearch":
      return `联网搜索 ${truncate(String(input.query ?? ""), 50)}`;
    case "Agent":
      return `子代理 ${truncate(String(input.description ?? input.prompt ?? ""), 40)}`;
    default:
      return tool;
  }
}

// 工具输出压缩：优先报错行，其次成功标志行（✓/passed/built...），否则取末行
export function summarizeToolResult(content: unknown): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .join("\n");
  } else if (content && typeof content === "object" && "text" in content) {
    text = String((content as { text: unknown }).text);
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "(空输出)";

  const errLines = lines.filter((l) => /error|failed|✗|denied|exception/i.test(l)).slice(0, 2);
  if (errLines.length > 0) return truncate(errLines.join(" | "), 120);

  const okLines = lines.filter((l) => /✓|✔|√|passed|built|done|complete|success|finished/i.test(l)).slice(0, 2);
  if (okLines.length > 0) return truncate(okLines.join(" | "), 120);

  return truncate(lines[lines.length - 1] ?? "", 120);
}

// 从 Edit/Write 工具结果聚合增删行统计。gitDiff 仅在 git 仓库内存在（单个对象）；
// 否则从 structuredPatch 的 diff 行数 +/-（structuredPatch 的行不含 +++/--- 头，防御排除）
export function extractDiffStats(
  result: unknown,
  stats: FileChangeStats,
  files: Set<string>,
): void {
  if (!result || typeof result !== "object") return;
  const r = result as {
    gitDiff?: unknown;
    structuredPatch?: unknown;
    filePath?: unknown;
    file_path?: unknown;
  };
  if (typeof r.filePath === "string") files.add(r.filePath);
  if (typeof r.file_path === "string") files.add(r.file_path);

  const gd = r.gitDiff;
  if (gd && typeof gd === "object" && !Array.isArray(gd)) {
    const d = gd as { filename?: unknown; additions?: unknown; deletions?: unknown };
    if (typeof d.filename === "string") files.add(d.filename);
    stats.lines_added += Number(d.additions) || 0;
    stats.lines_deleted += Number(d.deletions) || 0;
  } else if (Array.isArray(gd)) {
    for (const d of gd as { filename?: unknown; additions?: unknown; deletions?: unknown }[]) {
      if (!d || typeof d !== "object") continue;
      if (typeof d.filename === "string") files.add(d.filename);
      stats.lines_added += Number(d.additions) || 0;
      stats.lines_deleted += Number(d.deletions) || 0;
    }
  } else if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) {
    for (const hunk of r.structuredPatch as { lines?: unknown }[]) {
      if (!hunk || !Array.isArray(hunk.lines)) continue;
      for (const line of hunk.lines) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+") && !line.startsWith("+++")) stats.lines_added++;
        else if (line.startsWith("-") && !line.startsWith("---")) stats.lines_deleted++;
      }
    }
  } else if (typeof (r as { content?: unknown }).content === "string") {
    // 新建文件（type:create）没有旧内容，structuredPatch 为空数组，行数在 content 里
    const content = (r as { content: string }).content;
    if (content.length > 0) {
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      stats.lines_added += lines.length;
    }
  }
  stats.files_changed = files.size;
}

// TodoWrite 工具入参 -> 任务清单（字段形态异常时静默丢弃，上限 20 条）
export function parseTodoList(input: unknown): TodoItem[] {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return [];
  const out: TodoItem[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const content = typeof t.content === "string" ? t.content.trim() : "";
    const status = t.status;
    if (!content || (status !== "pending" && status !== "in_progress" && status !== "completed")) continue;
    const activeForm = typeof t.activeForm === "string" ? t.activeForm.trim() : "";
    out.push({
      content: content.slice(0, 120),
      status,
      ...(activeForm ? { active_form: activeForm.slice(0, 120) } : {}),
    });
    if (out.length >= 20) break;
  }
  return out;
}

// 任务清单追踪器：兼容两代工具——
//   TodoWrite（全量快照）与 TaskCreate/TaskUpdate（增量）。
//   ⚠ CLI 的 taskId 是全局递增（跨会话共享），不能按会话内创建顺序自增模拟：
//   TaskCreate 先以 id=null 入队，等其 tool_result {task:{id,subject}} 回填真实 id，
//   之后 TaskUpdate 才能命中。feed/feedResult 返回变更后的全量清单，未变更返回 null。
export class TaskTracker {
  private tasks: (TodoItem & { id: number | null })[] = [];
  private unconfirmed: number[] = []; // 已 TaskCreate 尚未收到 result 回填 id 的下标

  feed(tool: string, input: unknown): TodoItem[] | null {
    if (tool === "TodoWrite") {
      const list = parseTodoList(input);
      this.tasks = list.map((t) => ({ ...t, id: null }));
      this.unconfirmed = [];
      return this.snapshot();
    }
    if (tool === "TaskCreate") {
      const t = (input ?? {}) as { subject?: unknown; activeForm?: unknown };
      const subject = typeof t.subject === "string" ? t.subject.trim() : "";
      if (!subject) return null;
      const activeForm = typeof t.activeForm === "string" ? t.activeForm.trim() : "";
      this.tasks.push({
        id: null,
        content: subject.slice(0, 120),
        status: "pending",
        ...(activeForm ? { active_form: activeForm.slice(0, 120) } : {}),
      });
      this.unconfirmed.push(this.tasks.length - 1);
      return this.snapshot();
    }
    if (tool === "TaskUpdate") {
      const t = (input ?? {}) as { taskId?: unknown; status?: unknown; activeForm?: unknown };
      const id = Number(String(t.taskId ?? "").replace(/[^0-9]/g, ""));
      const task = this.tasks.find((x) => x.id === id);
      if (!task) return null;
      const status = t.status;
      let changed = false;
      if (status === "pending" || status === "in_progress" || status === "completed") {
        task.status = status;
        changed = true;
      } else if (status === "cancelled") {
        task.status = "completed"; // 展示口径：取消视作已结束
        changed = true;
      }
      if (typeof t.activeForm === "string" && t.activeForm.trim()) {
        task.active_form = t.activeForm.trim().slice(0, 120);
        changed = true;
      }
      return changed ? this.snapshot() : null;
    }
    return null;
  }

  // TaskCreate 的 tool_result（{task:{id,subject}}）：回填真实任务号。
  // CLI 工具串行，result 与最近的 TaskCreate 一一对应；subject 命中优先，否则 FIFO。
  feedResult(result: unknown): TodoItem[] | null {
    const t = (result as { task?: { id?: unknown; subject?: unknown } } | null)?.task;
    const id = Number(String(t?.id ?? "").replace(/[^0-9]/g, ""));
    if (!t || !id) return null;
    const idx = this.unconfirmed.shift();
    if (idx === undefined || !this.tasks[idx]) return null;
    this.tasks[idx].id = id;
    return this.snapshot();
  }

  // 重启恢复：用已知清单做种子（无任务号，TaskUpdate 无法命中旧条目，仅保展示）
  seed(todos: TodoItem[]): void {
    if (this.tasks.length || !todos.length) return;
    this.tasks = todos.map((t) => ({ ...t, id: null }));
  }

  snapshot(): TodoItem[] {
    return this.tasks.map(({ id: _id, ...rest }) => rest);
  }
}
