// #17 雇员独立家设置（产品层）：data/settings.json 单键持久化。
// 优先级（高→低）：CCR_EMPLOYEE_CONFIG_DIR 显式 env（部署覆盖面，锁定设置项）
//   > settings.json（用户面，三端设置 UI 读写）> 默认值。
// 默认值策略（用户 2026-09-28 拍板）：新装默认开（全新环境零迁移负担）；
// 存量升级默认关（行为不变，UI 引导后再开——开启只影响新会话，存量会话按
// 创建时记录的家走，无需迁移）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  try {
    const raw = JSON.parse(readFileSync(settingsPath(dataDir), "utf-8")) as Partial<RelaySettings>;
    return { employeeHome: raw.employeeHome === true };
  } catch {
    return null;
  }
}

export function writeSettingsFile(dataDir: string, s: RelaySettings): boolean {
  try {
    writeFileSync(settingsPath(dataDir), JSON.stringify(s, null, 2), "utf-8");
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

// 默认值：新装开 / 存量关（见文件头策略）
export function defaultSettings(dataDir: string): RelaySettings {
  return { employeeHome: isFreshInstall(dataDir) };
}

/** 三层合成（每次现算，无缓存——热切换后立即反映） */
export function resolveEmployeeHome(dataDir: string): EmployeeHomeState {
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
  const def = defaultSettings(dataDir);
  return {
    enabled: def.employeeHome,
    value: def.employeeHome ? parseEmployeeConfigDir("auto", dataDir) : null,
    source: "default",
  };
}
