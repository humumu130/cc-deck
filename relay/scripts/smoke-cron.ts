// cron.ts 解析器冒烟：数组/对象 map/{tasks:[...]} 三形态 + 字段别名 + 软删除过滤。
// 自包含 fixture（data/smoke-tmp 下），跑完断言即退出。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCronTasks } from "../src/cron.js";

const root = join(process.cwd(), "data", "smoke-cron");
rmSync(root, { recursive: true, force: true });

function fixture(name: string, json: unknown) {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "scheduled_tasks.json"), JSON.stringify(json));
  return cwd;
}

let fails = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { fails++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}

// ① 数组形态 + 预期字段（华为 CodeArts 分支 schema）
{
  const cwd = fixture("arr", [
    { id: "a1b2c3d4", cron: "0 9 * * *", prompt: "检查收件箱", status: "active", recurring: true, humanSchedule: "每天 09:00" },
    { id: "e5f6g7h8", cron: "*/5 * * * *", prompt: "盯构建", status: "paused", recurring: true },
    { id: "x1y2z3w4", cron: "30 14 5 9 *", prompt: "跑一次", status: "active", recurring: false },
    { id: "deadbeef", cron: "* * * * *", prompt: "已删", status: "deleted" },
  ]);
  const r = readCronTasks(cwd)!;
  assert(r.length === 3, "数组形态：软删除被过滤，剩 3 条");
  const first = r[0];
  assert(first.id === "a1b2c3d4" && first.schedule === "每天 09:00" && first.prompt === "检查收件箱", "humanSchedule 优先作 schedule");
  assert(r[1].paused === true, "status=paused → paused:true");
  assert(r[2].recurring === false, "recurring:false 透传（一次性）");
  assert(first.recurring === undefined, "recurring 默认（周期）不带字段");
}

// ② 对象 map 形态：键 = id，字段名变体
{
  const cwd = fixture("map", {
    "task-9": { name: "日报", command: "生成日报", interval: "0 18 * * 1-5", enabled: false },
  });
  const r = readCronTasks(cwd)!;
  assert(r.length === 1 && r[0].id === "task-9", "map 形态：键作 fallback id");
  assert(r[0].prompt === "生成日报" && r[0].schedule === "0 18 * * 1-5", "command/interval 别名生效");
  assert(r[0].paused === true, "enabled:false → paused");
  assert(r[0].name === "日报", "name 字段优先");
}

// ③ { tasks: [...] } 包装 + next_run_at ISO 字符串
{
  const cwd = fixture("wrap", { tasks: [
    { id: "w1", cron: "0 0 * * *", prompt: "p", nextRunAt: "2026-09-05T00:00:00Z" },
  ] });
  const r = readCronTasks(cwd)!;
  assert(r.length === 1 && r[0].next_run_at === Date.parse("2026-09-05T00:00:00Z"), "包装形态 + ISO nextRunAt → 毫秒");
}

// ④ 无文件 / 非法 JSON / 空数组
{
  const cwd = join(root, "none");
  mkdirSync(cwd, { recursive: true });
  assert(readCronTasks(cwd) === undefined, "无文件 → undefined");
  const bad = fixture("bad", "not json{");
  assert(readCronTasks(bad) === undefined, "非法 JSON → undefined");
  const empty = fixture("empty", []);
  const r = readCronTasks(empty)!;
  assert(Array.isArray(r) && r.length === 0, "空数组 → []（触发清空）");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
rmSync(root, { recursive: true, force: true });
process.exit(fails === 0 ? 0 : 1);
