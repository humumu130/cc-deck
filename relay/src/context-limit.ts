// 上下文窗口上限：集中维护并随 context_usage 下发，客户端不存映射表。
// #72 口径修正（2026-09-19 实测取证）：此前 /glm[-_]?5/ 映射 1M 是错的——本机
// glm-5.3 会话转录里 20+ 个压缩边界一致落在 per-call 水位 ~165-166K（个别长工具
// 回合越过检查点冲到 226-273K），即 Claude Code 自身按 200K 窗口、~83% 阈值自动
// 压缩（与用户 CLI+Claude HUD 时代"临近 100% 压缩"的体感一致）。显示口径必须与
// CLI 实际压缩行为一致。用户拍板：不追求贴近上限才压缩（高水位影响质量，早压缩
// 是好事），水位显示只需如实反映；压缩节奏完全归 CLI 管，这里只做显示。
export const CONTEXT_LIMIT_TOKENS = 200_000;

export function contextLimitOf(_model: string | undefined): number {
  return CONTEXT_LIMIT_TOKENS;
}

// 回放还原水位时的真实性上限（#72 follow-up，2026-09-19 夜实弹验证发现）：真实
// per-call 水位可以短暂越窗（取证：长工具回合越过压缩检查点冲到 226-273K），但
// 旧版 bug 把「回合聚合 usage」当水位写进事件流（忙会话动辄 500K+，e.g. 551835/
// 1070009），越此上限一律按污染丢弃——重启后新回合首个 message_delta 会写回真实
// 值，被丢弃的会话只是短暂无水位条（远好于显示假 >100%）。
export const REPLAY_CONTEXT_MAX = 300_000;
