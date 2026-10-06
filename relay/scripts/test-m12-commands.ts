// ---------- M12-1 四新命令真链路测试（orgAction adapter 单漏斗） ----------
// 覆盖：C1 白名单双处逐字一致（ws-server vs cloud-client，#117/#212 教训断言）；
//       C2 TASK_CREATE 成功路径（ACK data{entity_id,gid}+板卡落盘+审计行）；
//       C3 TASK_UPDATE 只推 status（text 缺省补旧值）+坏路径（entry 不存在/status 词表外）；
//       C4 DISPATCH 成功路径（ACK data{entity_id,gid,dispatch_id,session_id}+fake factory
//          spawn+零新增编排）+坏路径（gid 不存在/prompt 缺失）；
//       C5 LESSON_APPEND 成功路径（tags 洗刷+listLessons 落盘）+坏路径；
//       C6 权限拒绝（viewer 无 org:write，四命令全 forbidden+零落账）；
//       C7 坏 payload（缺 gid/缺 text/缺 entry_id）+未知 org action 统一收口。
// fixture 缝仿 test-r1b-org（mkdtemp+CCR_ORG_DIR 注入+fake agent factory+send 直调 handleCommand）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-m12-commands.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { COMMAND_TYPES as WS_TYPES } from "../src/ws-server.js";
import { COMMAND_TYPES as CLOUD_TYPES } from "../src/cloud-client.js";
import { listGroups, listLessons, loadBoard, setLightConfirmTrusted } from "../src/projects.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command } from "../src/types.js";

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

try {
  // ---------- C1 白名单双处逐字一致（静态断言，无需 fixture） ----------
  console.log("C1 白名单双处一致");
  const wsList = [...WS_TYPES].sort();
  const cloudList = [...CLOUD_TYPES].sort();
  assert(wsList.length === cloudList.length && wsList.every((v, i) => v === cloudList[i]),
    `C1① ws-server 与 cloud-client 白名单逐字一致（${wsList.length} 条 diff 空）`);
  for (const t of ["COMMAND_TASK_CREATE", "COMMAND_TASK_UPDATE", "COMMAND_DISPATCH", "COMMAND_LESSON_APPEND"]) {
    assert(WS_TYPES.has(t) && CLOUD_TYPES.has(t), `C1② ${t} 双处白名单都在`);
  }

  // ---------- fixture（仿 test-r1b-org） ----------
  const DATA = mkdtempSync(join(tmpdir(), "ccr-data-m12-"));
  const CWD = mkdtempSync(join(tmpdir(), "ccr-cwd-m12-"));
  const ORG = mkdtempSync(join(tmpdir(), "ccr-org-m12-"));
  const anchor = mkdtempSync(join(tmpdir(), "ccr-anchor-m12-"));
  const prevOrg = process.env.CCR_ORG_DIR;
  const prevTitleGen = process.env.CCR_NO_TITLE_GEN;
  process.env.CCR_ORG_DIR = ORG;
  process.env.CCR_NO_TITLE_GEN = "1";
  try {
    setLightConfirmTrusted(true); // 轻立项信任直通：create 即 active，省决议步
    const cfg: RelayConfig = {
      port: 8795, token: "t", tokenGenerated: false, defaultCwd: "",
      model: "test-model", bridgeToken: "bt", dataDir: DATA,
      cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
    };
    const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
    const mgr = new SessionManager(bus, cfg);
    const created: SpawnRec[] = [];
    mgr.setAgentFactory(makeFakeFactory(created));
    const auditLog = () => readNdjson<Record<string, unknown>>(join(ORG, "dispatch-log.ndjson"));
    void CWD;

    // 前置：轻立项组（trust_light 直通 active）
    const ackG = send(mgr, "g1", "COMMAND_ORG_ACTION", { action: "create", name: "M12 测试组", anchor_dir: anchor, tier: "轻立项" }, "web-1");
    const gid = (ackG.data as { group?: { id: string } } | undefined)?.group?.id ?? "";
    assert(ackG.ok === true && gid !== "" && listGroups().find((g) => g.id === gid)?.status === "active",
      "前置：轻立项信任直通组已 active");

    // ---------- C2 TASK_CREATE 成功路径 ----------
    console.log("C2 TASK_CREATE");
    const ack1 = send(mgr, "c1", "COMMAND_TASK_CREATE", { gid, text: "交付 parity 报告", status: "todo" }, "web-1");
    const d1 = ack1.data as { entity_id?: string; gid?: string } | undefined;
    assert(ack1.ok === true && typeof d1?.entity_id === "string" && d1.entity_id !== "" && d1.gid === gid,
      "C2① ACK ok+data{entity_id,gid} 齐全");
    const card1 = loadBoard(gid).entries.find((e) => e.id === d1?.entity_id);
    assert(card1 !== undefined && card1.text === "交付 parity 报告" && card1.status === "todo",
      "C2② 板卡真落盘（text/status 与 payload 一致，单漏斗写入 boards/<gid>.json）");
    const rows1 = auditLog();
    const last1 = rows1[rows1.length - 1] ?? {};
    assert(last1.target === "org-command" && last1.status === "done" && last1.actor === "user"
      && String(last1.receipt ?? "").includes("org task-create") && String(last1.receipt ?? "").includes("device=web-1"),
      "C2③ 审计行（org task-create · actor/device 留痕，dispatch-log 通道）");
    // 缺 status：缺省 todo
    const ack1b = send(mgr, "c1b", "COMMAND_TASK_CREATE", { gid, text: "缺省状态卡" }, "web-1");
    const card1b = loadBoard(gid).entries.find((e) => e.id === (ack1b.data as { entity_id?: string }).entity_id);
    assert(ack1b.ok === true && card1b?.status === "todo", "C2④ status 缺省落 todo");

    // ---------- C3 TASK_UPDATE ----------
    console.log("C3 TASK_UPDATE");
    const eid = d1?.entity_id ?? "";
    const ack2 = send(mgr, "c2", "COMMAND_TASK_UPDATE", { gid, entry_id: eid, status: "doing" }, "web-1");
    const d2 = ack2.data as { entity_id?: string; gid?: string } | undefined;
    const card2 = loadBoard(gid).entries.find((e) => e.id === eid);
    assert(ack2.ok === true && d2?.entity_id === eid && d2.gid === gid
      && card2?.status === "doing" && card2.text === "交付 parity 报告",
      "C3① 只推 status：卡状态迁移+text 缺省补旧值不丢");
    const ack2b = send(mgr, "c2b", "COMMAND_TASK_UPDATE", { gid, entry_id: "t-nonexist", status: "done" }, "web-1");
    assert(ack2b.ok === false && typeof ack2b.error === "string" && ack2b.error.includes("板卡不存在"),
      "C3② 坏路径：entry_id 不存在拒收（error fixture）");
    const ack2c = send(mgr, "c2c", "COMMAND_TASK_UPDATE", { gid, entry_id: eid, status: "zombie" }, "web-1");
    assert(ack2c.ok === false && ack2c.error === "status 必须是 todo|doing|done",
      "C3③ 坏路径：status 词表外拒收（error fixture）");

    // ---------- C4 DISPATCH ----------
    console.log("C4 DISPATCH");
    const ack3 = send(mgr, "c3", "COMMAND_DISPATCH", { gid, prompt: "干这单活", title: "M12 派单" }, "web-1");
    const d3 = ack3.data as { entity_id?: string; gid?: string | null; dispatch_id?: string; session_id?: string } | undefined;
    assert(ack3.ok === true && typeof d3?.dispatch_id === "string" && typeof d3.session_id === "string"
      && d3.entity_id === d3.session_id && d3.gid === gid,
      "C4① ACK ok+data{entity_id,gid,dispatch_id,session_id}（entity_id=worker 会话，设计稿并列口径）");
    assert(created.length === 1 && typeof created[0]?.prompt === "string" && created[0].prompt.includes("干这单活"),
      "C4② fake factory 恰 spawn 1 个 worker 会话（prompt 原文透传进派单模板，零新增编排）");
    const ack3b = send(mgr, "c3b", "COMMAND_DISPATCH", { gid: "g-ghost", prompt: "x" }, "web-1");
    assert(ack3b.ok === false && typeof ack3b.error === "string" && ack3b.error.includes("不存在"),
      "C4③ 坏路径：gid 不存在拒收（error fixture）");
    const ack3c = send(mgr, "c3c", "COMMAND_DISPATCH", { gid, prompt: "   " }, "web-1");
    assert(ack3c.ok === false && ack3c.error === "prompt 必填",
      "C4④ 坏路径：prompt 空白拒收（error fixture）");

    // ---------- C5 LESSON_APPEND ----------
    console.log("C5 LESSON_APPEND");
    const ack4 = send(mgr, "c4", "COMMAND_LESSON_APPEND", { gid, text: "parity 口径先对齐导入器语义", tags: ["m12", "m12", " ", "parity"] }, "web-1");
    const d4 = ack4.data as { entity_id?: string; gid?: string } | undefined;
    assert(ack4.ok === true && typeof d4?.entity_id === "string" && d4.entity_id !== "" && d4.gid === gid,
      "C5① ACK ok+data{entity_id,gid}");
    const lessons = listLessons(gid, undefined);
    assert(lessons.length === 1 && lessons[0]?.id === d4?.entity_id && JSON.stringify(lessons[0]?.tags) === JSON.stringify(["m12", "parity"]),
      "C5② lesson 落盘+tags 洗刷（去重/剔除空白，store 层语义）");
    const ack4b = send(mgr, "c4b", "COMMAND_LESSON_APPEND", { gid, text: "" }, "web-1");
    assert(ack4b.ok === false && ack4b.error === "text 必填", "C5③ 坏路径：text 必填（error fixture）");

    // ---------- C6 权限拒绝（viewer 无 org:write，咽喉层直调——org.ts 不信任客户端自报角色） ----------
    console.log("C6 权限拒绝");
    const before6 = auditLog().length;
    const r6a = mgr.orgCommand("viewer", "web-1", "task-create", { gid, text: "越权卡" });
    const r6b = mgr.orgCommand("viewer", "web-1", "task-update", { gid, entry_id: eid, status: "done" });
    const r6c = mgr.orgCommand("viewer", "web-1", "dispatch", { gid, prompt: "越权单" });
    const r6d = mgr.orgCommand("viewer", "web-1", "lesson-append", { gid, text: "越权经验" });
    const forbidden6 = [r6a, r6b, r6c, r6d].every((r) => "forbidden" in r && r.forbidden.error === "forbidden");
    assert(forbidden6, "C6① viewer 四命令全 forbidden（B2a fixture 口径 error=forbidden）");
    const role6 = "forbidden" in r6a ? r6a.forbidden.actor_role : undefined;
    const rejectRows6 = auditLog().slice(before6);
    assert(role6 === "viewer" && rejectRows6.length === 4 && rejectRows6.every((r) => String(r.receipt ?? "").includes("权限拒收")),
      "C6② forbidden ACK 带 actor_role=viewer+4 行拒收审计（R1b 先例：拒收本身留痕）");
    assert(loadBoard(gid).entries.every((e) => e.text !== "越权卡") && listLessons(gid, undefined).length === 1,
      "C6③ 越权写零副作用（板/lessons 均无新行——拒收审计≠写副作用）");

    // ---------- C7 坏 payload+未知 action 统一收口 ----------
    console.log("C7 坏 payload 与未知 action");
    const r7a = send(mgr, "c7a", "COMMAND_TASK_CREATE", { text: "缺 gid" }, "web-1");
    const r7b = send(mgr, "c7b", "COMMAND_TASK_CREATE", { gid }, "web-1");
    const r7c = send(mgr, "c7c", "COMMAND_TASK_UPDATE", { gid, status: "done" }, "web-1");
    assert(r7a.ok === false && r7a.error === "gid 必填"
      && r7b.ok === false && r7b.error === "text 必填"
      && r7c.ok === false && r7c.error === "entry_id 必填",
      "C7① 缺 gid/缺 text/缺 entry_id 三坏路径 error fixture 齐全");
    const r7d = mgr.orgCommand("owner", "web-1", "task-nonsense", {});
    assert(r7d.ok === false && "error" in r7d && String(r7d.error).includes("unsupported org action"),
      "C7② 未知 org action 咽喉 default 统一收口");
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR;
    else process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
    else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    rmSync(DATA, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
    rmSync(ORG, { recursive: true, force: true });
    rmSync(anchor, { recursive: true, force: true });
  }
} catch (e) {
  fail++;
  console.error(`  ✗ 测试体异常: ${e instanceof Error ? e.stack : String(e)}`);
}

console.log(`M12 commands: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
