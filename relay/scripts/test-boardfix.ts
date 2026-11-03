// boardfix（t-be03429f，1103 用户实锤「看板说谎」）：三刀断言。
//   刀1 重派接卡：dispatch 无 entry_id+题名匹配 backlog 陈卡 → 接回同卡（新 dispatch_id
//   写入+note 留痕），不另开新卡（同题双卡根断）
//   刀2 收割翻面强翻分支：backlog 卡+台账 done>72h → 绕 updated_at 防碾直接翻 done
//   （8 卡实锤全被「updated_at>doneAt 不碾」误挡——收口后刷文本不改态的 upd 不该挡）
//   刀3 周期自愈：converge 从 boot-only 挂 patrol runFull（30min 周期+boot 保留）
// 沙盒：CCR_ORG_DIR 隔离（org-defects 批范式）+fake agent（test-org-defects 同款）。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { createGroup, findGroup, loadBoard, upsertBoardEntry } from "../src/projects.js";
import { convergeBoardsWithDispatchLog } from "../src/projects.js";
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
        // R2 收口补：veteran 复用席投递走 sendMessage（dispatchWorker :8098）——空操作
        // 会让续单回合永不结束（收口不落=d2 done 行缺席）。新会话不经此路（firstMessage
        // 走工厂参数），无双发风险。
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
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-boardfix-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-boardfix-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PM_DUTY = "0";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8801, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "m", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "Leader 首建");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const anchor = mkdtempSync(join(tmpdir(), "boardfix-anchor-"));
    const cg = mgr.orgAction("project-create", { name: "boardfix 组", anchor, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(cg.ok === true, "组建");
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });

    // ============ 刀1：重派接卡 ============
    console.log("刀1 重派接卡（题名匹配 backlog 陈卡→同卡接续）:");
    const title1 = "boardfix 续单验证单（R1 首单）";
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "R1 首单干完", gid, title: title1 }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d1.ok === true, "R1 派发");
    await waitFor(() => readDispatchLog().some((e) => e.id === d1.dispatch_id && e.status === "done"));
    await waitFor(() => !((mgr as unknown as { openDispatches: Map<string, unknown[]> }).openDispatches.get((d1 as { session_id: string }).session_id)?.length));
    // 收口后卡应 submitted（boardlife ①：交付=完成候选——原直翻 done 语义升级，done 出口
    // 移至过审收割面）——手动退回 backlog 模拟「重派前旧卡滞留」形态
    const cardAfterDone = loadBoard(gid).entries.find((e) => e.dispatch_id === d1.dispatch_id);
    assert(cardAfterDone?.status === "submitted" && cardAfterDone?.review_required === true, `R1 收口卡翻 submitted 审查中（常路在——boardlife 交付候选；实 ${cardAfterDone?.status}/${JSON.stringify(cardAfterDone?.review_required)}）`);
    upsertBoardEntry(gid, { id: cardAfterDone!.id, text: cardAfterDone!.text, status: "backlog" });
    const staleCount = loadBoard(gid).entries.filter((e) => e.text === title1).length;
    assert(staleCount === 1, "陈卡回 backlog（形态 A 场景就位）");
    // 重派同题（无 entry_id——leader-dispatch bash 形态）
    const d2 = mgr.orgAction("dispatch", { anchor, prompt: "R2 续单再干", gid, title: title1 }) as { ok: boolean; dispatch_id?: string };
    assert(d2.ok === true, "R2 重派派发");
    const d2Done = await waitFor(() => readDispatchLog().some((e) => e.id === d2.dispatch_id && e.status === "done"));
    assert(d2Done, "R2 收口落账（veteran 续单回合完成——超时即夹具回归）");
    await waitFor(() => !((mgr as unknown as { openDispatches: Map<string, unknown[]> }).openDispatches.get((d2 as unknown as { session_id?: string })?.session_id ?? "")?.length));
    const board2 = loadBoard(gid);
    const sameTitle = board2.entries.filter((e) => (e.text || "").includes(title1.slice(0, 12)));
    assert(sameTitle.length === 1, `同题单卡（接卡不另开——实 ${sameTitle.length} 张）`);
    const adopted = sameTitle[0];
    assert(adopted.dispatch_id === d2.dispatch_id, "卡 dispatch_id=新续单 id（接回）");
    assert(String(adopted.note || "").includes("boardfix 续单接卡"), `note 留痕续单（实 ${JSON.stringify(adopted.note).slice(0, 60)}）`);
    // R2 收口补：transitions 留痕——接卡走认领分支必入 claimed 行，R2 收口翻面入 done 行
    //（moveEntryByDispatch 此前不记线=自愈/联动翻面卡内无痕的结构性缺口，R2 已补齐）
    const adoptedT = (adopted.transitions ?? []).map((t) => t.status);
    assert(adoptedT.includes("claimed"), `transitions 记续单认领（claimed 入线——实 ${JSON.stringify(adoptedT)}）`);
    assert(adoptedT[adoptedT.length - 1] === "submitted", `transitions 末行 submitted（R2 收口翻面入线——boardlife 交付候选；实 ${JSON.stringify(adoptedT)}）`);

    // ============ 刀2：收敛扫 72h 强翻分支 ============
    console.log("刀2 收割翻面（backlog+台账 done>72h 强翻绕防碾）:");
    // 造陈卡：卡带旧 dispatch_id+log 该 id done 于 73h 前+updated_at 晚于 done（防碾误挡形态）
    const oldDid = "d-stale-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: oldDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-x", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: oldDid, tier: "正经立项", target: "x", status: "done", session_id: "s-x", project_anchor: anchor });
    const staleCard = upsertBoardEntry(gid, { text: "boardfix 陈卡（72h 前已收割）", status: "backlog", dispatch_id: oldDid });
    assert(staleCard.ok, "陈卡建");
    const staleCardOk = staleCard as { ok: true; entry: { id: string; text: string } };
    // 刷 updated_at 到「晚于 done」（防碾挡板形态——8 卡实锤全在此）
    upsertBoardEntry(gid, { id: staleCardOk.entry.id, text: staleCardOk.entry.text, note: "后来刷过文本（updated_at 推新形态）" });
    assert(convergeBoardsWithDispatchLog().moved >= 1, "收敛扫翻正 ≥1（72h 强翻分支生效）");
    const afterConverge = loadBoard(gid).entries.find((e) => e.id === staleCardOk.entry.id);
    assert(afterConverge?.status === "done", `陈卡翻 done（实 ${afterConverge?.status}——绕过 updated_at 防碾）`);
    // R2 收口补：自愈翻正 transitions 留痕（卡内时间线可见）+幂等（二扫无重复行）
    const healT = (afterConverge?.transitions ?? []).map((t) => t.status);
    assert(healT[healT.length - 1] === "done", `自愈翻正 transitions 末行 done（实 ${JSON.stringify(healT)}）`);
    const healTLen = healT.length;
    convergeBoardsWithDispatchLog();
    const healT2 = (loadBoard(gid).entries.find((e) => e.id === staleCardOk.entry.id)?.transitions ?? []).map((t) => t.status);
    assert(healT2.length === healTLen && healT2[healT2.length - 1] === "done", "二扫幂等（done 卡跳过——transitions 无重复行）");
    // 对照①：非 backlog 在途态（claimed）同条件不碾（人工流程中不碰）
    const claimDid = "d-claim-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: claimDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-y", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: claimDid, tier: "正经立项", target: "x", status: "done", session_id: "s-y", project_anchor: anchor });
    const claimR = upsertBoardEntry(gid, { text: "boardfix 在途卡（claimed 不碾对照）", status: "claimed", dispatch_id: claimDid }) as { ok: boolean; entry?: { id: string } };
    convergeBoardsWithDispatchLog();
    const claimAfter = loadBoard(gid).entries.find((e) => e.id === claimR.entry?.id);
    assert(claimAfter?.status === "claimed", "对照：claimed 在途态零碾压（人工流程卡不碰）");
    // 对照②：71h 新鲜窗内 backlog 不翻（72h 豁免窗语义）
    const freshDid = "d-fresh-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 71 * 3600_000, id: freshDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-z", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 71 * 3600_000 + 1000, id: freshDid, tier: "正经立项", target: "x", status: "done", session_id: "s-z", project_anchor: anchor });
    const freshCard = upsertBoardEntry(gid, { text: "boardfix 新鲜卡（71h 窗内不翻对照）", status: "backlog", dispatch_id: freshDid }) as { ok: boolean; entry?: { id: string } };
    convergeBoardsWithDispatchLog();
    const freshAfter = loadBoard(gid).entries.find((e) => e.id === freshCard.entry?.id);
    assert(freshAfter?.status === "backlog", `对照②：71h 窗内零翻动（实 ${freshAfter?.status}——72h 强翻分支不触发+原路径被 updated_at 防碾挡（fresh 卡 upd=建卡时刻晚于 71h 前 done），窗内豁免语义成立）`);
    // 对照③（R2 收口补钉）：failed 终态不翻 done——失败单留板待人处置（#236 D 既有
    // 拍板），重派时由刀1 接卡兜住；自愈只认 done（已收割≠已失败）
    const failDid = "d-fail-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: failDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-f", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: failDid, tier: "正经立项", target: "x", status: "failed", session_id: "s-f", project_anchor: anchor });
    const failCard = upsertBoardEntry(gid, { text: "boardfix 失败单卡（failed 不翻 done 对照）", status: "backlog", dispatch_id: failDid }) as { ok: boolean; entry?: { id: string } };
    convergeBoardsWithDispatchLog();
    const failAfter = loadBoard(gid).entries.find((e) => e.id === failCard.entry?.id);
    assert(failAfter?.status === "backlog", `对照③：failed 终态零翻动（实 ${failAfter?.status}——失败留板待人，自愈只认 done）`);

    // ============ R3-P1：强翻两道人工意图豁免（B 审攻击脚本 attack2 复现形态） ============
    console.log("R3 强翻豁免（人工重开/hold 卡不被碾+计数明示）:");
    // 豁免①人工重开（attack2a）：done 交付卡→人工退 backlog（transitions 留 backlog 行 ts>doneAt）
    const reDid = "d-reopen-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 100 * 3600_000, id: reDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-r1", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 99 * 3600_000, id: reDid, tier: "正经立项", target: "x", status: "done", session_id: "s-r1", project_anchor: anchor });
    const reCard = upsertBoardEntry(gid, { text: "boardfix 人工重开卡（返工等重派）", status: "done", dispatch_id: reDid }) as { ok: boolean; entry?: { id: string; text: string } };
    upsertBoardEntry(gid, { id: reCard.entry!.id, text: reCard.entry!.text, status: "backlog", note: "[人工重开] 收割后发现要返工" });
    const r3a = convergeBoardsWithDispatchLog();
    const reAfter = loadBoard(gid).entries.find((e) => e.id === reCard.entry!.id);
    assert(reAfter?.status === "backlog", `豁免①人工重开卡不被碾（实 ${reAfter?.status}——R2 时代 2ms 内被碾回 done，transitions 罪证链 backlog(人工)→done(程序)绝迹）`);
    assert((reAfter?.transitions ?? []).some((t) => t.status === "backlog"), "豁免判据=done 后 backlog 迁移行在（R2 留痕恰给判据）");
    assert(r3a.skipped >= 1, `豁免命中计 skipped（实 ${r3a.skipped}——通知改述「跳过 N 张疑似人工在管」，不静默不谎报）`);
    // 豁免②hold 锁（attack2b）：backlog+hold:{reason} 不翻（防 held+done 脏态）
    const hdDid = "d-hold-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 100 * 3600_000, id: hdDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-r2", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 99 * 3600_000, id: hdDid, tier: "正经立项", target: "x", status: "done", session_id: "s-r2", project_anchor: anchor });
    const hdCard = upsertBoardEntry(gid, { text: "boardfix hold 卡（等装机回流）", status: "backlog", dispatch_id: hdDid }) as { ok: boolean; entry?: { id: string; text: string } };
    upsertBoardEntry(gid, { id: hdCard.entry!.id, text: hdCard.entry!.text, hold: { reason: "等装机回流" } });
    const r3b = convergeBoardsWithDispatchLog();
    const hdAfter = loadBoard(gid).entries.find((e) => e.id === hdCard.entry?.id);
    assert(hdAfter?.status === "backlog", `豁免②hold 卡不被翻（实 ${hdAfter?.status}——锁语义「这卡别动」被尊重，无 held+done 脏态）`);
    assert(!!hdAfter?.hold && String((hdAfter.hold as { reason?: string }).reason || "").includes("回流"), "hold 字段原样保留（无脏态残留）");
    assert(r3b.skipped >= 1, `hold 豁免同样计 skipped（实 ${r3b.skipped}）`);
    // 豁免不挡治愈：无人工行的 73h 陈卡照翻（上方 staleCard 已证）+强翻审计词发射
    const auditHits: string[] = [];
    const dupDid = "d-audit-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: dupDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-a", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: dupDid, tier: "正经立项", target: "x", status: "done", session_id: "s-a", project_anchor: anchor });
    upsertBoardEntry(gid, { text: "boardfix 审计卡（强翻入审计流）", status: "backlog", dispatch_id: dupDid });
    const r3c = convergeBoardsWithDispatchLog(undefined, (action, detail) => auditHits.push(action + "|" + detail));
    assert(r3c.moved >= 1 && auditHits.some((x) => x.startsWith("board-force-close|")), `强翻命中发 board-force-close 审计（实 ${JSON.stringify(auditHits.slice(0, 2))}——自愈动作入审计流）`);
    // R3-P2-1：moveEntryByDispatch 返回 boolean——同 dispatch_id 双卡第二张 no-op 不虚计
    const twinDid = "d-twin-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 73 * 3600_000, id: twinDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-t", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 73 * 3600_000 + 1000, id: twinDid, tier: "正经立项", target: "x", status: "done", session_id: "s-t", project_anchor: anchor });
    upsertBoardEntry(gid, { text: "boardfix 双卡一（共享 dispatch_id）", status: "backlog", dispatch_id: twinDid });
    upsertBoardEntry(gid, { text: "boardfix 双卡二（共享 dispatch_id）", status: "backlog", dispatch_id: twinDid });
    const r3d = convergeBoardsWithDispatchLog();
    assert(r3d.moved === 1, `boolean 计数只认真翻（实 moved=${r3d.moved}——第二张 no-op 不虚报，A 审 2.3 计数失真收口）`);

    // ============ R3-P2-2：接卡验旧单终态 + note 如实 + 题名 60 对称 ============
    console.log("R3 接卡终态预检（未终态不接+note 如实）:");
    // 未终态（在跑）旧单卡：不接卡（新开）+note 不谎注
    const runDid = "d-running-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 2 * 3600_000, id: runDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-run", project_anchor: anchor });
    const runTitle = "boardfix 在跑单卡（不得被接）";
    upsertBoardEntry(gid, { text: runTitle, status: "backlog", dispatch_id: runDid });
    const dRun = mgr.orgAction("dispatch", { anchor, prompt: "在跑单重派测", gid, title: runTitle }) as { ok: boolean; dispatch_id?: string };
    assert(dRun.ok === true, "在跑单同题重派派发 ok");
    const runCards = loadBoard(gid).entries.filter((e) => e.text === runTitle);
    const runOld = runCards.find((e) => e.dispatch_id === runDid);
    assert(!!runOld && !String(runOld.note || "").includes("已终态"), "未终态旧卡零接卡零谎注（note 无「已终态」——新开新卡）");
    assert(runCards.length >= 2 || runOld?.dispatch_id === runDid, `在跑旧卡 dispatch_id 不被改写（实 ${runOld?.dispatch_id}——旧单成果不脱钩）`);
    // done 终态旧单卡：接卡+note 如实带终态词
    const doneTitle = "boardfix done 单卡（可接+如实词）";
    const dnDid = "d-done-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 80 * 3600_000, id: dnDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-dn", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 79 * 3600_000, id: dnDid, tier: "正经立项", target: "x", status: "done", session_id: "s-dn", project_anchor: anchor });
    upsertBoardEntry(gid, { text: doneTitle, status: "backlog", dispatch_id: dnDid });
    const dDone = mgr.orgAction("dispatch", { anchor, prompt: "done 单重派测", gid, title: doneTitle }) as { ok: boolean; dispatch_id?: string };
    await waitFor(() => readDispatchLog().some((e) => e.id === dDone.dispatch_id && e.status === "done"));
    const dnAdopted = loadBoard(gid).entries.filter((e) => e.text === doneTitle).find((e) => e.dispatch_id === dDone.dispatch_id);
    assert(!!dnAdopted && dnAdopted.dispatch_id === dDone.dispatch_id, "done 终态卡照接（豁免不挡治愈路径）");
    assert(String(dnAdopted?.note || "").includes("已终态（done）"), `note 如实带终态词（实 ${JSON.stringify((dnAdopted?.note || "").slice(0, 80))}）`);
    // 题名 60 截断对称：无题名长首行（>60 字）派单的滞留卡可被接（R3 前键取全行恒不匹配=静默双卡）
    const longFirst = "无题名长首行派单压测".padEnd(72, "长") + "尾";
    const lgDid = "d-long-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 80 * 3600_000, id: lgDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-lg", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 79 * 3600_000, id: lgDid, tier: "正经立项", target: "x", status: "done", session_id: "s-lg", project_anchor: anchor });
    upsertBoardEntry(gid, { text: longFirst.slice(0, 60), status: "backlog", dispatch_id: lgDid }); // 建卡边形态：text=首行 60 截断
    const dL2 = mgr.orgAction("dispatch", { anchor, prompt: longFirst + "\n正文", gid }) as { ok: boolean; dispatch_id?: string };
    assert(dL2.ok === true, "无题名长首行重派 ok（title 缺省形态）");
    await waitFor(() => readDispatchLog().some((e) => e.id === dL2.dispatch_id && e.status === "done"));
    const longCards = loadBoard(gid).entries.filter((e) => e.text === longFirst.slice(0, 60));
    assert(longCards.length === 1 && longCards[0]?.dispatch_id === dL2.dispatch_id, `长首行滞留卡接回（实 ${longCards.length} 张、dispatch=${String(longCards[0]?.dispatch_id).slice(0, 10)}——A 审 1.1 键口径截 60 对称后不再静默双卡）`);

    // ============ R3 文件锚：通知改述/tx 包裹/审计词表 ============
    console.log("R3 文件锚（通知改述+tx 域+词表）:");
    const patrolSrcR3 = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf8");
    assert(patrolSrcR3.includes("疑似人工在管") && patrolSrcR3.includes("converged.skipped"), "patrol 通知改述（跳过 N 张疑似人工在管——不静默不谎报）");
    assert(patrolSrcR3.includes("board-force-close"), "patrol 强翻审计回调在");
    const projectsSrc = readFileSync(join(process.cwd(), "src", "projects.ts"), "utf8");
    assert(projectsSrc.includes("return withOrgWriteTx(dir, () => {"), "moveEntryByDispatch 入 withOrgWriteTx 互斥域（第四写口，B 审 P2-1）");
    assert(projectsSrc.includes("board-force-close"), "converge 强翻审计词发射在");
    const typesSrcR3 = readFileSync(join(process.cwd(), "src", "types.ts"), "utf8");
    assert(typesSrcR3.includes('"board-force-close"'), "board-force-close 入审计词表");
    assert(!/continuity-disclose",\n\s*"board-adopt", \/\/ boardfix[^\n]*\/\/ C-MODE-B2/.test(typesSrcR3), "types 注释错位已修（C-MODE-B2 注释归位 continuity-disclose 行）");

    // ============ R3 补（双审缺口三件：B-P0-2 毒自愈 / B-P2① 就绪闸 / B-P1① recon 守护） ============
    console.log("R3 补：毒行自愈+接卡就绪闸+recon 人工重开守护:");
    // ① B-P0-2：pm-reconcile 带外形状 {at,by,note,status}（ts 缺席）→ 读入归一 ts←at → 机写复活
    const poisonCard = upsertBoardEntry(gid, { text: "boardfix 毒行卡（带外写形状）", status: "done" }) as { ok: boolean; entry?: { id: string } };
    const boardPath = join(ORG, "boards", `${gid}.json`);
    const rawBoard = JSON.parse(readFileSync(boardPath, "utf8")) as { entries: { id: string; transitions?: unknown[] }[] };
    const pe = rawBoard.entries.find((e) => e.id === poisonCard.entry?.id);
    assert(!!pe, "毒行卡就位");
    pe!.transitions = [{ status: "claimed", ts: Date.now() - 1000 }, { at: Date.now(), by: "pm-reconcile-test", note: "陈卡翻正（带外对账脚本形态）", status: "done" }];
    writeFileSync(boardPath, JSON.stringify(rawBoard, null, 2));
    const healedRows = (loadBoard(gid).entries.find((e) => e.id === poisonCard.entry?.id)?.transitions ?? []) as { status?: string; ts?: number; at?: number; by?: string }[];
    assert(healedRows.length === 2 && healedRows.every((r) => typeof r.ts === "number"), `毒行读入归一（ts←at——实 ${JSON.stringify(healedRows[1]).slice(0, 90)}）`);
    assert(healedRows[1]?.by === "pm-reconcile-test", "归一行超额键保留（by/note 不删——schema 只查 status/ts）");
    const rewrite = upsertBoardEntry(gid, { id: pe!.id, text: "boardfix 毒行卡（带外写形状·改）" });
    assert(rewrite.ok === true, "毒行卡机写复活（归一后 schema 不再拒——瓷娃娃解除）");
    // ② B-P2①：接卡就绪闸——gated backlog 陈卡同题派单不被侧门认领（新开新卡，旧卡带 gate 原地留人）
    const gateTitle = "boardfix 门卡（gate 未过不得被接）";
    upsertBoardEntry(gid, { text: gateTitle, status: "backlog", gate: { reason: "等用户拍板" } });
    const dGate = mgr.orgAction("dispatch", { anchor, prompt: "门卡重派测", gid, title: gateTitle }) as { ok: boolean; dispatch_id?: string };
    assert(dGate.ok === true, "门卡同题派发 ok");
    await waitFor(() => readDispatchLog().some((e) => e.id === dGate.dispatch_id && e.status === "done"));
    const gateCards = loadBoard(gid).entries.filter((e) => e.text === gateTitle);
    const gateOld = gateCards.find((e) => e.status === "backlog");
    assert(!!gateOld && !!gateOld.gate, "门卡不被侧门认领（backlog+gate 原样——:7682 前置检查口径对称）");
    assert(gateCards.length === 2, `新卡开立不混认（实 ${gateCards.length} 张——跳过入审计不静默）`);
    // ③ B-P1①：recon 人工重开守护——done 终态后的 backlog 重开卡不被 1h 窗 recon 碾回 done
    const rgDid = "d-reguard-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 2 * 3600_000, id: rgDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-rg", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 2 * 3600_000 + 1000, id: rgDid, tier: "正经立项", target: "x", status: "done", session_id: "s-rg", project_anchor: anchor });
    upsertBoardEntry(gid, { text: "boardfix 人工重开卡（recon 不碾）", status: "backlog", dispatch_id: rgDid }); // 建卡即记 backlog 行@now——晚于 done=重开形态
    (mgr as unknown as { runLedgerRecon: (t: string) => void }).runLedgerRecon("boardfix-test");
    const reGuard = loadBoard(gid).entries.filter((e) => e.dispatch_id === rgDid)[0];
    assert(reGuard?.status === "backlog", `recon 守护：人工重开卡不被碾（实 ${reGuard?.status}——1h 窗零防碾对 30-90min 人口的碾压面已封）`);
    const convGuard = convergeBoardsWithDispatchLog();
    assert(convGuard.skipped >= 1, `converge 豁免同判据（skipped 计数——实 ${JSON.stringify(convGuard)}）`);
    // recon 正向对照：claimed 卡 + done>1h 照搬 done（#263 22 卡实锤形态不被守护误伤）
    const clDid = "d-clpos-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now() - 2 * 3600_000, id: clDid, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-cp", project_anchor: anchor });
    appendDispatch({ ts: Date.now() - 2 * 3600_000 + 1000, id: clDid, tier: "正经立项", target: "x", status: "done", session_id: "s-cp", project_anchor: anchor });
    upsertBoardEntry(gid, { text: "boardfix claimed 卡（recon 正向对照）", status: "claimed", dispatch_id: clDid });
    (mgr as unknown as { runLedgerRecon: (t: string) => void }).runLedgerRecon("boardfix-test");
    const clPos = loadBoard(gid).entries.filter((e) => e.dispatch_id === clDid)[0];
    assert(clPos?.status === "done", `recon 正向对照：claimed+done>1h 照搬 done（实 ${clPos?.status}——守护只限 backlog 重开形态）`);

    // ============ 刀3：周期挂点（文件锚+行为） ============
    console.log("刀3 周期自愈（patrol runFull 挂点）:");
    const patrolSrc = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf8");
    assert(patrolSrc.includes("convergeBoardsWithDispatchLog(undefined"), "patrol runFull 挂收敛扫（boot-only→周期；R3 回调参形态）");
    assert(patrolSrc.includes("board-converge"), "翻正带 board-converge 巡检通知（自愈有痕——用户可见）");
    const smSrc = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf8");
    assert(smSrc.includes("boardfix 续单接卡"), "刀1 接卡锚在 session-manager（建卡边）");
    assert(smSrc.includes("claimEntryId"), "接卡变量链在（entry_id 缺省→题名匹配→认领分支）");
    const typesSrc = readFileSync(join(process.cwd(), "src", "types.ts"), "utf8");
    assert(typesSrc.includes('"board-adopt"'), "board-adopt 审计词入词表");

    // 并发与一致性（验收 2）：upsert 走 withOrgWriteTx 原子（既有）+写后读见新值
    const cc = upsertBoardEntry(gid, { text: "boardfix 一致性卡", status: "backlog" }) as { ok: boolean; entry?: { id: string } };
    const cr = loadBoard(gid).entries.find((e) => e.id === cc.entry?.id);
    assert(cr?.text === "boardfix 一致性卡" && cr.status === "backlog", "写后读见新值（无缓存滞后）");
    // 旧卡无 transitions/note 容错（验收 3）：无 note 卡接卡时 note 从空起
    const bare = upsertBoardEntry(gid, { text: "boardfix 裸卡（无 note 容错）", status: "backlog" }) as { ok: boolean; entry?: { note?: string } };
    const bareE = (bare as { ok: true; entry?: { note?: string } }).entry;
    assert(!(bareE && bareE.note), "裸卡无 note 字段（容错场景就位）");
    const dBare = mgr.orgAction("dispatch", { anchor, prompt: "裸卡接卡测", gid, title: "boardfix 裸卡（无 note 容错）" }) as { ok: boolean };
    assert(dBare.ok === true, "裸卡接卡派发 ok（无 note 容错不炸）");
    await waitFor(() => readDispatchLog().some((e) => (e.title || "").includes("裸卡接卡测") && e.status === "done"));
  } finally {
    Object.keys(prev).forEach((k) => { process.env[k] = prev[k]; });
  }
  console.log(`\n========== boardfix 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
