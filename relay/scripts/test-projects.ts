// #26 矩阵式 M2 —— projects.ts 单元测试：项目组索引/三态状态机/护栏/信任累积/任务板冻结/
// 确认单决议/防漂移种子/结项核对清单
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatch } from "../src/org.js";
import {
  listGroups, listGroupsByStatus, findGroup, findGroupByAnchor, maxActiveGroups,
  createGroup, setGroupStatus, setGroupTier, canTransition, addMember, removeMember,
  loadBoard, upsertBoardEntry, moveBoardEntry, removeBoardEntry, moveEntryByDispatch,
  listConfirms, listPendingConfirms, addConfirm, decideConfirm,
  ensureProjectClaudeMd, buildArchiveChecklist, setLightConfirmTrusted, isLightConfirmTrusted,
} from "../src/projects.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), "cc-deck-projects-"));

// ---------- 索引空态与坏 JSON 容忍 ----------
console.log("索引:");
assert(listGroups(dir).length === 0, "无文件 → 空列表");
writeFileSync(join(dir, "projects.json"), "{not json", "utf-8");
assert(listGroups(dir).length === 0, "坏 JSON → 空列表（读侧防御）");
assert(isLightConfirmTrusted(dir) === false, "初始信任未建立");

// ---------- 立项：确认门槛与信任累积 ----------
console.log("立项（确认门槛）:");
const anchor1 = join(dir, "proj-alpha");
const c1 = createGroup({ name: "alpha", anchor_dir: anchor1, tier: "轻立项" }, dir);
assert(c1.ok && c1.needsConfirm && c1.group.status === "pending", "轻立项首走 pending（首次确认一次）");
assert(c1.ok && !!c1.confirm && c1.confirm.kind === "project-create", "附 project-create 确认单");
const gid1 = c1.ok ? c1.group.id : "";
assert(findGroup(gid1, dir)?.status === "pending", "按 id 查到");
assert(findGroup("alpha", dir)?.id === gid1, "按名查到");

const c2 = createGroup({ name: "beta", anchor_dir: join(dir, "proj-beta"), tier: "正经立项" }, dir);
assert(c2.ok && c2.needsConfirm && c2.group.status === "pending", "正经立项必 pending（必须确认）");
assert(c2.ok && c2.group.single_card === false, "正经立项非单卡态");
const gid2 = c2.ok ? c2.group.id : "";

// 锚点占用（pending 也占锚——防同锚双组）
const cClash = createGroup({ name: "alpha2", anchor_dir: anchor1, tier: "轻立项" }, dir);
assert(!cClash.ok, "锚点被占拒绝（一锚一组）");

// 确认决议：approve alpha → active + 信任累积 → 下次轻立项免确认
const cf1 = c1.ok && c1.confirm ? c1.confirm.id : "";
const d1 = decideConfirm(cf1, true, "test-user", dir);
assert(d1.ok && d1.confirm.status === "approved", "决议 approve");
setGroupStatus(gid1, "active", undefined, dir);
assert(findGroup(gid1, dir)?.status === "active", "alpha → active");
setLightConfirmTrusted(true, dir);
assert(isLightConfirmTrusted(dir) === true, "信任已累积");
const c3 = createGroup({ name: "gamma", anchor_dir: join(dir, "proj-gamma"), tier: "轻立项" }, dir);
assert(c3.ok && !c3.needsConfirm && c3.group.status === "active", "信任后轻立项直达 active（同类免确认）");
const gid3 = c3.ok ? c3.group.id : "";
assert(c3.ok && c3.group.single_card === true, "轻立项单卡态标记");
// 正经立项在信任累积后仍必须确认
const c4 = createGroup({ name: "delta", anchor_dir: join(dir, "proj-delta"), tier: "正经立项" }, dir);
assert(c4.ok && c4.needsConfirm, "正经立项不受轻立项信任影响（每次必确认）");
// 否决：pending → archived 留痕
const cf4 = c4.ok && c4.confirm ? c4.confirm.id : "";
decideConfirm(cf4, false, "test-user", dir);
const rej = setGroupStatus(gid4of(c4), "archived", "立项确认被否决", dir);
assert(rej.ok && rej.group.archive_note === "立项确认被否决", "否决 → archived 留痕");
function gid4of(r: typeof c4): string { return r.ok ? r.group.id : ""; }

// ---------- 状态机 ----------
console.log("三态状态机:");
assert(canTransition("active", "parked") && canTransition("parked", "active"), "在办⇄挂起双向");
assert(canTransition("active", "archived") && canTransition("parked", "archived"), "在办/挂起→结项");
assert(canTransition("archived", "active"), "复活边 archived→active");
assert(!canTransition("archived", "parked"), "结项是单向终态（无 archived→parked）");
const bad = setGroupStatus(gid1, "archived", undefined, dir);
assert(bad.ok && bad.group.status === "archived", "active→archived 合法");
const bad2 = setGroupStatus(gid1, "parked", undefined, dir);
assert(!bad2.ok, "archived→parked 非法拒绝");
const revive = setGroupStatus(gid1, "active", undefined, dir);
assert(revive.ok && revive.group.status === "active", "复活边重建在办");

// ---------- 护栏 ----------
console.log("护栏:");
const savedMax = process.env.CCR_ORG_MAX_GROUPS;
process.env.CCR_ORG_MAX_GROUPS = "2";
// 当前 active：alpha(gid1)、gamma(gid3) —— 上限 2，第三个拒绝
const c5 = createGroup({ name: "epsilon", anchor_dir: join(dir, "proj-epsilon"), tier: "轻立项" }, dir);
assert(!c5.ok, "超并行上限拒绝");
// parked 释放名额
setGroupStatus(gid3, "parked", undefined, dir);
const c6 = createGroup({ name: "epsilon", anchor_dir: join(dir, "proj-epsilon"), tier: "轻立项" }, dir);
assert(c6.ok, "挂起释放名额后可立项");
const gid6 = c6.ok ? c6.group.id : "";
// 复活也吃护栏：alpha parked 后 epsilon active，gamma parked——复活 gamma 前 active=alpha?:
// 状态梳理：alpha active、beta pending（不占 active 名额）、gamma parked、epsilon active
const r2 = setGroupStatus(gid6, "parked", undefined, dir);
const rv = setGroupStatus(gid3, "active", undefined, dir);
assert(rv.ok, "复活在名额内放行");
setGroupStatus(gid3, "parked", undefined, dir);
setGroupStatus(gid6, "active", undefined, dir);
process.env.CCR_ORG_MAX_GROUPS = savedMax;
assert(maxActiveGroups() === 5, "护栏默认 5（env 清除回落）");

// ---------- 升降级 ----------
console.log("升降级:");
const up = setGroupTier(gid1, "正经立项", dir);
assert(up.ok && up.group.tier === "正经立项" && up.group.single_card === false, "轻→正（单卡标记摘除）");
const down = setGroupTier(gid1, "轻立项", dir);
assert(down.ok && down.group.single_card === true, "正→轻（单卡标记恢复）");

// ---------- 编制快照 ----------
console.log("编制:");
const am = addMember(gid1, "sess-w1", "worker", dir);
assert(am.ok && am.group.headcount.length === 1, "加成员");
addMember(gid1, "sess-w1", "worker", dir);
assert(findGroup(gid1, dir)?.headcount.length === 1, "同会话去重");
const rm2 = removeMember(gid1, "sess-w1", dir);
assert(rm2.ok && rm2.group.headcount.length === 0, "移除成员");

// ---------- 任务板 ----------
console.log("任务板:");
const b1 = upsertBoardEntry(gid1, { text: "任务甲：改造入口", status: "todo" }, dir);
assert(b1.ok && b1.entry.status === "todo", "active 板可写");
const eid = b1.ok ? b1.entry.id : "";
const b2 = upsertBoardEntry(gid1, { id: eid, text: "任务甲：改造入口（改）", status: "doing", owner_session: "sess-w1", dispatch_id: "dsp-1" }, dir);
assert(b2.ok && b2.entry.text.includes("改") && b2.entry.dispatch_id === "dsp-1", "upsert 更新同条目");
assert(loadBoard(gid1, dir).entries.length === 1, "仍 1 条（无重复）");
const mv = moveBoardEntry(gid1, eid, "verify", dir);
assert(mv.ok && mv.entry.status === "verify", "搬卡 verify");
// 派单联动搬卡
moveEntryByDispatch(gid1, "dsp-1", "done", dir);
assert(loadBoard(gid1, dir).entries[0]?.status === "done", "按台账 id 联动搬卡");
moveEntryByDispatch(gid1, "dsp-none", "todo", dir); // 无对应条目 no-op
assert(loadBoard(gid1, dir).entries.length === 1, "联动 no-op 不炸");
// 冻结：parked 拒写
setGroupStatus(gid1, "parked", undefined, dir);
const frozen = upsertBoardEntry(gid1, { text: "冻结期写入" }, dir);
assert(!frozen.ok, "挂起板冻结拒写");
assert(loadBoard(gid1, dir).frozen === true, "frozen 标记落盘");
setGroupStatus(gid1, "active", undefined, dir);
const thawed = upsertBoardEntry(gid1, { text: "恢复后写入" }, dir);
assert(thawed.ok, "恢复在办后可写");
// 结项只读
setGroupStatus(gid1, "archived", "零异常一句话归档", dir);
const ro = moveBoardEntry(gid1, eid, "todo", dir);
assert(!ro.ok, "结项板只读");
// 条目删除
setGroupStatus(gid1, "active", undefined, dir);
const del = removeBoardEntry(gid1, eid, dir);
assert(del.ok, "删除条目");
const del2 = removeBoardEntry(gid1, eid, dir);
assert(!del2.ok, "再删报不存在");
// 不存在的组
const nog = upsertBoardEntry("pg-nope", { text: "x" }, dir);
assert(!nog.ok, "组不存在拒写");

// ---------- 确认单 ----------
console.log("确认单:");
const pend0 = listPendingConfirms(dir).length;
const cfA = addConfirm({ kind: "tier-change", title: "升级：alpha", reason: "范围扩大", payload: { gid: gid1, to_tier: "正经立项" } }, dir);
assert(listPendingConfirms(dir).length === pend0 + 1, "新增 pending");
const dd1 = decideConfirm(cfA.id, true, "u", dir);
assert(dd1.ok && dd1.confirm.status === "approved" && dd1.confirm.decided_by === "u", "决议记录 decided_by");
const dd2 = decideConfirm(cfA.id, false, "u", dir);
assert(!dd2.ok, "已决不可再决");
const cfB = addConfirm({ kind: "suggest-hold", title: "建议暂缓", reason: "依赖未就绪" }, dir);
const dd3 = decideConfirm("cf-not-exist", true, "u", dir);
assert(!dd3.ok, "不存在拒绝");
decideConfirm(cfB.id, false, "u", dir);
assert(listConfirms(dir).filter((c) => c.id === cfB.id)[0]?.status === "rejected", "rejected 留痕");
assert(listPendingConfirms(dir).length === pend0, "pending 归零");

// ---------- 防漂移种子 ----------
console.log("防漂移种子:");
const anchorNew = join(dir, "proj-seed");
assert(ensureProjectClaudeMd(anchorNew, "seed 项目") === "created", "首建 → created");
assert(readFileSync(join(anchorNew, "CLAUDE.md"), "utf-8").includes("改一字亦须报"), "种子含防漂移条款");
assert(ensureProjectClaudeMd(anchorNew, "seed 项目") === "exists", "幂等 exists");
writeFileSync(join(anchorNew, "CLAUDE.md"), "# 用户已有内容", "utf-8");
assert(ensureProjectClaudeMd(anchorNew, "seed 项目") === "exists", "已有内容不覆盖");
assert(readFileSync(join(anchorNew, "CLAUDE.md"), "utf-8") === "# 用户已有内容", "内容原样");

// ---------- 结项核对清单 ----------
console.log("结项核对清单:");
const dir2 = mkdtempSync(join(tmpdir(), "cc-deck-projects-"));
mkdirSync(join(dir2, "boards"), { recursive: true });
const cg = createGroup({ name: "chk", anchor_dir: join(dir2, "anchor-chk"), tier: "轻立项" }, dir2);
const gidC = cg.ok ? cg.group.id : "";
decideConfirm(cg.ok && cg.confirm ? cg.confirm.id : "", true, "u", dir2);
setGroupStatus(gidC, "active", undefined, dir2);
appendDispatch({ ts: 1, id: "dsp-open", tier: "随手办", target: "sess-w9", project_anchor: join(dir2, "anchor-chk"), status: "running", session_id: "s-w9" }, dir2);
appendDispatch({ ts: 2, id: "dsp-closed", tier: "随手办", target: "sess-w9", project_anchor: join(dir2, "anchor-chk"), status: "done", session_id: "s-w9" }, dir2);
appendDispatch({ ts: 3, id: "dsp-other", tier: "咨询", target: "org-leader", status: "running", session_id: "s-l" }, dir2);
upsertBoardEntry(gidC, { text: "未完", status: "doing" }, dir2);
upsertBoardEntry(gidC, { text: "已完", status: "done" }, dir2);
addMember(gidC, "sess-w9", "worker", dir2);
const chk = buildArchiveChecklist(gidC, dir2);
assert(!!chk, "清单生成");
assert(chk?.openDispatches.length === 1 && chk?.openDispatches[0]?.id === "dsp-open", "悬账 = 该锚点未收口派单（其他锚点/已收口不算）");
assert(chk?.openBoardEntries === 1, "板未完成计数");
assert(chk?.headcount.length === 1, "在编成员入清单");
assert(buildArchiveChecklist("pg-none", dir2) === null, "组不存在 → null");
rmSync(dir2, { recursive: true, force: true });

// ---------- 收尾 ----------
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
