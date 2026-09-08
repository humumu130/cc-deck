// #388 模型清单：聚合用户 Claude 配置里可用的模型，随 SNAPSHOT 下发供客户端下拉切换。
// 来源：~/.claude/settings.json 的 env（ANTHROPIC_DEFAULT_SONNET/HAIKU/OPUS_MODEL + 自定义
// ANTHROPIC_MODEL 系列）+ settings.model 当前默认 + CCR_MODELS 显式补充；去重保序
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = "glm-5.3";

function readClaudeSettings(): { env?: Record<string, string>; model?: string } {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

export function listModels(fallbackDefault: string): string[] {
  const s = existsSync(join(homedir(), ".claude", "settings.json")) ? readClaudeSettings() : {};
  const env = s.env ?? {};
  const out: string[] = [];
  const add = (m: unknown) => {
    if (typeof m !== "string") return;
    // CLI 的 [1m] 后缀是水位档标记，模型名本体去掉；去重保序
    const base = m.replace(/\[1m\]$/, "").trim();
    if (base && !out.includes(base)) out.push(base);
  };
  // 用户显式补充清单优先（CCR_MODELS="a,b,c"）
  for (const m of (process.env.CCR_MODELS ?? "").split(",")) add(m);
  // settings.model 是 CLI 当前默认
  add(s.model);
  // 厂商映射的三个档位（GLM/其它厂商部署时通常各档配一个模型名）
  add(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  add(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  add(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  add(fallbackDefault || DEFAULT_MODEL);
  return out;
}
