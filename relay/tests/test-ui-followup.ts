// follow-up UI 批（1029，件A-K 十一件）断言套件——源码锚 + 语法闸。
// 范式：test-287 源码锚（web-console 是 IIFE 脚本无法 import，行为面走锚+CDP 真机验收单）。
// 断言组：A 待命 gate / B 远程卡删除兜底 / C 引擎下拉品牌化 / D URL 路由 / E 徽章配色 /
//   F 滚动条 / G 状态行 / H 设置页三件 / I 消息去重排序 / J 图钉 / K 团队 chip 三件
// 直跑：env -u CCR_ORG_DIR -u CCR_DATA_DIR npx tsx tests/test-ui-followup.ts
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
const sb = rf("web-console", "js", "session-scrollbar.js");
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
ok(ssd.includes("function engineBadgeInner(cls, label)") && ssd.includes("ENGINE_BRAND_SVG[iconKey]") && ssd.includes('<span class="badge-brand">') && ssd.includes('class="so-copy">'), "C1 下拉行徽章带品牌图标（ENGINE_BRAND_SVG 同表；rebase 裁决：并入 dev engineBadgeInner 单口+件C 两行式 so-copy）");
ok(ssd.includes(">跟随源默认</strong>") && !ssd.includes("自动 · 跟随源默认"), "C2 「自动」徽章与标题词冗余去重");
ok(ssd.includes('return "未接入"') && ssd.includes('return "未安装"') && st.includes('e.state === "unsupported" ? "未接入" : "未安装"') && !ssd.includes("需先安装") && !st.includes("需先安装") && !ssd.includes('return "枚举占位') && !ssd.includes("不支持 · \"+(("), "C3 不可用文案产品化（W-ENGINESLIM 1106 用户令：二字短标双面同口径——session engineStateText 两 return+settings 三元；「需先安装」两文件绝迹；开发术语退役锚不变）");
ok(css.includes("#b2-engine-menu .source-option .so-copy") && css.includes("#b2-engine-menu .source-option.active"), "C4 下拉两行式+选中态对比度 CSS");

console.log("件D 消息流 URL 可开：");
ok(ssd.includes('class="ext-link"') && ssd.includes("data-ext-url"), "D1 linkify/mdInline 产出 ext-link 路由锚");
ok(ssd.includes("ccDeck.openExternal(url)") && ssd.includes('window.open(url, "_blank", "noopener")'), "D2 壳走 open_external / 浏览器 window.open 双路由");
ok(ssd.includes('matchMedia("(pointer: coarse)").matches') && ssd.includes("ev.ctrlKey || ev.metaKey"), "D3 触屏直接点 / 桌面 Ctrl/Cmd+点击修饰键语义");
ok(ssd.includes("⌘点击在浏览器打开"), "D4 hover 提示文案");

console.log("件E 徽章底色自定义（1117 用户令整功能移除）：");
ok(!bc.includes("window.__ccDeck005ApplyBadgeColors =") && !st.includes('data-settings-live="badge-colors"') && !st.includes("data-badge-color-input"), "E1 徽章配色退役负向锚：应用器定义/模板卡/行控件零残留（清理行字面量豁免——removeItem/getElementById 一次性清数据所需）");
ok(st.includes("data-src-slug") && td.includes("data-src-slug") && mj.includes("data-src-slug"), "E5 源徽章 slug 三渲染点接入");

console.log("件F 滚动条统一滚动才显：");
ok(css.includes(".wx-sb") && !css.includes("@media (pointer: fine)"), "F1 滚动才显 CSS（rebase 裁决：件F 全局 ::-webkit-scrollbar 覆写退役——与 dev 1101 微信式滚动条 wx-sb 并存=双滚动条视觉回归，功能由 wx-sb 承载）");
ok(sb.includes("scrolling: false") && sb.includes("is-on") && sb.includes("LINGER_MS"), "F2 滚动监听编排（rebase 裁决：件F bridge-core 全局 scrolling 挂类退役防死代码，三态 hover/scrolling/dragging+停滚 linger 由 session-scrollbar.js wx-sb 承载）");

console.log("件G 状态行弱化+开关：");
ok(ssd.includes("summaryShort: status === \"working\"") && ssd.includes("function shortSummaryOf"), "G1 正常干活态短语化数据层");
ok(ssd.includes('data-st="\' + item.status') || ssd.includes('" data-st="\' + item.status'), "G2 卡片带 data-st 状态属性（CSS 升格/降焦定位）");
ok(css.includes('html[data-statusline="off"] #d-session .srow-r2 { display: none; }') && css.includes('html[data-statusline="off"] #d-session .queue-card { padding-top: 9px'), "G3 开关关=两行卡+高度收小 CSS");
ok(css.includes('[data-st="error"] .srow-r2 { display: flex; }') && css.includes('[data-st="error"] .srow-r2-t { color: var(--error)'), "G4 异常升格不受开关影响");
ok(st.includes('statusline: "status-line"') && st.includes('data-settings-toggle="statusline"'), "G5 设置开关（默认开，localStorage 持久化）");
ok(mj.includes("data-st=") && css.includes('html[data-statusline="off"] #stage-mobile .mobile-card p'), "G6 移动视图同开关（data-st 属性+CSS 开关消费两锚）");

console.log("件H 设置页三件：");
ok(st.includes("引擎 = 可用于派单干活的 AI 编程工具（Claude/Codex/Trae…）"), "H0 术语说明行到位");
ok(st.includes("__ccDeck005EngineMarkHtml"), "H1 已接入引擎行带品牌图标（与弹窗同套；rebase 裁决：统一 dev 现行 __ccDeck005EngineMarkHtml 单口，分支 EngineBrandSvg 直查版退役防双源）");
ok(!st.includes("＋ 添加 provider"), "H2 「添加 provider」死按钮移除");
ok(!st.includes("<h5>系统设计图纸</h5>") && !st.includes('data-settings-live="design"') && st.includes("现行图纸入口=项目域第七 tab"), "H3 关于页图纸卡+渲染器移除（仅存退役注释；rebase 注记：现行图纸入口=项目域第七 tab W-SRCMENU2 ⑥，设置页死卡退役零损失）");

console.log("件I 消息去重+时序：");
ok(ssd.includes("ti.length >= 80 && list.some"), "I1 长用户消息内容幂等（≥80 字同内容 skip——relay 新 id 重报兜底）");
ok(ssd.includes("while (at > 0 && Number(list[at - 1].ts) > Number(e.ts)) at--;") && ssd.includes('return "resort"'), "I2 ts 稳定插入（回灌旧帧不再垫底）");
ok(ssd.includes('out === "resort") renderConversation()'), "I3 乱序路径整 pane 重排");

console.log("件J 图钉三处：");
ok(css.includes("#d-session .srow-pin { position: relative; flex: none; order: 0; margin-left: auto;") && !css.includes(".queue-card:has(.srow-pin.on) .srow-r1 { padding-right: 56px; }") && !css.includes("#d-session .srow-time {flex: none; margin-left: auto;"), "J1 置顶/未置顶时间恒定对齐（1123 二轮实锤：图钉 margin-left:auto 右簇锚定+恒占 18px；:has padding-right:56px 预留与 time margin-left:auto 双退役——旧法置顶行时间左移 56px）");
ok(css.includes("#d-session .queue-card.selected .srow-pin.on svg { color: var(--dim); }") && css.includes("#d-session .srow-pin.on { opacity: 1; color: var(--dim); }"), "J2 钉住/未钉住统一灰（品牌色+选中白描边退役）");

console.log("件K 团队 chip 三件：");
ok(ssd.includes("else if (UI && S.selected && pmTeamChipOf(S.selected).length) renderHeader()"), "K1 他成员更新也刷 head（计数对齐列表侧）");
ok(!ssd.includes('<i class="tc-dot"') && !css.includes("animation: slimPulseKf"), "K2 黄橙小灯移除（markup+动画全退役）");
ok(!css.includes("button.team-chip::after"), "K3 ▸ 微三角移除（hover 态+title 承担可展开语义）");


console.log("件L 值守巡检卡+状态栏前缀（W-UICLEAN2，1110 用户实锤×2）：");
ok(ssd.includes("function dutySummaryOf") && ssd.includes("function dutyCardHtml") && ssd.includes('dutySrc.startsWith("DUTY_RECEIPT ")'), "L1 DUTY_RECEIPT 行首识别→巡检卡（渲染层拦截，协议/转录零改动）");
ok(ssd.includes("一切正常") && ssd.includes('accept: "收单", dispatch: "派单"'), "L2 摘要动词化（none+无受阻=一切正常；动作映射收单/派单/板卡/通知）");
ok(ssd.includes("记录（原文截断）"), "L2b truncate 400 截断兜底（解析失败→记录+原文可见）");
ok(css.includes(".duty-row summary") && css.includes(".duty-row .duty-raw"), "L3 巡检卡样式（居中一行制+原文折叠块）");
ok(!/dockSemanticAction\(act\) \|\| s\.title/.test(ssd) && ssd.includes('dockSemanticAction(act) || "干活中"'), "L4 dock 会话名 fallback 封死（语义空落通用词「干活中」——零会话名铁律）");
{
  const dp = rf("expo-app", "src", "components", "detail-parts.tsx");
  const ds = rf("expo-app", "src", "components", "detail-styles.ts");
  ok(dp.includes("export function dutySummaryOf") && dp.includes('dutySrc.startsWith("DUTY_RECEIPT ")') && dp.includes("🛡 巡检"), "L5 expo 同款拦截卡（detail-parts）+摘要助手导出");
  ok(ds.includes("dutyRow") && ds.includes("dutyRaw"), "L6 expo 巡检卡样式键（对齐 trAuto 视觉）");
}

console.log("件U 1123 test.28 五刀（图钉右簇/聚合源标/桥层打标/项目卡源胶囊/空闲不跳+三功能平铺）：");
{
  const smSrc = rf("relay", "src", "session-manager.ts");
  const idx005 = rf("web-console", "index-005.html");
  ok(smSrc.includes('if (changed || summaryChanged) s.state.updated_at = at ?? Date.now();'), "U1 空闲不跳根修 v3（四现：WORKING 恒洗退役——revive-on-hydrate 同值重报不再刷 updated_at；活跃区排序用 turn_started_at 无消费者）"); ok(css.includes("#d-session .srow-pin { position: relative;"), "U7 图钉误触修（static→relative：共享 ::before 扩区在 static 下锚到 r1=铺满整行点击皆图钉；relative 保留流内恒占位，扩区回归钮自身——1123 四轮 P0）");
  ok(ssd.includes('b2AggViewActive') && ssd.includes('(b2AggViewActive() || item.source !== b2SelfSourceName())'), "U2 聚合视角会话卡全显源标（self 抑制仅单源/主源视角——S.relayName 随末到快照翻转反噬根因）");
  ok(bc.includes('relay_source: snapSrcName') && bc.includes('const snapSrcName'), "U3 桥层会话打 per-session 源名（applySnapshot 按本快照 relay_name——项目页/team 域消费桥缓存有源可显）");
  ok(bc.includes('pageSrcNames.size > 1') && bc.includes('srcCapOf'), "U4 项目卡源胶囊（页级源>1 开门，卡内显自己会话所属源≤3+溢出计数）");
  ok(!idx005.includes('data-head-menu') && idx005.includes('<button type="button" class="conv-mini" data-conv-toggle="proc"') && idx005.includes('<button type="button" class="conv-mini" data-conv-toggle="think"') && idx005.includes('<button type="button" class="conv-mini" data-fzone-toggle'), "U5 会话面板三功能平铺（⚙过程/✦思考/▤工作区 conv-mini 直出，⋯ 溢出菜单退役——1123 用户令不收纳）");
  ok(ssd.includes('s.last_heartbeat_at = Date.now();') && ssd.includes('const u = s.last_heartbeat_at ?? s.updated_at;') && !ssd.includes('s.updated_at = Date.now();\n                  if (p && typeof p.action_summary'), "U6 心跳不洗 updated_at（1123 三现真凶：PM 常驻保活空闲态心跳每拍拉顶空闲区——onHeartbeat 改记专用键，isRealWorking 第二判据换源消费+老快照回落兼容）");
}

console.log("件OU 源离线说谎面治本（t-0b360983，1124 homewin 实锤：缓存在线标识+「发送中」永挂无终态+归因混杂）：");
{
  ok(st.includes("__ccDeck005SourceHealth") && st.includes("downFor: Math.max(0, Date.now() - (c._downAt || Date.now()))") && st.includes('c._downAt = status === "online" ? 0 : (c._downAt || Date.now())') && st.includes("cloudUIOn() ? one(cloudCtx) : null"), "OU1 源健康观测口（地基 setConn/cloudSetConn 双写 _downAt 断连起点账本+lan/cloud 独立读数——「云桥重连中≠本机源死」分流锚）");
  ok(ssd.includes("SRC_STALE_MS = 10000") && ssd.includes("tickSourceStale") && ssd.includes('bn.className = "src-stale-banner"') && ssd.includes('const which = down.length === 2 ? "both"') && ssd.includes("列表为缓存数据，恢复后自动更新"), "OU2 会话卡诚实（秒拍态位投影：断连超 10s 列表顶横幅+data-src-stale——快照明示陈旧，恢复即摘）");
  ok(css.includes(".src-stale-banner") && css.includes("[data-session-list][data-src-dim] .list-upper .queue-card .status-dot { filter: grayscale(1); }") && css.includes(".msg-echo .echo-state .echo-retry") && ssd.includes('else delete list.dataset.srcDim'), "OU3 失联横幅/状态灯降灰/重发钮三态 CSS（审查 P2-C：降灰拆 data-src-dim 专用属性——聚合视角单源死不挂防活源卡误伤；选中卡豁免不降权）");
  ok(ssd.includes("function downTextOfSid") && ssd.includes('return "本机服务未连接"') && ssd.includes('return "云桥通道未连接"') && ssd.includes("markEchoFail(sid, text, why)") && ssd.includes("eq[i].why = why || \"\""), "OU4 发送终态分流（ack 超时按目标源健康判定——目标源离线=fail 带源因，云视角下 mainWsOpen 恒开的 slow 谎报路径封死）");
  ok(ssd.includes("function echoStateHtml") && ssd.includes('data-echo-retry=') && ssd.includes("function retryEcho") && ssd.includes("function dispatchEchoedText") && ssd.includes("sent: _cmdSrc.get(id) != null") && ssd.includes('x.why === whyMatch && !x.sent') && ssd.includes("条未送达消息已自动补发"), "OU5 重发钮+恢复自动补发（审查 P1-1：sent 溯源标——只自动补发从未真发出的 halfconn 受理类，已发出未 ACK 留人工重发；成功才移除+现场健康门）");
  ok(ssd.includes('(x.state === "fail" && x.why) || now - x.ts <') && ssd.includes('b2Toast(why ? why + " · 恢复后自动发送"') && ssd.includes("downTextOfSid(payload.session_id)") && st.includes('c._downAt = c._downAt || Date.now(); // offlineui（刀1）：cloudDisconnect'), "OU6 why-fail 退出时间清扫+受理 toast 分流+云侧直写记账（审查 P1-B/P2-2：源因 fail 只由补发/手动/对账移除永不超窗自删；云桥 cloudDisconnect/connectCloudForInner 直写路径补 _downAt——云侧横幅不缺位）");
}

console.log("件ND 1127 通知钮死钮二现（W-NOTIFYDEAD：origin 活连接兜底+开链悬挂可见+两链全程反馈）：");
{
  const sd = rf("web-console", "js", "settings-domain.js");
  const nj = rf("web-console", "js", "notify.js");
  const openAccBody = bc.slice(bc.indexOf("openAcceptance(id)"), bc.indexOf("openAcceptance(id)") + 1400);
  ok(sd.includes("window.__ccDeck005MainWs && window.__ccDeck005MainWs.url"), "ND1 HttpOrigin 活连接兜底（cfg.wsUrl 空窗不再回落死源 tauri.localhost——1127「打开验收单」死钮主因：file/tauri 源协议过检+openExternal 假成功+零 toast）");
  ok(sd.includes('"open-timeout"') && sd.includes("6000"), "ND2 openExternal 悬挂竞速 6s（WebView2 IPC 永不结算形态可观测：超时 toast+复制兜底——#268 Canceled 前科族）");
  ok(openAccBody.includes("return window.__ccDeck005OpenUrl(url)") && !openAccBody.includes("void window.__ccDeck005OpenUrl"), "ND3 openAcceptance void→return（Promise 不再被吞——调用方可观测成功/失败）");
  ok(nj.includes("function openAcceptanceObserved") && nj.includes("已打开验收单链接") && nj.includes("打开验收单失败(异步)"), "ND4 验收钮全程可见（成功 toast+异步失败 catch——resolve 静默曾=用户侧「无反应」）");
  const fsBody = nj.slice(nj.indexOf("function focusSource"), nj.indexOf("function focusSource") + 1600);
  ok(fsBody.includes("catch (e)") && fsBody.includes("跳转失败：") && fsBody.includes("// 面板不收"), "ND5 focusSource 全程防线（railJump/clickTab 抛→失败 toast+面板保持可重试——PM 线索③坐实形态）");
  const toastBody = bc.slice(bc.indexOf("const toast = (() =>"), bc.indexOf("const toast = (() =>") + 1200);
  ok(toastBody.includes('node.id = "toast"') && toastBody.includes('createElement("div")'), "ND6 bridge.toast 节点兜底（#toast 缺席不再静默 return——W-NOTIFYFIX「任何降级必须可见」补齐到桥面）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
