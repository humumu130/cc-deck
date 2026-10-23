// #212 W-SESSLABEL：会话标题改读 Claude Code 自带 ai-title/custom-title（零依赖纯文件读）。
//
// 数据形态（2026-10-22 本机 ~/.claude/projects 一手抽样，样本贴回执）：
//   {"type":"ai-title","aiTitle":"设计文档可靠性边界审查","sessionId":"02159bf3-…"}
//   ——实测仅 type/aiTitle/sessionId 三字段（任务书预报的 cwd/timestamp 字段不存在）；
//   同一行随回合推进重复追加（15 行同值实测），换任务后 CLI 追加新 aiTitle 行。
//   {"type":"custom-title","customTitle":"…"}——用户 /rename，本机无样本（按 CLI 契约实现）。
//
// ⚠️ 任务书给的 includes('"title"') 预过滤实测不命中：`"type":"ai-title"` 与
// `"aiTitle"` 都不含带引号前缀的 `"title"` 子串——照抄会漏掉全部标题行。本模块
// 用类型词 `"ai-title"` / `"custom-title"` 预过滤（实测命中，见 scripts/test-session-title.ts）。
//
// 优先级链（贯穿所有出口）：titleOverrides（用户 App 改名，session-manager 侧已有）>
// customTitle（手动 /rename）> aiTitle（CLI 自动任务标题=终端标签名）> 派生标题
//（deriveTitle(首条 prompt) / 目录名，ensureInitialTitle 既有兜底）。
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TranscriptTitle {
  custom?: string;
  ai?: string;
}

/**
 * 单行标题识别：类型词预过滤（不命中零 parse 成本），命中后 parse 取字段。
 * 非串/空串字段忽略——畸形行静默跳过，不中断调用方扫描。
 */
export function titleFromLine(line: string): TranscriptTitle | undefined {
  if (!line.includes('"ai-title"') && !line.includes('"custom-title"')) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  const out: TranscriptTitle = {};
  if (o.type === "custom-title" && typeof o.customTitle === "string" && o.customTitle.trim()) {
    out.custom = o.customTitle;
  }
  if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) {
    out.ai = o.aiTitle;
  }
  return out.custom || out.ai ? out : undefined;
}

/**
 * 批量文本扫描：custom > ai，同类型后行覆盖（CLI 换任务后追加新 aiTitle 行，
 * 文件序最新一条即当前任务标题——与终端标签一致）。
 */
export function scanTitleText(text: string): TranscriptTitle {
  const out: TranscriptTitle = {};
  for (const line of text.split("\n")) {
    const t = titleFromLine(line);
    if (!t) continue;
    if (t.custom) out.custom = t.custom;
    if (t.ai) out.ai = t.ai;
  }
  return out;
}

/**
 * cwd → ~/.claude/projects/ 编码目录名。实测规则：非 [A-Za-z0-9-] 字符逐个替换
 * 为 '-'，不合并不删除——
 *   /Users/xdd/dev/cc-deck          → -Users-xdd-dev-cc-deck
 *   D:\code\pcs-cloud               → D--code-pcs-cloud（Windows 样本，任务书给）
 *   /Users/xdd/dev/cc-deck/.claude  → -Users-xdd-dev-cc-deck--claude（'.' 也转 '-'）
 */
export function encodedProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * 按 cwd + sessionId 零依赖定位转录文件（transcriptPaths 内存丢失/hook 未上报窗口
 * 的兜底，不替代 hook 上报的权威路径）：
 *   ① 直查 <projects>/<encoded(cwd)>/<sessionId>.jsonl；
 *   ② miss → 扫该编码目录 mtime 最新 .jsonl（压缩续接换代等文件名漂移场景）；
 *   ③ 目录不存在 → null（不越出编码目录全局扫，防误配）。
 * .tmp- 段 cwd（titlegen 子会话/测试沙箱）调用方自行排除，此处不管。
 */
export function resolveSessionTitleFile(opts: { cwd: string; sessionId: string; home?: string }): string | null {
  if (!opts.cwd || !opts.sessionId) return null;
  const dir = join(opts.home ?? homedir(), ".claude", "projects", encodedProjectDir(opts.cwd));
  const direct = join(dir, `${opts.sessionId}.jsonl`);
  try {
    if (statSync(direct).isFile()) return direct;
  } catch {}
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { p: string; m: number } | null = null;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    try {
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    } catch {}
  }
  return best?.p ?? null;
}
