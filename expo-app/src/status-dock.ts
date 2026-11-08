// W-DOCKIDLE（1108 用户实锤）：输入区活动舱纯投影模块——「显隐走 closingBarOf 类
// 纯函数」架构口径的落位（此前三函数寄居 DetailScreen.tsx 巨组件内，无法被 node
// 直跑测试 import——notify-jump.ts 先例：纯逻辑独立成档，测试行为断言直连）。
// 零 RN 依赖（仅 protocol 类型+能力判定），DetailScreen re-export 保持兼容。
import { hasActivityCapability, type SessionState, type SessionStatus } from "./protocol";

/** done/error 收口条：ERROR ⚠ 常驻（对齐既有状态条语义）；DONE ✓ 只在回合收尾
 * 尾窗内显示（activity.state=DONE 落定后 DONE_TAIL_MS 内）——DONE 是会话静息态，
 * 常驻收口条会给每个历史会话都糊一条；尾窗即「本轮刚收口」语义，过窗自隐 */
export const DONE_TAIL_MS = 8000;
export type ClosingBar = { kind: "done" | "error"; text: string };
export function closingBarOf(s: SessionState | null | undefined, now: number): ClosingBar | null {
  if (!s) return null;
  if (s.status === "ERROR") return { kind: "error", text: s.last_error || "出错了" };
  if (s.status === "DONE" && s.activity?.state === "DONE" && typeof s.activity.updated_at === "number") {
    const age = now - s.activity.updated_at;
    if (age >= 0 && age <= DONE_TAIL_MS) return { kind: "done", text: "本轮已完成" };
  }
  return null;
}

// 四态图标：与色双通道区分（✶ ◉ ✓ ⚠ + working/waiting/done/error 四主题色），不引新依赖
const DOCK_ICONS: Record<string, string> = { WORKING: "✶", WAITING: "◉", DONE: "✓", ERROR: "⚠" };

export interface DockModel {
  state: SessionStatus;
  icon: string;
  summary?: string;   // 任务摘要（task_summary.text）
  actKind?: string;   // 当前活动 kind
  actText?: string;
  actTool?: string;
  elapsedMs?: number;
}

/**
 * 头部活动舱投影（B0 StatusDockState 只读消费）：
 * - activity 缺失 → null（整舱不渲染，无假「空闲」）
 * - native_status 能力关 → null（核心能力不在整舱不渲染；legacy 归一化能力全关同此）
 * - 任务摘要/当前活动按 operation_summary、耗时按 native_elapsed 各自门控，字段
 *   缺省不出行（不出假 0 / 假空串）
 * - approval 不入舱：审批由横幅/状态条承载，舱内不出第四行假占位
 * - W-DOCKIDLE：**终态（DONE/ERROR）不入舱**——activity 在会话终态被 relay
 *   applyActivity 整体冻结（保留收口前最后状态供快照，收口前最后帧常为 WORKING），
 *   终态会话的舱投影若放行会把冻结残影（绿点+陈文本+走秒）整条常驻在输入区上沿
 *   ——1108 用户实锤「空闲的时候一直显示一个绿色的什么什么」。终态收口由
 *   StatusStrip 承载（ERROR 常驻/DONE 8s 尾窗），舱内只放行 WORKING/WAITING 两活态。
 */
export function dockModelOf(s: SessionState | null | undefined): DockModel | null {
  const act = s?.activity;
  if (!act || !s) return null;
  if (!hasActivityCapability(s, "native_status")) return null;
  if (act.state !== "WORKING" && act.state !== "WAITING") return null;
  const m: DockModel = { state: act.state, icon: DOCK_ICONS[act.state] ?? "·" };
  if (hasActivityCapability(s, "operation_summary")) {
    const ts = act.task_summary;
    const text = typeof ts?.text === "string" ? ts.text.trim() : "";
    if (text) m.summary = text;
    const a = act.activity;
    if (a && typeof a.text === "string" && a.text.trim()) {
      m.actText = a.text.trim();
      if (typeof a.kind === "string" && a.kind) m.actKind = a.kind;
      if (typeof a.tool === "string" && a.tool) m.actTool = a.tool;
    }
  }
  if (hasActivityCapability(s, "native_elapsed") && typeof act.elapsed_ms === "number") m.elapsedMs = act.elapsed_ms;
  return m;
}

/** W-DOCKIDLE：输入区活动舱行渲染闸（纯投影，closingBarOf 同族）。锚**会话级真相**
 * （s.status）而非 activity 投影：仅 WAITING 会话显示——WORKING 由 dockWork 黄行
 * （执行摘要+走秒+停止钮）承载；DONE/ERROR 会话无论 activity 冻结滞留成什么残影
 * （relay applyActivity 终态不覆写，收口前最后帧常为 WORKING）都不渲染——空闲留白
 * （对齐团队 Tab A3「空闲留白」已定案语言），终态收口走 StatusStrip。对齐桌面端
 * #dockActivityRow 口径（空闲收起，仅收口条 8s）。
 * 注：本闸是第二道防线——dockModelOf 已滤终态投影；本闸再锚会话真相，专治
 * 「activity 冻结残影是活态形状（WORKING）而会话已空闲」的错位形态（1108 实锤形态）。 */
export function dockLineVisible(dock: DockModel | null | undefined, status: SessionStatus | undefined): boolean {
  return !!dock && status === "WAITING";
}
