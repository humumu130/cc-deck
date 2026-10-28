// #292-B4 终批断言套件（B4a 影子面；B4b/c 随灰度步扩展）：
//   §W 帧写透传：emitUpdated 触发 session 直写（shadow 模式），行落库+可比列与内存零差异
//   §S 影子 20 轮：写→投影重灌→直写→再比对（投影覆盖直写→直写再覆盖，终态=内存态）循环零差异
//   §P 性能预算（R4）：100 帧单帧事务计时 P95<5ms（沙盒口径）
//   §O off 旁路：CCR_SESSION_WRITE_MODE=off 零写（行数不变）
//   §D 降级：json 档=旁路；库不可用=warn 一次+帧链不炸
// 直跑：cd relay && env -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT npx tsx scripts/test-c4.ts
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-c4-org/", "../data/test-c4-data/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-c4-org/");
process.env.CCR_DATA_DIR = SB("../data/test-c4-data/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_STORAGE_READ_MODE;
delete process.env.CCR_SESSION_WRITE_MODE;
delete process.env.CCR_PORT;

let pass = 0, fail = 0;
function assert4(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); }
}

const { EventBus } = await import("../src/event-bus.js");
const { SessionManager } = await import("../src/session-manager.js");
const { loadConfig } = await import("../src/config.js");
const cfg = loadConfig();
cfg.token = "t";
cfg.dataDir = process.env.CCR_DATA_DIR!;
const bus = new EventBus({ persistPath: join(process.env.CCR_DATA_DIR!, "events.ndjson") });
const sm = new SessionManager(bus, cfg);
const { ensureStore, resolveDirs } = await import("../src/storage/read-mode.js");
const port = ensureStore(resolveDirs());
const sw = await import("../src/storage/session-write.js");

console.log("§W 帧写透传（external 卡路径——零 agent 依赖，同 emitUpdated 帧链）：");
let sid = "";
{
  const W_CWD = join(process.env.CCR_DATA_DIR!, "w");
  mkdirSync(W_CWD, { recursive: true });
  const est = sm.ensureExternal("ext-c4-e59a0001-0000-4000-8000-000000000001", W_CWD, "c4 批4会话", "c4-e59a0001", Date.now(), {});
  sid = est.session_id;
  sm.setExternalStatus(sid, "WORKING", "c4 批4首帧");
  // 帧链直驱（force 帧——setExternalStatus 的非 force 帧受 UPDATE_THROTTLE_MS 节流
  // 会跳过挂点：帧粒度=库粒度属设计内，最终由下一 force 帧收敛；测试直驱 force 验证透传）
  const cardsW = (sm as unknown as { sessions: Map<string, { state: { session_id: string } & Record<string, unknown> }> }).sessions;
  (sm as unknown as { emitUpdated: (s: unknown, force: boolean) => void }).emitUpdated(cardsW.get(sid) as never, true);
  const row = port.query<{ id: string; status: string; cwd: string }>("SELECT id, status, cwd FROM session WHERE id = ?", [sid]);
  assert4(row.length === 1, `W1 帧写透传：状态帧后 session 行落库（id=${sid.slice(0, 16)}…）`);
  assert4(row[0]?.status === "WORKING", `W2 落库 status=WORKING（实 ${row[0]?.status}）`);
  const cards = (sm as unknown as { sessions: Map<string, { state: { session_id: string } & Record<string, unknown> }> }).sessions;
  const st = cards.get(sid)?.state;
  assert4(!!st && sw.shadowSessionDiff(port, st as never).length === 0, "W3 影子比对：可比列零差异（status/updated_at/cwd/relay_session_id）");
}

console.log("§S 影子 20 轮（投影重灌↔直写互覆盖，终态=内存态）：");
{
  let diffN = 0;
  for (let i = 0; i < 20; i++) {
    // 状态推进（emitUpdated 帧）→直写
    (sm as unknown as { emitUpdatedForTest?: (id: string) => void }).emitUpdatedForTest?.(sid);
    // 直接驱动一次状态变更（setExternalStatus 同族——用内部 touch：改 summary 再 emit）
    const cards = (sm as unknown as { sessions: Map<string, { state: Record<string, unknown> }> }).sessions;
    const st = cards.get(sid)?.state;
    if (st) { st.action_summary = `影子轮 ${i}`; st.updated_at = Date.now(); }
    (sm as unknown as { emitUpdated: (s: unknown, force: boolean) => void }).emitUpdated(cards.get(sid) as never, true);
    // 投影重灌（ensureStore 全量导入——session 域 checkpoint 失效时重灌覆盖直写行）
    ensureStore(resolveDirs());
    // 再帧写（直写覆盖回内存态）
    (sm as unknown as { emitUpdated: (s: unknown, force: boolean) => void }).emitUpdated(cards.get(sid) as never, true);
    const diffs = sw.shadowSessionDiff(port, st as never);
    if (diffs.length) { diffN++; if (diffN <= 2) console.log(`    轮 ${i} 差异:`, diffs.join("; ").slice(0, 120)); }
  }
  assert4(diffN === 0, `S1 投影↔直写互覆盖 20 轮零差异（实 ${diffN} 轮有差）`);
}

console.log("§P 性能预算（R4：100 帧单帧事务 P95<5ms）：");
{
  const cards = (sm as unknown as { sessions: Map<string, { state: Record<string, unknown> }> }).sessions;
  const s4 = cards.get(sid) as never;
  const dts: number[] = [];
  for (let i = 0; i < 100; i++) {
    const st = cards.get(sid)?.state;
    if (st) st.updated_at = Date.now();
    const t = performance.now();
    (sm as unknown as { emitUpdated: (s: unknown, force: boolean) => void }).emitUpdated(s4, true);
    dts.push(performance.now() - t);
  }
  dts.sort((a, b) => a - b);
  const p95 = dts[Math.floor(dts.length * 0.95)];
  console.log(`  [计时] 100 帧 P50=${dts[50].toFixed(2)}ms P95=${p95.toFixed(2)}ms max=${dts[99].toFixed(2)}ms`);
  assert4(p95 < 5, `P1 单帧事务 P95<5ms（实 ${p95.toFixed(2)}ms，R4 预算）`);
}

console.log("§O off 旁路：");
{
  const before = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM session")[0]?.n ?? -1;
  process.env.CCR_SESSION_WRITE_MODE = "off";
  const cards = (sm as unknown as { sessions: Map<string, { state: Record<string, unknown> }> }).sessions;
  const st = cards.get(sid)?.state;
  if (st) st.updated_at = Date.now();
  (sm as unknown as { emitUpdated: (s: unknown, force: boolean) => void }).emitUpdated(cards.get(sid) as never, true);
  const after = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM session")[0]?.n ?? -2;
  // 行数不变且 updated_at 未被本帧推（off 旁路——行可能是旧直写行但值不动）
  const rowUa = port.query<{ updated_at: number }>("SELECT updated_at FROM session WHERE id = ?", [sid])[0]?.updated_at ?? 0;
  const memUa = Number(cards.get(sid)?.state.updated_at ?? 0);
  assert4(before === after && rowUa !== memUa, `O1 off=零写（行数 ${before}→${after} 不变，库时刻停在旁路前）`);
  delete process.env.CCR_SESSION_WRITE_MODE;
}

console.log("§D 降级：");
{
  // json 档=旁路（帧链不炸）
  process.env.CCR_STORAGE_READ_MODE = "json";
  let threw = false;
  try {
    const cards = (sm as unknown as { sessions: Map<string, { state: Record<string, unknown> }> }).sessions;
    const st = cards.get(sid)?.state;
    if (st) st.updated_at = Date.now();
    (sm as unknown as { emitUpdated: (s: unknown, force: boolean) => void }).emitUpdated(cards.get(sid) as never, true);
  } catch { threw = true; }
  assert4(!threw, "D1 json 档帧链不炸（直写旁路）");
  delete process.env.CCR_STORAGE_READ_MODE;
  // 库不可用（dataDir 指坏路径）：quiet 抛→warn 一次旁路，帧链不炸
  const savedData = process.env.CCR_DATA_DIR;
  process.env.CCR_DATA_DIR = "/dev/null/nope/c4";
  sw.resetSessionWriteWarnForTest();
  let threw2 = false;
  try {
    const cards = (sm as unknown as { sessions: Map<string, { state: Record<string, unknown> }> }).sessions;
    const st = cards.get(sid)?.state;
    if (st) st.updated_at = Date.now();
    (sm as unknown as { emitUpdated: (s: unknown, force: boolean) => void }).emitUpdated(cards.get(sid) as never, true);
  } catch { threw2 = true; }
  assert4(!threw2, "D2 库不可用：直写旁路 warn 一次，帧链不炸（#158 语义）");
  process.env.CCR_DATA_DIR = savedData;
}

// §F（PM 审查 FK 陷阱钉住）：冷启新库首帧写——quiet 建库无 group 行+直写带 project_gid
// →group_id NULL 化落行（零 FK 撞）；组行在位后 REPLACE 自愈归因
{
  process.env.CCR_DATA_DIR = SB("../data/test-c4-fk/"); // 新库（quiet 首建=无导入）
  const { ensureStoreQuiet } = await import("../src/storage/read-mode.js");
  const dirsF = resolveDirs();
  const portF = ensureStoreQuiet({ ...dirsF, dataDir: process.env.CCR_DATA_DIR });
  const stF = { session_id: "ext-c4-fk-0001", relay_session_id: "c4-fk-0001", project_gid: "pg-not-exist", cwd: "/tmp/fk", status: "WORKING", updated_at: Date.now(), started_at: Date.now() } as never;
  sw.shadowWriteSession(stF); // 首帧：组不在库→NULL 化
  const rowF = portF.query<{ id: string; group_id: string | null }>("SELECT id, group_id FROM session WHERE id = ?", ["ext-c4-fk-0001"]);
  assert4(rowF.length === 1 && rowF[0]?.group_id === null, `F1 冷启新库首帧写：未知组 NULL 化落行零 FK 撞（实 group_id=${rowF[0]?.group_id ?? "无行"}）`);
  // 组行在位后 REPLACE 自愈归因——组行走真导入器（import-org）灌库（手拼 INSERT 撞
  // NOTNULL 的坑实录：DML 一律经源码语句/导入器，不手拼）
  const { writeFileSync: wfF } = await import("node:fs");
  const orgDirF = process.env.CCR_ORG_DIR!;
  wfF(join(orgDirF, "projects.json"), JSON.stringify({ groups: [{
    id: "pg-not-exist", project_id: undefined, name: "FK 组", anchor_dir: "/tmp/fk-g", status: "active", tier: "轻立项",
    single_card: false, headcount: [], role_defaults: {}, created_at: Date.now(), updated_at: Date.now(),
  } satisfies never] }, null, 2));
  const { ensureStore } = await import("../src/storage/read-mode.js");
  ensureStore(resolveDirs()); // 读前触发=import-org 灌组行
  const stF2 = { ...stF, updated_at: Date.now() } as never;
  sw.shadowWriteSession(stF2);
  const rowF2 = portF.query<{ group_id: string | null }>("SELECT group_id FROM session WHERE id = ?", ["ext-c4-fk-0001"]);
  assert4(rowF2[0]?.group_id === "pg-not-exist", `F2 组行在位后 REPLACE 自愈归因（实 ${rowF2[0]?.group_id}）`);
  process.env.CCR_DATA_DIR = SB("../data/test-c4-data/");
}

// §B（B4b 对账哨）：三态差异分类正确性
{
  const { bootReconcile, bootFromMode } = sw;
  // 构造：库有 a/b/c，回放有 b/c/d——dbOnly=[a]、replayOnly=[d]
  const fakePort = {
    query: () => [{ id: "a", status: "WORKING" }, { id: "b", status: "DONE" }, { id: "c", status: "WORKING" }],
  } as never;
  const r = bootReconcile(fakePort, new Set(["b", "c", "d"]));
  assert4(r.dbOnly.length === 1 && r.dbOnly[0] === "a", `B1 库多行分类（实 ${JSON.stringify(r.dbOnly)}）`);
  assert4(r.replayOnly.length === 1 && r.replayOnly[0] === "d", `B2 回放多卡分类（实 ${JSON.stringify(r.replayOnly)}）`);
  const r2 = bootReconcile({ query: () => [{ id: "x", status: "WORKING" }] } as never, new Set(["x"]));
  assert4(r2.dbOnly.length === 0 && r2.replayOnly.length === 0, "B3 零差异路径");
  assert4(bootFromMode() === "events" && process.env.CCR_BOOT_FROM === undefined, "B4 缺省 events（现行为不动）");
  process.env.CCR_BOOT_FROM = "auto";
  assert4(bootFromMode() === "auto", "B5 auto 态识别");
  delete process.env.CCR_BOOT_FROM;
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
for (const d of ["../data/test-c4-org/", "../data/test-c4-data/", "../data/test-c4-fk/"]) {
  try { rmSync(SB(d), { recursive: true, force: true }); } catch {}
}
process.exit(fail > 0 ? 1 : 0);
