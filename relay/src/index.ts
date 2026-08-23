import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { SessionManager } from "./session-manager.js";
import { startServer } from "./ws-server.js";
import { compactEvents, loadEvents, reduceHistory, rewriteFile } from "./history.js";

const cfg = loadConfig();

// 历史持久化：relay/data/events.ndjson（重启后重放重建会话与时间线）
const persistPath = join(process.cwd(), "data", "events.ndjson");
const prior = loadEvents(persistPath);
const kept = compactEvents(prior);
if (prior.length !== kept.length) rewriteFile(persistPath, kept); // 启动时压缩
const replayed = reduceHistory(kept);

const bus = new EventBus({ preload: kept, persistPath });
const mgr = new SessionManager(bus, cfg);
const adopted = mgr.adopt(replayed);
startServer(bus, mgr, cfg);

console.log("Cloud Code Relay 已启动");
console.log(`  模型:   ${cfg.model}`);
console.log(`  端口:   ${cfg.port}`);
console.log(`  历史:   ${persistPath}（恢复 ${adopted} 个会话）`);
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
