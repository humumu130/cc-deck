// P0-B（DEV-19 2026-11-26）hook 上报腿健康链专项测试——「注入链全灭」定谳后的防线：
// 事故链：relay 11-24 23:46 死后 hook 全量 post fail 只进 hook-debug.log（无观察者+
// 256KB 自清空灭证）26h+ 无人知晓；巡检报告「无帧(999m)」则是压缩存储语义被误读。
// 本套锁四层：
//   A. 纯函数：nextState/shouldWriteState（成败翻转/失败累计/30s 节流）
//   B. hook 真进程 e2e：本地 relay 桩（真 http server）→ ok 入账；server 死 → fail 入账；
//      hook-debug.log 超 256KB 轮转保 .1（不再清空灭证）
//   C. relay 轻探针 checkHookLeg：持续失败告警 / 健康零告警 / 复活补报一次性 / 恢复行
//   D. 独立哨兵 patrol-standalone.sh：语法 + relay 双拍确认触发独立通道告警 + 恢复行
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nextState, shouldWriteState } from "../hooks/bridge-hook.mjs";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { PatrolModule } from "../src/patrol.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; process.exitCode = 1; }
  else console.log(`ok - ${msg}`);
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const HOOK = join(repoRoot, "relay", "hooks", "bridge-hook.mjs");
const STANDALONE = join(repoRoot, "scripts", "patrol-standalone.sh");

// ---------- A. 纯函数 ----------
{
  const t0 = 1_700_000_000_000;
  const s1 = nextState(null, true, t0);
  assert(s1.streak === 0 && s1.lastOkAt === t0, "A1 首次成功建档：streak=0 lastOkAt=now");
  const s2 = nextState(s1, false, t0 + 1000, "fetch failed");
  assert(s2.streak === 1 && s2.firstFailAt === t0 + 1000 && s2.lastFailAt === t0 + 1000 && s2.lastOkAt === t0 && s2.lastErr === "fetch failed",
    "A2 成→败翻转：首败时刻落 firstFailAt，lastOkAt 保留");
  const s3 = nextState(s2, false, t0 + 60_000, "fetch failed");
  assert(s3.streak === 2 && s3.firstFailAt === t0 + 1000 && s3.lastFailAt === t0 + 60_000,
    "A3 连败累计：firstFailAt 不漂移，lastFailAt 推进");
  const s4 = nextState(s3, true, t0 + 120_000);
  assert(s4.streak === 0 && s4.lastOkAt === t0 + 120_000 && s4.firstFailAt === t0 + 1000 && s4.lastFailAt === t0 + 60_000 && s4.lastErr === null,
    "A4 败→成翻转：streak 归零清 lastErr，失败史保留（复活补报判 lastFailAt>lastOkAt 用）");
  const corrupt = nextState({ garbage: true } as unknown, false, t0, "x");
  assert(corrupt.streak === 1 && corrupt.firstFailAt === t0, "A5 脏账兜底：坏 prev 当空账重立");
  assert(shouldWriteState(null, s1), "A6 首次建档必写");
  assert(shouldWriteState(s1, s2), "A7 成败翻转必写");
  assert(!shouldWriteState(s2, { ...s3, lastWriteAt: s2.lastWriteAt + 5_000 }), "A8 同败态 5s 内节流不写");
  assert(shouldWriteState(s2, { ...s3, lastWriteAt: s2.lastWriteAt + 31_000 }), "A9 同败态超 30s 必写");
  assert(shouldWriteState(s3, s4), "A10 败成翻转必写");
}

// ---------- B. hook 真进程 e2e（本地 relay 桩 + 隔离 HOME） ----------
async function sectionB(): Promise<void> {
  const HOME = mkdtempSync(join(tmpdir(), "ccr-hookfail-home-"));
  const DATA = join(HOME, ".cc-deck", "data");
  mkdirSync(DATA, { recursive: true });
  // 预填 >256KB 诊断日志：验证轮转保留一代（v1 行为=清空灭证）
  writeFileSync(join(DATA, "hook-debug.log"), "x".repeat(300 * 1024));

  let hits = 0;
  let sawToken = false;
  const srv = createServer((req, res) => {
    hits++;
    sawToken = req.headers["x-bridge-token"] === "e2e-token";
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  writeFileSync(join(DATA, "bridge.json"), JSON.stringify({ port, token: "e2e-token" }));

  const env: NodeJS.ProcessEnv = { ...process.env, HOME };
  delete env.CCR_RELAY_CHILD; // 生产早退口不得命中

  // 异步 spawn（不用 spawnSync）：桩 server 在本进程——同步等子进程会饿死事件循环，
  // 子进程 fetch 撞 3s 假超时（排查实锤：r0 timeout + 状态账缺）
  const runHook = (event: Record<string, unknown>) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, [HOOK], { env });
      let stderr = "";
      p.stderr.on("data", (c) => (stderr += c));
      p.stdin.write(JSON.stringify(event));
      p.stdin.end();
      p.on("close", (code) => resolve({ status: code, stderr }));
    });

  // B1 成功腿：PostToolUse 上报本地桩 → post ok 入账 + 日志轮转
  const r1 = await runHook({ hook_event_name: "PostToolUse", session_id: "e2e-hookfail-ok", tool_name: "Bash", tool_use_id: "tu-ok-1", cwd: HOME });
  assert(r1.status === 0, `B1 hook 进程静默退出 0（实=${r1.status} ${r1.stderr.slice(0, 200)}）`);
  await wait(200);
  assert(hits >= 1 && sawToken, "B1 relay 桩收到 POST 且带 bridge token");
  const okState = JSON.parse(readFileSync(join(DATA, "hook-post-fail.json"), "utf-8")) as { streak: number; lastOkAt: number };
  assert(okState.streak === 0 && okState.lastOkAt > 0, "B1 成功入账：streak=0 lastOkAt>0");
  assert(readFileSync(join(DATA, "hook-debug.log"), "utf-8").includes("post ok"), "B1 诊断日志记 post ok");
  assert(existsSync(join(DATA, "hook-debug.log.1")) && readFileSync(join(DATA, "hook-debug.log.1"), "utf-8").length > 290 * 1024,
    "B1 诊断日志超限轮转保 .1（旧内容在，不清空灭证）");

  // B2 失败腿（三轮重试路）：桩死后 PostToolUse（rounds=3，2s/4s 退避）——
  // 同时锁 P0-B 修的 retry 死路：原先退避 timer unref → r0 败后进程提前退出，
  // r1/r2 从未跑过（relay 热换窗兜底=死代码），状态账也不会落
  await new Promise<void>((r) => srv.close(() => r()));
  const t0 = Date.now();
  const r2 = await runHook({ hook_event_name: "PostToolUse", session_id: "e2e-hookfail-fail", tool_name: "Bash", tool_use_id: "tu-fail-1", cwd: HOME });
  const durMs = Date.now() - t0;
  assert(r2.status === 0, `B2 失败腿 hook 仍静默退出 0（实=${r2.status} ${r2.stderr.slice(0, 200)}）`);
  const debug2 = readFileSync(join(DATA, "hook-debug.log"), "utf-8");
  assert(/post fail \(r2 /.test(debug2), "B2 三轮重试真跑完（r2 行在——retry 死路已修）");
  assert(durMs >= 5_500, `B2 退避时延在场（≥2s+4s，实=${durMs}ms）`);
  const failState = JSON.parse(readFileSync(join(DATA, "hook-post-fail.json"), "utf-8")) as { streak: number; firstFailAt: number; lastFailAt: number; lastErr: string | null };
  assert(failState.streak >= 1 && failState.lastFailAt > 0 && failState.firstFailAt > 0, "B2 失败入账：streak≥1 时刻链在");
  assert(String(failState.lastErr || "").length > 0, "B2 失败原因入账");
  assert(debug2.includes("post fail"), "B2 诊断日志记 post fail");

  rmSync(HOME, { recursive: true, force: true });
}

// ---------- C. relay 轻探针 checkHookLeg ----------
async function sectionC(): Promise<void> {
  const DATA = mkdtempSync(join(tmpdir(), "ccr-hookfail-patrol-"));
  process.env.CCR_DATA_DIR = DATA;
  const ORG = mkdtempSync(join(tmpdir(), "ccr-hookfail-org-"));
  process.env.CCR_ORG_DIR = ORG;
  const ART = join(DATA, "artifacts");
  mkdirSync(ART, { recursive: true });
  process.env.CCR_ARTIFACTS_DIR = ART;
  process.env.CCR_NO_LEADER = "1";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_STORAGE_READ_MODE = "json";

  const cfg = loadConfig();
  const bus = new EventBus();
  const mgr = new SessionManager(bus, cfg);
  const reportPath = join(DATA, "patrol-report.md");
  const reportText = () => { try { return readFileSync(reportPath, "utf-8"); } catch { return ""; } };
  const writeHookState = (s: Record<string, unknown>) => writeFileSync(join(DATA, "hook-post-fail.json"), JSON.stringify(s));

  // C1 无账本（新装/bridge.json 从未出现）→ 静默零告警
  {
    const m = new PatrolModule(mgr, { dataDir: DATA, reportPath, enabled: () => true });
    m.runLight();
    await wait(50);
    assert(!reportText().includes("hook-post-fail") && !reportText().includes("hook-dark-boot"), "C1 无账本：零告警（新装非病）");
  }

  // C2 持续失败（新鲜+超阈）→ 告警；随后恢复 → RECOVERED 行（独立报告文件防串景）
  {
    const rp = join(DATA, "rp-c2.md");
    const rt = () => { try { return readFileSync(rp, "utf-8"); } catch { return ""; } };
    const m = new PatrolModule(mgr, { dataDir: DATA, reportPath: rp, enabled: () => true });
    const now = Date.now();
    writeHookState({ v: 1, streak: 5, firstFailAt: now - 20 * 60_000, lastFailAt: now - 60_000, lastOkAt: now - 25 * 60_000, lastErr: "fetch failed", lastWriteAt: now });
    m.runLight();
    await wait(50);
    assert(rt().includes("[hook-post-fail]"), "C2 持续失败 → 告警行落报告");
    writeHookState({ v: 1, streak: 0, firstFailAt: now - 20 * 60_000, lastFailAt: now - 60_000, lastOkAt: now, lastErr: null, lastWriteAt: now });
    m.runLight();
    await wait(50);
    assert(rt().includes("RECOVERED [hook-post-fail]"), "C2 ok 翻转 → 恢复行");
  }

  // C3 陈旧失败（末次失败超新鲜窗——hook 只是没会话可跑）→ 不误报持续失败
  {
    const rp = join(DATA, "rp-c3.md");
    const rt = () => { try { return readFileSync(rp, "utf-8"); } catch { return ""; } };
    const m = new PatrolModule(mgr, { dataDir: DATA, reportPath: rp, enabled: () => true });
    const now = Date.now();
    writeHookState({ v: 1, streak: 3, firstFailAt: now - 2 * 3600_000, lastFailAt: now - 90 * 60_000, lastOkAt: now - 3 * 3600_000, lastErr: "fetch failed", lastWriteAt: now });
    m.runLight();
    await wait(50);
    assert(!rt().includes("[hook-post-fail]"), "C3 陈旧失败不告警（超新鲜窗=hook 无会话可跑非病）");
  }

  // C4 复活补报一次性：新 PatrolModule（bootAt=now）+ 末次失败早于 boot → 首拍补报，次拍不重报
  {
    const rp = join(DATA, "rp-c4.md");
    const rt = () => { try { return readFileSync(rp, "utf-8"); } catch { return ""; } };
    const m = new PatrolModule(mgr, { dataDir: DATA, reportPath: rp, enabled: () => true });
    const now = Date.now();
    writeHookState({ v: 1, streak: 3, firstFailAt: now - 2 * 3600_000, lastFailAt: now - 30 * 60_000, lastOkAt: now - 125 * 60_000, lastErr: "fetch failed", lastWriteAt: now });
    m.runLight();
    await wait(50);
    assert(rt().includes("[hook-dark-boot]"), "C4 断流跨重启窗 → 首拍复活补报");
    m.runLight();
    await wait(50);
    const n = rt().split("[hook-dark-boot]").length - 1;
    assert(n === 1, `C4 复活补报一次性（行数=1，实=${n}）`);
  }

  // C4b 复活即愈形态：relay 起后 hook 首个事件已把账翻 ok（streak=0 但失败段未闭合于
  // boot 前）——首拍仍须补报（否则翻转后证据在而永不再报）
  {
    const rp = join(DATA, "rp-c4b.md");
    const rt = () => { try { return readFileSync(rp, "utf-8"); } catch { return ""; } };
    const m = new PatrolModule(mgr, { dataDir: DATA, reportPath: rp, enabled: () => true });
    await wait(20); // 确保 ok 翻转时刻严格晚于模块 bootAt（同毫秒边界防抖）
    const now = Date.now();
    writeHookState({ v: 1, streak: 0, firstFailAt: now - 3 * 3600_000, lastFailAt: now - 30 * 60_000, lastOkAt: now, lastErr: null, lastWriteAt: now });
    m.runLight();
    await wait(50);
    assert(rt().includes("[hook-dark-boot]"), "C4b 复活即愈（ok 翻在 boot 后）→ 仍补报");
    assert(rt().includes("relay 起后已恢复"), "C4b 措辞带「已恢复」");
  }

  // C4c boot 前已闭环的失败段（停机前旧账）→ 不报
  {
    const rp = join(DATA, "rp-c4c.md");
    const rt = () => { try { return readFileSync(rp, "utf-8"); } catch { return ""; } };
    const now = Date.now();
    writeHookState({ v: 1, streak: 0, firstFailAt: now - 3 * 3600_000, lastFailAt: now - 2 * 3600_000, lastOkAt: now - 90 * 60_000, lastErr: null, lastWriteAt: now });
    const m = new PatrolModule(mgr, { dataDir: DATA, reportPath: rp, enabled: () => true });
    m.runLight();
    await wait(50);
    assert(!rt().includes("[hook-dark-boot]"), "C4c 停机前已闭环失败段 → 不误报");
  }

  // C5 账本损坏 → 静默不炸
  {
    const m = new PatrolModule(mgr, { dataDir: DATA, reportPath, enabled: () => true });
    writeFileSync(join(DATA, "hook-post-fail.json"), "{corrupt");
    m.runLight();
    await wait(50);
    assert(!reportText().includes("hook-leg check error"), "C5 脏账静默（不进错误日志刷屏）");
  }

  rmSync(DATA, { recursive: true, force: true });
  rmSync(ORG, { recursive: true, force: true });
}

// ---------- D. 独立哨兵 patrol-standalone.sh ----------
async function sectionD(): Promise<void> {
  const syntax = spawnSync("bash", ["-n", STANDALONE], { encoding: "utf-8" });
  assert(syntax.status === 0, `D1 语法检查过（${syntax.stderr || ""}）`);

  const T = mkdtempSync(join(tmpdir(), "ccr-hookfail-standalone-"));
  mkdirSync(join(T, "data"), { recursive: true });
  const notifyLog = join(T, "notify.log");
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATROL_REPORT: join(T, "report.md"),
    PATROL_DATA_DIR: join(T, "data"),
    PATROL_STATE: join(T, "state.json"),
    PATROL_ORG_DIR: join(T, "org"),
    PATROL_RELAY_URL: "http://127.0.0.1:9/", // 9=discard 端口，本机无监听=死 relay
    PATROL_NOTIFY: `echo "N|$1|$2" >> ${notifyLog}`,
  };
  mkdirSync(join(T, "org"), { recursive: true });
  const reportText = () => { try { return readFileSync(join(T, "report.md"), "utf-8"); } catch { return ""; } };
  const notifyCount = () => { try { return readFileSync(notifyLog, "utf-8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  // 异步 spawn：D5/D6 的活体桩 server 在本进程——spawnSync 会饿死事件循环，curl 拿不到响应
  const runOnce = (env: NodeJS.ProcessEnv = baseEnv) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const p = spawn("bash", [STANDALONE], { env });
      let stderr = "";
      p.stderr.on("data", (c) => (stderr += c));
      p.on("close", (code) => resolve({ status: code, stderr }));
    });

  await runOnce();
  assert(notifyCount() === 0, "D2 首拍失败不叫（双拍确认防抖动）");
  assert(reportText().includes("连续失败 1 拍"), "D2 首拍报告记失败");
  await runOnce();
  assert(notifyCount() === 1, "D3 第二拍确认 → 独立通道告警恰一次");
  assert(reportText().includes("ALERT [relay]"), "D3 报告记 ALERT [relay]");
  await runOnce();
  assert(notifyCount() === 1, "D4 episode 去重：持续失败期不重叫");

  // D5 relay 复活 → RECOVERED 行（桩 server 真监听）
  const srv = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const envUp = { ...baseEnv, PATROL_RELAY_URL: `http://127.0.0.1:${port}/` };
  await runOnce(envUp);
  assert(reportText().includes("RECOVERED [relay]"), "D5 relay 复活 → RECOVERED 行");

  // D6 hook 腿独立判定：relay 在线 + 持续失败账 → 告警
  const now = Date.now();
  writeFileSync(join(T, "data", "hook-post-fail.json"), JSON.stringify({ v: 1, streak: 4, firstFailAt: now - 20 * 60_000, lastFailAt: now - 30_000, lastOkAt: now - 25 * 60_000, lastErr: "fetch failed", lastWriteAt: now }));
  await runOnce(envUp);
  assert(reportText().includes("ALERT [hook-post-fail]"), "D6 relay 在线但 hook 持续失败 → 独立告警");
  await new Promise<void>((r) => srv.close(() => r()));

  rmSync(T, { recursive: true, force: true });
}

await sectionB();
await sectionC();
await sectionD();
console.log(failures === 0 ? "\n=== test-hookfail ALL PASS ===" : `\n=== test-hookfail FAILURES: ${failures} ===`);
process.exit(failures === 0 ? 0 : 1);
