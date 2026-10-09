#!/usr/bin/env node
// 打包 CC Deck 插件：bundle relay 成单文件 + 汇集静态资源到 cc-plugins/plugins/cc-deck/
// 用法：node scripts/build-plugin.mjs（relay 目录下）
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const relayRoot = join(here, "..");
const root = join(relayRoot, "..");
const out = join(root, "cc-plugins", "plugins", "cc-deck");

// 1. bundle relay：esm 单文件，ws 的可选原生依赖不打进
await build({
  entryPoints: [join(relayRoot, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18", // #17（2026-09-10）：内嵌 relay 真实下限=18（源码用 top-level await + 全局 fetch，node14 转译救不了）；老 Node 由壳侧 err 引导升级（见 main.rs EMBEDDED_RELAY_ERR）
  outfile: join(out, "scripts", "relay.mjs"),
  // better-sqlite3 是原生模块（.node 二进制）不可内联：bundle 进 ESM 后其运行时依赖
  // bindings 包的 __filename 在 ESM 语境未定义 → 任何环境首次 boot 即 ReferenceError
  // （2026-10-07 部署单沙盒首 boot 实锤，此前测试全走 tsx 源码未踩中）。运行时从
  // bundle 同目录 node_modules 解析——插件/桌面两形态发布都须随包携带
  // node_modules 内 better-sqlite3 完整运行时 require 闭包：bindings、
  // file-uri-to-path（缺 file-uri-to-path 同样 boot 必崩，2026-10-07 沙盒
  // 二度实锤；含 build/Release 原生二进制）
  external: ["bufferutil", "utf-8-validate", "better-sqlite3"],
  define: { "process.env.CC_DECK_PLUGIN": '"1"' },
  // banner 里不声明 createRequire 标识符——源码（如 cli-path.ts）静态 import { createRequire }
  // 时 esbuild 会原样保留该 import，banner 再 import 一份 = 重复声明 SyntaxError，
  // 整个 bundle 起不来（2026-09-16 事故）。动态取用无标识符冲突
  banner: { js: "const require = (await import('node:module')).createRequire(import.meta.url);" },
  logLevel: "info",
});

// 2. 版本同步（单一版本源）：plugin.json 为源，回写三线——marketplace.json、
//    desktop-tauri/package.json（App 壳版本，tauri.conf.json version 引用它）、
//    web-console CONSOLE_VERSION。0.7.0 起三线统一，一处 bump 全线同步
//    （杜绝「App 0.6.4 > 控制台 0.6.2 却内容更旧」的撞名再现）。
//    ⚠ 必须在静态资源拷贝之前跑：拷贝从 root/web-console 取源，晚于此步
//    产物会带上旧版本号（test.1 预发首跑实锤，git status 无 diff 即症状）
const pluginJson = JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf-8"));
const ver = pluginJson.version;
const mktPath = join(root, ".claude-plugin", "marketplace.json");
const mkt = JSON.parse(readFileSync(mktPath, "utf-8"));
for (const p of mkt.plugins) {
  if (p.name === pluginJson.name) p.version = ver;
}
writeFileSync(mktPath, JSON.stringify(mkt, null, 2) + "\n");
const pkgPath = join(root, "desktop-tauri", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
pkg.version = ver;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const wcPath = join(root, "web-console", "index.html");
writeFileSync(wcPath, readFileSync(wcPath, "utf-8").replace(/(CONSOLE_VERSION\s*=\s*)"[^"]*"/, `$1"${ver}"`));
// 双壳同刷（新旧壳共存，2026-10-07 用户拍板）：/app2 的 005 新壳也是在线服务面，
// 版本回写两处都做，防主/副壳版本号各说各话
const wc005Path = join(root, "web-console", "index-005.html");
writeFileSync(wc005Path, readFileSync(wc005Path, "utf-8").replace(/(CONSOLE_VERSION\s*=\s*)"[^"]*"/, `$1"${ver}"`));

// 3. 静态资源：网页控制台 + 移动端 PWA 壳 + APK + 注入器源码 + bridge hook（单源复制，防双份漂移）
// ⚠ 此清单与 desktop-tauri/src-tauri/tauri.conf.json 的 resources 映射需同步维护
//   （#150：桌面打包漏 web-console/mobile → relay 网页端 503；qr.js 此处未拷，桌面打包有）
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { force: true });
  cpSync(from, to, { recursive: true });
};
copy(join(root, "web-console", "index.html"), join(out, "web-console", "index.html"));
// 005 新壳（新旧壳共存，2026-10-07 用户拍板）：relay /app2 对照入口的伺服文件——
// 白名单漏拷 = 插件包内 /app2 恒 503
copy(join(root, "web-console", "index-005.html"), join(out, "web-console", "index-005.html"));
copy(join(root, "web-console", "nacl.js"), join(out, "web-console", "nacl.js"));
// qr.js（扫码登录编码器）：#150 补——此前漏拷，插件部署的网页端点扫码按钮静默抛错（#325 同坑）
copy(join(root, "web-console", "qr.js"), join(out, "web-console", "qr.js"));
for (const f of ["manifest.json", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "maskable-512.png"]) {
  copy(join(root, "web-console", f), join(out, "web-console", f));
}
for (const f of ["index.html", "manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png"]) {
  copy(join(root, "mobile", f), join(out, "mobile", f));
}
// cc-deck.apk 是未跟踪的本地构建产物（Windows 时代习惯），缺失时跳过而非炸掉整个打包
//（Mac 接管后常无此文件；插件里旧 APK 副本保留不动）
if (existsSync(join(root, "mobile", "cc-deck.apk"))) {
  copy(join(root, "mobile", "cc-deck.apk"), join(out, "mobile", "cc-deck.apk"));
}
copy(join(relayRoot, "bin", "inject.cs"), join(out, "bin", "inject.cs"));
copy(join(relayRoot, "hooks", "bridge-hook.mjs"), join(out, "scripts", "hook.mjs"));
// desktop-tauri 内嵌 relay：与插件 bundle 同源复制（018 :424/:630——三产物统一由本
// 脚本生成、SHA 一致，禁手工 cp；历史上靠人工「桌面副本同步」曾漂移，P1a 上报后
// 2026-10-05 补此步）。产物同步清单与 tauri.conf.json resources 映射呼应（见 :32 ⚠）
copy(join(out, "scripts", "relay.mjs"), join(root, "desktop-tauri", "src-tauri", "resources", "relay.mjs"));

// 2b. native 闭包汇集（better-sqlite3 external 的发布面）：bundle 同目录须有
// node_modules/{better-sqlite3,bindings,file-uri-to-path}（见 external 注释）。
// better-sqlite3 只带运行时最小集（lib + build/Release/*.node + package.json，
// 不带 deps/src 编译料，26M→约 2M）；bindings/file-uri-to-path 纯 JS 整包。
// 两发布形态同源汇集：插件 scripts/node_modules + 桌面 resources/node_modules
//
// ⚠ 平台来源（#158，2026-10-08）：build/Release/better_sqlite3.node 拷自本机
// relay/node_modules——即**当前构建机的平台二进制**（dev 机 = darwin-arm64）。
// 汇集产物【不跨平台】：mac 发布（dmg）恰好正确；Windows 发布必须由 CI
// （.github/workflows/desktop.yml 的 prebuild-install 步）在 Windows runner 上
// 现场重拉 win32-x64 覆盖——0.7.0-test.3 就是闭包携 Mach-O 进 Windows 包，
// 内嵌 relay dlopen 即炸（8787 永不监听）。下方日志按魔数实测明示，防后人
// 误以为汇集产物跨平台；本地直出 Windows 包 = 必炸，勿省 CI 步。
const nmSrc = join(relayRoot, "node_modules");
const gatherClosure = (nmOut) => {
  rmSync(nmOut, { recursive: true, force: true });
  const bs = join(nmOut, "better-sqlite3");
  mkdirSync(join(bs, "build", "Release"), { recursive: true });
  copy(join(nmSrc, "better-sqlite3", "lib"), join(bs, "lib"));
  copy(join(nmSrc, "better-sqlite3", "build", "Release", "better_sqlite3.node"), join(bs, "build", "Release", "better_sqlite3.node"));
  copy(join(nmSrc, "better-sqlite3", "package.json"), join(bs, "package.json"));
  copy(join(nmSrc, "bindings"), join(nmOut, "bindings"));
  copy(join(nmSrc, "file-uri-to-path"), join(nmOut, "file-uri-to-path"));
};
gatherClosure(join(out, "scripts", "node_modules"));
gatherClosure(join(root, "desktop-tauri", "src-tauri", "resources", "node_modules"));

// 闭包内原生二进制实测告示（魔数判型：PE/Mach-O/ELF）——汇集即打，见上 ⚠ 平台来源
const nativeMagic = (file) => {
  const hex = readFileSync(file).subarray(0, 4).toString("hex");
  if (hex === "cffaedfe") return "Mach-O arm64 (darwin)";
  if (hex === "feedfacf") return "Mach-O x64 (darwin)";
  if (hex === "cafebabe") return "Mach-O fat (darwin)";
  if (hex.startsWith("4d5a")) return "PE (win32)";
  if (hex.startsWith("7f45")) return "ELF (linux)";
  return `unknown (${hex})`;
};
const nativeKind = nativeMagic(join(out, "scripts", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
console.warn(`[native] 闭包 better_sqlite3.node = ${nativeKind}——只保证 ${process.platform}-${process.arch} 可载；Windows 发布须由 CI desktop.yml 的 prebuild-install 步覆盖为 win32-x64（#158）`);

console.log(`\n插件已打包到: ${out}`);
console.log("本地验证: claude plugin marketplace add <此目录绝对路径> && claude plugin install cc-deck@cc-deck-plugins");
