// 任务工具门控的用户级兜底：CLI 按模型身份门控任务追踪工具（TaskCreate/Get/Update/
// List、TodoWrite），仅对 Claude 系模型默认提供，其它模型（GLM 等）一律裁剪——官方
// 逃生门是环境变量 CLAUDE_CODE_ENABLE_TODO_TOOLS=1（CLI changelog 明示）。
//
// 两层修复中的用户层：relay 托管会话由 agent-adapter spawn 时直接注入 env（进程级）；
// 但用户在终端自己开的会话（被 bridge hook 收编上报）不是 relay spawn 的，进程级注入
// 管不到——本模块在 relay 就绪后幂等补写用户 settings.json 的 env，让之后新开的
// 终端会话也拿到任务工具。已开着的会话无法追溯（env 在 CLI 进程启动时读取）。
//
// 原则：只在键不存在时补写。用户显式设置（含 "0" 故意关闭）一律尊重不动；
// 目录/文件缺失、JSON 损坏、env 非对象 → 放弃，绝不破坏用户文件。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const TODO_TOOLS_ENV_KEY = "CLAUDE_CODE_ENABLE_TODO_TOOLS";

export type EnsureTodoToolsResult =
  | "written" // 已补写（含创建新文件）
  | "present" // 键已存在，尊重不动
  | "skip-no-dir" // 配置目录不存在（未安装过 CLI）——放弃
  | "skip-bad-json" // settings.json 解析失败或结构异常——放弃，不动原文件
  | "error"; // 写入失败（权限等）

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function ensureTodoToolsEnv(): EnsureTodoToolsResult {
  const dir = claudeConfigDir();
  if (!existsSync(dir)) return "skip-no-dir";
  const file = join(dir, "settings.json");

  let obj: Record<string, unknown>;
  if (!existsSync(file)) {
    obj = {};
  } else {
    try {
      obj = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      return "skip-bad-json";
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return "skip-bad-json";
  }

  const env = obj.env;
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) return "skip-bad-json";
    if (TODO_TOOLS_ENV_KEY in env) return "present";
  }
  obj.env = { ...(env as Record<string, unknown>), [TODO_TOOLS_ENV_KEY]: "1" };

  try {
    writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    return "written";
  } catch {
    return "error";
  }
}
