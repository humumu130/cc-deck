// W-ACCOUNT 件一（1116 用户令：同账号自动互联）：Worker 账号层。
// 注册/登录（账密 PBKDF2）+ account_token 签发 + 桥升级口 acct 验证口。
// 安全口径（两路文档审查定稿 brief-account v2）：
//  - PBKDF2 iterations=100000 **钉死**：workerd 生产硬顶（>100k 直接抛
//    "iteration counts above 100000 are not supported"，issue cloudflare/workerd#1346；
//    wrangler dev/Node 不 enforce=本地绿不代线上绿）。增强走 pepper 不走加迭代。
//  - 两口前置 per-IP 内存限流（authHits，postHits 同款）——每未鉴权 login 白烧
//    一次 PBKDF2 CPU（Free 档 10ms 时额）=经济型 DoS 面，deriveBits 之前拦。
//  - 错锁=内存尽力而为闸（tenant.ts loginAttempts 先例——KV 计数器有竞态+烧写
//    配额，不落 KV，P2 备案）。
//  - KV 键存 sha256(token) 不存明文（明文 token 在 KV=桥运营者持即配对权柄）。
//  - acct:/acctok: 含冒号——/view/ 与 /dl/ 的键名白名单天然拒（公网读路不可达）。
export interface AuthDeps {
  DL?: KVNamespace; // 账号 KV 与 DL 同 namespace（键前缀 acct:/acctok: 隔离，含冒号在公开读路白名单外）
}

const ITER = 100_000; // workerd 硬顶，钉死（见文件头）
const TOKEN_TTL_MS = 90 * 24 * 3600_000;
const TOKEN_RENEW_MS = 30 * 24 * 3600_000;
const authHits = new Map<string, number[]>();
const loginFails = new Map<string, { n: number; until: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (authHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 5) return true; // PBKDF2 前置：5 次/分钟/IP
  arr.push(now);
  authHits.set(ip, arr);
  if (authHits.size > 1000) for (const [k, v] of authHits) if (v.every((t) => now - t >= 60_000)) authHits.delete(k);
  return false;
}
function failLocked(user: string): boolean {
  const f = loginFails.get(user);
  return !!f && f.until > Date.now();
}
function noteFail(user: string) {
  const f = loginFails.get(user) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60_000; f.n = 0; } // 尽力而为闸（isolate 生命周期内）
  loginFails.set(user, f);
  if (loginFails.size > 2000) for (const [k, v] of loginFails) if (v.until < Date.now() && v.n === 0) loginFails.delete(k);
}
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function derive(user: string, pass: string, saltRaw: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass + "|" + user), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltRaw as BufferSource, iterations: ITER }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(nBytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(nBytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const USER_RE = /^[\w.-]{3,24}$/;

/** /auth/register|login 两口（POST JSON）。 */
export async function handleAuth(req: Request, env: AuthDeps): Promise<Response> {
  if (!env.DL) return new Response("auth disabled", { status: 501 });
  const ip = req.headers.get("CF-Connecting-IP") ?? "?";
  if (rateLimited(ip)) return new Response("rate limited", { status: 429 });
  const isReg = new URL(req.url).pathname === "/auth/register";
  let user = "", pass = "";
  const raw = await req.text(); // 审查修（P2-5）：先读后帽——大 body×多 IP 压 isolate 内存（/view/ POST 65536→413 先例）
  if (raw.length > 4096) return new Response("too large", { status: 413 });
  try { const b = JSON.parse(raw) as { user?: unknown; pass?: unknown }; user = String(b.user ?? ""); pass = String(b.pass ?? ""); } catch { return new Response("bad json", { status: 400 }); }
  if (!USER_RE.test(user) || pass.length < 8) return new Response("bad credentials format", { status: 400 });
  if (!isReg && failLocked(user)) return new Response("too many attempts", { status: 429 });
  const id = (await sha256Hex(user)).slice(0, 16);
  const acctKey = "acct:" + id;
  if (isReg) {
    const prev = await env.DL.get(acctKey);
    if (prev) return new Response("already registered", { status: 409 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(user, pass, salt);
    await env.DL.put(acctKey, JSON.stringify({ salt: [...salt], hash }), { expirationTtl: 10 * 365 * 24 * 3600 });
    return Response.json({ ok: true });
  }
  const rec = await env.DL.get<{ salt: number[]; hash: string }>(acctKey, "json");
  const salt = new Uint8Array(rec?.salt ?? crypto.getRandomValues(new Uint8Array(16))); // 无账号也给假盐跑同长计算（防账号枚举时序）
  const hash = await derive(user, pass, salt);
  if (!rec || hash !== rec.hash) { noteFail(user); return new Response("user or password wrong", { status: 401 }); }
  loginFails.delete(user);
  const token = randomHex(32);
  const tokKey = "acctok:" + (await sha256Hex(token));
  // 审查修（P3 注释失实）：原「续期窗内复用」分支读的是新随机 token 的键恒 miss=死代码——
  // 删。每次登录落新键（旧键 KV TTL 自清）；低频写由 verifyAccountToken 滑动续期承担
  const exp = Date.now() + TOKEN_TTL_MS;
  await env.DL.put(tokKey, JSON.stringify({ account: id, exp }), { expirationTtl: Math.ceil((exp - Date.now()) / 1000) });
  return Response.json({ account_token: token });
}

/** 桥升级口 acct 验证：返回 account_id；无效/过期=throw（调用方 401 硬拒——不静默忽略）。 */
export async function verifyAccountToken(token: string, env: AuthDeps): Promise<string> {
  if (!env.DL) throw new Error("auth disabled");
  const rec = await env.DL.get<{ account: string; exp: number }>("acctok:" + (await sha256Hex(token)), "json");
  if (!rec || rec.exp < Date.now()) throw new Error("invalid account token");
  if (rec.exp - Date.now() < TOKEN_RENEW_MS) { // 滑动续期（低频写）
    await env.DL.put("acctok:" + (await sha256Hex(token)), JSON.stringify({ account: rec.account, exp: Date.now() + TOKEN_TTL_MS }), { expirationTtl: Math.ceil(TOKEN_TTL_MS / 1000) });
  }
  return rec.account;
}
