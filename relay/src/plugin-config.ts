import { readFileSync, readdirSync } from "node:fs";
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
// W-EXPP1 第七键 experience（2026-10-10）：团队经验库总闸（relay/src/experience.ts，
// 设计 §7.1 ARCH M3）——关=注入停 + GC 停 + worker 回执「经验：」自动申报捕获停，
// 零残留（deliverables 键同款语义；M12-4 收口自动账本就不经经验库、无需停写）。
// 缺省 true（#107 决策反转先例：默认关用户几个月发现不了）；用户 CLI 直写
//（org exp append）不拦——显式人为意图不受自动面总闸连坐。
// W-RULES1 第八键 rules（2026-10-11）：团队规则库总闸（relay/src/team-rules.ts，拍板
// verdict-rules-20261011）——关=派单规则注入停零残留；用户 CLI 直写（org rule append）
// 不拦（experience 键同款语义）。缺省 true（#107 先例）。relay 侧专属键，hooks 侧
// guard-lib CONFIG_DEFAULTS 不含（duty/preCompactSummary 同款）。
// W-KWP2 第九键 workerPlugins（2026-10-11）：托管雇员会话插件通路总闸（B 路 B1 打通，
// relay/src/agent-adapter.ts query options plugins 通路）——关=雇员会话不注入任何显式
// 插件（维持 KWP 前现状）；开=额外加载 workerPluginsDir() 目录下的插件（目录即清单，
// KWP「目录即声明」同款范式：放目录=授权 worker 用，删=撤权）。**缺省 false**（本键
// 是权限面扩大开关：插件可带 hooks=任意代码执行面，与 #107 默认开先例相反——拍板
// 红线「默认关，配置显式开才生效」优先于 #107 惯例）。仅作用雇员会话（session-manager
// newAgent 按 state.employee 守卫），非 Claude 引擎零波及；用户自己建的会话不受此键
// 影响（其插件面走各自 config 家的常规加载）。relay 侧专属键，hooks 侧 guard-lib
// CONFIG_DEFAULTS 不含。
export const PLUGIN_CFG_KEYS = ["taskGuard", "qNotify", "restorePoint", "deliverables", "duty", "preCompactSummary", "experience", "rules", "workerPlugins"] as const;
export type PluginConfig = { taskGuard: boolean; qNotify: boolean; restorePoint: boolean; deliverables: boolean; duty: boolean; preCompactSummary: boolean; experience: boolean; rules: boolean; workerPlugins: boolean };
// 测试缝（P71）：缺省 ~/.cc-deck/config.json；CCR_CONFIG_FILE 注入后读写全落指定
// 文件——值守产品门测试绝不触生产配置（同 CCR_DATA_DIR/CCR_ORG_DIR 隔离范式）
export function pluginConfigPath(): string {
  return process.env.CCR_CONFIG_FILE ?? join(homedir(), ".cc-deck", "config.json");
}
// 导出供 cloud-client 云通道 SNAPSHOT 同源携带（手机走云桥也要拿到开关）+
// session-manager feedPM 产品门（P71）读取
export function readPluginConfig(): PluginConfig {
  const out: PluginConfig = { taskGuard: false, qNotify: true, restorePoint: false, deliverables: true, duty: true, preCompactSummary: true, experience: true, rules: true, workerPlugins: false };
  try {
    const raw = JSON.parse(readFileSync(pluginConfigPath(), "utf-8")) as Record<string, unknown>;
    for (const k of PLUGIN_CFG_KEYS) if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
  } catch {}
  return out;
}

// ---------- W-KWP2 件一：worker 插件清单（B 路 B1）----------
// 目录即清单：workerPluginsDir() 下每个子目录 = 一个插件（标准 Claude Code 插件形态，
// 含 .claude-plugin/plugin.json），以显式 local path 注入雇员会话 query options——
// 与雇员独立家（CLAUDE_CONFIG_DIR）正交：显式路径加载不经 marketplace/config 安装
// 体系，雇员家没装过也生效（B1 断点②的根治点）。总闸（workerPlugins 键）关=恒空。
// 沙盒缝：CCR_WORKER_PLUGINS_DIR 覆盖目录（CCR_CONFIG_FILE 同款隔离范式）。

/** worker 插件清单目录（缺省 ~/.cc-deck/worker-plugins） */
export function workerPluginsDir(): string {
  return process.env.CCR_WORKER_PLUGINS_DIR ?? join(homedir(), ".cc-deck", "worker-plugins");
}

/**
 * 雇员会话应注入的插件绝对路径清单（总闸关/目录不存在/目录空 → []）。
 * 只收目录形态条目（.DS_Store 等散文件忽略——目录即声明的字面义）；不校验插件内
 * 合法性（.claude-plugin/plugin.json 缺失时 CLI 侧自会报无效插件，本层不做二次
 * 猜测——扫描面保持纯形状）。任何 IO 异常吞为 []（插件面绝不阻断会话创建主路径，
 * experience.ts 注入降级同款口径）。
 */
export function listWorkerPluginPaths(): string[] {
  if (!readPluginConfig().workerPlugins) return [];
  try {
    return readdirSync(workerPluginsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(workerPluginsDir(), d.name))
      .sort();
  } catch {
    return [];
  }
}
