// [W-SMIMPL ③] 会话状态转移断言层（W-SMDESIGN 候选 3 第一步，2026-10-25 Leader 拍板）
// 纯观测：session-manager 25 处 status 直写全部收口到 transition() 单点（行为零变化），
// 本文件只承载「转移合法性表」——非法转移 warn+audit 记账（NOTIFY_CHAIN_AUDIT +
// chain-audit.jsonl 镜像），**不阻断不改写**（收尸数据攒两周后按账收紧，第二步收编
// 挂 backlog，W-SMDESIGN §③ 候选 3 两步走拍板口径）。
//
// 表 v1（观测初版）：唯一硬规则 = DONE→WORKING 翻活只认 spawn 系入口——三个已知翻活
// 点（resumeAgent 流开 3364/dispatchWorker 6561/reviveSaved 3498）全是 spawn 系，
// 表外组合=非 spawn 入口翻活（W-SMDESIGN 伤口 A「done 态 + 非 spawn 入口翻活」点名面，
// sm:3364 注释自认「旧终态翻活防卡面停旧态」——翻写合法性此前靠调用点自觉）。
// 其余组合 v1 全放行：先零误报铺网，账面数据决定 v2 收紧面。

import type { SessionStatus } from "../types.js"; // 权威四值定义（types.ts 单源，此处只做表）
export type { SessionStatus };

/** 写点语义类别（by 标签前缀）：spawn=拉活/翻活系（新流/派单/审批/外部事件）；
 *  finalize=收口系（回合终态/流关/超时/删除/退休/看门狗收口）。 */
export type TransitionClass = "spawn" | "finalize";

/** by 标签 → 类别（前缀表驱动；表外标签按标签内容猜——详见 classOfBy 兜底） */
const BY_CLASS: Record<string, TransitionClass> = {
  // spawn 系
  "ext-waiting": "spawn", // setExternalWaiting：外部会话远程等待
  "wd-selfheal": "spawn", // 看门狗 gaveUp 自愈复位
  "tool-wait": "spawn", // 工具审批等待
  "tool-resolve": "spawn", // 审批决定回 WORKING
  resume: "spawn", // resumeAgent 换流（含流开翻活 3364）
  revive: "spawn", // reviveSaved 拉活
  dispatch: "spawn", // dispatchWorker 派单承接
  "wait-resolve": "spawn", // emitWaitingResolved 审批收尾
  // finalize 系
  "ext-finish": "finalize", // finishExternal 外部回合收口
  "stream-idle": "finalize", // idle 流假翻 DONE 收口
  "turn-end": "finalize", // onTurnEnd 回合终态 DONE/ERROR
  "stream-close": "finalize", // 流关闭兜底收口
  "stream-error": "finalize", // 流错误
  "revive-fail": "finalize", // revive 失败
  "boot-dim": "finalize", // applyPinned 启动休眠登记
  "boot-timeout": "finalize", // adoptExistingLeader 首建超时
  retire: "finalize", // retireSession 退休
  "wd-stall": "finalize", // recoverFromStall 僵尸判弃钉死
  "wd-fail": "finalize", // recoverFromStall 恢复失败
};

export function classOfBy(by: string): TransitionClass {
  return BY_CLASS[by] ?? (by.startsWith("spawn:") ? "spawn" : "finalize");
}

/** 转移合法性（v1 观测表）：唯一硬规则 DONE→WORKING 仅 spawn 系；其余全放行。
 *  返回 false = 非法观察（warn+audit，不阻断）。纯函数可直测。 */
export function transitionLegal(cur: SessionStatus, next: SessionStatus, by: string): boolean {
  if (cur === "DONE" && next === "WORKING" && classOfBy(by) !== "spawn") return false;
  return true;
}
