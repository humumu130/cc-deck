// [W-RETIRED] 退休成员会话名单（用户 1029 反馈根治）——判定分支/瞬态帧/purge/幂等。
// 判定单源 retiredMemberSids()：非 archived 组路由在册而编制外=退休；在任一非
// archived 组编制（active+parked）=现役。纯读 projects+routing 两本账（重启可重建）。
// 覆盖：
//   R1 在编现役不进名单（active 组 headcount+routing 齐）
//   R2 member-retire 主链（orgAction 无卡清扫路径）→ 名单命中 + 瞬态帧
//   R3 复拉（addMember 直调）→ 名单移除 + 复活帧
//   R4 parked 组编制快照=现役（org_parked 归组展示语义保持，不隐藏）
//   R5 archived 组路由不计（结项编制快照成员行为不变）
//   R6 跨组正交：他组除名痕迹仍命中（A 在 g2 路由在册无编制）
//   R7 retired-purge：名单内卡物理删除（deleteSession 链）+ 档案保留
//   R8 帧幂等：名单不变零帧（emitOrgState delta 检测）
//   R9 purge 后无卡名单稳定（名单=档案判定，卡片删除断链）
// 直跑：cd relay && npm run test:retired-sessions
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus, type Envelope } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { createGroup, addMember, removeMember, setGroupStatus, listGroups } from "../src/projects.js";
import { recordRoutingResult } from "../src/routing.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name); }
}

// ---- 沙盒（test-alive 同配方：CCR_ORG_DIR/CCR_DATA_DIR 隔离，不碰生产账本） ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-retired-org/", "../data/test-retired-data/", "../data/test-retired-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-retired-org/");
process.env.CCR_DATA_DIR = SB("../data/test-retired-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-retired-projects/");
process.env.CCR_SESSIONS_ROOT = SB("../data/test-retired-projects/sessions/");
mkdirSync(process.env.CCR_SESSIONS_ROOT, { recursive: true });
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";

const cfg = loadConfig();
cfg.token = "t";
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);

// 瞬态帧捕获（RETIRED_SESSIONS_UPDATED）
const frames: { ids: string[] }[] = [];
bus.subscribe((env: Envelope) => {
  if (env.type === "RETIRED_SESSIONS_UPDATED") {
    frames.push((env.payload as { retired_session_ids?: string[] }).retired_session_ids ?? []);
  }
});

// ---- 夹具 ----
const mkGroup = (name: string, anchor: string) => {
  const r = createGroup({ name, anchor_dir: anchor, tier: "轻立项" });
  if (!r.ok) throw new Error("建组失败: " + r.error);
  // 轻立项首次走 pending 确认——直接置 active（确认单链不在本测面）
  const g0 = r.group;
  if (g0.status === "pending") {
    const a = setGroupStatus(g0.id, "active");
    if (!a.ok) throw new Error("激活失败: " + a.error);
    return a.group;
  }
  return g0;
};

console.log("R1 在编现役:");
{
  const g1 = mkGroup("g-one", "/tmp/anchor-r1");
  addMember(g1.id, "sess-A", "worker");
  recordRoutingResult(g1.id, "sess-A", "done", "第一批活干完");
  ok(!mgr.retiredMemberSids().includes("sess-A"), "active 组在编+路由在册 → 现役不进名单");
  ok(mgr.retiredMemberSids().length === 0, "名单空（无退休）");
}

console.log("R2 member-retire 主链:");
{
  const g1 = mkGroup("g-two", "/tmp/anchor-r2");
  addMember(g1.id, "sess-B", "worker");
  recordRoutingResult(g1.id, "sess-B", "done", "干活");
  ok(!mgr.retiredMemberSids().includes("sess-B"), "退休前现役");
  const r = mgr.orgAction("member-retire", { gid: g1.id, sid: "sess-B" });
  ok(r.ok === true, "orgAction member-retire（无卡清扫路径）ok");
  ok(mgr.retiredMemberSids().includes("sess-B"), "除名后名单命中（路由在册+编制外）");
  ok(frames.length >= 1 && frames[frames.length - 1].includes("sess-B"), "瞬态帧 RETIRED_SESSIONS_UPDATED 广播且含 sid");
}

console.log("R3 复拉复活:");
{
  const g1 = mkGroup("g-three", "/tmp/anchor-r3");
  addMember(g1.id, "sess-C", "worker");
  recordRoutingResult(g1.id, "sess-C", "done", "干活");
  removeMember(g1.id, "sess-C");
  ok(mgr.retiredMemberSids().includes("sess-C"), "除名后进名单");
  const back = addMember(g1.id, "sess-C", "worker");
  ok(back.ok, "addMember 复拉入编 ok");
  ok(!mgr.retiredMemberSids().includes("sess-C"), "复拉后名单移除（现役复活）");
}

console.log("R4 parked 组口径:");
{
  const g2 = mkGroup("g-park", "/tmp/anchor-r4");
  addMember(g2.id, "sess-D", "worker");
  recordRoutingResult(g2.id, "sess-D", "done", "干活");
  const p = setGroupStatus(g2.id, "parked");
  ok(p.ok && p.group.status === "parked", "组挂起 ok");
  ok(!mgr.retiredMemberSids().includes("sess-D"), "parked 组编制快照=现役（归组展示语义保持，不隐藏）");
}

console.log("R5 archived 组:");
{
  const g3 = mkGroup("g-arch", "/tmp/anchor-r5");
  addMember(g3.id, "sess-E", "worker");
  recordRoutingResult(g3.id, "sess-E", "done", "干活");
  const a = setGroupStatus(g3.id, "archived");
  ok(a.ok, "组结项 ok");
  ok(!mgr.retiredMemberSids().includes("sess-E"), "archived 组路由不计（结项成员行为不变）");
}

console.log("R6 跨组正交:");
{
  const g4 = mkGroup("g-x1", "/tmp/anchor-r6a");
  const g5 = mkGroup("g-x2", "/tmp/anchor-r6b");
  addMember(g4.id, "sess-F", "worker");
  recordRoutingResult(g4.id, "sess-F", "done", "A 组活");
  recordRoutingResult(g5.id, "sess-F", "done", "B 组活（未入编）");
  ok(!mgr.retiredMemberSids().includes("sess-F"), "g4 在编 → 跨组路由不误伤现役");
  removeMember(g4.id, "sess-F");
  ok(mgr.retiredMemberSids().includes("sess-F"), "唯一编制除名+他组路由在册 → 退休命中");
}

console.log("R7 retired-purge:");
{
  // 护栏腾位：挂起两个在前段已完成使命的 active 组（g-one/g-two——其判定断言已收官）
  for (const g of listGroups()) {
    if (g.status === "active" && (g.name === "g-one" || g.name === "g-two")) setGroupStatus(g.id, "parked");
  }
  const g6 = mkGroup("g-purge", "/tmp/anchor-r7");
  addMember(g6.id, "sess-G", "worker");
  recordRoutingResult(g6.id, "sess-G", "done", "干活");
  removeMember(g6.id, "sess-G");
  ok(mgr.retiredMemberSids().includes("sess-G"), "purge 前名单命中");
  mgr.ensureExternal("sess-G", "/tmp/anchor-r7", "退休成员的会话", "cli-G"); // 建卡（external 形态最轻）
  ok(mgr.snapshot().some((s) => s.session_id === "sess-G"), "退休成员卡在快照（污染面——历史可查）");
  const r = mgr.orgAction("retired-purge", {});
  ok(r.ok === true, "orgAction retired-purge ok");
  const data = (r as { data?: { purged?: number; total?: number } }).data;
  ok(data?.purged === 1, "purged=1（名单内 1 卡删除）");
  ok(!mgr.snapshot().some((s) => s.session_id === "sess-G"), "purge 后快照无该卡（SESSION_DELETED 链）");
  ok(mgr.retiredMemberSids().includes("sess-G"), "档案保留（路由不动，复拉通道无恙）");
}

console.log("R8 帧幂等:");
{
  mgr.emitOrgState(); // 冲掉 R7 直调 removeMember 造数的 pending delta（生产路径 removeMember 全收口在 emitOrgState 后，无此窗）
  const before = frames.length;
  mgr.emitOrgState();
  mgr.emitOrgState();
  ok(frames.length === before, "名单不变连续 emitOrgState → 零帧（delta 检测幂等）");
}

console.log("R9 purge 后名单稳定:");
{
  ok(mgr.retiredMemberSids().includes("sess-G"), "无卡名单仍含 sess-G（名单=档案判定与卡片解耦）");
  const again = mgr.orgAction("retired-purge", {});
  const data = (again as { data?: { purged?: number } }).data;
  ok(again.ok === true && data?.purged === 0, "重复 purge 幂等（无卡可删 purged=0）");
}

console.log("R10 探针防收养（补充②：isSandboxCwd 第四族段形态）:");
{
  const isSandboxCwd = (await import("../src/bridge.js")).isSandboxCwd;
  ok(isSandboxCwd("/var/folders/xx/0abc/T/ccr-273e2e-answer-Xy12/proj") === true, "T/ccr-* 段形态命中（1030 12 卡实锤形态——不依赖 TMPDIR env）");
  ok(isSandboxCwd("/var/folders/xx/0abc/T/ccr-273e2e-answer") === true, "T/ccr-* 恰为尾段也命中");
  ok(isSandboxCwd("/var/folders/xx/0abc/T/常规目录/工作") === false, "T 下非 ccr- 前缀不误伤");
  ok(isSandboxCwd("/Users/xd/dev/T/ccr-manual") === true, "任意路径位的 T/ccr-* 段形态命中（宽匹配=PM 拍板方向）");
  ok(isSandboxCwd("/Users/xd/dev/cc-deck") === false, "业务路径不命中");
  ok(isSandboxCwd("/tmp/hello") === true && isSandboxCwd(".tmp-test/x") === true, "既有三族回归（/tmp 与 .tmp- 不回退）");
}

console.log(`\n结果: ${pass} ok, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
