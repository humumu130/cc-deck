// W-SCHEDFIX2 回放：派单可靠性两根修（2026-10-19，任务书 /tmp/w-schedfix2-task.md）
// 场景：① 件二 派单即醒——DONE 熟手（健康活流）认领即直注，免换流免轮询（注入在
//         dispatchWorker 调用返回前同步完成 = 不存在等待相位），hold:"turn" 入账，
//         ok 回合结束出账
//       ② 件二·loss-safety + 件一·补投账——直注后流死：下一条消息 resume 换流拉活时
//         flushResumeBacklog 带账补投（补投文本身再入账 hold:"turn"——补投链闭环）
//       ③ 件一 水位告警——unacked 入账带 ackId 透传，sendMessage 同步回显即时出账
//         （零滞留：不污染 unacked 非空判定、不被下次 resume 当积压二次注入）
//       ④ R3 不变式回归锁——僵尸熟手（pid 死）仍走 resumeAgent 换流承接（fast path
//         不误分流死流；僵尸补刀/互斥窗语义零变）
// 断言口径：agent 身份取自 sessions 映射（Leader 会话/值守 duty 的交错 spawn 不污染
// 身份链；免换流 = 同一 agent 对象，换流 = 对象替换）。仿 test-dispatch.ts 假件配方
// （agentFactory 测试缝，不拉真 CLI）+ replay-zombipark 的独立回放形态。
// 直跑：cd relay && npx tsx scripts/replay-schedfix2.ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { listGroups } from "../src/projects.js";
import { routingFor } from "../src/routing.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { Command } from "../src/types.js";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000, every = 5): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// ---------- 假件：init 20ms；回合（spawn prompt/sendMessage 触发）60ms 后收口。
// sendMessage 记账+ackId 同步回显（真 adapter 语义）；autoTurn=false 时回合不自动
// 收口（水位场景：把 onContext 卡在回合中段再手工收口，时序确定化）
type SentRec = { text: string; images?: string[]; echo?: string; ackId?: string };
type FakeAgent = AgentLike & { sent: SentRec[]; childPid?: number };
type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks; agent: FakeAgent; resume?: string; configHome?: string; permissionMode?: string };
let autoTurn = true;
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; resume?: string; configHome?: string }): AgentLike => {
    const a: FakeAgent = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sent: [] as SentRec[],
      sendMessage: (text, images, echo, ackId) => {
        a.sent.push({ text, images, echo, ackId });
        // 真 adapter：带 ackId 的回显同步发出（relay 按 id 精确出账）；无 ackId 回显
        // 不影响账面（hold 条目本就不随回显出账），省略
        if (ackId) cb.onLog("user_message", echo ?? text.slice(0, 120), { ackId });
        if (autoTurn) setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 12); }, 60);
      },
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    created.push({ prompt, cb, agent: a, resume: opts?.resume, configHome: opts?.configHome, permissionMode: opts?.permissionMode });
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, opts?.permissionMode ?? "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        cb.onTurnEnd(true, "success", 12);
      }, 60);
    }, 20);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-schedfix2-org-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-schedfix2-data-"));
  const prev = { org: process.env.CCR_ORG_DIR, title: process.env.CCR_NO_TITLE_GEN, autorevive: process.env.CCR_NO_AUTOREVIVE, activator: process.env.CCR_NO_ACTIVATOR, trim: process.env.CCR_NO_HEADCOUNT_TRIM, read: process.env.CCR_STORAGE_READ_MODE, stall: process.env.CCR_WATCHDOG_STALL_MS, cwd: process.env.CCR_CWD };
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_NO_AUTOREVIVE = "1";
  process.env.CCR_NO_ACTIVATOR = "1";
  process.env.CCR_NO_HEADCOUNT_TRIM = "1";
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_WATCHDOG_STALL_MS = "3600000"; // 本回放不看门狗（安静会话零起疑）
  delete process.env.CCR_CWD;
  const cleanup = () => {
    if (prev.org === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prev.org;
    if (prev.title === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prev.title;
    if (prev.autorevive === undefined) delete process.env.CCR_NO_AUTOREVIVE; else process.env.CCR_NO_AUTOREVIVE = prev.autorevive;
    if (prev.activator === undefined) delete process.env.CCR_NO_ACTIVATOR; else process.env.CCR_NO_ACTIVATOR = prev.activator;
    if (prev.trim === undefined) delete process.env.CCR_NO_HEADCOUNT_TRIM; else process.env.CCR_NO_HEADCOUNT_TRIM = prev.trim;
    if (prev.read === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prev.read;
    if (prev.stall === undefined) delete process.env.CCR_WATCHDOG_STALL_MS; else process.env.CCR_WATCHDOG_STALL_MS = prev.stall;
    if (prev.cwd === undefined) delete process.env.CCR_CWD; else process.env.CCR_CWD = prev.cwd;
    try { rmSync(ORG, { recursive: true, force: true }); rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录尽力清 */ }
  };

  const created: SpawnRec[] = [];
  try {
    const cfg: RelayConfig = {
      port: 8794, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const sentinel = mkdtempSync(join(tmpdir(), "ccr-schedfix2-sentinel-"));
    writeFileSync(join(DATA, "last-cwd"), sentinel, "utf-8");
    cfg.defaultCwd = sentinel;

    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    assertOk(mgr.ensureLeader().ok, "环境就绪（Leader 首建）");

    const mkGroup = (name: string): string => {
      const c = mgr.orgAction("project-create", { name, anchor: mkdtempSync(join(tmpdir(), `ccr-schedfix2-${name}-`)), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string } } };
      assertOk(c.ok, `${name} 建组`);
      mgr.orgAction("confirm-decide", { confirm_id: c.data?.confirm?.id ?? "", approve: true, by: "u" });
      const gid = listGroups().find((g) => g.name === name)?.id ?? "";
      assertOk(!!gid, `${name} 组 id 解析`);
      return gid;
    };
    const dispatch = (prompt: string, g: string) => mgr.orgAction("dispatch", { prompt, gid: g }) as { ok: boolean; session_id?: string; dispatch_id?: string; error?: string };
    type SessView = { unacked: { id: string; text: string; hold?: string; ts: number }[]; agent: AgentLike | null; state: { status: string }; ctxWd?: { armed?: boolean } };
    const sessions = () => (mgr as unknown as { sessions: Map<string, SessView> }).sessions;
    const unackedOf = (sid: string) => sessions().get(sid)?.unacked ?? [];
    const agentOf = (sid: string) => sessions().get(sid)?.agent ?? null;
    const recOf = (sid: string): SpawnRec => created.find((r) => r.agent === agentOf(sid))!;
    const countOf = (g: string, sid: string) => routingFor(g).find((x) => x.session_id === sid)?.count ?? 0;

    // ===== ① 派单即醒：DONE 熟手（健康活流）认领即直注 =====
    console.log("① 派单即醒（DONE 熟手直注）:");
    const gidA = mkGroup("sf2a");
    const d1 = dispatch("首单任务：建立上下文", gidA);
    assertOk(d1.ok === true && !!d1.session_id, "首单新建 worker");
    const w1 = d1.session_id!;
    ok(await waitFor(() => countOf(gidA, w1) === 1), "首单收口（count=1，worker 转 DONE）");
    const w1agent0 = agentOf(w1) as FakeAgent;
    const w1state = () => sessions().get(w1)!.state;
    ok(w1state().status === "DONE" && !!w1agent0, "前置：worker DONE 且流在场");

    const d2 = dispatch("第二单任务：直注验收", gidA);
    ok(d2.ok === true && d2.session_id === w1, "二单命中熟手（同会话承接）");
    // 即时性断言：注入在 dispatchWorker 调用返回前同步完成（无轮询相位可等）
    ok(w1agent0.sent.filter((m) => m.text.includes("第二单任务")).length === 1, "派单 prompt 已送达同一活流（sendMessage 直注）");
    ok(agentOf(w1) === w1agent0, "免换流：同一 agent 对象（不重拉——不重付 CLI 启动+transcript 重载）");
    ok(w1state().status === "WORKING", "状态即时推进 WORKING（派单即醒）");
    ok(unackedOf(w1).length === 1 && unackedOf(w1)[0]!.hold === "turn" && unackedOf(w1)[0]!.text.includes("第二单任务"), "直注 prompt 入账（hold:\"turn\"——回合中断可带账重放）");
    ok(await waitFor(() => countOf(gidA, w1) === 2), "直注回合收口（count=2）");
    ok(unackedOf(w1).length === 0, "ok 回合结束出账（hold:\"turn\" 清账，零残留）");

    // ===== ② 直注后流死：resume 补投链（件二 loss-safety + 件一 补投文再入账） =====
    console.log("② 直注后流死→resume 补投:");
    const d3 = dispatch("第三单任务：断流重放验收", gidA);
    ok(d3.ok === true && d3.session_id === w1 && w1agent0.sent.some((m) => m.text.includes("第三单任务")), "三单直注（第三单任务在活流）");
    w1agent0.ended = true; // 模拟流死（60ms 回合收口前杀流——回合未收口，账内条目在场）
    ok(unackedOf(w1).some((m) => m.text.includes("第三单任务")), "流死时账内滞留直注单（可重放）");
    const msg = mgr.handleCommand({ command_id: "m-1", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: w1, text: "用户消息：拉活并带账" } } as Command, "t");
    assertOk((msg as { ok: boolean }).ok === true, "用户消息触发 resume 拉活");
    ok(agentOf(w1) !== null && agentOf(w1) !== w1agent0, "死流走 resumeAgent 换流（对象替换=spawn 承接）");
    const rec2 = recOf(w1);
    ok(rec2.resume !== undefined, "resume 锚延续（上下文亲和）");
    ok((rec2.prompt ?? "").includes("用户消息"), "用户消息为 resume 首条（initialPrompt）");
    ok(await waitFor(() => rec2.agent.sent.some((m) => m.text.includes("第三单任务"))), "onInit 后 flushResumeBacklog 带账补投直注单");
    ok(unackedOf(w1).some((m) => m.hold === "turn" && m.text.includes("第三单任务")), "补投文再入账（hold:\"turn\"——补投后流再断仍可重放，件一补投链闭环）");
    ok(await waitFor(() => unackedOf(w1).length === 0), "补投回合收口出账（零残留）");

    // ===== ③ 水位告警入账：ackId 回显即时出账（零滞留） =====
    console.log("③ 水位告警 unacked 出账:");
    const gidB = mkGroup("sf2b");
    const d4 = dispatch("第四单任务：水位场景 worker", gidB);
    assertOk(d4.ok === true && !!d4.session_id, "新 worker 建立");
    const w2 = d4.session_id!;
    ok(await waitFor(() => countOf(gidB, w2) === 1), "前置：w2 首单收口");
    const w2agent = agentOf(w2) as FakeAgent;
    const cbW2 = recOf(w2).cb;
    // 手控回合：五单直注后回合不收口（autoTurn=false），onContext 卡回合中段触发（真实语义：
    // 水位帧本就逐调用到达于回合中）
    autoTurn = false;
    const d5 = dispatch("第五单任务：顶回合态", gidB);
    ok(d5.ok === true && d5.session_id === w2 && sessions().get(w2)!.state.status === "WORKING", "五单直注（w2 回合在途）");
    const before = unackedOf(w2).length;
    ok(before >= 1, "前置：回合在途（直注单 hold:\"turn\" 在账）");
    cbW2.onContext?.(190_000); // ≥85% × 默认 200K 档 → 触发摘要指令
    ok(sessions().get(w2)?.ctxWd?.armed === true, "水位阈值触发（ctxWd.armed）");
    const wlsent = w2agent.sent.filter((m) => m.text.includes("上下文水位即将触及压缩阈值"));
    ok(wlsent.length === 1 && !!wlsent[0]!.ackId, "摘要指令直发且带 ackId（出账对账键）");
    ok(unackedOf(w2).length === before, "回显同步出账：unacked 零滞留（修复点——此前条目永不出队，滞留污染判定+二次重放）");
    autoTurn = true;
    cbW2.onTurnEnd?.(true, "success", 5); // 回合收口（水位指令随此回合结束出账）
    ok(await waitFor(() => unackedOf(w2).length === 0), "回合结束零账（无任何滞留条目）");

    // ===== ④ R3 不变式回归锁：僵尸熟手仍 resume 换流承接（独立组防熟手池串场） =====
    console.log("④ R3 不变式（僵尸熟手仍换流）:");
    const gidC = mkGroup("sf2c");
    const d6 = dispatch("第六单任务：僵尸场景 worker", gidC);
    assertOk(d6.ok === true && !!d6.session_id, "新 worker 建立（w3）");
    const w3 = d6.session_id!;
    ok(await waitFor(() => countOf(gidC, w3) === 1), "前置：w3 首单收口");
    const w3agent = agentOf(w3) as FakeAgent;
    const savedPid = w3agent.childPid;
    w3agent.childPid = 999_999_999; // pid 判死（kill(0) 失败）——僵尸流形态
    const d7 = dispatch("第七单任务：僵尸承接", gidC);
    ok(d7.ok === true && d7.session_id === w3, "僵尸熟手仍承接原班（门在投递咽喉不在派单）");
    ok(agentOf(w3) !== w3agent, "僵尸走 resumeAgent 换流（不经 fast path——直注只服务健康活流）");
    const recZ = recOf(w3);
    ok(recZ.resume !== undefined && (recZ.prompt ?? "").includes("第七单任务"), "resume 锚+prompt 完整（prompt 不落死队列）");
    w3agent.childPid = savedPid;

    console.log(`\n${pass} passed, ${fail} failed`);
    cleanup();
    process.exit(fail > 0 ? 1 : 0);
  } catch (e) {
    console.error("replay 异常:", e);
    cleanup();
    process.exit(2);
  }
}

function assertOk(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); }
}

main();
