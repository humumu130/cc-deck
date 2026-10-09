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

// [1m] 水位档重挂（2026-10-09）：客户端清单/会话存储一律裸名（上面 listModels 展示时剥
// 后缀），但 CLI 只认模型名 [1m] 后缀升 1M 窗口——模型表外的名字（GLM-* 直传）一律按
// 200K 假设并主动 auto-compact（根因链与死路清单见 memory claude-context-window-1m.md）。
// glm-5 系（含 flash/turbo 变体）按 z.ai 官方规格 1M（同 context-limit.ts 显示表口径）；
// claude-* 原生窗口 CLI 自知、GLM-4.x 及未知模型不动。已带后缀的幂等返回。
export function withContextWindowSuffix(model: string | undefined): string | undefined {
  if (!model) return model;
  const m = model.trim();
  if (!m || /\[1m\]$/i.test(m)) return m;
  if (/^glm-5/i.test(m)) return `${m}[1m]`;
  return m;
}
