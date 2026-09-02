// 任务清单隐藏集：CLI 任务存储（~/.claude/tasks）无法外部真删，relay 侧按会话记录
// 隐藏条目的 normKey，在 SessionManager.setTodos 咽喉点过滤（hook 路径 / transcript
// 轮询 / COMMAND_REFRESH_TODOS 重发全被覆盖）。持久化 data/todo-hidden.json，读写失败静默降级。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "todo-hidden.json");
const MAX_PER_SESSION = 200; // 每会话封顶（FIFO 淘汰最旧）

let fileCache: Record<string, string[]> | null = null; // 磁盘内容（null = 未加载）
const keySets = new Map<string, Set<string>>();         // 会话 -> 内存隐藏键集

function load(): Record<string, string[]> {
  if (fileCache) return fileCache;
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf-8")) as Record<string, unknown>;
    fileCache = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) {
        const keys = v.filter((x): x is string => typeof x === "string" && !!x);
        if (keys.length) fileCache[k] = keys.slice(-MAX_PER_SESSION);
      }
    }
  } catch {
    fileCache = {}; // 不存在/损坏：从空集开始
  }
  return fileCache;
}

// 该会话的隐藏键集（懒加载；隐藏集为空时过滤零开销）
export function hiddenTodoKeys(sessionId: string): Set<string> {
  let s = keySets.get(sessionId);
  if (!s) {
    s = new Set(load()[sessionId] ?? []);
    keySets.set(sessionId, s);
  }
  return s;
}

// 追加隐藏键并落盘（重复隐藏幂等；写失败静默降级为仅内存）
export function addHiddenTodoKey(sessionId: string, key: string): void {
  if (!sessionId || !key) return;
  const s = hiddenTodoKeys(sessionId);
  if (s.has(key) && s.size <= MAX_PER_SESSION) return;
  s.add(key);
  const capped = [...s].slice(-MAX_PER_SESSION); // 超限时淘汰最旧
  keySets.set(sessionId, new Set(capped));
  const disk = load();
  disk[sessionId] = capped;
  fileCache = disk;
  try {
    writeFileSync(FILE, JSON.stringify(disk));
  } catch {}
}

// 测试用：丢弃内存缓存，强制下次从磁盘重载（模拟 relay 重启验证持久化）
export function resetHiddenTodoStore(): void {
  fileCache = null;
  keySets.clear();
}
