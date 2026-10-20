// W-SPLIT-S5 生命周期域③：上下文链（setExternalUsage/ctxWatchdog 挂钩——session-manager
// 方法体逐字搬出，仅 this.→mgr.）。搬运纪律同 S2/S3 样板：逻辑零改动（含注释原样）；
// 类面留委托壳（调用点 :2833/:2958/:3095 与外部 setBridge 面零改）。
import { randomUUID } from "node:crypto";
import { contextLimitOfEffective } from "../context-limit.js";
import { compactPrompt, wdThreshold, wdDropRatio, wdCooldownMs, wdCaptureTimeoutMs } from "../context-watchdog.js";
import { readPluginConfig } from "../plugin-config.js";

// 样板参数：真身 SessionManager——any 网关为跨 private 成员边界（行为等价由
// test-dispatch + parity 锁死，非类型信任面）

// 上下文窗口上限按模型区分（集中维护，随 context_usage 一起下发；换模型只改这里）。
// at 语义同 setTodos：首读 usage 种子传转录时刻（#157）
export function setExternalUsage(mgr: any, id: string, usage: any, model?: string, contextUsage?: number, at?: number): void {
  const s = mgr.sessions.get(id);
  if (!s) return;
  s.state.usage = usage;
  if (model) s.state.model = model;
  if (contextUsage !== undefined) {
    s.state.context_usage = contextUsage;
    // W-INJECT 问题⑤：外部会话也走 Effective 链——转录 model 是别名裸名
    //（claude-sonnet-5 等，GLM 别名舰队实跑 1M 窗），裸名直查落 200K 档=水位假满、
    // context-watchdog 误判压缩。W-CTXFIX B1 的「外部例外」前提（名字=CLI 实际
    // 口径）在别名方案下失真，统一按重挂规则升档
    s.state.context_limit = contextLimitOfEffective(model ?? s.state.model);
  }
  s.state.updated_at = at ?? Date.now();
  mgr.bus.emit(id, "SESSION_UPDATED", {
    status: s.state.status,
    action_summary: s.state.action_summary,
    stats: { ...s.state.stats },
    usage,
    ...(model ? { model } : {}),
    ...(contextUsage !== undefined ? { context_usage: contextUsage, context_limit: contextLimitOfEffective(model ?? s.state.model) } : {}), // W-INJECT⑤
    updated_at: s.state.updated_at,
  });
}

function ctxWdOf(s: any): any {
  if (!s.ctxWd) s.ctxWd = { capture: [] };
  return s.ctxWd;
}
/** 看门狗总开关（plugin-config 第六键 preCompactSummary，缺省 true） */
function ctxWdEnabled(): boolean {
  return readPluginConfig().preCompactSummary !== false;
}

export function ctxWatchdogOnContext(mgr: any, s: any, tokens: number): void {
  if (!ctxWdEnabled() || s.state.external) return;
  const limit = s.state.context_limit ?? 0;
  if (limit <= 0 || tokens <= 0) return;
  const wd = ctxWdOf(s);
  const now = Date.now();
  // 惰性超时：armed/pending 悬挂（流死/摘要回合无正文）超时放弃，状态机归零。
  // 不定时器——onContext 本就逐调用刷新，下一帧顺手清即可
  if ((wd.armed || wd.pending) && wd.since && now - wd.since > wdCaptureTimeoutMs()) {
    wd.armed = false;
    wd.pending = false;
    wd.since = undefined;
    wd.capture = [];
    mgr.pushExternalLog(s.state.session_id, "system", "压缩前摘要流程超时放弃");
  }
  // 骤降判定：per-call 水位单帧降幅超 limit×30% = CLI 已实际压缩（正常回合间
  // 波动是缓存重算的跳高不跳低，骤降只有全量压缩一种成因）。有摘要且未注回 →
  // 置标志，等下一回合首帧注入（COMMAND_MESSAGE 入口单点拼装）
  if (
    wd.lastWatermark !== undefined &&
    wd.lastWatermark - tokens > limit * wdDropRatio() &&
    s.state.pre_compact_summary &&
    !wd.reinjectPending
  ) {
    wd.reinjectPending = true;
    mgr.pushExternalLog(s.state.session_id, "system", "检测到上下文已压缩，任务状态摘要将在下一条消息自动注入");
    mgr.emitUpdated(s, true);
  }
  wd.lastWatermark = tokens;
  // 阈值触发。任何条件不满足都静默跳过（下一帧水位再说），不排队不重试
  if (tokens < limit * wdThreshold()) return;
  if (wd.armed || wd.pending || wd.reinjectPending) return; // 流程已在途/待注回
  if (s.state.status !== "WORKING" || s.state.compacting) return; // 回合态不符
  if (wd.lastPromptAt && now - wd.lastPromptAt < wdCooldownMs()) return; // 冷却窗（指令本身占水位，防风暴）
  const prompt = compactPrompt();
  wd.armed = true;
  wd.since = now;
  wd.lastPromptAt = now;
  wd.capture = [];
  // W-SCHEDFIX2 件一：水位告警入 unacked 重放账——与用户消息同账同出账语义
  //（:2757 先例：已 init 活流 = 无 hold，sendMessage 同步回显透传 ackId 精确出账，
  // 出账语义 =「已投递」）。此前裸 push 不透传 ackId——条目永无出队点，成功消费后
  // 恒滞留（污染 unacked 非空起疑判定，且下次 resume 被当积压重放成二次注入）。
  // push 先于 sendMessage：回显同步到达时账必须在。agent 不在场不落账（原实现
  // 裸 push 在 s.agent 为 null 时留幽灵悬账）。
  // echo 短文案：面板时间线显示一行系统动作，指令全文不刷屏
  if (s.agent) {
    const msgId = randomUUID();
    s.unacked.push({ id: msgId, text: prompt, ts: now, hold: s.state.relay_session_id ? undefined : "init" });
    s.agent.sendMessage(prompt, undefined, "【relay】上下文水位告警，已请求任务状态摘要", msgId);
  }
  mgr.pushExternalLog(s.state.session_id, "system", `上下文水位 ${Math.round((tokens / limit) * 100)}%，已请求压缩前任务状态摘要`);
  mgr.emitUpdated(s, true);
}

/** onStatusChange 挂点：回合终态边界推进两段态（armed→pending 升级 / pending 收口） */
export function ctxWatchdogOnTurnBoundary(mgr: any, s: any, newStatus: any): void {
  const wd = s.ctxWd;
  if (!wd) return;
  if (newStatus === "WORKING") return; // 只在回合终态边界推进
  const now = Date.now();
  if (wd.armed) {
    // 摘要指令发出后的第一个回合终态：开捕获窗（此后 assistant 正文属于摘要回合）
    wd.armed = false;
    wd.pending = true;
    wd.since = now;
    wd.capture = [];
    return;
  }
  if (wd.pending) {
    // 摘要回合结束：收口。无正文（模型直出 DONE/超时）= 本轮放弃，冷却已计，
    // 下次到阈值再试；有正文才写 state 并落痕
    const text = wd.capture.join("\n").trim();
    wd.pending = false;
    wd.since = undefined;
    wd.capture = [];
    if (text) {
      s.state.pre_compact_summary = text;
      mgr.pushExternalLog(s.state.session_id, "system", "压缩前任务状态摘要已固化");
    }
    mgr.emitUpdated(s, true);
  }
}
