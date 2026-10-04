import type { AgentCallbacks } from "./agent-adapter.js";
import { JsonProcessAgentSession, preflightEngine, type EngineConfig, type EngineSpawnOptions, type PreflightResult } from "./agent-jsonl.js";

export const QWEN_CODE_CAPABILITIES = {
  resume: false,
  reinjection: true,
  approval: false,
  images: false,
  usage: true,
  todos: false,
  artifacts: false,
  streaming: false,
} as const;

export const QWEN_PENDING_SMOKE = [
  "JSONL 是否可用及事件字段稳定性",
  "原生 resume 参数与会话锚点（第一期固定走重注入）",
  "provider/base URL/model 参数与鉴权变量名",
] as const;

export interface QwenCodeSessionOptions extends Omit<EngineSpawnOptions, "label" | "args"> {
  command?: string;
}

export class QwenCodeAgentSession extends JsonProcessAgentSession {
  constructor(opts: QwenCodeSessionOptions) {
    super({ ...opts, label: "qwen-code", command: opts.command ?? process.env.CCR_QWEN_PATH ?? "qwen" });
  }

  protected buildArgs(prompt: string): string[] {
    // 006 §3.2 已确认的基线：-p + --output-format json；其余能力仍待冒烟。
    return ["-p", prompt, "--output-format", "json"];
  }
}

export function preflightQwen(config?: Partial<EngineConfig>): PreflightResult {
  return preflightEngine({ command: config?.command ?? process.env.CCR_QWEN_PATH ?? "qwen", provider: config?.provider });
}

export function createQwenCodeAgent(opts: Omit<QwenCodeSessionOptions, "cb"> & { cb: AgentCallbacks }): QwenCodeAgentSession {
  return new QwenCodeAgentSession(opts);
}
