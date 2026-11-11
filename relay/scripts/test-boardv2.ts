// W-BOARDV2（1111 用户令「黑板+看板投影」）——黑板事件链/看板投影/done 说真话 集成测试。
// 覆盖：
//   B1 schema 闸：event 词表内收写、词表外拒写（org-schema 写严格）、abnormal_done 字段落写
//   B2 派发侧黑板：dispatch-seat-scan 扫描行 + dispatched 行 dispatch-spawned/reused 打标
//   B3 worker 黑板：worker-ack/start/milestone/done 落账 + 每单去重 + milestone 90s 节流
//       + 无在途单 no-op + 非法事件词拒收
//   B4 done 说真话：有 worker-done 申报→收口行无 abnormal_done；缺席→abnormal_done:true
//   B5 看板投影：queued→backlog / dispatched·running→claimed / worker-done·done→submitted
//       / transitions 晚行→done / failed→backlog / user-override 后写赢 / abnormal 角标
//   B6 user-override 写入口：orgAction board move 同步落事件行
//   B7 SDK 钩子组装：buildWorkerBoardHooks 四事件映射/异常吞掉/非干预返回
//   B8 leader-board CLI：JSON 形态 + 人读输出段（沙盒 org 夹具直跑）
// 形态=test-dispatch 族同款（自包含 tsx + pass/fail 计数 + 假 agent 工厂，不拉真 CLI）。
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, readDispatchLog, readDispatchLogRaw, hasDispatchEvent } from "../src/org.js";
import { DISPATCH_EVENTS, applyOrgChange } from "../src/org-schema.js";
import { projectBoard, clearBoardProjectionCache } from "../src/board-projection.js";
import { buildWorkerBoardHooks } from "../src/agent-adapter.js";
import { loadBoard, upsertBoardEntry } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 20): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// 假 agent 工厂：回合收口延迟可调（TURN_CLOSE_MS）——B3/B4 需要「回合还在跑」窗口内
// 注入 worker 黑板事件（真链路里 worker-done 申报先于 relay 收口 done，夹具同序模拟）。
let turnCloseMs = 500;
type SpawnRec = { cwd: string; prompt: string | undefined; cb: AgentCallbacks; agent: AgentLike; resume?: string; configHome?: string; workerBoard?: boolean; engine?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; resume?: string; configHome?: string; workerBoard?: boolean; engine?: string }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {
        if (a.ended) return;
        setTimeout(() => {
          if (a.ended) return;
          cb.onStats({ files_changed: 1, lines_added: 2, lines_deleted: 1 }); // S1 零产出闸白名单
          cb.onTurnEnd(true, "success", 12);
        }, turnCloseMs);
      },
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    created.push({ cwd, prompt, cb, agent: a, resume: opts?.resume, configHome: opts?.configHome, workerBoard: opts?.workerBoard, engine: opts?.engine });
    // test-dispatch 同款：init 20ms 后回调；带 prompt 的会话回合同样独立计时收口
    //（真链路=SDK 队列直消费 initial prompt，不经 sendMessage——夹具等价模拟）
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, opts?.permissionMode ?? "default");
      if (prompt !== undefined) {
        setTimeout(() => {
          if (a.ended) return;
          cb.onStats({ files_changed: 1, lines_added: 2, lines_deleted: 1 }); // S1 零产出闸白名单
          cb.onTurnEnd(true, "success", 12);
        }, turnCloseMs);
      }
    }, 20);
    return a;
  };

function rawRows(org: string): Array<Record<string, unknown>> {
  const p = join(org, "dispatch-log.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-boardv2-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-boardv2-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevRead = process.env.CCR_STORAGE_READ_MODE;
  const prevTitle = process.env.CCR_NO_TITLE_GEN;
  process.env.CCR_STORAGE_READ_MODE = "json"; // 夹具 json 形态（test-dispatch 同款钉档）
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  let exit = 0;
  try {
    const cfg: RelayConfig = {
      port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const sticky = mkdtempSync(join(tmpdir(), "ccr-sentinel-bv2-"));
    writeFileSync(join(DATA, "last-cwd"), sticky, "utf-8");
    cfg.defaultCwd = sticky;

    // ---------- B1 schema 闸 ----------
    console.log("B1 schema 闸:");
    const okRow = appendDispatch({ ts: Date.now(), id: "bv2-schema-ok", tier: "随手办", target: "x", status: "running", event: "worker-ack", session_id: "s1" });
    assert(okRow === true, "词表内 event（worker-ack）收写");
    const badRow = appendDispatch({ ts: Date.now(), id: "bv2-schema-bad", tier: "随手办", target: "x", status: "running", event: "worker-party", session_id: "s1" } as unknown as Parameters<typeof appendDispatch>[0]);
    assert(badRow === false, "词表外 event（worker-party）拒写（写严格）");
    const badAbn = appendDispatch({ ts: Date.now(), id: "bv2-schema-bad2", tier: "随手办", target: "x", status: "running", abnormal_done: "yes" } as unknown as Parameters<typeof appendDispatch>[0]);
    assert(badAbn === false, "abnormal_done 非布尔拒写");
    assert(DISPATCH_EVENTS.includes("dispatch-seat-scan") && DISPATCH_EVENTS.includes("user-override"), "词表含派发侧四态+user-override");

    // ---------- 环境：manager + leader ----------
    const created: SpawnRec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const lr = mgr.ensureLeader();
    assert(lr.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().some((s) => s.status === "DONE" && s.done_reason === "success"));

    const anchor = join(DATA, "anchor-bv2");
    mkdirSync(anchor, { recursive: true });

    // ---------- B2 派发侧黑板 + B3 worker 黑板 + B4 done 说真话（有申报） ----------
    console.log("B2/B3/B4 派发侧+worker 黑板+done 说真话:");
    turnCloseMs = 800; // 留足回合窗注入 worker 事件
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "改 README 错别字", title: "错别字任务" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d1.ok === true, "随手办派单受理");
    const did1 = d1.ok ? (d1 as { dispatch_id: string }).dispatch_id : "";
    const wid1 = d1.ok ? (d1 as { session_id: string }).session_id : "";
    assert(await waitFor(() => readDispatchLogRaw().some((r) => r.id === did1 && r.event === "dispatch-seat-scan")), "选席扫描事件行落账");
    const scanRow = readDispatchLogRaw().find((r) => r.id === did1 && r.event === "dispatch-seat-scan");
    assert(!!scanRow && String(scanRow.receipt ?? "").includes("选席扫描") && String(scanRow.receipt ?? "").includes("落席"), "扫描行 receipt 含决策主干（新建会话落席）");
    assert(scanRow?.status === "dispatched" && scanRow.target === "seat-scan", "扫描行 status=dispatched + target=seat-scan（六态零破坏）");
    assert(await waitFor(() => readDispatchLogRaw().some((r) => r.id === did1 && r.status === "dispatched" && r.event === "dispatch-spawned")), "dispatched 行带 dispatch-spawned 打标（新会话路径；原始行——收敛视图被 running 末行覆盖）");
    assert(await waitFor(() => readDispatchLog().some((r) => r.id === did1 && r.status === "running")), "回合 running 行（真启动）");

    // worker 黑板事件：ack/start 去重、milestone 节流、done 申报
    assert(mgr.workerBoardEvent(wid1, "worker-ack") === true, "worker-ack 落账");
    assert(mgr.workerBoardEvent(wid1, "worker-ack") === false, "worker-ack 同单去重（二次 false）");
    assert(mgr.workerBoardEvent(wid1, "worker-bad" as "worker-ack") === false, "非法事件词拒收");
    assert(mgr.workerBoardEvent(wid1, "worker-start", "Edit") === true, "worker-start 落账（detail=工具名）");
    assert(mgr.workerBoardEvent(wid1, "worker-milestone") === true, "worker-milestone 落账");
    assert(mgr.workerBoardEvent(wid1, "worker-milestone") === false, "worker-milestone 节流（90s 窗二次 false）");
    assert(mgr.workerBoardEvent(wid1, "worker-done", "结果：已改｜改动文件：README.md") === true, "worker-done 申报落账");
    assert(mgr.workerBoardEvent(wid1, "worker-done") === false, "worker-done 同单去重");
    assert(mgr.workerBoardEvent("no-such-sid", "worker-ack") === false, "无在途单会话 no-op（Leader/PM 零污染）");
    const ackRow = readDispatchLogRaw().find((r) => r.id === did1 && r.event === "worker-ack");
    assert(!!ackRow && ackRow.status === "running" && ackRow.session_id === wid1, "worker 事件行形态（同 id 段链/status=running/session=承接席）");

    // B4 正面：有 worker-done 申报 → 收口 done 无 abnormal_done
    assert(await waitFor(() => readDispatchLog().filter((r) => r.id === did1).some((r) => r.status === "done")), "回合收口 done");
    const closeRow1 = readDispatchLog().filter((r) => r.id === did1).find((r) => r.status === "done");
    assert(!!closeRow1 && closeRow1.abnormal_done !== true, "有 worker-done 申报 → 收口行无 abnormal_done（说真话对账通过）");
    assert(hasDispatchEvent(did1, "worker-done") === true, "hasDispatchEvent 对账原语命中");

    // ---------- B4 反面：无申报 → abnormal_done:true ----------
    console.log("B4 done 说真话（反面）:");
    turnCloseMs = 60; // 极速收口：注入窗口关闭=无任何 worker 事件
    const d2 = mgr.orgAction("dispatch", { anchor, prompt: "第二单（跑路形态）" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    const did2 = d2.ok ? (d2 as { dispatch_id: string }).dispatch_id : "";
    assert(await waitFor(() => readDispatchLog().filter((r) => r.id === did2).some((r) => r.status === "done")), "第二单收口 done");
    const closeRow2 = readDispatchLog().filter((r) => r.id === did2).find((r) => r.status === "done");
    assert(!!closeRow2 && closeRow2.abnormal_done === true, "worker-done 缺席 → 收口行 abnormal_done:true（异常完成可观测）");
    // 对账闸②：非 claude 引擎（结构性无申报能力）不标 abnormal（反方审查 P1 处置回归钉）
    // [W-BOARDV2-CIFIX] CI 环境整备：dispatch 前置 preflightDispatchEngine 对 codex 跑
    // 生产真预检（preflightEngine 查可执行 + probeEngineAuth 查登录态）——CI runner 无
    // codex 二进制→受理拒→本三断言环境红（本地有 codex 恒绿=CI/本地差异根因，CI 实跑
    // 53/3 本地复现 CCR_CODEX_PATH=__none__ 逐字同形）。整备两关真 ready 路径非旁路：
    // ① stub 可执行脚本（accessSync X_OK 过检——preflight 不真跑它）；② OPENAI_API_KEY
    // 在场（codexConfigAuthPresent 认配置优先→ready，跳过 spawn login status 探测）。
    // spawn 面零波及：fake factory 在场，newAgent codex 分支走替身不构造真 CLI 会话。
    // probeCache 首探前设值（本进程此前未 probe 过 codex）——断言语义全保留。
    const codexStub = join(DATA, "codex-stub.sh");
    writeFileSync(codexStub, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(codexStub, 0o755);
    const envBakCodex = { CCR_CODEX_PATH: process.env.CCR_CODEX_PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    process.env.CCR_CODEX_PATH = codexStub;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "boardv2-ci-stub";
    try {
      const d2c = mgr.orgAction("dispatch", { anchor, prompt: "codex 引擎单", engine: "codex" }) as { ok: boolean; dispatch_id?: string };
      const did2c = d2c.ok ? (d2c as { dispatch_id: string }).dispatch_id : "";
      assert(d2c.ok === true, "codex 引擎派单受理");
      assert(await waitFor(() => readDispatchLog().filter((r) => r.id === did2c).some((r) => r.status === "done")), "codex 单收口 done");
      const closeRow2c = readDispatchLog().filter((r) => r.id === did2c).find((r) => r.status === "done");
      assert(!!closeRow2c && closeRow2c.abnormal_done !== true, "非 claude 引擎无申报 → 不标 abnormal_done（结构性豁免）");
    } finally {
      // env 恢复（进程内防外溢；stub 随 DATA 临时目录清理）
      if (envBakCodex.CCR_CODEX_PATH === undefined) delete process.env.CCR_CODEX_PATH; else process.env.CCR_CODEX_PATH = envBakCodex.CCR_CODEX_PATH;
      if (envBakCodex.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = envBakCodex.OPENAI_API_KEY;
    }

    // ---------- B5/B6 看板投影 + user-override ----------
    console.log("B5/B6 看板投影+user-override:");
    clearBoardProjectionCache();
    const c1 = mgr.orgAction("project-create", { name: "bv2alpha", anchor: join(DATA, "proj-bv2"), tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; needsConfirm?: boolean; confirm?: { id: string } } };
    const gid = c1.data?.group?.id ?? "";
    if (c1.data?.needsConfirm && c1.data?.confirm?.id) mgr.orgAction("confirm-decide", { confirm_id: c1.data.confirm.id, approve: true, by: "u" });
    assert(!!gid, "项目组建（投影夹具）");
    turnCloseMs = 400;
    const d3 = mgr.orgAction("dispatch", { anchor: join(DATA, "proj-bv2"), prompt: "组内任务", gid, title: "投影任务" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    const did3 = d3.ok ? (d3 as { dispatch_id: string }).dispatch_id : "";
    assert(d3.ok === true && !!did3, "组派单受理");
    assert(await waitFor(() => readDispatchLog().filter((r) => r.id === did3).some((r) => r.status === "running")), "组单 running");
    const card = loadBoard(gid).entries.find((e) => e.dispatch_id === did3);
    assert(!!card, "建卡联动（dispatch_id 关联）");
    // 施工中投影：dispatched/running → claimed
    let proj = projectBoard(gid);
    let pc = proj.cards.find((c) => c.entry_id === card?.id);
    assert(pc?.lane === "claimed", "投影：dispatched/running → claimed（进行中）");
    assert((pc?.last_event === "dispatch-reused" || pc?.last_event === "dispatch-spawned" || pc?.last_event === "worker-milestone" || pc?.last_event === ""), "投影 last_event 为黑板事件词");
    assert(Array.isArray(pc?.lifecycle) && (pc?.lifecycle.length ?? 0) >= 2, "投影 lifecycle 全链在档");
    // 组单收口（400ms 无 worker 事件=abnormal 形态）→ done 行 → 投影 submitted + abnormal 角标
    assert(await waitFor(() => readDispatchLog().filter((r) => r.id === did3).some((r) => r.status === "done")), "组单收口 done");
    proj = projectBoard(gid);
    pc = proj.cards.find((c) => c.entry_id === card?.id);
    assert(pc?.lane === "submitted", "投影：relay done 收口 → submitted（待审）");
    assert(pc?.abnormal_done === true, "投影 abnormal_done 角标透传");

    // user-override：手工搬卡 → done 泳道（transitions 晚行+事件行双源）
    const mv = mgr.orgAction("board", { op: "move", gid, entry_id: card?.id, status: "done" }) as { ok: boolean };
    assert(mv.ok === true, "orgAction board move 受理");
    const ovrRow = readDispatchLogRaw().find((r) => r.event === "user-override" && String(r.target ?? "") === `card:${gid}:${card?.id}`);
    assert(!!ovrRow && ovrRow.status === "done" && String(ovrRow.stage ?? "") === "custom.board-done", "move 落 user-override 事件行（target=card:gid:entry + stage 编码泳道）");
    proj = projectBoard(gid);
    pc = proj.cards.find((c) => c.entry_id === card?.id);
    assert(pc?.lane === "done", "投影：override/transitions 晚行 → done（后写赢）");

    // failed → backlog
    const okRowF = appendDispatch({ ts: Date.now(), id: "bv2-fail-d", tier: "轻立项", target: "w", status: "dispatched", session_id: "w", project_anchor: join(DATA, "proj-bv2") });
    assert(okRowF === true, "投影夹具 dispatched 行落账");
    upsertBoardEntry(gid, { id: "bv2-fail-card", text: "失败投影卡", dispatch_id: "bv2-fail-d", status: "claimed" });
    appendDispatch({ ts: Date.now(), id: "bv2-fail-d", tier: "轻立项", target: "w", status: "failed", session_id: "w", project_anchor: join(DATA, "proj-bv2"), receipt: "error exit 1" });
    proj = projectBoard(gid);
    assert(proj.cards.find((c) => c.entry_id === "bv2-fail-card")?.lane === "backlog", "投影：failed → backlog（打回）");

    // ---------- B9 接线断言（审查 A-P0 直接漏网处的回归钉：spawn opts 必须带 workerBoard） ----------
    console.log("B9 钩子接线+age 新鲜度:");
    // claude 系 spawn（非 codex——SDK 编程式钩子是 claude 通道，codex 结构性豁免，
    // 对账闸在 closeOpenDispatches engineSupportsBoard 承接）必须全部带 workerBoard
    const claudeSpawns = created.filter((c) => c.engine !== "codex");
    const spawnedWithBoard = claudeSpawns.filter((c) => c.workerBoard === true).length;
    assert(claudeSpawns.length > 0 && spawnedWithBoard === claudeSpawns.length, "接线：全部 claude 系 spawn opts 带 workerBoard:true（newAgent 单点闸——P0 回归钉）");
    // age 新鲜度：缓存命中路径 age_ms 仍随时间推进（审查 A-P1 ④回归钉）
    const before = projectBoard(gid);
    await wait(60);
    const after = projectBoard(gid);
    const beforeCard = before.cards.find((c) => c.entry_id === card?.id);
    const afterCard = after.cards.find((c) => c.entry_id === card?.id);
    assert(!!afterCard && afterCard.age_ms >= (beforeCard?.age_ms ?? 0) + 50, "投影缓存命中 age_ms 现算（不冻结——停留时长信号可用）");

    // ---------- B7 SDK 钩子组装 ----------
    console.log("B7 SDK 钩子组装:");
    const seen: Array<[string, string | undefined]> = [];
    const hooks = buildWorkerBoardHooks((ev, dt) => seen.push([ev, dt]));
    const keys = Object.keys(hooks).sort().join(",");
    assert(keys === "PostToolUse,SessionStart,Stop,TaskCompleted", "四事件映射（SessionStart/PostToolUse/Stop/TaskCompleted）");
    // 逐个触发：断言上报词 + 非干预返回 + 异常吞掉
    const ss = hooks.SessionStart?.[0].hooks[0];
    const pt = hooks.PostToolUse?.[0].hooks[0];
    const sp = hooks.Stop?.[0].hooks[0];
    const tc = hooks.TaskCompleted?.[0].hooks[0];
    const out1 = await ss?.({ hook_event_name: "SessionStart", session_id: "x", transcript_path: "", cwd: "" } as never, undefined, { signal: new AbortController().signal });
    const out2 = await pt?.({ hook_event_name: "PostToolUse", session_id: "x", transcript_path: "", cwd: "", tool_name: "Edit", tool_input: {}, tool_response: "", tool_use_id: "u" } as never, undefined, { signal: new AbortController().signal });
    const out3 = await sp?.({ hook_event_name: "Stop", session_id: "x", transcript_path: "", cwd: "", stop_hook_active: false } as never, undefined, { signal: new AbortController().signal });
    const out4 = await tc?.({ hook_event_name: "TaskCompleted", session_id: "x", transcript_path: "", cwd: "", task_id: "1", task_subject: "错别字任务" } as never, undefined, { signal: new AbortController().signal });
    assert(seen[0]?.[0] === "worker-ack", "SessionStart → worker-ack");
    assert(seen[1]?.[0] === "worker-start" && seen[1]?.[1] === "Edit", "PostToolUse → worker-start（detail=工具名）");
    assert(seen[2]?.[0] === "worker-milestone", "Stop → worker-milestone");
    assert(seen[3]?.[0] === "worker-done" && seen[3]?.[1] === "错别字任务", "TaskCompleted → worker-done（detail=task_subject）");
    const empty = (o: unknown) => !!o && typeof o === "object" && Object.keys(o as object).length === 0;
    assert(empty(out1) && empty(out2) && empty(out3) && empty(out4), "钩子返回 {}（非干预语义——不决策不阻断）");
    const crashing = buildWorkerBoardHooks(() => { throw new Error("上报口炸了"); });
    let survived = true;
    try {
      await crashing.Stop?.[0].hooks[0]({ hook_event_name: "Stop", session_id: "x", transcript_path: "", cwd: "", stop_hook_active: false } as never, undefined, { signal: new AbortController().signal });
    } catch {
      survived = false;
    }
    assert(survived, "上报口异常吞掉（观测面绝不阻断回合）");

    // ---------- B8 leader-board CLI ----------
    console.log("B8 leader-board CLI:");
    const bin = join(import.meta.dirname ?? ".", "..", "..", "cc-plugins", "plugins", "cc-deck", "bin", "leader-board");
    const jsonOut = execFileSync("python3", [bin, "--json", "--window", "5000"], {
      env: { ...process.env, CCR_ORG_DIR: ORG },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(jsonOut) as { ok: boolean; active: unknown[]; abnormal_done: Array<{ id: string }>; terminal_recent: unknown[] };
    assert(parsed.ok === true && Array.isArray(parsed.active) && Array.isArray(parsed.abnormal_done) && Array.isArray(parsed.terminal_recent), "leader-board --json 形态（active/abnormal_done/terminal_recent）");
    assert(parsed.abnormal_done.some((x) => x.id === did2), "leader-board：跑路单（did2）入异常完成列");
    const textOut = execFileSync("python3", [bin, "--window", "5000", "--limit", "5"], {
      env: { ...process.env, CCR_ORG_DIR: ORG },
      encoding: "utf-8",
    });
    assert(textOut.includes("== 在途单") && textOut.includes("== 异常完成") && textOut.includes("== 最近终态"), "leader-board 人读输出三段（在途/异常完成/最近终态）");
  } catch (e) {
    console.error("套件异常:", e);
    exit = 1;
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevRead === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevRead;
    if (prevTitle === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitle;
    try { rmSync(ORG, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
    try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  }
  console.log(`\nboardv2: ${pass} passed, ${fail} failed`);
  if (fail > 0 || exit !== 0) process.exit(1);
}

void main();
