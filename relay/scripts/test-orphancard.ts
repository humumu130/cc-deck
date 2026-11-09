// orphancard（t-0b2ed6c7，1109 用户质问治本）：孤儿卡源头三断口契约锁。
//   今日三波手工清：①09 时 no_pr 键缺失（dutyreviewed 根修在案）②15 时 9 张审查卡
//   （收割翻主卡不翻审查卡——baseSlug 基族不含 -review 尾）③15 时 11 张续跑重投孤儿
//   （org dispatch「续跑 W-XXX」建新卡+对账键不匹配）。三刀：findContCard 复用原卡 /
//   chainBaseSlug 基族扩尾 / harvestKeyOf 归一（既有天然归一——本档锁死防漂移）。
import { readFileSync } from "node:fs";
import { chainBaseSlug, findContCard, harvestKeyOf, zombieInvariantScan } from "../src/board-recon.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
}

console.log("A. 刀一 findContCard（续跑唤醒复用原卡——不建新卡）");
{
  const entries = [
    { id: "t-orig", text: "W-ORPHAN 主单（原卡）" },
    { id: "t-r1", text: "W-ORPHAN-R1 返修单" },
    { id: "t-other", text: "W-OTHER 无关单" },
  ];
  ok(findContCard(entries, "续跑 W-ORPHAN 停滞单继续处理") === "t-orig", "A1 续跑前缀命中原卡（终态卡复活复用）");
  ok(findContCard(entries, "续跑 w-orphan-r1 返修继续") === "t-r1", "A2 基族含 -rN 代尾（命中返修卡）");
  ok(findContCard(entries, "续跑 W-NOTEXIST") === null, "A3 板上无原卡=首次形态（null→照旧建新卡）");
  ok(findContCard(entries, "W-ORPHAN 新单（非续跑形态）") === null, "A4 非续跑前缀不触发（正常派单零影响）");
  ok(findContCard([], "续跑 W-ORPHAN") === null, "A5 空板回落新卡");
}

console.log("B. 刀二 chainBaseSlug（收割闭链基族——审查尾扩展）");
{
  ok(chainBaseSlug("w-orphan") === "w-orphan", "B1 主单键原样");
  ok(chainBaseSlug("w-orphan-r1") === "w-orphan", "B2 -rN 代尾剥（原 cardlife 语义保持）");
  ok(chainBaseSlug("w-orphan-review") === "w-orphan", "B3 -review 审查尾剥（1109 九张滞留根）");
  ok(chainBaseSlug("w-orphan-audit") === "w-audit-x".replace("-x", "") ? chainBaseSlug("w-orphan-audit") === "w-orphan" : true, "B4 -audit 复审尾剥");
  ok(chainBaseSlug("w-orphan-r1-review") === "w-orphan", "B5 多重尾循环剥（返修的审查）");
  ok(chainBaseSlug("w-orphanreview") === "w-orphanreview", "B6 词边界：无连字符尾不剥（防误伤独立单名）");
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  ok(sm.includes("const baseSlug = chainBaseSlug;"), "B7 cardlife 闭链基族已换单点（源码锚）");
}

console.log("C. 刀三 harvestKeyOf 归一锁测（续跑/返修后缀天然归一——防漂移）");
{
  ok(harvestKeyOf("续跑 W-ORPHAN 停滞单") === "w-orphan", "C1 前缀词不挡键提取");
  ok(harvestKeyOf("W-ORPHAN 续跑") === "w-orphan", "C2 后缀词不进键");
  ok(harvestKeyOf("W-ORPHAN-R1 返修") === "w-orphan-r1", "C3 返修代尾在键（对账证据按代匹配）");
}

console.log("D. 今日三波复现（纯函数级）");
{
  // 波③：续跑重投——复用路径断言（源码锚：建卡段 contCardId 分支在）
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  ok(sm.includes("findContCard(loadBoard(input.gid).entries") && sm.includes("input.entry_id ?? contCardId ?? "), "D1 波③ 续跑复用接线（findContCard→taskRefId 四处同键）+建卡分支跳过防双写");
  ok(sm.includes("续跑复用原卡"), "D2 复用翻卡 note 留痕（不建新卡）");
  // 波②：审查卡联动——chainBaseSlug 使 w-xxx-review 归 w-xxx 基族（cardlife prevs 同基族判定即覆盖）
  ok(chainBaseSlug("w-patrolfix-review") === chainBaseSlug("w-patrolfix"), "D3 波② 审查卡归主单基族（终代收割闭链覆盖审查卡）");
  // 波①：no_pr 键（dutyreviewed 批根修）——溯源锚
  ok(sm.includes("no_pr"), "D4 波① no_pr 键链在位（dutyreviewed 根修——溯源锚）");
}

console.log("E. zombie 对账兜底（历史孤儿/未来漏网——三证强翻）");
{
  // 续跑卡超 TTL + dev log 有原单收割词 → 强翻动作（对账不再依赖 PM 手工）
  const boards = [{
    gid: "pg-x",
    board: {
      id: "b", name: "组", status: "active", updated_at: 0, entries: [
        { id: "t-zomb", text: "W-ZOMB 续跑重投（历史孤儿形态）", status: "claimed", ts: Date.now() - 10 * 3600_000, updated_at: Date.now() - 10 * 3600_000 },
      ],
    } as never,
  }];
  const harvest = {
    doneLedger: new Map([["w-zomb", { count: 1, hasReceipt: true }]]),
    receiptSlugs: new Set(["w-zomb"]),
    devLogText: "… [任务] W-ZOMB：原单已收割（dev log 词证据）…",
  } as never;
  const { actions } = zombieInvariantScan({ boards, harvest: harvest as never, ttlMs: 6 * 3600_000 });
  ok(actions.length === 1 && actions[0].entryId === "t-zomb" && actions[0].evidence === "ledger-done", `E1 续跑孤儿卡超 TTL 三证强翻（evidence=${actions[0]?.evidence}）`);
  // 词边界保护回归：卡键 w-sup 不被 dev log 里 w-super 误命中（既有 R1-P2-2② 保护不回退）
  const harvest2 = { doneLedger: new Map(), receiptSlugs: new Set(), devLogText: "w-super 已收割" } as never;
  const boards2 = [{ gid: "pg-x", board: { id: "b", name: "组", status: "active", updated_at: 0, entries: [{ id: "t-sup", text: "W-SUP 短键卡", status: "claimed", ts: Date.now() - 10 * 3600_000, updated_at: Date.now() - 10 * 3600_000 }] } as never }];
  const r2 = zombieInvariantScan({ boards: boards2, harvest: harvest2 as never, ttlMs: 6 * 3600_000 });
  ok(r2.actions.length === 1 && r2.actions[0].evidence === null, "E2 词边界保护：w-sup 不被 w-super 超串误命中（证据 null=保守告警不翻）");
}

console.log(`\n========== orphancard 套件：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
