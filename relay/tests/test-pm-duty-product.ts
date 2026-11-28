// ---------- P71 值守产品化一期测试（019 §6 产品面接线） ----------
// 覆盖：P0 配置面静态断言（五键/duty 缺省 true/CCR_CONFIG_FILE override）；
//       P1 缺省开门（config 无键=值守照常，产品缺省开回归面）；
//       P2 worker done 边唤醒主链（现行语义：交付收口→A 翻 submitted（boardlife）→
//          回执直达注入 PM（W-DELIVERCB 收件箱直达）→值守让位 sleep user_active
//          （W-DUTYBACKOFF 刀1）→收割解锁后活跃窗外兜底重算照常注入）；
//       P2b failed 边即刻零值守（notifyDispatchClosed 回执注入承接防双挂备案）；
//       P3/P4 三态之 blocked（gate 卡）/all_running（健康在跑不催）；
//       P5 无进展退避（W-DUTYBACKOFF 刀2：同 top 第 2 轮起 sleep no_progress_backoff
//          5→15→30→60min 级数）+top 变化复位+候选消化循环终止（级数表数值与到期补发
//          timer 真跑由 test-dutybackoff B/R2 组专锁）；
//       P6 全局总闸 duty=false→disabled 审计零注入（019 §6.1「值守审计仍记录
//          disabled」+kill-switch）；
//       P7 WORKING 合并门（019 §3.3「PM WORKING 时合并 feed 上下文而不追加回合」：
//          不换流打断在途回合，事件不丢——收口 turn_end 兜底重算；worker done 边的
//          回执直达换流面归 P2①）；
//       P8 组级门控 duty_policy.enabled=false 该组零候选、清除回开（两级同开才生效
//          之组级半边，019 §6.3「已有显式 false 的组不被迁移覆盖」）。
// fixture 缝仿 test-m12-commands C12 段（mkdtemp+CCR_ORG_DIR/CCR_DATA_DIR 注入+
// fake agent factory+send 直调 handleCommand；CCR_CONFIG_FILE/CCR_ACCEPTANCE_DIR
// 双隔离——config 与验收面绝不触生产）。每段独立 mgr+DATA+ORG，零状态串扰。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx tests/test-pm-duty-product.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { PLUGIN_CFG_KEYS, pluginConfigPath, readPluginConfig } from "../src/plugin-config.js";
import { evaluateDutyPolicy } from "../src/leader-duty.js";
import { loadBoard, setGroupDutyPolicy, setLightConfirmTrusted, upsertBoardEntry } from "../src/projects.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks; engine?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { engine?: string }): AgentLike => {
    void cwd;
    void model;
    created.push({ prompt, cb, ...(opts?.engine ? { engine: opts.engine } : {}) });
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

function readNdjson<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

function send(mgr: SessionManager, command_id: string, type: string, payload: Record<string, unknown>, by: string) {
  const cmd = { command_id, type, payload } as unknown as Command;
  return mgr.handleCommand(cmd, by);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 每段独立 fixture。返回 mgr/created/审计读取器/组 id/造卡器/Leader 引导器。
let seq = 0;
function mkFixture(dirs: string[]) {
  const DATA = mkdtempSync(join(tmpdir(), `ccr-p71-data-${++seq}-`));
  const ORG = mkdtempSync(join(tmpdir(), `ccr-p71-org-${seq}-`));
  const ANCHOR = mkdtempSync(join(tmpdir(), `ccr-p71-anchor-${seq}-`));
  const ART = mkdtempSync(join(tmpdir(), `ccr-p71-art-${seq}-`));
  dirs.push(DATA, ORG, ANCHOR, ART);
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  const prevArt = process.env.CCR_ARTIFACTS_DIR;
  process.env.CCR_STORAGE_READ_MODE = "json"; // 显式钉档（SQLITE-FLIP 后缺省=sqlite，fixture 是 json 形态——缺省读空库；75-R 回归发现的漏网连带面）
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_ARTIFACTS_DIR = ART; // 回执根钉沙盒（W-CARDLIFE 回执路径=artifactsDir() 单源，绝不触生产 ~/.cc-deck/artifacts）
  setLightConfirmTrusted(true); // 轻立项信任直通：create 即 active（板可写，M13-2 探针同缝）
  const cfg: RelayConfig = {
    port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null, accountToken: "",
  };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  const created: SpawnRec[] = [];
  mgr.setAgentFactory(makeFakeFactory(created));
  const rounds = () => readNdjson<Record<string, unknown>>(join(DATA, "duty-rounds.ndjson"));
  const ack = send(mgr, `p71g${seq}`, "COMMAND_ORG_ACTION", { action: "create", name: `值守产品组${seq}`, anchor_dir: ANCHOR, tier: "轻立项" }, "web-1");
  const gid = (ack.data as { group?: { id: string } } | undefined)?.group?.id ?? "";
  const card = (text: string): string => {
    const a = send(mgr, `p71c${seq}-${randomUUID().slice(0, 6)}`, "COMMAND_TASK_CREATE", { gid, text }, "web-1");
    return (a.data as { entity_id?: string }).entity_id ?? "";
  };
  const dispatch = (prompt: string, opts?: { receiptSlug?: string }): { workerIdx: number; dispatchId: string; receiptPath?: string } => {
    const workerIdx = created.length;
    // receiptSlug：任务书带约定回执路径（~/.cc-deck/artifacts/w-*.md）——dispatchWorker
    // 从 prompt 提取→收口按路径核对（W-CARDLIFE-R3 资格位链：尾行合规才翻 submitted）
    const full = opts?.receiptSlug ? `${prompt}（回执写 ~/.cc-deck/artifacts/${opts.receiptSlug}）` : prompt;
    const a = send(mgr, `p71w${seq}-${randomUUID().slice(0, 6)}`, "COMMAND_DISPATCH", { gid, prompt: full }, "web-1");
    return { workerIdx, dispatchId: (a.data as { dispatch_id?: string }).dispatch_id ?? "", ...(opts?.receiptSlug ? { receiptPath: join(ART, opts.receiptSlug) } : {}) };
  };
  // 回执文件落沙盒 ART（尾行军规行「结果：…｜改动文件：…」合规——receiptTailLineOk 行锚）
  const artifact = (slug: string): string => {
    const p = join(ART, slug);
    writeFileSync(p, "# 回执\n过程略\n结果：交付完毕｜改动文件：src/a.ts\n", "utf-8");
    return p;
  };
  // 无派单裸 worker（feedPM worker_done 边的零 closeout 形态——P7 WORKING 合并门用）
  const spawnWorker = (prompt: string): number => {
    const idx = created.length;
    (mgr as unknown as { create(cwd: string, prompt: string): string }).create(ANCHOR, prompt);
    return idx;
  };
  const ensureLeaderIdx = (): number => {
    const base = created.length;
    const r = mgr.ensureLeader();
    if (!r.ok) throw new Error("ensureLeader 失败");
    created[created.length - 1]?.cb.onInit(`sdk-p71-${seq}-boot`, "test-model");
    return base;
  };
  return { mgr, created, rounds, gid, card, dispatch, artifact, spawnWorker, data: DATA, ensureLeaderIdx, cleanup: () => {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
    if (prevArt === undefined) delete process.env.CCR_ARTIFACTS_DIR; else process.env.CCR_ARTIFACTS_DIR = prevArt;
  } };
}

// [W-DUTYBACKOFF] 刀1 让位后的确定性缝：把 events.ndjson 里该会话的真实 user_message
// 帧回拨出活跃窗（缺省 10min）——等效时间快进，门逻辑照真跑（数据面/判定序零改动）。
function coolUserMessages(dataDir: string, sid: string): void {
  const p = join(dataDir, "events.ndjson");
  const now = Date.now();
  const lines = readFileSync(p, "utf-8").split("\n").filter((l) => l.trim());
  const out = lines.map((l) => {
    try {
      const e = JSON.parse(l) as { type?: string; session_id?: string; ts?: number; payload?: { kind?: string } };
      if (e.type === "SESSION_LOG" && e.session_id === sid && e.payload?.kind === "user_message" && typeof e.ts === "number") {
        return JSON.stringify({ ...e, ts: now - 11 * 60_000 });
      }
    } catch { /* 坏行原样保留 */ }
    return l;
  });
  writeFileSync(p, out.join("\n") + "\n", "utf-8");
}

const prevEnv = ["CCR_PM_DUTY", "CCR_PM_DUTY_STALE_MS", "CCR_PM_DUTY_CONTINUATION_MS", "CCR_ACCEPTANCE_DIR", "CCR_CONFIG_FILE", "CCR_ORG_DIR", "CCR_NO_TITLE_GEN", "CCR_ARTIFACTS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of prevEnv) saved[k] = process.env[k];

try {
  // 值守开+测试缝（stale 零阈值/退避 30ms）+验收面/配置面双隔离（绝不触生产）
  process.env.CCR_PM_DUTY = "1";
  process.env.CCR_PM_DUTY_STALE_MS = "0";
  process.env.CCR_PM_DUTY_CONTINUATION_MS = "30";
  process.env.CCR_NO_TITLE_GEN = "1"; // 标题生成子会话不入 created（索引断言不被打乱，C12 同缝）
  process.env.CCR_ACCEPTANCE_DIR = mkdtempSync(join(tmpdir(), "ccr-p71-acc-"));
  const CFG = mkdtempSync(join(tmpdir(), "ccr-p71-cfg-"));
  process.env.CCR_CONFIG_FILE = join(CFG, "config.json");
  const dirs: string[] = [CFG, process.env.CCR_ACCEPTANCE_DIR];

  // ---------- P0 配置面静态断言 ----------
  console.log("P0 配置面（plugin-config 独立件）");
  assert(PLUGIN_CFG_KEYS.length === 11 && (PLUGIN_CFG_KEYS as readonly string[]).includes("duty") && (PLUGIN_CFG_KEYS as readonly string[]).includes("workerPlugins") && (PLUGIN_CFG_KEYS as readonly string[]).includes("patrol") && (PLUGIN_CFG_KEYS as readonly string[]).includes("dispatchIdempotency"),
    "P0① PLUGIN_CFG_KEYS 十一键含 duty（019 第五键；W-CTXFIX 第六键；W-EXPP1 第七键；W-RULES1 第八键 rules；W-KWP2 第九键 workerPlugins；巡检批第十键 patrol；domstep1 第十一键 dispatchIdempotency）");
  const dflt = readPluginConfig();
  assert(dflt.duty === true && dflt.taskGuard === false && dflt.qNotify === true && dflt.restorePoint === false && dflt.deliverables === true,
    "P0② 缺省值五键齐+duty 缺省 true（kill-switch 语义：显式 false 才关）");
  assert(dflt.preCompactSummary === true && dflt.experience === true,
    "P0②c preCompactSummary/experience 缺省 true（W-CTXFIX/W-EXPP1：默认开启、设置域可关）");
  assert(dflt.preCompactSummary === true, "P0②b preCompactSummary 缺省 true（W-CTXFIX：默认开启、设置域可关）");
  assert(pluginConfigPath() === process.env.CCR_CONFIG_FILE,
    "P0③ CCR_CONFIG_FILE override 生效（配置读写全落测试 tmp，零生产触达）");
  writeFileSync(pluginConfigPath(), JSON.stringify({ duty: false, unknown_key: 1 }) + "\n");
  assert(readPluginConfig().duty === false,
    "P0④ config duty=false 读回 false（未知键前向兼容不扰）");
  assert(evaluateDutyPolicy({ kind: "todo", id: "x" }).auto_dispatch_enabled === true, // DutyCandidateKind 值守词表（receipt/dispatch/todo/stale_doing）——非板态词表，D18 不动
    "P0⑤ evaluateDutyPolicy 缺省 auto_dispatch_enabled=true（019 §6.3 拍板默认值）");
  rmSync(pluginConfigPath()); // 回到「无 config 文件」基线（P1 起按缺省开跑）

  // ---------- P1 缺省开门：config 无键=值守照常 ----------
  console.log("P1 缺省开门");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      const cardId = f.card("缺省开门候选卡");
      const base = f.created.length;
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1);
      const prompt = String(f.created[base]?.prompt ?? "");
      assert(prompt.includes("[值守喂活]") && prompt.includes(cardId.slice(0, 12)),
        "P1① config 无 duty 键=缺省开：回合终态照常注入值守活（候选锚卡 id，prompt 内 12 位截断口径）");
      assert(prompt.includes("实现类需求请派发 worker 处理，勿自行编码。"),
        "P1①' #108 值守 prompt 恒定尾注在场（PM 不编码——无论候选如何每轮必带）");
      const last = f.rounds()[f.rounds().length - 1] ?? {};
      assert(last.result === "continue" && JSON.stringify(last.trigger) === JSON.stringify(["turn_end"]),
        "P1② 审计 continue 行（trigger=turn_end）");
      f.created[base]?.cb.onInit("sdk-p1-duty", "test-model"); // 清值守流 init timer
    } finally { f.cleanup(); }
  }

  // ---------- P2 worker done 边唤醒主链（依赖解锁→立即喂活） ----------
  console.log("P2 worker done 唤醒");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      const idA = f.card("依赖前置卡（派单承接）");
      const bUp = upsertBoardEntry(f.gid, { text: "依赖解锁卡（B 等 A）", status: "backlog", depends_on: [idA] });
      const idB = bUp.ok ? bUp.entry.id : "";
      assert(idA !== "" && idB !== "", "P2⓪ 依赖对落卡（A 派单承接/B depends_on[A]）");
      // 先派单承接 A（带任务书回执路径+回执文件先落——W-CARDLIFE-R3 资格位链：
      // 尾行军规行合规才翻 submitted；A=doing 非候选、B 依赖未解锁非候选）
      const w = f.dispatch("干 A 卡的单", { receiptSlug: "w-p71a.md" });
      f.artifact("w-p71a.md");
      upsertBoardEntry(f.gid, { id: idA, text: "依赖前置卡（派单承接）", status: "claimed", dispatch_id: w.dispatchId });
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1);
      assert((f.rounds()[f.rounds().length - 1] ?? {}).reason === "blocked",
        "P2⓪b boot 收口：A 在跑 B 等依赖（blocked 判定序先于 all_running，leader-duty :169）→sleep 清链+Leader 归 DONE 态");
      const before = f.created.length;
      const roundsBefore = f.rounds().length;
      // worker 交付：stats 非零（S1 零产出闸放行）→done 收口→A 翻 submitted→回执直达 PM
      f.created[w.workerIdx]?.cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 });
      f.created[w.workerIdx]?.cb.onTurnEnd(true, "结果：A 卡交付完毕", 50);
      const cbPrompt = String(f.created[before]?.prompt ?? "");
      assert(cbPrompt.includes("[worker 已交付]") && cbPrompt.includes(w.dispatchId.slice(0, 8)),
        "P2① worker done 即唤醒：回执直达注入 PM（W-DELIVERCB 收件箱直达——交付收口直达，不等值守巡检）");
      const boardA = loadBoard(f.gid).entries.find((e) => e.id === idA);
      assert(boardA?.status === "submitted" && boardA?.review_required === true,
        `P2①' A 翻 submitted 审查中（boardlife 交付=完成候选；实 ${boardA?.status}/${JSON.stringify(boardA?.review_required)}——回执尾行合规资格位链在）`);
      const last = f.rounds()[f.rounds().length - 1] ?? {};
      assert(f.rounds().length === roundsBefore + 1 && JSON.stringify(last.trigger) === JSON.stringify(["worker_done"])
        && last.result === "sleep" && last.reason === "user_active",
        "P2② 值守让位审计：worker_done 边 sleep user_active（W-DUTYBACKOFF 刀1——回执回显=真实用户消息入活跃窗，值守不叠轰炸；到期补发 timer 承接）");
      f.created[before]?.cb.onInit("sdk-p2-cb", "test-model"); // 交付回合 init（清值守流 init timer）
      // 收割（submitted→done 过审）→B 依赖解锁；冷却活跃窗（fixture 时间快进缝——
      // 回执回显出窗）→事件边兜底重算→B 候选照常注入（事件不丢）
      send(f.mgr, "p2hv", "COMMAND_TASK_UPDATE", { gid: f.gid, entry_id: idA, status: "done" }, "web-1");
      coolUserMessages(f.data, f.mgr.getLeaderSessionId() ?? "");
      const base = f.created.length;
      f.created[before]?.cb.onTurnEnd(true, "收割核验收口", 1);
      const dutyPrompt = f.created.slice(base).map((r) => String(r.prompt ?? "")).find((p) => p.includes("[值守喂活]")) ?? "";
      assert(dutyPrompt.includes(idB.slice(0, 12)),
        "P2③ 活跃窗外兜底重算：B 解锁成候选照常注入（019 §3.1 事件驱动在——收割后同一次重算覆盖）");
      f.created[f.created.length - 1]?.cb.onInit("sdk-p2-duty", "test-model"); // 清值守流 init timer
    } finally { f.cleanup(); }
  }

  // ---------- P2b failed 边即刻零值守（回执注入承接，防双挂） ----------
  console.log("P2b failed 边零值守");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1); // empty sleep 清链
      const bootDutyIdx = f.created.length - 1;
      const bootPrompt = String(f.created[bootDutyIdx]?.prompt ?? "");
      if (bootPrompt.includes("[值守喂活]")) f.created[bootDutyIdx]?.cb.onInit("sdk-p2b-pre", "test-model");
      const w = f.dispatch("会失败的单");
      const roundsBefore = f.rounds().length;
      f.created[w.workerIdx]?.cb.onTurnEnd(false, "worker 撞墙", 50);
      const newPrompts = f.created.slice(w.workerIdx + 1).map((r) => String(r.prompt ?? ""));
      assert(newPrompts.length >= 1 && newPrompts.every((p) => !p.includes("[值守喂活]")) && newPrompts.some((p) => p.includes("派单失败回执")),
        "P2b① failed 边零值守注入：仅既有回执注入面（双挂防重复轰炸备案维持）");
      assert(f.rounds().length === roundsBefore,
        "P2b② failed 边零值守审计（feedPM 未被触发）");
      const receiptIdx = f.created.length - 1;
      f.created[receiptIdx]?.cb.onInit("sdk-p2b-receipt", "test-model"); // 清回执流 init timer（不收口不续链）
    } finally { f.cleanup(); }
  }

  // ---------- P3/P4 三态：blocked（gate 卡）/all_running（健康在跑不催） ----------
  console.log("P3/P4 blocked 与 all_running");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      upsertBoardEntry(f.gid, { text: "等人放行的卡", status: "backlog", gate: { reason: "外部等待" } });
      const base = f.created.length;
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1);
      let last = f.rounds()[f.rounds().length - 1] ?? {};
      assert(f.created.length === base && last.result === "sleep" && last.reason === "blocked",
        "P3 blocked 态：gate 卡=等外部→sleep 零注入（candidates 空但 blocked 非空，019 §2.2 非行动位）");
      // 清 gate 卡（搬 done）+派 worker 健康在跑→all_running
      const board = loadBoard(f.gid);
      const gateEntry = board.entries.find((e) => e.gate);
      send(f.mgr, "p3clr", "COMMAND_TASK_UPDATE", { gid: f.gid, entry_id: gateEntry?.id ?? "", status: "done" }, "web-1");
      const w = f.dispatch("健康在跑的单");
      void w;
      f.created[bootIdx]?.cb.onTurnEnd(true, "值守收口", 1);
      last = f.rounds()[f.rounds().length - 1] ?? {};
      assert(last.result === "sleep" && last.reason === "all_running",
        "P4 all_running 态：worker 健康 WORKING→sleep 零注入（019 §2.2 全 running 反例——防 token 忙等）");
    } finally { f.cleanup(); }
  }

  // ---------- P5 无进展退避（W-DUTYBACKOFF 刀2）+top 变化复位+循环终止 ----------
  // 现行语义：同 top 候选连喂=队列无人消费——第 2 轮起 sleep no_progress_backoff
  //（5→15→30→60min 级数表，分钟级真实退避）。级数表数值与到期补发 timer 真跑由
  // test-dutybackoff B/R2 组专锁；此处锁产品链形态：首轮注入→同 top 退避（零注入+
  // wake_once 续办在案）→top 变化复位→候选消化终静默（idle 归零不再排 timer）。
  console.log("P5 无进展退避");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      const idC1 = f.card("退避链燃料卡一");
      let leaderCb = f.created[bootIdx]?.cb;
      const base1 = f.created.length;
      leaderCb?.onTurnEnd(true, "值守轮1", 1);
      const p1 = String(f.created[base1]?.prompt ?? "");
      assert(p1.includes("[值守喂活]") && p1.includes(idC1.slice(0, 12)),
        "P5① 首轮 feed 注入（top 卡 id 入 prompt——chain 起 1）");
      f.created[base1]?.cb.onInit("sdk-p5-v1", "test-model");
      leaderCb = f.created[base1]?.cb;
      const r1 = f.rounds()[f.rounds().length - 1] ?? {};
      assert(r1.result === "continue", "P5①' 首轮审计 continue（注入成功记账）");
      // 同 top 第 2 轮：无进展退避——零注入+wake_once 续办在案（级数 1=5min）
      const lenAt2 = f.created.length;
      leaderCb?.onTurnEnd(true, "值守轮2", 1);
      const r2 = f.rounds()[f.rounds().length - 1] ?? {};
      assert(f.created.length === lenAt2 && r2.result === "sleep" && r2.reason === "no_progress_backoff",
        "P5② 同 top 第 2 轮：sleep no_progress_backoff 零注入（队列无人消费不空转——刀2）");
      const cont = r2.continuation as { delay_ms?: number; once?: boolean } | undefined;
      assert(cont?.delay_ms === 5 * 60_000 && cont?.once === true,
        "P5③ continuation 在案（级数 1=5min/wake_once——R1 饱和环联动退避级数表）");
      // top 变化复位：燃料卡一收割 done+新卡入列→新 top≠lastTop→streak/退避窗清零→照常注入
      send(f.mgr, "p5c1", "COMMAND_TASK_UPDATE", { gid: f.gid, entry_id: idC1, status: "done" }, "web-1");
      const idC2 = f.card("退避链燃料卡二");
      const base3 = f.created.length;
      leaderCb?.onTurnEnd(true, "值守轮3", 1);
      const p3 = String(f.created[base3]?.prompt ?? "");
      assert(p3.includes("[值守喂活]") && p3.includes(idC2.slice(0, 12)),
        "P5④ top 变化复位退避：新 top 照常注入（streak/窗清零——刀2 复位条款）");
      f.created[base3]?.cb.onInit("sdk-p5-v3", "test-model");
      leaderCb = f.created[base3]?.cb;
      // 候选消化→idle 归零→循环终止面（sleep empty 零注入，链清零不再排续办 timer）
      send(f.mgr, "p5c2", "COMMAND_TASK_UPDATE", { gid: f.gid, entry_id: idC2, status: "done" }, "web-1");
      const lenAt5 = f.created.length;
      leaderCb?.onTurnEnd(true, "值守轮4", 1);
      const r5 = f.rounds()[f.rounds().length - 1] ?? {};
      assert(f.created.length === lenAt5 && r5.result === "sleep" && r5.reason === "empty",
        "P5⑤ 候选消化后循环终止：sleep empty 零注入（chain idle 归零，无活可干即静默）");
    } finally { f.cleanup(); }
  }

  // ---------- P6 全局总闸：duty=false→disabled 审计零注入 ----------
  console.log("P6 全局总闸");
  {
    writeFileSync(pluginConfigPath(), JSON.stringify({ duty: false }) + "\n");
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      f.card("总闸关闭时的卡");
      const base = f.created.length;
      const roundsBefore = f.rounds().length;
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1);
      const last = f.rounds()[f.rounds().length - 1] ?? {};
      assert(f.created.length === base && f.rounds().length === roundsBefore + 1,
        "P6① 总闸关：零注入+一行审计（不静默黑盒——019 §6.1 disabled 记账）");
      assert(last.result === "disabled" && last.reason === "global_switch",
        "P6② disabled 审计行（result=disabled/reason=global_switch，kill-switch 可对账）");
    } finally { f.cleanup(); }
    rmSync(pluginConfigPath()); // 恢复无 config 基线
  }

  // ---------- P7 WORKING 合并门：Leader 在岗不追加回合，事件不丢 ----------
  // 现行语义：worker done 边的「回执直达」走 resumeAgent 换流（W-DELIVERCB 交付回调
  // 优先，P2① 已锁）；值守 patrol 对 WORKING 目标仍零注入零审计（feedPM WORKING 门
  // 在 user_active 门之后的静默 return）——用无派单裸 worker 回合触发 worker_done 边
  // （零 closeout 零回执注入，活跃窗不介入）锁 WORKING 门本体。
  console.log("P7 WORKING 合并门");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx(); // Leader spawn 在途=WORKING（不收口）
      const idB = f.card("P7 待办卡（WORKING 期间积压）");
      const wk = f.spawnWorker("P7 裸 worker（零派单对照）");
      const before = f.created.length;
      const roundsBefore = f.rounds().length;
      f.created[wk]?.cb.onTurnEnd(true, "干完了", 1); // worker done（零派单）→feedPM→Leader WORKING→合并门静默
      assert(f.created.length === before && f.rounds().length === roundsBefore,
        "P7① Leader WORKING：worker done 零注入零审计（resumeAgent 不换流打断在途回合）");
      // Leader 收口→turn_end 兜底重算→积压候选照收（合并语义=不丢事件）
      const base = f.created.length;
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot 收口", 1);
      const prompt = String(f.created[base]?.prompt ?? "");
      assert(prompt.includes("[值守喂活]") && prompt.includes(idB.slice(0, 12)),
        "P7② 收口兜底重算：WORKING 期间积压候选在回合终态照常注入（事件不丢）");
      f.created[base]?.cb.onInit("sdk-p7-duty", "test-model");
    } finally { f.cleanup(); }
  }

  // ---------- P8 组级门控：enabled=false 该组零候选、清除回开 ----------
  console.log("P8 组级门控");
  {
    const f = mkFixture(dirs);
    try {
      const anchorB = mkdtempSync(join(tmpdir(), "ccr-p71-anchorB-"));
      dirs.push(anchorB);
      const ga = send(f.mgr, "p8ga", "COMMAND_ORG_ACTION", { action: "create", name: "关值守组", anchor_dir: anchorB, tier: "轻立项" }, "web-1");
      const gidA = (ga.data as { group?: { id: string } } | undefined)?.group?.id ?? "";
      assert(gidA !== "", "P8⓪ 第二组建组（独立 anchor 目录）");
      const policyR = setGroupDutyPolicy(gidA, { enabled: false });
      assert(policyR.ok, "P8① setGroupDutyPolicy 落组级策略（enabled=false）");
      const gaCard = send(f.mgr, "p8gac", "COMMAND_TASK_CREATE", { gid: gidA, text: "关组里的卡（不该进候选）" }, "web-1");
      const gaCardId = (gaCard.data as { entity_id?: string }).entity_id ?? "";
      const gbCardId = f.card("开组里的卡（该进候选）");
      const bootIdx = f.ensureLeaderIdx();
      const base = f.created.length;
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1);
      const prompt = String(f.created[base]?.prompt ?? "");
      assert(prompt.includes("[值守喂活]") && prompt.includes(gbCardId.slice(0, 12)) && !prompt.includes(gaCardId.slice(0, 12)),
        "P8② 组级关：关组卡零候选、开组照常（两级同开才生效之组级半边，019 §6.1）");
      f.created[base]?.cb.onInit("sdk-p8-v1", "test-model");
      // 清除策略→回缺省开→下轮候选含关组卡（top 变化复位无进展窗：P8② 注入后同 top
      // 连喂会被 W-DUTYBACKOFF 刀2 退避拦——先把开组卡收割 done 换 top，复位后照常注入）
      setGroupDutyPolicy(gidA, undefined);
      send(f.mgr, "p8clr", "COMMAND_TASK_UPDATE", { gid: f.gid, entry_id: gbCardId, status: "done" }, "web-1");
      const base2 = f.created.length;
      f.created[base]?.cb.onTurnEnd(true, "值守收口", 1);
      const prompt2 = String(f.created[base2]?.prompt ?? "");
      assert(prompt2.includes("[值守喂活]") && prompt2.includes(gaCardId.slice(0, 12)),
        "P8③ 清除策略回缺省开：关组卡进候选（policy=undefined 清除语义，019 §6.3 不迁移覆盖）");
      f.created[base2]?.cb.onInit("sdk-p8-v2", "test-model");
    } finally { f.cleanup(); }
  }

  // ---------- P9 W-INJFIX：值守 prompt 可再生——注入失败（init 超时 fresh 回退）不重放 ----------
  // 1014 注入刷屏根修：值守喂活 prompt 每轮 duty 重推导队列重新生成，是可再生消息——
  // 注入失败应直接放弃，不进 unacked 重放账（fresh 回退/看门狗接管/冷却补投全部跳过），
  // 不与用户消息争补偿链。对照组：同窗内用户消息必须照常重放（renewable 不殃及）。
  console.log("P9 值守 prompt 可再生（W-INJFIX）");
  {
    process.env.CCR_RESUME_INIT_MS = "150"; // init 看门狗 150ms（合法下限 100，test-resume-breaker 同缝）
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      f.card("P9 可再生验证候选卡");
      const base = f.created.length;
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1); // feedPM → resumeAgent（值守 prompt）
      const dutyPrompt = String(f.created[base]?.prompt ?? "");
      assert(dutyPrompt.includes("[值守喂活]"), "P9① 值守注入发生（prompt 含 [值守喂活]， renewable 标记路径）");
      const leaderId = f.mgr.getLeaderSessionId() ?? "";
      assert(leaderId !== "", "P9⓪ Leader 在档");
      // 值守流 spawn 后（互斥窗/活流均可）立即发一条用户消息：活流 sendMessage 同步
      // no-op（fake 无回显无 ackId）→ 留在 unacked（ts ≥ resumeStart）
      send(f.mgr, "p9msg", "COMMAND_MESSAGE", { session_id: leaderId, text: "P9 用户插话（不可再生）" }, "web-1");
      // 不调 onInit：150ms 后 init 看门狗触发 fresh 分支（Leader 无记忆 → fresh 重放）
      await sleep(600);
      const freshPrompt = String(f.created[f.created.length - 1]?.prompt ?? "");
      assert(freshPrompt.includes("P9 用户插话（不可再生）"), "P9② fresh 重放保留用户消息（renewable 语义不殃及普通消息）");
      assert(!freshPrompt.includes("[值守喂活]"), "P9③ 值守 prompt 不重放（可再生：失败即丢，下一轮 duty 重推导注入新 prompt）");
      const managed = (f.mgr as unknown as { sessions: Map<string, { unacked: unknown[] }> }).sessions.get(leaderId);
      assert(!!managed && managed.unacked.length === 0, "P9④ unacked 零滞留（renewable 条目丢弃、用户消息已并入 fresh 重放出账）");
    } finally {
      f.cleanup();
      delete process.env.CCR_RESUME_INIT_MS;
    }
  }

  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  console.log(`P71 duty product: ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
  process.exit(0);
} finally {
  for (const k of prevEnv) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
