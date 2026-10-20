// W-SPLIT-S5 生命周期域②：autoRevive/激活器协调（session-manager 六方法体逐字搬出，
// 仅 this.→mgr.+内部互调直调化）。搬运纪律同 S2/S3 样板：逻辑零改动（含注释原样）；
// 类面留委托壳（public 接口零变——index.ts boot 调用/激活器调用面/ensureAuthWatch
// 回调均不改）。
import { getEngineDefinition } from "../engine-registry.js";
import type { SessionEngine } from "../types.js";
import { ensureAuthWatch, takeBlockedCreates, takeBlockedDispatches } from "../engine-auth-watch.js";
import { readTaskStoreTodos } from "../task-store.js";
import { truncate } from "../summarizer.js";
import { findGroup } from "../projects.js";
import { resumePendingWindowMs } from "../session-manager.js"; // 类侧导出单源（S5 拆分面：常量级工具，S6 可提公共件

// 样板参数：真身 SessionManager——any 网关为跨 private 成员边界（行为等价由
// test-dispatch + parity 锁死，非类型信任面）。模块级工具（findGroup/
// resumePendingWindowMs）直接 import 单源。

// #75 无人值守连续性（2026-09-19 用户拍板最小闭环：不追求完善机制，先保证
// 「重启后当前工作会话能被拉起继续干活」）：relay 启动收养历史托管会话后，凡
// CLI 任务存储（按会话家：默认 ~/.claude 或雇员独立家的 tasks/<cli_sid>/，
// 权威源）里仍有未完成待办
//（pending/in_progress）的托管会话，自动 resume 并注入续跑指令——不再依赖人
// 发消息触发恢复。约束：外部会话不适用（用户终端自管，hooks 会重新接入）；
// 无未完成待办的不拉（已收工/纯闲聊会话拉起来只会空转耗 token）；单次上限
// 按最近活跃排序取 3 个；失败即止不重试（留 historical 态 = 与旧行为一致，
// 等人来发消息）。CCR_NO_AUTOREVIVE=1 逃生阀（测试/紧急关闭）。
export function autoReviveManaged(mgr: any, limit = 3): number {
  if (process.env.CCR_NO_AUTOREVIVE === "1") return 0;
  const candidates: { s: any; updated: number }[] = [];
  for (const s of mgr.sessions.values()) {
    if (reviveEligible(mgr, s)) continue;
    candidates.push({ s, updated: s.state.updated_at });
  }
  candidates.sort((a, b) => b.updated - a.updated);
  let revived = 0;
  for (const c of candidates) {
    if (revived >= limit) break;
    try {
      mgr.resumeAgent(c.s, "[relay 自动恢复] relay 重启完成，检测到本会话仍有未完成任务。" + reviveInstruction(c.s));
      revived++;
    } catch (e) {
      console.log(`[auto-revive] ${c.s.state.session_id.slice(0, 8)} 恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (revived > 0) console.log(`[auto-revive] 已自动拉起 ${revived} 个有未完成待办的托管会话`);
  return revived;
}

// ---------- #102 批 C：引擎登录就绪恢复三面（探/登/通之「通」） ----------
// ready 三源（watch 兜底循环 / 批 B pane 轮验 / verify 手动验证）都收敛到本入口；
// 10s 幂等窗去重——同一就绪事件多源重复触发只跑一轮。
//   面一（会话恢复）：运行时失效进 needs_auth 的 ERROR 会话自动 resume——复用
//     resumeAgent + renewable 值守 prompt（流断即丢不记重放账，duty 重推导再注入），
//     恢复尝试即清 auth_hint（摘 needs_auth 牌防重复触发）；
//   面二（创建拦截）：无会话实体可恢复——消费 intent 快照发通知「已登录，可以创建了」
//     +anchor/task 摘要回显；
//   面三（派单拦截）：通知「已登录，可以重新派单」——不自动重放（失败重放有
//     副作用风险，重发是用户动作）。
export function recoverEngineAfterAuth(mgr: any, engine: SessionEngine): void {
  const now = Date.now();
  if (now - (mgr.authRecoverAt.get(engine) ?? 0) < 10_000) return;
  mgr.authRecoverAt.set(engine, now);
  const label = getEngineDefinition(engine)?.label ?? engine;
  let resumed = 0;
  for (const s of mgr.sessions.values()) {
    // 只恢复运行时失效面（ERROR+auth_hint）；手动救活/已收口的会话不命中条件
    if (s.state.engine !== engine || !s.state.auth_hint || s.state.status !== "ERROR") continue;
    s.state.auth_hint = undefined; // 恢复尝试即摘牌（防本轮回环重复恢复；快照随帧自愈）
    try {
      mgr.resumeAgent(
        s,
        `[引擎登录恢复] ${label} 已登录，自动恢复本会话。检测到本会话仍有未完成任务。` + reviveInstruction(s),
        undefined, undefined, undefined, { renewable: true },
      );
      mgr.pushExternalLog(s.state.session_id, "system", `${label} 已登录，会话已恢复`);
      resumed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mgr.pushExternalLog(s.state.session_id, "system", `${label} 已登录，但会话自动恢复失败：${msg}（可手动发消息拉起）`);
    }
  }
  if (resumed > 0) {
    try {
      mgr.upsertNotification("system", `auth-recover-${engine}`, String(now), {
        title: `${label} 已登录`,
        body: truncate(`任务已恢复（${resumed} 个会话自动拉起）`, 160),
        severity: "info", group: "activity", actionable: false, domain: "session", returnPath: "sessions",
      });
    } catch { /* 通知面尽力而为 */ }
  }
  for (const c of takeBlockedCreates(engine)) {
    try {
      mgr.upsertNotification("system", `auth-create-${engine}-${c.ts}`, String(c.ts), {
        title: `${label} 已登录，可以创建了`,
        body: truncate(`此前被拦的创建已解锁：${c.prompt_summary || "(无任务摘要)"}${c.cwd ? `（目录 ${c.cwd}）` : ""}`, 160),
        severity: "info", group: "activity", actionable: false, domain: "session", returnPath: "sessions",
      });
    } catch { /* 尽力而为 */ }
  }
  for (const d of takeBlockedDispatches(engine)) {
    try {
      mgr.upsertNotification("system", `auth-dispatch-${engine}-${d.ts}`, String(d.ts), {
        title: `${label} 已登录，可以重新派单`,
        body: truncate(`此前被拦的派单已解锁：${d.title || d.anchor}`, 160),
        severity: "info", group: "activity", actionable: false, domain: "session", returnPath: "sessions",
      });
    } catch { /* 尽力而为 */ }
  }
}

// #102 批 C：重启扫描——relay 起动收养后为 needs_auth 态（auth_hint 在场）的会话
// 挂兜底重探（不拉活：拉活面归 autoReviveManaged 的待办判定；此处只挂探针监听，
// ready 即走恢复三面）。不受 CCR_NO_AUTOREVIVE 阀控（探测≠拉活）。
export function scanNeedsAuthSessions(mgr: any): number {
  const engines = new Set<SessionEngine>();
  for (const s of mgr.sessions.values()) {
    if (s.state.auth_hint && s.state.engine && s.state.engine !== "claude") engines.add(s.state.engine);
  }
  for (const e of engines) ensureAuthWatch(e);
  return engines.size;
}

// ---------- W-ACTIVATOR 单会话复活资格链（autoReviveManaged 过滤链抽出共用） ----------
// 返回 null=可拉；字符串=skip 原因（审计/测试可断言）。boot 扫描与事件驱动激活器
// 共用同一链——两条入口纪律零分叉（外部/在场/parked/退休/互斥/pin 休眠/熔断/锚点/
// 待办/48h 新鲜度，语义逐条搬自 autoReviveManaged 原实现，行为零变）。
// W-CDXREV 复活注入指令 engine 感知：claude 读任务清单续跑（既有口径）；codex 无
// Claude 系任务存储可读——改为「从中断处接续」口径（resume 上下文在 thread 里）
function reviveInstruction(s: any): string {
  return s.state.engine === "codex"
    ? "请从中断处接续推进当前任务：先简述已完成部分与下一步，再继续执行。"
    : "请直接读取任务清单继续推进工作，无需复述上下文。";
}
function reviveEligible(mgr: any, s: any): string | null {
  if (s.state.external) return "external";
  if (s.agent) return "agent-alive";
  // #26 M3 审查修正：挂起退休成员不自动拉起——组挂起=编制退休释放（板冻结）
  if (s.state.org_parked) return "org-parked";
  if (s.state.project_gid) {
    const pg = findGroup(s.state.project_gid);
    if (pg && pg.status !== "active") return "group-not-active";
  }
  // #26 补章审查修正（A/B 双报）：退休成员（member-retire 编制除名）不得起死回生
  if (mgr.isRetiredMember(s.state.session_id)) return "retired";
  // #189 resume 互斥（liveness 门同款去重锁——在途标记在则跳过，双拉防双进程）
  if (s.resumePending && Date.now() - s.resumePending < resumePendingWindowMs()) return "resume-in-flight";
  // W-LEADFIX pin 休眠豁免（用户拍板「开机不自动 resume」，见 applyPinned）
  if (s.state.pinned && s.state.saved) return "pinned-dormant";
  // W-LEADFIX 熔断豁免：连续 resume 失败冷却期内不自动拉起（防死循环换入口重演）
  if (s.resumeCooldownUntil && Date.now() < s.resumeCooldownUntil) return "resume-cooldown";
  if (!s.state.relay_session_id) return "no-resume-anchor";
  // W-CDXREV（用户 1013 指令根治）：codex 引擎无 Claude 系任务存储（readTaskStoreTodos
  // 恒 null=拉活死路，重启后 codex 会话全变历史只读）——以状态信号判活工作：
  // ERROR=回合失败死流（与激活器死信号同源）；WORKING=重启时在跑被腰斩（回放僵尸，
  // 语义等价 claude「有未完成待办」）；DONE=正常收工不拉（与 claude 语义一致）。
  // resume 链 codex 已通（resumeAgent→newAgent(engine:"codex")→CodexAgentSession
  // exec resume <thread_id>，relay_session_id=thread_id 即 resume 锚）。
  // 48h 新鲜度/互斥/冷却等闸门在后段共用不变
  if (s.state.engine === "codex") {
    if (s.state.status !== "ERROR" && s.state.status !== "WORKING") return "codex-idle";
  } else {
    // #17 雇员按家读取任务存储
    const todos = readTaskStoreTodos(s.state.relay_session_id, mgr.employeeHome(s.state));
    if (!todos || !todos.some((t: { status: string }) => t.status === "pending" || t.status === "in_progress")) return "no-open-todos";
  }
  // 48h 新鲜度：残留的"pending 愿望"不是活工作
  if (Date.now() - s.state.updated_at > 48 * 3600_000) return "stale-48h";
  return null;
}

// ---------- W-ACTIVATOR 事件驱动复活统一入口（agent-activator.ts 调用面） ----------
// 与 liveness 门的关系：投递点（sendMessage/dispatch）的判死拉活已在收编语义里
//（resumePending 互斥=天然去重锁，本入口的 Eligible 链同款检查——两路不会双拉）；
// 本入口补「没人投递时死了也能拉回」：agent-activator 订阅 SESSION_ERROR /
// DISPATCH_DONE(failed) 触发。通知面两态（stableKey 幂等）：成功=info/失败=waiting
// attention 级（可操作跳会话卡）。
export function reviveManagedSession(mgr: any, id: string, source: string, reason: string): { ok: boolean; skipped?: string; error?: string } {
  const s = mgr.sessions.get(id);
  if (!s) return { ok: false, skipped: "not-found" };
  const why = reviveEligible(mgr, s);
  if (why) return { ok: false, skipped: why };
  const title = s.state.title || id.slice(0, 8);
  try {
    mgr.resumeAgent(s, `[Agent 激活器 · ${source}] ${reason}。检测到本会话仍有未完成任务，已自动恢复。` + reviveInstruction(s));
    mgr.upsertNotification("system", "activator-revive", id, {
      title: "会话已自动复活（激活器）",
      body: `${title}：${reason}——已自动恢复（来源：${source}）`,
      severity: "info", group: "attention", actionable: false, sessionId: id, domain: "session", returnPath: "/",
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    mgr.upsertNotification("system", "activator-fail", id, {
      title: "自动复活失败（需要手动处理）",
      body: `${title}：${reason}——自动恢复失败：${msg}（点会话卡片可手动恢复）`,
      severity: "waiting", group: "attention", actionable: true, sessionId: id, domain: "session", returnPath: "/",
    });
    return { ok: false, error: msg };
  }
}
