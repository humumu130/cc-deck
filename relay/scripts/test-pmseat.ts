// ---------- [W-PMSEAT] 值守PM治理测试件（1104 用户实锤「串台」根治） ----------
//
// 覆盖（任务书验收点逐条）：
//   A 组·任命确认卡（验收①）：外部会话被自动提名（xdd-7c 案夹具）→ pm-appoint 卡进
//     org-confirms 且出现在 pendingUserActionsOf 聚合清单；未决期间 pm.session_id 空 +
//     喂活 sleep no_pm_target 零注入；✗ 后否决档记档 + 席位保持空 + 再触发零新卡。
//   B 组·任命 ✓ + 双 PM 互斥（验收②）：✓ 落 override 喂活恢复直达 PM；活值守 PM 在位
//     时第二会话 claim 被拒（时序证据=chain-audit pm-claim-rejected + 现任通知/时间线）
//     + override 不被改写；在位本人重复 claim 幂等收执；他人卡在决时新 claim 拒；
//     显式 claim 同样出卡不直写 override。
//   C 组·收割收尾联检（验收③）：dispatch 终态收口 × PR 面开着 → dispatch-closeout 卡
//     挂 PM 待办（orgAction pr-report 全链 + ndjson 直注两径）；review-ledger end
//     （prev 段行=in_review，harvest --merge 已并）不误报；pr-report merged 自动消单。
//   D 组·重启误伤守卫（PM 裁定入批，1104 21:09 事故时序）：外部 worker pid 活 →
//     closeHungDispatchRows 跳过清扫（restart-skip-live-worker 审计）待真实终态收口；
//     死 pid / 未知会话照常清扫。
//
// 沙盒：CCR_ORG_DIR/CCR_DATA_DIR/CCR_ARTIFACTS_DIR 隔离 + json 读档 + fake agent
// （test-pmwake-target / test-prchip 同款缝）。跑法：
//   env -u CCR_TOKEN -u CCR_STUB_MODE npx tsx scripts/test-pmseat.ts
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { writeCollabMode } from "../src/settings.js";
import { setLightConfirmTrusted, listPendingConfirms, addConfirm } from "../src/projects.js";
import { appendDispatch, readDispatchLog, readDispatchLogFile, readAppointRejected, readPmOverride, setPmOverride } from "../src/org.js";
import { pendingUserActionsOf } from "../src/pending-user-actions.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function readNdjson<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks };
// fake agent：5ms init + 带 prompt 的回合 10ms 自动终态（prchip 同款——派单收口/leader
// boot 都靠它自然走完，不悬挂）
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd; void model;
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit(`sdk-${a.id.slice(0, 8)}`, "test-model", "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        cb.onLog("assistant_text", "干完了。\n结果：完成｜改动文件：无（测试回执）");
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 5);
    return a;
  };

function mkCfg(port: number, dataDir: string): RelayConfig {
  return {
    port, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "test-model", bridgeToken: "bt", dataDir,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
}

let seq = 0;
function mkFixture(dirs: string[]): {
  mgr: SessionManager; extInputs: { sid: string; text: string }[];
  dataDir: string; rounds: () => Record<string, unknown>[]; chain: () => { action?: string; detail?: string; ts?: number }[];
  mkExt: (id: string, cwd: string, title: string, pid: number) => string;
  cleanup: () => void;
} {
  const DATA = mkdtempSync(join(tmpdir(), `ccr-pmseata-data-${++seq}-`));
  const ORG = mkdtempSync(join(tmpdir(), `ccr-pmseata-org-${seq}-`));
  const ART = mkdtempSync(join(tmpdir(), `ccr-pmseata-art-${seq}-`));
  dirs.push(DATA, ORG, ART);
  const prev = { CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_DATA_DIR: process.env.CCR_DATA_DIR, CCR_ARTIFACTS_DIR: process.env.CCR_ARTIFACTS_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_ARTIFACTS_DIR = ART;
  setLightConfirmTrusted(true);
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, mkCfg(8821, DATA));
  const created: SpawnRec[] = [];
  mgr.setAgentFactory(makeFakeFactory(created));
  // feedPM 首行 leaderId 早退门——A⑤/B⑤ 的喂活断言要求 leader 锚在位（no-leader 模式
  // 下值守目标仍解析为 override/空，锚只是过门条件，不参与目标解析；不建锚则 A⑤ 假
  // 失败、A⑪ 退化成恒真断言——验收点④明令禁止恒真）
  const lr = mgr.ensureLeader();
  if (!lr.ok) throw new Error(`ensureLeader 失败: ${"error" in lr ? lr.error : ""}`);
  const extInputs: { sid: string; text: string }[] = [];
  mgr.setBridge({
    extInput: (sid: string, text: string) => { extInputs.push({ sid, text }); return { ok: true }; },
    resolvePending: () => false, answerPending: () => null, extStop: () => ({ ok: true }),
    refreshTodos: () => ({ ok: true }), hideTodo: () => ({ ok: true }), forget: () => {},
  } as never);
  return {
    mgr, extInputs, dataDir: DATA,
    rounds: () => readNdjson<Record<string, unknown>>(join(DATA, "duty-rounds.ndjson")),
    chain: () => readNdjson<{ action?: string; detail?: string; ts?: number }>(join(DATA, "chain-audit.jsonl")),
    mkExt: (id, cwd, title, pid) => {
      mgr.ensureExternal(id, cwd, title, `sdk-${id.slice(0, 6)}`);
      mgr.setExternalCliPid(id, pid);
      return id;
    },
    cleanup: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    },
  };
}

// C/D 组夹具（orgAction 全链：leader+组+板+派单——prchip 同款）
function mkOrgFixture(dirs: string[]): { mgr: SessionManager; gid: string; anchor: string; dataDir: string; cleanup: () => void } {
  const ORG = mkdtempSync(join(tmpdir(), `ccr-pmseatc-org-${++seq}-`));
  const DATA = mkdtempSync(join(tmpdir(), `ccr-pmseatc-data-${seq}-`));
  const ART = mkdtempSync(join(tmpdir(), `ccr-pmseatc-art-${seq}-`));
  dirs.push(ORG, DATA, ART);
  const prev = { CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_DATA_DIR: process.env.CCR_DATA_DIR, CCR_ARTIFACTS_DIR: process.env.CCR_ARTIFACTS_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE };
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_STORAGE_READ_MODE = "json";
  setLightConfirmTrusted(true);
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, mkCfg(8822, DATA));
  const created: SpawnRec[] = [];
  mgr.setAgentFactory(makeFakeFactory(created));
  const r = mgr.ensureLeader();
  if (!r.ok) throw new Error("ensureLeader 失败");
  const anchor = mkdtempSync(join(tmpdir(), `ccr-pmseatc-anchor-${seq}-`));
  const cg = mgr.orgAction("project-create", { name: `pmseat 组${seq}`, anchor, tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm?: boolean } };
  const gid = cg.data?.group?.id ?? "";
  if (cg.data?.needsConfirm) mgr.orgAction("confirm-decide", { confirm_id: cg.data?.confirm?.id ?? "", approve: true, by: "u" });
  return {
    mgr, gid, anchor, dataDir: DATA,
    cleanup: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    },
  };
}

const savedEnv = ["CCR_PM_DUTY", "CCR_PM_DUTY_STALE_MS", "CCR_PM_DUTY_CONTINUATION_MS", "CCR_ACCEPTANCE_DIR", "CCR_CONFIG_FILE", "CCR_NO_TITLE_GEN"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of savedEnv) saved[k] = process.env[k];

async function main() {
  const dirs: string[] = [];
  const PR9 = "https://github.com/humumu130/cc-deck/pull/9"; // 1104 PR#9 案号
  try {
    process.env.CCR_PM_DUTY = "1";
    process.env.CCR_PM_DUTY_STALE_MS = "0";
    process.env.CCR_PM_DUTY_CONTINUATION_MS = "30";
    process.env.CCR_NO_TITLE_GEN = "1";
    const accDir = mkdtempSync(join(tmpdir(), "ccr-pmseat-acc-"));
    process.env.CCR_ACCEPTANCE_DIR = accDir;
    const cfgDir = mkdtempSync(join(tmpdir(), "ccr-pmseat-cfg-"));
    process.env.CCR_CONFIG_FILE = join(cfgDir, "config.json");
    dirs.push(accDir, cfgDir);

    // ============ A 组：任命确认卡拦截（xdd-7c 夹具，验收①） ============
    console.log("A 任命确认卡拦截（xdd-7c 外部会话自动提名）:");
    {
      const f = mkFixture(dirs);
      writeCollabMode(f.dataDir, "no-leader");
      const xdd = f.mkExt("ext-70d8c594-xdd7c", "/Users/xdd", "xdd-7c 随手外部会话", process.pid);
      const cardA1 = listPendingConfirms().find((c) => c.kind === "pm-appoint" && c.payload?.sid === xdd);
      assert(!!cardA1, "A① 自动提名出 pm-appoint 卡（org-confirms 在册，payload.sid=xdd-7c）");
      const agg = pendingUserActionsOf({ confirms: listPendingConfirms(), sessions: [], acceptances: [] });
      assert(agg.some((x) => x.kind === "org-confirm" && x.entity_id === cardA1?.id), "A② 卡出现在 pendingUserActionsOf 聚合清单（验收①探针）");
      const st = (f.mgr as unknown as { pmDutyStatus(): { session_id: string; alive: boolean; pending_appoint?: { session_id: string } } }).pmDutyStatus();
      assert(st.session_id === "" && st.alive === false, "A③ 未决期间 pm.session_id 空 + alive=false（先斩后奏根除）");
      assert(st.pending_appoint?.session_id === xdd, "A④ pm 视图 pending_appoint 面在场（值守位当前是谁可判）");
      (f.mgr as unknown as { feedPM: (t: string) => void }).feedPM("worker_done");
      const rowsA5 = f.rounds();
      assert(rowsA5.some((r) => r.result === "sleep" && r.reason === "no_pm_target"), "A⑤ 未决期间喂活 sleep no_pm_target（零喂活）");
      assert(!rowsA5.some((r) => r.result === "continue") && f.extInputs.length === 0, "A⑥ 零 continue 零注入（值守不推给未确认会话）");
      f.mgr.ensureExternal(xdd, "/Users/xdd", "xdd-7c 随手外部会话", "sdk-x2");
      const cntA7 = listPendingConfirms().filter((c) => c.kind === "pm-appoint" && c.payload?.sid === xdd).length;
      assert(cntA7 === 1, "A⑦ 同席待决卡幂等（重复触发零新卡）");
      const rej = f.mgr.orgAction("confirm-decide", { confirm_id: cardA1?.id ?? "", approve: false, by: "user" }) as { ok: boolean };
      assert(rej.ok === true, "A⑧ 任命卡 ✗ 决议通过");
      assert(readAppointRejected().some((r) => r.session_id === xdd), "A⑨ 否决档记档（appoint_rejected 含该席）");
      const st2 = (f.mgr as unknown as { pmDutyStatus(): { session_id: string; alive: boolean; pending_appoint?: unknown } }).pmDutyStatus();
      assert(st2.session_id === "" && st2.alive === false && st2.pending_appoint === undefined, "A⑩ ✗ 后 pm.session_id 保持空（验收①后半）");
      (f.mgr as unknown as { feedPM: (t: string) => void }).feedPM("turn_end");
      assert(!f.rounds().some((r) => r.result === "continue") && f.extInputs.length === 0, "A⑪ ✗ 后零喂活零注入");
      assert(!listPendingConfirms().some((c) => c.kind === "pm-appoint" && c.payload?.sid === xdd), "A⑫ ✗ 后再触发零新提名卡（否决档跳过——防轰炸环）");
      f.cleanup();
    }

    // ============ B 组：任命 ✓ 喂活恢复 + 双 PM 互斥（验收②） ============
    console.log("B 任命落位与双 PM 互斥:");
    {
      const f = mkFixture(dirs);
      writeCollabMode(f.dataDir, "no-leader");
      const pmB = f.mkExt("ext-pm-b", "/Users/xdd/dev/cc-deck", "在岗 PM", process.pid);
      const cardB = listPendingConfirms().find((c) => c.kind === "pm-appoint" && c.payload?.sid === pmB);
      assert(!!cardB, "B① 候选提名卡在册");
      const okB = f.mgr.orgAction("confirm-decide", { confirm_id: cardB?.id ?? "", approve: true, by: "user" }) as { ok: boolean };
      assert(okB.ok === true, "B② 任命卡 ✓ 决议通过");
      const ovB = readPmOverride();
      assert(ovB?.session_id === pmB && ovB.cli_pid === process.pid, "B③ override 落值（duty.json pm_override=该席+pid）");
      const stB = (f.mgr as unknown as { pmDutyStatus(): { session_id: string; alive: boolean } }).pmDutyStatus();
      assert(stB.alive === true && stB.session_id === pmB, "B④ pm 视图 alive=true 且值守位=确认席（值守标识数据面）");
      (f.mgr as unknown as { setExternalStatus: (id: string, s: string, sum: string) => void }).setExternalStatus(pmB, "DONE", "空闲等输入");
      (f.mgr as unknown as { workerDonePending: number }).workerDonePending = 1; // 喂活候选预置（finishExternal 边的等价直驱）
      (f.mgr as unknown as { feedPM: (t: string) => void }).feedPM("worker_done");
      assert(f.extInputs.some((x) => x.sid === pmB), "B⑤ 喂活恢复（✓ 后注入直达确认 PM——extInput 命中）");
      const sleeper = spawn("sleep", ["30"]);
      const claimerC = f.mkExt("ext-claimer-c", "/Users/xdd/dev/other", "第二认领者", sleeper.pid ?? process.pid);
      const tBefore = Date.now();
      const rC = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/other", pid: sleeper.pid ?? 0 }) as { ok: boolean; error?: string };
      assert(rC.ok === false && (rC.error ?? "").includes("占据"), "B⑥ 第二认领被拒（双 PM 互斥）" + (rC.ok ? "" : "｜" + (rC.error ?? "").slice(0, 60)));
      const chainB = f.chain().filter((x) => x.action === "pm-claim-rejected");
      assert(chainB.length >= 1 && (chainB[0]?.detail ?? "").includes(pmB.slice(0, 8)) && (chainB[chainB.length - 1]?.ts ?? 0) >= tBefore - 1000, "B⑦ chain-audit pm-claim-rejected 在档（时序证据①：ts≥claim 时刻、指向现任）");
      let notifText = "";
      try { notifText = readFileSync(join(f.dataDir, "notifications.json"), "utf8"); } catch { /* 无文件按空 */ }
      assert(notifText.includes("值守位认领被拒"), "B⑧ 现任收到 pm-claim-contested 通知（时序证据②：通知账在档）");
      const pmLogs = (f.mgr as unknown as { getExternalLogs(id: string): { text?: string }[] }).getExternalLogs(pmB);
      assert(pmLogs.some((l) => (l.text ?? "").includes("值守位")), "B⑨ 现任时间线留痕（pushExternalLog 尝试 claim 记录）");
      assert(readPmOverride()?.session_id === pmB, "B⑩ override 未被改写（现任保持）");
      const rAgain = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/cc-deck", pid: process.pid }) as { ok: boolean; data?: { already?: boolean } };
      assert(rAgain.ok === true && rAgain.data?.already === true, "B⑪ 现任重复 claim 幂等收执（already=true）");
      sleeper.kill();
      void claimerC;
      f.cleanup();
    }
    {
      const f = mkFixture(dirs);
      writeCollabMode(f.dataDir, "no-leader");
      const s1 = spawn("sleep", ["30"]);
      const cand = f.mkExt("ext-cand-d", "/Users/xdd/dev/d", "待决候选", s1.pid ?? process.pid);
      assert(listPendingConfirms().some((c) => c.kind === "pm-appoint" && c.payload?.sid === cand), "B⑫ 前置：候选卡在决");
      const s2 = spawn("sleep", ["30"]);
      f.mkExt("ext-rival-e", "/Users/xdd/dev/e", "竞争者", s2.pid ?? process.pid);
      const rR = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/e", pid: s2.pid ?? 0 }) as { ok: boolean; error?: string };
      assert(rR.ok === false && (rR.error ?? "").includes("待用户决议"), "B⑬ 他人卡在决时新 claim 被拒（一次一张，防双卡竞争）");
      const rej = f.mgr.orgAction("confirm-decide", { confirm_id: listPendingConfirms().find((c) => c.kind === "pm-appoint" && c.payload?.sid === cand)?.id ?? "", approve: false, by: "user" }) as { ok: boolean };
      assert(rej.ok === true, "B⑭ 前置：先前卡 ✗ 腾位");
      const rClaim = f.mgr.orgAction("pm-claim", { cwd: "/Users/xdd/dev/e", pid: s2.pid ?? 0 }) as { ok: boolean; data?: { needsConfirm?: boolean } };
      assert(rClaim.ok === true && rClaim.data?.needsConfirm === true, "B⑮ 显式 claim 出任命卡（needsConfirm，不直写 override）");
      assert(readPmOverride() === null, "B⑯ 未决期间 override 保持空（claim 通道同规——先斩后奏根除）");
      // B⑰ WS 咽喉放行（交接包 B2，#212 坑）：COMMAND_ORG_ACTION 通道 pm-claim 不再
      // unsupported——上一卡的 claim 幂等收执路径走真通道验证
      const cmd = { command_id: `pmsb17-${randomUUID().slice(0, 6)}`, type: "COMMAND_ORG_ACTION", payload: { action: "pm-claim", cwd: "/Users/xdd/dev/e", pid: s2.pid ?? 0 } } as unknown as Parameters<SessionManager["handleCommand"]>[0];
      const viaWs = f.mgr.handleCommand(cmd, "web-1") as { ok: boolean; error?: string; data?: { needsConfirm?: boolean; already?: boolean } };
      assert(viaWs.ok === true && (viaWs.data?.needsConfirm === true || viaWs.data?.already === true), "B⑰ WS/面板通道 pm-claim 咽喉放行（不再 unsupported org action）");
      s1.kill(); s2.kill();
      f.cleanup();
    }

    // ============ C 组：收割收尾联检（验收③） ============
    console.log("C 收割收尾联检（dispatch 终态 × 开着 PR）:");
    {
      const f = mkOrgFixture(dirs);
      const dp = f.mgr.orgAction("dispatch", { anchor: f.anchor, prompt: "C1 交付开 PR 样例", gid: f.gid, tier: "轻立项" }) as { ok: boolean; dispatch_id?: string };
      const did = String(dp.dispatch_id ?? "");
      assert(!!did, "C① 前置：派单建单（dispatch_id 在手）");
      await sleep(200); // fake worker 自动 init+回合终态（closeOpenDispatches 收口 done）
      const prOpen = f.mgr.orgAction("pr-report", { dispatch_id: did, pr_url: PR9, pr_state: "open" }) as { ok: boolean; error?: string };
      assert(prOpen.ok === true, "C② worker 交付后上报 PR open（板卡+台账 pr 面落值）" + (prOpen.ok ? "" : "｜" + (prOpen.error ?? "")));
      const cardC = listPendingConfirms().find((c) => c.kind === "dispatch-closeout" && c.payload?.dispatch_id === did);
      assert(!!cardC, "C③ 联检挂「关 PR」进 PM 待办（dispatch-closeout 卡，验收③）");
      assert((cardC?.payload?.pr_state ?? "") === "open" && (cardC?.payload?.pr_url ?? "") === PR9, "C④ 卡载荷携 pr_url/pr_state（PR#9 案形态）");
      const aggC = pendingUserActionsOf({ confirms: listPendingConfirms(), sessions: [], acceptances: [] });
      assert(aggC.some((x) => x.entity_id === cardC?.id), "C⑤ 收口卡进待拍板聚合清单（复用 awaituser 聚合）");
      const prMerged = f.mgr.orgAction("pr-report", { dispatch_id: did, pr_state: "merged" }) as { ok: boolean };
      assert(prMerged.ok === true, "C⑥ PM 收口后上报 merged");
      assert(!listPendingConfirms().some((c) => c.id === cardC?.id), "C⑦ merged 上报自动消单（pending 清空——by=auto:pr-merged）");
      f.cleanup();
    }
    {
      const f = mkOrgFixture(dirs);
      const id1 = `pmseat-c8a-${randomUUID().slice(0, 6)}`;
      const id2 = `pmseat-c8b-${randomUUID().slice(0, 6)}`;
      const id3 = `pmseat-c8c-${randomUUID().slice(0, 6)}`;
      const base = { tier: "轻立项" as const, target: "manual", session_id: "ext-c8" };
      appendDispatch({ ...base, ts: Date.now(), id: id1, status: "dispatched", title: "直收单（PR 滞留）" });
      appendDispatch({ ...base, ts: Date.now(), id: id1, status: "running" });
      appendDispatch({ ...base, ts: Date.now(), id: id1, status: "running", pr_url: PR9, pr_state: "ci_green" });
      appendDispatch({ ...base, ts: Date.now(), id: id1, status: "done", receipt: "交付收口（PM --final 未并 PR）" });
      assert(listPendingConfirms().some((c) => c.kind === "dispatch-closeout" && c.payload?.dispatch_id === id1), "C⑧ 直收形态（done×PR 开着）挂收口卡——1104 PR#9 孤儿形态");
      appendDispatch({ ...base, ts: Date.now(), id: id2, status: "dispatched", title: "审查收割单" });
      appendDispatch({ ...base, ts: Date.now(), id: id2, status: "running" });
      appendDispatch({ ...base, ts: Date.now(), id: id2, status: "done", receipt: "交付" });
      appendDispatch({ ...base, ts: Date.now(), id: id2, status: "in_review", receipt: "PR 互审发起" });
      appendDispatch({ ...base, ts: Date.now(), id: id2, status: "done", receipt: "PR 审查收口（squash-merge 收割）" });
      assert(!listPendingConfirms().some((c) => c.kind === "dispatch-closeout" && c.payload?.dispatch_id === id2), "C⑨ review-ledger end（harvest --merge 已并）不误报");
      appendDispatch({ ...base, ts: Date.now(), id: id3, status: "dispatched", title: "无 PR 单" });
      appendDispatch({ ...base, ts: Date.now(), id: id3, status: "done", receipt: "交付" });
      assert(!listPendingConfirms().some((c) => c.kind === "dispatch-closeout" && c.payload?.dispatch_id === id3), "C⑩ 无 PR 终态单零收口卡（不骚扰）");
      // C⑪ review-end 自动消单（交接包 B3）：交付关口建卡在先（PR open）→ 审查 begin→
      // end（harvest --merge 已并，未报 merged）→ 待决收口卡自动决（by=auto:review-end）
      const id4 = `pmseat-c11-${randomUUID().slice(0, 6)}`;
      appendDispatch({ ...base, ts: Date.now(), id: id4, status: "dispatched", title: "直收后补审单" });
      appendDispatch({ ...base, ts: Date.now(), id: id4, status: "running", pr_url: PR9, pr_state: "open" });
      appendDispatch({ ...base, ts: Date.now(), id: id4, status: "done", receipt: "交付（PR 开着）" });
      assert(listPendingConfirms().some((c) => c.kind === "dispatch-closeout" && c.payload?.dispatch_id === id4 && c.status === "pending"), "C⑪a 前置：交付关口收口卡在场");
      appendDispatch({ ...base, ts: Date.now(), id: id4, status: "in_review", receipt: "PR 互审发起" });
      appendDispatch({ ...base, ts: Date.now(), id: id4, status: "done", receipt: "PR 审查收口（squash-merge 收割）" });
      assert(!listPendingConfirms().some((c) => c.kind === "dispatch-closeout" && c.payload?.dispatch_id === id4), "C⑪b review-end 自动消单（--merge 直收后卡不残留）");
      f.cleanup();
    }

    // ============ D 组：重启误伤守卫（PM 裁定入批，1104 21:09 事故时序） ============
    console.log("D 重启误伤守卫（活 worker 不被「relay 重启，回合中断」收口）:");
    {
      const f = mkFixture(dirs);
      const liveW = f.mkExt("ext-liveworker", "/Users/xdd/dev/live", "在途 worker", process.pid);
      appendDispatch({ ts: Date.now(), id: "pmseat-d1", tier: "轻立项", target: "manual", status: "running", session_id: liveW, title: "D1 在途单" });
      (f.mgr as unknown as { closeHungDispatchRows: () => void }).closeHungDispatchRows();
      assert(readDispatchLog().find((r) => r.id === "pmseat-d1")?.status === "running", "D① 活 worker 在途单不被清扫（仍 running，待真实回合终态收口）");
      assert(f.chain().some((x) => x.action === "restart-skip-live-worker"), "D② restart-skip-live-worker 审计在档（跳过留痕）");
      const dp = spawn("sleep", ["0.05"]);
      const deadPid = dp.pid ?? 0;
      await sleep(300);
      const deadW = f.mkExt("ext-deadworker", "/Users/xdd/dev/dead", "死 worker", deadPid);
      appendDispatch({ ts: Date.now(), id: "pmseat-d2", tier: "轻立项", target: "manual", status: "running", session_id: deadW, title: "D2 死单" });
      (f.mgr as unknown as { closeHungDispatchRows: () => void }).closeHungDispatchRows();
      const lastD2 = readDispatchLog().find((r) => r.id === "pmseat-d2");
      assert(lastD2?.status === "done" && (lastD2?.receipt ?? "").includes("relay 重启"), "D③ 死 worker 悬账照常清扫（语义不变）");
      appendDispatch({ ts: Date.now(), id: "pmseat-d3", tier: "轻立项", target: "manual", status: "dispatched", session_id: "ext-gone", title: "D3 未知单" });
      (f.mgr as unknown as { closeHungDispatchRows: () => void }).closeHungDispatchRows();
      assert(readDispatchLog().find((r) => r.id === "pmseat-d3")?.status === "done", "D④ 未知会话悬账照常清扫（守卫不扩大豁免面）");
      f.cleanup();
    }

    // ============ E 组：R1 返修（1105 双审 P0×1+P1×4） ============
    console.log("E R1 返修（P0 sqlite 档守卫/现任复查/复合判活+release/auto 分档/pid 帧兜底）:");
    {
      // E1【P0】生产 sqlite 读档档位下守卫生效（A 审复现脚本 repro-sqlite-guard.ts
      // 行为版并入——改前红：守卫经 readDispatchLog 拿投影行，归因空=恒清扫；改后
      // 绿：ndjson 直读。档位切 sqlite 模拟生产默认读档）
      const f = mkFixture(dirs);
      process.env.CCR_STORAGE_READ_MODE = "sqlite";
      const liveW = f.mkExt("ext-e1live", "/Users/xdd/dev/e1", "E1 活 worker", process.pid);
      appendDispatch({ ts: Date.now(), id: "pmseat-e1", tier: "轻立项", target: "manual", status: "running", session_id: liveW, title: "E1 在途单" });
      (f.mgr as unknown as { closeHungDispatchRows: () => void }).closeHungDispatchRows();
      assert(readDispatchLogFile().find((r) => r.id === "pmseat-e1")?.status === "running", "E1【P0】sqlite 档活 worker 仍被守卫（ndjson 直读，不依赖读档投影归因）");
      const smSrc = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf-8");
      const gStart = smSrc.indexOf("private closeHungDispatchRows");
      const guardBlk = smSrc.slice(gStart, smSrc.indexOf("\n  private ", gStart + 10)); // 函数边界=下一个方法（helper 在本函数之前，勿用其定义定位）
      assert(!guardBlk.includes("readDispatchLog(") && guardBlk.includes("readFileSync(dispatchLogPath()"), "E1b 静态锁：守卫体 ndjson 直读（无 readDispatchLog——防档位回归）");
      assert(guardBlk.includes("cliPidFromEventsTail"), "E1c 静态锁：守卫判活多源接线（pid 帧兜底源在场）");
      process.env.CCR_STORAGE_READ_MODE = "json";
      f.cleanup();
    }
    {
      // E2【B-F1】现任复查：席位有活值守 PM 时陈旧卡 ✓ 被拦（不覆写不记档）；
      // 同 sid 复决放行
      const f = mkFixture(dirs);
      writeCollabMode(f.dataDir, "no-leader");
      const inc = f.mkExt("ext-e2-incumbent", "/Users/xdd/dev/e2i", "E2 现任", process.pid);
      setPmOverride({ session_id: inc, cli_pid: process.pid, cwd: "/Users/xdd/dev/e2i", claimed_at: Date.now() });
      const cand = f.mkExt("ext-e2-cand", "/Users/xdd/dev/e2c", "E2 迟到候选", process.pid);
      const card = addConfirm({ kind: "pm-appoint", title: "E2 迟到任命卡", reason: "现任复查夹具", payload: { sid: cand, cli_pid: process.pid, cwd: "/Users/xdd/dev/e2c", origin: "auto" } });
      const r = f.mgr.orgAction("confirm-decide", { confirm_id: card.id, approve: true, by: "user" }) as { ok: boolean; error?: string };
      assert(r.ok === false && (r.error ?? "").includes("在位"), "E2 活现任在场→陈旧卡 ✓ 被拦（incumbent 无感换位窗封死）");
      assert(readPmOverride()?.session_id === inc, "E2b 现任 override 未被覆写");
      assert(f.chain().some((x) => x.action === "pm-appoint-superseded-blocked"), "E2c superseded-blocked 审计在档");
      assert(!readAppointRejected().some((x) => x.session_id === cand), "E2d 陈旧卡作废不入否决档（非候选问题）");
      const card2 = addConfirm({ kind: "pm-appoint", title: "E2 同席复决", reason: "同 sid 放行面", payload: { sid: inc, cli_pid: process.pid, cwd: "/Users/xdd/dev/e2i", origin: "claim" } });
      const r2 = f.mgr.orgAction("confirm-decide", { confirm_id: card2.id, approve: true, by: "user" }) as { ok: boolean };
      assert(r2.ok === true && readPmOverride()?.session_id === inc, "E2e 同 sid 复决放行（幂等再确认）");
      f.cleanup();
    }
    {
      // E3【B-F2/A-P1①】复合判活：pid 活但会话在册 pid 已换代（回收占位）→视死清档
      const f = mkFixture(dirs);
      writeCollabMode(f.dataDir, "no-leader");
      const sl = spawn("sleep", ["30"]);
      const pidB = sl.pid ?? 1;
      const a = f.mkExt("ext-e3-a", "/Users/xdd/dev/e3", "E3 会话", pidB);
      setPmOverride({ session_id: a, cli_pid: process.pid, cwd: "", claimed_at: Date.now() }); // ov.pid 活但 ≠ 在册 pidB → stale
      const st = (f.mgr as unknown as { pmDutyStatus(): { alive: boolean } }).pmDutyStatus();
      assert(st.alive === false, "E3 pid 回收占位假阳→视死清档（锁席两出口互锁死根除）");
      assert(f.chain().some((x) => x.action === "pm-override-stale-pid"), "E3b stale-pid 审计在档");
      // E4【解锁出口】org pm release：显式让位直效
      setPmOverride({ session_id: a, cli_pid: pidB, cwd: "", claimed_at: Date.now() });
      const rr = f.mgr.orgAction("pm-release", {}) as { ok: boolean; data?: { released?: boolean } };
      assert(rr.ok === true && rr.data?.released === true, "E4 org pm release 直效让位");
      assert(readPmOverride() === null || readPmOverride() === undefined, "E4b override 已清（席位空，claim/提名恢复可达）");
      assert(f.chain().some((x) => x.action === "pm-release"), "E4c release 审计在档");
      sl.kill();
      f.cleanup();
    }
    {
      // E5【A-P1②】auto:pm-dead 不入否决档（进程幂窗≠用户否决）；用户 ✗ 才记档
      const f = mkFixture(dirs);
      writeCollabMode(f.dataDir, "no-leader");
      const sid = f.mkExt("ext-e5-cand", "/Users/xdd/dev/e5", "E5 候选", process.pid);
      const c1 = addConfirm({ kind: "pm-appoint", title: "E5 auto 消卡", reason: "幂窗分档", payload: { sid, cli_pid: process.pid, cwd: "", origin: "auto" } });
      f.mgr.orgAction("confirm-decide", { confirm_id: c1.id, approve: false, by: "auto:pm-dead" });
      assert(!readAppointRejected().some((x) => x.session_id === sid), "E5 auto:pm-dead 消卡不入否决档（CLI 重启复活可再提名）");
      assert(f.chain().some((x) => x.action === "pm-appoint-rejected" && (x.detail ?? "").includes("不入否决档")), "E5b auto 分档审计措辞在档");
      const c2 = addConfirm({ kind: "pm-appoint", title: "E5 用户否决", reason: "真否决记档", payload: { sid, cli_pid: process.pid, cwd: "", origin: "auto" } });
      f.mgr.orgAction("confirm-decide", { confirm_id: c2.id, approve: false, by: "user" });
      assert(readAppointRejected().some((x) => x.session_id === sid), "E5c 用户真 ✗ 记档（语义分档成立）");
      f.cleanup();
    }
    {
      // E6【B-F3】pid 帧 events 尾账兜底源（压缩窗/挤出后回放态缺 pid 的第二源）
      const f = mkFixture(dirs);
      const sid = f.mkExt("ext-e6", "/Users/xdd/dev/e6", "E6 会话", process.pid);
      const got = (f.mgr as unknown as { cliPidFromEventsTail(s: string): number | undefined }).cliPidFromEventsTail(sid);
      assert(got === process.pid, "E6 events 尾账可捞该会话最新 pid 帧");
      assert((f.mgr as unknown as { cliPidFromEventsTail(s: string): number | undefined }).cliPidFromEventsTail("ext-no-such") === undefined, "E6b 无帧 sid 空手返回（快筛零成本）");
      f.cleanup();
    }

    console.log(`\npmseat: ${pass}/${pass + fail} passed`);
    if (fail > 0) process.exit(1);
    process.exit(0);
  } finally {
    for (const k of savedEnv) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力清理 */ } }
  }
}

void main();
