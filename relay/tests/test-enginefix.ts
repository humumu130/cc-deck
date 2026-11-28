// [W-ENGINEFIX]（1124 用户实锤两报错）锚件：异引擎新建会话双刀——
//   刀A codebuddy 模型回落：全局当前模型串（Claude 系，如 glm-5.3[1m]）不再原文
//       传异引擎白名单 throw「未知模型」——resolveForeignEngineModel 分档单一事实源
//       （codebuddy 白名单∪custom: 放行，其余回落空串=omit --model）+
//       createRegisteredEngine 漏斗归一（全 spawn 入口）+ create() selectedModel 分档
//       接线锚（state.model 显示面与 spawn 同源）。
//   刀B qwen auth 前置收紧：单 env 键不再判 ready（上游组合制选型下单键不选型——
//       ANTHROPIC_API_KEY 单键假 ready 直通 spawn 即 CLI 裸炸「No auth type is
//       selected」，用户截图原文）；凭据文件候选保留（真登录产物不误拦）；
//       authFailureHint 补「no auth type is selected」pattern（运行时兜底链挂
//       auth_hint）。COMMAND_CREATE needs_auth 前置闸（session-commands #102 批A）
//       随探针收紧由假 ready 变真拦截——闸本体接线在此文本锚锁死。
//
// 矩阵（两组）：
//   A 组  模型分档：A1-A6 纯函数九例（codebuddy 白名单/custom:/default/空、
//        qwen/trae 恒回落）；A7-A8 漏斗端到端（假 bin 过 preflight，buildArgs 出参
//        无/有 --model）；A9 create() 接线锚（文本）。
//   B 组  qwen auth：B1 空 home → needs_auth+人话指引；B2 settings selectedType →
//        ready；B3 单键 ANTHROPIC_API_KEY（实锤形态）→ needs_auth；B4 anthropic
//        三键组合 → ready；B5 oauth_creds.json → ready；B6/B7 authFailureHint
//        新 pattern 命中/非登录文本 null；B8 COMMAND_CREATE 闸接线文本锚。
//
// fixture：mkdtemp home + 假 bin（cat 脚本 chmod 755 过 preflightEngine X_OK——
// test-engine-auth 同款惯例）。env 保存/恢复零生产触达。
//
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   node --import tsx/esm tests/test-enginefix.ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authFailureHint, probeEngineAuth } from "../src/engine-auth.js";
import { createRegisteredEngine, resolveForeignEngineModel } from "../src/engine-registry.js";
import { CODEBUDDY_MODELS } from "../src/agent-codebuddy.js";
import type { AgentCallbacks } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

const here = dirname(fileURLToPath(import.meta.url));

// ---------- fixture：假 bin + 可写 home ----------
const BIN = mkdtempSync(join(tmpdir(), "ccr-engfix-bin-"));
const HOME = mkdtempSync(join(tmpdir(), "ccr-engfix-home-"));
// codebuddy 假 bin：preflightEngine 只探在场/X_OK，不执行——echo 即可（真实 spawn 不触发）
const CB_BIN = join(BIN, "codebuddy-fake");
writeFileSync(CB_BIN, "#!/bin/sh\necho ok\n");
chmodSync(CB_BIN, 0o755);

// env 键保存/清场/恢复（qwen 组合制五键 + 通路键）
const ENV_KEYS = ["CCR_CODEBUDDY_PATH", "CCR_QWEN_PATH", "QWEN_OAUTH", "QWEN_API_KEY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "QWEN_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL"] as const;
const SAVED: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
const restoreEnv = () => { for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } };

const quietCb: AgentCallbacks = {
  onStatusChange: () => {}, onLog: () => {}, onUsage: () => {}, onInit: () => {},
  onTurnEnd: () => {}, onTodos: () => {}, onArtifacts: () => {},
} as unknown as AgentCallbacks;

try {
  // ================= A 组：刀A 模型分档 =================
  section("A 组 codebuddy 模型回落/白名单（resolveForeignEngineModel 分档单一事实源）");
  // A1 用户实锤原文：全局 Claude 系串（[1m] 水位后缀）→ codebuddy 白名单 miss → 回落
  assert(resolveForeignEngineModel("codebuddy", "glm-5.3[1m]") === "", "A1a codebuddy + 全局串 glm-5.3[1m] → 回落空串（omit --model，引擎自选默认）");
  assert(resolveForeignEngineModel("codebuddy", "claude-sonnet-4.6") === "", "A1b codebuddy + claude 系串 → 回落空串");
  // A2 内置白名单放行（选 codebuddy 自己的模型不受影响——验收点1 后半）
  assert(CODEBUDDY_MODELS.includes("glm-5.3") && resolveForeignEngineModel("codebuddy", "glm-5.3") === "glm-5.3", "A2a codebuddy + 内置 glm-5.3 → 原文放行");
  assert(resolveForeignEngineModel("codebuddy", "kimi-k3.1-pro") === "kimi-k3.1-pro", "A2b codebuddy + 内置 kimi-k3.1-pro → 原文放行");
  // A3 custom: 逃生前缀（词表漂移逃生门——白名单 fail-fast 不误伤自定义）
  assert(resolveForeignEngineModel("codebuddy", "custom:my-own") === "custom:my-own", "A3 codebuddy + custom: 前缀 → 原文放行（逃生门）");
  // A4 既有豁免语义维持
  assert(resolveForeignEngineModel("codebuddy", "") === "" && resolveForeignEngineModel("codebuddy", "default") === "" && resolveForeignEngineModel("codebuddy", "codebuddy") === "", "A4 空/default/codebuddy → 空串（buildArgs 既有豁免同款）");
  // A5 无源级清单引擎恒回落（buildArgs 本就不消费 --model——codex 同型先例）
  assert(resolveForeignEngineModel("qwen-code", "glm-5.3[1m]") === "" && resolveForeignEngineModel("trae", "gpt-x") === "", "A5 qwen-code/trae 任意显式串 → 空串（无清单不冒充，等价显式忽略）");

  section("A 组（续）createRegisteredEngine 漏斗归一（全 spawn 入口单点）");
  process.env.CCR_CODEBUDDY_PATH = CB_BIN;
  // A7 漏斗端到端：实锤串不再 throw「未知模型」——建会话成功 + argv 无 --model
  const leakSession = createRegisteredEngine("codebuddy", { cwd: BIN, model: "glm-5.3[1m]", cb: quietCb });
  assert(!!leakSession, "A7a codebuddy 漏斗：全局串经归一后建会话不 throw（1124 实锤「新建会话失败：未知模型」收口）");
  const leakArgs = leakSession ? (leakSession as unknown as { buildArgs(p: string): string[] }).buildArgs("hi") : [];
  assert(!leakArgs.includes("--model"), "A7b 归一后 buildArgs 无 --model（CLI 自选默认——「默认模型」语义）");
  // A8 内置模型透传不扰
  const validSession = createRegisteredEngine("codebuddy", { cwd: BIN, model: "glm-5.3", cb: quietCb });
  const validArgs = validSession ? (validSession as unknown as { buildArgs(p: string): string[] }).buildArgs("hi") : [];
  assert(validArgs.includes("--model") && validArgs[validArgs.indexOf("--model") + 1] === "glm-5.3", "A8 codebuddy + 内置 glm-5.3：漏斗透传，argv 带 --model glm-5.3（显式选择不受回落扰）");
  // A9 create() 接线锚：selectedModel 分档在 newAgent/state 之前（显示面与 spawn 同源真值）
  const sm = readFileSync(join(here, "..", "src", "session-manager.ts"), "utf-8");
  assert(sm.includes("resolveForeignEngineModel(engineRaw, rawModel)"), "A9 create() selectedModel 分档接线锚（engineRaw 分档在 state.model 落位前——端上不再显示误导性全局模型名）");

  // ================= B 组：刀B qwen auth 前置收紧 =================
  section("B 组 qwen auth 前置（探针收紧——非交互权威闸=「已选型」）");
  // B1 空 home 无 env：needs_auth + 人话指引（含 --auth-type 一次终端登录指引——验收点2）
  let r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "needs_auth" && (r.auth_hint ?? "").includes("--auth-type"), "B1 未配置（空 home 无 env）→ needs_auth + 指引含 --auth-type（COMMAND_CREATE 闸拦下给人话，不再裸 CLI 报错会话卡）");
  // B2 已配置（settings 选型位）→ ready（验收点2 前半：已配置机器正常起）
  mkdirSync(join(HOME, ".qwen"), { recursive: true });
  writeFileSync(join(HOME, ".qwen", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "anthropic" } } }));
  r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "ready", "B2 settings security.auth.selectedType 在场 → ready（已配置机器创建直通）");
  rmSync(join(HOME, ".qwen", "settings.json"));
  // B3 用户实锤形态：单键 ANTHROPIC_API_KEY（全局常配 env）不再假 ready
  process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
  r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "needs_auth", "B3 单键 ANTHROPIC_API_KEY → needs_auth（1124 收紧：组合制下单键不选型——假 ready 直通 spawn 即裸炸，本单根因形态）");
  delete process.env.ANTHROPIC_API_KEY;
  // B4 anthropic 三键组合（上游 getAuthTypeFromEnv 组合制）→ ready
  process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
  process.env.ANTHROPIC_BASE_URL = "https://api.example/v1";
  process.env.ANTHROPIC_MODEL = "glm-5.3";
  r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "ready", "B4 anthropic 三键组合（KEY+BASE_URL+MODEL）→ ready（完整 env 选型不误拦）");
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_MODEL;
  // B5 凭据文件候选保留（真登录产物不误拦——fail-open 精神保留给登录完成态）
  writeFileSync(join(HOME, ".qwen", "oauth_creds.json"), "{}");
  r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "ready", "B5 oauth_creds.json 凭据文件在场 → ready（登录完成态保留宽松）");
  rmSync(join(HOME, ".qwen", "oauth_creds.json"));

  section("B 组（续）运行时兜底 pattern + 创建闸接线锚");
  // B6 实锤报错原文命中 → qwen 人话指引（探针漏网时 spawn 后进 needs_auth 态带 hint）
  const hint6 = authFailureHint("No auth type is selected. Please configure an auth type (e.g. via settings or --auth-type) before running in non-interactive mode", "qwen-code");
  assert(!!hint6 && hint6.includes("--auth-type"), "B6 authFailureHint 命中「No auth type is selected」→ qwen 选型指引（运行时兜底链）");
  // B7 非登录态文本不误挂
  assert(authFailureHint("panic: runtime error", "qwen-code") === null, "B7 非登录态崩溃文本 → null（不误挂 auth_hint）");
  // B8 COMMAND_CREATE needs_auth 前置闸接线锚（#102 批A 既有闸——本单探针收紧后由假 ready 变真拦截）
  const sc = readFileSync(join(here, "..", "src", "commands", "session-commands.ts"), "utf-8");
  assert(sc.includes("probeEngineAuth(engineResolved)") && sc.includes("needs_auth: true"), "B8 COMMAND_CREATE 闸接线锚（engineResolved 非 claude 先探登录态，needs_auth 拒创建返结构化错误+auth_hint）");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  restoreEnv();
  rmSync(BIN, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
}
