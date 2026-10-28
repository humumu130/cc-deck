// #296 三态让位沙盒：假占口者（可控版本/无版本）+ 真子 relay（tsx src/index.ts，独立口+tmp dataDir）。
// 用法：node scripts/sandbox-296-yield.mjs <A|B|C>  （A=无版本占口 B=新占口 C=旧占口）
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "A";
const PORT = 18997;
const fake = createServer((req, res) => {
  if (mode !== "A" && req.url === "/api/version") {
    const v = mode === "B" ? "9.9.9" : "0.1.0";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, relay: v }));
    return;
  }
  res.writeHead(404).end(); // A 态：无版本接口（老 relay 形状）
});
await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
console.log(`[sandbox] mode=${mode} 假占口者监听 :${PORT}`);

const dataDir = mkdtempSync(join(tmpdir(), "296sandbox-"));
const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: process.cwd(),
  env: {
    // 剥离宿主生产形态变量（解构剥离，不动宿主 env）：worker 会话自带 CCR_PARENT_PID
    //（经验条「worker 会话自带生产 env」实锤）——不剥则子 relay 误判「内嵌形态」，
    // yield 走静默 exit(0) 分支，客户端模式分支永不被测到。沙盒模拟插件/独立形态。
    ...(({ CCR_PARENT_PID: _strip, ...clean }) => clean)(process.env),
    CCR_PORT: String(PORT),
    CCR_DATA_DIR: dataDir,
    CCR_NO_MDNS: "1",
    CCR_ORG_DIR: join(dataDir, "org"),
    CCR_RELAY_VERSION: "0.7.0-test.73",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write("[relay] " + d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write("[relay!] " + d); });

const t0 = Date.now();
const waitExit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
let verdict = "TIMEOUT";
while (Date.now() - t0 < 25_000) {
  await new Promise((r) => setTimeout(r, 500));
  if (out.includes("让位：端口已被 v9.9.9")) { verdict = mode === "B" ? "PASS-B-yield-客户端模式" : "UNEXPECTED"; break; }
  if (out.includes("旧版 relay（无版本接口）")) { verdict = mode === "A" ? "PASS-A-contend-warn" : "UNEXPECTED"; break; }
  if (out.includes("端口被旧版 v0.1.0 占用")) { verdict = mode === "C" ? "PASS-C-contend-warn" : "UNEXPECTED"; break; }
}
// 退出性证明：verdict 命中后再等 3s——yield(B)预期仍活（客户端模式不退进程），
// contend(A/C)预期 5s 内退（防热旋延迟退）。exited=3s 内观测到退出。
// 观测窗：B(yield)=3s 内不退=客户端模式在；A/C(contend)=5s 延迟退后 7s 内应退
const watchMs = verdict.includes("PASS-B") ? 3000 : 7000;
const exited = await Promise.race([waitExit.then(() => true), new Promise((r) => setTimeout(() => r(false), watchMs))]);
const exitOk = verdict.includes("PASS-B") ? !exited : exited;
console.log(`\n[sandbox] verdict=${verdict} relayExited=${exited}（B 预期 false=客户端模式不退）exitOk=${exitOk}`);
try { child.kill("SIGKILL"); } catch {}
try { fake.close(); } catch {}
try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
console.log(`[sandbox] RESULT:${verdict.startsWith("PASS") && exitOk ? "PASS" : "FAIL"}`);
process.exit(verdict.startsWith("PASS") ? 0 : 1);
