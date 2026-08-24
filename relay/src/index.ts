import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { SessionManager } from "./session-manager.js";
import { startServer } from "./ws-server.js";
import { compactEvents, loadEvents, reduceHistory, rewriteFile } from "./history.js";
import { loadOrCreateIdentity } from "./cloud-identity.js";
import { CloudClient } from "./cloud-client.js";

const cfg = loadConfig();

// 历史持久化：relay/data/events.ndjson（重启后重放重建会话与时间线）
const persistPath = join(cfg.dataDir, "events.ndjson");
const prior = loadEvents(persistPath);
const kept = compactEvents(prior);
if (prior.length !== kept.length) rewriteFile(persistPath, kept); // 启动时压缩
const replayed = reduceHistory(kept);

const bus = new EventBus({ preload: kept, persistPath });
const mgr = new SessionManager(bus, cfg);
const adopted = mgr.adopt(replayed);

// 云桥：CCR_CLOUD_URL 配置了才启用（出站连桥，公司网络友好）
let cloudIdentity: ReturnType<typeof loadOrCreateIdentity> | null = null;
if (cfg.cloudUrl) {
  cloudIdentity = loadOrCreateIdentity(cfg.dataDir);
  mgr.setCloud(cloudIdentity);
  if (cfg.cloudToken) {
    const cloud = new CloudClient(bus, mgr, cfg, cloudIdentity);
    cloud.start();
  }
}

startServer(bus, mgr, cfg);

// hooks 桥接配置：bridge-hook.mjs 读取后回连本机 /bridge/hook
writeFileSync(join(cfg.dataDir, "bridge.json"), JSON.stringify({ port: cfg.port, token: cfg.bridgeToken }), "utf-8");

console.log("Cloud Code Relay 已启动");
console.log(`  模型:   ${cfg.model}`);
console.log(`  端口:   ${cfg.port}`);
console.log(`  历史:   ${persistPath}（恢复 ${adopted} 个会话）`);
console.log(`  桥接:   ${join(cfg.dataDir, "bridge.json")}（外部 CLI 会话经 hooks 接入）`);
console.log(
  cloudIdentity
    ? `  云桥:   ${cfg.cloudUrl}（dev=${cloudIdentity.relayDev}，已配对 ${cloudIdentity.peers.size} 台设备${cfg.cloudToken ? "" : "；未设 CCR_CLOUD_TOKEN，仅可配对不可连桥"}）`
    : `  云桥:   未启用（未设置 CCR_CLOUD_URL）`,
);
if (cfg.tokenGenerated) {
  console.log(`  token:  ${cfg.token}  (未设置 CCR_TOKEN，本次随机生成)`);
}
for (const list of Object.values(networkInterfaces())) {
  for (const net of list ?? []) {
    if (net.family === "IPv4" && !net.internal) {
      console.log(`  控制台: http://${net.address}:${cfg.port}/?token=${cfg.token}`);
    }
  }
}
