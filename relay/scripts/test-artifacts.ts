// 输出物专项测试（2026-09-19 意图声明制口径，替代 #51 扩展名白名单）：
// 双通道——① 产物目录投递：写入 CCR_ARTIFACTS_DIR（生产=~/.cc-deck/artifacts/）
// 的任意格式文件自动收录（写进去=声明交付）；② 原地登记：POST /api/deliver 登记
// 项目内交付物原路径（文件不搬动，看板只记录）。项目目录里的改动（无论 md/html/
// 代码）一律不收。含 fileEditMetrics 单元 / hook 实时 + transcript 回放 /
// SNAPSHOT / 整表替换保留登记 / 中文文件名下载回归。
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
// 产物目录通道隔离：指向测试沙箱（生产默认 ~/.cc-deck/artifacts/）
const ART = join(ROOT, "artifacts");
process.env.CCR_ARTIFACTS_DIR = ART;
mkdirSync(ART, { recursive: true });
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
  assert(c1?.created === true && c1?.adds === 3, "metrics: type=create + content 行数（尾空行剔除）");
  const c2 = fileEditMetrics({ structuredPatch: [{ lines: ["-old", "+new", "+new2"] }] });
  assert(c2?.created === false && c2?.adds === 2 && c2?.dels === 1, "metrics: patch 有 hunks → edit，+/- 计数");
  const c3 = fileEditMetrics({ content: "x" });
  assert(c3?.created === true && c3?.adds === 1, "metrics: 无 type 无 patch、只有 content → create 兜底");
  const c4 = fileEditMetrics({ gitDiff: { filename: "a.ts", additions: 5, deletions: 2 }, structuredPatch: [{ lines: ["+1"] }] });
  assert(c4?.created === false && c4?.adds === 5 && c4?.dels === 2, "metrics: gitDiff 权威增删 + patch 非空 → edit");
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

// 产物目录里的真实文件（exists=true 路径）+ 只在 transcript 里出现过的（exists=false）
writeFileSync(join(ART, "工作报告-2026-09-19.html"), "<!doctype html><html><body>今日工作报告（中文文件名下载回归）</body></html>\n");

// 伪 transcript：项目目录 Write/Edit（一律不收）/ 产物目录 Write（收）/ 被打断调用
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
  // 产物目录投递①：真实落盘的中文 HTML 报告 → 收录且 exists=true
  JSON.stringify({
    type: "assistant", timestamp: new Date("2026-09-19T10:00:05Z").toISOString(),
    message: { content: [{ type: "tool_use", id: "toolu_a1", name: "Write", input: { file_path: join(ART, "工作报告-2026-09-19.html") } }] },
  }),
  JSON.stringify({
    type: "user", timestamp: new Date("2026-09-19T10:00:06Z").toISOString(), tool_use_result: { type: "create", content: "<html>报告</html>" },
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_a1", content: "ok" }] },
  }),
  // 产物目录投递②：任意格式（pdf，未落盘）→ 收录且 exists=false
  JSON.stringify({
    type: "assistant", timestamp: new Date("2026-09-19T10:00:07Z").toISOString(),
    message: { content: [{ type: "tool_use", id: "toolu_a2", name: "Write", input: { file_path: join(ART, "汇总表.pdf") } }] },
  }),
  JSON.stringify({
    type: "user", timestamp: new Date("2026-09-19T10:00:08Z").toISOString(), tool_use_result: { type: "create", content: "%PDF-" },
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_a2", content: "ok" }] },
  }),
  // 被打断：有 tool_use 无 result → 不入清单
  JSON.stringify({
    type: "assistant", timestamp: new Date("2026-09-19T10:00:09Z").toISOString(),
    message: { content: [{ type: "tool_use", id: "toolu_gone", name: "Edit", input: { file_path: join(ART, "没写完.pdf") } }] },
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

// 首个 hook → 建会话；转录扫描走 3s 轮询，等一轮再断言
await hook({ event: "UserPromptSubmit", prompt: "产物目录投递回合", cli_pid: process.pid });
await wait(4000);
let a = arts();
assert(a.length === 2, `回放只收产物目录投递 got=${a.length}`);
const byPath = (p: string) => a.find((x) => x.path === p);
const a1 = byPath(join(ART, "工作报告-2026-09-19.html"));
assert(!!a1 && a1.op === "create" && a1.exists === true, "回放：产物目录 HTML 收录（中文路径、盘上真实存在 exists=true）");
const a2 = byPath(join(ART, "汇总表.pdf"));
assert(!!a2 && a2.exists === false, "回放：任意格式收录（pdf，未落盘 exists=false）");
assert(!byPath(join(CWD, "docs/new.md")) && !byPath(join(CWD, "src/app.ts")), "回放：项目目录 Write/Edit 一律不收（启发式已废）");

// 实时路径①：产物目录新文件 → 收录
await hook({
  event: "PostToolUse", tool_name: "Write", cli_pid: process.pid,
  tool_input: { file_path: join(ART, "实时-补充.md") },
  tool_response: { type: "create", filePath: join(ART, "实时-补充.md"), structuredPatch: [], content: "补充\n两行\n" },
});
await wait(300);
a = arts();
assert(a.length === 3 && !!byPath(join(ART, "实时-补充.md")), "实时：产物目录 Write 收录");
// 实时路径②：项目目录文件 → 不收，清单不膨胀
await hook({
  event: "PostToolUse", tool_name: "Write", cli_pid: process.pid,
  tool_input: { file_path: "docs/another.md" },
  tool_response: { type: "create", filePath: "docs/another.md", structuredPatch: [], content: "不该进清单\n" },
});
await wait(300);
a = arts();
assert(a.length === 3, "实时：项目目录 Write 不收，清单不膨胀");

// ---------- 原地登记通道（/api/deliver） ----------
const DECLARED = join(CWD, "docs", "登记制说明.md");
mkdirSync(join(CWD, "docs"), { recursive: true });
writeFileSync(DECLARED, "# 登记制\n交付物原地不动，看板只登记。\n");
{
  const bad = await fetch(`${http}/api/deliver?token=WRONG`, { method: "POST", body: "{}" });
  assert(bad.status === 401, "deliver：错误 token 401");
  const r = await fetch(`${http}/api/deliver?token=${cfg.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: DECLARED, cwd: CWD }),
  });
  const j = (await r.json()) as { ok: boolean; session_id?: string };
  assert(r.status === 200 && j.ok === true && j.session_id === SID, `deliver：项目内文件登记成功归因到会话 got=${JSON.stringify(j)}`);
}
await wait(300);
a = arts();
const d1 = a.find((x) => x.path === DECLARED);
assert(a.length === 4 && !!d1 && d1.tools.includes("登记") && d1.exists === true && d1.adds === 0, "deliver：登记条目入板（tools=登记、原路径真实存在、不动 adds/dels）");

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
assert(Array.isArray(snapArts) && snapArts.length === 4 && snapArts.some((x) => x.tools.includes("登记")), "SNAPSHOT 全量携带 artifacts（含登记条目）");

// 回放幂等 + 登记保留：转录换文件（≈轮转）重触 firstRead → setArtifacts 整表替换，
// 产物目录基线回放 + 登记条目从 deliverables.json 挂回（不丢、不双计）
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
const k1 = a.find((x) => x.path === join(ART, "工作报告-2026-09-19.html"));
assert(!!k1 && k1.adds === 1 && a.length === 3 && a.some((x) => x.path === DECLARED), `幂等：整表替换回产物基线且登记条目保留 got=${a.length}（实时条目洗回、登记不丢）`);

// ---------- 产物中心 HTTP：列表 + 中文文件名下载 ----------
{
  const lr = await fetch(`${http}/api/artifacts?token=${cfg.token}`);
  const lj = (await lr.json()) as { ok: boolean; artifacts: { name: string }[] };
  assert(lr.status === 200 && lj.artifacts.some((x) => x.name === "工作报告-2026-09-19.html"), "产物中心列表含中文文件");
  const fr = await fetch(`${http}/artifacts/${encodeURIComponent("工作报告-2026-09-19.html")}?token=${cfg.token}`);
  const body = await fr.text();
  assert(fr.status === 200 && body.includes("今日工作报告"), `产物中心：中文文件名可下载（CJK 正则回归）status=${fr.status}`);
  const noauth = await fetch(`${http}/artifacts/${encodeURIComponent("工作报告-2026-09-19.html")}`);
  assert(noauth.status === 401, "产物中心：无 token 401");
}

ws.close();
ws2.close();
await wait(150);
rmSync(ROOT, { recursive: true, force: true });
console.log(`\nARTIFACTS TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
