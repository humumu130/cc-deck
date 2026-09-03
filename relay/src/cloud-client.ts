import WebSocket from "ws";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConfig } from "./config.js";
import type { CloudIdentity } from "./cloud-identity.js";
import type { PairingCodes } from "./pairing.js";
import { devId, seal, unseal, type SealedBox } from "./e2e.js";
import type { Command, CommandAckPayload, Envelope } from "./types.js";

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

// 云桥上行客户端：出站连桥（CCR_CLOUD_URL，公司网络友好），把 EventBus 事件
// E2E 加密转发给每个已 hello 的手机，手机命令解密后交给 handleCommand。
// resume 语义与 ws-server 完全相同：hello.last_seq 在缓冲内补发，否则 SNAPSHOT。
export class CloudClient {
  private ws: WebSocket | null = null;
  private phones = new Map<string, PhoneState>();
  private delayMs = 1000;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRecv = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: () => void;

  constructor(
    private bus: EventBus,
    private mgr: SessionManager,
    private cfg: RelayConfig,
    private identity: CloudIdentity,
    private pairCodes?: PairingCodes,
  ) {
    this.unsubscribe = bus.subscribe((env) => this.onEnv(env));
  }

  start(): void {
    this.connect();
    this.startHeartbeat();
  }

  private bridgeUrl(): string {
    const base = this.cfg.cloudUrl;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}token=${encodeURIComponent(this.cfg.cloudToken)}&dev=${this.identity.relayDev}`;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.bridgeUrl());
    this.ws = ws;
    ws.on("open", () => {
      this.delayMs = 1000;
      this.lastRecv = Date.now();
      console.log(`[cloud] bridge connected (dev=${this.identity.relayDev})`);
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
        console.log(`[cloud] bridge disconnected, retry in ${this.delayMs}ms`);
        for (const st of this.phones.values()) st.active = false;
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
      if (Date.now() - this.lastRecv > 25_000) {
        console.log("[cloud] heartbeat timeout (>25s no traffic), terminating for reconnect");
        ws.terminate();
        return;
      }
      ws.ping();
    }, 10_000);
    this.hbTimer.unref?.();
  }

  private send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  // 云通道是否有已 hello 的手机（提问/权限门控的"手机在线"判定要计入）
  hasActivePhones(): boolean {
    for (const st of this.phones.values()) if (st.active) return true;
    return false;
  }

  private sendSealed(dev: string, obj: unknown): void {
    const peer = this.identity.peers.get(dev);
    if (!peer) return;
    this.send({ to: dev, data: seal(obj, peer.pubkey, this.identity.keypair.secretKey) });
  }

  // 手机激活/恢复：缓冲内按 last_seq 补发，否则全量 SNAPSHOT（hello 与 ping-resume 共用）。
  // 全量恢复时 SNAPSHOT 只带会话状态不带时间线日志，日志随后逐条 SESSION_LOG 密文流式补发
  // （手机端 SESSION_LOG 处理器即 pushLog 追加，旧 APK 直接兼容）——所有日志塞进单帧会随
  // 历史增长无限膨胀，迟早再次撞上桥的帧上限；流式每帧只有单条日志大小。
  // 流式帧 seq 统一取 snapshot 时的 lastSeq：手机 lastSeq 不会因此前移，下次重连的 bus
  // 补发从该 seq 之后开始，不会与已流式补发的旧日志重复。
  private resumePhone(dev: string, lastSeq: number): void {
    this.phones.set(dev, { lastSeq, active: true });
    if (lastSeq > 0 && !this.bus.isBeyondBuffer(lastSeq)) {
      for (const env of this.bus.replayAfter(lastSeq)) this.sendSealed(dev, env);
      return;
    }
    const snapSeq = this.bus.lastSeq();
    const snapshot: Envelope = {
      seq: snapSeq,
      session_id: "",
      ts: Date.now(),
      type: "SNAPSHOT",
      payload: { sessions: this.mgr.snapshot(), logs: {}, server_time: Date.now() },
    };
    this.sendSealed(dev, snapshot);
    for (const [sid, logs] of Object.entries(this.mgr.snapshotLogs())) {
      for (const entry of logs) {
        this.sendSealed(dev, {
          seq: snapSeq,
          session_id: sid,
          ts: entry.ts ?? Date.now(),
          type: "SESSION_LOG",
          payload: entry,
        } as Envelope);
      }
    }
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
      const st = this.phones.get(f.to);
      if (st?.active) {
        st.active = false;
        console.log(`[cloud] route miss dev=${f.to}, mark inactive`);
      }
      return;
    }
    // 网页端等远端设备的一次性配对：data 为明文 {t:"pair_req", code, pubkey}（未配对设备
    // 尚无法加密；公钥本就公开，码一次性 10 分钟）。dev 必须与公钥派生值一致（防冒名），
    // 校验通过即 addPeer 并回密封 pair_ack。
    const pairReq = f.data as { t?: unknown } | undefined;
    if (f.from && pairReq && typeof pairReq === "object" && pairReq.t === "pair_req") {
      const pr = f.data as unknown as { code?: unknown; pubkey?: unknown; name?: unknown };
      const pubkey = typeof pr.pubkey === "string" ? pr.pubkey : "";
      const dev = pubkey ? devId(pubkey, "wb") : "";
      if (!pubkey || dev !== f.from || !this.pairCodes?.consume(String(pr.code ?? ""))) {
        console.log(`[cloud] pair_req rejected dev=${f.from}`);
        if (pubkey && dev === f.from) {
          this.send({ to: f.from, data: seal({ t: "pair_nack", error: "配对码无效或已过期" }, pubkey, this.identity.keypair.secretKey) });
        }
        return;
      }
      this.identity.addPeer(dev, { pubkey, name: typeof pr.name === "string" ? pr.name : "web", paired_at: Date.now() });
      console.log(`[cloud] paired web dev=${dev}`);
      this.sendSealed(f.from, { t: "pair_ack", relay_dev: this.identity.relayDev, relay_pubkey: this.identity.keypair.publicKey });
      return;
    }
    if (!f.from || !f.data || typeof f.from !== "string") return;
    const peer = this.identity.peers.get(f.from);
    if (!peer) {
      console.log(`[cloud] drop frame from unpaired dev=${f.from}`);
      return;
    }
    const inner = unseal<Record<string, unknown>>(f.data, peer.pubkey, this.identity.keypair.secretKey);
    if (!inner) {
      console.log(`[cloud] decrypt failed from dev=${f.from}（对端密钥已换，需重新配对）`);
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
      if (st.active) this.sendSealed(dev, env);
    }
  }

  close(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.ws?.close();
  }
}
