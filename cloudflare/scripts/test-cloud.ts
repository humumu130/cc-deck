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
  // POST disc → 桥回 RELAYS 入 poll 队列 → GET 取回，与 ws 路径行为一致。
  // #29（B-P0-1）：relay 身份须真实派生（桥侧 rl- 注册自洽校验，非派生 dev/rk 被拒）
  {
    const base = `http://127.0.0.1:${PORT}`;
    const rkPoll = Buffer.alloc(32, 3).toString("base64");
    const devPoll = "rl-" + [...Buffer.from(rkPoll, "base64").subarray(0, 8)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const rw = new WebSocket(`ws://127.0.0.1:${PORT}/cloud?token=${TOKEN}&dev=${devPoll}&rk=${encodeURIComponent(rkPoll)}`);
    const opened = await new Promise<boolean>((r) => {
      rw.on("open", () => r(true));
      rw.on("error", () => r(false));
    });
    assert(opened, "poll 发现帧: relay ws 连接（带 rk）");

    // #29（B-P2 poll 顶替守卫）：dev 已有活跃 WebSocket 时新建 poll 会话回 409，
    // 且既有 WS 不被踢——否则持 token 者 POST 猜中 dev 即可免费踢任意在线设备。
    // 注意威胁模型：rk=公钥是公开信息（RELAYS 帧下发），外层 rl- 自洽校验挡不住
    // 持公开 rk 者（自洽天然成立），DO 层 409 才是这道门——hijack 须带真 rk 模拟
    const hijack = await fetch(
      `${base}/cloud-poll?token=${TOKEN}&dev=${devPoll}&sid=poll-hijack&rk=${encodeURIComponent(rkPoll)}`,
      { method: "POST", body: JSON.stringify({ to: "*", data: { t: "hb" } }) },
    );
    assert(hijack.status === 409, "poll 顶替守卫: 有 WS 在线的 dev 拒新建 poll（409）");
    await new Promise((r) => setTimeout(r, 300));
    assert(rw.readyState === WebSocket.OPEN, "poll 顶替守卫: 既有 WS 连接未被 poll 创建踢掉");

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
      !!relaysFrame?.relays?.some((x) => x.dev === devPoll && x.rk === rkPoll),
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
