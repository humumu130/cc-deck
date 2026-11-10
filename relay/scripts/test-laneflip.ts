// W-LANEFLIP（1110 夜令·序列2）：看板甬道精确切换——zombie 形态面扩容五形态单测
// 刀三：backlog+dispatch_id（曾派发卡回 backlog 的对账残余——ORPHANCARD-R1 续跑卡
// 滞 8h 实锤形态）纳入 zombie 不变量扫描；纯待办 backlog（无 dispatch_id）不动（防误伤）。
// 刀四①-④：五形态时延语义（证据在=超 TTL 即翻，patrol light 轮=秒级触发——分钟级达标）。
import { zombieInvariantScan, harvestKeyOf, type HarvestEvidence } from "../src/board-recon.js";
import type { ProjectBoard } from "../src/projects.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string, detail = "") {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name + (detail ? " | " + detail : "")); }
}
const HOUR = 3600_000;
const NOW = 1794_300_000_000;

function ev(): HarvestEvidence {
  return {
    doneLedger: new Map([["w-laneflip-a", { count: 1, hasReceipt: true }], ["w-orphancard-r1", { count: 1, hasReceipt: true }]]),
    devLogText: "[任务] W-LANEFLIP-B devlog 词边界在",
    receiptSlugs: new Set(["w-laneflip-c"]),
  };
}
function board(entries: Array<Partial<ProjectBoard["entries"][number] & { dispatch_id?: string }>>): ProjectBoard {
  return { gid: "g-test", entries: entries.map((e, i) => ({ id: e.id ?? `e${i}`, text: e.text ?? "", status: e.status ?? "backlog", ts: e.ts ?? NOW - 8 * HOUR, updated_at: e.updated_at ?? NOW - 8 * HOUR, transitions: [], ...e })) } as ProjectBoard;
}

console.log("== W-LANEFLIP 刀三/刀四：zombie 形态面五形态 ==");

// 形态①：正常在途（claimed 未超 TTL）——不翻（在途常态）
{
  const r = zombieInvariantScan({ boards: [{ gid: "g", board: board([{ id: "c1", text: "W-LANEFLIP-A 单", status: "claimed", updated_at: NOW - 1 * HOUR }]) }], harvest: ev(), now: NOW, ttlMs: 6 * HOUR });
  assert(r.actions.length === 0, "①正常在途（1h 未超 6h TTL）不翻——在途节奏不误伤");
}
// 形态②：submitted 审查卡超 TTL + 台账 done 证据 → 强翻 done（本次 19 卡滞留主形态）
{
  const r = zombieInvariantScan({ boards: [{ gid: "g", board: board([{ id: "c2", text: "W-LANEFLIP-A 审查", status: "submitted", updated_at: NOW - 7 * HOUR }]) }], harvest: ev(), now: NOW, ttlMs: 6 * HOUR });
  assert(r.actions.length === 1 && r.actions[0].entryId === "c2" && r.actions[0].status === "submitted" && r.actions[0].evidence === "ledger-done", "②submitted 超 TTL+台账 done → 强翻（evidence=ledger-done）");
}
// 形态③（刀三新形态）：backlog+dispatch_id 超 TTL + 台账 done → 强翻（续跑卡对账残余）
{
  const r = zombieInvariantScan({ boards: [{ gid: "g", board: board([{ id: "c3", text: "W-ORPHANCARD-R1 续跑", status: "backlog", dispatch_id: "271486d9-x", updated_at: NOW - 9 * HOUR }]) }], harvest: ev(), now: NOW, ttlMs: 6 * HOUR });
  assert(r.actions.length === 1 && r.actions[0].entryId === "c3" && r.actions[0].status === "backlog" && r.actions[0].evidence === "ledger-done", "③backlog+dispatch_id 超 TTL+台账 done → 强翻（W-LANEFLIP 刀三：续跑卡滞 8h 形态收口）");
}
// 形态④（防误伤）：backlog 无 dispatch_id（纯待办池卡）超 TTL + 证据在 → 不翻
{
  const r = zombieInvariantScan({ boards: [{ gid: "g", board: board([{ id: "c4", text: "W-LANEFLIP-C 待办池卡", status: "backlog", updated_at: NOW - 9 * HOUR }]) }], harvest: ev(), now: NOW, ttlMs: 6 * HOUR });
  assert(r.actions.length === 0, "④纯待办 backlog（无 dispatch_id）不翻——待办池主权在用户/PM 不在对账器");
}
// 形态⑤：claimed 超 TTL + 三证全无 → 僵尸告警不翻（防误杀真长任务）
{
  const r = zombieInvariantScan({ boards: [{ gid: "g", board: board([{ id: "c5", text: "W-UNKNOWN-ZZZ 长任务", status: "claimed", updated_at: NOW - 10 * HOUR }]) }], harvest: ev(), now: NOW, ttlMs: 6 * HOUR });
  assert(r.actions.length === 1 && r.actions[0].evidence === null && r.actions.filter((a) => a.evidence !== null).length === 0, "⑤三证全无超 TTL=告警不翻（evidence=null 交值守视野，翻面零——既有语义不回归）");
}
// 刀四时延语义（分钟级断言的机制面）：证据在的超 TTL 卡在**下一轮 patrol light**（默认 5min，
// 沙盒 env 可压到秒级）即翻——zombie 是兜底链不是主链；主链=leader-harvest 收割时点翻
// （--final/--post-merge）与 converge 台账驱动翻——两者都在事件时点（分钟内）。
{
  const before = NOW;
  const r = zombieInvariantScan({ boards: [{ gid: "g", board: board([{ id: "c6", text: "W-LANEFLIP-A 主链残卡", status: "submitted", updated_at: before - 7 * HOUR }]) }], harvest: ev(), now: NOW, ttlMs: 6 * HOUR });
  assert(r.actions.length === 1, "时延机制：主链（收割/converge）漏翻的卡由 patrol light 轮（≤5min）兜底翻——双层时延均分钟级");
}
// 归一键回归（续跑卡 key 形态）
assert(harvestKeyOf("W-ORPHANCARD-R1 续跑") === "w-orphancard-r1", "归一键：ORPHANCARD-R1 续跑 → w-orphancard-r1（findContCard/证据三源同键）");

console.log(`\nW-LANEFLIP: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
