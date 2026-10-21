// 任务 hook 共享库：从会话转录（JSONL）重建内置任务清单的最新状态。
// 移植自 cc-deck relay 的 TaskTracker（relay/src/summarizer.ts）——同一套解析
// 语义（TodoWrite 全量快照 + TaskCreate/TaskUpdate 增量、tool_result 回填真实
// taskId），保证 hook 看到的清单与手机端"任务" tab 同源同值。
//
// ⚠ 已知边界（官方文档核实）：任务状态没有稳定的磁盘接口，转录是唯一渠道，且
// 异步写入可能滞后当前轮——Stop 时刻末次任务更新偶有未落盘，hook 容忍轻微滞后。
// 另：CLI 会话的工具集若不含 todo 工具（如部分第三方模型端点），转录里不会有
// 任务调用，两 hook 均静默放行/不注入。

import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { join, } from "node:path";
import { homedir } from "node:os";

// 统一入口：权威任务存储优先，转录解析回退
export async function readTasks(input) {
  const sid = input.session_id;
  if (sid) {
    const store = readTaskStore(String(sid));
    if (store) {
      return { tasks: store };
    }
  }
  if (!input.transcript_path) return { tasks: [] };
  const tr = await readTasksFromTranscript(input.transcript_path);
  return tr;
}
import { createInterface } from "node:readline";

// 两代工具名（与 relay bridge.ts 的识别集一致）
const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
// 豁免标记（CLAUDE.md 任务调度准则第 6 条）：不计入强制执行范围
const EXEMPT_RE = /^(\[搁置\]|\[常驻\])|parked/i;

export function isExempt(text) {
  return EXEMPT_RE.test(text ?? "");
}

// TodoWrite 输入 → 标准条目（content/status/active_form）
function parseTodoList(input) {
  const raw = (input ?? {}).todos;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const content = typeof t?.content === "string" ? t.content.trim() : "";
    if (!content) continue;
    const status = ["pending", "in_progress", "completed"].includes(t?.status) ? t.status : "pending";
    out.push({
      id: typeof t?.id === "number" ? t.id : undefined,
      content: content.slice(0, 120),
      status,
      ...(typeof t?.activeForm === "string" && t.activeForm.trim() ? { active_form: t.activeForm.trim().slice(0, 120) } : {}),
    });
  }
  return out;
}

// TaskTracker（端口版，语义对齐 relay/src/summarizer.ts:468）
export class TaskTracker {
  constructor() {
    this.tasks = [];
    this.unconfirmed = [];
  }
  feed(tool, input) {
    if (tool === "TodoWrite") {
      this.tasks = parseTodoList(input).map((t) => ({ ...t }));
      this.unconfirmed = [];
      return true;
    }
    if (tool === "TaskCreate") {
      const t = input ?? {};
      const subject = typeof t.subject === "string" ? t.subject.trim() : "";
      if (!subject) return false;
      const activeForm = typeof t.activeForm === "string" ? t.activeForm.trim() : "";
      this.tasks.push({
        content: subject.slice(0, 120),
        status: "pending",
        ...(activeForm ? { active_form: activeForm.slice(0, 120) } : {}),
      });
      this.unconfirmed.push(this.tasks.length - 1);
      return true;
    }
    if (tool === "TaskUpdate") {
      const t = input ?? {};
      const id = Number(String(t.taskId ?? "").replace(/[^0-9]/g, ""));
      const task = this.tasks.find((x) => x.id === id);
      if (!task) return false;
      let changed = false;
      if (["pending", "in_progress", "completed"].includes(t.status)) {
        task.status = t.status;
        changed = true;
      } else if (t.status === "cancelled") {
        task.status = "completed"; // 展示口径：取消视作已结束（与 relay 同）
        changed = true;
      } else if (t.status === "deleted") {
        this.tasks.splice(this.tasks.indexOf(task), 1);
        return true;
      }
      if (typeof t.activeForm === "string" && t.activeForm.trim()) {
        task.active_form = t.activeForm.trim().slice(0, 120);
        changed = true;
      }
      return changed;
    }
    return false;
  }
  // TaskCreate 的 tool_result {task:{id,subject}}：回填真实任务号（串行一一对应，FIFO）
  feedResult(result) {
    const t = result?.task;
    const id = Number(String(t?.id ?? "").replace(/[^0-9]/g, ""));
    if (!t || !id) return false;
    const idx = this.unconfirmed.shift();
    if (idx === undefined || !this.tasks[idx]) return false;
    this.tasks[idx].id = id;
    return true;
  }
}

// tool_result.content 归一为可解析对象：字符串直接 JSON.parse；分块数组取 text 拼接
function resultContent(result) {
  const c = result?.content;
  if (typeof c === "string") {
    try { return JSON.parse(c); } catch { return null; }
  }
  if (Array.isArray(c)) {
    const text = c.filter((b) => b?.type === "text").map((b) => b.text).join("");
    try { return JSON.parse(text); } catch { return null; }
  }
  return null;
}

// 权威存储优先（对齐 relay #206）：CLI 任务状态真实落盘在 ~/.claude/tasks/<sid>/<id>.json
// （relay/src/task-store.ts 同源），命中则不必解析转录；目录不存在（旧版 CLI/被裁工具
// 的会话）回退转录解析。返回统一 TodoItem[]（status/content/active_form）
export function readTaskStore(cliSessionId) {
  const dir = join(homedir(), ".claude", "tasks", cliSessionId);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null; // 无目录 → 回退
  }
  const out = [];
  for (const f of files) {
    try {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (t.status === "deleted") continue;
      const subject = typeof t.subject === "string" ? t.subject.trim() : "";
      if (!subject) continue;
      out.push({
        content: subject.slice(0, 120),
        status: ["in_progress", "completed"].includes(t.status) ? t.status : "pending",
        ...(typeof t.activeForm === "string" && t.activeForm.trim() ? { active_form: t.activeForm.trim().slice(0, 120) } : {}),
      });
    } catch {}
  }
  return out;
}

// 流式扫转录，返回 TaskTracker（已重放至文件末尾）。大文件只对含任务工具名的行
// 做 JSON.parse（与 relay bridge.ts 的快路径同法）。
export async function readTasksFromTranscript(transcriptPath) {
  const tr = new TaskTracker();
  const useIdToTool = new Map(); // tool_use id -> 工具名（配对 result 用）
  let rl;
  try {
    rl = createInterface({ input: createReadStream(transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  } catch {
    return tr;
  }
  for await (const line of rl) {
    if (!line.includes("TodoWrite") && !line.includes("TaskCreate") && !line.includes("TaskUpdate")) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const blocks = e?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "tool_use" && TASK_TOOLS.has(b.name)) {
        useIdToTool.set(b.id, b.name);
        tr.feed(b.name, b.input);
      } else if (b?.type === "tool_result" && useIdToTool.get(b.tool_use_id) === "TaskCreate") {
        tr.feedResult(resultContent(b));
      }
    }
  }
  return tr;
}

// 可执行待办：pending/in_progress 且不带豁免标记
export function actionable(tr) {
  return tr.tasks.filter((t) => (t.status === "pending" || t.status === "in_progress") && !isExempt(t.content));
}

// 单行摘要（注入用）：保持紧凑，上限 8 条 + 溢出行
export function summarize(list) {
  const lines = list.slice(0, 8).map((t) => `- [${t.status === "in_progress" ? "进行中" : "待办"}] ${t.content}`);
  if (list.length > 8) lines.push(`- …另有 ${list.length - 8} 条`);
  return lines.join("\n");
}

// 读 stdin 的 hook 输入 JSON
export function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
    process.stdin.on("error", () => resolve({}));
  });
}
