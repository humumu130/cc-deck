// W-GATEFIX 回执闸断言：首战未鸣三根因修复的机器验证
// 矩阵：G1 提取归一（~→绝对，w-*.md 提取命中）G2 failed 收口也调度（静态锚）
//      G3 无回执→黄框（沙盒 SessionManager+假 dispatch 收口，CCR_RECEIPT_CHECK_MS=300ms）
//      G4 有回执→零通知 G5 pending 落盘+boot 补跑（重启窗兜底）
// 直跑：cd relay && env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT CCR_RECEIPT_CHECK_MS=300 npx tsx scripts/test-gatefix.ts
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };

const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
// G1 提取归一（静态锚：~ 拆解为 homedir join——不再存带 ~ 的字面量）
ok(sm.includes('join(homedir(), ".cc-deck", "artifacts"'), "G1① receiptPath 归一为 homedir 绝对路径（~ 字面量废弃）");
ok(sm.includes("w-[a-z0-9-]+") && sm.includes("artifacts"), "G1② 提取正则保留（w-*.md 词形）");
// G2 failed 也调度（静态锚）
ok(sm.includes('if (status === "done" || status === "failed") this.scheduleReceiptCheck'), "G2 failed 收口也调度回执闸（首战未鸣根因——SMALLFIX 实锤收口 status=failed 被旧 done-only 静默跳过）");

// 沙盒集成（G3/G4/G5）
const DATA = mkdtempSync(join(tmpdir(), "ccr-gatefix-"));
process.env.CCR_RECEIPT_CHECK_MS = "300";
const cfg: RelayConfig = { port: 18997, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null };
const mgr = new SessionManager(new EventBus(), cfg);
// 伪造 openDispatch + 直调 closeOpenDispatches 不可行（私有）——改走 runReceiptCheck 公开语义面：
// 通过 (mgr as any) 触达（测试面特权，同 replay-cf3 惯例）
const anyMgr = mgr as unknown as {
  openDispatches: Map<string, unknown[]>;
  closeOpenDispatches: (k: string, s: "done" | "failed", r: string) => void;
  scheduleReceiptCheck: (id: string, gid: string, t: string, p?: string) => void;
  loadPendingReceiptChecks: () => { id: string }[];
};
const NOTES: string[] = [];
// 拦黄框出口：包一层（upsertNotification 太重——直接 monkeypatch notifyLeaderSystem）
const realNotify = Object.getPrototypeOf(mgr).notifyLeaderSystem;
Object.getPrototypeOf(mgr).notifyLeaderSystem = function (text: string) { NOTES.push(text); };
try {
  // G3：failed 收口 + 无回执 → 黄框（300ms 窗）
  anyMgr.scheduleReceiptCheck("gf-p3", "pg-test", "W-测试件无回执", join(DATA, "w-nonexistent.md"));
  await new Promise((r) => setTimeout(r, 700));
  ok(NOTES.some((t) => t.includes("gf-p3".slice(0, 8)) && t.includes("收口无回执")), "G3 无回执→黄框触发（300ms 缩短窗真实验证）");
  // G4：有回执 → 零新增通知
  writeFileSync(join(DATA, "w-exists.md"), "# 回执\n");
  const before = NOTES.length;
  anyMgr.scheduleReceiptCheck("gf-p4", "pg-test", "W-测试件有回执", join(DATA, "w-exists.md"));
  await new Promise((r) => setTimeout(r, 700));
  ok(NOTES.length === before, "G4 有回执→零误报");
  // G5：pending 落盘 + boot 补跑（调度后立即「重启」=丢弃定时器，只留盘账）
  anyMgr.scheduleReceiptCheck("gf-p5", "pg-test", "W-重启窗件", join(DATA, "w-nonexistent.md"));
  ok(existsSync(join(DATA, "pending-receipt-checks.json")), "G5① pending 账落盘（重启窗可见）");
  const mgr2 = new SessionManager(new EventBus(), cfg) as unknown as { recoverPendingReceiptChecks: () => number };
  ok(mgr2.recoverPendingReceiptChecks() >= 1, "G5② boot 补跑吃回 pending（重启窗兜底闭环）");
  await new Promise((r) => setTimeout(r, 300));
} finally {
  Object.getPrototypeOf(mgr).notifyLeaderSystem = realNotify;
  rmSync(DATA, { recursive: true, force: true });
}
ok(NOTES.some((t) => t.includes("gf-p5".slice(0, 8))), "G5③ 补跑后黄框送达（重启窗件）");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
