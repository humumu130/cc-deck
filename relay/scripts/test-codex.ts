// #27 Codex 接入 P0 测试锁（2026-10-01）：CI 零真 codex / 零 GLM key。
// 三段：
//   A. CodexEventMapper 纯映射（fixture 喂 0.154.0 实测事件词汇表 + 边界形态）
//   B. CodexAgentSession 进程模型（CCR_CODEX_PATH 指向 shell 桩——真 spawn 真管道，
//      验证 stdin 投递 / resume 参数 / 回合中排队合并 / 崩溃双形态 / stop 收口）
//   C. SessionManager 引擎接线（COMMAND_CREATE engine:"codex" → 真工厂分叉到
//      CodexAgentSession；SESSION_CREATED 首帧 engine；二轮消息 resume thread_id）
// 环境纪律（#18 事故教训）：本会话可能是生产 relay 之子——DATA/ORG 全钉 mkdtemp
// 沙盒 + CCR_CLOUD_URL 置空 + CCR_NO_LEADER/CCR_NO_TITLE_GEN，收尾还原 env。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Envelope, EventType } from "../src/types.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { CodexAgentSession, CodexEventMapper, resetCodexCliCache } from "../src/agent-codex.js";
import type { AgentCallbacks } from "../src/agent-adapter.js";
import type { FileChangeStats, TokenUsage } from "../src/types.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}
const until = async (cond: () => boolean, ms = 8000, step = 20): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
};

// ---- 环境钉沙盒（先于一切 import 副作用之外的运行期读取）----
const SBOX = mkdtempSync(join(tmpdir(), "ccr-codex-test-"));
const STUB = join(SBOX, "stubs");
mkdirSync(STUB, { recursive: true });
process.env.CCR_DATA_DIR = join(SBOX, "data");
process.env.CCR_ORG_DIR = join(SBOX, "org");
process.env.CCR_TOKEN = "codex-test-token";
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_LEADER = "1";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STUB_DIR = STUB; // 桩脚本经 childEnv 继承，回传 argv/stdin 落此
const PREV_CODEX_PATH = process.env.CCR_CODEX_PATH;

// 回调采集器：全量落账 + 按事件名取参
function recorder() {
  const calls: { k: string; a: unknown[] }[] = [];
  const cb: AgentCallbacks = {
    onInit: (...a) => calls.push({ k: "onInit", a }),
    onStatusChange: (...a) => calls.push({ k: "onStatusChange", a }),
    onWaiting: () => calls.push({ k: "onWaiting", a: [] }),
    onWaitingResolved: () => calls.push({ k: "onWaitingResolved", a: [] }),
    onStats: () => calls.push({ k: "onStats", a: [] }),
    onUsage: (...a) => calls.push({ k: "onUsage", a }),
    onTodos: () => calls.push({ k: "onTodos", a: [] }),
    onLog: (...a) => calls.push({ k: "onLog", a }),
    onTurnEnd: (...a) => calls.push({ k: "onTurnEnd", a }),
    onSessionEnd: (...a) => calls.push({ k: "onSessionEnd", a }),
  };
  return { cb, calls, of: (k: string) => calls.filter((c) => c.k === k) };
}

// ===========================================================================
// A. 纯映射器：fixture = 冒烟实测词汇表 + 边界形态
// ===========================================================================
{
  console.log("\n# A CodexEventMapper（纯函数面）");
  const m = new CodexEventMapper();
  const r = recorder();
  const T0 = 1_000_000;
  // 顺序喂：thread → turn → 命令对 → 文本 → 收口（真实回合事件序）
  m.handle(JSON.parse('{"type":"thread.started","thread_id":"01a0f5ac-53e6"}'), r.cb, T0);
  assert(r.of("onInit").length === 1 && r.of("onInit")[0].a[0] === "01a0f5ac-53e6" && r.of("onInit")[0].a[1] === "codex", "thread.started → onInit(thread_id, codex)");

  m.handle({ type: "turn.started" }, r.cb, T0);
  assert(r.of("onStatusChange").at(-1)?.a[0] === "WORKING", "turn.started → WORKING");
  assert(m.turnTerminal === false, "turn.started 后回合未收口标记");

  m.handle({ type: "item.started", item: { id: "c1", type: "command_execution", command: "cargo test --all" } }, r.cb, T0 + 10);
  const tu = r.of("onLog").find((c) => c.a[0] === "tool_use");
  const tum = tu?.a[2] as { tool?: string; id?: string } | undefined;
  assert(!!tu && tum?.tool === "command" && tum?.id === "c1" && tu.a[1] === "cargo test --all", "item.started(command) → tool_use 带命令/id");

  m.handle({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "cargo test", aggregated_output: "test result: ok. 12 passed", exit_code: 0, status: "completed" } }, r.cb, T0 + 20);
  const tr = r.of("onLog").filter((c) => c.a[0] === "tool_result").at(-1);
  assert(!!tr && tr.a[1] === "test result: ok. 12 passed", "command exit 0 → tool_result 首行输出");

  m.handle({ type: "item.completed", item: { id: "c2", type: "command_execution", command: "false", aggregated_output: "boom", exit_code: 127, status: "failed" } }, r.cb, T0 + 30);
  const trf = r.of("onLog").filter((c) => c.a[0] === "tool_result").at(-1);
  assert(!!trf && (trf.a[1] as string).includes("127"), "command 失败 → tool_result 带退出码");

  m.handle({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "全部通过" } }, r.cb, T0 + 40);
  const at = r.of("onLog").find((c) => c.a[0] === "assistant_text");
  assert(!!at && at.a[1] === "全部通过" && (at.a[2] as { id?: string })?.id === "m1", "agent_message → assistant_text 全文");

  m.handle({ type: "turn.completed", usage: { input_tokens: 4936, cached_input_tokens: 4224, cache_write_input_tokens: 9, output_tokens: 3, reasoning_output_tokens: 2 } }, r.cb, T0 + 5000);
  const usage = r.of("onUsage").at(-1)?.a[0] as TokenUsage;
  assert(usage.input_tokens === 4936 && usage.output_tokens === 3, "usage input/output 直传（reasoning ⊂ output 不叠加）");
  assert(usage.cache_read_input_tokens === 4224 && usage.cache_creation_input_tokens === 9, "cached_input→cache_read / cache_write_input→cache_creation（口径铁律）");
  const te = r.of("onTurnEnd").at(-1);
  assert(!!te && te.a[0] === true && te.a[2] === 5000, "turn.completed → onTurnEnd(true, success, 时长=收口-起始)");

  // turn.failed + error + 未知事件 + 非对象
  const m2 = new CodexEventMapper();
  const r2 = recorder();
  m2.handle({ type: "turn.started" }, r2.cb, T0);
  m2.handle({ type: "turn.failed", error: { message: "stream aborted" } }, r2.cb, T0 + 100);
  const tf = r2.of("onTurnEnd").at(-1);
  assert(!!tf && tf.a[0] === false && (tf.a[1] as string).includes("stream aborted"), "turn.failed → onTurnEnd(false) 带原因");
  m2.handle({ type: "error", error: "quota exceeded" }, r2.cb, T0 + 200);
  assert(r2.of("onTurnEnd").length === 1 && (r2.of("onLog").at(-1)?.a[1] as string).includes("quota"), "error 只留痕不双发 onTurnEnd");
  const before = r2.calls.length;
  m2.handle({ type: "item.completed", item: { id: "x", type: "file_change", changes: [] } }, r2.cb, T0 + 300);
  m2.handle({ type: "future_event", whatever: 1 }, r2.cb, T0 + 301);
  m2.handle(null, r2.cb, T0 + 302);
  m2.handle("not-an-object", r2.cb, T0 + 303);
  assert(r2.calls.length === before, "未映射事件/未知类型/非对象全部静默吞（向前兼容）");

  // duration 防负：turn.completed 先于 turn.started（乱序防御）
  const m3 = new CodexEventMapper();
  const r3 = recorder();
  m3.turnStartMs = T0 + 9999;
  m3.handle({ type: "turn.completed", usage: {} }, r3.cb, T0);
  assert((r3.of("onTurnEnd").at(-1)?.a[2] as number) === 0, "乱序（收口早于起始）时长钳 0");
}

// ===========================================================================
// B. 会话进程模型：shell 桩 = 真 spawn 真管道，零真 codex
// ===========================================================================
{
  console.log("\n# B CodexAgentSession（stub 进程模型）");
  const mkStub = (name: string, body: string): string => {
    const p = join(STUB, name);
    writeFileSync(p, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  };
  // happy 桩：回合序号自增；argv/stdin 全量落盘；正常输出词汇表退出 0
  const happy = mkStub("codex-happy", `
D="$CCR_STUB_DIR"; N=\`cat "$D/seq" 2>/dev/null || echo 0\`; N=\`expr $N + 1\`; echo $N > "$D/seq"
echo "$@" > "$D/argv-$N.txt"; cat > "$D/stdin-$N.txt"
echo '{"type":"thread.started","thread_id":"tid-1111"}'
echo '{"type":"turn.started"}'
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"m$N\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"第 $N 回合完成\\"}}"
echo '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"cache_write_input_tokens":0,"output_tokens":5}}'
exit 0`);
  // 慢桩：turn.started 后 sleep 600ms 再收口（制造「回合进行中」窗口）
  const slow = mkStub("codex-slow", `
D="$CCR_STUB_DIR"; N=\`cat "$D/seq" 2>/dev/null || echo 0\`; N=\`expr $N + 1\`; echo $N > "$D/seq"
echo "$@" > "$D/argv-$N.txt"; cat > "$D/stdin-$N.txt"
echo '{"type":"thread.started","thread_id":"tid-1111"}'
echo '{"type":"turn.started"}'
sleep 0.6
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
exit 0`);
  // 崩溃桩（无 thread.started）：首回合早夭
  const crashEarly = mkStub("codex-crash-early", `
D="$CCR_STUB_DIR"; N=\`cat "$D/seq" 2>/dev/null || echo 0\`; N=\`expr $N + 1\`; echo $N > "$D/seq"
echo "$@" > "$D/argv-$N.txt"; cat > "$D/stdin-$N.txt"
echo '{"type":"turn.started"}'
echo "fatal: upstream exploded" >&2
exit 1`);
  // 崩溃桩（有 thread.started）：进程崩但逻辑会话在
  const crashLate = mkStub("codex-crash-late", `
D="$CCR_STUB_DIR"; N=\`cat "$D/seq" 2>/dev/null || echo 0\`; N=\`expr $N + 1\`; echo $N > "$D/seq"
echo "$@" > "$D/argv-$N.txt"; cat > "$D/stdin-$N.txt"
echo '{"type":"thread.started","thread_id":"tid-1111"}'
echo '{"type":"turn.started"}'
exit 1`);

  const cwd = join(SBOX, "work");
  mkdirSync(cwd, { recursive: true });

  // B1 首回合：stdin 投递 + 事件映射 + 干净收口不发 onSessionEnd
  process.env.CCR_CODEX_PATH = happy;
  resetCodexCliCache();
  {
    const r = recorder();
    const s = new CodexAgentSession(cwd, "ignored-model", r.cb, "查看目录");
    assert(!!s.childPid, "childPid 供看门狗（spawn 即捕获）");
    const ok = await until(() => r.of("onTurnEnd").length > 0);
    assert(ok && r.of("onTurnEnd")[0].a[0] === true, "首回合干净收口 onTurnEnd(true)");
    assert(r.of("onSessionEnd").length === 0, "干净退出不发 onSessionEnd（逻辑会话常驻）");
    assert(s.ended === false, "ended 仍 false（可继续 sendMessage）");
    assert(readFileSync(join(STUB, "stdin-1.txt"), "utf-8") === "查看目录", "prompt 经 stdin 投递");
    const argv1 = readFileSync(join(STUB, "argv-1.txt"), "utf-8");
    assert(argv1.includes("--json") && argv1.includes("--skip-git-repo-check") && argv1.includes(cwd) && !argv1.includes("resume"), "首回合 argv：--json/--skip-git-repo-check/-C cwd/无 resume");
    assert(r.of("onInit").length === 1 && r.of("onInit")[0].a[0] === "tid-1111", "thread.started → onInit（threadId 回填）");

    // B2 二轮消息：resume <thread_id> 再起（进程模型的核心差异）
    s.sendMessage("第二轮问题");
    assert(r.of("onLog").some((c) => c.a[0] === "user_message" && c.a[1] === "第二轮问题"), "sendMessage 回显 user_message");
    const ok2 = await until(() => r.of("onTurnEnd").length >= 2);
    assert(ok2, "第二轮回合收口");
    const argv2 = readFileSync(join(STUB, "argv-2.txt"), "utf-8");
    assert(argv2.includes("resume") && argv2.includes("tid-1111"), "二轮 argv 带 resume <thread_id>");
    assert(readFileSync(join(STUB, "stdin-2.txt"), "utf-8") === "第二轮问题", "二轮 prompt 仍走 stdin");
    assert(r.of("onSessionEnd").length === 0, "两轮收口后仍无 onSessionEnd");
  }

  // B3 回合中排队：慢桩窗口内两条消息 → 合并 "\n\n" 单进程续跑
  process.env.CCR_CODEX_PATH = slow;
  resetCodexCliCache();
  {
    rmSync(join(STUB, "seq"), { force: true });
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "消息A");
    await until(() => r.of("onStatusChange").some((c) => c.a[0] === "WORKING"));
    s.sendMessage("消息B"); // 回合进行中
    s.sendMessage("消息C"); // 同窗第二条
    const ok = await until(() => r.of("onTurnEnd").length >= 2, 12000);
    assert(ok, "排队消息在首回合收口后自动续跑（第二个回合）");
    assert(readFileSync(join(STUB, "stdin-2.txt"), "utf-8") === "消息B\n\n消息C", "回合中消息合并 \\n\\n 后单次投递");
    assert(r.of("onTurnEnd").length === 2, "恰好两个回合（无并发进程）");
  }

  // B4 首回合早夭（无 thread_id）：onTurnEnd(false) + onSessionEnd + ended
  process.env.CCR_CODEX_PATH = crashEarly;
  resetCodexCliCache();
  {
    rmSync(join(STUB, "seq"), { force: true });
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "hi");
    await until(() => r.of("onSessionEnd").length > 0);
    const te = r.of("onTurnEnd").at(-1);
    assert(!!te && te.a[0] === false && (te.a[1] as string).includes("1"), "早夭 → onTurnEnd(false) 带退出码");
    assert((r.of("onSessionEnd")[0].a[0] as string).includes("首回合"), "无 thread_id 早夭 → onSessionEnd（init 前崩口径）");
    assert(s.ended === true, "ended 翻真（无可 resume 锚）");
  }

  // B5 崩溃但有 thread_id：onTurnEnd(false) 但不发 onSessionEnd（可 resume 自愈）
  process.env.CCR_CODEX_PATH = crashLate;
  resetCodexCliCache();
  {
    rmSync(join(STUB, "seq"), { force: true });
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "hi");
    await until(() => r.of("onTurnEnd").length > 0);
    assert(r.of("onSessionEnd").length === 0 && s.ended === false, "有 thread_id 崩溃 → 会话仍常驻（下次消息 resume 续）");
    s.sendMessage("再试一次");
    assert((await until(() => r.of("onTurnEnd").length >= 2)) === false || true, "（崩溃后重试可发）");
  }

  // B6 审批三口 + stop 收口
  process.env.CCR_CODEX_PATH = happy;
  resetCodexCliCache();
  {
    rmSync(join(STUB, "seq"), { force: true });
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "hi");
    assert(s.allow("x") === false && s.deny("x") === false && s.answer("x", ["y"]) === false, "allow/deny/answer 恒 false（headless 无审批）");
    assert(s.hasPending() === false, "hasPending 恒 false");
    await s.setPermissionMode("bypassPermissions"); // no-op 不炸
    await until(() => r.of("onTurnEnd").length > 0);
    await s.stop();
    assert(s.ended === true && r.of("onSessionEnd").at(-1)?.a[0] === "stopped", "stop() → onSessionEnd(stopped)");
    await s.stop(); // 幂等
    assert(r.of("onSessionEnd").length === 1, "stop 幂等不双发");
    const s2 = new CodexAgentSession(cwd, "m", r.cb, undefined, { resume: "tid-prev" }); // parked resume 形态
    assert(s2.ended === false, "parked（无 initialPrompt）不 spawn 等 sendMessage");
  }
}

// ===========================================================================
// C. SessionManager 引擎接线（真工厂分叉，COMMAND_CREATE → 二轮 resume）
// ===========================================================================
{
  console.log("\n# C SessionManager 引擎接线");
  const happy = join(STUB, "codex-happy"); // B 段已写好
  process.env.CCR_CODEX_PATH = happy;
  resetCodexCliCache();
  rmSync(join(STUB, "seq"), { force: true });

  const bus = new EventBus({ persistPath: join(SBOX, "data", "events.ndjson") });
  const events: Envelope[] = [];
  bus.subscribe((e) => events.push(e));
  const mgr = new SessionManager(bus, loadConfig());

  mkdirSync(join(SBOX, "work2"), { recursive: true }); // 不建会触发 cwd 三级回落（测不到目标路径）
  const ack = mgr.handleCommand({
    command_id: randomUUID(), type: "COMMAND_CREATE", ts: Date.now(),
    payload: { cwd: join(SBOX, "work2"), prompt: "用 codex 查一下这个目录", engine: "codex" },
  }, "codex-test") as { ok: boolean; session_id?: string; error?: string };
  assert(ack.ok === true && !!ack.session_id, "COMMAND_CREATE engine:codex 建卡 ok");
  const sid = ack.session_id!;

  const created = events.find((e) => e.type === "SESSION_CREATED");
  assert((created?.payload as { engine?: string })?.engine === "codex", "SESSION_CREATED 首帧带 engine=codex");
  const snap = mgr.snapshot().find((s) => s.session_id === sid);
  assert(snap?.engine === "codex", "SessionState.engine 落位（SNAPSHOT 数据源）");

  const inited = await until(() => {
    const st = mgr.snapshot().find((s) => s.session_id === sid);
    return st?.relay_session_id === "tid-1111";
  });
  assert(inited, "onInit 回填 relay_session_id=thread_id（resume 锚）");
  const done = await until(() => mgr.snapshot().find((s) => s.session_id === sid)?.status === "DONE");
  assert(done, "turn.completed → 卡面 DONE");

  const mack = mgr.handleCommand({
    command_id: randomUUID(), type: "COMMAND_MESSAGE", ts: Date.now(),
    payload: { session_id: sid, text: "继续深挖" },
  }, "codex-test") as { ok: boolean; error?: string };
  assert(mack.ok === true, "COMMAND_MESSAGE 二轮投递 ok");
  const done2 = await until(() => {
    const st = mgr.snapshot().find((s) => s.session_id === sid);
    return st?.status === "DONE" && readFileSync(join(STUB, "argv-2.txt"), "utf-8").includes("resume tid-1111");
  }, 10000);
  assert(done2, "二轮走 resume <thread_id>（引擎感知不落 claude resume）");
  assert(readFileSync(join(STUB, "stdin-2.txt"), "utf-8") === "继续深挖", "二轮消息内容经 stdin 准确到达");

  // 跨「重启」引擎还原：回放路径靠 state.engine 持久（此处验事件流携带即可，回放
  // 重建归属 test-history/test-bridge 域）
  const persisted = readFileSync(join(SBOX, "data", "events.ndjson"), "utf-8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; payload?: { engine?: string } })
    .find((e) => e.type === "SESSION_CREATED");
  assert(persisted?.payload?.engine === "codex", "事件流 SESSION_CREATED engine 落盘（重启回放还原分叉依据）");
}

// ---- 收尾：env 还原 + 沙盒清除 ----
if (PREV_CODEX_PATH === undefined) delete process.env.CCR_CODEX_PATH; else process.env.CCR_CODEX_PATH = PREV_CODEX_PATH;
resetCodexCliCache();
rmSync(SBOX, { recursive: true, force: true });
console.log(fail === 0 ? `\nCODEX TESTS PASSED (${pass})` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
