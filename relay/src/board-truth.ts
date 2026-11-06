// [W-BOARDTRUTH]（t-1e731c9c，1106 用户军令「不能我说一次你就核准一次就完事了，还是要治本」）
// 看板不说谎第三现治本——三判定纯函数（gh/台账/板仓真值对账，relay 集成面在
// session-manager（刀1 挂 pr-report merged）与 patrol（刀2/刀3 周期拍））。
//
// 第三现事故回链：返修链收割走新 PR（#47/#46 squash 入 dev），原分支 PR（#45
// feat/inboxv1、#43 feat/cardlifer2）无人关闭→板卡审查中虚高；另派单创建后未认领
// 无 TTL→claimed 泳道挂陈卡。三现共性=每现都 PM 手工对账+手工关卡，从未收口机制层。
//
// 设计铁律：
// - **宁可漏关不可错关**（任务书刀1 原文）：#29/#6 长挂 PR 绝不能被误判——同链判定
//   双条件硬门槛（分支基族命中 ∧ 后继已 merge 铁证）+title 基族词双保险；
// - 纯函数零 IO（gh 调用/台账读在集成面——测试直测判定，夹具免 mock 子进程）；
// - 无真值源（无 pr_url 的卡/gh 不可用）→不动作不臆断（审计降级留痕）。

/** 开 PR 快照形态（gh pr list 拉平——集成面构造） */
export interface OpenPrSnap { number: number; headRefName: string; title: string; url?: string; }

/** 分支/基族去代尾：`fix/cardlifer2r3`/`feat/inboxv1-r1`/`fix/boardtruth-r2` → 基族
 *（去尾部 `-?r\d+`——cardlifer2r3→cardlifer2、inboxv1-r1→inboxv1；非代尾名（sidebarbar/
 * prreview2——尾部无 r 前缀数字）原样返回。与板卡侧 baseSlug（cardlifer2 R2）同口径扩格：
 * 分支名返修链既有 `-r1` 连字符形态也有 `r3` 直连形态（1106 实况：fix/cardlifer2r3）。 */
export const branchBaseOf = (branch: string): string =>
  String(branch || "").replace(/-?r\d+$/, "");

/**
 * 刀1 判定：同链仍开 PR 清单（收割即闭候选）。
 *
 * 双条件（任务书原文「同 title 前缀+已存在后继 merge」的分支名硬形态）：
 *   ① **同链基族**：open PR 的分支基族 === 后继分支基族（分支名是 worker 派单时定的
 *      硬锚，比 title 更难撞——title 会被 PM/worker 润色）；
 *   ② **后继已 merge 铁证**：调用点=pr-report merged 事件（本事件即证——非 merged
 *      事件绝不进本函数）；
 *   ③ **title 基族词双保险**：open PR 的 title 含基族词（防分支命名巧合——两条不同
 *      工作撞同基族名时 title 不含对方 slug 词则不关）。
 * 返回命中的开 PR 清单（集成面逐个 gh pr close 带核销评论）；空=无同链/保守不动。
 */
export function supersededChainPrs(openPrs: OpenPrSnap[], mergedBranch: string, mergedNumber: number): OpenPrSnap[] {
  const base = branchBaseOf(String(mergedBranch || "").trim());
  if (!base) return [];
  const slugWord = base.split("/").pop() || base; // 基族词（fix/cardlifer2→cardlifer2——title 保险用）
  return openPrs.filter((pr) => {
    if (!pr || typeof pr.number !== "number") return false;
    if (pr.number === mergedNumber) return false; // 自身（merged，不在 open——防御）
    const prBase = branchBaseOf(String(pr.headRefName || "").trim());
    if (prBase !== base) return false; // ① 同链基族
    // 基族自身相同（同分支多 PR 形态）不靠 title 保险拦——同分支=同工作铁证
    if (String(pr.headRefName || "").trim() === String(mergedBranch || "").trim()) return true;
    // ③ title 基族词双保险（分支基族同但异工作的巧合防线）
    return String(pr.title || "").toLowerCase().includes(slugWord.toLowerCase());
  });
}

/** 台账行最小面（patrol 扫描输入——读侧只取判定所需字段） */
export interface DispatchRowLite { id?: string; status?: string; ts?: number; }

/**
 * 刀2 判定：未认领超时派单清单（queued/dispatched 停滞超阈——派了没开工）。
 * 「未认领」=台账停在 queued/dispatched（未到 running=worker 从未真正接活）；claimed
 * 板卡挂着是孤儿卡面（boardrecon 管），本刀不越界。
 * 返回超时行（集成面逐单撤单：台账 failed 收口+板卡回 backlog+审计+日聚合通知）。
 */
export function unclaimedStaleDispatches(rows: DispatchRowLite[], now = Date.now(), ttlMs = unclaimedTtlMs()): DispatchRowLite[] {
  // 末行赢：同 id 取最后一行（追加账本语义——早行 queued 晚行 done 的单不看早行）
  const last = new Map<string, DispatchRowLite>();
  for (const r of rows) {
    if (r && typeof r.id === "string" && r.id) last.set(r.id, r);
  }
  const out: DispatchRowLite[] = [];
  for (const r of last.values()) {
    if (r.status !== "queued" && r.status !== "dispatched") continue;
    const ts = Number(r.ts) || 0;
    if (!ts) continue; // 无时间戳不臆断
    if (now - ts > ttlMs) out.push(r);
  }
  return out;
}

/** 刀2 阈值：CCR_UNCLAIMED_TTL_H（小时，缺省 6——任务书建议值；显式 "0" 关扫（逃生阀）） */
export function unclaimedTtlMs(): number {
  const raw = process.env.CCR_UNCLAIMED_TTL_H;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (Number.isFinite(n) && n === 0) return Number.POSITIVE_INFINITY; // 显式 0=关
  return Number.isFinite(n) && n > 0 ? n * 3600_000 : 6 * 3600_000;
}

/** PR 真值快照（刀3——state∈open/closed/merged；集成面 gh pr list --state all 构造） */
export interface PrTruthSnap { number: number; state: string; url: string; }

/** 板卡最小面（dispatch_id+pr_url 在板卡上——prchip 落值面） */
export interface TruthBoardEntry { id: string; status: string; dispatch_id?: string; pr_url?: string; text?: string; note?: string; }

export interface PrStaleAction {
  gid: string;
  entryId: string;
  /** pr-closed-stale=审查中卡但 PR 已闭（非 merged）→翻 backlog 标陈；
   *  pr-merged-missed=审查中卡但 PR 已 merged（merged 事件丢失形态——PM 收割没上报）→翻 done */
  reason: "pr-closed-stale" | "pr-merged-missed";
  detail: string;
}

/**
 * 刀3 判定：审查中泳道（submitted/ready_to_install）×开 PR 真值双向对。
 * 板卡带 pr_url（prchip 落值）且对应 PR 真值 closed→翻 backlog 标陈；merged→翻 done
 * （merged 事件丢失的对账兜底——pr-report 状态机的补网）。无 pr_url 的审查中卡=无真值
 * 源不动作（纯 relay 收口单无 PR——不臆断）；PR 真值缺（gh 降级）由集成面跳过本函数。
 */
export function prStaleBoardActions(boards: Array<{ gid: string; entries: TruthBoardEntry[] }>, prs: PrTruthSnap[]): PrStaleAction[] {
  const byUrl = new Map(prs.map((p) => [String(p.url || ""), p]));
  const actions: PrStaleAction[] = [];
  for (const { gid, entries } of boards) {
    for (const e of entries) {
      if (e.status !== "submitted" && e.status !== "ready_to_install") continue;
      const url = String(e.pr_url || "");
      if (!url.startsWith("https://")) continue; // 无 PR 真值锚——不臆断
      const pr = byUrl.get(url);
      if (!pr) continue; // 清单里没有（gh limit 截断/异库）——无把握不动
      if (pr.state === "merged") {
        actions.push({ gid, entryId: e.id, reason: "pr-merged-missed", detail: `卡 ${e.id} 审查中但 PR #${pr.number} 已 merged（merged 事件丢失形态）——对账兜底翻 done` });
      } else if (pr.state === "closed") {
        actions.push({ gid, entryId: e.id, reason: "pr-closed-stale", detail: `卡 ${e.id} 审查中但 PR #${pr.number} 已关闭（非 merged——被拒/手动关）——翻回 backlog 标陈` });
      }
    }
  }
  return actions;
}
