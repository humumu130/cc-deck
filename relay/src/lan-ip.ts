// 本机局域网地址探测（#25 抽纯函数）：给 /local-info、启动日志、--qr 共用，
// 并配 scripts/test-lanip.mjs 用模拟网卡清单覆盖环境敏感分支（Hyper-V vEthernet
// 宿主网、纯虚拟适配器机、VPN-only 等公司机形态——单一真机测不出的盲区）。
import * as os from "node:os";

export interface NicLike {
  family?: string;
  internal?: boolean;
  address?: string;
}

// 虚拟适配器关键词：这些网卡上的地址手机大概率不可达（host-only/隧道），优先排除
export const VIRTUAL_NIC_RE =
  /vmware|virtual|vethernet|wsl|loopback|tap|bluetooth|hyper-v|docker|tailscale|zerotier|wireguard|wintun|openvpn|vpn/i;

// RFC1918 私网 + 169.254 排除（链路本地手机也连不上）。
// 10 分支不带点（尾部统一 \.）——旧写法 10\. + \. 双点只匹配 "10.."，10.x 全灭
// （用户公司机 10.123.90.5 探测为空的真凶，2026-09-10）
const PRIV_RE = /^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./;

function pickFrom(list: NicLike[] | undefined): string {
  for (const ni of list ?? []) {
    if ((ni.family ?? "IPv4") !== "IPv4" && ni.family !== 4) continue;
    const a = ni.address ?? "";
    if (ni.internal || /^(127\.|169\.254\.)/.test(a)) continue;
    if (PRIV_RE.test(a)) return a;
  }
  return "";
}

/// 两段式：先只认物理网卡；一无所获时回退全网卡（Hyper-V/WSL2 开发机的宿主网常跑在
/// vEthernet 上——严格过滤会把唯一可用地址滤掉，用户公司机实测中招 #25）。
/// 回退仍排除 internal/回环/链路本地/非私网——地址本身可达性让手机侧连接超时兜底。
export function detectLanIp(interfaces: Record<string, NicLike[]> = os.networkInterfaces()): string {
  let ip = "";
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_NIC_RE.test(name)) continue;
    ip = pickFrom(list);
    if (ip) return ip;
  }
  for (const list of Object.values(interfaces)) {
    ip = pickFrom(list);
    if (ip) return ip;
  }
  return "";
}
