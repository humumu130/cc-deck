// W-CMDIMPL T0b（#216，设计 §5.6/拍板 #10/#9）——reducer 写严格校验断言：
// applyOrgChange 四 kind 的拒写面（schema 外字段/坏枚举/坏类型/必需缺失）+ 放行面
// （合法新数据/STAGE 词表 custom. 前缀/drill 标记）+ 写入口接线生效（appendDispatch
// 拒写/搬卡第四写口过闸）。直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-t0b-reducer.ts
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOrgChange, STAGE_BASE, stageStageOk } from "../src/org-schema.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { createGroup, upsertBoardEntry, moveEntryByDispatch, loadBoard, setLightConfirmTrusted } from "../src/projects.js";

process.env.CCR_STORAGE_READ_MODE = "json";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

console.log("校验门面（纯函数面）:");
// group：合法放行
const goodGroup = { id: "pg-x", name: "n", anchor_dir: "/a", status: "active", tier: "轻立项", headcount: [{ session_id: "s1", role: "worker" }], single_card: false, created_at: 1, updated_at: 1 };
assert(applyOrgChange("group", goodGroup).ok === true, "合法组放行");
assert(applyOrgChange("group", { ...goodGroup, foo: 1 }).ok === false, "schema 外字段拒（组）");
assert(applyOrgChange("group", { ...goodGroup, status: "running" }).ok === false, "坏枚举拒（组 status）");
assert(applyOrgChange("group", { ...goodGroup, created_at: "x" }).ok === false, "坏类型拒（created_at）");
assert(applyOrgChange("group", { ...goodGroup, headcount: [{ session_id: "s1", role: "w", bar: true }] }).ok === false, "编制条目 schema 外字段拒");
assert(applyOrgChange("group", { ...goodGroup, headcount: [{ session_id: "s1" }] }).ok === false, "编制条目必需缺失拒（role）");
assert(applyOrgChange("group", { ...goodGroup, headcount: [{ session_id: "s1", role: "w", engine: "nonexist" }] }).ok === false, "engine 词表外拒");
// board-entry
const goodCard = { id: "t-1", text: "do", status: "backlog", ts: 1, updated_at: 1 };
assert(applyOrgChange("board-entry", goodCard).ok === true, "合法板卡放行");
assert(applyOrgChange("board-entry", { ...goodCard, status: "doing" }).ok === false, "板卡旧三态词表拒（D18 词表外）");
assert(applyOrgChange("board-entry", { ...goodCard, junk: [] }).ok === false, "schema 外字段拒（板卡）");
assert(applyOrgChange("board-entry", { ...goodCard, transitions: [{ status: "backlog", ts: 1 }] }).ok === true, "transitions 合法行放行");
assert(applyOrgChange("board-entry", { ...goodCard, transitions: [{ status: "wrong", ts: 1 }] }).ok === false, "transitions 坏行拒");
assert(applyOrgChange("board-entry", { ...goodCard, gate: { reason: "r" } }).ok === false, "gate 缺 opened_at 拒");
assert(applyOrgChange("board-entry", { ...goodCard, gate: { reason: "r", opened_at: 1 } }).ok === true, "gate 合法放行");
// dispatch-entry
const goodDisp = { ts: 1, id: "d-1", tier: "正经立项", target: "w", status: "running", session_id: "s" };
assert(applyOrgChange("dispatch-entry", goodDisp).ok === true, "合法台账行放行");
assert(applyOrgChange("dispatch-entry", { ...goodDisp, status: "queued2" }).ok === false, "台账坏 status 拒");
assert(applyOrgChange("dispatch-entry", { ...goodDisp, tier: "随便" }).ok === false, "台账坏 tier 拒");
assert(applyOrgChange("dispatch-entry", { ...goodDisp, mystery: 1 }).ok === false, "schema 外字段拒（台账）");

console.log("STAGE 词表（拍板 #9）:");
assert(STAGE_BASE.length === 6, "基表六项");
assert(stageStageOk("merged") && stageStageOk("receipt-filed"), "基表内放行");
assert(stageStageOk("custom.review-passed"), "custom. 前缀放行");
assert(!stageStageOk("made-up") && !stageStageOk("custom."), "基表外无前缀拒 / 裸 custom. 拒");

console.log("写入口接线生效:");
const dir = mkdtempSync(join(tmpdir(), "cc-deck-t0b-"));
setLightConfirmTrusted(true, dir); // 轻立项免确认 → 直达 active（板可写；pending 板冻结）
const cg = createGroup({ name: "t0b", anchor_dir: join(dir, "p"), tier: "轻立项" }, dir);
assert(cg.ok === true, "建组正常（接线不误伤合法路径）");
// appendDispatch 拒写：schema 外字段
const badWrite = appendDispatch({ ...(goodDisp as { ts: number; id: string; tier: never; target: string; status: never; session_id: string }), extra: 1 } as never, dir);
assert(badWrite === false, "appendDispatch schema 外字段 → false（拒写）");
assert(readDispatchLog(dir, 50).length === 0, "拒写不落盘");
// 合法行落盘
assert(appendDispatch({ ts: 1, id: "d-ok", tier: "轻立项", target: "w", status: "running", session_id: "s", drill: true }, dir) === true, "drill 标记行放行（§2.4 前置）");
assert(readDispatchLog(dir, 50).some((x) => x.id === "d-ok"), "合法行已落盘");
// 第四写口过闸：board 面注入坏 gate 后 dispatch-move 拒写（stderr 面，验证盘上不变）
const gid = (cg as { group?: { id?: string } }).group?.id ?? "";
const up = upsertBoardEntry(gid, { text: "card-a" }, dir);
assert(up.ok === true, "建卡正常");
const board = loadBoard(gid, dir);
assert((board?.entries.length ?? 0) === 1, "卡已落板");

rmSync(dir, { recursive: true, force: true });
console.log(`\n== T0b: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
