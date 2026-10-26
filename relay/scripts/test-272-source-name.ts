// #272 源名称可编辑——relay 读写口/广播/回落 + web 接线 断言。
// 任务书口径：hostname 默认过长（如 huanglin）要能改；sanitize ≤12 字符；空/非法回落
// hostname；改名后 SNAPSHOT 带新名（免重启）。
//
// 断言组：
//   A 纯函数（真模块 import，mkdtemp 沙盒）：sanitize 五态 + 写读持久化 + 清空回落
//   B 静态锚（防回退锁）：relay 六处接线（单源模块/setRelayName 广播/命令 case/白名单×2/
//     SNAPSHOT 现算×2）+ web 四处接线（onEvent 消费/编辑行双落点/命令形态）
//   C e2e（真 relay 子进程·随机端口·安全 env 全套）：连接收 SNAPSHOT(hostname) → 改名
//     ACK+RELAY_NAME_UPDATED 双回 → 重连 SNAPSHOT 新名 → 清空回落 hostname → 超长拒收
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-272-source-name.ts
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { WebSocket } from "ws";
import { effectiveRelayName, sanitizeRelayName, writeRelayName, RELAY_NAME_MAX } from "../src/settings.js";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(RELAY_DIR, "..");
const sd = readFileSync(join(ROOT, "web-console", "js", "settings-domain.js"), "utf-8");
const smSrc = readFileSync(join(RELAY_DIR, "src", "session-manager.ts"), "utf-8");
const bcSrc = readFileSync(join(RELAY_DIR, "src", "commands", "board-commands.ts"), "utf-8");
const wsSrc = readFileSync(join(RELAY_DIR, "src", "ws-server.ts"), "utf-8");
const ccSrc = readFileSync(join(RELAY_DIR, "src", "cloud-client.ts"), "utf-8");
const idxSrc = readFileSync(join(RELAY_DIR, "src", "index.ts"), "utf-8");
const typesSrc = readFileSync(join(RELAY_DIR, "src", "types.ts"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const p = (obj: unknown) => JSON.parse(JSON.stringify(obj));

console.log("#272 源名称可编辑——settings 读写口/广播/回落（纯函数+静态锚+e2e）");

// ---------- A 纯函数 ----------
{
  const dir = mkdtempSync(join(tmpdir(), "cc272-"));
  try {
    ok(effectiveRelayName(dir) === hostname().slice(0, 40), "A1 无文件回落 hostname");
    ok(sanitizeRelayName("  Mac小金刚  ").ok === true && p(sanitizeRelayName("  Mac小金刚  ")).name === "Mac小金刚", "A2 sanitize：trim 首尾空白");
    ok(sanitizeRelayName("x".repeat(RELAY_NAME_MAX + 1)).ok === false, "A3 sanitize：超长（>12）拒收");
    ok(sanitizeRelayName("bad\x01name").ok === false, "A4 sanitize：控制字符拒收");
    ok(sanitizeRelayName(42).ok === false && sanitizeRelayName(undefined).ok === false, "A5 sanitize：非字符串拒收");
    ok(sanitizeRelayName("   ").ok === true && p(sanitizeRelayName("   ")).name === "", "A6 sanitize：纯空白=清空（回落 hostname）");
    ok(writeRelayName(dir, "Mac小金刚") && effectiveRelayName(dir) === "Mac小金刚", "A7 改名持久化：写盘后现算即新名（免重启）");
    ok(readFileSync(join(dir, "relay-name"), "utf-8") === "Mac小金刚", "A8 文件内容即源名（relay-name 唯一事实源）");
    ok(writeRelayName(dir, "") && !existsSync(join(dir, "relay-name")) && effectiveRelayName(dir) === hostname().slice(0, 40), "A9 清空回落 hostname（文件删除幂等）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------- B 静态锚（防回退锁） ----------
ok(smSrc.includes('emitTransient("RELAY_NAME_UPDATED", { relay_name })'), "B1 setRelayName 成功边广播 RELAY_NAME_UPDATED");
ok(smSrc.includes('case "COMMAND_RELAY_NAME_SET"'), "B2 命令分派 case 挂载");
ok(bcSrc.includes("COMMAND_RELAY_NAME_SET(cmd"), "B3 board-commands 命令体挂载（sanitize/写口/ack relay_name）");
ok(wsSrc.includes('"COMMAND_RELAY_NAME_SET"') && ccSrc.includes('"COMMAND_RELAY_NAME_SET"'), "B4 LAN/云两入口白名单同挂（逐字一致纪律）");
ok(typesSrc.includes('"RELAY_NAME_UPDATED"') && typesSrc.includes("RelayNameSetCommand"), "B5 类型面：EventType+命令 shape");
ok(idxSrc.includes("effectiveRelayName(dataDir)"), "B6 relayNameOf 单源收编 settings.ts（读侧唯一事实源）");
ok(sd.includes('message.type === "RELAY_NAME_UPDATED"') && sd.includes("s.relay_source = next"), "B7 web onEvent 消费广播：relayName 跟随+存量会话源标签改写");
ok(sd.includes("function relayNameRowHtml") && sd.includes("relayNameRowHtml(false)") && sd.includes("relayNameRowHtml(true)"), "B8 编辑行双落点（桌面 settings 行+移动 lane）");
ok(sd.includes('type: "COMMAND_RELAY_NAME_SET"') && sd.includes("f.command_id !== commandId"), "B9 web 保存走命令通道+ACK 按 command_id 结算");
ok(sd.includes("[data-relay-name-input]") && sd.includes("data-relay-name-save"), "B10 输入/保存锚点（回车+点击委托+重渲保护）");

// ---------- C e2e：真 relay 子进程 ----------
{
  const dataDir = mkdtempSync(join(tmpdir(), "cc272-e2e-"));
  const port = 8800 + Math.floor(Math.random() * 400);
  const token = `test-token-${port}`;
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
      CCR_CLOUD_URL: "", CCR_NO_TITLE_GEN: "1", CCR_NO_BRIDGE_MIRROR: "1",
      CCR_NO_LEADER: "1", CCR_NO_MDNS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += String(d)));
  child.stderr?.on("data", (d) => (out += String(d)));
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* 已退 */ } };
  try {
    // TCP 探活（比 HTTP /health 稳：keep-alive 拆链的 ECONNRESET 不会裸崩进程）
    const probe = () => new Promise<boolean>((res) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); res(true); });
      sock.once("error", () => res(false));
    });
    let up = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !up) {
      up = await probe();
      if (!up) await new Promise((r) => setTimeout(r, 300));
    }
    ok(up, "C1 relay 子进程就绪（随机端口 " + port + "，安全 env 全套）");

    // ws 客户端：收帧收集器
    const frames: Array<Record<string, unknown>> = [];
    const mkWs = () => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&last_seq=0`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      ws.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* 非 JSON 忽略 */ } });
    });
    const waitFrame = (pred: (f: Record<string, unknown>) => boolean, ms = 8000) =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          const hit = frames.find(pred);
          if (hit) { clearInterval(iv); resolve(hit); }
          else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(null); }
        }, 50);
      });

    process.on("uncaughtException", (e) => { console.log("UNCAUGHT:", e && (e as Error).stack); console.log("CHILD OUT (tail):\n" + out.slice(-1500)); process.exit(2); });
    let ws = await mkWs();
    const snap1 = await waitFrame((f) => f.type === "SNAPSHOT");
    ok(!!snap1 && (snap1.payload as Record<string, unknown>)?.relay_name === hostname().slice(0, 40), "C2 连接即收 SNAPSHOT，relay_name=hostname 默认（未命名态）");

    ws.send(JSON.stringify({ command_id: "c272a", type: "COMMAND_RELAY_NAME_SET", payload: { name: "  Mac小金刚  " }, ts: Date.now() }));
    const ack1 = await waitFrame((f) => f.type === "COMMAND_ACK" && f.command_id === "c272a");
    ok(!!ack1 && ack1.ok === true && p(ack1.data).relay_name === "Mac小金刚", "C3 改名 ACK：trim 后生效名回传");
    const bcast = await waitFrame((f) => f.type === "RELAY_NAME_UPDATED");
    ok(!!bcast && p(bcast.payload).relay_name === "Mac小金刚", "C4 RELAY_NAME_UPDATED 广播到达（LAN 连接实时收，源 chip 免刷新换名）");

    // 重连（新 ws、last_seq=0）→ SNAPSHOT 现算新名（免重启验证）
    ws.close();
    frames.length = 0;
    ws = await mkWs();
    const snap2 = await waitFrame((f) => f.type === "SNAPSHOT");
    ok(!!snap2 && (snap2.payload as Record<string, unknown>)?.relay_name === "Mac小金刚", "C5 重连 SNAPSHOT 带新名（relayNameOf 现算——改名免重启）");

    // 超长拒收
    ws.send(JSON.stringify({ command_id: "c272b", type: "COMMAND_RELAY_NAME_SET", payload: { name: "x".repeat(13) }, ts: Date.now() }));
    const ack2 = await waitFrame((f) => f.type === "COMMAND_ACK" && f.command_id === "c272b");
    ok(!!ack2 && ack2.ok === false && String(ack2.error).includes("12"), "C6 超长（13 字符）拒收带可读指引");

    // 清空回落 hostname
    ws.send(JSON.stringify({ command_id: "c272c", type: "COMMAND_RELAY_NAME_SET", payload: { name: "   " }, ts: Date.now() }));
    const ack3 = await waitFrame((f) => f.type === "COMMAND_ACK" && f.command_id === "c272c");
    ok(!!ack3 && ack3.ok === true && p(ack3.data).relay_name === hostname().slice(0, 40), "C7 清空（纯空白）回落 hostname");
    ok(!existsSync(join(dataDir, "relay-name")), "C8 清空后 relay-name 文件已删（回落持久化语义）");
    ws.close();
  } finally {
    kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
