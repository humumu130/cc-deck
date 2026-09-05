import type { AskQuestion, FileChangeStats, TodoItem } from "./types.js";

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

// 匹配键：CLI 会把多条排队消息合并成一条（"\r" 连接），且消息内换行折叠为空格、
// 各处截断上限不一——精确比对会把同一批消息认成多条。统一折叠空白 + 300 截断。
// bridge（排队消息配对）与 todo-hidden（任务条目隐藏匹配）共用，勿复制两份漂移
export function normKey(text: string): string {
  return truncate(text.trim(), 300).replace(/\s+/g, " ");
}

// 全文上限：防单条超长回复撑爆 300 条日志缓冲与 SNAPSHOT
export const FULL_TEXT_CAP = 10_000;

// 原文：仅当摘要会截断（len > summaryCap）时返回，否则 undefined（text 即全文）
export function fullText(s: string, summaryCap: number): string | undefined {
  const one = normLines(s);
  if (one.length <= summaryCap) return undefined;
  return one.length <= FULL_TEXT_CAP ? one : one.slice(0, FULL_TEXT_CAP - 1) + "…";
}

// AskUserQuestion 输入解析（managed canUseTool / external PreToolUse 共用）；
// 防御性截断：问题≤4、选项≤6（协议层越界数据不炸客户端）
export function parseAskQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw.slice(0, 4)) {
    if (!q || typeof q !== "object") continue;
    const qq = q as Record<string, unknown>;
    const question = typeof qq.question === "string" ? qq.question.trim() : "";
    if (!question) continue;
    const options: AskQuestion["options"] = [];
    for (const o of Array.isArray(qq.options) ? qq.options.slice(0, 6) : []) {
      if (!o || typeof o !== "object") continue;
      const label = String((o as Record<string, unknown>).label ?? "").trim();
      if (!label) continue;
      const desc = (o as Record<string, unknown>).description;
      options.push({
        label: label.slice(0, 60),
        ...(typeof desc === "string" && desc.trim() ? { description: desc.trim().slice(0, 120) } : {}),
      });
    }
    out.push({
      header: (typeof qq.header === "string" ? qq.header.trim().slice(0, 24) : "") || question.slice(0, 24),
      question: question.slice(0, 200),
      multi: qq.multiSelect === true,
      options,
    });
  }
  return out;
}

// 作答 -> deny message（spike-askuser 验证：deny message 作为 tool_result 回给模型，模型按答案继续；
// allow+updatedInput.answers 会被 SDK 忽略并返回 "user did not answer"）
export function buildAnswerMessage(questions: AskQuestion[] | undefined, answers: string[]): string {
  if (!questions || questions.length === 0) {
    return `用户回答：「${answers[0] ?? ""}」`;
  }
  if (questions.length === 1) {
    return `用户回答：「${answers[0] ?? "（未作答）"}」`;
  }
  return (
    "用户的回答：" +
    questions.map((q, i) => `「${q.header}」→「${answers[i] ?? "（未作答）"}」`).join("；")
  );
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

// ---------- P2 结构化转录：工具完整输入/输出 + diff 行 ----------

const MAX_DETAIL = 4_000;

export function capDetail(s: string, n = MAX_DETAIL): string {
  return s.length <= n ? s : s.slice(0, n - 1) + `… (+${s.length - n} 字符)`;
}

// ---------- z.ai 内置工具桥识别 ----------
// z.ai 端把 MCP 工具调用/结果伪装成 assistant text block 注入对话流（"**🌐 Z.ai
// Built-in Tool: xxx**" + Input JSON / "**Output:** xxx_result_summary: [...]"）。
// 对用户是纯过程噪声且常带超长 CDN URL 与字面 \n 的 JSON 数组——归类为工具类
// 日志，客户端"消息"视图只按 kind 过滤即自动隐藏，无需四端改动
export function zaiToolName(text: string): string | null {
  const m = /^\*\*🌐 Z\.ai Built-in Tool: ([^\s*]+)\*\*/.exec(text.trimStart());
  return m ? `zai:${m[1]}` : null;
}

// 收紧：要求次行即 "**<tool>_result_summary" 键，避免讨论该格式本身的正文被误判
export function isZaiOutput(text: string): boolean {
  return /^\*\*Output:\*\*\s*\n\*\*[\w.-]+_result_summary/.test(text.trimStart());
}

// 流式期间的 zai 桥文本拦截（块未送达完整，只看前缀；终态由上面两函数精确归类）。
// 双向前缀：缓冲是标记的子前缀（"*"、"**"、"**Outp"…）时也静默——tokenizer 会把
// "**🌐" 切进多个 delta，首 delta 只含 "*" 若放行会漏出且终态重分类后成永久孤儿气泡；
// 正文以 * 开头时仅首个节流 tick 被静默，后续 tick / 终态必补发，无丢失
export function zaiBridgePrefix(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("**🌐") || t.startsWith("**Output:**") || "**🌐".startsWith(t) || "**Output:**".startsWith(t);
}

// ---------- #265 混合形态拆分 ----------
// z.ai 会把内置工具桥文本（调用→Input→*Executing*→Output）直接 append 到正文
// 同一条 text 块（"正文...**🌐 Z.ai Built-in Tool: xxx**..."），行首整块识别
// （zaiToolName/isZaiOutput）对混合形态不命中，Input JSON 与结果全文随
// assistant_text 漏进"消息"视图。按行状态机切段：桥段归工具日志，前后正文保留。
// 锚点要求完整行形态（Built-in 整行 / Output 整行 + 次行 summary 键），
// "讨论该格式"的正文（反引号包裹、行中引用）不会误拆。
export interface ZaiSeg {
  kind: "tool_use" | "tool_result";
  tool: string; // tool_use 为 "zai:<name>"，tool_result 恒 "zai"
  raw: string;
}

const RE_ZAI_CALL_ANY = /\*\*🌐 Z\.ai Built-in Tool: ([^\s*]+)\*\*/;
const RE_FENCE_LINE = /^(```|~~~)/;
const RE_ZAI_OUT_LINE = /^\*\*Output:\*\*$/;
const RE_ZAI_SUMMARY_LINE = /^\*\*[\w.-]+_result_summary\b/;

export function splitZaiText(text: string): { body: string; segs: ZaiSeg[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const bodyLines: string[] = [];
  const segs: ZaiSeg[] = [];
  let cur: { kind: ZaiSeg["kind"]; tool: string; lines: string[] } | null = null;
  let inFence = false; // 正文区围栏跟踪：``` 代码块内演示桥格式属于正文，识别会让悬空段吞掉后续正文
  const flush = () => {
    if (!cur) return;
    const raw = cur.lines.join("\n").trim();
    if (raw) segs.push({ kind: cur.kind, tool: cur.kind === "tool_use" ? cur.tool : "zai", raw });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    // 围栏只在正文区开关：桥段内 Input JSON 的 ```json 包裹是段内容，不参与跟踪
    if (!cur && RE_FENCE_LINE.test(l)) {
      inFence = !inFence;
      bodyLines.push(lines[i]);
      continue;
    }
    if (!cur && inFence) {
      bodyLines.push(lines[i]);
      continue;
    }
    // 调用锚行内匹配：z.ai append 时标记与正文同行（"正文。**🌐...**"），
    // 标记前文本归正文；标记两侧紧贴反引号 = 正文引用格式讨论，不拆
    const m = RE_ZAI_CALL_ANY.exec(l);
    const afterCh = m ? l[m.index + m[0].length] : "";
    if (m && l[m.index - 1] !== "`" && afterCh !== "`") {
      flush();
      const before = l.slice(0, m.index).trim();
      if (before) bodyLines.push(before);
      cur = { kind: "tool_use", tool: `zai:${m[1]}`, lines: [l.slice(m.index)] };
      continue;
    }
    if (RE_ZAI_OUT_LINE.test(l) && RE_ZAI_SUMMARY_LINE.test((lines[i + 1] ?? "").trim())) {
      flush(); // 调用段终结，开输出段
      cur = { kind: "tool_result", tool: "zai", lines: [lines[i]] };
      continue;
    }
    if (cur) {
      cur.lines.push(lines[i]);
      // 输出段在 summary 行（单行 JSON 数组，字面 \n 不折行）后结束，回到正文
      if (cur.kind === "tool_result" && RE_ZAI_SUMMARY_LINE.test(l)) flush();
    } else {
      bodyLines.push(lines[i]);
    }
  }
  flush(); // 无 Output 跟随的悬空调用段：整段归工具日志（桥截断时不把标记漏回正文）
  return { body: bodyLines.join("\n").trim(), segs };
}

// 工具入参详情（CLI 体感：$ 命令 / 文件路径+old→new / 搜索式…），无实质内容返回 undefined
export function detailToolUse(tool: string, input: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
  switch (tool) {
    case "Bash":
      return capDetail([`$ ${s("command")}`, s("description") ? `# ${s("description")}` : ""].filter(Boolean).join("\n"));
    case "Edit":
      return capDetail(
        [s("file_path") || "文件", "──── 旧 ────", s("old_string"), "──── 新 ────", s("new_string")].join("\n"),
        3_000,
      );
    case "Write":
      return capDetail([s("file_path") || "文件", s("content")].join("\n"));
    case "Read": {
      const parts = [s("file_path"), input.offset ? `offset ${input.offset}` : "", input.limit ? `limit ${input.limit}` : ""];
      const j = parts.filter(Boolean).join(" · ");
      return j || undefined;
    }
    case "Grep":
      return [`"${s("pattern")}"`, s("path") || s("glob") || "", input.i === true ? "-i" : ""].filter(Boolean).join(" · ") || undefined;
    case "Glob":
      return [s("pattern"), s("path")].filter(Boolean).join(" · ") || undefined;
    case "Agent":
      return capDetail([s("description"), s("prompt")].filter(Boolean).join("\n"), 1_500) || undefined;
    case "WebFetch":
      return capDetail([s("url"), s("prompt")].filter(Boolean).join("\n"), 1_000) || undefined;
    case "WebSearch":
      return s("query") || undefined;
    default: {
      // 键值行式渲染替代裸 JSON.stringify：保留真实换行，字面 \n 不再出现在卡片里
      try {
        const lines = Object.entries(input)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        if (!lines.length) return undefined;
        return capDetail(lines.join("\n"), 2_000);
      } catch {
        return undefined;
      }
    }
  }
}

// 工具输出全文（text 即全文时不需要 detail）
export function detailToolResult(content: unknown): string | undefined {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  else if (content && typeof content === "object" && "text" in content)
    text = String((content as { text: unknown }).text);
  const one = normLines(text);
  return one.length > 160 ? capDetail(one) : undefined;
}

// Edit/Write 结果的 structuredPatch -> 带行首 +/- 的 diff 行（手机端着色渲染）
export function diffLines(result: unknown): string[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { structuredPatch?: unknown; filePath?: unknown; file_path?: unknown; content?: unknown };
  const file = typeof r.filePath === "string" ? r.filePath : typeof r.file_path === "string" ? r.file_path : "";
  const out: string[] = [];
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) {
    if (file) out.push(`@@ ${file}`);
    for (const h of r.structuredPatch as { lines?: unknown }[]) {
      if (!h || !Array.isArray(h.lines)) continue;
      for (const l of h.lines) if (typeof l === "string") out.push(l);
    }
  } else if (typeof r.content === "string" && r.content.length > 0) {
    // 新建文件：无旧内容，全文即新增
    if (file) out.push(`@@ ${file} (新文件)`);
    const lines = r.content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const l of lines) out.push("+" + l);
  } else {
    return undefined;
  }
  if (out.length === 0) return undefined;
  return out.length > 400 ? [...out.slice(0, 400), `… (+${out.length - 400} 行)`] : out;
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
      } else if (status === "deleted") {
        // TaskUpdate(status=deleted) = 永久移除：清单里直接拿掉
        const i = this.tasks.indexOf(task);
        if (i >= 0) this.tasks.splice(i, 1);
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
