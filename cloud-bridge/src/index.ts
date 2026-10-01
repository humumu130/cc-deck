import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { CloudRouter } from "./router.js";

// 网页端静态文件目录（仓库 web-console/，部署布局 /opt/cc-cloud-bridge/web-console/）
const webDir = (name: string) => fileURLToPath(new URL(`../web-console/${name}`, import.meta.url));

// #29 残留备案转正（托管页零安全头，与 CF 形态 withSecHeaders 同刀）：公司网托管
// 页补四个不破坏自家页面的安全头。HSTS 故意除外——本形态裸 HTTP 无 TLS，浏览器
// 对 http 响应忽略 HSTS，不装样子；严格 CSP 同 CF 形态不上（web-console 单文件
// 应用带内联脚本，'self' 会当场砸掉页面）
const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
} as const;

// #29（B-P0-1 根治）：rl- dev 必须持对应公钥——devId 口径 = 公钥原始字节前 8 字节
// hex（与 relay/src/e2e.ts devId 一致）。桥侧 rl- 注册此前无鉴权：持 token 者可冒
// 真实 relay 的 dev 注册 + 上报假 rk，发现帧把「真 dev + 假公钥」喂给浏览器/expo
// 写进配对锚 → 后续密封永久指向攻击者公钥（web/expo 侧过滤是纵深，这里是断根）。
// 现行 relay 自 7b7cd3a 起连桥恒带 rk 且 dev 即派生值（cloud-client.ts），收紧零影响。
// wb-/ph-/wt- 无所有权证明（dev 即随机），顶替 DoS 面为协议固有，不在本刀范围
function rlDevOfRk(rk: string): string | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(rk)) return null; // nacl 32 字节公钥恒 43 字符 + '='
  const buf = Buffer.from(rk, "base64");
  if (buf.length !== 32) return null;
  return "rl-" + [...buf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HEARTBEAT_MS = 30_000;
// #85 心跳容忍度（2026-09-21）：单轮无 pong 即 terminate 对移动端太苛刻——手机
// 后台停摆（doze/冻结）持续几分钟是常态，且 terminate 硬掐 TCP 不发 close 帧，
// 客户端冻结期间无从感知（回前台才暴露）。踢人对客户端恢复无益（恢复靠客户端
// 自身探测），纯粹是服务端清死连接的卫生动作——个人自用桥连接数极少，容忍 20
// 轮（10 分钟）零压力：停摆 <10min 的连接解冻后 OkHttp 补上 pong 即原地复活
// （ping 节奏不变，30s 一拍保 NAT 不掐 idle TCP，复活链路成立的前提）
const HEARTBEAT_MISS_LIMIT = 20;

// Node 形态云桥：HTTP upgrade 鉴权（/cloud?token=&dev=）后交 CloudRouter。
// 桥不持久化任何状态，重启即清空（补发由 relay 的 seq 机制负责）。
// #373 /wan：手表明文透传通道——手表连 /wan?token=&dev=wt-*&to=rl-*，桥把它的
// 明文 relay 帧包成 {to, data:{t:"wan",from,frame}} 信封交路由；relay→手表方向
// 解信封还原明文帧。信任模型：桥可信（自家部署），仅此通道不走端到端密文。
export function startCloudServer(port: number, token: string, extraPorts: number[] = []): {
  port: number;
  close: () => Promise<void>;
  router: CloudRouter;
} {
  const wss = new WebSocketServer({ noServer: true });
  const socks = new Map<string, WebSocket>();
  const wanConns = new Map<string, { ws: WebSocket; to: string }>();
  let nextId = 0;

  const router = new CloudRouter({
    hooks: {
      send: (connId, frame) => {
        const wan = wanConns.get(connId);
        if (wan) {
          // 下行解信封：{to,from,data:{t:"wan",frame:"<明文帧JSON文本>"}} → 明文帧
          try {
            const env = JSON.parse(frame) as { data?: { t?: string; frame?: unknown } };
            if (env?.data?.t === "wan" && typeof env.data.frame === "string") {
              wan.ws.send(env.data.frame);
              return;
            }
          } catch { /* 非信封帧按原样发 */ }
        }
        const ws = socks.get(connId);
        if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
      },
      close: (connId, code, reason) => {
        wanConns.get(connId)?.ws.close(code, reason);
        socks.get(connId)?.close(code, reason);
      },
    },
    log: (m) => console.log(`[cloud-bridge] ${m}`),
  });

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      // #29（B-P3）：只回计数不回 dev 列表（与 CF 形态 RouterDO /health 对齐）——
      // 在线设备 id 名单对任意访客无暴露必要，防踩点
      res.writeHead(200, { "content-type": "application/json", ...SEC_HEADERS }).end(
        JSON.stringify({ ok: true, devices: router.devs().length }),
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS }).end(readFileSync(file));
      return;
    }
    if (req.method === "GET" && url.pathname === "/nacl.js") {
      const file = webDir("nacl.js");
      if (!existsSync(file)) {
        res.writeHead(503).end("web-console/nacl.js 不存在");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", ...SEC_HEADERS }).end(readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  };
  const server = createServer(onRequest);

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const dev = url.searchParams.get("dev") ?? "";
    const rk = url.searchParams.get("rk") ?? ""; // relay 连接上报公钥（发现帧下发，浏览器无需预知）
    const okToken = (url.searchParams.get("token") ?? "") === token;
    // #373 /wan：手表透传通道，to=目标 relay dev（rl-*）为该连接固定投递目标。
    // #29（B-P2）：to 强制 rl- 前缀——该通道语义就是「手表→自家 relay 的明文透传」，
    // 放宽到任意 dev 等于给手表开了「向任意在线设备投明文帧」的口子
    const isWan = url.pathname === "/wan";
    const wanTo = url.searchParams.get("to") ?? "";
    // #29（B-P0-1 根治）：rl- dev 注册强制自洽（dev 必须等于上报 rk 的派生值），
    // 冒名顶替/假 rk 一律拒（详见 rlDevOfRk 注释）
    const rlBad = dev.startsWith("rl-") && rlDevOfRk(rk) !== dev;
    if (rlBad) {
      console.log(`[cloud-bridge] reject rl- self-consistency dev=${dev} rk=${rk.slice(0, 8)}… from=${req.socket.remoteAddress}`);
    }
    if (
      rlBad ||
      !(okToken && dev.length >= 1 && dev.length <= 64 && (url.pathname === "/cloud" || (isWan && wanTo.startsWith("rl-") && wanTo.length <= 64)))
    ) {
      console.log(`[cloud-bridge] reject upgrade from=${req.socket.remoteAddress} path=${url.pathname}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connId = `c${++nextId}`;
      socks.set(connId, ws);
      if (isWan) wanConns.set(connId, { ws, to: wanTo });
      (ws as HbWs).isAlive = true;
      ws.on("pong", () => {
        (ws as HbWs).isAlive = true;
      });
      ws.on("error", () => undefined);
      ws.on("close", () => {
        socks.delete(connId);
        wanConns.delete(connId);
        router.unregister(connId);
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        // 链路级心跳回显（#146）：CF edge 会代答 ws 协议层 ping/pong（控制帧不透传
        // 源站），业务空闲时 edge→cloudflared→桥 后段被回收、对端半开 TCP 无感——
        // 手机重连 hello 全部 ROUTE_MISS 而源站 relay 毫不知情（2026-09-22 输出物
        // 栏断粮事故）。文本帧 CF 必透传，{t:"hb"} 直接回 {t:"hb_ack"}，供对端端到端
        // 探活；无 to/from 不进路由，relay/手机/网页任意连接通用
        try {
          if ((JSON.parse(data.toString()) as { t?: unknown }).t === "hb") {
            ws.send(JSON.stringify({ t: "hb_ack" }));
            return;
          }
        } catch { /* 非 JSON 帧照走原路由 */ }
        if (isWan) {
          // 上行包信封：明文帧 → {to:rd, data:{t:"wan",from,frame}}
          router.handleFrame(connId, JSON.stringify({ to: wanTo, data: { t: "wan", from: dev, frame: data.toString() } }));
          return;
        }
        router.handleFrame(connId, data.toString());
      });
      router.register(connId, dev, rk || undefined);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [connId, ws] of socks) {
      const c = ws as HbWs;
      if (!c.isAlive) {
        c.miss = (c.miss ?? 0) + 1;
        if (c.miss >= HEARTBEAT_MISS_LIMIT) {
          ws.terminate();
          continue;
        }
      } else {
        c.miss = 0;
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
  miss?: number; // #85 连续未回 pong 轮数（达到 HEARTBEAT_MISS_LIMIT 才 terminate）
}

function main(): void {
  const cfg = loadConfig();
  startCloudServer(cfg.port, cfg.token, cfg.extraPorts);
  console.log(`[cloud-bridge] listening :${cfg.port}${cfg.extraPorts.map((p) => ` :${p}`).join("")} path=/cloud`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
