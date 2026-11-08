// dutyreviewed（t-8712b7b1 第二现）：已核销回执复投永动——reviewed 键形态不同源契约锁。
//   实测定键（1109 生产实测）：acceptance id 恒 32 位 hex（验收单文件名/listAcceptances
//   s.id）；duty-reviewed.json 曾存 12 位短截断键（PM 止血按 feed 显示形态抄录）→ 与
//   32 位真 id 全等比对恒不中 → receiptCandidates filter 恒过 → 复投永动（三陈回执
//   51f856485cc1/aa56fdcb273f/ff0f11f5fe42 连投两轮）。
//   修=三刀：①生产数据修正（短键→真 id）②写侧断言（markDutyReviewed 拒非 32 位 hex）
//   ③读侧兼容层（短键前缀匹配兜底）+防御日志（>24h 未核销候选可观测）。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const REAL_A = "51f856485cc1bd02a150f2f8ed91b767"; // 生产三候选真 id（实测贴原文）
const REAL_B = "aa56fdcb273fb2dcca39269de408f861";
const REAL_C = "ff0f11f5fe42f74c89d223a77cae21d1";

async function main(): Promise<void> {
  const { readDutyReviewed, markDutyReviewed } = await import("../src/leader-duty.js");

  console.log("A. 匹配矩阵（reviewed 判定四形态）");
  {
    // 兼容层语义复刻（pendingAcceptanceReceipts 同款判定——纯函数直验）
    const FULL = /^[0-9a-f]{32}$/;
    const judge = (reviewedRaw: string[], id: string): boolean => {
      const set = new Set(reviewedRaw);
      const short = reviewedRaw.filter((k) => !FULL.test(k) && /^[0-9a-f]{6,31}$/.test(k));
      return set.has(id) || short.some((k) => id.startsWith(k));
    };
    assert(judge([REAL_A, REAL_B, REAL_C], REAL_A), "32 位原文键 → 命中（正例——修正后生产形态）");
    assert(judge(["51f856485cc1", "aa56fdcb273f", "ff0f11f5fe42"], REAL_A), "12 位短键前缀 → 兼容层命中（修前生产形态兜底——复投永动根除）");
    assert(judge([REAL_A], "99999999999999999999999999999999") === false, "无关节点 32 位 → 不命中（前缀不撞）");
    assert(judge(["51f856485cc1"], "51f856485ccXbd02a150f2f8ed91b767".replace("X", "9")) === false, "12 位前缀但后段不同 → 不命中（前缀匹配不误伤）");
    assert(judge(["zz非hex"], REAL_A) === false, "非 hex 键 → 不命中（兼容层只认 hex 短形态）");
  }

  console.log("B. 复现用例（短形态→仍投→修正后不投）");
  {
    const root = mkdtempSync(join(tmpdir(), "dutyreviewed-"));
    try {
      const dir = join(root, "org");
      mkdirSync(dir, { recursive: true });
      // 修前形态：短键文件
      writeFileSync(join(dir, "duty-reviewed.json"), JSON.stringify(["51f856485cc1", "aa56fdcb273f", "ff0f11f5fe42"]) + "\n", "utf-8");
      const rawBefore = readDutyReviewed(dir);
      const FULL = /^[0-9a-f]{32}$/;
      const beforeHit = rawBefore.includes(REAL_A) || rawBefore.filter((k) => !FULL.test(k)).some((k) => REAL_A.startsWith(k));
      assert(!rawBefore.includes(REAL_A) && beforeHit, "修前形态复现：短键全等不中（复投永动根）+兼容层前缀兜底命中");
      // 修正形态：真 id 文件
      writeFileSync(join(dir, "duty-reviewed.json"), JSON.stringify([REAL_A, REAL_B, REAL_C], null, 2) + "\n", "utf-8");
      assert(readDutyReviewed(dir).includes(REAL_A), "修正形态：真 id 全等命中（leader-duty receiptCandidates filter(r=>r.reviewed!==true) 即拒——候选不再投）");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  console.log("C. markDutyReviewed 写侧断言（防再犯）");
  {
    const root = mkdtempSync(join(tmpdir(), "dutyreviewed-w-"));
    try {
      const dir = join(root, "org");
      mkdirSync(dir, { recursive: true });
      markDutyReviewed([REAL_A], dir); // 合法 32 位 → 落盘
      let saved = JSON.parse(readFileSync(join(dir, "duty-reviewed.json"), "utf-8"));
      assert(saved.includes(REAL_A), "合法 32 位 hex 落盘（正例）");
      markDutyReviewed(["51f856485cc1"], dir); // 12 位短 → 拒写
      saved = JSON.parse(readFileSync(join(dir, "duty-reviewed.json"), "utf-8"));
      assert(!saved.includes("51f856485cc1"), "12 位短截断拒写（断言防再犯——恒不匹配键不入文件）");
      markDutyReviewed(["NOT-HEX-形态!!"], dir);
      saved = JSON.parse(readFileSync(join(dir, "duty-reviewed.json"), "utf-8"));
      assert(saved.length === 1, "非 hex 键拒写（文件长度不变——实=" + saved.length + "）");
      markDutyReviewed([REAL_B, "deadbeef"], dir); // 混合：合法过+非法拒
      saved = JSON.parse(readFileSync(join(dir, "duty-reviewed.json"), "utf-8"));
      assert(saved.includes(REAL_B) && !saved.includes("deadbeef"), "混合入参：合法落盘+非法拒（部分成功语义）");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  console.log("D. 源码锚（读侧兼容层+防御日志+产源键位）");
  {
    const { readFileSync: rf } = await import("node:fs");
    const sm = rf(new URL("../src/session-manager.ts", import.meta.url), "utf8");
    assert(sm.includes("shortPrefixes") && sm.includes("s.id.startsWith(k)"), "读侧兼容层在场（短键前缀匹配兜底）");
    assert(sm.includes("dutyReceiptStaleNotedAt") && sm.includes("陈回执候选未核销"), "防御日志在场（>24h 未核销 60s 去重告警——复投永动可发现）");
    assert(sm.includes("const reviewed = reviewedSet.has(s.id)"), "产源 reviewed 判定保持（reviewedSet 主路+兼容层兜底）");
    const ld = rf(new URL("../src/leader-duty.ts", import.meta.url), "utf8");
    assert(ld.includes("拒写") && ld.includes("/^[0-9a-f]{32}$/"), "写侧断言在 leader-duty（32 位 hex 唯一合法形态）");
    assert(ld.includes("receipt.reviewed !== true"), "receiptCandidates 过滤语义零变化（DUTYBACKOFF R3 红线）");
  }

  console.log(`\n========== dutyreviewed 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
