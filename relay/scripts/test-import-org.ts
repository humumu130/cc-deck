// M11-C1 组织域导入器测试：fixture 驱动（自制小样 orgDir，零生产触达）。
// 范式沿用 test-storage（mkdtemp+env 全清+assert 计数+两轮连跑）。
// fixture 布局：org.json（Leader 锚）+ projects.json（4 组：合法×3/词表外×1，含 anchor 归并/
//   engine 缺省/跨组归并/坏 headcount 条目）+ confirms.json（5 单：合法/坏 kind/坏 status/
//   悬空 gid/缺 gid）+ boards/g-1.json（边界实证：板内容不进五表）。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importOrg, ORG_IMPORT_SCHEMA_VERSION } from "../src/storage/import-org.js";
import { readCheckpoint } from "../src/storage/checkpoint.js";
import { listLoss } from "../src/storage/loss-report.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function sha1hex(s: string): string { return createHash("sha1").update(s).digest("hex"); }
function memId(identity: string): string { return `mem-${sha1hex(identity).slice(0, 12)}`; }

// ---------- 0. 启动前纪律 ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-import-org-"));
process.env.CCR_DATA_DIR = dataDir;
const orgDir = mkdtempSync(join(tmpdir(), "cc-deck-fixture-org-"));
process.env.CCR_ORG_DIR = join(dataDir, "org");
console.log("临时目录纪律:");
assert(dataDir.startsWith(tmpdir()) && orgDir.startsWith(tmpdir()) && process.env.CCR_ORG_DIR?.startsWith(tmpdir()) === true, "dataDir/orgDir/CCR_ORG_DIR 全落 tmpdir 前缀（零生产写入前提）");
assert(!orgDir.startsWith(process.env.HOME ?? "~"), "fixture orgDir 不在生产 HOME 下（不动 ~/.cc-deck）");

const port: StoragePort = createSqlitePort({ dataDir, filename: "import.sqlite3" });
port.open();
runMigrations(port, migrations);

// ---------- fixture ----------
const T = 1700000000000;
writeFileSync(join(orgDir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "sess-leader", leader_sdk_id: "sdk-1", created_at: T, updated_at: T + 1000 }, null, 2) + "\n");
writeFileSync(join(orgDir, "projects.json"), JSON.stringify({
  trust_light: false,
  groups: [
    { id: "g-1", name: "alpha", anchor_dir: "/fx/alpha", status: "active", tier: "正经立项", single_card: false, created_at: T + 200, updated_at: T + 300, headcount: [{ session_id: "s-1", role: "dev", engine: "codex" }, { session_id: "s-2", role: "dev", engine: "claude" }] },
    { id: "g-2", name: "beta", anchor_dir: "/fx/beta", status: "parked", tier: "轻立项", single_card: true, created_at: T + 400, updated_at: T + 500, headcount: [{ session_id: "s-bad", role: "dev" }, { session_id: "s-x" }] },
    { id: "g-bad", name: "deadgrp", anchor_dir: "/fx/dead", status: "dead", tier: "正经立项", single_card: false, created_at: T + 600, updated_at: T + 700, headcount: [{ session_id: "s-3", role: "dev", engine: "codex" }] },
    { id: "g-3", name: "alpha-two", anchor_dir: "/fx/alpha", status: "active", tier: "正经立项", single_card: false, created_at: T + 100, updated_at: T + 150, headcount: [{ session_id: "s-4", role: "dev", engine: "codex" }] },
  ],
}, null, 2) + "\n");
writeFileSync(join(orgDir, "confirms.json"), JSON.stringify([
  { id: "c-ok", kind: "tier-change", title: "升级 alpha", reason: "忙不过来", payload: { gid: "g-1", to_tier: "正经立项" }, status: "approved", created_at: T + 800, decided_at: T + 900, decided_by: "leader" },
  { id: "c-bad", kind: "weird-kind", title: "?", reason: "?", payload: { gid: "g-1" }, status: "approved", created_at: T + 810 },
  { id: "c-badstatus", kind: "archive", title: "?", reason: "?", payload: { gid: "g-1" }, status: "ok", created_at: T + 820 },
  { id: "c-dang", kind: "archive", title: "结项", reason: "零异常", payload: { gid: "g-nope" }, status: "pending", created_at: T + 830 },
  { id: "c-noattr", kind: "revive", title: "复活", reason: "又要用", payload: {}, status: "pending", created_at: T + 840 },
], null, 2) + "\n");
mkdirSync(join(orgDir, "boards"), { recursive: true });
writeFileSync(join(orgDir, "boards", "g-1.json"), JSON.stringify({ gid: "g-1", entries: [{ id: "e-1", text: "板卡不该进五表", status: "todo", ts: T, updated_at: T }], frozen: false, updated_at: T }, null, 2) + "\n");

// ---------- 1. 全量导入：行数+字段映射（验收 1） ----------
console.log("全量导入:");
const r1 = importOrg(port, orgDir);
assert(r1.skipped === false && r1.rescanned.length === 3, "三源全重扫（首轮无 checkpoint）");
assert(r1.counts.project === 2 && r1.counts.group === 3 && r1.counts.member === 4 && r1.counts.groupMember === 4 && r1.counts.orgConfirm === 3, `五表行数 2/3/4/4/3 与 fixture 期望一致（实测 ${JSON.stringify(r1.counts)}）`);
// 字段抽查：Leader member
const leader = port.query<{ id: string; stable_identity: string; display_name: string; external_sid: string; joined_at: number }>("SELECT id, stable_identity, display_name, external_sid, joined_at FROM member WHERE stable_identity LIKE '%@leader@'")[0];
assert(leader !== undefined && leader.stable_identity === `${orgDir}@leader@` && leader.display_name === "Leader" && leader.external_sid === "sess-leader" && leader.joined_at === T, "Leader member：identity=<orgDir>@leader@、sid/joined_at 来自锚");
// 字段抽查：跨组归并 member（dev@codex 归并 s-1/s-3/s-4 → g-1+g-3）
const devCodex = port.query<{ id: string; archive_json: string; joined_at: number; engine: string | null }>("SELECT id, archive_json, joined_at, engine FROM member WHERE stable_identity = ?", [`${orgDir}@dev@codex`])[0];
assert(devCodex !== undefined && devCodex.archive_json === JSON.stringify({ groups: ["g-1", "g-3"] }), "跨组归并 member：archive_json 记两组历史（g-1+g-3）");
// 字段抽查：engine 缺省条目 → identity 空段
const devNoEngine = port.query<{ id: string }>("SELECT id FROM member WHERE stable_identity = ?", [`${orgDir}@dev@`])[0];
assert(devNoEngine !== undefined && devNoEngine.id === memId(`${orgDir}@dev@`), "engine 缺省条目 identity 空段（<orgDir>@dev@）且 id 确定性推导");
// 字段抽查：project 归并（g-1/g-3 同 anchor → 同 project，name 取最早组 g-3）
const projAlpha = port.query<{ id: string; name: string; dir_fingerprint: string; anchor_dir: string }>("SELECT id, name, dir_fingerprint, anchor_dir FROM project WHERE anchor_dir = '/fx/alpha'")[0];
assert(projAlpha !== undefined && projAlpha.name === "alpha-two" && projAlpha.dir_fingerprint === sha1hex("/fx/alpha") && projAlpha.id === `proj-${sha1hex("/fx/alpha").slice(0, 12)}`, "anchor 归并：同 anchor 同 project、name 取最早组、dir_fingerprint=sha1(anchor)");
// 字段抽查：group 落库
const g1 = port.query<{ project_id: string | null; workflow_profile: string; single_card: number }>(`SELECT project_id, workflow_profile, single_card FROM "group" WHERE id = 'g-1'`)[0];
assert(g1 !== undefined && g1.project_id === projAlpha?.id && g1.workflow_profile === "engineering" && g1.single_card === 0, "group：project_id=归并 project、workflow_profile 缺省 engineering（冻结件 §4）");
// 字段抽查：group_member joined_at 取组 created_at（冻结件 §4：旧成员无 joined 取 group.created_at）
const gm3 = port.query<{ joined_at: number; command_role: string }>("SELECT joined_at, command_role FROM group_member WHERE group_id = 'g-3'")[0];
assert(gm3 !== undefined && gm3.joined_at === T + 100 && gm3.command_role === "dev", "group_member：joined_at 取组 created_at、组内角色覆盖 command_role=entry.role");
// 字段抽查：org_confirm decided_by 映射 + 悬空/缺归因写 NULL
const cOk = port.query<{ group_id: string | null; decided_by: string | null }>("SELECT group_id, decided_by FROM org_confirm WHERE id = 'c-ok'")[0];
assert(cOk !== undefined && cOk.group_id === "g-1" && cOk.decided_by === leader?.id, "org_confirm：decided_by='leader' 映射 Leader member id（回单映射规则）");
const cDang = port.query<{ group_id: string | null }>("SELECT group_id FROM org_confirm WHERE id IN ('c-dang','c-noattr')");
assert(cDang.length === 2 && cDang.every((r) => r.group_id === null), "悬空 gid/缺 gid 两单照导且归因写 NULL（不造关联）");
// 零悬空 FK + 板内容不进五表
assert(port.query("PRAGMA foreign_key_check").length === 0, "PRAGMA foreign_key_check 零行（五表零悬空 FK）");
const boardLeak = port.query<{ n: number }>(`SELECT COUNT(*) AS n FROM task`)[0]?.n ?? -1;
assert(boardLeak === 0, "boards/g-1.json 内容零进五表（task 0 行——板归 D 线，边界实证）");

// ---------- 2. loss 对账（验收 3） ----------
console.log("loss 对账:");
const lossProjects = listLoss(port, join(orgDir, "projects.json"));
const lossConfirms = listLoss(port, join(orgDir, "confirms.json"));
assert(lossProjects.length === 3 && lossProjects.map((l) => l.reason).sort().join() === "bad-field,dangling-ref,missing-field", `projects.json 3 账：组词表外/关系悬空/坏 headcount 条目（实测 ${lossProjects.map((l) => l.reason).join()}）`);
assert(lossProjects.find((l) => l.reason === "bad-field")?.lineNo === 3, "组坏行 file:line 指向 groups[] 第 3 元素（g-bad）");
assert(lossConfirms.length === 4 && lossConfirms.map((l) => l.reason).sort().join() === "bad-field,bad-field,dangling-ref,missing-attribution", `confirms.json 4 账：坏 kind/坏 status/悬空 gid/缺归因（实测 ${lossConfirms.map((l) => l.reason).join()}）`);
assert(listLoss(port, join(orgDir, "org.json")).length === 0, "org.json 零 loss");
assert(listLoss(port).length === 7, "loss 总账 7 条（projects 3 + confirms 4）");

// ---------- 3. 重复运行幂等（验收 2） ----------
console.log("幂等:");
const before = r1.counts;
const r2 = importOrg(port, orgDir);
assert(r2.skipped === true, "重复运行走 checkpoint 快进（skipped=true）");
assert(r2.counts.project === before.project && r2.counts.group === before.group && r2.counts.member === before.member && r2.counts.groupMember === before.groupMember && r2.counts.orgConfirm === before.orgConfirm, "五表行数不增（幂等实证）");
assert(listLoss(port).length === 7, "快进零写入：loss 总账不变（不重复落账）");
const sources = ["org.json", "projects.json", "confirms.json"].map((f) => join(orgDir, f));
assert(sources.every((f) => {
  const st = statSync(f);
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return readCheckpoint(port, f, { mtimeMs: Math.round(st.mtimeMs), lineCount: lines.length, schemaVersion: ORG_IMPORT_SCHEMA_VERSION }) !== null;
}), "三源 checkpoint 记录在位且有效（五元组命中）");

// ---------- 4. 源变化失效重扫：旧数据不残留（验收 4） ----------
console.log("源变化重扫:");
// projects.json：删 g-2、g-bad 转合法（active）、追加 g-4（新 anchor、新 role qa）
writeFileSync(join(orgDir, "projects.json"), JSON.stringify({
  trust_light: false,
  groups: [
    { id: "g-1", name: "alpha", anchor_dir: "/fx/alpha", status: "active", tier: "正经立项", single_card: false, created_at: T + 200, updated_at: T + 300, headcount: [{ session_id: "s-1", role: "dev", engine: "codex" }, { session_id: "s-2", role: "dev", engine: "claude" }] },
    { id: "g-bad", name: "revived", anchor_dir: "/fx/dead", status: "active", tier: "正经立项", single_card: false, created_at: T + 600, updated_at: T + 700, headcount: [{ session_id: "s-3", role: "dev", engine: "codex" }] },
    { id: "g-3", name: "alpha-two", anchor_dir: "/fx/alpha", status: "active", tier: "正经立项", single_card: false, created_at: T + 100, updated_at: T + 150, headcount: [{ session_id: "s-4", role: "dev", engine: "codex" }] },
    { id: "g-4", name: "delta", anchor_dir: "/fx/delta", status: "pending", tier: "轻立项", single_card: true, created_at: T + 1000, updated_at: T + 1100, headcount: [{ session_id: "s-9", role: "qa", engine: "codex" }] },
  ],
}, null, 2) + "\n");
const pj = join(orgDir, "projects.json");
utimesSync(pj, new Date(Date.now() + 10), new Date(Date.now() + 10)); // 防同毫秒 mtime 巧合
const r3 = importOrg(port, orgDir);
assert(r3.skipped === false && r3.rescanned.includes(pj), "projects.json 失效→重扫");
assert(r3.counts.project === 3 && r3.counts.group === 4 && r3.counts.member === 4 && r3.counts.groupMember === 5 && r3.counts.orgConfirm === 3, `重灌后行数与新期望一致 3/4/4/5/3（实测 ${JSON.stringify(r3.counts)}）`);
assert(port.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "group" WHERE id = 'g-2'`)[0]?.n === 0 && port.query<{ n: number }>("SELECT COUNT(*) AS n FROM project WHERE anchor_dir = '/fx/beta'")[0]?.n === 0, "旧数据不残留：g-2 及其孤 project 行已随域清消失");
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM group_member WHERE group_id = 'g-bad'")[0]?.n === 1, "g-bad 转合法后其 group_member 关系补齐（重扫语义）");
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM member WHERE stable_identity = ?", [`${orgDir}@qa@codex`])[0]?.n === 1, "新 role qa@codex 成员导入");
const lossAfter = listLoss(port);
assert(lossAfter.filter((l) => l.sourcePath === pj).length === 0 && lossAfter.filter((l) => l.sourcePath === join(orgDir, "confirms.json")).length === 4, "重扫按源清旧 loss 再落新账：projects.json 转净（0 条）、confirms.json 重灌同 4 条");
assert(port.query("PRAGMA foreign_key_check").length === 0, "重扫后仍零悬空 FK");

// ---------- 5. 整文件坏 JSON：该源零导入+落账，其余源照常（范式要点 4） ----------
console.log("坏 JSON 保护:");
const confirmsPath = join(orgDir, "confirms.json");
writeFileSync(confirmsPath, "{ 这不是 JSON");
utimesSync(confirmsPath, new Date(Date.now() + 20), new Date(Date.now() + 20));
const r4 = importOrg(port, orgDir);
assert(r4.skipped === false, "confirms.json 失效触发重扫");
assert(r4.counts.orgConfirm === 0, "坏 JSON 源零导入（损坏数据零进库）");
assert(r4.counts.group === 4 && r4.counts.member === 4 && r4.counts.project === 3, "其余源照常重灌（不阻断）");
const badLoss = listLoss(port, confirmsPath);
assert(badLoss.length === 1 && badLoss[0]?.reason === "bad-json" && badLoss[0]?.lineNo === 1, "坏 JSON 落账恰 1 条（line 1）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "坏源重扫后仍零悬空 FK");

port.close();
rmSync(dataDir, { recursive: true, force: true });
rmSync(orgDir, { recursive: true, force: true });

console.log(`Import org: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
