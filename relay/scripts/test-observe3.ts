// observe3（1104 用户令·架构升级期一②）：自主动作三档 off/observe/auto + 注意力经济学断言。
//   A 配置往返：三族三键三档枚举 + 旧布尔迁移（已启用→auto/未启用→observe）+ env 最高优
//   B converge 干跑：dryRun 研判照常（豁免计 skipped）板面零副作用 + auto 对照照翻
//   C patrol observe：push 单咽喉拦截（notifyDone 零调用 + observe-log 时序证据）+ auto 对照照推
//   D 静态锁：三族挂档点全引用 autoTierOf（新增自主动作必须挂档——auto-tiers.ts 注释锚）+ notify 折叠锚
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-observe3.ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatch } from "../src/org.js";
import { createGroup, loadBoard, upsertBoardEntry, convergeBoardsWithDispatchLog } from "../src/projects.js";
import { PatrolModule } from "../src/patrol.js";
import { setGroupStatus } from "../src/projects.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { RelayConfig } from "../src/config.js";
import { autoTierOf } from "../src/auto-tiers.js";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-observe3-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-observe3-"));
  const CFG = join(DATA, "config.json");
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_CONFIG_FILE = CFG; // A 族全程指向沙盒配置（勿读生产 ~/.cc-deck/config.json）
  for (const k of ["CCR_AUTO_TIER_PATROL", "CCR_AUTO_TIER_CONVERGE", "CCR_AUTO_TIER_REVIVE"]) delete process.env[k];
  try {
    // ============ A 配置往返（验收点 1） ============
    console.log("A 三族三键三档配置往返:");
    writeFileSync(CFG, JSON.stringify({ autoPatrol: "observe", autoConverge: "off", autoRevive: "auto" }));
    assert(autoTierOf("patrol") === "observe", "autoPatrol=observe 读回");
    assert(autoTierOf("converge") === "off", "autoConverge=off 读回");
    assert(autoTierOf("revive") === "auto", "autoRevive=auto 读回");
    writeFileSync(CFG, JSON.stringify({ autoPatrol: "bogus" }));
    assert(autoTierOf("patrol") === "auto", "非法档值回落缺省 auto（不脑补不炸）");
    // 旧布尔迁移（验收点 4 默认值映射）
    writeFileSync(CFG, JSON.stringify({ patrol: false }));
    assert(autoTierOf("patrol") === "observe", "迁移：旧 patrol=false（未启用）→observe（先看见再放开）");
    writeFileSync(CFG, JSON.stringify({ patrol: true }));
    assert(autoTierOf("patrol") === "auto", "迁移：旧 patrol=true（已启用）→auto（行为零变）");
    writeFileSync(CFG, "{}");
    assert(autoTierOf("patrol") === "auto" && autoTierOf("converge") === "auto" && autoTierOf("revive") === "auto", "无配置三族缺省 auto（现网行为零变——三族现均启用）");
    writeFileSync(CFG, JSON.stringify({ autoPatrol: "observe" }));
    process.env.CCR_AUTO_TIER_PATROL = "off";
    assert(autoTierOf("patrol") === "off", "env CCR_AUTO_TIER_PATROL 最高优（测试/紧急覆盖）");
    delete process.env.CCR_AUTO_TIER_PATROL;

    // ============ B converge 干跑（验收点 2——时序证据：板面零副作用） ============
    console.log("B converge 族 observe 干跑:");
    const anchor = mkdtempSync(join(tmpdir(), "observe3-anchor-"));
    const cg = createGroup({ name: "observe3 组", anchor_dir: anchor, tier: "轻立项" }) as { ok: boolean; group?: { id: string } };
    const gid = cg.group!.id;
    // setGroupStatus active（组 pending 冻结闸——B 审攻击脚本同款补激活）
    const { setGroupStatus } = await import("../src/projects.js");
    setGroupStatus(gid, "active");
    const H = 3600_000;
    const mkDone = (id: string) => {
      appendDispatch({ ts: Date.now() - 100 * H, id, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-" + id, project_anchor: anchor });
      appendDispatch({ ts: Date.now() - 99 * H, id, tier: "正经立项", target: "x", status: "done", session_id: "s-" + id, project_anchor: anchor });
    };
    // 陈卡（干跑目标）+ 人工重开卡（豁免）+ hold 卡（豁免）
    const dStale = "d-st-" + randomUUID().slice(0, 6); mkDone(dStale);
    upsertBoardEntry(gid, { text: "observe3 陈卡（应翻未翻）", status: "backlog", dispatch_id: dStale });
    const dRe = "d-re-" + randomUUID().slice(0, 6); mkDone(dRe);
    const reC = upsertBoardEntry(gid, { text: "observe3 人工重开卡（豁免）", status: "done", dispatch_id: dRe }) as { ok: boolean; entry: { id: string; text: string } };
    upsertBoardEntry(gid, { id: reC.entry.id, text: reC.entry.text, status: "backlog", note: "[人工重开]" });
    const dHd = "d-hd-" + randomUUID().slice(0, 6); mkDone(dHd);
    const hdC = upsertBoardEntry(gid, { text: "observe3 hold 卡（豁免）", status: "backlog", dispatch_id: dHd }) as { ok: boolean; entry: { id: string; text: string } };
    upsertBoardEntry(gid, { id: hdC.entry.id, text: hdC.entry.text, hold: { reason: "等装机" } });
    const dry = convergeBoardsWithDispatchLog(undefined, undefined, { dryRun: true });
    assert(dry.moved === 0, `dryRun moved=0（实 ${dry.moved}——动作不执行）`);
    assert(dry.wouldClose.length === 1 && dry.wouldClose[0].text.includes("陈卡"), `wouldClose 恰含陈卡（实 ${JSON.stringify(dry.wouldClose)}——研判照常）`);
    assert(dry.skipped === 2, `豁免照判 skipped=2（实 ${dry.skipped}——人工重开+hold）`);
    const b1 = loadBoard(gid);
    const staleAfter1 = b1.entries.find((e) => e.dispatch_id === dStale);
    assert(staleAfter1?.status === "backlog", `时序证据：干跑后陈卡仍 backlog（实 ${staleAfter1?.status}——板面零副作用）`);
    const dry2 = convergeBoardsWithDispatchLog(undefined, undefined, { dryRun: true });
    assert(dry2.wouldClose.length === 1, "干跑可反复执行（幂等——再跑仍恰 1 张）");
    const auto = convergeBoardsWithDispatchLog(); // auto 对照
    assert(auto.moved === 1 && loadBoard(gid).entries.find((e) => e.dispatch_id === dStale)?.status === "done", "auto 对照照翻（同输入 auto 档执行——陈卡翻 done）");

    // ============ C patrol observe（验收点 2——push 单咽喉拦截） ============
    console.log("C patrol 族 observe 干跑:");
    const pushed: string[] = [];
    const stubMgr = {
      snapshot: () => [{ session_id: "s-x", external: true, status: "WORKING" }],
      notifyDone: (sid: string, lines: string[]) => { pushed.push(lines.join(" ")); },
      emitChainAudit: () => {},
      upsertNotification: () => {},
    } as never;
    const pm = new PatrolModule(stubMgr, { dataDir: DATA, reportPath: join(DATA, "patrol-report.md"), enabled: () => true });
    process.env.CCR_AUTO_TIER_PATROL = "observe";
    (pm as unknown as { push: (k: string, t: string) => void }).push("disk", "observe3 测试告警（干跑）");
    await wait(30);
    assert(pushed.length === 0, "observe 档 notifyDone 零调用（推用户动作不执行）");
    const obLog = readFileSync(join(DATA, "observe-log.ndjson"), "utf-8");
    assert(obLog.includes('"family":"patrol"') && obLog.includes("observe3 测试告警"), "observe 账本在案（{family,key,detail} 时序证据落盘）");
    assert(readFileSync(join(DATA, "patrol-report.md"), "utf-8").includes("OBSERVE [disk]"), "巡逻报告 OBSERVE 行在（排障面）");
    (pm as unknown as { push: (k: string, t: string) => void }).push("disk", "observe3 测试告警（干跑）"); // 同文重推=去重面（研判链照跑零重复记账）
    const obLog2 = readFileSync(join(DATA, "observe-log.ndjson"), "utf-8");
    assert(obLog2 === obLog, "observe 档同文去重逻辑照跑（研判全链不受档位影响）");
    process.env.CCR_AUTO_TIER_PATROL = "auto";
    (pm as unknown as { push: (k: string, t: string) => void }).push("disk", "auto 档测试告警");
    await wait(30);
    assert(pushed.length === 1 && pushed[0].includes("auto 档测试告警"), "auto 对照照推（同链 auto 档执行 notifyDone）");

    // ============ E R1 六面收口（P1-1：observe 零副作用+observe 账多条目；auto 对照） ============
    console.log("E patrol 族 observe 六面收口（P1-1）:");
    // 沙盒组织+板 fixture：wakeup 到点卡 + claimed 滞留卡（主会话同静默）
    const anchor2 = mkdtempSync(join(tmpdir(), "observe3r1-anchor-"));
    const cg2 = createGroup({ name: "observe3r1 组", anchor_dir: anchor2, tier: "轻立项" }) as { ok: boolean; group?: { id: string } };
    const gid2 = cg2.group!.id;
    setGroupStatus(gid2, "active");
    const wk = upsertBoardEntry(gid2, { text: "R1 唤醒卡（wakeup 到点）", status: "backlog", wakeup_at: Date.now() - 60_000 }) as { ok: boolean; entry: { id: string } };
    const st = upsertBoardEntry(gid2, { text: "R1 滞留卡（claimed 无进展）", status: "claimed", owner_session: "s-stale-owner" }) as { ok: boolean; entry: { id: string } };
    // 手写旧 updated_at（upsert 恒写 now——claimed 滞留判定需要超阈值）
    {
      const { loadBoardFile } = await import("../src/projects.js");
      const bf = join(ORG, "boards", gid2 + ".json");
      const bj = JSON.parse(readFileSync(bf, "utf-8"));
      for (const e of bj.entries) { e.updated_at = Date.now() - 3 * 3600_000; e.ts = e.ts ?? Date.now(); }
      writeFileSync(bf, JSON.stringify(bj));
      void loadBoardFile; void st;
    }
    // stub mgr（六面副作用全记录）
    const sideEffects: { upserts: string[]; feedPM: string[]; notifyDone: string[]; boards: string[]; recon: string[] } = { upserts: [], feedPM: [], notifyDone: [], boards: [], recon: [] };
    const staleSession = { session_id: "s-stale-owner", status: "DONE", updated_at: Date.now() - 3 * 3600_000, title: "滞留主" };
    const workerStaleSession = { session_id: "s-w-stale", status: "WORKING", updated_at: Date.now() - 3 * 3600_000, title: "无帧 worker" };
    const stubMgr2 = {
      snapshot: () => [staleSession, workerStaleSession],
      sessions: new Map([["s-pm", { resumeCooldownUntil: Date.now() - 60_000, resumeFailStreak: 2 }]]),
      notifyDone: (sid: string, lines: string[]) => { sideEffects.notifyDone.push(lines.join(" ")); },
      emitChainAudit: () => {},
      upsertNotification: (kind: string, id: string) => { sideEffects.upserts.push(id); },
      emitBoard: (g: string) => { sideEffects.boards.push(g); },
      feedPM: (t: string) => { sideEffects.feedPM.push(t); },
      runLedgerRecon: (t: string) => { sideEffects.recon.push(t); },
      resolveObserveAdvisories: () => {},
    } as never;
    const DATA2 = mkdtempSync(join(tmpdir(), "observe3r1-data-"));
    const pm2 = new PatrolModule(stubMgr2, { dataDir: DATA2, reportPath: join(DATA2, "patrol-report.md"), enabled: () => true });
    process.env.CCR_MAIN_REPO = "/nonexistent-observe3r1"; // drillDue 恒 false（演练面走静态锁覆盖）
    process.env.CCR_AUTO_TIER_PATROL = "observe";
    // 面①②④：boardCardScan（wakeup 写板+直写通知+doing-stale 通知）
    (pm2 as unknown as { boardCardScan: () => void }).boardCardScan();
    const wkAfter = loadBoard(gid2).entries.find((e) => e.id === wk.entry.id);
    assert(!!wkAfter?.wakeup_at, `时序证据①：wakeup_at 未被清（实 ${String(wkAfter?.wakeup_at)}——observe 零板面副作用）`);
    assert(!sideEffects.upserts.some((k) => k === "board-wakeup" || k === "board-doing-stale"), "时序证据②：boardCardScan 直写通知账零调用（wakeup/doing-stale 均拦截）");
    assert(sideEffects.boards.length === 0, "时序证据③：emitBoard 零调用（板未动）");
    assert(sideEffects.feedPM.length === 0, "时序证据④：wakeup feedPM 零调用");
    assert(sideEffects.notifyDone.length === 0, "时序证据⑤：push 推送零调用（notifyDone 未达）");
    // 面⑦：breaker 补试喂活
    (pm2 as unknown as { retryExpiredBreaker: () => void }).retryExpiredBreaker();
    assert(sideEffects.feedPM.length === 0, "时序证据⑥：breaker feedPM 零调用（patrol-retry 拦截）");
    // 面⑥+面③：runFull（recon 拦截+worker-stale 升级通知拦截；converge 无台账行=跳过）
    (pm2 as unknown as { runFull: () => void }).runFull();
    assert(sideEffects.recon.length === 0, "时序证据⑦：runLedgerRecon 零调用（recon 拦截）");
    assert(!sideEffects.upserts.some((k) => k === "stale-escalate"), "时序证据⑧：stale-escalate 直写通知账零调用（升级面拦截）");
    // observe 账多条目（≥6 条不同 key——六面证据链）+ web 一行式（P2①）
    const oblog = readFileSync(join(DATA2, "observe-log.ndjson"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { family: string; key: string; action: string });
    const obKeys = new Set(oblog.filter((r) => r.family === "patrol").map((r) => r.key));
    assert(obKeys.size >= 6, `observe 账 ≥6 键（实 ${obKeys.size}：${[...obKeys].join(",")}——六面证据链）`);
    assert(obKeys.has("board-wakeup") && obKeys.has("board-doing-stale") && obKeys.has("patrol-retry") && obKeys.has("recon") && obKeys.has("stale-escalate"), "六面关键键齐（wakeup/doing-stale/breaker/recon/stale-escalate/push 族）");
    assert(sideEffects.upserts.some((k) => k.startsWith("observe-patrol-")), "P2①：patrol observe 记录 web 一行式在（upsert observe-patrol-* 已发）");
    // P2⑧：observe 期间同文 push 不写 lastAlerts——转 auto 首拍真推
    (pm2 as unknown as { push: (k: string, t: string) => void }).push("board-wakeup", "R1 转档探针告警文本");
    process.env.CCR_AUTO_TIER_PATROL = "auto";
    (pm2 as unknown as { push: (k: string, t: string) => void }).push("board-wakeup", "R1 转档探针告警文本");
    assert(sideEffects.notifyDone.some((t) => t.includes("R1 转档探针告警文本")), "P2⑧：observe 期同文转 auto 后首拍真推（不被 observeSeen/lastAlerts 吞）");
    // auto 对照：全新 stub+模块，同 fixture 照常执行
    const sideAuto: { upserts: string[]; feedPM: string[]; notifyDone: string[]; recon: string[] } = { upserts: [], feedPM: [], notifyDone: [], recon: [] };
    const stubMgr3 = {
      snapshot: () => [staleSession, workerStaleSession],
      sessions: new Map([["s-pm", { resumeCooldownUntil: Date.now() - 60_000 }]]),
      notifyDone: (_sid: string, lines: string[]) => { sideAuto.notifyDone.push(lines.join(" ")); },
      emitChainAudit: () => {},
      upsertNotification: (kind: string, id: string) => { sideAuto.upserts.push(id); },
      emitBoard: () => {},
      feedPM: (t: string) => { sideAuto.feedPM.push(t); },
      runLedgerRecon: (t: string) => { sideAuto.recon.push(t); },
      resolveObserveAdvisories: () => {},
    } as never;
    const pm3 = new PatrolModule(stubMgr3, { dataDir: DATA2, reportPath: join(DATA2, "patrol-report.md"), enabled: () => true });
    (pm3 as unknown as { boardCardScan: () => void }).boardCardScan();
    const wkAuto = loadBoard(gid2).entries.find((e) => e.id === wk.entry.id);
    assert(!wkAuto?.wakeup_at, "auto 对照①：wakeup_at 被消费清空（原行为照常）");
    assert(sideAuto.upserts.some((k) => k === "board-wakeup" || k === "board-doing-stale"), "auto 对照②：boardCardScan 直写通知照常");
    assert(sideAuto.feedPM.includes("board-wakeup"), "auto 对照③：wakeup feedPM 照常");
    (pm3 as unknown as { retryExpiredBreaker: () => void }).retryExpiredBreaker();
    assert(sideAuto.feedPM.includes("patrol-retry"), "auto 对照④：breaker feedPM 照常");
    (pm3 as unknown as { runFull: () => void }).runFull();
    assert(sideAuto.recon.includes("patrol-full"), "auto 对照⑤：runLedgerRecon 照常");
    assert(sideAuto.upserts.some((k) => k === "stale-escalate"), "auto 对照⑥：stale-escalate 通知照常");
    delete process.env.CCR_MAIN_REPO;
    delete process.env.CCR_AUTO_TIER_PATROL;

    // ============ F R1 P2⑤⑥⑦（跨族闸/载体解耦/observe 行收口） ============
    console.log("F P2⑤⑥⑦（跨族/载体/收口）:");
    // P2⑤：patrol=observe+converge=auto 组合——converge 完成通知直达不被吞
    {
      const { appendDispatch: ad } = await import("../src/org.js");
      const dR1 = "d-r1c-" + randomUUID().slice(0, 6);
      ad({ ts: Date.now() - 100 * 3600_000, id: dR1, tier: "正经立项", target: "x", status: "dispatched", session_id: "s-r1", project_anchor: anchor2 });
      ad({ ts: Date.now() - 99 * 3600_000, id: dR1, tier: "正经立项", target: "x", status: "done", session_id: "s-r1", project_anchor: anchor2 });
      upsertBoardEntry(gid2, { text: "R1 跨族闸对照卡", status: "backlog", dispatch_id: dR1 });
      const sideF: { upserts: string[] } = { upserts: [] };
      const stubF = {
        snapshot: () => [] as never[],
        notifyDone: () => {},
        emitChainAudit: () => {},
        upsertNotification: (kind: string, id: string) => { sideF.upserts.push(id); },
        emitBoard: () => {}, feedPM: () => {}, runLedgerRecon: () => {}, resolveObserveAdvisories: () => {},
      } as never;
      const pmF = new PatrolModule(stubF, { dataDir: DATA2, reportPath: join(DATA2, "p.md"), enabled: () => true });
      process.env.CCR_AUTO_TIER_PATROL = "observe";
      process.env.CCR_AUTO_TIER_CONVERGE = "auto";
      (pmF as unknown as { runFull: () => void }).runFull();
      assert(sideF.upserts.some((k) => k === "board-converge"), "P2⑤：patrol=observe+converge=auto——converge 完成通知直达（board-converge 已发，不被 patrol push 闸吞）");
      const cardF = loadBoard(gid2).entries.find((e) => e.dispatch_id === dR1);
      assert(cardF?.status === "done", "P2⑤ 对照：converge auto 真执行（卡翻 done）");
      delete process.env.CCR_AUTO_TIER_CONVERGE;
      delete process.env.CCR_AUTO_TIER_PATROL;
    }
    // P2⑥⑦：静态锁（载体解耦判定序+收口钩子在）+ resolveObserveAdvisories 行为
    {
      const patrolSrcF = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf-8");
      assert(patrolSrcF.includes('autoTierOf("patrol") === "off" && autoTierOf("converge") === "off"'), "P2⑥：fullTimer 双族 off 才停（converge 周期扫载体解耦）");
      assert(patrolSrcF.indexOf("converge 段自带档位闸") > 0 || patrolSrcF.includes("仅 converge 段运行"), "P2⑥：runFull converge 段后 patrol off 早退锚在");
      assert(patrolSrcF.includes("resolveObserveAdvisories"), "P2⑦：patrol 周期收口钩子在");
      const smSrcF = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf-8");
      assert(smSrcF.includes("resolveObserveAdvisories") && smSrcF.includes("observe-converge"), "P2⑦：SessionManager 收口方法在（前缀判族+离档 resolved）");
      // 行为：真 SessionManager 上 observe-patrol-* 行在档位转 auto 后被收口
      const cfgF: RelayConfig = { port: 8801, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null };
      const busF = new EventBus({ persistPath: join(DATA, "events-f.ndjson") });
      const mgrF = new SessionManager(busF, cfgF);
      mgrF.setAgentFactory(() => ({ id: "x", startedAt: 0, ended: true, sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false, stop: async () => {}, setPermissionMode: async () => {} }) as never);
      mgrF.upsertNotification("system", "observe-patrol-disk", "b1", { title: "[observe] 测试", body: "x", severity: "waiting", group: "attention", actionable: false, domain: "session", returnPath: "sessions" } as never);
      mgrF.upsertNotification("system", "observe-revive", "b1", { title: "[observe] 测试2", body: "x", severity: "waiting", group: "attention", actionable: false, domain: "session", returnPath: "sessions" } as never);
      process.env.CCR_AUTO_TIER_PATROL = "auto"; // patrol 离档、revive 仍 observe（缺省 auto?——显式 observe 保持）
      process.env.CCR_AUTO_TIER_REVIVE = "observe";
      mgrF.resolveObserveAdvisories();
      const snapNotif = (mgrF as unknown as { notifications: Map<string, { sourceContext?: { entityId?: string }; resolved_at?: number }> }).notifications;
      const obsPatrol = [...snapNotif.values()].find((n) => n.sourceContext?.entityId === "observe-patrol-disk");
      const obsRevive = [...snapNotif.values()].find((n) => n.sourceContext?.entityId === "observe-revive");
      assert(!!obsPatrol?.resolved_at, "P2⑦ 行为：patrol 转 auto——observe-patrol-* 行被收口 resolved");
      assert(!obsRevive?.resolved_at, "P2⑦ 行为：revive 仍 observe——observe-revive 行驻留（按档判族不误收）");
      delete process.env.CCR_AUTO_TIER_PATROL;
      delete process.env.CCR_AUTO_TIER_REVIVE;
    }
    // P1-2：清空钮判定序（静态——行为面 DOM 探针见 /tmp/w-observe3/probe-clear.mjs 截图留档）
    {
      const notifySrcF = readFileSync(join("..", "web-console", "js", "notify.js"), "utf-8");
      assert(notifySrcF.indexOf("[data-notify-grp-clear]") < notifySrcF.indexOf("[data-notify-grp-toggle]"), "P1-2：清空钮判定先于折叠开合（源码序——DOM 探针复验在案）");
    }
    // P2②：revive stale-todos 前置（静态锁——行为面 reviveEligible 深面仍挂账）
    {
      const reviveSrcF = readFileSync(join(process.cwd(), "src", "lifecycle", "revive.ts"), "utf-8");
      assert(reviveSrcF.indexOf("revive-stale-todos") < reviveSrcF.indexOf('reviveTier === "observe"'), "P2②：stale-todos 聚合块在 observe return 之前（两档共用，observe 不再双盲）");
    }
    // ④：auto-tiers 迁移叙事口径修正锚
    {
      const tiersSrcF = readFileSync(join(process.cwd(), "src", "auto-tiers.ts"), "utf-8");
      assert(tiersSrcF.includes("生产不可达"), "④：迁移叙事已修正（false→模块不实例化，映射生产不可达——口径如实）");
      assert(tiersSrcF.includes("recoverEngineAfterAuth") && tiersSrcF.includes("reviveManagedSession"), "A-7：revive 域另两面边界声明在（挂账待口径）");
    }

    // ============ D 静态锁（验收点 5——新增自主动作必须挂档） ============
    console.log("D 挂档静态锁+面板折叠锚:");
    const patrolSrc = readFileSync(join(process.cwd(), "src", "patrol.ts"), "utf-8");
    const smSrc = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf-8");
    const reviveSrc = readFileSync(join(process.cwd(), "src", "lifecycle", "revive.ts"), "utf-8");
    const tiersSrc = readFileSync(join(process.cwd(), "src", "auto-tiers.ts"), "utf-8");
    const notifySrc = readFileSync(join("..", "web-console", "js", "notify.js"), "utf-8");
    const cssSrc = readFileSync(join("..", "web-console", "css", "base.css"), "utf-8");
    assert(tiersSrc.includes("新增自主动作必须挂档"), "auto-tiers.ts 挂档纪律注释锚在（新增动作的单点收口契约）");
    assert(patrolSrc.includes('autoTierOf("patrol") === "off"') && patrolSrc.includes('autoTierOf("patrol") === "observe"'), "patrol 族挂档：off 定时器闸+push 单咽喉 observe 拦截");
    assert(patrolSrc.includes('autoTierOf("converge")') && patrolSrc.includes("{ dryRun: tier === \"observe\" }"), "converge 族挂档（patrol runFull 三档）");
    assert(smSrc.includes('autoTierOf("converge")'), "converge 族挂档（boot 侧同口径）");
    assert(reviveSrc.includes('autoTierOf("revive")') && reviveSrc.includes("[observe] 自动拉活干跑"), "revive 族挂档（off/observe 干跑+通知账一行式）");
    assert(patrolSrc.includes("recordWouldDo(this.opts.dataDir"), "observe 记账走 recordWouldDo 单口（observe-log.ndjson）");
    // 注意力经济学：面板需人置顶（既有三分组维持）+ 健康态折叠（observe3 新增）
    assert(notifySrc.includes('group("需你行动", "r", actionRows, "")'), "面板需人置顶（需你行动组首位——既有三分组维持）");
    assert(notifySrc.includes("dynamicCollapsed") && notifySrc.includes("data-notify-grp-toggle"), "健康态（动态组）默认折叠+组头开合（observe3）");
    assert(notifySrc.includes("#dyn-collapsed"), "折叠态入渲染签名（切换必重渲——跳帧短路防）");
    assert(cssSrc.includes(".ngrp-fold") && cssSrc.includes(".ngrp .caret"), "折叠 CSS 在（复用既有 token 零新色）");
  } finally {
    Object.keys(prev).forEach((k) => { process.env[k] = prev[k]; });
  }
  console.log(`\n========== observe3 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
