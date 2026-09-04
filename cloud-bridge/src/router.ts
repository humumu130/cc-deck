// 云桥路由核心：纯逻辑、无 I/O、无 Node 依赖。
// Node 适配器（src/index.ts）与 Cloudflare Durable Object 适配器
// （../cloudflare/src/worker.ts）共用同一份状态机。
// 桥只按 dev 转发不透明 data，不解析不缓存——seq/补发全部由 relay 侧负责。

export interface RouterHooks {
  send(connId: string, frame: string): void;
  close(connId: string, code: number, reason: string): void;
}

export interface RouterOptions {
  hooks: RouterHooks;
  log?: (msg: string) => void;
}

// 8MB 防御性上限：SNAPSHOT/图片上传等合法帧可达 MB 级（1MB 时快照密文刚超线，
// 桥把 relay 连接 1009 踢掉导致手机列表全空循环）
const MAX_FRAME = 8 << 20;
const MAX_DEV = 64;

export class CloudRouter {
  private devOf = new Map<string, string>();  // connId → dev
  private connOf = new Map<string, string>(); // dev → connId（一设备一连接）
  private keyOf = new Map<string, string>();  // dev → 公钥（relay 连接时上报，发现帧用；公钥本身公开无害）

  constructor(private opts: RouterOptions) {}

  get devCount(): number {
    return this.connOf.size;
  }

  devs(): string[] {
    return [...this.connOf.keys()];
  }

  devOfConn(connId: string): string | undefined {
    return this.devOf.get(connId);
  }

  // 登记（token 鉴权在适配器层完成）。同 dev 新连接顶替旧连接并踢掉，
  // 避免设备闪断重连期间双连接重复投递。rk 为可选公钥（relay 连接上报）。
  register(connId: string, dev: string, rk?: string): void {
    if (dev.length < 1 || dev.length > MAX_DEV) throw new Error("bad dev");
    const old = this.connOf.get(dev);
    if (old !== undefined && old !== connId) {
      this.devOf.delete(old);
      this.connOf.set(dev, connId);
      this.opts.hooks.close(old, 4000, "replaced");
    }
    this.devOf.set(connId, dev);
    this.connOf.set(dev, connId);
    if (rk) this.keyOf.set(dev, rk);
    else this.keyOf.delete(dev);
    this.opts.log?.(`register dev=${dev} conn=${connId}`);
  }

  unregister(connId: string): void {
    const dev = this.devOf.get(connId);
    if (dev === undefined) return;
    this.devOf.delete(connId);
    if (this.connOf.get(dev) === connId) {
      this.connOf.delete(dev);
      this.keyOf.delete(dev);
    }
    this.opts.log?.(`unregister dev=${dev} conn=${connId}`);
  }

  // 客户端帧 {to, data}（data 不透明）→ 转成 {to, from, data} 投给目标连接
  handleFrame(connId: string, text: string): void {
    const from = this.devOf.get(connId);
    if (from === undefined) return; // 未登记的连接（register 前的消息）直接忽略
    if (text.length > MAX_FRAME) {
      this.opts.hooks.close(connId, 1009, "frame too large");
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.reply(connId, { type: "ERROR", error: "bad json" });
      return;
    }
    const m = msg as { to?: unknown; data?: unknown } | null;
    if (
      !m ||
      typeof m.to !== "string" ||
      m.to.length < 1 ||
      m.to.length > MAX_DEV ||
      !("data" in m)
    ) {
      this.reply(connId, { type: "ERROR", error: "bad frame" });
      return;
    }
    // 发现帧 {to:"*", data:{t:"disc"}}：回在线 relay 列表（dev+公钥）。
    // 网页烘焙的 relay 指纹在 relay 换 keypair 后失配，ROUTE_MISS 前先发现真实身份
    if (m.to === "*") {
      const d = m.data as { t?: unknown } | null;
      if (!d || typeof d !== "object" || d.t !== "disc") {
        this.reply(connId, { type: "ERROR", error: "bad frame" });
        return;
      }
      const relays = this.devs()
        .filter((dev) => dev.startsWith("rl-"))
        .map((dev) => ({ dev, rk: this.keyOf.get(dev) ?? "" }));
      this.reply(connId, { type: "RELAYS", relays });
      return;
    }
    const target = this.connOf.get(m.to);
    if (target === undefined) {
      this.reply(connId, { type: "ROUTE_MISS", to: m.to });
      return;
    }
    this.opts.hooks.send(target, JSON.stringify({ to: m.to, from, data: m.data }));
  }

  private reply(connId: string, obj: Record<string, unknown>): void {
    this.opts.hooks.send(connId, JSON.stringify(obj));
  }
}
