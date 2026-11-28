// #276 活会话重接管——孤儿时间戳断言（收敛版）。
// 本套收敛为孤儿建卡诚实时间戳面：活性翻活/idle 回落/tool_use 保持由既有轮询政体
//（test-bridge case 36 全套：转录增长翻 WORKING「转录活跃（无 hook 会话）」/idle
// 回落/regrowth/tool_use 静默保持）权威承载——本批曾加 mtime 活性层，审查实证与
// 既有政体重复且冲突（窗口/摘要双轨打架，case 36 夹具 sid 复用实锤翻飞 hook 卡）
// 后撤销，只留与政体正交的时间戳修。
// 覆盖：
//   A1 孤儿新收养卡 updated_at = 转录 mtime（非建卡 now——rea 案冻结半边）
//   A2 已注册孤儿卡重扫：不重复建卡、零状态触碰（政体归轮询，收养面不越权）
//   A3 hook 驱动卡（模拟事件建的卡）收养面零触碰
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:alive
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { Bridge } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

// ---- 沙盒 ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const d of ["../data/test-alive-org/", "../data/test-alive-data/", "../data/test-alive-projects/"]) {
  rmSync(SB(d), { recursive: true, force: true });
  mkdirSync(SB(d), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-alive-org/");
process.env.CCR_DATA_DIR = SB("../data/test-alive-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-alive-projects/");
process.env.CCR_SESSIONS_ROOT = SB("../data/test-alive-projects/sessions/");
mkdirSync(process.env.CCR_SESSIONS_ROOT, { recursive: true });
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";

const cfg = loadConfig();
cfg.token = "t";
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
// fakeThis 承原型链（adoptOrphans 内部调 this.scanOrphanActivity/readCwdFromTail）
const fakeBridge: unknown = Object.create(Bridge.prototype);
Object.assign(fakeBridge as object, {
  mgr,
  transcriptPaths: new Map<string, string>(),
  orphanProbe: new Map<string, { size: number; ts: number; adopt: boolean }>(),
  orphanSkipBannerShown: true,
  ensureQueuePoll: () => {},
});
const fb = fakeBridge as { adoptOrphans(): void };
const adopt = () => fb.adoptOrphans();

const TROOT = join(process.env.CCR_PROJECTS_ROOT!, "proj-a");
mkdirSync(TROOT, { recursive: true });
const NOW = Date.now();
// 转录行按 scanOrphanActivity 判据塑形：≥1 user + ≥1 tool_use（perm-wait 形态，34 案口径）
const line = (cwd: string) =>
  JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }) + "\n" +
  JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } }) + "\n";
function mkTranscript(sid: string, at: number): string {
  const p = join(TROOT, `${sid}.jsonl`);
  writeFileSync(p, line("/tmp/wd"));
  utimesSync(p, new Date(at), new Date(at));
  return p;
}
const getExt = (id: string) => (mgr as unknown as { getExternal(id: string): { status: string; updated_at: number; action_summary: string } | undefined }).getExternal(id);

console.log("§A 孤儿时间戳面：");
// A1 新收养：updated_at = 转录 mtime
{
  const at = NOW - 10 * 60_000;
  mkTranscript("aaaabbbb-1111-2222-3333-000000000001", at);
  adopt();
  const st = getExt("ext-aaaabbbb-1111-2222-3333-000000000001");
  ok(!!st, "A1a 孤儿卡收养在册");
  ok(Math.abs((st?.updated_at ?? 0) - at) < 2000, `A1b 新卡 updated_at=转录 mtime（rea 案冻结半边；实偏差 ${(st?.updated_at ?? 0) - at}ms）`);
  ok(st?.status === "DONE", "A1c 新卡 DONE（只读接入语义保持）");
  // A2 已注册重扫：不重复建、状态零触碰
  const before = JSON.stringify(getExt("ext-aaaabbbb-1111-2222-3333-000000000001"));
  appendFileSync(join(TROOT, "aaaabbbb-1111-2222-3333-000000000001.jsonl"), line("/tmp/wd"));
  adopt();
  ok(JSON.stringify(getExt("ext-aaaabbbb-1111-2222-3333-000000000001")) === before, "A2 已注册卡重扫零触碰（活性政体归轮询，收养面不越权——test-bridge 36 冲突教训）");
}
// A3 模拟 hook 卡（ensureExternal 直建=hook 事件建档形态）：收养面零触碰
{
  const sid = "bbbbeeee-1111-2222-3333-000000000002";
  mkTranscript(sid, NOW - 10 * 60_000);
  mgr.ensureExternal(`ext-${sid}`, "/tmp/wd2", "hook 卡", sid, NOW - 60_000);
  const before = JSON.stringify(getExt(`ext-${sid}`));
  adopt();
  ok(JSON.stringify(getExt(`ext-${sid}`)) === before, "A3 hook 建档卡零触碰（事件流权威）");
}

console.log(`§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#276 孤儿诚实时间戳（活性政体归轮询的收敛口径）");
process.exit(fail > 0 ? 1 : 0);
