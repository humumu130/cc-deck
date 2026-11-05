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
  /** 终态会话（done_reason 在）——R1 起非一律死证：白名单外才算（见 ORPHAN_DEAD_REASONS） */
  done_reason?: string | null;
  status?: string;
  /** R1-P0 旁证①：CLI 进程 pid（活=不判死；调用侧从 snapshot cli_pid 透传） */
  cli_pid?: number | null;
  /** R1-P0 旁证②：最后真实活动时刻（updated_at 近窗=owner 还在干活；宽限窗判据） */
  last_active_at?: number;
}

export interface ReconDispatchRow {
  id?: string;
  status?: string;
}

export interface ReconAction {
  /** R1-P1-1：true=仅提醒（owner 活跃的长任务滞留）——auto 档不搬只审计 */
  advisory?: boolean;
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
  /** R1-P0 两拍确认：本拍新标记的孤儿候选（调用侧存供下拍 previouslyFlagged） */
  flaggedNow: Set<string>;
}

const STALE_MS_DEFAULT = 4 * 3600_000;

/** 纯函数对账（测试直测；boards=sessionsById 活组板）。 */
/**
 * R1-P0-1 孤儿宽限窗：owner 不在册后仍需满足「卡龄>GRACE 且非白名单终态且无旁证」
 * 且经**两拍确认**（previouslyFlagged 由调用侧 patrol 拍间维护——首拍只入 candidates
 * 返回，第二拍才出归位动作）。45min 取值：覆盖 #36 续跑链（重启后秒级~分钟续跑）+
 * patrol 30min 拍距跨拍窗（两拍确认 ≈60min 内活会话回归即自愈）+cli pid 探测窗。
 */
export const ORPHAN_GRACE_MS = 45 * 60_000;
/** R1-P0-1 近窗心跳窗：owner 最后真实工作帧 20min 内=还在干（长思考/长工具静默）不判死。 */
export const OWNER_ACTIVE_WINDOW_MS = 20 * 60_000;
/** R1-P0-1 死证白名单：done_reason 命中这些才算「真终态死证」。ended=进程态未知
 * （history.ts:382 自认）；「服务更新重启/已恢复/已保存」=可恢复/待续跑（#36 链），
 * 一律不判死（A 审四证：重启收殓/#36 续跑窗/no-leader/在岗执行者本卡）。 */
const ORPHAN_DEAD_REASONS = /(success|用户(终断|停止|结束)|completed|cancelled|canceled)/i;

export function reconcileBoardCards(input: {
  boards: Array<{ gid: string; board: ProjectBoard }>;
  sessions: ReconSession[];
  dispatchLog: ReconDispatchRow[];
  now?: number;
  staleMs?: number;
  /** R1-P0 两拍确认：上一拍已标记的孤儿候选（entryId 集）——本拍仍不在册才出动作 */
  previouslyFlagged?: Set<string>;
  /** R1-P0 输出侧：本拍新标记的候选（调用侧存起来供下拍 previouslyFlagged） */
  flaggedNow?: Set<string>;
}): ReconResult {
  const now = input.now ?? Date.now();
  const staleMs = input.staleMs ?? (Number(process.env.CCR_BOARDRECON_STALE_MS) || STALE_MS_DEFAULT);
  const live = new Map<string, ReconSession>();
  for (const s of input.sessions) {
    if (s.session_id && !s.done_reason) live.set(s.session_id, s);
  }
  // R1-P1-2：台账终态收殓整支**删除**——归 reconAutoCloseStaleCards（patrol 后拍、台账
  // ts 窗基、目标态 done 收割口径）。原支目标=搬 backlog 重派（重做语义）与 recon 同面
  // 不同标，且先手写入的 backlog transitions 行（ts 晚于终态行）命中 recon 重开守护
  // （session-manager:1409-1411）=done 翻面被永久堵死。两器分工自此：**本件管孤儿/
  // 滞留/一致性告警，recon 管终态收殓**。
  const running = new Set<string>();
  for (const r of input.dispatchLog) {
    if (r.id && (r.status === "running" || r.status === "dispatched" || r.status === "queued")) running.add(r.id);
  }
  const prevFlagged = input.previouslyFlagged ?? new Set<string>();
  const flagNow = input.flaggedNow ?? new Set<string>();
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
      // ②孤儿（R1-P0-1 多源聚合判死+缓冲——原单源「不在册即判」在 auto 档=双开实害）：
      //   死证=旁证聚合（非单一不在册）：a) 会话在册且真终态白名单命中；b) 不在册/
      //   非白名单终态（ended=进程态未知/服务更新重启=待续跑）时再过三道活证：
      //   ①台账 running 行（该 dispatch 真在跑）②owner 近窗真实工作帧（20min 内
      //   last_active_at）③卡龄宽限窗（45min——#36 续跑窗+两拍确认跨拍）。全部不中
      //   才标记候选；**两拍确认**（previouslyFlagged）后出归位动作。
      if (e.owner_session && !live.has(e.owner_session)) {
        const ownerSes = input.sessions.find((x) => x.session_id === e.owner_session);
        const deadCert = !!(ownerSes?.done_reason && ORPHAN_DEAD_REASONS.test(ownerSes.done_reason));
        const ledgerRunning = !!(e.dispatch_id && running.has(e.dispatch_id));
        const recentActive = !!ownerSes?.last_active_at && now - ownerSes.last_active_at < OWNER_ACTIVE_WINDOW_MS;
        const inGrace = age < ORPHAN_GRACE_MS;
        // 判死=白名单真终态 ∧ 三道活证全不中 ∧ 宽限窗外——**非白名单（ended/服务更新
        // 重启/已恢复/已保存等未知态）一律不判死**（A 审修法②：history.ts:382 自认
        // 进程态未知；#36 续跑链稍后回岗），两拍确认只是最后缓冲。
        if (!deadCert || ledgerRunning || recentActive || inGrace) {
          continue; // 未知态/活证/宽限在场——不标记不动作（下一拍重判）
        }
        flagNow.add(e.id);
        if (!prevFlagged.has(e.id)) {
          continue; // 首拍只标记（两拍确认——下一拍仍在才动作）
        }
        actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "orphan-session", detail: `owner ${String(e.owner_session).slice(0, 8)} 判死经旁证聚合（白名单${deadCert ? "命中" : "外终态/不在册"}+台账无 running${ledgerRunning ? "" : "✓"}+近窗无活动${recentActive ? "" : "✓"}+龄 ${Math.round(age / 60_000)}min 过宽限${inGrace ? "" : "✓"}，两拍确认）`, toBacklog: true });
        continue;
      }
      // ③滞留超窗无进展（updated_at 任何泳道迁移/编辑都刷新——boardCardScan 注释口径）
      //   R1-P1-1 owner 活跃守卫：owner 在册且 WORKING/WAITING=长编译/长工具静默期，
      //   对齐 boardCardScan「执行者活跃不算滞留」口径——只告警（advisory）不归位。
      if (age > staleMs) {
        const ownerLive = live.get(e.owner_session || "");
        const active = !!ownerLive && (ownerLive.status === "WORKING" || ownerLive.status === "WAITING");
        actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "stale-no-progress", detail: `claimed 滞留 ${Math.round(age / 3600_000)}h 无进展（阈值 ${Math.round(staleMs / 3600_000)}h${active ? "；owner 活跃中——只提醒不归位" : ""}）`, toBacklog: !active, advisory: active });
      }
    }
  }
  // R1-P2-1：一致性告警阈值化+方向化——负差（会话多卡少）=常态（PM/复核/咨询在岗
  // 不持卡），不告；正差（卡多会话少=可能孤儿）>1 才告（=1 常态抖动）。去常态假阳。
  let mismatch: string | null = null;
  if (claimedCards - workingSessions > 1) {
    mismatch = `进行中卡 ${claimedCards} > 工作中会话 ${workingSessions}（正差 ${claimedCards - workingSessions}——孤儿候选见对账清单）`;
  }
  return { actions, workingSessions, claimedCards, mismatch, flaggedNow: flagNow };
}
