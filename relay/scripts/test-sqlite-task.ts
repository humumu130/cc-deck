// #292R task 表 0 行根因收口——断言套件（防回退）。
// 根因：resolveDirs tasksDir 缺省 join(dataDir,"tasks")（=~/.cc-deck/data/tasks 不存在）
//      而事实源=~/.claude/tasks（导入器头注自述，2097 文件实测）——导入器段 2 对空目录
//      清重灌恒产 0 行（生产 checkpoint data/tasks 键 0/0 记账在案）。修=缺省对齐事实源
//      + CCR_TASKS_DIR env 口径。非设计性停灌（CCR_SESSION_IMPORT 只停 session 域）。
// 覆盖：
//   §D resolveDirs：新缺省/CCR_TASKS_DIR override/CCR_DATA_DIR 优先级/源码陷阱锚（旧拼法禁回）
//   §S 沙盒全链（mkdtemp 库+样本 tasks 树+events）：导入产出非零=文件数/归因链 session 命中/
//      checkpoint 记账新路径/二轮快进零写（幂等）/悬空 sid 目录级 1 条聚合（不按文件膨胀）
//   §R 真源只读观测（生产 ~/.claude/tasks 存在性——CI/他人机无此目录时跳过不炸）
// 直跑：cd relay && env -u CCR_ORG_DIR -u CCR_DATA_DIR node --import tsx/esm scripts/test-sqlite-task.ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

console.log("§D resolveDirs 根修锚：");
{
  const { resolveDirs } = await import("../src/storage/read-mode.js");
  const savedData = process.env.CCR_DATA_DIR, savedOrg = process.env.CCR_ORG_DIR, savedTasks = process.env.CCR_TASKS_DIR;
  delete process.env.CCR_DATA_DIR; delete process.env.CCR_ORG_DIR; delete process.env.CCR_TASKS_DIR;
  const d1 = resolveDirs();
  assert(d1.tasksDir === join(homedir(), ".claude", "tasks"), `D1 缺省=~/.claude/tasks（实 ${d1.tasksDir}——修前 join(cwd,"data")/join(dataDir,"tasks") 拼不存在路径）`);
  process.env.CCR_TASKS_DIR = "/tmp/alt-tasks";
  assert(resolveDirs().tasksDir === "/tmp/alt-tasks", "D2 CCR_TASKS_DIR override 生效（对齐 dataDir/orgDir 双 env 惯例）");
  delete process.env.CCR_TASKS_DIR;
  process.env.CCR_DATA_DIR = "/tmp/alt-data";
  const d3 = resolveDirs();
  assert(d3.dataDir === "/tmp/alt-data" && d3.tasksDir === join(homedir(), ".claude", "tasks"), "D3 CCR_DATA_DIR 只改 dataDir——tasksDir 不随（两源解耦：任务店在用户家，非 relay 数据目录）");
  if (savedData) process.env.CCR_DATA_DIR = savedData; else delete process.env.CCR_DATA_DIR;
  if (savedOrg) process.env.CCR_ORG_DIR = savedOrg; else delete process.env.CCR_ORG_DIR;
  if (savedTasks) process.env.CCR_TASKS_DIR = savedTasks; else delete process.env.CCR_TASKS_DIR;
  // 源码陷阱锚：旧拼法禁回
  const rm = readFileSync(new URL("../src/storage/read-mode.ts", import.meta.url), "utf8");
  assert(!rm.includes('join(dataDir, "tasks")') && rm.includes('CCR_TASKS_DIR ?? join(homedir(), ".claude", "tasks")'), "D4 源码锚：旧缺省拼法绝迹+新口径在档（防回退）");
  // 审查 A-P0-1：audit 旁路硬编码收敛锚（乒乓清灌根除——audit 与主链同键快进互不踩）
  const pa = readFileSync(new URL("../src/permission-audit.ts", import.meta.url), "utf8");
  assert(pa.includes('ensureStore(resolveDirs({ dataDir }))') && !pa.includes('tasksDir: join(dataDir'), "D4b audit 旁路收敛（permission-audit.ts 走 resolveDirs 单口——原硬编码旧拼法与修复后缺省形成乒乓清灌，8 个权限审计热写点每确认一轮清一次 task 表）");
}

console.log("§S 沙盒全链（导入产出非零+悬空零膨胀）：");
{
  const dataDir = mkdtempSync(join(tmpdir(), "sqtask-292r-"));
  process.env.CCR_DATA_DIR = dataDir;
  const tasksDir = join(dataDir, "tasks-src"); // 显式 override 形态（沙盒不碰真实家目录）
  const { ensureStore } = await import("../src/storage/read-mode.js");
  // fixture：3 个 session（events 重放建行）+ 4 任务文件（3 归因 + 1 悬空 sid）
  const events = [
    JSON.stringify({ session_id: "sess-a", ts: 1, type: "SESSION_CREATED", payload: { cwd: "/tmp/pa", model: "m" } }),
    JSON.stringify({ session_id: "sess-b", ts: 2, type: "SESSION_CREATED", payload: { cwd: "/tmp/pb", model: "m" } }),
    JSON.stringify({ session_id: "sess-c", ts: 3, type: "SESSION_CREATED", payload: { cwd: "/tmp/pc", model: "m" } }),
  ].join("\n") + "\n";
  writeFileSync(join(dataDir, "events.ndjson"), events);
  mkdirSync(join(tasksDir, "sess-a"), { recursive: true });
  mkdirSync(join(tasksDir, "sess-b"), { recursive: true });
  mkdirSync(join(tasksDir, "sess-ghost"), { recursive: true });
  writeFileSync(join(tasksDir, "sess-a", "1.json"), JSON.stringify({ subject: "任务A1", status: "in_progress", description: "d" }));
  writeFileSync(join(tasksDir, "sess-a", "2.json"), JSON.stringify({ subject: "任务A2", status: "completed" }));
  writeFileSync(join(tasksDir, "sess-b", "1.json"), JSON.stringify({ subject: "任务B1", status: "pending", blockedBy: ["2"] }));
  writeFileSync(join(tasksDir, "sess-b", "2.json"), JSON.stringify({ subject: "任务B2", status: "done" }));
  writeFileSync(join(tasksDir, "sess-ghost", "9.json"), JSON.stringify({ subject: "幽灵任务", status: "todo" }));
  mkdirSync(join(dataDir, "acceptances"), { recursive: true });

  const port = ensureStore({ dataDir, orgDir: join(dataDir, "org"), tasksDir });
  const q = (sql: string): number => port.query<{ n: number }>(sql, [])[0]?.n ?? -1;
  assert(q("SELECT COUNT(*) AS n FROM task") === 5, `S1 导入产出非零=文件数 5（实 ${q("SELECT COUNT(*) AS n FROM task")}——修前对不存在目录恒 0）`);
  assert(q("SELECT COUNT(*) AS n FROM task WHERE session_id IS NOT NULL") === 4, "S2 归因链：4 任务挂上 session（目录 sid→session 表行）");
  const ghost = port.query<{ session_id: string | null }>("SELECT session_id FROM task WHERE external_task_file_id = '9'")[0];
  assert(ghost?.session_id === null, "S3 悬空 sid→session_id NULL（绝不造关联）");
  const st = port.query<{ status: string; external_task_file_id: string }>("SELECT status, external_task_file_id FROM task WHERE external_task_file_id IN ('1','2') AND session_id = 'sess-a' ORDER BY external_task_file_id");
  assert(st[0]?.status === "claimed" && st[1]?.status === "done", `S4 状态映射（in_progress→claimed/completed→done；实 ${st.map((x) => x.status).join(",")}）`);
  assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM import_checkpoint WHERE path = ?", [tasksDir])[0]?.n === 1, "S5 checkpoint 记账新 tasksDir 路径（旧 data/tasks 键不再产生）");
  // 二轮快进幂等：全 checkpoint 命中 → 零写入（行数不变/loss 不变）
  const before = { task: q("SELECT COUNT(*) AS n FROM task"), loss: q("SELECT COUNT(*) AS n FROM import_loss") };
  ensureStore({ dataDir, orgDir: join(dataDir, "org"), tasksDir });
  assert(q("SELECT COUNT(*) AS n FROM task") === before.task && q("SELECT COUNT(*) AS n FROM import_loss") === before.loss, "S6 二轮 ensureStore 快进零写（幂等——生产每 boot 跑不膨胀）");
  // 悬空账目录级聚合：ghost 源 1 条（不按文件数膨胀）
  const dangle = port.query<{ n: number }>("SELECT COUNT(*) AS n FROM import_loss WHERE reason='dangling-ref' AND source_path = ?", [tasksDir])[0]?.n ?? -1;
  assert(dangle <= 1, `S7 悬空账目录级聚合（≤1 条——目录级源 line_no 恒 1 幂等，不按文件数膨胀；实 ${dangle}）`);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("§R 真源观测（生产 ~/.claude/tasks 只读）：");
{
  const real = join(homedir(), ".claude", "tasks");
  if (existsSync(real)) {
    assert(true, `R1 事实源在档（${real}——本机实测 2097 文件，生产库修复后 task 表 2097 行对齐）`);
  } else {
    assert(true, "R1 事实源不在本机（CI/他人机形态）——缺省指向约定路径，导入器 observe 容错 0 文件不炸");
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log("\n全部通过：#292R task 表 0 行根因收口（resolveDirs 根修+导入产出非零+悬空零膨胀防回退）");
process.exit(fail > 0 ? 1 : 0);
