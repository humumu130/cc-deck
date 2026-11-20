// CONNV4 批D（connv4d）：LAN 邻居发现 + 一键发起 + 对端同意流 + 拒绝记忆。
//
// 安全红线（评审 R5 / review-connv4-sec §一，写死）：
//   ①同意制只授权传输层准入；身份恒走配对码/账号信任链（同账号+LAN=免码复用 rk）。
//     本批不新建任何数据连接通道——同意落 device_trust confirmed 行（准入记账），
//     真正的会话数据信任照既有链（配对码/同账号 rk），不因 LAN 加宽（验收点6）。
//   ②弹窗信息（名字）= 不可信展示层（mDNS 明文可伪造）；身份键恒为公钥派生 dev
//     （rl- 前缀，relay 身份域——与 cloud-client 的 wb-/ph-/wt- 客户端设备域分属两域，
//     不新增前缀不复用 wb-：LAN 邻居是「对端 relay」不是「本机客户端设备」）。
//     拒绝记忆/冷却全键于 dev（=公钥指纹，评审 P2「拒绝记忆可键于公钥指纹」）。
//   ③请求帧「签名」（评审 P2 加固）= sealed box：发起端用自身私钥+本机公钥密封
//     {op, ts, name}，本机 unseal 成功即证明持钥（面向受理方的持钥证明，等价签名，
//     零新密钥类型——复用 cloud-keypair）+ ts ±5min 窗防重放。防「弹窗洪水伪造」
//     （攻击者可伪造名字但无法为任意 dev 构造密文）。E2E 兜底：伪造同意最坏后果
//     =一条空转传输连接，零数据暴露。
//
// 拒绝记忆 = setIgnored（admin_state 忽略清单，批C1 复用）+ revokeDevice（trust 吊销）；
// 解除 = 批C2 设备管理 unignore（clearAdminMarks+unRevokeDevice 链已就绪，本批零新代码）。
// 重复请求限频 = 独立短冷却 60s（KICK_COOLDOWN 24h 是账号类踢除语义，语义不合；
// 冷却只挡 request 弹卡路径，status 只读查询不受限——验收点5）。
import { devId, seal, unseal, type BoxKeyPair, type SealedBox } from "./e2e.js";
import { addConfirm, listPendingConfirms } from "./projects.js";
import {
  adminVerdict, setIgnored,
} from "./device-admin.js";
import {
  confirmDevice, getDeviceTrust, revokeDevice, trustStore, trustVerdict, upsertFirstSeen,
} from "./device-trust.js";
import { browseLanPeers, type BonjourCtor } from "./mdns.js";

/** LAN 待连冷却：同意前状态重复 request 60s 内静默回缓存态（防骚扰弹卡；只挡 request）。 */
export const LAN_CONNECT_COOLDOWN_MS = 60_000;
/** 请求帧 ts 窗口：±5 分钟（时钟漂移容忍+重放窗上限）。 */
export const LAN_CONNECT_TS_WINDOW_MS = 5 * 60_000;

export interface LanPeer {
  dev: string;
  name: string;
  pk: string;
  ip: string;
  port: number;
  ts: number;
}

/** 发起端视角的连接状态（states 缓存；web 源列表行渲染消费）。 */
export type LanConnStatus = "none" | "pending" | "confirmed" | "rejected";

// ---------- 发现侧：mDNS 服务 → LanPeer（纯函数，测试直测） ----------

function txtOf(raw: unknown): Record<string, unknown> {
  // bonjour-service 的 txt 是 KeyValue 对象（key→value）；异常形态一律空对象
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function ipv4Of(addresses: unknown): string {
  if (!Array.isArray(addresses)) return "";
  const v4 = addresses.filter((a) => typeof a === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith("127."));
  return v4[0] ?? "";
}

/** mDNS 服务解析：v2 TXT（v/dev/nm/pk）+dev 自洽（devId(pk)===dev）+自见过滤。
 *  不合格（v1 旧帧无标识/pk 不自洽/无 IPv4/是本机）返回 null——发现侧单点收口，
 *  伪装者广播假 dev（无对应私钥的 pk）在此被过滤（假 pk+自洽 dev 仍可通过=接受面：
 *  名字不可信公钥才是，拒绝记忆键于真指纹）。 */
export function parseLanService(
  service: { name?: string; port?: number; addresses?: string[]; txt?: unknown },
  selfDev: string,
  now = Date.now(),
): LanPeer | null {
  const txt = txtOf(service.txt);
  if (txt.v !== "2") return null; // v1 只有 v:"1"（无 dev/pk，无法构成连接语义）——不列
  const dev = typeof txt.dev === "string" ? txt.dev : "";
  const pk = typeof txt.pk === "string" ? txt.pk : "";
  const nm = typeof txt.nm === "string" ? txt.nm.slice(0, 40) : "";
  const port = Number(service.port) || 0;
  const ip = ipv4Of(service.addresses);
  if (!dev || !pk || !port || !ip) return null;
  if (!/^rl-[0-9a-f]{4,64}$/.test(dev)) return null;
  if (devId(pk, "rl") !== dev) return null; // 自洽：dev 必须是 pk 派生值
  if (dev === selfDev) return null; // 自见过滤（同进程 publish+browse 会看到自己）
  return { dev, name: nm || String(service.name ?? "").slice(0, 40) || dev, pk, ip, port, ts: now };
}

// ---------- 请求帧：seal/open（纯函数，测试直测） ----------

export interface LanConnectWire {
  op: "request" | "status";
  from: string; // 发起端 rl- dev（明文路由键）
  spk: string; // 发起端公钥 b64（自报；devId(spk,"rl")===from 由受理方校验）
  box: SealedBox; // seal({op, ts, name}, 对端公钥, 发起端私钥)
}

export interface LanConnectInner {
  op: "request" | "status";
  ts: number;
  name: string;
}

/** 受理端开帧校验：形状→dev 自洽→unseal→ts 窗口。全过=持钥证明成立。
 *  失败码：shape / self-consistency / unseal / replay。 */
export function openLanConnect(
  wire: unknown,
  myKeypair: BoxKeyPair,
  now = Date.now(),
): { ok: true; from: string; inner: LanConnectInner } | { ok: false; code: "shape" | "self" | "unseal" | "replay" } {
  const w = wire as Partial<LanConnectWire>;
  if (!w || (w.op !== "request" && w.op !== "status") || typeof w.from !== "string" || typeof w.spk !== "string"
    || !w.box || typeof w.box !== "object") return { ok: false, code: "shape" };
  if (!/^rl-[0-9a-f]{4,64}$/.test(w.from)) return { ok: false, code: "shape" };
  if (devId(w.spk, "rl") !== w.from) return { ok: false, code: "self" }; // 冒名：from ≠ spk 派生值
  // 坏 base64/坏 nonce 长度会让 nacl 抛（unseal 不接）——外来帧常态攻击面，必须吞成 unseal 失败
  let inner: LanConnectInner | null = null;
  try { inner = unseal<LanConnectInner>(w.box as SealedBox, w.spk, myKeypair.secretKey); } catch { inner = null; }
  if (!inner || (inner.op !== "request" && inner.op !== "status") || typeof inner.ts !== "number") return { ok: false, code: "unseal" };
  if (Math.abs(now - inner.ts) > LAN_CONNECT_TS_WINDOW_MS) return { ok: false, code: "replay" };
  return { ok: true, from: w.from, inner: { op: inner.op, ts: inner.ts, name: String(inner.name ?? "").slice(0, 40) } };
}

// ---------- 受理状态机（纯函数；写动作由调用方执行——测试不碰库也能跑决策面） ----------

export type LanAdmit =
  | { action: "card"; status: "pending" } // 首次：建 pending 行+出确认卡（调用方执行）
  | { action: "noop"; status: "pending" | "confirmed" | "none" } // 幂等：卡已在悬/已同意/只读查无行
  | { action: "silent"; status: "rejected" } // 忽略清单/已吊销：静默拒（不弹卡）
  | { action: "cooldown"; status: LanConnStatus } // 冷却中：静默回缓存态（防骚扰弹卡）
  | { action: "deny"; code: "mismatch" | "unavailable" }; // 换钥冒名 / 存储不可用（fail-closed）

export interface LanAdmitView {
  verdict: ReturnType<typeof trustVerdict>; // trustVerdict(port, from, spk)
  barred: ReturnType<typeof adminVerdict>; // adminVerdict(port, from)
  pendingCard: boolean; // listPendingConfirms 有本 dev 的 lan-connect 卡
  cooldownUntil: number | null; // 内存冷却表
  lastStatus: LanConnStatus; // 冷却回显用缓存态
}

/** 受理决策（对端面）。前置：openLanConnect 已过（持钥证明成立）。
 *  status op 恒只读（不出卡不写库不受冷却）；request op 走冷却+信任裁决。 */
export function admitLanConnect(view: LanAdmitView, op: "request" | "status", now: number): LanAdmit {
  if (view.verdict.state === "unavailable") return { action: "deny", code: "unavailable" };
  // 拒绝记忆在信任裁决之前（ignored 恒静默拒—— revoked 的行也走静默：吊销=拒绝态）
  if (view.barred && view.barred.barred === "ignored") return { action: "silent", status: "rejected" };
  if (op === "request" && view.cooldownUntil !== null && now < view.cooldownUntil) {
    return { action: "cooldown", status: view.lastStatus };
  }
  const v = view.verdict;
  if (v.state === "mismatch") return { action: "deny", code: "mismatch" }; // 同 dev 换 pubkey：冒名/换钥
  if (v.state === "revoked") return { action: "silent", status: "rejected" };
  if (v.state === "confirmed") return { action: "noop", status: "confirmed" };
  if (v.state === "pending") {
    // 行 pending 分两态：卡在悬=幂等不重弹；无卡=unignore 解除/决议写失败的同意流重启——重新出卡
    if (view.pendingCard) return { action: "noop", status: "pending" };
    return op === "status" ? { action: "noop", status: "pending" } : { action: "card", status: "pending" };
  }
  // none：首请
  if (op === "status") return { action: "noop", status: "none" }; // 只读查询不落半态
  if (view.pendingCard) return { action: "noop", status: "pending" }; // 卡已在悬（upsert 与卡间竞态窗）
  return { action: "card", status: "pending" };
}

// ---------- 决议副作用（applyConfirmEffects case "lan-connect" 调） ----------

/** 确认卡决议落效：✓=confirmDevice（传输层准入记账——pending→confirmed，身份面
 *  不动：不加 identity.peers，rk 信任仍走配对码/账号链）；✗=拒绝记忆双写
 *  （setIgnored 忽略清单+revokeDevice 吊销——再请求静默拒，解除走批C2 unignore）。
 *  写返检（批C1 fix2 口径）：setIgnored 失败即报错不回执成功（半写态可重试幂等收敛）。 */
export function applyLanConnectDecision(dataDir: string, dev: string, approved: boolean, by: string): { ok: boolean; error?: string } {
  const port = trustStore(dataDir);
  if (port === null) return { ok: false, error: "互信表不可用（fail-closed）" };
  if (approved) {
    const r = confirmDevice(port, dev, by);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  if (!setIgnored(port, dev, "LAN 连接请求被拒绝")) return { ok: false, error: "忽略清单写入失败——拒绝记忆未生效，请重试" };
  const rv = revokeDevice(port, dev, "LAN 连接请求被拒绝");
  if (!rv.ok) return { ok: false, error: `忽略已落库但吊销未落库（${rv.error ?? "存储写失败"}）——半写态，静默拒已生效；重试可幂等收敛` };
  return { ok: true };
}

// ---------- Hub（运行时聚合：发现缓存+发起端 HTTP+受理端入口） ----------

export interface LanPeersHubOpts {
  selfDev: () => string; // cloudIdentity?.relayDev ?? ""（闭包——identity 后台段构造）
  selfName: () => string; // relay-name/主机名（TXT nm 源）
  keypair: () => BoxKeyPair | null; // 同上闭包
  dataDir: string;
  bonjour?: BonjourCtor; // 测试注入 mock
  fetchImpl?: typeof fetch; // 测试注入
  now?: () => number;
}

/** 出卡（ws-server 受理端调）：标题带名字+指纹尾 4 位（名字不可信，指纹辅助核对）。 */
export function lanConnectConfirmCard(peer: { dev: string; name: string }, spk: string): void {
  const fp = peer.dev.replace(/^rl-/, "").slice(-4);
  addConfirm({
    kind: "lan-connect",
    title: `${peer.name || "一台电脑"} 请求连接`,
    reason: `局域网设备请求连接（指纹尾 4 位 ${fp}）——同意仅开放传输层准入，数据信任仍走配对码/账号；核对名字可能被伪造，公钥指纹才是身份`,
    payload: { dev: peer.dev, pubkey: spk, name: peer.name, fp },
  });
}

export class LanPeersHub {
  private peers = new Map<string, LanPeer>(); // dev → 最新发现（up/down 维护）
  private states = new Map<string, { status: LanConnStatus; ts: number }>(); // 发起端视角状态缓存
  private cooldowns = new Map<string, number>(); // 受理端短冷却（dev → until）
  private lastAdmit = new Map<string, LanConnStatus>(); // 冷却回显缓存态
  private mdnsOk = false;
  private browser: { stop: () => void } | null = null;
  private pollTimers = new Map<string, NodeJS.Timeout[]>();
  private lastPollAt = new Map<string, number>();
  private readonly opts: LanPeersHubOpts;

  constructor(opts: LanPeersHubOpts) {
    this.opts = opts;
  }

  /** 发现生命周期（index.ts 装配；CCR_NO_MDNS=1 时不启——与 publish 同门）。 */
  start(): void {
    if (this.browser) return;
    const byName = new Map<string, string>(); // service name → dev（down 事件只有 name）
    const b = browseLanPeers(
      (service) => {
        const peer = parseLanService(service, this.opts.selfDev(), this.opts.now?.() ?? Date.now());
        if (peer) {
          this.peers.set(peer.dev, peer);
          if (service.name) byName.set(service.name, peer.dev);
        }
      },
      (name) => {
        const dev = byName.get(name);
        if (dev) {
          this.peers.delete(dev);
          byName.delete(name);
        }
      },
      () => { this.mdnsOk = false; },
      this.opts.bonjour,
    );
    this.mdnsOk = b.ok;
    this.browser = b;
  }

  stop(): void {
    this.browser?.stop();
    this.browser = null;
    for (const ts of this.pollTimers.values()) for (const t of ts) clearTimeout(t);
    this.pollTimers.clear();
  }

  get mdnsAvailable(): boolean {
    return this.mdnsOk;
  }

  /** publish TXT（index.ts advertiseRelay 调用点消费——v2 帧）。 */
  txt(): Record<string, string> | null {
    const dev = this.opts.selfDev();
    const kp = this.opts.keypair();
    if (!dev || !kp) return null;
    return { dev, nm: this.opts.selfName().slice(0, 40), pk: kp.publicKey };
  }

  /** /api/lan-peers 响应体（web 源列表消费）。conn=发起端状态缓存 ⊕ 受理端 trust 账本
   *  （device_trust 是传输层准入账本，双向语义：对端先请求、本机已同意的邻居，本机
   *  列表同样显示「已同意」——不必本机再发起一次才知道）。 */
  snapshot(): { mdns: boolean; peers: Array<LanPeer & { conn: LanConnStatus }>; self: string } {
    const tport = trustStore(this.opts.dataDir);
    const connOf = (dev: string): LanConnStatus => {
      const s = this.states.get(dev)?.status;
      if (s && s !== "none") return s; // 本机发起侧最新态优先（含对端实时回执）
      const row = getDeviceTrust(tport, dev);
      if (!row) return "none";
      if (row.revoked_at !== null) return "rejected";
      if (row.confirmed_at !== null) return "confirmed";
      return "pending"; // 对端请求在悬（本机确认卡待决）
    };
    const peers = [...this.peers.values()]
      .map((p) => ({ ...p, conn: connOf(p.dev) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { mdns: this.mdnsOk, peers, self: this.opts.selfDev() };
  }

  /** 发起端：向对端发 request/status（HTTP 出站；结果更新 states 缓存）。 */
  async sendConnect(dev: string, op: "request" | "status"): Promise<{ ok: true; status: LanConnStatus } | { ok: false; error: string }> {
    const peer = this.peers.get(dev);
    const kp = this.opts.keypair();
    if (!peer) return { ok: false, error: "邻居不在发现缓存（可能刚下线）——稍后刷新重试" };
    if (!kp) return { ok: false, error: "本机身份不可用（cloud-keypair 未就绪）" };
    const now = this.opts.now?.() ?? Date.now();
    const inner: LanConnectInner = { op, ts: now, name: this.opts.selfName().slice(0, 40) };
    const wire: LanConnectWire = { op, from: this.opts.selfDev(), spk: kp.publicKey, box: seal(inner, peer.pk, kp.secretKey) };
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const r = await doFetch(`http://${peer.ip}:${peer.port}/api/lan-connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wire),
        signal: AbortSignal.timeout(4_000),
      });
      if (!r.ok) return { ok: false, error: `对方 relay 响应 ${r.status}` };
      const d = (await r.json()) as { status?: unknown };
      const status = d.status === "pending" || d.status === "confirmed" || d.status === "rejected" ? d.status : "none";
      this.states.set(dev, { status, ts: now });
      if (status === "pending" && op === "request") this.schedulePoll(dev); // 待决期间自动刷（5s×3）
      return { ok: true, status };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 待决状态自动轮询（unref，最多 3 次×5s——对方点同意后 15s 内发起端可见）。 */
  private schedulePoll(dev: string): void {
    const old = this.pollTimers.get(dev);
    if (old) for (const t of old) clearTimeout(t);
    const timers: NodeJS.Timeout[] = [];
    for (let i = 1; i <= 3; i++) {
      const t = setTimeout(() => {
        void this.sendConnect(dev, "status").then((r) => {
          if (r.ok && r.status !== "pending") {
            const ts = this.pollTimers.get(dev);
            if (ts) for (const x of ts) clearTimeout(x);
            this.pollTimers.delete(dev);
          }
        });
      }, i * 5_000);
      t.unref?.();
      timers.push(t);
    }
    this.pollTimers.set(dev, timers);
  }

  /** snapshot 时对 pending 且 >10s 未刷的邻居异步补一拍（节流；错误静默）。 */
  refreshPendingAsync(): void {
    const now = this.opts.now?.() ?? Date.now();
    for (const [dev, s] of this.states) {
      if (s.status !== "pending") continue;
      const last = this.lastPollAt.get(dev) ?? 0;
      if (now - last < 10_000) continue;
      this.lastPollAt.set(dev, now);
      void this.sendConnect(dev, "status").catch(() => undefined);
    }
  }

  /** 受理端入口（ws-server /api/lan-connect POST 调——外来帧，op 谓词已由 open 校验）。
   *  返回 {http, body}：http 非 200 时 body.error 人话。 */
  handleIncoming(wire: unknown): { http: number; body: Record<string, unknown> } {
    const kp = this.opts.keypair();
    if (!kp) return { http: 503, body: { ok: false, error: "身份不可用" } };
    const now = this.opts.now?.() ?? Date.now();
    const opened = openLanConnect(wire, kp, now);
    if (!opened.ok) {
      // 帧校验失败一律 4xx 且不回状态（防探测；shape/self 面向伪造者无信息可给）
      const http = opened.code === "replay" ? 403 : 400;
      return { http, body: { ok: false, error: `bad frame (${opened.code})` } };
    }
    const port = trustStore(this.opts.dataDir);
    const view: LanAdmitView = {
      verdict: trustVerdict(port, opened.from, (wire as LanConnectWire).spk),
      barred: adminVerdict(port, opened.from, now),
      pendingCard: listPendingConfirms().some((c) => c.kind === "lan-connect" && c.payload?.dev === opened.from),
      cooldownUntil: this.cooldowns.get(opened.from) ?? null,
      lastStatus: this.lastAdmit.get(opened.from) ?? "pending",
    };
    const admit = admitLanConnect(view, opened.inner.op, now);
    switch (admit.action) {
      case "deny":
        if (admit.code === "unavailable") return { http: 503, body: { ok: false, error: "互信表不可用（fail-closed）" } };
        return { http: 403, body: { ok: false, error: "pubkey mismatch" } }; // 换钥冒名：不回状态
      case "silent":
        // 拒绝记忆本身幂等静默（verdict 表查即挡），不刷冷却——冷却专防「卡在悬的重复
        // 弹卡」，别把 unignore 解除后的同意流重启也挡进 60s 窗
        this.lastAdmit.set(opened.from, "rejected");
        return { http: 200, body: { ok: true, status: "rejected" } }; // 静默拒：不弹卡，发起端显示「对方已拒绝」
      case "cooldown":
        return { http: 200, body: { ok: true, status: admit.status } };
      case "noop":
        this.lastAdmit.set(opened.from, admit.status);
        if (opened.inner.op === "request") this.cooldowns.set(opened.from, now + LAN_CONNECT_COOLDOWN_MS);
        return { http: 200, body: { ok: true, status: admit.status } };
      case "card": {
        if (port === null) return { http: 503, body: { ok: false, error: "互信表不可用（fail-closed）" } };
        const up = upsertFirstSeen(port, opened.from, (wire as LanConnectWire).spk, null);
        if (up === "unavailable") return { http: 503, body: { ok: false, error: "互信表不可用（fail-closed）" } };
        if (up === "mismatch") return { http: 403, body: { ok: false, error: "pubkey mismatch" } };
        if (up === "exists" && listPendingConfirms().some((c) => c.kind === "lan-connect" && c.payload?.dev === opened.from)) {
          // 竞态窗（admit 判定与 upsert 之间对端并发二帧）：卡真在悬才幂等回 pending
          this.lastAdmit.set(opened.from, "pending");
          this.cooldowns.set(opened.from, now + LAN_CONNECT_COOLDOWN_MS);
          return { http: 200, body: { ok: true, status: "pending" } };
        }
        // 名字取帧内自报（不可信展示层——卡面已注明）；dev 即指纹键
        lanConnectConfirmCard({ dev: opened.from, name: opened.inner.name }, (wire as LanConnectWire).spk);
        this.lastAdmit.set(opened.from, "pending");
        this.cooldowns.set(opened.from, now + LAN_CONNECT_COOLDOWN_MS);
        return { http: 200, body: { ok: true, status: "pending" } };
      }
    }
  }
}
