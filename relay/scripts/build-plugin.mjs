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
  external: ["bufferutil", "utf-8-validate"],
  define: { "process.env.CC_DECK_PLUGIN": '"1"' },
  // banner 里不声明 createRequire 标识符——源码（如 cli-path.ts）静态 import { createRequire }
  // 时 esbuild 会原样保留该 import，banner 再 import 一份 = 重复声明 SyntaxError，
  // 整个 bundle 起不来（2026-09-16 事故）。动态取用无标识符冲突
  banner: { js: "const require = (await import('node:module')).createRequire(import.meta.url);" },
  logLevel: "info",
});

// 2. 静态资源：网页控制台 + 移动端 PWA 壳 + APK + 注入器源码 + bridge hook（单源复制，防双份漂移）
// ⚠ 此清单与 desktop-tauri/src-tauri/tauri.conf.json 的 resources 映射需同步维护
//   （#150：桌面打包漏 web-console/mobile → relay 网页端 503；qr.js 此处未拷，桌面打包有）
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { force: true });
  cpSync(from, to, { recursive: true });
};
copy(join(root, "web-console", "index.html"), join(out, "web-console", "index.html"));
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

// 3. 版本同步：plugin.json 为源，写回 marketplace.json（防两处手改漂移）
const pluginJson = JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf-8"));
const mktPath = join(root, ".claude-plugin", "marketplace.json");
const mkt = JSON.parse(readFileSync(mktPath, "utf-8"));
for (const p of mkt.plugins) {
  if (p.name === pluginJson.name) p.version = pluginJson.version;
}
writeFileSync(mktPath, JSON.stringify(mkt, null, 2) + "\n");

console.log(`\n插件已打包到: ${out}`);
console.log("本地验证: claude plugin marketplace add <此目录绝对路径> && claude plugin install cc-deck@cc-deck-plugins");
