// #018-R1a activity 状态舱接入 SessionManager 集成测试（agentFactory 测试缝，零真 CLI）。
// 覆盖：A1 状态/日志回调写 dock（fixture 驱动 mapper 输出）；A2 同值重复回调不写不发；
//       A3 值变化恰好一条 SESSION_ACTIVITY 瞬态且 events.ndjson 无此类型；A4
//       mgr.snapshot() 直通 activity/activity_capabilities；A5 DONE 后 activity 保留
//       且停发瞬态（迟到的流尾帧不覆写）；A6 终态翻回 WORKING（新回合）恢复刷帧。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { CLAUDE_ACTIVITY_CAPABILITIES } from "../src/agent-adapter.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { SessionActivityPayload } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// 手动驱动型假 agent（仿 test-leader 的 factory 缝）：不做任何定时回调，测试体
// 同步直调 cb.onXxx 驱动，活动帧的时序完全确定性。cb 记录在 created 供取用。
type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd;
    void model;
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

function readNdjson(p: string): { type?: string }[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { type?: string });
}

async function main() {
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-r1a-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-cwd-r1a-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "ccr-org-r1a-"));
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  try {
    const ndjson = join(DATA, "events.ndjson");
    const cfg: RelayConfig = {
      port: 8793, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: ndjson });
    const transient: SessionActivityPayload[] = [];
    bus.subscribe((env) => {
      if (env.type === "SESSION_ACTIVITY") transient.push(env.payload as SessionActivityPayload);
    });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));
    // create 是 private（test-leader 同款 as unknown as 缝，见其 hack8/hack9 先例）
    const create = (mgr as unknown as { create(cwd: string, prompt: string): string }).create.bind(mgr);

    // ---------- A1 fixture 驱动回调 → state.activity 更新 ----------
    console.log("A1 回调路径写 dock");
    const sid = create(CWD, "测试活动接入");
    const cb = created[0].cb;
    cb.onInit("sdk-r1a", "test-model");
    cb.onStatusChange("WORKING", "修改 src/auth.ts");
    let dock = mgr.snapshot().find((s) => s.session_id === sid)?.activity;
    assert(!!dock, "A1① onStatusChange 后 snapshot 携带 activity");
    assert(dock?.state === "WORKING" && dock.activity?.text === "修改 src/auth.ts",
      "A1② dock.state/activity.text 取自 mapper 输出");
    assert(dock?.activity?.kind === "system"
      && dock?.capabilities.native_status === true && dock?.capabilities.approval === true,
      "A1③ 缺省 kind=system，能力位 = CLAUDE_ACTIVITY_CAPABILITIES");
    cb.onLog("tool_use", "Read 调用", { tool: "Read" });
    dock = mgr.snapshot().find((s) => s.session_id === sid)?.activity;
    assert(dock?.activity?.kind === "tool_use" && dock?.activity?.tool === "Read",
      "A1④ onLog 后 dock.activity 刷成 tool_use/Read");
    assert(transient.length === 2, `A1⑤ 恰好两条瞬态（实得 ${transient.length}）`);

    // ---------- A2 同值重复回调不写不发 ----------
    console.log("A2 同值重放静默");
    const before2 = transient.length;
    const frozenAt = mgr.snapshot().find((s) => s.session_id === sid)?.activity?.updated_at;
    cb.onLog("tool_use", "Read 调用", { tool: "Read" });
    cb.onLog("tool_use", "Read 调用", { tool: "Read" });
    dock = mgr.snapshot().find((s) => s.session_id === sid)?.activity;
    assert(transient.length === before2, "A2① 重放零瞬态");
    assert(dock?.updated_at === frozenAt, "A2② state.activity 未被覆写（updated_at 冻结）");

    // ---------- A3 变化恰好一条瞬态 + events.ndjson 无 SESSION_ACTIVITY ----------
    console.log("A3 变化单帧 + 不落盘");
    const before3 = transient.length;
    cb.onLog("assistant_text", "回答正文第一段");
    assert(transient.length === before3 + 1, "A3① 值变化恰好一条 SESSION_ACTIVITY");
    const last = transient[transient.length - 1];
    assert(last.session_id === sid && last.state === "WORKING"
      && last.activity_kind === "assistant_text" && last.text === "回答正文第一段"
      && !("tool" in last) && last.seq_local === before3 + 1,
      "A3② payload 字段对齐 SessionActivityPayload（seq_local 单调）");
    const persisted = readNdjson(ndjson);
    assert(persisted.length > 0 && persisted.some((e) => e.type === "SESSION_CREATED"),
      "A3③ events.ndjson 落盘通道在工作（含 SESSION_CREATED）");
    assert(!persisted.some((e) => e.type === "SESSION_ACTIVITY"),
      "A3④ 瞬态未落 events.ndjson");

    // ---------- A4 snapshot 直通 activity + activity_capabilities ----------
    console.log("A4 快照直通");
    const snapSession = mgr.snapshot().find((s) => s.session_id === sid);
    assert(!!snapSession?.activity && !!snapSession?.activity_capabilities,
      "A4① snapshot 会话含 activity 与 activity_capabilities");
    assert(JSON.stringify(snapSession?.activity_capabilities) === JSON.stringify(CLAUDE_ACTIVITY_CAPABILITIES),
      "A4② activity_capabilities 与 CLAUDE 常量同值");

    // ---------- A5 DONE 收口：activity 保留 + 停发瞬态 ----------
    console.log("A5 终态保留与静默");
    cb.onTurnEnd(true, "success", 100);
    const doneSnap = mgr.snapshot().find((s) => s.session_id === sid);
    assert(doneSnap?.status === "DONE", "A5① onTurnEnd 收口 DONE");
    assert(doneSnap?.activity?.activity?.text === "回答正文第一段",
      "A5② DONE 后 activity 保留最后状态供快照");
    const before5 = transient.length;
    cb.onLog("tool_use", "迟到的流尾帧", { tool: "Bash" });
    assert(transient.length === before5, "A5③ 终态后迟到回调零瞬态");
    assert(mgr.snapshot().find((s) => s.session_id === sid)?.activity?.activity?.text === "回答正文第一段",
      "A5④ 迟到回调未覆写 dock（保留收口前值）");

    // ---------- A6 新回合（终态翻回 WORKING）恢复刷帧 ----------
    console.log("A6 新回合恢复");
    cb.onStatusChange("WORKING", "新回合开工");
    assert(transient.length === before5 + 1, "A6① 终态翻回 WORKING 后瞬态恢复");
    assert(mgr.snapshot().find((s) => s.session_id === sid)?.activity?.activity?.text === "新回合开工",
      "A6② dock 恢复随状态刷新");
    const lastSeq = transient[transient.length - 1].seq_local;
    assert(lastSeq === transient[transient.length - 2].seq_local + 1,
      "A6③ seq_local 跨终态持续单调");
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
    else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwdEnv === undefined) delete process.env.CCR_CWD;
    else process.env.CCR_CWD = prevCwdEnv;
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\nR1a activity 接入：${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
