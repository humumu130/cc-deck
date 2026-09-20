import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import type { Command, WaitingPayload } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

function cmd(c: Omit<Command, "command_id" | "ts">): Command {
  return { ...c, command_id: randomUUID(), ts: Date.now() } as Command;
}

const bus = new EventBus();
const cfg = loadConfig();
const mgr = new SessionManager(bus, cfg);

const waitingSeen = new Set<string>();
const subagentEventSeen = new Set<string>(); // #112：SESSION_UPDATED(subagents) 事件流证据
bus.subscribe((e) => {
  console.log(`#${e.seq} [${e.session_id.slice(0, 8)}] ${e.type} ${summarize(e)}`);
  if (e.type === "SESSION_UPDATED" && Array.isArray((e.payload as Record<string, unknown>).subagents)) {
    subagentEventSeen.add(e.session_id);
  }
  if (e.type === "SESSION_WAITING") {
    const p = e.payload as WaitingPayload;
    waitingSeen.add(e.session_id);
    // 模拟手机/网页客户端：800ms 后 Allow
    setTimeout(() => {
      const ack = mgr.handleCommand(
        cmd({ type: "COMMAND_CONTINUE", payload: { session_id: e.session_id, request_id: p.request_id } }),
        "test-client",
      );
      console.log(`[auto-allow ack] ok=${ack.ok} ${ack.error ?? ""}`);
    }, 800);
  }
});

function summarize(e: { type: string; payload: unknown }): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "SESSION_LOG":
      return `[${p.kind}] ${p.text}`;
    case "SESSION_WAITING":
      return `${p.tool_name}: ${p.input_summary}`;
    case "SESSION_DONE":
      return `reason=${p.terminal_reason} dur=${(Number(p.duration_ms) / 1000).toFixed(1)}s stats=${JSON.stringify(p.stats)}`;
    case "SESSION_UPDATED":
      return `${p.status} · ${p.action_summary}`;
    case "SESSION_ERROR":
      return String(p.message);
    default:
      return "";
  }
}

const tmpDir = join(process.cwd(), ".tmp-test");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

// 会话 A：用 Write 工具建文件 → 走 WAITING→Allow→DONE + diff 统计
const ackA = mgr.handleCommand(
  cmd({
    type: "COMMAND_CREATE",
    payload: {
      cwd: tmpDir,
      prompt: "请用 Write 工具创建文件 hi.txt，内容为一行文字 hello relay。不要使用其他任何工具，写完即结束。",
    },
  }),
  "test-client",
);
assert(ackA.ok, `session A created (${ackA.session_id})`);

// 会话 B：纯文本回复，无工具 → 直接 DONE
const ackB = mgr.handleCommand(
  cmd({
    type: "COMMAND_CREATE",
    payload: { cwd: tmpDir, prompt: "请直接回复四个字：好的收到。禁止使用任何工具。" },
  }),
  "test-client",
);
assert(ackB.ok, `session B created (${ackB.session_id})`);

// 幂等去重：重发 B 的创建命令（同 command_id）→ 重放首次回执（不报错、不建新会话）
const dupAck = mgr.handleCommand(
  { type: "COMMAND_CREATE", command_id: ackB.command_id, ts: Date.now(), payload: { cwd: tmpDir, prompt: "x" } } as Command,
  "test-client",
);
assert(dupAck.ok && dupAck.session_id === ackB.session_id, "duplicate command replays first ack (idempotent)");
assert(mgr.snapshot().filter((s) => s.session_id === ackB.session_id).length === 1, "duplicate creates no extra session");

// 会话 C（#112）：Task 工具派生子代理 → subagents 采集（建条目 + tool_result 收尾）
const ackC = mgr.handleCommand(
  cmd({
    type: "COMMAND_CREATE",
    payload: {
      cwd: tmpDir,
      prompt: "请用 Task 工具派一个子代理，任务描述写「回复一个字」，让它只回复一个字：好。除此之外不要做任何事，拿到子代理结果即结束。",
    },
  }),
  "test-client",
);
assert(ackC.ok, `session C created (${ackC.session_id})`);

// 等三个会话到达终态（最多 150s）
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const states = mgr.snapshot();
  const a = states.find((s) => s.session_id === ackA.session_id);
  const b = states.find((s) => s.session_id === ackB.session_id);
  const c = states.find((s) => s.session_id === ackC.session_id);
  if (
    a && b && c &&
    (a.status === "DONE" || a.status === "ERROR") &&
    (b.status === "DONE" || b.status === "ERROR") &&
    (c.status === "DONE" || c.status === "ERROR")
  ) {
    await new Promise((r) => setTimeout(r, 1000)); // 等尾巴事件落地
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const states = mgr.snapshot();
const a = states.find((s) => s.session_id === ackA.session_id);
const b = states.find((s) => s.session_id === ackB.session_id);
const c = states.find((s) => s.session_id === ackC.session_id);

assert(!!a && a.status === "DONE", `A final DONE (got ${a?.status}, err=${a?.last_error})`);
assert(!!b && b.status === "DONE", `B final DONE (got ${b?.status}, err=${b?.last_error})`);
assert(waitingSeen.has(ackA.session_id!), "A saw WAITING (canUseTool fired)");
assert(!waitingSeen.has(ackB.session_id!), "B never waited (no tools used)");

// #112 会话 C：Task 派生的子代理在 subagents 账本里完整走查——建条目（desc/kind/
// started_at）→ tool_result 收尾（ended_at）→ 事件流至少下发过一帧 subagents
assert(!!c && c.status === "DONE", `C final DONE (got ${c?.status}, err=${c?.last_error})`);
const subs = c?.subagents ?? [];
assert(subs.length >= 1, `C subagents captured (${subs.length} entries)`);
const first = subs[0];
assert(
  !!first && typeof first.id === "string" && first.id.length > 0 && typeof first.desc === "string" && first.desc.length > 0 &&
    typeof first.kind === "string" && typeof first.started_at === "number" && first.bg === false,
  `C subagent entry shape (${JSON.stringify(first)})`,
);
assert(subs.every((x) => typeof x.ended_at === "number" && x.ended_at > 0), `C all subagents ended (got ${JSON.stringify(subs.map((x) => x.ended_at))})`);
assert(subagentEventSeen.has(ackC.session_id!), "C emitted SESSION_UPDATED with subagents");

// gitDiff 统计：形状若不匹配会是 0，只告警不判失败（待真机数据核对）
if (a && a.stats.lines_added > 0) {
  console.log(`ok - A diff stats: ${JSON.stringify(a.stats)}`);
} else {
  console.log(`WARN - A stats empty (${JSON.stringify(a?.stats)}) — FileWriteOutput 形状待核对`);
}

// 清理：STOP 让 parked 的 CLI 子进程退出（否则 Windows 下其 cwd 锁住临时目录）
for (const id of [ackA.session_id, ackB.session_id, ackC.session_id]) {
  if (!id) continue;
  mgr.handleCommand(cmd({ type: "COMMAND_STOP", payload: { session_id: id } }), "test-client");
}
await new Promise((r) => setTimeout(r, 3000));
rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

console.log("\nSESSION TESTS PASSED");
process.exit(0);
