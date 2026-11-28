// DL-P1-5 巡逻持续告警升级专项（2026-11-27 夜间缺陷台账）：push 的投递通道
// （notifyDone→通知账→端上面板）与 relay 同生死——生产实证 11-23 14:13 起九功能位
// 全红持续 3.5 天零触达（relay 活着的 33h 里也没报，「检测在、外发无」）。
// 本件断言：同文本告警持续超阈（CCR_PATROL_ESCALATE_MS）→ ESCALATED 报告行（独立
// 于面板通道的落盘观察点）+ 同 onset 只升一次 + 文本变=新 onset + resolve 清账 +
// 显式 0=关。osascript 发射面不直测（darwin GUI 会话外不可断言，报告行是可测锚）。
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PatrolModule } from "../src/patrol.js";

const ROOT = fileURLToPath(new URL("../data/test-patrol-escalate/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.CCR_DATA_DIR = join(ROOT, "datadir"); // auto-tiers 读档隔离（缺省档=auto）

let pass = 0, fail = 0;
const assert = (c: unknown, name: string) => { if (c) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const report = join(ROOT, "patrol-report.md");
// 假 mgr：零会话（ALERT-NO-TARGET 形态——升级最该响的场景）+通知面记账桩
const notified: string[] = [];
const mgr = {
  snapshot: () => [],
  notifyDone: (_sid: string, lines: string[]) => notified.push(lines.join(" ")),
} as never;
const p = new PatrolModule(mgr, { dataDir: join(ROOT, "datadir"), reportPath: report, enabled: () => true });
const push = (key: string, text: string) => ((p as unknown as { push(k: string, t: string): void }).push(key, text));
const resolveKey = (key: string) => ((p as unknown as { resolve(k: string): void }).resolve(key));
const reportText = () => { try { return readFileSync(report, "utf-8"); } catch { return ""; } };
const escalatedCount = () => (reportText().match(/ESCALATED \[/g) ?? []).length;

// ---------- 场景 A：持续超阈升级（一次/onset） ----------
{
  // 窗 2000ms（DEV-33 预批修法，S3 终审参数）：CI 低配 runner 上 120ms 睡眠可实际
  // 超睡 >500ms（run 46087000346 实锤 A1 假红）——窗 500→2000＋首睡眠 120→400，
  // 不升方向余量 5 倍；后续「须超窗」睡眠同步抬到 ≥2200ms（定时器只晚不早，
  // ≥2200ms 恒 > 2000ms 窗，升方向无假绿）。
  process.env.CCR_PATROL_ESCALATE_MS = "2000";
  push("worker-stale", "3 个会话 WORKING 停滞>40min：x、y、z");
  await sleep(400);
  push("worker-stale", "3 个会话 WORKING 停滞>40min：x、y、z"); // 窗内重复：不升
  assert(escalatedCount() === 0, "A1 窗内同文重复不升级");
  await sleep(1800); // 累计 ~2200ms > 2000ms 窗
  push("worker-stale", "3 个会话 WORKING 停滞>40min：x、y、z");
  assert(escalatedCount() === 1, "A2 持续超阈 → ESCALATED 报告行落盘（面板外独立观察点）");
  await sleep(550);
  push("worker-stale", "3 个会话 WORKING 停滞>40min：x、y、z");
  assert(escalatedCount() === 1, "A3 同 onset 只升一次（不刷屏）");
  assert(reportText().includes("ESCALATED [worker-stale] 巡检告警 [worker-stale] 持续") && reportText().includes("未恢复"), "A4 升级行带持续时长与告警文本（可排障）");
  assert(notified.length === 0, "A5 零会话形态面板通道零投递（ALERT-NO-TARGET——升级是唯一触达面）");
}

// ---------- 场景 B：文本变化=新 onset；resolve 清账 ----------
{
  push("worker-stale", "5 个会话 WORKING 停滞>40min：a、b、c、d、e"); // 文本变=新 onset
  await sleep(2200);
  push("worker-stale", "5 个会话 WORKING 停滞>40min：a、b、c、d、e");
  assert(escalatedCount() === 2, "B1 文本变化=新 onset 重新可升（恶化形态不被旧 onset 吞）");
  resolveKey("worker-stale");
  push("worker-stale", "5 个会话 WORKING 停滞>40min：a、b、c、d、e"); // 恢复后新 onset
  await sleep(2200);
  push("worker-stale", "5 个会话 WORKING 停滞>40min：a、b、c、d、e");
  assert(escalatedCount() === 3, "B2 resolve 清账（恢复后复发=新持续段可再升）");
}

// ---------- 场景 C：显式 0=关（逃生阀） ----------
{
  process.env.CCR_PATROL_ESCALATE_MS = "0";
  push("disk", "磁盘余量 3.2GB（红线 5GB）");
  await sleep(550);
  push("disk", "磁盘余量 3.2GB（红线 5GB）");
  assert(escalatedCount() === 3, "C1 显式 0=升级关阀（旧行为零升级）");
  delete process.env.CCR_PATROL_ESCALATE_MS;
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n== test-patrol-escalate 汇总：${pass} ok / ${fail} FAIL ==`);
if (fail > 0) process.exit(1);
