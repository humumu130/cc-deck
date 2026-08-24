import WebSocket from "ws";
import type { EventBus } from "./event-bus.js";
import type { SessionManager } from "./session-manager.js";
import type { RelayConfig } from "./config.js";
import type { CloudIdentity } from "./cloud-identity.js";
import { seal, unseal, type SealedBox } from "./e2e.js";
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
  private unsubscribe: () => void;

  constructor(
    private bus: EventBus,
    private mgr: SessionManager,
    private cfg: RelayConfig,
    private identity: CloudIdentity,
  ) {
    this.unsubscribe = bus.subscribe((env) => this.onEnv(env));
  }

  start(): void {
    this.connect();
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
      console.log(`[cloud] bridge connected (dev=${this.identity.relayDev})`);
    });
    ws.on("message", (raw) => this.onFrame(String(raw)));
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

  private send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private sendSealed(dev: string, obj: unknown): void {
    const peer = this.identity.peers.get(dev);
    if (!peer) return;
    this.send({ to: dev, data: seal(obj, peer.pubkey, this.identity.keypair.secretKey) });
  }

  private onFrame(text: string): void {
    let f: CloudFrame;
    try {
      f = JSON.parse(text) as CloudFrame;
    } catch {
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
      this.phones.set(f.from, { lastSeq, active: true });
      console.log(`[cloud] phone ${f.from} hello last_seq=${lastSeq}`);
      if (lastSeq > 0 && !this.bus.isBeyondBuffer(lastSeq)) {
        for (const env of this.bus.replayAfter(lastSeq)) this.sendSealed(f.from, env);
      } else {
        const snapshot: Envelope = {
          seq: this.bus.lastSeq(),
          session_id: "",
          ts: Date.now(),
          type: "SNAPSHOT",
          payload: { sessions: this.mgr.snapshot(), logs: this.mgr.snapshotLogs(), server_time: Date.now() },
        };
        this.sendSealed(f.from, snapshot);
      }
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
    this.ws?.close();
  }
}
