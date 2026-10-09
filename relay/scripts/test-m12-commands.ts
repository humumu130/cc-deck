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
//          兜底 task.text/M12-1 直派与 entry_id 认领旧路径零回归；
//       C9 生命周期（M12-3）：全状态边（dispatched→running→done/failed）/重投段链
//          （redispatch_of 同 root id 追加行）/ACK↔台账↔events 三面对账/重启兜底
//          closeHungDispatchRows 零悬挂；
//       C10 beads 接线（M12-4）：依赖完成→ready→可派全链/认领坏引用（幽灵引用）
//          不误放行/gate 设闸→拒→gate:null 唯一清除→放行/收口 done 自动回流
//          lesson（结构化模板非内容性经验，actor=system 审计）/failed 零 lesson；
//       C11 引擎编排（M12-5）：选择链三态（显式/角色配置/缺省 Claude）/preflight
//          失败 error 拒派零 spawn 零台账/zcode unsupported fail-closed/台账行
//          engine/provider/model 落账（收敛末行不丢）；
//       C12 值守喂活闭环（M12-6）：回合结束喂活（在岗证据）/全 running 放行/异常类
//          各一 feed（todo/stale_doing/failed——receipt v1 空源备案）/audit 只落
//          duty-rounds 零 EventBus/注入失败升级通知/K=3 防轰炸/缺省关零波及。
//       C13 验收回写与归因（M12-7）：收单全过→卡终态 done/fail 行保持/卡态不回转
//          （D14 改判仅修 result）/NULL 归因零回写零造卡（D18）/悬空引用禁操作
//          （unknown-target）/closure 四态白盒/receipt 候选真源（待填单进值守注入
//          且已提交单 reviewed 跳过）/artifact unknown 禁下载/登记面不存在会话零落账。
// fixture 缝仿 test-r1b-org（mkdtemp+CCR_ORG_DIR 注入+fake agent factory+send 直调 handleCommand）。
// 跑法：env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT -u CCR_STUB_MODE npx tsx scripts/test-m12-commands.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { COMMAND_TYPES as WS_TYPES } from "../src/ws-server.js";
import { COMMAND_TYPES as CLOUD_TYPES } from "../src/cloud-client.js";
import { acceptanceClosure } from "../src/acceptance.js";
import { listArtifacts, serveArtifact } from "../src/artifacts.js";
import { createGroup, listGroups, listLessons, loadBoard, removeBoardEntry, setLightConfirmTrusted, upsertBoardEntry } from "../src/projects.js";
import { readDispatchLog } from "../src/org.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { RelayConfig } from "../src/config.js";
import type { Command } from "../src/types.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks; engine?: string };
const makeFakeFactory = (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined, opts?: { engine?: string }): AgentLike => {
    void cwd;
    void model;
    created.push({ prompt, cb, ...(opts?.engine ? { engine: opts.engine } : {}) });
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
  const anchor2 = mkdtempSync(join(tmpdir(), "ccr-anchor2-m12-"));
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

    // ---------- C9 生命周期（M12-3）：全状态边/重投段链/三面对账/重启兜底出口 ----------
    console.log("C9 dispatch 生命周期与 receipt 对账");
    // events 面：subscribe 抓 DISPATCH_DONE 瞬态帧（notifyDispatchClosed 唯一终态广播口）
    const doneFrames: { dispatch_id?: string; status?: string; receipt?: string; worker_session_id?: string }[] = [];
    bus.subscribe((env) => { if (env.type === "DISPATCH_DONE") doneFrames.push(env.payload as typeof doneFrames[number]); });
    // C9① 重投段链：首战→failed→重投（同 root id）→running→done——台账五行两段
    const base91 = created.length;
    const ack91 = send(mgr, "c91", "COMMAND_DISPATCH", { gid, prompt: "首战失败单" }, "web-1");
    const rootId = (ack91.data as { dispatch_id?: string }).dispatch_id ?? "";
    created[base91]?.cb.onTurnEnd(false, "worker 撞墙失败", 100); // 回合终态→closeOpenDispatches failed
    const allRows = () => readNdjson<Record<string, unknown>>(join(ORG, "dispatch-log.ndjson")).filter((r) => r.id === rootId);
    const seg1 = allRows();
    const ack91r = send(mgr, "c91r", "COMMAND_DISPATCH", { gid, prompt: "重投再来", redispatch_of: rootId }, "web-1");
    const d91r = ack91r.data as { dispatch_id?: string } | undefined;
    const seg2 = allRows();
    assert(ack91r.ok === true && d91r?.dispatch_id === rootId,
      "C9① 重投 ACK dispatch_id≡原单 root id（同 id 追加行，读侧收敛末行赢）");
    assert(seg1.length === 3 && seg1.map((r) => r.status).join(",") === "dispatched,running,failed",
      "C9② 段 1 三行状态机 dispatched→running→failed（先落账再执行+回合收口）");
    assert(seg2.length === 5 && seg2.slice(3).map((r) => r.status).join(",") === "dispatched,running",
      "C9③ 重投追加段 2 两行（dispatched→running；导入侧行序终态切分出 #r2，运行时零段号）");
    created[base91 + 1]?.cb.onTurnEnd(true, "结果：这回成了｜改动文件：a.ts", 100);
    const finalRow = readDispatchLog().find((e) => e.id === rootId); // 收敛视图=末行
    assert(finalRow?.status === "done" && String(finalRow.receipt ?? "").includes("这回成了"),
      "C9④ 二回合收口 done：收敛视图（readDispatchLog 同 id 末行）status=done+receipt 含结果行");
    // C9⑤ 三面对账（同一 rootId）：ACK 面↔台账面↔events 面（DISPATCH_DONE 帧）+通知账
    const frames91 = doneFrames.filter((f) => f.dispatch_id === rootId);
    const notifRaw91 = existsSync(join(DATA, "notifications.json"))
      ? (JSON.parse(readFileSync(join(DATA, "notifications.json"), "utf-8")) as { notifications?: { key?: string; severity?: string; group?: string }[] }).notifications ?? []
      : [];
    const notif91 = notifRaw91.filter((n) => (n.key ?? "").includes(rootId));
    assert(frames91.length === 2 && frames91.map((f) => f.status).join(",") === "failed,done"
      && frames91.every((f) => f.worker_session_id !== ""),
      "C9⑤ events 面：DISPATCH_DONE 瞬态帧 failed+done 各一，dispatch_id/worker_session_id 同 id 可查");
    assert(notif91.length === 1 && notif91[0]?.group === "activity" && notif91[0]?.severity === "done",
      "C9⑥ 通知账面：stableKey=dispatch:id 一单一行（重投段链 failed→done 同 key 防重收敛末态，与台账收敛视图同哲学）");
    // C9⑦ 重投坏路径：原单不存在拒；在途单拒（防双跑）
    const ack92 = send(mgr, "c92", "COMMAND_DISPATCH", { gid, prompt: "x", redispatch_of: "d-nonexist" }, "web-1");
    assert(ack92.ok === false && String(ack92.error ?? "").includes("重投原单不存在"), "C9⑦ 坏路径：原单不存在拒收（error fixture）");
    const ack93 = send(mgr, "c93", "COMMAND_DISPATCH", { gid, prompt: "在途单" }, "web-1");
    const runningId = (ack93.data as { dispatch_id?: string }).dispatch_id ?? "";
    const ack93r = send(mgr, "c93r", "COMMAND_DISPATCH", { gid, prompt: "y", redispatch_of: runningId }, "web-1");
    assert(ack93r.ok === false && String(ack93r.error ?? "").includes("仍在途") && String(ack93r.error ?? "").includes("running"),
      "C9⑧ 坏路径：在途单重投拒收（防双跑同活，error fixture）");
    created[created.length - 1]?.cb.onTurnEnd(true, "收尾", 50); // 清悬账（防污染 C9⑨ 断言）
    // C9⑨ 重启兜底出口：closeHungDispatchRows 把 running/dispatched 悬账全补 done——
    // 悬挂行零残留（会话终局 10 出口+spawn 失败 2 口+看门狗 2 口之外的最后闸）
    const ack94 = send(mgr, "c94", "COMMAND_DISPATCH", { gid, prompt: "进程暴毙单" }, "web-1");
    assert(ack94.ok === true, "C9⑩ 前置：暴毙单 running 悬挂中");
    const hungId = (ack94.data as { dispatch_id?: string }).dispatch_id ?? "";
    const mgr2 = new SessionManager(bus, cfg); // 模拟重启：新实例读同一台账
    mgr2.setAgentFactory(makeFakeFactory(created));
    mgr2.ensureLeader(); // 启动钩子内 closeHungDispatchRows
    const hungAfter = readDispatchLog().filter((e) => e.status === "running" || e.status === "dispatched"); // 收敛视图（append-only 原始行不删，历史 running 行合法留存）
    const hungFixed = readNdjson<Record<string, unknown>>(join(ORG, "dispatch-log.ndjson"))
      .filter((r) => r.id === hungId).map((r) => r.status);
    assert(hungAfter.length === 0 && hungFixed[hungFixed.length - 1] === "done",
      "C9⑪ 重启兜底：收敛视图 running/dispatched 零残留+悬挂行补 done（receipt=relay 重启，回合中断）");

    // ---------- C10 beads 接线（M12-4）：ready 全链/坏引用认领/gate 清除口/收口 lesson ----------
    console.log("C10 beads ready/gate/lesson");
    // 依赖/gate 卡走 store 层 upsertBoardEntry 建（=orgAction board upsert 执行体下游；
    // 漏斗 deps/gate 透传 C8 段已覆盖——用户命令面咽喉无 board action，本段靶子是
    // computeReady/认领/gate 清除语义不是再验一遍漏斗）
    // C10①②③ 依赖完成→ready→可派全链：卡A(todo) ← 卡B(depends_on[A])——B 未就绪拒派，
    // A 搬 done 后认领放行（#087 就绪链全闭环，认领路径与编排链同一 computeReady 口径）
    const ackA = send(mgr, "c10a", "COMMAND_TASK_CREATE", { gid, text: "依赖前置卡A" }, "web-1");
    const idA = (ackA.data as { entity_id?: string }).entity_id ?? "";
    const cardB = upsertBoardEntry(gid, { text: "依赖后续卡B", depends_on: [idA] });
    const idB = cardB.ok ? cardB.entry.id : "";
    assert(ackA.ok === true && cardB.ok && idA !== "" && idB !== "",
      "C10① 前置：卡A(命令面)+卡B(depends_on[A]，store 层) 已建");
    const ackDep = send(mgr, "c10dep", "COMMAND_DISPATCH", { gid, prompt: "做B", entry_id: idB }, "web-1");
    assert(ackDep.ok === false && String(ackDep.error ?? "").includes("未就绪不可派") && String(ackDep.error ?? "").includes(idA),
      "C10② 依赖未完成认领拒派（error 含未就绪+依赖卡 id 逐条可判定，零 spawn）");
    send(mgr, "c10mv", "COMMAND_TASK_UPDATE", { gid, entry_id: idA, status: "done" }, "web-1");
    const ackDep2 = send(mgr, "c10dep2", "COMMAND_DISPATCH", { gid, prompt: "做B", title: "依赖后续卡B", entry_id: idB }, "web-1");
    assert(ackDep2.ok === true, "C10③ 依赖完成→ready→认领放行 spawn（ready 链闭环；带 title 保卡文本全文——认领挂接以 title||prompt 首行覆盖卡 text 的既有语义）");
    const bDispatchId = (ackDep2.data as { dispatch_id?: string }).dispatch_id ?? "";
    // C10④⑤ 收口 lesson 自动回流：B 回合 done → 板 lessons 分区多一条结构化账（非内容性）
    const lessonsBefore = (loadBoard(gid).lessons ?? []).length;
    created[created.length - 1]?.cb.onTurnEnd(true, "B 干完了，改动 b.ts", 100);
    const lessonsAuto = loadBoard(gid).lessons ?? [];
    const auto1 = lessonsAuto[lessonsAuto.length - 1];
    assert(lessonsAuto.length === lessonsBefore + 1 && auto1 !== undefined
      && auto1.text.includes("[派单收口]") && auto1.text.includes("依赖后续卡B") && auto1.text.includes("B 干完了")
      && auto1.tags.includes("派单收口") && auto1.source_dispatch_id === bDispatchId,
      "C10④ 收口 done 自动回流 lesson：结构化模板（卡摘要+收口态+dispatch 锚+tag），不生成内容性经验");
    const sysRows = auditLog().filter((r) => r.actor === "system");
    const sysLast = sysRows[sysRows.length - 1] ?? {};
    assert(sysRows.length >= 1 && sysLast.status === "done" && String(sysLast.receipt ?? "").includes("lesson 自动回流")
      && String(sysLast.receipt ?? "").includes("actor=system"),
      "C10⑤ 回流审计行 actor=system（dispatch-log 通道，与命令通道 actor=user 口径区分）");
    // C10⑥ failed 收口零 lesson（收口态不是经验——failed 走通知 action 桶，防垃圾账）
    const ackF = send(mgr, "c10f", "COMMAND_TASK_CREATE", { gid, text: "失败对照卡" }, "web-1");
    const idF = (ackF.data as { entity_id?: string }).entity_id ?? "";
    send(mgr, "c10fd", "COMMAND_DISPATCH", { gid, prompt: "会失败的活", entry_id: idF }, "web-1");
    const lessonsBeforeF = (loadBoard(gid).lessons ?? []).length;
    created[created.length - 1]?.cb.onTurnEnd(false, "worker 撞墙", 50);
    assert((loadBoard(gid).lessons ?? []).length === lessonsBeforeF,
      "C10⑥ failed 收口零 lesson（不产经验垃圾账）");
    // C10⑦ 认领坏引用（板演化后幽灵引用）不误放行：卡C dep[卡D]→删 D→认领 C error
    const ackD = send(mgr, "c10d", "COMMAND_TASK_CREATE", { gid, text: "将被删除的卡D" }, "web-1");
    const idD = (ackD.data as { entity_id?: string }).entity_id ?? "";
    const cardC = upsertBoardEntry(gid, { text: "幽灵引用卡C", depends_on: [idD] });
    const idC = cardC.ok ? cardC.entry.id : "";
    removeBoardEntry(gid, idD);
    const ackGhost = send(mgr, "c10ghost", "COMMAND_DISPATCH", { gid, prompt: "做C", entry_id: idC }, "web-1");
    assert(ackGhost.ok === false && String(ackGhost.error ?? "").includes("依赖卡不存在"),
      "C10⑦ 幽灵引用认领拒派（computeReady 坏引用=error，与编排链写卡前预检口径对齐，零 spawn）");
    // C10⑧⑨⑩⑪ gate 清除路径：gate 在场拒派→gate:null 唯一清除口→放行
    const cardE = upsertBoardEntry(gid, { text: "闸门卡E", gate: { reason: "等用户验收口径" } });
    const idE = cardE.ok ? cardE.entry.id : "";
    const ackGate1 = send(mgr, "c10g1", "COMMAND_DISPATCH", { gid, prompt: "做E", entry_id: idE }, "web-1");
    assert(ackGate1.ok === false && String(ackGate1.error ?? "").includes("gate 未过"),
      "C10⑧ gate 在场认领拒派（gate 未过 error，无自动放行路径）");
    const ackBoard = send(mgr, "c10ba", "COMMAND_ORG_ACTION", { action: "board", gid, op: "upsert", text: "x" }, "web-1");
    const clr = upsertBoardEntry(gid, { id: idE, text: "闸门卡E", gate: null });
    assert(ackBoard.ok === false && String(ackBoard.error ?? "").includes("unsupported org action: board"),
      "C10⑨ 用户命令面无 board action（咽喉 unsupported 固化——gate 清除不在用户命令面，人决策经 Leader CLI HTTP /api/org action=board 白名单）");
    assert(clr.ok && loadBoard(gid).entries.find((x) => x.id === idE)?.gate === undefined,
      "C10⑩ gate:null 显式清除落盘（board upsert=唯一清除口——确认卡词表五 kind 无 gate，裁定备案）");
    const ackGate2 = send(mgr, "c10g2", "COMMAND_DISPATCH", { gid, prompt: "做E", entry_id: idE }, "web-1");
    assert(ackGate2.ok === true, "C10⑪ 清除后认领放行 spawn（gate 语义全链：设闸→拒→人清除→放行）");
    created[created.length - 1]?.cb.onTurnEnd(true, "收尾", 50); // 清在办（防悬账污染）

    // ---------- C11 引擎编排（M12-5）：选择链三态/preflight 失败零 running/unsupported/台账引擎字段 ----------
    console.log("C11 引擎 profile/preflight 编排");
    // C11①②③ 显式覆盖（选择链最优先）：engine=codex 派单成功，台账三行同 id 共享引擎字段
    const baseC11 = created.length;
    const ackEng = send(mgr, "c11eng", "COMMAND_DISPATCH", { gid, prompt: "引擎单", engine: "codex", provider: "p1", model: "m1" }, "web-1");
    const engId = (ackEng.data as { dispatch_id?: string }).dispatch_id ?? "";
    assert(ackEng.ok === true && created[baseC11]?.engine === "codex",
      "C11① 显式 engine=codex 派单成功（选择链：显式覆盖最优先，factory 收到 engine）");
    const engRows = readNdjson<Record<string, unknown>>(join(ORG, "dispatch-log.ndjson")).filter((r) => r.id === engId);
    assert(engRows.length >= 2 && engRows.every((r) => r.engine === "codex" && r.provider === "p1" && r.model === "m1"),
      "C11② 台账行 engine/provider/model 落账（dispatched+running 同 id 共享，可审计）");
    created[baseC11]?.cb.onTurnEnd(true, "引擎单收口", 50);
    const engFinal = readDispatchLog().find((e) => e.id === engId);
    assert(engFinal?.engine === "codex" && engFinal?.provider === "p1",
      "C11③ 收口末行 engine 不丢（收敛视图字段保留——closeOpenDispatches 同 id 透传）");
    // C11④ 角色配置兜底：组 role_defaults.worker.engine=codex，无显式 engine 派单 resolved 到角色配置
    //（store 层建组——命令面 COMMAND_ORG_ACTION create 经 B2a adaptOrgAction 不透传
    // role_defaults（HTTP /api/org create 面才支持，:4270 洗刷段），缺口备案回单）
    const g2r = createGroup({ name: "引擎角色组", anchor_dir: anchor2, tier: "轻立项", role_defaults: { worker: { engine: "codex", model: "role-m" } } });
    const gid2 = g2r.ok ? g2r.group.id : "";
    const baseC11b = created.length;
    const ackRole = send(mgr, "c11role", "COMMAND_DISPATCH", { gid: gid2, prompt: "角色默认单" }, "web-1");
    assert(g2r.ok && gid2 !== "" && ackRole.ok === true && created[baseC11b]?.engine === "codex",
      "C11④ 角色配置兜底：role_defaults.worker.engine=codex，无显式 engine 派单 resolved 到角色配置（选择链三态之二）");
    created[baseC11b]?.cb.onTurnEnd(true, "收口", 50);
    // C11⑤ preflight 失败零 running：trae CLI 指向不存在绝对路径（accessSync 确定性失败）
    const prevTrae = process.env.CCR_TRAE_PATH;
    process.env.CCR_TRAE_PATH = "/nonexistent/ccr-test-trae-cli";
    const baseC11c = created.length;
    const ackPf = send(mgr, "c11pf", "COMMAND_DISPATCH", { gid, prompt: "preflight 失败单", engine: "trae" }, "web-1");
    assert(ackPf.ok === false && String(ackPf.error ?? "").includes("preflight 失败") && created.length === baseC11c,
      "C11⑤ preflight 失败 error 拒派（零 spawn 零台账——派单前 error 口径，dispatched 行都不落）");
    if (prevTrae === undefined) delete process.env.CCR_TRAE_PATH;
    else process.env.CCR_TRAE_PATH = prevTrae;
    // C11⑥ zcode unsupported：词表内但 registry 无适配器——明确 error 不静默回退
    const baseC11d = created.length;
    const ackZc = send(mgr, "c11zc", "COMMAND_DISPATCH", { gid, prompt: "zcode 单", engine: "zcode" }, "web-1");
    assert(ackZc.ok === false && String(ackZc.error ?? "").includes("unsupported engine: zcode") && created.length === baseC11d,
      "C11⑥ zcode unsupported 明确拒收（fail-closed 不静默回退，零 spawn 零台账）");
    // C11⑦ 缺省 Claude：无显式无角色配置 → engine 键缺省（旧行兼容）
    const baseC11e = created.length;
    const ackDflt = send(mgr, "c11dflt", "COMMAND_DISPATCH", { gid, prompt: "缺省引擎单" }, "web-1");
    assert(ackDflt.ok === true && created[baseC11e]?.engine === undefined,
      "C11⑦ 缺省 Claude：无显式无角色配置 → engine 键缺省不写（台账旧行兼容，选择链三态之三）");
    created[baseC11e]?.cb.onTurnEnd(true, "收口", 50);

    // ---------- C12 值守喂活闭环（M12-6）：回合结束喂活/全 running 放行/异常类各一
    //          feed/audit 落 duty-rounds 不进 events/失败升级通知/K=3 防轰炸 ----------
    console.log("C12 值守喂活闭环");
    // 值守开+测试缝（stale 零阈值/退避 30ms）。C12 用独立 ORG2（干净台账/板——
    // C1-C11 段的 failed 行 append-only 不可清，会污染 all_running 场景的候选判定）；
    // DATA 共用（duty-rounds/events/notifications 断言集中一处，mgr3 复用 DATA2 隔离）。
    // Leader 值守回合 fixture 链：ensureLeader spawn→onInit 灌 sdkId→onTurnEnd 触发
    // 值守检查→若注入则新流再 onInit（清 45s init timer，防测试进程悬挂）。
    const DATA2 = mkdtempSync(join(tmpdir(), "ccr-data2-m12-"));
    const ORG2 = mkdtempSync(join(tmpdir(), "ccr-org2-m12-"));
    const ORG3 = mkdtempSync(join(tmpdir(), "ccr-org3-m12-"));
    const anchor3 = mkdtempSync(join(tmpdir(), "ccr-anchor3-m12-"));
    const prevDuty = process.env.CCR_PM_DUTY;
    const prevStale = process.env.CCR_PM_DUTY_STALE_MS;
    const prevCont = process.env.CCR_PM_DUTY_CONTINUATION_MS;
    const prevOrgDuty = process.env.CCR_ORG_DIR;
    process.env.CCR_PM_DUTY = "1";
    process.env.CCR_PM_DUTY_STALE_MS = "0";
    process.env.CCR_PM_DUTY_CONTINUATION_MS = "30";
    process.env.CCR_ORG_DIR = ORG2;
    setLightConfirmTrusted(true); // ORG2 独立台账补轻立项信任——缺省 needsConfirm 落 pending 板冻结（projects.ts :264）
    const dutyRounds = () => readNdjson<Record<string, unknown>>(join(DATA, "duty-rounds.ndjson"));
    try {
      // 前置：值守专用组+Leader 会话（bootstrap spawn；fake 流零 onInit→手动灌 sdkId）
      const ackGD = send(mgr, "gd", "COMMAND_ORG_ACTION", { action: "create", name: "值守组", anchor_dir: anchor3, tier: "轻立项" }, "web-1");
      const gidD = (ackGD.data as { group?: { id: string } } | undefined)?.group?.id ?? "";
      const baseLeader = created.length;
      const ackLeader = mgr.ensureLeader();
      const leaderIdx0 = baseLeader;
      let leaderCb = created[leaderIdx0]?.cb;
      assert(ackLeader.ok === true && gidD !== "" && leaderCb !== undefined,
        "C12⓪ 前置：值守组+Leader 会话（bootstrap spawn）就位");
      // C12① 回合结束喂活（todo 类）：解锁 todo 卡→Leader 回合终态→检查→注入值守活
      const ackDC = send(mgr, "c12dc", "COMMAND_TASK_CREATE", { gid: gidD, text: "值守候选卡（解锁待办）" }, "web-1");
      const dutyCardId = (ackDC.data as { entity_id?: string }).entity_id ?? "";
      created[leaderIdx0]?.cb.onInit("sdk-duty-boot", "test-model"); // Leader init：灌 sdkId+锚回写
      const baseC1 = created.length;
      leaderCb?.onTurnEnd(true, "boot", 1);
      const dutyPrompt1 = created[baseC1]?.prompt;
      const round1 = dutyRounds()[dutyRounds().length - 1] ?? {};
      assert(typeof dutyPrompt1 === "string" && dutyPrompt1.includes("[值守喂活]") && dutyPrompt1.includes("DUTY_RECEIPT") && dutyPrompt1.includes(dutyCardId),
        "C12① 回合结束喂活：Leader 回合终态=在岗证据→todo 候选→注入自包含值守活（feed 锚+候选 id+DUTY_RECEIPT 协议行，非 worker 派单格式）");
      assert(round1.kind === "PM_DUTY_ROUND" && round1.result === "continue" && JSON.stringify(round1.trigger) === JSON.stringify(["turn_end"]),
        "C12①b 值守审计 continue 行（kind=PM_DUTY_ROUND/trigger=turn_end，落 duty-rounds.ndjson）");
      created[baseC1]?.cb.onInit("sdk-duty-1", "test-model"); // 值守流 init（清 init timer）
      leaderCb = created[baseC1]?.cb;
      // C12② 全 running 放行：清 todo 候选+派 worker 单（WORKING）→值守检查→sleep 不催
      send(mgr, "c12clr", "COMMAND_TASK_UPDATE", { gid: gidD, entry_id: dutyCardId, status: "done" }, "web-1");
      const baseW1 = created.length;
      send(mgr, "c12w1", "COMMAND_DISPATCH", { gid: gidD, prompt: "值守期间在跑的单" }, "web-1");
      const baseC2 = created.length;
      leaderCb?.onTurnEnd(true, "值守收口", 1);
      const round2 = dutyRounds()[dutyRounds().length - 1] ?? {};
      assert(created.length === baseC2 && round2.result === "sleep" && round2.reason === "all_running",
        "C12② 全 running 放行：worker 健康在跑→sleep 零注入（值守防的是有活全员闲，干活中不催——019 §2.2 全 running 反例）");
      // C12③ stale doing 类：worker1 交付收口（running→done 零 failed）+造悬挂 doing 卡
      //（dispatch 已收口不在 open FIFO+超窗零阈值——019 §5.1 stale 判定确定性数据源）
      created[baseW1]?.cb.onTurnEnd(true, "干完了", 50);
      upsertBoardEntry(gidD, { text: "悬挂 doing 卡（dispatch 已收口不在途）", status: "doing", dispatch_id: "d-already-closed" });
      const baseC3 = created.length;
      leaderCb?.onTurnEnd(true, "值守收口", 1);
      assert(created.length === baseC3 + 1 && String(created[baseC3]?.prompt ?? "").includes("[值守喂活]"),
        "C12③ stale doing 触发 feed：doing 卡挂已收口 dispatch（超窗）→悬挂行动位→值守注入");
      created[baseC3]?.cb.onInit("sdk-duty-2", "test-model");
      leaderCb = created[baseC3]?.cb;
      send(mgr, "c12clr2", "COMMAND_TASK_UPDATE", { gid: gidD, entry_id: loadBoard(gidD).entries.find((e) => e.dispatch_id === "d-already-closed")?.id ?? "", status: "done" }, "web-1");
      // C12③b dispatch failed 类：worker2 撞墙→failed 台账行→既有回执面即时注入 Leader
      //（notifyDispatchClosed M4 既有面，resumeAgent 换流——值守源码备案「双挂防重复
      // 轰炸」的分工：回执=告知失败，值守=重算队列）→回执回合结束（Leader 回合终态）
      //→feedPM 重算→dispatch 候选喂活
      const baseW2 = created.length;
      const ackW2 = send(mgr, "c12w2", "COMMAND_DISPATCH", { gid: gidD, prompt: "会失败的单" }, "web-1");
      const failedId = (ackW2.data as { dispatch_id?: string }).dispatch_id ?? "";
      created[baseW2]?.cb.onTurnEnd(false, "worker 撞墙", 50);
      const baseReceipt = created.length - 1; // 派单失败回执注入流（既有面产出，值守不断言它）
      created[baseReceipt]?.cb.onInit("sdk-receipt", "test-model"); // 清 resumeAgent 45s init timer
      const baseC3b = created.length;
      created[baseReceipt]?.cb.onTurnEnd(true, "回执收口", 1); // 回执回合终态=在岗证据→值守检查
      assert(created.length === baseC3b + 1 && String(created[baseC3b]?.prompt ?? "").includes("[值守喂活]") && String(created[baseC3b]?.prompt ?? "").includes(failedId.slice(0, 12)),
        "C12③b dispatch failed 触发 feed：失败台账行→回执回合结束→值守重算→注入值守活（候选含失败单 id——四类异常词表 receipt/dispatch/todo/stale_doing 的 dispatch 类）");
      created[baseC3b]?.cb.onInit("sdk-duty-3", "test-model");
      leaderCb = created[baseC3b]?.cb;
      // C12④ audit 三零：每检查一行审计只落 duty-rounds；events/通知账零值守词
      //（receipt 类备案：v1 空源不误报——正常 done 收口零注入即证，验收状态机 M12-7 落）
      const rounds4 = dutyRounds();
      assert(rounds4.length === 4 && rounds4.every((r) => r.kind === "PM_DUTY_ROUND"),
        "C12④a 四类检查四行审计（kind 全一致——一回合至多一检查，feedPM 同步单飞）");
      const eventsText = existsSync(join(DATA, "events.ndjson")) ? readFileSync(join(DATA, "events.ndjson"), "utf-8") : "";
      assert(eventsText.length > 0 && !eventsText.includes("PM_DUTY"),
        "C12④b 零 EventBus：events.ndjson 有会话帧但零 PM_DUTY 词（D18 三零边界——值守是内部治理非用户可见事件）");
      const notifText4 = existsSync(join(DATA, "notifications.json")) ? readFileSync(join(DATA, "notifications.json"), "utf-8") : "";
      assert(!notifText4.includes("PM_DUTY"), "C12④c 通知账零值守审计词（审计只在 duty-rounds.ndjson 独立文件）");
      // C12⑤⑥ 失败升级+K=3 防轰炸（独立 ORG3：Leader 无 sdkId=resumeAgent 必 throw 场景；
      // DATA2 隔离 duty-rounds/notifications 断言面）
      process.env.CCR_ORG_DIR = ORG3;
      setLightConfirmTrusted(true); // ORG3 同口径补信任（值守升级组 create 直达 active）
      const bus3 = new EventBus({ persistPath: join(DATA2, "events.ndjson") });
      const mgr3 = new SessionManager(bus3, { ...cfg, dataDir: DATA2 });
      mgr3.setAgentFactory(makeFakeFactory(created));
      const ackL3 = mgr3.ensureLeader();
      const leaderIdx3 = created.length - 1;
      const ackGD3 = send(mgr3, "gd3", "COMMAND_ORG_ACTION", { action: "create", name: "值守升级组", anchor_dir: anchor2, tier: "轻立项" }, "web-1");
      const gidD3 = (ackGD3.data as { group?: { id: string } } | undefined)?.group?.id ?? "";
      send(mgr3, "c12dc3", "COMMAND_TASK_CREATE", { gid: gidD3, text: "无人处理的卡" }, "web-1");
      const rounds3 = () => readNdjson<Record<string, unknown>>(join(DATA2, "duty-rounds.ndjson"));
      created[leaderIdx3]?.cb.onTurnEnd(true, "boot", 1); // 轮1：feed→注入尝试→throw
      const lastR3 = rounds3()[rounds3().length - 1] ?? {};
      assert(ackL3.ok === true && lastR3.result === "pm_unwakeable",
        "C12⑤a 注入失败→pm_unwakeable（保留原回合终态不伪造继续成功，Leader 无 SDK 会话记录）");
      const notifRaw3 = existsSync(join(DATA2, "notifications.json"))
        ? (JSON.parse(readFileSync(join(DATA2, "notifications.json"), "utf-8")) as { notifications?: { key?: string; title?: string; group?: string; severity?: string }[] }).notifications ?? []
        : [];
      const dutyNotif = notifRaw3.find((n) => String(n.key ?? "").startsWith("system:duty:"));
      assert(dutyNotif !== undefined && dutyNotif.title === "需要处理：团队值守无法继续" && dutyNotif.group === "action" && dutyNotif.severity === "error",
        "C12⑤b 失败升级用户：通知账 action 桶升级行（019 §5.2 语义一——值守无法继续请用户接管）");
      created[leaderIdx3]?.cb.onTurnEnd(true, "boot", 1); // 轮2：再失败（stableKey 防重不双发）
      const notifCount3 = (existsSync(join(DATA2, "notifications.json"))
        ? (JSON.parse(readFileSync(join(DATA2, "notifications.json"), "utf-8")) as { notifications?: unknown[] }).notifications ?? []
        : []).filter((n) => String((n as { key?: string }).key ?? "").startsWith("system:duty:")).length;
      created[leaderIdx3]?.cb.onTurnEnd(true, "boot", 1); // 轮3：K=3 触顶→sleep 零注入尝试
      const r3seq = rounds3().map((r) => r.result);
      const lastR3b = rounds3()[rounds3().length - 1] ?? {};
      assert(r3seq.join(",") === "pm_unwakeable,pm_unwakeable,sleep" && lastR3b.reason === "k_exhausted",
        "C12⑥ K=3 防轰炸：连续 feed 三次→第 3 次 shouldSleep 零注入（pm_unwakeable 计入 chain，防对死 Leader 无限重试）");
      const cont3 = lastR3b.continuation as { delay_ms?: number; once?: boolean } | undefined;
      assert(cont3?.delay_ms === 30 && cont3?.once === true && notifCount3 === 1,
        "C12⑥b 退避 continuation 在案（delay_ms=30 env 测试缝/wake_once）+升级通知 stableKey 防重单行");
      // C12⑦ 缺省关零波及：关开关→Leader 回合终态零检查零注入零审计
      if (prevDuty === undefined) delete process.env.CCR_PM_DUTY;
      else process.env.CCR_PM_DUTY = prevDuty;
      process.env.CCR_ORG_DIR = ORG2;
      const rounds7 = dutyRounds().length;
      const baseC7 = created.length;
      leaderCb?.onTurnEnd(true, "关值守后的回合", 1);
      assert(created.length === baseC7 && dutyRounds().length === rounds7,
        "C12⑦ 缺省关零波及：CCR_PM_DUTY 未设→值守零触发（零注入零审计，既有行为逐字节不变）");
      if (prevStale === undefined) delete process.env.CCR_PM_DUTY_STALE_MS;
      else process.env.CCR_PM_DUTY_STALE_MS = prevStale;
      if (prevCont === undefined) delete process.env.CCR_PM_DUTY_CONTINUATION_MS;
      else process.env.CCR_PM_DUTY_CONTINUATION_MS = prevCont;
      if (prevOrgDuty === undefined) delete process.env.CCR_ORG_DIR;
      else process.env.CCR_ORG_DIR = prevOrgDuty;
    } finally {
      rmSync(DATA2, { recursive: true, force: true });
      rmSync(ORG2, { recursive: true, force: true });
      rmSync(ORG3, { recursive: true, force: true });
      rmSync(anchor3, { recursive: true, force: true });
    }

    // ---------- C13 验收回写与归因（M12-7）：收单→卡终态联动/NULL 归因/悬空禁操作/
    //          卡态不回转/receipt 候选真源/unknown 禁下载/登记面零落账 ----------
    console.log("C13 验收回写与归因");
    // 独立 ACC（验收单 tmp——绝不读生产/默认目录）/ART（产物目录）/ORG5+DATA3（receipt
    // 值守 fixture 隔离）。id 用 32hex（ACCEPTANCE_ID_RE 硬门槛）；sheet/results 手写
    // fixture（出单 CLI 在生产 ~/.cc-deck/bin，红线不碰——归因字段由测试代出单方写）。
    const ACC = mkdtempSync(join(tmpdir(), "ccr-acc-m12-"));
    const ART = mkdtempSync(join(tmpdir(), "ccr-art-m12-"));
    const ORG5 = mkdtempSync(join(tmpdir(), "ccr-org5-m12-"));
    const anchor5 = mkdtempSync(join(tmpdir(), "ccr-anchor5-m12-"));
    const DATA3 = mkdtempSync(join(tmpdir(), "ccr-data3-m12-"));
    const prevAcc = process.env.CCR_ACCEPTANCE_DIR;
    const prevArt = process.env.CCR_ARTIFACTS_DIR;
    const prevDuty13 = process.env.CCR_PM_DUTY;
    const prevOrg13 = process.env.CCR_ORG_DIR;
    process.env.CCR_ACCEPTANCE_DIR = ACC;
    process.env.CCR_ARTIFACTS_DIR = ART;
    const accId = () => randomUUID().replaceAll("-", ""); // 32 hex 命中 ACCEPTANCE_ID_RE
    const writeSheet = (id: string, obj: Record<string, unknown>) =>
      writeFileSync(join(ACC, `${id}.json`), JSON.stringify(obj));
    const writeResults = (id: string, verdicts: ("pass" | "fail" | null)[]) =>
      writeFileSync(join(ACC, `${id}.results.json`), JSON.stringify({
        id,
        history: [{
          at: Date.now(), ua: "c13", counts: {
            pass: verdicts.filter((v) => v === "pass").length,
            fail: verdicts.filter((v) => v === "fail").length,
            skip: verdicts.filter((v) => v === null).length,
          },
          rows: verdicts.map((v, i) => ({ i, verdict: v, note: "" })),
        }],
      }));
    const entryCount = () => loadBoard(gid).entries.length;
    try {
      // 前置：两卡（归因靶）。主台账 ORG（trust_light 直通）+主 mgr 沿用
      const ackT1 = send(mgr, "c13t1", "COMMAND_TASK_CREATE", { gid, text: "验收回写靶卡一" }, "web-1");
      const ackT2 = send(mgr, "c13t2", "COMMAND_TASK_CREATE", { gid, text: "验收回写靶卡二" }, "web-1");
      const entry1 = (ackT1.data as { entity_id?: string }).entity_id ?? "";
      const entry2 = (ackT2.data as { entity_id?: string }).entity_id ?? "";
      assert(ackT1.ok === true && entry1 !== "" && entry2 !== "", "C13⓪ 前置：两靶卡就位");
      // C13① 收单全过→卡终态 done（归因双在场：gid+entry_id，出单方写入 relay 只读）
      const id1 = accId();
      writeSheet(id1, { id: id1, title: "靶卡一验收", created_at: Date.now(), gid, entry_id: entry1, rows: [{ task: "#T1①", item: "项一", criteria: "c1" }, { task: "#T1②", item: "项二", criteria: "c2" }] });
      writeResults(id1, ["pass", "pass"]);
      const r1 = mgr.settleAcceptanceResult(id1);
      assert(r1.ok === true && r1.action === "done" && loadBoard(gid).entries.find((e) => e.id === entry1)?.status === "done",
        "C13① 收单全过→卡终态 done（acceptance result 归因回写板卡，emitBoard 同通道）");
      // C13② fail 行→卡保持（not-closed；修复卡路径属 D14 派生卡 v2 面不造）
      const id2 = accId();
      writeSheet(id2, { id: id2, title: "靶卡二验收", created_at: Date.now(), gid, entry_id: entry2, rows: [{ task: "#T2①", item: "项一", criteria: "c1" }, { task: "#T2②", item: "项二", criteria: "c2" }] });
      writeResults(id2, ["pass", "fail"]);
      const r2 = mgr.settleAcceptanceResult(id2);
      assert(r2.ok === false && r2.reason === "not-closed" && loadBoard(gid).entries.find((e) => e.id === entry2)?.status === "todo",
        "C13② 有 fail 行→卡保持原态（not-closed 不联动，fail 走既有修复面）");
      // C13③ 卡态不回转（D14：closed 后改判仅修 result，done 是终态）
      writeResults(id1, ["pass", "fail"]); // 改判 fail 重提
      const r3 = mgr.settleAcceptanceResult(id1);
      assert(r3.ok === true && r3.reason === "already-done" && loadBoard(gid).entries.find((e) => e.id === entry1)?.status === "done",
        "C13③ 卡态不回转：done 后改判 fail 不回拉（幂等跳过，D14 收口裁定）");
      // C13④ NULL 归因零回写零造卡（D18：归因缺失记 NULL 不回填不猜）
      const id3 = accId();
      writeSheet(id3, { id: id3, title: "旧形态单（无归因）", created_at: Date.now(), rows: [{ task: "#X", item: "项", criteria: "c" }] });
      writeResults(id3, ["pass"]);
      const before4 = entryCount();
      const r4 = mgr.settleAcceptanceResult(id3);
      assert(r4.ok === false && r4.reason === "no-attribution" && entryCount() === before4,
        "C13④ NULL 归因：旧单无 gid/entry_id→零回写零造卡（缺归因保 NULL 不造假归因）");
      // C13⑤ 悬空引用禁操作（unknown-target：归因指向不存在的卡→不回写不造卡）
      const id4 = accId();
      writeSheet(id4, { id: id4, title: "悬空归因单", created_at: Date.now(), gid, entry_id: "t-ghost-13", rows: [{ task: "#G", item: "项", criteria: "c" }] });
      writeResults(id4, ["pass"]);
      const before5 = entryCount();
      const r5 = mgr.settleAcceptanceResult(id4);
      assert(r5.ok === false && r5.reason === "unknown-target" && entryCount() === before5,
        "C13⑤ 悬空禁操作：entry_id 指向不存在卡→unknown-target 零回写零造卡（D18 artifact unknown 禁操作同哲学）");
      // C13⑥ closure 四态白盒（收口判定纯函数：submitted/all_pass/fail_count/total）
      const c2 = acceptanceClosure(id2);
      const c4 = acceptanceClosure(id4);
      const id5 = accId();
      writeSheet(id5, { id: id5, title: "待填单（receipt 候选）", created_at: Date.now(), rows: [{ task: "#W", item: "项", criteria: "c" }] });
      const c5 = acceptanceClosure(id5);
      assert(c2?.submitted === true && c2.all_pass === false && c2.fail_count === 1 && c2.total === 2
        && c4?.all_pass === true && c5?.submitted === false,
        "C13⑥ closure 四态：fail 单 not-all-pass/全过单 all_pass/待填单 submitted=false（#195 生命周期语义）");
      // C13⑦ receipt 候选真源黑盒（值守注入含待填单 id；已提交单 reviewed 跳过不催）
      process.env.CCR_PM_DUTY = "1";
      process.env.CCR_ORG_DIR = ORG5;
      setLightConfirmTrusted(true); // ORG5 台账补信任
      const bus13 = new EventBus({ persistPath: join(DATA3, "events.ndjson") });
      const mgr13 = new SessionManager(bus13, { ...cfg, dataDir: DATA3 });
      mgr13.setAgentFactory(makeFakeFactory(created));
      const ackL13 = mgr13.ensureLeader();
      const leaderIdx13 = created.length - 1;
      created[leaderIdx13]?.cb.onInit("sdk-c13-boot", "test-model");
      const baseC13 = created.length;
      created[leaderIdx13]?.cb.onTurnEnd(true, "boot", 1);
      const prompt13 = String(created[baseC13]?.prompt ?? "");
      assert(ackL13.ok === true && created.length === baseC13 + 1 && prompt13.includes("[值守喂活]") && prompt13.includes(id5.slice(0, 12)) && !prompt13.includes(id4.slice(0, 12)),
        "C13⑦ receipt 候选真源：待填验收单→值守 receipt 类候选注入（单 id 入候选清单）；已提交单 reviewed 跳过不催（#195）");
      created[baseC13]?.cb.onInit("sdk-c13-duty", "test-model"); // 清 init timer
      // C13⑧ artifact unknown 禁下载（文件不在=403/404 天然禁——D18 unknown 禁下载禁预览固化）
      const stubRes = { writeHead: () => stubRes, end: () => {} } as never;
      assert(serveArtifact("ghost-c13.png", stubRes) === false && listArtifacts().length === 0,
        "C13⑧ artifact unknown 禁下载：不存在文件 serve 拒（false）+空产物目录零条目");
      // C13⑨ 登记面归因 NULL 档：不存在会话零落账（不造会话归因）
      const r9 = mgr.registerDeliverable("ghost-sid-13", join(ART, "x.txt"));
      // #183 账本 = artifacts-index.json（新名 + 旧 deliverables.json 都核，双保险）
      const idxRaw = existsSync(join(DATA, "artifacts-index.json")) ? readFileSync(join(DATA, "artifacts-index.json"), "utf-8") : "";
      const dlRaw = existsSync(join(DATA, "deliverables.json")) ? readFileSync(join(DATA, "deliverables.json"), "utf-8") : "";
      assert(r9.ok === false && !idxRaw.includes("ghost-sid-13") && !dlRaw.includes("ghost-sid-13"),
        "C13⑨ 登记面零落账：不存在会话→登记拒+关联索引零造归因行（registerDeliverable 会话门槛）");
    } finally {
      if (prevAcc === undefined) delete process.env.CCR_ACCEPTANCE_DIR;
      else process.env.CCR_ACCEPTANCE_DIR = prevAcc;
      if (prevArt === undefined) delete process.env.CCR_ARTIFACTS_DIR;
      else process.env.CCR_ARTIFACTS_DIR = prevArt;
      if (prevDuty13 === undefined) delete process.env.CCR_PM_DUTY;
      else process.env.CCR_PM_DUTY = prevDuty13;
      if (prevOrg13 === undefined) delete process.env.CCR_ORG_DIR;
      else process.env.CCR_ORG_DIR = prevOrg13;
      rmSync(ACC, { recursive: true, force: true });
      rmSync(ART, { recursive: true, force: true });
      rmSync(ORG5, { recursive: true, force: true });
      rmSync(anchor5, { recursive: true, force: true });
      rmSync(DATA3, { recursive: true, force: true });
    }
  } finally {
    if (prevOrg === undefined) delete process.env.CCR_ORG_DIR;
    else process.env.CCR_ORG_DIR = prevOrg;
    if (prevTitleGen === undefined) delete process.env.CCR_NO_TITLE_GEN;
    else process.env.CCR_NO_TITLE_GEN = prevTitleGen;
    rmSync(DATA, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
    rmSync(ORG, { recursive: true, force: true });
    rmSync(anchor, { recursive: true, force: true });
    rmSync(anchor2, { recursive: true, force: true });
  }
} catch (e) {
  fail++;
  console.error(`  ✗ 测试体异常: ${e instanceof Error ? e.stack : String(e)}`);
}

console.log(`M12 commands: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exitCode = 1;
