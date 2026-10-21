// W-AUTOMSG #194 web 半结构断言：isAutoInjected 标记表直跑 + entryHtml 折叠分支锚 +
// am-head 展开链接线。范式=test-005-servers.ts（静态锚 + blockFrom 提取直跑）。
//
// 直跑：cd relay && env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-automsg-web.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
const autoTs = readFileSync(join(root, "expo-app", "src", "auto-msg.ts"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string): string {
  const i = js.indexOf(needle);
  if (i < 0) return "";
  const j = js.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < js.length; k++) {
    if (js[k] === "{") depth++;
    else if (js[k] === "}") { depth--; if (depth === 0) return js.slice(i, k + 1); }
  }
  return "";
}

console.log("== W-AUTOMSG web: 标记表 + 折叠分支 + 展开链 ==");

// ---- A. isAutoInjected 直跑（web 内联副本） ----
console.log("-- A. isAutoInjected（web 副本直跑） --");
{
  const fn = eval("(function(){ " + js.slice(js.indexOf("const AUTO_MSG_PREFIXES"), js.indexOf(";", js.indexOf("const AUTO_MSG_PREFIXES")) + 1) + " " + blockFrom("function isAutoInjected(text)") + " return isAutoInjected; })()");
  ok(fn("【cc-deck 巡检轮】①查在办 worker ②…") === true, "A1 任务书给定前缀命中（cron 巡检）");
  ok(fn("[值守喂活] feed=abc 触发=turn_end…") === true, "A2 值守喂活前缀命中（relay 固定格式）");
  ok(fn("  【cc-deck 巡检轮】前导空白容忍") === true, "A3 前导空白容忍");
  ok(fn("普通用户消息") === false, "A4 普通消息不误折叠");
  ok(fn("[值守喂活]") === true, "A5 前缀即全文（无余文）也命中");
  ok(fn("") === false, "A6 空串不崩不误报");
  ok(fn("[值守] 半截前缀不命中（防误伤相似文案）") === false, "A7 相似但不完整的前缀不命中");
}

// ---- B. entryHtml 折叠分支锚 ----
console.log("-- B. entryHtml 折叠分支 --");
{
  const branch = js.slice(js.indexOf("W-AUTOMSG #194：自动注入消息"), js.indexOf("W-AUTOMSG #194：自动注入消息") + 1500); /* 追加件注释增长，窗口 1000→1500 */
  ok(branch.includes("isAutoInjected(src)"), "B1 user 分支头部先判 isAutoInjected（命中走折叠，未命中原气泡路径零变）");
  ok(branch.includes("⏱ 定时巡检") && branch.includes("fmtHM(e.ts)"), "B2 一行小灰字「⏱ 定时巡检 · HH:MM」（时间取消息时间戳）");
  ok(branch.includes('class="am-head" data-x=') || branch.includes("am-head"), "B3 折叠头 am-head 带 data-x（展开链键）");
  ok(branch.includes("open ?") && branch.includes("esc(src)"), "B4 open 才渲染原文 esc(src)（默认收起）");
  ok(!branch.includes("bubble me"), "B5 命中分支不渲染用户气泡（.bubble.me 零出现）");
  ok(/style="[^"]*color:var\(--faint\)/.test(branch), "B6 样式全 inline 用既有 token（不碰样式类文件——wxstyle 零冲突）");
}

// ---- C. 展开链接线 ----
console.log("-- C. 展开链 --");
ok(js.includes('.x-full[data-x], .th-head[data-x], .am-head[data-x]'), "C1 am-head 并入 expanded 切换委托链（复用 th-head 同链）");

// ---- D. 双端同表一致性 ----
console.log("-- D. 双端同表 --");
{
  const webList = js.slice(js.indexOf("const AUTO_MSG_PREFIXES"), js.indexOf("];", js.indexOf("const AUTO_MSG_PREFIXES")) + 1);
  const ai = autoTs.indexOf("AUTO_MSG_PREFIXES: readonly string[] = [");
  const expoList = ai >= 0 ? autoTs.slice(ai, autoTs.indexOf("];", ai) + 1) : "";
  const webItems = [...webList.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const expoItems = [...expoList.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  ok(webItems.length >= 2 && JSON.stringify(webItems) === JSON.stringify(expoItems), `D1 web/expo 前缀表逐项一致（${webItems.length} 项：${webItems.join(" / ")}）`);
  ok(autoTs.includes("【cc-deck 巡检轮】") && autoTs.includes("[值守喂活]"), "D2 expo 常量件含两前缀");
}

// ---- E. 零波及面 ----
console.log("-- E. 零波及 --");
ok(!js.slice(js.indexOf("W-AUTOMSG #194：自动注入消息") + 1000, js.indexOf("W-AUTOMSG #194：自动注入消息") + 2200).includes("automsg"), "E1 折叠分支后紧跟原用户气泡路径（未命中零改动）");
ok(!/th-head[^{]*\{[^}]*display/.test(js), "E2 未动 th-head 样式类（wxstyle 并行面）");

// ---- F. 居中系统提示形态（Leader 追加件：微信时间戳行视觉） ----
console.log("-- F. 完全居中形态 --");
{
  const branch2 = js.slice(js.indexOf("居中精修"), js.indexOf("居中精修") + 900);
  ok(branch2.includes("text-align:center"), "F1 容器水平居中（不占左右对齐位）");
  ok(branch2.includes("max-width:85%"), "F2 展开块限宽 85%（居中弱化块）");
  ok(!/background|border(?!-radius)/.test(branch2), "F3 无底色无边框（系统提示形态非气泡）");
  ok(branch2.includes("var(--dim)") && branch2.includes("var(--faint)"), "F4 收起 faint/展开 dim 双档弱化");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
