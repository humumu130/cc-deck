// ---------- P71 值守产品化一期测试（019 §6 产品面接线） ----------
// 覆盖：P0 配置面静态断言（五键/duty 缺省 true/CCR_CONFIG_FILE override）；
//       P1 缺省开门（config 无键=值守照常，产品缺省开回归面）；
//       P2 worker done 边唤醒主链（019 §3.1：交付收口→依赖解锁→立即喂活，杜绝
//          「worker 干完、Leader 休眠、回单无人验收」空转窗）；
//       P2b failed 边即刻零值守（notifyDispatchClosed 回执注入承接防双挂备案）；
//       P3/P4 三态之 blocked（gate 卡）/all_running（健康在跑不催）；
//       P5 K=3 continuation 延迟喂活真跑+候选消化后循环终止（019 §3.4）；
//       P6 全局总闸 duty=false→disabled 审计零注入（019 §6.1「值守审计仍记录
//          disabled」+kill-switch）；
//       P7 WORKING 合并门（019 §3.3「PM WORKING 时合并 feed 上下文而不追加回合」
//          最小落地：不换流打断在途回合，事件不丢——收口 turn_end 兜底重算）；
//       P8 组级门控 duty_policy.enabled=false 该组零候选、清除回开（两级同开才生效
//          之组级半边，019 §6.3「已有显式 false 的组不被迁移覆盖」）。
// fixture 缝仿 test-m12-commands C12 段（mkdtemp+CCR_ORG_DIR/CCR_DATA_DIR 注入+
// fake agent factory+send 直调 handleCommand；CCR_CONFIG_FILE/CCR_ACCEPTANCE_DIR
// 双隔离——config 与验收面绝不触生产）。每段独立 mgr+DATA+ORG，零状态串扰。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-pm-duty-product.ts
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
  dirs.push(DATA, ORG, ANCHOR);
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  process.env.CCR_STORAGE_READ_MODE = "json"; // 显式钉档（SQLITE-FLIP 后缺省=sqlite，fixture 是 json 形态——缺省读空库；75-R 回归发现的漏网连带面）
  process.env.CCR_ORG_DIR = ORG;
  setLightConfirmTrusted(true); // 轻立项信任直通：create 即 active（板可写，M13-2 探针同缝）
  const cfg: RelayConfig = {
    port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
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
  const dispatch = (prompt: string): { workerIdx: number; dispatchId: string } => {
    const workerIdx = created.length;
    const a = send(mgr, `p71w${seq}-${randomUUID().slice(0, 6)}`, "COMMAND_DISPATCH", { gid, prompt }, "web-1");
    return { workerIdx, dispatchId: (a.data as { dispatch_id?: string }).dispatch_id ?? "" };
  };
  const ensureLeaderIdx = (): number => {
    const base = created.length;
    const r = mgr.ensureLeader();
    if (!r.ok) throw new Error("ensureLeader 失败");
    created[created.length - 1]?.cb.onInit(`sdk-p71-${seq}-boot`, "test-model");
    return base;
  };
  return { mgr, created, rounds, gid, card, dispatch, ensureLeaderIdx, cleanup: () => {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
  } };
}

const prevEnv = ["CCR_PM_DUTY", "CCR_PM_DUTY_STALE_MS", "CCR_PM_DUTY_CONTINUATION_MS", "CCR_ACCEPTANCE_DIR", "CCR_CONFIG_FILE", "CCR_ORG_DIR", "CCR_NO_TITLE_GEN"] as const;
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
  assert(PLUGIN_CFG_KEYS.length === 6 && (PLUGIN_CFG_KEYS as readonly string[]).includes("duty"),
    "P0① PLUGIN_CFG_KEYS 六键含 duty（019 §6.2 第五键；W-CTXFIX 第六键 preCompactSummary）");
  const dflt = readPluginConfig();
  assert(dflt.duty === true && dflt.taskGuard === false && dflt.qNotify === true && dflt.restorePoint === false && dflt.deliverables === true,
    "P0② 缺省值五键齐+duty 缺省 true（kill-switch 语义：显式 false 才关）");
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
      // 先派单承接 A（A=doing 非候选、B 依赖未解锁非候选）→boot 收口时 all_running
      // sleep 清链+Leader 置 DONE（worker done 边过 WORKING 门的前提）
      const w = f.dispatch("干 A 卡的单");
      upsertBoardEntry(f.gid, { id: idA, text: "依赖前置卡（派单承接）", status: "claimed", dispatch_id: w.dispatchId });
      f.created[bootIdx]?.cb.onTurnEnd(true, "boot", 1);
      assert((f.rounds()[f.rounds().length - 1] ?? {}).reason === "blocked",
        "P2⓪b boot 收口：A 在跑 B 等依赖（blocked 判定序先于 all_running，leader-duty :169）→sleep 清链+Leader 归 DONE 态");
      const before = f.created.length;
      const roundsBefore = f.rounds().length;
      // worker 交付：A 搬 done→B 依赖解锁→feedPM("worker_done") 立即注入（不等 Leader 回合）
      f.created[w.workerIdx]?.cb.onTurnEnd(true, "干完了", 50);
      const dutyPrompt = String(f.created[before]?.prompt ?? "");
      assert(dutyPrompt.includes("[值守喂活]") && dutyPrompt.includes(idB.slice(0, 12)),
        "P2① worker done 即唤醒：交付收口→A 搬 done→B 解锁成候选→值守注入（019 §3.1 事件驱动）");
      const last = f.rounds()[f.rounds().length - 1] ?? {};
      assert(f.rounds().length === roundsBefore + 1 && JSON.stringify(last.trigger) === JSON.stringify(["worker_done"]),
        "P2② 审计 worker_done 行（一交付一检查，trigger=worker_done）");
      f.created[before]?.cb.onInit("sdk-p2-duty", "test-model"); // 清值守流 init timer
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

  // ---------- P5 K=3 continuation 延迟喂活真跑+候选消化后循环终止 ----------
  console.log("P5 continuation 退避");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx();
      f.card("常驻候选卡（K=3 链燃料）");
      // 连续三轮值守回合（每轮注入→新值守流收口=下一轮检查）
      let leaderCb = f.created[bootIdx]?.cb;
      for (let i = 1; i <= 2; i++) {
        const base = f.created.length;
        leaderCb?.onTurnEnd(true, `值守轮${i}`, 1);
        const p = String(f.created[base]?.prompt ?? "");
        assert(p.includes("[值守喂活]"), `P5① 第 ${i} 轮 feed 注入（chain=${i}）`);
        f.created[base]?.cb.onInit(`sdk-p5-v${i}`, "test-model");
        leaderCb = f.created[base]?.cb;
      }
      const base3 = f.created.length;
      leaderCb?.onTurnEnd(true, "值守轮3", 1);
      let r = f.rounds();
      const r3 = r[r.length - 1] ?? {};
      assert(f.created.length === base3 && r3.result === "sleep" && r3.reason === "k_exhausted",
        "P5② K=3 触顶：第 3 轮 sleep 零注入（防 token 忙等，019 §3.4）");
      const cont = r3.continuation as { delay_ms?: number; once?: boolean } | undefined;
      assert(cont?.delay_ms === 30 && cont?.once === true,
        "P5③ continuation 在案（delay=30ms env 测试缝/wake_once）");
      // 延迟喂活真跑：30ms 后 setTimeout 自动 feedPM——候选仍在→再次 sleep k_exhausted（新行）
      const countAtR3 = f.rounds().length;
      const deadline = Date.now() + 2000;
      while (f.rounds().length < countAtR3 + 1 && Date.now() < deadline) await sleep(20);
      r = f.rounds();
      assert(r.length > countAtR3, "P5④ 延迟喂活真跑（审计新增行——setTimeout 自动 feedPM）");
      const r4 = r[r.length - 1] ?? {};
      assert(r4.result === "sleep" && r4.reason === "k_exhausted",
        "P5⑤ continuation 触发的检查行（候选未消化→继续退避，非永久静默）");
      // 候选消化→链归零→循环终止
      const board = loadBoard(f.gid);
      const fuel = board.entries.find((e) => e.status === "backlog");
      send(f.mgr, "p5clr", "COMMAND_TASK_UPDATE", { gid: f.gid, entry_id: fuel?.id ?? "", status: "done" }, "web-1");
      await sleep(80); // 消化在途 setTimeout 一发（sleep empty 归零后不再排新 timer）
      const n1 = f.rounds().length;
      await sleep(200);
      const n2 = f.rounds().length;
      assert(n1 === n2, `P5⑥ 候选消化后循环终止（80ms 定格 ${n1} 行，200ms 后仍 ${n2} 行——idle 归零不再排 timer）`);
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
  console.log("P7 WORKING 合并门");
  {
    const f = mkFixture(dirs);
    try {
      const bootIdx = f.ensureLeaderIdx(); // Leader spawn 在途=WORKING（不收口）
      const idA = f.card("P7 前置卡");
      const bUp = upsertBoardEntry(f.gid, { text: "P7 解锁卡", status: "backlog", depends_on: [idA] });
      const idB = bUp.ok ? bUp.entry.id : "";
      const w = f.dispatch("P7 干 A");
      upsertBoardEntry(f.gid, { id: idA, text: "P7 前置卡", status: "claimed", dispatch_id: w.dispatchId });
      const before = f.created.length;
      const roundsBefore = f.rounds().length;
      f.created[w.workerIdx]?.cb.onTurnEnd(true, "干完了", 50); // worker done→Leader WORKING→合并门静默
      assert(f.created.length === before && f.rounds().length === roundsBefore,
        "P7① Leader WORKING：worker done 零注入零审计（resumeAgent 不换流打断在途回合）");
      // Leader 收口→turn_end 兜底重算→B 候选照收（合并语义=不丢事件）
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
      // 清除策略→回缺省开→下轮候选含关组卡
      setGroupDutyPolicy(gidA, undefined);
      const base2 = f.created.length;
      f.created[base]?.cb.onTurnEnd(true, "值守收口", 1);
      const prompt2 = String(f.created[base2]?.prompt ?? "");
      assert(prompt2.includes("[值守喂活]") && prompt2.includes(gaCardId.slice(0, 12)),
        "P8③ 清除策略回缺省开：关组卡进候选（policy=undefined 清除语义，019 §6.3 不迁移覆盖）");
      f.created[base2]?.cb.onInit("sdk-p8-v2", "test-model");
    } finally { f.cleanup(); }
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
