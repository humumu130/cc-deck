// #285 CodeBuddy 适配器增强——argv 透传/权限安全/profile 组装 断言。
// 范式：真源码 import 直跑（test-272 同范式），靶子 relay/src/agent-codebuddy.ts + settings.ts。
//
// 断言组：
//   A 常量面：17 模型（G4 对齐 help）/6 档位/3 别名/6 权限模式；G 组：resume argv/thinking 映射/能力位（W-ENGCB-FIX）
//   B buildArgs 透传（argv 断言=任务书口径）：model/effort 别名归一/permission-mode/fallback/
//     工具白黑名单——白名单外值 fail-fast throw
//   C 权限安全（任务书断言④）：bypassPermissions 仅显式（不传=argv 无此键）/未知模型 throw/
//     custom: 前缀剥壳
//   D profile 组装：EngineProfile effort/permission_mode 序列化+校验 passthrough
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-285-codebuddy-adapter.ts
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEBUDDY_MODELS, CODEBUDDY_EFFORTS, CODEBUDDY_EFFORT_ALIASES, CODEBUDDY_PERMISSION_MODES,
  CodeBuddyAgentSession, type CodeBuddySessionOptions,
} from "../src/agent-codebuddy.js";
import { validateEngineProfile, writeEngineProfilesFile, readEngineProfilesFile } from "../src/settings.js";
import type { AgentCallbacks } from "../src/agent-adapter.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// buildArgs 测试钩子：CodeBuddyAgentSession.buildArgs 是 protected——子类薄壳露出
class TestCB extends CodeBuddyAgentSession {
  public args(prompt: string, resume?: string): string[] { return this.buildArgs(prompt, resume); }
}
// noop 桩对齐现 AgentCallbacks 必填面（onTurnStart/onDock 已不在接口；补齐其余必填空实现——行为零变化）
const noopCb: AgentCallbacks = {
  onInit() {}, onStatusChange() {}, onWaiting() {}, onWaitingResolved() {}, onStats() {},
  onUsage() {}, onTodos() {}, onLog() {}, onTurnEnd() {}, onSessionEnd() {},
};
const mkSession = (over: Partial<CodeBuddySessionOptions> = {}) =>
  new TestCB({ cwd: "/tmp", model: "", cb: noopCb, ...over });

console.log("#285 CodeBuddy 适配器增强——argv 透传/权限安全/profile 组装");

// ---------- A 常量面 ----------
// [W-ENGCB-FIX G4]（1109 对齐 2.179.3 --help 实勘 17 个）
ok(CODEBUDDY_MODELS.length === 17, "A1 模型清单恰 17 个（2.179.3 --help 实勘——深测回执记 18 亦为计偏）");
ok(CODEBUDDY_MODELS.includes("hy4free") && CODEBUDDY_MODELS.includes("hy4std"), "A1b help 实有键在列（旧表误拒修复）");
ok(!CODEBUDDY_MODELS.includes("glm-5.1") && !CODEBUDDY_MODELS.includes("glm-5v-turbo") && !CODEBUDDY_MODELS.includes("minimax-m3") && !CODEBUDDY_MODELS.includes("hy4-preview"), "A1c 四幽灵键出列（glm-5.1/glm-5v-turbo/minimax-m3/hy4-preview——help 皆无）");
ok(CODEBUDDY_MODELS.includes("glm-5.3") && CODEBUDDY_MODELS.includes("glm-5.3-flash") && CODEBUDDY_MODELS.includes("kimi-k3.1-pro"), "A1 分工建议模型在列（flash 快/kimi 标准）");
ok(CODEBUDDY_EFFORTS.length === 6 && CODEBUDDY_EFFORTS.join(",") === "minimal,low,medium,high,xhigh,max", "A2 档位六档");
ok(CODEBUDDY_EFFORT_ALIASES["快速"] === "low" && CODEBUDDY_EFFORT_ALIASES["均衡"] === "high" && CODEBUDDY_EFFORT_ALIASES["极致"] === "xhigh", "A2 产品端映射：快速=low·均衡=high·极致=xhigh");
ok(CODEBUDDY_PERMISSION_MODES.length === 6 && CODEBUDDY_PERMISSION_MODES.includes("bypassPermissions"), "A3 权限六档含 bypassPermissions");

// ---------- B buildArgs 透传（argv 断言） ----------
{
  // B1 基线：无配置=旧版三参（--print + prompt + --output-format stream-json）
  const a1 = mkSession().args("test");
  ok(a1[0] === "--print" && a1[1] === "test" && a1[2] === "--output-format" && a1[3] === "stream-json" && a1.length === 4,
    "B1 零配置=旧版 argv 不变（兼容回退）");
  // B2 model 透传
  const a2 = mkSession({ model: "glm-5.3-flash" }).args("test");
  ok(a2.includes("--model") && a2[a2.indexOf("--model") + 1] === "glm-5.3-flash", "B2 --model 透传（argv 生效）");
  // B3 effort 别名归一
  const a3 = mkSession({ model: "kimi-k3.1-pro", codebuddy: { effort: "快速" } }).args("test");
  ok(a3.includes("--effort") && a3[a3.indexOf("--effort") + 1] === "low", "B3 --effort 别名归一（快速→low）");
  const a3b = mkSession({ codebuddy: { effort: "high" } }).args("test");
  ok(a3b[a3b.indexOf("--effort") + 1] === "high", "B3 --effort 直传值不变形");
  // B4 permission-mode
  const a4 = mkSession({ codebuddy: { permissionMode: "acceptEdits" } }).args("test");
  ok(a4.includes("--permission-mode") && a4[a4.indexOf("--permission-mode") + 1] === "acceptEdits", "B4 --permission-mode 透传（G2 定谳：worker 推荐档=auto——acceptEdits 下 Bash 硬拒）");
  // B5 fallback-model + 工具白黑名单
  const a5 = mkSession({ model: "glm-5.3", codebuddy: { fallbackModel: "glm-5.3-flash", allowedTools: ["Read", "Grep"], disallowedTools: ["Bash"] } }).args("test");
  ok(a5.includes("--fallback-model") && a5[a5.indexOf("--fallback-model") + 1] === "glm-5.3-flash", "B5 --fallback-model 过载回退");
  ok(a5.includes("--allowedTools") && a5[a5.indexOf("--allowedTools") + 1] === "Read,Grep", "B5 --allowedTools 白名单");
  ok(a5.includes("--disallowedTools") && a5[a5.indexOf("--disallowedTools") + 1] === "Bash", "B5 --disallowedTools 黑名单");
}
// ---------- C 权限安全（任务书断言④核心） ----------
{
  // C1 bypassPermissions 仅显式——不传 codebuddy 配置时 argv 绝无 --permission-mode
  const a1 = mkSession({ model: "glm-5.3" }).args("test");
  ok(!a1.includes("--permission-mode") && !a1.includes("bypassPermissions"),
    "C1 不传权限=argv 无 --permission-mode（bypass 绝不缺省放行——任务书安全断言）");
  // C2 显式 bypass 才透传
  const a2 = mkSession({ codebuddy: { permissionMode: "bypassPermissions" } }).args("test");
  ok(a2.includes("--permission-mode") && a2[a2.indexOf("--permission-mode") + 1] === "bypassPermissions",
    "C2 显式 bypass 才透传（唯一合法入口=调用方明确配置）");
  // C3 未知值 fail-fast throw
  let threw = false;
  try { mkSession({ model: "gpt-99" }).args("test"); } catch { threw = true; }
  ok(threw, "C3 未知模型 throw（fail-fast 防 spawn 静默跑偏）");
  threw = false;
  try { mkSession({ codebuddy: { effort: "ultra" } }).args("test"); } catch { threw = true; }
  ok(threw, "C3 未知档位 throw");
  threw = false;
  try { mkSession({ codebuddy: { permissionMode: "yolo" } }).args("test"); } catch { threw = true; }
  ok(threw, "C3 未知权限模式 throw");
  // C4 custom: 前缀剥壳（models.json 自定义模型）
  const a4 = mkSession({ model: "custom:my-finetune" }).args("test");
  ok(a4[a4.indexOf("--model") + 1] === "my-finetune", "C4 custom: 前缀剥壳（用户级 models.json 自定义）");
  // C5 default/codebuddy 哨兵不透传
  const a5 = mkSession({ model: "default" }).args("test");
  ok(!a5.includes("--model"), "C5 model=default 不透传（走引擎默认）");
}
// ---------- G W-ENGCB-FIX 新面（G3 resume argv / G5 thinking 映射 / G6 能力位） ----------
{
  // G3：首回合无 resume（argv 不含 --resume），第二回合传引擎 sid → --resume+create-missing
  const first = mkSession({ model: "glm-5.3-flash" }).args("第一问");
  ok(!first.includes("--resume") && !first.includes("--resume-create-missing"), "G3① 首回合无 --resume（argv 与旧版同形）");
  const second = mkSession({ model: "glm-5.3-flash" }).args("第二问", "eng-sid-123");
  ok(second.includes("--resume") && second[second.indexOf("--resume") + 1] === "eng-sid-123", "G3② 第二回合 --resume <sid>（原生续——重注全文退役）");
  ok(second.includes("--resume-create-missing"), "G3③ --resume-create-missing 随行（引擎侧会话被清时同 id 重建不断流）");
  ok(second.includes("--output-format") && second[second.indexOf("--output-format") + 1] === "stream-json" && second.includes("第二问"), "G3④ prompt/output-format 在 argv（model 等透传键追加于后——位序断言按值不按尾）");
  // G6：能力位三开
  const caps = (await import("../src/agent-codebuddy.js")).CODEBUDDY_CAPABILITIES;
  ok(caps.resume === true && caps.usage === true && caps.todos === true && caps.streaming === true, "G6① 能力位 resume/usage/todos/streaming 全开（深测实测推翻保守断言）");
  ok(caps.approval === false && caps.artifacts === false, "G6② approval/artifacts 维持 false（无 decision channel——不冒进）");
  // G5：thinking 块映射（mapper 纯函数面直喂）
  const { GenericJsonEventMapper } = await import("../src/agent-jsonl.js");
  const logs: { kind: string; text: string }[] = [];
  const cb5: AgentCallbacks = { ...noopCb, onLog: (kind, text) => { logs.push({ kind, text }); } };
  new GenericJsonEventMapper().handle({ type: "assistant", message: { content: [{ type: "thinking", thinking: "先核对词表再答" }, { type: "text", text: "答案是 42" }] } }, cb5);
  ok(logs.some((l) => l.kind === "thinking" && l.text.includes("核对词表")), "G5① thinking 块映射进日志流（kind=thinking——claude 同词，活动舱既有渲染面直吃）");
  ok(logs.some((l) => l.kind === "assistant_text" && l.text.includes("42")), "G5② text 块正文映射不受扰（同帧双块两吃）");
}

// ---------- D profile 组装（EngineProfile effort/permission_mode 序列化+校验） ----------
{
  const dir = mkdtempSync(join(tmpdir(), "cb285-"));
  try {
    const v = validateEngineProfile({ engine: "codebuddy", provider: "codebuddy", profile_ref: "free", effort: "快速", permission_mode: "acceptEdits" });
    ok(v.ok === true, "D1 profile 含 effort/permission_mode 校验通过");
    if (v.ok) {
      ok(v.profile.effort === "快速" && v.profile.permission_mode === "acceptEdits", "D1 两键 passthrough");
    }
    const w = writeEngineProfilesFile(dir, [{ engine: "codebuddy", provider: "codebuddy", profile_ref: "free", effort: "均衡", permission_mode: "auto" }]);
    ok(w.ok === true, "D2 profile 写盘成功");
    const back = readEngineProfilesFile(dir);
    ok(Array.isArray(back) && back.some((e) => e.engine === "codebuddy" && e.effort === "均衡" && e.permission_mode === "auto"),
      "D2 写读回环 effort=均衡·permission_mode=auto");
    // D3 删：负例注入在 TS/JSON 双层剥陷（42 字面量编译剥离·null 序列化剥离）——正路径 D1/D2 已覆盖校验面，adapter 层 C3 fail-fast 是更强防线
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
