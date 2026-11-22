// #316 mDNS 广播：手表在同一 WiFi 下零配置发现 relay（免手输 IP）。
// 服务类型 _ccdeck._tcp；失败静默（公司网/路由器禁组播不影响其余功能，手表回落手输）
// CONNV4 批D（connv4d）：双向化——publish TXT 扩 dev/nm/pk（v2 帧：LAN 邻居发现需要
// 对端 relay 身份标识+公钥才能构造密封请求帧；v1 只有 v:"1" 被发现侧忽略）；新增
// browseLanPeers（同网发现，lan-peers.ts 消费）。组播被拦容错与 publish 同款。
import Bonjour, { type ServiceConfig } from "bonjour-service";

export interface MdnsTxtV2 {
  v: "2";
  dev: string; // rl- 设备号（公钥派生）
  nm: string; // 显示名（relay-name/主机名——不可信展示层，安全见 lan-peers.ts 头注）
  pk: string; // box 公钥 b64（发起端 seal 请求帧用；devId(pk,"rl")===dev 自洽由发现侧校验）
}

/** 可注入的 Bonjour 构造器（测试 mock；缺省真包）。 */
export type BonjourCtor = typeof Bonjour;

/** CONNV4D 返修 fix1（P1-1 测试基建）：CCR_MDNS_IP 覆盖组播组地址（缺省 224.0.0.251）。
 *  用途=真实启动序测试的隔离面——真 index 进程+真组播栈跑在私有组（组织本地范围
 *  239.192/14，RFC 2365），同网真实设备（224.0.0.251 组）不可见（#20「测试幽灵
 *  实例」纪律不破）；测试端浏览器须同组才能收到（同主机组播回环）。publish/browse
 *  同读此钮。生产不设=构造参数逐字节不变。 */
/** bonjour-service 构造参数的 socket 透传面（ip=组播组地址——d.ts 未收录，
 *  runtime 经 Server→multicast-dns(opts) 原样消费）。 */
export type BonjourSocketOpts = Partial<ServiceConfig> & { ip?: string };
const mdnsGroupOpts = (): BonjourSocketOpts | undefined => {
  const ip = (process.env.CCR_MDNS_IP ?? "").trim();
  return ip ? { ip } : undefined;
};

export function advertiseRelay(port: number, name: string, extraTxt?: Record<string, string>): { stop: () => void } {
  try {
    const bonjour = new Bonjour(mdnsGroupOpts());
    // mDNS socket 的错误是异步 emit（组播被拦/地址被占），不监听会 unhandled——
    // 广播失败只影响手表自动发现（可手输），静默吞掉
    const service = bonjour.publish({ name, type: "ccdeck", port, txt: { v: "2", ...(extraTxt ?? {}) } });
    for (const emitter of [bonjour as unknown as NodeJS.EventEmitter, service as unknown as NodeJS.EventEmitter]) {
      emitter.on?.("error", () => undefined);
    }
    return {
      stop: () => {
        try {
          service.stop();
          bonjour.destroy();
        } catch {}
      },
    };
  } catch {
    return { stop: () => {} };
  }
}

/** 同网发现 _ccdeck._tcp 服务（批D）。up/down 喂 lan-peers hub；构造/浏览失败静默降级
 *  （onDown 通知——组播被拦时发现段隐藏而非报错，验收点2）。返回 {stop, ok}：
 *  ok=false=浏览器没起来（mdns 不可用信号，hub 记 mdnsOk=false）。 */
export function browseLanPeers(
  onPeer: (service: { name: string; port: number; addresses?: string[]; txt?: unknown }) => void,
  onGone: (name: string) => void,
  onDown: () => void,
  Ctor: BonjourCtor = Bonjour,
): { stop: () => void; ok: boolean } {
  try {
    // fix1：同读 CCR_MDNS_IP 隔离钮（与 publish 同组——测试形态下发现面也不出 224.0.0.251）
    const bonjour = new Ctor(mdnsGroupOpts(), () => {
      // errorCallback：组播 socket 起不来（被拦/无网卡）——静默降级
      onDown();
    });
    const browser = bonjour.find({ type: "ccdeck" }, (service) => {
      try { onPeer(service); } catch { /* 单条坏服务不炸浏览循环 */ }
    });
    for (const emitter of [bonjour as unknown as NodeJS.EventEmitter, browser as unknown as NodeJS.EventEmitter]) {
      emitter.on?.("error", () => undefined);
    }
    browser.on?.("down", (service: { name?: string }) => {
      try { onGone(service?.name ?? ""); } catch { /* 尽力而为 */ }
    });
    browser.on?.("txt-update", (next: { name?: string }) => {
      // TXT 变更（对端改名/换版本）按新服务喂——hub 按 name 键 upsert 覆盖
      if (next && typeof next === "object" && "txt" in next) {
        try { onPeer(next as { name: string; port: number; addresses?: string[]; txt?: unknown }); } catch {}
      }
    });
    return {
      stop: () => {
        try {
          browser.stop();
          bonjour.destroy();
        } catch {}
      },
      ok: true,
    };
  } catch {
    onDown();
    return { stop: () => {}, ok: false };
  }
}
