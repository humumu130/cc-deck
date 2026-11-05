// W-SESSIONMUTEX 断言件（1105 晨，撞车三部曲根治）：
//   A 守卫单点：sessionTwinWhy 判据三态（resume-in-flight 窗内/orphan-alive 探测活/
//   内存 agent 在≠孪生[接管语义放行]/CCR_TWIN_PROBE=0 逃生阀）
//   B resumeAgent 兜底闸：同 sid 双进程（R1 起真链：fixture spawn→onInit 边回写
//     state.cli_pid[A 审 P0 修复面]→模拟重启 agent=null→孤儿 pid=本测试进程=必活）
//     →第二实例拒拉起+twinBlock 标记；autoRevive 选人跳过；reviveSaved 头部守卫
//     （R1 P1-1 单点）；target_sid 派单孪生拒=挂起待裁决（R1 P2-2）
//   C 树锁 pid 细粒度：cli_pid 透传三口（write/read/acquire）+pid 差异读侧可见
//   D R1 真链组：onInit 回写落盘帧（events.ndjson cli_pid 在=重启回放源）+树锁
//     pid 写入边（自己锁回写/他人锁不动/窗不续）
// 事故锚：bootfast 1331/81905/2223 三活进程同 --resume 互踩（1104 夜实录——
// relay 重启后内存 agent 丢+外部进程活=autoRevive 叠加实例的真形态）。
// R1（t-d71f1382）：A 审 P0（managed pid 源缺失）+P1×2（reviveSaved 旁路/锁写入边）
// +P2 前两件（审计限频/熟手挂起）返修——B 组手工注入全部换真链。
// 直跑：env -u CCR_DATA_DIR -u CCR_ORG_DIR -u CCR_PORT npx tsx scripts/test-sessionmutex.ts
for (const k of ["CCR_DATA_DIR", "CCR_ORG_DIR", "CCR_PORT", "CCR_PARENT_PID", "CCR_RELAY_CHILD"]) delete process.env[k];
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { sessionTwinWhy, reviveEligible } from "../src/lifecycle/revive.js";
import { writeWorktreeLock, readWorktreeLock, acquireWorktreeLock } from "../src/dispatch-lock.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

const ORG = mkdtempSync(join(tmpdir(), "sm-org-"));
const DATA = mkdtempSync(join(tmpdir(), "sm-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STORAGE_READ_MODE = "json";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ok - " + n); } else { fail++; console.error("FAIL: " + n); } };

// ---------- A 守卫单点判据 ----------
{
  const MY_PID = process.pid; // 必活 pid（本测试进程）
  ok(sessionTwinWhy({ resumePending: Date.now() - 1000, agent: null, state: { cli_pid: MY_PID } }) === "resume-in-flight",
    "A1 resumePending 窗内=in-flight（统一互斥单点）");
  ok(sessionTwinWhy({ resumePending: undefined, agent: null, state: { cli_pid: MY_PID } }) === `orphan-alive:${MY_PID}`,
    "A2 孤儿面：无 agent+pid 活=orphan-alive（撞车三部曲根因形态——今晚实录）");
  ok(sessionTwinWhy({ resumePending: undefined, agent: { id: "a" }, state: { cli_pid: MY_PID } }) === null,
    "A3 内存 agent 在≠孪生（接管换代语义——renewable/reinjection 合法路径不拦）");
  ok(sessionTwinWhy({ resumePending: undefined, agent: null, state: { cli_pid: 999_999_999 } }) === null,
    "A4 pid 已死=无孤儿放行（process.kill 探测 ESRCH）");
  const saved = process.env.CCR_TWIN_PROBE;
  process.env.CCR_TWIN_PROBE = "0";
  ok(sessionTwinWhy({ resumePending: undefined, agent: null, state: { cli_pid: MY_PID } }) === null,
    "A5 CCR_TWIN_PROBE=0 逃生阀（测试面关探测）");
  process.env.CCR_TWIN_PROBE = saved;
}

// ---------- B resumeAgent 兜底闸+reviveEligible 前置 ----------
const { SessionManager } = await import("../src/session-manager.js");
const { EventBus } = await import("../src/event-bus.js");
const cfg = (await import("../src/config.js")).loadConfig();
const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
const mgr = new SessionManager(bus, cfg as never);
let spawnAttempts = 0;
let initSeq = 0;
mgr.setAgentFactory(((_cwd: string, _m: string, cb: AgentCallbacks): AgentLike => {
  spawnAttempts++;
  const n = spawnAttempts;
  // R1 真链 fixture：模拟真实 spawn 时序——childPid 就位（spawn 边）→ onInit（pid
  // 回写边=R1 P0 产品面）→ onTurnEnd（回合收口）。pid=本测试进程=必活（孤儿探测真阳）。
  const sdk = `sdk-sm-${++initSeq}`;
  setTimeout(() => {
    try {
      cb.onInit(sdk, "test-model");
      setTimeout(() => cb.onTurnEnd(true, "success", 10), 5);
    } catch { /* 产品面守卫 throw（孪生等）在此静默——由显式调用组断言 */ }
  }, 0);
  const a = {
    id: `agent-${n}`, startedAt: Date.now(), ended: false, childPid: process.pid,
    sendMessage: () => { setTimeout(() => cb.onTurnEnd(true, "success", 10), 5); },
    allow: () => false, deny: () => false, answer: () => false,
    stop: async () => { (a as { ended: boolean }).ended = true; cb.onSessionEnd("stopped"); },
    setPermissionMode: async () => {},
  } as never;
  return a;
}) as never);

{
  // 夹具：拉起一会话（spawn→onInit 真链回写 cli_pid→回合收口）→ agent 置 null 模拟
  // relay 重启丢内存 → 孤儿 pid（本测试进程）活=撞车三部曲形态。R1 起零手工注入。
  const r = mgr.dispatchWorker({ anchor: DATA, prompt: "B 夹具会话", title: "sm-b" });
  ok(r.ok === true && !(r as { queued?: boolean }).queued, "B1 夹具单派出");
  await wait(80);
  const snap = mgr.snapshot();
  const sid = snap.find((x) => x.title?.includes("sm-b"))?.session_id;
  ok(!!sid, "B2 夹具会话在册");
  const inner = (mgr as unknown as { sessions: Map<string, { agent: unknown; state: { session_id: string; cli_pid?: number; relay_session_id?: string } }> });
  const wrapper = sid ? inner.sessions.get(sid) : undefined;
  ok(!!wrapper, "B3 wrapper 在手");
  // B0 真链探针（R1 P0 核心——A 审「测试 B 组靠手工注入掩盖断链」的替换面）：
  // managed spawn 后 state.cli_pid 由 onInit 边产品代码回写（非注入），且 pid 帧落
  // 盘 events.ndjson（重启回放源）——判据对 managed 人群生产可达。
  ok(wrapper!.state.cli_pid === process.pid, `B0a managed spawn 真链回写 cli_pid（实 ${wrapper!.state.cli_pid}——onInit 边产品面，零手工注入）`);
  ok(!!wrapper!.state.relay_session_id, `B0b relay_session_id 真链回填（实 ${wrapper!.state.relay_session_id?.slice(0, 12)}）`);
  const ndjson = readFileSync(join(DATA, "events.ndjson"), "utf8");
  ok(ndjson.includes(`"cli_pid":${process.pid}`), "B0c pid 帧落盘 events.ndjson（重启回放源在——history.ts W-INJECT 链）");
  // 模拟撞车形态：内存 agent 丢（重启）——孤儿 pid 已由真链在册（活=本测试进程）
  wrapper!.agent = null;
  // B4 resumeAgent 拒拉起（throw+twinBlock 标记）
  let threw = "";
  let twinFlag = false;
  try {
    (mgr as unknown as { resumeAgent: (w: unknown, m: string) => void }).resumeAgent(wrapper, "[t] 双进程注入拉起");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
    twinFlag = !!(e as { twinBlock?: boolean })?.twinBlock;
  }
  ok(threw.includes("活进程") && threw.includes("W-SESSIONMUTEX"), `B4 第二实例拒拉起（throw 实证：${threw.slice(0, 50)}）`);
  ok(twinFlag, "B4b twinBlock 标记位在（dispatchWorker catch 面挂起分支的识别依据——R1 P2-2）");
  ok(spawnAttempts === 1, `B5 无新 spawn（实测 ${spawnAttempts}——autoRevive 叠加实例通道封死）`);
  // B6 reviveEligible 前置：候选即跳（session-twin）
  const why = reviveEligible(mgr, wrapper);
  ok(why === "session-twin", `B6 reviveEligible 前置拦截（why=${why}——autoRevive/#36 候选即跳）`);
  // B8 reviveSaved 头部守卫（R1 P1-1 单点——watchdog recoverFromStall/COMMAND_RESUME
  // 两旁路口自此受护；直调本体验守卫在 throw 出口）
  let threwRs = "";
  try {
    (mgr as unknown as { reviveSaved: (w: unknown) => void }).reviveSaved(wrapper);
  } catch (e) {
    threwRs = e instanceof Error ? e.message : String(e);
  }
  ok(threwRs.includes("活进程") && threwRs.includes("W-SESSIONMUTEX"), `B8 reviveSaved 头部守卫拒拉（R1 P1-1 单点：${threwRs.slice(0, 40)}）`);
  ok(spawnAttempts === 1, `B9 reviveSaved 拒后仍零新 spawn（实测 ${spawnAttempts}）`);
  // B10 孪生态派单=target_sid 定席路径：resumeAgent 撞守卫 throw→catch 面 twinBlock
  // 分支=挂起待裁决（不降级换作者续跑——R1 P2-2；定席面出口实证，plain 熟手面文本锚）
  const rTwin = mgr.dispatchWorker({ anchor: DATA, prompt: "B10 孪生态派单", title: "sm-twin", target_sid: sid });
  ok(rTwin.ok === false && String((rTwin as { error?: string }).error ?? "").includes("孪生守卫拦"), `B10 定席派单撞孪生=挂起待裁决（实 ${(rTwin as { error?: string }).error ?? "?"}）`);
  ok(spawnAttempts === 1, `B11 挂起后仍零新 spawn（实测 ${spawnAttempts}——不换作者续跑）`);
  // B7 renewable 放行（有意换代语义——守卫不拦 renewable）；需真 sdkId（绕过
  // sdkId 检查到达 renewable 放行语义）——直接深改 state 双字段
  wrapper!.state.cli_pid = 999_999_998; // 死 pid
  wrapper!.state.relay_session_id = "sm-sdk-id-b7";
  ok((inner.sessions.get(sid!)?.state.relay_session_id ?? "") === "sm-sdk-id-b7", `B7 前置：sdkId 赋值在册（实 ${inner.sessions.get(sid!)?.state.relay_session_id}）`);
  try {
    (mgr as unknown as { resumeAgent: (w: unknown, m: string, i?: unknown, e?: unknown, r?: unknown, o?: { renewable?: boolean }) => void }).resumeAgent(wrapper, "[t] renewable", undefined, undefined, undefined, { renewable: true });
    ok(true, "B7 renewable 放行（有意换代——reinjection 引擎杀旧语义保留）");
  } catch (e) {
    ok(false, `B7 renewable 误拦：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- D R1 真链组：onInit 锁回写（P1-2）+文本锚 ----------
{
  // D1/D2 自己单的锁：claim 边形态（session_id 已归属、无 pid）→ spawn→onInit 后
  // 产品代码回写 cli_pid（P1-2 写入边——此前生产恒缺省的无源管线补源）
  const wtdir = mkdtempSync(join(tmpdir(), "sm-wt-"));
  const sidD = (mgr as unknown as { create: (c: string, p: string) => string }).create(wtdir, "");
  const expD = Date.now() + 3600_000;
  writeWorktreeLock(wtdir, { slug: "sm-d", dispatch_id: "d-sm-d", session_id: sidD, created_at: 1234, expires_at: expD });
  await wait(40); // onInit 定时器（factory 排 0ms）+回写边
  const lk = readWorktreeLock(wtdir);
  ok(lk?.cli_pid === process.pid, `D1 树锁 pid 写入边真链（onInit 回写，实 ${lk?.cli_pid}）`);
  ok(lk?.created_at === 1234 && lk?.expires_at === expD, `D2 锁窗不续（created_at/expires_at 原样保留：${lk?.created_at}/${lk?.expires_at}）`);
  // D3 他人锁不被动：session_id 不匹配→零动作（fail-closed，不越权写他人锁）
  const wtdir2 = mkdtempSync(join(tmpdir(), "sm-wt2-"));
  (mgr as unknown as { create: (c: string, p: string) => string }).create(wtdir2, "");
  writeWorktreeLock(wtdir2, { slug: "sm-d2", dispatch_id: "d-sm-d2", session_id: "sm-other-sid" });
  await wait(40);
  ok(readWorktreeLock(wtdir2)?.cli_pid === undefined, "D3 他人锁零动作（session_id 不匹配不回写——不越权）");
  // D4-D6 文本锚（B10 已实证定席面挂起出口；此三锚钉 plain 熟手面同分支+限频+写入边）
  const smSrc = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  const brSrc = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf8");
  ok(smSrc.includes("挂起待裁决（不换作者续跑"), "D4 文本锚：plain 熟手 twinBlock 挂起分支在源（P2-2——与 B10 定席出口同分支）");
  ok(smSrc.includes("树锁 pid 写入边"), "D5 文本锚：onInit 锁回写边注释在源（P1-2）");
  ok(brSrc.includes("孪生持续：pid 对"), "D6 文本锚：bridge 孪生审计限频刷新行在源（P2-1）");
  rmSync(wtdir, { recursive: true, force: true });
  rmSync(wtdir2, { recursive: true, force: true });
}

// ---------- C 树锁 pid 细粒度 ----------
{
  const dir = mkdtempSync(join(tmpdir(), "sm-lock-"));
  writeWorktreeLock(dir, { slug: "sm", dispatch_id: "d-sm", session_id: "s-sm", cli_pid: 12345 });
  const lock = readWorktreeLock(dir);
  ok(lock?.cli_pid === 12345, "C1 锁内容含 cli_pid（write→read 透传）");
  const dir2 = mkdtempSync(join(tmpdir(), "sm-lock2-"));
  const r2 = acquireWorktreeLock(dir2, { slug: "sm2", dispatch_id: "d2", session_id: "s2", cli_pid: 54321 });
  ok(r2.ok && r2.lock.cli_pid === 54321, "C2 acquire 落 pid（原子获取面同透传）");
  rmSync(dir2, { recursive: true, force: true });
  // C3 同 sid 异 pid=读侧差异可见（裁决面）——worktreeHeldByOther 返回锁含对方 pid
  const { worktreeHeldByOther } = await import("../src/dispatch-lock.js");
  const held = worktreeHeldByOther(dir, "d-other");
  ok(held?.cli_pid === 12345 && held?.session_id === "s-sm", "C3 异单读锁见 sid+pid（孪生裁决身份可见——显式接管走 treegc takeover 口）");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n== test-sessionmutex 汇总：${pass} ok / ${fail} FAIL ==`);
rmSync(ORG, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
