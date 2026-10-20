// W-SPLIT-S3R2c：配对域命令 mixin（session-manager 四 case 体逐字搬出，仅 this.→mgr.）。
// 搬运纪律：与执行体内逻辑零改动（含注释原样）；依赖的模块级助手（peerKind）随迁
// 导出（session-manager 原定义同步删除防双源）——命令样板为后续 S3 拆分铺路。
import { devId } from "../e2e.js";
import type { PeerMeta } from "../types.js";
import type { CommandAckPayload } from "../types.js";

// 样板参数：真身 SessionManager / Command——any 网关为跨 private 成员与 payload
// 联合类型窄化边界（原 case 内的 switch narrowing 在独立函数不可复现）。行为等价
// 由 test-dispatch + check-behavior-parity 锁死，非类型信任面

// 设备类型派生：meta 自报身份优先（CC Deck App / 移动 platform → phone，watch → watch），
// 前缀派生兜底（ph-手机 wb-网页 wt-手表）——修正云桥配对手机被一律标"网页"的失真
// （W-S3R2c 随 case 体迁出；原 session-manager :158 同体）
export function peerKind(dev: string, meta?: PeerMeta): "phone" | "web" | "watch" | "other" {
  const plat = (meta?.platform ?? "").toLowerCase();
  const app = (meta?.app ?? "").toLowerCase();
  if (app.includes("cc deck") || app.includes("ccdeck")) return "phone";
  if (/wear|watch/.test(plat)) return "watch";
  if (/android|ios/.test(plat)) return "phone";
  if (dev.startsWith("ph-")) return "phone";
  if (dev.startsWith("wt-")) return "watch";
  return "web";
}

export function createPairingCommands(mgr: any) {
  return {
    COMMAND_PAIR_START(cmd: any, _by: string): CommandAckPayload {
      // 云桥配对：信任锚 = LAN 信道的 token 鉴权（与现状同威胁模型）
      if (!mgr.cloud || !mgr.cfg.cloudUrl) {
        return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
      }
      const { pubkey } = cmd.payload;
      if (typeof pubkey !== "string" || !/^[A-Za-z0-9+/]{43}={0,2}$/.test(pubkey)) {
        return { command_id: cmd.command_id, ok: false, error: "bad pubkey" };
      }
      const dev = devId(pubkey, "ph");
      const name = cmd.payload.name || "手机";
      mgr.cloud.addPeer(dev, { pubkey, name, paired_at: Date.now() });
      // 议题①：手机扫码配对同样是新设备入册（全权）——广播提醒其余在线设备
      mgr.bus.emitTransient("PAIRED_DEVICE", { dev, name, action: "add" });
      return {
        command_id: cmd.command_id,
        ok: true,
        cloud: {
          url: mgr.cfg.cloudUrl,
          token: mgr.cfg.cloudToken,
          relay_dev: mgr.cloud.relayDev,
          relay_pubkey: mgr.cloud.keypair.publicKey,
        },
      };
    },
    COMMAND_PAIR_CODE(cmd: any, _by: string): CommandAckPayload {
      // 信任设备（已配对手机，LAN token / 云 E2E 任一信道）为网页端新设备签发一次性配对码。
      // ttl_ms 可选：按次长码（F4；签发端夹逼 60s~30min，见 pairing.ts）
      if (!mgr.cloud || !mgr.pairIssuer) {
        return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
      }
      const ttlRaw = (cmd.payload as { ttl_ms?: unknown }).ttl_ms;
      const opts =
        typeof ttlRaw === "number" && Number.isFinite(ttlRaw) && ttlRaw > 0 ? { ttlMs: ttlRaw } : undefined;
      return { command_id: cmd.command_id, ok: true, pair_code: mgr.pairIssuer(opts) };
    },
    COMMAND_PEERS(cmd: any, _by: string): CommandAckPayload {
      // 议题①可信设备清单：kind 优先采信 meta 自报身份（app/platform），前缀派生
      // 降级为兜底——云桥配对的手机此前被一律按 wb- 前缀标成"网页"（前缀语义过时，
      // 2026-09-14 用户实测设备列表标签失真）。云桥未启用时 peers 恒空，返回空清单
      // 而非报错（网页端 UI 直接显示「暂无」。#42 e.meta 随条目下发）
      const peers = mgr.cloud
        ? [...mgr.cloud.peers.entries()].map(([dev, e]) => ({
            dev,
            name: e.name || dev.slice(0, 11),
            pubkey: e.pubkey,
            kind: peerKind(dev, e.meta),
            paired_at: e.paired_at,
            last_seen: e.last_seen ?? 0,
            ...(e.meta ? { meta: e.meta } : {}),
          }))
        : [];
      return { command_id: cmd.command_id, ok: true, peers };
    },
    COMMAND_PEERS_IMPORT(cmd: any, _by: string): CommandAckPayload {
      // 导入配对备份（导出的逆操作）：按 dev 合并入库（已存在跳过），返回导入数。
      // 条目格式与 COMMAND_PEERS 下发一致（dev/pubkey 必填，name/meta/paired_at 可选）
      if (!mgr.cloud) {
        return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
      }
      const raw = (cmd.payload as { peers?: unknown }).peers;
      if (!Array.isArray(raw)) return { command_id: cmd.command_id, ok: false, error: "peers 必须是数组" };
      const entries: { dev: string; pubkey: string; name?: string; meta?: PeerMeta; paired_at?: number }[] = [];
      for (const item of raw.slice(0, 100)) {
        const it = item as { dev?: unknown; pubkey?: unknown; name?: unknown; meta?: unknown; paired_at?: unknown };
        const dev = typeof it.dev === "string" ? it.dev : "";
        const pubkey = typeof it.pubkey === "string" ? it.pubkey : "";
        if (!/^[a-z]{2}-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pubkey)) continue;
        entries.push({
          dev,
          pubkey,
          ...(typeof it.name === "string" && it.name.trim() ? { name: it.name.trim().slice(0, 32) } : {}),
          ...(it.meta && typeof it.meta === "object" ? { meta: it.meta as PeerMeta } : {}),
          ...(typeof it.paired_at === "number" ? { paired_at: it.paired_at } : {}),
        });
      }
      const imported = mgr.cloud.importPeers(entries);
      for (const e of entries) {
        if (mgr.cloud.peers.has(e.dev)) {
          mgr.bus.emitTransient("PAIRED_DEVICE", { dev: e.dev, name: mgr.cloud.peers.get(e.dev)?.name ?? "", action: "add" });
        }
      }
      return { command_id: cmd.command_id, ok: true, imported };
    },
  };
}
