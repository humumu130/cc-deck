// M11-F2 artifact 复合键导入器测试：fixture 驱动（自制小样 dataDir，零生产触达）。
// 范式沿用 test-import-org/test-import-notification（mkdtemp+env 全清+assert 计数+两轮连跑）。
// fixture 布局：预插归因锚（project/group/session/task 各 1 合法行）+ 两清单源——
//   A deliverables.json（deliverable 形 6 行：无证据 unknown/悬空 sid/缺 sid 拒入/exists 三态/
//     unverified 证据抑制）+ B artifacts-scan.json（ArtifactItem 形 3 行：同键演进后写赢，
//     无 id → 归一 "local"）。
// 验收 4 灵魂断言：库行 existence_state 与 artifact-view.ts 读侧 evidence 口径逐行互证
//   （deriveArtifactView 真调，unknown → capabilities.open/download/reveal 全关）。
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importArtifacts, ARTIFACT_IMPORT_SCHEMA_VERSION } from "../src/storage/import-artifact.js";
import { readCheckpoint } from "../src/storage/checkpoint.js";
import { listLoss } from "../src/storage/loss-report.js";
import { deriveArtifactView } from "../src/artifact-view.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- 0. 启动前纪律 ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-import-art-"));
process.env.CCR_DATA_DIR = dataDir;
console.log("临时目录纪律:");
assert(dataDir.startsWith(tmpdir()), "fixture dataDir 落 tmpdir 前缀（零生产写入前提）");
assert(!dataDir.startsWith(process.env.HOME ?? "~"), "fixture dataDir 不在生产 HOME 下（不动 ~/.cc-deck）");

const port: StoragePort = createSqlitePort({ dataDir, filename: "import.sqlite3" });
port.open();
runMigrations(port, migrations);

// ---------- fixture：归因锚 + 两清单源 ----------
const T = 1700000000000;
const fileA = join(dataDir, "deliverables.json");
const fileB = join(dataDir, "artifacts-scan.json");
port.exec("INSERT INTO project (id, name, dir_fingerprint, anchor_dir, is_default, is_hidden, deleted_at, ts) VALUES ('proj-1', 'p', 'fp-1', '/fx/p', 0, 0, NULL, ?)", [T]);
port.exec(`INSERT INTO "group" (id, project_id, name, anchor_dir, status, tier, single_card, created_at, updated_at) VALUES ('g-1', 'proj-1', 'g', '/fx/p', 'active', '正经立项', 0, ?, ?)`, [T, T]);
port.exec("INSERT INTO session (id, relay_session_id, group_id, member_id, external_sid, engine, provider, model, cwd, status, started_at, updated_at) VALUES ('sess-ok', NULL, 'g-1', NULL, NULL, NULL, NULL, NULL, '/fx', 'running', ?, ?)", [T, T]);
port.exec("INSERT INTO task (id, project_id, group_id, session_id, parent_task_id, origin, task_ref, title, status, ts) VALUES ('task-1', 'proj-1', 'g-1', 'sess-ok', NULL, 'manual', 'tr-1', 't', 'backlog', ?)", [T]);
writeFileSync(fileA, JSON.stringify([
  { sid: "sess-ok", path: "/repo/docs/report.md", ts: T + 1 },
  { sid: "sess-gone", path: "/repo/gone.md", ts: T + 2 },
  { path: "/repo/nosid.md", ts: T + 3 },
  { sid: "sess-ok", path: "/repo/docs/c.md", ts: T + 4, exists: true },
  { sid: "sess-ok", path: "/repo/docs/d.md", ts: T + 5, exists: false },
  { sid: "sess-ok", path: "/repo/docs/e.md", ts: T + 6, unverified: true, exists: true },
], null, 2) + "\n");
writeFileSync(fileB, JSON.stringify([
  { path: "/repo/out/deck.html", op: "create", size: 1234, first_at: T + 10, last_at: T + 20, exists: true },
  { path: "/repo/out/deck.html", op: "create", size: 1300, first_at: T + 10, last_at: T + 30, exists: false },
  { path: "/repo/out/notes.md", op: "edit", first_at: T + 11, last_at: T + 21, exists: true },
], null, 2) + "\n");

const sources = () => [
  { id: "deliverables", file: fileA, attribution: { project_id: "proj-1", group_id: "g-1" } },
  { file: fileB, attribution: { task_id: "task-1" } },
];
const rowOf = (path: string) => port.query<{ source_id: string; project_id: string | null; group_id: string | null; session_id: string | null; task_id: string | null; size: number | null; kind: string; existence_state: string; created_at: number; updated_at: number }>("SELECT * FROM artifact WHERE normalized_path = ?", [path])[0];
const countOf = (path: string) => port.query<{ n: number }>("SELECT COUNT(*) AS n FROM artifact WHERE normalized_path = ?", [path])[0]?.n ?? -1;

// ---------- 1. 全量导入：行数+复合键映射+三态（验收 1/3） ----------
console.log("全量导入:");
const r1 = importArtifacts(port, sources());
assert(r1.skipped === false && r1.rescanned.length === 2, "两源全重扫（首轮无 checkpoint）");
assert(r1.counts.artifact === 7 && r1.counts.upserted === 7, `行数 7（A 源 5+B 源 2，同键演进行并键）与 fixture 期望一致（实测 ${JSON.stringify(r1.counts)}）`);
const report = rowOf("/repo/docs/report.md");
assert(report !== undefined && report.source_id === "deliverables" && report.existence_state === "unknown" && report.session_id === "sess-ok" && report.project_id === "proj-1" && report.group_id === "g-1" && report.kind === "deliverable", "report.md：无 exists 证据→unknown 不猜、deliverable 形 sid 归因+source 级 project/group 归因通路");
const gone = rowOf("/repo/gone.md");
assert(gone !== undefined && gone.session_id === null, "悬空 sid（sess-gone）行照导且 session_id 写 NULL（零造关联）");
assert(countOf("/repo/nosid.md") === 0, "缺 sid 的 deliverable 形行拒入（readDeliverables 过滤口径）+落账");
const cMd = rowOf("/repo/docs/c.md");
const dMd = rowOf("/repo/docs/d.md");
const eMd = rowOf("/repo/docs/e.md");
assert(cMd?.existence_state === "exists" && dMd?.existence_state === "missing", "显式 boolean 证据直判：exists:true→exists、exists:false→missing");
assert(eMd?.existence_state === "unknown", "unverified=true 记录存在证据不可采信（#72A0FIX2）→ 抑制判定落 unknown");
const deck = rowOf("/repo/out/deck.html");
assert(deck !== undefined && deck.source_id === "local" && deck.existence_state === "missing" && deck.kind === "create" && deck.task_id === "task-1" && deck.size === 1300 && deck.updated_at === T + 30, "同源同键两行：复合键并键、后写赢（state=missing/size=1300/updated_at 晚者）、无 id 源归一 'local'、task 归因通路");
assert(rowOf("/repo/out/notes.md")?.existence_state === "exists", "notes.md exists 直判");
assert(listLoss(port, fileA).length === 2 && listLoss(port, fileA).find((l) => l.reason === "dangling-ref" && l.lineNo === 2) !== undefined && listLoss(port, fileA).find((l) => l.reason === "missing-attribution" && l.lineNo === 3) !== undefined, "A 源 2 账：悬空 dangling-ref（line2）+缺 sid missing-attribution（line3），file:line 元素序口径");
assert(listLoss(port, fileB).length === 1 && listLoss(port, fileB)[0]?.reason === "duplicate-key" && listLoss(port, fileB)[0]?.lineNo === 2, "B 源 1 账：同源同键 duplicate-key（line2，后写赢语义留痕）");
assert(listLoss(port).length === 3, "loss 总账 3 条");
assert(port.query("PRAGMA foreign_key_check").length === 0, "PRAGMA foreign_key_check 零行（悬空归因全 NULL，零悬空 FK）");

// ---------- 2. 读侧门禁互证（验收 4，本单灵魂） ----------
console.log("读侧门禁互证:");
const dbRows = port.query<{ source_id: string; normalized_path: string; existence_state: string }>("SELECT source_id, normalized_path, existence_state FROM artifact ORDER BY source_id, normalized_path");
// 库行→读侧注册记录的同构输入：exists/missing 行带 boolean 证据，unknown 行不带（缺证据）
const regs = dbRows.map((r) => ({ source_id: r.source_id, path: r.normalized_path, ...(r.existence_state === "exists" ? { exists: true } : r.existence_state === "missing" ? { exists: false } : {}) }));
const view = deriveArtifactView({ registrations: regs });
const viewOf = (path: string) => view.find((v) => v.normalized_path === path);
assert(view.length === dbRows.length, `读侧投影行数与库行数一致（${view.length}/${dbRows.length}）`);
assert(dbRows.every((r) => {
  const v = view.find((x) => x.normalized_path === r.normalized_path && x.source_id === r.source_id);
  return v !== undefined && v.capabilities.open === (r.existence_state === "exists");
}), "全库 7 行逐行互证：capabilities.open === (existence_state==='exists')（view :377 口径）");
const unknownViews = dbRows.filter((r) => r.existence_state === "unknown").map((r) => viewOf(r.normalized_path));
assert(unknownViews.length === 3 && unknownViews.every((v) => v !== undefined && v.existence_state === "unknown" && v.capabilities.open === false && v.capabilities.download === false && v.capabilities.reveal === false), "unknown 禁 open/download/reveal：3 条 unknown 行（report/e/gone）读侧门禁全关（#72A0 P2-3C 不默认存在）");
assert(viewOf("/repo/docs/c.md")?.capabilities.open === true && viewOf("/repo/out/notes.md")?.capabilities.open === true, "exists 行读侧 open 放行（门禁只对缺证据收紧，不错杀）");

// ---------- 3. 重复运行幂等（验收 2 前半） ----------
console.log("幂等:");
const r2 = importArtifacts(port, sources());
assert(r2.skipped === true && r2.counts.artifact === 7 && r2.counts.upserted === 0, "重复运行走 checkpoint 快进（skipped=true、行数不增、upserted=0）");
assert(listLoss(port).length === 3, "快进零写入：loss 总账不变（不重复落账）");
assert([fileA, fileB].every((f) => {
  const st = statSync(f);
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return readCheckpoint(port, f, { mtimeMs: Math.round(st.mtimeMs), lineCount: lines.length, schemaVersion: ARTIFACT_IMPORT_SCHEMA_VERSION }) !== null;
}), "两源 checkpoint 记录在位且有效（五元组命中）");

// ---------- 4. 源变化失效重扫：同键演进+差集删不残留（验收 2 后半+5） ----------
console.log("演进重扫:");
writeFileSync(fileA, JSON.stringify([
  { sid: "sess-ok", path: "/repo/docs/report.md", ts: T + 1 },
  { sid: "sess-ok", path: "/repo/docs/c.md", ts: T + 4, exists: false },
  { sid: "sess-ok", path: "/repo/docs/d.md", ts: T + 5, exists: false },
  { sid: "sess-ok", path: "/repo/docs/e.md", ts: T + 6, unverified: true, exists: true },
  { sid: "sess-ok", path: "/repo/docs/f.md", ts: T + 7, exists: true },
], null, 2) + "\n");
utimesSync(fileA, new Date(Date.now() + 10), new Date(Date.now() + 10)); // 防同毫秒 mtime 巧合
const r3 = importArtifacts(port, sources());
assert(r3.skipped === false && r3.rescanned.length === 2, "A 源失效→重扫（两源都重灌）");
assert(r3.counts.artifact === 7 && r3.counts.upserted === 7, `重灌后行数 7（删 gone.md -1、增 f.md +1）与新期望一致（实测 ${JSON.stringify(r3.counts)}）`);
assert(countOf("/repo/docs/c.md") === 1 && rowOf("/repo/docs/c.md")?.existence_state === "missing", "同键 (deliverables,/repo/docs/c.md) 新状态覆盖：exists→missing 演进、行数不增（复合主键 UPSERT）");
assert(countOf("/repo/gone.md") === 0, "源删行差集清：gone.md 不残留（精确清域只动本源命名空间）");
assert(rowOf("/repo/docs/f.md")?.existence_state === "exists", "新增 f.md 导入");
assert(listLoss(port, fileA).length === 0 && listLoss(port).length === 1, "重扫按源清旧 loss 再落新账：A 源转净 0 条、B 源重灌同 1 条");
assert(port.query("PRAGMA foreign_key_check").length === 0, "重扫后仍零悬空 FK");

// ---------- 5. 整文件坏 JSON：该源差集清空+落账，其余源照常（范式要点 4） ----------
console.log("坏 JSON 保护:");
writeFileSync(fileA, "{ 这不是 JSON");
utimesSync(fileA, new Date(Date.now() + 20), new Date(Date.now() + 20));
const r4 = importArtifacts(port, sources());
assert(r4.skipped === false, "A 源失效触发重扫");
assert(r4.counts.artifact === 2, "坏 JSON 源全部行随差集清消失（A 命名空间清空），B 源 2 行照常");
const badLoss = listLoss(port, fileA);
assert(badLoss.length === 1 && badLoss[0]?.reason === "bad-json" && badLoss[0]?.lineNo === 1, "坏 JSON 落账恰 1 条（line 1），旧 A 源账清零");
assert(port.query("PRAGMA foreign_key_check").length === 0, "坏源重扫后仍零悬空 FK");

// ---------- 6. 内联源：内容指纹 checkpoint+UPSERT 演进（范式要点 2 变体） ----------
console.log("内联源:");
const inlineRecords = () => [{ path: "/x/inline.md", first_at: T + 50, exists: true }];
const r5a = importArtifacts(port, [{ id: "inline-x", records: inlineRecords() }]);
assert(r5a.skipped === false && r5a.counts.artifact === 3, "内联源首轮导入（artifact 2→3）");
const r5b = importArtifacts(port, [{ id: "inline-x", records: inlineRecords() }]);
assert(r5b.skipped === true && r5b.counts.artifact === 3, "内联源同内容→内容指纹 checkpoint 命中快进（行数不增）");
const r5c = importArtifacts(port, [{ id: "inline-x", records: [{ path: "/x/inline.md", first_at: T + 50, last_at: T + 60, exists: false }] }]);
assert(r5c.skipped === false && r5c.counts.artifact === 3 && rowOf("/x/inline.md")?.existence_state === "missing", "内联源内容变化→UPSERT 同键演进（state exists→missing、行数不增、他源行不受扰）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "内联源重扫后仍零悬空 FK");

port.close();
rmSync(dataDir, { recursive: true, force: true });

console.log(`Import artifact: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
