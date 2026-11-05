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
import { autoTierOf, recordWouldDo, observeBucket } from "../auto-tiers.js"; // observe3：revive 族三档挂档点（边界声明见 auto-tiers.ts——#PMRESUME/#36 状态恢复不入族）

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
  if (process.env.CCR_NO_AUTOREVIVE === "1") return 0; // 逃生阀恒最高（先于档位）
  const reviveTier = autoTierOf("revive"); // observe3：off=不研判直接停（与逃生阀同义叠加）
  if (reviveTier === "off") return 0;
  const candidates: { s: any; updated: number }[] = [];
  // #275R 陈年待办需确认面：reviveEligible 拦下的 stale-todos 不静默——boot 聚合出
  // 一条可操作通知（用户点头=去会话卡手动恢复），既不自动拉也不无声丢
  const staleTodoSkipped: string[] = [];
  for (const s of mgr.sessions.values()) {
    const why = reviveEligible(mgr, s);
    if (why === "stale-todos") {
      staleTodoSkipped.push(s.state.title || s.state.session_id.slice(0, 8));
      continue;
    }
    if (why) continue;
    candidates.push({ s, updated: s.state.updated_at });
  }
  candidates.sort((a, b) => b.updated - a.updated);
  // observe3 R1（B 审 1.3 P2）：#275R 陈年待办聚合通知前置到档位分支之前——stale-todos
  // 是「需人决策」面（点行跳会话卡手动恢复），observe 档不得双盲（原 observe return 0
  // 先于此块=观察档下陈年待办既无通知也无 observe 记录）。auto/observe 两档共用。
  if (staleTodoSkipped.length > 0) {
    try {
      // revision 用天级时间桶（审查 A/B-P1 同报）：静态键会让通知冻结在首 Fire 的
      // 名单且用户 dismiss 后永不再现——按天分桶既刷新内容又不至于每次 boot 刷屏
      mgr.upsertNotification("system", "revive-stale-todos", String(Math.floor(Date.now() / 86_400_000)), {
        title: "陈年待办未自动恢复（需确认）",
        body: truncate(`点本行跳会话列表找会话卡手动恢复。${staleTodoSkipped.slice(0, 3).join("、")}${staleTodoSkipped.length > 3 ? ` 等 ${staleTodoSkipped.length} 个` : ""}——待办超过 ${todoStaleDays()} 天未动，已跳过自动拉起`, 160),
        severity: "waiting", group: "attention", actionable: true, domain: "session", returnPath: "sessions",
      });
    } catch { /* 通知面尽力而为 */ }
  }
  // observe3（revive 族 observe 档干跑）：候选研判照常（reviveEligible 全链照跑，含
  // stale-todos 拦截聚合），resume 动作不执行——逐候选记 observe 账本+聚合通知账一行式
  //（day-bucket 防刷屏，revive-stale-todos 先例同款）。
  if (reviveTier === "observe") {
    const picked = candidates.slice(0, limit);
    for (const c of picked) recordWouldDo(mgr.cfg.dataDir, "revive", "auto-revive", "resume", `${c.s.state.title || c.s.state.session_id.slice(0, 8)}（有未完成待办）`);
    if (picked.length > 0) {
      console.log(`[auto-revive][observe] 将拉起 ${picked.length} 个有未完成待办的托管会话（干跑未执行）`);
      try {
        mgr.upsertNotification("system", "observe-revive", observeBucket(), {
          title: "[observe] 自动拉活干跑：将拉起 " + picked.length + " 个会话",
          body: `revive 档=observe（研判通过不执行）。将拉起：${picked.slice(0, 3).map((c) => c.s.state.title || c.s.state.session_id.slice(0, 8)).join("、")}${picked.length > 3 ? " 等" : ""}——转 auto 档才会执行`,
          severity: "waiting", group: "attention", actionable: false, domain: "session", returnPath: "sessions",
        });
      } catch { /* 通知账不可用时 observe-log 已在案 */ }
    }
    return 0;
  }
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

// ---------- #PMRESUME（用户 1102 晚实锤×3「手动拉回」）：PM 席位重启自愈专用通道 ----------
// 闸实锤（哪道闸吃的 PM）：**pinned-dormant**（reviveEligible 的 W-LEADFIX 闸——
// 「用户拍板开机不自动 resume」当年面向普通置顶会话；而 PM 首建即 pin（pinLeaderFile）
// + 重启 ensureLeader→adoptExistingLeader 无条件置 saved+DONE「已保存（Leader 休眠）」
// ⇒ WORKING 中断的 PM 虽被 #36 打标选中，恰撞 pinned&&saved 被拦=静默停摆）。
// 第二断点：PM 空闲（无标）态重启——#36 只收 WORKING，adoptExistingLeader 明确
// 「不 spawn」，keepalive 是 onSessionEnd 调度（relay 死=事件不达）⇒ 无人拉起。
// 修法（用户 1102 新令，口径变更备案）：PM 席位=常驻值守位（#287 常驻化语义）——
// ①WORKING 中断：席位豁免 pinned-dormant（仅此一道；retired/互斥窗/冷却三安全闸
//   全数尊重），resumeAgent 续跑（#36 同款文案链）；②空闲态：reviveSaved 温床拉起
//   待命（keepalive 同语义，受 duty 门 CCR_PM_DUTY=0/CCR_NO_LEADER=1 管——紧急关
//   停不拉闲）；两态都清 pre_reboot_status 防 #36 双拉。普通会话零波及：本通道只认
// leaderId，reviveEligible 共享闸不动（autoRevive/激活器/看门狗语义原样）。
export function resumeLeaderAfterReboot(mgr: any): number {
  if (process.env.CCR_RESUME_ON_REBOOT === "0") return 0; // 逃生阀（#36 同款）
  if (process.env.CCR_NO_AUTOREVIVE === "1") return 0; // 沙盒/测试铁闸
  const id = mgr.leaderId;
  if (!id) return 0;
  const s = mgr.sessions.get(id);
  if (!s) return 0;
  if (s.state.external) { console.log("[pm-resume] Leader 为外部会话（no-leader 模式用户终端管辖）——relay 无句柄不拉，归用户终端"); return 0; }
  if (s.agent) return 0; // 已在岗（boot 竞态窗，理论不可达）
  if (!s.state.relay_session_id) { console.log("[pm-resume] Leader 无 SDK 锚（首回合未完成即中断）——不硬拉，等首条消息/duty"); return 0; }
  // 三安全闸全数尊重（席位豁免只豁 pinned-dormant 一道）
  if (mgr.isRetiredMember && mgr.isRetiredMember(id)) { console.log("[pm-resume] Leader 已退休（编制除名）——不拉"); return 0; }
  if (s.resumePending && Date.now() - s.resumePending < resumePendingWindowMs()) { console.log("[pm-resume] resume 互斥窗内——本轮不拉（防双进程）"); return 0; }
  if (s.resumeCooldownUntil && Date.now() < s.resumeCooldownUntil) { console.log("[pm-resume] resume 熔断冷却中——本轮不拉（防死循环）"); return 0; }
  const wasWorking = s.state.pre_reboot_status === "WORKING";
  s.state.pre_reboot_status = undefined; // 清标防 #36 通道双拉（席位通道先跑）
  try {
    if (wasWorking) {
      // 中断续跑：与 #36 同语义（活工作中断=必须自动恢复，不受 duty 门）
      mgr.resumeAgent(s, "[relay 重启自愈 · 值守席位] relay 重启完成，PM 值守回合被中断，已自动续跑（#PMRESUME——不再需要人工发消息拉回）。" + reviveInstruction(s));
    } else {
      // 空闲温床拉起待命：keepalive 同语义（duty 门管——紧急关停=0 不拉闲）
      if (process.env.CCR_PM_DUTY === "0" || process.env.CCR_NO_LEADER === "1") return 0;
      mgr.reviveSaved(s);
    }
    try {
      mgr.upsertNotification("system", "pm-resume", `r${Date.now()}`, { // revision 唯一化：同 entityId+同 revision 视陈版跳更（A/B 两态通知实证）
        title: wasWorking ? "值守 PM 已自动续跑" : "值守 PM 已拉起待命",
        body: `${s.state.title || id.slice(0, 8)}：relay 重启后席位自愈（${wasWorking ? "中断回合自动续跑" : "温床待命——下条消息零冷启动"}，#PMRESUME）`,
        severity: "info", group: "activity", actionable: false, sessionId: id, domain: "session", returnPath: "sessions",
      });
    } catch { /* 通知面尽力而为 */ }
    console.log(`[pm-resume] 值守席位自愈：${wasWorking ? "中断续跑" : "温床待命"} sid=${id.slice(0, 8)}`);
    return 1;
  } catch (e) {
    console.log(`[pm-resume] Leader 拉起失败: ${e instanceof Error ? e.message : String(e)}（熔断账接管；人工发送消息可恢复）`);
    return 0;
  }
}

// ---------- #36 重启自愈（用户 1101 实锤）：中断前 WORKING 的托管会话 boot 自动续跑 ----------
// 与 autoReviveManaged（#75 待办驱动）互补：待办闸会把「回合在跑但任务清单无开放项」
// 的中断会话（长构建/纯执行回合）漏成「发送消息即可继续」人工干等——本通道以
// history.ts 打的 pre_reboot_status 状态信号选人（对齐 W-CDXREV codex 面的「WORKING=
// 回放僵尸=活工作」语义），复用 reviveEligible 全闸（retired/互斥/冷却/pinned/48h
// 新鲜度等）仅放行待办两判（no-open-todos/stale-todos——中断前在跑本身即活工作凭据）。
// 约束：单次上限 3（与 autoRevive 同档，按 updated_at 近者先）；消费即清标（防
// boot 后续轮次重放）；CCR_RESUME_ON_REBOOT=0 逃生阀（紧急关停）+ CCR_NO_AUTOREVIVE=1
// 沙盒铁闸（测试隔离，与 autoRevive 同源）。失败不重试（resumeAgent 熔断账自然接管）。
export function resumeInterruptedByReboot(mgr: any, limit = 3): number {
  if (process.env.CCR_RESUME_ON_REBOOT === "0") return 0; // #36 逃生阀
  if (process.env.CCR_NO_AUTOREVIVE === "1") return 0; // 沙盒/测试铁闸（autoRevive 同款）
  const candidates: { s: any; updated: number }[] = [];
  for (const s of mgr.sessions.values()) {
    if (s.state.pre_reboot_status !== "WORKING") continue; // 只有 history 分类打过标的中断会话
    const why = reviveEligible(mgr, s);
    // 放行待办两判（本通道的存在理由）；其余闸全数尊重（retired/互斥窗/冷却/pinned/
    // 外部/无锚/48h 陈——中断凭据不豁免编制与新鲜度纪律）
    if (why && why !== "no-open-todos" && why !== "stale-todos") continue;
    candidates.push({ s, updated: s.state.updated_at });
  }
  candidates.sort((a, b) => b.updated - a.updated);
  let resumed = 0;
  for (const c of candidates) {
    if (resumed >= limit) break;
    const s = c.s;
    s.state.pre_reboot_status = undefined; // 消费即清（本轮失败也不重试——熔断账接管）
    try {
      mgr.resumeAgent(s, "[relay 重启自愈] relay 重启完成，检测到本会话重启前有进行中的任务，已自动续跑。" + reviveInstruction(s));
      resumed++;
      try {
        mgr.upsertNotification("system", "reboot-resume", s.state.session_id, {
          title: "中断会话已自动续跑",
          body: `${s.state.title || s.state.session_id.slice(0, 8)}：重启前在跑的回合已自动恢复（#36 重启自愈）`,
          severity: "info", group: "activity", actionable: false, sessionId: s.state.session_id, domain: "session", returnPath: "sessions",
        });
      } catch { /* 通知面尽力而为 */ }
    } catch (e) {
      console.log(`[reboot-resume] ${s.state.session_id.slice(0, 8)} 续跑失败: ${e instanceof Error ? e.message : String(e)}（人工发送消息可恢复）`);
    }
  }
  if (resumed > 0) console.log(`[reboot-resume] 重启自愈：${resumed} 个中断 WORKING 会话已自动续跑（#36）`);
  return resumed;
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
// #275R 陈年待办闸阈值（天）：待办文件 mtime（readTaskStoreTodos 的 updated_at 来源）
// 距今超过该值 = 陈年愿望非活工作。CCR_REVIVE_TODO_STALE_DAYS 缺省 3，显式 "0"=关闸；
// 空串（launchd/compose 设而空）落缺省不静默关闸（审查 P3：与 CCR_ENGINE_STALE_MS
// 「空/非正→缺省」惯例对齐，防误关）
export function todoStaleDays(): number {
  const raw = process.env.CCR_REVIVE_TODO_STALE_DAYS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export function reviveEligible(mgr: any, s: any): string | null {
  if (s.state.external) return "external";
  // W-RATELIMIT429：API 限流退避中不自动拉起/不喂活（429 下 revive/resume 重试风暴
  // 放大器——今晚实锤并发 ~10 会话 429 卡死等人工捞×2）。**先于 agent-alive**：429
  // 退避的会话 agent 常还活着（回合报错≠进程死），活会话的注入/喂活族同受此闸；
  // 到点 onTurnEnd 退避定时器自清后恢复资格
  if (s.rateLimitBackoffUntil && Date.now() < s.rateLimitBackoffUntil) return "rate-limit-backoff";
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
    // #275R 空会话闸（1027 实锤 Codex 尸体复活）：ERROR 且从未产出（token 用量零——
    // 产出权威在 state.usage.output_tokens，session-manager「有产出」判定同字段；文件
    // 面 stats.files_changed 作次级双保险）= 尸体，不自动拉。真在干活被腰斩的 WORKING/
    // 有产出的 ERROR 照拉（W-CDXREV 1013 语义对「有产出死流」不变，闸只收窄空尸体
    // 子集）。残余风险（审查 B-P3-2）：relay 在 usage 帧落盘前崩溃→回放后误判尸体
    // 少拉一次，手动恢复不受影响——接受
    if (s.state.status === "ERROR") {
      const produced = (s.state.usage?.output_tokens ?? 0) > 0 || (s.state.stats?.files_changed ?? 0) > 0;
      if (!produced) return "codex-empty";
    }
  } else {
    // 48h 会话闸前置（审查 A-P3-3 归因顺序）：>48h 的会话本就不会被拉，先归因
    // stale-48h——不进陈年待办通知名单（防古老会话挤占显示位淹没真目标带）
    if (Date.now() - s.state.updated_at > 48 * 3600_000) return "stale-48h";
    // #17 雇员按家读取任务存储
    const todos = readTaskStoreTodos(s.state.relay_session_id, mgr.employeeHome(s.state));
    if (!todos || !todos.some((t: { status: string }) => t.status === "pending" || t.status === "in_progress")) return "no-open-todos";
    // #275R 陈年待办闸（1027 实锤傲修图旧会话被拉起自主改任务）：会话 48h 内被摸过
    // 不代表待办是活的——**最新一条**开放待办也超过 N 天未动 = 全部陈年，不自动拉
    //（boot 入口的「需确认」通知在 autoReviveManaged 聚合）
    const days = todoStaleDays();
    if (days > 0) {
      const openTodos = todos.filter((t: { status: string }) => t.status === "pending" || t.status === "in_progress");
      const newestOpenAt = Math.max(0, ...openTodos.map((t: { updated_at?: number }) => t.updated_at ?? 0));
      if (newestOpenAt > 0 && Date.now() - newestOpenAt > days * 86_400_000) return "stale-todos";
    }
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

// ---------- #287 PM 常驻化：dutyTarget 托管会话空闲保活判定（纯函数，测试直吃） ----------
// 语义：PM 唯一常驻（1027 用户裁定「PM 空闲有必要挂起退出吗？又不会有很多个 PM」）。
// 托管 SDK 会话=回合制进程（回合完 CLI 退出→saved 驻档→下一条消息 resumeAgent 冷启动
// 「已恢复 SDK 会话」）。保活=空闲自然关闭后延时无消息拉起（reviveSaved 复用：拉起后
// CLI 停在等待输入=温床，下一条消息 sendMessage 直达零冷启动；无积压落 DONE 待命态
// =#26 待命化同语义）。判定纯函数化：schedule 与 fire 双查同源，防调度窗竞态（换届/
// 删除/熔断/互斥全在火时现算）。
export const PM_KEEPALIVE_DELAY_MS = 3_000;
export const PM_KEEPALIVE_MAX_IDLE_STREAK = 2;

export interface PmKeepaliveParams {
  envOff?: string | undefined;   // process.env.CCR_PM_KEEPALIVE（"0"=逃生阀：测试/紧急关停）
  reason: string;                // onSessionEnd 收口原因（"stream closed"=自然空闲退出；stopped/其他不保活）
  external: boolean;             // 托管面（外部会话终端自管不保活）
  historical: boolean;           // 弃档态不保活
  isDutyTarget: boolean;         // 当前值守 PM（dutyTargetId；schedule/fire 双查=换届后旧 PM 自然衰减）
  resumePending?: number;        // #189 换流互斥窗内不拉
  resumeCooldownUntil?: number;  // W-LEADFIX 熔断冷却期不拉
  now: number;
  idleStreak: number;            // 连续「拉起后无任何回合活动即退出」计数（防死循环闸）
  /** R1（A-P1-2）：429 退避到期时刻（退避窗内不拉——防拉起即再吃 429） */
  rateLimitBackoffUntil?: number;
}

export function pmKeepaliveEligible(p: PmKeepaliveParams): boolean {
  if (p.envOff === "0") return false;
  if (p.reason !== "stream closed") return false;
  if (p.external || p.historical) return false;
  if (!p.isDutyTarget) return false;
  if (p.resumePending) return false;
  if (p.resumeCooldownUntil && p.resumeCooldownUntil > p.now) return false;
  // R1（A-P1-2）：退避窗内不拉——429 打断流形态（stream closed）恰是 keepalive 目标
  // 形态，原判据无退避=风暴窗内 duty 会话被反复拉起再吃 429。
  if (p.rateLimitBackoffUntil && p.rateLimitBackoffUntil > p.now) return false;
  if (p.idleStreak >= PM_KEEPALIVE_MAX_IDLE_STREAK) return false; // 拉起即退死循环闸：连续无活动退出≥2 停拉，等真实消息/回合复位（onTurnEnd 清零）
  return true;
}
