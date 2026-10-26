// #276 P0 环境根因层断言：install-hooks v2（本地副本挂载+cc-plugins 死路径改写）。
// 根因链实证（本套 C 段锚+回执记录）：
//   ① CLI 对 cc-plugins 绝对路径 hook 命令零执行（hook-debug 自 10-25 23:25 全静；
//      同机 ~/.claude/hooks 路径的 task-stop 16:11 仍写 .state——路径策略对照实证）
//   ② 插件 hook.mjs 文件本体完好（假家 E2E：diag+POST+沙盒 relay 落账 5 帧全通）
//   → 修法=挂载改走 ~/.claude/hooks 本地副本（install-hooks v2 单源分发+死路径改写）
// 直跑：cd relay && env -u CCR_ORG_DIR npx tsx scripts/test-hookmount.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("== B：install-hooks v2（fake HOME）==");
const FH = "/tmp/test-hookmount-home";
{
  rmSync(FH, { recursive: true, force: true });
  mkdirSync(join(FH, ".claude", "hooks"), { recursive: true });
  // 真实形态种：cc-plugins 死路径条目（bridge + deliver/guard 家族）+ 空 hooks 目录
  const deadCmd = (base: string) => `node "/Users/xdd/dev/cc-deck/cc-plugins/plugins/cc-deck/scripts/${base}"`;
  const seed = { hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: deadCmd("hook.mjs") }] }],
    Stop: [{ hooks: [{ type: "command", command: deadCmd("hook.mjs") }, { type: "command", command: deadCmd("deliver-stop.mjs") }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: deadCmd("deliver-guard.mjs") }] }, { hooks: [{ type: "command", command: deadCmd("guard-lifecycle.mjs") }] }],
  } };
  writeFileSync(join(FH, ".claude", "settings.json"), JSON.stringify(seed));
  const r = spawnSync(process.execPath, [join(root, "relay", "scripts", "install-hooks.mjs")], { env: { ...process.env, HOME: FH }, encoding: "utf8" });
  ok(r.status === 0, `B① installer 假家跑通（exit ${r.status}）`);
  type Entry = { hooks?: Array<{ command?: string }> };
  const after = JSON.parse(readFileSync(join(FH, ".claude", "settings.json"), "utf-8")) as { hooks?: Record<string, Entry[]> };
  let dead = 0, local = 0, evts = 0;
  for (const [k, v] of Object.entries(after.hooks ?? {})) {
    if (["Notification", "PostToolUse", "PreCompact", "PreToolUse", "SessionEnd", "Stop", "UserPromptSubmit"].includes(k)) evts++;
    for (const e of v) for (const h of e.hooks ?? []) {
      const c = h.command ?? "";
      if (c.includes("cc-plugins/plugins/cc-deck/scripts/")) dead++;
      if (c.includes("cc-bridge-hook.mjs")) local++;
    }
  }
  ok(dead === 0, `B② cc-plugins 死路径零残留（实 ${dead}）——#276 根因层收口`);
  ok(local >= 7, `B③ 六+PreCompact 事件全挂本地副本（实 ${local}）`);
  ok(evts === 7, `B④ 事件面齐（实 ${evts}，PreCompact 补挂）`);
  ok(existsSync(join(FH, ".claude", "hooks", "cc-bridge-hook.mjs")), "B⑤ cc-bridge-hook.mjs 单源副本在场");
  ok(
    existsSync(join(FH, ".claude", "hooks", "deliver-guard.mjs"))
      && existsSync(join(FH, ".claude", "hooks", "deliver-stop.mjs"))
      && existsSync(join(FH, ".claude", "hooks", "guard-lifecycle.mjs")),
    "B⑥ deliver/guard 救援副本在场（输出物回执链同批救活）",
  );
  ok(existsSync(join(FH, ".claude", "settings.json.bak-ccrelay")), "B⑦ settings.json 首次备份（可回滚）");
  const r2 = spawnSync(process.execPath, [join(root, "relay", "scripts", "install-hooks.mjs")], { env: { ...process.env, HOME: FH }, encoding: "utf8" });
  ok(r2.status === 0 && !/: 已添加/.test(r2.stdout), "B⑧ 幂等重跑零重复注册");
}

console.log("== C：静态锚 ==");
{
  const ih = readFileSync(join(root, "relay", "scripts", "install-hooks.mjs"), "utf-8");
  ok(ih.includes("cc-bridge-hook.mjs") && ih.includes("#276"), "C① v2 本地副本挂载策略在档");
  ok(ih.includes("rescueDeadEntries") && ih.includes("cc-plugins/plugins/cc-deck/scripts/"), "C② 死路径通用改写在档（bridge+deliver/guard 全家）");
  ok(ih.includes("turn-report"), "C③ turn-report 单源同步在档（Stop 外报链同修）");
  ok(ih.includes(".bak-ccrelay"), "C④ 备份约定在档");
}

console.log(`\n全部：${pass} ok / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
