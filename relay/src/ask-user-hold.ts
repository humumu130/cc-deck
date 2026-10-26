// #273 managed AskUserQuestion 挂起窗口（防 passcomb 式 84 分钟死锁）
//
// 背景（docs：relay/spike/askuser-cloud/protocol-findings.md）：
// - external 路径有 questionHoldMs（bridge.ts，默认 90s）——超时放行 CLI 本地选择器，
//   且 askFallback 把迟到作答转注入（bridge.ts:1591「两端任一先答即生效」）。
// - managed（SDK stream-json）路径两者皆无：AskUserQuestion 经 can_use_tool
//   control_request 挂起，无本地选择器可放行 → 无人作答=永久死锁（1026 passcomb
//   84.6 分钟实锤，最终 PM kill+resume 手动救）。
//
// 本件语义：
// - 超时放行 = deny-message「远程未作答」（模型按默认方案继续，denial 作为 tool_result
//   回给模型——summarizer.buildAnswerMessage 同通道，spike 实测 CLI 立即续跑）。
// - 迟到作答 = 超时后 LATE_INJECT_WINDOW_MS 内到达的 COMMAND_ANSWER 转 sendMessage
//   注入（对齐 external askFallback 语义）；再晚 = 作废（作答 false）。
import type { AskQuestion } from "./types.js";

/** 挂起窗口毫秒。默认 15 分钟：远程作答要时间（external 90s 对远程太短——daylog
 * 实锤），无限则是死锁（passcomb 实锤）。CCR_ASK_HOLD_MS 显式覆盖；0 = 关死超时
 * （仅真实作答/会话清扫可解，恢复 1026 前行为，排障逃生门）。 */
export function askHoldMs(): number {
  const v = Number(process.env.CCR_ASK_HOLD_MS);
  return Number.isFinite(v) && v >= 0 ? v : 900_000;
}

/** 迟到作答可注入窗口（超时放行后多久内的作答仍值得注入送达） */
export const LATE_INJECT_WINDOW_MS = 30 * 60_000;

export class AskUserHold {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private late = new Map<string, { questions: AskQuestion[]; at: number }>();

  constructor(private readonly lateWindowMs: number = LATE_INJECT_WINDOW_MS) {}

  /** 挂起窗口上膛。超时触发后该 requestId 自动进入迟到可注入窗口（供 answer() 注入）。
   * ms<=0 = 不挂定时器（超时关死），同时清除既有迟到窗记录。 */
  arm(requestId: string, questions: AskQuestion[], onTimeout: () => void, ms: number = askHoldMs()): void {
    this.settle(requestId);
    if (ms <= 0) return;
    this.timers.set(
      requestId,
      setTimeout(() => {
        this.timers.delete(requestId);
        this.late.set(requestId, { questions, at: Date.now() });
        onTimeout();
      }, ms),
    );
    // 防御性水位：正常流决议即 settle，稳态近空；溢出只可能是泄漏，清最早一条兜底
    if (this.timers.size > 32) {
      const first = this.timers.keys().next().value;
      if (first !== undefined) this.settle(first);
    }
  }

  /** 决议收口（allow/deny/answer/superseded/清扫）：撤定时器 + 作废迟到窗。
   * 注意与超时路径互斥——超时触发时定时器已自然移除且要保留迟到窗，不走本方法。 */
  settle(requestId: string): void {
    const t = this.timers.get(requestId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(requestId);
    }
    this.late.delete(requestId);
  }

  /** 迟到可注入：命中返回当时的问题集（供 buildAnswerMessage 组装注入文本），越窗/未知返回 undefined */
  injectable(requestId: string): AskQuestion[] | undefined {
    const e = this.late.get(requestId);
    if (!e) return undefined;
    if (Date.now() - e.at > this.lateWindowMs) {
      this.late.delete(requestId);
      return undefined;
    }
    return e.questions;
  }

  /** 会话终止/停止：全量收口（stop() 路径） */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.late.clear();
  }
}
