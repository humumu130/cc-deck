// W-CTXFIX B3（2026-10-10）：托管会话 context 阈值看门狗——压缩前任务摘要固化与注回。
//
// 背景（W-CTXDIAG 诊断）：CLI auto-compact 一旦发生，转录里只留 CLI 自己的摘要，
// relay/用户对「压缩前任务做到哪了」无感知；1M 大窗口会话被 200K 口径误压缩时
//（#22 之前的生产实态）任务状态丢失尤其致命。链路（用户拍板方向）：
//   水位 ≥85% → 发结构化摘要指令 → 捕获该回合 assistant 输出 → 存
//   state.pre_compact_summary → 检测 CLI 实际压缩（水位骤降）→ 下一回合首帧以
//   system-reminder 形态注回，只注一次。
// 压缩节奏仍完全归 CLI 管（context-limit.ts 同口径），本模块只做「压缩前的状态
// 外置存档」，不干预压缩本身。
//
// 状态机（两段态，防当前回合正文误捕）：armed（指令已入队，当前回合未结束）
//   → pending（当前回合终态，捕获窗开启）→ 终态收口（capture 写入 state）。
//   armed 期间到达的 assistant 文本属于摘要指令发出前的回合，不捕。

// ---------- 调参常量（env 可覆盖，沙盒测试把阈值调低即可触发全链） ----------

/** 水位阈值（占有效 limit 比例）：≥ 此值触发摘要指令 */
export const WD_THRESHOLD = 0.85;
/** 水位骤降比例（相对 limit）：单帧降幅超此值判定 CLI 已实际压缩 */
export const WD_DROP_RATIO = 0.3;
/** 摘要指令冷却窗：窗口内不重复触发（指令本身占水位，防风暴） */
export const WD_COOLDOWN_MS = 5 * 60_000;
/** 摘要字数上限（写进指令文案，模型自约束） */
export const WD_SUMMARY_MAX_CHARS = 500;
/** 捕获窗超时：armed/pending 悬挂超过此时长放弃（流死/模型不输出正文等异常态） */
export const WD_CAPTURE_TIMEOUT_MS = 10 * 60_000;

function envNum(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function wdThreshold(): number {
  return envNum("CCR_CTX_WD_THRESHOLD", WD_THRESHOLD, 0.01);
}
export function wdDropRatio(): number {
  return envNum("CCR_CTX_WD_DROP", WD_DROP_RATIO, 0.01);
}
export function wdCooldownMs(): number {
  return envNum("CCR_CTX_WD_COOLDOWN_MS", WD_COOLDOWN_MS);
}
export function wdCaptureTimeoutMs(): number {
  return envNum("CCR_CTX_WD_CAPTURE_TIMEOUT_MS", WD_CAPTURE_TIMEOUT_MS);
}

// ---------- 指令与注回文案 ----------

/** 摘要指令（发进会话的 user 消息正文）：状态级非全文级，模型自约束字数 */
export function compactPrompt(): string {
  return [
    "[relay·系统维护] 上下文水位即将触及压缩阈值。请立即输出本任务的状态摘要，",
    "用于压缩后恢复工作记忆。要求：",
    "① 只输出摘要文本本身，不要调用任何工具；",
    `② 总长 ≤${WD_SUMMARY_MAX_CHARS} 字，状态级而非全文级；`,
    "③ 依次覆盖：任务书要点 / 已完成 / 进行中 / 下一步 / 关键文件:行号 / 纪律红线。",
  ].join("\n");
}

/** 注回包装（下一回合首帧前缀）：system-reminder 形态，标注外置存档来源 */
export function wrapPreCompactReminder(summary: string): string {
  return (
    `<system-reminder>\n` +
    `压缩前任务状态摘要（外置记忆存档，压缩时由 relay 自动固化；仅供恢复上下文参考，` +
    `以当前磁盘与任务清单实际状态为准）：\n${summary}\n` +
    `</system-reminder>\n\n`
  );
}
