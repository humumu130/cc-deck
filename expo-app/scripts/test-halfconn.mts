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
ok(storeSrc.includes("enqueueHalfconn(type, payload, cmdId || uuid(), sid, onAck, \"会话不存在，命令未发送\")"), "T4a RN A 类：sidIndex miss 受理入队+强制全量（窗尽才报原错）");
ok(storeSrc.includes("enqueueHalfconn(type, payload, cmdId || uuid(), sid, onAck, \"未连接，命令未发送\")"), "T4b RN B 类：ws 未 OPEN 受理入队（窗尽才报原错）");
ok(storeSrc.includes("forceFullResync"), "T4c forceFullResync 在场");
ok(storeSrc.includes('data: seal({ t: "ping", last_seq: 0 }'), "T4d 云源强制全量不断链（ping last_seq=0）");
ok(storeSrc.includes("conn.lastSeq = 0;"), "T4e lastSeq=0（下次 hello/URL 不带旧 seq→relay 推全量）");
ok(storeSrc.includes("private drainHalfconn()"), "T4f drainHalfconn 在场");
const drainCalls = (storeSrc.match(/this\.drainHalfconn\(\);/g) ?? []).length;
ok(drainCalls >= 4, "T4g drain 触发点≥4（LAN OPEN/云 resume 复通/云首帧/SNAPSHOT 装配）", "calls=" + drainCalls);
ok(storeSrc.includes("connStateTextWithDown(c.state, c.lastDownAt)"), "T4h connStatusPatch 消费半连接修正");
ok(storeSrc.includes("sidIndex 更新路径账本"), "T4i RN 侧源表更新路径账本注释在场");

console.log("");
console.log(fail === 0 ? `PASS ${pass} assertions（halfconn：自愈时序+徽标诚实+双端锚）` : `FAIL ${pass} assertions（halfconn）`);
process.exit(fail === 0 ? 0 : 1);
