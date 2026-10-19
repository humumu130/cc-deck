// W-DISPVIS web 半结构断言：B4 活动行注入/消费两态点（act-consume 灰/绿）+ C2 角标
// （成员卡 dispatch-pending / 看板卡 disp-pend）+ pendingDispatchSids 直跑（收敛视图
// 逐行判定）+ 旧 relay 兼容（无 consumed 字段按 status 判定）。范式=test-005-servers.ts。
//
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-005-dispvis-web.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "web-console", "index-005.html"), "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string): string {
  const i = html.indexOf(needle);
  if (i < 0) return "";
  const j = html.indexOf("{", i);
  if (j < 0) return "";
  let depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(i, k + 1); }
  }
  return "";
}

console.log("== W-DISPVIS web: B4 两态点 + C2 角标 ==");

// ---- A. B4 活动行两态点 ----
console.log("-- A. act-consume 两态点 --");
ok(html.includes("#d-team .activity-row .act-consume {"), "A1 act-consume CSS 在场（灰点基态）");
ok(html.includes(".act-consume.consumed { background: var(--done); }"), "A2 consumed 绿点 CSS（--done）");
{
  const dotBlock = html.slice(html.indexOf("W-DISPVIS B4：注入/消费两态小点"), html.indexOf("W-DISPVIS B4：注入/消费两态小点") + 900);
  ok(dotBlock.includes('entry.status === "dispatched" || entry.status === "queued" || entry.status === "running"'), "A3 点渲染条件=dispatched/queued/running（非终态行——running 是承接不是消费）");
  ok(dotBlock.includes('entry.consumed === true ? " consumed" : ""'), "A4 点色按 consumed（真=绿/假=灰）");
  ok(dotBlock.includes("已注入（等待 worker 消费）"), "A5 hover 文案在（可解释性）");
}

// ---- B. C2 pendingDispatchSids 直跑 ----
console.log("-- B. pendingDispatchSids 直跑（收敛视图逐行判定） --");
{
  const src = blockFrom("function pendingDispatchSids(gid) {");
  ok(src.length > 0, "B1 pendingDispatchSids 函数在场（blockFrom 提取）");
  const state = { receipts: new Map() };
  const fn = eval("(" + src + ")");
  const mk = (rows) => { state.receipts.set("g1", rows); return fn("g1"); };
  ok(mk([{ id: "d1", status: "running", session_id: "s1", consumed: false }]).has("s1"), "B2 running 停留（未消费）→ 会话入集合（角标显示）");
  ok(!mk([{ id: "d1", status: "done", session_id: "s1", consumed: true }]).has("s1"), "B3 done 收口（已消费）→ 不入集合（角标消失）");
  ok(!mk([{ id: "d1", status: "failed", session_id: "s1", consumed: true }]).has("s1"), "B4 failed 终态同 done（消费完成）");
  ok(mk([{ id: "d1", status: "dispatched", session_id: "s1", consumed: false }]).has("s1"), "B5 dispatched 行带 sid（熟手承接前理论窗口）→ 入集合");
  ok(mk([{ id: "d1", status: "queued", session_id: "" }]).size === 0, "B6 排队行 sid 空 → 不入集合（无承接会话，组级由 queued 水位表达）");
  ok(mk([{ id: "d1", status: "running", session_id: "s1" }]).has("s1"), "B7 旧 relay 无 consumed 字段（undefined!==true）→ 仍按 status 判定（兼容零误伤）");
  ok(fn("g-nope").size === 0, "B8 无 receipts（未拉详情）→ 空集合零渲染");
}

// ---- C. C2 角标渲染位 ----
console.log("-- C. 角标渲染锚 --");
ok(html.includes('class="tag dispatch-pending"') && html.includes("已派单 · 等待处理"), "C1 成员卡角标 markup（tag dispatch-pending + 文案）");
ok(html.includes(".tag.dispatch-pending {"), "C2 成员卡角标 CSS（working 黄系）");
ok(html.includes('class="tchip disp-pend"'), "C3 看板卡角标 markup（tchip disp-pend）");
ok(html.includes(".tchip.disp-pend {"), "C4 看板卡角标 CSS（虚线框与 owner chip 区分）");
ok(html.includes("pendingDispatchSids(project.id).has(member.session_id)"), "C5 成员卡 join 键=member.session_id（project.id 组上下文）");
ok(html.includes("pendingDispatchSids(project.id).has(task.owner_session)"), "C6 看板卡 join 键=task.owner_session（认领卡执行者）");
ok(html.includes("派单已注入，worker 尚未消费"), "C7 角标 title 可解释文案");

// ---- D. 刷新链（零新帧依赖） ----
console.log("-- D. 刷新链静态锚 --");
ok(html.includes("state.dispatchQueues.set(gid, Array.isArray(data.dispatch_queue)"), "D1 detail 拉取存 dispatchQueues（组级排队存本）");
ok(/BOARD_UPDATED[^\n]*requestDetail/.test(html), "D2 BOARD_UPDATED 全量帧触发 requestDetail 重拉（角标数据收敛通道——零新帧）");

// ---- E. 旧 relay / 旧客户端兼容 ----
console.log("-- E. 兼容性 --");
ok(!html.includes("DISPATCH_CONSUMED_UPDATED"), "E1 零新帧类型（复用既有 BOARD_UPDATED→detail 链）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
