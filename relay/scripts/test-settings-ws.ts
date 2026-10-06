// #17 第二批补强（任务 #18）：雇员独立家设置 ws 协议**真启动形态**锁。
// 与 test-settings.ts（纯函数层）互补，这里锁「客户端在协议上看到什么」——
// 子进程拉起真 relay（tsx src/index.ts）：新装首启物化在 index.ts 启动序里，
// in-process 起服（loadConfig + startServer）走不到，必须真启动。
//
// 三块各起各停（端口 8801/8802/8803，startServer 进程退出即释放）：
//   A 新装（8801）：空数据目录 → SNAPSHOT {employee_home:true, source:"file",
//     value=<dataDir>/claude-home}（默认开 + 首启物化）+ settings.json 落盘
//   B 存量（8802）：预写 token 文件 → 默认关；双端收敛（c2 先连，c1 切换 c2 秒收
//     SETTINGS_UPDATED 瞬态帧 seq=0）+ ack 携带最新状态 + 帧序（广播先于 ACK，
//     客户端超时分流依赖此保证）+ 开/关双方向 + 落盘 + 非布尔拒收 + 幂等重发
//   C env 锁定（8803）：CCR_EMPLOYEE_CONFIG_DIR 显式路径 → SNAPSHOT source=env +
//     切换被拒（可读中文错误）+ 不广播 + 不物化
//
// 环境铁律：CCR_CLOUD_URL 置空串（loadConfig 缺省会连公共云桥！）；全部目录走
// mkdtemp 临时（绝不碰 ~/.cc-deck 与仓库 relay/data）；CCR_NO_LEADER=1（不设则
// index.ts 启动序 ensureLeader 无锚即真拉 Leader CLI——「全程不拉真 CLI」由该开关
// 保证而非碰巧）；CCR_NO_MDNS=1（不往局域网广播幽灵实例）；继承的生产 env
// （CCR_PARENT_PID/CCR_EMPLOYEE_CONFIG_DIR 等）在 bootRelay 剥净。CI 可跑（无凭据
// 依赖）。进程退出兜底 SIGKILL 全部子进程（含 SIGINT/SIGTERM 信号路径转发）。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { readSettingsFile } from "../src/settings.js";
import type { Command, CommandAckPayload, Envelope } from "../src/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SNAPSHOT.settings / SETTINGS_UPDATED / ack.data 三处同形（EmployeeHomeSettingsPayload）
interface EmpSt {
  employee_home: boolean;
  value: string | null;
  source: "env" | "file" | "default";
}

interface TestClient {
  ws: WebSocket;
  events: Envelope[];
  acks: CommandAckPayload[];
  order: string[]; // 同连接接收序（evt:*/ack:*）——帧序断言用
  opened: Promise<void>;
}

function connect(url: string): TestClient {
  const ws = new WebSocket(url);
  const c: TestClient = {
    ws,
    events: [],
    acks: [],
    order: [],
    opened: new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    }),
  };
  ws.on("message", (data) => {
    // 畸形帧不炸测试（#20 审查修正）：被测 relay 吐非 JSON 是值得报告的缺陷，记为
    // 事件流里一条 BAD_FRAME 让后续断言红出来，而非未捕获异常栈崩
    let msg: Envelope | (CommandAckPayload & { type: string });
    try {
      msg = JSON.parse(String(data)) as Envelope | (CommandAckPayload & { type: string });
    } catch {
      c.events.push({ type: "BAD_FRAME", payload: { raw: String(data).slice(0, 200) }, seq: -1, ts: Date.now(), session_id: "" } as unknown as Envelope);
      return;
    }
    if ((msg as { type?: string }).type === "COMMAND_ACK") {
      c.acks.push(msg as CommandAckPayload);
      c.order.push(`ack:${(msg as CommandAckPayload).command_id}`);
    } else {
      const env = msg as Envelope;
      c.events.push(env);
      c.order.push(`evt:${env.type}`);
    }
  });
  return c;
}

function send(c: TestClient, partial: Omit<Command, "command_id" | "ts">): string {
  const command_id = randomUUID();
  c.ws.send(JSON.stringify({ ...partial, command_id, ts: Date.now() }));
  return command_id;
}

async function waitAck(c: TestClient, id: string, ms = 5000): Promise<CommandAckPayload | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const a = c.acks.find((x) => x.command_id === id);
    if (a) return a;
    await wait(100);
  }
  return null;
}

// 等同一 command_id 的 n 个回执（幂等重发双 ack 场景——两次 waitAck 会同时命中首个）
async function waitAcks(c: TestClient, id: string, n: number, ms = 5000): Promise<CommandAckPayload[]> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = c.acks.filter((x) => x.command_id === id);
    if (list.length >= n) return list;
    await wait(100);
  }
  return c.acks.filter((x) => x.command_id === id);
}

// ack.data 取值（CommandAckPayload.data 形状按命令而异，这里按 EmpSt 收窄）
function ackData(a: CommandAckPayload | null): EmpSt | undefined {
  return (a as unknown as { data?: EmpSt } | null)?.data;
}

// ---------- 子进程真 relay（启动序含物化；in-process 到不了这段代码） ----------

const RELAY_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = join(RELAY_DIR, "node_modules", "tsx", "dist", "cli.mjs");

const live = new Set<ChildProcess>();
// 退出兜底：断言失败 process.exit(1) 时孤儿子进程一并带走（组级 SIGKILL 保证端口
// 释放——tsx cli 会 respawn 真 node 孙进程，只杀 wrapper 死不干净，孙进程会被
// launchd 收养继续占端口，下一轮假就绪打到别人身上）
process.on("exit", () => {
  for (const ch of live) {
    try {
      process.kill(-(ch.pid as number), "SIGKILL");
    } catch {
      try {
        ch.kill("SIGKILL");
      } catch {}
    }
  }
});
// 信号路径兜底（#20 审查修正）：Node 对默认处置的 SIGINT/SIGTERM 直接终止、不跑
// exit 钩子；relay 又是 detached 独立进程组不随父收信号——Ctrl-C / CI 取消会留下
// 3 个孤儿 relay 占 8801-8803，下轮端口预检拒跑。转发 exit 让上面的兜底执行
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => process.exit(1));
}

async function bootRelay(block: string, port: number, dataDir: string, envExtra: Record<string, string>): Promise<{ child: ChildProcess; token: string; log: () => string }> {
  // 端口预检：上轮泄漏的残留 relay 会让本轮子进程 EADDRINUSE 崩掉、health 轮询却
  // 被孤儿应答（假就绪）——断言全打到别人的 relay 上，先拒绝起测
  try {
    const pre = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (pre.ok) {
      console.error(`[${block}] 端口 ${port} 已有监听（残留 relay？），先清理再跑`);
      process.exit(1);
    }
  } catch {}
  // 环境基座（#20 审查修正）：裸透传 process.env 会把「生产 relay 之子」的全套继承
  // env 带进测试 relay——本套件防的正是这类环境（2026-09-28 事故同款）：
  // CCR_PARENT_PID 继承 → index.ts 看门狗 3s 探活 stale pid 即 exit(0)，relay 中途
  // 自杀表现为偶发「提前退出/waitAck 超时」；CCR_EMPLOYEE_CONFIG_DIR 继承 → A/B 的
  // source=file 断言整组假失败；CC_DECK_PLUGIN 改 dataDir 缺省落点。剥净再钉测试值
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.CCR_PARENT_PID;
  delete env.CCR_RELAY_CHILD;
  delete env.CC_DECK_PLUGIN;
  delete env.CCR_EMPLOYEE_CONFIG_DIR; // C 块 envExtra 显式再设（env 锁定态用例不受影响）
  // 用户级表面隔离（#20 P1）：真启动 index.ts ×3，onReady 的 ensureTodoToolsEnv 会
  // 幂等补写 ~/.claude/settings.json（键缺失时）——钉不存在的临时路径让它走
  // skip-no-dir 零写盘（目录勿预建；test-bridge 的 CLAUDE_CONFIG_DIR 先例同款）
  env.CLAUDE_CONFIG_DIR = join(dataDir, "claude-cfg");
  const child = spawn(process.execPath, [TSX_CLI, "src/index.ts"], {
    cwd: RELAY_DIR,
    detached: true, // 独立进程组：负 pid 信号可整组收干净（wrapper + tsx 孙进程）
    env: {
      ...env,
      CCR_PORT: String(port),
      CCR_TOKEN: `test-token-${port}`,
      CCR_DATA_DIR: dataDir,
      CCR_ORG_DIR: join(dataDir, "org"),
      CCR_ORG_BIN_DIR: join(dataDir, "bin"),
      CCR_PROJECTS_ROOT: join(dataDir, "projects-root"),
      CCR_CLOUD_URL: "", // 禁云桥：loadConfig 缺省连公共桥，测试绝不能摸真桥
      CCR_NO_TITLE_GEN: "1",
      // 禁 bridge.json 生产镜像（index.ts #211 换班镜像）：CCR_DATA_DIR 已钉临时目录，
      // 但镜像条件只看「dataDir≠hookHome 且 hookHome 存在」——不关会把测试端口/一次性
      // token 写进 ~/.cc-deck/data/bridge.json，测试一收生产 hook 全域失联
      CCR_NO_BRIDGE_MIRROR: "1",
      // 禁 Leader（ensureLeader 无锚即 spawn 真 CLI，口径 ==="1"）：本套件测设置项
      // 不测团队——不关则 A 块每轮都在沙盒 org 里真拉一个 Leader 上岗回合
      //（2026-09-28 expo 沙盒实锤同款路径；此前只是恰好被沙盒 containment 圈住
      // 没伤生产，会话本身是真烧）
      CCR_NO_LEADER: "1",
      // 禁 mDNS 广播（#20 审查修正）：否则每轮往局域网发 3 个同名幽灵 relay
      CCR_NO_MDNS: "1",
      ...envExtra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.add(child);
  let out = "";
  child.stdout?.on("data", (d) => (out += String(d)));
  child.stderr?.on("data", (d) => (out += String(d)));
  child.once("error", (e) => {
    console.error(`[${block}] relay spawn 失败: ${e.message}`);
    process.exit(1);
  });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`[${block}] relay 提前退出 code=${child.exitCode}\n${out}`);
      process.exit(1);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { child, token: `test-token-${port}`, log: () => out };
    } catch {}
    await wait(200);
  }
  console.error(`[${block}] health 就绪超时\n${out}`);
  process.exit(1);
}

async function shutdown(child: ChildProcess): Promise<void> {
  live.delete(child);
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  // 组级信号：SIGTERM 给 index.ts 优雅收尾（wrapper 同时收到即退）；3s 兜底组级
  // SIGKILL——单杀 wrapper 只会留下被收养的孙进程（8802 泄漏事故实证）
  try {
    process.kill(-(child.pid as number), "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode !== null) return; // 已退出：pid 可能已被 OS 复用，勿误杀无关进程组
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, 3000);
  await exited;
  clearTimeout(killTimer);
}

function snapshotSettings(c: TestClient): EmpSt | undefined {
  const snap = c.events.find((e) => e.type === "SNAPSHOT");
  return (snap?.payload as { settings?: EmpSt } | undefined)?.settings;
}

// ---------- Block A：新装默认开 + 首启物化（8801） ----------
{
  const DATA = mkdtempSync(join(tmpdir(), "ccr-setws-a-"));
  const r = await bootRelay("A 新装", 8801, DATA, {});
  try {
    const c = connect(`ws://127.0.0.1:8801/ws?token=${r.token}`);
    await c.opened;
    await wait(400);
    const st = snapshotSettings(c);
    assert(
      !!st && st.employee_home === true && st.source === "file" && st.value === join(DATA, "claude-home"),
      `A: 新装 SNAPSHOT 默认开 + 首启物化（source=file 非 default，防 SNAPSHOT 振荡）got=${JSON.stringify(st)}`,
    );
    assert(readSettingsFile(DATA)?.employeeHome === true, "A: 物化落盘 settings.json employeeHome=true");
    c.ws.close();
  } finally {
    await shutdown(r.child);
    rmSync(DATA, { recursive: true, force: true });
  }
}

// ---------- Block B：存量默认关 + 双端收敛 + 帧序 + 幂等 + 拒收（8802） ----------
{
  const DATA = mkdtempSync(join(tmpdir(), "ccr-setws-b-"));
  // 存量形态：token 文件已存在（isFreshInstall 先于首启落盘判 false）；
  // CCR_TOKEN 置空串 → loadConfig 不采信 env，读该文件做连接令牌
  const LEGACY_TOKEN = "legacy-token-8802";
  writeFileSync(join(DATA, "token"), LEGACY_TOKEN, "utf-8");
  const r = await bootRelay("B 存量", 8802, DATA, { CCR_TOKEN: "" });
  const token = LEGACY_TOKEN;
  try {
    const base = `ws://127.0.0.1:8802/ws?token=${token}`;
    const c2 = connect(base); // 「他端」先连（验收点 3 的协议基底：他端切换本端秒收）
    await c2.opened;
    await wait(400);
    const st0 = snapshotSettings(c2);
    assert(
      !!st0 && st0.employee_home === false && st0.source === "file" && st0.value === null,
      `B: 存量 SNAPSHOT 默认关（物化后 source=file，value=null）got=${JSON.stringify(st0)}`,
    );
    const c1 = connect(base);
    await c1.opened;
    await wait(200);

    // 切开：ack 带最新状态；c2 秒收同值瞬态帧；帧序 = 广播先于 ACK（同连接序）
    const idOn = send(c1, { type: "COMMAND_SETTINGS_UPDATE", payload: { employee_home: true } });
    const ackOn = await waitAck(c1, idOn);
    const dOn = ackData(ackOn);
    assert(
      ackOn?.ok === true && dOn?.employee_home === true && dOn?.source === "file" && dOn?.value === join(DATA, "claude-home"),
      `B: 切开 ack 携带最新状态 got=${JSON.stringify(ackOn)}`,
    );
    await wait(400);
    const updOn = c2.events.filter((e) => e.type === "SETTINGS_UPDATED");
    assert(
      updOn.length === 1 && (updOn[0].payload as EmpSt).employee_home === true && updOn[0].seq === 0,
      "B: 他端秒收 SETTINGS_UPDATED（瞬态 seq=0，覆盖式同源收敛）",
    );
    const iUpd = c1.order.indexOf("evt:SETTINGS_UPDATED");
    const iAck = c1.order.indexOf(`ack:${idOn}`);
    assert(iUpd >= 0 && iAck >= 0 && iUpd < iAck, "B: 帧序——SETTINGS_UPDATED 广播先于 COMMAND_ACK（客户端超时分流依赖）");
    assert(readSettingsFile(DATA)?.employeeHome === true, "B: 切开落盘 settings.json true");

    // 切回（false 方向 + value 归 null）
    const idOff = send(c1, { type: "COMMAND_SETTINGS_UPDATE", payload: { employee_home: false } });
    const ackOff = await waitAck(c1, idOff);
    const dOff = ackData(ackOff);
    assert(
      ackOff?.ok === true && dOff?.employee_home === false && dOff?.value === null && dOff?.source === "file",
      `B: 切回 ack {employee_home:false, value:null} got=${JSON.stringify(ackOff)}`,
    );
    await wait(400);
    const upds = c2.events.filter((e) => e.type === "SETTINGS_UPDATED");
    assert(upds.length === 2 && (upds[1].payload as EmpSt).employee_home === false, "B: 他端秒收回关广播");
    assert(readSettingsFile(DATA)?.employeeHome === false, "B: 切回落盘 false");

    // 幂等：同 command_id 重发 → 第二个 ack 带 duplicate:true，且不重复广播
    //（首发与现值相同也无 no-op 守卫 → 恰好多一条广播，共 3 条）
    const dupId = randomUUID();
    const frame = JSON.stringify({ type: "COMMAND_SETTINGS_UPDATE", command_id: dupId, ts: Date.now(), payload: { employee_home: false } });
    c1.ws.send(frame);
    c1.ws.send(frame);
    const dupAcks = await waitAcks(c1, dupId, 2);
    assert(dupAcks.length === 2 && dupAcks.some((a) => a.duplicate === true), "B: 同 command_id 重发 → duplicate 幂等标记（双 ack）");
    await wait(300);
    assert(
      c2.events.filter((e) => e.type === "SETTINGS_UPDATED").length === 3,
      "B: 幂等重放只执行一次（重发不再广播）",
    );

    // 非布尔载荷拒收（防缺键/字符串静默落 false 把开关关掉；类型绕行=被测行为本身）
    const idBad = send(c1, { type: "COMMAND_SETTINGS_UPDATE", payload: { employee_home: "true" } as unknown as Command["payload"] });
    const ackBad = await waitAck(c1, idBad);
    assert(ackBad?.ok === false && /布尔/.test(ackBad?.error ?? ""), `B: 非布尔载荷拒收 got=${JSON.stringify(ackBad)}`);
    assert(readSettingsFile(DATA)?.employeeHome === false, "B: 拒收不动盘上值");
    c1.ws.close();
    c2.ws.close();
  } finally {
    await shutdown(r.child);
    rmSync(DATA, { recursive: true, force: true });
  }
}

// ---------- Block C：env 锁定只读（8803） ----------
{
  const DATA = mkdtempSync(join(tmpdir(), "ccr-setws-c-"));
  const EMP_HOME = join(DATA, "locked-emp-home"); // 绝对路径（目录无需预建——spawn 时才用）
  const r = await bootRelay("C env 锁定", 8803, DATA, { CCR_EMPLOYEE_CONFIG_DIR: EMP_HOME });
  try {
    const c = connect(`ws://127.0.0.1:8803/ws?token=${r.token}`);
    await c.opened;
    await wait(400);
    const st = snapshotSettings(c);
    assert(
      !!st && st.source === "env" && st.employee_home === true && st.value === EMP_HOME,
      `C: env 锁定 SNAPSHOT {source:env, value=显式路径} got=${JSON.stringify(st)}`,
    );
    // 切换被拒：可读中文错误 + 不广播 + 不物化（env 层永不写 settings.json）
    const id = send(c, { type: "COMMAND_SETTINGS_UPDATE", payload: { employee_home: false } });
    const ack = await waitAck(c, id);
    assert(ack?.ok === false && /锁定/.test(ack?.error ?? ""), `C: 切换被拒（错误含「锁定」指引）got=${JSON.stringify(ack)}`);
    await wait(400);
    assert(c.events.every((e) => e.type !== "SETTINGS_UPDATED"), "C: 拒改不广播 SETTINGS_UPDATED");
    assert(!existsSync(join(DATA, "settings.json")), "C: env 层不物化（settings.json 不落盘）");
    c.ws.close();
  } finally {
    await shutdown(r.child);
    rmSync(DATA, { recursive: true, force: true });
  }
}

console.log("\nSETTINGS-WS TESTS PASSED");
process.exit(0);
