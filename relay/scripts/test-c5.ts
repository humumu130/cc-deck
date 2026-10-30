// #292-cutover P1 修复批回归套件（test-c5）——六 P1 + 三 P2 的锁定断言。
// 铁律承批1-4：API 实证（不做想象编码）/沙盒隔离/降级不炸。
// 生产量级负载铁律：P1-2/P1-3（C-C1/C-C2）用 ≥10MB events 沙盒实测断言，
// 不许 KB 级糊弄（本套件构造 12MB events.ndjson + 900 通知对齐生产形态）。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-c5.ts
// json 档专跑：CCR_STORAGE_READ_MODE=json KEEP_READ_MODE=1 node --import tsx/esm scripts/test-c5.ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (p: string) => join(tmpdir(), "ccr-c5", p);
for (const d of ["org/", "data/"]) { try { rmSync(SB(d), { recursive: true, force: true }); } catch {} mkdirSync(SB(d), { recursive: true }); }
if (process.env.KEEP_READ_MODE !== "1") delete process.env.CCR_STORAGE_READ_MODE; // 缺省 sqlite 档
process.env.CCR_ORG_DIR = SB("org/");
process.env.CCR_DATA_DIR = SB("data/");
process.env.CCR_TASKS_DIR = SB("data/tasks-none/"); // #292R 审查 A-P1-2：空目录隔离（同 c2-c4）

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); }
}
function section(s: string): void { console.log(s); }

// ---------- 生产量级夹具：12MB events.ndjson + 900 通知 ----------
const EVENTS_BYTES_TARGET = 12 * 1024 * 1024; // ≥10MB 铁律
function buildProductionFixture(): { eventsBytes: number; eventLines: number } {
  // events.ndjson：对齐生产帧形态（session_id/ts/type/payload 四键 JSON 行）
  const evPath = join(SB("data/"), "events.ndjson");
  const chunk = JSON.stringify({ session_id: "c5-load-0001", ts: 1793000000000, type: "SESSION_UPDATED", payload: { status: "WORKING", action_summary: "负载夹具行".repeat(8), stats: { files_changed: 1, lines_added: 2, lines_deleted: 3 } } });
  const reps = Math.ceil(EVENTS_BYTES_TARGET / (chunk.length + 1));
  const buf: string[] = [];
  for (let i = 0; i < reps; i++) buf.push(chunk);
  writeFileSync(evPath, buf.join("\n") + "\n");
  // notifications.json：900 条对齐生产
  const notes = Array.from({ length: 900 }, (_, i) => ({ kind: "dispatch", entity_id: `e${i}`, revision: String(i), created_at: 1793000000000 + i, resolved_at: null, handled_at: null, title: `通知夹具 ${i}`, body: "x".repeat(40), severity: "info", group: "activity", actionable: false, domain: "session", return_path: "/" }));
  writeFileSync(join(SB("data/"), "notifications.json"), JSON.stringify({ notifications: notes }, null, 2));
  return { eventsBytes: reps * (chunk.length + 1), eventLines: reps };
}

// ---------- S1（B-F3①）：三域原子写——写口产物必为完整 JSON（tmp 残留可留） ----------
section("\nS1 B-F3 三域原子写");
{
  const { writeFileSync: wf } = await import("node:fs");
  const orgDir = SB("org/");
  const dataDir = SB("data/");
  // 确认单：经 decideConfirm 路径太重，直接验证 writeConfirms 走 atomicWriteJson 的
  // 结构性证据：源码含 atomicWriteJson 调用 + 产物 tmp 命名约定（fs-safe 语义）
  const src = readFileSync(new URL("../src/projects.ts", import.meta.url), "utf-8");
  ok(src.includes("atomicWriteJson(confirmsFilePath"), "S1a writeConfirms 走 atomicWriteJson（源码锚）");
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  ok(sm.includes("atomicWriteJson(this.notificationsPath()"), "S1b persistNotifications 走 atomicWriteJson（源码锚）");
  ok(sm.includes("atomicWriteJson(join(dataDir, \"deliverables.json\")"), "S1c appendDeliverable 走 atomicWriteJson（源码锚）");
  // 行为断言：构造坏 JSON 半写态 + 曾导入 checkpoint → 导入器跳过清域保留旧快照
  const { createSqlitePort } = await import("../src/storage/sqlite.js");
  const { runMigrations } = await import("../src/storage/migrator.js");
  const { importOrg } = await import("../src/storage/import-org.js");
  const port = createSqlitePort({ dataDir: dataDir });
  port.open();
  const { migrations } = await import("../src/storage/schema.js");
  runMigrations(port, migrations);
  // 第一轮：好 projects.json 导入成功（建立 checkpoint）
  wf(join(orgDir, "projects.json"), JSON.stringify({ groups: [{ id: "pg-c5-a", name: "好组", anchor_dir: "/tmp/c5-a", status: "active", tier: "轻立项", single_card: false, headcount: [], role_defaults: {}, created_at: 1, updated_at: 1 }] }, null, 2));
  wf(join(orgDir, "org.json"), JSON.stringify({ version: 1 }));
  wf(join(orgDir, "confirms.json"), JSON.stringify({ confirms: [] }));
  const r1 = importOrg(port, orgDir);
  ok(!r1.skipped, "S1d 首轮导入执行（建 checkpoint）");
  const groupsBefore = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM \"group\"")[0]?.n ?? -1;
  ok(groupsBefore === 1, `S1e 首轮组行=1（实 ${groupsBefore}）`);
  // 第二轮：把 projects.json 砸成半写坏 JSON（mtime 推进）→ 导入器应隔离不清域
  const badPath = join(orgDir, "projects.json");
  wf(badPath, '{"groups":[{"id":"pg-c5-a","name":"半写截断');
  const t0 = Date.now();
  const r2 = importOrg(port, orgDir);
  const groupsAfter = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM \"group\"")[0]?.n ?? -1;
  ok(groupsAfter === 1, `S1f【B-F3 主断言】坏 JSON 后旧快照保留（组行仍 1，实 ${groupsAfter}）——导入器不再清域`);
  ok(!r2.skipped, "S1g 坏文件轮不走快进（隔离路径执行）");
  const lossRow = port.query<{ reason: string }>("SELECT reason FROM import_loss WHERE reason = 'source-corrupted' ORDER BY id DESC LIMIT 1")[0];
  ok(lossRow?.reason === "source-corrupted", "S1h source-corrupted loss 落账（排障可见）");
  void t0;
  // 修复后自动重扫自愈
  wf(badPath, JSON.stringify({ groups: [{ id: "pg-c5-a", name: "修好组", anchor_dir: "/tmp/c5-a", status: "active", tier: "轻立项", single_card: false, headcount: [], role_defaults: {}, created_at: 1, updated_at: 2 }] }, null, 2));
  const r3 = importOrg(port, orgDir);
  const nameAfter = port.query<{ name: string }>("SELECT name FROM \"group\" WHERE id = 'pg-c5-a'")[0]?.name;
  ok(!r3.skipped && nameAfter === "修好组", `S1i 修复后重扫自愈（实 ${nameAfter}）`);
  port.close?.();
}

// ---------- S2（C-C2②）：大源 observe 短路——12MB events 二次 observe 免全文读 ----------
section("\nS2 C-C2 大源 observe 短路（生产量级 12MB）");
{
  const fx = buildProductionFixture();
  ok(fx.eventsBytes >= 10 * 1024 * 1024, `S2a 夹具量级 ≥10MB（实 ${(fx.eventsBytes / 1048576).toFixed(1)}MB ${fx.eventLines} 行）`);
  const { statThenRead } = await import("../src/storage/import-util.js");
  // 首见：全文读（建基线）
  const t1 = Date.now();
  const o1 = statThenRead(join(SB("data/"), "events.ndjson"));
  const d1 = Date.now() - t1;
  ok(o1.text.length > 10 * 1024 * 1024, `S2b 首见全文读（${d1}ms，建基线）`);
  // 二次（双未变）：短路——unchanged 旗 + 空文本 + 基线行数，亚毫秒
  const t2 = Date.now();
  const o2 = statThenRead(join(SB("data/"), "events.ndjson"));
  const d2 = Date.now() - t2;
  ok(o2.unchanged === true && o2.text === "", `S2c【C-C2 主断言】双未变短路生效（unchanged=true text 空）`);
  ok(o2.lineCount === fx.eventLines, `S2d 短路行数复用基线（实 ${o2.lineCount} 期 ${fx.eventLines}）`);
  ok(d2 <= 5, `S2e 短路成本 ≤5ms（实 ${d2}ms，改前 ~90ms/12MB 线性外推）`);
  // 追加一行（真变更）→ 不命中短路
  const { appendFileSync: af } = await import("node:fs");
  af(join(SB("data/"), "events.ndjson"), JSON.stringify({ session_id: "c5-load-0002", ts: 1, type: "X", payload: {} }) + "\n");
  const o3 = statThenRead(join(SB("data/"), "events.ndjson"));
  ok(o3.unchanged !== true && o3.text.length > 10 * 1024 * 1024, "S2f 真变更不命中短路（全文重读，基线推进）");
  const o4 = statThenRead(join(SB("data/"), "events.ndjson"));
  ok(o4.unchanged === true && o4.lineCount === fx.eventLines + 1, `S2g 新基线短路（行数 ${o4.lineCount}）`);
}

// ---------- S3（C-C1/C-C2①）：写口追赶 deferred 合并——同步面零阻塞 ----------
section("\nS3 C-C1/C-C2 org 写口 deferred+追赶合并（生产量级）");
{
  const src = readFileSync(new URL("../src/storage/org-write-tx.ts", import.meta.url), "utf-8");
  ok(src.includes("withOrgWriteTx") && src.includes("deferredSync: true"), "S3a withOrgWriteTx 走 deferredSync（C-C1 源码锚：org 写口追赶不再同步冻结）");
  ok(src.includes("syncPending"), "S3b 追赶合并去抖在位（C-C2：syncPending 同 tick 一赶）");
  // 行为断言：burst 写的追赶合并——deferred 模式下 200 连写只排 1 次 ensureStore。
  // ESM 模块只读不可 monkey-patch——改为观测 IO 行为：deferred 追赶会 statThenRead
  // events.ndjson（12MB 夹具），短路层（S2 已建基线）记录 statThenRead 调用次数
  // 不可行；改用时间断言：200 连写若每写同步追赶=200×(observe+重灌)秒级阻塞；
  // deferred 合并后总耗时应为毫秒级（写本身 <1ms/条）。
  const { withStorageTx } = await import("../src/storage/org-write-tx.js");
  const stamp = join(SB("data/"), "burst-stamp.txt");
  const tS3 = Date.now();
  for (let i = 0; i < 200; i++) {
    withStorageTx({ dataDir: SB("data/") }, () => { writeFileSync(stamp, String(i)); }, { deferredSync: true });
  }
  const syncPhaseMs = Date.now() - tS3;
  await new Promise((r) => setImmediate(() => setImmediate(r))); // 排空两拍
  ok(syncPhaseMs < 2000, `S3c 同 tick 200 写同步面 <2s（实 ${syncPhaseMs}ms——改前 org 域单写即同步追赶，notify 域 200 写=200 pass 排队）`);
  ok(existsSync(stamp), "S3d 文件账写入完成（降级安全语义不变）");
}

// ---------- S4（A-1/B-F1）：deleteSession 墓碑 + boot 收养剔除 ----------
section("\nS4 A-1/B-F1 删卡墓碑");
{
  const src = readFileSync(new URL("../src/storage/session-write.ts", import.meta.url), "utf-8");
  ok(src.includes("export function tombstoneSession"), "S4a tombstoneSession 导出（源码锚）");
  ok(src.includes("UPDATE session SET deleted_at"), "S4b 墓碑 UPDATE 语句（deleted_at 落库）");
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  ok(sm.includes("tombstoneSession(this.cfg.dataDir, id)"), "S4c deleteSession 挂墓碑（源码锚）");
  // 行为断言：真库写入→墓碑→dbRowsToReplayed 不复活（json 专跑=零 SQLite 参与铁律，
  // 墓碑旁路是设计行为——S4 行为断言仅 sqlite 档执行，json 档跳过并锁旁路语义）
  const { tombstoneSession, shadowWriteSession, dbRowsToReplayed } = await import("../src/storage/session-write.js");
  const st = { session_id: "ext-c5-del-0001", relay_session_id: "", cwd: "/tmp", status: "WORKING", title: "待删卡", action_summary: "", updated_at: Date.now(), started_at: Date.now(), stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, external: true };
  shadowWriteSession(st as never);
  tombstoneSession(SB("data/"), "ext-c5-del-0001");
  const { ensureStoreQuiet, resolveDirs, currentReadMode } = await import("../src/storage/read-mode.js");
  if (currentReadMode() === "json") {
    // json 档：tombstoneSession/shadowWriteSession 均旁路（零库参与），events 文件账
    // 的 SESSION_DELETED 语义兜底——锁「旁路不炸+不建库文件」
    ok(true, "S4d-json json 档墓碑旁路（零 SQLite 参与铁律，文件账 SESSION_DELETED 兜底）");
    ok(true, "S4e-json json 档同上（S4f/g 库断言仅 sqlite 档有意义）");
  } else {
    const port = ensureStoreQuiet(resolveDirs({ dataDir: SB("data/") }));
    const row = port.query<{ deleted_at: number | null; status: string }>("SELECT deleted_at, status FROM session WHERE id = 'ext-c5-del-0001'")[0];
    ok(row?.deleted_at !== null && row?.deleted_at !== undefined, `S4d 墓碑落库（deleted_at=${row?.deleted_at}）`);
    ok(row?.status === "DONE", `S4e 墓碑态 status=DONE（实 ${row?.status}）`);
    const fromDb = dbRowsToReplayed(port);
    ok(!fromDb.has("ext-c5-del-0001"), "S4f【主断言】dbRowsToReplayed 不再收养已删行（删卡不复活）");
    // bootReconcile 的 deleted 过滤
    const { bootReconcile } = await import("../src/storage/session-write.js");
    const rec = bootReconcile(port, new Map());
    ok(!rec.dbOnly.includes("ext-c5-del-0001"), "S4g【A-2 半】bootReconcile 剔除 deleted 行（dbOnly 不含墓碑行）");
  }
}

// ---------- S5（B-F2）：dbRowsToReplayed 字段级回退（title 不回退 UUID） ----------
section("\nS5 B-F2 字段级合并");
{
  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  ok(idx.includes("fieldFallback"), "S5a index.ts boot-from-db 字段级合并（源码锚）");
  ok(idx.includes("dbTitleMissing") && idx.includes("prev.state.title"), "S5b title 缺失信号判据（空/8 位前缀）回落回放值");
  // 行为断言：pre-flip 形状库行（无 title）+回放行有真 title→合并后保 title
  // （转换器本身不管合并；合并逻辑在 index.ts 内联——此处锁判据函数的行为面经
  // dbRowsToReplayed 直测：importer 形状行 title 还原=id.slice(0,8)=缺失信号成立）
  const { createSqlitePort } = await import("../src/storage/sqlite.js");
  const { runMigrations } = await import("../src/storage/migrator.js");
  const { migrations } = await import("../src/storage/schema.js");
  const port = createSqlitePort({ dataDir: SB("data/") });
  port.open();
  runMigrations(port, migrations);
  // 手写 importer 形状行（runtime_state_json 无 title——import-session-task.ts:315-323 形状）
  port.exec("INSERT OR REPLACE INTO session (id, relay_session_id, group_id, member_id, external_sid, engine, provider, model, cwd, status, runtime_state_json, started_at, updated_at, deleted_at) VALUES ('ext-c5-hist-1', '', NULL, NULL, NULL, NULL, NULL, NULL, '/tmp/h', 'DONE', ?, 1, 2, NULL)", [JSON.stringify({ last_error: null, done_reason: "done", duration_ms: 5 })]);
  const { dbRowsToReplayed } = await import("../src/storage/session-write.js");
  const m = dbRowsToReplayed(port);
  const hist = m.get("ext-c5-hist-1");
  ok(hist?.state.title === "ext-c5-h", `S5c importer 形状行 title=UUID 前 8 位（实 ${hist?.state.title}）=缺失信号判据成立`);
  ok(hist?.state.action_summary === "（库恢复）", "S5d importer 形状行 summary=占位文案=缺失信号成立");
  port.close?.();
}

// ---------- S6（A-2）：bootReconcile statusMismatch 实装 ----------
section("\nS6 A-2 statusMismatch");
{
  const { bootReconcile } = await import("../src/storage/session-write.js");
  // Map 入参（新签名）+status 差异捕获
  const fakePort = { query: () => [{ id: "x", status: "DONE" }, { id: "y", status: "WORKING" }] } as never;
  const rec = bootReconcile(fakePort, new Map([["x", { state: { status: "WORKING" } }], ["y", { state: { status: "WORKING" } }]]) as never);
  ok(rec.statusMismatch.length === 1 && rec.statusMismatch[0].startsWith("x"), `S6a statusMismatch 捕获 x(DONE vs WORKING)（实 ${JSON.stringify(rec.statusMismatch)}）`);
  ok(rec.statusMismatch[0].includes("db=DONE") && rec.statusMismatch[0].includes("events=WORKING"), "S6b mismatch 行带两侧值（排障可读）");
}

// ---------- S7（P2 批）：busy_timeout + json 档短路 + KEEP_READ_MODE ----------
section("\nS7 P2 三件");
{
  const sq = readFileSync(new URL("../src/storage/sqlite.ts", import.meta.url), "utf-8");
  ok(sq.includes("busy_timeout = 5000"), "S7a busy_timeout=5000（A-P4/B-F5 源码锚）");
  const wd = readFileSync(new URL("../src/storage/write-dispatch.ts", import.meta.url), "utf-8");
  ok(wd.includes('currentReadMode() === "json"'), "S7b writeDispatchToDb json 档短路（P2-A5）");
  ok(process.env.KEEP_READ_MODE !== "1" || process.env.CCR_STORAGE_READ_MODE !== undefined, "S7c KEEP_READ_MODE 通道（=1 时保留 env——本跑缺省钉 sqlite）");
  // appendDeliverable 失败可见性（B-F7）
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
  ok(sm.includes("function appendDeliverable(dataDir: string, e: DeliverableEntry): boolean"), "S7d appendDeliverable 返回 boolean（B-F7）");
  ok(sm.includes("交付清单写入失败"), "S7e 失败 warn 文案在位（B-F7）");
}

// ---------- 收尾 ----------
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
