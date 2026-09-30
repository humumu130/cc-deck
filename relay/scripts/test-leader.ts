// #26 矩阵式 M1 —— Leader 常驻化集成测试（agentFactory 测试缝，不拉真 CLI）。
// 覆盖：L1 首建（锚/pinned/题名/待命化）+ L2 sticky-cwd 豁免 + L3 重启重建零 spawn
//       + L4 幂等 + L5 废锚重建 + L6 派单台账（running/done/failed/FIFO/兜底全清/断档补记）
//       + L10 首建 init 看门狗（#22①）+ L11 废锚僵尸清锚重首建（#22②）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { ORG_LEADER_BOOTSTRAP_PROMPT, ORG_LEADER_TITLE, readDispatchLog, readOrgAnchor, writeOrgAnchor } from "../src/org.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { ReplayedSession } from "../src/history.js";
import type { SessionState } from "../src/types.js";

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

// 假 agent 工厂（仿 test-bridge #46）：init = 20ms 后回 onInit；parked（prompt=undefined）
// 不触发 onTurnEnd——首建 Leader 的形态。created 记录每次 spawn 供计数断言。
// "hang" = #22① 靶子：CLI 挂死形态——零回调（不 init、不报错、不退出），stop 仍同步收尾。
let initMode: "init" | "noinit" | "die" | "hang" = "init";
type SpawnRec = { prompt: string | undefined; resume?: string; cb: AgentCallbacks; configHome?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { resume?: string; configHome?: string }): AgentLike => {
    void cwd;
    created.push({ prompt, resume: opts?.resume, cb, configHome: opts?.configHome });
    const mode = initMode;
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
    if (mode === "init") {
      setTimeout(() => {
        if (a.ended) return;
        cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
        if (prompt !== undefined) setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 12); }, 10);
      }, 20);
    } else if (mode === "die") {
      setTimeout(() => { if (!a.ended) { a.ended = true; cb.onSessionEnd("stream closed"); } }, 10);
    }
    // "hang"：无任何定时回调（挂死）
    return a;
  };

const readJson = (p: string): unknown => {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
};

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-lead-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-lead-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  const prevResumeInit = process.env.CCR_RESUME_INIT_MS;
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD; // sticky 豁免分支的前提（设了 CCR_CWD 时该分支本就跳过）
  try {
    const cfg: RelayConfig = {
      port: 8791, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };

    // ---------- L0 CCR_NO_LEADER 禁用（#21 隔离缺陷批） ----------
    // 无锚即 spawn 真 CLI 是产品语义（生产首建），但测试/沙盒 relay 不需要 Leader 时
    // 必须能显式关掉：2026-09-28 expo 沙盒实锤 orgDir「存在但空」被当未建组织直接
    // 拉起真 Leader（bypassPermissions 上岗回合真烧）。锁死：禁用=零 spawn/零目录
    // 创建/零锚写盘/幂等
    {
      const ORG_D = join(ORG, "disabled-org");
      const DATA_D = mkdtempSync(join(tmpdir(), "ccr-data-lead-d-"));
      process.env.CCR_ORG_DIR = ORG_D;
      process.env.CCR_NO_LEADER = "1";
      const spawned0: SpawnRec[] = [];
      const mgr0 = new SessionManager(new EventBus({ persistPath: join(DATA_D, "events.ndjson") }), { ...cfg, dataDir: DATA_D });
      mgr0.setAgentFactory(makeFakeFactory(spawned0));
      const r0 = mgr0.ensureLeader();
      assert(r0.ok === false, "L0 禁用态 ensureLeader 返回 not-ok");
      assert(spawned0.length === 0, "L0 禁用态零 spawn（不烧真会话）");
      assert(!existsSync(ORG_D), "L0 禁用态不建 org 目录");
      assert(!existsSync(join(DATA_D, "pinned-sessions.json")), "L0 禁用态零 pinned 写盘");
      const r0b = mgr0.ensureLeader();
      assert(r0b.ok === false, "L0 禁用态幂等（重复调用仍 not-ok，未置常驻标记）");
      delete process.env.CCR_NO_LEADER;
      process.env.CCR_ORG_DIR = ORG; // 还原 L1 起的夹具路径
    }

    // ---------- L0b #21③ 首回合在途不被待命化假翻 ----------
    // 根因（2026-09-28 沙盒 Leader「已上岗」×N 排查实锤）：create(initialPrompt) 的
    // prompt 在 adapter 构造时已入 SDK 队列但不进 unacked——init 先于模型输出到达，
    // 旧待命化条件（unacked===0 && WORKING）在首回合在途时恰好满足 → 回合没跑就被
    // 假翻 DONE「待命」，首个流式帧又打回 WORKING，事件流呈现「DONE 后 WORKING 复起」
    //（×N 重复文本本身是同 id 流式部分帧，属观察口径）。pendingInitial 避让+终态清除
    {
      const ORG_B = join(ORG, "boot-org");
      const DATA_B = mkdtempSync(join(tmpdir(), "ccr-data-lead-b-"));
      const prevMode = initMode;
      process.env.CCR_ORG_DIR = ORG_B;
      initMode = "noinit"; // 手动驱动时序：init / 终态分开调，锁中间态
      const spawnedB: SpawnRec[] = [];
      const mgrB = new SessionManager(new EventBus({ persistPath: join(DATA_B, "events.ndjson") }), { ...cfg, dataDir: DATA_B });
      mgrB.setAgentFactory(makeFakeFactory(spawnedB));
      const rB = mgrB.ensureLeader();
      const idB = rB.ok ? rB.session_id : "";
      assert(rB.ok === true && spawnedB.length === 1, "L0b 前置：首建 spawn 一次（带 bootstrap prompt）");
      assert(spawnedB[0].prompt === ORG_LEADER_BOOTSTRAP_PROMPT, "L0b 前置：bootstrap prompt 在途（pendingInitial 置位的输入面）");
      // ① init 到达（unacked=0、WORKING、首回合在途）→ 不得假翻 DONE
      spawnedB[0].cb.onInit("sdk-boot-1", cfg.model, "default");
      const mid = mgrB.snapshot().find((s) => s.session_id === idB);
      assert(mid?.status === "WORKING", "L0b ① 首回合在途 onInit 不假翻 DONE（待命化避让）");
      // ② 回合终态正常收口（pendingInitial 清除路径）
      spawnedB[0].cb.onTurnEnd(true, "success", 100);
      const fin = mgrB.snapshot().find((s) => s.session_id === idB);
      assert(fin?.status === "DONE" && fin.done_reason === "success", "L0b ② 回合终态正常收口 DONE");
      // ③ 终态后 init 再到（换流形态）：状态稳定不炸、不产生新的假翻路径
      spawnedB[0].cb.onInit("sdk-boot-2", cfg.model, "default");
      const after = mgrB.snapshot().find((s) => s.session_id === idB);
      assert(after?.status === "DONE", "L0b ③ 回合后 init 到达状态稳定（DONE 保持）");
      initMode = prevMode;
      process.env.CCR_ORG_DIR = ORG;
    }

    // ---------- L1 首建 + L2 sticky-cwd 豁免 ----------
    console.log("L1 首建 + L2 sticky-cwd 豁免:");
    const sentinel = mkdtempSync(join(tmpdir(), "ccr-sentinel-"));
    writeFileSync(join(DATA, "last-cwd"), sentinel, "utf-8");
    cfg.defaultCwd = sentinel;

    const created1: SpawnRec[] = [];
    const mgr1 = new SessionManager(new EventBus({ persistPath: join(DATA, "events.ndjson") }), cfg);
    mgr1.setAgentFactory(makeFakeFactory(created1));

    const r1 = mgr1.ensureLeader();
    assert(r1.ok === true && r1.created === true, "L1 首建 created=true");
    const leaderId = r1.ok ? r1.session_id : "";
    assert(created1.length === 1 && created1[0].prompt === ORG_LEADER_BOOTSTRAP_PROMPT, "L1 唯一一次 spawn，携带上岗引导（fresh parked 不回 init，首条输入才产生 sdkId）");
    assert(mgr1.snapshot().find((s) => s.session_id === leaderId)?.employee === true, "L1 Leader 卡带雇员标记（#17 独立家身份）");

    const a1 = readOrgAnchor();
    assert(!!a1 && a1.leader_session_id === leaderId && a1.leader_sdk_id === "", "L1 锚落盘（sdk_id 空串 = 首建窗口）");

    const pinned1 = readJson(join(DATA, "pinned-sessions.json")) as string[] | null;
    assert(Array.isArray(pinned1) && pinned1.includes(leaderId), "L1 pinned 文件含 Leader id（首建即置顶）");

    const ov1 = readJson(join(DATA, "title-overrides.json")) as Record<string, string> | null;
    assert(!!ov1 && ov1[leaderId] === ORG_LEADER_TITLE, "L1 题名 override 落盘（跨重启权威）");

    assert(existsSync(join(ORG, "CLAUDE.md")), "L1 org CLAUDE.md 种子落盘");

    assert(readFileSync(join(DATA, "last-cwd"), "utf-8") === sentinel, "L2 last-cwd 文件未被 org 覆盖（豁免生效）");
    assert(cfg.defaultCwd === sentinel, "L2 cfg.defaultCwd 内存未变");

    // onInit → 锚回填 → 上岗回合收口（等终态防中间态竞态；#21③ 修复后 init 不再
    // 待命化假翻——首回合在途避让，终态由 onTurnEnd 翻 DONE，见 L0b）
    assert(await waitFor(() => {
      const c = mgr1.snapshot().find((s) => s.session_id === leaderId);
      return !!c && c.status === "DONE" && c.done_reason === "success";
    }), "L1 上岗回合正常收口（onTurnEnd 终态收口 DONE；reason=CLI terminal_reason，fake 固定 success）");
    const a1b = readOrgAnchor()!;
    assert(a1b.leader_sdk_id.startsWith("sdk-"), "L1 回填 sdk id（fake 工厂 sdk- 前缀口径）");
    assert(a1b.leader_session_id === leaderId, "L1 回填不换 relay id");
    const card1 = mgr1.snapshot().find((s) => s.session_id === leaderId)!;
    assert(card1.relay_session_id === a1b.leader_sdk_id, "L1 卡片 relay_session_id = 锚 sdk id");
    assert(card1.title === ORG_LEADER_TITLE && card1.title_locked === true, "L1 卡片题名立即生效（不等重启收养）");
    assert(card1.pinned === true, "L1 卡片置顶");
    assert(mgr1.isLeaderSession(leaderId) === true && mgr1.isLeaderSession("nope") === false, "L1 isLeaderSession 内存匹配");

    // ---------- L4 幂等 ----------
    console.log("L4 幂等:");
    const nBefore = mgr1.snapshot().length;
    const r4 = mgr1.ensureLeader();
    assert(r4.ok === true && r4.created === false && r4.rebuilt === false && r4.session_id === leaderId, "L4 再跑同 id、created/rebuilt 均 false");
    assert(mgr1.snapshot().length === nBefore && created1.length === 1, "L4 无新卡无新 spawn");

    // ---------- L3 重启重建（applyPinned 先清失联 → ensureLeader 零 spawn 重建）----------
    console.log("L3 重启重建:");
    const created2: SpawnRec[] = [];
    initMode = "init";
    const mgr2 = new SessionManager(new EventBus({ persistPath: join(DATA, "events.ndjson") }), cfg);
    mgr2.setAgentFactory(makeFakeFactory(created2));
    assert(mgr2.adopt(new Map()) === 0, "L3 adopt 空表（events 压缩挤掉 Leader 的形态）");
    mgr2.applyPinned();
    const pinnedClean = readJson(join(DATA, "pinned-sessions.json")) as string[] | null;
    assert(Array.isArray(pinnedClean) && !pinnedClean.includes(leaderId), "L3 applyPinned 静默清掉失联 Leader 条目（时序前提坐实：ensureLeader 必须在后）");

    const r3 = mgr2.ensureLeader();
    assert(r3.ok === true && r3.rebuilt === true && r3.session_id === leaderId, "L3 从锚重建（同 relay id）rebuilt=true");
    assert(created2.length === 0, "L3 重建零 spawn");
    const card3 = mgr2.snapshot().find((s) => s.session_id === leaderId)!;
    assert(card3.relay_session_id === a1b.leader_sdk_id, "L3 重建卡 relay_session_id = 锚 sdk id（可 resume）");
    assert(card3.status === "DONE" && card3.saved === true && card3.pinned === true && card3.historical === true, "L3 休眠卡形态：DONE/saved/pinned/historical");
    assert(card3.employee === true, "L3 锚重建保雇员标记（#17 边界审查 P1：compactEvents 30 会话上限挤掉首帧后，重建字面量不得丢身份）");
    assert(card3.employee_home === undefined && readOrgAnchor()?.employee_home === undefined, "L3 关态锚不带家记录（=默认家，与旧 transcript 实际所在一致）");
    assert(card3.title === ORG_LEADER_TITLE && card3.cwd === ORG, "L3 题名 + org cwd");
    const pinned3 = readJson(join(DATA, "pinned-sessions.json")) as string[] | null;
    assert(Array.isArray(pinned3) && pinned3.includes(leaderId), "L3 pinned 文件重新含 Leader id（重建后写回）");

    // ---------- L5 废锚（sdk_id 空 + 不在内存 → 清锚重建）----------
    console.log("L5 废锚:");
    const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org-lead2-"));
    const DATA2 = mkdtempSync(join(tmpdir(), "ccr-data-lead2-"));
    process.env.CCR_ORG_DIR = ORG2;
    writeOrgAnchor({ version: 1, leader_session_id: "bogus-leader-id", leader_sdk_id: "", created_at: 1, updated_at: 1 }, ORG2);
    const created5: SpawnRec[] = [];
    const cfg5: RelayConfig = { ...cfg, dataDir: DATA2, defaultCwd: "" };
    const mgr5 = new SessionManager(new EventBus({ persistPath: join(DATA2, "events.ndjson") }), cfg5);
    mgr5.setAgentFactory(makeFakeFactory(created5));
    const r5 = mgr5.ensureLeader();
    assert(r5.ok === true && r5.created === true, "L5 废锚按未建组织处理（清锚首建）");
    const a5 = readOrgAnchor();
    assert(!!a5 && a5.leader_session_id === (r5.ok ? r5.session_id : "") && a5.leader_session_id !== "bogus-leader-id", "L5 新锚替换废锚");
    rmSync(ORG2, { recursive: true, force: true });
    rmSync(DATA2, { recursive: true, force: true });
    rmSync(sentinel, { recursive: true, force: true });

    // ---------- L6 派单台账（C3） ----------
    console.log("L6 派单台账:");
    const ORG3 = mkdtempSync(join(tmpdir(), "ccr-org-lead3-"));
    const DATA3 = mkdtempSync(join(tmpdir(), "ccr-data-lead3-"));
    process.env.CCR_ORG_DIR = ORG3;
    const created6: SpawnRec[] = [];
    const cfg6: RelayConfig = { ...cfg, dataDir: DATA3, defaultCwd: "" };
    const mgr6 = new SessionManager(new EventBus({ persistPath: join(DATA3, "events.ndjson") }), cfg6);
    mgr6.setAgentFactory(makeFakeFactory(created6));
    const r6 = mgr6.ensureLeader();
    const lid = r6.ok ? r6.session_id : "";
    const msg = (sid: string, text: string) =>
      mgr6.handleCommand({ type: "COMMAND_MESSAGE", command_id: randomUUID(), ts: Date.now(), payload: { session_id: sid, text } }, "test");
    assert(await waitFor(() => {
      const c = mgr6.snapshot().find((s) => s.session_id === lid);
      return !!c && c.status === "DONE" && c.done_reason === "success";
    }), "L6 Leader 上岗回合完成（前置）");
    assert(readDispatchLog(ORG3).length === 0, "L6 上岗引导（create initialPrompt）不入台账");

    msg(lid, "咨询：矩阵式 M2 的路由表放哪层？");
    let log6 = readDispatchLog(ORG3);
    assert(log6.length === 1 && log6[0].status === "running" && log6[0].tier === "咨询" && log6[0].target === "org-leader" && log6[0].session_id === lid, "L6 MESSAGE→running（咨询/org-leader/会话 id）");
    const dA = log6[0].id;
    created6[0].cb.onTurnEnd(true, "答案已交付", 10);
    log6 = readDispatchLog(ORG3);
    assert(log6.length === 1 && log6[0].id === dA && log6[0].status === "done" && log6[0].receipt === "答案已交付", "L6 回合成功→同 id done（回执=terminal_reason）");

    msg(lid, "问题一");
    msg(lid, "问题二");
    log6 = readDispatchLog(ORG3);
    const running6 = log6.filter((e) => e.status === "running");
    assert(running6.length === 2, "L6 两条消息各自成单（FIFO 排队 2 个 running）");
    const dB = running6[0].id;
    const dC = running6[1].id;
    created6[0].cb.onTurnEnd(true, "第一答", 10);
    log6 = readDispatchLog(ORG3);
    assert(log6.find((e) => e.id === dB)?.status === "done" && log6.find((e) => e.id === dC)?.status === "running", "L6 一回合只收口最旧一单（FIFO 顺序）");
    created6[0].cb.onTurnEnd(false, "CLI 异常退出", 10);
    log6 = readDispatchLog(ORG3);
    assert(log6.find((e) => e.id === dC)?.status === "failed" && log6.find((e) => e.id === dC)?.receipt === "CLI 异常退出", "L6 回合失败→failed（回执保留）");

    const mk = mgr6.handleCommand({ type: "COMMAND_CREATE", command_id: randomUUID(), ts: Date.now(), payload: { cwd: ORG3, prompt: "普通会话" } }, "test");
    const otherId = mk.ok ? (mk.session_id ?? "") : "";
    assert(!!otherId && otherId !== lid, "L6 普通会话已建（前置）");
    msg(otherId, "普通消息");
    assert(readDispatchLog(ORG3).length === 3, "L6 非 Leader 会话零记账");

    msg(lid, "问一");
    msg(lid, "问二");
    created6[0].cb.onSessionEnd("stream closed");
    log6 = readDispatchLog(ORG3);
    assert(log6.length === 5 && log6.every((e) => e.status !== "running") && log6.filter((e) => e.receipt === "stream closed").length === 2, "L6 onSessionEnd 兜底全清（未收口一律 done）");

    msg(lid, "悬账问题");
    assert(readDispatchLog(ORG3).some((e) => e.status === "running"), "L6 悬账落盘（前置：崩溃前 running）");
    const created7: SpawnRec[] = [];
    const mgr7 = new SessionManager(new EventBus({ persistPath: join(DATA3, "events.ndjson") }), cfg6);
    mgr7.setAgentFactory(makeFakeFactory(created7));
    const r7 = mgr7.ensureLeader();
    assert(r7.ok === true && created7.length === 0, "L6 重启 ensureLeader ok 且零 spawn（前置）");
    log6 = readDispatchLog(ORG3);
    const hung6 = log6.find((e) => e.receipt === "relay 重启，回合中断");
    assert(!!hung6 && hung6.status === "done" && log6.every((e) => e.status !== "running"), "L6 断档补记：悬账补 done「relay 重启，回合中断」且无残留 running");
    rmSync(ORG3, { recursive: true, force: true });
    rmSync(DATA3, { recursive: true, force: true });

    // ---------- L7 M1/M2 审查轮：恢复路径漏收（reviveSaved/合并重放）+ Leader 卡拒删 ----------
    console.log("L7 审查轮（恢复漏收/Leader 拒删）:");
    const ORG4 = mkdtempSync(join(tmpdir(), "ccr-org-l7-"));
    const DATA4 = mkdtempSync(join(tmpdir(), "ccr-data-l7-"));
    process.env.CCR_ORG_DIR = ORG4;
    const created8: SpawnRec[] = [];
    const mgr8 = new SessionManager(new EventBus({ persistPath: join(DATA4, "events.ndjson") }), { ...cfg6, dataDir: DATA4 });
    mgr8.setAgentFactory(makeFakeFactory(created8));
    const r8 = mgr8.ensureLeader();
    const lid8 = r8.ok ? r8.session_id : "";
    assert(r8.ok === true && created8.length === 1, "L7 前置：首建 Leader");

    // (1) Leader 卡拒删：逻辑常驻锚是权威（§3.5）——进程内删卡=组织失聪（重启前无入口）
    assert(mgr8.deleteSession(lid8) === false, "L7 deleteSession(Leader) → 拒删");
    assert(!!mgr8.snapshot().find((s) => s.session_id === lid8), "L7 Leader 卡仍在册");
    const delAck = mgr8.handleCommand({ command_id: randomUUID(), type: "COMMAND_DELETE", ts: Date.now(), payload: { session_id: lid8 } }, "test") as { ok: boolean; error?: string };
    assert(delAck.ok === false && !!delAck.error, "L7 COMMAND_DELETE(Leader) → ok:false 带指引");

    // (2) 恢复走 reviveSaved（无未回显消息 → parked 恢复不再产生回合事件）→ 悬挂单按中断收口
    const msg8 = (text: string) =>
      mgr8.handleCommand({ command_id: randomUUID(), type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: lid8, text } }, "test");
    // 前置：上岗回合完成（onInit 已回、sdkId 在册——recoverFromStall 的 sdkId 检查在
    // 收口分支之前，太早触发会走 recover_fail 什么都没收）
    assert(await waitFor(() => {
      const c = mgr8.snapshot().find((s) => s.session_id === lid8);
      return !!c && c.status === "DONE" && c.done_reason === "success";
    }), "L7 Leader 上岗回合完成（前置）");
    msg8("咨询 X");
    assert(await waitFor(() => readDispatchLog(ORG4).some((e) => e.status === "running")), "L7 咨询单落账 running（前置）");
    const hack8 = mgr8 as unknown as {
      sessions: Map<string, { agent: { ended: boolean } | null; unacked: { text: string }[]; wd: { phase: string } }>;
      openDispatches: Map<string, { id: string; tier: "咨询" }[]>;
      recoverFromStall(s: never, lane: string, stalled: number, cpu: number): Promise<void>;
    };
    const s8 = hack8.sessions.get(lid8)!;
    s8.agent = { ended: true }; // 树已死（ended）：跳过杀树等待窗口，直达恢复分支
    s8.unacked = [];
    await hack8.recoverFromStall(s8 as never, "slow", 1000, 0);
    let log8 = readDispatchLog(ORG4);
    assert(log8.some((e) => e.status === "done" && e.receipt === "流中断恢复待命，回合中断"), "L7 reviveSaved 分支：悬挂单按中断收口（不再永悬 running）");
    assert(log8.every((e) => e.status !== "running"), "L7 无残留 running");
    assert(created8.length === 2, "L7 reviveSaved 拉起恢复流（spawn 记账）");

    // (3) 合并重放：N 条未回显 + N 张悬挂单 → 合成 1 回合只归头单，盈余从尾收（写实回执）
    msg8("问题一");
    msg8("问题二");
    assert(await waitFor(() => readDispatchLog(ORG4).filter((e) => e.status === "running").length === 2), "L7 两张悬挂单（前置）");
    s8.unacked = [{ text: "问题一" }, { text: "问题二" }];
    if (s8.agent) (s8.agent as { ended: boolean }).ended = true;
    await hack8.recoverFromStall(s8 as never, "slow", 1000, 0);
    log8 = readDispatchLog(ORG4);
    const merged = log8.find((e) => e.receipt === "多消息合并重放（并入同回合）");
    assert(!!merged && merged.status === "done", "L7 合并重放：盈余单先按中断收口（写实回执）");
    assert(log8.filter((e) => e.status === "running").length === 1, "L7 头单留给合并回合（FIFO 语义：尾单先收）");
    created8[created8.length - 1].cb.onTurnEnd(true, "合并作答", 10);
    log8 = readDispatchLog(ORG4);
    assert(log8.every((e) => e.status !== "running") && log8.some((e) => e.receipt === "合并作答"), "L7 合并回合 → 头单 done 归回合回执");
    rmSync(ORG4, { recursive: true, force: true });
    rmSync(DATA4, { recursive: true, force: true });

    // ---------- L8 收尾加固（adopt 零 spawn / 锚回写不变式 / evict Leader 豁免） ----------
    console.log("L8 加固（adopt/锚回写/evict 豁免）:");
    const ORG5 = mkdtempSync(join(tmpdir(), "ccr-org-l8-"));
    const DATA5 = mkdtempSync(join(tmpdir(), "ccr-data-l8-"));
    process.env.CCR_ORG_DIR = ORG5;
    const created9: SpawnRec[] = [];
    const mgr9 = new SessionManager(new EventBus({ persistPath: join(DATA5, "events.ndjson") }), { ...cfg6, dataDir: DATA5 });
    mgr9.setAgentFactory(makeFakeFactory(created9));
    const r9 = mgr9.ensureLeader();
    const lid9 = r9.ok ? r9.session_id : "";
    assert(r9.ok === true && created9.length === 1, "L8 前置：首建 Leader 一次 spawn");
    assert(await waitFor(() => {
      const c = mgr9.snapshot().find((s) => s.session_id === lid9);
      return !!c && c.status === "DONE" && c.done_reason === "success";
    }), "L8 前置：上岗回合完成（onInit 已回、sdkId 落锚）");
    const a9 = readOrgAnchor();
    assert(!!a9 && a9.leader_session_id === lid9 && !!a9.leader_sdk_id, "L8 前置：锚带 sdkId");

    // (1) adopt 零 spawn：重启形态 = 内存已有该会话（events 历史回放形态）→
    //     ensureLeader 只认领（adoptExistingLeader），无 spawn 无重建
    const created10: SpawnRec[] = [];
    const mgr10 = new SessionManager(new EventBus({ persistPath: join(DATA5, "events2.ndjson") }), { ...cfg6, dataDir: DATA5 });
    mgr10.setAgentFactory(makeFakeFactory(created10));
    mgr10.adopt(new Map([[lid9, {
      state: {
        session_id: lid9, relay_session_id: a9!.leader_sdk_id, cwd: ORG5, initial_prompt: "x",
        title: "Leader", model: "m", status: "DONE", action_summary: "（历史）",
        started_at: 1, updated_at: 1, stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
        pinned: true,
      },
      logs: [],
    } as ReplayedSession]]));
    const r10 = mgr10.ensureLeader();
    assert(r10.ok === true && r10.created === false && r10.rebuilt === false && created10.length === 0, "L8 adopt 零 spawn（内存已有 → 只认领不建）");
    rmSync(join(DATA5, "events2.ndjson"), { force: true });

    // (2) 锚回写不变式：固定 relay id 靠「每次换流 onInit 回写」——resume 产生新
    //     sdkId，锚必须跟着收敛（否则重启重建的休眠卡拿旧 sdk resume 失联）
    const hack9 = mgr9 as unknown as { sessions: Map<string, { agent: unknown | null }> };
    hack9.sessions.get(lid9)!.agent = null; // 模拟旧流已死（resume 路径前提）
    mgr9.handleCommand({ command_id: randomUUID(), type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: lid9, text: "再问一条" } }, "test");
    assert(await waitFor(() => created9.length === 2), "L8 resume 换流 spawn（前置）");
    assert(await waitFor(() => {
      const a = readOrgAnchor();
      return !!a && a.leader_session_id === lid9 && !!a.leader_sdk_id && a.leader_sdk_id !== a9!.leader_sdk_id;
    }), "L8 锚回写不变式：换流新 sdkId → 锚收敛（relay id 不变）");

    // (3) evict Leader 豁免：容量满（MAX_SESSIONS=20）只挤普通 DONE 卡；pinned
    //     （Leader 首建即置顶）永不动——锚是权威，驱逐 Leader=组织失聪
    const hackEvict = mgr9 as unknown as { sessions: Map<string, unknown>; evictOldSessions(): void };
    const sess9 = hackEvict.sessions as Map<string, { state: { session_id: string; status: string; pinned?: boolean; started_at: number } }>;
    for (let i = 0; i < 21; i++) {
      sess9.set("ev-dummy-" + i, { state: { session_id: "ev-dummy-" + i, status: "DONE", started_at: 1000 + i, pinned: undefined } });
    }
    (sess9.get(lid9) as { state: { started_at: number } }).state.started_at = 1; // Leader 置最老——若豁免失效必先被驱逐
    hackEvict.evictOldSessions();
    assert(!!sess9.get(lid9), "L8 Leader 豁免驱逐（pinned，锚是权威）");
    assert(!sess9.has("ev-dummy-0") && sess9.size < 20, `L8 普通旧卡先被挤（余 ${sess9.size} < 20）`);
    rmSync(ORG5, { recursive: true, force: true });
    rmSync(DATA5, { recursive: true, force: true });

    // ---------- L9 #17 第二批：开启态锚记家（建锚写入 → onInit 回写保留 → 重启重建还原） ----------
    console.log("L9 锚记家（#17 第二批）:");
    const ORG6 = mkdtempSync(join(tmpdir(), "ccr-org-l9-"));
    const DATA6 = mkdtempSync(join(tmpdir(), "ccr-data-l9-"));
    const EMP6 = mkdtempSync(join(tmpdir(), "ccr-emp-l9-"));
    process.env.CCR_ORG_DIR = ORG6;
    const created11: SpawnRec[] = [];
    const cfg11: RelayConfig = { ...cfg6, dataDir: DATA6, employeeConfigDir: EMP6 };
    const mgr11 = new SessionManager(new EventBus({ persistPath: join(DATA6, "events.ndjson") }), cfg11);
    mgr11.setAgentFactory(makeFakeFactory(created11));
    const r11 = mgr11.ensureLeader();
    const lid11 = r11.ok ? r11.session_id : "";
    assert(r11.ok === true && !!lid11, "L9 开启态首建 Leader（前置）");
    assert(created11[0]?.configHome === EMP6, "L9 首建 spawn 带 configHome=独立家（上岗回合即落独立家）");
    const a11 = readOrgAnchor();
    assert(a11?.employee_home === EMP6, "L9 锚记家：建锚写入创建时落定的家");
    assert(mgr11.snapshot().find((s) => s.session_id === lid11)?.employee_home === EMP6, "L9 Leader 卡带 employee_home 记录");
    // 上岗回合完成 → onInit 回写锚（spread 保留 employee_home 不丢）
    assert(await waitFor(() => {
      const c = mgr11.snapshot().find((s) => s.session_id === lid11);
      return !!c && c.status === "DONE" && c.done_reason === "success";
    }), "L9 上岗回合完成（前置）");
    assert(readOrgAnchor()?.employee_home === EMP6 && !!readOrgAnchor()?.leader_sdk_id, "L9 onInit 回写锚后 employee_home 保留（sdk_id 收敛不顶掉家记录）");
    // 重启锚重建（events 挤掉首帧形态）：开关翻转（关）后重建仍按锚记录还原——
    // 常驻 Leader 的 resume 恒指其 transcript 实际所在的家
    cfg11.employeeConfigDir = null; // 重启前用户关了开关
    const created12: SpawnRec[] = [];
    const mgr12 = new SessionManager(new EventBus({ persistPath: join(DATA6, "events.ndjson") }), cfg11);
    mgr12.setAgentFactory(makeFakeFactory(created12));
    assert(mgr12.adopt(new Map()) === 0, "L9 adopt 空表（events 挤掉首帧形态，前置）");
    mgr12.applyPinned();
    const r12 = mgr12.ensureLeader();
    assert(r12.ok === true && r12.rebuilt === true && r12.session_id === lid11, "L9 锚重建（前置）");
    const card12 = mgr12.snapshot().find((s) => s.session_id === lid11)!;
    assert(card12.employee === true && card12.employee_home === EMP6, "L9 重建卡按锚还原 employee_home（开关翻转对常驻 Leader 无损）");
    // 重建卡消息复活路径的 spawn 选家：employeeHome() 记录优先——resume 带 EMP 而非当前关态的 undefined
    const ack12 = mgr12.handleCommand({ command_id: randomUUID(), type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: lid11, text: "重建后咨询" } }, "test");
    assert(ack12.ok === true, "L9 重建卡可发消息复活（前置）");
    assert(await waitFor(() => created12.some((c) => c.resume)), "L9 复活 resume spawn 发起（前置）");
    assert(created12.filter((c) => c.resume).every((c) => c.configHome === EMP6), "L9 重建卡 resume 带锚记录的家（关态翻转后仍指 transcript 实际所在）");
    rmSync(ORG6, { recursive: true, force: true });
    rmSync(DATA6, { recursive: true, force: true });
    rmSync(EMP6, { recursive: true, force: true });

    // ---------- L10 #22① 首建 init 看门狗（hang CLI：不 init/不报错/不退出） ----------
    // 首建 prompt 不进 unacked → #7 watchdog pre-init 豁免恰好命中（永无人管）——
    // bootTimer 是唯一防线：超时=杀树+清锚+卸常驻+删卡；同进程再调 ensureLeader 即重建。
    // CCR_RESUME_INIT_MS=300 加速；对照组锁正常路径：重建后 init 已到，timer 到点空转不动作
    {
      const ORG_G = mkdtempSync(join(tmpdir(), "ccr-org-l10-"));
      const DATA_G = mkdtempSync(join(tmpdir(), "ccr-data-l10-"));
      process.env.CCR_ORG_DIR = ORG_G;
      process.env.CCR_RESUME_INIT_MS = "300";
      const prevMode10 = initMode;
      initMode = "hang";
      const spawned10: SpawnRec[] = [];
      const mgr10 = new SessionManager(new EventBus({ persistPath: join(DATA_G, "events.ndjson") }), { ...cfg, dataDir: DATA_G });
      mgr10.setAgentFactory(makeFakeFactory(spawned10));
      const r10 = mgr10.ensureLeader();
      const id10 = r10.ok ? r10.session_id : "";
      assert(r10.ok === true && !!id10 && spawned10.length === 1, "L10 前置：首建 spawn 一次（hang CLI 不回 init）");
      assert(readOrgAnchor()?.leader_sdk_id === "", "L10 前置：锚 sdk_id 空串（init 未回填）");
      assert(await waitFor(() => mgr10.snapshot().every((s) => s.session_id !== id10)), "L10 ① 超时开火：挂死首建卡被删（deleteSession 通道）");
      assert(readOrgAnchor() === null, "L10 ② 废锚清除（空 sdk_id 本就 resume 不了）");
      const pinned10 = readJson(join(DATA_G, "pinned-sessions.json")) as string[] | null;
      assert(!Array.isArray(pinned10) || !pinned10.includes(id10), "L10 ③ pinned 写穿同步摘除");
      // 重建（同进程 ensureLeader，leaderId/Ensured 已卸）：init 模式正常上岗；缺省
      // 45s 窗内 timer 不会开火，且 init 到达后 relay_session_id 回填=空转条件
      if (prevResumeInit === undefined) delete process.env.CCR_RESUME_INIT_MS; else process.env.CCR_RESUME_INIT_MS = prevResumeInit;
      initMode = "init";
      const r10b = mgr10.ensureLeader();
      const id10b = r10b.ok ? r10b.session_id : "";
      assert(r10b.ok === true && r10b.created === true && id10b !== id10, "L10 ④ 清锚后重首建（新 id，旧僵尸不复活）");
      assert(await waitFor(() => {
        const c = mgr10.snapshot().find((s) => s.session_id === id10b);
        return !!c && c.status === "DONE" && c.done_reason === "success";
      }), "L10 ⑤ 重建 Leader 正常上岗收口（init 已到，timer 空转不误杀）");
      assert(!!readOrgAnchor()?.leader_sdk_id && readOrgAnchor()?.leader_session_id === id10b, "L10 ⑥ 重建锚 sdk_id 正常回填");
      initMode = prevMode10;
      rmSync(ORG_G, { recursive: true, force: true });
      rmSync(DATA_G, { recursive: true, force: true });
    }

    // ---------- L11 #22② 废锚僵尸：sdk_id 空锚 + 内存卡 → 清锚重首建 ----------
    // 场景：首建落了 SESSION_CREATED 但 init 前崩（锚 sdk_id 空串）→ 重启后卡被 adopt
    // 收养在内存——旧实现 adoptExistingLeader 直接收养置 leaderEnsured，但该卡 resume
    // 永抛「无 SDK 会话记录」，常驻通道变砖。修法：双条件（锚 sdk_id 空 && 卡
    // relay_session_id 空）→ 清锚按未建组织重首建（旧卡留为普通卡）；对照组锁
    // guard 不误杀正常收养
    {
      const ORG_H = mkdtempSync(join(tmpdir(), "ccr-org-l11-"));
      const DATA_H = mkdtempSync(join(tmpdir(), "ccr-data-l11-"));
      const DATA_I = mkdtempSync(join(tmpdir(), "ccr-data-l11c-"));
      process.env.CCR_ORG_DIR = ORG_H;
      const mkCard = (id: string, rid: string): ReplayedSession => ({
        state: {
          session_id: id, relay_session_id: rid, cwd: ORG_H, initial_prompt: "", title: "zombie",
          model: "", status: "DONE", action_summary: "", started_at: Date.now(), updated_at: Date.now(),
          stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 },
          external: false, remote_mode: false,
        } as SessionState,
        logs: [],
      });
      // ① 僵尸形态：空 sdk_id 锚 + 空relay_session_id 卡
      writeOrgAnchor({ version: 1, leader_session_id: "dead-l11", leader_sdk_id: "", created_at: Date.now(), updated_at: Date.now() });
      const spawnedH: SpawnRec[] = [];
      const mgrH = new SessionManager(new EventBus({ persistPath: join(DATA_H, "events.ndjson") }), { ...cfg, dataDir: DATA_H });
      mgrH.setAgentFactory(makeFakeFactory(spawnedH));
      mgrH.adopt(new Map([["dead-l11", mkCard("dead-l11", "")]]));
      const rH = mgrH.ensureLeader();
      const newH = rH.ok ? rH.session_id : "";
      assert(rH.ok === true && rH.created === true && newH !== "dead-l11", "L11 ① 僵尸卡不被收养：清锚重首建（created=true 新 id）");
      assert(spawnedH.length === 1 && readOrgAnchor()?.leader_session_id === newH, "L11 ② 重首建 spawn 一次、锚指向新 Leader");
      assert(!!mgrH.snapshot().find((s) => s.session_id === "dead-l11"), "L11 ③ 旧僵尸卡保留为普通卡（可手删）");
      // ② 对照：sdk_id 已回填 + 卡在内存 → 正常收养（不误入僵尸分支）
      writeOrgAnchor({ version: 1, leader_session_id: "live-l11", leader_sdk_id: "sdk-live-11", created_at: Date.now(), updated_at: Date.now() });
      const spawnedI: SpawnRec[] = [];
      const mgrI = new SessionManager(new EventBus({ persistPath: join(DATA_I, "events.ndjson") }), { ...cfg, dataDir: DATA_I });
      mgrI.setAgentFactory(makeFakeFactory(spawnedI));
      mgrI.adopt(new Map([["live-l11", mkCard("live-l11", "sdk-live-11")]]));
      const rI = mgrI.ensureLeader();
      assert(rI.ok === true && rI.created === false && rI.session_id === "live-l11", "L11 ④ 对照：sdk_id 已回填的锚+内存卡 → 正常收养");
      assert(spawnedI.length === 0, "L11 ⑤ 对照：收养零 spawn（guard 不误杀）");
      rmSync(ORG_H, { recursive: true, force: true });
      rmSync(DATA_H, { recursive: true, force: true });
      rmSync(DATA_I, { recursive: true, force: true });
    }
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwdEnv === undefined) delete process.env.CCR_CWD; else process.env.CCR_CWD = prevCwdEnv;
    if (prevResumeInit === undefined) delete process.env.CCR_RESUME_INIT_MS; else process.env.CCR_RESUME_INIT_MS = prevResumeInit;
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
