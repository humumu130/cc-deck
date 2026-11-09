import type { AgentCallbacks } from "./agent-adapter.js";
import { JsonProcessAgentSession, mapJsonlActivity, preflightEngine, type EngineConfig, type EngineSpawnOptions, type JsonlActivityOptions, type MappedStatusDock, type PreflightResult } from "./agent-jsonl.js";

export const CODEBUDDY_CAPABILITIES = {
  // [W-ENGCB-FIX G3/G6]（1109 深测回执实测推翻 2026-10-27 保守断言）：
  // resume=true——CLI 有 -r/--resume（2.179.3 help 实证），execTurn 经 buildArgs 第二参
  // 传 --resume <sid> 原生续会话（adapter 捕获 stream-json init 帧 session_id）；
  // usage=true——result 帧完整 usage（input/output/cache 含 1M contextWindow）实测在场，
  // mapper onUsage 已通；todos=true——TaskCreate/TaskUpdate 工具族（todos 语义）实测；
  // streaming=true——stream-json 实时帧（--output-format stream-json 官方 realtime 形态）。
  resume: true,
  reinjection: true,
  approval: false,
  images: false,
  usage: true,
  todos: true,
  artifacts: false,
  streaming: true,
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

// ---------- #285 能力面（2026-10-27 一手 help；[W-ENGCB-FIX G4] 1109 对齐 2.179.3 --help 实勘）----------
// 模型（--model）：help 实勘 **17 个**（深测回执记 18 为计偏；旧表 20 个含 4 幽灵键：
// glm-5.1/glm-5v-turbo/minimax-m3/hy4-preview 均不在 help——白名单 fail-fast 误拒真键
// hy4free/hy4std 的同时放行幽灵键）。分工建议（PM 侦察）：简单单=glm-5.3-flash/
// minimax-m3.1-flash（快）·标准=kimi-k3.1-pro/glm-5.3·--effort 档位独立于模型。
// 漂移教训：CLI 升版会动清单——词表与 help 失配时 custom: 前缀是逃生门（绕白名单直传）。
// 用户级 ~/.codebuddy/models.json 可自定义（id 覆盖/availableModels 全覆盖）。
export const CODEBUDDY_MODELS: readonly string[] = [
  "hy4free", "hy4std", "hy3", "hy3-x", "deepseek-v4.1-flash",
  "glm-5.3", "glm-5.3-flash", "glm-5.2", "space-bunny",
  "minimax-m3.1-flash", "minimax-m2.7",
  "kimi-k3.1-pro", "kimi-k3-1", "kimi-k2.8-preview",
  "deepseek-v4-pro", "step-5-preview", "mimo-v2.6-pro",
];
// 档位（--effort）：六档。产品端「快速/均衡/极致」映射=快速→low·均衡→high·极致→xhigh。
export const CODEBUDDY_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const CODEBUDDY_EFFORT_ALIASES: Record<string, string> = { 快速: "low", 均衡: "high", 极致: "xhigh" };
// 权限（--permission-mode）：六档。[W-ENGCB-FIX G2]（1109 深测五档实测定谳）：
// **worker spawn 推荐档=auto**——acceptEdits 下 Bash 硬拒（非交互模式无批准通道，
//「无法弹出权限提示」），worker 跑不了任何命令=全哑；auto 档 Bash 免问跑通（实测）。
// default=Read 类免批但 Bash 拒；dontAsk=Bash 拒（模型自降级 Read 韧性好）；plan 未测深；
// bypassPermissions 仅显式传入——永不作为缺省（G1：dangerous 黑名单可中转绕过，
// 恒非 bypass 是 relay 侧唯一可靠防线——推广文案不得宣称 codebuddy 有 dangerous 工具防线）。
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

  protected buildArgs(prompt: string, resumeSessionId?: string): string[] {
    // B1a 修正（006 §3.3 一手 help 核实 + 本机 2026-10-05 help 复核）：--ci-mode
    // 已被 help 否定（旧注释引用的「规格冻结」与 006 现文冲突，以 006/实测为准）。
    // 非交互形态 = -p/--print 布尔开关 + prompt 位置参数 + --output-format；
    // stream-json 是官方声明的 realtime streaming 形态（Claude Code 协议同构族，
    // mapper 宽容解析，事件字段词汇真回合冒烟欠账维持——006 §3.4）。
    // 无 decision channel 时绝不映射 WAITING。
    // [W-ENGCB-FIX G3] 原生续会话：有引擎侧 session id（第二回合起）传 --resume——
    // 上下文由引擎侧会话承载，免每轮新进程重注全文（深测实测重注单轮 input 22.7k）。
    // --resume-create-missing 随行：引擎侧会话被清（引擎重启/存储回收）时同 id 重建
    // 空会话续跑而非硬错——回合不断流（代价=该轮上下文丢失，usage 面可察）；
    // help 自述该 flag 即「job worker respawn recovery path」——正是 relay 复活链形态。
    // #285 能力面透传：model/effort/permission-mode/fallback-model/工具白黑名单
    //（一手 help 2026-10-27 核实）——所有值经白名单校验，非法即 throw（fail-fast
    // 防 spawn 带错参数静默跑偏）；bypassPermissions 仅显式传入，缺省永不放行。
    const args = [
      "--print",
      ...(resumeSessionId ? ["--resume", resumeSessionId, "--resume-create-missing"] : []),
      prompt,
      "--output-format", "stream-json",
    ];
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
