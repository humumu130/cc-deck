// 云桥路由核心：纯逻辑、无 I/O、无 Node 依赖。
// Node 适配器（src/index.ts）与 Cloudflare Durable Object 适配器
// （../cloudflare/src/worker.ts）共用同一份状态机。
// 桥只按 dev 转发不透明 data，不解析不缓存——seq/补发全部由 relay 侧负责。
//
// #116（2026-09-13）：同 dev 由「新连顶替踢旧连」改为「多连共存、下行广播」。
// 顶替踢连在两类真实场景里制造互踢死循环——①relay 配置两条桥 URL 指向同一台桥
// （CF 域名 + 直连 IP），每次建连把另一条踢掉，对方 1s 重连再踢回来（bridge
// connected/disconnected 风暴，用户实测「一会儿连上一会儿连不上」的根因）；
// ②手机对同一 relay 有两个云条目（两次扫码不同 URL），同 dev 两连互踢对撞。
// 多连共存后：下行帧广播给目标 dev 的全部连接，各客户端独立消费；每 dev 上限
// 4 连（超过踢最旧，防泄漏）。

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
const MAX_CONNS_PER_DEV = 4;

export class CloudRouter {
  private devOf = new Map<string, string>();  // connId → dev
  // dev → 该设备的全部活跃连接（#116 多连共存；Set 保持插入序，首元素最旧）
  private connsOf = new Map<string, Set<string>>();
  private keyOf = new Map<string, string>();  // dev → 公钥（relay 连接时上报，发现帧用；公钥本身公开无害）

  constructor(private opts: RouterOptions) {}

  get devCount(): number {
    return this.connsOf.size;
  }

  devs(): string[] {
    return [...this.connsOf.keys()];
  }

  devOfConn(connId: string): string | undefined {
    return this.devOf.get(connId);
  }

  // 登记（token 鉴权在适配器层完成）。同 dev 多连共存：不踢旧连，只在超过
  // MAX_CONNS_PER_DEV 时踢最旧的一条（正常客户端 1~2 连，远触不到上限；上限只
  // 挡异常泄漏）。rk 为可选公钥（relay 连接上报）。
  register(connId: string, dev: string, rk?: string): void {
    if (dev.length < 1 || dev.length > MAX_DEV) throw new Error("bad dev");
    let set = this.connsOf.get(dev);
    const wasEmpty = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.connsOf.set(dev, set);
    }
    if (set.size >= MAX_CONNS_PER_DEV && !set.has(connId)) {
      const oldest = set.values().next().value as string;
      set.delete(oldest);
      this.devOf.delete(oldest);
      this.opts.hooks.close(oldest, 4000, "conn-limit");
    }
    set.add(connId);
    this.devOf.set(connId, dev);
    if (rk) this.keyOf.set(dev, rk);
    else this.keyOf.delete(dev);
    this.opts.log?.(`register dev=${dev} conn=${connId} (${set.size} conns)`);
    // #34 relay 上线广播：该 relay 的连接数 0→1 时通知全体在线设备——手机「待
    // 唤醒」态（relay 死但桥 ws 未断）收到 rd 匹配的此帧即在原连接补发 hello
    // 恢复，替代盲目重试。0→1 判定天然幂等：重挂/多连不重复播，防轮询风暴
    if (dev.startsWith("rl-") && wasEmpty) {
      const frame = JSON.stringify({ type: "relay-online", rd: dev });
      for (const [d, targets] of this.connsOf) {
        if (d === dev) continue; // 上线的 relay 自己无需唤醒
        for (const t of targets) this.opts.hooks.send(t, frame);
      }
    }
  }

  unregister(connId: string): void {
    const dev = this.devOf.get(connId);
    if (dev === undefined) return;
    this.devOf.delete(connId);
    const set = this.connsOf.get(dev);
    if (set) {
      set.delete(connId);
      if (!set.size) {
        this.connsOf.delete(dev);
        this.keyOf.delete(dev);
      }
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
    // 通配帧（to:"*"）：disc = 发现在线 relay；pair_req = 配对码定位广播。
    // wb 未配对时与 relay 无共享密钥，pair_req 本就是「明文信封 + wb 公钥」形态，
    // 广播按同规则转发（桥不解析 data 内容）。
    if (m.to === "*") {
      const d = m.data as { t?: unknown } | null;
      if (!d || typeof d !== "object" || typeof d.t !== "string") {
        this.reply(connId, { type: "ERROR", error: "bad frame" });
        return;
      }
      // 发现帧：回在线 relay 列表（dev+公钥）。网页烘焙的 relay 指纹在 relay 换
      // keypair 后失配，ROUTE_MISS 前先发现真实身份
      if (d.t === "disc") {
        const relays = this.devs()
          .filter((dev) => dev.startsWith("rl-"))
          .map((dev) => ({ dev, rk: this.keyOf.get(dev) ?? "" }));
        this.reply(connId, { type: "RELAYS", relays });
        return;
      }
      // 配对码定位广播：转发给所有在线 rl- 设备（data 不透明原样）。多台 relay 挂
      // 同一座桥时，手机不预知 rd 也能凭码定位——持码 relay 回 pair_ack，未持码者
      // 静默。旧 relay 不识别 bc 标记也只是当普通 pair_req 处理：持码照常 ack，
      // 未持码回的密文 nack 手机在广播态无 rk 可解、天然忽略，混跑不炸
      if (d.t === "pair_req") {
        for (const [dev, targets] of this.connsOf) {
          if (!dev.startsWith("rl-")) continue;
          for (const target of targets) {
            if (target === connId) continue;
            this.opts.hooks.send(target, JSON.stringify({ to: dev, from, data: m.data }));
          }
        }
        return;
      }
      this.reply(connId, { type: "ERROR", error: "bad frame" });
      return;
    }
    const targets = this.connsOf.get(m.to);
    if (!targets || !targets.size) {
      this.reply(connId, { type: "ROUTE_MISS", to: m.to });
      return;
    }
    // #116 下行广播：目标 dev 的每条连接各投一份（双条目手机各自消费；密文帧
    // 无持钥者解不开，多投无泄露面）
    const frame = JSON.stringify({ to: m.to, from, data: m.data });
    for (const t of targets) this.opts.hooks.send(t, frame);
  }

  private reply(connId: string, obj: Record<string, unknown>): void {
    this.opts.hooks.send(connId, JSON.stringify(obj));
  }
}
