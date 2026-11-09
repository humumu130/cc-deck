// ---------- W-ENGDIST-A（t-2b1165a2，1110）：引擎一键安装器 + trae 补丁自动应用 ----------
// 用户拍板口径（1110）：「所有引擎可信度 100%，别的用户安装之后也是 100%」——新用户
// 从零装机 → 四引擎可用全链自动化。本件三职责：
//   1. engine-install 状态机（npm 三引擎 -g 直装 + trae 全链 clone/uv sync/补丁/preflight
//      复验；行级日志供前端轮询；同引擎 running 拒重复启动；已装探测=跳过+版本行）
//   2. trae 补丁自动应用（ensureTraeServerToolPatch——agent-trae.ts spawn 前挂点 +
//      安装链末尾同函数；勘察 w-engtraedist.md A 路定案：检测锚=补丁 MARKER 在场性，
//      零子进程；missing 才跑 python3 脚本；失败降级=告警不阻断对话面）
//   3. 审计单口（auditEngineEvent：chain-audit.jsonl append——词表见 types.ts
//      CHAIN_AUDIT_ACTIONS engine-install/engine-patch-apply/engine-patch-fail 三词；
//      与 SessionManager.emitChainAudit 同格式双写口，jsonl 单行 append 原子安全）
// 无环纪律（org.ts 同款）：本模块只依赖 node 内置 + config.resolveDataDir，不反向
// import SessionManager/ws-server（HTTP 面在 ws-server 组装，状态机纯内存零持久）。
import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "./config.js";

/** 引擎安装规格：npm 三引擎一条命令；trae 全链多步（每步一行日志，行内可失败终止）。 */
type InstallSpec =
  | { id: "qwen-code" | "codex" | "codebuddy"; kind: "npm"; npmPackage: string }
  | { id: "trae"; kind: "trae" };

const SPECS: Record<string, InstallSpec> = {
  "qwen-code": { id: "qwen-code", kind: "npm", npmPackage: "@qwen-code/qwen-code" },
  codex: { id: "codex", kind: "npm", npmPackage: "codex" },
  codebuddy: { id: "codebuddy", kind: "npm", npmPackage: "@tencent-ai/codebuddy-code" },
  trae: { id: "trae", kind: "trae" },
};

/** trae 固定位（勘察 §五定案）：CC Deck 自管域 ~/.cc-deck/engines/trae-agent——
 * agent-trae.ts 的 command 缺省解析链同引本常量（固定位 .venv/bin/trae-cli 可执行
 * 即用——wrapper 退役，CCR_TRAE_PATH 直指 venv cli 的免 env 回写形态）。 */
export function traeFixedRoot(): string {
  return process.env.CCR_TRAE_ROOT?.trim() || join(process.env.HOME || "~", ".cc-deck", "engines", "trae-agent");
}
export function traeFixedCli(): string {
  return join(traeFixedRoot(), ".venv", "bin", "trae-cli");
}

/** 补丁脚本解析：env 显式位 > 仓根 scripts/（src 上溯两级=relay，再上一级=仓根）。 */
function patchScriptPath(): string {
  const env = process.env.CCR_TRAE_PATCH_SCRIPT?.trim();
  if (env && existsSync(env)) return env;
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const cand = join(repoRoot, "scripts", "trae-servertool-patch.py");
  if (existsSync(cand)) return cand;
  return "";
}

/** trae 源树 anthropic_client.py 定位（trae 根推导——勘察 §二.2 同式）。
 * 接受任意 cli 路径（固定位/env 指位/PATH 名）；入参已是 .py（ensureTraeServerToolPatch
 * 复验路径）直接透传——防二次上溯错位。PATH 名（无 /）时回落固定位推导。 */
export function traeClientPyFor(cliPath: string): string {
  if (cliPath.endsWith(".py")) return cliPath;
  const p = cliPath.includes("/") ? cliPath : traeFixedCli();
  // …/bin/trae-cli → .venv → trae根 → trae_agent/utils/llm_clients/anthropic_client.py
  const root = dirname(dirname(dirname(p)));
  return join(root, "trae_agent", "utils", "llm_clients", "anthropic_client.py");
}

/** 审计单口：chain-audit.jsonl append（与 emitChainAudit 同行格式；engine 域三词）。 */
export function auditEngineEvent(action: "engine-install" | "engine-patch-apply" | "engine-patch-fail", detail: string): void {
  try {
    const dir = resolveDataDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "chain-audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), action, detail }) + "\n", "utf-8");
  } catch { /* 审计失败绝不阻断安装/对话主路径 */ }
}

/** 补丁态探测（零子进程——读文件 grep MARKER）。
 * applied=已打；missing=文件在但未打（升级覆盖/新装）；absent=源文件不在（未装/路径异常）。 */
export type TraePatchState = "applied" | "missing" | "absent";
export function traePatchState(cliPath?: string): TraePatchState {
  const py = traeClientPyFor(cliPath || process.env.CCR_TRAE_PATH || traeFixedCli());
  try {
    const src = readFileSync(py, "utf-8");
    return src.includes("W-ENGTRAE-UP") ? "applied" : "missing";
  } catch {
    return "absent";
  }
}

/** A 路·补丁自动应用（agent-trae.ts buildArgs 挂点 + 安装链末尾共用）。
 * 哲学同 ensureTraeConfigTemplate：失败不阻断 spawn（对话面照跑——补丁只影响工具
 * 执行面，缺补丁=trae 自身的「No command provided」循环会在轨迹里暴露）。
 * 升级重放：trae 升级覆盖源文件 → MARKER 消失 → missing → 重打（幂等设计天然覆盖）；
 * 上游重构锚漂移 → 脚本响亮失败 → 本函数降级为告警审计行。返回终态供测试/安装链复验。 */
export function ensureTraeServerToolPatch(cliPath?: string): TraePatchState {
  if (process.env.CCR_STUB_MODE) return "applied"; // 桩环境护栏（同 ensureTraeConfigTemplate——测试不碰真实安装）
  const py = traeClientPyFor(cliPath || process.env.CCR_TRAE_PATH || traeFixedCli());
  const before = traePatchState(py);
  if (before !== "missing") return before; // applied/absent 均零动作
  const script = patchScriptPath();
  if (!script) {
    auditEngineEvent("engine-patch-fail", "trae 兼容补丁脚本未找到（仓根 scripts/trae-servertool-patch.py 缺失——重装 CC Deck 可修复）；工具执行面暂不可用，对话不受阻");
    return "missing";
  }
  const r = spawnSync("python3", [script, py], { timeout: 30_000, encoding: "utf-8" });
  if (r.status === 0 && traePatchState(py) === "applied") {
    auditEngineEvent("engine-patch-apply", `trae 兼容补丁已应用（server-tool 旁路 → 泛型 ToolParam；GLM 等第三方 anthropic 兼容层工具执行面打通）→ ${py}`);
    return "applied";
  }
  const tail = String(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ");
  auditEngineEvent("engine-patch-fail", `trae 兼容补丁应用失败（${tail || `exit ${r.status}`}）——工具执行面暂不可用，对话不受阻；可手动：python3 ${script} ${py}`);
  return "missing";
}

// ---------- 安装状态机（内存态；前端 POST 启动 + GET 轮询） ----------

export interface EngineInstallState {
  engine: string;
  state: "running" | "done" | "fail";
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /** done 态补充：终态一行摘要（已装/新装/已装跳过） */
  summary?: string;
}

const installs = new Map<string, EngineInstallState>();

export function getEngineInstall(engine: string): EngineInstallState | null {
  return installs.get(engine) ?? null;
}

function run(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { ...opts, timeout: opts?.timeout ?? 300_000, encoding: "utf-8" });
  return { ok: r.status === 0, out: String(r.stdout || r.stderr || "").trim() };
}

function npmInstalledVersion(pkg: string): string {
  const r = run("npm", ["ls", "-g", pkg, "--depth=0"], { timeout: 30_000 });
  return r.ok && r.out.includes(`${pkg}@`) ? (r.out.match(new RegExp(`${pkg.replace("/", "\\/")}@([^\\s']+)`))?.[1] ?? "") : "";
}

/** 启动安装（异步跑，立即返回初始态）。幂等：已装探测→跳过+版本行（秒级 done）；
 * 同引擎 running 在场=拒绝重复启动（返回现有态由调用方 409 语义处理）。 */
export function startEngineInstall(engine: string): { started: boolean; state: EngineInstallState } {
  const spec = SPECS[engine];
  if (!spec) {
    const st: EngineInstallState = { engine, state: "fail", log: [`✗ 未知引擎「${engine}」——可装：qwen-code / codex / codebuddy / trae`], startedAt: Date.now(), finishedAt: Date.now(), summary: "未知引擎" };
    installs.set(engine, st);
    return { started: false, state: st };
  }
  const cur = installs.get(engine);
  if (cur && cur.state === "running") return { started: false, state: cur };
  const st: EngineInstallState = { engine, state: "running", log: [], startedAt: Date.now() };
  installs.set(engine, st);
  void (async () => {
    const log = (line: string) => { st.log.push(line); };
    try {
      if (spec.kind === "npm") {
        const ver = npmInstalledVersion(spec.npmPackage);
        if (ver) {
          log(`✓ ${engine} 已安装（npm ${spec.npmPackage}@${ver}）——跳过安装（已装幂等）`);
          st.state = "done"; st.summary = `已装 ${ver}（跳过）`;
        } else {
          log(`▸ npm install -g ${spec.npmPackage} …`);
          const r = run("npm", ["install", "-g", spec.npmPackage]);
          if (!r.ok) throw new Error(`npm 安装失败：${r.out.split("\n").slice(-3).join(" ") || "exit 非 0"}`);
          log(`✓ npm 安装完成`);
          const after = npmInstalledVersion(spec.npmPackage);
          if (after) log(`✓ 版本 ${after}`);
          // preflight 复验（which 探测）
          const pf = run("which", [engine === "codebuddy" ? "codebuddy-code" : engine === "qwen-code" ? "qwen" : engine]);
          log(pf.ok ? "✓ preflight 复验过（CLI 已在 PATH）" : `⚠ preflight 复验：CLI 未探测到（重开终端/新 shell 生效——npm -g bin 目录需在 PATH）`);
          st.state = "done"; st.summary = `新装${after ? " " + after : ""}`;
        }
      } else {
        // trae 全链（勘察 §五 步骤 1-4+6+补丁；每步 idempotent）
        const root = traeFixedRoot();
        // 步1 python3 ≥3.10
        const pyv = run("python3", ["--version"], { timeout: 10_000 });
        const m = pyv.out.match(/Python (\d+)\.(\d+)/);
        const pyOk = !!m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 10));
        if (!pyOk) throw new Error(`python3 版本不足（${pyv.out || "未探测到"}——需 ≥3.10）`);
        log(`✓ Python ${m?.[1]}.${m?.[2]} ≥3.10`);
        // 步2 uv
        let uvOk = run("which", ["uv"]).ok;
        if (!uvOk) {
          log("▸ uv 未装——官方脚本安装（astral.sh）…");
          const r = run("sh", ["-c", 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { timeout: 180_000 });
          uvOk = r.ok;
          log(uvOk ? "✓ uv 安装完成" : `⚠ uv 安装失败（${r.out.split("\n").slice(-2).join(" ") || "网络"}）——可手动装后重试；uv 通常在 ~/.local/bin/uv`);
          if (uvOk) process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH || ""}`;
        } else log("✓ uv 已装");
        if (!uvOk) throw new Error("uv 不可用（上一步失败）——先手动安装 uv 再点安装");
        // 步3 clone 固定位（已在场=跳过+版本探测）
        if (existsSync(join(root, ".git"))) {
          const rev = run("git", ["-C", root, "rev-parse", "--short", "HEAD"], { timeout: 10_000 });
          log(`✓ 源码已在场（${rev.out || "?"}）——跳过 clone（已装幂等）`);
        } else {
          log(`▸ git clone --depth 1 bytedance/trae-agent → ${root} …`);
          mkdirSync(dirname(root), { recursive: true });
          const r = run("git", ["clone", "--depth", "1", "https://github.com/bytedance/trae-agent.git", root], { timeout: 600_000 });
          if (!r.ok) throw new Error(`clone 失败：${r.out.split("\n").slice(-2).join(" ") || "网络（GitHub 可达性）"}`);
          log("✓ clone 完成");
        }
        // 步4 uv sync（幂等：依赖已装秒过）
        log("▸ uv sync（建/补 .venv 依赖）…");
        const sync = run("uv", ["sync"], { cwd: root, timeout: 600_000 });
        if (!sync.ok) throw new Error(`uv sync 失败：${sync.out.split("\n").slice(-3).join(" ") || "exit 非 0"}`);
        log("✓ .venv 就绪");
        // 步5 补丁自动应用（同 spawn 前挂点函数——升级重放即此处+buildArgs 双保险）
        const patch = ensureTraeServerToolPatch(traeFixedCli());
        log(patch === "applied" ? "✓ trae 兼容补丁已应用（工具执行面就绪）" : "⚠ 补丁未应用（对话可用，工具执行暂缺——见审计行/手动 python3 scripts/trae-servertool-patch.py）");
        // 步6 preflight 复验
        try { accessSync(traeFixedCli(), constants.X_OK); log("✓ preflight 复验过（.venv/bin/trae-cli 可执行）"); } catch { throw new Error("preflight 复验失败：.venv/bin/trae-cli 不可执行"); }
        log(`ℹ 引擎位：${traeFixedCli()}（CCR_TRAE_PATH 未设时自动探测此固定位）`);
        st.state = "done"; st.summary = "trae 全链就绪（源码+venv+补丁）";
      }
      auditEngineEvent("engine-install", `${engine} 安装完成：${st.summary ?? ""}`);
    } catch (e) {
      st.log.push(`✗ ${e instanceof Error ? e.message : String(e)}`);
      st.state = "fail"; st.summary = "失败（见日志行）";
      auditEngineEvent("engine-install", `${engine} 安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      st.finishedAt = Date.now();
    }
  })();
  return { started: true, state: st };
}
