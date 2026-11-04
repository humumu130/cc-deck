// dispatchbomb（t-5bdf04e3，1105 sqlitefix 验收审猎获）：大源清域炸弹排雷契约锁。
//   病灶：dispatch-log.ndjson >2MB（SIZE_MEMO_MAX_BYTES）双未变短路时 statThenRead 返回
//   unchanged+空 text+基线 lineCount——import-dispatch-lesson 的 observeNdjson 无 unchanged
//   分支，split("") → lines=[] 且 lineCount=0（丢基线）→ checkpoint 失配 → replay 清
//   dispatch/lesson 全域+灌 0 行+写 0/0。生产 1.1MB 逼近触发线，越线即清空。
//   修=对照 session-task 版补 unchanged 分支（lineCount 取基线、lines=[]——快进不清域）。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main(): Promise<void> {
  console.log("A. 源码锚：unchanged 分支在位（对齐 session-task 先例）");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/storage/import-dispatch-lesson.ts", import.meta.url), "utf8");
    assert(src.includes("obs.unchanged === true") && src.includes("lineCount: obs.lineCount ?? 0"), "observeNdjson unchanged 分支（lineCount 取基线——丢基线=清域炸弹根）");
    const st = readFileSync(new URL("../src/storage/import-session-task.ts", import.meta.url), "utf8");
    assert(st.includes("obs.unchanged === true"), "session-task 先例在位（不回归）");
  }

  console.log("B. 行为：>2MB 双未变 → 快进不清域（全域行数不变）");
  {
    const { ensureStore } = await import("../src/storage/read-mode.js");
    const { importDispatchLesson } = await import("../src/storage/import-dispatch-lesson.js");
    const { createSqlitePort } = await import("../src/storage/sqlite.js");
    const { runMigrations } = await import("../src/storage/migrator.js");
    const { migrations } = await import("../src/storage/schema.js");
    const root = mkdtempSync(join(tmpdir(), "dispatchbomb-"));
    const dataDir = join(root, "data");
    const orgDir = join(root, "org");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(orgDir, { recursive: true });
    const logFile = join(orgDir, "dispatch-log.ndjson");
    try {
      // 造 >2MB 台账（真实行——首见建基线走全文读）
      const row = (i: number) => JSON.stringify({ ts: 1700000000000 + i, id: "d" + i, tier: "正经立项", status: "done", receipt: null }); // DispatchLine 契约（ts/id/tier/status 必备）
      let chunk = "";
      for (let i = 0; chunk.length < 2.2 * 1024 * 1024; i++) chunk += row(i) + "\n";
      writeFileSync(logFile, chunk, "utf8");

      const port = createSqlitePort({ dataDir });
      port.open();
      runMigrations(port, migrations);
      const r1 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: join(orgDir, "boards") });
      const n = (sql: string): number => port.query<{ n: number }>(sql)[0]?.n ?? -1;
      const count1 = n("SELECT COUNT(*) AS n FROM dispatch");
      assert(count1 > 1000, `首轮全量导入（${count1} 行——大源首见全文读建基线）`);
      assert(r1.counts.dispatch === count1, `导入计数如实（${r1.counts.dispatch}）`);

      // 第二轮：同文件（双未变）——大源短路路径（LARGE_SHORTCIRC 命中 → unchanged:true）
      const r2 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: join(orgDir, "boards") });
      const count2 = n("SELECT COUNT(*) AS n FROM dispatch");
      assert(r2.skipped === true, `二轮双未变→skipped 快进（实 skipped=${r2.skipped}——unchanged 分支 lineCount 取基线）`);
      assert(count2 === count1, `**清域炸弹根除**：全域行数不变（${count1}→${count2}——修前此处被清为 0）`);

      // 真 append（变更）→ 正常增量
      appendFileSync(logFile, row(999999) + "\n", "utf8");
      const r3 = importDispatchLesson(port, { dispatchLogFile: logFile, boardsDir: join(orgDir, "boards") });
      const count3 = n("SELECT COUNT(*) AS n FROM dispatch");
      assert(count3 > count2, `真变更（append）正常增量导入（${count2}→${count3}——短路不误伤变更路径）`);

      port.close?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("C. 与 sqlitefix 域缓存/签名衔接面（短路不误伤）");
  {
    const { readFileSync } = await import("node:fs");
    const rm = readFileSync(new URL("../src/storage/read-mode.ts", import.meta.url), "utf8");
    // 签名层（shadowSourcesSig）走 statSigOf（stat mtime/size）——与 statThenRead 短路层
    // 正交：大源双未变 → 签名不变 → ensureStore 短路（不进 importer）；真变更 → 签名变
    // → ensureStore 失配 → scheduleShadowImport → importer 走全文/unchanged 分支。
    assert(rm.includes("dispatch-log.ndjson") && rm.includes("statSigOf"), "签名层 dispatch-log 精确 stat 在位（与短路层正交——签名先拦，importer 兜底）");
    const idl = readFileSync(new URL("../src/storage/import-dispatch-lesson.ts", import.meta.url), "utf8");
    assert(idl.indexOf("obs.unchanged === true") < idl.indexOf("const lines = obs.text.split"), "unchanged 分支先于 split（短路先行——空 text 永不进 split）");
  }

  console.log(`\n========== dispatchbomb 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
