// relfix-s S1 零产出闸集成测试（multica poisoned.go 假成功翻转范式落地件）。
// 覆盖：
//   G1 零产出翻转：done 收口（files_changed=0 ∧ 在途单 ∧ 回执无「结果：」行）→ failed/zero_output
//   G2 白名单·显式回执：同形态但回执带「结果：…｜改动文件：无」→ 正常 done（不误伤纯调研类）
//   G3 白名单·有文件改动：files_changed>0 ∧ 无结果行 → done + receipt_missing（原 W-SMIMPL② 语义不变）
//   G4 词表面：org-schema 校验接受 failure_reason=zero_output（旧词表拒写=闸行落不了账）
// 环境隔离：CCR_ORG_DIR/CCR_PORT/CCR_STORAGE_READ_MODE 显式钉（worker 会话自带生产 env——坑实录）。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { applyOrgChange } from "../src/org-schema.js";
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

// fake agent：init 后 prompt 20ms 回 onTurnEnd(ok)；emitResult 非空时先回一条带
// 「结果：」行的 assistant 消息（worker 纪律模板形态）
let emitResult: string | null = null;
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {
        setTimeout(() => {
          if (a.ended) return;
          if (emitResult) cb.onLog("assistant_text", `做完了。\n${emitResult}`, {});
          cb.onTurnEnd(true, "success", 10);
        }, 10);
      },
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("s1-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        if (emitResult) cb.onLog("assistant_text", `做完了。\n${emitResult}`, {});
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 20);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-s1-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-s1-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevMode = process.env.CCR_STORAGE_READ_MODE;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwd = process.env.CCR_CWD;
  const prevPort = process.env.CCR_PORT;
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PORT = "8791"; // 显式错开（worker 会话自带生产 env 坑实录）
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8791, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE") !== undefined);

    const anchor = join(DATA, "proj-s1");
    mkdirSync(anchor, { recursive: true });

    // ---------- G1 零产出翻转 ----------
    console.log("G1 零产出翻转（0 文件 ∧ 有单 ∧ 无结果行 → failed/zero_output）:");
    emitResult = null; // 无「结果：」行
    const g1 = mgr.orgAction("dispatch", { anchor, prompt: "修个 bug" }) as { ok: boolean; dispatch_id?: string; error?: string };
    assert(g1.ok === true, "派单受理");
    await waitFor(() => {
      const row = readDispatchLog().find((e) => e.id === g1.dispatch_id);
      return row?.status === "failed";
    });
    const g1row = readDispatchLog().find((e) => e.id === g1.dispatch_id);
    assert(g1row?.status === "failed", "零产出单收口翻转为 failed（done 被拒）");
    assert(g1row?.failure_reason === "zero_output", `failure_reason=zero_output（实测=${g1row?.failure_reason}）`);
    assert((g1row?.receipt ?? "").includes("零产出闸"), "回执含「零产出闸」标注（PM 可读）");

    // ---------- G2 白名单·显式回执 ----------
    console.log("G2 白名单·显式回执（结果行带「改动文件：无」→ 正常 done）:");
    emitResult = "结果：纯调研完成，结论已在本回复中｜改动文件：无";
    const g2 = mgr.orgAction("dispatch", { anchor, prompt: "调研一下 x" }) as { ok: boolean; dispatch_id?: string };
    assert(g2.ok === true, "派单受理");
    await waitFor(() => {
      const row = readDispatchLog().find((e) => e.id === g2.dispatch_id);
      return row?.status === "done";
    });
    const g2row = readDispatchLog().find((e) => e.id === g2.dispatch_id);
    assert(g2row?.status === "done", "白名单放行：显式回执的零文件单正常 done");
    assert((g2row?.receipt ?? "").includes("结果："), "回执拼入结果行");

    // ---------- G3 白名单·有文件改动 ----------
    console.log("G3 白名单·有文件改动（files_changed>0 ∧ 无结果行 → done+receipt_missing）:");
    emitResult = null;
    const g3 = mgr.orgAction("dispatch", { anchor, prompt: "再修一个" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(g3.ok === true, "派单受理");
    // 注入非零产出统计（bridge.ts:3305 setExternalStats 同链路）——回合结束前落位
    if (g3.session_id) mgr.setExternalStats(g3.session_id, { files_changed: 3, lines_added: 10, lines_deleted: 2 });
    await waitFor(() => {
      const row = readDispatchLog().find((e) => e.id === g3.dispatch_id);
      return row?.status === "done";
    });
    const g3row = readDispatchLog().find((e) => e.id === g3.dispatch_id);
    assert(g3row?.status === "done", "有文件改动不过闸：正常 done");
    assert(g3row?.receipt_missing === true, "无结果行仍标 receipt_missing（W-SMIMPL② 观测语义不变）");
    assert(g3row?.failure_reason === undefined, "无 failure_reason（done 单不落失败枚举）");

    // ---------- G4 词表面 ----------
    console.log("G4 词表面（org-schema 校验接受 zero_output）:");
    const probeOk = applyOrgChange("dispatch-entry", {
      ts: Date.now(), id: randomUUID(), tier: "随手办", target: "x",
      status: "failed", receipt: "零产出闸：测试探针", session_id: "s", failure_reason: "zero_output",
    });
    assert(probeOk.ok === true, `schema 接受 failure_reason=zero_output${probeOk.ok ? "" : `（${probeOk.error}）`}`);
    const probeBad = applyOrgChange("dispatch-entry", {
      ts: Date.now(), id: randomUUID(), tier: "随手办", target: "x",
      status: "failed", receipt: "x", session_id: "s", failure_reason: "not_in_vocab",
    });
    assert(probeBad.ok === false, "词表外值仍拒（校验面未被放宽）");

    console.log(`\nS1 结果: ${pass} pass / ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR; else process.env.CCR_ORG_DIR = prevOrg;
    if (prevMode === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevMode;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwd === undefined) delete process.env.CCR_CWD; else process.env.CCR_CWD = prevCwd;
    if (prevPort === undefined) delete process.env.CCR_PORT; else process.env.CCR_PORT = prevPort;
  }
}

void main();
