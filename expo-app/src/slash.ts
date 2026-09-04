// Slash 命令联想数据源。
// LAN 通道 fetch relay GET /api/commands（内置 + 用户级 ~/.claude/commands +
// 项目级 <cwd>/.claude/commands）；云通道 HTTP 到不了 relay、LAN 拉取失败时
// 回落内置表（与 relay/src/ws-server.ts BUILTIN_COMMANDS 同步维护）。
export interface SlashCommand {
  name: string;
  desc: string;
  source: "builtin" | "user" | "project";
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "compact", desc: "压缩对话历史，释放上下文", source: "builtin" },
  { name: "clear", desc: "清空当前会话历史", source: "builtin" },
  { name: "help", desc: "查看帮助", source: "builtin" },
  { name: "model", desc: "查看/切换模型", source: "builtin" },
  { name: "cost", desc: "当前会话 token 用量", source: "builtin" },
  { name: "context", desc: "上下文使用概况", source: "builtin" },
  { name: "memory", desc: "编辑项目记忆 CLAUDE.md", source: "builtin" },
  { name: "init", desc: "为当前项目初始化 CLAUDE.md", source: "builtin" },
  { name: "review", desc: "审查 PR / 代码变更", source: "builtin" },
  { name: "resume", desc: "恢复历史会话", source: "builtin" },
  { name: "rename", desc: "重命名当前会话", source: "builtin" },
  { name: "export", desc: "导出当前会话记录", source: "builtin" },
  { name: "todos", desc: "查看当前任务清单", source: "builtin" },
  { name: "permissions", desc: "权限规则管理", source: "builtin" },
  { name: "config", desc: "打开配置面板", source: "builtin" },
  { name: "mcp", desc: "MCP 服务器管理", source: "builtin" },
  { name: "statusline", desc: "状态栏配置", source: "builtin" },
  { name: "output-style", desc: "切换输出风格", source: "builtin" },
  { name: "add-dir", desc: "添加额外工作目录", source: "builtin" },
  { name: "vim", desc: "切换 vim 按键模式", source: "builtin" },
  { name: "doctor", desc: "Claude Code 健康检查", source: "builtin" },
  { name: "login", desc: "切换账号", source: "builtin" },
  { name: "bug", desc: "报告问题", source: "builtin" },
  { name: "release-notes", desc: "查看更新日志", source: "builtin" },
];

const cache = new Map<string, { ts: number; list: SlashCommand[] }>();
const TTL = 60_000;

export function httpBaseOf(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    return (u.protocol === "wss:" ? "https://" : "http://") + u.host;
  } catch {
    return "";
  }
}

export function matchSlash(list: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, 8);
  return list.filter((c) => c.name.toLowerCase().startsWith(q) || (c.desc || "").toLowerCase().includes(q)).slice(0, 8);
}

export async function fetchSlashCommands(
  httpBase: string,
  token: string,
  cwd: string,
): Promise<SlashCommand[]> {
  if (!httpBase || !token) return BUILTIN_COMMANDS;
  const key = httpBase + "|" + cwd;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.list;
  try {
    const r = await fetch(
      `${httpBase}/api/commands?token=${encodeURIComponent(token)}&cwd=${encodeURIComponent(cwd)}`,
      { signal: AbortSignal.timeout?.(4000) },
    );
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { ok?: boolean; commands?: SlashCommand[] };
    if (!j?.ok || !Array.isArray(j.commands)) throw new Error("bad shape");
    const list = j.commands.filter((c) => c && typeof c.name === "string");
    cache.set(key, { ts: Date.now(), list });
    return list;
  } catch {
    return BUILTIN_COMMANDS;
  }
}
