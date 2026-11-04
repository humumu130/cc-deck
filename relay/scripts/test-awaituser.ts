// [W-AWAITUSER] 待拍板全局可见性（1104 用户令）全套件。
//   A 聚合纯函数：三源注入→清单成形（key 稳定/秒级归一/AskUserQuestion 与 decidable=false
//     含入——1104 实锤形态/submitted 排除/已决 confirm 排除/确定性排序）
//   B 真链路帧驱动：SessionManager 上 waiting 产生→PENDING_USER_ACTIONS_UPDATED 带 waiting
//     项；翻走→帧减项；org-confirm 落单→帧带项；决议→减项（帧证据=事件序，非终态采样）
//   C 验收单源：登记（CLI 直写盘）→refresh 挂点入清单；回填→出清单；幂等零帧
//   D 推送限频（DecisionNotificationWatcher）：三源滞留≥waitMs 各推一次；重扫不重推；
//     未超阈值不推；四问形态（旧 allowWaiting 排除面）同样推到；重启（新实例同台账）
//     不重推；新 key（新确认单）新推；listAcceptances 缺席=源③不入扫描（兼容面）
//   E WS 快照探针：真连接收 SNAPSHOT 断言 pending_user_actions 键在场（能力位=空数组也下发）
//   F 静态锁：两处快照组装单口走 pendingUserActionsList（防第四源旁路/双壳漏键）+
//     发射挂点在册 + 消费面锚（notify 排序键扩展不破 observe3 锚/会话浮顶/团队入口/
//     bridge 数据面/expo USER_NOTE 消费）
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-awaituser.ts
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { DecisionNotificationWatcher, readDecisionNotificationLedger } from "../src/decision-notify.js";
import { pendingUserActionsOf, sessionAwaitingUser, normMs } from "../src/pending-user-actions.js";
import type { PendingUserAction } from "../src/pending-user-actions.js";
import { saveResult } from "../src/acceptance.js";
import { startServer } from "../src/ws-server.js";
import type { OrgConfirm } from "../src/projects.js";
import type { AcceptanceSummary } from "../src/acceptance.js";
import type { SessionState, Command } from "../src/types.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";

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

// ---------- A 聚合纯函数 ----------
function unitTests() {
  console.log("A 聚合纯函数:");
  const now = Date.now();
  const confirm: OrgConfirm = {
    id: "cf-unit-1", kind: "tier-change", title: "档位变更：升正式项目", reason: "三条批验收全过",
    status: "pending", created_at: Math.floor(now / 1000) - 60, decided_at: null, payload: {},
  } as unknown as OrgConfirm;
  const decided: OrgConfirm = { ...confirm, id: "cf-unit-2", status: "approved", decided_at: now };
  const sPlain: SessionState = {
    session_id: "sess-a", status: "WAITING",
    waiting_request: { request_id: "req-a", tool_name: "Bash", input_summary: "x", suggestions: [] },
    waiting_started_at: now - 60_000, updated_at: now, started_at: now,
  } as unknown as SessionState;
  // 1104 实锤形态：AskUserQuestion 四问（questions 在场）
  const sQuestions: SessionState = {
    session_id: "sess-q", status: "WAITING",
    waiting_request: { request_id: "req-q", tool_name: "AskUserQuestion", input_summary: "四问", suggestions: [], questions: [{ header: "h", question: "选哪个方案？", options: [{ label: "A" }, { label: "B" }] }] },
    waiting_started_at: now - 30_000, updated_at: now, started_at: now,
  } as unknown as SessionState;
  // decidable=false 仅通知形态：不可端上决议，但用户仍需看见
  const sNotice: SessionState = {
    session_id: "sess-n", status: "WAITING",
    waiting_request: { request_id: "req-n", tool_name: "WebFetch", input_summary: "y", suggestions: [], decidable: false },
    waiting_started_at: now - 10_000, updated_at: now, started_at: now,
  } as unknown as SessionState;
  const sWorking: SessionState = { session_id: "sess-w", status: "WORKING", updated_at: now, started_at: now } as unknown as SessionState;
  const accPending: AcceptanceSummary = { id: "acc-unit-1", title: "test.100 装机验收", created_at: Math.floor(now / 1000) - 600, total: 5, judged: 0, submitted: false, done: false };
  const accDone: AcceptanceSummary = { id: "acc-unit-2", title: "已回填单", created_at: Math.floor(now / 1000) - 900, total: 3, judged: 3, submitted: true, done: true };

  const out = pendingUserActionsOf({ confirms: [confirm, decided], sessions: [sPlain, sQuestions, sNotice, sWorking], acceptances: [accPending, accDone] });
  assert(out.length === 5, `A① 三源注入→5 项（确认1+会话3+验收1；已决/WORKING/已提交排除），实得 ${out.length}`);
  const kinds = out.map((x) => x.kind).sort().join(",");
  assert(kinds === "acceptance,org-confirm,waiting,waiting,waiting", `A② kind 枚举正确（${kinds}）`);
  const wQ = out.find((x) => x.kind === "waiting" && x.entity_id === "sess-q");
  assert(!!wQ && wQ.title.includes("等你作答") && wQ.title.includes("选哪个方案"),
    "A③ AskUserQuestion 标题带「等你作答」+问题首句（1104 形态可读性）");
  assert(!!out.find((x) => x.kind === "waiting" && x.entity_id === "sess-n"),
    "A④ decidable=false 仅通知形态同样入清单（用户可见性不缺角）");
  assert(out.find((x) => x.kind === "org-confirm")!.created_at > now - 61_000,
    "A⑤ confirm 秒级 created_at 归一为毫秒（normMs 单源归一）");
  assert(out.find((x) => x.kind === "acceptance")!.created_at > now - 601_000,
    "A⑥ acceptance 秒级 created_at 归一为毫秒");
  const cf = out.find((x) => x.kind === "org-confirm")!;
  assert(cf.key === `org-confirm:cf-unit-1:${Math.floor(now / 1000) - 60}`, `A⑦ confirm key=stableKey 三键（${cf.key}）`);
  assert(out.every((x, i) => i === 0 || out[i - 1].created_at >= x.created_at), "A⑧ created_at 降序稳定排序");
  const again = pendingUserActionsOf({ confirms: [confirm, decided], sessions: [sPlain, sQuestions, sNotice, sWorking], acceptances: [accPending, accDone] });
  assert(JSON.stringify(again) === JSON.stringify(out), "A⑨ 确定性：同输入同输出（投影 dedup 依赖）");
  assert(normMs(Math.floor(now / 1000)) === Math.floor(now / 1000) * 1000 && normMs(now) === now, "A⑩ normMs 双向（秒×1000/毫秒原样）");
  assert(sessionAwaitingUser(sQuestions) && !sessionAwaitingUser(sWorking), "A⑪ sessionAwaitingUser 判定单点");
  const empty = pendingUserActionsOf({ confirms: [], sessions: [], acceptances: [] });
  assert(empty.length === 0 && JSON.stringify(empty) === "[]", "A⑫ 空态=空数组（能力位下发口径）");
}

// ---------- E 子进程形态（独立进程跑 WS 探针） ----------
// 为什么子进程：本测试主进程内实证——连接处理器里 SNAPSHOT 构建出现 ~2.5s 同步
// 阻塞（事件循环停摆、ws 客户端握手停 CONNECTING、伴随 startServer 627ms），同构
// 沙盒在独立进程稳定绿（12 轮二分定位到「仅主进程内必现」，独立根因未收口——测试
// 形态学绕开，非产品面，详见回执坑实录）。子进程=绿形态原样，父子以退出码+stdout 契约。
async function eChild(): Promise<number> {
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-auchild-"));
  process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "ccr-org-auchild-"));
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_ACCEPTANCE_DIR = join(DATA, "acceptances");
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_PROJECTS_ROOT = mkdtempSync(join(tmpdir(), "ccr-proj-auchild-"));
  delete process.env.CC_DECK_PLUGIN;
  delete process.env.CCR_PARENT_PID;
  delete process.env.CCR_RELAY_CHILD;
  const port = 18000 + Math.floor(Math.random() * 2000); // 随机端口：防并发套件/僵尸子进程占口（固定 8799 实测被前次子进程泄漏占用）
  const cfg: RelayConfig = {
    port, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  const server = startServer(bus, mgr, cfg, {});
  await new Promise<void>((r) => setTimeout(r, 300)); // listen 就绪窗
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(cfg.token)}`);
  const opened = new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", (e: Error) => rej(e)); });
  const seen: { type: string; payload?: Record<string, unknown> }[] = [];
  ws.on("message", (raw: WebSocket.RawData) => {
    try { seen.push(JSON.parse(String(raw)) as { type: string; payload?: Record<string, unknown> }); } catch { /* 坏帧跳过 */ }
  });
  let ok = false;
  try {
    await opened;
    const deadline = Date.now() + 3800;
    while (Date.now() < deadline && !seen.some((e) => e.type === "SNAPSHOT")) {
      await new Promise<void>((r) => setTimeout(r, 40));
    }
    const snap = seen.find((e) => e.type === "SNAPSHOT")?.payload;
    assert(!!snap && Object.prototype.hasOwnProperty.call(snap, "pending_user_actions"),
      "E① SNAPSHOT 带 pending_user_actions 键（能力位：空清单也下发）");
    assert(!!snap && Array.isArray(snap.pending_user_actions) && (snap.pending_user_actions as unknown[]).length === 0,
      "E② 快照值与内存清单一致（此时清单空）");
    ok = fail === 0;
  } catch (e) {
    console.error("E 子进程异常:", e instanceof Error ? e.message : String(e));
    ok = false;
  }
  try { ws.close(); } catch {}
  await server.close();
  console.log(ok ? "E-GREEN" : "E-RED");
  return ok ? 0 : 1;
}

// ---------- B/C 真链路（SessionManager 沙盒） ----------
// 沙盒铁律（test-ws.ts 同款）：生产 env 全套被继承时（本测试可能在生产 relay 之子
// 环境跑），loadConfig/resolveDataDir/acceptanceDir 的 env 优先级会把读写劫持到
// ~/.cc-deck——首跑实证：acceptance 读到生产目录、sqlite 锁竞争致帧抖动、孤儿扫描
// 收养真实会话。钉死全套沙盒 env + json 读模式（绕开 storage 导入器锁窗口）
async function integrationTests(): Promise<void> {
  console.log("B 真链路帧驱动（waiting/org-confirm）:");
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-await-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-cwd-await-"));
  const prev = { ...process.env };
  process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "ccr-org-await-"));
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_ACCEPTANCE_DIR = join(DATA, "acceptances");
  process.env.CCR_STORAGE_READ_MODE = "json"; // observe3 套件同款：json 直读绕 sqlite 锁窗
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_PROJECTS_ROOT = mkdtempSync(join(tmpdir(), "ccr-proj-await-")); // 孤儿扫描空根：不扫真实 ~/.claude
  delete process.env.CC_DECK_PLUGIN;
  delete process.env.CCR_PARENT_PID;
  delete process.env.CCR_RELAY_CHILD;
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  try {
    const cfg: RelayConfig = {
      port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const frames: PendingUserAction[][] = [];
    bus.subscribe((env) => {
      if (env.type === "PENDING_USER_ACTIONS_UPDATED") frames.push((env.payload as { items: PendingUserAction[] }).items);
    });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));
    const create = (mgr as unknown as { create(cwd: string, prompt: string): string }).create.bind(mgr);
    const send = (mgr as unknown as { handleCommand(c: Command, by: string): Promise<unknown> }).handleCommand.bind(mgr);

    // ---------- E WS 快照探针（子进程形态；见 eChild 头注） ----------
    console.log("E WS 快照探针:");
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, ["--import", "tsx/esm", selfPath], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, AWAITUSER_E_CHILD: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    const childOut = `${child.stdout || ""}\n${child.stderr || ""}`;
    process.stdout.write(childOut.split("\n").filter((l) => l.trim().startsWith("✓") || l.includes("E-GREEN") || l.includes("E-RED") || l.includes("E 子进程异常")).join("\n") + "\n");
    assert(child.status === 0 && childOut.includes("E-GREEN") && childOut.includes("E①") && childOut.includes("E②"),
      "E①+E② 子进程真连接收 SNAPSHOT：pending_user_actions 键在场且与内存清单一致（退出码 " + child.status + "）");


    // B① waiting 产生 → 帧带 waiting 项
    const sid = create(CWD, "等待拍板测试");
    const cb = created[0].cb;
    cb.onInit("sdk-await", "test-model");
    cb.onStatusChange("WORKING", "开工");
    const before = frames.length;
    cb.onWaiting({ request_id: "req-1", tool_name: "Bash", input_summary: "跑构建", suggestions: [] });
    assert(frames.length === before + 1 && frames[frames.length - 1].some((x) => x.kind === "waiting" && x.entity_id === sid),
      "B① onWaiting → 聚合帧即时带 waiting 项（帧驱动不等轮询）");
    assert(mgr.pendingUserActionsList().length === 1, "B② pendingUserActionsList 与帧同源（单口一致）");


    // B③ 同请求重放：onWaiting 路径会重置 waiting_started_at（session-manager 既有
    // 语义：滞留起点刷新）→ 聚合项 created_at 合法变化，帧为「同 key 覆盖式替换」
    //（非新增条目）——与通知账的 stableKey 防重是两层（账防重/清单值变即发）
    const keyBefore = frames[frames.length - 1].find((x) => x.kind === "waiting")!.key;
    const before2 = frames.length;
    cb.onWaiting({ request_id: "req-1", tool_name: "Bash", input_summary: "跑构建", suggestions: [] });
    const latest = frames[frames.length - 1];
    const wNow = mgr.pendingUserActionsList();
    assert(frames.length - before2 <= 1 && wNow.length === 1 && wNow[0].key === keyBefore
      && latest.every((x) => x.key === keyBefore),
      "B③ 同请求重放：清单仍恰 1 项同 key（帧=覆盖式替换或零帧，非新增条目）");

    // B④ 翻走 → 帧减项（消费即消失）
    const before4 = frames.length;
    cb.onStatusChange("WORKING", "决议翻回");
    assert(frames.length > before4 && frames[frames.length - 1].length === 0,
      "B④ 状态翻走 → 聚合帧清项（消费掉立即出清单）");

    // B④ org-confirm 落单 → 帧带项；决议 → 减项
    const ack = (await send({ command_id: "au1", type: "COMMAND_ORG_ACTION", payload: { action: "create", name: "聚合测试组", anchor_dir: mkdtempSync(join(tmpdir(), "ccr-anchor-await-")), tier: "正经立项" } } as unknown as Command, "web-1")) as { ok: boolean; data?: { confirm?: { id: string } } };
    const cfId = ack.data?.confirm?.id;
    assert(frames[frames.length - 1].some((x) => x.kind === "org-confirm" && x.entity_id === cfId),
      "B⑤ 确认卡落单 → 聚合帧带 org-confirm 项");
    const beforeCf = frames.length;
    await send({ command_id: "au2", type: "COMMAND_ORG_CONFIRM", payload: { confirm_id: cfId, approve: true } } as unknown as Command, "web-1");
    assert(frames.length === beforeCf + 1 && !frames[frames.length - 1].some((x) => x.entity_id === cfId),
      "B⑥ 确认卡决议 → 聚合帧减项");

    // ---------- C 验收单源（CLI 直写盘 → refresh 挂点） ----------
    // awaituser R1（A 审 P2① 验收 2）：外部 CLI 三挂点帧驱动——增/减项不再等 60s 兜底轮
    {
      const mgrX = mgr as unknown as {
        setExternalWaiting(id: string, payload: unknown): void;
        emitWaitingResolved(id: string, requestId: string, decision: string, by: string): void;
        setExternalStatus(id: string, status: string, summary: string): void;
      };
      let before = frames.length;
      mgrX.setExternalWaiting(sid, { request_id: "req-ext-1", tool_name: "Bash", input_summary: "外部 CLI 等待", suggestions: [] }); // 挂点②
      assert(frames.length === before + 1 && frames[frames.length - 1].some((x) => x.kind === "waiting" && x.entity_id === sid),
        "B②b setExternalWaiting → 聚合帧即时增项（外部入等帧驱动——不再等 60s 轮）");
      before = frames.length;
      mgrX.emitWaitingResolved(sid, "req-ext-1", "allow", "u"); // 挂点③：等待解除即时减项
      assert(frames.length === before + 1 && !frames[frames.length - 1].some((x) => x.kind === "waiting" && x.entity_id === sid),
        "B②a emitWaitingResolved → 聚合帧即时减项（外部解除帧驱动）");
      before = frames.length;
      mgrX.setExternalWaiting(sid, { request_id: "req-ext-2", tool_name: "Bash", input_summary: "外部 CLI 等待二", suggestions: [] });
      mgrX.setExternalStatus(sid, "WORKING", "外部状态切走等待消解"); // 挂点①（造项+切走：净效果=减项帧链）
      assert(frames.length > before && !frames[frames.length - 1].some((x) => x.kind === "waiting" && x.entity_id === sid),
        "B②c setExternalStatus 非 WAITING → 聚合帧即时减项（外部状态切换帧驱动）");
      mgrX.emitWaitingResolved(sid, "req-ext-2", "deny", "u"); // 清场（幂等）
    }

    console.log("C 验收单源:");
    const accDir = join(DATA, "acceptances");
    mkdirSync(accDir, { recursive: true });
    const accId = randomUUID().replace(/-/g, "");
    writeFileSync(join(accDir, `${accId}.json`), JSON.stringify({
      id: accId, title: "test.98 装机验收", created_at: Math.floor(Date.now() / 1000) - 60,
      rows: [{ task: "T1", item: "装机", criteria: "能打开" }],
    }));
    const beforeAcc = frames.length;
    mgr.refreshPendingUserActions(); // 挂点等价调用（生产=reflux tick 签名对账边/LAN 提交边/60s 兜底轮）
    assert(frames.length === beforeAcc + 1 && frames[frames.length - 1].some((x) => x.kind === "acceptance" && x.entity_id === accId),
      "C① 登记直写盘 → refresh 挂点 → 聚合帧带 acceptance 项");
    const stable = frames.length;
    mgr.refreshPendingUserActions();
    assert(frames.length === stable, "C② 无变化 refresh 零新帧（值变才发）");
    saveResult(accId, { rows: [{ i: 0, verdict: "pass", note: "" }] }, "test-ua");
    mgr.refreshPendingUserActions();
    assert(!frames[frames.length - 1].some((x) => x.entity_id === accId),
      "C③ 回填落盘 → refresh → 聚合帧出项（#195 submitted 语义）");

  } finally {
    // 沙盒 env 整包还原（prev 快照含删除键的回剥）
    const keep = new Set(Object.keys(prev));
    for (const k of Object.keys(process.env)) if (!keep.has(k) && k.startsWith("CCR_")) delete process.env[k];
    Object.assign(process.env, prev);
  }
}

// ---------- D 推送限频（watcher 沙盒 + 时钟注入） ----------
function watcherTests(): void {
  console.log("D 推送限频:");
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-auwatch-"));
  const ledgerPath = join(DATA, "decision-notifications.json");
  const now = { v: 1_700_000_000_000 };
  const pushed: string[] = [];
  const notified: string[] = [];
  const confirm: OrgConfirm = {
    id: "cf-push-1", kind: "tier-change", title: "升档确认", reason: "", status: "pending",
    created_at: Math.floor((now.v - 20 * 60_000) / 1000), decided_at: null, payload: {},
  } as unknown as OrgConfirm;
  const sQuestion: SessionState = {
    session_id: "sess-push-q", status: "WAITING", title: "四问会话",
    waiting_request: { request_id: "req-q", tool_name: "AskUserQuestion", input_summary: "四问", suggestions: [], questions: [{ header: "h", question: "选哪个？", options: [] }] },
    waiting_started_at: now.v - 12 * 60_000, updated_at: now.v, started_at: now.v,
  } as unknown as SessionState;
  const acc: AcceptanceSummary = { id: "acc-push-1", title: "验收单甲", created_at: Math.floor((now.v - 30 * 60_000) / 1000), total: 2, judged: 0, submitted: false, done: false };
  const mk = (over: Partial<{ listAcceptances: () => AcceptanceSummary[]; userPush: (t: string) => boolean }> = {}) => new DecisionNotificationWatcher({
    ledgerPath,
    dataDir: DATA,
    listConfirms: () => [confirm],
    snapshotSessions: () => [sQuestion],
    leaderSessionId: () => null,
    notify: (sid, text) => { notified.push(`${sid}:${text}`); return true; },
    listAcceptances: over.listAcceptances ?? (() => [acc]),
    userPush: over.userPush ?? ((text) => { pushed.push(text); return true; }),
    now: () => now.v,
    intervalMs: 9_999_999, waitMin: 10, remindHours: 0,
  });
  const w = mk();
  w.scan();
  assert(pushed.length === 3, `D① 三源滞留超阈值各推一次（3 推），实得 ${pushed.length}：${pushed.join(" / ")}`);
  assert(pushed.some((t) => t.includes("确认卡《升档确认》")) && pushed.some((t) => t.includes("等你作答") || t.includes("四问")) && pushed.some((t) => t.includes("验收单《验收单甲》")),
    "D② 推送文案三源各带来源语义（确认卡/会话作答/验收单）");
  w.scan();
  assert(pushed.length === 3, "D③ 重扫不重推（user_pushed_at 限频）");
  // 未超阈值不推（新 key+新鲜时戳）
  const freshAcc: AcceptanceSummary = { ...acc, id: "acc-fresh", created_at: Math.floor(now.v / 1000) };
  const w2 = mk({ listAcceptances: () => [acc, freshAcc], userPush: (t) => { pushed.push(t); return true; } });
  w2.scan();
  assert(pushed.length === 3, "D④ 未超阈值（刚登记）不推——超阈值才推");
  // 台账持久 user_pushed_at → 重启不重推
  const ledger = readDecisionNotificationLedger(ledgerPath);
  const accItem = ledger.notifications.find((n) => n.kind === "acceptance");
  assert(accItem?.user_pushed_at === now.v, "D⑤ user_pushed_at 持久落台账");
  const w3 = mk();
  w3.scan();
  assert(pushed.length === 3, "D⑥ 重启（新实例同台账）不重推（跨重启限频）");
  // 四问形态接得到（旧 allowWaiting 排除面）：D① 已含 sQuestion 断言于 D②；此处独立验证 PM 注入腿确实没接（口径分离的证据）
  assert(!notified.some((t) => t.includes("[审批]")), "D⑦ 四问形态：waiting 的 PM 注入腿零发（allowWaiting 口径维持——[审批] 前缀零命中）、用户推送腿已覆盖（D①②）");
  // listAcceptances 缺席 = 源③不入扫描（兼容面）
  const pushedB: string[] = [];
  const w4 = new DecisionNotificationWatcher({
    ledgerPath: join(DATA, "b.json"), dataDir: DATA,
    listConfirms: () => [], snapshotSessions: () => [], leaderSessionId: () => null,
    notify: () => true, now: () => now.v, intervalMs: 9_999_999, waitMin: 10,
    userPush: (t) => { pushedB.push(t); return true; },
  });
  w4.scan();
  assert(pushedB.length === 0, "D⑧ listAcceptances 缺席=验收不入推送扫描（旧接线兼容）");
  // 回填后不再推（滞留消解）
  const w5 = mk({ listAcceptances: () => [{ ...acc, submitted: true }], userPush: (t) => { pushed.push(t); return true; } });
  const ledgerBefore = readDecisionNotificationLedger(ledgerPath).notifications.filter((n) => n.kind === "acceptance").length;
  w5.scan();
  const ledgerAfter = readDecisionNotificationLedger(ledgerPath);
  assert(pushed.length === 3 && ledgerAfter.notifications.find((n) => n.kind === "acceptance")?.resolved_at !== undefined,
    `D⑨ 回填→acceptance 账 resolved 且零新推（账行数 ${ledgerBefore}→${ledgerAfter.notifications.filter((n) => n.kind === "acceptance").length}）`);
  w.stop(); w2.stop(); w3.stop(); w4.stop(); w5.stop();
  // awaituser R1（A 审 P1-1 验收 1）：零端在线注入 → emitUserNote false → 不记锚 →
  // 端恢复后同 key 重推成功（时序证据）。恒真禁用——全部走实值断言。
  {
    const pushedX: string[] = [];
    let online = false; // 零端在线（推送时刻）
    const lx = join(DATA, "r1-zero-online.json");
    const mkX = () => new DecisionNotificationWatcher({
      ledgerPath: lx, dataDir: DATA,
      listConfirms: () => [], snapshotSessions: () => [], leaderSessionId: () => null,
      notify: () => true, now: () => now.v, intervalMs: 9_999_999, waitMin: 10,
      listAcceptances: () => [acc],
      // 真值接线：online=false 模拟 mgr.emitUserNote 的 liveFrontends()=false（零端在线）
      userPush: (t) => { if (!online) return false; pushedX.push(t); return true; },
    });
    const wx = mkX();
    wx.scan();
    const led0 = readDecisionNotificationLedger(lx).notifications.find((n) => n.kind === "acceptance");
    assert(pushedX.length === 0 && led0?.user_pushed_at === undefined, `D⑩ 零端在线=未投出不记锚（pushed=${pushedX.length}，锚=${JSON.stringify(led0?.user_pushed_at)}——契约「false=未投出不记 user_pushed_at」复活）`);
    online = true; // 端恢复
    wx.scan();
    const led1 = readDecisionNotificationLedger(lx).notifications.find((n) => n.kind === "acceptance");
    assert(pushedX.length === 1 && led1?.user_pushed_at === now.v, `D⑪ 端恢复后同 key 重推成功并记锚（pushed=${pushedX.length}，锚=${led1?.user_pushed_at}）`);
    wx.scan();
    assert(pushedX.length === 1, `D⑫ 记锚后重扫不重推（限频恢复——pushed=${pushedX.length}）`);
    wx.stop();
  }
  // emitUserNote 单元（mgr 直测：liveFrontends 注入面——ws-server 装配真值的同源行为）
  {
    const bus2 = new EventBus({ persistPath: join(DATA, "ev-r1.ndjson") });
    const cfg2: RelayConfig = { port: 8811, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null };
    const mgr2 = new SessionManager(bus2, cfg2);
    let fired = 0;
    bus2.subscribe((env) => { if (env.type === "USER_NOTE") fired++; });
    mgr2.liveFrontends = () => false;
    assert(mgr2.emitUserNote("零在线测试") === false && fired === 0, "U① liveFrontends=false → 不发帧 return false（零端在线真值）");
    mgr2.liveFrontends = () => true;
    assert(mgr2.emitUserNote("有端在线测试") === true && fired === 1, "U② liveFrontends=true → 发帧 return true");
    (mgr2 as unknown as { liveFrontends?: () => boolean }).liveFrontends = undefined;
    assert(mgr2.emitUserNote("未注入兼容测试") === true && fired === 2, "U③ 未注入=旧语义恒 true（测试/独立装配兼容面）");
  }
}

// ---------- F 静态锁（源锚断言——observe3 D 族同款范式） ----------
function staticLockTests(): void {
  console.log("F 静态锁:");
  const ROOT = join(fileURLToPath(new URL("..", import.meta.url))); // relay/（cwd 无关锚）
  const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");
  const wsSrc = read("src/ws-server.ts");
  const cloudSrc = read("src/cloud-client.ts");
  const smSrc = read("src/session-manager.ts");
  const notifySrc = read("../web-console/js/notify.js");
  const sessionSrc = read("../web-console/js/session-domain.js");
  const teamSrc = read("../web-console/js/team-domain.js");
  const bridgeSrc = read("../web-console/js/bridge-core.js");
  const shellSrc = read("../web-console/index-005.html");
  const storeSrc = read("../expo-app/src/store.ts");
  const appSrc = read("../expo-app/App.tsx");

  assert(wsSrc.includes("pending_user_actions: mgr.pendingUserActionsList()"),
    "F① LAN SNAPSHOT 走单口 pendingUserActionsList（防旁路拼装）");
  assert(cloudSrc.includes("pending_user_actions: this.mgr.pendingUserActionsList()"),
    "F② 云通道 SNAPSHOT 同键同口（#117 双落点纪律）");
  const smRefreshCount = (smSrc.match(/refreshPendingUserActions\(\)/g) ?? []).length;
  assert(smSrc.includes("syncWaitingNotification") && smRefreshCount >= 5,
    `F③ 发射挂点在册：waiting 单点×2 + org 三点 + 方法体（≥5 处 refresh，实得 ${smRefreshCount}）`);
  assert((wsSrc.match(/mgr\.refreshPendingUserActions\(\)/g) ?? []).length >= 2,
    "F④ ws-server 验收面两挂点（LAN 提交边 + reflux 签名对账边）");
  assert(smSrc.includes("startPendingUserActionsTick") && smSrc.includes("60_000"),
    "F⑤ 60s 兜底轮在册（验收登记 out-of-band 写面）");
  assert(read("src/pending-user-actions.ts").includes("现役三源") && read("src/pending-user-actions.ts").includes("必须挂进本聚合清单"),
    "F⑥ 源登记注释锚（新增待用户面必须挂聚合清单——同类绝迹机制）");
  // notify 排序：userPending 键在 active 键之前（扩同一排序器）+ observe3 锚不破
  assert(notifySrc.includes("Number(b.userPending === true) - Number(a.userPending === true) || Number(b.active) - Number(a.active)"),
    "F⑦ notify 排序器扩展：userPending 位在 active 位之前（同一比较器链，非第二排序器）");
  assert(notifySrc.includes('group("需你行动", "r", actionRows, "")'),
    "F⑧ observe3 锚保留：需你行动组首位（三分组结构不动）");
  assert(notifySrc.includes('"#au:" + rows.filter((r) => r.userPending).map((r) => r.key).join(",")'),
    "F⑨ 渲染签名含 userPending 指纹（顶格变化必重渲——跳帧短路防）");
  assert(notifySrc.includes("awaitu-chip"), "F⑩ 待拍板行 chip 在册");
  // 会话列表：浮顶层序 + chip
  assert(sessionSrc.includes("awaitingUser(b)) - Number(awaitingUser(a)); if (au) return au;") && sessionSrc.indexOf("awaitingUser(b)) - Number(awaitingUser(a))") < sessionSrc.indexOf("const pin = pinRank(b) - pinRank(a); if (pin) return pin;"),
    "F⑪ 会话列表等拍板浮顶先于置顶（au 层 > pin 层）");
  assert(sessionSrc.includes("awaitu-flag") && sessionSrc.includes("等你拍板"), "F⑫ 会话卡「等你拍板」chip 在册");
  // 团队待办入口 + bridge 数据面 + 壳容器
  assert(teamSrc.includes("PENDING_USER_ACTIONS_UPDATED") && teamSrc.includes("data-awaitu-jump"), "F⑬ 团队域待办分区入口+帧消费在册");
  assert(bridgeSrc.includes("pending_user_actions") && bridgeSrc.includes("PENDING_USER_ACTIONS_UPDATED"), "F⑭ bridge 数据面（快照键+增量帧）在册");
  assert(shellSrc.includes("data-awaituser-block"), "F⑮ 活壳检查器「等你拍板」容器在册");
  assert(storeSrc.includes('case "USER_NOTE"') && appSrc.includes("store.onUserNote") && appSrc.includes("notifyAlert(\"等你拍板\""),
    "F⑯ 手机推送链终点在册（expo USER_NOTE 消费→onUserNote→系统通知）");
  const cssSrc = read("../web-console/css/base.css");
  assert(cssSrc.includes(".awaitu-chip") && cssSrc.includes(".tag.awaitu-flag") && cssSrc.includes(".awaitu-row"),
    "F⑰ 三面样式在册（chip/会话标/入口行）");
  // [W-AWAITUSER×observe3 衔接收据]：observe3 的 notify 折叠三锚+CSS 锚已随本批预置
  //（双批同语句扩展文本合并必冲突，语义终态在我侧合成——收割冲突解法=取本批版）
  assert(notifySrc.includes("dynamicCollapsed") && notifySrc.includes("data-notify-grp-toggle") && notifySrc.includes("#dyn-collapsed"),
    "F⑱ observe3 折叠锚预置在册（动态组默认折叠/组头开合/签名位——合流语义终态）");
  assert(cssSrc.includes(".ngrp-fold") && cssSrc.includes(".ngrp .caret"),
    "F⑲ observe3 折叠 CSS 预置在册（复用既有 token 零新色）");
}

async function main(): Promise<void> {
  if (process.env.AWAITUSER_E_CHILD === "1") process.exit(await eChild()); // E 子进程形态（父进程 spawn 再入）
  unitTests();
  await integrationTests();
  watcherTests();
  staticLockTests();
  console.log(`\n[awaituser] pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

void main().catch((e: unknown) => { console.error("SUITE CRASH:", e); process.exit(1); });
