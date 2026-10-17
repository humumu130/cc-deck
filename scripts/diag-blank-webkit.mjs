// W-BLK3B（#145）设置页空白·真 WebKit 复现诊断
// 引擎对齐：Mac 桌面壳=WKWebView（Safari 17.x），此前修复全用 headless Chrome 验不出。
// 协议对齐：Tauri=tauri://localhost（自定义协议·无 HTTP 头·类 file://）——file:// 最贴近。
// 用法：node scripts/diag-blank-webkit.mjs [--file <path>] [--http]
//   缺省 file:///Applications/CC Deck Nova.app/.../index-005.html（用户在跑的 test.37 资产）
//   --http 走 python3 http.server 对比（Tauri 实际不走 http，仅隔离变量用）
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

const require = createRequire("/usr/local/lib/node_modules/");
const { webkit } = require("/usr/local/lib/node_modules/playwright-core/index.js");

const APP_HTML = "/Applications/CC Deck Nova.app/Contents/Resources/web-console/index-005.html";
const argFile = process.argv.includes("--file") ? process.argv[process.argv.indexOf("--file") + 1] : APP_HTML;
const useHttp = process.argv.includes("--http");

const OUT = "/tmp/w-blk3b";
fs.mkdirSync(OUT, { recursive: true });

const events = { console: [], pageerror: [], requestfailed: [], rejection: [] };

let url;
let server = null;
if (useHttp) {
  const dir = argFile.startsWith("/") ? argFile.slice(0, argFile.lastIndexOf("/")) : "web-console";
  const port = 18923;
  server = spawn("python3", ["-m", "http.server", String(port), "--directory", dir], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  url = `http://127.0.0.1:${port}/${(argFile.split("/").pop())}`;
} else {
  url = "file://" + argFile;
}
console.log("[diag] URL:", url);

const browser = await webkit.launch({
  // 全局 playwright-core 期望 webkit-2248；本机缓存为 special-2251（Mac14 arm64 专用构建）
  // ——executablePath 直挂跳过版本校验（同代次协议兼容）
  executablePath: process.env.PLAYWRIGHT_WEBKIT_EXE ?? (await (async () => {
    const os = await import("node:os");
    const caches = os.homedir() + "/Library/Caches/ms-playwright";
    const cand = fs.readdirSync(caches).filter((d) => d.startsWith("webkit")).sort().reverse()[0];
    if (!cand) throw new Error("无 webkit 构建缓存");
    return `${caches}/${cand}/pw_run.sh`;
  })()),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => events.console.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => events.pageerror.push(String(e.stack || e.message)));
page.on("requestfailed", (r) => events.requestfailed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on("unhandledrejection" in page ? "unhandledrejection" : "pageerror", () => {}); // webkit 无独立事件，pageerror 已覆盖

try {
  await page.goto(url, { waitUntil: "load", timeout: 20000 });
} catch (e) {
  console.log("[diag] goto 挂:", String(e).slice(0, 200));
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/01-loaded.png` });

// 探测页面结构：rail 域切换键（005 双列壳）
const probe = await page.evaluate(() => {
  const railBtns = [...document.querySelectorAll("[data-d]")].map((b) => b.dataset.d);
  const hasB2 = !!document.querySelector("#b2-body, .b2-stage, #d-settings");
  const title = document.title;
  return { railBtns: [...new Set(railBtns)], hasB2, title };
});
console.log("[diag] 结构探测:", JSON.stringify(probe).slice(0, 300));

// 切设置视图（多 selector 容错）
const switched = await page.evaluate(() => {
  const cand = document.querySelector('[data-d="set"]') || [...document.querySelectorAll("button,span,div")].find((x) => (x.textContent || "").trim() === "设置" && x.querySelector("svg, i"));
  if (!cand) return "no-entry";
  cand.click();
  return "clicked";
});
console.log("[diag] 设置切换:", switched);
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/02-settings.png` });

// 设置容器渲染态
const state = await page.evaluate(() => {
  const cands = [...document.querySelectorAll("#d-settings, [data-page='settings'], .settings-nav, .settings-row")];
  const first = cands[0];
  if (!first) return { found: 0 };
  const cs = getComputedStyle(first);
  const r = first.getBoundingClientRect();
  return { found: cands.length, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, height: Math.round(r.height), width: Math.round(r.width), children: first.children.length };
});
console.log("[diag] 设置容器:", JSON.stringify(state));

// 输出错误汇总
console.log("\n===== console（全部）=====");
events.console.slice(0, 30).forEach((l) => console.log("  " + l.slice(0, 220)));
console.log("===== pageerror（首错在此）=====");
events.pageerror.slice(0, 6).forEach((l) => console.log("  " + l.slice(0, 500)));
console.log("===== requestfailed =====");
events.requestfailed.slice(0, 8).forEach((l) => console.log("  " + l.slice(0, 180)));
fs.writeFileSync(`${OUT}/events.json`, JSON.stringify(events, null, 2));

await browser.close();
if (server) server.kill();
console.log("\n[diag] 截图: " + OUT + "/01-loaded.png / 02-settings.png");
