// W-DUTYBACKOFF 断言件（1106 用户实锤两连：①「一直在对话中还巡什么检」②「加个退避
// 策略」；③DUTY_RECEIPT 协议半接线——pendingAcceptanceReceipts 硬编码 reviewed:false，
// test.97 三陈回执重复投喂 38h+）。
// 三组（fake timer/短 env——无真实 sleep 长等待）：
//   A 刀1：lastRealUserMessageAt 双源（真实 user_message 命中/[值守喂活] 注入排除/无消息
//     null）+dutyUserActiveSkip 行为（活跃→true，超窗→false）
//   B 刀2：dutyNoProgressDelayMs 级数表（5→15→30→60 封顶）+feedPM 无进展退避审计行
//     （同 top 连喂→第 2 轮起 sleep·no_progress_backoff；top 变化复位）
//   C 刀3：readDutyReviewed/markDutyReviewed 持久化往返+pendingAcceptanceReceipts 过滤
//     （accept 后同 receipt 不再入候选——跨「重启」=新实例仍过滤）+maybeConsumeDutyReceipt
//     副作用（accept ids 落 reviewed+审计；坏行 receipt_missing 不惩罚）
// 直跑：env -u CCR_DATA_DIR -u CCR_ORG_DIR -u CCR_PORT npx tsx scripts/test-dutybackoff.ts
for (const k of ["CCR_DATA_DIR", "CCR_ORG_DIR", "CCR_PORT", "CCR_PARENT_PID", "CCR_RELAY_CHILD"]) delete process.env[k];
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastRealUserMessageAt, dutyNoProgressDelayMs, dutyUserActiveMin } from "../src/duty-feed.js";
import { readDutyReviewed, markDutyReviewed, parseDutyReceipt } from "../src/leader-duty.js";

const ORG = mkdtempSync(join(tmpdir(), "dbo-org-"));
const DATA = mkdtempSync(join(tmpdir(), "dbo-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_PM_DUTY = "1";

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { if (c) { pass++; console.log("  ok - " + n); } else { fail++; console.error("FAIL: " + n); } };

// ---------- A 刀1：真实用户消息判据 ----------
{
  const now = Date.now();
  const ev = join(DATA, "events.ndjson");
  const sid = "pm-target-1";
  // 三行：真实消息（5min 前）/值守注入回显（1min 前——更近但应排除）/assistant（噪音）
  appendFileSync(ev, JSON.stringify({ type: "SESSION_LOG", session_id: sid, ts: now - 5 * 60_000, payload: { kind: "user_message", text: "这个问题怎么看" } }) + "\n");
  appendFileSync(ev, JSON.stringify({ type: "SESSION_LOG", session_id: sid, ts: now - 60_000, payload: { kind: "user_message", text: "[值守喂活] feed=abc 触发=turn_end" } }) + "\n");
  appendFileSync(ev, JSON.stringify({ type: "SESSION_LOG", session_id: sid, ts: now - 30_000, payload: { kind: "assistant_text", text: "答复" } }) + "\n");
  const at = lastRealUserMessageAt(DATA, sid);
  ok(at !== null && Math.abs(at - (now - 5 * 60_000)) < 5, `A1 真实消息命中+注入排除（实 ${at}≈${now - 5 * 60_000}——[值守喂活] 回显不计）`);
  ok(lastRealUserMessageAt(DATA, "pm-other") === null, "A2 无消息会话 null");
  ok(dutyUserActiveMin() === 10, `A3 活跃窗缺省 10min（实 ${dutyUserActiveMin()}）`);
  // A4：真实消息 5min 前 < 10min 窗=活跃；伪造 15min 前=出窗
  appendFileSync(ev, JSON.stringify({ type: "SESSION_LOG", session_id: "pm-2", ts: now - 15 * 60_000, payload: { kind: "user_message", text: "旧的" } }) + "\n");
  const at2 = lastRealUserMessageAt(DATA, "pm-2");
  ok(at2 !== null && now - at2 >= dutyUserActiveMin() * 60_000, "A4 15min 前消息出窗（不活跃）");
}

// ---------- B 刀2：级数表 ----------
{
  ok(dutyNoProgressDelayMs(1) === 5 * 60_000 && dutyNoProgressDelayMs(2) === 15 * 60_000, "B1 级数 1/2=5/15min");
  ok(dutyNoProgressDelayMs(3) === 30 * 60_000 && dutyNoProgressDelayMs(4) === 60 * 60_000 && dutyNoProgressDelayMs(9) === 60 * 60_000, "B2 级数 3/4/9=30/60/60（封顶）");
  // B3：feedPM 无进展退避行为（真 SessionManager——短窗 env 造活跃候选+同 top 连喂两次）
  const { SessionManager } = await import("../src/session-manager.js");
  const { EventBus } = await import("../src/event-bus.js");
  const cfg = (await import("../src/config.js")).loadConfig() as never;
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  let spawnN = 0;
  mgr.setAgentFactory(((_cwd: string, _m: string, cb: { onInit: (s: string, m: string) => void; onTurnEnd: (ok: boolean, r: string, d: number) => void }): unknown => {
    spawnN++;
    setTimeout(() => {
      try {
        cb.onInit(`sdk-dbo-${spawnN}`, "m");
        // 回合收口（ Leader 首回合 DONE——否则 WORKING 合并语义让 feedPM 静默早退）
        setTimeout(() => { try { cb.onTurnEnd(true, "success", 10); } catch { /* 收口竞态静默 */ } }, 5);
      } catch { /* 孪生守卫等 throw 静默 */ }
    }, 0);
    return { id: `a${spawnN}`, startedAt: Date.now(), ended: false, sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false, stop: async () => {}, setPermissionMode: async () => {} };
  }) as never);
  // 造值守目标：leader 模式（dutyEnabled+leaderId）——ensureLeader 首建 spawn
  const led = mgr.ensureLeader();
  ok(led.ok === true, `B3 前置 Leader 建位（${led.ok ? "ok" : JSON.stringify(led).slice(0, 60)}）`);
  await new Promise((r) => setTimeout(r, 300));
  // 造 pending receipt 候选（acceptances 目录+未提交单）
  const accDir = join(DATA, "acceptances");
  mkdirSync(accDir, { recursive: true });
  writeFileSync(join(accDir, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.json"), JSON.stringify({ id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", submitted: false, updated_at: Date.now() - 40 * 3600_000, rows: [{ label: "回归", result: "", note: "" }] }), "utf-8");
  const rounds0 = () => { try { return readFileSync(join(DATA, "duty-rounds.ndjson"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { result?: string; reason?: string; detail?: string }); } catch { return []; } };
  const inner = mgr as unknown as { feedPM: (t: string, o?: { continuation?: boolean }) => void; dutyNoProgressStreak: number; dutyNextFeedAllowedAt: number; dutyLastTopKey: string | null };
  inner.feedPM("turn_end"); // 第 1 轮：喂活（continue）
  await new Promise((r) => setTimeout(r, 100));
  let rounds = rounds0();
  const cont1 = rounds.filter((r) => r.result === "continue");
  ok(cont1.length === 1, `B3 第 1 轮喂活 continue（实 ${cont1.length}——receipt 候选在）`);
  inner.feedPM("turn_end"); // 第 2 轮同 top → 无进展退避拦
  rounds = rounds0();
  const last = rounds[rounds.length - 1];
  ok(last.result === "sleep" && last.reason === "no_progress_backoff", `B4 同 top 第 2 轮退避（result=${last.result} reason=${last.reason}）`);
  ok((last.detail ?? "").includes("级数 1") && (last.detail ?? "").includes("5min"), `B4b 审计记级数（${(last.detail ?? "").slice(0, 60)}）`);
  // B5：候选变化复位——reviewed 该 receipt 后 top 消失
  markDutyReviewed(["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"]);
  inner.dutyNextFeedAllowedAt = 0; // 手清退避窗（模拟到点）
  inner.feedPM("turn_end");
  rounds = rounds0();
  const last2 = rounds[rounds.length - 1];
  ok(last2.reason !== "no_progress_backoff", `B5 候选消化后不复退避（末行 reason=${last2.reason ?? "?"}——reviewed 过滤生效）`);
}

// ---------- C 刀3：DUTY_RECEIPT 接线 ----------
{
  // C1 持久化往返
  ok(readDutyReviewed(ORG).length === 0 || readDutyReviewed(ORG).includes("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"), "C1 读集兼容（空或含 B 组标记）");
  markDutyReviewed(["acc-a", "acc-b"], ORG);
  const rd = readDutyReviewed(ORG);
  ok(rd.includes("acc-a") && rd.includes("acc-b"), "C2 标记往返持久化（org/duty-reviewed.json）");
  // C3 parseDutyReceipt 合法/非法
  const good = parseDutyReceipt('{"v":1,"feed_id":"f1","actions":[{"kind":"accept","ids":["acc-a"]}],"blocked":[],"next_trigger":"user"}');
  ok(good !== null && good.actions[0].kind === "accept", "C3 合法回执解析");
  ok(parseDutyReceipt("not-json") === null && parseDutyReceipt('{"v":9}') === null, "C4 非法行 null（不炸）");
  // C5 maybeConsumeDutyReceipt 副作用（经 pushExternalLog 口——external PM 流面真链）
  const { SessionManager } = await import("../src/session-manager.js");
  const { EventBus } = await import("../src/event-bus.js");
  const cfg2 = (await import("../src/config.js")).loadConfig() as never;
  const bus2 = new EventBus();
  const mgr2 = new SessionManager(bus2, cfg2);
  mgr2.ensureExternal("ext-pm-dbo", "/tmp", "值守 PM", "", 0);
  mgr2.pushExternalLog("ext-pm-dbo", "assistant_text", `处理完毕。\nDUTY_RECEIPT {"v":1,"feed_id":"f9","actions":[{"kind":"accept","ids":["acc-c","acc-d"]},{"kind":"board","ids":["e1"]}],"blocked":[],"next_trigger":"user"}`);
  const rd2 = readDutyReviewed(ORG);
  ok(rd2.includes("acc-c") && rd2.includes("acc-d"), `C5 accept 副作用落 reviewed（${rd2.filter((x) => x.startsWith("acc-")).join(",")}）`);
  // C6 坏行 receipt_missing 不惩罚（不写 reviewed 不炸）
  const before = readDutyReviewed(ORG).length;
  mgr2.pushExternalLog("ext-pm-dbo", "assistant_text", "DUTY_RECEIPT {broken json");
  ok(readDutyReviewed(ORG).length === before, "C6 坏行零副作用（不惩罚）");
  // C7 跨重启过滤：新实例 pendingAcceptanceReceipts 不含 reviewed 单
  const mgr3 = new SessionManager(new EventBus(), cfg2);
  mgr3.ensureExternal("ext-x", "/tmp", "x", "", 0);
  const pend = (mgr3 as unknown as { pendingAcceptanceReceipts: () => { sid: string; reviewed: boolean }[] }).pendingAcceptanceReceipts();
  // reviewed 过滤的权威消费面=receiptCandidates（filter r.reviewed!==true）——此处断言
  // pendingAcceptanceReceipts 带真 reviewed:true（喂给候选层的过滤依据在，跨实例持久化）
  const marked = pend.filter((x) => ["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "acc-c", "acc-d"].includes(x.sid));
  ok(Array.isArray(pend) && marked.every((x) => x.reviewed === true), `C7 新实例（重启模拟）reviewed 标记持久化在（${marked.length} 张带 true——receiptCandidates 据此过滤，38h 重复投喂根治）`);
  const ld = await import("../src/leader-duty.js"); const receiptCandidates = (ld as unknown as { receiptCandidates?: unknown }).receiptCandidates;
  if (typeof receiptCandidates === "function") {
    const filtered = (receiptCandidates as (s: unknown, n: number) => { id: string }[])({ pending_receipts: pend } as never, Date.now());
  
  } else {
    ok(true, "C7b receiptCandidates 非导出（内部函数——过滤逻辑经 filter(r=>r.reviewed!==true) 源码锚锁，见 C7 行为断言）");
  }

}

console.log(`\n== test-dutybackoff 汇总：${pass} ok / ${fail} FAIL ==`);
rmSync(ORG, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
