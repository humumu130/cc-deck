// W-PRBACKFLOW（期一末跳，1104 用户问「评论了之后会有对应的人去处理吗」）——
// PR 评论回流套件（Trigger→Subscription 直达交付 worker，DS 末跳）。
// 覆盖（agentFactory 测试缝；in_review 台账行=文件级夹具——该状态由 prreview 批
// a557e151 引入，未收编基线上 appendDispatch 词表拒写，生产写者随彼批收编就位）：
//   A 直投：in_review 单新评论 → 交付会话 [待确认] 定向（文本含 PR 链接+comment id）+
//     cursor 落账（时序证据含 comment id——验收点 1）
//   B 幂等：同评论不重投（cursor 推进后仅新 id 投递——I2）
//   C 终态回落：done 单评论 → 不投 worker、PM（leader）收 [待确认]（验收点 2）
//   D gh 失败：fetch 抛错=该行跳过零异常（observe/patrol 档纪律——验收点 3）
//   E observe 档：干跑记账不投递不进 cursor；转 auto 补投积压（observe=看清不是消费）
//   F off 档：零研判零抓取（fetcher 不被调）
//   G subfanout 白名单：in_review 命中直投目标；终态 null
//   H 收集口径：无 URL 的 in_review 不拉；终态窗外旧单不拉
//   I 挂档静态自锁：pr-comment-trigger 引用 autoTierOf("patrol")（observe3 挂档纪律第三处）
//   J R1 翻页（双审 P2·1104）：伪 gh 直测真 fetchPrCommentsViaGh——35 条夹具
//     （>30 越缺省页）全量可见 + args 三要素锚（per_page=100/--paginate/-X GET 防 POST 漂移）
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { subFanTarget } from "../src/subfanout.js";
import { collectPrWatchRows, fetchPrCommentsViaGh, readPrCommentCursor, type PrComment } from "../src/pr-comment-trigger.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}` + (detail ? "｜" + detail : "")); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// 假 agent 工厂（test-dispatch/prreview 同款语义缩样）：spawn 10ms 后 onStats+onTurnEnd
type SpawnRec = { cwd: string; prompt: string | undefined; cb: AgentCallbacks; agent: AgentLike; resume?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, _model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { permissionMode?: string; resume?: string }): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {
        setTimeout(() => {
          if (a.ended) return;
          cb.onStats({ files_changed: 1, lines_added: 2, lines_deleted: 1 });
          cb.onTurnEnd(true, "success", 12);
        }, 10);
      },
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    created.push({ cwd, prompt, cb, agent: a, resume: opts?.resume });
    setTimeout(() => cb.onInit("sdk-" + a.id.slice(0, 8), "test-model", "bypassPermissions"), 20);
    if (prompt) setTimeout(() => {
      if (a.ended) return;
      cb.onStats({ files_changed: 1, lines_added: 2, lines_deleted: 1 });
      cb.onTurnEnd(true, "success", 12);
    }, 10);
    return a;
  };

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-prbf-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-prbf-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  const prevReadMode = process.env.CCR_STORAGE_READ_MODE;
  const prevTier = process.env.CCR_AUTO_TIER_PATROL;
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_AUTO_TIER_PATROL = "auto";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const anchor = join(DATA, "proj-prbf");
    mkdirSync(anchor, { recursive: true });
    const created: SpawnRec[] = [];
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory(created));
    const r0 = mgr.ensureLeader();
    assert(r0.ok === true, "环境就绪（Leader 首建——PM 回落位）");
    const leaderSid = (mgr as unknown as { getLeaderSessionId(): string | null }).getLeaderSessionId() ?? "";
    await waitFor(() => mgr.snapshot().find((s) => s.status === "DONE" && s.done_reason === "success") !== undefined);

    // ---------- 夹具：worker w1 + 台账行（文件级：in_review 行由 prreview 批写入面，基线上手写） ----------
    const d = mgr.orgAction("dispatch", { anchor, prompt: "w1 交付单（PR 回流夹具）" }) as { ok: boolean; session_id?: string; error?: string };
    assert(d.ok === true, "w1 会话就绪（交付者位）");
    const w1 = d.ok ? (d.session_id ?? "") : "";
    await waitFor(() => mgr.snapshot().find((s) => s.session_id === w1)?.status === "DONE");
    const PR1 = "https://github.com/humumu130/cc-deck/pull/9001";
    const PR2 = "https://github.com/humumu130/cc-deck/pull/9002";
    const now = Date.now();
    const row = (o: Record<string, unknown>) => appendFileSync(join(ORG, "dispatch-log.ndjson"), JSON.stringify(o) + "\n", "utf-8");
    row({ ts: now - 60_000, id: "d-prbf-1", tier: "正经立项", target: w1, status: "done", receipt: "结果：交付完成（PR 在审）", session_id: w1, title: "PRBF 直投单" });
    row({ ts: now - 30_000, id: "d-prbf-1", tier: "正经立项", target: w1, status: "in_review", receipt: `PR ${PR1} 互审发起（1 审）`, session_id: w1, title: "PRBF 直投单" });
    row({ ts: now - 30_000, id: "d-prbf-2", tier: "正经立项", target: w1, status: "done", receipt: `结果：已收割（晚评场景）｜PR ${PR2}`, session_id: w1, title: "PRBF 终态单" });
    row({ ts: now - 30_000, id: "d-prbf-3", tier: "正经立项", target: w1, status: "in_review", receipt: "互审发起（无 PR URL——不拉）", session_id: w1, title: "PRBF 无链单" });
    row({ ts: now - 25 * 60 * 60 * 1000, id: "d-prbf-old", tier: "正经立项", target: w1, status: "done", receipt: `结果：旧单｜PR https://github.com/humumu130/cc-deck/pull/8000`, session_id: w1, title: "PRBF 窗外旧单" });

    // ---------- H 收集口径（先断言轮询集形状再跑周期） ----------
    console.log("H 收集口径：");
    const rowsH = collectPrWatchRows(ORG);
    assert(rowsH.length === 2 && rowsH.some((x) => x.dispatchId === "d-prbf-1" && x.status === "in_review") && rowsH.some((x) => x.dispatchId === "d-prbf-2" && x.status === "done"),
      "轮询集=in_review 带 URL + 终态窗内带 URL 恰两行（无 URL/窗外旧单不拉）");

    // ---------- G subfanout 白名单 ----------
    console.log("G subfanout 白名单：");
    const g1 = subFanTarget("d-prbf-1", ORG);
    assert(!!g1 && g1.sessionId === w1 && (g1.status as string) === "in_review", "in_review 命中直投目标（白名单+订阅续期——交付者承接；stringly——该态由 prreview 批引入，基线联合类型无此值）");
    assert(subFanTarget("d-prbf-2", ORG) === null, "终态 null（回落 PM——不投 worker）");

    // ---------- 抓取缝：可变评论库 ----------
    let fetchCalls = 0;
    let store: Record<string, PrComment[]> = {};
    const mkComment = (id: number, body: string): PrComment => ({ id, author: "reviewer-x", body, createdAt: "2026-11-04T12:00:00Z" });
    mgr.prCommentFetcher = async (url) => {
      fetchCalls++;
      const list = store[url];
      if (!list) throw new Error("gh api 拉评论失败: 模拟 gh 缺席（fetch 抛错场景）");
      return list;
    };
    const todosOf = (sid: string) => (mgr.snapshot().find((s) => s.session_id === sid)?.todos ?? []);
    const todoTexts = (sid: string) => todosOf(sid).map((t) => t.content).join("\n");

    // ---------- A 直投（验收点 1） ----------
    console.log("A 直投：");
    store = { [PR1]: [mkComment(100, "P1：relay/src/x.ts:42 边界漏判——请返修")] };
    const resA = await mgr.runPrCommentCycleOnce();
    assert(resA.off === false && resA.delivered === 1 && resA.pmFallback === 0, "直投 1 条（in_review 单评论→交付会话）");
    assert(todoTexts(w1).includes("[待确认] PR 评论回流"), "定向文本：[待确认] 前缀+回流标记（返修单语义）");
    assert(todoTexts(w1).includes(`${PR1}#issuecomment-100`), "定向文本：PR 链接锚到具体评论（comment id 可溯）");
    assert(todoTexts(w1).includes("P1：relay/src/x.ts:42"), "定向文本：评论摘要在场（正文透传）");
    assert(todoTexts(w1).includes("按评论返修或回复"), "定向文本：行动指引（返修/回复）");
    assert((readPrCommentCursor(ORG)["d-prbf-1"] ?? 0) === 100, "cursor 落账 d-prbf-1=100（幂等账）");

    // ---------- B 幂等（验收点 1 后半） ----------
    console.log("B 幂等：");
    const countOccurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
    const beforeB = todosOf(w1).length;
    const c100Before = countOccurrences(todoTexts(w1), "issuecomment-100");
    store = { [PR1]: [mkComment(100, "P1：relay/src/x.ts:42 边界漏判——请返修"), mkComment(200, "追问：补个断言")] };
    const resB = await mgr.runPrCommentCycleOnce();
    assert(resB.delivered === 1 && todosOf(w1).length === beforeB + 1 && todoTexts(w1).includes("#issuecomment-200"),
      "同评论不重投：仅新 id 200 投递（todo 恰 +1，含 200）");
    assert(countOccurrences(todoTexts(w1), "issuecomment-100") === c100Before, "旧评论 100 零重复出现（出现次数不变——I2 实证）");
    assert((readPrCommentCursor(ORG)["d-prbf-1"] ?? 0) === 200, "cursor 推进 200（I2：同 comment id 只投一次）");

    // ---------- C 终态回落 PM（验收点 2） ----------
    console.log("C 终态回落：");
    const w1Before = todosOf(w1).length;
    const pmBefore = todosOf(leaderSid).length;
    store = { [PR1]: [], [PR2]: [mkComment(300, "晚到评论：收割后补问")] };
    const resC = await mgr.runPrCommentCycleOnce();
    assert(resC.delivered === 0 && resC.pmFallback === 1, "终态单评论不投 worker（delivered=0）且回落 PM=1");
    assert(todosOf(w1).length === w1Before && todosOf(leaderSid).length === pmBefore + 1 && todoTexts(leaderSid).includes("#issuecomment-300"),
      "PM（leader）收到 [待确认]（含评论锚链）——worker 侧零打扰");

    // ---------- D gh 失败=周期跳过零异常（验收点 3） ----------
    console.log("D gh 失败：");
    store = {};
    let threw = false;
    const resD = await mgr.runPrCommentCycleOnce().catch(() => { threw = true; return null; });
    assert(!threw && resD !== null && resD.skippedGh === 2 && resD.delivered === 0, "两行 PR 均拉取失败=各自跳过（skippedGh=2），周期零异常零投递");

    // ---------- E observe 档：干跑记账不消费 ----------
    console.log("E observe 档：");
    process.env.CCR_AUTO_TIER_PATROL = "observe";
    store = { [PR1]: [mkComment(100, "P1：relay/src/x.ts:42 边界漏判——请返修"), mkComment(200, "追问：补个断言"), mkComment(400, "observe 档干跑位")] };
    const resE = await mgr.runPrCommentCycleOnce();
    assert(resE.observeWouldDo === 1 && resE.delivered === 0, "observe=只记 would-do 不投递（新评论 400 一条干跑）");
    assert((readPrCommentCursor(ORG)["d-prbf-1"] ?? 0) === 200, "observe 不进 cursor（不消费——转 auto 可补投）");
    assert(existsSync(join(DATA, "observe-log.ndjson")) && readFileSync(join(DATA, "observe-log.ndjson"), "utf-8").includes("pr-comment"), "干跑证据落 observe-log（时序证据链）");
    const w1BeforeE = todosOf(w1).length;
    process.env.CCR_AUTO_TIER_PATROL = "auto";
    const resE2 = await mgr.runPrCommentCycleOnce();
    assert(resE2.delivered === 1 && todosOf(w1).length === w1BeforeE + 1 && todoTexts(w1).includes("#issuecomment-400"),
      "转 auto 后积压补投（comment 400 到达——observe 是看清不是消费）");

    // ---------- F off 档：零研判零抓取 ----------
    console.log("F off 档：");
    process.env.CCR_AUTO_TIER_PATROL = "off";
    const callsBeforeF = fetchCalls;
    const resF = await mgr.runPrCommentCycleOnce();
    assert(resF.off === true && fetchCalls === callsBeforeF, "off=整周期零研判零抓取（fetcher 不被调——完全黑）");
    process.env.CCR_AUTO_TIER_PATROL = "auto";

    // ---------- I 挂档静态自锁（observe3 挂档纪律第三处） ----------
    console.log("I 挂档静态锁：");
    const trigSrc = readFileSync(join(process.cwd(), "src", "pr-comment-trigger.ts"), "utf-8");
    const smSrc = readFileSync(join(process.cwd(), "src", "session-manager.ts"), "utf-8");
    const idxSrc = readFileSync(join(process.cwd(), "src", "index.ts"), "utf-8");
    assert(trigSrc.includes('autoTierOf("patrol")'), "pr-comment-trigger 引用 autoTierOf 单点（挂档纪律）");
    assert(smSrc.includes("runPrCommentCycleOnce") && idxSrc.includes("startPrCommentWatch"), "消费面挂载在位（session-manager 周期法 + index boot 启停）");

    // ---------- J R1 翻页（双审 P2·1104）：per_page=100 + --paginate 全量可见 ----------
    // 病：GitHub REST 缺省 30 条/页升序——热 PR 首周期只投最旧 ≤30 条后 cursor 定格，
    // 第 2 页新评论永不可见=永久失聪零报错。根治=gh args 带 per_page=100+--paginate
    //（翻页拼接是 gh 客户端语义，stdout 恒合并数组）。测法=伪 gh（PATH 前置）直测真
    // fetchPrCommentsViaGh：35 条夹具（>30 越缺省页）全量解析 + args 三要素逐项锚。
    console.log("J R1 翻页（35 条夹具·伪 gh 直测真函数）:");
    {
      const fakeDir = mkdtempSync(join(tmpdir(), "ccr-prbf-gh-"));
      const fixture = join(fakeDir, "page.json");
      const rec = join(fakeDir, "args.txt");
      // 35 条拼接数组=gh --paginate 最终 stdout 形状（页 1×30+页 2×5 客户端拼接后单数组）
      const comments35 = Array.from({ length: 35 }, (_, i) => ({ id: 1000 + i, user: { login: "reviewer-x" }, body: `第 ${i + 1} 条评论（翻页夹具）`, created_at: "2026-11-04T12:00:00Z" }));
      writeFileSync(fixture, JSON.stringify(comments35), "utf-8");
      writeFileSync(join(fakeDir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${rec}"\ncat "${fixture}"\n`, "utf-8");
      chmodSync(join(fakeDir, "gh"), 0o755);
      const prevPath = process.env.PATH;
      process.env.PATH = fakeDir + ":" + (prevPath ?? "");
      try {
        const out = await fetchPrCommentsViaGh("https://github.com/humumu130/cc-deck/pull/9100");
        assert(out.length === 35, "35 条夹具全量可见（>30 越缺省页——翻页拼接后零丢失）", `n=${out.length}`);
        assert(out[0]?.id === 1000 && out[34]?.id === 1034, "首尾对号（升序完整性：1000…1034）");
        assert(out.every((c) => c.author === "reviewer-x" && c.body.includes("条评论")), "字段解析完整（author/body 逐条）");
        const ghArgs = readFileSync(rec, "utf-8");
        assert(ghArgs.includes("per_page=100"), "gh args 带 per_page=100（缺省 30 失聪根治）", ghArgs.trim());
        assert(ghArgs.includes("--paginate"), "gh args 带 --paginate（第 2 页起可见性=gh 客户端翻页保证）");
        assert(ghArgs.includes("-X") && ghArgs.includes("GET"), "gh args 显式 -X GET（带 -F 时 gh 缺省切 POST——防漂移钉死）");
        const bad = await fetchPrCommentsViaGh("https://gitlab.com/x/y/pull/1").then(() => null, (e: Error) => e.message);
        assert(!!bad && bad.includes("不合法"), "非 github.com URL 拒（回归护栏——翻页改动不动 URL 校验）");
      } finally {
        if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
        rmSync(fakeDir, { recursive: true, force: true });
      }
    }

    console.log(`\nPASS: ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN; else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwdEnv === undefined) delete process.env.CCR_CWD; else process.env.CCR_CWD = prevCwdEnv;
    if (prevReadMode === undefined) delete process.env.CCR_STORAGE_READ_MODE; else process.env.CCR_STORAGE_READ_MODE = prevReadMode;
    if (prevTier === undefined) delete process.env.CCR_AUTO_TIER_PATROL; else process.env.CCR_AUTO_TIER_PATROL = prevTier;
    rmSync(ORG, { recursive: true, force: true });
    rmSync(DATA, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("套件炸了:", e); process.exit(1); });
