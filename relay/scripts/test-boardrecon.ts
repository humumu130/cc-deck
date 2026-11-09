// [W-BOARDRECON]（t-7c780d9a）三断言组：
//   ①终态翻卡既有面核验（boardlife/boardfix 已在 dev——不重做，锚确认）
//   ②孤儿归位：死会话 claimed 卡→对账清单 orphan-session→（auto 档）backlog+note 留痕
//   ③一致性告警：5 在岗 8 卡→mismatch 生成（不静默）
// 外加：台账终态漏网/滞留超窗/活性对照/纯净板零动作。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { reconcileBoardCards, type ReconSession, type ReconDispatchRow, zombieInvariantScan, zombieTtlMs, ZOMBIE_NOTE_MARK, reconHeartbeatLine, type HarvestEvidence } from "../src/board-recon.js";
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
    // R2-P1 结构断言（判错力=挪回嵌套即红）：对账块（autoTierOf 行）必须在
    // stale 分支闭括（else resolve worker-stale）**之后**——平级；R1 误嵌
    // if(stale.length) 体内时它在该行之前=stale=0 整支不跑（R1 验收 P1 定罪形态）
    const ptLines = pt.split("\n");
    const lineOf = (pred: (l: string) => boolean): number => ptLines.findIndex(pred);
    const staleClose = lineOf((l) => l.includes("else this.resolve(`worker-stale`)"));
    const reconMode = lineOf((l) => l.includes('autoTierOf("boardrecon")'));
    assert(staleClose >= 0 && reconMode > staleClose, `对账块与 stale 分支平级（mode 行 ${reconMode} > stale 闭 ${staleClose}——嵌回体内即红）`);
    // R2-P2 结构断言：off 早退门在场（off 档零板加载/零审计/零通知）
    assert(pt.includes('if (mode !== "off")') && pt.includes("R2-P2：off 早退"), "boardrecon off 档早退门（off=零动作——autoTierOf 三档语义完整）");
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
  console.log("④ W-BOARDTRUTH5 刀二：形态免疫不变量对账（claimed/submitted 超 TTL×三证任一强翻）:");
  {
    // 三证各一卡 + 三证全无 + 未超 TTL + 非 claimed/submitted 态（六卡一板同拍）
    const harvest: HarvestEvidence = {
      doneLedger: new Map([["w-lead", { count: 1, hasReceipt: true }]]), // 证据①：台账 done+回执
      devLogText: "abc123 [任务] w-devlog 修板 (#70)\nabc124 [任务] w-devlog-r2 修板 (#71)", // 证据②（含超串干扰 w-devlog-r2）
      receiptSlugs: new Set(["w-receipt"]), // 证据③：回执尾行合规
    };
    const b = mkBoard([
      mkEntry({ id: "z1", status: "claimed", text: "[任务] W-LEAD 修板", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "z2", status: "submitted", text: "[任务] W-RECEIPT 修板", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "z3", status: "claimed", text: "[任务] W-DEVLOG 修板", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "z4", status: "claimed", text: "[任务] W-NONE 修板", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "z5", status: "claimed", text: "[任务] W-LEAD 修板（嫩）", updated_at: now - 1 * 3600_000 }),
      mkEntry({ id: "z6", status: "backlog", text: "[任务] W-LEAD 修板（陈积）", updated_at: now - 9 * 3600_000 }),
    ]);
    const r = zombieInvariantScan({ boards: [{ gid: "g", board: b }], harvest, now, ttlMs: 6 * 3600_000 });
    assert(r.actions.find((a) => a.entryId === "z1")?.evidence === "ledger-done", "①claimed+台账 done+回执 → 强翻证据 ledger-done（五现 4/10 僵尸=claimed 形态——R3 盲区本刀收辖）");
    assert(r.actions.find((a) => a.entryId === "z2")?.evidence === "receipt-line", "②submitted+回执尾行合规 → 强翻证据 receipt-line");
    assert(r.actions.find((a) => a.entryId === "z3")?.evidence === "dev-log", "③claimed+dev log 命中 → 强翻证据 dev-log");
    assert(r.actions.find((a) => a.entryId === "z4")?.evidence === null, "④三证全无 → evidence=null（僵尸告警面——不静默翻，防误杀真长任务）");
    assert(!r.actions.some((a) => a.entryId === "z5"), "⑤未超 TTL 零判定（6h 内交付/审查是常态节奏）");
    assert(!r.actions.some((a) => a.entryId === "z6"), "⑥backlog 态不辖（只有 claimed/submitted 两态在刀二辖区）");
    // 形态免疫正证：z1/z3 无 dispatch_id/no_pr 任何路径痕迹——判据零看路径字段
    const z1src = r.actions.find((a) => a.entryId === "z1");
    assert(!!z1src && !("dispatch_id" in z1src) && !("no_pr" in z1src), "⑦判据形态无关（action 无路径字段——只看卡态/龄/证据三不变量）");
  }

  console.log("④b 刀二护栏（词边界/时戳/标记幂等/回落碰撞/skip 让位）:");
  {
    const harvest: HarvestEvidence = { doneLedger: new Map(), devLogText: "xxx [任务] w-super 修板 (#80)", receiptSlugs: new Set() };
    // 词边界：卡键 w-super≠log 里 w-super（命中）；反例键 w-sup 不被 w-super 超串误命中
    const b = mkBoard([
      mkEntry({ id: "k1", status: "claimed", text: "[任务] W-SUP 修板", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "k2", status: "claimed", text: "[任务] W-SUPER 修板", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "k3", status: "claimed", text: "[任务] W-MARK 修板", updated_at: now - 7 * 3600_000, note: `${ZOMBIE_NOTE_MARK} 11/09] 滞留 7h 三证全无——已告警不静默翻` }),
      mkEntry({ id: "k4", status: "claimed", text: "[任务] W-NOAGE 修板", ts: 0, updated_at: 0 }),
      mkEntry({ id: "k5", status: "claimed", text: "人工板卡无slug锚", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "k6", status: "claimed", text: "人工板卡无slug锚", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "k7", status: "claimed", text: "[任务] W-SKIP 让位卡", updated_at: now - 7 * 3600_000 }),
    ]);
    const r = zombieInvariantScan({ boards: [{ gid: "g", board: b }], harvest, now, ttlMs: 6 * 3600_000, skipEntryIds: new Set(["k7"]) });
    assert(r.actions.find((a) => a.entryId === "k2")?.evidence === "dev-log", "词边界正例：w-super 命中 log");
    assert(r.actions.find((a) => a.entryId === "k1")?.evidence === null, "词边界反例：w-sup 不被 w-super 超串误命中（假证据面封死）");
    assert(!r.actions.some((a) => a.entryId === "k3"), "僵尸标记 note 在场 skip（告警幂等锚——第二轮不重复）");
    assert(!r.actions.some((a) => a.entryId === "k4"), "无时戳卡 skip（不臆断）");
    assert(!r.actions.some((a) => a.entryId === "k5" || a.entryId === "k6"), "回落键全板碰撞 skip（前 10 字键跨卡碰撞=证据归属不可分辨）");
    assert(!r.actions.some((a) => a.entryId === "k7"), "skipEntryIds 让位（本拍 R3 已判定卡——两器不重复动作）");
  }

  console.log("④c 刀二幂等（两轮零重复副作用）:");
  {
    const harvest: HarvestEvidence = { doneLedger: new Map([["w-idem", { count: 1, hasReceipt: true }]]), devLogText: "", receiptSlugs: new Set() };
    const round1 = mkBoard([
      mkEntry({ id: "i1", status: "claimed", text: "[任务] W-IDEM 强翻卡", updated_at: now - 7 * 3600_000 }),
      mkEntry({ id: "i2", status: "claimed", text: "[任务] W-IDEM2 告警卡", updated_at: now - 7 * 3600_000 }),
    ]);
    const r1 = zombieInvariantScan({ boards: [{ gid: "g", board: round1 }], harvest, now, ttlMs: 6 * 3600_000 });
    assert(r1.actions.length === 2 && r1.actions.find((a) => a.entryId === "i1")?.evidence === "ledger-done" && r1.actions.find((a) => a.entryId === "i2")?.evidence === null, "第一轮：1 强翻+1 告警判定");
    // 模拟应用：i1 翻 done（离辖）+i2 note 标记（幂等锚）——第二轮板面
    const round2 = mkBoard([
      { ...round1.entries[0], status: "done" as never, updated_at: now },
      { ...round1.entries[1], note: `${ZOMBIE_NOTE_MARK} 11/09] 滞留 7h 三证全无——已告警` },
    ]);
    const r2 = zombieInvariantScan({ boards: [{ gid: "g", board: round2 }], harvest, now, ttlMs: 6 * 3600_000 });
    assert(r2.actions.length === 0, "第二轮零判定（翻后离辖+标记锚滤除——两轮零重复副作用，幂等成立）");
  }

  console.log("⑤ W-BOARDTRUTH5 刀三：生效探针心跳行 + 常驻挂点源锚:");
  {
    const line = reconHeartbeatLine("auto", 3, 2, 1, 1, 0);
    assert(line.startsWith("alive mode=auto") && line.includes("判定 3") && line.includes("僵尸面 1") && line.includes("强翻 1/告警 0"), `心跳行格式与计数（实 ${line}）`);
    assert((() => { const l = reconHeartbeatLine("off", 0, 0, 0, 0, 0); return l.includes("mode=off") && l.includes("判定 0"); })(), "空转轮/off 档心跳也发（timer 活体证明——「建了从未跑」当日暴露）");
    const pt = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf-8");
    assert(pt.includes("CCR_BOARD_RECON_DELAY_MS") && pt.includes("CCR_BOARD_RECON_MS") && pt.includes("this.runBoardRecon();"), "刀一常驻挂点在（错峰首轮 delay+每小时稳态双 timer+runFull 轮头三口同体）");
    assert(pt.includes('"board-recon-loop"'), "刀三心跳 emit 在（audit 可检索键 board-recon-loop）");
    assert(pt.includes("zombieInvariantScan") && pt.includes('"boardtruth5-zombie-done"'), "刀二应用面在（强翻 journal action 可检索）");
    // 结构锚：runBoardRecon 方法体必须在 runFull 的 stale 闭行之后（①既有结构断言同源——
    // 方法提取后仍满足「对账块与 stale 分支平级或其后」）
    const ptLines = pt.split("\n");
    const staleClose = ptLines.findIndex((l) => l.includes("else this.resolve(`worker-stale`)"));
    const reconMethod = ptLines.findIndex((l) => l.includes("private runBoardRecon(): void"));
    assert(staleClose >= 0 && reconMethod > staleClose, `runBoardRecon 方法体位于 stale 闭行后（${reconMethod} > ${staleClose}——①组结构断言兼容）`);
  }

  console.log("⑤b 刀二 TTL 配置读取（CCR_BOARD_ZOMBIE_TTL_H）:");
  {
    process.env.CCR_BOARD_ZOMBIE_TTL_H = "1";
    assert(zombieTtlMs() === 3600_000, "env=1 → 1h");
    process.env.CCR_BOARD_ZOMBIE_TTL_H = "0";
    assert(zombieTtlMs() === Number.POSITIVE_INFINITY, "显式 0=关（逃生阀——判定族整体关闭）");
    const harvest: HarvestEvidence = { doneLedger: new Map([["w-shut", { count: 1, hasReceipt: true }]]), devLogText: "", receiptSlugs: new Set() };
    const shut = zombieInvariantScan({ boards: [{ gid: "g", board: mkBoard([mkEntry({ id: "s1", status: "claimed", text: "[任务] W-SHUT 关阀卡", updated_at: now - 99 * 3600_000 })]) }], harvest, now });
    assert(shut.actions.length === 0, "关阀态零判定（TTL=∞——逃生阀实证非纸面）");
    delete process.env.CCR_BOARD_ZOMBIE_TTL_H;
    assert(zombieTtlMs() === 6 * 3600_000, "缺省 6h（任务书建议值）");
    const ttlParam = zombieInvariantScan({ boards: [{ gid: "g", board: mkBoard([mkEntry({ id: "s2", status: "claimed", text: "[任务] W-SHUT 参数卡", updated_at: now - 7 * 3600_000 })]) }], harvest, now, ttlMs: 6 * 3600_000 });
    assert(ttlParam.actions.length === 1 && ttlParam.actions[0].evidence === "ledger-done", "ttlMs 参数直调同效（缺省 env 路径之外的第二入口）");
  }
  console.log(`\n========== boardrecon 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
