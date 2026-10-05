// #018-B1a：引擎 activity mapper 系统化 + capability fixture（worker G）
// 验收口径：Trae/Qwen/CodeBuddy mapper（kind/text/tool/occurred_at 逐行断言）+
// Claude/Codex preflight 分档 + ZCode unsupported 主档 + 畸形行容错（跳过并计数）。
// 样本来源备案见 src/agent-jsonl.ts ENGINE_JSONL_PROFILES 与回单；
// 断言时间一律注入 NOW 定值（禁两个独立取时点的 Date.now 比对，N1② 教训）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_JSONL_PROFILES, mapJsonlActivity, mapJsonlStream, preflightEngine } from "../src/agent-jsonl.js";
import { preflightClaude } from "../src/agent-adapter.js";
import { mapCodexActivity, preflightCodex } from "../src/agent-codex.js";
import { mapTraeActivity } from "../src/agent-trae.js";
import { mapQwenCodeActivity } from "../src/agent-qwen.js";
import { mapCodeBuddyActivity } from "../src/agent-codebuddy.js";
import { mapZCodeActivity, preflightZCode } from "../src/agent-zcode.js";
import type { ActivityCapabilities } from "../src/types.js";

const NOW = 1728100000500;
const capabilities: ActivityCapabilities = {
  native_status: false,
  operation_summary: true,
  native_elapsed: false,
  approval: false,
};

const fixtureText = (name: string): string => readFileSync(join(process.cwd(), "tests/fixtures", name), "utf8");
// 尾空行过滤（文件以 \n 结尾的 split 尾串）：空行判定归 mapJsonlStream（分帧噪声），
// 逐行 parseLine 的段不应吃空串
const fixtureLines = (name: string): string[] => fixtureText(name).split("\n").filter((l) => l.trim().length > 0);
const parseFixture = <T>(name: string): T => JSON.parse(fixtureText(name)) as T;
const parseLine = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;

let pass = 0;
let fail = 0;
function check(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
function finish(): never {
  console.log(`b1a mapper: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 0. 形态档位表（显式备案载体）
// ---------------------------------------------------------------------------
check(ENGINE_JSONL_PROFILES.trae?.structured === false && ENGINE_JSONL_PROFILES.trae.timeFields.length === 0, "profile trae: 纯文本档（无 JSONL 开关，工具/时间不伪造）");
check(ENGINE_JSONL_PROFILES["qwen-code"]?.structured === true, "profile qwen-code: 结构化档（单对象基线，JSONL 待冒烟宽容两吃）");
check(ENGINE_JSONL_PROFILES.codebuddy?.structured === true, "profile codebuddy: 结构化档（stream-json 同构族，宽容解析）");
check(Boolean(ENGINE_JSONL_PROFILES.trae?.note && ENGINE_JSONL_PROFILES["qwen-code"]?.note && ENGINE_JSONL_PROFILES.codebuddy?.note), "三个 profile 均带样本来源备案注记");

// ---------------------------------------------------------------------------
// 1. Trae：纯文本路径（006 §3.1 一手 help 核实：无 JSON/JSONL 开关）
// ---------------------------------------------------------------------------
const traeOut = mapJsonlStream(fixtureLines("engine-trae-text.jsonl"), { capabilities, now: NOW, profileId: "trae" });
check(traeOut.textLines === 4 && traeOut.malformed === 0 && traeOut.parsed === 0, "Trae 纯文本流：4 行全按正文处理，零畸形计数");
check(traeOut.docks.length === 4 && traeOut.docks.every((d) => d.state === "WORKING"), "Trae 每行正文映射 WORKING（不炸不中断）");
check(traeOut.docks.every((d) => d.activity?.kind === "assistant_text"), "Trae 正文行 kind=assistant_text");
check(traeOut.docks.every((d) => d.activity?.tool === undefined && d.activity?.occurred_at === undefined), "Trae 工具/时间字段不伪造");
check(traeOut.docks.every((d) => d.time_basis === "relay_received"), "Trae 时间口径恒 relay_received（018 :260）");
check(traeOut.docks[3]?.activity?.text === "Error: Config file not found. Please specify a valid config file on the command line option --config-file", "Trae 错误文本行保留正文（006 §3.1：文本行不伪造成 ERROR 事件）");

const traeMixed = mapJsonlStream(fixtureLines("engine-trae-mixed.jsonl"), { capabilities, now: NOW, profileId: "trae" });
check(traeMixed.docks.length === 3 && traeMixed.textLines === 2 && traeMixed.parsed === 1 && traeMixed.malformed === 0, "Trae 混流：伪 JSON 行与坏行都按正文处理不计数");
check(mapTraeActivity("薄壳直通正文", { now: NOW }).activity?.text === "薄壳直通正文", "Trae 薄壳入口直通内核");

const traeEmpty = mapJsonlStream(fixtureLines("engine-trae-empty.jsonl"), { capabilities, now: NOW, profileId: "trae" });
check(traeEmpty.docks.length === 0 && traeEmpty.malformed === 0, "Trae 空流：零映射零计数");

// ---------------------------------------------------------------------------
// 2. Qwen Code：单对象文档基线 + JSONL 宽容形态（006 §3.2，冒烟欠账备案）
// ---------------------------------------------------------------------------
const qwenDoc = parseFixture<{ response: string; created_at: number }>("engine-qwen-document.json");
const qwenDocDock = mapQwenCodeActivity(qwenDoc, { now: NOW });
check(qwenDocDock.activity?.kind === "assistant_text" && qwenDocDock.activity?.text === "Qwen 代码生成完成", "Qwen 单对象文档 response→assistant_text");
check(qwenDocDock.activity?.occurred_at === 1728100000000 && qwenDocDock.time_basis === "occurred_at", "Qwen created_at 数字毫秒透传 + occurred_at 口径");

const qwenOut = mapJsonlStream(fixtureLines("engine-qwen-stream.jsonl"), { capabilities, now: NOW, profileId: "qwen-code" });
check(qwenOut.parsed === 5 && qwenOut.malformed === 0, "Qwen JSONL 流：5 行全解析（含未知形态宽容吞）");
check(qwenOut.docks[0]?.activity?.kind === "assistant_text" && qwenOut.docks[0]?.activity?.occurred_at === 1728100000100, "Qwen 行1 assistant_text + created_at 透传");
check(qwenOut.docks[1]?.activity?.kind === "tool_use" && qwenOut.docks[1]?.activity?.tool === "read_file", "Qwen 行2 tool_call→tool_use + 工具名");
check(qwenOut.docks[2]?.activity?.kind === "tool_result" && qwenOut.docks[2]?.activity?.text === "文件内容", "Qwen 行3 tool_result + 结果文本");
check(qwenOut.docks[3]?.state === "DONE" && qwenOut.docks[3]?.activity?.kind === "assistant_text", "Qwen 行4 done→DONE 终态");
check(!qwenOut.docks[4]?.activity, "Qwen 行5 未知形态（无 type/正文键）不伪造 activity");

const qwenEmpty = mapJsonlStream(fixtureLines("engine-qwen-empty.jsonl"), { capabilities, now: NOW, profileId: "qwen-code" });
check(qwenEmpty.docks.length === 0 && qwenEmpty.malformed === 0, "Qwen 空流：零映射零计数");

// ---------------------------------------------------------------------------
// 3. CodeBuddy：Claude 协议族 stream-json（006 §3.3 help 核实开关实存；
//    字段词汇按家族同构宽容解析，真回合冒烟欠账维持）
// ---------------------------------------------------------------------------
const CB_TS1 = Date.parse("2026-10-05T08:00:01.000Z"); // ISO 字符串时间的期望值（单次取值）
const cbOut = mapJsonlStream(fixtureLines("engine-codebuddy-stream.jsonl"), { capabilities, now: NOW, profileId: "codebuddy" });
check(cbOut.parsed === 6 && cbOut.malformed === 0, "CodeBuddy stream 流：6 行全解析");
check(!cbOut.docks[0]?.activity && cbOut.docks[0]?.state === "WORKING", "CodeBuddy 行1 system init 不伪造活动");
check(cbOut.docks[1]?.activity?.kind === "assistant_text" && cbOut.docks[1]?.activity?.text === "开始检查代码", "CodeBuddy 行2 message.content text 块→assistant_text");
check(cbOut.docks[1]?.activity?.occurred_at === CB_TS1 && cbOut.docks[1]?.time_basis === "occurred_at", "CodeBuddy ISO 字符串 timestamp 解析 + occurred_at 口径");
check(cbOut.docks[2]?.activity?.kind === "tool_use" && cbOut.docks[2]?.activity?.tool === "Read", "CodeBuddy 行3 tool_use 块→tool_use + 块内工具名");
check(cbOut.docks[2]?.activity?.text === "Read 执行中", "CodeBuddy tool_use 无正文时给执行中占位");
check(cbOut.docks[3]?.activity?.kind === "tool_result" && cbOut.docks[3]?.activity?.text === "文件内容 ok", "CodeBuddy 行4 tool_result 块→tool_result + 块内结果文本");
check(cbOut.docks[4]?.activity?.kind === "assistant_text" && cbOut.docks[4]?.activity?.text === "检查完成", "CodeBuddy 行5 正文块还原");
check(cbOut.docks[5]?.state === "DONE", "CodeBuddy 行6 result(success)→DONE 终态");

const cbErrLine = parseLine(fixtureLines("engine-codebuddy-error.jsonl")[0]);
const cbErrDock = mapCodeBuddyActivity(cbErrLine, { now: NOW });
check(cbErrDock.state === "ERROR" && cbErrDock.activity?.kind === "system", "CodeBuddy result(is_error)→ERROR fail-closed 不落 DONE");
check(cbErrDock.activity?.text === "权限被拒绝：无法写入受保护路径", "CodeBuddy is_error 错误文本取 result 字段");

const cbNoTs = mapJsonlStream(fixtureLines("engine-codebuddy-notimestamps.jsonl"), { capabilities, now: NOW, profileId: "codebuddy" });
check(cbNoTs.docks[0]?.activity?.occurred_at === undefined && cbNoTs.docks[0]?.time_basis === "relay_received", "CodeBuddy 无时间字段→relay_received 口径（时间字段有无对照）");
check(cbNoTs.docks[1]?.state === "DONE", "CodeBuddy 无时间戳流终态不受影响");

const cbMal = mapJsonlStream(fixtureLines("engine-codebuddy-malformed.jsonl"), { capabilities, now: NOW, profileId: "codebuddy" });
check(cbMal.parsed === 1 && cbMal.malformed === 2 && cbMal.docks.length === 1, "CodeBuddy 畸形流：2 坏行跳过并计数，1 好行照常映射");
check(!fixtureText("engine-codebuddy-malformed.jsonl").includes("throw"), "畸形流不中断（fixture 原样喂入未抛出）");

const cbEmpty = mapJsonlStream(fixtureLines("engine-codebuddy-empty.jsonl"), { capabilities, now: NOW, profileId: "codebuddy" });
check(cbEmpty.docks.length === 0 && cbEmpty.malformed === 0, "CodeBuddy 空流：零映射零计数");

// ---------------------------------------------------------------------------
// 4. Codex：0.154.0 一手词汇表（docs/codex-integration-research.md 附录）
// ---------------------------------------------------------------------------
const codexLines = fixtureLines("engine-codex-stream.jsonl").map(parseLine);
const codexEvents = codexLines.map((line) => mapCodexActivity(line, { now: NOW }));
check(codexEvents[0]?.state === "WORKING" && !codexEvents[0]?.activity, "Codex thread.started 保守无活动");
check(codexEvents[1]?.state === "WORKING" && codexEvents[1]?.activity?.text === "执行中", "Codex turn.started→执行中");
check(codexEvents[2]?.activity?.kind === "tool_use" && codexEvents[2]?.activity?.tool === "command" && codexEvents[2]?.activity?.text === "npm test", "Codex item.started command_execution→tool_use");
check(codexEvents[3]?.activity?.kind === "assistant_text" && codexEvents[3]?.activity?.text === "测试全部通过", "Codex item.completed agent_message→assistant_text");
check(codexEvents[4]?.activity?.kind === "tool_result" && codexEvents[4]?.activity?.text === "3 passed", "Codex item.completed command_execution(exit 0)→tool_result");
check(codexEvents[5]?.state === "DONE" && codexEvents[5]?.time_basis === "relay_received" && codexEvents[5]?.activity?.occurred_at === undefined, "Codex turn.completed→DONE；一手词汇表无时间字段→relay_received（018 :260）");
const codexFail = mapCodexActivity(parseLine(fixtureLines("engine-codex-error.jsonl")[0]), { now: NOW });
check(codexFail.state === "ERROR" && codexFail.activity?.text === "fixture failure", "Codex turn.failed→ERROR + 错误文本");
const codexStreamOut = mapJsonlStream(fixtureLines("engine-codex-stream.jsonl"), { capabilities, now: NOW });
check(codexStreamOut.malformed === 0 && codexStreamOut.parsed === 6, "Codex 流喂通用内核：全解析零畸形（宽容向前兼容）");
const codexEmpty = mapJsonlStream(fixtureLines("engine-codex-empty.jsonl"), { capabilities, now: NOW });
check(codexEmpty.docks.length === 0 && codexEmpty.malformed === 0, "Codex 空流：零映射零计数");

// ---------------------------------------------------------------------------
// 5. ZCode：显式 unsupported 主档（006 §3.5 / 018 :293-294）
// ---------------------------------------------------------------------------
const zcPreflight = preflightZCode();
check(zcPreflight.ok === false && zcPreflight.errors.length > 0, "ZCode preflight 恒 fail-closed");
check(zcPreflight.errors[0]?.includes("隐私/遥测") && zcPreflight.errors[0]?.includes("unsupported"), "ZCode 拒绝面显式标注隐私/遥测缺口主档");
check(zcPreflight.warnings.some((w) => w.includes("acknowledged_warning")), "ZCode 启用前置（遥测核验+警示确认）写入 warnings");
const zcDock = mapZCodeActivity({ now: NOW });
check(zcDock.unsupported === true && !zcDock.activity, "ZCode 映射面 unsupported 且不伪造活动");
check(fixtureLines("engine-zcode-unsupported.jsonl").length === 2, "ZCode fixture（被档位拒绝的输入样本）在位");

// ---------------------------------------------------------------------------
// 6. preflight 分档（018 :293-294 矩阵）
// ---------------------------------------------------------------------------
const pfClaudeFail = preflightClaude({ cliPath: null, credentialConfigured: false });
check(!pfClaudeFail.ok && pfClaudeFail.errors.length >= 2, "Claude preflight：CLI/凭证缺失 fail-closed");
const pfClaudeOk = preflightClaude({ cliPath: "/tmp/claude", credentialConfigured: true, version: "1.0" });
check(pfClaudeOk.ok && pfClaudeOk.warnings.length === 0, "Claude preflight：SDK/凭证/版本显式核验全过零警告（018 矩阵三要素核对）");

const pfCodexPartial = preflightCodex({ cliPath: "/tmp/codex", credentialConfigured: true, version: "1.0" });
check(pfCodexPartial.ok && pfCodexPartial.warnings.some((w) => w.includes("JSONL")), "Codex preflight：JSONL 能力未核验→warning 档（不阻断）");
const pfCodexFail = preflightCodex({ cliPath: "/tmp/codex", credentialConfigured: true, version: "1.0", jsonlSupported: false });
check(!pfCodexFail.ok && pfCodexFail.errors.some((e) => e.includes("JSONL")), "Codex preflight：JSONL 能力核验不过→error fail-closed");
const pfCodexOk = preflightCodex({ cliPath: "/tmp/codex", credentialConfigured: true, version: "1.0", jsonlSupported: true });
check(pfCodexOk.ok && pfCodexOk.warnings.length === 0, "Codex preflight：CLI/凭证/版本/JSONL 四要素齐→零警告");
const pfCodexNoCli = preflightCodex({ cliPath: null, credentialConfigured: false });
check(!pfCodexNoCli.ok, "Codex preflight：CLI/凭证缺失 fail-closed");

// 三薄壳 preflight（注册表消费面）：存在命令 ok / 不存在 error / PATH 缺失 error
for (const [name, preflight] of [
  ["Trae", (cmd: string) => preflightEngine({ command: cmd })],
  ["Qwen", (cmd: string) => preflightEngine({ command: cmd })],
  ["CodeBuddy", (cmd: string) => preflightEngine({ command: cmd })],
] as const) {
  const okResult = preflight("/bin/echo");
  check(okResult.ok, `${name} preflight：存在且可执行的命令→ok 档`);
  const missingResult = preflight("/ccr-b1a-nonexistent/missing-cli");
  check(!missingResult.ok && missingResult.errors.some((e) => e.includes("不存在或不可执行")), `${name} preflight：路径命令不存在→error 档`);
  const bareResult = preflight("ccr-b1a-definitely-missing-cli");
  check(!bareResult.ok, `${name} preflight：裸命令 PATH 探测不到→error 档`);
}

finish();
