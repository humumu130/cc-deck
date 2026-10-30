// ---------- W-DUTY-CHAIN：duty 断链根修集成测试（10-28/29 断链根因回归锚） ----------
// 根因：dutyEnabled() 原 opt-in（CCR_PM_DUTY === "1" 才开）——「生产开 duty」寄存在
// 进程 env 易失介质。带 =1 的 relay 是「从 export 过该变量的 shell 启动的 Nova 壳」
// 孵化（env 继承链 shell→GUI→relay）；10-28/29 三次 relay 重启全走 launchd 冷启 Nova
// 壳（PPID=1 无用户 shell env）→ dutyEnabled 恒 false → duty-rounds.ndjson 断写
// 19.5h，且环境门关=零审计=断链不可观测。
// 根修：反转为 opt-out（=0 才关，缺省开，对齐 CCR_NO_AUTOREVIVE 逃生阀范式）。
// 覆盖：
//   R1 重启自愈（验收点2/4 核心）：模拟「重启后新进程」——env 无 CCR_PM_DUTY（=
//      launchd 冷启 relay 真实 env 态）起新 SessionManager（同 DATA 第二代）→ Leader
//      回合终态 → duty-rounds.ndjson 出现 PM_DUTY_ROUND（旧代码此场景恒零写入）；
//   R2 逃生阀：CCR_PM_DUTY=0 → 回合终态零写入（沙盒/紧急关停隔离面，旧语义保留）；
//   R3 产品门不动：plugin_config.duty=false（CCR_CONFIG_FILE 隔离）→ disabled 审计行
//      （环境门开时产品门关=有审计的关，kill-switch 语义零波及）；
//   R4 断链可观测：org status 的 pm 视图携带 duty_enabled/product_switch——环境门关
//      时 alive=false+hint（假活根修），缺省开时 duty_enabled=true。
// fixture 缝仿 test-m12-commands C12（mkdtemp+fake agent factory+send 直调）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE -u CCR_PM_DUTY npx tsx scripts/test-duty-restart-chain.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { setLightConfirmTrusted } from "../src/projects.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command } from "../src/types.js";

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

function readRounds(dir: string): Record<string, unknown>[] {
  const p = join(dir, "duty-rounds.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function send(mgr: SessionManager, command_id: string, type: string, payload: Record<string, unknown>, by: string) {
  const cmd = { command_id, type, payload } as unknown as Command;
  return mgr.handleCommand(cmd, by);
}

// 「重启后新进程」等价构造：同 DATA/ORG 起新 SessionManager 实例（relay 进程内
// SessionManager 态不跨进程存活——新实例=新进程的内存态；env 态由调用方布置）。
function bootRelayGen(dataDir: string, created: SpawnRec[]): SessionManager {
  const cfg: RelayConfig = {
    port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const bus = new EventBus({ persistPath: join(dataDir, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(makeFakeFactory(created));
  return mgr;
}

const prevDuty = process.env.CCR_PM_DUTY;
const prevOrg = process.env.CCR_ORG_DIR;
const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
const prevCfgFile = process.env.CCR_CONFIG_FILE;
delete process.env.CCR_PM_DUTY; // 全程缺省态（= launchd 冷启 relay env）——R2 段再局部布置
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_NO_TITLE_GEN = "1";

const DATA = mkdtempSync(join(tmpdir(), "ccr-data-dutychain-"));
const ORG = mkdtempSync(join(tmpdir(), "ccr-org-dutychain-"));
const anchor = mkdtempSync(join(tmpdir(), "ccr-anchor-dutychain-"));
process.env.CCR_ORG_DIR = ORG;
try {
  setLightConfirmTrusted(true);
  const mkGroupWithTodo = (mgr: SessionManager, name: string): string => {
    const ack = send(mgr, `gd-${name}`, "COMMAND_ORG_ACTION", { action: "create", name, anchor_dir: anchor, tier: "轻立项" }, "web-1");
    const gid = ((ack as { data?: { group?: { id?: string } } }).data?.group?.id) ?? "";
    if (gid) send(mgr, `tc-${name}`, "COMMAND_TASK_CREATE", { gid, text: "断链回归候选卡（解锁待办）" }, "web-1");
    return gid;
  };
  // Leader 就位 + 灌 sdkId（fake 流零 onInit→手动灌，m12 C12⓪ 同款缝）
  const armLeader = (mgr: SessionManager, created: SpawnRec[]): AgentCallbacks | undefined => {
    const ack = mgr.ensureLeader();
    if (!ack.ok) return undefined;
    const cb = created[created.length - 1]?.cb;
    cb?.onInit(`sdk-dutychain-${randomUUID().slice(0, 8)}`, "test-model");
    return cb;
  };

  // ---------- R1 重启自愈：env 无 CCR_PM_DUTY 的「新进程」回合终态写轮 ----------
  console.log("R1 重启自愈（缺省开=断链根修断言）");
  {
    const created: SpawnRec[] = [];
    const gen1 = bootRelayGen(DATA, created); // 第一代进程：有 env 时代（不布置 env，行为与布置=1 等价——根修后缺省即开）
    mkGroupWithTodo(gen1, "重启组");
    const cb1 = armLeader(gen1, created);
    assert(cb1 !== undefined, "R1⓪ 前置：第一代 Leader 就位（fake factory spawn+sdkId 灌注）");
    cb1?.onTurnEnd(true, "第一代收口", 1);
    assert(readRounds(DATA).length >= 1, "R1① 第一代在岗回合写轮（todo 候选 actionable→continue 注入）");
    if (created.length > 1) created[created.length - 1]?.cb.onInit(`sdk-duty-r1c-${randomUUID().slice(0, 6)}`, "test-model"); // 值守注入流清 init timer
    // ——模拟 relay 进程死亡重启：新 SessionManager 实例（新内存态），env 保持缺省（launchd 冷启无 CCR_PM_DUTY）——
    const roundsBeforeReboot = readRounds(DATA).length;
    const created2: SpawnRec[] = [];
    const gen2 = bootRelayGen(DATA, created2); // 第二代=重启后新进程（同 DATA：duty-rounds append-only 跨代续写）
    mkGroupWithTodo(gen2, "重启二代组");
    // 重启后 Leader 卡由 ensureLeader 从锚重建（rebuildDormant 零 spawn）——重启后真实
    // 回合由 resumeAgent 重新拉起（notifyDispatchClosed 派单失败回执注入同款产品路径）
    const ackL2 = gen2.ensureLeader();
    assert(ackL2.ok === true && created2.length === 0, "R1②⓪ 重启后 Leader 锚重建（零 spawn 合成休眠卡——重启真实形态）");
    const leaderId2 = (ackL2 as { session_id?: string }).session_id ?? "";
    // 基线债清障（1030）：resumeAgent/require 已收私有（W-SPLIT 后 mixin 域），测试直调改
    // 结构化断言访问（运行时同一方法，纯类型层）
    (gen2 as unknown as { resumeAgent: (s: unknown, t: string) => void; require: (id: string) => unknown }).resumeAgent(
      (gen2 as unknown as { require: (id: string) => unknown }).require(leaderId2), "重启后首回合指令");
    assert(created2.length === 1, "R1②⓪b resumeAgent 拉起重启后首个回合流（fake factory spawn）");
    const cb2 = created2[created2.length - 1]?.cb;
    cb2.onInit(`sdk-duty-r1re-${randomUUID().slice(0, 6)}`, "test-model"); // 灌 sdkId+清 init timer
    cb2.onTurnEnd(true, "重启后首个回合", 1);
    const afterReboot = readRounds(DATA);
    const newRounds = afterReboot.slice(roundsBeforeReboot);
    assert(newRounds.length >= 1 && newRounds.every((r) => r.kind === "PM_DUTY_ROUND"),
      "R1② 重启后 duty 轮恢复写入（env 缺席新进程回合终态照写 PM_DUTY_ROUND——10-28/29 断链形态根修断言）");
    assert(newRounds.some((r) => Array.isArray(r.trigger) && (r.trigger as string[]).includes("turn_end")),
      "R1③ 重启后新轮 trigger=turn_end（验收点2 口径：turn_end 触发）");
    if (created2.length > 1) created2[created2.length - 1]?.cb.onInit(`sdk-duty-r1d-${randomUUID().slice(0, 6)}`, "test-model");
  }

  // ---------- R2 逃生阀：CCR_PM_DUTY=0 → 零写入（沙盒/紧急关停隔离面） ----------
  console.log("R2 逃生阀（=0 才关）");
  {
    const DATA2 = mkdtempSync(join(tmpdir(), "ccr-data2-dutychain-"));
    const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org2-dutychain-"));
    process.env.CCR_ORG_DIR = ORG2;
    setLightConfirmTrusted(true);
    process.env.CCR_PM_DUTY = "0";
    const created: SpawnRec[] = [];
    const mgr = bootRelayGen(DATA2, created);
    mkGroupWithTodo(mgr, "逃生阀组");
    const cb = armLeader(mgr, created);
    cb?.onTurnEnd(true, "逃生阀下的回合", 1);
    assert(readRounds(DATA2).length === 0,
      "R2① CCR_PM_DUTY=0 → 回合终态零轮零审计（逃生阀语义=组件不存在，既有隔离行为保留）");
    // R4a 断链可观测·环境门关：org status pm 视图不假活
    const st = mgr.orgAction("status", {}) as { ok: boolean; data?: { pm?: { alive?: boolean; duty_enabled?: boolean; hint?: string } } };
    const pm = st.data?.pm;
    assert(st.ok && pm?.alive === false && pm?.duty_enabled === false && String(pm?.hint ?? "").includes("环境门"),
      "R4a org status 可观测：环境门关→alive=false+hint 指明「值守环境门关闭」（假活根修——断链 19.5h 无感的放大器）");
    delete process.env.CCR_PM_DUTY; // 还原缺省态
    process.env.CCR_ORG_DIR = ORG;
    rmSync(DATA2, { recursive: true, force: true });
    rmSync(ORG2, { recursive: true, force: true });
  }

  // ---------- R3 产品门不动：plugin_config.duty=false → disabled 审计行 ----------
  console.log("R3 产品门（kill-switch 语义零波及）");
  {
    const DATA3 = mkdtempSync(join(tmpdir(), "ccr-data3-dutychain-"));
    const ORG3 = mkdtempSync(join(tmpdir(), "ccr-org3-dutychain-"));
    const CFG3 = join(DATA3, "config.json");
    writeFileSync(CFG3, JSON.stringify({ duty: false }));
    process.env.CCR_ORG_DIR = ORG3;
    process.env.CCR_CONFIG_FILE = CFG3;
    setLightConfirmTrusted(true);
    const created: SpawnRec[] = [];
    const mgr = bootRelayGen(DATA3, created);
    mkGroupWithTodo(mgr, "产品门组");
    const cb = armLeader(mgr, created);
    cb?.onTurnEnd(true, "产品门关下的回合", 1);
    const rounds = readRounds(DATA3);
    assert(rounds.length === 1 && rounds[0].result === "disabled" && rounds[0].reason === "global_switch",
      "R3① 产品门关→disabled 审计行恰一行（reason=global_switch——用户面 kill-switch 有审计的关，语义不动）");
    const st = mgr.orgAction("status", {}) as { ok: boolean; data?: { pm?: { duty_enabled?: boolean; product_switch?: boolean; hint?: string } } };
    const pm = st.data?.pm;
    assert(st.ok && pm?.duty_enabled === false && pm?.product_switch === false && String(pm?.hint ?? "").includes("产品总闸"),
      "R4b org status 可观测：产品门关→duty_enabled=false+product_switch=false+hint 指明产品总闸");
    delete process.env.CCR_CONFIG_FILE;
    process.env.CCR_ORG_DIR = ORG;
    rmSync(DATA3, { recursive: true, force: true });
    rmSync(ORG3, { recursive: true, force: true });
  }

  // ---------- R4c 缺省开态 org status 视图 ----------
  console.log("R4c 缺省开可观测");
  {
    const created: SpawnRec[] = [];
    const mgr = bootRelayGen(DATA, created); // DATA 已有组与轮——直接复用（不建新组，零候选也可断言开关键）
    const st = mgr.orgAction("status", {}) as { ok: boolean; data?: { pm?: { duty_enabled?: boolean; product_switch?: boolean } } };
    const pm = st.data?.pm;
    assert(st.ok && pm?.duty_enabled === true && pm?.product_switch === true,
      "R4c org status 可观测：缺省态（env 未设+config 无键）→duty_enabled=true（值守链开着的可见证据）");
  }
} finally {
  if (prevDuty === undefined) delete process.env.CCR_PM_DUTY;
  else process.env.CCR_PM_DUTY = prevDuty;
  if (prevOrg === undefined) delete process.env.CCR_ORG_DIR;
  else process.env.CCR_ORG_DIR = prevOrg;
  if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
  else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
  if (prevCfgFile === undefined) delete process.env.CCR_CONFIG_FILE;
  else process.env.CCR_CONFIG_FILE = prevCfgFile;
  rmSync(DATA, { recursive: true, force: true });
  rmSync(ORG, { recursive: true, force: true });
  rmSync(anchor, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
