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

// ---------- #285 能力面（2026-10-27 一手 help/官方文档核实）----------
// 模型（--model）：20 个内置。分工建议（PM 侦察）：简单单=glm-5.3-flash/minimax-m3.1-flash
//（快）·标准=kimi-k3.1-pro/glm-5.3·--effort 档位独立于模型。
// 用户级 ~/.codebuddy/models.json 可自定义（id 覆盖/availableModels 全覆盖）。
export const CODEBUDDY_MODELS: readonly string[] = [
  "hy4-preview", "hy3", "hy3-x", "deepseek-v4.1-flash", "step-5-preview",
  "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo",
  "space-bunny", "minimax-m3.1-flash", "minimax-m3", "minimax-m2.7",
  "kimi-k3.1-pro", "kimi-k3-1", "kimi-k2.8-preview",
  "deepseek-v4-pro", "mimo-v2.6-pro",
];
// 档位（--effort）：六档。产品端「快速/均衡/极致」映射=快速→low·均衡→high·极致→xhigh。
export const CODEBUDDY_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const CODEBUDDY_EFFORT_ALIASES: Record<string, string> = { 快速: "low", 均衡: "high", 极致: "xhigh" };
// 权限（--permission-mode）：六档。adapter 推荐 worker spawn 用 acceptEdits 或 auto
//（防未预批准直接死），bypassPermissions 仅显式传入——永不作为缺省。
// 求值顺序：hooks→交互工具→deny→可信allow→命令安全检查→ask→bypass短路→不可信allow→模式基线→非交互兜底。
export const CODEBUDDY_PERMISSION_MODES: readonly string[] = ["default", "plan", "acceptEdits", "dontAsk", "auto", "bypassPermissions"];
// -y ≡ bypassPermissions；CODEBUDDY_IS_SANDBOXED=1+-y=沙箱红字全放（隐藏档 delegate/
// fullAccess/work/ignore 是 IDE/子代理内部档，CLI 适配器不开——防误入未文档化形态）。

export interface CodeBuddySpawnConfig {
  /** --effort（六档或产品端别名——别名在 adapter 内归一） */
  effort?: string;
  /** --permission-mode（六档；bypassPermissions 仅显式——adapter 层非显式即拒） */
  permissionMode?: string;
  /** --fallback-model（过载回退，-p 模式） */
  fallbackModel?: string;
  /** --allowedTools 白名单 */
  allowedTools?: string[];
  /** --disallowedTools 黑名单 */
  disallowedTools?: string[];
}

export interface CodeBuddySessionOptions extends Omit<EngineSpawnOptions, "label" | "args"> {
  command?: string;
  /** #285 能力面透传（engine profile / org dispatch 携带） */
  codebuddy?: CodeBuddySpawnConfig;
}

export class CodeBuddyAgentSession extends JsonProcessAgentSession {
  private readonly cbConfig: CodeBuddySpawnConfig;
  constructor(opts: CodeBuddySessionOptions) {
    // profileId 钉死 codebuddy 档（#42）
    super({ ...opts, label: "codebuddy", command: opts.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code", profileId: "codebuddy" });
    this.cbConfig = opts.codebuddy ?? {}; // #285 能力面配置（父类 opts 类型窄化——本类持有）
  }

  protected buildArgs(prompt: string): string[] {
    // B1a 修正（006 §3.3 一手 help 核实 + 本机 2026-10-05 help 复核）：--ci-mode
    // 已被 help 否定（旧注释引用的「规格冻结」与 006 现文冲突，以 006/实测为准）。
    // 非交互形态 = -p/--print 布尔开关 + prompt 位置参数 + --output-format；
    // stream-json 是官方声明的 realtime streaming 形态（Claude Code 协议同构族，
    // mapper 宽容解析，事件字段词汇真回合冒烟欠账维持——006 §3.4）。
    // 无 decision channel 时绝不映射 WAITING。
    // #285 能力面透传：model/effort/permission-mode/fallback-model/工具白黑名单
    //（一手 help 2026-10-27 核实）——所有值经白名单校验，非法即 throw（fail-fast
    // 防 spawn 带错参数静默跑偏）；bypassPermissions 仅显式传入，缺省永不放行。
    const args = ["--print", prompt, "--output-format", "stream-json"];
    const model = (this.opts.model || "").trim();
    if (model && model !== "default" && model !== "codebuddy") {
      if (!CODEBUDDY_MODELS.includes(model) && !model.startsWith("custom:")) {
        throw new Error(`codebuddy 未知模型: ${model}（内置 20 个或 custom: 前缀自定义，见 CODEBUDDY_MODELS）`);
      }
      args.push("--model", model.startsWith("custom:") ? model.slice(7) : model);
    }
    const cb = this.cbConfig;
    if (cb?.effort) {
      const eff = CODEBUDDY_EFFORT_ALIASES[cb.effort] ?? cb.effort;
      if (!CODEBUDDY_EFFORTS.includes(eff)) throw new Error(`codebuddy 未知档位: ${cb.effort}（六档或 快速/均衡/极致 别名）`);
      args.push("--effort", eff);
    }
    if (cb?.permissionMode) {
      if (!CODEBUDDY_PERMISSION_MODES.includes(cb.permissionMode)) {
        throw new Error(`codebuddy 未知权限模式: ${cb.permissionMode}（六档见 CODEBUDDY_PERMISSION_MODES）`);
      }
      args.push("--permission-mode", cb.permissionMode); // bypassPermissions 只能从这里显式进来
    }
    if (cb?.fallbackModel) {
      if (!CODEBUDDY_MODELS.includes(cb.fallbackModel) && !cb.fallbackModel.startsWith("custom:")) {
        throw new Error(`codebuddy 未知回退模型: ${cb.fallbackModel}`);
      }
      args.push("--fallback-model", cb.fallbackModel.startsWith("custom:") ? cb.fallbackModel.slice(7) : cb.fallbackModel);
    }
    if (cb?.allowedTools?.length) args.push("--allowedTools", cb.allowedTools.join(","));
    if (cb?.disallowedTools?.length) args.push("--disallowedTools", cb.disallowedTools.join(","));
    return args;
  }
}

export function preflightCodeBuddy(config?: Partial<EngineConfig>): PreflightResult {
  return preflightEngine({ command: config?.command ?? process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code", provider: config?.provider });
}

export function createCodeBuddyAgent(opts: Omit<CodeBuddySessionOptions, "cb"> & { cb: AgentCallbacks }): CodeBuddyAgentSession {
  return new CodeBuddyAgentSession(opts);
}
