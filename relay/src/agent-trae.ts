import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function mapTraeActivity(raw: unknown, options: Omit<JsonlActivityOptions, "capabilities" | "profileId"> = {}): MappedStatusDock {
  // #42 收口：档位钉死 trae（structured=false），批量/流式两面同源，调用方不可覆盖
  return mapJsonlActivity(raw, { ...options, capabilities: TRAE_ACTIVITY_CAPABILITIES, profileId: "trae" });
}

/** trae config 权威位（W-ENGREST-FIX 1109 深测 P1 修）：CCR_TRAE_CONFIG 显式优先，缺省
 * ~/.trae-agent/trae_config.yaml。背景：trae-cli `--config-file` 缺省值是 **cwd 相对**
 * trae_config.yaml（server/trae_agent/cli.py:139 default="trae_config.yaml"）——relay 会话
 * cwd 各异=每会话都得有 config 才能跑，生产不可用；恒注入本权威位。engine-auth 的 trae
 * 探测位与此同源（改一处两消费面同动）。 */
export function traeConfigPath(): string {
  return process.env.CCR_TRAE_CONFIG?.trim() || join(homedir(), ".trae-agent", "trae_config.yaml");
}

/** 首次引导模板（api_key 留空值——engine-auth 探测按「api_key 非空」判 ready，模板态
 * 判 needs_auth 引导用户填写；占位文字会被探针误判 ready，故用空串+注释指路）。 */
const TRAE_CONFIG_TEMPLATE = `# trae-agent 配置（cc-deck 首次引导生成）——trae-agent 无登录命令，认证=本文件 YAML。
# 填好 api_key / base_url 后即可使用；也可设 CCR_TRAE_CONFIG 指向你已有的配置文件。
# models 节 8 字段全量必填（缺字段报 TypeError）；完整说明见 github.com/bytedance/trae-agent。
model_providers:
  anthropic:
    api_key: ""
    # ↑ 填你的 API key（sk- 开头的密钥串），保留引号去掉也可
    provider: anthropic
    base_url: ""
    # ↑ 填 API 地址（https:// 开头完整地址）
models:
  trae_agent_model:
    model_provider: anthropic
    model: claude-sonnet-4-5
    max_tokens: 4096
    temperature: 0.5
    top_p: 1
    top_k: 0
    max_retries: 3
    parallel_tool_calls: true
agents:
  trae_agent:
    enable_lakeview: false
    model: trae_agent_model
    max_steps: 10
    tools:
      - bash
      - str_replace_based_edit_tool
      - sequentialthinking
      - task_done
`;

/** 全局缺省位无 config 时生成注释模板（首次引导）。护栏：CCR_TRAE_CONFIG 显式位不代写
 * （用户明指路径，拼写错应让 trae 自身报「Config file not found」暴露，代写会掩盖）；
 * CCR_STUB_MODE 在场=适配器测试桩环境，不碰真实 home（test-engine-adapters 活构
 * TraeAgentSession，无此护栏单测会在每台开发机写 ~/.trae-agent/）。幂等：在场即跳过。 */
function ensureTraeConfigTemplate(): void {
  if (process.env.CCR_TRAE_CONFIG?.trim() || process.env.CCR_STUB_MODE) return;
  const p = traeConfigPath();
  try {
    if (existsSync(p)) return;
    mkdirSync(join(homedir(), ".trae-agent"), { recursive: true });
    writeFileSync(p, TRAE_CONFIG_TEMPLATE, "utf-8");
  } catch { /* 生成失败不阻断 spawn——trae 会以缺 config 的明确报错暴露 */ }
}

export interface TraeSessionOptions extends Omit<EngineSpawnOptions, "label" | "args"> {
  command?: string;
}

export class TraeAgentSession extends JsonProcessAgentSession {
  constructor(opts: TraeSessionOptions) {
    // profileId 钉死 trae 档（structured=false）：纯文本 stdout 行一律正文（#42）
    super({ ...opts, label: "trae", command: opts.command ?? process.env.CCR_TRAE_PATH ?? "trae-cli", profileId: "trae" });
  }

  protected buildArgs(prompt: string): string[] {
    // 官方仓库 README 已确认：trae-cli run "<task>"；工作目录由 spawn cwd 提供。
    // W-ENGREST-FIX（1109 深测 P1）：恒带 --config-file 权威位（缺省 cwd 相对=生产不可用，
    // 见 traeConfigPath 头注）；缺省位无文件时先生成模板引导。
    ensureTraeConfigTemplate();
    return ["run", prompt, "--config-file", traeConfigPath()];
  }
}

export function preflightTrae(config?: Partial<EngineConfig>): PreflightResult {
  return preflightEngine({ command: config?.command ?? process.env.CCR_TRAE_PATH ?? "trae-cli", provider: config?.provider });
}

export function createTraeAgent(opts: Omit<TraeSessionOptions, "cb"> & { cb: AgentCallbacks }): TraeAgentSession {
  return new TraeAgentSession(opts);
}
