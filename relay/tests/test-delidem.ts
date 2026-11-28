// #265 会话删除幂等化 + 增量续传对账——断言套件。
// 两段：§S 真服务行为（EventBus+SessionManager+startServer 真链路，seed 会话免拉真 CLI，
// 惯例同 test-ws.ts / test-notify2.ts 的 (mgr as any).sessions.set）；
// §F 前端纯函数直跑 + 双端静态锚（范式同 test-session-slim.ts）。
// 覆盖（任务书口径：断言 ≥3 + PM 补充「快照不含某会话时前端卡消失」）：
//   S1 删不存在会话 → ok:true + SESSION_DELETED 广播（幂等根修）
//   S2 删运行中会话 → 仍拒绝（「会话运行中，不能删除」语义保持）
//   S3 last_seq 快路径重连 → 收 SESSIONS_RECONCILE（在线 id 全集；瞬态 seq:0 唯一一帧）
//   S4 已删会话重连不复活（对账帧集合不含已删/幽灵 sid）
//   F1 web onReconcile 直跑：集合外同源卡清除 + #B3-3 历史桶/草稿回收 + 他源卡不误伤
//   F2 web 删除 ACK「会话不存在」→ 本地照样清卡（老 relay 兼容窗，静态锚）
//   F3 expo store 对账 case + COMMAND_DELETE 失败 ACK 兜底（静态锚）
//   F4 relay 静态锚（COMMAND_DELETE 弃 require / deleteSession 缺席广播 / 三出口补发）
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:delidem
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/ws-server.js";
import type { Command, CommandAckPayload, Envelope } from "../src/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ============================== §S 真服务行为 ==============================
process.env.CCR_PORT = "8814";
process.env.CCR_TOKEN = "test-token-delidem";
// 沙盒铁律（同 test-ws.ts）：组织/数据/项目根全钉仓库沙盒，防生产 env 渗入
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
for (const dir of ["../data/test-delidem-org/", "../data/test-delidem-data/", "../data/test-delidem-projects/"]) {
  rmSync(SB(dir), { recursive: true, force: true });
  mkdirSync(SB(dir), { recursive: true });
}
process.env.CCR_ORG_DIR = SB("../data/test-delidem-org/");
process.env.CCR_DATA_DIR = SB("../data/test-delidem-data/");
process.env.CCR_PROJECTS_ROOT = SB("../data/test-delidem-projects/");
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_PARENT_PID;
delete process.env.CCR_RELAY_CHILD;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = "";
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_NO_BRIDGE_MIRROR = "1";

const cfg = loadConfig();
const bus = new EventBus();
const mgr = new SessionManager(bus, cfg);
startServer(bus, mgr, cfg);
await wait(300);

// seed 两个会话：DONE 可删 + WORKING 拒删（免拉真 CLI，test-notify2 mk 同款最小形状）
function seed(id: string, status: "DONE" | "WORKING"): void {
  (mgr as unknown as { sessions: Map<string, unknown> }).sessions.set(id, {
    agent: null, logs: [], lastUpdateEmit: 0,
    lastProgressAt: Date.now(), lastProgressKind: "",
    unacked: [], wd: { phase: "idle", recoveries: [], gaveUp: false }, streamGen: 0, activitySeq: 0,
    state: {
      session_id: id, relay_session_id: `sdk-${id}`, external: false, status,
      title: id, started_at: Date.now() - 7_200_000, updated_at: Date.now(),
      engine: "claude", pinned: false, stats: {},
    },
  });
}
seed("delidem-done", "DONE");
seed("delidem-working", "WORKING");

interface TestClient { ws: WebSocket; events: Envelope[]; acks: CommandAckPayload[]; opened: Promise<void>; }
function connect(url: string): TestClient {
  const ws = new WebSocket(url);
  const c: TestClient = {
    ws, events: [], acks: [],
    opened: new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }),
  };
  ws.on("message", (data) => {
    let msg: Envelope | (CommandAckPayload & { type: string });
    try { msg = JSON.parse(String(data)) as Envelope | (CommandAckPayload & { type: string }); } catch { return; }
    if ((msg as { type?: string }).type === "COMMAND_ACK") c.acks.push(msg as CommandAckPayload);
    else c.events.push(msg as Envelope);
  });
  return c;
}
function send(c: TestClient, type: Command["type"], payload: Record<string, unknown>): string {
  const command_id = randomUUID();
  c.ws.send(JSON.stringify({ command_id, type, payload, ts: Date.now() } as Command)); // 测试面宽 payload（联合判别收窄交给运行时）
  return command_id;
}
const base = `ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`;

// -- S0 全新连接（无 last_seq）走全量 SNAPSHOT，不带对账帧（对账只属快路径）
const c1 = connect(base);
await c1.opened;
await wait(300);
const snap = c1.events.find((e) => e.type === "SNAPSHOT");
ok(!!snap, "S0 全新连接收到 SNAPSHOT");
ok(!c1.events.some((e) => e.type === "SESSIONS_RECONCILE"), "S0 全量路径不带对账帧（只在快路径补发）");
const snapIds = ((snap?.payload as { sessions?: { session_id: string }[] })?.sessions ?? []).map((s) => s.session_id);
ok(snapIds.includes("delidem-done") && snapIds.includes("delidem-working"), "S0 SNAPSHOT 含两个 seed 会话");

// -- S1 删不存在会话 → ok:true + SESSION_DELETED 广播（幂等根修；幽灵 sid=历史残留卡实况）
const ghostAckId = send(c1, "COMMAND_DELETE", { session_id: "delidem-ghost" });
await wait(300);
const ghostAck = c1.acks.find((a) => a.command_id === ghostAckId);
ok(!!ghostAck && ghostAck.ok === true, "S1 删不存在会话 → ok:true（目标不存在=删除已达成）");
ok(
  c1.events.some((e) => e.type === "SESSION_DELETED" && e.session_id === "delidem-ghost"),
  "S1 幂等删除照常广播 SESSION_DELETED（全端清卡信号）",
);

// -- S2 删运行中会话 → 仍拒绝（语义保持）
const runAckId = send(c1, "COMMAND_DELETE", { session_id: "delidem-working" });
await wait(300);
const runAck = c1.acks.find((a) => a.command_id === runAckId);
ok(!!runAck && runAck.ok === false && String(runAck.error).includes("会话运行中"), "S2 删运行中会话仍被拒");
ok(
  !c1.events.some((e) => e.type === "SESSION_DELETED" && e.session_id === "delidem-working"),
  "S2 运行中会话未发 SESSION_DELETED",
);

// -- S3 last_seq 快路径重连 → 收 SESSIONS_RECONCILE（在线 id 全集；瞬态 seq:0 不重复）
const seqNow = bus.lastSeq();
const c2 = connect(`${base}&last_seq=${seqNow}`);
await c2.opened;
await wait(300);
const rec2 = c2.events.filter((e) => e.type === "SESSIONS_RECONCILE");
ok(rec2.length === 1, `S3 快路径重连收对账帧（收到 ${rec2.length} 帧，瞬态不落缓冲不重放）`);
const recIds = (rec2[0]?.payload as { session_ids?: string[] })?.session_ids ?? [];
ok(recIds.includes("delidem-done") && recIds.includes("delidem-working"), "S3 对账帧含全部在线会话");
ok(!recIds.includes("delidem-ghost"), "S3 对账帧不含幽灵 sid");
ok(rec2[0]?.seq === 0, "S3 对账帧 seq:0（瞬态，不占事件序）");

// -- S4 正常删除后快路径重连 → 已删会话不在对账集合（WS 断线窗口删除→重连不复活）
const delAckId = send(c1, "COMMAND_DELETE", { session_id: "delidem-done" });
await wait(300);
const delAck = c1.acks.find((a) => a.command_id === delAckId);
ok(!!delAck && delAck.ok === true, "S4 正常删除仍 ok（在册会话删除路径不回归）");
const c3 = connect(`${base}&last_seq=${bus.lastSeq()}`);
await c3.opened;
await wait(300);
const rec3 = c3.events.filter((e) => e.type === "SESSIONS_RECONCILE");
ok(rec3.length === 1, "S4 二次快路径重连对账帧仍唯一（每次现算重发）");
const rec3Ids = (rec3[0]?.payload as { session_ids?: string[] })?.session_ids ?? [];
ok(!rec3Ids.includes("delidem-done") && !rec3Ids.includes("delidem-ghost"), "S4 已删/幽灵 sid 均不在对账集合（重连不复活）");
ok(rec3Ids.includes("delidem-working"), "S4 在册会话仍在集合（不误伤）");

console.log(`§S 服务端：${pass} ok / ${fail} FAIL`);
const serverFail = fail;
c1.ws.close(); c2.ws.close(); c3.ws.close();
await wait(150);
process.exitCode = 0;

// ============================== §F 前端直跑 + 静态锚 ==============================
pass = 0; fail = 0;
const sessionSrc = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
const storeSrc = readFileSync(join(root, "expo-app", "src", "store.ts"), "utf-8");
const relayCmdSrc = readFileSync(join(root, "relay", "src", "commands", "session-commands.ts"), "utf-8");
const relayMgrSrc = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
const wsSrvSrc = readFileSync(join(root, "relay", "src", "ws-server.ts"), "utf-8");
const cloudSrc = readFileSync(join(root, "relay", "src", "cloud-client.ts"), "utf-8");
const typesSrc = readFileSync(join(root, "relay", "src", "types.ts"), "utf-8");

function fnBody(src: string, name: string): string {
  // 双形态：`function name(` 与 TS 方法 `name(cmd...`（session-commands mixin 的
  // COMMAND_DELETE 是对象方法体，无 function 前缀）
  let i = src.indexOf(`function ${name}(`);
  if (i < 0) i = src.indexOf(`${name}(cmd`);
  if (i < 0) return "";
  const j = src.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return "";
}

// -- F1 web onReconcile/dropSessionLocal 直跑（同源清卡 + 历史桶回收 + 他源不误伤）
{
  const HIST_PREFIX = "cc.input.hist.";
  const ls = new Map<string, string>();
  const localStorage = { removeItem: (k: string) => { ls.delete(k); }, getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v); } };
  const S = {
    sessions: new Map<string, { session_id: string; relay_source?: string }>([
      ["a-live", { session_id: "a-live", relay_source: "r1" }],
      ["b-other", { session_id: "b-other", relay_source: "r2" }],   // 他源卡：不得误伤
      ["c-stale", { session_id: "c-stale", relay_source: "r1" }],   // 同源陈旧卡：应清
    ]),
    timelines: new Map([["c-stale", [{ id: 1 }]], ["b-other", [{ id: 2 }]]]),
    imgUrls: new Map([["c-stale/x", { url: "blob:z" }]]),
    selected: "c-stale",
  };
  const inputDrafts = new Map([["c-stale", "draft"], ["b-other", "keep"]]);
  for (const k of ["a-live", "b-other", "c-stale"]) ls.set(HIST_PREFIX + k, "[]");
  let renders = 0;
  const URL = { revokeObjectURL: (u: string) => { void u; } };
  const factory = new Function(
    "S", "HIST_PREFIX", "inputDrafts", "localStorage", "URL", "renderMyList", "renderAll",
    fnBody(sessionSrc, "dropSessionLocal") + "\n" + fnBody(sessionSrc, "onReconcile") + "\n return { dropSessionLocal, onReconcile };",
  );
  const api = factory(S, HIST_PREFIX, inputDrafts, localStorage, URL, () => { renders++; }, () => { renders++; });
  api.onReconcile({ session_ids: ["a-live"], relay_source: "r1" });
  ok(S.sessions.has("a-live"), "F1 在线会话保留");
  ok(S.sessions.has("b-other"), "F1 他源卡不误伤（relay_source 不匹配跳过）");
  ok(!S.sessions.has("c-stale"), "F1 同源集合外陈旧卡清除（PM 补充断言：快照不含 → 卡消失）");
  ok(!ls.has(HIST_PREFIX + "c-stale") && ls.has(HIST_PREFIX + "b-other"), "F1 #B3-3 输入历史桶随删回收（仅清被删 sid）");
  ok(!inputDrafts.has("c-stale") && inputDrafts.has("b-other"), "F1 #B3-4 草稿随删回收");
  ok(!S.timelines.has("c-stale") && S.timelines.has("b-other"), "F1 转录随删回收");
  ok(S.selected === "", "F1 选中态被清（选中卡被对账清除时）");
  ok(renders > 0, "F1 清卡后重渲");
  // 畸形帧防御：payload 非法不炸不清
  api.onReconcile(null as never);
  api.onReconcile({ session_ids: "not-array" } as never);
  ok(S.sessions.has("a-live") && S.sessions.has("b-other"), "F1 畸形对账帧防御（不炸不清）");
  // 全空集合（relay 无会话）：同源全清
  api.onReconcile({ session_ids: [], relay_source: "r2" });
  ok(!S.sessions.has("b-other"), "F1 空集合同源全清（relay 侧清空时端上跟清）");
}

// -- F2 web 删除 ACK「会话不存在」兜底（静态锚：两条删除路径同口径）
{
  const delRegion = (marker: string) => {
    const i = sessionSrc.indexOf(marker);
    return i < 0 ? "" : sessionSrc.slice(i, i + 900);
  };
  const r1 = delRegion('await commandAck("COMMAND_DELETE"');
  const r2 = delRegion('commandAck("COMMAND_DELETE"');
  ok(/会话不存在\/\.test\(v\.error\)/.test(r1) && /onDeleted\(s\.session_id\)/.test(r1), "F2 hover×/右键删除路径：不存在=清卡（onDeleted 全套）");
  ok(/会话不存在\/\.test\(v\.error\)/.test(r2) && /onDeleted\(s\.session_id\)/.test(r2), "F2 详情页删除路径：同口径兜底");
  ok(sessionSrc.includes('case "SESSIONS_RECONCILE": onReconcile(m.payload); break;'), "F2 handleFrame 对账帧分发接线");
}

// -- F3 expo store 锚（对账 case + COMMAND_DELETE 失败 ACK 兜底 + PendingCmd.sid）
{
  ok(storeSrc.includes('case "SESSIONS_RECONCILE"') && /conn\.sessions\.delete\(gone\)/.test(storeSrc), "F3 expo 对账 case：集合外本源会话就地清");
  ok(/p\?\.type === "COMMAND_DELETE" && p\.sid && \/会话不存在\/\.test\(ack\.error\)/.test(storeSrc), "F3 expo COMMAND_DELETE 失败 ACK「会话不存在」→ 本地清卡兜底");
  ok(/conn\.sessions\.delete\(p\.sid\)/.test(storeSrc), "F3 expo 兜底清卡落点（conn.sessions/timelines/sidIndex）");
  ok(/\.\.\.\(sid \? \{ sid \} : \{\}\)/.test(storeSrc), "F3 expo PendingCmd 携带目标 sid");
}

// -- F4 relay 静态锚（幂等弃 require / 缺席广播 / 三出口补发 / 类型面）
{
  const cmdRegion = fnBody(relayCmdSrc, "COMMAND_DELETE");
  ok(cmdRegion.length > 0, "F4 COMMAND_DELETE 方法体可抽取");
  ok(!cmdRegion.includes("mgr.require("), "F4 COMMAND_DELETE 弃 require（不再对缺席会话抛「会话不存在」）");
  ok(cmdRegion.includes("mgr.sessions.get("), "F4 COMMAND_DELETE 改 sessions.get（缺席=s 已删语义）");
  ok(/const s = mgr\.sessions\.get[\s\S]*?if \(s && \(s\.state\.status === "WORKING"/.test(relayCmdSrc), "F4 运行中拒删语义保持（s 在场才判 WORKING/WAITING）");
  ok(/if \(!s\) \{[\s\S]*?SESSION_DELETED[\s\S]*?return true;/.test(relayMgrSrc), "F4 deleteSession 缺席分支照常广播 SESSION_DELETED");
  ok(wsSrvSrc.includes("buildSessionsReconcile(mgr, opts.relayName?.())"), "F4 ws-server 快路径补发对账帧");
  ok((cloudSrc.match(/buildSessionsReconcile\(this\.mgr/g) ?? []).length === 2, "F4 cloud-client resumePhone/resumeWan 双出口补发");
  ok(typesSrc.includes('"SESSIONS_RECONCILE"') && typesSrc.includes("SessionsReconcilePayload"), "F4 类型面：EventType + payload 声明");
}

console.log(`§F 前端+锚：${pass} ok / ${fail} FAIL`);
if (serverFail + fail > 0) { console.error(`FAIL：共 ${serverFail + fail} 条断言未过`); process.exitCode = 1; }
else console.log(`\n全部通过：#265 会话删除幂等化 + 增量续传对账 §S+§F`);
// startServer 的监听/心跳定时器挂着事件循环（test-ws 同款收尾：显式退出）
process.exit(process.exitCode ?? 0);
