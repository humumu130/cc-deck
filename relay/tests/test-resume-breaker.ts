// W-LEADFIX resume 熔断专项（纯单元）：同一会话连续 resume 失败 ≥2 次进入冷却，
// 冷却期内自动恢复路径（auto-revive）不再拉起、到期自动解除且退避翻倍；onInit 成功
// 才复位连败计数；reviveSaved 的 init 看门狗超时同权连击；用户点卡/发消息（手动意图）
// 不受闸；pin 停放休眠（pinned+saved）不被 auto-revive 自动拉起（#49「开机不自动
// resume」语义回归锁）；init 看门狗按 transcript 体量自适应放大。
//
// 连败触发走两条路：① spawn 同步失败（factory 抛错——无 agent 残留，auto-revive
// 探针非空转）② init 看门狗超时（假 agent 挂死 + CCR_RESUME_INIT_MS=150）。
// 时长全部 env 缩短（base=1000ms），断言用行为（spawn 计数）+ resumeBreakerForTests
// 状态缝（setWatchdogProcs 同款测试缝先例），不掏私有字段。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { ReplayedSession } from "../src/history.js";
import type { AgentLike } from "../src/agent-adapter.js";
import type { Command } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../data/test-resume-breaker/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "proj-a"), { recursive: true });
mkdirSync(join(ROOT, "proj-b"), { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_RESUME_INIT_MS = "150"; // init 看门狗 150ms（合法下限 100）
process.env.CCR_RESUME_BREAKER_BASE_MS = "1000"; // 冷却 base 1s（合法下限 1s）

let pass = 0, fail = 0;
const assert = (c: unknown, name: string) => { if (c) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 任务存储夹具（真实 ~/.claude/tasks/<sid>/，测试专用假 sid，用完即删）
const TASKS = join(homedir(), ".claude", "tasks");
function putTodo(cliSid: string): void {
  const d = join(TASKS, cliSid);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "1.json"), JSON.stringify({ id: 1, subject: "在干活", status: "in_progress" }));
}
const TODO_SIDS = ["leadfix-a1", "leadfix-b1", "leadfix-d1"];
for (const s of TODO_SIDS) putTodo(s);

// 大 transcript 夹具（真实 ~/.claude/projects/<slug>/，用完即删）：25MB → 2 个 10MB
// 档 → init 看门狗 3×base=450ms（对照无 transcript 的 150ms，断言余量 3 倍）
const PROJECTS = join(homedir(), ".claude", "projects");
const BIG_SID = "leadfix-big-transcript-cli";
const slugA = join(ROOT, "proj-a").replace(/[^a-zA-Z0-9]/g, "-");
mkdirSync(join(PROJECTS, slugA), { recursive: true });
writeFileSync(join(PROJECTS, slugA, `${BIG_SID}.jsonl`), Buffer.alloc(25 * 1024 * 1024, 64));

// 受控行为的假 agent 工厂：throw = 构造即抛（spawn 失败）；hang = 永不 onInit（等
// 看门狗判死）；init = 5ms 后 onInit（恢复成功）。stop() 置 ended（对齐真实流：看门
// 狗 stop 后流关闭，COMMAND_MESSAGE 才走 resume 分支）。attempts 记 factory 调用数
//（含 throw——resumeAgent 真被调到才算数，压制断言看它不涨）
function makeManager() {
  const mgr = new SessionManager(new EventBus(), loadConfig());
  const attempts: number[] = [];
  const spawns: { resume?: string }[] = [];
  const sends: string[] = [];
  const behaviors: ("throw" | "hang" | "init")[] = [];
  mgr.setAgentFactory((_cwd, _model, cb, _initialPrompt, opts) => {
    attempts.push(attempts.length + 1);
    const behavior = behaviors.shift() ?? "throw";
    if (behavior === "throw") throw new Error("模拟 spawn 失败");
    spawns.push({ resume: opts?.resume });
    const agent: AgentLike = {
      id: `fake-${attempts.length}`, startedAt: Date.now(), ended: false,
      sendMessage: (text) => { sends.push(text); },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { agent.ended = true; },
      setPermissionMode: async () => {},
    };
    if (behavior === "init") setTimeout(() => cb.onInit(`sdk-${attempts.length}`, "glm-5.3", "bypassPermissions"), 5);
    return agent;
  });
  return { mgr, attempts, spawns, sends, behaviors };
}

const mk = (sid: string, cliSid: string, extra: Record<string, unknown> = {}): [string, ReplayedSession] => [
  sid,
  {
    state: {
      session_id: sid, relay_session_id: cliSid, cwd: join(ROOT, "proj-a"), initial_prompt: "x",
      title: sid, model: "glm-5.3", status: "DONE", action_summary: "（历史）",
      started_at: Date.now(), updated_at: Date.now(),
      stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
      usage: { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...extra,
    },
    logs: [],
  } as unknown as ReplayedSession,
];

const st = (mgr: SessionManager, sid: string) => mgr.snapshot().find((s) => s.session_id === sid)!;
const waitCond = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (cond()) return true; await sleep(30); }
  return cond();
};

// ---------- 场景 A：连败熔断 → 冷却压制 auto-revive → 到期解封 → 退避翻倍 ----------
{
  const { mgr, attempts } = makeManager();
  mgr.adopt(new Map([mk("m1", "leadfix-a1")]));
  mgr.autoReviveManaged();
  assert(attempts.length === 1, "A1 首次 auto-revive 正常发起（spawn 失败记账 streak=1）");
  assert(mgr.resumeBreakerForTests("m1")?.streak === 1, "A1 spawn 失败进熔断记账（streak=1）");
  mgr.autoReviveManaged();
  const b2 = mgr.resumeBreakerForTests("m1")!;
  assert(attempts.length === 2 && b2.streak === 2 && b2.cooldownUntil > Date.now(), "A2 连败 2 次 → 冷却就位");
  const cool1 = b2.cooldownUntil - Date.now();
  assert(cool1 > 800 && cool1 <= 1000, `A2 冷却窗 ≈ base 1s（实测 ${cool1}ms）`);
  assert(mgr.autoReviveManaged() === 0 && attempts.length === 2, "A3 冷却期内 auto-revive 被压制（零发起，死循环断根）");
  await sleep(1100); // 等冷却过期
  mgr.autoReviveManaged();
  assert(attempts.length === 3, "A4 冷却到期自动解封");
  const b3 = mgr.resumeBreakerForTests("m1")!;
  assert(b3.streak === 3 && b3.cooldownUntil > Date.now(), "A4 第 3 败 → 退避窗就位");
  const cool2 = b3.cooldownUntil - Date.now();
  assert(cool2 > 1600 && cool2 <= 2000, `A5 退避翻倍：第 3 败冷却 ≈ 2×base（实测 ${cool2}ms）`);
  mgr.autoReviveManaged();
  assert(attempts.length === 3, "A5 退避期内再拉仍被压制");
}

// ---------- 场景 B：onInit 成功才复位（手动重试不清，成功才清） ----------
{
  const { mgr, attempts, behaviors } = makeManager();
  mgr.adopt(new Map([mk("m1", "leadfix-b1")]));
  mgr.autoReviveManaged();
  mgr.autoReviveManaged();
  assert(mgr.resumeBreakerForTests("m1")?.streak === 2, "B1 连败 2 次就位");
  await sleep(1100); // 等冷却过期（复位验证要在可拉起状态下做）
  // 恢复成功：onInit 到达 → 复位（注意 spawn 同步置 WORKING，复位要看 onInit 后的
  // streak 归零，不能拿 WORKING 当 init 证据）
  behaviors.push("init");
  mgr.autoReviveManaged();
  assert(await waitCond(() => mgr.resumeBreakerForTests("m1")?.streak === 0), "B2 onInit 成功复位熔断（streak 归零）");
  assert(st(mgr, "m1").status === "WORKING", "B2 恢复真活了一次（WORKING）");
  assert(mgr.resumeBreakerForTests("m1")?.cooldownUntil === 0, "B2 cooldown 同步双清");
}

// ---------- 场景 C：reviveSaved 看门狗超时同权连击；点卡/发消息（手动）不受闸 ----------
{
  const { mgr, attempts, behaviors } = makeManager();
  behaviors.push("hang", "hang", "init", "hang", "hang", "init");
  mgr.adopt(new Map([mk("m2", "leadfix-c2", { saved: true })]));
  const resume = () => mgr.handleCommand({ command_id: `c-${attempts.length}`, type: "COMMAND_RESUME_SESSION", payload: { session_id: "m2" }, ts: Date.now() } as unknown as Command, "user");
  assert(resume().ok === true && attempts.length === 1, "C1 点卡恢复拉起（第 1 次）");
  assert(
    await waitCond(() => st(mgr, "m2").status === "ERROR" && (st(mgr, "m2").last_error ?? "").includes("初始化超时（1s）")),
    "C1 reviveSaved init 看门狗判死（动态秒数文案，150ms 显示不出现 0 秒）",
  );
  assert(mgr.resumeBreakerForTests("m2")?.streak === 1, "C1 看门狗超时进熔断记账");
  resume();
  assert(await waitCond(() => attempts.length === 2 && st(mgr, "m2").status === "ERROR"), "C2 第 2 次超时 → 连败 2 次进冷却");
  assert((mgr.resumeBreakerForTests("m2")?.cooldownUntil ?? 0) > Date.now(), "C2 冷却就位");
  // 手动路径不受闸 ①：点卡照常拉起（init 成功 → 复位 + 落待命态）
  assert(resume().ok === true && attempts.length === 3, "C3 冷却期点卡（手动意图）照常拉起");
  assert(
    await waitCond(() => st(mgr, "m2").status === "DONE" && st(mgr, "m2").done_reason === "已恢复（等待输入）"),
    "C3 恢复成功落待命态（onInit 复位熔断）",
  );
  assert(mgr.resumeBreakerForTests("m2")?.streak === 0, "C3 onInit 复位（跨路径复核）");
  // 造冷却态：先 STOP 收掉活 agent（否则点卡走幂等分支不 spawn），再两次点卡失败
  assert(mgr.handleCommand({ command_id: "c-stop", type: "COMMAND_STOP", payload: { session_id: "m2" }, ts: Date.now() } as unknown as Command, "user").ok === true, "C4 STOP 活 agent ok");
  await sleep(100); // 假 agent stop 异步置 ended
  resume();
  await waitCond(() => st(mgr, "m2").status === "ERROR");
  resume();
  await waitCond(() => st(mgr, "m2").status === "ERROR");
  assert((mgr.resumeBreakerForTests("m2")?.cooldownUntil ?? 0) > Date.now() && attempts.length === 5, "C4 冷却态就位（第 2 次连败）");
  // 手动路径不受闸 ②：发消息照常拉起
  const ack = mgr.handleCommand({ command_id: "c-msg", type: "COMMAND_MESSAGE", payload: { session_id: "m2", text: "手动消息试试" }, ts: Date.now() } as unknown as Command, "user");
  assert(ack.ok === true && attempts.length === 6, "C5 冷却期用户发消息（手动意图）越过熔断照常拉起");
}

// ---------- 场景 D：pin 停放休眠不被 auto-revive 拉起（#49 语义回归锁） ----------
{
  const { mgr, attempts, behaviors } = makeManager();
  behaviors.push("init");
  mgr.adopt(new Map([mk("m3", "leadfix-d1", { pinned: true, saved: true })]));
  assert(mgr.autoReviveManaged() === 0 && attempts.length === 0, "D1 置顶停放休眠不自动拉起（applyPinned 语义）");
  const unpin = mgr.handleCommand({ command_id: "d-unpin", type: "COMMAND_PIN_SESSION", payload: { session_id: "m3", pinned: false }, ts: Date.now() } as unknown as Command, "user");
  assert(unpin.ok === true, "D2 unpin ack ok");
  assert(mgr.autoReviveManaged() === 1 && attempts.length === 1, "D2 解除置顶后照常自动拉起（豁免只针对 pin 停放形态）");
}

// ---------- 场景 E：init 看门狗按 transcript 体量自适应放大 ----------
{
  const { mgr, attempts, behaviors } = makeManager();
  behaviors.push("hang", "hang");
  putTodo(BIG_SID); // 无 todos 不进 auto-revive 候选（用完随 TODO_SIDS 外单独清理）
  putTodo("leadfix-small-transcript-cli");
  const small = mk("m-small", "leadfix-small-transcript-cli");
  small[1].state.cwd = join(ROOT, "proj-b"); // 无 transcript：base 150ms
  mgr.adopt(new Map([mk("m-big", BIG_SID), small]));
  const t0 = Date.now();
  mgr.autoReviveManaged(); // 两个候选一次拉起（updated_at 同刻，插入序稳定）
  let bigErrAt = 0, smallErrAt = 0;
  const both = await waitCond(() => {
    if (!smallErrAt && st(mgr, "m-small").status === "ERROR") smallErrAt = Date.now() - t0;
    if (!bigErrAt && st(mgr, "m-big").status === "ERROR") bigErrAt = Date.now() - t0;
    return !!bigErrAt && !!smallErrAt;
  });
  assert(both && bigErrAt >= 380 && bigErrAt < 2000, `E1 大 transcript（25MB）看门狗放大到 3×≈450ms（实测 ${bigErrAt}ms）`);
  assert(both && smallErrAt < 380, `E2 无 transcript 会话仍走 base 150ms（实测 ${smallErrAt}ms，不误伤小会话）`);
  assert(both && smallErrAt <= bigErrAt, "E3 小会话先判死（放大只作用于大体量）");
  assert(attempts.length === 2, "E 两个候选都被拉起（对照有效）");
}

// ---------- 场景 F：恢复成功补投积压（熔断/休眠期入队不丢消息的闭环） ----------
// 链路：假 agent 永不回显 user_message → unacked 持续留账（= 生产熔断期入队形态）。
// ① 消息驱动二次 resume：resumeAgent onInit 补投旧账；② STOP 收流后点卡恢复：
// reviveSaved onInit 补投 + 卡片落「处理排队消息」而非「等待输入」
{
  const { mgr, sends, behaviors } = makeManager();
  behaviors.push("init", "init", "init");
  mgr.adopt(new Map([mk("m4", "leadfix-f1")]));
  const send = (text: string) => mgr.handleCommand({ command_id: `f-${text}`, type: "COMMAND_MESSAGE", payload: { session_id: "m4", text }, ts: Date.now() } as unknown as Command, "user");
  assert(send("活儿一号").ok === true, "F1 消息驱动拉起");
  assert(await waitCond(() => mgr.resumeBreakerForTests("m4")?.streak === 0 && st(mgr, "m4").status === "WORKING"), "F1 init 成功");
  assert(mgr.handleCommand({ command_id: "f-stop", type: "COMMAND_STOP", payload: { session_id: "m4" }, ts: Date.now() } as unknown as Command, "user").ok === true, "F2 STOP 收流（「活儿一号」悬账 unacked）");
  await sleep(100);
  assert(send("活儿二号").ok === true, "F3 死流后再发消息（二次 resume）");
  assert(
    await waitCond(() => sends.includes("活儿一号")),
    `F3 二次 resume 的 onInit 补投旧账「活儿一号」（sends=${JSON.stringify(sends)}）`,
  );
  assert(mgr.handleCommand({ command_id: "f-stop2", type: "COMMAND_STOP", payload: { session_id: "m4" }, ts: Date.now() } as unknown as Command, "user").ok === true, "F4 再收流（「活儿二号」悬账）");
  await sleep(100);
  assert(mgr.handleCommand({ command_id: "f-resume", type: "COMMAND_RESUME_SESSION", payload: { session_id: "m4" }, ts: Date.now() } as unknown as Command, "user").ok === true, "F4 点卡恢复（reviveSaved，无首条消息的 parked 恢复）");
  assert(
    await waitCond(() => sends.some((t) => t.includes("活儿二号"))),
    `F4 reviveSaved onInit 补投「活儿二号」（sends=${JSON.stringify(sends)}）`,
  );
  assert(
    st(mgr, "m4").action_summary === "已恢复，处理排队消息",
    "F4 有积压时卡片显示「处理排队消息」而非「等待输入」",
  );
}

// ---------- 清理 ----------
for (const s of [...TODO_SIDS, BIG_SID, "leadfix-small-transcript-cli"]) rmSync(join(TASKS, s), { recursive: true, force: true });
rmSync(join(PROJECTS, slugA), { recursive: true, force: true });
rmSync(ROOT, { recursive: true, force: true });
console.log(`\nRESUME-BREAKER TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
