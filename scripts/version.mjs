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
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(canonical)) {
  console.error(`VERSION 文件不是 semver（三段或四段，如 0.3.26 / 0.3.26.1）：${canonical}`);
  process.exit(1);
}

// 各落点：[文件, 取值正则, 回写替换函数]
const targets = [
  {
    name: "web-console CONSOLE_VERSION",
    file: "web-console/index.html",
    get: (s) => /^const CONSOLE_VERSION = "(.+?)";$/m.exec(s)?.[1],
    set: (s) => s.replace(/^const CONSOLE_VERSION = "(?:.+?)";$/m, `const CONSOLE_VERSION = "${canonical}";`),
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
    name: "cloudflare homepage version",
    file: "web-console/site/index.html",
    get: (s) => /<i class="pulse"><\/i>v([\d.]+)/.exec(s)?.[1],
    set: (s) =>
      s
        .replace(/(<i class="pulse"><\/i>)v[\d.]+/, `$1v${canonical}`)
        .replace(/当前版本 v[\d.]+/, `当前版本 v${canonical}`)
        .replace(/Windows · v[\d.]+ · Tauri/, `Windows · v${canonical} · Tauri`),
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
