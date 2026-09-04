import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { homedir, networkInterfaces } from "node:os";
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

// 内置 slash 命令表（手机/网页输入联想）：只列稳定核心集，desc 仅作提示文案
const BUILTIN_COMMANDS: { name: string; desc: string }[] = [
  { name: "compact", desc: "压缩对话历史，释放上下文" },
  { name: "clear", desc: "清空当前会话历史" },
  { name: "help", desc: "查看帮助" },
  { name: "model", desc: "查看/切换模型" },
  { name: "cost", desc: "当前会话 token 用量" },
  { name: "context", desc: "上下文使用概况" },
  { name: "memory", desc: "编辑项目记忆 CLAUDE.md" },
  { name: "init", desc: "为当前项目初始化 CLAUDE.md" },
  { name: "review", desc: "审查 PR / 代码变更" },
  { name: "resume", desc: "恢复历史会话" },
  { name: "rename", desc: "重命名当前会话" },
  { name: "export", desc: "导出当前会话记录" },
  { name: "todos", desc: "查看当前任务清单" },
  { name: "permissions", desc: "权限规则管理" },
  { name: "config", desc: "打开配置面板" },
  { name: "mcp", desc: "MCP 服务器管理" },
  { name: "statusline", desc: "状态栏配置" },
  { name: "output-style", desc: "切换输出风格" },
  { name: "add-dir", desc: "添加额外工作目录" },
  { name: "vim", desc: "切换 vim 按键模式" },
  { name: "doctor", desc: "Claude Code 健康检查" },
  { name: "login", desc: "切换账号" },
  { name: "bug", desc: "报告问题" },
  { name: "release-notes", desc: "查看更新日志" },
];

interface SlashCommand {
  name: string;
  desc: string;
  source: "builtin" | "user" | "project";
}

// 扫描自定义命令目录（~/.claude/commands 或 <cwd>/.claude/commands）：
// 文件名=命令名，子目录一层 namespace:name；desc 取 frontmatter description 或首个非空行
function listCustomCommands(dir: string, source: "user" | "project"): SlashCommand[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return [];
  }
  const descOf = (p: string): string => {
    try {
      const head = readFileSync(p, "utf-8").slice(0, 400);
      const m = /^description:\s*(.+)$/m.exec(head);
      if (m) return m[1].trim().slice(0, 80);
      const line = head.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("---"));
      return line ? line.trim().slice(0, 80) : "";
    } catch {
      return "";
    }
  };
  const out: SlashCommand[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md")) {
      out.push({ name: e.name.slice(0, -3), desc: descOf(join(dir, e.name)), source });
    } else if (e.isDirectory()) {
      try {
        for (const g of readdirSync(join(dir, e.name))) {
          if (g.endsWith(".md")) out.push({ name: `${e.name}:${g.slice(0, -3)}`, desc: descOf(join(dir, e.name, g)), source });
        }
      } catch {}
    }
  }
  return out;
}

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
      res.writeHead(302, { location: "/m" + (url.search || "") }).end(); // 保留 ?token= 等查询（丢了配对链接就废了）
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
    // 云桥配对码（网页端首次配对用）：LAN token 鉴权，码一次性 1 分钟有效（pairing.ts 默认 TTL）
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
    // Slash 命令列表（手机/网页输入联想）：内置表 + 用户级 ~/.claude/commands +
    // 项目级 <cwd>/.claude/commands（cwd 经 LAN token 鉴权后信任，与 WS 命令同信任级）
    if (req.method === "GET" && url.pathname === "/api/commands") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const cwd = url.searchParams.get("cwd") ?? "";
      const custom = [
        ...listCustomCommands(join(homedir(), ".claude", "commands"), "user"),
        ...(cwd ? listCustomCommands(join(cwd, ".claude", "commands"), "project") : []),
      ];
      // 自定义命令同名覆盖内置
      const seen = new Set(custom.map((c) => c.name));
      const commands: SlashCommand[] = [
        ...custom,
        ...BUILTIN_COMMANDS.filter((c) => !seen.has(c.name)).map((c) => ({ ...c, source: "builtin" as const })),
      ];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ ok: true, commands }));
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
    const replay = lastSeq > 0 && !bus.isBeyondBuffer(lastSeq) ? bus.replayAfter(lastSeq) : null;
    // 落后太多 = 客户端冷启动（内存空但 localStorage 存着旧 seq）：增量事件只能更新
    // 已知会话、建不出列表，且上千帧补发挤占带宽——超过阈值直接 SNAPSHOT 全量重建
    if (replay && replay.length <= 200) {
      for (const env of replay) ws.send(JSON.stringify(env));
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
