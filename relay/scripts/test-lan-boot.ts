// CONNV4D 返修 fix1（P1-1）：真实启动序断言——起真 index 进程（tsx 子进程，安全 env
// 全套）→ 真组播栈（bonjour-service 真 publish，非 mock）→ 浏览器收 _ccdeck._tcp →
// 断言 advertise TXT 含 v2 身份（dev=rl- 公钥派生+pk 自洽+nm）。防回归锚：bootfast2
// 曾把云桥块（cloudIdentity 唯一构造点）整体后台化，listen 回调先到 → hub.txt() 恒
// null → TXT 恒发 v:"2" 空帧 → 同版本部署互不可见（LAN 发现腿死路，R1 P1-1）——
// mock bonjour 从 hub 层注入，永远测不到这条腿，故必须真进程真栈。
//
// 隔离纪律（#20「测试幽灵实例」实锤教训）：CCR_MDNS_IP 把 publish/browse 挪到私有
// 组播组（组织本地范围 239.192/14，RFC 2365）——同网真实设备（224.0.0.251 组）不
// 可见；测试端浏览器同组收包（同主机组播回环）。CCR_MDNS_NAME 唯一名防自撞。
// CCR_CLOUD_URL 指哑桥（127.0.0.1:1 连不上，零外联）只为开 identity 构造闸——云
// token 缺省回落公共桥 token 会起 CloudClient，连哑桥即刻失败重试，无副作用。
//
// 跑法：
//   env -u CCR_ORG_DIR npx tsx scripts/test-lan-boot.ts
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import Bonjour from "bonjour-service";
import { devId } from "../src/e2e.js";
import type { BonjourSocketOpts } from "../src/mdns.js";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GROUP = "239.192.77.19"; // 组织本地范围私有组——与 224.0.0.251（mDNS 知名组）分属
const NAME = `CC Deck Boot Test ${process.pid}`;

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("CONNV4D-FIX1 LAN BOOT（真实启动序：index 进程→真组播→TXT v2 身份）");

// ---------- 1. 静态序锚（bootfast 时序回归锁，272-B 同款源码抽取范式） ----------
{
  const idx = readFileSync(join(RELAY_DIR, "src", "index.ts"), "utf-8");
  const mdns = readFileSync(join(RELAY_DIR, "src", "mdns.ts"), "utf-8");
  const pre = idx.indexOf("云身份预构造");
  const boot = idx.indexOf("startServer(bus, mgr, cfg");
  assert(pre >= 0 && boot >= 0 && pre < boot, "静态序锚：identity 预构造先于 startServer（onReady TXT 时序根）");
  assert(idx.indexOf("云身份预构造失败（云桥段重试）") >= 0 && /if \(!cloudIdentity\) cloudIdentity = loadOrCreateIdentity/.test(idx),
    "静态锚：预构造失败回落云桥块重试（不二次构造——peers Map 实例态不换）");
  assert(mdns.includes("CCR_MDNS_IP"), "静态锚：mdns 组播组隔离钮（CCR_MDNS_IP）publish/browse 双落");
}

// ---------- 2. 真实启动序 e2e：真 index 进程 → 真组播 → TXT v2 身份 ----------
{
  const dataDir = mkdtempSync(join(tmpdir(), "cc-connv4d-boot-"));
  const port = 4200 + Math.floor(Math.random() * 3000);
  const token = `test-token-boot-${port}`;
  const TSX_CLI = join(RELAY_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const env = { ...process.env } as Record<string, string>;
  delete env.CCR_EMPLOYEE_CONFIG_DIR;
  env.CLAUDE_CONFIG_DIR = join(dataDir, "claude-cfg");
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "src/index.ts"], {
    cwd: RELAY_DIR, detached: true,
    env: {
      ...env, CCR_PORT: String(port), CCR_TOKEN: token, CCR_DATA_DIR: dataDir,
      CCR_ORG_DIR: join(dataDir, "org"), CCR_ORG_BIN_DIR: join(dataDir, "bin"),
      CCR_PROJECTS_ROOT: join(dataDir, "projects-root"),
      CCR_CLOUD_URL: "ws://127.0.0.1:1/cloud", // 哑桥：开 identity 构造闸（cloudUrls 非空）零外联
      CCR_NO_TITLE_GEN: "1", CCR_NO_BRIDGE_MIRROR: "1",
      CCR_NO_LEADER: "1",
      CCR_MDNS_NAME: NAME, CCR_MDNS_IP: GROUP, // 私有组隔离；不设 CCR_NO_MDNS——本套的靶子就是真广播
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += String(d)));
  child.stderr?.on("data", (d) => (out += String(d)));
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* 已退 */ } };

  // 浏览器同组收包（真 bonjour-service；up+txt-update 双挂——TXT 若分帧到也能收到）
  const bonjour = new Bonjour({ ip: GROUP } as BonjourSocketOpts);
  const seen: Array<{ name?: string; txt?: Record<string, unknown> }> = [];
  const browser = bonjour.find({ type: "ccdeck" }, (s) => { seen.push(s); });
  browser.on?.("txt-update", (s: { name?: string; txt?: Record<string, unknown> }) => { seen.push(s); });

  try {
    // TCP 探活（272 同款——比 HTTP /health 稳）
    const probe = () => new Promise<boolean>((res) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); res(true); });
      sock.once("error", () => res(false));
    });
    let up = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !up) {
      up = await probe();
      if (!up) await wait(300);
    }
    assert(up, "index 子进程就绪（listen " + port + "，安全 env 全套+真 mDNS 广播开）");

    // 等 advertise 到达：服务名匹配 + TXT 带身份（P1-1 靶——修复前 TXT 恒 {v:"2"} 空
    // 帧，dev/pk 永不到达即超时红；修复后 identity 预构造先于 listen，首帧即全量）
    let hit: { name?: string; txt?: Record<string, unknown> } | null = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && !hit) {
      hit = seen.find((s) => s?.name === NAME && s.txt && typeof (s.txt as Record<string, unknown>).dev === "string") ?? null;
      if (!hit) await wait(200);
    }
    assert(hit !== null, "真组播栈收到本机广播（" + NAME + "，私有组回环——非 mock 链路）");
    const txt = (hit?.txt ?? {}) as Record<string, unknown>;
    const dev = typeof txt.dev === "string" ? txt.dev : "";
    const pk = typeof txt.pk === "string" ? txt.pk : "";
    assert(txt.v === "2", "TXT v2 帧在位（v=\"2\"）");
    assert(/^rl-[0-9a-f]{4,64}$/.test(dev), "TXT 含 dev（rl- 公钥派生身份——P1-1 修复锚：bootfast 时序后首帧即全量）");
    assert(pk.length >= 40 && devId(pk, "rl") === dev, "TXT 含 pk 且 dev 自洽（devId(pk)===dev——发起端免二次握手锚）");
    assert(typeof txt.nm === "string" && (txt.nm as string).length > 0, "TXT 含 nm（显示名——不可信展示层，发现列表消费）");
    // 云身份文件确实由预构造生成（哑桥形态下 identity 已就绪的旁证）
    const kpFile = readFileSync(join(dataDir, "cloud-keypair.json"), "utf-8");
    const kp = JSON.parse(kpFile) as { publicKey?: string };
    assert(kp.publicKey === pk, "广播 pk 与 data/cloud-keypair.json 一致（identity 预构造就绪旁证）");
  } finally {
    try { browser.stop(); } catch { /* 尽力而为 */ }
    try { bonjour.destroy(); } catch { /* 尽力而为 */ }
    kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
  void out; // 诊断保留（失败时人工看子进程输出）
}

console.log(`\nLAN-BOOT TESTS: ${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
