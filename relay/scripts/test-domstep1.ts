// domstep1（域图 superagent-domain-v1 §三第一步·1104 用户令）：Trigger 幂等落账+Report 六态位断言。
//   A trigger_key 生成单点：同意图同键/归一化等价/gid 域分隔/slug 不入键
//   B 入口幂等：同键双发第二单被拒（回执含在途单 id）+异题不误拦+开关 off 回退口
//   C Report 六态：分类单点（结构化卡压倒文本/散文本 waiting→progress+备注）+落账往返+
//     waiting 行 100% 有 confirm_ref（反恒真：无卡文本永远进不了 waiting）
//   D 静态锁：三行落键点+入口闸引用单点+挂键纪律锚+第十一键
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-domstep1.ts
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { readDispatchLog, appendDispatch } from "../src/org.js";
import { dispatchTriggerKey, findInFlightByTriggerKey } from "../src/trigger-key.js";
import { classifyReportStatus, appendDeliverCallback, amendFailedReport, deliverCallbackSeen, deliverCallbackLogPath } from "../src/deliver-callback.js";
import { PLUGIN_CFG_KEYS, readPluginConfig } from "../src/plugin-config.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// 卡死 agent：onInit 起会话但不收工（回合永在途=幂等查重的在途单形态）
const makeStuckFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => { /* 卡死：不回包不收工（在途保持） */ },
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => { if (!a.ended) cb.onInit("sdk-" + a.id.slice(0, 8), model, "default"); }, 10); // prompt 不自动收工=在途
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-domstep1-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-domstep1-"));
  const CFG = join(DATA, "config.json");
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_CONFIG_FILE = CFG;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_PM_DUTY = "0";
  delete process.env.CCR_CWD;
  writeFileSync(CFG, "{}");
  try {
    // ============ A trigger_key 生成单点 ============
    console.log("A trigger_key 生成（来源+意图归一化指纹）:");
    const k1 = dispatchTriggerKey({ gid: "g1", title: "修复登录页", prompt: "正文" });
    assert(k1.startsWith("tk-") && k1.length === 11, `键形 tk-+8hex（实 ${k1}）`);
    assert(dispatchTriggerKey({ gid: "g1", title: "修复登录页", prompt: "x" }) === k1, "同意图同键（确定性）");
    assert(dispatchTriggerKey({ gid: "g1", title: " 修复   登录页 ", prompt: "x" }) === dispatchTriggerKey({ gid: "g1", title: "修复 登录页", prompt: "x" }), "空白折叠等价（连续空白归一为单空格——boardfix 题名键同口径，折叠非删除）");
    assert(dispatchTriggerKey({ gid: "g1", title: "修复登录页".toUpperCase() === "修复登录页" ? "修复LOGIN" : "修复LOGIN", prompt: "x" }) === dispatchTriggerKey({ gid: "g1", title: "修复login", prompt: "x" }), "lowercase 等价（大小写归一）");
    assert(dispatchTriggerKey({ gid: "g2", title: "修复登录页", prompt: "x" }) !== k1, "gid 入键（异组同题不互拦）");
    assert(dispatchTriggerKey({ gid: "g1", title: "修复登录页", prompt: "x", } as never) === dispatchTriggerKey({ gid: "g1", title: "修复登录页", prompt: "x", slug: "fix-login-77" } as never), "slug 不入键（CLI/API 两入口同任务同键——幂等面不穿孔）");
    // domstep1r1：原「缺省 title 回落」断言为同表达式自比（恒真）——拆真：60 位后差异被
    // 截同键 + 首 60 内差异异键两组（截断行为真测，非确定性自证）
    assert(dispatchTriggerKey({ gid: "g1", prompt: "X".repeat(60) + "AAA\n正文" }) === dispatchTriggerKey({ gid: "g1", prompt: "X".repeat(60) + "BBB\n正文" }), "缺省 title 回落 prompt 首行截 60：60 位后差异被截→同键");
    assert(dispatchTriggerKey({ gid: "g1", prompt: "X".repeat(60) + "AAA\n正文" }) !== dispatchTriggerKey({ gid: "g1", prompt: "X".repeat(59) + "YAA\n正文" }), "首 60 内差异→异键（截断行为真测）");
    assert(dispatchTriggerKey({ gid: "g1", prompt: "\n首行空白回退非空行" }) === dispatchTriggerKey({ gid: "g1", prompt: "首行空白回退非空行" }), "首行空白回退首个非空行（防同组空 intent 共用一键——审 A 1d）");
    assert(dispatchTriggerKey({ prompt: "随手办无组任务" }) !== dispatchTriggerKey({ prompt: "随手办无组任务二" }), "无 gid（随手办）键仍可区分意图");
    // domstep1r1（P2-A② 审 A 1c）：no-gid 面 anchor 入键——跨锚同题放行（随手办合法并行
    // 不误杀），归一化同 S2 口径（重放必同 cwd 仍同键）；gid 面组锚恒定不受影响
    assert(dispatchTriggerKey({ anchor: "/tmp/repoA", prompt: "跑构建修报错" }) !== dispatchTriggerKey({ anchor: "/tmp/repoB", prompt: "跑构建修报错" }), "no-gid 面 anchor 入键：跨锚同题放行（原空域误杀根除）");
    assert(dispatchTriggerKey({ anchor: "/tmp/repoA/", prompt: "跑构建修报错" }) === dispatchTriggerKey({ anchor: "/tmp/REPOA", prompt: "跑构建修报错" }), "anchor 归一化同 S2 口径（尾斜杠剥+lowercase——重放同 cwd 仍同键）");
    assert(dispatchTriggerKey({ gid: "g1", anchor: "/tmp/repoA", title: "同题", prompt: "x" }) === dispatchTriggerKey({ gid: "g1", anchor: "/tmp/repoB", title: "同题", prompt: "x" }), "gid 面组锚恒定：anchor 不参与（组域键不受派单锚影响）");

    // findInFlightByTriggerKey：手造台账（queued 在途/终态不拦/旧行无键不参与）
    const tkProbe = "tk-deadbeef";
    const dQ = "dq-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now(), id: dQ, tier: "轻立项", target: "cap-queue", status: "queued", receipt: "排队", session_id: "", trigger_key: tkProbe });
    assert(findInFlightByTriggerKey(tkProbe) === dQ, "queued 计在途（排队期间同 Trigger 拒重）");
    const dT = "dt-" + randomUUID().slice(0, 8);
    appendDispatch({ ts: Date.now(), id: dT, tier: "轻立项", target: "x", status: "dispatched", session_id: "s", trigger_key: "tk-old1" });
    appendDispatch({ ts: Date.now() + 1, id: dT, tier: "轻立项", target: "x", status: "done", receipt: "结果：完成", session_id: "s", trigger_key: "tk-old1" });
    assert(findInFlightByTriggerKey("tk-old1") === null, "末行赢：done 终态不拦（同键可再派）");
    appendDispatch({ ts: Date.now(), id: "legacy-" + randomUUID().slice(0, 6), tier: "轻立项", target: "x", status: "dispatched", session_id: "s2" });
    assert(findInFlightByTriggerKey("tk-nothing") === null, "旧行无键不参与查重（零迁移宽容）");
    // domstep1r1（P2-A① 审 A 1b）：换题重投链——同 root 段链键**末行赢**（原首行赢把 id
    // 钉死首段键 K1，重投单超时重发 K2 查重不命中=返修单双开不拦）
    const dR = "dr-" + randomUUID().slice(0, 8);
    const kOldSeg = "tk-redisp-old", kNewSeg = "tk-redisp-new";
    appendDispatch({ ts: Date.now(), id: dR, tier: "轻立项", target: "x", status: "dispatched", session_id: "s", trigger_key: kOldSeg });
    appendDispatch({ ts: Date.now() + 1, id: dR, tier: "轻立项", target: "x", status: "done", receipt: "结果：完成", session_id: "s" }); // 终态行不透传键
    appendDispatch({ ts: Date.now() + 2, id: dR, tier: "轻立项", target: "y", status: "dispatched", session_id: "s2", trigger_key: kNewSeg }); // redispatch 换题新段（落新输入算的键）
    assert(findInFlightByTriggerKey(kNewSeg) === dR, "换题重投链：末段键 K2 命中在途（返修单超时重发可拦——时序：K1 段→done→K2 段在途）");
    assert(findInFlightByTriggerKey(kOldSeg) === null, "旧段键 K1 随段退役不误拦（done 终态段不再占键）");
    // domstep1r1（P1-B 审 B ④）：缺省 sqlite 档（生产缺省，2026-10-06 SQLITE-FLIP）幂等
    // 查重——原 readDispatchLog 投影读在缺省档静默失明（dispatch 表无 trigger_key 列，
    // 探针 /tmp/domstep1-review/probe-sqlite2.mts 实锤），r1 改文件直读后两档同命中。
    // 此断言=缺省档回归钉（谁改回投影读谁红）。
    delete process.env.CCR_STORAGE_READ_MODE; // 缺省=sqlite（read-mode resolveReadMode）
    assert(findInFlightByTriggerKey(tkProbe) === dQ, "缺省 sqlite 档查重命中（文件直读——投影失明免疫，P1-B 回归钉）");
    const projRows = readDispatchLog();
    console.log(`  · 缺省档投影行 ${projRows.length}，含键行 ${projRows.filter((r) => r.trigger_key).length}（sqlite=无列失明在案；driver 缺席降级 json 则带键——均非闸依赖面）`);
    process.env.CCR_STORAGE_READ_MODE = "json"; // 还原后续用例档位

    // ============ B 入口幂等（真 SessionManager 链） ============
    console.log("B 入口幂等（同键双发拒+回退口）:");
    const cfg: RelayConfig = { port: 8801, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeStuckFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "Leader 首建");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const anchor = mkdtempSync(join(tmpdir(), "domstep1-anchor-"));
    const cg = mgr.orgAction("project-create", { name: "domstep1 组", anchor, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(cg.ok === true, "组建");
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });
    const title = "domstep1 幂等验证单（卡死在途）";
    const d1 = mgr.orgAction("dispatch", { anchor, prompt: "卡死干活（不收工）", gid, title }) as { ok: boolean; dispatch_id?: string };
    assert(d1.ok === true, "首派 ok（在途单建立）");
    await waitFor(() => readDispatchLog().some((e) => e.id === d1.dispatch_id));
    const row1 = readDispatchLog().filter((e) => e.id === d1.dispatch_id).pop();
    assert(!!row1?.trigger_key && row1.trigger_key.startsWith("tk-"), `首行台账带 trigger_key（实 ${String(row1?.trigger_key)}）`);
    // 同键双发：第二单被拒
    const d2 = mgr.orgAction("dispatch", { anchor, prompt: "超时重发形态（同题）", gid, title }) as { ok: boolean; error?: string; duplicate_of?: string };
    assert(d2.ok === false, "同键双发第二单被拒（I2 入口幂等）");
    assert(!!d2.duplicate_of && d2.duplicate_of === d1.dispatch_id, `回执含在途单 id（duplicate_of=${String(d2.duplicate_of).slice(0, 8)}）`);
    assert(!!d2.error && d2.error.includes("幂等命中") && d2.error.includes(String(d1.dispatch_id).slice(0, 8)), `回执明示幂等命中（实 ${JSON.stringify((d2.error || "").slice(0, 60))}）`);
    const gateRow = readDispatchLog().filter((e) => e.target === "dispatch-gate" && e.status === "failed").pop();
    assert(!!gateRow?.trigger_key && gateRow.trigger_key === row1?.trigger_key, "拒收台账行在案且带同键（对账可见）");
    // 异题不误拦
    const d3 = mgr.orgAction("dispatch", { anchor, prompt: "另一件事", gid, title: "domstep1 异题单（不应拦）" }) as { ok: boolean };
    assert(d3.ok === true, "异题单不误拦（键=意图指纹非全局闸）");
    // 回退口：开关 off 双发都过
    writeFileSync(CFG, JSON.stringify({ dispatchIdempotency: false }));
    const d4 = mgr.orgAction("dispatch", { anchor, prompt: "回退口验证", gid, title }) as { ok: boolean; dispatch_id?: string };
    assert(d4.ok === true && d4.dispatch_id !== d1.dispatch_id, "开关 off=同键双发都过（dispatchIdempotency=false 回退口）");
    writeFileSync(CFG, "{}");
    // domstep1r1（P2-A① 验收点 2·真闸链）：单 d1 终态→redispatch_of 换题重投（新键 K2
    // 同 root 新段在途）→同新题超时重发查重命中被拒——返修单双开不拦的换题链闭环。
    // 终态行手造（真实链 closeOpenDispatches 终态行不带键；redispatch 新段行落新输入键）。
    appendDispatch({ ts: Date.now(), id: d1.dispatch_id!, tier: "轻立项", target: "spawn-pending", status: "done", receipt: "结果：完成", session_id: "s" });
    const reTitle = "domstep1 幂等验证单r1 返修（换题重投）";
    const d6 = mgr.orgAction("dispatch", { anchor, prompt: "换题重投干活（卡死在途）", gid, title: reTitle, redispatch_of: d1.dispatch_id }) as { ok: boolean; dispatch_id?: string; error?: string };
    assert(d6.ok === true, `终态后换题重投受理（redispatch_of 同 root 新段${d6.ok ? "" : "：" + String(d6.error).slice(0, 60)}）`);
    await waitFor(() => { const rows = readDispatchLog().filter((e) => e.id === d1.dispatch_id); return rows.some((e) => e.trigger_key && e.trigger_key !== row1?.trigger_key); });
    const reRows = readDispatchLog().filter((e) => e.id === d1.dispatch_id && e.trigger_key && e.trigger_key !== row1?.trigger_key);
    assert(reRows.length >= 1 && reRows[reRows.length - 1].trigger_key === dispatchTriggerKey({ gid, title: reTitle, prompt: "换题重投干活（卡死在途）" }), "重投新段行落新输入算的键（K2）——时序在案");
    const d7 = mgr.orgAction("dispatch", { anchor, prompt: "超时重发形态（同新题）", gid, title: reTitle }) as { ok: boolean; error?: string; duplicate_of?: string };
    assert(d7.ok === false && d7.duplicate_of === d1.dispatch_id, `换题重投后同新题（K2）重发查重命中拒（duplicate_of=${String(d7.duplicate_of).slice(0, 8)}）——I2 换题链闭环`);

    // ============ C Report 六态 ============
    console.log("C Report 六态（结构化优先+落账往返）:");
    assert(classifyReportStatus({ receipt: "正常交付", waitingCardRef: "wait-card:Bash" }).status === "waiting", "结构化卡压倒文本（有卡=waiting——即使文本无等待字样）");
    const wRef = classifyReportStatus({ receipt: "等待用户确认", waitingCardRef: "confirm:abc12345" });
    assert(wRef.status === "waiting" && wRef.confirm_ref === "confirm:abc12345", "waiting 带卡引用（confirm_ref 对账键）");
    const noCard = classifyReportStatus({ receipt: "结果：完成——但正文提了等待用户回复", waitingCardRef: null });
    assert(noCard.status === "progress" && !!noCard.note && noCard.note.includes("散文本不认"), `散文本 waiting 不认（→progress+备注，实 ${JSON.stringify(noCard)}）——反恒真面`);
    assert(classifyReportStatus({ receipt: "任务阻塞中", waitingCardRef: null }).status === "blocked", "blocked 识别");
    assert(classifyReportStatus({ receipt: "x", waitingCardRef: null, dispatchFailed: true }).status === "failed", "failed 终态优先");
    assert(classifyReportStatus({ receipt: "任务失败：无法修复，终局收工", waitingCardRef: null }).status === "failed", "失败词识别（domstep1r1 P2-A③——原「任务失败」回执误落 ready）");
    assert(classifyReportStatus({ receipt: "结果：失败分析报告已交付｜改动文件：a.ts", waitingCardRef: null }).status === "ready", "窄词表不误伤（「失败分析」正常交付=ready——失败词只在任务失败/无法完成/行首失败：形态）");
    assert(classifyReportStatus({ receipt: "已放弃处理", waitingCardRef: null }).status === "dropped", "dropped 识别");
    assert(classifyReportStatus({ receipt: "结果：完成｜改动文件：a.ts", waitingCardRef: null }).status === "ready", "正常交付=ready");
    // 落账往返
    const did = "dcb-" + randomUUID().slice(0, 8);
    appendDeliverCallback({ ts: Date.now(), dispatch_id: did, session_id: "s-w", via: "stop-hook", target: "pm", report_status: "waiting", confirm_ref: "wait-card:Edit" });
    const seen = deliverCallbackSeen(did) as { report_status?: string; confirm_ref?: string };
    assert(seen.report_status === "waiting" && seen.confirm_ref === "wait-card:Edit", "行往返六态字段持久（读回不丢）");
    // domstep1r1：抽样对账拆真——原样本=本测试自写字面量（1/1 自证）+「旧行无字段共存」
    // 恒真（|| true）双水分。改：样本经**生产分类器**产出（classifyReportStatus→落账与
    // session-manager 三写点同形）+ 混入散文本等待/失败词/正常交付异质行 + 直写旧形状
    // 行（无 report_status）验零迁移宽容。
    const mixed = [
      { receipt: "等待用户装机真验", waitingCardRef: "confirm:aa111111" as string | null },
      { receipt: "卡在审批工具上", waitingCardRef: "wait-card:Bash" as string | null },
      { receipt: "结果：完成——正文提了等待用户回复", waitingCardRef: null },
      { receipt: "任务失败：无法修复", waitingCardRef: null },
      { receipt: "结果：完成｜改动文件：a.ts", waitingCardRef: null },
    ];
    for (const m of mixed) {
      const cls = classifyReportStatus(m);
      appendDeliverCallback({ ts: Date.now(), dispatch_id: "dcb-mix-" + randomUUID().slice(0, 6), session_id: "s-w", via: "stop-hook", target: "pm", ...(cls.confirm_ref ? { confirm_ref: cls.confirm_ref } : {}), ...(cls.note ? { report_note: cls.note } : {}), report_status: cls.status });
    }
    appendFileSync(deliverCallbackLogPath(), JSON.stringify({ ts: Date.now(), dispatch_id: "dcb-legacy-" + randomUUID().slice(0, 6), session_id: "s-old", via: "stop-hook", target: "pm" }) + "\n", "utf-8");
    const allRows = readFileSync(deliverCallbackLogPath(), "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as { report_status?: string; confirm_ref?: string }[];
    const waitingRows = allRows.filter((r) => r.report_status === "waiting");
    assert(waitingRows.length >= 2 && waitingRows.every((r) => !!r.confirm_ref), `抽样对账：waiting 行 ${waitingRows.length}/${waitingRows.length} 100% 有 confirm_ref（样本经分类器产出+散文本/失败词异质行混入——无卡文本进不了 waiting）`);
    const noCardWaiting = mixed.filter((m) => !m.waitingCardRef && /等待|待确认/.test(m.receipt));
    assert(noCardWaiting.every((m) => classifyReportStatus(m).status !== "waiting"), "散文本等待行全部落在 waiting 外（progress/failed——反恒真对照在案）");
    assert(allRows.some((r) => !("report_status" in r)) && allRows.every((r) => typeof r === "object"), "旧形状行（无 report_status）在场共存且可解析（读侧宽容零迁移——真断言）");
    // domstep1r1（P2-A③ 验收点 3）：failed 位接线——注入失败回执→落 failed 非 ready
    //（stop-hook 先投 ready 形态 → 收口判 failed → amendFailedReport 末行赢修正）
    const didFail = "dcb-fail-" + randomUUID().slice(0, 6);
    appendDeliverCallback({ ts: Date.now(), dispatch_id: didFail, session_id: "s-w", via: "stop-hook", target: "pm", tier: "轻立项", delivered: false, report_status: "ready" });
    assert(amendFailedReport(didFail) === true, "收口判 failed → 修正行追加（amendFailedReport 单点）");
    const afterFail = deliverCallbackSeen(didFail) as { report_status?: string; delivered?: boolean };
    assert(afterFail.report_status === "failed", "注入失败回执→落 failed 非 ready（验收点 3——末行赢修正）");
    assert(afterFail.delivered === false && afterFail.report_status === "failed", "修正行保留投递位（delivered:false 不被洗——补扫面 undeliveredCallbacks 不受影响）");
    assert(amendFailedReport(didFail) === false, "已 failed 幂等（不重复修正）");
    assert(amendFailedReport("dcb-no-such-" + randomUUID().slice(0, 6)) === false, "无既有行 no-op（无回执的单不造行）");

    // ============ D 静态锁 ============
    console.log("D 挂键静态锁:");
    const smSrc = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf-8");
    const tkSrc = readFileSync(join(process.cwd(), "src", "trigger-key.ts"), "utf-8");
    assert(tkSrc.includes("无 Trigger 键不得") && tkSrc.includes("新增派单入口必须带 key"), "挂键纪律注释锚在（新增入口单点收口契约）");
    assert(tkSrc.includes("readDispatchLogFile") && !tkSrc.includes("readDispatchLog("), "查重读口=文件直读 readDispatchLogFile（P1-B 锁——改回投影读必红：sqlite 档失明）");
    assert(smSrc.includes("amendFailedReport(e.id)"), "收口 failed 接线在（P2-A③ 静态锁——notifyDispatchClosed failed 边）");
    assert(smSrc.includes("findInFlightByTriggerKey(triggerKey)") && smSrc.includes("readPluginConfig().dispatchIdempotency"), "入口闸引用单点查重+开关位");
    const rowHits = (smSrc.match(/trigger_key: triggerKey/g) || []).length + (smSrc.match(/trigger_key: dispatchTriggerKey\(input\)/g) || []).length;
    assert(rowHits >= 3, `台账落键点 ≥3（dispatched×2+queued×1，实 ${rowHits}）——新入口必须带 key 的静态锁`);
    assert(smSrc.includes("report_status: rep.status"), "回执三写点带六态位（skip/主行/补扫）");
    assert(smSrc.includes('import { dispatchTriggerKey, findInFlightByTriggerKey } from "./trigger-key.js"'), "import 单点（不旁路复制公式）");
    assert(PLUGIN_CFG_KEYS.includes("dispatchIdempotency" as never) && readPluginConfig().dispatchIdempotency === true, "第十一键注册+默认开");
  } finally {
    Object.keys(prev).forEach((k) => { process.env[k] = prev[k]; });
  }
  console.log(`\n========== domstep1 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
