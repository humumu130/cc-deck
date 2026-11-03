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
import { markManagedRebootInterrupted, rebootAutoResumable, reduceHistory } from "../src/history.js";
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
  // ---------- A. markManagedRebootInterrupted（分类标记面+W-REBOOTTXT 分类） ----------
  console.log("A history.ts 分类标记（markManagedRebootInterrupted）:");
  const mkRs = () => ({ state: { status: "WORKING", done_reason: undefined as string | undefined, historical: false, pre_reboot_status: undefined as string | undefined }, logs: [] as { ts: number; kind: string; text: string }[] });
  const rsW = mkRs();
  markManagedRebootInterrupted(rsW, "WORKING", true);
  assert(rsW.state.status === "DONE" && rsW.state.historical === true, "WORKING 中断→DONE 中性态（不触发完成通知卡——#52 语义保持）");
  assert(rsW.state.pre_reboot_status === "WORKING", "WORKING 中断→pre_reboot_status 打标（boot 自愈链选人凭据）");
  assert(rsW.logs.some((l) => l.text.includes("自动续跑")), "文案预告自动续跑（不再「发送消息即可继续」干等）");
  const rsWait = mkRs(); rsWait.state.status = "WAITING";
  markManagedRebootInterrupted(rsWait, "WAITING", true);
  assert(rsWait.state.pre_reboot_status === undefined, "WAITING 中断不打标（半截权限流 resume 无法自答——人工触发）");
  assert(rsWait.logs.some((l) => l.text.includes("发送消息即可继续")), "WAITING 维持旧文案（行为零变）");
  const rsIdle = mkRs(); rsIdle.state.status = "DONE";
  markManagedRebootInterrupted(rsIdle, "DONE", true);
  assert(rsIdle.state.pre_reboot_status === undefined, "终态（DONE）重放不打标（空闲会话维持现行为——无活硬续=烧 token）");
  // ---------- A2. W-REBOOTTXT 分类：revive 链注定拒续的类型不诺续 ----------
  console.log("A2 中断文案分类（W-REBOOTTXT 外部 CLI 不诺自动续跑）:");
  const rsExt = mkRs();
  markManagedRebootInterrupted(rsExt, "WORKING", false);
  assert(rsExt.state.pre_reboot_status === undefined, "外部/拒续型 WORKING 中断不打标（boot 链空试=落空承诺——省得试）");
  assert(rsExt.logs.some((l) => l.text.includes("发送消息即可继续")) && !rsExt.logs.some((l) => l.text.includes("自动续跑")), "拒续型文案如实「发送消息即可继续」（不诺自动续跑——用户实锤 5e4f4963 对症）");
  assert(rsExt.state.status === "DONE" && rsExt.state.historical === true, "拒续型状态语义不变（DONE 中性态+historical——仅文案与打标分叉）");
  const rsExtWait = mkRs(); rsExtWait.state.status = "WAITING";
  markManagedRebootInterrupted(rsExtWait, "WAITING", false);
  assert(rsExtWait.logs.some((l) => l.text.includes("发送消息即可继续")), "拒续型 WAITING 同旧文案（无分叉）");
  // ---------- A3. rebootAutoResumable 谓词（对齐 reviveEligible 重放可判拒续轴） ----------
  console.log("A3 谓词单口（rebootAutoResumable）:")
  const predOk = rebootAutoResumable({ relay_session_id: "sdk-x", updated_at: Date.now() });
  assert(predOk === true, "托管+锚+新鲜→可续（打标+承诺）");
  assert(rebootAutoResumable({ external: true, relay_session_id: "sdk-x", updated_at: Date.now() }) === false, "external→拒续轴（reviveEligible external 闸对齐）");
  assert(rebootAutoResumable({ updated_at: Date.now() }) === false, "无 relay_session_id→拒续轴（no-resume-anchor 对齐）");
  assert(rebootAutoResumable({ org_parked: "pg-x", relay_session_id: "sdk-x", updated_at: Date.now() }) === false, "org_parked→拒续轴（组挂起=编制退休释放）");
  assert(rebootAutoResumable({ pinned: true, saved: true, relay_session_id: "sdk-x", updated_at: Date.now() }) === false, "pinned&&saved→拒续轴（pinned-dormant；Leader 豁免在 #PMRESUME 先行清标）");
  assert(rebootAutoResumable({ relay_session_id: "sdk-x", updated_at: Date.now() - 49 * 3_600_000 }) === false, "48h 陈→拒续轴（stale-48h）");
  assert(rebootAutoResumable({ relay_session_id: "thread-x", updated_at: Date.now(), engine: "codex" }) === false, "codex→拒续轴（R2-P2-2 codex-idle：boot 链对中断标 DONE 态 codex 恒拒——诺了必落空）");
  assert(rebootAutoResumable({ relay_session_id: "sdk-x", updated_at: Date.now(), engine: "claude" }) === true, "claude 引擎不受 codex 轴影响（仍可续）");
  assert(rebootAutoResumable({ pinned: true, relay_session_id: "sdk-x", updated_at: Date.now() }) === true, "pinned 未休眠（无 saved）→可续（pinned-dormant 只锁双条件）");
  // ---------- A4. 重放集成：收养型外部身份还原（根缺口——用户实锤路径全链） ----------
  console.log("A4 重放集成（reduceHistory 收养型 external 还原+分类落位）:")
  const now = Date.now();
  const sidExt = "adopted-ext-0001";
  const envs = [
    { session_id: sidExt, ts: now - 6e5, type: "SESSION_CREATED", payload: { cwd: "/Users/u/dev/x", initial_prompt: "外部 CLI 首条", model: "m" } }, // CREATED 无 external（收养形态/旧版写入）
    { session_id: sidExt, ts: now - 5e5, type: "SESSION_UPDATED", payload: { status: "WORKING", action_summary: "外部在跑", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, external: true, relay_session_id: "sdk-ext-1", updated_at: now - 5e5 } }, // 身份随 UPDATED 帧（MERGE_KEYS 广播面）
  ] as unknown as import("../src/types.js").Envelope[];
  const replayed = reduceHistory(envs);
  const rsA = replayed.get(sidExt);
  assert(!!rsA && rsA.state.external === true, "重放应用 SESSION_UPDATED.external=true（收养型身份还原——根缺口闭合）");
  assert(!!rsA && rsA.state.pre_reboot_status === undefined, "收养型外部 WORKING 中断不打标（boot 链不空试）");
  assert(!!rsA && rsA.logs.some((l) => l.text.includes("发送消息即可继续")) && !rsA.logs.some((l) => l.text.includes("自动续跑")), "收养型外部中断文案=发送消息即可继续（用户实锤案例路径全链修）");
  const sidManaged = "managed-sdk-0002";
  const envs2 = [
    { session_id: sidManaged, ts: now - 6e5, type: "SESSION_CREATED", payload: { cwd: "/Users/u/dev/x", initial_prompt: "托管首条", model: "m" } },
    { session_id: sidManaged, ts: now - 5e5, type: "SESSION_UPDATED", payload: { status: "WORKING", action_summary: "托管在跑", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, relay_session_id: "sdk-managed-1", updated_at: now - 5e5 } },
  ] as unknown as import("../src/types.js").Envelope[];
  const rsM = reduceHistory(envs2).get(sidManaged);
  assert(!!rsM && rsM.state.pre_reboot_status === "WORKING" && rsM.logs.some((l) => l.text.includes("自动续跑")), "托管 SDK WORKING 零变化（仍打标+诺续——回归钉死）");
  // [W-REBOOTTXT R2-P3/P1-B] 真实帧形态两态钉死：①UPDATED 带 external=R2 后 emitUpdated
  // 真形态（上方 sidExt 已断言）；②坏帧存量另一态=CREATED 带 external（UPDATED 无）——
  // CREATED 侧还原同样生效；③全缺形态（CREATED/UPDATED 均无 external 的远古流）=重放
  // 不可判，诺续照旧（存量诚实缺口如实钉死，非新回归——遗留清单在案）
  const sidExtC = "created-ext-0003";
  const envsC = [
    { session_id: sidExtC, ts: now - 6e5, type: "SESSION_CREATED", payload: { cwd: "/Users/u/dev/x", initial_prompt: "外部建卡", model: "m", external: true } },
    { session_id: sidExtC, ts: now - 5e5, type: "SESSION_UPDATED", payload: { status: "WORKING", action_summary: "外跑", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, relay_session_id: "sdk-extc-1", updated_at: now - 5e5 } },
  ] as unknown as import("../src/types.js").Envelope[];
  const rsC = reduceHistory(envsC).get(sidExtC);
  assert(!!rsC && rsC.state.external === true && rsC.state.pre_reboot_status === undefined, "坏帧存量·CREATED 带 external：身份还原+不诺续（验收点①形态B）");
  const sidGhost = "ghost-managed-0004";
  const envsG = [
    { session_id: sidGhost, ts: now - 6e5, type: "SESSION_CREATED", payload: { cwd: "/Users/u/dev/x", initial_prompt: "远古流", model: "m" } },
    { session_id: sidGhost, ts: now - 5e5, type: "SESSION_UPDATED", payload: { status: "WORKING", action_summary: "远古", stats: { files_changed: 0, lines_added: 0, lines_deleted: 0 }, relay_session_id: "sdk-ghost-1", updated_at: now - 5e5 } },
  ] as unknown as import("../src/types.js").Envelope[];
  const rsG = reduceHistory(envsG).get(sidGhost);
  assert(!!rsG && rsG.state.external !== true && rsG.state.pre_reboot_status === "WORKING" && rsG.logs.some((l) => l.text.includes("自动续跑")), "全缺形态（两帧均无 external 的远古流）：重放不可判→诺续照旧（存量诚实缺口如实钉死——P1-B 只修「帧在流里」的存量与全部增量）");

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

    // [W-REBOOTTXT R2-P1-B] 真帧形态直证：活 mgr 增量帧载荷恒带 external 布尔（重放面
    // 生效的发射侧前提——A4 族用的是手工帧，此处验 emitUpdated 真产物）
    const liveFrames: { sid: string; payload: Record<string, unknown> }[] = [];
    bus.subscribe((env: { type: string; session_id?: string; payload?: unknown }) => {
      if (env.type === "SESSION_UPDATED" && env.session_id === dp.session_id) liveFrames.push({ sid: env.session_id!, payload: env.payload as Record<string, unknown> });
    });
    (mgr as any).emitUpdated?.(s, true);
    assert(liveFrames.length >= 1 && liveFrames[liveFrames.length - 1].payload.external === false, "活帧 SESSION_UPDATED.external 恒带布尔（托管=false 真形态——R2-P1-B 发射侧钉死）");

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
