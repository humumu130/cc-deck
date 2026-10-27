#!/usr/bin/env node
// 把 relay/hooks/bridge-hook.mjs 装入 ~/.claude/settings.json 六事件（幂等，含备份）
// 结构与本机验证版一致；PreToolUse 带 timeout 620（远程审批最长挂 600s）
//
// #276 P0 根修（1026 实锤）：CLI（Claude Code 2.1.x）不再执行指向 cc-plugins 安装目录
// 绝对路径的 hook 命令（~/.claude/hooks/ 内的照常执行——task-stop/task-context 同机对照
// 实证；插件路径 hook.mjs 自 10-25 23:25 起零触发，全机外部会话桥接/审批/定位断链，
// relay 重启后活会话永不重接管）。修法=挂载改走 ~/.claude/hooks 本地副本：
//   ① bridge-hook 单源拷贝为 ~/.claude/hooks/cc-bridge-hook.mjs（内容比对幂等）
//   ② turn-report.mjs 单源（仓根 scripts/hooks/）同拷（本机该文件曾缺失=Stop 外报 404）
//   ③ settings.json 存量 cc-plugins 路径条目（hook.mjs/deliver-guard/deliver-stop/
//      guard-lifecycle——输出物回执链同批死）一律改写指向本地副本；文件随之拷贝
//   ④ 六事件注册指向本地副本（新装/已装 bridge-hook 均归一到该路径）
// 运行本脚本即生产止血（本机 ~/.claude 侧；不动 relay 进程）。备份 .bak-ccrelay（首次）。
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const selfDir = dirname(fileURLToPath(import.meta.url));
const bridgeHookSrc = join(selfDir, "..", "hooks", "bridge-hook.mjs").replace(/\\/g, "/");
const turnReportSrc = join(selfDir, "..", "..", "scripts", "hooks", "turn-report.mjs").replace(/\\/g, "/");
// 插件脚本目录（cc-plugins 死路径条目的文件来源；仓内同名件兜底）
const pluginScriptsDir = join(selfDir, "..", "..", "cc-plugins", "plugins", "cc-deck", "scripts");
const hooksDir = join(homedir(), ".claude", "hooks");
const settingsPath = join(homedir(), ".claude", "settings.json");
const localBridgeHook = join(hooksDir, "cc-bridge-hook.mjs");
// cc-plugins 安装目录条目的改写目标识别（同机可能多部署，前缀匹配）
const DEAD_PREFIX = "cc-plugins/plugins/cc-deck/scripts/";

let cfg = {};
try {
  cfg = JSON.parse(readFileSync(settingsPath, "utf-8"));
} catch {
  if (existsSync(settingsPath)) throw new Error(`settings.json 解析失败：${settingsPath}`);
}
cfg.hooks ??= {};

const backup = settingsPath + ".bak-ccrelay";
if (existsSync(settingsPath) && !existsSync(backup)) copyFileSync(settingsPath, backup);

mkdirSync(hooksDir, { recursive: true });

// ---- ①② 单源拷贝（内容一致跳过，幂等） ----
let copied = 0;
function syncFile(src, dst) {
  if (!existsSync(src)) return false;
  let same = false;
  try { same = existsSync(dst) && readFileSync(dst, "utf-8") === readFileSync(src, "utf-8"); } catch { same = false; }
  if (!same) { copyFileSync(src, dst); copied++; console.log(`+ ${basename(dst)} → ${dst}`); }
  return true;
}
syncFile(bridgeHookSrc, localBridgeHook);
syncFile(turnReportSrc, join(hooksDir, "turn-report.mjs"));
if (!existsSync(localBridgeHook)) {
  // 仓源不在（如独立安装布局）：退回插件副本作拷贝源（自救）
  syncFile(join(pluginScriptsDir, "hook.mjs"), localBridgeHook);
}

// ---- ③ 存量 cc-plugins 死路径条目改写（deliver/guard 家族同批救活） ----
function rescueDeadEntries() {
  let rescued = 0;
  for (const entries of Object.values(cfg.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        const cmd = typeof h.command === "string" ? h.command : "";
        const m = cmd.match(/"([^"]*\/cc-plugins\/plugins\/cc-deck\/scripts\/[^"]+\.mjs)"/) ?? cmd.match(/(\S*cc-plugins\/plugins\/cc-deck\/scripts\/\S+\.mjs)/);
        if (!m) continue;
        const base = basename(m[1]);
        const local = join(hooksDir, base === "hook.mjs" ? "cc-bridge-hook.mjs" : base);
        // 本地副本在场或可补（插件目录/仓内同名件）
        if (!existsSync(local)) {
          const src = existsSync(join(pluginScriptsDir, base)) ? join(pluginScriptsDir, base) : join(hooksDir, base);
          if (!existsSync(src)) { console.log(`! 无法救活 ${base}（来源缺失），条目保留原样`); continue; }
          copyFileSync(src, local);
          copied++;
          console.log(`+ ${basename(local)} → ${local}（死路径救援拷贝）`);
        }
        h.command = cmd.replace(m[1], local);
        rescued++;
      }
    }
  }
  if (rescued) console.log(`~ settings.json：${rescued} 条 cc-plugins 死路径条目改写为本地副本`);
  return rescued;
}
const rescued = rescueDeadEntries();

// ---- ④ 六事件注册（指向本地副本；已挂 bridge-hook 任意形态则归一） ----
const EVENTS = {
  Notification: {},
  PostToolUse: { matcher: "*" },
  PreCompact: {},
  PreToolUse: { matcher: "*", timeout: 620 },
  SessionStart: {}, // #279 野生会话广播：会话启动注入 cc-deck 在场声明（hook 内 2s 快速通道）
  SessionEnd: {},
  Stop: {},
  UserPromptSubmit: {},
};

let changed = 0;
for (const [event, extra] of Object.entries(EVENTS)) {
  cfg.hooks[event] ??= [];
  const already = cfg.hooks[event].some(
    (e) => (e.hooks ?? []).some((h) => (h.command ?? "").includes("cc-bridge-hook.mjs") || (h.command ?? "").includes("bridge-hook.mjs")),
  );
  if (already) { console.log(`= ${event}: 已有 bridge-hook，跳过`); continue; }
  cfg.hooks[event].push({
    hooks: [{ type: "command", command: `node "${localBridgeHook}"`, ...extra }],
    ...(extra.matcher ? { matcher: extra.matcher } : {}),
  });
  changed++;
  console.log(`+ ${event}: 已添加`);
}

writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");

console.log(`\n完成（新增 ${changed} 项，改写死路径 ${rescued} 条，拷贝 ${coped(copied)}）。hook 路径：${localBridgeHook}`);
if (changed > 0) console.log(`备份：${backup}（仅首次创建）`);
console.log("注意：已运行的 Claude Code 会话不会热加载 hooks，需新开会话生效。");
function coped(n) { return `${n} 个文件`; }
