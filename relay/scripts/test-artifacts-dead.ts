// #224 已删输出物不出现在下发面板。链路：产物目录文件 mergeArtifact 入表 → 删文件
// → 20s 轮询（测试直接调 pollArtifactsExistence，不等真实定时）→ 断言：
// ① SESSION_UPDATED artifacts 帧不含已删条目；② snapshot() 同过滤；③ state 内部
// 保留 dead 条目（exists=false，文件重建时合并复用）；④ 下一次任意 artifacts 帧
// （registerDeliverable 触发）也 re-stat 过滤（两层复查的 emit 层）。
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const root = join(process.cwd(), ".tmp-test-artifacts-dead");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "artifacts"), { recursive: true });
mkdirSync(join(root, "data"), { recursive: true });
process.env.CCR_ARTIFACTS_DIR = join(root, "artifacts");
process.env.CCR_DATA_DIR = join(root, "data");
process.env.CCR_NO_TITLE_GEN = "1";

const bus = new EventBus();
const cfg = loadConfig();
const mgr = new SessionManager(bus, cfg);

const SID = "test-224-dead";
const st = mgr.ensureExternal(SID, root, "#224 已删输出物过滤测试");
assert(!!st, "session created");

// 订阅侧收集 artifacts 帧（模拟客户端面板数据源）
const frames: { paths: string[] }[] = [];
bus.subscribe((e) => {
  if (e.type === "SESSION_UPDATED" && Array.isArray((e.payload as Record<string, unknown>).artifacts)) {
    const arts = (e.payload as { artifacts: { path: string }[] }).artifacts;
    frames.push({ paths: arts.map((a) => a.path) });
  }
});

// 三个存活条目：产物目录 ×2（mergeArtifact 自动收录）+ 项目内登记 ×1
const f1 = join(root, "artifacts", "报告-1.html");
const f2 = join(root, "artifacts", "报告-2.html");
const f3 = join(root, "交付-3.md");
writeFileSync(f1, "<html>one</html>");
writeFileSync(f2, "<html>two-two</html>");
writeFileSync(f3, "# three");
mgr.mergeArtifact(SID, { path: f1, tool: "Write", adds: 1, dels: 0, created: true, ts: Date.now() });
mgr.mergeArtifact(SID, { path: f2, tool: "Write", adds: 1, dels: 0, created: true, ts: Date.now() });
assert(mgr.registerDeliverable(SID, f3).ok, "deliverable registered");
const snap1 = mgr.snapshot().find((s) => s.session_id === SID);
assert(snap1?.artifacts?.length === 3, `snapshot has 3 alive artifacts (got ${snap1?.artifacts?.length})`);

// 删 f1 → 定时轮询（直接调）→ 面板应剔除
unlinkSync(f1);
frames.length = 0;
(mgr as unknown as { pollArtifactsExistence(): void }).pollArtifactsExistence();
assert(frames.length === 1, "poll broadcast once after deletion");
assert(!frames[0]!.paths.includes(f1), "broadcast frame excludes deleted f1");
assert(frames[0]!.paths.includes(f2) && frames[0]!.paths.includes(f3), "broadcast keeps alive f2/f3");
const snap2 = mgr.snapshot().find((s) => s.session_id === SID);
assert(snap2?.artifacts?.length === 2 && !snap2?.artifacts?.some((a) => a.path === f1), "snapshot excludes deleted f1");
const internal = mgr.getExternal(SID)?.artifacts;
assert(internal?.some((a) => a.path === f1 && a.exists === false) === true, "internal state keeps dead f1 (exists=false)");

// 删 f2 后走 emit 层复查：registerDeliverable 触发的帧同样剔除（不等 20s 轮询）
unlinkSync(f2);
frames.length = 0;
assert(mgr.registerDeliverable(SID, f3).ok === true, "re-register f3 (idempotent)");
assert(frames.length === 1, "register broadcast fired");
assert(!frames[0]!.paths.includes(f2), "emit-layer restat excludes deleted f2 immediately");

// 无变化时轮询静默（不刷无意义帧）
frames.length = 0;
(mgr as unknown as { pollArtifactsExistence(): void }).pollArtifactsExistence();
assert(frames.length === 0, "poll silent when nothing changed");

// 文件重建 → 条目回归（dead 条目合并复用，不丢历史）
writeFileSync(f1, "<html>one-again-longer</html>");
frames.length = 0;
(mgr as unknown as { pollArtifactsExistence(): void }).pollArtifactsExistence();
assert(frames.length === 1 && frames[0]!.paths.includes(f1), "recreated f1 back in frame");
const revived = mgr.getExternal(SID)?.artifacts?.find((a) => a.path === f1);
assert(revived?.exists === true && revived.op === "create", "revived f1 merged with history (op=create kept)");

rmSync(root, { recursive: true, force: true });
console.log("\n全部通过");
