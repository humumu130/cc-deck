// duty R2（1102 双审 B P2×2）：决议复活边沿+挂起期到期感知两刀——集成测试件
// R2-A：confirm-decide 后 feedPM("confirm-decided") 边沿（挂起→决议→evaluate 不再 user_confirm 阻塞）
// R2-B：挂起期最老待决卡龄达阈值 → 通知面 duty-hold 条目（不再零通知）；决议联动 resolved
// 惯例：fake agentFactory / CCR_ORG_DIR+CCR_DATA_DIR 隔离 / 断言累计（duty 保持开启——本批对象）
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { addConfirm, listConfirms } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0, fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`PASS ${msg}`); }
  else { fail++; console.error(`FAIL ${msg}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {},
      allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => {
      if (a.ended) return;
      cb.onInit("sdk-" + a.id.slice(0, 8), model, "default");
      if (prompt !== undefined) setTimeout(() => { if (a.ended) return; cb.onStats({ files_changed: 1, lines_added: 1, lines_deleted: 0 }); cb.onTurnEnd(true, "success", 10); }, 10);
    }, 10);
    return a;
  };
const dutyRounds = (dataDir: string) => {
  try { return readFileSync(join(dataDir, "duty-rounds.ndjson"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { trigger?: string[]; result?: string; reason?: string; blocked?: { id: string; reason: string }[] }); } catch { return []; }
};

async function main() {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-dutyr2-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-dutyr2-"));
  const prev = { ...process.env };
  process.env.CCR_STORAGE_READ_MODE = "json";
  process.env.CCR_RESUME_PENDING_MS = "5000";
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_DATA_DIR = DATA;
  process.env.CCR_CONFIRM_HOLD_ESCALATE_MS = "60000"; // P2-B 测试缩窗（1h——卡龄造 3h 过阈）
  delete process.env.CCR_CWD;
  delete process.env.CCR_PM_DUTY; // 值守保持开启（本批对象——显式清掉继承面）
  try {
    const cfg: RelayConfig = { port: 8797, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudToken: "", cloudUrl: "", employeeConfigDir: null };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    mgr.setAgentFactory(makeFakeFactory());
    const r0 = mgr.ensureLeader();
    check(r0.ok === true, "R2 环境就绪（Leader 首建，值守开启）");
    await waitFor(() => mgr.snapshot().some((s) => s.done_reason === "success"));

    // ================= R2-B 前置+R2-A 场景：造一张「3h 前的」待决卡 =================
    const c1 = addConfirm({ kind: "rule-append", title: "R2 测试规则卡", reason: "duty R2 集成测试", payload: { text: "r2 测试规则行", audience: "all", scope: "team", created_by: "agent" } });
    check(!!c1 && !!(c1 as { id?: string }).id, "待决确认卡已建");
    const cid1 = (c1 as { id: string }).id;
    // 老化卡龄：直接改 ORG/confirms.json 的 created_at → 3h 前（P2-B 龄判定消费源）
    const cpath = join(ORG, "confirms.json");
    const raw = JSON.parse(readFileSync(cpath, "utf-8")) as unknown;
    const list = Array.isArray(raw) ? raw : ((raw as { confirms?: unknown[] }).confirms ?? []);
    const target = list.find((x) => (x as { id?: string }).id === cid1) as { created_at?: number } | undefined;
    check(!!target, "confirms.json 直读定位到卡（老化写回前提）");
    if (target) { target.created_at = Date.now() - 3 * 3_600_000; writeFileSync(cpath, JSON.stringify(raw), "utf-8"); }

    // 挂起态：feedPM → sleep+blocked(user_confirm)；且龄过阈 → duty-hold 通知（P2-B）
    (mgr as unknown as { feedPM: (t: string) => void }).feedPM("worker_done");
    await wait(150);
    let rounds = dutyRounds(DATA);
    const blockedRound = rounds.find((r) => (r.blocked ?? []).some((b) => b.reason === "user_confirm"));
    check(!!blockedRound && blockedRound.result === "sleep", "R2-B 前置：待决卡在场值守挂起（sleep+user_confirm 阻塞审计在账）");
    const notes = (mgr as unknown as { notificationsList: () => { key: string; title: string }[] }).notificationsList();
    const hold = notes.find((n) => n.key === `system:duty-hold:${cid1}`);
    check(!!hold && hold.title.includes("值守挂起中") && hold.title.includes("3 小时"), `R2-B：挂起期到期卡产生通知面条目（key=system:duty-hold:${cid1.slice(0, 6)}…，标题含时长）`);

    // R2-A：决议 → confirm-decided 边沿（duty 轮 trigger 含 confirm-decided 且无 user_confirm 阻塞）
    const dec = mgr.orgAction("confirm-decide", { confirm_id: cid1, approve: true, by: "u" }) as { ok: boolean; error?: string };
    check(dec.ok === true, `R2-A：决议受理（${dec.ok ? "" : dec.error ?? ""}）`);
    await wait(200);
    rounds = dutyRounds(DATA);
    const edge = rounds.filter((r) => (r.trigger ?? []).includes("confirm-decided"));
    check(edge.length >= 1, "R2-A：决议边沿触发 feedPM（duty 轮 trigger=confirm-decided 在账）");
    check(edge.every((r) => !(r.blocked ?? []).some((b) => b.reason === "user_confirm")), "R2-A：决议后 evaluate 不再 user_confirm 阻塞（挂起→决议→直返）");
    // R2-B 联动：duty-hold 通知随决议 resolved
    const notes2 = (mgr as unknown as { notificationsList: () => { key: string; resolved_at?: number }[] }).notificationsList();
    const hold2 = notes2.find((n) => n.key === `system:duty-hold:${cid1}`);
    check(!!hold2 && hold2.resolved_at !== undefined, "R2-B 联动：挂起提醒随卡决议 resolved（不再悬挂）");
    // 新增确认卡场景（挂起期新卡照常入通知账——审查已核 addConfirm 咽喉，此处锁行为不回退）
    const c2 = addConfirm({ kind: "rule-append", title: "R2 挂起期新卡", reason: "新增感知", payload: { text: "新卡", audience: "all", scope: "team", created_by: "agent" } });
    const notes3 = (mgr as unknown as { notificationsList: () => { key: string }[] }).notificationsList();
    check(!!c2 && notes3.some((n) => n.key.startsWith(`org-confirm:${(c2 as { id: string }).id}`)), "R2-B：挂起期新增确认卡照常入通知账（addConfirm 咽喉不回退）");
    check(listConfirms().every((c) => c.id !== cid1 || c.status === "approved"), "决议状态落账（approved）");
  } finally {
    Object.keys(prev).forEach((k) => { process.env[k] = prev[k]; });
  }
  console.log(`\nduty R2: ${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
