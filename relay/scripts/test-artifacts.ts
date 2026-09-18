// #35 输出物采集专项测试：fileEditMetrics 单元 + 外部会话真实链路
//（hook 端点 → feedFileStats 实时合并 / transcript 回放重建 → SESSION_UPDATED/SNAPSHOT 下发）
// 环境隔离口径同 test-bridge（独立数据目录/项目根/claude 配置/端口）
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import { fileEditMetrics } from "../src/summarizer.js";
import type { ArtifactItem, BridgeEvent, Envelope } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../data/test-artifacts/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_PROJECTS_ROOT = join(ROOT, "projects");
process.env.CCR_PORT = "8893";
process.env.CCR_CWD = join(ROOT, "work"); // 会话默认目录 = 伪 cwd（回放相对路径补全基准）
mkdirSync(process.env.CCR_CWD, { recursive: true });
const CCFG = join(ROOT, "claude-cfg");
mkdirSync(CCFG, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = CCFG;

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

// ---------- 单元：fileEditMetrics（create/edit 判定四形态） ----------
{
  const c1 = fileEditMetrics({ type: "create", structuredPatch: [], content: "a\nb\nc" });
  assert(c1?.created === true && c1.adds === 3, "metrics: type=create + content 行数（尾空行剔除）");
  const c2 = fileEditMetrics({ structuredPatch: [{ lines: ["-old", "+new", "+new2"] }] });
  assert(c2?.created === false && c2.adds === 2 && c2.dels === 1, "metrics: patch 有 hunks → edit，+/- 计数");
  const c3 = fileEditMetrics({ content: "x" });
  assert(c3?.created === true && c3.adds === 1, "metrics: 无 type 无 patch、只有 content → create 兜底");
  const c4 = fileEditMetrics({ gitDiff: { filename: "a.ts", additions: 5, deletions: 2 }, structuredPatch: [{ lines: ["+1"] }] });
  assert(c4?.created === false && c4.adds === 5 && c4.dels === 2, "metrics: gitDiff 权威增删 + patch 非空 → edit");
  const c5 = fileEditMetrics({ type: "text_diff_content" });
  assert(c5 === null, "metrics: 无可辨数据 → null（调用方跳过）");
  const c6 = fileEditMetrics({ structuredPatch: [{ lines: ["+++ a.ts", "--- b.ts", "+x"] }] });
  assert(c6?.adds === 1, "metrics: +++/--- 头行不计入（bridge 旧内联计数的小高估已修）");
}

// ---------- 真实链路：hook 事件 + transcript 回放 ----------
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const { bridge } = startServer(bus, mgr, cfg, {});
await wait(250);
const http = `http://127.0.0.1:${cfg.port}`;
const SID = "ext-cli-art1";

// WS 订阅（SNAPSHOT + 实时帧都收）
const frames: Envelope[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
ws.on("message", (d) => {
  const m = JSON.parse(String(d)) as Envelope;
  if (m.type === "SESSION_UPDATED" || m.type === "SNAPSHOT") frames.push(m);
});
await new Promise((r) => ws.once("open", r));
await wait(200);

const artFrames = () =>
  frames.filter((e) => e.type === "SESSION_UPDATED" && e.session_id === SID && (e.payload as { artifacts?: ArtifactItem[] }).artifacts);
const arts = () => {
  const f = artFrames();
  return f.length ? (f[f.length - 1].payload as { artifacts: ArtifactItem[] }).artifacts : [];
};

// 伪 transcript：Write 新建 / Edit 修改 / cwd 外 Write / 被打断无结果的调用
const CWD = process.env.CCR_CWD!;
const T = join(ROOT, "transcript.jsonl");
const lines = [
  JSON.stringify({ type: "user", message: { content: "写点东西" }, cwd: CWD, timestamp: new Date("2026-09-19T10:00:00Z").toISOString() }),
  JSON.stringify({
    type: "assistant", timestamp: new Date("2026-09-19T10:00:01Z").toISOString(),
    message: { content: [{ type: "tool_use", id: "toolu_w1", name: "Write", input: { file_path: "docs/new.md" } }] },
  }),
  JSON.stringify({
    type: "user", timestamp: new Date("2026-09-19T10:00:02Z").toISOString(), tool_use_result: { type: "create", structuredPatch: [], content: "# 标题\n正文一\n" },
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_w1", content: "ok" }] },
  }),
  JSON.stringify({
    type: "assistant", timestamp: new Date("2026-09-19T10:00:03Z").toISOString(),
    message: { content: [{ type: "tool_use", id: "toolu_e1", name: "Edit", input: { file_path: "src/app.ts" } }] },
  }),
  JSON.stringify({
    type: "user", timestamp: new Date("2026-09-19T10:00:04Z").toISOString(),
    tool_use_result: { structuredPatch: [{ lines: ["-旧逻辑", "+新逻辑", "+补一行"] }] },
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_e1", content: "ok" }] },
  }),
  JSON.stringify({
    type: "assistant", timestamp: new Date("2026-09-19T10:00:05Z").toISOString(),
    message: { content: [{ type: "tool_use", id: "toolu_x1", name: "Write", input: { file_path: "/tmp/outside-report.md" } }] },
  }),
  JSON.stringify({
    type: "user", timestamp: new Date("2026-09-19T10:00:06Z").toISOString(),
    tool_use_result: { type: "create", content: "外部产出" },
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_x1", content: "ok" }] },
  }),
  // 被打断：有 tool_use 无 result → 不入清单
  JSON.stringify({
    type: "assistant", timestamp: new Date("2026-09-19T10:00:07Z").toISOString(),
    message: { content: [{ type: "tool_use", id: "toolu_gone", name: "Edit", input: { file_path: "src/dead.ts" } }] },
  }),
];
writeFileSync(T, lines.join("\n") + "\n");

async function hook(ev: Partial<BridgeEvent> & { event: string }): Promise<void> {
  const r = await fetch(`${http}/bridge/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": cfg.bridgeToken },
    body: JSON.stringify({ session_id: "cli-art1", cwd: CWD, transcript_path: T, ...ev }),
  });
  if (r.status !== 200) throw new Error("hook " + r.status);
}

// 首个 hook（UserPromptSubmit + transcript）→ 建会话；转录扫描走 3s 轮询
//（UserPromptSubmit 不即时扫——只登记 transcriptPaths），等一轮轮询再断言
await hook({ event: "UserPromptSubmit", prompt: "输出物回放回合", cli_pid: process.pid });
await wait(4000);
let a = arts();
assert(a.length === 3, `回放建 3 条（打断调用不入）got=${a.length}`);
const byPath = (p: string) => a.find((x) => x.path === p);
const w1 = byPath(join(CWD, "docs/new.md"));
assert(!!w1 && w1.op === "create" && w1.adds === 2 && w1.origin === "cwd", "回放：Write 新建归 create（相对路径已补全、origin=cwd、content 行数）");
const e1 = byPath(join(CWD, "src/app.ts"));
assert(!!e1 && e1.op === "edit" && e1.adds === 2 && e1.dels === 1, "回放：Edit 归 edit（patch 计数）");
const x1 = byPath("/tmp/outside-report.md");
assert(!!x1 && x1.origin === "outside", "回放：cwd 外绝对路径 origin=outside");
assert(a.every((x) => x.exists === false), "回放：文件不存在 → exists=false（「已删除」态数据）");

// 实时路径：PostToolUse Write（feedFileStats → mergeArtifact 增量）
await hook({
  event: "PostToolUse", tool_name: "Write", cli_pid: process.pid,
  tool_input: { file_path: "docs/new.md" },
  tool_response: { type: "create", filePath: "docs/new.md", structuredPatch: [], content: "重建后全文\n四行\n内容\n更多\n" },
});
await wait(300);
a = arts();
const w1b = a.find((x) => x.path === join(CWD, "docs/new.md"));
assert(!!w1b && w1b.op === "create" && w1b.adds === 2 + 4 && w1b.tools.length === 1, "实时：同文件再 Write 累计行数、create 不降级、单条不重");
assert(a.length === 3, "实时：无新文件时清单不膨胀");

// 实时新文件（Edit 覆盖）
await hook({
  event: "PostToolUse", tool_name: "Edit", cli_pid: process.pid,
  tool_input: { file_path: "src/app.ts" },
  tool_response: { structuredPatch: [{ lines: ["+又一处"] }] },
});
await wait(300);
a = arts();
const e1b = a.find((x) => x.path === join(CWD, "src/app.ts"));
assert(!!e1b && e1b.tools.includes("Write") === false && e1b.tools.includes("Edit") && e1b.adds === 3, "实时：Edit 工具并入 tools、行数续累加");

// SNAPSHOT 携带（新 WS 连接全量拉取）
const ws2 = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`);
let snap: Envelope | undefined;
ws2.on("message", (d) => {
  const m = JSON.parse(String(d)) as Envelope;
  if (m.type === "SNAPSHOT") snap = m;
});
await new Promise((r) => ws2.once("open", r));
await wait(300);
const snapArts = ((snap as { payload?: { sessions?: { session_id: string; artifacts?: ArtifactItem[] }[] } })?.payload?.sessions ?? [])
  .find((x) => x.session_id === SID)?.artifacts;
assert(Array.isArray(snapArts) && snapArts.length === 3 && snapArts.some((x) => x.op === "create"), "SNAPSHOT 全量携带 artifacts（断线重连重建）");

// 回放幂等：模拟转录轮转/收缩——新 transcript 比旧的小（去掉末尾被打断行），
// prev offset > size 触发 firstRead 全量重扫；setArtifacts 整体替换语义应把
// 实时路径累计过的行数拉回回放基线（不双计）
const T2 = join(ROOT, "transcript2.jsonl");
writeFileSync(T2, lines.slice(0, -1).join("\n") + "\n");
{
  const r = await fetch(`${http}/bridge/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": cfg.bridgeToken },
    body: JSON.stringify({ session_id: "cli-art1", cwd: CWD, transcript_path: T2, event: "UserPromptSubmit", prompt: "第二轮首读（转录换文件≈轮转）", cli_pid: process.pid }),
  });
  if (r.status !== 200) throw new Error("hook2 " + r.status);
}
await wait(4000);
a = arts();
const w1c = a.find((x) => x.path === join(CWD, "docs/new.md"));
assert(!!w1c && w1c.adds === 2 && a.length === 3, "幂等：转录换文件重触 firstRead → 整表替换不双计（回到回放基线）");

ws.close();
ws2.close();
await wait(150);
rmSync(ROOT, { recursive: true, force: true });
console.log(`\nARTIFACTS TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
