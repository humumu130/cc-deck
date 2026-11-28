// #72 上下文水位专项（纯单元，不起服务）：
// ① 托管路径水位 = per-call（onContext，每条 assistant 消息），回合 result 聚合
//    usage 不得覆盖它（旧实现在这里把水位钉成假 100%：重回合聚合恒超窗口）；
// ② limit 映射一律 200K（glm-5.3 旧映射 1M 是错的——转录 20+ 压缩边界一致落在
//    ~166K = CLI 按 200K 窗口 ~83% 阈值压缩的指纹，取证见 session-manager 注释）；
// ③ history 回放还原 context_usage/context_limit（热替换/重启后水位条不消失）；
// ④ 外部路径 setExternalUsage 的 limit 同口径。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadEvents, reduceHistory } from "../src/history.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import { watermarkFromUsage } from "../src/agent-adapter.js";

const ROOT = fileURLToPath(new URL("../data/test-ctxwm/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

const mgr = new SessionManager(new EventBus(), loadConfig());
let captured: AgentCallbacks | null = null;
let seq = 0;
mgr.setAgentFactory((_cwd, _model, cb) => {
  captured = cb;
  const agent: AgentLike = {
    id: `fake-${++seq}`,
    startedAt: Date.now(),
    ended: false,
    sendMessage() {},
    allow: () => false,
    deny: () => false,
    answer: () => false,
    stop: async () => {},
    setPermissionMode: async () => {},
  };
  return agent;
});

// S1 托管：per-call 水位 + result 聚合不覆盖 + 压缩后回落（create 走命令通道）
const ack = mgr.handleCommand(
  { command_id: "c-ctxwm-1", type: "COMMAND_CREATE", payload: { cwd: "/tmp/proj-ctx", prompt: "水位测试" } } as Parameters<typeof mgr.handleCommand>[0],
  "test",
);
const sid = ack.session_id!;
const cb = captured as unknown as AgentCallbacks;
cb.onInit("sdk-fake-1", "glm-5.3");
cb.onContext?.(150_000);
// 回合 result 聚合 usage（回合内多次调用之和，1.07M——旧实现把水位钉死在这 → 假 100%）
cb.onUsage({ input_tokens: 300_000, output_tokens: 50_000, cache_read_input_tokens: 700_000, cache_creation_input_tokens: 70_000 });
{
  const st = mgr.snapshot().find((s) => s.session_id === sid)!;
  assert(st.context_usage === 150_000, `水位=per-call 150K（不被 result 聚合覆盖）got=${st.context_usage}`);
  assert(st.context_limit === 200_000, `limit=200K（glm-5.3 不再 1M）got=${st.context_limit}`);
  assert(st.usage?.input_tokens === 300_000 && st.usage?.cache_read_input_tokens === 700_000, "usage 总量=回合聚合累计");
}
cb.onContext?.(27_449); // 压缩后回落
{
  const st = mgr.snapshot().find((s) => s.session_id === sid)!;
  assert(st.context_usage === 27_449, `水位覆盖式回落（压缩后）got=${st.context_usage}`);
}

// S2 外部路径 limit 同口径
mgr.ensureExternal("ext-ctx-a", "/tmp/proj-a", "会话A");
mgr.setExternalUsage("ext-ctx-a", { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "glm-5.3", 123_456);
{
  const st = mgr.getExternal("ext-ctx-a")!;
  assert(st.context_usage === 123_456 && st.context_limit === 200_000, `外部路径 limit=200K got=${st.context_limit}`);
}

// S3 回放还原水位（重启后水位条不消失）+ follow-up：limit 重算 / 污染值丢弃
{
  const evFile = join(ROOT, "events.ndjson");
  const t0 = Date.now();
  const lines = [
    { seq: 1, ts: t0, type: "SESSION_CREATED", session_id: "m-replay-1", payload: { cwd: "/tmp/p", initial_prompt: "回放测试", model: "glm-5.3", title: "回放会话" } },
    { seq: 2, ts: t0 + 1, type: "SESSION_UPDATED", session_id: "m-replay-1", payload: { status: "WORKING", action_summary: "干活", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, usage: { input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 0 }, context_usage: 108_466, context_limit: 1_000_000 } },
    { seq: 3, ts: t0 + 2, type: "SESSION_UPDATED", session_id: "m-replay-2", payload: { status: "DONE", action_summary: "旧bug", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, context_usage: 551_835, context_limit: 1_000_000 } },
  ];
  writeFileSync(evFile, lines.map((l) => JSON.stringify(l)).join("\n"));
  const rs = reduceHistory(loadEvents(evFile));
  const st = rs.get("m-replay-1")?.state;
  assert(st?.context_usage === 108_466, `回放还原 context_usage got=${st?.context_usage}`);
  assert(st?.context_limit === 200_000, `回放 limit 重算为 200K（历史帧 1M 不信任）got=${st?.context_limit}`);
  const st2 = rs.get("m-replay-2")?.state;
  assert(st2?.context_usage === undefined, `旧聚合污染值（551835>300K）不还原 got=${st2?.context_usage}`);
}

// S4 watermarkFromUsage：message_delta 口径（GLM 后端真值只在 delta/result）
{
  assert(watermarkFromUsage({ input_tokens: 7046, output_tokens: 3, cache_read_input_tokens: 11648 }) === 18_694, "delta usage → per-call 水位 18694");
  assert(watermarkFromUsage({ input_tokens: 0, output_tokens: 0 }) === 0, "GLM assistant 完整消息的全零 usage → 0（不触发）");
  assert(watermarkFromUsage(undefined) === 0, "无 usage → 0");
  assert(watermarkFromUsage({ input_tokens: 100, cache_creation_input_tokens: 50 }) === 150, "cache_creation 计入");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nCTXWM TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
