// W-PMWAKE：worker DONE→PM 唤醒候选断言（1013 夜四报告落地 5h43m 无人收割实证）。
// 纯函数面：worker_done_pending 计数 → DutyCandidate「worker_done」→ actionable。
import {
  type DutyQueueSnapshot,
  evaluateLeaderActionableWork,
} from "../src/leader-duty.js";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => { if (cond) { pass++; console.log("  ok " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " | " + detail : "")); } };

const base: DutyQueueSnapshot = { now: 1_000_000 };

// ① 有未处理 worker DONE → actionable + 候选形态
{
  const r = evaluateLeaderActionableWork({ ...base, worker_done_pending: 3 });
  const c = r.candidates.find((x) => x.kind === "worker_done");
  ok(r.actionable && !!c, "① worker_done_pending>0 → actionable", JSON.stringify(r.candidates));
  ok(c?.id === "worker-done-pending-3", "① 计数进候选 id", c?.id);
}

// ② 计数=0 → 无该候选（裸快照回落 empty）
{
  const r = evaluateLeaderActionableWork({ ...base, worker_done_pending: 0 });
  ok(!r.candidates.some((x) => x.kind === "worker_done") && !r.actionable, "② 零计数不产生候选");
}

// ③ 与 blocked 并存：候选优先于 blocked（actionable 压过等待）
{
  const r = evaluateLeaderActionableWork({
    ...base,
    worker_done_pending: 2,
    blocked: [{ id: "t-gate", reason: "external" }],
  });
  ok(r.actionable && r.candidates.some((x) => x.kind === "worker_done"), "③ blocked 并存时 worker_done 仍 actionable");
}

// ④ 与 stale_doing 并存：两类候选同列（互不吞）
{
  const r = evaluateLeaderActionableWork({
    ...base,
    worker_done_pending: 1,
    stale_doing: [{ session_id: "s-x", doing_ms: 90 * 60_000, dispatch_id: "d-1" }],
  });
  const kinds = r.candidates.map((x) => x.kind);
  ok(kinds.includes("worker_done") && kinds.includes("stale_doing"), "④ 与 stale_doing 并存互不吞", JSON.stringify(kinds));
}

console.log(fail === 0 ? `WORKER-DONE TESTS: ${pass} pass / ${fail} fail` : `FAIL: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
