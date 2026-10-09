// #172-ext 多引擎 rollout 收编：Trae / Qwen Code / CodeBuddy / ZCode 共享
// codex 的扫描框架，每引擎一个 scanner；根目录不存在时静默跳过（不报错），
// 引擎装上后下一轮自动跟进。全部落在 mkdtemp 沙盒，不触碰 ~/.trae 等真机目录。
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/event-bus.js";
import { Bridge } from "../src/bridge.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { ENGINE_SCAN_SPECS, RolloutScanner, engineProcesses, specOf, type EngineProcessInfo } from "../src/engine-rollouts.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok - ${message}`);
}

const root = mkdtempSync(join(tmpdir(), "ccr-engine-rollouts-"));
const dataDir = join(root, "data");
const projectsRoot = join(root, "claude-projects");
const traeRoot = join(root, "trae-sessions");
const qwenRoot = join(root, "qwen-sessions");
const cbRoot = join(root, "codebuddy-sessions");
const zcodeRoot = join(root, "zcode-sessions");
const traeWork = join(root, "trae-work");
const qwenWork = join(root, "qwen-work");
const cbWork = join(root, "cb-work");
const zcodeWork = join(root, "zcode-work");
mkdirSync(join(traeRoot, "2026", "10"), { recursive: true });
mkdirSync(qwenRoot, { recursive: true });
mkdirSync(cbRoot, { recursive: true });
mkdirSync(traeWork, { recursive: true });
mkdirSync(qwenWork, { recursive: true });
mkdirSync(cbWork, { recursive: true });
mkdirSync(zcodeWork, { recursive: true });
// zcodeRoot 与 codex 根故意不建：验证缺目录跳过；真机 ~/.codex 也用沙盒空路径隔开

process.env.CCR_DATA_DIR = dataDir;
process.env.CCR_PROJECTS_ROOT = projectsRoot;
process.env.CCR_SESSIONS_ROOT = join(root, "claude-sessions");
process.env.CCR_CODEX_SESSIONS_ROOT = join(root, "no-codex");
process.env.CCR_TRAE_SESSIONS_ROOT = traeRoot;
process.env.CCR_QWEN_SESSIONS_ROOT = qwenRoot;
process.env.CCR_CODEBUDDY_SESSIONS_ROOT = cbRoot;
process.env.CCR_ZCODE_SESSIONS_ROOT = zcodeRoot;
process.env.CCR_ENGINE_SCAN_MS = "60000";
process.env.CCR_ENGINE_STALE_MS = "600000";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_LEADER = "1";
process.env.CCR_CLOUD_URL = "";

const traeSessionId = "01trae-aaaa-bbbb-cccc-dddddddddddd";
const qwenSessionId = "01qwen-1111-2222-3333-444444444444";
const cbSessionId = "01cbuddy-aaaa-bbbb-cccc-dddddddddddd";
const zcodeSessionId = "01zcode-aaaa-bbbb-cccc-dddddddddddd";
const start = Date.now() - 4_000;

const line = (timestamp: number, ordinal: number, type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: new Date(timestamp).toISOString(), ordinal, type, payload }) + "\n";

const traePath = join(traeRoot, "2026", "10", `rollout-2026-10-08T20-01-01-${traeSessionId}.jsonl`);
writeFileSync(
  traePath,
  [
    line(start, 0, "session_meta", { session_id: traeSessionId, cwd: traeWork, model_provider: "trae-local" }),
    line(start + 100, 1, "event_msg", { type: "task_started" }),
    line(start + 200, 2, "event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "用 Trae 重构登录模块" }] } }),
  ].join(""),
);

const qwenPath = join(qwenRoot, `session-${qwenSessionId}.jsonl`);
writeFileSync(
  qwenPath,
  [
    line(start, 0, "session_meta", { session_id: qwenSessionId, cwd: qwenWork, model_provider: "qwen" }),
    line(start + 100, 1, "event_msg", { type: "task_started" }),
    line(start + 200, 2, "message", { role: "user", content: [{ type: "text", text: "跑一遍 Qwen 全量检查" }] }),
    line(start + 300, 3, "event_msg", { type: "item.started", item: { type: "command_execution", command: "qwen lint ." } }),
  ].join(""),
);

const cbPath = join(cbRoot, `rollout-${cbSessionId}.jsonl`);
writeFileSync(
  cbPath,
  [
    line(start, 0, "session_meta", { session_id: cbSessionId, cwd: cbWork }),
    line(start + 100, 1, "event_msg", { type: "task_started" }),
    line(start + 200, 2, "event_msg", { type: "error", error: { message: "codebuddy fixture crash" } }),
  ].join(""),
);

const processesByEngine = new Map<string, EngineProcessInfo[]>([
  ["trae", [{ pid: 5100, cwd: traeWork, startedAt: start + 100, command: "trae agent" }]],
  ["qwen-code", [{ pid: 5200, cwd: qwenWork, startedAt: start + 100, command: "qwen chat" }]],
  ["codebuddy", []],
]);
const bus = new EventBus();
const events: Array<{ type: string; session_id: string; payload: unknown }> = [];
bus.subscribe((event) => events.push(event));
const mgr = new SessionManager(bus, loadConfig());
const bridge = new Bridge(bus, mgr, {
  gateTools: new Set(),
  hasClients: () => false,
  dataDir,
  engineProcessProvider: (engine) => processesByEngine.get(engine),
});

bridge.scanExternalEngines();
let state = mgr.snapshot().find((item) => item.relay_session_id === traeSessionId);
assert(!!state && state.external === true && state.engine === "trae", "Trae rollout 收编为外部卡 engine=trae");
assert(state?.title === "用 Trae 重构登录模块", `Trae 首条 UserMessage 派生标题 (${state?.title ?? ""})`);
assert(state?.status === "WORKING" && state.historical !== true, "活 Trae 进程映射 WORKING");
assert(state?.cli_pid === 5100, "Trae 进程对位 cli_pid");
assert(state?.engine_provider === "trae-local", "Trae session_meta provider 透传");
assert(events.some((event) => event.type === "SESSION_CREATED" && (event.payload as { engine?: string }).engine === "trae"), "SESSION_CREATED 带 engine=trae");

state = mgr.snapshot().find((item) => item.relay_session_id === qwenSessionId);
assert(!!state && state.engine === "qwen-code", "Qwen Code rollout 收编 engine=qwen-code");
assert(state?.status === "WORKING" && state?.cli_pid === 5200, "Qwen Code 进程对位映射 WORKING");
assert(mgr.getExternalLogs(state!.session_id).some((log) => log.text.includes("qwen lint")), "Qwen Code 活动投影到时间线");

state = mgr.snapshot().find((item) => item.relay_session_id === cbSessionId);
assert(!!state && state.engine === "codebuddy", "CodeBuddy rollout 收编 engine=codebuddy");
assert(state?.status === "ERROR" && state.historical === true, "error rollout + 无活进程映射 ERROR 历史态");

assert(!mgr.snapshot().some((item) => item.engine === "zcode"), "zcode 根目录缺失时静默跳过不建卡");
assert(!mgr.snapshot().some((item) => item.engine === "codex"), "codex 根目录缺失时同样跳过");
assert(mgr.snapshot().every((item) => !item.session_id.startsWith("ext-zcode-")), "zcode 无 ext 卡残留");

appendFileSync(qwenPath, line(start + 500, 4, "event_msg", { type: "turn.completed" }));
bridge.scanExternalEngines();
state = mgr.snapshot().find((item) => item.relay_session_id === qwenSessionId);
assert(state?.status === "DONE" && state?.action_summary === "Qwen Code 回合完成", "Qwen Code turn.completed 映射 DONE + 引擎标签摘要");

// 缺目录引擎装上后下一轮自动跟进（跳过 ≠ 永久禁用）
mkdirSync(zcodeRoot, { recursive: true });
writeFileSync(
  join(zcodeRoot, `session-${zcodeSessionId}.jsonl`),
  [
    line(start, 0, "session_meta", { session_id: zcodeSessionId, cwd: zcodeWork }),
    line(start + 100, 1, "event_msg", { type: "task_started" }),
    line(start + 200, 2, "event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "ZCode 补装后收编" }] } }),
  ].join(""),
);
bridge.scanExternalEngines();
state = mgr.snapshot().find((item) => item.relay_session_id === zcodeSessionId);
assert(!!state && state.engine === "zcode" && state.title === "ZCode 补装后收编", "目录后建引擎下一轮自动收编");

// 命令行匹配词级隔离：qwen 不认 codex 命令，codebuddy 不认前缀误撞
const codexSpec = specOf("codex");
const qwenSpec = specOf("qwen-code");
const cbSpec = specOf("codebuddy");
assert(!qwenSpec.commandPattern.test("codex exec --full") && qwenSpec.commandPattern.test("qwen chat"), "命令匹配按引擎词级隔离");
assert(cbSpec.commandPattern.test("/usr/local/bin/codebuddy run") && !cbSpec.commandPattern.test("mycodebuddy run"), "命令匹配词边界防前缀误撞");
assert(!codexSpec.commandPattern.test("codex-cli wrapper"), "词级匹配不吃连字符前缀变体");
const filtered = engineProcesses([{ pid: 1, command: "codex exec" }, { pid: 2, command: "qwen chat" }], codexSpec);
assert(filtered.length === 1 && filtered[0].pid === 1, "ps 快照按引擎 commandPattern 过滤");
assert(ENGINE_SCAN_SPECS.length === 5 && new Set(ENGINE_SCAN_SPECS.map((spec) => spec.engine)).size === 5, "五引擎注册表齐全无重复");

bridge.close();
rmSync(root, { recursive: true, force: true });
console.log("\nENGINE ROLLOUT TESTS PASSED");
