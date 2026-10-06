// #230 deliverBySession 归因测试：三查形态 + 对 cwd 启发式的优先级 + 回落兜底。
// 场景源自 2026-10-02 生产实锤：deliver 带 CLI 原生 sid（6366b926…），卡是 journal
// 回放保留的裸 UUID 老卡（8dc5b169…，relay_session_id=CLI sid）——两查全 miss 回落
// cwd 启发式，把产物挂给隔壁更活跃的卡。修复 = 第三查 relay_session_id 反查。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";

process.env.CCR_DATA_DIR = mkdtempSync(join(tmpdir(), ".tmp-deliver-session-"));

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const bus = new EventBus();
const cfg = loadConfig();
const mgr = new SessionManager(bus, cfg);

// 场景布置：projA 目录 + 交付物文件（registerDeliverable 会 stat）
const root = mkdtempSync(join(tmpdir(), ".tmp-deliver-fixtures-"));
const projA = join(root, "projA");
mkdirSync(projA, { recursive: true });
const f1 = join(projA, "report-a.md");
writeFileSync(f1, "# A\n");
const f2 = join(root, "report-b.md");
writeFileSync(f2, "# B\n");

// 卡 A：裸 UUID 老卡形态（journal 回放保留），relay_session_id=CLI sid A
const SID_A = "6366b926-4bb9-4d83-a3fb-b61a80c01e59";
const CARD_A = "8dc5b169-573e-4a44-afb4-24c70fbca383";
mgr.ensureExternal(CARD_A, projA, "老卡会话", SID_A);

// 卡 B：现行 ext- 前缀形态，cwd=/root（前缀匹配下方 deliver 的 cwd），建卡更晚=更活跃
const SID_B = "c9c8f311-92d9-4373-b3d4-aede6298bb6c";
const CARD_B = `ext-${SID_B}`;
mgr.ensureExternal(CARD_B, root, "隔壁会话", SID_B);
// updated_at 同毫秒打平时启发式按插入序取先者（既有语义），隔 5ms 保证 B 严格最新
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
mgr.setExternalStatus(CARD_B, "WORKING", "正在忙"); // updated_at 拔到最新，启发式必选 B

// ① #230 核心：CLI sid A 反查裸 UUID 老卡。cwd 故意给 /root（同时匹配 A/B 且 B 更活
// 跃）——修复前此处回落启发式挂 B（生产实锤路径），修复后必须精确挂 A
let r = mgr.deliverBySession(SID_A, root, f1);
assert(r.ok && r.session_id === CARD_A, `① CLI sid 反查裸 UUID 老卡 → 挂 ${CARD_A.slice(0, 8)}（实际 ${r.session_id?.slice(0, 8) ?? "无"}）`);
const artA = mgr.getExternal(CARD_A)?.artifacts ?? [];
assert(artA.some((a) => a.path.toLowerCase() === f1.toLowerCase()), "① 产物落在老卡 artifacts 里");
const artB = mgr.getExternal(CARD_B)?.artifacts ?? [];
assert(!artB.some((a) => a.path.toLowerCase() === f1.toLowerCase()), "① 隔壁卡 artifacts 无此产物（未被抢挂）");

// ② ext- 形态回归：CLI sid B 仍走第二查命中 ext- 卡（cwd 给完全无关路径，证明不走启发式）
r = mgr.deliverBySession(SID_B, "/definitely/not/a/session/cwd", f2);
assert(r.ok && r.session_id === CARD_B, `② ext- 前缀形态回归 → 挂 ${CARD_B.slice(0, 12)}（实际 ${r.session_id?.slice(0, 12) ?? "无"}）`);

// ③ 回落兜底不破：未知 sid + cwd 命中 → deliverByCwd 语义（挂最近活跃的 B）
r = mgr.deliverBySession("unknown-sid-0000", root, f2);
assert(r.ok && r.session_id === CARD_B, "③ 未知 sid 回落 cwd 启发式 → 最近活跃卡");

// ④ 未知 sid + cwd 无匹配 → 明确失败（不丢单也不乱挂）
r = mgr.deliverBySession("unknown-sid-0000", "/definitely/not/a/session/cwd", f2);
assert(!r.ok, "④ 无任何匹配 → ok:false");

// ⑤ findByCliSid 直查（公开单点，供后续复用）
assert(mgr.findByCliSid(SID_A) === CARD_A, "⑤ findByCliSid(CLI sid) 返回老卡 id");
assert(mgr.findByCliSid("no-such") === null, "⑤ findByCliSid 未知 sid 返回 null");

console.log("ALL PASS - deliverBySession 三查归因");
rmSync(root, { recursive: true, force: true });
rmSync(process.env.CCR_DATA_DIR!, { recursive: true, force: true });
process.exit(0);
