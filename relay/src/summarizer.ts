import type { FileChangeStats } from "./types.js";

const MAX_SUMMARY = 80;

export function basename(p: unknown): string {
  if (typeof p !== "string") return "";
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export function truncate(s: string, n = MAX_SUMMARY): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
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
