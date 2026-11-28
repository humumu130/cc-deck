// W-P0-FIX P0-3 等价契约测试：bootReplayFile（单遍流式）=== loadEvents→compactEvents→
// reduceHistory(kept) 三步串联（boot 旧路径）。随机事件流 ×N 轮 + 边界形态（复活/孤儿
// DELETE/超窗截尾/坏行/多会话活跃度排序/已最简不重写）双算法产物逐字节对比。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootReplayFile, compactEvents, loadEvents, reduceHistory, appendLine } from "../src/history.js";
import type { Envelope, EventType } from "../src/types.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}
function section(t: string) { console.log(t); }

// 随机事件流发生器（确定性种子）
let seed = 20261013;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const TYPES: EventType[] = ["SESSION_CREATED", "SESSION_UPDATED", "SESSION_LOG", "SESSION_HEARTBEAT", "SESSION_DONE", "SESSION_ERROR", "SESSION_WAITING", "SESSION_WAITING_RESOLVED", "SESSION_DELETED", "TASK_DONE"];
function genStream(nSessions: number, nEvents: number, sidPool = 6): Envelope[] {
  const sids = Array.from({ length: nSessions }, (_, i) => `s-${i % sidPool}`);
  const out: Envelope[] = [];
  let seq = 1;
  for (let i = 0; i < nEvents; i++) {
    const sid = sids[Math.floor(rnd() * sids.length)];
    const type = TYPES[Math.floor(rnd() * TYPES.length)];
    // CREATED 载荷按 reduceHistory 真实形态（deriveTitle 吃 initial_prompt）
    const payload = type === "SESSION_CREATED"
      ? { cwd: "/tmp/g", initial_prompt: "gen-" + i, model: "test-model" }
      : type === "SESSION_UPDATED"
        ? { status: "WORKING", action_summary: "sum-" + i, stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 } }
        : { k: i };
    out.push({ seq: seq++, session_id: sid, ts: Date.now() - (nEvents - i) * 1000, type, payload });
  }
  // 保证至少一个会话有 CREATED（否则全残缺）
  out.unshift({ seq: 0, session_id: "s-0", ts: Date.now() - nEvents * 1000, type: "SESSION_CREATED", payload: { cwd: "/tmp", initial_prompt: "p", model: "m" } });
  return out;
}
function serialize(events: Envelope[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const dirs: string[] = [];
async function withFile(name: string, content: string): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "ccr-hstr-"));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// 归一化：reduceHistory 给非终态会话补的「服务更新重启」系统日志 ts=调用时刻
// Date.now()（两算法两次调用必差毫秒）——对比前归零，等价性只看算法产物本身
function normSessions(m: Map<string, { logs?: { ts: number; kind: string; text: string }[] }>): string {
  return JSON.stringify([...m.entries()], (k, v) => {
    if (k === "logs" && Array.isArray(v)) {
      return v.map((l) => (l && l.kind === "system" && /服务更新重启/.test(String(l.text)) ? { ...l, ts: 0 } : l));
    }
    return v;
  });
}

async function equivCase(label: string, events: Envelope[], extraLines = ""): Promise<void> {
  const p = await withFile("events.ndjson", serialize(events) + extraLines);
  const prior = loadEvents(p);
  const keptOld = compactEvents(prior);
  const sessionsOld = reduceHistory(keptOld);
  const boot = await bootReplayFile(p);
  assert(
    JSON.stringify(boot.kept) === JSON.stringify(keptOld),
    `${label}: kept 等价（流式=三步）`,
  );
  assert(
    normSessions(boot.sessions) === normSessions(sessionsOld),
    `${label}: 重放态等价`,
  );
  assert(boot.compacted === (prior.length !== keptOld.length), `${label}: 压缩判定等价`);
}

// ---------- S1 随机流等价 ×5 轮（形态各异） ----------
section("\nS1 随机事件流双算法等价");
await equivCase("S1a 小流", genStream(3, 40));
await equivCase("S1b 中流多会话", genStream(8, 600));
await equivCase("S1c 大流超窗（截尾必触发）", genStream(4, 4000));
await equivCase("S1d 稀疏流", genStream(2, 30, 2));
await equivCase("S1e 密集单会话", genStream(1, 2000, 1));

// ---------- S2 边界形态 ----------
section("\nS2 边界形态等价");
{
  // 复活：DELETED 后同 sid 再 CREATED + 事件
  const revived: Envelope[] = [
    { seq: 1, session_id: "r-1", ts: 1000, type: "SESSION_CREATED", payload: { cwd: "/a", initial_prompt: "x", model: "m" } },
    { seq: 2, session_id: "r-1", ts: 2000, type: "SESSION_UPDATED", payload: { status: "WORKING", action_summary: "a" } },
    { seq: 3, session_id: "r-1", ts: 3000, type: "SESSION_DELETED", payload: {} },
    { seq: 4, session_id: "r-1", ts: 4000, type: "SESSION_CREATED", payload: { cwd: "/a", initial_prompt: "y", model: "m2" } },
    { seq: 5, session_id: "r-1", ts: 5000, type: "SESSION_UPDATED", payload: { status: "DONE", action_summary: "b" } },
  ];
  await equivCase("S2a 复活（删后重建）", revived);
  // 孤儿 DELETE（未建桶）
  const orphan: Envelope[] = [
    { seq: 1, session_id: "ghost", ts: 1000, type: "SESSION_DELETED", payload: {} },
    { seq: 2, session_id: "s-0", ts: 2000, type: "SESSION_CREATED", payload: { cwd: "/b", initial_prompt: "z", model: "m" } },
  ];
  await equivCase("S2b 孤儿 DELETE", orphan);
  // 尾删（桶建后被删，无复活）
  const tailDel: Envelope[] = [
    { seq: 1, session_id: "d-1", ts: 1000, type: "SESSION_CREATED", payload: { cwd: "/c", initial_prompt: "p", model: "m" } },
    { seq: 2, session_id: "d-1", ts: 2000, type: "SESSION_LOG", payload: { kind: "assistant_text", text: "hi" } },
    { seq: 3, session_id: "d-1", ts: 3000, type: "SESSION_DELETED", payload: {} },
  ];
  await equivCase("S2c 尾删（整组丢弃）", tailDel);
  // 坏行与空行（loadEvents 同口径跳过）
  const dirty = genStream(2, 50);
  await equivCase("S2d 坏行/空行混入", dirty, "{ broken json !!\n\n" + JSON.stringify({ not: "envelope" }) + "\n");
  // 空文件
  await equivCase("S2e 空文件", []);
}

// ---------- S3 行为断言（压缩判定/重写幂等） ----------
section("\nS3 行为断言");
{
  const p = await withFile("events.ndjson", serialize(genStream(3, 300)));
  const b1 = await bootReplayFile(p);
  assert(b1.compacted === true, "S3 超窗流 compacted=true");
  // 已最简流：kept===prior（全部保留型事件且不超窗）
  const minimal: Envelope[] = [
    { seq: 1, session_id: "m-1", ts: 1000, type: "SESSION_CREATED", payload: { cwd: "/d", initial_prompt: "q", model: "m" } },
    { seq: 2, session_id: "m-1", ts: 2000, type: "SESSION_UPDATED", payload: { status: "DONE", action_summary: "ok" } },
  ];
  const p2 = await withFile("min.ndjson", serialize(minimal));
  const b2 = await bootReplayFile(p2);
  assert(b2.compacted === false, "S3 最简流 compacted=false（不白重写）");
  assert(b2.kept.length === 2, "S3 最简流全保留");
  // appendLine 与流式读兼容（追加后再 boot 仍等价）
  appendLine(p2, { seq: 3, session_id: "m-1", ts: 3000, type: "SESSION_LOG", payload: { kind: "system", text: "later" } });
  const b3 = await bootReplayFile(p2);
  const o3 = reduceHistory(compactEvents(loadEvents(p2)));
  assert(normSessions(b3.sessions) === normSessions(o3), "S3 追加后双算法仍等价");
}

// ---------- 收尾 ----------
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
console.log(`\nhistory-stream: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
