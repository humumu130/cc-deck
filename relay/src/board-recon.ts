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
  /** W-BOARDRECON-R3：台账 title（收割证据①——done 行 receipt 非空配对） */
  title?: string;
  receipt?: string;
}

export interface ReconAction {
  /** R1-P1-1：true=仅提醒（owner 活跃的长任务滞留）——auto 档不搬只审计 */
  advisory?: boolean;
  gid: string;
  entryId: string;
  text: string;
  /** orphan-session=owner 会话死/不在册；ledger-terminal=台账终态漏网；stale-no-progress=滞留超窗；
   * R3：harvested-unflipped=submitted 陈化+收割证据已存在（auto 翻 done）；duplicate-card=同文本双卡 */
  reason: "orphan-session" | "ledger-terminal" | "stale-no-progress" | "harvested-unflipped" | "duplicate-card";
  detail: string;
  toBacklog: boolean;
  /** R3：true=翻 done（已收割未翻——与 toBacklog 互斥面） */
  toDone?: boolean;
}

/** R3 收割证据三源（调用侧构建，纯函数只判——保持零 IO 可测）：
 * - doneLedger：台账 done 行按 slug 锚聚合 {count, hasReceipt}——证据①（status=done+receipt 非空）
 * - devLogText：git log --oneline 全文（一次子进程取回缓存）——证据②（slug 命中 dev 提交）
 * - receiptSlugs：artifacts/w-*.md 尾行合规（「结果：…｜改动文件：…」）的 slug 集——证据③ */
export interface HarvestEvidence {
  doneLedger: Map<string, { count: number; hasReceipt: boolean }>;
  devLogText: string;
  receiptSlugs: Set<string>;
}

/** R3 归一键：卡/台账/回执/git log 统一用 W-SLUG 锚（`w-xxx` 前缀，大小写不敏感）；
 * 无 slug 前缀的卡（如「巡查员上岗：…」）回落前 10 字归一。标题措辞差（派单书 vs 台账
 * 微调词）在 slug 锚下零影响——三源键同一套。 */
/** W-ORPHANCARD 刀二（1109 用户质问治本）：收割闭链基族键——去代尾/审查尾/复审尾
 * （多重尾循环剥，w-xxx-r1-review → w-xxx）。原 cardlife 内联 baseSlug 只剥 -rN——
 * 审查单卡（w-xxx-review）不归主单基族=终代收割不闭审查卡（1109 实锤 9 张滞留）。
 * 提取为导出纯函数：cardlife 段与对账器同源单点，测试直测。
 * R1（审查 P2-2）：review/audit 吃数字代尾（-review2=今日现行重派约定形态——1109
 * W-HEADFIX-REVIEW2 真单；regex 词后带数字旧白名单不匹配漏网）。-fin/-re/-b 低频
 * 形态不扩（误伤面大于收益），漏网卡走 zombie TTL 三证兜底（boardrecon 保守路径）。 */
export function chainBaseSlug(key: string): string {
  let s = String(key || "");
  for (let i = 0; i < 3; i++) s = s.replace(/-(r\d+|review\d*|audit\d*)$/, "");
  return s;
}

/** W-ORPHANCARD 刀一：续跑唤醒复用查找——title 含续跑词时在板找同基族卡（任意状态
 * ——终态卡续跑=复活原卡不建新卡）。返回卡 id 或 null（null=非续跑形态/板上无原卡，
 * 照旧建新卡）。
 * R1（审查 P0 定谳·双形态触发）：首版正则 `^续跑\s+w-` 只吃前缀式，而生产真身 7 张
 * 全后缀式「W-XXX 续跑」（1109 现板逐张实勘+当日台账 50 笔零前缀式）——0/7 命中空转。
 * 现触发=title 含续跑词（词边界 (?:^|\s)续跑(?:\s|$)——「不诺自动续跑」类正文词不误触，
 * leader 台账 311 笔唯一续跑词命中即该形态）+ raw=harvestKeyOf 首枚 w- 键（前后缀词
 * 天然不进键，刀三锁测在案）。 */
export function findContCard(entries: Array<{ id: string; text?: string }>, title: string): string | null {
  const t = String(title || "").trim();
  if (!/(?:^|\s)续跑(?:\s|$)/.test(t)) return null; // 续跑词边界（双形态通吃：前缀式/后缀式）
  const raw = harvestKeyOf(t);
  if (!raw.startsWith("w-")) return null; // 含续跑词但无 w- 键（如「续跑 巡查员上岗」）→非本面
  const base = chainBaseSlug(raw);
  let baseHit: string | null = null;
  for (const e of entries) {
    const k = harvestKeyOf(String(e.text || ""));
    if (!k.startsWith("w-")) continue;
    if (k === raw) return e.id; // 精确代次优先（续跑 w-x-r1 命中 r1 卡本体）
    if (baseHit === null && chainBaseSlug(k) === base) baseHit = e.id; // 基族回退（终代卡/主卡）
  }
  return baseHit;
}

export function harvestKeyOf(text: string): string {
  const m = String(text || "").match(/w-([a-z0-9][a-z0-9-]{1,40})/i);
  if (m) return `w-${m[1].toLowerCase()}`;
  return String(text || "").replace(/\s+/g, "").slice(0, 10).toLowerCase();
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
  /** W-BOARDRECON-R3：收割证据三源（submitted 陈化判定用；缺席=判定族关闭向后兼容） */
  harvest?: HarvestEvidence;
  /** R3：submitted 陈化阈值（缺省 2h；CCR_BOARDRECON_HARVEST_STALE_MS 可调） */
  harvestStaleMs?: number;
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
  // R1-P2-2①：回落键全板唯一性索引——无 w- slug 锚的卡用前 10 字截断键，跨状态碰撞
  //（done 卡与 submitted 卡同键，或两张 submitted 异文同键）时证据归属不可分辨
  //（reviewseat/reviewseatr1 真板假告警实锤）。回落键仅全板无碰撞时参与证据匹配；
  // 碰撞对一律 skip（连 advisory 都不出=消假告警噪音，人工板面本可见两卡）。
  const fallbackKeyCounts = new Map<string, number>();
  for (const { board: fb } of input.boards) {
    for (const ent of fb.entries) {
      const k = harvestKeyOf(String(ent.text || ""));
      if (k && !k.startsWith("w-")) fallbackKeyCounts.set(k, (fallbackKeyCounts.get(k) ?? 0) + 1);
    }
  }
  for (const { gid, board } of input.boards) {
    // W-BOARDRECON-R3 重复卡检测（前置段——同 gid 同归一键 submitted 双卡）：告警卡提示
    // 合并不自动删（任务书口径③；本事故 sqlitefixr1 ×2 实锤）。注意在 harvested 判定前跑：
    // 双卡同题属「标题多义」，harvested 段对多卡同键降 advisory 不自动翻——两段协同。
    const submittedByKey = new Map<string, string[]>();
    if (input.harvest) {
      for (const e of board.entries) {
        if (e.status !== "submitted") continue;
        const key = harvestKeyOf(String(e.text || ""));
        (submittedByKey.get(key) ?? submittedByKey.set(key, []).get(key)!).push(e.id);
      }
      for (const [key, ids] of submittedByKey) {
        if (ids.length >= 2) {
          actions.push({ gid, entryId: ids[0], text: key, reason: "duplicate-card", detail: `同文本 submitted 双卡 ×${ids.length}（${ids.join(",")}）——疑似重复派单建卡，确认后合并/删一张`, toBacklog: false, advisory: true });
        }
      }
    }
    for (const e of board.entries) {
      // W-BOARDRECON-R3 判定族「已收割未翻」（手工收割断链第二现治本——1105 用户实锤
      // 审查中 23 里 18 张已收割未翻）：submitted 滞留超阈值 + 收割证据 → 翻 done。
      // R1-P1-1（A 审）：翻卡只认②dev log（真收割证据）；①③（交付/收货时点产物）单独
      // 在场降 advisory——在审返修/未 squash 的卡绝不被误翻。
      if (e.status === "submitted" && input.harvest) {
        const harvestStaleMs = input.harvestStaleMs ?? (Number(process.env.CCR_BOARDRECON_HARVEST_STALE_MS) || 2 * 3600_000);
        const updated = Number(e.updated_at || e.ts || 0);
        if (now - updated > harvestStaleMs) {
          const key = harvestKeyOf(String(e.text || ""));
          // R1-P2-2③：空键不参与证据匹配（includes("")/get("") 恒命中=假证据面）
          // R1-P2-2①：回落键全板碰撞（计数>1）=证据归属不可分辨，skip 不出判定
          if (key && !( !key.startsWith("w-") && (fallbackKeyCounts.get(key) ?? 0) > 1 )) {
            const ev = input.harvest;
            const ledgerHit = ev.doneLedger.get(key);
            const ledgerOk = !!ledgerHit && ledgerHit.count >= 1 && ledgerHit.hasReceipt;
            // R1-P2-2②：dev 命中加词边界（负向前瞻）——卡键 w-relayfreshci 不得被 log 里的
            // w-relayfreshci-r1 超串误命中（前缀包含=假收割证据）
            const devHit = key.startsWith("w-")
              ? new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9-])", "i").test(ev.devLogText)
              : ev.devLogText.toLowerCase().includes(key);
            const receiptOk = ev.receiptSlugs.has(key);
            // R1-P1-1（A 审）：证据分档——②=强（真收割：dev 已收）；①③=弱（交付/收货时点，
            // 不证明进 dev）。EXECUTE 只认②；弱证单独在场=advisory「陈化在审请人工核」。
            const weakHits = [ledgerOk && "台账 done+回执", receiptOk && "回执尾行合规"].filter(Boolean) as string[];
            const hits = [devHit && "dev log 命中", ...weakHits].filter(Boolean) as string[];
            const dupCount = submittedByKey.get(key)?.length ?? 1;
            if (devHit && dupCount === 1) {
              actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "harvested-unflipped", detail: `submitted 陈化 ${Math.round((now - updated) / 3600_000)}h，收割证据：${hits.join(" + ")}（含 dev log=真收割）——已收割未翻，翻 done（boardrecon auto）`, toBacklog: false, toDone: true });
            } else if (devHit && dupCount >= 2) {
              actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "harvested-unflipped", detail: `dev log 命中但同键 ${dupCount} 卡并存——多义不自动翻，人工确认后单键翻卡`, toBacklog: false, advisory: true });
            } else if (!devHit && weakHits.length >= 1 && dupCount === 1) {
              actions.push({ gid, entryId: e.id, text: String(e.text || "").slice(0, 40), reason: "harvested-unflipped", detail: `交付/收货证据在（${weakHits.join(" + ")}）但 dev log 未命中——陈化在审请人工核（在审返修/未 squash 均此形态，不自动翻）`, toBacklog: false, advisory: true });
            }
          }
          // 无证据=真在审，不动（真在审不误翻）；空键/回落碰撞键=无可靠归一锚，同不动
        }
        continue;
      }
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

// ── W-BOARDTRUTH5（t-acd5c245，1109 用户军令五现「为啥一而再再而三三而四四而五」）
// 刀二/刀三：形态免疫不变量对账+生效探针。元根因=治路径不治不变量（五现每一现都是
// 「某条路径没走通」——收割无翻卡/手工绕过/PR 不闭/审查单无终态/CLI 未传键），路径会
// 变形态会变，不变量永真：**卡的非终态滞留超 TTL × 交付证据在场/缺席**。五现 10 僵尸=
// 5 submitted+4 claimed（claimed 不在对账范围=R3 盲区）——本刀 claimed/submitted 同辖。

/** 刀二僵尸 TTL：CCR_BOARD_ZOMBIE_TTL_H（小时，缺省 6；显式 "0"=关（逃生阀））——
 * 与 unclaimedTtlMs 同配方（board-truth.ts 惯例：阈值全走 env 不进 plugin-config）。 */
export function zombieTtlMs(): number {
  const raw = process.env.CCR_BOARD_ZOMBIE_TTL_H;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (Number.isFinite(n) && n === 0) return Number.POSITIVE_INFINITY;
  return Number.isFinite(n) && n > 0 ? n * 3600_000 : 6 * 3600_000;
}

/** 僵尸告警 note 标记（幂等锚）：已标记卡第二轮不再重复告警（scan 侧滤除）。
 * 子串稳定无日期——note 内容比对用前缀，追加细节不影响识别。 */
export const ZOMBIE_NOTE_MARK = "[boardtruth5 僵尸卡告警";

export interface ZombieEvidenceAction {
  gid: string;
  entryId: string;
  text: string;
  status: "claimed" | "submitted";
  ageMs: number;
  /** 三证首个命中（台账 done+回执 → 回执尾行合规 → dev log 词边界）；null=三证全无
   * （僵尸告警面——不静默翻，进值守视野人工核实：真长任务可忽略/真僵尸人工收口）。 */
  evidence: "ledger-done" | "receipt-line" | "dev-log" | null;
}

/**
 * 刀二形态免疫对账（纯函数零 IO——boards/harvest 调用侧构建，测试直测）：
 * claimed/submitted 卡超僵尸 TTL → 三证任一成立（台账 done+回执/回执尾行合规/dev log
 * 收录）=强翻 done；三证全无=僵尸告警（evidence=null，不翻——防误杀 6h+ 真长任务，
 * 但让僵尸进入值守视野）。**形态免疫**=判据只看不变量（卡态/龄/交付证据），不看
 * no_pr/派单路径/收割器形态——五现的教训即路径形态必变。
 * 防误杀护栏（与 R3 harvested-unflipped 同三护栏）：①无时戳不臆断（updated_at/ts
 * 全缺 skip）②空键/回落键全板碰撞 skip（证据归属不可分辨）③已带僵尸标记 note skip
 * （告警幂等——一次即记）。skipEntryIds=本拍 reconcileBoardCards 已出判定的卡
 * （两器不重复动作：孤儿归位 vs 证据强翻同拍冲突时 R3 先判，本刀让位）。
 */
export function zombieInvariantScan(input: {
  boards: Array<{ gid: string; board: ProjectBoard }>;
  harvest: HarvestEvidence;
  now?: number;
  ttlMs?: number;
  skipEntryIds?: Set<string>;
}): { actions: ZombieEvidenceAction[] } {
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? zombieTtlMs();
  const skip = input.skipEntryIds ?? new Set<string>();
  // 回落键全板唯一性索引（R1-P2-2①同款——无 slug 锚卡的前 10 字键跨卡碰撞=证据归属
  // 不可分辨，一律 skip）
  const fallbackKeyCounts = new Map<string, number>();
  for (const { board: fb } of input.boards) {
    for (const ent of fb.entries) {
      const k = harvestKeyOf(String(ent.text || ""));
      if (k && !k.startsWith("w-")) fallbackKeyCounts.set(k, (fallbackKeyCounts.get(k) ?? 0) + 1);
    }
  }
  const actions: ZombieEvidenceAction[] = [];
  if (!Number.isFinite(ttl)) return { actions }; // 逃生阀开（TTL=∞）：判定族整体关闭
  for (const { gid, board } of input.boards) {
    for (const e of board.entries) {
      if (e.status !== "claimed" && e.status !== "submitted") continue; // 形态面：非终态滞留两态
      if (skip.has(e.id)) continue; // 本拍 R3 已判定——两器不重复动作
      if (String(e.note || "").includes(ZOMBIE_NOTE_MARK)) continue; // 告警幂等锚（第二轮不再重复）
      const updated = Number(e.updated_at || e.ts || 0);
      if (!updated) continue; // 无时戳不臆断
      const ageMs = now - updated;
      if (ageMs <= ttl) continue; // 未超 TTL（在途常态——6h 内交付/审查中是正常节奏）
      const key = harvestKeyOf(String(e.text || ""));
      // 空键不参与证据匹配（includes("")/get("") 恒命中=假证据面）；回落键碰撞同 skip
      if (!key || (!key.startsWith("w-") && (fallbackKeyCounts.get(key) ?? 0) > 1)) continue;
      const ev = input.harvest;
      const ledgerHit = ev.doneLedger.get(key);
      const ledgerOk = !!ledgerHit && ledgerHit.count >= 1 && ledgerHit.hasReceipt; // 证据①：台账 done+回执
      const receiptOk = ev.receiptSlugs.has(key); // 证据③：回执尾行合规（判定顺序①→③→②，台账最权威）
      // 证据②：dev log 词边界（R1-P2-2②同款——卡键 w-abc 不被 log 里 w-abc-r1 超串误命中）
      const devHit = key.startsWith("w-")
        ? new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9-])", "i").test(ev.devLogText)
        : ev.devLogText.toLowerCase().includes(key);
      const evidence: ZombieEvidenceAction["evidence"] = ledgerOk ? "ledger-done" : receiptOk ? "receipt-line" : devHit ? "dev-log" : null;
      actions.push({ gid, entryId: e.id, text: String(e.text || ""), status: e.status, ageMs, evidence });
    }
  }
  return { actions };
}

/**
 * 刀三生效探针心跳行（纯函数——patrol 对账每轮含空转轮落 audit 一行，测试断言格式）。
 * 目的：「建了从未跑」类断电（五现元根因之一：对账器在 dev 存在、生产 boards-journal
 * 该 action 零行）当日暴露——audit 流 >2h 无 board-recon-loop 行=常驻环死，值守/巡检
 * 可见。off 档也发（mode=off 判定 0——证明 timer 活，动作面零）。
 */
export function reconHeartbeatLine(mode: string, judged: number, flipped: number, zombies: number, zDone: number, zAlarm: number): string {
  return `alive mode=${mode} 对账判定 ${judged}（翻/归 ${flipped}）· 僵尸面 ${zombies}（强翻 ${zDone}/告警 ${zAlarm}）`;
}
