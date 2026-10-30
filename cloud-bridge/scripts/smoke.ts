// 桥冒烟测试（协议层）：对任意形态的云桥（Node / Cloudflare wrangler dev）
// 跑同一组协议断言：鉴权失败、双设备密文帧互通、离线 ROUTE_MISS、同 dev 顶替。
import { WebSocket } from "ws";

export type Assert = (cond: unknown, msg: string) => void;

interface TestClient {
  ws: WebSocket;
  frames: unknown[];
  closed: boolean;
  open: Promise<boolean>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 5000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(every);
  }
  return fn();
}

export async function bridgeSmoke(base: string, token: string, assert: Assert): Promise<void> {
  // #29（B-P0-1）：桥侧 rl- 注册强制 dev = rl-<公钥前 8 字节 hex>（与 relay devId
  // 同口径）。冒烟用的 relay 身份须为真实派生形态——非派生 dev/rk 会被 upgrade 层
  // 拒绝（下文有专项断言）。固定测试向量公钥（32 字节全 0x01 / 0x02）
  const devOfRk = (rk: string): string => {
    const buf = Buffer.from(rk, "base64");
    return "rl-" + [...buf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const RK1 = Buffer.alloc(32, 1).toString("base64");
  const RK2 = Buffer.alloc(32, 2).toString("base64");
  const RELAY1 = devOfRk(RK1);
  const RELAY2 = devOfRk(RK2);

  const urlOf = (dev: string, tok: string, extra = "", path = "/cloud") => `${base}${path}?token=${tok}&dev=${dev}${extra}`;
  const connect = (dev: string, tok = token, extra = "", path = "/cloud"): TestClient => {
    const ws = new WebSocket(urlOf(dev, tok, extra, path));
    let settled = false;
    const c: TestClient = {
      ws,
      frames: [],
      closed: false,
      open: new Promise((r) => {
        const done = (v: boolean) => {
          if (!settled) {
            settled = true;
            r(v);
          }
        };
        ws.on("open", () => done(true));
        ws.on("error", () => done(false));
        // 服务器在握手前直接断开时只有 close 没有 error，别吊死
        ws.on("close", () => done(false));
      }),
    };
    ws.on("message", (d) => c.frames.push(JSON.parse(String(d))));
    ws.on("close", () => {
      c.closed = true;
    });
    ws.on("error", () => undefined);
    return c;
  };

  // 错误 token：upgrade 被拒
  const bad = connect("baddev", "wrong-token");
  assert(!(await bad.open), "错误 token 被拒");
  bad.ws.terminate();

  // #29（B-P0-1）：rl- 冒名注册三态——真 dev 名 + 假 rk / 无 rk / 非派生 dev 全拒；
  // 正确派生 rk 放行
  const fake1 = connect("rl-0011223344556677", token, `&rk=${encodeURIComponent(RK1)}`);
  assert(!(await fake1.open), "rl- dev 与 rk 派生不符被拒");
  fake1.ws.terminate();
  const fake2 = connect(RELAY1, token, "&rk=NotARealKey");
  assert(!(await fake2.open), "rl- dev 带 garbage rk 被拒");
  fake2.ws.terminate();
  const fake3 = connect(RELAY1); // 无 rk
  assert(!(await fake3.open), "rl- dev 不带 rk 被拒");
  fake3.ws.terminate();

  // #29（B-P2）：/wan 通道 to 强制 rl- 前缀
  const wanBad = connect("wt-watch", token, "&to=phone1", "/wan");
  assert(!(await wanBad.open), "/wan to 非 rl- 被拒");
  wanBad.ws.terminate();

  const relay = connect(RELAY1, token, `&rk=${encodeURIComponent(RK1)}`); // relay 连接上报公钥
  const phone = connect("phone1");
  assert((await relay.open) && (await phone.open), "双设备连接成功（rk 派生自洽放行）");

  // #29（B-P2）：/wan 正例（to=rl- 放行）+ 伪装信封不解封。注意 /wan 连接的上行
  // to 在连接时已锁定为自家 relay（帧内的 to 会被改写），故伪装信封用普通 /cloud
  // 连接发：relay 向 phone 投 {t:"wan",frame} 信封形态，phone 收到的必须是原样
  // 信封——解封仅限 /wan 注册连接，防 from 语义丢失的明文帧直投任意设备
  const watch = connect("wt-watch1", token, `&to=${RELAY1}`, "/wan");
  assert(await watch.open, "/wan to=rl- 放行（手表透传正例）");
  watch.ws.close();
  await wait(100);
  relay.ws.send(JSON.stringify({ to: "phone1", data: { t: "wan", frame: '{"injected":1}' } }));
  assert(
    await waitFor(() => phone.frames.some((f) => (f as { data?: { t?: string } }).data?.t === "wan")),
    "伪装 wan 信封到非 wan 目标原样投递（不解封）",
  );

  // relay → phone 密文帧原样转发
  const cipher = { n: "nonce-b64", c: "cipher-b64" };
  relay.ws.send(JSON.stringify({ to: "phone1", data: cipher }));
  assert(
    await waitFor(() =>
      phone.frames.some(
        (f) =>
          (f as { to?: string }).to === "phone1" &&
          (f as { from?: string }).from === RELAY1 &&
          JSON.stringify((f as { data?: unknown }).data) === JSON.stringify(cipher),
      ),
    ),
    "密文帧 relay→phone 原样转发",
  );

  // phone → 离线设备
  phone.ws.send(JSON.stringify({ to: "ghost", data: {} }));
  assert(
    await waitFor(() => phone.frames.some((f) => (f as { type?: string }).type === "ROUTE_MISS")),
    "离线目标回 ROUTE_MISS",
  );

  // 发现帧：网页（不知 relay 指纹）问桥要在线 relay 身份，回 {dev, rk}
  phone.ws.send(JSON.stringify({ to: "*", data: { t: "disc" } }));
  assert(
    await waitFor(() =>
      phone.frames.some(
        (f) =>
          (f as { type?: string }).type === "RELAYS" &&
          Array.isArray((f as { relays?: { dev: string; rk: string }[] }).relays) &&
          (f as { relays: { dev: string; rk: string }[] }).relays.some(
            (r) => r.dev === RELAY1 && r.rk === RK1,
          ),
      ),
    ),
    "发现帧回 RELAYS 带 relay 公钥",
  );

  // 配对码定位广播：wb 广播 pair_req（to:"*" + bc 标记）→ 桥转发给所有在线 rl-，
  // 非 relay 设备与发送者自身不收；disc 语义不变
  const relay2 = connect(RELAY2, token, `&rk=${encodeURIComponent(RK2)}`);
  assert((await relay2.open), "广播: 第二台 relay 连接成功");
  const bcBody = { t: "pair_req", code: "123456", pubkey: "PK1", name: "m", bc: true };
  phone.ws.send(JSON.stringify({ to: "*", data: bcBody }));
  assert(
    await waitFor(() =>
      relay.frames.some(
        (f) =>
          (f as { to?: string }).to === RELAY1 &&
          (f as { from?: string }).from === "phone1" &&
          JSON.stringify((f as { data?: unknown }).data) === JSON.stringify(bcBody),
      ) &&
      relay2.frames.some(
        (f) =>
          (f as { to?: string }).to === RELAY2 &&
          (f as { from?: string }).from === "phone1" &&
          JSON.stringify((f as { data?: unknown }).data) === JSON.stringify(bcBody),
      ),
    ),
    "广播 pair_req 转发给所有在线 relay（to/from/data 正确）",
  );
  await wait(200);
  assert(
    !phone.frames.some((f) => (f as { data?: { t?: string } }).data?.t === "pair_req") &&
      !phone.frames.some((f) => (f as { type?: string }).type === "ERROR"),
    "广播不回发给发送者、不回 ERROR",
  );
  relay2.ws.close();
  await wait(100);

  // 同 dev 顶替：旧连接被踢，新连接接管路由
  const phone2 = connect("phone1");
  assert(await phone2.open, "同 dev 新连接可建立");
  assert(await waitFor(() => phone.closed), "旧连接被顶替关闭");
  relay.ws.send(JSON.stringify({ to: "phone1", data: { n: "x", c: "y" } }));
  assert(
    await waitFor(() => phone2.frames.some((f) => (f as { from?: string })?.from === RELAY1)),
    "顶替后新连接收到路由",
  );

  relay.ws.close();
  phone2.ws.close();
  await wait(100);
}

// ---------- T1a 租户矩阵（PRD v0.3 §4.4/§4.5；Node/CF 双形态同一矩阵=同构断言） ----------
// 覆盖：M1 邀请闸四件（高熵/一码一设备/15min/限速）→M2 登录+首登=租户主→
// M3 过滤矩阵（RELAYS/pair_req/定向/relay-online，null-tenant 窗口行为）→
// M4 管理面（桥主≠租户主互不越界/踢出活线断+同钥拒重入/主权转移）→
// M5 dtok（验签/伪造拒）→M6 存量导入（peers_report→桥主 approve 收编）。
// strict 模式（截止日）为路由器单元测试面（test-cloud.ts）——wire 层不可切。
export async function tenantSmoke(base: string, token: string, adminKey: string, assert: Assert): Promise<void> {
  const devOfRk = (rk: string): string => {
    const buf = Buffer.from(rk, "base64");
    return "rl-" + [...buf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const RK_A = Buffer.alloc(32, 0x11).toString("base64");
  const RK_B = Buffer.alloc(32, 0x22).toString("base64");
  const RK_C = Buffer.alloc(32, 0x33).toString("base64");
  const RK_D = Buffer.alloc(32, 0x44).toString("base64");
  const RLA = devOfRk(RK_A), RLB = devOfRk(RK_B), RLC = devOfRk(RK_C), RLD = devOfRk(RK_D);

  const connect = (dev: string, extra = ""): TestClient => {
    const ws = new WebSocket(`${base}/cloud?token=${token}&dev=${dev}${extra}`);
    let settled = false;
    const c: TestClient = { ws, frames: [], closed: false, open: new Promise((r) => { const done = (v: boolean) => { if (!settled) { settled = true; r(v); } }; ws.on("open", () => done(true)); ws.on("error", () => done(false)); ws.on("close", () => done(false)); }) };
    ws.on("message", (d) => c.frames.push(JSON.parse(String(d))));
    ws.on("close", () => { c.closed = true; });
    ws.on("error", () => undefined);
    return c;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试谓词统一 any（frames: unknown[]）
const waitFrame = async (c: TestClient, pred: (f: any) => boolean, ms = 6000) => waitFor(() => c.frames.some((f) => pred(f)), ms);
  const typeOf = (t: string) => (f: any) => f.type === t;

  // 管理台连接（任意 dev——窗口模式 null-tenant 准入）
  const adm = connect("adm-console");
  assert(await adm.open, "管理台连接建立（null-tenant 窗口准入）");
  const op = async (o: { op: string; args?: Record<string, unknown>; admin?: string; dtok?: string }): Promise<number> => {
    const since = adm.frames.length; // 关联键：发帧前水位——回帧必在其后（同 op 名多次调用不撞旧帧）
    adm.ws.send(JSON.stringify({ to: "*", data: { t: "tenant_op", op: o.op, args: o.args ?? {}, auth: { ...(o.admin !== undefined ? { admin: o.admin } : {}), ...(o.dtok !== undefined ? { dtok: o.dtok } : {}) } } }));
    return since;
  };
  const lastOpResult = async (opName: string, since?: number): Promise<Record<string, unknown> | null> => {
    const from = since ?? 0;
    const got = await waitFor(() => adm.frames.slice(from).some((f: any) => (f.type === "tenant_op_ok" || f.type === "tenant_op_err") && f.op === opName));
    if (!got) return null;
    const list = adm.frames.slice(from).filter((f: any) => (f.type === "tenant_op_ok" || f.type === "tenant_op_err") && f.op === opName);
    return list[list.length - 1] as Record<string, unknown>;
  };

  // M0 bootstrap：桥主建两租户（随建随发首邀请）
  const w_tenant_create_1 = await op({ op: "tenant-create", args: { name: "甲租户" }, admin: "wrong-key" });
  assert((await lastOpResult("tenant-create", w_tenant_create_1))?.type === "tenant_op_err", "M0 错 ADMIN_KEY 被拒");
  const w_tenant_create_2 = await op({ op: "tenant-create", args: { name: "甲租户" }, admin: adminKey });
  const r1 = await lastOpResult("tenant-create", w_tenant_create_2);
  assert(r1?.type === "tenant_op_ok" && typeof r1.tid === "string" && typeof r1.invite === "string" && (r1.invite as string).length >= 24, "M0 tenant-create 甲（tid+高熵邀请码 ≥24 字符）");
  const T1 = r1!.tid as string, INV1 = r1!.invite as string;
  const w_tenant_create_3 = await op({ op: "tenant-create", args: { name: "乙租户" }, admin: adminKey });
  const r2 = await lastOpResult("tenant-create", w_tenant_create_3);
  assert(r2?.type === "tenant_op_ok", "M0 tenant-create 乙");
  const T2 = r2!.tid as string, INV2 = r2!.invite as string;

  // M1 邀请闸：错码（笼统）/一码一设备/限速
  const bad = connect("login-probe");
  assert(await bad.open, "M1 登录试探连接建立");
  for (let i = 0; i < 10; i++) bad.ws.send(JSON.stringify({ to: "*", data: { t: "login_req", invite: "totally-wrong-" + i, dev: "ph-bad" + i, pubkey: RK_A } }));
  assert(await waitFrame(bad, (f: any) => f.type === "login_err" && f.error === "invalid invite"), "M1 错邀请码被拒（笼统文案）");
  bad.ws.send(JSON.stringify({ to: "*", data: { t: "login_req", invite: "another-wrong", dev: "ph-bad99", pubkey: RK_A } }));
  assert(await waitFrame(bad, (f: any) => f.type === "login_err" && String(f.error).includes("too many attempts")), "M1 尝试限速触发（同源 5min 窗 10 次）");
  bad.ws.terminate();

  // M2 登录流：RLA 用 INV1 登录（首登=租户主）；同码二次登录=一码一设备拒
  const a = connect(RLA, `&rk=${encodeURIComponent(RK_A)}`);
  assert(await a.open, "M2 RLA 连接建立（未登录窗口态）");
  a.ws.send(JSON.stringify({ to: "*", data: { t: "login_req", invite: INV1, dev: RLA, pubkey: RK_A } }));
  assert(await waitFrame(a, (f: any) => f.type === "login_ok" && f.tenant === T1), "M2 RLA login_ok（甲租户）");
  const loginOkA = a.frames.filter(typeOf("login_ok")).pop() as { token: string; tenant: string; exp: number } | undefined;
  if (!loginOkA) { assert(false, "M2 RLA login_ok 缺帧（前置失败级联）"); return; }
  assert(typeof loginOkA.token === "string" && loginOkA.token.startsWith("t1."), "M2 设备 token 签发（t1. 桥签名形态）");

  const a2 = connect("login-probe2");
  assert(await a2.open, "M1b 复用码试探连接");
  a2.ws.send(JSON.stringify({ to: "*", data: { t: "login_req", invite: INV1, dev: "ph-reuse", pubkey: RK_B } }));
  assert(await waitFrame(a2, (f: any) => f.type === "login_err"), "M1 一码一设备：INV1 已耗（budget=1）复用被拒");
  a2.ws.terminate();

  // RLB：RLA（租户主）生成新邀请→登录同租户；RLC 用乙码登录乙
  const w_invite_create_1 = await op({ op: "invite-create", args: { tenant: T1 }, dtok: loginOkA.token });
  const invR = await lastOpResult("invite-create", w_invite_create_1);
  assert(invR?.type === "tenant_op_ok" && typeof invR.code === "string", "M4 租户主生成邀请（明文仅此一次）");
  const INV1B = invR!.code as string;
  const b = connect(RLB, `&rk=${encodeURIComponent(RK_B)}`);
  assert(await b.open, "M2 RLB 连接建立");
  b.ws.send(JSON.stringify({ to: "*", data: { t: "login_req", invite: INV1B, dev: RLB, pubkey: RK_B } }));
  assert(await waitFrame(b, (f: any) => f.type === "login_ok" && f.tenant === T1), "M2 RLB 凭租户主邀请入甲租户");
  const loginOkB = b.frames.filter(typeOf("login_ok")).pop() as { token: string } | undefined;
  if (!loginOkB) { assert(false, "M2 RLB login_ok 缺帧（前置失败级联）"); return; }
  const c = connect(RLC, `&rk=${encodeURIComponent(RK_C)}`);
  assert(await c.open, "M2 RLC 连接建立");
  c.ws.send(JSON.stringify({ to: "*", data: { t: "login_req", invite: INV2, dev: RLC, pubkey: RK_C } }));
  assert(await waitFrame(c, (f: any) => f.type === "login_ok" && f.tenant === T2), "M2 RLC 入乙租户（首登=乙租户主）");
  const loginOkC = c.frames.filter(typeOf("login_ok")).pop() as { token: string } | undefined;
  if (!loginOkC) { assert(false, "M2 RLC login_ok 缺帧（前置失败级联）"); return; }
  // RLD：不登录（null-tenant 迁移窗态）
  const d = connect(RLD, `&rk=${encodeURIComponent(RK_D)}`);
  assert(await d.open, "M3 RLD 连接建立（null-tenant 不登录）");
  await wait(300);

  // M3 过滤矩阵：RELAYS（disc）
  const disc = (cl: TestClient) => cl.ws.send(JSON.stringify({ to: "*", data: { t: "disc" } }));
  const relaysOf = async (cl: TestClient): Promise<string[]> => {
    const n0 = cl.frames.filter(typeOf("RELAYS")).length;
    disc(cl);
    await waitFrame(cl, (f) => (f as Record<string, unknown>).type === "RELAYS", 4000);
    await wait(150);
    const all = cl.frames.filter(typeOf("RELAYS"));
    const last = all[all.length - 1] as { relays: { dev: string }[] };
    return (last.relays ?? []).map((r) => r.dev);
  };
  const seenA = await relaysOf(a);
  assert(seenA.includes(RLB) && seenA.includes(RLD), "M3 甲设备 RELAYS 见同租户+迁移窗 null（G6 消费面）");
  assert(!seenA.includes(RLC), "M3 甲设备不见乙租户 relay（硬隔离）");
  const seenD = await relaysOf(d);
  assert(seenD.includes(RLA) && seenD.includes(RLB) && seenD.includes(RLC) && seenD.includes(RLD), "M3 null 设备见全员（现状不变——迁移连续性）");
  const seenC = await relaysOf(c);
  assert(!seenC.includes(RLA) && !seenC.includes(RLB), "M3 乙设备不见甲 relay（对称硬隔离）");

  // M3 定向路由：跨租户=笼统 ROUTE_MISS；同租户/null 互通
  a.frames.length = 0;
  a.ws.send(JSON.stringify({ to: RLC, data: { t: "probe" } }));
  assert(await waitFrame(a, (f: any) => f.type === "ROUTE_MISS" && f.to === RLC), "M3 甲→乙定向=笼统 ROUTE_MISS（在线也不可探测）");
  a.frames.length = 0;
  a.ws.send(JSON.stringify({ to: RLD, data: { t: "probe" } }));
  assert(await waitFrame(d, (f: any) => f.from === RLA && (f.data as { t?: string })?.t === "probe"), "M3 甲→null 定向互通（迁移窗）");
  a.frames.length = 0;
  d.ws.send(JSON.stringify({ to: RLA, data: { t: "probe2" } }));
  assert(await waitFrame(a, (f: any) => f.from === RLD && (f.data as { t?: string })?.t === "probe2"), "M3 null→甲定向互通（现状）");

  // M3 pair_req 广播：甲设备发的广播乙收不到
  c.frames.length = 0; d.frames.length = 0;
  b.ws.send(JSON.stringify({ to: "*", data: { t: "pair_req", bc: true, code: "x" } }));
  assert(await waitFrame(a, (f) => (f.data as { t?: string })?.t === "pair_req"), "M3 甲内广播触达同租户 RLA");
  assert(await waitFrame(d, (f) => (f.data as { t?: string })?.t === "pair_req"), "M3 甲内广播触达 null 设备（窗口）");
  await wait(300);
  assert(!c.frames.some((f) => (f as { data?: { t?: string } }).data?.t === "pair_req"), "M3 甲内广播不触达乙租户");

  // M3 relay-online：RLC 上线通知不给甲（RLC 已在线——用 RLD 重连触发验证反例：RLD 上线甲可见）
  a.frames.length = 0;
  d.ws.close();
  const d2 = connect(RLD, `&rk=${encodeURIComponent(RK_D)}`);
  assert(await d2.open, "M3 RLD 重连建立");
  assert(await waitFrame(a, (f: any) => f.type === "relay-online" && f.rd === RLD), "M3 null relay 上线通知触达甲（窗口）");
  // 反例：乙 relay 再上线，甲不应收到——用第二台乙 relay 触发
  const RK_C2 = Buffer.alloc(32, 0x55).toString("base64");
  const RLC2 = devOfRk(RK_C2);
  a.frames.length = 0;
  const c2 = connect(RLC2, `&rk=${encodeURIComponent(RK_C2)}`);
  assert(await c2.open, "M3 RLC2（乙，null-tenant 未登录）连接建立");
  await wait(400);
  assert(a.frames.some((f: any) => f.type === "relay-online" && f.rd === RLC2), "M3 null relay 上线通知照发全员（窗口矩阵：null 源通知不隔离）");
  c2.ws.terminate();

  // M4 管理面：互不越界 + 设备列表 + 主权转移 + 踢出
  const w_device_kick_1 = await op({ op: "device-kick", args: { tenant: T1, dev: RLB }, admin: adminKey });
  assert((await lastOpResult("device-kick", w_device_kick_1))?.type === "tenant_op_err", "M4 桥主不能踢设备（互不越界）");
  const w_tenant_create_4 = await op({ op: "tenant-create", args: { name: "越界" }, dtok: loginOkA.token });
  assert((await lastOpResult("tenant-create", w_tenant_create_4))?.type === "tenant_op_err", "M4 租户主不能建租户（互不越界）");
  const w_device_list_1 = await op({ op: "device-list", args: { tenant: T1 }, dtok: loginOkC.token });
  assert((await lastOpResult("device-list", w_device_list_1))?.type === "tenant_op_err", "M4 乙租户主不能列甲设备（跨租户越界）");
  const w_device_list_2 = await op({ op: "device-list", args: { tenant: T1 }, dtok: loginOkA.token });
  const dl = await lastOpResult("device-list", w_device_list_2);
  const devs = ((dl as { devices?: { dev: string; owner?: boolean }[] })?.devices) ?? [];
  assert(dl?.type === "tenant_op_ok" && devs.some((x) => x.dev === RLA && x.owner) && devs.some((x) => x.dev === RLB && !x.owner), "M4 租户主设备列表（RLA=owner 标记）");

  // 主权转移 RLA→RLB，再由 RLB 踢 RLA：活线断+同钥拒重入
  const w_owner_transfer_1 = await op({ op: "owner-transfer", args: { tenant: T1, dev: RLB }, dtok: loginOkA.token });
  assert((await lastOpResult("owner-transfer", w_owner_transfer_1))?.type === "tenant_op_ok", "M4 主权转移 RLA→RLB");
  const w_device_kick_2 = await op({ op: "device-kick", args: { tenant: T1, dev: RLA }, dtok: loginOkB.token });
  assert((await lastOpResult("device-kick", w_device_kick_2))?.type === "tenant_op_ok", "M4 新租户主踢出 RLA");
  assert(await waitFor(() => a.closed), "M4 被踢设备活线即断（B2 四缺口）");
  const aRetry = connect(RLA, `&rk=${encodeURIComponent(RK_A)}`);
  assert(!(await aRetry.open), "M4 同钥重入被拒（upgrade 401）");
  aRetry.ws.terminate();
  // dtok 伪造：tampered token 拒连
  const forged = connect("ph-forge", `&dtok=${loginOkB.token.slice(0, -3)}abc`);
  assert(!(await forged.open), "M5 伪造 dtok 拒连（验签失败）");
  forged.ws.terminate();
  // 合法 dtok 重连（RLB 带 token）：准入过
  const b2 = connect(RLB, `&rk=${encodeURIComponent(RK_B)}&dtok=${loginOkB.token}`);
  assert(await b2.open, "M5 合法 dtok 连接准入（同租户绑定）");

  // M6 存量导入：RLD（null，窗口态）上报 peers → 桥主 approve 收编入甲
  d2.ws.send(JSON.stringify({ to: "*", data: { t: "peers_report", peers: [
    { dev: "ph-old1", pubkey: "PK-old1-aaaaaaaaaaaaaaaaaaaa", name: "旧手机1" },
    { dev: "ph-old2", pubkey: "PK-old2-aaaaaaaaaaaaaaaaaaaa" },
    { dev: "bad!!dev", pubkey: "x" },
  ] } }));
  assert(await waitFrame(d2, typeOf("peers_report_ok")), "M6 peers_report 受理（pending）");
  const w_import_list_1 = await op({ op: "import-list", admin: adminKey  });
  const il = await lastOpResult("import-list", w_import_list_1);
  const imports = ((il as { imports?: { id: string; state: string; peers: unknown[] }[] })?.imports) ?? [];
  const pending = imports.find((r) => r.state === "pending");
  assert(!!pending && pending.peers.length === 2, "M6 桥主见 pending 上报（上报时即滤脏：合法 2/3）");
  const w_import_approve_1 = await op({ op: "import-approve", args: { id: pending!.id, tid: T1 }, admin: adminKey });
  assert((await lastOpResult("import-approve", w_import_approve_1))?.type === "tenant_op_ok", "M6 桥主确认收编入甲租户");
  const w_device_list_3 = await op({ op: "device-list", args: { tenant: T1 }, dtok: loginOkB.token });
  const dl2 = await lastOpResult("device-list", w_device_list_3);
  const devs2 = ((dl2 as { devices?: { dev: string; imported?: boolean }[] })?.devices) ?? [];
  assert(devs2.some((x) => x.dev === "ph-old1" && x.imported), "M6 收编设备入名册（imported 标记）");
  // 审计面：桥主桥级审计含全程归因
  const w_bridge_audit_1 = await op({ op: "bridge-audit", admin: adminKey  });
  const au = await lastOpResult("bridge-audit", w_bridge_audit_1);
  const ops = ((au as { audit?: { op: string }[] })?.audit) ?? [];
  assert(ops.some((x) => x.op === "login-ok") && ops.some((x) => x.op === "device-kick") && ops.some((x) => x.op === "import-approve"), "M7 桥级审计含登录/踢出/导入归因");

  for (const cl of [adm, b, c, d2, b2]) { try { cl.ws.close(); } catch { /* */ } }
  await wait(150);
}
