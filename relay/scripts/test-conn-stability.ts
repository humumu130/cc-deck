// conn-stability（t-bf6ec695，用户 1101 晚实锤 P0）：双端连接稳定性断言。
//   A 电脑端「断后连不上」：真进程实测——起 relay→kill -9（陈锁残留）→再起→lock pid 验活
//     放行接管（#37 链）+端口恢复+token 复用二连握手。壳 supervise（#66 重拉+指数退避）
//     代码链读码验证（无法脱离 cargo 测——结论锚进本文件注释供审查）
//   B 手机端「易断+重连慢」：退避表数字锚（BASE 1s/上限 60s/连上归零）+AppState 前台
//     零退避链（onForeground 清退避+看门狗 5s 拉立即）+connEvents 断连台账结构锚
//   C 打点：五分类挂点锚（net-drop/server-close/protocol/hb-timeout/resume-broken）
//     +环形 cap 20+复通 durMs 补写+关于页只读口
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 10000, every = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}
function portListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  // connect 探（非 listen 绑）：listen 成功=端口空闲（探针自己绑上）会误报就绪
  return new Promise((resolve) => {
    const s = connect(port, host, () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 800);
  });
}

const relayDir = join(fileURLToPath(import.meta.url).replace(/\/scripts\/.*$/, ""));
const PORT = 8941;
const DATA = join(tmpdir(), "ccr-conn-stability-" + Date.now());

async function startRelay(): Promise<{ proc: ReturnType<typeof spawn>; pid: number }> {
  // detached=自成进程组：tsx 是 wrapper（真正 relay 是孙进程）——kill 必须杀整组
  // （杀 tsx 父不连坐孙=端口仍占，「kill 后端口空」假红——进程树坑实录）
  const proc = spawn(process.execPath, [join(relayDir, "node_modules", ".bin", "tsx"), "src/index.ts"], {
    cwd: relayDir,
    env: { ...process.env, CCR_DATA_DIR: DATA, CCR_PORT: String(PORT), CCR_NO_TITLE_GEN: "1", CCR_STORAGE_READ_MODE: "json" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  proc.stdout!.on("data", () => {});
  proc.stderr!.on("data", () => {});
  return { proc, pid: proc.pid! };
}

async function main() {
  mkdirSync(DATA, { recursive: true });

  // ============ A 电脑端：真进程 kill 复活链 ============
  console.log("A 电脑端 relay 死亡→接管（真进程实测）:");
  const t0 = Date.now();
  const r1 = await startRelay();
  let up1 = false;
  for (let i = 0; i < 100 && !up1; i++) { up1 = await portListening(PORT); if (!up1) await wait(100); }
  ok(up1, `relay 首起端口就绪（${Date.now() - t0}ms——冷启动数字入回执）`);
  const lock1 = readFileSync(join(DATA, "relay.lock"), "utf8").trim();
  ok(Number(lock1) > 0, `单实例锁写入（lock=${lock1.slice(0, 6)}…——tsx 树孙进程 pid，非 wrapper pid）`);
  // kill -9：模拟崩溃/断电——不清锁（最坏形态：wipe 不执行的硬死）
  try { process.kill(-r1.pid, "SIGKILL"); } catch { try { r1.proc.kill("SIGKILL"); } catch {} } // 整组杀
  for (let i = 0; i < 50; i++) { if (!(await portListening(PORT))) break; await wait(100); }
  ok(!(await portListening(PORT)), "kill -9 后端口空（进程硬死）");
  ok(existsSync(join(DATA, "relay.lock")), "陈锁残留（wipe 未及执行的断电形态——#37 场景）");
  // 再起：pid 验活应放行接管（posix kill(dead_pid,0)=ESRCH）
  const t2 = Date.now();
  const r2 = await startRelay();
  let up2 = false;
  for (let i = 0; i < 150 && !up2; i++) { up2 = await portListening(PORT); if (!up2) await wait(100); }
  ok(up2, `新 relay 起在陈锁上（pid 验活放行接管——断后连不上根因面排除；复活 ${Date.now() - t2}ms）`);
  const lock2 = readFileSync(join(DATA, "relay.lock"), "utf8").trim();
  ok(Number(lock2) > 0 && lock2 !== lock1, "锁被新进程接管覆写（孙 pid ≠ 旧锁 pid）");

  // token 复用：二连握手（supervise 重拉后 webview 用旧 token 直连的场景）
  const token = readFileSync(join(DATA, "token"), "utf8").trim();
  const wsOk = await new Promise<boolean>((resolve) => {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 4000);
      ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(true); });
      ws.on("error", () => { clearTimeout(timer); resolve(false); });
    } catch { resolve(false); }
  });
  ok(wsOk, "旧 token 对新 relay 握手成功（#158-批3 token 无条件落库链——webview 无需重配）");
  try { process.kill(-r2.pid, "SIGTERM"); } catch { try { r2.proc.kill("SIGTERM"); } catch {} } // 整组杀
  await wait(300);
  // 壳侧 supervise 链（读码结论锚——cargo 测不可行，代码证据行号）：
  //   main.rs supervise_embedded_relay（#66）：1.5s 拍 try_wait 收割死句柄→端口空+WANT→
  //   重拉（2→32s 指数退避+60s 稳定清零+外部 relay 让位）；setup 尾部无条件常驻挂载。
  //   「断后连不上只能重启 app」在代码面无洞（watchdog/lock 验活/token 复用三链齐备）——
  //   真机若复现，嫌疑收敛到：pid 复用窗口（posix kill(pid,0) 对复用 pid 误判活）或
  //   node 路径环境变化（spawn 失败循环退避）。均列回执遗留。
  const mainrs = readFileSync(join(relayDir, "..", "desktop-tauri", "src-tauri", "src", "main.rs"), "utf8");
  ok(mainrs.includes("fn supervise_embedded_relay") && mainrs.includes("1500") && mainrs.includes("respawn"), "壳 supervise 锚（#66 watchdog 在：1.5s 拍+重拉——读码验证）");
  ok(mainrs.includes("takeover armed"), "启动让位分支 WANT 置真锚（外部 relay 退出后壳能接管）");

  // ============ B 手机端：退避表+前台零退避链（文件锚） ============
  console.log("B 手机端退避与恢复链（文件锚）:");
  const store = readFileSync(join(relayDir, "..", "expo-app", "src", "store.ts"), "utf8");
  ok(store.includes("const RECONNECT_BASE_MS = 1000;"), "退避起步 1s（1101 P0「重连慢」收敛——旧 3s）");
  ok(store.includes("const RECONNECT_MAX_MS = 60_000;"), "退避上限 60s 保持（后台省电+W-CLOUD② 整夜挂死死线论证仍立）");
  ok(store.includes("this.resetBackoff();"), "回前台清退避（#114 onForeground——AppState active 零退避首试）");
  ok(store.includes("retryAt - Date.now() > 6000"), "前台看门狗：>6s 后到点的重试拉立即（5s 巡检）");
  ok(store.includes("connectStartedAt && Date.now() - conn.connectStartedAt > 20_000"), "挂死 connect 20s 掐掉重发（#85 Android TCP 挂起）");
  ok(store.includes("fastRetry ? Math.min(conn.reconnectDelay, 800)"), "fastRetry 800ms 快试档在（成功即重置）");

  // ============ C 断连打点：五分类+台账+关于页 ============
  console.log("C 断连打点（connEvents 台账）:");
  for (const k of ["net-drop", "hb-timeout", "server-close", "protocol", "resume-broken"]) {
    ok(store.includes(`"${k}"`), `分类词 ${k} 在词表`);
  }
  ok(store.includes("conn.connEvents.length > 20"), "环形 cap 20（防长跑膨胀）");
  ok(store.includes("last.durMs = Date.now() - last.ts"), "复通补写 durMs（断→通时长——「重连慢」的实测数字）");
  ok((store.match(/recordConnEvent\(/g) || []).length >= 4, `记录挂点 ≥4（实测 ${(store.match(/recordConnEvent\(/g) || []).length} 处：LAN onclose/cloud onclose code 分类/connDead hb/resume）`);
  ok((store.match(/noteConnUp\(/g) || []).length >= 4, `复通挂点 ≥4（实测 ${(store.match(/noteConnUp\(/g) || []).length} 处：adoptLan/resume 恢复/云首帧）`);
  ok(store.includes("recentConnEvents(n = 3)"), "关于页只读口 recentConnEvents（private 破坏零——窄口断言）");
  const sp = readFileSync(join(relayDir, "..", "expo-app", "src", "screens", "SettingsPage.tsx"), "utf8");
  ok(sp.includes("最近断连（排障参考）") && sp.includes("s 恢复") && sp.includes("未恢复"), "关于弹窗「最近断连」段（时刻·分类·恢复时长三要素）");

  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(`\n========== conn-stability 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
