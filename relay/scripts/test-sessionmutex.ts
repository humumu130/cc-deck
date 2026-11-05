// W-SESSIONMUTEX 断言件（1105 晨，撞车三部曲根治）：
//   A 守卫单点：sessionTwinWhy 判据三态（resume-in-flight 窗内/orphan-alive 探测活/
//   内存 agent 在≠孪生[接管语义放行]/CCR_TWIN_PROBE=0 逃生阀）
//   B resumeAgent 兜底闸：同 sid 双进程注入（fixture 孤儿 pid=本测试进程 pid=必活）
//     →第二实例拒拉起+session-twin-blocked 审计；autoRevive 选人跳过（reviveEligible
//     前置=候选即跳不浪费 throw 轮）
//   C 树锁 pid 细粒度：cli_pid 透传三口（write/read/acquire）+pid 差异读侧可见
// 事故锚：bootfast 1331/81905/2223 三活进程同 --resume 互踩（1104 夜实录——
// relay 重启后内存 agent 丢+外部进程活=autoRevive 叠加实例的真形态）。
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
mgr.setAgentFactory(((_cwd: string, _m: string, cb: AgentCallbacks): AgentLike => {
  spawnAttempts++;
  const a = {
    id: `agent-${spawnAttempts}`, startedAt: Date.now(), ended: false,
    sendMessage: () => { setTimeout(() => cb.onTurnEnd(true, "success", 10), 5); },
    allow: () => false, deny: () => false, answer: () => false,
    stop: async () => { (a as { ended: boolean }).ended = true; cb.onSessionEnd("stopped"); },
    setPermissionMode: async () => {},
  } as never;
  return a;
}) as never);

{
  // 夹具：拉起一会话 → 收口（agent 残留置 null 模拟 relay 重启丢内存）→ state.cli_pid=MY_PID（孤儿活）
  const r = mgr.dispatchWorker({ anchor: DATA, prompt: "B 夹具会话", title: "sm-b" });
  ok(r.ok === true && !(r as { queued?: boolean }).queued, "B1 夹具单派出");
  await wait(60);
  const snap = mgr.snapshot();
  const sid = snap.find((x) => x.title?.includes("sm-b"))?.session_id;
  ok(!!sid, "B2 夹具会话在册");
  const inner = (mgr as unknown as { sessions: Map<string, { agent: unknown; state: { session_id: string; cli_pid?: number; relay_session_id?: string } }> });
  const wrapper = sid ? inner.sessions.get(sid) : undefined;
  ok(!!wrapper, "B3 wrapper 在手");
  // 模拟撞车形态：内存 agent 丢（重启）+外部 pid=本测试进程（必活）+有 relay_session_id
  wrapper!.agent = null;
  wrapper!.state.cli_pid = process.pid;
  wrapper!.state.relay_session_id = wrapper!.state.relay_session_id ?? "fake-sdk-id-sm";
  // B4 resumeAgent 拒拉起（throw+审计）
  let threw = "";
  const audits: string[] = [];
  (mgr as unknown as { emitChainAudit: (k: string, d: string) => void });
  try {
    (mgr as unknown as { resumeAgent: (w: unknown, m: string) => void }).resumeAgent(wrapper, "[t] 双进程注入拉起");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok(threw.includes("活进程") && threw.includes("W-SESSIONMUTEX"), `B4 第二实例拒拉起（throw 实证：${threw.slice(0, 50)}）`);
  ok(spawnAttempts === 1, `B5 无新 spawn（实测 ${spawnAttempts}——autoRevive 叠加实例通道封死）`);
  // B6 reviveEligible 前置：候选即跳（session-twin）
  const why = reviveEligible(mgr, wrapper);
  ok(why === "session-twin", `B6 reviveEligible 前置拦截（why=${why}——autoRevive/#36 候选即跳）`);
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
