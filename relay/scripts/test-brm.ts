// #G3+G5 板卡富模型+失败自动重试——断言套件。
// 覆盖：
//   §P 纯函数（dispatch-retry 直 import）：classify 六类匹配序 / isTransient 瞬态集
//   §S 真对象（orgDir 沙盒）：upsertBoardEntry priority/parent_id 透传+回读+坏值拒 /
//      appendDispatch 咽喉 failed 行自动 failure_reason（显式不覆盖）/ priority 透传 /
//      failure_reason 坏值拒写 / readDispatchLog 收敛带新字段
//   §A 静态锚：session-manager 重试挂钩+透传 / web 渲染四面 / schema 词表
// 直跑：cd relay && env -u CCR_ORG_DIR npm run test:brm
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDispatchFailure, isTransientFailure, TRANSIENT_FAILURES, TRANSIENT_RETRY_DELAY_MS } from "../src/dispatch-retry.js";
import { createGroup, upsertBoardEntry, loadBoardFile, findGroup, setGroupStatus } from "../src/projects.js";
import { appendDispatch, readDispatchLog } from "../src/org.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- 沙盒 orgDir ----
const SB = (p: string) => fileURLToPath(new URL(p, import.meta.url));
rmSync(SB("../data/test-brm-org/"), { recursive: true, force: true });
mkdirSync(SB("../data/test-brm-org/"), { recursive: true });
process.env.CCR_ORG_DIR = SB("../data/test-brm-org/");

console.log("§P classifyDispatchFailure 纯函数（匹配序 specific→generic）：");
{
  // 本仓真实错误串锚（#291/#294R 批实测形态）
  ok(classifyDispatchFailure("API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-10-28 12:27:08 重置。]") === "model_overload", "P1 429+使用上限→model_overload（本仓真实串）");
  ok(classifyDispatchFailure("Error: rate limit exceeded, too many requests") === "model_overload", "P1b rate limit/too many requests→model_overload");
  ok(classifyDispatchFailure("初始化超时（30s）") === "timeout", "P2 超时→timeout");
  ok(classifyDispatchFailure("fetch failed: ETIMEDOUT") === "timeout", "P2b ETIMEDOUT→timeout（timeout 先于 network——specific 序）");
  ok(classifyDispatchFailure("network error: ECONNRESET socket hang up") === "network_error", "P3 ECONNRESET/socket→network_error");
  ok(classifyDispatchFailure("FetchError: ENOTFOUND api.example.com") === "network_error", "P3b ENOTFOUND→network_error");
  ok(classifyDispatchFailure("tool Bash crashed: panic segfault") === "tool_crash", "P4 crash/panic→tool_crash");
  ok(classifyDispatchFailure("任务已取消（cancelled by user）") === "cancelled", "P5 cancel/取消→cancelled（最 specific 先匹配）");
  ok(classifyDispatchFailure("入编被编制上限闸拒绝: headcount_cap=6") === "logic_error", "P6 编制闸拒→logic_error（兜底——逻辑类不自动重试）");
  ok(classifyDispatchFailure("无 SDK 会话记录，无法恢复") === "logic_error", "P6b 参数/状态错→logic_error 兜底");
  // 审查 A-P1-1 修复锚：Node 网络瞬态错误码族三族（原全漏自动重试）
  ok(classifyDispatchFailure("Error: read EPIPE") === "network_error", "P6c EPIPE→network_error（A-P1-1：原落 logic_error 漏重试）");
  ok(classifyDispatchFailure("getaddrinfo EAI_AGAIN api.example.com") === "network_error", "P6d EAI_AGAIN→network_error（A-P1-1）");
  ok(classifyDispatchFailure("ECONNABORTED connection aborted") === "network_error", "P6e ECONNABORTED→network_error（A-P1-1：原落 cancelled 漏重试）");
  ok(classifyDispatchFailure("Request aborted due to timeout") === "timeout", "P6f aborted due to timeout→timeout（A-P1-1：timeout 词自身命中，abort 裸词退役）");
  ok(classifyDispatchFailure("任务已被用户中止") === "cancelled", "P6g 用户中止→cancelled 仍先命中（abort 移位不伤取消语义）");
  // 瞬态集
  ok(isTransientFailure("network_error") && isTransientFailure("timeout") && isTransientFailure("model_overload"), "P7 瞬态三类=自动重试资格");
  ok(!isTransientFailure("logic_error") && !isTransientFailure("tool_crash") && !isTransientFailure("cancelled"), "P7b 逻辑/崩/取消三类不自动重试（人工/PM 决策）");
  ok(TRANSIENT_RETRY_DELAY_MS === 30_000, "P8 重试延迟 30s（任务书口径）");
  ok(TRANSIENT_FAILURES.size === 3, "P8b 瞬态集恰三成员");
}

console.log("§S 真对象行为（orgDir 沙盒）：");
{
  // G3 板卡富模型 CRUD
  const cg = createGroup({ name: "brm 测试团", anchor_dir: "/tmp/brm-anchor", tier: "轻立项" });
  ok(cg.ok, "S0 建组");
  const gid = cg.ok ? cg.group.id : "";
  setGroupStatus(gid, "active"); // 新组默认 pending=板冻结，激活后可写（生产同链：PM 确认翻 active）
  const parent = upsertBoardEntry(gid, { text: "父任务", priority: "P0" });
  ok(parent.ok && (parent as { entry: { priority?: string } }).entry.priority === "P0", "S1 upsert 建 priority=P0（透传+回读）");
  const child = upsertBoardEntry(gid, { text: "子任务", parent_id: (parent as { entry: { id: string } }).entry.id, priority: "P1" });
  ok(child.ok && (child as { entry: { parent_id?: string; priority?: string } }).entry.parent_id === (parent as { entry: { id: string } }).entry.id && (child as { entry: { priority?: string } }).entry.priority === "P1", "S2 upsert 建 parent_id+priority=P1（父子链透传）");
  const board = loadBoardFile(gid);
  ok(board?.entries.some((e) => e.priority === "P0" && !e.parent_id) && board?.entries.some((e) => e.parent_id === (parent as { entry: { id: string } }).entry.id), "S3 loadBoardFile 回读富字段（持久化往返）");
  const badPrio = upsertBoardEntry(gid, { id: "bad-1", text: "坏优先级", priority: "P3" });
  ok(!badPrio.ok && /priority/.test(badPrio.error ?? "") && /不在词表/.test(badPrio.error ?? ""), "S4 priority 坏值拒写（P0/P1/P2 词表闸——checkFields enum 通用检查先命中，分支细查双闸兜底）");
  // 更新分支：null 清除
  const upd = upsertBoardEntry(gid, { id: (child as { entry: { id: string } }).entry.id, text: "子任务", priority: null, parent_id: null });
  ok(upd.ok && !(upd as { entry: { priority?: string } }).entry.priority && !(upd as { entry: { parent_id?: string } }).entry.parent_id, "S5 null 清除（回未标注/根卡）");
  // 坏 parent_id 容错（不炸——孤儿渲染层平铺）
  const orphan = upsertBoardEntry(gid, { text: "孤儿子卡", parent_id: "nonexistent-parent" });
  ok(orphan.ok, "S6 坏 parent_id 容错写入（孤儿渲染层平铺——与 depends_on 同口径不炸）");

  // G5 appendDispatch 咽喉
  const base = { ts: Date.now(), id: "brm-d1", tier: "正经立项" as const, target: "spawn-pending", session_id: "", actor: "leader" };
  ok(appendDispatch({ ...base, status: "failed", receipt: "API Error: Request rejected (429) 已达到使用上限" }), "S7 failed 行写入 ok");
  const row = readDispatchLog().find((e) => e.id === "brm-d1");
  ok(row?.failure_reason === "model_overload", "S8 咽喉自动分类：429 receipt→failure_reason=model_overload（调用方零改动单点）");
  ok(appendDispatch({ ...base, id: "brm-d2", status: "failed", receipt: "whatever", failure_reason: "timeout" }), "S9 显式 failure_reason 写入 ok");
  ok(readDispatchLog().find((e) => e.id === "brm-d2")?.failure_reason === "timeout", "S10 显式分类不被咽喉覆盖（尊重调用方）");
  ok(!appendDispatch({ ...base, id: "brm-d3", status: "failed", receipt: "x", failure_reason: "weather_error" } as never), "S11 failure_reason 坏枚举拒写（词表闸）");
  ok(appendDispatch({ ...base, id: "brm-d4", status: "running", receipt: "", priority: "P0" }), "S12 dispatch priority 透传写入 ok");
  const row4 = readDispatchLog().find((e) => e.id === "brm-d4");
  ok(row4?.priority === "P0" && row4?.failure_reason === undefined, "S13 台账行带 priority=P0（非 failed 无 failure_reason）");
  ok(appendDispatch({ ...base, id: "brm-d5", status: "dispatched", retry_of: "brm-d1", session_id: "s-x" }), "S14 retry_of 标记行写入 ok");
  ok(readDispatchLog().find((e) => e.id === "brm-d5")?.retry_of === "brm-d1", "S15 retry_of 回读（重试链证据）");
  ok(findGroup(gid) !== null, "S16 组仍在（前序写无破坏）");
}

console.log("§A 静态锚（relay/web/schema）：");
{
  const sm = readFileSync(join(root, "relay", "src", "session-manager.ts"), "utf-8");
  const web = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
  const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");
  const schema = readFileSync(join(root, "relay", "src", "org-schema.ts"), "utf-8");
  const retry = readFileSync(join(root, "relay", "src", "dispatch-retry.ts"), "utf-8");

  // relay：重试挂钩
  ok(/private maybeTransientRetry\(dispatchId: string/.test(sm) && sm.includes("if (input.retry_of) return; // 本单已是重试：不再重试（链深恒 1——含排队重放单带 retry_of 的复合形态）"), "A1 maybeTransientRetry 定义+链深 1 门控（审查 A-P2-1：死分支已删）");
  ok((sm.match(/this\.maybeTransientRetry\(dispatchId, input/g) ?? []).length === 2, "A2 两 spawn 失败出口挂重试（复用降级再失败+首次拉起失败——编制闸/入编闸出口不挂=逻辑类）");
  ok(sm.includes("queue_replay: dispatchId, retry_of: dispatchId") && sm.includes("scheduleTransientRetry(() => {"), "A3 重试原参重入（queue_replay 同 id 段链+retry_of 标记+30s 调度）");
  // relay：透传
  ok(sm.includes('...(input.priority ? { priority: input.priority } : {}), // #G3：派单优先级随台账全行'), "A4 engineFields 层 priority 透传（台账全行）");
  ok((sm.match(/\.\.\.\(input\.priority \? \{ priority: input\.priority \} : \{\}\), \.\.\.\(input\.parent_id \? \{ parent_id: input\.parent_id \} : \{\}\)/g) ?? []).length === 2, "A5 建卡两分支带 priority+parent_id");
  ok(sm.includes('...(input.retry_of ? { retry_of: input.retry_of } : {})'), "A6 dispatched 行带 retry_of 标记");
  ok(sm.includes("...(e.retry_of ? { retry_of: e.retry_of } : {})") && sm.includes("重试标记随收口行透传"), "A6b 收口行透传 retry_of——json 档收敛末行赢，收口行不带会洗掉 dispatched 行标记（审查 B-P1-2）");
  ok(sm.includes("failure_reason: classifyDispatchFailure(`${msg}\\n${msg2}`)") && sm.includes("failure_reason: classifyDispatchFailure(msg)"), "A6c spawn 两出口 failure_reason 用原始串（审查 A-P2-2：receipt 截断砍错误码=标签与行为不一致）");
  ok(sm.includes('failure_reason: "logic_error"') && sm.includes("审查 A-P2-4：编制闸类恒 logic"), "A6d capReuse 出口显式 logic_error（审查 A-P2-4：msg 含网络词时不误标瞬态）");
  // web
  ok(web.includes("const boardExpanded = new Set();") && web.includes('data-board-toggle='), "A7 web 折叠态 Set+折叠钮");
  ok(web.includes("const subCount = task.__subCount || 0;") && web.includes('"subtasks">'), "A8 web 子卡挂靠容器（默认折叠）");
  ok(web.includes("visibleN: withSubs.length") && web.includes("laneRes.visibleN"), "A8b 泳道计数=可见卡数（审查 B-P2-3：折叠子卡不计数）");
  ok(web.includes('t.__subRunning = t.__subs.some((sub) => dispatchStatus.get(sub.dispatch_id) === "running");'), "A8c 父卡运行信号（审查 B-P2-2：折叠不吞子卡 running）");
  ok(/rootIds\.has\(sub\.parent_id\)/.test(web) && web.includes("孤儿子卡（孙链）：平铺进根列"), "A9 web 孤儿容错（孙链/坏引用平铺不丢）");
  ok(web.includes('data-priority=') && web.includes("prio-' + prio.toLowerCase()"), "A10 web 优先级 chip+data-priority（P0/P1 显）");
  ok(web.includes("const failChip = entry.status === \"failed\" && entry.failure_reason") && web.includes("自动重试"), "A11 web 活动行失败分类 chip+重试标识");
  ok(css.includes('.tchip.prio-p0') && css.includes('.task-card[data-priority="P0"] { box-shadow: inset 0 2.5px 0') && css.includes("#d-team .subtasks .task-card.compact") && css.includes(".act-freason") && css.includes(".sub-toggle.sub-running"), "A12 CSS 六件（prio chip/顶部条·B-P1-1/子卡特异性·B-P2-1/sub-running·B-P2-2/失败分类 chip）");
  // schema
  ok(schema.includes('export const BOARD_PRIORITIES = ["P0", "P1", "P2"] as const;') && schema.includes('export const FAILURE_REASONS = ['), "A13 schema 词表（优先级三档+失败六枚举镜像）");
  ok(schema.includes("板卡 priority 不在词表") && schema.includes("failure_reason 不在词表") && schema.includes("派单 priority 不在词表"), "A14 schema 三处词表闸（板卡/失败/派单）");
  ok(retry.includes("export function classifyDispatchFailure") && retry.includes("export function scheduleTransientRetry"), "A15 dispatch-retry 导出面（分类器+调度缝）");
}

console.log(`\n§P-§A：${pass} ok / ${fail} FAIL`);
if (fail > 0) { console.error(`FAIL：共 ${fail} 条未过`); process.exit(1); }
console.log("\n全部通过：#G3+G5 板卡富模型+失败自动重试（priority/父子链/失败分类/瞬态重试）");
process.exit(fail > 0 ? 1 : 0);
