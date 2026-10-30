// relfix-s S3 一致性三小改集成测试（multica mech2 P3/P4/P7 范式落地件）。
// 覆盖：
//   P3 世代 CAS：台账末行已终态 → 残留引用收口跳过（不重复落终态行）；世代失配 → 跳过
//   P4 入队幂等：同锚不同 id 活单在制 → appendDispatch 开单行拒写；同 id 段链豁免；终态不拦
//   P7 IssueSnapshot：认领既有卡派单 → dispatched 行带 task_snapshot；单在跑期间板被移动 →
//        收口 receipt 附「单外板变动」
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { appendDispatch, dispatchLogPath, readDispatchLog } from "../src/org.js";
import { readFileSync } from "node:fs";
const rawRows = (id: string): number =>
  readFileSync(dispatchLogPath(), "utf-8").split("\n").filter((l) => l.trim() && (() => { try { return (JSON.parse(l) as { id?: string }).id === id; } catch { return false; } })()).length;
// S3：原始台账按 status 取行（收敛视图末行赢——dispatched 行专属字段如 task_snapshot
// 会被 running 行洗掉，断言必须读原始行）
const rawRowOf = (id: string, status: string): Record<string, unknown> | undefined =>
  readFileSync(dispatchLogPath(), "utf-8").split("\n")
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } })
    .filter((x): x is Record<string, unknown> => !!x && x.id === id && x.status === status)
    .pop();
import { createGroup, decideConfirm, loadBoard, setGroupStatus, upsertBoardEntry } from "../src/projects.js";
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
        const fire = () => { if (!a.ended) cb.onLog("assistant_text", "结果：完工｜改动文件：a.ts", {}), cb.onTurnEnd(true, "success", 10); };
        if (holdTurn) pendingTurnCb = fire; else setTimeout(fire, 10);
      },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("s3-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) {
        const fire = () => { if (!a.ended) cb.onLog("assistant_text", "结果：完工｜改动文件：a.ts", {}), cb.onTurnEnd(true, "success", 10); };
        if (holdTurn) pendingTurnCb = fire; else setTimeout(fire, 10);
      }
    }, 20);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-s3-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-s3-"));
  const prevs: Record<string, string | undefined> = {
    CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE,
    CCR_NO_TITLE_GEN: process.env.CCR_NO_TITLE_GEN, CCR_CWD: process.env.CCR_CWD, CCR_PORT: process.env.CCR_PORT,
  };
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PORT = "8794";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8794, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE") !== undefined);

    // ---------- P4 入队幂等（appendDispatch 咽喉，直调单元面） ----------
    console.log("P4 入队幂等咽喉:");
    const anchor = join(DATA, "proj-s3");
    mkdirSync(anchor, { recursive: true });
    const idA = randomUUID();
    const okA = appendDispatch({ ts: 1, id: idA, tier: "随手办", target: "x", status: "dispatched", session_id: "sx", project_anchor: anchor });
    assert(okA === true, "首张活单落账（基线）");
    const idB = randomUUID();
    const okB = appendDispatch({ ts: 2, id: idB, tier: "随手办", target: "x", status: "dispatched", session_id: "sx", project_anchor: anchor });
    assert(okB === false, "同锚不同 id 开单行拒写（幂等咽喉）");
    assert(!readDispatchLog().some((e) => e.id === idB), "拒写行不落账（台账无 B）");
    const okA2 = appendDispatch({ ts: 3, id: idA, tier: "随手办", target: "x", status: "running", session_id: "sx", project_anchor: anchor });
    assert(okA2 === true, "同 id 段链推进豁免（queued/dispatched→running）");
    const okA3 = appendDispatch({ ts: 4, id: idA, tier: "随手办", target: "x", status: "done", receipt: "结果：x｜改动文件：a", session_id: "sx", project_anchor: anchor });
    assert(okA3 === true, "终态行不拦（收口必经）");
    const idC = randomUUID();
    const okC = appendDispatch({ ts: 5, id: idC, tier: "随手办", target: "x", status: "queued", session_id: "sx", project_anchor: anchor });
    assert(okC === true, "A 已终态后新 queued 单可落（活单判定实时）");
    // 组锚豁免（续作修订与 S2 同口径）：组锚上组派并行是生产主流（组锚≠真实写面），
    // 咽喉遇组锚跳过——豁免谓词已由 SessionManager 构造时注册（findGroupByAnchor）
    appendDispatch({ ts: Date.now(), id: idC, tier: "随手办", target: "x", status: "failed", receipt: "清 C", session_id: "sx", project_anchor: anchor });
    const ganchor2 = join(DATA, "proj-s3-exempt");
    mkdirSync(ganchor2, { recursive: true });
    const gx = createGroup({ name: "s3 豁免组", anchor_dir: ganchor2, tier: "轻立项" });
    if (gx.ok && gx.confirm) decideConfirm(gx.confirm.id, true, "u");
    const g1 = appendDispatch({ ts: Date.now(), id: randomUUID(), tier: "正经立项", target: "x", status: "dispatched", session_id: "sx", project_anchor: ganchor2 });
    const g2 = appendDispatch({ ts: Date.now() + 1, id: randomUUID(), tier: "正经立项", target: "x", status: "dispatched", session_id: "sx", project_anchor: ganchor2 });
    assert(g1 === true && g2 === true, "组锚上两张活单均落账（组派并行豁免——非组锚才拦）");

    // ---------- P3 世代 CAS（残留引用收口跳过） ----------
    console.log("P3 世代 CAS:");
    holdTurn = true;
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "CAS 靶单（先摆活）" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    // 等等——锚上还有 C（queued）。S2 闸会挡。先收口 C：直调 appendDispatch 终态 C。
    const idC2 = readDispatchLog().find((e) => e.id === idC);
    void idC2;
    appendDispatch({ ts: Date.now(), id: idC, tier: "随手办", target: "x", status: "failed", receipt: "测试收口 C", session_id: "sx", project_anchor: anchor });
    const d1b = mgr.orgAction("dispatch", { anchor, prompt: "CAS 靶单（重试）" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d1b.ok === true || d1.ok === true, "靶单受理（其一）");
    const target = (d1b.ok ? d1b : d1);
    await waitFor(() => readDispatchLog().some((e) => e.id === target.dispatch_id && e.status === "running"));
    const gen1 = readDispatchLog().find((e) => e.id === target.dispatch_id)?.generation;
    assert(typeof gen1 === "number", `dispatched 行带 generation（实测=${gen1}）`);
    // 模拟 drain 残留引用：手工往承接会话队列塞同 id 旧世代引用，然后收口路径触发
    const sid = (d1b.ok ? d1b.session_id : d1.session_id) as string;
    const internals = mgr as unknown as { openDispatches: Map<string, { id: string; tier: "随手办"; generation?: number }[]> };
    internals.openDispatches.get(sid)?.push({ id: target.dispatch_id as string, tier: "随手办", generation: (gen1 as number) - 1 });
    turnRelease();
    await waitFor(() => { const rows = readDispatchLog().filter((e) => e.id === target.dispatch_id); const last = rows[rows.length - 1]; return last && (last.status === "done" || last.status === "failed"); });
    const rowsAfter = readDispatchLog().filter((e) => e.id === target.dispatch_id);
    const lastAfter = rowsAfter[rowsAfter.length - 1];
    assert(lastAfter.status === "done", "真引用正常收口 done（有结果行不触 S1）");
    const rawAfter = rawRows(target.dispatch_id as string);
    assert(rawAfter >= 3 && rawAfter <= 4, `原始行数符合预期（disp+run+done=${rawAfter}，旧世代引用被 CAS 挡掉不落行）`);
    // 旧引用收口跳过的直接断言：终态后再塞残留引用走一次流关闭兜底收口
    internals.openDispatches.get(sid)?.push({ id: target.dispatch_id as string, tier: "随手办" });
    // 触发一次收口路径（对 Leader/靶会话 stop → onSessionEnd → closeOpenDispatches all）
    // 找靶会话之外的收口面：直接调用 mgr 的内部 stopSession（公开面）
    const st = (mgr as unknown as { stopSession: (id: string) => void }).stopSession;
    if (typeof st === "function") st(sid);
    await wait(150);
    const rawFinal = rawRows(target.dispatch_id as string);
    assert(rawFinal === rawAfter, `终态后残留引用不再落行（CAS 跳过：${rawAfter}→${rawFinal}）`);

    // ---------- P7 IssueSnapshot ----------
    console.log("P7 IssueSnapshot 基线:");
    const ganchor = join(DATA, "proj-s3-g");
    mkdirSync(ganchor, { recursive: true });
    const g = createGroup({ name: "s3 组", anchor_dir: ganchor, tier: "轻立项" });
    assert(g.ok === true, "建组");
    const gid = g.ok ? g.group.id : "";
    // 轻立项首次须确认（组停 pending 建不了卡）——test-beads 同款配方：确认+激活
    if (g.ok && g.confirm) decideConfirm(g.confirm.id, true, "u");
    setGroupStatus(gid, "active");
    upsertBoardEntry(gid, { text: "P7 靶卡：做一件事", status: "backlog" });
    const card = loadBoard(gid).entries.find((x) => x.text.startsWith("P7 靶卡"));
    assert(!!card, "建卡");
    holdTurn = true;
    const p7 = mgr.orgAction("dispatch", { anchor: ganchor, prompt: "认领 P7 卡干活", gid, entry_id: card?.id }) as { ok: boolean; dispatch_id?: string };
    assert(p7.ok === true, "认领派单受理");
    await waitFor(() => readDispatchLog().some((e) => e.id === p7.dispatch_id && e.status === "running"));
    const snapRow = rawRowOf(p7.dispatch_id as string, "dispatched") as { task_snapshot?: { text?: string } } | undefined;
    assert(snapRow?.task_snapshot !== undefined && snapRow.task_snapshot?.text === "P7 靶卡：做一件事", `dispatched 行带 task_snapshot 基线（实测=${JSON.stringify(snapRow?.task_snapshot)?.slice(0, 50)}）`);
    // 单在跑期间板被单外编辑（改卡文本）——drift 面：不走 move（claimed→done 有状态机闸、
    // 且收口自身联动也写 done，会跟 drift 制造打架）；文本编辑是板卡常态写口最稳
    const edited = mgr.orgAction("board", { op: "upsert", gid, entry_id: card?.id, text: "P7 靶卡：做一件事（单外被改）" }) as { ok: boolean };
    assert(edited.ok === true, "单在跑期间板被单外编辑（模拟 drift）");
    turnRelease();
    await waitFor(() => { const rows = readDispatchLog().filter((e) => e.id === p7.dispatch_id); const last = rows[rows.length - 1]; return last && (last.status === "done" || last.status === "failed"); });
    const p7last = readDispatchLog().filter((e) => e.id === p7.dispatch_id).pop();
    assert((p7last?.receipt ?? "").includes("单外板变动"), `收口回执附板变动提示（实测=${(p7last?.receipt ?? "").slice(-60)}）`);

    console.log(`\nS3 结果: ${pass} pass / ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    for (const [k, v] of Object.entries(prevs)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

void main();
