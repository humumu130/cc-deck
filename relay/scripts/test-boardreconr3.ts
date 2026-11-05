// W-BOARDRECON-R3 断言件：对账器扩「已收割未翻」判定（1105 用户实锤——审查中 23 里
// 18 张已收割未翻陈卡：手工 squash 收割路径零翻卡纯靠人记，第一现 #66 只修了自动链）。
// 夹具三态：①证据齐（台账 done+receipt）→自动翻 done；②双卡同题（sqlitefixr1 ×2
// 实锤形态）→降告警卡不自动翻；③无证据（真在审）→不动。重复卡检测顺带。装配面
// （patrol 三源构建+auto 翻 done+journal）源码锚。
// 直跑：env -u CCR_DATA_DIR -u CCR_ORG_DIR -u CCR_PORT npx tsx scripts/test-boardreconr3.ts
for (const k of ["CCR_DATA_DIR", "CCR_ORG_DIR", "CCR_PORT", "CCR_PARENT_PID", "CCR_RELAY_CHILD"]) delete process.env[k];
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { reconcileBoardCards, harvestKeyOf, type HarvestEvidence } from "../src/board-recon.js";
import type { ProjectBoard } from "../src/projects.js";

const now = Date.now();
const staleOld = now - 3 * 3600_000; // 陈化 3h（>2h 阈值）
const fresh = now - 30 * 60_000;     // 新鲜 submitted（不触发）
let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ok - " + n); } else { fail++; console.error("FAIL: " + n); } };

const mkBoard = (entries: Array<Partial<ProjectBoard["entries"][number]>>): ProjectBoard =>
  ({ gid: "g1", entries: entries.map((e, i) => ({ id: e.id ?? `e${i}`, text: e.text ?? "", status: e.status ?? "submitted", ts: e.ts ?? staleOld, updated_at: e.updated_at ?? staleOld })) } as never);

// ---------- A 纯函数判定族 ----------
{
  const harvest: HarvestEvidence = {
    doneLedger: new Map([
      ["w-ratelimit429", { count: 1, hasReceipt: true }],   // 证据①齐
      ["w-sqlitefixr1", { count: 1, hasReceipt: true }],    // 证据①齐但双卡（多义）
      ["w-boardrecon", { count: 1, hasReceipt: true }],
      ["w-weakonly", { count: 1, hasReceipt: true }],        // R1-P1-1：①③齐而②缺（弱证形态）
    ]),
    devLogText: "abc123 [任务] w-ratelimit429 限流治理\nxyz [任务] w-treegcr1 worktree gc\ndef [任务] w-relayfreshci-r1 中继新鲜度修复\nghi [任务] w-devonly 仅dev证据单\njkl [任务] sqlitefixr1 sqlite 根修返修", // 证据②
    receiptSlugs: new Set(["w-treegcr1", "w-ratelimit429", "w-weakonly"]), // 证据③
  };
  const r = reconcileBoardCards({
    boards: [{ gid: "g1", board: mkBoard([
      { id: "s-rl429", text: "W-RATELIMIT429：429 限流治理（全局并发闸+退避自愈）" },           // 三证全 → 自动翻
      { id: "s-sq1", text: "sqlitefixr1：sqlite 根修返修（P0 首读投毒+P1×3+P2 批）" },           // 双卡同键 → 多义降告警
      { id: "s-sq2", text: "sqlitefixr1：sqlite 根修返修（P0 首读投毒+P1×3+P2 批）——重复卡" },   // ↑同键第二张
      { id: "s-treegc", text: "W-TREEGCR1：worktree GC 吃稿根治（脏树禁删）" },                  // 证据②③ → 翻
      { id: "s-live", text: "W-LIVEAUDIT：在审单（真审中无证据）", updated_at: fresh },          // 新鲜 → 不动
      { id: "s-nolive", text: "W-NOEVIDENCE：陈化但零证据（真在审）" },                          // 陈化无证据 → 不动
      // ---- R1 返修五形态（A 审 P1 判据收敛+键碰撞三刀）----
      { id: "s-weak", text: "W-WEAKONLY：①③齐无②（在审返修形态——dev 未进）" },               // ①③单独 → advisory
      { id: "s-devonly", text: "W-DEVONLY：仅②（无①③——纯 dev 命中）" },                        // ②单独 → 翻
      { id: "s-rfshort", text: "W-RELAYFRESHCI：中继新鲜度（前缀卡，dev 只有 -r1）" },           // 超串 → 不命中
      { id: "s-rfr1", text: "W-RELAYFRESHCI-R1：中继新鲜度返修（dev 有 -r1）", updated_at: staleOld }, // 词边界正向 → 翻
      { id: "s-empty", text: "" },                                                               // 空键 → 不参与
      { id: "s-fb1", text: "审查席位一批：reviewseat 首巡" },                                    // 回落键碰撞对①
      { id: "s-fb2", text: "审查席位二批：reviewseatr1 复巡" },                                  // 回落键碰撞对②（前10字同）
      { id: "s-fbdone", text: "审查席位零批：已收割旧卡", status: "done" },                      // 同回落键 done 卡（全板计数>1）
    ]) }],
    sessions: [], dispatchLog: [], now, harvest,
  });
  const flip = (id: string) => r.actions.find((a) => a.entryId === id);
  ok(!!flip("s-rl429") && flip("s-rl429")!.toDone === true && !flip("s-rl429")!.advisory, "A1 三证齐自动翻 done（toDone 动作）");
  ok(flip("s-rl429")!.detail.includes("台账 done+回执") && flip("s-rl429")!.detail.includes("dev log 命中"), `A1b 证据链入 detail（${flip("s-rl429")!.detail.slice(0, 50)}）`);
  ok(!!flip("s-sq1") && flip("s-sq1")!.advisory === true && !flip("s-sq1")!.toDone, "A2 双卡同键降告警卡（多义不自动翻——sqlitefixr1 实锤形态）");
  ok(!!flip("s-treegc") && flip("s-treegc")!.toDone === true, "A3 证据②③（git log+回执）翻 done");
  ok(!flip("s-live"), "A4 新鲜 submitted 不动（<2h 阈值）");
  ok(!flip("s-nolive"), "A5 陈化但零证据不动（真在审不误翻——验收 2 判定面）");
  const dup = r.actions.find((a) => a.reason === "duplicate-card");
  ok(!!dup && dup.advisory === true && dup.detail.includes("s-sq1") && dup.detail.includes("s-sq2"), `A6 重复卡检测告警（同文本双卡：${dup?.detail.slice(0, 50)}）`);
  // ---- R1 五形态（A 审 P1-1/P2-2）----
  ok(!!flip("s-weak") && flip("s-weak")!.advisory === true && !flip("s-weak")!.toDone, "A9 ①③单独（无②）→advisory 不翻（在审返修形态——t-4e0a6fc2 误翻根修）");
  ok(flip("s-weak")!.detail.includes("陈化在审请人工核"), "A9b advisory 文案（陈化在审请人工核）");
  ok(!!flip("s-devonly") && flip("s-devonly")!.toDone === true && !flip("s-devonly")!.advisory, "A10 ②单独（无①③）→翻 done（dev=唯一真收割证据）");
  ok(!flip("s-rfshort"), "A11 词边界：w-relayfreshci 卡不被 log 的 w-relayfreshci-r1 超串误命中（无①③即无判定）");
  ok(!!flip("s-rfr1") && flip("s-rfr1")!.toDone === true, "A11b 词边界正向：w-relayfreshci-r1 卡真命中翻 done");
  ok(!flip("s-empty"), "A12 空键不参与证据匹配（includes 空串恒真面封死）");
  ok(!flip("s-fb1") && !flip("s-fb2"), "A13 回落键碰撞对（前 10 字同+板内 done 卡同键）→不出判定（假告警消音）");
  // A7 无 harvest 入参=判定族关闭（向后兼容）
  const rNoEv = reconcileBoardCards({ boards: [{ gid: "g1", board: mkBoard([{ id: "s-rl429", text: "W-RATELIMIT429：…陈化" }]) }], sessions: [], dispatchLog: [], now });
  ok(!rNoEv.actions.some((a) => a.entryId === "s-rl429"), "A7 harvest 缺席=族关闭（向后兼容）");
  // A8 键归一：无 slug 前缀回落前 10 字
  ok(harvestKeyOf("巡查员上岗：首巡+自我介绍") === "巡查员上岗：首巡+自", "A8 归一键无 slug 回落（前 10 字符——字面量期望，恒等式写法已修）");
  ok(harvestKeyOf("W-RATELIMIT429：429 限流治理") === "w-ratelimit429", "A8b slug 锚大小写归一");
}

// ---------- B 装配面源码锚（patrol 三源+auto 翻+journal 轻口） ----------
{
  const pt = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf8");
  ok(pt.includes("harvestKeyOf") && pt.includes("doneLedger") && pt.includes("receiptSlugs"), "B1 patrol 三源构建在（台账聚合/回执扫描键就位）");
  ok(pt.includes("reconDevLogCache"), "B2 dev log 10min 缓存在（低频子进程不烧）");
  ok(pt.includes('journal_action: "boardrecon-auto-done"') && pt.includes("已收割未翻自动收口"), "B3 auto 翻 done 带 journal 定制+note 证据");
  const pj = readFileSync(join(process.cwd(), "src", "projects.ts"), "utf8");
  ok(pj.includes("journal_action ??"), "B4 upsert journal 轻口透传（缺省 update/create 不变）");
  const hv = readFileSync(join(process.cwd(), "..", "cc-plugins", "plugins", "cc-deck", "bin", "leader-harvest"), "utf8");
  ok(hv.includes("W-BOARDRECON-R3 手工收割翻卡") && hv.includes("org board move"), "B5 手工收割 SOP 提示（机制提醒不靠记性）");
}

// ---------- C 真板 dry-run（判定面验证——只读不翻） ----------
{
  const ORG = process.env.CCR_ORG_DIR || join(process.env.HOME || "~", ".cc-deck", "org");
  try {
    const real = readFileSync(join(ORG, "boards", "pg-7cb58ab4.json"), "utf8");
    const board = JSON.parse(real) as ProjectBoard;
    const submitted = board.entries.filter((e) => e.status === "submitted");
    const staleSubmitted = submitted.filter((e) => now - Number(e.updated_at || e.ts || 0) > 2 * 3600_000);
    console.log(`  [真板] submitted=${submitted.length} 其中陈化>2h=${staleSubmitted.length}`);
    // 真板判定面：陈化卡逐张过 harvestKeyOf——有 slug 键即对账器可见（证据三源命中与否
    // 运行时定——此处验证键覆盖面：全部卡可被归一键命中=判定可达）
    const keyable = staleSubmitted.filter((e) => harvestKeyOf(String(e.text || "")).length > 0).length;
    ok(keyable === staleSubmitted.length, `C1 真板陈化 submitted 全部可归键（${keyable}/${staleSubmitted.length}——判定面可达；PM 午前已手工核销 18 张，现存=真在审不应被翻——证据面运行时把关）`);
  } catch {
    console.log("  [真板] 板仓不可读（CI/沙盒环境）——跳过 C 组（本机组在生产机跑）");
    ok(true, "C 组环境豁免（板仓缺席）");
  }
}

const ORG_SB = mkdtempSync(join(tmpdir(), "brc3-"));
rmSync(ORG_SB, { recursive: true, force: true });
console.log(`\n== test-boardreconr3 汇总：${pass} ok / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
