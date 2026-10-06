// M11-E1 notification 双层导入器测试：fixture 驱动（自制小样 dataDir，零生产触达）。
// 范式沿用 test-import-org（mkdtemp+env 全清+assert 计数+两轮连跑）。
// fixture 布局：notifications.json（投影源 5 条：双 client 读态/resolved/全局 dismissed/缺 key/
//   缺 created_at）+ decision-notifications.json（ledger 4 条：同 k-1 跨源归并/仅 ledger k-6/
//   缺 key/k-1 同源重复）；段 6 重写投影源（重复 client_id 去重保护，P2-1 回归锁）。
// 注意：loss 的 lineNo = 数组元素序（idx+1），非 JSON 物理行号（与 C1 口径一致）。
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSqlitePort } from "../src/storage/sqlite.js";
import { runMigrations } from "../src/storage/migrator.js";
import { migrations } from "../src/storage/schema.js";
import { importNotifications, NOTIFICATION_IMPORT_SCHEMA_VERSION } from "../src/storage/import-notification.js";
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
function ntfId(key: string): string { return `ntf-${sha1hex(key).slice(0, 12)}`; }

// ---------- 0. 启动前纪律 ----------
const dataDir = mkdtempSync(join(tmpdir(), "cc-deck-import-ntf-"));
process.env.CCR_DATA_DIR = dataDir;
console.log("临时目录纪律:");
assert(dataDir.startsWith(tmpdir()), "fixture dataDir 落 tmpdir 前缀（零生产写入前提）");
assert(!dataDir.startsWith(process.env.HOME ?? "~"), "fixture dataDir 不在生产 HOME 下（不动 ~/.cc-deck）");

const port: StoragePort = createSqlitePort({ dataDir, filename: "import.sqlite3" });
port.open();
runMigrations(port, migrations);

// ---------- fixture ----------
const T = 1700000000000;
const projFile = join(dataDir, "notifications.json");
const ledgerFile = join(dataDir, "decision-notifications.json");
writeFileSync(projFile, JSON.stringify({
  notifications: [
    { key: "k-1", kind: "org-confirm", group: "action", severity: "waiting", title: "确认升级", body: "alpha 请求升级", sourceContext: { domain: "org-confirm", entityId: "oc-1", sessionId: "sess-a", alertId: "al-1", returnPath: "/org/confirm/oc-1" }, actionable: true, created_at: T + 1, client_states: [{ client_id: "phone", read_at: T + 5 }, { client_id: "desktop", read_at: T + 6, dismissed_at: T + 7 }] },
    { key: "k-2", kind: "dispatch", group: "activity", severity: "done", title: "派单完成", body: "d-1 已完成", sourceContext: { domain: "dispatch", entityId: "d-1", sessionId: "sess-b", alertId: "al-2", returnPath: "/dispatch/d-1" }, actionable: false, created_at: T + 2, resolved_at: T + 8 },
    { key: "k-3", kind: "waiting", group: "attention", severity: "error", title: "等待输入", body: "s-3 等待用户", sourceContext: { domain: "waiting", entityId: "w-1", sessionId: "sess-c", alertId: "al-3", returnPath: "" }, actionable: true, created_at: T + 3, dismissed_at: T + 9 },
    { kind: "system", group: "activity", severity: "info", title: "缺 key", body: "x", sourceContext: { domain: "system", entityId: "e-4", alertId: "al-4", returnPath: "" }, actionable: false, created_at: T + 4 },
    { key: "k-5", kind: "system", group: "activity", severity: "info", title: "缺 created_at", body: "x", sourceContext: { domain: "system", entityId: "e-5", alertId: "al-5", returnPath: "" }, actionable: false },
  ],
}, null, 2) + "\n");
writeFileSync(ledgerFile, JSON.stringify([
  { key: "k-1", kind: "org-confirm", source_session_id: "sess-ledger", created_at: T, first_sent_at: T - 100, group: "action", actionable: true, revision: "r2" },
  { key: "k-6", kind: "acceptance", source_session_id: "sess-6", created_at: T + 10, first_sent_at: T + 9, group: "action", actionable: true, revision: "r1" },
  { kind: "system", source_session_id: "sess-7", created_at: T + 11, actionable: false },
  { key: "k-1", kind: "org-confirm", source_session_id: "sess-ledger-2", created_at: T + 50, actionable: true },
], null, 2) + "\n");

// ---------- 1. 全量导入：行数+双层字段映射（验收 1/2/3） ----------
console.log("全量导入:");
const r1 = importNotifications(port, dataDir);
assert(r1.skipped === false && r1.rescanned.length === 2, "两源全重扫（首轮无 checkpoint）");
assert(r1.counts.notification === 4 && r1.counts.clientState === 2, `双层行数 实体 4/client 2 与 fixture 期望一致（实测 ${JSON.stringify(r1.counts)}）`);
// k-1 跨源归并行：投影字段优先 + created_at 取较早 + ledger 专有字段进 payload
const k1 = port.query<{ id: string; category: string; level: string; session_id: string | null; handled_at: number | null; resolved_at: number | null; condition_key: string; created_at: number; payload_json: string }>("SELECT * FROM notification WHERE condition_key = 'k-1'")[0];
const k1Payload = JSON.parse(k1?.payload_json ?? "{}") as { title?: string; source_context?: { returnPath?: string }; ledger?: { first_sent_at?: number; revision?: string } };
assert(k1 !== undefined && k1.id === ntfId("k-1") && k1.category === "org-confirm" && k1.level === "waiting" && k1.session_id === "sess-a" && k1.created_at === T, "k-1 跨源归并：id 确定性、投影 kind/severity/sessionId 优先、created_at 取较早（T 非 T+1）");
assert(k1.handled_at === null && k1.resolved_at === null && k1.condition_key === "k-1", "k-1：无 handled/resolved（per-device dismiss 不下沉实体）");
assert(k1Payload.title === "确认升级" && k1Payload.source_context?.returnPath === "/org/confirm/oc-1" && k1Payload.ledger?.first_sent_at === T - 100 && k1Payload.ledger?.revision === "r2", "k-1 payload：投影 title/sourceContext 与 ledger 专有 first_sent_at/revision 双源收编不丢");
// k-2 resolved 语义
const k2 = port.query<{ level: string; resolved_at: number | null; handled_at: number | null; session_id: string | null }>("SELECT level, resolved_at, handled_at, session_id FROM notification WHERE condition_key = 'k-2'")[0];
assert(k2 !== undefined && k2.level === "done" && k2.resolved_at === T + 8 && k2.handled_at === null && k2.session_id === "sess-b", "k-2：resolved_at 落实体、handled 独立不混写");
// k-3 全局 dismiss → handled 下沉（isHandled 语义）
const k3 = port.query<{ level: string; handled_at: number | null; resolved_at: number | null }>("SELECT level, handled_at, resolved_at FROM notification WHERE condition_key = 'k-3'")[0];
assert(k3 !== undefined && k3.level === "error" && k3.handled_at === T + 9 && k3.resolved_at === null, "k-3：全局 dismissed_at 下沉 handled_at（isHandled 语义）、returnPath 空串不落 unmapped 账");
// k-6 仅 ledger：severity 推导 + source_session_id 归因
const k6 = port.query<{ level: string; category: string; session_id: string | null; created_at: number; payload_json: string }>("SELECT level, category, session_id, created_at, payload_json FROM notification WHERE condition_key = 'k-6'")[0];
const k6Payload = JSON.parse(k6?.payload_json ?? "{}") as { ledger?: { revision?: string } };
assert(k6 !== undefined && k6.level === "waiting" && k6.category === "acceptance" && k6.session_id === "sess-6" && k6.created_at === T + 10 && k6Payload.ledger?.revision === "r1", "k-6 仅 ledger：level 按投影同向推导（actionable 未 resolved→waiting）、source_session_id 归因、revision 进 payload");
// per-client 读态：复合主键两行、互不覆盖、read 不污染实体
const cs = port.query<{ client_id: string; read_at: number | null; dismissed_at: number | null }>("SELECT client_id, read_at, dismissed_at FROM notification_client_state WHERE notification_id = ? ORDER BY client_id", [ntfId("k-1")]);
assert(cs.length === 2 && cs[0]?.client_id === "desktop" && cs[0]?.read_at === T + 6 && cs[0]?.dismissed_at === T + 7 && cs[1]?.client_id === "phone" && cs[1]?.read_at === T + 5 && cs[1]?.dismissed_at === null, "per-client 读态落 client_state（复合主键两行）：desktop read+dismiss、phone 仅 read");
assert(cs[0]?.read_at !== cs[1]?.read_at, "双设备读态互不覆盖（phone/desktop read_at 各归各）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "PRAGMA foreign_key_check 零行（双层零悬空 FK）");

// ---------- 2. loss 对账（验收 5 前半） ----------
console.log("loss 对账:");
const lossProj = listLoss(port, projFile);
const lossLedger = listLoss(port, ledgerFile);
assert(lossProj.length === 4 && lossProj.filter((l) => l.reason === "unmapped-field").length === 2 && lossProj.filter((l) => l.reason === "missing-field").length === 2, "投影源 4 账：returnPath unmapped×2（k-1/k-2）+ 缺字段 missing×2（n-4/n-5）");
assert(lossProj.find((l) => l.reason === "unmapped-field" && l.lineNo === 1) !== undefined && lossProj.find((l) => l.reason === "missing-field" && l.lineNo === 4) !== undefined, "投影源 file:line 精确（line1 unmapped、line4 missing，元素序口径）");
assert(lossLedger.length === 2 && lossLedger.find((l) => l.reason === "missing-field" && l.lineNo === 3) !== undefined && lossLedger.find((l) => l.reason === "duplicate-key" && l.lineNo === 4) !== undefined, "ledger 2 账：缺 key missing（line3）+ k-1 同源重复 duplicate-key（line4）；k-1 跨源归并不误账");
assert(listLoss(port).length === 6, "loss 总账 6 条（投影 4 + ledger 2）");

// ---------- 3. 重复运行幂等（验收 4 前半） ----------
console.log("幂等:");
const r2 = importNotifications(port, dataDir);
assert(r2.skipped === true, "重复运行走 checkpoint 快进（skipped=true）");
assert(r2.counts.notification === 4 && r2.counts.clientState === 2, "双层行数不增（幂等实证）");
assert(listLoss(port).length === 6, "快进零写入：loss 总账不变（不重复落账）");
assert([projFile, ledgerFile].every((f) => {
  const st = statSync(f);
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return readCheckpoint(port, f, { mtimeMs: Math.round(st.mtimeMs), lineCount: lines.length, schemaVersion: NOTIFICATION_IMPORT_SCHEMA_VERSION }) !== null;
}), "两源 checkpoint 记录在位且有效（五元组命中）");

// ---------- 4. 源变化失效重扫：旧数据不残留（验收 4 后半） ----------
console.log("源变化重扫:");
writeFileSync(projFile, JSON.stringify({
  notifications: [
    { key: "k-1", kind: "org-confirm", group: "action", severity: "waiting", title: "确认升级", body: "alpha 请求升级", sourceContext: { domain: "org-confirm", entityId: "oc-1", sessionId: "sess-a", alertId: "al-1", returnPath: "/org/confirm/oc-1" }, actionable: true, created_at: T + 1, client_states: [{ client_id: "phone", read_at: T + 5 }, { client_id: "desktop", read_at: T + 6, dismissed_at: T + 7 }] },
    { key: "k-3", kind: "waiting", group: "attention", severity: "error", title: "等待输入", body: "s-3 等待用户", sourceContext: { domain: "waiting", entityId: "w-1", sessionId: "sess-c", alertId: "al-3", returnPath: "" }, actionable: true, created_at: T + 3, dismissed_at: T + 9 },
    { key: "k-8", kind: "system", group: "activity", severity: "info", title: "新通知", body: "n-8", sourceContext: { domain: "system", entityId: "e-8", alertId: "al-8", returnPath: "" }, actionable: false, created_at: T + 20 },
  ],
}, null, 2) + "\n");
utimesSync(projFile, new Date(Date.now() + 10), new Date(Date.now() + 10)); // 防同毫秒 mtime 巧合
const r3 = importNotifications(port, dataDir);
assert(r3.skipped === false && r3.rescanned.includes(projFile) && r3.rescanned.includes(ledgerFile), "投影源失效→域重扫（两源都重灌）");
assert(r3.counts.notification === 4 && r3.counts.clientState === 2, `重灌后行数与新期望一致 实体 4/client 2（实测 ${JSON.stringify(r3.counts)}）`);
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification WHERE condition_key = 'k-2'")[0]?.n === 0, "旧数据不残留：已删的 k-2 实体行随域清消失");
const k8 = port.query<{ level: string; category: string; session_id: string | null; handled_at: number | null }>("SELECT level, category, session_id, handled_at FROM notification WHERE condition_key = 'k-8'")[0];
assert(k8 !== undefined && k8.level === "info" && k8.category === "system" && k8.session_id === null && k8.handled_at === null, "新增 k-8 导入：system 类合法无归因 session_id NULL（不造关联不落账）");
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification_client_state WHERE notification_id = ?", [ntfId("k-1")])[0]?.n === 2, "k-1 双设备读态随源重灌不丢（重扫语义）");
const lossAfter = listLoss(port);
assert(lossAfter.filter((l) => l.sourcePath === projFile).length === 1 && lossAfter.filter((l) => l.sourcePath === ledgerFile).length === 2, "重扫按源清旧 loss 再落新账：投影源 n-2/n-4/n-5 旧账清除余 1、ledger 重灌同 2");
assert(port.query("PRAGMA foreign_key_check").length === 0, "重扫后仍零悬空 FK");

// ---------- 5. 整文件坏 JSON：该源零导入+落账，其余源照常（范式要点 4） ----------
console.log("坏 JSON 保护:");
writeFileSync(ledgerFile, "{ 这不是 JSON");
utimesSync(ledgerFile, new Date(Date.now() + 20), new Date(Date.now() + 20));
const r4 = importNotifications(port, dataDir);
assert(r4.skipped === false, "ledger 失效触发重扫");
assert(r4.counts.notification === 3, "坏 JSON 源的实体（仅 ledger 的 k-6）随域清消失，投影源 3 行照常");
assert(r4.counts.clientState === 2, "投影源 per-client 读态不受坏源影响");
const badLoss = listLoss(port, ledgerFile);
assert(badLoss.length === 1 && badLoss[0]?.reason === "bad-json" && badLoss[0]?.lineNo === 1, "坏 JSON 落账恰 1 条（line 1），旧 ledger 账清零");
assert(port.query("PRAGMA foreign_key_check").length === 0, "坏源重扫后仍零悬空 FK");

// ---------- 6. 同条目重复 client_id：去重后写赢不炸域（M11-REVIEW2 P2-1 回归锁） ----------
// 修复缺陷：client_state 裸 INSERT PK(notification_id,client_id)，同条目重复 client_id 撞
// UNIQUE 整域硬失败（修复前本段 importNotifications 直接抛异常）。修法：同条目内按 client_id
// 去重后写赢（当前态投影：后写=该设备较新 read/dismiss 态）+ duplicate-key 落账。
console.log("重复 client_id 保护:");
writeFileSync(projFile, JSON.stringify({
  notifications: [
    { key: "k-dup", kind: "system", group: "activity", severity: "info", title: "重复设备", body: "x", sourceContext: { domain: "system", entityId: "e-d1", alertId: "al-d1", returnPath: "" }, actionable: false, created_at: T + 30, client_states: [{ client_id: "phone", read_at: T + 31 }, { client_id: "phone", read_at: T + 32, dismissed_at: T + 33 }] },
    { key: "k-ok", kind: "system", group: "activity", severity: "info", title: "正常设备", body: "x", sourceContext: { domain: "system", entityId: "e-d2", alertId: "al-d2", returnPath: "" }, actionable: false, created_at: T + 34, client_states: [{ client_id: "tab", read_at: T + 35 }] },
  ],
}, null, 2) + "\n");
utimesSync(projFile, new Date(Date.now() + 100), new Date(Date.now() + 100));
const r6 = importNotifications(port, dataDir);
assert(r6.skipped === false && r6.counts.notification === 2, `同条目重复 client_id 不炸域：导入成功实体 2 行（修复前 UNIQUE 抛异常整域回滚，实际 ${r6.counts.notification}）`);
const dupRows = port.query<{ client_id: string; read_at: number | null; dismissed_at: number | null }>(
  "SELECT client_id, read_at, dismissed_at FROM notification_client_state WHERE notification_id = ?", [ntfId("k-dup")]);
assert(dupRows.length === 1 && dupRows[0]?.client_id === "phone" && dupRows[0]?.read_at === T + 32 && dupRows[0]?.dismissed_at === T + 33,
  `同条目按 client_id 去重后写赢：两条归一行、末条（较新态）生效（实测 ${JSON.stringify(dupRows)}）`);
assert(port.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification_client_state WHERE notification_id = ?", [ntfId("k-ok")])[0]?.n === 1,
  "无重复条目照常落行（k-ok tab 一行）");
const dupLoss = listLoss(port, projFile);
assert(dupLoss.length === 1 && dupLoss[0]?.reason === "duplicate-key" && dupLoss[0]?.lineNo === 1 && (dupLoss[0]?.excerpt as string).includes("phone"),
  "重复 client_id 落 duplicate-key 账恰 1 条（line 1 元素序，excerpt 带 client_id）");
assert(port.query("PRAGMA foreign_key_check").length === 0, "去重后零悬空 FK");

port.close();
rmSync(dataDir, { recursive: true, force: true });

console.log(`Import notification: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
