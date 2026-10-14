// #102 批 B web 半测试件：登录引导卡（LoginCard 模块/AUTH_REQUIRED 帧分支/QR 渲染链/
// 三入口接线/目录转绿 patch）。范式=test-005-engauth-web.ts（静态锚 + blockFrom
// 提取纯函数 eval 直跑——不拉浏览器，词面与逻辑双锚）。
//
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-englogin-web.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "web-console", "index-005.html"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string): string {
  const i = html.indexOf(needle);
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "} ") { depth--; if (depth === 0) return html.slice(i, k + 1); }
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  return "";
}

console.log("== #102 批 B web：登录引导卡 + AUTH_REQUIRED 消费链 ==");

// ---- A. 帧消费：handleFrame AUTH_REQUIRED 分支 ----
{
  const branch = html.indexOf('frame.type === "AUTH_REQUIRED"');
  ok(branch > 0, "A1 handleFrame 含 AUTH_REQUIRED 分支（B4 桥帧总线消费）");
  const seg = branch > 0 ? html.slice(branch - 200, branch + 300) : "";
  ok(seg.includes("__ccDeck005LoginCard") && seg.includes("onFlow"), "A2 分支转 LoginCard.onFlow（payload 透传渲染）");
}

// ---- B. LoginCard 模块结构（QR/按钮/patch） ----
{
  const mod = html.indexOf("window.__ccDeck005LoginCard = (() => {");
  ok(mod > 0, "B1 LoginCard 模块在场（window 全局——跨 script 块可达）");
  const modEnd = html.indexOf("// ---------- 项目域聚合与渲染", mod);
  const seg = mod > 0 && modEnd > mod ? html.slice(mod, modEnd) : "";
  ok(seg.includes("new QRCode(0, QRErrorCorrectLevel.M)") && seg.includes("isDark"), "B2 QR 渲染链与 FB3 配对同款（qr.js QRCode 类 + canvas 逐格——不引外链）");
  ok(seg.includes('data-elc-act="verify"') || seg.includes('"verify"'), "B3 「我已完成登录」按钮链（verify 动作发 COMMAND_ENGINE_LOGIN）");
  ok(seg.includes('"cancel"'), "B4 取消按钮链（cancel 动作）");
  ok(seg.includes('"retry"'), "B5 终态重开按钮链（timeout/error/cancelled 后可重新发起）");
  ok(seg.includes("COMMAND_ENGINE_LOGIN"), "B6 命令走 bridge.sendCommand（主连接通道）");
  const patch = blockFrom("const patchCatalog = (engine) => {");
  ok(patch.includes('hit.state = "ready"'), "B7 ready 事件 → 本地 catalog patch（目录黄点转绿不等重连）");
  ok(seg.includes('flow.mode === "browser"') && seg.includes("回到这台电脑"), "B8 browser 模式文案（codex 本机浏览器回调——手机端见「回到电脑前」提示）");
  ok(seg.includes("qr_text"), "B9 二维码字符画透传渲染（pre 等宽兜底通道）");
  const openFn = blockFrom("open(engine) {");
  ok(openFn.includes('action: "start"'), "B10 open() 幂等 start（ACK data 即流程投影直接渲染）");
}

// ---- C. 三入口接线 ----
{
  const submitSeg = html.indexOf("已为你拉起登录引导");
  ok(submitSeg > 0 && html.slice(submitSeg - 300, submitSeg + 200).includes("LoginCard.open"), "C1 创建弹窗提交拦截 → 自动弹登录卡（toast 升级）");
  const ackSeg = html.indexOf("登录引导已弹出");
  ok(ackSeg > 0 && html.slice(ackSeg - 400, ackSeg + 200).includes("LoginCard.open"), "C2 fail-fast ACK needs_auth → 幂等兜底再开卡");
  const menuRow = html.indexOf('data-engine-login="');
  ok(menuRow > 0, "C3 引擎菜单未登录组行可点（data-engine-login）");
  const settingsRow = html.indexOf("立即登录</button>");
  ok(settingsRow > 0, "C4 设置·引擎目录行「立即登录」按钮（row-share 同款样式）");
  const mobileRow = html.indexOf("未登录 · 点此扫码登录");
  ok(mobileRow > 0, "C5 移动视口引擎行「未登录 · 点此扫码登录」");
  const delegated = html.indexOf('const engLoginRow = event.target.closest("[data-engine-login]")');
  ok(delegated > 0, "C6 设置区委托分支（立即登录 → LoginCard.open）");
}

// ---- D. CSS 卡面 ----
{
  ok(html.includes(".englogin-card {"), "D1 登录卡样式在场（fixed 浮卡）");
  ok(html.includes(".elc-qrwrap") && html.includes(".elc-art"), "D2 QR 白底容器 + 字符画等宽容器（两类码面）");
  ok(html.includes(".englogin-card.ready"), "D3 ready 绿态样式（转绿视觉）");
}

// ---- E. eval 直跑：patchCatalog 语义（纯函数面） ----
{
  // patchCatalog 依赖 bridge/subscribers 闭包——eval 提取内层语义做行为等价校验
  const patch = blockFrom("const patchCatalog = (engine) => {");
  ok(patch.length > 0, "E1 patchCatalog 可提取");
  ok(patch.includes("find((e) => e && e.id === engine)") && patch.includes('delete hit.auth_hint'), "E2 patch 语义：按 id 定位 + state=ready + 清 auth_hint");
}

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
