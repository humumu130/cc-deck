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
  computeReady, computeReadySet, addLesson, listLessons,
} from "../src/projects.js";

// 显式钉 json 档（SQLITE-FLIP 后缺省=sqlite，本件直测 projects.ts json 读写面 fixture——
// 缺省读空库全件语义崩；必须先于第一个读面调用，放护栏段已晚——前段坏状态会延续；
// 75-R 回归发现的漏网连带面，环境注入版 99/99 佐证钉档位置是唯一变量）
process.env.CCR_STORAGE_READ_MODE = "json";

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
const b1 = upsertBoardEntry(gid1, { text: "任务甲：改造入口", status: "backlog" }, dir);
assert(b1.ok && b1.entry.status === "backlog", "active 板可写");
const eid = b1.ok ? b1.entry.id : "";
const b2 = upsertBoardEntry(gid1, { id: eid, text: "任务甲：改造入口（改）", status: "claimed", owner_session: "sess-w1", dispatch_id: "dsp-1" }, dir);
assert(b2.ok && b2.entry.text.includes("改") && b2.entry.dispatch_id === "dsp-1", "upsert 更新同条目");
assert(loadBoard(gid1, dir).entries.length === 1, "仍 1 条（无重复）");
const mv = moveBoardEntry(gid1, eid, "done", dir);
assert(mv.ok && mv.entry.status === "done", "搬卡 done");
// 派单联动搬卡（收口失败语义：退回待办）
moveEntryByDispatch(gid1, "dsp-1", "backlog", dir);
assert(loadBoard(gid1, dir).entries[0]?.status === "backlog", "按台账 id 联动搬卡");
moveEntryByDispatch(gid1, "dsp-none", "done", dir); // 无对应条目 no-op
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
const ro = moveBoardEntry(gid1, eid, "backlog", dir);
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
upsertBoardEntry(gidC, { text: "未完", status: "claimed" }, dir2);
upsertBoardEntry(gidC, { text: "已完", status: "done" }, dir2);
addMember(gidC, "sess-w9", "worker", dir2);
const chk = buildArchiveChecklist(gidC, dir2);
assert(!!chk, "清单生成");
assert(chk?.openDispatches.length === 1 && chk?.openDispatches[0]?.id === "dsp-open", "悬账 = 该锚点未收口派单（其他锚点/已收口不算）");
assert(chk?.openBoardEntries === 1, "板未完成计数");
assert(chk?.headcount.length === 1, "在编成员入清单");
assert(buildArchiveChecklist("pg-none", dir2) === null, "组不存在 → null");
rmSync(dir2, { recursive: true, force: true });

// ---------- #087 beads 思想采纳（009 §4 M1/M2）：depends_on / ready / gate→blocked / lessons ----------
console.log("beads·依赖字段:");
const dirB = mkdtempSync(join(tmpdir(), "cc-deck-projects-beads-"));
const cb = createGroup({ name: "beads", anchor_dir: join(dirB, "a-beads"), tier: "轻立项" }, dirB);
const gidB = cb.ok ? cb.group.id : "";
decideConfirm(cb.ok && cb.confirm ? cb.confirm.id : "", true, "u", dirB);
setGroupStatus(gidB, "active", undefined, dirB);
assert(findGroup(gidB, dirB)?.status === "active", "beads 组就位 active（独立沙盒）");
// 依赖字段：写入+洗刷+落盘恢复+空数组清除
const depSrc = upsertBoardEntry(gidB, { text: "依赖源卡", status: "backlog" }, dirB);
const depId = depSrc.ok ? depSrc.entry.id : "";
const wDep = upsertBoardEntry(gidB, { text: "主卡", status: "backlog", depends_on: [depId, "", depId, "  "] }, dirB);
const wid = wDep.ok ? wDep.entry.id : "";
assert(wDep.ok && wDep.entry.depends_on?.length === 1 && wDep.entry.depends_on[0] === depId, "depends_on 落卡（空串洗刷+去重）");
assert(loadBoard(gidB, dirB).entries.find((x) => x.id === wid)?.depends_on?.length === 1, "depends_on 落盘恢复");
const wDepClr = upsertBoardEntry(gidB, { id: wid, text: "主卡", depends_on: [] }, dirB);
assert(wDepClr.ok && wDepClr.entry.depends_on === undefined, "空数组清除 depends_on（字段退场）");

console.log("beads·ready 就绪集:");
const freeCheck = computeReady({ id: "t-free" }, loadBoard(gidB, dirB));
assert(freeCheck.ready && freeCheck.reasons.length === 0 && freeCheck.gate_reason === null, "无依赖无 gate → ready（纯函数正面）");
upsertBoardEntry(gidB, { id: wid, text: "主卡", depends_on: [depId] }, dirB);
const blockCard = loadBoard(gidB, dirB).entries.find((x) => x.id === wid)!;
const rBlock = computeReady(blockCard, loadBoard(gidB, dirB));
assert(!rBlock.ready && rBlock.reasons.length === 1 && rBlock.reasons[0].includes(depId) && rBlock.reasons[0].includes("backlog"), "依赖 todo → not ready（原因含依赖 id+状态可判定）");
moveBoardEntry(gidB, depId, "done", dirB);
assert(computeReady(blockCard, loadBoard(gidB, dirB)).ready === true, "依赖 done → ready（全 done 放行）");
upsertBoardEntry(gidB, { id: wid, text: "主卡", depends_on: ["t-ghost"] }, dirB);
const ghostCard = loadBoard(gidB, dirB).entries.find((x) => x.id === wid)!;
const rGhost = computeReady(ghostCard, loadBoard(gidB, dirB));
assert(!rGhost.ready && rGhost.reasons[0]?.includes("t-ghost") && rGhost.reasons[0]?.includes("坏引用"), "坏引用按未就绪容错（不炸不静默放行）");
const set1 = computeReadySet(loadBoard(gidB, dirB));
assert(set1.length === 1 && set1[0].id === wid && set1[0].check.ready === false, "computeReadySet 过滤 done 只余未完成卡（bd ready 前沿思想）");

console.log("beads·gate→blocked:");
const wGate = upsertBoardEntry(gidB, { id: wid, text: "主卡", depends_on: [], gate: { reason: "等用户验收点确认" } }, dirB);
assert(wGate.ok && wGate.entry.gate?.reason === "等用户验收点确认" && typeof wGate.entry.gate.opened_at === "number", "gate 设闸落卡（reason+opened_at 自动补）");
const gateCard = loadBoard(gidB, dirB).entries.find((x) => x.id === wid)!;
const rGate = computeReady(gateCard, loadBoard(gidB, dirB));
assert(!rGate.ready && rGate.gate_reason === "等用户验收点确认", "gate 在场 → blocked 可判定（原因可查）");
const wGateClr = upsertBoardEntry(gidB, { id: wid, text: "主卡", gate: null }, dirB);
assert(wGateClr.ok && wGateClr.entry.gate === undefined, "gate 清除唯一口=人显式 upsert gate:null");
const clrCard = loadBoard(gidB, dirB).entries.find((x) => x.id === wid)!;
assert(computeReady(clrCard, loadBoard(gidB, dirB)).gate_reason === null, "清除后 gate_reason 归 null（清除动作是人做的，无自动放行）");
const wG2 = upsertBoardEntry(gidB, { text: "gate 卡", gate: { reason: "挂起等外部" } }, dirB);
const g2id = wG2.ok ? wG2.entry.id : "";
moveBoardEntry(gidB, g2id, "claimed", dirB);
const g2After = loadBoard(gidB, dirB).entries.find((x) => x.id === g2id)!;
assert(g2After.gate?.reason === "挂起等外部", "搬卡不动 gate（无自动关闭路径）");
assert(g2After.status === "claimed" && computeReady(g2After, loadBoard(gidB, dirB)).gate_reason === "挂起等外部", "doing 态 gate 卡仍 blocked（gate 独立于状态机，不自动放行）");

console.log("beads·lessons 回流:");
const l1 = addLesson(gidB, { text: "T17 教训：spawnSync env 必显式钉 CCR_TOKEN", tags: ["worker-G", "测试", "claude"], source_dispatch_id: "dsp-l1" }, dirB);
assert(l1.ok && l1.lesson.tags.length === 3 && l1.lesson.source_dispatch_id === "dsp-l1", "lessons 写入（tag+来源派单可回溯）");
addLesson(gidB, { text: "lessons 语义由 cc-deck 定义", tags: ["PM", "设计"] }, dirB);
addLesson(gidB, { text: "无 tag 经验也合法", tags: [] }, dirB);
assert(loadBoard(gidB, dirB).lessons?.length === 3, "lessons 落盘恢复（board 分区）");
// W-EXPP1 读侧退役（2026-10-10，设计 §8 P1 退役清单）：经验域已被团队经验库
//（relay/src/experience.ts）接管，listLessons 恒空（json/sqlite 同谓词）；写入面
// addLesson 保留（M12-4 收口自动账维持现状写旧域，D1-1），板文件数据原样冻结。
// 原「无 filter 全量/单 tag/多 tag AND」三断言随读侧退役作废——查询消费一律走
// experience.ts（listExperience/matchPredicate），见 scripts/test-experience.ts。
assert(listLessons(gidB, undefined, dirB).length === 0, "读侧退役：无 filter 恒空（W-EXPP1）");
assert(listLessons(gidB, { tags: ["测试"] }, dirB).length === 0, "读侧退役：带 tags 同谓词恒空（W-EXPP1）");
assert(listLessons(gidB, { tags: ["worker-G", "claude"] }, dirB).length === 0, "读侧退役：多 tag 同谓词恒空（W-EXPP1）");
assert(listLessons(gidB, { tags: ["不存在的tag"] }, dirB).length === 0, "无命中返回空（不炸）");
assert(!addLesson(gidB, { text: "   " }, dirB).ok, "空 text 拒写");
setGroupStatus(gidB, "parked", undefined, dirB);
assert(!addLesson(gidB, { text: "冻结期经验" }, dirB).ok, "冻结板 lessons 拒写（与卡同口径）");
setGroupStatus(gidB, "active", undefined, dirB);
rmSync(dirB, { recursive: true, force: true });

// ---------- M3 挂起自动化：findStaleGroups / markHoldSuggested ----------
console.log("挂起自动化（活度口径）:");
import { findStaleGroups, markHoldSuggested } from "../src/projects.js";
import { recordRoutingResult } from "../src/routing.js";
const DAY = 86_400_000;
const dir3 = mkdtempSync(join(tmpdir(), "cc-deck-projects3-"));
const now = 1_000_000_000_000;
const cs = createGroup({ name: "fresh", anchor_dir: join(dir3, "a-fresh"), tier: "轻立项" }, dir3);
const gidF = cs.ok ? cs.group.id : "";
decideConfirm(cs.ok && cs.confirm ? cs.confirm.id : "", true, "u", dir3);
setGroupStatus(gidF, "active", undefined, dir3);
assert(findStaleGroups(now, 14, dir3).length === 0, "新组（updated_at=now）不 stale");
assert(findStaleGroups(now, 0, dir3).length === 0, "staleDays=0 = 触发器关闭");
// 手工把组龄拨老：直接改索引文件（updated_at 无 setter，写文件最省口径）
const pfile = JSON.parse(readFileSync(join(dir3, "projects.json"), "utf-8")) as { groups: { id: string; updated_at: number }[] };
pfile.groups.find((x) => x.id === gidF)!.updated_at = now - 20 * DAY;
writeFileSync(join(dir3, "projects.json"), JSON.stringify(pfile), "utf-8");
const st1 = findStaleGroups(now, 14, dir3);
assert(st1.length === 1 && st1[0].gid === gidF && st1[0].idleDays >= 20, "20 天无活动 → stale（idleDays 写实）");
// 板活动刷新活度：upsert 后不再 stale
upsertBoardEntry(gidF, { text: "动了一下", status: "backlog" }, dir3);
assert(findStaleGroups(now, 14, dir3).length === 0, "板更新刷新活度");
// 台账活动
const p2 = JSON.parse(readFileSync(join(dir3, "projects.json"), "utf-8")) as { groups: { id: string; updated_at: number }[]; boards?: unknown };
p2.groups.find((x) => x.id === gidF)!.updated_at = now - 20 * DAY;
writeFileSync(join(dir3, "projects.json"), JSON.stringify(p2), "utf-8");
const bfile = JSON.parse(readFileSync(join(dir3, "boards", `${gidF}.json`), "utf-8")) as { updated_at: number };
bfile.updated_at = now - 20 * DAY;
writeFileSync(join(dir3, "boards", `${gidF}.json`), JSON.stringify(bfile), "utf-8");
assert(findStaleGroups(now, 14, dir3).length === 1, "组+板都老 → stale");
// 台账活动：给另一组挂 3 天前的收口行（gidF 的台账保持空，隔离验证）
const co = createGroup({ name: "other", anchor_dir: join(dir3, "a-other"), tier: "轻立项" }, dir3);
const gidO = co.ok ? co.group.id : "";
decideConfirm(co.ok && co.confirm ? co.confirm.id : "", true, "u", dir3);
setGroupStatus(gidO, "active", undefined, dir3);
const pO = JSON.parse(readFileSync(join(dir3, "projects.json"), "utf-8")) as { groups: { id: string; updated_at: number }[] };
pO.groups.find((x) => x.id === gidO)!.updated_at = now - 20 * DAY;
writeFileSync(join(dir3, "projects.json"), JSON.stringify(pO), "utf-8");
appendDispatch({ ts: now - 3 * DAY, id: "dsp-recent", tier: "随手办", target: "w", project_anchor: join(dir3, "a-other"), status: "done", session_id: "w" }, dir3);
assert(findStaleGroups(now, 14, dir3).some((x) => x.gid === gidF) && !findStaleGroups(now, 14, dir3).some((x) => x.gid === gidO), "3 天前的台账活动刷新活度（他组隔离）");
// 路由表活动（熟手最近收工也算活度）
recordRoutingResult(gidF, "w", "done", "最近收工", dir3);
assert(findStaleGroups(now, 14, dir3).length === 0, "路由表 last_ts 刷新活度（熟手最近收工）");
// 成员会话活动（M3 审查修正第五路）：用户直驱推进不动台账/板/组，成员 updated_at 兜
const cm = createGroup({ name: "memberdrive", anchor_dir: join(dir3, "a-md"), tier: "轻立项" }, dir3);
const gidM = cm.ok ? cm.group.id : "";
decideConfirm(cm.ok && cm.confirm ? cm.confirm.id : "", true, "u", dir3);
setGroupStatus(gidM, "active", undefined, dir3);
const pM = JSON.parse(readFileSync(join(dir3, "projects.json"), "utf-8")) as { groups: { id: string; updated_at: number }[] };
pM.groups.find((x) => x.id === gidM)!.updated_at = now - 20 * DAY;
writeFileSync(join(dir3, "projects.json"), JSON.stringify(pM), "utf-8");
assert(findStaleGroups(now, 14, dir3).some((x) => x.gid === gidM), "组静默 20 天 → stale（无成员信号基线）");
assert(!findStaleGroups(now, 14, dir3, { [gidM]: now - 1 * DAY }).some((x) => x.gid === gidM), "成员会话昨天还在动 → 不 stale（直驱开发不算闲置）");
assert(findStaleGroups(now, 14, dir3, { [gidM]: now - 30 * DAY }).some((x) => x.gid === gidM), "成员信号也老 → stale");
assert(findStaleGroups(now, 14, dir3, { "no-such-gid": now }).some((x) => x.gid === gidM), "他组成员信号不串组（gidM 仍 stale，键隔离）");
setGroupStatus(gidM, "parked", undefined, dir3); // 收编：不污染后续全量计数断言
// parked/archived 不进扫描
setGroupStatus(gidF, "parked", undefined, dir3);
assert(findStaleGroups(now, 14, dir3).length === 0, "非 active 不扫描");
setGroupStatus(gidF, "active", undefined, dir3);
// 冷却戳：markHoldSuggested 不动 updated_at（建议不是活动）
const before = JSON.parse(readFileSync(join(dir3, "projects.json"), "utf-8")) as { groups: { id: string; updated_at: number; hold_suggested_at?: number }[] };
const updBefore = before.groups.find((x) => x.id === gidF)!.updated_at;
markHoldSuggested(gidF, now - 1 * DAY, dir3);
const after = JSON.parse(readFileSync(join(dir3, "projects.json"), "utf-8")) as { groups: { id: string; updated_at: number; hold_suggested_at?: number }[] };
assert(after.groups.find((x) => x.id === gidF)!.hold_suggested_at === now - 1 * DAY, "冷却戳落盘");
assert(after.groups.find((x) => x.id === gidF)!.updated_at === updBefore, "戳记不动 updated_at（不自我续命）");
rmSync(dir3, { recursive: true, force: true });

// ---------- 收尾 ----------
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
