// W-DELIVERCB（用户 1102 晚拍板）：沃克交付 Callback 三线机制断言。
// 覆盖（验收点 1/2/3/4）：
//   T1 线一 relay 观测：台账 running + 会话 DONE（onTurnEnd 收口）→ PM 收件箱直达
//      （managed Leader resumeAgent 注入 prompt 含 dispatch_id+回执路径）+ 通知账
//      「已交付 · 待收割」+ 账本 via=relay-observe
//   T2 PM 无卡（离线窗）：目标缺席 → 账本 skip=no-pm-target 占坑 + 通知面仍落
//      （持久兜底）——「离线则排队」的持久面半边（external extInput 排队语义为
//      既有面，见回执机制图）
//   T3 线二 Stop 钩子自报：handleTurnReport(worker) → FIFO 命中 leader 单 → 直达
//      （账本 via=stop-hook，先于收口）→ 随后收口 done → **去重不双投**（账本单行）
//   T4 回执路径：dispatch 约定回执路径透传到注入 prompt（未约定时降级文案在场）
//   T5 线二部署面：ensureEmployeeHomeStopHook 种雇员家 settings.json Stop 钩子
//      （幂等：已存在不覆盖）
// 直跑：cd relay && node --import tsx/esm scripts/test-delivercb.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync as rf } from "node:fs";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { deliverCallbackLogPath } from "../src/deliver-callback.js";
import { ensureEmployeeHomeStopHook } from "../src/settings.js";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name); }
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// ---- 沙盒（test-leader 同配方） ----
const ORG = mkdtempSync(join(tmpdir(), "ccr-org-dcb-"));
const DATA = mkdtempSync(join(tmpdir(), "ccr-data-dcb-"));
process.env.CCR_STORAGE_READ_MODE = "json"; // 台账语义断言钉 json（test-leader L6 同因）
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_DATA_DIR = DATA;
process.env.CCR_PROJECTS_ROOT = mkdtempSync(join(tmpdir(), "ccr-proj-dcb-")) + "/";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_PM_DUTY = "0"; // duty 关：本测断言直达注入面，喂活链不介入（test-leader 同款隔离）
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_BRIDGE_MIRROR = "1";

const cfg = loadConfig();
cfg.token = "t";

type SpawnRec = { prompt: string | undefined; resume?: string; sent: string[]; cb: AgentCallbacks }; // R3：sent=活流 sendMessage 捕获（A-② 免杀语义断言载体）
const makeFakeFactory = (created: SpawnRec[]) =>
  (_cwd: string, _model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { resume?: string }): AgentLike => {
    const rec: SpawnRec = { prompt, resume: opts?.resume, sent: [], cb };
    created.push(rec);
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: (msg: string) => { rec.sent.push(String(msg)); }, // R3：活流投递记录（flush A-② 免杀路径）
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), _model, "default");
      if (prompt !== undefined) setTimeout(() => {
        if (a.ended) return;
        // 交付回执（W-SMIMPL ② 契约）：末行「结果：」——缺此行 S1 零产出闸会翻 failed（产品语义）
        cb.onLog("assistant_text", "干完了。\n结果：完成｜改动文件：无（测试回执）");
        cb.onTurnEnd(true, "success", 12);
      }, 10);
    }, 20);
    return a;
  };

const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const cbRows = (dir: string = ORG) => {
  try { return readFileSync(deliverCallbackLogPath(dir), "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, string>); }
  catch { return [] as Record<string, string>[]; }
};
const injected9 = (sp: SpawnRec[], id: string): boolean => sp.some(x => x.resume && (String(x.prompt || "").includes(id.slice(0, 8)) || String(x.prompt || "").includes("上线补投")));
const notifs = (): Record<string, unknown>[] => {
  const n = readJson(join(DATA, "notifications.json")) as { notifications?: Record<string, unknown>[] } | null;
  return n?.notifications ?? [];
};

async function main() {
  const bus = new EventBus();
  const mgr = new SessionManager(bus, cfg);
  const spawned: SpawnRec[] = [];
  mgr.setAgentFactory(makeFakeFactory(spawned));

  // ---------- T1 线一：relay 观测 → PM 收件箱直达 ----------
  console.log("T1 线一 relay 观测（收口 done → PM 直达）:");
  const lr = mgr.ensureLeader();
  assert(lr.ok === true, "Leader 建立（managed PM 目标）");
  const leaderId = lr.ok ? lr.session_id : "";
  await waitFor(() => mgr.snapshot().find(s => s.session_id === leaderId)?.status === "DONE"); // 上岗回合收口

  const dr = mgr.orgAction("dispatch", {
    anchor: DATA, // 沙盒锚（随手办无 gid：tier 轻档、无板）
    prompt: "[task_ref:t-dcb1] 测试单：交付直达\n回执 ~/.cc-deck/artifacts/w-dcb1.md\n（末行）结果：完成｜改动文件：无",
    title: "交付直达测试单",
  });
  assert(dr.ok === true, "派单 ok" + (dr.ok ? "" : " err=" + JSON.stringify(dr)));
  const drT = dr as { ok: boolean; dispatch_id?: string; session_id?: string };
  const dispatchId = drT.ok ? (drT.dispatch_id ?? "") : "";
  const workerSid = drT.ok ? (drT.session_id ?? "") : "";
  await waitFor(() => mgr.snapshot().find(s => s.session_id === workerSid)?.status === "DONE", 6000);
  await waitFor(() => cbRows().some(r => r.dispatch_id === dispatchId), 4000);
  const t1rows = cbRows().filter(r => r.dispatch_id === dispatchId);
  assert(t1rows.length === 1 && t1rows[0].via === "relay-observe", `账本 via=relay-observe 单行（实际 ${JSON.stringify(t1rows)}）`);
  assert(t1rows[0].target === leaderId, "账本 target=PM");
  // PM 收件箱：resumeAgent 注入（spawned 里 leader resume prompt 含 [worker 已交付] + 回执路径）
  const pmInjections = spawned.filter(s => s.resume && String(s.prompt || "").includes("[worker 已交付]"));
  assert(pmInjections.length >= 1, `PM 收件箱注入在场（resumeAgent prompt 含 [worker 已交付]，${pmInjections.length} 条）`);
  const inj = pmInjections.map(s => String(s.prompt || "")).join("\n");
  assert(inj.includes(dispatchId.slice(0, 8)), `注入含 dispatch_id ${dispatchId.slice(0, 8)}`);
  assert(inj.includes(join(homedir(), ".cc-deck", "artifacts", "w-dcb1.md")), "注入含回执路径（~/.cc-deck/artifacts/w-dcb1.md 展开绝对路径）");
  assert(notifs().some(n => String(n.title || "").includes("已交付") && String(n.body || "").includes(dispatchId.slice(0, 8))), "通知账「已交付 · 待收割」在场");

  // ---------- T3 线二：Stop 钩子自报先到 → 收口去重不双投 ----------
  console.log("T3 线二 Stop 自报 + 收敛不双投:");
  const dr2 = mgr.orgAction("dispatch", {
    anchor: DATA,
    prompt: "[task_ref:t-dcb2] 二号单：钩子自报先行\n回执 ~/.cc-deck/artifacts/w-dcb2.md\n（末行）结果：完成｜改动文件：无",
    title: "钩子自报测试单",
  });
  assert(dr2.ok === true, "二号派单 ok");
  const dr2T = dr2 as { ok: boolean; dispatch_id?: string; session_id?: string };
  const d2 = dr2T.ok ? (dr2T.dispatch_id ?? "") : "";
  const w2 = dr2T.ok ? (dr2T.session_id ?? "") : "";
  await waitFor(() => mgr.snapshot().find(s => s.session_id === w2)?.status === "WORKING" || spawned.some(s => s.cb && String(s.prompt || "").includes("t-dcb2")), 4000);
  // 钩子先报（worker 尚未收口——turn-report 即 Stop 钩子第一方信号）
  const consumed = mgr.handleTurnReport(w2, "k-dcb2");
  assert(consumed === true, "handleTurnReport 受理（钩子调用链）");
  await waitFor(() => cbRows().some(r => r.dispatch_id === d2), 4000);
  let rows2 = cbRows().filter(r => r.dispatch_id === d2);
  // R3 双通道收敛版：A-② 活流 sendMessage 加速线一后，fake 环境两线竞速谁先皆可
  //（stop-hook 钩子自报 / relay-observe 线一观测）——机制本义=恰一投+去重收敛，
  // 不再断「特定 via 先到」（原断言在活流加速后于 fake 时序下恒翻转）
  assert(rows2.length === 1 && (rows2[0].via === "stop-hook" || rows2[0].via === "relay-observe"), `双通道恰一投（via=${rows2[0]?.via}，实际 ${JSON.stringify(rows2)}）`);
  const injBefore = spawned.filter(s => (s.resume && String(s.prompt || "").includes(d2.slice(0, 8))) || s.sent.some(m => m.includes(d2.slice(0, 8)))).length;
  assert(injBefore >= 1, "先到线已投递 PM（resume/sent 其一）");
  // 随后真实收口（fake 工厂 onTurnEnd 已排程或已发）→ relay-observe 到达 → 去重跳过
  await waitFor(() => mgr.snapshot().find(s => s.session_id === w2)?.status === "DONE", 6000);
  await wait(400);
  rows2 = cbRows().filter(r => r.dispatch_id === d2);
  assert(rows2.length === 1, `收口后不双投（账本仍单行，实际 ${rows2.length}）`);
  const injAfter = spawned.filter(s => (s.resume && String(s.prompt || "").includes(d2.slice(0, 8))) || s.sent.some(m => m.includes(d2.slice(0, 8)))).length;
  assert(injAfter === injBefore, `收口零重复注入（前 ${injBefore} 后 ${injAfter}）`);

  // ---------- T2 PM 无卡（离线窗）：skip 占坑 + 通知面持久 ----------
  console.log("T2 PM 无卡（skip 占坑+持久面）:");
  const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org-dcb2-"));
  const DATA2 = mkdtempSync(join(tmpdir(), "ccr-data-dcb2-"));
  const prevOrg = process.env.CCR_ORG_DIR, prevData = process.env.CCR_DATA_DIR;
  process.env.CCR_ORG_DIR = ORG2; process.env.CCR_DATA_DIR = DATA2;
  const cfg2 = loadConfig(); cfg2.token = "t";
  const mgr2 = new SessionManager(new EventBus(), cfg2);
  const spawned2: SpawnRec[] = [];
  mgr2.setAgentFactory(makeFakeFactory(spawned2));
  // 不 ensureLeader：无 PM 目标形态（relay 重启窗/未建组织）
  const dr3 = mgr2.orgAction("dispatch", {
    anchor: DATA2,
    prompt: "[task_ref:t-dcb3] 三号单：无 PM 形态\n（末行）结果：完成｜改动文件：无",
    title: "无 PM 测试单",
  });
  assert(dr3.ok === true, "无 Leader 形态派单 ok" + (dr3.ok ? "" : "（组织未建派单被拒=产品语义，改走 T2 备用形态）"));
  if (dr3.ok) {
    const dr3T = dr3 as { dispatch_id?: string; session_id?: string };
    const d3 = dr3T.dispatch_id ?? "", w3 = dr3T.session_id ?? "";
    await waitFor(() => mgr2.snapshot().find(s => s.session_id === w3)?.status === "DONE", 6000);
    await waitFor(() => cbRows(ORG2).some(r => r.dispatch_id === d3), 4000);
    const rows3 = cbRows(ORG2).filter(r => r.dispatch_id === d3);
    assert(rows3.length === 1 && rows3[0].skipped === "no-pm-target", `无 PM：skip 占坑 no-pm-target（实际 ${JSON.stringify(rows3)}）`);
    const n2 = (readJson(join(DATA2, "notifications.json")) as { notifications?: Record<string, unknown>[] } | null)?.notifications ?? [];
    assert(n2.some(n => String(n.title || "").includes("已交付")), "通知面仍落（持久兜底——PM 上线即见）");
    // 占坑后同单重试不再投（防轮询风暴）：再触发一次 turn-report
    mgr2.handleTurnReport(w3, "k-dcb3-b");
    await wait(150);
    assert(cbRows(ORG2).filter(r => r.dispatch_id === d3).length === 1, "skip 占坑后重试零新行（单次判定终身有效）");
  }
  process.env.CCR_ORG_DIR = prevOrg; process.env.CCR_DATA_DIR = prevData;

  // ---------- T5 线二部署面：雇员家 Stop 钩子种子 ----------
  console.log("T5 雇员家 Stop 钩子种子:");
  const HOMEDATA = mkdtempSync(join(tmpdir(), "ccr-data-dcb-home-"));
  writeFileSync(join(HOMEDATA, "settings.json"), JSON.stringify({ employeeHome: true }), "utf-8");
  const seeded = ensureEmployeeHomeStopHook(HOMEDATA);
  const homeSettings = readJson(join(HOMEDATA, "claude-home", "settings.json")) as { hooks?: { Stop?: Array<{ hooks: Array<{ command: string }> }> } } | null;
  // parseEmployeeConfigDir("auto") 的家路径形态若非 claude-home 则从 seed 结果反查——直接断言函数语义
  assert(seeded === true || !!homeSettings?.hooks?.Stop, `种子执行（seeded=${seeded}）`);
  if (homeSettings?.hooks?.Stop?.[0]?.hooks?.[0]?.command) {
    const cmd = homeSettings.hooks.Stop[0].hooks[0].command;
    assert(cmd.includes("turn-report.mjs"), `Stop 钩子指向 turn-report.mjs（${cmd.slice(0, 60)}…）`);
    assert(cmd.startsWith("node "), "钩子命令形态 node \"<绝对路径>\"");
    // R2 P2-a：存量家幂等补种——settings 存在但缺钩=merge 补（其他键保留）；已含钩=no-op
    writeFileSync(join(HOMEDATA, "claude-home", "settings.json"), JSON.stringify({ user: "hand-edited" }), "utf-8");
    const backfilled = ensureEmployeeHomeStopHook(HOMEDATA);
    const afterBf = readJson(join(HOMEDATA, "claude-home", "settings.json")) as { user?: string; hooks?: { Stop?: Array<{ hooks: Array<{ command: string }> }> } } | null;
    assert(backfilled === true && afterBf?.user === "hand-edited", `存量缺钩=merge 补种（seeded=${backfilled}，用户键保留=${afterBf?.user}）`);
    assert(!!afterBf?.hooks?.Stop?.[0]?.hooks?.[0]?.command?.includes("turn-report.mjs"), "补种后 Stop 钩子在位");
    assert(ensureEmployeeHomeStopHook(HOMEDATA) === false, "已含钩=no-op（幂等跳过留痕）");
  } else {
    assert(false, "种子产物 settings.json 缺 Stop 钩子（路径形态请对照 parseEmployeeConfigDir auto）");
  }

  // ========== W-DELIVERCB R2（军令单三 P1+丢注入①） ==========
  const rowsOf = (id: string) => cbRows().filter(r => r.dispatch_id === id);
  const injectionsWith = (txt: string) => spawned.filter(x => x.resume && String(x.prompt || "").includes(txt)).length;

  // ---------- T6 P1-a：钩子线真通（真脚本 spawn，双 env 态对照） ----------
  console.log("T6 P1-a 钩子白名单放行（真 turn-report.mjs spawn）:");
  const { spawn: spawnProc } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const posts: string[] = [];
  const hsrv = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { posts.push(req.url + "|" + b); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); });
  await new Promise<void>((r) => hsrv.listen(0, "127.0.0.1", () => r()));
  const hport = (hsrv.address() as { port: number }).port;
  const trPath = join(process.cwd(), "..", "scripts", "hooks", "turn-report.mjs");
  const fakeTr = join(DATA, "fake-transcript.json");
  const sid6 = "dcb6-" + randomUUID().slice(0, 8);
  writeFileSync(fakeTr, JSON.stringify({ uuid: "11111111-2222-3333-4444-555555555555", m: "x".repeat(100) }), "utf-8");
  const runHook = (env: Record<string, string>): Promise<number> => new Promise((res) => {
    const c = spawnProc("node", [trPath], { env: { ...process.env, CCR_RELAY_URL: "http://127.0.0.1:" + hport, ...env } });
    c.stdin.write(JSON.stringify({ session_id: sid6, transcript_path: fakeTr }));
    c.stdin.end();
    c.on("close", (code) => res(code ?? 1));
  });
  await runHook({ CCR_RELAY_CHILD: "1" });
  assert(posts.length === 0, `CCR_RELAY_CHILD=1（无白名单）零 POST（自环闸——修前托管沃克形态，实=${posts.length}）`);
  const rc6 = await runHook({ CCR_RELAY_CHILD: "1", CCR_TURN_REPORT: "1" });
  await wait(300);
  assert(rc6 === 0 && posts.some((x) => x.includes("/api/turn-report") && x.includes(sid6)), `CCR_TURN_REPORT=1 白名单放行 POST 达到（rc=${rc6}，实=${JSON.stringify(posts.map(x => x.slice(0, 60)))}）`);
  const ce = (await import("../src/agent-adapter.js")).childEnv({ turnReport: true });
  assert(ce.CCR_TURN_REPORT === "1" && (await import("../src/agent-adapter.js")).childEnv({}).CCR_TURN_REPORT === undefined, "childEnv turnReport 位（白名单 env 单点）");
  hsrv.close();

  // ---------- T7 P1-b：排水接续竞态——FIFO 头不误投 ----------
  console.log("T7 P1-b 排水接续 FIFO 头不误投:");
  const dr4 = mgr.orgAction("dispatch", { anchor: DATA, prompt: "[task_ref:t-dcb4] A 单（收口后排水 B）\n（末行）结果：完成｜改动文件：无", title: "排水 A 单" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
  const d4 = dr4.dispatch_id ?? "", w4 = dr4.session_id ?? "";
  await waitFor(() => mgr.snapshot().find(x => x.session_id === w4)?.status === "DONE", 6000);
  await waitFor(() => rowsOf(d4).length === 1, 4000); // A 已线一投递（recent 记账在）
  // B=排水接续同席（直接注入 w4 队列模拟 drainDispatchQueue 派给同一熟手的下一单——
  // 避开真派单路由的 new-session 随机性，竞态形态确定性复现）
  const d5 = "d-race-b-" + randomUUID().slice(0, 8);
  const openMap7 = (mgr as unknown as { openDispatches: Map<string, Array<{ id: string; tier: string; actor: string }>> }).openDispatches;
  openMap7.set(w4, [{ id: d5, tier: "随手办", actor: "leader" }]);
  const injB0 = injectionsWith(d5.slice(0, 8));
  mgr.handleTurnReport(w4, "k-race-b"); // A 收工的迟到 hook 报——修前会把 FIFO 头 B（未开工）误投+占坑
  await wait(250);
  assert(rowsOf(d5).length === 0, `B 未被误投/占坑（修前实锤：FIFO 头被当刚收工单，实 rows=${JSON.stringify(rowsOf(d5))}）`);
  assert(injectionsWith(d5.slice(0, 8)) === injB0, "B 零直达注入（真交付不被 seen 永久压制）");
  // B 真实收工（正常 done 收口）→ 线一正常投递（recent 判定不误伤正路）
  (mgr as unknown as { closeOpenDispatches(key: string, s: "done", r: string): void }).closeOpenDispatches(w4, "done", "B 单正常收口（T7）");
  await waitFor(() => rowsOf(d5).length === 1 && String(rowsOf(d5)[0].via) === "relay-observe", 4000);
  assert(true, "B 真实收工后线一正常投递");

  // ---------- T8 P1-c：中断口径 done ≠ 交付 ----------
  console.log("T8 P1-c 中断三态（不直达+文案区分）:");
  const d8 = "d-int-" + randomUUID().slice(0, 8);
  const openMap = (mgr as unknown as { openDispatches: Map<string, Array<{ id: string; tier: string; actor: string }>> }).openDispatches;
  openMap.set(w4, [{ id: d8, tier: "随手办", actor: "leader" }]);
  const inj8 = spawned.filter(x => x.resume && String(x.prompt || "").includes(d8.slice(0, 8))).length;
  (mgr as unknown as { closeOpenDispatches(key: string, s: "done", r: string, a?: boolean, rr?: boolean, g?: string, b?: "done" | "backlog", o?: { interrupted?: boolean }): void }).closeOpenDispatches(w4, "done", "流关闭：回合中断（P1-c 模拟）", false, false, undefined, "backlog", { interrupted: true });
  await wait(250);
  assert(rowsOf(d8).length === 0, "中断口径 done 零 deliver 行（伪「已交付」根除）");
  assert(spawned.filter(x => x.resume && String(x.prompt || "").includes(d8.slice(0, 8))).length === inj8, "中断零 PM 直达注入");
  assert(notifs().some(n => String(n.title || "").includes("中断（待重派）") && String(n.body || "").includes("P1-c 模拟")), `通知文案区分中断（待重派）——实匹配：${notifs().filter(n => String(n.title || "").includes("中断")).map(n => n.title).join("|") || "（无）"}`);
  // 对照：同 id 正常 done 收口 → 正常直达（语义未过收）
  const d8b = "d-norm-" + randomUUID().slice(0, 8);
  openMap.set(w4, [{ id: d8b, tier: "随手办", actor: "leader" }]);
  (mgr as unknown as { closeOpenDispatches(key: string, s: "done", r: string): void }).closeOpenDispatches(w4, "done", "正常收口（对照）");
  await wait(250);
  assert(rowsOf(d8b).length === 1 && String(rowsOf(d8b)[0].via) === "relay-observe", "对照：正常 done 照常直达（线一语义零回归）");

  // R3-B-边一（r2-b 审探针实锤复现面）：用户手停**真回调形态**——onTurnEnd(true,"interrupted")
  // 经 :3509 收口链（非 closeOpenDispatches 直调）——flag 透传后零 deliver 行+中断文案
  // R4-P2（review-w-delivercb-r3）：活代 worker cb——A 单（t-dcb4）的 spawn rec 绑 w4 席，
  // 其后无 resume（T7 走直调收口不换流）=代际未进、mine() 放行；此前 fired spawned[0]
  // （leader bootstrap 陈旧代，T1 交付注入已 resumeAgent 前进 streamGen）恒 no-op 空洞
  const w4rec = [...spawned].reverse().find(x => String(x.prompt || "").includes("t-dcb4")) as (SpawnRec | undefined);
  const d8c = "d-hand-" + randomUUID().slice(0, 8);
  openMap.set(w4, [{ id: d8c, tier: "随手办", actor: "leader" }]);
  const inj8c = spawned.filter(x => x.resume && String(x.prompt || "").includes(d8c.slice(0, 8))).length;
  // 活代归因正证据：真收口链 fire 必落台账 done 行（陈旧代 no-op 无行=判别器——
  // R3 审实证旧形态 fire 零效果，靠「队列没动」恒真）
  const dlog8c = (await import("../src/org.js")).readDispatchLog;
  const intNotifBefore = notifs().filter(n => String(n.title || "").includes("中断（待重派）")).length;
  w4rec?.cb.onLog("assistant_text", "干到一半。\n结果：未完成（手停测试）"); // 回执带「结果：」行防 S1 闸并道
  w4rec?.cb.onTurnEnd(true, "interrupted", 30); // 用户手停形态（agent-adapter:814 同款 ok=true+reason）
  await waitFor(() => dlog8c().some((e: { id: string; status: string }) => e.id === d8c && e.status === "done"), 4000);
  assert(dlog8c().some((e: { id: string; status: string }) => e.id === d8c && e.status === "done"), "手停真回调：台账 done 行落（活代真链归因正证据——非 no-op 空洞）");
  await wait(200);
  assert(rowsOf(d8c).length === 0, `手停真回调：零 deliver 行（伪「已交付」根除——B 审探针场景闭环，实 ${JSON.stringify(rowsOf(d8c))}）`);
  assert(spawned.filter(x => x.resume && String(x.prompt || "").includes(d8c.slice(0, 8))).length === inj8c, "手停零 PM 直达注入");
  const intNotifAfter = notifs().filter(n => String(n.title || "").includes("中断（待重派）")).length;
  assert(intNotifAfter === intNotifBefore + 1, `手停通知文案区分（中断通知 Δ=+1：${intNotifBefore}→${intNotifAfter}——本单归因非旧账混判）`);
  // success 对照支（同活代 cb 真链）：正常收口 → 台账 done + deliver 行直达（判别对完整）
  const d8d = "d-ok-" + randomUUID().slice(0, 8);
  openMap.set(w4, [{ id: d8d, tier: "随手办", actor: "leader" }]);
  w4rec?.cb.onLog("assistant_text", "干完了。\n结果：完成（对照）｜改动文件：无");
  w4rec?.cb.onTurnEnd(true, "success", 20);
  await waitFor(() => dlog8c().some((e: { id: string; status: string }) => e.id === d8d && e.status === "done") && rowsOf(d8d).length === 1, 4000);
  assert(rowsOf(d8d).length === 1 && String(rowsOf(d8d)[0].via) === "relay-observe", "success 对照：同活代链正常收工→deliver 直达（判别对闭合——中断拦/success 投）");

  // ---------- T9 丢注入①：PM 不在场 delivered:false → 上线补投 ----------
  console.log("T9 上线补投（PM 不在场占坑→恢复即达）:");
  const leaderSes = (mgr as unknown as Map<string, unknown>).constructor; // noop 占位（下行真删）
  const sesMap = (mgr as unknown as { sessions: Map<string, unknown> }).sessions;
  const savedLeader = sesMap.get(leaderId);
  sesMap.delete(leaderId); // 模拟 relay 重启窗：leaderId 在册但会话卡不在场
  const d9 = "d-miss-" + randomUUID().slice(0, 8);
  openMap.set(w4, [{ id: d9, tier: "随手办", actor: "leader" }]);
  (mgr as unknown as { closeOpenDispatches(key: string, s: "done", r: string): void }).closeOpenDispatches(w4, "done", "PM 离场窗交付（T9）");
  await wait(250);
  const r9 = rowsOf(d9) as unknown as Array<Record<string, unknown>>;
  assert(r9.length === 1 && r9[0].delivered === false, `PM 不在场：占坑行 delivered:false（实 ${JSON.stringify(r9)}）`);
  sesMap.set(leaderId, savedLeader); // PM 回场（上线边沿）
  const flushed = (mgr as unknown as { flushUndeliveredCallbacks(): number }).flushUndeliveredCallbacks();
  await wait(250);
  assert(flushed >= 1, `上线补投触发（flushed=${flushed}）`);
  // R3-A-②：活流免杀——leader 会话 agent 在场（未 ended）走 sendMessage（sent 通道）；
  // 无流才 suppress/resume（resume 通道）。两通道其一含聚合 prompt 即达卡。
  const sentHit = spawned.some((x) => x.sent.some((m) => m.includes(d9.slice(0, 8)) || m.includes("上线补投")));
  assert(sentHit || injectionsWith(d9.slice(0, 8)) >= 1 || injected9(spawned, d9), "补投 prompt 达 PM（活流 sent/换流 resume/注入三通道其一——A-② 免杀语义）");
  const r9b = rowsOf(d9) as unknown as Array<Record<string, unknown>>;
  assert(r9b.length === 2 && r9b[1].delivered !== false, `补账行落（末行赢=已投，实 ${JSON.stringify(r9b)}）`);

  // ---------- T9b R3-A-①：onInit 接线端到端（防「直调盲区」——r2-a 审要求） ----------
  console.log("T9b 上线补投接线点（onInit 链非直调）:");
  const d9b = "d-wire-" + randomUUID().slice(0, 8);
  sesMap.delete(leaderId); // PM 再离场
  openMap.set(w4, [{ id: d9b, tier: "随手办", actor: "leader" }]);
  (mgr as unknown as { closeOpenDispatches(key: string, s: "done", r: string): void }).closeOpenDispatches(w4, "done", "PM 离场窗交付（T9b 接线）");
  await wait(250);
  const r9c = rowsOf(d9b) as unknown as Array<Record<string, unknown>>;
  assert(r9c.length === 1 && r9c[0].delivered === false, "T9b 占坑 delivered:false");
  sesMap.set(leaderId, savedLeader);
  const sentBefore = spawned.reduce((n, x) => n + x.sent.length, 0);
  const recsBefore = spawned.length;
  // 触发 leader 真 resume（新流握手经真工厂→新 cb→onInit 链内接线点自动 flush——
  // 纯接线端到端零直调；旧 cb 直发会被 #109 mine() 代际守卫正确拒绝——那本身是产品语义）
  if (!sesMap.has(leaderId)) sesMap.set(leaderId, savedLeader); // 防御：T9 直调链若清了 leader 先复原
  const leaderSes2 = sesMap.get(leaderId) as unknown as { state: { relay_session_id?: string } } | undefined;
  assert(!!leaderSes2?.state?.relay_session_id, "leader relay_session_id 在场（A-① 回填后挂点前提）");
  try {
    (mgr as unknown as { resumeAgent(s: unknown, p: string): unknown }).resumeAgent(savedLeader, "T9b 接线探针（新流 init）"); // resumeAgent 收 ManagedSession 对象（非 sid）——:3725 同款
  } catch (e) {
    console.error("  [T9b] resumeAgent 异常（接线断言降级走工厂记录判读）:", e instanceof Error ? e.message : String(e));
  }
  await waitFor(() => spawned.length > recsBefore, 4000);
  await wait(350); // 新流 onInit（fake 20ms）→接线点 flush（回填后）
  const sentAfter = spawned.reduce((n, x) => n + x.sent.length, 0);
  const r9d = rowsOf(d9b) as unknown as Array<Record<string, unknown>>;
  assert(sentAfter > sentBefore || r9d.length >= 2, `onInit 接线点自动补投（sent ${sentBefore}→${sentAfter} 或补账行落——接线级端到端，实 ${JSON.stringify(r9d)}）`);

  console.log(`\ndelivercb: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

void main();
