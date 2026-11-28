// #70 快照日志截断保护专项（纯单元，不起服务）：buildSnapshotLogs 的条数帽与
// 字节预算两级截断下，消息类条目（user_message/assistant_text）必须最后被丢——
// 重连端（快照重建）要能看到问答正文，工具噪音先裁。背景：用户手机在线收实时
// 帧看得到回答，打开 Mac 走快照重建只剩提问——无差别裁最旧把正文洗掉了。
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { LogEntry } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../data/test-snaplogs/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_NO_TITLE_GEN = "1";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}
const isMsg = (e: LogEntry) => e.kind === "user_message" || e.kind === "assistant_text";

const mgr = new SessionManager(new EventBus(), loadConfig());

// 场景①：长会话 120 条（6 条消息散布在中段，其余工具噪音），cap=50
const S1 = "ext-snap-a";
mgr.ensureExternal(S1, "/tmp/proj-a", "会话A");
const msgAt = new Set([20, 40, 60, 80, 100, 110]);
for (let i = 0; i < 120; i++) {
  mgr.pushExternalLog(S1, msgAt.has(i) ? (i % 40 === 20 ? "user_message" : "assistant_text") : "tool_use", msgAt.has(i) ? `m${i}` : `noise${i}`);
}
{
  const r = mgr.buildSnapshotLogs(512 * 1024, 50);
  const logs = r.logs[S1] ?? [];
  const msgs = logs.filter(isMsg).map((e) => e.text);
  assert(logs.length === 50, `条数帽生效 got=${logs.length}`);
  assert(msgs.length === 6 && ["m20", "m40", "m60", "m80", "m100", "m110"].every((t) => msgs.includes(t)), `窗口内消息全保 got=${JSON.stringify(msgs)}`);
  assert(r.logs_truncated[S1] === 70, `截断计数=120-50 got=${r.logs_truncated[S1]}`);
  assert(logs.every((e) => e.text.startsWith("m") || e.text.startsWith("noise")), "条目形状完好");
  // 顺序保持：是喂入顺序的子序列
  const seq = logs.map((e) => Number(e.text.replace(/^[a-z]+/, "")));
  assert(seq.every((v, i) => i === 0 || v > seq[i - 1]), "输出保持时间顺序");
}

// 场景②：短会话（30 条 ≤ cap）原样全量，无截断标记
const S2 = "ext-snap-b";
mgr.ensureExternal(S2, "/tmp/proj-b", "会话B");
for (let i = 0; i < 30; i++) mgr.pushExternalLog(S2, i % 15 === 0 ? "user_message" : "tool_use", i % 15 === 0 ? `u${i}` : `n${i}`);
{
  const r = mgr.buildSnapshotLogs(512 * 1024, 50);
  assert((r.logs[S2] ?? []).length === 30 && !r.logs_truncated[S2], "短会话不截断");
}

// 场景③：字节预算极小（300B）——全会话压到保底 1 条时，有消息的会话最后留的
// 必须是消息（噪音先丢），纯噪音会话留噪音
const S3 = "ext-snap-c";
mgr.ensureExternal(S3, "/tmp/proj-c", "会话C");
for (let i = 0; i < 20; i++) mgr.pushExternalLog(S3, i === 5 || i === 15 ? "assistant_text" : "tool_use", i === 5 || i === 15 ? `a${i}` : `x${i}`);
const S4 = "ext-snap-d";
mgr.ensureExternal(S4, "/tmp/proj-d", "会话D");
for (let i = 0; i < 20; i++) mgr.pushExternalLog(S4, "tool_result", `y${i}`);
{
  const r = mgr.buildSnapshotLogs(300, 50);
  const c3 = r.logs[S3] ?? [];
  const c4 = r.logs[S4] ?? [];
  assert(c3.length === 1 && isMsg(c3[0] as LogEntry), `预算压底后有消息会话留消息 got=${c3.map((e) => e.kind + ":" + e.text).join(",")}`);
  assert(c4.length >= 1 && c4.every((e) => !isMsg(e)), `纯噪音会话不保消息（预算够小即停，条数≤2）got=${c4.map((e) => e.kind + ":" + e.text).join(",")}`);
  assert(r.logs_truncated[S3]! + c3.length === 20 && r.logs_truncated[S4]! + c4.length === 20, `截断计数账目恒等 got=${r.logs_truncated[S3]}+${c3.length} / ${r.logs_truncated[S4]}+${c4.length}`);
}

// 场景④：极端全消息刷屏（60 条消息 > cap）仍裁最旧保 50——防消息洪水撑爆帧
const S5 = "ext-snap-e";
mgr.ensureExternal(S5, "/tmp/proj-e", "会话E");
for (let i = 0; i < 60; i++) mgr.pushExternalLog(S5, "assistant_text", `s${i}`);
{
  const r = mgr.buildSnapshotLogs(512 * 1024, 50);
  const c5 = r.logs[S5] ?? [];
  assert(c5.length === 50 && c5[0]!.text === "s10" && c5[49]!.text === "s59", `消息洪水仍受帽 got=${c5.length} first=${c5[0]?.text}`);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nSNAPLOGS TESTS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
