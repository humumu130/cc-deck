// sqlitefix（t-bc3e9e2a，1104 P0·test.97 撤回根修）：事件循环堵死复现/对照脚本。
//   用法：CCR_ORG_DIR=/tmp/sf-bench-org CCR_DATA_DIR=/tmp/sf-bench-data CCR_STORAGE_READ_MODE=sqlite \
//         node --import tsx/esm scripts/bench-sqlitefix.ts [--gen]
//   --gen：首次造数据集（dispatch-log 20k 行 + events.ndjson 5k 行——复现生产量级台账）。
//   输出：ensureStore 首建 / 二次调用（缓存命中——修复前=同步七域聚合·修复后=签名短路）/
//   源变更后三次调用 / readDispatchLog sqlite 档二次读 的逐次毫秒——修复树 vs 基线
//  （git stash 后同跑）对照即验收 ① 的单元级证据；全 URL p99 见回执（真 relay 压测）。
import { mkdirSync, appendFileSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

const ORG = process.env.CCR_ORG_DIR ?? "/tmp/sf-bench-org";
const DATA = process.env.CCR_DATA_DIR ?? "/tmp/sf-bench-data";
const gen = process.argv.includes("--gen");

if (gen) {
  mkdirSync(ORG, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(join(ORG, "boards"), { recursive: true });
  writeFileSync(join(ORG, "org.json"), JSON.stringify({ version: 1 }));
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g1", name: "bench 团", anchor_dir: "/tmp/sf", status: "active", tier: "正经立项", created_at: Date.now(), updated_at: Date.now(), headcount: [], role_defaults: {} }] }));
  writeFileSync(join(ORG, "confirms.json"), JSON.stringify({ pending: [] }));
  writeFileSync(join(DATA, "deliverables.json"), JSON.stringify({ items: [] }));
  writeFileSync(join(DATA, "notifications.json"), JSON.stringify({ items: [] }));
  writeFileSync(join(DATA, "decision-notifications.json"), JSON.stringify({ items: [] }));
  // dispatch-log 20k 行（生产量级台账——PM 定罪的 sqlite 全表扫描对象）
  if (!existsSync(join(ORG, "dispatch-log.ndjson"))) {
    const rows: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      rows.push(JSON.stringify({ id: "d" + i, tier: "正经立项", stage: "claim", title: "台账行" + i, body: "bench", created_at: Date.now() - (20_000 - i) * 1000, updated_at: Date.now() - (20_000 - i) * 1000, status: i % 3 === 0 ? "done" : i % 3 === 1 ? "running" : "dispatched", target_member_id: null, source_session_id: null, gid: "g1" }));
    }
    writeFileSync(join(ORG, "dispatch-log.ndjson"), rows.join("\n") + "\n");
  }
  // events.ndjson 5k 行（session-task 域源）
  if (!existsSync(join(DATA, "events.ndjson"))) {
    const evs: string[] = [];
    for (let i = 0; i < 5_000; i++) evs.push(JSON.stringify({ seq: i + 1, type: "SESSION_LOG", session_id: "s" + (i % 50), payload: [], ts: Date.now() - (5_000 - i) * 1000 }));
    writeFileSync(join(DATA, "events.ndjson"), evs.join("\n") + "\n");
  }
  console.log("[gen] 数据集就绪：" + ORG + " / " + DATA);
}

const mode = process.env.CCR_STORAGE_READ_MODE;
console.log(`[bench] read mode=${mode} org=${ORG} data=${DATA}`);

const rm = await import("../src/storage/read-mode.js");
const { ensureStore } = rm as { ensureStore: (d: { dataDir: string; orgDir: string; tasksDir?: string }) => unknown };
const dirs = { dataDir: DATA, orgDir: ORG, tasksDir: join(DATA, "tasks") };

const t = (fn: () => void): number => { const t0 = Date.now(); fn(); return Date.now() - t0; };

const ms1 = t(() => ensureStore(dirs));
console.log(`[bench] ensureStore 首建（open+migrate+全量导入）: ${ms1}ms`);

const ms2: number[] = [];
for (let i = 0; i < 10; i++) ms2.push(t(() => ensureStore(dirs)));
console.log(`[bench] ensureStore 二次×10（缓存命中——修复前=七域同步聚合 / 修复后=签名短路）: ${ms2.join(",")} ms`);

appendFileSync(join(ORG, "dispatch-log.ndjson"), JSON.stringify({ id: "dbench", tier: "正经立项", stage: "claim", title: "增量行", body: "x", created_at: Date.now(), updated_at: Date.now(), status: "running", gid: "g1" }) + "\n");
const ms3 = t(() => ensureStore(dirs));
console.log(`[bench] ensureStore 源变更后（真导入快进）: ${ms3}ms`);
// sqlitefix 补面：org 源变更（mtime touch projects.json）——触发 orgRescanPending 十表
// 全清重灌（生产 8s 主源假说：外部写者/relay 写 org 三源后，基线命中分支的同步导入跑
// 全量重灌——本段两轮对照：变更后首轮=重灌成本；再一轮（签名回填后）=短路
const pj = join(ORG, "projects.json");
const now2 = new Date();
utimesSync(pj, now2, new Date(now2.getTime() + 5000));
const ms4 = t(() => ensureStore(dirs));
console.log(`[bench] ensureStore org 源变更后首轮（基线=十表全清重灌同步跑 / 修复=同样跑但仅此轮）: ${ms4}ms`);
const ms5 = t(() => ensureStore(dirs));
console.log(`[bench] ensureStore org 变更后二轮（修复=签名回填短路 <10ms / 基线=再跑一轮导入）: ${ms5}ms`);

const org = await import("../src/org.js");
const rd: number[] = [];
for (let i = 0; i < 10; i++) rd.push(t(() => (org as unknown as { readDispatchLog: (d?: string, m?: number) => unknown[] }).readDispatchLog(ORG, 500)));
console.log(`[bench] readDispatchLog(500) sqlite 档×10（域缓存前/后对照面）: ${rd.join(",")} ms`);
console.log("[bench] 对照口径：修复前「二次」列应现数百 ms~秒级（PM 实锤 8s 为叠加三定时器共振）；修复后应 <10ms。基线跑法：git stash -- relay/src && 同命令再跑");
