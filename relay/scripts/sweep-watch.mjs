#!/usr/bin/env node
// watch 层本地闸 runner（DEV-53，2026-11-28）：顺序全量跑 relay/tests/ci.json 的 watch 键，
// 任一红（非零退出/超时）exit 1——「CI 红=必有人管」在矩阵外的运行腿。
//
// 用法（relay 目录）：
//   npm run sweep:watch                    # 全量（逐键超时默认 900s，对齐长跑键 1200s 预算惯例留余量）
//   npm run sweep:watch -- --filter board  # 只跑键名含 board 的子集（调试用）
//   npm run sweep:watch -- --timeout 300   # 调逐键超时（秒）
//
// 顺序执行（不并行）：watch 键含 lan 组播/tmux 会话/真 CLI 回合等本机资源面，并行互扰
// 会让红绿不可信（DEV-48 巡检口径：网络类偶发红先排同机互扰再定罪）。
// 输出：逐键 PASS/FAIL（FAIL 附尾部日志 40 行）＋汇总表；Ctrl-C 语义＝当前键中断、汇总仍打印
//（SIGINT handler 真实现——DEV-42 P3 补：原头注释超诺，默认行为是整跑被杀无汇总）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_JSON = path.join(RELAY_DIR, "tests", "ci.json");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const FILTER = flag("--filter", null);
const TIMEOUT_SEC = Number(flag("--timeout", 900));
const TAIL_LINES = 40;

const ci = JSON.parse(fs.readFileSync(CI_JSON, "utf8"));
const watchKeys = Object.keys(ci.watch || {});
if (watchKeys.length === 0) {
  console.error("ERR: ci.json watch 层为空——无可扫键（若 watch 已清空请同步退役本 runner 调用面）");
  process.exit(1);
}
const keys = FILTER ? watchKeys.filter((k) => k.includes(FILTER)) : watchKeys;
if (keys.length === 0) {
  console.error(`ERR: --filter "${FILTER}" 未命中任何 watch 键`);
  process.exit(1);
}
console.log(`watch sweep：${keys.length}/${watchKeys.length} 键，逐键超时 ${TIMEOUT_SEC}s，顺序执行\n`);

function runKey(key) {
  return new Promise((resolve) => {
    // detached+进程组击杀：超时杀 npm 外壳会留 tsx 孙进程成孤儿（继续占端口/改沙盒，
    // 顺序执行的下一键被互扰）——负 pid 一锅端整组。
    const child = spawn("npm", ["run", "--silent", key], { cwd: RELAY_DIR, env: process.env, detached: true });
    let out = "";
    const t0 = Date.now();
    let timedOut = false;
    let interrupted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* 组已退出 */ }
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, TIMEOUT_SEC * 1000);
    // Ctrl-C（SIGINT）：击杀当前键进程组并按「中断」结算（汇总仍打印——与头注释承诺一致）。
    // 第二次 Ctrl-C = 真退出（不再拦截，兜底死循环场景）。
    const onInt = () => {
      if (interrupted) { process.removeListener("SIGINT", onInt); return; }
      interrupted = true;
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* 组已退出 */ }
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    };
    if (!process.listenerCount("SIGINT")) process.on("SIGINT", onInt);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); process.removeListener("SIGINT", onInt); resolve({ key, code: -1, ms: Date.now() - t0, out: String(e), timedOut: false, interrupted }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInt);
      resolve({ key, code: code ?? -1, ms: Date.now() - t0, out, timedOut, interrupted });
    });
  });
}

const results = [];
let interrupted = false;
for (const key of keys) {
  if (interrupted) { console.log(`▷ ${key} ... 跳过（Ctrl-C 中断）`); continue; } // 中断后不再起键，汇总仍打印
  process.stdout.write(`▶ ${key} ... `);
  const r = await runKey(key);
  results.push(r);
  if (r.interrupted) interrupted = true;
  const secs = (r.ms / 1000).toFixed(1);
  if (r.code === 0) console.log(`PASS (${secs}s)`);
  else {
    const why = r.interrupted ? "Ctrl-C 中断" : r.timedOut ? `TIMEOUT >${TIMEOUT_SEC}s` : `exit=${r.code}`;
    console.log(`FAIL (${why}, ${secs}s)`);
    const tail = r.out.trimEnd().split("\n").slice(-TAIL_LINES);
    if (tail.length) console.log(tail.map((l) => `    ${l}`).join("\n"));
  }
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n==== watch sweep 汇总：${results.length - failed.length}/${results.length} PASS，${failed.length} FAIL${interrupted ? "（Ctrl-C 中断——未跑键已跳过）" : ""} ====
`);
if (failed.length || interrupted) {
  for (const f of failed) console.log(`  FAIL ${f.key} (${f.interrupted ? "interrupted" : f.timedOut ? "timeout" : "exit=" + f.code})`);
  process.exit(1);
}
