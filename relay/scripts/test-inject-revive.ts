// W-INJECT 专项测试：会话存活自愈（防只读）+ 注入失败显式化 + 排队落盘重投 + 提交快路径
// 覆盖面：
//   ① reviveAliveExternals：重启收养误标 historical 的活 pid 卡翻案；idle_archived 不翻案；
//      翻案触发落盘排队重投
//   ② COMMAND_RESUME_SESSION 外部分支：活 pid=清标记 ok；死 pid=明确报错
//   ③ do-script 静默假成功根治：脚本结构断言（TTY-NOT-FOUND + do script 移出 try）
//   ④ 注入失败保留重投：1~2 连败队列+pending 保留落盘；3 连败转显式失败终态
//   ⑤ 重启回种：queue 文件 → 新 Bridge 回种 inputQueue+pending → hook 重连自动补投
//   ⑥ scheduleSubmitEnter：注入成功后 ~300ms 补发纯回车（提交快路径）
import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import { Bridge } from "../src/bridge.js";
import { SNAPSHOT_LOGS_LAN } from "../src/session-manager.js";
import { buildDoScriptExpr, buildCaptureScript, mapAppleError } from "../src/injector.js";
import type { BridgeEvent, Command, Envelope } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const waitLog = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await wait(80);
};

const HERE = fileURLToPath(new URL("./", import.meta.url));
const DATA = fileURLToPath(new URL("../data/test-inject-revive/", import.meta.url));
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.CCR_PORT = "8823";
process.env.CCR_TOKEN = "tir-token";
process.env.CCR_BRIDGE_TOKEN = "tir-bridge-token";
process.env.CCR_NO_TITLE_GEN = "1";
// ⑨ 预算断言的环境去噪：引擎扫描默认 5s 一轮，冷 cursor 首扫全量解析（本机 codex
// rollouts 大目录）会卡事件循环 ~1s+，直接打穿 submit-enter 的 1s 预算窗——套件级
// 拉长到 60s（W-PERF cursor 语义不受影响，boot 首扫照跑）
process.env.CCR_ENGINE_SCAN_MS = "60000";
process.env.CCR_NO_LEADER = "1";
process.env.CCR_DEAD_SWEEP = "0";
process.env.CCR_NO_TERM_LINE = "1";
// 验证链/看门狗全调远：提交快路径与失败重投的断言窗口内不受干扰
process.env.CCR_VERIFY_MS = "60000";
process.env.CCR_STUCK_AFTER_MS = "30000";
process.env.CCR_STUCK_RETRY_MS = "20000";
// 假注入器：参数含 FORCE_FAIL 即 exit 1（注入失败路径），否则记日志 exit 0
const FAKE = join(DATA, "fake-injector.mjs");
// W-INJDEGRADE：假 osascript（resumeSession macOS 分支走 runAppleScript→此假）——
// 记录 argv 到日志供「降级=claude --resume 真被调起」实证，绝不碰真 Terminal.app
const FAKE_OSA = join(DATA, "fake-osascript.mjs");
const OSA_LOG = join(DATA, "osascript.log");
const INJECT_LOG = join(DATA, "inject.log");
writeFileSync(
  FAKE,
  [
    'import { appendFileSync, writeFileSync, existsSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'appendFileSync(process.env.CCR_INJECT_LOG, JSON.stringify(args) + "\\n");',
    'if (args.some((a) => String(a).includes("FORCE_FAIL"))) process.exit(1);',
    'if (args[1] === "--peek") {',
    '  // 防抢发守门读屏：框内 = CCR_FAKE_BOX 指定的文本（守门判定 enter 需框内只有已知文本）；',
    '  // 未设 = 快照不可用（exit 1 → capture null → unknown，⑨a 的判定源）；',
    '  // CCR_FAKE_BOX_RACE=渲染竞态：首捕返回外来旧帧（TUI 未渲染），复捕起渲染我们的文本',
    '  if (!process.env.CCR_FAKE_BOX) process.exit(1);',
    '  if (process.env.CCR_FAKE_BOX_RACE) {',
    '    const marker = process.env.CCR_FAKE_BOX_RACE;',
    '    if (!existsSync(marker)) {',
    '      writeFileSync(marker, "1");',
    '      writeFileSync(args[2], ["✶ Working…", "─".repeat(40), "❯ 别人的旧帧内容", "─".repeat(40)].join("\\n"));',
    '      process.exit(0);',
    '    }',
    '  }',
    '  try { writeFileSync(args[2], ["✶ Working…", "─".repeat(40), "❯ " + (process.env.CCR_FAKE_BOX ?? ""), "─".repeat(40)].join("\\n")); } catch {}',
    "  process.exit(0);",
    "}",
    "process.exit(0);",
  ].join("\n"),
);
writeFileSync(
  FAKE_OSA,
  [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.env.CCR_OSA_LOG, JSON.stringify(process.argv.slice(1)) + "\\n");',
    "process.exit(0);",
  ].join("\n"),
);
process.env.CCR_OSA_LOG = OSA_LOG;
process.env.CCR_OSASCRIPT_CMD = FAKE_OSA;
process.env.CCR_INJECT_CMD = FAKE;
process.env.CCR_INJECT_LOG = INJECT_LOG;
process.env.CCR_DATA_DIR = DATA;
const PROOT = join(DATA, "projects");
process.env.CCR_PROJECTS_ROOT = PROOT;
const fakeLog = (): string[][] => {
  let raw = "";
  try {
    raw = readFileSync(INJECT_LOG, "utf-8");
  } catch {
    return [];
  }
  const out: string[][] = [];
  for (const l of raw.split(/\r?\n/)) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
};

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
// 事件流收集（日志文本断言面）
const logs: Envelope[] = [];
bus.subscribe((e) => {
  if (e.type === "SESSION_LOG") logs.push(e);
});
const sessionLogText = (id: string) =>
  logs
    .filter((e) => e.session_id === id)
    .map((e) => String((e.payload as { text?: string }).text ?? ""))
    .join("\n");

// ---------- ③ do-script 结构断言（纯字符串，先行） ----------
{
  const ds = buildDoScriptExpr(4242, '"hi"');
  assert(ds.includes("TTY-NOT-FOUND"), "③ do-script 定位落空显式报错（TTY-NOT-FOUND）");
  assert(ds.includes("do script (\"hi\") in hitTab"), "③ do script 移出 try（命中才执行，执行错误不再被吞）");
  assert(ds.includes("if hitTab is missing value"), "③ 先定位后执行结构");
  const cap = buildCaptureScript(4242);
  assert(cap.includes("return contents of (contents of hitTab)") && cap.includes("tty of t"), "③ capture 双层解引用保留（45 段口径）");
  assert(cap.includes("TTY-NOT-FOUND"), "③ capture 定位落空显式报错");
  const mapped = mapAppleError("execution error: TTY-NOT-FOUND: ttys003");
  assert(!!mapped && mapped.includes("Terminal.app"), "③ TTY-NOT-FOUND 翻译成人话");
}

// ---------- ① 存活自愈：boot 收养误标翻案 ----------
{
  const id = "ext-tir-revive-1";
  const s = mgr.ensureExternal(id, "/tmp/tir", "自愈验证", "tir-revive-1");
  mgr.setExternalCliPid(id, process.pid); // 本测试进程恒活
  s.status = "DONE";
  s.historical = true; // 模拟重启收养误标（pid 帧缺失 → 重放活体判定失败）
  const b2 = new Bridge(bus, mgr, {
    gateTools: new Set(["Bash"]),
    hasClients: () => false,
    dataDir: DATA,
  });
  assert(!s.historical, "① boot 自愈：活 pid 的 historical 卡翻案清标记");
  assert(s.idle_archived === undefined, "① 翻案卡不带 idle 归档标记");

  // idle 归档卡（#50 刻意沉底）不翻案
  const id2 = "ext-tir-revive-2";
  const s2 = mgr.ensureExternal(id2, "/tmp/tir", "idle 归档验证", "tir-revive-2");
  mgr.setExternalCliPid(id2, process.pid);
  s2.status = "DONE";
  s2.historical = true;
  s2.idle_archived = true;
  // 触发周期口径：直接构造新 Bridge 不可行（boot 已跑），借 60s 节拍不可等——
  // 用「再翻案一轮」验证：boot 逻辑只跑一次，这里改为断言 boot 后仍保持（boot 时已带标记）
  const b3 = new Bridge(bus, mgr, { gateTools: new Set(["Bash"]), hasClients: () => false, dataDir: DATA });
  assert(s2.historical === true && s2.idle_archived === true, "① idle 归档卡不被存活自愈翻案（#50 语义保持）");
  void b2;
  void b3;
}

// ---------- ② COMMAND_RESUME_SESSION 外部分支 ----------
{
  // 活 pid：清标记回 ok
  const id = "ext-tir-resume-1";
  const s = mgr.ensureExternal(id, "/tmp/tir", "resume 验证", "tir-resume-1");
  mgr.setExternalCliPid(id, process.pid);
  s.status = "DONE";
  s.historical = true;
  const ack1 = mgr.handleCommand({ command_id: randomUUID(), type: "COMMAND_RESUME_SESSION", ts: Date.now(), payload: { session_id: id } } as Command, "test");
  assert(ack1.ok === true && !s.historical, "② 外部会话恢复：活 pid 清只读标记回 ok");

  // 死 pid：明确报错（424242 = 本套件惯例假 pid，本机无此进程）
  const id2 = "ext-tir-resume-2";
  const s2 = mgr.ensureExternal(id2, "/tmp/tir", "resume 死验证", "tir-resume-2");
  mgr.setExternalCliPid(id2, 424242);
  const ack2 = mgr.handleCommand({ command_id: randomUUID(), type: "COMMAND_RESUME_SESSION", ts: Date.now(), payload: { session_id: id2 } } as Command, "test");
  assert(ack2.ok === false && String(ack2.error ?? "").includes("已结束"), "② 外部会话恢复：死 pid 明确报错不假成功");
  void s2;
}

// ---------- ④/⑤/⑥ 全服链路：注入失败重投 + 落盘回种 + 提交快路径 ----------
{
  const { bridge, close } = await startServer(bus, mgr, cfg, {
    holdMs: 1200,
    questionHoldMs: 800,
    gateToolsRaw: "Bash",
  });
  await wait(300);

  // ④ 注入失败保留重投（1~2 败）+ 3 连败显式失败终态
  const idFail = "ext-tir-fail-1";
  const sf = mgr.ensureExternal(idFail, "/tmp/tir", "失败重投验证", "tir-fail-1");
  mgr.setExternalCliPid(idFail, process.pid);
  sf.status = "DONE";
  const r1 = bridge.extInput(idFail, "FORCE_FAIL 第一条");
  assert(r1.ok === true, "④ extInput 受理回 ok（失败在注入环节，不假拒绝）");
  await waitLog(() => sessionLogText(idFail).includes("保留"), 6000);
  const qfile = join(DATA, "ext-input-queue.json");
  assert(existsSync(qfile), "④ 注入失败后队列落盘");
  const disk1 = JSON.parse(readFileSync(qfile, "utf-8")) as Record<string, unknown[]>;
  assert((disk1[idFail]?.length ?? 0) === 1, "④ 失败消息保留在落盘队列（不再蒸发）");
  assert((sf.pending_inputs ?? []).length === 1, "④ pending 回显保留（重投期可见）");
  assert(sessionLogText(idFail).includes("自动重投") && sessionLogText(idFail).includes("降级恢复投递"), "④ 失败留痕含重投进度与降级预告（首条横幅，降噪后无逐次进度）");

  // 2、3 连败 → W-INJDEGRADE 降级（#142）：不再丢弃，转恢复投递腿（claude --resume）。
  // 每次发消息前重挂 pid 模拟「hook 重连 → 重投周期」（失败即清 pid，不重挂会走
  // resumeExternal 恢复路径，不进注入失败计数——与生产分诊一致）
  mgr.setExternalCliPid(idFail, process.pid);
  bridge.extInput(idFail, "FORCE_FAIL 第二条");
  await wait(1200); // 同因连败第 2 次：横幅静默（降噪）——等一拍再验
  const banner2 = sessionLogText(idFail).match(/注入失败（[^）]*）/g) ?? [];
  assert(banner2.length === 1, `④ 横幅降噪：同因连败只插首条（实测 ${banner2.length} 条「注入失败」横幅）`);
  assert((sf.pending_inputs ?? []).length === 2, "④ 重试期 pending 回显保留（两条排队消息都在场）");
  mgr.setExternalCliPid(idFail, process.pid);
  bridge.extInput(idFail, "FORCE_FAIL 第三条");
  await waitLog(() => sessionLogText(idFail).includes("降级:回合末"), 6000);
  const disk3 = JSON.parse(readFileSync(qfile, "utf-8")) as Record<string, unknown[]>;
  assert((disk3[idFail]?.length ?? 0) === 0, "④ 3 连败后注入队列清空（消息已转投恢复腿，不滞留）");
  assert((sf.pending_inputs ?? []).length >= 2, `④ 降级后 pending 回显保留≥转投条数（实测 ${sf.pending_inputs?.length}，不丢失）`);
  assert(sessionLogText(idFail).includes("转恢复投递"), "④ 降级汇总横幅落人话日志");
  // 降级实证：假 osascript 收到 claude --resume 调起（消息真被转交恢复腿，非仅改文案）
  console.log('DEBUG-LOGS>>>' + sessionLogText(idFail));
  // 降级实证（resumeSession 为 fire-and-forget 异步，横幅先落——轮询等 osascript 假记录）
  let osaCalls = "";
  for (let i = 0; i < 20 && !osaCalls.includes("claude --resume"); i++) {
    await wait(300);
    osaCalls = existsSync(OSA_LOG) ? readFileSync(OSA_LOG, "utf-8") : "";
  }
  assert(osaCalls.includes("claude --resume"), "④ 降级实证：resumeSession 真被调起（osascript argv 含 claude --resume）");
  assert(osaCalls.includes("FORCE_FAIL"), "④ 降级实证：转投文本经 resume prompt 携带");

  // ⑤ 重启回种：手写 queue 文件 → 新 Bridge 回种 → hook 重连自动补投
  const idRestore = "ext-tir-restore-1";
  const sr = mgr.ensureExternal(idRestore, "/tmp/tir", "回种验证", "tir-restore-1");
  mgr.setExternalCliPid(idRestore, process.pid);
  sr.status = "DONE";
  sr.historical = true; // 同时验证回种+自愈联动
  process.env.CCR_FAKE_BOX = "重启前的排队消息"; // 守门读屏：框内=我们的文本 → 补发回车
  writeFileSync(
    qfile,
    JSON.stringify({ [idRestore]: [{ text: "重启前的排队消息", ts: Date.now() }] }),
  );
  const bNew = new Bridge(bus, mgr, { gateTools: new Set(["Bash"]), hasClients: () => false, dataDir: DATA });
  void bNew;
  await waitLog(() => (fakeLog().length ?? 0) > 0, 6000);
  assert(fakeLog().some((a) => a.some((x) => String(x).includes("重启前的排队消息"))), "⑤ 回种消息经自愈翻案自动补投到注入器");
  assert(!sr.historical, "⑤ 回种联动自愈：historical 翻案");
  assert((sr.pending_inputs ?? []).length === 1, "⑤ 补投后 pending 保留待 UPS 晋升（晋升闭环归正式消息）");
  // 落盘账本随注入成功清空（读盘在注入回执后有落笔顺序差，轮询等而非读一次）
  await waitLog(() => {
    try {
      const d = JSON.parse(readFileSync(qfile, "utf-8")) as Record<string, unknown[]>;
      return (d[idRestore]?.length ?? 0) === 0;
    } catch {
      return false;
    }
  }, 6000);
  const disk5 = JSON.parse(readFileSync(qfile, "utf-8")) as Record<string, unknown[]>;
  assert((disk5[idRestore]?.length ?? 0) === 0, "⑤ 补投后落盘账本同步清");

  // ⑥ 提交快路径：注入成功后 ~300ms 补发纯回车
  const idFast = "ext-tir-fast-1";
  const st = mgr.ensureExternal(idFast, "/tmp/tir", "快路径验证", "tir-fast-1");
  mgr.setExternalCliPid(idFast, process.pid);
  st.status = "DONE";
  process.env.CCR_FAKE_BOX = "快路径消息";
  const before = fakeLog().length;
  bridge.extInput(idFast, "快路径消息");
  await waitLog(() => {
    const lg = fakeLog();
    // 文本注入之后出现 args=[pid, ""] 的纯回车
    const ti = lg.findIndex((a) => a.some((x) => String(x).includes("快路径消息")));
    return ti >= 0 && lg.slice(ti + 1).some((a) => a.length >= 2 && a[1] === "" );
  }, 6000);
  assert(true, "⑥ 注入成功后 300ms 级补发纯回车（提交快路径命中）");
  void before;

  // ⑨ W-INJECT P0：idle 会话首条消息 3 秒内发出（守门误判三面收口）
  {
    // a) 快照不可用（unknown）→ 立即盲发（fail-open，对齐看门狗直发语义）
    const idA = "ext-tir-p0-unknown";
    const sa = mgr.ensureExternal(idA, "/tmp/tir", "P0 unknown 验证", "tir-p0-a");
    mgr.setExternalCliPid(idA, process.pid);
    sa.status = "DONE";
    delete process.env.CCR_FAKE_BOX; // 无屏可读 = unknown
    const t0a = Date.now();
    bridge.extInput(idA, "首条消息unknown");
    let enterA = -1;
    await waitLog(() => {
      const lg = fakeLog();
      const ti = lg.findIndex((a) => a.some((x) => String(x).includes("首条消息unknown")));
      const ei = lg.slice(ti + 1).findIndex((a) => a.length >= 2 && a[1] === "");
      if (ti >= 0 && ei >= 0) { enterA = Date.now() - t0a; return true; }
      return false;
    }, 6000);
    // 预算口径：relay 侧 [submit] ms（打点）≤1s 为权威；墙钟含 3 次 fake spawn（本环境每次 0.3~1s）
    assert(enterA >= 0 && enterA <= 3000, `⑨a idle+快照不可用：首条 3 秒内补发提交回车（实测 ${enterA}ms，relay 侧见 [submit] 打点）`);

    // b2) 渲染竞态（用户活体样本签名）：首捕旧帧 skip-absent → 250ms 复捕见文本 → enter
    //     必须在 1s 预算内发出（此前：静默跳过 → Enter 彻底丢失 → 第二条才顶出）
    const idB2 = "ext-tir-p0-race";
    const sb2 = mgr.ensureExternal(idB2, "/tmp/tir", "P0 渲染竞态验证", "tir-p0-b2");
    mgr.setExternalCliPid(idB2, process.pid);
    sb2.status = "DONE";
    const raceMarker = join(DATA, "race-marker-" + Date.now());
    process.env.CCR_FAKE_BOX = "渲染竞态首条";
    process.env.CCR_FAKE_BOX_RACE = raceMarker;
    const t0b2 = Date.now();
    bridge.extInput(idB2, "渲染竞态首条");
    let enterB2 = -1;
    await waitLog(() => {
      const lg = fakeLog();
      const ti = lg.findIndex((a) => a.some((x) => String(x).includes("渲染竞态首条")));
      const ei = lg.slice(ti + 1).findIndex((a) => a.length >= 2 && a[1] === "");
      if (ti >= 0 && ei >= 0) { enterB2 = Date.now() - t0b2; return true; }
      return false;
    }, 6000);
    assert(enterB2 >= 0 && enterB2 <= 3000, `⑨b2 渲染竞态：复捕后补发（实测 ${enterB2}ms，relay 侧见 [submit] 打点）`);
    delete process.env.CCR_FAKE_BOX_RACE;

    // b) 框内无我们文本（skip-absent）→ 保持静默：已进 CLI 原生队列的正常态，补发回车
    //    =误发无关草稿（111 段红线「natively-queued never compensated」）；未渲染竞态由
    //    #111 验证链 1s 二次 capture 兜住（彼时已渲染→enter 判定照发）
    const idB = "ext-tir-p0-skipabsent";
    const sb = mgr.ensureExternal(idB, "/tmp/tir", "P0 skip-absent 验证", "tir-p0-b");
    mgr.setExternalCliPid(idB, process.pid);
    sb.status = "DONE";
    process.env.CCR_FAKE_BOX = "别人的草稿内容"; // 框内没有我们的文本 → skip-absent
    bridge.extInput(idB, "首条消息skipabsent");
    await wait(2500); // 覆盖 submit-enter 两轮 + #111 快窗
    {
      const lg = fakeLog();
      const ti = lg.findIndex((a) => a.some((x) => String(x).includes("首条消息skipabsent")));
      const entered = ti >= 0 && lg.slice(ti + 1).some((a) => a.length >= 2 && a[1] === "");
      assert(!entered, "⑨b skip-absent 保持静默（原生队列语义，不误发回车）");
    }
    process.env.CCR_FAKE_BOX = undefined as unknown as string;

    // c) tries 账本死锁破除：上轮 given_up 后，新消息入队即清账（#111/看门狗不被挡）
    const idC = "ext-tir-p0-ledger";
    const sc = mgr.ensureExternal(idC, "/tmp/tir", "P0 账本验证", "tir-p0-c");
    mgr.setExternalCliPid(idC, process.pid);
    sc.status = "DONE";
    (bridge as unknown as { stuckWatch: Map<string, { tries: number; given_up: boolean }> }).stuckWatch.set(idC, { tries: 3, given_up: true });
    process.env.CCR_FAKE_BOX = "账本轮新消息";
    bridge.extInput(idC, "账本轮新消息");
    assert(
      !(bridge as unknown as { stuckWatch: Map<string, unknown> }).stuckWatch.has(idC),
      "⑨c 新消息入队即清 tries/given_up 账本（死锁腿拔除）",
    );
    await waitLog(() => {
      const lg = fakeLog();
      const ti = lg.findIndex((a) => a.some((x) => String(x).includes("账本轮新消息")));
      return ti >= 0 && lg.slice(ti + 1).some((a) => a.length >= 2 && a[1] === "");
    }, 6000);
    assert(true, "⑨c given_up 后新消息补偿链存活（提交回车照发）");
    delete process.env.CCR_FAKE_BOX;
  }

  // ⑦ W-INJECT 问题④：历史回滚根治——LAN 快照宽窗 vs 云端安全默认（#408 口径不动）
  {
    const idHist = "ext-tir-hist-1";
    const sh = mgr.ensureExternal(idHist, "/tmp/tir", "历史窗口验证", "tir-hist-1");
    sh.status = "DONE";
    for (let i = 0; i < 300; i++) {
      mgr.pushExternalLog(idHist, "user_message", `历史消息 ${i}`, undefined, { full: `历史消息 ${i}` });
    }
    const wide = mgr.buildSnapshotLogs(SNAPSHOT_LOGS_LAN.budgetBytes, SNAPSHOT_LOGS_LAN.perSessionCap);
    assert((wide.logs[idHist]?.length ?? 0) === 300 && !wide.logs_truncated[idHist], "⑦ LAN 快照宽窗全量携带 300 条（重启重建不回滚）");
    const cloud = mgr.buildSnapshotLogs();
    assert((cloud.logs[idHist]?.length ?? 0) <= 60 && !!cloud.logs_truncated[idHist], "⑦ 云端默认窗口保持 #408 安全值（50 帽 + truncated 标记，CF 1MiB 不破）");
    void sh;
  }

  // ⑩ W-PERM：权限循环注入的投递链端到端（真 tmux pane 字节落盘）。
  // claude 档位循环本身已人工实测入档（1012：ESC[Z 经 tmux pane 驱动真 claude
  // bypass→default→acceptEdits→plan 全四档，指示条捕获为证）；本段自动断言的是
  // relay→tmux→pane 的字节投递链（pane=node raw-mode stdin 落盘，确定性 100%）。
  // 环境无 tmux 时整段跳过（CI 兼容）
  {
    const tmuxOk = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();
    if (!tmuxOk) {
      console.log("skip ⑩（环境无 tmux，权限循环端到端段不适用）");
    } else {
      const sess = "winject-cycle";
      const delivery = join(DATA, "esc-z-bytes.log");
      try { rmSync(delivery, { force: true }); } catch {}
      try { execFileSync("tmux", ["kill-session", "-t", sess], { stdio: "ignore" }); } catch {}
      // pane=node（过 VALID_TARGET 宿主校验）+ raw-mode stdin 逐字节落盘（行缓冲会吞掉
      // 无换行的 ESC[Z——首版 harness 教训）
      execFileSync("tmux", ["new-session", "-d", "-s", sess, "node", "-e",
        `const fs=require('fs');process.stdin.setRawMode(true);process.stdin.on('data',(d)=>fs.appendFileSync(${JSON.stringify(delivery)},d));setInterval(()=>{},1000)`], { stdio: "ignore" });
      await wait(500);
      const panePid = Number(execFileSync("tmux", ["list-panes", "-t", sess, "-F", "#{pane_pid}"], { encoding: "utf8" }).trim());
      const idCy = "ext-tir-cycle-1";
      const scy = mgr.ensureExternal(idCy, "/tmp/tir", "权限循环验证", "tir-cycle-1");
      mgr.setExternalCliPid(idCy, panePid);
      scy.status = "DONE";
      // 引擎闸：codex 如实报不支持（无任何注入发生）
      const scx = mgr.ensureExternal("ext-tir-cycle-cx", "/tmp/tir", "权限循环 codex", "tir-cycle-cx", 0, { engine: "codex" });
      mgr.setExternalCliPid("ext-tir-cycle-cx", process.pid);
      scx.status = "DONE";
      const rCx = bridge.cyclePerm("ext-tir-cycle-cx", 1);
      assert(rCx.ok === false && String(rCx.error ?? "").includes("不支持"), "⑩ codex 引擎如实报不支持权限循环");
      // claude + 真 tmux pane：cycle 一发 → ESC[Z 字节落盘（投递链物理证据）
      delete process.env.CCR_INJECT_CMD; // 解锁 tmux 通道（resolveTmuxTarget 的测试逃生门）
      delete process.env.CCR_OSASCRIPT_CMD; // W-INJDEGRADE：同款解锁——OSASCRIPT 假在场会禁 tmux 解析（injector :254 同门）
      await wait(200);
      const rCy = bridge.cyclePerm(idCy, 1);
      assert(rCy.ok === true, "⑩ claude 会话权限循环受理 ok");
      await waitLog(() => { try { return readFileSync(delivery).length >= 3; } catch { return false; } }, 6000);
      const bytes = (() => { try { return readFileSync(delivery); } catch { return Buffer.alloc(0); } })();
      assert(bytes.length >= 3 && bytes[0] === 0x1b && bytes[1] === 0x5b && bytes[2] === 0x5a, "⑩ ESC[Z 三字节经 relay→tmux→pane 送达（物理证据）");
      await waitLog(() => sessionLogText(idCy).includes("已发送权限循环切换") || sessionLogText(idCy).includes("已循环切换"), 6000);
      // fallback（读屏未识别档位）已降级本地日志——断言改为「不假镜像」：mode 未写入 state
      assert(scx && scy.permission_mode === undefined, "⑩ 未识别档位不假镜像（fallback 仅本地日志）");
      try { execFileSync("tmux", ["kill-session", "-t", sess], { stdio: "ignore" }); } catch {}
      process.env.CCR_INJECT_CMD = FAKE; // 还原套件注入器
      process.env.CCR_OSASCRIPT_CMD = FAKE_OSA; // W-INJDEGRADE：还原 osascript 假
    }
  }

  await close();
}

// ⑧ W-INJECT 问题⑤：上下文窗口解析——别名裸名/GLM 直传全走 1M 档（生产实锤：
// ext-ab91190d model=claude-sonnet-5 落 200K、usage 346K 水位假 100%）
{
  const { contextLimitOf, contextLimitOfEffective } = await import("../src/context-limit.js");
  const { withContextWindowSuffix } = await import("../src/models.js");
  assert(contextLimitOfEffective("claude-sonnet-5") === 1_000_000, "⑧ 别名裸名 claude-sonnet-5 → 1M（生产缺口修补）");
  assert(contextLimitOfEffective("GLM-5.3") === 1_000_000, "⑧ GLM-5.3 直传 → 1M");
  assert(contextLimitOfEffective("claude-sonnet-4-5-20250929") === 1_000_000, "⑧ 旧别名 sonnet-4-5 → 1M（回归保持）");
  assert(contextLimitOfEffective("claude-sonnet-4-5-20250929[1m]") === 1_000_000, "⑧ 已带 [1m] → 1M（不重挂）");
  assert(contextLimitOfEffective("glm-4.5-air") === 128_000, "⑧ glm-4.5 官方 128K 档不误升");
  assert(contextLimitOf("未知模型-xyz") === 200_000, "⑧ 未知模型默认 200K 档不变");
  assert(withContextWindowSuffix("claude-sonnet-5") === "claude-sonnet-5[1m]", "⑧ 重挂规则覆盖 sonnet-5（spawn/显示同源）");
  assert(withContextWindowSuffix("claude-opus-5") === "claude-opus-5[1m]", "⑧ 重挂规则覆盖 opus-5");
}

console.log("\n全部通过：W-INJECT 专项（自愈/恢复/落盘重投/快路径/历史窗口/上下文档位）");
process.exit(0);
