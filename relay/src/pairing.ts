// 云桥配对码：无法走 LAN 信道的远端设备（公司电脑网页端）的一次性信任锚。
// 管理员经 POST /api/pair-issue（bridge token 鉴权）领码，设备在云通道 pair_req 帧
// 里携带公钥+码，relay 校验通过即 addPeer。码一次性，默认 5 分钟有效（2026-09-07 从
// 60s 提升：用户看到码→走到另一台设备输入普遍超 1 分钟，短窗把正确码也判死，实测
// 「配对码无效」的根因；防爆破不靠 TTL 短窗——码空间 10^6 + cloud-client 连续错码
// 限流 + 手机端自动续领足够）。手机端倒计时读 expires_in，无需改动自动跟随。
export interface PairingCodes {
  // 2026-09-09：默认 TTL 5→20 分钟（用户反馈窗口太短）；issue 支持管理员指定码值/时长
  // （POST /api/pair-code?code=xxx&ttl=ms，LAN token 鉴权）——用户要固定码场景
  issue(opts?: { code?: string; ttlMs?: number }): { code: string; expires_in: number };
  consume(code: string): boolean;
}

export function createPairingCodes(ttlMs = 20 * 60 * 1000): PairingCodes {
  const codes = new Map<string, { expires: number }>();
  return {
    issue(o = {}) {
      const now = Date.now();
      const eff = o.ttlMs && o.ttlMs >= 60_000 ? o.ttlMs : ttlMs;
      for (const [c, v] of codes) if (v.expires < now) codes.delete(c);
      // 指定码（须 6 位数字）：重发同码=刷新有效期；与随机码共用一次性消费语义
      if (o.code && /^\d{6}$/.test(o.code)) {
        codes.set(o.code, { expires: now + eff });
        return { code: o.code, expires_in: Math.floor(eff / 1000) };
      }
      let code = "";
      do {
        code = String(Math.floor(100000 + Math.random() * 900000));
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
