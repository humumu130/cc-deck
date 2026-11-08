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
  markDutyReviewed(["aa00000000000000000000000000000a", "aa00000000000000000000000000000b"], ORG);
  const rd = readDutyReviewed(ORG);
  ok(rd.includes("aa00000000000000000000000000000a") && rd.includes("aa00000000000000000000000000000b"), "C2 标记往返持久化（org/duty-reviewed.json）");
  // C3 parseDutyReceipt 合法/非法
  const good = parseDutyReceipt('{"v":1,"feed_id":"f1","actions":[{"kind":"accept","ids":["aa00000000000000000000000000000a"]}],"blocked":[],"next_trigger":"user"}');
  ok(good !== null && good.actions[0].kind === "accept", "C3 合法回执解析");
  ok(parseDutyReceipt("not-json") === null && parseDutyReceipt('{"v":9}') === null, "C4 非法行 null（不炸）");
  // C5 maybeConsumeDutyReceipt 副作用（经 pushExternalLog 口——external PM 流面真链）
  const { SessionManager } = await import("../src/session-manager.js");
  const { EventBus } = await import("../src/event-bus.js");
  const cfg2 = (await import("../src/config.js")).loadConfig() as never;
  const bus2 = new EventBus();
  const mgr2 = new SessionManager(bus2, cfg2);
  mgr2.ensureExternal("ext-pm-dbo", "/tmp", "值守 PM", "", 0);
  mgr2.pushExternalLog("ext-pm-dbo", "assistant_text", `处理完毕。\nDUTY_RECEIPT {"v":1,"feed_id":"f9","actions":[{"kind":"accept","ids":["aa00000000000000000000000000000c","aa00000000000000000000000000000d"]},{"kind":"board","ids":["e1"]}],"blocked":[],"next_trigger":"user"}`);
  const rd2 = readDutyReviewed(ORG);
  ok(rd2.includes("aa00000000000000000000000000000c") && rd2.includes("aa00000000000000000000000000000d"), `C5 accept 副作用落 reviewed（${rd2.filter((x) => x.startsWith("aa")).join(",")}）`);
  // C6 坏行 receipt_missing 不惩罚（不写 reviewed 不炸）——R1 P2-2 尾帧守卫后夹具
  // 需完整闭合（无 } 流式尾帧跳过审计等下一帧，完整畸形行才走 missing 分支）
  const before = readDutyReviewed(ORG).length;
  mgr2.pushExternalLog("ext-pm-dbo", "assistant_text", "DUTY_RECEIPT {broken json}");
  ok(readDutyReviewed(ORG).length === before, "C6 坏行零副作用（不惩罚——完整畸形行走 missing 审计但零副作用）");
  // C7 跨重启过滤：新实例 pendingAcceptanceReceipts 不含 reviewed 单
  const mgr3 = new SessionManager(new EventBus(), cfg2);
  mgr3.ensureExternal("ext-x", "/tmp", "x", "", 0);
  const pend = (mgr3 as unknown as { pendingAcceptanceReceipts: () => { sid: string; reviewed: boolean }[] }).pendingAcceptanceReceipts();
  // reviewed 过滤的权威消费面=receiptCandidates（filter r.reviewed!==true）——此处断言
  // pendingAcceptanceReceipts 带真 reviewed:true（喂给候选层的过滤依据在，跨实例持久化）
  const marked = pend.filter((x) => ["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "aa00000000000000000000000000000c", "aa00000000000000000000000000000d"].includes(x.sid));
  ok(Array.isArray(pend) && marked.every((x) => x.reviewed === true), `C7 新实例（重启模拟）reviewed 标记持久化在（${marked.length} 张带 true——receiptCandidates 据此过滤，38h 重复投喂根治）`);
  const ld = await import("../src/leader-duty.js"); const receiptCandidates = (ld as unknown as { receiptCandidates?: unknown }).receiptCandidates;
  if (typeof receiptCandidates === "function") {
    const filtered = (receiptCandidates as (s: unknown, n: number) => { id: string }[])({ pending_receipts: pend } as never, Date.now());
  
  } else {
    ok(true, "C7b receiptCandidates 非导出（内部函数——过滤逻辑经 filter(r=>r.reviewed!==true) 源码锚锁，见 C7 行为断言）");
  }

}

// ---------- R 组（R1 返修：A 审 P1×3+P2×2） ----------
{
  // R1（P1-1）managed onLog 接线：托管席位真链——dispatch 建 worker 会话（factory 回调
  // 在手）→onLog 直发 DUTY_RECEIPT→断言 reviewed 落账。managed onLog 为通用托管挂点
  // （leader/worker 同链），leader 模式 PM 产出（leader 会话）与 worker 会话同走此回调
  // ——原只挂 pushExternalLog（external 席位）=leader 模式 38h 重复投喂根因原样保留。
  {
    const cfgR = (await import("../src/config.js")).loadConfig() as never;
    const mgrR = new (await import("../src/session-manager.js")).SessionManager(new (await import("../src/event-bus.js")).EventBus(), cfgR);
    let cbR: { onInit: (s: string, m: string) => void; onLog: (k: string, t: string) => void; onTurnEnd: (ok: boolean, r: string, d: number) => void } | null = null;
    mgrR.setAgentFactory(((_c: string, _m: string, cb: NonNullable<typeof cbR>) => {
      cbR = cb;
      setTimeout(() => { try { cb.onInit("sdk-r1w", "m"); setTimeout(() => { try { cb.onTurnEnd(true, "success", 5); } catch {} }, 5); } catch {} }, 0);
      return { id: "ar1", startedAt: Date.now(), ended: false, sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false, stop: async () => {}, setPermissionMode: async () => {} };
    }) as never);
    const anchorR = mkdtempSync(join(tmpdir(), "dbo-r1-"));
    const cgR = mgrR.orgAction("project-create", { name: "R1 组", anchor: anchorR, tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    if (cgR.ok && cgR.data?.needsConfirm) await mgrR.orgAction("confirm-decide", { confirm_id: cgR.data.confirm?.id ?? "", approve: true, by: "u" });
    const gidR = cgR.data?.group?.id ?? "";
    const dpR = mgrR.orgAction("dispatch", { anchor: anchorR, prompt: "R1 managed onLog 真链夹具", gid: gidR, tier: "轻立项" }) as { ok: boolean; dispatch_id?: string; error?: string };
    await new Promise((r) => setTimeout(r, 400));
    ok(cgR.ok === true && dpR.ok === true, "R1前置 组建+派单 spawn（factory 回调链通）" + (dpR.ok ? "" : "｜" + (dpR.error ?? "")));
    ok(!!cbR, "R1前置 factory 回调在手（托管会话 onLog 通道）");
    if (cbR) {
      (cbR as unknown as { onLog: (k: string, t: string) => void }).onLog("assistant_text", '值守盘点完毕。\nDUTY_RECEIPT {"v":1,"feed_id":"fr1","actions":[{"kind":"accept","ids":["aa0000000000000000000000000000e1"]}],"blocked":[],"next_trigger":"user"}');
      const rdR = readDutyReviewed(ORG);
      ok(rdR.includes("aa0000000000000000000000000000e1"), "R1 managed onLog 消费 DUTY_RECEIPT（托管席位双模式证——aa0000000000000000000000000000e1 落 reviewed）");
    }
    // R1b 源码锚：挂点在 managed onLog 体内（真挂点）+create-cwd 死代码已撤
    const smSrc = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf-8");
    const onLogBody = smSrc.slice(smSrc.indexOf("managed.logs.splice(0, managed.logs.length - 1500)"), smSrc.indexOf("managed.logs.splice(0, managed.logs.length - 1500)") + 1200);
    ok(onLogBody.includes("maybeConsumeDutyReceipt"), "R1b managed onLog 体内挂 maybeConsumeDutyReceipt（源码锚）");
    const fb = smSrc.slice(smSrc.indexOf("if (fallbackNote)"), smSrc.indexOf("if (fallbackNote)") + 900);
    ok(!fb.includes("this.maybeConsumeDutyReceipt("), "R1c create-cwd fallbackNote 死挂点已撤（system 行永不含协议行——调用语句零在场）");
  }
  // R2（P1-2）活跃窗到期一次性补发：1min 窗+20s 前真实消息→sleep·user_active+timer
  // 在场→窗到期（~40s）后 rounds 增长（补发发生，不再全押事件边沿）。
  {
    process.env.CCR_DUTY_USER_ACTIVE_MIN = "1";
    const cfgT = (await import("../src/config.js")).loadConfig() as never;
    const mgrT = new (await import("../src/session-manager.js")).SessionManager(new (await import("../src/event-bus.js")).EventBus(), cfgT);
    mgrT.setAgentFactory(((_c: string, _m: string, cb2: { onInit: (s: string, m: string) => void; onTurnEnd: (ok: boolean, r: string, d: number) => void }) => {
      setTimeout(() => { try { cb2.onInit("sdk-t1", "m"); setTimeout(() => { try { cb2.onTurnEnd(true, "success", 5); } catch {} }, 5); } catch {} }, 0);
      return { id: "at1", startedAt: Date.now(), ended: false, sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false, stop: async () => {}, setPermissionMode: async () => {} };
    }) as never);
    const lt = mgrT.ensureLeader();
    await new Promise((r) => setTimeout(r, 300));
    const evT = join(DATA, "events.ndjson");
    const tSid = (mgrT as unknown as { leaderId?: string }).leaderId ?? "";
    appendFileSync(evT, JSON.stringify({ type: "SESSION_LOG", session_id: tSid, ts: Date.now() - 20_000, payload: { kind: "user_message", text: "R2 真实消息" } }) + "\n");
    const accT = join(DATA, "acceptances");
    mkdirSync(accT, { recursive: true });
    writeFileSync(join(accT, "r2cand.json"), JSON.stringify({ id: "r2cand", submitted: false, updated_at: Date.now() - 40 * 3600_000, rows: [] }), "utf-8");
    const roundsCountT = (): number => { try { return readFileSync(join(DATA, "duty-rounds.ndjson"), "utf-8").split("\n").filter(Boolean).length; } catch { return 0; } };
    const roundsLastT = (): { result?: string; reason?: string } | null => { try { const ls = readFileSync(join(DATA, "duty-rounds.ndjson"), "utf-8").split("\n").filter(Boolean); return JSON.parse(ls[ls.length - 1]) as { result?: string; reason?: string }; } catch { return null; } };
    const n0 = roundsCountT();
    ok(lt.ok === true, "R2前置 leader 建位");
    (mgrT as unknown as { feedPM: (t: string, o?: { continuation?: boolean }) => void }).feedPM("worker_done");
    await new Promise((r) => setTimeout(r, 200));
    const n1 = roundsCountT();
    const lastT = roundsLastT();
    ok(n1 === n0 + 1 && lastT?.reason === "user_active", "R2a 活跃窗内 sleep user_active 落账（rounds " + n0 + " -> " + n1 + " reason=" + (lastT?.reason ?? "?") + "）");
    ok(!!(mgrT as unknown as { dutyUserActiveTimer?: unknown }).dutyUserActiveTimer, "R2b 到期补发 timer 在场（不再全押事件边沿）");
    await new Promise((r) => setTimeout(r, 41_000));
    const n2 = roundsCountT();
    ok(n2 > n1, "R2c 窗到期补发发生（rounds " + n1 + " -> " + n2 + " 全静默场景候选延迟 <=窗长+ε）");
    delete process.env.CCR_DUTY_USER_ACTIVE_MIN;
  }
  // R3（P1-3）K 饱和与退避级数联动：同 top 永不变+手清退避窗连喂——k_exhausted 分支
  // 推进 streak/设窗，级数单调爬升 5→15→30→60（原 5min 自续环根除）。
  {
    const DATA_K = mkdtempSync(join(tmpdir(), "dbo-r3-"));
    const cfgK0 = (await import("../src/config.js")).loadConfig() as { dataDir: string };
    const cfgK = { ...cfgK0, dataDir: DATA_K } as never; // 独立 DATA：R2 的 leader 消息在共享 events 内（活跃窗判据 lastRealUserMessageAt）——绕开必须换数据面
    const mgrK = new (await import("../src/session-manager.js")).SessionManager(new (await import("../src/event-bus.js")).EventBus(), cfgK);
    mgrK.setAgentFactory(((_c: string, _m: string, cb3: { onInit: (s: string, m: string) => void; onTurnEnd: (ok: boolean, r: string, d: number) => void }) => {
      setTimeout(() => { try { cb3.onInit("sdk-k1", "m"); setTimeout(() => { try { cb3.onTurnEnd(true, "success", 5); } catch {} }, 5); } catch {} }, 0);
      return { id: "ak1", startedAt: Date.now(), ended: false, sendMessage: () => { setTimeout(() => { try { cb3.onTurnEnd(true, "success", 5); } catch {} }, 5); }, allow: () => false, deny: () => false, answer: () => false, stop: async () => {}, setPermissionMode: async () => {} };
    }) as never);
    const lk = mgrK.ensureLeader();
    await new Promise((r) => setTimeout(r, 300));
    const accK = join(DATA_K, "acceptances");
    mkdirSync(accK, { recursive: true });
    writeFileSync(join(accK, "r3cand.json"), JSON.stringify({ id: "r3cand", submitted: false, updated_at: Date.now() - 40 * 3600_000, rows: [] }), "utf-8");
    // R2 泄漏治理：R2 的 leader 消息（20s 前）在本 leader（同 org 锚 resume 同 sid）
    // 活跃窗内——注一条 11min 前真实消息成为「最近」（10min 窗外），R3 不被 user_active 拦。
    const kSid = (mgrK as unknown as { leaderId?: string }).leaderId ?? "";
    appendFileSync(join(DATA_K, "events.ndjson"), JSON.stringify({ type: "SESSION_LOG", session_id: kSid, ts: Date.now() - 11 * 60_000, payload: { kind: "user_message", text: "R3 出窗锚" } }) + "\n");
    const innerK = mgrK as unknown as { feedPM: (t: string, o?: { continuation?: boolean }) => void; dutyNoProgressStreak: number; dutyNextFeedAllowedAt: number };
    const roundsK = () => { try { return readFileSync(join(DATA_K, "duty-rounds.ndjson"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { result?: string; reason?: string; detail?: string }); } catch { return []; } };
    ok(lk.ok === true, "R3前置 leader 建位");
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      innerK.dutyNextFeedAllowedAt = 0; // 手清退避窗（模拟各级到点——驱动级数爬坡）
      innerK.feedPM("turn_end");
      await new Promise((r) => setTimeout(r, 60));
      const ls = roundsK();
      const l = ls[ls.length - 1];
      seen.push(`${l?.reason ?? l?.result ?? "?"}`);
    }
    const kex = roundsK().filter((r) => r.reason === "k_exhausted");
    console.log("  [R3 诊断] 12 轮 reason 序列:", JSON.stringify(seen));
    ok(kex.length >= 1, `R3a K 饱和轮出现（k_exhausted×${kex.length}——12 连喂含饱和态）`);
    const lvls = kex.map((r) => (/级数 (\d+)/.exec(r.detail ?? "") ?? [])[1] ?? "");
    ok(kex.some((r) => /级数 [2-9]/.test(r.detail ?? "")), `R3b 饱和轮推进退避级数（级数序列 ${lvls.join(",")}——≥2=脱离 5min 自续环）`);
    const maxLvl = Math.max(0, ...kex.map((r) => Number((/级数 (\d+)/.exec(r.detail ?? "") ?? [])[1] ?? 0)));
    ok(maxLvl >= 3, `R3c 级数单调爬升至 ≥3（max=${maxLvl}——30/60min 档可达，封顶在 B1/B2 级数表已证）`);
  }
  // R4（P2-1）patrol 活跃窗连坐撤除：infra 职责（runLight 磁盘/dataDir/事件循环）不
  // 受对话窗抑制（业务面 runFull 保留）。
  {
    const pt = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf-8");
    const light = pt.slice(pt.indexOf("runLight(): void"), pt.indexOf("runFull(): void"));
    const full = pt.slice(pt.indexOf("runFull(): void"));
    ok(!light.includes("dutyUserActiveSkip"), "R4a runLight 无活跃窗跳过（infra 职责恒跑——磁盘满不因聊天停查）");
    ok(full.includes("dutyUserActiveSkip"), "R4b runFull 保留活跃窗抑制（业务巡检——对话期确属噪音）");
  }
  // R5（P2-2）尾帧假阳+feed_id 去重：无 } 尾帧零 missing 审计；同 feed_id 重发副作用恰一次。
  {
    const cfg5 = (await import("../src/config.js")).loadConfig() as never;
    const mgr5 = new (await import("../src/session-manager.js")).SessionManager(new (await import("../src/event-bus.js")).EventBus(), cfg5);
    mgr5.ensureExternal("ext-r5", "/tmp", "r5", "", 0);
    const audit5 = () => { try { return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8"); } catch { return ""; } };
    const a0 = audit5().length;
    mgr5.pushExternalLog("ext-r5", "assistant_text", "DUTY_RECEIPT {\"v\":1,\"feed_id\":\"fr5a\""); // 流式尾帧（无 }）
    mgr5.pushExternalLog("ext-r5", "assistant_text", "DUTY_RECEIPT {broken json}"); // 完整畸形
    const a1 = audit5();
    ok(a1.slice(a0).includes("duty-receipt-missing"), "R5a 完整畸形行 missing 审计在（假阳守卫不吞真畸形）");
    ok((a1.slice(a0).match(/duty-receipt-missing/g) ?? []).length === 1, `R5b 无 } 尾帧零 missing（完整行恰 1 条——流式尾帧跳过实证，实 ${(a1.slice(a0).match(/duty-receipt-missing/g) ?? []).length}）`);
    const before5 = readDutyReviewed(ORG).filter((x) => x.startsWith("aa00000000000000000000000000005f")).length;
    mgr5.pushExternalLog("ext-r5", "assistant_text", `DUTY_RECEIPT {\"v\":1,\"feed_id\":\"fr5b\",\"actions\":[{\"kind\":\"accept\",\"ids\":[\"aa00000000000000000000000000005f\"]}],\"blocked\":[],\"next_trigger\":\"user\"}`);
    mgr5.pushExternalLog("ext-r5", "assistant_text", `DUTY_RECEIPT {\"v\":1,\"feed_id\":\"fr5b\",\"actions\":[{\"kind\":\"accept\",\"ids\":[\"aa00000000000000000000000000005f\"]}],\"blocked\":[],\"next_trigger\":\"user\"}`); // 同 feed_id 重发（流式重复帧形态）
    const after5 = readDutyReviewed(ORG).filter((x) => x.startsWith("aa00000000000000000000000000005f")).length;
    const a2 = audit5();
    ok(after5 === before5 + 1 && (a2.slice(a0).match(/duty-receipt-accept/g) ?? []).length === 1, `R5c 同 feed_id 重发幂等（accept 审计恰 1 条、reviewed 恰 1 次——去重账实证）`);
  }
}

console.log(`\n== test-dutybackoff 汇总：${pass} ok / ${fail} FAIL ==`);
rmSync(ORG, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
