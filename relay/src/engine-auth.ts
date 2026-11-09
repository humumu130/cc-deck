// ---------- #102 批 A：每引擎登录态探针（薄适配三要素：探针命令 + 错误 pattern + 登录命令） ----------
// 背景（1014 用户实测踩坑）：CodeBuddy CLI 已装但未登录（桌面版登录态与 CLI 独立），
// preflightEngine 只探「CLI 在不在 PATH / env key 设没设」，「装了但没登录」通过预检、
// 派单后才炸笼统「引擎返回错误」。本件补第二维探测：账号登录态。
//
// 设计铁律（任务书钉死）：
//   1. **认配置优先**：codex 走中转（config.toml bearer token）时 `codex login status`
//      显示 Not logged in 但照样能跑——探针必须先识别「中转/API key 配置在场」，
//      有则直接判 ready 跳过登录探测，不能一刀切误报（本机实锤案例）。
//   2. **fail-open**：探针命令执行失败/超时/输出不认识 → 判 ready（宁可漏报不锁引擎——
//      漏报最坏回到现状「spawn 后炸笼统错误」，误报会把可用引擎锁死在目录里）。
//   3. **只判两态**（ready / needs_auth）：CLI 没装是 preflightEngine 的 unavailable 维，
//      本件所有调用方都在 pf.ok 之后才 probe，两维正交不重叠。
//
// 各引擎探测面（2026-10-14 本机实测锚定）：
//   claude     免检恒 ready（relay 进程即 claude SDK）
//   codex      三源判 ready：$CODEX_HOME|~/.codex 的 config.toml 带 bearer token（任意
//              model_providers.* 的 (experimental_)bearer_token）/ auth.json 存在（ChatGPT
//              登录态）/ OPENAI_API_KEY env；三源全无 → spawn `codex login status`，
//              输出含 "Not logged in" → needs_auth（实测 rc=0、文本匹配非退出码）
//   codebuddy  spawn `<CCR_CODEBUDDY_PATH|codebuddy-code> auth status`，输出含
//              "Authentication required" → needs_auth（实测输出「Authentication required.
//              Please use /login command to sign in to your account」）
//   qwen-code  三层判定（W-ENGREST-FIX 1109 对版 0.27.1）：settings 选型位
//              security.auth.selectedType → env 组合（上游 getAuthTypeFromEnv 逐字：
//              anthropic/openai/gemini/QWEN_OAUTH）→ 旧单键+凭据文件候选宽松尾路
//   trae       config 文件判定（W-ENGREST-FIX 1109 对版）：CCR_TRAE_CONFIG ||
//              ~/.trae-agent/trae_config.yaml 存在且 api_key 非空 → ready（真 CLI 无
//              login 子命令，认证=YAML；与 agent-trae traeConfigPath 同源）
//   zcode      枚举占位未接入编排，恒 ready（catalog unsupported 分支不会调到）
//
// 运行时兜底（token 中途过期）：authFailureHint 对引擎输出/退出尾行做 pattern 匹配
//（Not logged in / Authentication required / 请先登录），命中返回该引擎登录指引。
import { accessSync, constants, readFileSync } from "node:fs";
import { spawnSync, execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEngine } from "./types.js";

export interface EngineAuthProbe {
  state: "ready" | "needs_auth";
  /** state=needs_auth 时必有：登录指引（动词开头、含具体命令、不写内部机制词——更新说明军规口径） */
  auth_hint?: string;
}

/** 探针注入缝（测试用）：home 目录与探针命令可重定向，缺省全部实况 */
export interface AuthProbeOptions {
  homeDir?: string;
  /** spawnSync 探针超时 ms（缺省 5000——auth status 类子命令亚秒级，5s 已宽） */
  timeoutMs?: number;
}

const HINTS: Record<string, string> = {
  codex: "终端运行 codex login 完成登录；用 API 中转则在 ~/.codex/config.toml 配 bearer_token，或设置 OPENAI_API_KEY 环境变量",
  codebuddy: "终端运行 codebuddy-code，输入 /login 完成登录（桌面版登录态与 CLI 相互独立）",
  // W-ENGREST-FIX（1109 对版）：qwen auth 子命令 0.27.1 已 removed；选型=settings
  // security.auth.selectedType（顶层 authType 不是读取位）或 --auth-type；env 面按上游
  // getAuthTypeFromEnv 组合制（如 anthropic=API_KEY+BASE_URL+MODEL 三键齐才自动选型）
  "qwen-code": "在 ~/.qwen/settings.json 设置 security.auth.selectedType（如 anthropic/openai/qwen-subscription）并配置对应环境变量（如 ANTHROPIC_API_KEY+ANTHROPIC_BASE_URL），或运行 qwen --auth-type <类型> 选型",
  // W-ENGREST-FIX（1109 对版）：trae-agent 无登录命令（commands=interactive/run/show-config/
  // tools），认证=YAML api_key；探测位与 agent-trae 注入位同源（CCR_TRAE_CONFIG 或全局位）
  trae: "在 ~/.trae-agent/trae_config.yaml 配置 model_providers 的 api_key 与 base_url（trae-agent 无登录命令，认证走配置文件），或设置 CCR_TRAE_CONFIG 指向已有配置",
};

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** codex 配置目录：CODEX_HOME 显式优先（codex CLI 同语义），缺省 ~/.codex */
function codexHome(homeDir: string): string {
  return process.env.CODEX_HOME?.trim() || join(homeDir, ".codex");
}

/** codex 认配置优先判定：config.toml 带任意 bearer token / auth.json 在场 / env key 在场 */
function codexConfigAuthPresent(homeDir: string): boolean {
  if (process.env.OPENAI_API_KEY?.trim()) return true;
  const home = codexHome(homeDir);
  if (fileExists(join(home, "auth.json"))) return true;
  try {
    const config = readFileSync(join(home, "config.toml"), "utf-8");
    // (experimental_)bearer_token = "非空值" ——认中转/API key 配置在场（1014 实锤：
    // 此形态下 `codex login status` 恒 Not logged in 但可跑，一刀切探测必误报）
    return /(?:experimental_)?bearer_token\s*=\s*"[^"]+"/.test(config);
  } catch {
    return false;
  }
}

/** 凭据文件/env 候选命中判定（qwen-code/trae 共用：候选任一命中即 ready） */
function credentialCandidatePresent(files: string[], envKeys: string[]): boolean {
  if (envKeys.some((k) => process.env[k]?.trim())) return true;
  return files.some(fileExists);
}

/** qwen 登录态判定（W-ENGREST-FIX 1109 对版 0.27.1 源码级）：非交互权威闸=「已选型」——
 * settings 读取位是 security.auth.selectedType（顶层 authType 非读取位；validateNon-
 * InteractiveAuth 实测「No auth type is selected」即此）；env 面按上游 getAuthTypeFromEnv
 * 组合制（单键不选型）：anthropic=API_KEY+BASE_URL+MODEL、openai=API_KEY+BASE_URL+
 * (OPENAI_MODEL|QWEN_MODEL)、gemini=API_KEY+MODEL、QWEN_OAUTH 单键即选。旧单键/文件
 * 候选保留为宽松尾路（fail-open：在场按可试判 ready，选型缺失由 spawn 报错可见）。 */
function qwenAuthCandidatePresent(homeDir: string): boolean {
  try {
    const s = JSON.parse(readFileSync(join(homeDir, ".qwen", "settings.json"), "utf-8")) as { security?: { auth?: { selectedType?: unknown } } };
    if (typeof s?.security?.auth?.selectedType === "string" && s.security.auth.selectedType.trim() !== "") return true;
  } catch { /* 无 settings/坏 JSON → 走 env/候选面 */ }
  const v = (k: string): string | undefined => {
    const raw = process.env[k]?.trim();
    return raw ? raw : undefined;
  };
  if (v("QWEN_OAUTH")) return true;
  if (v("ANTHROPIC_API_KEY") && v("ANTHROPIC_BASE_URL") && v("ANTHROPIC_MODEL")) return true;
  if (v("OPENAI_API_KEY") && v("OPENAI_BASE_URL") && (v("OPENAI_MODEL") || v("QWEN_MODEL"))) return true;
  if (v("GEMINI_API_KEY") && v("GEMINI_MODEL")) return true;
  return credentialCandidatePresent(
    [join(homeDir, ".qwen", "oauth_creds.json"), join(homeDir, ".qwen", "google-accounts.json"), join(homeDir, ".qwen", "aws_credentials.json")],
    ["QWEN_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"],
  );
}

/** trae 登录态判定（W-ENGREST-FIX 1109 对版）：真 trae-agent CLI 无 login 子命令
 * （commands=interactive/run/show-config/tools），认证=YAML api_key。旧探针
 * `trae-cli login status` 对真 CLI 是不存在的子命令（恒 fail-open 假 ready）。改 config
 * 文件判定：存在且 api_key 非空值 → ready；缺席/空 key → needs_auth（trae 无登录命令
 * 可走，config 缺席=真不可跑，非探针故障不适用 fail-open）。位与 agent-trae 注入位
 * 同源（CCR_TRAE_CONFIG || ~/.trae-agent/trae_config.yaml）；show-config 能验同判据但
 * 要 spawn 0.5~5s 且富文本格式随版本漂移，文件判定零成本零漂移。 */
function traeConfigAuthPresent(homeDir: string): boolean {
  const p = process.env.CCR_TRAE_CONFIG?.trim() || join(homeDir, ".trae-agent", "trae_config.yaml");
  try {
    const y = readFileSync(p, "utf-8");
    // 剥注释再匹配：模板/用户配置的注释示例行（# 填 api_key: sk-xxx 之类）不含真实凭据
    //（首启模板实测教训：注释字面量会被正则误命中→模板态误报 ready）
    const code = y.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n").replace(/\s+#.*$/gm, "");
    return /api_key:\s*["']?[^\s"']+/i.test(code);
  } catch {
    return false;
  }
}

function needsAuth(engine: SessionEngine): EngineAuthProbe {
  return { state: "needs_auth", auth_hint: HINTS[engine] ?? `请在终端完成 ${engine} 登录` };
}

/** 静态登录指引文案（零 spawn——#102 批 B engine-login 流程 hint 用；探针级
 * 精确 hint 由 probeEngineAuth* 的 auth_hint 承载，本函数只做降级文案） */
export function staticAuthHint(engine: SessionEngine): string {
  return HINTS[engine] ?? `请在终端完成 ${engine} 登录`;
}

const readyProbe: EngineAuthProbe = { state: "ready" };

// ---------- 结果缓存（生产路径 45s TTL；测试带 opts 走旁路零缓存保确定性） ----------
// 为什么必须缓存：engineCatalogSummary 每次 SNAPSHOT 装配都会探（ws/cloud 两出口
// 每次建连各一次），spawnSync 同步阻塞主线程 0.8~5s/次——重连风暴时 relay 全会话
// 事件停摆。45s 语义：登录后目录黄点/创建拦截最迟 45s 自愈（用户完成登录→稍等或
// 重连即恢复），换来稳态 SNAPSHOT 零 spawn。COMMAND_CREATE/派单拦截同吃缓存。
const CACHE_TTL_MS = 45_000;
const probeCache = new Map<SessionEngine, { at: number; probe: EngineAuthProbe }>();

/** 失效缓存（测试夹具用：改 env/文件后强制重探；生产不需要——TTL 自然过期） */
export function resetEngineAuthCache(): void {
  probeCache.clear();
}

/** 引擎登录态探针（preflightEngine 之后第二维：CLI 在场前提下的账号登录态）。
 * 带opts = 测试旁路（零缓存直探）；无 opts = 生产路径（45s TTL 缓存）。 */
export function probeEngineAuth(engine: SessionEngine, opts?: AuthProbeOptions): EngineAuthProbe {
  if (!opts) {
    const hit = probeCache.get(engine);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.probe;
  }
  const probe = probeEngineAuthDirect(engine, opts);
  if (!opts) probeCache.set(engine, { at: Date.now(), probe });
  return probe;
}

function probeEngineAuthDirect(engine: SessionEngine, opts?: AuthProbeOptions): EngineAuthProbe {
  const home = opts?.homeDir ?? homedir();
  const timeoutMs = opts?.timeoutMs ?? 5000;
  switch (engine) {
    case "claude":
      return readyProbe; // relay 进程即 SDK，恒 ready（免检）
    case "zcode":
      return readyProbe; // 枚举占位未接入编排（catalog unsupported 分支不会调到；防御恒 ready）
    case "codex": {
      if (codexConfigAuthPresent(home)) return readyProbe; // 认配置优先——中转/token 在场跳过登录探测
      try {
        const r = spawnSync(process.env.CCR_CODEX_PATH ?? "codex", ["login", "status"], {
          stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf-8",
        });
        if (r.error || r.signal) return readyProbe; // 探针故障 fail-open
        const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
        if (/not logged in/i.test(out)) return needsAuth(engine);
        return readyProbe; // "Logged in" / 其他输出一律 ready（fail-open）
      } catch {
        return readyProbe;
      }
    }
    case "codebuddy": {
      try {
        // 与 preflightCodeBuddy 同命令源（CCR_CODEBUDDY_PATH ?? "codebuddy-code"；
        // 本机实测 codebuddy/codebuddy-code 双 bin 同包同行为）
        const r = spawnSync(process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code", ["auth", "status"], {
          stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf-8",
        });
        if (r.error || r.signal) return readyProbe; // 探针故障 fail-open
        const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
        if (/authentication required|not logged in|请先登录/i.test(out)) return needsAuth(engine);
        return readyProbe;
      } catch {
        return readyProbe;
      }
    }
    case "qwen-code":
      // W-ENGREST-FIX：判定上收 qwenAuthCandidatePresent（settings 选型位+env 组合+旧候选）
      return qwenAuthCandidatePresent(home) ? readyProbe : needsAuth(engine);
    case "trae":
      // W-ENGREST-FIX：config 文件+api_key 非空判定（真 CLI 无 login 子命令，旧探针恒假 ready）
      return traeConfigAuthPresent(home) ? readyProbe : needsAuth(engine);
    default:
      return readyProbe;
  }
}

/** 运行时兜底 pattern：引擎输出/退出尾行命中登录失效特征 → 返回登录指引（null=非登录态故障）。
 * 兜 token 中途过期：会话已过创建闸，spawn 后引擎吐「Not logged in / Authentication
 * required / 请先登录」——调用方（session-manager onTurnEnd ERROR 面）据此把会话标
 * needs_auth 态（state.auth_hint）随 SNAPSHOT 下发。 */
export function authFailureHint(text: string, engine?: SessionEngine): string | null {
  if (!/not logged in|authentication required|please use \/login|请先登录|账号未登录/i.test(text)) return null;
  return (engine && HINTS[engine]) ?? "请在终端完成对应引擎的登录后重试";
}

// ---------- #102 批 B：异步探针（登录 pane 轮验用——spawnSync 阻塞主线程 0.8~5s，
// 登录流程存活期每 ~2.4s 轮验一次会把 relay 事件流打停摆；批 A 同款防线注释见
// CACHE_TTL_MS 处）。判定逻辑与 probeEngineAuthDirect 逐引擎同源（输出文本匹配
// 同 pattern），仅 spawn 面 sync→async。文件/env 判定（codex 认配置、qwen/trae
// 凭据候选）微秒级保持同步。不进缓存：调用方（engine-login 轮验）本就每轮
// resetEngineAuthCache，缓存语义由调用方掌控。
function execFileText(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      // 探针故障 fail-open 与同步版同口径：error/signal → ready 由调用方兜
      resolve({ ok: !err, out: `${stdout ?? ""}\n${stderr ?? ""}` });
    });
  });
}

export async function probeEngineAuthAsync(engine: SessionEngine, opts?: AuthProbeOptions): Promise<EngineAuthProbe> {
  const home = opts?.homeDir ?? homedir();
  const timeoutMs = opts?.timeoutMs ?? 5000;
  switch (engine) {
    case "claude":
    case "zcode":
      return readyProbe; // 免检恒 ready（同同步版）
    case "codex": {
      if (codexConfigAuthPresent(home)) return readyProbe; // 认配置优先（同步版同源函数）
      try {
        const r = await execFileText(process.env.CCR_CODEX_PATH ?? "codex", ["login", "status"], timeoutMs);
        if (!r.ok) return readyProbe; // 探针故障 fail-open
        return /not logged in/i.test(r.out) ? needsAuth(engine) : readyProbe;
      } catch {
        return readyProbe;
      }
    }
    case "codebuddy": {
      try {
        const r = await execFileText(process.env.CCR_CODEBUDDY_PATH ?? "codebuddy-code", ["auth", "status"], timeoutMs);
        if (!r.ok) return readyProbe;
        return /authentication required|not logged in|请先登录/i.test(r.out) ? needsAuth(engine) : readyProbe;
      } catch {
        return readyProbe;
      }
    }
    case "qwen-code":
      // W-ENGREST-FIX：与同步版同源（qwenAuthCandidatePresent——纯文件/env 判定微秒级）
      return qwenAuthCandidatePresent(home) ? readyProbe : needsAuth(engine);
    case "trae":
      // W-ENGREST-FIX：与同步版同源（traeConfigAuthPresent——纯文件判定，无 spawn 面）
      return traeConfigAuthPresent(home) ? readyProbe : needsAuth(engine);
    default:
      return readyProbe;
  }
}
