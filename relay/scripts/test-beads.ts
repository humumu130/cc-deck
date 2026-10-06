// #087 beads 思想采纳（009 §4 M2）—— dispatchWorker 派单前置检查集成测试。
// 范式仿 test-r1c-notify（fake agent factory + CCR_ORG_DIR 沙盒 + 手工 RelayConfig），
// 拒绝发生在 spawn 前，无需真引擎。覆盖：
//   B1 依赖未就绪拒派（原因逐条可判定 / 零 spawn / 零台账行）
//   B2 gate 卡拒派（gate 未过原因可查）
//   B3 板卡不存在拒
//   B4 依赖补 done 后放行 + 认领承接（卡 todo→doing 挂 dispatch_id/owner_session、依赖保留）
//   B5 缺 entry_id 新卡派单不检查（前置检查只在认领时触发，不挡新单）
//   B6 orgCommand API 面透传（HTTP/WS 真入口同样被拦/放行）
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { dispatchLogPath, readDispatchLog } from "../src/org.js";
import { createGroup, decideConfirm, setGroupStatus, upsertBoardEntry, moveBoardEntry, loadBoard, findGroup } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

type SpawnRec = { prompt: string | undefined };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd; void model; void cb;
    created.push({ prompt });
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

function main() {
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-beads-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "ccr-org-beads-"));
  process.env.CCR_NO_TITLE_GEN = "1";
  try {
    const cfg: RelayConfig = {
      port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));

    // ---------- 沙盒就位：active 组 + 板卡三张（依赖源 todo / 主卡依赖它 / gate 卡） ----------
    console.log("B0 沙盒就位");
    const anchor = mkdtempSync(join(tmpdir(), "ccr-anchor-beads-"));
    const cg = createGroup({ name: "beads 派单组", anchor_dir: anchor, tier: "轻立项" });
    const gid = cg.ok ? cg.group.id : "";
    decideConfirm(cg.ok && cg.confirm ? cg.confirm.id : "", true, "u");
    setGroupStatus(gid, "active");
    assert(findGroup(gid)?.status === "active", "B0① 组 active（信任确认路径）");
    const dep = upsertBoardEntry(gid, { text: "依赖源卡", status: "backlog" });
    const depId = dep.ok ? dep.entry.id : "";
    const main = upsertBoardEntry(gid, { text: "主卡：改造入口", status: "backlog", depends_on: [depId] });
    const wid = main.ok ? main.entry.id : "";
    const gated = upsertBoardEntry(gid, { text: "gate 卡", status: "backlog", gate: { reason: "等用户验收点确认" } });
    const g2id = gated.ok ? gated.entry.id : "";
    assert(dep.ok && main.ok && gated.ok && wid !== "" && g2id !== "", "B0② 板卡三张就位（依赖链+gate）");
    const ledgerBase = readDispatchLog().length;

    // ---------- B1 依赖未就绪拒派 ----------
    console.log("B1 依赖未就绪拒派");
    const r1 = mgr.dispatchWorker({ anchor: "", prompt: "干主卡", gid, entry_id: wid });
    assert(r1.ok === false && r1.error.includes("未就绪不可派"), "B1① 认领未就绪卡拒派");
    assert(r1.ok === false && r1.error.includes(depId) && r1.error.includes("backlog"), "B1② 拒因逐条可判定（缺哪张/各自状态）");
    assert(created.length === 0, "B1③ 拒绝发生在 spawn 前（零引擎拉起）");
    assert(readDispatchLog().length === ledgerBase, "B1④ 拒绝零台账行（不落 dispatched 假账）");

    // ---------- B2 gate 卡拒派 ----------
    console.log("B2 gate 卡拒派");
    const r2 = mgr.dispatchWorker({ anchor: "", prompt: "干 gate 卡", gid, entry_id: g2id });
    assert(r2.ok === false && r2.error.includes("gate 未过: 等用户验收点确认"), "B2① gate 未过拒派（原因可查）");
    assert(created.length === 0, "B2② gate 拒同样零 spawn（无自动放行路径）");

    // ---------- B3 板卡不存在拒 ----------
    console.log("B3 板卡不存在拒");
    const r3 = mgr.dispatchWorker({ anchor: "", prompt: "认领幽灵卡", gid, entry_id: "t-nope" });
    assert(r3.ok === false && r3.error.includes("板卡不存在: t-nope"), "B3① 幽灵 entry_id 拒（先建卡再认领）");

    // ---------- B4 依赖补 done 后放行 + 认领承接 ----------
    console.log("B4 就绪放行+认领承接");
    assert(moveBoardEntry(gid, depId, "done").ok, "B4① 依赖源卡搬 done（人补齐依赖）");
    const r4 = mgr.dispatchWorker({ anchor: "", prompt: "干主卡", gid, entry_id: wid });
    const ok4 = r4.ok ? r4 : null;
    assert(ok4 !== null, "B4② 依赖全 done 无 gate → 放行");
    assert(created.length === 1, "B4③ 放行后引擎拉起恰好一次（fake factory）");
    const claimed = loadBoard(gid).entries.find((x) => x.id === wid)!;
    assert(claimed.status === "claimed", "B4④ 认领承接：卡 todo→doing");
    assert(ok4 !== null && claimed.dispatch_id === ok4.dispatch_id && claimed.owner_session === ok4.session_id,
      "B4⑤ 卡挂 dispatch_id+owner_session（台账↔板卡互证）");
    assert(claimed.depends_on?.length === 1 && claimed.depends_on[0] === depId, "B4⑥ 认领不洗依赖（同一张卡，依赖关系保留）");
    // 台账双面：收敛视图（同 id 去重留最后）=running；原始文件 dispatched+running 两行同 id
    const conv4 = readDispatchLog().filter((d) => d.id === (ok4?.dispatch_id ?? "_"));
    assert(conv4.length === 1 && conv4[0]?.status === "running", "B4⑦ 台账收敛视图=running（正常派单链终态）");
    const raw4 = readFileSync(dispatchLogPath(), "utf-8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string; status: string }).filter((d) => d.id === (ok4?.dispatch_id ?? "_"));
    assert(raw4.length === 2 && raw4[0]?.status === "dispatched" && raw4[1]?.status === "running",
      "B4⑧ 台账原始两行 dispatched+running 同 id（append-only 链完整）");

    // ---------- B5 缺 entry_id 新卡派单不检查 ----------
    console.log("B5 新卡派单不检查");
    const r5 = mgr.dispatchWorker({ anchor: "", prompt: " unrelated 新活", gid });
    const r5id = r5.ok ? r5.dispatch_id : "";
    assert(r5.ok === true, "B5① 板上有 gate 卡/未就绪卡不挡新卡派单（检查只在认领时触发）");
    assert(loadBoard(gid).entries.some((x) => x.dispatch_id === r5id && x.id !== wid && x.id !== g2id),
      "B5② 新卡自动落卡（无 entry_id 走建卡分支）");

    // ---------- B6 orgAction API 面（HTTP /api/org 真入口）透传 ----------
    console.log("B6 API 面透传");
    const r6a = mgr.orgAction("dispatch", { gid, prompt: "干 gate 卡", entry_id: g2id });
    assert(r6a.ok === false && String(r6a.error).includes("gate 未过"), "B6① API 面认领 gate 卡同样被拦");
    const r6b = mgr.orgAction("dispatch", { gid, prompt: "API 面认领主卡", entry_id: wid });
    const ok6b = r6b.ok && typeof (r6b as unknown as { dispatch_id?: string }).dispatch_id === "string"
      ? r6b as unknown as { dispatch_id: string } : null;
    assert(ok6b !== null && created.length === 3, "B6② API 面认领就绪卡放行（entry_id 透传到 dispatchWorker）");
    const reClaimed = loadBoard(gid).entries.find((x) => x.id === wid)!;
    assert(ok6b !== null && reClaimed.dispatch_id === ok6b.dispatch_id,
      "B6③ 再认领同卡翻新 dispatch_id（认领总是指向当前派单）");
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR;
    else process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
    else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\nBeads 派单前置检查：${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
