import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { CloudRouter } from "./router.js";

// 网页端静态文件目录（仓库 web-console/，部署布局 /opt/cc-cloud-bridge/web-console/）
const webDir = (name: string) => fileURLToPath(new URL(`../web-console/${name}`, import.meta.url));

const HEARTBEAT_MS = 30_000;

// Node 形态云桥：HTTP upgrade 鉴权（/cloud?token=&dev=）后交 CloudRouter。
// 桥不持久化任何状态，重启即清空（补发由 relay 的 seq 机制负责）。
export function startCloudServer(port: number, token: string, extraPorts: number[] = []): {
  port: number;
  close: () => Promise<void>;
  router: CloudRouter;
} {
  const wss = new WebSocketServer({ noServer: true });
  const socks = new Map<string, WebSocket>();
  let nextId = 0;

  const router = new CloudRouter({
    hooks: {
      send: (connId, frame) => {
        const ws = socks.get(connId);
        if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
      },
      close: (connId, code, reason) => {
        socks.get(connId)?.close(code, reason);
      },
    },
    log: (m) => console.log(`[cloud-bridge] ${m}`),
  });

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, devices: router.devs() }),
      );
      return;
    }
    // 网页端托管（公司电脑浏览器）：页面与 nacl 静态文件，不含任何密钥——
    // E2E 密钥在浏览器 localStorage，桥 token 经配对链接的 fragment 送达
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const file = webDir("index.html");
      if (!existsSync(file)) {
        res.writeHead(503).end("web-console/index.html 不存在");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
      return;
    }
    if (req.method === "GET" && url.pathname === "/nacl.js") {
      const file = webDir("nacl.js");
      if (!existsSync(file)) {
        res.writeHead(503).end("web-console/nacl.js 不存在");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  };
  const server = createServer(onRequest);

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const dev = url.searchParams.get("dev") ?? "";
    const rk = url.searchParams.get("rk") ?? ""; // relay 连接上报公钥（发现帧下发，浏览器无需预知）
    if (
      url.pathname !== "/cloud" ||
      (url.searchParams.get("token") ?? "") !== token ||
      dev.length < 1 ||
      dev.length > 64
    ) {
      console.log(`[cloud-bridge] reject upgrade from=${req.socket.remoteAddress} path=${url.pathname}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connId = `c${++nextId}`;
      socks.set(connId, ws);
      (ws as HbWs).isAlive = true;
      ws.on("pong", () => {
        (ws as HbWs).isAlive = true;
      });
      ws.on("error", () => undefined);
      ws.on("close", () => {
        socks.delete(connId);
        router.unregister(connId);
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        router.handleFrame(connId, data.toString());
      });
      router.register(connId, dev, rk || undefined);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [connId, ws] of socks) {
      const c = ws as HbWs;
      if (!c.isAlive) {
        ws.terminate();
        continue;
      }
      c.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  server.listen(port);
  // 同一 net.Server 不能 listen 两次，附加端口各起一个实例、upgrade 事件转发给主实例
  const extras = extraPorts.map((p) => {
    const ex = createServer(onRequest);
    ex.on("upgrade", (req, socket, head) => server.emit("upgrade", req, socket, head));
    ex.listen(p);
    return ex;
  });

  return {
    port,
    router,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of socks.values()) ws.terminate();
        wss.close(() => {
          let pending = extras.length;
          const done = () => (--pending === 0 ? server.close(() => resolve()) : undefined);
          if (pending === 0) return server.close(() => resolve());
          for (const ex of extras) ex.close(done);
        });
      }),
  };
}

interface HbWs extends WebSocket {
  isAlive: boolean;
}

function main(): void {
  const cfg = loadConfig();
  startCloudServer(cfg.port, cfg.token, cfg.extraPorts);
  console.log(`[cloud-bridge] listening :${cfg.port}${cfg.extraPorts.map((p) => ` :${p}`).join("")} path=/cloud`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
