// W-RESTARTDESIGN 直跑测试：restart-ledger 四场景（回灌往返/过期分层/原子写/失败重试）
// + dispatch-queue 收编锚 + 回执闸静态锚。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-restart-ledger.ts
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as rf, existsSync as ex } from "node:fs";
// @ts-expect-error .ts 直引（tsx 直跑口径）
import { saveRestartLedger, loadRestartLedger, restartLedgerTtlMs, resetRestartLedgerForTests } from "../src/restart-ledger.ts";
// @ts-expect-error 同上
import { resetDispatchQueueRetryForTests } from "../src/dispatch-queue.ts";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function assert(cond: boolean, name: string): void {
  if (!cond) throw new Error(name);
}

console.log("== W-RESTARTDESIGN：restart-ledger 四场景 + 收编/闸锚 ==");

// ---- 场景①：回灌往返（save→load 幂等 + 孤儿由调用方处理——模块面只验往返） ----
{
  resetRestartLedgerForTests();
  const dir = mkdtempSync(join(tmpdir(), "ccr-rl-"));
  try {
    saveRestartLedger(dir, [
      { session_id: "s-1", unacked: [{ id: "m-1", text: "用户消息", ts: Date.now() }], resumeFailStreak: 2 },
      { session_id: "s-2", unacked: [], resumeCooldownUntil: Date.now() + 60_000 },
    ]);
    const { entries, droppedRenewable } = loadRestartLedger(dir);
    ok(entries.length === 2, "① 往返：两条目保存+读回");
    ok(entries[0].session_id === "s-1" && entries[0].unacked[0].text === "用户消息", "① unacked 字段往返保真");
    ok(entries[0].resumeFailStreak === 2 && entries[1].resumeCooldownUntil !== undefined, "① 熔断两字段往返保真");
    ok(droppedRenewable === 0, "① 新鲜条目零过期丢弃");
    // 空账保存=空文件；读回空
    saveRestartLedger(dir, []);
    ok(loadRestartLedger(dir).entries.length === 0, "① 空账往返");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- 场景②：过期分层（renewable 超 TTL 丢 / 用户消息永不过期） ----
{
  resetRestartLedgerForTests();
  const dir = mkdtempSync(join(tmpdir(), "ccr-rl-"));
  const ttl = restartLedgerTtlMs();
  try {
    const now = Date.now();
    saveRestartLedger(dir, [
      {
        session_id: "s-x",
        unacked: [
          { id: "r-old", text: "值守可再生", ts: now - ttl - 1_000, renewable: true },
          { id: "u-old", text: "用户消息", ts: now - ttl - 600_000 },
          { id: "r-new", text: "新鲜 renewable", ts: now - 1_000, renewable: true },
        ],
      },
    ]);
    const { entries, droppedRenewable } = loadRestartLedger(dir, now);
    const ids = entries[0].unacked.map((m) => m.id);
    ok(droppedRenewable === 1, "② 仅 renewable 超 TTL 被丢（1 条）");
    ok(ids.includes("u-old"), "② 用户消息永不过期（超 TTL 仍留——#7 必达）");
    ok(!ids.includes("r-old"), "② 超期 renewable 已丢");
    ok(ids.includes("r-new"), "② 新鲜 renewable 保留");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- 场景③：原子写（产物是合法 JSON 无 tmp 残留 + 覆盖旧档） ----
{
  resetRestartLedgerForTests();
  const dir = mkdtempSync(join(tmpdir(), "ccr-rl-"));
  try {
    saveRestartLedger(dir, [{ session_id: "a", unacked: [{ id: "1", text: "t", ts: 1 }] }]);
    // 覆盖写
    saveRestartLedger(dir, [{ session_id: "b", unacked: [] }]);
    const raw = JSON.parse(readFileSync(join(dir, "restart-ledger.json"), "utf-8"));
    ok(raw.version === 1 && raw.entries.length === 1 && raw.entries[0].session_id === "b", "③ 覆盖写最新胜+合法 JSON");
    ok(!existsSync(join(dir, "restart-ledger.json.tmp")), "③ 无 tmp 残留（rename 完成）");
    // 坏档：load 回空不抛
    writeFileSync(join(dir, "restart-ledger.json"), "{broken");
    const bad = loadRestartLedger(dir);
    ok(bad.entries.length === 0, "③ 坏档回空不抛（跳回灌）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- 场景④：写穿失败重试（目录被同名文件占位→writeFileSync throw→false+不抛） ----
{
  resetRestartLedgerForTests();
  const dir = mkdtempSync(join(tmpdir(), "ccr-rl-"));
  try {
    // 占位：target.tmp 做成目录 → writeFileSync(tmp) throw
    mkdirSync(join(dir, "restart-ledger.json.tmp"), { recursive: true });
    const r = saveRestartLedger(dir, [{ session_id: "a", unacked: [] }]);
    ok(r === false, "④ 写穿失败返回 false（不抛）");
    // 重试后成功路径仍通：清占位再 save
    rmSync(join(dir, "restart-ledger.json.tmp"), { recursive: true, force: true });
    ok(saveRestartLedger(dir, [{ session_id: "a", unacked: [] }]) === true, "④ 退避重试后成功落盘");
    resetRestartLedgerForTests();
    resetDispatchQueueRetryForTests();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- 场景⑤：dispatch-queue 收编锚（静态：退避 helper 在场） ----
{
  const src = rf(join(import.meta.dirname, "../src/dispatch-queue.ts"), "utf-8");
  ok(src.includes("dqRetry") && src.includes("renameSync"), "⑤ dispatch-queue 原子写+退避在场");
  ok(src.includes("console.error"), "⑤ 三次失败 error 高噪在场");
}

// ---- 场景⑥：回执闸静态锚（方法体+挂点+ledger 收编） ----
{
  const sm = rf(join(import.meta.dirname, "../src/session-manager.ts"), "utf-8");
  ok(sm.includes("private scheduleReceiptCheck("), "⑥① 回执闸方法体在场");
  ok(sm.includes('if (status === "done" || status === "failed") this.scheduleReceiptCheck('), "⑥② 收口边沿挂点在场（done||failed，W-GATEFIX）");
  ok(sm.includes("notifyLeaderSystem"), "⑥③ 无会话落 ledger 方法在场");
  ok(sm.includes("user-note-"), "⑥④ notifyConfirm ledger 收编（source:user-note）在场");
  const ws = rf(join(import.meta.dirname, "../src/ws-server.ts"), "utf-8");
  ok(ws.includes("queued: true") && ws.includes("notifyLeaderSystem"), "⑥⑤ /api/notify 两分支 200+queued 在场");
  const idx = rf(join(import.meta.dirname, "../src/index.ts"), "utf-8");
  ok(/applyPinned[\s\S]{0,600}loadRestartLedgerOnBoot[\s\S]{0,400}reloadDispatchQueue/.test(idx), "⑥⑥ boot 顺序：pinned→ledger→queue（F2）");
  ok(sm.includes("loadRestartLedgerOnBoot(): "), "⑥⑦ 回灌方法体在场");
  ok(sm.includes("restart-undelivered-"), "⑥⑧ 用户消息终态未投递通知在场（F1）");
  ok(/receiptPath\?\) => \{/.test(sm) || sm.includes("receiptPath?: string"), "⑥⑨ 任务书回执路径提取+存 dispatch 记录（receiptPath 字段链）");
  ok(/existsSync\(entry\.receiptPath\)/.test(sm), "⑥⑩ 精确核对优先（entry.receiptPath existsSync；无提取值回落前缀扫描，W-GATEFIX 归一后）");
}

console.log(`\nrestart-ledger: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
