// #17 雇员独立家设置（产品层）：data/settings.json 单键持久化。
// 优先级（高→低）：CCR_EMPLOYEE_CONFIG_DIR 显式 env（部署覆盖面，锁定设置项）
//   > settings.json（用户面，三端设置 UI 读写）> 默认值。
// 默认值策略（用户 2026-09-28 拍板）：新装默认开（全新环境零迁移负担）；
// 存量升级默认关（行为不变，UI 引导后再开——开启只影响新会话，存量会话按
// 创建时记录的家走，无需迁移）。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEmployeeConfigDir } from "./config.js";

export interface RelaySettings {
  employeeHome: boolean;
}

/** 最终生效的雇员独立家状态（SNAPSHOT/设置页数据源） */
export interface EmployeeHomeState {
  /** 开关是否生效（env 或文件任一开启且可解析） */
  enabled: boolean;
  /** 实际家路径；关闭时 null */
  value: string | null;
  /** 生效来源：env=环境变量锁定（UI 只读）；file=设置文件；default=新装/存量推导 */
  source: "env" | "file" | "default";
}

const SETTINGS_FILE = "settings.json";

export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE);
}

export function readSettingsFile(dataDir: string): RelaySettings | null {
  const p = settingsPath(dataDir);
  if (!existsSync(p)) return null; // 无文件=未表态（落 default 层），与损坏区分
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<RelaySettings>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    return { employeeHome: raw.employeeHome === true };
  } catch (e) {
    // 审查修正（边界 P2-1）：半写/损坏不再静默按「无文件」处理——一行 warn 保住
    // 可诊断性（失败方向安全：default 层存量=关）
    console.warn(`[settings] ${SETTINGS_FILE} 读取失败（按未配置处理）: ${(e as Error).message}`);
    return null;
  }
}

export function writeSettingsFile(dataDir: string, s: RelaySettings): boolean {
  // 审查修正（边界 P2-1）：tmp+rename 原子换名——直写 truncate-then-write 崩在半路
  // 会留半文件，下次启动静默翻 default 层；原子写失败时原文件不动。
  // 合并读原始 JSON（非 readSettingsFile——后者只回 employeeHome）：未来 settings
  // 加第二键时一次开关切换不抹兄弟键。
  try {
    const p = settingsPath(dataDir);
    let prev: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) prev = raw as Record<string, unknown>;
    } catch {} // 无文件/损坏：按空合并（写侧不告警，读侧已 warn）
    const merged = { ...prev, ...s };
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8");
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

// 新装判定：dataDir 无任何 relay 自产持久痕迹（事件流/桥令牌/设置文件）。
// 首启生成的 bridge-token 是「至少跑过一次」的最强信号；events.ndjson 是
// 「至少有过一个会话」。两者皆无 = 全新环境。
export function isFreshInstall(dataDir: string): boolean {
  return !existsSync(join(dataDir, "events.ndjson")) &&
    !existsSync(join(dataDir, "bridge-token")) &&
    !existsSync(join(dataDir, "token")) &&
    !existsSync(settingsPath(dataDir));
}

// 默认值：新装开 / 存量关（见文件头策略）。freshInstall 为启动序预算值（见
// resolveEmployeeHome 注释），缺省时现算（测试/工具路径）
export function defaultSettings(dataDir: string, freshInstall?: boolean): RelaySettings {
  return { employeeHome: freshInstall ?? isFreshInstall(dataDir) };
}

/** 三层合成（每次现算，无缓存——热切换后立即反映）。
 * freshInstall：启动序预算的「新装」标志（loadConfig 在写 token/bridge-token 之前
 * 捕获——首启那两个文件已落盘，事后现算恒为存量；审查修正 P1）。运行期调用
 * （applyEmployeeHome/SNAPSHOT）不传：首靴已把 default 决定物化进 settings.json，
 * 不会再落 default 层。 */
export function resolveEmployeeHome(dataDir: string, freshInstall?: boolean): EmployeeHomeState {
  const envRaw = (process.env.CCR_EMPLOYEE_CONFIG_DIR ?? "").trim();
  const fromEnv = parseEmployeeConfigDir(envRaw, dataDir);
  if (fromEnv !== null || envRaw !== "") {
    // env 显式设置（含「设了但非法」——按关闭处理但来源仍是 env，UI 锁定只读）
    return { enabled: fromEnv !== null, value: fromEnv, source: "env" };
  }
  const file = readSettingsFile(dataDir);
  if (file) {
    return {
      enabled: file.employeeHome,
      value: file.employeeHome ? parseEmployeeConfigDir("auto", dataDir) : null,
      source: "file",
    };
  }
  const def = defaultSettings(dataDir, freshInstall);
  return {
    enabled: def.employeeHome,
    value: def.employeeHome ? parseEmployeeConfigDir("auto", dataDir) : null,
    source: "default",
  };
}
