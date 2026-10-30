// 云桥路由核心：纯逻辑、无 I/O、无 Node 依赖。
// Node 适配器（src/index.ts）与 Cloudflare Durable Object 适配器
// （../cloudflare/src/worker.ts）共用同一份状态机。
// 桥只按 dev 转发不透明 data，不解析不缓存——seq/补发全部由 relay 侧负责。

export interface RouterHooks {
  send(connId: string, frame: string): void;
  close(connId: string, code: number, reason: string): void;
}

// T1a 租户过滤视图（PRD §4.4/§4.5）：TenantService 实现注入，双形态共享单源。
// 恒活读（内存态零 await）——六触点：register 准入（含同钥拒重入）/relay-online
// 广播/disc 发现（RELAYS）/pair_req 广播/定向路由/wan 固定目标（同走定向）。
// 缺省不注入=纯配对模型现状（迁移连续性：未开租户的桥零行为差异）。
export interface TenantFilter {
  tenantOf(dev: string): string | null;
  isRevoked(dev: string): boolean;
  visible(a: string, b: string): boolean; // §4.4 null-tenant 矩阵（窗口/strict 两档）
  // 管理帧终结（桥侧终结非中转）：login_req/tenant_op/peers_report。async——
  // 回执经 hooks.send 出，失败自吞不炸连接
  onManagementFrame(connId: string, from: string, data: { t: string } & Record<string, unknown>): Promise<void>;
}

export interface RouterOptions {
  hooks: RouterHooks;
  log?: (msg: string) => void;
  tenant?: TenantFilter;
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

  // T1a：租户过滤视图后挂（服务构造需先引用 router 的 hooks——两相成环的解法）。
  // 注入前=纯配对模型现状（六触点全放行）
  setTenant(tenant: TenantFilter): void {
    this.opts.tenant = tenant;
  }

  get devCount(): number {
    return this.connOf.size;
  }

  devs(): string[] {
    return [...this.connOf.keys()];
  }

  devOfConn(connId: string): string | undefined {
    return this.devOf.get(connId);
  }

  // #29（B-P2 poll 顶替）：dev 当前占用的连接 id（无=离线）。适配器用它区分
  // 「同 dev 旧 poll 会话」（可顶替，防占坑）与「同 dev 活跃 WebSocket」（poll 兜底
  // 传输不得踢主传输——否则持 token 者 POST 猜中 dev 即可把任意在线设备踢下线）
  connOfDev(dev: string): string | undefined {
    return this.connOf.get(dev);
  }

  // 登记（token 鉴权在适配器层完成）。同 dev 新连接顶替旧连接并踢掉，
  // 避免设备闪断重连期间双连接重复投递。rk 为可选公钥（relay 连接上报）。
  register(connId: string, dev: string, rk?: string): void {
    if (dev.length < 1 || dev.length > MAX_DEV) throw new Error("bad dev");
    // T1a 触点①：吊销设备拒绝注册（B2 踢出四缺口之「同钥拒重入」——活线断后
    // 同 dev 重连在此被拒；adapter 升级口另有一层 admission，双保险）
    if (this.opts.tenant?.isRevoked(dev)) throw new Error("device revoked");
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
    // #34 relay 上线广播：新 relay 连接（首连/顶替重连/DO 休眠唤醒重建）时通知
    // 全体在线连接——手机「待唤醒」态（relay 死但桥 ws 未断）收到 rd 匹配的
    // 此帧即在原连接补发 hello 恢复，替代盲目重试。幂等 register（DO 每请求
    // 重挂/poll touch，old === connId）不重播，防轮询风暴
    if (dev.startsWith("rl-") && old !== connId) {
      const frame = JSON.stringify({ type: "relay-online", rd: dev });
      for (const [d, target] of this.connOf) {
        if (d === dev) continue; // 上线的 relay 自己无需唤醒
        // T1a 触点②：relay-online 广播按租户矩阵过滤（跨租户不可见上线事件）
        if (this.opts.tenant && !this.opts.tenant.visible(dev, d)) continue;
        this.opts.hooks.send(target, frame);
      }
    }
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
    // 通配帧（to:"*"）：disc = 发现在线 relay；pair_req = 配对码定位广播。
    // wb 未配对时与 relay 无共享密钥，pair_req 本就是「明文信封 + wb 公钥」形态，
    // 广播按同规则转发（桥不解析 data 内容）。
    if (m.to === "*") {
      const d = m.data as { t?: unknown } | null;
      if (!d || typeof d !== "object" || typeof d.t !== "string") {
        this.reply(connId, { type: "ERROR", error: "bad frame" });
        return;
      }
      // T1a 触点⑤：管理帧桥侧终结（login_req/tenant_op/peers_report——PRD §3.2
      // 管理帧非密封中转）。异步执行，回执经 hooks.send；不阻塞本帧处理
      if (this.opts.tenant && (d.t === "login_req" || d.t === "tenant_op" || d.t === "peers_report")) {
        const tenant = this.opts.tenant;
        void tenant.onManagementFrame(connId, from, d as { t: string } & Record<string, unknown>).catch((e) => {
          this.opts.log?.(`tenant frame error: ${e}`);
          this.reply(connId, { type: "ERROR", error: "tenant op failed" });
        });
        return;
      }
      // 发现帧：回在线 relay 列表（dev+公钥）。网页烘焙的 relay 指纹在 relay 换
      // keypair 后失配，ROUTE_MISS 前先发现真实身份
      if (d.t === "disc") {
        // T1a 触点③：RELAYS 按租户矩阵过滤（问者只见同租户+迁移窗 null；G6 消费面）
        const tenant = this.opts.tenant;
        const relays = this.devs()
          .filter((dev) => dev.startsWith("rl-"))
          .filter((dev) => !tenant || tenant.visible(from, dev))
          .map((dev) => ({ dev, rk: this.keyOf.get(dev) ?? "" }));
        this.reply(connId, { type: "RELAYS", relays });
        return;
      }
      // 配对码定位广播：转发给所有在线 rl- 设备（data 不透明原样）。多台 relay 挂
      // 同一座桥时，手机不预知 rd 也能凭码定位——持码 relay 回 pair_ack，未持码者
      // 静默。旧 relay 不识别 bc 标记也只是当普通 pair_req 处理：持码照常 ack，
      // 未持码回的密文 nack 手机在广播态无 rk 可解、天然忽略，混跑不炸
      if (d.t === "pair_req") {
        for (const [dev, target] of this.connOf) {
          if (!dev.startsWith("rl-") || target === connId) continue;
          // T1a 触点④：配对定位广播按租户矩阵过滤（跨租户收不到）
          if (this.opts.tenant && !this.opts.tenant.visible(from, dev)) continue;
          this.opts.hooks.send(target, JSON.stringify({ to: dev, from, data: m.data }));
        }
        return;
      }
      this.reply(connId, { type: "ERROR", error: "bad frame" });
      return;
    }
    // T1a 触点⑥：定向路由（含 /wan 固定目标）跨租户=笼统 ROUTE_MISS——目标存
    // 在与否不可探测（PRD §4.4「跨租户=笼统拒绝（不可探测）」）
    if (this.opts.tenant && !this.opts.tenant.visible(from, m.to)) {
      this.reply(connId, { type: "ROUTE_MISS", to: m.to });
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
