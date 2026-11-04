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
import type { BoardEntry } from "../src/projects.js";
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
    assert(pt.includes('autoTierOf("boardrecon")') && pt.includes("board-recon"), "patrol 挂三方对账（R1-P1-3：autoTierOf 单点——原 CCR_BOARDRECON_MODE 绕过已退役）");
  }

  console.log("② 孤儿判死多源聚合+两拍确认（R1-P0-1）:")
  {
    const sessions: ReconSession[] = [
      { session_id: "s-live", status: "WORKING" },
      { session_id: "s-dead", status: "DONE", done_reason: "success" }, // 白名单真终态
    ];
    const board = mkBoard([
      mkEntry({ id: "t-orphan", owner_session: "s-dead", status: "claimed", text: "真死孤儿卡", updated_at: now - 2 * 3600_000 }),
      mkEntry({ id: "t-stale", owner_session: "s-live", status: "claimed", text: "滞留超窗卡（owner 活跃）", updated_at: now - 5 * 3600_000 }),
      mkEntry({ id: "t-fresh", owner_session: "s-live", status: "claimed", text: "健康在途卡" }),
    ]);
    const log: ReconDispatchRow[] = [];
    const flag = new Set<string>();
    // 拍 1：白名单死证+过宽限+无旁证 → 仅标记（两拍确认首拍零动作）
    const r1 = reconcileBoardCards({ boards: [{ gid: "g-recon", board }], sessions, dispatchLog: log, now, previouslyFlagged: new Set(), flaggedNow: flag });
    assert(!r1.actions.some((a) => a.entryId === "t-orphan"), "拍1 首拍只标记零动作（两拍确认——t-orphan 不在 actions）");
    assert(flag.has("t-orphan"), "拍1 候选入 flaggedNow（跨拍状态）");
    // 拍 2：同形态再判 → 出归位动作
    const r2 = reconcileBoardCards({ boards: [{ gid: "g-recon", board }], sessions, dispatchLog: log, now, previouslyFlagged: flag, flaggedNow: new Set() });
    assert(r2.actions.some((a) => a.entryId === "t-orphan" && a.reason === "orphan-session" && a.toBacklog), "拍2 第二拍出孤儿归位（旁证聚合全不中+两拍确认）");
    // R1-P1-1：owner 活跃（WORKING）滞留卡 → advisory 只提醒不归位
    const stale = r2.actions.find((a) => a.entryId === "t-stale");
    assert(!!stale && stale.advisory === true && stale.toBacklog === false, `owner 活跃滞留=advisory 只提醒（实 ${JSON.stringify(stale && { a: stale.advisory, t: stale.toBacklog })}）`);
    assert(!r2.actions.some((a) => a.entryId === "t-fresh"), "健康在途卡零动作");
    // R1-P1-2：ledger-terminal 支已删（终态收殓归 recon）
    assert(!r2.actions.some((a) => a.reason === "ledger-terminal"), "ledger-terminal 支退役（同面不同标+先手互堵根除——recon 管）");
  }

  console.log("②b 三形态豁免（A 审四证——重启收殓/#36 续跑窗/近窗心跳/台账 running）:");
  {
    const mk = (entryId: string, extra: Partial<BoardEntry>) => mkBoard([mkEntry(Object.assign({ id: entryId, owner_session: "s-x", status: "claimed", text: entryId, updated_at: now - 2 * 3600_000 } as Partial<BoardEntry>, extra))]);
    const flagAll = new Set(["e1", "e2", "e3", "e4"]);
    // 形态1 重启收殓 done_reason=ended（进程态未知）——两拍后仍豁免
    const r1 = reconcileBoardCards({ boards: [{ gid: "g", board: mk("e1", {}) }], sessions: [{ session_id: "s-x", status: "DONE", done_reason: "ended" }], dispatchLog: [], now, previouslyFlagged: flagAll, flaggedNow: new Set() });
    assert(!r1.actions.some((a) => a.entryId === "e1"), "重启收殓 ended（进程态未知）不算死证——两拍后仍零归位");
    // 形态2 #36 续跑窗（服务更新重启+pre_reboot WORKING）
    const r2 = reconcileBoardCards({ boards: [{ gid: "g", board: mk("e2", {}) }], sessions: [{ session_id: "s-x", status: "DONE", done_reason: "服务更新重启，会话已中断" }], dispatchLog: [], now, previouslyFlagged: flagAll, flaggedNow: new Set() });
    assert(!r2.actions.some((a) => a.entryId === "e2"), "服务更新重启（#36 待续跑）不算死证");
    // 形态3 近窗心跳（owner 最后活动 10min 前——不在 snapshot 的外部会话旁证）
    const r3 = reconcileBoardCards({ boards: [{ gid: "g", board: mk("e3", {}) }], sessions: [{ session_id: "s-x", status: "DONE", done_reason: "ended", last_active_at: now - 10 * 60_000 }], dispatchLog: [], now, previouslyFlagged: flagAll, flaggedNow: new Set() });
    assert(!r3.actions.some((a) => a.entryId === "e3"), "近窗心跳（最后活动 10min 内）豁免——长思考静默不判死");
    // 形态4 台账 running 行旁证
    const r4 = reconcileBoardCards({ boards: [{ gid: "g", board: mk("e4", { dispatch_id: "d-run" }) }], sessions: [{ session_id: "s-x", status: "DONE", done_reason: "ended" }], dispatchLog: [{ id: "d-run", status: "running" }], now, previouslyFlagged: flagAll, flaggedNow: new Set() });
    assert(!r4.actions.some((a) => a.entryId === "e4"), "台账 running 行在=真在跑豁免（dispatch 旁证）");
    // 对照：白名单死证+全旁证不中+两拍 → 归位（活证链保真）
    const r5 = reconcileBoardCards({ boards: [{ gid: "g", board: mk("e5", { owner_session: "s-d" }) }], sessions: [{ session_id: "s-d", status: "DONE", done_reason: "success" }], dispatchLog: [], now, previouslyFlagged: new Set(["e5"]), flaggedNow: new Set() });
    assert(r5.actions.some((a) => a.entryId === "e5" && a.toBacklog), "对照：白名单死证两拍后照归（守卫不误伤真孤儿）");
  }

  console.log("②c 宽限窗+一致性方向化（P0 缓冲/P2-1）:")
  {
    const young = mkBoard([mkEntry({ id: "y1", owner_session: "s-d", status: "claimed", text: "嫩卡", updated_at: now - 10 * 60_000 })]);
    const r = reconcileBoardCards({ boards: [{ gid: "g", board: young }], sessions: [{ session_id: "s-d", status: "DONE", done_reason: "success" }], dispatchLog: [], now, previouslyFlagged: new Set(["y1"]), flaggedNow: new Set() });
    assert(!r.actions.some((a) => a.entryId === "y1"), "卡龄 <45min 宽限窗豁免（#36 续跑窗跨拍保护）");
    const s2: ReconSession[] = Array.from({ length: 5 }, (_, i) => ({ session_id: "w" + i, status: "WORKING" }));
    const many = reconcileBoardCards({ boards: [{ gid: "g", board: mkBoard([mkEntry({ id: "c1", owner_session: "w0", status: "claimed", text: "x" })]) }], sessions: s2, dispatchLog: [], now });
    assert(many.mismatch === null, "负差（会话多卡少=PM/复核在岗常态）不告警（P2-1 方向化）");
  }

  console.log("③ 一致性告警（5 在岗 8 卡→mismatch 不静默）:");
  {
    const sessions: ReconSession[] = Array.from({ length: 5 }, (_, i) => ({ session_id: `s-w${i}`, status: "WORKING" }));
    const entries = Array.from({ length: 8 }, (_, i) => mkEntry({ id: "t-c" + i, owner_session: i < 5 ? `s-w${i}` : "s-dead" + i, status: "claimed" }));
    const r = reconcileBoardCards({ boards: [{ gid: "g", board: mkBoard(entries) }], sessions, dispatchLog: [], now });
    assert(r.workingSessions === 5 && r.claimedCards === 8, `计数如实（工作 5/卡 8——实 ${r.workingSessions}/${r.claimedCards}）`);
    assert(r.mismatch !== null && r.mismatch.includes("5") && r.mismatch.includes("8"), `mismatch 告警生成（正差 3>1——实 ${JSON.stringify(r.mismatch)}）`);
    // R1-P0：owner 不在册（s-dead 无 done_reason=未知态非白名单）→ 零归位（候选标记
    // 进 flaggedNow 待下拍+白名单核；「不在册即孤儿」的旧行为已根除——A 审 P0 四证）
    assert(r.actions.filter((a) => a.reason === "orphan-session").length === 0, "不在册非白名单零归位（两拍+白名单+旁证——旧「即判」行为退役）");
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
