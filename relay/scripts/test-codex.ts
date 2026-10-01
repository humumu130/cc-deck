// #27 Codex 接入 P0 测试锁（2026-10-01）：CI 零真 codex / 零 GLM key。
// 三段：
//   A. CodexEventMapper 纯映射（fixture 喂 0.154.0 实测事件词汇表 + 边界形态）
//   B. CodexAgentSession 进程模型（CCR_CODEX_PATH 指向 shell 桩——真 spawn 真管道，
//      验证 stdin 投递 / resume 参数 / 回合中排队合并 / 崩溃双形态 / stop 收口）
//   C. SessionManager 引擎接线（COMMAND_CREATE engine:"codex" → 真工厂分叉到
//      CodexAgentSession；SESSION_CREATED 首帧 engine；二轮消息 resume thread_id）
// 环境纪律（#18 事故教训）：本会话可能是生产 relay 之子——DATA/ORG 全钉 mkdtemp
// 沙盒 + CCR_CLOUD_URL 置空 + CCR_NO_LEADER/CCR_NO_TITLE_GEN，收尾还原 env。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Envelope, EventType } from "../src/types.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { loadEvents, reduceHistory } from "../src/history.js";
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
// 防引擎路由回归烧真 token：engine 分叉若被改坏（codex 卡落到 Claude 工厂），
// SDK 会真拉 Claude CLI——钉死到 /bin/false 让任何漏网 spawn 立即失败，且不写
// ~/.claude/projects（测试审查 ⑫：C 段此前对此零防线）
process.env.CC_DECK_CLAUDE_PATH = "/bin/false";
const PREV_CODEX_PATH = process.env.CCR_CODEX_PATH;

// 每段清桩产物（argv-*/stdin-*/seq）：seq 归 1 后旧段同名文件会被覆盖，断言读的
// 可能是上一段的残件（测试审查 ⑪——此前只清 seq，靠桩恰好同名覆写侥幸通过）
const clearArtifacts = (): void => {
  for (const f of readdirSync(STUB)) if (/^(argv-|stdin-|seq)/.test(f)) rmSync(join(STUB, f), { force: true });
};

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
  // 零事件桩：坏 provider 形态——dump 后直接退，一个 JSON 都不吐（审查 P1「零事件
  // 僵尸卡」的复现源：turnTerminal 若不在 spawn 时置 false，此形态收不了口）
  const crashSilent = mkStub("codex-crash-silent", `
D="$CCR_STUB_DIR"; N=\`cat "$D/seq" 2>/dev/null || echo 0\`; N=\`expr $N + 1\`; echo $N > "$D/seq"
echo "$@" > "$D/argv-$N.txt"; cat > "$D/stdin-$N.txt"
exit 1`);
  // turn.failed 桩：收口事件到达后干净退出（验证不再走退出码路径双发）
  const failTurn = mkStub("codex-fail-turn", `
D="$CCR_STUB_DIR"; N=\`cat "$D/seq" 2>/dev/null || echo 0\`; N=\`expr $N + 1\`; echo $N > "$D/seq"
echo "$@" > "$D/argv-$N.txt"; cat > "$D/stdin-$N.txt"
echo '{"type":"thread.started","thread_id":"tid-1111"}'
echo '{"type":"turn.started"}'
echo "{\\"type\\":\\"turn.failed\\",\\"error\\":{\\"message\\":\\"model overloaded\\"}}"
exit 0`);
  // 挂死桩：dump 后长眠（C 段 fresh-重放路径的 init 看门狗触发源）
  const hang = mkStub("codex-hang", `
D="$CCR_STUB_DIR"; N=\`cat "$D/seq" 2>/dev/null || echo 0\`; N=\`expr $N + 1\`; echo $N > "$D/seq"
echo "$@" > "$D/argv-$N.txt"; cat > "$D/stdin-$N.txt"
sleep 30
exit 0`);

  const cwd = join(SBOX, "work");
  mkdirSync(cwd, { recursive: true });

  // B1 首回合：stdin 投递 + 事件映射 + 干净收口不发 onSessionEnd
  process.env.CCR_CODEX_PATH = happy;
  resetCodexCliCache();
  {
    clearArtifacts();
    const r = recorder();
    const s = new CodexAgentSession(cwd, "ignored-model", r.cb, "查看目录");
    assert(!!s.childPid, "childPid 供看门狗（spawn 即捕获）");
    assert(r.of("onStatusChange").some((c) => c.a[0] === "WORKING" && c.a[1] === "启动中"), "spawn 即报 WORKING「启动中」（turn.started 前窗口不停旧态）");
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
    clearArtifacts();
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
    clearArtifacts();
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "hi");
    await until(() => r.of("onSessionEnd").length > 0);
    const te = r.of("onTurnEnd").at(-1);
    const reason = String(te?.a[1] ?? "");
    assert(!!te && te.a[0] === false && reason.includes("1"), "早夭 → onTurnEnd(false) 带退出码");
    if (process.env.CCR_CODEX_DEBUG) console.log("   [dbg B4] reason =", JSON.stringify(reason));
    assert(reason.includes("upstream exploded"), "崩溃原因含 stderr 尾段（可诊断）");
    assert((r.of("onSessionEnd")[0].a[0] as string).includes("首回合"), "无 thread_id 早夭 → onSessionEnd（init 前崩口径）");
    assert(s.ended === true, "ended 翻真（无可 resume 锚）");
  }

  // B5 崩溃但有 thread_id：onTurnEnd(false) 但不发 onSessionEnd（可 resume 自愈）；
  // 重发消息走 resume（旧版此处是恒真假断言——测试审查 ⑤ 换成 argv 真锁）
  process.env.CCR_CODEX_PATH = crashLate;
  resetCodexCliCache();
  {
    clearArtifacts();
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "hi");
    await until(() => r.of("onTurnEnd").length > 0);
    assert(r.of("onSessionEnd").length === 0 && s.ended === false, "有 thread_id 崩溃 → 会话仍常驻（下次消息 resume 续）");
    s.sendMessage("再试一次");
    const ok2 = await until(() => r.of("onTurnEnd").length >= 2, 8000);
    assert(ok2, "崩溃后重试可发（第二回合到达）");
    const argv2 = readFileSync(join(STUB, "argv-2.txt"), "utf-8");
    assert(argv2.includes("resume") && argv2.includes("tid-1111"), "重试 argv 带 resume <thread_id>（自愈锚透传）");
    assert(r.of("onSessionEnd").length === 0, "崩溃-重试全程无 onSessionEnd（逻辑会话常驻）");
  }

  // B5b 零事件退出（坏 provider 形态）：turnTerminal 在 spawn 时置 false 的锁——
  // 删掉实现里那两行，这里 onTurnEnd/onSessionEnd 一个都不会到（until 超时红）
  process.env.CCR_CODEX_PATH = crashSilent;
  resetCodexCliCache();
  {
    clearArtifacts();
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "hi");
    const ended = await until(() => r.of("onSessionEnd").length > 0, 8000);
    assert(ended, "零事件退出 → onSessionEnd（僵尸卡修复：回合在途标记不靠首事件）");
    const te = r.of("onTurnEnd").at(-1);
    assert(!!te && te.a[0] === false && (te.a[1] as string).includes("1"), "零事件退出 → onTurnEnd(false) 带退出码");
    assert(s.ended === true, "零事件退出 → ended（无锚卡不留 WORKING 僵尸）");
  }

  // B5c turn.failed 收口后干净退出：恰一次 onTurnEnd，退出码路径不双发
  process.env.CCR_CODEX_PATH = failTurn;
  resetCodexCliCache();
  {
    clearArtifacts();
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "hi");
    await until(() => r.of("onTurnEnd").length > 0);
    await new Promise((res) => setTimeout(res, 300)); // 给 close 事件留到达窗口
    assert(r.of("onTurnEnd").length === 1, "turn.failed → onTurnEnd 恰一次（exit 0 不双发）");
    const te = r.of("onTurnEnd")[0];
    assert(!!te && te.a[0] === false && (te.a[1] as string).includes("model overloaded"), "turn.failed 带原因文本");
    assert(r.of("onSessionEnd").length === 0 && s.ended === false, "有 thread_id：失败回合后会话常驻（可 resume 重试）");
  }

  // B5d 回合进行中 stop：同步收口 + stopping 守卫拦下 close 全部动作
  process.env.CCR_CODEX_PATH = slow;
  resetCodexCliCache();
  {
    clearArtifacts();
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, "长活");
    await until(() => r.of("onStatusChange").some((c) => c.a[0] === "WORKING"));
    await s.stop();
    assert(s.ended === true && r.of("onSessionEnd").length === 1 && r.of("onSessionEnd")[0].a[0] === "stopped", "stop 同步收口：onSessionEnd(stopped) 立即到达");
    await new Promise((res) => setTimeout(res, 700)); // 杀树后 close 到达窗口
    assert(r.of("onTurnEnd").length === 0, "被杀回合不补发 onTurnEnd（stopping 守卫，防假 ERROR 帧叠在 stopped 终态上）");
    assert(r.of("onSessionEnd").length === 1, "onSessionEnd 恰一次（close 不双发）");
  }

  // B6 审批三口 + stop 收口
  process.env.CCR_CODEX_PATH = happy;
  resetCodexCliCache();
  {
    clearArtifacts();
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
    assert(s2.childPid === undefined, "parked 无进程（childPid undefined，看门狗不误收养）");
  }

  // B6b 拒图（-i 需文件路径，relay 侧是 base64——三口统一 system 留痕拒绝）
  {
    clearArtifacts();
    const r = recorder();
    const s = new CodexAgentSession(cwd, "m", r.cb, undefined, {
      resume: "tid-prev",
      images: ["data:image/png;base64,AAAA"],
    });
    assert(r.of("onLog").some((c) => c.a[0] === "system" && String(c.a[1]).includes("不支持附图")), "构造路径带图 → system 拒图留痕（不吞）");
    s.sendMessage("看这张图", ["data:image/png;base64,BBBB"]);
    assert(r.of("onLog").filter((c) => c.a[0] === "system" && String(c.a[1]).includes("不支持附图")).length >= 2, "sendMessage 带图 → system 拒图留痕");
    const ok = await until(() => r.of("onTurnEnd").length >= 1);
    assert(ok && r.of("onLog").some((c) => c.a[0] === "user_message" && String(c.a[1]).includes("看这张图")), "拒图不影响正文投递（回合照常收口）");
    const argv1 = readFileSync(join(STUB, "argv-1.txt"), "utf-8");
    assert(!argv1.includes("-i"), "argv 不带 -i（base64 非文件路径，不硬塞）");
  }
}

// ===========================================================================
// C. SessionManager 引擎接线（真工厂分叉，COMMAND_CREATE → 二轮 resume）
// ===========================================================================
{
  console.log("\n# C SessionManager 引擎接线");
  const happy = join(STUB, "codex-happy"); // B 段已写好
  const crashLateBin = join(STUB, "codex-crash-late");
  const hangBin = join(STUB, "codex-hang");
  process.env.CCR_CODEX_PATH = happy;
  resetCodexCliCache();
  clearArtifacts();

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

  // C2 CLI 缺失 → 构造器同步 throw → create ack ok:false（f975fea 同款兜底，测试 ⑭）。
  // 判空要同时清 PATH 与 HOME：childEnv 有四条硬编码补位目录（~/node/bin 恰是本机
  // 真 codex 所在），单清 PATH 探测仍会命中
  {
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = "";
    process.env.HOME = join(SBOX, "nohome");
    process.env.CCR_CODEX_PATH = join(SBOX, "absent-codex");
    resetCodexCliCache();
    const th = mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_CREATE", ts: Date.now(),
      payload: { cwd: join(SBOX, "work2"), prompt: "x", engine: "codex" },
    }, "codex-test") as { ok: boolean; error?: string };
    assert(th.ok === false && (th.error ?? "").includes("codex"), "CLI 缺失 → create ok:false 可读错误（同步 throw 不炸 relay）");
    assert(!mgr.snapshot().some((s) => s.title === "x"), "失败建卡无半登记残留");
    process.env.PATH = prevPath ?? "";
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    process.env.CCR_CODEX_PATH = happy;
    resetCodexCliCache();
  }

  // C3 STOP → MESSAGE：走 resumeAgent（死卡分支）且 resume 透传（测试 ①——锁
  // engine 感知恢复，防回归成「ended 后 sendMessage 静默丢」）
  {
    clearArtifacts();
    const stop = mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_STOP", ts: Date.now(), payload: { session_id: sid },
    }, "codex-test") as { ok: boolean };
    assert(stop.ok === true, "COMMAND_STOP ok");
    const m3 = mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_MESSAGE", ts: Date.now(),
      payload: { session_id: sid, text: "停止后再发" },
    }, "codex-test") as { ok: boolean; error?: string };
    assert(m3.ok === true, "STOP 后 COMMAND_MESSAGE ok（resumeAgent 接管，不静默丢）");
    const done3 = await until(() => {
      const st = mgr.snapshot().find((s) => s.session_id === sid);
      return st?.status === "DONE" && existsSync(join(STUB, "argv-1.txt"))
        && readFileSync(join(STUB, "argv-1.txt"), "utf-8").includes("resume tid-1111");
    }, 10000);
    assert(done3, "STOP→MESSAGE 走 resumeAgent：argv 带 resume tid（恢复不换引擎）");
    assert(readFileSync(join(STUB, "stdin-1.txt"), "utf-8") === "停止后再发", "恢复消息经 stdin 准确到达");
  }

  // C4 reviveSaved codex 短路：同步合成 DONE「已恢复」（测试 ③——通用路径 parked
  // 不 spawn 无 onInit，30s 看门狗必误报「恢复失败」）
  {
    mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_STOP", ts: Date.now(), payload: { session_id: sid },
    }, "codex-test");
    const t0 = Date.now();
    const rack = mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_RESUME_SESSION", ts: Date.now(), payload: { session_id: sid },
    }, "codex-test") as { ok: boolean; error?: string };
    const st = mgr.snapshot().find((s) => s.session_id === sid);
    assert(rack.ok === true && Date.now() - t0 < 2000, "RESUME_SESSION 同步返回（不挂 30s 看门狗）");
    assert(st?.status === "DONE" && st.done_reason === "已恢复（等待输入）", "codex 短路恢复：直接合成已恢复终态");
    assert(st?.saved !== true && st?.historical !== true, "休眠/历史标记随恢复清除");
  }

  // C5 挂死恢复 → fresh 重放（测试 ②）：crashLate 先造「有锚无记忆」会话（thread_id
  // 已回填、无 assistant 产出），STOP 后发消息走 resumeAgent；hang 桩让 init 看门狗
  // （钉 200ms）开火 → 无记忆分支 fresh spawn 重放（argv 无 resume、仍走 codex 工厂）
  {
    clearArtifacts();
    process.env.CCR_CODEX_PATH = crashLateBin;
    resetCodexCliCache();
    const ack2 = mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_CREATE", ts: Date.now(),
      payload: { cwd: join(SBOX, "work2"), prompt: "会崩的首回合", engine: "codex" },
    }, "codex-test") as { ok: boolean; session_id?: string };
    const sid2 = ack2.session_id!;
    const inited2 = await until(() => mgr.snapshot().find((s) => s.session_id === sid2)?.relay_session_id === "tid-1111");
    assert(inited2, "崩前锚已回填（thread_id 可 resume）");
    await until(() => mgr.snapshot().find((s) => s.session_id === sid2)?.status === "ERROR");
    mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_STOP", ts: Date.now(), payload: { session_id: sid2 },
    }, "codex-test");
    const prevInitMs = process.env.CCR_RESUME_INIT_MS;
    // flake 根治（2026-10-01 全量回归实录）：此前钉 200ms，高负载下看门狗开火可
    // 快过挂死桩的 fork+exec——杀树时桩还没写 seq/argv 台账，fresh 重放进程抢到
    // 2 号槽：argv-3 永不出现（until 超时假 FAIL）+ stdin-3 ENOENT 直接炸测试。
    // 系统行为本身是对的（fresh 确实发生），碎的是测试「槽位=固定编号」假设。
    // 双修：①窗口 1500ms（桩启动+写台账的 7 倍余量，仍远小于缺省 45s）；②断言改
    // 槽位无关内容扫描——stdin 含原消息且 argv 无 resume = fresh 槽；argv 带
    // resume tid = resume 槽（create 槽因 stdin 是首回合消息天然不混入）
    process.env.CCR_RESUME_INIT_MS = "1500";
    process.env.CCR_CODEX_PATH = hangBin;
    resetCodexCliCache();
    const m4 = mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_MESSAGE", ts: Date.now(),
      payload: { session_id: sid2, text: "恢复试试" },
    }, "codex-test") as { ok: boolean };
    assert(m4.ok === true, "挂死恢复路径消息 ok");
    const slotOf = (pred: (argv: string, stdin: string) => boolean): boolean => {
      for (const f of readdirSync(STUB)) {
        if (!/^argv-\d+\.txt$/.test(f)) continue;
        const n = f.slice(5, -4);
        try {
          if (pred(readFileSync(join(STUB, f), "utf-8"),
                   readFileSync(join(STUB, `stdin-${n}.txt`), "utf-8"))) return true;
        } catch { /* 桩台账写一半，下一个轮询再看 */ }
      }
      return false;
    };
    const fresh = await until(() =>
      slotOf((argv, stdin) => !argv.includes("resume") && stdin.includes("恢复试试")), 12000);
    assert(fresh, "init 看门狗开火：fresh 重放 argv 无 resume（无记忆不赌 resume）");
    const resumeRan = await until(() => slotOf((argv) => argv.includes("resume tid-1111")), 12000);
    assert(resumeRan, "先走的 resume 进程也是 codex 工厂 spawn（引擎路由不回归）");
    // 清理挂死的 fresh 进程 + 还原 env
    mgr.handleCommand({
      command_id: randomUUID(), type: "COMMAND_STOP", ts: Date.now(), payload: { session_id: sid2 },
    }, "codex-test");
    if (prevInitMs === undefined) delete process.env.CCR_RESUME_INIT_MS; else process.env.CCR_RESUME_INIT_MS = prevInitMs;
    process.env.CCR_CODEX_PATH = happy;
    resetCodexCliCache();
  }

  // C6 重启回放还原 engine（测试 ④——history.ts P1 修复的实现级锁，等效断言另在
  // test-history 落一条纯函数版）
  {
    const replayed = reduceHistory(loadEvents(join(SBOX, "data", "events.ndjson")));
    assert(replayed.get(sid)?.state.engine === "codex", "回放还原 engine=codex（重启后恢复不换引擎）");
  }
}

// ---- 收尾：env 还原 + 沙盒清除 ----
if (PREV_CODEX_PATH === undefined) delete process.env.CCR_CODEX_PATH; else process.env.CCR_CODEX_PATH = PREV_CODEX_PATH;
resetCodexCliCache();
rmSync(SBOX, { recursive: true, force: true });
console.log(fail === 0 ? `\nCODEX TESTS PASSED (${pass})` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
