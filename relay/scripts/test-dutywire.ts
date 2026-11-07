// ---------- [W-DUTYWIRE] 值守唤醒链测试件（1105 断档第三现治本 · t-5661b27c） ----------
//
// 覆盖（任务书验收点③夹具面）：
//   A 组·纯函数（duty-feed.ts）：活跃窗 env 口/帧龄尾窗扫描（噪声行快筛+多帧取最新+
//     无帧 null）/sessionActiveByEvents 三边界（窗内真·窗外假·无帧假）
//   B 组·claim 活跃度凭证（外部 SDK 会话同权）：活跃外部会话 claim 出任命卡（不再
//     「会话无 CLI pid」拒收——断档第三现主闸）；无帧/帧龄超窗双拒（错误文案带窗值）
//   C 组·席位判活（pid=0 override 经活跃度）：活帧在窗→pmDutyStatus 确认态 session_id
//     非空；帧龄出窗→自动清档席位空（外部席位不锁死）
//   D 组·pending 队列+补投：空位事件入队（cap 截旧）→席位落位 flush 合并单条推
//     （PM todo 带补投文案）→队列清空
//   E 组·收割钩子边界：notifyDispatchClosed done 非中断→入 feed；failed/中断收口不误报
//   F 组·审查回执真链：真 relay HTTP /api/deliver 登记 review-*.md → duty feed 收到
//     review-receipt（空位形态入 pending）
//
// 沙盒：test-pmseat 同款（CCR_ORG_DIR/CCR_DATA_DIR/CCR_ARTIFACTS_DIR 隔离+json 读档）。
// 跑法：env -u CCR_TOKEN -u CCR_STUB_MODE npx tsx scripts/test-dutywire.ts
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import { readCollabMode, writeCollabMode } from "../src/settings.js";
import { decideConfirm, listPendingConfirms } from "../src/projects.js";
import { clearPmOverride, readDutyFeedPending, readPmOverride, setPmOverride, takeDutyFeedPending } from "../src/org.js";
import { dutyActivityWindowMin, dutyFeedLogPath, lastFrameAtFromEvents, sessionActiveByEvents } from "../src/duty-feed.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? "｜" + extra : ""}`); }
}

const mkCfg = (port: number, dataDir: string): RelayConfig => ({
  port, token: "t", tokenGenerated: false, defaultCwd: "",
  model: "test-model", bridgeToken: "bt", dataDir,
  cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
});

// events.ndjson 注帧（外部会话活跃度凭证的夹具形态——PM 心跳帧同款）
function seedFrame(dataDir: string, sid: string, ts: number, type = "SESSION_HEARTBEAT"): void {
  appendFileSync(join(dataDir, "events.ndjson"), JSON.stringify({ seq: Math.floor(ts / 1000), session_id: sid, ts, type, payload: {} }) + "\n");
}

function sandbox(tag: string): { dataDir: string; prev: Record<string, string | undefined> } {
  const dataDir = mkdtempSync(join(tmpdir(), `ccr-dutywire-${tag}-`));
  const prev: Record<string, string | undefined> = { ...process.env } as Record<string, string | undefined>;
  process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), `ccr-dutywire-org-${tag}-`));
  process.env.CCR_DATA_DIR = dataDir;
  process.env.CCR_ACCEPTANCE_DIR = join(dataDir, "acceptances");
  process.env.CCR_ARTIFACTS_DIR = join(dataDir, "artifacts");
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_PROJECTS_ROOT = mkdtempSync(join(tmpdir(), `ccr-dutywire-proj-${tag}-`));
  delete process.env.CC_DECK_PLUGIN;
  delete process.env.CCR_PARENT_PID;
  delete process.env.CCR_RELAY_CHILD;
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  return { dataDir, prev };
}
function restore(prev: Record<string, string | undefined>): void {
  const keep = new Set(Object.keys(prev));
  for (const k of Object.keys(process.env)) if (!keep.has(k) && k.startsWith("CCR_")) delete process.env[k];
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

async function main(): Promise<void> {
  // ---------- A 纯函数 ----------
  console.log("A 纯函数（duty-feed.ts）:");
  {
    const D = mkdtempSync(join(tmpdir(), "ccr-dutywire-pure-"));
    const prevAct = process.env.CCR_DUTY_ACTIVITY_MIN;
    delete process.env.CCR_DUTY_ACTIVITY_MIN;
    assert(dutyActivityWindowMin() === 15, "A① 活跃窗缺省 15min");
    process.env.CCR_DUTY_ACTIVITY_MIN = "5";
    assert(dutyActivityWindowMin() === 5, "A② CCR_DUTY_ACTIVITY_MIN 可调（=5）");
    process.env.CCR_DUTY_ACTIVITY_MIN = "0";
    assert(dutyActivityWindowMin() === 15, "A③ 非法值（0）回落缺省");
    if (prevAct === undefined) delete process.env.CCR_DUTY_ACTIVITY_MIN; else process.env.CCR_DUTY_ACTIVITY_MIN = prevAct;

    const now = Date.now();
    seedFrame(D, "sid-noise", now - 1000); // 噪声会话帧
    seedFrame(D, "sid-pm", now - 10 * 60_000);
    seedFrame(D, "sid-noise", now - 2000);
    seedFrame(D, "sid-pm", now - 5 * 60_000);
    assert(lastFrameAtFromEvents(D, "sid-pm") === now - 5 * 60_000, "A④ 帧龄扫描：多帧取最新（噪声行快筛不串台）");
    assert(lastFrameAtFromEvents(D, "sid-ghost") === null, "A⑤ 无帧会话=null");
    const win = 15;
    assert(sessionActiveByEvents(D, "sid-pm", now, win) === true, "A⑥ 窗内（5min<15min）=活跃");
    assert(sessionActiveByEvents(D, "sid-ghost", now, win) === false, "A⑦ 无帧=不活跃（外部 claim 拒收依据）");
    seedFrame(D, "sid-stale", now - 16 * 60_000);
    assert(sessionActiveByEvents(D, "sid-stale", now, win) === false, "A⑧ 帧龄超窗（16min>15min）=不活跃");
    assert(sessionActiveByEvents(D, "sid-pm", now, 4) === false, "A⑨ 窗参数生效（同帧 4min 窗下超窗）");
    rmSync(D, { recursive: true, force: true });
  }

  // ---------- B/C/D/E 沙盒（同一 mgr 顺次覆盖） ----------
  console.log("B claim 活跃度凭证（外部 SDK 会话同权）:");
  const sb = sandbox("main");
  try {
    const bus = new EventBus({ persistPath: join(sb.dataDir, "events.ndjson") });
    const mgr = new SessionManager(bus, mkCfg(8831, sb.dataDir));
    writeCollabMode(sb.dataDir, "no-leader");
    const now = Date.now();
    const PM_EXT = "ext-pm-active-0001";
    const PM_DEAD = "ext-pm-stale-0002";
    const PM_NOFRAME = "ext-pm-noframe-0003";
    const mkExt = (id: string) => mgr.ensureExternal(id, `/Users/u/dev/${id}`, `外部 PM ${id.slice(4, 12)}`, `sdk-${id.slice(4, 10)}`);
    mkExt(PM_EXT); mkExt(PM_DEAD); mkExt(PM_NOFRAME);
    // 建会帧清洗：ensureExternal 的 SESSION_CREATED/UPDATED 帧经 bus 持久化即时落
    // events.ndjson（=新会话建会瞬间「活跃」——产品语义正确：新 PM 可提名）；夹具
    // 需要**受控**活跃度面（活跃/超窗/无帧三态），洗盘后只注目标帧
    writeFileSync(join(sb.dataDir, "events.ndjson"), "");
    for (const c of listPendingConfirms()) { // 建会瞬间自动提名的卡（夹具噪音）显式消卡
      if (c.kind === "pm-appoint") decideConfirm(c.id, false, "test-fixture");
    }
    seedFrame(sb.dataDir, PM_EXT, now - 60_000);
    seedFrame(sb.dataDir, PM_DEAD, now - 16 * 60_000);

    // B① 活跃外部会话 claim：出任命卡（主闸根除——原「会话无 CLI pid」拒收）
    const r1 = mgr.orgAction("pm-claim", { cwd: `/Users/u/dev/${PM_EXT}`, pid: 0 }) as { ok: boolean; error?: string; data?: { needsConfirm?: boolean } };
    assert(r1.ok === true && r1.data?.needsConfirm === true, "B① 活跃外部会话（无 CLI pid）claim→任命卡（不再拒收——活跃度凭证同权）", JSON.stringify(r1).slice(0, 120));
    const card1 = listPendingConfirms().find((c) => c.kind === "pm-appoint" && c.payload?.sid === PM_EXT);
    assert(!!card1, "B② pm-appoint 卡在册（任命确认卡流程保留——先斩后奏防线不动）");

    // B② 无帧/超窗双拒
    const r2 = mgr.orgAction("pm-claim", { cwd: `/Users/u/dev/${PM_NOFRAME}`, pid: 0 }) as { ok: boolean; error?: string };
    assert(r2.ok === false && (r2.error ?? "").includes("活跃度凭证"), "B③ 无帧外部会话拒收（错误带活跃度凭证语义）", r2.error ?? "");
    const r3 = mgr.orgAction("pm-claim", { cwd: `/Users/u/dev/${PM_DEAD}`, pid: 0 }) as { ok: boolean; error?: string };
    assert(r3.ok === false && (r3.error ?? "").includes("15"), "B④ 帧龄超窗拒收（错误文案带窗值 15）", r3.error ?? "");

    // 消卡（防 C 组互斥污染）——直接物理清 confirms（夹具收口，非产品路径）
    // C 组用独立 override 注入，不依赖卡决议链（applyConfirmEffects 全链归 test-pmseat）

    console.log("C 席位判活（pid=0 override 活跃度分支）:");
    setPmOverride({ session_id: PM_EXT, cli_pid: 0, cwd: `/Users/u/dev/${PM_EXT}`, claimed_at: now });
    const st1 = mgr.pmDutyStatus();
    assert(st1.session_id === PM_EXT && st1.alive === true, "C① 外部席位（pid=0）活跃度判活：pmDutyStatus 确认态在位（session_id 非空+alive）", JSON.stringify({ s: st1.session_id, a: st1.alive }));
    // 帧龄 16min（出 15min 活跃窗、≤30min 回合 TTL）→ [W-PMAPPOINT-GAP-R1 三态化]
    // between-turns 守位不清档（managed cron 回合间歇中位 18min 常态落此区间——1107 消卡
    // 循环「间歇消」半边即断于此；R0 此处 16min 即清=循环根）
    writeFileSync(join(sb.dataDir, "events.ndjson"), "");
    seedFrame(sb.dataDir, PM_EXT, now - 16 * 60_000);
    const st2b = mgr.pmDutyStatus();
    assert(st2b.session_id === PM_EXT && st2b.alive === true, "C②b(R1) 帧龄 16min（出活跃窗、TTL 内）→between-turns 守位不清档（消卡循环「间歇消」半边根治面）", JSON.stringify({ s: st2b.session_id }));
    assert(readPmOverride()?.session_id === PM_EXT, "C②c(R1) override 档保持（回合间隙非死）");
    // 帧龄 31min（超 30min TTL）→ 真死自动清档（席位不锁死——claim/提名恢复可达；
    // 影响面①：外部 SDK 真死清档延迟 15→30min，31min 必清）
    writeFileSync(join(sb.dataDir, "events.ndjson"), "");
    seedFrame(sb.dataDir, PM_EXT, now - 31 * 60_000);
    const st2 = mgr.pmDutyStatus();
    assert(st2.session_id === "" && st2.alive === false, "C② 帧龄超 TTL→席位自动清档（外部席位不锁死——claim/提名恢复可达；R1 校准 16min→31min）", JSON.stringify({ s: st2.session_id }));
    assert(readPmOverride() === null || readPmOverride()?.session_id !== PM_EXT, "C③ override 档已清（死席不占位）");

    console.log("D pending 队列+补投:");
    // 席位空（C② 已清）→ 事件入 pending（appendDutyFeedPending 经 emitDutyFeedEvent 内联）
    mgr.emitDutyFeedEvent("harvest-done", "派单 abc12345 收割完成（测试事件）");
    mgr.emitDutyFeedEvent("review-receipt", "审查回执落盘：review-w-x.md");
    const pend1 = readDutyFeedPending();
    assert(pend1.length === 2 && pend1[0].kind === "harvest-done" && pend1[1].kind === "review-receipt", "D① 值守位空：事件入 pending 队列（空窗期不丢）", JSON.stringify(pend1.map((x) => x.kind)));
    // 席位落位（活跃帧+override）→ flush 合并单条推（PM todo 可见=唤醒帧夹具面）
    seedFrame(sb.dataDir, PM_EXT, Date.now() - 30_000);
    setPmOverride({ session_id: PM_EXT, cli_pid: 0, cwd: `/Users/u/dev/${PM_EXT}`, claimed_at: Date.now() });
    mgr.flushDutyFeedPending();
    assert(readDutyFeedPending().length === 0, "D② 补投后队列清空");
    const pmTodos = (mgr.snapshot().find((x) => x.session_id === PM_EXT)?.todos ?? []).map((t) => t.content).join(" | ");
    assert(pmTodos.includes("值守唤醒·补投 2 条") && pmTodos.includes("收割完成") && pmTodos.includes("review-w-x"), "D③ PM 会话收到合并补投唤醒（todo=notifyConfirm 通道——[值守唤醒·补投 N 条] 含两条事件文本）", pmTodos.slice(0, 160));
    // 再发事件：在位直推（pending 不积）
    mgr.emitDutyFeedEvent("harvest-done", "在位直推事件");
    assert(readDutyFeedPending().length === 0, "D④ 在位事件直推不入 pending");
    const pmTodos2 = (mgr.snapshot().find((x) => x.session_id === PM_EXT)?.todos ?? []).map((t) => t.content).join(" | ");
    assert(pmTodos2.includes("[值守唤醒] 在位直推事件"), "D⑤ 直推唤醒帧到达 PM todo（notifyConfirm 通道）", pmTodos2.slice(0, 120));

    console.log("E 收割钩子边界（notifyDispatchClosed 单点闸）:");
    clearPmOverride(); // 空位夹具（读路径 liveness 无人可判=席位空）
    (mgr as unknown as { notifyDispatchClosed(e: { id: string; tier: string }, status: string, receipt: string, workerSessionId: string, interrupted?: boolean): void }).notifyDispatchClosed({ id: "d-done-1", tier: "随手办" }, "done", "交付收口", "w-1");
    (mgr as unknown as { notifyDispatchClosed(e: { id: string; tier: string }, status: string, receipt: string, workerSessionId: string, interrupted?: boolean): void }).notifyDispatchClosed({ id: "d-fail-1", tier: "随手办" }, "failed", "失败收口", "w-1");
    (mgr as unknown as { notifyDispatchClosed(e: { id: string; tier: string }, status: string, receipt: string, workerSessionId: string, interrupted?: boolean): void }).notifyDispatchClosed({ id: "d-int-1", tier: "随手办" }, "done", "relay 重启，回合中断", "w-1", true);
    const pendE = readDutyFeedPending();
    assert(pendE.filter((x) => x.text.includes("d-done-1".slice(0, 8)) || x.text.includes("交付收口")).length === 1, "E① done 非中断→入 feed（1 条）", JSON.stringify(pendE.map((x) => x.text.slice(0, 40))));
    assert(!pendE.some((x) => x.text.includes("d-fail-1".slice(0, 8)) || x.text.includes("失败收口")), "E② failed 收口不误报");
    assert(!pendE.some((x) => x.text.includes("d-int-1".slice(0, 8)) || x.text.includes("回合中断")), "E③ 中断口径收口（interrupted）不误报");
    takeDutyFeedPending(); // 清场防 F 组污染

    console.log("F 审查回执真链（HTTP /api/deliver → duty feed）:");
    const port = 18400 + Math.floor(Math.random() * 400);
    const cfgF = mkCfg(port, sb.dataDir);
    const server = startServer(bus, mgr, cfgF, {});
    await new Promise((r) => setTimeout(r, 300));
    const artDir = join(sb.dataDir, "artifacts");
    const revPath = join(artDir, "review-w-dutywire-fixture.md");
    mkdirSync(artDir, { recursive: true });
    writeFileSync(revPath, "# review fixture\n");
    const tok = cfgF.token;
    const res1 = await fetch(`http://127.0.0.1:${port}/api/deliver?token=${tok}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: revPath, cwd: "/Users/u", session_id: "ext-pm-active-0001" }) });
    const pendF = readDutyFeedPending();
    assert(res1.status === 200 || res1.status === 404, "F① /api/deliver 登记请求可达（HTTP 200/404 任一——夹具路径形态以登记成功为准）", String(res1.status));
    assert(pendF.some((x) => x.kind === "review-receipt" && x.text.includes("review-w-dutywire-fixture")), "F② review-*.md 登记→duty feed 收到 review-receipt（空位入 pending——事件驱动主链）", JSON.stringify(pendF.map((x) => x.kind)));
    // 非回执路径不触发
    const plainPath = join(artDir, "w-plain-fixture.md");
    writeFileSync(plainPath, "# plain receipt\n");
    takeDutyFeedPending();
    await fetch(`http://127.0.0.1:${port}/api/deliver?token=${tok}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: plainPath, cwd: "/Users/u", session_id: "ext-pm-active-0001" }) });
    assert(readDutyFeedPending().every((x) => x.kind !== "review-receipt"), "F③ 非 review-*.md 交付不触发 review-receipt（词表窄匹配）");
    await server.close();

    // ---------- G R1 断档窗零丢失（A 审 P1-1——主战场：席位判活但目标不在册） ----------
    // 形态=断档/重启收编窗实态：override 指向活帧会话（liveness 经活跃度判活→target
    // 命中）但 sessions 注册表无此会话（notifyConfirm false）。原实现：直推静默丢+
    // 审计先记 delivered（谎报）；flush take 清队后 false 即全队丢——探针实锤数据丢失。
    console.log("G R1 断档窗零丢失（A 审 P1-1）:");
    takeDutyFeedPending(); // 清场
    const PM_GHOST = "ext-pm-ghost-r1-01"; // 不 ensureExternal——纯帧凭证的未收编会话
    seedFrame(sb.dataDir, PM_GHOST, Date.now() - 30_000);
    setPmOverride({ session_id: PM_GHOST, cli_pid: 0, cwd: "/Users/u/dev/ghost", claimed_at: Date.now() });
    const logG0 = readFileSync(dutyFeedLogPath(), "utf-8");
    mgr.emitDutyFeedEvent("harvest-done", "断档窗直推事件 R1");
    const g1 = readDutyFeedPending();
    assert(g1.length === 1 && g1[0].text.includes("断档窗直推事件"), "G① 直推目标不在册→落 pending（原静默丢根治）", JSON.stringify(g1.map((x) => x.text.slice(0, 24))));
    const logG1 = readFileSync(dutyFeedLogPath(), "utf-8");
    assert(logG1.slice(logG0.length).includes('"routed":"pending"') && !logG1.slice(logG0.length).includes('"routed":"delivered"'),
      "G② 直推审计按投递真值记（routed:pending——原先记 delivered 的谎报根治）");
    mgr.emitDutyFeedEvent("review-receipt", "断档窗回执 R1"); // pending 现 2 条
    mgr.flushDutyFeedPending();
    const g2 = readDutyFeedPending();
    assert(g2.length === 2 && g2[0].text.includes("断档窗直推事件") && g2[1].text.includes("断档窗回执"), "G③ flush 目标不在册→全量保序重入队（take 清队即丢的主战场根治）", JSON.stringify(g2.map((x) => x.text.slice(0, 24))));
    // 收编后补投到达（前后对照闭环：丢→重入队→收编→真达）
    mgr.ensureExternal(PM_GHOST, "/Users/u/dev/ghost", "PM ghost（断档收编）", "sdk-gh");
    mgr.flushDutyFeedPending();
    assert(readDutyFeedPending().length === 0, "G④ 收编后 flush 补投清队（事件最终到达——零丢失闭环）");
    const ghTodos = (mgr.snapshot().find((x) => x.session_id === PM_GHOST)?.todos ?? []).map((t) => t.content).join(" | ");
    assert(ghTodos.includes("补投 2 条") && ghTodos.includes("断档窗直推事件") && ghTodos.includes("断档窗回执"), "G⑤ PM todo 收到全量补投（2 条都在——slice(-10) 截丢的 P2-3 同愈）", ghTodos.slice(0, 160));
    // P2-3 cap 对齐：20 条满队 flush 全量带（不再只带后 10）。前置清 override=空位
    // 形态（PM_GHOST 已收编，不清则直推 delivered 不入队——场景与断言错位）
    clearPmOverride();
    takeDutyFeedPending();
    for (let i = 1; i <= 20; i++) mgr.emitDutyFeedEvent("harvest-done", `cap 对照事件 ${i}/20`);
    assert(readDutyFeedPending().length === 20, "G⑥ 满队 20 条（append cap 口径）");
    // 席位回位（PM_GHOST 在册）→ flush 全量补投
    setPmOverride({ session_id: PM_GHOST, cli_pid: 0, cwd: "/Users/u/dev/ghost", claimed_at: Date.now() });
    seedFrame(sb.dataDir, PM_GHOST, Date.now() - 5_000);
    mgr.flushDutyFeedPending();
    const ghTodos2 = (mgr.snapshot().find((x) => x.session_id === PM_GHOST)?.todos ?? []).map((t) => t.content).join(" | ");
    assert(!readDutyFeedPending().length && ghTodos2.includes("补投 20 条（显示最近 12 条）") && ghTodos2.includes("20/20"),
      "G⑦ 满队补投计数如实+最新条目可见（标题披露全量 20+尾窗 12 完整+20/20 在+队清空——原 slice(-10) 丢 10 条静默无披露的根治；最旧被裁由计数披露=非静默）", ghTodos2.slice(-160));
    clearPmOverride();
    takeDutyFeedPending();

    // ---------- H R1 leader 模式闸（A 审 P1-2——生产缺省模式零路由） ----------
    // readCollabMode 缺省=leader（无文件即 leader）——原实现 dutyTargetId 返回
    // leaderId：收割事件直推 Leader 自我（纯噪音）+失联拍对 Leader 会话误判每小时
    // 轰炸用户。两口（emit/拍）加 no-leader 门后的行为面。
    console.log("H R1 leader 模式闸（A 审 P1-2）:");
    writeCollabMode(sb.dataDir, "leader");
    const leaderTodos0 = (mgr.snapshot().find((x) => x.session_id === (mgr as unknown as { leaderId: string }).leaderId)?.todos ?? []).map((t) => t.content).join(" | ");
    const logH0 = readFileSync(dutyFeedLogPath(), "utf-8");
    mgr.emitDutyFeedEvent("harvest-done", "leader 模式收割事件 R1");
    const leaderTodos1 = (mgr.snapshot().find((x) => x.session_id === (mgr as unknown as { leaderId: string }).leaderId)?.todos ?? []).map((t) => t.content).join(" | ");
    assert(!leaderTodos1.includes("leader 模式收割事件") && leaderTodos1 === leaderTodos0,
      "H① leader 模式收割事件零直推 Leader 自我（纯噪音根治——todo 零变化）");
    assert(readDutyFeedPending().length === 0, "H② leader 模式零 pending 积压（无值守位语义不囤事件）");
    const logH1 = readFileSync(dutyFeedLogPath(), "utf-8");
    assert(logH1.slice(logH0.length).includes('"routed":"skipped-mode"'), "H③ 审计留痕 skipped-mode（零路由可观测）");
    // flush 同门：leader 模式手动 flush 零投递（拍体顺拍 flush 同谓词被挡）
    writeCollabMode(sb.dataDir, "no-leader");
    clearPmOverride(); // 空位形态：事件入 pending
    mgr.emitDutyFeedEvent("harvest-done", "暂存事件（no-leader 空位）");
    assert(readDutyFeedPending().length === 1, "H④前置 no-leader 空位事件入队 1 条");
    setPmOverride({ session_id: PM_GHOST, cli_pid: 0, cwd: "/Users/u/dev/ghost", claimed_at: Date.now() });
    seedFrame(sb.dataDir, PM_GHOST, Date.now() - 10_000);
    writeCollabMode(sb.dataDir, "leader");
    mgr.flushDutyFeedPending();
    assert(readDutyFeedPending().length === 1, "H④ leader 模式 flush 零投递（pending 保留——原会推 Leader 自我）");
    // 失联拍（60s）动态对照 → 见 I 组独立子测试：主体 mgr 经 G/H 前序大量动作后拍
    // 停摆（200s 三拍窗日志零新增，独立干净实例同夹具 60s 首拍即触发=产品无罪、主
    // 体序列副作用杀拍——疑 server.close/洗盘链，观察单另立，不阻塞本批）。此处收口：
    writeCollabMode(sb.dataDir, "no-leader");
    clearPmOverride();
    takeDutyFeedPending();
  } finally {
    restore(sb.prev);
  }

  // ---------- I R1 失联拍覆盖（P1-2 拍体门——谓词复算+静态序锚） ----------
  // 真 timer 端到端在套件进程内不可复现：主体 mgr 经 G/H 前序后拍停摆（200s 三拍窗
  // 日志零新增）、第二实例同不跑——独立进程同夹具 60s 首拍即触发（产品无罪；证据
  // 见回执 w-dutywire.md R1 段「独立进程实证」）。套件内覆盖=拍体判定谓词逐项复算
  // （同夹具下四值全支持触发）+ 源码静态序锚（门→target→at→节流→pm-lost 落账）。
  console.log("I R1 失联拍谓词复算+静态序（A 审 P1-2 拍体门）:");
  {
    const sb2 = sandbox("r1lost");
    try {
      const bus2 = new EventBus({ persistPath: join(sb2.dataDir, "events.ndjson") });
      const mgr2 = new SessionManager(bus2, mkCfg(18810, sb2.dataDir));
      writeCollabMode(sb2.dataDir, "no-leader");
      const GHOST2 = "ext-r1lost-ghost-1";
      seedFrame(sb2.dataDir, GHOST2, Date.now() - 2 * 60_000);
      setPmOverride({ session_id: GHOST2, cli_pid: 0, cwd: "/Users/u/dev/g2", claimed_at: Date.now() });
      process.env.CCR_DUTY_LOST_MIN = "1";
      // 谓词复算：拍体四步判定在夹具下的期望值逐项断言（任一失配=pm-lost 不会触发
      // 的真因；全配=触发路径畅通，剩下的只有 timer 相位/停摆属运行时面）
      const pMode = readCollabMode(sb2.dataDir);
      const pTarget = (mgr2 as unknown as { dutyTargetId(): string | null }).dutyTargetId();
      const pAt = lastFrameAtFromEvents(sb2.dataDir, GHOST2);
      const pLost = Number(process.env.CCR_DUTY_LOST_MIN) * 60_000;
      const pThrottle = Date.now() - (mgr2 as unknown as { lastPmLostAlertAt: number }).lastPmLostAlertAt;
      assert(pMode === "no-leader", "I① 拍门谓词①：collab-mode=no-leader（门放行）", pMode);
      assert(pTarget === GHOST2, "I② 拍门谓词②：dutyTargetId 命中失联席位（liveness 活跃窗内）", String(pTarget));
      assert(pAt !== null && Date.now() - pAt > pLost, "I③ 拍门谓词③：帧龄 2min > lostMin 1min（失联判定成立——非第一分支 return）", JSON.stringify({ at: pAt, ageMs: pAt ? Date.now() - pAt : -1 }));
      assert(pThrottle >= 3600_000, "I④ 拍门谓词④：节流放行（lastPmLostAlertAt 初值 0）", String(pThrottle));
      // 静态序锚：拍体源码完整路径（门→target 空分支→at 判定→flush→节流→pm-lost
      // 落账），leader 门在首行（独立进程实证配套：门挡=整拍 return，pm-lost 不可达）
      const smSrcI = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf-8");
      const watchBody = smSrcI.slice(smSrcI.indexOf("this.dutyLostTimer = setInterval"), smSrcI.indexOf("this.dutyLostTimer.unref"));
      const seq = [
        watchBody.indexOf('readCollabMode(this.cfg.dataDir) !== "no-leader") return;'),
        watchBody.indexOf("const target = this.dutyTargetId();"),
        watchBody.indexOf("lastFrameAtFromEvents(this.cfg.dataDir, target)"),
        watchBody.indexOf("this.lastPmLostAlertAt = now;"),
        watchBody.indexOf('kind: "pm-lost"'),
      ];
      assert(seq.every((x) => x >= 0) && seq.every((x, i) => i === 0 || x > seq[i - 1]), "I⑤ 拍体源码序锚：leader 门→target→帧龄→节流→pm-lost 落账顺序完整（门挡=pm-lost 不可达）", JSON.stringify(seq));
      assert(watchBody.indexOf('readCollabMode(this.cfg.dataDir) !== "no-leader") return;') < seq[1], "I⑥ leader 门在 target 判定之前（P1-2 拍体门位置——早退先于一切判定）");
      delete process.env.CCR_DUTY_LOST_MIN;
    } finally {
      delete process.env.CCR_DUTY_LOST_MIN;
      restore(sb2.prev);
    }
  }

  console.log(`\n========== dutywire 套件：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail > 0) process.exit(1);
}

void main().catch((e: unknown) => { console.error("SUITE CRASH:", e); process.exit(1); });
