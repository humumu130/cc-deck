// W-BOARDTRUTH7（1117 用户实锤第七现）：投影终态吸收回归。
// 形态：收割 done transition 落账后，迟到的「交付申报族」dispatch 行（纯六态 done /
// worker-done / in_review / submitted——ts 晚于收割）不得把卡打回「审查中」。
// 复活门：只有新一轮开工信号（queued/dispatched/failed→backlog、running/worker-start→claimed）
// 才允许翻案。四断言 + 对照（正常流不受影响）。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

const dataDir = mkdtempSync(join(tmpdir(), "bt7-"));
process.env.CCR_DATA_DIR = dataDir;
mkdirSync(join(dataDir, "org", "boards"), { recursive: true });

// 动态 import（env 先行）
const { projectBoard, clearBoardProjectionCache } = await import("../src/board-projection.js");
const { saveBoardFile } = await import("../src/projects.js");
type Proj = ReturnType<typeof projectBoard>;

const GID = "pg-test";
const T0 = Date.parse("2026-11-01T00:00:00Z");

function mkEntry(id: string, dispatchId: string, transitions: { status: string; ts: number }[], status: string) {
  return { id, text: `卡-${id}`, status, owner_session: "s1", dispatch_id: dispatchId, ts: T0, updated_at: T0, transitions };
}
function row(id: string, status: string, ts: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ts, id, tier: "正经立项", target: "org-leader", status, session_id: "s1", ...extra });
}
function setup(entries: unknown[], rows: string[]) {
  clearBoardProjectionCache();
  writeFileSync(join(dataDir, "org", "boards", `${GID}.json`), JSON.stringify({ gid: GID, entries, frozen: false, updated_at: T0 }));
  writeFileSync(join(dataDir, "org", "dispatch-log.ndjson"), rows.map((r) => r + "\n").join(""));
  return projectBoard(GID);
}
const laneOf = (p: Proj, id: string) => p.cards.find((c) => c.entry_id === id)?.lane;

// ① 第七现主形态：收割 transition done@T0+1000，dispatch 纯六态 done 行 ts=T0+9000（迟到申报）
{
  const p = setup(
    [mkEntry("a1", "d1", [{ status: "claimed", ts: T0 }, { status: "submitted", ts: T0 + 500 }, { status: "done", ts: T0 + 1000 }], "done")],
    [row("d1", "dispatched", T0 + 100), row("d1", "done", T0 + 9000)],
  );
  ok(laneOf(p, "a1") === "done", `① 迟到 dispatch:done（晚 8s 于收割）被吸收——lane=${laneOf(p, "a1")}`);
}
// ② 迟到 worker-done 事件行（同族：交付申报）
{
  const p = setup(
    [mkEntry("a2", "d2", [{ status: "claimed", ts: T0 }, { status: "done", ts: T0 + 1000 }], "done")],
    [row("d2", "dispatched", T0 + 100), row("d2", "done", T0 + 8000, { event: "worker-done", receipt: "交付" })],
  );
  ok(laneOf(p, "a2") === "done", `② 迟到 worker-done 事件行被吸收——lane=${laneOf(p, "a2")}`);
}
// ③ 复活门：done 后新一轮 queued（同 dispatch 链重派）→ backlog（真开工才翻案）
{
  const p = setup(
    [mkEntry("a3", "d3", [{ status: "claimed", ts: T0 }, { status: "done", ts: T0 + 1000 }], "done")],
    [row("d3", "dispatched", T0 + 100), row("d3", "done", T0 + 2000), row("d3", "queued", T0 + 9000)],
  );
  ok(laneOf(p, "a3") === "backlog", `③ done 后新一轮 queued 复活——lane=${laneOf(p, "a3")}`);
}
// ④ 对照：正常流（申报在前、收割在后）不受影响
{
  const p = setup(
    [mkEntry("a4", "d4", [{ status: "claimed", ts: T0 }, { status: "submitted", ts: T0 + 2000 }, { status: "done", ts: T0 + 3000 }], "done")],
    [row("d4", "dispatched", T0 + 100), row("d4", "done", T0 + 2000)],
  );
  ok(laneOf(p, "a4") === "done", `④ 正常流（收割晚于申报）仍 done——lane=${laneOf(p, "a4")}`);
}
// ⑤ 对照：未收割的申报照旧进审查中（吸收不误伤在途）
{
  const p = setup(
    [mkEntry("a5", "d5", [{ status: "claimed", ts: T0 }, { status: "submitted", ts: T0 + 500 }], "submitted")],
    [row("d5", "dispatched", T0 + 100), row("d5", "done", T0 + 9000)],
  );
  ok(laneOf(p, "a5") === "submitted", `⑤ 无收割落账的迟到申报仍进审查中——lane=${laneOf(p, "a5")}`);
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n§BOARDTRUTH7：${pass} ok / ${fail} FAIL`);
if (fail) process.exit(1);
