// #018-W2a：Web AI 无框消息 + 双段 dock fixture 直跑测试（worker H）。
// 被测对象 = web-console/index.html 的 W2A-MESSAGES 纯函数段（锚点正则提取，
// new Function 构造直跑——段自包含零 DOM、不取时，构造+运行不需浏览器）。
// 覆盖（018 :414 + §2.1.2 + :646 验收）：①role 判定（user_message 唯一气泡面/其余
// AI 无框面/头像行身份元信息）②流式替换（同 id 原地替换绝不追加/迟到残帧不回退/
// 终态揭标）③双段 dock（任务段 todos 摘要/活动段节流/WAITING 独占/旧 relay 单段降级）
// ④done/error 收口（ERROR 常驻/DONE 尾窗/快照回放与增量帧同 id 去重接线）
// + 结构自查闸（018 §5.5 + W2A 接线静态锚点）。
// 断言时间全定值（now/at=1000 等），无两个取时点 Date.now 比对。
// 直跑入口（relay 目录）：
//   env -u CCR_ORG_DIR node --import tsx/esm scripts/test-w2a-messages.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEB_HTML = fileURLToPath(new URL("../../web-console/index.html", import.meta.url));

let pass = 0;
let fail = 0;
function check(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
function finish(): never {
  console.log(`w2a messages projection: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

// ---------- 被测段提取 + 锚点唯一性 ----------
const html = readFileSync(WEB_HTML, "utf8");
const seg = /\/\* W2A-MESSAGES-START \*\/([\s\S]*?)\/\* W2A-MESSAGES-END \*\//.exec(html);
check(!!seg, "锚点① W2A-MESSAGES 段存在且可提取");
check(html.split("W2A-MESSAGES-START").length === 2 && html.split("W2A-MESSAGES-END").length === 2,
  "锚点② START/END 标记全文各只出现一次（提取无歧义）");
const segCode = seg ? seg[1] : "";

type Role = "user" | "ai-text" | "ai-think" | "ai-tool" | "ai-result" | "ai-sys";
type Head = { name: string; meta: string };
type TaskSeg = { done: number; total: number; current: string; text: string };
type Todo = { content?: string; status?: string; active_form?: string };
type DockAct = { state?: string; activity?: { text?: string; tool?: string }; updated_at?: number };
type W2AApi = {
  ENGINE_LABEL: Record<string, string>;
  msgRoleOf(kind: unknown): Role;
  aiHeadOf(session: unknown, projects: unknown): Head;
  streamMergeDecide(existing: unknown, incoming: unknown): "append" | "replace" | "skip";
  streamFinalized(entry: unknown, status: unknown): boolean;
  dockExclusiveOf(s: unknown): boolean;
  dockTaskOf(todos: unknown): TaskSeg | null;
  dockActivityThrottled(prev: unknown, next: unknown, now: number, minMs: number): boolean;
  dockSegmentsOf(input: unknown): { waiting: boolean; task: TaskSeg | null; activity: { text: string; tool: string } | null };
  dockClosingOf(s: unknown, now: number, tailMs?: number): { kind: "done" | "error"; text: string } | null;
};
const api = new Function(
  segCode + "\nreturn { ENGINE_LABEL: ENGINE_LABEL, msgRoleOf: msgRoleOf, aiHeadOf: aiHeadOf, streamMergeDecide: streamMergeDecide, streamFinalized: streamFinalized, dockExclusiveOf: dockExclusiveOf, dockTaskOf: dockTaskOf, dockActivityThrottled: dockActivityThrottled, dockSegmentsOf: dockSegmentsOf, dockClosingOf: dockClosingOf };",
)() as W2AApi;

const PROJECTS = [{ id: "g1", name: "收银台改造", tier: "正经立项" }, { id: "g2", name: "无档位组" }];

// ---------- ① role 判定 + 头像行身份（§2.1.2 pane 协议） ----------
{
  check(api.msgRoleOf("user_message") === "user", "① user_message → 唯一气泡面");
  check(api.msgRoleOf("assistant_text") === "ai-text" && api.msgRoleOf("thinking") === "ai-think",
    "① assistant_text/thinking → AI 无框面（正文/思考折叠）");
  check(api.msgRoleOf("tool_use") === "ai-tool" && api.msgRoleOf("tool_result") === "ai-result",
    "① tool_use/tool_result → AI 无框面（折叠交互保留，折叠在渲染层不降级）");
  check(api.msgRoleOf("system") === "ai-sys" && api.msgRoleOf("junk_kind") === "ai-sys" && api.msgRoleOf(undefined) === "ai-sys",
    "① system/未知 kind 兜底 ai-sys——不冒充用户气泡也不崩");
  const h0 = api.aiHeadOf(null, PROJECTS);
  check(h0.name === "Claude" && h0.meta === "", "① 会话缺失 → Claude 缺省兜底（升级前文案，旧 relay 零影响）");
  check(api.aiHeadOf({}, PROJECTS).name === "Claude", "① engine 缺省 → Claude（现状默认）");
  check(api.aiHeadOf({ engine: "codex" }, PROJECTS).name === "Codex", "① engine codex → Codex（引擎名进元信息行）");
  check(api.aiHeadOf({ engine: "qwen-code" }, PROJECTS).name === "Qwen Code", "① 词表全量映射（qwen-code → Qwen Code）");
  check(api.aiHeadOf({ engine: "mystery" }, PROJECTS).name === "Claude", "① 未知 engine → 回落 Claude（不裸奔 undefined）");
  const h1 = api.aiHeadOf({ engine: "claude", project_gid: "g1" }, PROJECTS);
  check(h1.meta === "收银台改造 · 正经立项", "① 团队成员会话：组名 + 组档位元信息（project_gid 归属）");
  const h2 = api.aiHeadOf({ project_gid: "g1", dispatch_tier: "轻立项" }, PROJECTS);
  check(h2.meta === "收银台改造 · 轻立项", "① 档位 session 优先回落组档（dispatch_tier 覆盖）");
  check(api.aiHeadOf({ project_gid: "g2" }, PROJECTS).meta === "无档位组", "① 组无档位 → 只组名（不出假档位）");
  check(api.aiHeadOf({ project_gid: "gx" }, PROJECTS).meta === "项目组", "① 组查无 → 兜底「项目组」（不空挂）");
  check(api.aiHeadOf({ dispatch_tier: "随手办" }, PROJECTS).meta === "", "① 无组会话 meta 空（元信息行不渲染）");
}

// ---------- ② 流式替换：同 id 原地替换绝不追加 + 迟到残帧不回退 + 终态揭标 ----------
{
  check(api.streamMergeDecide({ id: "a" }, null) === "skip" && api.streamMergeDecide({ id: "a" }, 42) === "skip",
    "② 非法入帧 → skip（不崩）");
  check(api.streamMergeDecide(null, { id: "a", text: "x" }) === "append", "② 桶空/条目缺失 → append（新块）");
  check(api.streamMergeDecide({ id: "a" }, { text: "x" }) === "append", "② 无 id 帧 → append（非流式普通条目）");
  check(api.streamMergeDecide({ id: "a", streaming: true }, { id: "a", text: "更长", streaming: true }) === "replace",
    "② 同 id 流式增量 → replace（原地替换绝不追加）");
  check(api.streamMergeDecide({ id: "a" }, { id: "a", text: "终文", full: "全文" }) === "replace",
    "② 终帧（无 streaming 标记带 full）→ replace 覆盖在位");
  check(api.streamMergeDecide({ id: "a", full: "已收口" }, { id: "a", text: "残", streaming: true }) === "skip",
    "② 迟到残帧：已收口条目（终帧已落/快照含终文）遇无 full streaming 残帧 → skip 不回退");
  check(api.streamMergeDecide({ id: "a", full: "已收口" }, { id: "a", text: "x", streaming: true, full: "F" }) === "replace",
    "② 带 full 的帧不视为残帧（内容在身，放行覆盖）");
  check(api.streamMergeDecide({ id: "a", streaming: true }, { id: "b", text: "x" }) === "append",
    "② 不同 id → append（新块，呼叫方按 id 定位桶）");
  check(api.streamFinalized({ streaming: true }, "WORKING") === false, "② 揭标判定：会话在跑 + streaming → 未收口（光标在）");
  check(api.streamFinalized({ streaming: true }, "DONE") === true && api.streamFinalized({ streaming: true }, "ERROR") === true,
    "② 终态 DONE/ERROR：streaming 残标揭除（光标不闪，等真实终帧 replace）");
  check(api.streamFinalized({ streaming: true }, "WAITING") === true && api.streamFinalized({ streaming: true }, undefined) === true,
    "② WAITING/状态缺失同揭标（保守收口——不在跑就不闪）");
  check(api.streamFinalized({}, "WORKING") === true && api.streamFinalized(null, "WORKING") === true,
    "② 非 streaming 条目天然已收口（缺失/非流式恒 true）");
}

// ---------- ③ 双段 dock：任务段/活动段/WAITING 独占/降级单段/节流 ----------
{
  check(api.dockExclusiveOf({ status: "WAITING", waiting_request: { request_id: "r1" } }) === true,
    "③ WAITING + waiting_request → 等待卡独占 dock（硬条款）");
  check(api.dockExclusiveOf({ status: "WAITING", waiting_request: { decidable: false } }) === true,
    "③ 被动等待（decidable:false）同独占——与 waitbox 显隐同口径（CLI 本地等待也在显）");
  check(api.dockExclusiveOf({ status: "WAITING" }) === false, "③ WAITING 无等待请求 → 不独占");
  check(api.dockExclusiveOf({ status: "WAITING", waiting_request: {}, historical: true }) === false,
    "③ 历史会话不独占（waitbox 对历史隐藏同口径）");
  check(api.dockExclusiveOf({ status: "WORKING", waiting_request: {} }) === false && api.dockExclusiveOf(null) === false,
    "③ 非 WAITING/空入参 → 不独占");
  check(api.dockTaskOf([]) === null && api.dockTaskOf(undefined) === null && api.dockTaskOf("junk") === null,
    "③ 任务段：空/缺失/非数组 → null（整段不渲染，无假 0/0）");
  const t1 = api.dockTaskOf([
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress", active_form: "正在写 B" },
    { content: "c", status: "pending" },
  ]);
  check(!!t1 && t1.done === 1 && t1.total === 3 && t1.current === "正在写 B" && t1.text === "任务 1/3 · 正在写 B",
    "③ 任务段摘要：完成数/总数 + in_progress 条目（active_form 优先）");
  check(api.dockTaskOf([{ content: "a", status: "in_progress" }])?.current === "a",
    "③ active_form 缺省回落 content");
  check(api.dockTaskOf([{ content: "a", status: "completed" }, { content: "b", status: "pending" }])?.current === "",
    "③ 无 in_progress → current 空（不猜下一个）");
  check(api.dockTaskOf([{ status: "in_progress" }, { content: "", status: "x" }]) === null,
    "③ 无 content 条目滤除（滤后空 → null）");
  const prev = { state: "WORKING", activity: { text: "编辑 x.ts" }, updated_at: 1000 };
  const same = { state: "WORKING", activity: { text: "编辑 x.ts" } };
  check(api.dockActivityThrottled(prev, same, 1500, 1000) === true, "③ 节流：同态同文窗口内（500ms<1s）→ 刷账拦截");
  check(api.dockActivityThrottled(prev, same, 2100, 1000) === false, "③ 节流：过窗（1.1s>1s）→ 放行");
  check(api.dockActivityThrottled(prev, { state: "WORKING", activity: { text: "读 y.ts" } }, 1001, 1000) === false,
    "③ 节流：文本一变立即放行（不牺牲新鲜度）");
  check(api.dockActivityThrottled(prev, { state: "WAITING", activity: { text: "编辑 x.ts" } }, 1001, 1000) === false,
    "③ 节流：状态一变立即放行");
  check(api.dockActivityThrottled(null, same, 1500, 1000) === false
    && api.dockActivityThrottled(prev, { state: "WORKING", activity: { text: "编辑 x.ts" } }, 500, 1000) === false,
    "③ 节流：无前值/时钟回退（乱序 observed_at）放行不节流");
  const w = api.dockSegmentsOf({ session: { status: "WAITING", waiting_request: {} }, activityText: "编辑 x.ts" });
  check(w.waiting === true && w.task === null && w.activity === null,
    "③ 双段投影：独占期两段 null（含收口条调用方一并让位——等待只渲染一处）");
  const single = api.dockSegmentsOf({
    session: { todos: [{ content: "a", status: "pending" }] },
    activityText: "x", activityCap: false,
  });
  check(single.waiting === false && !!single.task && single.activity === null,
    "③ 旧 relay 无 activity（能力关）→ 活动段 null 单段降级（任务段保留）");
  check(api.dockSegmentsOf({ session: {}, activityText: "" }).activity === null,
    "③ 无 activity 数据 → 活动段 null（无假空闲行）");
  const both = api.dockSegmentsOf({
    session: { todos: [{ content: "a", status: "completed" }] },
    activityText: "  编辑 x.ts  ", activityTool: "Edit", activityCap: true,
  });
  check(!!both.task && !!both.activity && both.activity.text === "编辑 x.ts" && both.activity.tool === "Edit",
    "③ 双段齐显：activity 文本 trim + tool 透传（标题行用）");
  check(api.dockSegmentsOf({ session: {}, activityText: "x", activityCap: undefined }).activity !== null,
    "③ 能力位缺字段 ≠ false → 活动段放行（旧快照无 capability 字段不误杀）");
}

// ---------- ④ done/error 收口：ERROR 常驻 / DONE 尾窗 / 收口接线 ----------
{
  const c1 = api.dockClosingOf({ status: "ERROR", last_error: "编译失败" }, 1000);
  check(!!c1 && c1.kind === "error" && c1.text === "编译失败", "④ ERROR ⚠ 常驻：last_error 透传");
  check(api.dockClosingOf({ status: "ERROR" }, 1000)?.text === "出错了", "④ ERROR 无 last_error → 兜底可读文案（不裸奔）");
  const doneS = { status: "DONE", activity: { state: "DONE", updated_at: 9000 } };
  check(api.dockClosingOf(doneS, 12000, 8000)?.kind === "done", "④ DONE ✓ 尾窗内（3s<8s）→「本轮已完成」");
  check(api.dockClosingOf(doneS, 17001, 8000) === null, "④ DONE 过窗（8.001s）→ 自隐（静息态不常驻收口条）");
  check(api.dockClosingOf({ status: "DONE", activity: { state: "DONE", updated_at: 9000 } }, 8000, 8000) === null,
    "④ DONE age<0（updated_at 在未来）→ 不显示（不做负时长）");
  check(api.dockClosingOf({ status: "DONE", activity: { state: "WORKING", updated_at: 9000 } }, 12000, 8000) === null,
    "④ DONE 但 activity.state 未落 DONE → 不显示（等权威终态）");
  check(api.dockClosingOf({ status: "DONE" }, 1000, 8000) === null, "④ DONE 无 activity → 不显示");
  check(api.dockClosingOf({ status: "WORKING" }, 1000, 8000) === null, "④ WORKING → 无收口条（活动段在岗）");
  check(api.dockClosingOf({ status: "DONE", activity: { state: "DONE", updated_at: 1000 } }, 3000, 1000) === null
    && api.dockClosingOf({ status: "DONE", activity: { state: "DONE", updated_at: 1000 } }, 3000, 2000)?.kind === "done",
    "④ tailMs 参数化（缺省 8000）——尾窗边界随调用方口径");
  check(api.dockClosingOf(null, 1000) === null, "④ 空入参 → null（不崩）");
}

// ---------- ⑤ 结构自查闸（018 §5.5 + W2a 接线静态锚点） ----------
{
  const closeIdx = html.lastIndexOf("</html>");
  check(closeIdx > 0 && html.slice(closeIdx + "</html>".length).trim() === "",
    "⑤ `</html>` 后零内容（防 markup 被追加到文件尾）");
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(ids).size === ids.length, `⑤ 静态 markup 无重复 id（共 ${ids.length} 个）`);
  const jsIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(jsIds).size === jsIds.length, `⑤ 全文（含脚本内模板）无重复 id（共 ${jsIds.length} 个）`);
  check(!/document\.|window\.|querySelector/i.test(segCode), "⑤ W2A 段零 DOM 依赖（无 document/window/querySelector 引用）");
  check(!segCode.includes("Date.now"), "⑤ W2A 段不取时（now 由调用方注入——断言无两个取时点问题）");
  check(html.includes('if (streamMergeDecide(list[i], e) === "skip") return;'),
    "⑤ 接线① pushLog 残帧不回退：skip 判定在存储层同 id 分支消费");
  check(html.includes("const renderKey = [s.session_id, activeTab, s.status,"),
    "⑤ 接线② renderKey 含会话态：终态翻帧触发时间线重建（揭标生效面）");
  check(html.includes('escapeHtml(head ? head.name : "Claude")') && html.includes('class="ai-meta"'),
    "⑤ 接线③ 头像行身份动态化：引擎名转义输出 + 成员元信息行（原写死 Claude 移除）");
  check(html.includes("renderTimeline(list, aiHeadOf(s, sel.ctx.projects), s.status)"),
    "⑤ 接线④ 身份/状态线程化：renderTimeline → entryHtml（head+status 注入）");
  check((html.match(/id="dockTodoRow"/g) || []).length === 1 && (html.match(/id="dockCloseRow"/g) || []).length === 1
    && (html.match(/id="dockActivityRow"/g) || []).length === 1,
    "⑤ 接线⑤ dock 三行 markup 各恰一处（任务段/收口条/活动段）");
  check(html.includes('tr.classList.toggle("show", !seg.waiting && !!seg.task)')
    && html.includes('dar.classList.toggle("show", !seg.waiting && !!seg.activity)')
    && html.includes('cr.classList.toggle("show", !!closing)'),
    "⑤ 接线⑥ WAITING 独占硬条款：任务/活动段随 seg.waiting 让位，收口条独立显隐");
  check(html.includes("dockActivityThrottled(prevDock, nextDock, observedAt, 1000)"),
    "⑤ 接线⑦ 活动段节流在 SESSION_ACTIVITY 账面写入口消费（1s 窗口）");
  check(html.includes("if (!ctx.timelines.has(sid)) ctx.timelines.set(sid, []);")
    && html.includes("sel.ctx.timelines.get(s.session_id)"),
    "⑤ 跨会话帧隔离：pushLog 按 sid 分桶写 + 渲染只取当前选中会话（跨会话帧不串桶不串显）");
  check(html.includes('const role = msgRoleOf(e.kind);') && !html.includes('if (e.kind === "user_message")'),
    "⑤ role 判定单点化：entryHtml 分支由 msgRoleOf 驱动（kind 直判移除）");
  check(html.includes(".notice-row:hover .nr-title { color: var(--text-strong); }")
    && !html.includes(".notice-row:hover { background:"),
    "⑤ 通知列表观感修正（同批顺带）：hover 底色移除，反馈降为标题微亮");
}

finish();
