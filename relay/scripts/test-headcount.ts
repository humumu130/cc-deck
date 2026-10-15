// P0 编制膨胀根修（2026-10-15 用户实锤「编制膨胀 65 席」）——编制上限/触顶复用/
// 排队不扩编/headcount 裁剪 断言套件（agentFactory 测试缝，不拉真 CLI）。
// 覆盖：H1 cap 内新建 H2 触顶全忙排队（FIFO+queued 台账行+队列文件持久）
//       H3 收口释放排水（复用收口熟手，零新建）H4 cap-set 组级覆盖与清除
//       H5 member-add 上限闸（泛 worker 拒 / 命名角色豁免）
//       H6 planHeadcountTrim 纯函数（命名保/存活保/24h 活动/原因文本/边界）
//       H7 trimHeadcounts 编排（裁剪准确+报告落盘+projects.json 收敛）
//       H8 触顶先清后判（过期席清理腾名额→正常新建，PM 补充③）
//       H9 member-retire 腾名额排水（除名即试排，队列接续新建）
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import {
  addMember, createGroup, findGroup, genericWorkerCount, headcountCapOf, listGroups,
  maxHeadcountWorkers, planHeadcountTrim, setGroupStatus,
} from "../src/projects.js";
import { loadDispatchQueue } from "../src/dispatch-queue.js";
type QueuedDispatchLike = { dispatch_id: string; enqueued_at: number; input: Record<string, unknown> };
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = (p: string): unknown => {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
};

// 假 agent 工厂：init 10ms 后 onInit；回合终态**不自动发**（测试手动 finishTurn 控制
// 时序——并发派单需要「全忙」窗口，自动收口会破坏触顶判定）。
type Rec = { cwd: string; prompt?: string; cb: AgentCallbacks; agent: AgentLike; resume?: string; employee?: boolean };
const makeFakeFactory = (created: Rec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { resume?: string; permissionMode?: string; employee?: boolean }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    created.push({ cwd, prompt, cb, agent: a, resume: opts?.resume, employee: opts?.employee });
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, opts?.permissionMode ?? "default");
    }, 10);
    return a;
  };

// 直改会话内存态（裁剪测试的时间机器：updated_at 回拨/状态改写——创建即 WORKING，
// 回拨即「陈旧」）。SessionManager.sessions 私有，测试缝走断言 cast。
type SessionMap = Map<string, { state: { updated_at: number; status: string; session_id: string; project_gid?: string } }>;
const sessionsOf = (mgr: SessionManager): SessionMap => (mgr as unknown as { sessions: SessionMap }).sessions;
// create 私有，测试缝同款 cast（运行时 JS 不设私有栅栏）
const createSession = (mgr: SessionManager, cwd: string): string =>
  (mgr as unknown as { create: (cwd: string, prompt: string, pm?: string, autoMkdir?: boolean, opts?: object) => string }).create(cwd, "", "default", false, { employee: true });

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-hc-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-hc-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevCap = process.env.CCR_ORG_HEADCOUNT_CAP;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  const prevCwd = process.env.CCR_CWD;
  const prevNoTrim = process.env.CCR_NO_HEADCOUNT_TRIM;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ORG_HEADCOUNT_CAP = "2";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_NO_HEADCOUNT_TRIM = "1"; // 测试内不跑 boot/定时裁剪（手动触发面验证）
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8794, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const anchor = join(ORG, "anchor-repo");
    mkdirSync(anchor, { recursive: true });
    const anchor2 = join(ORG, "anchor-trim");
    mkdirSync(anchor2, { recursive: true });

    const created: Rec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));

    // ---- 组夹具 ----
    const cg = createGroup({ name: "HC 组", anchor_dir: anchor, tier: "轻立项" });
    assert(cg.ok, "夹具：组创建");
    const gid = cg.ok ? cg.group.id : "";
    setGroupStatus(gid, "active");
    assert(findGroup(gid)?.status === "active", "夹具：组激活");

    // ---- H1 cap 内新建（泛 worker 0→2，无既有熟手逐单新建） ----
    console.log("H1 cap 内新建");
    const r1 = mgr.dispatchWorker({ anchor, gid, prompt: "任务一", title: "T1" });
    assert(r1.ok && !("queued" in r1 && r1.queued), "第一单新建（无熟手无排队）");
    await wait(30); // init 到位（WORKING）
    const r2 = mgr.dispatchWorker({ anchor, gid, prompt: "任务二", title: "T2" });
    assert(r2.ok && !("queued" in r2 && r2.queued), "第二单新建（首单在忙无路由不复用）");
    assert(r1.ok && r2.ok && r1.session_id !== r2.session_id, "两单两会话");
    await wait(30);
    const g1 = findGroup(gid);
    assert(!!g1 && genericWorkerCount(g1.headcount) === 2, `cap 内泛 worker 累计=2（实际 ${g1 ? genericWorkerCount(g1.headcount) : "?"}）`);
    assert(!!g1 && headcountCapOf(g1) === 2, "生效上限=全局 env 缺省 2");
    assert(maxHeadcountWorkers() === 2, "maxHeadcountWorkers 读 env=2");

    // ---- H2 触顶全忙排队（FIFO + queued 台账行 + 队列文件持久） ----
    console.log("H2 触顶全忙排队");
    const r3 = mgr.dispatchWorker({ anchor, gid, prompt: "任务三", title: "T3" });
    assert(r3.ok && (r3 as { queued?: boolean }).queued === true, "第三单触顶转排队（queued:true）");
    assert(r3.ok && (r3 as { session_id: string }).session_id === "", "排队单无承接会话");
    const ledger3 = readDispatchLog().find((e) => e.id === (r3.ok ? (r3 as { dispatch_id: string }).dispatch_id : ""));
    assert(ledger3?.status === "queued", "台账收敛行 status=queued");
    assert(loadDispatchQueue().length === 1, "队列文件持久 1 条");
    const r4 = mgr.dispatchWorker({ anchor, gid, prompt: "任务四", title: "T4" });
    assert(r4.ok && (r4 as { queued?: boolean }).queued === true, "第四单继续排队");
    assert(loadDispatchQueue()[0]?.dispatch_id === (r3.ok ? (r3 as { dispatch_id: string }).dispatch_id : ""), "FIFO 保序（先到的在队首）");
    assert(loadDispatchQueue().length === 2, "队列 2 条");

    // ---- H3 收口释放排水（w1 收口 → 队列单复用 w1，零扩编） ----
    console.log("H3 收口释放排水");
    const d3 = r3.ok ? (r3 as { dispatch_id: string }).dispatch_id : "";
    const d4 = r4.ok ? (r4 as { dispatch_id: string }).dispatch_id : "";
    const dump = (tag: string) => {
      const g = findGroup(gid);
      console.log(`    [dump ${tag}] agents=${created.length} 泛worker=${g ? genericWorkerCount(g.headcount) : "?"} members=[${g?.headcount.map((x) => x.session_id.slice(0, 6)).join(",")}] queue=[${loadDispatchQueue().map((x) => x.dispatch_id.slice(0, 6)).join(",")}] d3=${readDispatchLog().find((e) => e.id === d3)?.status}/${readDispatchLog().find((e) => e.id === d3)?.session_id?.slice(0, 6)} d4=${readDispatchLog().find((e) => e.id === d4)?.status}/${readDispatchLog().find((e) => e.id === d4)?.session_id?.slice(0, 6)}`);
    };
    dump("H3前");
    created[0].cb.onTurnEnd(true, "success", 5); // w1 交付收口
    await wait(80); // microtask 排水 + resume init
    dump("w1收口后");
    const g3 = findGroup(gid)!;
    assert(genericWorkerCount(g3.headcount) === 2, `排水复用零扩编（泛 worker=2，实际 ${genericWorkerCount(g3.headcount)}）`);
    assert(loadDispatchQueue().length === 1, `队列排空至 1（实际 ${loadDispatchQueue().length}）`);
    const led3 = readDispatchLog().find((e) => e.id === d3);
    assert(led3?.status === "running" && led3.session_id === (r1.ok ? r1.session_id : ""), `队首单收敛 running 承接=w1（实际 ${led3?.status}/${led3?.session_id?.slice(0, 8)}）`);
    // w1 resume 流（created 末位）收口 → 台账 done
    created[created.length - 1].cb.onTurnEnd(true, "success", 5);
    await wait(60);
    dump("d3交付后");
    const led3b = readDispatchLog().find((e) => e.id === d3);
    assert(led3b?.status === "done", `复用单交付后台账 done（实际 ${led3b?.status}）`);
    assert(loadDispatchQueue().length === 0, `队列最终排空（实际 ${loadDispatchQueue().length}）`);
    const led4 = readDispatchLog().find((e) => e.id === d4);
    assert(led4?.status === "running" || led4?.status === "done", `第二排队单接续（实际 ${led4?.status ?? "无"}）`);
    if (led4?.status === "running") {
      created[created.length - 1].cb.onTurnEnd(true, "success", 5);
      await wait(40);
      dump("d4交付后");
    }

    // ---- H4 cap-set 组级覆盖与清除 ----
    console.log("H4 cap-set");
    const cs1 = mgr.orgAction("cap-set", { gid, cap: 5 });
    assert(cs1.ok, "cap-set 5 受理");
    assert(headcountCapOf(findGroup(gid)!) === 5, "组级覆盖生效（5）");
    const cs2 = mgr.orgAction("cap-set", { gid, cap: 0 });
    assert(cs2.ok && headcountCapOf(findGroup(gid)!) === 2, "cap≤0 清除回全局缺省（2）");

    // ---- H5 member-add 上限闸（泛 worker 拒 / 命名角色豁免） ----
    console.log("H5 member-add 闸");
    const gFull = findGroup(gid)!; // 泛 worker=2 已满
    assert(genericWorkerCount(gFull.headcount) === 2, "前置：泛 worker 满 2 席");
    const m1 = addMember(gid, "ghost-sid-extra", "worker");
    assert(!m1.ok && (m1.error ?? "").includes("上限"), "泛 worker 触顶拒绝（上限闸）");
    const m2 = addMember(gid, "ghost-sid-named", "桌面UI工程师");
    assert(m2.ok, "命名角色不占泛用席位（豁免入编）");
    const m3 = addMember(gid, r1.ok ? r1.session_id : "", "worker", { nick: "老熟人" });
    assert(m3.ok, "已在编席位更新分支不触闸");

    // ---- H6 planHeadcountTrim 纯函数 ----
    console.log("H6 planHeadcountTrim 纯函数");
    const now = Date.now();
    const HOUR = 3_600_000;
    const hc = [
      { session_id: "a-named", role: "观察员" },
      { session_id: "a-live", role: "worker" },
      { session_id: "a-recent", role: "worker" },
      { session_id: "a-stale", role: "worker" },
      { session_id: "a-ghost", role: "worker" },
    ];
    const plan = planHeadcountTrim({
      headcount: hc,
      isLiveSession: (sid) => sid === "a-live",
      lastActiveOf: (sid) => (sid === "a-recent" ? now - HOUR : sid === "a-stale" ? now - 72 * HOUR : 0),
      now,
    });
    assert(plan.keep.map((x) => x.session_id).join(",") === "a-named,a-live,a-recent", "保留：命名/存活/24h 内活动");
    assert(plan.trimmed.map((x) => x.entry.session_id).join(",") === "a-stale,a-ghost", "裁剪：过期/无记录");
    assert(plan.trimmed[0]?.reason.includes("3 天"), `过期原因带天数（实际「${plan.trimmed[0]?.reason}」）`);
    assert(plan.trimmed[1]?.reason.includes("无派单收口记录"), `无记录原因（实际「${plan.trimmed[1]?.reason}」）`);
    const b1 = planHeadcountTrim({ headcount: [{ session_id: "x", role: "worker" }], isLiveSession: () => false, lastActiveOf: () => now - 24 * HOUR + 60_000, now });
    const b2 = planHeadcountTrim({ headcount: [{ session_id: "x", role: "worker" }], isLiveSession: () => false, lastActiveOf: () => now - 24 * HOUR - 60_000, now });
    assert(b1.trimmed.length === 0 && b2.trimmed.length === 1, "24h 边界（线上保/线下裁）");

    // ---- H7 trimHeadcounts 编排（裁剪准确 + 报告落盘 + projects.json 收敛） ----
    console.log("H7 trimHeadcounts 编排");
    const cg2 = createGroup({ name: "Trim 目标组", anchor_dir: anchor2, tier: "轻立项" });
    const gid2 = cg2.ok ? cg2.group.id : "";
    setGroupStatus(gid2, "active");
    mgr.orgAction("cap-set", { gid: gid2, cap: 8 }); // 夹具搭建期临时抬上限（cap 闸对夹具同样生效）
    addMember(gid2, "sid-named", "观察员");
    const sLive = createSession(mgr, anchor2); // WORKING
    addMember(gid2, sLive, "worker");
    const sRecent = createSession(mgr, anchor2);
    const stRecent = sessionsOf(mgr).get(sRecent);
    if (stRecent) { stRecent.state.status = "DONE"; stRecent.state.updated_at = now - HOUR; } // 1h 前收工=近期
    addMember(gid2, sRecent, "worker");
    const sStale = createSession(mgr, anchor2);
    const stStale = sessionsOf(mgr).get(sStale);
    if (stStale) { stStale.state.status = "DONE"; stStale.state.updated_at = now - 72 * HOUR; } // 3 天前收工=过期
    addMember(gid2, sStale, "worker");
    addMember(gid2, "sid-ghost", "worker"); // 无会话卡
    mgr.orgAction("cap-set", { gid: gid2, cap: 0 }); // 清除临时上限回全局 2（H8/H9 的 cap 口径）
    assert(findGroup(gid2)?.headcount.length === 5, "前置：目标组 5 席（1 命名+4 泛）");
    const tr = mgr.trimHeadcounts();
    const tg = tr.data.groups.find((x) => x.gid === gid2);
    assert(tr.ok && !!tg, "裁剪编排出报告");
    assert(tg?.before === 5 && tg?.after === 3, `5→3（实际 ${tg?.before}→${tg?.after}）`);
    assert(tg?.trimmed.map((x) => x.session_id).sort().join(",") === [sStale, "sid-ghost"].sort().join(","), "裁剪对象=过期会话席+幽灵席");
    assert(findGroup(gid2)?.headcount.map((x) => x.session_id).sort().join(",") === [sLive, sRecent, "sid-named"].sort().join(","), "projects.json 收敛（named/live/recent 保留）");
    const report = readJson(join(ORG, "headcount-trim-report.json")) as { groups?: { gid: string; trimmed: unknown[] }[] } | null;
    assert(!!report && (report.groups ?? []).some((x) => x.gid === gid2 && x.trimmed.length === 2), "裁剪报告落盘 org/headcount-trim-report.json");
    // dryRun 不动盘
    const tr2 = mgr.trimHeadcounts({ dryRun: true });
    assert(tr2.data.totalTrimmed === 0, "收敛后重扫零裁剪（幂等）");

    // ---- H8 触顶先清后判（过期席清理腾名额 → 正常新建，PM 补充③） ----
    console.log("H8 触顶先清后判");
    // gid2 现状：泛 worker=live(WORKING)+recent(DONE 近期) = 2 = cap
    const spawnH8 = created.length;
    const stRecent2 = sessionsOf(mgr).get(sRecent);
    if (stRecent2) { stRecent2.state.status = "DONE"; stRecent2.state.updated_at = now - 72 * HOUR; } // recent 也过期
    const rH8 = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "触顶先清验证", title: "H8" });
    assert(rH8.ok && !("queued" in rH8 && rH8.queued), "触顶单未被排队（清理腾出名额后正常派发）");
    assert(created.length === spawnH8 + 1, `过期席清理后新建承接（spawn ${spawnH8}→${created.length}）`);
    const gH8 = findGroup(gid2)!;
    assert(!gH8.headcount.some((x) => x.session_id === sRecent), "过期旧席已被裁出编制");
    assert(genericWorkerCount(gH8.headcount) === 2, `清理后泛 worker 回到 cap 内（${genericWorkerCount(gH8.headcount)}）`);
    await wait(30);

    // ---- H9 触顶复用（全忙+触顶 → 复用 idle 席；resume 非 spawn） ----
    console.log("H9 触顶复用");
    // gid2：live(WORKING) + H8 新会话满 2；先让 H8 单交付（清在途派单+留路由），
    // 再把 H8 会话改 DONE→idle（live 保持 WORKING）
    const sH8 = rH8.ok ? rH8.session_id : "";
    const h8AgentIdx = created.findIndex((x) => x.cwd === anchor2 && x.resume === undefined && x.prompt?.includes("触顶先清验证"));
    if (h8AgentIdx >= 0) created[h8AgentIdx].cb.onTurnEnd(true, "success", 5);
    await wait(40);
    const stH8 = sessionsOf(mgr).get(sH8);
    if (stH8) { stH8.state.status = "DONE"; stH8.state.updated_at = now - 2 * HOUR; }
    const spawnH9 = created.length;
    const rH9 = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "触顶复用验证", title: "H9" });
    assert(rH9.ok && (rH9 as { queued?: boolean }).queued !== true, "触顶但有空闲 → 复用不排队");
    assert(rH9.ok && rH9.session_id === sH8, `复用 idle 最久泛 worker（实际 ${rH9.ok ? rH9.session_id.slice(0, 8) : "?"}）`);
    // 复用=resume 同会话（factory 会为 resume 造新 AgentLike 实例——会话 id 不变才是语义）
    const gH9 = findGroup(gid2)!;
    assert(genericWorkerCount(gH9.headcount) === 2 && rH9.ok && findGroup(gid2)!.headcount.some((x) => x.session_id === sH8), "复用零扩编（泛 worker 恒 2，承接席在编）");

    // ---- H10 member-retire 腾名额排水（除名即试排，队列接续新建） ----
    console.log("H10 member-retire 排水");
    // gid2：H9 单在 sH8 上 running；live 在忙。再派一单 → 触顶全忙 → 排队
    const rH10 = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "退休排水验证", title: "H10" });
    assert(rH10.ok && (rH10 as { queued?: boolean }).queued === true, "前置：触顶全忙排队");
    const dH10 = rH10.ok ? (rH10 as { dispatch_id: string }).dispatch_id : "";
    const spawnH10 = created.length;
    const ret = mgr.orgAction("member-retire", { gid: gid2, sid: sH8, reason: "测试退休" });
    assert(ret.ok, "member-retire 受理");
    await wait(60);
    console.log(`    [dump H10] queue=[${loadDispatchQueue().map((x) => x.dispatch_id.slice(0, 6)).join(",")}] mem=[${(mgr as unknown as { dispatchQueueItems: QueuedDispatchLike[] }).dispatchQueueItems.map((x) => x.dispatch_id.slice(0, 6)).join(",")}] dH10=${readDispatchLog().find((e) => e.id === dH10)?.status}`);
    assert(loadDispatchQueue().length === 0, "除名腾名额后队列排空");
    assert(created.length === spawnH10 + 1, `排水新建承接（spawn ${spawnH10}→${created.length}）`);
    const ledH10 = readDispatchLog().find((e) => e.id === dH10);
    assert(ledH10?.status === "running", `排队单接续 running（实际 ${ledH10?.status ?? "无"}）`);
  } finally {
    // 环境还原
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevCap === undefined) delete process.env.CCR_ORG_HEADCOUNT_CAP; else process.env.CCR_ORG_HEADCOUNT_CAP = prevCap;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
    if (prevCwd === undefined) delete process.env.CCR_CWD; else process.env.CCR_CWD = prevCwd;
    if (prevNoTrim === undefined) delete process.env.CCR_NO_HEADCOUNT_TRIM; else process.env.CCR_NO_HEADCOUNT_TRIM = prevNoTrim;
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n结果：${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
