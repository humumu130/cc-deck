// ---------- 灰度 env 覆盖文件（DEV-39 清单1：#292 cutover 灰度序的生产载体） ----------
// 为什么需要：Nova 壳以固定 env 契约孵化 relay（desktop-tauri main.rs relay_spawn_env
// 只带 PORT/DATA_DIR/INJECT_CS/NOHOOK_IDLE_MS/PARENT_PID 五键），存储灰度键无注入通道
// ——session-write.ts:41-47 自规划的「auto 对账零差异段 → CCR_SESSION_IMPORT=off →
// CCR_SESSION_WRITE_MODE=db → CCR_BOOT_FROM=db」四步灰度在生产只能靠「改缺省+发版」
// 一步一版，env 显式段（每步可独立回退的验收形态）无从落地。本模块补一个 boot 期
// env 覆盖文件：缺省 ~/.cc-deck/relay-env.json（CCR_RELAY_ENV_FILE 可指它处，测试/
// 沙盒用）。#292 cutover 后该文件保留——回退通道（任何一步出问题改回/off + 重启
// relay）与后续灰度的常设机关。
//
// 语义（三条边界，与 read-mode「无效值 fail-fast」口径互补）：
//   1. 白名单收紧：只认灰度五键（READ_MODE/WRITE_MODE/SESSION_IMPORT/BOOT_FROM/
//      EVENTS_ARCHIVE），未知键 warn 不炸（typo 可见）不应用——本文件不是任意 env
//      注入口，是存储灰度的专用面。
//   2. 进程显式 env > 文件：已设的 process.env 键不覆盖（CLI 直跑/CI 显式 env 语义
//      保持最高优先级；文件只在键缺席时补位）。
//   3. 值必须是字符串（JSON 对象里 {"CCR_BOOT_FROM": "auto"} 形态）；非串值 warn 跳过
//      ——防空值/数字把 fail-fast 解析面喂炸。
//
// 应用时点：index.ts 首位 import（模块体先于一切业务模块执行）。仓库已核：storage/
// config 各模块均无模块顶层 env 读（全部函数内现读现用），文件补位后所有读点即见。
// 无效值不在本层拒（read-mode resolveReadMode 的 fail-fast 与词表校验各自把关——本层
// 只做注入，不做语义）。
//
// 可观测：appliedRelayEnvFile() 供 /health storage 段透出（文件路径+应用键清单），
// 排障时「env 到底哪来的」一眼可查（对齐 plugin-config 的配置可观测惯例）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 灰度白名单（DEV-39 定档五键）：存储读写档/导入闸/boot 源/审计归档开关。 */
const GRAY_KEYS: readonly string[] = [
  "CCR_STORAGE_READ_MODE",
  "CCR_SESSION_WRITE_MODE",
  "CCR_SESSION_IMPORT",
  "CCR_BOOT_FROM",
  "CCR_EVENTS_ARCHIVE",
] as const;

export function relayEnvFilePath(): string {
  return process.env.CCR_RELAY_ENV_FILE ?? join(homedir(), ".cc-deck", "relay-env.json");
}

const applied: { file: string; keys: string[] } = { file: "", keys: [] };

/** 本次 boot 从 env 文件实际应用的键（/health 透出面；未启用=file 空串）。 */
export function appliedRelayEnvFile(): { file: string; keys: string[] } {
  return { file: applied.file, keys: [...applied.keys] };
}

/** boot 期应用 env 覆盖文件（index.ts 首位 import 触发；幂等——二次调用零动作）。 */
export function applyRelayEnvFile(): void {
  if (applied.file || applied.keys.length) return;
  const file = relayEnvFilePath();
  if (!existsSync(file)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    // 坏文件=告警不炸 boot（relay 必须照常起——对齐 read-mode 降级横幅的存活语义）；
    // 但也不能静默吞：灰度键失配会让运维以为已生效，记 file 让 /health 可见「读了没成」
    console.error(`[boot-env] ⚠️  ${file} 解析失败（忽略该文件，全部灰度键走缺省）：${err instanceof Error ? err.message : String(err)}`);
    applied.file = file;
    return;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(`[boot-env] ⚠️  ${file} 不是 JSON 对象（忽略该文件，全部灰度键走缺省）`);
    applied.file = file;
    return;
  }
  applied.file = file;
  const entries = Object.entries(raw as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (!(GRAY_KEYS as readonly string[]).includes(k)) {
      console.warn(`[boot-env] 未知键 "${k}" 不在灰度白名单（${GRAY_KEYS.join("/")}），已忽略`);
      continue;
    }
    if (typeof v !== "string") {
      console.warn(`[boot-env] 键 "${k}" 值非字符串（${typeof v}），已忽略——写形如 {"CCR_BOOT_FROM": "auto"} 的字符串值`);
      continue;
    }
    if (process.env[k] !== undefined) continue; // 进程显式 env 优先，不覆盖
    process.env[k] = v;
    applied.keys.push(k);
  }
  if (applied.keys.length) {
    console.log(`[boot-env] 灰度 env 文件已应用：${applied.keys.map((k) => `${k}=${process.env[k]}`).join(" ")}（源 ${file}）`);
  }
}

applyRelayEnvFile();
