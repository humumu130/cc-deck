// #26 矩阵式 M1 —— org.ts 单元测试：orgDir 覆盖 / 锚读写 / CLAUDE.md 幂等种子 / 台账追加与回读
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  orgDir, ensureOrgDir, ensureOrgClaudeMd, ORG_CLAUDE_MD_SEED, ORG_CLAUDE_MD_M2_MARKER,
  ORG_CLAUDE_MD_M2P1_MARKER, ORG_CLAUDE_MD_M2P1_SECTION,
  readOrgAnchor, writeOrgAnchor, clearOrgAnchor,
  appendDispatch, readDispatchLog, dispatchLogPath, type DispatchEntry, type OrgAnchor,
} from "../src/org.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), "cc-deck-org-"));

// ---------- orgDir：默认路径 + env 覆盖逐次求值 ----------
console.log("orgDir:");
assert(orgDir() === join(process.env.HOME ?? "", ".cc-deck", "org"), "默认 ~/.cc-deck/org");
process.env.CCR_ORG_DIR = "/tmp/cc-deck-org-env-a";
assert(orgDir() === "/tmp/cc-deck-org-env-a", "CCR_ORG_DIR 覆盖即时生效");
process.env.CCR_ORG_DIR = "/tmp/cc-deck-org-env-b";
assert(orgDir() === "/tmp/cc-deck-org-env-b", "覆盖逐次求值（非启动时快照）");
delete process.env.CCR_ORG_DIR;

// ---------- 锚读写 ----------
console.log("锚（org.json）:");
assert(readOrgAnchor(dir) === null, "无锚 → null");
assert(ensureOrgDir(dir) === dir, "ensureOrgDir 幂等");
const a1: OrgAnchor = { version: 1, leader_session_id: "relay-uuid-1", leader_sdk_id: "", created_at: 111, updated_at: 111 };
assert(writeOrgAnchor(a1, dir) === true, "写入成功");
const r1 = readOrgAnchor(dir);
assert(!!r1 && r1.leader_session_id === "relay-uuid-1" && r1.leader_sdk_id === "", "往返：sdk_id 空串合法（首建窗口）");
const r1b = readOrgAnchor(dir);
assert(!!r1b && r1b.leader_sdk_id === "" && r1b.version === 1, "缺省字段补齐不漂移");
writeFileSync(join(dir, "org.json"), "{not json", "utf-8");
assert(readOrgAnchor(dir) === null, "坏 JSON → null");
writeFileSync(join(dir, "org.json"), JSON.stringify({ version: 1, created_at: 1, updated_at: 1 }), "utf-8");
assert(readOrgAnchor(dir) === null, "缺 leader_session_id → null");
writeFileSync(join(dir, "org.json"), JSON.stringify({ version: 2, leader_session_id: "x", leader_sdk_id: "y", created_at: 1, updated_at: 1 }), "utf-8");
assert(readOrgAnchor(dir) === null, "version≠1 → null");
writeOrgAnchor({ version: 1, leader_session_id: "relay-uuid-2", leader_sdk_id: "sdk-xyz", created_at: 222, updated_at: 333 }, dir);
const r2 = readOrgAnchor(dir);
assert(!!r2 && r2.leader_session_id === "relay-uuid-2" && r2.leader_sdk_id === "sdk-xyz" && r2.updated_at === 333, "覆盖写入后读到新值");
clearOrgAnchor(dir);
assert(readOrgAnchor(dir) === null, "clearOrgAnchor 清锚");
// 旧锚缺 leader_sdk_id 字段 → 容忍为空串
writeFileSync(join(dir, "org.json"), JSON.stringify({ version: 1, leader_session_id: "relay-uuid-3", created_at: 1, updated_at: 1 }), "utf-8");
const r3 = readOrgAnchor(dir);
assert(!!r3 && r3.leader_sdk_id === "", "旧锚缺 sdk_id 容忍为空串");

// ---------- CLAUDE.md 幂等种子（M2 起带分诊通道增量段，标记幂等追加） ----------
console.log("CLAUDE.md 种子:");
const orgMd = () => readFileSync(join(dir, "CLAUDE.md"), "utf-8");
assert(ensureOrgClaudeMd(dir) === "created", "首建 → created（种子 + M2 分诊段一体）");
assert(ensureOrgClaudeMd(dir) === "exists", "再跑 → exists（标记在，零写入）");
assert(orgMd().startsWith(ORG_CLAUDE_MD_SEED) && orgMd().includes(ORG_CLAUDE_MD_M2_MARKER), "内容 = M1 种子 + M2 分诊段");
// 冲刺 F-11：种子不再含 M1 过渡段（新装不进矛盾文本）；补强段（分诊执行口径）一并落
assert(!ORG_CLAUDE_MD_SEED.includes("过渡期纪律"), "种子无 M1 过渡段（F-11：小事可直接办 vs 派 worker 打架源已除）");
assert(orgMd().includes(ORG_CLAUDE_MD_M2P1_MARKER), "首建含补强段（F-11 分诊执行口径）");
// M1 时代已落地的文件（无 M2 标记）：增量追加不回播、不丢既有记忆
const dirM1 = mkdtempSync(join(tmpdir(), "cc-deck-org-"));
const m1Content = ORG_CLAUDE_MD_SEED + "\n2026-09-26 用户偏好测试条目\n";
writeFileSync(join(dirM1, "CLAUDE.md"), m1Content, "utf-8");
assert(ensureOrgClaudeMd(dirM1) === "upgraded", "M1 旧档 → upgraded（补 M2 段）");
const upgraded = readFileSync(join(dirM1, "CLAUDE.md"), "utf-8");
assert(upgraded.includes("用户偏好测试条目") && upgraded.includes(ORG_CLAUDE_MD_M2_MARKER), "既有记忆保留 + M2 段就位");
assert(upgraded.includes(ORG_CLAUDE_MD_M2P1_MARKER), "M1 旧档一次升级补齐 M2 + 补强段（两段一体）");
// 冲刺 F-11 存量形态（已有 M2 段、无补强段——当前沙盒即此形状）：只补缺段，不重播 M2
const dirM2Only = mkdtempSync(join(tmpdir(), "cc-deck-org-"));
writeFileSync(join(dirM2Only, "CLAUDE.md"),
  ORG_CLAUDE_MD_SEED + "\n" + "## M2 分诊通道（旧版存量）\n\n- 旧文案占位\n\n2026-09-27 Leader 记忆条目\n", "utf-8");
assert(ensureOrgClaudeMd(dirM2Only) === "upgraded", "M2 存量档 → upgraded（只补补强段）");
const m2Only = readFileSync(join(dirM2Only, "CLAUDE.md"), "utf-8");
assert(m2Only.split("## M2 分诊通道").length === 2, "M2 段不重播（标记只出现一次）");
assert(m2Only.includes("Leader 记忆条目") && m2Only.includes(ORG_CLAUDE_MD_M2P1_MARKER), "记忆保留 + 补强段追加在尾");
assert(m2Only.indexOf(ORG_CLAUDE_MD_M2P1_MARKER) > m2Only.indexOf("Leader 记忆条目"), "补强段追加在既有内容之后");
assert(m2Only.includes(ORG_CLAUDE_MD_M2P1_SECTION.trim().split("\n")[0]), "补强段标题行原样");
rmSync(dirM2Only, { recursive: true, force: true });
assert(ensureOrgClaudeMd(dirM1) === "exists", "已 upgraded 再跑 → exists");
rmSync(dirM1, { recursive: true, force: true });
// 手改（有标记）后仍 exists
writeFileSync(join(dir, "CLAUDE.md"), orgMd() + "\n2026-09-27 新增记忆条目\n", "utf-8");
assert(ensureOrgClaudeMd(dir) === "exists", "手改后仍 exists");
assert(orgMd().includes("新增记忆条目"), "手改内容不被覆盖（幂等不回播种子）");
// 空目录再建
const dir2 = mkdtempSync(join(tmpdir(), "cc-deck-org-"));
assert(ensureOrgClaudeMd(dir2) === "created", "新目录首建");
rmSync(dir2, { recursive: true, force: true });

// ---------- 台账 ----------
console.log("台账（dispatch-log.ndjson）:");
assert(readDispatchLog(dir).length === 0, "无文件 → 空");
const mkEntry = (id: string, status: DispatchEntry["status"], receipt?: string): DispatchEntry =>
  ({ ts: Date.now(), id, tier: "咨询", target: "org-leader", status, ...(receipt !== undefined ? { receipt } : {}), session_id: "relay-uuid-9" });
assert(appendDispatch(mkEntry("d1", "running"), dir) === true, "追加 running");
assert(appendDispatch(mkEntry("d1", "done", "success"), dir) === true, "追加同 id done");
assert(appendDispatch(mkEntry("d2", "running"), dir) === true, "追加第二条 d2");
let log = readDispatchLog(dir);
assert(log.length === 2, "同 id 收敛视图 = 2 条分单");
assert(log.find((e) => e.id === "d1")?.status === "done" && log.find((e) => e.id === "d1")?.receipt === "success", "d1 收敛到 done+receipt");
assert(log.find((e) => e.id === "d2")?.status === "running", "d2 仍 running");
// 垃圾行容忍
writeFileSync(dispatchLogPath(dir), "{{garbage\n\nnot-json\n", { flag: "a" });
log = readDispatchLog(dir);
assert(log.length === 2, "垃圾行/空行跳过不炸");
// max 截尾
for (let i = 0; i < 100; i++) appendDispatch(mkEntry(`bulk-${i}`, "running"), dir);
log = readDispatchLog(dir, 10);
assert(log.length === 10 && log[9].id === "bulk-99" && log[0].id.startsWith("bulk-"), "max 截尾取最后 N 条分单");
// 连续追加顺序性
const dir3 = mkdtempSync(join(tmpdir(), "cc-deck-org-"));
mkdirSync(dir3, { recursive: true });
let allOk = true;
for (let i = 0; i < 100; i++) if (!appendDispatch(mkEntry(`seq-${String(i).padStart(3, "0")}`, "done", `r${i}`), dir3)) allOk = false;
const log3 = readDispatchLog(dir3);
assert(allOk && log3.length === 100, "连续 append 100 次全部成功");
assert(log3.every((e, i, arr) => i === 0 || arr[i - 1].id < e.id), "顺序性：id 按写入序");
rmSync(dir3, { recursive: true, force: true });

// ---------- 收尾 ----------
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
