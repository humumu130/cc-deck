import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { SessionManager } from "./session-manager.js";
import { startServer } from "./ws-server.js";

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
startServer(bus, mgr, cfg);

console.log("Cloud Code Relay 已启动");
console.log(`  模型:   ${cfg.model}`);
console.log(`  端口:   ${cfg.port}`);
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
