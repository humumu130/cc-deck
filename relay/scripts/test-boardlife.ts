// boardlife（t-390fd452，1103 用户口径「板就是活的指挥部」）：板卡生命周期审查态+双端 chip 三件套。
//   ①生命周期：worker 交付（close done）→submitted（review_required 自动置位，R2 内核）；
//     需修重派（同题无 entry_id）→打回 claimed（boardfix 刀1 接卡扩态）；再交付→幂等保位；
//     过审收割（board-move submitted→done）→done+资格位清（R3）——每跳 transitions 留痕
//   ②协同：converge（boardfix 72h 强翻/原路径）对 submitted 复核态保护不碾
//   ③chip 数据面（web/expo 文本锚——005 壳闭包不可直跑，test-005-leaderhide 先例）
// 沙盒：CCR_ORG_DIR/CCR_DATA_DIR 隔离+CCR_STORAGE_READ_MODE=json+fake agent（test-boardfix 同款）。
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { loadBoard, moveBoardEntry, upsertBoardEntry, convergeBoardsWithDispatchLog } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0, fail = 0;
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

const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {
        setTimeout(() => {
          if (a.ended) return;
          cb.onLog("assistant_text", "干完了。\n结果：完成｜改动文件：无（测试回执）");
          cb.onTurnEnd(true, "success", 10);
        }, 10);
      }, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        cb.onLog("assistant_text", "干完了。\n结果：完成｜改动文件：无（测试回执）");
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 10);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-boardlife-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-boardlife-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PM_DUTY = "0";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8803, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "m", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "Leader 首建");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const anchor = mkdtempSync(join(tmpdir(), "boardlife-anchor-"));
    const cg = mgr.orgAction("project-create", { name: "boardlife 组", anchor, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(cg.ok === true, "组建");
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });

    // ============ ①生命周期全链 ============
    console.log("①生命周期（交付→submitted→重派打回→再交付→收割 done）:");
    const title = "boardlife 全链验证单";
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "首单", gid, title }) as { ok: boolean; dispatch_id?: string };
    assert(d1.ok === true, "派单");
    await waitFor(() => readDispatchLog().some((e) => e.id === d1.dispatch_id && e.status === "done"));
    const c1 = loadBoard(gid).entries.find((e) => e.dispatch_id === d1.dispatch_id);
    assert((c1?.transitions ?? [])[0]?.status === "claimed", `派单入线 claimed（transitions 首行=${(c1?.transitions ?? [])[0]?.status}——fake 极速交付下中间态由时间线证明）`);
    // fake 交付→收口 done 边：卡应 submitted+review_required（不再直接 done——1103 晚两张在审卡实锤修复面）
    await waitFor(() => {
      const c = loadBoard(gid).entries.find((e) => e.dispatch_id === d1.dispatch_id);
      return c?.status === "submitted";
    });
    const c2 = loadBoard(gid).entries.find((e) => e.dispatch_id === d1.dispatch_id);
    assert(c2?.status === "submitted", `交付→submitted 审查中（实 ${c2?.status}——板不再谎报完成）`);
    assert(c2?.review_required === true, `review_required 自动置位（实 ${JSON.stringify(c2?.review_required)}——R2 内核链接线）`);
    const t2 = (c2?.transitions ?? []).map((t) => t.status);
    assert(t2.join(",") === "claimed,submitted", `transitions 留痕 claimed→submitted（实 ${JSON.stringify(t2)}）`);

    // 需修重派（审查发现问题 R2 续单——同题无 entry_id）→接卡打回 claimed
    const d2 = mgr.orgAction("dispatch", { anchor, prompt: "需修重派", gid, title }) as { ok: boolean; dispatch_id?: string };
    assert(d2.ok === true, "需修重派派发");
    await waitFor(() => {
      const c = loadBoard(gid).entries.find((e) => e.dispatch_id === d2.dispatch_id);
      return c?.status === "claimed" || c?.status === "submitted";
    });
    const c3 = loadBoard(gid).entries.filter((e) => (e.text || "").includes(title.slice(0, 12)));
    assert(c3.length === 1, `同题单卡（submitted 接卡不另开——实 ${c3.length} 张）`);
    assert(c3[0]?.dispatch_id === d2.dispatch_id, "接卡：dispatch_id=续单 id（submitted→claimed 打回）");
    await waitFor(() => readDispatchLog().some((e) => e.id === d2.dispatch_id && e.status === "done"));
    const c4 = loadBoard(gid).entries.find((e) => e.dispatch_id === d2.dispatch_id);
    assert(c4?.status === "submitted", `再交付→submitted 幂等保位（实 ${c4?.status}）`);
    const t4 = (c4?.transitions ?? []).map((t) => t.status);
    assert(t4.join(",") === "claimed,submitted,claimed,submitted", `全链 transitions 五态四跳留痕（实 ${JSON.stringify(t4)}）`);
    assert(t4.filter((s) => s === "submitted").length === 2 && (c4?.transitions ?? []).length === 4, "幂等无重复行（submitted 二跳各一行）");

    // 过审收割（leader-harvest 面人工确认——板面搬卡 board-move：submitted→done 合法迁移+R3 清位）
    const mv = moveBoardEntry(gid, c4!.id, "done");
    assert(mv.ok === true, `收割搬卡 submitted→done（${mv.ok ? "ok" : mv.error}）`);
    const c5 = loadBoard(gid).entries.find((e) => e.id === c4!.id);
    assert(c5?.status === "done", `过审收割→done（实 ${c5?.status}——真完成才进完成泳道）`);
    assert(!(c5 as { review_required?: boolean }).review_required, "done 清资格位（R3 复核闭环——终态无复核态）");
    const t5 = (c5?.transitions ?? []).map((t) => t.status);
    assert(t5[t5.length - 1] === "done", `收割跳 transitions 入线（实 ${JSON.stringify(t5)}）`);

    // ============ ①b 题名漂移双卡（PM boardfix 回执 R3 复核补注①顺带） ============
    console.log("①b 题名漂移接卡（精确 miss→前缀回落 ≤12 字尾缀）:");
    const driftTitle = "boardlife 漂移卡基题";
    const driftDid = "d-drift-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 80 * 3600_000, id: driftDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-df", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 79 * 3600_000, id: driftDid, tier: "正经立项", target: "x", status: "done", session_id: "s-df", project_anchor: anchor });
    upsertBoardEntry(gid, { text: driftTitle + "【密钥切换重派】", status: "backlog", dispatch_id: driftDid }); // 漂移形态：题名+短尾缀
    const dDrift = mgr.orgAction("dispatch", { anchor, prompt: "漂移重派测", gid, title: driftTitle }) as { ok: boolean; dispatch_id?: string };
    assert(dDrift.ok === true, "漂移重派派发 ok");
    await waitFor(() => readDispatchLog().some((e) => e.id === dDrift.dispatch_id && e.status === "done"));
    const driftCards = loadBoard(gid).entries.filter((e) => (e.text || "").startsWith(driftTitle));
    assert(driftCards.length === 1 && driftCards[0]?.dispatch_id === dDrift.dispatch_id, `漂移卡前缀回落接回（实 ${driftCards.length} 张——历史双卡 t-28943119 形态闭合）`);
    // 尾缀长度闸：尾缀 >12 字的长漂移不接（防同前缀异任务误接）
    const farTitle = "boardlife 长漂移卡基题";
    const farDid = "d-far-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 80 * 3600_000, id: farDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-far", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 79 * 3600_000, id: farDid, tier: "正经立项", target: "x", status: "done", session_id: "s-far", project_anchor: anchor });
    upsertBoardEntry(gid, { text: farTitle + "——这是一段超过十二个字的长尾缀注记不接", status: "backlog", dispatch_id: farDid });
    const dFar = mgr.orgAction("dispatch", { anchor, prompt: "长漂移重派测", gid, title: farTitle }) as { ok: boolean; dispatch_id?: string };
    assert(dFar.ok === true, "长漂移重派派发 ok");
    await waitFor(() => readDispatchLog().some((e) => e.id === dFar.dispatch_id && e.status === "done"));
    const farOld = loadBoard(gid).entries.find((e) => e.dispatch_id === farDid);
    assert(farOld?.dispatch_id === farDid, "长尾缀旧卡 dispatch_id 未被改写（不误接）");
    const farCards = loadBoard(gid).entries.filter((e) => (e.text || "").startsWith(farTitle));
    assert(farCards.length === 2, `长漂移开新卡双卡并存（实 ${farCards.length} 张——>12 字尾缀=异任务判定，不误接）`);
    // 审后修正负例（review-w-boardlife-b-1103 P2）：submitted 等审卡不被回落劫持——
    // 漂移回落限 backlog（待审交付旁路审查闭环=禁区；精确等值仍可接 submitted）
    const subDriftTitle = "boardlife 等审漂移卡基题";
    const sdDid = "d-sd-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 80 * 3600_000, id: sdDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-sd", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 79 * 3600_000, id: sdDid, tier: "正经立项", target: "x", status: "done", session_id: "s-sd", project_anchor: anchor });
    upsertBoardEntry(gid, { text: subDriftTitle + "【等审中】", status: "backlog", dispatch_id: sdDid });
    upsertBoardEntry(gid, { id: loadBoard(gid).entries.find((e) => e.dispatch_id === sdDid)!.id, text: subDriftTitle + "【等审中】", status: "done", review_required: true }); // →submitted
    const dSubDrift = mgr.orgAction("dispatch", { anchor, prompt: "等审漂移重派测", gid, title: subDriftTitle }) as { ok: boolean; dispatch_id?: string };
    assert(dSubDrift.ok === true, "等审漂移重派派发 ok");
    await waitFor(() => readDispatchLog().some((e) => e.id === dSubDrift.dispatch_id && e.status === "done"));
    const sdCards = loadBoard(gid).entries.filter((e) => (e.text || "").startsWith(subDriftTitle));
    const sdOld = sdCards.find((e) => e.dispatch_id === sdDid);
    assert(sdOld?.status === "submitted" && sdOld?.dispatch_id === sdDid, `等审卡不被回落劫持（实 ${sdOld?.status}/${sdOld?.dispatch_id?.slice(0, 8)}——回落限 backlog，审查闭环不被旁路）`);
    assert(sdCards.length === 2, `等审漂移开新卡（实 ${sdCards.length} 张——精确等值 miss 时 submitted 不进回落池）`);

    // ============ ②boardfix 协同：converge 复核态保护 ============
    console.log("②协同（converge 不碾 submitted/强翻豁免新态兼容）:");
    const subDid = "d-sub-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: subDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-s", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: subDid, tier: "正经立项", target: "x", status: "done", session_id: "s-s", project_anchor: anchor });
    const subCard = upsertBoardEntry(gid, { text: "boardlife 审查卡（converge 不碾对照）", status: "submitted", review_required: true, dispatch_id: subDid }) as { ok: boolean; entry?: { id: string } };
    const convR = convergeBoardsWithDispatchLog();
    const subAfter = loadBoard(gid).entries.find((e) => e.id === subCard.entry?.id);
    assert(subAfter?.status === "submitted", `submitted 复核态保护（实 ${subAfter?.status}——72h 台账 done 在场也不碾，done 出口=过审收割面）`);
    // 审后修正负例（review-w-boardlife-a-1103 P1）：submitted 被人工 board-move 退
    // backlog（审查打回·不做重派形态）→ 72h 强翻豁免必须命中（[claimed,submitted,backlog]
    // 序列无 done 行——原判据漏，被否决的活被强翻标完成）
    const rbDid = "d-rb-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: rbDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-rb", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: rbDid, tier: "正经立项", target: "x", status: "done", session_id: "s-rb", project_anchor: anchor });
    upsertBoardEntry(gid, { text: "boardlife 打回卡（submitted 退 backlog 不强翻）", status: "claimed", dispatch_id: rbDid });
    const rbCard = loadBoard(gid).entries.find((e) => e.dispatch_id === rbDid);
    upsertBoardEntry(gid, { id: rbCard!.id, text: rbCard!.text, status: "done", review_required: true }); // R2→submitted
    moveBoardEntry(gid, rbCard!.id, "backlog"); // 人工审查打回
    const rbPre = loadBoard(gid).entries.find((e) => e.id === rbCard!.id);
    assert(rbPre?.status === "backlog" && (rbPre?.transitions ?? []).map((t) => t.status).join(",") === "claimed,submitted,backlog", `打回形态就位（实 ${rbPre?.status}/${JSON.stringify((rbPre?.transitions ?? []).map((t) => t.status))}）`);
    const convR2 = convergeBoardsWithDispatchLog();
    const rbAfter = loadBoard(gid).entries.find((e) => e.id === rbCard!.id);
    assert(rbAfter?.status === "backlog" && convR2.skipped >= 1, `submitted 打回卡豁免强翻（实 ${rbAfter?.status}/skipped=${convR2.skipped}——审查否决不被程序翻成完成）`);
    // 对照：真陈卡形态（[claimed] 无候选行，8 卡实锤形态）照翻不挡治愈
    const tcDid = "d-tc-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: tcDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-tc", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: tcDid, tier: "正经立项", target: "x", status: "done", session_id: "s-tc", project_anchor: anchor });
    upsertBoardEntry(gid, { text: "boardlife 真陈卡对照（无候选行照翻）", status: "claimed", dispatch_id: tcDid });
    const tcId = loadBoard(gid).entries.find((e) => e.dispatch_id === tcDid)!.id;
    const tcPre = loadBoard(gid).entries.find((e) => e.dispatch_id === tcDid);
    // 手术：把 claimed 行保留、status 置 backlog（模拟旧裸设/out-of-board 8 卡真实形态）
    const boardPath2 = join(ORG, "boards", `${gid}.json`);
    const rawB2 = JSON.parse(readFileSync(boardPath2, "utf8")) as { entries: { id: string; status?: string }[] };
    rawB2.entries.find((e) => e.id === tcId)!.status = "backlog";
    writeFileSync(boardPath2, JSON.stringify(rawB2, null, 2));
    const tcR = convergeBoardsWithDispatchLog();
    const tcAfter = loadBoard(gid).entries.find((e) => e.id === tcId);
    assert(tcAfter?.status === "done" && tcR.moved >= 1, `真陈卡（[claimed] 无候选行）照翻治愈（实 ${tcAfter?.status}/moved=${tcR.moved}——豁免扩点不挡主路径）`);

    // ============ ③chip 数据面（web/expo 文本锚） ============
    console.log("③chip 三件（web+expo 文本锚——闭包/组件不可直跑）:");
    const td = readFileSync(join(process.cwd(), "..", "web-console", "js", "team-domain.js"), "utf8");
    assert(td.includes('owner-jump'), "web②执行者 chip 可点态（owner-jump 有主挂牌）");
    assert(td.includes("escape(task.owner_session)") && td.includes("data-team-member-session"), "web②跳转属性挂执行者 sid（同一委托链）");
    assert(td.includes('待指派审查'), "web③无 PM 灰牌文案在");
    assert(td.includes('审查中 · ') && td.includes('tchip reviewer'), "web③PM 在岗处理者 chip 在");
    const pmFind = 'members(project).find((m) => String(m && m.role || "").toLowerCase() === "pm"';
    assert(td.includes(pmFind), "web③数据源=组内 PM 席位行（members role=pm）");
    const tdp = readFileSync(join(process.cwd(), "..", "expo-app", "src", "screens", "TeamDetailPage.tsx"), "utf8");
    assert(tdp.includes("onOpenSession(e.owner_session!)"), "expo②执行者 chip 点按直达会话（onOpenSession 链）");
    assert(tdp.includes("审查中 · {pmName}"), "expo③PM 处理者 chip 文案在");
    assert(tdp.includes("待指派审查"), "expo③灰牌降级在");
    assert(tdp.includes('String(m?.role || "").toLowerCase() === "pm"'), "expo③数据源同口径（members role=pm）");
    const sm = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf8");
    assert(sm.includes('status: "done", review_required: true }'), "①交付边完成候选链接线锚在");
    assert(sm.includes('x.status === "backlog" || x.status === "submitted"'), "①接卡扩 submitted（需修重派打回）锚在");
    const pj = readFileSync(join(process.cwd(), "src", "projects.ts"), "utf8");
    assert(pj.includes('entry.status === "submitted" || entry.status === "ready_to_install" || entry.status === "planned") continue'), "②converge 复核态保护锚在（planlane 批：planned 规划态同款保护）");
    const patrolSrc = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf8");
    assert(patrolSrc.includes("board-submitted-stale") && patrolSrc.includes("CCR_BOARD_SUBMITTED_STALE_MS"), "④收割兜底铃锚在（review-b P1：submitted 滞留>24h 巡检提醒——PM 漏收不再永挂）");
    // R2-P1：slim 兜底——bridge selectSessionCard else 分支接 SlimUi.open（DOM 无卡但快照在→直选）
    const bridge = readFileSync(join(process.cwd(), "..", "web-console", "js", "bridge-core.js"), "utf8");
    assert(bridge.includes("__ccDeck005SlimUi?.open") && bridge.includes("__ccDeck005SlimUi?.has?.(sid)"), "R2-P1 slim 兜底锚在（bridge else 分支→SlimUi.open 直选——E2E E6 实证）");
    const sess = readFileSync(join(process.cwd(), "..", "web-console", "js", "session-domain.js"), "utf8");
    assert(sess.includes("has: (sid) => S.sessions.has"), "R2-P1 has 探测口锚在（SlimUi freeze 对象）");
    // R2-2：泳道头「审查中」（用户 1103 点名「甬道为什么叫待审查」）——一处词表全跟随
    assert(td.includes('["submitted", "审查中"]') && !td.includes('["submitted", "待审查"]'), "R2-2 web lanes 词表=审查中（待审查绝迹）");
    assert(sess.includes('["submitted", "审查中"]'), "R2-2 web 抽屉词表同词");
    const tdpR2 = readFileSync(join(process.cwd(), "..", "expo-app", "src", "screens", "OrgZone.tsx"), "utf8");
    assert(tdpR2.includes('["submitted", "审查中"]'), "R2-2 expo BOARD_LANES 同词（OrgZone 定义双屏消费）");
  } finally {
    Object.keys(prev).forEach((k) => { process.env[k] = prev[k]; });
  }
  console.log(`\n========== boardlife 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
