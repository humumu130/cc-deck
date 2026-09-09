#!/usr/bin/env node
// CC Deck 插件 · Stop 守卫（仅在桥接会话上生效，见 guard-lib 桥接登记守卫）：
//  组件一 taskGuard（默认关）：存在可执行待办（[搁置]/[常驻]/parked 豁免、blockedBy
//    失效依赖忽略）→ 拦截收工提示继续；60 秒内第二次停止放行（蓝本
//    ~/.claude/hooks/task-stop.mjs 的简化版：去 [待确认] 横幅与 git 滞后检测）
//  组件三 restorePoint（默认关）：放行前把未完成任务清单写入项目目录
//    .cc-deck/state.md（下次会话由 guard-context 注入接续提示）
//  组件二 qNotify 依赖：放行把回合状态机置闲、拦截保持忙碌（判「忙碌中插入提问」）
// 全程异常静默 exit 0，绝不因守卫故障卡住收工。
import { readFileSync } from "node:fs";
import {
  readConfig, readCliPid, readTasks, writeTurn,
  consumePassWindow, clearPassWindow, writeRestore, removeRestore,
} from "./guard-lib.mjs";

const input = (() => {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return {};
  }
})();

// relay 自拉的 CLI 子进程不桥接也不守卫（与 bridge-hook 同口径）
if (process.env.CCR_RELAY_CHILD) process.exit(0);

const sid = String(input.session_id || "");
const cwd = String(input.cwd || "");
if (!sid) process.exit(0);

// 作用域守卫：未桥接会话（cli-pids.json 无本 sid）静默退出
const pid = readCliPid(sid);
if (!pid) process.exit(0);

const cfg = readConfig();
if (!cfg.taskGuard && !cfg.qNotify && !cfg.restorePoint) process.exit(0);

const tasks = cfg.taskGuard || cfg.restorePoint ? readTasks(sid) : [];

// 放行统一出口：恢复点落盘（有遗留才写，无遗留清掉旧文件）+ 回合置闲
const pass = () => {
  if (cfg.restorePoint) {
    if (tasks.length) writeRestore(cwd, sid, tasks);
    else removeRestore(cwd);
  }
  if (cfg.qNotify) writeTurn(sid, false, pid);
  process.exit(0);
};

if (!cfg.taskGuard || tasks.length === 0) {
  if (cfg.taskGuard) clearPassWindow(sid); // 清残留时间戳，防下次 60s 窗口误放行
  pass();
}

// 60s 二次放行：第一次拦截写时间戳，窗口内第二次停止读后删除并放行
if (consumePassWindow(sid)) pass();

// 拦截：保持忙碌（CLI 会被迫继续回合），stderr 提示（exit 2 = 阻断 Stop）
if (cfg.qNotify) writeTurn(sid, true, pid);
const lines = tasks.slice(0, 8).map((t) => `- #${t.id} ${t.subject}${t.status === "in_progress" ? "（进行中）" : ""}`);
const more = tasks.length > 8 ? `\n…另有 ${tasks.length - 8} 条` : "";
console.error(
  `【任务清单纪律】还有 ${tasks.length} 条可执行待办（搁置/常驻已豁免）：\n${lines.join("\n")}${more}\n` +
    `按 FIFO 继续执行下一条；确需收工（等待用户/被阻塞）请在 60 秒内再次停止即放行。`,
);
process.exit(2);
