import { networkInterfaces, homedir, hostname } from "node:os";
import { join } from "node:path";
import { writeFileSync, openSync, readFileSync, rmSync, existsSync } from "node:fs";
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
import { advertiseRelay } from "./mdns.js";

const cfg = loadConfig();

// #28（2026-09-10 用户机实测根因）：同数据目录双 relay 进程（CLI 插件 supervisor +
// exe 内嵌共用 ~/.cc-deck/data，同身份连桥）被桥按 dev 顶号互踢——闪断循环、重启
// 才恢复。数据目录级单实例锁：锁内有活进程则本进程退出（先到先得，覆盖所有入口）
{
  const lockPath = join(cfg.dataDir, "relay.lock");
  try {
    const prev = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isFinite(prev) && prev > 0 && prev !== process.pid) {
      process.kill(prev, 0); // 活着会抛？不——活着不抛，死了抛 ESRCH
      // 走到这 = 旧进程还活着：让位退出（exe 内嵌场景另一进程正服务 8787）。
      // 压 5s 再退：supervisor bat 循环重启，立即退出会热旋（每秒拉起即退烧 CPU）。
      // 顶层 await 永挂阻断后续初始化，5s 后由 timer 收走进程
      console.log(`[relay] 数据目录已被 pid=${prev} 的 relay 占用（单实例锁），5s 后让位退出`);
      setTimeout(() => process.exit(0), 5_000);
      await new Promise<never>(() => {});
    }
  } catch (e) {
    // ESRCH=旧进程已死（陈旧锁）/ ENOENT=无锁：正常继续，下方接管
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ESRCH") {
      // 权限等其他错误：不阻断启动（锁是加固不是门槛），仅记日志
      console.log("[relay] 单实例锁检查异常（忽略继续）:", (e as Error).message);
    }
  }
  try {
    writeFileSync(lockPath, String(process.pid));
  } catch {}
  const wipe = () => {
    try {
      if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) rmSync(lockPath);
    } catch {}
  };
  process.on("exit", wipe);
  process.on("SIGINT", () => { wipe(); process.exit(0); });
  process.on("SIGTERM", () => { wipe(); process.exit(0); });
}

// #324 选装生命周期：被桌面壳拉起（CCR_PARENT_PID 注入）时随壳退出——壳被强杀
// （任务管理器/崩溃）收不到清理事件，这里轮询父进程存活，死了自行退出，不留孤儿 relay
const parentPid = Number(process.env.CCR_PARENT_PID ?? 0);
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log("[relay] parent process gone, exiting embedded relay");
      process.exit(0);
    }
  }, 3000);
}

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

// --pair：向运行中的 relay 领取云桥配对码（异地网页端/设备输码接入，无需 LAN 可达）。
// bridge.json 自带端口+bridgeToken，只打 loopback——能读本机 bridge.json 的进程本就可信
if (cliArgs.has("--pair")) {
  let port = cfg.port;
  let bridgeToken = cfg.bridgeToken;
  try {
    const b = JSON.parse(readFileSync(join(cfg.dataDir, "bridge.json"), "utf-8")) as {
      port?: number;
      token?: string;
    };
    if (b.port) port = b.port;
    if (b.token) bridgeToken = b.token;
  } catch {}
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/pair-issue`, {
      method: "POST",
      headers: { "x-bridge-token": bridgeToken },
    });
    if (r.status === 501) {
      console.log("云桥未启用（未设置 CCR_CLOUD_URL/CCR_CLOUD_TOKEN），无可领配对码");
      process.exit(1);
    }
    if (!r.ok) {
      console.log(`领取失败: HTTP ${r.status}（先运行 /cc-deck 启动 relay）`);
      process.exit(1);
    }
    const d = (await r.json()) as { code: string; expires_in: number };
    console.log("");
    console.log("════════════════════════════");
    // 8 位码居中分两段（旧 6 位同款式样）；分钟数动态读 expires_in
    const half = Math.floor(d.code.length / 2);
    console.log(`  云桥配对码：${d.code.slice(0, half)} ${d.code.slice(half)}`);
    console.log("════════════════════════════");
    console.log(`${Math.round(d.expires_in / 60)} 分钟内有效、一次性。在异地网页端（${cfg.cloudUrls[0] ?? "云桥"}）或`);
    console.log("手机 App「配对码」入口输入即可接入本机 relay。");
    process.exit(0);
  } catch {
    console.log("连不上本机 relay（先运行 /cc-deck 启动）");
    process.exit(1);
  }
}

// --qr：只打印连接二维码（App 直连 + App 下载 + 控制台），不启动服务
if (cliArgs.has("--qr")) {
  const ip = lanIps()[0] ?? "127.0.0.1";
  // App 直连码（#276）：JSON {v,url,token}，CC Deck App 扫码添加服务器——地址+令牌一步到位，
  // 免手输。v 版本号留扩展余地；扫码页按 v 分发解析
  printQr(
    JSON.stringify({ v: 1, url: `ws://${ip}:${cfg.port}/ws`, token: cfg.token }),
    `App 直连（CC Deck App 内扫码添加）: ws://${ip}:${cfg.port}/ws`,
  );
  printQr(`http://${ip}:${cfg.port}/m/cc-deck.apk`, `App 下载（手机摄像头扫描）: http://${ip}:${cfg.port}/m/cc-deck.apk`);
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
        windowsHide: true,
      });
      return /node/i.test(out);
    }
    if (existsSync("/proc")) return readFileSync(`/proc/${pid}/comm`, "utf-8").includes("node");
    // macOS 无 /proc，用 ps 查进程名（拿不到=已退出，走 catch 返回 false）；
    // comm 可能是完整路径，按 basename 精确比对，避免路径含 node 误判
    return "node" === execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim().split(/[\\/]/).pop();
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

// #49 置顶会话休眠登记（2026-09-09 用户拍板：开机不自动 resume）：pinned-sessions.json
// 清单内会话只标 saved（可见不可操作、卡片「已保存」），用户点卡发 COMMAND_RESUME_SESSION
// 才用 transcript resume 按需拉起——不拉 SDK 子进程，启动零成本
const pinned = mgr.applyPinned();

// 云桥：CCR_CLOUD_URL 配置了才启用（出站连桥，公司网络友好）。
// 逗号分隔多桥并行：每桥一个 CloudClient，手机/网页各自连任一桥都能互通
let cloudIdentity: ReturnType<typeof loadOrCreateIdentity> | null = null;
const cloudClients: CloudClient[] = [];
const pairCodes = createPairingCodes();
if (cfg.cloudUrls.length) {
  cloudIdentity = loadOrCreateIdentity(cfg.dataDir);
  mgr.setCloud(cloudIdentity);
  mgr.setPairIssuer((o) => pairCodes.issue(o));
  mgr.setLoginGranter((dev, pk, name) => {
    for (const c of cloudClients) c.grantLogin(dev, pk, name);
    return true;
  });
  // 0.4.4 跨网回传：两遍扫描——先试目标持活跃连接（hello 在线）的桥（必发必达），
  // 再回落 sighting 桥（近期见过信标，发送后靠桥 ROUTE_MISS 兜底）；防 sighting 桥
  // 排前遮蔽真正连着目标页的桥
  mgr.setImportPusher((dev, pk, payload) => {
    for (const c of cloudClients) if (c.hasActiveDev(dev) && c.pushImportTo(dev, pk, payload)) return true;
    for (const c of cloudClients) if (!c.hasActiveDev(dev) && c.pushImportTo(dev, pk, payload)) return true;
    return false;
  });
  // 议题①踢除执行器：先移除 peers（写穿落盘），再各桥发明文 pair_nack 令其立即
  // 停止重连 + 停发下行——多桥场景设备连着哪座桥都能收到失联通知
  mgr.setPeerKicker((dev) => {
    cloudIdentity?.removePeer(dev);
    for (const c of cloudClients) c.kickPeer(dev);
  });
  if (cfg.cloudToken) {
    for (const url of cfg.cloudUrls) {
      const c = new CloudClient(bus, mgr, cfg, cloudIdentity, pairCodes, url);
      cloudClients.push(c);
      c.start();
    }
  }
}

// 云通道活跃手机计入"手机在线"：云桥场景下提问/权限照常门控（否则手机在场却直接放行本地）
// pairCodes 仅云桥启用时下发（无云桥时配对码无处消费，领了也白领）
startServer(bus, mgr, cfg, {
  cloudHasPhones: () => cloudClients.some((c) => c.hasActivePhones()),
  ...(cloudClients.length ? { pairCodes } : {}),
  // relay_dev 随 SNAPSHOT 下发（云桥启用即有身份，含未设 cloudToken 的仅配对场景）：
  // 客户端据此证明 LAN 直连条目与云桥条目是同一台 relay，自动合并重复条目。
  // wan_dev（F7）：手表 /wan 凭据 dev，手机端拼进手表连接配置（旧客户端自动忽略）
  ...(cloudIdentity ? { cloudRelayDev: () => cloudIdentity!.relayDev } : {}),
  ...(cloudIdentity ? { cloudWanDev: () => cloudIdentity!.wanDev } : {}),
  // #100 relay 自定义名称：dataDir/relay-name 单行文件（web 设置 relay 页可写）
  relayName: () => {
    try { return readFileSync(join(cfg.dataDir, "relay-name"), "utf8").trim().slice(0, 40) || ""; } catch { return ""; }
  },
  // daemon 子进程 listen 成功后自写 pid（父进程不预写，端口被占时不留死 pid）
  onReady: () => {
    // #316 mDNS 广播（_ccdeck._tcp）：手表同 WiFi 零配置发现；失败静默（组播被拦不影响其余）
    advertiseRelay(cfg.port, `CC Deck Relay (${hostname()})`);
    if (process.env.CC_DECK_DAEMON === "1") {
      writeFileSync(join(cfg.dataDir, "relay.pid"), String(process.pid), "utf-8");
    }
    // hooks 桥接配置：listen 成功后才写（启动失败不覆盖持端口 relay 的配置）。
    // 开发模式额外镜像到 ~/.cc-deck/data（hook 的首选目录）：dev/插件两个 relay
    // 换班持端口时，hook 读到的 token 始终属于实际活着的 relay，杜绝 403 失联（#211）
    const bridgeJson = JSON.stringify({ port: cfg.port, token: cfg.bridgeToken });
    writeFileSync(join(cfg.dataDir, "bridge.json"), bridgeJson, "utf-8");
    const hookHome = join(homedir(), ".cc-deck", "data");
    if (cfg.dataDir !== hookHome && existsSync(hookHome)) {
      try {
        writeFileSync(join(hookHome, "bridge.json"), bridgeJson, "utf-8");
      } catch {}
    }
  },
});

console.log("CC Deck Relay 已启动");
console.log(`  模型:   ${cfg.model}`);
console.log(`  端口:   ${cfg.port}`);
console.log(`  历史:   ${persistPath}（恢复 ${adopted} 个会话）`);
if (pinned.saved > 0) {
  console.log(`  置顶:   ${pinned.saved} 个会话已休眠登记（点卡片按需恢复，不自动拉起）`);
}
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
