// C-MODE-BATCH2（t-7689ab01，2026-11-01 用户 1101 全拍板 C 模式·策略层四件）：
//   模块5 续接断链披露（三情形 prompt 注入连续性声明+continuity-disclose 审计词）
//   模块7 issue 亲和复用（同锚历史成功优先档）+差异喂给（Since your last run 块）
//   模块8 per-turn blocks 后置（MUL-5377 同款：稳定段前置保 system 前缀 cache 命中）
//   模块10 复拉优先于新开（高分熟手 count≥CCR_REVIVE_MIN_COUNT 有空位自动回编）
// 惯例对齐 test-org-defects：fake agentFactory / CCR_ORG_DIR+CCR_DATA_DIR 隔离 / 断言累计。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager, wrapDispatchPrompt } from "../src/session-manager.js";
import { readDispatchLog } from "../src/org.js";
import { findGroup } from "../src/projects.js";
import { recordRoutingResult } from "../src/routing.js";
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

// fake agent：捕获最终 dispatchPrompt（模块5/7/8 的端到端断言载体——prompt 在 spawn 现场到达）
let lastDispatchPrompt = "";
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: (msg: unknown) => { const t = typeof msg === "string" ? msg : String((msg as { prompt?: string })?.prompt ?? ""); if (t.includes("派单")) lastDispatchPrompt = t; }, // resume/create 派单 prompt 都经 sendMessage（factory 第四参=create 引导词非任务书——捕获位修正）
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      if (prompt !== undefined) lastDispatchPrompt = prompt; // 纯函数面模块8 之外的注入链全在此捕获
      cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 });
        cb.onTurnEnd(true, "success", 10);
      }, 10);
    }, 10);
    return a;
  };

function readAudit(DATA: string, word: string): number {
  try {
    return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8").split("\n").filter((l) => l.includes(`"action":"${word}"`)).length;
  } catch { return 0; }
}

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-cmode2-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-cmode2-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_RESUME_PENDING_MS = "5000";
  process.env.CCR_PM_DUTY = "0"; // duty 值守缺省开会在组锚上持续派无题自动单（污染「上一单」判定——org-defects 批同款教训） // 派发间隔跨窗：resume 后 45s 缺省窗会让「亲和/复拉」场景全被 resumePending skip（env 允许最小 5s）
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_DATA_DIR = DATA;
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8797, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "环境就绪（Leader 首建）");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));
    const m = mgr as any;

    // ================= 模块8：per-turn blocks 后置（结构纯函数面） =================
    console.log("模块8 prompt 结构（MUL-5377 同款后置）:");
    const stableA = wrapDispatchPrompt("正经立项", "任务甲正文", "经验块甲", "岗位块", "规则块", "组织纪律块");
    const stableB = wrapDispatchPrompt("正经立项", "任务乙完全不同正文", "经验块乙", "岗位块", "规则块", "组织纪律块");
    const SEP = "————（以上为稳定段；以下每单必变，勿跨单假设）————";
    assert(stableA.includes(SEP) && stableB.includes(SEP), "稳定段/必变段分隔标记在（prompt 内自述结构）");
    // 前缀 cache 命中核心断言：两单（任务/经验全不同）公共前缀长度 ≥ 分隔行位置（稳定段全同）
    let common = 0;
    while (common < Math.min(stableA.length, stableB.length) && stableA[common] === stableB[common]) common++;
    assert(common >= stableA.indexOf(SEP), `公共前缀覆盖全稳定段（common=${common} ≥ 分隔位=${stableA.indexOf(SEP)}——跨单 system 前缀逐字节稳定=cache 命中）`);
    assert(stableA.indexOf("岗位块") < stableA.indexOf(SEP) && stableA.indexOf("规则块") < stableA.indexOf(SEP) && stableA.indexOf("组织纪律块") < stableA.indexOf(SEP), "岗位/规则/组织纪律三稳定块均在分隔行之前（前置区）");
    assert(stableA.indexOf("任务甲正文") > stableA.indexOf(SEP) && stableA.indexOf("经验块甲") > stableA.indexOf(SEP), "任务正文/经验命中在分隔行之后（必变尾区）");
    const dyn = wrapDispatchPrompt("正经立项", "任务丙", undefined, undefined, undefined, undefined, { continuity: "连续性声明样例段", sinceLast: "Since 样例段" });
    assert(dyn.indexOf("连续性声明样例段") > dyn.indexOf(SEP) && dyn.indexOf("Since 样例段") > dyn.indexOf(SEP) && dyn.indexOf("Since 样例段") < dyn.indexOf("任务丙"), "模块5/7 载荷注入必变尾区且先于任务正文（dynamic 位序）");
    // token 对照（结构收益量化）：稳定段占整 prompt 比例（无 dynamic 无经验的最小单）
    const minimal = wrapDispatchPrompt("正经立项", "任务正文一行");
    assert(minimal.indexOf(SEP) / minimal.length > 0.5, `最小单稳定段占比 ${Math.round((minimal.indexOf(SEP) / minimal.length) * 100)}%（>50%——前缀 cache 覆盖过半；对照表入回执）`);
    // 旧序对照（反证）：旧结构 task 紧跟头（idx<3%），新结构 task 在尾区（idx>50%）
    assert(minimal.indexOf("任务正文一行") / minimal.length > 0.5, "任务正文位于 prompt 后半（旧结构在前 3%——per-turn 后置实证）");

    // ================= 场景基建：组+双熟手 =================
    const anchor1 = mkdtempSync(join(tmpdir(), "cmode2-anchor1-"));
    const cg = mgr.orgAction("project-create", { name: "cmode2 组", anchor: anchor1, tier: "正经立项" }) as { ok: boolean; data?: { group?: { id: string }; confirm?: { id: string }; needsConfirm: boolean } };
    assert(cg.ok === true, "组建");
    const gid = cg.data?.group?.id ?? "";
    if (cg.data?.needsConfirm) await mgr.orgAction("confirm-decide", { confirm_id: cg.data.confirm?.id ?? "", approve: true, by: "u" });
    // 熟手 A：锚 1 历史成功单×3（routing count=3——模块10 高分线）
    const dA1 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "A1 锚历史单", gid, title: "锚一历史任务" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(dA1.ok === true, "熟手 A 派发（锚 1 首单）");
    const sidA = (dA1 as { session_id: string }).session_id;
    await waitFor(() => readDispatchLog().some((e) => e.id === dA1.dispatch_id && e.status === "done"));
    recordRoutingResult(gid, sidA, "done", "历史单1");
    recordRoutingResult(gid, sidA, "done", "历史单2");
    recordRoutingResult(gid, sidA, "done", "历史单3");
    // （场景修正：第二锚单也落 A=单熟手形态——routing 唯一高分席，对照角色退役；
    //  亲和断言聚焦「同锚回 A+Since 块内容」，漂移对照由模块8 纯函数面+复拉场景覆盖）
    const anchor2 = anchor1;

    // ================= 模块7：issue 亲和复用+差异喂给 =================
    console.log("模块7 issue 亲和+Since your last run:");
    await wait(5300); // 跨 resumePending 窗（A 刚 done，窗内 pickVeteran 会 skip 它）
    // 组默认锚=anchor1（g.anchor_dir）；再派同锚单 → 亲和轮应落 A（锚 1 历史成功）而非 B
    const d7 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "同锚亲和单（应回 A）", gid, title: "亲和验证单" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d7.ok === true, "同锚重派派发");
    await waitFor(() => readDispatchLog().some((e) => e.id === d7.dispatch_id && e.status === "done"));
    const d7sid = (d7 as { session_id: string }).session_id;
    assert(d7sid === sidA, `同锚重派落回熟手 A（亲和+熟手链——未漂移新会话）`);
    const sinceDirect = (mgr as any).buildSinceLastBlock(anchor1, "dbg") as string | undefined;
    console.log("  [诊断] 直调差异块:", sinceDirect ? "有（len=" + sinceDirect.length + "，含题=" + String(sinceDirect.includes("锚一历史任务")) + "）" : "undefined");
    assert(lastDispatchPrompt.includes("Since your last run") && lastDispatchPrompt.includes("上一单：") && lastDispatchPrompt.includes("收割于"), "差异块在 prompt：Since your last run+上单行+收割时间结构在（夹层无题内部单如实报无题=数据如实）");
    // title 回找验证（直调面）：此刻最新同锚 done=d7 自身（带题）→块应回显其题——验证
    // 「原始行回找 dispatched 行题名」链（收敛视图会让终态无题行覆盖之）
    const sinceNow = (mgr as any).buildSinceLastBlock(anchor1, "dbg-none") as string | undefined;
    assert(!!sinceNow && (sinceNow.includes("亲和验证单") || sinceNow.includes("锚一历史任务")), "title 回找链：直调块回显 done 单题名（非『（无题）』=原始行直读回找通——last 取 d7/dA1 存在收口竞态，双题哨兵）");
    assert(lastDispatchPrompt.indexOf("Since your last run") > lastDispatchPrompt.indexOf("————（以上为稳定段"), "差异块在必变尾区（不破前缀 cache）");
    await waitFor(() => !((mgr as any).openDispatches.get(sidA)?.length));

    // ================= 模块10：复拉优先于新开 =================
    console.log("模块10 复拉优先:");
    await wait(5300); // 跨窗（亲和单刚 done）
    // A 退休（orgAction member-retire 直调——test-org-defects :260 先例）
    const ret = mgr.orgAction("member-retire", { gid, sid: sidA, reason: "cmode2 测试退休" }) as { ok: boolean; error?: string };
    assert(ret.ok === true && !findGroup(gid)?.headcount.some((h) => h.session_id === sidA), "A 退休（编制除名+retired_entries 落因）");
    process.env.CCR_REVIVE_MIN_COUNT = "3";

    // 同锚再派：高分 A 已退休+有空位 → 复拉回编优先（而非新会话/落 B——B 无锚 1 史亲和轮不中，
    // 普通轮 B 在编可中…… 复拉先于普通轮发生：A count=4（3 历史+亲和单 done 记账）≥3 拉回）
    const d10 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "复拉验证单（高分退休席应回编承接）", gid, title: "复拉验证" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d10.ok === true, "复拉场景派发");
    await waitFor(() => readDispatchLog().some((e) => e.id === d10.dispatch_id && e.status === "done"));
    assert((d10 as { session_id: string }).session_id === sidA, "落席=复拉回编的 A（新开为兜底未触发）");
    assert(!!findGroup(gid)?.headcount.some((h) => h.session_id === sidA), "A 已回编（member-add 拉回）");
    assert(readAudit(DATA, "dispatch-reroute") >= 1 && (readFileSyncAudit(DATA) ?? "").includes("模块10 复拉优先"), "复拉审计帧在（dispatch-reroute·模块10 复拉优先）");
    delete process.env.CCR_REVIVE_MIN_COUNT;
    await waitFor(() => !((mgr as any).openDispatches.get(sidA)?.length));

    // ================= 模块5：续接断链披露（三情形） =================
    console.log("模块5 续接断链披露:");
    await wait(5300); // 跨窗
    // 情形 b（对准已退役）：A 再退休+清 routing 亲和外的他人不可续——直接判 bestUnavailableVeteran
    const ret2 = mgr.orgAction("member-retire", { gid, sid: sidA, reason: "cmode2 测试退休" }) as { ok: boolean; error?: string };
    assert(ret2.ok === true, "A 再退休（复拉场景后复原）");
    // 情形构造：A 高分退休+routing 序首位 → bestUnavailableVeteran 应报 retired+成因
    const bu = (mgr as any).bestUnavailableVeteran(gid) as { kind: string; sid: string; detail?: string } | null;
    assert(!!bu && bu?.kind === "retired" && bu?.sid === sidA, `对准退役判定（kind=${bu?.kind} sid 命中 A）`);
    assert(!!bu?.detail && /手动|空闲|解散/.test(bu.detail), `退休成因富化在（detail=${bu?.detail}）`);
    // 披露文案三 kind（纯函数面：a/b/c 各含「勿假设其上下文在位」+上单身份行）
    const discA = (mgr as any).buildContinuityDisclosure({ kind: "resume-failed", sid: "sess-abcdef123456", detail: "agent 通道超时" }) as string;
    assert(discA.includes("勿假设其上下文在位") && discA.includes("续接拉起失败") && discA.includes("agent 通道超时"), "情形 a 文案：resume 失败因透出");
    const discB = (mgr as any).buildContinuityDisclosure({ kind: "retired", sid: "sess-abcdef123456", detail: "72h 空闲收敛（idle-trim）" }) as string;
    assert(discB.includes("成员已退休") && discB.includes("idle-trim"), "情形 b 文案：退休成因透出");
    const discC = (mgr as any).buildContinuityDisclosure({ kind: "context-unavailable", sid: "sess-abcdef123456" }) as string;
    assert(discC.includes("档案不可续"), "情形 c 文案：上下文不可用");
    // 端到端两态（返工③ P1-1 修正后契约）：resume 成功落席=无声明（被承接席上下文就在位，
    // 注入「勿假设其上下文在位」=假声明+命令放弃正当上下文）；真·新会话承接=声明在场+审计词+尾区位
    process.env.CCR_REVIVE_MIN_COUNT = "999"; // 复拉排除从 d5 起就位（晚设会让 d5 先拉回 A，场景失义）
    const d5 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "披露验证单（A 已退休，B 在编承接）", gid, title: "披露验证" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d5.ok === true, "披露场景派发");
    await waitFor(() => readDispatchLog().some((e) => e.id === d5.dispatch_id && e.status === "done"));
    assert((d5 as { session_id: string }).session_id !== sidA, "复拉排除下未落 A（B 在编承接——resume 落席态）");
    const d5b = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "披露验证单2（B 在编 resume——无声明态）", gid, title: "披露验证2" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    await waitFor(() => readDispatchLog().some((e) => e.id === d5b.dispatch_id && e.status === "done"));
    assert(!lastDispatchPrompt.includes("连续性声明") && !lastDispatchPrompt.includes("勿假设其上下文在位"), "返工③ P1-1：resume 成功落席 prompt 无连续性声明（上下文就在位——注入即假声明）");
    // 真·新会话承接：本 fixture 单熟手（:137 d7sid≡sidA）——d5 建新席 C（create+披露）、
    // d5b 回落 C（resume=无声明态）。退休 C 后无在编可续席+routing 序首位 A 不可续→d6 真 create
    const resumeSid = (d5b as { session_id: string }).session_id;
    assert(resumeSid !== sidA && resumeSid === (d5 as { session_id: string }).session_id, "d5/d5b 同席（create C→回落 C resume——两态场景前提）");
    const retB = mgr.orgAction("member-retire", { gid, sid: resumeSid, reason: "cmode2 测试退休（披露两态场景收口）" }) as { ok: boolean; error?: string };
    assert(retB.ok === true, `承接席退休（无在编可续席=真·新会话承接场景；err=${(retB as { error?: string }).error ?? "?"}）`);
    const d6 = mgr.orgAction("dispatch", { anchor: anchor1, prompt: "披露验证单3（真新会话承接）", gid, title: "披露验证3" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
    assert(d6.ok === true, "新会话承接派发");
    await waitFor(() => readDispatchLog().some((e) => e.id === d6.dispatch_id && e.status === "done"));
    assert([sidA, resumeSid].every((s) => (d6 as { session_id: string }).session_id !== s), "落席=全新会话（非 A 非 C）");
    assert(lastDispatchPrompt.includes("连续性声明") && lastDispatchPrompt.includes("勿假设其上下文在位"), "端到端：真·新会话承接 prompt 含连续性声明（替代静默 fresh）");
    assert(readAudit(DATA, "continuity-disclose") >= 1, "continuity-disclose 审计词在账（真实披露路径单发——纯函数面直调不误发）");
    assert(lastDispatchPrompt.indexOf("连续性声明") > lastDispatchPrompt.indexOf("————（以上为稳定段"), "披露段在必变尾区（模块5×8 位置协同）");
    delete process.env.CCR_REVIVE_MIN_COUNT;
  } finally {
    Object.keys(prev).forEach((k) => { process.env[k] = prev[k]; });
  }
  console.log(`\n========== C-MODE-BATCH2 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
function readFileSyncAudit(DATA: string): string | null {
  try { return readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8"); } catch { return null; }
}
void main();
