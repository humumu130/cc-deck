import type { AgentCallbacks, AgentLike } from "./agent-adapter.js";
import { createCodeBuddyAgent, preflightCodeBuddy, CODEBUDDY_CAPABILITIES } from "./agent-codebuddy.js";
import { createQwenCodeAgent, preflightQwen, QWEN_CODE_CAPABILITIES } from "./agent-qwen.js";
import { createTraeAgent, preflightTrae, TRAE_CAPABILITIES } from "./agent-trae.js";
import type { EngineCapabilities, PreflightResult, ProviderProfile } from "./agent-jsonl.js";
import type { SessionEngine } from "./types.js";

export interface RegisteredEngineOptions {
  cwd: string;
  model: string;
  provider?: string;
  cb: AgentCallbacks;
  initialPrompt?: string;
  contextPacket?: string;
  configHome?: string;
  providerProfile?: ProviderProfile;
}

export interface EngineDefinition {
  id: SessionEngine;
  label: string;
  capabilities?: EngineCapabilities;
  reinjection: boolean;
  create(opts: RegisteredEngineOptions): AgentLike;
  preflight(provider?: ProviderProfile): PreflightResult;
}

function profileFor(engine: SessionEngine, provider?: string): ProviderProfile | undefined {
  if (!provider) return undefined;
  const key = engine.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const apiKeyEnv = process.env[`CCR_${key}_API_KEY_ENV`];
  const baseUrlEnv = process.env[`CCR_${key}_BASE_URL_ENV`];
  return { provider, ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(baseUrlEnv ? { baseUrlEnv } : {}) };
}

const definitions: Record<"trae" | "qwen-code" | "codebuddy", EngineDefinition> = {
  trae: {
    id: "trae",
    label: "Trae",
    capabilities: TRAE_CAPABILITIES,
    reinjection: true,
    create: (opts) => createTraeAgent(opts),
    preflight: (provider) => preflightTrae({ provider }),
  },
  "qwen-code": {
    id: "qwen-code",
    label: "Qwen Code",
    capabilities: QWEN_CODE_CAPABILITIES,
    reinjection: true,
    create: (opts) => createQwenCodeAgent(opts),
    preflight: (provider) => preflightQwen({ provider }),
  },
  codebuddy: {
    id: "codebuddy",
    label: "CodeBuddy Code",
    capabilities: CODEBUDDY_CAPABILITIES,
    reinjection: true,
    create: (opts) => createCodeBuddyAgent(opts),
    preflight: (provider) => preflightCodeBuddy({ provider }),
  },
};

export function isSessionEngine(value: unknown): value is SessionEngine {
  return value === "claude" || value === "codex" || value === "trae" || value === "qwen-code" || value === "codebuddy" || value === "zcode";
}

export function isReinjectionEngine(value: SessionEngine | undefined): boolean {
  return value === "trae" || value === "qwen-code" || value === "codebuddy";
}

export function getEngineDefinition(engine: SessionEngine): EngineDefinition | undefined {
  return engine in definitions ? definitions[engine as keyof typeof definitions] : undefined;
}

export function createRegisteredEngine(engine: SessionEngine, opts: RegisteredEngineOptions): AgentLike | undefined {
  const definition = getEngineDefinition(engine);
  if (!definition) return undefined;
  const check = definition.preflight(opts.providerProfile ?? profileFor(engine, opts.provider));
  if (!check.ok) throw new Error(`${definition.label} preflight 失败: ${check.errors.join("；")}`);
  return definition.create(opts);
}

export function preflightRegisteredEngine(engine: SessionEngine): PreflightResult | null {
  return getEngineDefinition(engine)?.preflight() ?? null;
}

export function providerProfileFor(engine: SessionEngine, provider?: string): ProviderProfile | undefined {
  return profileFor(engine, provider);
}
