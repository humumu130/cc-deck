// ---------- #105 pmwake 落点错位根修测试：no-leader 值守目标 = 用户实际 PM 会话 ----------
// 覆盖：
//   L1 leader 模式回归：值守注入仍走 resumeAgent 落 Leader 锚卡（created prompt 含
//      [值守喂活]），extInput 零调用——现行为不变；
//   N1 no-leader + worker turn_end → result=continue + bridge.extInput 注入落
//      external PM 卡（sid=PM、text 含 [值守喂活]、PM 卡时间线有留痕行）+ Leader
//      锚卡零值守 spawn（1015 实锤反面：喂弃用锚卡 128 行全 sleep 零 continue）；
//   N2 no-leader 无活 external（无 pid / 死 pid）→ sleep no_pm_target 可观测哑值守；
//   N3 no-leader + PM WORKING → 合并门直接返回（extInput 零调用不催）；
//   N4 finishExternal(PM 卡) → workerDonePending 归零 + turn_end 触发审计行
//      （external PM 回合终态=值守检查点，对齐托管 Leader turn_end 语义）。
// fixture 缝仿 test-pm-duty-product（mkdtemp+CCR_ORG_DIR 注入+fake agent factory+
// fake bridge；CCR_CONFIG_FILE/CCR_ACCEPTANCE_DIR 双隔离——config 与验收面绝不触生产）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-pmwake-target.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { writeCollabMode } from "../src/settings.js";
import { setLightConfirmTrusted, upsertBoardEntry } from "../src/projects.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks; engine?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { engine?: string }): AgentLike => {
    void cwd;
    void model;
    created.push({ prompt, cb, ...(opts?.engine ? { engine: opts.engine } : {}) });
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; },
      setPermissionMode: async () => {},
    };
    return a;
  };

function readNdjson<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

function send(mgr: SessionManager, command_id: string, type: string, payload: Record<string, unknown>, by: string) {
  const cmd = { command_id, type, payload } as unknown as Command;
  return mgr.handleCommand(cmd, by);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let seq = 0;
function mkFixture(dirs: string[]) {
  const DATA = mkdtempSync(join(tmpdir(), `ccr-p105-data-${++seq}-`));
  const ORG = mkdtempSync(join(tmpdir(), `ccr-p105-org-${seq}-`));
  const ANCHOR = mkdtempSync(join(tmpdir(), `ccr-p105-anchor-${seq}-`));
  dirs.push(DATA, ORG, ANCHOR);
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  setLightConfirmTrusted(true);
  const cfg: RelayConfig = {
    port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  const created: SpawnRec[] = [];
  mgr.setAgentFactory(makeFakeFactory(created));
  const extInputs: { sid: string; text: string }[] = [];
  mgr.setBridge({
    extInput: (sid: string, text: string) => { extInputs.push({ sid, text }); return { ok: true }; },
    resolvePending: () => false,
    answerPending: () => null,
    extStop: () => ({ ok: true }),
    refreshTodos: () => ({ ok: true }),
    hideTodo: () => ({ ok: true }),
    forget: () => {},
  });
  const rounds = () => readNdjson<Record<string, unknown>>(join(DATA, "duty-rounds.ndjson"));
  const ack = send(mgr, `p105g${seq}`, "COMMAND_ORG_ACTION", { action: "create", name: `pmwake组${seq}`, anchor_dir: ANCHOR, tier: "轻立项" }, "web-1");
  const gid = (ack.data as { group?: { id: string } } | undefined)?.group?.id ?? "";
  const card = (text: string): string => {
    const a = send(mgr, `p105c${seq}-${randomUUID().slice(0, 6)}`, "COMMAND_TASK_CREATE", { gid, text }, "web-1");
    return (a.data as { entity_id?: string }).entity_id ?? "";
  };
  const dispatch = (prompt: string): number => {
    const workerIdx = created.length;
    send(mgr, `p105w${seq}-${randomUUID().slice(0, 6)}`, "COMMAND_DISPATCH", { gid, prompt }, "web-1");
    return workerIdx;
  };
  const ensureLeaderIdx = (): number => {
    const base = created.length;
    const r = mgr.ensureLeader();
    if (!r.ok) throw new Error("ensureLeader 失败");
    created[created.length - 1]?.cb.onInit(`sdk-p105-${seq}-boot`, "test-model");
    return base;
  };
  const mkPm = (): string => {
    const id = `ext-pm-${seq}-${randomUUID().slice(0, 8)}`;
    mgr.ensureExternal(id, ANCHOR, "PM 主会话", `sdk-pm-${seq}`);
    mgr.setExternalCliPid(id, process.pid); // 本进程 pid：信号 0 探测恒活
    return id;
  };
  return { mgr, created, extInputs, rounds, gid, card, dispatch, ensureLeaderIdx, mkPm, dataDir: DATA, cleanup: () => {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
  } };
}

const prevEnv = ["CCR_PM_DUTY", "CCR_PM_DUTY_STALE_MS", "CCR_PM_DUTY_CONTINUATION_MS", "CCR_ACCEPTANCE_DIR", "CCR_CONFIG_FILE", "CCR_ORG_DIR", "CCR_NO_TITLE_GEN"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of prevEnv) saved[k] = process.env[k];

try {
  process.env.CCR_PM_DUTY = "1";
  process.env.CCR_PM_DUTY_STALE_MS = "0";
  process.env.CCR_PM_DUTY_CONTINUATION_MS = "30";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_ACCEPTANCE_DIR = mkdtempSync(join(tmpdir(), "ccr-p105-acc-"));
  const CFG = mkdtempSync(join(tmpdir(), "ccr-p105-cfg-"));
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  const dirs: string[] = [CFG, process.env.CCR_ACCEPTANCE_DIR];

  // ---------- L1 leader 模式回归：注入仍走 resumeAgent 落锚卡 ----------
  console.log("L1 leader 模式回归");
  {
    const f = mkFixture(dirs);
    const leaderIdx = f.ensureLeaderIdx();
    f.card("L1 待办卡");
    const wIdx = f.dispatch("L1 worker 活");
    f.created[leaderIdx]?.cb.onTurnEnd(true, "boot", 1); // Leader boot 收口置 DONE（worker done 边过 WORKING 门的前提）
    const before = f.created.length;
    f.created[wIdx].cb.onTurnEnd(true, "done", 1); // worker 交付 → feedPM("worker_done")
    const cont = f.rounds().filter((r) => r.result === "continue");
    assert(cont.length >= 1, "L1① result=continue（leader 模式现行为）");
    assert(f.extInputs.length === 0, "L1② extInput 零调用（leader 模式不走 external 通路）");
    const dutySpawn = f.created.find((x) => (x.prompt ?? "").includes("[值守喂活]"));
    assert(!!dutySpawn, "L1③ 值守注入落 Leader 锚卡（resumeAgent spawn prompt 含 [值守喂活]）");
    assert(f.created[leaderIdx] !== undefined, "L1④ Leader 在档");
    f.cleanup();
  }

  // ---------- N1 no-leader：注入落 external PM 卡 ----------
  console.log("N1 no-leader 目标切换");
  {
    const f = mkFixture(dirs);
    const leaderIdx = f.ensureLeaderIdx();
    writeCollabMode(f.dataDir, "no-leader");
    const pmId = f.mkPm();
    (f.mgr as unknown as { setExternalStatus(id: string, s: string, sum: string): void }).setExternalStatus(pmId, "DONE", "空闲等输入");
    f.card("N1 待办卡");
    const wIdx = f.dispatch("N1 worker 活");
    f.created[leaderIdx]?.cb.onTurnEnd(true, "boot", 1); // 锚卡 boot 收口置 DONE（no-leader 下此口不再触发值守——目标已切 external）
    const before = f.created.length;
    f.created[wIdx].cb.onTurnEnd(true, "done", 1);
    const cont = f.rounds().filter((r) => r.result === "continue");
    assert(cont.length >= 1, "N1① result=continue（no-leader 喂活真实发生——1015 实锤的反面）");
    const hit = f.extInputs.find((x) => x.sid === pmId && x.text.includes("[值守喂活]"));
    assert(!!hit, "N1② 注入经 bridge.extInput 落 external PM 卡（text 含 [值守喂活]）");
    const pmLogs = (f.mgr as unknown as { getExternalLogs(id: string): { text: string }[] }).getExternalLogs(pmId);
    assert(pmLogs.some((l) => (l.text ?? "").includes("[值守喂活]")), "N1③ PM 卡时间线留痕（pushExternalLog 落实际目标卡）");
    const anchorDuty = f.created.slice(before).find((x) => (x.prompt ?? "").includes("[值守喂活]"));
    assert(!anchorDuty, "N1④ Leader 锚卡零值守注入（弃用锚不再被喂）");
    void leaderIdx;
    f.cleanup();
  }

  // ---------- N2 no-leader 无活 external：可观测哑值守 ----------
  console.log("N2 no-leader 无 PM 目标");
  {
    const f = mkFixture(dirs);
    f.ensureLeaderIdx();
    writeCollabMode(f.dataDir, "no-leader");
    // 死 pid external：spawn 短命进程拿 pid 等它退出
    const p = spawn("sleep", ["0.05"]);
    const deadPid = p.pid ?? 0;
    await sleep(300);
    const deadId = `ext-dead-${seq}-${randomUUID().slice(0, 6)}`;
    f.mgr.ensureExternal(deadId, "/tmp", "死壳 PM", "sdk-dead");
    f.mgr.setExternalCliPid(deadId, deadPid);
    // 无 pid external：不该被选中
    const noPidId = `ext-nopid-${seq}-${randomUUID().slice(0, 6)}`;
    f.mgr.ensureExternal(noPidId, "/tmp", "无定位 PM", "sdk-nopid");
    f.card("N2 待办卡");
    const wIdx = f.dispatch("N2 worker 活");
    f.created[wIdx].cb.onTurnEnd(true, "done", 1);
    const rows = f.rounds();
    const noTarget = rows.find((r) => r.result === "sleep" && r.reason === "no_pm_target");
    assert(!!noTarget, "N2① sleep no_pm_target 审计行（哑值守可观测）");
    assert(!rows.some((r) => r.result === "continue"), "N2② 零 continue（不喂幽灵不喂死壳）");
    assert(f.extInputs.length === 0, "N2③ extInput 零调用");
    f.cleanup();
  }

  // ---------- N3 no-leader + PM WORKING：合并门不催 ----------
  console.log("N3 PM WORKING 合并门");
  {
    const f = mkFixture(dirs);
    f.ensureLeaderIdx();
    writeCollabMode(f.dataDir, "no-leader");
    const pmId = f.mkPm();
    (f.mgr as unknown as { setExternalStatus(id: string, s: string, sum: string): void }).setExternalStatus(pmId, "WORKING", "PM 在岗干活");
    f.card("N3 待办卡");
    const wIdx = f.dispatch("N3 worker 活");
    f.created[wIdx].cb.onTurnEnd(true, "done", 1);
    assert(f.extInputs.length === 0, "N3① PM WORKING 零注入（合并不催——external 排队路径同样不追发）");
    const cont = f.rounds().filter((r) => r.result === "continue");
    assert(cont.length === 0, "N3② 零 continue 审计（合并门先于判定返回）");
    f.cleanup();
  }

  // ---------- N4 finishExternal(PM) → 归零 + turn_end 检查点 ----------
  console.log("N4 external PM 回合终态检查点");
  {
    const f = mkFixture(dirs);
    f.ensureLeaderIdx();
    writeCollabMode(f.dataDir, "no-leader");
    const pmId = f.mkPm();
    (f.mgr as unknown as { setExternalStatus(id: string, s: string, sum: string): void }).setExternalStatus(pmId, "DONE", "空闲等输入");
    f.card("N4 待办卡");
    const wIdx = f.dispatch("N4 worker 活");
    f.created[wIdx].cb.onTurnEnd(true, "done", 1); // → continue（PM 收到注入）
    const pendingAfterFeed = (f.mgr as unknown as { workerDonePending: number }).workerDonePending;
    // worker_done_pending 在 feed 时不清零（PM 只是收到通知，还没处理）——喂活后仍 ≥1
    assert(pendingAfterFeed >= 1, "N4① 喂活后 worker_done_pending 仍在（处理语义未完成）");
    (f.mgr as unknown as { setExternalStatus(id: string, s: string, sum: string): void }).setExternalStatus(pmId, "WORKING", "PM 处理中");
    const roundsBefore = f.rounds().length;
    (f.mgr as unknown as { finishExternal(id: string, r: string, d: number): void }).finishExternal(pmId, "completed", 100);
    const rows = f.rounds();
    assert(rows.length > roundsBefore, "N4② finishExternal 触发新 duty 轮（turn_end 检查点）");
    assert((f.mgr as unknown as { workerDonePending: number }).workerDonePending === 0, "N4③ worker_done_pending 归零（PM 在岗盘点过）");
    const lastRow = rows[rows.length - 1] as { trigger?: string[] };
    assert(lastRow.trigger?.includes("turn_end") || rows.slice(roundsBefore).some((r) => (r.trigger as string[])?.includes("turn_end")),
      "N4④ 新行 trigger=turn_end");
    f.cleanup();
  }

  // ---------- pm_parked 复查（任务书第 2 点）：no-leader external 目标无 saved 概念 ----------
  console.log("P-parked no-leader 停放语义复查");
  {
    const f = mkFixture(dirs);
    f.ensureLeaderIdx();
    writeCollabMode(f.dataDir, "no-leader");
    const pmId = f.mkPm();
    // external 卡置 saved（异常态防御）：不该走 pm_parked 停放分支（判定只对托管目标）
    const pmState = (f.mgr as unknown as { getExternal(id: string): { saved?: boolean } | undefined }).getExternal(pmId);
    if (pmState) pmState.saved = true;
    (f.mgr as unknown as { setExternalStatus(id: string, s: string, sum: string): void }).setExternalStatus(pmId, "DONE", "空闲等输入（saved 标记在身）");
    f.card("P 待办卡");
    const wIdx = f.dispatch("P worker 活");
    const pLeaderIdx = 0; // ensureLeaderIdx 的 Leader 是本 fixture 首个 spawn
    f.created[pLeaderIdx]?.cb.onTurnEnd(true, "boot", 1); // 锚卡收口置 DONE
    f.created[wIdx].cb.onTurnEnd(true, "done", 1);
    const rows = f.rounds();
    assert(!rows.some((r) => r.reason === "pm_parked"), "P① external 目标不落 pm_parked（停放判定限托管——no-leader 哑值守问题随目标切换消解）");
    assert(rows.some((r) => r.result === "continue"), "P② 注入照常发生（saved 标记不哑掉 external 目标）");
    f.cleanup();
  }

  console.log(`\nP105 pmwake target: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  for (const k of prevEnv) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  const dirs: string[] = [];
  void dirs;
  // mkFixture 内登记的目录清理（简单扫 tmp 前缀，7 天清扫兜底，这里主动清）
  for (const d of [process.env.CCR_ACCEPTANCE_DIR, process.env.CCR_CONFIG_FILE ? join(process.env.CCR_CONFIG_FILE, "..") : undefined]) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  }
}
