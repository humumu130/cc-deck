// W-PRREVIEW（期一④ PR 互审，1104 用户拍板「Multica 同款」）—— 互审链 relay 侧套件。
// 覆盖（agentFactory 测试缝，不拉真 CLI；test-dispatch 同款配方）：
//   R1 review-route 路由：避交付者（最高亲和熟手被排除→次席接审）+ N 审互异 +
//      全排除=无匹配回落 PM 子代理（routed=false，不自动开新会话）
//   R2 同域熟手：skills 标签命中越过熟练序（tag_hit=true）
//   R3 target_sid 定席：确定性落席（返回 session_id=定席）+ 安全闸三拒
//      （不存在/Leader/在忙/非编制）+ exclude 自矛盾拒
//   R4 review-ledger 台账段行：原单链 done→in_review（begin 幂等 already）→done（end）；
//      in_review 行过 schema 落账（ndjson 权威面）+ 活单过滤不含 in_review
//   R5 档位零变化：count 钳 1..3（上限=审查档位上限，档位决策仍在 PM——工具不代定档）
//   回归面：dispatch 无新参数行为不变由 test-dispatch 全量套件承担（本套件零改动旧路径）
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { listPendingConfirms, loadBoard, removeMember } from "../src/projects.js";
import { routingFor } from "../src/routing.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// 假 agent 工厂（test-dispatch 同款语义缩样）：init 20ms 后 onInit；prompt/resume
// 消息 10ms 后 onStats+onTurnEnd(ok)——回合即完，routing 记账路径可断言。
const okNext = true;
type SpawnRec = { cwd: string; prompt: string | undefined; cb: AgentCallbacks; agent: AgentLike; resume?: string; configHome?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, _model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; resume?: string; configHome?: string }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {
        setTimeout(() => {
          if (a.ended) return;
          cb.onStats({ files_changed: 1, lines_added: 2, lines_deleted: 1 }); // S1 零产出闸白名单（有改动正常 done）
          cb.onTurnEnd(okNext, "success", 10);
        }, 10);
      },
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    created.push({ cwd, prompt, cb, agent: a, resume: opts?.resume, configHome: opts?.configHome });
    setTimeout(() => cb.onInit("sdk-" + a.id.slice(0, 8), "test-model", "bypassPermissions"), 20);
    // spawn 路径回合收口（test-dispatch 同款语义）：带 prompt 的 spawn=上岗即跑单，
    // 10ms 后 onStats+onTurnEnd——routing 记账/台账收口链可断言
    if (prompt) setTimeout(() => {
      if (a.ended) return;
      cb.onStats({ files_changed: 1, lines_added: 2, lines_deleted: 1 });
      cb.onTurnEnd(okNext, "success", 12);
    }, 10);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-prrev-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-prrev-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  process.env.CCR_STORAGE_READ_MODE = "json"; // fixture json 形态（test-dispatch 同款钉档）
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const anchor = join(DATA, "proj-pr");
    mkdirSync(anchor, { recursive: true });

    const created: SpawnRec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建）");
    const leaderSid = (mgr as unknown as { getLeaderSessionId(): string | null }).getLeaderSessionId() ?? "";
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE" && s.done_reason === "success") !== undefined);

    // ---------- 夹具：组 + 三熟手（w1 亲和最高 count=2，w2/w3 各 1） ----------
    console.log("夹具：组与三熟手");
    const c = mgr.orgAction("project-create", { name: "prrev", anchor, tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
    const gid = c.ok ? (c.data?.group?.id ?? "") : "";
    assert(c.ok === true && !!gid, "组 prrev 立项（pending，前置）");
    const cid = c.ok ? (c.data?.confirm?.id ?? (listPendingConfirms()[0]?.id ?? "")) : "";
    mgr.orgAction("confirm-decide", { confirm_id: cid, approve: true, by: "u" });
    assert(mgr.orgAction("status", {}).ok === true, "组激活（确认卡点头，前置）");

    const hack = mgr as unknown as {
      sessions: Map<string, { state: { status: string; relay_session_id?: string } }>;
    };
    const dispatchOne = async (prompt: string): Promise<{ did: string; sid: string }> => {
      const d = mgr.orgAction("dispatch", { anchor, prompt, gid }) as { ok: boolean; dispatch_id?: string; session_id?: string; error?: string };
      if (!d.ok) throw new Error(`dispatch 夹具失败: ${d.error}`);
      const sid = d.session_id ?? "";
      const did = d.dispatch_id ?? "";
      // 等台账 done（收口=回合结束+routing 记账同刻）——比等 count 更进一步：resume 路径
      // count 在派单前已≥1，等 count 会秒过漏掉本单收口（亲和计数竞态）
      if (!(await waitFor(() => (readDispatchLog().find((e) => e.id === did)?.status ?? "") === "done", 5000)))
        throw new Error(`dispatch 夹具未收口: ${did.slice(0, 8)}`);
      return { did, sid };
    };
    const holdBusy = (sid: string) => { const s = hack.sessions.get(sid); if (s) s.state.status = "WORKING"; };
    const unbusy = (sid: string) => { const s = hack.sessions.get(sid); if (s) s.state.status = "DONE"; };

    const o1 = await dispatchOne("w1 首单（亲和积累①）");
    holdBusy(o1.sid); // 挡住 w1 → 下一单开新会话
    const o2 = await dispatchOne("w2 首单");
    holdBusy(o2.sid);
    const o3 = await dispatchOne("w3 首单");
    holdBusy(o3.sid); // 三席全占 → w1 独占释放造第二笔亲和
    unbusy(o1.sid);
    const o4 = await dispatchOne("w1 二单（亲和积累②，本单=「交付开 PR」的原单）");
    unbusy(o2.sid); unbusy(o3.sid); // 三席全释放（互审路由候选池就位）
    const w1 = o4.sid, w2 = o2.sid, w3 = o3.sid;
    const order = o4.did; // 「交付 PR」的原单（w1 交付）
    assert((routingFor(gid).find((x) => x.session_id === w1)?.count ?? 0) >= 2, "w1 亲和最高（count=2，交付者=最亲和熟手，前置）");
    assert(await waitFor(() => (readDispatchLog().find((e) => e.id === order)?.status ?? "") === "done"), "原单已 done 收口（前置）");

    // ---------- R1 review-route：避交付者 + 互异 + 无匹配回落 ----------
    console.log("R1 review-route 路由：");
    const rr1 = mgr.orgAction("review-route", { gid, count: 1, exclude_sessions: [w1] }) as { ok: boolean; data?: { routed?: boolean; reviewers?: { session_id: string; tag_hit: boolean }[]; reason?: string } };
    const rr1d = rr1.data ?? {};
    assert(rr1.ok === true && rr1d.routed === true, "review-route 路由命中（routed=true）");
    assert((rr1d.reviewers ?? []).length === 1 && rr1d.reviewers?.[0].session_id !== w1, "避交付者：最高亲和熟手 w1 被排除，次席接审");
    const rr2 = mgr.orgAction("review-route", { gid, count: 2, exclude_sessions: [w1] }) as { ok: boolean; data?: { routed?: boolean; reviewers?: { session_id: string }[] } };
    const rr2s = (rr2.data?.reviewers ?? []).map((x) => x.session_id);
    assert(rr2.ok === true && new Set(rr2s).size === rr2s.length && rr2s.length === 2 && !rr2s.includes(w1), "双审互异：两位互审员互不相同且均非交付者");
    const spawnedBefore = created.length;
    const rr3 = mgr.orgAction("review-route", { gid, count: 1, exclude_sessions: [w1, w2, w3] }) as { ok: boolean; data?: { routed?: boolean; reason?: string } };
    assert(rr3.ok === true && rr3.data?.routed === false && (rr3.data?.reason ?? "").includes("PM 子代理"), "全排除=无匹配 routed=false（回落 PM 子代理信号，不自动开新会话）");
    assert(created.length === spawnedBefore, "无匹配零 spawn（review-route 只路由零派发——created 不增）");

    // ---------- R2 同域熟手：skills 标签命中越过熟练序 ----------
    console.log("R2 同域熟手标签命中：");
    mgr.orgAction("tag", { gid, sid: w3, tags: ["review"] });
    assert((routingFor(gid).find((x) => x.session_id === w3)?.tags ?? []).includes("review"), "w3 挂 review 标签（前置）");
    const rr4 = mgr.orgAction("review-route", { gid, count: 1, skills: ["review"], exclude_sessions: [w1] }) as { ok: boolean; data?: { reviewers?: { session_id: string; tag_hit: boolean }[] } };
    const rr4r = rr4.data?.reviewers ?? [];
    assert(rr4.ok === true && rr4r.length === 1 && rr4r[0].session_id === w3 && rr4r[0].tag_hit === true, "同域熟手命中：review 标签席越过熟练序（w3 tag_hit=true）");

    // ---------- R3 target_sid 定席与安全闸 ----------
    console.log("R3 target_sid 定席：");
    const dv = mgr.orgAction("dispatch", { anchor, gid, prompt: "互审单（R3：定席 w2 出审）", target_sid: w2, exclude_sessions: [w1] }) as { ok: boolean; session_id?: string; dispatch_id?: string; error?: string };
    assert(dv.ok === true && dv.session_id === w2, "定席确定性落席（返回 session_id=定席 w2，不静默换席）");
    const dvLanded = dv.ok ? (readDispatchLog().find((e) => e.id === (dv.dispatch_id ?? ""))?.status ?? "") : "";
    assert(await waitFor(() => (readDispatchLog().find((e) => e.id === (dv.dispatch_id ?? ""))?.status ?? "") === "done"), "互审单回合收口 done（fake 工厂 10ms 回合）");
    assert(dvLanded === "dispatched" || dvLanded === "running" || dvLanded === "done", "互审单台账行在册（段链推进）");
    const tGhost = mgr.orgAction("dispatch", { anchor, gid, prompt: "定席不存在", target_sid: randomUUID() }) as { ok: boolean; error?: string };
    assert(tGhost.ok === false && (tGhost.error ?? "").includes("不存在"), "定席安全闸：会话不存在 → 响亮拒");
    const tLeader = mgr.orgAction("dispatch", { anchor, gid, prompt: "定席 Leader", target_sid: leaderSid }) as { ok: boolean; error?: string };
    assert(tLeader.ok === false && (tLeader.error ?? "").includes("Leader"), "定席安全闸：Leader 不接单 → 拒");
    holdBusy(w2);
    const tBusy = mgr.orgAction("dispatch", { anchor, gid, prompt: "定席在忙", target_sid: w2 }) as { ok: boolean; error?: string };
    assert(tBusy.ok === false && (tBusy.error ?? "").includes("在忙"), "定席安全闸：在忙 → 拒（稍后重跑路由）");
    unbusy(w2);
    const tSelf = mgr.orgAction("dispatch", { anchor, gid, prompt: "自矛盾", target_sid: w2, exclude_sessions: [w2] }) as { ok: boolean; error?: string };
    assert(tSelf.ok === false && (tSelf.error ?? "").includes("排除集"), "定席安全闸：target 同时在排除集 → 拒（自相矛盾参数）");
    removeMember(gid, w2);
    const tRoster = mgr.orgAction("dispatch", { anchor, gid, prompt: "定席非编制", target_sid: w2 }) as { ok: boolean; error?: string };
    assert(tRoster.ok === false && (tRoster.error ?? "").includes("编制"), "定席安全闸：已退编（非编制）→ 拒（互审员=在编 worker）");

    // ---------- R4 review-ledger 台账段行 ----------
    console.log("R4 review-ledger 台账段行：");
    const lb = mgr.orgAction("review-ledger", { dispatch_id: order, phase: "begin", note: "PR #e2e 互审发起（leader-harvest --review）" }) as { ok: boolean; data?: { status?: string; already?: boolean } };
    assert(lb.ok === true && lb.data?.status === "in_review", "begin：原单链落 in_review 段行（schema 过闸——in_review 已入词表）");
    assert((readDispatchLog().find((e) => e.id === order)?.status ?? "") === "in_review", "台账收敛末行=in_review（同 id 末行收敛）");
    const lb2 = mgr.orgAction("review-ledger", { dispatch_id: order, phase: "begin" }) as { ok: boolean; data?: { already?: boolean } };
    assert(lb2.ok === true && lb2.data?.already === true, "begin 幂等：末行已 in_review → already 不重复落行");
    const rawRows = readFileSync(join(ORG, "dispatch-log.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; status: string });
    assert(rawRows.filter((e) => e.id === order && e.status === "in_review").length === 1, "in_review 段行恰一行（幂等实证）");
    const le = mgr.orgAction("review-ledger", { dispatch_id: order, phase: "end", note: "PR squash-merge 收割（leader-harvest --merge）" }) as { ok: boolean; data?: { status?: string } };
    assert(le.ok === true && le.data?.status === "done", "end：审查收口段行落 done");
    assert((readDispatchLog().find((e) => e.id === order)?.status ?? "") === "done", "台账收敛末行回 done（终态视图恢复）");
    const lbad = mgr.orgAction("review-ledger", { dispatch_id: order, phase: "wat" }) as { ok: boolean; error?: string };
    assert(lbad.ok === false && (lbad.error ?? "").includes("begin|end"), "phase 词表守卫：非法 phase → 拒");
    const lmiss = mgr.orgAction("review-ledger", { dispatch_id: randomUUID(), phase: "begin" }) as { ok: boolean; error?: string };
    assert(lmiss.ok === false && (lmiss.error ?? "").includes("原单不存在"), "原单不存在 → 拒（防幻觉链）");
    // 活单过滤不含 in_review：开放单口径（dispatched|running|queued）不把 in_review 当活单
    const openAfter = readDispatchLog().filter((e) => e.status === "dispatched" || e.status === "running" || e.status === "queued");
    assert(!openAfter.some((e) => e.id === order), "活单白名单不含 in_review（不重收口/不阻新单——开放单过滤零命中）");

    // ---------- R5 档位零变化（count 钳制=上限护栏，档位决策仍在 PM） ----------
    console.log("R5 档位护栏：");
    const rr5 = mgr.orgAction("review-route", { gid, count: 5, exclude_sessions: [w1] }) as { ok: boolean; data?: { reviewers?: { session_id: string }[] } };
    assert(rr5.ok === true && (rr5.data?.reviewers ?? []).length <= 3, "count 钳 1..3（审查档位上限=3，档位决策仍在 PM——工具不代定档）");

    // ---------- 收尾 ----------
    const b = loadBoard(gid);
    assert(existsSync(join(ORG, "dispatch-log.ndjson")) && b.entries.length >= 0, "组面/台账面无异常（收尾巡检）");
    console.log(`\nPASS: ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwdEnv === undefined) delete process.env.CCR_CWD; else process.env.CCR_CWD = prevCwdEnv;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("套件炸了:", e); process.exit(1); });
