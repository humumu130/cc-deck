// 租户域纯逻辑（PRD v0.3 §4.4/§4.5，T1a）：双形态共享——CF RouterDO 与 Node 自部署桥
// 注入各自 TenantStore adapter（DO storage / 本地 JSON 文件），状态机单源。
// 无 Node 依赖：crypto 走 WebCrypto（Node 18+/workerd 双端可用）。
//
// 模型（整库 JSON，小规模全量读写）：
//   tenants { tid → {name, created_at, sealed, owner_dev} }
//   devices { dev → {pubkey, tenant, joined_at, exp, revoked_at, name, imported} }
//   invites [ {code_hash, tenant, created_at, expires_at, budget, uses} ]（明文码只在创建响应里出现一次）
//   imports [ {id, reported_by, peers, ts, state} ]（cloud-peers.json 上报→桥主确认入租户）
//   audit   [ 环形 500 条 ]（登录/管理操作全归因：设备级 actor）
//
// 过滤矩阵（§4.4 null-tenant 矩阵，迁移连续性=最高优先）：
//   租户↔租户   ：同租户可见，跨租户不可见（定向路由回笼统 ROUTE_MISS——不可探测）
//   null↔null   ：互通（现状语义不动）
//   租户↔null   ：窗口模式（默认）互通——未迁移设备与已登录设备零功能差异；
//                 strict 模式（截止日后 T1b 启用）互不可见
//   revoked     ：register 拒绝（同钥拒重入）+ 活线即断 + dtok 验签失败
// 注意：本矩阵只决定「桥面可见性/可路由性」；E2E 密封与 relay 侧信任链不在本层。

export interface TenantRecord {
  name: string;
  created_at: number;
  sealed: boolean;
  owner_dev: string | null; // 每租户首个登录设备=租户主（PRD §4.5）
}

export interface DeviceRecord {
  pubkey: string;
  tenant: string;
  joined_at: number;
  exp: number; // 设备登录态 token 过期时刻（ms）；token 续签=更新此值
  revoked_at: number | null;
  name?: string;
  imported?: boolean; // 存量导入收编（cloud-peers 上报→桥主确认）
}

export interface InviteRecord {
  code_hash: string; // SHA-256(code) hex——明文邀请码不落库
  tenant: string;
  created_at: number;
  expires_at: number;
  budget: number; // 次数预算（默认 1=一码一设备）
  uses: number;
  created_by: string;
}

export interface ImportRecord {
  id: string;
  reported_by: string; // 上报 relay 的 dev
  peers: { dev: string; pubkey: string; name?: string }[];
  ts: number;
  state: "pending" | "approved" | "rejected";
}

export interface AuditEntry {
  ts: number;
  actor: string; // dev 或 "admin"
  op: string;
  detail: string;
}

export interface TenantDb {
  v: 1;
  tenants: Record<string, TenantRecord>;
  devices: Record<string, DeviceRecord>;
  invites: InviteRecord[];
  imports: ImportRecord[];
  audit: AuditEntry[];
}

// 双形态存储 adapter：CF=DO storage（单键整库）/Node=JSON 文件（写时备份在 adapter 侧）
export interface TenantStore {
  load(): Promise<TenantDb | null>;
  save(db: TenantDb): Promise<void>;
}

export interface TenantServiceOptions {
  store: TenantStore;
  adminKey?: string; // 桥主（CF=Worker secret / Node=env 配置）；缺省=管理 API 关闭（仅登录流可用）
  strict?: () => boolean; // strict 模式（截止日后 null 隔离）；缺省恒 false（迁移窗）
  now?: () => number;
  send: (connId: string, frame: string) => void; // 管理帧回执出口（adapter 注入）
  onKick?: (dev: string) => void; // 吊销活线断出口（adapter 注入：找连接 close+unregister）
  onLogin?: (dev: string, tenant: string) => void; // 登录成功通知（router 侧无需刷新——tenantOf 恒活读）
}

export const INVITE_TTL_MS = 15 * 60 * 1000; // PRD §4.5：邀请码时效 15min
export const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_RATE_MAX = 10; // 桥侧尝试限速：同源 5min 窗 10 次（B2 P0-2）
export const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000; // 设备登录态 90 天（长命；吊销即时生效）
const AUDIT_MAX = 500;

const enc = new TextEncoder();

function emptyDb(): TenantDb {
  return { v: 1, tenants: {}, devices: {}, invites: [], imports: [], audit: [] };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(enc.encode(JSON.stringify(obj)));
}

function fromB64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 常数时间比较（WebCrypto 无 timingSafeEqual；管理键比较防时序侧信道）
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export class TenantService {
  private db: TenantDb = emptyDb();
  private loginAttempts = new Map<string, number[]>(); // source → 时间戳环（DO 休眠即清，尽力而为闸）
  readonly ready: Promise<void>;

  constructor(private opts: TenantServiceOptions) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const db = await this.opts.store.load();
      if (db && db.v === 1) this.db = db;
    } catch (e) {
      console.log(`[tenant] store load failed (start empty): ${e}`);
    }
  }

  private get now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private persist(): Promise<void> {
    return this.opts.store.save(this.db).catch((e) => {
      console.log(`[tenant] store save failed: ${e}`);
    });
  }

  private audit(actor: string, op: string, detail: string): void {
    this.db.audit.push({ ts: this.now, actor, op, detail });
    if (this.db.audit.length > AUDIT_MAX) this.db.audit.splice(0, this.db.audit.length - AUDIT_MAX);
  }

  private reply(connId: string, obj: Record<string, unknown>): void {
    try {
      this.opts.send(connId, JSON.stringify(obj));
    } catch { /* 连接已死——丢弃回执 */ }
  }

  // ---------- 过滤视图（router 六触点恒活读；内存态零 await） ----------

  tenantOf(dev: string): string | null {
    const d = this.db.devices[dev];
    if (!d || d.revoked_at !== null) return null;
    return this.tenantsAlive(d.tenant) ? d.tenant : null;
  }

  isRevoked(dev: string): boolean {
    const d = this.db.devices[dev];
    return !!d && d.revoked_at !== null;
  }

  private tenantsAlive(tid: string): boolean {
    const t = this.db.tenants[tid];
    return !!t && !t.sealed;
  }

  // §4.4 null-tenant 过滤矩阵（窗口/strict 两档；六触点统一消费）
  visible(a: string, b: string): boolean {
    const ta = this.tenantOf(a);
    const tb = this.tenantOf(b);
    if (ta && tb) return ta === tb;
    if (!ta && !tb) return true;
    const strict = this.opts.strict ? this.opts.strict() : false;
    return !strict;
  }

  // ---------- 设备登录态 token（桥签名：dev+pubkey+tenant+exp） ----------

  private hmacKey(): Uint8Array {
    // 签名密钥从 adminKey 派生（域分离）——adminKey 轮换=全体设备 token 失效（回执备案）
    const k = this.opts.adminKey ?? "";
    return enc.encode("cc-tenant-token-v1:" + k);
  }

  private async hmac(payload: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("raw", this.hmacKey() as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload) as BufferSource);
    return new Uint8Array(sig);
  }

  private async signToken(payload: { dev: string; tenant: string; exp: number; iat: number }): Promise<string> {
    const body = b64urlJson(payload);
    const sig = await this.hmac(body);
    return `t1.${body}.${b64url(sig)}`;
  }

  async verifyDeviceToken(dtok: string): Promise<{ dev: string; tenant: string; exp: number } | null> {
    const m = /^t1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(dtok);
    if (!m) return null;
    try {
      const expect = await this.hmac(m[1]);
      const got = fromB64url(m[2]);
      if (expect.length !== got.length) return null;
      let diff = 0;
      for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ got[i];
      if (diff !== 0) return null;
      const payload = JSON.parse(new TextDecoder().decode(fromB64url(m[1]))) as { dev?: unknown; tenant?: unknown; exp?: unknown };
      if (typeof payload.dev !== "string" || typeof payload.tenant !== "string" || typeof payload.exp !== "number") return null;
      if (payload.exp < this.now) return null;
      if (this.isRevoked(payload.dev)) return null; // 吊销即全租户断（验签面）
      return { dev: payload.dev, tenant: payload.tenant, exp: payload.exp };
    } catch {
      return null;
    }
  }

  // 连接准入（adapter 升级口调用）：revoked 恒拒；dtok 在场必须验过且 dev 一致
  // （ph-* 随机 dev 的防冒名层）；窗口模式 dtok 缺席=回落名册（迁移双轨）。
  async checkAdmission(dev: string, dtok: string | undefined): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.isRevoked(dev)) return { ok: false, reason: "device revoked" };
    if (dtok === undefined || dtok === "") return { ok: true };
    const v = await this.verifyDeviceToken(dtok);
    if (!v || v.dev !== dev) return { ok: false, reason: "bad device token" };
    return { ok: true };
  }

  // ---------- 邀请码（高熵/一码一设备/时效/限速——B2 P0-2 四闸） ----------

  async createInvite(tenant: string, createdBy: string, budget = 1, ttlMs = INVITE_TTL_MS): Promise<{ code: string; expires_at: number } | { error: string }> {
    const t = this.db.tenants[tenant];
    if (!t) return { error: "tenant not found" };
    if (t.sealed) return { error: "tenant sealed" };
    const code = randomToken(24); // 192bit 熵
    const expires_at = this.now + ttlMs;
    this.db.invites.push({
      code_hash: await sha256Hex(code),
      tenant,
      created_at: this.now,
      expires_at,
      budget: Math.max(1, Math.min(budget, 50)),
      uses: 0,
      created_by: createdBy,
    });
    this.audit(createdBy, "invite-create", `tenant=${tenant} budget=${budget} ttl=${Math.round(ttlMs / 60000)}min`);
    await this.persist();
    return { code, expires_at }; // 明文只此一次
  }

  private rateOk(source: string): boolean {
    const nowT = this.now;
    const win = (this.loginAttempts.get(source) ?? []).filter((t) => nowT - t < LOGIN_RATE_WINDOW_MS);
    if (win.length >= LOGIN_RATE_MAX) {
      this.loginAttempts.set(source, win);
      return false;
    }
    win.push(nowT);
    this.loginAttempts.set(source, win);
    return true;
  }

  private async consumeInvite(code: string, tenant: string): Promise<boolean> {
    const h = await sha256Hex(code);
    const nowT = this.now;
    const idx = this.db.invites.findIndex((i) => i.code_hash === h);
    if (idx < 0) return false;
    const inv = this.db.invites[idx];
    if (inv.tenant !== tenant || inv.expires_at < nowT || inv.uses >= inv.budget) return false;
    inv.uses += 1;
    return true;
  }

  // ---------- 管理帧终结（login_req / tenant_op / peers_report） ----------

  // TenantFilter 契约名（router 六触点之管理帧终结口）
  onManagementFrame(connId: string, from: string, data: { t: string } & Record<string, unknown>): Promise<void> {
    return this.onFrame(connId, from, data as Record<string, unknown>);
  }

  async onFrame(connId: string, from: string, data: Record<string, unknown>): Promise<void> {
    const t = data.t;
    if (t === "login_req") return this.onLoginReq(connId, from, data);
    if (t === "tenant_op") return this.onTenantOp(connId, from, data);
    if (t === "peers_report") return this.onPeersReport(connId, from, data);
  }

  private async onLoginReq(connId: string, from: string, data: Record<string, unknown>): Promise<void> {
    const invite = typeof data.invite === "string" ? data.invite : "";
    const pubkey = typeof data.pubkey === "string" ? data.pubkey : "";
    const dev = typeof data.dev === "string" && data.dev.length >= 1 && data.dev.length <= 64 ? data.dev : from;
    const source = `${from}`;
    if (!invite || !pubkey) {
      this.reply(connId, { type: "login_err", error: "invite and pubkey required" });
      return;
    }
    if (!this.rateOk(source)) {
      this.audit(source, "login-rate-limited", "");
      this.reply(connId, { type: "login_err", error: "too many attempts, retry later" });
      return;
    }
    await this.ready;
    // 邀请码定位租户：按 hash 反查（码不携租户名——防租户名枚举）
    const h = await sha256Hex(invite);
    const inv = this.db.invites.find((i) => i.code_hash === h);
    if (!inv || inv.expires_at < this.now || inv.uses >= inv.budget) {
      this.audit(source, "login-rejected", "bad/expired/exhausted invite");
      this.reply(connId, { type: "login_err", error: "invalid invite" }); // 笼统（不可探测具体原因）
      return;
    }
    if (!(await this.consumeInvite(invite, inv.tenant))) {
      this.reply(connId, { type: "login_err", error: "invalid invite" });
      return;
    }
    const tenant = inv.tenant;
    const exp = this.now + TOKEN_TTL_MS;
    const existing = this.db.devices[dev];
    if (existing && existing.revoked_at === null && existing.pubkey !== pubkey) {
      // 同 dev 换公钥重登=冒名面——拒绝（名册钉扎 pubkey）
      this.audit(source, "login-rejected", `dev=${dev} pubkey mismatch`);
      this.reply(connId, { type: "login_err", error: "device already registered with another key" });
      return;
    }
    this.db.devices[dev] = {
      pubkey,
      tenant,
      joined_at: existing?.joined_at ?? this.now,
      exp,
      revoked_at: null,
      name: existing?.name,
      imported: existing?.imported,
    };
    const t = this.db.tenants[tenant];
    if (t && t.owner_dev === null) {
      t.owner_dev = dev; // 每租户首个登录设备=租户主（PRD §4.5）
      this.audit(dev, "tenant-owner-bootstrap", `tenant=${tenant}`);
    }
    const token = await this.signToken({ dev, tenant, exp, iat: this.now });
    this.audit(dev, "login-ok", `tenant=${tenant}`);
    await this.persist();
    this.reply(connId, { type: "login_ok", token, tenant, exp });
    this.opts.onLogin?.(dev, tenant);
  }

  // ---------- 管理操作（桥主 ADMIN_KEY / 租户主 owner dtok——权限互不越界） ----------

  private async authAdmin(data: Record<string, unknown>): Promise<boolean> {
    const auth = data.auth as { admin?: unknown } | undefined;
    const key = this.opts.adminKey;
    return !!key && !!auth && typeof auth.admin === "string" && ctEqual(auth.admin, key);
  }

  private async authOwner(data: Record<string, unknown>, tenant: string): Promise<string | null> {
    const auth = data.auth as { dtok?: unknown } | undefined;
    if (!auth || typeof auth.dtok !== "string") return null;
    const v = await this.verifyDeviceToken(auth.dtok);
    if (!v || v.tenant !== tenant) return null;
    const t = this.db.tenants[tenant];
    if (!t || t.owner_dev !== v.dev) return null;
    return v.dev;
  }

  private async onTenantOp(connId: string, from: string, data: Record<string, unknown>): Promise<void> {
    await this.ready;
    const op = typeof data.op === "string" ? data.op : "";
    const args = (data.args ?? {}) as Record<string, unknown>;
    const fail = (error: string) => this.reply(connId, { type: "tenant_op_err", op, error });
    const done = (result: Record<string, unknown>) => this.reply(connId, { type: "tenant_op_ok", op, ...result });

    // ---- 桥主面（ADMIN_KEY）----
    if (op === "tenant-create" || op === "tenant-list" || op === "tenant-seal" || op === "import-list" || op === "import-approve" || op === "import-reject" || op === "bridge-audit") {
      if (!(await this.authAdmin(data))) return fail("admin auth required");
      if (op === "tenant-create") {
        const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 40) : "unnamed";
        const tid = "t-" + (this.now.toString(36) + randomToken(6)).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
        this.db.tenants[tid] = { name, created_at: this.now, sealed: false, owner_dev: null };
        this.audit("admin", "tenant-create", `tid=${tid} name=${name}`);
        // 首邀请随建随发（桥主转交租户主，租户主再自行邀新）
        const inv = await this.createInvite(tid, "admin");
        await this.persist();
        return done({ tid, invite: "code" in inv ? inv.code : "", expires_at: "expires_at" in inv ? inv.expires_at : 0 });
      }
      if (op === "tenant-list") {
        return done({
          tenants: Object.entries(this.db.tenants).map(([tid, t]) => ({
            tid, name: t.name, sealed: t.sealed, owner_dev: t.owner_dev,
            devices: Object.values(this.db.devices).filter((d) => d.tenant === tid && d.revoked_at === null).length,
          })),
        });
      }
      if (op === "tenant-seal") {
        const tid = String(args.tid ?? "");
        const t = this.db.tenants[tid];
        if (!t) return fail("tenant not found");
        t.sealed = true;
        this.audit("admin", "tenant-seal", `tid=${tid}`);
        await this.persist();
        return done({});
      }
      if (op === "import-list") {
        return done({ imports: this.db.imports.slice(-50) });
      }
      if (op === "import-approve" || op === "import-reject") {
        const id = String(args.id ?? "");
        const rec = this.db.imports.find((r) => r.id === id);
        if (!rec || rec.state !== "pending") return fail("import not pending");
        const tid = String(args.tid ?? "");
        if (op === "import-approve") {
          if (!this.db.tenants[tid]) return fail("tenant not found");
          let added = 0;
          let skipped = 0;
          for (const p of rec.peers) {
            if (!/^(rl-|ph-|wt-)[A-Za-z0-9_-]{1,60}$/.test(p.dev) || typeof p.pubkey !== "string" || p.pubkey.length < 16) {
              skipped++;
              continue;
            }
            if (this.db.devices[p.dev]) {
              skipped++; // 已在册不覆盖（名册权威写口=登录/导入，防重复导入互相踩）
              continue;
            }
            this.db.devices[p.dev] = { pubkey: p.pubkey, tenant: tid, joined_at: this.now, exp: 0, revoked_at: null, name: p.name, imported: true };
            added++;
          }
          rec.state = "approved";
          this.audit("admin", "import-approve", `id=${id} tenant=${tid} added=${added} skipped=${skipped}`);
        } else {
          rec.state = "rejected";
          this.audit("admin", "import-reject", `id=${id}`);
        }
        await this.persist();
        return done({});
      }
      if (op === "bridge-audit") {
        return done({ audit: this.db.audit.slice(-100) });
      }
    }

    // ---- 租户主面（owner dtok；桥主不越界代行——验收「桥主≠租户主时权限互不越界」）----
    if (op === "device-list" || op === "device-kick" || op === "invite-create" || op === "owner-transfer" || op === "tenant-audit") {
      const tenant = String(args.tenant ?? "");
      if (!this.db.tenants[tenant]) return fail("tenant not found");
      const owner = await this.authOwner(data, tenant);
      if (!owner) return fail("tenant owner auth required");
      if (op === "device-list") {
        return done({
          devices: Object.entries(this.db.devices)
            .filter(([dev, d]) => d.tenant === tenant)
            .map(([dev, d]) => ({ dev, pubkey: d.pubkey.slice(0, 8) + "…", joined_at: d.joined_at, revoked: d.revoked_at !== null, imported: !!d.imported, name: d.name, owner: this.db.tenants[tenant].owner_dev === dev })),
        });
      }
      if (op === "device-kick") {
        const dev = String(args.dev ?? "");
        const d = this.db.devices[dev];
        if (!d || d.tenant !== tenant) return fail("device not in tenant");
        if (dev === this.db.tenants[tenant].owner_dev) return fail("owner device cannot be kicked (transfer first)");
        d.revoked_at = this.now;
        this.audit(owner, "device-kick", `tenant=${tenant} dev=${dev}`);
        await this.persist();
        this.opts.onKick?.(dev); // 活线即断（B2 四缺口：踢出不停线=还能用到自然断）
        return done({});
      }
      if (op === "invite-create") {
        const budget = typeof args.budget === "number" ? args.budget : 1;
        const r = await this.createInvite(tenant, owner, budget);
        if ("error" in r) return fail(r.error);
        return done({ code: r.code, expires_at: r.expires_at });
      }
      if (op === "owner-transfer") {
        const dev = String(args.dev ?? "");
        const d = this.db.devices[dev];
        if (!d || d.tenant !== tenant || d.revoked_at !== null) return fail("device not in tenant");
        this.db.tenants[tenant].owner_dev = dev;
        this.audit(owner, "owner-transfer", `tenant=${tenant} to=${dev}`);
        await this.persist();
        return done({});
      }
      if (op === "tenant-audit") {
        return done({ audit: this.db.audit.filter((a) => a.detail.includes(tenant) || a.actor === owner).slice(-100) });
      }
    }

    return fail("unknown op");
  }

  // ---------- 存量迁移上报（G6/T1b：relay 启动上报 cloud-peers 清单→桥主确认收编） ----------

  private async onPeersReport(connId: string, from: string, data: Record<string, unknown>): Promise<void> {
    await this.ready;
    const peers = Array.isArray(data.peers) ? data.peers : [];
    // 上报时即滤脏（与 import-approve 同口径）：dev 形如 rl-/ph-/wt- 合法段+pubkey
    // ≥16 字符——pending 面只见合法清单，approve 阶段同规则再验（纵深）
    const clean = peers
      .filter((p): p is { dev: string; pubkey: string; name?: string } =>
        !!p && typeof p === "object" && typeof (p as { dev?: unknown }).dev === "string" && typeof (p as { pubkey?: unknown }).pubkey === "string")
      .map((p) => p as { dev: string; pubkey: string; name?: string })
      .filter((p) => /^(rl-|ph-|wt-)[A-Za-z0-9_-]{1,60}$/.test(p.dev) && p.pubkey.length >= 16)
      .slice(0, 500);
    // 同一 relay 重复上报：替换其 pending 记录（幂等，不堆台账）
    const prev = this.db.imports.find((r) => r.reported_by === from && r.state === "pending");
    const rec: ImportRecord = { id: "imp-" + randomToken(8), reported_by: from, peers: clean, ts: this.now, state: "pending" };
    if (prev) Object.assign(prev, rec, { id: prev.id });
    else this.db.imports.push(rec);
    if (this.db.imports.length > 200) this.db.imports.splice(0, this.db.imports.length - 200);
    this.audit(from, "peers-report", `${clean.length} peers`);
    await this.persist();
    this.reply(connId, { type: "peers_report_ok", id: prev ? prev.id : rec.id, count: clean.length });
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(s) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 内存 store（测试/纯内存形态）
export class MemoryStore implements TenantStore {
  private db: TenantDb | null = null;
  async load(): Promise<TenantDb | null> {
    return this.db;
  }
  async save(db: TenantDb): Promise<void> {
    this.db = db;
  }
}
