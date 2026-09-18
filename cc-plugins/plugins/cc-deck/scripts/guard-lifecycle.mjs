#!/usr/bin/env node
// CC Deck 插件 · PostToolUse 任务生命周期守卫（matcher：TaskCreate|TaskUpdate|TaskDelete）。
// 缘起（2026-09-18）：任务面板更新长期靠模型自觉，攒到轮末批量记账导致频繁滞后、
// 用户需三催。本守卫把"状态变化点"变成机械注入点——每次任务增/删/改（含标完成、
// 开始、改描述）后，立即重读权威任务存储（~/.claude/tasks/<sid>/，relay 同源），
// 注入：①本次变更回执 ②此刻该做的调度动作（FIFO 拉单/连锁解锁/汇报）③变更后
// 的完整待办面板。清单就在眼前，滞后一眼可见，记账从自觉变反射。
//
// 与 guard-stop/guard-context 的差异：不要求会话已桥接——任务存储是本地事实，
// 桥接与否不影响清单正确性；配置沿用 taskGuard 键（任务调度守卫家族开关）。
// stdout（PostToolUse 契约）整块注入上下文；任何异常静默退出不干扰 CLI。
import { readFileSync } from "node:fs";
import { readConfig, readAllTasks, isPidAlive, readCliPid } from "./guard-lib.mjs";

const input = (() => {
  try { return JSON.parse(readFileSync(0, "utf-8")); } catch { return {}; }
})();

// 注意：不设 CCR_RELAY_CHILD 豁免（与 guard-context 不同）——那些守卫拦的是
// 托管会话会产生副作用的动作（Stop 拦截空转推送 / notify POST / 回合状态机）；
// 本守卫只读本地任务存储 + stdout 注入，零副作用，而托管会话（手机/网页驱动）
// 恰是任务面板最直接的消费端，最该同步。

const sid = String(input.session_id || "");
const tool = String(input.tool_name || "");
if (!sid || !/^Task(Create|Update|Delete)$/.test(tool)) process.exit(0);
if (!readConfig().taskGuard) process.exit(0);

// ---------- 变更回执（从 tool_input/tool_response 提炼一句话） ----------
const ti = input.tool_input ?? {};
const resp = typeof input.tool_response === "string" ? input.tool_response : "";
const respId = (/#(\d+)/.exec(resp) || [])[1];
const tid = String(ti.taskId ?? respId ?? "").replace(/[^0-9]/g, "");

let echo;
if (tool === "TaskCreate") {
  echo = `+新任务已入单（FIFO 排队，P0 先行；不打断进行中的任务，做完手头再拉）`;
} else if (tool === "TaskUpdate" && ti.status === "in_progress") {
  echo = `#${tid} → 进行中。开工纪律：先 TaskGet 读最新描述；进度/结论随手写回 description，别攒到轮末`;
} else if (tool === "TaskUpdate" && ti.status === "completed") {
  echo = `#${tid} → 已完成。连锁检查：它 blocks 的任务是否就此解锁；下一步 TaskList 取下一条（FIFO/P0 先行）或向用户汇报`;
} else if (tool === "TaskUpdate" && ti.status === "deleted") {
  echo = `#${tid} → 已删除`;
} else if (tool === "TaskUpdate") {
  echo = `#${tid} 内容已更新（描述/优先级写回完成）`;
} else {
  echo = `任务清单结构变更（${tool}）`;
}

// ---------- 变更后面板：重读权威存储 ----------
const EXEMPT_RE = /^[〔\[【]\s*(搁置|常驻)\s*[〕\]】]/;
const isExempt = (t) =>
  EXEMPT_RE.test(String(t.subject || "").trim()) ||
  EXEMPT_RE.test(String(t.description || "").trim()) ||
  /\bparked\b/i.test(String(t.subject || "") + " " + String(t.description || ""));

const all = readAllTasks(sid);
const byNum = new Map(all.map((t) => [String(t.id), t]));
const openIds = new Set(
  all.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => String(t.id)),
);
const open = all
  .filter((t) => openIds.has(String(t.id)))
  .filter((t) => {
    if (isExempt(t)) return false;
    const blk = Array.isArray(t.blockedBy) ? t.blockedBy : [];
    return !blk.some((b) => openIds.has(String(b)));
  })
  .sort((a, b) => Number(a.id) - Number(b.id));

// 完成解锁检测：刚关掉的 #tid 若是某些任务的最后一块挡板，点名提醒
let unlocked = "";
if ((tool === "TaskUpdate" && (ti.status === "completed" || ti.status === "deleted")) || tool === "TaskDelete") {
  const freed = open
    .filter((t) => (Array.isArray(t.blockedBy) ? t.blockedBy : []).map(String).includes(tid))
    .map((t) => `#${t.id} ${String(t.subject || "").slice(0, 40)}`);
  if (freed.length) unlocked = `\n🔓 解锁：${freed.slice(0, 3).join("；")}${freed.length > 3 ? ` 等 ${freed.length} 条` : ""}`;
}

// 多任务并行悬挂：>1 条 in_progress 常是"做完没关"的漏（并行意图除外，点名即可）
const running = open.filter((t) => t.status === "in_progress");
const hangNote =
  running.length > 1
    ? `\n⚠ 同时 ${running.length} 条进行中（#${running.map((t) => t.id).join(" #")}）——确认是并行意图，还是做完没关？`
    : "";

const lines = open.slice(0, 12).map((t) =>
  `#${t.id}${t.status === "in_progress" ? "（进行中）" : ""} ${String(t.subject || "").slice(0, 46)}`,
);
const more = open.length > 12 ? `\n…另有 ${open.length - 12} 条` : "";
const panel = lines.length
  ? `当前待办 ${open.length} 条：\n${lines.join("\n")}${more}`
  : `当前待办 0 条——清单已清空；按需向用户汇报收尾，勿凭空造单。`;

process.stdout.write(`【任务面板|${echo}】${unlocked}${hangNote}\n${panel}\n`);
process.exit(0);
