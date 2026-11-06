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

/** 开 PR 快照形态（gh pr list 拉平——集成面构造）。
 *  W-BOARDTRUTH-R1（P2 时序门）：增 createdAt/mergedAt（gh 同名字段 ISO 串或 ms 数——
 *  侧只做大小比较，字符串 ISO 与数字均接受）。 */
export interface OpenPrSnap { number: number; headRefName: string; title: string; url?: string; createdAt?: number | string; }

/** 分支→基族（R1 P0-2 真实化）：`fix/cardlifer2r3`/`feat/inboxv1-r1` → `cardlife`/
 * `inboxv1`——①小写归一；②**剥 type 前缀**（feat|fix|build|diag/——返修链换 type 是常态：
 * 真身 #45 feat/inboxv1 × 后继 #47 fix/inboxv1r1，旧口径连前缀比=恒不等=刀1 对真身漏判
 * 的直接根因）；③**贪婪循环**去尾部 `-?r\d+`（连字符 r1 与直连 r3 双形态）——单遍剥在
 * 「批名自身尾含代号」形态塌方（A2 实锤：cardlifer2 单遍剥成 cardlife 而 cardlifer2r3
 * 剥成 cardlifer2=不对称漏判——贪婪两代同归 cardlife；与板卡侧 baseSlug「cardlifer2 R2」
 * 代际口径同源）。非代尾名（prreview2 尾 v2≠rN/sidebarbar）原样。 */
export const branchBaseOf = (branch: string): string => {
  let b = String(branch || "").trim().toLowerCase().replace(/^(feat|fix|build|diag)\//, "");
  for (;;) {
    const next = b.replace(/-?r\d+$/, "");
    if (next === b || !next) return b || next;
    b = next;
  }
};

/** title 基族词保险的归一化（R1 P0-2）：小写+去连字符/空白（真身 #45 title 是
 * `W-INBOX-V1：…`——连字符形态旧 `includes("inboxv1")` 恒 miss=保险失效）。 */
export const titleBaseWord = (title: string): string =>
  String(title || "").toLowerCase().replace(/[\s\-—]+/g, "");

/**
 * 刀1 判定：同链仍开 PR 清单（收割即闭候选）。
 *
 * 条件（R1 真实化后四重）：
 *   ① **同链基族**：open PR 分支基族 === 后继分支基族（剥 type 前缀后比——真身
 *      feat/inboxv1 × fix/inboxv1r1 命中）；
 *   ② **后继已 merge 铁证**：调用点=pr-report merged 事件（非 merged 事件绝不进）；
 *   ③ **title 基族词双保险**：归一化 title（去连字符/空白）含基族词（真身
 *      `W-INBOX-V1：` 命中）——防两条不同工作撞同基族名；
 *   ④ **时序门（P2）**：后继 mergedAt 晚于原 PR createdAt 才判 superseded——共享前缀
 *      命名（fix/board 后开 × fix/boardr2 先并）构造形态下后继比原 PR 还早=不是它的
 *      返修链，不闭。任一时戳缺席不拦（集成面 gh 恒供）。
 * 返回命中的开 PR 清单（集成面逐个 gh pr close 带核销评论）；空=无同链/保守不动。
 */
export function supersededChainPrs(openPrs: OpenPrSnap[], mergedBranch: string, mergedNumber: number, mergedAt?: number | string): OpenPrSnap[] {
  const base = branchBaseOf(String(mergedBranch || ""));
  if (!base) return [];
  const slugWord = base; // 基族词（已剥前缀——title 保险用）
  const mergedAtMs = mergedAt === undefined || mergedAt === null || mergedAt === "" ? undefined : new Date(mergedAt).getTime();
  return openPrs.filter((pr) => {
    if (!pr || typeof pr.number !== "number") return false;
    if (pr.number === mergedNumber) return false; // 自身（merged，不在 open——防御）
    // ④ 时序门（P2）：后继 merged 晚于原 PR 创建才可能是它的返修链（缺时戳不拦）
    if (mergedAtMs !== undefined && !Number.isNaN(mergedAtMs)) {
      const createdMs = pr.createdAt === undefined || pr.createdAt === null || pr.createdAt === "" ? undefined : new Date(pr.createdAt).getTime();
      if (createdMs !== undefined && !Number.isNaN(createdMs) && !(mergedAtMs > createdMs)) return false;
    }
    const prBase = branchBaseOf(String(pr.headRefName || ""));
    if (prBase !== base) return false; // ① 同链基族
    // 同分支全名（同分支多 PR 形态）不靠 title 保险拦——同分支=同工作铁证
    if (String(pr.headRefName || "").trim().toLowerCase() === String(mergedBranch || "").trim().toLowerCase()) return true;
    // ③ title 基族词双保险（归一化——连字符/空白形态命中）
    return titleBaseWord(pr.title).includes(slugWord);
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
  // R1 P0-1：gh `pr list --json state` 返回**大写** "OPEN"/"MERGED"/"CLOSED"（A 审实测
  // 5/5 大写 0 小写）——旧小写比较恒不中=刀3 死码（生产恒零动作）。双侧归一比较，
  // 大小写两形态同判（快照手工小写注入的旧夹具兼容）。
  const byUrl = new Map(prs.map((p) => [String(p.url || ""), { st: String(p.state || "").toLowerCase(), n: Number(p.number) || 0 }]));
  const actions: PrStaleAction[] = [];
  for (const { gid, entries } of boards) {
    for (const e of entries) {
      if (e.status !== "submitted" && e.status !== "ready_to_install") continue;
      const url = String(e.pr_url || "");
      if (!url.startsWith("https://")) continue; // 无 PR 真值锚——不臆断
      const t = byUrl.get(url);
      if (!t || !t.st) continue; // 清单里没有（gh limit 截断/异库）——无把握不动
      if (t.st === "merged") {
        actions.push({ gid, entryId: e.id, reason: "pr-merged-missed", detail: `卡 ${e.id} 审查中但 PR #${t.n} 已 merged（merged 事件丢失形态）——对账兜底翻 done` });
      } else if (t.st === "closed") {
        actions.push({ gid, entryId: e.id, reason: "pr-closed-stale", detail: `卡 ${e.id} 审查中但 PR #${t.n} 已关闭（非 merged——被拒/手动关）——翻回 backlog 标陈` });
      }
    }
  }
  return actions;
}
