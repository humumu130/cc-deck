import type { AgentCallbacks } from "./agent-adapter.js";
import { JsonProcessAgentSession, preflightEngine, type EngineConfig, type EngineSpawnOptions, type PreflightResult } from "./agent-jsonl.js";

export const CODEBUDDY_CAPABILITIES = {
  resume: false,
  reinjection: true,
  approval: false,
  images: false,
  usage: false,
  todos: false,
  artifacts: false,
  streaming: false,
} as const;

export const CODEBUDDY_PENDING_SMOKE = [
  "官方 --help 核对 bin、prompt 入口与输出协议",
  "provider/base URL/model 参数与鉴权变量名",
  "CI 权限失败退出码与是否存在 decision channel",
] as const;

export interface CodeBuddySessionOptions extends Omit<EngineSpawnOptions, "label" | "args"> {
  command?: string;
}

export class CodeBuddyAgentSession extends JsonProcessAgentSession {
  constructor(opts: CodeBuddySessionOptions) {
    super({ ...opts, label: "codebuddy", command: opts.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code" });
  }

  protected buildArgs(_prompt: string): string[] {
    // --ci-mode 是规格冻结的非交互约束；prompt 参数名/输出协议待 --help 核实，
    // 因此正文仅走 stdin。无 decision channel 时绝不映射 WAITING。
    return ["--ci-mode"];
  }
}

export function preflightCodeBuddy(config?: Partial<EngineConfig>): PreflightResult {
  return preflightEngine({ command: config?.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code", provider: config?.provider });
}

export function createCodeBuddyAgent(opts: Omit<CodeBuddySessionOptions, "cb"> & { cb: AgentCallbacks }): CodeBuddyAgentSession {
  return new CodeBuddyAgentSession(opts);
}
