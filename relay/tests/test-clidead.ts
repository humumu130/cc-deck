// #113「CLI 进程已退出」误报根修测试（2026-10-15）
// 根因：hook 侧 cli-pids.json 缓存对 resume 会话（复用同 session_id 换新进程）永久
// 命中死 pid → hook 持续上报死 pid → relay 3s 死亡扫描误报；60s 补定位修好又被下一条
// hook 事件毒回（生产 ext-29ab 单会话 4 小时 102 连报实锤）。
// 覆盖面：
//   T1  陈旧死 pid 事件不覆盖活 pid（防回退闸）+ 误报循环断链
//   T2  resume 换代（死→活）正常采纳，扫描不误报
//   T3  真死仍报：死 pid + 无后续事件 → disconnected + 「CLI 进程已退出」（防漏报锚）
//   T4  补定位顺序：sessions/*.json 活证据压过缓存死 pid
//   T5  缓存死 pid 在无活证据时仍补水 → 真死仍报（补水通路不因根修变聋）
//   T6  hook 子进程 walk-first：死缓存被活祖先链压过 + 缓存回写（HOME 隔离）
//   T6b 快路径：缓存 pid 恰为直接父进程零探测采信
//   T7  双副本 hook（relay/hooks + cc-plugins）逐字节一致
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import type { BridgeEvent } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    cleanup();
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// —— 隔离（全部在 loadConfig 前设好；端口与 test-bridge 默认 8798 错开）——
process.env.CCR_PORT = "8799";
process.env.CCR_TOKEN = "test-token-clidead";
process.env.CCR_BRIDGE_TOKEN = "bridge-token-clidead";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_INJECT_CMD = fileURLToPath(new URL("./fake-injector.mjs", import.meta.url));
process.env.CCR_NO_TERM_LINE = "1";
// 死亡扫描默认关（与 test-bridge 同纪律），各用例局部开——防 3s 自动轮询干扰断言时序
process.env.CCR_DEAD_SWEEP = "0";
const TDATA = fileURLToPath(new URL("../data/test-clidead-datadir/", import.meta.url));
process.env.CCR_DATA_DIR = TDATA;
rmSync(TDATA, { recursive: true, force: true });
const SROOT = fileURLToPath(new URL("../data/test-clidead-sessions/", import.meta.url));
process.env.CCR_SESSIONS_ROOT = SROOT;
rmSync(SROOT, { recursive: true, force: true });
mkdirSync(SROOT, { recursive: true });
const PROOT = fileURLToPath(new URL("../data/test-clidead-projects/", import.meta.url));
process.env.CCR_PROJECTS_ROOT = PROOT;
rmSync(PROOT, { recursive: true, force: true });
const TORG = fileURLToPath(new URL("../data/test-clidead-orgdir/", import.meta.url));
rmSync(TORG, { recursive: true, force: true });
process.env.CCR_ORG_DIR = TORG;
const CCFG = fileURLToPath(new URL("../data/test-clidead-cfg/", import.meta.url));
rmSync(CCFG, { recursive: true, force: true });
mkdirSync(CCFG, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = CCFG;
process.env.CCR_NO_LEADER = "1";

const sleepers: Array<{ kill: () => void }> = [];
function cleanup(): void {
  for (const s of sleepers) {
    try { s.kill(); } catch {}
  }
}
process.on("exit", cleanup);

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const { bridge } = startServer(bus, mgr, cfg, {});
await wait(300);

const http = `http://127.0.0.1:${cfg.port}`;

function hook(ev: Partial<BridgeEvent> & { event: string; session_id: string }): Promise<{ status: number }> {
  return fetch(`${http}/bridge/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": cfg.bridgeToken },
    body: JSON.stringify({ cwd: "/tmp", ...ev }),
  }).then(async (r) => ({ status: r.status }));
}

const extId = (cli: string) => "ext-" + cli;
const st = (cli: string) => mgr.getExternal(extId(cli))!;

// 真进程助手：活=长眠 node（ps 可见、映像=node 命中 VALID_TARGET）；死=已退出
async function spawnLive(): Promise<number> {
  const p = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" });
  sleepers.push(p);
  await wait(250); // ps 可见性
  return p.pid!;
}
async function spawnDead(): Promise<number> {
  const p = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((r) => p.once("exit", () => r()));
  return p.pid!;
}

// 局部开死亡扫描直调（同 test-bridge 46/144 段手法）
function sweep(): void {
  process.env.CCR_DEAD_SWEEP = "1";
  (bridge as unknown as { sweepWorkingIdle(): void }).sweepWorkingIdle();
  process.env.CCR_DEAD_SWEEP = "0";
}

const alarmed = (cli: string) => JSON.stringify(mgr.getExternalLogs(extId(cli))).includes("CLI 进程已退出");

assert((await fetch(`${http}/health`)).ok, "server listening");

// T1 陈旧死 pid 事件不覆盖活 pid + 误报循环断链（生产 ext-29ab 拉锯的最小复刻）
{
  const live1 = await spawnLive();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-a", prompt: "陈旧拒绝", cli_pid: live1 });
  await wait(150);
  assert(st("clidead-a").status === "WORKING", "T1 session WORKING");
  assert(st("clidead-a").cli_pid === live1, "T1 live pid adopted");

  const dead2 = await spawnDead();
  // 同会话后续 hook 事件携带已死旧 pid（= resume 后 hook 缓存未失效时的上报形态）
  await hook({ event: "PostToolUse", session_id: "clidead-a", tool_name: "Bash", cli_pid: dead2 });
  await hook({ event: "PostToolUse", session_id: "clidead-a", tool_name: "Bash", cli_pid: dead2 });
  await wait(150);
  assert(st("clidead-a").cli_pid === live1, "T1 stale dead pid rejected (live pid kept)");

  sweep();
  assert(st("clidead-a").status === "WORKING", "T1 sweep keeps WORKING (no false alarm)");
  assert(!alarmed("clidead-a"), "T1 no「CLI 进程已退出」log");
}

// T2 resume 换代：记录 pid 已死 → 事件携带新活 pid 正常采纳（恢复闭环不回归）
{
  const dead1 = await spawnDead();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-b", prompt: "resume 换代", cli_pid: dead1 });
  await wait(150);
  assert(st("clidead-b").cli_pid === dead1, "T2 dead pid initially recorded");

  const live2 = await spawnLive();
  await hook({ event: "PostToolUse", session_id: "clidead-b", tool_name: "Bash", cli_pid: live2 });
  await wait(150);
  assert(st("clidead-b").cli_pid === live2, "T2 new live pid adopted (resume generation)");

  sweep();
  assert(st("clidead-b").status === "WORKING", "T2 sweep keeps WORKING after adoption");
  assert(!alarmed("clidead-b"), "T2 no alarm after adoption");
}

// T3 真死仍报（防漏报锚）：死 pid、无后续事件 → disconnected + 报文
{
  const dead3 = await spawnDead();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-c", prompt: "真死场景", cli_pid: dead3 });
  await wait(150);
  assert(st("clidead-c").status === "WORKING", "T3 starts WORKING");
  sweep();
  assert(st("clidead-c").status === "DONE" && st("clidead-c").done_reason === "disconnected", "T3 real death → disconnected");
  assert(alarmed("clidead-c"), "T3「CLI 进程已退出」reported for real death");
}

// T4 补定位顺序：sessions/*.json 活证据压过缓存死 pid（boot/heal 新顺序）
{
  const live4 = await spawnLive();
  const dead4 = await spawnDead();
  // 活进程自写的会话文件（reconcile 的权威源）+ 缓存里的陈旧死 pid
  writeFileSync(join(SROOT, `${live4}.json`), JSON.stringify({ sessionId: "clidead-t4" }));
  const cacheFile = join(TDATA, "cli-pids.json");
  writeFileSync(cacheFile, JSON.stringify({ "clidead-t4": dead4 }));
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t4", prompt: "顺序验证" }); // 无 pid 建卡
  await wait(150);
  assert(!st("clidead-t4").cli_pid, "T4 session starts pid-less");

  const b = bridge as unknown as { reconcilePidsFromSessions(): void; hydratePidsFromCache(): void };
  b.reconcilePidsFromSessions(); // 新顺序第一步：活证据先行
  b.hydratePidsFromCache();      // 新顺序第二步：缓存兜底
  assert(st("clidead-t4").cli_pid === live4, "T4 live sessions-file pid wins over stale cache");
}

// T5 缓存死 pid 无活证据时仍补水 → 真死仍报（补水通路不因根修变聋）
{
  const dead5 = await spawnDead();
  writeFileSync(join(TDATA, "cli-pids.json"), JSON.stringify({ "clidead-t5": dead5 }));
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t5", prompt: "缓存兜底" });
  await wait(150);
  const b = bridge as unknown as { reconcilePidsFromSessions(): void; hydratePidsFromCache(): void };
  b.reconcilePidsFromSessions(); // 无活证据，no-op
  b.hydratePidsFromCache();      // 缓存兜底补水（保持原语义：缓存仍是最后定位来源）
  assert(st("clidead-t5").cli_pid === dead5, "T5 cached pid still hydrates when nothing live");
  sweep();
  assert(st("clidead-t5").status === "DONE" && st("clidead-t5").done_reason === "disconnected", "T5 hydrated dead pid → real death reported");
}

// T6 hook 子进程 walk-first：死缓存被活祖先链压过 + 缓存回写（HOME 隔离不触生产）
// 注意：本套件若跑在 relay 托管会话里，Bash/子进程继承 CCR_RELAY_CHILD=1，会触发
// hook 首行守卫静默退出——子进程 env 必须剥离该变量（2026-10-15 T6 假阴性实录）
const hookEnv = (home: string): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete e.CCR_RELAY_CHILD;
  return e;
};
{
  const hookSrc = fileURLToPath(new URL("../hooks/bridge-hook.mjs", import.meta.url));
  const home6 = mkdtempSync(join(tmpdir(), "clidead-home-"));
  const data6 = join(home6, ".cc-deck", "data");
  mkdirSync(data6, { recursive: true });
  // bridge.json 指向关闭端口：POST 秒失败（PreToolUse rounds=1），hook 静默退出
  writeFileSync(join(data6, "bridge.json"), JSON.stringify({ port: 59901, token: "t" }));
  const dead6 = await spawnDead();
  writeFileSync(join(data6, "cli-pids.json"), JSON.stringify({ "clidead-hook": dead6 }));

  const child = spawn(process.execPath, [hookSrc], {
    env: hookEnv(home6),
    stdio: ["pipe", "ignore", "ignore"],
  });
  // 链：hook ← 本测试进程（node 非壳）→ 祖先 walk 第一步即命中测试进程 pid
  child.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "clidead-hook", cwd: "/tmp/.tmp-clidead-probe/x", tool_name: "Bash" }));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  await once(child, "exit");
  clearTimeout(timer);

  const diag = readFileSync(join(data6, "hook-debug.log"), "utf-8");
  assert(diag.includes(`cli_pid=${process.pid}`), "T6 walk-first: live ancestor beats stale cached pid");
  const cache6 = JSON.parse(readFileSync(join(data6, "cli-pids.json"), "utf-8")) as Record<string, number>;
  assert(cache6["clidead-hook"] === process.pid, "T6 cache rewritten to walked pid");
  assert(diag.includes("cli_pid=0") === false || !diag.split("\n").some((l) => l.includes("cli_pid=0") && l.includes("clidead-hook")), "T6 no zero-pid fallback");

  // T6b 快路径：缓存 pid 恰为直接父进程（常态）→ 零探测采信
  writeFileSync(join(data6, "cli-pids.json"), JSON.stringify({ "clidead-hook2": process.pid }));
  const child2 = spawn(process.execPath, [hookSrc], {
    env: hookEnv(home6),
    stdio: ["pipe", "ignore", "ignore"],
  });
  child2.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "clidead-hook2", cwd: "/tmp/.tmp-clidead-probe/x", tool_name: "Bash" }));
  child2.stdin.end();
  const timer2 = setTimeout(() => child2.kill("SIGKILL"), 20_000);
  await once(child2, "exit");
  clearTimeout(timer2);
  const diag2 = readFileSync(join(data6, "hook-debug.log"), "utf-8");
  // diag 的 session 字段截断到 8 字符（session=clidead-），按事件行序断言第二条
  const evLines = diag2.split("\n").filter((l) => l.includes("event=PreToolUse"));
  assert(evLines.length === 2 && evLines[1].includes(`cli_pid=${process.pid}`), "T6b fast path: cached ppid adopted");
  rmSync(home6, { recursive: true, force: true });
}

// T7 双副本 hook 逐字节一致（单源双形态防漂移）
{
  const a = readFileSync(fileURLToPath(new URL("../hooks/bridge-hook.mjs", import.meta.url)));
  const b = readFileSync(fileURLToPath(new URL("../../cc-plugins/plugins/cc-deck/scripts/hook.mjs", import.meta.url)));
  assert(a.equals(b), "T7 hook copies byte-identical");
}

// ============ cliflap（1103 用户实锤 P0）：乒乓穿透面——hook 失联形态 ============
// #49（T1/T2/T4）修的是 hook 在报时的 pid 采纳链；本形态 hook 全失联（「未见主动
// 结束上报」）——无新 pid 输入，s.cli_pid 停在陈旧值，deadSweep 判死↔转录增长（新
// 进程真写）翻回，分钟级十数轮。三修：①转录增长守卫（实干不判退）②退出滞回带
// （真死只报一次）③恢复播报限频（乒乓放大器）。

// T8 修①：WORKING+死 pid+转录 5min 内增长 → sweep 不判退不报文（修前=刷屏源）
{
  const dead8 = await spawnDead();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t8", prompt: "cliflap 守卫", cli_pid: dead8 });
  await wait(150);
  assert(st("clidead-t8").status === "WORKING", "T8 starts WORKING");
  // 模拟「新进程真在写转录」（pushAssistantTexts 增量链的记账位——测试直调等价）
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t8"), Date.now());
  sweep();
  assert(st("clidead-t8").status === "WORKING", "T8 转录增长中：sweep 不判退（陈旧 pid 守卫——实干会话零误报）");
  assert(!alarmed("clidead-t8"), "T8 无「已退出」报文（刷屏源根除）");
  // 增长停 5min 后（守卫过期）真死照报（守卫不是免死金牌）
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t8"), Date.now() - 301_000);
  sweep();
  assert(st("clidead-t8").done_reason === "disconnected", "T8 增长停+pid 死：照常 disconnected（守卫窗口有限）");
  assert(alarmed("clidead-t8"), "T8 真死报文在场");
}

// T9 修②：退出滞回带——报过一次后带内二次到达不重报（乒乓收殓）
{
  const logsBefore = JSON.stringify(mgr.getExternalLogs(extId("clidead-t8"))).split("CLI 进程已退出").length - 1;
  // 模拟 pollCliStatus 竞速翻回（残留增长）后再进 sweep：手动翻 WORKING+带内再 sweep
  mgr.setExternalStatus(extId("clidead-t8"), "WORKING", "竞速翻回模拟");
  sweep(); // deadSweepAt 带内（刚报过）
  const logsAfter = JSON.stringify(mgr.getExternalLogs(extId("clidead-t8"))).split("CLI 进程已退出").length - 1;
  assert(logsAfter === logsBefore, `T9 滞回带内不重报（前 ${logsBefore} 后 ${logsAfter}——真死只报一次）`);
}

// T10 修③：恢复播报限频——带内翻 WORKING 状态照翻、播报不重复
{
  const dead10 = await spawnDead();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t10", prompt: "恢复限频", cli_pid: dead10 });
  await wait(150);
  // 先推 DONE 形态（非 WORKING 才能 触发恢复分支）+增长新鲜
  mgr.setExternalStatus(extId("clidead-t10"), "DONE", "先落");
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t10"), Date.now());
  const poll = () => { process.env.CCR_DEAD_SWEEP = "1"; (bridge as unknown as { pollCliStatus(): void }).pollCliStatus(); process.env.CCR_DEAD_SWEEP = "0"; };
  poll();
  const first = JSON.stringify(mgr.getExternalLogs(extId("clidead-t10"))).split("CLI 状态恢复运行").length - 1;
  assert(first === 1, `T10 首次恢复播报一条（实 ${first}）`);
  // 竞速窗模拟：再落 DONE+带内再 poll → 状态翻 WORKING 但播报静默
  mgr.setExternalStatus(extId("clidead-t10"), "DONE", "竞速再落");
  (bridge as unknown as { cliStatusAt: Map<string, number> }).cliStatusAt.delete(extId("clidead-t10")); // 清 5s 轮询节流（测试两次 poll 毫秒间隔会被节流吞）
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t10"), Date.now());
  poll();
  const second = JSON.stringify(mgr.getExternalLogs(extId("clidead-t10"))).split("CLI 状态恢复运行").length - 1;
  assert(second === 1, `T10 带内重复翻回零新播报（前 1 后 ${second}——乒乓放大器拆除）`);
  assert(st("clidead-t10").status === "WORKING", `T10 状态照翻（真活必须 WORKING——限频只限播报不限状态）`);
}

// T11 cliflap R2-P2-1：busy 子句新鲜度——死 pid+busy 状态文件+lastGrow 过期 → 不翻回零播报
//（修前=cliSessionStatus 裸读无新鲜度，真死会话被无条件翻 WORKING→滞回带满重报→5min 一对无限刷）
{
  const { homedir } = await import("node:os");
  const dead11 = await spawnDead();
  const busyFile = join(homedir(), ".claude", "sessions", `${dead11}.json`);
  mkdirSync(join(homedir(), ".claude", "sessions"), { recursive: true });
  writeFileSync(busyFile, JSON.stringify({ status: "busy" }), "utf-8"); // CLI mid-turn 被杀：文件卡 busy（无时钟无新鲜度）
  sleepers.push({ kill: () => { try { rmSync(busyFile, { force: true }); } catch {} } });
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t11", prompt: "busy 新鲜度", cli_pid: dead11 });
  await wait(150);
  const poll11 = () => { process.env.CCR_DEAD_SWEEP = "1"; (bridge as unknown as { pollCliStatus(): void }).pollCliStatus(); process.env.CCR_DEAD_SWEEP = "0"; };
  const countResume = () => JSON.stringify(mgr.getExternalLogs(extId("clidead-t11"))).split("CLI 状态恢复运行").length - 1;
  // 面 A（修前刷屏形态）：DONE + busy 文件 + lastGrow 过期（301s 前）→ 不翻回零播报
  mgr.setExternalStatus(extId("clidead-t11"), "DONE", "T11 先落");
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t11"), Date.now() - 301_000);
  (bridge as unknown as { cliStatusAt: Map<string, number> }).cliStatusAt.delete(extId("clidead-t11"));
  poll11();
  assert(st("clidead-t11").status === "DONE", "T11 死 pid+busy 文件+lastGrow 过期：不翻回 WORKING（busy 子句受 300s 新鲜度约束——B 审攻点3）");
  assert(countResume() === 0, `T11 陈旧 busy 零播报（实 ${countResume()}——对死进程假报「恢复运行（状态文件）」根除）`);
  // 面 B（活形态不误伤）：DONE + busy 文件 + lastGrow 新鲜 → 照常翻回+播报一条
  mgr.setExternalStatus(extId("clidead-t11"), "DONE", "T11 再落");
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t11"), Date.now());
  (bridge as unknown as { cliStatusAt: Map<string, number> }).cliStatusAt.delete(extId("clidead-t11"));
  poll11();
  assert(st("clidead-t11").status === "WORKING", "T11 busy+转录新鲜：照常翻回 WORKING（真活必须翻——守卫不误伤）");
  assert(countResume() === 1, `T11 新鲜 busy 播报恰一条（实 ${countResume()}）`);
  rmSync(busyFile, { force: true });
}

// T11b cliflap R2-P2-2：forget 清三 Map（防乒乓防抖账无界涨）+set 位 cap 纪律
{
  const id = extId("clidead-t11");
  const b = bridge as unknown as { deadSweepAt: Map<string, number>; resumeAnnouncedAt: Map<string, number>; deadGrowNoteAt: Map<string, number>; forget(id: string): void };
  b.deadSweepAt.set(id, 1);
  b.resumeAnnouncedAt.set(id, 1);
  b.deadGrowNoteAt.set(id, 1);
  assert(b.deadSweepAt.has(id) && b.resumeAnnouncedAt.has(id) && b.deadGrowNoteAt.has(id), "T11b 前置：三 Map 键在场");
  b.forget(id);
  assert(!b.deadSweepAt.has(id) && !b.resumeAnnouncedAt.has(id) && !b.deadGrowNoteAt.has(id), "T11b forget 后三 Map 无残留键（deadSweepAt/resumeAnnouncedAt/deadGrowNoteAt——B 审攻点4）");
}

// T12 hookloop 刀1：挂起形态不判死——hooked+静默超窗+终端进程活 → 不判死不播报
//（21h 会话乒乓判死侧根除；修前=15min 静默即判「hook 失联兜底」误收活回合）
{
  const live12 = await spawnLive();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t12", prompt: "挂起守卫", cli_pid: live12 });
  await wait(150);
  assert(st("clidead-t12").status === "WORKING", "T12 starts WORKING");
  // 三时钟压旧（16min>900s 窗；idleSince=max(lastGrow,lastHookAt,updated_at) 全旧才满窗）
  const old12 = Date.now() - 16 * 60_000;
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t12"), old12);
  (bridge as unknown as { lastHookAt: Map<string, number> }).lastHookAt.set(extId("clidead-t12"), old12);
  (mgr.getExternal(extId("clidead-t12")) as unknown as { updated_at: number }).updated_at = old12;
  sweep();
  const deadNotes = () => JSON.stringify(mgr.getExternalLogs(extId("clidead-t12"))).split("hook 失联兜底").length - 1;
  assert(st("clidead-t12").status === "WORKING", "T12 静默窗满但终端进程活：不判死（hookloop 刀1——进程活=回合可能还在）");
  assert(deadNotes() === 0, `T12 零「hook 失联兜底」播报（实 ${deadNotes()}——21h 刷屏判死侧根除）`);
  // 面 B 次级门：CLI 自写状态报 idle 且超双窗（31min>30min）→ 允许判（防 hook 永久失联卡 WORKING）
  const { homedir } = await import("node:os");
  const idleFile = join(homedir(), ".claude", "sessions", `${live12}.json`);
  mkdirSync(join(homedir(), ".claude", "sessions"), { recursive: true });
  writeFileSync(idleFile, JSON.stringify({ status: "idle" }), "utf-8");
  sleepers.push({ kill: () => { try { rmSync(idleFile, { force: true }); } catch {} } });
  const old12b = Date.now() - 31 * 60_000;
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t12"), old12b);
  (bridge as unknown as { lastHookAt: Map<string, number> }).lastHookAt.set(extId("clidead-t12"), old12b);
  (mgr.getExternal(extId("clidead-t12")) as unknown as { updated_at: number }).updated_at = old12b;
  sweep();
  assert(st("clidead-t12").status === "DONE", "T12b 进程活+CLI 自报 idle+超双窗：照常判（次级门——守卫不是免死金牌）");
  assert(deadNotes() === 1, `T12b 判死播报恰一条（实 ${deadNotes()}）`);
}

// T12c hookloop 真死回归（红线）：进程死+hook 失联 → 真死收殓一次不循环
{
  const dead12c = await spawnDead();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t12c", prompt: "真死回归", cli_pid: dead12c });
  await wait(150);
  const old12c = Date.now() - 16 * 60_000;
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t12c"), old12c);
  (bridge as unknown as { lastHookAt: Map<string, number> }).lastHookAt.set(extId("clidead-t12c"), old12c);
  (mgr.getExternal(extId("clidead-t12c")) as unknown as { updated_at: number }).updated_at = old12c;
  sweep();
  assert(st("clidead-t12c").done_reason === "disconnected", "T12c 进程死：走真死收殓（disconnected——刀1 不拦权威死证）");
  assert(alarmed("clidead-t12c"), "T12c 「CLI 进程已退出」报文在场（真死报一次）");
  // 死 pid 无活可寻：水合穿孔翻活不生效（循环断链）+二扫不重报
  (bridge as unknown as { reviveOnHydrate(id: string): void }).reviveOnHydrate(extId("clidead-t12c"));
  assert(st("clidead-t12c").status !== "WORKING", "T12c 死 pid：reviveOnHydrate 不翻活（无进程证据不翻——循环断）");
  const notesBefore = JSON.stringify(mgr.getExternalLogs(extId("clidead-t12c"))).split("CLI 进程已退出").length - 1;
  sweep();
  const notesAfter = JSON.stringify(mgr.getExternalLogs(extId("clidead-t12c"))).split("CLI 进程已退出").length - 1;
  assert(notesAfter === notesBefore, `T12c 二扫不重报（前 ${notesBefore} 后 ${notesAfter}——真死只报一次）`);
}

// T13 hookloop 刀2：循环检测冻结——判死↔翻活 1h 内 ≥3 对 → 冻结+告警一次+静默翻活抑制
{
  const live13 = await spawnLive();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t13", prompt: "循环冻结", cli_pid: live13 });
  await wait(150);
  const b13 = bridge as unknown as { noteLoopEvent(id: string, kind: "death" | "revive"): void; loopFrozen(id: string): boolean; reviveOnHydrate(id: string): void };
  const alarmNotes = () => JSON.stringify(mgr.getExternalLogs(extId("clidead-t13"))).split("判死-接管循环").length - 1;
  for (let i = 0; i < 2; i++) { b13.noteLoopEvent(extId("clidead-t13"), "death"); b13.noteLoopEvent(extId("clidead-t13"), "revive"); }
  assert(!b13.loopFrozen(extId("clidead-t13")), "T13 前置：2 对未冻结（阈值 3）");
  assert(alarmNotes() === 0, "T13 前置：未到阈值零告警");
  b13.noteLoopEvent(extId("clidead-t13"), "death");
  b13.noteLoopEvent(extId("clidead-t13"), "revive");
  assert(b13.loopFrozen(extId("clidead-t13")), "T13 1h 内 3 对：冻结生效");
  assert(alarmNotes() === 1, `T13 冻结告警恰一条（实 ${alarmNotes()}）`);
  // 冻结抑制静默翻活：DONE+活 pid 直调 reviveOnHydrate → 不翻不播
  mgr.setExternalStatus(extId("clidead-t13"), "DONE", "T13 先落");
  b13.reviveOnHydrate(extId("clidead-t13"));
  assert(st("clidead-t13").status === "DONE", "T13 冻结中：静默翻活被抑制（状态定格——以进程为凭）");
  const reviveNotes = () => JSON.stringify(mgr.getExternalLogs(extId("clidead-t13"))).split("重启后检测到终端进程仍在运行").length - 1;
  assert(reviveNotes() === 0, `T13 冻结中接管播报零（实 ${reviveNotes()}——复活侧刷屏根除）`);
  // 解冻①：hook 恢复 → 台账清 → 静默翻活复活（自愈链不破坏）
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t13", prompt: "hook 回来了", cli_pid: live13 });
  await wait(150);
  assert(!b13.loopFrozen(extId("clidead-t13")), "T13 hook 恢复：冻结解除（循环前提消失）");
  mgr.setExternalStatus(extId("clidead-t13"), "DONE", "T13 再落");
  b13.reviveOnHydrate(extId("clidead-t13"));
  assert(st("clidead-t13").status === "WORKING", "T13 解冻后：接管翻活照常（#276/#50 自愈链保持）");
  assert(reviveNotes() === 1, `T13 解冻后接管播报恰一条（实 ${reviveNotes()}）`);
}

// T14 hookloop 刀3：判死播报限频——5min 带内二次判死零新播报
{
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t14", prompt: "限频" }); // 无 cli_pid：进程探测无果 → 判死路径可达（无 disconnected 分流）
  await wait(150);
  const old14 = Date.now() - 16 * 60_000;
  const clockOld = () => {
    (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(extId("clidead-t14"), old14);
    (bridge as unknown as { lastHookAt: Map<string, number> }).lastHookAt.set(extId("clidead-t14"), old14);
    (mgr.getExternal(extId("clidead-t14")) as unknown as { updated_at: number }).updated_at = old14;
  };
  clockOld();
  sweep();
  const deadNotes14 = () => JSON.stringify(mgr.getExternalLogs(extId("clidead-t14"))).split("hook 失联兜底").length - 1;
  assert(deadNotes14() === 1, `T14 首次判死播报一条（实 ${deadNotes14()}）`);
  // 翻回 WORKING+时钟再压旧 → 带内二次判死：状态照收、播报静默
  mgr.setExternalStatus(extId("clidead-t14"), "WORKING", "竞速翻回模拟");
  clockOld();
  sweep();
  assert(deadNotes14() === 1, `T14 带内二次判死零新播报（实 ${deadNotes14()}——限频只限播报）`);
  assert(st("clidead-t14").status === "DONE", "T14 二次判死状态照收（限频不限判定）");
}

// T14b hookloop 台账 forget 清账（防防抖账无界涨——cliflap R2-P2-2 同纪律）
{
  const id = extId("clidead-t14");
  const b = bridge as unknown as { hookLoopPairs: Map<string, number[]>; hookLoopFrozenAt: Map<string, number>; pendingDeathAt: Map<string, number>; sysRate: Map<string, { at: number; n: number; total: number }>; forget(id: string): void };
  b.hookLoopPairs.set(id, [Date.now()]);
  b.hookLoopFrozenAt.set(id, Date.now());
  b.pendingDeathAt.set(id, Date.now());
  b.sysRate.set(id + "|hook-dead", { at: Date.now(), n: 1, total: 1 });
  b.sysRate.set(id + "|revive-takeover", { at: Date.now(), n: 1, total: 1 });
  assert(b.hookLoopPairs.has(id) && b.hookLoopFrozenAt.has(id) && b.sysRate.size >= 2, "T14b 前置：四台账键在场");
  b.forget(id);
  assert(!b.hookLoopPairs.has(id) && !b.hookLoopFrozenAt.has(id) && !b.pendingDeathAt.has(id), "T14b forget 后三 Map 无残留键");
  assert(!b.sysRate.has(id + "|hook-dead") && !b.sysRate.has(id + "|revive-takeover"), "T14b forget 后 sysRate 前缀键无残留（id|tag 扫描清）");
}

// ============ hookloop R2（1104 双审）：冻结可持续/口序/第四对 ============

// T15 R2-P1 冻结可持续：陈旧冻结条目（>1h）不再阻断二次冻结——过期删账+!loopFrozen 再触发
{
  const b = bridge as unknown as { hookLoopPairs: Map<string, number[]>; hookLoopFrozenAt: Map<string, number>; pendingDeathAt: Map<string, number>; noteLoopEvent(id: string, kind: "death" | "revive"): void; loopFrozen(id: string): boolean };
  const d15 = await spawnDead();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t15", prompt: "冻结可持续", cli_pid: d15 });
  await wait(150);
  const id = extId("clidead-t15");
  // 场景：首冻 2h 前（已过期），台账残留陈旧冻结条目——修前 get()!==undefined 恒阻断二次冻结
  b.hookLoopFrozenAt.set(id, Date.now() - 2 * 3_600_000);
  b.hookLoopPairs.delete(id);
  assert(b.loopFrozen(id) === false, "T15 陈旧冻结条目已过期（loopFrozen=false——读时顺手删账）");
  assert(!b.hookLoopFrozenAt.has(id), "T15 过期冻结条目读时被删（陈旧账不滞留）");
  // 1h 内再造 3 对 → 二次冻结必须触发（修前=永不触发，乒乓零制动复发）
  for (let i = 0; i < 3; i++) {
    b.noteLoopEvent(id, "death");
    b.noteLoopEvent(id, "revive");
  }
  assert(b.hookLoopFrozenAt.has(id) && b.loopFrozen(id) === true, "T15 过期后 3 对再冻结触发（冻结可持续——非 1h 定时炸弹）");
  const fzLog = JSON.stringify(mgr.getExternalLogs(id)).split("静默判定已冻结").length - 1;
  assert(fzLog === 1, `T15 再冻结告警播一次（实 ${fzLog}——告警重播口径随再冻结成立）`);
  b.hookLoopFrozenAt.delete(id); b.hookLoopPairs.delete(id); b.pendingDeathAt.delete(id);
}

// T16 R2-P2-1 口序：冻结中进程换代 → 解冻并翻活（修前=冻结闸先挡，换代清账不可达）
{
  const dead16 = await spawnDead();
  const live16 = await spawnLive();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t16", prompt: "口序", cli_pid: dead16 });
  await wait(150);
  const id16 = extId("clidead-t16");
  const b16 = bridge as unknown as { hookLoopFrozenAt: Map<string, number>; reviveOnHydrate(id: string): void };
  mgr.setExternalStatus(id16, "DONE", "判死态");
  b16.hookLoopFrozenAt.set(id16, Date.now()); // 冻结中
  (mgr.getExternal(id16) as unknown as { cli_pid: number }).cli_pid = dead16; // 旧代（死 pid）
  // findAliveCliProcess 第二源：pid cache 注入活 pid（sid=relay_session_id||去 ext- 前缀）= 换代形态
  const cacheFile = join(TDATA, "cli-pids.json");
  writeFileSync(cacheFile, JSON.stringify({ "clidead-t16": live16 }), "utf-8");
  b16.reviveOnHydrate(id16);
  await wait(150);
  assert(!b16.hookLoopFrozenAt.has(id16), "T16 冻结中进程换代：清账先于冻结闸（口②真实可达——冻结条目随换代清除）");
  assert(st("clidead-t16").status === "WORKING", "T16 换代后翻活（修前=冻结闸先挡永不翻）");
  try { rmSync(cacheFile, { force: true }); } catch {}
}

// T16b R2-P2-1 反面：冻结中同代（pid 不变）仍抑制
{
  const live16b = await spawnLive();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t16b", prompt: "同代", cli_pid: live16b });
  await wait(150);
  const id16b = extId("clidead-t16b");
  const b16b = bridge as unknown as { hookLoopFrozenAt: Map<string, number>; reviveOnHydrate(id: string): void };
  mgr.setExternalStatus(id16b, "DONE", "判死态");
  b16b.hookLoopFrozenAt.set(id16b, Date.now());
  (mgr.getExternal(id16b) as unknown as { cwd: string }).cwd = process.cwd();
  (mgr.getExternal(id16b) as unknown as { cli_pid: number }).cli_pid = live16b; // 同代活 pid
  b16b.reviveOnHydrate(id16b);
  await wait(100);
  assert(st("clidead-t16b").status === "DONE", "T16b 冻结中同代：静默翻活仍抑制（抑制语义不因口序调整丢失）");
}

// T17 R2-P2-4 第四对：无 hook 会话判死侧记账+限频（修前=零记账零限频）
{
  const b17 = bridge as unknown as { hookLoopPairs: Map<string, number[]>; sysRate: Map<string, { at: number; n: number; total: number }> };
  const id17 = extId("clidead-t17");
  // 造无 hook 会话（不 POST hook——直接 setExternal 不可：测试面经 hook/ensureExternal。用 hook 建后把 lastHookAt/noHookIds 置无 hook 形态）
  const dead17 = await spawnDead();
  await hook({ event: "UserPromptSubmit", session_id: "clidead-t17", prompt: "第四对", cli_pid: dead17 });
  await wait(150);
  // 转「无 hook」形态：清 lastHookAt + 入 noHookIds + status WORKING + 双时钟压旧（>90s idle 档）
  (bridge as unknown as { lastHookAt: Map<string, number> }).lastHookAt.delete(id17);
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(id17, Date.now() - 120_000);
  (mgr.getExternal(id17) as unknown as { updated_at: number }).updated_at = Date.now() - 120_000;
  const noHookIds = (bridge as unknown as { noHookIds: Set<string> }).noHookIds;
  noHookIds.add(id17);
  sweep(); // sweepWorkingIdle 死 pid 分支先收（disconnected）——无 hook 扫描不达。改走 sweepNoHookIdle？
  // sweepWorkingIdle 对死 pid 会走 disconnected 收殓（非第四对）；第四对判死侧=sweepNoHookIdle
  // （无 hook 会话专属扫描）。直调该扫描器：
  const sweepNH = (bridge as unknown as { sweepNoHookIdle(): void }).sweepNoHookIdle.bind(bridge);
  mgr.setExternalStatus(id17, "WORKING", "再造工作态");
  noHookIds.add(id17);
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(id17, Date.now() - 120_000);
  (bridge as unknown as { turnShape: Map<string, string> }).turnShape.set(id17, "end"); // end 档=90s 窗（gen 档 600s）
  sweepNH();
  const nhLog = () => JSON.stringify(mgr.getExternalLogs(id17)).split("转录静默，回合视作结束").length - 1;
  assert(st("clidead-t17").status === "DONE", "T17 无 hook 静默判死照常（判定不因限频改变）");
  assert(nhLog() === 1, `T17 首次判死播报一条（实 ${nhLog()}）`);
  // 带内二次：状态翻回+时钟压旧再扫 → 播报静默但记账累积
  mgr.setExternalStatus(id17, "WORKING", "竞速翻回");
  noHookIds.add(id17);
  (bridge as unknown as { lastGrow: Map<string, number> }).lastGrow.set(id17, Date.now() - 120_000);
  (mgr.getExternal(id17) as unknown as { updated_at: number }).updated_at = Date.now() - 120_000;
  (bridge as unknown as { turnShape: Map<string, string> }).turnShape.set(id17, "end");
  sweepNH();
  assert(nhLog() === 1, `T17 带内二次判死零新播报（实 ${nhLog()}——第四对限频生效）`);
  assert(b17.sysRate.has(id17 + "|nohook-dead"), "T17 第四对记账入 sysRate（nohook-dead tag）");
  // 死亡侧记账与 revive 配对成对（noteLoopEvent death 入 pendingDeathAt）
  const hasDeath = (bridge as unknown as { pendingDeathAt: Map<string, number> }).pendingDeathAt.has(id17);
  assert(hasDeath, "T17 判死入 pendingDeathAt（与 revive 配对——第四对进乒乓台账）");
}

// T17b R2-P2-2 账对称：hook 恢复（解冻口①）三账齐清
{
  const id17b = extId("clidead-t17");
  const b = bridge as unknown as { hookLoopPairs: Map<string, number[]>; hookLoopFrozenAt: Map<string, number>; pendingDeathAt: Map<string, number> };
  b.hookLoopPairs.set(id17b, [Date.now()]);
  b.hookLoopFrozenAt.set(id17b, Date.now());
  b.pendingDeathAt.set(id17b, Date.now());
  await hook({ event: "Stop", session_id: "clidead-t17", prompt: "", cli_pid: 0 });
  await wait(150);
  assert(!b.hookLoopPairs.has(id17b) && !b.hookLoopFrozenAt.has(id17b) && !b.pendingDeathAt.has(id17b), "T17b hook 恢复三账齐清（含 pendingDeathAt——修前漏清误配对）");
}

cleanup();
console.log("clidead: all ok");
process.exit(0);
