// #73 外部会话助手消息碎片化专项（纯单元，不起 ws 服务）：
// ① pushExternalLog 同 id 原地替换（替换不占 500 条帽）；
// ② bridge 增长链：同 message.id 的转录快照行（跨多次 push / 批内多条）折叠成
//    单条完整文本；回退快照（空/变短）不回退已下发文本；
// ③ 不同 message.id 不相误折叠（即使后一条文本恰以前一条全文为前缀）；
// ④ thinking 快照同样折叠；
// ⑤ history 回放同 id 替换（重启后中间快照帧不复活成重复条目）。
// 取证背景：实测外部转录 58 行 assistant 仅 19 个唯一 message.id（同 id 行=同一条
// 消息的流式增长快照，个别尾行文本为空/变短是分块 flush 伪影）。
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { Bridge } from "../src/bridge.js";
import { reduceHistory } from "../src/history.js";
import type { BridgeEvent, Envelope, LogEntry } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../data/test-fragment/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_PROJECTS_ROOT = join(ROOT, "projects"); // 孤儿扫描隔离
mkdirSync(process.env.CCR_PROJECTS_ROOT, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = join(ROOT, "claude-cfg");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

const bus = new EventBus();
const cfg = loadConfig();
const mgr = new SessionManager(bus, cfg);
const bridge = new Bridge(bus, mgr, { gateTools: new Set(["Bash"]), hasClients: () => false, dataDir: cfg.dataDir });

// 捕获 SESSION_LOG 帧（计数用：验证替换帧而非重复新增帧）
const frames: LogEntry[] = [];
bus.subscribe((env) => {
  if (env.type === "SESSION_LOG") frames.push(env.payload as LogEntry);
});

// ---------- S1 pushExternalLog 同 id 原地替换 ----------
{
  mgr.ensureExternal("ext-frag-a", "/tmp/proj-frag", "碎片测试A");
  mgr.pushExternalLog("ext-frag-a", "assistant_text", "部分文本", undefined, { full: "部分文本", id: "xstream-t1" });
  mgr.pushExternalLog("ext-frag-a", "assistant_text", "部分文本已补全", undefined, { full: "部分文本已补全", id: "xstream-t1" });
  const logs = mgr.snapshotLogs()["ext-frag-a"];
  const texts = logs.filter((e) => e.kind === "assistant_text");
  assert(texts.length === 1 && texts[0].text === "部分文本已补全", `S1 同 id 替换为终态单条 got=${texts.length}条/${texts[0]?.text}`);
  // 替换不占 500 帽：505 次替换后仍 1 条
  for (let i = 0; i < 505; i++) mgr.pushExternalLog("ext-frag-a", "assistant_text", `x${i}`, undefined, { id: "xstream-t1" });
  assert(mgr.snapshotLogs()["ext-frag-a"].filter((e) => e.id === "xstream-t1").length === 1, "S1 高频替换不膨胀条目（不占 500 帽）");
}

// ---------- 转录夹具 ----------
const CLI = "cli-frag";
const EXT = "ext-" + CLI;
const T = join(ROOT, "transcript.jsonl");
const aLine = (msgId: string, text: string, extraBlocks: unknown[] = []) =>
  JSON.stringify({ type: "assistant", message: { id: msgId, model: "glm-5.3", content: [{ type: "text", text }, ...extraBlocks] }, timestamp: new Date().toISOString() });
const uLine = (p: string) => JSON.stringify({ type: "user", message: { role: "user", content: p }, timestamp: new Date().toISOString() });

const hook = (ev: Partial<BridgeEvent> & { event: string }) =>
  bridge.handleEvent({ session_id: CLI, cwd: "/tmp/proj-frag", ...ev } as BridgeEvent);

// 建会话 + 首读锚点（此时转录只有 user 行）
writeFileSync(T, uLine("回答测试问题") + "\n");
await hook({ event: "UserPromptSubmit", prompt: "回答测试问题", cli_pid: process.pid, transcript_path: T });
const logsOf = (): LogEntry[] => mgr.snapshotLogs()[EXT] ?? [];
const textsOf = (): LogEntry[] => logsOf().filter((e) => e.kind === "assistant_text");

// ---------- S2 增长链跨多次 push ----------
appendFileSync(T, aLine("msg_1", "第一段") + "\n");
await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
assert(textsOf().length === 1 && textsOf()[0].text === "第一段", "S2 首个快照成为单条正文");
appendFileSync(T, aLine("msg_1", "第一段加第二段，回答完整了") + "\n");
await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
{
  const ts = textsOf();
  assert(ts.length === 1 && ts[0].text === "第一段加第二段，回答完整了", `S2 增长快照原地替换（跨 push）got=${ts.length}条/${ts[0]?.text}`);
  const idFrames = frames.filter((f) => f.id === ts[0].id);
  assert(idFrames.length === 2 && idFrames.every((f) => f.id === ts[0].id), `S2 两帧同 id（替换帧）got=${idFrames.length}帧`);
}

// ---------- S3 批内多条快照折叠 + 回退快照不回退 ----------
appendFileSync(T, aLine("msg_2", "第二条") + "\n");
appendFileSync(T, aLine("msg_2", "第二条消息的完整内容") + "\n");
appendFileSync(T, aLine("msg_2", "第二条") + "\n"); // 分块 flush 伪影：变短回退
await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
{
  const ts = textsOf();
  assert(ts.length === 2 && ts[1].text === "第二条消息的完整内容", `S3 批内增长折叠为终态（回退快照不生效）got=${ts.length}条/${ts[1]?.text}`);
  const id2Frames = frames.filter((f) => f.id === ts[1].id);
  assert(id2Frames.length === 2, `S3 回退快照不产生重复帧 got=${id2Frames.length}帧`);
}

// ---------- S4 不同消息不相误折叠（后者恰以前者全文为前缀） ----------
appendFileSync(T, aLine("msg_3", "第二条消息的完整内容，另起一条新消息") + "\n");
await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
{
  const ts = textsOf();
  assert(ts.length === 3 && ts[2].text.includes("另起一条新消息") && ts[2].id !== ts[1].id, `S4 前缀开头的新消息不误折叠 got=${ts.length}条`);
}

// ---------- S5 thinking 快照同样折叠 ----------
appendFileSync(T, aLine("msg_4", "正文", [{ type: "thinking", thinking: "短暂思考" }]) + "\n");
appendFileSync(T, aLine("msg_4", "正文", [{ type: "thinking", thinking: "短暂思考之后是更完整的思考过程" }]) + "\n");
await hook({ event: "PostToolUse", tool_name: "Bash", tool_response: "ok", transcript_path: T });
{
  const th = logsOf().filter((e) => e.kind === "thinking" && e.text.includes("思考"));
  assert(th.length === 1 && th[0].text.includes("更完整"), `S5 thinking 增长折叠 got=${th.length}条`);
  const t4 = textsOf().filter((e) => e.text === "正文");
  assert(t4.length === 1, `S5 同消息正文与思考各自独立成条 got=${t4.length}条`);
}

// ---------- S6 回放同 id 替换（重启后中间帧不复活） ----------
{
  const t0 = Date.now();
  const mk = (seq: number, text: string, id: string): Envelope => ({
    seq, session_id: "ext-replay-frag", ts: t0 + seq, type: "SESSION_LOG",
    payload: { ts: t0 + seq, kind: "assistant_text", text, id },
  });
  const evs: Envelope[] = [
    { seq: 1, ts: t0, type: "SESSION_CREATED", session_id: "ext-replay-frag", payload: { cwd: "/tmp/p", initial_prompt: "回放", model: "", title: "回放", external: true } },
    mk(2, "中间快照", "xstream-k1"),
    mk(3, "中间快照续", "xstream-k1"),
    mk(4, "中间快照续·终态全文", "xstream-k1"),
  ];
  const rs = reduceHistory(evs).get("ext-replay-frag");
  const ts = rs?.logs.filter((e) => e.kind === "assistant_text") ?? [];
  assert(ts.length === 1 && ts[0].text === "中间快照续·终态全文", `S6 回放同 id 帧折叠为终态单条 got=${ts.length}条/${ts[0]?.text}`);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nFRAGMENT TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
