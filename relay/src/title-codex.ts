// #219 多引擎适配件②（2026-10-23）：codex 标题解析器。
// 数据源实证（2026-10-23 本机 ~/.codex 勘查）：codex 侧维护 session_index.jsonl——
// {"id":"<thread_id>","thread_name":"<标题>","updated_at":"..."}，与 claude 转录内嵌
// ai-title（bridge.ts scanTranscriptTitles）同构：引擎自己起的名、relay 免费读。
// 命中率备案：本机索引仅 2 条 vs 9 天 rollout 文件——thread_name 生成频率是 codex
// 侧行为（exec 场景未保每会话都写），查无 = 回落档 deriveTitle（session-manager
// 接线），不做重试风暴不做阻塞。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexSessionIndexEntry {
  id: string;
  thread_name: string;
}

/** 单行宽松解析：id 与 thread_name 双字段齐全才收；畸形行静默跳过（索引是 codex 地盘，relay 只读） */
export function parseCodexSessionIndexLine(line: string): CodexSessionIndexEntry | null {
  try {
    const raw = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
    if (typeof raw?.id !== "string" || !raw.id) return null;
    if (typeof raw.thread_name !== "string" || !raw.thread_name.trim()) return null;
    return { id: raw.id, thread_name: raw.thread_name.trim() };
  } catch {
    return null;
  }
}

/** 按 codex thread_id 查线程名。文件缺失/无命中/全畸形 → null（回落档由调用方接）。
 * 同 id 多条取文件序最后一条（与 bridge 标题扫描「取文件序最新」同口径）；
 * 长度按会话标题口径截 120（setExternalTitle 同款）。 */
export function readCodexThreadName(threadId: string, codexHome?: string): string | null {
  if (!threadId) return null;
  try {
    const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    let text: string;
    try {
      text = readFileSync(join(home, "session_index.jsonl"), "utf-8");
    } catch {
      return null; // 文件不存在 = 该 codex 版本没写索引，恒走回落档
    }
    let hit: string | undefined;
    for (const line of text.split("\n")) {
      const entry = parseCodexSessionIndexLine(line);
      if (entry && entry.id === threadId) hit = entry.thread_name;
    }
    return hit ? [...hit].slice(0, 120).join("") : null;
  } catch {
    return null;
  }
}
