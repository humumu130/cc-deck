#!/usr/bin/env node
// 把 relay/hooks/bridge-hook.mjs 装入 ~/.claude/settings.json 六事件（幂等，含备份）
// 结构与本机验证版一致；PreToolUse 带 timeout 620（远程审批最长挂 600s）
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "bridge-hook.mjs")
  .replace(/\\/g, "/");
const settingsPath = join(homedir(), ".claude", "settings.json");

let cfg = {};
try {
  cfg = JSON.parse(readFileSync(settingsPath, "utf-8"));
} catch {
  if (existsSync(settingsPath)) throw new Error(`settings.json 解析失败：${settingsPath}`);
}
cfg.hooks ??= {};

const EVENTS = {
  Notification: {},
  PostToolUse: { matcher: "*" },
  PreToolUse: { matcher: "*", timeout: 620 },
  SessionEnd: {},
  Stop: {},
  UserPromptSubmit: {},
};

const backup = settingsPath + ".bak-ccrelay";
if (existsSync(settingsPath) && !existsSync(backup)) copyFileSync(settingsPath, backup);

let changed = 0;
for (const [event, extra] of Object.entries(EVENTS)) {
  cfg.hooks[event] ??= [];
  const already = cfg.hooks[event].some(
    (e) => (e.hooks ?? []).some((h) => (h.command ?? "").includes("bridge-hook.mjs")),
  );
  if (already) {
    console.log(`= ${event}: 已有 bridge-hook，跳过`);
    continue;
  }
  cfg.hooks[event].push({
    hooks: [{ type: "command", command: `node ${hookPath}`, ...extra }],
    ...(extra.matcher ? { matcher: extra.matcher } : {}),
  });
  changed++;
  console.log(`+ ${event}: 已添加`);
}

writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
console.log(`\n完成（新增 ${changed} 项）。hook 路径：${hookPath}`);
if (changed > 0) console.log(`备份：${backup}（仅首次创建）`);
console.log("注意：已运行的 Claude Code 会话不会热加载 hooks，需新开会话生效。");
