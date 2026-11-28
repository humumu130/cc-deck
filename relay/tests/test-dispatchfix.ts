// W-DISPATCHFIX（1120 用户军令级·治本单 t-dispatchfix）：派单链状态一致性断言套件。
// 三现（板面/派单表象与实际不符——每次靠人工戳穿）治本面：
//   S1 queued 语义修真——帽满排队按真活性分叉（seats-busy vs pool-empty），假「全忙」退役
//   S2 同 slug 去重闸——queued/claimed 在途再派拒收（板面零重复记账；帽分支入队前掐死）
//   S3 池空窗自动拉起——claude -p 形态（mock bin）消费队首：queued→running(headless)→done
//      全台账链+板卡翻态+日志落盘
//   S4 锁 GC——终态单锁自动清（脏树守卫）+ 弃单哨兵锁随驱逐清（119min 死等形态退役）
//   S5 sweep 兜底拉起——已排队+池空（非 enqueue 时点）周期拍自动起消费者
//   S6 活性真态穿透——displayLiveness/snapshot/心跳帧（WORKING 假态照妖镜）
//   S7 org 面真态——status open 含 queued+worker_liveness；detail pool[].liveness
//   S8 重启窗孤儿双跑面（返修 fix1·P1-1）——boot 清扫活守卫（pid 活不收口/pid 死照常
//      +rc 还原 exit 语义）+sweep 重挂收口（pid 退按 rc done/failed+在途计数回填）
//      +slug 闸孤儿查重（行态异常不放行）+worktree 锁认领/让位
//      h) 收口后可再拉起（返修 fix2·r2 P1）——在途账派生非累积：真拉起→模拟重启→pid 退
//      （done/failed/中断三形态）→收口→在途归零→再派单新拉起成功；闸前刷新不等拍；
//      手工清零位退役（fix1 在 S8 g 段首的手工清零=把「收口后计数应自行回落」洗出断言面）
// agentFactory 测试缝（不拉真 CLI），范式同 test-drainfix.ts / test-headcount.ts。
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawn as childSpawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import type { Envelope } from "../src/types.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import type { DispatchTier } from "../src/org.js";
import { createGroup, findGroup, setGroupStatus } from "../src/projects.js";
import { loadDispatchQueue } from "../src/dispatch-queue.js";
import { loadBoard, upsertBoardEntry } from "../src/projects.js";
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
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await wait(100); }
  return pred();
}

// 假 agent 工厂（test-drainfix 同款）：init 10ms 后 onInit；回合终态不自动发。
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

// 私有态测试缝（运行时 JS 不设私有栅栏——test-drainfix 同范式）
type SessionRec = { state: { status: string; session_id: string; cli_pid?: number; updated_at?: number; project_gid?: string }; agent?: { ended: boolean } };
const sessionsOf = (mgr: SessionManager): Map<string, SessionRec> => (mgr as unknown as { sessions: Map<string, SessionRec> }).sessions;
const queueOf = (mgr: SessionManager): QueuedDispatchLike[] => (mgr as unknown as { dispatchQueueItems: QueuedDispatchLike[] }).dispatchQueueItems;
const setQueue = (mgr: SessionManager, items: QueuedDispatchLike[]): void => { (mgr as unknown as { dispatchQueueItems: QueuedDispatchLike[] }).dispatchQueueItems = items; };
const clearFrameCache = (mgr: SessionManager): void => { ((mgr as unknown as { frameAgeCache: Map<string, unknown> }).frameAgeCache).clear(); };

/** 真活性击杀（fake-busy 形态注入）：agent 流断（ended）——activeManagedCount 照计
 *（agent 引用在+status WORKING），realLiveness 掉 dead（pid=0 无流+帧龄超窗）。 */
const killTruth = (mgr: SessionManager, sid: string): void => {
  const s = sessionsOf(mgr).get(sid);
  if (s?.agent) s.agent.ended = true;
};

const ledOf = (id: string) => readDispatchLog().find((e) => e.id === id);

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-dispatchfix-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-dispatchfix-"));
  const WT = mkdtempSync(join(tmpdir(), "ccr-wt-dispatchfix-"));
  const prevEnv: Record<string, string | undefined> = {
    CCR_WORKER_CONCURRENCY_CAP: process.env.CCR_WORKER_CONCURRENCY_CAP,
    CCR_ORG_DIR: process.env.CCR_ORG_DIR,
    CCR_ORG_HEADCOUNT_CAP: process.env.CCR_ORG_HEADCOUNT_CAP,
    CCR_ORG_MAX_GROUPS: process.env.CCR_ORG_MAX_GROUPS,
    CCR_NO_TITLE_GEN: process.env.CCR_NO_TITLE_GEN,
    CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE,
    CCR_CWD: process.env.CCR_CWD,
    CCR_NO_HEADCOUNT_TRIM: process.env.CCR_NO_HEADCOUNT_TRIM,
    CCR_NO_DISPATCH_SWEEP: process.env.CCR_NO_DISPATCH_SWEEP,
    CCR_DISPATCH_SWEEP_MIN: process.env.CCR_DISPATCH_SWEEP_MIN,
    CCR_WT_ROOT: process.env.CCR_WT_ROOT,
    CCR_NO_HEADLESS_SPAWN: process.env.CCR_NO_HEADLESS_SPAWN,
    CCR_HEADLESS_CLAUDE: process.env.CCR_HEADLESS_CLAUDE,
  };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ORG_HEADCOUNT_CAP = "8";
  process.env.CCR_ORG_MAX_GROUPS = "20"; // 八组隔离（缺省 5 会在 S5 后撞并行组护栏——cg.ok=false 静默吞 gid）
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_NO_HEADCOUNT_TRIM = "1";
  process.env.CCR_NO_DISPATCH_SWEEP = "1"; // 全程手动 sweep（S5 显式调）
  process.env.CCR_WT_ROOT = WT;
  delete process.env.CCR_CWD;
  process.env.CCR_NO_HEADLESS_SPAWN = "1"; // S1/S2 关（S3/S5 开）
  try {
    const cfg: RelayConfig = {
      port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null, accountToken: "",
    };
    const anchor = join(ORG, "anchor-repo");
    mkdirSync(anchor, { recursive: true });

    const created: Rec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));

    // ================= S1 queued 语义修真（验收①）=================
    console.log("S1 帽满排队按真活性分叉——seats-busy vs pool-empty");
    {
      process.env.CCR_WORKER_CONCURRENCY_CAP = "2";
      const cg = createGroup({ name: "语义组", anchor_dir: anchor, tier: "轻立项" });
      const gid = cg.ok ? cg.group.id : "";
      setGroupStatus(gid, "active");
      const r1 = mgr.dispatchWorker({ anchor, gid, prompt: "任务一", title: "T1" });
      const r2 = mgr.dispatchWorker({ anchor, gid, prompt: "任务二", title: "T2" });
      await wait(30);
      assert(r1.ok && r2.ok, "夹具：两单两 worker（在编在忙）");
      assert(mgr.activeManagedCount() === 2 && mgr.realActiveManagedCount() === 2, "夹具：status 口径=真活性口径=2（worker 真活）");
      // 真忙排队：queue_reason=seats-busy + active_workers=2
      const r3 = mgr.dispatchWorker({ anchor, gid, prompt: "任务三", title: "T3" }) as { ok: boolean; queued?: boolean; queue_reason?: string; active_workers?: number; dispatch_id?: string };
      assert(r3.ok && r3.queued === true && r3.queue_reason === "seats-busy", `真忙排队 queue_reason=seats-busy（实际 ${r3.queue_reason}）`);
      assert(r3.active_workers === 2, `active_workers 透传真值（实际 ${r3.active_workers}）`);
      assert((ledOf(r3.dispatch_id ?? "")?.receipt ?? "").includes("席位忙"), "queued 行 receipt 直说「席位忙」（不再假「全忙」）");
      // 击杀真活（status 不动——WORKING 假态），时间机器 +40min（帧龄超 5min 显示窗+30min 间隙窗）
      killTruth(mgr, r1.ok ? r1.session_id : "");
      killTruth(mgr, r2.ok ? r2.session_id : "");
      const realNow = Date.now;
      Date.now = () => realNow() + 40 * 60_000;
      try {
        clearFrameCache(mgr);
        assert(mgr.activeManagedCount() === 2, "status 口径仍 2（WORKING 假态——activeManagedCount 被死会话占满）");
        assert(mgr.realActiveManagedCount() === 0, `**真活性口径=0**（池空窗可判——实际 ${mgr.realActiveManagedCount()}）`);
        const r4 = mgr.dispatchWorker({ anchor, gid, prompt: "任务四", title: "T4" }) as { ok: boolean; queued?: boolean; queue_reason?: string; active_workers?: number; dispatch_id?: string };
        assert(r4.ok && r4.queued === true && r4.queue_reason === "pool-empty", `**池空窗排队 queue_reason=pool-empty**（实际 ${r4.queue_reason}——1120 晨「表象活席都在忙实际无消费者」退役）`);
        assert(r4.active_workers === 0, "active_workers=0 透传（PM 免猜）");
        assert((ledOf(r4.dispatch_id ?? "")?.receipt ?? "").includes("池空窗"), "queued 行 receipt 直说「池空窗」+headless 接管预告");
        // 清场：排队单逐出（后续段队列断言隔离）
        (mgr as unknown as { evictQueuedDispatch: (id: string) => number }).evictQueuedDispatch(r3.dispatch_id ?? "");
        (mgr as unknown as { evictQueuedDispatch: (id: string) => number }).evictQueuedDispatch(r4.dispatch_id ?? "");
      } finally { Date.now = realNow; }
    }

    // ================= S2 同 slug 去重闸（验收④）=================
    console.log("S2 同 slug 在途拒收——queued/claimed/帽分支三面");
    {
      process.env.CCR_WORKER_CONCURRENCY_CAP = "20";
      const anchor2 = join(ORG, "anchor-slug");
      mkdirSync(anchor2, { recursive: true });
      const cg2 = createGroup({ name: "去重组", anchor_dir: anchor2, tier: "轻立项" });
      const gid2 = cg2.ok ? cg2.group.id : "";
      setGroupStatus(gid2, "active");
      // a) claimed 在途：同 slug 再派拒收
      const ra = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "原单", title: "SA", slug: "dup-runx" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
      await wait(30);
      assert(ra.ok && ledOf(ra.dispatch_id ?? "")?.status === "running", "夹具：SA 在跑（dispatched 行带 slug）");
      assert(ledOf(ra.dispatch_id ?? "")?.slug === "dup-runx", "dispatched 行落 slug（查重锚入台账）");
      const rb = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "重派同 slug", title: "SA2", slug: "dup-runx" }) as { ok: boolean; error?: string; duplicate_of?: string };
      assert(rb.ok === false && rb.duplicate_of === ra.dispatch_id, `claimed 在途同 slug 拒收+duplicate_of（实际 ${JSON.stringify(rb)}）`);
      const gateRows = readDispatchLog().filter((e) => e.status === "failed" && e.target === "dispatch-gate" && e.slug === "dup-runx");
      assert(gateRows.length === 1, "拒收落 failed 记因行（可对账）");
      // b) 帽分支入队前掐死：帽满（cap=1）+ 同 slug 在途 → 不入队直接拒
      process.env.CCR_WORKER_CONCURRENCY_CAP = "1";
      const rc = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "撞帽重派", title: "SA3", slug: "dup-runx" }) as { ok: boolean; duplicate_of?: string };
      assert(rc.ok === false && rc.duplicate_of === ra.dispatch_id, "帽满分支同 slug 在入队前拒（不重复入队）");
      assert(queueOf(mgr).length === 0, `队列零重复条目（实际 ${queueOf(mgr).length}——板面不重复记账）`);
      process.env.CCR_WORKER_CONCURRENCY_CAP = "20";
      // c) queued 在途：排队单占 slug → 再派拒收
      const anchor3 = join(ORG, "anchor-slugq");
      mkdirSync(anchor3, { recursive: true });
      const cg3 = createGroup({ name: "排队去重组", anchor_dir: anchor3, tier: "轻立项" });
      const gid3 = cg3.ok ? cg3.group.id : "";
      setGroupStatus(gid3, "active");
      const qcap = mgr.orgAction("cap-set", { gid: gid3, cap: 1 });
      assert(qcap.ok, "夹具：cap=1");
      const rq1 = mgr.dispatchWorker({ anchor: anchor3, gid: gid3, prompt: "占位单", title: "SQ1" }) as { ok: boolean; session_id?: string; dispatch_id?: string };
      await wait(30);
      const rq2 = mgr.dispatchWorker({ anchor: anchor3, gid: gid3, prompt: "排队单", title: "SQ2", slug: "dup-queux" }) as { ok: boolean; queued?: boolean; dispatch_id?: string };
      assert(rq2.ok && rq2.queued === true && (ledOf(rq2.dispatch_id ?? "")?.slug === "dup-queux"), "夹具：SQ2 排队（queued 行带 slug）");
      const rq3 = mgr.dispatchWorker({ anchor: anchor3, gid: gid3, prompt: "再派同 slug", title: "SQ3", slug: "dup-queux" }) as { ok: boolean; duplicate_of?: string };
      assert(rq3.ok === false && rq3.duplicate_of === rq2.dispatch_id, `queued 在途同 slug 拒收（实际 ${JSON.stringify(rq3)}）`);
      assert(loadDispatchQueue().length === 1, "队列仍 1 条（零重复）");
      // 清场：腾出排队单（S3 用新组）
      (mgr as unknown as { evictQueuedDispatch: (id: string) => number }).evictQueuedDispatch(rq2.dispatch_id ?? "");
    }

    // ================= S3 池空窗自动拉起（验收②·mock bin）=================
    console.log("S3 池空窗自动拉起 headless 消费者（claude -p 形态·mock）");
    {
      const marker = join(DATA, "headless-marker.log");
      const mockBin = join(DATA, "mock-claude.sh");
      writeFileSync(mockBin, `#!/bin/bash\n# W-DISPATCHFIX 测试 mock：模拟 claude -p（吃 stdin/写标记/退出 0）\ncat > /dev/null\necho "mock-pid=$$ args=$*" >> ${JSON.stringify(marker)}\nexit 0\n`, { encoding: "utf-8", mode: 0o755 });
      chmodSync(mockBin, 0o755);
      delete process.env.CCR_NO_HEADLESS_SPAWN;
      process.env.CCR_HEADLESS_CLAUDE = mockBin;
      const anchor4 = join(ORG, "anchor-headless");
      mkdirSync(anchor4, { recursive: true });
      const cg4 = createGroup({ name: "拉起组", anchor_dir: anchor4, tier: "轻立项" });
      const gid4 = cg4.ok ? cg4.group.id : "";
      setGroupStatus(gid4, "active");
      const qcap4 = mgr.orgAction("cap-set", { gid: gid4, cap: 1 });
      assert(qcap4.ok, "夹具：cap=1");
      // 唯一 worker 假死占位：WORKING 滞留 + 真活性 dead（现三形态）
      const rh1 = mgr.dispatchWorker({ anchor: anchor4, gid: gid4, prompt: "占位者", title: "HA" }) as { ok: boolean; session_id?: string; dispatch_id?: string };
      await wait(30);
      killTruth(mgr, rh1.session_id ?? "");
      const realNow = Date.now;
      Date.now = () => realNow() + 40 * 60_000;
      let rh2: { ok: boolean; queued?: boolean; queue_reason?: string; active_workers?: number; dispatch_id?: string };
      try {
        clearFrameCache(mgr);
        rh2 = mgr.dispatchWorker({ anchor: anchor4, gid: gid4, prompt: "池空窗单", title: "HB", slug: "headless-one" }) as typeof rh2;
      } finally { Date.now = realNow; }
      assert(rh2.ok && rh2.queued === true && rh2.queue_reason === "pool-empty", "夹具：HB 池空窗排队（enqueue 边触发拉起）");
      const dHB = rh2.dispatch_id ?? "";
      assert(await waitFor(() => ledOf(dHB)?.status === "running" && ledOf(dHB)?.headless === true, 5000), `**headless 拉起记账**：HB → running 行带 headless:true（实际 ${ledOf(dHB)?.status}/${ledOf(dHB)?.headless}）`);
      const runningRow = readDispatchLog().find((e) => e.id === dHB && e.headless === true);
      assert(!!runningRow && (runningRow.receipt ?? "").includes("claude -p"), "running 行 receipt 记 claude -p 形态+日志路径");
      assert(await waitFor(() => existsSync(marker), 5000), "mock 消费者真被拉起（标记文件落盘）");
      assert(await waitFor(() => ledOf(dHB)?.status === "done", 5000), `**headless 消费收口**：rc=0 → done（实际 ${ledOf(dHB)?.status}）`);
      const logDir = join(DATA, "headless-workers");
      assert(existsSync(logDir) && readFileSync(marker, "utf-8").includes("mock-pid"), "日志目录+标记内容在（日志落盘验收点）");
      const board = loadBoard(gid4);
      const card = board.entries.find((x) => x.dispatch_id === dHB);
      assert(card?.status === "done", `板卡随收口翻 done（实际 ${card?.status}——板面不悬账）`);
      assert(queueOf(mgr).length === 0, "队列排空（队首被消费者接管）");
      // 拉起失败升级面：CCR_HEADLESS_CLAUDE 指向不存在路径 → 预检失败升级+单留队列
      const missing = join(DATA, "no-such-bin");
      const prevHeadless = process.env.CCR_HEADLESS_CLAUDE;
      process.env.CCR_HEADLESS_CLAUDE = missing;
      const anchor5 = join(ORG, "anchor-hfail");
      mkdirSync(anchor5, { recursive: true });
      const cg5 = createGroup({ name: "失败升级组", anchor_dir: anchor5, tier: "轻立项" });
      const gid5 = cg5.ok ? cg5.group.id : "";
      setGroupStatus(gid5, "active");
      mgr.orgAction("cap-set", { gid: gid5, cap: 1 });
      const rf1 = mgr.dispatchWorker({ anchor: anchor5, gid: gid5, prompt: "占位者二", title: "FA" }) as { ok: boolean; session_id?: string };
      await wait(30);
      killTruth(mgr, rf1.session_id ?? "");
      const realNow2 = Date.now;
      Date.now = () => realNow2() + 40 * 60_000;
      let rf2: { ok: boolean; queued?: boolean; dispatch_id?: string };
      try {
        clearFrameCache(mgr);
        rf2 = mgr.dispatchWorker({ anchor: anchor5, gid: gid5, prompt: "失败单", title: "FB" }) as typeof rf2;
      } finally { Date.now = realNow2; }
      assert(rf2.ok && rf2.queued === true, "夹具：FB 池空窗排队（拉起将失败）");
      assert(queueOf(mgr).length >= 1 && ledOf(rf2.dispatch_id ?? "")?.status === "queued", "**拉起失败不丢单**：FB 留队列等退避重试（台账仍 queued）");
      process.env.CCR_HEADLESS_CLAUDE = prevHeadless;
      // 清场
      (mgr as unknown as { evictQueuedDispatch: (id: string) => number }).evictQueuedDispatch(rf2.dispatch_id ?? "");
    }

    // ================= S4 锁 GC（验收⑤）=================
    console.log("S4 终态单锁 GC + 弃单哨兵锁随驱逐清");
    {
      // a) 终态 id 锁 → 自动清
      const dir1 = join(WT, "cc-deck-w-gc-clean");
      mkdirSync(dir1, { recursive: true });
      const tid1 = randomUUID();
      appendDispatch({ ts: Date.now(), id: tid1, tier: "轻立项", target: "gc-test", status: "failed", receipt: "终态（测试注入）", session_id: "" });
      writeFileSync(join(dir1, ".cc-deck-lock"), JSON.stringify({ slug: "gc-clean", dispatch_id: tid1, created_at: Date.now(), expires_at: Date.now() + 2 * 3600_000 }), "utf-8");
      const cleared = mgr.gcTerminalWorktreeLocks();
      assert(cleared >= 1 && !existsSync(join(dir1, ".cc-deck-lock")), `**终态单锁自动清**（实际 cleared=${cleared}——119min 死等形态退役）`);
      // b) 脏树守卫：终态但树脏 → 锁留守（W-TREEGC 占位牌语义）
      const dir2 = join(WT, "cc-deck-w-gc-dirty");
      mkdirSync(dir2, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: dir2 });
      execFileSync("git", ["-C", dir2, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"]); // CI runner 无 git identity——inline -c 免配置依赖
      const tid2 = randomUUID();
      appendDispatch({ ts: Date.now(), id: tid2, tier: "轻立项", target: "gc-test", status: "done", receipt: "终态（测试注入）", session_id: "" });
      writeFileSync(join(dir2, ".cc-deck-lock"), JSON.stringify({ slug: "gc-dirty", dispatch_id: tid2, created_at: Date.now(), expires_at: Date.now() + 2 * 3600_000 }), "utf-8");
      writeFileSync(join(dir2, "uncommitted.txt"), "脏树证据", "utf-8");
      mgr.gcTerminalWorktreeLocks();
      assert(existsSync(join(dir2, ".cc-deck-lock")), "脏树不清锁（交付物防裸奔守卫保持）");
      // c) 在途 id 锁不动（非终态）
      const dir3 = join(WT, "cc-deck-w-gc-live");
      mkdirSync(dir3, { recursive: true });
      const tid3 = randomUUID();
      appendDispatch({ ts: Date.now(), id: tid3, tier: "轻立项", target: "gc-test", status: "running", receipt: "在跑", session_id: "x" });
      writeFileSync(join(dir3, ".cc-deck-lock"), JSON.stringify({ slug: "gc-live", dispatch_id: tid3, created_at: Date.now(), expires_at: Date.now() + 2 * 3600_000 }), "utf-8");
      mgr.gcTerminalWorktreeLocks();
      assert(existsSync(join(dir3, ".cc-deck-lock")), "在途单锁不动（只 GC 终态）");
      // d) 弃单哨兵锁随驱逐清
      const dir4 = join(WT, "cc-deck-w-gc-evict");
      mkdirSync(dir4, { recursive: true });
      writeFileSync(join(dir4, ".cc-deck-lock"), JSON.stringify({ slug: "evict-me", created_at: Date.now(), expires_at: Date.now() + 2 * 3600_000 }), "utf-8");
      const evictId = randomUUID();
      setQueue(mgr, [{ dispatch_id: evictId, enqueued_at: Date.now(), input: { anchor: anchor, prompt: "弃单", slug: "evict-me", worktree: dir4 } }]);
      const n = (mgr as unknown as { evictQueuedDispatch: (id: string) => number }).evictQueuedDispatch(evictId);
      assert(n === 1 && !existsSync(join(dir4, ".cc-deck-lock")), "**弃单哨兵锁随驱逐清**（排队侧 119min 变体退役）");
    }

    // ================= S5 sweep 兜底拉起（验收②续）=================
    console.log("S5 周期拍池空窗兜底（已排队+池死透→自动起消费者）");
    {
      (mgr as unknown as { headlessSpawnCooldownUntil: number }).headlessSpawnCooldownUntil = 0; // S3 失败升级的退避清位（隔离）
      assert(mgr.headlessInFlight() === 0, `**自家消费者退出后在途归零**（S3 收口后零残留，无手工清零——实际 ${mgr.headlessInFlight()}）`);
      const marker5 = join(DATA, "headless-marker-s5.log");
      const mockBin5 = join(DATA, "mock-claude-s5.sh");
      writeFileSync(mockBin5, `#!/bin/bash\ncat > /dev/null\necho "s5-pid=$$" >> ${JSON.stringify(marker5)}\nexit 0\n`, { encoding: "utf-8", mode: 0o755 });
      chmodSync(mockBin5, 0o755);
      process.env.CCR_HEADLESS_CLAUDE = mockBin5;
      const anchor6 = join(ORG, "anchor-sweep");
      mkdirSync(anchor6, { recursive: true });
      const cg6 = createGroup({ name: "sweep组", anchor_dir: anchor6, tier: "轻立项" });
      const gid6 = cg6.ok ? cg6.group.id : "";
      setGroupStatus(gid6, "active");
      mgr.orgAction("cap-set", { gid: gid6, cap: 1 });
      const rs1 = mgr.dispatchWorker({ anchor: anchor6, gid: gid6, prompt: "占位者三", title: "SWA" }) as { ok: boolean; session_id?: string };
      await wait(30);
      killTruth(mgr, rs1.session_id ?? "");
      // 注入已排队单（非 enqueue 时点形态：排队在先、池后死透）
      const injId = randomUUID();
      setQueue(mgr, [{ dispatch_id: injId, enqueued_at: Date.now(), input: { anchor: anchor6, gid: gid6, prompt: "sweep 兜底单", title: "SWB", slug: "sweep-one" } }]);
      const realNow = Date.now;
      Date.now = () => realNow() + 40 * 60_000;
      try {
        clearFrameCache(mgr);
        const res = mgr.sweepDispatchQueueOnce();
        assert(res.triggered === true, "sweep 触发（队列非空）");
      } finally { Date.now = realNow; }
      assert(await waitFor(() => ledOf(injId)?.status === "done", 8000), `**sweep 兜底拉起消费**：注入单 → headless → done（实际 ${ledOf(injId)?.status}）`);
      assert(await waitFor(() => existsSync(marker5), 5000), "s5 消费者标记在（真拉起非纸面）");
    }

    // ================= S6 活性真态穿透（验收③）=================
    console.log("S6 displayLiveness/snapshot/心跳帧——WORKING 假态照妖镜");
    {
      const anchor7 = join(ORG, "anchor-live");
      mkdirSync(anchor7, { recursive: true });
      const cg7 = createGroup({ name: "活性组", anchor_dir: anchor7, tier: "轻立项" });
      const gid7 = cg7.ok ? cg7.group.id : "";
      setGroupStatus(gid7, "active");
      const rl1 = mgr.dispatchWorker({ anchor: anchor7, gid: gid7, prompt: "活性单", title: "LA" }) as { ok: boolean; session_id?: string };
      await wait(30);
      const sidA = rl1.session_id ?? "";
      const snapAlive = mgr.snapshot().find((s) => s.session_id === sidA);
      assert(snapAlive?.liveness === "alive", `活 worker 快照 liveness=alive（实际 ${snapAlive?.liveness}）`);
      // 心跳帧捎带
      let hbLive = "";
      const off = bus.subscribe((env: Envelope) => { if (env.type === "SESSION_HEARTBEAT" && env.session_id === sidA) hbLive = String((env.payload as { liveness?: string }).liveness ?? ""); });
      (mgr as unknown as { heartbeat: () => void }).heartbeat();
      off();
      assert(hbLive === "alive", `心跳帧捎带 liveness=alive（实际 ${hbLive}）`);
      // 击杀+6min（>5min 显示窗）：pid=0+agent 在（流断）→ 不给 between-turns 缓冲 → dead
      killTruth(mgr, sidA);
      const realNow = Date.now;
      Date.now = () => realNow() + 6 * 60_000;
      try {
        clearFrameCache(mgr);
        const snapDead = mgr.snapshot().find((s) => s.session_id === sidA);
        assert(snapDead?.liveness === "dead", `**死 worker 显示级 5min 内显停摆**（实际 ${snapDead?.liveness}——1119 夜 80min 盲区根治的数据面）`);
      } finally { Date.now = realNow; }
      // 复活帧自愈：worker 回活（回合帧新鲜）→ alive
      bus.emit(sidA, "SESSION_UPDATED", { status: "WORKING", action_summary: "复活帧（测试注入）" });
      clearFrameCache(mgr);
      const snapRevive = mgr.snapshot().find((s) => s.session_id === sidA);
      assert(snapRevive?.liveness === "alive", "帧回新鲜即复活（误杀自愈面）");
    }

    // ================= S7 org 面真态（验收③·dispatch 单态同源）=================
    console.log("S7 org status/detail 真态——claimed×worker 死=失联非在跑");
    {
      const anchor8 = join(ORG, "anchor-detail");
      mkdirSync(anchor8, { recursive: true });
      const cg8 = createGroup({ name: "detail组", anchor_dir: anchor8, tier: "轻立项" });
      const gid8 = cg8.ok ? cg8.group.id : "";
      setGroupStatus(gid8, "active");
      const rd1 = mgr.dispatchWorker({ anchor: anchor8, gid: gid8, prompt: "detail 单", title: "DA" }) as { ok: boolean; session_id?: string; dispatch_id?: string };
      await wait(30);
      // 活态面（正常时间）：claimed 行 worker_liveness=alive + pool[].liveness 全携带
      const detail = mgr.orgAction("project-detail", { id: gid8 }) as { ok: boolean; data?: { pool?: { liveness?: string }[]; receipts?: { status?: string; worker_liveness?: string }[] } };
      const dd = detail.data ?? {};
      assert((dd.pool ?? []).every((p) => typeof p.liveness === "string"), "detail pool[].liveness 全场携带（板面成员活性列数据源）");
      assert((dd.receipts ?? []).some((r) => r.status === "running" && r.worker_liveness === "alive"), "receipts claimed 行带 worker_liveness（失联态数据源）");
      // 失联面：击杀真活+时间机器 → status/detail 的 claimed 行显 dead（非「在跑」）
      for (const s of sessionsOf(mgr).values()) { if (s.agent) s.agent.ended = true; } // 全池击杀（前面段落遗留 worker 一并死透——real=0 断言前提）
      const realNow = Date.now;
      Date.now = () => realNow() + 40 * 60_000;
      try {
        clearFrameCache(mgr);
        const st = mgr.orgAction("status", {}) as { ok: boolean; data?: { open?: { id: string; status: string; worker_liveness?: string }[]; workers_real_active?: number; workers_status_active?: number } };
        const d = st.data ?? {};
        assert(typeof d.workers_real_active === "number" && typeof d.workers_status_active === "number", "status 带 workers_real_active/workers_status_active（PM 一眼判死等）");
        assert(d.workers_real_active === 0 && (d.workers_status_active ?? 0) > 0, `**真活 0/status 口径>N**——池空窗可判（实际 real=${d.workers_real_active} status=${d.workers_status_active}）`);
        const mine = (d.open ?? []).find((e) => e.id === rd1.dispatch_id);
        assert(mine?.status === "running" && mine?.worker_liveness === "dead", `**claimed×worker 死 → worker_liveness=dead（失联非在跑）**（实际 ${mine?.status}/${mine?.worker_liveness}）`);
        const detail2 = mgr.orgAction("project-detail", { id: gid8 }) as { ok: boolean; data?: { receipts?: { id?: string; worker_liveness?: string }[] } };
        const row2 = (detail2.data?.receipts ?? []).find((r) => r.id === rd1.dispatch_id);
        assert(row2?.worker_liveness === "dead", "detail receipts 失联行同源（claimed×dead）");
      } finally { Date.now = realNow; }
    }

    // ================= S8 重启窗孤儿双跑面（返修 fix1·P1-1）=================
    console.log("S8 headless 重启窗——boot 清扫活守卫+重挂收口+slug 孤儿闸+锁认领+收口后可再拉起");
    {
      // ── 夹具底座：组+板卡（收口翻态断言锚）+ 行注入器 + 牺牲子进程（真活/真死 pid）──
      const anchor9 = join(ORG, "anchor-restart");
      mkdirSync(anchor9, { recursive: true });
      const cg9 = createGroup({ name: "重启窗组", anchor_dir: anchor9, tier: "轻立项" });
      const gid9 = cg9.ok ? cg9.group.id : "";
      setGroupStatus(gid9, "active");
      const mkCard = (id: string, text: string): void => { upsertBoardEntry(gid9, { id, text, status: "claimed", owner_session: "", dispatch_id: id }); };
      const cardOf = (id: string): { status?: string } | undefined => loadBoard(gid9).entries.find((x) => x.dispatch_id === id);
      const mkHeadlessRow = (id: string, pid: number, slug: string): void => {
        appendDispatch({ ts: Date.now(), id, tier: "轻立项" as DispatchTier, target: `headless:${pid}`, status: "running", event: "dispatch-headless", receipt: `池空窗 headless（pid=${pid}，重启窗测试注入）`, session_id: "", project_anchor: anchor9, actor: "leader", headless: true, slug });
      };
      const rcOf = (id: string): string => join(DATA, "headless-workers", `${id.slice(0, 8)}.rc`);
      const closeHung = (): void => { (mgr as unknown as { closeHungDispatchRows: () => void }).closeHungDispatchRows(); };

      // a) boot 清扫活守卫：pid 活（本测试进程）→ 行不收口（审查 P1-1 主形态）
      const hidA = randomUUID();
      mkCard(hidA, "重启窗单A");
      mkHeadlessRow(hidA, process.pid, "restart-orphan-a");
      closeHung();
      assert(ledOf(hidA)?.status === "running", `**boot 清扫活守卫**：headless pid 活=行保持 running 不误收口（实际 ${ledOf(hidA)?.status}）`);
      assert(cardOf(hidA)?.status === "claimed", "活孤儿板卡不动（在跑不说中断——面板所见即真实）");

      // b) sweep 重挂收口拍：pid 活 → 行保持+在途计数回填；pid 退+rc=0 → done
      const victim = childSpawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
      const vpid = victim.pid ?? 0;
      const exited = new Promise<void>((res) => victim.once("exit", () => res()));
      const hidB = randomUUID();
      mkCard(hidB, "重启窗单B");
      mkHeadlessRow(hidB, vpid, "restart-orphan-b");
      const sw1 = mgr.sweepHeadlessRows();
      assert(sw1.live >= 1 && ledOf(hidB)?.status === "running", `**sweep poll 活 pid 不收口**（live=${sw1.live}，实际 ${ledOf(hidB)?.status}）`);
      assert(mgr.headlessInFlight() >= 1, "在途计数回填（重启后归零的孤儿并入并发帽口径）");
      const inFlightAtBackfill = mgr.headlessInFlight();
      victim.kill("SIGKILL");
      await exited; // 回收后 pid 真死（kill-0 ESRCH）
      writeFileSync(rcOf(hidB), "0", "utf-8");
      const sw2 = mgr.sweepHeadlessRows();
      assert(sw2.closed >= 1 && ledOf(hidB)?.status === "done", `**pid 退+rc=0 → done**（exit 语义还原——实际 ${ledOf(hidB)?.status}）`);
      assert(mgr.headlessInFlight() === inFlightAtBackfill - 1, `**孤儿收口后在途随之回落**（${inFlightAtBackfill}→${mgr.headlessInFlight()}，余活孤儿 hidA——派生非累积，返修 fix2）`);
      assert((ledOf(hidB)?.receipt ?? "").includes("rc=0"), "收口行记 rc（对账锚）");
      assert(cardOf(hidB)?.status === "done", "板卡随 rc=0 翻 done");

      // c) rc≠0 → failed+板回待办+同款退避
      const hidC = randomUUID();
      mkCard(hidC, "重启窗单C");
      mkHeadlessRow(hidC, vpid, "restart-orphan-c"); // vpid 已死（复用牺牲 pid）
      writeFileSync(rcOf(hidC), "3", "utf-8");
      mgr.sweepHeadlessRows();
      assert(ledOf(hidC)?.status === "failed" && cardOf(hidC)?.status === "backlog", `**pid 退+rc=3 → failed+板回待办**（实际 ${ledOf(hidC)?.status}/${cardOf(hidC)?.status}）`);
      assert((mgr as unknown as { headlessSpawnCooldownUntil: number }).headlessSpawnCooldownUntil > Date.now(), "异常 rc 同款 2min 退避（坏单连环拉起风暴防）");

      // d) boot 清扫死 pid+rc 缺席（旧形态行）→ 照常中断收口（语义不可知不虚构 done）
      const hidD = randomUUID();
      mkCard(hidD, "重启窗单D");
      mkHeadlessRow(hidD, vpid, "restart-orphan-d");
      closeHung();
      assert(ledOf(hidD)?.status === "done" && (ledOf(hidD)?.receipt ?? "").includes("中断"), `**boot 清扫死 pid+无 rc → 照常中断收口**（实际 ${ledOf(hidD)?.status}/${ledOf(hidD)?.receipt}）`);
      assert(cardOf(hidD)?.status === "backlog", "中断收口板卡回待办");

      // e) boot 清扫死 pid+rc 在场 → 按 rc 还原（重启窗内完成的真交付不记「中断」）
      const hidE = randomUUID();
      mkCard(hidE, "重启窗单E");
      mkHeadlessRow(hidE, vpid, "restart-orphan-e");
      writeFileSync(rcOf(hidE), "0", "utf-8");
      closeHung();
      assert(ledOf(hidE)?.status === "done" && (ledOf(hidE)?.receipt ?? "").includes("rc=0"), `**boot 清扫死 pid+rc=0 → done**（rc 语义优先——实际 ${ledOf(hidE)?.receipt}）`);

      // f) slug 闸孤儿查重：行态异常（误收口）也不放行——同树还有真跑的 worker
      appendDispatch({ ts: Date.now(), id: hidA, tier: "轻立项" as DispatchTier, target: "headless", status: "done", receipt: "误收口（测试注入——行态异常形态）", session_id: "", project_anchor: anchor9, actor: "leader", headless: true, slug: "restart-orphan-a" });
      const rga = mgr.dispatchWorker({ anchor: anchor9, gid: gid9, prompt: "重派同 slug", title: "RG", slug: "restart-orphan-a" }) as { ok: boolean; error?: string; duplicate_of?: string };
      assert(rga.ok === false && rga.duplicate_of === hidA && (rga.error ?? "").includes("孤儿"), `**slug 闸行态异常不放行**（误收口行+pid 活=拒新单——实际 ${JSON.stringify(rga).slice(0, 120)}）`);

      // g) worktree 锁认领/让位（真 spawn 流——mock bin 同 S3/S5 范式）
      (mgr as unknown as { headlessSpawnCooldownUntil: number }).headlessSpawnCooldownUntil = 0; // c) 段退避清位（隔离）
      const marker8 = join(DATA, "headless-marker-s8.log");
      const mockBin8 = join(DATA, "mock-claude-s8.sh");
      writeFileSync(mockBin8, `#!/bin/bash\ncat > /dev/null\necho "s8-pid=$$" >> ${JSON.stringify(marker8)}\nexit 0\n`, { encoding: "utf-8", mode: 0o755 });
      chmodSync(mockBin8, 0o755);
      process.env.CCR_HEADLESS_CLAUDE = mockBin8;
      const anchorG = join(ORG, "anchor-s8g");
      mkdirSync(anchorG, { recursive: true });
      const cgG = createGroup({ name: "锁认领组", anchor_dir: anchorG, tier: "轻立项" });
      const gidG = cgG.ok ? cgG.group.id : "";
      setGroupStatus(gidG, "active");
      mgr.orgAction("cap-set", { gid: gidG, cap: 1 });
      const rg0 = mgr.dispatchWorker({ anchor: anchorG, gid: gidG, prompt: "占位者四", title: "S8O" }) as { ok: boolean; session_id?: string };
      await wait(30);
      killTruth(mgr, rg0.session_id ?? "");
      // g1) 让位：worktree 被他人活锁占 → 不拉（防同树双跑），单留队列
      const wtBusy = join(WT, "cc-deck-w-s8-busy");
      mkdirSync(wtBusy, { recursive: true });
      writeFileSync(join(wtBusy, ".cc-deck-lock"), JSON.stringify({ slug: "other-slug", dispatch_id: randomUUID(), created_at: Date.now(), expires_at: Date.now() + 2 * 3600_000 }), "utf-8");
      let rg2: { ok: boolean; queued?: boolean; dispatch_id?: string } = { ok: false };
      const realNowG = Date.now;
      Date.now = () => realNowG() + 40 * 60_000;
      try {
        clearFrameCache(mgr);
        rg2 = mgr.dispatchWorker({ anchor: anchorG, gid: gidG, prompt: "锁忙单", title: "S8B", slug: "s8-claim", worktree: wtBusy }) as typeof rg2;
      } finally { Date.now = realNowG; }
      assert(queueOf(mgr).some((x) => x.dispatch_id === rg2.dispatch_id) && ledOf(rg2.dispatch_id ?? "")?.status === "queued", `**worktree 被占让位**：单留队不拉（实际 ${ledOf(rg2.dispatch_id ?? "")?.status}）`);
      assert(!existsSync(marker8), "未真拉起（无消费者标记——锁闸先于 spawn）");
      (mgr as unknown as { evictQueuedDispatch: (id: string) => number }).evictQueuedDispatch(rg2.dispatch_id ?? "");
      // g2) 认领：无主 worktree → 拉起+落锁+rc 落盘+收口随清锁
      const wtFree = join(WT, "cc-deck-w-s8-claim");
      mkdirSync(wtFree, { recursive: true });
      let rg3: { ok: boolean; queued?: boolean; dispatch_id?: string } = { ok: false };
      Date.now = () => realNowG() + 40 * 60_000;
      try {
        clearFrameCache(mgr);
        rg3 = mgr.dispatchWorker({ anchor: anchorG, gid: gidG, prompt: "锁认领单", title: "S8C", slug: "s8-claim-2", worktree: wtFree }) as typeof rg3;
      } finally { Date.now = realNowG; }
      const dG3 = rg3.dispatch_id ?? "";
      assert(await waitFor(() => ledOf(dG3)?.status === "running" && ledOf(dG3)?.headless === true, 5000), `**headless 拉起（无主 worktree）**（实际 ${ledOf(dG3)?.status}）`);
      assert(/^headless:\d+$/.test(ledOf(dG3)?.target ?? ""), `running 行 target 锚 pid（重启判活锚——实际 ${ledOf(dG3)?.target}）`);
      const lockBody = JSON.parse(readFileSync(join(wtFree, ".cc-deck-lock"), "utf-8")) as { dispatch_id?: string };
      assert(lockBody.dispatch_id === dG3, `**headless 认领 worktree 锁**（重启窗异 slug 互斥面——实际 ${lockBody.dispatch_id?.slice(0, 8)}）`);
      assert(await waitFor(() => ledOf(dG3)?.status === "done", 5000), `消费完成收口（实际 ${ledOf(dG3)?.status}）`);
      assert(readFileSync(rcOf(dG3), "utf-8") === "0", "**rc 落盘=0**（sh 包装——重启后 exit 语义证据）");
      assert(!existsSync(join(wtFree, ".cc-deck-lock")), "收口随清锁（notifyDispatchClosed 扫描清）");
    }

    // ================= S8 h) 收口后可再拉起（返修 fix2·r2 P1）=================
    console.log("S8h 重挂孤儿收口后在途归位——真拉起→模拟重启→pid 退→收口→再派单→新拉起成功");
    {
      // ── 夹具：门控 mock（吃 stdin 后等放行文件 $CCR_TEST_HEADLESS_GATE 出现，按其内容退出=rc
      //    可控；120s 兜底自退防遗留）+池空窗组（死席占位，g 段同款）──
      const markerH = join(DATA, "headless-marker-s8h.log");
      const mockBinH = join(DATA, "mock-claude-s8h.sh");
      writeFileSync(mockBinH, [
        "#!/bin/bash",
        "# 返修 fix2 门控 mock：吃 stdin、记 pid、等放行文件出现后按其内容退出（120s 兜底自退）",
        "cat > /dev/null",
        `echo "pid=$$" >> ${JSON.stringify(markerH)}`,
        `n=0; while [ ! -f "$CCR_TEST_HEADLESS_GATE" ] && [ "$n" -lt 2400 ]; do sleep 0.05; n=$((n+1)); done`,
        `exit "$(cat "$CCR_TEST_HEADLESS_GATE" 2>/dev/null || echo 9)"`,
        "",
      ].join("\n"), { encoding: "utf-8", mode: 0o755 });
      chmodSync(mockBinH, 0o755);
      process.env.CCR_HEADLESS_CLAUDE = mockBinH;
      const gates: string[] = []; // 全部门控文件（段尾统一放行——SIGKILL 形态下 mock 孙进程仍在等）
      const newGate = (name: string): string => { const g = join(DATA, `gate-${name}`); gates.push(g); return g; };
      const markerLines = (): number => { try { return readFileSync(markerH, "utf-8").split("\n").filter(Boolean).length; } catch { return 0; } };
      const rcOfH = (id: string): string => join(DATA, "headless-workers", `${id.slice(0, 8)}.rc`);
      const closeHung = (): void => { (mgr as unknown as { closeHungDispatchRows: () => void }).closeHungDispatchRows(); };
      const mkHeadlessRow = (id: string, pid: number, slug: string): void => {
        appendDispatch({ ts: Date.now(), id, tier: "轻立项" as DispatchTier, target: `headless:${pid}`, status: "running", event: "dispatch-headless", receipt: `池空窗 headless（pid=${pid}，重启窗测试注入）`, session_id: "", project_anchor: anchorH, actor: "leader", headless: true, slug });
      };
      const auditHas = (...needles: string[]): boolean => {
        try { return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8").split("\n").some((l) => needles.every((n) => l.includes(n))); } catch { return false; }
      };
      // 时间机器（S1/S8g 同款 +40min：帧龄超 5min 显示窗+30min 间隙窗=死席真判死）；调用前后清帧龄缓存
      const realNowH = Date.now;
      const tm = <T>(fn: () => T): T => { Date.now = () => realNowH() + 40 * 60_000; try { clearFrameCache(mgr); return fn(); } finally { Date.now = realNowH; clearFrameCache(mgr); } };
      type Seam = { headlessChildren: Map<string, ChildProcess>; headlessOrphansInFlight: number; headlessSpawnCooldownUntil: number };
      const seam = mgr as unknown as Seam;
      /** 模拟 relay 重启（进程内等价）：新 relay 对旧子进程零记忆——登记表清空（孤儿=不属
       *  本进程的 running headless 行）+摘掉本进程挂在子进程上的 exit/error handler（旧
       *  relay 的收口闭包随进程消亡——没人替孤儿收口，只剩台账 running 行+pid+sh 包装的
       *  rc 落盘文件）。子进程本体不动（detached，照跑）。 */
      const simulateRestart = (): ChildProcess[] => {
        const children = [...seam.headlessChildren.values()];
        for (const c of children) {
          c.removeAllListeners("exit");
          c.removeAllListeners("error");
          c.on("error", () => {}); // 护栏：摘掉 handler 后 error 事件无监听=炸测试进程（真孤儿无此对象，纯 harness 防护）
        }
        seam.headlessChildren.clear();
        return children;
      };
      /** 放行子进程退出并等其真死（exit 事件=已回收非僵尸）；窗内未退返回 false（断言报） */
      const release = async (child: ChildProcess, gate: string, rc: string): Promise<boolean> => {
        let exited = false;
        child.once("exit", () => { exited = true; });
        writeFileSync(gate, rc, "utf-8");
        return waitFor(() => exited, 15_000);
      };
      const anchorH = join(ORG, "anchor-s8h");
      mkdirSync(anchorH, { recursive: true });
      const cgH = createGroup({ name: "重启再拉起组", anchor_dir: anchorH, tier: "轻立项" });
      const gidH = cgH.ok ? cgH.group.id : "";
      setGroupStatus(gidH, "active");
      assert(mgr.orgAction("cap-set", { gid: gidH, cap: 1 }).ok, "夹具：cap=1（池空窗组）");
      const rh0 = mgr.dispatchWorker({ anchor: anchorH, gid: gidH, prompt: "占位者五", title: "S8HO" }) as { ok: boolean; session_id?: string };
      await wait(30);
      killTruth(mgr, rh0.session_id ?? "");
      const cardOfH = (id: string): { status?: string } | undefined => loadBoard(gidH).entries.find((x) => x.dispatch_id === id);
      type Disp = { ok: boolean; queued?: boolean; queue_reason?: string; dispatch_id?: string };
      /** 池空窗派单（group-cap 触发路径）：门控文件经 env 透传给本次拉起的消费者（spawn 时点快照） */
      const dispatch = (slug: string, gate: string): Disp => {
        process.env.CCR_TEST_HEADLESS_GATE = gate;
        return tm(() => mgr.dispatchWorker({ anchor: anchorH, gid: gidH, prompt: `返修 fix2 重启再拉起 ${slug}`, title: slug, slug })) as Disp; // title=全 slug（截断会撞 trigger_key 幂等闸）
      };
      /** 真拉起（生产 spawn 流：sh 包装+rc 落盘+running 行）→模拟重启→boot 清扫+首拍重挂：
       *  断言孤儿在途=1。返回孤儿句柄（行 id/子进程句柄/包装 pid/门控文件）。 */
      const raiseOrphan = async (slug: string): Promise<{ id: string; child: ChildProcess; pid: number; gate: string }> => {
        const gate = newGate(slug);
        const linesBefore = markerLines(); // 本次拉起前的消费者进程数（marker 行=已起进程各 1 行）
        const r = dispatch(slug, gate);
        const id = r.dispatch_id ?? "";
        assert(r.ok && r.queued === true && r.queue_reason === "pool-empty", `[${slug}] 夹具：池空窗排队→拉起（实际 ${JSON.stringify(r).slice(0, 160)}）`);
        const row = ledOf(id);
        const pid = Number((/^headless:(\d+)$/.exec(row?.target ?? "") ?? [])[1] ?? 0);
        const child = seam.headlessChildren.get(id);
        assert(row?.status === "running" && row.headless === true && pid > 0 && !!child && mgr.headlessInFlight() === 1, `[${slug}] **真拉起**：running headless 行+本进程在途登记=1（实际 ${row?.status}/${row?.target}/在途 ${mgr.headlessInFlight()}）`);
        assert(await waitFor(() => markerLines() >= linesBefore + 1, 5000), `[${slug}] 消费者进程真起（吃到 stdin——marker 第 ${linesBefore + 1} 行）`);
        assert(simulateRestart().length === 1, `[${slug}] 模拟重启：旧 relay 内存态清空（登记表 1→0，exit handler 摘除）`);
        assert(mgr.headlessInFlight() === 0, `[${slug}] 重启后新 relay 在途归零（孤儿首拍回填前不可见）`);
        closeHung(); // boot 清扫：活 pid 行跳过
        assert(ledOf(id)?.status === "running", `[${slug}] boot 清扫不误收口活孤儿（真子进程 pid=${pid}）`);
        const sw = tm(() => mgr.sweepHeadlessRows());
        assert(sw.live === 1 && seam.headlessChildren.size === 0 && seam.headlessOrphansInFlight === 1 && mgr.headlessInFlight() === 1, `[${slug}] **首拍重挂：孤儿在途=1**（本进程 0+孤儿 1；live=${sw.live}）`);
        return { id, child: child as ChildProcess, pid, gate };
      };
      /** 放行本进程消费者（rc=0）→等 done 收口→在途归零 */
      const finishOwn = async (id: string, gate: string): Promise<void> => {
        const child = seam.headlessChildren.get(id);
        assert(!!child && mgr.headlessInFlight() === 1, `[${id.slice(0, 8)}] 新消费者本进程在途=1（实际 ${mgr.headlessInFlight()}）`);
        writeFileSync(gate, "0", "utf-8");
        assert(await waitFor(() => ledOf(id)?.status === "done", 8000), `[${id.slice(0, 8)}] **新消费者消费完成 done**（实际 ${ledOf(id)?.status}）`);
        assert(mgr.headlessInFlight() === 0, `[${id.slice(0, 8)}] 退出后在途归零（exit 边出表——实际 ${mgr.headlessInFlight()}）`);
      };
      try {
        // ── 前置：g) 段自家消费者经 exit handler 收口后在途零残留（本进程账精确——全程无手工清零）──
        assert(mgr.headlessInFlight() === 0, `**g 段消费者收口后在途归零**（实际 ${mgr.headlessInFlight()}——手工清零位已退役）`);

        // ── A) done 形态·拍收口：孤儿在跑期间新单让位→pid 退 rc=0→拍收口 done→在途归零
        //      →让位单被拍排水消费（新 pid）→新派单再拉起 ──
        const oa = await raiseOrphan("fix2-done");
        const markerAfterOrphan = markerLines(); // 此后未拉起期间应恒等（raiseOrphan 返回=本孤儿 marker 行已落）
        const gateBlockedA = newGate("fix2-done-blocked");
        const blockedA = dispatch("fix2-done-blocked", gateBlockedA);
        const bidA = blockedA.dispatch_id ?? "";
        assert(blockedA.ok && blockedA.queued === true && ledOf(bidA)?.status === "queued", `**孤儿在跑期间新单让位**：留队不拉第二个消费者（实际 ${ledOf(bidA)?.status}）`);
        assert(mgr.headlessInFlight() === 1 && markerLines() === markerAfterOrphan, "在途=1（孤儿）且消费者进程数未增（单飞语义对孤儿同权——闸前刷新不误放）");
        assert(await release(oa.child, oa.gate, "0"), "孤儿 rc=0 放行后窗内真退（exit 事件=已回收）");
        assert(ledOf(oa.id)?.status === "running" && readFileSync(rcOfH(oa.id), "utf-8") === "0", "孤儿真退后行仍 running（重启后无 exit handler 收口）+rc 落盘=0 由 sh 包装真写（非测试注入）");
        const swA = tm(() => mgr.sweepHeadlessRows());
        assert(swA.closed === 1 && ledOf(oa.id)?.status === "done" && (ledOf(oa.id)?.receipt ?? "").includes("rc=0"), `**拍收口 done**（rc 语义——实际 ${ledOf(oa.id)?.status}/${ledOf(oa.id)?.receipt}）`);
        assert(cardOfH(oa.id)?.status === "done", `板卡随收口翻 done（实际 ${cardOfH(oa.id)?.status}）`);
        assert(mgr.headlessInFlight() === 0, `**收口后在途归零**（done 形态——实际 ${mgr.headlessInFlight()}，r2 P1 泄漏形态=仍 1）`);
        // 让位单被周期拍消费（sweep 触发路径——「已排队后池才空」形态同款）
        process.env.CCR_TEST_HEADLESS_GATE = gateBlockedA;
        tm(() => mgr.sweepDispatchQueueOnce());
        const newPid = Number((/^headless:(\d+)$/.exec(ledOf(bidA)?.target ?? "") ?? [])[1] ?? 0);
        assert(ledOf(bidA)?.status === "running" && ledOf(bidA)?.headless === true && newPid > 0 && newPid !== oa.pid, `**让位单被新消费者接管**（拍排水→拉起新进程 pid=${newPid}≠孤儿 ${oa.pid}——实际 ${ledOf(bidA)?.status}/${ledOf(bidA)?.target}）`);
        await finishOwn(bidA, gateBlockedA);
        // 新派单再拉起（group-cap 触发路径——同 gid 池空窗）
        const gateAgainA = newGate("fix2-again");
        const againA = dispatch("fix2-again", gateAgainA);
        const aidA = againA.dispatch_id ?? "";
        assert(ledOf(aidA)?.status === "running" && ledOf(aidA)?.headless === true, `**再派单→新拉起成功**（同 gid 池空窗——实际 ${ledOf(aidA)?.status}/${ledOf(aidA)?.target}）`);
        await finishOwn(aidA, gateAgainA);

        // ── B) failed 形态·拍收口：rc=3→failed+板回待办+2min 退避；在途归零——闸因=cooldown
        //      （按设计的坏单防风暴退避）而非 single-flight（泄漏形态）；退避过后再拉起成功 ──
        const ob = await raiseOrphan("fix2-failed");
        const gateBlockedB = newGate("fix2-failed-blocked");
        const blockedB = dispatch("fix2-failed-blocked", gateBlockedB);
        const bidB = blockedB.dispatch_id ?? "";
        assert(blockedB.ok && blockedB.queued === true && ledOf(bidB)?.status === "queued" && mgr.headlessInFlight() === 1, `孤儿在跑期间让位（failed 形态同款——实际 ${ledOf(bidB)?.status}/在途 ${mgr.headlessInFlight()}）`);
        assert(await release(ob.child, ob.gate, "3"), "孤儿 rc=3 放行后窗内真退");
        const swB = tm(() => mgr.sweepHeadlessRows());
        assert(swB.closed === 1 && ledOf(ob.id)?.status === "failed" && cardOfH(ob.id)?.status === "backlog", `**拍收口 failed+板回待办**（rc=3——实际 ${ledOf(ob.id)?.status}/${cardOfH(ob.id)?.status}）`);
        assert(mgr.headlessInFlight() === 0, `**收口后在途归零**（failed 形态——实际 ${mgr.headlessInFlight()}，r2 P1 泄漏形态=仍 1）`);
        const verdictB = tm(() => mgr.maybeSpawnHeadlessConsumer("test"));
        assert(verdictB.spawned === false && verdictB.reason === "cooldown", `**闸因=cooldown 非 single-flight**（泄漏形态=single-flight 永久哑火；退避是按设计的坏单防风暴——实际 ${verdictB.reason}）`);
        seam.headlessSpawnCooldownUntil = 0; // 退避清位=时间控制（退避是设计行为，非缺陷遮掩）
        process.env.CCR_TEST_HEADLESS_GATE = gateBlockedB;
        const spawnB = tm(() => mgr.maybeSpawnHeadlessConsumer("test"));
        assert(spawnB.spawned === true && ledOf(bidB)?.status === "running" && ledOf(bidB)?.headless === true, `**退避过后让位单被拉起**（实际 ${ledOf(bidB)?.status}）`);
        await finishOwn(bidB, gateBlockedB);

        // ── C) 中断形态·拍收口：SIGKILL 包装进程（rc 未及落盘）→「回合中断」收口→在途归零→再拉起 ──
        const oc = await raiseOrphan("fix2-killed");
        let killed = false;
        oc.child.once("exit", () => { killed = true; });
        oc.child.kill("SIGKILL");
        assert(await waitFor(() => killed, 15_000), "包装进程被杀且窗内回收（pid 真死）");
        assert(!existsSync(rcOfH(oc.id)) && ledOf(oc.id)?.status === "running", "未及落 rc+行仍 running（中断形态前提——待拍收口）");
        const swC = tm(() => mgr.sweepHeadlessRows());
        assert(swC.closed === 1 && ledOf(oc.id)?.status === "done" && (ledOf(oc.id)?.receipt ?? "").includes("中断"), `**拍收口中断口径**（实际 ${ledOf(oc.id)?.status}/${ledOf(oc.id)?.receipt}）`);
        assert(mgr.headlessInFlight() === 0, `**收口后在途归零**（中断形态——实际 ${mgr.headlessInFlight()}）`);
        const gateAgainC = newGate("fix2-killed-again");
        const againC = dispatch("fix2-killed-again", gateAgainC);
        const aidC = againC.dispatch_id ?? "";
        assert(ledOf(aidC)?.status === "running" && ledOf(aidC)?.headless === true, `**再派单→新拉起成功**（实际 ${ledOf(aidC)?.status}/${ledOf(aidC)?.target}）`);
        await finishOwn(aidC, gateAgainC);

        // ── D) 闸前刷新（不等拍）：孤儿在两拍之间退出→再派单时闸口当场收口+回落→同一次派单即拉起 ──
        const od = await raiseOrphan("fix2-refresh");
        assert(await release(od.child, od.gate, "0"), "孤儿 rc=0 放行后窗内真退");
        assert(ledOf(od.id)?.status === "running" && mgr.headlessInFlight() === 1, "拍未到：行仍 running+在途快照仍=1（孤儿已退的陈旧快照——r2 P1 在此后的闸口必现）");
        const gateAgainD = newGate("fix2-refresh-again");
        const againD = dispatch("fix2-refresh-again", gateAgainD);
        const aidD = againD.dispatch_id ?? "";
        assert(ledOf(od.id)?.status === "done" && cardOfH(od.id)?.status === "done", `**闸前刷新当场收口孤儿**（走 sweep 同一收口口——实际 ${ledOf(od.id)?.status}/${cardOfH(od.id)?.status}）`);
        assert(ledOf(aidD)?.status === "running" && ledOf(aidD)?.headless === true, `**同一次派单即拉起新消费者**（不等下一拍 ≤5min——实际 ${ledOf(aidD)?.status}）`);
        await finishOwn(aidD, gateAgainD);

        // ── E) 闸前刷新·failed 形态：当场收口 failed→在途归零→按设计退避（cooldown）→退避后拍排水拉起 ──
        const oe = await raiseOrphan("fix2-refresh-failed");
        const markerAfterOrphanE = markerLines();
        assert(await release(oe.child, oe.gate, "3"), "孤儿 rc=3 放行后窗内真退");
        const gateBlockedE = newGate("fix2-refresh-failed-blocked");
        const blockedE = dispatch("fix2-refresh-failed-blocked", gateBlockedE);
        const bidE = blockedE.dispatch_id ?? "";
        assert(blockedE.ok && blockedE.queued === true && ledOf(oe.id)?.status === "failed" && mgr.headlessInFlight() === 0, `**闸前刷新当场收口 failed+在途归零**（实际 ${ledOf(oe.id)?.status}/在途 ${mgr.headlessInFlight()}）`);
        assert(ledOf(bidE)?.status === "queued" && markerLines() === markerAfterOrphanE, `坏单退避生效：新单留队不拉（闸因 cooldown——实际 ${ledOf(bidE)?.status}）`);
        seam.headlessSpawnCooldownUntil = 0;
        process.env.CCR_TEST_HEADLESS_GATE = gateBlockedE;
        tm(() => mgr.sweepDispatchQueueOnce());
        assert(ledOf(bidE)?.status === "running" && ledOf(bidE)?.headless === true, `退避过后让位单被拍排水拉起（实际 ${ledOf(bidE)?.status}）`);
        await finishOwn(bidE, gateBlockedE);

        // ── F) 全局帽分支（trigger=global-cap）同享闸口：帽=在编 status 口径数+死席池空窗→排队即拉起 ──
        const orf = await raiseOrphan("fix2-global");
        assert(await release(orf.child, orf.gate, "0"), "孤儿 rc=0 放行后窗内真退");
        const activeStatus = mgr.activeManagedCount();
        assert(activeStatus >= 2, `夹具：在编 status 口径 ≥2（实际 ${activeStatus}——workerConcurrencyCap 下限 2）`);
        const prevCap = process.env.CCR_WORKER_CONCURRENCY_CAP;
        const gateF = newGate("fix2-global-again");
        let gf: Disp = { ok: false };
        let fid = "";
        process.env.CCR_WORKER_CONCURRENCY_CAP = String(activeStatus);
        try {
          gf = dispatch("fix2-global-again", gateF);
          fid = gf.dispatch_id ?? "";
        } finally { process.env.CCR_WORKER_CONCURRENCY_CAP = prevCap; }
        assert(gf.ok && gf.queued === true && gf.queue_reason === "pool-empty" && ledOf(orf.id)?.status === "done", `**全局帽池空窗排队→闸前刷新收口孤儿**（实际 queue_reason=${gf.queue_reason}/孤儿行 ${ledOf(orf.id)?.status}）`);
        assert(ledOf(fid)?.status === "running" && ledOf(fid)?.headless === true && auditHas("headless-spawn", `单 ${fid.slice(0, 8)} pid=`, "trigger=global-cap"), `**全局帽路径再拉起成功**（trigger=global-cap 审计在——实际 ${ledOf(fid)?.status}/${ledOf(fid)?.target}）`);
        await finishOwn(fid, gateF);

        // ── G) 加固：`headless:0` 形态行（kill(0,0) 打本进程组恒成功）不认 pid——不计孤儿在途、boot 清扫照常收口 ──
        const hid0 = randomUUID();
        mkHeadlessRow(hid0, 0, "fix2-zero-pid");
        assert(process.kill(0, 0) === true, "背景事实：kill(0,0) 恒成功（pid 0 行若被认=永久判活+在途常驻）");
        const sw0 = tm(() => mgr.sweepHeadlessRows());
        assert(sw0.live === 0 && mgr.headlessInFlight() === 0, `**\`headless:0\` 行不计活孤儿**（在途仍 0——live=${sw0.live}）`);
        closeHung();
        assert(ledOf(hid0)?.status === "done" && (ledOf(hid0)?.receipt ?? "").includes("中断"), `**\`headless:0\` 行落通用清扫口收口**（不永久挂起——实际 ${ledOf(hid0)?.status}）`);
      } finally {
        for (const g of gates) { try { writeFileSync(g, "0", "utf-8"); } catch { /* 尽力而为 */ } }
        delete process.env.CCR_TEST_HEADLESS_GATE;
        await wait(300); // 被杀包装进程遗留的 mock 孙进程见放行文件自退（DATA 目录此后才清）
      }
    }

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    // 环境还原+清扫
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { rmSync(ORG, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    try { rmSync(WT, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

void main();
