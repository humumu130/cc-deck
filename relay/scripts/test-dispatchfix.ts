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
// agentFactory 测试缝（不拉真 CLI），范式同 test-drainfix.ts / test-headcount.ts。
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import type { Envelope } from "../src/types.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import type { DispatchTier } from "../src/org.js";
import { createGroup, findGroup, setGroupStatus } from "../src/projects.js";
import { loadDispatchQueue } from "../src/dispatch-queue.js";
import { loadBoard } from "../src/projects.js";
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
      (mgr as unknown as { headlessSpawnInFlight: number }).headlessSpawnInFlight = 0;
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
