// M11-F1 验收域导入测试：fixture 驱动（自制 acceptances 目录，零生产触达）。
// 范式沿用导入线四件（mkdtemp+env 全清+assert 计数+两轮一致）；组织域前置 C1 importOrg
// （group 归因链依赖）。断言面（对应验收点 1-5）：
//   A 四面全字段映射：sheet 全列（task_id NULL/group_id 归因/title/created_at/sheet_key 保留）、
//     item（数组序→item_index 1-based）、result（history 展开+actor←ua+verdict 词表）。
//   B 缺归因 NULL+missing-attribution 对号；FK 拒对照（悬空 item_id/sheet_id 硬塞被拒）。
//   C 重复 history 不折叠：同 item 两条历史 verdict 全保留多行（vs E1 当前态折叠——备案区分）。
//   D 坏件不阻断：坏 JSON sheet/非 32hex id/孤儿 results 存在，合法 sheet 照常导入。
//   E 幂等重跑快进行数不增；失效重扫（sheet 变更）域清重灌不残留。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importOrg } from "../src/storage/import-org.js";
import { importAcceptance, ACCEPTANCE_IMPORT_SCHEMA_VERSION, IMPORT_ACTOR } from "../src/storage/import-acceptance.js";
import { writeCheckpoint } from "../src/storage/checkpoint.js";
import { listLoss } from "../src/storage/loss-report.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---------- 0. 启动前纪律 ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-f1-"));
process.env.CCR_DATA_DIR = dataDir;
const orgDir = join(dataDir, "org");
process.env.CCR_ORG_DIR = orgDir;
console.log("临时目录纪律:");
assert(process.env.CCR_DATA_DIR === dataDir && process.env.CCR_ORG_DIR === orgDir, "CCR_DATA_DIR/CCR_ORG_DIR 均指向临时目录");
assert(dataDir.startsWith(tmpdir()) && orgDir.startsWith(tmpdir()), "两 env 落 tmpdir 前缀下");
assert(!existsSync(join(process.env.HOME ?? "", ".cc-deck", "cc-deck.sqlite3")), "生产目录无本测试库文件（未触碰 ~/.cc-deck）");

// ---------- fixture ----------
const acceptDir = join(dataDir, "acceptances");
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccccccccccccccc";
const D = "dddddddddddddddddddddddddddddddd";
const E = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function writeFixtures(): void {
  mkdirSync(acceptDir, { recursive: true });
  // sheet A：全字段 + 归因命中（cwd=/fx/proj-a → g1）
  writeFileSync(join(acceptDir, `${A}.json`), JSON.stringify({
    id: A, title: "验收单甲", created_at: 1000, cwd: "/fx/proj-a",
    preface: ["前言段"], notes: ["备注段"], // DDL 无列丢弃面
    sheet_key: "1234567890abcdef1234567890abcdef",
    rows: [
      { task: "#1①", item: "项一", criteria: "点开可见" },
      { task: "#1②", item: "项二", criteria: "点击生效" },
      { task: "#1③", item: "项三", criteria: "无报错" },
    ],
  }));
  // sheet B：无 cwd → 归因 NULL+loss
  writeFileSync(join(acceptDir, `${B}.json`), JSON.stringify({
    id: B, title: "验收单乙", created_at: 1001,
    rows: [
      { task: "#2①", item: "项一", criteria: "c1" },
      { task: "#2②", item: "项二", criteria: "c2" },
    ],
  }));
  // sheet C：cwd 匹配不上 → 归因 NULL+loss
  writeFileSync(join(acceptDir, `${C}.json`), JSON.stringify({
    id: C, title: "验收单丙", created_at: 1002, cwd: "/fx/nowhere",
    rows: [{ task: "#3①", item: "项一", criteria: "c3" }],
  }));
  // 坏 JSON sheet（文件名合法 32hex）
  writeFileSync(join(acceptDir, `${D}.json`), "{bad json");
  // 非 32hex id 文件（线上 ACCEPTANCE_ID_RE 同词表拒入）
  writeFileSync(join(acceptDir, "nonhexid.json"), JSON.stringify({ id: "nonhexid", title: "野单", created_at: 1003, rows: [] }));
  // A 的 results：history 2 条（不折叠核心例：item1 两条历史 verdict pass→fail）
  writeFileSync(join(acceptDir, `${A}.results.json`), JSON.stringify({
    id: A,
    history: [
      { at: 2000, ua: "UA-1", rows: [
        { i: 0, verdict: "pass", note: "ok" },
        { i: 1, verdict: "fail", note: "no" },
        { i: 2, verdict: null, note: "未测" },
      ] },
      { at: 3000, ua: "UA-2", rows: [
        { i: 0, verdict: "fail", note: "改判" },
        { i: 5, verdict: "pass", note: "" },     // 越界悬空拒行
        { i: 1, verdict: "maybe", note: "x" },   // 词表外拒行
      ] },
    ],
  }));
  // B 的 results：ua 缺失 → 迁移批 actor
  writeFileSync(join(acceptDir, `${B}.results.json`), JSON.stringify({
    id: B,
    history: [{ at: 2500, rows: [{ i: 0, verdict: "pass", note: "" }] }],
  }));
  // C 的 results：对应 sheet 是坏 JSON 未导入 → 孤儿 results 落账跳全文件
  writeFileSync(join(acceptDir, `${C}.results.json`), JSON.stringify({
    id: C, history: [{ at: 2600, ua: "UA-3", rows: [{ i: 0, verdict: "pass", note: "" }] }],
  }));
  // E 的 results：完全无对应 sheet 文件 → 孤儿
  writeFileSync(join(acceptDir, `${E}.results.json`), JSON.stringify({
    id: E, history: [{ at: 2700, ua: "UA-4", rows: [{ i: 0, verdict: "pass", note: "" }] }],
  }));
  // C1 org fixture（group 归因链依赖）
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(orgDir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "lead-sess", created_at: 1000 }));
  writeFileSync(join(orgDir, "projects.json"), JSON.stringify({
    groups: [{ id: "g1", name: "grp-a", anchor_dir: "/fx/proj-a", status: "active", tier: "正经立项", single_card: false, headcount: [], created_at: 1000, updated_at: 1000 }],
  }));
  writeFileSync(join(orgDir, "confirms.json"), "[]");
}
writeFixtures();

const port: StoragePort = createSqlitePort({ dataDir, filename: "f1.sqlite3" });
port.open();
runMigrations(port, migrations);
const orgResult = importOrg(port, orgDir);
assert(orgResult.counts.group === 1, "前置：C1 组织域 fixture 导入（1 组）");

// ---------- A. 全量首跑：四面全字段映射 ----------
console.log("全量首跑:");
const r1 = importAcceptance(port, acceptDir);
assert(r1.skipped === false, "首跑非快进");
assert(r1.counts.sheet === 3, `sheet 3 行（A/B/C 合法；坏 JSON+非 32hex 拒入，实际 ${r1.counts.sheet}）`);
assert(r1.counts.item === 6, `item 6 行（A3+B2+C1，实际 ${r1.counts.item}）`);
assert(r1.counts.result === 6, `result 6 行（A history 4 合法+B 1+C results 配对导入 1，实际 ${r1.counts.result}）`);

const sa = port.query<Record<string, unknown>>("SELECT * FROM acceptance_sheet WHERE id = ?", [A])[0];
assert(sa !== undefined && sa.task_id === null && sa.group_id === "g1", "sheet A：task_id NULL（源无 task 关联）+group_id 归因命中 g1");
assert(sa?.title === "验收单甲" && sa?.created_at === 1000, "sheet A：title/created_at 原值入列");
assert(sa?.sheet_key === "1234567890abcdef1234567890abcdef", "sheet A：sheet_key 保留原值（冻结件口径）");
const it1 = port.query<Record<string, unknown>>(
  "SELECT * FROM acceptance_item WHERE sheet_id = ? AND item_index = 1", [A])[0];
assert(it1 !== undefined && it1.task === "#1①" && it1.item === "项一" && it1.criteria === "点开可见", "item A/1：数组序→item_index=1（1-based）+三串全列");
const idxs = port.query<{ item_index: number }>("SELECT item_index FROM acceptance_item WHERE sheet_id = ? ORDER BY item_index", [B]).map((r) => r.item_index);
assert(JSON.stringify(idxs) === "[1,2]", "item B：数组顺序成为 item_index（1,2 连续）");

const ra_h0 = port.query<Record<string, unknown>>(
  "SELECT * FROM acceptance_result WHERE item_id = ? AND created_at = 2000", [String(it1?.id)])[0];
assert(ra_h0 !== undefined && ra_h0.verdict === "pass" && ra_h0.note === "ok" && ra_h0.actor === "UA-1",
  "result A/1@h0：verdict/note/actor←ua 全列");
const ra_h1 = port.query<Record<string, unknown>>(
  "SELECT * FROM acceptance_result WHERE item_id = ? AND created_at = 3000", [String(it1?.id)])[0];
assert(ra_h1 !== undefined && ra_h1.verdict === "fail" && ra_h1.actor === "UA-2", "result A/1@h1：改判历史独立成行");
const itb1 = port.query<Record<string, unknown>>(
  "SELECT * FROM acceptance_item WHERE sheet_id = ? AND item_index = 1", [B])[0];
const rb = port.query<Record<string, unknown>>(
  "SELECT * FROM acceptance_result WHERE item_id = ?", [String(itb1?.id)])[0];
assert(rb !== undefined && rb.actor === IMPORT_ACTOR, "result B/1：ua 缺失→迁移批 actor 兜底");
const rnull = port.query<Record<string, unknown>>(
  "SELECT * FROM acceptance_result WHERE item_id = ? AND created_at = 2000",
  [String(port.query<Record<string, unknown>>("SELECT id FROM acceptance_item WHERE sheet_id = ? AND item_index = 3", [A])[0]?.id)])[0];
assert(rnull !== undefined && rnull.verdict === null && rnull.note === "未测", "result A/3：verdict NULL（未测）合法落列");

// ---------- B. 缺归因 loss 对号 + FK 拒对照 ----------
console.log("缺归因与 FK:");
const lossA = listLoss(port, acceptDir);
const missAttr = lossA.filter((l) => l.reason === "missing-attribution");
assert(missAttr.length === 2 && missAttr.every((l) => [B, C].some((id) => (l.excerpt as string).includes(id))),
  "缺归因两账 missing-attribution 对号（B 无 cwd / C cwd 不匹配）");
const sb = port.query<Record<string, unknown>>("SELECT group_id FROM acceptance_sheet WHERE id = ?", [B])[0];
const sc = port.query<Record<string, unknown>>("SELECT group_id FROM acceptance_sheet WHERE id = ?", [C])[0];
assert(sb?.group_id === null && sc?.group_id === null, "缺归因 sheet 的 group_id 均 NULL（零造关联）");
let fkThrow = false;
try { port.exec(`INSERT INTO acceptance_item (id, sheet_id, item_index, task, item, criteria) VALUES ('x','no-such-sheet',1,'t','i','c')`); } catch { fkThrow = true; }
assert(fkThrow, "FK 对照：硬塞悬空 sheet_id 的 item 被拒（NULL 是唯一正解）");
fkThrow = false;
try { port.exec("INSERT INTO acceptance_result (id, item_id, actor, created_at) VALUES ('y','no-such-item','a',1)"); } catch { fkThrow = true; }
assert(fkThrow, "FK 对照：硬塞悬空 item_id 的 result 被拒");

// ---------- loss 全对账 ----------
assert(lossA.length === 7, `loss 恰 7 条（实际 ${lossA.length}）`);
assert(lossA.filter((l) => l.reason === "bad-json").length === 1, "坏 JSON sheet 一账");
assert(lossA.some((l) => l.reason === "bad-field" && (l.excerpt as string).includes("nonhexid")), "非 32hex id 拒入落账（线上同词表）");
assert(lossA.filter((l) => l.reason === "dangling-ref").length === 2, "悬空两账（越界 i=5 拒行 / 孤儿 results E 无对应 sheet）");
assert(lossA.some((l) => l.reason === "bad-field" && (l.excerpt as string).includes("maybe")), "verdict 词表外（maybe）拒行落账");
const rc = port.query<Record<string, unknown>>(
  "SELECT r.verdict, r.actor FROM acceptance_result r JOIN acceptance_item i ON r.item_id = i.id WHERE i.sheet_id = ?",
  [C])[0];
assert(rc !== undefined && rc.verdict === "pass" && rc.actor === "UA-3", "C 的 results 正常配对导入（cwd 归因 NULL 不影响 results 挂靠）");

// ---------- C. 重复 history 不折叠 ----------
console.log("history 不折叠:");
const it1Id = String(it1?.id);
const histCount = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM acceptance_result WHERE item_id = ?", [it1Id])[0]?.n ?? -1;
assert(histCount === 2, `同 item 两条历史全保留（pass@2000+fail@3000，实际 ${histCount}）——不折叠`);
const batchCount = port.query<{ n: number }>("SELECT COUNT(DISTINCT created_at) AS n FROM acceptance_result WHERE item_id = ?", [it1Id])[0]?.n ?? -1;
assert(batchCount === 2, `两批次时间戳并存（${batchCount} 批）——批次事实流非当前态覆盖`);

// ---------- D. 坏件不阻断（A 面已证 3 sheet 导入成功，此处补断言坏件清单） ----------
console.log("坏件不阻断:");
assert(r1.counts.sheet === 3 && lossA.filter((l) => ["bad-json", "bad-field", "dangling-ref"].includes(l.reason)).length === 5,
  "坏件 5 账在案且合法 3 sheet 全导（不阻断）");

// ---------- E. 幂等重跑 + 失效重扫 ----------
console.log("幂等与失效重扫:");
const r2 = importAcceptance(port, acceptDir);
assert(r2.skipped === true && r2.rescanned.length === 0, "checkpoint 命中→快进零写入");
assert(r2.counts.sheet === 3 && r2.counts.item === 6 && r2.counts.result === 6, "快进后行数不增（3/6/6）");
assert(listLoss(port, acceptDir).length === 7, "快进后 loss 不增（仍 7）");

writeFileSync(join(acceptDir, `${B}.json`), JSON.stringify({
  id: B, title: "验收单乙改", created_at: 1001,
  rows: [
    { task: "#2①", item: "项一", criteria: "c1" },
    { task: "#2②", item: "项二", criteria: "c2" },
  ],
}));
const bFile = join(acceptDir, `${B}.json`);
utimesSync(bFile, new Date(statSync(bFile).mtimeMs + 10), new Date(statSync(bFile).mtimeMs + 10)); // APFS 同毫秒保护
const r3 = importAcceptance(port, acceptDir);
assert(r3.skipped === false && r3.rescanned.length === 1, "sheet 变更→域清重灌");
assert(r3.counts.sheet === 3 && r3.counts.item === 6 && r3.counts.result === 6, "重灌后行数不增（防残留面）");
const sb2 = port.query<Record<string, unknown>>("SELECT title FROM acceptance_sheet WHERE id = ?", [B])[0];
assert(sb2?.title === "验收单乙改", "重灌采新内容（title 更新）");
assert(listLoss(port, acceptDir).length === 7, "重灌后旧账清零重落不重复（仍 7）");
const cp3 = port.query<{ line_offset: number }>("SELECT line_offset FROM import_checkpoint WHERE path = ?", [acceptDir])[0];
assert(cp3 !== undefined, "重灌后 checkpoint 已回写");
void cp3;
void ACCEPTANCE_IMPORT_SCHEMA_VERSION;

port.close();
rmSync(dataDir, { recursive: true, force: true });

console.log(`Import acceptance: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
