// M11-C2 组织导入等价 fixture：旧 JSON store（projects.ts 语义权威，只读消费）↔ 新 SQLite
// 导入行（importOrg）双源对表——证明「同一份 org 目录，旧读路径与新导入路径说的是同一件事」。
// 与 test-import-org.ts（C1 导入器行为单测）分件：本件用 projects.ts 真写函数（createGroup/
// setGroupStatus/setGroupTier/markHoldSuggested/addConfirm/decideConfirm/upsertBoardEntry，全带
// dir 注入零生产触达）生成 fixture，等价断言=旧读面读回值对照导入行字段值，不猜值。
// 双目录结构：
//   fx1（F1 现状证据小库）：真写路径产出的包裹形 confirms.json（projects.ts:625 {confirms:[…]}）
//     直接 importOrg——断言现状=整源 bad-json 零导入（发现 F1：import-org.ts:241 只认裸数组）。
//   fx2（等价对照主库）：confirms.json 展开为裸数组（格式对齐假设面）后逐单等价对照——
//     F1 修复后本件即验收件；projects.json 保持真写路径包裹形（import-org.ts:152 读 .groups 正确消费）。
// 已知差异显式登记（断言在件）：parked_at/archived_at 丢失面（F2）、single_card 不推导（F3）。
// 范式沿用 C1（mkdtemp+env 钉死+assert 计数+utimesSync 防 mtime 巧合+foreign_key_check 兜底）。
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importOrg } from "../src/storage/import-org.js";
import { listLoss } from "../src/storage/loss-report.js";
import {
  addConfirm, canTransition, computeReady, computeReadySet, createGroup, decideConfirm, listConfirms,
  listGroups, listPendingConfirms, loadBoard, markHoldSuggested, setGroupStatus, setGroupTier,
  setLightConfirmTrusted, upsertBoardEntry,
  type ProjectGroup, type ProjectGroupStatus,
} from "../src/projects.js";
import type { OrgConfirm } from "../src/projects.js";
import type { StoragePort } from "../src/storage/port.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function sha1hex(s: string): string { return createHash("sha1").update(s).digest("hex"); }
function memId(identity: string): string { return `mem-${sha1hex(identity).slice(0, 12)}`; }
/** fixture 造态守卫：CreateGroupResult 联合类型跨语句收窄（造态失败即炸，不静默续跑）。 */
function groupOf(r: { ok: boolean; group?: ProjectGroup }): ProjectGroup {
  if (!r.ok || !r.group) throw new Error("fixture 造态失败");
  return r.group;
}

// ---------- 0. 纪律 ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-parity-db-"));
process.env.CCR_DATA_DIR = dataDir;
const fx1 = mkdtempSync(join(tmpdir(), "cc-deck-parity-org1-")); // F1 现状证据
const fx2 = mkdtempSync(join(tmpdir(), "cc-deck-parity-org2-")); // 等价对照主库
process.env.CCR_ORG_DIR = join(dataDir, "org");
console.log("临时目录纪律:");
assert(dataDir.startsWith(tmpdir()) && fx1.startsWith(tmpdir()) && fx2.startsWith(tmpdir()) && process.env.CCR_ORG_DIR?.startsWith(tmpdir()) === true, "dataDir/双 fixture orgDir/CCR_ORG_DIR 全落 tmpdir 前缀");
assert(!fx1.startsWith(process.env.HOME ?? "~") && !fx2.startsWith(process.env.HOME ?? "~"), "fixture orgDir 不在生产 HOME 下");

const port: StoragePort = createSqlitePort({ dataDir, filename: "parity.sqlite3" });
port.open();
runMigrations(port, migrations);

// ---------- 1. fx1：F1 现状证据（真写路径包裹形 confirms.json → 现状行为） ----------
console.log("F1 现状证据（fx1 真包裹形）:");
setLightConfirmTrusted(true, fx1);
const f1g = createGroup({ name: "serious", anchor_dir: "/fx1/serious", tier: "正经立项" }, fx1);
assert(f1g.ok && f1g.confirm !== null, "fx1 真写路径：正经立项出单（confirms.json 落盘）");
addConfirm({ kind: "suggest-hold", title: "?", reason: "?", payload: { gid: groupOf(f1g).id } }, fx1);
const rawConfirms = JSON.parse(readFileSync(join(fx1, "confirms.json"), "utf8")) as { confirms: unknown[] };
assert(!Array.isArray(rawConfirms) && Array.isArray(rawConfirms.confirms) && rawConfirms.confirms.length === 2, "fx1 现场取证：confirms.json 实际格式={confirms:[…]} 包裹形（projects.ts:625 唯一写者）");
writeFileSync(join(fx1, "org.json"), JSON.stringify({ version: 1, leader_session_id: "s-l", created_at: 1 }, null, 2) + "\n");
const f1 = importOrg(port, fx1);
const f1ConfLoss = listLoss(port, join(fx1, "confirms.json"));
assert(f1.counts.orgConfirm === 0, "F1 现状：真包裹形 confirms.json 进 importOrg → org_confirm 0 行（整源拒）");
assert(f1ConfLoss.length === 1 && f1ConfLoss[0]?.reason === "bad-json" && (f1ConfLoss[0]?.excerpt ?? "").includes("confirms"), "F1 现状：该源落 bad-json 单账（excerpt=包裹形源文本）——生产格式与导入器脱节，发现清单 F1（P1）");
assert(f1.counts.group === 1 && f1.counts.project === 1, "F1 邻面：同轮组/project 照常导入（projects.json 包裹形被正确消费，坏源不阻断）");

// ---------- 2. fx2 旧写路径造态（S1 四态+复活边 / S2 tier+hold / S3 board / S4 confirms） ----------
console.log("旧写路径造态（fx2）:");
setLightConfirmTrusted(true, fx2);
const ra = createGroup({ name: "alpha", anchor_dir: "/px/alpha", tier: "轻立项" }, fx2);
assert(ra.ok && ra.group.status === "active" && ra.group.single_card === true, "旧读面：信任态下轻立项直达 active、single_card=tier 联动词（projects.ts:264）");
const rp = createGroup({ name: "parked-one", anchor_dir: "/px/parked", tier: "轻立项" }, fx2);
assert(rp.ok && rp.group.status === "active", "旧读面：第二轻立项同径 active");
const gP = groupOf(rp);
const rb = createGroup({ name: "serious", anchor_dir: "/px/serious", tier: "正经立项" }, fx2);
assert(rb.ok && rb.group.status === "pending" && rb.needsConfirm === true && rb.confirm?.kind === "project-create", "旧读面：正经立项 pending+自动出 project-create 确认单（§4 确认门槛）");

// S1 状态机：全 16 边结构化对照（权威表=projects.ts TRANSITIONS :220-225）
const ALL: ProjectGroupStatus[] = ["pending", "active", "parked", "archived"];
const EXPECTED_TRANSITIONS: Record<ProjectGroupStatus, ProjectGroupStatus[]> = {
  pending: ["active", "archived"],
  active: ["parked", "archived"],
  parked: ["active", "archived"],
  archived: ["active"],
};
let smEq = true;
for (const f of ALL) for (const t of ALL) { if (canTransition(f, t) !== EXPECTED_TRANSITIONS[f]!.includes(t)) smEq = false; }
assert(smEq && canTransition("archived", "active") && !canTransition("archived", "parked"), "S1 旧读面状态机全 16 边（archived→active 唯一复活边）——导入面 status 词表同域四态");
const gA = groupOf(ra).id;
const rbG = groupOf(rb);
const walk: Array<[ProjectGroupStatus, string?]> = [["parked"], ["active"], ["archived", "零异常归档"], ["active"]];
let walkOk = true;
for (const [to, note] of walk) { const r = setGroupStatus(gA, to, note, fx2); if (!r.ok) walkOk = false; }
assert(walkOk, "S1 旧读面：active→parked→active→archived→active 走通（复活边在机，walk 每边过 canTransition）");

// S2 tier 联动+hold
const tierR = setGroupTier(gA, "正经立项", fx2);
assert(tierR.ok && tierR.group.tier === "正经立项" && tierR.group.single_card === false, "S2 旧读面：升降级联动 single_card 翻转（projects.ts:345）");
const T_HOLD = 1700000000000;
markHoldSuggested(gP.id, T_HOLD, fx2);
const rpAfter = listGroups(fx2).find((x) => x.id === gP.id);
assert(rpAfter !== undefined && rpAfter.hold_suggested_at === T_HOLD && rpAfter.updated_at === gP.updated_at, "S2 旧读面：hold 戳落位且不动 updated_at（「建议」不是活动，projects.ts:765）");

// S3 board（旧读面语义；导入面范围边界见 §4）
const boardOps = [
  upsertBoardEntry(gA, { id: "card-done", text: "依赖源卡", status: "done" }, fx2),
  upsertBoardEntry(gA, { id: "card-dep", text: "被依赖卡", depends_on: ["card-done"] }, fx2),
  upsertBoardEntry(gA, { id: "card-gate", text: "设闸卡", gate: { reason: "CI 红" } }, fx2),
  upsertBoardEntry(gA, { id: "card-ghost", text: "坏引用卡", depends_on: ["ghost-missing"] }, fx2),
];
assert(boardOps.every((r) => r.ok), "S3 旧读面：板四卡写入（done/依赖/gate/坏引用）");
const board = loadBoard(gA, fx2);
const depCheck = computeReady(board.entries.find((e) => e.id === "card-dep")!, board);
const gateCheck = computeReady(board.entries.find((e) => e.id === "card-gate")!, board);
const ghostCheck = computeReady(board.entries.find((e) => e.id === "card-ghost")!, board);
assert(depCheck.ready === true && depCheck.gate_reason === null, "S3 旧读面 computeReady：依赖全 done→ready");
assert(gateCheck.ready === false && gateCheck.gate_reason === "CI 红", "S3 旧读面 computeReady：gate 在场=blocked 可判定（reason 透出，对应 task.gate_reason 非 NULL 即 blocked 派生态语义）");
assert(ghostCheck.ready === false && ghostCheck.reasons.some((r) => r.includes("ghost-missing")), "S3 旧读面 computeReady：坏引用按未就绪不炸（reasons 单列）");
assert(computeReadySet(board).length === 3, "S3 旧读面 computeReadySet：done 卡不进就绪集（3 张非 done）");

// S4 confirms：五 kind 全词表+两单决议（decided_by 两映射路径）
addConfirm({ kind: "tier-change", title: "升 alpha", reason: "忙不过来", payload: { gid: gA, to_tier: "正经立项" } }, fx2);
addConfirm({ kind: "suggest-hold", title: "建议暂缓", reason: "两周无活动", payload: { gid: gA } }, fx2);
const cArc = addConfirm({ kind: "archive", title: "结项 serious", reason: "试跑结束", payload: { gid: rbG.id } }, fx2);
addConfirm({ kind: "revive", title: "复活 parked", reason: "又要用", payload: { gid: gP.id } }, fx2);
const tierChangeId = listConfirms(fx2).find((c) => c.kind === "tier-change")!.id;
assert(decideConfirm(tierChangeId, true, "leader", fx2).ok && decideConfirm(cArc.id, false, "user-alice", fx2).ok, "S4 旧读面：两单决议（approved by leader / rejected by user-alice）");

// ---------- 3. 格式对齐（裸数组展开）+ 脏数据追加（S5），定格旧读面基准 ----------
console.log("S5 脏数据追加（confirms 展开为裸数组）:");
const oldGroups: ProjectGroup[] = listGroups(fx2); // 基准定格在手搓追加之前（只含写路径 3 组）
const oldConfirms: OrgConfirm[] = listConfirms(fx2); // 包裹形仍在（此刻 5 单：1 立项+4 手动）
const confFile = join(fx2, "confirms.json");
const bare = oldConfirms.slice() as unknown as Record<string, unknown>[]; // OrgConfirm 无索引签名，裸数组展开走 unknown 桥
bare.push({ id: "c-nopayload", kind: "project-create", title: "?", reason: "?", status: "pending", created_at: 10 }); // 缺 payload→缺归因
bare.push({ id: "c-dang2", kind: "archive", title: "?", reason: "?", payload: { gid: "g-nope" }, status: "pending", created_at: 11 }); // gid 悬空
bare.push({ id: "c-nodecided", kind: "suggest-hold", title: "?", reason: "?", payload: { gid: gA }, status: "rejected", created_at: 12 }); // 缺 decided_at/decided_by→NULL 零 loss
writeFileSync(confFile, JSON.stringify(bare, null, 2) + "\n", "utf8"); // F1 格式对齐假设面：裸数组
utimesSync(confFile, new Date(Date.now() + 5), new Date(Date.now() + 5));

const projFile = join(fx2, "projects.json");
const pf = JSON.parse(readFileSync(projFile, "utf8")) as { groups: Record<string, unknown>[] };
const sparseIdx = pf.groups.length; // g-sparse 元素序（0-based；loss lineNo=idx+1）
pf.groups.push({ id: "g-sparse", name: "sparse", anchor_dir: "/px/sparse", status: "active", tier: "轻立项", headcount: [{ session_id: "s-ok", role: "dev", engine: "codex" }, { session_id: "s-bad" }] }); // 缺 created_at/updated_at/role_defaults/hold/archive_note/single_card；headcount 第二条缺 role
pf.groups.push({ id: "g-noname", anchor_dir: "/px/noname", status: "active", tier: "轻立项", created_at: 1, updated_at: 2, headcount: [{ session_id: "s-n", role: "qa", engine: "codex" }] }); // 缺 name→组拒入
pf.groups.push({ id: "g-doing", name: "legacy", anchor_dir: "/px/doing", status: "doing", tier: "轻立项", created_at: 3, updated_at: 4, headcount: [{ session_id: "s-d", role: "dev", engine: "claude" }] }); // status 词表外→拒入
writeFileSync(projFile, JSON.stringify(pf, null, 2) + "\n", "utf8");
writeFileSync(join(fx2, "org.json"), JSON.stringify({ version: 1, leader_session_id: "sess-leader", created_at: 1700000000000 }, null, 2) + "\n");
oldConfirms.push(...(bare.slice(5) as unknown as OrgConfirm[])); // 脏 3 单并入读面基准（展开后 listConfirms 不再可用）
assert(oldGroups.length === 3 && oldConfirms.length === 8, "基准定格：写路径组 3（手搓在定格后，拒入面归 loss 对账）+ 单 8（5 真+3 脏）");

// ---------- 4. 导入+等价对照（S1/S2/S4/S5 逐面） ----------
console.log("等价对照（首轮导入）:");
const r1 = importOrg(port, fx2);
assert(r1.skipped === false && r1.rescanned.length === 3, "首轮三源全重扫");

// 行级对照 helper：旧读面组 ↔ group 行逐列
function groupRow(id: string): Record<string, unknown> | undefined {
  return port.query(`SELECT * FROM "group" WHERE id = ?`, [id])[0] as Record<string, unknown> | undefined;
}
function eqGroup(g: ProjectGroup, row: Record<string, unknown> | undefined): boolean {
  return row !== undefined
    && row.id === g.id && row.name === g.name && row.anchor_dir === g.anchor_dir
    && row.status === g.status && row.tier === g.tier
    && row.single_card === (g.single_card === true ? 1 : 0)
    && row.headcount_json === JSON.stringify(g.headcount ?? [])
    && row.role_defaults_json === JSON.stringify(g.role_defaults ?? {})
    && (row.hold_suggested_at ?? null) === (g.hold_suggested_at ?? null)
    && (row.archive_note ?? null) === (g.archive_note ?? null)
    && row.created_at === (g.created_at ?? 0) && row.updated_at === g.updated_at;
}
const rows4 = port.query<{ id: string }>(`SELECT id FROM "group"`);
assert(rows4.length === 4 && rows4.every((r) => ["g-sparse", gA, gP.id, rbG.id].includes(r.id)), "组行=写路径 3 组+手搓合法 sparse（拒入 2 组零落行）");
const validGroups = rows4.map((r) => r.id);
assert(oldGroups.filter((g) => validGroups.includes(g.id)).every((g) => eqGroup(g, groupRow(g.id))), "S1/S2 等价：写路径 3 组逐列全等（status/tier/single_card/headcount_json/role_defaults_json/hold/archive_note/双戳）");
const rowA = groupRow(gA);
assert(rowA !== undefined && rowA.status === "active" && rowA.archive_note === "零异常归档", "S1 复活边：导入行 status=active（复活终态）且 archive_note 归档词保留（复活不清注，两源同语义 projects.ts:331）");
const oldA = oldGroups.find((g) => g.id === gA)!;
assert(typeof oldA.archived_at === "number" && typeof oldA.parked_at === "number", "S1 旧读面：parked_at/archived_at 历史戳在读（复活不清戳）");
const gCols = port.query("PRAGMA table_info(\"group\")").map((c) => (c as { name: string }).name);
assert(!gCols.includes("parked_at") && !gCols.includes("archived_at"), "S1 已知差异（显式登记 F2）：导入面无 parked_at/archived_at 列——挂起/结项时间戳不随导入，仅 archive_note/updated_at 承载");

// S2 脏数据等价缺口：轻立项+single_card 缺失
const rowSparse = groupRow("g-sparse");
if (rowSparse === undefined) throw new Error("S5: g-sparse 行缺失（手搓合法组应已落行）");
assert(rowSparse.tier === "轻立项" && rowSparse.single_card === 0, "S2 已知差异（显式登记 F3）：旧脏行轻立项缺 single_card→导入行 0（原样不推导；projects.ts 联动词应得 1——导入器不猜值原则，差异备案）");
assert(rowSparse.created_at === 0 && rowSparse.updated_at === 0 && rowSparse.hold_suggested_at === null && rowSparse.archive_note === null && rowSparse.role_defaults_json === "{}" && rowSparse.headcount_json === JSON.stringify([{ session_id: "s-ok", role: "dev", engine: "codex" }, { session_id: "s-bad" }]), "S5 缺省面：created_at/updated_at=0、hold/archive_note=NULL、role_defaults={}、headcount 原样快照（member 面才清洗）");

// S2 hold：g-p 行两戳与旧读面同源
const oldP = oldGroups.find((g) => g.id === gP.id)!;
const rowP = groupRow(gP.id);
assert(rowP !== undefined && rowP.hold_suggested_at === T_HOLD && oldP.hold_suggested_at === T_HOLD && rowP.updated_at === oldP.updated_at, "S2 hold 等价：暂缓戳两源同值、updated_at 同不被扰动");

// S3 导入面范围边界：board 旧读有、组织域导入面无对应物（归 D/E 线）
assert((port.query<{ n: number }>("SELECT COUNT(*) AS n FROM task")[0]?.n ?? -1) === 0 && (port.query<{ n: number }>("SELECT COUNT(*) AS n FROM lesson")[0]?.n ?? -1) === 0, "S3 范围边界：boards/*.json 不进组织域五表（task/lesson 0 行——entries→task/lessons→lesson 归 D/E 线，import-org.ts:4）");
assert(existsSync(join(fx2, "boards", `${gA}.json`)), "S3 旧读面：板文件在（freezeBoard 随状态转移落盘）——等价对照的旧源真实存在");

// S4 confirms 逐单对照（旧读面基准=内存 oldConfirms，对照裸数组导入行）
const confRows = port.query<{ id: string; kind: string; group_id: string | null; title: string; reason: string; payload_json: string; status: string; created_at: number; decided_at: number | null; decided_by: string | null }>("SELECT * FROM org_confirm");
assert(confRows.length === oldConfirms.length, `确认单行数=旧读面单数（${confRows.length}=${oldConfirms.length}）`);
const leaderId = memId(`${fx2}@leader@`);
assert(leaderId === port.query<{ id: string }>("SELECT id FROM member WHERE stable_identity LIKE '%@leader@'")[0]?.id, "Leader member id=sha12(<orgDir>@leader@)（对照基准）");
let confEq = true;
for (const c of oldConfirms) {
  const row = confRows.find((r) => r.id === c.id);
  if (!row) { confEq = false; break; }
  const gid = typeof (c.payload as Record<string, unknown> | undefined)?.gid === "string" ? (c.payload as Record<string, unknown>).gid as string : null;
  const wantDecidedBy = c.decided_by === "leader" ? leaderId : (c.decided_by ?? null);
  if (row.kind !== c.kind || row.title !== c.title || row.reason !== c.reason || row.status !== c.status
    || row.created_at !== c.created_at || (row.decided_at ?? null) !== (c.decided_at ?? null)
    || (row.decided_by ?? null) !== wantDecidedBy
    || JSON.stringify(JSON.parse(row.payload_json)) !== JSON.stringify(c.payload ?? {})
    || row.group_id !== (gid !== null && validGroups.includes(gid) ? gid : null)) { confEq = false; break; }
}
assert(confEq, "S4 等价：8 单逐字段全等（kind/title/reason/status/created_at/decided_at/payload_json 深等/group_id 归因——合法 gid 落行、悬空/缺 payload 归 NULL）");
assert(confRows.find((r) => r.id === tierChangeId)?.decided_by === leaderId, "S4 decided_by 映射：'leader'→Leader member id");
assert(confRows.find((r) => r.id === cArc.id)?.decided_by === "user-alice", "S4 decided_by：非 leader 串原样保留（不猜映射）");
assert(confRows.filter((r) => r.status === "pending").length === oldConfirms.filter((c) => c.status === "pending").length, "S4 pending 面等价：行态 pending 数=旧读面 pending 数");
const kindSet = new Set(confRows.map((r) => r.kind));
assert(kindSet.size === 5 && ["project-create", "tier-change", "suggest-hold", "archive", "revive"].every((k) => kindSet.has(k)), "S4 词表等价：五 kind 全在（与 ConfirmKind 同域）");
const rowNoDecided = confRows.find((r) => r.id === "c-nodecided");
assert(rowNoDecided !== undefined && rowNoDecided.decided_at === null && rowNoDecided.decided_by === null && rowNoDecided.status === "rejected", "S5 缺省面：缺 decided_at/decided_by→NULL 落行（不猜决议人）零 loss");

// S5 loss 对号入座（file:line:reason 对号，不猜值）
console.log("S5 loss 对账:");
const lossP = listLoss(port, projFile);
const lossC = listLoss(port, confFile);
const reasonsP = lossP.map((l) => `${l.lineNo}:${l.reason}`).sort().join();
assert(lossP.length === 5 && reasonsP === [`${sparseIdx + 1}:missing-field`, `${sparseIdx + 2}:missing-field`, `${sparseIdx + 3}:bad-field`, "0:dangling-ref", "0:dangling-ref"].sort().join(), `S5 projects.json 5 账对号：sparse 坏 headcount 条目/noname 缺 name/doing 词表外+两拒入组关系悬空账（组拒入无行号可指→lineNo=0，导入器现状）（实测 ${reasonsP}）`);
assert(lossC.length === 2 && lossC.map((l) => `${l.lineNo}:${l.reason}`).sort().join() === "6:missing-attribution,7:dangling-ref", "S5 confirms.json 2 账对号：缺 payload=missing-attribution、gid 悬空=dangling-ref（裸数组元素序=lineNo）");
assert((port.query<{ n: number }>("SELECT COUNT(*) AS n FROM member WHERE stable_identity = ?", [`${fx2}@qa@codex`])[0]?.n ?? 0) === 1, "S5 成员面：拒入组（noname）的 headcount 成员照导（冻结件 §4：headcount 是成员存在的事实）");
assert((port.query<{ n: number }>("SELECT COUNT(*) AS n FROM group_member WHERE group_id IN ('g-noname','g-doing')")[0]?.n ?? 0) === 0, "S5 关系面：拒入组零 group_member（悬空落账不造关联）");
assert((port.query<{ n: number }>("SELECT COUNT(*) AS n FROM group_member WHERE group_id = 'g-sparse'")[0]?.n ?? 0) === 1, "S5 关系面：合法组坏条目剔除后关系恰 1 条（s-ok）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "全库零悬空 FK");

// ---------- 5. 等价的时间维度（S6：快进/重扫同步） ----------
console.log("S6 时间维度:");
const r2 = importOrg(port, fx2);
assert(r2.skipped === true && r2.counts.group === 4 && r2.counts.orgConfirm === oldConfirms.length, "同源快进：skipped=true、行数=基准现值（零漂移）");
assert(listLoss(port).filter((l) => l.sourcePath.startsWith(fx2)).length === lossP.length + lossC.length, "快进零写入：fx2 loss 存量不变（全账另含 fx1 的 F1 证据账）");
const toActive = setGroupStatus(gP.id, "active", undefined, fx2); // 注意 note?/dir? 位次：fx2 须落 dir 位
if (!toActive.ok) console.error(`  [诊断] setGroupStatus 失败: ${JSON.stringify(toActive)}`);
const rpNow = listGroups(fx2).find((g) => g.id === gP.id);
if (rpNow?.status !== "active") console.error(`  [诊断] rp 组现状: ${JSON.stringify({ id: gP.id, status: rpNow?.status, all: listGroups(fx2).map((g) => `${g.id}:${g.status}`) })}`);
assert(toActive.ok && rpNow?.status === "active", "旧写路径再动：parked→active（状态机合法边）");
utimesSync(projFile, new Date(Date.now() + 10), new Date(Date.now() + 10));
const r3 = importOrg(port, fx2);
assert(r3.skipped === false && r3.rescanned.includes(projFile), "源变化失效→重扫");
const rowP2 = groupRow(gP.id);
assert(rowP2 !== undefined && rowP2.status === "active" && rowP2.updated_at === listGroups(fx2).find((g) => g.id === gP.id)?.updated_at, "重扫后导入行追平新读面（status=active、updated_at 同源）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "重扫后仍零悬空 FK");

port.close();
rmSync(dataDir, { recursive: true, force: true });
rmSync(fx1, { recursive: true, force: true });
rmSync(fx2, { recursive: true, force: true });

console.log(`Import org parity: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
