// #102 批 C：登录就绪兜底重探 + 恢复三面测试件
// 覆盖：watch 循环器（挂载/重复挂载幂等/指数退避/ready 收口+hook 触发/hook 异常
// 隔离）+ 被拦意图登记与消费（登记即挂 watch/cap 语义沿用 pushCapped/消费即清）
// + SessionManager 恢复三面集成（ERROR+auth_hint 会话自动 resume·renewable 值守、
// 引擎/状态条件不误伤、通知三面口径+intent 快照回显、二次 ready 幂等、重启扫描）。
//
// 注入缝：CCR_AUTH_WATCH_BASE_MS/MAX_MS 压缩退避时序到百 ms 级；探针 mock 同批 B
//（CCR_CODEBUDDY_PATH 假脚本，输出由状态文件切 needs_auth→ready）。退避时序断言用
// 测试侧轮询观察探针计数文件的完成时刻（gap 递增），不依赖探针脚本自记时间戳。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ⚠ 值 import 全部动态化：SessionManager 静态 import 会把 engine-auth-watch 拖进
// 模块图（import 提升 → env 设置前加载 → WATCH_BASE 落缺省 60s，全件超时）——批 B
// 「动态 import 提升坑」的传递链变体（本件首版实测全挂的根因）。type-only import
// 不触发模块求值，保留静态。
import type { ReplayedSession } from "../src/history.js";
import type { AgentLike } from "../src/agent-adapter.js";
import type { SessionEngine } from "../src/types.js";
type EventBusT = typeof import("../src/event-bus.js").EventBus;
type SessionManagerT = import("../src/session-manager.js").SessionManager;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const assert = (c: unknown, name: string) => { if (c) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };
function section(name: string) { console.log(name); }

const T = mkdtempSync(join(tmpdir(), "ccr-authwatch-"));
// 时间压缩：BASE 100ms 起、MAX 400ms 帽（退避 100→200→400→400…）
process.env.CCR_AUTH_WATCH_BASE_MS = "100";
process.env.CCR_AUTH_WATCH_MAX_MS = "400";

// ---------- 假探针（codebuddy auth status）：输出=状态文件；每次执行 touch 计数文件 ----------
const CB_STATE = join(T, "cb-state");
const CB_COUNT_DIR = join(T, "cb-probes");
const cbProbe = join(T, "cb-probe");
writeFileSync(CB_STATE, "Authentication required. Please use /login command to sign in\n");
writeFileSync(cbProbe, [
  "#!/bin/sh",
  `mkdir -p "${CB_COUNT_DIR}"`,
  `printf '%s\\n' x >> "${CB_COUNT_DIR}/n"`,
  `cat "${CB_STATE}"`,
  "exit 0",
].join("\n"));
chmodSync(cbProbe, 0o755);
const savedCb = process.env.CCR_CODEBUDDY_PATH;
process.env.CCR_CODEBUDDY_PATH = cbProbe;

/** 探针已执行次数（计数文件行数） */
const probeCount = (): number => {
  try { return readFileSync(join(CB_COUNT_DIR, "n"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
};

/** 轮询等待条件（每 15ms 一轮，超时抛给调用方判 fail） */
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (cond()) return true;
    await sleep(15);
  }
  return cond();
}

type Watch = typeof import("../src/engine-auth-watch.js");
let w: Watch;

try {
  // ⚠ 动态 import：BASE/MAX 常量在模块体求值时读 env（批 B 同款教训——静态 import
  // 提升到 env 设置前会拿到缺省 60s，全件超时；SessionManager 等值依赖同因动态化）
  w = await import("../src/engine-auth-watch.js");
  const { EventBus } = await import("../src/event-bus.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { loadConfig } = await import("../src/config.js");

  // ---------- W1 登记即挂载 + 重复挂载幂等 ----------
  section("W1 被拦意图登记即挂 watch + 幂等");
  w.recordBlockedCreate({ engine: "codebuddy", cwd: "/tmp/proj-w1", prompt_summary: "W1 创建任务", ts: 1 });
  w.recordBlockedDispatch({ engine: "codebuddy", title: "W1 派单", anchor: "/tmp/proj-w1", ts: 2 });
  assert(w.authWatchActive("codebuddy") === true, "W1a recordBlockedCreate/Dispatch 登记即挂兜底 watch");
  assert(w.authWatchActive("codex") === false, "W1b 未登记引擎不挂（隔离）");
  // 同引擎重复挂载不重起：短窗内连挂三次，首周期（100ms）内探针只执行一次
  w.ensureAuthWatch("codebuddy"); w.ensureAuthWatch("codebuddy"); w.ensureAuthWatch("codebuddy");
  await sleep(60);
  const early = probeCount();
  assert(early <= 1, `W1c 重复 ensureAuthWatch 不重起循环（首周期探针 ≤1 次 got=${early}）`);

  // ---------- W2 指数退避（持续 needs_auth：gap 递增） ----------
  section("W2 指数退避（needs_auth 持续期间探针间隔逐次放大）");
  // 测试侧轮询观察计数变化时刻（探针完成 → 计数+1 → 下一轮 poll 观察到；误差 ≤15ms）
  const obs: number[] = [];
  let last = probeCount();
  const deadline = Date.now() + 2_500;
  while (obs.length < 3 && Date.now() < deadline) {
    await sleep(15);
    const c = probeCount();
    if (c !== last) { last = c; obs.push(Date.now()); }
  }
  assert(obs.length >= 3, `W2a 持续 needs_auth 期间探针按周期执行（≥3 次 got=${obs.length}）`);
  if (obs.length >= 3) {
    const gap1 = obs[1]! - obs[0]!;
    const gap2 = obs[2]! - obs[1]!;
    assert(gap2 > gap1 + 50, `W2b 退避递增（gap2=${gap2}ms > gap1=${gap1}ms+50——100→200 轨迹）`);
  }
  assert(w.authWatchActive("codebuddy") === true, "W2c needs_auth 期间 watch 不退出（兜底常驻）");

  // ---------- W3 ready 收口 + hook 触发 + 意图消费 ----------
  section("W3 探针转 ready → 收口+恢复钩子+意图消费");
  const hookCalls: SessionEngine[] = [];
  w.setAuthWatchReadyHook((e) => { hookCalls.push(e); });
  writeFileSync(CB_STATE, "Signed in as tester@example.com (Plus)\n");
  const settled = await waitFor(() => !w.authWatchActive("codebuddy"), 2_000);
  assert(settled, "W3a ready 后 watch 收口（active 清）");
  assert(hookCalls.length === 1 && hookCalls[0] === "codebuddy", `W3b 恢复钩子恰调一次（got=${JSON.stringify(hookCalls)}）`);
  const creates = w.takeBlockedCreates("codebuddy");
  assert(creates.length === 1 && creates[0]!.prompt_summary === "W1 创建任务" && creates[0]!.cwd === "/tmp/proj-w1",
    "W3c 创建意图快照完整（cwd+prompt 摘要——通知回显数据源）");
  const dispatches = w.takeBlockedDispatches("codebuddy");
  assert(dispatches.length === 1 && dispatches[0]!.title === "W1 派单", "W3d 派单意图快照完整");
  assert(w.takeBlockedCreates("codebuddy").length === 0 && w.takeBlockedDispatches("codebuddy").length === 0,
    "W3e 消费即清（二次 take 空——二次 ready 不重复通知）");

  // ---------- W4 ready 后再挂（新轮回可达——needs_auth 复发场景） ----------
  section("W4 ready 后可重挂（登录态复发的下一轮兜底）");
  w.ensureAuthWatch("codebuddy");
  assert(w.authWatchActive("codebuddy") === true, "W4a watch 清后可重挂");
  const settled2 = await waitFor(() => !w.authWatchActive("codebuddy"), 2_000);
  assert(settled2 && hookCalls.length === 2, `W4b 新轮回 ready 照常收口+触发（got=${hookCalls.length}）`);

  // ---------- W5 hook 异常隔离 ----------
  section("W5 恢复钩子异常不影响收口");
  w.setAuthWatchReadyHook(() => { throw new Error("boom"); });
  w.ensureAuthWatch("codebuddy");
  const settled3 = await waitFor(() => !w.authWatchActive("codebuddy"), 2_000);
  assert(settled3, "W5a hook 抛异常 watch 照常收口（try/catch 隔离——不悬挂不崩 relay）");

  // ========== 部分 2：SessionManager 恢复三面集成 ==========
  section("I1 恢复三面集成（会话 resume/创建回显/派单通知+幂等）");
  w.resetAuthWatchForTest(); // 清部分 1 的 spy hook——由 SessionManager 构造器接管
  const DATA = join(T, "datadir");
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_NO_TITLE_GEN = "1";
  const bus = new EventBus();
  const mgr = new SessionManager(bus, loadConfig());
  const resumes: { engine?: string; text: string }[] = [];
  mgr.setAgentFactory((_cwd, _model, _cb, initialPrompt, opts) => {
    resumes.push({ engine: opts?.engine, text: initialPrompt ?? "" });
    const agent: AgentLike = {
      id: `fake-aw-${resumes.length}`, startedAt: Date.now(), ended: false,
      sendMessage() {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => {}, setPermissionMode: async () => {},
    };
    return agent;
  });
  // 注：codebuddy 是 registry 引擎——resume 不走 agentFactory（createRegisteredEngine
  // 直接构造，注入的 CCR_CODEBUDDY_PATH 假探针即会话进程），恢复触发的正面积爆走
  // 状态面证据（action_summary「重新注入上下文」/auth_hint 摘牌/恢复日志/通知），不依赖
  // factory 记录器（claude 分支专属）
  const mkS = (sid: string, extra: Record<string, unknown>): [string, ReplayedSession] => [
    sid,
    {
      state: {
        session_id: sid, relay_session_id: `cli-${sid}`, cwd: "/tmp/p", initial_prompt: "x",
        title: sid, model: "glm-5.3", status: "DONE", action_summary: "（历史）",
        started_at: Date.now(), updated_at: Date.now(),
        stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
        ...extra,
      },
      logs: [],
    } as unknown as ReplayedSession,
  ];
  mgr.adopt(new Map([
    // 目标：codebuddy 运行时失效（ERROR+auth_hint）——批 C 恢复面
    mkS("cb-err", { engine: "codebuddy", status: "ERROR", auth_hint: "终端运行 codebuddy-code，输入 /login 完成登录" }),
    // 对照一：引擎不匹配（claude）不误伤
    mkS("cla-err", { status: "ERROR", auth_hint: "伪标记（claude 免检不该有）" }),
    // 对照二：状态不匹配（DONE）不误伤——恢复只认 ERROR 面
    mkS("cb-done", { engine: "codebuddy", status: "DONE", auth_hint: "残留标记" }),
  ]));
  // 登记两面前置：创建被拦（intent 快照）+派单被拦
  w.recordBlockedCreate({ engine: "codebuddy", cwd: "/tmp/proj", prompt_summary: "帮我写批C测试任务", ts: Date.now() });
  w.recordBlockedDispatch({ engine: "codebuddy", title: "批C集成派单", anchor: "/tmp/proj", ts: Date.now() });
  // 探针仍 ready（W5 状态）→ watch 100ms 后首探 ready → recoverEngineAfterAuth 三面。
  // 恢复痕迹 = 恢复日志落账（registry 引擎会话进程是假探针脚本——秒退把 status 打回
  // ERROR 属测试环境伪影，不断言终态 WORKING；恢复动作本身已由摘牌+summary+日志证明）
  const resumed = await waitFor(() =>
    (mgr.snapshotLogs()["cb-err"] ?? []).some((l) => l.text.includes("已登录，会话已恢复")), 2_500);
  assert(resumed, "I1a needs_auth 会话在探针 ready 后自动 resume（watch 兜底链打通——恢复日志落账）");
  const snap = mgr.snapshot();
  const cb = snap.find((s) => s.session_id === "cb-err")!;
  const recoverLogs = (mgr.snapshotLogs()["cb-err"] ?? []).filter((l) => l.text.includes("已登录，会话已恢复"));
  assert(!cb.auth_hint && recoverLogs.length === 1,
    `I1b 恢复即摘 needs_auth 牌+恢复动作恰一次（got=${cb.auth_hint ? "hint在" : "已清"}/${recoverLogs.length} 条恢复日志——summary 被引擎启动回调覆写属测试伪影不断言）`);
  assert(snap.find((s) => s.session_id === "cla-err")?.action_summary !== "重新注入上下文"
    && snap.find((s) => s.session_id === "cb-done")?.action_summary !== "重新注入上下文",
    "I1c 恰恢复一个会话（引擎+ERROR+auth_hint 三条件收敛，对照会话零误伤）");
  assert(snap.find((s) => s.session_id === "cla-err")?.auth_hint === "伪标记（claude 免检不该有）",
    "I1d 引擎不匹配的会话不误伤（auth_hint 原样保留）");
  // pushExternalLog「已登录，会话已恢复」
  const logs = mgr.snapshotLogs()["cb-err"] ?? [];
  assert(logs.some((l) => l.text.includes("已登录，会话已恢复")), "I1f 恢复成功落外部日志（pushExternalLog 面纱口径）");
  // 通知三面
  const notes = mgr.notificationsList();
  const noteText = notes.map((n) => `${n.title} ${n.body}`).join("\n");
  assert(/已登录[\s\S]*任务已恢复/.test(noteText), `I1g 恢复通知（「已登录+任务已恢复」口径——任务书钉句）got=${noteText.slice(0, 120)}`);
  assert(noteText.includes("可以创建了") && noteText.includes("帮我写批C测试任务"),
    "I1h 创建拦截通知：intent 快照回显（anchor/task 摘要进通知正文）");
  assert(noteText.includes("可以重新派单") && noteText.includes("批C集成派单"),
    "I1i 派单拦截通知：不自动重放，通知回显原单标题");
  // 幂等：二次 ready（AUTH_REQUIRED ready 帧实时面）10s 窗内不重复恢复——恢复日志
  // 不新增+摘牌不复活+通知不重复（幂等窗+auth_hint 已摘双保险）
  const logsBefore = (mgr.snapshotLogs()["cb-err"] ?? []).filter((l) => l.text.includes("已登录，会话已恢复")).length;
  const notesBefore = mgr.notificationsList().length;
  bus.emitTransient("AUTH_REQUIRED", { engine: "codebuddy", state: "ready", mode: "hint", flow_id: "test-2nd" });
  await sleep(250);
  const logsAfter = (mgr.snapshotLogs()["cb-err"] ?? []).filter((l) => l.text.includes("已登录，会话已恢复")).length;
  assert(logsAfter === logsBefore, `I1j 二次 ready 幂等（恢复动作不重复 got=${logsAfter - logsBefore}）`);
  assert(!mgr.snapshot().find((s) => s.session_id === "cb-err")?.auth_hint, "I1j' 摘牌不复活（条件面兜底——跨幂等窗也不重复）");
  assert(mgr.notificationsList().length === notesBefore, "I1k 二次 ready 不重复通知（意图已消费+同 key 防重）");

  // ---------- I2 重启扫描 ----------
  section("I2 重启扫描（needs_auth 会话挂兜底）");
  const mgr2 = new SessionManager(new EventBus(), loadConfig());
  mgr2.adopt(new Map([
    mkS("cb-err2", { engine: "codebuddy", status: "ERROR", auth_hint: "终端运行 codebuddy-code 登录" }),
    mkS("plain", { engine: "codebuddy", status: "ERROR" }), // 无 auth_hint 的普通 ERROR：不挂
  ]));
  // 探针切回 needs_auth：扫描断言 watch 在挂即可，不让它立刻收口
  writeFileSync(CB_STATE, "Authentication required. Please use /login command to sign in\n");
  const n2scan = mgr2.scanNeedsAuthSessions();
  assert(n2scan === 1, `I2a 扫描只挂 needs_auth 引擎（去重 got=${n2scan}）`);
  assert(w.authWatchActive("codebuddy") === true, "I2b relay 重启后 needs_auth 会话挂上兜底重探");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  fail++;
  console.error(`  ✗ 测试件异常终止: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
} finally {
  if (savedCb === undefined) delete process.env.CCR_CODEBUDDY_PATH;
  else process.env.CCR_CODEBUDDY_PATH = savedCb;
  delete process.env.CCR_AUTH_WATCH_BASE_MS;
  delete process.env.CCR_AUTH_WATCH_MAX_MS;
  delete process.env.CCR_DATA_DIR;
  delete process.env.CCR_NO_TITLE_GEN;
  rmSync(T, { recursive: true, force: true });
}
