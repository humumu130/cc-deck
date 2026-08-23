import type { Envelope, EventType } from "./types.js";
import { appendLine } from "./history.js";

type Listener = (env: Envelope) => void;

export interface EventBusOptions {
  capacity?: number;
  // 重启恢复：历史事件预填缓冲（seq 延续，重连客户端可无缝补发）
  preload?: Envelope[];
  // 落盘路径：设置后每个事件追加写入 ndjson
  persistPath?: string;
}

// 全局 seq 计数 + 环形缓冲 + 订阅/补发 + 可选持久化
export class EventBus {
  private seq = 0;
  private buffer: Envelope[] = [];
  private listeners = new Set<Listener>();

  constructor(private opts: EventBusOptions = {}) {
    const capacity = opts.capacity ?? 500;
    if (opts.preload?.length) {
      const sorted = [...opts.preload].sort((a, b) => a.seq - b.seq);
      this.seq = sorted[sorted.length - 1].seq;
      this.buffer = sorted.slice(Math.max(0, sorted.length - capacity));
    }
  }

  emit<P>(sessionId: string, type: EventType, payload: P): Envelope {
    const env: Envelope = {
      seq: ++this.seq,
      session_id: sessionId,
      ts: Date.now(),
      type,
      payload,
    };
    this.buffer.push(env);
    if (this.buffer.length > (this.opts.capacity ?? 500)) {
      this.buffer.splice(0, this.buffer.length - (this.opts.capacity ?? 500));
    }
    if (this.opts.persistPath) {
      try {
        appendLine(this.opts.persistPath, env);
      } catch {
        // 落盘失败不影响在线广播
      }
    }
    for (const l of this.listeners) {
      try {
        l(env);
      } catch {
        // 单个监听者异常不影响广播
      }
    }
    return env;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  lastSeq(): number {
    return this.seq;
  }

  // 补发 last_seq 之后的事件（含缓冲被裁剪的处理：调用方需检测缺口）
  replayAfter(lastSeq: number): Envelope[] {
    return this.buffer.filter((e) => e.seq > lastSeq);
  }

  // 客户端 last_seq 落后到缓冲之外时，需要全量快照重建
  isBeyondBuffer(lastSeq: number): boolean {
    const oldest = this.buffer[0];
    return !oldest ? lastSeq < this.seq : lastSeq < oldest.seq - 1;
  }
}
