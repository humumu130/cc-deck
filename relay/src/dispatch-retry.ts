// #G5 失败分类学+瞬态自动重试（对标 multica，用户拍板 PM 推荐先行）。
// 分类器纯函数（错误串→六枚举）+ 瞬态判定 + 重试调度包装。写侧单点=org.appendDispatch
//（failed 行自动 failure_reason）；重试挂钩=session-manager dispatchWorker 的 spawn
// 失败出口（queue_replay 同 id 段链 + retry_of 标记，链深恒 1 防循环）。
// 逻辑类（logic_error/tool_crash/cancelled）不自动重试——人工/PM 决策（与零产出
// DONE 闸 L-1026-1 互补：那是收口质检，这是投递容错）。
// 本模块零 org 依赖（防循环 import）：hasRetryMark 的台账证据读在 session-manager
// 消费侧内联（readDispatchLog 已在彼 import）。

/** #G5 失败分类学：六枚举（任务书口径）。 */
export type DispatchFailureReason =
  | "network_error"
  | "timeout"
  | "tool_crash"
  | "model_overload"
  | "logic_error"
  | "cancelled";

export const DISPATCH_FAILURE_REASONS = [
  "network_error", "timeout", "tool_crash", "model_overload", "logic_error", "cancelled",
] as const;

/** 瞬态类（自动重试一次的资格集）：网络/超时/模型过载——重跑大概率好；逻辑类
 * （参数错/编制闸/工具崩/取消）重跑同结果，留给人工/PM。 */
export const TRANSIENT_FAILURES: ReadonlySet<string> = new Set(["network_error", "timeout", "model_overload"]);

/** 自动重试延迟（任务书口径 30s）：429 配额窗/网络抖动的典型恢复尺度。 */
export const TRANSIENT_RETRY_DELAY_MS = 30_000;

/**
 * 错误串→失败分类（纯函数，测试直吃）。匹配序=specific→generic，先命中先赢：
 *   cancelled（明确中止语义，最 specific）→ model_overload（429/限额/过载）→
 *   timeout（超时族）→ network_error（连接族）→ tool_crash（崩族）→ 兜底 logic_error。
 * 本仓真实错误串锚：429「API Error: Request rejected (429)·已达到 5 小时的使用上限」；
 * 「初始化超时（30s）」；ECONNRESET/ENOTFOUND；编制闸拒（入编被编制上限闸拒绝）等。
 */
export function classifyDispatchFailure(text: string): DispatchFailureReason {
  const t = String(text ?? "");
  if (/cancel|interrupt|abort|中止|取消/i.test(t)) return "cancelled";
  if (/429|rate.?limit|overload|使用上限|配额|quota|too many requests/i.test(t)) return "model_overload";
  if (/timeout|timed?.?out|etimedout|超时/i.test(t)) return "timeout";
  if (/network|econnreset|econnrefused|enotfound|ehostunreach|fetch failed|socket|hang ?up|网络|连接/i.test(t)) return "network_error";
  if (/crash|panic|segfault|崩/i.test(t)) return "tool_crash";
  return "logic_error";
}

/** 瞬态判定：分类 ∈ 瞬态集（自动重试资格）。 */
export function isTransientFailure(reason: string): boolean {
  return TRANSIENT_FAILURES.has(reason);
}

/** 重试调度包装（测试注入缝：短延迟直跑）。unref=不阻进程退出。 */
export function scheduleTransientRetry(fire: () => void, delayMs: number = TRANSIENT_RETRY_DELAY_MS): void {
  const t = setTimeout(fire, delayMs);
  t.unref?.();
}
