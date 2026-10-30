// X1 多机编排：密封 xmsg 域核心（PRD v0.3 §3.2/§4.2-4.4/§4.8）。
// 纯域模块 + 文件账本（outbox/seen/held/peer 公钥缓存）——除 device_trust 表（device-trust.ts）
// 外零 SQLite（PRD §4.5「relay 侧 SQLite 仅 device_trust 一表」口径）。
// 传输面在 cloud-client（密封/解封/桥帧），策略面在 session-manager（信任裁决/注入/xack），
// 本文件是两方共享的账本与校验单源。
//
// 线格式（PRD §3.2 + spk 扩展，备案回执「PRD 口径备案」节）：
//   桥帧 {to:"rl-yyy", data:{t:"xmsg", v:1, spk:"<发送方公钥b64>", env:{n,c}}}
//   内层明文 XmsgInner（env 密封体）；回执 {t:"xack", v:1, spk, env:{n,c}} 内层 XackInner。
//   spk=发送方公钥（公钥本就 disc 公开，router.ts keyOf 同口径）；dev 与 spk 的派生一致性
//   （devId(spk,"rl")===from）由接收方校验，与 pair_req 防冒名同款。明文 xmsg 即丢/拒绝。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devId, type SealedBox } from "./e2e.js";

// ---------- 常量（§4.8 承 v0.2：24h 同窗幂等/outbox 落盘/串行/限速 2 条每对每秒；D2：32KB） ----------

export const XMSG_BODY_MAX = 32 * 1024; // D2 拍板：单条 ≤32KB（分片预留，本批不分片）
export const XMSG_TTL_DEFAULT_MS = 5 * 60_000; // 断线补发窗口内有效
export const XMSG_TTL_MAX_MS = 15 * 60_000;
export const XMSG_SEEN_WINDOW_MS = 24 * 60 * 60_000; // 24h 同窗幂等（msg_id 去重）
export const XMSG_RATE_PER_PAIR = 2; // 每对每秒 2 条（收发两侧各设闸）
export const XMSG_RATE_WINDOW_MS = 1_000;
export const XMSG_HELD_MAX_PER_DEV = 8; // 首联卡悬置消息上限（超出 rejected:held-overflow）
export const XMSG_OUTBOX_KEEP_MS = 10 * 60_000; // 终态条目保留时长（ccops 轮询窗口）
export const XMSG_SEND_RETRY_MS = 3_000; // 未回执重发间隔（接收侧 msg_id 幂等=零重）

/** CCR_XMSG 开关（默认 off=纯现状零行为差异，§5 渐进；与 CCR_TENANT 同范式）。 */
export function xmsgEnabled(): boolean {
  return process.env.CCR_XMSG === "1";
}

// ---------- 线类型 ----------

export interface XmsgSource {
  dev: string; // 发送方 relay dev（rl-xxxx）
  session?: string; // 发送方来源会话（值班位发送时缺省）
  role?: string; // 发送角色（pm/worker/…，可选）
}

/** 密封内层明文体（PRD §3.2）。 */
export interface XmsgInner {
  t: "xmsg";
  v: 1;
  tenant: string | null; // 发送方租户（未登录=null——接收方按 null-tenant 窗口矩阵裁决）
  source: XmsgSource;
  target: { session?: string }; // 目标会话（缺省=对端值班位，§4.2-1 痛点 D 回程）
  msg_id: string;
  ts: number;
  ttl: number;
  ack_req: boolean;
  body: string;
}

/** 回执内层（PRD §3.2：queued|injected|rejected:<reason>|failed[:<reason>]）。 */
export interface XackInner {
  t: "xack";
  msg_id: string;
  state: string;
  note?: string; // 人话补充（首联悬置/限速提示等）
}

/** 桥帧 data 外层（明文壳：桥定向帧不检内层类型，本格式零桥侧改动）。 */
export interface XmsgWire {
  t: "xmsg";
  v: 1;
  spk: string;
  env: SealedBox;
}
export interface XackWire {
  t: "xack";
  v: 1;
  spk: string;
  env: SealedBox;
}

export function isXmsgWire(d: unknown): d is XmsgWire {
  const w = d as Partial<XmsgWire> | null;
  return !!w && typeof w === "object" && w.t === "xmsg" && typeof w.spk === "string" && !!w.spk
    && !!w.env && typeof w.env === "object" && typeof w.env.n === "string" && typeof w.env.c === "string";
}
export function isXackWire(d: unknown): d is XackWire {
  const w = d as Partial<XackWire> | null;
  return !!w && typeof w === "object" && w.t === "xack" && typeof w.spk === "string" && !!w.spk
    && !!w.env && typeof w.env === "object" && typeof w.env.n === "string" && typeof w.env.c === "string";
}

/** dev↔pubkey 自洽校验（防冒名：与 pair_req 同款，#42 口径）。 */
export function spkMatchesDev(spk: string, from: string): boolean {
  try {
    return devId(spk, "rl") === from;
  } catch {
    return false;
  }
}

// ---------- 内层校验（矩阵单源：cloud-client 接收口与测试共用） ----------

export type XmsgInvalid = { ok: false; reason: string };

export function validateXmsgInner(inner: unknown, now = Date.now()): { ok: true } | XmsgInvalid {
  const x = inner as Partial<XmsgInner> | null;
  if (!x || typeof x !== "object") return { ok: false, reason: "shape" };
  if (x.t !== "xmsg") return { ok: false, reason: "type" };
  if (x.v !== 1) return { ok: false, reason: "version" };
  if (!(typeof x.tenant === "string" || x.tenant === null)) return { ok: false, reason: "tenant" };
  if (!x.source || typeof x.source !== "object" || typeof x.source.dev !== "string" || !x.source.dev.startsWith("rl-")) {
    return { ok: false, reason: "source" };
  }
  if (x.source.session !== undefined && (typeof x.source.session !== "string" || !x.source.session)) return { ok: false, reason: "source-session" };
  if (x.target === null || typeof x.target !== "object") return { ok: false, reason: "target" };
  if (x.target.session !== undefined && (typeof x.target.session !== "string" || !x.target.session)) return { ok: false, reason: "target-session" };
  if (typeof x.msg_id !== "string" || !/^[a-zA-Z0-9-]{6,64}$/.test(x.msg_id)) return { ok: false, reason: "msg-id" };
  if (typeof x.ts !== "number" || !Number.isFinite(x.ts)) return { ok: false, reason: "ts" };
  const ttl = typeof x.ttl === "number" ? x.ttl : XMSG_TTL_DEFAULT_MS;
  if (ttl < 0 || ttl > XMSG_TTL_MAX_MS) return { ok: false, reason: "ttl" };
  if (now - x.ts > ttl) return { ok: false, reason: "expired" };
  if (now < x.ts - 60_000) return { ok: false, reason: "clock-skew" }; // 未来钟漂 >60s 拒
  if (typeof x.body !== "string" || !x.body || x.body.length > XMSG_BODY_MAX) return { ok: false, reason: "body" };
  return { ok: true };
}

// ---------- 来源标注（§4.3：接收侧机器生成、不可剥离——发送方无法伪造/剥离前缀） ----------

export function xmsgAnnotation(source: XmsgSource): string {
  const sid8 = source.session ? source.session.slice(0, 8) : "";
  return sid8
    ? `⇄跨机 · 来自 ${source.dev} 会话 ${sid8} · 非本机手输`
    : `⇄跨机 · 来自 ${source.dev}（值班位）· 非本机手输`;
}

/** 注入正文 = 标注首行 + 原文（标注由接收方拼装=不可剥离语义的实现位）。 */
export function annotateBody(inner: XmsgInner): string {
  return `${xmsgAnnotation(inner.source)}\n${inner.body}`;
}

// ---------- 文件账本底座（tmp+rename 原子写；坏文件视作空态——org 文件域惯例） ----------

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf-8");
  renameSync(tmp, path);
}

// ---------- outbox（§4.8：落盘 + 本机重连补发腿；幂等由接收侧 seen 承接） ----------

export type XmsgOutboxState = "pending" | "sent" | "injected" | "rejected" | "failed";

export interface XmsgOutboxEntry {
  msg_id: string;
  dev: string; // 目标设备
  session?: string; // 目标会话（缺省=对端值班位）
  body: string;
  tenant: string | null;
  state: XmsgOutboxState;
  detail?: string; // 终态人话（rejected:no-session 等）
  ts: number;
  tries: number;
  last_try_at?: number;
  terminal_at?: number;
}

export function isTerminalState(s: XmsgOutboxState): boolean {
  return s === "injected" || s === "rejected" || s === "failed";
}

export class XmsgOutbox {
  private entries: XmsgOutboxEntry[] = [];
  constructor(private path: string, private now: () => number = Date.now) {
    this.entries = readJson<XmsgOutboxEntry[]>(path, []);
  }
  private flush(): void {
    // 终态条目过窗即清（ccops/org 轮询窗口 10min）；未决条目永不清（补发腿的账）
    const cutoff = this.now() - XMSG_OUTBOX_KEEP_MS;
    this.entries = this.entries.filter((e) => !isTerminalState(e.state) || (e.terminal_at ?? 0) > cutoff);
    writeJsonAtomic(this.path, this.entries);
  }
  append(e: Omit<XmsgOutboxEntry, "state" | "tries">): XmsgOutboxEntry {
    const entry: XmsgOutboxEntry = { ...e, state: "pending", tries: 0 };
    this.entries.push(entry);
    this.flush();
    return entry;
  }
  get(msgId: string): XmsgOutboxEntry | undefined {
    return this.entries.find((e) => e.msg_id === msgId);
  }
  /** 发送侧状态机单点：pending→sent→(injected|rejected|failed)；终态不可回退。 */
  mark(msgId: string, state: XmsgOutboxState, detail?: string): XmsgOutboxEntry | undefined {
    const e = this.get(msgId);
    if (!e) return undefined;
    if (isTerminalState(e.state)) return e; // 终态幂等（迟到回执不回退）
    e.state = state;
    if (detail !== undefined) e.detail = detail;
    if (state === "sent") {
      e.tries += 1;
      e.last_try_at = this.now();
    }
    if (isTerminalState(state)) e.terminal_at = this.now();
    this.flush();
    return e;
  }
  /** pending/sent 未决条目（重连补发与周期重发腿的输入；ttl 过期→failed:ttl-expired）。 */
  due(now = this.now()): XmsgOutboxEntry[] {
    for (const e of this.entries) {
      if ((e.state === "pending" || e.state === "sent") && now - e.ts > XMSG_TTL_DEFAULT_MS) {
        e.state = "failed";
        e.detail = "ttl-expired";
        e.terminal_at = now;
      }
    }
    this.flush();
    return this.entries.filter((e) => e.state === "pending" || e.state === "sent");
  }
  list(): XmsgOutboxEntry[] {
    return [...this.entries];
  }
}

// ---------- seen（24h 同窗幂等：接收侧 msg_id → 回执态缓存，重发零重投） ----------

/** seen 条目：state/note 之外携带 from/spk——ext-input 异步注入完成（injected 升级）时
 * 回执需要来方地址；持久化后 relay 重启也不丢回执能力。 */
export interface XmsgSeenRecord {
  state: string;
  note?: string;
  ts: number;
  from?: string;
  spk?: string;
}

export class XmsgSeen {
  private map: Map<string, XmsgSeenRecord>;
  constructor(private path: string, private now: () => number = Date.now) {
    this.map = new Map(Object.entries(readJson<Record<string, XmsgSeenRecord>>(path, {})));
    this.prune();
  }
  private prune(): void {
    const cutoff = this.now() - XMSG_SEEN_WINDOW_MS;
    let dirty = false;
    for (const [k, v] of this.map) {
      if (v.ts < cutoff) {
        this.map.delete(k);
        dirty = true;
      }
    }
    if (dirty) this.flush();
  }
  private flush(): void {
    writeJsonAtomic(this.path, Object.fromEntries(this.map));
  }
  /** 命中=窗口内重复消息（回缓存回执，不再投递）。 */
  hit(msgId: string): XmsgSeenRecord | null {
    return this.map.get(msgId) ?? null;
  }
  record(msgId: string, state: string, note?: string, meta?: { from?: string; spk?: string }): void {
    const prev = this.map.get(msgId);
    this.map.set(msgId, {
      state, ts: this.now(),
      note: note ?? prev?.note,
      from: meta?.from ?? prev?.from,
      spk: meta?.spk ?? prev?.spk,
    });
    this.prune();
    this.flush();
  }
}

// ---------- held（首联卡悬置：确认前扣住、确认后放行、否决即弃——§4.4 域内-首次确认） ----------

export interface XmsgHeldItem {
  msg_id: string;
  inner: XmsgInner; // 完整内层（确认后原样走投递链）
  ts: number;
}

export class XmsgHeld {
  private map: Map<string, XmsgHeldItem[]>;
  constructor(private path: string, private now: () => number = Date.now) {
    this.map = new Map(Object.entries(readJson<Record<string, XmsgHeldItem[]>>(path, {})));
  }
  private flush(): void {
    writeJsonAtomic(this.path, Object.fromEntries(this.map));
  }
  /** 悬置一条；返回 false = 超上限（调用方回 rejected:held-overflow）。 */
  hold(dev: string, item: XmsgHeldItem): boolean {
    const q = this.map.get(dev) ?? [];
    if (q.length >= XMSG_HELD_MAX_PER_DEV) return false;
    q.push(item);
    this.map.set(dev, q);
    this.flush();
    return true;
  }
  drain(dev: string): XmsgHeldItem[] {
    const q = this.map.get(dev) ?? [];
    this.map.delete(dev);
    this.flush();
    return q;
  }
  count(dev: string): number {
    return this.map.get(dev)?.length ?? 0;
  }
}

// ---------- peer 公钥缓存（发送侧密封目标发现：disc/RELAYS 与来帧 spk 双源进账） ----------

export class XmsgPeers {
  private map: Map<string, { pubkey: string; ts: number }>;
  constructor(private path: string, private now: () => number = Date.now) {
    this.map = new Map(Object.entries(readJson<Record<string, { pubkey: string; ts: number }>>(path, {})));
  }
  private flush(): void {
    writeJsonAtomic(this.path, Object.fromEntries(this.map));
  }
  get(dev: string): string | null {
    return this.map.get(dev)?.pubkey ?? null;
  }
  put(dev: string, pubkey: string): void {
    this.map.set(dev, { pubkey, ts: this.now() });
    this.flush();
  }
}

// ---------- 限速闸（§4.8 每对每秒 2 条；收发两侧各一实例——发送侧排队节流、接收侧超限拒绝） ----------

export class XmsgRateGate {
  private hist = new Map<string, number[]>();
  constructor(private max = XMSG_RATE_PER_PAIR, private windowMs = XMSG_RATE_WINDOW_MS, private now: () => number = Date.now) {}
  /** 滑窗计数；过闸即记账（发送侧拿到 false 应延后重试而非丢弃）。 */
  allow(peer: string): boolean {
    const t = this.now();
    const q = (this.hist.get(peer) ?? []).filter((x) => t - x < this.windowMs);
    if (q.length >= this.max) {
      this.hist.set(peer, q);
      return false;
    }
    q.push(t);
    this.hist.set(peer, q);
    return true;
  }
}

// ---------- 账本装配（单一构造口：dataDir 下四文件） ----------

export interface XmsgStores {
  outbox: XmsgOutbox;
  seen: XmsgSeen;
  held: XmsgHeld;
  peers: XmsgPeers;
}

export function openXmsgStores(dataDir: string, now: () => number = Date.now): XmsgStores {
  return {
    outbox: new XmsgOutbox(join(dataDir, "xmsg-outbox.json"), now),
    seen: new XmsgSeen(join(dataDir, "xmsg-seen.json"), now),
    held: new XmsgHeld(join(dataDir, "xmsg-held.json"), now),
    peers: new XmsgPeers(join(dataDir, "xmsg-peers.json"), now),
  };
}
