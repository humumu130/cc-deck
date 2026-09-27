// #26 矩阵式 M2 —— 分诊引擎集成测试（agentFactory 测试缝，不拉真 CLI）。
// 覆盖：D1 随手办派单（纪律模板/acceptEdits/sticky 豁免/先落账再执行）
//       D2 派单收口（done/failed + 板联动退回待办）D3 立项确认门槛与信任累积
//       D4 升降级/建议暂缓/结项核对（一句话归档 vs 确认卡）D5 状态护栏
//       D6 断档补记（dispatched/running 悬账）D7 handleCommand 确认决议/详情拉取
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager, wrapDispatchPrompt } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { listGroups, loadBoard } from "../src/projects.js";
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
let okNext = true;
type SpawnRec = { cwd: string; prompt: string | undefined; cb: AgentCallbacks };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string }): AgentLike => {
    created.push({ cwd, prompt, cb });
    const ok = okNext;
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
      cb.onInit("sdk-" + a.id.slice(0, 8), model, opts?.permissionMode ?? "default");
      if (prompt !== undefined) setTimeout(() => { if (!a.ended) cb.onTurnEnd(ok, ok ? "success" : "error exit 1", 12); }, 10);
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
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8793, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "",
    };
    const stickySentinel = mkdtempSync(join(tmpdir(), "ccr-sentinel-"));
    writeFileSync(join(DATA, "last-cwd"), stickySentinel, "utf-8");
    cfg.defaultCwd = stickySentinel;

    const created: SpawnRec[] = [];
    const mgr = new SessionManager(new EventBus({ persistPath: join(DATA, "events.ndjson") }), cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE" && s.done_reason === "success") !== undefined);
    assert(readFileSync(join(DATA, "last-cwd"), "utf-8") === stickySentinel, "基线：last-cwd 未被 org 污染");

    // ---------- D1 随手办派单 ----------
    console.log("D1 随手办派单:");
    const anchor = join(DATA, "proj-x"); // 故意不存在：验证 autoMkdir
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "把 README 的错别字改掉" }) as { ok: boolean; dispatch_id?: string; session_id?: string; error?: string };
    assert(d1.ok === true, "派单成功（目录不存在 autoMkdir 兜住）");
    const wid1 = d1.ok ? (d1 as { session_id: string }).session_id : "";
    const did1 = d1.ok ? (d1 as { dispatch_id: string }).dispatch_id : "";
    assert(existsSync(anchor), "worker cwd 目录已建（autoMkdir）");
    const rec1 = created.find((c) => c !== created[0] && c.prompt?.startsWith("[随手办 派单]"));
    assert(!!rec1 && rec1.cwd === anchor, "spawn 携纪律模板 + cwd 锚项目");
    assert(!!rec1 && rec1.prompt === wrapDispatchPrompt("随手办", "把 README 的错别字改掉"), "模板全文一致（wrapDispatchPrompt）");
    assert(await waitFor(() => mgr.snapshot().find((s) => s.session_id === wid1)?.permission_mode === "acceptEdits"), "权限 acceptEdits（§4 随手办纪律，init 回报后落 state）");
    const w1 = mgr.snapshot().find((s) => s.session_id === wid1);
    assert(w1?.dispatch_tier === "随手办", "会话态档位=随手办");
    assert(w1?.project_gid === undefined, "随手办无组归属");
    assert(readFileSync(join(DATA, "last-cwd"), "utf-8") === stickySentinel, "派单不污染 sticky 默认目录（skipStickyCwd）");
    // 先落账再执行：readDispatchLog 按 id 收敛（同 id 留最后），原始序读 ndjson 验证
    const raw1 = readFileSync(join(ORG, "dispatch-log.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; status: string; project_anchor?: string });
    const rows1 = raw1.filter((e) => e.id === did1);
    assert(rows1.length >= 2 && rows1[0]?.status === "dispatched" && rows1[1]?.status === "running", "先落账再执行（dispatched → running 同 id 原始序）");
    assert(readDispatchLog().find((e) => e.id === did1)?.project_anchor === anchor, "台账带项目锚点（§2.5 分流数据源；收敛视图）");

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

    // ---------- D6 断档补记 ----------
    console.log("D6 断档补记:");
    // 模拟上一进程崩在派单窗口（dispatched 未收 running）与回合中（running 未收口）
    const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org-disp2-"));
    const DATA2 = mkdtempSync(join(tmpdir(), "ccr-data-disp2-"));
    const prevOrg2 = process.env.CCR_ORG_DIR;
    process.env.CCR_ORG_DIR = ORG2;
    writeFileSync(join(ORG2, "dispatch-log.ndjson"),
      JSON.stringify({ ts: 1, id: "dsp-win", tier: "随手办", target: "spawn-pending", status: "dispatched", session_id: "", project_anchor: "/tmp/p" }) + "\n" +
      JSON.stringify({ ts: 2, id: "dsp-run", tier: "咨询", target: "org-leader", status: "running", session_id: "s-old" }) + "\n", "utf-8");
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

    // ---------- 收尾 ----------
    console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen) process.env.CCR_NO_TITLE_GEN = prevTitleGen; else delete process.env.CCR_NO_TITLE_GEN;
    if (prevCwdEnv) process.env.CCR_CWD = prevCwdEnv; else delete process.env.CCR_CWD;
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
}

void main();
