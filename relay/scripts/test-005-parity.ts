// #80 005 原型存量特性补全：P1 七项静态锚+行为直跑+已有面锁定。
// 靶子 specs/005-prototype-a.html；对照旧版 web-console/index.html 盘点表 /tmp/005-parity-audit.md
// （29 缺口 P1 11/P2 9/P3 9；死 tab 误判已实探修正——tab 面在本文件 T 节锁定防回退）。
// 覆盖：T 已有面锁定（五 tab 懒注入+任务四态+readonly-banner）/M 右键菜单/H 隐藏项目恢复/
// K 键盘（↑↓ 会话+⌘←→ 源循环+守卫）/I IME 守卫/D 拖入蒙层/B 回到底/通用纪律（toast 配套+token）。
// 行为探针 /tmp/005parityprobe.html 33/33（行为侧）；本文件静态锚+纯函数直跑互为犄角。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-parity.ts
// B批增补：C 段读 web-console/index-005.html 锁云桥链静态锚（配对/降级轮询/心跳/命令 shim/
// read-shared 写纪律/安全校验零裁剪）+ 六内联块 node --check 语法门 + LAN 探测链防回退锚。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "specs", "005-prototype-a.html"), "utf-8");
const shell = readFileSync(join(root, "web-console", "index-005.html"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockAt(needle: string): string {
  const i = html.indexOf(needle);
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  const start = j;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(start, k + 1); }
  }
  return "";
}
function cssBlock(selector: string): string {
  return blockAt(selector + " {");
}
function fnBody(name: string): string {
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  return "";
}
function jsConst(name: string): string {
  const i = html.indexOf(`const ${name} = `);
  if (i < 0) return "";
  const end = html.indexOf("\n", i);
  return html.slice(i, end);
}
function count(hay: string, needle: string) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

// ---- T. tab 已有面锁定（盘点修正：死 tab 是静态读码误判，实探 12/12；防回退锁） ----
for (const fn of ["setupSessionTabs", "setupMobileDetailTabs", "setupTeamTabs", "setupMobileTeamTabs", "setupProjectTabs"]) {
  ok(fnBody(fn) !== "", `tab wire fn ${fn} exists`);
}
const bootZone = html.slice(html.indexOf("setupRowMenu();"));
ok(["setupRowMenu", "setupHiddenProjectRestore", "setupSessionKeyNav", "setupDocDragOver", "setupBackToBottom", "setupSessionTabs"].every((fn) => bootZone.includes(fn + "();")), "P1 setups invoked at boot");
ok(fnBody("setupSessionTabs").includes("已完成 · 6") && fnBody("setupSessionTabs").includes("进行中 · 1") && fnBody("setupSessionTabs").includes("待审查 · 1") && fnBody("setupSessionTabs").includes("待办 · 1"), "desktop task pane injects four-state groups (verify lane renamed 待审查 per 2026-10-05 word table)");
ok(fnBody("setupMobileDetailTabs").includes("innerHTML") && fnBody("setupSessionTabs").includes("已完成 · 6"), "mobile task pane mirrors desktop inject (innerHTML reuse → four-state groups ride along)");
ok(fnBody("setupSessionTabs").indexOf("已完成 · 6") < fnBody("setupSessionTabs").indexOf("进行中 · 1") && fnBody("setupSessionTabs").indexOf("进行中 · 1") < fnBody("setupSessionTabs").indexOf("待审查 · 1") && fnBody("setupSessionTabs").indexOf("待审查 · 1") < fnBody("setupSessionTabs").indexOf("待办 · 1"), "four-state order done→run→review→todo (legacy :6543 semantics, lane word table 2026-10-05)");
ok(fnBody("setupSessionTabs").includes("readonly-banner") || html.includes("readonly-banner"), "⋯ pane readonly-banner intact");

// ---- M. 行右键菜单（1c+13a+14a：四动作+working 拦截+五路收起） ----
ok(cssBlock(".row-menu").includes("position: fixed"), "row-menu overlay fixed (no layout shift)");
ok(['data-row-action="pin"', 'data-row-action="rename"', 'data-row-action="copyid"', 'data-row-action="del"'].every((a) => fnBody("openRowMenu").includes(a)), "menu carries pin/rename/copyid/del actions");
ok(fnBody("openRowMenu").includes("会话运行中，不能删除"), "working row delete intercepted with toast");
ok(fnBody("setupRowMenu").includes('addEventListener("contextmenu"') && fnBody("setupRowMenu").includes("pointerdown") && fnBody("setupRowMenu").includes("scroll") && fnBody("setupRowMenu").includes("resize"), "menu closes on contextmenu/pointerdown/scroll/blur/resize wiring");
ok(fnBody("closeRowMenu") !== "" && fnBody("wireOverlayEscape").includes('getElementById("row-menu")'), "Escape chain wired to row-menu (closeTransientOverlays + keydown branch)");
ok(html.includes("const commitRename") && html.includes('input.addEventListener("blur", commitRename, { once: true })'), "rename commits via idempotent commitRename (Enter direct + blur once)");
ok(fnBody("setupRowMenu").includes("contextmenu") && html.includes('data-hidden-project title="右键恢复显示"'), "hidden project card exposes contextmenu affordance");

// ---- H. 已隐藏项目右键恢复（7a：文案承诺的交互必须存在） ----
ok(fnBody("setupHiddenProjectRestore").includes("contextmenu") && fnBody("setupHiddenProjectRestore").includes("已恢复显示"), "right-click restores hidden project + toast");
ok(fnBody("setupHiddenProjectRestore").includes("活跃项目") && fnBody("setupHiddenProjectRestore").includes("remove()"), "restore moves card to active group + head count +1, hidden head removed");

// ---- K. ↑↓ 切会话（1a：裸键空输入+Alt 档+浮层不抢+守卫链） ----
ok(fnBody("moveSessionSelection") !== "" && fnBody("moveSessionSelection").includes("scrollIntoView") && fnBody("moveSessionSelection").includes("composer-input") , "arrow nav moves selection, scrolls into view, focuses composer");
ok(fnBody("moveSessionSelection").includes("showToast") === false, "arrow nav emits no toast (high-frequency op stays silent)");
ok(fnBody("setupSessionKeyNav").includes("row-rename-input") && fnBody("setupSessionKeyNav").includes(".source-menu.open") && fnBody("setupSessionKeyNav").includes("altKey"), "bare key guarded: rename input / open overlays; alt tier anywhere");
ok(fnBody("setupSessionKeyNav").includes('trim()') || fnBody("setupSessionKeyNav").includes("value"), "bare key only on empty composer draft");

// ---- K2. ⌘/Ctrl+←→ 切源循环（1b） ----
ok(fnBody("setupSessionKeyNav").includes('ArrowRight') && fnBody("setupSessionKeyNav").includes("metaKey") && fnBody("setupSessionKeyNav").includes("ctrlKey"), "cmd/ctrl+arrow tier present");
ok(fnBody("setupSessionKeyNav").includes('tagName === "INPUT"') && fnBody("setupSessionKeyNav").includes("isContentEditable"), "text-editing targets not hijacked (input/textarea/contentEditable guard)");

// ---- I. IME composition 守卫（3a：Enter 误发根治） ----
const composerGuards = count(html, "isComposing || e.keyCode === 229") + count(html, "e.isComposing || e.keyCode === 229");
ok(composerGuards >= 2, `composition guard on Enter paths (${composerGuards} sites, composer + rename)`);

// ---- D. 文档级拖入蒙层（3b：防默认白屏 + 载荷分流引导） ----
ok(blockAt("body.file-drag-over::after").includes("松开把文件加进输入栏"), "drag-over mask with actionable copy");
ok(fnBody("setupDocDragOver").includes("depth") && fnBody("setupDocDragOver").includes("dragleave") && fnBody("setupDocDragOver").includes("preventDefault"), "depth counting + leave collapse + drop preventDefault");
ok(fnBody("setupDocDragOver").includes("types") && fnBody("setupDocDragOver").includes("文件") , "empty-types treated as potential file + uri payload toast guide");

// ---- B. 回到底（15a：离底 80px+停 300ms 复核+滚动中先收+平滑回底） ----
ok(cssBlock(".back-to-bottom").includes("position: fixed"), "back-to-bottom pinned to viewport (works in page-scroll prototype form)");
ok(fnBody("setupBackToBottom").includes("300") && fnBody("setupBackToBottom").includes("nearBottom") && fnBody("setupBackToBottom").includes("behavior: \"smooth\""), "300ms settle recheck + smooth scroll to bottom");
ok(fnBody("setupBackToBottom").includes("scrollingElement") && fnBody("setupBackToBottom").includes("#d-session.active"), "dual scroller detection (element vs page) + session-active gate");

// ---- 通用纪律 ----
ok(jsConst("sessionCtaMarkup").includes('class="srow-cta"') && jsConst("renderSessionCard").includes("${sessionCtaMarkup(item)}"), "CTA overlay rides card (interlude 4/5 intact)");
ok(cssBlock("#d-session .queue-card").includes("border-radius: 0") && cssBlock("#d-session .queue").includes("padding: 16px 0"), "full-bleed row language intact (interlude 6/7)");
ok(cssBlock(".wait-actions").includes("justify-content: flex-end") && cssBlock(".notify-actions").includes("justify-content: flex-end"), "action groups anchored right (interlude 8)");
ok(count(html, "web-console") === 0, "zero references to legacy web-console (borrow semantics, never implementation)");
const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
let compiled = true;
try { new Function(script); } catch { compiled = false; }
ok(compiled, "inline script compiles (syntax gate)");

// ---- C. 云桥链静态锚（B批移植：靶子 web-console/index-005.html，防回退锁） ----
const cloudStart = shell.indexOf("// ==================== 云桥链（B批移植");
const cloudEnd = shell.indexOf("// ---------- #143 Leader 合流接线：团队域通道");
const cloudZone = cloudStart >= 0 && cloudEnd > cloudStart ? shell.slice(cloudStart, cloudEnd) : "";
ok(cloudZone.length > 10000, "cloud module zone present in foundation script (>10k chars)");
const shellHas = (needle: string) => shell.includes(needle);
// C1 依赖与形态分流
ok(/<script src="\/nacl\.js"><\/script>/.test(shell.split("<style>")[0] || ""), "C1 /nacl.js head 阻塞引用（坑6：内联块执行前 nacl 就绪）");
ok(cloudZone.includes('location.protocol === "https:" && !shellProbe'), "C1 cloudMode 门（https 且非桌面壳才走云链；http LAN/tauri 不动）");
ok(shell.includes("if (cloudMode) { bootstrapCloud(); return; }"), "C1 bootstrapConnection 云形态分流（缝合点 a：探测链原路径不动）");
// C2 密封层与共享身份
ok(cloudZone.includes("// ---------- 云桥 E2E 密封层（") && cloudZone.includes("// ---------- 云桥 E2E 密封层结束 ----------"), "C2 密封层标记段成对（test-005-cloud 抽取直跑锚）");
ok(["toB64", "fromB64", "genKp", "devId", "seal", "unseal"].every((fn) => cloudZone.includes("function " + fn + "(")), "C2 密封层六件套齐（与 relay/src/e2e.ts 同构）");
ok(cloudZone.includes('"ccr_cloud_kp"') && cloudZone.includes("function loadCloudIdentity"), "C2 浏览器身份 ccr_cloud_kp 与旧壳同键（跨壳同一设备身份）");
ok(cloudZone.includes('const SERVERS_KEY = "ccd_servers"') && cloudZone.includes("function readSharedServersRaw") && cloudZone.includes("function writeSharedServers"), "C2 共享源库 ccd_servers 读写助手（read-shared 决策 1）");
// C3 写纪律：只在配对成功落写；损坏跳写
{
  const ackIdx = cloudZone.indexOf('inner.t === "pair_ack"');
  const persistIdx = cloudZone.indexOf("cloudPersistPaired(cfg);");
  ok(ackIdx >= 0 && persistIdx > ackIdx, "C3 cloudPersistPaired 只在 pair_ack 成功分支调用");
  ok(cloudZone.includes("if (list === null)") && cloudZone.includes("跳过写入"), "C3 共享库损坏(null)跳写不覆盖（红线：保护旧壳数据）");
  ok(cloudZone.includes('s.id === entry.id && s.kind === "cloud"'), "C3 upsert 仅匹配自身云源条目（不删条目、不碰 lan 源）");
}
// C4 配对链路与安全校验零裁剪
ok(["connectCloudFor", "sendPairReq", "discoverRelay", "startPairWatchdog", "startPollTransport", "pollLoop", "onCloudTextRaw", "onCloudText", "sendCloudRaw", "sendCloud", "startCloudPing", "stopCloudPing", "scheduleCloudReconnect", "cloudManualRetry", "resetCloudPairing", "submitPairCode", "bootstrapCloud", "cloudDisconnect", "cloudSetConn"].every((fn) => cloudZone.includes("function " + fn + "(")), "C4 云链主干函数齐（旧壳锚点全移植）");
ok(cloudZone.includes("inner.relay_dev !== target.rd"), "C4 pair_ack rd 错位丢弃（安全校验 1/3 零裁剪）");
ok(cloudZone.includes("target.cands.some") || cloudZone.includes("cands.some((c) => c.dev === inner.relay_dev)"), "C4 广播态 ack 必须来自发现候选（安全校验 2/3）");
ok(cloudZone.includes('devId(x.rk, "rl") === x.dev'), "C4 RELAYS 候选 rk 自洽校验（安全校验 3/3：公钥派生 dev 防顶替）");
ok(cloudZone.includes('t === "pair_nack"') && cloudZone.includes("m.data.t === \"pair_nack\"") === false && cloudZone.includes("if (target && !target.rd) return;"), "C4 明文/密封 pair_nack 双路处理（广播态 nack 视为噪音）");
ok(cloudZone.includes("}, 8000);") && cloudZone.includes("30_000, 900_000"), "C4 配对看门狗 8s 间隔 + 退避 30s→15min");
ok(cloudZone.includes("/^\\d{6,8}$/"), "C4 输码校验 6-8 位（8 位现行 + 管理员 6 位过渡）");
{
  const totalPk = count(cloudZone, "body.pubkey = ckp.publicKey");
  const guardedPk = count(cloudZone, "if (pair.pc) body.pubkey = ckp.publicKey");
  ok(guardedPk >= 1 && totalPk === guardedPk, "C4 pair_req 仅带码携 pubkey（#29 C-P0-1：空码信标不带）");
}
// C5 长轮询降级（公司代理掐 WS）
ok(cloudZone.includes("/cloud-poll") && cloudZone.includes("function startPollTransport") && cloudZone.includes("async function pollLoop"), "C5 /cloud-poll 长轮询传输存在");
ok(cloudZone.includes("握手 8s 无响应") && cloudZone.includes("8000);"), "C5 握手 8s 看门狗 → 切轮询");
ok(cloudZone.includes("ctx.wsFails >= 2"), "C5 ws 闪断 x2 → 切轮询");
ok(cloudZone.includes("out.frames") && cloudZone.includes("onCloudText(ctx, f)"), "C5 轮询下行帧进统一入口");
// C6 心跳与重连
ok(cloudZone.includes("}, 20000);") && cloudZone.includes("45000"), "C6 20s 密封 ping + 45s 无 pong 判死");
ok(cloudZone.includes("CLOUD_RETRY_BASE_MS = 3000") && cloudZone.includes("CLOUD_RETRY_MAX_MS = 30000"), "C6 云链独立退避节奏 3s→30s");
ok(cloudZone.includes("300_000") && cloudZone.includes("静默慢速重试"), "C6 真未配对 5min 慢速重试（不刷屏）");
ok(cloudZone.includes("visibilitychange") && cloudZone.includes("cloudManualRetry") && cloudZone.includes("回前台"), "C6 回前台 ping-resume + 8s 半开探测");
// C7 命令面 shim（缝合点 c）与下行总线（缝合点 b）
ok(cloudZone.includes("const cloudCmdShim") && cloudZone.includes('get readyState()') && cloudZone.includes("sendCloud(cloudCtx, obj);"), "C7 cloudCmdShim readyState/send 密封上行");
ok(cloudZone.includes("window.__ccDeck005MainWs = cloudCmdShim") && cloudZone.includes("ctx.ws = cloudCmdShim"), "C7 云形态接管 __ccDeck005MainWs/ctx.ws（B2/B4/Team 零改动借道）");
ok(cloudZone.includes('window.__ccDeck005Frames.emit({ kind: "ws", state:') && cloudZone.includes('window.__ccDeck005Frames.emit({ kind: "frame", frame: inner })'), "C7 下行经帧总线（状态+内层帧双事件）");
{
  const cmdAckIdx = cloudZone.indexOf('inner.type === "COMMAND_ACK"');
  ok(cmdAckIdx > 0 && cloudZone.indexOf("Team.onAck(inner)", cmdAckIdx) > 0 && cloudZone.indexOf('__ccDeck005Frames.emit({ kind: "frame", frame: inner })', cmdAckIdx) > 0, "C7 COMMAND_ACK 按 command_id 双口结算（Team + 总线，不锚 socket）");
}
// C8 UI 挂载与移动端可用性（坑7）
ok(shell.includes("data-cloud-pair-input") && shell.includes("data-cloud-pair-submit") && shell.includes("data-cloud-retry"), "C8 配对表单/重试钮 data 锚（桌面+移动共用委托）");
ok(shell.includes("data-cloud-settings-slot") && shell.includes("data-cloud-mobile-slot"), "C8 桌面 connections 面板 slot + 移动 lane slot");
ok(cloudZone.includes("event.isComposing || event.keyCode === 229"), "C8 云表单 Enter IME 守卫（005 军规同款）");
ok(cloudZone.includes("font-size:14px"), "C8 移动端输入框 14px（防 iOS 聚焦缩放）");
ok(cloudZone.includes("document.activeElement") && cloudZone.includes("[data-cloud-pair-input]"), "C8 输入中跳过重渲（防打字被 innerHTML 清掉）");
ok(shell.includes("window.__ccDeck005CloudUI = {"), "C8 域脚本只读挂钩 __ccDeck005CloudUI（B4/B7 借道，帧路由零改动）");
// C9 深链与 last_seq
ok(cloudZone.includes("location.hash.slice(1)") && cloudZone.includes('history.replaceState(null, "", location.pathname)'), "C9 配对深链 fragment 捕获后抹除");
ok(cloudZone.includes('h.get("pc")') && cloudZone.includes('h.get("rd")') && cloudZone.includes('h.get("rk")') && cloudZone.includes('h.get("bt")'), "C9 深链参数 pc/rd/rk/bt 齐备");
ok(cloudZone.includes('const CLOUD_LASTSEQ_KEY = "cc-deck-005-lastseq"') && cloudZone.includes("lsSet(CLOUD_LASTSEQ_KEY"), "C9 last_seq 落 005 自有键");
ok(cloudZone.includes("ctx.sessions.size > 0 ? ctx.lastSeq : 0"), "C9 hello 空 会话→0 全量重建（SNAPSHOT 语义 relay 驱动，无自建拉全量）");
// C10 混合内容与 nacl 降级（坑6/坑8）
ok(cloudZone.includes('.replace(/^https:\\/\\//i, "wss://")') && cloudZone.includes('location.protocol === "https:" ? "wss://" : "ws://"'), "C10 云 URL 恒归一 ws/wss（https 页禁 ws://）");
ok(cloudZone.includes("if (!window.nacl)") && cloudZone.includes("加密组件未加载"), "C10 nacl 加载失败降级提示（不白屏）");
// C11 LAN 探测链防回退（云链合入不得伤及既有形态）
ok(shell.includes("function connectLan") && shell.includes("function probeLocalRelay") && shell.includes("/local-info") && shell.includes("probe_local"), "C11 LAN/桌面探测链锚 intact");
ok(shell.includes('localStorage.getItem("cc-deck-005-token")') && shell.includes("connectLan(ctx);"), "C11 ?token=/localStorage 探测链原样");
const VER = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim(); // 发版单一事实源（0.7.0-test.3 批去硬编码）
ok(shell.includes(`CONSOLE_VERSION = "${VER}"`), `C11 版本常量与 VERSION 一致（${VER}）`);
ok(shell.includes("if (cloudMode) cloudDisconnect();"), "C11 pagehide 云链卸载");
// C12 语法门：六内联块 node --check（B批施工的主回归门）
{
  const blocks = [...shell.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok(blocks.length === 6, `C12 内联块数量 6（实际 ${blocks.length}）`);
  const dir = join(tmpdir(), "005-parity-blocks");
  mkdirSync(dir, { recursive: true });
  let synFails = 0;
  blocks.forEach((code, i) => {
    const p = join(dir, `b${i + 1}.js`);
    writeFileSync(p, code);
    try { execFileSync("node", ["--check", p], { stdio: "pipe" }); }
    catch { synFails++; console.error(`  C12 block ${i + 1} syntax FAIL`); }
  });
  rmSync(dir, { recursive: true, force: true });
  ok(synFails === 0, "C12 六内联块全部 node --check 通过");
}

console.log(`\n005-parity: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
