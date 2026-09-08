import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { listModels } from "./models.js";
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
  "COMMAND_LOGIN_GRANT",
  "COMMAND_WATCH_GRANT",
  "COMMAND_PERM",
  "COMMAND_MODEL",
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
  const qrJs = join(webRoot, "web-console", "qr.js");
  const mobileDir = join(webRoot, "mobile") + sep;
  // web-console PWA 资产白名单（manifest 引用的文件；此前 404 → 加主屏无图标/无 manifest）
  const PWA_ASSETS: Record<string, string> = {
    "/manifest.json": "application/manifest+json; charset=utf-8",
    "/apple-touch-icon.png": "image/png",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
    "/maskable-512.png": "image/png",
  };

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
    // #316 审查修复：待配对手表连接未鉴权，不计入"手机在线"——否则配对连接会让
    // 提问/权限门控误判有手机在场，挂起等一个不存在的审批方
    hasClients: () =>
      [...wss.clients].some((c) => c.readyState === WebSocket.OPEN && !(c as ClientWs).pairing) ||
      !!opts.cloudHasPhones?.(),
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
    // 手机浏览器不再跳 /m：web-console 自带 720px 移动端布局（#169 PWA 路线），
    // /m 仅保留给旧主屏图标，页面自身跳回根路径
    if (req.method === "GET" && url.pathname === "/") {
      if (!existsSync(consoleHtml)) {
        res.writeHead(503).end("web-console/index.html 不存在（步骤 6 生成）");
        return;
      }
      const html = readFileSync(consoleHtml);
      // no-store：控制台是单文件全量替换（无哈希资产名），浏览器启发式缓存会
      // 让 relay 升级后的 LAN 用户一直看旧页（token 换代 → 莫名 401）
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/nacl.js") {
      // web-console 云桥模式依赖的 tweetnacl（页面 <script src="/nacl.js">）
      if (!existsSync(naclJs)) {
        res.writeHead(503).end("web-console/nacl.js 不存在（cp node_modules/tweetnacl/nacl-fast.min.js）");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(naclJs));
      return;
    }
    if (req.method === "GET" && url.pathname === "/qr.js") {
      // #325 扫码登录的二维码编码器（页面 <script src="/qr.js">）；此前白名单漏了
      // 此路由 → 404 → QRCode 未定义 → 点击按钮静默抛错不弹窗（2026-09-07 用户实测踩中）
      if (!existsSync(qrJs)) {
        res.writeHead(503).end("web-console/qr.js 不存在");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(qrJs));
      return;
    }
    if (req.method === "GET" && PWA_ASSETS[url.pathname]) {
      const file = join(webRoot, "web-console", url.pathname.slice(1));
      if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": PWA_ASSETS[url.pathname] }).end(readFileSync(file));
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
    // #393 手动通知（LAN token 鉴权）：body {session_id?, done: string[]} → 该会话（缺省
    // 取最新 WORKING/外部会话）悬浮框弹 TASK_DONE。答疑/联调实测悬浮框用
    if (req.method === "POST" && url.pathname === "/api/notify") {
      void handleNotify(req, res, mgr, cfg);
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
    // #316 手表配对信道：?pair=1 无 token（手表 mDNS 发现后走此路，等手机比对 6 位码授权）。
    // 连接标记 pairing=true：不订事件、不收命令，授权通过才把 token 发给它自行重连正规信道
    const pairing = url.searchParams.get("pair") === "1";
    if (!pairing && (url.searchParams.get("token") ?? "") !== cfg.token) {
      console.log(`[ws-upgrade] reject: token mismatch`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    console.log(`[ws-upgrade] accepted${pairing ? " (pairing)" : ""}`);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, url));
  });

  // ── #316 手表配对池：PAIR_REQUEST/PAIR_RESOLVED 是瞬态帧（seq:0 不进 EventBus，
  // 不落 events.ndjson），只直播给 LAN 已鉴权客户端；授权命令同样只在 ws-server 层消化
  const PAIR_TTL_MS = 120_000;
  const watchPairings = new Map<
    string,
    { name: string; code: string; ws: WebSocket; timer: ReturnType<typeof setTimeout> }
  >();
  const lanBroadcast = (obj: unknown): void => {
    const text = JSON.stringify(obj);
    for (const client of wss.clients) {
      if ((client as ClientWs).pairing) continue;
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  };
  const pairResolvedFrame = (requestId: string, decision: "allow" | "deny" | "timeout") =>
    lanBroadcast({ seq: 0, session_id: "", ts: Date.now(), type: "PAIR_RESOLVED", payload: { request_id: requestId, decision } });
  function resolvePairing(requestId: string, decision: "allow" | "deny" | "timeout"): void {
    const p = watchPairings.get(requestId);
    if (!p) return;
    watchPairings.delete(requestId);
    clearTimeout(p.timer);
    try {
      if (decision === "allow") p.ws.send(JSON.stringify({ type: "PAIR_OK", token: cfg.token }));
      else if (decision === "deny") p.ws.send(JSON.stringify({ type: "PAIR_DENY" }));
      else p.ws.send(JSON.stringify({ type: "PAIR_TIMEOUT" }));
    } catch {}
    // 给帧留出 flush 时间再关；watch 拿到 token 自行断开重连正规信道
    setTimeout(() => {
      try {
        p.ws.close();
      } catch {
        try {
          p.ws.terminate();
        } catch {}
      }
    }, 400);
    pairResolvedFrame(requestId, decision);
    console.log(`[pair] watch pairing ${requestId} -> ${decision}`);
  }
  function startWatchPairing(ws: WebSocket, url: URL): void {
    // 未鉴权标记必须最先打：池满拒绝路径也要带着它走（close 握手可被扣住 ~30s，
    // 期间 bus/lanBroadcast 会把全部会话事件漏给这条连接——#316 审查 Critical）
    (ws as ClientWs).pairing = true;
    if (watchPairings.size >= 5) {
      // 并发待配对池上限：防 LAN 内恶意设备刷请求轰炸手机弹窗
      try { ws.send(JSON.stringify({ type: "PAIR_DENY", reason: "配对请求过多，请稍后再试" })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    const requestId = randomUUID();
    const name = (url.searchParams.get("name") ?? "手表").slice(0, 24);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const entry = { name, code, ws, timer: setTimeout(() => resolvePairing(requestId, "timeout"), PAIR_TTL_MS) };
    watchPairings.set(requestId, entry);
    ws.on("close", () => {
      // 手表放弃（断开）：清池并通知手机收弹窗
      if (watchPairings.get(requestId)?.ws === ws) {
        watchPairings.delete(requestId);
        clearTimeout(entry.timer);
        pairResolvedFrame(requestId, "timeout");
      }
    });
    try {
      ws.send(JSON.stringify({ type: "PAIR_PENDING", request_id: requestId, code, expires_in: Math.floor(PAIR_TTL_MS / 1000) }));
    } catch {}
    lanBroadcast({
      seq: 0, session_id: "", ts: Date.now(), type: "PAIR_REQUEST",
      payload: { request_id: requestId, name, code, expires_in: Math.floor(PAIR_TTL_MS / 1000) },
    });
    console.log(`[pair] watch pairing request id=${requestId} name=${name}`);
  }

  wss.on("connection", (ws: WebSocket, url: URL) => {
    const clientId = `web-${connectionCounter++}`;
    (ws as ClientWs).isAlive = true;
    ws.on("pong", () => {
      (ws as ClientWs).isAlive = true;
    });
    ws.on("error", () => undefined);

    if (url.searchParams.get("pair") === "1") {
      startWatchPairing(ws, url);
      return;
    }

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
        payload: { sessions: mgr.snapshot(), logs: mgr.snapshotLogs(), server_time: Date.now(), homedir: homedir(), models: listModels(mgr.cfg.model) },
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
      // #316 手表配对授权：ws-server 层消化（持有待配对池），不进 mgr
      if (cmd.type === "COMMAND_WATCH_GRANT") {
        const p = cmd.payload as { request_id?: unknown; allow?: unknown };
        const rid = typeof p.request_id === "string" ? p.request_id : "";
        if (!watchPairings.has(rid)) {
          ws.send(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: false, error: "配对请求不存在或已过期" }));
          return;
        }
        resolvePairing(rid, p.allow ? "allow" : "deny");
        ws.send(JSON.stringify({ type: "COMMAND_ACK", command_id: cmd.command_id, ok: true }));
        return;
      }
      const ack = mgr.handleCommand(cmd, clientId);
      ws.send(JSON.stringify({ type: "COMMAND_ACK", ...ack }));
    });
  });

  // 全局事件广播（#316：待配对手表未鉴权，不收事件）
  const unsubscribe = bus.subscribe((env) => {
    const text = JSON.stringify(env);
    for (const client of wss.clients) {
      if ((client as ClientWs).pairing) continue;
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

// #393 /api/notify：手动注入 TASK_DONE（悬浮框通知），LAN token 鉴权
async function handleNotify(
  req: IncomingMessage,
  res: ServerResponse,
  mgr: SessionManager,
  cfg: RelayConfig,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if ((url.searchParams.get("token") ?? "") !== cfg.token) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  let body = "";
  req.setEncoding("utf-8");
  for await (const chunk of req) body += chunk;
  try {
    const p = JSON.parse(body) as { session_id?: string; done?: unknown; mode?: string; text?: unknown };
    // #393 mode=confirm：黄框 [待确认] 推送（text 单条），否则绿框 TASK_DONE（done 列表）
    if (p.mode === "confirm") {
      const text = typeof p.text === "string" ? p.text.trim().slice(0, 120) : "";
      if (!text) { res.writeHead(400).end('{"error":"text 不能为空"}'); return; }
      const sessions = mgr.snapshot();
      const target =
        (p.session_id ? sessions.find((s) => s.session_id === p.session_id) : undefined) ||
        sessions.find((s) => s.status === "WORKING" && s.external) ||
        sessions.find((s) => s.external) ||
        sessions[0];
      if (!target) { res.writeHead(503).end('{"error":"无可投递会话"}'); return; }
      mgr.notifyConfirm(target.session_id, text);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode: "confirm", session_id: target.session_id }));
      return;
    }
    const items = Array.isArray(p.done) ? p.done.filter((x): x is string => typeof x === "string" && !!x).slice(0, 10) : [];
    if (!items.length) { res.writeHead(400).end('{"error":"done 不能为空"}'); return; }
    const sessions = mgr.snapshot();
    const target =
      (p.session_id ? sessions.find((s) => s.session_id === p.session_id) : undefined) ||
      sessions.find((s) => s.status === "WORKING" && s.external) ||
      sessions.find((s) => s.external) ||
      sessions[0];
    if (!target) { res.writeHead(503).end('{"error":"无可投递会话"}'); return; }
    const remaining = target.todos ? target.todos.filter((t) => t.status !== "completed").length : 0;
    mgr.notifyDone(target.session_id, items, remaining);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, session_id: target.session_id }));
  } catch {
    res.writeHead(400).end('{"error":"bad json"}');
  }
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
  pairing?: boolean; // #316 待配对手表（/ws?pair=1）：未鉴权，不收事件、不发命令
}

let connectionCounter = 0;
