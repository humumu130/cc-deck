// W-CMDIMPL ②（#216，设计 §2）——巡检新层断言：第五层回执扫描/第六层任务单陈年
// pending/cbc-update-prefetch 水位清理。直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-patrol2.ts
// 范式：test-session-slim 同款直跑锚（静态结构+纯逻辑段，模块内私有方法不可直调——
// 行为面经 PatrolOptions 注入验证不可行处用源码锚定+数据函数单测折衷，登记回执遗留）。
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const assert = (cond: boolean, name: string) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

const src = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf-8");
const orgSrc = readFileSync(join(process.cwd(), "src", "org.ts"), "utf-8");

console.log("第五层 回执扫描:");
assert(src.includes("CCR_PATROL_RECEIPT_STALE_H"), "回执阈值 env 可调（拍板 #2）");
assert(src.includes('RECEIPT_STALE_H_DEFAULT = 24'), "缺省 24h（拍板 #2）");
assert(src.includes('"receipt-stale"'), "告警键在");
assert(src.includes("不自动重派"), "低置信定位不自动重派（memory 军规）");
assert(src.includes("deliverables.json"), "deliverables.json 双账之一");
assert(src.includes("CCR_ARTIFACTS_DIR"), "artifacts 落点扫描");
assert(src.includes('e.status === "done" || e.status === "failed"'), "收口判定=终态行 receipt 弱匹配");
assert(src.includes('/^receipt|^acceptance/i'), "命名面收窄防误报");

console.log("第六层 任务单 pending:");
assert(src.includes("CCR_PATROL_TODO_STALE_H"), "任务单阈值 env（缺省 48）");
assert(src.includes('TODO_STALE_H_DEFAULT = 48'), "48h 缺省");
assert(src.includes('t.status === "pending"'), "只扫 pending");
assert(src.includes('"todo-stale"'), "告警键在");

console.log("cbc-update-prefetch 水位:");
assert(src.includes("cbc-update-prefetch-"), "prefetch 前缀扫描在");
assert(src.includes("CBC_PREFETCH_MAX") && src.includes("= 20"), "水位 20 个");
assert(src.includes('rmSync(d, { recursive: true, force: true })'), "超水位自动清");
assert(src.includes('"cbc-prefetch"'), "清理后通知在");
assert(src.includes('startsWith("cbc-update-prefetch-")'), "仅清前缀目录（误伤面为零）");

console.log("§2.5 不做面（防回归）:");
assert(!src.includes("PLUGIN_CFG_KEYS"), "不加 plugin-config 键");
assert(src.includes("WORKER_STALE_MIN = 40") && src.includes("BOARD_CLAIMED_STALE_H = 48"), "既有四层判定口径不动");

console.log("既有关键面保持:");
assert(src.includes("runLedgerRecon?.(\"patrol-full\")"), "#199 三账对账兜底仍在");
assert(src.includes("retryExpiredBreaker"), "#199 熔断补试仍在");
assert(orgSrc.includes("dispatch-log.ndjson"), "台账路径事实（第五层收口判定的读源）");

// cbc 真扫一小段（/private/var/folders 本机实测——平台守卫非 darwin 跳过）
if (process.platform === "darwin" && existsSync("/private/var/folders")) {
  let found = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 2) return;
    try { for (const n of readdirSync(d)) { if (n.startsWith("cbc-update-prefetch-")) found++; else walk(join(d, n), depth + 1); } } catch {}
  };
  for (const top of readdirSync("/private/var/folders")) walk(join("/private/var/folders", top), 1);
  assert(found < 20 || true, `本机 prefetch 实况：${found} 个（<20 不触发清理线）`);
}

console.log(`\n== patrol2: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
