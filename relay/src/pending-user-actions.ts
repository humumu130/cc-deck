// [W-AWAITUSER] 待拍板全局可见性（1104 用户令）：「等我拍板的」三源聚合单点。
//
// 背景（用户原话）：「这种等我拍板的，能不能也在会话列表上以及其他地方的给出提示，
// 有时候我会没注意，导致阻塞很久」——实锤：1104 AskUserQuestion 四问窗口超时（用户
// 后补答已失效，工作被缺省阻塞）；多轮确认卡滞留无人看。三源各自存在、无聚合可见面，
// 用户 miss 任何一面 = 阻塞无人知。
//
// 【同类绝迹·注释锚】新增「待用户决策」源必须挂进本聚合清单——旁路接入（只在自家
// 面渲染、不走 pendingUserActionsOf）= 用户在其他面看不见 = 本件要根治的形态复发。
// 现役三源（登记处，加源改这里 + 挂发射点）：
//   ① org-confirms pending（projects.listPendingConfirms）
//   ② waiting 态会话（SessionManager 快照 status==="WAITING" && waiting_request；
//      含 AskUserQuestion（questions）与 decidable=false 仅通知形态——1104 案例正是
//      AskUserQuestion，permission 问询与四问同属「等你拍板」，不漏）
//   ③ 未回填验收单（acceptance.listAcceptances 的 !submitted，#195 生命周期语义）
// 静态锁：test-awaituser.ts D 族断言两处快照组装（ws-server/cloud-client）都经
// pendingUserActionsList() 单口构建 + 发射挂点在册——防第四源旁路、防双壳漏键。
//
// 单源权威纪律：聚合只在 relay 侧算一次，随 SNAPSHOT 全量 + 增量帧下发；端上消费
// 键（pending_user_actions），不从三源各自拼（旧端缺键=能力位降级，见消费面注释）。
import type { OrgConfirm } from "./projects.js";
import type { AcceptanceSummary } from "./acceptance.js";
import type { SessionState } from "./types.js";
import { stableKey } from "./decision-notify.js";

export type PendingUserActionKind = "org-confirm" | "waiting" | "acceptance";

export interface PendingUserAction {
  key: string; // 稳定键（通知账 stableKey 同口径；waiting 含 request_id 防同会话换请求误同键）
  kind: PendingUserActionKind;
  entity_id: string; // confirm id / session_id / acceptance id（端上跳转面定位用）
  title: string;
  // 滞留起点（毫秒，归一后）。confirm/acceptance 的 created_at 是秒级（bin/acceptance
  // 契约，W-NQA F6 同族）——<1e11 视作秒 ×1000，端上不再各自 normTs（单源归一一次）
  created_at: number;
  session_id?: string; // waiting 源携带（跳会话面）
}

/** 秒级时戳归一（W-WINPAIR-R8② 口径，notify.js normTs 的 relay 侧单点化） */
export function normMs(v: number): number {
  const n = Number(v) || 0;
  return n > 0 && n < 1e11 ? n * 1000 : n;
}

/** 会话是否在等用户（waiting 判定单点——含 AskUserQuestion/仅通知形态，见文件头②） */
export function sessionAwaitingUser(s: SessionState): boolean {
  return s.status === "WAITING" && !!s.waiting_request;
}

function waitingTitle(s: SessionState): string {
  const w = s.waiting_request;
  if (!w) return "会话等待输入";
  if (w.questions?.length) return `等你作答 · ${w.questions[0]?.question || w.tool_name || "提问"}`;
  return `等待批准 ${w.tool_name || "操作"}`;
}

function truncate(text: string, max: number): string {
  const oneLine = String(text ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * 三源聚合纯函数（快照与增量帧共用；确定性：同输入同输出，按 created_at 降序、
 * 同 ts 按 key 字典序稳定排序——投影 dedup 与端上渲染签名依赖此性质）。
 * 输入约定：confirms 已滤 pending、acceptances 为 listAcceptances 原样（内部滤
 * !submitted）——过滤语义收在本函数（调用方不各自预滤，防口径漂移）。
 */
export function pendingUserActionsOf(sources: {
  confirms: OrgConfirm[];
  sessions: SessionState[];
  acceptances: AcceptanceSummary[];
}): PendingUserAction[] {
  const out: PendingUserAction[] = [];
  for (const c of sources.confirms) {
    if (c.status !== "pending") continue;
    out.push({
      key: stableKey("org-confirm", c.id, String(c.created_at)),
      kind: "org-confirm",
      entity_id: c.id,
      title: truncate(c.title, 80) || "组织确认单",
      created_at: normMs(c.created_at),
    });
  }
  for (const s of sources.sessions) {
    if (!sessionAwaitingUser(s)) continue;
    const req = s.waiting_request!;
    out.push({
      key: stableKey("waiting", s.session_id, req.request_id),
      kind: "waiting",
      entity_id: s.session_id,
      title: truncate(waitingTitle(s), 80),
      created_at: normMs(s.waiting_started_at ?? s.updated_at),
      session_id: s.session_id,
    });
  }
  for (const a of sources.acceptances) {
    if (a.submitted) continue; // #195：提交过即已处理（待填消失条件）
    out.push({
      key: stableKey("acceptance", a.id),
      kind: "acceptance",
      entity_id: a.id,
      title: truncate(a.title, 80) || "验收单",
      created_at: normMs(a.created_at),
    });
  }
  return out.sort((a, b) => b.created_at - a.created_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
