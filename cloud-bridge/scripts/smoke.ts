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
  const urlOf = (dev: string, tok: string) => `${base}/cloud?token=${tok}&dev=${dev}`;
  const connect = (dev: string, tok = token): TestClient => {
    const ws = new WebSocket(urlOf(dev, tok));
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

  const relay = connect("relay1");
  const phone = connect("phone1");
  assert((await relay.open) && (await phone.open), "双设备连接成功");

  // relay → phone 密文帧原样转发
  const cipher = { n: "nonce-b64", c: "cipher-b64" };
  relay.ws.send(JSON.stringify({ to: "phone1", data: cipher }));
  assert(
    await waitFor(() =>
      phone.frames.some(
        (f) =>
          (f as { to?: string }).to === "phone1" &&
          (f as { from?: string }).from === "relay1" &&
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

  // 同 dev 顶替：旧连接被踢，新连接接管路由
  const phone2 = connect("phone1");
  assert(await phone2.open, "同 dev 新连接可建立");
  assert(await waitFor(() => phone.closed), "旧连接被顶替关闭");
  relay.ws.send(JSON.stringify({ to: "phone1", data: { n: "x", c: "y" } }));
  assert(
    await waitFor(() => phone2.frames.some((f) => (f as { from?: string })?.from === "relay1")),
    "顶替后新连接收到路由",
  );

  relay.ws.close();
  phone2.ws.close();
  await wait(100);
}
