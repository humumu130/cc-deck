// #268 云通道降级失效根修——ws 僵尸死（Canceled 形态）状态机行为断言。
// 范式：静态锚 + 真源码抽取直跑（test-258-pair-selfheal 同范式）——靶子
// web-console/js/settings-domain.js 云链状态机。
//
// 事故背景（1026 CF tail 实锤）：桌面壳（Tauri WebView2）wss 连接 Canceled 后，
// 13s 通道看门狗/45s 心跳判死/8s 回前台探测三条恢复路径全部只调 ws.close() 等
// onclose 排重连——僵尸形态 onclose 永不触发 → 状态机零定时器零流量，UI 恒
// 「连接中」，relay 投递无门（tail 零 /cloud 零 /cloud-poll）。
//
// 断言组：
//   Z1 悬死握手（onopen/onclose 永不触发）：8s 握手看门狗 → 收尸 → 降级轮询 → pollLoop GET 起跑
//   Z2 僵尸在线（open 后黑洞，close 无 onclose）：13s 通道看门狗判死 → 收尸 + 直排重连（#268 核心）
//   Z3 二次僵尸判定 → wsFails≥2 → transport 翻 poll → 重连走 startPollTransport（全链接管）
//   Z4 45s 心跳判死（无 pong 僵尸）：同口径收尸+直排重连，不押 onclose
//   H1 握手被拒（onclose 先于 open）：switchToPoll → poll（既有语义保持）
//   H2 自然闪断 ×2 → 降级 poll（既有 wsFails 语义保持）
//   P1 轮询 GET 401 自愈：自定义 token 回退烘焙值 + transport 回 ws（既有语义保持）
//   P2 轮询网络持续失败：状态显形 + 循环仍活（4s 节奏续跑，不死不停摆）
//   D1 诊断快照 cloudDiag()：通道/失败计数/看门狗武装态/最后错误 字段完备且随迁移刷新
//   D2 诊断留痕 cloudDiagNote：连续同迁移去重、错误入 lastError、console 显形
//   R1 诊断面板行：poll 态含「HTTP 轮询」、失败计数、重试出口（桌面/移动双形）
//   S1-S5 结构闸：三条判死路径无裸 close 等 onclose、面板已接线、无残留裸收尸点
//
// 纯静态抽取 + eval 直跑：无桥/无 relay/无网络。虚拟时钟驱动 8s/13s/3s 全部真实常量。
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-268-cloud-watchdog.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sd = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
// 平衡花括号整函数提取（blockFrom 范式）
function blockFrom(needle: string, zone?: string): string {
  const src = zone ?? sd;
  const i = src.indexOf(needle);
  if (i < 0) return "";
  const j = src.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return "";
}
function bodyOf(block: string): string {
  return block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
}

console.log("#268 云通道降级死角根修——settings-domain.js 状态机（源码抽取直跑）");

// ---------- 抽取 ----------
const wrapperBlock = blockFrom("function connectCloudFor(ctx, manual)");
const innerBlock = blockFrom("function connectCloudForInner(ctx, manual)");
const pollStartBlock = blockFrom("function startPollTransport(ctx, base, token, dev, pair)");
const pollLoopBlock = blockFrom("async function pollLoop(ctx)");
const setConnBlock = blockFrom("function cloudSetConn(status, text, kind)");
const classifyBlock = blockFrom("function classifyCloudFail(t)");
const reconnectBlock = blockFrom("function scheduleCloudReconnect(ctx, minDelayMs)");
const chanWdBlock = blockFrom("function startChannelWatchdog(ctx)");
const stopChanWdBlock = blockFrom("function stopChannelWatchdog(ctx)");
const pingBlock = blockFrom("function startCloudPing(ctx)");
const stopPingBlock = blockFrom("function stopCloudPing(ctx)");
const helloBlock = blockFrom("function sendCloudHello(ctx)");
const killWsBlock = blockFrom("function killWsTransport(ctx)");
const diagNoteBlock = blockFrom("function cloudDiagNote(kind, detail, isError)");
const diagBlock = blockFrom("function cloudDiag()");
const diagRowBlock = blockFrom("function cloudDiagRowHtml(d, mobile)");
const peerOfBlock = blockFrom("function cloudPeerOf(cfg)");
const retryableBlock = blockFrom("function isCloudRetryable()");
const retryBtnBlock = blockFrom("function cloudRetryBtn()");

for (const [b, n] of [[wrapperBlock, "connectCloudFor"], [innerBlock, "connectCloudForInner"], [pollStartBlock, "startPollTransport"], [pollLoopBlock, "pollLoop"], [setConnBlock, "cloudSetConn"], [reconnectBlock, "scheduleCloudReconnect"], [chanWdBlock, "startChannelWatchdog"], [pingBlock, "startCloudPing"], [helloBlock, "sendCloudHello"], [killWsBlock, "killWsTransport"], [diagNoteBlock, "cloudDiagNote"], [diagBlock, "cloudDiag"], [diagRowBlock, "cloudDiagRowHtml"], [peerOfBlock, "cloudPeerOf"], [retryableBlock, "isCloudRetryable"], [retryBtnBlock, "cloudRetryBtn"]] as [string, string][]) {
  ok(!!b, "锚定 " + n + " 函数体");
}
if (fail) { console.log(`\n${pass} passed, ${fail} failed（锚定失败，中止）`); process.exit(1); }

// ---------- 虚拟时钟 ----------
class VClock {
  now = 1_700_000_000_000;
  timers: { id: number; due: number; cb: () => void; interval: number }[] = [];
  nextId = 1;
  setTimeout(cb: () => void, delay: number) { const t = { id: this.nextId++, due: this.now + (delay || 0), cb, interval: 0 }; this.timers.push(t); return t.id; }
  clearTimeout(id: number) { this.timers = this.timers.filter((t) => t.id !== id); }
  setInterval(cb: () => void, interval: number) { const t = { id: this.nextId++, due: this.now + (interval || 0), cb, interval: interval || 1 }; this.timers.push(t); return t.id; }
  clearInterval(id: number) { this.clearTimeout(id); }
  private drain(): number {
    let fired = 0;
    for (;;) {
      const due = this.timers.filter((t) => t.due <= this.now).sort((a, b) => a.due - b.due || a.id - b.id);
      if (!due.length) break;
      const t = due[0];
      this.timers = this.timers.filter((x) => x.id !== t.id);
      t.cb(); fired++;
      if (t.interval) { t.due = this.now + t.interval; this.timers.push(t); }
      if (fired > 5000) throw new Error("虚拟时钟失控");
    }
    return fired;
  }
  advance(ms: number): number { this.now += ms; return this.drain(); }
}
// Date mock：new Date(ts).toLocaleTimeString() 可用 + Date.now() 走虚拟钟
function mkDateMock(clock: VClock) {
  function D(this: unknown, ts?: number) {
    const self = this as { toLocaleTimeString?: () => string };
    self.toLocaleTimeString = () => "12:00:00";
    void ts;
  }
  (D as unknown as { now: () => number }).now = () => clock.now;
  return D;
}

// ---------- FakeWS：三种死法 ----------
// hang：构造后 onopen/onclose 永不触发（升级请求被挂起/取消）
// zombie：握手成功（harness 手动 simulateOpen），之后黑洞——close() 永不触发 onclose（WebView2 Canceled 形态）
// natural：close() 正常触发 onclose（良性行为）
class FakeWS {
  static created: FakeWS[] = [];
  static mode: "hang" | "zombie" | "natural" = "zombie";
  static reset(mode: "hang" | "zombie" | "natural") { FakeWS.created = []; FakeWS.mode = mode; }
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  closeCalled = 0;
  constructor(public url: string) { FakeWS.created.push(this); }
  send(s: string) { if (this.readyState !== 1) throw new Error("INVALID_STATE_ERR"); this.sent.push(s); }
  close() {
    this.closeCalled++;
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (FakeWS.mode === "natural") { const h = this.onclose; this.onclose = null; h && h({ code: 1005 }); }
    // hang / zombie：静默——onclose 永不触发（病灶本体）
  }
  simulateOpen() { if (this.readyState === 0) { this.readyState = 1; this.onopen && this.onopen({}); } }
  simulateMessage(data: string) { this.onmessage && this.onmessage({ data }); }
}

// ---------- 装配：真函数体 + 注入自由变量（晚绑定 env 解互递归） ----------
interface Harness {
  ctx: Record<string, unknown>;
  clock: VClock;
  fetchCalls: { url: string; opts?: unknown }[];
  fetchCtl: { mode: "ok" | "netfail" | "auth401"; respond: (() => void)[] };
  logs: string[];
  console: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  diagLog: Record<string, unknown>[];
  setConnCalls: unknown[][];
}
function mkCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.assign({
    cfg: { id: "s1", name: "云桥", kind: "cloud", wsUrl: "wss://bridge.example/cloud", token: "tok",
      cloud: { url: "wss://bridge.example/cloud", token: "tok", rd: "rl-1", rk: "rk-1", paired: true } },
    status: "offline", statusText: "未连接", failKind: "", retryAt: 0, retryNote: "",
    sessions: new Map(), lastSeq: 0, hasSnapshot: false, relayName: "t",
    ws: null, reconnectDelay: 3000, reconnectTimer: 0,
    pendingPair: null, pairTimer: 0, pingTimer: null, lastPong: 0,
    pairNextAt: 0, pairBackoffMs: 0,
    transport: "ws", pollGen: 0, pollSid: "", pollBase: "",
    wsFails: 0, postFails: 0, hsTimer: 0, discTried: false, discTimer: 0, _everOnline: false,
    helloTimer: 0, _lastFrameAt: 0,
    diagLastNote: "", diagLastError: null,
  }, over);
}
function link(block: string, params: string[], deps: Record<string, unknown>, isAsync = false): (...a: unknown[]) => unknown {
  for (const p of params) if (p in deps) throw new Error("参数与自由变量撞名: " + p);
  const body = bodyOf(block);
  // with(__D) 注入：自由变量经作用域对象解析，与实参个数彻底解耦（cloudDiagNote 的 isError、
  // scheduleCloudReconnect 的 minDelayMs 都是可选参——按位拼接会把 deps 串进参数槽）
  // eslint-disable-next-line no-new-func
  const f = isAsync
    ? new Function(...params, "__D", "return (async () => { with (__D) {" + body + "} })();")
    : new Function(...params, "__D", "with (__D) {" + body + "}");
  // 可选参（isError/minDelayMs）调用时实参不足——先补齐形参槽，deps 恒落 __D 尾槽
  return (...a: unknown[]) => {
    const padded = [...a];
    while (padded.length < params.length) padded.push(undefined);
    return f(...padded, deps);
  };
}
function buildHarness(ctx: Record<string, unknown>, wsMode: "hang" | "zombie" | "natural") {
  const clock = new VClock();
  FakeWS.reset(wsMode);
  const logs: string[] = [];
  const consoleMock = {
    log: (...a: unknown[]) => { logs.push("log|" + a.map(String).join(" ")); },
    error: (...a: unknown[]) => { logs.push("err|" + a.map(String).join(" ")); },
  };
  const diagLog: Record<string, unknown>[] = [];
  const fetchCalls: { url: string; opts?: unknown }[] = [];
  const fetchCtl = { mode: "ok" as "ok" | "netfail" | "auth401", respond: [] as (() => void)[] };
  const setConnCalls: unknown[][] = [];
  const DateMock = mkDateMock(clock);
  const h: Harness = { ctx, clock, fetchCalls, fetchCtl, logs, console: consoleMock, diagLog, setConnCalls };

  const env: Record<string, unknown> = {};
  const late = (name: string) => (...a: unknown[]) => (env[name] as (...x: unknown[]) => unknown)(...a);
  let uuidN = 0;

  const baseDeps = {
    cloudCtx: ctx, console: consoleMock, Date: DateMock,
    setTimeout: (cb: () => void, d: number) => clock.setTimeout(cb, d),
    clearTimeout: (id: number) => clock.clearTimeout(id),
    setInterval: (cb: () => void, d: number) => clock.setInterval(cb, d),
    clearInterval: (id: number) => clock.clearInterval(id),
    WebSocket: FakeWS,
    CLOUD_RETRY_BASE_MS: 3000, CLOUD_RETRY_MAX_MS: 30000, CHANNEL_DEAD_MS: 13000,
    BAKED_BRIDGE_TOKEN: "baked-tok",
    showToast: () => {}, loadCloudIdentity: () => {}, devId: () => "wb-mock", ckp: { publicKey: "pk" },
    serverBridgeToken: () => "tok", pendingPairOf: () => null,
    sendPairReq: () => {}, startPairWatchdog: () => {}, discoverRelay: () => {},
    // onCloudText 拟真（#268 复发 A' 批起）：可解析 JSON 帧 = _lastFrameAt/lastPong 刷新
    //（虚拟钟时刻！）+ 通道看门狗退役——真 onCloudTextRaw 的三个关键副作用；密文帧业务面
    // 本测试不涉。注意：必须用 clock.now——裸 Date.now() 是真时钟，虚拟钟下会成「未来帧」
    // 让看门狗「近期有帧」永久误判（P3 调试实录）
    onCloudText: (c: Record<string, unknown>, text: string) => {
      try { JSON.parse(text); c._lastFrameAt = clock.now; c.lastPong = clock.now; (late("stopChannelWatchdog") as (x: unknown) => void)(c); } catch {}
    },
    cloudUuid: () => "sid-" + (++uuidN),
    cloudPeerOf: late("cloudPeerOf"), // Inner/startPollTransport 都要判定 peer 就绪（晚绑定：env 先建后链）
    syncTeamBind: () => {}, renderCloudUI: () => {},
    setConn: (...a: unknown[]) => { setConnCalls.push(a); },
    window: { __ccDeck005Frames: { emit: () => {} } },
    escapeHtml: (s: string) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string),
  };

  // sendCloud 拟真（无 nacl）：ws 就绪才真发，poll 走 POST 面
  const sendCloud = (c: Record<string, unknown>, obj: { t?: string }) => {
    if (c.transport === "poll") { fetchCalls.push({ url: String(c.pollBase) + " [POST " + obj.t + "]" }); return true; }
    const w = c.ws as FakeWS | null;
    if (!w || w.readyState !== 1) return false;
    try { w.send(JSON.stringify(obj)); return true; } catch { return false; }
  };

  // fetch 拟真：ok=挂起等手动放行（模拟 wait=20 长轮询），netfail=立即 reject，auth401=401
  const fetchMock = (url: string, opts?: unknown) => {
    fetchCalls.push({ url, opts });
    if (fetchCtl.mode === "netfail") return Promise.reject(new Error("net down"));
    if (fetchCtl.mode === "auth401") return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    return new Promise((res) => { fetchCtl.respond.push(() => res({ ok: true, status: 200, json: async () => ({ frames: [] }) })); });
  };

  env.cloudPeerOf = link(peerOfBlock, ["cfg"], {});
  env.classifyCloudFail = link(classifyBlock, ["t"], {});
  env.cloudDiagNote = link(diagNoteBlock, ["kind", "detail", "isError"], { cloudCtx: ctx, cloudDiagLog: diagLog, console: consoleMock, Date: DateMock });
  env.cloudDiag = link(diagBlock, [], { cloudCtx: ctx, cloudDiagLog: diagLog });
  env.isCloudRetryable = link(blockFrom("function isCloudRetryable()"), [], { cloudCtx: ctx });
  env.cloudRetryBtn = link(blockFrom("function cloudRetryBtn()"), [], { isCloudRetryable: late("isCloudRetryable") });
  env.cloudDiagRowHtml = link(diagRowBlock, ["d", "mobile"], { escapeHtml: baseDeps.escapeHtml, cloudRetryBtn: late("cloudRetryBtn"), Date: DateMock });
  env.cloudSetConn = link(setConnBlock, ["status", "text", "kind"], {
    cloudCtx: ctx, cloudDiagNote: late("cloudDiagNote"), classifyCloudFail: late("classifyCloudFail"),
    syncTeamBind: baseDeps.syncTeamBind, setConn: baseDeps.setConn, renderCloudUI: baseDeps.renderCloudUI,
    window: baseDeps.window,
  });
  env.killWsTransport = link(killWsBlock, ["ctx"], {});
  env.stopChannelWatchdog = link(stopChanWdBlock, ["ctx"], baseDeps);
  env.scheduleCloudReconnect = link(reconnectBlock, ["ctx", "minDelayMs"], {
    ...baseDeps, cloudSetConn: late("cloudSetConn"), connectCloudFor: late("connectCloudFor"),
  });
  env.startChannelWatchdog = link(chanWdBlock, ["ctx"], {
    ...baseDeps, cloudSetConn: late("cloudSetConn"), cloudDiagNote: late("cloudDiagNote"),
    killWsTransport: late("killWsTransport"), scheduleCloudReconnect: late("scheduleCloudReconnect"),
  });
  env.stopCloudPing = link(stopPingBlock, ["ctx"], baseDeps);
  env.startCloudPing = link(pingBlock, ["ctx"], {
    ...baseDeps, sendCloud, stopCloudPing: late("stopCloudPing"), startChannelWatchdog: late("startChannelWatchdog"),
    cloudSetConn: late("cloudSetConn"),
    cloudDiagNote: late("cloudDiagNote"), killWsTransport: late("killWsTransport"),
    scheduleCloudReconnect: late("scheduleCloudReconnect"),
  });
  env.sendCloudHello = link(helloBlock, ["ctx"], {
    ...baseDeps, sendCloud, startChannelWatchdog: late("startChannelWatchdog"),
    cloudDiagNote: late("cloudDiagNote"), cloudSetConn: late("cloudSetConn"),
    killWsTransport: late("killWsTransport"), scheduleCloudReconnect: late("scheduleCloudReconnect"),
  });
  env.onCloudText = baseDeps.onCloudText; // P 组直驱用（w.onmessage 手工接线）
  env.pollLoop = link(pollLoopBlock, ["ctx"], {
    ...baseDeps, fetch: fetchMock, cloudSetConn: late("cloudSetConn"), cloudDiagNote: late("cloudDiagNote"),
    connectCloudFor: late("connectCloudFor"), scheduleCloudReconnect: late("scheduleCloudReconnect"),
    AbortSignal,
  }, true);
  env.startPollTransport = link(pollStartBlock, ["ctx", "base", "token", "dev", "pair"], {
    ...baseDeps, cloudSetConn: late("cloudSetConn"), sendCloudHello: late("sendCloudHello"),
    startCloudPing: late("startCloudPing"), pollLoop: late("pollLoop"),
  });
  env.connectCloudForInner = link(innerBlock, ["ctx", "manual"], {
    ...baseDeps, cloudSetConn: late("cloudSetConn"), startPollTransport: late("startPollTransport"),
    killWsTransport: late("killWsTransport"), stopChannelWatchdog: late("stopChannelWatchdog"),
    connectCloudFor: late("connectCloudFor"), cloudDiagNote: late("cloudDiagNote"),
    sendCloudHello: late("sendCloudHello"), startCloudPing: late("startCloudPing"),
    scheduleCloudReconnect: late("scheduleCloudReconnect"), // onclose 自然断路径直排重连
  });
  env.connectCloudFor = link(wrapperBlock, ["ctx", "manual"], {
    ...baseDeps, connectCloudForInner: late("connectCloudForInner"), cloudSetConn: late("cloudSetConn"),
    cloudDiagNote: late("cloudDiagNote"), scheduleCloudReconnect: late("scheduleCloudReconnect"),
  });
  return { h, env };
}
// 微任务排空（pollLoop 等 async 体内 await 后续拍）
async function tick(n = 8) { for (let i = 0; i < n; i++) await Promise.resolve(); }

// ---------- Z1 悬死握手：onopen/onclose 永不触发 → 8s 看门狗 → 收尸 → 降级轮询起跑 ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "hang");
  (env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);
  ok(!h.logs.some((l) => l.includes("通道启动异常")), "Z0 哨兵：状态机无同步异常（防假性降级污染断言）");
  ok(FakeWS.created.length === 1 && ctx.status === "connecting", "Z1 ws 建连进入连接中（悬死形态不炸）");
  h.clock.advance(7999);
  ok(ctx.transport === "ws" && FakeWS.created.length === 1, "Z1 8s 内不打扰（握手窗口完整）");
  h.clock.advance(1); // 8s 整
  ok(ctx.transport === "poll", "Z1 握手 8s 无响应 → 降级 poll（无 onclose 参与）");
  ok(ctx.ws === null, "Z1 悬死 socket 已收尸（ctx.ws 摘除）");
  await tick();
  const pollGets = h.fetchCalls.filter((f) => String(f.url).includes("/cloud-poll") && !String(f.url).includes("POST"));
  ok(pollGets.length >= 1, "Z1 pollLoop 已起跑（/cloud-poll GET 发出）——悬死→看门狗→poll 全链通");
  ok(ctx.status === "online" && String(ctx.statusText).includes("轮询"), "Z1 轮询通道直显已连接（轮询）");
}

// ---------- Z2+Z3 僵尸在线全链：open 后黑洞（close 无 onclose）→ 13s 判死 → 直排重连 → 二次判死 → poll 接管 ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "zombie");
  (env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);
  FakeWS.created[0].simulateOpen();
  ok(ctx.status === "online", "Z2 僵尸前正常在线（open→online+hello）");
  ok(FakeWS.created[0].sent.some((s) => s.includes('"hello"')), "Z2 hello 已发出（武装通道看门狗的锚）");
  h.clock.advance(13000);
  // #268 核心断言：判死后即使 onclose 永不触发，重连也必须已直排
  ok(ctx.ws === null, "Z2 13s 无回包判死即收尸（不等 onclose）");
  ok(ctx.wsFails === 1, "Z2 僵尸判定并入 wsFails 记账（=1）");
  ok(ctx.status === "connecting" && Number(ctx.retryAt) > h.clock.now, "Z2 重连已直排（retryAt 在未来——旧版此处零定时器永久停摆）");
  ok(FakeWS.created[0].closeCalled >= 1, "Z2 收尸口对僵尸 socket 调过 close（best-effort）");
  const verdict = h.logs.find((l) => l.includes("通道看门狗"));
  ok(!!verdict, "Z2 判死 verdict console 显形");
  h.clock.advance(3000); // 重连定时器触发
  ok(FakeWS.created.length === 2, "Z2 重连真发起了第二笔 ws（僵尸不死机）");
  FakeWS.created[1].simulateOpen();
  ok(ctx.status === "online", "Z3 第二笔连上（仍 ws 通道）");
  h.clock.advance(13000); // 第二次判死
  ok(ctx.wsFails === 2 && ctx.transport === "poll", "Z3 二次僵尸判定 → wsFails≥2 → 降级 poll");
  ok(ctx.ws === null, "Z3 二次收尸");
  h.clock.advance(3000); // 重连 → startPollTransport
  await tick();
  const pollGets = h.fetchCalls.filter((f) => String(f.url).includes("/cloud-poll") && !String(f.url).includes("POST"));
  ok(pollGets.length >= 1, "Z3 poll 接管：/cloud-poll GET 已发出（悬死→看门狗→重连→poll 全链闭合）");
  ok(String(ctx.pollBase).includes("/cloud-poll") && String(ctx.pollBase).includes("sid="), "Z3 轮询会话基址含 sid（会话面重建）");
}

// ---------- Z4 45s 心跳判死（僵尸形态）：收尸+直排重连（旧版裸 close 无排程） ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "zombie");
  // 隔离直驱：不走 connectCloudFor（13s 通道看门狗会抢跑），单验 45s 心跳判死路径
  const w = new FakeWS("wss://b/cloud?token=tok&dev=wb-mock");
  w.readyState = 1;
  ctx.ws = w;
  ctx.status = "online";
  (env.startCloudPing as (c: unknown) => void)(ctx);
  h.clock.advance(65000); // 20s ping ×3 + 45s 无 pong
  ok(ctx.ws === null, "Z4 心跳判死即收尸（45s 无 pong，僵尸 close 不等 onclose）");
  ok(ctx.status === "connecting" && Number(ctx.retryAt) > h.clock.now, "Z4 心跳判死直接排重连（旧版裸 close 零排程）");
  ok(Number(ctx.wsFails) >= 1, "Z4 心跳判死并入 wsFails 记账");
  const note = h.logs.find((l) => l.includes("心跳判死"));
  ok(!!note, "Z4 心跳判死 console 显形");
  ok(w.closeCalled >= 1, "Z4 收尸口对僵尸 socket 调过 close（best-effort）");
}

// ---------- P 组：#268 复发 A' 根治——稳态半开判死提速（ping 发出点武装看门狗） ----------
// 背景：公司 TLS 代理掐 ws 下行（上行通）→ 稳态只剩 45s 心跳判死 → 恢复窗 60s >> UI ack
// 阈值 8s → 窗内命令全报「未确认」但实际送达（1026 PM 实锤）。P1-a：ping 后 13s 无帧即判死。
// P1 稳态半开判死时刻：ping 发出 +13s（不再等 45s 心跳）
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "zombie");
  const w = new FakeWS("wss://b/cloud?token=tok&dev=wb-mock");
  w.readyState = 1;
  ctx.ws = w;
  ctx.status = "online";
  (env.startCloudPing as (c: unknown) => void)(ctx);
  h.clock.advance(19_999);
  ok(ctx.wsFails === 0 && ctx.status === "online", "P1 ping 前（<20s）不打扰");
  h.clock.advance(1); // t=20s：ping #1 发出 + 看门狗武装（半开起点：pong 永不回）
  ok(w.sent.some((s) => s.includes('"ping"')), "P1 ping 已发出");
  ok(!!ctx.helloTimer, "P1 ping 发出点武装通道看门狗（helloTimer 在岗）");
  h.clock.advance(13_000); // t=33s：pong 无回 → 判死
  ok(ctx.ws === null && Number(ctx.wsFails) === 1, "P1 稳态半开 ping 后 13s 即判死（修复前 45s 心跳——恢复窗主导项拔除）");
  ok(ctx.status === "connecting" && Number(ctx.retryAt) > h.clock.now, "P1 判死后收尸+重连直排");
  const note = h.logs.find((l) => l.includes("心跳判死") || l.includes("通道看门狗判死"));
  ok(!!note, "P1 判死 verdict console 显形");
}
// P2 安静系统 3 周期零误判：pong 秒级回 → 看门狗即退役，健康通道不被误杀
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "zombie");
  const w = new FakeWS("wss://b/cloud?token=tok&dev=wb-mock");
  w.readyState = 1;
  ctx.ws = w;
  ctx.status = "online";
  w.onmessage = (ev: { data: string }) => (env.onCloudText as (c: unknown, t: string) => void)(ctx, ev.data);
  (env.startCloudPing as (c: unknown) => void)(ctx);
  for (let cycle = 1; cycle <= 3; cycle++) {
    h.clock.advance(20_000); // 精确落在 ping 时刻：tick 触发（ping 发出 + 武装）
    ok(w.sent.filter((s) => s.includes('"ping"')).length === cycle, "P2 第 " + cycle + " 周期 ping 发出");
    if (cycle === 2) h.clock.advance(5_000); // 第 2 周期模拟 pong 慢 5s（仍在 13s 窗内，考验退役路径）
    w.simulateMessage('{"pong":' + cycle + "}"); // pong 到：_lastFrameAt 刷新 + 看门狗退役
    ok(ctx.status === "online" && Number(ctx.wsFails) === 0 && ctx.ws === w && !ctx.helloTimer,
      "P2 第 " + cycle + " 周期零误判（pong 到→看门狗退役 helloTimer=0；安静通道不被 ping 武装误杀）");
  }
}
// P3 全链：健康连接→半开（ping 无回）→判死×2→poll 接管，恢复窗 ≤35s（修复前 60s）
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "zombie");
  (env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);
  FakeWS.created[0].simulateOpen();
  ok(ctx.status === "online", "P3 健康期建连 online");
  FakeWS.created[0].simulateMessage('{"type":"SNAPSHOT_LIKE"}'); // hello 应答帧退役初连看门狗（稳态起点）
  h.clock.advance(20_000); // 稳态 ping #1 发出——此刻起半开（pong 永不回）
  const tBlack = h.clock.now;
  ok(!!ctx.helloTimer, "P3 半开起点：ping 已发+看门狗在岗");
  h.clock.advance(13_000); // 判死 #1（wsFails=1）→ 3s 重连
  ok(Number(ctx.wsFails) === 1, "P3 判死 #1（半开后 13s）");
  h.clock.advance(3_000); // 重连 → ws #2
  FakeWS.created[1].simulateOpen(); // 半开复现（onopen 达、回包死）
  h.clock.advance(13_000); // 判死 #2 → wsFails=2 → poll
  ok(ctx.transport === "poll", "P3 二次判死降级 poll");
  h.clock.advance(3_000); // poll 起跑
  await tick();
  const pollGets = h.fetchCalls.filter((f) => String(f.url).includes("/cloud-poll") && !String(f.url).includes("POST"));
  ok(pollGets.length >= 1, "P3 poll 接管（/cloud-poll GET 发出）");
  const recovery = h.clock.now - tBlack;
  ok(recovery <= 35_000, "P3 半开→poll 接管 ≤35s（实测 " + Math.round(recovery / 1000) + "s；修复前 60s——UI 8s 阈值误报窗大幅收窄）");
}

// ---------- H1 握手被拒（onclose 先于 open）：立即降级 poll ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "natural");
  (env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);
  FakeWS.created[0].readyState = 3;
  FakeWS.created[0].onclose && FakeWS.created[0].onclose({ code: 1006 });
  ok(ctx.transport === "poll", "H1 握手被拒 → switchToPoll（既有语义保持）");
  await tick();
  const pollGets = h.fetchCalls.filter((f) => String(f.url).includes("/cloud-poll") && !String(f.url).includes("POST"));
  ok(pollGets.length >= 1, "H1 poll 立即起跑");
}

// ---------- H2 自然闪断 ×2 → 降级 poll（wsFails 既有语义保持） ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "natural");
  (env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);
  FakeWS.created[0].simulateOpen();
  FakeWS.created[0].close(); // onclose code 1005（natural 模式触发）
  ok(ctx.wsFails === 1 && ctx.transport === "ws", "H2 首次闪断只记账不降级（3s 重连 ws）");
  h.clock.advance(3000);
  ok(FakeWS.created.length === 2, "H2 闪断后重连");
  FakeWS.created[1].simulateOpen();
  FakeWS.created[1].close();
  ok(ctx.wsFails === 2 && ctx.transport === "poll", "H2 二次闪断 → 降级 poll（连上又断=疑似代理掐）");
  h.clock.advance(3000);
  await tick();
  const pollGets = h.fetchCalls.filter((f) => String(f.url).includes("/cloud-poll") && !String(f.url).includes("POST"));
  ok(pollGets.length >= 1, "H2 降级后 poll 起跑");
}

// ---------- P1 轮询 GET 401 自愈（自定义 token 回退烘焙值 + transport 回 ws） ----------
{
  const ctx = mkCtx({ cfg: { id: "s1", name: "云桥", kind: "cloud", wsUrl: "wss://bridge.example/cloud", token: "custom-tok", cloud: { rd: "rl-1", rk: "rk-1", paired: true } } });
  ctx.transport = "poll";
  ctx.pollGen = 1;
  ctx.pollBase = "https://bridge.example/cloud-poll?token=custom-tok&dev=wb-mock&sid=sid-1";
  const { h, env } = buildHarness(ctx, "natural");
  h.fetchCtl.mode = "auth401";
  const p = (env.pollLoop as (c: unknown) => Promise<void>)(ctx);
  await tick(12);
  ok((ctx.cfg as { token: string }).token === "baked-tok", "P1 401 自愈：自定义 token 回退烘焙值");
  ok((ctx.cfg as { cloud: { token?: string } }).cloud.token === "baked-tok", "P1 cloud 子对象 token 同步回退");
  ok(ctx.transport === "ws", "P1 自愈后 transport 回 ws（重走 WS 优先）");
  ok(FakeWS.created.length === 1, "P1 自愈即重连（新 ws 已建）");
  await p.catch(() => {}); // gen 已翻，循环退出
}

// ---------- P2 轮询网络持续失败：状态显形 + 循环仍活 ----------
{
  const ctx = mkCtx();
  ctx.transport = "poll";
  ctx.pollGen = 1;
  ctx.pollBase = "https://bridge.example/cloud-poll?token=tok&dev=wb-mock&sid=sid-1";
  const { h, env } = buildHarness(ctx, "natural");
  h.fetchCtl.mode = "netfail";
  void (env.pollLoop as (c: unknown) => Promise<void>)(ctx);
  await tick(12); // 第 1 次 GET 立即失败 → 4s 等待（netFails=1）
  h.clock.advance(4000); await tick(12); // 第 2 次（netFails=2）
  const afterSecond = h.fetchCalls.length;
  h.clock.advance(4000); await tick(12); // 第 3 次（netFails=3 ≥3 → 显形）
  ok(ctx.status === "connecting" && String(ctx.statusText).includes("网络不通"), "P2 持续失败显形「网络不通，重试中」（不静默）");
  h.clock.advance(4000); await tick(12); // 第 4 次
  ok(h.fetchCalls.length >= afterSecond + 2, "P2 循环不死：4s 节奏持续重试（poll 标记≠循环死）");
}

// ---------- D1 诊断快照字段完备且随迁移刷新 ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "zombie");
  (env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);
  FakeWS.created[0].simulateOpen();
  h.clock.advance(13000); // 判死
  h.clock.advance(3000); // 重连 → 仍 ws（wsFails=1）
  FakeWS.created[1].simulateOpen();
  h.clock.advance(13000); // 二次判死 → poll
  const d = (env.cloudDiag as () => Record<string, unknown>)();
  ok(d.transport === "poll", "D1 快照 transport 反映降级后状态");
  ok(d.wsFails === 2, "D1 快照失败计数 wsFails=2");
  const wd = d.watchdog as Record<string, string>;
  ok(wd.handshake === "idle" && wd.channel === "idle" && wd.pair === "idle", "D1 三看门狗武装态可读（判死后 idle）");
  const le = d.lastError as { text: string } | null;
  ok(!!le && le.text.includes("hello 后") && le.text.includes("降级"), "D1 最后错误=判死 verdict（含降级去向）");
  ok(Array.isArray(d.log) && (d.log as unknown[]).length >= 2, "D1 迁移账本 ring 有留痕");
  ok(h.logs.some((l) => l.includes("[cloud:diag⚠]")), "D1 诊断留痕 console 显形（⚠ 错误级）");
}

// ---------- D2 cloudDiagNote 去重 + lastError 演进 ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "natural");
  const note = env.cloudDiagNote as (k: string, d: string, e?: boolean) => void;
  note("状态 connecting", "连接中");
  note("状态 connecting", "连接中"); // 重复
  note("轮询 GET 失败", "HTTP 500", true);
  ok((h.diagLog as unknown[]).length === 2, "D2 连续同迁移去重（ring 不灌水）");
  const le = ctx.diagLastError as { text: string };
  ok(le.text === "HTTP 500", "D2 错误级留痕落 lastError（面板最后错误行数据源）");
  ok(h.logs.filter((l) => l.includes("轮询 GET 失败")).length === 1, "D2 每条新迁移恰好一条 console.log");
}

// ---------- R1 诊断面板行渲染（桌面/移动双形） ----------
{
  const ctx = mkCtx();
  const { h, env } = buildHarness(ctx, "natural");
  ctx.transport = "poll"; ctx.wsFails = 2; ctx.postFails = 1; ctx.retryAt = h.clock.now + 9000; ctx.status = "connecting";
  const d = (env.cloudDiag as () => Record<string, unknown>)();
  const rowDesktop = (env.cloudDiagRowHtml as (d: unknown, m: boolean) => string)((env.cloudDiag as () => unknown)(), false);
  const rowMobile = (env.cloudDiagRowHtml as (d: unknown, m: boolean) => string)((env.cloudDiag as () => unknown)(), true);
  for (const [html, tag] of [[rowDesktop, "桌面"], [rowMobile, "移动"]] as [string, string][]) {
    ok(html.includes("HTTP 轮询"), "R1 " + tag + "面板显示当前通道=HTTP 轮询");
    ok(html.includes("ws×2") && html.includes("上行×1"), "R1 " + tag + "面板显示失败计数");
    ok(html.includes("重试") || html.includes("下次"), "R1 " + tag + "面板带行动出口（重试/倒计时）");
    ok(!html.includes("undefined") && !html.includes("NaN"), "R1 " + tag + "面板无未定义字段泄漏");
    ok(html.includes("最后错误") || html.includes("最近帧"), "R1 " + tag + "面板显示最后错误/最近帧行");
  }
  ok(rowDesktop.includes('data-cloud-diag') && rowDesktop.includes("settings-row"), "R1 桌面形挂 settings-row 容器");
  ok(rowMobile.includes('data-cloud-diag') && rowMobile.includes("mobile-task"), "R1 移动形挂 mobile-task 容器");
  void d; void ctx;
}

// ---------- S 组：结构闸（防回退锁） ----------
ok(bodyOf(chanWdBlock).includes("killWsTransport(ctx)") && bodyOf(chanWdBlock).includes("scheduleCloudReconnect(ctx)"),
  "S1 通道看门狗死路径=收尸+直排重连（不再押 onclose）");
ok(!bodyOf(chanWdBlock).includes("onclose → scheduleCloudReconnect"), "S1 旧注释「onclose → scheduleCloudReconnect」已退役");
ok(bodyOf(pingBlock).includes("killWsTransport(ctx)") && bodyOf(pingBlock).includes("scheduleCloudReconnect(ctx)"),
  "S2 心跳判死路径同口径（收尸+直排重连）");
ok(bodyOf(pingBlock).includes("startChannelWatchdog(ctx)"),
  "S6 ping 发出点武装通道看门狗（#268 复发 A' P1-a 防回退锁——稳态半开判死 45s→13s 的本体）");
ok(bodyOf(helloBlock).includes("killWsTransport(ctx)"), "S3 hello 发送失败路径收尸（不赌 onclose）");
{
  const visZone = sd.slice(sd.indexOf("document.addEventListener(\"visibilitychange\""), sd.indexOf("function classifyCloudFail"));
  ok(visZone.includes("killWsTransport(cloudCtx)") && visZone.includes("scheduleCloudReconnect(cloudCtx)"),
    "S4 回前台 8s 探测判死路径同口径（收尸+直排重连）");
}
{
  const cloudZone = sd.slice(sd.indexOf("const cloudCtx = {"), sd.indexOf("// ---------- 配对入口"));
  const bareCloses = cloudZone.match(/ctx\.ws && ctx\.ws\.close\(\)/g) || [];
  ok(bareCloses.length === 0, "S5 云链区零裸 close 残留（全部走收尸口）");
}
ok(sd.includes("html += cloudDiagRowHtml(cloudDiag(), false);") && sd.includes("html += cloudDiagRowHtml(cloudDiag(), true);"),
  "S5 诊断面板已接线（桌面 settings 行 + 移动 lane 双落点）");

// ---------- R2 面板接线行为断言：设置行/移动 lane 真渲染出诊断行 ----------
{
  const ctx = mkCtx();
  const { env } = buildHarness(ctx, "natural");
  const rowsBlock = blockFrom("function cloudSettingsRows()");
  const laneBlock = blockFrom("function cloudMobileLaneInner()");
  const sharedDeps = {
    cloudUIOn: () => true, // 云链激活态（面板出现的前提）
    cloudSharedCloudServers: () => [{ id: "s1", name: "云桥", wsUrl: "wss://bridge.example/cloud" }], // 移动 lane 空列表提前 return，给一条走正路
    sdelServerRows: () => "", // 服务器行渲染不在本断言范围
    cloudPeerOf: env.cloudPeerOf, cloudCtx: ctx, cloudDiag: env.cloudDiag,
    cloudDiagRowHtml: env.cloudDiagRowHtml, escapeHtml: (s: string) => String(s),
    relayNameRowHtml: () => "", viewSource: () => "local", cloudMode: false,
    ckp: { publicKey: "pk" }, devId: () => "wb-mock",
  };
  const rows = (link(rowsBlock, [], sharedDeps) as () => string)();
  const lane = (link(laneBlock, [], sharedDeps) as () => string)();
  ok(rows.includes('data-cloud-diag') && rows.includes("通道诊断"), "R2 桌面设置行渲染出通道诊断面板（行为级接线，非 grep）");
  ok(lane.includes('data-cloud-diag') && lane.includes("通道诊断"), "R2 移动 lane 渲染出通道诊断面板");
  ok(!rows.includes("undefined"), "R2 渲染无未定义泄漏");
}
ok(sd.includes("window.__ccDeck005CloudDiag = cloudDiag"), "S5 诊断快照只读挂钩已挂（域脚本/测试借道）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
