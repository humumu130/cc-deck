#!/usr/bin/env node
// CC Deck 插件 · 输出物收工兜底（#203，2026-09-25 用户拍板进插件）：
// 会话 Stop 时对账——本会话写过文档类文件（deliver-guard 随手记账）但输出物
// 看板还没有本会话任何登记 → 拦截一次，提醒 AI 自查补登记
// （~/.cc-deck/bin/deliver <绝对路径>，在哪个目录执行都行）；60 秒内第二次停止
// 放行并给这批文件盖章（同批不再提醒，后续只追新增）。
//
// 设计边界（#69 废除的启发式不回潮）：
//  · 不自动登记、不猜「什么是交付物」——只列出写过的文档类文件，判断留给 AI；
//  · docs/ 下的写入已被 deliver-guard 自动登记 → 看板有 sid 条目 → 天然豁免，
//    本提醒只覆盖 docs/ 之外（或自动登记失败）的漏网；
//  · 看板零登记的判定 = deliverables.json 无 e.sid === 本会话（注册即命中，
//    与 deliver CLI 的 cwd 前缀匹配无关）。
// 静默放行：非桥接会话 / deliverables 开关关 / deliver 脚本不在（未装 relay）/
// 账本为空或文件已删光 / 看板已有本会话条目。全程异常静默 exit 0，绝不卡收工。
// 独立 60s 窗口（不与 guard-stop 共享 guard-pass 文件：两个 Stop hook 并挂时
// 各自消费同一窗口会互删误拦，见 guard-lib consumeDeliverPassWindow 注释）。
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  readConfig, readCliPid,
  pendingDeliverWatch, ackDeliverWatch, clearDeliverWatch, consumeDeliverPassWindow,
} from "./guard-lib.mjs";

const input = (() => {
  try {
    return JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return {};
  }
})();

// relay 自拉的 CLI 子进程不桥接也不守卫（与 guard-stop 同口径）
if (process.env.CCR_RELAY_CHILD) process.exit(0);

const sid = String(input.session_id || "");
if (!sid) process.exit(0);

// 作用域守卫：未桥接会话（cli-pids.json 无本 sid）静默退出——deliver 登记靠桥接
// 会话匹配，未桥接时登记必失败，提醒只会空转
if (!readCliPid(sid)) process.exit(0);

const cfg = readConfig();
if (!cfg.deliverables) process.exit(0);

const deckDir = join(homedir(), ".cc-deck");
if (!existsSync(join(deckDir, "bin", "deliver"))) process.exit(0);

// 待提醒 = 已记账 − 已盖章 − 文件已不存在（写完又删的是草稿，不值得唠叨）
let files = pendingDeliverWatch(sid).filter((p) => {
  try { return existsSync(p); } catch { return false; }
});
if (!files.length) process.exit(0);

// 看板对账（逐文件）：本会话已登记的路径不再追——docs/ 自动登记、AI 手动 deliver
// 都会把 path 写进 deliverables.json，按 sid + 路径归一比对应付「部分登记」的中间态
// （3 个写了 2 个登记过 → 只提醒剩下的 1 个，不整批豁免）。路径归一同 relay #203：
// resolve + realpath 回落——/tmp 与 /private/tmp 两种形态不打架。看板读不到
// （relay 首启前/文件损坏）当零登记继续提醒，二停放行兜底
try {
  const list = JSON.parse(readFileSync(join(deckDir, "data", "deliverables.json"), "utf-8"));
  if (Array.isArray(list)) {
    const norm = (x) => {
      const r = resolve(x || ".");
      try { return realpathSync(r); } catch { return r; }
    };
    const registered = new Set(
      list.filter((e) => e && e.sid === sid && typeof e.path === "string").map((e) => norm(e.path)),
    );
    const remain = files.filter((p) => !registered.has(norm(p)));
    if (!remain.length) {
      clearDeliverWatch(sid);
      process.exit(0);
    }
    files = remain;
  }
} catch {}

// 60s 二次放行：窗口内第二次停止 = 用户/AI 明确「这批不是交付物」→ 盖章放行
if (consumeDeliverPassWindow(sid)) {
  ackDeliverWatch(sid, files);
  process.exit(0);
}

// 拦截：stderr 提示（exit 2 = 阻断 Stop，同 guard-stop 惯例）
const lines = files.slice(0, 6).map((p) => "- " + p).join("\n");
const more = files.length > 6 ? `\n…另有 ${files.length - 6} 个` : "";
console.error(
  `【输出物兜底】本会话写过 ${files.length} 个文档类文件，输出物看板还没有本会话的登记：\n` +
  `${lines}${more}\n` +
  `若其中有用户要的交付物：执行 ~/.cc-deck/bin/deliver <文件绝对路径> 逐个补登记。\n` +
  `若都不是交付物（内部草稿/笔记等）：忽略即可，60 秒内再次停止即放行（同批文件不再提醒）。`,
);
process.exit(2);
