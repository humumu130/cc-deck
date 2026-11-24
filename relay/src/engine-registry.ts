import type { AgentCallbacks, AgentLike } from "./agent-adapter.js";
import { createCodeBuddyAgent, preflightCodeBuddy, CODEBUDDY_CAPABILITIES, CODEBUDDY_MODELS, type CodeBuddySpawnConfig } from "./agent-codebuddy.js";
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
  /** #285 codebuddy 能力面配置（session-manager 从 engine profile / spawn opts 组装） */
  codebuddy?: CodeBuddySpawnConfig;
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
    create: (opts) => createCodeBuddyAgent({ ...opts, codebuddy: opts.codebuddy }), // #285 能力面透传
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

/** [W-ENGINEFIX 刀A]（1124 用户实锤）：异引擎模型分档——新建/派单把全局当前模型串
 * （Claude 系，如 glm-5.3[1m]）原文传给异引擎 → codebuddy 白名单 fail-fast throw
 * 「未知模型」拒绝创建。codex 侧已有先例（agent-codex.ts 头注：模型不透传——relay
 * 的模型名是 Claude 侧概念，引擎用自家默认）。本函数=分档单一事实源：模型串不在该
 * 引擎源级清单且非 custom: 逃生前缀 → 回落空串（=omit --model，CLI 自选默认，「默认
 * 模型」语义）。
 *   - codebuddy：CODEBUDDY_MODELS 白名单 ∪ custom: 前缀放行（buildArgs 同款口径）；
 *   - trae/qwen-code：无源级模型清单（catalog 不冒充）→ 任何显式串恒回落——两者
 *     buildArgs 本就不消费 --model（codex 同型），行为等价于显式忽略。
 * 空串/"default"/"codebuddy" 维持空串（buildArgs 既有豁免语义）。调用方两处：
 * create() 的 selectedModel 分档（state.model 显示面与 spawn 同源真值）+ 本文件
 * createRegisteredEngine 漏斗兜底（resume/fresh/revive/dispatch 等存量的 state.model
 * 再入路径——存量卡带异引擎串复活不再 throw）。 */
export function resolveForeignEngineModel(engine: SessionEngine, model: string): string {
  const m = (model || "").trim();
  if (!m || m === "default" || m === "codebuddy") return "";
  if (engine === "codebuddy" && (CODEBUDDY_MODELS.includes(m) || m.startsWith("custom:"))) return m;
  return "";
}

export function createRegisteredEngine(engine: SessionEngine, opts: RegisteredEngineOptions): AgentLike | undefined {
  const definition = getEngineDefinition(engine);
  if (!definition) return undefined;
  const check = definition.preflight(opts.providerProfile ?? profileFor(engine, opts.provider));
  if (!check.ok) throw new Error(`${definition.label} preflight 失败: ${check.errors.join("；")}`);
  // [W-ENGINEFIX 刀A] 漏斗归一：全 spawn 入口（create/resume/fresh/revive/dispatch）
  // 的 model 在此过分档——异引擎串回落引擎默认，relay 日志一行可察（谁在何串回落）。
  // 不静默：回落是用户可见行为变化（UI 选了全局默认模型 + 异引擎 = 引擎自选默认），
  // console.log 进 relay 日志面供排障对账；buildArgs 的白名单 throw 保留为最后防线
  // （正常链路经本口归一后恒不触发，仅旁路直调 buildArgs 时兜底）。
  const resolvedModel = resolveForeignEngineModel(engine, opts.model);
  if ((opts.model || "").trim() !== resolvedModel && (opts.model || "").trim()) {
    console.log(`[enginefix] ${engine} 模型回落: 「${(opts.model || "").trim()}」不在该引擎模型清单，改用引擎默认（omit --model）`);
  }
  return definition.create({ ...opts, model: resolvedModel });
}

export function preflightRegisteredEngine(engine: SessionEngine): PreflightResult | null {
  return getEngineDefinition(engine)?.preflight() ?? null;
}

export function providerProfileFor(engine: SessionEngine, provider?: string): ProviderProfile | undefined {
  return profileFor(engine, provider);
}
