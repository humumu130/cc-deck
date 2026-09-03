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
import { createPairingCodes } from "./pairing.js";

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

// 重放会重写历史状态（非终态→ERROR、清 waiting_request），但重连客户端走
// last_seq 补发拿不到 SNAPSHOT——为每个收养会话广播一次当前状态，补发路径也能收敛
for (const s of mgr.snapshot()) {
  bus.emit(s.session_id, "SESSION_UPDATED", {
    status: s.status,
    action_summary: s.action_summary,
    stats: { ...s.stats },
    ...(s.usage ? { usage: s.usage } : {}),
  });
}

// 云桥：CCR_CLOUD_URL 配置了才启用（出站连桥，公司网络友好）。
// 逗号分隔多桥并行：每桥一个 CloudClient，手机/网页各自连任一桥都能互通
let cloudIdentity: ReturnType<typeof loadOrCreateIdentity> | null = null;
const cloudClients: CloudClient[] = [];
const pairCodes = createPairingCodes();
if (cfg.cloudUrls.length) {
  cloudIdentity = loadOrCreateIdentity(cfg.dataDir);
  mgr.setCloud(cloudIdentity);
  mgr.setPairIssuer(() => pairCodes.issue());
  if (cfg.cloudToken) {
    for (const url of cfg.cloudUrls) {
      const c = new CloudClient(bus, mgr, cfg, cloudIdentity, pairCodes, url);
      cloudClients.push(c);
      c.start();
    }
  }
}

// 云通道活跃手机计入"手机在线"：云桥场景下提问/权限照常门控（否则手机在场却直接放行本地）
startServer(bus, mgr, cfg, {
  cloudHasPhones: () => cloudClients.some((c) => c.hasActivePhones()),
  pairCodes,
});

// hooks 桥接配置：bridge-hook.mjs 读取后回连本机 /bridge/hook
writeFileSync(join(cfg.dataDir, "bridge.json"), JSON.stringify({ port: cfg.port, token: cfg.bridgeToken }), "utf-8");

console.log("CC Deck Relay 已启动");
console.log(`  模型:   ${cfg.model}`);
console.log(`  端口:   ${cfg.port}`);
console.log(`  历史:   ${persistPath}（恢复 ${adopted} 个会话）`);
console.log(`  桥接:   ${join(cfg.dataDir, "bridge.json")}（外部 CLI 会话经 hooks 接入）`);
console.log(
  cloudIdentity
    ? `  云桥:   ${cfg.cloudUrls.join(" + ")}（dev=${cloudIdentity.relayDev}，已配对 ${cloudIdentity.peers.size} 台设备${cfg.cloudToken ? "" : "；未设 CCR_CLOUD_TOKEN，仅可配对不可连桥"}）`
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
