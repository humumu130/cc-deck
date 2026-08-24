import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { CloudRouter } from "./router.js";

const HEARTBEAT_MS = 30_000;

// Node 形态云桥：HTTP upgrade 鉴权（/cloud?token=&dev=）后交 CloudRouter。
// 桥不持久化任何状态，重启即清空（补发由 relay 的 seq 机制负责）。
export function startCloudServer(port: number, token: string): {
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, devices: router.devs() }),
      );
      return;
    }
    res.writeHead(404).end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const dev = url.searchParams.get("dev") ?? "";
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
      router.register(connId, dev);
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

  return {
    port,
    router,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of socks.values()) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

interface HbWs extends WebSocket {
  isAlive: boolean;
}

function main(): void {
  const cfg = loadConfig();
  startCloudServer(cfg.port, cfg.token);
  console.log(`[cloud-bridge] listening :${cfg.port} path=/cloud`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
