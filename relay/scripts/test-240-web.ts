// #240-Web：方向键三档 + 点击回焦 + IME 激活路径 测试（worker H）。
// 被测对象 = web-console/index.html 的 240-KB 纯函数锚点段（kbMod/kbModHit/
// sessKeyHit/histKeyHit——localStorage 经 new Function 参数注入桩，构造+运行不需
// 浏览器）+ DOM 交互面的静态结构锚点断言（点击回焦守卫链/IME 路径守卫链——行为面
// node 无法桩测，见回单装机补验清单）+ 结构自查闸（018 §5.5 口径）。
// 语义源：feat-240-rel 397d7a8（三档化+点击回焦）+ bd1a424 web 段（imeClick 路径）。
// 断言无时间比对（键位判定纯布尔）。
// 直跑入口（relay 目录）：
//   env -u CCR_ORG_DIR node --import tsx/esm scripts/test-240-web.ts
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
  console.log(`240 web projection: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

const html = readFileSync(WEB_HTML, "utf8");

// ---------- 锚点提取（240-KB 纯函数段） ----------
const seg = /\/\* 240-KB-START \*\/([\s\S]*?)\/\* 240-KB-END \*\//.exec(html);
check(!!seg, "锚点① 240-KB 段存在且可提取");
check(html.split("240-KB-START").length === 2 && html.split("240-KB-END").length === 2,
  "锚点② START/END 标记全文各只出现一次（提取无歧义）");
const segCode = seg ? seg[1] : "";

type KEv = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };
type KBApi = {
  KB_MOD_KEY: string;
  kbMod(): string;
  kbModHit(ev: KEv): boolean;
  sessKeyHit(ev: KEv): boolean;
  histKeyHit(ev: KEv): boolean;
};
// localStorage 桩：以固定存档值回答 getItem（页面代码原样引用全局 identifier，
// 参数名同名遮蔽注入——构造成功即语法自包含）
const makeApi = (stored: string | null): KBApi =>
  new Function(
    "localStorage",
    segCode + "\nreturn { KB_MOD_KEY: KB_MOD_KEY, kbMod: kbMod, kbModHit: kbModHit, sessKeyHit: sessKeyHit, histKeyHit: histKeyHit };",
  )({ getItem: (_k: string) => stored, setItem: (_k: string, _v: string) => {} }) as KBApi;

const ev = (o: Partial<KEv> = {}): KEv => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

// ---------- ① kbMod 存档兼容（三档 lever，默认 alt，老存档零影响） ----------
{
  check(makeApi(null).kbMod() === "alt", "① 无存档 → 默认 alt（升级零影响）");
  check(makeApi("alt").kbMod() === "alt", "① 存档 alt → alt");
  check(makeApi("ctrl").kbMod() === "ctrl", "① 老存档 ctrl → ctrl（保留不迁移）");
  check(makeApi("none").kbMod() === "none", "① 新存档 none → none");
  check(makeApi("junk").kbMod() === "alt", "① 非法存档值 → 回落默认 alt（不崩）");
  check(makeApi(null).KB_MOD_KEY === "ccd_kb_mod", "① 存储键名 ccd_kb_mod（与 #67 老键共用，同一 lever 档位记忆）");
}

// ---------- ② sessKeyHit 三档九型（切会话键命中） ----------
{
  const none = makeApi("none"), alt = makeApi("alt"), ctrl = makeApi("ctrl");
  check(none.sessKeyHit(ev()) === true, "② 无档 裸↑↓ → 命中（微信式回归）");
  check(none.sessKeyHit(ev({ altKey: true })) === false, "② 无档 Alt+↑↓ → 不命中（让位翻历史）");
  check(none.sessKeyHit(ev({ ctrlKey: true })) === false, "② 无档 Ctrl+↑↓ → 不命中");
  check(alt.sessKeyHit(ev()) === false, "② Alt档 裸↑↓ → 不命中（原语义：裸键不切）");
  check(alt.sessKeyHit(ev({ altKey: true })) === true, "② Alt档 Alt+↑↓ → 命中（零回归）");
  check(alt.sessKeyHit(ev({ ctrlKey: true })) === false, "② Alt档 Ctrl+↑↓ → 不命中");
  check(ctrl.sessKeyHit(ev()) === false, "② Ctrl档 裸↑↓ → 不命中");
  check(ctrl.sessKeyHit(ev({ altKey: true })) === false, "② Ctrl档 Alt+↑↓ → 不命中");
  check(ctrl.sessKeyHit(ev({ ctrlKey: true })) === true, "② Ctrl档 Ctrl+↑↓ → 命中（零回归）");
  check(none.sessKeyHit(ev({ shiftKey: true })) === false,
    "② 无档 Shift+裸↑↓ → 不命中（shift 是文本选择意图）");
  check(none.sessKeyHit(ev({ metaKey: true })) === false && alt.sessKeyHit(ev({ altKey: true, metaKey: true })) === false,
    "② meta 参与一律不命中（Cmd 组合留给系统/呼出，两档同口径）");
}

// ---------- ③ histKeyHit 与切会话键互补（翻历史，msginput 内 #34） ----------
{
  const none = makeApi("none"), alt = makeApi("alt"), ctrl = makeApi("ctrl");
  check(none.histKeyHit(ev()) === false, "③ 无档 裸↑↓ → 不翻历史（让位切会话）");
  check(none.histKeyHit(ev({ altKey: true })) === true, "③ 无档 Alt+↑↓ → 翻历史（互补互换）");
  check(none.histKeyHit(ev({ altKey: true, ctrlKey: true })) === false, "③ 无档 Alt+Ctrl 同按 → 不翻（非纯 Alt）");
  check(alt.histKeyHit(ev()) === true, "③ Alt档 裸↑↓ → 翻历史（原语义不变）");
  check(alt.histKeyHit(ev({ altKey: true })) === false, "③ Alt档 Alt+↑↓ → 不翻（让位切会话）");
  check(ctrl.histKeyHit(ev()) === true, "③ Ctrl档 裸↑↓ → 翻历史（原语义不变）");
  check(ctrl.histKeyHit(ev({ ctrlKey: true })) === false, "③ Ctrl档 Ctrl+↑↓ → 不翻（让位切会话）");
  check(alt.histKeyHit(ev({ metaKey: true })) === false && none.histKeyHit(ev({ altKey: true, metaKey: true })) === false,
    "③ meta 参与一律不翻（两档同口径）");
}

// ---------- ④ kbModHit 切源回落（「无」档固定 Alt+←→，裸 ←→ 不抢） ----------
{
  const none = makeApi("none");
  check(none.kbModHit(ev()) === false, "④ 无档 裸←→ → 切源不命中（光标高频操作不抢）");
  check(none.kbModHit(ev({ altKey: true })) === true, "④ 无档 Alt+←→ → 切源命中（固定回落 Alt 分支）");
  check(none.kbModHit(ev({ ctrlKey: true })) === false, "④ 无档 Ctrl+←→ → 不命中（无档没有 Ctrl 语义）");
  check(makeApi("ctrl").kbModHit(ev({ ctrlKey: true })) === true, "④ Ctrl档 切源 Ctrl+←→ 命中（零回归）");
}

// ---------- ⑤ DOM 交互面静态锚点（行为面装机补验，见回单清单） ----------
{
  check(html.includes('if (kbMod() === "none" && $("msginput").value !== "") return;'),
    "⑤ 空输入守卫在位：无档且有草稿时裸 ↑↓ 不切（保草稿）");
  check(html.includes("if (!histKeyHit(e)) return;"),
    "⑤ 翻历史监听经 histKeyHit 闸（元素级先判，让位键冒泡到 document 切会话）");
  check(html.includes('t.closest("button, a, input, textarea, select, label, [contenteditable]")'),
    "⑤ 点击回焦守卫①：交互控件（按钮/链接/输入/下拉/label/contenteditable）不抢");
  check(html.includes("if (sel && !sel.isCollapsed && sel.toString()) return;"),
    "⑤ 点击回焦守卫②：文本拖选/双击选词中不打扰");
  check(html.includes('$("waitbox").style.display === "block") return;'),
    "⑤ 点击回焦守卫③：审批/提问弹窗打开焦点归它");
  check(html.includes('if ($("orgdrawer") || $("orgnew") || $("wizPop").classList.contains("open")) return;'),
    "⑤ 点击回焦守卫④：m2 浮层补全（组织抽屉/立项模态/配对向导）不回焦");
  check((html.match(/document\.addEventListener\("click", \(ev\) => \{\n  if \(!window\.ccDeck \|\| !selected\) return;/g) || []).length === 1,
    "⑤ 点击回焦监听恰好一处（不重复挂载）");
  check(html.includes("document.activeElement !== el && window.ccDeck && window.ccDeck.imeClick"),
    "⑤ IME 路径①：仅焦点真丢 + 桥在 + imeClick 可用时走合成点击");
  check(html.includes("document.elementFromPoint(x, y)") && html.includes("hit === el || (hit && el.contains(hit))"),
    "⑤ IME 路径②：elementFromPoint 确认点击处无浮层遮挡（命中输入框本体或其内）");
  check(/imeClick\(x, y\)\.catch\(\(\) => \{\n\s*try \{ el\.focus\(\{ preventScroll: true \}\); \} catch \{ el\.focus\(\); \}/.test(html),
    "⑤ IME 路径③：invoke 失败回落纯 JS focus（浏览器/Windows/桥缺失同路径）");
  check(html.includes("style=\"--n:3\"") && html.includes('["none", "alt", "ctrl"][+b.dataset.i]'),
    "⑤ lever 三档化在位：--n:3 + 档位映射数组（无/Alt/Ctrl）");
  check(html.includes('"↑↓（空输入时）"'),
    "⑤ 设置文案联动：无档切换会话提示改「↑↓（空输入时）」");
}

// ---------- ⑥ 结构自查闸（018 §5.5 口径） ----------
{
  const closeIdx = html.lastIndexOf("</html>");
  check(closeIdx > 0 && html.slice(closeIdx + "</html>".length).trim() === "",
    "⑥ `</html>` 后零内容");
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(ids).size === ids.length, `⑥ 静态 markup 无重复 id（共 ${ids.length} 个）`);
  const jsIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check(new Set(jsIds).size === jsIds.length, `⑥ 全文（含脚本内模板）无重复 id（共 ${jsIds.length} 个）`);
  check(!/document\.|window\.|localStorage\.(getItem|setItem)/.test(segCode.replace(/localStorage\.getItem\(KB_MOD_KEY\)/, "")),
    "⑥ 240-KB 段零 DOM 依赖（localStorage 为注入桩，段内无 document/window 引用）");
}

finish();
