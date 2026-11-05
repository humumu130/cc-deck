// W-VERSIONLIFT 夹具（2026-11-05）：version.mjs 预发序号撞顶自动升段断言。
// 直跑：node scripts/test-versionlift.mjs（零依赖，node:fs/os/path/child_process）。
// 方法：mkdtemp 假仓 + 复制 scripts/version.mjs + 造九落点最小文件 → spawnSync 三模式
// （无参/--check/--write）断言；全程不触碰真仓 VERSION 与落点。
// 任务书验收点对照：
//   1. 0.7.0-test.100 → 0.7.1-test.1+VERSION 回写+落点一致+versionCode=70100-99=70001；
//      0.7.0-test.99 与原版（cf1fd078）输出逐字节一致。
//      ⚠ 任务书验收点另写「0.7.9-test.100 → 0.8.0-test.1（minor 进位）」与其改动要求
//      「patch+1（patch=99 时 minor+1）」矛盾（0.7.9 的 patch=9 未满槽，正文规则得
//      0.7.10-test.1，且仓库 patch 两位是事实先例：0.4.18）。按改动要求正文实现，
//      本夹具两组都测：0.7.9 → 0.7.10（正文规则）+ 0.7.99 → 0.8.0（真正的 minor 进位）。
//   2. --check 撞顶语义（升段后事实源不误红）+ 幂等 + 正式版/snap 零扰动。
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "version.mjs"), "utf8");
const repos = [];
const BASELINE = "0.6.3"; // 落点起始值（官网预发豁免停留位）

function mkRepo(version, scriptSrc = script) {
  const root = mkdtempSync(join(tmpdir(), "cc-deck-vlift-"));
  repos.push(root);
  const put = (rel, s) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), s); };
  put("scripts/version.mjs", scriptSrc);
  put("VERSION", `${version}\n`);
  put("web-console/index.html", `const CONSOLE_VERSION = "${BASELINE}"; // dev 尾注容忍\n`);
  put("web-console/index-005.html", `  const __ccDeck005Version = "${BASELINE}";\n`);
  put("expo-app/app.json", `{\n  "version": "${BASELINE}",\n  "android": { "versionCode": 60300 }\n}\n`);
  put("expo-app/android/app/build.gradle", `versionName "${BASELINE}"\nversionCode 60300\n`);
  put("desktop-tauri/package.json", `{\n  "version": "${BASELINE}"\n}\n`);
  put("cc-plugins/plugins/cc-deck/.claude-plugin/plugin.json", `{\n  "version": "${BASELINE}"\n}\n`);
  put(".claude-plugin/marketplace.json", `{\n  "name": "cc-deck",\n  "version": "${BASELINE}"\n}\n`);
  put("web-console/site/index.html", `<i class="pulse"></i>v${BASELINE} 当前版本 v${BASELINE} Windows · v${BASELINE} · Tauri\n`);
  return root;
}
const run = (root, mode = "") =>
  spawnSync("node", ["scripts/version.mjs", ...(mode ? [mode] : [])], { cwd: root, encoding: "utf8" });
const readAt = (root, rel) => readFileSync(join(root, rel), "utf8");

console.log("A. 主夹具：0.7.0-test.100 → 0.7.1-test.1（--write 全链）：");
{
  const r = mkRepo("0.7.0-test.100");
  const w = run(r, "--write");
  ok(w.status === 0, "--write rc=0");
  ok(w.stderr.includes("撞顶") && w.stderr.includes("自动升段 0.7.1-test.1"), "stderr 转换日志（PM 发版可见）");
  ok(w.stdout.includes("已全部同步为 0.7.1-test.1"), "尾行同步输出用升段后版本");
  ok(readAt(r, "VERSION") === "0.7.1-test.1\n", "VERSION 回写（带换行，事实源=输出）");
  ok(readAt(r, "expo-app/app.json").includes('"version": "0.7.1-test.1"'), "app.json expo.version=0.7.1-test.1");
  ok(readAt(r, "expo-app/app.json").includes('"versionCode": 70001'), "app.json versionCode=70100-99=70001");
  ok(readAt(r, "expo-app/android/app/build.gradle").includes('versionName "0.7.1-test.1"'), "build.gradle versionName 同步");
  ok(readAt(r, "expo-app/android/app/build.gradle").includes("versionCode 70001"), "build.gradle versionCode=70001（单调：>0.7.0-test.99 的 69999）");
  for (const rel of ["web-console/index.html", "web-console/index-005.html", "desktop-tauri/package.json", "cc-plugins/plugins/cc-deck/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json"])
    ok(readAt(r, rel).includes("0.7.1-test.1"), `落点同步：${rel}`);
  ok(readAt(r, "web-console/site/index.html").includes(`v${BASELINE}`) && !readAt(r, "web-console/site/index.html").includes("0.7.1-test.1"), "官网门面豁免：预发不刷、停留正式版");
  const c = run(r, "--check");
  ok(c.status === 0, "升段后 --check 不误红（rc=0）");
  const w2 = run(r, "--write");
  ok(!w2.stderr.includes("撞顶"), "幂等：再跑不再触发升段");
}

console.log("B. minor 进位：0.7.99-test.100 → 0.8.0-test.1：");
{
  const r = mkRepo("0.7.99-test.100");
  const w = run(r, "--write");
  ok(readAt(r, "VERSION") === "0.8.0-test.1\n", "patch=99 → minor+1、patch 归 0");
  ok(w.stderr.includes("自动升段 0.8.0-test.1"), "转换日志正确");
  ok(readAt(r, "expo-app/app.json").includes('"versionCode": 79901'), "versionCode=8*1e4-(100-1)=79901");
}

console.log("C. 正文规则直证：0.7.9-test.100 → 0.7.10-test.1（patch=9 未满槽不进位）：");
{
  const r = mkRepo("0.7.9-test.100");
  run(r, "--write");
  ok(readAt(r, "VERSION") === "0.7.10-test.1\n", "patch+1=10 ≤99（两位槽事实先例 0.4.18）");
  ok(readAt(r, "expo-app/app.json").includes('"versionCode": 70901'), "versionCode=7*1e4+10*100-99=70901（>0.7.9-test.99 的 70899，单调）");
}

console.log("D. snap 同款：0.7.0-snap.100 → 0.7.1-snap.1：");
{
  const r = mkRepo("0.7.0-snap.100");
  const w = run(r, "--write");
  ok(readAt(r, "VERSION") === "0.7.1-snap.1\n", "snap 通道同规则");
  ok(w.stderr.includes("自动升段 0.7.1-snap.1"), "snap 转换日志在");
}

console.log("E. N≤99 零变化：0.7.0-test.99 与原版（cf1fd078）逐字节一致：");
{
  // 原版脚本从 git 对象取（分支基点），两仓同输入比对三模式输出与写后落点字节
  const orig = spawnSync("git", ["-C", here + "/..", "show", "cf1fd078:scripts/version.mjs"], { encoding: "utf8" });
  if (orig.status !== 0) { ok(false, "取原版 cf1fd078:scripts/version.mjs 失败"); }
  else {
    const rNew = mkRepo("0.7.0-test.99"), rOld = mkRepo("0.7.0-test.99", orig.stdout);
    for (const mode of ["", "--write", "--check"]) {
      const a = run(rOld, mode), b = run(rNew, mode);
      ok(a.status === b.status && a.stdout === b.stdout && a.stderr === b.stderr, `mode=${mode || "(查看)"} 三流逐字节一致（rc=${a.status}）`);
    }
    for (const rel of ["VERSION", "web-console/index.html", "expo-app/app.json", "expo-app/android/app/build.gradle", "desktop-tauri/package.json", "web-console/site/index.html"])
      ok(readAt(rNew, rel) === readAt(rOld, rel), `写后落点字节一致：${rel}`);
  }
}

console.log("F. --check 撞顶语义：先升段事实源、落点红提示 --write、闭环后绿：");
{
  const r = mkRepo("0.7.0-test.100"); // 落点停留 BASELINE 旧值
  const c = run(r, "--check");
  ok(c.status === 1, "落点未刷 → --check 红 rc=1（版本不一致，非格式误红）");
  ok(c.stdout.includes("≠ 0.7.1-test.1"), "红在落点对照（对升段后事实源校验）");
  ok(c.stderr.includes("撞顶"), "--check 同样升段+stderr 日志");
  ok(readAt(r, "VERSION") === "0.7.1-test.1\n", "--check 路径也回写 VERSION（事实源收敛）");
  ok(run(r, "--write").status === 0 && run(r, "--check").status === 0, "--write 刷落点后 --check 绿（发版闸闭环）");
}

console.log("G. 正式版零扰动：0.7.0 无升段：");
{
  const r = mkRepo("0.7.0");
  const w = run(r, "--write");
  ok(!w.stderr.includes("撞顶") && w.status === 0, "正式版无转换日志");
  ok(readAt(r, "VERSION") === "0.7.0\n", "VERSION 不被改写");
  ok(readAt(r, "expo-app/app.json").includes('"versionCode": 70000'), "versionCode=70000");
  ok(readAt(r, "web-console/site/index.html").includes("v0.7.0"), "正式版官网门面照刷（stableOnly 仅豁免预发）");
}

console.log("H. 双槽满进位（边界）：0.99.99-test.100 → 1.0.0-test.1：");
{
  const r = mkRepo("0.99.99-test.100");
  run(r, "--write");
  ok(readAt(r, "VERSION") === "1.0.0-test.1\n", "patch/minor 双满 → major 进位归零");
  ok(readAt(r, "expo-app/app.json").includes('"versionCode": 999901'), "versionCode=1e6-(100-1)=999901（>0.99.99 的 999900，单调）");
}

for (const r of repos) rmSync(r, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} test-versionlift：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
