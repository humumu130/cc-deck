// W-DRAINFIX（1111 用户实锤，t-5e8866d2）：派发队列排水死锁治本断言套件。
// 病灶：drainDispatchQueue 全触发点=事件边（收口/除名/重启回灌），编制全闲+队列
// 挂单=零事件永哑火（fzone-b1 断档→B1R 入队→15 编制全闲实锤）。
// 覆盖：D1 死锁复现与 sweep 接走（全闲+队列单→一拍派发，零扩编）
//       D2 断档悬账收敛（判活=dead→failed 收口回 backlog；触顶回队语义保持；
//           retire 让位后队列单接续——不被死档 worker 卡死全链）
//       D3 活 worker 守卫（帧活跃/pid 活/回合间隙 between-turns 三态一律不动）
//       D4 定时器注册面（boot 首拍即扫/短间隔定时自动接走/NO 开关与 0 值全停）
//       D5 源码锚（index.ts boot 注册面）
// agentFactory 测试缝（不拉真 CLI），范式同 test-headcount.ts。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import type { DispatchTier } from "../src/org.js";
import {
  createGroup, findGroup, genericWorkerCount, headcountCapOf, setGroupStatus,
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

// 假 agent 工厂（test-headcount 同款）：init 10ms 后 onInit；回合终态不自动发——
// 断档形态（收口边哑火）由测试直改内存态注入，自动收口会破坏前提。
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

// 私有态测试缝（运行时 JS 不设私有栅栏——test-headcount 同范式）
type SessionRec = { state: { status: string; session_id: string; cli_pid?: number; updated_at?: number; project_gid?: string } };
const sessionsOf = (mgr: SessionManager): Map<string, SessionRec> => (mgr as unknown as { sessions: Map<string, SessionRec> }).sessions;
const openOf = (mgr: SessionManager): Map<string, { id: string; gid?: string; tier?: DispatchTier }[]> => (mgr as unknown as { openDispatches: Map<string, { id: string; gid?: string; tier?: DispatchTier }[]> }).openDispatches;
const queueLen = (mgr: SessionManager): number => (mgr as unknown as { dispatchQueueItems: QueuedDispatchLike[] }).dispatchQueueItems.length;
const sweepTimerOf = (mgr: SessionManager): unknown => (mgr as unknown as { dispatchSweepTimer: unknown }).dispatchSweepTimer;

/** 断档形态注入（1111 实锤复刻）：收口边哑火——状态已翻 DONE、悬账已清、台账活单
 * 行已收敛终态（closeHungDispatchRows 同款无事件收口形态——事件外路径不挂排水），
 * 但零事件（无 onTurnEnd → 无排水触发）。这就是修前「全闲+队列单」死锁终态的形态。 */
const injectGapFlip = (mgr: SessionManager, sid: string): void => {
  for (const r of openOf(mgr).get(sid) ?? []) {
    appendDispatch({ ts: Date.now(), id: r.id, tier: r.tier ?? "轻立项", target: sid, status: "done", receipt: "断档翻转（测试注入·事件外收口，中断口径）", session_id: sid });
  }
  const s = sessionsOf(mgr).get(sid);
  if (s) s.state.status = "DONE";
  openOf(mgr).delete(sid);
};

async function main() {
  process.env.CCR_WORKER_CONCURRENCY_CAP = "20"; // 全局帽隔离（test-headcount 同款）
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-drainfix-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-drainfix-"));
  const prevEnv: Record<string, string | undefined> = {
    CCR_ORG_DIR: process.env.CCR_ORG_DIR,
    CCR_ORG_HEADCOUNT_CAP: process.env.CCR_ORG_HEADCOUNT_CAP,
    CCR_NO_TITLE_GEN: process.env.CCR_NO_TITLE_GEN,
    CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE,
    CCR_CWD: process.env.CCR_CWD,
    CCR_NO_HEADCOUNT_TRIM: process.env.CCR_NO_HEADCOUNT_TRIM,
    CCR_NO_DISPATCH_SWEEP: process.env.CCR_NO_DISPATCH_SWEEP,
    CCR_DISPATCH_SWEEP_MIN: process.env.CCR_DISPATCH_SWEEP_MIN,
  };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ORG_HEADCOUNT_CAP = "2";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_NO_HEADCOUNT_TRIM = "1";
  delete process.env.CCR_CWD;
  delete process.env.CCR_NO_DISPATCH_SWEEP; // 本套件全程手动 sweepDispatchQueueOnce，防外部 env 误关
  delete process.env.CCR_DISPATCH_SWEEP_MIN;
  try {
    const cfg: RelayConfig = {
      port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const anchor = join(ORG, "anchor-repo");
    mkdirSync(anchor, { recursive: true });

    const created: Rec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const ledOf = (id: string) => readDispatchLog().find((e) => e.id === id);

    // ================= D1 死锁复现与 sweep 接走 =================
    console.log("D1 全闲+队列单 → sweep 一拍接走（1111 实锤形态）");
    {
      const cg = createGroup({ name: "排水组", anchor_dir: anchor, tier: "轻立项" });
      const gid = cg.ok ? cg.group.id : "";
      setGroupStatus(gid, "active");
      const r1 = mgr.dispatchWorker({ anchor, gid, prompt: "任务一", title: "T1" });
      await wait(30);
      const r2 = mgr.dispatchWorker({ anchor, gid, prompt: "任务二", title: "T2" });
      await wait(30);
      assert(r1.ok && r2.ok, "夹具：两单两 worker（在忙）");
      const r3 = mgr.dispatchWorker({ anchor, gid, prompt: "任务三", title: "T3" });
      const d3 = r3.ok ? (r3 as { dispatch_id: string }).dispatch_id : "";
      assert(r3.ok && (r3 as { queued?: boolean }).queued === true, "第三单触顶转排队（queued:true）");
      assert(loadDispatchQueue().length === 1, "队列 1 条");
      // 断档形态注入：两 worker 收口边哑火（状态翻 DONE、悬账清、零事件零排水）
      injectGapFlip(mgr, r1.ok ? r1.session_id : "");
      injectGapFlip(mgr, r2.ok ? r2.session_id : "");
      assert(queueLen(mgr) === 1 && loadDispatchQueue().length === 1, "死锁复现：全闲+队列挂单并存（无事件边排水——修前终态）");
      const res = mgr.sweepDispatchQueueOnce();
      assert(res.triggered === true && res.deadClosed === 0, `sweep 触发（triggered=true，纯 A 条件——实际 ${JSON.stringify(res)}）`);
      assert(queueLen(mgr) === 0 && loadDispatchQueue().length === 0, `**死锁治本**：sweep 一拍队列排空（内存 ${queueLen(mgr)}/盘 ${loadDispatchQueue().length}）`);
      const led3 = ledOf(d3);
      const takers = new Set([r1.ok ? r1.session_id : "", r2.ok ? r2.session_id : ""]);
      assert(led3?.status === "running" && takers.has(led3?.session_id ?? ""), `队首单被空闲 worker 承接（实际 ${led3?.status}/${led3?.session_id?.slice(0, 8)}）`);
      assert(genericWorkerCount(findGroup(gid)!.headcount) === 2, "排水复用零扩编（泛 worker 恒 2）");
      // 收尾：承接者悬账清位（cast——不触发事件边；台账 running 行留痕无妨，后续
      // 段落换组隔离，D2 时间机器扫描 openDispatches 不受污染）
      if (led3?.session_id) injectGapFlip(mgr, led3.session_id);
    }

    // ================= D2 断档悬账收敛（条件 B）=================
    console.log("D2 open 单 worker 断档 → 悬账收口 + 触顶回队语义保持 + 让位接续");
    {
      const anchor2 = join(ORG, "anchor-gap");
      mkdirSync(anchor2, { recursive: true });
      const cg2 = createGroup({ name: "断档组", anchor_dir: anchor2, tier: "轻立项" });
      const gid2 = cg2.ok ? cg2.group.id : "";
      setGroupStatus(gid2, "active");
      const cs = mgr.orgAction("cap-set", { gid: gid2, cap: 1 });
      assert(cs.ok && headcountCapOf(findGroup(gid2)!) === 1, "夹具：cap=1");
      const rA = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "断档者单", title: "TA" });
      const sA = rA.ok ? rA.session_id : "";
      const dA = rA.ok ? (rA as { dispatch_id: string }).dispatch_id : "";
      await wait(30);
      assert(ledOf(dA)?.status === "running" && !!sA, "夹具：TA 在跑（wA 在忙，open 单挂着）");
      const rB = mgr.dispatchWorker({ anchor: anchor2, gid: gid2, prompt: "排队单", title: "TB" });
      const dB = rB.ok ? (rB as { dispatch_id: string }).dispatch_id : "";
      assert(rB.ok && (rB as { queued?: boolean }).queued === true, "夹具：TB 触顶排队");
      // 时间机器：帧龄 +40min（超活跃窗 15min+回合间隙 TTL 30min）→ 判活=dead；
      // 状态保持 WORKING（断档 mid-turn——无完成事件正是病灶）
      const realNow = Date.now;
      Date.now = () => realNow() + 40 * 60_000;
      try {
        const res = mgr.sweepDispatchQueueOnce();
        assert(res.deadClosed === 1 && res.triggered === true, `断档悬账收口 1 行（实际 deadClosed=${res.deadClosed}）`);
        const ledA = ledOf(dA);
        assert(ledA?.status === "failed" && (ledA?.receipt ?? "").includes("断档兜底"), `TA failed 收口（receipt 含「断档兜底」——实际 ${ledA?.status}/「${ledA?.receipt ?? "无"}」）`);
        assert(!openOf(mgr).has(sA), "wA open 单已清（dispatch 槽位释放）");
        assert(queueLen(mgr) === 1 && loadDispatchQueue().length === 1, `触顶回队语义保持：wA 仍 WORKING=忙，TB 留队不强派（队列 ${queueLen(mgr)}）`);
        assert(ledOf(dB)?.status === "queued", "TB 台账 queued（重放再排队同 id 回队首）");
      } finally {
        Date.now = realNow;
      }
      // 让位接续：member-retire 腾名额 → 既有排水挂点接管 → TB 接续（不被死档卡死全链）
      const rr = mgr.orgAction("member-retire", { gid: gid2, sid: sA, reason: "断档测试收尾" });
      assert(rr.ok, `member-retire 让位 ok（实际 ${rr.ok ? "ok" : rr.error}）`);
      await wait(40);
      assert(queueLen(mgr) === 0 && loadDispatchQueue().length === 0, `**不被死档卡死**：让位后排队单接续排空（队列 ${queueLen(mgr)}）`);
      const ledB = ledOf(dB);
      assert(ledB?.status === "running", `TB 接续 running（实际 ${ledB?.status}）`);
    }

    // ================= D3 活 worker 守卫（不动三态）=================
    console.log("D3 活 worker 守卫：帧活跃/pid 活/回合间隙 一律不动");
    {
      const anchor3 = join(ORG, "anchor-live");
      mkdirSync(anchor3, { recursive: true });
      const cg3 = createGroup({ name: "守卫组", anchor_dir: anchor3, tier: "轻立项" });
      const gid3 = cg3.ok ? cg3.group.id : "";
      setGroupStatus(gid3, "active");
      mgr.orgAction("cap-set", { gid: gid3, cap: 1 });
      const rC = mgr.dispatchWorker({ anchor: anchor3, gid: gid3, prompt: "活流单", title: "TC" });
      const sC = rC.ok ? rC.session_id : "";
      const dC = rC.ok ? (rC as { dispatch_id: string }).dispatch_id : "";
      await wait(30);
      // ① 帧活跃（<15min）→ alive：sweep 不动
      const res1 = mgr.sweepDispatchQueueOnce();
      assert(res1.deadClosed === 0 && openOf(mgr).has(sC) && ledOf(dC)?.status === "running", "帧活跃 worker 的 open 单不动（alive 档）");
      // ② pid 活（外部 CLI 形态）→ alive：无帧也不动（closeHungDispatchRows 误伤守卫同款判据）
      const stC = sessionsOf(mgr).get(sC);
      if (stC) stC.state.cli_pid = process.pid; // 测试进程自身=活 pid
      const res2 = mgr.sweepDispatchQueueOnce();
      assert(res2.deadClosed === 0 && openOf(mgr).has(sC), "pid 活 worker 的 open 单不动（外部回合在跑不误伤）");
      if (stC) stC.state.cli_pid = 0;
      // ③ 回合间隙（帧龄 16min：超活跃窗、未超 30min TTL）→ between-turns 守位不动
      const realNow3 = Date.now;
      Date.now = () => realNow3() + 16 * 60_000;
      try {
        const res3 = mgr.sweepDispatchQueueOnce();
        assert(res3.deadClosed === 0 && openOf(mgr).has(sC), "回合间隙 worker 守位不动（between-turns 档——SEATALIVE 语义保持）");
      } finally {
        Date.now = realNow3;
      }
    }

    // ================= D4 定时器注册面 =================
    console.log("D4 定时器注册面：boot 首拍即扫 / 短间隔定时自动接走 / 开关");
    {
      const anchor4 = join(ORG, "anchor-timer");
      mkdirSync(anchor4, { recursive: true });
      const cg4 = createGroup({ name: "定时组", anchor_dir: anchor4, tier: "轻立项" });
      const gid4 = cg4.ok ? cg4.group.id : "";
      setGroupStatus(gid4, "active");
      // 双席：定时腿要一次接走一个排队单后第二单也有承接位（单席会触顶回队）
      const rD = mgr.dispatchWorker({ anchor: anchor4, gid: gid4, prompt: "定时在忙一", title: "TD" });
      const sD1 = rD.ok ? rD.session_id : "";
      await wait(30);
      const rE = mgr.dispatchWorker({ anchor: anchor4, gid: gid4, prompt: "定时在忙二", title: "TE" });
      const sE1 = rE.ok ? rE.session_id : "";
      await wait(30);
      assert(!!sD1 && !!sE1 && sD1 !== sE1, "夹具：双席在忙");
      const rF = mgr.dispatchWorker({ anchor: anchor4, gid: gid4, prompt: "定时排队单", title: "TF" });
      const dF = rF.ok ? (rF as { dispatch_id: string }).dispatch_id : "";
      assert((rF as { queued?: boolean }).queued === true, "夹具：TF 排队");
      injectGapFlip(mgr, sD1);
      injectGapFlip(mgr, sE1); // 断档形态（全闲+队列单）
      // startDispatchSweep 首拍即扫（startStaleScan 同款范式）——boot 首拍即接走
      process.env.CCR_DISPATCH_SWEEP_MIN = "0.01"; // 600ms（定时腿测试用）
      mgr.startDispatchSweep();
      assert(sweepTimerOf(mgr) != null, "定时器已注册（interval 在场）");
      assert(queueLen(mgr) === 0 && ledOf(dF)?.status === "running", `boot 首拍即扫：TF 已接走（队列 ${queueLen(mgr)}/${ledOf(dF)?.status}）`);
      // 定时腿：再造「全闲+队列单」，全程不手动 sweep/无事件边，等 600ms 定时器自动接走
      const sF = ledOf(dF)?.session_id ?? ""; // TF 承接席（现 WORKING）
      const rG = mgr.dispatchWorker({ anchor: anchor4, gid: gid4, prompt: "定时接续单", title: "TG" });
      const dG = rG.ok ? (rG as { dispatch_id: string }).dispatch_id : "";
      await wait(30);
      assert(ledOf(dG)?.status === "running", `夹具：TG 落在另一空闲席（实际 ${ledOf(dG)?.status}）`);
      const rH = mgr.dispatchWorker({ anchor: anchor4, gid: gid4, prompt: "定时二排队单", title: "TH" });
      const dH = rH.ok ? (rH as { dispatch_id: string }).dispatch_id : "";
      assert((rH as { queued?: boolean }).queued === true, "夹具：TH 排队（等定时器）");
      injectGapFlip(mgr, sF);
      injectGapFlip(mgr, ledOf(dG)?.session_id ?? ""); // 双席回闲 → 死锁形态
      await wait(1100); // >600ms 间隔：定时腿自行动作
      assert(queueLen(mgr) === 0, `**定时兜底**：600ms 间隔定时器自动接走（队列 ${queueLen(mgr)}）`);
      assert(ledOf(dH)?.status === "running", `TH 定时接续 running（实际 ${ledOf(dH)?.status}）`);
      // 开关：CCR_NO_DISPATCH_SWEEP=1 全停 + 显式 0=全关（新 mgr 验证零注册）
      const bus2 = new EventBus({ persistPath: join(DATA, "events.ndjson") });
      const mgr2 = new SessionManager(bus2, cfg);
      process.env.CCR_NO_DISPATCH_SWEEP = "1";
      mgr2.startDispatchSweep();
      assert(sweepTimerOf(mgr2) == null, "CCR_NO_DISPATCH_SWEEP=1 全停（定时器不注册）");
      delete process.env.CCR_NO_DISPATCH_SWEEP;
      process.env.CCR_DISPATCH_SWEEP_MIN = "0";
      mgr2.startDispatchSweep();
      assert(sweepTimerOf(mgr2) == null, "CCR_DISPATCH_SWEEP_MIN=0 显式全关（boot 首拍也不跑）");
    }

    // ================= D5 源码锚：boot 注册面 =================
    console.log("D5 源码锚");
    {
      const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
      assert(src.includes("mgr.startDispatchSweep()"), "index.ts boot 注册 startDispatchSweep（随 relay 启动）");
      const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
      assert(sm.includes("sweepDispatchQueueOnce") && sm.includes("const gids = new Set(this.dispatchQueueItems.map"), "sweep 主体+按队列 gid 键控逐组排在位（drain(\"\") 对带 gid 单全盲的实测修正）");
    }
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n========== drainfix 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
