// W-TASKFLOW（2026-10-12）——board-mirror.ts 单元 + SessionManager 集成测试：
// 看板→PM 会话任务清单单向同步器（唯一事实源强制）。
// 覆盖：①投影（五态→三态映射/done 完结回收/parked 组冻结退出/未知态防御）
// ②合并幂等与 source 污染防御 ③对账 diff（missing/stale/extra/clean）
// ④claimed>48h 超窗升级 ⑤同步器单向性（**会话清单改动不回写看板**——纯函数层
// sha 比对 + manager 层 setTodos/REFRESH 磁盘链两路锁死，用户拍板红线）
// ⑥看门 v2（漂移强制回写+通知+台账；健康态零动作）⑦hidden 过滤对镜像生效。
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { createGroup, decideConfirm, setGroupStatus, setLightConfirmTrusted, upsertBoardEntry, moveBoardEntry, loadBoardFile } from "../src/projects.js";
import { boardMirrorTodos, mergeBoardMirror, mirrorDiff, escalateClaimed, isBoardMirror } from "../src/board-mirror.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RefreshTodosCommand } from "../src/types.js";

// 钉 json 读档（同 test-projects.ts 头注：缺省 sqlite 投影会让直测 json 读写面的断言语义崩）
process.env.CCR_STORAGE_READ_MODE = "json";

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

const sha = (p: string): string => {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return "MISSING"; }
};

// 假 agent 工厂（仿 test-leader：init 20ms 后 onInit；parked 不触发 onTurnEnd）
type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks };
const makeFakeFactory = (created: SpawnRec[]) =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    created.push({ prompt, cb });
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
    }, 20);
    return a;
  };

const HOUR = 3600_000;

async function main() {
  // ================= Part 1 纯函数层 =================
  console.log("P1 投影与纯函数:");
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-mirror-"));
  const boardSha0 = sha(join(ORG, "boards")); // 空目录基线（MISSING）

  // 建一个 active 组（信任累积后轻立项直达 active）
  setLightConfirmTrusted(true, ORG);
  const g1 = createGroup({ name: "研发组", anchor_dir: join(ORG, "a1"), tier: "轻立项" }, ORG);
  const gid1 = g1.ok ? g1.group.id : "";
  assert(g1.ok && g1.group.status === "active", "前置：active 组就绪");

  assert(boardMirrorTodos(ORG).length === 0, "空板 → 零镜像");
  const c1 = upsertBoardEntry(gid1, { text: "任务甲：修复登录崩溃", status: "backlog" }, ORG);
  const c2 = upsertBoardEntry(gid1, { text: "任务乙：优化启动速度", status: "claimed" }, ORG);
  const c3 = upsertBoardEntry(gid1, { text: "任务丙：待复核卡", status: "backlog" }, ORG);
  const c4 = upsertBoardEntry(gid1, { text: "任务丁：已装机验证", status: "done" }, ORG);
  assert(c1.ok && c2.ok && c3.ok && c4.ok, "前置：四态卡入库");
  // submitted 生成锁（R1）：先独立设 review_required 资格位（status 缺省分支），再 move
  const rr3 = upsertBoardEntry(gid1, { id: c3.ok ? c3.entry.id : "", text: "任务丙：待复核卡", review_required: true }, ORG);
  assert(rr3.ok, "前置：资格位独立设置");
  const m3 = moveBoardEntry(gid1, c3.ok ? c3.entry.id : "", "submitted", ORG);
  assert(m3.ok && m3.entry.status === "submitted", "前置：submitted 卡就绪");

  const mirror1 = boardMirrorTodos(ORG);
  assert(mirror1.length === 3, "done 卡不进镜像（完结回收）——只投 3 张");
  const byRef = new Map(mirror1.map((m) => [m.board_ref.entry_id, m]));
  const e1id = c1.ok ? c1.entry.id : "";
  const e2id = c2.ok ? c2.entry.id : "";
  const e3id = c3.ok ? c3.entry.id : "";
  assert(byRef.get(e1id)?.status === "pending" && !!byRef.get(e1id)?.content.startsWith("[研发组·待认领] 任务甲"), "backlog → pending + 组名·待认领徽标");
  assert(byRef.get(e2id)?.status === "in_progress" && !!byRef.get(e2id)?.content.startsWith("[研发组·进行中] 任务乙"), "claimed → in_progress + 进行中徽标");
  assert(byRef.get(e3id)?.status === "in_progress" && !!byRef.get(e3id)?.content.includes("待复核"), "submitted → in_progress + 待复核徽标");
  assert(mirror1.every((m) => isBoardMirror(m) && m.source === "board"), "镜像条目带 source=board + board_ref（端上可辨）");
  assert(mirror1.every((m) => m.id === undefined), "镜像无数字 id（#NNN 跳转面自然跳过）");

  // ready_to_install + 未知态防御
  const c5 = upsertBoardEntry(gid1, { text: "任务戊：待装机", status: "ready_to_install" }, ORG);
  assert(c5.ok, "前置：ready_to_install 卡");
  assert(boardMirrorTodos(ORG).find((m) => m.content.includes("待装机"))?.status === "in_progress", "ready_to_install → in_progress + 待装机徽标");
  const rawBoard = JSON.parse(readFileSync(join(ORG, "boards", `${gid1}.json`), "utf-8")) as { entries: { id?: string; text?: string; status: string; ts?: number; updated_at?: number }[] };
  rawBoard.entries.push({ id: "t-unknown", text: "未知态卡", status: "weird_state", ts: 1, updated_at: 1 });
  writeFileSync(join(ORG, "boards", `${gid1}.json`), JSON.stringify(rawBoard, null, 2), "utf-8");
  assert(boardMirrorTodos(ORG).every((m) => !m.content.includes("未知态卡")), "词表外未知态不投影不炸");
  rawBoard.entries.pop(); // 勿用 delete（挖洞→JSON null→loadBoardFile 容错判坏板清全板）
  writeFileSync(join(ORG, "boards", `${gid1}.json`), JSON.stringify(rawBoard, null, 2), "utf-8");

  // parked 组冻结退出
  const g2 = createGroup({ name: "挂起组", anchor_dir: join(ORG, "a2"), tier: "轻立项" }, ORG);
  const gid2 = g2.ok ? g2.group.id : "";
  upsertBoardEntry(gid2, { text: "挂起组的卡", status: "claimed" }, ORG);
  assert(boardMirrorTodos(ORG).some((m) => m.content.includes("挂起组的卡")), "前置：第二组卡在镜像");
  setGroupStatus(gid2, "parked", undefined, ORG);
  assert(!boardMirrorTodos(ORG).some((m) => m.content.includes("挂起组的卡")), "parked 组冻结 → 卡退出镜像（板冻结只读同源）");

  // 合并幂等 + 污染防御
  const disk = [{ content: "本地自建任务", status: "in_progress" as const }, { content: "污染条目", status: "pending" as const, source: "board" as const }];
  const merged1 = mergeBoardMirror(disk, ORG);
  const merged2 = mergeBoardMirror(merged1, ORG);
  assert(JSON.stringify(merged1) === JSON.stringify(merged2), "合并幂等（重复合成稳定）");
  assert(!merged1.some((t) => t.content === "污染条目"), "磁盘侧 source 污染值防御性剔除");
  assert(merged1.some((t) => t.content === "本地自建任务"), "磁盘自建任务保留");

  // 对账 diff
  const fullMirror = boardMirrorTodos(ORG);
  assert(mirrorDiff(fullMirror, ORG).clean, "镜像=投影 → clean（健康态）");
  const dropped = fullMirror.slice(1);
  const d1 = mirrorDiff(dropped, ORG);
  assert(d1.missing.length === 1 && !d1.clean, "缺一张 → missing=1");
  const mutated = fullMirror.map((m, i) => (i === 0 ? { ...m, status: "pending" as const, content: m.content + " 旧文" } : m));
  const d2 = mirrorDiff(mutated, ORG);
  assert(d2.stale.length === 1, "内容/状态过期 → stale=1");
  const extraList = [...fullMirror, ...fullMirror.slice(0, 1).map((m) => ({ ...m, board_ref: { gid: "pg-x", entry_id: "t-gone" } }))];
  const d3 = mirrorDiff(extraList, ORG);
  assert(d3.extra.length === 1, "看板无而镜像有 → extra=1（残留）");

  // 48h 升级窗口
  const now = Date.now();
  const brd = JSON.parse(readFileSync(join(ORG, "boards", `${gid1}.json`), "utf-8")) as { entries: { id: string; status: string; updated_at: number; text?: string }[] };
  const claimedEntry = brd.entries.find((e) => e.id === e2id);
  assert(!!claimedEntry, "前置：claimed 卡定位");
  if (claimedEntry) claimedEntry.updated_at = now - 49 * HOUR;
  const freshEntry = brd.entries.find((e) => e.id === e1id);
  assert(!!freshEntry, "前置：新鲜卡定位");
  if (freshEntry) freshEntry.status = "claimed"; // backlog 也搬 claimed 但 updated_at 新鲜
  writeFileSync(join(ORG, "boards", `${gid1}.json`), JSON.stringify(brd, null, 2), "utf-8");
  const esc = escalateClaimed(now, ORG);
  assert(esc.length === 1 && esc[0].entry_id === e2id && esc[0].group_name === "研发组", "claimed>48h 超窗 → 升级候选 1 张（新鲜卡不计）");
  process.env.CCR_BOARD_ESCALATE_MS = String(24 * HOUR);
  assert(escalateClaimed(now, ORG).length === 1, "env 窗口收紧到 24h（测试缝生效，49h 仍超）");
  delete process.env.CCR_BOARD_ESCALATE_MS;

  // 单向性（纯函数层）：全函数调用后板文件字节不变
  const bShaBefore = sha(join(ORG, "boards", `${gid1}.json`));
  const pShaBefore = sha(join(ORG, "projects.json"));
  mergeBoardMirror([], ORG);
  mirrorDiff([], ORG);
  escalateClaimed(Date.now(), ORG);
  boardMirrorTodos(ORG);
  assert(sha(join(ORG, "boards", `${gid1}.json`)) === bShaBefore && sha(join(ORG, "projects.json")) === pShaBefore && boardSha0 === "MISSING", "单向性（纯函数层）：投影/合并/对账/升级全只读——板与索引字节不变");

  // ================= Part 2 manager 集成层 =================
  console.log("P2 manager 集成（fake factory）:");
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-mirror-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  try {
    const cfg: RelayConfig = {
      port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const spawned: SpawnRec[] = [];
    const mgr = new SessionManager(new EventBus({ persistPath: join(DATA, "events.ndjson") }), cfg);
    mgr.setAgentFactory(makeFakeFactory(spawned));

    const r = mgr.ensureLeader();
    assert(r.ok === true, "前置：Leader 首建成功");
    const leaderId = r.ok ? r.session_id : "";
    assert(await waitFor(() => !!(mgr as unknown as { sessions: Map<string, { state: { relay_session_id?: string } }> }).sessions.get(leaderId)?.state.relay_session_id), "前置：fake init 到达（relay_session_id 回填）");

    type Hack = {
      sessions: Map<string, { state: { relay_session_id?: string; employee_home?: string; todos?: { content: string; status: string; source?: string }[]; historical: boolean } }>;
      notifications: Map<string, { key: string; title: string }>;
      leaderId: string | null;
    };
    const hack = mgr as unknown as Hack;

    // ① Leader setTodos 自动合并
    mgr.setTodos(leaderId, [{ content: "PM 本地任务", status: "in_progress" }]);
    const todos1 = hack.sessions.get(leaderId)?.state.todos ?? [];
    assert(todos1.some((t) => t.content === "PM 本地任务"), "Leader 磁盘自建任务入清单");
    assert(todos1.some((t) => t.source === "board"), "Leader 清单自动合成看板镜像（setTodos 咽喉）");
    assert(todos1.filter((t) => t.source === "board").length === boardMirrorTodos(ORG).length, "镜像张数=看板投影张数");

    // ② 非 Leader 会话不合并
    const otherTodos = [{ content: "普通会话任务", status: "pending" as const }];
    // 直接构造一个普通托管会话：借 create（走公开命令面）
    const createAck = mgr.handleCommand({ command_id: "c-1", type: "COMMAND_CREATE", payload: { cwd: join(ORG), prompt: "普通会话（测试）", model: cfg.model } } as never, "test");
    assert(createAck.ok, "前置：COMMAND_CREATE ok");
    await waitFor(() => {
      for (const [, s] of hack.sessions) { if (!s.state.historical && s.state.relay_session_id) return true; }
      return false;
    });
    let otherId = "";
    for (const [id, s] of hack.sessions) { if (id !== leaderId && !s.state.historical) otherId = id; }
    if (otherId) {
      mgr.setTodos(otherId, otherTodos);
      const ot = hack.sessions.get(otherId)?.state.todos ?? [];
      assert(ot.length === 1 && ot.every((t) => t.source !== "board"), "非 Leader 会话零镜像（合并只进 PM 清单）");
    } else {
      assert(false, "前置：普通会话建立失败");
    }

    // ③ 板变更即推：新卡 → emitBoard → 镜像更新
    const cNew = upsertBoardEntry(gid1, { text: "新派单卡", status: "claimed" }, ORG);
    mgr.emitBoard(gid1);
    const todos2 = hack.sessions.get(leaderId)?.state.todos ?? [];
    assert(cNew.ok && todos2.some((t) => t.content.includes("新派单卡")), "板新卡 → emitBoard → 镜像同拍出现（不等 30s 轮询）");
    assert(todos2.some((t) => t.content === "PM 本地任务"), "镜像更新不洗掉磁盘自建任务");

    // ④ 完结回收：卡 done → 镜像消失
    moveBoardEntry(gid1, cNew.ok ? cNew.entry.id : "", "done", ORG);
    mgr.emitBoard(gid1);
    const todos3 = hack.sessions.get(leaderId)?.state.todos ?? [];
    assert(!todos3.some((t) => t.content.includes("新派单卡")), "卡 done → 镜像回收（终态不驻留）");

    // ⑤ 单向性（集成层 A·setTodos 路径）：模拟 CLI 流改清单——看板字节不变
    //（基线在 ④ 之后取：④ 的搬卡合法刷板，不能混进单向性比对）
    const boardShaA = sha(join(ORG, "boards", `${gid1}.json`));
    mgr.setTodos(leaderId, [{ content: "PM 改了任务", status: "pending" }]);
    assert(sha(join(ORG, "boards", `${gid1}.json`)) === boardShaA, "单向性 A：会话清单改动（setTodos 路径）不回写看板（sha 不变）");
    // 恢复现场：本地任务改回
    mgr.setTodos(leaderId, [{ content: "PM 本地任务", status: "in_progress" }]);

    // ⑥ 单向性（集成层 B·磁盘链）：模拟 CLI 任务系统写文件 + REFRESH 重读
    //（employee_home 语义 = CLAUDE_CONFIG_DIR 等价物：任务存储在 <home>/tasks/<sid>/）
    const empHome = mkdtempSync(join(tmpdir(), "ccr-emp-home-"));
    const cliSid = hack.sessions.get(leaderId)?.state.relay_session_id ?? "";
    const taskDir = join(empHome, "tasks", cliSid);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "1.json"), JSON.stringify({ id: 1, subject: "CLI 写的磁盘任务", status: "in_progress" }), "utf-8");
    hack.sessions.get(leaderId)!.state.employee_home = empHome; // 测试缝：雇员家指向沙盒（缺省 homedir 会碰真 ~/.claude）
    const refAck = mgr.handleCommand({ command_id: "c-2", type: "COMMAND_REFRESH_TODOS", payload: { session_id: leaderId } } as RefreshTodosCommand, "test");
    assert(refAck.ok, "前置：REFRESH 命令 ok");
    const todos4 = hack.sessions.get(leaderId)?.state.todos ?? [];
    assert(todos4.some((t) => t.content === "CLI 写的磁盘任务"), "磁盘任务经 REFRESH 入清单（#206 权威轮询路径）");
    assert(todos4.some((t) => t.source === "board"), "磁盘重读后镜像仍在（setTodos 咽喉统一合成）");
    assert(sha(join(ORG, "boards", `${gid1}.json`)) === boardShaA, "单向性 B：CLI 写任务文件+重读（pollTaskStore 链）不回写看板（sha 不变）");

    // ⑦ 看门 v2：人为漂移（剥镜像）→ reconcile 强制回写 + 报警
    const notifBefore = hack.notifications.size;
    const ledgerBefore = readDispatchLog(ORG).filter((e) => e.target === "board-mirror").length;
    const ls = hack.sessions.get(leaderId)!.state;
    ls.todos = (ls.todos ?? []).filter((t) => t.source !== "board"); // 模拟外部洗掉镜像
    mgr.reconcileBoardMirror();
    const todos5 = hack.sessions.get(leaderId)?.state.todos ?? [];
    assert(todos5.some((t) => t.source === "board") && todos5.filter((t) => t.source === "board").length === boardMirrorTodos(ORG).length, "看门 v2：漂移 → 强制以看板为准回写（镜像恢复）");
    assert(hack.notifications.size > notifBefore, "看门 v2：漂移 → 通知落账（报警面）");
    const ledgerAfter = readDispatchLog(ORG).filter((e) => e.target === "board-mirror").length;
    assert(ledgerAfter === ledgerBefore + 1, "看门 v2：台账行 +1（tier=看门狗审计）");

    // ⑧ 看门健康态：无漂移 → 零新增
    const notifSteady = hack.notifications.size;
    const ledgerSteady = readDispatchLog(ORG).filter((e) => e.target === "board-mirror").length;
    mgr.reconcileBoardMirror();
    assert(hack.notifications.size === notifSteady && readDispatchLog(ORG).filter((e) => e.target === "board-mirror").length === ledgerSteady, "看门 v2：健康态零动作（无重复报警）");

    // ⑨ 48h 升级通知（P1 已造 49h claimed 卡；⑦ 的首次 reconcile 已顺带落账——验在账+幂等）
    const escKeys = [...hack.notifications.keys()].filter((k) => k.startsWith("system:board-escalate"));
    assert(escKeys.length >= 1, "claimed>48h 超窗 → 升级通知落账（一卡一账）");
    mgr.reconcileBoardMirror();
    mgr.reconcileBoardMirror();
    const escAgain = [...hack.notifications.keys()].filter((k) => k.startsWith("system:board-escalate")).length;
    assert(escAgain === escKeys.length, "升级通知幂等（stableKey 防重不轰炸）");

    // ⑩ hidden 过滤对镜像生效
    const mirrorSample = (hack.sessions.get(leaderId)?.state.todos ?? []).find((t) => t.source === "board");
    if (mirrorSample) {
      mgr.handleCommand({ command_id: "c-3", type: "COMMAND_TODO_HIDE", payload: { session_id: leaderId, content: mirrorSample.content } } as never, "test");
      mgr.setTodos(leaderId, [{ content: "PM 本地任务", status: "in_progress" }]);
      const afterHide = hack.sessions.get(leaderId)?.state.todos ?? [];
      assert(!afterHide.some((t) => t.content === mirrorSample.content), "镜像条目可 ✕ 隐藏且重合成不复活（用户侧噪音控制）");
    } else {
      assert(false, "前置：取镜像样本失败");
    }

    // ⑪ SNAPSHOT 携带镜像（端上面板任务 tab 数据源）
    const snapLeader = mgr.snapshot().find((s) => s.session_id === leaderId);
    assert(!!snapLeader?.todos && snapLeader.todos.some((t) => t.source === "board"), "SNAPSHOT 携带镜像条目（面板任务 tab 双跑数据源就绪）");

    // ⑫ task_ref 全链路匹配键（2026-10-12 用户拍板补充）：派单 prompt 头注入 →
    // 板卡同 id → 收口回执头携带，四处同键（prompt/板/台账/通知）
    {
      const anchorDir = mkdtempSync(join(tmpdir(), "ccr-anchor-"));
      const gW = createGroup({ name: "taskref组", anchor_dir: anchorDir, tier: "轻立项" }, ORG);
      const gidW = gW.ok ? gW.group.id : "";
      assert(gW.ok && gW.group.status === "active", "前置：taskref 组 active");
      const spawnBefore = spawned.length;
      const dw = mgr.dispatchWorker({ anchor: anchorDir, prompt: "task_ref 测试任务书正文", gid: gidW, title: "task_ref 验证单" });
      assert(dw.ok, "前置：dispatchWorker ok");
      const wSid = dw.ok ? dw.session_id : "";
      await waitFor(() => !!(hack.sessions.get(wSid)?.state.relay_session_id));
      const wPrompt = spawned[spawnBefore]?.prompt ?? "";
      const refMatch = /^\[task_ref:(t-[0-9a-f]{8})\] \[gid:(pg-[0-9a-f]{8})\] task_ref 验证单/.exec(wPrompt);
      assert(!!refMatch, "task_ref ①：派单 prompt 头部注入 [task_ref:卡id] [gid:组id] 标题");
      assert(refMatch?.[2] === gidW, "task_ref ①：gid 段与实际组 id 一致");
      const wCard = loadBoardFile(gidW, ORG)?.entries.find((e) => e.dispatch_id === (dw.ok ? dw.dispatch_id : ""));
      assert(!!wCard && (!refMatch || wCard.id === refMatch[1]), "task_ref ②：板卡 id = prompt 头 task_ref（预生成同键落板）");
      // 收口：worker 回合终态 → closeOpenDispatches done → 台账 receipt 头带 task_ref
      const wAgentRec = spawned.find((r) => r.prompt === wPrompt);
      wAgentRec?.cb.onTurnEnd(true, "success", 42);
      const closedRow = readDispatchLog(ORG).find((x) => x.id === (dw.ok ? dw.dispatch_id : "") && (x.status === "done" || x.status === "failed"));
      assert(!!closedRow && (!refMatch || (closedRow.receipt ?? "").startsWith(`[task_ref:${refMatch[1]}]`)), "task_ref ③：收口回执头部携带 [task_ref:卡id]（台账行）");
      assert(loadBoardFile(gidW, ORG)?.entries.find((e) => e.id === wCard?.id)?.status === "done", "task_ref ④：收口联动搬卡 done（ref 链路闭环）");
      rmSync(anchorDir, { recursive: true, force: true });
    }

    rmSync(DATA, { recursive: true, force: true });
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
  }

  rmSync(ORG, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
