// W-TEAMPOPOLISH（1105 用户令「新建团队弹窗三路审查落地优化」）——静态闸+行为断言。
// 范式对齐 test-277（真源码抽取直跑）：靶子 web-console/js/team-domain.js + css/base.css。
// 断言组（对应任务书 14 项）：
//   A 排印（A1+C4：h3 14/600+label sans/ls0）· B1 loopback hint 联动（行为 eval）
//   C1 动效（tcp-enter 两端持 translate+backdrop fade+kill list）· C2 表面（三层影+高光+压暗）
//   C3 焦点环 · A2 浏览钮同质感 · A3 高度两档 · C5 蓝框中性化 · B2 副标题删+tier 动态 hint
//   A4+C4 断词（文案 ≤32 字当量+keep-all）· B3 blur 内联校验+提交前置内联化
//   B4 两列行+紧凑空态 · P3 主钮渐变/×28/bezel · ⑭ prefill 参数位
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const td = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string): string {
  // 顶层函数边界截取（到下一个缩进 16 空格的 function 声明）——比找裸 } 稳（函数体嵌套不误断）
  const i = td.indexOf(needle);
  if (i < 0) return "";
  const j = td.indexOf("\n                function ", i + needle.length);
  return j > i ? td.slice(i, j) : td.slice(i, i + 2400);
}
// 字当量：CJK 记 1、ASCII 记 0.5（审查口径 ≤32 字当量）
const zhLen = (s: string) => [...s].reduce((n, ch) => n + (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(ch) ? 1 : 0.5), 0);

// ---------- B1 loopback hint（行为 eval：造 stub 跑真函数） ----------
{
  const code = blockFrom("function teamAnchorBrowseable") + "\n" + blockFrom("function teamAnchorHint");
  const run = (stub: Record<string, unknown>) => {
    const fn = new Function("window", code + "; return teamAnchorHint;")(stub);
    return fn as (which: string) => string;
  };
  // loopback 可浏览（Tauri+loopback 双真）→ 本机文案与浏览钮真值联动
  const hintLoop = run({ __TAURI__: { dialog: {} }, __ccDeck005LocalRelayLoopback: () => true, __ccDeck005PlatformFor: () => "darwin" })("local");
  ok(hintLoop === "路径在本机 relay 上，可点浏览直接选择", `B1 loopback 可浏览→联动文案（得「${hintLoop}」）`);
  // 非 loopback 本机（浏览器宿主）→ 宿主机文案（不再自相矛盾）
  const hintNo = run({ __ccDeck005PlatformFor: () => "darwin" })("local");
  ok(hintNo.includes("relay 宿主机") && hintNo.includes("/Users/"), `B1 非浏览态→宿主机文案（得「${hintNo}」）`);
  // 远程源恒不联动（浏览钮隐藏态文案不含「浏览」）
  const hintCloud = run({ __TAURI__: { dialog: {} }, __ccDeck005LocalRelayLoopback: () => true, __ccDeck005PlatformFor: () => "win32" })("cloud");
  ok(hintCloud.includes("那台电脑") && !hintCloud.includes("浏览"), `B1 远程源不误标可浏览（得「${hintCloud}」）`);
}

// ---------- A1+C4 排印 / A2 同质感 / A3 高度 ----------
{
  ok(/\.create-pop h3 \{[^}]*font-size: 14px;[^}]*font-weight: 600;/.test(css), "A1 h3 14px/600（标题-正文倒挂归位，全 create 弹窗共享）");
  ok(/\.create-label \{[^}]*font: 600 var\(--fs-B\) var\(--sans\);[^}]*letter-spacing: 0;/.test(css), "A1+C4 label 600 12px sans ls=0（mono/uppercase 退役，CJK 字距不再落空）");
  ok(!/create-label[^}]*--mono/.test(css), "A1+C4 label 无 mono 残留");
  ok(!td.includes('"secondary-btn create-browse"'), "A2 浏览钮删 secondary-btn 类（与输入同质感）");
  ok(/\.engine-picker \{[^}]*min-height: 32px;/.test(css), "A3 engine-picker 34→32（控件档归一）");
  ok(/\.team-cand \.team-cand-role \{[^}]*height: 28px;/.test(css), "A3 成员行档 28（cand-role 26→28）");
  ok(/\.create-pop \.primary-btn, \.create-pop \.secondary-btn \{ min-height: 32px; \}/.test(css), "A3 弹窗域钮高 32（全站 34 档不牵连）");
}

// ---------- C1 动效 / C2 表面 / C3 焦点环 ----------
{
  ok(/@keyframes tcp-enter \{ from \{ opacity: 0; transform: translate\(-50%, calc\(-50% \+ var\(--dist-m\)\)\) scale\(\.97\); \} to \{ opacity: 1; transform: translate\(-50%, -50%\); \} \}/.test(css), "C1 tcp-enter 两端持 -50% 居中（translateY+scale .97，np-enter 不可直用的根因已处理）");
  ok(/\.create-pop \{[^}]*animation: tcp-enter var\(--dur-enter\) var\(--ease-out\);/.test(css), "C1 create-pop 消费动效 token（--dur-enter/--ease-out）");
  ok(/@keyframes backdrop-fade/.test(css) && /\.pair-pop-backdrop \{[^}]*animation: backdrop-fade/.test(css), "C1 backdrop fade 入场");
  const kill = css.match(/@media \(prefers-reduced-motion: reduce\)[^{]*\{[\s\S]*?\n\}/g)?.find((b) => b.includes("kill list")) ?? "";
  ok(kill.includes(".create-pop") && kill.includes(".pair-pop-backdrop"), "C1 tcp-enter/backdrop-fade 入 reduced-motion kill list");
  ok(/\.create-pop \{[^}]*box-shadow: 0 1px 2px rgba\(0,0,0,\.30\), 0 8px 24px rgba\(0,0,0,\.38\), 0 24px 64px rgba\(0,0,0,\.32\), inset 0 1px 0/.test(css), "C2 三层影+inset 顶部高光（notifpanel 分层语言）");
  ok(/\.pair-pop-backdrop \{[^}]*color-mix\(in srgb, var\(--text-strong\) 16%, transparent\)/.test(css), "C2 backdrop 白雾→压暗 16%（text-strong 混合）");
  // R1（A 审 P1 双失明补盲）：原断言只证「16% 档存在」不证「唯一」——:3201 旧 bg0 72% 档
  // 同特异度源序在后恒胜，正则两处各自命中=测试绿而运行时白雾。单源守卫：backdrop 的
  // background 声明全文件只允许 :231 一处（含 16% 档），bg0 混合档零残留。
  const bdBlocks = css.match(/\.pair-pop-backdrop \{[^}]*\}/g) ?? [];
  ok(bdBlocks.filter((b) => /background/.test(b)).length === 1 && !/var\(--bg0\) 72%/.test(css), `C2 backdrop 单源守卫（含 background 的定义块=${bdBlocks.filter((b) => /background/.test(b)).length} 处，bg0 72% 旧档零残留）`);
  ok(/\.create-field:focus \{[^}]*border-color: var\(--brand-hover\);[^}]*box-shadow: 0 0 0 3px var\(--focus-ring\);/.test(css), "C3 焦点环：brand-hover 描边+focus-ring 3px（token 首消费）");
}

// ---------- B2 副标题删+tier 动态 hint / B4 两列+紧凑空态 ----------
{
  ok(!td.includes('class="create-sub">需确认的新建项目会在确认卡上请你决议'), "B2 头部副标题退役（答非所问行删除）");
  ok(td.includes('TEAM_TIER_HINTS = { "轻立项": "创建即生效", "正经立项": "提交后在确认卡上等你决议" }'), "B2 档位后果文案入库（决策点可见）"); // W-AGGFIX A5：hint 与选项文案去重（「日常免确认」留选项侧）——断言随文案演进
  ok(td.includes('[data-team-tier-hint]') && td.includes("teamTierHint(tierSel.value)"), "B2 tier hint 随选项动态切换（change 联动）");
  ok(/\.create-two \{ display: grid; grid-template-columns: 1fr 1fr;/.test(css), "B4 团队名+立项档并排两列行");
  ok(/@media \(max-width: 400px\) \{ \.create-two \{ grid-template-columns: 1fr; \} \}/.test(css), "B4 窄屏折行保竖排");
  ok(td.includes('class="team-empty-row"') && td.includes("＋ 添加</button></div>"), "B4 空态 banner+添加钮合并一行");
  ok(td.includes('if (defCands.length) html += \'<button type="button" class="team-add-btn" data-team-add-member>＋ 添加成员</button>\';'), "B4 空态不重复渲染底部添加钮");
  ok(td.includes('team-empty-row")?.remove();'), "B4 首条手动行入列撤空态行");
}

// ---------- A4+C4 断词+文案长度 ----------
{
  const hints = ["路径在本机 relay 上，可点浏览直接选择", "路径在那台电脑（Windows）上——形如 C:\\Users\\名字\\项目", "路径在那台电脑上——形如 /Users/名字/项目", "路径在那台电脑上——按它的系统填绝对路径", "路径在 relay 宿主机（Windows）上——形如 C:\\Users\\名字\\项目", "路径在 relay 宿主机上——形如 /Users/名字/项目", "创建即生效，日常免确认", "提交后在确认卡上等你决议", "该源暂无可入编会话，可先建团稍后补员", "命令通道未接入，无法提交创建。"];
  ok(hints.every((h) => zhLen(h) <= 32), `A4+C4 hint/banner 全线 ≤32 字当量单行（最长 ${Math.max(...hints.map(zhLen)).toFixed(1)}）`);
  ok(/\.create-pop \.create-hint \{[^}]*word-break: keep-all;[^}]*overflow-wrap: anywhere;/.test(css), "A4+C4 keep-all 断词兜底（路径串不被拆，超长串才断）");
  // P3 术语后果化：用户面产出（字符串/option 文案）绝迹——注释里的历史记述不算（改动说明需引用术语名）
  const tdCode = td.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ok(!tdCode.includes("一锚一团") && !tdCode.includes("单卡简化态"), "P3 术语后果化（用户面「一锚一团」「单卡简化态」绝迹，注释记述除外）");
}

// ---------- B3 blur 内联校验 ----------
{
  ok(td.includes('pop.addEventListener("focusout"') && td.includes("teamNameValidate(pop)"), "B3 focusout→name 校验挂钩");
  ok(td.includes("teamAnchorValidate(pop)"), "B3 anchor 校验挂钩");
  ok(td.includes('classList.add("create-err")') && td.includes('note.className = "create-err-note"'), "B3 内联错误态（描边+尾随提示行）");
  ok(td.includes("state.projects || []).some((p) => p && p.name === name)"), "B3 重名对照已载团队列表（不重拉）");
  ok(!td.includes('toast("先填团队名")') && !td.includes('toast("锚点目录需是绝对路径'), "B3 提交前置校验退役 toast（错误就近内联；toast 只留传输层失败）");
  ok(/\.create-field\.create-err[^{]*\{[^}]*border-color: var\(--danger-line\);/.test(css), "B3 错误态 CSS（danger 描边）");
}

// ---------- C5 蓝框中性化 / P3 主钮渐变+×28+bezel ----------
{
  ok(/#team-create-pop \.readonly-banner \{[^}]*var\(--line-soft\)[\s\S]{0,120}var\(--surface1\)[\s\S]{0,80}var\(--dim\)/.test(css), "C5 弹窗域 banner 中性化（surface1+line-soft+dim，单 accent 留主钮）");
  ok(/\.primary-btn \{ background: linear-gradient\(180deg, var\(--brand-hover\), var\(--brand-strong\)\)/.test(css), "P3 主钮渐变端点 brand-hover/brand-strong（起点不发灰，一处改全线）");
  ok(/\.create-x \{[^}]*width: 28px; height: 28px;/.test(css), "P3 × 命中区 28px");
  ok(/\.secondary-btn \{[^}]*box-shadow: inset 0 -1px 0/.test(css), "P3 次级钮 bezel 底缘");
}

// ---------- ⑭ prefill 参数位 ----------
{
  ok(td.includes("function openTeamCreate(prefill = null)"), "⑭ openTeamCreate prefill 参数位（缺省 null 行为与旧版一致）");
  ok(td.includes('data-team-origin-note') && td.includes("来自聚合推荐"), "⑭ 「来自聚合推荐」溯源小注位");
  ok(td.includes("pf.tier === \"轻立项\" || pf.tier === \"正经立项\"") && td.includes("escape(pf && pf.name"), "⑭ name/tier 预填消费位");
  ok(td.includes("Array.isArray(pf.members)") && td.includes("data-team-member=\"' + cssEscape"), "⑭ members 预勾参数位（sid 命中候选行）");
}

// ---------- 277 锚回归（关键锚不破） ----------
{
  ok(td.includes('data-team-field="source"') && td.includes("teamCandsForSource(srcSel.value"), "277 锚：源选择器+候选联动在位");
  ok(td.includes("data-team-anchor-browse") && td.includes("data-team-anchor-hint"), "277 锚：浏览钮/hint 锚在位");
  ok(td.includes("anchorFormatOk(anchor)"), "277 锚：格式校验函数仍在消费");
}

console.log(fail === 0 ? `\nteampolish: ${pass} passed, 0 failed` : `\nteampolish: ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
