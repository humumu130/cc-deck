// W-ENGDIST-A（t-2b1165a2）：引擎一键安装+trae 补丁自动应用——纯 fs/行为级断言件
// 环境护栏：CCR_DATA_DIR 指 tmp（审计行落测试域不碰生产 chain-audit）；npm 行为级用
// 本机已装引擎的「跳过」路径（不真装不真卸——真装全链在回执人工真测面）。
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = (p: string) => join(root, p);
let pass = 0, fail = 0;
function ok(cond: boolean, name: string, detail = "") {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "——" + detail : ""}`); }
}

console.log("# engdista：引擎一键安装 + trae 补丁自动应用");

// ---------- ① 前端安装引导锚（settings-domain） ----------
const sd = readFileSync(rel("web-console/js/settings-domain.js"), "utf-8");
ok(sd.includes('data-engine-install="${esc(e.id)}"') && sd.includes("一键安装"), "件③ 引擎行未安装态安装钮");
ok(sd.includes('ENGINE_INSTALLABLE = { "qwen-code": 1, codex: 1, codebuddy: 1, trae: 1 }'), "件③ 可装四引擎白名单（zcode 不给钮）");
ok(sd.includes('closest("[data-engine-install]")') && sd.includes("installEngine("), "件③ 点击委托→installEngine");
ok(sd.includes("/api/engine-install?token=") && sd.includes("refreshAllData();"), "件③ POST 启动+轮询+终态 refreshAllData 刷新引擎态");
ok(!/fetch\((?![^)]*token)[^)]*engine-install/.test(sd), "件③ 安装 API 调用恒带 token（鉴权）");

// ---------- ② 路由+词表锚（relay） ----------
const ws = readFileSync(rel("relay/src/ws-server.ts"), "utf-8");
ok(ws.includes('"/api/engine-install"') && ws.includes("startEngineInstall") && ws.includes("getEngineInstall"), "件① POST/GET 两路由挂载");
ok(ws.includes('url.searchParams.get("token") ?? "") !== cfg.token'), "件① token 鉴权（同 plugin-config 面）");
const types = readFileSync(rel("relay/src/types.ts"), "utf-8");
ok(types.includes('"engine-install",') && types.includes('"engine-patch-apply",') && types.includes('"engine-patch-fail",'), "审计词表三新词（CHAIN_AUDIT_ACTIONS）");

// ---------- ③ agent-trae 挂点+固定位链（件②④） ----------
const at = readFileSync(rel("relay/src/agent-trae.ts"), "utf-8");
ok(at.includes("ensureTraeServerToolPatch(this.opts.command);") && at.includes("ensureTraeConfigTemplate();"), "件② buildArgs 挂点（模板后补丁，spawn 前）");
ok(at.includes("function traeCommandDefault()") && at.includes("traeFixedCli(), constants.X_OK") && at.includes('?? traeCommandDefault()'), "件④ 缺省链：opts>CCR_TRAE_PATH>固定位>PATH（wrapper 退役）");
ok(at.includes('import { ensureTraeServerToolPatch, traeFixedCli } from "./engine-install.js"'), "引擎域内聚 import（无环纪律）");

// ---------- ④ 行为级：traePatchState 三态 + ensureTraeServerToolPatch 真打（fixture） ----------
process.env.CCR_DATA_DIR = mkdtempSync(join(tmpdir(), "engdista-data-"));
const engdista = await import("../src/engine-install.js");

const fxRoot = mkdtempSync(join(tmpdir(), "engdista-trae-"));
const clientPy = join(fxRoot, "trae_agent", "utils", "llm_clients", "anthropic_client.py");
mkdirSync(join(fxRoot, "trae_agent", "utils", "llm_clients"), { recursive: true });
// 补丁脚本可跑化：用仓内真脚本（CCR_TRAE_PATCH_SCRIPT 指真位）——fixture client.py 写
// **合法 Python** 的未打补丁形态（py_compile 是补丁脚本的终验环节——悬空缩进的伪源会被
// 它拦截，首版 fixture 即栽在此：脚本先写后验，文件已成补丁态但 exit 1——测试件要点）。
const realPatch = rel("scripts/trae-servertool-patch.py");
writeFileSync(clientPy, [
  "import anthropic.types",
  "from anthropic.types import TextEditor20250429",
  "",
  "",
  "def convert(tools):",
  "    if tools:",
  "        tool_schemas = []",
  "        for tool in tools:",
  '                if tool.name == "str_replace_based_edit_tool":',
  "                    tool_schemas.append(",
  "                        TextEditor20250429(",
  '                            name="str_replace_based_edit_tool",',
  '                            type="text_editor_20250429",',
  "                        )",
  "                    )",
  '                elif tool.name == "bash":',
  "                    tool_schemas.append(",
  '                        anthropic.types.ToolBash20250124Param(name="bash", type="bash_20250124")',
  "                    )",
  "                else:",
  "                    tool_schemas.append(",
  "                        anthropic.types.ToolParam(",
  "                            name=tool.name,",
  "                            description=tool.description,",
  "                            input_schema=tool.get_input_schema(),",
  "                        )",
  "                    )",
  "",
].join("\n"), "utf-8");

// 固定位根覆写（不碰 ~/.cc-deck 真域）：CCR_TRAE_ROOT 指 fixture
process.env.CCR_TRAE_ROOT = fxRoot;
process.env.CCR_TRAE_PATCH_SCRIPT = existsSync(realPatch) ? realPatch : "";
delete process.env.CCR_STUB_MODE;
// 注意：engine-install.ts 的 traeFixedCli/traeClientPyFor 读 env 在调用时（非 import 时）——env 后置有效
const cliPath = join(fxRoot, ".venv", "bin", "trae-cli");

ok(engdista.traePatchState(cliPath) === "missing", "④ traePatchState=missing（未打补丁态）");
ok(!existsSync(join(fxRoot, "trae_agent", "utils", "llm_clients", "anthropic_client.py.orig-bak")), "④ 打前无备份");
const st1 = engdista.ensureTraeServerToolPatch(cliPath);
ok(st1 === "applied", `④ ensureTraeServerToolPatch 真打→applied（CCR_TRAE_PATCH_SCRIPT=${process.env.CCR_TRAE_PATCH_SCRIPT ? "真脚本" : "缺"}）`);
const patched = readFileSync(clientPy, "utf-8");
ok(patched.includes("W-ENGTRAE-UP") && patched.includes("if False and tool.name =="), "④ 补丁形态（两特判旁路+标记）");
ok(existsSync(join(fxRoot, "trae_agent", "utils", "llm_clients", "anthropic_client.py.orig-bak")), "④ .orig-bak 备份在场");
ok(engdista.traePatchState(cliPath) === "applied", "④ 打后态=applied");
const st2 = engdista.ensureTraeServerToolPatch(cliPath);
ok(st2 === "applied", "④ 幂等：二次调用零动作仍 applied");
const audit = readFileSync(join(process.env.CCR_DATA_DIR, "chain-audit.jsonl"), "utf-8");
ok(audit.includes('"action":"engine-patch-apply"') && audit.includes("trae 兼容补丁已应用"), "④ 审计行落 chain-audit（engine-patch-apply）");

// absent 态（cli 指不存在路径）
ok(engdista.traePatchState(join(fxRoot, "nowhere", "cli")) === "absent", "④ absent 态（源文件不在）");
// 桩护栏
process.env.CCR_STUB_MODE = "1";
ok(engdista.ensureTraeServerToolPatch(join(fxRoot, ".missing-cli")) === "applied", "④ CCR_STUB_MODE 护栏（零动作）");
delete process.env.CCR_STUB_MODE;

// ---------- ⑤ 行为级：startEngineInstall 状态机（未知引擎/已装跳过路径） ----------
const r0 = engdista.startEngineInstall("not-an-engine");
ok(r0.state.state === "fail" && r0.state.log[0].includes("未知引擎"), "⑤ 未知引擎→fail 态+可读日志行");
// 已装跳过（本机 codex 已装——npm ls 秒回；若 npm 不可用该断言降级跳过不红）
const npmOk = spawnSync("npm", ["ls", "-g", "codex", "--depth=0"], { encoding: "utf-8" }).status === 0;
if (npmOk) {
  const r1 = engdista.startEngineInstall("codex");
  await new Promise((res) => setTimeout(res, 3000));
  const st = engdista.getEngineInstall("codex");
  ok(!!st && st.state === "done" && st.log.some((l: string) => l.includes("已安装") || l.includes("新装")), "⑤ codex 安装状态机终态 done（已装跳过/新装任一路径）", JSON.stringify(st?.log?.slice(0, 3)));
} else {
  console.log("  - npm 探测不可用（环境缺）——已装跳过路径断言降级跳过");
}
// GET 无记录
ok(engdista.getEngineInstall("zcode") === null, "⑤ 未启动引擎查询=null");

// ---------- 清场 ----------
rmSync(process.env.CCR_DATA_DIR, { recursive: true, force: true });
rmSync(fxRoot, { recursive: true, force: true });

console.log(`\n== test-engdista：${pass} passed / ${fail} failed ==`);
if (fail > 0) process.exit(1);
