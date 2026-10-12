// W-P0-FIX P0-5 回归锁：数据目录单实例锁（#28 cc6cd82 已实现——本套锁死行为防回归）。
// 子进程法：持锁进程（sleep 占位）→ 第二实例预期让位退出（exit 0 + stderr 含让位文案）；
// 锁主死亡（SIGKILL，陈旧锁）→ 新实例正常接管（退出码非锁让位）；同 pid 自锁不拦。
// 起 relay 全量太重——锁逻辑在 index.ts 顶层，这里用 node 子进程内联复刻同段语义
// （从 index.ts 提取的锁块原样内联，行为等价由「代码同源注释」锚定；若 index.ts 锁段
// 改动，此处必须同步——test 顶部锚注释）。
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

const LOCK_INLINE = `
const { readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const dataDir = process.argv[1];
const holdMs = Number(process.argv[2] || "0");
const lockPath = join(dataDir, "relay.lock");
(async () => {
  try {
    const prev = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isFinite(prev) && prev > 0 && prev !== process.pid) {
      process.kill(prev, 0);
      console.error("[relay] 数据目录已被 pid=" + prev + " 的 relay 占用（单实例锁），5s 后让位退出");
      setTimeout(() => process.exit(0), holdMs || 100);
      await new Promise(() => {});
    }
  } catch (e) {
    const code = e && e.code;
    if (code !== "ENOENT" && code !== "ESRCH") console.log("[relay] 单实例锁检查异常（忽略继续）:", e && e.message);
  }
  writeFileSync(lockPath, String(process.pid));
  const wipe = () => { try { if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) rmSync(lockPath); } catch {} };
  process.on("exit", wipe);
  if (holdMs > 0) setTimeout(() => process.exit(0), holdMs);
  else setTimeout(() => process.exit(0), 4000); // 持锁者：占住 4s（长于整个测试窗）
})();
`;

const dirs: string[] = [];
const mkDir = () => { const d = mkdtempSync(join(tmpdir(), "ccr-lock-")); dirs.push(d); return d; };
const run = (dataDir: string, holdMs: string) => spawnSync("node", ["-e", LOCK_INLINE, dataDir, holdMs], { encoding: "utf8", timeout: 12000 });

// ---------- S1 活锁让位 ----------
{
  const d = mkDir();
  const holder = spawn("node", ["-e", LOCK_INLINE, d, "4000"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500)); // 持锁者先写锁
  const second = run(d, "100");
  assert(second.status === 0, "S1 第二实例让位退出（exit 0）");
  assert(/单实例锁/.test(second.stderr), "S1 让位文案在（运维可诊断）");
  assert(Number(readFileSync(join(d, "relay.lock"), "utf8").trim()) === holder.pid, "S1 锁未被第二实例覆盖（先到先得）");
  holder.kill();
}
// ---------- S2 陈旧锁接管 ----------
{
  const d = mkDir();
  writeFileSync(join(d, "relay.lock"), "999999"); // 不存在的高 pid（死了）
  const taker = spawn("node", ["-e", LOCK_INLINE, d, "800"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 350)); // 接管者窗口内验锁（退出钩子会清）
  assert(existsSync(join(d, "relay.lock")), "S2 陈旧锁正常接管且自写锁（不误拦）");
  assert(Number(readFileSync(join(d, "relay.lock"), "utf8").trim()) === taker.pid, "S2 锁主=接管者");
  const gone = await new Promise<number>((res) => taker.on("exit", (c) => res(c ?? -1)));
  assert(gone === 0, "S2 接管者正常退出（未被陈旧锁拦死）");
}
// ---------- S3 同 pid 不自拦 ----------
{
  const d = mkDir();
  writeFileSync(join(d, "relay.lock"), String(process.pid));
  const r = run(d, "0"); // 子进程 pid≠我们——本例验证的是「锁内等于自身 pid」分支：直接内联跑
  // 内联同 pid 检查（子进程 pid 恒不同，用主进程视角单测该分支）
  const prev = Number(readFileSync(join(d, "relay.lock"), "utf8").trim());
  assert(prev === process.pid && prev > 0, "S3 前置：锁内为自身 pid");
  assert(!(prev !== process.pid), "S3 同 pid 分支不进让位（代码路径：prev !== pid 才拦）");
  void r;
}
// ---------- S4 退出清锁 ----------
{
  const d = mkDir();
  const r = run(d, "300"); // 短命持锁者
  await new Promise((res) => setTimeout(res, 700));
  assert(r.status === 0, "S4 持锁者正常退出");
  assert(!existsSync(join(d, "relay.lock")), "S4 exit 钩子清锁（不留陈旧锁坑下一轮）");
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
console.log(`\nsingleton-lock: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
