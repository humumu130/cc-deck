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
//   qwen-code  凭据文件/env 存在性（本机未装，路径按 gemini-cli fork 惯例候选——
//              上游版本漂移会误报 needs_auth，误报代价=用户照 hint 重新登录一次，
//              无锁死风险，备案）
//   trae       同上（凭据候选 ~ per trae-cli 惯例；同备案）
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
  "qwen-code": "终端启动 qwen-code 后按提示登录（输入 /auth），或设置 QWEN_API_KEY / GEMINI_API_KEY 环境变量",
  trae: "终端运行 trae-cli，按 ? 选 Login with Email 完成登录（或点引擎目录的立即登录）",
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
      // 候选路径按 gemini-cli fork 惯例（oauth_creds/google-accounts）；本机未装未实测，
      // 漂移误报代价=引导重登一次，无锁死（登录后凭据文件出现即 ready）
      return credentialCandidatePresent(
        [join(home, ".qwen", "oauth_creds.json"), join(home, ".qwen", "google-accounts.json"), join(home, ".qwen", "aws_credentials.json")],
        ["QWEN_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      ) ? readyProbe : needsAuth(engine);
    case "trae": {
      // #102 批 B 实测修正（与 probeEngineAuthAsync 同源）：文件候选恒 miss 误报，
      // 改探针命令文本匹配——`trae-cli login status` v2 输出「Not logged in」rc=0；
      // 1.0 输出空 → fail-open ready
      try {
        const r = spawnSync(process.env.CCR_TRAE_PATH ?? "trae-cli", ["login", "status"], {
          stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf-8",
        });
        if (r.error || r.signal) return readyProbe;
        const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
        return /not logged in|未登录|请先登录/i.test(out) ? needsAuth(engine) : readyProbe;
      } catch {
        return readyProbe;
      }
    }
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
      return credentialCandidatePresent(
        [join(home, ".qwen", "oauth_creds.json"), join(home, ".qwen", "google-accounts.json"), join(home, ".qwen", "aws_credentials.json")],
        ["QWEN_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      ) ? readyProbe : needsAuth(engine);
    case "trae":
      // #102 批 B 实测修正（Leader 追加要求）：trae 凭据不在批 A 候选的
      // ~/.trae/.credentials.json 等路径（实测 v2 状态存 ~/.trae/cli/*.sqlite），文件
      // 候选恒 miss → 长期误报 needs_auth。改与 codex 同款探针命令文本匹配：
      // `trae-cli login status` 实测输出「Not logged in」rc=0（v2 traex 同款）；
      // 1.0 老版该子命令输出为空 → fail-open 判 ready（1.0 已 limited maintenance，
      // 主线适配 v2，取舍回执备案）
      try {
        const r = await execFileText(process.env.CCR_TRAE_PATH ?? "trae-cli", ["login", "status"], timeoutMs);
        if (!r.ok) return readyProbe;
        return /not logged in|未登录|请先登录/i.test(r.out) ? needsAuth(engine) : readyProbe;
      } catch {
        return readyProbe;
      }
    default:
      return readyProbe;
  }
}
