// W-BOARDTRUTH 测试件（t-1e731c9c 治本 + t-2dba637e R1 返修真实化）：
//   A 刀1 判定：**真实形态夹具**（R1：#43/#45/#46/#47 四 PR 真身分支名/title/时戳原样
//     从 gh pr list 拷入——旧夹具改写分支名/title 使命中=造假已删）/异工作守卫/长挂
//     不误关/基族剥前缀+双代尾形态/同分支铁证/自身排除/**P2 时序门**（共享前缀构造
//     形态反例：后继 merged 早于原 PR 创建=不闭）
//   B 刀2 判定：超阈撤/未超不动/末行赢/TTL env 逃生阀
//   C 刀3 判定：**大写 state 形态**（R1：gh 恒返 OPEN/MERGED/CLOSED——旧小写比较=死码）
//     merged 补翻/closed 退回/无 pr_url 不臆断/真值缺不动/小写旧形态兼容
//   D 集成锚：session-manager/patrol 挂点+gh 字段（createdAt/mergedAt）/词表
//   E P1 撤单驱逐（R1）：evictQueuedDispatch 驱逐+落盘；drain 前查终态弃已撤单
//     （台账 queued→failed→running 矛盾链根陔回归）
// 直跑：env -u CCR_DATA_DIR -u CCR_ORG_DIR npx tsx scripts/test-boardtruth.ts
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supersededChainPrs, unclaimedStaleDispatches, unclaimedTtlMs, prStaleBoardActions, branchBaseOf, titleBaseWord, type OpenPrSnap, type PrTruthSnap } from "../src/board-truth.js";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("✗ " + n); } };

// ---------- 真实形态夹具（R1：从 gh pr list --json 原样拷贝——1106 实况） ----------
const REAL = {
  // 真身对①：原 #45 feat/inboxv1（CLOSED，时点形态=open）× 后继 #47 fix/inboxv1r1（MERGED）
  p45: { number: 45, headRefName: "feat/inboxv1", title: "[任务] W-INBOX-V1：收件箱最小切片三刀——×双钮+行键归一+已归档分区（不丢账语义修正）", url: "https://github.com/humumu130/cc-deck/pull/45", createdAt: "2026-11-05T22:34:28Z" } as OpenPrSnap,
  m47: { branch: "fix/inboxv1r1", number: 47, mergedAt: "2026-11-05T23:48:35Z" },
  // 真身对②：原 #43 feat/cardlifer2 × 后继 #46 fix/cardlifer2r3（r 代直连形态）
  p43: { number: 43, headRefName: "feat/cardlifer2", title: "[任务] cardlifer2：板卡生命周期强制化——PR merged 自动翻卡+收口资格位（不靠规则靠机制）", url: "https://github.com/humumu130/cc-deck/pull/43", createdAt: "2026-11-05T22:24:39Z" } as OpenPrSnap,
  m46: { branch: "fix/cardlifer2r3", number: 46, mergedAt: "2026-11-06T00:09:55Z" },
  // 长挂/异链防误伤面（真实当前 open 集）
  p29: { number: 29, headRefName: "fix/sessionmutex", title: "[任务] W-SESSIONMUTEX 同 sid 多进程互斥：撞车三部曲真根治（孤儿进程面守卫+孪生暴露+树锁 pid", url: "https://github.com/humumu130/cc-deck/pull/29", createdAt: "2026-11-05T00:32:47Z" } as OpenPrSnap,
  p50: { number: 50, headRefName: "fix/dutybackoff", title: "[任务] W-DUTYBACKOFF 值守/巡检智能化三刀：对话活跃抑制+无进展回避+DUTY_RECEIPT 接线", url: "https://github.com/humumu130/cc-deck/pull/50", createdAt: "2026-11-06T03:55:59Z" } as OpenPrSnap,
  p51: { number: 51, headRefName: "fix/seatlive", title: "[任务] seatlive：值守席位回合感知存活——CLI 回合退出≠PM 死+续任免卡（断档第四现治本）", url: "https://github.com/humumu130/cc-deck/pull/51", createdAt: "2026-11-06T06:43:41Z" } as OpenPrSnap,
};

console.log("A 刀1 同链 PR 收割即闭判定（真实形态）:");
{
  const openNow: OpenPrSnap[] = [REAL.p45, REAL.p43, REAL.p29, REAL.p50, REAL.p51];
  // 真身对①：feat/inboxv1（开）× fix/inboxv1r1（merged）——异型前缀+连字符 title 双杀旧口径
  const h47 = supersededChainPrs(openNow, REAL.m47.branch, REAL.m47.number, REAL.m47.mergedAt);
  ok(h47.length === 1 && h47[0].number === 45, `A1 真身对①命中（#45 被 #47 superseded——前缀异型 feat×fix+title 连字符 W-INBOX-V1，实 [${h47.map((x) => x.number)}]）`);
  ok(!h47.some((x) => x.number === 29 || x.number === 50 || x.number === 51), "A1b 长挂/异链 #29/#50/#51 不牵连");
  // 真身对②：feat/cardlifer2 × fix/cardlifer2r3（r 代直连+title 空格形态 cardlifer2 R3）
  const h46 = supersededChainPrs(openNow, REAL.m46.branch, REAL.m46.number, REAL.m46.mergedAt);
  ok(h46.length === 1 && h46[0].number === 43, `A2 真身对②命中（#43 被 #46 superseded——r3 直连形态+title 空格 R3，实 [${h46.map((x) => x.number)}]）`);
  // 防误伤：当前真实 open 集对历史 merged（#6 prreview 族）零命中
  ok(supersededChainPrs([REAL.p29, REAL.p50, REAL.p51], "feat/prreview", 6).length === 0, "A3 真实 open 集 ×#6（prreview 族 merged）零命中（不误伤）");
  // 基族真实形态
  ok(branchBaseOf("fix/cardlifer2r3") === "cardlife" && branchBaseOf("feat/cardlifer2") === "cardlife", `A4a 批名自带代号贪婪两代同归（cardlifer2r3≡cardlifer2→cardlife——A2 塌方形态，实 ${branchBaseOf("fix/cardlifer2r3")}/${branchBaseOf("feat/cardlifer2")}）`);
  ok(branchBaseOf("feat/inboxv1") === "inboxv1" && branchBaseOf("fix/inboxv1r1") === "inboxv1", "A4b 异型前缀归同族（feat/inboxv1 ≡ fix/inboxv1r1 → inboxv1——P0-2 根修）");
  ok(branchBaseOf("feat/inboxv1-r1") === "inboxv1", "A4c 连字符代尾形态（-r1）");
  ok(branchBaseOf("fix/prreview2") === "prreview2" && branchBaseOf("fix/sidebarbar") === "sidebarbar", "A4d 非代尾名不误伤（prreview2/sidebarbar 原样）");
  ok(titleBaseWord("[任务] W-INBOX-V1：收件箱最小切片").includes("inboxv1"), "A4e title 归一（连字符/空白剥——W-INBOX-V1 命中 inboxv1 基族词）");
  ok(titleBaseWord("[任务] cardlifer2：板卡生命周期强制化").includes("cardlife"), "A4f title 保险随贪婪基族（cardlifer2 含 cardlife 词）");
  // 异工作同基族守卫（title 无基族词）
  ok(supersededChainPrs([{ number: 61, headRefName: "fix/inboxv1-mirror", title: "[任务] 别的工作（分支撞名）" }], "fix/inboxv1r2", 60).length === 0, "A5 异工作同前缀守卫（-mirror≠基族——①层拦下）");
  ok(supersededChainPrs([{ number: 62, headRefName: "fix/inboxv1r9", title: "[任务] 别的工作（同基族 title 无词）" }], "feat/inboxv1", 63).length === 0, "A5b 同基族异工作（title 保险拦下）");
  // 同分支铁证（同分支=同工作，免 title 保险）+自身排除
  ok(supersededChainPrs([{ number: 71, headRefName: "feat/inboxv1", title: "旧 draft" }], "feat/inboxv1", 70).length === 1, "A6 同分支异号开 PR 闭（同分支铁证）");
  ok(supersededChainPrs([{ number: 47, headRefName: "fix/inboxv1r1", title: "自身" }], "fix/inboxv1r1", 47).length === 0, "A7 merged 自身不进清单（防御）");
  // P2 时序门：共享前缀构造形态（fix/board 后开 × fix/boardr2 先并）→不闭；正序→闭
  const boardOpen: OpenPrSnap[] = [{ number: 80, headRefName: "fix/board", title: "[任务] W-BOARD：某工作（含 board 词）", createdAt: "2026-11-06T10:00:00Z" }];
  ok(supersededChainPrs(boardOpen, "fix/boardr2", 81, "2026-11-06T09:00:00Z").length === 0, "A8 P2 时序门反例（后继 merged 09:00 早于原 PR 创建 10:00——构造形态不闭）");
  ok(supersededChainPrs(boardOpen, "fix/boardr2", 81, "2026-11-06T11:00:00Z").length === 1, "A8b 正序（merged 11:00 晚于创建 10:00）照闭（真返修链不受门误拦）");
}

console.log("B 刀2 未认领 TTL 判定:");
{
  const now = Date.now();
  const H = 3600_000;
  const rows = [
    { id: "d-old", status: "queued", ts: now - 7 * H },
    { id: "d-disp", status: "dispatched", ts: now - 9 * H },
    { id: "d-new", status: "queued", ts: now - 1 * H },
    { id: "d-run", status: "running", ts: now - 30 * H },
    { id: "d-done", status: "done", ts: now - 2 * H },
    { id: "d-revive", status: "queued", ts: now - 8 * H },
    { id: "d-revive", status: "running", ts: now - 1 * H },
  ];
  const stale = unclaimedStaleDispatches(rows, now, 6 * H);
  const ids = stale.map((x) => x.id).sort();
  ok(ids.join(",") === "d-disp,d-old", `B1 超阈撤单恰两单（实 [${ids}]）`);
  ok(!ids.includes("d-revive"), "B2 末行赢（早 queued 晚 running=已开工不撤）");
  ok(!ids.includes("d-run"), "B3 已开工单不在未认领面");
  ok(unclaimedStaleDispatches([{ id: "x", status: "queued", ts: now - 100 * H }], now, Number.POSITIVE_INFINITY).length === 0, "B4 TTL 关扫逃生阀");
  const savedQ = process.env.CCR_UNCLAIMED_TTL_H;
  process.env.CCR_UNCLAIMED_TTL_H = "2";
  ok(unclaimedTtlMs() === 2 * H, "B5 env 阈值可调");
  process.env.CCR_UNCLAIMED_TTL_H = "0";
  ok(unclaimedTtlMs() === Number.POSITIVE_INFINITY, "B6 显式 0=关扫");
  process.env.CCR_UNCLAIMED_TTL_H = savedQ;
}

console.log("C 刀3 审查中×PR 真值对账判定（gh 大写形态）:");
{
  const prs: PrTruthSnap[] = [
    { number: 90, state: "MERGED", url: "https://github.com/x/y/pull/90" }, // R1：gh 实测恒大写
    { number: 91, state: "CLOSED", url: "https://github.com/x/y/pull/91" },
    { number: 92, state: "OPEN", url: "https://github.com/x/y/pull/92" },
    { number: 93, state: "merged", url: "https://github.com/x/y/pull/93" }, // 旧小写注入兼容
  ];
  const boards = [{
    gid: "pg-bt",
    entries: [
      { id: "t-merged-missed", status: "submitted", dispatch_id: "d1", pr_url: "https://github.com/x/y/pull/90" },
      { id: "t-closed-stale", status: "ready_to_install", dispatch_id: "d2", pr_url: "https://github.com/x/y/pull/91" },
      { id: "t-open-ok", status: "submitted", dispatch_id: "d3", pr_url: "https://github.com/x/y/pull/92" },
      { id: "t-merged-lower", status: "submitted", dispatch_id: "d7", pr_url: "https://github.com/x/y/pull/93" },
      { id: "t-no-pr", status: "submitted", dispatch_id: "d4" },
      { id: "t-unknown-pr", status: "submitted", dispatch_id: "d5", pr_url: "https://github.com/x/y/pull/999" },
      { id: "t-done-skip", status: "done", dispatch_id: "d6", pr_url: "https://github.com/x/y/pull/91" },
    ],
  }];
  const acts = prStaleBoardActions(boards, prs);
  ok(acts.length === 3, `C1 恰三动作（大写 MERGED/CLOSED+小写兼容，实 ${acts.length}——旧口径对大写恒 0=P0-1 死码回归锚）`);
  ok(acts.some((a) => a.entryId === "t-merged-missed" && a.reason === "pr-merged-missed"), "C2 大写 MERGED 丢失形态→补翻 done");
  ok(acts.some((a) => a.entryId === "t-closed-stale" && a.reason === "pr-closed-stale"), "C3 大写 CLOSED→退 backlog 标陈");
  ok(acts.some((a) => a.entryId === "t-merged-lower"), "C3b 小写旧形态兼容（手工注入快照不炸）");
  ok(!acts.some((a) => a.entryId === "t-open-ok"), "C4 PR OPEN 真值一致——不动");
  ok(!acts.some((a) => a.entryId === "t-no-pr") && !acts.some((a) => a.entryId === "t-unknown-pr"), "C5 无 pr_url/真值缺——无把握不动");
  ok(!acts.some((a) => a.entryId === "t-done-skip"), "C6 非审查中卡不进对账面");
}

console.log("D 集成锚:");
{
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  ok(sm.includes("closeSupersededChainPRs") && sm.includes("supersededChainPrs"), "D1 session-manager 刀1 挂点+判定接线在");
  ok(sm.includes("void this.closeSupersededChainPRs"), "D1b merged 事件 fire-and-forget");
  ok(sm.includes("number,headRefName,title,url,createdAt") && sm.includes("number,headRefName,mergedAt"), "D1c gh 字段含 createdAt/mergedAt（P2 时序门供时）");
  const pt = readFileSync(new URL("../src/patrol.ts", import.meta.url), "utf-8");
  ok(pt.includes("unclaimedStaleDispatches") && pt.includes("appendDispatch"), "D2 patrol 刀2 拍");
  ok(pt.includes("prStaleBoardActions") && pt.includes("pr\", \"list\", \"--state\", \"all\""), "D3 patrol 刀3 拍");
  ok(pt.includes("boardtruth-unclaimed-"), "D3b 日聚合通知 key");
  ok(pt.includes("evictQueuedDispatch"), "D3c 撤单联动驱逐（P1——patrol 撤单边调用）");
  const ty = readFileSync(new URL("../src/types.ts", import.meta.url), "utf-8");
  ok(["boardtruth-pr-superseded", "boardtruth-pr-close-degraded", "boardtruth-unclaimed-ttl", "boardtruth-pr-merged-missed", "boardtruth-pr-closed-stale"].every((k) => ty.includes(`"${k}"`)), "D4 审计词表五词在");
  ok(ty.includes("boardtruth-queue-evict"), "D4b 驱逐审计词在词表（R1）");
}

console.log("E P1 撤单驱逐（矛盾链根除）:");
{
  // 最小 SessionManager harness：真实例+假工厂缝（test-dispatch 同款配方）
  const prevOrg = process.env.CCR_ORG_DIR, prevData = process.env.CCR_DATA_DIR, prevRead = process.env.CCR_STORAGE_READ_MODE;
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-btr1-")), DATA = mkdtempSync(join(tmpdir(), "ccr-data-btr1-"));
  process.env.CCR_ORG_DIR = ORG; process.env.CCR_DATA_DIR = DATA; process.env.CCR_STORAGE_READ_MODE = "json";
  try {
    const { SessionManager } = await import("../src/session-manager.js");
    const { EventBus } = await import("../src/event-bus.js");
    const { appendDispatch } = await import("../src/org.js");
    const { loadDispatchQueue } = await import("../src/dispatch-queue.js");
    const mgr = new SessionManager(new EventBus({ persistPath: join(DATA, "events.ndjson") }), {
      port: 8791, token: "t", tokenGenerated: false, defaultCwd: DATA, model: "m", bridgeToken: "bt",
      dataDir: DATA, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    } as never);
    const hack = mgr as unknown as { dispatchQueueItems: Array<{ dispatch_id: string; enqueued_at: number; input: Record<string, unknown> }>; drainDispatchQueue(gid: string): void };
    // ① evictQueuedDispatch：驱逐内存+落盘
    hack.dispatchQueueItems = [
      { dispatch_id: "d-revoke-me", enqueued_at: Date.now(), input: { anchor: "/tmp/x", prompt: "被撤单", gid: "g1" } },
      { dispatch_id: "d-keep", enqueued_at: Date.now(), input: { anchor: "/tmp/x", prompt: "正常排队", gid: "g1" } },
    ];
    const n = mgr.evictQueuedDispatch("d-revoke-me");
    const persisted = loadDispatchQueue(ORG).map((x) => x.dispatch_id);
    ok(n === 1 && hack.dispatchQueueItems.length === 1 && hack.dispatchQueueItems[0].dispatch_id === "d-keep", "E1 evictQueuedDispatch 驱逐目标单留他单（内存）");
    ok(!persisted.includes("d-revoke-me") && persisted.includes("d-keep"), `E2 驱逐落盘（dispatch-queue.json 不再含已撤单，实 [${persisted}]）`);
    ok(mgr.evictQueuedDispatch("d-revoke-me") === 0, "E3 幂等（再逐返 0）");
    // ② drain 前查终态：台账已终态的排队单直接弃（不重放——queued→failed→running 矛盾链根除）
    appendDispatch({ ts: Date.now(), id: "d-already-failed", tier: "随手办", target: "cap-queue", status: "queued", receipt: "排队", session_id: "" });
    appendDispatch({ ts: Date.now() + 1, id: "d-already-failed", tier: "随手办", target: "org-command", status: "failed", receipt: "未认领超时撤单（TTL）", session_id: "", actor: "system" });
    hack.dispatchQueueItems = [
      { dispatch_id: "d-already-failed", enqueued_at: Date.now(), input: { anchor: "/tmp/x", prompt: "已撤单却仍在队列（A 审矛盾链形态）", gid: "g1" } },
      { dispatch_id: "d-fresh", enqueued_at: Date.now(), input: { anchor: "/tmp/y", prompt: "健康排队单", gid: "g1" } },
    ];
    try { hack.drainDispatchQueue("g1"); } catch { /* 假工厂未装——dispatchWorker 对健康单可能早退，闸效果只看队列面 */ }
    ok(!hack.dispatchQueueItems.some((x) => x.dispatch_id === "d-already-failed"), "E4 drain 前查终态：已撤单弃出队列（矛盾链根除——不再重放已终态单）");
    const { readDispatchLog } = await import("../src/org.js");
    const chain = readDispatchLog().filter((r) => r.id === "d-already-failed").map((r) => r.status);
    ok(chain[chain.length - 1] === "failed" && !chain.includes("running"), `E5 台账无矛盾链（末行 failed，全程 [${chain}]——旧形态会再出 running）`);
  } finally {
    process.env.CCR_ORG_DIR = prevOrg; process.env.CCR_DATA_DIR = prevData; process.env.CCR_STORAGE_READ_MODE = prevRead;
    rmSync(ORG, { recursive: true, force: true }); rmSync(DATA, { recursive: true, force: true });
  }
}

// ---------- W-CARDTERM-R1：板账异常自证红条（1112 用户「自证件」令——集成锚） ----------
console.log("R1 板账异常自证红条（CARDTERM-R1）:");
{
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  const td = readFileSync(new URL("../../web-console/js/team-domain.js", import.meta.url), "utf-8");
  const css = readFileSync(new URL("../../web-console/css/base.css", import.meta.url), "utf-8");
  ok(sm.includes("boardHealth = new Map") && sm.includes("fixedToday") && sm.includes("stuck: Array<{ text: string; kind: string; hours: number; note: string }>"), "R1a relay 异常账在册（boardHealth Map——当日已修/残留两类）");
  ok(sm.includes("boardReconHealthScan") && sm.includes('"frozen-stuck"') && sm.includes('"failed-in-review"'), "R1b stuck 扫描两类（冻结组滞卡+failed×复核矛盾——D18 保护态显性化）");
  ok(sm.includes("(outBoard as { health?: unknown }).health = hh"), "R1c emitBoard 帧挂 health（BOARD_UPDATED 首帧/diff 同口——勿新开轮询面）");
  ok(sm.includes("this.boardHealthBump(g.id, movedLocal)") && sm.includes("this.emitBoard(g.id);"), "R1d 搬后计数+帧下发（对账动作即时反映到红条数据源）");
  ok(td.includes('class="board-health-bar err"') && td.includes("板账异常 ") && td.includes("（点击查看）"), "R1e 前端红条 markup（常驻警示条+可展开）");
  ok(td.includes("board && board.health && Array.isArray(board.health.stuck)") && td.includes(': "";'), "R1f N=0 零渲染（健康态零痕迹——三元空串不占空间）");
  ok(td.includes("挂起组滞卡") && td.includes("台账失败但卡停复核") && sm.includes("请人工裁决") && sm.includes("复活后下轮对账收敛"), "R1g 人话纪律（类型人话在 td/note 人话在 sm——处置建议皆人话非裸枚举）");
  ok(td.includes("bh.fixedToday") && td.includes("今日已自动修正"), "R1h 当日已修可见（次要行——修了什么同样示众）");
  ok(css.includes(".board-health-bar") && css.includes("var(--error)") && css.includes(".bh-list"), "R1i 红条 CSS（err 色系+清单布局）");
  ok(td.includes("boardHealthBar + "), "R1j 红条入板 pane（泳道之上页头之下——boardMarkup return 前拼）");
}

// ---------- W-CARDTERM-R2：backlog 死卡收敛+僵尸喂红条（集成锚——反方审三 P1 返修） ----------
console.log("R2 backlog 死卡收敛+僵尸喂红条（CARDTERM-R2）:");
{
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  const br = readFileSync(new URL("../src/board-recon.ts", import.meta.url), "utf-8");
  const pt = readFileSync(new URL("../src/patrol.ts", import.meta.url), "utf-8");
  const td = readFileSync(new URL("../../web-console/js/team-domain.js", import.meta.url), "utf-8");
  ok(sm.includes("readDispatchLog(undefined, 20_000)") && sm.includes("ledInterrupt"), "R2a P1-2 窗扩 20k+中断行在册（刀三+红条同受益；守护语义修判据=台账行 receipt 前缀）");
  ok(sm.includes('"terminal-stuck"'), "R2b 红条 terminal-stuck 第三类（backlog×failed 超龄/守护命中示众/claimed 残留——backlog 死卡显性化）");
  ok(sm.includes("boardHealthFeedZombies") && sm.includes("boardZombies"), "R2c 僵尸喂红条账+喂入口（patrol 拍尾全量替换——清单变化即发帧）");
  ok(sm.includes("...hh.stuck, ...zz.filter"), "R2d emitBoard health 合成（僵尸拼接文本键去重——recon 扫描优先，两账皆空=零渲染口径不变）");
  ok(pt.includes('startsWith("relay 重启")') && pt.includes("不算收割证据"), "R2e patrol 证据①滤中断行（P2-4——切 auto 防中断退单卡成批误翻）");
  ok(pt.includes("boardtruth5-zombie-observe"), "R2f observe 档僵尸告警双通道（duty feed+通知——「不静默翻」不退化成「不翻不响」P2-5）");
  ok(br.includes("zombieBacklogTtlMs") && br.includes("isBacklogNoId"), "R2g 僵尸形态门扩无关联 backlog（w-slug×72h 长窗——F6 五网盲面接住）");
  ok(td.includes("台账终态滞留") && td.includes("僵尸卡·证据在") && td.includes("僵尸卡·三证全无"), "R2h 前端类型人话随扩（terminal-stuck+僵尸两类——红条清单第五类）");
}

console.log(`\nboardtruth: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
process.exit(fail ? 1 : 0);
