import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
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

interface TestClient {
  ws: WebSocket;
  events: Envelope[];
  acks: CommandAckPayload[];
  opened: Promise<void>;
  closed: Promise<void>;
}

function connect(url: string): TestClient {
  const ws = new WebSocket(url);
  const c: TestClient = {
    ws,
    events: [],
    acks: [],
    opened: new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    }),
    closed: new Promise((res) => ws.once("close", res)),
  };
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Envelope | (CommandAckPayload & { type: string });
    if ((msg as { type?: string }).type === "COMMAND_ACK") c.acks.push(msg as CommandAckPayload);
    else c.events.push(msg as Envelope);
  });
  return c;
}

function send(c: TestClient, partial: Omit<Command, "command_id" | "ts">): string {
  const command_id = randomUUID();
  c.ws.send(JSON.stringify({ ...partial, command_id, ts: Date.now() }));
  return command_id;
}

// ---- 启动被测服务（独立端口，避免与 dev server 冲突） ----
process.env.CCR_PORT = "8799";
process.env.CCR_TOKEN = "test-token-123";
// #26 M1/M2 审查轮：/api/org HTTP 通道测试需要隔离组织目录（默认 ~/.cc-deck/org 绝不可碰）
const WS_ORG = fileURLToPath(new URL("../data/test-ws-org/", import.meta.url));
mkdirSync(WS_ORG, { recursive: true });
rmSync(WS_ORG, { recursive: true, force: true });
mkdirSync(WS_ORG, { recursive: true });
process.env.CCR_ORG_DIR = WS_ORG;
// 沙盒铁律：数据目录钉死仓库沙盒。本仓库的测试可能在「生产 relay 之子」的环境里跑
// （CCR_DATA_DIR/CC_DECK_PLUGIN/CCR_RELAY_CHILD 等生产 env 全套被继承），loadConfig
// 的 env 优先级会整包劫持数据落点——2026-09-28 事故实证：last-cwd/settings.json/
// child-sessions.json 落进生产 ~/.cc-deck/data，测试 CLI 的 transcript 进全局目录
const WS_DATA = fileURLToPath(new URL("../data/test-ws-data/", import.meta.url));
rmSync(WS_DATA, { recursive: true, force: true });
mkdirSync(WS_DATA, { recursive: true });
process.env.CCR_DATA_DIR = WS_DATA;
delete process.env.CC_DECK_PLUGIN; // 该分支的 dataDir 缺省同样指向 ~/.cc-deck/data
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR; // 防生产锁定 env 渗入（6b 会误走 env 只读分支）
process.env.CCR_CLOUD_URL = ""; // loadConfig 缺省会连公共云桥（快照外泄到公网桥）
process.env.CCR_NO_TITLE_GEN = "1"; // 拉真 CLI 但不拉起名子进程：titlegen 会另落一份全局 transcript
process.env.CCR_NO_BRIDGE_MIRROR = "1"; // 防御性：当前 in-process 无 onReady 镜像，防未来演进踩同坑
// 孤儿扫描用空临时根，防止测试扫到真实 ~/.claude/projects
process.env.CCR_PROJECTS_ROOT = fileURLToPath(new URL("../data/test-projects-ws/", import.meta.url));
// #67 COMMAND_CREATE 探针 cwd 用 .tmp- 沙箱：历史用 process.cwd()（仓库根），
// 真实 CLI 的 transcript 落全局 ~/.claude/projects 且无 .tmp- 段，被生产 relay
// 孤儿扫描收养成一排「relay」卡（journal 回放永久复活）。沙箱 cwd 让 transcript
// 自带 .tmp- 段被护栏跳过（同 test-sessions/.tmp-test 惯例）
const PROBE_CWD = fileURLToPath(new URL("../data/.tmp-test-ws/", import.meta.url));
mkdirSync(PROBE_CWD, { recursive: true });
const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
startServer(bus, mgr, cfg);
await wait(300);

const base = `ws://127.0.0.1:${cfg.port}/ws`;

// 0. 服务真的在监听（防止连接拒绝被误判为鉴权通过）
const health = await fetch(`http://127.0.0.1:${cfg.port}/health`);
assert(health.ok, `server listening (health ${health.status})`);

// 1. 错误 token → 连接被拒（401）
let rejected = false;
try {
  const bad = connect(`${base}?token=WRONG`);
  await bad.opened;
  await bad.closed; // 若意外连上也应很快被关
  rejected = true; // 连接后立即关闭也算通过（这里 open 就不该成功）
} catch {
  rejected = true;
}
assert(rejected, "wrong token rejected");

// 2. 正确 token 连接 → 收到 SNAPSHOT（当前无会话）
const c1 = connect(`${base}?token=${cfg.token}`);
await c1.opened;
await wait(300);
assert(c1.events.length === 1 && c1.events[0].type === "SNAPSHOT", "fresh client gets SNAPSHOT");
assert(
  (c1.events[0].payload as { sessions: unknown[] }).sessions.length === 0,
  "snapshot empty initially",
);

// 3. 创建一个真实会话（纯文本快速完成）
const createId = send(c1, {
  type: "COMMAND_CREATE",
  payload: { cwd: PROBE_CWD, prompt: "请直接回复两个字：收到。禁止使用任何工具。" },
});
let sessionId = "";
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  const ack = c1.acks.find((a) => a.command_id === createId);
  if (ack?.session_id) sessionId = ack.session_id;
  const done = c1.events.find(
    (e) => e.session_id === sessionId && e.type === "SESSION_DONE",
  );
  if (done) break;
  await wait(500);
}
assert(sessionId !== "", "COMMAND_CREATE acked with session_id");
assert(
  c1.events.some((e) => e.session_id === sessionId && e.type === "SESSION_CREATED"),
  "c1 saw SESSION_CREATED live",
);
assert(
  c1.events.some((e) => e.session_id === sessionId && e.type === "SESSION_DONE"),
  "c1 saw SESSION_DONE live",
);
const lastSeq = c1.events[c1.events.length - 1].seq;
assert(lastSeq >= 3, `seq progressed (last=${lastSeq})`);

// 4. 重连补发：第二个客户端带 last_seq=1 → 只收 seq>1，连续无丢失
const c2 = connect(`${base}?token=${cfg.token}&last_seq=1`);
await c2.opened;
await wait(500);
assert(!c2.events.some((e) => e.seq <= 1), "replayed events all seq>1");
const seqs = c2.events.map((e) => e.seq).sort((a, b) => a - b);
assert(
  seqs.length > 0 && seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1),
  `replay contiguous from 2 to ${seqs[seqs.length - 1] ?? "?"}`,
);
assert(
  c2.events.some((e) => e.type === "SESSION_DONE" && e.session_id === sessionId),
  "replay contains missed SESSION_DONE",
);

// 5. 幂等：同 command_id 重发 → ack duplicate
const dupId = randomUUID();
c1.ws.send(JSON.stringify({ type: "COMMAND_MESSAGE", command_id: dupId, ts: Date.now(), payload: { session_id: sessionId, text: "x" } }));
c1.ws.send(JSON.stringify({ type: "COMMAND_MESSAGE", command_id: dupId, ts: Date.now(), payload: { session_id: sessionId, text: "x" } }));
await wait(500);
const dupAcks = c1.acks.filter((a) => a.command_id === dupId);
assert(dupAcks.length === 2, "both duplicate sends acked");
// #65：首次回执无标记，幂等重放带 duplicate:true（此前原样回放，两帧无差别可断）
assert(
  dupAcks.some((a) => a.duplicate === true) && dupAcks.some((a) => !a.duplicate),
  "duplicate command_id replayed with duplicate mark (first ack unmarked)",
);

// 6. 非法消息 → 错误 ack 且连接不掉
c1.ws.send("not json");
c1.ws.send(JSON.stringify({ type: "COMMAND_UNKNOWN", command_id: randomUUID(), ts: 1, payload: {} }));
await wait(300);
assert(c1.ws.readyState === WebSocket.OPEN, "connection survives invalid messages");
assert(
  c1.acks.some((a) => a.ok === false),
  "invalid message got error ack",
);

// 6b. #17 第二批补强：SNAPSHOT.settings 形状 + 开关热切换双端收敛 + 幂等重发 +
//     非布尔拒收（状态无关：读现值→翻转→还原，仓库本地 data 目录已 gitignore）。
//     本套件 in-process 起服不跑 index.ts 物化 → 快照可能停在 default 层——恰好
//     补上 default 形态；真启动的 file/env 两形态由 test-settings-ws 锁
{
  type St = { employee_home?: unknown; value?: unknown; source?: unknown };
  const st0 = (c1.events[0].payload as { settings?: St }).settings;
  assert(
    !!st0 && typeof st0.employee_home === "boolean"
      && (st0.value === null || typeof st0.value === "string")
      && (st0.source === "env" || st0.source === "file" || st0.source === "default"),
    `SNAPSHOT.settings 形状（布尔 + value null|字符串 + source 三态）got=${JSON.stringify(st0)}`,
  );
  const cur = (st0 as St).employee_home as boolean;
  const countUpd = () => c2.events.filter((e) => e.type === "SETTINGS_UPDATED").length;
  const before = countUpd();

  // 热切换到反值：ack 带最新状态（file 层）→ c2 秒收同值瞬态帧（seq=0）
  const fid = send(c1, { type: "COMMAND_SETTINGS_UPDATE", payload: { employee_home: !cur } });
  let fack: CommandAckPayload | undefined;
  for (let i = 0; i < 30 && !fack; i++) {
    fack = c1.acks.find((a) => a.command_id === fid);
    if (!fack) await wait(100);
  }
  const fd = (fack as unknown as { data?: St } | undefined)?.data;
  assert(
    fack?.ok === true && fd?.employee_home === !cur && fd?.source === "file",
    `热切换 ack 携带最新状态（file 层）got=${JSON.stringify(fack)}`,
  );
  await wait(400);
  const flips = c2.events.filter((e) => e.type === "SETTINGS_UPDATED");
  assert(
    flips.length === before + 1
      && (flips[flips.length - 1].payload as St).employee_home === !cur
      && flips[flips.length - 1].seq === 0,
    "他端同连接秒收 SETTINGS_UPDATED（瞬态 seq=0）",
  );
  const afterFlip = countUpd();

  // 幂等：同 command_id 双发 → 第二个 ack duplicate:true；重放不重复广播
  //（首发与现值相同仍执行 → 恰好多一条广播）
  const dupId = randomUUID();
  const frame = JSON.stringify({ type: "COMMAND_SETTINGS_UPDATE", command_id: dupId, ts: Date.now(), payload: { employee_home: !cur } });
  c1.ws.send(frame);
  c1.ws.send(frame);
  for (let i = 0; i < 30 && c1.acks.filter((a) => a.command_id === dupId).length < 2; i++) await wait(100);
  const dacks = c1.acks.filter((a) => a.command_id === dupId);
  assert(dacks.length === 2 && dacks.some((a) => a.duplicate === true), "同 command_id 重发 → duplicate 幂等标记");
  await wait(300);
  assert(countUpd() === afterFlip + 1, "幂等重放只执行一次（重发不再广播）");

  // 非布尔载荷拒收（防缺键/字符串静默落 false 关掉开关）+ 不广播
  // 故意发非布尔（类型绕行：被测行为就是协议层拒收畸形载荷）
  const bid = send(c1, { type: "COMMAND_SETTINGS_UPDATE", payload: { employee_home: "true" } as unknown as Command["payload"] });
  for (let i = 0; i < 30 && !c1.acks.some((a) => a.command_id === bid); i++) await wait(100);
  const back = c1.acks.find((a) => a.command_id === bid);
  assert(back?.ok === false && /布尔/.test(back?.error ?? ""), `非布尔载荷拒收 got=${JSON.stringify(back)}`);
  await wait(300);
  assert(countUpd() === afterFlip + 1, "拒收不广播");

  // 还原现值（收尾零残留）+ 落盘核对
  const rid = send(c1, { type: "COMMAND_SETTINGS_UPDATE", payload: { employee_home: cur } });
  for (let i = 0; i < 30 && !c1.acks.some((a) => a.command_id === rid); i++) await wait(100);
  const rack = c1.acks.find((a) => a.command_id === rid);
  const rd = (rack as unknown as { data?: St } | undefined)?.data;
  assert(rack?.ok === true && rd?.employee_home === cur, "切回原值 ack 确认");
  await wait(300);
  assert(readSettingsFile(cfg.dataDir)?.employeeHome === cur, "settings.json 落盘与还原值一致");
}

// 7. #26 M1/M2 审查轮：/api/org HTTP 通道——鉴权 + 决议动作白名单（confirm-decide
//    不开放 HTTP：读过 token 的进程不得自批确认卡，决议只走 WS COMMAND_ORG_CONFIRM）
const orgBase = `http://127.0.0.1:${cfg.port}/api/org`;
const noTok = await fetch(orgBase, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "status" }) });
assert(noTok.status === 401, "/api/org 无 token → 401");
const decide = await fetch(`${orgBase}?token=${cfg.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "confirm-decide", confirm_id: "cf-x", approve: true }) });
assert(decide.status === 403, "/api/org confirm-decide → 403（决议面不开放 HTTP）");
assert(((await decide.json()) as { ok: boolean }).ok === false, "拒收回 ok:false");
const stat = await fetch(`${orgBase}?token=${cfg.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "status" }) });
assert(stat.status === 200 && ((await stat.json()) as { ok: boolean }).ok === true, "/api/org status 放行（提案面）");
rmSync(WS_ORG, { recursive: true, force: true });

// 清理：STOP 会话 + 关闭
send(c1, { type: "COMMAND_STOP", payload: { session_id: sessionId } });
await wait(2000);
c1.ws.close();
c2.ws.close();
await wait(500);

// 全局 transcript 收尾：真 CLI 的 transcript 落 ~/.claude/projects/<cwd-slug>/，
// 该 slug 只可能是本测试探针会话（.tmp-test-ws 唯一名）——删净不留测试残渣，
// 用户可见会话列表零污染（2026-09-28 事故后补的纪律）
try {
  const projs = join(homedir(), ".claude", "projects");
  for (const n of readdirSync(projs)) {
    if (n.endsWith("-tmp-test-ws")) rmSync(join(projs, n), { recursive: true, force: true });
  }
} catch {} // 目录不存在/权限异常不阻塞测试结论

console.log("\nWS TESTS PASSED");
process.exit(0);
