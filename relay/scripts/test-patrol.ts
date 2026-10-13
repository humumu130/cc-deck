// W-PATROL 巡检哨兵专项测试：
// ① worker 帧停滞（WORKING >40min）→ 告警；健康/compacting → 不告警
// ② 看板漂移（claimed 停滞>48h / submitted 积压）→ 告警
// ③ 去重：同条件不重推，解除→恢复行
// ④ 开关：enabled=false → runFull/runLight no-op
// ⑤ 轻探针：report 落盘 + dataDir 可写探针
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { PatrolModule } from "../src/patrol.js";
import type { Envelope } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; process.exitCode = 1; }
  else console.log(`ok - ${msg}`);
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DATA = mkdtempSync(join(tmpdir(), "ccr-patrol-"));
process.env.CCR_DATA_DIR = DATA;
const ORG = mkdtempSync(join(tmpdir(), "ccr-patrol-org-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_NO_LEADER = "1";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STORAGE_READ_MODE = "json"; // W-PATROL：JSON fixture 读模式（缺省=sqlite 找不到库→空 groups）

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const notes: string[] = [];
bus.subscribe((e) => {
  if (e.type === "TASK_DONE") {
    const done = (e.payload as { done?: string[] }).done ?? [];
    notes.push(...done);
  }
});

const mod = new PatrolModule(mgr, {
  dataDir: DATA,
  reportPath: join(DATA, "patrol-report.md"),
  enabled: () => process.env.CCR_PATROL !== "0",
});

// ---------- ① worker 帧新鲜度 ----------
{
  // 停滞 worker：WORKING + updated_at 60min 前
  const s1 = mgr.ensureExternal("ext-patrol-stale", "/tmp/patrol", "停滞验证", "patrol-stale-1");
  mgr.setExternalCliPid("ext-patrol-stale", process.pid);
  s1.status = "WORKING";
  s1.updated_at = Date.now() - 60 * 60_000;
  // 健康 worker：WORKING + updated_at 现在
  const s2 = mgr.ensureExternal("ext-patrol-fresh", "/tmp/patrol", "健康验证", "patrol-fresh-1");
  s2.status = "WORKING";
  // compacting worker：停滞但压缩期静默合法
  const s3 = mgr.ensureExternal("ext-patrol-compacting", "/tmp/patrol", "压缩验证", "patrol-cmp-1");
  s3.status = "WORKING";
  s3.compacting = true;
  s3.updated_at = Date.now() - 90 * 60_000;
}
mod.runFull();
await wait(50);
assert(notes.some((n) => n.includes("停滞>40min")), "① WORKING 停滞 60min → 告警推用户");
assert(notes.some((n) => n.includes("停滞验证")), "① 告警含会话标题");
assert(!notes.some((n) => n.includes("健康验证")), "① 健康会话不误报");
assert(!notes.some((n) => n.includes("压缩验证")), "① compacting 停滞不误报（压缩期静默合法）");

// ---------- ③ 去重：同条件不重推 ----------
const countAfterFirst = notes.length;
mod.runFull();
await wait(50);
assert(notes.length === countAfterFirst, "③ 同条件不重推（onset-only 去重）");

// ---------- ② 条件解除 → 恢复行（不推用户，只落报告） ----------
{
  const s1 = mgr.ensureExternal("ext-patrol-stale", "/tmp/patrol", "停滞验证", "patrol-stale-1");
  s1.updated_at = Date.now(); // 恢复
}
mod.runFull();
await wait(50);
assert(notes.length === countAfterFirst, "③ 恢复不推用户（只落报告）");
assert(readFileSync(join(DATA, "patrol-report.md"), "utf-8").includes("RECOVERED [worker-stale]"), "③ 恢复行落报告");

// ---------- ② 看板漂移（org/boards fixture） ----------
{
  const orgDir = join(ORG, "boards");
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [
    { id: "pg-patrol", name: "巡检测试组", status: "active", tier: "core", anchor_dir: "/tmp/patrol", headcount: [], single_card: false, created_at: Date.now(), updated_at: Date.now() },
  ], trust_light: null }));
  const now = Date.now();
  writeFileSync(join(orgDir, "pg-patrol.json"), JSON.stringify({
    gid: "pg-patrol",
    entries: [
      { id: "e1", text: "停滞 72h 的 claimed 条目", status: "claimed", updated_at: now - 72 * 3600_000 },
      { id: "e2", text: "待验收条目", status: "submitted", updated_at: now },
    ],
  }));
}
mod.runFull();
await wait(50);
assert(notes.some((n) => n.includes("claimed 停滞>48h")), "② claimed 停滞>48h → 告警");
assert(notes.some((n) => n.includes("submitted 待验收")), "② submitted 积压 → 告警");

// ---------- ④ 开关 off → no-op ----------
{
  const s4 = mgr.ensureExternal("ext-patrol-off", "/tmp/patrol", "开关验证", "patrol-off-1");
  s4.status = "WORKING";
  s4.updated_at = Date.now() - 60 * 60_000;
}
process.env.CCR_PATROL = "0";
const notesBeforeOff = notes.length;
mod.runFull();
await wait(50);
assert(notes.length === notesBeforeOff, "④ CCR_PATROL=0 → 巡检 no-op");
delete process.env.CCR_PATROL;

// ---------- ⑤ 轻探针：report 落盘 ----------
mod.runLight();
await wait(50);
const report = readFileSync(join(DATA, "patrol-report.md"), "utf-8");
assert(report.includes("light:"), "⑤ 轻探针 report 落盘");
assert(report.includes("disk="), "⑤ 轻探针含磁盘余量");
assert(existsSync(join(DATA, ".patrol-probe")), "⑤ dataDir 可写探针落盘");

// ---------- start/stop 生命周期 ----------
{
  process.env.CCR_PATROL_LIGHT_MS = "100";
  const m2 = new PatrolModule(mgr, { dataDir: DATA, reportPath: join(DATA, "patrol-report.md"), enabled: () => true });
  m2.start();
  assert(!!(m2 as unknown as { lightTimer: unknown }).lightTimer, "⑥ start 后 lightTimer 在");
  m2.stop();
  assert(!(m2 as unknown as { lightTimer: unknown }).lightTimer, "⑥ stop 后定时器清");
}

// ---------- 清理 ----------
rmSync(DATA, { recursive: true, force: true });
if (failures === 0) console.log("\nPATROL TESTS PASSED");
else { console.error(`${failures} failures`); process.exit(1); }
