// W-CARDTERM-REVIEW3 反方夹具（1112 三审三·板账治本死角实证——审查证据件，手动运行，
// 不接 CI matrix：断言锚定的是**当前行为的死角 characterization**，修法批落地后需翻转）。
//
// 实证七问（对 PR#121 三刀+红条的反方攻击，全部复刻 PM 1112 手工清账的真实生产形态）：
//   F1 中断补记形态（7/12 张实锤）：卡 claimed→backlog（T2>台账 done 行 T1）+台账行
//      receipt「relay 重启，回合中断」→ recon 收敛吗？红条 stuck 亮吗？
//   F2 failed 退单形态（4/12 张实锤）：卡 backlog+台账 failed → recon？红条？
//   F3 500 窗外：backlog+台账 done（干净 receipt）但台账行被 501 张更新单挤出
//      readDispatchLog() 默认窗 → recon？红条？
//   F4 正对照：同 F3 形态无噪音行（窗内）→ 收敛（证明网本身工作，F3 差异=窗）
//   F5 红条正对照：submitted+台账 failed → stuck=failed-in-review（红条接线有效面）
//   F6 无 dispatch_id 的 backlog 卡 → 全网盲
//   F7 僵尸网视角：zombieInvariantScan 对 F1/F2 形态的判定（证据①是否把中断行当收割证据）
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
    if (pc.data?.needsConfirm) mgr.orgAction("confirm-decide", { confirm_id: pc.data?.confirm?.id ?? "", approve: true, by: "u" });
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

/** 复刻 patrol.ts:610-632 僵尸证据①构建语义（byId 归并：done 累积/首行 title/任意非空 receipt） */
function buildDoneLedgerPatrolStyle(orgDir: string): HarvestEvidence {
  const byId = new Map<string, { title?: string; done: boolean; hasReceipt: boolean }>();
  for (const line of readFileSync(join(orgDir, "dispatch-log.ndjson"), "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as { id?: string; title?: string; status?: string; receipt?: string };
      if (typeof r.id !== "string" || !r.id) continue;
      const cur = byId.get(r.id);
      byId.set(r.id, { title: r.title || cur?.title, done: r.status === "done" || (cur?.done ?? false), hasReceipt: !!r.receipt || (cur?.hasReceipt ?? false) });
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
    // ===== F1 中断补记形态（今日 7/12 张实锤复刻） =====
    console.log("F1 中断补记（台账 done 行 receipt=relay 重启 + 卡 claimed→backlog T2>T1）:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f1");
      mkCard(f, gid, "W-CT3F1：中断补记滞卡", "d-f1", "claimed");
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f1", tier: "正经立项", target: "manual", status: "running", session_id: "s-f1", title: "W-CT3F1 中断前 running 行" });
      appendDispatch({ ts: Date.now() - 72 * H + 5, id: "d-f1", tier: "正经立项", target: "manual", status: "done", session_id: "s-f1", title: "", receipt: "relay 重启，回合中断" });
      backdateCard(f, gid, "d-f1", Date.now() - 72 * H); // 卡时序回到中断前
      f.mgr.orgAction("board", { op: "move", gid, entry_id: loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f1")!.id, status: "backlog" }); // closeHung 同款：台账行后搬 backlog（T2>T1）
      backdateCard(f, gid, "d-f1", Date.now() - 71 * H, Date.now() - 71 * H); // 滞留 71h（僵尸网 TTL>6h 判定需要；末行 backlog 迁移仍 > 台账行 ts）
      f.mgr.runLedgerRecon("f1-test");
      await sleep(100);
      const c = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f1");
      ok(c?.status === "backlog", `F1a recon 不收敛（现状=${c?.status}——backlog 重开守护把 closeHung 自身搬卡当人工重开，永久堵死【死角锚·修后翻转】）`);
      const h = healthOf(f, gid);
      ok(!h || h.stuck.length === 0, `F1b 红条 stuck 空（${h?.stuck.length ?? 0} 条——boardHealth 两类均不含 backlog×终态超龄【死角锚·修后翻转】）`);
      // F7a 僵尸网视角（同夹具）：证据①是否把中断行当收割证据
      const zs = zombieInvariantScan({ boards: [{ gid, board: loadBoard(gid) }], harvest: buildDoneLedgerPatrolStyle(f.ORG), now: Date.now() });
      const z1 = zs.actions.find((a) => a.entryId === c!.id);
      ok(!!z1 && z1.evidence === "ledger-done", `F7a 僵尸网判「证在=ledger-done」（evidence=${z1?.evidence ?? "无动作"}——中断补记行被当收割证据=假阳；NAV 卡「证在 1」同源【现状锚】）`);
      f.cleanup();
    }

    // ===== F2 failed 退单形态（今日 4/12 张实锤复刻） =====
    console.log("F2 failed 退单（卡 backlog+台账 failed——重派决策面语义）:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f2");
      mkCard(f, gid, "W-CT3F2：failed 退单滞卡", "d-f2", "claimed");
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f2", tier: "正经立项", target: "manual", status: "failed", session_id: "s-f2", title: "W-CT3F2", receipt: "排队重放异常: worktree 被他单活锁占用" });
      backdateCard(f, gid, "d-f2", Date.now() - 72 * H);
      f.mgr.orgAction("board", { op: "move", gid, entry_id: loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f2")!.id, status: "backlog" });
      backdateCard(f, gid, "d-f2", Date.now() - 71 * H, Date.now() - 71 * H); // 滞留 71h（僵尸网 TTL 判定需要）
      f.mgr.runLedgerRecon("f2-test");
      await sleep(100);
      const c = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f2");
      ok(c?.status === "backlog", `F2a recon 不收敛（现状=${c?.status}——failed→backlog=no-op 设计内；但无任何示众面【死角锚·修后翻转】）`);
      const h = healthOf(f, gid);
      ok(!h || h.stuck.length === 0, `F2b 红条 stuck 空（${h?.stuck.length ?? 0} 条——failed-in-review 只辖 submitted/ready，failed×backlog 不亮【死角锚·修后翻转】）`);
      const zs = zombieInvariantScan({ boards: [{ gid, board: loadBoard(gid) }], harvest: buildDoneLedgerPatrolStyle(f.ORG), now: Date.now() });
      const z2 = zs.actions.find((a) => a.entryId === c!.id);
      ok(!!z2 && z2.evidence === null, `F7b 僵尸网判「证无」（evidence=${z2?.evidence ?? "无动作"}——doneLedger 只收 done 行；证无=告警分支，observe 档零输出【现状锚】）`);
      f.cleanup();
    }

    // ===== F3/F4 500 窗对照（同形态，差异仅=台账行在窗内/窗外） =====
    console.log("F3/F4 readDispatchLog() 默认 500 窗（窗外老单双盲）:");
    {
      const f = mkEnv();
      const gidF3 = f.mkGroup("f3");
      mkCard(f, gidF3, "W-CT3F3：窗外老单滞卡", "d-f3", "backlog");
      backdateCard(f, gidF3, "d-f3", Date.now() - 80 * H);
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f3", tier: "正经立项", target: "manual", status: "done", session_id: "s-f3", title: "W-CT3F3 干净收割", receipt: "结果：真收割｜改动文件：a.ts" });
      // 505 张更新单把 d-f3 挤出默认窗（readDispatchLog 同 id 去重后取末 500）
      for (let i = 0; i < 505; i++) appendDispatch({ ts: Date.now(), id: `d-noise-${i}`, tier: "正经立项", target: "manual", status: "running", session_id: "s-n", title: `噪音单 ${i}` });
      f.mgr.runLedgerRecon("f3-test");
      await sleep(100);
      const c3 = loadBoard(gidF3).entries.find((x) => x.dispatch_id === "d-f3");
      const h3 = healthOf(f, gidF3);
      ok(c3?.status === "backlog", `F3a 窗外老单 recon 不收敛（现状=${c3?.status}——台账行被 500 窗截掉，led map 无此 id；生产 2636 ids 窗=11-09 起【死角锚·修后翻转】）`);
      ok(!h3 || h3.stuck.length === 0, `F3b 窗外老单红条 stuck 空（${h3?.stuck.length ?? 0} 条——红条与刀三共用同窗 led map【死角锚·修后翻转】）`);

      const gidF4 = f.mkGroup("f4");
      mkCard(f, gidF4, "W-CT3F4：窗内老单对照", "d-f4", "backlog");
      backdateCard(f, gidF4, "d-f4", Date.now() - 80 * H);
      appendDispatch({ ts: Date.now() - 72 * H, id: "d-f4", tier: "正经立项", target: "manual", status: "done", session_id: "s-f4", title: "W-CT3F4 干净收割", receipt: "结果：真收割｜改动文件：a.ts" });
      f.mgr.runLedgerRecon("f4-test");
      await sleep(100);
      const c4 = loadBoard(gidF4).entries.find((x) => x.dispatch_id === "d-f4");
      ok(c4?.status === "done", `F4a 正对照：同形态窗内→收敛 done（现状=${c4?.status}——网本身工作，F3 唯一差异=窗）`);
      ok((healthOf(f, gidF4)?.fixedToday ?? 0) >= 1, `F4b boardHealthBump 当日已修计数（fixedToday=${healthOf(f, gidF4)?.fixedToday ?? 0}——已修示众面接线有效）`);
      f.cleanup();
    }

    // ===== F5 红条正对照（本批红条真实有效面） =====
    console.log("F5 submitted×台账 failed → stuck=failed-in-review:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f5");
      mkCard(f, gid, "W-CT3F5：failed 复核矛盾卡", "d-f5", "claimed");
      const ent = loadBoard(gid).entries.find((x) => x.dispatch_id === "d-f5")!;
      upsertBoardEntry(gid, { id: ent.id, text: ent.text, status: "done", review_required: true }); // R2 内核→submitted（org 命令白名单不透传 rr，直调 store 同 test-cardterm 手法）
      appendDispatch({ ts: Date.now() - 2 * H, id: "d-f5", tier: "正经立项", target: "manual", status: "failed", session_id: "s-f5", title: "W-CT3F5", receipt: "审查打回：证据不足" });
      f.mgr.runLedgerRecon("f5-test");
      await sleep(100);
      const h = healthOf(f, gid);
      ok(h?.stuck.length === 1 && h.stuck[0].kind === "failed-in-review", `F5a 红条 stuck=failed-in-review（${h?.stuck.map((s) => s.kind).join(",") ?? "无"}——保护态显性化接线有效）`);
      f.cleanup();
    }

    // ===== F6 无 dispatch_id 的 backlog 卡 =====
    console.log("F6 无关联 backlog 卡（手写/关联丢失形态）:");
    {
      const f = mkEnv();
      const gid = f.mkGroup("f6");
      mkCard(f, gid, "W-CT3F6：无关联滞卡（工作其实已完结）", null, "backlog");
      backdateCardByText(f, gid, "W-CT3F6", Date.now() - 80 * H); // 滞留 80h（僵尸网 TTL 判定需要）
      f.mgr.runLedgerRecon("f6-test");
      await sleep(100);
      const c = loadBoard(gid).entries.find((x) => x.text.startsWith("W-CT3F6"));
      const h = healthOf(f, gid);
      ok(c?.status === "backlog" && (!h || h.stuck.length === 0), `F6a 全网盲（现状=${c?.status}/stuck=${h?.stuck.length ?? 0}——#263/红条 id 必需、僵尸网纯 backlog 排除、刀二不闭 backlog 态【死角锚·修后翻转】）`);
      const zs = zombieInvariantScan({ boards: [{ gid, board: loadBoard(gid) }], harvest: { doneLedger: new Map(), devLogText: "w-ct3f6", receiptSlugs: new Set() }, now: Date.now() });
      ok(!zs.actions.some((a) => a.entryId === c!.id), `F6b 僵尸网也不辖（纯 backlog 无 id 被形态面排除——证据在手也不翻不警【现状锚】）`);
      f.cleanup();
    }

    console.log(`\n========== cardterm-review3 反方夹具：${pass} 通过 / ${fail} 失败 ==========`);
    console.log(`（F1/F2/F3/F6 系【死角锚】——断言的是当前缺口现状，修法批落地后应翻转；F4/F5/F7 为接线有效面/现状实锤）`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
}
void main();
