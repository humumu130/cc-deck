import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { devId, generateKeyPair, type BoxKeyPair } from "./e2e.js";
import type { PeerMeta } from "./types.js";

// relay 侧云身份：box 密钥对（data/cloud-keypair.json，首启生成后固定）
// + 已配对手机（data/cloud-peers.json，公钥来自 LAN 信道上的 COMMAND_PAIR_START）。
// peers 内存为主、写穿到磁盘（配对是低频操作）。
// 2026-09-09 议题①：peers 增删配套（removePeer）与 last_seen（touchPeer 只更新
// 内存，hello/ping 每次都会 touch——写盘仍只在增删时）；F7：/wan 手表凭据
//（wan-secret → 派生 wt- dev，见文末）。

export interface PeerEntry {
  pubkey: string;
  name?: string;
  meta?: PeerMeta; // #42 设备自报身份元数据（pair_req 校验后入库；存量文件无此字段 = 缺省，读取兼容）
  paired_at: number;
  last_seen?: number; // 内存态（不落盘）：最近一次 hello/ping，重启清零
}

export interface CloudIdentity {
  keypair: BoxKeyPair;
  relayDev: string; // "rl-xxxx"，由公钥派生
  // F7 /wan 手表凭据派生 dev（"wt-xxxx"，sha256(wan-secret) 前 16 hex）：手机经
  // SNAPSHOT wan_dev 字段拿到后写进手表连接配置；公共桥严格模式下其他 wt-* 一律拒绝
  wanDev: string;
  peersPath: string;
  peers: Map<string, PeerEntry>;
  addPeer(dev: string, entry: PeerEntry): void;
  removePeer(dev: string): void;
  touchPeer(dev: string): void;
  // #42 设备改名（hello 顺带实名化用）：同名不写盘，改名即持久化
  renamePeer(dev: string, name: string): void;
}

export function loadOrCreateIdentity(dataDir: string): CloudIdentity {
  const kpPath = join(dataDir, "cloud-keypair.json");
  let keypair: BoxKeyPair;
  if (existsSync(kpPath)) {
    keypair = JSON.parse(readFileSync(kpPath, "utf-8")) as BoxKeyPair;
    if (!keypair.publicKey || !keypair.secretKey) throw new Error("cloud-keypair.json 损坏，请删除后重启重新生成（已配对手机需重新配对）");
  } else {
    keypair = generateKeyPair();
    writeFileSync(kpPath, JSON.stringify(keypair), "utf-8");
  }

  // F7 /wan 手表凭据：明文透传通道的唯一共享秘密。dev 即凭据（wt-<hash 前 16>）——
  // 手表端零改动（URL 由手机 App 下发），桥原样转发，relay 校验 from 是否等于本机
  // 派生值。secret 只活在 relay 数据目录，公共桥上的陌生人拿不到（威胁模型 A1）；
  // 桥运营者可见（A4，与该通道「桥可信」的原前提一致，本期不收紧）
  const wanSecretPath = join(dataDir, "wan-secret");
  let wanSecret = "";
  if (existsSync(wanSecretPath)) wanSecret = readFileSync(wanSecretPath, "utf-8").trim();
  if (!/^[0-9a-f]{32}$/.test(wanSecret)) {
    wanSecret = randomBytes(16).toString("hex");
    writeFileSync(wanSecretPath, wanSecret, "utf-8");
  }
  const wanDev = "wt-" + createHash("sha256").update(wanSecret).digest("hex").slice(0, 16);

  const peersPath = join(dataDir, "cloud-peers.json");
  const peers = new Map<string, PeerEntry>();
  if (existsSync(peersPath)) {
    try {
      const raw = JSON.parse(readFileSync(peersPath, "utf-8")) as Record<string, PeerEntry>;
      for (const [dev, entry] of Object.entries(raw)) peers.set(dev, entry);
    } catch {
      // 损坏则视为无配对
    }
  }
  const persistPeers = (): void => {
    const obj: Record<string, PeerEntry> = {};
    for (const [k, v] of peers) obj[k] = v;
    writeFileSync(peersPath, JSON.stringify(obj, null, 2), "utf-8");
  };

  return {
    keypair,
    relayDev: devId(keypair.publicKey, "rl"),
    wanDev,
    peersPath,
    peers,
    addPeer(dev, entry) {
      peers.set(dev, entry);
      persistPeers();
    },
    // 议题①踢除：Map 删 + 写穿落盘；幂等（不存在也成功）。通道侧联动见 CloudClient.kickPeer
    removePeer(dev) {
      if (!peers.delete(dev)) return;
      persistPeers();
    },
    // last_seen 内存态：hello/ping 每次都 touch，不写盘（高频操作落盘没有意义，
    // 重启清零 = 「未知」，UI 显示离线即可）
    touchPeer(dev) {
      const e = peers.get(dev);
      if (e) e.last_seen = Date.now();
    },
    renamePeer(dev, name) {
      const e = peers.get(dev);
      if (!e || !name || e.name === name) return;
      e.name = name;
      persistPeers();
    },
  };
}
