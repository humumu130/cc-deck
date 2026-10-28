// #296 relay 单通道收敛——纯函数断言（semver 序/让位三态/版本链）+ 结构闸。
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-relay-single-conn.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  parseSemver, preKey, isRelayNewer, decideYield,
  resolveRelayVersion, resetRelayVersionCacheForTest,
  type OccupantProbe,
} from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wss = readFileSync(join(root, "relay", "src", "ws-server.ts"), "utf-8");
const mainrs = readFileSync(join(root, "desktop-tauri", "src-tauri", "src", "main.rs"), "utf-8");
const sdjs = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("#296 relay 单通道收敛——纯函数断言+结构闸");

// ---------- V semver 序（与 expo updates.ts 语义锚一致） ----------
{
  const cases: Array<[string, string, boolean, string]> = [
    ["0.7.0-test.73", "0.7.0-test.72", true, "通道尾号大者新（73>72）"],
    ["0.7.0-test.9", "0.7.0-test.10", false, "尾号数值比（9<10 非字典序）"],
    ["0.7.0", "0.7.0-test.73", true, "core 相等正式>预发布"],
    ["0.7.1", "0.7.0-test.99", true, "core 三段优先"],
    ["0.7.0-test.27-nova", "0.7.0-test.27", false, "壳通道烙印透明（≡ 同版）"],
    ["v0.7.0", "0.7.0", false, "v 前缀剥离"],
    ["0.7.0-test.73", "0.7.0-test.73", false, "全等=false"],
  ];
  for (const [a, b, want, name] of cases) ok(isRelayNewer(a, b) === want, "V " + name);
  const p = parseSemver("0.7.0-test.27-nova");
  ok(p.core.join(".") === "0.7.0" && preKey(p.pre) === "test.27", "V parseSemver+preKey（nova 后缀剥离）");
}

// ---------- Y 让位决策三态（PM 复验三态沙盒的纯函数面） ----------
{
  const y1 = decideYield("0.7.0-test.73", { kind: "version", version: "0.7.0-test.74" });
  ok(y1.action === "yield" && y1.reason.includes("v0.7.0-test.74"), "Y1 新占口→让位（占用者≥己）");
  const y2 = decideYield("0.7.0-test.74", { kind: "version", version: "0.7.0-test.73" });
  ok(y2.action === "contend" && y2.reason.includes("旧版"), "Y2 旧占口→竞争（warn 指引接管）");
  const y3 = decideYield("0.7.0-test.74", { kind: "version", version: "0.7.0-test.74" });
  ok(y3.action === "yield", "Y3 同版占口→让位（先到先得不互抢）");
  const y4 = decideYield("0.7.0-test.74", { kind: "no-interface" });
  ok(y4.action === "contend" && y4.reason.includes("无版本接口"), "Y4 无版本占口（老 relay）→竞争+接管指引");
  const y5 = decideYield("0.7.0-test.74", { kind: "unreachable" });
  ok(y5.action === "contend" && y5.reason.includes("未知进程"), "Y5 探测不通→竞争+排查指引");
}

// ---------- C 版本链（env>文件>兜底） ----------
{
  const dataDir = mkdtempSync(join(tmpdir(), "296ver-"));
  process.env.CCR_RELAY_VERSION = "9.9.9-env";
  resetRelayVersionCacheForTest();
  ok(resolveRelayVersion() === "9.9.9-env", "C1 env 最高位生效");
  delete process.env.CCR_RELAY_VERSION;
  resetRelayVersionCacheForTest();
  const got = resolveRelayVersion();
  ok(/^\d+\.\d+\.\d+/.test(got) || got === "0.0.0-dev", "C2 无 env 落文件链或兜底（实得 " + got + "）");
  void dataDir;
}

// ---------- S 结构闸（防回退） ----------
const s1 = wss.includes('"/api/version"') && wss.includes("resolveRelayVersion()");
const s2 = wss.includes("relay_version: resolveRelayVersion()") && wss.includes("decideYield");
const s3 = wss.includes("客户端模式继续") && wss.includes("CCR_PARENT_PID");
const s4 = mainrs.includes("relay_takeover") && mainrs.includes("relay.mjs") && mainrs.includes("零误杀拒杀");
const s5 = mainrs.includes("CCR_RELAY_VERSION") && mainrs.includes("probe_port_relay_version");
const s6 = sdjs.includes("healTick") && !sdjs.includes("healTries > 15");
const s7 = sdjs.includes("relay-takeover-available") && sdjs.includes("doRelayTakeover");
const s8 = sdjs.includes("lastProbeFail") && mainrs.includes("probe_local: ");
ok(s1, "S1 /api/version 端点+版本自报在挂");
ok(s2, "S2 SNAPSHOT relay_version+让位决策在挂");
ok(s3, "S3 让位协议双形态（客户端模式/内嵌静默退）在挂");
ok(s4, "S4 壳一键接管+特征零误杀闸在挂");
ok(s5, "S5 壳版本探测+env 注入在挂");
ok(s6, "S6 自愈去 15 次上限（永久退避）");
ok(s7, "S7 前端接管弹条+事件监听");
ok(s8, "S8 probe 失败原因透出（前端 lastProbeFail+壳日志）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
