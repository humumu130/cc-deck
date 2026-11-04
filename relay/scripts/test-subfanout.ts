// W-SUBFANOUT 断言件（架构升级期一①，DS Subscription fan-out 对位）：
// 单元节=直通判定单点 subFanTarget 六态（在途三态/末行收敛终态/无单/非串/无承接会话/空台账）；
// 集成节=真 startServer + /api/notify：I1 在途单 1 跳直通 worker（PM 分诊帧反证：
//   PM 在册且 WORKING external 排序在前，分诊路径必落 PM——落 worker 即直通铁证）
//   I2 终态单回落分诊（对照）I3 直通目标不在册回落 I4 裸消息启发式不变（回归锚）
//   I5 直通双留痕（送达 user-note+审计 subfanout 条目）与审计幂等。
// 环境隔离口径同 test-artifacts（独立 data/org/端口——CCR_PORT 必须错开生产 8787）。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import { subFanTarget } from "../src/subfanout.js";
import type { NotificationItem } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../data/test-subfanout/", import.meta.url));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const ORG = join(ROOT, "org");
mkdirSync(ORG, { recursive: true });
process.env.CCR_ORG_DIR = ORG; // 台账沙盒（subFanTarget 集成路径经 orgDir() 取此值）
process.env.CCR_DATA_DIR = join(ROOT, "datadir");
process.env.CCR_PORT = "8897"; // 生产 8787 必须错开（团队经验）
process.env.CCR_STORAGE_READ_MODE = "json";
process.env.CCR_NO_TITLE_GEN = "1";
mkdirSync(process.env.CCR_DATA_DIR, { recursive: true });

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.error("FAIL: " + name); }
}

// ---------- 夹具：dispatch-log.ndjson（append-only 状态机，同 id 多行末行赢） ----------
const W1 = "ext-w1"; // 在途单承接会话（集成节造册）
const rows = [
  { ts: 1, id: "did-active", tier: "正经立项", target: "w", status: "dispatched", session_id: W1, title: "直通活单" },
  { ts: 2, id: "did-active", tier: "正经立项", target: "w", status: "running", session_id: W1, title: "直通活单" },
  { ts: 1, id: "did-done", tier: "正经立项", target: "w", status: "dispatched", session_id: "ext-w2", title: "终态单" },
  { ts: 2, id: "did-done", tier: "正经立项", target: "w", status: "running", session_id: "ext-w2", title: "终态单" },
  { ts: 3, id: "did-done", tier: "正经立项", target: "w", status: "done", session_id: "ext-w2", title: "终态单", receipt: "结果：完｜改动文件：无" },
  { ts: 1, id: "did-queued", tier: "轻立项", target: "w", status: "queued", session_id: "ext-w1b", title: "排队单" },
  { ts: 1, id: "did-nosess", tier: "咨询", target: "w", status: "running", session_id: "", title: "异常行" },
];
writeFileSync(join(ORG, "dispatch-log.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---------- 单元节：subFanTarget 六态（显式 dir——不起 server） ----------
{
  const t1 = subFanTarget("did-active", ORG);
  assert(t1?.dispatchId === "did-active" && t1?.sessionId === W1 && t1?.status === "running",
    "T1 running 在途 → 直投承接会话（末行收敛 status=running）");
  const t2 = subFanTarget("did-queued", ORG);
  assert(t2?.status === "queued" && t2?.sessionId === "ext-w1b",
    "T2 queued 在途 → 直投（三活态白名单）");
  assert(subFanTarget("did-active", ORG)?.status !== "dispatched", "T2b 末行赢：dispatched 首行不覆盖 running 末行");
  assert(subFanTarget("did-done", ORG) === null, "T3 终态（done）→ null 回落分诊");
  assert(subFanTarget("did-none", ORG) === null, "T4 无此单 → null");
  assert(subFanTarget(undefined, ORG) === null && subFanTarget(123, ORG) === null && subFanTarget("   ", ORG) === null,
    "T5 非串/裸值/空白 → null（不猜归属）");
  assert(subFanTarget("did-nosess", ORG) === null, "T6 在途但无承接会话（异常行）→ null");
  const emptyDir = join(ROOT, "org-empty"); mkdirSync(emptyDir, { recursive: true });
  assert(subFanTarget("did-active", emptyDir) === null, "T7 空台账 → null（文件缺省 []）");
}

// ---------- 集成节：真 server + /api/notify ----------
const cfg = loadConfig();
const bus = new EventBus({ persistPath: join(process.env.CCR_DATA_DIR!, "events.ndjson") });
const mgr = new SessionManager(bus, cfg);
const { close } = startServer(bus, mgr, cfg, {});
await wait(250);
const http = `http://127.0.0.1:${cfg.port}/api/notify?token=${cfg.token}`;
const post = (body: Record<string, unknown>) =>
  fetch(http, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, unknown>>);

// 造册顺序=Map 迭代序：pm 先入 → 分诊启发式（WORKING external 优先）必落 pm；
// 直通命中 worker 即与分诊可区分（PM 分诊帧反证设计）
const PM = "ext-pm", WORKER = W1;
mgr.ensureExternal(PM, join(ROOT, "pm"), "pm 值守");
mgr.ensureExternal(WORKER, join(ROOT, "w1"), "worker 甲");
await wait(150);

const todosOf = (sid: string) => mgr.getExternal(sid)?.todos ?? [];
const notes = (): NotificationItem[] => mgr.notificationsList();
const subfanNotes = () => notes().filter((n) => n.title === "订阅直通（跳过 PM 分诊）");

// I1 在途单：1 跳直通 worker
{
  const r = await post({ mode: "confirm", dispatch_id: "did-active", text: "审查意见：P1 一处需修" });
  assert(r.ok === true && r.subfanout === true && r.dispatch_id === "did-active" && r.session_id === WORKER,
    "I1a 在途单响应：subfanout:true + 1 跳直达 worker 会话");
  assert(todosOf(WORKER).some((t) => t.content.includes("[待确认]") && t.content.includes("审查意见")),
    "I1b worker 收到 [待确认] 审查意见（notifyConfirm 送达）");
  assert(!todosOf(PM).some((t) => t.content.includes("审查意见")),
    "I1c PM 未收到（无 PM 分诊帧——PM 在册且 WORKING external 排序在前，落 worker 只能是直通）");
  const audit = subfanNotes();
  assert(audit.length === 1 && audit[0].body.includes("did-active".slice(0, 8)) && audit[0].body.includes("ext-w1".slice(0, 12)),
    "I1d 审计留痕：通知账 subfanout 条目含 dispatch 短 id + worker 短 id（直通≠不留账）");
  assert(audit[0].group === "activity" && audit[0].actionable !== true, "I1e 审计条目 activity 组非 actionable（审计面不弹不打扰）");
  // I5 幂等：同 text 同单重发 → 审计条目不双发（system 静默防重；todos 重复追加是 notifyConfirm 既有行为非本批面）
  await post({ mode: "confirm", dispatch_id: "did-active", text: "审查意见：P1 一处需修" });
  assert(subfanNotes().length === 1, "I5 直通审计条目幂等（重复事件不双发）");
}

// I2 终态单：回落既有分诊（对照）
{
  const before = todosOf(PM).length;
  const r = await post({ mode: "confirm", dispatch_id: "did-done", text: "终态单补充：归档核对" });
  assert(r.ok === true && !("subfanout" in r) && r.session_id === PM,
    "I2a 终态单响应：无 subfanout 字段 + 落 PM（既有启发式：WORKING external 第一）");
  assert(todosOf(PM).length === before + 1 && todosOf(PM).some((t) => t.content.includes("终态单补充")),
    "I2b PM 分诊收到（对照证据：终态回流分诊路径）");
  assert(!subfanNotes().some((n) => n.body.includes("终态单补充")), "I2c 回落路径不留直通审计（身份不混淆）");
}

// I3 直通目标不在册：回落（DS「executor 不在→回 Eval」对位）
{
  const before = todosOf(PM).length;
  const r = await post({ mode: "confirm", dispatch_id: "did-queued", text: "排队单消息：会话已亡回落" });
  assert(r.ok === true && !("subfanout" in r) && r.session_id === PM && todosOf(PM).length === before + 1,
    "I3 在途但承接会话不在册 → 回落 PM 分诊（不丢消息）");
}

// I4 裸消息（无 dispatch_id）：既有启发式不变（回归锚）
{
  const r = await post({ mode: "confirm", text: "裸消息回归锚" });
  assert(r.ok === true && !("subfanout" in r) && r.session_id === PM, "I4 无归属裸消息走既有启发式（零改动的默认路径）");
}

// 附：确认既有流零破坏——user-note 送达账仍在（notifyConfirm 副产品）
assert(notes().some((n) => n.title === "待确认（用户通知）" && n.body.includes("审查意见")),
  "I6 notifyConfirm 既有 user-note 送达账零破坏");

await close();
console.log(`\n== test-subfanout 汇总：${pass} ok / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
