import WebSocket from "ws";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConfig } from "./config.js";
import type { CloudIdentity } from "./cloud-identity.js";
import type { PairingCodes } from "./pairing.js";
import { devId, seal, unseal, type SealedBox } from "./e2e.js";
import type { Command, CommandAckPayload, Envelope, PeerMeta } from "./types.js";

interface PhoneState {
  lastSeq: number; // hello 时上报，用于补发
  active: boolean; // 桥连接期间是否已 hello（断线后置 false 等重新 hello）
}

interface CloudFrame {
  to?: string;
  from?: string;
  data?: SealedBox;
  type?: string;
}

// #42 设备身份元数据校验：pair_req 的 meta 由配对方自报（浏览器 UA 摘要 / App 型号
// 版本），桥不解析透传，入库前的唯一防线在这里——只认四个已知键，值 trim 后非空且
// 为字符串才收，超长（>120 字符）截断；全部无效则视为不带 meta（旧客户端等价）
const PEER_META_MAX = 120;
const PEER_META_KEYS = ["name", "platform", "ua", "app"] as const;
function sanitizePeerMeta(raw: unknown): PeerMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: PeerMeta = {};
  let n = 0;
  for (const k of PEER_META_KEYS) {
    const v = src[k];
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    out[k] = s.length > PEER_META_MAX ? s.slice(0, PEER_META_MAX) : s;
    n++;
  }
  return n > 0 ? out : undefined;
}

// 云桥上行客户端：出站连桥（CCR_CLOUD_URL，公司网络友好），把 EventBus 事件
// E2E 加密转发给每个已 hello 的手机，手机命令解密后交给 handleCommand。
// resume 语义与 ws-server 完全相同：hello.last_seq 在缓冲内补发，否则 SNAPSHOT。
export class CloudClient {
  private ws: WebSocket | null = null;
  private phones = new Map<string, PhoneState>();
  // #373 /wan 手表明文透传设备（wt-*）：桥可信通道，无密钥对；状态机与 phones 同构
  private wanWatches = new Map<string, { lastSeq: number; active: boolean }>();
  private unpairedNotice = new Map<string, number>();
  // 配对码爆破限流（双层）：①按 dev——10 分钟窗口内连续 5 次错码的 dev 静默丢弃；
  // ②全局预算（2026-09-09 F2 修复）——按 dev 计数可被「每 5 次换一个密钥对」绕过，
  // 故全部 dev 合计错码超预算后本窗口内任何 pair_req（含正码）一律静默丢弃，
  // 在线穷举速率坍缩到预算值（50 次/10min ≈ 0.083rps，任何码空间都安全）。
  // 窗口过期自动重置：正常用户偶尔输错远够不着预算
  private pairFails = new Map<string, { n: number; until: number }>();
  private pairBudgetN = 0;
  private pairBudgetStart = 0;
  private pairBudgetUntil = 0;
  // 实例字段而非常量：测试可收紧（test-cloud.ts 全局预算用例）
  private pairBudgetMax = 50;
  private pairBudgetWindowMs = 600_000;
  // F7 /wan 拒绝日志限频：未持凭据手表的帧在严格模式下静默丢弃，日志 30s 一条防刷屏
  private wanDropLoggedAt = 0;
  private delayMs = 1000;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRecv = 0;
  private lastPingAt = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  // 桥闪断时记录断线前 active 的设备，重连后主动补发（见 connect 的 open 处理）
  private resumeOnOpen = new Set<string>();
  // #384b 近 60s 内 grant 过的登录设备：桥断连丢 ack 后重连补发（定时整体清空）
  private pendingGrantAcks = new Map<string, number>();
  private unsubscribe: () => void;

  constructor(
    private bus: EventBus,
    private mgr: SessionManager,
    private cfg: RelayConfig,
    private identity: CloudIdentity,
    private pairCodes?: PairingCodes,
    private url?: string,
  ) {
    this.unsubscribe = bus.subscribe((env) => this.onEnv(env));
  }

  start(): void {
    this.connect();
    this.startHeartbeat();
  }

  private bridgeUrl(): string {
    const base = this.url ?? this.cfg.cloudUrl;
    const sep = base.includes("?") ? "&" : "?";
    // rk=公钥上报给桥：桥发现帧（网页 to:"*" disc）下发 {dev,rk}，浏览器无需预知 relay 指纹
    return `${base}${sep}token=${encodeURIComponent(this.cfg.cloudToken)}&dev=${this.identity.relayDev}&rk=${encodeURIComponent(this.identity.keypair.publicKey)}`;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.bridgeUrl());
    this.ws = ws;
    ws.on("open", () => {
      this.delayMs = 1000;
      this.lastRecv = Date.now();
      console.log(`[cloud] bridge connected ${this.tag} (dev=${this.identity.relayDev})`);
      // 闪断自愈：桥链路闪断不该连累每台设备重新 hello——后台网页标签会被浏览器
      // 冻结定时器发不出 ping，下行将黑洞到手动刷新。重连后立即按各设备 lastSeq
      // 主动补发；设备自身已掉线时桥回 ROUTE_MISS，走原有下线标记路径。
      if (this.resumeOnOpen.size) {
        const devs = [...this.resumeOnOpen];
        this.resumeOnOpen.clear();
        console.log(`[cloud] auto-resume ${devs.length} device(s) after bridge reconnect: ${devs.join(",")}`);
        for (const dev of devs) {
          if (this.phones.has(dev)) this.resumePhone(dev, this.phones.get(dev)?.lastSeq ?? 0);
          else if (this.wanWatches.has(dev)) this.resumeWan(dev, this.wanWatches.get(dev)?.lastSeq ?? 0);
        }
      }
      // #384b 扫码登录 ack 补发：grant 命令到达时若本桥恰好断连（桥闪断/部署踢连接），
      // pair_ack 静默丢失，电脑端永远等不到。桥重连 open 后对近 60s 的 grant 补发一次
      // （幂等：手机重复授权/网页重复收 ack 都无害）
      if (this.pendingGrantAcks.size) {
        const acks = [...this.pendingGrantAcks.keys()];
        console.log(`[cloud] replay ${acks.length} login ack(s) after bridge reconnect`);
        for (const dev of acks) this.sendSealed(dev, {
          t: "pair_ack",
          relay_dev: this.identity.relayDev,
          relay_pubkey: this.identity.keypair.publicKey,
        });
      }
    });
    ws.on("message", (raw) => {
      this.lastRecv = Date.now();
      this.onFrame(String(raw));
    });
    ws.on("pong", () => {
      this.lastRecv = Date.now();
    });
    ws.on("error", () => undefined); // close 会跟着触发，统一在那处理
    ws.on("close", () => {
      if (this.ws === ws) {
        console.log(`[cloud] bridge disconnected ${this.tag}, retry in ${this.delayMs}ms`);
        for (const [dev, st] of this.phones) {
          if (st.active) this.resumeOnOpen.add(dev);
          st.active = false;
        }
        for (const [dev, st] of this.wanWatches) {
          if (st.active) this.resumeOnOpen.add(dev);
          st.active = false;
        }
        this.ws = null;
        this.timer = setTimeout(() => this.connect(), this.delayMs);
        this.delayMs = Math.min(this.delayMs * 2, 30_000);
      }
    });
  }

  // 出站链路心跳：10s 协议层 ping 保活 NAT 映射；25s 无任何回包说明对端/路径已死
  // （半开 TCP 不触发 close），主动 terminate 走统一重连路径。
  private startHeartbeat(): void {
    if (this.hbTimer) return;
    this.hbTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // 只在「ping 出去但 pong 没回来」时判死：业务空闲（手机挂另一座桥、网页后台
      // 冻结）不算链路死——此前按任意收包计时，安静 25s 即掐线，CF 桥闪断循环根因
      if (this.lastPingAt > 0 && Date.now() - this.lastPingAt > 24_000 && Date.now() - this.lastRecv > 24_000) {
        console.log("[cloud] heartbeat timeout (pong missing >24s), terminating for reconnect");
        ws.terminate();
        return;
      }
      if (this.lastPingAt === 0 || Date.now() - this.lastPingAt >= 10_000) {
        this.lastPingAt = Date.now();
        ws.ping();
      }
    }, 5_000);
    this.hbTimer.unref?.();
  }

  private send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  // 多桥并行时的日志标签（桥 host）
  private get tag(): string {
    try {
      return new URL(this.url ?? this.cfg.cloudUrl).host;
    } catch {
      return "?";
    }
  }

  // 云通道是否有已 hello 的手机（提问/权限门控的"手机在线"判定要计入）
  hasActivePhones(): boolean {
    for (const st of this.phones.values()) if (st.active) return true;
    return false;
  }

  private sendSealed(dev: string, obj: unknown): boolean {
    const peer = this.identity.peers.get(dev);
    if (!peer) return false;
    this.send({ to: dev, data: seal(obj, peer.pubkey, this.identity.keypair.secretKey) });
    return true;
  }

  // 未配对设备的帧此前静默丢弃：对端不知道自己已被除名，只能永远卡"连接中"
  // 并按心跳节奏刷帧。回一帧明文 pair_nack（此时不知道对方公钥、无法加密），
  // 浏览器据此显示"未配对"并停止重试。每设备 60s 限一帧，防心跳放大成刷屏。
  private notifyUnpaired(dev: string, reason: string): void {
    const now = Date.now();
    if (now - (this.unpairedNotice.get(dev) ?? 0) < 60_000) return;
    this.unpairedNotice.set(dev, now);
    this.send({ to: dev, data: { t: "pair_nack", error: reason } });
  }

  // #325 扫码登录：已配对手机扫了网页端出示的二维码后，经此方法把会话公钥升格为
  // 新已配对 peer 并主动推 pair_ack（与 6 位码 pair_req 成功路径同构——网页端
  // 收到即落成云源，全程免输码）。多桥场景各桥都发：页面只连了其中一座，
  // 未命中桥的帧自然丢弃；addPeer 在共享 identity 上做幂等
  grantLogin(dev: string, pubkey: string, name: string): boolean {
    if (!this.identity.peers.get(dev)) {
      this.identity.addPeer(dev, { pubkey, name, paired_at: Date.now() });
      console.log(`[cloud] login granted dev=${dev} name=${name} via ${this.tag}`);
      // 议题①/§6.3 补偿：扫码授权也是新设备获得全权——同样广播提醒持有者
      this.bus.emitTransient("PAIRED_DEVICE", { dev, name, action: "add" });
    }
    this.pendingGrantAcks.set(dev, Date.now());
    if (this.pendingGrantAcks.size > 50) {
      const now = Date.now();
      for (const [d, ts] of this.pendingGrantAcks) if (now - ts > 60_000) this.pendingGrantAcks.delete(d);
    }
    this.sendSealed(dev, {
      t: "pair_ack",
      relay_dev: this.identity.relayDev,
      relay_pubkey: this.identity.keypair.publicKey,
    });
    return true;
  }

  // 议题①踢除联动：先发明文 pair_nack 让设备立即「失联 + 停止重连」（复用未配对
  // 提示协议，但不吃 notifyUnpaired 的 60s 节流——管理员动作必须直达；设备此刻
  // 离线则帧自然丢失，它下次心跳会落入 drop-frame 分支再收一条），再停发下行。
  // peers 移除在 index.ts 的 kicker 里先做（identity.removePeer），这里只管通道侧。
  // 幂等：对不在 peers/phones 的 dev 调用无副作用（桥回 ROUTE_MISS 丢弃）
  kickPeer(dev: string): void {
    this.send({ to: dev, data: { t: "pair_nack", error: "已被管理员移除，请重新配对" } });
    this.phones.delete(dev);
    this.wanWatches.delete(dev);
    this.resumeOnOpen.delete(dev);
  }

  // 手机激活/恢复：缓冲内按 last_seq 补发，否则全量 SNAPSHOT（hello 与 ping-resume 共用）。
  // 全量恢复 = 单帧 SNAPSHOT 携带预算内日志（每会话最近 K 条 + 总字节上限，与 LAN 的
  // ws-server 同一构建）。#408（2026-09-09 断连死循环根因）：此前日志逐条 SESSION_LOG
  // 密文流式补发，历史涨到数千条时恢复即洪峰——CF 桥限流器把 relay 连接踢掉 → 重连 →
  // auto-resume 再补 → 自喂养死循环；更早版本全量内联单帧则撞 CF Workers ws 1MiB 单帧
  // 硬限。预算单帧两头都封死：无洪峰、帧有界（明文 ≤512KB → 密文 ~700KB < 900KB）。
  private resumePhone(dev: string, lastSeq: number): void {
    this.phones.set(dev, { lastSeq, active: true });
    this.identity.touchPeer(dev); // 议题①：last_seen 内存态更新（设备清单在线点）
    const replay = lastSeq > 0 && !this.bus.isBeyondBuffer(lastSeq) ? this.bus.replayAfter(lastSeq) : null;
    // 落后太多 = 设备冷启动（内存空但持久化了旧 seq）：增量事件只能更新已知会话、
    // 建不出列表，且上千帧补发挤占桥带宽——超过阈值直接 SNAPSHOT 全量重建
    if (replay && replay.length <= 200) {
      for (const env of replay) this.sendSealed(dev, env);
      return;
    }
    const snapSeq = this.bus.lastSeq();
    const snapLogs = this.mgr.buildSnapshotLogs();
    const snapshot: Envelope = {
      seq: snapSeq,
      session_id: "",
      ts: Date.now(),
      type: "SNAPSHOT",
      // relay_dev 随云通道快照自报（与 ws-server 的 LAN 快照同源，#401 补强）：客户端
      // 据此确认/补齐条目身份标记——云桥在线时同机的 LAN/云桥双条目也能归并。
      // wan_dev（F7）：手机据此拼手表 /wan 连接配置的 dev 段（凭据即 dev）；
      // 旧客户端忽略多余字段，向前兼容
      payload: {
        sessions: this.mgr.snapshot(),
        logs: snapLogs.logs,
        ...(Object.keys(snapLogs.logs_truncated).length ? { logs_truncated: snapLogs.logs_truncated } : {}),
        server_time: Date.now(),
        relay_dev: this.identity.relayDev,
        wan_dev: this.identity.wanDev,
      },
    };
    this.sendSealed(dev, snapshot);
  }

  private onFrame(text: string): void {
    let f: CloudFrame;
    try {
      f = JSON.parse(text) as CloudFrame;
    } catch {
      return;
    }
    // 桥告知目标手机不在线：标记下线等对方 ping/hello 恢复，避免持续向虚空加密下发
    if (f.type === "ROUTE_MISS" && f.to) {
      const st = this.phones.get(f.to) ?? this.wanWatches.get(f.to);
      if (st?.active) {
        st.active = false;
        console.log(`[cloud] route miss dev=${f.to}, mark inactive`);
      }
      return;
    }
    // #373 /wan 手表明文透传信封（桥可信通道）：{t:"wan", from, frame:"<relay协议明文JSON文本>"}
    const wanEnv = f.data as { t?: unknown; frame?: unknown } | undefined;
    if (f.from && wanEnv && typeof wanEnv === "object" && wanEnv.t === "wan" && typeof wanEnv.frame === "string") {
      this.handleWan(f.from, wanEnv.frame);
      return;
    }
    // 网页端等远端设备的一次性配对：data 为明文 {t:"pair_req", code, pubkey}（未配对设备
    // 尚无法加密；公钥本就公开，码一次性 10 分钟）。dev 必须与公钥派生值一致（防冒名），
    // 校验通过即 addPeer 并回密封 pair_ack。
    // bc=true 为配对码定位广播（多台 relay 挂同一座桥，手机不预知 rd、凭码找持码者）：
    // 码不归本机管 ≠ 错码——未持码时静默丢弃，绝不回 nack（桥上每台各回一份会把手机
    // 淹没）；错码计数照常累计（广播若不计错会被当爆破旁路）。旧手机/网页不发 bc，
    // 单播路径行为与从前完全一致。
    const pairReq = f.data as { t?: unknown } | undefined;
    if (f.from && pairReq && typeof pairReq === "object" && pairReq.t === "pair_req") {
      const pr = f.data as unknown as { code?: unknown; pubkey?: unknown; name?: unknown; bc?: unknown; meta?: unknown };
      const bc = pr.bc === true;
      const pubkey = typeof pr.pubkey === "string" ? pr.pubkey : "";
      const dev = pubkey ? devId(pubkey, "wb") : "";
      if (!pubkey || dev !== f.from) {
        console.log(`[cloud] pair_req rejected dev=${f.from}`);
        return;
      }
      const now = Date.now();
      const pf = this.pairFails.get(dev);
      if (pf && pf.until > now) {
        console.log(`[cloud] pair_req throttled dev=${dev}（连续错码）`);
        return;
      }
      if (pf) this.pairFails.delete(dev); // 静默期满：计数归零重来（否则手误 5 次后永久一触即锁）
      // 全局预算（F2）：耗尽后窗口内静默丢弃一切 pair_req（含正码——否则爆破第 51
      // 次猜中就穿门），且必须先于 consume 判定（否则会把用户的正码烧掉）
      if (now - this.pairBudgetStart >= this.pairBudgetWindowMs) {
        this.pairBudgetStart = now;
        this.pairBudgetN = 0;
      }
      if (this.pairBudgetUntil > now) {
        console.log(`[cloud] pair_req dropped dev=${dev}（全局错码预算耗尽，${Math.ceil((this.pairBudgetUntil - now) / 1000)}s 后重置）`);
        return;
      }
      if (this.pairCodes?.consume(String(pr.code ?? ""))) {
        // #42 可选自报 meta：校验/截断后随条目持久化（旧客户端无 meta = 字段缺省）
        const meta = sanitizePeerMeta(pr.meta);
        this.identity.addPeer(dev, {
          pubkey,
          name: typeof pr.name === "string" ? pr.name : "web",
          paired_at: Date.now(),
          ...(meta ? { meta } : {}),
        });
        console.log(`[cloud] paired web dev=${dev}${bc ? " via broadcast" : ""}`);
        // 议题①/§6.3 补偿告警：新设备获得全权的瞬间通知全部在线已配对设备——
        // 公共桥广播定位的 race 攻击即便得手，攻击设备立刻出现在持有者屏幕上
        this.bus.emitTransient("PAIRED_DEVICE", {
          dev,
          name: typeof pr.name === "string" ? pr.name : "web",
          action: "add",
        });
      } else if (!this.identity.peers.get(dev)) {
        // 码无效且未配对过：真拒绝；连续 5 次错码进入 10 分钟静默期（防爆破枚举），
        // 同时计入全局预算（广播 miss 同样计入——把广播当爆破旁路的路也封掉）。
        // 清理只删已过期条目，不清仍在静默期内的（全清会给爆破者开窗）
        const n = (pf?.n ?? 0) + 1;
        this.pairFails.set(dev, { n, until: n >= 5 ? now + 600_000 : 0 });
        if (++this.pairBudgetN >= this.pairBudgetMax) {
          this.pairBudgetUntil = this.pairBudgetStart + this.pairBudgetWindowMs;
          console.log(`[cloud] 全局错码预算耗尽（${this.pairBudgetMax} 次/窗口），静默至预算窗口结束`);
        }
        if (this.pairFails.size > 100) {
          for (const [d, v] of this.pairFails) if (v.until <= now) this.pairFails.delete(d);
        }
        console.log(`[cloud] pair_req ${bc ? "broadcast miss" : "rejected"} dev=${f.from}`);
        // 广播未命中静默：码是别的 relay 签发的，与本机无关
        if (!bc) this.send({ to: f.from, data: seal({ t: "pair_nack", error: "配对码无效或已过期" }, pubkey, this.identity.keypair.secretKey) });
        return;
      }
      // 码已消费但设备已配对：幂等补发 ack——首包 ack 可能随桥连接闪断一起丢失，
      // 浏览器重试/F5 即自愈，不必重新领配对链接
      this.sendSealed(f.from, { t: "pair_ack", relay_dev: this.identity.relayDev, relay_pubkey: this.identity.keypair.publicKey });
      return;
    }
    if (!f.from || !f.data || typeof f.from !== "string") return;
    const peer = this.identity.peers.get(f.from);
    if (!peer) {
      console.log(`[cloud] drop frame from unpaired dev=${f.from}`);
      this.notifyUnpaired(f.from, "设备不在 relay 配对列表中（relay 侧配对信息已丢失），请重新打开配对链接");
      return;
    }
    const inner = unseal<Record<string, unknown>>(f.data, peer.pubkey, this.identity.keypair.secretKey);
    if (!inner) {
      console.log(`[cloud] decrypt failed from dev=${f.from}（对端密钥已换，需重新配对）`);
      this.notifyUnpaired(f.from, "设备密钥对不上（浏览器或 relay 已换密钥），请重新打开配对链接");
      return;
    }
    if (inner.t === "hello") {
      const lastSeq = Number(inner.last_seq ?? 0) || 0;
      console.log(`[cloud] phone ${f.from} hello last_seq=${lastSeq}`);
      this.resumePhone(f.from, lastSeq);
      return;
    }
    if (inner.t === "ping") {
      // 手机应用层心跳：探测 NAT 半开（TCP 超时需分钟级，这里压到 <1 分钟）。
      // 兼作 resume：relay 侧断线重连/重启会把手机置 active=false，但手机 ws 存活
      // 不会再发 hello，下行将永久黑洞（上行命令/ACK 不受门控，极难察觉）——
      // ping 到达即链路通，顺手按 ping.last_seq 恢复补发（旧版无字段则全量 SNAPSHOT）。
      const st = this.phones.get(f.from);
      const lastSeq = Number(inner.last_seq ?? 0) || 0;
      if (!st || !st.active) {
        console.log(`[cloud] phone ${f.from} resume via ping last_seq=${lastSeq}`);
        this.resumePhone(f.from, lastSeq);
      } else {
        st.lastSeq = lastSeq;
        this.identity.touchPeer(f.from); // 议题①：活跃心跳同样推进 last_seen
      }
      this.sendSealed(f.from, { t: "pong", ts: Date.now() });
      return;
    }
    // 普通命令（COMMAND_ACK 加密回发，与 ws-server 的直发 ACK 同构）
    const cmd = inner as unknown as Command;
    if (typeof cmd.command_id !== "string" || typeof cmd.type !== "string" || typeof cmd.payload !== "object" || !cmd.payload) {
      this.sendSealed(f.from, { type: "COMMAND_ACK", command_id: "?", ok: false, error: "invalid command shape" });
      return;
    }
    const ack: CommandAckPayload = this.mgr.handleCommand(cmd, `cloud-${f.from}`);
    this.sendSealed(f.from, { type: "COMMAND_ACK", ...ack });
  }

  private onEnv(env: Envelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const [dev, st] of this.phones) {
      // 推进 lastSeq：桥闪断后 auto-resume 按 seq 补发，服务端必须知道已推到哪
      // （否则只能等设备 ping 上报，回补会重复下发已收事件）。
      // seq 单调守卫：瞬态帧（seq:0，如 PAIRED_DEVICE）不回拨 lastSeq
      if (st.active && this.sendSealed(dev, env) && env.seq > st.lastSeq) st.lastSeq = env.seq;
    }
    for (const [dev, st] of this.wanWatches) {
      if (st.active) {
        this.sendWan(dev, env);
        if (env.seq > st.lastSeq) st.lastSeq = env.seq;
      }
    }
  }

  // ---------- #373 /wan 手表明文透传 ----------
  private sendWan(dev: string, obj: unknown): void {
    this.send({ to: dev, data: { t: "wan", frame: JSON.stringify(obj) } });
  }

  // F7 收口：公共桥（token 公开，任意人可注册任意 dev）上 /wan 明文通道等于无鉴权
  // 全权信道——默认拒绝未持本机 wan 凭据（identity.wanDev，data/wan-secret 派生）
  // 的手表；自建桥维持「桥可信」原语义（手表仍可用 wt-app1 等任意 dev）。
  // CCR_WAN_STRICT=1 强制全桥严格 / =0 强制全桥放开（自建公共桥运营者可选严格）
  private get wanStrict(): boolean {
    const v = process.env.CCR_WAN_STRICT;
    if (v === "1") return true;
    if (v === "0") return false;
    try {
      const h = new URL(this.url ?? this.cfg.cloudUrl).hostname;
      return h === "cc.humumu.online" || h === "cc-deck.humumu.online";
    } catch {
      return true;
    }
  }

  // 手表上行帧：hello（连接/重连，带 last_seq 增量恢复）或 Command（ACK 明文信封回发）
  private handleWan(dev: string, frameText: string): void {
    if (!dev.startsWith("wt-")) {
      console.log(`[cloud] wan frame from non-watch dev=${dev}, drop`);
      return;
    }
    if (this.wanStrict && dev !== this.identity.wanDev) {
      // 默认拒绝：不回包（不确认凭据有效性）、不烧任何状态；日志限频防刷屏
      const now = Date.now();
      if (now - this.wanDropLoggedAt > 30_000) {
        this.wanDropLoggedAt = now;
        console.log(`[cloud] wan frame from untrusted watch dev=${dev} dropped（严格模式，凭据 dev=${this.identity.wanDev}，bridge=${this.tag}）`);
      }
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(frameText);
    } catch {
      this.sendWan(dev, { type: "COMMAND_ACK", command_id: "?", ok: false, error: "bad json" });
      return;
    }
    const o = obj as { t?: unknown; last_seq?: unknown };
    if (o && o.t === "hello") {
      this.resumeWan(dev, typeof o.last_seq === "number" ? o.last_seq : 0);
      return;
    }
    const cmd = obj as Command;
    if (typeof cmd === "object" && cmd && typeof cmd.command_id === "string" && typeof cmd.type === "string") {
      const ack: CommandAckPayload = this.mgr.handleCommand(cmd, `wan-${dev}`);
      this.sendWan(dev, { type: "COMMAND_ACK", ...ack });
      return;
    }
    this.sendWan(dev, { type: "COMMAND_ACK", command_id: "?", ok: false, error: "invalid command shape" });
  }

  // 手表恢复：与 resumePhone 同构（缓冲内增量补发 / 全量 SNAPSHOT 单帧带预算日志），
  // 明文信封下发。#408：流式日志洪峰在 /wan 通道同样会踢桥，与云手机路径一并根治
  private resumeWan(dev: string, lastSeq: number): void {
    const known = this.wanWatches.has(dev);
    this.wanWatches.set(dev, { lastSeq, active: true });
    if (!known) console.log(`[cloud] watch ${dev} online via wan`);
    const replay = lastSeq > 0 && !this.bus.isBeyondBuffer(lastSeq) ? this.bus.replayAfter(lastSeq) : null;
    if (replay && replay.length <= 200) {
      for (const env of replay) this.sendWan(dev, env);
      return;
    }
    const snapSeq = this.bus.lastSeq();
    const snapLogs = this.mgr.buildSnapshotLogs();
    const snapshot: Envelope = {
      seq: snapSeq,
      session_id: "",
      ts: Date.now(),
      type: "SNAPSHOT",
      payload: {
        sessions: this.mgr.snapshot(),
        logs: snapLogs.logs,
        ...(Object.keys(snapLogs.logs_truncated).length ? { logs_truncated: snapLogs.logs_truncated } : {}),
        server_time: Date.now(),
      },
    };
    this.sendWan(dev, snapshot);
  }

  close(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.ws?.close();
  }
}
