// [W-SEAT-SEMANTICS] 席位语义手术断言（用户 1101 拍板 C 模式批次一）——成因入库三
// 通路 + 富化帧双载 + trim 三策略化（72h/首裁确认卡/轮次账）+ 兼容（retired_session_ids
// 旧格式零破坏）。沙盒配方与 test-retired-sessions 同源（CCR_ORG_DIR/CCR_DATA_DIR 隔离）。
// 覆盖：
//   C1 manual 通路：orgAction member-retire → entries[].cause="manual" + ledger 落账
//   C2 idle-trim 通路：trimHeadcounts 执行 → entries[].cause="idle-trim" + 轮次账 jsonl
//   C3 group-disband 通路：orgAction project-status→parked → cause="group-disband"
//   C4 无账历史条目 → entries 带 sid 无 cause（端上回落「离席」泛词）
//   C5 复拉→再裁=末笔覆盖（idle-trim 覆盖旧 manual）
//   C6 帧双载兼容：RETIRED_SESSIONS_UPDATED 同时带 retired_session_ids（旧端零破坏）
//   C7 首裁闸：auto 轮首裁→确认卡+不裁；✓→真裁+轮次账；此后 auto 永直裁
//   C8 首裁否决：✗→不裁；24h 冷却窗内 auto 再轮=跳过不出新卡
//   C9 keepIdleMs 缺省 72h（auto 轮 dryRun 判定与新缺省一致——用 plan 边界旁证）
//   C10 旧 report 兼容保留（headcount-trim-report.json 仍最新一份覆盖写）
// 直跑：cd relay && node --import tsx/esm scripts/test-retired-causes.ts
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
type Envelope = { type: string; payload?: unknown };
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { createGroup, addMember, removeMember, setGroupStatus, listPendingConfirms, listConfirms } from "../src/projects.js";
import { recordRoutingResult } from "../src/routing.js";
import { listRetiredEvents } from "../src/projects.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name); }
}

// ---- 沙盒（test-retired-sessions 同配方） ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-retired-causes-org/", "../data/test-retired-causes-data/", "../data/test-retired-causes-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-retired-causes-org/");
process.env.CCR_DATA_DIR = SB("../data/test-retired-causes-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-retired-causes-projects/");
process.env.CCR_SESSIONS_ROOT = SB("../data/test-retired-causes-projects/sessions/");
mkdirSync(process.env.CCR_SESSIONS_ROOT, { recursive: true });
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_ORG_MAX_GROUPS = "12"; // 沙盒腾位（缺省 5 并行护栏——本测 9 组夹具）
process.env.CCR_STORAGE_READ_MODE = "json"; // [W-SEAT-SEMANTICS] 钉 json 读档：#292 双轨下 sqlite 读模式+延迟导入追赶在同一进程测试窗内不可见新增确认卡（沙盒隔离目录不跑追赶）——本测全链 json 真相源，与生产「json 真相+deferred 同步」语义一致
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";

const cfg = loadConfig();
cfg.token = "t";
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);

// 帧捕获（全 payload——双载断言用）
const frames: { ids: string[]; entries: unknown }[] = [];
bus.subscribe((env: Envelope) => {
  if (env.type === "RETIRED_SESSIONS_UPDATED") {
    const p = (env.payload ?? {}) as { retired_session_ids?: string[]; retired_entries?: unknown };
    frames.push({ ids: (p.retired_session_ids ?? []) as string[], entries: p.retired_entries });
  }
});

const mkGroup = (name: string, anchor: string) => {
  const r = createGroup({ name, anchor_dir: anchor, tier: "轻立项" });
  if (!r.ok) throw new Error("建组失败: " + r.error);
  const g0 = r.group;
  if (g0.status === "pending") {
    const a = setGroupStatus(g0.id, "active");
    if (!a.ok) throw new Error("激活失败: " + a.error);
    return a.group;
  }
  return g0;
};

const ORG = process.env.CCR_ORG_DIR as string;
const doneWith = (gid: string) => { try { setGroupStatus(gid, "archived", "测试收尾归档"); } catch { /* 不影响断言 */ } }; // active 组 5 上限护栏——逐案收尾归档
const entryOf = (sid: string) => mgr.retiredMemberEntries().find((e) => e.session_id === sid);

console.log("C1 manual 通路（member-retire → cause=manual）:");
{
  const g = mkGroup("sc-manual", "/tmp/anchor-sc1");
  addMember(g.id, "sess-M1", "worker");
  recordRoutingResult(g.id, "sess-M1", "done", "干活");
  const r = mgr.orgAction("member-retire", { gid: g.id, sid: "sess-M1", reason: "测试除名" });
  ok(r.ok === true, "orgAction member-retire ok");
  const e = entryOf("sess-M1");
  ok(!!e && e.cause === "manual", "entries cause=manual");
  ok(!!e && typeof e.since === "number" && e.since > 0, "since=记账时刻");
  ok(!!e && (e.detail ?? "").includes("测试除名"), "detail 带理由");
  ok(listRetiredEvents().some((ev) => ev.session_id === "sess-M1" && ev.cause === "manual"), "ledger jsonl 落账");
  doneWith(g.id);
}

console.log("C2 idle-trim 通路（trimHeadcounts 执行 → cause=idle-trim + 轮次账）:");
{
  const g = mkGroup("sc-trim", "/tmp/anchor-sc2");
  addMember(g.id, "sess-T1", "worker");
  recordRoutingResult(g.id, "sess-T1", "done", "干活");
  // 手动面（无 auto）直接执行：不设闸
  const r = mgr.trimHeadcounts({ onlyGid: g.id, keepIdleMs: 0 }); // keepIdleMs:0=确定性过期（now-last<0 恒假 → 近期活动保留判不命中）
  ok(r.ok && r.data.totalTrimmed >= 1, "手动 trim 执行裁剪（不经首裁闸）");
  const e = entryOf("sess-T1");
  ok(!!e && e.cause === "idle-trim", "entries cause=idle-trim（末笔覆盖 C1 场景同构）");
  ok(!!e && /闲置/.test(String(e.detail)), "detail 带闲置时长");
  const journal = join(ORG, "headcount-trim-journal.ndjson");
  ok(existsSync(journal), "轮次账 headcount-trim-journal.ndjson 落盘");
  const rows = readFileSync(journal, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { gid?: string; via?: string });
  ok(rows.some((x) => x.gid === g.id && x.via === "manual"), "轮次账含本组 manual 轮（via 标记）");
  ok(existsSync(join(ORG, "headcount-trim-report.json")), "C10 旧 report 兼容保留（最新一份覆盖写）");
  doneWith(g.id);
}

console.log("C3 group-disband 通路（project-status→parked → cause=group-disband）:");
{
  const g = mkGroup("sc-park", "/tmp/anchor-sc3");
  addMember(g.id, "sess-P1", "worker");
  recordRoutingResult(g.id, "sess-P1", "done", "干活");
  const r = mgr.orgAction("project-status", { id: g.id, to: "parked" });
  ok(r.ok === true, "orgAction project-status→parked ok（走 parkGroupMembers 联动链）");
  ok(listRetiredEvents().some((ev) => ev.session_id === "sess-P1" && ev.cause === "group-disband"), "ledger cause=group-disband 落账");
  // parked 组编制快照=现役口径不变（retiredMemberSids 不含 parked 在册成员——test-retired-sessions R4 同款）
  ok(!mgr.retiredMemberSids().includes("sess-P1"), "parked 编制快照=现役（口径零变化，成因仅入账备用）");
  doneWith(g.id);
}

console.log("C4 无账历史条目（成因缺庅回落泛词）:");
{
  const g = mkGroup("sc-hist", "/tmp/anchor-sc4");
  addMember(g.id, "sess-H1", "worker");
  recordRoutingResult(g.id, "sess-H1", "done", "干活");
  // 直调 removeMember（storage 面，绕开 member-retire 动作）=模拟记账前历史事件
  removeMember(g.id, "sess-H1");
  const e = entryOf("sess-H1");
  ok(!!e && e.cause === undefined, "entries 带 sid 无 cause（端上回落「离席」泛词）");
  doneWith(g.id);
}

console.log("C5 复拉→再裁=末笔覆盖:");
{
  const g = mkGroup("sc-rejoin", "/tmp/anchor-sc5");
  addMember(g.id, "sess-R1", "worker");
  recordRoutingResult(g.id, "sess-R1", "done", "干活");
  mgr.orgAction("member-retire", { gid: g.id, sid: "sess-R1", reason: "先除名" });
  ok(entryOf("sess-R1")?.cause === "manual", "第一笔=manual");
  const back = addMember(g.id, "sess-R1", "worker");
  ok(back.ok && !mgr.retiredMemberSids().includes("sess-R1"), "复拉后现役（名单移除）");
  mgr.trimHeadcounts({ onlyGid: g.id, keepIdleMs: 0 });
  const e = entryOf("sess-R1");
  ok(!!e && e.cause === "idle-trim", "再裁后末笔 idle-trim 覆盖 manual（现状成因语义）");
  doneWith(g.id);
}

console.log("C6 帧双载兼容:");
{
  ok(frames.length >= 1, "RETIRED_SESSIONS_UPDATED 已广播");
  const last = frames[frames.length - 1];
  ok(Array.isArray(last.ids), "retired_session_ids 仍在（旧端零破坏）");
  ok(Array.isArray(last.entries), "retired_entries 富化同帧携带");
}

console.log("C7 首裁闸（auto 轮首裁→确认卡；✓→真裁；此后永直裁）:");
{
  const g = mkGroup("sc-gate", "/tmp/anchor-sc7");
  addMember(g.id, "sess-G1", "worker");
  recordRoutingResult(g.id, "sess-G1", "done", "干活");
  const r1 = mgr.trimHeadcounts({ auto: true, keepIdleMs: 0 });
  ok(r1.ok && r1.data.totalTrimmed === 0, "auto 首轮：不裁（闸拦截）");
  ok((r1.data.gated ?? []).some((x) => x.gid === g.id && x.confirm_id), "gated 记录带 confirm_id");
  const card = listPendingConfirms().find((c) => c.kind === "headcount-trim-first" && c.payload?.gid === g.id);
  ok(!!card, "headcount-trim-first 确认卡在列");
  // 待决期间再 auto：幂等跳过不出新卡
  const before = listPendingConfirms().filter((c) => c.kind === "headcount-trim-first").length;
  const r2 = mgr.trimHeadcounts({ auto: true, keepIdleMs: 0 });
  ok(r2.ok && r2.data.totalTrimmed === 0, "待决期 auto 再轮：仍不裁");
  ok(listPendingConfirms().filter((c) => c.kind === "headcount-trim-first").length === before, "不出第二张卡（幂等）");
  // ✓ 决议 → viaConfirm 真裁
  const d = mgr.orgAction("confirm-decide", { confirm_id: card!.id, approve: true });
  ok(d.ok === true, "confirm-decide ✓ ok（副作用=viaConfirm 重入真裁）");
  ok(mgr.retiredMemberSids().includes("sess-G1"), "决议后裁剪生效（sid 进名单）");
  ok(entryOf("sess-G1")?.cause === "idle-trim", "决议裁=idle-trim 成因");
  const jRows = readFileSync(join(ORG, "headcount-trim-journal.ndjson"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { gid?: string; via?: string });
  ok(jRows.some((x) => x.gid === g.id && x.via === "confirm"), "轮次账 via=confirm（决议轮）");
  // 此后 auto 轮永直裁（journal 有既往轮）
  addMember(g.id, "sess-G2", "worker");
  recordRoutingResult(g.id, "sess-G2", "done", "干活");
  const r3 = mgr.trimHeadcounts({ auto: true, keepIdleMs: 0 });
  ok(r3.ok && r3.data.totalTrimmed >= 1 && !(r3.data.gated ?? []).some((x) => x.gid === g.id), "此后 auto 轮直裁（永续，不再出卡）");
  doneWith(g.id);
}

console.log("C8 首裁否决（✗→不裁；24h 冷却）:");
{
  const g = mkGroup("sc-rej", "/tmp/anchor-sc8");
  addMember(g.id, "sess-J1", "worker");
  recordRoutingResult(g.id, "sess-J1", "done", "干活");
  const r1 = mgr.trimHeadcounts({ auto: true, keepIdleMs: 0 });
  ok(r1.ok && r1.data.totalTrimmed === 0 && (r1.data.gated ?? []).some((x) => x.gid === g.id), "auto 首轮出卡不裁");
  const card = listPendingConfirms().find((c) => c.kind === "headcount-trim-first" && c.payload?.gid === g.id);
  ok(!!card, "确认卡在列");
  const d = mgr.orgAction("confirm-decide", { confirm_id: card!.id, approve: false });
  ok(d.ok === true, "confirm-decide ✗ ok（无副作用）");
  ok(!mgr.retiredMemberSids().includes("sess-J1"), "否决后不裁（仍在编）");
  const r2 = mgr.trimHeadcounts({ auto: true, keepIdleMs: 0 });
  ok(r2.ok && r2.data.totalTrimmed === 0 && (r2.data.gated ?? []).some((x) => x.gid === g.id && /冷却/.test(x.note)), "冷却窗内 auto 再轮=跳过不出新卡（note=冷却）");
  // 冷却过后可重提：decided_at 可造——直接验判定函数面（listConfirms 历史已含 rejected）
  const rej = listConfirms().filter((c) => c.kind === "headcount-trim-first" && c.payload?.gid === g.id && c.status === "rejected");
  ok(rej.length === 1 && typeof rej[0].decided_at === "number", "否决留痕（decided_at 在场，24h 后重提依据）");
  doneWith(g.id);
}

console.log("C9 keepIdleMs 缺省 72h:");
{
  // auto 轮 dryRun 判定与缺省一致性旁证：dryRun 不设闸（清单面），且缺省窗口=72h——
  // 用幽灵席（无活动记录恒过期）+ dryRun 返回裁单证明缺省窗口生效路径可走通（24h→72h
  // 数值面在 planHeadcountTrim 纯函数单测已覆盖，此处验编排签名面）
  const g = mkGroup("sc-72", "/tmp/anchor-sc9");
  addMember(g.id, "sess-K1", "worker");
  recordRoutingResult(g.id, "sess-K1", "done", "干活");
  const r = mgr.trimHeadcounts({ dryRun: true, keepIdleMs: 0 }); // keepIdleMs:0=确定性入清单（72h 缺省下新鲜 routing 恒保留，测不到清单面）
  ok(r.ok && r.data.groups.some((x) => x.gid === g.id), "dryRun 清单面可用（含本组裁单）");
  ok(r.data.groups.every((x) => x.gid !== g.id || x.after === x.before - x.trimmed.length), "dryRun before/after 自洽");
  ok(!listPendingConfirms().some((c) => c.kind === "headcount-trim-first" && c.payload?.gid === g.id), "dryRun 不出确认卡");
  ok(!existsSync(join(ORG, "headcount-trim-journal.ndjson")) || !readFileSync(join(ORG, "headcount-trim-journal.ndjson"), "utf-8").includes(g.id), "dryRun 不落轮次账（零副作用）");
}

console.log(`\nretired-causes: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
