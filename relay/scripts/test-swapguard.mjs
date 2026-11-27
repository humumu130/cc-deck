// DEV-18 审查 P2 移交（2026-11-27 批 A）：swap-nova.sh 发射 payload 前 rm -f "$VERDICT"
// ——防陈旧 verdict 假绿/假红收割。行为级沙盒验证：预置陈旧 verdict=3（上一轮被杀
// 遗留），跑 --no-open 换装（payload 即写 0 退出）——有守卫则本轮 exit 0 且 verdict
// 消费干净；无守卫则等待循环首拍读陈旧 3 → exit 3（假红形态；陈旧 0 同理假绿）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SANDBOX = join(REPO, "relay", "data", "test-swapguard");
rmSync(SANDBOX, { recursive: true, force: true });
const dataDir = join(SANDBOX, "data");
const appSrc = join(SANDBOX, "src", "FakeApp.app");
const appDst = join(SANDBOX, "Applications", "FakeApp.app");
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(appSrc, "Contents"), { recursive: true });
writeFileSync(join(appSrc, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>');
writeFileSync(join(dataDir, "bridge.json"), JSON.stringify({ port: 58999 }));

let pass = 0, fail = 0;
const assert = (c, name) => { if (c) { pass++; console.log("  ok - " + name); } else { fail++; console.log("FAIL: " + name); } };

// 预置陈旧 verdict=3（上一轮「health 未转绿后被杀」的遗留——守卫缺席时必误读）
writeFileSync(join(dataDir, "swap-nova.verdict"), "3");

let code = -1;
let out = "";
try {
  out = execFileSync("bash", [join(REPO, "scripts", "swap-nova.sh"), appSrc, "--no-open"], {
    env: { ...process.env, CCR_APP_PATH: appDst, CCR_DATA_DIR: dataDir, CCR_APP_PROC: "no-such-proc-xyz", CCR_PORT: "58999" },
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  code = 0;
} catch (e) {
  code = e.status ?? -1;
  out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}

const verdictPath = join(dataDir, "swap-nova.verdict");
const logPath = join(dataDir, "swap-nova.log");
const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";

assert(code === 0, `换装+--no-open 全链 exit 0（实测 ${code}——陈旧 verdict=3 未污染本轮判定）`);
assert(!existsSync(verdictPath), "verdict 消费后清理（无残留传下轮）");
assert(log.includes("换装完成"), "本轮真跑（换装段日志在）");
assert(log.includes("不自动拉起"), "payload 本轮落 verdict（--no-open 分支）");

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n== test-swapguard 汇总：${pass} ok / ${fail} FAIL ==`);
if (fail > 0) process.exit(1);
