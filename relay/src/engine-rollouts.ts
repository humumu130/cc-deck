import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { deriveTitle } from "./history.js";
import type { LogEntry, SessionEngine, SessionStatus } from "./types.js";

export interface EngineProcessInfo {
  pid: number;
  cwd?: string;
  startedAt?: number;
  command?: string;
  threadId?: string;
}

export interface EngineRolloutProfile {
  filePath: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  status: SessionStatus;
  terminal: boolean;
  activity?: string;
  activityKind?: LogEntry["kind"];
  activityTool?: string;
  activityKey: string;
  model?: string;
  provider?: string;
  error?: string;
}

export interface EngineScanSpec {
  engine: SessionEngine;   // 收编卡的 engine 徽标值
  label: string;           // 活动文案前缀（Codex / Trae / Qwen Code / …）
  envRoot: string;         // sessions 根目录覆盖变量（测试沙盒用）
  homeDirName: string;     // 默认根 ~/.<homeDirName>/sessions
  filePattern: RegExp;     // rollout 文件名匹配（未知命名引擎放宽到任意 .jsonl）
  commandPattern: RegExp;  // ps 命令行匹配（词级，防前缀误撞）
}

const commandPatternOf = (name: string): RegExp =>
  new RegExp(`(?:^|\\s|/)${name}(?:\\.exe)?(?:\\s|$)`, "i");

export const ENGINE_SCAN_SPECS: EngineScanSpec[] = [
  { engine: "codex", label: "Codex", envRoot: "CCR_CODEX_SESSIONS_ROOT", homeDirName: ".codex", filePattern: /^rollout-.+\.jsonl$/i, commandPattern: commandPatternOf("codex") },
  { engine: "trae", label: "Trae", envRoot: "CCR_TRAE_SESSIONS_ROOT", homeDirName: ".trae", filePattern: /\.jsonl$/i, commandPattern: commandPatternOf("trae") },
  { engine: "qwen-code", label: "Qwen Code", envRoot: "CCR_QWEN_SESSIONS_ROOT", homeDirName: ".qwen", filePattern: /\.jsonl$/i, commandPattern: commandPatternOf("qwen") },
  { engine: "codebuddy", label: "CodeBuddy", envRoot: "CCR_CODEBUDDY_SESSIONS_ROOT", homeDirName: ".codebuddy", filePattern: /\.jsonl$/i, commandPattern: commandPatternOf("codebuddy") },
  { engine: "zcode", label: "ZCode", envRoot: "CCR_ZCODE_SESSIONS_ROOT", homeDirName: ".zcode", filePattern: /\.jsonl$/i, commandPattern: commandPatternOf("zcode") },
];

export function specOf(engine: SessionEngine): EngineScanSpec {
  const spec = ENGINE_SCAN_SPECS.find((item) => item.engine === engine);
  if (!spec) throw new Error(`未知引擎: ${engine}`);
  return spec;
}

export function engineRoot(spec: EngineScanSpec, home: string): string {
  return process.env[spec.envRoot] || join(home, spec.homeDirName, "sessions");
}

interface RolloutCursor {
  offset: number;
  carry: string;
  profile: EngineRolloutProfile;
}

interface RolloutRecord {
  timestamp?: unknown;
  ordinal?: unknown;
  type?: unknown;
  payload?: unknown;
}

const clip = (text: string, cap: number): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  return [...compact].length > cap ? [...compact].slice(0, cap).join("") + "…" : compact;
};

function isBootstrapPrompt(prompt: string): boolean {
  const normalized = prompt.trimStart();
  return normalized.startsWith("<environment_context>") || normalized.startsWith("<skills_instructions>");
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function eventTime(record: RolloutRecord): number | undefined {
  const numeric = finite(record.timestamp);
  if (numeric !== undefined) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  if (typeof record.timestamp === "string") {
    const parsed = Date.parse(record.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  const object = objectOf(value);
  if (typeof object.text === "string") return object.text;
  if (typeof object.message === "string") return object.message;
  if (typeof object.content === "string") return object.content;
  if (object.content !== undefined) return textOf(object.content);
  return "";
}

function sessionIdFromFile(filePath: string): string {
  const stem = basename(filePath, ".jsonl").replace(/^rollout-/, "");
  const id = /([0-9a-z]{8,}(?:-[0-9a-z]+){2,})$/i.exec(stem)?.[1];
  return id || stem || basename(filePath);
}

function initialProfile(spec: EngineScanSpec, filePath: string): EngineRolloutProfile {
  return {
    filePath,
    sessionId: sessionIdFromFile(filePath),
    cwd: "",
    prompt: "",
    title: "未命名会话",
    startedAt: 0,
    updatedAt: 0,
    status: "WORKING",
    terminal: false,
    activityKey: "",
  };
}

function eventBody(record: RolloutRecord): Record<string, unknown> {
  const payload = objectOf(record.payload);
  return Object.keys(payload).length ? payload : objectOf(record);
}

function activityFor(
  type: string,
  body: Record<string, unknown>,
  label: string,
): { text?: string; kind?: LogEntry["kind"]; tool?: string; status?: SessionStatus; terminal?: boolean; error?: string; prompt?: string } {
  const normalizedType = type.replace(/^item_/, "item.").replace(/^turn_/, "turn.");
  const item = objectOf(body.item);
  const itemType = typeof item.type === "string" ? item.type : "";
  const errorValue = body.error ?? item.error;
  const error = clip(typeof errorValue === "string" ? errorValue : textOf(errorValue), 220);
  if (normalizedType === "turn.failed" || type === "task_failed" || type === "error") {
    return { text: error || `${label} 回合失败`, kind: "system", status: "ERROR", terminal: true, error: error || `${label} 回合失败` };
  }
  if (normalizedType === "turn.completed" || type === "task_complete" || type === "task_completed") {
    return { text: `${label} 回合完成`, kind: "system", status: "DONE", terminal: true };
  }
  if (normalizedType === "turn.started" || type === "task_started") {
    return { text: `${label} 回合运行中`, kind: "system", status: "WORKING", terminal: false };
  }
  if (normalizedType === "item.started") {
    if (itemType === "command_execution") {
      const command = clip(textOf(item.command), 180);
      return { text: command ? `执行命令：${command}` : "执行命令", kind: "tool_use", tool: "command", status: "WORKING", terminal: false };
    }
    return { text: itemType ? `开始：${itemType}` : `${label} 工作中`, kind: "system", status: "WORKING", terminal: false };
  }
  if (normalizedType === "item.completed") {
    if (itemType === "UserMessage") {
      const prompt = clip(textOf(item.content), 4000);
      return { text: prompt ? `用户：${clip(prompt, 180)}` : "用户输入", kind: "user_message", status: "WORKING", terminal: false, prompt };
    }
    if (itemType === "AgentMessage") {
      const text = clip(textOf(item.content ?? item.text), 220);
      return { text: text ? `回复：${text}` : `${label} 回复`, kind: "assistant_text", status: "WORKING", terminal: false };
    }
    if (itemType === "CommandExecution") {
      const command = clip(textOf(item.command), 120);
      const failed = item.status === "failed" || (finite(item.exit_code) !== undefined && item.exit_code !== 0);
      const output = clip(textOf(item.aggregated_output), 160);
      return {
        text: failed ? `命令失败：${command || output || "未知命令"}` : `命令完成：${command || output || "command"}`,
        kind: failed ? "system" : "tool_result",
        tool: "command",
        status: failed ? "ERROR" : "WORKING",
        terminal: false,
        ...(failed ? { error: output || "命令执行失败" } : {}),
      };
    }
    if (itemType === "FileChange") {
      return { text: "文件变更完成", kind: "tool_result", status: "WORKING", terminal: false };
    }
    if (itemType) return { text: `完成：${itemType}`, kind: "system", status: "WORKING", terminal: false };
  }
  if (type === "message" || type === "response_item") {
    const role = typeof body.role === "string" ? body.role : "";
    const text = clip(textOf(body.content ?? body.text), 220);
    const prompt = role === "user" ? clip(textOf(body.content), 4000) : "";
    if (role === "user") return { text: text ? `用户：${clip(text, 180)}` : "用户输入", kind: "user_message", status: "WORKING", terminal: false, prompt };
    if (role === "assistant") return { text: text ? `回复：${text}` : `${label} 回复`, kind: "assistant_text", status: "WORKING", terminal: false };
    if (body.type === "function_call") {
      const name = clip(textOf(body.name), 100);
      return { text: name ? `调用：${name}` : "调用工具", kind: "tool_use", tool: name || "function", status: "WORKING", terminal: false };
    }
  }
  if (type === "function_call") {
    const name = clip(textOf(body.name), 100);
    return { text: name ? `调用：${name}` : "调用工具", kind: "tool_use", tool: name || "function", status: "WORKING", terminal: false };
  }
  if (type === "function_call_output") {
    return { text: "工具调用完成", kind: "tool_result", status: "WORKING", terminal: false };
  }
  return {};
}

function applyRecord(spec: EngineScanSpec, profile: EngineRolloutProfile, record: RolloutRecord): void {
  const body = eventBody(record);
  const type = typeof body.type === "string" ? body.type : typeof record.type === "string" ? record.type : "";
  const at = eventTime(record);
  if (at !== undefined) {
    profile.startedAt = profile.startedAt > 0 ? Math.min(profile.startedAt, at) : at;
    profile.updatedAt = Math.max(profile.updatedAt, at);
  }
  const meta = type === "session_meta" ? body.payload && typeof body.payload === "object" ? objectOf(body.payload) : body : body;
  const sessionId = typeof meta.session_id === "string" && meta.session_id
    ? meta.session_id
    : typeof meta.id === "string" && meta.id && type === "session_meta" ? meta.id : "";
  if (sessionId) profile.sessionId = sessionId;
  if (typeof body.thread_id === "string" && body.thread_id) profile.sessionId = body.thread_id;
  if (typeof meta.cwd === "string" && meta.cwd) profile.cwd = meta.cwd;
  if (typeof meta.model_provider === "string" && meta.model_provider) profile.provider = meta.model_provider;
  if (typeof body.model === "string" && body.model) profile.model = body.model;
  const item = objectOf(body.item);
  if (typeof item.cwd === "string" && item.cwd && !profile.cwd) profile.cwd = item.cwd;
  const activity = activityFor(type, body, spec.label);
  if (activity.prompt && !isBootstrapPrompt(activity.prompt) && (!profile.prompt || isBootstrapPrompt(profile.prompt))) {
    profile.prompt = activity.prompt;
    profile.title = deriveTitle(activity.prompt);
  }
  if (activity.status) profile.status = activity.status;
  if (activity.terminal !== undefined) profile.terminal = activity.terminal;
  if (activity.error) profile.error = activity.error;
  else if (activity.status === "WORKING" || activity.status === "DONE") profile.error = undefined;
  if (activity.text) {
    const ordinal = typeof record.ordinal === "string" || typeof record.ordinal === "number" ? String(record.ordinal) : "";
    const itemId = typeof item.id === "string" ? item.id : "";
    profile.activity = activity.text;
    profile.activityKind = activity.kind;
    profile.activityTool = activity.tool;
    profile.activityKey = `${at ?? profile.updatedAt}:${ordinal}:${type}:${itemId}:${activity.text}`;
  }
}

function rolloutFiles(root: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile() && pattern.test(entry.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

export class RolloutScanner {
  private readonly cursors = new Map<string, RolloutCursor>();

  constructor(private readonly spec: EngineScanSpec, private readonly root: string) {}

  scan(now = Date.now()): EngineRolloutProfile[] {
    const files = rolloutFiles(this.root, this.spec.filePattern);
    const seen = new Set(files);
    for (const filePath of files) {
      let size = 0;
      let mtime = now;
      try {
        const stat = statSync(filePath);
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        continue;
      }
      let cursor = this.cursors.get(filePath);
      if (!cursor || size < cursor.offset) {
        cursor = { offset: 0, carry: "", profile: initialProfile(this.spec, filePath) };
        this.cursors.set(filePath, cursor);
      }
      let fd: number | undefined;
      try {
        fd = openSync(filePath, "r");
        const remaining = size - cursor.offset;
        if (remaining > 0) {
          const buffer = Buffer.alloc(Math.min(remaining, 1024 * 1024));
          let position = cursor.offset;
          let carry = cursor.carry;
          while (position < size) {
            const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
            if (read <= 0) break;
            position += read;
            const lines = (carry + buffer.subarray(0, read).toString("utf8")).split(/\r?\n/);
            carry = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try { applyRecord(this.spec, cursor.profile, JSON.parse(line) as RolloutRecord); } catch {}
            }
          }
          cursor.offset = position;
          cursor.carry = carry;
        }
        if (cursor.profile.startedAt === 0) cursor.profile.startedAt = mtime || now;
        if (cursor.profile.updatedAt === 0) cursor.profile.updatedAt = mtime || now;
      } catch {
        continue;
      } finally {
        if (fd !== undefined) try { closeSync(fd); } catch {}
      }
    }
    for (const filePath of this.cursors.keys()) if (!seen.has(filePath)) this.cursors.delete(filePath);
    return [...this.cursors.values()].map((cursor) => ({ ...cursor.profile }));
  }
}

function processCwd(pid: number): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const raw = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000 });
    return raw.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1) || undefined;
  } catch {
    return undefined;
  }
}

interface PsEntry {
  pid: number;
  startedAt?: number;
  command: string;
}

function parseProcessStart(raw: string): number | undefined {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// 一次 ps 快照供全部引擎共享（每 tick 一次，避免逐引擎重复跑 ps）
export function captureCliProcesses(): PsEntry[] | null {
  if (process.platform === "win32") return null;
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const out: PsEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      out.push({ pid, startedAt: parseProcessStart(match[3]), command: match[4] });
    }
    return out;
  } catch {
    return null;
  }
}

export function engineProcesses(snapshot: PsEntry[], spec: EngineScanSpec): EngineProcessInfo[] {
  const out: EngineProcessInfo[] = [];
  for (const entry of snapshot) {
    if (!spec.commandPattern.test(entry.command)) continue;
    const threadId = /(?:^|\s)([0-9a-z]{8,}(?:-[0-9a-z]+){2,})(?:\s|$)/i.exec(entry.command)?.[1];
    out.push({ pid: entry.pid, cwd: processCwd(entry.pid), startedAt: entry.startedAt, command: entry.command, threadId });
  }
  return out;
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  return a.replace(/[\\/]$/, "").toLowerCase() === b.replace(/[\\/]$/, "").toLowerCase();
}

const PROCESS_START_TOLERANCE_MS = 10 * 60_000;

export function matchEngineProcess(profile: EngineRolloutProfile, processes: EngineProcessInfo[]): EngineProcessInfo | undefined {
  const byThread = processes.filter((process) => process.threadId === profile.sessionId);
  const cwdCandidates = processes.filter((process) => samePath(process.cwd, profile.cwd));
  const byStart = cwdCandidates.filter((process) => {
    if (!profile.startedAt || !process.startedAt) return true;
    return Math.abs(process.startedAt - profile.startedAt) <= PROCESS_START_TOLERANCE_MS;
  });
  const candidates = byThread.length > 0
    ? byThread
    : byStart.length > 0
      ? byStart
      : profile.startedAt || cwdCandidates.length !== 1
        ? []
        : cwdCandidates;
  if (!candidates.length) return undefined;
  return [...candidates].sort((left, right) => {
    const score = (process: EngineProcessInfo): number => {
      let value = 0;
      if (process.threadId === profile.sessionId) value += 1_000_000;
      if (samePath(process.cwd, profile.cwd)) value += 100_000;
      if (process.startedAt && profile.startedAt) {
        value += Math.max(0, 50_000 - Math.abs(profile.startedAt - process.startedAt) / 10);
      }
      return value;
    };
    return score(right) - score(left);
  })[0];
}
