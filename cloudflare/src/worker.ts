// Cloudflare 形态云桥：Worker 入口只做 upgrade + token 鉴权，
// 连接全部交给唯一的 RouterDO 实例（WebSocket Hibernation API，
// 空闲时 DO 休眠不计费）。路由逻辑与 Node 形态共用
// ../../cloud-bridge/src/router.ts 的 CloudRouter，协议完全一致。
import { DurableObject } from "cloudflare:workers";
import { CloudRouter } from "../../cloud-bridge/src/router.ts";

interface Env {
  CLOUD_TOKEN: string;
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
    if ((url.searchParams.get("token") ?? "") !== env.CLOUD_TOKEN) {
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
      return Response.json({ ok: true, bridge: "cloudflare", devices: this.router.devs() });
    }
    if (url.pathname !== "/cloud" && url.pathname !== "/cloud-poll") return new Response("not found", { status: 404 });
    const dev = url.searchParams.get("dev") ?? "";
    if (dev.length < 1 || dev.length > 64) return new Response("bad dev", { status: 400 });

    // HTTP 长轮询兜底传输：公司 TLS 解密代理掐 WS 升级（返回 200 非 101）时，
    // 浏览器退化为 POST 上行 + GET 长挂下行，路由/顶替/E2E 协议与 ws 完全一致
    if (url.pathname === "/cloud-poll") {
      const sid = url.searchParams.get("sid") ?? "";
      if (sid.length < 1 || sid.length > 64) return new Response("bad sid", { status: 400 });
      const s = this.ensurePoll(dev, sid);
      const connId = "poll:" + sid;
      if (req.method === "POST") {
        const body = await req.text();
        if (body.length > 8 << 20) return new Response("too large", { status: 413 });
        this.router.handleFrame(connId, body);
        return Response.json({ ok: true });
      }
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
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
    pair[1].serializeAttachment(JSON.stringify({ dev, connId }));
    this.router.register(connId, dev);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 轮询会话按 sid 记账：每次请求 touch，>120s 没来由后续请求顺带清扫。
  // 每次请求都 register（同 connId 幂等不顶替自己）——DO 被逐出后路由表丢失，
  // 下一个 POST/GET 即重挂，relay→浏览器方向的帧不再 ROUTE_MISS。
  private ensurePoll(dev: string, sid: string) {
    const now = Date.now();
    for (const [s, p] of this.polls) {
      if (now - p.lastSeen > 120_000) {
        p.closed = true; p.resolver?.(); p.resolver = null;
        this.polls.delete(s);
        this.router.unregister("poll:" + s);
      }
    }
    let p = this.polls.get(sid);
    if (!p) {
      p = { dev, queue: [], resolver: null, lastSeen: now, closed: false };
      this.polls.set(sid, p);
    }
    p.lastSeen = now;
    this.router.register("poll:" + sid, dev);
    return p;
  }

  // 本地 workerd 的 webSocketMessage 里 ws.tags 未暴露（undefined），
  // 但 serializeAttachment/deserializeAttachment 可用——connId 存附件；
  // getWebSockets(tag) 的 tag 过滤仍然有效（顶替/定向发送用它）
  private attachOf(ws: WebSocket): { dev?: string; connId?: string } | undefined {
    const raw = (ws as { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw) as { dev?: string; connId?: string };
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
      if (a?.dev && a.connId) this.router.register(a.connId, a.dev);
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    this.rehydrate();
    const connId = this.attachOf(ws)?.connId;
    if (connId) this.router.handleFrame(connId, message);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.rehydrate();
    const connId = this.attachOf(ws)?.connId;
    if (connId) this.router.unregister(connId);
  }
}
