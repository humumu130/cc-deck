// W-KWP2 件一端到端（B 路 B1 自测口径）：沙盒 Claude worker 会话装最小测试插件
// （自造 hello-plugin）→ 会话内 skill 触发可见。
//
// 链路：new AgentSession（真 CLI 子进程）+ opts.workerPlugins=[tmp 插件路径] →
// SDK query options.plugins → CLI 加载显式 local 插件 → 用户触发 skill →
// 捕获 Skill tool_use（含 hello-demo）或插件特征问候语正文。
//
// 上游接线（fake factory 断言）在 test-worker-plugins.ts S3；本脚本补「SDK→CLI→
// 插件加载→skill 触发」真链路段。需要本机 claude CLI 可用（凭证已配置）。
// 隔离：插件目录/工作目录全在 tmp，不触 ~/.cc-deck；不依赖 relay 进程。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentSession, toSdkPlugins, type AgentCallbacks } from "../src/agent-adapter.js";

const dirs: string[] = [];
const mkDir = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `ccr-wplug-e2e-${tag}-`)); dirs.push(d); return d; };

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
};

// ---------- 造最小测试插件（KWP 范式：plugin.json 4 字段 + skills/<name>/SKILL.md） ----------
const PLG = mkDir("plg");
const pluginDir = join(PLG, "hello-plugin");
mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
mkdirSync(join(pluginDir, "skills", "hello-demo"), { recursive: true });
writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({
  name: "hello-plugin",
  version: "0.1.0",
  description: "W-KWP2 minimal test plugin (worker plugin pipeline e2e)",
  // ⚠ author 必须对象形态（{name}）——字符串会被 claude plugin validate 拒（实测
  // 2026-10-11：Invalid input: expected object, received string → 整插件 load error，
  // skills 全部不可用）。KWP 实测补充进件三写作规范
  author: { name: "cc-deck" },
}, null, 2) + "\n");
writeFileSync(join(pluginDir, "skills", "hello-demo", "SKILL.md"), `---
name: hello-demo
description: Say hello in the team's fixed format. Use when the user asks to "用 hello-demo 打招呼", "say hello with hello-demo", or explicitly mentions the hello-demo skill.
---

# Hello Demo

When this skill is invoked, respond with exactly this one line and nothing else:

KWP2-HELLO-OK 你好！来自 hello-plugin 的问候（worker 插件通路端到端验证成功）。
`);

console.log("插件落位:", pluginDir);

// ---------- 起 AgentSession（真 CLI）+ 触发 skill ----------
const CWD = mkDir("cwd");
const seenSkillUse: { skill?: string }[] = [];
let assistantText = "";
let inited = false;

const cb: AgentCallbacks = {
  onInit: () => { inited = true; console.log("  [e2e] CLI init"); },
  onStatusChange: () => {},
  onWaiting: (p) => {
    // 沙盒无审批人：权限请求直接放行（Skill 触发若要权限门则自动 allow）
    const sid = (cb as { _s?: AgentSession })._s;
    console.log(`  [e2e] 等待权限: ${p.tool_name}`);
    sid?.allow(p.request_id);
  },
  onWaitingResolved: () => {},
  onStats: () => {},
  onUsage: () => {},
  onTodos: () => {},
  onLog: (kind, text, meta) => {
    if (kind === "tool_use" && meta?.tool === "Skill") {
      seenSkillUse.push({ skill: /hello-demo/i.test(JSON.stringify(meta.detail ?? text)) ? "hello-demo" : text.slice(0, 40) });
      console.log(`  [e2e] Skill 工具调用: ${JSON.stringify(meta.detail ?? text).slice(0, 120)}`);
    }
    if (kind === "assistant_text" && /KWP2-HELLO-OK/.test(meta?.full ?? text)) {
      assistantText = meta?.full ?? text;
      console.log("  [e2e] 正文捕获插件特征问候语");
    }
    if (kind === "assistant_text") console.log(`  [e2e][正文] ${(meta?.full ?? text).slice(0, 200).replace(/\n/g, " ⏎ ")}`);
  },
  onTurnEnd: (ok, reason) => { console.log(`  [e2e] 回合结束 ok=${ok} ${reason}`); },
  onSessionEnd: (reason) => { console.log(`  [e2e] 会话结束 ${reason}`); },
};

console.log("\n起 AgentSession（workerPlugins 通路）…");
const session = new AgentSession(CWD, "sonnet", cb, "请触发 hello-demo skill：用 hello-demo 打个招呼", {
  workerPlugins: [pluginDir],
  permissionMode: "bypassPermissions",
});
(cb as { _s?: AgentSession })._s = session;

const TIMEOUT_MS = 180_000;
const done = new Promise<void>((resolve) => {
  const t0 = Date.now();
  let skillAt = 0;
  const tick = setInterval(() => {
    if (seenSkillUse.length > 0 && !skillAt) skillAt = Date.now();
    // 正文捕获即收；skill 已触发但正文 25s 未到也收（Skill 执行→下回合正文序列兜底）
    if (assistantText || (skillAt && Date.now() - skillAt > 25_000) || Date.now() - t0 > TIMEOUT_MS) {
      clearInterval(tick);
      resolve();
    }
  }, 500);
});
await done;
void session.stop().catch(() => {});
await new Promise((r) => setTimeout(r, 800));

console.log("");
assert(inited, "CLI 子进程 init（插件通路不阻断会话启动）");
assert(seenSkillUse.length > 0, `Skill 工具触发可见（${seenSkillUse.length} 次调用）`);
assert(seenSkillUse.some((s) => s.skill === "hello-demo"), "触发的正是 hello-demo（插件清单加载生效）");
assert(/KWP2-HELLO-OK/.test(assistantText), "插件 skill 正文被执行（特征问候语在 assistant 正文）");

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
console.log(`\nworker-plugins-e2e: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
