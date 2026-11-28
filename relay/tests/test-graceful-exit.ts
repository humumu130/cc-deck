// W-RELDEATH 随批回归锁：graceful-exit.ts 告别行纯函数（DEV-18 P0-A——治 SIGTERM 静默死
// 排障盲区：2026-11-24 换装 kill 后 embedded-relay.log 尾部零线索，只能靠 mtime+外部
// 日志倒推死亡时刻与信号）。锁死三态：无活派单（告别行仍打）、有活派单（明细逐一列
// 行）、账不可读（计数位标「派单账不可读」而非误导性 0）。
import { gracefulExitLines, type GracefulDispatchRow } from "../src/graceful-exit.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

// ── 无活派单：告别行无条件在（旧版此态零输出=排障盲区的本体）──
{
  const lines = gracefulExitLines("SIGTERM", 4242, []);
  assert(lines.length === 1, "无活派单恰好一行");
  assert(lines[0].includes("[graceful]") && lines[0].includes("SIGTERM") && lines[0].includes("pid=4242"), "行含 [graceful]+信号+pid");
  assert(lines[0].includes("活派单 0"), "计数位 0");
}

// ── 有活派单：首行 + 恢复提示 + 明细逐一 ──
{
  const rows: GracefulDispatchRow[] = [
    { id: "d1", status: "dispatched", title: "单甲" },
    { id: "d2", status: "running", title: "单乙" },
    { id: "d3", status: "done", title: "已完（不计）" },
    { id: "d4", status: "queued", title: "排队（不计）" },
  ];
  const lines = gracefulExitLines("SIGINT", 99, rows);
  assert(lines.length === 4, "2 活单 → 首行+提示行+2 明细行");
  assert(lines[0].includes("活派单 2"), "只计 dispatched/running");
  assert(lines.some((l) => l.includes("d1") && l.includes("单甲")) && lines.some((l) => l.includes("d2") && l.includes("单乙")), "活单明细逐一列行");
  assert(!lines.some((l) => l.includes("d3") || l.includes("d4")), "终态/排队单不混入");
  assert(!lines[0].includes("reloadDispatchQueue"), "首行保持单行简洁（恢复提示不挤首行）");
  assert(lines[1].includes("reloadDispatchQueue"), "恢复提示语义保留");
}

// ── 账不可读（null）：告别行仍打，计数位如实标注 ──
{
  const lines = gracefulExitLines("SIGTERM", 7, null);
  assert(lines.length === 1, "账不可读不炸、不臆造明细");
  assert(lines[0].includes("派单账不可读"), "计数位标「派单账不可读」（不误导为 0）");
  assert(lines[0].includes("pid=7"), "pid 仍在（对表 ps 用）");
}

console.log(fail === 0 ? `\nPASS test-graceful-exit (${pass} assertions)` : `\nFAIL test-graceful-exit: ${fail} failed / ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
