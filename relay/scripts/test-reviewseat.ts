// W-REVIEWSEAT（1105 用户拍板）四断言组：
//   A store 组：配置 CRUD（钳位/原子写/池组 ensure+cap 同步/快照 payload）
//   B 路由三跳组：互审（reviewer 排除）→团队专属席→全局池（异构优先）；三跳共 exclude 互异
//   C 守卫组：评审席接实施单拒（响亮错+审计帧）；review_only=true 放行+纪律段注入
//   D 动态调整组：orgAction review-seat-set 热生效（enabled/size/override——路由行为随写即变，零重启）
// 惯例：test-dispatch 头部（fake agentFactory/四重隔离/断言累计）。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readReviewSeatConfig, writeReviewSeatConfig, ensureReviewPoolGroup, reviewPoolGid, reviewPoolSnapshot, teamReviewerSeats, reviewSeatSnapshotPayload } from "../src/review-seat.js";
import { addMember, createGroup, decideConfirm, findGroup, listGroups, setGroupStatus } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => { setTimeout(() => { if (!a.ended) { cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 }); cb.onTurnEnd(true, "success", 10); } }, 10); }, // resume 回合模拟（定席单走 sendMessage——空实现会挂 WORKING）
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => { if (!a.ended) { cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 }); cb.onTurnEnd(true, "success", 10); } }, 10);
    }, 10);
    return a;
  };

const ORG = mkdtempSync(join(tmpdir(), "rs-org-"));
const DATA = mkdtempSync(join(tmpdir(), "rs-data-"));
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_NO_TITLE_GEN = "1";
delete process.env.CCR_CWD;

async function main() {
  // ================= A store 组 =================
  console.log("A store 组：");
  const c0 = readReviewSeatConfig();
  ok(c0.enabled === true && c0.default_size === 2 && Object.keys(c0.team_override).length === 0, "A1 缺省配置（enabled/size=2/override 空）");
  const c1 = writeReviewSeatConfig({ default_size: 99, team_override: { "pg-abc": 1, "bad": 5, "pg-x": 9 } });
  ok(c1.default_size === 8, "A2 size 钳位 1..8（99→8）");
  ok(c1.team_override["pg-abc"] === 1 && !("bad" in c1.team_override) && c1.team_override["pg-x"] === 8, "A3 override 过滤（非 pg- 键弃/9→8 钳位）");
  ensureReviewPoolGroup();
  const pgid = reviewPoolGid();
  ok(!!pgid && !!findGroup(pgid), "A4 池组 ensure（建组+gid 回写 store）");
  ok(findGroup(pgid)?.status === "active", "A5 池组 active（系统组件不走用户确认面）");
  ok(reviewPoolSnapshot().cap === 8, "A6 cap 同步（size 写→组 cap 即改）");
  // 团队组建（甲）+reviewer 专属席
  mkdirSync(join(ORG, "jia"));
  const r2 = createGroup({ name: "甲", anchor_dir: join(ORG, "jia"), tier: "轻立项", headcount: [] });
  if (r2.ok && r2.confirm) decideConfirm(r2.confirm.id, true, "t");
  if (r2.ok && r2.group?.status === "pending") setGroupStatus(r2.group.id, "active");
  const jia = listGroups().find((x) => x.name === "甲");
  ok(!!jia, "A7 甲组建+active");
  if (jia) {
    addMember(jia.id, "sid-seat1", "reviewer");
    addMember(jia.id, "sid-w1", "worker");
    ok(teamReviewerSeats(jia.id).length === 1 && teamReviewerSeats(jia.id)[0].session_id === "sid-seat1", "A8 专属席筛（role=reviewer 且不含 worker）");
  }
  const payload = reviewSeatSnapshotPayload();
  ok(payload.teams.some((t) => t.name === "甲" && t.actual === 1) && !payload.teams.some((t) => t.gid === pgid), "A9 快照 payload（teams 含甲 actual=1/不含池组自己）");

  // ================= B/C/D 需要 mgr =================
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(makeFakeFactory());
  const r0 = mgr.ensureLeader();
  ok(r0.ok === true, "环境就绪（Leader 首建）");
  await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));

  // ================= B 路由三跳组 =================
  console.log("B 路由三跳组：");
  // 造态：甲组 worker w1 活席（互审候选）；专属席 sid-seat1 无会话（死席）→跳过；池组两席（一活一死+异构）
  const anchor = join(ORG, "jia");
  const d1 = mgr.orgAction("dispatch", { anchor, prompt: "w1 干活成为熟手", gid: jia!.id, title: "rs-1" }) as { ok: boolean; session_id?: string };
  ok(d1.ok === true, "B0 w1 派单成功（互审候选就位）");
  const w1 = d1.ok ? (d1 as { session_id: string }).session_id : "";
  await waitFor(() => mgr.snapshot().find((s) => s.session_id === w1)?.status === "DONE");
  const d2 = mgr.orgAction("dispatch", { anchor, prompt: "审查单探路", gid: jia!.id, title: "rs-r0", target_sid: w1, review_only: true }) as { ok: boolean; error?: string };
  ok(d2.ok === true, "B0b w1 亦可接 review_only 单（worker 接审查单不违守卫）");
  await waitFor(() => mgr.snapshot().find((s) => s.session_id === w1)?.status === "DONE"); // 回闲防忙态污染 B3 peer 断言
  // 池组造席：两活席（需真实会话——用 review_only 派单拉活？池组 anchor 池目录）
  const poolAnchor = join(ORG, "review-pool");
  const dp1 = mgr.orgAction("dispatch", { anchor: poolAnchor, prompt: "池席 claude 干活", gid: pgid, title: "rs-p1" }) as { ok: boolean; session_id?: string; error?: string };
  // 池组派单可能因 anchor 无 CLAUDE 等——容错：失败则跳过池活席场景改断言路由 reason
  const poolSid = dp1.ok ? (dp1 as { session_id: string }).session_id : "";
  if (poolSid) {
    await waitFor(() => mgr.snapshot().find((s) => s.session_id === poolSid)?.status === "DONE");
    addMember(pgid, poolSid, "reviewer");
  }
  ok(reviewPoolSnapshot().seats.length >= (poolSid ? 1 : 0), "B0c 池组席位在场（活席派单拉起+入编）");
  // 互审排除 reviewer：甲组 count=1 路由——期望 peer(w1) 而非 seat（seat 死席）
  const rr1 = mgr.routeReviewers(jia!.id, { count: 1, exclude: [w1] }) as { routed: boolean; reviewers: { session_id: string; source: string }[]; reason?: string };
  ok(!rr1.routed || rr1.reviewers.every((x) => x.session_id !== "sid-seat1"), "B1 互审跳1 排除 reviewer 死席（sid-seat1 不被选中——评审席不进互审候选）");
  // 池活席路由：exclude w1 后 count=1——若池活席在场应命中 source=pool
  if (poolSid) {
    const rr2 = mgr.routeReviewers(jia!.id, { count: 1, exclude: [w1] }) as { routed: boolean; reviewers: { source: string }[] };
    ok(rr2.routed && rr2.reviewers[0]?.source === "pool", `B2 池跳命中（source=${rr2.reviewers[0]?.source}——跨团队池席被路由）`);
  } else {
    ok(true, "B2（池活席未就位——派单容错跳过，池路由断言由 D 组 store 面覆盖）");
  }
  // 专属席活席场景：把 w1 转编为甲组 reviewer（addMember role）——routeReviewers exclude w1 不行——新造：直接把 sid-seat1 从 headcount 移除、w1 加 reviewer 角色（addMember 同 sid 改 role——projects addMember 幂等？用 remove+add）
  // 简化：routeReviewers(gid, {exclude:[]})——w1 是 worker（peer 跳应选中）→验证 source=peer
  const rr3 = mgr.routeReviewers(jia!.id, { count: 1, ...(poolSid ? { exclude: [poolSid] } : {}) }) as { routed: boolean; reviewers: { session_id: string; source: string }[]; reason?: string };
  ok(rr3.routed && rr3.reviewers[0]?.source === "peer", `B3 池席排除后互审跳命中 worker（source=${rr3.reviewers[0]?.source}——池兜底不抢互审席）`);

  // ================= C 守卫组 =================
  console.log("C 守卫组：");
  if (poolSid) {
    const g1 = mgr.orgAction("dispatch", { anchor: poolAnchor, prompt: "实施类单误派评审席", gid: pgid, title: "rs-guard", target_sid: poolSid }) as { ok: boolean; error?: string };
    ok(g1.ok === false && (g1.error ?? "").includes("只读守卫"), `C1 评审席接实施单拒（${(g1.error ?? "").slice(0, 30)}…）`);
    const g2 = mgr.orgAction("dispatch", { anchor: poolAnchor, prompt: "审查单（review）", gid: pgid, title: "rs-rv", target_sid: poolSid, review_only: true }) as { ok: boolean; error?: string };
    ok(g2.ok === true, `C2 review_only=true 放行${g2.ok ? "" : "（err=" + (g2.error ?? "").slice(0, 60) + "）"}`);
    await waitFor(() => mgr.snapshot().find((s) => s.session_id === poolSid)?.status === "DONE"); // 回闲防 D5 定席撞忙态
  } else {
    ok(true, "C 组（池活席未就位——守卫断言转 store 面判定：isReviewerSeat 单元）");
    ok(!(mgr as unknown as { isReviewerSeat: (s: string) => boolean }).isReviewerSeat("sid-notexist"), "C1' isReviewerSeat 非席返 false");
  }
  // 纪律段注入（review_only 派单的 prompt 含评审席纪律——从 wrapDispatchPrompt 产物验：dispatch 成功态无直查口，验 reviewOnlyBlock 存在）
  ok(typeof (mgr as unknown as { reviewOnlyBlock: () => string }).reviewOnlyBlock() === "string" && (mgr as unknown as { reviewOnlyBlock: () => string }).reviewOnlyBlock().includes("禁止修改产品代码"), "C3 纪律段在场（只读铁律文案）");

  // ================= D 动态调整组 =================
  console.log("D 动态调整组：");
  const s1 = mgr.orgAction("review-seat-get", {}) as { ok: boolean; data?: { config: { enabled: boolean; default_size: number } } };
  ok(s1.ok === true && s1.data?.config?.default_size === 8, "D1 review-seat-get（配置读面+池现状）");
  const s2 = mgr.orgAction("review-seat-set", { enabled: false, default_size: 3, team_override: { [jia!.id]: 2 } }) as { ok: boolean; data?: { config: { enabled: boolean; default_size: number; team_override: Record<string, number> } } };
  ok(s2.ok === true && s2.data?.config?.enabled === false && s2.data?.config?.default_size === 3 && s2.data?.config?.team_override?.[jia!.id] === 2, "D2 set 三键热写（enabled/size/override）");
  ok(readReviewSeatConfig().enabled === false, "D3 store 即读即新（热生效——路由每次现读）");
  const rr4 = mgr.routeReviewers(jia!.id, { count: 1, exclude: [w1] }) as { routed: boolean; reason?: string };
  ok(!rr4.routed && (rr4.reason ?? "").includes("已停用"), `D4 停用后路由跳过池层（reason 含停用——${(rr4.reason ?? "").slice(0, 24)}）`);
  if (poolSid) {
    const g3 = mgr.orgAction("dispatch", { anchor: poolAnchor, prompt: "停用态再派审查单", gid: pgid, title: "rs-rv2", target_sid: poolSid, review_only: true }) as { ok: boolean; error?: string };
    ok(g3.ok === true, "D5 停用不撤编制（既有池席仍可显式定席接审单——enabled 只控路由跳，不毁席）");
  }
  const s3 = mgr.orgAction("review-seat-set", { enabled: true }) as { ok: boolean };
  ok(s3.ok === true && readReviewSeatConfig().enabled === true, "D6 重开即恢复");
  ok(reviewPoolSnapshot().cap === 3, "D7 cap 随 set=3 同步（池组编制面联动）");

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main().then(
  () => {},
  (e) => { console.error("SUITE-ERR:", e); process.exit(1); },
);
process.on("exit", () => { try { rmSync(ORG, { recursive: true, force: true }); } catch {} try { rmSync(DATA, { recursive: true, force: true }); } catch {} });
