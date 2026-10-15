// T10 修复半测试件：聚合多源发送路由（RouteWs 兜底泛化）+ 创建目标源显式锁通道 +
// 桥会话帧通道标（relay_channel）。范式=test-005-englogin-web.ts（静态锚 + blockFrom
// 提取纯函数 eval 直跑——不拉浏览器，词面与逻辑双锚）。
//
// 根因背景（1015 用户实测实锤链）：地基链 onEvent 只锚 SNAPSHOT（增量帧不进
// ctx.sessions）→ SNAPSHOT 之后新建的会话在两源表恒 miss → RouteWs 兜底盲投视角
// 通道（云视角=云 shim）→ 云 relay 查无此会话报「会话不存在: <完整 36 位 id>」→
// 窄 toast 目视截断成「残缺 id」假象。修复三面：①桥（applySnapshot/SESSION_CREATED
// 建卡）打 relay_channel 帧通道标；②RouteWs B4 兜底按标路由+全 miss 拒发（null）；
// ③创建弹窗显式选 local 也锁 LAN 通道（Leader 追加：云视角下「选本机却落远程」）。
//
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-route-fix.ts
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
// 括号体提取（箭头函数赋值：window.xxx = (p) => {...}——取参数括号起的完整箭头函数）
function arrowFrom(needle: string): string {
  const i = html.indexOf(needle);
  if (i < 0) return "";
  const paren = html.indexOf("(", i);
  const eq = html.indexOf("=>", i);
  if (paren < 0 || eq < 0 || paren > eq) return "";
  const j = html.indexOf("{", eq);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(paren, k + 1); }
  }
  return "";
}

console.log("== T10：聚合多源发送路由 + 创建目标源显式锁通道 ==");

// ---- A. 词面锚：修复三面在场 ----
{
  const snap = blockFrom("function applySnapshot(payload, evSource) {");
  ok(snap.length > 0, "A1 applySnapshot 签名带 evSource（帧通道入参——无参版本已退役）");
  ok(snap.includes("relay_channel: chan") && snap.includes('evSource === "cloud" ? "cloud" : "lan"'), "A2 快照建卡打 relay_channel（cloud/lan 双值）");
  const agg = html.indexOf('applySnapshot(frame.payload, evSource);\n                      for (const [id, v] of keepSessions)');
  const els = html.indexOf("} else applySnapshot(frame.payload, evSource);");
  ok(agg > 0 && els > 0, "A3 SNAPSHOT 两处调用都传 evSource（aggregate keep 分支 + else 分支）");
  const created = html.indexOf('frame.type === "SESSION_CREATED"');
  const createdSeg = created > 0 ? html.slice(created, created + 900) : "";
  ok(createdSeg.includes("relay_channel: evSource") && createdSeg.includes("? \"cloud\" : \"lan\""), "A4 实时帧建卡（SESSION_CREATED）打 relay_channel");
  const merge = blockFrom("else if (SESSION_MERGE_TYPES.has(frame.type)) {");
  ok(merge.includes("Object.assign(session, frame.payload, { session_id: frame.session_id, updated_at:") && !merge.includes("relay_channel:"), "A5 merge 分支不覆写 relay_channel（Object.assign 仅写 session_id/updated_at——帧 payload 无该字段时卡上标记保留）");
  const toast = html.indexOf(".toast {");
  const toastSeg = toast > 0 ? html.slice(toast, toast + 700) : "";
  ok(toastSeg.includes("word-break: break-all"), "A6 toast 长文本强制折行（36 位 UUID 完整可读——「残缺 id」目视假象消除）");
}

// ---- B. 行为锚：RouteWs 五分支 eval 直跑 ----
{
  const src = arrowFrom("window.__ccDeck005RouteWs = (payload)");
  ok(src.length > 0, "B0 RouteWs 箭头函数可提取（eval 直跑前置）");
  if (src.length > 0) {
    const fakeLan = { readyState: 1, tag: "lan-ws" };
    const fakeShim = { readyState: 1, tag: "cloud-shim" };
    const fakeMain = { readyState: 1, tag: "main-ws" };
    const mkEnv = (opts: {
      cloudSids?: string[]; lanSids?: string[]; b4?: Array<[string, Record<string, unknown>]>; cloudOnline?: boolean; lanOnline?: boolean; mainWs?: unknown;
    }) => {
      const ctx = { sessions: new Map((opts.lanSids ?? []).map((s) => [s, {}])), ws: opts.lanOnline === false ? null : fakeLan };
      const cloudCtx = { sessions: new Map((opts.cloudSids ?? []).map((s) => [s, {}])), status: opts.cloudOnline === false ? "offline" : "online", relayName: "云源甲", hasSnapshot: true };
      const w = { __ccDeck005B4: { sessions: new Map(opts.b4 ?? []) }, __ccDeck005MainWs: opts.mainWs === null ? undefined : fakeMain };
      return { window: w, ctx, cloudCtx, cloudCmdShim: fakeShim };
    };
    const routeOf = (env: { window: unknown; ctx: unknown; cloudCtx: unknown; cloudCmdShim: unknown }) =>
      eval(`(function(window, ctx, cloudCtx, cloudCmdShim) { return (${src}); })`)(env.window, env.ctx, env.cloudCtx, env.cloudCmdShim) as (p: Record<string, unknown>) => unknown;
    const tag = (r: unknown) => (r && typeof r === "object" ? String((r as { tag?: string }).tag ?? "?") : String(r));

    ok(tag(routeOf(mkEnv({}))(({}))) === "main-ws", "B1 无 sid 命令维持视角通道（MainWs——CREATE 类语义不变）");
    ok(tag(routeOf(mkEnv({ cloudSids: ["aaa"] }))({ session_id: "aaa" })) === "cloud-shim", "B2 云源表命中 → 云 shim");
    ok(tag(routeOf(mkEnv({ lanSids: ["bbb"] }))({ session_id: "bbb" })) === "lan-ws", "B3 本机源表命中 → LAN ws");
    // T10 核心场景：两源表 miss（地基不吃实时帧）+ B4 桥实时卡带 lan 标 → LAN ws
    //（修复前：兜底 return MainWs——云视角下 = 云 shim → 云 relay「会话不存在: <完整id>」）
    ok(tag(routeOf(mkEnv({ b4: [["ccc", { relay_channel: "lan" }]] }))({ session_id: "ccc" })) === "lan-ws", "B4 T10 核心：B4 实时卡（lan 标，两源表 miss）→ LAN ws（修复前盲投视角通道错投云）");
    ok(tag(routeOf(mkEnv({ b4: [["ddd", { relay_channel: "cloud" }]] }))({ session_id: "ddd" })) === "cloud-shim", "B5 B4 实时卡（cloud 标）→ 云 shim");
    ok(tag(routeOf(mkEnv({ b4: [["eee", { relay_source: "云源甲" }]] }))({ session_id: "eee" })) === "cloud-shim", "B6 B4 快照卡（relay_source=云源名旧锚）→ 云 shim（旧标兼容）");
    ok(tag(routeOf(mkEnv({ b4: [["fff", { relay_source: "本机-Mac" }]] }))({ session_id: "fff" })) === "lan-ws", "B7 B4 快照卡（relay_source=本机源名）→ LAN ws");
    ok(routeOf(mkEnv({}))({ session_id: "ghost" }) === null, "B8 全 miss → null 拒发（不再盲投——误导性「会话不存在: <id>」从根上消除）");
    ok(routeOf(mkEnv({ b4: [["ggg", { relay_channel: "lan" }]], lanOnline: false }))({ session_id: "ggg" }) === null, "B9 lan 标卡但 LAN 链未连 → null（离线源不可发）");
    ok(routeOf(mkEnv({ b4: [["hhh", { relay_channel: "cloud" }]], cloudOnline: false }))({ session_id: "hhh" }) === null, "B10 cloud 标卡但云链离线 → null");
  }
}

// ---- C. 全链语义：登录后创建 → 发送路由闭环（applySnapshot + SESSION_CREATED 建卡 + RouteWs 串联）----
{
  const snapSrc = blockFrom("function applySnapshot(payload, evSource) {");
  ok(snapSrc.length > 0, "C0 applySnapshot 可提取（eval 直跑前置）");
  if (snapSrc.length > 0) {
    const mk = () => {
      const bridge = { sessions: new Map(), notifications: [], pendingConfirms: [], accepts: [], projects: [], designDocs: [], snapshot: null, hasSnapshot: false, relayName: "", homedir: "", notificationsSupported: false, notifyAckUnsupported: true };
      const fn = eval(`(function(bridge, location) { ${snapSrc} return applySnapshot; })`)(bridge, { host: "192.168.0.105:8787" });
      return { bridge, fn };
    };
    // C1 云源快照 + 本机实时帧建卡：混合态下新会话路由本机（用户实测场景的抽象——
    // 本机创建 codebuddy 会话，B4 桥 lan 标救回路由）
    {
      const { bridge, fn } = mk();
      fn({ relay_name: "云源甲", sessions: [{ session_id: "old-cloud", cwd: "/x" }] }, "cloud");
      // SESSION_CREATED 建卡（handleFrame 分支的行为等价——打同样的标）
      bridge.sessions.set("new-lan", { session_id: "new-lan", relay_channel: "lan" });
      ok(bridge.sessions.get("old-cloud")?.relay_channel === "cloud" && bridge.sessions.get("new-lan")?.relay_channel === "lan", "C1 混合态两卡各带正确通道标（云快照卡=cloud/本机实时卡=lan）");
    }
    // C2 aggregate 重放：本机快照后接云快照——本机卡被 keep 并集保留且**本机标不被云快照覆盖**
    {
      const { bridge, fn } = mk();
      fn({ relay_name: "Mac本机", sessions: [{ session_id: "s-lan", relay_channel: "lan" }] }, "lan");
      const kept = new Map(bridge.sessions);
      fn({ relay_name: "云源甲", sessions: [{ session_id: "s-cloud" }] }, "cloud");
      for (const [id, v] of kept) if (!bridge.sessions.has(id)) bridge.sessions.set(id, v);
      ok(bridge.sessions.get("s-cloud")?.relay_channel === "cloud" && bridge.sessions.get("s-lan")?.relay_channel === "lan", "C2 双源快照并集各标不串（keep 并集保留本机卡+lan 标）");
    }
  }
}

// ---- D. sendCmd 拒发文案 + submitCreate 显式选源（词面锚）----
{
  const send = blockFrom("function sendCmd(type, payload, wsOverride) {");
  ok(send.includes("sidMiss") && send.includes("会话不在已连接的源上") && send.includes("typeof payload.session_id === \"string\""), "D1 sendCmd 区分「路由拒发（null）」与「连接断」——sid 命令拒发给可操作文案");
  const submit = html.indexOf("function submitCreate() {");
  const submitSeg = submit > 0 ? html.slice(submit, submit + 3000) : "";
  ok(submitSeg.includes('srcSel.value === "cloud"') && submitSeg.includes("远程源不在线，无法在远程创建"), "D2 显式选远程锁云 shim（既有行为保持）");
  ok(submitSeg.includes('srcSel.value === "local"') && submitSeg.includes("本机源不在线，无法在本机创建") && submitSeg.indexOf('srcSel.value === "local"') < submitSeg.indexOf("const payload ="), "D3 显式选本机锁 LAN 通道（Leader 追加：云视角下「选本机却落远程」根修——local 分支先于 payload 组装）");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "HAS FAIL"}：${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
