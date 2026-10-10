// #7 SDK 会话流中断看门狗全链路测试：双通道起疑 / CPU 双采样防误杀 / 采样窗内恢复
// 中止 / 杀树重拉 + 未回显消息重放 / 防风暴放弃 / 排除项（WAITING·无 pid·pre-init
// parked）/ 禁用开关。
// 全部走测试缝：agentFactory 假 agent（带 fake childPid）+ setWatchdogProcs 假进程树，
// 不拉真 CLI、不真杀进程；看门狗由 mgr.tickWatchdog() 手动驱动。
// 窗口参数受实现下限约束（STALL≥5s、FAST≥2s、SAMPLE≥50ms），静默等待期把阈值 hush
// 到 10min/3min——心跳 5s 与慢窗口 5s 同频，不 hush 时心跳会抢先开窗（抖动源），
// 手动 tick 前再 arm 回测试值，保证开窗者确定是本测试。
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { readDispatchLog } from "../src/org.js";
import type { Envelope, WatchdogPayload } from "../src/types.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 5000, every = 20): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(every);
  }
  return fn();
};

// 数据目录隔离 + 短看门狗参数（env 逐次求值，测试内动态可改）
// org 台账沙盒（#25-P7）：recoverFromStall 自愈动作现在落 dispatch-log.ndjson——
// 不钉 CCR_ORG_DIR 会直写用户真实 ~/.cc-deck/org（生产数据污染，test:ws 事故同类）
const TDATA = fileURLToPath(new URL("../data/test-wd-datadir/", import.meta.url));
process.env.CCR_DATA_DIR = TDATA;
const TORG = mkdtempSync(join(tmpdir(), "ccr-wd-org-"));
process.env.CCR_ORG_DIR = TORG;
// 台账断言（#25-P7）验证的是 dispatch-log.ndjson 写入面；2026-10-06 SQLITE-FLIP 后
// 读侧缺省走 sqlite 投影（导入器灌库 + target 有损映射），沙盒里 wdLedger 恒空——
// 本测试钉 JSON 读档恢复其本意（read-mode currentReadMode 逐次求值，env 即时生效）
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_WATCHDOG_STALL_MS = "5000";
process.env.CCR_WATCHDOG_FAST_MS = "2000";
process.env.CCR_WATCHDOG_SAMPLE_MS = "100";
rmSync(TDATA, { recursive: true, force: true });

const QUIET_SLOW = 5200; // > STALL(5000)
const QUIET_FAST = 2200; // > FAST(2000)
const hush = (): void => {
  process.env.CCR_WATCHDOG_STALL_MS = "600000";
  process.env.CCR_WATCHDOG_FAST_MS = "180000";
};
const arm = (): void => {
  process.env.CCR_WATCHDOG_STALL_MS = "5000";
  process.env.CCR_WATCHDOG_FAST_MS = "2000";
};

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const events: Envelope[] = [];
bus.subscribe((e) => events.push(e));
const wdPayloads = (sid: string, action: WatchdogPayload["action"]) =>
  events
    .filter((e) => e.type === "WATCHDOG" && e.session_id === sid && (e.payload as WatchdogPayload).action === action)
    .map((e) => e.payload as WatchdogPayload);
const wd = (sid: string, action: WatchdogPayload["action"]) => wdPayloads(sid, action).length > 0;
const wdCount = (action: WatchdogPayload["action"]) =>
  events.filter((e) => e.type === "WATCHDOG" && (e.payload as WatchdogPayload).action === action).length;
const hasSysLog = (sid: string, kw: string) =>
  events.some((e) => e.type === "SESSION_LOG" && e.session_id === sid && String((e.payload as { text?: string }).text ?? "").includes(kw));
// #25-P7 台账观察：看门狗自愈动作的 dispatch-log 行（tier="看门狗"）
const wdLedger = (sid: string) => readDispatchLog().filter((e) => e.tier === "看门狗" && e.session_id === sid);

// ---- 假 agent 工厂：20ms 后 onInit 就绪；保持 WORKING（不自动回合结束） ----
// P1FIX 同步回显建模（2026-10-10）：真实 adapter 的 sendMessage 在发送时刻**同步**发
// user_message 回显并透传 ackId——旧 fake 只记录不回显，「回显出队」场景靠测试事后手工
// onLog 模拟「CLI 稍后异步回显」的假想行为，与生产时序错位，恰好掩盖了 unacked 账
// 「永不按本条出队」的 P1（审计 W-AUDIT-CORRECT 实锤）。改同步回显后，凡断言 unacked
// 行为的用例测的都是真时序
interface Rec {
  prompt: string | undefined;
  resume?: string;
  cb: AgentCallbacks;
  agent: AgentLike & { childPid?: number; sent: { text: string; images?: string[]; echo?: string; ackId?: string }[] };
}
const created: Rec[] = [];
let noPidFrom = Infinity; // 该序号起的 agent 不带 childPid（排除项场景用）
let noInitFrom = Infinity; // 该序号起的 agent 永不 onInit（pre-init parked 场景用）
mgr.setAgentFactory((_cwd, _model, cb, prompt, opts) => {
  const a = {
    id: randomUUID(),
    startedAt: Date.now(),
    ended: false,
    // #62：记录 sendMessage 收到的实参（托管发文件断言用：正文合成 + echo 分离；
    // P1FIX 增记 ackId 供出账链路断言）
    sent: [] as { text: string; images?: string[]; echo?: string; ackId?: string }[],
    sendMessage: (text: string, images?: string[], echo?: string, ackId?: string) => {
      const rec = a as AgentLike & { childPid?: number; sent: { text: string; images?: string[]; echo?: string; ackId?: string }[] };
      rec.sent.push({ text, images, echo, ackId });
      if (!a.ended) cb.onLog("user_message", echo ?? text, ackId ? { ackId } : undefined);
    },
    allow: () => false,
    deny: () => false,
    answer: () => false,
    stop: async () => {},
    setPermissionMode: async () => {},
  } as AgentLike & { childPid?: number; sent: { text: string; images?: string[]; echo?: string }[] };
  if (created.length < noPidFrom) (a as { childPid?: number }).childPid = 40000 + created.length;
  const rec: Rec = { prompt, resume: opts?.resume, cb, agent: a };
  created.push(rec);
  if (created.length > noInitFrom) return a; // pre-init 形态：init 永不到达（brand-new parked）
  setTimeout(() => {
    if (a.ended) return;
    cb.onInit("sdk-" + a.id.slice(0, 8), "test-model", "default");
  }, 20);
  return a;
});

// ---- 假进程树：快照吐罐头 CPU 值（cpuFeed 逐次 shift，空了重复末值 → 两轮同值=空闲；
// 两值差 ≥500ms = 活跃）；killTree 记 pid 并模拟"进程死亡 → SDK 流关闭" ----
let cpuFeed: number[] = [100, 100];
let cpuLast = 100;
const killedPids: number[] = [];
mgr.setWatchdogProcs({
  snapshotTree: async () => {
    const v = cpuFeed.length ? (cpuLast = cpuFeed.shift()!) : cpuLast;
    const m = new Map<number, { ppid: number; cpuMs: number }>();
    for (const r of created) {
      const pid = r.agent.childPid;
      if (pid) m.set(pid, { ppid: 1, cpuMs: v });
    }
    return m;
  },
  killTree: async (pid: number) => {
    killedPids.push(pid);
    const rec = created.find((r) => r.agent.childPid === pid);
    if (rec && !rec.agent.ended) {
      rec.agent.ended = true;
      rec.cb.onSessionEnd("killed");
    }
    return "killed";
  },
});

const ack = (cmd: Parameters<SessionManager["handleCommand"]>[0]) =>
  mgr.handleCommand(cmd, "test") as { ok: boolean; session_id?: string; error?: string };
const stateOf = (sid: string) => mgr.snapshot().find((s) => s.session_id === sid);

async function main(): Promise<void> {
  // ===== A. 快通道命中 → 杀树重拉（parked）+ 活流发送同步回显即时出队（零残留）
  //      + 流死重发路径仍入账 → 看门狗带账重放 =====
  // P1FIX 时序语义（2026-10-10）：sendMessage 的回显是同步的（真 adapter 行为），
  // 已 init 会话的消息发出即出账（出账语义 = relay 已投递）——此后流死恢复走 parked
  // 不重放（A1/A2）；「看门狗带账重放」覆盖移到 A3 的流死重发路径（resumeAgent 首条
  // 消息走 initialPrompt 无回显，hold:"turn" 在账直到首个 ok 回合结束）
  const a1 = ack({ command_id: "c-a1", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "看门狗 A" }, ts: Date.now() });
  assert(a1.ok === true && typeof a1.session_id === "string", "A 会话创建");
  const sidA = a1.session_id!;
  const recA1 = created[created.length - 1];
  assert(await waitFor(() => !!stateOf(sidA)?.relay_session_id), "A onInit 就绪");
  const sdkA = stateOf(sidA)!.relay_session_id;
  recA1.cb.onLog("tool_result", "工具完成", { tool: "Bash" }); // 快通道指纹：工具已回，CLI 本该立刻接话
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_FAST);
  arm();
  mgr.tickWatchdog();
  assert(wdPayloads(sidA, "stall_detected").some((p) => p.lane === "fast"), "A 快通道起疑（tool_result 静默超窗）");
  assert(await waitFor(() => wd(sidA, "recover_ok")), "A 采样→僵死→恢复完成（recover_ok）");
  assert(killedPids.includes(recA1.agent.childPid!), "A 杀树收到 childPid");
  assert(wd(sidA, "zombie_confirmed"), "A 两轮 CPU 采样判僵死");
  const recA2 = created[created.length - 1];
  // 无任何未出账消息 → 恢复走 parked（reviveSaved，prompt 空）而非带账 resume
  assert(recA2 !== recA1 && recA2.resume === sdkA && recA2.prompt === undefined, "A 空账恢复走 parked（不重放）");
  assert(hasSysLog(sidA, "看门狗接管"), "A 时间线留『看门狗接管』（用户可见）");
  // #25-P7 台账行：自愈动作进回执流（tier=看门狗，done，跨重启可审计）
  assert(wdLedger(sidA).some((e) => e.status === "done" && (e.receipt ?? "").startsWith("看门狗接管")), "A 台账留看门狗自愈行（done·看门狗接管）");
  assert(
    await waitFor(() => stateOf(sidA)?.status === "DONE" && (stateOf(sidA)?.done_reason ?? "").includes("已恢复")),
    "A parked 恢复停在等待输入（DONE·已恢复）",
  );

  // A2 活流发消息 → 同步回显即时出账（零残留行为验证）：发一条再僵死一次，恢复仍
  // parked——若账内还滞留该消息，恢复会带账 resume（prompt 非空）当场暴露
  const sdkA2 = "sdk-" + recA2.agent.id.slice(0, 8);
  assert(await waitFor(() => stateOf(sidA)?.relay_session_id === sdkA2), "A2 新 agent init 落地");
  const msgA2 = ack({ command_id: "m-a2", type: "COMMAND_MESSAGE", payload: { session_id: sidA, text: "活流发的消息" }, ts: Date.now() });
  assert(msgA2.ok === true, "A2 活流消息 ack");
  assert(recA2.agent.sent.some((m) => m.text === "活流发的消息"), "A2 消息进活流（同 agent sendMessage）");
  recA2.cb.onLog("tool_result", "工具完成 2", { tool: "Bash" });
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_FAST);
  arm();
  mgr.tickWatchdog();
  assert(await waitFor(() => created.length >= 3), "A2 第二次僵死重拉");
  const recA3 = created[created.length - 1];
  // 假 agent 每次生成新 sdk id：parked resume 从"最新"SDK 会话 id 续（真 SDK resume 同 id，此处只验证非空续接语义）
  assert(recA3.prompt === undefined && recA3.resume === sdkA2, "A2 同步回显即时出队（零残留）→ 恢复走 parked 不重放");
  assert(
    await waitFor(() => stateOf(sidA)?.status === "DONE" && (stateOf(sidA)?.done_reason ?? "").includes("已恢复")),
    "A2 parked 恢复停在等待输入（DONE·已恢复）",
  );
  const sdkA3 = "sdk-" + recA3.agent.id.slice(0, 8);
  assert(await waitFor(() => stateOf(sidA)?.relay_session_id === sdkA3), "A2 新 agent init 落地");

  // A3 流死重发路径仍入账（任务书断言②）：resumeAgent 首条消息 = initialPrompt 路径
  // 永无回显，入账（hold:"turn"）→ 新流再僵死 → 看门狗带账重放（prompt = 该消息）。
  // 独立新会话：sidA 的防风暴滑窗已被 A1/A2 两次自愈烧满（≥2 次即 gave_up），再接管
  // 不会发生——这正是防风暴语义，A3 的重放覆盖换新会话验
  const a9 = ack({ command_id: "c-a9", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "看门狗 A3" }, ts: Date.now() });
  assert(a9.ok === true && typeof a9.session_id === "string", "A3 会话创建（独立会话，自愈额度独立计）");
  const sidA9 = a9.session_id!;
  assert(await waitFor(() => !!stateOf(sidA9)?.relay_session_id), "A3 onInit 就绪");
  const recA9 = created[created.length - 1];
  const sdkA9 = stateOf(sidA9)!.relay_session_id;
  recA9.agent.ended = true; // 模拟流崩：死流分支判定只看 ended，不走假 killTree 免噪音
  const msgA3 = ack({ command_id: "m-a3", type: "COMMAND_MESSAGE", payload: { session_id: sidA9, text: "流死后发的消息" }, ts: Date.now() });
  assert(msgA3.ok === true, "A3 流死消息 ack（resumeAgent 接管）");
  assert(await waitFor(() => created.length >= 5), "A3 流死发送 → resume 重拉");
  const recA4 = created[created.length - 1];
  assert(recA4.prompt === "流死后发的消息" && recA4.resume === sdkA9, "A3 首条消息随 resume 入账（hold:turn，未出账）");
  assert(await waitFor(() => stateOf(sidA9)?.relay_session_id === "sdk-" + recA4.agent.id.slice(0, 8)), "A3 新流 init 落地");
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(await waitFor(() => created.length >= 6), "A3 新流再僵死 → 接管");
  const recA5 = created[created.length - 1];
  assert(recA5.prompt === "流死后发的消息", "A3 账内消息随接管重放（watchdog 带账重放回归锁）");
  assert(await waitFor(() => stateOf(sidA9)?.status === "WORKING"), "A3 重放恢复后 WORKING");
  recA5.cb.onTurnEnd(true, "A3 收尾退场", 1000); // 退场（DONE）：WORKING 会话留到 B 的
  // tick 会同窗起疑抢走 B 的 cpuFeed 序列（采样按 tick 顺序异步并发），B 被误判僵尸

  // ===== B. CPU 活跃 → 误杀排除 + 锚点后移 =====
  const b1 = ack({ command_id: "c-b1", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "看门狗 B 长构建" }, ts: Date.now() });
  const sidB = b1.session_id!;
  assert(await waitFor(() => !!stateOf(sidB)?.relay_session_id), "B onInit 就绪");
  const recB = created[created.length - 1];
  const countBeforeB = created.length;
  cpuFeed = [100, 2600]; // 采样窗内整树烧 2.5s CPU = 真干活（长构建/长思考）
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(wdPayloads(sidB, "stall_detected").some((p) => p.lane === "slow"), "B 慢通道起疑（任意静默超窗）");
  assert(await waitFor(() => wd(sidB, "cpu_active")), "B 整树 CPU 活跃 → 不判僵死");
  assert(!wd(sidB, "zombie_confirmed"), "B 无僵死判定");
  assert(created.length === countBeforeB, "B 未被杀（零重拉）");
  await wait(100);
  mgr.tickWatchdog(); // 锚点刚被 cpu_active 后移：不应立刻再次起疑
  const earlyB = wdPayloads(sidB, "stall_detected").some((p) => (p.stalled_ms ?? 9999) < 4000);
  assert(!earlyB, "B 锚点后移（cpu_active 后不连续起疑）");
  assert(stateOf(sidB)?.status === "WORKING", "B 保持 WORKING");

  // ===== C. 采样窗内恢复进展 → 中止 =====
  cpuFeed = [100, 110];
  recB.cb.onLog("tool_use", "干活", { tool: "Bash" });
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(wdPayloads(sidB, "stall_detected").length === 2, "C 采样前 B 再次起疑（第 2 次）");
  setTimeout(() => recB.cb.onLog("assistant_text", "又说话了"), 40); // 落在 100ms 采样窗内
  await wait(400);
  assert(!wd(sidB, "zombie_confirmed"), "C 采样窗内恢复进展 → 中止（不判僵死）");
  assert(!killedPids.includes(recB.agent.childPid!), "C B 未被杀");
  assert(stateOf(sidB)?.status === "WORKING", "C B 未被动过");
  recB.cb.onTurnEnd(true, "测试收尾", 5000); // B 退场（DONE），后续场景不再参与检测

  // ===== D. 排除项：WAITING 合法静默 / 无 childPid 不起疑（两会话同窗验证） =====
  const d1 = ack({ command_id: "c-d1", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "看门狗 D 等待" }, ts: Date.now() });
  const sidD = d1.session_id!;
  assert(await waitFor(() => !!stateOf(sidD)?.relay_session_id), "D onInit 就绪");
  const recD = created[created.length - 1];
  recD.cb.onWaiting({ request_id: "r1", tool_name: "Bash", input_summary: "等审批", suggestions: [] });
  assert(stateOf(sidD)?.status === "WAITING", "D 进入 WAITING（等审批）");
  noPidFrom = created.length; // 此后工厂产出的 agent 无 childPid（假实现/云通道等形态）
  const d2 = ack({ command_id: "c-d2", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "看门狗 D2 无 pid" }, ts: Date.now() });
  const sidD2 = d2.session_id!;
  assert(await waitFor(() => !!stateOf(sidD2)?.relay_session_id), "D2 onInit 就绪");
  assert(created[created.length - 1].agent.childPid === undefined, "D2 假 agent 无 childPid");
  await wait(QUIET_SLOW); // 两会话均静默超慢窗口
  mgr.tickWatchdog();
  assert(!wd(sidD, "stall_detected"), "D WAITING 态不检测（等审批是合法静默）");
  assert(!wd(sidD2, "stall_detected"), "D2 无 pid 不起疑（无 CPU 证据不下手）");
  noPidFrom = Infinity;

  // ===== E. 防风暴：1h 内 ≥2 次自愈后放弃（WAITING + 黄框通知） =====
  const e1 = ack({ command_id: "c-e1", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "看门狗 E 风暴" }, ts: Date.now() });
  const sidE = e1.session_id!;
  assert(await waitFor(() => !!stateOf(sidE)?.relay_session_id), "E onInit 就绪");
  // 第 1 轮：静默 → 僵死 → 无未回显消息 → parked 自愈（recover_ok #1）
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(await waitFor(() => wd(sidE, "recover_ok")), "E 第 1 轮自愈完成（parked 恢复）");
  // 唤醒：先等恢复的新 agent init 落地再发——消除「init 前发送落互斥窗（hold:turn
  // 在账会被重放）/ init 后走活流（同步回显即时出账）」的竞态，断言才能确定化。
  // P1FIX 后本段验证活流路径：消息同步回显即时出账，第 2 轮恢复走 parked（不重放）
  const recE1 = created[created.length - 1];
  assert(await waitFor(() => stateOf(sidE)?.relay_session_id === "sdk-" + recE1.agent.id.slice(0, 8)), "E 第 1 轮恢复的新流 init 落地");
  // 唤醒：发一条消息（DONE → WORKING）
  const w1 = ack({ command_id: "m-e1", type: "COMMAND_MESSAGE", payload: { session_id: sidE, text: "第二轮消息" }, ts: Date.now() });
  assert(w1.ok === true && stateOf(sidE)?.status === "WORKING", "E 唤醒（消息驱动回 WORKING）");
  // 第 2 轮：静默 → 僵死 → 空账 parked 自愈（recover_ok #2）；「带账重放」覆盖在 A3。
  // 等待用 delta 计数（wdCount 是全局数，A1/A2/A3 已烧掉 3 次，>=2 会瞬间放行，
  // 断言跑在恢复完成前——竞态）
  const recoverOkBeforeE2 = wdCount("recover_ok");
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(await waitFor(() => wdCount("recover_ok") >= recoverOkBeforeE2 + 1), "E 第 2 轮自愈完成");
  assert(created[created.length - 1].prompt === undefined, "E 第 2 轮活流消息已即时出账 → parked 恢复（不重放）");
  // 第 3 轮起疑需 WORKING：第 2 轮 parked 恢复后卡面 DONE（P1FIX 后不再带账 resume）。
  // 先等 R2 的 init 落地（否则 onInit 的 revive 包裹会把状态覆写回 DONE），再
  // onStatusChange 翻回 WORKING 模拟 CLI 报活（stall 检测只扫 WORKING）
  const recE2r2 = created[created.length - 1];
  assert(await waitFor(() => stateOf(sidE)?.relay_session_id === "sdk-" + recE2r2.agent.id.slice(0, 8)), "E 第 2 轮恢复的新流 init 落地");
  recE2r2.cb.onStatusChange("WORKING", "第 3 轮唤醒");
  // 第 3 轮：1h 滑窗内已 2 次自愈 → 放弃（不再拉起）
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(await waitFor(() => wd(sidE, "gave_up")), "E 第 3 轮放弃（防风暴上限）");
  assert(await waitFor(() => stateOf(sidE)?.status === "WAITING"), "E 放弃后转 WAITING");
  const stE = stateOf(sidE)!;
  assert((stE.action_summary ?? "").includes("上限"), "E 摘要说明已达上限");
  assert(hasSysLog(sidE, "已达上限"), "E 时间线留已达上限说明");
  // #25-P7 台账行：放弃=停止干预的重要状态变化，failed 醒目留痕
  assert(wdLedger(sidE).some((e) => e.status === "failed" && (e.receipt ?? "").includes("停止自动干预")), "E 台账留放弃行（failed·停止自动干预）");
  assert(
    (stE.todos ?? []).some((t) => t.content.includes("[待确认]") && t.content.includes("流中断")),
    "E 黄框通知（[待确认] 条目注入）",
  );
  const countAfterGiveup = created.length;
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  await wait(200);
  assert(created.length === countAfterGiveup, "E 放弃后不再拉起新 agent");

  // ===== H. #109 放弃路径重构：不预杀树 + 流回调自愈翻回 WORKING + 手动接管补刀旧树 =====
  const recE2 = created[created.length - 1]; // 放弃时仍挂着的 agent（第 2 轮重拉的那个）
  assert(!recE2.agent.ended, "H 放弃路径未预杀树（agent 仍挂着）");
  assert(!killedPids.includes(recE2.agent.childPid!), "H 放弃时未发杀树指令");
  // H1 流回魂：任何流回调都是活体证据 → 撤销放弃、翻回 WORKING
  recE2.cb.onLog("assistant_text", "其实流还活着");
  assert(await waitFor(() => stateOf(sidE)?.status === "WORKING"), "H1 流回调 → 自愈翻回 WORKING");
  assert(hasSysLog(sidE, "已自动撤销等待状态"), "H1 时间线留自愈说明");
  // H2 自愈后发消息走活流（不 resume）：同 agent 收到，不拉新 agent
  const createdBeforeH2 = created.length;
  const hMsg = ack({ command_id: "m-h1", type: "COMMAND_MESSAGE", payload: { session_id: sidE, text: "自愈后的消息" }, ts: Date.now() });
  assert(hMsg.ok === true, "H2 自愈后消息 ack");
  assert(recE2.agent.sent.some((m) => m.text === "自愈后的消息"), "H2 消息进活流（同 agent sendMessage）");
  assert(created.length === createdBeforeH2, "H2 未拉新 agent");
  // H3 再次停滞 → 滑窗内仍 2 次 → 再放弃（依旧不杀）；手动消息 → resume 接管 + 补刀旧树
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(await waitFor(() => wdCount("gave_up") >= 2), "H3 再次放弃（滑窗内仍 2 次）");
  assert(await waitFor(() => stateOf(sidE)?.status === "WAITING"), "H3 再次 WAITING");
  const createdBeforeH3 = created.length;
  const oldPidH = recE2.agent.childPid!;
  const hMsg2 = ack({ command_id: "m-h2", type: "COMMAND_MESSAGE", payload: { session_id: sidE, text: "手动恢复" }, ts: Date.now() });
  assert(hMsg2.ok === true, "H3 手动消息 ack");
  assert(await waitFor(() => created.length === createdBeforeH3 + 1), "H3 resume 拉起新 agent");
  assert(created[created.length - 1].prompt === "手动恢复", "H3 重放手动消息");
  assert(await waitFor(() => killedPids.includes(oldPidH)), "H3 接管补刀旧树（无孤儿进程）");
  assert(await waitFor(() => stateOf(sidE)?.status === "WORKING"), "H3 接管后 WORKING");
  // H4 流身份守卫：旧流（补刀收尾 / 回魂）事件整体忽略——不改状态、不进时间线
  assert(stateOf(sidE)?.status === "WORKING", "H4 补刀收尾回调未污染新流状态");
  recE2.cb.onLog("assistant_text", "旧流幽灵消息");
  assert(
    !events.some((e) => e.type === "SESSION_LOG" && e.session_id === sidE && String((e.payload as { text?: string }).text ?? "").includes("旧流幽灵消息")),
    "H4 旧流事件不进时间线",
  );
  assert(stateOf(sidE)?.status === "WORKING", "H4 旧流不翻状态");

  // ===== F. 禁用开关：同条件一关一开对照 =====
  const f1 = ack({ command_id: "c-f1", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "看门狗 F 禁用对照" }, ts: Date.now() });
  const sidF = f1.session_id!;
  assert(await waitFor(() => !!stateOf(sidF)?.relay_session_id), "F onInit 就绪");
  process.env.CCR_WATCHDOG_DISABLE = "1";
  await wait(QUIET_SLOW); // 静默超慢窗口（心跳同频 tick 也被开关拦下）
  mgr.tickWatchdog();
  assert(!wd(sidF, "stall_detected"), "F CCR_WATCHDOG_DISABLE=1 全停");
  delete process.env.CCR_WATCHDOG_DISABLE;
  mgr.tickWatchdog();
  assert(wd(sidF, "stall_detected"), "F 开关移除后同条件立即起疑（对照）");
  // F 起疑后的异步自愈（采样→parked 恢复）确定性收尾：不收尾的话它会落进 G 的
  // 静默窗，恢复 agent 撞上 noInitFrom 永不 init，卡"恢复中"被 G 的 tick 二次自愈
  assert(await waitFor(() => stateOf(sidF)?.status === "DONE" && (stateOf(sidF)?.done_reason ?? "").includes("已恢复")), "F 僵死自愈收尾（DONE·已恢复）");

  // ===== G. pre-init parked 豁免：init 未到且无未回显消息 = 合法等待，不检测；
  // 发过消息（unacked 非空）仍检测——僵死后无 sdkId 可恢复，recover_fail → ERROR 上屏 =====
  noInitFrom = created.length; // 此后 agent 永不 onInit（brand-new parked：CLI 零输出等首条消息）
  const g1 = ack({ command_id: "c-g1", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "" }, ts: Date.now() });
  const sidG = g1.session_id!;
  const recG = created[created.length - 1];
  assert(recG.prompt === undefined && !stateOf(sidG)?.relay_session_id, "G parked 创建（无初始消息，init 未到）");
  cpuFeed = [100, 100];
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(!wd(sidG, "stall_detected"), "G pre-init parked 静默不检测（合法等待输入）");
  assert(!killedPids.includes(recG.agent.childPid!), "G parked CLI 未被误杀");
  // 用户发消息后仍未有 init：起疑 → 僵死 → 恢复失败上屏（不静默吊死）
  const gMsg = ack({ command_id: "m-g1", type: "COMMAND_MESSAGE", payload: { session_id: sidG, text: "G 的第一条消息" }, ts: Date.now() });
  assert(gMsg.ok === true, "G parked 会话发消息入账（unacked 非空）");
  const createdBeforeG = created.length;
  hush();
  await wait(QUIET_SLOW);
  arm();
  mgr.tickWatchdog();
  assert(wdPayloads(sidG, "stall_detected").some((p) => p.lane === "slow"), "G 有未回显消息后起疑");
  assert(await waitFor(() => wd(sidG, "recover_fail")), "G 无 sdkId 恢复失败（recover_fail）");
  assert(killedPids.includes(recG.agent.childPid!), "G 僵死 CLI 已收杀");
  assert(await waitFor(() => stateOf(sidG)?.status === "ERROR"), "G 死局上屏（ERROR 而非永挂启动中）");
  assert((stateOf(sidG)?.last_error ?? "").includes("无法自动恢复"), "G last_error 说明无法自动恢复");
  assert(created.length === createdBeforeG, "G 不再拉起新 agent（无 sdkId 可续）");
  noInitFrom = Infinity;

  // ===== #62 托管会话发文件：COMMAND_MESSAGE files → relay 落盘 tmp（原名）+ 正文
  // 合成路径指令下发 agent + echo 分离（客户端回显不带临时路径）=====
  {
    const a62 = ack({ command_id: "c-62", type: "COMMAND_CREATE", payload: { cwd: process.cwd(), prompt: "62 托管发文件" }, ts: Date.now() });
    assert(a62.ok === true && typeof a62.session_id === "string", "62 托管会话创建");
    const sid62 = a62.session_id!;
    assert(await waitFor(() => !!stateOf(sid62)?.relay_session_id), "62 onInit 就绪");
    const rec62 = created[created.length - 1];
    const docB64 = Buffer.from("托管文件内容 hello", "utf-8").toString("base64");
    const m62 = ack({
      command_id: "m-62", type: "COMMAND_MESSAGE",
      payload: { session_id: sid62, text: "看下这个文件", files: [{ name: "桌面文档.txt", b64: docB64 }] },
      ts: Date.now(),
    });
    assert(m62.ok === true, "62 托管发文件 ack ok");
    const sent62 = rec62.agent.sent.at(-1)!;
    assert(sent62.text.startsWith("看下这个文件") && sent62.text.includes("文件已保存：") && sent62.text.includes("桌面文档.txt"), "62 agent 收到合成正文（原文+路径指令）");
    assert(sent62.echo === "看下这个文件（+1 文件）", "62 echo 分离（原文本+计数，不含路径）");
    const tmp62 = join(TDATA, "..", "tmp");
    const saved62 = readdirSync(tmp62).filter((f) => f.startsWith("file-"));
    assert(saved62.some((f) => f.endsWith("桌面文档.txt")), "62 文件落盘 tmp 保留原始名");
    rmSync(tmp62, { recursive: true, force: true });
  }

  mgr.setAgentFactory(null);
  mgr.setWatchdogProcs(null);
  rmSync(TDATA, { recursive: true, force: true });
  rmSync(TORG, { recursive: true, force: true });
  console.log(
    `\nWATCHDOG TESTS PASSED（${events.length} events，起疑 ${wdCount("stall_detected")} / 自愈 ${wdCount("recover_ok")} / 放弃 ${wdCount("gave_up")}）`,
  );
  process.exit(0);
}

void main();
