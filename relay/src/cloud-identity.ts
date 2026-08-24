import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devId, generateKeyPair, type BoxKeyPair } from "./e2e.js";

// relay 侧云身份：box 密钥对（data/cloud-keypair.json，首启生成后固定）
// + 已配对手机（data/cloud-peers.json，公钥来自 LAN 信道上的 COMMAND_PAIR_START）。
// peers 内存为主、写穿到磁盘（配对是低频操作）。

export interface PeerEntry {
  pubkey: string;
  name?: string;
  paired_at: number;
}

export interface CloudIdentity {
  keypair: BoxKeyPair;
  relayDev: string; // "rl-xxxx"，由公钥派生
  peersPath: string;
  peers: Map<string, PeerEntry>;
  addPeer(dev: string, entry: PeerEntry): void;
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

  return {
    keypair,
    relayDev: devId(keypair.publicKey, "rl"),
    peersPath,
    peers,
    addPeer(dev, entry) {
      peers.set(dev, entry);
      const obj: Record<string, PeerEntry> = {};
      for (const [k, v] of peers) obj[k] = v;
      writeFileSync(peersPath, JSON.stringify(obj, null, 2), "utf-8");
    },
  };
}
