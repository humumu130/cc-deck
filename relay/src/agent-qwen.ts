import type { AgentCallbacks } from "./agent-adapter.js";
import { JsonProcessAgentSession, mapJsonlActivity, preflightEngine, type EngineConfig, type EngineSpawnOptions, type JsonlActivityOptions, type MappedStatusDock, type PreflightResult } from "./agent-jsonl.js";

export const QWEN_CODE_CAPABILITIES = {
  // [W-ENGDIST-B 件一]（1110）：resume=true——CLI 0.27.1 help 实勘 -r/--resume <sessionId>，
  // result 帧 session_id 捕获（实测 json 输出在场）+buildArgs 消费+失锚自愈（构造器
  // 包装：失败文案含 session/resume 即清锚回落全文重注——CLI 对失锚硬错 exit 1 实测）。
  resume: true,
  reinjection: true,
  approval: false,
  images: false,
  usage: true,
  todos: false,
  artifacts: false,
  streaming: false,
} as const;

export const QWEN_ACTIVITY_CAPABILITIES = {
  native_status: false,
  operation_summary: true,
  native_elapsed: false,
  approval: false,
} as const;

export const QWEN_PENDING_SMOKE = [
  "JSONL 是否可用及事件字段稳定性",
  "provider/base URL/model 参数与鉴权变量名",
] as const; /* [W-ENGDIST-B 件一] resume 项已清（help 实勘+result 帧 session_id 实测在场+失锚自愈接线） */

export function mapQwenCodeActivity(raw: unknown, options: Omit<JsonlActivityOptions, "capabilities" | "profileId"> = {}): MappedStatusDock {
  // #42 收口：档位钉死 qwen-code（JSON 单对象基线，JSONL/stream 宽容两吃）
  return mapJsonlActivity(raw, { ...options, capabilities: QWEN_ACTIVITY_CAPABILITIES, profileId: "qwen-code" });
}

export interface QwenCodeSessionOptions extends Omit<EngineSpawnOptions, "label" | "args"> {
  command?: string;
}

export class QwenCodeAgentSession extends JsonProcessAgentSession {
  constructor(opts: QwenCodeSessionOptions) {
    // profileId 钉死 qwen-code 档（#42）
    // [W-ENGDIST-B 件一]（1110，qwen 0.27.1 help 实勘 -r/--resume <sessionId>）：原生
    // 续会话接线——mapper 已从 result 帧 session_id 捕获 engineSessionId（jsonl 基类
    // G3 机制），本类此前只是没消费（buildArgs 忽略第二参）。失锚自愈：CLI 对不存在的
    // session 硬错退出（实测 `--resume deadbeef` → stderr「No saved session found…」
    // exit 1，qwen 无 codebuddy --resume-create-missing 等价物）——包装 cb.onTurnEnd
    // 在失败文案命中 session/resume 时清 engineSessionId，下一回合回落全文重注（引擎
    // 侧会话被清/换机场景不断流，代价=该轮上下文丢失，usage 面可察——G3 同款语义
    // 由 relay 侧实现）。
    super({
      ...opts,
      label: "qwen-code",
      command: opts.command ?? process.env.CCR_QWEN_PATH ?? "qwen",
      profileId: "qwen-code",
      cb: {
        ...opts.cb,
        onTurnEnd: (ok, detail, ms) => {
          if (!ok && /session|resume/i.test(String(detail ?? ""))) {
            this.engineSessionId = undefined; // 失锚自愈：下回合回落全文重注
            try { opts.cb.onLog("system", "qwen 引擎侧会话失锚——已回落全文重注（resume 锚清空）"); } catch { /* 尽力而为 */ }
          }
          opts.cb.onTurnEnd(ok, detail, ms);
        },
      },
    });
  }

  protected buildArgs(prompt: string, resumeSessionId?: string): string[] {
    // 006 §3.2 已确认的基线：-p + --output-format json；其余能力仍待冒烟。
    // W-ENGREST-FIX（1109 根因考证）：headless（-p 非交互）默认档剔除审批类工具——CLI 警告
    // 原文点名 (shell, write, edit)，init 帧 tools 恒无 write_file/edit/run_shell_command
    //（实测基线 26 工具 8 轮空转建不成文件）；--approval-mode yolo 后 31 工具含执行类、
    // 2 轮建成（b.txt 实证）。relay 层即权限边界（能力位 approval=false=006 口径 auto
    // 全放行），CLI 侧 yolo 与之同义——审批策略由 relay 统一，不靠引擎交互。
    return [
      "-p",
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []), // [W-ENGDIST-B 件一] 原生续（0.27.1 help：-r, --resume <sessionId>）——上下文由引擎侧会话承载，免每轮新进程重注全文
      prompt,
      "--output-format", "json",
      "--approval-mode", "yolo",
    ];
  }
}

export function preflightQwen(config?: Partial<EngineConfig>): PreflightResult {
  return preflightEngine({ command: config?.command ?? process.env.CCR_QWEN_PATH ?? "qwen", provider: config?.provider });
}

export function createQwenCodeAgent(opts: Omit<QwenCodeSessionOptions, "cb"> & { cb: AgentCallbacks }): QwenCodeAgentSession {
  return new QwenCodeAgentSession(opts);
}
