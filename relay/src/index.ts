import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { writeFileSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { SessionManager } from "./session-manager.js";
import { startServer } from "./ws-server.js";
import { compactEvents, loadEvents, reduceHistory, rewriteFile } from "./history.js";
import { loadOrCreateIdentity } from "./cloud-identity.js";
import { CloudClient } from "./cloud-client.js";
import { createPairingCodes } from "./pairing.js";
import { printQr } from "./qr.js";

const cfg = loadConfig();

function lanIps(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    // 虚拟网卡/VPN 隧道（vEthernet 含 Hyper-V Default Switch、Tailscale/ZeroTier/WireGuard 等）手机不可达，排除
    if (/vmware|virtualbox|wsl|loopback|hyper-v|docker|vethernet|tailscale|zerotier|wireguard|wintun|openvpn|vpn|tap/i.test(name)) continue;
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      // 私网段白名单（RFC1918）：排除公网网卡、169.254 链路本地等手机扫码也连不上的地址
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(net.address)) out.push(net.address);
    }
  }
  return out;
}

const cliArgs = new Set(process.argv.slice(2));

// --qr：只打印连接二维码（App 下载 + 控制台），不启动服务
if (cliArgs.has("--qr")) {
  const ip = lanIps()[0] ?? "127.0.0.1";
  printQr(`http://${ip}:${cfg.port}/m`, `App 下载（手机摄像头扫描）: http://${ip}:${cfg.port}/m`);
  printQr(
    `http://${ip}:${cfg.port}/?token=${cfg.token}`,
    `网页控制台: http://${ip}:${cfg.port}/?token=${cfg.token}`,
  );
  process.exit(0);
}

// --daemon：spawn detached 自身转后台，日志追加 data/relay.log（插件 /cc-deck 用）。
// pid 文件由子进程 listen 成功后自写（onReady）：端口被占时子进程即崩，不留死 pid 覆盖原实例
if (cliArgs.has("--daemon")) {
  if (!process.env.CC_DECK_PLUGIN) {
    console.log("dev 模式（tsx 前台跑 TS 源码）不支持 --daemon，请直接前台运行");
    process.exit(1);
  }
  const rest = process.argv.slice(2).filter((a) => a !== "--daemon");
  const logFd = openSync(join(cfg.dataDir, "relay.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...rest], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, CC_DECK_DAEMON: "1" },
  });
  child.unref();
  console.log(`CC Deck Relay 已转后台运行（日志: ${join(cfg.dataDir, "relay.log")}）`);
  process.exit(0);
}

// pid 复用防护：Windows pid 回收快，残留 pid 文件可能指向无关进程，kill 前先校验是 node
function pidIsNode(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return /node/i.test(out);
    }
    return readFileSync(`/proc/${pid}/comm`, "utf-8").includes("node");
  } catch {
    return false;
  }
}

// --stop：读 relay.pid 终止后台进程（插件 /cc-deck-stop 用）
if (cliArgs.has("--stop")) {
  const pidFile = join(cfg.dataDir, "relay.pid");
  try {
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    if (pid > 0 && pidIsNode(pid)) {
      process.kill(pid);
      console.log(`CC Deck Relay 已停止（pid ${pid}）`);
    } else {
      console.log("未发现运行中的 CC Deck Relay（pid 文件失效，已清理）");
    }
  } catch {
    console.log("未发现运行中的 CC Deck Relay");
  }
  try {
    rmSync(pidFile);
  } catch {}
  process.exit(0);
}


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
  // daemon 子进程 listen 成功后自写 pid（父进程不预写，端口被占时不留死 pid）
  onReady: () => {
    if (process.env.CC_DECK_DAEMON === "1") {
      writeFileSync(join(cfg.dataDir, "relay.pid"), String(process.pid), "utf-8");
    }
  },
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
if (process.env.CC_DECK_DAEMON === "1") {
  // daemon 模式 stdout 落 relay.log：token/带 token 的 URL 不写日志（防泄露），扫码走 /cc-deck
  console.log("  连接:  运行 /cc-deck 显示二维码（token 不写入日志）");
} else {
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
}
