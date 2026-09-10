// 三码契约测试（#22 后立）：网页端出的码形态 × App 端 parseScanPayload 真源解析。
// 无相机也能端到端验证扫码链路的协议契约——8 位配对码被拒这类回归以后在这里拦。
// 用法：node relay/scripts/test-scan-contract.mjs（无依赖；直接从 ScanScreen.tsx 抠出
// parseScanPayload 源码执行，杜绝测试副本漂移）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tsx = readFileSync(join(root, "expo-app/src/screens/ScanScreen.tsx"), "utf8");

// 抠出 export function parseScanPayload 的完整函数体（到平衡大括号）
const start = tsx.indexOf("export function parseScanPayload");
if (start < 0) throw new Error("parseScanPayload 不在 ScanScreen.tsx（结构变了？）");
const bodyStart = tsx.indexOf("{", tsx.indexOf(")", start));
let depth = 0, end = -1;
for (let i = bodyStart; i < tsx.length; i++) {
  if (tsx[i] === "{") depth++;
  else if (tsx[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
}
const fnSrc = tsx.slice(tsx.indexOf("function", start), end + 1);
// 源是 TS（类型注解）——esbuild 转译成纯 JS 再求值，保持"真源"不抄副本
const js = transformSync(fnSrc, { loader: "ts" }).code;
// eslint-disable-next-line no-eval
const parseScanPayload = new Function(js + "; return parseScanPayload;")();

let pass = 0, fail = 0;
function t(name, payload, check) {
  const r = parseScanPayload(typeof payload === "string" ? payload : JSON.stringify(payload));
  let ok = false, detail = "";
  try { ok = check(r); } catch (e) { detail = "检查异常 " + e.message; }
  if (ok) { pass++; console.log("ok - " + name); }
  else { fail++; console.log(`FAIL: ${name} → ${JSON.stringify(r).slice(0, 160)} ${detail}`); }
}

// ── ① v1 LAN 直连码（relay 页「扫码接入」本机出码 / LAN 分享） ──
t("① v1 LAN 直连", { v: 1, url: "ws://192.168.0.101:8787/ws", token: "abc123" },
  (r) => r && r.wsUrl === "ws://192.168.0.101:8787/ws" && r.token === "abc123");

// ── ② ccdeck-add 云接入码（分享到手机 / 扫码接入云源） ──
// #22 回归锚点：配对码硬化后 relay 领的是 8 位——旧解析 ^\d{6}$ 会整码拒收
t("② ccdeck-add 8 位码（#22 回归锚）", {
  t: "ccdeck-add", v: 1, bridge: "wss://cc.humumu.online/cloud",
  bt: "bridge-token-xx", rd: "rl-3a9a68c9104f5b44", rk: "rk-value", code: "81510288",
}, (r) => r && r.invite && r.invite.code === "81510288" && r.invite.rd.startsWith("rl-"));
t("② ccdeck-add 6 位码（旧 relay 兼容）", {
  t: "ccdeck-add", v: 1, bridge: "wss://8.133.211.170:8790/cloud",
  bt: "bt", rd: "rl-1234567890abcdef", rk: "rk", code: "123456",
}, (r) => r && r.invite && r.invite.code === "123456");

// ── ③ ccdeck-login 合并码（扫码从手机导入：授权入网 / 回传连接） ──
t("③ ccdeck-login imp:1（0.4.4+ 合并码）", {
  t: "ccdeck-login", v: 1, imp: 1, bridge: "wss://cc.humumu.online/cloud",
  rd: "rl-3a9a68c9104f5b44", dev: "wb-e0da2aecf177768f", pk: "PK".padEnd(64, "x"),
  name: encodeURIComponent("公司电脑"),
}, (r) => r && r.login && r.login.imp === true && r.login.dev === "wb-e0da2aecf177768f");
t("③ ccdeck-login 无 imp（纯授权，旧形态兼容）", {
  t: "ccdeck-login", v: 1, bridge: "wss://cc.humumu.online/cloud",
  dev: "wb-e0da2aecf177768f", pk: "PK".padEnd(64, "x"), name: "web",
}, (r) => r && r.login && !r.login.imp);
t("③ ccdeck-login imp:true（布尔形态容错）", {
  t: "ccdeck-login", v: 1, imp: true, bridge: "wss://cc.humumu.online/cloud",
  dev: "wb-e0da2aecf177768f", pk: "PK".padEnd(64, "x"),
}, (r) => r && r.login && r.login.imp === true);

// ── ④ ccdeck-import LAN rt（旧「扫码从手机导入」直连语境） ──
t("④ ccdeck-import rt", { t: "ccdeck-import", v: 1, rt: { url: "ws://192.168.0.101:8787/ws", token: "tk" } },
  (r) => r && r.import && r.import.url === "ws://192.168.0.101:8787/ws");

// ── ⑤ 裸地址码（?token= 形态） ──
t("⑤ 裸 ws 地址+token", "ws://192.168.0.101:8787/ws?token=abc123",
  (r) => r && r.wsUrl === "ws://192.168.0.101:8787/ws" && r.token === "abc123");

// ── ⑥ 垃圾输入拒收 ──
t("⑥ 非 CC Deck 码拒收", "https://example.com/some/page", (r) => r === null);
t("⑥ ccdeck-add 坏 code 拒收", {
  t: "ccdeck-add", v: 1, bridge: "wss://x/cloud", bt: "b", rd: "rl-aaaa", rk: "r", code: "12345",
}, (r) => r === null);

console.log(fail ? `\nSCAN CONTRACT TESTS FAILED (${fail})` : "\nSCAN CONTRACT TESTS PASSED");
process.exit(fail ? 1 : 0);
