// #26 矩阵式 M2 —— 分诊引擎集成测试（agentFactory 测试缝，不拉真 CLI）。
// 覆盖：D1 随手办派单（纪律模板/bypassPermissions[F-10]/sticky 豁免/先落账再执行）
//       D1b 回执拼入「结果：」行（F-02）D2 派单收口（done/failed + 板联动退回待办）
//       D3 立项确认门槛与信任累积 D4 升降级/建议暂缓/结项核对（一句话归档 vs 确认卡）
//       D5 状态护栏 D6 断档补记（dispatched/running 悬账）D7 handleCommand 确认决议/详情拉取
//       D14 resume 挂死自愈（F-07：fresh 重放/ERROR+saved/STOP·删除·合并窗口/usage 记忆）
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager, wrapDispatchPrompt } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { addMember, listGroups, listPendingConfirms, loadBoard, upsertBoardEntry } from "../src/projects.js";
import { routingFor } from "../src/routing.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { Command } from "../src/types.js";

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

// 假 agent 工厂：init 模式 20ms 后 onInit（permissionMode 按工厂入参回报）；prompt
// 会话再 10ms 后 onTurnEnd(okMode)。okNext 控制下一次 spawn 的回合成败（failed 收口用）。
// stopNoop（D11 补刀用例）：stop() 计数但不落 ended/不回 onSessionEnd——模拟
// resumePending 窗口内 stop 落空（孤儿 CLI 没被杀掉）。
let okNext = true;
let stopNoop = false;
// 冲刺 F-02：非空时 fake agent 在 onTurnEnd 前回一条带「结果：」末行的 assistant
// 消息（模拟 worker 纪律模板回执），验台账 receipt 拼入该行
let emitResultLine: string | null = null;
// 冲刺 F-07：true 时 resume 形态的 spawn 静默挂死（不 init/不报错/不退出——上游
// CLI 对悬空 transcript 的实锤行为），验 init 超时回退 fresh spawn
let hangResume = false;
const stopCalls: string[] = [];
type SpawnRec = { cwd: string; prompt: string | undefined; cb: AgentCallbacks; agent: AgentLike; resume?: string; configHome?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; resume?: string; configHome?: string }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => {
        if (stopNoop) { stopCalls.push(a.id); return; }
        a.ended = true; cb.onSessionEnd("stopped");
      },
      setPermissionMode: async () => {},
    };
    created.push({ cwd, prompt, cb, agent: a, resume: opts?.resume, configHome: opts?.configHome });
    const ok = okNext;
    if (hangResume && opts?.resume) return a; // F-07：挂死流——零回调零退出
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, opts?.permissionMode ?? "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        if (emitResultLine) cb.onLog("assistant_text", `分析并动手改了。\n${emitResultLine}`, {});
        cb.onTurnEnd(ok, ok ? "success" : "error exit 1", 12);
      }, 10);
    }, 20);
    return a;
  };

const readJson = (p: string): unknown => {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
};

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-disp-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-disp-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  const prevInitMs = process.env.CCR_RESUME_INIT_MS; // 提到 try 外：finally 恢复用（审查修正）
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8793, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const stickySentinel = mkdtempSync(join(tmpdir(), "ccr-sentinel-"));
    writeFileSync(join(DATA, "last-cwd"), stickySentinel, "utf-8");
    cfg.defaultCwd = stickySentinel;

    const created: SpawnRec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    // D12：看门狗动作面观察缝（WATCHDOG 事件采集，验 recover_abandon 真发出）
    const wdActions: { sid: string; action: string }[] = [];
    // #40 M4：派单完成回调观察缝（DISPATCH_DONE 瞬态帧采集——缝必须在 D1 之前埋好，
    // 帧是 seq:0 直播不落盘，晚订阅收不到历史）
    const doneFrames: { dispatch_id: string; status: string; payload: Record<string, unknown> }[] = [];
    bus.subscribe((env) => {
      if (env.type === "WATCHDOG") wdActions.push({ sid: env.session_id, action: String((env.payload as { action?: string }).action ?? "") });
      if (env.type === "DISPATCH_DONE") {
        const p = env.payload as Record<string, unknown>;
        doneFrames.push({ dispatch_id: String(p.dispatch_id ?? ""), status: String(p.status ?? ""), payload: p });
      }
    });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE" && s.done_reason === "success") !== undefined);
    assert(readFileSync(join(DATA, "last-cwd"), "utf-8") === stickySentinel, "基线：last-cwd 未被 org 污染");

    // ---------- D1 随手办派单 ----------
    console.log("D1 随手办派单:");
    // 冲刺 F-04：派单 = 干活语义，幽灵锚一律拒（不再 autoMkdir 静默跑单）
    const ghost = join(DATA, "proj-ghost");
    const dg = mgr.orgAction("dispatch", { anchor: ghost, prompt: "试探" }) as { ok: boolean; error?: string };
    assert(dg.ok === false && (dg.error ?? "").includes("锚目录不存在"), "幽灵锚拒派（可读报错，F-04）");
    assert(!existsSync(ghost), "拒绝后不留幽灵目录（无副作用）");
    const anchor = join(DATA, "proj-x");
    mkdirSync(anchor, { recursive: true });
    // 审查修正补锁：锚是文件 → 三态可读报错（不再统一说「不存在」）
    const fileAnchor = join(DATA, "anchor-as-file.txt");
    writeFileSync(fileAnchor, "x", "utf-8");
    const df = mgr.orgAction("dispatch", { anchor: fileAnchor, prompt: "试探" }) as { ok: boolean; error?: string };
    assert(df.ok === false && (df.error ?? "").includes("不是目录"), "锚是文件 → 报错指明「不是目录」（三态区分）");
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "把 README 的错别字改掉" }) as { ok: boolean; dispatch_id?: string; session_id?: string; error?: string };
    assert(d1.ok === true, "派单成功（锚目录存在）");
    const wid1 = d1.ok ? (d1 as { session_id: string }).session_id : "";
    const did1 = d1.ok ? (d1 as { dispatch_id: string }).dispatch_id : "";
    const rec1 = created.find((c) => c !== created[0] && c.prompt?.startsWith("[随手办 派单]"));
    assert(!!rec1 && rec1.cwd === anchor, "spawn 携纪律模板 + cwd 锚项目");
    assert(!!rec1 && rec1.prompt === wrapDispatchPrompt("随手办", "把 README 的错别字改掉"), "模板全文一致（wrapDispatchPrompt）");
    assert(await waitFor(() => mgr.snapshot().find((s) => s.session_id === wid1)?.permission_mode === "bypassPermissions"), "权限 bypassPermissions（冲刺 F-10：无人值守派单，CLI 层审批=派单黑洞，纪律约束在 prompt/台账侧）");
    const w1 = mgr.snapshot().find((s) => s.session_id === wid1);
    assert(w1?.dispatch_tier === "随手办", "会话态档位=随手办");
    assert(w1?.project_gid === undefined, "随手办无组归属");
    assert(readFileSync(join(DATA, "last-cwd"), "utf-8") === stickySentinel, "派单不污染 sticky 默认目录（skipStickyCwd）");
    // 先落账再执行：readDispatchLog 按 id 收敛（同 id 留最后），原始序读 ndjson 验证
    const raw1 = readFileSync(join(ORG, "dispatch-log.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; status: string; project_anchor?: string });
    const rows1 = raw1.filter((e) => e.id === did1);
    assert(rows1.length >= 2 && rows1[0]?.status === "dispatched" && rows1[1]?.status === "running", "先落账再执行（dispatched → running 同 id 原始序）");
    assert(readDispatchLog().find((e) => e.id === did1)?.project_anchor === anchor, "台账带项目锚点（§2.5 分流数据源；收敛视图）");

    // ---------- D1b 回执可读性（冲刺 F-02） ----------
    console.log("D1b 回执可读性（F-02）:");
    // 先等 D1 的回合真收口再开 emitResultLine——fake 回合是 30ms 异步，开着开关
    // 派新单会把开关泄漏进上一单的 turn-end（wid1 被误写 assistant 日志，D8 前置被污染）
    assert(await waitFor(() => readDispatchLog().filter((e) => e.id === did1).some((e) => e.status === "done")), "D1 回合先收口（前置）");
    emitResultLine = "结果：错别字已改｜改动文件：README.md";
    const d1b = mgr.orgAction("dispatch", { anchor, prompt: "再改一处" }) as { ok: boolean; dispatch_id?: string };
    const did1b = d1b.ok ? (d1b as { dispatch_id: string }).dispatch_id : "";
    assert(await waitFor(() => readDispatchLog().filter((e) => e.id === did1b).some((e) => e.status === "done")), "回合收口 done");
    emitResultLine = null; // fake 回调是异步 setTimeout——收口后再关，避免回合内被清
    const rc1b = readDispatchLog().filter((e) => e.id === did1b).find((e) => e.status === "done");
    assert((rc1b?.receipt ?? "").includes("结果：错别字已改｜改动文件：README.md"), "回执拼入「结果：」行（§3.5 回执语义落到台账字段）");
    assert((rc1b?.receipt ?? "").startsWith("success"), "回执保留 terminal_reason 前缀（写实）");

    // ---------- D2 派单收口 ----------
    console.log("D2 派单收口:");
    assert(await waitFor(() => readDispatchLog().filter((e) => e.id === did1).some((e) => e.status === "done")), "worker 回合 done → 台账收口");
    const closeRow = readDispatchLog().filter((e) => e.id === did1).find((e) => e.status === "done");
    assert(!!closeRow && closeRow.tier === "随手办" && closeRow.session_id === wid1 && closeRow.target === wid1, "收口行 tier/session/target 写实");
    // failed 路径：项目组派单 + 失败 → 板退回 todo
    const c2 = mgr.orgAction("project-create", { name: "alpha", anchor: join(DATA, "proj-a"), tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(c2.ok === true && c2.data?.needsConfirm === true, "首次轻立项 → 确认卡（信任未累积）");
    const gidA = c2.data?.group?.id ?? "";
    const cfA = c2.data?.confirm?.id ?? "";
    const dec1 = mgr.orgAction("confirm-decide", { confirm_id: cfA, approve: true, by: "u" });
    assert(dec1.ok === true && listGroups().find((g) => g.id === gidA)?.status === "active", "用户 ✓ → active（决议副作用）");
    okNext = false;
    const d2 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-a"), prompt: "加个按钮", gid: gidA, title: "按钮任务" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    const did2 = d2.ok ? (d2 as { dispatch_id: string }).dispatch_id : "";
    const wid2 = d2.ok ? (d2 as { session_id: string }).session_id : "";
    const w2 = mgr.snapshot().find((s) => s.session_id === wid2);
    assert(w2?.project_gid === gidA && w2?.dispatch_tier === "轻立项", "组派单会话态带归属+组档位");
    // 冲刺 F-05 补锁：派单 title 双写内存态（此前只落盘，重启前后列表标题劈叉）
    assert(w2?.title === "[轻立项] 按钮任务", "派单 title 即时进会话运行态（F-05，含档位前缀，无需重启）");
    assert((listGroups().find((g) => g.id === gidA)?.headcount ?? []).some((h) => h.session_id === wid2), "worker 入编（headcount）");
    assert(loadBoard(gidA).entries.some((e) => e.dispatch_id === did2 && e.status === "doing"), "板联动：承接条目 doing");
    assert(await waitFor(() => readDispatchLog().filter((e) => e.id === did2).some((e) => e.status === "failed")), "失败回合 → 台账 failed");
    assert(loadBoard(gidA).entries.find((e) => e.dispatch_id === did2)?.status === "todo", "板联动：failed 退回 todo");
    okNext = true;

    // ---------- D3 确认门槛与信任累积 ----------
    console.log("D3 确认门槛:");
    const c3 = mgr.orgAction("project-create", { name: "beta", anchor: join(DATA, "proj-b"), tier: "轻立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; group?: { id: string; status: string } } };
    assert(c3.ok === true && c3.data?.needsConfirm === false && c3.data?.group?.status === "active", "信任已累积 → 轻立项直达 active（同类免确认）");
    const c4 = mgr.orgAction("project-create", { name: "gamma", anchor: join(DATA, "proj-g"), tier: "正经立项" }) as { ok: boolean; data?: { needsConfirm?: boolean; confirm?: { id: string } } };
    assert(c4.ok === true && c4.data?.needsConfirm === true, "正经立项不受信任影响（每次必确认）");
    const bypass = mgr.orgAction("project-status", { id: "gamma", to: "active" });
    assert(bypass.ok === false, "pending 不可 set 旁路（确认门槛只经确认卡决议）");
    const cfG = c4.data?.confirm?.id ?? "";
    const rej = mgr.orgAction("confirm-decide", { confirm_id: cfG, approve: false, by: "u" });
    assert(rej.ok === true && listGroups().find((g) => g.name === "gamma")?.status === "archived", "否决 → archived 留痕");
    const badCreate = mgr.orgAction("project-create", { name: "x", anchor: "relative/path", tier: "轻立项" });
    assert(badCreate.ok === false, "相对路径 anchor 拒绝");
    const clash = mgr.orgAction("project-create", { name: "y", anchor: join(DATA, "proj-a"), tier: "正经立项" });
    assert(clash.ok === false, "锚点被占拒绝（一锚一组）");

    // ---------- D4 升降级/建议暂缓/结项 ----------
    console.log("D4 升降级/暂缓/结项:");
    const t1 = mgr.orgAction("project-tier", { id: gidA, to: "正经立项", reason: "范围扩大要上验收单" }) as { ok: boolean; data?: { confirm?: { id: string } } };
    assert(t1.ok === true && !!t1.data?.confirm, "升级 → 确认卡（一句理由入单）");
    mgr.orgAction("confirm-decide", { confirm_id: t1.data?.confirm?.id ?? "", approve: true, by: "u" });
    assert(listGroups().find((g) => g.id === gidA)?.tier === "正经立项", "✓ → 档位迁移（只补不重建）");
    const h1 = mgr.orgAction("suggest-hold", { id: gidA, reason: "依赖的 SDK 未发版", condition: "SDK 1.2 正式发布" }) as { ok: boolean; data?: { confirm?: { id: string } } };
    assert(h1.ok === true && !!h1.data?.confirm, "建议暂缓 → 确认卡（点头即挂起）");
    mgr.orgAction("confirm-decide", { confirm_id: h1.data?.confirm?.id ?? "", approve: true, by: "u" });
    const gA2 = listGroups().find((g) => g.id === gidA);
    assert(gA2?.status === "parked" && loadBoard(gidA).frozen === true, "✓ → 挂起 + 板冻结");
    const noGid = mgr.orgAction("suggest-hold", { reason: "等用户补充需求" }) as { ok: boolean; data?: { ledgered?: boolean } };
    assert(noGid.ok === true && noGid.data?.ledgered === true, "无组暂缓 → 纯台账留痕");
    assert(readDispatchLog().some((e) => e.tier === "暂缓" && e.status === "done"), "暂缓台账行落账");
    const frozenDispatch = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-a"), prompt: "偷偷干活", gid: gidA });
    assert(frozenDispatch.ok === false, "挂起组拒派单（冻结）");
    // 复活（用户明示直达）→ 在办
    const rv = mgr.orgAction("project-status", { id: gidA, to: "active" });
    assert(rv.ok === true && loadBoard(gidA).frozen === false, "复活直达（不走确认单）+ 板解冻");
    // 结项：板有未完 → 确认卡附清单；清完 → 一句话归档
    const arc1 = mgr.orgAction("project-status", { id: gidA, to: "archived" }) as { ok: boolean; data?: { needsConfirm?: boolean; checklist?: { openBoardEntries: number }; confirm?: { id: string } } };
    assert(arc1.ok === true && arc1.data?.needsConfirm === true && arc1.data?.checklist?.openBoardEntries === 1, "有未完条目 → 结项确认卡附核对清单");
    mgr.orgAction("confirm-decide", { confirm_id: arc1.data?.confirm?.id ?? "", approve: true, by: "u" });
    assert(listGroups().find((g) => g.id === gidA)?.status === "archived", "✓ → 结项（单向终态）");
    const gidB = (listGroups().find((g) => g.name === "beta") as { id: string }).id;
    const arc2 = mgr.orgAction("project-status", { id: gidB, to: "archived" }) as { ok: boolean; data?: { archived?: boolean; needsConfirm?: boolean } };
    assert(arc2.ok === true && arc2.data?.archived === true && !arc2.data?.needsConfirm, "零悬账零未完 → 一句话归档（无确认卡）");
    const arcBoard = mgr.orgAction("board", { op: "upsert", gid: gidB, text: "结项后写入" });
    assert(arcBoard.ok === false, "结项板只读");

    // ---------- D5 板操作 ----------
    console.log("D5 板操作:");
    const gidC = (listGroups().find((g) => g.name === "beta") as { id: string }).id; // 已归档，另建新组验板
    const c5 = mgr.orgAction("project-create", { name: "delta", anchor: join(DATA, "proj-d"), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string } } };
    const gidD = listGroups().find((g) => g.name === "delta")?.id ?? "";
    mgr.orgAction("confirm-decide", { confirm_id: c5.data?.confirm?.id ?? "", approve: true, by: "u" });
    const b1 = mgr.orgAction("board", { op: "upsert", gid: gidD, text: "任务甲" }) as { ok: boolean; data?: { entry?: { id: string; status: string } } };
    assert(b1.ok === true && b1.data?.entry?.status === "todo", "板 upsert 默认 todo");
    const eid = b1.data?.entry?.id ?? "";
    const b2 = mgr.orgAction("board", { op: "move", gid: gidD, entry_id: eid, status: "done" });
    assert(b2.ok === true && loadBoard(gidD).entries[0]?.status === "done", "板 move");
    const b3 = mgr.orgAction("board", { op: "del", gid: gidD, entry_id: eid });
    assert(b3.ok === true && loadBoard(gidD).entries.length === 0, "板 del");
    const b4 = mgr.orgAction("board", { op: "move", gid: gidC, entry_id: "nope", status: "todo" });
    assert(b4.ok === false, "未知操作/归档板拒绝");
    // 冲刺 F-03 补锁：gid 直调不带 anchor 亦可（anchor 校验移到 gid 解析后，
    // gid 派单用组锚）——台账 project_anchor 落组锚
    const e0 = mgr.orgAction("dispatch", { prompt: "gid 直调（无 anchor，F-03）", gid: gidD }) as { ok: boolean; dispatch_id?: string; error?: string };
    assert(e0.ok === true, "gid 派单不带 anchor 可派（F-03）");
    const didE0 = e0.ok ? (e0 as { dispatch_id: string }).dispatch_id : "";
    assert((readDispatchLog().find((e) => e.id === didE0)?.project_anchor ?? "") === join(DATA, "proj-d"), "gid 派单台账锚=组锚（F-03）");
    assert(await waitFor(() => readDispatchLog().filter((e) => e.id === didE0).some((e) => e.status === "done")), "F-03 直调单收口（板联动 done 收尾，无悬账留给结项核对）");

    // ---------- D6 断档补记 ----------
    console.log("D6 断档补记:");
    // 模拟上一进程崩在派单窗口（dispatched 未收 running）与回合中（running 未收口）
    const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org-disp2-"));
    const DATA2 = mkdtempSync(join(tmpdir(), "ccr-data-disp2-"));
    const prevOrg2 = process.env.CCR_ORG_DIR;
    process.env.CCR_ORG_DIR = ORG2;
    writeFileSync(join(ORG2, "dispatch-log.ndjson"),
      JSON.stringify({ ts: 1, id: "dsp-win", tier: "随手办", target: "spawn-pending", status: "dispatched", session_id: "", project_anchor: "/tmp/p" }) + "\n" +
      JSON.stringify({ ts: 2, id: "dsp-run", tier: "咨询", target: "org-leader", status: "running", session_id: "s-old" }) + "\n" +
      JSON.stringify({ ts: 3, id: "dsp-gid", tier: "正经立项", target: "s-old", status: "running", session_id: "s-old", project_anchor: "/tmp/anchor-x" }) + "\n", "utf-8");
    // D6b 豁免面上锁（#7 加固轮）：gid 悬账配套路由表/板条目预先在盘——断档补记
    // 走 appendDispatch 直写、不经 closeOpenDispatches → 不写路由表（relay 重启不是
    // worker 的账）。冲刺 F-08（G1 实测校准）：板条按中断口径退 todo——原「仍归原
    // 会话等续跑收口」不成立（续跑回合不走派单 FIFO，无钩子搬 done → orphan doing
    // 永挂）；auto-revive 续跑真交付了由 Leader/用户目测搬 done。
    writeFileSync(join(ORG2, "projects.json"), JSON.stringify({
      groups: [{ id: "g-x", name: "断档组", anchor_dir: "/tmp/anchor-x", status: "active", tier: "正经立项",
        headcount: [{ session_id: "s-old", role: "worker" }], single_card: false, created_at: 1, updated_at: 1 }],
      trust_light: false,
    }), "utf-8");
    mkdirSync(join(ORG2, "boards"), { recursive: true });
    writeFileSync(join(ORG2, "boards", "g-x.json"), JSON.stringify({
      entries: [{ id: "e-x", text: "断档在跑", status: "doing", dispatch_id: "dsp-gid" }],
      frozen: false,
    }), "utf-8");
    writeFileSync(join(ORG2, "routing.json"), JSON.stringify({
      entries: [{ gid: "g-x", session_id: "s-old", count: 3, failed: 0, last_ts: 1, tags: [] }],
    }), "utf-8");
    const cfg2: RelayConfig = { ...cfg, dataDir: DATA2 };
    const mgr2 = new SessionManager(new EventBus({ persistPath: join(DATA2, "events.ndjson") }), cfg2);
    mgr2.setAgentFactory(makeFakeFactory([]));
    const r2 = mgr2.ensureLeader();
    assert(r2.ok === true, "重启就绪");
    const log2 = readDispatchLog();
    assert(log2.filter((e) => e.id === "dsp-win").some((e) => e.status === "done"), "dispatched 悬账 → 补记 done");
    assert(log2.filter((e) => e.id === "dsp-run").some((e) => e.status === "done"), "running 悬账 → 补记 done");
    const rej2 = log2.filter((e) => e.id === "dsp-run").find((e) => e.status === "done");
    assert(rej2?.receipt === "relay 重启，回合中断", "补记回执语义");
    assert(log2.filter((e) => e.id === "dsp-gid").some((e) => e.status === "done"), "gid 悬账同样补记 done");
    assert((routingFor("g-x").find((x) => x.session_id === "s-old")?.count ?? -1) === 3, "断档补记不写路由表（count 不动）");
    assert(loadBoard("g-x").entries[0]?.status === "todo", "断档补记板条退 todo（F-08 中断口径——活没交付不能停 doing）");
    process.env.CCR_ORG_DIR = prevOrg2 ?? ORG;
    rmSync(ORG2, { recursive: true, force: true });
    rmSync(DATA2, { recursive: true, force: true });

    // ---------- D7 handleCommand 通道 ----------
    console.log("D7 客户端命令:");
    const cd = mgr.orgAction("project-create", { name: "eps", anchor: join(DATA, "proj-e"), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
    const gidE = cd.data?.group?.id ?? "";
    const cfE = cd.data?.confirm?.id ?? "";
    const ack1 = mgr.handleCommand({ command_id: "cmd-1", type: "COMMAND_ORG_CONFIRM", ts: Date.now(), payload: { confirm_id: cfE, approve: true } } as Command, "web-1");
    assert(ack1.ok === true && listGroups().find((g) => g.id === gidE)?.status === "active", "COMMAND_ORG_CONFIRM ✓ 生效");
    const ack2 = mgr.handleCommand({ command_id: "cmd-2", type: "COMMAND_PROJECT_DETAIL", ts: Date.now(), payload: { gid: gidE } } as Command, "web-1");
    const det = ack2.data as { group?: { id: string }; board?: { entries: unknown[] }; receipts?: unknown[] } | undefined;
    assert(ack2.ok === true && det?.group?.id === gidE && Array.isArray(det?.board?.entries) && Array.isArray(det?.receipts), "COMMAND_PROJECT_DETAIL 返回编制/板/回执流");
    const ack3 = mgr.handleCommand({ command_id: "cmd-3", type: "COMMAND_PROJECT_DETAIL", ts: Date.now(), payload: { gid: "nope" } } as Command, "web-1");
    assert(ack3.ok === false, "未知组详情 → ok:false");

    // ---------- D8 M3 熟手查表调度（§5 双来源） ----------
    console.log("D8 熟手查表调度:");
    // eps 组（D7）active 且无派单记录：首单必走记忆亲和新会话
    const e1 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-e"), prompt: "eps 第一单", gid: gidE }) as { ok: boolean; session_id?: string; dispatch_id?: string };
    const wE1 = e1.session_id ?? "";
    assert(e1.ok === true && !!wE1, "首单（路由表空）→ 新会话承接");
    assert(await waitFor(() => (routingFor(gidE).find((x) => x.session_id === wE1)?.count ?? 0) === 1), "首单 done → 路由表 count=1");
    // 第二单：W1 空闲熟手 → resume（会话亲和）——session_id 不变、不产新会话
    const before2 = mgr.snapshot().length;
    const created2 = created.length;
    const e2 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-e"), prompt: "eps 第二单", gid: gidE }) as { ok: boolean; session_id?: string; dispatch_id?: string };
    assert(e2.ok === true && e2.session_id === wE1, "空闲熟手 → resume 原会话（session_id 复用）");
    assert(mgr.snapshot().length === before2, "未新增会话（会话亲和，非新拉）");
    assert(created.length === created2 + 1, "resume 也走工厂（换流），但归属同一 relay 会话");
    const rawE2 = readFileSync(join(ORG, "dispatch-log.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; status: string; target: string });
    assert(rawE2.filter((x) => x.id === e2.dispatch_id)[0]?.target === wE1, "dispatched 行直指熟手（非 spawn-pending）");
    assert(await waitFor(() => (routingFor(gidE).find((x) => x.session_id === wE1)?.count ?? 0) === 2), "熟手再收口 → count=2");
    assert((listGroups().find((g) => g.id === gidE)?.headcount ?? []).filter((h) => h.session_id === wE1).length === 1, "重复派单 headcount 不重复入编（幂等）");

    // 忙 → 次优/新会话：W1 置 WORKING → 第三单拉新 W2
    const internals = mgr as unknown as { sessions: Map<string, { state: { status: string; relay_session_id?: string } }> };
    internals.sessions.get(wE1)!.state.status = "WORKING";
    const e3 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-e"), prompt: "eps 第三单", gid: gidE }) as { ok: boolean; session_id?: string };
    const wE2 = e3.session_id ?? "";
    assert(e3.ok === true && !!wE2 && wE2 !== wE1, "熟手在忙 → 新会话（排队不做，活不过夜）");
    assert(await waitFor(() => (routingFor(gidE).find((x) => x.session_id === wE2)?.count ?? 0) === 1), "W2 done → count=1（次序 W1=2 > W2=1）");
    // W1 仍忙、W2 空闲 → 第四单 resume W2（次优熟手）
    const e4 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-e"), prompt: "eps 第四单", gid: gidE }) as { ok: boolean; session_id?: string };
    assert(e4.ok === true && e4.session_id === wE2, "首选忙 → 次优熟手 W2 resume");
    assert(await waitFor(() => (routingFor(gidE).find((x) => x.session_id === wE2)?.count ?? 0) === 2), "W2 再收口 → count=2");

    // 搞砸 → 避开：W2 评 bad → 第五单（W1 忙）跳过 W2 → 新会话 W3
    const rt = mgr.orgAction("rate", { gid: gidE, sid: wE2, rating: "bad" });
    assert(rt.ok === true, "org rate bad 落账");
    const e5 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-e"), prompt: "eps 第五单", gid: gidE }) as { ok: boolean; session_id?: string };
    const wE3 = e5.session_id ?? "";
    assert(e5.ok === true && !!wE3 && wE3 !== wE1 && wE3 !== wE2, "bad 评价熟手被避开 → 新会话");
    assert(await waitFor(() => (routingFor(gidE).find((x) => x.session_id === wE3)?.count ?? 0) === 1), "W3 done → count=1");
    // 退休形态：W1 会话不在册（只剩路由表记录）→ 档案位跳过；W2 bad；W3 空闲 → resume W3
    internals.sessions.delete(wE1);
    const e6 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-e"), prompt: "eps 第六单", gid: gidE }) as { ok: boolean; session_id?: string };
    assert(e6.ok === true && e6.session_id === wE3, "退休记录跳过 + bad 跳过 → resume 唯一可用熟手 W3");
    // tag 通道顺手验（评鉴/标签 CLI 面）
    const tg = mgr.orgAction("tag", { gid: gidE, sid: wE3, tags: ["rust", "cli"] });
    assert(tg.ok === true && (routingFor(gidE).find((x) => x.session_id === wE3)?.tags ?? []).join(",") === "rust,cli", "org tag 标签落账");
    const rtMiss = mgr.orgAction("rate", { gid: gidE, sid: "no-such", rating: "good" });
    assert(rtMiss.ok === false, "无合作记录不可评");

    // ---------- D9 M3 两层联动 + 挂起自动化 ----------
    console.log("D9 两层联动/挂起自动化:");
    const cz = mgr.orgAction("project-create", { name: "zeta", anchor: join(DATA, "proj-z"), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
    const gidZ = cz.data?.group?.id ?? "";
    mgr.orgAction("confirm-decide", { confirm_id: cz.data?.confirm?.id ?? "", approve: true, by: "u" });
    const z1 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-z"), prompt: "zeta 第一单", gid: gidZ }) as { ok: boolean; session_id?: string };
    const wZ1 = z1.session_id ?? "";
    assert(z1.ok === true && !!wZ1, "zeta 首单承接");
    assert(await waitFor(() => (routingFor(gidZ).find((x) => x.session_id === wZ1)?.count ?? 0) === 1), "zeta 首单收口 count=1");
    // 在跑成员 + 悬账 → 组挂起：悬账收口（中断≠干砸，路由表无感）+ 会话休眠
    const hack = mgr as unknown as {
      sessions: Map<string, { state: { status: string; org_parked?: string; project_gid?: string; done_reason?: string; updated_at?: number }; agent: { ended: boolean } | null; streamGen: number }>;
      openDispatches: Map<string, { id: string; tier: string; gid?: string; anchor?: string }[]>;
    };
    hack.sessions.get(wZ1)!.state.status = "WORKING";
    hack.openDispatches.set(wZ1, [{ id: "dsp-z-inflight", tier: "正经立项", gid: gidZ, anchor: join(DATA, "proj-z") }]);
    const failedBefore = routingFor(gidZ).find((x) => x.session_id === wZ1)?.failed ?? 0;
    const pz = mgr.orgAction("project-status", { id: gidZ, to: "parked", note: "先放放" });
    assert(pz.ok === true && listGroups().find((g) => g.id === gidZ)?.status === "parked", "组挂起直达");
    assert(hack.sessions.get(wZ1)?.state.org_parked === gidZ, "成员会话两层联动：org_parked 落组 id");
    assert(hack.sessions.get(wZ1)?.state.status === "DONE", "挂起成员收口 DONE（退休进熟手池）");
    assert(readDispatchLog().some((e) => e.id === "dsp-z-inflight" && e.status === "failed" && e.receipt === "项目组挂起，回合中断"), "悬账收口：中断≠干砸（failed+写实回执）");
    assert((routingFor(gidZ).find((x) => x.session_id === wZ1)?.failed ?? 1) === failedBefore, "路由表不被挂起中断污染");
    const frz = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-z"), prompt: "冻结中偷活", gid: gidZ });
    assert(frz.ok === false, "挂起组拒派单（M2 护栏不回归）");
    // 复活：只清标记（零 eager spawn）+ 下次派单查表拉原班
    const rz = mgr.orgAction("project-status", { id: gidZ, to: "active" });
    assert(rz.ok === true && hack.sessions.get(wZ1)?.state.org_parked === undefined, "复活清成员 parked 标记");
    const z2 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-z"), prompt: "zeta 第二单", gid: gidZ }) as { ok: boolean; session_id?: string };
    assert(z2.ok === true && z2.session_id === wZ1, "复活后派单 → 路由表拉原班（resume 原会话）");
    assert(await waitFor(() => (routingFor(gidZ).find((x) => x.session_id === wZ1)?.count ?? 0) === 2), "原班再收口 count=2");

    // 挂起自动化：20 天无活动 → autoSuggestHold 出卡；幂等 + 否决冷却 + 开关
    //（用零活动新组验证——zeta 的板/台账/路由全是刚刚的活动，活度口径不会 stale）
    const DAY = 86_400_000;
    const co2 = mgr.orgAction("project-create", { name: "oldwork", anchor: join(DATA, "proj-old"), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
    const gidO2 = co2.data?.group?.id ?? "";
    mgr.orgAction("confirm-decide", { confirm_id: co2.data?.confirm?.id ?? "", approve: true, by: "u" });
    const backdate = (gid: string, days: number) => {
      const pf = JSON.parse(readFileSync(join(ORG, "projects.json"), "utf-8")) as { groups: { id: string; updated_at: number; hold_suggested_at?: number }[] };
      const g0 = pf.groups.find((x) => x.id === gid);
      if (g0) g0.updated_at = Date.now() - days * DAY;
      writeFileSync(join(ORG, "projects.json"), JSON.stringify(pf), "utf-8");
    };
    backdate(gidO2, 20);
    const scan1 = mgr.autoSuggestHold();
    assert(scan1.suggested.includes(gidO2), "20 天无活动 → 自动建议暂缓卡");
    const autoCf = listPendingConfirms().find((c) => c.kind === "suggest-hold" && c.payload.gid === gidO2);
    assert(!!autoCf && autoCf.payload.auto === true, "触发器卡带 auto 标（与手动建议可辨）");
    assert(!!listGroups().find((g) => g.id === gidO2)?.hold_suggested_at, "冷却戳落盘");
    const scan2 = mgr.autoSuggestHold();
    assert(!scan2.suggested.includes(gidO2) && scan2.skipped.includes(gidO2), "二次扫描不重提（待决卡+冷却）");
    // 否决 → 冷却：卡被否决后再扫仍不提
    mgr.orgAction("confirm-decide", { confirm_id: autoCf?.id ?? "", approve: false, by: "u" });
    const scan3 = mgr.autoSuggestHold();
    assert(!scan3.suggested.includes(gidO2), "否决后窗口期内不叨扰（hold_suggested_at 冷却）");
    // 冷却过期 → 再提
    const pf2 = JSON.parse(readFileSync(join(ORG, "projects.json"), "utf-8")) as { groups: { id: string; hold_suggested_at?: number }[] };
    pf2.groups.find((x) => x.id === gidO2)!.hold_suggested_at = Date.now() - 15 * DAY;
    writeFileSync(join(ORG, "projects.json"), JSON.stringify(pf2), "utf-8");
    const scan4 = mgr.autoSuggestHold();
    assert(scan4.suggested.includes(gidO2), "冷却过期 → 可再建议");
    mgr.orgAction("confirm-decide", { confirm_id: listPendingConfirms().find((c) => c.kind === "suggest-hold" && c.payload.gid === gidO2)?.id ?? "", approve: false, by: "u" });
    // 开关：CCR_ORG_STALE_DAYS=0 关触发器
    const prevStale = process.env.CCR_ORG_STALE_DAYS;
    process.env.CCR_ORG_STALE_DAYS = "0";
    const scan5 = mgr.autoSuggestHold();
    assert(scan5.suggested.length === 0, "CCR_ORG_STALE_DAYS=0 触发器关闭");
    if (prevStale === undefined) delete process.env.CCR_ORG_STALE_DAYS; else process.env.CCR_ORG_STALE_DAYS = prevStale;

    // ---------- D10 M3 审查修正（多 Agent 分工审查轮） ----------
    console.log("D10 审查修正（跨组正交/中断口径/编制解散/挂起防误触）:");
    const cbFor = (cwd: string): AgentCallbacks | undefined =>
      [...created].reverse().find((c) => c.cwd === cwd)?.cb;
    const projZ = join(DATA, "proj-z");

    // a) 跨组正交：同一熟手为 B 组（eps）在跑，A 组（zeta）挂起 → 只收 A 的账，
    //    会话不退休不杀流（矩阵式「项目×熟手」正交）
    hack.sessions.get(wZ1)!.state.status = "WORKING";
    hack.openDispatches.set(wZ1, [{ id: "dsp-E-inflight", tier: "正经立项", gid: gidE, anchor: join(DATA, "proj-e") }]);
    const pz2 = mgr.orgAction("project-status", { id: gidZ, to: "parked", note: "再放放" });
    assert(pz2.ok === true, "zeta 二次挂起");
    assert((hack.openDispatches.get(wZ1) ?? []).some((x) => x.id === "dsp-E-inflight"), "B 组派单不随 A 组挂起陪葬（FIFO 保留）");
    assert(!readDispatchLog().some((e) => e.id === "dsp-E-inflight"), "B 组悬账未被误收口");
    assert(hack.sessions.get(wZ1)?.state.org_parked === undefined, "他组在忙成员不打挂起标记（没随本组休眠）");
    assert(hack.sessions.get(wZ1)?.state.status === "WORKING", "他组在忙成员不退休不停流");
    // B 组回合自然收口：路由表分开记（wZ1 × eps 首次入账）
    cbFor(projZ)!.onTurnEnd(true, "success", 5);
    assert(!hack.openDispatches.has(wZ1), "B 组回合收口后 FIFO 清空");
    assert((routingFor(gidE).find((x) => x.session_id === wZ1)?.count ?? 0) === 1, "跨组熟手账分开记（zeta 老熟手 × eps count=1）");
    mgr.orgAction("project-status", { id: gidZ, to: "active" });

    // b) 中断≠交付（interrupted 不写熟手账）：zeta 三单 → 新会话（wZ1 刚收口前忙态
    //    已被 a) 尾部翻 DONE？——a) 收口即 DONE，pickVeteran 会选它；先置忙逼出新人）
    hack.sessions.get(wZ1)!.state.status = "WORKING";
    const z3 = mgr.orgAction("dispatch", { anchor: projZ, prompt: "zeta 三单", gid: gidZ }) as { ok: boolean; session_id?: string };
    const wZ4 = z3.session_id ?? "";
    assert(z3.ok === true && !!wZ4 && wZ4 !== wZ1, "首选忙 → 新会话承接三单");
    assert(await waitFor(() => (routingFor(gidZ).find((x) => x.session_id === wZ4)?.count ?? 0) === 1), "三单正常收口 count=1");
    const cntZ4 = routingFor(gidZ).find((x) => x.session_id === wZ4)!.count;
    hack.openDispatches.set(wZ4, [{ id: "dsp-int-x", tier: "正经立项", gid: gidZ, anchor: projZ }]);
    upsertBoardEntry(gidZ, { text: "用户手停的活", status: "doing", dispatch_id: "dsp-int-x" });
    cbFor(projZ)!.onTurnEnd(true, "interrupted", 5);
    assert(readDispatchLog().some((e) => e.id === "dsp-int-x" && e.status === "done" && e.receipt === "interrupted"), "用户中断收口：台账 done+写实回执");
    assert(loadBoard(gidZ).entries.find((x) => x.dispatch_id === "dsp-int-x")?.status === "todo", "审查修正：中断板退 todo（半成品不进 done，结项核对可见）——与其余四路径口径统一");
    assert((routingFor(gidZ).find((x) => x.session_id === wZ4)?.count ?? -1) === cntZ4, "中断不抬 count（≠交付记账）");
    assert(!hack.openDispatches.has(wZ4), "中断收口 FIFO 清空");

    // c) onSessionEnd 兜底 = 中断口径（未开工/被打断的流关闭，不写熟手账）
    hack.openDispatches.set(wZ4, [{ id: "dsp-fall-x", tier: "正经立项", gid: gidZ, anchor: projZ }]);
    cbFor(projZ)!.onSessionEnd("stopped");
    assert(readDispatchLog().some((e) => e.id === "dsp-fall-x" && e.status === "done" && e.receipt === "stopped"), "流关闭兜底收口 done");
    assert((routingFor(gidZ).find((x) => x.session_id === wZ4)?.count ?? -1) === cntZ4, "兜底收口同样不写熟手账");

    // d) 结项编制解散（§2.2）：eps 零悬账零未完 → 一句话归档 + 成员归属解除 +
    //    路由表档案永存 + 编制快照留组内
    const hcE_before = (listGroups().find((g) => g.id === gidE)?.headcount ?? []).length;
    const az = mgr.orgAction("project-status", { id: gidE, to: "archived" }) as { ok: boolean; data?: { archived?: boolean } };
    assert(az.ok === true && az.data?.archived === true, "eps 一句话归档");
    assert(hack.sessions.get(wE3)?.state.project_gid === undefined, "编制解散：成员 project_gid 清空");
    assert(hack.sessions.get(wE3)?.state.done_reason === "项目组结项（编制解散）", "解散收口 done_reason 写实");
    assert(routingFor(gidE).length > 0 && (routingFor(gidE).find((x) => x.session_id === wE3)?.count ?? 0) === 2, "路由表档案永存（结项后历史可查）");
    assert((listGroups().find((g) => g.id === gidE)?.headcount ?? []).length === hcE_before, "编制快照留组内（结项详情可查）");

    // e) 挂起组不再出建议暂缓卡（防陈旧卡点头误杀复活成员）
    mgr.orgAction("project-status", { id: gidZ, to: "parked", note: "挂起验防误触" });
    assert(hack.sessions.get(wZ4)?.state.org_parked === gidZ, "zeta 挂起联动（wZ4 退休）");
    const shP = mgr.orgAction("suggest-hold", { id: gidZ, reason: "试试" });
    assert(shP.ok === false, "挂起组建议暂缓 → ok:false（无需再建议）");

    // f) 消息复活即脱离挂起休眠（org_parked 清除，走 resumeAgent 路径）
    const ackMsg = mgr.handleCommand({ command_id: "cmd-m3-revive", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: wZ4, text: "复活继续干活" } } as Command, "web-1");
    assert(ackMsg.ok === true, "挂起成员可被消息复活（不锁死）");
    assert(hack.sessions.get(wZ4)?.state.org_parked === undefined, "复活即脱离挂起休眠（熟手池口径回真）");
    assert(hack.sessions.get(wZ4)?.state.status === "WORKING", "复活后 WORKING");

    // g) 重启重建挂起标记：内存态丢失 → 按组状态反推补标；已被复活的（agent 在）不回打
    hack.sessions.get(wZ1)!.state.org_parked = undefined;
    const rehy = mgr.rehydrateParkedMembers();
    assert(rehy === 1 && hack.sessions.get(wZ1)?.state.org_parked === gidZ, "rehydrate 按组状态反推补标（只补丢标的）");
    assert(hack.sessions.get(wZ4)?.state.org_parked === undefined, "复活中的成员不被 rehydrate 回打（agent 守卫）");

    // ---------- D11 M1/M2 审查轮（补课回归：修正点全部上锁） ----------
    console.log("D11 审查轮（板退窗口/兜底板向/陈旧卡/名额/白名单/锚冲突/成员活度/补刀）:");

    // a) 挂起板退窗口：在跑派单的 doing 条目随组挂起退 todo + 冻结（修正点的实际效果，此前无直测）
    const cEta = mgr.orgAction("project-create", { name: "eta", anchor: join(DATA, "proj-eta"), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
    const gidEta = cEta.data?.group?.id ?? "";
    mgr.orgAction("confirm-decide", { confirm_id: cEta.data?.confirm?.id ?? "", approve: true, by: "u" });
    const etaAnchor = join(DATA, "proj-eta");
    const etaD1 = mgr.orgAction("dispatch", { anchor: etaAnchor, prompt: "eta 一单", gid: gidEta }) as { ok: boolean; session_id?: string };
    const wEta = etaD1.session_id ?? "";
    assert(await waitFor(() => (routingFor(gidEta).find((x) => x.session_id === wEta)?.count ?? 0) === 1), "eta 首单收口（前置）");
    hack.sessions.get(wEta)!.state.status = "WORKING";
    hack.openDispatches.set(wEta, [{ id: "dsp-eta-p", tier: "正经立项", gid: gidEta, anchor: etaAnchor }]);
    upsertBoardEntry(gidEta, { text: "挂起时在跑", status: "doing", dispatch_id: "dsp-eta-p" });
    const pEta = mgr.orgAction("project-status", { id: gidEta, to: "parked", note: "板退窗口" });
    assert(pEta.ok === true, "eta 挂起");
    assert(loadBoard(gidEta).entries.find((x) => x.dispatch_id === "dsp-eta-p")?.status === "todo", "挂起板退窗口：在跑条目退 todo（不永挂 doing）");
    assert(loadBoard(gidEta).frozen === true, "挂起后板冻结");
    assert(readDispatchLog().some((x) => x.id === "dsp-eta-p" && x.status === "failed" && x.receipt === "项目组挂起，回合中断"), "悬账 failed+写实回执");

    // b) 兜底收口板方向：流关闭台账 done（中断≠交付）但板退 todo——结项核对才看得见未完
    mgr.orgAction("project-status", { id: gidEta, to: "active" });
    const etaD2 = mgr.orgAction("dispatch", { anchor: etaAnchor, prompt: "eta 二单", gid: gidEta }) as { ok: boolean; session_id?: string };
    assert(etaD2.ok === true && etaD2.session_id === wEta, "复活后原班承接（前置）");
    assert(await waitFor(() => (routingFor(gidEta).find((x) => x.session_id === wEta)?.count ?? 0) === 2), "二单收口（前置）");
    hack.openDispatches.set(wEta, [{ id: "dsp-eta-f", tier: "正经立项", gid: gidEta, anchor: etaAnchor }]);
    upsertBoardEntry(gidEta, { text: "流死在半路", status: "doing", dispatch_id: "dsp-eta-f" });
    cbFor(etaAnchor)!.onSessionEnd("stopped");
    assert(readDispatchLog().some((x) => x.id === "dsp-eta-f" && x.status === "done" && x.receipt === "stopped"), "兜底台账 done（回执写实）");
    assert(loadBoard(gidEta).entries.find((x) => x.dispatch_id === "dsp-eta-f")?.status === "todo", "兜底板退 todo（不虚标 done）");

    // c) 陈旧暂缓卡：出卡后组被直达挂起 → 点头 → 组不动、成员标记不被重打
    const shE = mgr.orgAction("suggest-hold", { id: gidEta, reason: "等等看" }) as { ok: boolean; data?: { confirm?: { id: string } } };
    assert(shE.ok === true, "active 组建议暂缓出卡（前置）");
    mgr.orgAction("project-status", { id: gidEta, to: "parked", note: "直达挂起（卡变陈旧）" });
    const appr = mgr.orgAction("confirm-decide", { confirm_id: shE.data?.confirm?.id ?? "", approve: true, by: "u" });
    assert(appr.ok === true, "陈旧卡点头决议本身成功");
    assert(listGroups().find((g) => g.id === gidEta)?.status === "parked", "陈旧卡复核：组仍 parked（不重复动作）");
    assert(hack.sessions.get(wEta)?.state.org_parked === gidEta, "成员标记不被重打（直达挂起那次打的还在）");

    // d) 名额满批准：前置核挡下（卡保持待决）——不产「已批准但组永卡 pending」死锁
    const activeBefore = listGroups().filter((g) => g.status === "active").length;
    const savedMax2 = process.env.CCR_ORG_MAX_GROUPS;
    process.env.CCR_ORG_MAX_GROUPS = String(activeBefore + 1);
    const cOm = mgr.orgAction("project-create", { name: "omicron", anchor: join(DATA, "proj-om"), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
    const gidOm = cOm.data?.group?.id ?? "";
    const cfOm = cOm.data?.confirm?.id ?? "";
    process.env.CCR_ORG_MAX_GROUPS = String(activeBefore); // 卡待决期间名额被占满
    const blocked = mgr.orgAction("confirm-decide", { confirm_id: cfOm, approve: true, by: "u" }) as { ok: boolean; error?: string };
    assert(blocked.ok === false && (blocked.error ?? "").includes("上限"), "名额满 → 批准被前置核挡下");
    assert(listPendingConfirms().some((c) => c.id === cfOm && c.status === "pending"), "卡保持待决（可腾名额再批）");
    assert(listGroups().find((g) => g.id === gidOm)?.status === "pending", "组仍 pending（没被半激活）");
    if (savedMax2 === undefined) delete process.env.CCR_ORG_MAX_GROUPS; else process.env.CCR_ORG_MAX_GROUPS = savedMax2;
    const apprOm = mgr.orgAction("confirm-decide", { confirm_id: cfOm, approve: true, by: "u" });
    assert(apprOm.ok === true && listGroups().find((g) => g.id === gidOm)?.status === "active", "恢复名额后批准 → active（闭环）");

    // e) board move 白名单：非法 status 拒绝（与 upsert 同口径）
    const mvBad = mgr.orgAction("board", { op: "move", gid: gidEta, entry_id: "nope", status: "bogus" }) as { ok: boolean; error?: string };
    assert(mvBad.ok === false && (mvBad.error ?? "").includes("todo|doing|done"), "board move 非法 status 拒绝");

    // f) 复活边锚复查：归档组锚被新组占位 → 拒复活（双组同锚拦截）
    const cTh = mgr.orgAction("project-create", { name: "theta", anchor: join(DATA, "proj-th"), tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string } } };
    const gidTh = cTh.data?.group?.id ?? "";
    assert(cTh.ok === true && listGroups().find((g) => g.id === gidTh)?.status === "active", "theta 轻立项直达 active（前置）");
    const arTh = mgr.orgAction("project-status", { id: gidTh, to: "archived" });
    assert(arTh.ok === true, "theta 一句话归档（锚释放，前置）");
    const cIo = mgr.orgAction("project-create", { name: "iota", anchor: join(DATA, "proj-th"), tier: "轻立项" });
    assert(cIo.ok === true, "同锚新组 iota 占位（前置）");
    const rvTh = mgr.orgAction("project-status", { id: gidTh, to: "active" }) as { ok: boolean; error?: string };
    assert(rvTh.ok === false && (rvTh.error ?? "").includes("占用"), "复活边锚复查：占位时拒复活");

    // g) memberActivity 接线：四路全陈旧但成员会话在动 → 不出卡（防漏传第五路活度的回归）
    const cKa = mgr.orgAction("project-create", { name: "kappa", anchor: join(DATA, "proj-ka"), tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string } } };
    const gidKa = cKa.data?.group?.id ?? "";
    addMember(gidKa, wZ1, "worker");
    backdate(gidKa, 20);
    const savedPgid = hack.sessions.get(wZ1)!.state.project_gid;
    hack.sessions.get(wZ1)!.state.project_gid = gidKa;
    hack.sessions.get(wZ1)!.state.updated_at = Date.now();
    const scanK1 = mgr.autoSuggestHold();
    assert(!scanK1.suggested.includes(gidKa), "成员会话在动 → 不出卡（第五路活度接线）");
    hack.sessions.get(wZ1)!.state.project_gid = savedPgid; // 还原信号 → 反证不是永不出卡
    const scanK2 = mgr.autoSuggestHold();
    assert(scanK2.suggested.includes(gidKa), "无成员信号 → 照常出卡（活度口径不误杀）");
    mgr.orgAction("confirm-decide", { confirm_id: listPendingConfirms().find((c) => c.kind === "suggest-hold" && c.payload.gid === gidKa)?.id ?? "", approve: false, by: "u" });

    // h) 停流补刀（B1 修正真触发）：挂起落在 spawn 窗口 → 立即 stop 落空后窗口外必补刀；
    //    期间被复活换流 → 代际守卫跳过（只杀旧流）
    const prevRpm = process.env.CCR_RESUME_PENDING_MS;
    process.env.CCR_RESUME_PENDING_MS = "5000"; // 窗口下限（resumePendingWindowMs 最低 5s）
    stopNoop = true;
    mgr.orgAction("project-status", { id: gidKa, to: "archived" }); // 腾名额（kappa 用完了）
    mgr.orgAction("project-status", { id: gidOm, to: "archived" });
    const cMu = mgr.orgAction("project-create", { name: "mu", anchor: join(DATA, "proj-mu"), tier: "轻立项" });
    const gidMu = listGroups().find((g) => g.name === "mu")?.id ?? "";
    assert(cMu.ok === true && !!gidMu, "mu 立项（前置）");
    const dMu = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-mu"), prompt: "mu 一单", gid: gidMu }) as { ok: boolean; session_id?: string };
    const wMu = dMu.session_id ?? "";
    assert(dMu.ok === true && await waitFor(() => (routingFor(gidMu).find((x) => x.session_id === wMu)?.count ?? 0) === 1), "mu 首单收口（前置）");
    const cNu = mgr.orgAction("project-create", { name: "nu", anchor: join(DATA, "proj-nu"), tier: "轻立项" });
    const gidNu = listGroups().find((g) => g.name === "nu")?.id ?? "";
    assert(cNu.ok === true && !!gidNu, "nu 立项（前置）");
    const dNu = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-nu"), prompt: "nu 一单", gid: gidNu }) as { ok: boolean; session_id?: string };
    const wNu = dNu.session_id ?? "";
    assert(dNu.ok === true && await waitFor(() => (routingFor(gidNu).find((x) => x.session_id === wNu)?.count ?? 0) === 1), "nu 首单收口（前置）");
    const agentMu = created.find((c) => c.cwd === join(DATA, "proj-mu"))?.agent;
    const agentNu = created.find((c) => c.cwd === join(DATA, "proj-nu"))?.agent;
    const muBefore = stopCalls.filter((x) => x === agentMu?.id).length;
    const nuBefore = stopCalls.filter((x) => x === agentNu?.id).length;
    mgr.orgAction("project-status", { id: gidMu, to: "parked", note: "补刀用例（无人接管）" });
    mgr.orgAction("project-status", { id: gidNu, to: "parked", note: "换流用例" });
    mgr.orgAction("project-status", { id: gidNu, to: "active" });
    const dNu2 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-nu"), prompt: "nu 二单", gid: gidNu }) as { ok: boolean; session_id?: string };
    assert(dNu2.ok === true && dNu2.session_id === wNu, "nu 复活后原班承接（换流，前置）");
    await wait(6500); // 5s 窗口 + 1s 缓冲 + 调度余量
    assert(stopCalls.filter((x) => x === agentMu?.id).length === muBefore + 2, "mu：立即 stop 落空 + 窗口后补刀真触发（代际守卫）");
    assert(stopCalls.filter((x) => x === agentNu?.id).length === nuBefore + 1, "nu：复活换流 → 补刀被代际守卫跳过（不误杀新流）");
    stopNoop = false;
    if (prevRpm === undefined) delete process.env.CCR_RESUME_PENDING_MS; else process.env.CCR_RESUME_PENDING_MS = prevRpm;

    // ---------- D12 收尾加固（tier 守卫 + 恢复放弃） ----------
    console.log("D12 tier 守卫/恢复放弃:");
    // a) 档位守卫：pending（立项卡没过——档位就写在卡上，先改=审A落B）与
    //    archived（编制已解散）拒出卡；挂起组允许（整理档位与复活后口径连贯）
    const cSg = mgr.orgAction("project-create", { name: "sigma", anchor: join(DATA, "proj-sg"), tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
    const gidSg = cSg.data?.group?.id ?? "";
    assert(cSg.ok === true && !!gidSg, "sigma 正经立项 → pending（前置）");
    const tSg = mgr.orgAction("project-tier", { id: gidSg, to: "轻立项", reason: "立项前偷改档" }) as { ok: boolean; error?: string };
    assert(tSg.ok === false && (tSg.error ?? "").includes("pending"), "pending 组拒改档（档位随立项卡定）");
    mgr.orgAction("confirm-decide", { confirm_id: cSg.data?.confirm?.id ?? "", approve: false, by: "u" });
    const tTh2 = mgr.orgAction("project-tier", { id: gidTh, to: "轻立项", reason: "结项后想改档" }) as { ok: boolean; error?: string };
    assert(tTh2.ok === false && (tTh2.error ?? "").includes("结项"), "archived 组拒改档（编制已解散）");
    const tEt = mgr.orgAction("project-tier", { id: gidEta, to: "轻立项", reason: "挂起期整理档位" }) as { ok: boolean; data?: { confirm?: { id: string }; noop?: boolean } };
    assert(tEt.ok === true && !!tEt.data?.confirm, "挂起组允许改档（确认卡走起）");
    mgr.orgAction("confirm-decide", { confirm_id: tEt.data?.confirm?.id ?? "", approve: true, by: "u" });
    assert(listGroups().find((g) => g.id === gidEta)?.tier === "轻立项" && listGroups().find((g) => g.id === gidEta)?.status === "parked", "挂起组改档落地（状态不动）");

    // a2) tier 陈旧卡（审查修正 A/C）：出卡后组结项 → 批旧卡不动档位——决议口与
    //     提案口同款守卫（提案口挡了直达，决议口漏挡则旁路：归档终态快照被改写）
    const cSt = mgr.orgAction("project-create", { name: "stale", anchor: join(DATA, "proj-st"), tier: "轻立项" });
    const gidSt = listGroups().find((g) => g.name === "stale")?.id ?? "";
    assert(cSt.ok === true && !!gidSt, "stale 立项（前置）");
    const tSt = mgr.orgAction("project-tier", { id: gidSt, to: "正经立项", reason: "出卡后就结项" }) as { ok: boolean; data?: { confirm?: { id: string } } };
    assert(tSt.ok === true && !!tSt.data?.confirm, "stale 升级卡在决（前置）");
    const arSt = mgr.orgAction("project-status", { id: gidSt, to: "archived" });
    assert(arSt.ok === true, "卡待决期间组结项（前置：零悬账一句话归档）");
    const apSt = mgr.orgAction("confirm-decide", { confirm_id: tSt.data?.confirm?.id ?? "", approve: true, by: "u" });
    assert(apSt.ok === true, "陈旧卡点头决议本身成功");
    assert(listGroups().find((g) => g.id === gidSt)?.tier === "轻立项", "陈旧卡复核：结项组档位不动（决议口守卫）");

    // b) recover_abandon：杀树等待窗口内组被挂起收口 → 看门狗放弃恢复（不起死回生）
    mgr.orgAction("project-status", { id: gidD, to: "archived" }); // 腾名额（delta/oldwork 已无悬账未完）
    mgr.orgAction("project-status", { id: gidO2, to: "archived" });
    const cRc = mgr.orgAction("project-create", { name: "rho", anchor: join(DATA, "proj-rc"), tier: "轻立项" });
    const gidRc = listGroups().find((g) => g.name === "rho")?.id ?? "";
    assert(cRc.ok === true && !!gidRc, "rho 立项（前置）");
    const rcAnchor = join(DATA, "proj-rc");
    const dRc = mgr.orgAction("dispatch", { anchor: rcAnchor, prompt: "rho 一单", gid: gidRc }) as { ok: boolean; session_id?: string };
    const wRc = dRc.session_id ?? "";
    assert(dRc.ok === true && await waitFor(() => (routingFor(gidRc).find((x) => x.session_id === wRc)?.count ?? 0) === 1), "rho 首单收口（前置：relay_session_id 在册）");
    hack.sessions.get(wRc)!.state.status = "WORKING";
    hack.openDispatches.set(wRc, [{ id: "dsp-rc-ab", tier: "轻立项", gid: gidRc, anchor: rcAnchor }]);
    const hackRc = mgr as unknown as { recoverFromStall(s: never, lane: string, stalled: number, cpu: number): Promise<void> };
    const sRc = hack.sessions.get(wRc)!;
    stopNoop = true; // stop 落空：agent 永不落 ended → 逼出整段 5s 杀树等待窗口
    const recP = hackRc.recoverFromStall(sRc as never, "slow", 1000, 0);
    await wait(300); // 已进等待窗口（此时挂起 = 正中竞态靶心）
    const pRc = mgr.orgAction("project-status", { id: gidRc, to: "parked", note: "恢复窗口内挂起" });
    assert(pRc.ok === true, "窗口内挂起直达（前置）");
    assert(readDispatchLog().some((x) => x.id === "dsp-rc-ab" && x.status === "failed" && x.receipt === "项目组挂起，回合中断"), "悬账由挂起收口（非看门狗）");
    const createdBefore = created.length;
    await recP;
    assert(wdActions.some((x) => x.sid === wRc && x.action === "recover_abandon"), "看门狗发出 recover_abandon（放弃恢复事件面）");
    assert(hack.sessions.get(wRc)?.state.org_parked === gidRc && hack.sessions.get(wRc)?.agent === null, "放弃恢复：会话保持挂起休眠（不复活不换流）");
    assert(created.length === createdBefore, "放弃恢复零 spawn（不起死回生）");
    // 审查修正（B）：防风暴额度只记真实干预——放弃=零干预零额度（push 原在放弃
    // 守卫之前，两次 park-放弃会烧掉第三次真僵死的自愈机会）
    const wdRc = (hack.sessions.get(wRc) as unknown as { wd: { recoveries: unknown[] } }).wd;
    assert(wdRc.recoveries.length === 0, "放弃恢复不烧自愈额度（recoveries 只记真实干预）");
    stopNoop = false;

    // b2) 看门狗接管「无未回显消息」路径（冲刺 F-06 审查补锁：板去向无直测）：
    //     FIFO 挂单 + 板 doing + unacked 空 → recoverFromStall 直调 → 台账 done+
    //     写实回执 + 板退 todo。构造要点：①派单 resume 会推 unacked 而 fake 工厂
    //     不发 user_message 日志（无回显清除），须手工清空才落在 no-pending 分支；
    //     ②agent.ended 先置真——否则 5s 杀树等待后被 force stop，fake 的
    //     onSessionEnd 抢先以「stopped」收口 FIFO，目标回执被顶掉
    mgr.orgAction("project-status", { id: gidEta, to: "active" });
    const etaD3 = mgr.orgAction("dispatch", { anchor: etaAnchor, prompt: "eta 三单（看门狗接管用）", gid: gidEta }) as { ok: boolean; session_id?: string };
    assert(etaD3.ok === true && etaD3.session_id === wEta, "eta 复活后原班承接三单（前置）");
    assert(await waitFor(() => (routingFor(gidEta).find((x) => x.session_id === wEta)?.count ?? 0) === 3), "三单收口 count=3（前置：relay_session_id 在册）");
    const sEta = hack.sessions.get(wEta) as unknown as { agent: { ended: boolean } | null; unacked: unknown[] };
    sEta.unacked = []; // 逼出 no-pending 分支（见上①）
    sEta.agent!.ended = true; // 流已断（见上②）
    hack.openDispatches.set(wEta, [{ id: "dsp-eta-wd", tier: "轻立项", gid: gidEta, anchor: etaAnchor }]);
    upsertBoardEntry(gidEta, { text: "看门狗接管的活", status: "doing", dispatch_id: "dsp-eta-wd" });
    await (mgr as unknown as { recoverFromStall(s: never, lane: string, stalled: number, cpu: number): Promise<void> })
      .recoverFromStall(hack.sessions.get(wEta) as never, "slow", 1000, 0);
    assert(readDispatchLog().some((x) => x.id === "dsp-eta-wd" && x.status === "done" && x.receipt === "流中断恢复待命，回合中断"), "看门狗接管：无未回显 → 台账 done+写实回执（F-06）");
    assert(loadBoard(gidEta).entries.find((x) => x.dispatch_id === "dsp-eta-wd")?.status === "todo", "板退 todo（F-06：活没交付不能停 done，结项核对可见）");
    assert((routingFor(gidEta).find((x) => x.session_id === wEta)?.count ?? -1) === 3, "中断收口不写路由（count 不动）");

    // ---------- D13 补章（skills 定向调度 + 成员级退休/复拉） ----------
    console.log("D13 补章（skills 定向/成员级退休）:");
    const cTa = mgr.orgAction("project-create", { name: "tau", anchor: join(DATA, "proj-ta"), tier: "轻立项" });
    const gidTa = listGroups().find((g) => g.name === "tau")?.id ?? "";
    assert(cTa.ok === true && !!gidTa, "tau 立项（前置）");
    const taAnchor = join(DATA, "proj-ta");
    // 抬 W1 熟练度到 3（逐单等收口再派下一单——空闲熟手 resume 原会话，顺带锁
    // 「无 skills 行为不变」的回归口径）
    let wT1 = "";
    for (let i = 0; i < 3; i++) {
      const dx = mgr.orgAction("dispatch", { anchor: taAnchor, prompt: `tau 基线单 ${i + 1}`, gid: gidTa }) as { ok: boolean; session_id?: string };
      const sx = dx.session_id ?? "";
      assert(dx.ok === true && !!sx, `tau 基线单 ${i + 1} 派出（前置）`);
      assert(await waitFor(() => (routingFor(gidTa).find((x) => x.session_id === sx)?.count ?? 0) === i + 1), `基线单 ${i + 1} 收口（前置）`);
      if (!wT1) wT1 = sx;
      else assert(sx === wT1, `基线单 ${i + 1} resume 原熟手（无 skills 行为不变）`);
    }
    assert((routingFor(gidTa).find((x) => x.session_id === wT1)?.count ?? 0) === 3, "W1 count=3（前置）");
    hack.sessions.get(wT1)!.state.status = "WORKING"; // 逼出第二会话
    const ta2 = mgr.orgAction("dispatch", { anchor: taAnchor, prompt: "tau 二单", gid: gidTa }) as { ok: boolean; session_id?: string };
    const wT2 = ta2.session_id ?? "";
    assert(ta2.ok === true && !!wT2 && wT2 !== wT1, "首熟练手忙 → 新会话 W2（前置）");
    assert(await waitFor(() => (routingFor(gidTa).find((x) => x.session_id === wT2)?.count ?? 0) === 1), "W2 收口（前置）");
    hack.sessions.get(wT1)!.state.status = "DONE"; // 还原空闲
    assert(mgr.orgAction("tag", { gid: gidTa, sid: wT2, tags: ["rust"] }).ok === true, "W2 打 rust 标（前置）");
    const ta3 = mgr.orgAction("dispatch", { anchor: taAnchor, prompt: "tau 三单（要 rust）", gid: gidTa, skills: ["rust"] }) as { ok: boolean; session_id?: string };
    assert(ta3.ok === true && ta3.session_id === wT2, "skills 命中 → 越过熟练序选带标签熟手（W1=3 让位 W2）");
    assert(await waitFor(() => (routingFor(gidTa).find((x) => x.session_id === wT2)?.count ?? 0) === 2), "W2 再收口（前置）");
    const ta4 = mgr.orgAction("dispatch", { anchor: taAnchor, prompt: "tau 四单", gid: gidTa, skills: ["python"] }) as { ok: boolean; session_id?: string };
    assert(ta4.ok === true && ta4.session_id === wT1, "skills 无命中 → 放宽回熟练序（技能是偏好不是硬约束）");
    assert(await waitFor(() => (routingFor(gidTa).find((x) => x.session_id === wT1)?.count ?? 0) === 4), "W1 再收口（前置：4>2 奠定退休后余威）");

    // b) 成员级退休：编制除名 → 本组悬账中断收口 + 会话休眠 + 路由档案保留 + 编制门跳过
    hack.sessions.get(wT1)!.state.status = "WORKING";
    hack.openDispatches.set(wT1, [{ id: "dsp-ta-ret", tier: "轻立项", gid: gidTa, anchor: taAnchor }]);
    const rt1 = mgr.orgAction("member-retire", { gid: gidTa, sid: wT1, reason: "休假" }) as { ok: boolean; data?: { halted?: boolean } };
    assert(rt1.ok === true && rt1.data?.halted === true, "member-retire 成功（在跑成员停流收口）");
    assert(readDispatchLog().some((x) => x.id === "dsp-ta-ret" && x.status === "failed" && (x.receipt ?? "").includes("成员退休")), "本组悬账按中断收口（写实回执）");
    assert(!(listGroups().find((g) => g.id === gidTa)?.headcount ?? []).some((h) => h.session_id === wT1), "编制除名（headcount 移除）");
    assert(hack.sessions.get(wT1)?.state.status === "DONE" && hack.sessions.get(wT1)?.state.done_reason === "成员退休（编制除名，路由表档案保留）", "会话休眠 + done_reason 写实");
    assert(hack.sessions.get(wT1)?.state.project_gid === undefined, "本组归属清除");
    assert((routingFor(gidTa).find((x) => x.session_id === wT1)?.count ?? -1) === 4, "路由档案保留（count 不动）");
    const ta5 = mgr.orgAction("dispatch", { anchor: taAnchor, prompt: "tau 五单", gid: gidTa }) as { ok: boolean; session_id?: string };
    assert(ta5.ok === true && ta5.session_id === wT2, "编制门生效：退休熟手不被 resume（只剩档案），落 W2");
    assert(await waitFor(() => (routingFor(gidTa).find((x) => x.session_id === wT2)?.count ?? 0) === 3), "W2 收口（前置）");
    const rtBad1 = mgr.orgAction("member-retire", { gid: gidTh, sid: wT2 }) as { ok: boolean; error?: string };
    assert(rtBad1.ok === false && (rtBad1.error ?? "").includes("结项"), "结项组拒退休（编制已是快照档案）");
    const rtBad2 = mgr.orgAction("member-retire", { gid: gidTa, sid: "no-such-sid" }) as { ok: boolean; error?: string };
    assert(rtBad2.ok === false && (rtBad2.error ?? "").includes("编制内"), "不在编制拒退休");

    // c) 复拉：member-add 回编制 → 编制门重新放行（W1=4 > W2=3 熟练序居首）
    const ma1 = mgr.orgAction("member-add", { gid: gidTa, sid: wT1 }) as { ok: boolean; data?: { group?: { headcount?: { session_id: string }[] } } };
    assert(ma1.ok === true && (ma1.data?.group?.headcount ?? []).some((h) => h.session_id === wT1), "复拉入编成功");
    const ta6 = mgr.orgAction("dispatch", { anchor: taAnchor, prompt: "tau 六单", gid: gidTa }) as { ok: boolean; session_id?: string };
    assert(ta6.ok === true && ta6.session_id === wT1, "复拉后编制门放行（原熟手回归 resume）");
    assert(await waitFor(() => (routingFor(gidTa).find((x) => x.session_id === wT1)?.count ?? 0) === 5), "W1 回归收口");

    // c2) 大小写对偶（审查修正，三家同报）：自然书写标签（Rust）× 派单 skills（rust）
    //     命中——写侧 tagRouting 归一落库，读侧防御存量档案
    assert(mgr.orgAction("tag", { gid: gidTa, sid: wT2, tags: ["Rust"] }).ok === true, "大写标签写入（前置）");
    assert((routingFor(gidTa).find((x) => x.session_id === wT2)?.tags ?? []).join(",") === "rust", "写侧归一：标签落库小写");
    const ta7 = mgr.orgAction("dispatch", { anchor: taAnchor, prompt: "tau 七单（要 Rust）", gid: gidTa, skills: ["rust"] }) as { ok: boolean; session_id?: string };
    const wT2cb = created[created.length - 1].cb; // ta7 的 resume 流（W2 当前流）——d) 段收 phi 悬账用它
    assert(ta7.ok === true && ta7.session_id === wT2, "大小写对偶命中（Rust 标签 × rust 查询，越过 W1 熟练序）");
    assert(await waitFor(() => (routingFor(gidTa).find((x) => x.session_id === wT2)?.count ?? 0) === 4), "七单收口（前置）");

    // c3) 他组挂起标记不陪葬（审查修正 A4）：retired 只清指向本组的 org_parked
    hack.sessions.get(wT1)!.state.org_parked = "g-elsewhere"; // 模拟他组（别处）挂起标记
    const rt3 = mgr.orgAction("member-retire", { gid: gidTa, sid: wT1, reason: "再退验他组标记" }) as { ok: boolean; data?: { halted?: boolean } };
    assert(rt3.ok === true && rt3.data?.halted === true, "W1 二次退休（前置：FIFO 空停流）");
    assert(hack.sessions.get(wT1)?.state.org_parked === "g-elsewhere", "他组挂起标记保留（成员级退休不陪葬他组状态）");

    // c4) 无卡成员除名（审查修正 A5/C4）：会话卡被 evict/压缩后编制残条不再死锁
    addMember(gidTa, "ghost-sid", "worker");
    const rtG = mgr.orgAction("member-retire", { gid: gidTa, sid: "ghost-sid" }) as { ok: boolean; data?: { halted?: boolean } };
    assert(rtG.ok === true && rtG.data?.halted === false, "无卡成员照常除名（halted:false 纯档案清扫）");
    assert(!(listGroups().find((g) => g.id === gidTa)?.headcount ?? []).some((h) => h.session_id === "ghost-sid"), "幽灵编制条目已清");

    // d) 跨组正交：W2 为 phi 组在跑 → tau 侧 member-retire 只除名不杀流
    const cPh = mgr.orgAction("project-create", { name: "phi", anchor: join(DATA, "proj-ph"), tier: "轻立项" });
    const gidPh = listGroups().find((g) => g.name === "phi")?.id ?? "";
    assert(cPh.ok === true && !!gidPh, "phi 立项（前置）");
    addMember(gidPh, wT2, "worker");
    hack.sessions.get(wT2)!.state.status = "WORKING";
    hack.openDispatches.set(wT2, [{ id: "dsp-ph-x", tier: "轻立项", gid: gidPh, anchor: join(DATA, "proj-ph") }]);
    const rt2 = mgr.orgAction("member-retire", { gid: gidTa, sid: wT2, reason: "除名但活没干完" }) as { ok: boolean; data?: { halted?: boolean } };
    assert(rt2.ok === true && rt2.data?.halted === false, "他组在跑 → 只除名不停流（halted:false）");
    assert(readDispatchLog().every((x) => x.id !== "dsp-ph-x"), "他组悬账不陪葬（phi 的单没被 tau 侧退休收口）");
    assert(hack.sessions.get(wT2)?.state.status === "WORKING", "会话仍在干活（未休眠）");
    wT2cb.onTurnEnd(true, "phi 干完", 8); // wT2 自己的流回调（ta7 的 resume 流；cbFor 此刻会命中 wT1 流，不能用）
    assert(readDispatchLog().some((x) => x.id === "dsp-ph-x" && x.status === "done" && x.receipt === "phi 干完"), "他组回合自然收口（写实回执）");
    assert((routingFor(gidPh).find((x) => x.session_id === wT2)?.count ?? 0) === 1, "phi 路由入账（跨组正交面）");
    assert(!hack.openDispatches.has(wT2), "FIFO 清空");

    // ---------- D14 resume 挂死自愈（冲刺 F-07）+ 审查轮补锁 ----------
    console.log("D14 resume 挂死自愈（F-07）:");
    process.env.CCR_RESUME_INIT_MS = "300";
    const hack14 = mgr as unknown as {
      sessions: Map<string, {
        state: { status: string; saved?: boolean; last_error?: string; session_id: string; usage?: { input_tokens: number; output_tokens: number } };
        agent: { ended: boolean; stop: () => Promise<void> } | null;
        logs: { kind: string; text: string }[];
        unacked: { text: string; ts: number }[];
      }>;
    };
    // a) 首回合会话（无 assistant 产出=无记忆可丢）：resume 挂死 → 300ms 超时 → fresh spawn 重放
    const sW1 = hack14.sessions.get(wid1)!;
    assert(!sW1.logs.some((e) => e.kind === "assistant_text"), "前置：wid1 无已完成回合（首回合形态）");
    sW1.agent!.ended = true; // 流已死 → COMMAND_MESSAGE 走 resumeAgent
    hangResume = true;
    const createdBeforeA = created.length;
    const ack14a = mgr.handleCommand({ command_id: "cmd-f07a", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: wid1, text: "救命消息（F-07）" } } as Command, "web-1");
    assert(ack14a.ok === true, "消息受理（触发 resume）");
    assert(created.length === createdBeforeA + 1 && !!created[created.length - 1].resume, "resume 形态 spawn 发起");
    assert(await waitFor(() => created.some((c, i) => i >= createdBeforeA && !c.resume && c.prompt?.includes("救命消息（F-07）"))), "超时回退 fresh spawn（prompt=重放消息）");
    assert(await waitFor(() => sW1.logs.some((e) => e.kind === "system" && e.text.includes("用新会话重发"))), "回退留痕（system 日志可审计，用户语言）");
    assert(!sW1.unacked.some((m) => m.text.includes("救命消息（F-07）")), "重放消息未回显账已清（防下轮看门狗重复重放）");
    assert(await waitFor(() => sW1.state.status === "DONE"), "fresh 流回合自然收口（DONE）");
    hangResume = false;
    // a2) 审查 P1「停了又复活」：init 窗口内用户 STOP → timer 撤销，不 fresh 不覆写
    const stopSid = (() => {
      const d = mgr.orgAction("dispatch", { anchor, prompt: "停止窗口用例" }) as { ok: boolean; session_id?: string };
      return d.ok ? (d as { session_id: string }).session_id : "";
    })();
    assert(await waitFor(() => hack14.sessions.get(stopSid)?.state.status === "DONE"), "停止用例会话先收口（前置）");
    const sStop = hack14.sessions.get(stopSid)!;
    assert(!sStop.logs.some((e) => e.kind === "assistant_text"), "前置：无已完成回合（首回合形态）");
    sStop.agent!.ended = true;
    hangResume = true;
    const createdBeforeStop = created.length;
    const ackStop = mgr.handleCommand({ command_id: "cmd-f07-stop", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: stopSid, text: "要被停掉的消息" } } as Command, "web-1");
    assert(ackStop.ok === true, "消息受理（触发 resume，前置）");
    await sStop.agent!.stop(); // 用户 STOP：fake agent 落 ended + onSessionEnd → timer 应被清
    await wait(600); // 300ms init 窗口 + 缓冲
    assert(created.length === createdBeforeStop + 1, "STOP 后无 fresh spawn（不复活用户刚停掉的活）");
    assert(sStop.state.status !== "ERROR" || (sStop.state.last_error ?? "").includes("无响应") === false, "STOP 终态不被超时分支覆写成 ERROR");
    hangResume = false;
    // a3) 审查 P2「删除幽灵拉活」：init 窗口内会话卡被删 → timer 不为已删会话开火
    const delSid = (() => {
      const d = mgr.orgAction("dispatch", { anchor, prompt: "删除窗口用例" }) as { ok: boolean; session_id?: string };
      return d.ok ? (d as { session_id: string }).session_id : "";
    })();
    assert(await waitFor(() => hack14.sessions.get(delSid)?.state.status === "DONE"), "删除用例会话先收口（前置）");
    const sDel = hack14.sessions.get(delSid)!;
    assert(!sDel.logs.some((e) => e.kind === "assistant_text"), "前置：无已完成回合");
    sDel.agent!.ended = true;
    hangResume = true;
    const createdBeforeDel = created.length;
    const ackDel = mgr.handleCommand({ command_id: "cmd-f07-del", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: delSid, text: "会被删掉的消息" } } as Command, "web-1");
    assert(ackDel.ok === true, "消息受理（触发 resume，前置）");
    hack14.sessions.delete(delSid); // deleteSession 语义：卡移除、不停 agent 不换引用
    await wait(600);
    assert(created.length === createdBeforeDel + 1, "会话已删 → 无 fresh spawn（不为幽灵拉活）");
    hangResume = false;
    // a4) 审查 P2「窗口内第二条消息丢失」：fresh 重放合并窗口内全部未回显消息
    const mrgSid = (() => {
      const d = mgr.orgAction("dispatch", { anchor, prompt: "合并重放用例" }) as { ok: boolean; session_id?: string };
      return d.ok ? (d as { session_id: string }).session_id : "";
    })();
    assert(await waitFor(() => hack14.sessions.get(mrgSid)?.state.status === "DONE"), "合并用例会话先收口（前置）");
    const sMrg = hack14.sessions.get(mrgSid)!;
    assert(!sMrg.logs.some((e) => e.kind === "assistant_text"), "前置：无已完成回合");
    sMrg.agent!.ended = true;
    hangResume = true;
    const createdBeforeMrg = created.length;
    const ackM1 = mgr.handleCommand({ command_id: "cmd-f07-m1", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: mrgSid, text: "第一条（合并重放）" } } as Command, "web-1");
    assert(ackM1.ok === true, "首条消息受理（触发 resume，前置）");
    const ackM2 = mgr.handleCommand({ command_id: "cmd-f07-m2", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: mrgSid, text: "第二条（窗口内到达）" } } as Command, "web-1");
    assert(ackM2.ok === true, "窗口内第二条受理（排队路径，前置）");
    assert(await waitFor(() => created.some((c, i) => i >= createdBeforeMrg && !c.resume && c.prompt?.includes("第一条（合并重放）") && c.prompt?.includes("第二条（窗口内到达）"))), "fresh 重放合并窗口内全部消息（第二条不丢）");
    assert(!sMrg.unacked.some((m) => m.text.includes("窗口内到达")), "合并后未回显账清空");
    hangResume = false;
    // b) 有记忆会话：resume 挂死 → 不赌 fresh（抹上下文）→ ERROR+saved 可重试
    emitResultLine = "结果：有记忆的活｜改动文件：a.ts";
    const d14b = mgr.orgAction("dispatch", { anchor, prompt: "产出一条 assistant 记忆" }) as { ok: boolean; session_id?: string };
    const wid14b = d14b.ok ? (d14b as { session_id: string }).session_id : "";
    assert(await waitFor(() => hack14.sessions.get(wid14b)?.logs.some((e) => e.kind === "assistant_text") === true), "前置：wid14b 有已完成回合（有记忆形态）");
    emitResultLine = null; // fake 回合 30ms 异步——见 onLog 即已收口（onLog 与 onTurnEnd
    // 同 tick 同步连发，前提见工厂 setTimeout 体；把 onTurnEnd 挪独立 timer 需重审此处）
    const s14b = hack14.sessions.get(wid14b)!;
    s14b.agent!.ended = true;
    hangResume = true;
    const createdBefore14b = created.length;
    const ack14b = mgr.handleCommand({ command_id: "cmd-f07b", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: wid14b, text: "第二条消息" } } as Command, "web-1");
    assert(ack14b.ok === true, "消息受理（触发 resume）");
    assert(await waitFor(() => s14b.state.status === "ERROR" && s14b.state.saved === true), "有记忆会话：ERROR+saved（可重试，不赌 fresh）");
    assert((s14b.state.last_error ?? "").includes("无响应"), "失败原因写实（上游挂死）");
    assert(!created.some((c, i) => i >= createdBefore14b && !c.resume), "未发起 fresh spawn（上下文优先）");
    hangResume = false;
    // b2) 记忆判定加固：logs 无 assistant_text 但累计过输出（usage.output_tokens>0）
    // ——同走 ERROR+saved 不 fresh（logs 滚动窗裁掉早前回合的形态）
    const uSid = (() => {
      const d = mgr.orgAction("dispatch", { anchor, prompt: "usage 记忆判定用例" }) as { ok: boolean; session_id?: string };
      return d.ok ? (d as { session_id: string }).session_id : "";
    })();
    assert(await waitFor(() => hack14.sessions.get(uSid)?.state.status === "DONE"), "usage 用例会话先收口（前置）");
    const sU = hack14.sessions.get(uSid)!;
    assert(!sU.logs.some((e) => e.kind === "assistant_text"), "前置：relay logs 无 assistant_text（模拟被裁）");
    sU.state.usage = { input_tokens: 10, output_tokens: 5 };
    sU.agent!.ended = true;
    hangResume = true;
    const createdBeforeU = created.length;
    const ackU = mgr.handleCommand({ command_id: "cmd-f07u", type: "COMMAND_MESSAGE", ts: Date.now(), payload: { session_id: uSid, text: "usage 判定消息" } } as Command, "web-1");
    assert(ackU.ok === true, "消息受理（触发 resume，前置）");
    assert(await waitFor(() => sU.state.status === "ERROR" && sU.state.saved === true), "累计输出>0 = 有记忆：ERROR+saved（不 fresh）");
    assert(!created.some((c, i) => i >= createdBeforeU && !c.resume), "usage 记忆同样不 fresh spawn");
    hangResume = false;

    // ---------- D15 雇员独立家（#17）：spawn 传 CLAUDE_CONFIG_DIR、身份标记、开关语义 ----------
    console.log("D15 雇员独立家（#17）:");
    {
      const anchor15 = join(DATA, "proj-emp-home");
      mkdirSync(anchor15, { recursive: true });
      // 基线：开关关闭（cfg.employeeConfigDir=null）——雇员身份标记在、configHome 不传
      const before15 = created.length;
      const d15a = mgr.orgAction("dispatch", { anchor: anchor15, prompt: "独立家基线单" }) as { ok: boolean; session_id?: string };
      assert(d15a.ok === true, "基线单派发");
      await waitFor(() => mgr.snapshot().find((s) => s.session_id === d15a.session_id && s.status === "DONE") !== undefined);
      assert(created.slice(before15).every((c) => c.configHome === undefined), "开关关闭：spawn 不传 configHome（行为与从前一致）");
      assert(mgr.snapshot().find((s) => s.session_id === d15a.session_id)?.employee === true, "worker 卡带雇员标记（身份恒在，与开关无关）");
      // 中途开启：新单立即生效（resume 原班与新 spawn 同口，都带 configHome）
      const EMP = mkdtempSync(join(tmpdir(), "ccr-emp-home-"));
      cfg.employeeConfigDir = EMP;
      const before15b = created.length;
      const d15b = mgr.orgAction("dispatch", { anchor: anchor15, prompt: "独立家生效单" }) as { ok: boolean; session_id?: string };
      assert(d15b.ok === true, "生效单派发");
      await waitFor(() => mgr.snapshot().find((s) => s.session_id === d15b.session_id && s.status === "DONE") !== undefined);
      assert(created.slice(before15b).every((c) => c.configHome === EMP), "开关开启：spawn 收到 configHome=独立家（含 resume 原班路径）");
      cfg.employeeConfigDir = null;
      // P2-b（边界审查）：上面两单皆无 gid = 恒 fresh create，"resume 原班"声明此前
      // 未被真正盖住——gid 组造熟手，第二单必走 resume spawn，锁 configHome 到达
      const prevMax15 = process.env.CCR_ORG_MAX_GROUPS;
      process.env.CCR_ORG_MAX_GROUPS = "50";
      const c15 = mgr.orgAction("project-create", { name: "emp-home-g", anchor: anchor15, tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
      const gid15 = c15.data?.group?.id ?? "";
      assert(c15.ok === true && !!gid15, "熟手组建组（正经立项，前置）");
      mgr.orgAction("confirm-decide", { confirm_id: c15.data?.confirm?.id ?? "", approve: true, by: "u" });
      cfg.employeeConfigDir = EMP;
      const before15c = created.length;
      const f15 = mgr.orgAction("dispatch", { anchor: anchor15, prompt: "熟手首单", gid: gid15 }) as { ok: boolean; session_id?: string };
      assert(f15.ok === true, "熟手首单派发（前置）");
      assert(await waitFor(() => (routingFor(gid15).find((x) => x.session_id === f15.session_id)?.count ?? 0) === 1), "首单收口入路由表（前置）");
      assert(created.slice(before15c).every((c) => c.configHome === EMP), "组 worker fresh spawn 带 configHome");
      assert(mgr.snapshot().find((s) => s.session_id === f15.session_id)?.employee === true, "组 worker 卡带雇员标记");
      const f15b = mgr.orgAction("dispatch", { anchor: anchor15, prompt: "熟手二单", gid: gid15 }) as { ok: boolean; session_id?: string };
      assert(f15b.ok === true && f15b.session_id === f15.session_id, "第二单 resume 原班（会话 id 复用，前置）");
      const lastSpawn = created[created.length - 1];
      assert(!!lastSpawn.resume && lastSpawn.configHome === EMP, "resume 原班 spawn 带 configHome=独立家（P2-b 补盖，此前声明的覆盖缺口）");
      assert(await waitFor(() => (routingFor(gid15).find((x) => x.session_id === f15.session_id)?.count ?? 0) === 2), "二单收口 count=2（前置闭环）");
      // P2-a：换家失联收口口径（真 CLI 实测形态：error_during_execution: No
      // conversation found…，~3.5s 快速失败）——台账 failed 写实收口 + 不记熟手
      // failed（配置漂移≠干砸，防两次后旧熟手被调度永久拉黑）+ 时间线人话日志
      hack.openDispatches.set(f15.session_id!, [{ id: "dsp-homelost", tier: "正经立项", gid: gid15, anchor: anchor15 }]);
      const failedBefore15 = routingFor(gid15).find((x) => x.session_id === f15.session_id)?.failed ?? 0;
      cbFor(anchor15)!.onTurnEnd(false, "error_during_execution: No conversation found with session ID: abc-123", 5);
      assert(readDispatchLog().some((e) => e.id === "dsp-homelost" && e.status === "failed" && (e.receipt ?? "").includes("No conversation found")), "换家失联：台账 failed 写实收口");
      assert((routingFor(gid15).find((x) => x.session_id === f15.session_id)?.failed ?? -1) === failedBefore15, "换家失联不记熟手 failed（配置漂移≠干砸）");
      assert((hack14.sessions.get(f15.session_id!)?.logs.some((e) => e.kind === "system" && e.text.includes("CCR_EMPLOYEE_CONFIG_DIR")) ?? false) === true, "时间线留人话日志（指向开关，可诊断）");
      // 第二批根治语义正锁：关态创建的熟手无 employee_home 记录 → 开启开关后
      // resume 仍不带 configHome（默认家 = 旧 transcript 实际所在）——开关翻转
      // 只影响新会话，存量天然无损（三角度审查共识方案落地）
      cfg.employeeConfigDir = null; // 关态建组（一锚一组：另起锚，emp-home-g 已占 anchor15）
      const anchor15b = join(DATA, "proj-emp-home-legacy");
      mkdirSync(anchor15b, { recursive: true });
      const c15c = mgr.orgAction("project-create", { name: "emp-home-legacy", anchor: anchor15b, tier: "正经立项" }) as { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } };
      const gid15c = c15c.data?.group?.id ?? "";
      assert(c15c.ok === true && !!gid15c, "存量熟手组建组（前置）");
      mgr.orgAction("confirm-decide", { confirm_id: c15c.data?.confirm?.id ?? "", approve: true, by: "u" });
      assert(cfg.employeeConfigDir === null, "前置：关态");
      const before15d = created.length;
      const l15 = mgr.orgAction("dispatch", { anchor: anchor15b, prompt: "存量熟手首单", gid: gid15c }) as { ok: boolean; session_id?: string };
      assert(l15.ok === true && await waitFor(() => (routingFor(gid15c).find((x) => x.session_id === l15.session_id)?.count ?? 0) === 1), "存量熟手首单收口（前置）");
      assert(created.slice(before15d).every((c) => c.configHome === undefined), "关态创建 spawn 不带 configHome");
      assert(mgr.snapshot().find((s) => s.session_id === l15.session_id)?.employee_home === undefined, "关态雇员卡无 employee_home 记录（=默认家）");
      cfg.employeeConfigDir = EMP;
      const l15b = mgr.orgAction("dispatch", { anchor: anchor15b, prompt: "存量熟手二单", gid: gid15c }) as { ok: boolean; session_id?: string };
      assert(l15b.ok === true && l15b.session_id === l15.session_id, "开关开启后熟手照常 resume 原班（前置）");
      const legacySpawn = created[created.length - 1];
      assert(!!legacySpawn.resume && legacySpawn.configHome === undefined, "存量熟手 resume 不带 configHome（按创建时记录走默认家，无损）");
      assert(await waitFor(() => (routingFor(gid15c).find((x) => x.session_id === l15.session_id)?.count ?? 0) === 2), "存量熟手二单收口（闭环）");
      cfg.employeeConfigDir = null;
      if (prevMax15 === undefined) delete process.env.CCR_ORG_MAX_GROUPS; else process.env.CCR_ORG_MAX_GROUPS = prevMax15;
    }

    // ---------- D16 #25-P2 删卡清挂单：deleteSession 把在途 FIFO 残条写实收口 ----------
    console.log("D16 删卡清挂单（#25-P2）:");
    {
      // 形态：多消息 FIFO 收口顺序错位 → 会话已 DONE 但队列仍挂着一条（此前进程内
      // 常驻到重启）。删卡即收口（对齐退休/挂起联动口径）；evictOldSessions 驱逐
      // 路径同款调用形状（需 50 卡触发，不单测——同一 closeOpenDispatches 行为）
      const anchor16 = join(DATA, "proj-del16");
      mkdirSync(anchor16, { recursive: true });
      const d16 = mgr.orgAction("dispatch", { anchor: anchor16, prompt: "删卡清挂单基线单" }) as { ok: boolean; session_id?: string };
      assert(d16.ok === true && !!d16.session_id, "基线单派发（前置）");
      assert(await waitFor(() => mgr.snapshot().find((s) => s.session_id === d16.session_id && s.status === "DONE") !== undefined), "基线单先收口（前置）");
      hack.openDispatches.set(d16.session_id!, [{ id: "dsp-del-16", tier: "随手办" }]);
      assert(mgr.deleteSession(d16.session_id!) === true, "deleteSession 成功（worker 卡可删）");
      assert(!hack.openDispatches.has(d16.session_id!), "FIFO 键随删卡消失（不再进程内常驻）");
      const e16 = readDispatchLog().filter((e) => e.id === "dsp-del-16").at(-1);
      assert(e16?.status === "failed" && e16?.receipt === "会话删除，回合中断", "台账残条写实收口（failed·会话删除，回合中断）");
      assert(mgr.snapshot().find((s) => s.session_id === d16.session_id) === undefined, "卡已删（闭环）");
    }

    // ---------- D17 #40 M4 派单完成回调（谁派活谁收通知） ----------
    console.log("D17 派单完成回调（#40 M4）:");
    {
      // (a) 端上广播帧：done/failed 单都有 DISPATCH_DONE（D1/D2 的历史帧——缝在
      //     main 开头埋好，此处断言采集结果）
      const f1 = doneFrames.find((f) => f.dispatch_id === did1);
      assert(f1?.status === "done" && f1.payload.actor === "leader", "done 单广播 DISPATCH_DONE（actor=leader）");
      const f2 = doneFrames.find((f) => f.dispatch_id === did2);
      assert(!!f2 && f2.status === "failed", "failed 单广播 DISPATCH_DONE");
      const p2 = f2?.payload ?? {};
      assert(p2.worker_session_id === wid2 && p2.gid === gidA, "帧带承接会话+组（跳转数据）");
      assert(String(p2.receipt ?? "").length > 0, "帧带回执文本");
      // (b) 缺省口径：D16 hack 直塞 FIFO（无 actor）→ 只广播不注入（帧在、无定向）
      assert(doneFrames.some((f) => f.dispatch_id === "dsp-del-16" && !("actor" in f.payload)), "旧数据/无 actor 单仍广播（缺省不降级）");
      // (c) Leader 会话闭环：failed 且 actor=leader → 回执进 Leader 时间线
      //（pushExternalLog system 行 + resumeAgent 唤醒；resume 形态 prompt 走
      //  sendMessage，fake 不记录——以时间线 system 行为注入证据）
      const hack17 = mgr as unknown as { leaderId: string; sessions: Map<string, { logs: { kind: string; text?: string }[] }> };
      const leaderLogs17 = hack17.sessions.get(hack17.leaderId)?.logs ?? [];
      assert(leaderLogs17.some((l) => l.kind === "system" && (l.text ?? "").includes("[派单失败回执]") && (l.text ?? "").includes(did2.slice(0, 8))), "failed 单注入 Leader 回执（时间线 system 行）");
      assert(!leaderLogs17.some((l) => (l.text ?? "").includes("[派单失败回执]") && (l.text ?? "").includes(did1.slice(0, 8))), "done 单不注入（省 token 口径）");
      // (d) 台账 actor 字段写实（原始 ndjson 序：dispatched→running→failed 同 actor；
      //     readDispatchLog 是同 id 收敛视图只有末行——多行验证必须读原始文件，D1 同款）
      const raw17 = readFileSync(join(ORG, "dispatch-log.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; status: string; actor?: string });
      const rows17 = raw17.filter((e) => e.id === did2);
      assert(rows17.length >= 3 && rows17.every((e) => e.actor === "leader"), "台账行 actor=leader（dispatched→running→failed 全链）");
      // (e) 全量收口语义：注入不重复派帧——did2 只有一条 DISPATCH_DONE
      assert(doneFrames.filter((f) => f.dispatch_id === did2).length === 1, "每单恰一帧（不随注入重复）");
    }

    // ---------- 收尾 ----------
    console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen) process.env.CCR_NO_TITLE_GEN = prevTitleGen; else delete process.env.CCR_NO_TITLE_GEN;
    if (prevCwdEnv) process.env.CCR_CWD = prevCwdEnv; else delete process.env.CCR_CWD;
    // 审查修正：env 开关恢复统一进 finally——D14 中途断言失败时不再泄漏
    // CCR_RESUME_INIT_MS=300 进后续同进程逻辑
    if (prevInitMs !== undefined) {
      if (prevInitMs) process.env.CCR_RESUME_INIT_MS = prevInitMs; else delete process.env.CCR_RESUME_INIT_MS;
    }
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
}

void main();
