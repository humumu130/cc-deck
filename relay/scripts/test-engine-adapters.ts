import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericJsonEventMapper, parseJsonDocument, splitUtf8Lines } from "../src/agent-jsonl.js";
import { TraeAgentSession } from "../src/agent-trae.js";
import { QwenCodeAgentSession } from "../src/agent-qwen.js";
import { CodeBuddyAgentSession } from "../src/agent-codebuddy.js";
import { preflightEngine } from "../src/agent-jsonl.js";
import type { AgentCallbacks } from "../src/agent-adapter.js";
import type { FileChangeStats, SessionLogPayload, SessionStatus, TodoItem, TokenUsage, WaitingPayload } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "ccr-engine-adapters-"));
let pass = 0;
let fail = 0;
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function callbacks() {
  const logs: Array<{ kind: SessionLogPayload["kind"]; text: string }> = [];
  const statuses: SessionStatus[] = [];
  const turns: boolean[] = [];
  let initialized = "";
  const cb: AgentCallbacks = {
    onInit: (id) => { initialized = id; },
    onStatusChange: (status) => { statuses.push(status); },
    onWaiting: (_p: WaitingPayload) => { throw new Error("stub adapter 不应产生 WAITING"); },
    onWaitingResolved: () => {},
    onStats: (_stats: FileChangeStats) => {},
    onUsage: (_usage: TokenUsage) => {},
    onTodos: (_todos: TodoItem[]) => {},
    onLog: (kind, text) => { logs.push({ kind, text }); },
    onTurnEnd: (ok) => { turns.push(ok); },
    onSessionEnd: () => {},
  };
  return { cb, logs, statuses, turns, get initialized() { return initialized; } };
}

const bin = join(root, "stub-engine.sh");
writeFileSync(bin, `#!/bin/sh
mode="${"$CCR_STUB_MODE"}"
if [ "$mode" = "qwen" ]; then
  printf '%s\\n' '{"type":"session.started","session_id":"stub-qwen","model":"qwen-test"}'
  printf '%s\\n' '{"type":"assistant","text":"Qwen 输出","usage":{"input_tokens":12,"output_tokens":4}}'
  printf '%s\\n' '{"type":"done"}'
elif [ "$mode" = "codebuddy" ]; then
  printf '%s\\n' 'permission denied: ci mode cannot modify this path' >&2
  exit 13
elif [ "$mode" = "document" ]; then
  printf '%s' '{"type":"done","text":"整段 JSON"}'
else
  printf '%s\\n' 'Trae plain line 1'
  printf '%s\\n' 'Trae plain line 2'
fi
`, "utf8");
chmodSync(bin, 0o755);

try {
  const framer = splitUtf8Lines();
  const bytes = Buffer.from("中\n文\n", "utf8");
  assert(framer.push(bytes.subarray(0, 2)).length === 0, "UTF-8 字节分帧不在半字符处解码");
  assert(framer.push(bytes.subarray(2)).join("|") === "中|文", "UTF-8 分帧输出完整行");
  assert(JSON.stringify(parseJsonDocument(["{", '  \"type\": \"done\",', '  \"text\": \"ok\"', "}"])) .includes("done"), "whole-document JSON fallback");

  const map = callbacks();
  const mapper = new GenericJsonEventMapper();
  mapper.handle({ type: "tool_call", name: "read_file" }, map.cb);
  mapper.handle({ type: "unknown.future.event", value: 1 }, map.cb);
  assert(map.logs.some((x) => x.kind === "tool_use"), "未知事件不阻塞，可靠工具事件仍映射");

  const trae = callbacks();
  process.env.CCR_STUB_MODE = "trae";
  const traeAgent = new TraeAgentSession({ cwd: root, model: "trae-test", command: bin, cb: trae.cb, initialPrompt: "首轮" });
  await wait(1500);
  assert(Boolean(trae.initialized) && trae.turns[0] === true, "Trae fresh spawn + 纯文本正文 + DONE");
  assert(trae.logs.filter((x) => x.kind === "assistant_text").length >= 2, "Trae 纯文本按行保留正文");
  await traeAgent.stop();

  const qwen = callbacks();
  process.env.CCR_STUB_MODE = "qwen";
  const qwenAgent = new QwenCodeAgentSession({ cwd: root, model: "qwen-test", command: bin, cb: qwen.cb, initialPrompt: "中文\n长 prompt" });
  await wait(1500);
  assert(qwen.turns[0] === true && qwen.logs.some((x) => x.text.includes("Qwen 输出")), "Qwen -p/JSON 输出 mapper");
  await qwenAgent.stop();

  const codebuddy = callbacks();
  process.env.CCR_STUB_MODE = "codebuddy";
  const codebuddyAgent = new CodeBuddyAgentSession({ cwd: root, model: "cb-test", command: bin, cb: codebuddy.cb, initialPrompt: "权限测试" });
  await wait(1500);
  assert(codebuddy.turns[0] === false, "CodeBuddy CI 权限错误映射 ERROR");
  assert(!codebuddy.statuses.includes("WAITING"), "CodeBuddy CI 不伪造 WAITING");
  await codebuddyAgent.stop();

  process.env.CCR_STUB_MODE = "document";
  const document = callbacks();
  const documentAgent = new TraeAgentSession({ cwd: root, model: "trae-test", command: bin, cb: document.cb, initialPrompt: "整段" });
  await wait(1500);
  assert(document.logs.some((x) => x.text.includes("整段 JSON")), "适配器接受 whole-document JSON");
  await documentAgent.stop();

  const bad = preflightEngine({ command: join(root, "missing-cli"), provider: { baseUrl: "not a url", apiKeyEnv: "CCR_TEST_MISSING_KEY" } });
  assert(!bad.ok && bad.errors.length >= 2, "preflight 检查命令、provider 与 base URL");
  assert(!Object.values(process.env).some((v) => v === "长 prompt"), "测试未把 prompt/key 写入环境输出");
} finally {
  delete process.env.CCR_STUB_MODE;
  rmSync(root, { recursive: true, force: true });
}

console.log(fail === 0 ? `ENGINE ADAPTER TESTS PASSED (${pass})` : `${fail} FAILED / ${pass} PASSED`);
process.exit(fail === 0 ? 0 : 1);
