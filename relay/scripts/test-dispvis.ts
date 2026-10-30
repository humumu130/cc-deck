// W-DISPVIS B4：dispatch 台账「已注入/已消费」两态暴露（project-detail receipts.consumed）
// ——按同 id 收敛末行判定（末行 running/done/failed=已消费），历史行同标；dispatch_queue
// 排队明细随 detail 下发。C2 消费链数据源同此件断言（web 侧 join 见 test-005-dispvis-web.ts）。
//
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE \
//   node --import tsx/esm scripts/test-dispvis.ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }

try {
  const ORG = mkdtempSync(join(tmpdir(), "ccr-dv-org-"));
  const ANCHOR = mkdtempSync(join(tmpdir(), "ccr-dv-anchor-"));
  const DATA = mkdtempSync(join(tmpdir(), "ccr-dv-data-"));
  const saved = ["CCR_ORG_DIR", "CCR_STORAGE_READ_MODE", "CCR_DATA_DIR", "CCR_NO_MDNS"];
  const prev: Record<string, string | undefined> = {};
  for (const k of saved) prev[k] = process.env[k];
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_STORAGE_READ_MODE = "json";

  const created: { prompt: string | undefined; cb: AgentCallbacks }[] = [];
  const fakeFactory = (_cwd: string, _model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; }, setPermissionMode: async () => {},
    };
    return a;
  };
  const bus = new EventBus();
  const cfg: RelayConfig = {
    port: 8799, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "m", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(fakeFactory);

  section("B4 detail receipts.consumed（注入/消费两态）");
  // 立项（免确认路径：直接写组——用 project-create + 自动确认太重；test-dispatch 范式走
  // orgAction project-create 产组，trust_light 关闭时需确认。这里轻量：直接调 orgAction
  // project-create 一次拿到 gid）
  const pc = mgr.orgAction("project-create", { name: "dv组", anchor: ANCHOR, tier: "轻立项" }) as { ok: boolean; data?: { group?: { id: string }; needsConfirm?: boolean; confirm?: { id: string } } };
  let gid = pc.data?.group?.id ?? "";
  if (pc.ok && pc.data?.needsConfirm && pc.data.confirm?.id) {
    // test-dispatch 192 行范式：confirm-decide 决议（轻立项首次确认一次）
    mgr.orgAction("confirm-decide", { confirm_id: pc.data.confirm.id, approve: true, by: "dv-test" });
  }
  assert(!!gid, "前置：组已建（gid 在手）");

  type ReceiptRow = { id: string; status: string; session_id: string; consumed?: boolean };
  const detail = () => mgr.orgAction("project-detail", { id: gid }) as { ok: boolean; data?: { receipts?: ReceiptRow[]; dispatch_queue?: { dispatch_id: string; title?: string }[]; queued?: number } };

  const d1 = mgr.orgAction("dispatch", { anchor: ANCHOR, prompt: "dv 第一单", gid, title: "一单" }) as { ok: boolean; dispatch_id?: string; session_id?: string };
  assert(d1.ok === true, "前置：单 1 已派（fake agent 承接）");
  const sid1 = d1.session_id ?? "";

  const r1 = detail();
  const rows1 = r1.data?.receipts ?? [];
  const d1rows = rows1.filter((x) => x.id === d1.dispatch_id);
  // running 停留=承接成功但回合未收口（消息可能仍在注入队列/换流窗口）——「已注入未消费」
  // 的可观测窗口（dispatched→running 同 tick 连写，dispatched 单独停留窗口不可观测）
  assert(d1rows.some((x) => x.status === "running") && d1rows.every((x) => x.consumed === false), "D1 running 停留（回合未收口）→ consumed=false（已注入未消费态——灰点数据源）");

  // 触发消费证据：回合完成（onTurnEnd true → closeOpenDispatches done 收口）
  const agent1 = created[created.length - 1];
  agent1.cb.onStats({ files_changed: 1, lines_added: 2, lines_deleted: 1 }); // S1 夹具适配（relfix-s）：上报改动过零产出闸
  agent1.cb.onTurnEnd(true, "success", 10);
  const r2 = detail();
  const d1rows2 = (r2.data?.receipts ?? []).filter((x) => x.id === d1.dispatch_id);
  // readDispatchLog 是同 id 收敛视图（读侧末行赢——org.ts byId Map）：收口后该单恰一行 done
  assert(d1rows2.length === 1 && d1rows2[0].status === "done", "D2 收口后收敛视图该单恰一行 done（读侧末行赢）");
  assert(d1rows2.every((x) => x.consumed === true), "D3 末行 done → consumed=true（消费完成——绿点数据源）");

  // 混合并存：新单未收口 + 旧单已消费
  const d2 = mgr.orgAction("dispatch", { anchor: ANCHOR, prompt: "dv 第二单", gid, title: "二单" }) as { ok: boolean; dispatch_id?: string };
  const r3 = detail();
  const rows3 = r3.data?.receipts ?? [];
  assert(rows3.filter((x) => x.id === d2.dispatch_id).every((x) => x.consumed === false), "D4 新单 dispatched 未收口 → consumed=false");
  assert(rows3.filter((x) => x.id === d1.dispatch_id).every((x) => x.consumed === true), "D5 旧单（已消费）不受新单影响 → consumed=true（互不干扰）");

  // 排队场景（cap=1 触顶全忙）：两席会话都置 WORKING（忙）→ pickVeteran 跳过（忙）
  // + trim 全保（忙=存活）+ pickIdleRosterWorker 全忙 null → 排队（cap 闸正路径）
  mgr.orgAction("cap-set", { gid, cap: 1 });
  const agent2 = created[created.length - 1];
  agent1.cb.onStatusChange("WORKING", "跑");
  agent2.cb.onStatusChange("WORKING", "跑");
  const d3 = mgr.orgAction("dispatch", { anchor: ANCHOR, prompt: "dv 排队单", gid, title: "三单" }) as { ok: boolean; queued?: boolean; dispatch_id?: string };
  assert(d3.ok === true && (d3 as { queued?: boolean }).queued === true, "D6 cap=1 触顶全忙 → 单 3 排队（queued ACK）");
  const r4 = detail();
  assert((r4.data?.queued ?? 0) >= 1, "D7 detail.queued 水位 ≥1（面板可见性）");
  const dq = r4.data?.dispatch_queue ?? [];
  assert(dq.some((x) => x.dispatch_id === d3.dispatch_id && x.title === "三单"), "D8 dispatch_queue 明细含排队单（id+title——组级排队可见面）");
  const rows4 = r4.data?.receipts ?? [];
  assert(rows4.filter((x) => x.id === d3.dispatch_id).every((x) => x.consumed === false), "D9 排队单台账行 consumed=false（queued=已注入未消费——灰点同口径）");

  section("C2 数据源完备性（web join 侧输入面）");
  assert(rows4.some((x) => x.session_id), "C2-1 running/done 行带 session_id（成员卡/看板卡 join 键在位——dispatched/queued 行 sid 空属正常，sid 在承接行）");
  assert(rows4.every((x) => typeof x.consumed === "boolean"), "C2-2 consumed 恒布尔（旧 relay 缺省 undefined 由端上宽容）");

  for (const k of saved) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  rmSync(ORG, { recursive: true, force: true });
  rmSync(ANCHOR, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
} catch (e) {
  fail++;
  console.error(`  ✗ 测试件异常终止: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
