// dispatchappend（t-a5e9f79e，P0）：dispatch-log append-only 增量续读契约锁。
//   病灶：import-dispatch-lesson 的 dispatch-log checkpoint 走严格匹配（mtime/lineCount
//   任变即 null）——派单台账唯一写者是 append 模式（org.ts writeFileSync flag:"a"），
//   每次 append lineCount 必变 → 失效 → replay 清 dispatch+lesson 两域全量重灌
//   （生产 1.1MB/3k+ 行，运行期每 append 烧一次 = relay 振荡，1105 实产 PM 实锤）。
//   修 = 对照 events 段 F2 先例（sqlitefix-R1）给 readCheckpoint 传 { appendOnly: true }：
//   行数纯增长 → 旧 offset 仍有效 → 增量续读（不清域）；缩减 → 全量重放兜底。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const row = (i: number): string => JSON.stringify({ ts: 1700000000000 + i, id: "d" + i, tier: "正经立项", status: "done", receipt: null }) + "\n";

async function main(): Promise<void> {
  console.log("A. 源码锚：appendOnly 第五参在场+events F2 先例不回归");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/storage/import-dispatch-lesson.ts", import.meta.url), "utf8");
    assert(src.includes(`readCheckpoint(port, sources.dispatchLogFile, { ...current, mtimeMs: obsLog.mtimeMs, lineCount: obsLog.lineCount }, { appendOnly: true })`), "dispatch-log readCheckpoint 带 appendOnly（增量续读——严格匹配=每 append 清域重灌的振荡根）");
    const st = readFileSync(new URL("../src/storage/import-session-task.ts", import.meta.url), "utf8");
    assert(st.includes("{ appendOnly: true }"), "events 段 F2 先例在位（不回归）");
    // boards 源保持严格（目录级语义——文件可增可删可改，无 append 契约）
    assert(!/readCheckpoint\(port, sources\.boardsDir[^\n]*appendOnly/.test(src), "boards 源保持严格匹配（目录级语义不放宽）");
  }

  console.log("B. 行为：append → 增量续读（不清域）；缩减 → replay 兜底");
  {
    const { importDispatchLesson } = await import("../src/storage/import-dispatch-lesson.js");
    const { createSqlitePort } = await import("../src/storage/sqlite.js");
    const { runMigrations } = await import("../src/storage/migrator.js");
    const { migrations } = await import("../src/storage/schema.js");
    const root = mkdtempSync(join(tmpdir(), "dispatchappend-"));
    const dataDir = join(root, "data");
    const orgDir = join(root, "org");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(orgDir, { recursive: true });
    const logFile = join(orgDir, "dispatch-log.ndjson");
    const boardsDir = join(orgDir, "boards");
    mkdirSync(boardsDir, { recursive: true });
    try {
      // 造板文件（lesson 源——带 lessons 块喂 lesson 域，验证 dispatch append 不联动清 lesson）
      writeFileSync(join(boardsDir, "b1.json"), JSON.stringify({
        name: "cc-deck", frozen: false, entries: [], updated_at: 1700000000000,
        lessons: [{ text: "l1", ts: 1700000000000, source: "test" }],
      }), "utf8");
      // 造台账 500 行（首轮全量建基线）
      let chunk = "";
      for (let i = 0; i < 500; i++) chunk += row(i);
      writeFileSync(logFile, chunk, "utf8");

      const port = createSqlitePort({ dataDir });
      port.open();
      runMigrations(port, migrations);
      const n = (sql: string): number => port.query<{ n: number }>(sql)[0]?.n ?? -1;
      const r1 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir });
      assert(n("SELECT COUNT(*) AS n FROM dispatch") === 500 && r1.counts.dispatch === 500, `首轮全量导入（dispatch=${r1.counts.dispatch}——建基线）`);
      const lessonAfter1 = n("SELECT COUNT(*) AS n FROM lesson");
      assert(lessonAfter1 === 0, `lesson 停灌语义保持（W-EXPP1：lesson 段 no-op 恒空投影——板文件 lessons 不入表，${lessonAfter1} 行）`);

      // append 500 行（纯追加——唯一写者 org.ts flag:"a" 形态）
      let appendChunk = "";
      for (let i = 500; i < 1000; i++) appendChunk += row(i);
      appendFileSync(logFile, appendChunk, "utf8");
      const r2 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir });
      const d2 = n("SELECT COUNT(*) AS n FROM dispatch");
      assert(r2.skipped === false && r2.dispatchProcessed === 500, `**振荡根除**：append 后增量续读（dispatchProcessed=${r2.dispatchProcessed}——只灌新 500 行，修前 replay 全清 0→重灌 1000）`);
      assert(d2 === 1000, `行数如实（500→${d2}）`);
      assert(n("SELECT COUNT(*) AS n FROM lesson") === lessonAfter1, `lesson 域不被联动清（${lessonAfter1} 行不变——dispatch cpLog 有效=域失效不触发）`);

      // 双未变 → 快进（skipped）
      const r3 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir });
      assert(r3.skipped === true, "双未变 → skipped 快进（幂等保持）");

      // 缩减兜底（truncate 到 300 行——前缀已变 → null → replay 清域重灌）
      let shortChunk = "";
      for (let i = 0; i < 300; i++) shortChunk += row(i);
      writeFileSync(logFile, shortChunk, "utf8");
      const r4 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir });
      const d4 = n("SELECT COUNT(*) AS n FROM dispatch");
      assert(d4 === 300 && r4.dispatchProcessed === 300, `缩减兜底 replay（${d4} 行全量重放——前缀已变时正确性优先于增量）`);
      assert(n("SELECT COUNT(*) AS n FROM lesson") === lessonAfter1, `replay 后 lesson 随 boards 重灌恢复（${lessonAfter1} 行）`);

      port.close?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("C. 生产振荡链路锚（org 写口 append 模式=前缀不变契约的写者侧铁证）");
  {
    const { readFileSync } = await import("node:fs");
    const org = readFileSync(new URL("../src/org.ts", import.meta.url), "utf8");
    assert(org.includes(`writeFileSync(dispatchLogPath(d), JSON.stringify(e) + "\\n", { flag: "a" })`), "org.ts 派单台账唯一写者=append 模式（flag:\"a\"——前缀不变契约成立的前提）");
  }

  console.log(`\n========== dispatchappend 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
