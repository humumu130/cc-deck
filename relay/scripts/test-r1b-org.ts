// #018-R1b org/command 真链路接入 SessionManager 集成测试。
// 覆盖：B1 COMMAND_ORG_ACTION=create needsConfirm 流（ACK data 冻结形态 {group,
//       needsConfirm, confirm?} + confirms.json 落单 + 审计行 actor/device/action/
//       anchor）；B1b ✓ 决议经 COMMAND_ORG_CONFIRM 同咽喉 → 组 pending→active；
//       B2 同 confirm 二次决议幂等（ACK ok、确认单/组不重复落账，审计照记）；
//       B3 权限拒收（B2a fixture 口径：error=forbidden + actor_role，无落账）；
//       B4 onWaiting 接 activity 状态舱（WAITING 帧发出、同值 dedup、终态守卫、
//       决议翻回 WORKING 恢复）；B5 confirms.json 坏 JSON 容错 + 重读还原；
//       B6 未知 action/未知命令统一收口（咽喉 default + B0 execCommand default）。
//       fake factory 缝仿 test-r1a-activity（零定时回调，测试体同步直调 cb）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import { listGroups } from "../src/projects.js";
import type { RelayConfig } from "../src/config.js";
import type { Command, SessionActivityPayload } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd;
    void model;
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => { a.ended = true; },
      setPermissionMode: async () => {},
    };
    return a;
  };

function readNdjson<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

function send(mgr: SessionManager, command_id: string, type: string, payload: Record<string, unknown>, by: string) {
  const cmd = { command_id, type, payload } as unknown as Command;
  return mgr.handleCommand(cmd, by);
}

async function main() {
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-r1b-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-cwd-r1b-"));
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-r1b-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  const prevCwdEnv = process.env.CCR_CWD;
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  delete process.env.CCR_CWD;
  try {
    const cfg: RelayConfig = {
      port: 8794, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const activity: SessionActivityPayload[] = [];
    bus.subscribe((env) => {
      if (env.type === "SESSION_ACTIVITY") activity.push(env.payload as SessionActivityPayload);
    });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));
    const create = (mgr as unknown as { create(cwd: string, prompt: string): string }).create.bind(mgr);
    const auditLog = () => readNdjson<Record<string, unknown>>(join(ORG, "dispatch-log.ndjson"));
    const confirmsStore = (): { id: string; status: string; decided_at?: number; decided_by?: string; payload: Record<string, unknown> }[] =>
      (JSON.parse(readFileSync(join(ORG, "confirms.json"), "utf-8")) as { confirms?: never }).confirms ?? [];

    // ---------- B1 COMMAND_ORG_ACTION=create：needsConfirm 流 + ACK 冻结形态 ----------
    console.log("B1 create needsConfirm 流");
    const anchor = mkdtempSync(join(tmpdir(), "ccr-anchor-r1b-"));
    const ack1 = send(mgr, "c1", "COMMAND_ORG_ACTION",
      { action: "create", name: "R1B 测试组", anchor_dir: anchor, tier: "正经立项" }, "web-1");
    assert(ack1.ok === true, "B1① create ACK ok");
    const d1 = ack1.data as { group?: { id: string; status: string; tier: string }; needsConfirm?: boolean; confirm?: { id: string } } | undefined;
    assert(!!d1?.group && d1.needsConfirm === true && !!d1.confirm
      && Object.keys(d1).sort().join(",") === "confirm,group,needsConfirm",
      "B1② ACK data 冻结形态 {group, needsConfirm, confirm?}（字段名一字不改）");
    assert(d1?.group?.status === "pending" && d1.group.tier === "正经立项",
      "B1③ 组落 pending（正经立项必须确认）");
    const cfId = d1?.confirm?.id ?? "";
    const store1 = confirmsStore();
    assert(store1.length === 1 && store1[0].id === cfId && store1[0].status === "pending"
      && store1[0].payload.gid === d1?.group?.id,
      "B1④ needsConfirm=true 已落 org/confirms.json（payload.gid 指回组）");
    const rows1 = auditLog();
    const last1 = rows1[rows1.length - 1] ?? {};
    assert(last1.target === "org-command" && last1.status === "done" && last1.actor === "user"
      && last1.project_anchor === anchor && last1.tier === "正经立项"
      && String(last1.receipt ?? "").includes("device=web-1") && String(last1.receipt ?? "").includes("org create"),
      "B1⑤ 审计行记 actor/device/action/anchor（复用 dispatch-log 通道）");

    // ---------- B1b COMMAND_ORG_CONFIRM ✓ 决议：同咽喉收口 → 组 active ----------
    console.log("B1b ✓ 决议 → 组 active");
    const ack2 = send(mgr, "c2", "COMMAND_ORG_CONFIRM", { confirm_id: cfId, approve: true }, "cloud-dev1");
    assert(ack2.ok === true, "B1b① 确认卡 ✓ ACK ok（云端 clientId 同咽喉）");
    assert(listGroups().find((g) => g.id === d1?.group?.id)?.status === "active",
      "B1b② ✓ 决议联动 projects 三态：pending → active");
    const store2 = confirmsStore();
    assert(store2[0].status === "approved" && !!store2[0].decided_at,
      "B1b③ 确认单状态翻 approved 并留痕");
    const last2 = auditLog()[auditLog().length - 1] ?? {};
    assert(String(last2.receipt ?? "").includes("device=cloud-dev1") && last2.status === "done"
      && last2.project_anchor === anchor,
      "B1b④ 决议审计行带 device/anchor（actor=user）");

    // ---------- B2 同 confirm 二次决议：幂等（ACK ok、不重复落账） ----------
    console.log("B2 二次决议幂等");
    const before3 = confirmsStore()[0];
    const groupBefore = listGroups().find((g) => g.id === d1?.group?.id);
    const ack3 = mgr.orgCommand("owner", "web-9", "confirm-decide", { confirm_id: cfId, approve: true });
    assert(ack3.ok === true, "B2① 二次决议 ACK ok（非 decideConfirm 的 ok:false 拒绝）");
    const after3 = confirmsStore()[0];
    assert(after3.status === before3.status && after3.decided_at === before3.decided_at
      && after3.decided_by === before3.decided_by,
      "B2② 确认单未被重写（decided_at/decided_by 冻结）");
    const groupAfter = listGroups().find((g) => g.id === d1?.group?.id);
    assert(groupAfter?.status === groupBefore?.status && groupAfter?.updated_at === groupBefore?.updated_at,
      "B2③ 组三态未被重放迁移（updated_at 冻结）");
    const last3 = auditLog()[auditLog().length - 1] ?? {};
    assert(last3.status === "done" && String(last3.receipt ?? "").includes("幂等重放"),
      "B2④ 重放审计行照记且标注幂等（台账 append-only 不吞）");

    // ---------- B3 权限拒收（B2a fixture 口径） ----------
    console.log("B3 权限拒收");
    const groupsBefore = listGroups().length;
    const r4 = mgr.orgCommand("viewer", "web-2", "create",
      { action: "create", name: "越权组", anchor_dir: join(anchor, "x"), tier: "轻立项" });
    assert(r4.ok === false, "B3① viewer create 被拒");
    const f4 = (r4 as { forbidden?: { command_id: string; ok: false; error: string; actor_role: string } }).forbidden;
    assert(!!f4 && f4.error === "forbidden" && f4.actor_role === "viewer" && f4.ok === false
      && f4.command_id === "org:create",
      "B3② ForbiddenCommandAck 形态 = B2a fixture 口径（forbidden + actor_role）");
    assert(listGroups().length === groupsBefore && !existsSync(join(anchor, "x")),
      "B3③ 拒收零落账（无新组、锚目录未建）");
    const failedRow = auditLog().find((e) => e.status === "failed");
    assert(!!failedRow && String(failedRow.receipt ?? "").includes("actor=viewer") && String(failedRow.receipt ?? "").includes("device=web-2"),
      "B3④ 拒收审计行留痕（failed + actor/device 在案）");
    const ackBadTier = send(mgr, "c3", "COMMAND_ORG_ACTION",
      { action: "create", name: "档位错", anchor_dir: anchor, tier: "合伙立项" }, "web-1");
    assert(ackBadTier.ok === false && ackBadTier.error === "tier 必须是 轻立项|正经立项",
      "B3⑤ B2a adapter 校验口径原样回 ACK（档位词表）");

    // ---------- B4 onWaiting 接 activity 状态舱（R1a 尾巴） ----------
    console.log("B4 onWaiting 状态舱");
    const sid = create(CWD, "R1B 等待测试");
    const cb = created[0].cb;
    cb.onInit("sdk-r1b", "test-model");
    cb.onStatusChange("WORKING", "开工");
    const beforeW = activity.length;
    cb.onWaiting({ request_id: "req-1", tool_name: "Bash", input_summary: "跑回归", suggestions: [] });
    const snapW = mgr.snapshot().find((s) => s.session_id === sid);
    assert(snapW?.status === "WAITING" && snapW.activity?.state === "WAITING",
      "B4① onWaiting 后 status 与 dock.state 同翻 WAITING");
    assert(snapW?.activity?.activity?.text === "等待批准 Bash：跑回归"
      && snapW?.activity?.activity?.kind === "system",
      "B4② dock 文案点明等待批准（B0 词表无 approval → kind=system，R1a 同款纪律）");
    const lastAct = activity[activity.length - 1];
    assert(activity.length === beforeW + 1 && lastAct.state === "WAITING"
      && lastAct.activity_kind === "system",
      "B4③ WAITING 瞬态帧恰好一条（SESSION_ACTIVITY）");
    const beforeDedup = activity.length;
    cb.onWaiting({ request_id: "req-1", tool_name: "Bash", input_summary: "跑回归", suggestions: [] });
    assert(activity.length === beforeDedup, "B4④ 同值重复 onWaiting 被 dedup（零瞬态）");
    cb.onStatusChange("WORKING", "继续跑");
    assert(mgr.snapshot().find((s) => s.session_id === sid)?.activity?.state === "WORKING",
      "B4⑤ 决议后经既有 onStatusChange 通路 dock 翻回 WORKING");
    cb.onTurnEnd(true, "success", 100);
    const beforeLate = activity.length;
    cb.onWaiting({ request_id: "req-2", tool_name: "Write", input_summary: "迟到帧", suggestions: [] });
    assert(activity.length === beforeLate
      && mgr.snapshot().find((s) => s.session_id === sid)?.activity?.activity?.text === "继续跑",
      "B4⑥ 终态守卫：DONE 后迟到 onWaiting 零瞬态、不覆写 dock");

    // ---------- B6 未知收口（咽喉 default + B0 execCommand default） ----------
    console.log("B6 未知命令收口");
    const r6 = mgr.orgCommand("owner", "web-1", "tier-change", {});
    assert(r6.ok === false && (r6 as { error: string }).error === "unsupported org action: tier-change",
      "B6① 咽喉未知 action 统一拒收");
    const ack6 = send(mgr, "c6", "COMMAND_ORG_BOGUS", {}, "web-1");
    assert(ack6.ok === false && ack6.error === "unsupported command",
      "B6② 未知命令走 B0 execCommand default（ws/cloud 两入口同源）");

    // ---------- B5 confirms.json 坏 JSON 容错 + 重读还原（最后跑：会重置存储） ----------
    console.log("B5 坏 JSON 容错");
    writeFileSync(join(ORG, "confirms.json"), "}}}bad json{{{", "utf-8");
    const r5 = mgr.orgCommand("owner", "web-1", "confirm-decide", { confirm_id: "cf-missing", approve: true });
    assert(r5.ok === false && (r5 as { error: string }).error.includes("不存在"),
      "B5① 坏 JSON 不炸读侧（readConfirms 容错 → 确认单不存在）");
    const anchor2 = mkdtempSync(join(tmpdir(), "ccr-anchor2-r1b-"));
    const ack5 = send(mgr, "c5", "COMMAND_ORG_ACTION",
      { action: "create", name: "重读还原组", anchor_dir: anchor2, tier: "轻立项" }, "wan-wt-9");
    const d5 = ack5.data as { needsConfirm?: boolean; confirm?: { id: string } } | undefined;
    assert(ack5.ok === true && d5?.needsConfirm === true,
      "B5② 坏 JSON 后新立项照常落单（轻立项首次也需确认）");
    const store5 = confirmsStore();
    assert(store5.length === 1 && store5[0].id === d5?.confirm?.id && store5[0].status === "pending",
      "B5③ confirms.json 重读还原为合法存储（重写后可解析）");
    const last5 = auditLog()[auditLog().length - 1] ?? {};
    assert(String(last5.receipt ?? "").includes("device=wan-wt-9"),
      "B5④ 云手表通道（wan-* clientId）同一咽喉审计留痕");
  } finally {
    process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
    else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    if (prevCwdEnv === undefined) delete process.env.CCR_CWD;
    else process.env.CCR_CWD = prevCwdEnv;
    rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\nR1b org 真链路：${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
