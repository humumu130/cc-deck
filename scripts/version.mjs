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
      s.replace(/^([ \t]*)const CONSOLE_VERSION = "(?:.+?)";/m, `$1const CONSOLE_VERSION = "${canonical}";`),
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
    name: "desktop-tauri package.json version",
    file: "desktop-tauri/package.json",
    get: (s) => /"version":\s*"(.+?)"/.exec(s)?.[1],
    set: (s) => s.replace(/("version":\s*)"(?:.+?)"/, `$1"${canonical}"`),
  },
  {
    // 主页（cloudflare worker /dl/）三处版本展示：hero 徽章 / lead 行 / 桌面卡副标——
    // 用户定立的发版纪律：每次发版主页版本信息必须同步（2026-09-09），纳入单一事实源自动化
    // 预发通道容忍（2026-10-07 ⑥d）：canonical 带 -test.N 预发段时 `[\d.]+` 只吃到
    // 主干（v0.7.0-test.2 取到 0.7.0 ≠ canonical），version --check 永远红、闸门连环挂；
    // 三处取值/回写统一带可选预发段（正式版三段号行为不变）
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
  const raw = read(t.file);
  const cur = t.get(raw);
  const ok = cur === canonical;
  if (!ok) mismatch = true;
  console.log(`${ok ? "✓" : "✗"} ${t.name}: ${cur ?? "(未找到)"}${ok ? "" : ` ≠ ${canonical}`}`);
  if (!ok && (mode === "--write" || mode === "-w")) write(t.file, t.set(raw));
}
if (mode === "--write" || mode === "-w") console.log(`已全部同步为 ${canonical}`);
else if (mismatch && mode === "--check") {
  console.error("版本不一致：发版时只改 VERSION 后运行 node scripts/version.mjs --write");
  process.exit(1);
}
