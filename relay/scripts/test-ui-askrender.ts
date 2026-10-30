// W-UI-ASKRENDER：AskUserQuestion 结构化问卷卡渲染——行为级 + 源码面断言。
// 范式：真源码抽取直跑（test-282/273 同范式），靶子 session-domain/mobile/base.css。
//
// 断言组：
//   A parseAskDetail：完整解析 / capDetail 截断抢救 / 垃圾与缺失回落 null / 帽对齐 relay（4问6项）/
//     multiSelect 归一 multi / 对象形（{"questions":...}）兼容 / 问句内嵌 '}' 抢救不炸
//   B askGroupsHtml：static（纯展示无钮）/ single（data-wait-answer 序号链）/ multi
//     （data-wait-chip qi:oi + wc-label + wc-check）/ 含预览标记 / 可多选标
//   C askPreviewFlagsFor：末位 ask 条目对齐借源 / 不匹配不回溯 / 无时间线 null
//   D entryHtml 行为级：折叠摘要+header 标签 / 展开问卷卡 / 反解析失败回落通用 trow /
//     Bash 行零回归（copy-btn 保留）/ Task 行零回归（data-role=task + task-life）
//   E syncWaitCard 源码面：「／」拼接退役 / 四路径（single/multi/passive/90s 超时）接问卷 /
//     提交链 data-wait-submit·data-wait-answer·data-wait-deny 保留
//   F mobile：mWaitCardHtml B2 就绪走 askGroupsHtml 静态问卷 + 回落旧形态 / 调用点传 s
//   G B2 导出面：askGroupsHtml/askPreviewFlagsFor 挂出
//   H CSS：同族样式类齐备（.ask-card/.wq-opt/.wait-chip.row/.wo-prev/.ask-tag）
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-ui-askrender.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ssd = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
const mb = readFileSync(join(root, "web-console", "js", "mobile.js"), "utf-8");
const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string, zone: string): string {
  // W-UI-ASKRENDER 专用抽取：函数体内字符串字面量可含 '}'（askSalvageJson 的闭合尾表），
  // 括号计数法会被骗——改取「needle 起 → 下一个同缩进 function/注释行边界」
  const i = zone.indexOf(needle);
  if (i < 0) return "";
  const rest = zone.slice(i + needle.length);
  const m = /\n                (?:function |\/\/ |const )/.exec(rest);
  return m ? zone.slice(i, i + needle.length + m.index) : zone.slice(i);
}

console.log("W-UI-ASKRENDER：AskUserQuestion 结构化问卷卡");

// ---------- 公共桩 + 抽取 ----------
const escSrc = blockFrom("function esc(", ssd);
const oneLineSrc = blockFrom("function oneLine(", ssd);
const parseSrc = blockFrom("function parseAskDetail(", ssd);
const salvageSrc = blockFrom("function askSalvageJson(", ssd);
const groupsSrc = blockFrom("function askGroupsHtml(", ssd);
const flagsSrc = blockFrom("function askPreviewFlagsFor(", ssd);
ok(!!(parseSrc && salvageSrc && groupsSrc && flagsSrc && escSrc && oneLineSrc), "源码抽取：六个函数块齐备");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bag: Record<string, any> = {};
const S = { timelines: new Map() }; // askPreviewFlagsFor 闭包 S 经构造器形参注入
new Function("bag", "S", escSrc + oneLineSrc + salvageSrc + parseSrc + groupsSrc + flagsSrc
  + "\nObject.assign(bag, { esc, oneLine, parseAskDetail, askGroupsHtml, askPreviewFlagsFor });")(bag, S);
const esc = bag.esc as (v: unknown) => string;
const oneLine = bag.oneLine as (t: unknown) => string;
const parseAskDetail2 = bag.parseAskDetail as (d?: string) => any;
const askGroupsHtml2 = bag.askGroupsHtml as (qs: any, flags: any, mode: string) => string;
const askPreviewFlagsFor2 = bag.askPreviewFlagsFor as (s: any, w: any) => any;

// ---------- A parseAskDetail ----------
const D1 = 'questions: [{"question":"用哪个数据库？","header":"选库","options":[{"label":"SQLite","description":"嵌入式零运维"},{"label":"PostgreSQL","description":"独立服务","preview":"CREATE TABLE…"}],"multiSelect":true}]';
{
  const qs = parseAskDetail2(D1);
  ok(qs && qs.length === 1, "A1 完整解析：1 问");
  ok(qs[0].multi === true, "A1 multiSelect → multi 归一");
  ok(qs[0].options.length === 2 && qs[0].options[0].label === "SQLite" && qs[0].options[0].desc === "嵌入式零运维", "A1 选项 label/description 解析");
  ok(qs[0].options[1].preview === true && qs[0].options[0].preview === false, "A1 preview 在位标记（第二项 true 首项 false）");
  ok(qs[0].header === "选库", "A1 header 解析");
}
{
  // capDetail 2000 帽截断形态一：切在选项区（'}' 之后）——平衡器/回退双路径可救
  const big1 = { question: "切在选项区的长问句？", header: "截断A", options: [{ label: "A", description: "x".repeat(300), preview: "code" }, { label: "B", description: "y".repeat(300) }] };
  const f1 = JSON.stringify([big1]);
  const qs1 = parseAskDetail2("questions: " + f1.slice(0, 260) + "… (+" + (f1.length - 260) + " 字符)");
  ok(qs1 !== null && qs1.length === 1, "A2 截断抢救（选项区切断）：可部分恢复（得 " + (qs1 ? qs1.length : "null") + " 问）");
  // 截断形态二：切在首问超长题干中间（首个 '}' 之前——平衡器主路径的用武之地）
  const big2 = { question: "长问" + "很长的描述".repeat(400), header: "截断B", options: [{ label: "A" }, { label: "B" }] };
  const f2 = JSON.stringify([big2]);
  const qs2 = parseAskDetail2("questions: " + f2.slice(0, 900) + "… (+" + (f2.length - 900) + " 字符)");
  ok(qs2 !== null && qs2.length === 1 && qs2[0].header === String(qs2[0].question).slice(0, 24), "A2 截断抢救（题干中段切断·无 '}' 锚点）：平衡器拼回，header 回落题干前缀");
}
{
  ok(parseAskDetail2("questions: [乱码不是JSON") === null, "A3 垃圾 detail → null（回落通用渲染）");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ok(parseAskDetail2(undefined as any) === null, "A4 detail 缺失 → null");
}
{
  const qs = parseAskDetail2('questions: [' +
    Array.from({ length: 5 }, (_, i) => '{"question":"问' + i + '","header":"h' + i + '","options":' + JSON.stringify(Array.from({ length: 7 }, (_, j) => ({ label: "o" + j }))) + '}').join(",") + "]");
  ok(qs.length === 4, "A5 帽对齐 relay：5 问 → 4（parseAskQuestions 同帽）");
  ok(qs.every((q: any) => q.options.length === 6), "A5 选项帽：7 项 → 6");
}
{
  const qs = parseAskDetail2('{"questions":[{"question":"对象形兼容？","options":[{"label":"是"}]}]}');
  ok(qs && qs.length === 1 && qs[0].question === "对象形兼容？", "A6 对象形（{\"questions\":…}）兼容");
}
{
  const qs = parseAskDetail2('questions: [{"question":"含 } 花括号的问句？","header":"h","options":[{"label":"A"}]},');
  ok(qs !== null && qs[0].question === "含 } 花括号的问句？", "A7 问句内嵌 '}' + 尾逗号截断 → 抢救成功不炸");
}
{
  const qs = parseAskDetail2('questions: [{"header":"无题干"}]');
  ok(qs === null, "A8 无 question 条目被滤 → null（不产空问卡）");
}

// ---------- B askGroupsHtml ----------
const QS = [
  { header: "选库", question: "用哪个数据库？", multi: false, options: [{ label: "SQLite", desc: "嵌入式零运维", preview: false }, { label: "PostgreSQL", desc: "独立服务", preview: true }] },
  { header: "部署", question: "部署到哪？", multi: true, options: [{ label: "内网", desc: "", preview: false }, { label: "云端", desc: "公网可达", preview: false }] },
];
const FLAGS = QS.map((q) => q.options.map((o) => o.preview));
{
  const h = askGroupsHtml2(QS, FLAGS, "static");
  ok(h.includes('data-wait-qgroup="0"') && h.includes('data-wait-qgroup="1"'), "B1 static：每问一卡（2 组）");
  ok(!h.includes("<button"), "B1 static：纯展示零按钮（时间线/只读面）");
  ok(h.includes("wo-desc") && h.includes("嵌入式零运维") && h.includes("独立服务"), "B1 选项 description 次行");
  ok(h.includes("含预览"), "B1 preview 标记渲染");
  ok((h.match(/含预览/g) || []).length === 1, "B1 仅带 preview 选项标记（1/4 项）");
  ok(h.includes("可多选"), "B1 multiSelect → 可多选标");
}
{
  const h = askGroupsHtml2([QS[0]], [FLAGS[0]], "single");
  ok(h.includes('data-wait-answer="0"') && h.includes('data-wait-answer="1"'), "B2 single：选项行 data-wait-answer 序号链（原 handleWaitAnswer 链）");
  ok(!h.includes("data-wait-chip"), "B2 single：不带多选 chip 链");
}
{
  const h = askGroupsHtml2(QS, FLAGS, "multi");
  ok(h.includes('data-wait-chip="0:0"') && h.includes('data-wait-chip="1:1"'), "B3 multi：chip qi:oi 定位链（原 toggle 链）");
  ok(h.includes('class="wait-chip row"') && (h.match(/wc-label/g) || []).length === 4, "B3 multi：wait-chip row 变体 + wc-label（handleWaitSubmit 读值链）");
  ok((h.match(/wc-check/g) || []).length === 4, "B3 multi：选项行均带勾选位（row 变体统一选择位形态）");
}
{
  // B4 双来源语义：选项自带 preview（时间线反解析形）直显；flags 借源（等待卡 relay 形）
  // 仅叠加。无 preview 且无 flags → 零标记（降级不阻塞）
  const bare = [{ header: "h", question: "q", multi: false, options: [{ label: "A", desc: "" }, { label: "B", desc: "" }] }];
  ok(!askGroupsHtml2(bare, null, "static").includes("含预览"), "B4 无 preview 无 flags → 零 preview 标（降级不阻塞）");
  ok(askGroupsHtml2(QS, null, "static").includes("含预览"), "B4 选项自带 preview → 直显（时间线卡主路径）");
  const relayShape = [{ header: "h", question: "q", multi: false, options: [{ label: "A", description: "d" }, { label: "B", description: "d2" }] }];
  ok(askGroupsHtml2(relayShape, [[false, true]], "static").includes("含预览"), "B4 relay 形选项（description 字段）+ flags 借源 → 标记叠加；desc 双兼容");
}

// ---------- C askPreviewFlagsFor ----------
{
  const sid = "s-flag";
  const w = { questions: [{ question: "用哪个数据库？", header: "选库", multi: true, options: [{ label: "SQLite" }, { label: "PostgreSQL" }] }] };
  ok(askPreviewFlagsFor2({ session_id: sid }, w) === null, "C1 无时间线 → null");
  S.timelines.set(sid, [{ kind: "tool_use", tool: "AskUserQuestion", detail: D1 }]);
  const fl = askPreviewFlagsFor2({ session_id: sid }, w);
  ok(Array.isArray(fl) && fl[0][1] === true && fl[0][0] === false, "C2 末位 ask 条目对齐 → preview 借源成功");
  S.timelines.set(sid, [{ kind: "tool_use", tool: "AskUserQuestion", detail: 'questions: [{"question":"完全另一个问题","options":[{"label":"x"}]}]' }]);
  ok(askPreviewFlagsFor2({ session_id: sid }, w) === null, "C3 题干不匹配 → null（不回溯旧条目防错配）");
}

// ---------- D entryHtml 行为级 ----------
{
  const entrySrc = blockFrom("function entryHtml(", ssd);
  ok(!!entrySrc, "D0 entryHtml 抽取");
  const stubs: Record<string, unknown> = {
    esc, oneLine,
    msgRoleOf: (k: string) => k === "user_message" ? "user" : k === "assistant_text" ? "ai-text" : k === "thinking" ? "ai-think" : k === "tool_use" ? "ai-tool" : k === "tool_result" ? "ai-result" : "ai-sys",
    eKey: (e: { id?: string; ts: number; kind: string; text?: string }) => e.id || (e.ts + "|" + e.kind + "|" + (e.text || "").length),
    expanded: new Set<string>(),
    thinkShown: false,
    isAutoInjected: () => false,
    userMsgHtml: (t: string) => t, bubbleImgHtml: () => "", fmtHM: () => "12:00",
    engineMetaOf: () => ["Claude", "claude"],
    ENGINE_BRAND_SVG: {}, b2SourceColor: () => "#888", mdHtml: (t: string) => t,
    isStreaming: () => false, isTaskLifeTool: (t: string) => t === "TaskCreate" || t === "TaskUpdate",
    taskLifeIcon: () => "", toolIcon: () => "⚙", taskRefRow: (t: string) => String(t),
    parseAskDetail: parseAskDetail2, askGroupsHtml: askGroupsHtml2, cssEsc: (t: string) => t,
    UI: { convPane: null }, S: null,
  };
  const mk = new Function(...Object.keys(stubs), entrySrc + "\nreturn entryHtml;")(...Object.values(stubs));
  const sStub = { engine: "claude" };
  const eAsk = { kind: "tool_use", tool: "AskUserQuestion", text: "AskUserQuestion", detail: D1, ts: 1 };
  const h1 = mk(eAsk, sStub);
  ok(h1.includes("ask-tag") && h1.includes("1 个问题") && h1.includes("选库"), "D1 折叠态：友好摘要（1 个问题 · 首问截断）+ header 标签行");
  ok(!h1.includes("tdetail") && !h1.includes("&quot;question"), "D1 折叠态：不再出现拍扁 JSON");
  ok(!h1.includes("ask-card"), "D1 折叠态：问卷卡不渲染");
  (stubs.expanded as Set<string>).add((stubs.eKey as (e: unknown) => string)(eAsk));
  const h2 = mk(eAsk, sStub);
  ok(h2.includes("ask-card") && h2.includes("wait-qgroup") && h2.includes("SQLite") && h2.includes("嵌入式零运维") && h2.includes("含预览") && h2.includes("可多选"), "D2 展开态：完整问卷卡（题卡+选项+描述次行+含预览+可多选）");
  ok(h2.includes("收起 ▴"), "D2 展开态：收起把手");
  const eBad = { kind: "tool_use", tool: "AskUserQuestion", text: "AskUserQuestion", detail: "questions: [截断了没法救", ts: 2 };
  const h3 = mk(eBad, sStub);
  ok(h3.includes("tdetail") || h3.includes("AskUserQuestion"), "D3 反解析失败 → 回落通用 trow（零回归兜底）");
  const eBash = { kind: "tool_use", tool: "Bash", text: "执行 ls -la", detail: "$ ls -la", ts: 3 };
  const h4 = mk(eBash, sStub);
  ok(h4.includes('data-copy') && h4.includes("tname") && h4.includes("执行"), "D4 Bash 行零回归（copy-btn/摘要保留）");
  const eTask = { kind: "tool_use", tool: "TaskCreate", text: "新建 某任务", ts: 4 };
  const h5 = mk(eTask, sStub);
  ok(h5.includes('data-role="task"') && h5.includes("task-life"), "D5 TaskCreate 行零回归（生命周期行不进过程组）");
}

// ---------- E syncWaitCard 源码面 ----------
{
  ok(!ssd.includes('join(" ／ ")'), "E1 「／」拼接纯文本退役（session-domain 全域无残留）");
  ok(ssd.includes('askGroupsHtml(w.questions, askPreviewFlagsFor(s, w), "static")'), "E2 passive/超时路径接静态问卷（不可决/失效无作答钮）");
  ok(ssd.includes('single ? "single" : "multi"') && ssd.includes('askGroupsHtml(w.questions, askPreviewFlagsFor(s, w), single'), "E3 可答路径 single/multi 分流接问卷");
  ok(ssd.includes('data-wait-submit') && ssd.includes('data-wait-deny') && (ssd.match(/data-wait-answer/g) || []).length >= 2, "E4 提交链三钩保留（submit/deny/answer）");
}

// ---------- F mobile ----------
{
  ok(mb.includes("api.askGroupsHtml") && mb.includes('askGroupsHtml(w.questions, flags, "static")'), "F1 mWaitCardHtml B2 就绪 → 静态问卷（三面同源）");
  ok(mb.includes("mWaitCardHtml(s.waiting_request, s)"), "F2 调用点传 s（借源 preview 标记需要会话）");
  ok(mb.includes('join(" ／ ")'), "F2 B2 未就绪回落旧形态保留（「／」拼接在 fallback 分支）");
}

// ---------- G B2 导出 ----------
{
  ok(ssd.includes("askGroupsHtml, askPreviewFlagsFor, // W-UI-ASKRENDER"), "G B2 导出面挂出（mobile 复用口）");
}

// ---------- H CSS ----------
{
  for (const cls of [".ask-card", ".wq-opt", ".wait-chip.row", ".wo-prev", ".ask-tag", ".wo-desc", ".wq-opts"])
    ok(css.includes(cls), "H 样式类在位：" + cls);
  ok(css.includes("W-UI-ASKRENDER：AskUserQuestion 结构化问卷卡"), "H 样式块注释锚在位");
}

console.log("");
if (fail > 0) { console.log(fail + " FAILED, " + pass + " passed"); process.exit(1); }
console.log(pass + " passed");
