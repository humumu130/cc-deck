// #268 复发排查实证（A' 候选：稳态半开——上行通、下行死）——量化「恢复窗」。
// 背景：PM 报用户公司电脑 test.70 上行全达但 UI 恒报「命令未确认」——推演：半开连接
// （代理放行上行掐下行）下，稳态判死靠 45s 心跳（hello 看门狗只武装初连窗），恢复链
// 45s 判死+3s 重连+（新 ws 再死）45s+3s 才到 poll —— 恢复窗 ~100s >> UI 8s ack 阈值。
// 本脚本用真实套接鞋重演：服务器先正常回包（客户端转 online 稳态），T 秒后转黑洞
// （只收不回=下行死、上行达），量：判死 verdict 时刻 / 重连次数 / poll 接管时刻。
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/repro-268b-stale-dead.ts
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

// ---------- 服务器：正常回包（pong 语义）→ T 秒后转黑洞 ----------
// 帧全为掩码密文/桩串，服务器不解析——「正常期」下行走原始 ws 文本帧回显一条诊断帧即可
// （客户端 onCloudText 只认 JSON；回一条 {"type":"IGNORE"} 让 _lastFrameAt 刷新=通道活）。
const svc = { mode: "live" as "live" | "blackhole", wsConns: 0, uplinkBytes: 0, pollGets: 0, downlinkSent: 0 };
const server: Server = createServer((req: IncomingMessage, res) => {
  const url = String(req.url || "");
  if (url.startsWith("/cloud-poll")) {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { svc.uplinkBytes += body.length; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      return;
    }
    svc.pollGets++;
    tlog("srv: GET /cloud-poll #" + svc.pollGets);
    // 黑洞期：挂满 wait 不回帧（下行死）；正常期回一条活动帧
    const wait = Math.min(Number(new URL(url, "http://x").searchParams.get("wait") ?? "20") || 20, 25) * 1000;
    setTimeout(() => {
      const frames = svc.mode === "live" ? ['{"type":"KEEPALIVE"}'] : [];
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ frames }));
    }, svc.mode === "live" ? 800 : wait);
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
  const connN = svc.wsConns;
  tlog("srv: ws #" + connN + " 升级完成（mode=" + svc.mode + "）");
  socket.on("data", (buf: Buffer) => {
    svc.uplinkBytes += buf.length; // 上行恒达（黑洞=只收不回）
    if (svc.mode === "live" && svc.downlinkSent < 999) {
      // 正常期：回一条未掩码文本帧 {"type":"KEEPALIVE"}（服务器→客户端掩码位必须为 0）
      const payload = Buffer.from('{"type":"KEEPALIVE"}');
      const frame = Buffer.alloc(2 + payload.length);
      frame[0] = 0x81; frame[1] = payload.length; // FIN+text，mask 位 0（服务端帧不掩码）
      payload.copy(frame, 2);
      try { socket.write(frame); svc.downlinkSent++; } catch { /* 濒死 */ }
    }
  });
  socket.on("error", () => {});
});
await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
const port = (server.address() as AddressInfo).port;
tlog("服务器就绪 :" + port + "（先 live 回包，20s 后转黑洞=半开形态）");

// ---------- 真源码状态机（同 repro-268 装配） ----------
class LoggedWS extends WebSocket {
  constructor(url: string | URL) {
    super(url);
    this.addEventListener("close", (ev) => tlog("cli: ws onclose code=" + (ev as CloseEvent).code));
    this.addEventListener("error", () => {});
  }
}
const ctx: Record<string, unknown> = {
  cfg: { id: "s1", name: "云桥", kind: "cloud", wsUrl: "http://127.0.0.1:" + port + "/cloud", token: "baked-tok",
    cloud: { url: "", token: "baked-tok", rd: "rl-1", rk: "rk-1", paired: true } },
  status: "offline", statusText: "未连接", failKind: "", retryAt: 0, retryNote: "",
  sessions: new Map(), lastSeq: 0, hasSnapshot: false, relayName: "t",
  ws: null, reconnectDelay: 3000, reconnectTimer: 0, pendingPair: null, pairTimer: 0, pingTimer: null, lastPong: 0,
  pairNextAt: 0, pairBackoffMs: 0, transport: "ws", pollGen: 0, pollSid: "", pollBase: "",
  wsFails: 0, postFails: 0, hsTimer: 0, discTried: false, discTimer: 0, _everOnline: false,
  helloTimer: 0, _lastFrameAt: 0, diagLastNote: "", diagLastError: null,
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
  if (c.transport === "poll") { void fetch(String(c.pollBase), { method: "POST", body: JSON.stringify(obj) }).catch(() => {}); return true; }
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
  // onCloudText 拟真：可解析 JSON 帧 = _lastFrameAt 刷新 + 通道看门狗退役（真 onCloudTextRaw 的
  // 两个关键副作用；密文帧经 unseal 才有业务意义，此处 KEEPALIVE 明文帧走到这就够）
  onCloudText: (c: Record<string, unknown>, text: string) => {
    try { JSON.parse(text); c._lastFrameAt = Date.now(); (late("stopChannelWatchdog") as (x: unknown) => void)(c); } catch {}
  },
  cloudUuid: () => "sid-" + (++uuidN),
  cloudPeerOf: late("cloudPeerOf"), syncTeamBind: () => {}, renderCloudUI: () => {},
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
env.startCloudPing = link(blockFrom("function startCloudPing(ctx)"), ["ctx"], { ...baseDeps, sendCloud, stopCloudPing: late("stopCloudPing"), startChannelWatchdog: late("startChannelWatchdog"), cloudSetConn: late("cloudSetConn"), cloudDiagNote: late("cloudDiagNote"), killWsTransport: late("killWsTransport"), scheduleCloudReconnect: late("scheduleCloudReconnect") });
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

tlog("启动状态机（live 期：服务器回 KEEPALIVE 帧 → 客户端 online 稳态）");
(env.connectCloudFor as (c: unknown, m: boolean) => void)(ctx, false);

// 20s 后转黑洞（半开形态：上行仍收、下行停）
setTimeout(() => { svc.mode = "blackhole"; tlog(">>> 服务器转黑洞（半开：上行收、下行死）——用户发消息的 ack 从此断"); }, 20_000);

// 观察窗 150s：记录判死/重连/poll 接管时刻
const BLACK_AT = 20_000;
let pollAt = 0;
await new Promise<void>((resolve) => {
  const iv = setInterval(() => {
    tlog("… status=" + ctx.status + "（" + ctx.statusText + "） transport=" + ctx.transport + " wsFails=" + ctx.wsFails
      + " ws#" + svc.wsConns + " uplinkB=" + svc.uplinkBytes + " pollGET×" + svc.pollGets);
    if (!pollAt && ctx.transport === "poll" && svc.pollGets >= 1) { pollAt = Date.now() - T0; }
    if (pollAt && Date.now() - T0 - BLACK_AT > 90_000) { clearInterval(iv); resolve(); }
    if (Date.now() - T0 > 160_000) { clearInterval(iv); resolve(); } // 硬顶
  }, 5_000);
  setTimeout(() => { clearInterval(iv); resolve(); }, 160_000);
});

tlog("========== 收口 ==========");
tlog("黑洞起点: 20.0s");
tlog("poll 接管: " + (pollAt ? ((pollAt - BLACK_AT) / 1000).toFixed(1) + "s（黑洞后）" : "未接管（观察窗内）"));
tlog("结论: UI ack 阈值 8s << 恢复窗 " + (pollAt ? Math.round((pollAt - BLACK_AT) / 1000) : ">140") + "s —— 与「未确认」复发吻合度：" + (pollAt ? "高" : "需更长观察"));
process.exitCode = 0;
setTimeout(() => process.exit(0), 300).unref();
