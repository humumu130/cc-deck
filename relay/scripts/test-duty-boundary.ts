// M11-E2 值守审计边界护栏测试：duty 域与 SQLite/EventType/EventBus 三面隔离。
// 口径：specs/019-pm-duty.md §1/§4.3——「PM_DUTY_ROUND 是独立日志条目，写入
// CCR_DATA_DIR/duty-rounds.ndjson append-only 文件，不进入 EventBus、EventType union
// 或 events.ndjson，不参加业务状态机」；注记件 relay/src/storage/port.ts DUTY-BOUNDARY 段。
// 范式沿用 test-storage-schema（mkdtemp+assert 计数+两轮连跑）。
// 静态面：表清单/事件联合/源码 import/注记在位四扫；运行面：真实开库跑迁移+duty 纯函数
// 全轮，断言 dataDir 零新增文件副作用（open 态内前后清单一致+零 duty 词文件名）。
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceDutyFeed,
  evaluateDutyPolicy,
  evaluateLeaderActionableWork,
  isValidDutyReceipt,
  parseDutyReceipt,
  serializeDutyReceipt,
  transitionDutyFeedCount,
  validateDutyReceipt,
  type DutyQueueSnapshot,
  type DutyReceipt,
} from "../src/leader-duty.js";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { IMPORT_LEDGER_TABLES, migrations, STORAGE_INDEXES, STORAGE_TABLES } from "../src/storage/schema.js";

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const FIXTURE = <T>(name: string): T =>
  JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures", name), "utf8")) as T;

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

function runOnce(round: number): void {
  console.log(`—— 第 ${round} 轮 ——`);

  // ---------- 静态面 1：schema 表/索引/迁移名清单零 duty ----------
  assert(STORAGE_TABLES.length === 15 && STORAGE_TABLES.every((t) => !/duty/i.test(t)),
    "S1 STORAGE_TABLES 15 表零 duty 词");
  assert(IMPORT_LEDGER_TABLES.length === 2 && IMPORT_LEDGER_TABLES.every((t) => !/duty/i.test(t)),
    "S2 IMPORT_LEDGER_TABLES 台账表零 duty 词");
  assert(STORAGE_INDEXES.every((i) => !/duty/i.test(i)), "S3 STORAGE_INDEXES 索引零 duty 词");
  assert(migrations.every((m) => !/duty/i.test(m.name)), "S4 迁移版本名清单零 duty 词");

  // ---------- 静态面 2：types.ts EventType 联合段零 duty 事件词 ----------
  const typesSrc = readFileSync(join(SRC_DIR, "types.ts"), "utf8");
  const etStart = typesSrc.indexOf("export type EventType");
  const etEnd = typesSrc.indexOf(";", etStart);
  const etUnion = etStart >= 0 && etEnd > etStart ? typesSrc.slice(etStart, etEnd) : "";
  assert(etUnion.length > 100 && !/duty/i.test(etUnion),
    "S5 EventType 联合段（" + etUnion.split("\n").length + " 行）零 duty 事件词");

  // ---------- 静态面 3：leader-duty.ts 纯函数面（零 import，强于「不引 event-bus/storage」） ----------
  const dutySrc = readFileSync(join(SRC_DIR, "leader-duty.ts"), "utf8");
  assert(!/^import\s/m.test(dutySrc) && !/require\(/.test(dutySrc),
    "S6 leader-duty.ts 零 import/require（纯函数文件）");
  assert(!/event-bus/.test(dutySrc) && !/from "\.\/storage\//.test(dutySrc),
    "S7 leader-duty.ts 无 event-bus/storage 引用词");

  // ---------- 静态面 4：EventBus 零 duty 出口 + 注记在位 ----------
  const busSrc = readFileSync(join(SRC_DIR, "event-bus.ts"), "utf8");
  assert(!/duty/i.test(busSrc), "S8 event-bus.ts 全文零 duty 词（零出口静态面）");
  const portSrc = readFileSync(join(SRC_DIR, "storage", "port.ts"), "utf8");
  assert(portSrc.includes("DUTY-BOUNDARY") && portSrc.includes("duty-rounds.ndjson")
    && portSrc.includes("零 SQLite 表") && portSrc.includes("零 EventType 注册") && portSrc.includes("零 EventBus 出口"),
    "S9 port.ts DUTY-BOUNDARY 注记段在位（三零+落盘口径）");

  // ---------- 运行面：mkdtemp 开库跑迁移 → duty 纯函数全轮 → 零文件副作用 ----------
  const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-duty-boundary-"));
  try {
    const port = createSqlitePort({ dataDir, filename: "boundary-check.sqlite3" });
    port.open();
    runMigrations(port, migrations);
    const tables = port.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    assert(tables.length === 17 && tables.every((r) => !/duty/i.test(r.name)),
      "R1 库内 17 表（15+2）与冻结件一致且零 duty 表");
    port.close();

    // 纯函数跑轮期间端口已关——副作用断言只认 dataDir 文件清单（duty 无任何落盘授权，
    // 跑轮前后 open→close 已定型的文件集不应再变化）。
    const before = readdirSync(dataDir).sort();
    const snapshot = FIXTURE<DutyQueueSnapshot>("duty-candidates.json");
    const work = evaluateLeaderActionableWork(snapshot);
    assert(work.actionable === true && work.reason === "actionable" && work.candidates.length === 4,
      "R2 duty 纯函数跑轮：候选快照四类判定正常");
    let feed = transitionDutyFeedCount({ consecutive_feeds: 0 }, "feed");
    feed = advanceDutyFeed(feed.state, "feed");
    feed = advanceDutyFeed(feed.state, "feed");
    assert(feed.state.consecutive_feeds === 3 && feed.shouldSleep === true
      && feed.continuation?.wake_once === true, "R3 duty 纯函数跑轮：K=3 sleep+continuation 正常");
    const receipt = FIXTURE<DutyReceipt>("duty-receipt.json");
    const parsed = parseDutyReceipt(serializeDutyReceipt(receipt));
    assert(parsed !== null && isValidDutyReceipt(parsed) && validateDutyReceipt(receipt).ok,
      "R4 duty 纯函数跑轮：回执序列化/解析/校验正常");
    assert(evaluateDutyPolicy(work.candidates[0]!, { auto_dispatch_enabled: false }).mode === "allow",
      "R5 duty 纯函数跑轮：策略决策面正常");
    const after = readdirSync(dataDir).sort();
    assert(before.length > 0 && before.join("|") === after.join("|"),
      "R6 纯函数全轮后 dataDir 文件清单零变化（" + before.length + " 文件）");
    assert(after.every((f) => !/duty/i.test(f)), "R7 dataDir 零 duty 词文件（duty-rounds.ndjson 未被创建）");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// 两轮连跑（范式纪律：第二轮在全新 mkdtemp 上复跑全部断言）。
runOnce(1);
runOnce(2);
console.log(`duty boundary: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
process.exit(0);
