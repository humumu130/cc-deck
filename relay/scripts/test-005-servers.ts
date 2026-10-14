// #005-SDEL 服务器条目列表管理（用户 1013 反馈：删掉失效服务器条目重连——旧壳 deleteServer 移植）：
// 静态锚 + 纯函数直跑 + 结构闸（test-005-ui-rows.ts 同范式）。
// 靶子 web-console/index-005.html（现役新壳，feat/1010-audit-fixbatch 线起）。
//
// 旧壳/新壳行为对照（移植口径备案）：
// - 旧壳 index.html deleteServer：confirm→servers filter→saveServers（localStorage+sessionStorage
//   双写）→disconnectCtx→setPendingPair(null)→activeServerId 回退 servers[0]→closeDetail→重渲。
// - 新壳 W-SDEL deleteCloudServer：共享库 ccd_servers filter（writeSharedServers 双写同键）→
//   setPendingPair(null)→当前源 cloudDisconnect（掐 6 定时器+ws）→内存 cfg 重置/回退下一条
//   paired 并 bootstrapCloud 重连；删空回 local 视角+空模板 cfg（防 cloudManualRetry/
//   visibilitychange 拉回已删地址）→replaySnapshots/renderSessionList/renderCloudUI/
//   refreshSourceSwitchers 全链重渲。LAN 本机源不在共享库（新壳本机=probe 单例），不受影响。
// - 活跃源（在线/连接中）删除=二次确认（明示断连）；离线死条目直接删（用户主路径不设卡）。
// - 编辑=旧壳 saveSrvBtn 编辑分支：地址未变保配对身份；地址变更=换桥重置配对；改连接字段即重连。
//
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-servers.ts
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
// 平衡花括号提取（blockAt 范式）：从锚串（function 开头）起整函数到配对 } 止——含参数列表，
// eval 时 "(" + src + ")" 转函数表达式直跑
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

console.log("== #005-SDEL servers: 共享库 CRUD + 删除防拉回 + 列表管理 ==");
console.log("-- A. 静态锚：CRUD 函数与删除链 --");

// A1 CRUD 函数齐（W-SDEL 段八函数）
const SDEL_FNS = ["sdelRemoveFromList", "sdelPatchEntry", "sharedCloudEntryOf", "removeSharedCloudServer", "updateSharedCloudServer", "deleteCloudServer", "activateCloudServer", "openEditServerUI"];
ok(SDEL_FNS.every((fn) => html.includes("function " + fn + "(")), "A1 W-SDEL CRUD 函数齐（8 个）");
ok(html.includes("W-SDEL 服务器条目管理"), "A1 W-SDEL 段标记在场（注释锚）");

// A2 删除链核心序列：库删 → 配对挂起清 → 当前源断链 → 回退重连/删空回本机
ok(html.includes("function deleteCloudServer(id) {"), "A2 deleteCloudServer 入口签名");
{
  const body = blockFrom("function deleteCloudServer(id) {");
  ok(body.includes("removeSharedCloudServer(id)"), "A2 删除走共享库移除（不直写 localStorage）");
  ok(body.includes("setPendingPair(id, null)"), "A2 配对挂起一并清（旧壳 deleteServer 同口径）");
  ok(body.includes("cloudDisconnect()"), "A2 当前源删除先断链（掐 pollGen/pairTimer/ping/reconnect/hs/disc 全套）");
  ok(body.includes("cloudCtx.sessions.clear()"), "A2 会话缓存清空");
  ok(body.includes("bootstrapCloud()"), "A2 回退下一条已配对源自动重连（旧壳回退 servers[0] 同语义）");
  ok(body.includes('localStorage.removeItem(ACTIVE_CLOUD_KEY)'), "A2 删空清 ACTIVE_CLOUD_KEY");
  ok(body.includes('cloudCtx.cfg = { id: cloudUuid(), name: "云桥", kind: "cloud", wsUrl: ""'), "A2 删空落空模板 cfg（防拉回已删地址的内存锚）");
  ok(body.includes('setSourceNameOverride(relayName, "")'), "A2 在线源删除清改名 override");
  ok(body.includes("replaySnapshots(); renderSessionList(); renderCloudUI(); refreshSourceSwitchers();"), "A2 删除后全链重渲");
  const iDisc = body.indexOf("cloudDisconnect()");
  const iCfg = body.indexOf("cloudCtx.cfg = { id: cloudUuid()");
  ok(iDisc >= 0 && iCfg > iDisc, "A2 断链在 cfg 重置之前（relayName/override 先取后断）");
}

// A3 活跃源二次确认门 + 离线直接删
{
  const body = blockFrom("function deleteCloudServerUI(entry) {");
  ok(body.includes('cloudCtx.status === "online" || cloudCtx.status === "connecting"'), "A3 live 判定=当前源且在线/连接中");
  ok(body.includes("confirm(") && body.includes("删除将断开连接"), "A3 活跃源删除二次确认（明示断连影响）");
  ok(!body.replace(/if \(live[^\n]*\n/, "").includes("confirm("), "A3 离线死条目无确认卡（直接删——用户主路径）");
}

// A4 拉活链防复活：cloudPersistPaired「绝不删条目」纪律未破（删除走独立 remove 函数）
{
  const i = html.indexOf("function cloudPersistPaired");
  ok(i >= 0 && html.slice(Math.max(0, i - 300), i + 100).includes("绝不删条目"), "A4 cloudPersistPaired 纪律注释保持（配对落写仍不删条目）");
}

console.log("-- B. 纯函数直跑：sdelRemoveFromList / sdelPatchEntry --");

// B1 sdelRemoveFromList 直跑（eval 完整函数源码转表达式；无 DOM 依赖）
{
  const src = "(" + blockFrom("function sdelRemoveFromList") + ")";
  const fn = eval(src) as (list: unknown[], id: string) => unknown[];
  const c1 = { id: "c1", kind: "cloud", wsUrl: "wss://a/cloud" };
  const c2 = { id: "c2", kind: "cloud", wsUrl: "wss://b/cloud" };
  const l1 = { id: "l1", kind: "lan", wsUrl: "ws://x:8787/ws" };
  const out1 = fn([c1, c2, l1], "c1");
  ok(out1.length === 2 && out1[0] === c2 && out1[1] === l1, "B1 删指定 cloud 条目，其余原样保留（lan 不碰）");
  const out2 = fn([c1, c2], "nope");
  ok(out2.length === 2, "B1 删不存在 id 幂等（列表不变）");
  const out3 = fn([c1, c2, l1], "l1");
  ok(out3.length === 3, "B1 lan 条目不可经此删（kind 过滤只对 cloud 生效）");
  const out4 = fn([], "c1");
  ok(Array.isArray(out4) && out4.length === 0, "B1 空列表安全");
}

// B2 sdelPatchEntry 直跑（eval 多行函数体；BAKED_RELAY 注入）
{
  let ranBaked = false;
  const BAKED_RELAY = { get rd() { ranBaked = true; return "rd-baked"; }, rk: "rk-baked" };
  const src = "(" + blockFrom("function sdelPatchEntry") + ")";
  const fn = eval(src) as (cur: Record<string, unknown>, patch: Record<string, unknown>) => { entry: Record<string, unknown>; addrChanged: boolean };
  const cur = { id: "c1", name: "家里 Mac", kind: "cloud", wsUrl: "wss://old/cloud", token: "t1",
    cloud: { url: "wss://old/cloud", token: "t1", rd: "rd-live", rk: "rk-live", paired: true } };
  // 改名：保配对身份
  const r1 = fn(cur, { name: "家里 Mac2" });
  ok(r1.entry.name === "家里 Mac2" && r1.addrChanged === false, "B2 改名不触发地址变更位");
  ok((r1.entry.cloud as Record<string, unknown>).paired === true && (r1.entry.cloud as Record<string, unknown>).rd === "rd-live", "B2 地址未变保 rd/rk/paired（旧壳编辑分支同语义）");
  // 改地址：重置配对
  const r2 = fn(cur, { name: "家里 Mac", wsUrl: "wss://new/cloud" });
  ok(r2.addrChanged === true, "B2 地址变更置位");
  const c2 = r2.entry.cloud as Record<string, unknown>;
  ok(c2.paired === false && c2.rd === "rd-baked" && c2.rk === "rk-baked", "B2 换桥重置配对身份回落烘焙值（需重新输码）");
  ok(ranBaked, "B2 烘焙值真实取自 BAKED_RELAY（非硬编码）");
  ok(r2.entry.wsUrl === "wss://new/cloud", "B2 新地址写入条目");
  // 改 token：不动配对
  const r3 = fn(cur, { token: "t2" });
  const c3 = r3.entry.cloud as Record<string, unknown>;
  ok(r3.entry.token === "t2" && c3.paired === true && c3.token === "t2", "B2 令牌更新不触发配对重置");
  // 空名回落
  const r4 = fn({ id: "c9", kind: "cloud", wsUrl: "wss://x/cloud", cloud: null }, { name: "  " });
  ok(r4.entry.name === "云桥", "B2 空名回落默认「云桥」");
  // 尾斜杠归一
  const r5 = fn(cur, { wsUrl: "wss://old/cloud/" });
  ok(r5.addrChanged === false && r5.entry.wsUrl === "wss://old/cloud", "B2 尾斜杠归一不计地址变更（submitAddServer 同口径）");
}

console.log("-- C. UI 列表化与三锚委托 --");

// C1 列表化：共享库逐条渲染（map 循环）+ 每行三动作
{
  const body = blockFrom("function sdelServerRows(mobile) {");
  ok(body.includes("cloudSharedCloudServers()") && body.includes(".map("), "C1 列表=共享库逐条 map 渲染（不再单条云桥行焊死）");
  ok(body.includes('data-srv-connect="'), "C1 非当前行「连接」钮（切换连接入口）");
  ok(body.includes('data-srv-delete="'), "C1 每行 ✕ 删除钮");
  ok(body.includes('data-srv-edit="'), "C1 每行 ✎ 编辑钮");
  ok(body.includes("cloudRetryBtn()"), "C1 当前行保留重试钮（data-cloud-retry 既有锚）");
  ok(body.includes("mobile") && body.includes("mobile-task"), "C1 移动 lane 复用同构行（两壳共一套 data 锚）");
}

// C2 cloudSettingsRows：空列表引导 + 多条时添加行恒显 + 非云形态也列条目
{
  const body = blockFrom("function cloudSettingsRows() {");
  ok(body.includes("cloudSharedCloudServers()"), "C2 设置域读共享库全量条目");
  ok(body.includes("sdelServerRows(false)"), "C2 桌面行走 sdelServerRows");
  ok(!body.includes("if (!cloudUIOn()) {\n          return"), "C2 非云形态不再提前 return（死条目清理不依赖云链激活态）");
  ok(body.includes("data-settings-add"), "C2 添加入口恒显（多条时可继续加）");
  ok(body.includes("data-cloud-pair-input") && body.includes("data-cloud-pair-submit"), "C2 配对表单锚保留（parity C8 兼容）");
}
// C3 移动端 lane 同步列表化
{
  const body = blockFrom("function cloudMobileLaneInner() {");
  ok(body.includes("sdelServerRows(true)"), "C3 移动 lane 桌面同构列表");
  ok(body.includes("远程源 · "), "C3 lane 头改「远程源 · N」（云桥从唯一固定项降级为条目之一）");
  ok(body.includes("data-cloud-pair-input"), "C3 移动配对表单锚保留");
}

// C4 三锚文档级委托（无 cloudUIOn 门）——closest 调用形态只在委托回调里（渲染处是拼接形态）
{
  const anchor = 'event.target.closest("[data-srv-connect]")';
  const i = html.indexOf(anchor);
  ok(i > 0, "C4 三锚走文档级委托（closest 委托形态在场）");
  const iDelegate = i >= 0 ? html.lastIndexOf("document.addEventListener(\"click\"", i) : -1;
  ok(iDelegate > 0 && i - iDelegate < 200, "C4 委托挂在文档级 click 监听内");
  const seg = iDelegate > 0 ? html.slice(iDelegate, iDelegate + 900) : "";
  ok(seg.includes("activateCloudServer") && seg.includes("deleteCloudServerUI") && seg.includes("openEditServerUI"), "C4 委托接线三函数");
  ok(!seg.includes("if (!cloudUIOn()) return;"), "C4 委托不带云形态门（非云形态可清理条目）");
}

// C5 切换连接语义（activateCloudServer）
{
  const body = blockFrom("function activateCloudServer(id) {");
  ok(body.includes("lsSet(ACTIVE_CLOUD_KEY, id)"), "C5 切换先落 ACTIVE_CLOUD_KEY（bootstrap 重选锚）");
  ok(body.includes("cloudDisconnect()") && body.includes("bootstrapCloud()"), "C5 换源=断当前+重连（点行设活动源语义）");
  ok(body.includes("switchToCloudSource(false)"), "C5 壳/LAN 形态首启云链接管");
  ok(body.includes('setSourceView("cloud")'), "C5 切视角跟随源（旧壳点行=设活动源）");
}

// C6 编辑弹窗语义
{
  const body = blockFrom("function openEditServerUI(entry) {");
  ok(body.includes("data-edit-url") && body.includes("data-edit-name") && body.includes("data-edit-token"), "C6 编辑三字段（名称/地址/令牌）");
  ok(body.includes("updateSharedCloudServer(entry.id"), "C6 保存走共享库更新（非显示层旁挂）");
  ok(body.includes("setSourceNameOverride(relayName, name)"), "C6 在线源改名同步 override（顶栏/徽章跟随）");
  ok(body.includes('地址已变更 · 需重新输码配对') || body.includes("addrChanged ?"), "C6 地址变更明示重配对");
  const iSave = body.indexOf("wasCur");
  ok(iSave > 0 && body.includes("cloudDisconnect();"), "C6 当前源字段变更断开重连（旧壳「改连接字段即重连」）");
}

// C7 非 cloudMode（桌面壳/浏览器 LAN 形态）连接面板同列条目——用户主场景是桌面壳，
// else 分支不列条目=改了白改；刷新借道防删后旧列表滞留
{
  const i = html.indexOf('cloudSettingsRows() +');
  ok(i > 0, "C7 非 cloudMode 连接面板嵌入 cloudSettingsRows（桌面壳/LAN 形态同列条目）");
  const iElse = html.lastIndexOf("else {", i);
<<<<<<< HEAD
  ok(iElse > 0 && html.slice(iElse, i).includes("settings-row"), "C7 嵌入位于 initSettingsLiveData else 分支（本机 relay 行之后）");
=======
  ok(iElse > 0 && html.slice(iElse, i).includes("v8-relaystat"), "C7 嵌入位于 initSettingsLiveData else 分支（本机 relay 行之后·W-V8R 批6 行形态改 v8-relaystat）");
>>>>>>> feat/v8-visual-restore
  ok(html.includes("window.__ccDeck005RefreshSettingsLive = render;"), "C7 设置实时区刷新借道挂 window（bridge.subscribe 只随桥事件走）");
  const del = blockFrom("function deleteCloudServer(id) {");
  ok(del.includes("__ccDeck005RefreshSettingsLive"), "C7 删除后主动刷设置实时区（无桥事件路径）");
  const act = blockFrom("function activateCloudServer(id) {");
  ok(act.includes("__ccDeck005RefreshSettingsLive"), "C7 切换后主动刷设置实时区");
  const edit = blockFrom("function openEditServerUI(entry) {");
  ok(edit.includes("__ccDeck005RefreshSettingsLive"), "C7 编辑保存后主动刷设置实时区");
}

console.log("-- D. 结构闸 --");

// D1 改动主 script 块整体编译（node --check，真语法闸——parity C12 同口径但锚本域）。
// 块定位用成对正向扫描：块内注释含「<script>」字面量（如「域各在独立 <script> 块」）会骗过
// lastIndexOf 反向定位，正向成对推进天然跳过（指针每次跳到块尾之后）
{
  const iSdel = html.indexOf("W-SDEL 服务器条目管理");
  ok(iSdel > 0, "D1 sdel 段在 HTML 内");
  let iOpen = -1;
  let iClose = -1;
  let p = 0;
  while (p < html.length) {
    const a = html.indexOf("<script>", p);
    if (a < 0) break;
    const b = html.indexOf("</script>", a);
    if (b < 0) break;
    if (a < iSdel && iSdel < b) { iOpen = a; iClose = b; break; }
    p = b + 1;
  }
  ok(iOpen > 0 && iClose > iSdel, "D1 sdel 段所在 script 块边界可寻（成对扫描）");
  if (iOpen > 0 && iClose > iSdel) {
    const js = html.slice(iOpen + "<script>".length, iClose);
    const tmp = join(root, "relay", "data", "test-sdel-check.mjs");
    let compiled = false;
    let errNote = "";
    try {
      const { writeFileSync, rmSync, mkdirSync } = await import("node:fs");
      mkdirSync(join(root, "relay", "data"), { recursive: true });
      writeFileSync(tmp, js);
      const { execFileSync } = await import("node:child_process");
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
      compiled = true;
      rmSync(tmp, { force: true });
    } catch (e) {
      errNote = e instanceof Error ? e.message.split("\n")[0] : String(e);
      try { const { rmSync } = await import("node:fs"); rmSync(tmp, { force: true }); } catch {}
    }
    ok(compiled, "D1 主 script 块 node --check 编译通过" + (compiled ? "" : "（" + errNote + "）"));
  }
}

// D2 内联事件 HTML 字符串 div 平衡（sdelServerRows 两条路径的行字符串）
{
  const body = blockFrom("function sdelServerRows(mobile) {");
  const divsOpen = (body.match(/<div/g) || []).length;
  const divsClose = (body.match(/<\/div>/g) || []).length;
  ok(divsOpen === divsClose, `D2 sdelServerRows 行字符串 div 平衡（${divsOpen}/${divsClose}）`);
  const editBody = blockFrom("function openEditServerUI(entry) {");
  const eOpen = (editBody.match(/<div/g) || []).length;
  const eClose = (editBody.match(/<\/div>/g) || []).length;
  ok(eOpen === eClose, `D2 编辑弹窗 innerHTML div 平衡（${eOpen}/${eClose}）`);
}

// D3 data-* 锚唯一性纪律：data-srv-* 值域检查（id 拼接无引号逃逸）
{
  const body = blockFrom("function sdelServerRows(mobile) {");
  ok(!body.includes('data-srv-delete="\'+'), "D3 删除锚 id 拼接无引号裸拼风险形态");
}

console.log(`\n005-servers: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
