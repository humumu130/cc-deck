// #292-B3 批3 断言套件：四域写口（experience/rules/notifications/deliverables）
// 套批2 withOrgWriteTx/withStorageTx 范式 + 八口外包（B-P2-3 收编）+ notification 高频计时。
//   §E experience/rules：单点包（saveExperience/saveRules）透传+坏 JSON 保护态不因 tx 破坏
//   §N notifications：upsert 事务透传+库立即可见（notification 表）+单写耗时（>50ms 阈值哨）
//   §V deliverables：append 事务透传+artifact 表可见
//   §G 八口：createGroup/addMember（互调簇嵌套防护+Inner 直调）/setGroupTier/…透传
//   §D 降级：json 档短路（四域纯文件照写）
// 直跑：cd relay && env -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT npx tsx scripts/test-c3.ts
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-c3-org/", "../data/test-c3-data/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-c3-org/");
process.env.CCR_DATA_DIR = SB("../data/test-c3-data/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
// #292-cutover-P1（C-C6）：本套件主体断言 SQLite 行为（§W 帧写/§S 影子比对需库
// 行），全套件 json 跑结构性不成立——env 钉 sqlite 档（json 子段 §D/§O 套件内
// 自管）。json 档全套件覆盖面 = test-c2 + test-brm + test-c5（KEEP_READ_MODE 通道）。
delete process.env.CCR_STORAGE_READ_MODE;
delete process.env.CCR_PORT;

let pass = 0, fail = 0;
function assert3(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); }
}

console.log("§E experience/rules 单点包：");
{
  const exp = await import("../src/experience.js");
  const r1 = exp.appendExperience({ text: "批3 事务透传条目", kind: "practice", role: "worker" } as never, process.env.CCR_ORG_DIR);
  assert3(r1.ok !== false, "E1 appendExperience 事务透传（文件账成功）", r1.ok ? "" : JSON.stringify(r1).slice(0, 80));
  const raw = JSON.parse(readFileSync(join(process.env.CCR_ORG_DIR!, "experience.json"), "utf-8")) as { entries: unknown[] };
  assert3(raw.entries.some((e) => String((e as { text?: string }).text ?? "").includes("批3 事务透传条目")), "E2 文件账落盘（tmp+rename 原子写在 tx 内）");
  const rules = await import("../src/team-rules.js");
  const r2 = rules.appendRule({ text: "批3 规则条目", audience: "all", scope: "team" }, process.env.CCR_ORG_DIR);
  assert3(r2.ok !== false, "E3 appendRule 事务透传", r2.ok ? "" : JSON.stringify(r2).slice(0, 80));
}
console.log("§N notifications（含计时）：");
{
  // 直接构造 SessionManager 太重（EventBus/leader 链）——用投影级验证：persistNotifications 的
  // 效果（notifications.json 落盘+notification 表可见）经 sm 实例。轻构：EventBus+cfg（test-bootts 同款）
  const { EventBus } = await import("../src/event-bus.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig();
  cfg.token = "t";
  cfg.dataDir = process.env.CCR_DATA_DIR!;
  const bus = new EventBus({ persistPath: join(process.env.CCR_DATA_DIR!, "events.ndjson") });
  const sm = new SessionManager(bus, cfg);
  const t0 = Date.now();
  sm.upsertNotificationForTest("system", "c3-notify-1", "r1", {
    title: "批3 通知", body: "事务透传", severity: "info", group: "activity", actionable: false, domain: "session", returnPath: "sessions",
  });
  const dt = Date.now() - t0;
  const rawN = JSON.parse(readFileSync(join(process.env.CCR_DATA_DIR!, "notifications.json"), "utf-8")) as { notifications: { key: string }[] };
  assert3(rawN.notifications.some((n) => n.key.includes("c3-notify-1")), "N1 通知事务透传（notifications.json 落盘）");
  // 高频成本哨（任务书 >50ms 阈值）：连续 5 写取最大值
  let maxDt = dt;
  for (let i = 2; i <= 5; i++) {
    const t = Date.now();
    sm.upsertNotificationForTest("system", `c3-notify-${i}`, "r1", {
      title: `批3 通知 ${i}`, body: "高频", severity: "info", group: "activity", actionable: false, domain: "session", returnPath: "sessions",
    });
    maxDt = Math.max(maxDt, Date.now() - t);
  }
  console.log(`  [计时] 首写 ${dt}ms / 5 写最大 ${maxDt}ms（阈值 50ms）`);
  assert3(maxDt <= 50, `N2 单写耗时 ≤50ms（实 ${maxDt}ms）——同步追赶成立，无需异步化`);
  // 库立即可见（追赶生效）
  const { ensureStore, resolveDirs } = await import("../src/storage/read-mode.js");
  const port = ensureStore(resolveDirs());
  // 表列（schema 实测）：id/level/category/payload_json——通知 key 在 id（importer 派生）
  const row = port.query<{ payload_json: string }>("SELECT payload_json FROM notification WHERE payload_json LIKE ?", ["%批3 通知%"]);
  assert3(row.length > 0, "N3 通知写后库立即可见（payload_json 含标题，追赶生效）");
}
console.log("§V deliverables：");
{
  const { EventBus } = await import("../src/event-bus.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig();
  cfg.token = "t";
  cfg.dataDir = process.env.CCR_DATA_DIR!;
  const bus = new EventBus({ persistPath: join(process.env.CCR_DATA_DIR!, "events.ndjson") });
  const sm = new SessionManager(bus, cfg);
  sm.registerDeliverableForTest({ sid: "c3-sess", path: join(process.env.CCR_DATA_DIR!, "c3-out.md") });
  const rawV = JSON.parse(readFileSync(join(process.env.CCR_DATA_DIR!, "deliverables.json"), "utf-8")) as { sid: string; path: string }[];
  assert3(rawV.some((x) => x.sid === "c3-sess"), "V1 交付登记事务透传（deliverables.json）");
  const { ensureStore, resolveDirs } = await import("../src/storage/read-mode.js");
  const port = ensureStore(resolveDirs());
  const row = port.query<{ normalized_path: string }>("SELECT normalized_path FROM artifact WHERE normalized_path LIKE ?", ["%c3-out.md%"]);
  assert3(row.length > 0, "V2 交付写后 artifact 表可见（追赶生效）");
}
console.log("§G 八口（B-P2-3 收编）：");
{
  const proj = await import("../src/projects.js");
  const DIR = process.env.CCR_ORG_DIR;
  const c = proj.createGroup({ name: "c3-g", anchor_dir: "/tmp/c3-g", tier: "轻立项" }, DIR);
  assert3(c.ok, "G1 createGroup 事务透传（内嵌 addConfirmInner 不嵌套炸）", c.ok ? "" : (c as { error?: string }).error ?? "");
  const gid = c.ok ? (c as { group: { id: string } }).group.id : "";
  const am = proj.addMember(gid, "c3-sid-1", "worker", undefined, DIR);
  assert3(am.ok, "G2 addMember 事务透传（含 opts 参数保真）", am.ok ? "" : (am as { error?: string }).error ?? "");
  const st = proj.setGroupTier(gid, "正经立项", DIR);
  assert3(st.ok, "G3 setGroupTier 透传", st.ok ? "" : (st as { error?: string }).error ?? "");
  const rm2 = proj.removeMember(gid, "c3-sid-1", DIR);
  assert3(rm2.ok, "G4 removeMember 透传", rm2.ok ? "" : (rm2 as { error?: string }).error ?? "");
  const ac = proj.addConfirm({ kind: "project-tier", title: "批3 确认", reason: "c3", payload: { gid } } as never, DIR);
  assert3(typeof (ac as { id?: string }).id === "string", "G5 addConfirm 独立出口透传（OrgConfirm 返回，createGroup 内走 Inner 双形态）", JSON.stringify(ac).slice(0, 60));
  // 嵌套防护行为：出口互调出口=类型化编程错误（txDepth）——直接验证 withStorageTx 嵌套
  const { withStorageTx } = await import("../src/storage/org-write-tx.js");
  let nestedThrew = false;
  try { withStorageTx(undefined, () => { withStorageTx(undefined, () => 1); }); } catch (e) { nestedThrew = /嵌套写事务/.test(String(e)); }
  assert3(nestedThrew, "G6 出口嵌套=类型化编程错误（txDepth 防护 fail-fast）");
}
console.log("§D 降级：");
{
  process.env.CCR_STORAGE_READ_MODE = "json";
  const exp = await import("../src/experience.js");
  const r = exp.appendExperience({ text: "json 档条目", kind: "fact", role: "worker" } as never, process.env.CCR_ORG_DIR);
  const raw = JSON.parse(readFileSync(join(process.env.CCR_ORG_DIR!, "experience.json"), "utf-8")) as { entries: { text?: string }[] };
  assert3(r.ok !== false && raw.entries.some((e) => e.text === "json 档条目"), "D1 json 档四域短路纯文件（照写不炸）");
  delete process.env.CCR_STORAGE_READ_MODE;
}

// G7（A-P1-2/B-P1-1 修复锁）：createGroup 确认单 hook 补发
{
  const DIR7 = process.env.CCR_ORG_DIR!;
  const proj7 = await import("../src/projects.js");
  const { setConfirmCreatedHook } = proj7;
  let hookN = 0;
  setConfirmCreatedHook(() => { hookN++; });
  const c7 = proj7.createGroup({ name: "c3-hook", anchor_dir: "/tmp/c3-hook", tier: "正经立项" }, DIR7);
  setConfirmCreatedHook(null);
  assert3(c7.ok && hookN === 1, `G7 createGroup 确认单 hook 补发一次（实 ${hookN}）——P1-2 修复锁`);
}
// G8 rollback：fn 抛错→异常上抛+连接干净（后续事务可用）
{
  const { withStorageTx } = await import("../src/storage/org-write-tx.js");
  let threw = false;
  try { withStorageTx(undefined, () => { throw new Error("c3-rollback-probe"); }); } catch (e) { threw = String(e).includes("c3-rollback-probe"); }
  const after = withStorageTx(undefined, () => "ok");
  assert3(threw && after === "ok", "G8 fn 抛错→rollback+原样上抛，后续事务可用（连接干净）");
}
// N4 deferred 一致性窗口：写后同步点不可见承诺不破（最终一致）——tick 后可见
{
  const { EventBus } = await import("../src/event-bus.js");
  const { SessionManager } = await import("../src/session-manager.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg4 = loadConfig();
  cfg4.token = "t"; cfg4.dataDir = process.env.CCR_DATA_DIR!;
  const bus4 = new EventBus({ persistPath: join(process.env.CCR_DATA_DIR!, "events.ndjson") });
  const sm4 = new SessionManager(bus4, cfg4);
  sm4.upsertNotificationForTest("system", "c3-defer", "r1", { title: "defer 窗口", body: "异步追赶", severity: "info", group: "activity", actionable: false, domain: "session", returnPath: "sessions" });
  await new Promise<void>((r) => setImmediate(() => r()));
  const { ensureStore, resolveDirs } = await import("../src/storage/read-mode.js");
  const port4 = ensureStore(resolveDirs());
  const row4 = port4.query<{ payload_json: string }>("SELECT payload_json FROM notification WHERE payload_json LIKE ?", ["%defer 窗口%"]);
  assert3(row4.length > 0, "N4 deferred 追赶：tick 后库可见（一致性窗口=读前触发自愈+最终一致）");
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
for (const d of ["../data/test-c3-org/", "../data/test-c3-data/"]) {
  try { rmSync(SB(d), { recursive: true, force: true }); } catch {}
}
process.exit(fail > 0 ? 1 : 0);
void writeFileSync;
