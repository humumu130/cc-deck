// ---------- M12-1 四新命令真链路测试（orgAction adapter 单漏斗） ----------
// 覆盖：C1 白名单双处逐字一致（ws-server vs cloud-client，#117/#212 教训断言）；
//       C2 TASK_CREATE 成功路径（ACK data{entity_id,gid}+板卡落盘+审计行）；
//       C3 TASK_UPDATE 只推 status（text 缺省补旧值）+坏路径（entry 不存在/status 词表外）；
//       C4 DISPATCH 成功路径（ACK data{entity_id,gid,dispatch_id,session_id}+fake factory
//          spawn+零新增编排）+坏路径（gid 不存在/prompt 缺失）；
//       C5 LESSON_APPEND 成功路径（tags 洗刷+listLessons 落盘）+坏路径；
//       C6 权限拒绝（viewer 无 org:write，四命令全 forbidden+零落账）；
//       C7 坏 payload（缺 gid/缺 text/缺 entry_id）+未知 org action 统一收口；
//       C8 编排链（M12-2）：payload.task → 先写卡再派——成功链三键/依赖未就绪 blocked
//          零 spawn/gate 未过/坏引用 error 零写/互斥与词表/中间态 task_ref 重派/prompt
//          兜底 task.text/M12-1 直派与 entry_id 认领旧路径零回归。
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

    // ---------- C8 编排链（M12-2）：payload.task → 先写卡 → 依赖/gate 检查 → 认领派单 ----------
    console.log("C8 编排链 task.create→dispatch");
    const runningRows = () => auditLog().filter((r) => r.target !== "org-command").length; // dispatched/running/failed 台账行（区别 org-command 审计行）
    // C8① 编排成功链：卡入账（doing+dispatch_id+text 全文）+task_ref 三键+审计两行
    const before81 = created.length;
    const audit81Base = auditLog().length;
    const longText = "交付 parity 报告并核对六域等价性口径——这一段超过六十字符，用来断言编排链 title 保全文不被认领分支截断覆盖。";
    const ack81 = send(mgr, "c81", "COMMAND_DISPATCH", { gid, prompt: "编排首单", task: { text: longText, note: "编排备注" } }, "web-1");
    const d81 = ack81.data as { entity_id?: string; task_ref?: string; blocked?: boolean; dispatch_id?: string; session_id?: string } | undefined;
    const card81 = loadBoard(gid).entries.find((e) => e.id === d81?.entity_id);
    assert(ack81.ok === true && d81?.blocked === false && d81.task_ref === d81.entity_id
      && typeof d81.dispatch_id === "string" && d81.dispatch_id !== "" && typeof d81.session_id === "string" && d81.session_id !== "",
      "C8① 成功链 ACK data{entity_id,task_ref,blocked:false,dispatch_id,session_id}（task_ref≡entity_id）");
    assert(card81 !== undefined && card81.status === "doing" && card81.dispatch_id === d81?.dispatch_id && card81.text === longText && card81.note === "编排备注",
      "C8② 卡入账认领：doing+dispatch_id 挂接+text 全文保留（title 兜底防截断）+note 落盘");
    const audit81 = auditLog().slice(audit81Base);
    assert(created.length === before81 + 1 && audit81.some((r) => String(r.receipt ?? "").includes("编排建卡"))
      && audit81.some((r) => String(r.receipt ?? "").includes("编排派单已受理")),
      "C8③ 审计两行（task-create+dispatch，编排口径 receipt——与 dispatchWorker 台账行同文件穿插）");
    // C8④ 依赖未就绪：blocked 正常编排态，零 spawn 零 dispatched 台账行，卡保留
    const depAck = send(mgr, "c84dep", "COMMAND_TASK_CREATE", { gid, text: "依赖前置卡" }, "web-1");
    const depId = (depAck.data as { entity_id?: string }).entity_id ?? "";
    const before84 = created.length;
    const running84 = runningRows();
    const ack84 = send(mgr, "c84", "COMMAND_DISPATCH", { gid, prompt: "编排受阻单", task: { text: "被依赖卡挡住的活", depends_on: [depId] } }, "web-1");
    const d84 = ack84.data as { entity_id?: string; task_ref?: string; blocked?: boolean; block_reasons?: string[]; gate_reason?: string | null; dispatch_id?: string } | undefined;
    assert(ack84.ok === true && d84?.blocked === true && (d84.block_reasons ?? []).some((s) => s.includes("未完成"))
      && d84.task_ref === d84.entity_id && !("dispatch_id" in (ack84.data as object)),
      "C8④ 依赖未就绪 → ok:true+blocked:true+block_reasons 可判定（无 dispatch_id 键）");
    assert(created.length === before84 && runningRows() === running84 && loadBoard(gid).entries.some((e) => e.id === d84?.entity_id),
      "C8⑤ blocked 零 spawn：worker 会话不建+dispatched 台账零行+卡保留在板（backlog 语义）");
    // C8⑤ gate 未设过：gate_reason 单列透传
    const ack85 = send(mgr, "c85", "COMMAND_DISPATCH", { gid, prompt: "闸门单", task: { text: "等人放行的活", gate: { reason: "等用户验收口径" } } }, "web-1");
    const d85 = ack85.data as { blocked?: boolean; gate_reason?: string | null } | undefined;
    assert(ack85.ok === true && d85?.blocked === true && d85.gate_reason === "等用户验收口径",
      "C8⑥ gate 未过 → blocked+gate_reason 单列（编排只设闸，清除走人决策口）");
    // C8⑥ 坏引用：数据完整性错误 → error 拒收（非 blocked），零写零 spawn
    const boardCount86 = loadBoard(gid).entries.length;
    const before86 = created.length;
    const ack86 = send(mgr, "c86", "COMMAND_DISPATCH", { gid, prompt: "坏引用单", task: { text: "带幽灵依赖", depends_on: ["t-ghost"] } }, "web-1");
    assert(ack86.ok === false && typeof ack86.error === "string" && ack86.error.includes("依赖卡不存在: t-ghost") && ack86.error.includes("坏引用编排拒收"),
      "C8⑦ 坏引用 → error fixture（依赖卡不存在: t-ghost），不误放行不误 blocked");
    assert(loadBoard(gid).entries.length === boardCount86 && created.length === before86,
      "C8⑧ 坏引用零写零 spawn（板零新卡、worker 会话零建）");
    // C8⑦ 互斥与词表：task×entry_id 二义性拒收；task.status 词表收窄
    const ack87 = send(mgr, "c87", "COMMAND_DISPATCH", { gid, prompt: "x", entry_id: "t-anything", task: { text: "二义" } }, "web-1");
    assert(ack87.ok === false && ack87.error === "task 与 entry_id 互斥（建新卡或认领旧卡二选一）",
      "C8⑨ task 与 entry_id 互斥 error fixture");
    const ack88 = send(mgr, "c88", "COMMAND_DISPATCH", { gid, prompt: "x", task: { text: "已完成卡", status: "done" } }, "web-1");
    assert(ack88.ok === false && ack88.error === "task.status 必须是 todo|doing", "C8⑩ task.status 词表外拒收");
    // C8⑧ task 建卡成功但 dispatch 失败中间态：卡保留（不回滚）+error 带 task_ref 可重派
    const before89 = created.length;
    const ack89 = send(mgr, "c89", "COMMAND_DISPATCH", { gid, prompt: "中间态单", task: { text: "写卡成派单败" }, engine: "bogus" }, "web-1");
    assert(ack89.ok === false && typeof ack89.error === "string" && ack89.error.includes("未知引擎") && ack89.error.includes("task_ref=") && ack89.error.includes("可带 entry_id 重派"),
      "C8⑪ dispatch 失败中间态 → ok:false error 带 task_ref 引导重派");
    const stuckCard = loadBoard(gid).entries.find((e) => e.text === "写卡成派单败");
    assert(stuckCard !== undefined && created.length === before89,
      "C8⑫ 卡已入账不回滚（下轮可带 entry_id 重派）+零 spawn");
    // C8⑨ prompt 缺省兜底 task.text（无 prompt 也能派——卡文本即指令主形态）
    const ack8a = send(mgr, "c8a", "COMMAND_DISPATCH", { gid, task: { text: "就干这个不需要单独 prompt" } }, "web-1");
    const d8a = ack8a.data as { blocked?: boolean; task_ref?: string } | undefined;
    const lastPrompt = created[created.length - 1]?.prompt;
    assert(ack8a.ok === true && d8a?.blocked === false && typeof lastPrompt === "string" && lastPrompt.includes("就干这个不需要单独 prompt"),
      "C8⑬ prompt 缺省兜底 task.text 透传进派单模板");
    // C8⑩ M12-1 旧路径回归：无 task 键直派（entity_id=会话语义）+entry_id 认领既有卡
    const ack8b = send(mgr, "c8b", "COMMAND_DISPATCH", { gid, prompt: "认领既有卡单", entry_id: depId }, "web-1");
    const d8b = ack8b.data as { entity_id?: string; dispatch_id?: string } | undefined;
    const depCard = loadBoard(gid).entries.find((e) => e.id === depId);
    assert(ack8b.ok === true && typeof d8b?.dispatch_id === "string" && !(d8b as { task_ref?: string }).task_ref
      && depCard?.status === "doing" && depCard?.dispatch_id === d8b.dispatch_id,
      "C8⑭ M12-1 旧路径零回归：entry_id 认领（无 task_ref 键=直派/认领语义，卡 doing 挂接）");
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
