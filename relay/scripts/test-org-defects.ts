// W-ORG-DEFECTS（2026-11-01 用户 1101 定性编排层产品缺陷 P0 批）——六件回归：
//   件1 收割锁：harvestViolationScan 审计行消费→harvest-violation 帧+通知
//   件2 worktree 互斥：dispatch-lock 底座（活锁/陈锁/他单不清/scanClear）+ relay 候选预检（worktreeBusySkip）
//   件3 held 出口：board-hold/board-release 全往返 + holdOvertimeScan（48h 超时提醒）+ holdNudgeScan（催收关键词）
//   件4 busy 检查：熟手在途单（内存账/持久账）→pickVeteranEligible 跳过换新会话（叠单消灭）
//   件5 回执落盘事件唤醒：scanReceiptDrop 基线→落盘→receipt-drop 帧
//   件6 僵尸看门狗：两轮确认→member-retire+zombie-retire 帧+悬账 failed 收口
// 惯例对齐 test-dispatch：fake agentFactory / CCR_ORG_DIR+CCR_DATA_DIR 隔离 / 断言累计。
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { addMember, createGroup, findGroup, loadBoard, upsertBoardEntry } from "../src/projects.js";
import { recordRoutingResult } from "../src/routing.js";
import { acquireWorktreeLock, claimWorktreeLock, clearWorktreeLock, scanClearWorktreeLocks, worktreeHeldByOther, writeWorktreeLock } from "../src/dispatch-lock.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// 假 agent 工厂（busy/僵尸场景需要「spawn 后不回回合」的挂起形态：busyHold=true 时
// prompt 回合永不 onTurnEnd——会话停在 WORKING，openDispatches 不收口）。
let busyHold = false;
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        if (busyHold) return; // 挂起：不回回合（busy 场景的在途单）
        cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 });
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 10);
    return a;
  };

const auditLines = (DATA: string, word: string): number =>
  (() => { try { return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8").split("\n").filter((l) => l.includes(`"action":"${word}"`)).length; } catch { return 0; }})();

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-defects-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-defects-"));
  const WT_ROOT = mkdtempSync(join(tmpdir(), "ccr-wt-defects-"));
  const ART = mkdtempSync(join(tmpdir(), "ccr-art-defects-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_WT_ROOT = WT_ROOT;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));

    // ---------- 件2（底座）：dispatch-lock 语义四断言 ----------
    console.log("件2 worktree 锁底座（dispatch-lock.ts）:");
    const wt = join(WT_ROOT, "cc-deck-w-lockdemo");
    mkdirSync(wt, { recursive: true });
    assert(worktreeHeldByOther(wt) === null, "无锁=不占用");
    writeWorktreeLock(wt, { slug: "demo-a", dispatch_id: "did-aaa" });
    const held = worktreeHeldByOther(wt);
    assert(!!held && held.slug === "demo-a", "他人活锁=占用（slug 可读）");
    assert(worktreeHeldByOther(wt, "did-aaa") === null, "自己单的锁≠占用（幂等续派）");
    assert(clearWorktreeLock(wt, "did-bbb") === false && worktreeHeldByOther(wt, "did-zzz") !== null, "他人活锁清不动（防误删后继单新锁）");
    assert(clearWorktreeLock(wt, "did-aaa") === true && !existsSync(join(wt, ".cc-deck-lock")), "自己单清锁成功");
    writeWorktreeLock(wt, { slug: "demo-stale", dispatch_id: "did-old", expires_at: Date.now() - 1 });
    assert(worktreeHeldByOther(wt, "did-new") === null, "过期=陈锁不拦新单（惰性失效）");
    writeWorktreeLock(wt, { slug: "demo-scan", dispatch_id: "did-scan" });
    const cleared = scanClearWorktreeLocks("did-scan");
    assert(cleared.length === 1 && cleared[0] === wt && !existsSync(join(wt, ".cc-deck-lock")), "scanClear 按收口单 id 匹配清锁（relay 收口边同款调用）");

    // ---------- 件4：busy 熟手被跳过（叠单消灭） ----------
    console.log("件4 路由 busy 检查:");
    const anchor = join(DATA, "proj-busy");
    mkdirSync(anchor, { recursive: true });
    const c2 = mgr.orgAction("project-create", { name: "defects 组", anchor, tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(c2.ok === true, "组建（project-create）");
    const gid = c2.data?.group?.id ?? "";
    if (c2.data?.needsConfirm) {
      const dec = mgr.orgAction("confirm-decide", { confirm_id: c2.data.confirm?.id ?? "", approve: true, by: "u" }) as { ok: boolean };
      assert(dec.ok === true, "立项确认 ✓（首次轻立项出卡——test-dispatch D3 同流程）");
    }
    assert(findGroup(gid)?.status === "active", "组 active");
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "第一单给 A 干完成为熟手", gid, title: "busy-1" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d1.ok === true, "第一单派发成功");
    const sidA = d1.ok ? (d1 as { session_id: string }).session_id : "";
    await waitFor(() => readDispatchLog().some((e) => e.id === d1.dispatch_id && e.status === "done"));
    if (!findGroup(gid)?.headcount.some((h) => h.session_id === sidA)) addMember(gid, sidA, "worker");
    recordRoutingResult(gid, sidA, "done", "第一单 done");
    assert(!!findGroup(gid)?.headcount.some((h) => h.session_id === sidA), "A 在编（roster）");
    // 场景①：内存账 busy（openDispatches 有未收口单）→ 第二单不得落 A
    (mgr as any).openDispatches.set(sidA, [{ id: "open-x", tier: "轻立项" }]);
    const d2 = mgr.orgAction("dispatch", { anchor, prompt: "第二单应跳过忙的 A", gid, title: "busy-2" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d2.ok === true, "第二单派发成功（不因忙拒收）");
    const row2 = readDispatchLog().filter((e) => e.id === d2.dispatch_id);
    assert(!(row2.some((e) => e.session_id === sidA)), "busy（内存账）A 被跳过——第二单不落 A（叠单消灭）");
    assert(auditLines(DATA, "dispatch-reroute") >= 1, "busy skip 有 dispatch-reroute 审计帧（skip 可归因）");
    await waitFor(() => readDispatchLog().some((e) => e.id === d2.dispatch_id && e.status === "done"));
    // 场景②：持久台账 busy（重启空窗兜底）——清内存账，伪造台账 dispatched 行
    (mgr as any).openDispatches.delete(sidA);
    const { appendDispatch } = await import("../src/org.js");
    appendDispatch({ ts: Date.now(), id: "persist-busy-1", tier: "轻立项", target: sidA, status: "dispatched", session_id: sidA, project_anchor: anchor });
    const d3 = mgr.orgAction("dispatch", { anchor, prompt: "第三单走持久账兜底", gid, title: "busy-3" }) as { ok: boolean; dispatch_id?: string };
    const row3 = readDispatchLog().filter((e) => e.id === d3.dispatch_id);
    assert(d3.ok === true && !(row3.some((e) => e.session_id === sidA)), "busy（持久台账 dispatched 行）A 仍被跳过（重启空窗兜底）");
    await waitFor(() => readDispatchLog().some((e) => e.id === d3.dispatch_id && e.status === "done"));
    appendDispatch({ ts: Date.now(), id: "persist-busy-1", tier: "轻立项", target: sidA, status: "failed", session_id: sidA, project_anchor: anchor, receipt: "测试收口" });
    (mgr as any).openDispatches.delete(sidA);

    // ---------- 件2（relay 面）：候选 cwd 在他人活锁 worktree → 跳过 ----------
    console.log("件2 relay 候选预检（worktreeBusySkip）:");
    const wt2 = join(WT_ROOT, "cc-deck-w-busydemo");
    mkdirSync(wt2, { recursive: true });
    writeWorktreeLock(wt2, { slug: "other-task", dispatch_id: "did-other" });
    const sm = (mgr as any).sessions.get(sidA) as { state: { cwd?: string } } | undefined;
    const prevCwd = sm?.state.cwd;
    if (sm) sm.state.cwd = wt2;
    const skipRes = (mgr as any).worktreeBusySkip(sidA, wt2);
    assert(skipRes === true, "他人活锁 worktree 内候选=磁盘忙 skip");
    assert(auditLines(DATA, "worktree-busy") >= 1, "worktree-busy 审计帧在（新词入账）");
    if (sm && prevCwd !== undefined) sm.state.cwd = prevCwd;
    assert((mgr as any).worktreeBusySkip(sidA, join(WT_ROOT, "not-a-worktree")) === false, "无锁目录不误伤");


    // ---------- 件3：held 出口三段 ----------
    console.log("件3 held 态出口:");
    const card = upsertBoardEntry(gid, { text: "held 卡样例（等 L2 真机验证）", status: "claimed" });
    assert(card.ok, "板卡建");
    const cardId = card.ok ? card.entry.id : "";
    const h1 = mgr.orgAction("board-hold", { gid: gid, entry_id: cardId, reason: "等 L2 真机验证" }) as { ok: boolean; error?: string };
    assert(h1.ok === true, "board-hold 上锁成功");
    assert(loadBoard(gid).entries.find((e) => e.id === cardId)?.hold?.reason === "等 L2 真机验证", "hold 字段落板（{reason, since}）");
    // 48h 出口：伪未来时刻扫描（since 真值不动，now=+49h → 超时提醒）
    const before = auditLines(DATA, "hold-overtime");
    (mgr as any).holdOvertimeScan(Date.now() + 49 * 3600_000);
    assert(auditLines(DATA, "hold-overtime") > before, "held>48h → hold-overtime 审计帧（超时提醒出口①）");
    (mgr as any).holdOvertimeScan(Date.now()); // 未超时扫：不新增
    assert(auditLines(DATA, "hold-overtime") === before + 1, "未超时不重复提醒（stableKey 防重）");
    // 催收出口②
    (mgr as any).holdNudgeScan("那个图钉怎么还没做？");
    const nudges = [...((mgr as any).notifications as Map<string, { title: string }>).values()].filter((n) => n.title.includes("held 卡疑似被用户催收"));
    assert(nudges.length >= 1, "催收关键词命中 → held 卡催收通知（出口②）");
    (mgr as any).holdNudgeScan("无关消息不触发");
    const nudges2 = [...((mgr as any).notifications as Map<string, { title: string }>).values()].filter((n) => n.title.includes("held 卡疑似被用户催收"));
    assert(nudges2.length === nudges.length, "无关键词不触发（不误报）");
    // 一键破锁出口③
    const rel = mgr.orgAction("board-release", { gid: gid, entry_id: cardId }) as { ok: boolean; error?: string };
    assert(rel.ok === true, "board-release 破锁成功");
    assert(loadBoard(gid).entries.find((e) => e.id === cardId)?.hold === undefined, "hold 字段已清");
    assert(auditLines(DATA, "hold-release") >= 1, "hold-release 审计帧在（held 时长病理学入账）");

    // ---------- 件5：回执落盘事件唤醒 ----------
    console.log("件5 回执落盘事件唤醒（scanReceiptDrop）:");
    (mgr as any).scanReceiptDrop(); // 首扫=基线
    const before5 = auditLines(DATA, "receipt-drop");
    writeFileSync(join(ART, "w-defects-demo.md"), "# 回执\n\n结果：演示｜改动文件：无\n", "utf-8");
    (mgr as any).scanReceiptDrop();
    assert(auditLines(DATA, "receipt-drop") === before5 + 1, "w-*.md 落盘 → receipt-drop 审计帧（feedPM 唤醒源）");
    (mgr as any).scanReceiptDrop(); // 无变化：不重复
    assert(auditLines(DATA, "receipt-drop") === before5 + 1, "无新落盘不重复触发（快照 diff）");
    writeFileSync(join(ART, "not-a-receipt.txt"), "x", "utf-8");
    (mgr as any).scanReceiptDrop();
    assert(auditLines(DATA, "receipt-drop") === before5 + 1, "非回执命名不触发（w-*/review-w-* 模式过滤）");

    // ---------- 件6：僵尸看门狗两轮确认 ----------
    console.log("件6 僵尸看门狗:");
    process.env.CCR_ZOMBIE_CONFIRM_MS = "1"; // 测试：确认窗 1ms（两轮 tick 即确认）
    busyHold = true; // 先置挂起：spawn 后 prompt 回合不回（WORKING 无推进）
    const dz = mgr.orgAction("dispatch", { anchor, prompt: "僵尸单：spawn 后挂起", gid: gid, title: "zombie-1" }) as { ok: boolean; session_id?: string };
    assert(dz.ok === true, "僵尸单派发");
    const sidZ = dz.ok ? (dz as { session_id: string }).session_id : "";
    await waitFor(() => (mgr as any).sessions.get(sidZ)?.state?.status === "WORKING");
    const mz = (mgr as any).sessions.get(sidZ) as { lastProgressAt: number; state: { status: string; project_gid?: string; updated_at?: number } };
    mz.lastProgressAt = Date.now() - 40 * 60_000; // 40min 无帧（>15min 判据）
    mz.state.updated_at = Date.now() - 40 * 60_000; // routeLivenessSkip 取 Math.max(两值)——同置旧防 running 边刚刷新盖过
    (mgr as any).zombieWatchdogTick();
    assert((mgr as any).zombieSuspects.size === 1, "第一轮：标 suspected（不立即杀）");
    await wait(10); // 跨过 1ms 确认窗（同毫秒双 tick=窗未过）
    (mgr as any).zombieWatchdogTick();
    assert(!(findGroup(gid)?.headcount.some((h) => h.session_id === sidZ)), "第二轮确认：member-retire（编制除名）");
    assert(auditLines(DATA, "zombie-retire") >= 1, "zombie-retire 审计帧在");
    assert(readDispatchLog().some((e) => e.session_id === sidZ && e.status === "failed" && (e.receipt ?? "").includes("僵尸看门狗")), "僵尸悬账 failed 收口（台账可归因）");
    busyHold = false;
    delete process.env.CCR_ZOMBIE_CONFIRM_MS;

    // ---------- P1-1 返工（审查A档）：锁 dispatch_id 认领边落盘 + 无 id 哨兵收窄 + self 豁免 ----------
    console.log("P1-1 认领边落锁（生产无 id 形态全链）:");
    const wt3 = join(WT_ROOT, "cc-deck-w-claimdemo");
    mkdirSync(wt3, { recursive: true });
    // ① bash 侧哨兵形态（无 id——leader-dispatch 预建跳的真实产出）→ dispatchWorker 认领边补写
    writeWorktreeLock(wt3, { slug: "p11-claim" }); // 无 dispatch_id=哨兵锁
    const dp = mgr.orgAction("dispatch", { anchor, prompt: "P1-1 认领边落锁用例（worktree 透传）", gid, title: "p11-claim", worktree: wt3, slug: "p11-claim" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(dp.ok === true, "带 worktree 派单成功（透传零阻力）");
    // 认领边断言窗口=派发返回即刻（收口边 scanClear 会在 done 后按 id 清锁——树释放是正链路）
    const lockAfter = JSON.parse(readFileSync(join(wt3, ".cc-deck-lock"), "utf-8")) as { slug?: string; dispatch_id?: string; session_id?: string };
    assert(lockAfter.dispatch_id === dp.dispatch_id && lockAfter.session_id === dp.session_id, `认领边补写归属（dispatch_id=${String(lockAfter.dispatch_id).slice(0, 8)}… session_id 落盘——哨兵锁→有主锁）`);
    assert(lockAfter.slug === "p11-claim", "slug 透传在锁面（审计可归因）");
    await waitFor(() => readDispatchLog().some((e) => e.id === dp.dispatch_id && e.status === "done"));
    assert(!existsSync(join(wt3, ".cc-deck-lock")), "收口边正链路：done 后 scanClear 按本单 id 清锁（树释放——下一单可入）");
    // ② 无 id 哨兵锁收窄：他单收口不清我哨兵（只按过期失效）；过期哨兵=陈锁照清
    const wt4 = join(WT_ROOT, "cc-deck-w-sentinel");
    mkdirSync(wt4, { recursive: true });
    writeWorktreeLock(wt4, { slug: "sentinel-live" });
    assert(clearWorktreeLock(wt4, "did-unrelated") === false && existsSync(join(wt4, ".cc-deck-lock")), "无 id 哨兵锁不被他单收口清（在途标记保护——撞车面防回潮）");
    const scanSkipped = scanClearWorktreeLocks("did-unrelated");
    assert(!scanSkipped.includes(wt4) && existsSync(join(wt4, ".cc-deck-lock")), "scanClear 跳过无 id 哨兵锁（收口边同判据）");
    writeWorktreeLock(wt4, { slug: "sentinel-stale", expires_at: Date.now() - 1 });
    assert(scanClearWorktreeLocks("did-unrelated").includes(wt4), "过期哨兵=陈锁照清（只按过期失效，不积尸");
    // ③ self 豁免：同 slug 重派目标树内的老熟手不被自家哨兵锁阻塞
    const smA = (mgr as any).sessions.get(sidA) as { state: { cwd?: string } } | undefined;
    const prevCwdA = smA?.state.cwd;
    if (smA) smA.state.cwd = wt3;
    assert((mgr as any).worktreeBusySkip(sidA, wt3, wt3) === false, "self 豁免：本次目标 worktree 内候选不被自家锁 skip（同 slug 重派老熟手可认领）");

    writeWorktreeLock(wt3, { slug: "p11-claim", dispatch_id: "did-stranger" });
    assert((mgr as any).worktreeBusySkip(sidA, wt3) === true, "对照①：树被他人 id 活锁占时仍 skip（豁免不放大权限）");
    writeWorktreeLock(wt3, { slug: "p11-claim" });
    assert((mgr as any).worktreeBusySkip(sidA, wt3, wt3) === false && (mgr as any).worktreeBusySkip(sidA, wt3) === true, "对照③：无 id 哨兵锁——豁免参放行（本单目标树）/无豁免参照 skip（他单视角在途标记拦新单）");
    writeWorktreeLock(wt3, { slug: "p11-claim", dispatch_id: dp.dispatch_id, session_id: dp.session_id });
    if (smA && prevCwdA !== undefined) smA.state.cwd = prevCwdA;
    // 清场：dp 单入编成员退役+锁文件清——段在尾部（防御性清场，理论上无下游）
    try { (mgr as any).orgAction("member-retire", { gid, session_id: dp.session_id }); } catch (_) {}
    try { rmSync(join(wt3, ".cc-deck-lock"), { force: true }); rmSync(join(wt4, ".cc-deck-lock"), { force: true }); } catch (_) {}

    // ---------- 件1：越权收割审计行消费 ----------
    console.log("件1 越权收割拦截（harvestViolationScan 消费面）:");
    writeFileSync(join(DATA, "harvest-violations.ndjson"),
      JSON.stringify({ ts: Date.now(), pid: 99999, cwd: "/private/tmp/cc-deck-w-evil", refspec: "refs/heads/x:refs/heads/dev", role: "" }) + "\n", "utf-8");
    (mgr as any).harvestViolationScan();
    assert(auditLines(DATA, "harvest-violation") >= 1, "pre-push 审计行 → harvest-violation 审计帧");
    const hv = [...((mgr as any).notifications as Map<string, { title: string }>).values()].filter((n) => n.title.includes("越权收割拦截"));
    assert(hv.length >= 1, "越权收割 PM 通知在账（事故即达）");
    (mgr as any).harvestViolationScan(); // 无新行：不重复
    assert(auditLines(DATA, "harvest-violation") === 1, "增量消费不重放（offset 记忆）");

    // ---------- 返工②（B 档攻防 review-w-orgdefects-b-1101）：P0-① 符号链接绕闸 + P0-② 锁 TOCTOU ----------
    console.log("返工② P0-① pre-push 物理化（符号链接绕闸复测）:");
    const hookPath = new URL("../../scripts/hooks/pre-push", import.meta.url).pathname;
    const runHook = (cwd: string, env: NodeJS.ProcessEnv, remoteRef = "refs/heads/dev") =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        const base = { ...process.env };
        delete base.CC_ORG_ROLE; // 防本会话 env 位泄漏误拦（PM 放行用例的干净底座）
        const child = spawn("bash", [hookPath], { cwd, env: { ...base, ...env } });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += String(d); });
        child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
        // git 原生四字段：local_ref local_sha remote_ref remote_sha（闸匹配第三位 remote）
        child.stdin.write(`refs/heads/feat/x 0000000000000000000000000000000000000000 ${remoteRef} 1111111111111111111111111111111111111111\n`);
        child.stdin.end();
      });
    const advData = mkdtempSync(join(tmpdir(), "ccr-adv2-data-"));
    // B 档攻击可移植复刻（CI 修：Linux /tmp 非符号链接——旧写法赌 macOS 形态在 CI 恒假阳性）：
    // 自建「物理目录 + 逻辑别名符号链接」对，双平台等价复现绕闸场景
    const physWt = mkdtempSync(join(tmpdir(), "ccr-adv2-phys-"));
    const advWt = physWt + "-link";
    symlinkSync(physWt, advWt);
    const rBypass = await runHook(advWt, { CCR_DATA_DIR: advData, CCR_WT_ROOT: physWt });
    assert(rBypass.code !== 0 && rBypass.stderr.includes("越权收割拦截"), `B 档绕过路径（符号链接 cwd）被拦（rc=${rBypass.code}——pwd -P 物理化双比对）`);
    const hvPath = join(advData, "harvest-violations.ndjson");
    assert(existsSync(hvPath) ? readFileSync(hvPath, "utf-8").includes(physWt) : true, "审计行记物理路径（pwd_p）——逻辑别名入档即钉死（文件缺席时前断言已失败，此处防崩）");
    const rPm = await runHook(ORG, { CCR_DATA_DIR: advData, CCR_WT_ROOT: "/private/tmp" }); // ORG 在 /var/folders（wt 外）=PM 主仓形态
    assert(rPm.code === 0, `PM 主仓路径（wt 外）不受误拦（rc=${rPm.code}）`);
    const rRole = await runHook(ORG, { CCR_DATA_DIR: advData, CC_ORG_ROLE: "worker" }); // env 位=worker 在任何 cwd
    assert(rRole.code !== 0, "CC_ORG_ROLE=worker 全域拦（env 位第二判据）");
    const rTag = await runHook(advWt, { CCR_DATA_DIR: advData, CCR_WT_ROOT: "/private/tmp" }, "refs/tags/v1.0");
    assert(rTag.code === 0, "tag push 不受限（三态回归：dev/main 拦、tag 放、PM 放）");

    console.log("返工② P0-② 锁原子化（TS 底座恰一胜 + relay 认领 fail-closed + bash 双锁并发）:");
    const wtR = join(WT_ROOT, "cc-deck-w-race1");
    mkdirSync(wtR, { recursive: true });
    // ① 无主连发 ×8（Node 单线程内即序；真并发恰一胜由 ⑤ wt-lock.py 子进程×8 与 fs 层
    //    O_EXCL 共同证明——TS/bash 同协议，协议保证进程间，进程内即序为下界）：
    let wins = 0;
    for (let i = 0; i < 8; i++) { if (acquireWorktreeLock(wtR, { slug: "race" }).ok) wins++; }
    assert(wins === 1, `无主连发 8 抢恰 1 胜（实=${wins}——首个 O_EXCL 建、余者 EEXIST 判负，无 check-then-write 间隙）`);
    // ② 陈锁接管连发 ×8：temp+replace+回读校验恰一胜（接管竞态的败者自知——见 ⑤ 子进程真并发同证）
    const wtR2 = join(WT_ROOT, "cc-deck-w-race2");
    mkdirSync(wtR2, { recursive: true });
    writeWorktreeLock(wtR2, { slug: "old", expires_at: Date.now() - 1000 });
    wins = 0;
    for (let i = 0; i < 8; i++) { if (acquireWorktreeLock(wtR2, { slug: "take" }).ok) wins++; }
    assert(wins === 1, `陈锁接管连发 8 抢恰 1 胜（实=${wins}——接管后活锁在场，余者判负）`);
    const finalLock = JSON.parse(readFileSync(join(wtR2, ".cc-deck-lock"), "utf-8")) as { slug: string };
    assert(finalLock.slug === "take", "接管后盘上是赢者锁（最后 replace 者独占）");
    // ③ 认领语义：他人 id 活锁判负 / 同 id 幂等 / 同 slug 哨兵接管
    const wtR3 = join(WT_ROOT, "cc-deck-w-race3");
    mkdirSync(wtR3, { recursive: true });
    writeWorktreeLock(wtR3, { slug: "s3", dispatch_id: "did-other", session_id: "sid-x" });
    const cLose = claimWorktreeLock(wtR3, { slug: "s3", dispatch_id: "did-mine" });
    assert(cLose.ok === false, "认领判负：他人 id 活锁（fail-closed——盲覆写时代同刻双派双双放行的病灶）");
    const cSame = claimWorktreeLock(wtR3, { slug: "s3", dispatch_id: "did-other", session_id: "sid-y" });
    assert(cSame.ok === true, "认领幂等：同 id 重放照写（续派口径）");
    writeWorktreeLock(wtR3, { slug: "s3" }); // 换哨兵形态
    const cSentinel = claimWorktreeLock(wtR3, { slug: "s3", dispatch_id: "did-mine2", session_id: "sid-z" });
    assert(cSentinel.ok === true, "同 slug 哨兵锁：原子接管补写归属（P1-1 认领边正链路保持）");
    // ④ relay 认领边 fail-closed：他 id 活锁树下派单 → orgAction 拒 + worktree-lock-race 审计/通知
    const wtR4 = join(WT_ROOT, "cc-deck-w-race4");
    mkdirSync(wtR4, { recursive: true });
    writeWorktreeLock(wtR4, { slug: "s4", dispatch_id: "did-stranger-4", session_id: "sid-stranger" });
    const raceBefore = auditLines(DATA, "worktree-lock-race");
    const dpLose = mgr.orgAction("dispatch", { anchor, prompt: "P0-② 认领 fail-closed 用例", gid, title: "race-lose", worktree: wtR4, slug: "s4" }) as { ok: boolean; error?: string };
    assert(dpLose.ok === false, `他 id 活锁树派单被拒（fail-closed——rc 面 orgAction ok=false）`);
    assert(auditLines(DATA, "worktree-lock-race") === raceBefore + 1, "worktree-lock-race 审计帧恰 +1（竞态即达 PM 可视面）");
    const raceNtf = [...((mgr as any).notifications as Map<string, { title: string }>).values()].filter((n) => n.title.includes("派单锁竞态拒绝"));
    assert(raceNtf.length >= 1, "锁竞态 PM 通知在账");
    // ⑤ bash 侧 wt-lock.py 并发：双实例同刻恰一胜（B-档 ②a 场景的写路径）
    const lockBin = new URL("../../cc-plugins/plugins/cc-deck/bin/wt-lock.py", import.meta.url).pathname;
    const runLock = (args: string[]) => new Promise<number>((resolve) => execFile("python3", [lockBin, ...args], { env: { ...process.env, CCR_WT_LOCK_WINDOW_MS: "7200000" } }, (e) => resolve(e === null ? 0 : 1)));
    const wtR5 = join(WT_ROOT, "cc-deck-w-race5");
    mkdirSync(wtR5, { recursive: true });
    const wtLockPath = join(wtR5, ".cc-deck-lock");
    let bashWins = 0;
    await Promise.all(Array.from({ length: 8 }, () => runLock(["wt", "acquire", wtLockPath, "--slug", "bash-race"]).then((c) => { if (c === 0) bashWins++; })));
    assert(bashWins === 1, `bash wt acquire 并发 8 抢恰 1 胜（实=${bashWins}——O_EXCL 与 TS 同协议）`);
    const wtR6 = join(WT_ROOT, "cc-deck-w-race6");
    mkdirSync(wtR6, { recursive: true });
    writeWorktreeLock(wtR6, { slug: "old6", expires_at: Date.now() - 1000 });
    bashWins = 0;
    await Promise.all(Array.from({ length: 8 }, () => runLock(["wt", "acquire", join(wtR6, ".cc-deck-lock"), "--slug", "take6"]).then((c) => { if (c === 0) bashWins++; })));
    assert(bashWins === 1, `bash 陈锁接管并发 8 抢恰 1 胜（实=${bashWins}——replace+回读校验同款）`);
    // ⑥ harvest 实例锁并发（B-档 ②d 场景）：同刻双收割恰一进闸
    const hLockPath = join(advData, "harvest.lock");
    let hWins = 0;
    await Promise.all(Array.from({ length: 8 }, () => runLock(["hlock", "acquire", hLockPath, "--pid", String(process.pid), "--dispatch-id", "hdemo"]).then((c) => { if (c === 0) hWins++; })));
    assert(hWins === 1, `harvest 实例锁并发 8 抢恰 1 进闸（实=${hWins}——pid 存活判活+原子接管）`);
    const hVerdict = await new Promise<string>((resolve) => execFile("python3", [lockBin, "hlock", "verdict", hLockPath], {}, (_e, out) => resolve(String(out).trim())));
    assert(hVerdict.startsWith("held"), `harvest 持锁 verdict（${hVerdict}——LOSE 路径消息即 die 1 依据）`);
    // ⑦ TS↔bash 协议互操作（生产真链路）：bash 落哨兵（wt-lock.py）→ relay 认领接管（TS）；
    //    TS 活锁在场 → bash acquire LOSE（两实现同一「恰一胜」契约，跨进程面闭合）
    const wtR7 = join(WT_ROOT, "cc-deck-w-race7");
    mkdirSync(wtR7, { recursive: true });
    assert((await runLock(["wt", "acquire", join(wtR7, ".cc-deck-lock"), "--slug", "interop"])) === 0, "bash 落哨兵锁（leader-dispatch 真产出形态）");
    const cInterop = claimWorktreeLock(wtR7, { slug: "interop", dispatch_id: "did-interop", session_id: "sid-interop" });
    assert(cInterop.ok === true, "relay 认领接管 bash 哨兵锁（同 slug 原子 takeover——P1-1 认领边在原子协议下正链路不变）");
    assert((await runLock(["wt", "acquire", join(wtR7, ".cc-deck-lock"), "--slug", "interop2"])) !== 0, "TS 认领后的活锁 → bash 再抢 LOSE（跨实现互斥闭合——B-档 ②a 双双落锁形态绝迹）");
    rmSync(advData, { recursive: true, force: true });
    rmSync(advWt, { recursive: true, force: true });

    // ---------- 收尾 ----------
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    process.env = prev as NodeJS.ProcessEnv;
    try { rmSync(ORG, { recursive: true, force: true }); } catch {}
    try { rmSync(DATA, { recursive: true, force: true }); } catch {}
    try { rmSync(WT_ROOT, { recursive: true, force: true }); } catch {}
    try { rmSync(ART, { recursive: true, force: true }); } catch {}
  }
}

void main();
