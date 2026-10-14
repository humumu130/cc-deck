// #102 批 A web 半测试件：引擎目录 needs_auth 状态点渲染（设置·模型服务区/引擎选择器/
// 手机目录）+ 会话详情 auth_hint 指引行 + MERGE_KEYS 收容。范式=test-005-servers.ts
//（静态锚 + blockFrom 提取纯函数 eval 直跑——不拉浏览器，词面与逻辑双锚）。
//
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-engauth-web.ts
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
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  return "";
}

console.log("== #102 批 A web：needs_auth 状态点 + 指引链 ==");

// ---- A. engineStateText 纯函数直跑（胶囊 meta/菜单小字/拦截 toast 共用数据源） ----
{
  const src = blockFrom("function engineStateText(e) {");
  ok(src.length > 0, "A1 engineStateText 在场（blockFrom 可提取）");
  const oneLine = (t: string) => String(t ?? "");
  const fn = eval("(" + src + ")");
  ok(fn({ state: "needs_auth", auth_hint: "终端运行 codebuddy-code，输入 /login 完成登录" }) === "未登录 · 终端运行 codebuddy-code，输入 /login 完成登录", "A2 needs_auth → 「未登录 · <hint>」（auth_hint 透传）");
  ok(fn({ state: "needs_auth" }).startsWith("未登录 · "), "A3 needs_auth 无 hint → 兜底文案仍「未登录 ·」前缀");
  ok(fn({ state: "ready", models: ["a", "b"] }) === "2 个模型" && fn({ state: "ready" }).includes("已就绪"), "A4 ready 语义零改动（回归锚）");
  ok(fn({ state: "unsupported", preflight: { reason: "占位" } }).includes("不支持"), "A5 unsupported 语义零改动（回归锚）");
  ok(fn({ state: "unavailable", preflight: { reason: "CLI 未装" } }).includes("不可用"), "A6 unavailable 语义零改动（回归锚）");
}

// ---- B. 引擎菜单分组（openEngineMenu：needs_auth 单列组+灰置+黄点） ----
{
  const src = blockFrom("function openEngineMenu(anchor) {");
  ok(src.length > 0, "B1 openEngineMenu 在场");
  ok(src.includes('filter((e) => e.state !== "ready" && e.state !== "needs_auth")'), "B2 不可用组剔除 needs_auth（单列不混组）");
  ok(src.includes('filter((e) => e.state === "needs_auth")'), "B3 needs_auth 独立分组在场");
  ok(src.includes("未登录 · ") && src.includes("aria-disabled"), "B4 组头「未登录」+灰置不可点（div 非 button——不可选但可见指引）");
  ok(src.includes("e.auth_hint"), "B5 灰置行 title/小字透出 auth_hint（hover 指引）");
}

// ---- C. 设置·模型服务区（provLive：黄点 tag 未登录+hint 文案） ----
{
  const i = html.indexOf("provLive.innerHTML = catalog.map((e) => {");
  ok(i > 0, "C1 provider 区渲染体在场（provLive catalog map）");
  const seg = html.slice(i, i + 2200);
  ok(seg.includes('e.state === "needs_auth"'), "C2 设置区 needs_auth 分支在场");
  ok(seg.includes("tag authn") && seg.includes("未登录"), "C3 未登录 tag（authn 黄色系）");
  ok(seg.includes("eng-auth-dot"), "C4 行内黄点（eng-auth-dot）");
  ok(seg.includes("e.auth_hint"), "C5 copy/title 显示 auth_hint 登录指引");
}

// ---- D. 状态点 CSS（黄=--working 三处） ----
{
  ok(html.includes(".engine-picker .ep-dot.warn { background: var(--working); }"), "D1 胶囊黄点 CSS（needs_auth）");
  ok(html.includes(".source-option .ep-dot"), "D2 菜单行内 dot CSS");
  ok(html.includes(".tag.authn"), "D3 未登录 tag CSS");
}

// ---- E. 会话运行时兜底显示链（MERGE_KEYS/SESSION_ERROR/详情指引行） ----
{
  ok(/MERGE_KEYS = \[[^\]]*"auth_hint"\]/.test(html), "E1 MERGE_KEYS 收容 auth_hint（UPDATE 增量合并白名单——null 清除语义）");
  const onErr = blockFrom("function onErrorEvt(sid, p) {");
  ok(onErr.includes("p.auth_hint"), "E2 onErrorEvt 存 SESSION_ERROR 帧 auth_hint");
  ok(html.includes('s.status === "ERROR" && s.auth_hint') && html.includes("🔑"), "E3 详情面板 ERROR 态附登录指引行（🔑 前缀区别 ⚠ 错误行）");
}

// ---- F. 创建链拦截提示（本地 menu 拦截 + ACK fail-fast 双保险） ----
{
  const submit = blockFrom("function submitCreate() {");
  ok(submit.includes('entry.state === "needs_auth"') && submit.includes("引擎未登录："), "F1 submitCreate 本地拦截 toast 带指引（引擎未登录：+hint）");
  ok(submit.includes("ack.needs_auth") && submit.includes("未创建会话"), "F2 ACK fail-fast 拒绝分支显示可操作指引（relay 侧拦截回执）");
  ok(html.includes("b2Toast(msg, ms)"), "F3 b2Toast 支持时长参数（指引类 toast 6s 长显——默认 2.4s 读不完命令）");
}

// ---- G. 手机侧目录（mobile settings Agent 引擎区同态） ----
{
  ok(/name === "Agent 引擎"[\s\S]{0,600}e\.state === "needs_auth" \? "未登录"/.test(html), "G1 手机目录 needs_auth → 「未登录」态（与桌面设置区同词表）");
}

// ---- H. 降级链不回归（catalogReadyEngines 剔除 needs_auth 的端侧对应：菜单灰置即不可选） ----
{
  const pick = blockFrom("function pickEngine(btnOrId) {");
  ok(pick.includes('entry.state !== "ready"'), "H1 pickEngine 非 ready 拦截仍在（needs_auth 引擎不可硬选——API 直发也拦）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
