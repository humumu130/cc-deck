// #212 远程审批「允许并记住」：relay 侧规则引擎（存储 + 匹配 + 危险判定）。
// 两类会话的审批都流经 relay 进程（托管 agent-adapter.handlePermission / 外部
// bridge.onPreToolUse），规则引擎落此一处即全覆盖——命中即本地放行，不再下发
// 审批卡。效果对齐 CLI 端权限弹窗的「don't ask again」，且作用域多一档：
//   session = 仅该会话（CLI 只有这档）；global = 所有会话（含未来新建）。
// 存储：data/allow-rules.json（写穿，重启回放）。管理走 HTTP /api/allow-rules。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AllowRule {
  id: string;
  scope: "session" | "global";
  session_id?: string; // scope=session 时必填（relay 会话 id）
  tool: string; // Bash / Edit / Write / WebFetch …
  pattern: string; // Bash=命令前缀 token 序列；Edit 族=目录路径前缀；其他="*"（工具级）
  created_at: number;
  created_by: string; // 哪个端记的（客户端标识）
}

// Bash 单 token 黑名单：命中即不提供「记住」（按钮不出现）。读类工具里 curl/wget
// 也能拉恶意载荷，一并拦。git push 改远端历史，拦 force 但放普通 push——黑名单
// 按 token 匹配做不到子命令粒度，git 整族放行由用户自行斟酌（CLI 同粒度）。
const BASH_TOKEN_DENY = new Set([
  "rm", "sudo", "su", "kill", "pkill", "killall", "shutdown", "reboot", "halt",
  "mkfs", "dd", "chmod", "chown", "curl", "wget", "launchctl", "crontab",
  "systemctl", "defaults", "osascript", "nvram", "fdisk", "parted",
]);
// shell 组合符出现 = 命令是多段拼接，拆开看不可判，整条不给记
const SHELL_COMPOSITE = /[;|&<>`]|\$\(/;

export function isMemorable(tool: string, input: Record<string, unknown> | undefined): boolean {
  if (tool === "AskUserQuestion" || tool === "ExitPlanMode") return false; // 输入/计划，非权限语义
  if (tool === "Bash") {
    const cmd = String(input?.command ?? "");
    if (!cmd.trim()) return false;
    if (SHELL_COMPOSITE.test(cmd)) return false;
    const tokens = cmd.trim().split(/\s+/);
    if (BASH_TOKEN_DENY.has(tokens[0] ?? "")) return false;
    return true;
  }
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
    return typeof input?.file_path === "string" && (input.file_path as string).length > 0;
  }
  return true; // WebFetch / WebSearch / Task 等：工具级记忆
}

// 建议规则：tool + input → pattern（匹配语义见 AllowRule.pattern 注释）+ 端上预览 label
export function suggestPattern(
  tool: string,
  input: Record<string, unknown> | undefined,
): { pattern: string; label: string } | null {
  if (!isMemorable(tool, input)) return null;
  if (tool === "Bash") {
    const tokens = String(input?.command ?? "").trim().split(/\s+/);
    // 环境变量前缀（FOO=bar cmd）剥掉——记真正要放行的命令本体
    let i = 0;
    while (i < tokens.length && /^\w+=/.test(tokens[i] ?? "")) i++;
    const sig = tokens.slice(i).filter((t) => !t.startsWith("-")); // 旗标不进 pattern
    const pattern = sig.slice(0, 2).join(" ") || tokens[i] || tokens[0] || "";
    if (!pattern) return null;
    return { pattern, label: `「${pattern}」开头的命令` };
  }
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
    const fp = String(input?.file_path ?? "");
    const dir = fp.replace(/\/[^/]*$/, "");
    if (!dir) return null;
    return { pattern: dir, label: `${dir} 下的文件编辑` };
  }
  return { pattern: "*", label: `${tool} 全部放行` };
}

// pattern 匹配（suggestPattern 的逆运算）。命中返回 true。
function matchPattern(rule: AllowRule, tool: string, input: Record<string, unknown> | undefined): boolean {
  if (rule.tool !== tool) return false;
  if (tool === "Bash") {
    const cmd = String(input?.command ?? "").trim();
    if (!cmd || SHELL_COMPOSITE.test(cmd)) return false; // 组合命令永不走记忆通道
    const tokens = cmd.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^\w+=/.test(tokens[i] ?? "")) i++;
    const sig = tokens.slice(i).filter((t) => !t.startsWith("-"));
    const head = sig.slice(0, 2).join(" ") || tokens[i] || "";
    return !!head && head === rule.pattern;
  }
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
    const fp = String(input?.file_path ?? "");
    return !!fp && (fp === rule.pattern || fp.startsWith(rule.pattern + "/"));
  }
  return true; // 工具级
}

export class AllowRuleStore {
  private rules: AllowRule[] = [];
  private file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "allow-rules.json");
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as AllowRule[];
      if (Array.isArray(parsed)) this.rules = parsed.filter((r) => r && r.tool && r.pattern);
    } catch {
      this.rules = [];
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.rules, null, 2));
    } catch {
      /* 落盘失败不阻断放行决策（内存态仍有效） */
    }
  }

  /** 会话 id + 工具 + 入参 → 命中的规则（null = 无规则，正常下发审批卡） */
  match(sessionId: string, tool: string, input: Record<string, unknown> | undefined): AllowRule | null {
    for (const r of this.rules) {
      if (r.scope === "session" && r.session_id !== sessionId) continue;
      if (matchPattern(r, tool, input)) return r;
    }
    return null;
  }

  /** 记一条（去重：同 scope+session+tool+pattern 只留最新） */
  add(tool: string, pattern: string, scope: "session" | "global", sessionId: string | undefined, by: string): AllowRule {
    this.rules = this.rules.filter(
      (r) => !(r.tool === tool && r.pattern === pattern && r.scope === scope && r.session_id === sessionId),
    );
    const rule: AllowRule = {
      id: randomUUID(),
      scope,
      ...(scope === "session" && sessionId ? { session_id: sessionId } : {}),
      tool,
      pattern,
      created_at: Date.now(),
      created_by: by,
    };
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return false;
    this.persist();
    return true;
  }

  /** 会话删除时清掉它的 session 级规则 */
  dropSession(sessionId: string): void {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => !(r.scope === "session" && r.session_id === sessionId));
    if (this.rules.length !== before) this.persist();
  }

  list(): AllowRule[] {
    return [...this.rules];
  }
}
