// W-RESUME-P2SWEEP #36 重启自愈（用户 1101 实锤「会话已中断，发送消息即可继续」需
// 人工续）——两态+逃生阀+标记面回归：
//   A. markManagedRebootInterrupted（history.ts 分类标记）：WORKING 打标+续跑文案 / WAITING 不打标+旧文案
//   B. resumeInterruptedByReboot（boot 自愈链）：WORKING 中断→自动 resume（WORKING 态+agent 在岗+标清+通知）；
//      空闲（无标）→不恢复；CCR_RESUME_ON_REBOOT=0 逃生阀→不恢复；
//      「无开放待办」照拉（#36 核心：autoRevive 待办闸漏掉的纯执行回合）；
//      retired/互斥等其余闸沿用 reviveEligible（他处已测，此处不重复）。
// 惯例对齐 test-org-defects：fake agentFactory / CCR_ORG_DIR+CCR_DATA_DIR 隔离 / 断言累计。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { markManagedRebootInterrupted } from "../src/history.js";
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
        cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 });
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 10);
    return a;
  };

async function main() {
  // ---------- A. markManagedRebootInterrupted（分类标记面） ----------
  console.log("A history.ts 分类标记（markManagedRebootInterrupted）:");
  const mkRs = () => ({ state: { status: "WORKING", done_reason: undefined as string | undefined, historical: false, pre_reboot_status: undefined as string | undefined }, logs: [] as { ts: number; kind: string; text: string }[] });
  const rsW = mkRs();
  markManagedRebootInterrupted(rsW, "WORKING");
  assert(rsW.state.status === "DONE" && rsW.state.historical === true, "WORKING 中断→DONE 中性态（不触发完成通知卡——#52 语义保持）");
  assert(rsW.state.pre_reboot_status === "WORKING", "WORKING 中断→pre_reboot_status 打标（boot 自愈链选人凭据）");
  assert(rsW.logs.some((l) => l.text.includes("自动续跑")), "文案预告自动续跑（不再「发送消息即可继续」干等）");
  const rsWait = mkRs(); rsWait.state.status = "WAITING";
  markManagedRebootInterrupted(rsWait, "WAITING");
  assert(rsWait.state.pre_reboot_status === undefined, "WAITING 中断不打标（半截权限流 resume 无法自答——人工触发）");
  assert(rsWait.logs.some((l) => l.text.includes("发送消息即可继续")), "WAITING 维持旧文案（行为零变）");
  const rsIdle = mkRs(); rsIdle.state.status = "DONE";
  markManagedRebootInterrupted(rsIdle, "DONE");
  assert(rsIdle.state.pre_reboot_status === undefined, "终态（DONE）重放不打标（空闲会话维持现行为——无活硬续=烧 token）");

  // ---------- B. resumeInterruptedByReboot（boot 自愈链两态+逃生阀） ----------
  console.log("B boot 自愈链（resumeInterruptedByReboot）:");
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-resume-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-resume-"));
  const WT_ROOT = mkdtempSync(join(tmpdir(), "ccr-wt-resume-"));
  const ART = mkdtempSync(join(tmpdir(), "ccr-art-resume-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_WT_ROOT = WT_ROOT;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  delete process.env.CCR_RESUME_ON_REBOOT;
  delete process.env.CCR_NO_AUTOREVIVE;
  try {
    const cfg: RelayConfig = {
      port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));

    const anchor = join(DATA, "proj-resume");
    mkdirSync(anchor, { recursive: true });
    const c2 = mgr.orgAction("project-create", { name: "resume 组", anchor, tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    const gid = c2.data?.group?.id ?? "";
    if (c2.data?.needsConfirm) mgr.orgAction("confirm-decide", { confirm_id: c2.data.confirm?.id ?? "", approve: true, by: "u" });
    assert(!!gid, "组建就绪");

    // B1 前置：派单造一个真托管会话（拿 relay_session_id），收工回 DONE
    const dp = mgr.orgAction("dispatch", { anchor, prompt: "#36 测试用会话（重启用）", gid, title: "resume-target" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(dp.ok === true, "派单造托管会话");
    await waitFor(() => mgr.snapshot().some((s) => s.session_id === dp.session_id && s.status === "DONE"));
    const s = (mgr as any).sessions.get(dp.session_id) as any;
    assert(!!s?.state?.relay_session_id, `托管会话有 resume 锚（relay_session_id=${String(s?.state?.relay_session_id).slice(0, 8)}…）`);

    // B1 主断言：模拟「重启重放后」形态（DONE+historical+pre_reboot_status 标+无活 agent
    // ——重放只重建状态不重建进程）→ 自愈续跑
    //（任务存储无 todos 文件=no-open-todos——恰是 autoRevive 待办闸漏掉、#36 要接的形态）
    s.state.status = "DONE"; s.state.historical = true; s.state.pre_reboot_status = "WORKING"; s.agent = null;
    const resumed = mgr.resumeInterruptedByReboot();
    assert(resumed === 1, `WORKING 中断→自动恢复（resumed=${resumed}——无开放待办也拉，纯执行回合不再漏）`);
    assert(s.state.status === "WORKING" && !!s.agent, "会话回 WORKING+agent 在岗（resumeAgent 真拉起）");
    assert(s.state.pre_reboot_status === undefined, "消费即清标（防重放双拉）");
    const ntf = [...((mgr as any).notifications as Map<string, { title: string }>).values()].filter((n) => n.title.includes("中断会话已自动续跑"));
    assert(ntf.length >= 1, "自动续跑通知在账（用户知情——不再静默）");
    await waitFor(() => mgr.snapshot().some((x) => x.session_id === dp.session_id && x.status === "DONE"));

    // B2 空闲（无标）不恢复
    s.state.status = "DONE"; s.state.historical = true; s.agent = null; delete s.state.pre_reboot_status;
    const resumedIdle = mgr.resumeInterruptedByReboot();
    assert(resumedIdle === 0 && s.state.status === "DONE", `空闲会话不恢复（resumed=${resumedIdle}——无活硬续=烧 token）`);

    // B3 逃生阀 CCR_RESUME_ON_REBOOT=0
    s.state.pre_reboot_status = "WORKING";
    process.env.CCR_RESUME_ON_REBOOT = "0";
    const resumedOff = mgr.resumeInterruptedByReboot();
    assert(resumedOff === 0 && s.state.status === "DONE", `逃生阀=0 不恢复（resumed=${resumedOff}——紧急关停面）`);
    delete process.env.CCR_RESUME_ON_REBOOT;
    // 阀开后同标照拉（阀是开关不是清标）
    const resumedOn = mgr.resumeInterruptedByReboot();
    assert(resumedOn === 1, "撤阀后同标照拉（阀=开关非清标）");
    await waitFor(() => mgr.snapshot().some((x) => x.session_id === dp.session_id && x.status === "DONE"));
  } finally {
    process.env = prev as NodeJS.ProcessEnv;
    try { rmSync(ORG, { recursive: true, force: true }); } catch {}
    try { rmSync(DATA, { recursive: true, force: true }); } catch {}
    try { rmSync(WT_ROOT, { recursive: true, force: true }); } catch {}
    try { rmSync(ART, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
