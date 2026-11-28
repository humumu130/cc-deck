// ---------- P0-3/T1（DEV-43）：桥直推告警帧——双形态共享单源 ----------
// 云桥 HTTP 注入口：relay/壳全死时，本机哨兵（patrol-standalone）与 relay 侧
// wakeup 外发仍能把一条告警送到手机——帧经桥直投，不经 relay 路由（relay 死了
// 正是最该叫人的时候，这是「独立告警通道」的定义，产品审视 P0-3）。
//
// 信任模型：与 /wan 手表透传同款——桥可信（自家部署），明文帧只承载告警文本，
// 无任何密钥/控制语义；接收端（手机 App）只做展示，不执行。
// 防滥用：① 鉴权=桥 token（公共桥即公开 token，公开面承认）；② 定向投递 to
// 必填——dev id 是公钥/随机派生的 16 hex，不知 dev 无法盲投（广播=垃圾面，禁）；
// ③ 独立限流（每 IP 突发 5、10s 回 1）——真事故 handful 条足够，超限 429。
// Node 形态（src/index.ts）与 CF 形态（../cloudflare/src/worker.ts）共用本文件。

/** 校验+归一 POST /alert 载荷。非法返回 null（端点回 400）。 */
export function parseAlertPayload(raw: unknown): { to: string; title: string; body: string; level: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const to = typeof o.to === "string" ? o.to.trim() : "";
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const body = typeof o.body === "string" ? o.body.trim() : "";
  const level = typeof o.level === "string" && o.level.trim() ? o.level.trim() : "warn";
  // dev 口径与桥注册一致（1..64）；title/body 空串=误用，超长截断（推送显示面本就短）
  if (to.length < 1 || to.length > 64) return null;
  if (!title || !body) return null;
  return {
    to,
    title: title.slice(0, 120),
    body: body.slice(0, 500),
    level: level.slice(0, 16),
  };
}

/** 构造下发给目标设备的明文帧（手机端 store.ts 云帧环按 type 识别）。 */
export function buildAlertFrame(p: { to: string; title: string; body: string; level: string }): string {
  return JSON.stringify({ type: "bridge_alert", title: p.title, body: p.body, level: p.level, ts: Date.now() });
}

// ---------- 限流（独立于帧通道的 alert 专用桶；两形态各自持有实例） ----------

export interface AlertLimiter {
  /** 消耗 1 令牌通过=true；超限 false（调用方回 429） */
  ok(key: string): boolean;
}

/** 突发 burst、每 intervalMs 回 1 令牌。窗口实现：令牌桶（内存态，重启清零可接受——
 * 公共桥限流是防滥用兜底不是精确配额）。 */
export function createAlertLimiter(burst: number, intervalMs: number, now: () => number = Date.now): AlertLimiter {
  const buckets = new Map<string, { tokens: number; last: number }>();
  return {
    ok(key: string): boolean {
      const t = now();
      const b = buckets.get(key);
      if (!b) {
        if (buckets.size > 10_000) buckets.clear(); // 防 key 洪水撑爆内存
        buckets.set(key, { tokens: burst - 1, last: t });
        return true;
      }
      const refill = Math.floor((t - b.last) / intervalMs);
      b.tokens = Math.min(burst, b.tokens + refill);
      b.last = refill > 0 ? t : b.last;
      if (b.tokens <= 0) return false;
      b.tokens -= 1;
      return true;
    },
  };
}
