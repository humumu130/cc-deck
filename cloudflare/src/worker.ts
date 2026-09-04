// Cloudflare 形态云桥：Worker 入口只做 upgrade + token 鉴权，
// 连接全部交给唯一的 RouterDO 实例（WebSocket Hibernation API，
// 空闲时 DO 休眠不计费）。路由逻辑与 Node 形态共用
// ../../cloud-bridge/src/router.ts 的 CloudRouter，协议完全一致。
import { DurableObject } from "cloudflare:workers";
import { CloudRouter } from "../../cloud-bridge/src/router.ts";

interface Env {
  CLOUD_TOKEN: string;
  PUBLIC_TOKEN?: string; // 可选：开源公共桥场景的公开 token（与 CLOUD_TOKEN 任一匹配即放行，连接统一受 DO 内限流保护）
  ROUTER: DurableObjectNamespace<RouterDO>;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      // 转发进 DO 拿设备列表（与 Node 形态 /health 对齐；会唤醒 DO，无连接时即刻再休眠）
      const stub = env.ROUTER.get(env.ROUTER.idFromName("main"));
      return stub.fetch(new Request("https://router/health"));
    }
    if (url.pathname !== "/cloud" && url.pathname !== "/cloud-poll") {
      return new Response("not found", { status: 404 });
    }
    const tok = url.searchParams.get("token") ?? "";
    if (tok !== env.CLOUD_TOKEN && !(env.PUBLIC_TOKEN && tok === env.PUBLIC_TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }
    const dev = url.searchParams.get("dev") ?? "";
    if (dev.length < 1 || dev.length > 64) {
      return new Response("bad dev", { status: 400 });
    }
    // 单 DO 实例承载全部连接，路由表才互相可见。
    // 必须转发原始 Request——用 req.url 字符串会丢 Upgrade 头，握手即 500
    const stub = env.ROUTER.get(env.ROUTER.idFromName("main"));
    return stub.fetch(req);
  },
};

export class RouterDO extends DurableObject {
  // 公共桥防滥用限流（家用规模远够不着阈值，只有真滥用才触发）：
  //   总连接（WS+轮询）≤ 600、dev 数 ≤ 400、每 dev 上行帧率 30/s（突发 60）
  private static MAX_CONNS = 600;
  private static MAX_DEVS = 400;
  private static RATE_PER_SEC = 30;
  private static RATE_BURST = 60;
  private buckets = new Map<string, { tokens: number; last: number }>();

  // connId 用随机 id（tag[1]），dev 存 tag[0]：
  // 同 dev 重连时新旧 connId 不同，CloudRouter 的顶替守卫才不会误判
  // HTTP 长轮询会话（connId = "poll:"+sid）没有 WebSocket，下行帧入队等 GET 来取
  private polls = new Map<string, { dev: string; queue: string[]; resolver: (() => void) | null; lastSeen: number; closed: boolean }>();
  private router = new CloudRouter({
    hooks: {
      send: (connId, frame) => {
        if (connId.startsWith("poll:")) {
          const s = this.polls.get(connId.slice(5));
          if (s && !s.closed) {
            if (s.queue.length >= 500) s.queue.shift(); // 丢最旧：旧日志可靠 last_seq 补发，pong/ACK 等新帧不能丢
            s.queue.push(frame);
            s.resolver?.();
            s.resolver = null;
          }
          return;
        }
        for (const ws of this.ctx.getWebSockets(connId)) {
          try {
            ws.send(frame);
          } catch (e) {
            // 目标连接濒死时 send 会抛；不兜住会沿 webSocketMessage 冒泡，
            // 把发送方连接一起 1011 踢掉（桥无缓冲，此帧只能丢弃）
            console.log(`[cloud-bridge] send failed conn=${connId}: ${e}`);
          }
        }
      },
      close: (connId, code, reason) => {
        if (connId.startsWith("poll:")) {
          const s = this.polls.get(connId.slice(5));
          if (s) {
            s.closed = true; s.resolver?.(); s.resolver = null;
            this.polls.delete(connId.slice(5));
          }
          return;
        }
        for (const ws of this.ctx.getWebSockets(connId)) {
          try {
            ws.close(code, reason);
          } catch {
            // 已在关闭流程中
          }
        }
      },
    },
    log: (m) => console.log(`[cloud-bridge] ${m}`),
  });

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      this.rehydrate();
      // 只回计数不回 dev 列表：公共桥 /health 无鉴权，dev id 虽是公钥派生非机密，
      // 也没必要向任意访客暴露在线设备元数据
      return Response.json({ ok: true, bridge: "cloudflare", devices: this.router.devs().length });
    }
    if (url.pathname !== "/cloud" && url.pathname !== "/cloud-poll") return new Response("not found", { status: 404 });
    const dev = url.searchParams.get("dev") ?? "";
    const rk = url.searchParams.get("rk") ?? ""; // relay 连接上报公钥（发现帧下发；浏览器连接不带）
    if (dev.length < 1 || dev.length > 64) return new Response("bad dev", { status: 400 });
    // 容量门禁：唤醒后按附件/轮询表重建的存活连接计数，超限拒新连（429）。
    // 清扫必须先于门禁：否则 polls 撑爆后所有请求 429、永远到不了 ensurePoll
    // 里的清扫，死 sid 永久占据容量把合法用户全锁死
    this.rehydrate();
    this.sweepPolls();
    const connCount = this.ctx.getWebSockets().length + this.polls.size;
    if (connCount > RouterDO.MAX_CONNS || this.router.devs().length > RouterDO.MAX_DEVS) {
      return new Response("bridge busy", { status: 429 });
    }

    // HTTP 长轮询兜底传输：公司 TLS 解密代理掐 WS 升级（返回 200 非 101）时，
    // 浏览器退化为 POST 上行 + GET 长挂下行，路由/顶替/E2E 协议与 ws 完全一致
    if (url.pathname === "/cloud-poll") {
      const sid = url.searchParams.get("sid") ?? "";
      if (sid.length < 1 || sid.length > 64) return new Response("bad sid", { status: 400 });
      // 限流键用源 IP 而非 URL 里的 dev：poll 路径 dev 是每次请求的参数，
      // 攻击者轮换 dev 即可无限领新令牌桶。GET（建会话长挂）也要耗令牌，
      // 否则占坑洪水完全免费。正常网页 1-2 会话每 20s 一个 GET，30/s/IP 无感
      const ip = req.headers.get("CF-Connecting-IP") ?? dev;
      if (req.method === "POST") {
        // Content-Length 预检 + 限流都先于读 body：超大请求也要耗令牌，
        // 且 8MB body 进内存再 parse/stringify 放大 3 倍，几并发即打爆 DO
        const cl = Number(req.headers.get("content-length") ?? "0");
        if (cl > 8 << 20) return new Response("too large", { status: 413 });
        if (!this.rateOk(ip)) return new Response("rate limited", { status: 429 });
        this.ensurePoll(dev, sid);
        const body = await req.text();
        if (body.length > 8 << 20) return new Response("too large", { status: 413 });
        this.router.handleFrame("poll:" + sid, body);
        return Response.json({ ok: true });
      }
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      // 仅新建会话扣令牌：流式期间浏览器收帧即重 GET（sid 不变）不该被限流，
      // 而占坑攻击必须不断换新 sid——正好逐次扣
      if (!this.polls.has(sid) && !this.rateOk(ip)) return new Response("rate limited", { status: 429 });
      const s = this.ensurePoll(dev, sid);
      const waitMs = Math.min(Number(url.searchParams.get("wait") ?? "20") || 20, 25) * 1000;
      if (s.queue.length === 0 && !s.closed) {
        await new Promise<void>((r) => {
          s.resolver = r;
          setTimeout(r, waitMs);
        });
        s.resolver = null;
      }
      const frames = s.queue.splice(0, s.queue.length);
      return Response.json({ frames, closed: s.closed });
    }

    // 唤醒可能由新连接触发：先按附件重建路由表，同 dev 顶替才能正确踢旧连接
    this.rehydrate();

    // 顶替：踢掉同 dev 的旧连接（休眠唤醒后 getWebSockets 只返回存活的）
    for (const old of this.ctx.getWebSockets(dev)) {
      try {
        old.close(4000, "replaced");
      } catch {
        // ignore
      }
    }

    const connId = crypto.randomUUID();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [dev, connId]);
    // rk 进 attachment：DO 休眠唤醒 rehydrate 重建路由表时带回，发现帧不因唤醒丢公钥
    pair[1].serializeAttachment(JSON.stringify({ dev, connId, rk, ip: req.headers.get("CF-Connecting-IP") }));
    this.router.register(connId, dev, rk || undefined);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 每 source（源 IP，本地 dev 兜底）令牌桶帧率限流（上行帧/轮询请求）；
  // 超限返回 false，调用方踢连接/拒请求
  private rateOk(source: string): boolean {
    const now = Date.now();
    if (this.buckets.size > 2000) {
      for (const [k, b] of this.buckets) {
        if (now - b.last > 600_000) this.buckets.delete(k);
      }
    }
    let b = this.buckets.get(source);
    if (!b) {
      b = { tokens: RouterDO.RATE_BURST, last: now };
      this.buckets.set(source, b);
    }
    // Math.max 防 CF 边缘时钟回拨把 elapsed 算成负、桶被扣穿
    const elapsed = Math.max(0, now - b.last);
    b.tokens = Math.min(RouterDO.RATE_BURST, b.tokens + (elapsed / 1000) * RouterDO.RATE_PER_SEC);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // 轮询会话按 sid 记账：每次请求 touch，>120s 没来即过期（sweepPolls 清扫）。
  // 每次请求都 register（同 connId 幂等不顶替自己）——DO 被逐出后路由表丢失，
  // 下一个 POST/GET 即重挂，relay→浏览器方向的帧不再 ROUTE_MISS。
  // register 用会话既有的 p.dev：他人 POST 猜中 sid 时不能把会话改道到自己名下。
  // 同 dev 轮换 sid 占坑由 router 的顶替语义天然化解：新 sid register 踢掉旧
  // poll 会话（close hook 移出 polls），同 dev 在线 poll 会话恒 ≤ 1
  private ensurePoll(dev: string, sid: string) {
    let p = this.polls.get(sid);
    if (!p) {
      p = { dev, queue: [], resolver: null, lastSeen: Date.now(), closed: false };
      this.polls.set(sid, p);
    }
    p.lastSeen = Date.now();
    this.router.register("poll:" + sid, p.dev);
    return p;
  }

  // 死会话清扫。必须在容量门禁之前调用（见 fetch 内注释）
  private sweepPolls(): void {
    const now = Date.now();
    for (const [s, p] of this.polls) {
      if (now - p.lastSeen > 120_000) {
        p.closed = true; p.resolver?.(); p.resolver = null;
        this.polls.delete(s);
        this.router.unregister("poll:" + s);
      }
    }
  }

  // 本地 workerd 的 webSocketMessage 里 ws.tags 未暴露（undefined），
  // 但 serializeAttachment/deserializeAttachment 可用——connId 存附件；
  // getWebSockets(tag) 的 tag 过滤仍然有效（顶替/定向发送用它）
  private attachOf(ws: WebSocket): { dev?: string; connId?: string; rk?: string; ip?: string } | undefined {
    const raw = (ws as { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw) as { dev?: string; connId?: string; rk?: string; ip?: string };
    } catch {
      return undefined;
    }
  }

  // 休眠唤醒后 CloudRouter 内存表已丢，但 WebSocket 与附件还在运行时：
  // 首个事件到达时按附件重建路由表，否则 handleFrame 全部静默丢弃、对端 ROUTE_MISS
  private rehydrated = false;
  private rehydrate(): void {
    if (this.rehydrated) return;
    this.rehydrated = true;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachOf(ws);
      if (a?.dev && a.connId) this.router.register(a.connId, a.dev, a.rk || undefined);
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    this.rehydrate();
    const a = this.attachOf(ws);
    if (!a?.connId) return;
    if (!this.rateOk(a.ip ?? a.dev ?? "?")) {
      try { ws.close(4291, "rate limited"); } catch { /* 已在关闭流程 */ }
      this.router.unregister(a.connId);
      return;
    }
    this.router.handleFrame(a.connId, message);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.rehydrate();
    const connId = this.attachOf(ws)?.connId;
    if (connId) this.router.unregister(connId);
  }
}
