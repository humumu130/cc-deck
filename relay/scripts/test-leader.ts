// #26 矩阵式 M1 —— Leader 常驻化集成测试（agentFactory 测试缝，不拉真 CLI）。
// 覆盖：L1 首建（锚/pinned/题名/待命化）+ L2 sticky-cwd 豁免 + L3 重启重建零 spawn
//       + L4 幂等 + L5 废锚重建。台账用例（L6）在 C3 追加。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { ORG_LEADER_BOOTSTRAP_PROMPT, ORG_LEADER_TITLE, readOrgAnchor, writeOrgAnchor } from "../src/org.js";
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

// 假 agent 工厂（仿 test-bridge #46）：init = 20ms 后回 onInit；parked（prompt=undefined）
// 不触发 onTurnEnd——首建 Leader 的形态。created 记录每次 spawn 供计数断言。
let initMode: "init" | "noinit" | "die" = "init";
type SpawnRec = { prompt: string | undefined; resume?: string; cb: AgentCallbacks };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { resume?: string }): AgentLike => {
    void cwd;
    created.push({ prompt, resume: opts?.resume, cb });
    const mode = initMode;
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    if (mode === "init") {
      setTimeout(() => {
        if (a.ended) return;
        cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
        if (prompt !== undefined) setTimeout(() => { if (!a.ended) cb.onTurnEnd(true, "success", 12); }, 10);
      }, 20);
    } else if (mode === "die") {
      setTimeout(() => { if (!a.ended) { a.ended = true; cb.onSessionEnd("stream closed"); } }, 10);
    }
    return a;
  };

const readJson = (p: string): unknown => {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
};

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-lead-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-lead-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD; // sticky 豁免分支的前提（设了 CCR_CWD 时该分支本就跳过）
  try {
    const cfg: RelayConfig = {
      port: 8791, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "",
    };

    // ---------- L1 首建 + L2 sticky-cwd 豁免 ----------
    console.log("L1 首建 + L2 sticky-cwd 豁免:");
    const sentinel = mkdtempSync(join(tmpdir(), "ccr-sentinel-"));
    writeFileSync(join(DATA, "last-cwd"), sentinel, "utf-8");
    cfg.defaultCwd = sentinel;

    const created1: SpawnRec[] = [];
    const mgr1 = new SessionManager(new EventBus({ persistPath: join(DATA, "events.ndjson") }), cfg);
    mgr1.setAgentFactory(makeFakeFactory(created1));

    const r1 = mgr1.ensureLeader();
    assert(r1.ok === true && r1.created === true, "L1 首建 created=true");
    const leaderId = r1.ok ? r1.session_id : "";
    assert(created1.length === 1 && created1[0].prompt === ORG_LEADER_BOOTSTRAP_PROMPT, "L1 唯一一次 spawn，携带上岗引导（fresh parked 不回 init，首条输入才产生 sdkId）");

    const a1 = readOrgAnchor();
    assert(!!a1 && a1.leader_session_id === leaderId && a1.leader_sdk_id === "", "L1 锚落盘（sdk_id 空串 = 首建窗口）");

    const pinned1 = readJson(join(DATA, "pinned-sessions.json")) as string[] | null;
    assert(Array.isArray(pinned1) && pinned1.includes(leaderId), "L1 pinned 文件含 Leader id（首建即置顶）");

    const ov1 = readJson(join(DATA, "title-overrides.json")) as Record<string, string> | null;
    assert(!!ov1 && ov1[leaderId] === ORG_LEADER_TITLE, "L1 题名 override 落盘（跨重启权威）");

    assert(existsSync(join(ORG, "CLAUDE.md")), "L1 org CLAUDE.md 种子落盘");

    assert(readFileSync(join(DATA, "last-cwd"), "utf-8") === sentinel, "L2 last-cwd 文件未被 org 覆盖（豁免生效）");
    assert(cfg.defaultCwd === sentinel, "L2 cfg.defaultCwd 内存未变");

    // onInit → 锚回填 + 待命化 → 上岗回合收口（等终态防中间态竞态）
    assert(await waitFor(() => {
      const c = mgr1.snapshot().find((s) => s.session_id === leaderId);
      return !!c && c.status === "DONE" && c.done_reason === "success";
    }), "L1 上岗回合正常收口（onInit 先待命化，onTurnEnd 收口 DONE；reason=CLI terminal_reason，fake 固定 success）");
    const a1b = readOrgAnchor()!;
    assert(a1b.leader_sdk_id.startsWith("sdk-"), "L1 回填 sdk id（fake 工厂 sdk- 前缀口径）");
    assert(a1b.leader_session_id === leaderId, "L1 回填不换 relay id");
    const card1 = mgr1.snapshot().find((s) => s.session_id === leaderId)!;
    assert(card1.relay_session_id === a1b.leader_sdk_id, "L1 卡片 relay_session_id = 锚 sdk id");
    assert(card1.title === ORG_LEADER_TITLE && card1.title_locked === true, "L1 卡片题名立即生效（不等重启收养）");
    assert(card1.pinned === true, "L1 卡片置顶");
    assert(mgr1.isLeaderSession(leaderId) === true && mgr1.isLeaderSession("nope") === false, "L1 isLeaderSession 内存匹配");

    // ---------- L4 幂等 ----------
    console.log("L4 幂等:");
    const nBefore = mgr1.snapshot().length;
    const r4 = mgr1.ensureLeader();
    assert(r4.ok === true && r4.created === false && r4.rebuilt === false && r4.session_id === leaderId, "L4 再跑同 id、created/rebuilt 均 false");
    assert(mgr1.snapshot().length === nBefore && created1.length === 1, "L4 无新卡无新 spawn");

    // ---------- L3 重启重建（applyPinned 先清失联 → ensureLeader 零 spawn 重建）----------
    console.log("L3 重启重建:");
    const created2: SpawnRec[] = [];
    initMode = "init";
    const mgr2 = new SessionManager(new EventBus({ persistPath: join(DATA, "events.ndjson") }), cfg);
    mgr2.setAgentFactory(makeFakeFactory(created2));
    assert(mgr2.adopt(new Map()) === 0, "L3 adopt 空表（events 压缩挤掉 Leader 的形态）");
    mgr2.applyPinned();
    const pinnedClean = readJson(join(DATA, "pinned-sessions.json")) as string[] | null;
    assert(Array.isArray(pinnedClean) && !pinnedClean.includes(leaderId), "L3 applyPinned 静默清掉失联 Leader 条目（时序前提坐实：ensureLeader 必须在后）");

    const r3 = mgr2.ensureLeader();
    assert(r3.ok === true && r3.rebuilt === true && r3.session_id === leaderId, "L3 从锚重建（同 relay id）rebuilt=true");
    assert(created2.length === 0, "L3 重建零 spawn");
    const card3 = mgr2.snapshot().find((s) => s.session_id === leaderId)!;
    assert(card3.relay_session_id === a1b.leader_sdk_id, "L3 重建卡 relay_session_id = 锚 sdk id（可 resume）");
    assert(card3.status === "DONE" && card3.saved === true && card3.pinned === true && card3.historical === true, "L3 休眠卡形态：DONE/saved/pinned/historical");
    assert(card3.title === ORG_LEADER_TITLE && card3.cwd === ORG, "L3 题名 + org cwd");
    const pinned3 = readJson(join(DATA, "pinned-sessions.json")) as string[] | null;
    assert(Array.isArray(pinned3) && pinned3.includes(leaderId), "L3 pinned 文件重新含 Leader id（重建后写回）");

    // ---------- L5 废锚（sdk_id 空 + 不在内存 → 清锚重建）----------
    console.log("L5 废锚:");
    const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org-lead2-"));
    const DATA2 = mkdtempSync(join(tmpdir(), "ccr-data-lead2-"));
    process.env.CCR_ORG_DIR = ORG2;
    writeOrgAnchor({ version: 1, leader_session_id: "bogus-leader-id", leader_sdk_id: "", created_at: 1, updated_at: 1 }, ORG2);
    const created5: SpawnRec[] = [];
    const cfg5: RelayConfig = { ...cfg, dataDir: DATA2, defaultCwd: "" };
    const mgr5 = new SessionManager(new EventBus({ persistPath: join(DATA2, "events.ndjson") }), cfg5);
    mgr5.setAgentFactory(makeFakeFactory(created5));
    const r5 = mgr5.ensureLeader();
    assert(r5.ok === true && r5.created === true, "L5 废锚按未建组织处理（清锚首建）");
    const a5 = readOrgAnchor();
    assert(!!a5 && a5.leader_session_id === (r5.ok ? r5.session_id : "") && a5.leader_session_id !== "bogus-leader-id", "L5 新锚替换废锚");
    rmSync(ORG2, { recursive: true, force: true });
    rmSync(DATA2, { recursive: true, force: true });
    rmSync(sentinel, { recursive: true, force: true });
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwdEnv === undefined) delete process.env.CCR_CWD; else process.env.CCR_CWD = prevCwdEnv;
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
