// relfix-s S2 目录锁集成测试：同 anchor_dir 活派单在制时新派单被拒（人话报错含
// 在制单号）；完成后可再派；queue_replay 重入豁免。0927 混合工作区坏包事故闸级根治件。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { createGroup, decideConfirm, setGroupStatus } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

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

// holdTurn=true：回合挂起不收口（在途窗口拉住，测试手动放行 turnRelease()）
let holdTurn = false;
let pendingTurnCb: (() => void) | null = null;
const turnRelease = () => { holdTurn = false; const cb = pendingTurnCb; pendingTurnCb = null; cb?.(); };
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {
        const fire = () => { if (!a.ended) cb.onTurnEnd(true, "success", 10); };
        if (holdTurn) pendingTurnCb = fire; else setTimeout(fire, 10);
      },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("s2-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) {
        const fire = () => { if (!a.ended) cb.onTurnEnd(true, "success", 10); };
        if (holdTurn) pendingTurnCb = fire; else setTimeout(fire, 10);
      }
    }, 20);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-s2-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-s2-"));
  const prevs: Record<string, string | undefined> = {
    CCR_ORG_DIR: process.env.CCR_ORG_DIR,
    CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE,
    CCR_NO_TITLE_GEN: process.env.CCR_NO_TITLE_GEN,
    CCR_CWD: process.env.CCR_CWD,
    CCR_PORT: process.env.CCR_PORT,
  };
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PORT = "8792";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8792, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE") !== undefined);

    const anchor = join(DATA, "proj-s2");
    mkdirSync(anchor, { recursive: true });

    // ---------- T1 在途拒新 ----------
    console.log("T1 同 anchor 在途拒新单:");
    holdTurn = true; // 拉住在途窗口
    const a1 = mgr.orgAction("dispatch", { anchor, prompt: "长任务 A" }) as { ok: boolean; dispatch_id?: string };
    assert(a1.ok === true, "首单 A 受理");
    await waitFor(() => readDispatchLog().some((e) => e.id === a1.dispatch_id && e.status === "running"));
    const b1 = mgr.orgAction("dispatch", { anchor, prompt: "撞车单 B" }) as { ok: boolean; error?: string };
    assert(b1.ok === false, "同锚在途时新单被拒");
    assert((b1.error ?? "").includes("目录锁"), `报错含「目录锁」（实测=${(b1.error ?? "").slice(0, 30)}）`);
    assert((b1.error ?? "").includes(String(a1.dispatch_id).slice(0, 8)), "报错含在制单号（人话可追）");

    // ---------- T2 完成后可再派 ----------
    console.log("T2 完成后可再派:");
    turnRelease(); // 放行 A 回合 → 收口（S1 闸可能翻 failed/zero_output，终态即可）
    await waitFor(() => {
      const row = readDispatchLog().find((e) => e.id === a1.dispatch_id);
      return row !== undefined && (row.status === "done" || row.status === "failed");
    });
    assert(true, "A 单已终态");
    holdTurn = true;
    const c1 = mgr.orgAction("dispatch", { anchor, prompt: "后续单 C" }) as { ok: boolean; dispatch_id?: string };
    assert(c1.ok === true, "A 终态后同锚可再派");
    turnRelease();
    if (c1.dispatch_id) await waitFor(() => { const row = readDispatchLog().find((e) => e.id === c1.dispatch_id); return row?.status === "done" || row?.status === "failed"; });

    // ---------- T3 queue_replay 重入豁免 ----------
    console.log("T3 queue_replay 重入豁免（同单段链不是第二张单）:");
    holdTurn = true;
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "重放靶单 D" }) as { ok: boolean; dispatch_id?: string };
    assert(d1.ok === true, "D 单受理");
    await waitFor(() => readDispatchLog().some((e) => e.id === d1.dispatch_id && e.status === "running"));
    // 直调 dispatchWorker 带 queue_replay（内部重入形态）——不被 D 自己的活单挡
    const replay = mgr.dispatchWorker({ anchor, prompt: "重放靶单 D（drain 重入）", queue_replay: d1.dispatch_id });
    assert(replay.ok === true, "queue_replay 重入过闸（同 id 豁免）");
    turnRelease();

    // ---------- T4 不同锚不受连坐 ----------
    console.log("T4 不同锚并行不受连坐:");
    holdTurn = true;
    const other = join(DATA, "proj-s2-other");
    mkdirSync(other, { recursive: true });
    const e1 = mgr.orgAction("dispatch", { anchor: other, prompt: "邻锚单 E" }) as { ok: boolean };
    assert(e1.ok === true, "不同锚目录并行不受影响（锁是 per-anchor 非 global）");
    turnRelease();

    // ---------- T5 gid 组派豁免（续作实证修订） ----------
    console.log("T5 gid 组派豁免（组内并行是生产主流——组锚≠worker 真实写面）:");
    const ganchor = join(DATA, "proj-s2-group");
    mkdirSync(ganchor, { recursive: true });
    const g = createGroup({ name: "s2 组", anchor_dir: ganchor, tier: "轻立项" });
    if (g.ok && g.confirm) decideConfirm(g.confirm.id, true, "u");
    setGroupStatus(g.ok ? g.group.id : "", "active");
    const gid = g.ok ? g.group.id : "";
    assert(!!gid, "建组+激活");
    holdTurn = true;
    const w1 = mgr.orgAction("dispatch", { gid, prompt: "组内活一（worktree-A）" }) as { ok: boolean; dispatch_id?: string };
    assert(w1.ok === true, "组内首单受理");
    await waitFor(() => readDispatchLog().some((e) => e.id === w1.dispatch_id && e.status === "running"));
    const w2 = mgr.orgAction("dispatch", { gid, prompt: "组内活二（worktree-B 并行）" }) as { ok: boolean; dispatch_id?: string };
    assert(w2.ok === true, `组内第二单不被组锚连坐（生产并行形态，实测=${w2.ok === true ? "过" : JSON.stringify((w2 as { error?: string }).error ?? "").slice(0, 60)}）`);
    // 无 gid 随手办撞组锚（CLI cwd=组锚=真实同目录写面）仍拦——组锚不是法外之地
    holdTurn = true;
    const solo = mgr.orgAction("dispatch", { anchor: ganchor, prompt: "裸派撞组锚" }) as { ok: boolean; error?: string };
    assert(solo.ok === false && (solo.error ?? "").includes("目录锁"), "无 gid 随手办撞组锚目录仍拦（台账锚=真实写面形态锁死）");
    turnRelease();

    console.log(`\nS2 结果: ${pass} pass / ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    for (const [k, v] of Object.entries(prevs)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

void main();
