// W-CMDIMPL T0a（#216，设计 §5.3 案甲三件套）——fs-safe 原语 + projects.json 落盘安全
// 专项断言：①tmp+rename 原子写（无残留 tmp）②journal 追加（先于主写/滚动/失败不阻断）
// ③坏 JSON 只读闸 + journal 回放自动重建 + 人工修复自动解除 ④org.json 原子写。
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-t0-fs-safe.ts
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, appendJournal, lastGoodJournalSnapshot } from "../src/fs-safe.js";
import { listGroups, createGroup, isProjectsReadOnly } from "../src/projects.js";
import { readOrgAnchor, writeOrgAnchor } from "../src/org.js";

process.env.CCR_STORAGE_READ_MODE = "json"; // 钉 json 档（test-projects 同款）

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), "cc-deck-t0-"));

// ---------- ① 原子写 ----------
console.log("原子写:");
const f1 = join(dir, "a.json");
assert(atomicWriteJson(f1, '{"x":1}') === true, "原子写成功");
assert(JSON.parse(readFileSync(f1, "utf-8")).x === 1, "内容正确");
assert(readdirSync(dir).filter((n) => n.includes(".tmp-")).length === 0, "成功后无残留 tmp");
assert(atomicWriteJson("/nonexistent-dir-xyz/a.json", "{}") === false, "目录不存在 → false");
assert(atomicWriteJson(f1, '{"x":2}') === true && JSON.parse(readFileSync(f1, "utf-8")).x === 2, "覆写生效");

// ---------- ② journal ----------
console.log("journal:");
const jf = join(dir, "j.ndjson");
appendJournal(jf, { ts: 1, kind: "t", snapshot: { a: 1 } });
appendJournal(jf, { ts: 2, kind: "t", snapshot: { a: 2 } });
assert(readFileSync(jf, "utf-8").trim().split("\n").length === 2, "追加两行");
assert((lastGoodJournalSnapshot(jf) as { a: number }).a === 2, "末行快照返回（倒序找最近好行）");
writeFileSync(jf, '{"bad line\n' + JSON.stringify({ ts: 9, snapshot: { a: 9 } }) + "\n", "utf-8");
assert((lastGoodJournalSnapshot(jf) as { a: number }).a === 9, "半写行跳过，取最近可解析快照");
appendJournal(join(dir, "no-such-dir", "x.ndjson"), { ts: 1 });
assert(!existsSync(join(dir, "no-such-dir")), "journal 失败不炸不建目录（纪律①）");

// ---------- ③ projects.json 三件套 ----------
console.log("projects 三件套:");
const pdir = mkdtempSync(join(tmpdir(), "cc-deck-t0-p-"));
// 正常写 → journal 有行 + 文件无 tmp 残留
const g = createGroup({ name: "t0", anchor_dir: join(pdir, "proj"), tier: "轻立项" }, pdir);
assert(g.ok !== false, "createGroup 正常路径成功");
assert(existsSync(join(pdir, "projects-journal.ndjson")), "主写伴随 journal 行（第二件）");
assert(readdirSync(pdir).filter((n) => n.includes(".tmp-")).length === 0, "主写无残留 tmp（第一件原子写）");
assert(listGroups(pdir).some((x) => x.name === "t0"), "写后读回一致");
// 场景一（journal 在场）：坏 JSON → journal 回放自动重建（第三件的恢复面，只读不出现）
const goodSnapshot = { groups: [{ id: "g-recover", name: "recovered", anchor_dir: "/tmp/rec", status: "active", tier: "轻立项", headcount: [], single_card: false, created_at: 1, updated_at: 1 }], trust_light: true };
appendJournal(join(pdir, "projects-journal.ndjson"), { ts: Date.now(), kind: "projects", groups_n: 1, trust_light: true, snapshot: goodSnapshot });
writeFileSync(join(pdir, "projects.json"), "{corrupted-again", "utf-8");
const groups = listGroups(pdir);
assert(groups.some((x) => x.id === "g-recover"), "坏文件 → journal 回放自动重建（最近好快照）");
assert(isProjectsReadOnly() === false, "回放成功 → 只读自动解除");
assert(JSON.parse(readFileSync(join(pdir, "projects.json"), "utf-8")).groups[0].id === "g-recover", "重建文件落盘（原子写）");
// 场景二（journal 缺席）：坏 JSON → 只读模式 + 写拒 + 损坏文件保留（人工处置窗口）
const pdir2 = mkdtempSync(join(tmpdir(), "cc-deck-t0-p2-"));
writeFileSync(join(pdir2, "projects.json"), "{corrupted", "utf-8");
listGroups(pdir2);
assert(isProjectsReadOnly() === true, "坏 JSON 且无 journal → 只读模式（第三件兜底闸）");
const g2 = createGroup({ name: "t0b", anchor_dir: join(pdir2, "proj2"), tier: "轻立项" }, pdir2);
assert((g2 as { ok?: boolean }).ok === false, "只读模式写操作被拒（防空态写回）");
assert(readFileSync(join(pdir2, "projects.json"), "utf-8") === "{corrupted", "损坏文件未被覆盖（人工处置窗口保留）");
// 人工修复 → 好文件读入 → 只读解除
writeFileSync(join(pdir2, "projects.json"), JSON.stringify({ groups: [], trust_light: false }), "utf-8");
listGroups(pdir2);
assert(isProjectsReadOnly() === false, "人工修复文件 → 只读自动解除");
rmSync(pdir2, { recursive: true, force: true });

// ---------- ④ org.json 原子写 ----------
console.log("org 锚:");
const adir = mkdtempSync(join(tmpdir(), "cc-deck-t0-a-"));
assert(writeOrgAnchor({ version: 1, leader_session_id: "sess-1", leader_sdk_id: "sdk-1", created_at: 1, updated_at: 1 }, adir) === true, "锚原子写成功");
assert(readOrgAnchor(adir)?.leader_session_id === "sess-1", "锚读回一致");
assert(readdirSync(adir).filter((n) => n.includes(".tmp-")).length === 0, "锚写无残留 tmp");

rmSync(dir, { recursive: true, force: true });
rmSync(pdir, { recursive: true, force: true });
rmSync(adir, { recursive: true, force: true });
console.log(`\n== T0a: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
