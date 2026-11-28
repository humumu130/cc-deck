// L-1029-4 云回流 A 修三件单测（纯单元 + 轻量 SessionManager 集成，不起服务）：
//   A. cloudToken 三级回退：env CCR_CLOUD_TOKEN → 文件 <dataDir>/cloud-token → 默认值
//      （默认值不写字面量断言——先取「双档皆无」基线再断言覆盖关系，默认值演进不炸测试）
//   B. 拉回失败分流：classifyRefluxFailure 三分类 + RefluxFailureTracker 连击/边沿
//      告警/epoch 递增/成功清零（含换类重置、恢复后再故障新 epoch=新通知 key）
//   C. SessionManager.cloudRefluxHealth 面板集成：告警落账（kind=system、body 带
//      对症建议）→ 恢复 resolve 同期账（resolved_at 填上、面板可见性=notificationsList）
// 隔离：CCR_DATA_DIR 指临时目录（SessionManager 构造/journal 不碰生产数据）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

// ---- A. 三级回退（loadConfig 单口）----
// loadConfig 每次调用重读 env+文件（无模块级缓存），可直接场景切换
import { loadConfig } from "../src/config.js";
const ROOT = mkdtempSync(join(tmpdir(), "cloud-reflux-test."));
process.env.CCR_DATA_DIR = ROOT;
process.env.CCR_TOKEN = "test-token";
delete process.env.CCR_CLOUD_TOKEN; // 防外层环境带值污染（env 档断言前提）

const baseline = loadConfig().cloudToken; // 第三档基线：无 env 无文件
assert(typeof baseline === "string" && baseline.length > 0, "A1 双档皆无=非空默认值");

writeFileSync(join(ROOT, "cloud-token"), "  file-token-abc  \n", "utf-8"); // 带空白：trim 后用
assert(loadConfig().cloudToken === "file-token-abc", "A2 无 env+文件存在=文件值（trim）");

process.env.CCR_CLOUD_TOKEN = "env-token-xyz";
assert(loadConfig().cloudToken === "env-token-xyz", "A3 env+文件并存=env 优先");

process.env.CCR_CLOUD_TOKEN = "   "; // 空白 env=未设置（防误写空值把 token 打成空串）
assert(loadConfig().cloudToken === "file-token-abc", "A4 空白 env 跳过落文件档");

writeFileSync(join(ROOT, "cloud-token"), "\n  \n", "utf-8"); // 空文件=未设置
delete process.env.CCR_CLOUD_TOKEN;
assert(loadConfig().cloudToken === baseline, "A5 空文件+无 env 落默认档");

// ---- B. 分流分类与连击追踪（ws-server 导出纯逻辑）----
import { classifyRefluxFailure, RefluxFailureTracker, REFLUX_ALERT_THRESHOLD, REFLUX_KIND_ADVICE } from "../src/ws-server.js";

assert(REFLUX_ALERT_THRESHOLD === 3, "B0 阈值=3（任务书口径）");
assert(classifyRefluxFailure(null, 401) === "auth", "B1 401→auth");
assert(classifyRefluxFailure(null, 403) === "auth", "B2 403→auth");
assert(classifyRefluxFailure(null, 500) === "http", "B3 500→http");
assert(classifyRefluxFailure(new Error("boom"), null) === "network", "B4 throw 无状态→network");
assert(classifyRefluxFailure(null, null) === "http", "B5 无状态无异常→http 兜底");
assert(REFLUX_KIND_ADVICE.auth.includes("wrangler secret put") && REFLUX_KIND_ADVICE.auth.includes("cloud-token"), "B6 auth 建议含重设步骤关键词");

const t = new RefluxFailureTracker();
let r1 = t.recordFailure("auth"); let r2 = t.recordFailure("auth"); let r3 = t.recordFailure("auth");
assert(!r1.alert && !r2.alert && r3.alert && r3.epoch === 1, "B7 第3拍边沿告警一次（epoch=1）");
const r4 = t.recordFailure("auth");
assert(!r4.alert && r4.epoch === 1, "B8 第4拍不再重复告警（同故障期一条）");
assert(t.snapshot.kind === "auth" && t.snapshot.count === 4, "B8b snapshot 计数连击");

const s1 = t.recordSuccess();
assert(s1.wasAlarming && s1.epoch === 1 && s1.kind === "auth", "B9 成功清零带回告警态+同期 kind（恢复配对）");
const s2 = t.recordSuccess();
assert(!s2.wasAlarming && s2.kind === null, "B10 健康态再成功=无告警可清");

// 恢复后同 kind 再故障：epoch 自增=新通知 key（绕「已 resolved 同 key 不复活」防重）
t.recordFailure("auth"); t.recordFailure("auth");
const r5 = t.recordFailure("auth");
assert(r5.alert && r5.epoch === 2, "B11 新故障期 epoch=2（新账 key）");

// 换类重置：auth×2 → network 1 拍即 count=1（防跨类误累计）
const t2 = new RefluxFailureTracker();
t2.recordFailure("auth"); t2.recordFailure("auth");
t2.recordFailure("network");
assert(t2.snapshot.kind === "network" && t2.snapshot.count === 1, "B12 换类重置计数");

// ---- C. cloudRefluxHealth 面板集成（告警落账→恢复 resolve）----
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
{
  const mgr = new SessionManager(new EventBus(), loadConfig());
  mgr.cloudRefluxHealth({ epoch: 1, kind: "auth", detail: "连续 3 拍拉取失败（auth，HTTP 401）：鉴权 401/403：云桥 token 两端不一致。重设：wrangler secret put CLOUD_TOKEN…" });
  let list = mgr.notificationsList();
  const eid = (n: { sourceContext?: { entityId?: string } }) => n.sourceContext?.entityId;
  const acc = list.find((n) => n.kind === "system" && eid(n) === "cloud-reflux:1");
  assert(acc !== undefined, "C1 告警落账（system/cloud-reflux:1 面板可见）");
  assert(!!acc && acc.body.includes("401") && acc.body.includes("secret put"), "C2 告警正文含类因与建议动作");
  assert(!!acc && acc.resolved_at === undefined, "C3 告警未恢复前不 resolved");

  // 同期重复告警 upsert 防重（非 dispatch kind 静默跳过，不双发）
  mgr.cloudRefluxHealth({ epoch: 1, kind: "auth", detail: "重复边沿（不会发生，防重验证）" });
  list = mgr.notificationsList();
  assert(list.filter((n) => eid(n) === "cloud-reflux:1").length === 1, "C4 同 key 重放不双发");

  mgr.cloudRefluxHealth({ epoch: 1, kind: "auth", detail: "", recovered: true });
  list = mgr.notificationsList();
  const rec = list.find((n) => eid(n) === "cloud-reflux:1");
  assert(rec !== undefined && rec.resolved_at !== undefined, "C5 恢复自清=同期账 resolved");

  // 新故障期（epoch=2）再告警：新账一条，不复活旧账
  mgr.cloudRefluxHealth({ epoch: 2, kind: "network", detail: "连续 3 拍拉取失败（network，请求未达）" });
  list = mgr.notificationsList();
  assert(list.some((n) => eid(n) === "cloud-reflux:2" && n.resolved_at === undefined), "C6 新故障期=新账一条（旧 resolved 不复活）");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
