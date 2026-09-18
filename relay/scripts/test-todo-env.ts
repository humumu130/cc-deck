// todo-tools-env 单测：CLAUDE_CONFIG_DIR 指临时目录，六个用例覆盖补写全语义。
// 运行：npm run test:todo-env（tsx scripts/test-todo-env.ts）
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? "ok" : "FAIL"} - ${msg}`);
  if (!cond) failed++;
}

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "todo-env-"));
  process.env.CLAUDE_CONFIG_DIR = d;
  return d;
}

// ① 目录不存在 → skip-no-dir，不创建任何东西
{
  const d = freshDir();
  rmSync(d, { recursive: true, force: true });
  const { ensureTodoToolsEnv } = await import("../src/todo-tools-env.js");
  check(ensureTodoToolsEnv() === "skip-no-dir", "① no dir → skip-no-dir");
}

// ② 目录存在、settings.json 不存在 → written 且创建合法 JSON
{
  const d = freshDir();
  const { ensureTodoToolsEnv, TODO_TOOLS_ENV_KEY } = await import("../src/todo-tools-env.js");
  const r = ensureTodoToolsEnv();
  const parsed = JSON.parse(readFileSync(join(d, "settings.json"), "utf-8"));
  check(r === "written" && parsed.env[TODO_TOOLS_ENV_KEY] === "1", "② missing file → written + valid JSON");
}

// ③ 已有 settings 无该键 → written，且原有键完整保留
{
  const d = freshDir();
  const orig = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://x" }, model: "glm-5.3" });
  writeFileSync(join(d, "settings.json"), orig);
  const { ensureTodoToolsEnv } = await import("../src/todo-tools-env.js");
  const r = ensureTodoToolsEnv();
  const parsed = JSON.parse(readFileSync(join(d, "settings.json"), "utf-8"));
  check(
    r === "written" && parsed.env.ANTHROPIC_BASE_URL === "https://x" && parsed.model === "glm-5.3",
    "③ existing file → written + original keys preserved",
  );
}

// ④ 键已存在（含显式 "0"）→ present，文件字节不动
{
  const d = freshDir();
  const orig = JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" } }, null, 2);
  writeFileSync(join(d, "settings.json"), orig);
  const { ensureTodoToolsEnv } = await import("../src/todo-tools-env.js");
  const before = readFileSync(join(d, "settings.json"), "utf-8");
  const r = ensureTodoToolsEnv();
  check(r === "present" && readFileSync(join(d, "settings.json"), "utf-8") === before, "④ explicit value → present, untouched");
}

// ⑤ 坏 JSON → skip-bad-json，原文件不动
{
  const d = freshDir();
  writeFileSync(join(d, "settings.json"), "{ broken");
  const { ensureTodoToolsEnv } = await import("../src/todo-tools-env.js");
  const r = ensureTodoToolsEnv();
  check(r === "skip-bad-json" && readFileSync(join(d, "settings.json"), "utf-8") === "{ broken", "⑤ bad JSON → skip, file intact");
}

// ⑥ env 字段是非对象 → skip-bad-json
{
  const d = freshDir();
  writeFileSync(join(d, "settings.json"), JSON.stringify({ env: "oops" }));
  const { ensureTodoToolsEnv } = await import("../src/todo-tools-env.js");
  check(ensureTodoToolsEnv() === "skip-bad-json", "⑥ env non-object → skip-bad-json");
}

delete process.env.CLAUDE_CONFIG_DIR;
if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall todo-env checks passed");
