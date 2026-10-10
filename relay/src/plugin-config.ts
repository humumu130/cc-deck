import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// #71 插件可选能力配置（019 §6.2）：~/.cc-deck/config.json 五键，hooks 侧
// guard-lib.mjs CONFIG_DEFAULTS 与 /api/plugin-config 端点共用。
// 从 ws-server.ts 拆出独立件（P71）：值守判定面（session-manager feedPM 产品门）
// 要读 duty 总闸——session-manager 不许反向依赖 ws-server（HTTP 面拖进底层依赖图），
// 故配置读写落此，ws-server re-export readPluginConfig 保 cloud-client 既有 import。
// 各键缺省值与 hooks 侧 guard-lib.mjs 的 CONFIG_DEFAULTS 一致。
// #71 第四键 deliverables：输出物看板总开关——关=三端隐藏「输出物」tab、
// guard-context 不注入投递约定；开=SNAPSHOT 下发 true + hook 注入约定 + deliver 脚本落位。
// #107 默认改开（#71 决策反转，用户 2026-09-20：默认关用户可能几个月都不知道有这
// 功能）；已显式写 false 的用户不受影响（下方 typeof 守卫：键存在才覆盖）。
// #71 第五键 duty（P71/019 §6.2/§6.5 拍板）：值守总闸（kill-switch 语义）——关=
// 全组停止值守 feed/自动派活；缺省 true（019 §6.4 六项默认生效基调+§6.3「已有显式
// false 的组不被迁移覆盖」同构：显式 false 才关，config 无键=开）。环境门
// CCR_PM_DUTY 仍须显式开（沙盒/既有测试缺省关零波及），两级同开才生效（§6.1）。
// W-CTXFIX 第六键 preCompactSummary（2026-10-10）：压缩前任务摘要看门狗总闸
//（relay/src/context-watchdog.ts 链路）——关=托管会话水位到阈值不发摘要指令、
// 不注回；缺省 true（用户拍板：默认开启、设置域可关）。relay 侧专属键，hooks 侧
// guard-lib CONFIG_DEFAULTS 不含（同 duty 先例）。
export const PLUGIN_CFG_KEYS = ["taskGuard", "qNotify", "restorePoint", "deliverables", "duty", "preCompactSummary"] as const;
export type PluginConfig = { taskGuard: boolean; qNotify: boolean; restorePoint: boolean; deliverables: boolean; duty: boolean; preCompactSummary: boolean };
// 测试缝（P71）：缺省 ~/.cc-deck/config.json；CCR_CONFIG_FILE 注入后读写全落指定
// 文件——值守产品门测试绝不触生产配置（同 CCR_DATA_DIR/CCR_ORG_DIR 隔离范式）
export function pluginConfigPath(): string {
  return process.env.CCR_CONFIG_FILE ?? join(homedir(), ".cc-deck", "config.json");
}
// 导出供 cloud-client 云通道 SNAPSHOT 同源携带（手机走云桥也要拿到开关）+
// session-manager feedPM 产品门（P71）读取
export function readPluginConfig(): PluginConfig {
  const out: PluginConfig = { taskGuard: false, qNotify: true, restorePoint: false, deliverables: true, duty: true, preCompactSummary: true };
  try {
    const raw = JSON.parse(readFileSync(pluginConfigPath(), "utf-8")) as Record<string, unknown>;
    for (const k of PLUGIN_CFG_KEYS) if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
  } catch {}
  return out;
}
