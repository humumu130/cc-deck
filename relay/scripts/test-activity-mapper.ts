import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapActivityState, mapClaudeActivity, mergeActivitySamples, preflightClaude, deriveActivityTaskSummary } from "../src/agent-adapter.js";
import { mapJsonlActivity } from "../src/agent-jsonl.js";
import { CODEX_ACTIVITY_CAPABILITIES, mapCodexActivity, preflightCodex } from "../src/agent-codex.js";
import { mapTraeActivity, TRAE_ACTIVITY_CAPABILITIES } from "../src/agent-trae.js";
import { mapQwenCodeActivity, QWEN_ACTIVITY_CAPABILITIES } from "../src/agent-qwen.js";
import { mapCodeBuddyActivity, CODEBUDDY_ACTIVITY_CAPABILITIES } from "../src/agent-codebuddy.js";
import { mapZCodeActivity, ZCODE_ACTIVITY_CAPABILITIES } from "../src/agent-zcode.js";
import { BRIDGE_ACTIVITY_CAPABILITIES, mapBridgeActivity } from "../src/bridge.js";
import type { TodoItem } from "../src/types.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures", name), "utf8")) as T;
let pass = 0;
let fail = 0;
function check(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
function finish(): never {
  console.log(`activity mapper: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

const capabilities = { native_status: false, operation_summary: true, native_elapsed: false, approval: false } as const;
const tasks = {
  todos: [{ status: "in_progress", active_form: "回填验收证据", content: "验收", updated_at: 10 } as TodoItem],
  dispatch: "执行 dispatch",
  board: "看 board",
  session: "会话任务",
};

const claude = fixture<Record<string, any>>("engine-claude.json");
const codex = fixture<Record<string, any>>("engine-codex.json");
const trae = fixture<Record<string, any>>("engine-trae.json");
const qwen = fixture<Record<string, any>>("engine-qwen.json");
const codebuddy = fixture<Record<string, any>>("engine-codebuddy.json");
const zcode = fixture<Record<string, any>>("engine-zcode.json");
const bridge = fixture<Record<string, any>>("bridge-activity.json");

const claudeTool = mapClaudeActivity({ ...claude.tool, task: tasks, now: 200 });
check(claudeTool.activity?.kind === "tool_use" && claudeTool.activity.tool === "Read", "Claude tool block maps tool_use");
check(claudeTool.task_summary?.source === "todo" && claudeTool.task_summary.text === "回填验收证据", "task summary prioritizes active todo");
check(mapClaudeActivity(claude.waiting).state === "WAITING", "Claude real approval channel preserves WAITING");
check(mapClaudeActivity(claude.assistant).activity?.occurred_at === 110, "Claude preserves producer occurred_at");

const codexTool = mapCodexActivity(codex.tool, { now: 200 });
check(codexTool.activity?.kind === "tool_use" && codexTool.activity.text === "npm test", "Codex command execution maps tool_use");
check(mapCodexActivity(codex.assistant).activity?.kind === "assistant_text", "Codex agent message maps assistant_text");
check(mapCodexActivity(codex.result).activity?.kind === "tool_result", "Codex command result maps tool_result");
check(mapCodexActivity(codex.failed).state === "ERROR", "Codex failed turn maps ERROR");
check(mapCodexActivity(codex.unknown).state === "WORKING" && !mapCodexActivity(codex.unknown).activity, "Codex unknown event is conservative");
check(!CODEX_ACTIVITY_CAPABILITIES.approval && mapCodexActivity({ type: "waiting" }).state === "WORKING", "Codex does not fake WAITING");
check(mapCodexActivity({ type: "waiting" }, { remoteDecisionChannel: true }).capabilities.approval, "Codex approval is opt-in to remote channel");

check(mapTraeActivity(trae.plain).activity?.kind === "assistant_text", "Trae plain stdout maps assistant_text");
check(mapTraeActivity(trae.badLine).activity?.text === "{not-json", "Trae malformed JSON line remains safe text");
check(!TRAE_ACTIVITY_CAPABILITIES.approval, "Trae approval capability is false");
check(mapQwenCodeActivity(qwen.assistant).activity?.occurred_at === 1234, "Qwen producer timestamp is retained");
check(!mapQwenCodeActivity(qwen.empty).activity, "Qwen empty event does not invent activity");
check(mapCodeBuddyActivity(codebuddy.done).state === "DONE", "CodeBuddy terminal JSON event maps DONE");
check(!CODEBUDDY_ACTIVITY_CAPABILITIES.approval, "CodeBuddy approval capability is false");

const unsupported = mapZCodeActivity({ now: 200, task: tasks });
check(unsupported.state === "ERROR" && unsupported.unsupported === true, "ZCode exposes unsupported state");
check(!unsupported.activity && Boolean(unsupported.diagnostic?.includes("privacy/telemetry")), "ZCode does not fake activity");
check(!ZCODE_ACTIVITY_CAPABILITIES.operation_summary, "ZCode operation capability is false");

const bridgeTool = mapBridgeActivity(bridge.tool);
check(bridgeTool.activity?.kind === "tool_use" && bridgeTool.activity.tool === "Bash", "Bridge PreToolUse maps tool_use");
check(mapBridgeActivity(bridge.result).time_basis === "occurred_at", "Bridge preserves occurred_at basis");
check(mapBridgeActivity(bridge.error).state === "ERROR", "Bridge error maps ERROR");
check(mapBridgeActivity(bridge.end).state === "DONE", "Bridge SessionEnd maps DONE");
check(BRIDGE_ACTIVITY_CAPABILITIES.approval, "Bridge exposes its real remote approval capability");

const received = mapActivityState({ state: "WORKING", activityText: "收到文本", ts: 321, now: 400, capabilities });
check(received.time_basis === "relay_received" && received.activity?.observed_at === 321 && received.activity?.occurred_at === undefined, "Missing producer time is marked relay_received");
const taskFallback = deriveActivityTaskSummary({ dispatch: "dispatch", board: "board", session: "session" }, 500);
check(taskFallback?.source === "dispatch", "task summary falls back dispatch then board then session");
const merged = mergeActivitySamples(
  mapClaudeActivity({ status: "WORKING", log: { kind: "tool_use", text: "part 1", tool: "Read", ts: 100 } }),
  mapClaudeActivity({ status: "WORKING", log: { kind: "tool_use", text: "part 2", tool: "Read", ts: 220 } }),
);
check(merged.merged && !merged.terminal, "same tool updates merge within 150ms");
const closed = mergeActivitySamples(
  mapClaudeActivity({ status: "WORKING", log: { kind: "tool_use", text: "part", tool: "Read", ts: 100 } }),
  mapClaudeActivity({ status: "WORKING", log: { kind: "tool_result", text: "done", tool: "Read", ts: 120 } }),
);
check(closed.terminal && !closed.merged, "tool_result closes independently");

const badJson = mapJsonlActivity("not-json", { capabilities, now: 600 });
check(badJson.state === "WORKING" && badJson.activity?.kind === "assistant_text", "bad JSON input does not throw or fabricate tool events");
check(mapJsonlActivity({ type: "tool_result", tool: "Read", result: "ok" }, { capabilities, now: 600 }).activity?.kind === "tool_result", "generic JSONL tool_result maps separately");
check(!preflightClaude({ cliPath: null, credentialConfigured: false }).ok, "Claude preflight fails closed without CLI/credentials");
check(!preflightCodex({ cliPath: null, credentialConfigured: false }).ok, "Codex preflight fails closed without CLI/credentials");
check(preflightClaude({ cliPath: "/tmp/claude", credentialConfigured: true, version: "1.0" }).warnings.length === 0, "Claude preflight accepts explicit checks without secret inspection");
check(preflightCodex({ cliPath: "/tmp/codex", credentialConfigured: true, version: "1.0" }).warnings.length === 0, "Codex preflight accepts explicit checks without secret inspection");

finish();
