// ---------- sqlite 加载韧性测试（#158 批1） ----------
// 五段：0 驱动动态加载正常面 / 1 驱动加载失败→读面降级 json 档（sqlite+shadow 档）
// / 2 建库失败（驱动可载但 dataDir 不可建）→同降级 / 3 boot 探测横幅与 json 档零探测
// / 4 permission-audit 尽力而为面（auditStore null + 读写 null 容忍）+ 注入复位。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT npx tsx scripts/test-sqlite-resilience.ts
// 背景：0.7.0-test.3 Windows 包携 darwin-arm64 二进制 → dlopen ERR_DLOPEN_FAILED 炸进程
//（8787 永不监听）。驱动改可失败动态加载（storage/sqlite.ts），读面降级 json 档
//（read-mode.ts viaReadMode），本测试锁死降级语义：进程绝不因驱动缺失抛未捕获异常。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDriver, resetSqliteDriverForTest, type SqliteDriverLoad } from "../src/storage/sqlite.js";
import {
  resetReadModeForTest,
  probeSqliteDriverAtBoot,
  isSqliteDegradationNotifiedForTest,
} from "../src/storage/read-mode.js";
import { listGroups } from "../src/projects.js";
import { auditStore, appendPermissionAudit, readPermissionAudit, type PermissionAuditRow } from "../src/permission-audit.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// console 捕获（横幅断言面）：降级告警走 console.error，审计跳过走 console.warn
const errors: string[] = [];
const warns: string[] = [];
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.error = (...a: unknown[]) => { errors.push(a.join(" ")); origError(...a); };
console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); origWarn(...a); };
const bannerHit = (): boolean => errors.some((l) => l.includes("sqlite 不可用，已降级 json 档"));
const auditSkipHit = (): boolean => warns.some((l) => l.includes("审计落库跳过"));

// ---------- 造态 ----------
const root = mkdtempSync(join(tmpdir(), "cc-sqlite-resilience-"));
const dataDir = join(root, "data");
const orgDir = join(root, "org");
mkdirSync(dataDir, { recursive: true });
mkdirSync(orgDir, { recursive: true });
process.env.CCR_DATA_DIR = dataDir;
const T = 1760000000000;
const g1 = { id: "g-1", name: "serious", anchor_dir: "/fx/serious", status: "active", tier: "正经立项", headcount: [], role_defaults: {}, single_card: false, created_at: T + 1, updated_at: T + 2 };
writeFileSync(join(orgDir, "projects.json"), JSON.stringify({ trust_light: false, groups: [g1] }, null, 2) + "\n");

const setMode = (m: string | undefined): void => {
  if (m === undefined) delete process.env.CCR_STORAGE_READ_MODE;
  else process.env.CCR_STORAGE_READ_MODE = m;
};
/** 注入「win32 撞 darwin 二进制」同型失败（错误码对齐 0.7.0-test.3 实锤）。 */
const injectDlopenFailure = (): void => {
  const bad: SqliteDriverLoad = {
    ok: false,
    ctor: null,
    error: "Could not locate the bindings file: ... \\build\\Release\\better_sqlite3.node（was loaded with: win32-x64）",
    code: "ERR_DLOPEN_FAILED",
  };
  resetSqliteDriverForTest(bad);
};
const sampleRow: PermissionAuditRow = {
  requested_mode: "bypassPermissions",
  normalized_mode: null,
  effective_mode: "deny",
  native_mode: null,
  capability_state: null,
  engine: null,
  reason: "resilience-test",
  policy_source: null,
  environment: null,
  dir_scope: null,
  tier: null,
  actor: null,
  session_id: null,
  command_id: null,
  created_at: Date.now(),
};

try {
  // ---------- 0. 驱动动态加载：正常面（本机真实 require） ----------
  console.log("段0 驱动正常加载:");
  setMode(undefined); // 缺省 sqlite 档
  resetReadModeForTest(); // 清任何注入，按真实环境加载
  const driver = loadSqliteDriver();
  assert(driver.ok && driver.ctor !== null && driver.error === null, "本机真实驱动可载（ok=true+ctor 在位）");
  assert(loadSqliteDriver() === driver, "成败一次缓存（重复调用同引用，不重复 require）");

  // ---------- 1. 驱动加载失败 → 读面降级 json 档 ----------
  console.log("段1 驱动失败降级:");
  injectDlopenFailure();
  const degraded = listGroups(orgDir); // 启动链同款读入口（rehydrateParkedMembers→listGroups）
  assert(degraded.length === 1 && degraded[0].id === "g-1", "sqlite 档+驱动失败：listGroups 返回 json 侧金值（降级不抛）");
  assert(bannerHit(), "降级横幅已打（「sqlite 不可用，已降级 json 档」）");
  assert(errors.some((l) => l.includes("ERR_DLOPEN_FAILED")), "横幅含错误码 ERR_DLOPEN_FAILED");
  assert(errors.some((l) => l.includes(process.platform) && l.includes(process.arch)), "横幅含平台标识（platform-arch）");
  assert(errors.some((l) => l.includes("配置档位 sqlite")), "横幅含配置档位（缺省 sqlite）");
  const bannerCount = errors.filter((l) => l.includes("已降级 json 档")).length;
  listGroups(orgDir); // 二次读
  listGroups(orgDir); // 三次读
  assert(errors.filter((l) => l.includes("已降级 json 档")).length === bannerCount, "降级横幅每进程一次（高频读不刷屏）");

  setMode("shadow");
  resetReadModeForTest();
  injectDlopenFailure();
  const shGroups = listGroups(orgDir);
  assert(shGroups.length === 1 && shGroups[0].id === "g-1", "shadow 档+驱动失败：返回值仍 json 侧（对比面无库可对，直接降级）");

  setMode("json");
  resetReadModeForTest();
  injectDlopenFailure();
  errors.length = 0;
  const jGroups = listGroups(orgDir);
  assert(jGroups.length === 1 && jGroups[0].id === "g-1", "json 档+驱动失败：读面原样（json 档本就零 SQLite 参与）");
  assert(!bannerHit(), "json 档不触发降级横幅（无降级可言）");

  // ---------- 2. 建库失败（驱动可载但 dataDir 不可建）→ 同降级 ----------
  console.log("段2 建库失败降级:");
  setMode("sqlite");
  resetReadModeForTest(); // 真实驱动
  errors.length = 0;
  const notADir = join(root, "blocker-file"); // dataDir 落在普通文件上：mkdirSync 必抛
  writeFileSync(notADir, "x");
  process.env.CCR_DATA_DIR = notADir;
  try {
    const g = listGroups(orgDir);
    assert(g.length === 1 && g[0].id === "g-1", "建库失败：读面降级 json 侧返回（不抛）");
    assert(errors.some((l) => l.includes("建库/迁移失败")), "建库失败横幅在（context 含「sqlite 建库/迁移失败」）");
  } catch (e) {
    assert(false, `建库失败不应抛（却抛了: ${e instanceof Error ? e.message : String(e)}）`);
  }
  process.env.CCR_DATA_DIR = dataDir;

  // ---------- 3. boot 探测：横幅前置 + json 档零探测 + 正常路径零输出 ----------
  console.log("段3 boot 探测:");
  resetReadModeForTest();
  setMode("sqlite");
  const driverOk = loadSqliteDriver();
  errors.length = 0;
  probeSqliteDriverAtBoot();
  assert(driverOk.ok && !bannerHit(), "驱动正常：boot 探测零输出（mac 正常路径零变化）");

  setMode("json");
  injectDlopenFailure();
  errors.length = 0;
  probeSqliteDriverAtBoot();
  assert(!bannerHit(), "json 档：boot 探测跳过（零 SQLite 参与，无横幅）");

  setMode("sqlite");
  errors.length = 0;
  probeSqliteDriverAtBoot();
  assert(bannerHit() && errors.some((l) => l.includes("boot 探测")), "sqlite 档+驱动失败：boot 探测即打横幅（不等读入口）");

  // ---------- 4. permission-audit 尽力而为面 + 注入复位 ----------
  console.log("段4 审计面降级:");
  warns.length = 0;
  const auditPort = auditStore(dataDir); // 驱动仍注入失败
  assert(auditPort === null, "auditStore 驱动失败→null（不抛）");
  assert(auditSkipHit(), "审计跳过告警已打（一次）");
  let noThrow = true;
  try {
    appendPermissionAudit(null, sampleRow);
    const rows = readPermissionAudit(null, 10);
    assert(rows.length === 0, "append(null) 不抛 + read(null)=[]（null 容忍）");
  } catch {
    noThrow = false;
  }
  assert(noThrow, "审计 null 面全程无异常");

  resetReadModeForTest(); // 复位注入：清 driverOverride+缓存+告警标志
  setMode("sqlite");
  const port2 = auditStore(dataDir);
  assert(port2 !== null, "复位注入后 auditStore 恢复真实驱动（非 null）");
  const g2 = listGroups(orgDir);
  assert(g2.length === 1 && g2[0].id === "g-1" && g2[0].tier === "正经立项", "复位后 sqlite 档照常（表投影可读——mac 正常路径回归锚）");
  assert(!isSqliteDegradationNotifiedForTest(), "复位清除降级告警标志");

  // 无效模式值 fail-fast 语义不变（降级不得吞掉配置 typo）
  setMode("jsno");
  let threw = false;
  try { listGroups(orgDir); } catch { threw = true; }
  assert(threw, "无效模式值仍 fail-fast 抛错（降级≠静默吞配置错误）");
  setMode(undefined);
} finally {
  console.error = origError;
  console.warn = origWarn;
  resetReadModeForTest();
  delete process.env.CCR_STORAGE_READ_MODE;
  delete process.env.CCR_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
