// #42 引擎适配器一期收口对照套（10-04 版扩为收口版）
// 对照口径：Trae/Qwen/CodeBuddy 三引擎 + 通用 JSONL 兜底四路，五面逐项——
//   spawn 形态 / stream 解析（档位两面同源）/ DONE 判定 / ERROR 判定（is_error fail-closed）
//   / activity 上报 / capability 声明（006 保守口径：无审批能力的引擎不伪造 approval）
// 规范依据：006 :20（能力缺失用能力位表达，不伪造 WAITING/统计）、:294（stdout 无
//   结构化事件按纯文本能力位落地，不因通用 parser 存在而虚构 JSONL）、:560（能力位快照）
// 引擎本机安装：trae-cli/qwen/zcode 未装、codebuddy-code 已装——三新引擎全部走
//   stub fixture（#69：Qwen 真机冒烟待装后补验，不阻塞本单）。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GenericJsonEventMapper,
  mapJsonlStream,
  parseJsonDocument,
  preflightEngine,
  profileStructured,
  splitUtf8Lines,
} from "../src/agent-jsonl.js";
import { CODEBUDDY_ACTIVITY_CAPABILITIES, CODEBUDDY_CAPABILITIES, CodeBuddyAgentSession, mapCodeBuddyActivity, preflightCodeBuddy } from "../src/agent-codebuddy.js";
import { QWEN_ACTIVITY_CAPABILITIES, QWEN_CODE_CAPABILITIES, QwenCodeAgentSession, mapQwenCodeActivity, preflightQwen } from "../src/agent-qwen.js";
import { TRAE_ACTIVITY_CAPABILITIES, TRAE_CAPABILITIES, TraeAgentSession, mapTraeActivity, preflightTrae } from "../src/agent-trae.js";
import { preflightZCode } from "../src/agent-zcode.js";
import { createRegisteredEngine, getEngineDefinition, isReinjectionEngine } from "../src/engine-registry.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
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
  const usages: TokenUsage[] = [];
  let waitingCount = 0;
  let initialized = "";
  const cb: AgentCallbacks = {
    onInit: (id) => { initialized = id; },
    onStatusChange: (status) => { statuses.push(status); },
    onWaiting: (_p: WaitingPayload) => { waitingCount++; },
    onWaitingResolved: () => {},
    onStats: (_stats: FileChangeStats) => {},
    onUsage: (usage) => { usages.push(usage); },
    onTodos: (_todos: TodoItem[]) => {},
    onLog: (kind, text) => { logs.push({ kind, text }); },
    onTurnEnd: (ok) => { turns.push(ok); },
    onSessionEnd: () => {},
  };
  return {
    cb, logs, statuses, turns, usages,
    get waiting() { return waitingCount; },
    get initialized() { return initialized; },
  };
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
elif [ "$mode" = "codebuddy-ok" ]; then
  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"cb-stub","model":"cb-test"}'
  printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"read_file","id":"t1","input":{"path":"x"}}]}}'
  printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file body"}]}}'
  printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"CB 正文输出"}]}}'
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'
elif [ "$mode" = "document" ]; then
  printf '%s' '{"type":"done","text":"整段 JSON"}'
else
  printf '%s\\n' 'Trae plain line 1'
  printf '%s\\n' '{ "broken": trae-not-json'
  printf '%s\\n' 'Trae plain line 2'
fi
`, "utf8");
chmodSync(bin, 0o755);

try {
  // ============ 通用 JSONL 基础面（原基线保留） ============
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

  // ============ A. stream 解析：档位两面同源（#42 修齐点） ============
  assert(profileStructured(undefined) && profileStructured("qwen-code") && profileStructured("codebuddy"), "档位判定：缺省/qwen-code/codebuddy=结构化档");
  assert(!profileStructured("trae") && profileStructured("未注册引擎"), "档位判定：trae=纯文本档；未注册档位按保守 JSONL 档");

  const traeBatch = mapJsonlStream(["plain one", '{ "broken": trae', "plain two"], { capabilities: TRAE_ACTIVITY_CAPABILITIES, profileId: "trae" });
  assert(traeBatch.textLines === 3 && traeBatch.parsed === 0 && traeBatch.malformed === 0, "批量面 trae 档：纯文本行（含 { 开头坏行）全按正文、零畸形");

  const cbBatch = mapJsonlStream(
    ['{"type":"result","is_error":true,"result":"boom"}', "not-json"],
    { capabilities: CODEBUDDY_ACTIVITY_CAPABILITIES, profileId: "codebuddy" },
  );
  assert(cbBatch.parsed === 1 && cbBatch.malformed === 1, "批量面 codebuddy JSONL 档：坏行计畸形不中断流");
  assert(cbBatch.docks[0]?.state === "ERROR", "批量面 is_error result 行 fail-closed 转 ERROR 不落 DONE");

  const traeDock = mapTraeActivity("正文行");
  assert(traeDock.state === "WORKING" && traeDock.activity?.text === "正文行", "mapTraeActivity 纯文本→正文 dock");
  assert(mapQwenCodeActivity({ type: "done" }).state === "DONE", "mapQwenCodeActivity done→DONE");
  assert(mapCodeBuddyActivity({ type: "error", error: "x" }).state === "ERROR", "mapCodeBuddyActivity error→ERROR");

  // ============ B/C. DONE + ERROR 判定（会话级，四路） ============
  process.env.CCR_STUB_MODE = "trae";
  const trae = callbacks();
  const traeAgent = new TraeAgentSession({ cwd: root, model: "trae-test", command: bin, cb: trae.cb, initialPrompt: "首轮" });
  await wait(1500);
  assert(Boolean(trae.initialized) && trae.turns[0] === true, "Trae fresh spawn + 纯文本正文 + DONE");
  assert(trae.logs.filter((x) => x.kind === "assistant_text").length >= 2, "Trae 纯文本按行保留正文");
  assert(trae.logs.some((x) => x.kind === "assistant_text" && x.text.includes("trae-not-json")), "流式面 trae 档：{ 开头纯文本行按正文保留不误吞（#42 修齐回归）");
  assert(traeAgent.malformedLineCount === 0, "流式面 trae 档：零畸形计数（候选行路径不触发）");
  await traeAgent.stop();

  process.env.CCR_STUB_MODE = "qwen";
  const qwen = callbacks();
  const qwenAgent = new QwenCodeAgentSession({ cwd: root, model: "qwen-test", command: bin, cb: qwen.cb, initialPrompt: "中文\n长 prompt" });
  await wait(1500);
  assert(qwen.turns[0] === true && qwen.logs.some((x) => x.text.includes("Qwen 输出")), "Qwen -p/JSON 输出 mapper");
  assert(qwen.usages.some((u) => u.input_tokens === 12 && u.output_tokens === 4), "Qwen JSON 单对象 usage 上报（usage=true 能力位的已证来源）");
  await qwenAgent.stop();

  process.env.CCR_STUB_MODE = "codebuddy-ok";
  const cbOk = callbacks();
  const cbOkAgent = new CodeBuddyAgentSession({ cwd: root, model: "cb-test", command: bin, cb: cbOk.cb, initialPrompt: "正常流" });
  await wait(1500);
  assert(cbOk.turns[0] === true, "CodeBuddy stream-json 正常流 result→DONE");
  assert(cbOk.logs.some((x) => x.kind === "assistant_text" && x.text.includes("CB 正文输出")), "CodeBuddy message.content 块正文提取");
  assert(cbOk.logs.some((x) => x.kind === "tool_use"), "CodeBuddy message.content tool_use 块映射");
  assert(!cbOk.statuses.includes("WAITING") && cbOk.waiting === 0, "CodeBuddy 正常流零 WAITING");
  await cbOkAgent.stop();

  process.env.CCR_STUB_MODE = "codebuddy";
  const codebuddy = callbacks();
  const codebuddyAgent = new CodeBuddyAgentSession({ cwd: root, model: "cb-test", command: bin, cb: codebuddy.cb, initialPrompt: "权限测试" });
  await wait(1500);
  assert(codebuddy.turns[0] === false, "CodeBuddy CI 权限错误映射 ERROR");
  assert(!codebuddy.statuses.includes("WAITING"), "CodeBuddy CI 不伪造 WAITING");
  await codebuddyAgent.stop();

  const iserr = callbacks();
  new GenericJsonEventMapper().handle({ type: "result", is_error: true, result: "boom" }, iserr.cb);
  assert(iserr.turns[0] === false, "mapper is_error result 行 fail-closed：turnEnd(false) 不落 DONE");

  process.env.CCR_STUB_MODE = "document";
  const document = callbacks();
  const documentAgent = new TraeAgentSession({ cwd: root, model: "trae-test", command: bin, cb: document.cb, initialPrompt: "整段" });
  await wait(1500);
  assert(document.logs.some((x) => x.text.includes("整段 JSON")), "适配器接受 whole-document JSON");
  await documentAgent.stop();

  // ============ D. spawn ENOENT fail-closed（不落 running 假态） ============
  const enoent = callbacks();
  const enoentAgent = new TraeAgentSession({ cwd: root, model: "m", command: join(root, "no-such-cli"), cb: enoent.cb, initialPrompt: "x" });
  await wait(400);
  assert(enoent.turns[0] === false && enoent.statuses.includes("ERROR"), "spawn ENOENT fail-closed：ERROR + turnEnd(false)，不挂起不假 running");
  await enoentAgent.stop();

  // ============ E. preflight fail-closed（含 registry 拒绝面 / ZCode unsupported） ============
  const bad = preflightEngine({ command: join(root, "missing-cli"), provider: { baseUrl: "not a url", apiKeyEnv: "CCR_TEST_MISSING_KEY" } });
  assert(!bad.ok && bad.errors.length >= 2, "preflight 检查命令、provider 与 base URL");
  assert(!preflightTrae({ command: join(root, "missing-cli") }).ok, "preflightTrae 命令覆盖透传，缺失即 fail-closed");
  assert(!preflightQwen({ command: join(root, "missing-cli") }).ok, "preflightQwen 命令覆盖透传，缺失即 fail-closed");
  assert(!preflightCodeBuddy({ command: join(root, "missing-cli") }).ok, "preflightCodeBuddy 命令覆盖透传，缺失即 fail-closed");

  let registryThrew = false;
  try {
    createRegisteredEngine("codebuddy", { cwd: root, model: "cb", cb: callbacks().cb, providerProfile: { baseUrl: "not a url" } });
  } catch { registryThrew = true; }
  assert(registryThrew, "createRegisteredEngine preflight 失败 throw：不 spawn 不落假态");

  assert(createRegisteredEngine("zcode", { cwd: root, model: "z", cb: callbacks().cb }) === undefined, "createRegisteredEngine(zcode) 返回 undefined：不 spawn");
  const zpf = preflightZCode();
  assert(!zpf.ok && zpf.errors.join().includes("unsupported"), "preflightZCode 恒拒（unsupported 主档，装没装不是放行条件）");
  assert(getEngineDefinition("zcode") === undefined, "zcode 不在 registry 白名单");

  // ============ F. capability 声明快照 + 不伪造 approval ============
  const capsTable = [
    ["trae", TRAE_CAPABILITIES],
    ["qwen-code", QWEN_CODE_CAPABILITIES],
    ["codebuddy", CODEBUDDY_CAPABILITIES],
  ] as const;
  for (const [name, caps] of capsTable) {
    assert(caps.approval === false && caps.resume === false && caps.streaming === false, `${name} 能力位快照：approval/resume/streaming=false（006 保守口径）`);
  }
  assert(QWEN_CODE_CAPABILITIES.usage === true, "qwen usage=true 为 JSON 基线声明（真机冒烟欠账，差异备案）");
  assert(isReinjectionEngine("trae") && isReinjectionEngine("qwen-code") && isReinjectionEngine("codebuddy") && !isReinjectionEngine("zcode"), "reinjection 白名单=三新引擎，zcode 不入");

  for (const [name, agent] of [["trae", traeAgent as AgentLike], ["qwen-code", qwenAgent as AgentLike], ["codebuddy", codebuddyAgent as AgentLike]] as const) {
    // AgentLike 接口形态调用（带参）：同时验证三引擎满足编排契约
    assert(agent.allow("r1") === false && agent.deny("r1") === false && agent.answer("r1", ["a"]) === false, `${name} 无审批能力：allow/deny/answer 恒 false 不伪造通过`);
  }
  assert(trae.waiting === 0 && qwen.waiting === 0 && cbOk.waiting === 0 && codebuddy.waiting === 0, "四路会话全程零 WAITING（无 decision channel 引擎不伪造审批）");

  assert(!Object.values(process.env).some((v) => v === "长 prompt"), "测试未把 prompt/key 写入环境输出");
} finally {
  delete process.env.CCR_STUB_MODE;
  rmSync(root, { recursive: true, force: true });
}

console.log(fail === 0 ? `ENGINE ADAPTER TESTS PASSED (${pass})` : `${fail} FAILED / ${pass} PASSED`);
process.exit(fail === 0 ? 0 : 1);
