// 门控与解锁的实链证据：模型 glm-5.3 下，干净配置目录（模拟外部用户无 settings 兜底）
// ± CLAUDE_CODE_ENABLE_TODO_TOOLS=1 两组 spawn CLI，比对 init 消息 tools 数组中
// TaskCreate/TodoWrite 的存在性。运行：npx tsx scripts/spike-todo-tools.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeCliPath } from "../src/cli-path.js";

const TASK_TOOLS = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TodoWrite"];
// 双安装机器（如 /usr/local 旧 npm 版 + ~/.local 新原生版）resolveClaudeCliPath 可能命中
// 无开关旧版——CC_SPIKE_CLAUDE 显式指定可跑的目标 CLI；生产 relay 不受影响（resolve 顺序同 cli-path.ts）
const cliPath = process.env.CC_SPIKE_CLAUDE ?? resolveClaudeCliPath();
if (!cliPath) throw new Error("CLI 不可见：请从 relay 环境跑，或 CC_SPIKE_CLAUDE 显式指定");

async function probe(withEnv: boolean): Promise<string[]> {
  const cfgDir = mkdtempSync(join(tmpdir(), "cc-probe-"));
  try {
    const ac = new AbortController();
    const q = query({
      prompt: "hi",
      options: {
        model: "glm-5.3",
        cwd: cfgDir,
        pathToClaudeCodeExecutable: cliPath ?? undefined,
        env: {
          // 白名单式：CLI 活着必需的 PATH/HOME/凭据带上；配置目录隔离才是实验变量——
          // settings.json 的 env 兜底（含凭据与本机 TODO_TOOLS）不得泄入
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? "",
          ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "",
          CLAUDE_CONFIG_DIR: cfgDir,
          ...(withEnv ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } : {}),
        },
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        abortController: ac,
        stderr: (s) => console.error(`[cli-stderr ${withEnv ? "env组" : "干净组"}]`, s.slice(0, 300)),
      },
    });
    for await (const msg of q) {
      const m = msg as { type?: string; subtype?: string; tools?: string[] };
      if (m.type === "system" && m.subtype === "init") {
        ac.abort(); // init 即证据，不需要跑完回合
        return m.tools ?? [];
      }
    }
    return [];
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
}

const baseline = await probe(false);
const injected = await probe(true);
const fmt = (tools: string[]) => TASK_TOOLS.map((t) => `${t}:${tools.includes(t) ? "✓" : "✗"}`).join(" ");
console.log(`[无 env 注入]  ${fmt(baseline)}`);
console.log(`[env=1 注入]   ${fmt(injected)}`);
// 判定口径：Task 系列（TaskCreate/Get/Update/List）是调度准则与 task-store.ts 直读
// (~/.claude/tasks) 的工具，四件套齐全即解锁达标。TodoWrite 是 legacy 工具，该版本
// 独立门控（env=1 亦不出），不参与判定——仅记录展示
const GATE = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"];
const gateProven = GATE.every((t) => !baseline.includes(t));
const unlockProven = GATE.every((t) => injected.includes(t));
console.log(gateProven ? "✓ 门控复现：干净环境下 glm-5.3 无 Task 系列工具" : "! 门控未复现（baseline 已含任务工具，检查隔离）");
console.log(unlockProven ? "✓ 解锁验证：注入后 Task 系列四件套齐全" : "! 解锁未生效");
process.exit(gateProven && unlockProven ? 0 : 1);
