// 历史持久化测试：deriveTitle / compactEvents / reduceHistory / EventBus 持久化+预载 / adopt
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { compactEvents, deriveTitle, loadEvents, reduceHistory, rewriteFile } from "../src/history.js";
import type { Envelope, SnapshotPayload } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- deriveTitle ----------
console.log("deriveTitle:");
assert(deriveTitle("帮我重构登录模块\n另外注意样式") === "帮我重构登录模块", "取首行");
assert(deriveTitle("  ```bash\n跑测试") === "跑测试", "剥离 markdown 前缀");
assert(deriveTitle("a".repeat(40)).length === 25 && deriveTitle("a".repeat(40)).endsWith("…"), "超长截断 24+省略号");
assert(deriveTitle("   ") === "未命名会话", "空白兜底");

// ---------- compactEvents ----------
console.log("compactEvents:");
const mk = (seq: number, sid: string, type: string, payload: unknown = {}): Envelope =>
  ({ seq, session_id: sid, ts: 1000 + seq, type: type as Envelope["type"], payload });

const events: Envelope[] = [];
let seq = 0;
const sid = "s1";
events.push(mk(++seq, sid, "SESSION_CREATED", { cwd: "/tmp", initial_prompt: "测试", title: "测试", model: "m" }));
for (let i = 0; i < 350; i++) events.push(mk(++seq, sid, "SESSION_LOG", { kind: "assistant_text", text: `log${i}` }));
for (let i = 0; i < 80; i++) events.push(mk(++seq, sid, "SESSION_UPDATED", { status: "WORKING", action_summary: `u${i}`, stats: null }));
events.push(mk(++seq, sid, "SESSION_HEARTBEAT", { elapsed_ms: 1, action_summary: "h" }));
events.push(mk(++seq, sid, "SESSION_DONE", { terminal_reason: "success", duration_ms: 100, stats: { files_changed: 1, lines_added: 2, lines_deleted: 3 } }));

const compacted = compactEvents(events);
assert(!compacted.some((e) => e.type === "SESSION_HEARTBEAT"), "丢弃心跳");
const logs = compacted.filter((e) => e.type === "SESSION_LOG");
assert(logs.length === 300 && (logs[0].payload as { text: string }).text === "log50", "每会话日志保留最后 300 条");
const nonCreatedStates = compacted.filter((e) => e.type !== "SESSION_CREATED" && e.type !== "SESSION_LOG");
assert(nonCreatedStates.length === 50, "非 CREATED 状态事件保留最后 50 条");
assert(compacted.some((e) => e.type === "SESSION_CREATED") && compacted.some((e) => e.type === "SESSION_DONE"), "保留 CREATED/DONE");
assert(compacted.every((e, i, a) => i === 0 || a[i - 1].seq <= e.seq), "保持 seq 有序");

// ---------- reduceHistory ----------
console.log("reduceHistory:");
const replayed = reduceHistory(compacted);
const rs = replayed.get(sid);
assert(!!rs, "会话重建");
assert(rs!.state.title === "测试", "标题恢复");
assert(rs!.state.status === "DONE" && rs!.state.done_reason === "success", "终态恢复");
assert(rs!.state.stats.lines_added === 2 && rs!.state.stats.lines_deleted === 3, "统计恢复");
assert(rs!.logs.length === 301, "时间线 = 300 日志 + 1 完成事件");

// 非终态会话 → ERROR + historical
const events2 = [mk(1, "s2", "SESSION_CREATED", { cwd: "/x", initial_prompt: "中断测试", model: "m" }), mk(2, "s2", "SESSION_UPDATED", { status: "WORKING", action_summary: "干活", stats: null })];
const replayed2 = reduceHistory(events2);
const rs2 = replayed2.get("s2")!;
assert(rs2.state.status === "ERROR" && rs2.state.last_error === "Relay 重启，会话中断", "非终态标记 ERROR");
assert(rs2.state.historical === true, "标记 historical");
assert(rs2.logs.at(-1)!.text === "Relay 重启，会话中断", "中断事件入时间线");

// ---------- EventBus 持久化 + 预载 ----------
console.log("EventBus 持久化:");
const dir = mkdtempSync(join(tmpdir(), "ccr-hist-"));
const persistPath = join(dir, "events.ndjson");

const bus1 = new EventBus({ persistPath });
bus1.emit("a", "SESSION_CREATED", { cwd: "/a", initial_prompt: "p", title: "t", model: "m" });
bus1.emit("a", "SESSION_LOG", { kind: "system", text: "x" });
bus1.emit("a", "SESSION_DONE", { terminal_reason: "success", duration_ms: 5, stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 } });

const disk = loadEvents(persistPath);
assert(disk.length === 3 && disk[2].seq === 3, "事件落盘且 seq 正确");

// 模拟重启：压缩 + 预载
const kept2 = compactEvents(disk);
const bus2 = new EventBus({ preload: kept2, persistPath });
assert(bus2.lastSeq() === 3, "重启后 seq 延续（新事件从 4 开始）");
const before = bus2.emit("a", "SESSION_LOG", { kind: "system", text: "y" });
assert(before.seq === 4, "新事件 seq=4");
assert(bus2.replayAfter(3).length === 1, "跨重启补发缺口");
const snapshot = { sessions: null as unknown, logs: null as unknown } as SnapshotPayload;

// ---------- SessionManager.adopt ----------
console.log("SessionManager.adopt:");
const cfg = loadConfig();
cfg.token = "test";
const mgr = new SessionManager(bus2, cfg);
const n = mgr.adopt(reduceHistory(kept2));
assert(n === 1, "收养 1 个历史会话");
const snap = mgr.snapshot();
assert(snap.length === 1 && snap[0].historical === true && snap[0].title === "t", "快照含历史会话");
const ack = mgr.handleCommand(
  { command_id: "c1", type: "COMMAND_STOP", ts: Date.now(), payload: { session_id: snap[0].session_id } },
  "test-client",
);
assert(ack.ok === false && (ack.error ?? "").includes("不可操作"), "历史会话拒绝 STOP");
const ack2 = mgr.handleCommand(
  { command_id: "c2", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: snap[0].session_id, text: "hi" } },
  "test-client",
);
assert(ack2.ok === false, "历史会话拒绝 MESSAGE");
assert(Object.keys(mgr.snapshotLogs()).length === 1, "快照含时间线");

rmSync(dir, { recursive: true, force: true });
void snapshot;

console.log(`\n${fail === 0 ? "HISTORY TESTS PASSED" : "HISTORY TESTS FAILED"} (${pass} pass / ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
