// 定时任务读取：CLI 会话的 <cwd>/.claude/scheduled_tasks.json
// （Claude Code CronCreate durable=true 落盘；官方未公开 schema，衍生分支
// 字段为 id/cron/prompt/status/recurring/humanSchedule）。宽容解析隔离
// 版本差异：顶层数组与对象 map 双形态、字段多名兼容，异常返回 undefined。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CronTask } from "./types.js";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

// 毫秒时间戳：数字直用；ISO 字符串 Date.parse；纯数字字符串 Number
function tsNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.trim()) {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function normalizeTask(raw: unknown, fallbackId: string): CronTask | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const status = str(o.status);
  if (status === "deleted") return null; // 软删除条目不展示
  const rawId = str(o.id) ?? str(o.taskId);
  const prompt = str(o.prompt) ?? str(o.command) ?? str(o.task) ?? str(o.instruction) ?? str(o.message) ?? "";
  const schedule = str(o.humanSchedule) ?? str(o.schedule) ?? str(o.cron) ?? str(o.interval) ?? str(o.expression) ?? "";
  const name = str(o.name) ?? str(o.title) ?? str(o.label);
  // 识别不出任何任务字段（如 {jobs:[...]} 异名包装的包装对象本身）→ 幽灵条目，丢弃
  if (!prompt && !schedule && !name && !rawId) return null;
  const paused =
    o.paused === true || o.enabled === false || o.active === false ||
    status === "paused" || status === "expired";
  const next = tsNum(o.next_run_at ?? o.nextRunAt ?? o.next_run ?? o.nextExecutionAt);
  return {
    id: rawId ?? fallbackId,
    name: name ?? (prompt ? prompt.slice(0, 40) : schedule || "未命名任务"),
    prompt,
    schedule,
    ...(next !== undefined ? { next_run_at: next } : {}),
    ...(paused ? { paused: true } : {}),
    ...(o.recurring === false ? { recurring: false } : {}),
  };
}

// 三态：undefined = 文件不存在（视为清空候选）；"bad" = 文件在但读/解析失败
// （非原子写入读到半截 JSON：保留旧值等下一轮，避免误发清空再回填的闪烁）；
// 数组 = 解析结果（空数组 = 已清空，触发客户端清空展示）
export function readCronTasks(cwd: string): CronTask[] | "bad" | undefined {
  let text: string;
  try {
    text = readFileSync(join(cwd, ".claude", "scheduled_tasks.json"), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "bad";
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return "bad";
  }
  let entries: [string, unknown][];
  if (Array.isArray(root)) {
    entries = root.map((r, i) => [String(i), r]);
  } else if (root && typeof root === "object") {
    const wrapped = (root as Record<string, unknown>).tasks;
    entries = Array.isArray(wrapped)
      ? wrapped.map((r, i) => [String(i), r])
      : Object.entries(root as Record<string, unknown>);
  } else {
    return "bad"; // 文件在但根形态不可识别（字符串/数字等）：保留旧值
  }
  const out: CronTask[] = [];
  for (const [key, raw] of entries) {
    const t = normalizeTask(raw, key);
    if (t) out.push(t);
  }
  return out;
}

// 变化检测用：归一化结果的稳定序列化
export function cronTasksKey(tasks: CronTask[]): string {
  return JSON.stringify(tasks);
}
