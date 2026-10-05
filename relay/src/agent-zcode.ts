import { mapActivityState, type ActivityTaskSources, type AdapterPreflightResult, type MappedStatusDock } from "./agent-adapter.js";

export const ZCODE_ACTIVITY_CAPABILITIES = {
  native_status: false,
  operation_summary: false,
  native_elapsed: false,
  approval: false,
} as const;

export interface ZCodeActivityOptions {
  now?: number;
  task?: ActivityTaskSources;
}

/**
 * ZCode 显式 unsupported 主档（018 :293-294 矩阵「显式 unsupported/fail-closed；
 * 不得因枚举存在而加入默认列表」）。恒不通过：隐私/遥测 preflight 缺口（006 §3.5，
 * 2026-09-23 静默上传 Git 历史争议）未建可验证的关闭机制前不接入——显式档位函数
 * 而非散落 if，注册表/调用方面对的是同一个可判定的拒绝面。不探测本地 bin：
 * 装没装不是放行条件，遥测机制核验 + acknowledged_warning 才是（006 §3.5）。
 */
export function preflightZCode(): AdapterPreflightResult {
  return {
    ok: false,
    command: "zcode",
    errors: [
      "ZCode unsupported 主档：隐私/遥测 preflight 缺口（006 §3.5 fail-closed），不接入、不伪造 activity",
    ],
    warnings: [
      "启用前置：遥测默认关闭机制的不可绕过核验 + upload_git_history 单独开关 + acknowledged_warning 确认（006 §3.5）",
    ],
  };
}

/** ZCode 未通过隐私/遥测 preflight；保持显式 unsupported，不伪造活动。 */
export function mapZCodeActivity(options: ZCodeActivityOptions = {}): MappedStatusDock {
  return mapActivityState({
    state: "ERROR",
    now: options.now,
    task: options.task,
    capabilities: ZCODE_ACTIVITY_CAPABILITIES,
    unsupported: "ZCode privacy/telemetry preflight 未通过；activity unsupported",
  });
}
