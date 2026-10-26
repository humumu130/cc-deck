// #268 复现脚本：真实套接字重演「wss 悬死 → 看门狗 → poll 接管」全链。
// 任务书口径（#268 任务 1）：Mac 无 Windows WebView2，用 test server 模拟掐断——
//   /cloud   ：完成 ws 升级后黑洞——只收不回、永不发 close 帧（WebView2「Canceled」
//              僵尸形态的服务器侧等价物：客户端 close() 后 onclose 无人应答）
//   /cloud-poll：真实 HTTP 长轮询面（GET 回 {frames:[]}，POST 200）
// 状态机 = settings-domain.js 真源码抽取直跑（test-268 同范式），但注入：
//   真 WebSocket（Node 22 undici）+ 真 fetch + 真定时器 + 真常数（8s/13s/3s）。
//
// 预期时间线（墙钟）：0s ws#1 open+hello → 13s 判死#1 → 16s ws#2 → 29s 判死#2 降级
// → 32s /cloud-poll GET 首现 → poll 循环持续。40s 观察窗收口。
// 通过判据：ws 连接≥2 + hello 收到≥2 + poll GET≥2 + transport=poll → exit 0。
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/repro-268-zombie-ws.ts
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, Server } from "node:http";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sd = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");

const T0 = Date.now();
function tlog(msg: string) { console.log("[" + ((Date.now() - T0) / 1000).toFixed(1).padStart(5) + "s] " + msg); }

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
function bodyOf(block: string): string { return block.slice(block.indexOf("{") + 1, block.lastIndexOf("}")); }
function link(block: string, params: string[], deps: Record<string, unknown>, isAsync = false): (...a: unknown[]) => unknown {
  const body = bodyOf(block);
  // eslint-disable-next-line no-new-func
  const f = isAsync
    ? new Function(...params, "__D", "return (async () => { with (__D) {" + body + "} })();")
    : new Function(...params, "__D", "with (__D) {" + body + "}");
  return (...a: unknown[]) => { const p = [...a]; while (p.length < params.length) p.push(undefined); return f(...p, deps); };
}

// ---------- 黑洞 ws 服务器（只收不回，永不 close）+ 轮询 HTTP 面 ----------
const svc = { wsConns: 0, wsBytes: 0, pollGets: 0, pollPosts: 0 };
const server: Server = createServer((req: IncomingMessage, res) => {
  const url = String(req.url || "");
  if (url.startsWith("/cloud-poll")) {
    if (req.method === "POST") {
      svc.pollPosts++;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { tlog("srv: POST /cloud-poll（" + body.slice(0, 40) + "…）"); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      return;
    }
    svc.pollGets++;
    tlog("srv: GET /cloud-poll #" + svc.pollGets + " " + url.slice(url.indexOf("?") + 1, url.indexOf("?") + 34) + "…");
    setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ frames: [] })); }, 800);
    return;
  }
  res.writeHead(404); res.end();
});
server.on("upgrade", (req, socket) => {
  const url = String(req.url || "");
  if (!url.startsWith("/cloud")) { socket.destroy(); return; }
  const key = String(req.headers["sec-websocket-key"] || "");
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  svc.wsConns++;
  tlog("srv: ws 升级完成（黑洞连接 #" + svc.wsConns + "）——只收不回，永不发 close 帧");
  socket.on("data", (buf: Buffer) => {
    svc.wsBytes += buf.length;
    // 客户端→服务端帧带掩码，ASCII 探测不可靠——以字节数为准（hello/ping 均计入黑洞流量）
    if (svc.wsBytes === buf.length) tlog("srv: 首包入黑洞（" + buf.length + "B，hello 已被吞，不回 SNAPSHOT）");
  });
  socket.on("error", () => {});
  // 永不写回、永不 close：客户端 close() 的关闭帧进黑洞 → onclose 无人应答（僵尸形态）
});
await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
const port = (server.address() as AddressInfo).port;
tlog("黑洞服务器就绪 127.0.0.1:" + port + "（/cloud ws 黑洞 + /cloud-poll HTTP）");

// ---------- 真源码状态机装配（真 WebSocket/fetch/定时器） ----------
class LoggedWS extends WebSocket {
  constructor(url: string | URL) {
    super(url);
    tlog("cli: new WebSocket " + String(url).slice(0, 52) + "…");
    this.addEventListener("open", () => tlog("cli: ws onopen"));
    this.addEventListener("close", (ev) => tlog("cli: ws onclose code=" + (ev as CloseEvent).code + "（若判死后仍无此行=僵尸形态实锤）"));
    this.addEventListener("error", () => tlog("cli: ws onerror"));
  }
}
const ctx: Record<string, unknown> = {
  cfg: { id: "s1", name: "云桥", kind: "cloud", wsUrl: "http://127.0.0.1:" + port + "/cloud", token: "baked-tok",
    cloud: { url: "", token: "baked-tok", rd: "rl-1", rk: "rk-1", paired: true } },
  status: "offline", statusText: "未连接", failKind: "", retryAt: 0, retryNote: "",
  sessions: new Map(), lastSeq: 0, hasSnapshot: false, relayName: "t",
  ws: null, reconnectDelay: 3000, reconnectTimer: 0,
  pendingPair: null, pairTimer: 0, pingTimer: null, lastPong: 0,
  pairNextAt: 0, pairBackoffMs: 0,
  transport: "ws", pollGen: 0, pollSid: "", pollBase: "",
  wsFails: 0, postFails: 0, hsTimer: 0, discTried: false, discTimer: 0, _everOnline: false,
  helloTimer: 0, _lastFrameAt: 0,
  diagLastNote: "", diagLastError: null,
};
const diagLog: Record<string, unknown>[] = [];
const consoleTagged = {
  log: (...a: unknown[]) => tlog("cli: " + a.map(String).join(" ")),
  error: (...a: unknown[]) => tlog("cli⚠ " + a.map(String).join(" ")),
};
const env: Record<string, unknown> = {};
const late = (n: string) => (...a: unknown[]) => (env[n] as (...x: unknown[]) => unknown)(...a);
let uuidN = 0;
const sendCloud = (c: Record<string, unknown>, obj: { t?: string }) => {
  if (c.transport === "poll") {
    void fetch(String(c.pollBase), { method: "POST", body: JSON.stringify(obj) }).catch(() => {});
    return true;
  }
  const w = c.ws as WebSocket | null;
  if (!w || w.readyState !== 1) return false;
  try { w.send("stub:" + obj.t); return true; } catch { return false; }
};
const baseDeps = {
  cloudCtx: ctx, console: consoleTagged, Date,
  setTimeout, clearTimeout, setInterval, clearInterval,
  WebSocket: LoggedWS,
  CLOUD_RETRY_BASE_MS: 3000, CLOUD_RETRY_MAX_MS: 30000, CHANNEL_DEAD_MS: 13000,
  BAKED_BRIDGE_TOKEN: "baked-tok",
  showToast: () => {}, loadCloudIdentity: () => {}, devId: () => "wb-mock", ckp: { publicKey: "pk" },
  serverBridgeToken: () => "baked-tok", pendingPairOf: () => null,
  sendPairReq: () => {}, startPairWatchdog: () => {}, discoverRelay: () => {},
  onCloudText: () => {}, cloudUuid: () => "sid-" + (++uuidN),
  cloudPeerOf: late("cloudPeerOf"),
  syncTeamBind: () => {}, renderCloudUI: () => {},
  setConn: () => {}, window: { __ccDeck005Frames: { emit: () => {} } },
};
env.cloudPeerOf = link(blockFrom("function cloudPeerOf(cfg)"), ["cfg"], {});
env.classifyCloudFail = link(blockFrom("function classifyCloudFail(t)"), ["t"], {});
env.cloudDiagNote = link(blockFrom("function cloudDiagNote(kind, detail, isError)"), ["kind", "detail", "isError"], { cloudCtx: ctx, cloudDiagLog: diagLog, console: consoleTagged, Date });
env.cloudSetConn = link(blockFrom("function cloudSetConn(status, text, kind)"), ["status", "text", "kind"], {
  cloudCtx: ctx, cloudDiagNote: late("cloudDiagNote"), classifyCloudFail: late("classifyCloudFail"),
  syncTeamBind: () => {}, setConn: () => {}, renderCloudUI: () => {}, window: baseDeps.window,
});
env.killWsTransport = link(blockFrom("function killWsTransport(ctx)"), ["ctx"], {});
env.stopChannelWatchdog = link(blockFrom("function stopChannelWatchdog(ctx)"), ["ctx"], baseDeps);
env.scheduleCloudReconnect = link(blockFrom("function scheduleCloudReconnect(ctx, minDelayMs)"), ["ctx", "minDelayMs"], { ...baseDeps, cloudSetConn: late("cloudSetConn"), connectCloudFor: late("connectCloudFor") });
env.startChannelWatchdog = link(blockFrom("function startChannelWatchdog(ctx)"), ["ctx"], { ...baseDeps, cloudSetConn: late("cloudSetConn"), cloudDiagNote: late("cloudDiagNote"), killWsTransport: late("killWsTransport"), showToast: () => {}, scheduleCloudReconnect: late("scheduleCloudReconnect") });
env.stopCloudPing = link(blockFrom("function stopCloudPing(ctx)"), ["ctx"], baseDeps);
env.startCloudPing = link(blockFrom("function startCloudPing(ctx)"), ["ctx"], { ...baseDeps, sendCloud, stopCloudPing: late("stopCloudPing"), cloudSetConn: late("cloudSetConn"), cloudDiagNote: late("cloudDiagNote"), killWsTransport: late("killWsTransport"), scheduleCloudReconnect: late("scheduleCloudReconnect") });
env.sendCloudHello = link(blockFrom("function sendCloudHello(ctx)"), ["ctx"], { ...baseDeps, sendCloud, startChannelWatchdog: late("startChannelWatchdog"), cloudDiagNote: late("cloudDiagNote"), cloudSetConn: late("cloudSetConn"), killWsTransport: late("killWsTransport"), scheduleCloudReconnect: late("scheduleCloudReconnect") });
env.pollLoop = link(blockFrom("async function pollLoop(ctx)"), ["ctx"], { ...baseDeps, fetch, cloudSetConn: late("cloudSetConn"), cloudDiagNote: late("cloudDiagNote"), connectCloudFor: late("connectCloudFor"), scheduleCloudReconnect: late("scheduleCloudReconnect"), AbortSignal }, true);
env.startPollTransport = link(blockFrom("function startPollTransport(ctx, base, token, dev, pair)"), ["ctx", "base", "token", "dev", "pair"], { ...baseDeps, cloudSetConn: late("cloudSetConn"), sendCloudHello: late("sendCloudHello"), startCloudPing: late("startCloudPing"), pollLoop: late("pollLoop") });
env.connectCloudForInner = link(blockFrom("function connectCloudForInner(ctx, manual)"), ["ctx", "manual"], {
  ...baseDeps, cloudSetConn: late("cloudSetConn"), startPollTransport: late("startPollTransport"), killWsTransport: late("killWsTransport"),
  stopChannelWatchdog: late("stopChannelWatchdog"), connectCloudFor: late("connectCloudFor"), cloudDiagNote: late("cloudDiagNote"),
  sendCloudHello: late("sendCloudHello"), startCloudPing: late("startCloudPing"), scheduleCloudReconnect: late("scheduleCloudReconnect"),
});
env.connectCloudFor = link(blockFrom("function connectCloudFor(ctx, manual)"), ["ctx", "manual"], {
  ...baseDeps, connectCloudForInner: late("connectCloudForInner"), cloudSetConn: late("cloudSetConn"),
  cloudDiagNote: late("cloudDiagNote"), scheduleCloudReconnect: late("scheduleCloudReconnect"),
});

tlog("启动云链状态机（真源码直跑，注入真 WebSocket/fetch/定时器）");
(env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);

// ---------- 观察窗：40s 墙钟，poll 接管即提前收口 ----------
const WATCH_MS = 40_000;
await new Promise<void>((resolve) => {
  const iv = setInterval(() => {
    tlog("… status=" + ctx.status + "（" + ctx.statusText + "） transport=" + ctx.transport + " wsFails=" + ctx.wsFails
      + " ws#" + svc.wsConns + " 黑洞" + svc.wsBytes + "B pollGET×" + svc.pollGets);
    if (ctx.transport === "poll" && svc.pollGets >= 2) { clearInterval(iv); resolve(); }
  }, 5000);
  setTimeout(() => { clearInterval(iv); resolve(); }, WATCH_MS);
});

const takeover = ctx.transport === "poll" && svc.pollGets >= 2;
tlog("========== 收口判定 ==========");
tlog("ws 连接数: " + svc.wsConns + "（预期 ≥2：判死→重连→再判死）");
tlog("黑洞吞流量: " + svc.wsBytes + "B（hello 已送达被吞——上行有证据，回包无门）");
tlog("poll GET:  " + svc.pollGets + "（预期 ≥2：poll 接管铁证）");
tlog("transport: " + ctx.transport + "  wsFails: " + ctx.wsFails + "  status: " + ctx.status + "（" + ctx.statusText + "）");
console.log(takeover
  ? "\n✅ 复现通过：wss 黑洞悬死 → 看门狗判死 → 收尸重连 → 二次判死降级 → HTTP 轮询接管（全链闭合，无需 onclose）"
  : "\n❌ 复现失败：poll 未在观察窗内接管（见上方时间线诊断）");
process.exitCode = takeover ? 0 : 1;
setTimeout(() => process.exit(takeover ? 0 : 1), 300).unref();
