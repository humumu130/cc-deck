// #018-R1c 决策通知真链路接入 SessionManager 集成测试（fake factory 缝仿 r1a/r1b）。
// 覆盖：N1 org-confirm 源产生（R1b orgCommand needsConfirm 落单）+ 持久；N2 waiting
//       源 + stableKey 去重 + 翻回 resolved + 已决不复活；N3 终态收口；N4 dispatch
//       源（done/failed 分桶）+ 一单一行去重；N5 ACK 生命周期三态 + 幂等不复活 +
//       未知 key 拒收；N6 值变才发（同值静默）；N7 重启还原进快照数据源（零重发帧）；
//       N8 坏 JSON 容错 + 写侧还原；N9 未知命令 B0 default 收口。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
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
    closeDispatch.call(mgr3, { id: "d-3", tier: "咨询" }, "done", "重启后首单", "s-x");
    const parsed = storeFile();
    assert(Array.isArray(parsed?.notifications) && parsed.notifications.some((n) => n.key === "dispatch:d-3"),
      "N8② 写侧首落还原合法存储（可解析）");

    // ---------- N9 未知命令 B0 default（两入口同源） ----------
    console.log("N9 未知命令收口");
    const ack10 = send(mgr, "n9", "COMMAND_NOTIFICATION_BOGUS", {}, "web-1");
    assert(ack10.ok === false && ack10.error === "unsupported command",
      "N9① 未知命令走 B0 execCommand default");
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
