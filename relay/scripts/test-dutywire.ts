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
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import { writeCollabMode } from "../src/settings.js";
import { decideConfirm, listPendingConfirms } from "../src/projects.js";
import { clearPmOverride, readDutyFeedPending, readPmOverride, setPmOverride, takeDutyFeedPending } from "../src/org.js";
import { dutyActivityWindowMin, lastFrameAtFromEvents, sessionActiveByEvents } from "../src/duty-feed.js";
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
    // 帧龄出窗 → 读路径自动清档（席位不锁死）
    writeFileSync(join(sb.dataDir, "events.ndjson"), "");
    seedFrame(sb.dataDir, PM_EXT, now - 16 * 60_000);
    const st2 = mgr.pmDutyStatus();
    assert(st2.session_id === "" && st2.alive === false, "C② 帧龄出窗→席位自动清档（外部席位不锁死——claim/提名恢复可达）", JSON.stringify({ s: st2.session_id }));
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
  } finally {
    restore(sb.prev);
  }

  console.log(`\n========== dutywire 套件：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail > 0) process.exit(1);
}

void main().catch((e: unknown) => { console.error("SUITE CRASH:", e); process.exit(1); });
