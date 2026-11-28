// DL-P1-1 恢复死循环降级治根专项（2026-11-27 夜间缺陷台账）：「首回合未完成即中断」
// 形态（无 assistant 帧/零 output/transcript 无记忆）的**无消息自动恢复路径**
//（reviveSaved——PM 值守保活/重启温床拉起）连败 ≥2 次 → 不再进冷却循环，自动降级
// 新会话承接（同卡换新 SDK 流：fresh spawn 无 resume 参数、onInit 回写
// relay_session_id、熔断复位、冷却期积压补投）。有记忆形态不降级（静默抹上下文
// 风险——维持 ERROR+saved 原路径）。
//
// 生产实证（events.ndjson 0f6906c5=PM 值守席）：11-21 17:14 → 11-24 19:17 SESSION_ERROR
// 「恢复失败: 初始化超时」×9 + 「恢复已连续失败…冷却」×22 + 「已熔断…跳过并入队」×8
// ——指路文案「给会话发一条消息可自动回退新会话续命」对无消息自动路径永不可达：
// 消息路径（resumeAgent）自带 fresh 回退，reviveSaved 没有，本件补齐。
//
// 直调 reviveSaved（PM 席位保活同入口——席位编排另测 test-leader）。时长 env 缩短
//（init 看门狗 150ms），断言用行为（spawn 序列 resume 参数）+状态快照+熔断测试缝。
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { AgentLike } from "../src/agent-adapter.js";

const ROOT = fileURLToPath(new URL("../data/test-resume-degrade/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "proj-a"), { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_RESUME_INIT_MS = "150"; // init 看门狗 150ms（合法下限 100）
process.env.CCR_RESUME_BREAKER_BASE_MS = "1000"; // 冷却 base 1s（合法下限 1s）

let pass = 0, fail = 0;
const assert = (c: unknown, name: string) => { if (c) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 受控行为假工厂：hang=永不 onInit（等看门狗判死）；init=5ms 后 onInit。
// spawns 记每次 spawn 的 resume 参数与首条 prompt（降级 fresh=两者皆无）。
function makeManager() {
  const mgr = new SessionManager(new EventBus(), loadConfig());
  const spawns: Array<{ resume?: string; ip?: unknown }> = [];
  const sends: string[] = [];
  const behaviors: ("hang" | "init")[] = [];
  mgr.setAgentFactory((_cwd, _model, cb, initialPrompt, opts) => {
    spawns.push({ resume: opts?.resume, ip: typeof initialPrompt === "string" ? initialPrompt.slice(0, 24) : initialPrompt });
    const behavior = behaviors.shift() ?? "hang";
    const agent: AgentLike = {
      id: `fake-${spawns.length}`, startedAt: Date.now(), ended: false,
      sendMessage: (text) => { sends.push(text); },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { agent.ended = true; },
      setPermissionMode: async () => {},
    };
    if (behavior === "init") setTimeout(() => cb.onInit(`sdk-deg-${spawns.length}`, "glm-5.3", "bypassPermissions"), 5);
    return agent;
  });
  return { mgr, spawns, sends, behaviors };
}

// 无记忆形态（DL-P1-1 判据三条件全空）：logs 空 + output_tokens=0 + 无 transcript 文件
type Internal = { sessions: Map<string, any>; reviveSaved(s: any): void };
function makeSession(mgr: SessionManager, sid: string, cliSid: string, extra: Record<string, unknown> = {}): void {
  const internal = mgr as unknown as Internal;
  internal.sessions.set(sid, {
    state: {
      session_id: sid, relay_session_id: cliSid, cwd: join(ROOT, "proj-a"), initial_prompt: "x",
      title: sid, model: "glm-5.3", status: "DONE", action_summary: "（历史）",
      started_at: Date.now(), updated_at: Date.now(),
      stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...extra,
    },
    logs: [],
    unacked: [],
    streamGen: 0, wd: { phase: "idle" },
  } as never);
}
const revive = (mgr: SessionManager, sid: string): void =>
  ((mgr as unknown as Internal).reviveSaved)((mgr as unknown as Internal).sessions.get(sid));
const st = (mgr: SessionManager, sid: string) => mgr.snapshot().find((s) => s.session_id === sid)!;
const waitCond = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (cond()) return true; await sleep(30); }
  return cond();
};

// ---------- 场景 A：无记忆形态 hang×1 → 常规失败（首败不降级） ----------
{
  const { mgr, spawns, behaviors } = makeManager();
  behaviors.push("hang");
  makeSession(mgr, "deg1", "deg-a1");
  revive(mgr, "deg1");
  await sleep(300); // 等 150ms 看门狗判死
  const s1 = st(mgr, "deg1");
  assert(spawns.length === 1 && spawns[0]?.resume === "deg-a1", "A1 首败正常 resume 尝试（带 resume 参数）");
  assert(s1.status === "ERROR" && (s1.last_error ?? "").includes("恢复失败"), "A1 首败走原路径（ERROR+可重试，不降级）");
  assert((s1.last_error ?? "").includes("首次回合未完成"), "A1b 指路文案在（消息自愈通道提示）");
  assert(mgr.resumeBreakerForTests("deg1")?.streak === 1, "A1c 首败进熔断记账 streak=1");
}

// ---------- 场景 B：连败 2 次触发降级——fresh 承接+锚收敛+熔断复位+积压补投 ----------
{
  const { mgr, spawns, sends, behaviors } = makeManager();
  behaviors.push("hang", "hang", "init");
  makeSession(mgr, "deg2", "deg-b1");
  // 预置冷却期积压（suppressAutoResume 入队形态——unacked 无 hold/renewable）
  ((mgr as unknown as Internal).sessions.get("deg2")!).unacked.push({ id: "q1", text: "[交付直达] 积压的派单回执", ts: Date.now() });
  revive(mgr, "deg2");            // 第 1 败：hang → ERROR streak=1
  await sleep(300);
  assert(st(mgr, "deg2").status === "ERROR", "B1 第一败 ERROR（原路径）");
  revive(mgr, "deg2");            // 第 2 败：hang → 判定降级 → 同步 fresh spawn（behavior=init）
  await waitCond(() => st(mgr, "deg2").status === "DONE");
  const s2 = st(mgr, "deg2");
  assert(spawns.length === 3, `B2 降级链三段 spawn（resume 挂死×2 + fresh×1，实测 ${spawns.length}）`);
  assert(spawns[1]?.resume === "deg-b1" && spawns[2]?.resume === undefined && spawns[2]?.ip === undefined, "B3 第 2 败先试原 resume，降级 fresh 无 resume 无 prompt（同卡换新流）");
  assert(s2.relay_session_id === "sdk-deg-3", `B4 新 SDK 锚回写（relay_session_id=${s2.relay_session_id}——onInit 无条件覆盖旧悬空 id）`);
  assert((s2.action_summary ?? "").includes("降级"), `B4b 卡面明示降级承接（${s2.action_summary}）`);
  const b5 = mgr.resumeBreakerForTests("deg2");
  assert(b5?.streak === 0 && b5?.cooldownUntil === 0, "B5 fresh init 成功熔断复位（streak/cooldown 清零——死循环断根）");
  assert(sends.some((t) => t.includes("积压的派单回执")), "B6 冷却期积压随降级补投（flushResumeBacklog）");
  // PM 保活调用侧同款活流守卫（schedulePMKeepalive：s.agent && !s.agent.ended 不拉）
  const alive = ((mgr as unknown as Internal).sessions.get("deg2")!).agent;
  if (!(alive && !alive.ended)) revive(mgr, "deg2");
  assert(spawns.length === 3, "B7 降级后 agent 在场（调用侧活流守卫）不再重复拉起");
}

// ---------- 场景 C：有记忆形态（usage output>0）连败不降级——抹上下文风险不引入 ----------
{
  const { mgr, spawns, behaviors } = makeManager();
  behaviors.push("hang", "hang");
  makeSession(mgr, "deg3", "deg-a1", {
    usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  revive(mgr, "deg3");
  await sleep(300);
  revive(mgr, "deg3");
  await sleep(300);
  const s3 = st(mgr, "deg3");
  assert(spawns.length === 2 && spawns.every((r) => r?.resume === "deg-a1"), "C1 有记忆形态两败全走原 resume 路径（无 fresh spawn）");
  assert(s3.status === "ERROR", "C2 有记忆形态维持 ERROR+saved 可重试（不静默抹上下文）");
  assert((mgr.resumeBreakerForTests("deg3")?.streak ?? 0) >= 2, "C3 熔断记账照常（冷却循环原语义保留）");
}

// ---------- 场景 D：降级 fresh 也挂死 → 回落 ERROR+熔断记账（降级不是无限重试许可证） ----------
{
  const { mgr, spawns, behaviors } = makeManager();
  behaviors.push("hang", "hang", "hang");
  makeSession(mgr, "deg4", "deg-b1");
  revive(mgr, "deg4");
  await sleep(300);
  revive(mgr, "deg4");
  await sleep(400); // 第二败触发降级 fresh（hang）→ fresh 看门狗 150ms 判死
  const s4 = st(mgr, "deg4");
  assert(spawns.length === 3 && spawns[2]?.resume === undefined, "D1 双段皆挂：fresh 也 spawn 了（第 3 次）");
  assert(s4.status === "ERROR" && (s4.last_error ?? "").includes("降级"), `D2 fresh 挂死回落 ERROR（${s4.last_error ?? ""}）`);
  assert((mgr.resumeBreakerForTests("deg4")?.cooldownUntil ?? 0) > Date.now(), "D3 降级失败进熔断冷却（退避兜底有界）");
}

rmSync(ROOT, { recursive: true, force: true });

console.log(`\n== test-resume-degrade 汇总：${pass} ok / ${fail} FAIL ==`);
if (fail > 0) process.exit(1);
