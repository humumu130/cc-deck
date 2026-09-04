import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConfig } from "./config.js";
import { Bridge, parseGateTools } from "./bridge.js";
import type { BridgeEvent, Command, CommandAckPayload, Envelope } from "./types.js";

function localIps(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === "IPv4") out.add(ni.address);
  }
  return out;
}

const COMMAND_TYPES = new Set([
  "COMMAND_CREATE",
  "COMMAND_MESSAGE",
  "COMMAND_STOP",
  "COMMAND_CONTINUE",
  "COMMAND_REJECT",
  "COMMAND_EXT_MODE",
  "COMMAND_EXT_INPUT",
  "COMMAND_EXT_STOP",
  "COMMAND_DELETE",
  "COMMAND_RENAME",
  "COMMAND_ANSWER",
  "COMMAND_PAIR_START",
  "COMMAND_PAIR_CODE",
  "COMMAND_PERM",
  "COMMAND_REFRESH_TODOS",
  "COMMAND_TODO_HIDE",
]);

const HEARTBEAT_MS = 30_000;

export interface StartServerOptions {
  gateToolsRaw?: string;    // CCR_GATE_TOOLS，逗号分隔门控工具名
  holdMs?: number;          // PreToolUse 挂起上限（测试用短值）
  questionHoldMs?: number;  // AskUserQuestion 挂起窗口（测试用短值）
  cloudHasPhones?: () => boolean; // 云通道是否有活跃手机（计入"手机在线"门控）
  pairCodes?: { issue(): { code: string; expires_in: number } }; // 云桥配对码（网页端领码）
  onReady?: () => void;     // listen 成功后回调（daemon 模式在此时写 pid 文件，防端口被占时留下死 pid）
}

// 连接策略：
//  - 新客户端（无 last_seq）：发 SNAPSHOT 全量会话快照，之后收实时事件
//  - 重连客户端（last_seq 在缓冲内）：只补发 seq > last_seq 的事件
//  - last_seq 落后到缓冲外：退化为 SNAPSHOT 重建（客户端应重置本地状态）
export function startServer(
  bus: EventBus,
  mgr: SessionManager,
  cfg: RelayConfig,
  opts: StartServerOptions = {},
): { port: number; close: () => Promise<void>; bridge: Bridge } {
  // 静态根：插件 bundle（CC_DECK_PLUGIN define）= 插件根（scripts/../）；开发模式 = 仓库根（src/../../）
  const webRoot =
    process.env.CCR_WEB_ROOT ??
    ((process.env.CC_DECK_PLUGIN as string | undefined)
      ? fileURLToPath(new URL("../", import.meta.url))
      : fileURLToPath(new URL("../../", import.meta.url)));
  const consoleHtml = join(webRoot, "web-console", "index.html");
  const naclJs = join(webRoot, "web-console", "nacl.js");
  const mobileDir = join(webRoot, "mobile") + sep;

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".apk": "application/vnd.android.package-archive",
  };
  // /m 静态托管（移动端 App 壳），仅允许 mobile/ 目录内已知扩展
  const serveMobile = (url: URL, res: ServerResponse): boolean => {
    if (url.pathname !== "/m" && !url.pathname.startsWith("/m/")) return false;
    const rel = url.pathname === "/m" ? "index.html" : url.pathname.slice(3).replace(/^\/+/, "");
    if (!/^[\w.-]+$/.test(rel)) {
      res.writeHead(400).end("bad path");
      return true;
    }
    const file = mobileDir + rel;
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return true;
    }
    const ext = rel.slice(rel.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" }).end(readFileSync(file));
    return true;
  };

  const wss = new WebSocketServer({ noServer: true });
  const bridge = new Bridge(bus, mgr, {
    gateTools: parseGateTools(opts.gateToolsRaw ?? process.env.CCR_GATE_TOOLS),
    dataDir: cfg.dataDir,
    hasClients: () => [...wss.clients].some((c) => c.readyState === WebSocket.OPEN) || !!opts.cloudHasPhones?.(),
    holdMs: opts.holdMs,
    questionHoldMs: opts.questionHoldMs,
  });
  mgr.setBridge(bridge);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/bridge/hook") {
      void handleBridgeHook(req, res, bridge, cfg);
      return;
    }
    if (req.method === "GET" && serveMobile(url, res)) return;
    // 手机浏览器访问根路径时跳转移动端
    if (req.method === "GET" && url.pathname === "/" &&
        /Android|iPhone|iPad|Mobile/i.test(req.headers["user-agent"] ?? "")) {
      res.writeHead(302, { location: "/m" }).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      if (!existsSync(consoleHtml)) {
        res.writeHead(503).end("web-console/index.html 不存在（步骤 6 生成）");
        return;
      }
      const html = readFileSync(consoleHtml);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/nacl.js") {
      // web-console 云桥模式依赖的 tweetnacl（页面 <script src="/nacl.js">）
      if (!existsSync(naclJs)) {
        res.writeHead(503).end("web-console/nacl.js 不存在（cp node_modules/tweetnacl/nacl-fast.min.js）");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(readFileSync(naclJs));
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    // 同机零配置直连：本机浏览器打开 CC Deck 网页时探测本机 relay，直接拿连接参数。
    // 仅 loopback 请求放行；token 只回给可信 origin（我们的部署域/本机/本机 LAN IP 托管页），
    // 防止任意网页从 loopback 套取 token。Safari 不豁免 loopback 混合内容，会探测失败（回退手动）。
    if (req.method === "GET" && url.pathname === "/local-info") {
      const remote = req.socket.remoteAddress ?? "";
      const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const origin = (req.headers.origin ?? "").trim();
      const ips = localIps();
      const hostTrusted = (h: string) => h === "localhost" || h === "127.0.0.1" || ips.has(h);
      // 带 Origin（跨源页面）：白名单回显放行；无 Origin：同源 fetch / 本机进程，认 Host。
      // Host 浏览器不可伪造；能伪造的非浏览器进程本来就能直接读 token 文件，非此端点威胁面。
      let allowOrigin = "";
      if (origin) {
        try {
          const u = new URL(origin);
          if (u.origin === "https://cc.humumu.online" || hostTrusted(u.hostname)) allowOrigin = origin;
        } catch {}
      } else {
        const host = (req.headers.host ?? "").split(":")[0];
        if (hostTrusted(host)) allowOrigin = `http://${req.headers.host}`;
      }
      if (!isLoopback || !allowOrigin) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": allowOrigin,
        "cache-control": "no-store",
      }).end(JSON.stringify({ ok: true, port: cfg.port, token: cfg.token }));
      return;
    }
    // 领取配对码（--pair CLI / /cc-deck-pair 用）：loopback + bridgeToken，
    // 与 /bridge/hook 同信任模型（能读本机 bridge.json 的进程本就可信）
    if (req.method === "POST" && url.pathname === "/api/pair-issue") {
      const remote = req.socket.remoteAddress ?? "";
      const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!isLoopback || (req.headers["x-bridge-token"] ?? "") !== cfg.bridgeToken) {
        res.writeHead(403).end();
        return;
      }
      if (!opts.pairCodes) {
        res.writeHead(501).end("pairing not enabled");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opts.pairCodes.issue()));
      return;
    }
    // 云桥配对码（网页端首次配对用）：LAN token 鉴权，码一次性 30 秒有效
    if (req.method === "POST" && url.pathname === "/api/pair-code") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (!opts.pairCodes) {
        res.writeHead(501).end("pairing not enabled");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opts.pairCodes.issue()));
      return;
    }
    res.writeHead(404).end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    console.log(`[ws-upgrade] from=${req.socket.remoteAddress} path=${url.pathname}`);
    if (url.pathname !== "/ws") {
      console.log(`[ws-upgrade] reject: bad path`);
      socket.destroy();
      return;
    }
    if ((url.searchParams.get("token") ?? "") !== cfg.token) {
      console.log(`[ws-upgrade] reject: token mismatch`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    console.log(`[ws-upgrade] accepted`);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, url));
  });

  wss.on("connection", (ws: WebSocket, url: URL) => {
    const clientId = `web-${connectionCounter++}`;
    (ws as ClientWs).isAlive = true;
    ws.on("pong", () => {
      (ws as ClientWs).isAlive = true;
    });
    ws.on("error", () => undefined);

    const lastSeq = Number(url.searchParams.get("last_seq") ?? "0") || 0;
    if (lastSeq > 0 && !bus.isBeyondBuffer(lastSeq)) {
      for (const env of bus.replayAfter(lastSeq)) ws.send(JSON.stringify(env));
    } else {
      const snapshot: Envelope = {
        seq: bus.lastSeq(),
        session_id: "",
        ts: Date.now(),
        type: "SNAPSHOT",
        payload: { sessions: mgr.snapshot(), logs: mgr.snapshotLogs(), server_time: Date.now() },
      };
      ws.send(JSON.stringify(snapshot));
    }

    ws.on("message", (data) => {
      let cmd: Command;
      try {
        cmd = JSON.parse(String(data)) as Command;
      } catch {
        ws.send(JSON.stringify({ type: "COMMAND_ACK", command_id: "?", ok: false, error: "invalid JSON" }));
        return;
      }
      if (cmd && (cmd as { type?: string }).type === "PING") {
        // 手机应用层心跳（云/LAN 同协议）：探测 NAT 半开
        ws.send('{"type":"PONG"}');
        return;
      }
      if (
        !cmd ||
        typeof cmd.command_id !== "string" ||
        typeof cmd.type !== "string" ||
        !COMMAND_TYPES.has(cmd.type) ||
        typeof cmd.payload !== "object" ||
        cmd.payload === null
      ) {
        ws.send(
          JSON.stringify({
            type: "COMMAND_ACK",
            command_id: typeof cmd?.command_id === "string" ? cmd.command_id : "?",
            ok: false,
            error: "invalid command shape",
          }),
        );
        return;
      }
      const ack = mgr.handleCommand(cmd, clientId);
      ws.send(JSON.stringify({ type: "COMMAND_ACK", ...ack }));
    });
  });

  // 全局事件广播
  const unsubscribe = bus.subscribe((env) => {
    const text = JSON.stringify(env);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const c = client as ClientWs;
      if (!c.isAlive) {
        client.terminate();
        continue;
      }
      c.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);

  server.listen(cfg.port, opts.onReady);

  return {
    port: cfg.port,
    bridge,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        unsubscribe();
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

// hooks 桥接入口：仅本机回环 + bridge token；PreToolUse 可能长轮询挂起
async function handleBridgeHook(
  req: IncomingMessage,
  res: ServerResponse,
  bridge: Bridge,
  cfg: RelayConfig,
): Promise<void> {
  const remote = req.socket.remoteAddress ?? "";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopback || (req.headers["x-bridge-token"] ?? "") !== cfg.bridgeToken) {
    res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
    return;
  }
  let body = "";
  req.setEncoding("utf-8");
  for await (const chunk of req) body += chunk;
  try {
    const ev = JSON.parse(body) as BridgeEvent;
    const decision = await bridge.handleEvent(ev);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(decision));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    );
  }
}

interface ClientWs extends WebSocket {
  isAlive: boolean;
}

let connectionCounter = 0;
