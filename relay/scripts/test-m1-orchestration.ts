// ---------- M12-8 编排闭环真链路测试（M1-2 收口单：一条流串起 M12-1..7 全部单写入口） ----------
// 计划表 :77：「test-m1-orchestration.ts（新）、M12 全部单写入口｜跑通新任务→派单→worker→
// 回执→验收→lesson；断线/重启后不丢；验收旧 JSON 只读截止已切换」。
// 覆盖：
//   O1 前置：轻立项组 active（M12-1 COMMAND_ORG_ACTION 入口）；
//   O2 段① 建卡编排：主卡带 depends_on → 依赖未就绪 blocked:true 零 spawn（M12-2 编排）；
//   O3 段② 依赖卡先派先收：认领派单（M12-1 入口）→ worker 回合 done → 台账 done（M12-3
//       生命周期）+ 卡自动搬 done（closeOpenDispatches done 边）+ lesson 自动回流（M12-4）；
//   O4 段③ 就绪放行：依赖已 done → 重发同 task 编排 blocked:false spawn（beads ready 链）；
//   O5 断线/重启：主卡 running 悬挂中弃 mgr → 新 mgr ensureLeader（closeHungDispatchRows
//       兜底）→ 悬账收敛+板条退 todo（中断口径非真交付：不写 lesson）→ 状态可续；
//   O6 段④ 主卡认领重派+回合收口：台账 done+lesson2 回流（重启后链路续走到终态）；
//   O7 段⑤ CLI 出单真链路：python3 直跑源件（cc-plugins，测试用源路径；CCR_NO_CLOUD=1
//       测试缝禁真网 KV）--gid/--entry 归因端到端落盘（M12-8 透传小项）+relay 读侧透传；
//   O8 段⑥ 收单回写闭环：saveResult 全过（模拟 LAN POST 处理段）→ settleAcceptanceResult
//       （M12-7）→ 归因卡终态 done——从立项到收口全链闭合；
//   O9 值守串联：CCR_PM_DUTY=1 下 Leader 回合终态 feedPM 跑通（M12-6），编排状态零扰动
//       （细节 C12 已锁，此处只证共存）；
//   O10 SQLite 账实段（read-mode 裁定面）：全链后 ensureStore 全量导入 → 投影读回
//       （dispatch/lesson/group）+ runShadowCompare 六域对账零未备案 diff + 导入幂等——
//       「切换后读 SQLite 不丢账」证据（cutover §4 闸门 3 可测面；旧 JSON 零新写不可实测
//       备案：M12 写面=命令面单写入口，底层旧 JSON 即真相源，写者切换属 M1-3，见回单）。
// fixture 缝仿 test-m12-commands（mkdtemp+CCR_ORG_DIR 注入+fake agent factory+send 直调
// handleCommand）；CLI 段 spawnSync python3 子进程（env 显式注入，不污染父进程）。
// **三 worker 编制形态备案**：链路三次认领派单按职能透传不同 role（surveyor/builder/
// rework——D18 时点备案：P81-2 权限主体映射词表（worker/pm/team_pm/review/review_pm）
// 收窄后 surveyor 非法，最小修=落 worker（勘察属 worker 职能）；builder/rework 实际
// 未显式传 role（缺省 worker 直通）
// rework，dispatchWorker input.role 命令面原生参数）。M12-8 FIX-1 已修 import-org 聚合缺陷
// （identity=sha12(orgDir@role@engine@session) 混入 session 维度+关系落库去重）——同组多
// worker 同 role 同引擎不再撞 UNIQUE(group_id,member_id)，O10 shadow 对账全域零容忍
//（notification 比对口径缺陷同期已修：read-mode compareDomain 改读两 JSON 源 distinct key）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-m1-orchestration.ts
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { acceptanceClosure, loadAcceptance, saveResult } from "../src/acceptance.js";
import { loadBoard, setLightConfirmTrusted } from "../src/projects.js";
import { readDispatchLog } from "../src/org.js";
import {
  dispatchEntriesFromDb,
  ensureStore,
  importAllForShadow,
  lessonsFromDb,
  projectGroupsFromDb,
  resolveDirs,
  runShadowCompare,
} from "../src/storage/read-mode.js";
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
  (_cwd: string, _model: string, cb: AgentCallbacks, prompt: string | undefined, _opts?: unknown): AgentLike => {
    void _cwd; void _model; void _opts;
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

function readNdjson<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

function send(mgr: SessionManager, command_id: string, type: string, payload: Record<string, unknown>, by: string) {
  const cmd = { command_id, type, payload } as unknown as Command;
  return mgr.handleCommand(cmd, by);
}

// CLI 源件路径（仓库根 cc-plugins/plugins/cc-deck/bin/acceptance；~/.cc-deck/bin 同步副本
// 不动——装机批的事，测试用源路径直跑，派单文明确）
const RELAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_SRC = join(RELAY_ROOT, "..", "cc-plugins", "plugins", "cc-deck", "bin", "acceptance");

try {
  // ---------- fixture（仿 test-m12-commands：独立台账/数据目录，零生产触达） ----------
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-orch-"));
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-orch-"));
  const anchor = mkdtempSync(join(tmpdir(), "ccr-anchor-orch-"));
  const ACC = mkdtempSync(join(tmpdir(), "ccr-acc-orch-"));
  // 验收单 md fixture（四段结构：标题/前置/验收表/备注——CLI 宽容解析取前三列）
  const mdPath = join(DATA, "orch-acceptance.md");
  writeFileSync(mdPath, [
    "# 全链编排验收单",
    "",
    "- 前置：主卡交付物已合入",
    "",
    "| 任务号 | 验收项 | 通过标准 | 通过与否 | 问题 |",
    "|---|---|---|---|---|",
    "| #O1 | 编排链 | 派单收口台账可查 | | |",
    "| #O2 | 验收回写 | 归因卡终态 done | | |",
    "",
    "- 备注：M12-8 真链路单",
  ].join("\n"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  const prevDuty = process.env.CCR_PM_DUTY;
  const prevAcc = process.env.CCR_ACCEPTANCE_DIR;
  delete process.env.CCR_STORAGE_READ_MODE; // 主链全程 json 档（现状写路径）；SQLite 面走 ensureStore 直调不经读档位
  delete process.env.CCR_PM_DUTY;           // 值守 O9 才开
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  // 两端口径一致（acceptance.ts :55 备案：「任一单边设置都会读写分家」）——父进程
  // （relay 读侧 loadAcceptance/saveResult）与 CLI 子进程同指 ACC tmp
  process.env.CCR_ACCEPTANCE_DIR = ACC;
  try {
    setLightConfirmTrusted(true); // 轻立项信任直通：create 即 active（C12 既有范式）
    const cfg: RelayConfig = {
      port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));
    const dutyRounds = () => readNdjson<Record<string, unknown>>(join(DATA, "duty-rounds.ndjson"));

    // ---------- O1 前置：轻立项组 active（M12-1 命令面入口） ----------
    console.log("O1 前置");
    const ackG = send(mgr, "o1g", "COMMAND_ORG_ACTION", { action: "create", name: "M12-8 编排组", anchor_dir: anchor, tier: "轻立项" }, "web-1");
    const gid = (ackG.data as { group?: { id: string } } | undefined)?.group?.id ?? "";
    assert(ackG.ok === true && gid !== "", "O1① 轻立项组建组 ACK ok（M12-1 orgAction 漏斗）");
    assert(loadBoard(gid).entries.length === 0, "O1② 板文件就位（编排写面锚定）");

    // ---------- O2 段①建卡编排：依赖未就绪 blocked 零 spawn（M12-2） ----------
    console.log("O2 建卡编排（依赖 blocked）");
    const depAck = send(mgr, "o2dep", "COMMAND_TASK_CREATE", { gid, text: "依赖前置：环境勘察报告" }, "web-1");
    const depId = (depAck.data as { entity_id?: string }).entity_id ?? "";
    const baseO2 = created.length;
    const mainAck1 = send(mgr, "o2main", "COMMAND_DISPATCH", {
      gid, prompt: "主卡活",
      task: { text: "交付主活：全链编排验收", depends_on: [depId] },
    }, "web-1");
    const dMain1 = mainAck1.data as { entity_id?: string; task_ref?: string; blocked?: boolean; block_reasons?: string[]; dispatch_id?: string } | undefined;
    const mainId = dMain1?.entity_id ?? "";
    assert(mainAck1.ok === true && dMain1?.blocked === true && (dMain1.block_reasons ?? []).some((s) => s.includes("未完成")) && !("dispatch_id" in (mainAck1.data as object)),
      "O2① 主卡依赖未就绪 → blocked:true 零派单（编排 gate，无 dispatch_id 键）");
    assert(created.length === baseO2 && mainId !== "" && loadBoard(gid).entries.find((e) => e.id === mainId)?.status === "backlog",
      "O2② 零 spawn+主卡落板 todo（backlog 语义，task_ref≡entity_id）");

    // ---------- O3 段②依赖卡先派先收：认领→回合 done→台账 done+卡自动 done+lesson 回流 ----------
    console.log("O3 依赖卡先派先收");
    const baseO3 = created.length;
    const depDisp = send(mgr, "o3dep", "COMMAND_DISPATCH", { gid, prompt: "勘察走起", title: "依赖前置：环境勘察报告", entry_id: depId, role: "worker" }, "web-1");
    const depDispatchId = (depDisp.data as { dispatch_id?: string }).dispatch_id ?? "";
    assert(depDisp.ok === true && depDispatchId !== "" && created.length === baseO3 + 1
      && loadBoard(gid).entries.find((e) => e.id === depId)?.status === "claimed",
      "O3① 依赖卡认领放行：spawn+卡 doing 挂接 dispatch_id（M12-1 入口）");
    created[baseO3]?.cb.onInit("sdk-orch-dep", "test-model"); // 清 init timer 防悬挂
    created[baseO3]?.cb.onTurnEnd(true, "结果：勘察完成｜改动文件：survey.md", 100);
    const depConv = readDispatchLog().filter((e) => e.id === depDispatchId);
    const lessonsAfterDep = loadBoard(gid).lessons ?? [];
    assert(depConv[depConv.length - 1]?.status === "done" && String(depConv[depConv.length - 1]?.receipt ?? "").includes("勘察完成"),
      "O3② worker 回合收口 → 台账 done+receipt 留痕（M12-3 生命周期 done 边）");
    assert(loadBoard(gid).entries.find((e) => e.id === depId)?.status === "done"
      && lessonsAfterDep.some((l) => l.source_dispatch_id === depDispatchId && l.text.includes("[派单收口]") && l.tags.includes("派单收口")),
      "O3③ 收口联动双写：卡自动搬 done（closeOpenDispatches done 边）+lesson 自动回流（M12-4，actor=system）");

    // ---------- O4 段③就绪放行：依赖已 done → 带 entry_id 重派认领 O2 卡（beads ready 链；
    //            重派口径=C8⑫「卡已入账不回滚，下轮可带 entry_id 重派」——task{} 键每次建新卡，
    //            认领既有卡必须 entry_id） ----------
    console.log("O4 就绪放行主卡");
    const baseO4 = created.length;
    const mainAck2 = send(mgr, "o4main", "COMMAND_DISPATCH", { gid, prompt: "主卡活", entry_id: mainId, role: "worker" }, "web-1");
    const dMain2 = mainAck2.data as { entity_id?: string; dispatch_id?: string; session_id?: string } | undefined;
    const hungId = dMain2?.dispatch_id ?? "";
    assert(mainAck2.ok === true && hungId !== "" && created.length === baseO4 + 1,
      "O4① 依赖 done → 认领放行：spawn（M12-2/M12-4 ready 链闭环，认领路径 computeReady 同口径）");
    assert(loadBoard(gid).entries.find((e) => e.id === mainId)?.status === "claimed"
      && loadBoard(gid).entries.find((e) => e.id === mainId)?.dispatch_id === hungId,
      "O4② 主卡认领 doing 挂接 dispatch_id（零新卡，认领既有 blocked 卡）");

    // ---------- O5 断线/重启：主卡 running 悬挂→弃 mgr→新 mgr 兜底→状态可续 ----------
    console.log("O5 断线/重启不丢");
    const mgr2 = new SessionManager(bus, { ...cfg, dataDir: DATA }); // 模拟断线后重启：新实例读同一台账
    mgr2.setAgentFactory(makeFakeFactory(created));
    const ackL = mgr2.ensureLeader(); // 启动钩子内 closeHungDispatchRows（悬账兜底）
    const leaderIdx = created.length - 1; // ensureLeader spawn 的 Leader 会话（fake factory 记录）
    created[leaderIdx]?.cb.onInit("sdk-orch-leader", "test-model"); // 清 init timer（45s 悬挂防）
    const hungRows = readNdjson<Record<string, unknown>>(join(ORG, "dispatch-log.ndjson")).filter((r) => r.id === hungId);
    const convView = readDispatchLog().filter((e) => e.status === "running" || e.status === "dispatched");
    const mainAfterRestart = loadBoard(gid).entries.find((e) => e.id === mainId);
    const lessonsAtRestart = (loadBoard(gid).lessons ?? []).length;
    assert(ackL.ok === true && convView.length === 0 && hungRows[hungRows.length - 1]?.status === "done"
      && String(hungRows[hungRows.length - 1]?.receipt ?? "").includes("relay 重启"),
      "O5① 悬账兜底：收敛视图零 running/dispatched+悬挂行补 done（receipt=relay 重启，回合中断——M12-3 重启出口）");
    assert(mainAfterRestart?.status === "backlog" && (loadBoard(gid).lessons ?? []).length === lessonsAtRestart,
      "O5② 主卡退 todo（中断口径非真交付：不落 done 不写 lesson——垃圾账防线）+板卡状态跨重启可读");

    // ---------- O6 段④主卡认领重派+回合收口（重启后链路续走到终态） ----------
    console.log("O6 主卡认领重派+收口");
    const baseO6 = created.length;
    const mainAck3 = send(mgr2, "o6main", "COMMAND_DISPATCH", { gid, prompt: "主卡活续", title: "交付主活：全链编排验收", entry_id: mainId, role: "worker" }, "web-1");
    const mainDispatchId2 = (mainAck3.data as { dispatch_id?: string }).dispatch_id ?? "";
    assert(mainAck3.ok === true && mainDispatchId2 !== "" && created.length === baseO6 + 1,
      "O6① 重启后认领重派放行（依赖仍 done，computeReady 同口径；新 dispatch 单非复用悬挂 id）");
    created[baseO6]?.cb.onInit("sdk-orch-main", "test-model");
    created[baseO6]?.cb.onTurnEnd(true, "结果：主活完成全链绿｜改动文件：main.ts", 100);
    const mainConv = readDispatchLog().filter((e) => e.id === mainDispatchId2);
    const lesson2 = (loadBoard(gid).lessons ?? []).find((l) => l.source_dispatch_id === mainDispatchId2);
    assert(mainConv[mainConv.length - 1]?.status === "done"
      && loadBoard(gid).entries.find((e) => e.id === mainId)?.status === "done"
      && lesson2 !== undefined && lesson2.text.includes("交付主活"),
      "O6② 二段收口：台账 done+主卡 done+lesson2 回流（派单→worker→回执→lesson 全链真跑通）");

    // ---------- O7 段⑤CLI 出单真链路（python3 源件直跑+归因端到端） ----------
    console.log("O7 CLI 出单（--gid/--entry 透传）");
    assert(existsSync(CLI_SRC), "O7① CLI 源件在位（cc-plugins/plugins/cc-deck/bin/acceptance）");
    const cliEnv = { ...process.env, CCR_NO_CLOUD: "1", CCR_ACCEPTANCE_DIR: ACC, CCR_PORT: "8797", CCR_DATA_DIR: DATA };
    const cli = spawnSync("python3", [CLI_SRC, mdPath, "--gid", gid, "--entry", mainId], { env: cliEnv, encoding: "utf-8" });
    const accDirEntries = existsSync(ACC) ? readdirSync(ACC) : [];
    const sheetId = accDirEntries.find((f) => f.endsWith(".json") && !f.endsWith(".results.json"))?.replace(/\.json$/, "") ?? "";
    const sheet = sheetId !== "" ? loadAcceptance(sheetId) : null;
    assert(cli.status === 0 && sheetId !== "" && sheet !== null,
      "O7② CLI 出单成功：登记落盘（CCR_NO_CLOUD=1 缝跳云段，LAN 链接照常）");
    assert(sheet?.gid === gid && sheet?.entry_id === mainId,
      "O7③ 归因端到端：--gid/--entry 进单 json→relay 读侧 loadAcceptance 透传（接收端零改即通）");

    // ---------- O8 段⑥收单回写闭环：saveResult 全过→settle→归因卡终态 done（M12-7） ----------
    console.log("O8 收单回写闭环");
    const passRows = (sheet?.rows ?? []).map((r, i) => ({ i, verdict: "pass" as const, note: "" }));
    const saveErr = saveResult(sheetId, { rows: passRows }, "m1-orchestration");
    assert(saveErr === null, "O8① 收单提交落 history（saveResult=LAN POST /api/acceptance 处理段同函数）");
    const settle = mgr2.settleAcceptanceResult(sheetId); // 重启后的实例跑归因回写（断线不丢能力的续段证明）
    const closureEnd = sheetId !== "" ? acceptanceClosure(sheetId) : null;
    // 主卡在 O6 worker 收口时已被 moveEntryByDispatch 搬 done（真链路时序：卡终态先于
    // 用户填单收单）——settle 撞 already-done 幂等分支=终态保护在真链路的自然实证（M12-7）
    assert(settle.ok === true && settle.reason === "already-done",
      "O8② 收单全过 → settle 幂等跳过（卡已 done=already-done，终态保护先于验收回写）");
    assert(closureEnd?.submitted === true && closureEnd.all_pass === true
      && loadBoard(gid).entries.find((e) => e.id === mainId)?.status === "done",
      "O8③ closure 收口态+归因卡终态 done——立项→派单→worker→回执→验收→lesson 全链闭合");

    // ---------- O9 值守串联：编排流与值守共存（M12-6；细节 C12 已锁，此处只证零互扰） ----------
    console.log("O9 值守串联（共存不互扰）");
    process.env.CCR_PM_DUTY = "1";
    const rounds0 = dutyRounds().length;
    const entries0 = loadBoard(gid).entries.length;
    created[leaderIdx]?.cb.onTurnEnd(true, "leader 回合终态", 1); // 值守挂点：Leader 会话限定
    const roundNew = dutyRounds()[dutyRounds().length - 1] ?? {};
    assert(dutyRounds().length === rounds0 + 1 && roundNew.kind === "PM_DUTY_ROUND",
      "O9① Leader 回合终态 → 值守检查审计一行（队列全 done 放行 sleep 零注入——细节 C12 已锁）");
    assert(loadBoard(gid).entries.length === entries0
      && readDispatchLog().filter((e) => e.status === "running" || e.status === "dispatched").length === 0,
      "O9② 值守零扰动编排状态：板卡台账不变（喂活只读队列+注入，零写板零写台账）");

    // ---------- O10 SQLite 账实段（read-mode 裁定面：全链后重建+投影读回+shadow 对账） ----------
    console.log("O10 SQLite 账实（read-mode 裁定：切换后读 SQLite 不丢账）");
    const dirs = resolveDirs({ dataDir: DATA, orgDir: ORG });
    const port = ensureStore(dirs);
    // 读前触发灌库（铁律 3；importAllForShadow 幂等快进）。P81-5 起审计写面（permission-audit
    // auditStore=ensureStore）会在链路中途建库+缓存端口，ensureStore 命中 portCache 零重扫——
    // 「冷启动全量灌」不再由 ensureStore 保证，显式快进把全链 JSON 账灌到当前再投影/对账。
    const importFails = importAllForShadow(port, dirs);
    assert(importFails.length === 0,
      `O10⓪ 七域导入零失败（快进灌账兜底；实报 ${importFails.length} 域失败）`);
    const dbDispatch = dispatchEntriesFromDb(port);
    const dbDep = dbDispatch.filter((e) => e.id === depDispatchId);
    const dbMain = dbDispatch.filter((e) => e.id === mainDispatchId2);
    assert(dbDep.length > 0 && dbDep[dbDep.length - 1]?.status === "done"
      && dbMain.length > 0 && dbMain[dbMain.length - 1]?.status === "done",
      "O10① dispatch 域投影：两单收敛 done 读回（台账账实相符）");
    const dbLessons = lessonsFromDb(port, gid);
    assert(dbLessons.some((l) => l.source_dispatch_id === depDispatchId)
      && dbLessons.some((l) => l.source_dispatch_id === mainDispatchId2),
      "O10② lesson 域投影：两单收口经验读回（回流账实相符）");
    const dbGroups = projectGroupsFromDb(port);
    assert(dbGroups.some((g) => g.id === gid),
      "O10③ group 域投影：编排组读回（归因锚在位）");
    const shadowRows = runShadowCompare(port, dirs);
    const hardRows = shadowRows.filter((r) => r.category !== "value-mismatch");
    // 备案有损映射面（read-mode.ts 头注）：trust_light/parked_at/archived_at/dispatch.target——
    // value-mismatch 行键落此集即合规（点路径形态宽松包含匹配；新未备案词面=红）
    const WHITELIST = ["trust_light", "parked_at", "archived_at", "target"];
    const offRows = shadowRows.filter((r) => r.category === "value-mismatch" && !WHITELIST.some((w) => r.key.includes(w)));
    // M12-8 FIX-1 已修 notification 比对口径（read-mode compareDomain 改读两 JSON 源 distinct
    // key 数，对齐 import-notification），全域零容忍恢复：缺失/数量/错误类任何域零行
    // +value-mismatch 全落备案集。
    assert(hardRows.length === 0 && offRows.length === 0,
      `O10④ shadow 六域对账（全域零容忍，notification 口径缺陷已修）：缺失/数量/错误类零行+value-mismatch 全落备案集（实报 ${shadowRows.length} 行）`);
    const before = dispatchEntriesFromDb(port).length;
    importAllForShadow(port, dirs); // 二调：checkpoint 快进幂等（重启续跑不重灌）
    assert(dispatchEntriesFromDb(port).length === before,
      "O10⑤ 导入幂等：重扫零重灌（断线/重启后 SQLite 侧同样不丢不重）");

    console.log(`\nM1 orchestration: ${pass}/${pass + fail} passed`);
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR;
    else process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
    else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE;
    else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
    if (prevDuty === undefined) delete process.env.CCR_PM_DUTY;
    else process.env.CCR_PM_DUTY = prevDuty;
    if (prevAcc === undefined) delete process.env.CCR_ACCEPTANCE_DIR;
    else process.env.CCR_ACCEPTANCE_DIR = prevAcc;
    rmSync(DATA, { recursive: true, force: true });
    rmSync(ORG, { recursive: true, force: true });
    rmSync(anchor, { recursive: true, force: true });
    rmSync(ACC, { recursive: true, force: true });
  }
} catch (e) {
  console.error(e);
  console.error("M1 orchestration: suite error");
  process.exit(1);
}
if (fail > 0) process.exit(1);
