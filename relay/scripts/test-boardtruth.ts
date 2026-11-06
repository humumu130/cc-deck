// W-BOARDTRUTH 测试件（t-1e731c9c，看板不说谎第三现治本）：
//   A 刀1 判定：同链命中（#45/#43 第三现形态）/异工作同前缀守卫/#29 长挂不误关/
//     -r1 连字符与 r3 直连双形态基族/同分支多 PR
//   B 刀2 判定：超阈撤/未超不动/末行赢（早 queued 晚 done 不撤）/TTL env 逃生阀
//   C 刀3 判定：merged 补翻（事件丢失形态）/closed 退回/无 pr_url 不臆断/PR 真值缺不动
//   D 集成锚：session-manager 挂点/patrol 两拍/词表五词
// 直跑：env -u CCR_DATA_DIR -u CCR_ORG_DIR npx tsx scripts/test-boardtruth.ts
import { readFileSync } from "node:fs";
import { supersededChainPrs, unclaimedStaleDispatches, unclaimedTtlMs, prStaleBoardActions, branchBaseOf, type OpenPrSnap, type PrTruthSnap } from "../src/board-truth.js";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("✗ " + n); } };

console.log("A 刀1 同链 PR 收割即闭判定:");
{
  // 第三现真身形态：原 PR #45 feat/inboxv1（开）+后继 #47 feat/inboxv1r1（merged 事件）
  const openPrs: OpenPrSnap[] = [
    { number: 45, headRefName: "feat/inboxv1", title: "[任务] inboxv1：收件箱最小切片", url: "u45" },
    { number: 29, headRefName: "fix/sessionmutex", title: "[任务] sessionmutex：孪生互斥", url: "u29" }, // 长挂不相关
    { number: 51, headRefName: "feat/linkquality-r1", title: "[任务] linkquality R1：遥测返修", url: "u51" }, // 异链
  ];
  const hits = supersededChainPrs(openPrs, "feat/inboxv1r1", 47);
  ok(hits.length === 1 && hits[0].number === 45, `A1 同链命中（#45 被 #47 superseded——第三现真身形态，实 [${hits.map((x) => x.number)}]）`);
  ok(!hits.some((x) => x.number === 29), "A2 长挂 PR #29 不误关（异链——宁可漏关不可错关）");
  ok(supersededChainPrs(openPrs, "feat/linkquality-r1", 50).every((x) => x.number !== 45), "A3 异链 merged 不牵连（#45 只被自家链闭）");
  // 守卫：异工作同前缀（基族撞名但 title 无基族词）
  const decoy: OpenPrSnap[] = [{ number: 61, headRefName: "fix/inboxv1-mirror", title: "[任务] 别的工作（分支撞名）", url: "u61" }];
  ok(supersededChainPrs(decoy, "feat/inboxv1r2", 60).length === 0 || supersededChainPrs([{ number: 61, headRefName: "fix/inboxv1-mirror", title: "[任务] 别的工作（title 无基族词）", url: "u61" }], "feat/inboxv1r2", 60).length === 0, "A4 异工作同前缀守卫（title 基族词双保险拦下）");
  // 基族双形态
  ok(branchBaseOf("fix/cardlifer2r3") === "fix/cardlifer2", `A5a 基族直连形态（cardlifer2r3→cardlifer2，实 ${branchBaseOf("fix/cardlifer2r3")}）`);
  ok(branchBaseOf("feat/inboxv1-r1") === "feat/inboxv1", "A5b 基族连字符形态（-r1）");
  ok(branchBaseOf("fix/prreview2") === "fix/prreview2", "A5c 非代尾名不误伤（prreview2 尾部 w2≠rN）");
  ok(branchBaseOf("fix/sidebarbar") === "fix/sidebarbar", "A5d 无代尾原样");
  // 同分支多 PR（同分支=同工作铁证，免 title 保险）
  ok(supersededChainPrs([{ number: 71, headRefName: "feat/inboxv1", title: "旧 draft" }], "feat/inboxv1", 70).length === 1, "A6 同分支异号开 PR 闭（同分支铁证）");
  // 自身排除
  ok(supersededChainPrs([{ number: 47, headRefName: "feat/inboxv1r1", title: "自身" }], "feat/inboxv1r1", 47).length === 0, "A7 merged 自身不进清单（防御）");
}

console.log("B 刀2 未认领 TTL 判定:");
{
  const now = Date.now();
  const H = 3600_000;
  const rows = [
    { id: "d-old", status: "queued", ts: now - 7 * H },      // 超阈 queued
    { id: "d-disp", status: "dispatched", ts: now - 9 * H }, // 超阈 dispatched
    { id: "d-new", status: "queued", ts: now - 1 * H },      // 未超
    { id: "d-run", status: "running", ts: now - 30 * H },    // 已开工（非未认领面）
    { id: "d-done", status: "done", ts: now - 2 * H },       // 终态
    { id: "d-revive", status: "queued", ts: now - 8 * H },   // 早行超阈……
    { id: "d-revive", status: "running", ts: now - 1 * H },  // ……晚行 running（末行赢不撤）
  ];
  const stale = unclaimedStaleDispatches(rows, now, 6 * H);
  const ids = stale.map((x) => x.id).sort();
  ok(ids.join(",") === "d-disp,d-old", `B1 超阈撤单恰两单（queued+dispatched，实 [${ids}]）`);
  ok(!ids.includes("d-revive"), "B2 末行赢（早行 queued 晚行 running=已开工不撤）");
  ok(!ids.includes("d-run"), "B3 已开工单不在未认领面（claimed 挂卡归 boardrecon 孤儿面）");
  ok(unclaimedStaleDispatches([{ id: "x", status: "queued", ts: now - 100 * H }], now, Number.POSITIVE_INFINITY).length === 0, "B4 TTL 关扫逃生阀（Infinity 恒不撤）");
  const savedQ = process.env.CCR_UNCLAIMED_TTL_H;
  process.env.CCR_UNCLAIMED_TTL_H = "2";
  ok(unclaimedTtlMs() === 2 * H, "B5 env 阈值可调（CCR_UNCLAIMED_TTL_H=2h）");
  process.env.CCR_UNCLAIMED_TTL_H = "0";
  ok(unclaimedTtlMs() === Number.POSITIVE_INFINITY, "B6 显式 0=关扫");
  process.env.CCR_UNCLAIMED_TTL_H = savedQ;
}

console.log("C 刀3 审查中×PR 真值对账判定:");
{
  const prs: PrTruthSnap[] = [
    { number: 90, state: "merged", url: "https://github.com/x/y/pull/90" },
    { number: 91, state: "closed", url: "https://github.com/x/y/pull/91" },
    { number: 92, state: "open", url: "https://github.com/x/y/pull/92" },
  ];
  const boards = [{
    gid: "pg-bt",
    entries: [
      { id: "t-merged-missed", status: "submitted", dispatch_id: "d1", pr_url: "https://github.com/x/y/pull/90" },
      { id: "t-closed-stale", status: "ready_to_install", dispatch_id: "d2", pr_url: "https://github.com/x/y/pull/91" },
      { id: "t-open-ok", status: "submitted", dispatch_id: "d3", pr_url: "https://github.com/x/y/pull/92" },
      { id: "t-no-pr", status: "submitted", dispatch_id: "d4" }, // 无 url=无真值源
      { id: "t-unknown-pr", status: "submitted", dispatch_id: "d5", pr_url: "https://github.com/x/y/pull/999" }, // 真值缺
      { id: "t-done-skip", status: "done", dispatch_id: "d6", pr_url: "https://github.com/x/y/pull/91" }, // 非审查中
    ],
  }];
  const acts = prStaleBoardActions(boards, prs);
  ok(acts.length === 2, `C1 恰两动作（merged 补翻+closed 退回，实 ${acts.length}）`);
  ok(acts.some((a) => a.entryId === "t-merged-missed" && a.reason === "pr-merged-missed"), "C2 merged 丢失形态→补翻 done");
  ok(acts.some((a) => a.entryId === "t-closed-stale" && a.reason === "pr-closed-stale"), "C3 PR 已闭（非 merged）→退 backlog 标陈");
  ok(!acts.some((a) => a.entryId === "t-open-ok"), "C4 PR open 真值一致——不动");
  ok(!acts.some((a) => a.entryId === "t-no-pr"), "C5 无 pr_url 不臆断（纯 relay 单无真值源）");
  ok(!acts.some((a) => a.entryId === "t-unknown-pr"), "C6 PR 真值缺（limit 截断/异库）——无把握不动");
  ok(!acts.some((a) => a.entryId === "t-done-skip"), "C7 非审查中卡不进对账面");
}

console.log("D 集成锚:");
{
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  ok(sm.includes("closeSupersededChainPRs") && sm.includes("supersededChainPrs"), "D1 session-manager 刀1 挂点+判定接线在");
  ok(sm.includes("void this.closeSupersededChainPRs"), "D1b merged 事件 fire-and-forget（不阻塞 orgAction 命令面）");
  const pt = readFileSync(new URL("../src/patrol.ts", import.meta.url), "utf-8");
  ok(pt.includes("unclaimedStaleDispatches") && pt.includes("appendDispatch"), "D2 patrol 刀2 拍（TTL 撤单+台账 failed 收口）");
  ok(pt.includes("prStaleBoardActions") && pt.includes("pr\", \"list\", \"--state\", \"all\""), "D3 patrol 刀3 拍（gh pr list 真值+对账处置）");
  ok(pt.includes("boardtruth-unclaimed-"), "D3b 日聚合通知 key（同 key 幂等非轰炸）");
  const ty = readFileSync(new URL("../src/types.ts", import.meta.url), "utf-8");
  ok(["boardtruth-pr-superseded", "boardtruth-pr-close-degraded", "boardtruth-unclaimed-ttl", "boardtruth-pr-merged-missed", "boardtruth-pr-closed-stale"].every((k) => ty.includes(`"${k}"`)), "D4 审计词表五词在");
}

console.log(`\nboardtruth: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
process.exit(fail ? 1 : 0);
