// #258 配对确认（pair_ack）丢失自愈——前端 pendingPair 状态机行为断言。
// 范式：静态锚 + 真源码抽取直跑（test-005-servers blockFrom 同范式）——靶子
// web-console/js/settings-domain.js（W-SPLIT-S4b 起云链唯一真身，index-005.html 只挂 <script>）。
//
// 事故背景（1026 用户实锤）：公司 Windows 端输码，relay 侧已 paired，pair_ack 经云桥下行
// 丢失 → 前端卡「配对进行中」。旧版看门狗耗尽后 3s 快速重连恰落在 30s 配对退避窗内，
// onopen 跳过 sendPairReq 且不起看门狗——无看门狗/无重连定时器/无心跳，三无停摆。
//
// 断言组：
//   A1 补查恒发：onopen 配对态（含退避窗深处）必发一查 + 起看门狗（1026 根因回归）
//   A2 已配对设备重连直显：有身份无 pendingPair → 直落 online + hello，不发 pair_req
//   A3 空码信标语义保持：pc="" 恒发
//   B1 看门狗耗尽：3 次重发后 offline(pair) + 退避 30s 并入重连延迟（scheduleCloudReconnect 第二参）
//   B2 成功即清：peer 变化即清 timer + pairBackoffMs/pairNextAt 归零，不落 offline
//   B3 指数退避封顶：30s→60s→…→900s 封顶
//   B4 minDelay 并入重连延迟：delay=max(常规退避, minDelay)，常规退避自增不受污染
//   S1-S3 结构闸：onopen/poll 无 pairNextAt 拦截、耗尽并退避、ack 成功清退避
//
// 纯静态抽取 + eval 直跑：无桥/无 relay/无网络/无 CCR_DATA_DIR 副作用。
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-258-pair-selfheal.ts
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
// 平衡花括号整函数提取（blockFrom 范式）：锚串起、配对 } 止
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
// eval 成函数：param 名单与函数体自由变量一一对应（sloppy mode：内联 opened= 赋值成全局无害）
function evalFn(block: string, params: string[], args: unknown[]): (...a: unknown[]) => unknown {
  // eslint-disable-next-line no-new-func
  const f = new Function(...params, block.slice(block.indexOf("{") + 1, block.lastIndexOf("}")));
  return (...a: unknown[]) => f(...(a.length ? a : args));
}

console.log("#258 配对自愈——settings-domain.js 状态机（源码抽取直跑）");

// ---------- 抽取：connectCloudFor → onopen 体 ----------
const connectBlock = blockFrom("function connectCloudFor(ctx, manual)");
ok(!!connectBlock, "锚定 connectCloudFor 函数体");
const onopenNeedle = "w.onopen = () => {";
const onopenBlock = blockFrom(onopenNeedle, connectBlock);
ok(!!onopenBlock, "锚定云链 onopen 体（connectCloudFor 内，区别于 483 行 LAN onopen）");
const watchdogBlock = blockFrom("function startPairWatchdog(ctx)");
ok(!!watchdogBlock, "锚定 startPairWatchdog 函数体");
const reconnectBlock = blockFrom("function scheduleCloudReconnect(ctx, minDelayMs)");
ok(!!reconnectBlock, "锚定 scheduleCloudReconnect(ctx, minDelayMs)（#258 第二参签名）");
const pollBlock = blockFrom("function startPollTransport(ctx, base, token, dev, pair)");
ok(!!pollBlock, "锚定 startPollTransport 函数体");

// onopen 体剥掉 "w.onopen = () =>" 前缀再 eval
const onopenBody = onopenBlock.slice(onopenBlock.indexOf("{") + 1, onopenBlock.lastIndexOf("}"));

function mkOnopenStubCtx(over: Record<string, unknown> = {}) {
  return Object.assign(
    {
      ws: { tag: "w" }, hsTimer: 0, reconnectDelay: 3000, transport: "ws",
      discTried: false, sessions: new Map(), lastSeq: 7,
      pairNextAt: 0, pairBackoffMs: 0, pendingPair: null,
    },
    over,
  ) as Record<string, unknown>;
}
interface Stubs { calls: Record<string, unknown[][]>; discoverRelay: (...a: unknown[]) => void; sendPairReq: (...a: unknown[]) => void; startPairWatchdog: (...a: unknown[]) => void; cloudSetConn: (...a: unknown[]) => void; sendCloud: (...a: unknown[]) => void; startCloudPing: (...a: unknown[]) => void }
function runOnopen(ctx: Record<string, unknown>, peer: unknown, pair: unknown, stubs: Stubs) {
  const f = new Function(
    "ctx", "w", "peer", "pair", "dev", "CLOUD_RETRY_BASE_MS", "clearTimeout",
    "discoverRelay", "sendPairReq", "startPairWatchdog", "cloudSetConn", "sendCloud", "startCloudPing",
    onopenBody,
  );
  f(ctx, ctx.ws, peer, pair, "wb-mock", 3000, () => {}, stubs.discoverRelay, stubs.sendPairReq, stubs.startPairWatchdog, stubs.cloudSetConn, stubs.sendCloud, stubs.startCloudPing);
}
function mkStubs(): Stubs {
  const calls: Record<string, unknown[][]> = { sendPairReq: [], startPairWatchdog: [], cloudSetConn: [], sendCloud: [], startCloudPing: [], discoverRelay: [] };
  return {
    calls,
    discoverRelay: (...a: unknown[]) => { calls.discoverRelay.push(a); },
    sendPairReq: (...a: unknown[]) => { calls.sendPairReq.push(a); },
    startPairWatchdog: (...a: unknown[]) => { calls.startPairWatchdog.push(a); },
    cloudSetConn: (...a: unknown[]) => { calls.cloudSetConn.push(a); },
    sendCloud: (...a: unknown[]) => { calls.sendCloud.push(a); },
    startCloudPing: (...a: unknown[]) => { calls.startCloudPing.push(a); },
  };
}

// ---------- A1 补查恒发（1026 根因回归：退避窗深处开门必发一查） ----------
{
  const stubs = mkStubs();
  const ctx = mkOnopenStubCtx({ pairNextAt: Date.now() + 60_000 }); // 退避窗最深处
  runOnopen(ctx, null, { pc: "87654321", rd: "rl-x", rk: "rk" }, stubs);
  ok(stubs.calls.sendPairReq.length === 1, "A1 退避窗内 onopen 仍补发一查 pair_req（旧版此处跳过=三无停摆）");
  ok(stubs.calls.startPairWatchdog.length === 1, "A1 退避窗内 onopen 仍起配对看门狗（重试驱动不缺席）");
  ok(stubs.calls.cloudSetConn.length === 0 && stubs.calls.sendCloud.length === 0, "A1 未配对不落 online/不发 hello");
}

// ---------- A2 已配对设备重连直显 ----------
{
  const stubs = mkStubs();
  const ctx = mkOnopenStubCtx();
  runOnopen(ctx, { relay_dev: "rl-x", relay_pubkey: "rk" }, null, stubs);
  ok(stubs.calls.sendPairReq.length === 0, "A2 已配对（有身份无 pendingPair）不发 pair_req");
  const conn = stubs.calls.cloudSetConn[0] as unknown[];
  ok(!!conn && conn[0] === "online", "A2 直落 online（重连直显，不经配对中）");
  const helloArgs = (stubs.calls.sendCloud[0] ?? []) as unknown[];
  const hello = helloArgs[1] as { t?: string } | undefined;
  ok(!!hello && hello.t === "hello", "A2 立发 hello 进业务恢复");
  ok(stubs.calls.startCloudPing.length === 1, "A2 心跳即起");
}

// ---------- A3 空码信标语义保持 ----------
{
  const stubs = mkStubs();
  const ctx = mkOnopenStubCtx();
  runOnopen(ctx, null, { pc: "", rd: "rl-x", rk: "rk" }, stubs);
  ok(stubs.calls.sendPairReq.length === 1 && stubs.calls.startPairWatchdog.length === 1, "A3 空码信标恒发恒起（语义保持）");
}

// ---------- B 组：看门狗（mock setInterval 手动驱动） ----------
interface WatchCtx { cfg: Record<string, unknown>; pendingPair: Record<string, unknown> | null; pairTimer: number; pairNextAt: number; pairBackoffMs: number; [k: string]: unknown }
function runWatchdogRounds(ctx: WatchCtx, rounds: number, peerOf: () => { relay_dev: string } | null) {
  // 返回每轮记录：{ backoffMs, minDelayArg, offline }
  const log: { backoffMs: number; minDelay: number; offline: unknown[] | null; resends: number }[] = [];
  for (let r = 0; r < rounds; r++) {
    const drv: { cb: null | (() => void) } = { cb: null };
    let resends = 0;
    const reconnectArgs: unknown[][] = [];
    const connCalls: unknown[][] = [];
    let cleared = 0;
    const f = new Function(
      "ctx", "setInterval", "clearInterval", "cloudPeerOf", "cloudSetConn", "scheduleCloudReconnect",
      "showToast", "pendingPairOf", "sendPairReq", "devId", "ckp", "console",
      watchdogBlock.slice(watchdogBlock.indexOf("{") + 1, watchdogBlock.lastIndexOf("}")),
    );
    f(
      ctx,
      (cb: () => void) => { drv.cb = cb; return 1 as unknown as number; },
      () => { cleared++; },
      peerOf,
      (...a: unknown[]) => { connCalls.push(a); },
      (...a: unknown[]) => { reconnectArgs.push(a); },
      () => {},
      () => null,
      () => { resends++; },
      () => "wb-mock",
      { publicKey: "pk" },
      { log: () => {} },
    );
    // 驱动 4 拍（8/16/24s 重发 + 第 4 拍耗尽），或 peer 变化提前清
    for (let t = 0; t < 4 && drv.cb; t++) drv.cb();
    log.push({
      backoffMs: ctx.pairBackoffMs as number,
      minDelay: reconnectArgs.length ? (reconnectArgs[0][1] as number) : -1,
      offline: connCalls.find((c) => c[0] === "offline") ?? null,
      resends,
    });
    void cleared;
  }
  return log;
}

// B1 耗尽：3 次重发 → offline(pair) + 30s 退避并入重连
{
  const ctx: WatchCtx = { cfg: { id: "s1" }, pendingPair: { pc: "12345678", rd: "rl-x" }, pairTimer: 0, pairNextAt: 0, pairBackoffMs: 0 };
  const [r1] = runWatchdogRounds(ctx, 1, () => null);
  ok(r1.resends === 3, "B1 耗尽前恰重发 3 次 pair_req（8s 节奏）");
  ok(r1.backoffMs === 30_000, "B1 首轮退避 30s");
  ok(r1.minDelay === 30_000, "B1 退避并入重连延迟（scheduleCloudReconnect(ctx, 30000)——重连开门时窗已过）");
  const off = r1.offline as unknown[] | null;
  ok(!!off && off[0] === "offline" && off[2] === "pair", "B1 耗尽落 offline + failKind=pair（不引导输码）");
  ok(ctx.pairNextAt > Date.now() + 29_000 && ctx.pairNextAt <= Date.now() + 31_000, "B1 pairNextAt≈now+30s");
}

// B2 成功即清：peer 变化 → 清 timer + 退避归零，不落 offline
{
  const ctx: WatchCtx = { cfg: { id: "s2" }, pendingPair: { pc: "12345678", rd: "rl-old" }, pairTimer: 0, pairNextAt: Date.now() + 120_000, pairBackoffMs: 120_000 };
  // 第 3 拍起 relay 侧身份到位（新 rd ≠ peerBefore=rl-old）
  let n = 0;
  const log = runWatchdogRounds(ctx, 1, () => (++n >= 3 ? { relay_dev: "rl-new" } : null));
  ok(ctx.pairBackoffMs === 0 && ctx.pairNextAt === 0, "B2 新身份到手即清退避（成功即清，下次满速）");
  ok(log[0].offline === null, "B2 成功路径不落 offline");
}

// B3 指数退避封顶：30s→60s→120s→240s→480s→900s→900s
{
  const ctx: WatchCtx = { cfg: { id: "s3" }, pendingPair: { pc: "12345678", rd: "rl-x" }, pairTimer: 0, pairNextAt: 0, pairBackoffMs: 0 };
  const log = runWatchdogRounds(ctx, 7, () => null);
  const seq = log.map((r) => r.backoffMs);
  ok(JSON.stringify(seq) === JSON.stringify([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]), "B3 指数退避 30s 起步 15min 封顶（" + seq.join(",") + "）");
  ok(log.every((r) => r.minDelay === r.backoffMs), "B3 每轮退避都并入重连延迟（自愈循环无需用户动作）");
}

// ---------- B4 minDelay 并入 scheduleCloudReconnect ----------
{
  const timers: { cb: () => void; delay: number }[] = [];
  const connCalls: unknown[][] = [];
  const f = new Function(
    "ctx", "minDelayMs", "CLOUD_RETRY_BASE_MS", "CLOUD_RETRY_MAX_MS", "cloudSetConn", "setTimeout", "connectCloudFor", "cloudCtx",
    reconnectBlock.slice(reconnectBlock.indexOf("{") + 1, reconnectBlock.lastIndexOf("}")),
  );
  const ctx = { cfg: { wsUrl: "wss://b/cloud" }, failKind: "pair", reconnectDelay: 3000, reconnectTimer: 0, retryAt: 0, retryNote: "", statusText: "" };
  f(ctx, 60_000, 3000, 30_000, (...a: unknown[]) => { connCalls.push(a); }, (cb: () => void, delay: number) => { timers.push({ cb, delay }); return 1; }, () => {}, ctx);
  ok(timers.length === 1 && timers[0].delay === 60_000, "B4 minDelay=60s 并入重连延迟（常规 3s 让位）");
  ok(ctx.retryAt > Date.now() + 59_000, "B4 retryAt 按并入后延迟计时（倒计时文案不骗人）");
  ok(ctx.reconnectDelay === 6000, "B4 常规退避自增不受 minDelay 污染（3000→6000）");
  f(ctx, undefined, 3000, 30_000, (...a: unknown[]) => { connCalls.push(a); }, (cb: () => void, delay: number) => { timers.push({ cb, delay }); return 2; }, () => {}, ctx);
  ok(timers[1].delay === 6000, "B4 无 minDelay 时按常规退避走（6000）");
}

// ---------- S 组：结构闸（防回退锁） ----------
ok(!onopenBody.includes("pairNextAt"), "S1 onopen 配对态无退避窗拦截（1026 根因位不复辟）");
ok(!pollBlock.includes("pairNextAt") && pollBlock.includes("sendPairReq(ctx, pair, dev)") && pollBlock.includes("startPairWatchdog(ctx)"), "S1 轮询传输同口径：开门补发无退避窗拦截");
ok(watchdogBlock.includes("scheduleCloudReconnect(ctx, ctx.pairBackoffMs)"), "S2 看门狗耗尽把退避时长传给重连调度");
{
  const ackIdx = sd.indexOf('inner.t === "pair_ack"');
  const clearIdx = sd.indexOf("ctx.pairNextAt = 0; ctx.pairBackoffMs = 0;", ackIdx);
  ok(ackIdx >= 0 && clearIdx > ackIdx, "S3 pair_ack 成功分支清配对退避（成功即清）");
}
ok(sd.includes("function scheduleCloudReconnect(ctx, minDelayMs)") && sd.includes("Math.max(ctx.reconnectDelay || CLOUD_RETRY_BASE_MS, minDelayMs || 0)"), "S2 minDelay 语义=Math.max 并入");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
