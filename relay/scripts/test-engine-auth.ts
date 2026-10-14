// #102 批 A 引擎登录态探针测试件（relay 半）：probeEngineAuth 三态判定（ready/
// needs_auth × preflight unavailable 正交）+ codex 认配置优先（中转 token 不误报——
// 1014 本机实锤反例锚死）+ codebuddy auth status 探测 + qwen/trae 凭据文件存在性 +
// authFailureHint 运行时兜底 pattern + HINTS 文案规范。web 渲染面锚在
// test-005-engauth-web.ts（A-H 段），catalog 协议+创建拦截集成在
// test-75r-engine-catalog.ts（S1④⑤⑥/S4/S7g-i）——三件各半不重叠。
//
// 矩阵（四段）：
//   P1  codex 十场景：中转 bearer token（experimental_/裸 key 两形态）→ ready 不误报 /
//       空值 token 不认 / auth.json → ready / OPENAI_API_KEY → ready / CODEX_HOME 显式
//       优先 / 三源全无+Not logged in → needs_auth+hint / Logged in → ready / 探针故障
//       fail-open
//   P2  codebuddy 三场景：Authentication required → needs_auth+hint / 正常输出 → ready /
//       探针故障 fail-open（1014 根因案例探针面锁死）
//   P3  qwen-code/trae 凭据文件存在性（候选命中 ready / 空 home needs_auth / env 候选）+
//       claude/zcode 恒 ready（免检/占位）；P3' 缓存行为（无 opts 生产路径 45s TTL
//       命中/reset 重探——SNAPSHOT 防 spawn 风暴语义锁死）
//   P4  authFailureHint pattern 三命中 + 非登录文本 null + HINTS 文案规范（动词开头）+
//       onTurnEnd 回合成功清位锚（session-manager relay 半）
//
// fixture：mkdtemp home（.codex/config.toml、.qwen/oauth_creds.json 等）+ mkdtemp bin
// 假脚本（cat 固定输出，chmod 755 过 preflightEngine X_OK——探针缝与 CCR_*_PATH 注入
// 同 75r S3 惯例）。env 全程保存/恢复（本件碰 CCR_CODEX_PATH/CCR_CODEBUDDY_PATH/
// CODEX_HOME/OPENAI_API_KEY/QWEN_API_KEY/GEMINI_API_KEY/ANTHROPIC_API_KEY/
// ANTHROPIC_AUTH_TOKEN/TRAE_API_KEY 九键）。
//
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   node --import tsx/esm scripts/test-engine-auth.ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authFailureHint, probeEngineAuth, resetEngineAuthCache } from "../src/engine-auth.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

// ---------- fixture：假脚本 bin + 可写 home ----------
const BIN = mkdtempSync(join(tmpdir(), "ccr-auth-bin-"));
const HOME = mkdtempSync(join(tmpdir(), "ccr-auth-home-"));
const mkScript = (name: string, output: string) => {
  const p = join(BIN, name);
  writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`);
  chmodSync(p, 0o755);
  return p;
};
const CODEX_NOT_LOGGED = mkScript("codex-not-logged", "Not logged in: run `codex login`");
const CODEX_LOGGED_IN = mkScript("codex-logged-in", "Logged in using ChatGPT");
const CB_AUTH_REQUIRED = mkScript("cb-auth-required", "Authentication required. Please use /login command to sign in to your account");
const CB_HEALTHY = mkScript("cb-healthy", "Signed in as tester@example.com (Plus)");

// ---------- env 九键保存/清场/恢复（零生产触达） ----------
const ENV_KEYS = ["CCR_CODEX_PATH", "CCR_CODEBUDDY_PATH", "CODEX_HOME", "OPENAI_API_KEY",
  "QWEN_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "TRAE_API_KEY"] as const;
const SAVED: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
const restoreEnv = () => { for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } };

try {
  // ---------- P1 codex：认配置优先（中转 token 不误报）+ 登录探测 + fail-open ----------
  section("P1 codex 认配置优先与登录探测");
  // a. 中转 bearer token（experimental_ 前缀形态——1014 本机比特AI中转实锤）→ 认配置
  //    优先直接 ready，即使探针会吐 Not logged in 也不误报
  mkdirSync(join(HOME, ".codex"), { recursive: true });
  writeFileSync(join(HOME, ".codex", "config.toml"),
    '[model_providers "bitproxy"]\nbase_url = "https://proxy.example/v1"\nexperimental_bearer_token = "sk-bit-xxx"\n');
  process.env.CCR_CODEX_PATH = CODEX_NOT_LOGGED;
  let r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "ready", "P1a config.toml 带 experimental_bearer_token → ready（中转配置在场跳过登录探测——不误报）");
  // b. 裸 bearer_token 键形态（非 experimental 前缀）同认
  writeFileSync(join(HOME, ".codex", "config.toml"),
    '[model_providers "p2"]\nbearer_token = "sk-plain"\n');
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "ready", "P1b config.toml 裸 bearer_token 键 → ready（两键形态同认）");
  // c. 空值 token 不认（= "非空" 才算——防空白配置伪装在场）；此时探针被走到
  writeFileSync(join(HOME, ".codex", "config.toml"),
    '[model_providers "p3"]\nbearer_token = ""\n');
  process.env.CCR_CODEX_PATH = CODEX_LOGGED_IN;
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "ready", "P1c 空值 token 不认配置 → 走探针（Logged in → ready，探针确实被走到）");
  process.env.CCR_CODEX_PATH = CODEX_NOT_LOGGED;
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "needs_auth" && typeof r.auth_hint === "string" && r.auth_hint.length > 0,
    "P1d 空值 token + Not logged in 输出 → needs_auth+hint 非空（认配置与探测正交验证）");
  // d. auth.json 在场（ChatGPT 登录态文件）→ ready，探针吐 Not logged in 也不管
  writeFileSync(join(HOME, ".codex", "auth.json"), '{"OPENAI_API_KEY":null,"tokens":{}}');
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "ready", "P1e auth.json 存在 → ready（三源之二：文件登录态，优先于探针）");
  rmSync(join(HOME, ".codex", "auth.json"));
  // e. OPENAI_API_KEY env → ready（三源之三）
  process.env.OPENAI_API_KEY = "sk-test-key";
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "ready", "P1f OPENAI_API_KEY env 在场 → ready（三源之三：env key）");
  delete process.env.OPENAI_API_KEY;
  // f. 三源全无 + Not logged in → needs_auth（hint 动词开头+含 codex 字样）
  writeFileSync(join(HOME, ".codex", "config.toml"), "# empty config\n");
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "needs_auth" && /codex/i.test(r.auth_hint ?? "") && /^终端/.test(r.auth_hint ?? ""),
    "P1g 三源全无 + Not logged in → needs_auth，hint 动词开头（终端…）且含 codex");
  // g. 三源全无 + Logged in → ready
  process.env.CCR_CODEX_PATH = CODEX_LOGGED_IN;
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "ready", "P1h Logged in 输出 → ready");
  // h. 探针命令故障（不存在路径）→ fail-open ready（宁可漏报不锁引擎）
  process.env.CCR_CODEX_PATH = join(BIN, "no-such-bin");
  r = probeEngineAuth("codex", { homeDir: HOME });
  assert(r.state === "ready", "P1i 探针故障 fail-open → ready（spawn error 不误锁）");
  // i. CODEX_HOME 显式优先于 homeDir 参数（codex CLI 同语义）
  const ALT = mkdtempSync(join(tmpdir(), "ccr-auth-alt-"));
  mkdirSync(join(ALT, "codex-conf"), { recursive: true });
  writeFileSync(join(ALT, "codex-conf", "config.toml"), 'bearer_token = "sk-alt"\n');
  process.env.CODEX_HOME = join(ALT, "codex-conf");
  process.env.CCR_CODEX_PATH = CODEX_NOT_LOGGED;
  r = probeEngineAuth("codex", { homeDir: HOME }); // HOME 的 config 是空壳，ALT 才带 token
  assert(r.state === "ready", "P1j CODEX_HOME 显式优先（ALT 带 token 判 ready，不看 homeDir）");
  delete process.env.CODEX_HOME;
  rmSync(ALT, { recursive: true, force: true });

  // ---------- P2 codebuddy：auth status 探测（1014 根因案例） ----------
  section("P2 codebuddy auth status 探测");
  process.env.CCR_CODEBUDDY_PATH = CB_AUTH_REQUIRED;
  r = probeEngineAuth("codebuddy", { homeDir: HOME });
  assert(r.state === "needs_auth" && typeof r.auth_hint === "string" && /登录|login/i.test(r.auth_hint ?? ""),
    "P2a Authentication required 输出 → needs_auth+hint（1014 根因案例：装了未登录不再静默放行）");
  process.env.CCR_CODEBUDDY_PATH = CB_HEALTHY;
  r = probeEngineAuth("codebuddy", { homeDir: HOME });
  assert(r.state === "ready", "P2b 已登录输出（Signed in）→ ready");
  process.env.CCR_CODEBUDDY_PATH = join(BIN, "no-such-cb");
  r = probeEngineAuth("codebuddy", { homeDir: HOME });
  assert(r.state === "ready", "P2c 探针故障 fail-open → ready");
  delete process.env.CCR_CODEBUDDY_PATH;
  delete process.env.CCR_CODEX_PATH;

  // ---------- P3 qwen-code/trae 凭据文件 + claude/zcode 恒 ready ----------
  section("P3 qwen-code/trae 凭据文件与免检引擎");
  mkdirSync(join(HOME, ".qwen"), { recursive: true });
  writeFileSync(join(HOME, ".qwen", "oauth_creds.json"), "{}");
  r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "ready", "P3a qwen oauth_creds.json 存在 → ready");
  rmSync(join(HOME, ".qwen", "oauth_creds.json"));
  r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "needs_auth" && (r.auth_hint ?? "").length > 0, "P3b qwen 无凭据无 env → needs_auth+hint");
  process.env.QWEN_API_KEY = "qk-1";
  r = probeEngineAuth("qwen-code", { homeDir: HOME });
  assert(r.state === "ready", "P3c qwen env key 在场 → ready（候选 env 路径）");
  delete process.env.QWEN_API_KEY;
  mkdirSync(join(HOME, ".trae"), { recursive: true });
  writeFileSync(join(HOME, ".trae", ".credentials.json"), "{}");
  r = probeEngineAuth("trae", { homeDir: HOME });
  assert(r.state === "ready", "P3d trae .credentials.json 存在 → ready");
  rmSync(join(HOME, ".trae", ".credentials.json"));
  r = probeEngineAuth("trae", { homeDir: HOME });
  assert(r.state === "needs_auth", "P3e trae 无凭据 → needs_auth");
  r = probeEngineAuth("claude", { homeDir: HOME });
  assert(r.state === "ready", "P3f claude 恒 ready（relay 进程即 SDK 免检）");
  r = probeEngineAuth("zcode", { homeDir: HOME });
  assert(r.state === "ready", "P3g zcode 恒 ready（枚举占位，catalog unsupported 分支不会调到）");
  // P3' 缓存行为（无 opts = 生产路径 45s TTL；带 opts = 测试旁路零缓存——P1-P3 全程
  // 带 homeDir 不碰缓存，本段专测缓存语义）
  section("P3' probe 缓存行为（45s TTL）");
  resetEngineAuthCache();
  process.env.CODEX_HOME = join(BIN, "empty-home"); // BIN 下无 config/auth.json——三源全无
  process.env.CCR_CODEX_PATH = CODEX_NOT_LOGGED;
  const c1 = probeEngineAuth("codex"); // 无 opts：生产路径，结果进缓存
  assert(c1.state === "needs_auth", "P3h 无 opts 生产路径首探 needs_auth（进缓存）");
  process.env.CCR_CODEX_PATH = CODEX_LOGGED_IN; // env 已变
  const c2 = probeEngineAuth("codex");
  assert(c2.state === "needs_auth", "P3i TTL 内缓存命中：env 变更不出新结果（SNAPSHOT 防 spawn 风暴——登录后 ≤45s 自愈）");
  resetEngineAuthCache();
  const c3 = probeEngineAuth("codex");
  assert(c3.state === "ready", "P3j reset 后重探：新 env 生效（Logged in → ready）");
  resetEngineAuthCache();
  delete process.env.CODEX_HOME;
  delete process.env.CCR_CODEX_PATH;

  // ---------- P4 authFailureHint 运行时兜底 pattern + HINTS 文案规范 ----------
  section("P4 authFailureHint pattern 与 hint 文案");
  const h1 = authFailureHint("Error: Not logged in. Run codex login", "codex");
  assert(h1 !== null && /codex/i.test(h1), "P4a Not logged in 命中 → codex hint");
  const h2 = authFailureHint("Authentication required. Please use /login command", "codebuddy");
  assert(h2 !== null && h2.length > 0, "P4b Authentication required 命中 → codebuddy hint");
  const h3 = authFailureHint("会话失败：请先登录后重试", undefined);
  assert(h3 !== null && /登录/.test(h3), "P4c 中文「请先登录」命中 → 通用指引（引擎未知）");
  assert(authFailureHint("command not found: codex", "codex") === null, "P4d 非登录态故障 → null（不误标）");
  assert(authFailureHint("engine exited with status 1", "trae") === null, "P4e 普通退出错误 → null");
  // hint 文案规范（更新说明军规口径：动词开头、含具体命令、不写内部机制词）
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const engineAuthSrc = readFileSync(join(srcDir, "engine-auth.ts"), "utf-8");
  const hintsBlock = /const HINTS: Record<string, string> = \{[\s\S]*?\};/.exec(engineAuthSrc)?.[0] ?? "";
  assert(hintsBlock !== "", "P4f HINTS 表可提取");
  const hintLines = [...hintsBlock.matchAll(/"?((?:codex|codebuddy|qwen-code|trae))"?: "([^"]+)"/g)];
  assert(hintLines.length === 4, "P4g HINTS 恰四引擎（codex/codebuddy/qwen-code/trae——claude/zcode 免检无 hint）");
  assert(hintLines.every((m) => /运行|启动|输入|配置|设置/.test(m[2])),
    "P4h 每条 hint 含动作词+具体命令（终端运行/输入 /login/设置环境变量——军规口径）");
  assert(hintLines.every((m) => !/SDK|SNAPSHOT|relay|endpoint|HTTP/i.test(m[2])),
    "P4i hint 无内部机制词（SDK/relay/endpoint 等不进用户文案——军规口径）");
  // relay 半清位锚：回合成功=登录态恢复（或兜底误报自愈），onTurnEnd ok 分支清标记
  const smSrc = readFileSync(join(srcDir, "session-manager.ts"), "utf-8");
  assert(/if \(managed\.state\.auth_hint\) managed\.state\.auth_hint = undefined/.test(smSrc),
    "P4j relay 半清位锚：回合成功清 needs_auth 标记（onTurnEnd ok 分支）");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  restoreEnv();
  rmSync(BIN, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
}
