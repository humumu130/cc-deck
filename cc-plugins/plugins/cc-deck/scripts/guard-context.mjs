#!/usr/bin/env node
// CC Deck 插件 · UserPromptSubmit 守卫（仅在桥接会话上生效，见 guard-lib 桥接登记守卫）：
//  组件一 taskGuard（默认关）：注入当前待办摘要 + 一行分诊纪律
//    「新任务立即入单 / 完成即关 / 纯问答不入单」（蓝本 task-context.mjs 简化版：
//    去 [待确认] 前排与任务面板滞后检测）
//  组件二 qNotify（默认开）：会话忙碌期间用户插入提问（回合状态机忙碌 + CLI 进程
//    仍存活，即上一事件是 prompt 而非放行的 Stop）→ POST 本机 relay
//    /api/notify mode=confirm（各端通知悬浮框弹「插入的提问已排队」——不露内部
//    机制措辞，2026-09-10 用户纠错：旧文案「用户插入提问（滚动防丢）」泄露实现术语）
//  组件三 restorePoint（默认关）：项目目录存在 24h 内、非本会话写入的
//    .cc-deck/state.md → 注入一行「上次会话遗留待办」提示并消费该文件（只注入一次）
// stdout 整块注入上下文；通知 POST 与本地读取并行、最后收尾 await；异常全程静默。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  readConfig, readCliPid, isPidAlive, readTasks, readTurn, writeTurn,
  readRestore, restoreInjectable, removeRestore,
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

// ---- 组件二：忙碌中插入提问 → 手机弹通知框（先发射，与下方本地读取并行） ----
let notify = null;
if (cfg.qNotify) {
  const turn = readTurn(sid);
  const busy = turn.busy && isPidAlive(turn.pid || pid);
  if (busy) notify = notifyInsert(sid);
  writeTurn(sid, true, pid); // 本条 prompt 开启新回合：忙碌置位（Stop 放行才置闲）
}

const out = [];

// ---- 组件三：上次会话遗留待办（一次性注入后消费） ----
if (cfg.restorePoint && cwd) {
  const st = readRestore(cwd);
  if (restoreInjectable(st, sid)) {
    const items = [...st.text.matchAll(/^- (#.+)$/gm)].slice(0, 3).map((m) => m[1].trim());
    const brief = items.length ? items.join("；") : "见 .cc-deck/state.md";
    out.push(`【上次会话遗留待办】${brief} —— 建议先 TaskCreate 重建这些条目再开工（详见项目目录 .cc-deck/state.md）。`);
    removeRestore(cwd); // 只提示一次：注入即消费，防每条消息重复刷屏
  }
}

// ---- 组件一：当前待办摘要 + 分诊纪律 ----
if (cfg.taskGuard) {
  const tasks = readTasks(sid);
  if (tasks.length) {
    const lines = tasks.slice(0, 10).map((t) => `- #${t.id} ${t.subject}${t.status === "in_progress" ? "（进行中）" : ""}`);
    const more = tasks.length > 10 ? `\n…另有 ${tasks.length - 10} 条` : "";
    out.push(
      `【待办提醒|${tasks.length} 条】新消息先分诊：新任务立即 TaskCreate 入单 / 补充更新对应条目 / 纯问答直接答；完成即关。\n${lines.join("\n")}${more}`,
    );
  } else {
    out.push("【待办提醒|0 条】新任务立即入单 / 完成即关 / 纯问答不入单。");
  }
}

if (out.length) console.log(out.join("\n"));
if (notify) await notify; // 等 POST 收尾再退（≤1.5s），防进程先退掐断请求
process.exit(0);

// POST 本机 relay /api/notify（LAN token 在 data/token；端口在 data/bridge.json）。
// mode=confirm 复用现有黄框 [待确认] 通知链路；session_id 用 relay 外部会话 id（ext-<sid>）。
async function notifyInsert(sidRaw) {
  try {
    const dataDir = join(homedir(), ".cc-deck", "data");
    const b = JSON.parse(readFileSync(join(dataDir, "bridge.json"), "utf-8"));
    const lanToken = readFileSync(join(dataDir, "token"), "utf-8").trim();
    const body = JSON.stringify({
      mode: "confirm",
      session_id: "ext-" + sidRaw,
      text: "你在电脑上插入的提问已排队，当前回合结束后处理",
    });
    const res = await Promise.race([
      fetch(`http://127.0.0.1:${b.port}/api/notify?token=${encodeURIComponent(lanToken)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
    ]);
    void res;
  } catch {}
}
