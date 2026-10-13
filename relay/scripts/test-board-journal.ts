// W-BJOURNAL 板文件 delta journal 测试（SSOT 拍板点1）：写板→journal 有行（含 gid/
// entry_id/action/prev/next）｜幂等写→行数=写次数｜滚动触发→旧档 .1 存在｜各 action 语义
// （create/update/move/remove/freeze）｜journal 写失败不阻断板写（只读目录极端模拟）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGroup, upsertBoardEntry, moveBoardEntry, removeBoardEntry, setGroupStatus } from "../src/projects.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string, detail = "") {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name + (detail ? " | " + detail : "")); }
}
function section(t: string) { console.log(t); }

const dirs: string[] = [];
function mkOrg(): string {
  const org = mkdtempSync(join(tmpdir(), "ccr-bj-"));
  dirs.push(org);
  return org;
}
function journalLines(org: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(org, "boards-journal.ndjson"), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}
function mkBoardedOrg(): { org: string; gid: string } {
  // 手写 org 目录（轻立项首建走确认卡，测试绕行——writableBoard 只读 projects.json）
  const org = mkOrg();
  const anchor = mkdtempSync(join(tmpdir(), "ccr-bj-a-")); dirs.push(anchor);
  const gid = "g-j1";
  writeFileSync(join(org, "projects.json"), JSON.stringify({
    groups: [{ id: gid, name: "journal 组", anchor_dir: anchor, status: "active", tier: "轻立项", headcount: [], single_card: false, created_at: 1, updated_at: 1 }],
    trust_light: false,
  }), "utf-8");
  return { org, gid };
}

// ---------- S1 写板→journal 有行 ----------
section("\nS1 写板产生 journal 行（含全字段）");
{
  const { org, gid } = mkBoardedOrg();
  const u = upsertBoardEntry(gid, { text: "任务甲", status: "backlog" }, org);
  assert(u.ok, "S1 前置：建卡成功");
  if (!u.ok) throw new Error("unreachable"); // TS 收窄：assert 不缩窄 union
  const lines = journalLines(org);
  assert(lines.length >= 1, "S1 写板→journal 有行", `n=${lines.length}`);
  const row = lines.at(-1)! as { ts?: number; gid?: string; entry_id?: string; action?: string; next?: { status?: string; text?: string } };
  assert(typeof row.ts === "number" && row.gid === gid, "S1 行含 ts+gid");
  assert(row.action === "create" && row.entry_id === u.entry!.id, "S1 行含 action=create+entry_id", JSON.stringify(row));
  assert(!("prev" in row) && row.next?.status === "backlog" && row.next?.text === "任务甲", "S1 新建行：无 prev、next 摘要对");

  // 更新支：prev/next 齐
  const u2 = upsertBoardEntry(gid, { id: u.entry!.id, text: "任务甲改", status: "claimed" }, org);
  assert(u2.ok, "S1 前置：更新成功");
  const row2 = journalLines(org).at(-1)! as { action?: string; prev?: { status?: string; text?: string }; next?: { status?: string } };
  assert(row2.action === "update" && row2.prev?.status === "backlog" && row2.next?.status === "claimed", "S1 更新行：prev→next 摘要对", JSON.stringify(row2));
}

// ---------- S2 幂等写→行数=写次数 ----------
section("\nS2 每次落盘一行（幂等写不合并）");
{
  const { org, gid } = mkBoardedOrg();
  const u = upsertBoardEntry(gid, { text: "任务乙", status: "backlog" }, org);
  const before = journalLines(org).length;
  for (let i = 0; i < 3; i++) upsertBoardEntry(gid, { id: u.entry!.id, text: "任务乙", status: "backlog" }, org); // 内容幂等仍写
  const after = journalLines(org).length;
  assert(after === before + 3, "S2 三次幂等写→行数+3（行数=写次数）", `${before}→${after}`);
}

// ---------- S3 滚动→旧档 .1 存在 ----------
section("\nS3 超 5MB 滚动保留一份旧档");
{
  const { org, gid } = mkBoardedOrg();
  const jp = join(org, "boards-journal.ndjson");
  // 预置 5MB+ 现档 + 一份旧 .1（验证被滚动替换）
  writeFileSync(jp, "x".repeat(5 * 1024 * 1024 + 1024), "utf-8");
  writeFileSync(jp + ".1", "old", "utf-8");
  upsertBoardEntry(gid, { text: "触发滚动", status: "backlog" }, org);
  assert(statSync(jp + ".1").size === 5 * 1024 * 1024 + 1024, "S3 旧档被滚动内容替换（原 .1 让位）");
  const newJ = readFileSync(jp, "utf-8");
  assert(newJ.length < 1024 && newJ.includes("触发滚动"), "S3 新档从头起且含新行（滚动后追加）", `len=${newJ.length}`);
  assert(journalLines(org).length === 1, "S3 滚动后行数归 1（旧档隔离）");
}

// ---------- S4 move/remove/freeze 语义行 ----------
section("\nS4 各 action 语义行");
{
  const { org, gid } = mkBoardedOrg();
  const u = upsertBoardEntry(gid, { text: "任务丙", status: "claimed" }, org);
  const m = moveBoardEntry(gid, u.entry!.id, "done", org);
  assert(m.ok, "S4 前置：move 成功");
  const rmv = journalLines(org).find((l) => (l as { action?: string }).action === "move") as { prev?: { status?: string }; next?: { status?: string } };
  assert(rmv?.prev?.status === "claimed" && rmv?.next?.status === "done", "S4 move 行 prev/next 对");
  const r2 = removeBoardEntry(gid, u.entry!.id, org);
  assert(r2.ok, "S4 前置：remove 成功");
  const rrow = journalLines(org).find((l) => (l as { action?: string }).action === "remove") as { entry_id?: string; prev?: { text?: string } };
  assert(rrow?.entry_id === u.entry!.id && rrow?.prev?.text === "任务丙", "S4 remove 行带 entry_id+prev 摘要");
  const fz = setGroupStatus(gid, "parked", "journal 冻结测试", org);
  assert(fz.ok, "S4 前置：park 冻结成功");
  assert(journalLines(org).some((l) => (l as { action?: string }).action === "freeze"), "S4 freeze 行在场");
}

// ---------- S5 journal 失败不阻断板写 ----------
section("\nS5 journal 写失败不阻断主写");
{
  const { org, gid } = mkBoardedOrg();
  // 只堵 journal：boards-journal.ndjson 造成目录（appendFileSync 必 EISDIR），板目录 mkdir 照常
  mkdirSync(join(org, "boards-journal.ndjson"));
  const u = upsertBoardEntry(gid, { text: "journal 失败也写板", status: "backlog" }, org);
  assert(u.ok, "S5 journal 失败（路径被占）板写仍成功（保险不是闸）", u.ok ? "" : JSON.stringify(u));
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
console.log(`\nboard-journal: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
