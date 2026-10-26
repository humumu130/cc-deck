// #17 雇员独立家设置（产品层）：data/settings.json 单键持久化。
// 优先级（高→低）：CCR_EMPLOYEE_CONFIG_DIR 显式 env（部署覆盖面，锁定设置项）
//   > settings.json（用户面，三端设置 UI 读写）> 默认值。
// 默认值策略（用户 2026-09-28 拍板）：新装默认开（全新环境零迁移负担）；
// 存量升级默认关（行为不变，UI 引导后再开——开启只影响新会话，存量会话按
// 创建时记录的家走，无需迁移）。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseEmployeeConfigDir } from "./config.js";
import type { SessionEngine } from "./types.js";

export interface RelaySettings {
  employeeHome: boolean;
}

export interface EngineProfile {
  engine: SessionEngine;
  provider: string;
  profile_ref: string;
  model?: string;
  capabilities?: string[];
  enabled?: boolean;
  base_url?: string;
  api_key_env?: string;
  base_url_env?: string;
  keychain_ref?: string;
}

export interface EngineProfilePreflight {
  ok: boolean;
  errors: string[];
  warnings: string[];
  env_refs: string[];
}

export type EngineProfileWriteResult =
  | { ok: true; profiles: EngineProfile[] }
  | { ok: false; error: string };

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
const ENGINE_PROFILES_FILE = "engine-profiles.json";
const ENGINE_PROFILE_ENGINES: readonly SessionEngine[] = ["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"];
const SECRET_FIELD = /(token|secret|password|api[_-]?key|private[_-]?key)/i;
const REFERENCE_FIELD = /(?:_env|_ref)$/i;

// ---------- #272 源名称（relay-name 文件唯一事实源，W-SRCLABEL #134 单点收编模块） ----------
// 语义：dataDir/relay-name 存在且非空 → 即源名（读侧沿用历史 40 字符上限兜底，防手改
// 文件超长撑爆 chip）；缺失/空 → 回落 hostname。写口（本模块 writeRelayName）统一
// sanitize：trim、拒控制字符、限长 ≤12（任务书口径：聚合模式源 chip 高频出现，长名噪声大）；
// 空串=清空文件（回落 hostname）。SNAPSHOT relay_name / SESSIONS_RECONCILE relay_source
// 均经 effectiveRelayName 现算（改名免重启生效）。
export const RELAY_NAME_MAX = 12;
const RELAY_NAME_FILE = "relay-name";

export function effectiveRelayName(dataDir: string): string {
  try {
    return readFileSync(join(dataDir, RELAY_NAME_FILE), "utf8").trim().slice(0, 40) || hostname().slice(0, 40);
  } catch {
    return hostname().slice(0, 40);
  }
}

/** sanitize 源名输入：非字符串/含控制字符/超长 → ok:false 带可读指引；空串（trim 后）→ ok:true name="" = 清空回落 hostname */
export function sanitizeRelayName(input: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "源名称须为字符串" };
  if (/[\x00-\x1f\x7f]/.test(input)) return { ok: false, error: "源名称含控制字符" };
  const name = input.trim();
  if (name.length === 0) return { ok: true, name: "" };
  if (name.length > RELAY_NAME_MAX) return { ok: false, error: `源名称最长 ${RELAY_NAME_MAX} 字符（当前 ${name.length}）` };
  return { ok: true, name };
}

export function writeRelayName(dataDir: string, name: string): boolean {
  try {
    const p = join(dataDir, RELAY_NAME_FILE);
    if (name === "") {
      try { unlinkSync(p); } catch { /* 无文件=已回落，幂等 */ }
      return true;
    }
    writeFileSync(p, name, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function engineProfilesPath(dataDir: string): string {
  return join(dataDir, ENGINE_PROFILES_FILE);
}

function secretFieldPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => secretFieldPaths(item, `${prefix}[${index}]`));
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SECRET_FIELD.test(key) && !REFERENCE_FIELD.test(key)) out.push(path);
    if (REFERENCE_FIELD.test(key) && typeof child !== "string") out.push(path);
    out.push(...secretFieldPaths(child, path));
  }
  return out;
}

export function validateEngineProfile(profile: unknown): { ok: true; profile: EngineProfile } | { ok: false; error: string } {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return { ok: false, error: "profile 必须是对象" };
  const raw = profile as Record<string, unknown>;
  const secretPaths = secretFieldPaths(raw);
  if (secretPaths.length > 0) return { ok: false, error: `profile 含秘密字段: ${secretPaths.join(",")}` };
  if (!ENGINE_PROFILE_ENGINES.includes(raw.engine as SessionEngine)) return { ok: false, error: "engine 无效" };
  if (typeof raw.provider !== "string" || !raw.provider.trim()) return { ok: false, error: "provider 必填" };
  if (typeof raw.profile_ref !== "string" || !raw.profile_ref.trim()) return { ok: false, error: "profile_ref 必填" };
  if (raw.model !== undefined && typeof raw.model !== "string") return { ok: false, error: "model 必须是字符串" };
  if (raw.capabilities !== undefined && (!Array.isArray(raw.capabilities) || raw.capabilities.some((item) => typeof item !== "string"))) return { ok: false, error: "capabilities 必须是字符串数组" };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return { ok: false, error: "enabled 必须是布尔值" };
  if (raw.base_url !== undefined) {
    if (typeof raw.base_url !== "string") return { ok: false, error: "base_url 必须是字符串" };
    try { new URL(raw.base_url); } catch { return { ok: false, error: "base_url 无法解析" }; }
  }
  return {
    ok: true,
    profile: {
      engine: raw.engine as SessionEngine,
      provider: raw.provider.trim(),
      profile_ref: raw.profile_ref.trim(),
      ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
      ...(Array.isArray(raw.capabilities) ? { capabilities: raw.capabilities as string[] } : {}),
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      ...(typeof raw.base_url === "string" ? { base_url: raw.base_url.trim() } : {}),
      ...(typeof raw.api_key_env === "string" ? { api_key_env: raw.api_key_env.trim() } : {}),
      ...(typeof raw.base_url_env === "string" ? { base_url_env: raw.base_url_env.trim() } : {}),
      ...(typeof raw.keychain_ref === "string" ? { keychain_ref: raw.keychain_ref.trim() } : {}),
    },
  };
}

export function readEngineProfilesFile(dataDir: string): EngineProfile[] | null {
  try {
    const raw = JSON.parse(readFileSync(engineProfilesPath(dataDir), "utf-8")) as unknown;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { profiles?: unknown }).profiles) ? (raw as { profiles: unknown[] }).profiles : null;
    if (!list) return null;
    const profiles: EngineProfile[] = [];
    for (const item of list) {
      const checked = validateEngineProfile(item);
      if (!checked.ok) return null;
      profiles.push(checked.profile);
    }
    return profiles;
  } catch {
    return null;
  }
}

export function writeEngineProfilesFile(dataDir: string, profiles: unknown[]): EngineProfileWriteResult {
  const checked: EngineProfile[] = [];
  for (const item of profiles) {
    const result = validateEngineProfile(item);
    if (!result.ok) return result;
    checked.push(result.profile);
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    const target = engineProfilesPath(dataDir);
    const tmp = target + ".tmp";
    writeFileSync(tmp, JSON.stringify({ profiles: checked }, null, 2) + "\n", "utf-8");
    renameSync(tmp, target);
    return { ok: true, profiles: checked };
  } catch {
    return { ok: false, error: "engine profile 写入失败" };
  }
}

export function preflightEngineProfile(profile: unknown, env: NodeJS.ProcessEnv = process.env): EngineProfilePreflight {
  const checked = validateEngineProfile(profile);
  if (!checked.ok) return { ok: false, errors: [checked.error], warnings: [], env_refs: [] };
  const value = checked.profile;
  const errors: string[] = [];
  const warnings: string[] = [];
  const envRefs: string[] = [];
  for (const ref of [value.api_key_env, value.base_url_env]) {
    if (!ref) continue;
    envRefs.push(ref);
    if (!env[ref]) errors.push(`环境引用未设置: ${ref}`);
  }
  if (value.base_url_env && env[value.base_url_env]) {
    try { new URL(env[value.base_url_env]!); } catch { errors.push(`base URL 环境引用无法解析: ${value.base_url_env}`); }
  }
  if (value.keychain_ref) warnings.push(`凭证由 keychain 引用提供: ${value.keychain_ref}`);
  if (value.engine === "zcode") errors.push("ZCode unsupported/fail-closed");
  return { ok: errors.length === 0, errors, warnings, env_refs: envRefs };
}

export const readEngineProfiles = readEngineProfilesFile;
export const writeEngineProfiles = writeEngineProfilesFile;

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

// ---------- W-RULES1 雇员家轻种子（2026-10-11，拍板表 #7 / C 路 §6.3） ----------
// 隐藏断链修复：雇员独立家开启后，用户全局 CLAUDE.md（~/.claude/CLAUDE.md）对雇员会话
// 静默失联（CLI 不再加载默认家）——用户军规对 worker 全部失效且无任何报错。处置口径
//（C 路 §6.3 拍板）：**不做自动同步**（用户全局文件是用户地盘，机器拷贝=越权写），
// 只在 claude-home 种一份断链说明（无 CLAUDE.md 时一次性写入，存在即认绝不覆盖——
// org/项目 CLAUDE.md 幂等种子同纪律），把「拷不拷、拷什么」的决定权留给用户。
// 团队规则走派单注入（org/rules.json）不受此断链影响——说明行一并写明，防误解。
const EMPLOYEE_HOME_SEED = `# 雇员独立家说明（系统生成，可删除）

本目录是 cc-deck 雇员会话的独立配置家：用户全局 CLAUDE.md（~/.claude/CLAUDE.md）**不会**在此自动加载——个人全局纪律（自测要求、措辞军规等）如需对 worker 生效，请人工拷贝到本文件。
团队规则（用户审定的红线）不依赖本文件：随派单自动注入（~/.cc-deck/org/rules.json）。
`;

/** 雇员家断链说明种子（启动序一次性调用，index.ts）。开关关/目录不可建/已存在 → 静默
 * 跳过（尽力而为：种子是提示面，写失败不阻断启动）。返回是否新写了种子（测试用）。 */
export function ensureEmployeeHomeSeed(dataDir: string): boolean {
  try {
    const st = resolveEmployeeHome(dataDir);
    if (!st.enabled || !st.value) return false;
    if (existsSync(join(st.value, "CLAUDE.md"))) return false;
    mkdirSync(st.value, { recursive: true });
    writeFileSync(join(st.value, "CLAUDE.md"), EMPLOYEE_HOME_SEED, "utf-8");
    console.log(`[settings] 雇员家断链说明已种子：${join(st.value, "CLAUDE.md")}（用户全局 CLAUDE.md 不在独立家自动加载）`);
    return true;
  } catch (e) {
    console.warn(`[settings] 雇员家种子写入失败（跳过，不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------- W-MODE 协作模式开关（2026-10-12 最小核心） ----------
// collabMode: "leader"（默认，现状全兼容）| "no-leader"（会话列表/SNAPSHOT 隐藏 Leader
// 常驻锚卡）。独立小文件 data/collab-mode.json（任务书口径，不挤 settings.json——
// 语义域不同：settings 是产品行为开关，这是组织形态开关）。读写纪律抄 settings.json
// 两条硬约束：tmp+rename 原子写；坏 JSON 按「未配置」处理（leader 兜底，失败方向=
// 现状，永不因坏文件把用户锁进 no-leader）。隐藏是纯下发面过滤：锚、内存卡、
// ensureLeader、团队/看板/通知机制全量照常（用户痛点=挂死 ERROR 锚卡删不掉恢复
// 不了，隐藏即解——relay 拒删是 M1 审查轮的故意设计，不能为开关放开）。

export type CollabMode = "leader" | "no-leader";

const COLLAB_MODE_FILE = "collab-mode.json";

export function readCollabMode(dataDir: string): CollabMode {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, COLLAB_MODE_FILE), "utf-8")) as { mode?: unknown };
    return raw && raw.mode === "no-leader" ? "no-leader" : "leader"; // 未知值/坏 JSON → leader（现状兜底）
  } catch {
    return "leader"; // 无文件=默认态（不落盘：leader 是现状，零迁移）
  }
}

export function writeCollabMode(dataDir: string, mode: CollabMode): boolean {
  try {
    const p = join(dataDir, COLLAB_MODE_FILE);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify({ mode, updated_at: Date.now() }, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}
