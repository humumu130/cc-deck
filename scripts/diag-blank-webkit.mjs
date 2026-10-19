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

// ===== W-BLK4：连态注入（#145 第五轮）=====
// 生产 relay 只读消费：WS 连 8787 收 SNAPSHOT，经帧总线（地基 emit 同款入口）
// 注入页面——B2/B4 渲染链全跑，会话列表/团队卡塞满=真壳连态。零命令上行。
if (process.argv.includes("--connected")) {
  const token = fs.readFileSync(`${process.env.HOME}/.cc-deck/data/token`, "utf8").trim();
  const wsUrl = `ws://127.0.0.1:8787/ws?token=${encodeURIComponent(token)}`;
  console.log("[diag] 连态注入:", wsUrl.slice(0, 50) + "…");
  const conn = await page.evaluate(async (u) => {
    return await new Promise((resolve) => {
      const frames = window.__ccDeck005Frames;
      if (!frames) { resolve("no-bus"); return; }
      let snap = 0, upd = 0;
      const ws = new WebSocket(u);
      const done = () => resolve(`ws=snap:${snap}/upd:${upd}`);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          frames.emit({ kind: "frame", frame: m, source: "lan" });
          if (m.type === "SNAPSHOT") snap++;
          else if (m.type && m.type !== "COMMAND_ACK") upd++;
        } catch {}
      };
      ws.onopen = () => console.log("[page] ws open");
      ws.onerror = () => { resolve("ws-error"); };
      ws.onclose = (e) => { resolve(`ws-closed code=${e.code}`); };
      // 也喂 ws 状态事件（B2 的 status 语义）+ 挂 sessionCount 变化等待
      frames.emit({ kind: "ws", state: "open" });
      setTimeout(done, 6000); // 收 6s 帧（SNAPSHOT+可能的增量）
    });
  }, wsUrl);
  console.log("[diag] 连态注入结果:", conn);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/01c-connected.png` });
}

// 切设置视图（多 selector 容错）
const switched = await page.evaluate(() => {
  // W-BLK4：005 真实 rail 键优先（data-domain）——旧 fallback 易点中 mobile 导航
  const cand = document.querySelector('.rail-btn[data-domain="settings"]') || document.querySelector('[data-d="set"]') || [...document.querySelectorAll("button,span,div")].find((x) => (x.textContent || "").trim() === "设置" && x.querySelector("svg, i"));
  if (!cand) return "no-entry";
  cand.click();
  return "clicked";
});
console.log("[diag] 设置切换:", switched);
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/02-settings.png` });
// W-BLK4：再等 1s 动态渲染后补一张（连态下 live 区后续填充）
await page.waitForTimeout(1200);

await page.screenshot({ path: `${OUT}/02b-settings-late.png` });
// 设置容器渲染态 + W-BLK4 全几何（连态撑高排查：谁把 d-settings 推出视口）
const state = await page.evaluate(() => {
  const cands = [...document.querySelectorAll("#d-settings, [data-page='settings'], .settings-nav, .settings-row")];
  const first = cands[0];
  if (!first) return { found: 0 };
  const cs = getComputedStyle(first);
  const r = first.getBoundingClientRect();
  // 兄弟节点几何（找撑高者）：#d-settings 的父级 stage-desktop 的直接子域 + 关键层
  const geo = {};
  const stage = first.closest(".mode-stage, #stage-desktop") || first.parentElement;
  if (stage) {
    geo.stage = { tag: stage.id || stage.className.slice(0, 30), rect: { y: Math.round(stage.getBoundingClientRect().y), h: Math.round(stage.getBoundingClientRect().height), sh: stage.scrollHeight } };
    geo.siblings = [...stage.children].map((c) => {
      const cr = c.getBoundingClientRect();
      return { id: c.id || String(c.className).slice(0, 26), y: Math.round(cr.y), h: Math.round(cr.height), sh: c.scrollHeight, off: Math.abs(cr.y) > 9000 ? "OFFSCREEN" : "" };
    }).slice(0, 12);
  }
  // 全页滚动三件套 + d-settings 深处首行可见性
  const de = document.documentElement;
  geo.doc = { scrollH: de.scrollHeight, clientH: de.clientHeight, bodyScrollH: document.body.scrollHeight };
  const row1 = first.querySelector(".settings-row, .v8-setcard, .v8-sethead");
  if (row1) { const rr = row1.getBoundingClientRect(); geo.firstRow = { y: Math.round(rr.y), h: Math.round(rr.height), inView: rr.y >= 0 && rr.y < window.innerHeight }; }
  return { found: cands.length, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, height: Math.round(r.height), width: Math.round(r.width), y: Math.round(r.y), children: first.children.length, ...geo };
});
console.log("[diag] 设置容器+几何:", JSON.stringify(state, null, 1));

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
