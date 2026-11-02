// #PMRESUME（用户 1102 晚实锤×3 手动拉回）：PM 席位重启自愈——闸实锤断言+席位豁免
// 两态+普通会话零波及+逃生阀/互斥闸+双实例接力端到端。
// 惯例对齐 test-resume-reboot：fake agentFactory / CCR_ORG_DIR+CCR_DATA_DIR 隔离 / 断言累计。
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { reviveEligible } from "../src/lifecycle/revive.js";
import { bootReplayFile } from "../src/history.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

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
        if (a.ended || busyHold) return; // busyHold=挂起：回合不收口（WORKING 中断形态）
        cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 });
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 10);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-pmresume-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-pmresume-"));
  const ART = mkdtempSync(join(tmpdir(), "ccr-art-pmresume-"));
  const WT_ROOT = mkdtempSync(join(tmpdir(), "ccr-wt-pmresume-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_WT_ROOT = WT_ROOT;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  delete process.env.CCR_RESUME_ON_REBOOT;
  delete process.env.CCR_NO_AUTOREVIVE;
  delete process.env.CCR_PM_DUTY;
  delete process.env.CCR_NO_LEADER;
  try {
    const cfg: RelayConfig = {
      port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const eventsPath = join(DATA, "events.ndjson");
    const bus = new EventBus({ persistPath: eventsPath });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const lid = mgr.getLeaderSessionId() ?? "";
    assert(!!lid, "leaderId 在册");
    const s = (mgr as any).sessions.get(lid) as any;
    assert(!!s?.state?.pinned, "PM 首建即置顶（pin 语义在位——闸实锤前提）");
    assert(!!s?.state?.relay_session_id, `PM 有 SDK 锚（resume 句柄 ${String(s?.state?.relay_session_id).slice(0, 8)}…）`);

    // ---------- A. 闸实锋试验台：PM WORKING 中断被重启（重挂后形态） ----------
    console.log("A 闸实锋试验台（PM WORKING 中断→重启重挂形态）:");
    s.state.status = "DONE"; s.state.historical = true; s.state.saved = true; s.state.pre_reboot_status = "WORKING"; s.agent = null;
    const gate = reviveEligible(mgr, s) as string;
    assert(gate === "pinned-dormant", `闸实锤：reviveEligible 判「${gate}」——pinned+saved（W-LEADFIX 闸，非任务书猜的外部/无锚）`);
    assert(mgr.resumeInterruptedByReboot() === 0 && s.state.status === "DONE", "#36 通道现状实锤：被 pinned-dormant 拦（PM 静默停摆=手动拉回×3 的机制）");
    const n1 = mgr.resumeLeaderAfterReboot();
    assert(n1 === 1, `席位通道拉起（resumeLeaderAfterReboot=${n1}——席位豁免 pinned-dormant）`);
    assert(s.state.status === "WORKING" && !!s.agent, "PM 中断续跑：回 WORKING+agent 在岗");
    assert(s.state.pre_reboot_status === undefined, "清标防 #36 双拉");
    const ntf = [...((mgr as any).notifications as Map<string, { title: string }>).values()].filter((n) => n.title.includes("值守 PM 已自动续跑"));
    assert(ntf.length >= 1, "自愈通知在账（用户知情）");
    await waitFor(() => mgr.snapshot().some((x) => x.session_id === lid && x.status === "DONE"));

    // ---------- B. 空闲温床：无标 idle PM 重启后拉起待命 ----------
    console.log("B 空闲温床（idle PM 重启→温床待命）:");
    s.state.status = "DONE"; s.state.historical = true; s.state.saved = true; delete s.state.pre_reboot_status; s.agent = null;
    const n2 = mgr.resumeLeaderAfterReboot();
    assert(n2 === 1, `空闲席位拉起待命（=${n2}——keepalive 温床同语义，duty 门管）`);
    const allNtf = [...((mgr as any).notifications as Map<string, any>).values()];
    const ntf2 = allNtf.filter((n: any) => String(n.title ?? "").includes("值守 PM 已拉起待命"));
    assert(ntf2.length >= 1, `待命通知在账（现有 titles: ${allNtf.map((n: any) => n.title).join(" | ").slice(0, 160) || "（空）"}）`);
    await waitFor(() => mgr.snapshot().some((x) => x.session_id === lid && x.status === "DONE"));

    // ---------- C. 普通会话零波及 ----------
    console.log("C 普通会话语义零变化:");
    const anchor = join(DATA, "proj-pmresume");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(anchor, { recursive: true });
    const c2 = mgr.orgAction("project-create", { name: "pmresume 组", anchor, tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    const gid = c2.data?.group?.id ?? "";
    if (c2.data?.needsConfirm) mgr.orgAction("confirm-decide", { confirm_id: c2.data.confirm?.id ?? "", approve: true, by: "u" });
    const dp = mgr.orgAction("dispatch", { anchor, prompt: "普通会话（零波及对照）", gid, title: "worker-norm" }) as { ok: boolean; session_id?: string };
    await waitFor(() => mgr.snapshot().some((x) => x.session_id === dp.session_id && x.status === "DONE"));
    const w = (mgr as any).sessions.get(dp.session_id) as any;
    w.state.status = "DONE"; w.state.historical = true; w.state.saved = true; w.state.pinned = true; w.state.pre_reboot_status = "WORKING"; w.agent = null;
    assert(mgr.resumeLeaderAfterReboot() === 0 && w.state.status === "DONE", "席位通道只认 leaderId（普通会话不碰——即便同 pinned+saved+标形态）");
    assert(mgr.resumeInterruptedByReboot() === 0, "普通会话照旧被 pinned-dormant 拦（#36 语义零变——W-LEADFIX 拍板对普通置顶会话仍有效）");

    // ---------- D. 阀与安全闸 ----------
    console.log("D 逃生阀与安全闸:");
    s.state.pre_reboot_status = "WORKING"; s.agent = null;
    process.env.CCR_RESUME_ON_REBOOT = "0";
    assert(mgr.resumeLeaderAfterReboot() === 0 && s.state.status === "DONE", `逃生阀=0 不拉（紧急关停面；标保留=${s.state.pre_reboot_status === "WORKING"}）`);
    delete process.env.CCR_RESUME_ON_REBOOT;
    s.resumePending = Date.now();
    assert(mgr.resumeLeaderAfterReboot() === 0, "resume 互斥窗内不拉（防双进程——席位豁免不含安全三闸）");
    s.resumePending = undefined;
    const n4 = mgr.resumeLeaderAfterReboot();
    assert(n4 === 1, "撤阀撤窗后照拉（阀/窗=开关非清标）");
    await waitFor(() => mgr.snapshot().some((x) => x.session_id === lid && x.status === "DONE"));

    // ---------- E. 端到端（真事件流：kill→replay→分类打标→adopt→席位自愈） ----------
    console.log("E 端到端（真事件流 kill→replay→adopt→席位自愈）:");
    // 主 harness 的 leader 事件全程落 events.ndjson（CREATED 完整）；二回合挂起制造
    // 「值守回合被 kill 切断」的真形态——重放分类（markManagedRebootInterrupted）
    // 走生产真路径打标，非手工置 state
    busyHold = true;
    (mgr as any).resumeAgent(s, "e2e 值守回合：巡检在途（busyHold 挂起=kill 前在跑）");
    assert(await waitFor(() => s.state?.status === "WORKING" && !!s.agent, 4000), "e2e：kill 前 PM WORKING 在岗（真回合+真锚）");
    // —— kill 模拟：主 mgr 连同 agent 丢弃（fake agent 无守护定时器=进程死）——
    // —— 重启模拟：mgr2 回放同 events → 分类打标 → adopt → applyPinned → ensureLeader（saved+DONE 休眠）→ 席位自愈 ——
    const boot = await bootReplayFile(eventsPath);
    assert(boot.sessions.size >= 1, `回放产物非空（sessions=${boot.sessions.size}——真分类路径）`);
    const mgr2 = new SessionManager(new EventBus({ persistPath: eventsPath }), cfg);
    mgr2.setAgentFactory(makeFakeFactory());
    const adopted = (mgr2 as any).adopt(boot.sessions);
    (mgr2 as any).applyPinned();
    const r2 = mgr2.ensureLeader();
    const lid2 = mgr2.getLeaderSessionId() ?? "";
    assert(r2.ok === true && lid2 === lid && adopted >= 1, `重启回放收养（adopt=${adopted}，leaderId 复原 ${lid2.slice(0, 8)}…）`);
    const s2 = (mgr2 as any).sessions.get(lid2) as any;
    assert(s2?.state?.saved === true && s2?.state?.pinned === true, "重启后 PM 形态：pinned+saved「已保存休眠」（adoptExistingLeader 强制——用户见到的停摆态）");
    const gate2 = reviveEligible(mgr2, s2) as string;
    assert(gate2 === "pinned-dormant", `端到端闸实锤复现（reviveEligible=「${gate2}」——#36 对它无能为力）`);
    const replayedMarker = s2?.state?.pre_reboot_status;
    const n5 = mgr2.resumeLeaderAfterReboot();
    assert(n5 === 1 && replayedMarker === "WORKING", `真分类打标（pre_reboot_status=${String(replayedMarker)}）+ 席位自愈拉起（=${n5}——无人工干预）`);
    assert(await waitFor(() => s2.state?.status === "WORKING" && !!s2.agent, 5000), "端到端终态：PM 自续 WORKING+agent 在岗（验收=杀 relay 重启 PM 自续 ✓）");
    busyHold = false;

  } finally {
    busyHold = false;
    process.env = prev as NodeJS.ProcessEnv;
    for (const d of [ORG, DATA, WT_ROOT, ART]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
