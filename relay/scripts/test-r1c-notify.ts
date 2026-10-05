// #018-R1c 决策通知真链路接入 SessionManager 集成测试（fake factory 缝仿 r1a/r1b）。
// 覆盖：N1 org-confirm 源产生（R1b orgCommand needsConfirm 落单）+ 持久；N2 waiting
//       源 + stableKey 去重 + 翻回 resolved + 已决不复活；N3 终态收口；N4 dispatch
//       源（done/failed 分桶）+ 一单一行去重；N5 ACK 生命周期三态 + 幂等不复活 +
//       未知 key 拒收；N6 值变才发（同值静默）；N7 重启还原进快照数据源（零重发帧）；
//       N8 坏 JSON 容错 + 写侧还原；N9 未知命令 B0 default 收口。
// #018-R1FIX1 增补：N10 org-confirm 五入口单一产生源（旧 orgAction create/archive/
//       tier/suggest-hold 手动/autoSuggestHold 自动）+ 三端投影 + 重启还原；N11
//       dispatch 终态出口（首派失败/看门狗 done+failed/重启悬账补记）；N12 superseded
//       waiting 精确收口（旧 key 关、当前 key 不动）；N13 确认副作用失败语义（error
//       面不 resolved）；N14 确认单孤儿对账（重启收口记原因 + 重放不复活）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { setConfirmCreatedHook } from "../src/projects.js";
import type { OrgConfirm } from "../src/projects.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command, NotificationItem } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd;
    void model;
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; },
      setPermissionMode: async () => {},
    };
    return a;
  };

function send(mgr: SessionManager, command_id: string, type: string, payload: Record<string, unknown>, by: string) {
  const cmd = { command_id, type, payload } as unknown as Command;
  return mgr.handleCommand(cmd, by);
}

async function main() {
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-r1c-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-cwd-r1c-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "ccr-org-r1c-"));
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const frames: NotificationItem[][] = [];
    bus.subscribe((env) => {
      if (env.type === "NOTIFICATIONS_UPDATED") frames.push((env.payload as { items: NotificationItem[] }).items);
    });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));
    const create = (mgr as unknown as { create(cwd: string, prompt: string): string }).create.bind(mgr);
    const closeDispatch = (mgr as unknown as {
      notifyDispatchClosed(e: { id: string; tier: string; gid?: string; anchor?: string; actor?: string }, status: "done" | "failed", receipt: string, workerSessionId: string): void;
    }).notifyDispatchClosed.bind(mgr);
    const storeFile = (): { notifications: NotificationItem[] } | null =>
      existsSync(join(DATA, "notifications.json"))
        ? JSON.parse(readFileSync(join(DATA, "notifications.json"), "utf-8")) as { notifications: NotificationItem[] }
        : null;
    const findKind = (kind: string, pred?: (n: NotificationItem) => boolean) =>
      mgr.notificationsList().filter((n) => n.kind === kind && (pred ? pred(n) : true));

    // ---------- N1 org-confirm 源（R1b orgCommand needsConfirm 落单） ----------
    console.log("N1 org-confirm 源");
    const anchor = mkdtempSync(join(tmpdir(), "ccr-anchor-r1c-"));
    const before1 = frames.length;
    const ack1 = send(mgr, "n1", "COMMAND_ORG_ACTION",
      { action: "create", name: "R1C 通知组", anchor_dir: anchor, tier: "正经立项" }, "web-1");
    // #72A0FIX2 类型面补注（Leader N1② 修订的既有 tsc 伤，零行为变化）：confirm
    // 实际携带 created_at（stableKey 的 revision 来源），cast 声明面补齐
    const d1 = ack1.data as { group?: { id: string }; confirm?: { id: string; created_at?: number } } | undefined;
    const cfItems = findKind("org-confirm");
    assert(ack1.ok === true && cfItems.length === 1,
      "N1① needsConfirm 落单产 org-confirm 通知恰好一条");
    const cfItem = cfItems[0];
    // N1② revision 比对取 ACK data 的 confirm.created_at（stableKey 的真实来源）——
    // 通知项自身 created_at=upsert 时第二次 Date.now()，与 confirm 落单时刻隔了
    // ensureProjectClaudeMd 文件 IO，毫秒级不等是常态（跨毫秒即 flake）
    assert(cfItem.sourceContext.entityId === d1?.confirm?.id
      && cfItem.key === `org-confirm:${cfItem.sourceContext.entityId}:${d1?.confirm?.created_at}`,
      "N1② stableKey=org-confirm:<confirm_id>:<created_at>（B3a 口径）");
    assert(cfItem.group === "action" && cfItem.severity === "waiting" && cfItem.actionable === true,
      "N1③ action 桶 / waiting 级 / 可操作");
    assert(frames.length === before1 + 1 && frames[frames.length - 1].some((n) => n.key === cfItem.key),
      "N1④ NOTIFICATIONS_UPDATED 瞬态帧随产生发出（全量 items）");
    assert(storeFile()?.notifications.some((n) => n.key === cfItem.key) === true,
      "N1⑤ notifications.json 持久落账");

    // ---------- N2 waiting 源 + stableKey 去重 + 翻回 resolved ----------
    console.log("N2 waiting 源");
    const sid = create(CWD, "R1C 等待通知");
    const cb = created[0].cb;
    cb.onInit("sdk-r1c", "test-model");
    cb.onStatusChange("WORKING", "开工");
    const req = { request_id: "req-1", tool_name: "Bash", input_summary: "跑回归", suggestions: [] as string[] };
    cb.onWaiting(req);
    const w1 = findKind("waiting")[0];
    assert(!!w1 && w1.key === `waiting:${sid}:req-1` && w1.title === "等待批准 Bash",
      "N2① onWaiting 产 waiting 通知（stableKey=waiting:<sid>:<request_id>）");
    const after2 = { frames: frames.length, items: mgr.notificationsList().length };
    cb.onWaiting(req); // 同请求重放
    assert(frames.length === after2.frames && mgr.notificationsList().length === after2.items,
      "N2② 同 stableKey 重放：零新账零帧（产生源防重）");
    cb.onStatusChange("WORKING", "继续"); // 决议翻回
    const w1after = findKind("waiting")[0];
    assert(w1after.key === w1.key && (w1after.resolved_at ?? 0) > 0,
      "N2③ onStatusChange 翻回 → waiting 转 resolved");
    const after3 = { frames: frames.length, resolved: w1after.resolved_at };
    cb.onWaiting(req); // 已决账同 key 重放
    const w1again = findKind("waiting")[0];
    assert(frames.length === after3.frames && w1again.resolved_at === after3.resolved,
      "N2④ 已 resolved 的账同 key 重放不复活（幂等）");
    cb.onWaiting({ ...req, request_id: "req-2", tool_name: "Write" });
    assert(findKind("waiting").length === 2,
      "N2⑤ 新请求（新 stableKey）产新账");

    // ---------- N3 终态收口 ----------
    console.log("N3 终态收口");
    cb.onTurnEnd(true, "success", 100);
    assert(findKind("waiting").every((n) => (n.resolved_at ?? 0) > 0),
      "N3① onTurnEnd 终态 → 该会话全部 waiting 账 resolved");

    // ---------- N4 dispatch 源（done/failed 分桶 + 一单一行） ----------
    console.log("N4 dispatch 源");
    const before4 = frames.length;
    closeDispatch({ id: "d-1", tier: "随手办" }, "done", "交付完成回执", sid);
    const done4 = findKind("dispatch", (n) => n.sourceContext.entityId === "d-1")[0];
    assert(done4?.key === "dispatch:d-1" && done4.group === "activity"
      && done4.severity === "done" && done4.actionable === false,
      "N4① dispatch done → activity 桶/done 级/不可操作（key=dispatch:<id>）");
    closeDispatch({ id: "d-1", tier: "随手办" }, "done", "交付完成回执", sid);
    assert(findKind("dispatch", (n) => n.sourceContext.entityId === "d-1").length === 1
      && frames.length === before4 + 1,
      "N4② 同单重复收口：一单一行不双发（对账去重）");
    closeDispatch({ id: "d-2", tier: "随手办" }, "failed", "执行炸了", sid);
    const fail4 = findKind("dispatch", (n) => n.sourceContext.entityId === "d-2")[0];
    assert(fail4.group === "action" && fail4.severity === "error" && fail4.actionable === true,
      "N4③ dispatch failed → action 桶/error 级/可操作（重派要对账决策）");

    // ---------- N5 ACK 生命周期三态 + 幂等 ----------
    console.log("N5 ACK 生命周期");
    // N3 终态已把在等账全收口——先造一条新的未决 waiting 账再验 ACK
    cb.onWaiting({ request_id: "req-3", tool_name: "Edit", input_summary: "改配置", suggestions: [] });
    const w3 = findKind("waiting", (n) => n.key.endsWith(":req-3"))[0];
    const ack5 = send(mgr, "n5a", "COMMAND_NOTIFICATION_ACK", { notification_key: w3.key, action: "handled" }, "web-1");
    assert(ack5.ok === true
      && findKind("waiting", (n) => n.key === w3.key)[0].handled_at !== undefined,
      "N5① ACK handled → handled_at 落账");
    const ack6 = send(mgr, "n5b", "COMMAND_NOTIFICATION_ACK", { notification_key: fail4.key, action: "dismissed" }, "cloud-dev1");
    const fail4b = findKind("dispatch", (n) => n.sourceContext.entityId === "d-2")[0];
    assert(ack6.ok === true && (fail4b as typeof fail4b & { dismissed_at?: number }).dismissed_at !== undefined
      && fail4b.handled_at !== undefined,
      "N5② ACK dismissed → dismissed_at + handled_at 落账");
    const ack7 = send(mgr, "n5c", "COMMAND_ORG_CONFIRM", { confirm_id: d1?.confirm?.id, approve: true }, "web-1");
    const cfAfter = findKind("org-confirm")[0];
    assert(ack7.ok === true && (cfAfter.resolved_at ?? 0) > 0,
      "N5③ 确认单决议 → org-confirm 通知转 resolved（applyConfirmEffects 收口）");
    const before8 = frames.length;
    const ack8 = send(mgr, "n5d", "COMMAND_NOTIFICATION_ACK", { notification_key: cfAfter.key, action: "handled" }, "web-1");
    const cfAfter2 = findKind("org-confirm")[0];
    assert(ack8.ok === true && cfAfter2.resolved_at === cfAfter.resolved_at
      && cfAfter2.handled_at === cfAfter.handled_at && frames.length === before8,
      "N5④ 已 resolved 的账 ACK：ok 但零迁移零帧（不复活）");
    const ack9 = send(mgr, "n5e", "COMMAND_NOTIFICATION_ACK", { notification_key: "dispatch:nope", action: "handled" }, "web-1");
    assert(ack9.ok === false && typeof ack9.error === "string",
      "N5⑤ 未知 key 拒收（ok:false 带错误）");

    // ---------- N6 值变才发（同值静默） ----------
    console.log("N6 值变才发");
    const before10 = frames.length;
    send(mgr, "n6a", "COMMAND_NOTIFICATION_ACK", { notification_key: w3.key, action: "handled" }, "web-1"); // 重复 handled
    assert(frames.length === before10,
      "N6① 同值重复迁移零帧（transitionNotification 只填空位 + 投影序列化 dedup）");

    // ---------- N7 重启还原（离线重载进快照数据源） ----------
    console.log("N7 重启还原");
    const listBefore = mgr.notificationsList();
    const framesBefore = frames.length;
    const mgr2 = new SessionManager(bus, cfg); // 同 dataDir 模拟重启
    assert(JSON.stringify(mgr2.notificationsList()) === JSON.stringify(listBefore),
      "N7① 重启从 notifications.json 还原全量通知账");
    assert(frames.length === framesBefore,
      "N7② 重启还原不重发 NOTIFICATIONS_UPDATED（基线锚定，值变才发）");

    // ---------- N8 坏 JSON 容错 + 写侧还原 ----------
    console.log("N8 坏 JSON 容错");
    writeFileSync(join(DATA, "notifications.json"), "}}}bad json{{{", "utf-8");
    const mgr3 = new SessionManager(bus, cfg);
    assert(mgr3.notificationsList().length === 0,
      "N8① 坏 JSON → 空账起步不炸读侧");
    // #018-R1FIX1：mgr3 构造会抢走确认单产生回调槽（单回调槽后注册覆盖）——
    // 绑回 mgr，mgr3 只作坏账隔离样本，不承接后续产生
    setConfirmCreatedHook((c: OrgConfirm) =>
      (mgr as unknown as { recordOrgConfirmNotification(c: OrgConfirm): void }).recordOrgConfirmNotification(c));
    closeDispatch.call(mgr3, { id: "d-3", tier: "咨询" }, "done", "重启后首单", "s-x");
    const parsed = storeFile();
    assert(Array.isArray(parsed?.notifications) && parsed.notifications.some((n) => n.key === "dispatch:d-3"),
      "N8② 写侧首落还原合法存储（可解析）");

    // ---------- N9 未知命令 B0 default（两入口同源） ----------
    console.log("N9 未知命令收口");
    const ack10 = send(mgr, "n9", "COMMAND_NOTIFICATION_BOGUS", {}, "web-1");
    assert(ack10.ok === false && ack10.error === "unsupported command",
      "N9① 未知命令走 B0 execCommand default");

    // ---------- N10 P1-1 org-confirm 单一产生源（五入口全接） ----------
    console.log("N10 P1-1 org-confirm 五入口产生源");
    const orgConfirmCount = () => findKind("org-confirm").length;
    const beforeN10 = orgConfirmCount();
    const framesBeforeN10 = frames.length;
    // 出口①旧 orgAction 漏斗 project-create（R1c 只接了 orgCommand create，此路径
    // 此前只在 confirms.json 落单、通知面漏项——hook 挂 projects.addConfirm 单咽喉）
    const r10a = mgr.orgAction("project-create", {
      name: "R1FIX1 旧漏斗组", anchor: mkdtempSync(join(tmpdir(), "ccr-anchor-fix1-")), tier: "轻立项",
    });
    const d10a = r10a.ok ? (r10a.data as { needsConfirm?: boolean; confirm?: { id: string } } | undefined) : undefined;
    assert(r10a.ok === true && d10a?.needsConfirm === true && !!d10a.confirm
      && findKind("org-confirm", (n) => n.sourceContext.entityId === d10a.confirm?.id).length === 1,
      "N10① 旧 orgAction project-create 落单 → org-confirm 通知入账（漏接收口）");
    // 出口②结项 archive：种一行 running 台账（按锚点匹配）→ 清单非零 → 确认卡
    appendDispatch({ ts: Date.now(), id: "d-arch-fix1", tier: "随手办", target: "s-arch", status: "running", session_id: "s-arch", project_anchor: anchor });
    const r10b = mgr.orgAction("project-status", { id: d1?.group?.id, to: "archived" });
    const d10b = r10b.ok ? (r10b.data as { needsConfirm?: boolean; confirm?: { id: string } } | undefined) : undefined;
    assert(r10b.ok === true && d10b?.needsConfirm === true && !!d10b.confirm
      && findKind("org-confirm", (n) => n.sourceContext.entityId === d10b.confirm?.id).length === 1,
      "N10② 结项 archive 确认卡 → org-confirm 通知入账");
    // 出口③档位 tier-change：组 B 轻立项先决议激活，再升正经立项出卡
    const r10c0 = mgr.orgAction("project-create", {
      name: "R1FIX1 升档组", anchor: mkdtempSync(join(tmpdir(), "ccr-anchor-fix2-")), tier: "轻立项",
    });
    const d10c0 = r10c0.ok ? (r10c0.data as { group?: { id: string }; confirm?: { id: string } } | undefined) : undefined;
    const ack10c0 = send(mgr, "n10c0", "COMMAND_ORG_CONFIRM", { confirm_id: d10c0?.confirm?.id, approve: true }, "web-1");
    assert(ack10c0.ok === true, "N10③前置 升档组立项决议通过（激活）");
    const r10c = mgr.orgAction("project-tier", { id: d10c0?.group?.id, to: "正经立项", reason: "R1FIX1 fixture 升档" });
    const d10c = r10c.ok ? (r10c.data as { needsConfirm?: boolean; confirm?: { id: string } } | undefined) : undefined;
    assert(r10c.ok === true && d10c?.needsConfirm === true
      && findKind("org-confirm", (n) => n.sourceContext.entityId === d10c.confirm?.id).length === 1,
      "N10③ project-tier 出卡 → org-confirm 通知入账");
    // 出口④组暂缓 suggest-hold（手动，在办组）
    const r10d = mgr.orgAction("suggest-hold", { id: d10c0?.group?.id, reason: "R1FIX1 fixture 手动建议暂缓" });
    const d10d = r10d.ok ? (r10d.data as { needsConfirm?: boolean; confirm?: { id: string } } | undefined) : undefined;
    assert(r10d.ok === true && d10d?.needsConfirm === true
      && findKind("org-confirm", (n) => n.sourceContext.entityId === d10d.confirm?.id).length === 1,
      "N10④ suggest-hold（手动）出卡 → org-confirm 通知入账");
    // 出口⑤自动暂缓建议：组 D 立项激活后 updated_at 回溯 30 天 + 窗口收 7 天
    const r10e0 = mgr.orgAction("project-create", {
      name: "R1FIX1 沉睡组", anchor: mkdtempSync(join(tmpdir(), "ccr-anchor-fix3-")), tier: "轻立项",
    });
    const d10e0 = r10e0.ok ? (r10e0.data as { group?: { id: string }; confirm?: { id: string } } | undefined) : undefined;
    send(mgr, "n10e0", "COMMAND_ORG_CONFIRM", { confirm_id: d10e0?.confirm?.id, approve: true }, "web-1");
    const projectsFile = join(process.env.CCR_ORG_DIR as string, "projects.json");
    const pj10 = JSON.parse(readFileSync(projectsFile, "utf-8")) as { groups: { id: string; updated_at: number }[]; trust_light: boolean };
    const sleepy = pj10.groups.find((g) => g.id === d10e0?.group?.id);
    if (sleepy) sleepy.updated_at = Date.now() - 30 * 86_400_000;
    writeFileSync(projectsFile, JSON.stringify(pj10, null, 2) + "\n", "utf-8");
    const prevStale = process.env.CCR_ORG_STALE_DAYS;
    process.env.CCR_ORG_STALE_DAYS = "7";
    const sug = mgr.autoSuggestHold(Date.now());
    if (prevStale === undefined) delete process.env.CCR_ORG_STALE_DAYS;
    else process.env.CCR_ORG_STALE_DAYS = prevStale;
    const autoItem = findKind("org-confirm").find((n) => n.title === "建议暂缓：R1FIX1 沉睡组");
    assert(!!d10e0?.group?.id && sug.suggested.includes(d10e0.group.id) && !!autoItem,
      "N10⑤ autoSuggestHold 自动出卡 → org-confirm 通知入账（漏接收口）");
    // 三端投影对账：列表合计 + 持久 + 重启还原（零重发帧）
    // 六张 = 五入口目标卡（create/archive/tier/hold手动/hold自动）+ 出口③④共用的
    // 升档组建卡（轻立项首建同样出卡）；决议收口另有帧，不计入产生数
    assert(orgConfirmCount() === beforeN10 + 6,
      "N10⑥ 五入口各产一条 action 项（无漏接无重复；含前置建卡合计 6）");
    const keys10 = findKind("org-confirm").map((n) => n.key);
    assert(keys10.every((k) => storeFile()?.notifications.some((n) => n.key === k) === true),
      "N10⑦ notifications.json 持久落账（离线端兜底）");
    const framesBeforeRestart10 = frames.length;
    const mgr10 = new SessionManager(bus, cfg); // 同 dataDir 模拟重启
    assert(mgr10.notificationsList().filter((n) => n.kind === "org-confirm").length === beforeN10 + 6,
      "N10⑧ 重启还原：五入口通知全量在账");
    assert(frames.length === framesBeforeRestart10,
      "N10⑨ 重启还原零重发 NOTIFICATIONS_UPDATED（孤儿对账无变更不发声）");
    // 重启 manager 抢走了产生回调槽——绑回 mgr（模拟生产：后续命令仍由原 manager 承接）
    setConfirmCreatedHook((c: OrgConfirm) =>
      (mgr as unknown as { recordOrgConfirmNotification(c: OrgConfirm): void }).recordOrgConfirmNotification(c));
    void mgr10;

    // ---------- N11 P1-2 dispatch 终态出口 ----------
    console.log("N11 P1-2 dispatch 终态出口");
    // 出口③首次拉起失败：工厂抛异常 → failed 台账行 + action/error 通知（旧「CLI
    // 同步拿 error」例外只针对在线弹窗通道，账面不豁免）
    mgr.setAgentFactory((): AgentLike => { throw new Error("boom-spawn-fix1"); });
    const r11a = mgr.dispatchWorker({ anchor: CWD, prompt: "R1FIX1 首派失败" });
    mgr.setAgentFactory(makeFakeFactory(created));
    const spawnFail = findKind("dispatch", (n) => n.body.includes("boom-spawn-fix1"))[0];
    assert(r11a.ok === false && !!spawnFail && spawnFail.group === "action"
      && spawnFail.severity === "error" && spawnFail.actionable === true,
      "N11① 首次拉起失败 → failed 行 + action/error 可操作通知（离线可见）");
    // 出口④看门狗（recoveries 已达上限 → 一次 recoverFromStall 同时产接管 done 行
    // 与上限 failed 行两账；gaveUp 分支先落台账再返回，杀树路径不触达）
    const sid11 = create(CWD, "R1FIX1 看门狗通知");
    const cb11 = created[created.length - 1].cb;
    cb11.onInit("sdk-fix1-wd", "test-model");
    type WdState = { wd: { recoveries: number[]; phase: string; gaveUp: boolean }; state: { session_id: string } };
    const s11 = (mgr as unknown as { sessions: Map<string, WdState> }).sessions.get(sid11);
    if (s11) s11.wd.recoveries = [Date.now() - 1_200_000, Date.now() - 600_000];
    await (mgr as unknown as {
      recoverFromStall(s: WdState, lane: "slow" | "fast" | "ended", stalled: number, cpuDelta: number): Promise<void>;
    }).recoverFromStall(s11 as WdState, "slow", 11 * 60_000, 0);
    const wdDone = findKind("dispatch", (n) => n.title === "看门狗 单完成");
    const wdFail = findKind("dispatch", (n) => n.title === "看门狗 单失败");
    assert(wdDone.length === 1 && wdDone[0].group === "activity" && wdDone[0].actionable === false,
      "N11② 看门狗接管 done → activity 桶通知（不可操作）");
    assert(wdFail.length === 1 && wdFail[0].group === "action" && wdFail[0].severity === "error"
      && wdFail[0].actionable === true,
      "N11③ 看门狗上限 failed → action/error 可操作通知（结构化面兜底）");
    // 出口①重启悬账补记（closeHungDispatchRows 直测：种 running 行 → done 收敛 +
    // activity 通知；done/无 actor → Leader 注入按 M4 规则天然豁免）
    appendDispatch({ ts: Date.now() - 60_000, id: "d-hung-fix1", tier: "正经立项", target: "s-hung", status: "running", session_id: "s-hung", project_anchor: anchor });
    (mgr as unknown as { closeHungDispatchRows(): void }).closeHungDispatchRows();
    const hungLog = readDispatchLog().filter((e) => e.id === "d-hung-fix1");
    const hungItem = findKind("dispatch", (n) => n.sourceContext.entityId === "d-hung-fix1")[0];
    assert(hungLog.length === 1 && hungLog[0].status === "done" && !!hungItem
      && hungItem.group === "activity" && hungItem.severity === "done" && hungItem.actionable === false,
      "N11④ 重启悬账补记 → done 台账收敛 + activity 通知（台账/通知账对称）");

    // ---------- N12 P2-1 superseded waiting 精确收口 ----------
    console.log("N12 superseded waiting 收口");
    const sid12 = create(CWD, "R1FIX1 superseded 等待");
    const cb12 = created[created.length - 1].cb;
    cb12.onInit("sdk-fix1-sup", "test-model");
    cb12.onStatusChange("WORKING", "开工");
    const reqOld = { request_id: "req-old", tool_name: "Bash", input_summary: "旧请求", suggestions: [] as string[] };
    cb12.onWaiting(reqOld);
    cb12.onWaiting({ ...reqOld, request_id: "req-new", tool_name: "Write", input_summary: "新请求" });
    const wOld = findKind("waiting", (n) => n.key === `waiting:${sid12}:req-old`)[0];
    const wNew = findKind("waiting", (n) => n.key === `waiting:${sid12}:req-new`)[0];
    assert(!!wOld && !!wNew && wOld.resolved_at === undefined && wNew.resolved_at === undefined,
      "N12① 前置：双请求双账均在等（req-new 已替代 req-old）");
    cb12.onWaitingResolved("req-old", "allow", "web-x"); // 迟到的旧决议
    const wOldAfter = findKind("waiting", (n) => n.key === `waiting:${sid12}:req-old`)[0];
    const wNewAfter = findKind("waiting", (n) => n.key === `waiting:${sid12}:req-new`)[0];
    assert((wOldAfter.resolved_at ?? 0) > 0 && wNewAfter.resolved_at === undefined,
      "N12② 迟到旧决议：旧 key 精确收口，当前 req-new 账未动");
    const st12 = (mgr as unknown as { sessions: Map<string, { state: { status: string; waiting_request?: { request_id: string } } }> })
      .sessions.get(sid12)?.state;
    assert(st12?.status === "WAITING" && st12?.waiting_request?.request_id === "req-new",
      "N12③ 状态机不受牵连：仍 WAITING 且当前请求是 req-new");

    // ---------- N13 P2-2 确认副作用失败语义 ----------
    console.log("N13 副作用失败 error 面");
    const r13 = mgr.orgAction("project-create", {
      name: "R1FIX1 劈叉组", anchor: mkdtempSync(join(tmpdir(), "ccr-anchor-fix4-")), tier: "正经立项",
    });
    const d13 = r13.ok ? (r13.data as { group?: { id: string }; confirm?: { id: string } } | undefined) : undefined;
    // 手术：组从事实源抹掉 → 激活副作用必失败（setGroupStatus 组不存在）
    const pj13 = JSON.parse(readFileSync(projectsFile, "utf-8")) as { groups: { id: string }[]; trust_light: boolean };
    pj13.groups = pj13.groups.filter((g) => g.id !== d13?.group?.id);
    writeFileSync(projectsFile, JSON.stringify({ groups: pj13.groups, trust_light: pj13.trust_light }, null, 2) + "\n", "utf-8");
    const ack13 = send(mgr, "n13", "COMMAND_ORG_CONFIRM", { confirm_id: d13?.confirm?.id, approve: true }, "web-1");
    const failItem = findKind("org-confirm", (n) => n.sourceContext.entityId === d13?.confirm?.id)[0];
    assert(ack13.ok === false && typeof ack13.error === "string",
      "N13① 激活失败 → 决议命令错误回执（决议留痕不回滚）");
    assert(!!failItem && failItem.resolved_at === undefined && failItem.severity === "error"
      && failItem.title.includes("决议执行失败") && failItem.actionable === true,
      "N13② 同 key 原地转 error 告警面：不 resolved、可操作（旧序失败时显示已决）");
    assert(!!failItem && failItem.body.includes("org set"),
      "N13③ error 面带补救通道指引（决议已留痕 + 直达通道）");
    assert(!!failItem && storeFile()?.notifications.some((n) => n.key === failItem.key && n.severity === "error") === true,
      "N13④ error 面持久落账（重启后可见）");

    // ---------- N14 P2-5 确认单孤儿对账 ----------
    console.log("N14 孤儿对账");
    const orphanId = d10d?.confirm?.id as string;
    const confirmsFile = join(process.env.CCR_ORG_DIR as string, "confirms.json");
    const cf14 = JSON.parse(readFileSync(confirmsFile, "utf-8")) as { confirms: { id: string }[] };
    cf14.confirms = cf14.confirms.filter((c) => c.id !== orphanId);
    writeFileSync(confirmsFile, JSON.stringify(cf14, null, 2) + "\n", "utf-8");
    const orphanBefore = findKind("org-confirm", (n) => n.sourceContext.entityId === orphanId)[0];
    assert(!!orphanBefore && orphanBefore.resolved_at === undefined,
      "N14① 前置：通知在账 pending、事实源已无此确认单（孤儿形态）");
    const mgr14 = new SessionManager(bus, cfg); // 同 dataDir 重启 → 启动对账
    const orphanAfter = mgr14.notificationsList().find((n) => n.sourceContext.entityId === orphanId);
    assert(!!orphanAfter && (orphanAfter.resolved_at ?? 0) > 0 && orphanAfter.body.includes("孤儿对账"),
      "N14② 重启对账：孤儿确认单通知自动收口并在 body 记原因");
    const ack14 = send(mgr14, "n14", "COMMAND_ORG_CONFIRM", { confirm_id: orphanId, approve: true }, "web-1");
    const orphanFinal = mgr14.notificationsList().find((n) => n.sourceContext.entityId === orphanId);
    assert(ack14.ok === false && (orphanFinal?.resolved_at ?? 0) > 0,
      "N14③ 重放决议 → 确认单不存在拒收（decideConfirm 口径）；通知保持 resolved 不复活");
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
    else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwdEnv === undefined) delete process.env.CCR_CWD;
    else process.env.CCR_CWD = prevCwdEnv;
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\nR1c notification 真链路：${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
