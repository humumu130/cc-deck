// sqlitefix（t-bc3e9e2a，P0·test.97 撤回根修）：影子导入堵事件循环契约锁。
//   病灶：ensureStore 缓存命中分支恒跑 importAllForShadow（observe 全文读+sqlite 投影
//   查询秒级）×三定时器周期摸=readDispatchLog 热路径打爆事件循环（全 URL 8s/请求，
//   1104 用户实锤启动 1-2min+断连难重连）。修=stat 源签名短路+dispatch 域级缓存+三定时器错峰。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

async function main(): Promise<void> {
  const rm = srcOf("../src/storage/read-mode.ts");
  const org = srcOf("../src/org.ts");
  const patrol = srcOf("../src/patrol.ts");
  const sm = srcOf("../src/session-manager.ts");
  const wf = srcOf("../src/watch-feed.ts");

  console.log("A. 根治层源码锚（ensureStore 签名短路）");
  {
    assert(rm.includes("function shadowSourcesSig(dirs: ReadModeDirs): string") && rm.includes("const shadowSigCache = new Map<string, string>()"), "源签名函数+缓存 Map 在场（stat-only 零 sqlite 零全文读）");
    const i = rm.indexOf("export function ensureStore");
    const seg = rm.slice(i, i + 1200);
    assert(seg.includes("shadowSigCache.get(dirs.dataDir) === sig") && seg.includes("return cached;"), "命中分支签名短路（未变直接回缓存端口——读路径零同步导入）");
    assert(!seg.includes("importAllForShadow(cached, dirs); // 铁律"), "原「恒跑导入」行退役（铁律 3 语义保留：源变才跑——注释自证）");
    assert(rm.includes('org.json", "projects.json", "confirms.json", "dispatch-log.ndjson", "boards-journal.ndjson"') && rm.includes('"events.ndjson"') && rm.includes('"deliverables.json"'), "签名源全拼（七域 importer 源：org 三源+dlog+journal+events+deliverables）");
    assert(rm.includes('dirFiles(join(dirs.orgDir, "boards"), ".json")') && rm.includes('dirFiles(join(dirs.dataDir, "acceptances"), ".json")') && rm.includes("dirFiles(dirs.tasksDir"), "目录型源逐文件 stat（目录 mtime 不随子文件内容变——浅扫保真）");
    assert(rm.includes("超 50ms 观测闸"), "导入快进 50ms 观测闸（真变更导入超时打点——可观测性）");
  }

  console.log("B. dispatch 域级缓存（全表 SELECT 只在真变更后跑）");
  {
    assert(rm.includes("export function readDispatchFromDbCached") && rm.includes("dispatchEntriesFromDb(port, 1_000_000)"), "域缓存函数在场（全表拉取一次+签名命中回缓存行）");
    assert(org.includes("readDispatchFromDbCached(port, d)") && org.includes("rows.length > max ? rows.slice(-max) : rows"), "readDispatchLog sqlite 档接域缓存（出口 slice 语义与「最后 max 条」同源）");
    const recall = srcOf("../src/recall.ts");
    assert(recall.includes("readDispatchLogFile"), "先例锚：recall.ts 文件直读保持（chainrecall R1 650× 在位不回归）");
    const prc = srcOf("../src/pr-comment-trigger.ts");
    assert(prc.includes("readDispatchLogFile"), "pr-comment-trigger 文件直读保持（prbackflow 批在位）");
  }

  console.log("C. 三定时器错峰（0s/20s/40s 相位——同拍共振消除）");
  {
    assert(patrol.includes("错峰 1/3") && patrol.includes("首拍相位 0s"), "patrol 相位 0s（注释锚——原相位保留）");
    const flat = (x: string): string => x.replace(/\s+/g, " ");
    assert(sm.includes("错峰 3/3") && flat(sm).includes("setTimeout(() => { if (this.prCommentTimer) void this.runPrCommentCycleOnce(); }, 20_000)"), "pr-comment 首拍 20s 错峰（相位实锚——setTimeout 源码串）");
    assert(wf.includes("错峰 2/3") && flat(wf).includes("}, 40_000)") && flat(wf).includes("if (this.timer) return; // 等待期被 stop 即不再起"), "watch-feed 首拍 40s 错峰（相位实锚+stop 等待窗保护）");
  }

  console.log("D. 行为验证（真 sqlite 档：短路耗时+失配重导入+域缓存同引用）");
  {
    const { ensureStore, readDispatchFromDbCached } = await import("../src/storage/read-mode.js");
    const root = mkdtempSync(join(tmpdir(), "sqlitefix-"));
    const dataDir = join(root, "data");
    const orgDir = join(root, "org");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(orgDir, { recursive: true });
    mkdirSync(join(orgDir, "boards"), { recursive: true });
    writeFileSync(join(orgDir, "org.json"), JSON.stringify({ schema: 1, groups: [{ id: "g1", name: "短路验", status: "active", tier: "正经立项" }] }), "utf-8");
    writeFileSync(join(orgDir, "projects.json"), "[]", "utf-8");
    writeFileSync(join(orgDir, "confirms.json"), "[]", "utf-8");
    writeFileSync(join(dataDir, "events.ndjson"), "", "utf-8");
    writeFileSync(join(orgDir, "dispatch-log.ndjson"), "", "utf-8"); // D 组域缓存失配用例要 touch
    try {
      const t0 = Date.now();
      const port = ensureStore({ dataDir, orgDir, tasksDir: join(dataDir, "tasks") });
      const firstMs = Date.now() - t0;
      assert(firstMs < 10_000, `首建导入完成（${firstMs}ms——含 open+migrate+七域灌）`);
      // 命中短路：源未变第二轮应显著快于首建（签名 stat ~<50ms 级）
      const t1 = Date.now();
      ensureStore({ dataDir, orgDir, tasksDir: join(dataDir, "tasks") });
      const secondMs = Date.now() - t1;
      assert(secondMs < Math.max(50, firstMs / 5), `命中短路快（第二轮 ${secondMs}ms（首建 ${firstMs}ms）——读路径零同步导入）`);
      // 失配重导入：touch org.json（mtime 变）→ 第三轮真跑导入（语义保持）
      const orgJson = join(orgDir, "org.json");
      const now = new Date();
      utimesSync(orgJson, now, new Date(now.getTime() + 1000));
      const t2 = Date.now();
      ensureStore({ dataDir, orgDir, tasksDir: join(dataDir, "tasks") });
      const thirdMs = Date.now() - t2;
      assert(thirdMs >= secondMs, `源变失配重导入（第三轮 ${thirdMs}ms ≥ 短路 ${secondMs}ms——新鲜度语义不破）`);
      // dispatch 域缓存：两轮同引用（未变更）；变更后新引用
      const r1 = readDispatchFromDbCached(port, { dataDir, orgDir });
      const r2 = readDispatchFromDbCached(port, { dataDir, orgDir });
      assert(r1 === r2, "域缓存签名未变回同引用（全表 SELECT 零重跑）");
      utimesSync(join(orgDir, "dispatch-log.ndjson"), now, new Date(now.getTime() + 2000));
      const r3 = readDispatchFromDbCached(port, { dataDir, orgDir });
      assert(r3 !== r1, "dispatch-log 变更后缓存失效重查（写侧 append→mtime 变→新行可见）");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("E. 热路径清单锚（任务书要求④——每处有归宿，详表在回执）");
  {
    assert(patrol.includes("readDispatchLog(orgDir(), 2000)"), "patrol:351 走 readDispatchLog=org.ts 域缓存版（等效缓存法——sqlite 档已零全表）");
    assert(!patrol.includes("viaReadMode"), "patrol 无直接 viaReadMode 面（grep 0——经 org.ts 单口）");
  }

  console.log(`\n========== sqlitefix 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
