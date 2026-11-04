// W-SQLITEFIX-R1 P0·F1 回归锁（A 审复现脚本收编入套件——原 /tmp/review-sqlitefix-a/
// repro-poison.ts exit=42 实证「首读竞态投毒」；修后 rc=0，收编防回退）。
// 链路：外部写者 append dispatch-log → 首个 readDispatchLog（same-turn，竞态导入调度）
//       → flush 等导入完成 → 再读 → 断言行可见（首读走 json 权威[保险①]；域缓存
//       过渡窗不写[保险②]+导入收尾失效[保险③]）。
// 直跑：env -u CCR_DATA_DIR -u CCR_ORG_DIR -u CCR_PORT npx tsx scripts/test-sqlitefix-poison.ts
// （头部剥生产 env=环境立规样板：worker shell 自带 CCR_DATA_DIR 会拿生产库当沙盒——B 审备案）
for (const k of ["CCR_DATA_DIR", "CCR_ORG_DIR", "CCR_PORT", "CCR_PARENT_PID", "CCR_RELAY_CHILD"]) delete process.env[k];
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CCR_STORAGE_READ_MODE = "sqlite";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string) => { if (c) { pass++; console.log("  ok - " + n); } else { fail++; console.error("FAIL: " + n); } };

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sf-poison-"));
  const dataDir = join(root, "data");
  const orgDir = join(root, "org");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(orgDir, { recursive: true });
  mkdirSync(join(orgDir, "boards"), { recursive: true });
  writeFileSync(join(orgDir, "org.json"), JSON.stringify({ schema: 1, groups: [{ id: "g1", name: "复现", status: "active", tier: "正经立项" }] }));
  writeFileSync(join(orgDir, "projects.json"), "[]");
  writeFileSync(join(orgDir, "confirms.json"), "[]");
  writeFileSync(join(orgDir, "dispatch-log.ndjson"), JSON.stringify({ id: "row-1", tier: "正经立项", stage: "claim", title: "首行", body: "b", gid: "g1", target_member_id: null, source_session_id: null, status: "dispatched", ts: 1 }) + "\n");
  writeFileSync(join(dataDir, "events.ndjson"), "");

  process.env.CCR_DATA_DIR = dataDir;
  process.env.CCR_ORG_DIR = orgDir;

  const rm = await import("../src/storage/read-mode.js");
  const org = await import("../src/org.js");

  const dirs = { dataDir, orgDir, tasksDir: join(dataDir, "tasks") };
  rm.ensureStore(dirs); // 冷建（同步导入 row-1）

  // 外部写者追加 row-2（mtime/size 变 → 签名必变）
  appendFileSync(join(orgDir, "dispatch-log.ndjson"), JSON.stringify({ id: "row-2", tier: "正经立项", stage: "claim", title: "增量行", body: "b", gid: "g1", target_member_id: null, source_session_id: null, status: "dispatched", ts: 2 }) + "\n");

  const read1 = org.readDispatchLog(undefined, 500).map((e: { id: string }) => e.id);
  ok(read1.includes("row-2"), `[1] 变更后首读新行可见（保险① pending 后移→json 权威）：${JSON.stringify(read1)}`);

  await rm.flushShadowImportForTest(dataDir);
  ok(true, "[2] 后台导入完成（flush 栅栏通过）");

  const read2 = org.readDispatchLog(undefined, 500).map((e: { id: string }) => e.id);
  ok(read2.includes("row-2"), `[3] 导入完成后再读可见（保险②过渡窗不缓存+③收尾失效——投毒绝迹）：${JSON.stringify(read2)}`);

  const read3 = org.readDispatchLog(undefined, 500).map((e: { id: string }) => e.id);
  ok(read3.includes("row-2"), `[4] 三读仍可见（恒新鲜）：${JSON.stringify(read3)}`);

  rmSync(root, { recursive: true, force: true });
  console.log(`\n== test-sqlitefix-poison 汇总：${pass} ok / ${fail} FAIL ==`);
  process.exit(fail ? 42 : 0);
}
void main();
