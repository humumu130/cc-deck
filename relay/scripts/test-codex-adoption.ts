import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/event-bus.js";
import { Bridge } from "../src/bridge.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { RolloutScanner, specOf, matchEngineProcess, type EngineProcessInfo } from "../src/engine-rollouts.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok - ${message}`);
}

const root = mkdtempSync(join(tmpdir(), "ccr-codex-adopt-"));
const dataDir = join(root, "data");
const rolloutRoot = join(root, "codex-sessions");
const projectsRoot = join(root, "claude-projects");
const claudeRoot = join(root, "claude");
const workDir = join(root, "work");
const errorDir = join(root, "error-work");
mkdirSync(join(rolloutRoot, "2026", "10", "08"), { recursive: true });
mkdirSync(projectsRoot, { recursive: true });
mkdirSync(claudeRoot, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(errorDir, { recursive: true });

process.env.CCR_DATA_DIR = dataDir;
process.env.CCR_PROJECTS_ROOT = projectsRoot;
process.env.CCR_SESSIONS_ROOT = join(root, "claude-sessions");
process.env.CCR_CODEX_SESSIONS_ROOT = rolloutRoot;
// 其余引擎根指到不存在的沙盒路径，隔离真机 ~/.trae 等目录
process.env.CCR_TRAE_SESSIONS_ROOT = join(root, "no-trae");
process.env.CCR_QWEN_SESSIONS_ROOT = join(root, "no-qwen");
process.env.CCR_CODEBUDDY_SESSIONS_ROOT = join(root, "no-codebuddy");
process.env.CCR_ZCODE_SESSIONS_ROOT = join(root, "no-zcode");
process.env.CCR_ENGINE_SCAN_MS = "60000";
process.env.CCR_ENGINE_STALE_MS = "600000";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_LEADER = "1";
process.env.CCR_CLOUD_URL = "";

const sessionId = "01adoption-1111-2222-3333-444444444444";
const errorSessionId = "01error-aaaa-bbbb-cccc-dddddddddddd";
const start = Date.now() - 4_000;
const rolloutPath = join(rolloutRoot, "2026", "10", "08", "rollout-2026-10-08T22-19-50-" + sessionId + ".jsonl");
const errorPath = join(rolloutRoot, "2026", "10", "08", "rollout-2026-10-08T22-20-50-" + errorSessionId + ".jsonl");

const line = (timestamp: number, ordinal: number, type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: new Date(timestamp).toISOString(), ordinal, type, payload }) + "\n";

writeFileSync(
  rolloutPath,
  [
    line(start, 0, "session_meta", { session_id: sessionId, cwd: workDir, model_provider: "test-provider" }),
    line(start + 100, 1, "event_msg", { type: "task_started" }),
    line(start + 150, 2, "message", { role: "user", content: [{ type: "text", text: "<environment_context>启动上下文</environment_context>" }] }),
    line(start + 200, 3, "event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "收编 Codex 外部会话" }] } }),
    line(start + 300, 4, "event_msg", { type: "item.started", item: { type: "command_execution", command: "printf rollout" } }),
  ].join(""),
);

writeFileSync(
  errorPath,
  [
    line(start, 0, "session_meta", { session_id: errorSessionId, cwd: errorDir }),
    line(start + 100, 1, "event_msg", { type: "task_started" }),
    line(start + 200, 2, "event_msg", { type: "error", error: { message: "fixture failure" } }),
  ].join(""),
);

let processes: EngineProcessInfo[] | null = [{ pid: 4242, cwd: workDir, startedAt: start + 200, command: "codex exec" }];
const bus = new EventBus();
const events: Array<{ type: string; session_id: string; payload: unknown }> = [];
bus.subscribe((event) => events.push(event));
const mgr = new SessionManager(bus, loadConfig());
const bridge = new Bridge(bus, mgr, {
  gateTools: new Set(),
  hasClients: () => false,
  dataDir,
  engineProcessProvider: (engine) => engine === "codex" ? processes : undefined,
});

bridge.scanExternalEngines();
let state = mgr.snapshot().find((item) => item.relay_session_id === sessionId);
assert(!!state, "rollout 增量扫描收编 Codex 会话");
assert(state?.external === true && state.engine === "codex", "Codex 卡标 external + engine=codex");
assert(state?.title === "收编 Codex 外部会话", `首条 UserMessage 派生标题 (${state?.title ?? ""})`);
assert(state?.status === "WORKING" && state.historical !== true, "活跃 rollout 映射 WORKING");
assert(state?.cli_pid === 4242, "cwd/启动时间启发式对位活 Codex 进程");
const scannedProfile = new RolloutScanner(specOf("codex"), rolloutRoot).scan().find((profile) => profile.sessionId === sessionId);
assert(!!scannedProfile && !matchEngineProcess(scannedProfile, [{ pid: 4343, cwd: workDir, startedAt: start - 30 * 60_000 }]), "同 cwd 但启动时间不符不误认 Codex 进程");
assert(events.some((event) => event.type === "SESSION_CREATED" && (event.payload as { engine?: string }).engine === "codex"), "SESSION_CREATED 带 engine=codex");
assert(mgr.getExternalLogs(state!.session_id).some((log) => log.text.includes("执行命令") && typeof log.occurred_at === "number"), "最近 rollout 活动投影到时间线");

appendFileSync(rolloutPath, line(start + 500, 4, "event_msg", { type: "turn.completed" }));
bridge.scanExternalEngines();
state = mgr.snapshot().find((item) => item.relay_session_id === sessionId);
assert(state?.status === "DONE", "turn.completed 映射 DONE");
assert(state?.action_summary === "Codex 回合完成", "终态卡摘要跟随最近 rollout 活动");
assert(state?.historical !== true, "进程仍在时完成会话不提前归档");

processes = [];
bridge.scanExternalEngines();
state = mgr.snapshot().find((item) => item.relay_session_id === sessionId);
assert(state?.historical === true && state.status === "DONE", "进程死亡后转历史态");

bridge.scanExternalEngines();
const errorState = mgr.snapshot().find((item) => item.relay_session_id === errorSessionId);
assert(errorState?.engine === "codex" && errorState.status === "ERROR", "error rollout 映射 ERROR");
assert(errorState?.historical === true, "无活进程的 error rollout 进入历史态");

const claudeSessionId = "claude-regression-session";
const claudeTranscript = join(claudeRoot, "claude.jsonl");
writeFileSync(claudeTranscript, "");
await bridge.handleEvent({
  event: "UserPromptSubmit",
  session_id: claudeSessionId,
  cwd: claudeRoot,
  prompt: "Claude 外部链路回归",
  transcript_path: claudeTranscript,
  cli_pid: process.pid,
});
const claudeState = mgr.snapshot().find((item) => item.relay_session_id === claudeSessionId);
assert(claudeState?.external === true && claudeState.engine === undefined, "Claude 外部 hook 收编链保持不变");

bridge.close();
assert(readFileSync(rolloutPath, "utf8").includes("turn.completed"), "测试只读验证 rollout 写入未触碰生产目录");
rmSync(root, { recursive: true, force: true });
console.log("\nCODEX ADOPTION TESTS PASSED");
