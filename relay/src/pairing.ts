// 云桥配对码：无法走 LAN 信道的远端设备（公司电脑网页端）的一次性信任锚。
// 管理员经 POST /api/pair-issue（bridge token 鉴权）领码，设备在云通道 pair_req 帧
// 里携带公钥+码，relay 校验通过即 addPeer。码一次性；手机端倒计时读 expires_in，
// TTL 调整客户端自动跟随（无需发版）。
// 2026-09-09 安全加固（docs-internal/配对信任安全设计.md P0-B）：
//   ① 6→8 位数字（10^8 ≈ 2^26.6，在线穷举成本×100，number-pad 体验不变）+ CSPRNG
//     （crypto.randomInt 替换 Math.random，F1）
//   ② 默认 TTL 回 5 分钟（原 20min）；CCR_PAIR_TTL_MS 环境变量可配默认值；
//     按次 ?ttl 上限 30 分钟（F3）——长码场景走按次签发，不绑架默认值
//   ③ 指定码接受 6-8 位（管理员过渡期 6 位自定义码仍可用），弱码回退随机码
import { randomInt } from "node:crypto";

export interface PairingCodes {
  issue(opts?: { code?: string; ttlMs?: number }): { code: string; expires_in: number };
  consume(code: string): boolean;
}

const TTL_FLOOR_MS = 60_000;       // 下限：再短会把正确码也判死（2026-09-07「配对码无效」根因）
const TTL_CEIL_MS = 30 * 60_000;   // 上限（F3）：任何码存活不超过 30 分钟

function clampTtl(ms: number): number {
  return Math.min(Math.max(Math.round(ms), TTL_FLOOR_MS), TTL_CEIL_MS);
}

// 环境变量可配默认 TTL（自建/特殊用户自救口）；同样吃 60s~30min 夹逼，
// 维持「任何码存活 ≤30 分钟」的单一不变量
function defaultTtlFromEnv(): number {
  const raw = Number(process.env.CCR_PAIR_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? clampTtl(raw) : 5 * 60_000;
}

// 弱码（口述场景人类最爱，也是爆破字典第一页）：全同位 / 升降顺子
function isWeakCode(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  return "0123456789".includes(code) || "9876543210".includes(code);
}

export function createPairingCodes(ttlMs?: number): PairingCodes {
  const baseTtl = ttlMs ?? defaultTtlFromEnv();
  const codes = new Map<string, { expires: number }>();
  return {
    issue(o = {}) {
      const now = Date.now();
      const eff = o.ttlMs && o.ttlMs > 0 ? clampTtl(o.ttlMs) : baseTtl;
      for (const [c, v] of codes) if (v.expires < now) codes.delete(c);
      // 指定码（6-8 位数字）：重发同码=刷新有效期；与随机码共用一次性消费语义。
      // 格式非法或弱码 → 回退 CSPRNG 随机码（返回值即所见，签出的永远是强码）
      if (o.code && /^\d{6,8}$/.test(o.code) && !isWeakCode(o.code)) {
        codes.set(o.code, { expires: now + eff });
        return { code: o.code, expires_in: Math.floor(eff / 1000) };
      }
      let code = "";
      do {
        code = String(randomInt(10000000, 100000000)); // CSPRNG：[10^7, 10^8) 恰 8 位
      } while (codes.has(code));
      codes.set(code, { expires: now + eff });
      return { code, expires_in: Math.floor(eff / 1000) };
    },
    consume(code: string) {
      const v = codes.get(code);
      if (!v) return false;
      codes.delete(code);
      return v.expires >= Date.now();
    },
  };
}
