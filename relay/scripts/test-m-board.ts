// multica 中件批二·板卡域三件测试：
//   M2a 板卡唤醒（multica 借②）：wakeup_at 卡级字段（upsert 设置/清除回环）+
//     patrol 轻探针两规则——①到点消费制触发（actionable 通知+onset 推送+字段清空防重触
//     +PM 喂活尽力）②claimed(doing) 滞留>阈值（默认 60min，env 可调）且执行者同静默
//     →提醒（不自动重派）；执行者活跃/未来时点/终态卡=不触发（防误杀长编译）。
//   M2b 父子（借④补强）：parent_id 回环（#G3 已有，锁断言防回退）+ 看板批次齐活
//     渲染面静态锚（__subDone/__subAllDone/x/y 进度/齐活 chip——team-domain+css）。
//   M5 双活数据层防（卷一 §Top5-1 范式）：veteran 认领「同席活单检查+dispatched 落账」
//     同入 org 写锁域——同 session 已有异 id 的 dispatched/running 行→数据层拒收+
//     台账 failed 记因；同 id 段链（queue_replay/redispatch）不误伤；终态后复用照旧
//     （D8 会话亲和回归口径）。
// 隔离：CCR_ORG_DIR/CCR_DATA_DIR/CCR_STORAGE_READ_MODE=json/CCR_NO_LEADER=1 四钉
//（test-patrol/test-dispatch 同缝），不触生产 ~/.cc-deck。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { PatrolModule } from "../src/patrol.js";
import { readDispatchLog, readDispatchLogFile } from "../src/org.js";
import { createGroup, listGroups, loadBoard, setLightConfirmTrusted, setGroupStatus, upsertBoardEntry } from "../src/projects.js";
import { routingFor } from "../src/routing.js";
import { loadConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}
const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");

// fake agent 工厂（test-dispatch 同款；**不回 onStatusChange**——veteran 恒 idle，
// M5 双活窗（认领→WORKING 翻转间隙）在测试里被拉宽成确定性窗口）
type SpawnRec = { cwd: string; prompt: string | undefined; cb: AgentCallbacks; agent: AgentLike; resume?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; resume?: string }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => { setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 10); }, 10); },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    created.push({ cwd, prompt, cb, agent: a, resume: opts?.resume });
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, opts?.permissionMode ?? "default");
      if (prompt !== undefined) setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 10); }, 10);
    }, 20);
    return a;
  };

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CCR_ORG_DIR", "CCR_DATA_DIR", "CCR_STORAGE_READ_MODE", "CCR_NO_LEADER", "CCR_NO_TITLE_GEN", "CCR_PATROL_DOING_STALE_MIN", "CCR_PATROL", "CCR_ARTIFACTS_DIR"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const dirs: string[] = [];

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-mboard-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-mboard-"));
  dirs.push(ORG, DATA);
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_LEADER = "1";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_ARTIFACTS_DIR = join(DATA, "artifacts");
  mkdirSync(join(DATA, "artifacts"), { recursive: true });
  delete process.env.CCR_PATROL_DOING_STALE_MIN;
  try {
    const cfg = loadConfig();
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const notes: string[] = [];
    bus.subscribe((e) => {
      if (e.type === "TASK_DONE") notes.push(...((e.payload as { done?: string[] }).done ?? []));
    });
    const created: SpawnRec[] = [];
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const patrol = new PatrolModule(mgr, { dataDir: DATA, reportPath: join(DATA, "patrol-report.md"), enabled: () => process.env.CCR_PATROL !== "0" });

    // 立项 + 板卡底子
    const anchor = join(DATA, "proj-mboard");
    mkdirSync(anchor, { recursive: true });
    setLightConfirmTrusted(true);
    const cg = createGroup({ name: "mboard 组", anchor_dir: anchor, tier: "轻立项" });
    const gid = cg.ok ? cg.group.id : "";
    if (listGroups().find((g) => g.id === gid)?.status !== "active") setGroupStatus(gid, "active");
    assert(listGroups().find((g) => g.id === gid)?.status === "active", "组 active（前置）");

    // ---------- M2a-1：wakeup_at 字段域（设置/回读/清除回环） ----------
    section("\nM2a-1 wakeup_at 板卡字段域：");
    {
      const w = upsertBoardEntry(gid, { id: "t-wake-1", text: "唤醒卡", status: "backlog", wakeup_at: Date.now() + 3600_000 });
      assert(w.ok && w.entry.wakeup_at === w.entry.wakeup_at && typeof w.entry.wakeup_at === "number", "upsert 带 wakeup_at 落卡（设置面）");
      assert(loadBoard(gid).entries.find((e) => e.id === "t-wake-1")?.wakeup_at !== undefined, "板文件回读带 wakeup_at（持久化）");
      const c = upsertBoardEntry(gid, { id: "t-wake-1", text: "唤醒卡", status: "backlog", wakeup_at: null });
      assert(c.ok && loadBoard(gid).entries.find((e) => e.id === "t-wake-1")?.wakeup_at === undefined, "wakeup_at:null=清除（消费口径同 parent_id）");
    }

    // ---------- M2a-2：patrol 两规则（时钟回拨=沙盒时钟推进） ----------
    section("\nM2a-2 patrol 板卡域两规则：");
    {
      // 推送目标会话（push 投递兜底链需要；进程 pid=活）
      const pm1 = mgr.ensureExternal("ext-mboard-1", anchor, "patrol 目标会话");
      mgr.setExternalCliPid("ext-mboard-1", process.pid);
      // 规则①到点卡：wakeup_at 过去 1min → 触发+消费
      upsertBoardEntry(gid, { id: "t-wake-due", text: "到点唤醒卡", status: "backlog", wakeup_at: Date.now() - 60_000 });
      // 规则①未来卡：不触发
      upsertBoardEntry(gid, { id: "t-wake-future", text: "未来唤醒卡", status: "backlog", wakeup_at: Date.now() + 3600_000 });
      // 规则②滞留卡：claimed + updated_at 61min 前 + 无执行者
      const s2 = upsertBoardEntry(gid, { id: "t-stall-1", text: "滞留卡无主", status: "claimed" });
      assert(s2.ok, "滞留卡建（前置）");
      { // 手工回拨卡龄（沙盒时钟推进：把 updated_at 拨回 61min 前）
        const b = loadBoard(gid);
        const e = b.entries.find((x) => x.id === "t-stall-1");
        if (e) { e.updated_at = Date.now() - 61 * 60_000; writeFileSync(join(ORG, "boards", `${gid}.json`), JSON.stringify(b) + "\n", "utf-8"); }
      }
      // 规则②执行者活跃卡：卡龄 61min 但执行者会话刚刚活动 → 不算滞留（长编译防误杀）
      upsertBoardEntry(gid, { id: "t-stall-2", text: "执行者在干卡", status: "claimed", owner_session: "ext-mboard-1" });
      {
        const b = loadBoard(gid);
        const e = b.entries.find((x) => x.id === "t-stall-2");
        if (e) { e.updated_at = Date.now() - 61 * 60_000; writeFileSync(join(ORG, "boards", `${gid}.json`), JSON.stringify(b) + "\n", "utf-8"); }
      }
      // 规则②终态卡：done 滞龄不触发
      upsertBoardEntry(gid, { id: "t-done-old", text: "终态旧卡", status: "done" });
      {
        const b = loadBoard(gid);
        const e = b.entries.find((x) => x.id === "t-done-old");
        if (e) { e.updated_at = Date.now() - 61 * 60_000; writeFileSync(join(ORG, "boards", `${gid}.json`), JSON.stringify(b) + "\n", "utf-8"); }
      }
      patrol.runLight();
      // 通知账（actionable 通知落 dataDir/notifications.json）
      const notif = readFileSync(join(DATA, "notifications.json"), "utf-8");
      assert(notif.includes("板卡唤醒") && notif.includes("到点唤醒卡"), "规则①：到点卡产生唤醒通知（actionable）");
      assert(loadBoard(gid).entries.find((e) => e.id === "t-wake-due")?.wakeup_at === undefined, "规则①：触发后 wakeup_at 消费清空（防重触）");
      assert(loadBoard(gid).entries.find((e) => e.id === "t-wake-future")?.wakeup_at !== undefined, "规则①：未来时点卡不触发不消费");
      assert(!notif.includes("未来唤醒卡"), "规则①：未来卡无通知");
      assert(notif.includes("doing 滞留提醒"), "规则②：滞留卡产生提醒通知");
      assert(notif.includes("滞留卡无主") && !notif.includes("执行者在干卡"), "规则②：执行者活跃卡不误报（防误杀长编译）");
      assert(!notif.includes("终态旧卡"), "规则②：终态卡不触发");
      const notesAfterFirst = notes.filter((n) => n.includes("巡检")).length;
      // onset-only：同条件第二轮不重推；已消费/已处理面不重复
      patrol.runLight();
      assert(notes.filter((n) => n.includes("巡检")).length === notesAfterFirst, "onset-only：同条件二轮不重推");
      assert(!notif.includes("到点唤醒卡") || loadBoard(gid).entries.find((e) => e.id === "t-wake-due")?.wakeup_at === undefined, "消费幂等：二轮不重复触发（字段已清）");
      // 阈值 env 可调（卷四裁决「默认 60 可调」）：调到 6000min → 滞留卡不再报
      process.env.CCR_PATROL_DOING_STALE_MIN = "6000";
      // 重新制造一张滞留卡（原卡已在 lastAlerts 去重账本——换新卡验证阈值生效）
      upsertBoardEntry(gid, { id: "t-stall-3", text: "阈值卡", status: "claimed" });
      {
        const b = loadBoard(gid);
        const e = b.entries.find((x) => x.id === "t-stall-3");
        if (e) { e.updated_at = Date.now() - 61 * 60_000; writeFileSync(join(ORG, "boards", `${gid}.json`), JSON.stringify(b) + "\n", "utf-8"); }
      }
      const notifBefore = readFileSync(join(DATA, "notifications.json"), "utf-8");
      patrol.runLight();
      const notifAfter = readFileSync(join(DATA, "notifications.json"), "utf-8");
      assert(!notifAfter.includes("阈值卡") || notifBefore.includes("阈值卡"), "阈值 env 可调：6000min 下 61min 卡不报");
      delete process.env.CCR_PATROL_DOING_STALE_MIN;
      // 报告落盘面
      const report = readFileSync(join(DATA, "patrol-report.md"), "utf-8");
      assert(report.includes("board-card:"), "巡检报告含 board-card 扫描行（可观测）");
    }

    // ---------- M2b：父子域回环 + 渲染面静态锚 ----------
    section("\nM2b 父子（parent_id 回环+齐活渲染锚）：");
    {
      const p = upsertBoardEntry(gid, { id: "t-parent-1", text: "批次父卡", status: "claimed" });
      assert(p.ok, "父卡建（前置）");
      const c1 = upsertBoardEntry(gid, { id: "t-child-1", text: "子卡一", status: "done", parent_id: "t-parent-1" });
      const c2 = upsertBoardEntry(gid, { id: "t-child-2", text: "子卡二", status: "claimed", parent_id: "t-parent-1" });
      assert(c1.ok && c2.ok, "两张子卡挂 parent_id（#G3 回环）");
      const b = loadBoard(gid);
      assert(b.entries.filter((e) => e.parent_id === "t-parent-1").length === 2, "板文件回读 parent_id 持久（2 子）");
      // 派单建卡透传口径（#G3 已有，锁断言防回退）：dispatchWorker parent_id → 新卡带
      const js = readFileSync(join(repoRoot, "web-console/js/team-domain.js"), "utf-8");
      assert(js.includes("__subDone") && js.includes("__subAllDone"), "渲染层算子齐备（__subDone/__subAllDone）");
      assert(/subDone \+ "\/" \+ subCount/.test(js), "折叠钮显子卡进度 x/y（done/total）");
      assert(js.includes("sub-all-chip") && js.includes("批次齐活"), "齐活 chip 渲染（全部子卡 done 父卡亮）");
      assert(js.includes('subAllDone ? " sub-all" : ""'), "齐活折叠钮加亮类（sub-all）");
      assert(!/\"▸\" \+ \" \" \+ subCount/.test(js), "旧「只显总数」渲染已退役（x/y 全面替换）");
      const css = readFileSync(join(repoRoot, "web-console/css/base.css"), "utf-8");
      assert(css.includes(".sub-toggle.sub-all") && css.includes(".sub-all-chip"), "齐活样式锚（钮亮+chip）");
      // 老卡零变化：无 parent_id 卡（subCount=0）不渲染折叠钮——渲染串以 subCount 条件包裹（静态锚）
      assert(js.includes("subCount ? '<button"), "无子卡不渲染折叠钮（老卡零变化口径）");
      // wakeup_at 透传面（M2a）：org-schema 声明（applyOrgChange 校验面）
      const schema = readFileSync(join(repoRoot, "relay/src/org-schema.ts"), "utf-8");
      assert(schema.includes("wakeup_at: { type: \"number\" }"), "org-schema 板卡 schema 含 wakeup_at（校验面）");
    }

    // ---------- M5：双活数据层防 ----------
    section("\nM5 dispatch 双活数据层防（同席活单拒）：");
    {
      // 熟手 w1 诞生：首单收口 → routing count=1 + relay_session_id 在册（veteran 可选中）
      const d1 = mgr.orgAction("dispatch", { anchor, prompt: "mboard 首单", gid }) as { ok: boolean; session_id?: string };
      const w1 = d1.session_id ?? "";
      assert(d1.ok === true && !!w1, "首单派出（前置）");
      assert(await waitFor(() => (routingFor(gid).find((x) => x.session_id === w1)?.count ?? 0) === 1), "首单收口 routing=1（前置）");
      assert((mgr as unknown as { sessions: Map<string, { state: { relay_session_id?: string } }> }).sessions.get(w1)?.state.relay_session_id !== undefined, "w1 已 init（relay_session_id 在册，前置）");

      // 双活窗构造（数据层不变式测试）：dispatchWorker 全程同步零 await——同线程
      // 双 claim 不可能经派单路径发生；守卫的真实捕获面=①relay 重启重放窗（会话
      // 重放回 idle 而台账活单仍在——重启期间在制单的实态）②跨写口认领（面板
      // task/COMMAND_DISPATCH 等异口挂 owner）③未来 async 重构回归。直接构造
      // 「w1 idle + 台账活 running 行」态（app 层检查恒放行）→ 数据层必须拒。
      const activeId = "mboard-active-" + randomUUID().slice(0, 8);
      const { appendDispatch } = await import("../src/org.js");
      appendDispatch({ ts: Date.now(), id: activeId, tier: "正经立项", target: w1, status: "running", session_id: w1, project_anchor: anchor, actor: "leader" });
      const notesLenBefore = notes.length;
      const dB = mgr.orgAction("dispatch", { anchor, prompt: "mboard 双活 B 单", gid }) as { ok: boolean; error?: string; dispatch_id?: string };
      assert(dB.ok === false && (dB.error ?? "").includes("同席活单拒收"), "活单在制 + 会话 idle（重放窗态）→ 数据层拒收（app 层恒放行的态由数据层兜）");
      assert((dB.error ?? "").includes(activeId.slice(0, 8)), "拒收报错指向在制活单 id（可操作指引）");
      {
        const row = readDispatchLog().find((e) => e.id === (dB.dispatch_id ?? ""));
        assert(row?.status === "failed" && (row.receipt ?? "").includes("同席活单拒收"), "台账 failed 行记因（数据层双活防）");
        assert((row as { failure_reason?: string }).failure_reason === "logic_error", "失败分类=logic_error（非瞬态不自动重试）");
      }
      // 台账文件直读变体（M5 守卫事务内同口径）：与 readDispatchLog 收敛一致
      assert(readDispatchLogFile().some((e) => e.id === activeId), "readDispatchLogFile 文件直读=收敛同口径（守卫读源）");
      // 活单终态（收口）→ 守卫解除，熟手复用照旧（无假阳性）
      appendDispatch({ ts: Date.now(), id: activeId, tier: "正经立项", target: w1, status: "done", session_id: w1, project_anchor: anchor, actor: "leader", receipt: "结果：模拟收口" });
      const d3 = mgr.orgAction("dispatch", { anchor, prompt: "mboard 三单", gid }) as { ok: boolean; session_id?: string; dispatch_id?: string };
      assert(d3.ok === true && d3.session_id === w1, "活单终态后新单 → 熟手正常复用（无假阳性）");
      assert(await waitFor(() => { const r = readDispatchLog().find((e) => e.id === (d3.dispatch_id ?? "")); return r?.status === "done"; }), "三单收口（前置）");
      // 同 id 段链不误伤：redispatch_of=三单（终态后）→ 守卫 id 排除放行
      const dR = mgr.orgAction("dispatch", { anchor, prompt: "mboard 重投单", gid, redispatch_of: d3.dispatch_id }) as { ok: boolean; session_id?: string };
      assert(dR.ok === true && dR.session_id === w1, "同 id 段链（redispatch）不误伤——熟手复用照旧（D8 会话亲和无回归）");
      assert(notes.length >= notesLenBefore, "巡检通知链未受 M5 影响（旁路无扰）");

    }

    console.log(`\n========== m-board 套件：${pass} 通过 / ${fail} 失败 ==========`);
  } finally {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力清理 */ } }
  }
  process.exit(fail > 0 ? 1 : 0);
}

void main();
