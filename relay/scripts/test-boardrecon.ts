// [W-BOARDRECON]（t-7c780d9a）三断言组：
//   ①终态翻卡既有面核验（boardlife/boardfix 已在 dev——不重做，锚确认）
//   ②孤儿归位：死会话 claimed 卡→对账清单 orphan-session→（auto 档）backlog+note 留痕
//   ③一致性告警：5 在岗 8 卡→mismatch 生成（不静默）
// 外加：台账终态漏网/滞留超窗/活性对照/纯净板零动作。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { reconcileBoardCards, type ReconSession, type ReconDispatchRow } from "../src/board-recon.js";
import type { ProjectBoard } from "../src/projects.js";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const now = Date.now();
const mkBoard = (entries: ProjectBoard["entries"]): ProjectBoard => ({ gid: "g-recon", entries, frozen: false, updated_at: now } as ProjectBoard);
const mkEntry = (over: Partial<ProjectBoard["entries"][number]>): ProjectBoard["entries"][number] =>
  ({ id: "t-" + Math.random().toString(36).slice(2, 8), text: "任务卡", ts: now - 7200_000, updated_at: now - 1800_000, ...over } as never);

async function main(): Promise<void> {
  console.log("① 终态翻卡既有面锚（boardlife/boardfix 在 dev——本单不重做）:");
  {
    const sm = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf8");
    assert(sm.includes("review_required: true }"), "boardlife 交付边在（close done→R2 内核 submitted）");
    const pj = readFileSync(join(process.cwd(), "src", "projects.ts"), "utf8");
    assert(pj.includes("convergeBoardsWithDispatchLog") && pj.includes("reconAutoCloseStaleCards") || sm.includes("reconAutoCloseStaleCards"), "boardfix converge/recon 在（台账终态翻面既有件）");
    const pt = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf8");
    assert(pt.includes("CCR_BOARDRECON_MODE") && pt.includes("board-recon"), "patrol 挂三方对账（observe/auto 档）");
  }

  console.log("② 孤儿归位（死会话 claimed 卡→清单→auto 真归位）:");
  {
    const sessions: ReconSession[] = [
      { session_id: "s-live", status: "WORKING" },
      { session_id: "s-done", status: "DONE", done_reason: "success" },
    ];
    const board = mkBoard([
      mkEntry({ id: "t-orphan", owner_session: "s-dead", status: "claimed", text: "孤儿卡（owner 已死）" }),
      mkEntry({ id: "t-terminal", owner_session: "s-live", status: "claimed", dispatch_id: "d-fin", text: "台账终态漏网卡", updated_at: now - 2 * 3600_000 }),
      mkEntry({ id: "t-stale", owner_session: "s-live", status: "claimed", text: "滞留超窗卡", updated_at: now - 5 * 3600_000 }),
      mkEntry({ id: "t-fresh", owner_session: "s-live", status: "claimed", text: "健康在途卡" }),
    ]);
    const log: ReconDispatchRow[] = [
      { id: "d-fin", status: "done" },
      { id: "d-run", status: "running" },
    ];
    const r = reconcileBoardCards({ boards: [{ gid: "g-recon", board }], sessions, dispatchLog: log, now });
    const reasons = r.actions.map((a) => a.reason);
    assert(reasons.includes("orphan-session"), `死会话 claimed 卡入清单 orphan-session（实 ${JSON.stringify(reasons)}）`);
    assert(reasons.includes("ledger-terminal"), `台账终态漏网卡入清单（d-fin done 而卡 claimed——实 ${JSON.stringify(reasons)}）`);
    assert(reasons.includes("stale-no-progress"), `滞留 5h 卡入清单（阈值 4h——实 ${JSON.stringify(reasons)}）`);
    const freshHit = r.actions.find((a) => a.entryId === "t-fresh");
    assert(!freshHit, "健康在途卡（owner 活+新鲜+台账非终态）零动作");
    const runHit = r.actions.find((a) => a.entryId === "t-terminal" && a.detail.includes("running"));
    assert(!runHit, "running 台账不算终态（对照）");
    assert(r.actions.every((a) => a.toBacklog), "全部动作目标=backlog（可重派）");
  }

  console.log("③ 一致性告警（5 在岗 8 卡→mismatch 不静默）:");
  {
    const sessions: ReconSession[] = Array.from({ length: 5 }, (_, i) => ({ session_id: `s-w${i}`, status: "WORKING" }));
    const entries = Array.from({ length: 8 }, (_, i) => mkEntry({ id: "t-c" + i, owner_session: i < 5 ? `s-w${i}` : "s-dead" + i, status: "claimed" }));
    const r = reconcileBoardCards({ boards: [{ gid: "g", board: mkBoard(entries) }], sessions, dispatchLog: [], now });
    assert(r.workingSessions === 5 && r.claimedCards === 8, `计数如实（工作 5/卡 8——实 ${r.workingSessions}/${r.claimedCards}）`);
    assert(r.mismatch !== null && r.mismatch.includes("5") && r.mismatch.includes("8"), `mismatch 告警生成（实 ${JSON.stringify(r.mismatch)}）`);
    assert(r.actions.filter((a) => a.reason === "orphan-session").length === 3, "超额 3 卡全判孤儿（owner 不在册）");
  }
  {
    // 账实相符形态：零 mismatch 零动作
    const sessions: ReconSession[] = [{ session_id: "s-1", status: "WORKING" }];
    const r2 = reconcileBoardCards({ boards: [{ gid: "g", board: mkBoard([mkEntry({ owner_session: "s-1", status: "claimed" })]) }], sessions, dispatchLog: [], now });
    assert(r2.mismatch === null && r2.actions.length === 0, `账实相符：零告警零动作（实 ${JSON.stringify(r2.mismatch)}/${r2.actions.length}）`);
  }
  console.log(`\n========== boardrecon 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
