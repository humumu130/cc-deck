// follow-up UI 批（1029，件A-K 十一件）断言套件——源码锚 + 语法闸。
// 范式：test-287 源码锚（web-console 是 IIFE 脚本无法 import，行为面走锚+CDP 真机验收单）。
// 断言组：A 待命 gate / B 远程卡删除兜底 / C 引擎下拉品牌化 / D URL 路由 / E 徽章配色 /
//   F 滚动条 / G 状态行 / H 设置页三件 / I 消息去重排序 / J 图钉 / K 团队 chip 三件
// 直跑：env -u CCR_ORG_DIR -u CCR_DATA_DIR npx tsx scripts/test-ui-followup.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const root = join(import.meta.dirname, "..", "..");
const rf = (...p: string[]) => readFileSync(join(root, ...p), "utf-8");
const ssd = rf("web-console", "js", "session-domain.js");
const mj = rf("web-console", "js", "mobile.js");
const bc = rf("web-console", "js", "bridge-core.js");
const st = rf("web-console", "js", "settings-domain.js");
const td = rf("web-console", "js", "team-domain.js");
const css = rf("web-console", "css", "base.css");

console.log("Z0 语法闸（五个触点文件 node --check）：");
for (const f of ["session-domain", "bridge-core", "settings-domain", "mobile", "team-domain"]) {
  const r = spawnSync("node", ["--check", join(root, "web-console", "js", f + ".js")], { encoding: "utf-8" });
  ok(r.status === 0, `Z0-${f} 语法可解析`);
}

console.log("件A 待命徽章 WORKING gate：");
ok(ssd.includes('pmStandby: session.pm_standby === true && status !== "working"'), "A1 桌面 myCardItem：WORKING 干活态不显待命");
ok(mj.includes('(s.pm_standby && s.status !== "WORKING") ? ["待命", "waiting"]'), "A2 移动 stTag：同 gate");

console.log("件B 远程源会话卡删除兜底：");
ok(ssd.includes("isRemoteProjection(s)") && ssd.includes('relay_channel === "cloud"'), "B1 远程投影判定（云通道/源名差异）");
ok(ssd.includes("data-del-hide") && ssd.includes("仅本机隐藏"), "B2 确认浮层含「仅本机隐藏」次级路径");
ok(ssd.includes("源机不在线，删除指令未送达"), "B3 源机离线人话提示");
ok(ssd.includes("源机上的常驻会话不能远程删除（团队锚点）——已改为本机隐藏"), "B4 常驻锚拒删→自动转本机隐藏+人话解释");
ok(ssd.includes("remoteHiddenHas(x.session_id)") && ssd.includes("REMOTE_HIDDEN_KEY"), "B5 列表渲染过滤隐藏卡+持久化键");
ok(st.includes("__ccDeck005RenderHiddenRemote") && st.includes("data-hidden-restore"), "B6 设置页恢复行");

console.log("件C 引擎下拉 engineBadge 品牌体系：");
ok(ssd.includes("const badgeOf = (e) =>") && ssd.includes("brandIcon(e.id)"), "C1 下拉行徽章带品牌图标（ENGINE_BRAND_SVG 同表）");
ok(ssd.includes(">跟随源默认</strong>") && !ssd.includes("自动 · 跟随源默认"), "C2 「自动」徽章与标题词冗余去重");
ok(ssd.includes("未安装 · 需先安装 ") && !ssd.includes("枚举占位未接入编排") && !ssd.includes("不支持 · \"+(("), "C3 不可用文案产品化（给动作不给谜语）");
ok(css.includes("#b2-engine-menu .source-option .so-copy") && css.includes("#b2-engine-menu .source-option.active"), "C4 下拉两行式+选中态对比度 CSS");

console.log("件D 消息流 URL 可开：");
ok(ssd.includes('class="ext-link"') && ssd.includes("data-ext-url"), "D1 linkify/mdInline 产出 ext-link 路由锚");
ok(ssd.includes("ccDeck.openExternal(url)") && ssd.includes('window.open(url, "_blank", "noopener")'), "D2 壳走 open_external / 浏览器 window.open 双路由");
ok(ssd.includes('matchMedia("(pointer: coarse)").matches') && ssd.includes("ev.ctrlKey || ev.metaKey"), "D3 触屏直接点 / 桌面 Ctrl/Cmd+点击修饰键语义");
ok(ssd.includes("⌘点击在浏览器打开"), "D4 hover 提示文案");

console.log("件E 徽章底色自定义：");
ok(bc.includes("__ccDeck005ApplyBadgeColors") && bc.includes("cc-badge-custom-style"), "E1 应用器+动态 style 覆写链");
ok(bc.includes('window.__ccDeck005BadgeColorsKey = "cc-deck-005-badge-colors"') && bc.includes("data-badge-custom"), "E2 存储键+总闸属性");
ok(st.includes('data-settings-live="badge-colors"') && st.includes("data-badge-color-input") && st.includes("data-badge-color-reset"), "E3 设置面配色行（input+重置）");
ok(bc.includes("__ccDeck005BadgeFgOf") && bc.includes("0.2126"), "E4 底色亮度自动配黑/白字（双主题同底色可用）");
ok(st.includes("data-src-slug") && td.includes("data-src-slug") && mj.includes("data-src-slug"), "E5 源徽章 slug 三渲染点接入");

console.log("件F 滚动条统一滚动才显：");
ok(css.includes("@media (pointer: fine)") && css.includes(".scrolling::-webkit-scrollbar-thumb"), "F1 细滚动条 hover/滚动显 CSS（触屏排除）");
ok(bc.includes('document.addEventListener("scroll"') && bc.includes('"scrolling"'), "F2 捕获式滚动监听+300ms 去抖挂类");

console.log("件G 状态行弱化+开关：");
ok(ssd.includes("summaryShort: status === \"working\"") && ssd.includes("function shortSummaryOf"), "G1 正常干活态短语化数据层");
ok(ssd.includes('data-st="\' + item.status') || ssd.includes('" data-st="\' + item.status'), "G2 卡片带 data-st 状态属性（CSS 升格/降焦定位）");
ok(css.includes('html[data-statusline="off"] #d-session .srow-r2 { display: none; }') && css.includes('html[data-statusline="off"] #d-session .queue-card { padding-top: 9px'), "G3 开关关=两行卡+高度收小 CSS");
ok(css.includes('[data-st="error"] .srow-r2 { display: flex; }') && css.includes('[data-st="error"] .srow-r2-t { color: var(--error)'), "G4 异常升格不受开关影响");
ok(st.includes('statusline: "status-line"') && st.includes('data-settings-toggle="statusline"'), "G5 设置开关（默认开，localStorage 持久化）");
ok(mj.includes('data-st="${esc(String(s.status || "").toLowerCase())}"') && css.includes('html[data-statusline="off"] #stage-mobile .mobile-card p'), "G6 移动视图同开关");

console.log("件H 设置页三件：");
ok(st.includes("引擎 = 可用于派单干活的 AI 编程工具（Claude/Codex/Trae…）"), "H0 术语说明行到位");
ok(st.includes("__ccDeck005EngineBrandSvg") && st.includes("brandHtml"), "H1 已接入引擎行带品牌图标（与弹窗同套）");
ok(!st.includes("＋ 添加 provider"), "H2 「添加 provider」死按钮移除");
ok(!st.includes("<h5>系统设计图纸</h5>") && !st.includes('data-settings-live="design"'), "H3 关于页图纸卡+渲染器移除（仅存退役注释）");

console.log("件I 消息去重+时序：");
ok(ssd.includes("ti.length >= 80 && list.some"), "I1 长用户消息内容幂等（≥80 字同内容 skip——relay 新 id 重报兜底）");
ok(ssd.includes("while (at > 0 && Number(list[at - 1].ts) > Number(e.ts)) at--;") && ssd.includes('return "resort"'), "I2 ts 稳定插入（回灌旧帧不再垫底）");
ok(ssd.includes('out === "resort") renderConversation()'), "I3 乱序路径整 pane 重排");

console.log("件J 图钉三处：");
ok(css.includes(".queue-card:has(.srow-pin.on) .srow-r1 { padding-right: 56px; }"), "J1 置顶态时间与图钉拉开间距（r1 预留按钮区）");
ok(css.includes("#d-session .queue-card.selected .srow-pin.on svg { color: var(--dim); }") && css.includes("#d-session .srow-pin.on { opacity: 1; color: var(--dim); }"), "J2 钉住/未钉住统一灰（品牌色+选中白描边退役）");

console.log("件K 团队 chip 三件：");
ok(ssd.includes("else if (UI && S.selected && pmTeamChipOf(S.selected).length) renderHeader()"), "K1 他成员更新也刷 head（计数对齐列表侧）");
ok(!ssd.includes('<i class="tc-dot"') && !css.includes("animation: slimPulseKf"), "K2 黄橙小灯移除（markup+动画全退役）");
ok(!css.includes("button.team-chip::after"), "K3 ▸ 微三角移除（hover 态+title 承担可展开语义）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
