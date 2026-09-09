import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { join, dirname, sep } from "node:path";
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

// 浏览器 CORS 可信域白名单：网页控制台部署域。cc-deck.humumu.online 为新域（#411 根修）——
// 旧白名单只认 cc.humumu.online，网页开在新域时跨源读本机 /local-info、/api/pair-code
// 响应被浏览器静默拦截，「本机领码」必失败。新增部署域只需在此追加。
const TRUSTED_WEB_ORIGINS: readonly string[] = ["https://cc.humumu.online", "https://cc-deck.humumu.online"];

// #448 插件可选能力配置：~/.cc-deck/config.json 三键（guard-stop/guard-context hooks 与
// /api/plugin-config 端点共用）。缺省值与 hooks 侧 guard-lib.mjs 的 CONFIG_DEFAULTS 一致
const PLUGIN_CFG_KEYS = ["taskGuard", "qNotify", "restorePoint"] as const;
type PluginConfig = { taskGuard: boolean; qNotify: boolean; restorePoint: boolean };
function pluginConfigPath(): string {
  return join(homedir(), ".cc-deck", "config.json");
}
function readPluginConfig(): PluginConfig {
  const out: PluginConfig = { taskGuard: false, qNotify: true, restorePoint: false };
  try {
    const raw = JSON.parse(readFileSync(pluginConfigPath(), "utf-8")) as Record<string, unknown>;
    for (const k of PLUGIN_CFG_KEYS) if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
  } catch {}
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
  "COMMAND_PEERS",
  "COMMAND_PEER_KICK",
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
  pairCodes?: { issue(opts?: { code?: string; ttlMs?: number }): { code: string; expires_in: number } }; // 云桥配对码（网页端领码；管理员可指定码值/时长）
  cloudRelayDev?: () => string; // 云桥设备 id：随 SNAPSHOT relay_dev 下发，客户端据此合并同机 LAN/云条目
  cloudWanDev?: () => string; // F7 /wan 手表凭据 dev：随 SNAPSHOT wan_dev 下发，手机据此拼手表连接配置
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
      // #43 回环豁免：请求落在本机（Host=loopback）时 Origin 一律放行——本机页面/
      // webview（tauri/electron 的 Origin:null）领码 Failed to fetch 根修；本机到本机的跨源检查无安全意义
      const reqLb = (req.headers.host ?? "").split(":")[0] === "127.0.0.1" || (req.headers.host ?? "").split(":")[0] === "localhost";
      if (origin && reqLb) allowOrigin = origin === "null" ? "*" : origin;
      else if (origin) {
        try {
          const u = new URL(origin);
          if (TRUSTED_WEB_ORIGINS.includes(u.origin) || hostTrusted(u.hostname)) allowOrigin = origin;
        } catch {}
      } else {
        const host = (req.headers.host ?? "").split(":")[0];
        if (hostTrusted(host)) allowOrigin = `http://${req.headers.host}`;
      }
      if (!isLoopback || !allowOrigin) { res.writeHead(404).end(); return; }
      // #44 lanIp：本机 relay 直出添加手机二维码用（exe 本地打开的页面拿不到自身 LAN IP）。
      // 按网卡名过滤虚拟适配器（VMware/VirtualBox/Hyper-V/WSL 的 host-only 网段手机不可达）
      const virtualNic = /vmware|virtual|vethernet|wsl|loopback|tap|bluetooth/i;
      let lanIp = "";
      for (const [name, list] of Object.entries(networkInterfaces())) {
        if (virtualNic.test(name)) continue;
        for (const ni of list ?? []) {
          if (ni.family !== "IPv4" || /^(127\.|169\.254\.)/.test(ni.address)) continue;
          if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(ni.address)) { lanIp = ni.address; break; }
        }
        if (lanIp) break;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": allowOrigin,
        "cache-control": "no-store",
      }).end(JSON.stringify({ ok: true, port: cfg.port, token: cfg.token, lan_ip: lanIp }));
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
    // 云桥配对码（网页端首次配对用）：LAN token 鉴权，码一次性短时效
    //（pairing.ts 默认 5 分钟/CCR_PAIR_TTL_MS 可配；expires_in 随响应下发，端上动态渲染）
    if (req.method === "POST" && url.pathname === "/api/pair-code") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (!opts.pairCodes) {
        res.writeHead(501).end("pairing not enabled");
        return;
      }
      // #397 CORS：网页端「本机显示配对码」从云桥域页面跨源读本机响应——
      // 与 /local-info 同款可信 origin 白名单（我们的部署域/本机/本机 LAN IP），
      // 否则浏览器静默拦截响应，领码在部署域页面必失败（#411：新域 cc-deck.* 已入白名单）
      const origin = (req.headers.origin ?? "").trim();
      const ips = localIps();
      const hostOk = (h: string) => h === "localhost" || h === "127.0.0.1" || ips.has(h);
      let acao = "";
      // #43 回环豁免（同 /local-info）：exe webview Origin:null 直通
      const reqLb2 = (req.headers.host ?? "").split(":")[0] === "127.0.0.1" || (req.headers.host ?? "").split(":")[0] === "localhost";
      if (origin && reqLb2) acao = origin === "null" ? "*" : origin;
      else if (origin) {
        try {
          const u = new URL(origin);
          if (TRUSTED_WEB_ORIGINS.includes(u.origin) || hostOk(u.hostname)) acao = origin;
        } catch {}
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (acao) headers["access-control-allow-origin"] = acao;
      // 管理员可指定码值/时长（2026-09-09）：?code=789321&ttl=1200000（毫秒，下限 60s）
      const qCode = url.searchParams.get("code") ?? undefined;
      const qTtlRaw = Number(url.searchParams.get("ttl"));
      const qTtl = Number.isFinite(qTtlRaw) && qTtlRaw > 0 ? qTtlRaw : undefined;
      res
        .writeHead(200, headers)
        .end(JSON.stringify(opts.pairCodes.issue(qCode || qTtl ? { code: qCode, ttlMs: qTtl } : undefined)));
      return;
    }
    // #393 手动通知（LAN token 鉴权）：body {session_id?, done: string[]} → 该会话（缺省
    // 取最新 WORKING/外部会话）悬浮框弹 TASK_DONE。答疑/联调实测悬浮框用
    if (req.method === "POST" && url.pathname === "/api/notify") {
      void handleNotify(req, res, mgr, cfg);
      return;
    }
    // #448 插件可选能力配置（设置「插件」页三开关）：读写 ~/.cc-deck/config.json 的
    // taskGuard/qNotify/restorePoint。hooks（guard-stop/guard-context）与本端点共用该
    // 文件为单一事实源；缺省 taskGuard=false / qNotify=true / restorePoint=false。
    // 鉴权与 CORS 与 /api/pair-code 同款（LAN token + 部署域白名单 + #43 回环豁免）；
    // POST 参数走 query（?taskGuard=1）避免跨源 JSON body 触发预检。
    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/plugin-config") {
      if ((url.searchParams.get("token") ?? "") !== cfg.token) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      void handlePluginConfig(req, res);
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
      // #408 大帧根治：日志不再全量内联（随历史膨胀，实测 3 会话即 0.63MiB，规模
      // 上去必撞 CF 桥 1MiB 单帧硬限），改预算装配（每会话最近 K 条 + 总字节上限，
      // 与云通道同一构建）。客户端 timelines 接受截断语义；logs_truncated 标记供 UI 提示
      const snapLogs = mgr.buildSnapshotLogs();
      const snapshot: Envelope = {
        seq: bus.lastSeq(),
        session_id: "",
        ts: Date.now(),
        type: "SNAPSHOT",
        payload: {
          sessions: mgr.snapshot(),
          logs: snapLogs.logs,
          ...(Object.keys(snapLogs.logs_truncated).length ? { logs_truncated: snapLogs.logs_truncated } : {}),
          server_time: Date.now(),
          homedir: homedir(),
          models: listModels(mgr.cfg.model),
          // 云桥启用的 relay 附带自身设备 id（= CloudConfig.relayDev 同源值）：
          // 客户端据此密码学匹配"LAN 直连条目"与"云桥条目"是同一台 relay，自动合并。
          // wan_dev（F7）：手表 /wan 透传通道的凭据 dev，手机侧写进手表连接配置
          ...(opts.cloudRelayDev?.() ? { relay_dev: opts.cloudRelayDev() } : {}),
          ...(opts.cloudWanDev?.() ? { wan_dev: opts.cloudWanDev() } : {}),
        },
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
      // #45 三码体系·客户端间转发：手机「从手机导入」的回发帧（t=ccdeck-import-resp）
      // 不是命令——原样转发给同 relay 的其他已认证 ws 客户端（网页/exe 的导入监听器）
      if (cmd && (cmd as { t?: string }).t === "ccdeck-import-resp") {
        const raw = JSON.stringify(cmd);
        for (const c of wss.clients) {
          if (c !== ws && c.readyState === WebSocket.OPEN) c.send(raw);
        }
        ws.send('{"t":"ccdeck-import-resp-ack"}');
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

// #448 /api/plugin-config：GET 读三键；POST query/body 布尔值合并写（未知键保留、
// 无效值忽略）。token 鉴权在路由层完成；CORS 与 /api/pair-code 同款
async function handlePluginConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = (req.headers.origin ?? "").trim();
  const ips = localIps();
  const hostOk = (h: string) => h === "localhost" || h === "127.0.0.1" || ips.has(h);
  let acao = "";
  // #43 回环豁免（同 /local-info、/api/pair-code）：exe webview Origin:null 直通
  const reqLb = (req.headers.host ?? "").split(":")[0] === "127.0.0.1" || (req.headers.host ?? "").split(":")[0] === "localhost";
  if (origin && reqLb) acao = origin === "null" ? "*" : origin;
  else if (origin) {
    try {
      const u = new URL(origin);
      if (TRUSTED_WEB_ORIGINS.includes(u.origin) || hostOk(u.hostname)) acao = origin;
    } catch {}
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(acao ? { "access-control-allow-origin": acao } : {}),
  };
  if (req.method === "GET") {
    res.writeHead(200, headers).end(JSON.stringify({ ok: true, config: readPluginConfig() }));
    return;
  }
  // POST：吸掉 body（可能为空/JSON）后合并 query 参数写入；只认三键布尔，其余忽略
  let body = "";
  req.setEncoding("utf-8");
  for await (const chunk of req) body += chunk;
  let parsed: Record<string, unknown> = {};
  try {
    if (body.trim()) parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {}
  const next = readPluginConfig();
  let changed = false;
  // query 值只认 1/true/0/false（缺参/空串/垃圾值视为未传），body 值必须是布尔
  const parseQBool = (v: string): boolean | undefined => {
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
    return undefined;
  };
  for (const k of PLUGIN_CFG_KEYS) {
    const raw = url.searchParams.get(k);
    const qb = raw === null ? undefined : parseQBool(raw);
    const bv = parsed[k];
    if (qb !== undefined) {
      next[k] = qb;
      changed = true;
    } else if (typeof bv === "boolean") {
      next[k] = bv;
      changed = true;
    }
  }
  if (changed) {
    try {
      // 保留文件里的未知键（前向兼容），写完回读返回生效值。
      // dev 形态 dataDir=relay/data，~/.cc-deck 可能还不存在——先建目录再写
      let full: Record<string, unknown> = {};
      try {
        full = JSON.parse(readFileSync(pluginConfigPath(), "utf-8")) as Record<string, unknown>;
      } catch {}
      for (const k of PLUGIN_CFG_KEYS) full[k] = next[k];
      mkdirSync(dirname(pluginConfigPath()), { recursive: true });
      writeFileSync(pluginConfigPath(), JSON.stringify(full, null, 2) + "\n", "utf-8");
    } catch {
      res.writeHead(500, headers).end(JSON.stringify({ ok: false, error: "config.json 写入失败" }));
      return;
    }
  }
  res.writeHead(200, headers).end(JSON.stringify({ ok: true, config: readPluginConfig() }));
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
      // session_id 兼容裸 CLI id：外部会话 relay id = "ext-"+<cli_sid>（#448 守卫 hook 直传裸 sid）
      const target =
        (p.session_id
          ? (sessions.find((s) => s.session_id === p.session_id) ??
            sessions.find((s) => s.session_id === "ext-" + p.session_id))
          : undefined) ||
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
