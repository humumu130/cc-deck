import type { AgentCallbacks } from "./agent-adapter.js";
import { JsonProcessAgentSession, mapJsonlActivity, preflightEngine, type EngineConfig, type EngineSpawnOptions, type JsonlActivityOptions, type MappedStatusDock, type PreflightResult } from "./agent-jsonl.js";

export const TRAE_CAPABILITIES = {
  resume: false,
  reinjection: true,
  approval: false,
  images: false,
  usage: false,
  todos: false,
  artifacts: false,
  streaming: false,
} as const;

export const TRAE_ACTIVITY_CAPABILITIES = {
  native_status: false,
  operation_summary: true,
  native_elapsed: false,
  approval: false,
} as const;

export const TRAE_PENDING_SMOKE = [
  "--help/版本确认 JSON 或 JSONL 输出开关",
  "非交互/自动批准、provider/model 参数与退出码",
  "原生 session/resume 能力（第一期固定不启用）",
] as const;

export function mapTraeActivity(raw: unknown, options: Omit<JsonlActivityOptions, "capabilities"> = {}): MappedStatusDock {
  return mapJsonlActivity(raw, { ...options, capabilities: TRAE_ACTIVITY_CAPABILITIES });
}

export interface TraeSessionOptions extends Omit<EngineSpawnOptions, "label" | "args"> {
  command?: string;
}

export class TraeAgentSession extends JsonProcessAgentSession {
  constructor(opts: TraeSessionOptions) {
    super({ ...opts, label: "trae", command: opts.command ?? process.env.CCR_TRAE_PATH ?? "trae-cli" });
  }

  protected buildArgs(prompt: string): string[] {
    // 官方仓库 README 已确认：trae-cli run "<task>"；工作目录由 spawn cwd 提供。
    return ["run", prompt];
  }
}

export function preflightTrae(config?: Partial<EngineConfig>): PreflightResult {
  return preflightEngine({ command: config?.command ?? process.env.CCR_TRAE_PATH ?? "trae-cli", provider: config?.provider });
}

export function createTraeAgent(opts: Omit<TraeSessionOptions, "cb"> & { cb: AgentCallbacks }): TraeAgentSession {
  return new TraeAgentSession(opts);
}
