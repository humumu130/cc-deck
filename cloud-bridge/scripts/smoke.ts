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
