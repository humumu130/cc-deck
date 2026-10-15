// W-UPDFIX（#130 更新弹窗降级提示）版本比较器矩阵测试：parseSemver 通道后缀修复 +
// isNewer 通道后缀透明化。提取法：从 src/updates.ts 源码提取 parseSemver/preKey/
// isNewer/channelOf 四纯函数 new Function 求值——零 RN 模块链（updates.ts 顶部
// import AppState/AsyncStorage 等 RN 面，worktree 无 expo node_modules 时
// registerHooks 桩链在 tsx CJS 转译路径上拦不住 require，故走源码字面锚同族路线）。
//
// 实锤复现组：0.7.0-test.27-nova 装机被推 0.7.0-test.25（旧正则 [\w.]+ 不含 "-"，
// 本地整串落 core [0,0,0]，远端任意 0.7.x 判大）。
// 运行：expo-app 目录 node --import tsx scripts/test-updates-cmp.ts
//   （tsx 可解析不到时：node --import <relay>/node_modules/tsx/dist/loader.mjs …）

// @ts-expect-error node:fs 未进 expo tsconfig types 字段
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const assert = (c: unknown, name: string, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " | " + detail : ""}`); }
};
const section = (n: string) => console.log(n);

// ---------- 源码提取（签名行以 { 结尾锚定 + 括号平衡收口；返回类型含 {} 的函数
// 不能用「第一个 {」起数——parseSemver 的 : { core...; pre... } 会让平衡提前归零） ----------
const src = readFileSync(new URL("../src/updates.ts", import.meta.url), "utf8");
function grabFn(name: string): string {
  const i = src.search(new RegExp(`(function ${name}\\()`));
  if (i < 0) throw new Error(`源码锚缺失: function ${name}`);
  const lineEnd = src.indexOf("\n", i);
  const head = src.slice(i, lineEnd).trimEnd();
  if (!head.endsWith("{")) throw new Error(`签名行不以 { 结尾（形态漂移？）: ${head}`);
  let depth = 0;
  for (let k = i + head.lastIndexOf("{"); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`括号失衡: ${name}`);
}
const fnSrc = ["parseSemver", "preKey", "isNewer", "channelOf"].map(grabFn).join("\n");
// 提取的 TS 源带类型标注——写临时 .ts 由运行时 strip（本件自身即经同链路加载），再动态 import
// @ts-expect-error node:fs 同上
import { writeFileSync, mkdtempSync } from "node:fs";
// @ts-expect-error node:os 同上
import { tmpdir } from "node:os";
const tmpdirPath = mkdtempSync(`${tmpdir()}/ccr-updcmp-`);
const tmpUrl = new URL(`extracted-${process.pid}.ts`, `file://${tmpdirPath}/`);
writeFileSync(tmpUrl, `${fnSrc}\nexport { parseSemver, preKey, isNewer, channelOf };\n`);
const { parseSemver, preKey, isNewer, channelOf } = await import(tmpUrl.href);

// ========== M0 提取健康度（防源码锚漂移假绿） ==========
section("M0 源码锚健康度");
assert(parseSemver("0.7.0-test.27-nova").core.join(".") === "0.7.0" && parseSemver("0.7.0-test.27-nova").pre === "test.27-nova",
  "M0a parseSemver 解析 -nova 后缀（core 三段+pre 含连字符串）",
  JSON.stringify(parseSemver("0.7.0-test.27-nova")));
assert(preKey("test.27-nova") === "test.27" && preKey(null) === null,
  "M0b preKey 通道后缀透明（test.27-nova → test.27）");

// ========== M1 实锤复现组（真机症状根修验证） ==========
section("M1 实锤复现组（test.27-nova 装机 vs test 清单）");
assert(isNewer("0.7.0-test.25", "0.7.0-test.27-nova") === false,
  "M1a 实锤对：远端 test.25 < 本地 test.27-nova → 不更新（降级提示根除）");
assert(isNewer("0.7.0-test.26", "0.7.0-test.27-nova") === false,
  "M1b 任意旧 test 段：test.26 < test.27-nova → 不更新");
assert(isNewer("0.7.0-test.28", "0.7.0-test.27-nova") === true,
  "M1c 真新版仍推：test.28 > test.27-nova → 更新（数字段比较，后缀不参与数值）");
assert(isNewer("0.7.1", "0.7.0-test.27-nova") === true,
  "M1d 正式版跨段：0.7.1 > 0.7.0-test.27-nova → 更新");
assert(isNewer("0.7.0", "0.7.0-test.27-nova") === true,
  "M1e 同号正式 > 预发布（semver 规则维持——nova 后缀不豁免）");

// ========== M2 通道后缀透明组（同版本不同通道不互推） ==========
section("M2 通道后缀透明组");
assert(isNewer("0.7.0-test.27", "0.7.0-test.27-nova") === false,
  "M2a 同版本 test.27 不推 test.27-nova 装机（通道不互推·正向）");
assert(isNewer("0.7.0-test.27-nova", "0.7.0-test.27") === false,
  "M2b 同版本 test.27-nova 不推 test.27 装机（通道不互推·反向）");
assert(isNewer("0.7.0-test.27-nova", "0.7.0-test.27-nova") === false,
  "M2c 全等（含后缀）→ 不更新");
assert(isNewer("0.7.0-test.28-nova", "0.7.0-test.27") === true,
  "M2d 数字段领先时后缀不挡更新（test.28-nova > test.27）");

// ========== M3 channelOf 通道判定组（同族隐患回归锁） ==========
section("M3 channelOf（-nova 后缀不破坏通道判定）");
assert(channelOf("0.7.0-test.27-nova") === "test", "M3a test.N-nova → test");
assert(channelOf("0.7.0-test.27") === "test", "M3b test.N → test（既有）");
assert(channelOf("0.7.0-snap.3-nova") === "snap", "M3c snap.N-nova → snap");
assert(channelOf("0.7.0-dev.90-nova") === "dev", "M3d dev.N-nova → dev（通道判定不因后缀漂移）");
assert(channelOf("0.7.0") === "release", "M3e 正式版 → release（既有）");
assert(channelOf("v0.7.0") === "release", "M3f v 前缀容忍（既有）");

// ========== M4 既有语义回归组（修复不动旧口径） ==========
section("M4 既有语义回归组");
assert(isNewer("0.5.1", "0.5.1-test.17") === true, "M4a 正式 > 预发布（0.5.1 > 0.5.1-test.17）");
assert(isNewer("0.5.1-test.18", "0.5.1-test.9") === true, "M4b 预发布数字段（test.18 > test.9）");
assert(isNewer("0.5.1-test.9", "0.5.1-test.18") === false, "M4c 反向不更新");
assert(isNewer("0.5.2", "0.5.1") === true && isNewer("0.5.1", "0.5.2") === false, "M4d core 三段数值序");
assert(isNewer("0.5.1", "0.5.1") === false, "M4e 全等不更新");
assert(isNewer("v0.5.2", "0.5.1") === true, "M4f v 前缀剥离（既有）");
assert(isNewer("1.0.0-test.2", "0.9.9-test.999") === true, "M4g core 优先于预发布段（1.0.0-test.2 > 0.9.9）");

console.log(`\n===== ${pass}/${pass + fail} PASS =====`);
process.exit(fail ? 1 : 0);
