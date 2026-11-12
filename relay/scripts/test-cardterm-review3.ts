// W-CARDTERM-R2 回归夹具（1112 三审三反方死角实证件 → 修法批翻转锚）：原 characterization
// 13 断言锚定死角现状（backlog 死卡形态全漏），W-CARDTERM-R2（P1×3 返修）落地后翻转为本
// 回归件——死角锚翻绿锁定修复语义，正对照（F4/F5）钉不回归。已接 CI 三落点。
//
// 修法面（对 w-cardterm-review3.md 遗留节逐条）：
//   F1 中断补记形态（7 张窗外+2 张守护堵）：守护语义修（ledInterrupt 判据——closeHung 自身
//      搬卡不再被当人工重开）→ recon 收敛 done + fixedToday 计数
//   F2 failed 退单形态（4 张 no-op）：决策面语义保持（不自动搬）+ 红条 terminal-stuck 示众
//   F3 500 窗外（7 张 led miss）：readDispatchLog 窗 500→20k（converge/patrol 先例对齐）
//   F4 正对照：窗内收敛+计数（不回归）
//   F5 红条正对照：failed-in-review（不回归）
//   F6 无 dispatch_id 任务形卡（五网盲）：僵尸网形态门扩展（backlog 无 id×w-slug×72h）+
//      僵尸判定喂红条（boardHealthFeedZombies→emitBoard health 合成）
//   F7 僵尸网视角：证据①滤中断行（P2-4 切 auto 防误翻）——中断滞卡不再假阳「证在」
//
// 运行：cd relay && npx tsx scripts/test-cardterm-review3.ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch } from "../src/org.js";
import { loadBoard, upsertBoardEntry } from "../src/projects.js";
import { zombieInvariantScan, harvestKeyOf, type HarvestEvidence } from "../src/board-recon.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const H = 3_600_000;

const dirs: string[] = [];
function mkEnv() {
  const ORG = mkdtempSync(join(tmpdir(), "ct3-org-"));
  const DATA = mkdtempSync(join(tmpdir(), "ct3-data-"));
  const ART = mkdtempSync(join(tmpdir(), "ct3-art-"));
  dirs.push(ORG, DATA, ART);
  const prev = { CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_DATA_DIR: process.env.CCR_DATA_DIR, CCR_ARTIFACTS_DIR: process.env.CCR_ARTIFACTS_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE, CCR_CONFIG_FILE: process.env.CCR_CONFIG_FILE };
  process.env.CCR_ORG_DIR = ORG; process.env.CCR_DATA_DIR = DATA; process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_STORAGE_READ_MODE = "json";
  const cfgDir = mkdtempSync(join(tmpdir(), "ct3-cfg-")); dirs.push(cfgDir);
  process.env.CCR_CONFIG_FILE = join(cfgDir, "config.json");
  const cfg: RelayConfig = {
    port: 8950 + Math.floor(Math.random() * 40), token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(() => ({
    id: randomUUID(), startedAt: Date.now(), ended: true,
    sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
    stop: async () => {}, setPermissionMode: async () => {},
  }));
  const mkGroup = (name: string) => {
    const pc = mgr.orgAction("project-create", { name, anchor: `/tmp/ct3-${name}`, tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string }; group?: { id: string } } };
    const gid = pc.data?.group?.id ?? `pg-${name}`;
    if (pc.data?.needsConfirm) mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm?.id ?? "", approve: true, by: "u" });
    return gid as string;
  };
  return { ORG, DATA, ART, mgr, mkGroup, cleanup: () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

/** 建卡+挂 dispatch_id（复刻 test-cardterm attach 手法） */
function mkCard(f: ReturnType<typeof mkEnv>, gid: string, text: string, dispatchId: string | null, status: "claimed" | "backlog") {
  f.mgr.orgAction("board", { op: "upsert", gid, text, status });
  if (!dispatchId) return;
  const bp = join(f.ORG, "boards", `${gid}.json`);
  const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ id: string; text: string; dispatch_id?: string }> };
  const ent = b.entries.find((x) => x.text.startsWith(text.slice(0, 8)));
  if (!ent) throw new Error(`mkCard 卡未找到: ${text}`);
  ent.dispatch_id = dispatchId;
  writeFileSync(bp, JSON.stringify(b), "utf-8");
}

/** 原始改板：回填卡 ts/updated_at/transitions（复刻生产老卡时序）。backlogTransNewer=true 时
 * 末行 backlog 迁移单独后移（F1 closeHung 形态：台账行 T1 < 搬卡 T2）。 */
function backdateCard(f: ReturnType<typeof mkEnv>, gid: string, dispatchId: string, tsMs: number, backlogTransNewerMs?: number) {
  const bp = join(f.ORG, "boards", `${gid}.json`);
  const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ dispatch_id?: string; ts?: number; updated_at?: number; transitions?: Array<{ status: string; ts: number }> }> };
  const ent = b.entries.find((x) => x.dispatch_id === dispatchId);
  if (!ent) throw new Error("backdateCard 卡未找到");
  ent.ts = tsMs; ent.updated_at = tsMs;
  if (ent.transitions) for (const t of ent.transitions) t.ts = tsMs;
  if (backlogTransNewerMs !== undefined && ent.transitions?.length) ent.transitions[ent.transitions.length - 1].ts = backlogTransNewerMs;
  writeFileSync(bp, JSON.stringify(b), "utf-8");
}

/** 原始改板（按文本找卡）：F6 无 id 卡回填时序 */
function backdateCardByText(f: ReturnType<typeof mkEnv>, gid: string, prefix: string, tsMs: number) {
  const bp = join(f.ORG, "boards", `${gid}.json`);
  const b = JSON.parse(readFileSync(bp, "utf-8")) as { entries: Array<{ text?: string; ts?: number; updated_at?: number; transitions?: Array<{ status: string; ts: number }> }> };
  const ent = b.entries.find((x) => (x.text || "").startsWith(prefix));
  if (!ent) throw new Error("backdateCardByText 卡未找到");
  ent.ts = tsMs; ent.updated_at = tsMs;
  if (ent.transitions) for (const t of ent.transitions) t.ts = tsMs;
  writeFileSync(bp, JSON.stringify(b), "utf-8");
}

type Health = { day: string; fixedToday: number; stuckAt: number; stuck: Array<{ text: string; kind: string; hours: number; note: string }> };
const healthOf = (f: ReturnType<typeof mkEnv>, gid: string) => (f.mgr as unknown as { boardHealth: Map<string, Health> }).boardHealth.get(gid);

/** 复刻 patrol 证据①构建语义（byId 归并：done 累积/首行 title/任意非空 receipt）——
 * W-CARDTERM-R2 P2-4 后口径：中断补记行（receipt「relay 重启」前缀）不立 done/不算
 * 回执证据（与 patrol.ts 修法同款，随 patrol 演进同步维护本复刻）。 */
function buildDoneLedgerPatrolStyle(orgDir: string): HarvestEvidence {
  const byId = new Map<string, { title?: string; done: boolean; hasReceipt: boolean }>();
  for (const line of readFileSync(join(orgDir, "dispatch-log.ndjson"), "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as { id?: string; title?: string; status?: string; receipt?: string };
      if (typeof r.id !== "string" || !r.id) continue;
      const interrupt = String(r.receipt || "").startsWith("relay 重启"); // P2-4：中断行不算收割证据
      const cur = byId.get(r.id);
      byId.set(r.id, { title: r.title || cur?.title, done: (r.status === "done" && !interrupt) || (cur?.done ?? false), hasReceipt: (!!r.receipt && !interrupt) || (cur?.hasReceipt ?? false) });
    } catch { /* 损坏行跳过 */ }
  }
  const doneLedger = new Map<string, { count: number; hasReceipt: boolean }>();
  for (const { title, done, hasReceipt } of byId.values()) {
    if (!done || !title) continue;
    const key = harvestKeyOf(title);
    if (!key) continue;
    const cur = doneLedger.get(key);
    doneLedger.set(key, { count: (cur?.count ?? 0) + 1, hasReceipt: (cur?.hasReceipt ?? false) || hasReceipt });
  }
  return { doneLedger, devLogText: "", receiptSlugs: new Set<string>() };
}

async function main() {
  try {
    // ===== F1 中断补记形态（1112 实锤 7 窗外+2 守护堵 → 修后收敛） =====
    console.log("F1 中断补记（台账 done 行 receipt=relay 重启 + 卡 backlog T2>T1 → 守护修后收敛）:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f1");
      mkCard(f, gid, "W-CT3F1：中断补记滞卡", "d-f1", "claimed");
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f1", tier: "正经立项", target: "manual", status: "running", session_id: "s-f1", title: "W-CT3F1 中断前 running 行" });
      appendDispatch({ ts: Date.now() - 72 * H + 5, id: "d-f1", tier: "正经立项", target: "manual", status: "done", session_id: "s-f1", title: "", receipt: "relay 重启，回合中断" });
      backdateCard(f, gid, "d-f1", Date.now() - 72 * H); // 卡时序回到中断前
      f.mgr.orgAction("board", { op: "move", gid, entry_id: loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f1")!.id, status: "backlog" }); // closeHung 同款：台账行后搬 backlog（T2>T1）
      backdateCard(f, gid, "d-f1", Date.now() - 71 * H, Date.now() - 71 * H); // 滞留 71h；末行 backlog 迁移仍 > 台账行 ts
      // F7a 僵尸网视角（收敛前）：证据①滤中断行（P2-4）——不再把中断补记当收割证据假阳
      const zs0 = zombieInvariantScan({ boards: [{ gid, board: loadBoard(gid) }], harvest: buildDoneLedgerPatrolStyle(f.ORG), now: Date.now() });
      const z0 = zs0.actions.find((a) => a.text.startsWith("W-CT3F1"));
      ok(!!z0 && z0.evidence === null, `F7a 证据①滤中断行：僵尸网判中断滞卡「证无」（evidence=${z0?.evidence ?? "无动作"}——P2-4 后不再 ledger-done 假阳，切 auto 不误翻）`);
      ok(!buildDoneLedgerPatrolStyle(f.ORG).doneLedger.has("w-ct3f1"), `F7a2 中断行不入证据①键账（doneLedger 无 w-ct3f1——builder 与 patrol 同款过滤）`);
      f.mgr.runLedgerRecon("f1-test");
      await sleep(100);
      const c = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f1");
      ok(c?.status === "done", `F1a recon 收敛 done（现状=${c?.status}——守护语义修：closeHung 自身搬卡不再被当人工重开，中断滞卡超 1h 窗照收敛【翻转锚】）`);
      const h = healthOf(f, gid);
      ok(c?.status === "done" && (h?.stuck.length ?? 1) === 0 && (h?.fixedToday ?? 0) >= 1, `F1b 收敛后已修计数（stuck=${h?.stuck.length ?? "?"}/fixedToday=${h?.fixedToday ?? 0}——当日已修示众，死卡不滞红条）`);
      f.cleanup();
    }

    // ===== F2 failed 退单形态（决策面语义保持 + 红条 terminal-stuck 示众） =====
    console.log("F2 failed 退单（卡 backlog+台账 failed——不自动搬，红条示众请裁决）:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f2");
      mkCard(f, gid, "W-CT3F2：failed 退单滞卡", "d-f2", "claimed");
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f2", tier: "正经立项", target: "manual", status: "failed", session_id: "s-f2", title: "W-CT3F2", receipt: "排队重放异常: worktree 被他单活锁占用" });
      backdateCard(f, gid, "d-f2", Date.now() - 72 * H);
      f.mgr.orgAction("board", { op: "move", gid, entry_id: loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f2")!.id, status: "backlog" });
      backdateCard(f, gid, "d-f2", Date.now() - 71 * H, Date.now() - 71 * H);
      f.mgr.runLedgerRecon("f2-test");
      await sleep(100);
      const c = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f2");
      ok(c?.status === "backlog", `F2a failed×backlog 不自动搬（现状=${c?.status}——重派/换人/放弃=人工决策面，语义保持回归钉）`);
      const h = healthOf(f, gid);
      ok(h?.stuck.length === 1 && h.stuck[0].kind === "terminal-stuck", `F2b 红条 terminal-stuck 示众（${h?.stuck.map((s) => s.kind).join(",") ?? "无"}——failed×backlog 超 24h 死卡显性化请裁决【翻转锚】）`);
      const zs = zombieInvariantScan({ boards: [{ gid, board: loadBoard(gid) }], harvest: buildDoneLedgerPatrolStyle(f.ORG), now: Date.now() });
      const z2 = zs.actions.find((a) => a.text.startsWith("W-CT3F2"));
      ok(!!z2 && z2.evidence === null, `F7b 僵尸网判「证无」（evidence=${z2?.evidence ?? "无动作"}——failed 行本就不入证据①；observe 档 P2-5 后有告警不再静默）`);
      f.cleanup();
    }

    // ===== F3/F4 20k 窗对照（同形态，差异仅=台账行在 500 默认窗外/窗内） =====
    console.log("F3/F4 readDispatchLog 窗 500→20k（窗外老单不再双盲）:");
    {
      const f = mkEnv();
      const gidF3 = f.mkGroup("f3");
      mkCard(f, gidF3, "W-CT3F3：窗外老单滞卡", "d-f3", "backlog");
      backdateCard(f, gidF3, "d-f3", Date.now() - 80 * H);
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f3", tier: "正经立项", target: "manual", status: "done", session_id: "s-f3", title: "W-CT3F3 干净收割", receipt: "结果：真收割｜改动文件：a.ts" });
      for (let i = 0; i < 505; i++) appendDispatch({ ts: Date.now(), id: `d-noise-${i}`, tier: "正经立项", target: "manual", status: "running", session_id: "s-n", title: `噪音单 ${i}` }); // 505 张更新单（默认 500 窗截掉，20k 窗可见）
      f.mgr.runLedgerRecon("f3-test");
      await sleep(100);
      const c3 = loadBoard(gidF3).entries.find((x) => x.dispatch_id === "d-f3");
      const h3 = healthOf(f, gidF3);
      ok(c3?.status === "done", `F3a 窗外老单收敛 done（现状=${c3?.status}——20k 窗后 led 命中，P1-2 一行修【翻转锚】）`);
      ok((h3?.fixedToday ?? 0) >= 1 && (h3?.stuck.length ?? 1) === 0, `F3b 窗外老单已修计数（fixedToday=${h3?.fixedToday ?? 0}/stuck=${h3?.stuck.length ?? "?"}——红条与刀三同窗受益）`);

      const gidF4 = f.mkGroup("f4");
      mkCard(f, gidF4, "W-CT3F4：窗内老单对照", "d-f4", "backlog");
      backdateCard(f, gidF4, "d-f4", Date.now() - 80 * H);
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f4", tier: "正经立项", target: "manual", status: "done", session_id: "s-f4", title: "W-CT3F4 干净收割", receipt: "结果：真收割｜改动文件：a.ts" });
      f.mgr.runLedgerRecon("f4-test");
      await sleep(100);
      const c4 = loadBoard(gidF4).entries.find((x) => x.dispatch_id === "d-f4");
      ok(c4?.status === "done", `F4a 正对照不回归（现状=${c4?.status}——窗内收敛语义原样）`);
      ok((healthOf(f, gidF4)?.fixedToday ?? 0) >= 1, `F4b boardHealthBump 当日已修计数（fixedToday=${healthOf(f, gidF4)?.fixedToday ?? 0}——已修示众面接线有效）`);
      f.cleanup();
    }

    // ===== F5 红条正对照（failed-in-review 有效面不回归） =====
    console.log("F5 submitted×台账 failed → stuck=failed-in-review:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f5");
      mkCard(f, gid, "W-CT3F5：failed 复核矛盾卡", "d-f5", "claimed");
      const ent = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f5")!;
      upsertBoardEntry(gid, { id: ent.id, text: ent.text, status: "done", review_required: true }); // R2 内核→submitted
      appendDispatch({ ts: Date.now() - 2 * H, id: "d-f5", tier: "正经立项", target: "manual", status: "failed", session_id: "s-f5", title: "W-CT3F5", receipt: "审查打回：证据不足" });
      f.mgr.runLedgerRecon("f5-test");
      await sleep(100);
      const h = healthOf(f, gid);
      ok(h?.stuck.length === 1 && h.stuck[0].kind === "failed-in-review", `F5a 红条 stuck=failed-in-review（${h?.stuck.map((s) => s.kind).join(",") ?? "无"}——保护态显性化接线不回归）`);
      f.cleanup();
    }

    // ===== F6 无 dispatch_id 任务形卡（僵尸形态门扩展 + 喂红条） =====
    console.log("F6 无关联任务形 backlog 卡（僵尸网接住+喂红条）:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f6");
      mkCard(f, gid, "W-CT3F6：无关联滞卡（工作其实已完结）", null, "backlog");
      backdateCardByText(f, gid, "W-CT3F6", Date.now() - 80 * H); // 滞留 80h（> 无关联 backlog 72h 长窗）
      f.mgr.runLedgerRecon("f6-test");
      await sleep(100);
      const c = loadBoard(gid).entries.find((x) => x.text.startsWith("W-CT3F6"));
      const zs = zombieInvariantScan({ boards: [{ gid, board: loadBoard(gid) }], harvest: { doneLedger: new Map(), devLogText: "w-ct3f6", receiptSlugs: new Set<string>() }, now: Date.now() });
      const z6 = zs.actions.find((a) => a.text.startsWith("W-CT3F6"));
      ok(c?.status === "backlog" && !!z6 && z6.evidence === "dev-log", `F6a 僵尸网辖无关联任务形卡（evidence=${z6?.evidence ?? "不辖"}——backlog 无 id×w-slug×超 72h 形态门扩展【翻转锚】）`);
      // 喂红条（patrol 拍尾同款映射）→ emitBoard health 合成（lastBoardBroadcast 验帧）
      f.mgr.boardHealthFeedZombies(gid, [{ text: "W-CT3F6：无关联滞卡（工作其实已完结）", kind: z6?.evidence ? "zombie-evidence" : "zombie-no-evidence", hours: 80, note: "滞留 80h，交付证据在（dev-log）——强翻走 auto 档；observe 档请人工收口或切 auto" }]);
      await sleep(50);
      const frame = (f.mgr as unknown as { lastBoardBroadcast: Map<string, { health?: { stuck: Array<{ text: string; kind: string }> } }> }).lastBoardBroadcast.get(gid);
      ok(frame?.health?.stuck?.some((s) => s.kind === "zombie-evidence" && s.text.startsWith("W-CT3F6")) === true, `F6b 僵尸判定喂红条（帧 health.stuck 含 zombie-evidence 条目——boardZombies 账+emitBoard 合成链通【翻转锚】）`);
      f.cleanup();
    }

    console.log(`\n========== cardterm-review3 回归夹具（R2 修法后翻转）：${pass} 通过 / ${fail} 失败 ==========`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
}
void main();
