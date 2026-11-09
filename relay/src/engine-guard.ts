// W-ENGSEC（100% 工程批三·统一安全层）：非 claude 引擎危险工具审计+拦截。
//
// 上游硬顶（用户拍板全引擎 100% 后的补齐层）：codex/qwen/trae/codebuddy 四引擎
// headless exec 型——无审批交互通道（面板开关形同虚设）、CodeBuddy G1 危险工具
// 黑名单可 ToolSearch→DeferExecuteTool 中转绕过。本层=CC Deck 自己的安全语义，
// 呈现与 claude code 等效（PM 拍板口径）。
//
// 等效语义定案（实勘修正）：任务书原设想「注入拒绝结果（引擎可继续但拿拒绝）」
// ——实勘四引擎均 exec 型一次性 spawn（prompt in → 自跑 → 事件流出，无中途
// stdin 协议），**无通道注入 tool_result**。等效落法=**检测即斩 + 拒绝语入流 +
// 审计 + 通知**：危险命令出现在转录流（tool_use）即（托管面）stop() 终止回合、
// system 行「已被安全策略拦截…请改道」进时间线（模型 resume 下轮读到改道）、
// engine-tool-audit.ndjson 审计 + upsertNotification 面板通知；external 面（用户
// 终端自开、relay 无进程句柄）=审计+通知不斩。不做假挂起（CLI 自跑不停）。
//
// 能力边界（备案）：四引擎 tool_use 转录事件多数不带 input 全参（codex 命令文本
// 在、qwen/trae 常只有工具名）——**命令类拦覆盖主破坏面**（rm -rf/sudo/管道执行/
// 盘写/敏感外发）；写类工具（Edit/Write）路径限目录在转录层不可达（无 input 面，
// claude 面由 allow-rules+原生审批承担）。CodeBuddy G1 中转链：中转后命令文本仍
// 经转录流（tool_use 面）→ 本层按内容匹配覆盖（不按工具名——黑名单按名可绕，
// 内容匹配不可绕）。
//
// 档位语义（跨引擎统一）：bypassPermissions=全放（各引擎现状）；default/
// acceptEdits（及受限）=危险库拦。spawn 参数面：codebuddy 已有 --permission-mode
// 透传（#285/W-ENGCB-FIX G2 面）与本层双落；其余引擎靠检测斩。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EngineGuardVerdict {
  block: boolean;
  rule: string; // 命中的规则 id（审计/通知引用）
  reason: string; // 人话理由
}

// 内置危险模式（正则，大小写敏感关——命令面小写为主但 sudo Sudo 都要拦）：
//   每条=精确语义锚（非子串泛匹配），误伤面控制：
//   - rm 强删：rm 任意参组合带 -r/-R 且非 -i 交互（rm -rf / rm -fr / rm -r）；单文件 rm 不拦（写代码常态）
//   - sudo/su：提权面整体拦（default 档不该有提权）
//   - 管道执行：curl|wget … | sh/bash/zsh（远程载荷直执行——数 lex 险之首）
//   - chmod 777 / chown 递归：世界可写面
//   - 盘级写：mkfs* / dd of=/dev/（块设备）
//   - 敏感外发：.ssh 私钥/环境凭据文件出现在 curl/wget/nc 的 URL 或 body 参位
//   - 强制推送：git push --force / -f（改远端历史——allow-rules BASH_TOKEN_DENY 同族口径 git 族放行但 force 拦）
const BUILTIN_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: "rm-recursive", re: /\brm\s+[^;|&]*[-][rRf]/, reason: "rm 递归/强删（-r/-f 族）" },
  { id: "privilege-esc", re: /\b(sudo|doas)\b|\bsu\s+-|\bsu\s+root/, reason: "提权执行（sudo/su/doas）" },
  { id: "pipe-execute", re: /\b(curl|wget)\b[^;|&]*\|\s*(sudo\s+)?(sh|bash|zsh|python|python3)\b/, reason: "远程载荷管道直执行（curl|sh 形态）" },
  { id: "chmod-world", re: /\bchmod\s+(-R\s+)?777\b/, reason: "chmod 777 世界可写" },
  { id: "chown-recursive", re: /\bchown\s+[^;|&]*-R\b/, reason: "chown 递归改属主" },
  { id: "disk-write", re: /\bmkfs(\.\w+)?\b|\bdd\b[^;|&]*\bof=\/dev\//, reason: "盘级写入（mkfs/dd of=块设备）" },
  { id: "secrets-exfil", re: /\b(curl|wget|nc|ncat|ssh|scp)\b[^;|&]*(\.ssh\/|id_rsa|id_ed25519|\.env\b|\.aws\/credentials|\.netrc)/, reason: "敏感凭据/私钥外发" },
  { id: "git-force-push", re: /\bgit\s+push\s+[^;|&]*(-f\b|--force\b)/, reason: "git 强推改远端历史" },
];

// 路径白名单（命令文本含这些锚时不拦该条——/tmp 作业面是测试常态：
// rm -rf /tmp/testdir 是验收真测命令本身，default 档下 /tmp 内的 rm 放行由白名单承载）
const BUILTIN_PATH_ALLOW = ["/tmp/", "/private/tmp/", "/var/folders/"];

export function engineGuardExtraPatterns(): Array<{ id: string; source: string; re: RegExp; reason: string }> {
  // 用户可配置扩展：CCR_ENGSEC_EXTRA（分号分段，每段 pattern::reason）
  // 形态简化：每段 "pattern::reason"（::分隔），坏正则跳过并 console.warn（配置面不炸主流程）
  const raw = process.env.CCR_ENGSEC_EXTRA ?? "";
  const out: Array<{ id: string; source: string; re: RegExp; reason: string }> = [];
  for (const seg of raw.split(";")) {
    const s = seg.trim();
    if (!s) continue;
    const [pat, reason] = s.split("::");
    if (!pat) continue;
    try {
      out.push({ id: "extra-" + out.length, source: s, re: new RegExp(pat, "i"), reason: reason || "用户扩展规则" });
    } catch { console.warn(`[engine-guard] CCR_ENGSEC_EXTRA 坏正则已跳过: ${s.slice(0, 80)}`); }
  }
  return out;
}

/** 命令/工具调用文本评估。opts.allowTmpWhiteList=false 时关白名单（白名单仅命令类主评估用）。 */
export function assessEngineCommand(text: string, opts?: { extra?: Array<{ id: string; source: string; re: RegExp; reason: string }>; useBuiltinWhiteList?: boolean }): EngineGuardVerdict {
  const cmd = String(text ?? "");
  if (!cmd.trim()) return { block: false, rule: "", reason: "" };
  const extra = opts?.extra ?? engineGuardExtraPatterns();
  for (const p of BUILTIN_PATTERNS) {
    if (!p.re.test(cmd)) continue;
    if ((opts?.useBuiltinWhiteList ?? true) && BUILTIN_PATH_ALLOW.some((a) => cmd.includes(a)) && (p.id === "rm-recursive" || p.id === "chmod-world" || p.id === "chown-recursive")) {
      // /tmp 等作业面白名单：rm -rf /tmp/testdir 类测试命令放行（审计仍记——white-listed 形态）
      return { block: false, rule: p.id + ":whitelisted", reason: p.reason + "（作业面白名单路径）" };
    }
    return { block: true, rule: p.id, reason: p.reason };
  }
  for (const p of extra) {
    if (p.re.test(cmd)) return { block: true, rule: p.id, reason: p.reason + `（扩展规则 ${p.source.slice(0, 40)}）` };
  }
  return { block: false, rule: "", reason: "" };
}

/** tool_use 转录行 → 待评估命令文本（适配器形态归一：codex「执行命令：cmd」前缀/
 *  rollouts command 原文/其它引擎 text 或 meta.full 全文——内容匹配不依赖前缀精确性）。 */
export function commandTextFromToolUse(text: string, meta?: { full?: string; tool?: string }): string {
  const raw = (typeof meta?.full === "string" && meta.full ? meta.full : text) ?? "";
  return String(raw).replace(/^执行命令：/, "").trim();
}

/** 审计流：data/engine-tool-audit.ndjson（追加写；文件级尽力而为不炸主流程）。 */
export function appendEngineToolAudit(dataDir: string, entry: {
  ts: number; engine: string; session_id: string; mode: string;
  command: string; rule: string; reason: string; action: "blocked" | "notified-only" | "whitelisted";
  detail?: string;
}): void {
  try {
    const dir = dataDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "engine-tool-audit.ndjson"), JSON.stringify({ v: 1, ...entry }) + "\n", "utf-8");
  } catch { /* 审计面尽力而为 */ }
}

export function readEngineToolAudit(dataDir: string, limit = 50): Array<Record<string, unknown>> {
  try {
    const lines = readFileSync(join(dataDir, "engine-tool-audit.ndjson"), "utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { raw: l }; } });
  } catch { return []; }
}

/** 档位是否启用拦截（bypass=全放=各引擎现状；default/acceptEdits/受限=危险库拦）。 */
export function modeGuards(mode: string | undefined): boolean {
  return mode !== "bypassPermissions";
}
