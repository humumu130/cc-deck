// 版本号单一事实源同步/校验（#394 根治版本显示不同步）
// 用法：
//   node scripts/version.mjs            查看各处当前值
//   node scripts/version.mjs --check    任一处与 VERSION 不一致 → 非零退出（pre-commit 钩子用）
//   node scripts/version.mjs --write    把 VERSION 的值写入全部落点
// 事实源：仓库根 VERSION 文件（单行 semver，如 0.3.26）。发版只改这里 + 跑 --write。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, s) => writeFileSync(join(root, p), s);

const canonical = read("VERSION").trim();
// 三段主干 + 可选预发段（2026-10-07 ⑥d）：0.7.0 起 test 通道版本（-test.N）也走
// 单一事实源出包；四段号（0.4.18.1）依旧禁止——Tauri/npm 不兼容，2026-09-11 废止
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(canonical)) {
  console.error(`VERSION 文件不是三段 semver（可带 -test.N 预发段；四段号与 Tauri/npm 不兼容——0.4.18.1 实测产物版本错乱，2026-09-11 废止）：${canonical}`);
  process.exit(1);
}

// versionCode 推导（2026-10-10 #44 收编为落点）：Android 覆盖升级硬要求 versionCode
// 单调不减，此前 build.gradle 硬编码 101、expo 自动值不随版本走——0.6.3 正式版
// versionCode=104，所有 0.6.3 用户装不上任何 0.7 包（INSTALL_FAILED_VERSION_DOWNGRADE）。
// 规则不用「统一 +1」手工计数器——忘 bump 即复发同一 bug；改用 VERSION 确定性推导，
// --write 自动得值、--check 可精确校验，遗忘类事故根除：
//   base = major*1e6 + minor*1e4 + patch*100（minor/patch 各留两位槽）
//   预发（-test.N/-snap.N）再减 (100-N)：同版本 test 包排在正式版之下
//   （0.7.0-test.99=69999 < 0.7.0=70000，test 用户可升正式版；N 限两位）
// 值域对照：0.6.3=60300（历史已发 104，新值只需后续 >104）、0.7.0-test.10=69910、
// 0.7.0=70000、0.7.1=70100——对 104/101 均严格递增
const vc = /^(\d+)\.(\d+)\.(\d+)(?:-(test|snap)\.(\d+))?$/.exec(canonical);
if (!vc) {
  console.error(`VERSION 预发段只认 -test.N/-snap.N 两位数（versionCode 推导需要）：${canonical}`);
  process.exit(1);
}
const [, vcMaj, vcMin, vcPat, vcPre, vcPreN] = vc;
if (Number(vcMin) > 99 || Number(vcPat) > 99) {
  console.error(`VERSION minor/patch 超两位槽（${vcMin}.${vcPat}）：versionCode 推导会跨槽串位，请换新 major`);
  process.exit(1);
}
if (vcPre && Number(vcPreN) > 99) {
  console.error(`VERSION 预发序号超两位（${vcPre}.${vcPreN}）：versionCode 推导只容 N≤99（否则与正式版撞号），请发新版本号`);
  process.exit(1);
}
const versionCode = Number(vcMaj) * 1e6 + Number(vcMin) * 1e4 + Number(vcPat) * 100 - (vcPre ? 100 - Number(vcPreN) : 0);

// 各落点：[文件, 取值正则, 回写替换函数]
const targets = [
  {
    name: "web-console CONSOLE_VERSION",
    file: "web-console/index.html",
    // 行尾注释容忍（2026-10-03）：dev→m2 合并带入的 `"; // dev 0.6.2 …` 尾注曾让
    // `$` 锚定正则取不到值、版本闸门误报「未找到」。取值只认引号内；回写只替换
    // 语句本体、尾注原样保留
    // 前导空白容忍（2026-10-07 ⑥d）：005 壳的常量在 IIFE 内带 6 空格缩进，行首
    // `^const` 锚定取不到值；允许缩进并在回写时原样保留（desktop.yml 的 sed 无 ^
    // 天然兼容，不用动）
    get: (s) => /^[ \t]*const CONSOLE_VERSION = "(.+?)";/m.exec(s)?.[1],
    set: (s) =>
      s.replace(/^([ \t]*)const CONSOLE_VERSION = "(?:.+?)";/m, `$1const CONSOLE_VERSION = "${canonical}"`),
  },
  {
    // 新旧壳共存（用户拍板，2026-10-07）：/app2 的 005 新壳也是在线服务面（relay /app2、
    // CF /app2），版本统一纪律两处都刷，防主/副壳版本漂移各说各话
    name: "web-console-005 CONSOLE_VERSION",
    file: "web-console/index-005.html", // console-guardrails ④：005 常量唯一定义位=壳头部 __ccDeck005Version（settings-domain 只读 window 值；旧 settings 域块字面量是漂移第三源，已退役）
    get: (s) => /__ccDeck005Version\s*=\s*"(.+?)"/.exec(s)?.[1],
    set: (s) =>
      s.replace(/(__ccDeck005Version\s*=\s*)"(?:.+?)"/, `$1"${canonical}"`),
  },
  {
    name: "expo-app app.json expo.version",
    file: "expo-app/app.json",
    get: (s) => /"version":\s*"(.+?)"/.exec(s)?.[1],
    set: (s) => s.replace(/("version":\s*)"(?:.+?)"/, `$1"${canonical}"`),
  },
  {
    name: "expo-app build.gradle versionName",
    file: "expo-app/android/app/build.gradle",
    get: (s) => /versionName\s+"(.+?)"/.exec(s)?.[1],
    set: (s) => s.replace(/versionName\s+"(?:.+?)"/, `versionName "${canonical}"`),
  },
  {
    // Android 覆盖升级闸（2026-10-10 #44，推导规则见文件头 versionCode 注释）：
    // app.json 是 expo/prebuild 的声明源（expo 读它生成/校验原生工程）。
    // expected：本落点校验值是推导整数而非 VERSION 字符串，走 expected 通道
    name: "expo-app app.json android.versionCode",
    file: "expo-app/app.json",
    get: (s) => /"versionCode":\s*(\d+)/.exec(s)?.[1],
    set: (s) => s.replace(/("versionCode":\s*)\d+/, `$1${versionCode}`),
    expected: String(versionCode),
  },
  {
    // 同上（#44）：CI（android.yml）用 checked-in android/ 目录 gradlew 直包、
    // 不跑 prebuild——build.gradle 的 versionCode 才是装机 APK 的真值
    // （此前硬编码 101 不动，正是 0.6.3 用户装不上 0.7 包的根因），两处同刷防漂移
    name: "expo-app build.gradle versionCode",
    file: "expo-app/android/app/build.gradle",
    get: (s) => /versionCode\s+(\d+)/.exec(s)?.[1],
    set: (s) => s.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`),
    expected: String(versionCode),
  },
  {
    name: "desktop-tauri package.json version",
    file: "desktop-tauri/package.json",
    get: (s) => /"version":\s*"(.+?)"/.exec(s)?.[1],
    set: (s) => s.replace(/("version":\s*)"(?:.+?)"/, `$1"${canonical}"`),
  },
  {
    // 插件清单版本（2026-10-10 A1 收敛，审查 P1-1）：plugin.json 此前是
    // relay/scripts/build-plugin.mjs 的「第二事实源」（打包时反读它回写三线），
    // 与 VERSION 并存且互不回写——test.7 批起 VERSION 停在 test.4、五处守卫全红
    // （63b92a7 bump 漏刷 VERSION 即漂移坐实）。收敛后 plugin.json 降为纯落点，
    // build-plugin.mjs 也改读 VERSION（见该文件步骤 2），两机制同源幂等
    name: "plugin.json version",
    file: "cc-plugins/plugins/cc-deck/.claude-plugin/plugin.json",
    get: (s) => /"version":\s*"(.+?)"/.exec(s)?.[1],
    set: (s) => s.replace(/("version":\s*)"(?:.+?)"/, `$1"${canonical}"`),
  },
  {
    // marketplace 清单版本（2026-10-10 A1 收敛，同上）：scope 到 cc-deck 插件块，
    // 未来加第二个 plugin 时首个 "version" 通配不会误伤
    name: "marketplace.json version",
    file: ".claude-plugin/marketplace.json",
    get: (s) => /"name":\s*"cc-deck"[\s\S]{0,200}?"version":\s*"(.+?)"/.exec(s)?.[1],
    set: (s) =>
      s.replace(/("name":\s*"cc-deck"[\s\S]{0,200}?"version":\s*)"(?:.+?)"/, `$1"${canonical}"`),
  },
  {
    // 主页（cloudflare worker /dl/）三处版本展示：hero 徽章 / lead 行 / 桌面卡副标——
    // 用户定立的发版纪律：每次发版主页版本信息必须同步（2026-09-09），纳入单一事实源自动化
    // 预发通道容忍（2026-10-07 ⑥d）：canonical 带 -test.N 预发段时 `[\d.]+` 只吃到
    // 主干（v0.7.0-test.2 取到 0.7.0 ≠ canonical），version --check 永远红、闸门连环挂；
    // 三处取值/回写统一带可选预发段（正式版三段号行为不变）
    // 官网只认正式版（用户口径 2026-10-08）：test 是自测通道不该上门面——canonical
    // 带预发段时本落点整体跳过（不读不写不报红），主页停留在最近正式版；0.7.0-test.3
    // 批曾把主页刷成 test 号线上公开可见，回退 0.6.3 并加此豁免根治
    stableOnly: true,
    name: "cloudflare homepage version",
    file: "web-console/site/index.html",
    get: (s) => /<i class="pulse"><\/i>v([\d.]+(?:-[\w.]+)?)/.exec(s)?.[1],
    set: (s) =>
      s
        .replace(/(<i class="pulse"><\/i>)v[\d.]+(?:-[\w.]+)?/, `$1v${canonical}`)
        .replace(/当前版本 v[\d.]+(?:-[\w.]+)?/, `当前版本 v${canonical}`)
        .replace(/Windows · v[\d.]+(?:-[\w.]+)? · Tauri/, `Windows · v${canonical} · Tauri`),
  },
];

const mode = process.argv[2] ?? "";
let mismatch = false;
for (const t of targets) {
  if (t.stableOnly && /-/.test(canonical)) {
    console.log(`↷ ${t.name}: 预发版不刷官网门面（停留最近正式版）`);
    continue;
  }
  const raw = read(t.file);
  const cur = t.get(raw);
  const expected = t.expected ?? canonical;
  const ok = cur === expected;
  if (!ok) mismatch = true;
  console.log(`${ok ? "✓" : "✗"} ${t.name}: ${cur ?? "(未找到)"}${ok ? "" : ` ≠ ${expected}`}`);
  if (!ok && (mode === "--write" || mode === "-w")) write(t.file, t.set(raw));
}
if (mode === "--write" || mode === "-w") console.log(`已全部同步为 ${canonical}`);
else if (mismatch && mode === "--check") {
  console.error("版本不一致：发版时只改 VERSION 后运行 node scripts/version.mjs --write");
  process.exit(1);
}
