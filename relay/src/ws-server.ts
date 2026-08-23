import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConfig } from "./config.js";
import type { Command, CommandAckPayload, Envelope } from "./types.js";

const COMMAND_TYPES = new Set([
  "COMMAND_CREATE",
  "COMMAND_MESSAGE",
  "COMMAND_STOP",
  "COMMAND_CONTINUE",
  "COMMAND_REJECT",
]);

const HEARTBEAT_MS = 30_000;

// 连接策略：
//  - 新客户端（无 last_seq）：发 SNAPSHOT 全量会话快照，之后收实时事件
//  - 重连客户端（last_seq 在缓冲内）：只补发 seq > last_seq 的事件
//  - last_seq 落后到缓冲外：退化为 SNAPSHOT 重建（客户端应重置本地状态）
export function startServer(
  bus: EventBus,
  mgr: SessionManager,
  cfg: RelayConfig,
): { port: number; close: () => Promise<void> } {
  const consoleHtml = fileURLToPath(new URL("../../web-console/index.html", import.meta.url));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      if (!existsSync(consoleHtml)) {
        res.writeHead(503).end("web-console/index.html 不存在（步骤 6 生成）");
        return;
      }
      const html = readFileSync(consoleHtml);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if ((url.searchParams.get("token") ?? "") !== cfg.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
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

  server.listen(cfg.port);

  return {
    port: cfg.port,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        unsubscribe();
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

interface ClientWs extends WebSocket {
  isAlive: boolean;
}

let connectionCounter = 0;
