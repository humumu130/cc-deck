// W-RATELIMIT429 断言件（1104 用户实锤：并发 ~10 会话 429 卡死等人工捞×2）。
// 两组：
//   A 429 注入→退避序列+恢复续跑：backoffDelayMs 指数+抖动+封顶纯函数；真
//     SessionManager 假 agent onTurnEnd(false,"API Error: Request rejected (429)·[1302][速率限制]")
//     →退避态（streak/backoffUntil/action_summary 可见「限流退避中（下次尝试 HH:MM:SS）」）
//     →reviveEligible 跳过（rate-limit-backoff）→二次 429 升档→回合成功清账→到点自清续跑。
//   B 并发帽：8 单帽 6→2 排队（queued:true+队列长度+台账 queued 行）→空位放行（drain 后
//     队列减一+新单真派出）。
// 环境：CCR_ORG_DIR 沙盒+CCR_WORKER_CONCURRENCY_CAP=6+CCR_RATE_LIMIT_BASE_MS=50（短退避）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { backoffDelayMs } from "../src/dispatch-retry.js";
import { reviveEligible } from "../src/lifecycle/revive.js";
import { readDispatchLog } from "../src/org.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

const ORG = mkdtempSync(join(tmpdir(), "rl-org-"));
const DATA = mkdtempSync(join(tmpdir(), "rl-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_WORKER_CONCURRENCY_CAP = "6";
process.env.CCR_RATE_LIMIT_BASE_MS = "50"; // 退避短值（50ms 起：50→100→200…测试可等）

const io_read = (rel: string) => readFileSync(rel, "utf8");
let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ok - " + n); } else { fail++; console.error("FAIL: " + n); } };

// ---------- A0 纯函数：指数+抖动+封顶 ----------
{
  const now = 1_800_000_000_000;
  const jit = 0.8 + (now % 41) / 100;
  const seq = [1, 2, 3, 6, 9].map((s) => backoffDelayMs(s, 30_000, 600_000, now));
  ok(Math.abs(seq[0] - 30_000 * jit) <= 1, `A0a streak1=30s×抖动（实测 ${seq[0]}ms）`);
  ok(Math.abs(seq[1] - 60_000 * jit) <= 1 && Math.abs(seq[2] - 120_000 * jit) <= 1, "A0b 指数升档 60s→120s");
  ok(Math.abs(seq[3] - 600_000 * jit) <= 1 && Math.abs(seq[4] - 600_000 * jit) <= 1, "A0c 封顶 10min（streak6=960s 裁到 600s；streak9 同封顶）");
  const spread = [0, 1, 2, 3, 4].map((k) => backoffDelayMs(1, 30_000, 600_000, now + k * 7));
  ok(Math.max(...spread) / Math.min(...spread) <= 1.2 / 0.8 + 0.01, "A0d 抖动带 0.8~1.2（防同刻共振）");
}

// ---------- 真链：SessionManager + 假 agent ----------
const { SessionManager } = await import("../src/session-manager.js");
const { EventBus } = await import("../src/event-bus.js");
const cfg = (await import("../src/config.js")).loadConfig();
const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
const mgr = new SessionManager(bus, cfg as never);

// 假 agent 工厂：spawn 记录；sendMessage 直回 turn end（成败可控）；可注入 429 失败
const spawned: { cb: AgentCallbacks; agent: AgentLike & { fire429: () => void; fireOk: () => void } }[] = [];
let nextFail429 = false;
let holdTurn = false; // B 组：挂着不收口（占满并发帽用——成功回合即释放槽位）
mgr.setAgentFactory(((_cwd: string, _m: string, cb: AgentCallbacks): AgentLike => {
  const a = {
    id: `agent-${spawned.length + 1}`, startedAt: Date.now(), ended: false,
    sendMessage: () => {
      if (holdTurn) return; // 占位：不回 turn end=恒 WORKING 占槽
      setTimeout(() => {
        if (nextFail429) cb.onTurnEnd(false, "API Error: Request rejected (429)·[1302][速率限制]", 100);
        else cb.onTurnEnd(true, "success", 100);
      }, 10);
    },
    // 测试直驱口：不经 sendMessage 触发回合终态（A 组用）
    fire429: () => cb.onTurnEnd(false, "API Error: Request rejected (429)·[1302][速率限制]", 100),
    fireOk: () => cb.onTurnEnd(true, "success", 100),
    allow: () => false, deny: () => false, answer: () => false,
    stop: async () => { (a as { ended: boolean }).ended = true; cb.onSessionEnd("stopped"); },
    setPermissionMode: async () => {},
  } as never;
  spawned.push({ cb, agent: a });
  return a;
}) as never);

// A 组夹具：一个已拉起的 managed 会话（经 dispatchWorker 真链拉起最重——直造：用
// mgr 内部 create？最小面：dispatchWorker 一单（假 factory 拉起即 spawned[0]），随后
// 用 fire429/fireOk 驱动回合终态。
{
  const r = mgr.dispatchWorker({ anchor: DATA, prompt: "A 组夹具会话：429 退避验证", title: "rl-a" });
  ok(r.ok === true && !(r as { queued?: boolean }).queued, `A1 夹具单派出（ok 实值=${r.ok} 直派【R1 修真：原同义反复恒真】）`);
  await wait(80);
  ok(spawned.length >= 1, "A2 假 agent 拉起");
}
const fix = spawned[0];
{
  // A3 首次 429 → 退避态
  fix.agent.fire429();
  await wait(30);
  const s = mgr.getExternal("") ?? null; // managed 会话不经 getExternal——直接看 mgr 内部：
  // managed 会话在 sessions：找 title 含 rl-a
  const snap = mgr.snapshot();
  const target = snap.find((x) => x.title?.includes("rl-a") || x.action_summary?.includes("限流退避中"));
  ok(!!target && target.action_summary.includes("限流退避中"), `A3 退避态可见（action_summary=${target?.action_summary?.slice(0, 30)}）`);
  ok(target!.action_summary.includes("下次尝试"), "A3b 带下次尝试时刻（用户免手动捞）");
  // A4 reviveEligible 跳过
  const managed = (mgr as unknown as { sessions: Map<string, { state: { session_id: string; title?: string }; rateLimitBackoffUntil?: number; rateLimitStreak?: number }> });
  let hit: { rateLimitBackoffUntil?: number; rateLimitStreak?: number } | undefined;
  for (const v of managed.sessions.values()) if (v.rateLimitBackoffUntil) hit = v;
  ok(!!hit && hit.rateLimitStreak === 1, "A4 退避账在（streak=1）");
  // A6 二次 429 → 升档 streak=2（先升档再验拦截——50ms 短退避定时器到点自清会
  // 抢在断言前清 backoffUntil，二次 429 重置窗口后断言稳）
  fix.agent.fire429();
  await wait(15);
  ok(hit!.rateLimitStreak === 2 && (hit!.rateLimitBackoffUntil ?? 0) > Date.now(), "A6 二次 429 升档（streak=2 退避更长）");
  const why = reviveEligible(mgr, managed.sessions.get(snap.find((x) => x.action_summary?.includes("限流退避中"))!.session_id));
  ok(why === "rate-limit-backoff", `A5 reviveEligible 拦截（why=${why}——重试风暴不放大）`);
  // A7 到点自清（短退避 50ms 系——已过）+ 回合成功清账
  await wait(400); // 退避 50×jitter≈40-60ms 到点自清
  ok(!hit!.rateLimitBackoffUntil, "A7 到点自清（backoffUntil 清——streak 留账升档用）");
  fix.agent.fire429(); await wait(20);
  fix.agent.fireOk(); await wait(30);
  ok(!hit!.rateLimitStreak && !hit!.rateLimitBackoffUntil, "A8 回合成功清账（限流解除）");
}

// ---------- B 组：并发帽（fixture 直造活槽——绕 dispatchWorker 全链深依赖） ----------
{
  holdTurn = true; // drain 放行重入 dispatchWorker 时挂起不收口（防释放循环）
  // 直造 6 个活 managed（agent 在=占槽；state 最小面——闸只读 external/agent）
  const inner = (mgr as unknown as { sessions: Map<string, { agent: unknown; state: { session_id: string; external?: boolean; status: string; cwd: string; title: string; stats: { files_changed: number; lines_added: number; lines_deleted: number }; started_at: number; updated_at: number } }> });
  const fixtureIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const sid = `fx-rl-${i}`;
    inner.sessions.set(sid, {
      agent: { id: `fx-agent-${i}` },
      state: { session_id: sid, status: "WORKING", cwd: DATA, title: `fx ${i}`, stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, started_at: Date.now(), updated_at: Date.now() },
    });
    fixtureIds.push(sid);
  }
  ok(mgr.activeManagedCount() >= 6, `B1 前置：≥6 活 worker 占满帽（实测 ${mgr.activeManagedCount()}，含 A 组残留）`);
  // B2/B3：超帽单 → 排队不拒收
  const r7 = mgr.dispatchWorker({ anchor: DATA, prompt: "B 第 7 单应排队", title: "rl-q7" });
  const r8 = mgr.dispatchWorker({ anchor: DATA, prompt: "B 第 8 单应排队", title: "rl-q8" });
  ok((r7 as { queued?: boolean }).queued === true && (r8 as { queued?: boolean }).queued === true, "B2 超帽单 queued:true（排队不拒收）");
  ok(mgr.dispatchQueueSize() === 2, `B3 队列长度 2（实测 ${mgr.dispatchQueueSize()}）`);
  const log = readDispatchLog(ORG);
  ok(log.some((e) => e.status === "queued" && (e.receipt ?? "").includes("全局并发触顶")), "B4 台账 queued 行（全局并发触顶文案）");
  // B5：空位语义——释放 fixture 槽至帽下后新单不再排队（直派；队内积压由收口边
  // drainDispatchQueue 既有基建接续——test-dispatch 已覆盖该路径，此处不重复驱动）
  for (const fid of fixtureIds) {
    if (mgr.activeManagedCount() < 6) break;
    inner.sessions.delete(fid);
  }
  const B5_ANCHOR = mkdtempSync(join(tmpdir(), "rl-b5-")); // R1：独立锚——原 DATA 锚有排队单在队（无 drain 边未出队），目录锁拒同锚新单是正确保护，与「空位直派」语义无关
  const r9 = mgr.dispatchWorker({ anchor: B5_ANCHOR, prompt: "B 空位后第 9 单应直派", title: "rl-q9" });
  ok(r9.ok === true, `B5 空位后新单直派不再排队（ok=${r9.ok} err=${(r9 as { error?: string }).error ?? ""} workers=${mgr.activeManagedCount()}【R1 修真：原对拒收恒真】）`);
}


// ---------- R1 断言组（P0 双桶排水+B2 failed 行+B1 过闸/落盘+B4 护栏+文本锚）----------
{
  console.log("R1-P0 无 gid 排水/必败 failed/过闸/文本锚:");
  const readSrc = io_read("src/session-manager.ts");
  ok(readSrc.includes("?? this.dispatchQueueItems.find((x) => !(x.input as { gid?: string }).gid)"), "R1-e 双桶排水文本锚（P0：无 gid 桶每次 drain 顺带——六触发点零改动覆盖）");
  ok(readSrc.includes("排队重放拒收"), "R1-f drain ok:false failed 行文本锚（B2 全族兜口：台账收敛+trigger 锁释放）");
  ok(!readSrc.includes("!input.queue_replay && this.activeManagedCount()"), "R1-g queue_replay 不再豁免全局闸（B1-a 反锚——重启重放过帽）");
  ok(readSrc.includes("rate-limit-backoff.json"), "R1-h 退避态落盘文本锚（B1-b）");
  ok(readSrc.includes("this.emitUpdated(managed, true); // R1（A-P1）"), "R1-i 退避摘要即时帧（A-P1 可见性）");
  ok(readSrc.includes("rateLimitBackoffUntil: this.backoffUntilOf"), "R1-j keepalive 退避钳（A-P1-2）");
  ok(readSrc.includes("backoffUntilOf(s.state.session_id) > Date.now()) continue"), "R1-k 选席退避钳（B3）");
  ok(readSrc.includes("if (s.rateLimitTimer) { clearTimeout(s.rateLimitTimer); s.rateLimitTimer = null; this.persistRateLimitBackoff"), "R1-l 删卡清退避定时器（A-P2-4）");
  ok(readSrc.includes("全局排队满仓（200）"), "R1-d 200 满仓护栏（B4）");
  ok(readSrc.includes('if (s.rateLimitTimer) { clearTimeout(s.rateLimitTimer); s.rateLimitTimer = null; }\n    this.persistRateLimitBackoff'), "R1-m retireSession 清定时器（B7）");
  ok(readSrc.includes('if (s.state.action_summary === "wd-stall") continue;'), "R1-n wd-stall 不占帽（B6）");
  // 行为断言：无 gid 单占满帽→排队→释放→出队（真链）
  const CAP = 6;
  const sessMap = (mgr as unknown as { sessions: Map<string, { state: { session_id: string } }> }).sessions;
  for (const k of [...sessMap.keys()]) sessMap.delete(k); // 清场
  const busy: string[] = [];
  for (let i = 0; i < CAP; i++) {
    const r = mgr.dispatchWorker({ anchor: mkdtempSync(join(tmpdir(), "rl-r1-anchor-")), prompt: `占帽 ${i}`, title: `rl-occ2-${i}` }) as { ok: boolean; queued?: boolean; session_id?: string };
    if (!r.ok || r.queued) break;
    busy.push(r.session_id ?? "");
  }
  ok(busy.length >= 1, `占帽就位（busy=${busy.length} active=${mgr.activeManagedCount()}）`);
  const rNg = mgr.dispatchWorker({ anchor: mkdtempSync(join(tmpdir(), "rl-r1-anchor2-")), prompt: "R1 无 gid 排水验证单", title: "rl-ng2" }) as { ok: boolean; queued?: boolean; dispatch_id?: string };
  ok(rNg.ok === true && rNg.queued === true, `R1-a 无 gid 单入队（ok=${rNg.ok} queued=${rNg.queued}）`);
  const ngId = rNg.dispatch_id ?? "";
  // 释放槽（真路径：摘会话腾位+close 触发 drain）。双桶 FIFO——rNg 之前可能还有
  // 早段残留无 gid 单（r8 等）先出队（先来先服务=正确序），轮询多轮直到 rNg 出队。
  let round = 0;
  let queueNow = (mgr as unknown as { dispatchQueueItems: Array<{ dispatch_id: string }> }).dispatchQueueItems;
  while (queueNow.some((x) => x.dispatch_id === ngId) && round < 10) {
    const victim = busy[round] ?? [...sessMap.keys()][0];
    if (!victim) break;
    sessMap.delete(victim);
    (mgr as unknown as { closeOpenDispatches: (k: string, s: string, r: string) => void }).closeOpenDispatches(victim, "done", `释放槽-R1-r${round}`);
    await wait(80);
    queueNow = (mgr as unknown as { dispatchQueueItems: Array<{ dispatch_id: string }> }).dispatchQueueItems;
    round++;
  }
  const qItems = queueNow;
  const stillInQueue = qItems.some((x) => x.dispatch_id === ngId);
  ok(!stillInQueue, `R1-b 无 gid 排队单出队（队列无此 id【P0 主断言：原六触发点 string 键控永不排水】）`);
  const logRows = readDispatchLog(ORG).filter((e) => e.id === ngId);
  const converged = logRows.some((e) => e.status === "dispatched" || e.status === "running" || e.status === "done" || e.status === "failed");
  ok(converged, `R1-b2 台账行收敛（终态/dispatched【P0：原 queued 永悬+目录锁永锁锚】）`);
}

console.log(`\n== test-ratelimit429 汇总：${pass} ok / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
