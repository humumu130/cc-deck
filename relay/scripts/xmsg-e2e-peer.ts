// X1 e2e 沙盒自举 fixture：一进程=一台「机器」（relay 全家桶：SessionManager+ws-server+
// CloudClient+xmsg 传输面装配，仿 index.ts 云桥段的最小子集）。test-xmsg-e2e.ts 以不同
// env 多开本文件模拟双机/三机；devfile 写本机 relayDev + pid，测试进程据此驱动。
// env 契约：CCR_PORT/CCR_TOKEN/CCR_BRIDGE_TOKEN/CCR_DATA_DIR/CCR_ORG_DIR/CCR_CLOUD_URL/
// CCR_CLOUD_TOKEN/CCR_TENANT/CCR_TENANT_INVITE/CCR_XMSG/XMSG_E2E_DEVFILE（必填）；
// CCR_INJECT_CMD/CCR_INJECT_LOG/CCR_NO_LEADER/CCR_NO_TITLE_GEN 等测试闸同 test-bridge 配方。
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { CloudClient } from "../src/cloud-client.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { createPairingCodes } from "../src/pairing.js";
import { startServer } from "../src/ws-server.js";

const devfile = process.env.XMSG_E2E_DEVFILE;
if (!devfile) {
  console.error("XMSG_E2E_DEVFILE 未设置");
  process.exit(1);
}
process.env.CCR_NO_TITLE_GEN ??= "1";
process.env.CCR_NO_LEADER ??= "1";
process.env.CCR_DEAD_SWEEP ??= "0";

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
const identity = loadOrCreateIdentity(cfg.dataDir);
mgr.setCloud(identity);
const pairCodes = createPairingCodes();
mgr.setPairIssuer((o) => pairCodes.issue(o));
const cloud = new CloudClient(bus, mgr, cfg, identity, pairCodes, cfg.cloudUrls[0]);
// X1 传输面装配（index.ts 同款最小集：单桥）
mgr.setXmsgTransport({
  myDev: () => identity.relayDev,
  myTenant: () => {
    try { return identity.loadTenantCred()?.tenant ?? null; } catch { return null; }
  },
  send: (dev, inner, pk) => cloud.xmsgSend(dev, inner as unknown as Record<string, unknown>, pk),
  ack: (dev, pk, inner) => cloud.xmsgAck(dev, pk, inner as unknown as Record<string, unknown>),
  discover: (dev) => cloud.xmsgDiscover(dev),
});
startServer(bus, mgr, cfg, { pairCodes });
cloud.start();
writeFileSync(devfile, JSON.stringify({ dev: identity.relayDev, pid: process.pid }), "utf-8");
console.log(`PEER_READY dev=${identity.relayDev} port=${cfg.port} data=${cfg.dataDir}`);
// 常驻（测试进程 SIGTERM 收尾）
setInterval(() => {}, 60_000);
process.on("SIGTERM", () => {
  try { cloud.close(); } catch { /* 尽力而为 */ }
  process.exit(0);
});
