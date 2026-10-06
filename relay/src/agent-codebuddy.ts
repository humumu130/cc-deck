import type { AgentCallbacks } from "./agent-adapter.js";
import { JsonProcessAgentSession, mapJsonlActivity, preflightEngine, type EngineConfig, type EngineSpawnOptions, type JsonlActivityOptions, type MappedStatusDock, type PreflightResult } from "./agent-jsonl.js";

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

export const CODEBUDDY_ACTIVITY_CAPABILITIES = {
  native_status: false,
  operation_summary: true,
  native_elapsed: false,
  approval: false,
} as const;

export const CODEBUDDY_PENDING_SMOKE = [
  "官方 --help 核对 bin、prompt 入口与输出协议",
  "provider/base URL/model 参数与鉴权变量名",
  "CI 权限失败退出码与是否存在 decision channel",
] as const;

export function mapCodeBuddyActivity(raw: unknown, options: Omit<JsonlActivityOptions, "capabilities" | "profileId"> = {}): MappedStatusDock {
  // #42 收口：档位钉死 codebuddy（stream-json 同构族宽容解析）
  return mapJsonlActivity(raw, { ...options, capabilities: CODEBUDDY_ACTIVITY_CAPABILITIES, profileId: "codebuddy" });
}

export interface CodeBuddySessionOptions extends Omit<EngineSpawnOptions, "label" | "args"> {
  command?: string;
}

export class CodeBuddyAgentSession extends JsonProcessAgentSession {
  constructor(opts: CodeBuddySessionOptions) {
    // profileId 钉死 codebuddy 档（#42）
    super({ ...opts, label: "codebuddy", command: opts.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code", profileId: "codebuddy" });
  }

  protected buildArgs(prompt: string): string[] {
    // B1a 修正（006 §3.3 一手 help 核实 + 本机 2026-10-05 help 复核）：--ci-mode
    // 已被 help 否定（旧注释引用的「规格冻结」与 006 现文冲突，以 006/实测为准）。
    // 非交互形态 = -p/--print 布尔开关 + prompt 位置参数 + --output-format；
    // stream-json 是官方声明的 realtime streaming 形态（Claude Code 协议同构族，
    // mapper 宽容解析，事件字段词汇真回合冒烟欠账维持——006 §3.4）。
    // 无 decision channel 时绝不映射 WAITING。
    return ["--print", prompt, "--output-format", "stream-json"];
  }
}

export function preflightCodeBuddy(config?: Partial<EngineConfig>): PreflightResult {
  return preflightEngine({ command: config?.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code", provider: config?.provider });
}

export function createCodeBuddyAgent(opts: Omit<CodeBuddySessionOptions, "cb"> & { cb: AgentCallbacks }): CodeBuddyAgentSession {
  return new CodeBuddyAgentSession(opts);
}
