// [W-BOARDRECON]（t-7c780d9a，1104 用户实锤「工作中 5 沃克 vs 进行中 8 卡」第三现）：
// 看板三方对账器——claimed 卡 × owner_session 存活 × dispatch 台账定期对账。
//
// 边界与既有件的分工（防重复造轮）：
// - 终态翻卡（dispatch done→submitted/failed→backlog）已由 boardlife 交付边+boardfix
//   converge/recon 覆盖——本件不重做，只兜「翻面路径被 relay 重启打断」的漏网面
//  （台账终态而卡仍 claimed——reconAutoCloseStaleCards 已收 1h 窗后形态，本件零重）。
// - 本件真增量=**孤儿卡归位**：claimed 卡的 owner 会话已死/不在册/终态，或卡滞
//   claimed 超窗（缺省 4h）无任何进展——归位 backlog（可重派）+审计行落账。
// - **数字一致性告警**：真实工作中会话数 vs claimed 卡数——对不上即告警事件+通知
//  （不静默——用户一眼可判账实相符，第三现的「怎么还没根治」之问的直面答复）。
//
// 档位（任务书验收 2：首跑 observe）：CCR_BOARDRECON_MODE=observe（缺省——研判清单
// +审计+通知，不动板）/auto（翻面动作执行：孤儿→backlog）。两档对账与告警照常，
// 差别只在是否落 upsert。
import type { ProjectBoard } from "./projects.js";

export interface ReconSession {
  session_id: string;
  /** 终态会话（done_reason 在）视为不活跃 */
  done_reason?: string | null;
  status?: string;
}

export interface ReconDispatchRow {
  id?: string;
  status?: string;
}

export interface ReconAction {
  gid: string;
  entryId: string;
  text: string;
  /** orphan-session=owner 会话死/不在册；ledger-terminal=台账终态漏网；stale-no-progress=滞留超窗 */
  reason: "orphan-session" | "ledger-terminal" | "stale-no-progress";
  detail: string;
  toBacklog: boolean;
}

export interface ReconResult {
  actions: ReconAction[];
  /** 一致性：真实工作会话数 vs claimed 卡数 */
  workingSessions: number;
  claimedCards: number;
  /** 对不上时的差值描述（null=账实相符） */
  mismatch: string | null;
}

const STALE_MS_DEFAULT = 4 * 3600_000;

/** 纯函数对账（测试直测；boards=sessionsById 活组板）。 */
export function reconcileBoardCards(input: {
  boards: Array<{ gid: string; board: ProjectBoard }>;
  sessions: ReconSession[];
  dispatchLog: ReconDispatchRow[];
  now?: number;
  staleMs?: number;
}): ReconResult {
  const now = input.now ?? Date.now();
  const staleMs = input.staleMs ?? (Number(process.env.CCR_BOARDRECON_STALE_MS) || STALE_MS_DEFAULT);
  const live = new Map<string, ReconSession>();
  for (const s of input.sessions) {
    if (s.session_id && !s.done_reason) live.set(s.session_id, s);
  }
  const terminal = new Set<string>();
  for (const r of input.dispatchLog) {
    if (r.id && (r.status === "done" || r.status === "failed")) terminal.add(r.id);
  }
  const actions: ReconAction[] = [];
  let claimedCards = 0;
  let workingSessions = 0;
  for (const s of input.sessions) {
    if (s.session_id && !s.done_reason && (s.status === "WORKING" || s.status === "WAITING")) workingSessions++;
  }
  for (const { gid, board } of input.boards) {
    for (const e of board.entries) {
      if (e.status !== "claimed") continue;
      claimedCards++;
      const updated = Number(e.updated_at || e.ts || 0);
      const age = now - updated;
      // ①台账终态漏网（翻面路径被打断——boardfix converge 兜 backlog 态，claimed 态
      //   漏网在此收）：1h 缓冲窗（与 reconAutoCloseStaleCards 同口径，收口在途不算）
      if (e.dispatch_id && terminal.has(e.dispatch_id) && age > 3600_000) {
        actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "ledger-terminal", detail: `dispatch ${String(e.dispatch_id).slice(0, 8)} 已终态而卡仍 claimed（翻面被重启打断的漏网）`, toBacklog: true });
        continue;
      }
      // ②孤儿：owner 会话死/不在册/终态——卡无人执持，归位可重派
      if (e.owner_session && !live.has(e.owner_session)) {
        actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "orphan-session", detail: `owner ${String(e.owner_session).slice(0, 8)} 不在活跃册（死会话/终态/被 retire）`, toBacklog: true });
        continue;
      }
      // ③滞留超窗无进展（updated_at 任何泳道迁移/编辑都刷新——boardCardScan 注释口径）
      if (age > staleMs) {
        actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "stale-no-progress", detail: `claimed 滞留 ${Math.round(age / 3600_000)}h 无进展（阈值 ${Math.round(staleMs / 3600_000)}h）`, toBacklog: true });
      }
    }
  }
  let mismatch: string | null = null;
  if (claimedCards !== workingSessions) {
    mismatch = `工作中会话 ${workingSessions} ≠ 进行中卡 ${claimedCards}（差 ${claimedCards - workingSessions}——孤儿/漏网卡见对账清单）`;
  }
  return { actions, workingSessions, claimedCards, mismatch };
}
