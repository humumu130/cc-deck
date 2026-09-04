// 云桥配对码：无法走 LAN 信道的远端设备（公司电脑网页端）的一次性信任锚。
// 管理员经 POST /api/pair-issue（bridge token 鉴权）领码，设备在云通道 pair_req 帧
// 里携带公钥+码，relay 校验通过即 addPeer。码一次性，默认 20 分钟有效——领码经
// 手机转达、用户再走到公司电脑输入，实测 10 分钟不够（防爆破靠 consume 失败限流）。
export interface PairingCodes {
  issue(): { code: string; expires_in: number };
  consume(code: string): boolean;
}

export function createPairingCodes(ttlMs = 1200 * 1000): PairingCodes {
  const codes = new Map<string, { expires: number }>();
  return {
    issue() {
      const now = Date.now();
      for (const [c, v] of codes) if (v.expires < now) codes.delete(c);
      let code = "";
      do {
        code = String(Math.floor(100000 + Math.random() * 900000));
      } while (codes.has(code));
      codes.set(code, { expires: now + ttlMs });
      return { code, expires_in: Math.floor(ttlMs / 1000) };
    },
    consume(code: string) {
      const v = codes.get(code);
      if (!v) return false;
      codes.delete(code);
      return v.expires >= Date.now();
    },
  };
}
