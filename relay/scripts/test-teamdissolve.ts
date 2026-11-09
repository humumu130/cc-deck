// [W-TEAMDISSOLVE]（1109 用户令「观察者团队不想要了不知道怎么搞」）测试件：
//   A dissolve 主路径（active 组）：team.dissolved_at 落值+组状态不动（项目保留）+
//     成员会话脱组（project_gid 清）+退休档案+chain-audit 词+幂等（二次=noop ok）
//   B 在途闸：running 派单在账 → 拒绝并回待处置清单；收口后放行
//   C 防自毁闸：值守 Leader 会话在编制内 → 拒绝
//   D 形态闸：仅立项目（no_team）无团队层拒收；pending 组拒收（去留归立项卡）
//   E parked 路径（Watchtower 形态）：挂起组解散成功（简化解散——在途闸自然空放行）
//   F 静态锁：orgCommand 咽喉放行+HTTP 白名单+UI 三面锚（入口/弹窗/已解散区/CSS）
// 直跑：env -u CCR_DATA_DIR -u CCR_ORG_DIR npx tsx scripts/test-teamdissolve.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { createGroup, findGroup, listRetiredEvents, setGroupStatus, teamStateOf } from "../src/projects.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command } from "../src/types.js";
import { randomUUID } from "node:crypto";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd; void model;
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
    };
    return a;
  };

async function main() {
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-td-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-cwd-td-"));
  const prev = { ...process.env };
  process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "ccr-org-td-"));
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_PROJECTS_ROOT = mkdtempSync(join(tmpdir(), "ccr-proj-td-"));
  delete process.env.CC_DECK_PLUGIN;
  delete process.env.CCR_PARENT_PID;
  delete process.env.CCR_RELAY_CHILD;
  try {
    const cfg: RelayConfig = {
      port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const audits: string[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    bus.subscribe((env) => { if (env.type === "NOTIFY_CHAIN_AUDIT") audits.push(String((env.payload as { action?: string }).action ?? "")); });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));
    const create = (mgr as unknown as { create(cwd: string, prompt: string): string }).create.bind(mgr);
    const send = (mgr as unknown as { handleCommand(c: Command, by: string): Promise<unknown> }).handleCommand.bind(mgr);
    const approveCreate = async (ack: { ok: boolean; data?: { confirm?: { id: string }; group?: { id: string } } }) => {
      if (ack.data?.confirm?.id) {
        const a = await send({ command_id: randomUUID(), type: "COMMAND_ORG_CONFIRM", payload: { confirm_id: ack.data.confirm.id, approve: true } } as unknown as Command, "web-1") as { ok: boolean };
        if (!a.ok) throw new Error("立项卡批准失败");
      }
    };
    const dissolve = (id: string, by = "web-1") => {
      // R1-P1-A：helper 默认带 confirm_name（=组名真值——与前端弹窗提交同门）；专测无/错名走 dissolveRaw
      const g = findGroup(id);
      return send({ command_id: randomUUID(), type: "COMMAND_ORG_ACTION", payload: { action: "dissolve", id, confirm_name: g?.name ?? "" } } as unknown as Command, by) as Promise<{ ok: boolean; error?: string; data?: { dissolved?: boolean; retired?: number; noop?: boolean; group?: { id: string; status: string; team?: { formed_at: number; dissolved_at?: number } } } }>;
    };
    const dissolveRaw = (id: string, confirmName?: string, by = "web-1") =>
      send({ command_id: randomUUID(), type: "COMMAND_ORG_ACTION", payload: { action: "dissolve", id, ...(confirmName === undefined ? {} : { confirm_name: confirmName }) } } as unknown as Command, by) as Promise<{ ok: boolean; error?: string; data?: { dissolved?: boolean; noop?: boolean } }>;

    // ---------- A 主路径（active 组全效果链） ----------
    console.log("A dissolve 主路径:");
    const anchor = mkdtempSync(join(tmpdir(), "td-anchor-a-"));
    const ackC = await send({ command_id: "c1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "TD-主路径组", anchor_dir: anchor, tier: "轻立项", pm_session_id: "" } } as unknown as Command, "web-1") as { ok: boolean; data?: { group?: { id: string } } };
    const gid = ackC.data?.group?.id;
    if (!gid) throw new Error("A 前置建组失败");
    await approveCreate(ackC as never);
    const g0 = findGroup(gid);
    assert(!!g0 && g0.status === "active" && teamStateOf(g0).has === true, `A0 前置建组 active+有团队层（status=${g0?.status}）`);
    // 两个 worker 会话入编
    const mkWorker = async (n: number) => {
      const sid = create(CWD, "TD worker " + n);
      const cb = created[created.length - 1].cb;
      cb.onInit("sdk-" + n, "test-model");
      cb.onStatusChange("WORKING", "开工");
      const ack = await send({ command_id: randomUUID(), type: "COMMAND_ORG_ACTION", payload: { action: "member-add", gid, sid, role: "worker" } } as unknown as Command, "web-1") as { ok: boolean; error?: string };
      return { sid, ok: ack.ok, err: ack.error };
    };
    const w1 = await mkWorker(1);
    const w2 = await mkWorker(2);
    assert(w1.ok && w2.ok, `A0b 两 worker 入编（${w1.err ?? "ok"}/${w2.err ?? "ok"}）`);
    // A0c 前置：project_gid 由派单承接流写（member-add 只写 headcount）——直接模拟派单
    // 挂靠态（dispatchWorker 同款落点），A4 的「脱组清空」才有真前置（防恒真）
    const sm = mgr as unknown as { sessions: Map<string, { state: { project_gid?: string } }> };
    sm.sessions.get(w1.sid)!.state.project_gid = gid;
    assert(sm.sessions.get(w1.sid)?.state.project_gid === gid, "A0c 前置：模拟派单挂靠 project_gid=gid（A4 非恒真）");
    const r1 = await dissolve(gid);
    assert(r1.ok === true && r1.data?.dissolved === true && r1.data?.retired === (findGroup(gid!)?.headcount.length ?? 0), `A1解散 ok+retired 席位数（ok=${r1.ok} retired=${r1.data?.retired} err=${r1.error ?? ""}）`);
    const g1 = findGroup(gid);
    assert(!!g1?.team?.dissolved_at && g1.status === "active", `A2 team.dissolved_at 落值+组状态不动（status=${g1?.status} 项目保留）`);
    const st1 = g1 ? teamStateOf(g1) : { has: true };
    assert(st1.has === false && (st1 as { dissolvedAt?: number }).dissolvedAt === g1?.team?.dissolved_at, "A3 teamStateOf 派生=已解散留档");
    const s1 = (mgr as unknown as { sessions: Map<string, { state: { project_gid?: string } }> }).sessions.get(w1.sid);
    assert(s1?.state.project_gid === undefined, "A4 成员会话脱组（project_gid 清空回无团队态）");
    const retiredEv = listRetiredEvents().filter((e) => e.gid === gid);
    assert(retiredEv.length >= 2 && retiredEv.every((e) => e.cause === "group-disband"), `A5 退休档案留痕（${retiredEv.length} 条 group-disband）`);
    assert(audits.includes("group-dissolve"), "A6 chain-audit group-dissolve 词入账");
    const r2 = await dissolve(gid);
    assert(r2.ok === true && r2.data?.noop === true, `A7 幂等（二次=noop ok，err=${r2.error ?? "无"}）`);

    // ---------- B 在途闸 ----------
    console.log("B 在途闸:");
    const anchorB = mkdtempSync(join(tmpdir(), "td-anchor-b-"));
    const ackB = await send({ command_id: "c2", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "TD-在途组", anchor_dir: anchorB, tier: "轻立项" } } as unknown as Command, "web-1") as { ok: boolean; data?: { group?: { id: string } } };
    const gidB = ackB.data?.group?.id;
    if (!gidB) throw new Error("B 前置建组失败");
    await approveCreate(ackB as never);
    appendDispatch({ id: "disp-open-1", ts: Date.now(), tier: "随手办", target: "someone", project_anchor: anchorB, status: "running", session_id: "sess-x", title: "在途单" });
    const rb = await dissolve(gidB);
    assert(rb.ok === false && String(rb.error ?? "").includes("在途派单") && String(rb.error ?? "").includes("disp-ope") && String(rb.error ?? "").includes("running"), `B1 在途单拦截+清单回显（err=${(rb.error ?? "").slice(0, 60)}）`);
    appendDispatch({ id: "disp-open-1", ts: Date.now(), tier: "随手办", target: "someone", project_anchor: anchorB, status: "done", session_id: "sess-x", title: "收口" });
    const rb2 = await dissolve(gidB);
    assert(rb2.ok === true && rb2.data?.dissolved === true, `B2 收口后放行（ok=${rb2.ok} err=${rb2.error ?? ""}）`);

    // ---------- C 防自毁闸 ----------
    console.log("C 防自毁闸:");
    const anchorC = mkdtempSync(join(tmpdir(), "td-anchor-c-"));
    const ackC2 = await send({ command_id: "c3", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "TD-PM组", anchor_dir: anchorC, tier: "轻立项", pm_session_id: "" } } as unknown as Command, "web-1") as { ok: boolean; data?: { group?: { id: string } } };
    const gidC = ackC2.data?.group?.id;
    if (!gidC) throw new Error("C 前置建组失败");
    await approveCreate(ackC2 as never);
    const pmSid = create(CWD, "TD PM");
    created[created.length - 1].cb.onInit("sdk-pm", "test-model");
    // PM 会话入编 + 置为 leaderId（值守席）
    await send({ command_id: randomUUID(), type: "COMMAND_ORG_ACTION", payload: { action: "member-add", gid: gidC, sid: pmSid, role: "pm" } } as unknown as Command, "web-1");
    (mgr as unknown as { leaderId: string | null }).leaderId = pmSid;
    const rc = await dissolve(gidC);
    assert(rc.ok === false && String(rc.error ?? "").includes("自毁"), `C1 值守 PM 在编=拒（err=${(rc.error ?? "").slice(0, 50)}）`);
    (mgr as unknown as { leaderId: string | null }).leaderId = null;
    const rc2 = await dissolve(gidC);
    assert(rc2.ok === true, "C2 PM 挪走后放行");

    // ---------- D 形态闸 ----------
    console.log("D 形态闸:");
    const rd = await dissolve("pg-does-not-exist");
    assert(rd.ok === false && String(rd.error ?? "").includes("不存在"), "D1 未知组拒");
    const cg = createGroup({ name: "TD-仅项目", anchor_dir: mkdtempSync(join(tmpdir(), "td-anchor-d-")), tier: "轻立项", no_team: true });
    assert(cg.ok && !!cg.group && teamStateOf(cg.group).has === false, "D2 前置：no_team 组=无团队层");
    const rd2 = await dissolve(cg.ok && cg.group ? cg.group.id : "");
    assert(rd2.ok === false && String(rd2.error ?? "").includes("无团队层"), "D3 仅立项目无团队可解散拒收");

    // ---------- E parked 路径（Watchtower 形态） ----------
    console.log("E parked 路径:");
    const anchorE = mkdtempSync(join(tmpdir(), "td-anchor-e-"));
    const ackE = await send({ command_id: "c4", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "TD-挂起组", anchor_dir: anchorE, tier: "轻立项" } } as unknown as Command, "web-1") as { ok: boolean; data?: { group?: { id: string } } };
    const gidE = ackE.data?.group?.id;
    if (!gidE) throw new Error("E 前置建组失败");
    await approveCreate(ackE as never);
    setGroupStatus(gidE, "parked", "测试挂起");
    const re = await dissolve(gidE);
    assert(re.ok === true && re.data?.dissolved === true, `E1 parked 组解散成功（Watchtower 形态——ok=${re.ok} err=${re.error ?? ""}）`);
    const gE = findGroup(gidE);
    assert(gE?.status === "parked" && !!gE.team?.dissolved_at, "E2 parked 态保持+团队层已解（项目保留）");

    // ---------- F 静态锁 ----------
    console.log("F 静态锁:");
    const ROOT = join(import.meta.dirname, "..");
    const smSrc = readFileSync(join(ROOT, "src/session-manager.ts"), "utf-8");
    const wsSrc = readFileSync(join(ROOT, "src/ws-server.ts"), "utf-8");
    const teamSrc = readFileSync(join(ROOT, "..", "web-console/js/team-domain.js"), "utf-8");
    const shellSrc = readFileSync(join(ROOT, "..", "web-console/index-005.html"), "utf-8");
    const cssSrc = readFileSync(join(ROOT, "..", "web-console/css/base.css"), "utf-8");
    const typesSrc = readFileSync(join(ROOT, "src/types.ts"), "utf-8");
    assert(smSrc.includes('case "dissolve"') && smSrc.includes('action === "dissolve"'), "F1 orgAction case+orgCommand 咽喉双面在册（#212 坑防）");
    assert(wsSrc.includes('"dissolve", // [W-TEAMDISSOLVE]'), "F2 HTTP 白名单在册");
    assert(typesSrc.includes('"group-dissolve"'), "F3 chain-audit 词表在册");
    assert(smSrc.includes("防自毁") && smSrc.includes("在途派单未收口") && smSrc.includes("待立项确认（pending）"), "F4 三闸文案锚（自毁/在途/pending）");
    assert(teamSrc.includes("openDissolveModal") && teamSrc.includes('data-dissolve-input') && teamSrc.includes("team-dissolved-toggle"), "F5 UI 弹窗+开合+输入确认在册");
    assert(shellSrc.includes("data-team-dissolve"), "F6 活壳入口钮在册");
    assert(cssSrc.includes(".dissolve-dialog") && cssSrc.includes(".head-dissolve"), "F7 弹窗+入口样式在册");
    void readDispatchLog;

    // ---------- R 组（R1 返修：P1-A confirm_name 闸+P1-B dissolved 双拒+P2-C 词表+P3-G 档案文案） ----------
    console.log("R 返修闸:");
    // R1（P1-A）：无 confirm_name 拒（API 直调无门单发成毁绝迹）/错名拒/幂等不带 confirm 放行
    const rNone = await dissolveRaw(gid); // gid=A 组（已解散态——幂等分支在 confirm 闸之前，恰好证幂等免确认）
    assert(rNone.ok === true && rNone.data?.noop === true, `R1a 幂等分支先于 confirm 闸（重复点击不被确认拦：ok=${rNone.ok} noop=${rNone.data?.noop}）`);
    const anchorR = mkdtempSync(join(tmpdir(), "td-anchor-r-"));
    const ackR = await send({ command_id: "c-r1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "TD-返修组", anchor_dir: anchorR, tier: "轻立项" } } as unknown as Command, "web-1") as { ok: boolean; data?: { group?: { id: string } } };
    const gidR = ackR.data?.group?.id;
    if (!gidR) throw new Error("R 前置建组失败");
    await approveCreate(ackR as never);
    const rBad = await dissolveRaw(gidR);
    assert(rBad.ok === false && String(rBad.error ?? "").includes("confirm_name") && String(rBad.error ?? "").includes("TD-返修组"), `R1b 无 confirm_name 拒（err=${(rBad.error ?? "").slice(0, 60)}）`);
    const rWrong = await dissolveRaw(gidR, "TD-错误名");
    assert(rWrong.ok === false && String(rWrong.error ?? "").includes("confirm_name"), `R1c 错名拒（严格相等——err=${(rWrong.error ?? "").slice(0, 50)}）`);
    // R1（P1-B）：dissolved 组 member-add+dispatch 双拒
    const rOk = await dissolve(gidR); // helper 带对名
    assert(rOk.ok === true && rOk.data?.dissolved === true, `R1d 带对名解散通过（ok=${rOk.ok} err=${rOk.error ?? ""}）`);
    const rAdd = await send({ command_id: "c-r2", type: "COMMAND_ORG_ACTION", payload: { action: "member-add", gid: gidR, sid: "sess-any", role: "worker" } } as unknown as Command, "web-1") as { ok: boolean; error?: string };
    assert(rAdd.ok === false && String(rAdd.error ?? "").includes("团队已解散，不可入编"), `R2a dissolved 组 member-add 拒（err=${(rAdd.error ?? "").slice(0, 60)}）`);
    const rDispatch = mgr.orgAction("dispatch", { anchor: anchorR, prompt: "x", gid: gidR }) as { ok: boolean; error?: string };
    assert(rDispatch.ok === false && String(rDispatch.error ?? "").includes("团队已解散，不可派单"), `R2b dissolved 组 dispatch 拒（err=${(rDispatch.error ?? "").slice(0, 60)}）`);
    // R3（P2-C）：queued/in_review 在途拦截（词表对齐——queued 不再静默中断、in_review 不再悬死）
    setGroupStatus(gidR, "archived", "R3 腾位（dissolved 组归档——项目层收口，团队层已散）"); // active 上限 5：解散不降 status 占位，归档腾名额
    const anchorR3 = mkdtempSync(join(tmpdir(), "td-anchor-r3-"));
    const ackR3 = await send({ command_id: "c-r3", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "TD-词表组", anchor_dir: anchorR3, tier: "轻立项" } } as unknown as Command, "web-1") as { ok: boolean; data?: { group?: { id: string } } };
    const gidR3 = ackR3.data?.group?.id;
    if (!gidR3) throw new Error("R3 前置建组失败: " + JSON.stringify(ackR3).slice(0, 200));
    await approveCreate(ackR3 as never);
    appendDispatch({ id: "disp-q-1", ts: Date.now(), tier: "随手办", target: "someone", project_anchor: anchorR3, status: "queued", session_id: "sess-q", title: "排队单" });
    const rQ = await dissolve(gidR3);
    assert(rQ.ok === false && String(rQ.error ?? "").includes("queued"), `R3a queued 拦截（不再静默中断——err=${(rQ.error ?? "").slice(0, 60)}）`);
    appendDispatch({ id: "disp-q-1", ts: Date.now(), tier: "随手办", target: "someone", project_anchor: anchorR3, status: "in_review", session_id: "sess-q", title: "审查期单" });
    const rI = await dissolve(gidR3);
    assert(rI.ok === false && String(rI.error ?? "").includes("in_review"), `R3b in_review 拦截（不再悬死——err=${(rI.error ?? "").slice(0, 60)}）`);
    // R4（P3-G）：dissolve 档案归因=团队解散（与结项区分——新档不污染）
    const retired = listRetiredEvents();
    assert(retired.some((x) => String((x as { detail?: string }).detail ?? "").includes("团队解散（项目保留）")), `R4a retired 档案 detail=团队解散（项目保留）（${retired.length} 条中 ${retired.filter((x) => String((x as { detail?: string }).detail ?? "").includes("团队解散")).length} 条新语义）`);
    assert(smSrc.includes('disbandGroupMembers(id, "团队解散（项目保留）")'), "R4b 源码锚：dissolve 调用点传新文案");
  } finally {
    const keep = new Set(Object.keys(prev));
    for (const k of Object.keys(process.env)) if (!keep.has(k) && k.startsWith("CCR_")) delete process.env[k];
    Object.assign(process.env, prev);
  }
  console.log(`\nteamdissolve: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

void main().catch((e: unknown) => { console.error("SUITE CRASH:", e); process.exit(1); });
