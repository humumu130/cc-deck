// M4 claim barrier 优雅更新窗断言（multica 卷一 T3 / synthesis M4，2026-10-29 批）——
// 真源码 import 直跑（test-272 范式）。靶子 scripts/graceful-restart.ts（主链注入式）
// + src/index.ts SIGTERM 诊断锚 + deploy 薄壳。
//
// 断言组：
//   A 活单判定纯函数：dispatched/running 算活；queued/done/failed/审计单行排除；收敛末行赢
//   B 主链注入式（mock deps 记录调用序列，零真 launchd）：
//      B1 预检失败原进程未动｜B2 无派单即刻换新｜B3 在跑等待→归零换新（kick 在归零后）
//      B4 超时不硬杀（零 kick 零 copy）+活单清单｜B5 新 bundle 起不来→自动回滚续服务
//      B6 回滚仍失败→告警退出（kick 恰 2 次不循环）
//   C CLI 级 smoke（PATH 劫持 mock launchctl，真 tsx 跑）：C1 在跑等待→终态后换新（时序）
//      ｜C2 超时退出码 3+零 launchctl｜C3 预检退出码 5｜C4 真端口不通→回滚后仍不通退出码 5
//      （bundle 已回滚+kick 恰 2 次）
//
// 直跑：env -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_READ_MODE npx tsx scripts/test-m-graceful.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as net from "node:net";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

const { activeDispatches, gracefulRestart } = await import("../scripts/graceful-restart.js");

console.log("M4-A 活派单判定（claim barrier 判据）：");
const rows = [
  { id: "d1", status: "dispatched", target: "w1", title: "单甲" },
  { id: "d2", status: "running", target: "w2", title: "单乙" },
  { id: "d3", status: "queued", target: "cap-queue" },
  { id: "d4", status: "done", target: "w3" },
  { id: "audit", status: "done", target: "org-command" },
];
const act = activeDispatches(rows);
ok(act.length === 2 && act.some((a) => a.id === "d1") && act.some((a) => a.id === "d2"), "A1 dispatched/running 算活（恰 2）");
ok(!act.some((a) => a.id === "d3"), "A2 queued 排除（重启 reloadDispatchQueue 安全恢复）");
ok(!act.some((a) => a.id === "d4") && !act.some((a) => a.id === "audit"), "A3 终态/审计行排除");
const converged = activeDispatches([
  { id: "d1", status: "dispatched" },
  { id: "d1", status: "done" },
]);
ok(converged.length === 0, "A4 同 id 收敛末行赢（dispatched→done 后不算活）");

console.log("M4-B 主链注入式（mock deps 序列断言）：");
// 通用 mock：记录副作用序列；readRows/probe 行为按用例注入
function mockDeps(over: Partial<{ rows: () => { id: string; status: string }[]; probeUpAfterCopies: number }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      readRows: over.rows ?? (() => []),
      exec: (cmd: string, args: string[]) => { calls.push(`${cmd} ${args.join(" ").slice(0, 40)}`); },
      copy: (from: string, to: string) => { calls.push(`copy ${from.includes("pre-graceful") ? "BACKUP" : "NEW"}→${to.slice(-18)}`); },
      // 探活语义=按 copy 计数（备份+拷新=2；回滚后=3）——时序无关：probeUpAfterCopies
      // 缺省 2（换新即可通）；3=回滚后才通；Infinity=恒不通。与 up() 的轮询节奏解耦。
      probe: async () => {
        const copies = calls.filter((c) => c.startsWith("copy")).length;
        const v = copies >= (over.probeUpAfterCopies ?? 2);
        calls.push(`probe:${v ? "up" : "down"}`);
        return v;
      },
      // 真微延迟：让 up() 的预算循环不空转（mock 即返会让首轮探活在 budget 内连发烧尽断言序）
      sleep: async () => { calls.push("sleep"); await new Promise((r) => setTimeout(r, 10)); },
      log: () => { /* 静音 */ },
    },
  };
}
const SB1 = mkdtempSync(join(tmpdir(), "m-graceful-"));
const newB = join(SB1, "new-relay.mjs"), tgtB = join(SB1, "target-relay.mjs");
writeFileSync(newB, "console.log('new');\n", "utf-8");
writeFileSync(tgtB, "console.log('old');\n", "utf-8");
const BASE = { newBundle: newB, targetBundle: tgtB, port: 18787, probeMs: 80, label: "test.label" };

// B1 预检失败（newBundle 不存在）——原进程未动
{
  const m = mockDeps();
  const r = await gracefulRestart({ ...BASE, newBundle: join(SB1, "no-such.mjs"), windowMs: 1000, deps: m.deps });
  ok(r.outcome === "preflight-failed" && m.calls.length === 0, "B1 新 bundle 缺失→preflight-failed 且零副作用（原进程未动）");
}

// B2 无派单即刻换新（零 sleep）
{
  const m = mockDeps();
  const r = await gracefulRestart({ ...BASE, windowMs: 60_000, deps: m.deps });
  ok(r.outcome === "restarted", "B2 无派单→restarted");
  ok(m.calls.some((c) => c.startsWith("node --check")) && m.calls.some((c) => c.startsWith("launchctl kickstart")) && m.calls.includes("probe:up"), "B2 序列含 check→备份→拷新→kick→探活通");
  ok(!m.calls.includes("sleep"), "B2 即刻换新（等待零拍）");
}

// B3 在跑等待→归零换新（kick 在归零之后）
{
  let n = 0;
  const m = mockDeps({ rows: () => (n++ < 2 ? [{ id: "d1", status: "running" }] : []) });
  const r = await gracefulRestart({ ...BASE, windowMs: 30_000, deps: m.deps });
  ok(r.outcome === "restarted" && r.waitedMs >= 0, "B3 活单→窗内归零→restarted");
  const firstSleep = m.calls.indexOf("sleep");
  const kick = m.calls.findIndex((c) => c.startsWith("launchctl"));
  ok(firstSleep >= 0 && kick > firstSleep, "B3 kickstart 发生在等待（归零）之后——不硬杀时序");
}

// B4 超时不硬杀（零 kick 零 copy）+ 活单清单
{
  const m = mockDeps({ rows: () => [{ id: "d9", status: "running", target: "w9", title: "长编译单" }] });
  const r = await gracefulRestart({ ...BASE, windowMs: 120, deps: m.deps });
  ok(r.outcome === "timeout-keep-running", "B4 窗满→timeout-keep-running（不硬杀）");
  ok(!m.calls.some((c) => c.startsWith("launchctl")) && !m.calls.some((c) => c.startsWith("copy")), "B4 超时路径零 kickstart 零 bundle 写动（进程与文件都未动）");
  ok(r.activeAtExit?.length === 1 && r.activeAtExit[0]?.id === "d9", "B4 退出清单带活单（人工决策面）");
}

// B5 新 bundle 起不来→自动回滚续服务
{
  const m = mockDeps({ probeUpAfterCopies: 3 }); // 换新后探活 down，回滚 copy（第 3 笔）后才 up
  const r = await gracefulRestart({ ...BASE, windowMs: 1000, deps: m.deps });
  const kicks = m.calls.filter((c) => c.startsWith("launchctl"));
  ok(r.outcome === "rolled-back" && kicks.length === 2, "B5 探活失败→回滚→二 kick→rolled-back");
  ok(m.calls.filter((c) => c.startsWith("copy")).length === 3, "B5 copy×3（备份+拷新+回滚）");
  const copyNames = m.calls.filter((c) => c.startsWith("copy"));
  ok(copyNames.length === 3 && copyNames[2]?.startsWith("copy BACKUP→"), "B5 回滚源=备份件（BACKUP→目标）");
}

// B6 回滚后仍不通→告警退出（kick 恰 2 次不循环）
{
  const m = mockDeps({ probeUpAfterCopies: Infinity }); // 恒不通：回滚后也不通
  const r = await gracefulRestart({ ...BASE, windowMs: 500, probeMs: 60, deps: m.deps });
  const kicks = m.calls.filter((c) => c.startsWith("launchctl"));
  ok(r.outcome === "rollback-failed" && kicks.length === 2, "B6 二轮仍不通→rollback-failed（kick 恰 2，无重试循环）");
}

console.log("M4-C CLI 级 smoke（PATH 劫持 mock launchctl，真 tsx）：");
// C1 探活依赖：测试进程内起真 listener 占 18787（CLI defaultDeps.probe 连它即通——
// 换新段「探活通过」路径的唯一真端口面；C4 用 PORT=1 制造恒不通）
const echo18387 = net.createServer((s) => s.destroy());
await new Promise<void>((r) => echo18387.listen(18787, "127.0.0.1", () => r()));
const SB2 = mkdtempSync(join(tmpdir(), "m-graceful-cli-"));
const orgD = join(SB2, "org"), binD = join(SB2, "bin");
mkdirSync(orgD, { recursive: true }); mkdirSync(binD, { recursive: true });
const logPath = join(SB2, "launchctl-calls.log");
// mock launchctl：追加时间戳记录
writeFileSync(join(binD, "launchctl"), `#!/bin/zsh\nnode -e "process.stdout.write(String(Date.now()))" >> ${logPath}\necho " $*" >> ${logPath}\nexit 0\n`, { mode: 0o755 });
chmodSync(join(binD, "launchctl"), 0o755);
const cliNew = join(SB2, "new.mjs"), cliTgt = join(SB2, "tgt.mjs");
writeFileSync(cliNew, "console.log('cli-new');\n", "utf-8");
writeFileSync(cliTgt, "console.log('cli-old');\n", "utf-8");
const ledger = join(orgD, "dispatch-log.ndjson");
const dl = (e: object) => writeFileSync(ledger, JSON.stringify(e) + "\n", { flag: "a" });
const runCli = (extraEnv: Record<string, string>) => spawnSync("npx", ["tsx", "scripts/graceful-restart.ts", cliNew], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: `${binD}:${process.env.PATH}`,
    CCR_ORG_DIR: orgD, CCR_DATA_DIR: join(SB2, "data"), CCR_STORAGE_READ_MODE: "json",
    APP_RELAY: cliTgt, CCR_PROBE_TIMEOUT: "1", CCR_GRACEFUL_WINDOW: "30", CCR_PORT: "18787",
    ...extraEnv,
  },
  encoding: "utf-8", timeout: 90_000,
});
const kickCount = () => (existsSync(logPath) ? readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean) : []);

// C1 真时序：后台发起 CLI，1.2s 后台账收口终态→归零换新；断言退出码 0+kick 恰一次+bundle 换新
{
  rmSync(logPath, { force: true });
  rmSync(ledger, { force: true });
  dl({ ts: Date.now(), id: "dp-c1", tier: "正经立项", target: "w-c1", status: "dispatched", session_id: "s1", title: "C1 在跑单" });
  const startedAt = Date.now();
  const child = spawnSync("sh", ["-c", `npx tsx scripts/graceful-restart.ts ${cliNew} & CPID=$!; sleep 1.2; printf '%s' '{"ts":1,"id":"dp-c1","tier":"正经立项","target":"w-c1","status":"done","session_id":"s1","receipt":"结果：完"}' >> "${ledger}"; wait $CPID; echo "EXIT:$?"`], {
    cwd: process.cwd(), env: {
      ...process.env, PATH: `${binD}:${process.env.PATH}`,
      CCR_ORG_DIR: orgD, CCR_DATA_DIR: join(SB2, "data"), CCR_STORAGE_READ_MODE: "json",
      APP_RELAY: cliTgt, CCR_PROBE_TIMEOUT: "1", CCR_GRACEFUL_WINDOW: "30", CCR_PORT: "18787",
    }, encoding: "utf-8", timeout: 90_000,
  });
  const out = (child.stdout ?? "") + (child.stderr ?? "");
  const kicks = kickCount();
  ok(/EXIT:0/.test(out), `C1 在跑→终态→换新 退出码 0（输出尾 ${out.slice(-40).trim()}）`);
  ok(kicks.length === 1, `C1 恰一次 kickstart（实得 ${kicks.length}——等终态才杀，非即刻硬杀）`);
  ok(kicks.length === 1 && Number(kicks[0]?.split(" ")[0]) - startedAt >= 1000, "C1 kick 发生在等待之后（时间戳距发起 ≥1s——真等待实证）");
  ok(readFileSync(cliTgt, "utf-8").includes("cli-new"), "C1 目标 bundle 已换新");
}

// C2 超时：台账恒活单+窗 1s → 退出码 3+零 launchctl
{
  rmSync(logPath, { force: true });
  rmSync(ledger, { force: true });
  dl({ ts: Date.now(), id: "dp-c2", tier: "正经立项", target: "w-c2", status: "running", session_id: "s2", title: "C2 长跑单" });
  const r = runCli({ CCR_GRACEFUL_WINDOW: "1" });
  ok(r.status === 3, `C2 窗满退出码 3（实得 ${r.status}）——不硬杀`);
  ok(kickCount().length === 0, "C2 零 launchctl 调用（进程未动）");
  ok((r.stdout ?? "").includes("dp-c2"), "C2 人工决策面打印活单 id");
}

// C3 预检失败：新 bundle 不存在 → 退出码 5+零 launchctl
{
  rmSync(logPath, { force: true });
  const r = spawnSync("npx", ["tsx", "scripts/graceful-restart.ts", join(SB2, "ghost.mjs")], {
    cwd: process.cwd(), env: {
      ...process.env, PATH: `${binD}:${process.env.PATH}`,
      CCR_ORG_DIR: orgD, CCR_DATA_DIR: join(SB2, "data"), CCR_STORAGE_READ_MODE: "json",
      APP_RELAY: cliTgt, CCR_PROBE_TIMEOUT: "1", CCR_GRACEFUL_WINDOW: "1", CCR_PORT: "18787",
    }, encoding: "utf-8", timeout: 60_000,
  });
  ok(r.status === 5, `C3 预检失败退出码 5（实得 ${r.status}）——原进程未动`);
  ok(kickCount().length === 0, "C3 零 launchctl");
}

// C4 真端口不通：换新→探活失败→回滚→仍不通 → 退出码 5，kick 恰 2 次，bundle 已回滚为旧
{
  rmSync(logPath, { force: true });
  rmSync(ledger, { force: true }); // 空台账：无派单即刻进换新段
  writeFileSync(cliTgt, "console.log('cli-old');\n", "utf-8"); // C1 已换 new——重建 C4 的「旧」基准
  const r = runCli({ CCR_PORT: "1" }); // 端口 1 无人监听→probe 恒 false
  ok(r.status === 5, `C4 回滚后仍不通退出码 5（实得 ${r.status}）`);
  ok(kickCount().length === 2, `C4 kick 恰 2 次（换新+回滚，实得 ${kickCount().length}）`);
  ok(readFileSync(cliTgt, "utf-8").includes("cli-old"), "C4 bundle 已自动回滚为旧内容（服务可续）");
}

// 源码锚：relay SIGTERM 诊断（graceful 屏障的 relay 侧对称面）
{
  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  ok(idx.includes("shutdownDiag") && idx.includes("reloadDispatchQueue 恢复排队"), "锚 relay SIGTERM 活单诊断在位");
  const rd = readFileSync(new URL("../../deploy/mac-relay-launchd/README.md", import.meta.url), "utf-8");
  ok(rd.includes("graceful-restart.sh") && rd.includes("不硬杀"), "锚 README 热部署口径已切优雅路径");
}

try { echo18387.close(); } catch { /* 尽力而为 */ }
try { rmSync(SB1, { recursive: true, force: true }); rmSync(SB2, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
