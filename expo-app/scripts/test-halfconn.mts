// halfconn（#38 族四现·1104 用户实锤「收得到发不出」）专项测试：
//   A. RN 纯函数：connStateTextWithDown（offline+下行活→重连中；超窗/零帧→已断开；
//      online/connecting/unpaired 不受影响）——源文本提取 eval 直跑（conn-ux-p0 同款）
//   B. web 行为级时序证据（验收点②）：从 session-domain.js 提取 halfconnRetrySend+sendCmd
//      eval 注入桩环境——注入源失配态（RouteWs 恒 null）→ sendCmd 受理（不死 toast）→
//      模拟 SNAPSHOT 重建源表（RouteWs 翻 ready）→ 轮询拍真发出（command_id 复用）；
//      时序断言：受理时刻 < 重同步触发时刻 < 真发出时刻
//   C. 双端源码字面锚：web 自愈三件结构（ResyncSource 双通道/胶囊重连中/账本注释/
//      toast 动作钮）+ RN 自愈链（send 两类入队/forceFullResync 云 ping 不断链/
//      drain 四触发点/connStatusPatch 消费）
//   D. RN drainHalfconn 行为级（R1·P1-②/P2②）：方法体提取 eval+桩 this——双源夹具
//      （sourceId=cloud 而 activeConn=lan 必投 cloud）/sid miss 无回落留队窗尽/窗尽
//      onAck 优先不叠全局 emit/双空 legacy 兜底保持
//   E. R1 字面锚：web 接线三件（onEvent 帧驱动/秒针到期翻转/IngestFrame 注入口/
//      RouteWs 源标记）+ failB2Flights 按源收割 + RN 六件（负锚：drain 无 ?? activeConn 回落）
//   F. web failB2Flights 行为级（R1·P2③·验收 3）：函数体提取 eval——他源 close 只清
//      本源 waiter；受理中（src=null）永不被 close 清；无参旧面全清
// 直跑：cd relay && node --import tsx ../expo-app/scripts/test-halfconn.mts
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.error("  FAIL " + name + (extra ? "｜" + extra : "")); }
};

// ---------- A. RN 纯函数（源文本提取 eval——conn-ux-p0 同款防漂移口径） ----------
const storeSrc = readFileSync(new URL("../src/store.ts", import.meta.url), "utf-8");
function extractFn(src: string, name: string): string {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error(name + " not found");
  let depth = 0;
  const j = src.indexOf("{", i);
  let k = j;
  while (k < src.length) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) break; }
    k += 1;
  }
  return src.slice(i, k + 1);
}
// connStateTextWithDown 依赖 connStateTextOf——eval 副本（源段带 TS 标注不可直 eval，
// 剥标注手写 JS 副本 + 源形态漂移锚防漂，conn-ux-p0 同款口径）
const srcWithDown = extractFn(storeSrc, "connStateTextWithDown");
if (!srcWithDown.includes("已断开") || !srcWithDown.includes("HALFCONN_GRACE_MS")) throw new Error("connStateTextWithDown 源形态漂移——请同步更新本测试 eval 副本");
if (!extractFn(storeSrc, "connStateTextOf").includes("配对失效")) throw new Error("connStateTextOf 源形态漂移");
const HALFCONN_GRACE_MS = 45_000;
const withDown = new Function("HALFCONN_GRACE_MS", `
  function connStateTextOf(state) {
    switch (state) {
      case "online": return "已连接";
      case "unpaired": return "配对失效";
      case "reconnecting":
      case "offline": return "已断开";
      default: return "连接中";
    }
  }
  function connStateTextWithDown(state, lastDownAt, now) {
    now = now === undefined ? Date.now() : now;
    const base = connStateTextOf(state);
    if (base !== "已断开") return base;
    return lastDownAt > 0 && now - lastDownAt < HALFCONN_GRACE_MS ? "重连中" : base;
  }
  return connStateTextWithDown;`)(HALFCONN_GRACE_MS) as (state: string, lastDownAt: number, now?: number) => string;
const NOW = 1_800_000_000_000;
ok(withDown("offline", NOW - 10_000, NOW) === "重连中", "T1a offline+下行 10s 前仍活→重连中（徽标诚实）");
ok(withDown("reconnecting", NOW - 44_000, NOW) === "重连中", "T1b reconnecting+窗内→重连中");
ok(withDown("offline", NOW - 46_000, NOW) === "已断开", "T1c offline+超 45s 窗→已断开（不无限乐观）");
ok(withDown("offline", 0, NOW) === "已断开", "T1d offline+从未有帧→已断开");
ok(withDown("online", 0, NOW) === "已连接", "T1e online 不受下行判定影响");
ok(withDown("connecting", NOW - 1_000, NOW) === "连接中", "T1f connecting 保持连接中");
ok(withDown("unpaired", NOW - 1_000, NOW) === "配对失效", "T1g unpaired 不被半连接修正吞掉");

// ---------- B. web 行为级时序证据（验收点②：注入源失配态→自动重同步→真发出） ----------
const sdSrc = readFileSync(new URL("../../web-console/js/session-domain.js", import.meta.url), "utf-8");
function extractRange(src: string, fromMarker: string, toMarker: string): string {
  const i = src.indexOf(fromMarker);
  if (i < 0) throw new Error("fromMarker not found: " + fromMarker);
  const j = src.indexOf(toMarker, i);
  if (j < 0) throw new Error("toMarker not found: " + toMarker);
  return src.slice(i, j);
}
// halfconnRetrySend 段（含其前的 _halfconnInFlight let）到 sendCmd 函数尾
const seg = extractRange(sdSrc, "let _halfconnInFlight = 0;", "function commandAck");
let sent: Array<{ at: number; obj: Record<string, unknown> }> = [];
let resyncAt: number[] = [];
let toasts: Array<{ msg: string; action?: { label: string } }> = [];
let routeReady = false;
const fakeWs = {
  readyState: 1,
  send: (raw: string) => { sent.push({ at: Date.now(), obj: JSON.parse(raw) }); },
};
const win = {
  __ccDeck005RouteWs: (_p: unknown) => (routeReady ? fakeWs : null),
  __ccDeck005ResyncSource: (_p: unknown) => { resyncAt.push(Date.now()); return null; },
};
const b2ToastStub = (msg: string, _ms?: number, action?: { label: string }) => { toasts.push({ msg, action }); };
const uuidStub = () => "cmd-halfconn-test";
const harness = new Function("window", "b2Toast", "uuid", "setInterval", "clearInterval", "Date",
  seg + "\nreturn { sendCmd, halfconnRetrySend };")(win, b2ToastStub, uuidStub, setInterval, clearInterval, Date);
const t0 = Date.now();
const id = harness.sendCmd("COMMAND_MESSAGE", { session_id: "s-halfconn-1", text: "hi" } as Record<string, unknown>);
const acceptedAt = Date.now();
ok(typeof id === "string" && id.length > 0, "T2a 源失配态（RouteWs=null）受理不死锁（返回 command_id）");
ok(toasts.some((t) => t.msg.includes("待同步") || t.msg.includes("自动发送")), "T2b 受理通告文案（会话源待同步·恢复后自动发送）", JSON.stringify(toasts));
// 700ms 后模拟「SNAPSHOT 已重建源表」（resync 生效）：RouteWs 翻 ready
setTimeout(() => { routeReady = true; }, 700);
await new Promise((r) => setTimeout(r, 2000));
ok(resyncAt.length >= 1 && resyncAt[0] >= t0, "T2c 重同步被触发（__ccDeck005ResyncSource 收到调用）");
ok(sent.length === 1, "T2d 恢复后命令真发出（恰好一次，不重复投递）", "sent=" + sent.length);
ok(sent.length === 1 && sent[0].obj.command_id === "cmd-halfconn-test", "T2e command_id 复用（受理与真发出同 id——relay 幂等锚）");
ok(sent.length === 1 && sent[0].obj.type === "COMMAND_MESSAGE", "T2f 命令类型透传");
ok(resyncAt.length >= 1 && sent.length === 1 && acceptedAt <= resyncAt[0] && resyncAt[0] <= sent[0].at,
  "T2g 时序证据：受理(" + acceptedAt + ") ≤ 重同步触发(" + (resyncAt[0] || -1) + ") ≤ 真发出(" + (sent[0] ? sent[0].at : -1) + ")", "");

// ---------- C1. web 源码字面锚 ----------
const stSrc = readFileSync(new URL("../../web-console/js/settings-domain.js", import.meta.url), "utf-8");
ok(stSrc.includes("__ccDeck005ResyncSource"), "T3a resyncSource 单点导出（B2 sendCmd/toast 动作钮双消费）");
ok(stSrc.includes('{ t: "ping", last_seq: 0 }'), "T3b 云链强制全量通道（ping last_seq=0=relay resumePhone(0) 语义）");
ok(stSrc.includes("?token=") && stSrc.includes("临时 ws"), "T3c LAN 临时 ws 全量通道（1013 件9 先例注释在场）");
ok(stSrc.includes("源集合更新路径账本"), "T3d 源表更新路径账本注释在场（同类绝迹机制锚）");
ok(stSrc.includes('" · 重连中"') || stSrc.includes("· 重连中"), "T3e windowbar 胶囊半连接显「重连中」");
ok(stSrc.includes("RECONNECT_GRACE_MS"), "T3f 重连判定窗常量（45s）");
ok(stSrc.includes("context._lastFrameAt = Date.now();") && stSrc.includes("地基帧统一入口"), "T3g 地基帧统一入口刷 _lastFrameAt（LAN onmessage/云 onCloudText/IngestSnapshot 三路全覆盖）");
ok(sdSrc.includes("立即重连"), "T3h sidMiss toast 可执行动作（立即重连钮）");
ok(sdSrc.includes("_halfconnInFlight >= 3"), "T3i web 并发自愈风暴闸");

// ---------- C2. RN 源码字面锚 ----------
ok(storeSrc.includes("enqueueHalfconn(type, payload, cmdId || uuid(), sid, onAck, \"会话不存在，命令未发送\", sourceId)"), "T4a RN A 类：sidIndex miss 受理入队+强制全量（窗尽才报原错；R1 起透传 sourceId）");
ok(storeSrc.includes("enqueueHalfconn(type, payload, cmdId || uuid(), sid, onAck, \"未连接，命令未发送\", conn.id)"), "T4b RN B 类：ws 未 OPEN 受理入队（窗尽才报原错；R1 起带本源 id 不丢源）");
ok(storeSrc.includes("forceFullResync"), "T4c forceFullResync 在场");
ok(storeSrc.includes('data: seal({ t: "ping", last_seq: 0 }'), "T4d 云源强制全量不断链（ping last_seq=0）");
ok(storeSrc.includes("conn.lastSeq = 0;"), "T4e lastSeq=0（下次 hello/URL 不带旧 seq→relay 推全量）");
ok(storeSrc.includes("private drainHalfconn()"), "T4f drainHalfconn 在场");
const drainCalls = (storeSrc.match(/this\.drainHalfconn\(\);/g) ?? []).length;
ok(drainCalls >= 4, "T4g drain 触发点≥4（LAN OPEN/云 resume 复通/云首帧/SNAPSHOT 装配）", "calls=" + drainCalls);
ok(storeSrc.includes("connStateTextWithDown(c.state, c.lastDownAt)"), "T4h connStatusPatch 消费半连接修正");
ok(storeSrc.includes("sidIndex 更新路径账本"), "T4i RN 侧源表更新路径账本注释在场");

// ---------- D. RN drainHalfconn 行为级（R1：P1-② 双源路由+去回落 / P2② 窗尽 onAck） ----------
// 方法体提取（brace 配对）→ TS 标注剥离（private/keep 类型注记）→ eval+桩 this 直跑
function extractMethod(src: string, sig: string): string {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("method not found: " + sig);
  let depth = 0;
  const j = src.indexOf("{", i);
  let k = j;
  while (k < src.length) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) break; }
    k += 1;
  }
  return src.slice(i, k + 1);
}
const drainMethod = extractMethod(storeSrc, "private drainHalfconn() {");
if (!drainMethod.includes("this.activeConn()")) throw new Error("drainHalfconn 源形态漂移（activeConn 解析链不在场）");
const drainFn = new Function(
  "return " + drainMethod
    .replace("private drainHalfconn()", "function drainHalfconn()")
    .replace("const keep: typeof this.halfconnQueue = [];", "const keep = [];"),
)() as (this: unknown) => void;
{
  const mkConn = (id: string) => ({ id, ws: { readyState: 1 } }); // WebSocket.OPEN=1
  const connLan = mkConn("lan-1"), connCloud = mkConn("cloud-1");
  const dispatched: Array<{ src: string; cmd: string }> = [];
  const emits: Array<Record<string, unknown>> = [];
  const acks: Array<{ ok: boolean; err: string | null }> = [];
  const nowMs = Date.now();
  const queue: Array<Record<string, unknown>> = [
    { type: "COMMAND_ORG_CONFIRM", payload: {}, cmdId: "d-src", sid: null, sourceId: "cloud-1", at: nowMs - 9000, giveUp: "未连接，命令未发送" }, // 双源：sourceId=cloud 而 activeConn=lan
    { type: "COMMAND_MESSAGE", payload: {}, cmdId: "d-miss", sid: "sid-ghost", at: nowMs - 9000, giveUp: "会话不存在，命令未发送", onAck: (r: { ok: boolean; err: string | null }) => acks.push(r) }, // sid miss+窗尽+onAck
    { type: "COMMAND_MESSAGE", payload: {}, cmdId: "d-miss2", sid: "sid-ghost", at: nowMs - 3000, giveUp: "会话不存在，命令未发送" }, // 未到窗：留队
    { type: "COMMAND_MESSAGE", payload: {}, cmdId: "d-legacy", sid: null, at: nowMs - 9000, giveUp: "未连接，命令未发送" }, // sid/sourceId 双空：activeConn 兜底保持
    { type: "COMMAND_NOTIFICATION_ACK", payload: {}, cmdId: "d-ghost-src", sid: null, sourceId: "src-gone", at: nowMs - 9000, giveUp: "未连接，命令未发送" }, // sourceId 失效+窗尽无 onAck：全局 emit
  ];
  const fakeStore = {
    halfconnQueue: queue,
    sidIndex: new Map([["sid-live", connLan]]),
    conns: new Map([["lan-1", connLan], ["cloud-1", connCloud]]),
    activeConn: () => connLan, // 反证锚：活动源=lan，sourceId=cloud 的项必须投 cloud
    dispatchCmd: (conn: { id: string }, cmd: { command_id: string }) => { dispatched.push({ src: conn.id, cmd: cmd.command_id }); return true; },
    emit: (e: Record<string, unknown>) => { emits.push(e); },
  };
  drainFn.call(fakeStore);
  ok(dispatched.some((d) => d.cmd === "d-src" && d.src === "cloud-1") && !dispatched.some((d) => d.cmd === "d-src" && d.src === "lan-1"),
    "D1 双源投对源：sourceId=cloud-1 的队列项投 cloud（activeConn=lan 反证——不误投他源）", JSON.stringify(dispatched));
  ok(!dispatched.some((d) => d.cmd === "d-miss") && acks.length === 1 && acks[0].ok === false && acks[0].err === "会话不存在，命令未发送",
    "D2 sid 重同步后仍 miss：不回落 activeConn 不盲发（#294 废弃路径根除）——窗尽 onAck({ok:false, err=giveUp}) 如实报", JSON.stringify(acks));
  ok(!emits.some((e) => e.lastErrorCmd === "会话不存在，命令未发送"),
    "D3 onAck 在场不叠全局 emit（结果语义契约——调用方接管展示）", JSON.stringify(emits));
  ok((fakeStore.halfconnQueue as Array<{ cmdId: string }>).length === 1 && (fakeStore.halfconnQueue as Array<{ cmdId: string }>)[0].cmdId === "d-miss2",
    "D4 未到窗项留队（不误杀在途自愈；drain 换新数组非原位过滤）", "len=" + (fakeStore.halfconnQueue as unknown[]).length);
  ok(dispatched.some((d) => d.cmd === "d-legacy" && d.src === "lan-1"),
    "D5 sid/sourceId 双空 legacy 项保持 activeConn 兜底（兼容面不回归）", JSON.stringify(dispatched));
  ok(emits.some((e) => e.lastErrorCmd === "未连接，命令未发送") && !dispatched.some((d) => d.cmd === "d-ghost-src"),
    "D6 sourceId 失效（源已删）+窗尽无 onAck：全局 lastErrorCmd 收口（盲发零发生）", JSON.stringify(emits));
  ok(!drainMethod.includes("?? this.activeConn"),
    "D7 负锚：drain 解析链无 `?? activeConn` 直回落（sid 在册项 miss 即 undefined 留队——P1-② 结构锁）");
}

// ---------- E. R1 字面锚（web 接线三件+failB2Flights 源过滤+RN 六件） ----------
ok(stSrc.includes("scheduleConnBadgeRefresh(); // halfconn R1"), "E1 onEvent 帧驱动徽章重渲接线（P1-① 死码复活——增量帧窗胶囊可翻）");
ok(stSrc.includes("alive !== _halfconnAliveSeen"), "E2 45s 到期反向翻转：秒针拍 alive 态位检测（重连中→未连接无帧可依）");
ok(stSrc.includes("__ccDeck005IngestFrame"), "E3 增量帧注入口在册（探针③换增量帧形态的证据面）");
ok(((stSrc.match(/__ccDeck005LastRouteSource = "(?:lan|cloud)"/g) ?? []).length) >= 5, "E4 RouteWs 五分支源标记（lan/cloud——failB2Flights 按源收割判据）");
ok(sdSrc.includes("failB2Flights(ev.source)"), "E5 close 事件按源收割接线（他源断链不清本源）");
ok(sdSrc.includes("if (source && (src === null || src !== source)) continue;"), "E6 收割跳过守卫在册（src=null 受理中不被断链收割——幽灵重发源头）");
ok(sdSrc.includes("_cmdSrc.set(retried, null)") && sdSrc.includes("_cmdSrc.set(cmd.command_id"), "E7 飞行源两路径落账（真发出记源/受理中记 null）");
ok(sdSrc.includes(">= 7000"), "E8 web 自愈窗 8s→7s（短于最短 waiter 8s——同刻竞态收口）");
ok(sdSrc.includes("__ccDeck005B2FlightProbe"), "E9 抖动窗探针口在册（验收 3 观测面）");
ok(storeSrc.includes("(it.sid || it.sourceId ? undefined : this.activeConn())"), "E10 RN drain 三段解析序（sidIndex→sourceId→双空才活动源）");
ok(storeSrc.includes("sourceId?: string; onAck?: PendingCmd[\"onAck\"]"), "E11 RN 队列项带 sourceId（B 类入队不丢源）");
ok(storeSrc.includes("resyncGateAt") && storeSrc.includes("Date.now() - gateAt < 5000"), "E12 RN forceFullResync per-source 5s 节流（A 类风暴不再 N 次全量过桥）");
ok(storeSrc.includes("!conn.resyncArmed") && storeSrc.includes("conn.resyncArmed = false;"), "E13 RN LAN lastSeq 回填竞态闸+SNAPSHOT 到达解除（全量重建必发生）");
ok(storeSrc.includes("命令结果未知"), "E14 RN clearPendingCmds 逐项 onAck 收口（措辞按结果未知不谎报失败）");
ok(storeSrc.includes("it.onAck({ ok: false, err: it.giveUp })"), "E15 RN 窗尽 giveUp 回调 onAck（fetchArtifact 不再干等 90s）");

// ---------- F. web failB2Flights 行为级（R1·P2③·验收 3：源过滤防抖动窗幽灵重复） ----------
{
  const failText = extractMethod(sdSrc, "function failB2Flights(source) {");
  const settled: string[] = [];
  const mkWaiter = (id: string) => ({ res: () => { settled.push(id); }, t: setTimeout(() => {}, 1 << 30) });
  const S = { ackWaiters: new Map<string, ReturnType<typeof mkWaiter>>() };
  const _cmdSrc = new Map<string, string | null>();
  for (const [id, src] of [["w-lan", "lan"], ["w-cloud", "cloud"], ["w-acc", null]] as const) {
    S.ackWaiters.set(id, mkWaiter(id));
    _cmdSrc.set(id, src);
  }
  const failFn = new Function("S", "_cmdSrc", failText + "\nreturn failB2Flights;")(S, _cmdSrc) as (source?: string) => void;
  failFn("cloud");
  ok(settled.join(",") === "w-cloud" && S.ackWaiters.has("w-lan") && S.ackWaiters.has("w-acc") && !_cmdSrc.has("w-cloud"),
    "F1 他源 close 只清他源（cloud 断链：仅 w-cloud 结算并清账，w-lan/w-acc 保留）", settled.join(","));
  failFn("lan");
  ok(settled.join(",") === "w-cloud,w-lan" && S.ackWaiters.has("w-acc"),
    "F2 本源 close 清本源；受理中（src=null）永不被 close 清（等恢复照发——幽灵重发源头封死）", settled.join(","));
  failFn();
  ok(S.ackWaiters.size === 0 && settled.length === 3, "F3 无参旧调用面保持全清（兜底语义）", "size=" + S.ackWaiters.size);
  ok(!_cmdSrc.has("w-acc") && !_cmdSrc.has("w-lan"), "F4 收割同步清 _cmdSrc 账（防泄漏）");
}

console.log("");
console.log(fail === 0 ? `PASS ${pass} assertions（halfconn：自愈时序+徽标诚实+双端锚）` : `FAIL ${pass} assertions（halfconn）`);
process.exit(fail === 0 ? 0 : 1);
