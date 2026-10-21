// W-AUTOMSG #194（用户 1021 反馈）：自动注入消息标记表——调度器 cron 自动注入 PM 会话
// 的消息（如「【cc-deck 巡检轮】①查在办 worker…」）经桥进来就是真用户消息，relay 侧
// 无标记可用，双端按前缀识别折叠显示（一行小灰字，点开看原文）。
// 前缀清单（单一事实源本件；web-console/js 消费面维护同表副本——两端无共享机制，
// 改清单须两处同步）：
//   【cc-deck 巡检轮】  用户自配 cron 巡检任务文案（任务书给定收录）
//   [值守喂活]          relay feedPM 值守注入（session-manager feedPM prompt 首行
//                      固定格式「[值守喂活] feed=… 触发=…」——同语义噪音面，一并收录）
export const AUTO_MSG_PREFIXES: readonly string[] = [
  "【cc-deck 巡检轮】",
  "[值守喂活]",
];

/** 命中任一已知自动注入前缀（前导空白容忍）→ true=折叠显示 */
export function isAutoInjected(text: string): boolean {
  const t = text.trimStart();
  return AUTO_MSG_PREFIXES.some((p) => t.startsWith(p));
}
