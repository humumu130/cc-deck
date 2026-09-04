// Cloudflare 形态冒烟：起 `wrangler dev`（workerd 本地运行，不需要账号），
// 等健康检查就绪后跑与 Node 形态相同的 bridgeSmoke 协议断言。
import { spawn, execSync } from "node:child_process";
import { WebSocket } from "ws";
import { bridgeSmoke } from "../../cloud-bridge/scripts/smoke.js";

let failures = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
    process.exitCode = 1;
  } else {
    console.log(`ok - ${msg}`);
  }
}

const PORT = 8791;
const TOKEN = "changeme-cloudtoken"; // 与 wrangler.toml [vars] 保持一致
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// 残留的 wrangler dev / workerd 会占住端口或内部服务端口，导致新实例
// 挂起（实测 workerd 僵尸会让下一次 wrangler dev 卡在 Ready 之前）——先清场
function clearStale(): void {
  try {
    execSync("taskkill /IM workerd.exe /F", { shell: "cmd.exe", stdio: "ignore" });
  } catch {
    // 没有 workerd
  }
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='node.exe'\\" | Where-Object {$_.CommandLine -like '*wrangler*'} | Select-Object -ExpandProperty ProcessId"`,
      { encoding: "utf8" },
    );
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { shell: "cmd.exe", stdio: "ignore" });
      } catch {
        // 已退出
      }
    }
  } catch {
    // 无残留
  }
}
clearStale();

const proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
  cwd: root,
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
proc.stdout.on("data", (d) => process.stdout.write(`[wrangler] ${d}`));
proc.stderr.on("data", (d) => process.stderr.write(`[wrangler] ${d}`));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitHealthy(ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // 尚未就绪（或连接吊死，2s 超时重试）
    }
    await wait(300);
  }
  return false;
}

// Windows 上 shell:true 时 proc.kill 只杀 cmd 壳，必须 taskkill 整个进程树
async function killTree(): Promise<void> {
  if (process.platform !== "win32" || !proc.pid) {
    proc.kill("SIGTERM");
    return;
  }
  await new Promise<void>((resolve) => {
    const tk = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
    tk.on("close", () => resolve());
    setTimeout(resolve, 5000);
  });
  clearStale();
}

// 看门狗：无论如何 3 分钟内退出，避免 wrangler 卡住拖死测试
const watchdog = setTimeout(() => {
  console.error("TIMEOUT: 测试超时");
  void killTree().then(() => process.exit(2));
}, 180_000);
watchdog.unref?.();
process.on("exit", () => void killTree());

try {
  assert(await waitHealthy(), "wrangler dev 就绪");
  await bridgeSmoke(`ws://127.0.0.1:${PORT}`, TOKEN, assert);

  // 轮询传输的发现帧（现实拓扑：relay 走 ws 上报 rk，浏览器被代理掐 ws 时降级 poll）：
  // POST disc → 桥回 RELAYS 入 poll 队列 → GET 取回，与 ws 路径行为一致
  {
    const base = `http://127.0.0.1:${PORT}`;
    const rw = new WebSocket(`ws://127.0.0.1:${PORT}/cloud?token=${TOKEN}&dev=rl-pollt&rk=RkPollRelay1`);
    const opened = await new Promise<boolean>((r) => {
      rw.on("open", () => r(true));
      rw.on("error", () => r(false));
    });
    assert(opened, "poll 发现帧: relay ws 连接（带 rk）");
    const sid = "poll-disc-wb";
    const p = await fetch(`${base}/cloud-poll?token=${TOKEN}&dev=wb-pollt&sid=${sid}`, {
      method: "POST",
      body: JSON.stringify({ to: "*", data: { t: "disc" } }),
    });
    assert(p.ok, "poll 发现帧: disc POST 成功");
    const g = await fetch(`${base}/cloud-poll?token=${TOKEN}&dev=wb-pollt&sid=${sid}&wait=3`);
    const out = (await g.json()) as { frames?: string[] };
    const relaysFrame = (out.frames || [])
      .map((x) => {
        try {
          return JSON.parse(x) as { type?: string; relays?: { dev: string; rk: string }[] };
        } catch {
          return null;
        }
      })
      .find((x) => x && x.type === "RELAYS");
    assert(!!relaysFrame, "poll 发现帧: GET 收到 RELAYS");
    assert(
      !!relaysFrame?.relays?.some((x) => x.dev === "rl-pollt" && x.rk === "RkPollRelay1"),
      "poll 发现帧: RELAYS 带 relay 公钥",
    );
    rw.close();
  }
} finally {
  await killTree();
}

if (failures === 0) console.log("CLOUDFLARE BRIDGE TESTS PASSED");
else {
  console.error(`${failures} failures`);
  process.exit(1);
}
