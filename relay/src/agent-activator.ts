// W-ACTIVATOR Agent 激活器：事件驱动自动复活（停摆杜绝第三刀，2026-10-13 派单）。
// 定位（与已收编 liveness 门的分工）：liveness 门守「有人投递」的咽喉——消息/派单到达
// 时判死流就地拉活；本件守「没人投递」的死角——会话死了（SESSION_ERROR / 派单失败收口）
// 但没有后续投递事件时，由 EventBus 事件触发拉回。两条路共用 SessionManager 的
// reviveEligible 资格链（#189 resumePending 互斥=天然去重锁，不会双拉）。
// 频控纪律（防复活风暴）：同会话冷却窗（缺省 10min）+ 滚动小时全局上限（缺省 6 次），
// env 可调（CCR_ACTIVATOR_COOLDOWN_MS / CCR_ACTIVATOR_MAX_PER_HOUR）；CCR_NO_ACTIVATOR=1
// 逃生阀（测试/紧急关闭，与 CCR_NO_AUTOREVIVE 同族）。
// SESSION_DELETED 不触发（任务书防护：删除是显式意图，激活器不做误删复活）。
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { Envelope } from "./types.js";

const numEnv = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export interface ActivatorHandle {
  /** 触发统计（测试/运维观测） */
  stats(): { triggers: number; revives: number; skipped: number; failures: number; cooldownHits: number; windowHits: number };
  detach(): void;
}

export function attachAgentActivator(bus: EventBus, mgr: SessionManager): ActivatorHandle {
  const cooldownMs = numEnv("CCR_ACTIVATOR_COOLDOWN_MS", 10 * 60_000);
  const maxPerHour = Math.floor(numEnv("CCR_ACTIVATOR_MAX_PER_HOUR", 6));
  const lastAttempt = new Map<string, number>(); // sid → 上次尝试时刻（冷却窗）
  const recent: number[] = []; // 全局滚动小时窗内的尝试时刻
  const st = { triggers: 0, revives: 0, skipped: 0, failures: 0, cooldownHits: 0, windowHits: 0 };

  const pruneWindow = (now: number): void => {
    while (recent.length && now - recent[0]! > 3600_000) recent.shift();
  };

  const tryRevive = (sid: string, source: string, reason: string): void => {
    const now = Date.now();
    const last = lastAttempt.get(sid) ?? 0;
    if (now - last < cooldownMs) {
      st.cooldownHits++;
      return; // 同会话冷却窗内不重复拉（风暴纪律第一道）
    }
    pruneWindow(now);
    if (recent.length >= maxPerHour) {
      st.windowHits++;
      return; // 全局滚动窗上限（风暴纪律第二道——多会话连环死也不无限拉）
    }
    lastAttempt.set(sid, now);
    recent.push(now);
    st.triggers++;
    const r = mgr.reviveManagedSession(sid, source, reason);
    if (r.ok) st.revives++;
    else if (r.skipped) st.skipped++;
    else st.failures++;
  };

  const unsub = bus.subscribe((env: Envelope) => {
    if (process.env.CCR_NO_ACTIVATOR === "1") return;
    // 会话错误=会话死信号（含崩溃/外杀后 ERROR 化）。终态 DONE 不触发（正常收工）；
    // DELETED 不触发（删除是显式意图——任务书防护）。
    if (env.type === "SESSION_ERROR" && env.session_id) {
      tryRevive(env.session_id, "SESSION_ERROR", "会话进入错误态");
      return;
    }
    // 派单失败收口（瞬态帧）：承接 worker 会话拉回（若其仍有未完待办——资格链判）
    if (env.type === "DISPATCH_DONE" && env.payload) {
      const p = env.payload as { status?: string; worker_session_id?: string };
      if (p.status === "failed" && typeof p.worker_session_id === "string" && p.worker_session_id) {
        tryRevive(p.worker_session_id, "DISPATCH_FAILED", "派单失败收口");
      }
    }
  });

  return {
    stats: () => ({ ...st }),
    detach: unsub,
  };
}
