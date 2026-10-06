// #79 005 原型输入栏补全：附件三入口/暂存架/附件卡 + 历史消息上下翻 + 停止链。
// 断言面：①附件链静态锚点（clip/paste/drop 三入口汇入同一 _staged、空架不渲染、
//   单件可移除、附件卡随消息）②历史翻键位与到头策略（非空不触发、到头停住不循环、
//   ↓ 清空退出、手工编辑/发送复位）③停止链（icon-stop 方块、可达性词、点动波、
//   「已停止」截断标记、busy 挡发送/附件、team 不进生成中）④新增 CSS 块 token
//   纪律（零裸色值）⑤行为直跑（纯函数 new Function + 桩 DOM）⑥结构闸。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-79-input.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const specPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "specs", "005-prototype-a.html");
const html = readFileSync(specPath, "utf-8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function fnOf(name: string, args: string): string {
  return html.match(new RegExp("function " + name + "\\(" + args + "\\) \\{[\\s\\S]*?\\n      \\}"))?.[0] ?? "";
}
function cssBlock(selector: string): string {
  const i = html.indexOf(selector + " {");
  if (i < 0) return "";
  let depth = 0, j = html.indexOf("{", i);
  const start = j;
  for (; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  return "";
}

console.log("== #79 prototype input: static anchors ==");

// ---- ① 附件三入口 → 同一暂存架 → 附件卡随消息 ----
ok(html.includes('composerClipInput.accept = "image/*,.pdf,.md,.txt,.zip,.json,.csv"'), "入口① clip：共享隐藏 file input + accept 全类型");
ok(html.includes('composerClipInput._composer = clip.closest("[data-composer]")'), "入口① clip：点击记忆目标 composer");
ok(html.includes('document.addEventListener("paste"') && html.includes("event.clipboardData?.files || []"), "入口② paste：clipboardData.files 入架");
ok(html.includes('document.addEventListener("drop"') && html.includes("event.dataTransfer?.files || []"), "入口③ drop：composer 整区为落点");
ok(html.includes('composer.classList.add("dragover")') && html.includes('.composer.dragover { border-color: var(--brand)'), "入口③ dragover 高亮 + dragleave/drop 退出");
ok(html.includes("生成中 · 请先停止再补附件"), "生成中补附件被拒（可见反馈，不静默）");
ok(html.includes("URL.createObjectURL(file)"), "图片走本地 objectURL 缩略图（原型假上传零外部资源）");
ok(fnOf("stageFiles", "composer, files") !== "" && fnOf("renderTray", "composer") !== "", "stageFiles/renderTray 在场（三入口汇入同一 _staged）");
ok(html.includes("if (!items.length) { tray?.remove(); return; }"), "暂存架空架不渲染（remove 节点）");
ok(html.includes('data-tray-remove="${i}"') && html.includes("splice(Number(trayX.dataset.trayRemove), 1)"), "暂存架单件可移除（索引委托 splice）");
ok(html.includes('setAttribute("aria-label", "待发送附件")'), "暂存架可达性 role=list + label");
ok(html.includes(".composer-tray { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 0 100%;"), "tray flex:1 0 100% 换行第二行（手机不破版结构锚点）");
ok(html.includes("bubble.append(atts);") && html.indexOf("bubble.append(atts);") < html.indexOf("bubble.append(document.createTextNode(text));"), "附件卡随消息发送（先附件卡后文本节点）");
ok(fnOf("trayEsc", "text").includes('replace(/[&<>"]/g'), "附件名进 innerHTML 前最小转义");

// ---- ② 历史消息上下翻 ----
ok(html.includes('event.key !== "ArrowUp" && event.key !== "ArrowDown"'), "↑/↓ 键位捕获");
ok(html.includes("const inHistory = !!histState && histState.idx >= 0;"), "历史翻态判定（回填后 ↑↓ 继续递推/反向）");
ok(html.includes("if (!inHistory && input.value.trim()) return;"), "非空草稿态不触发（不抢按键）");
ok(html.includes("if (hist.idx >= items.length - 1) { event.preventDefault(); return; }") && html.includes("到头停住不循环（选定策略，防误发）"), "到头策略：停住不循环 + 策略注明（防误发旧消息）");
ok(html.includes('input.value = hist.idx < 0 ? "" : items[hist.idx];'), "↓ 递减到 -1 清空输入退出历史态");
ok(html.includes("_hist.idx = -1; // 手工编辑即退出历史翻态"), "手工编辑退出历史态");
ok(html.includes("if (composer._hist) composer._hist.idx = -1;"), "发送后复位历史态");
ok(html.includes("filter((n) => n.nodeType === 3)") && html.includes("filter((t, i, a) => t !== a[i - 1])"), "历史只取文本节点 + 相邻去重（附件卡文本不入）");
ok(html.includes("input.setSelectionRange(input.value.length, input.value.length);"), "回填后光标置末尾");

// ---- ③ 停止链 ----
ok(html.includes('<symbol id="icon-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></symbol>'), "停止钮方块图标 sprite（icon-stop rect）");
ok(html.includes('sendButton.setAttribute("aria-label", "停止生成")') && html.includes('sendButton.title = "停止生成";'), "停止钮可达性词（aria-label + title）");
ok(html.includes('classList.add("composer-stop")') && cssBlock(".primary-btn.composer-stop") !== "", "发送钮→停止钮次级视觉态（CSS 档在场）");
ok(cssBlock(".stream-dots") !== "" && cssBlock("@keyframes stream-bounce") !== "", "生成中流式点动波（假动画 CSS）");
ok(html.includes('class="stopped-mark" title="生成已中断，回复截断于此">已停止'), "「已停止」截断标记 + 语义 title");
ok((html.match(/finishComposing\(composer, sendButton, true\)/g) || []).length === 2, "点击 + Enter 双路打断（click/keydown 委托各一）");
ok(html.includes('showToast("已停止生成（原型演示）")'), "打断即时 toast 反馈");
ok(html.includes("const COMPOSE_AUTO_MS = 3000;") && html.includes("finishComposing(composer, sendButton, false), COMPOSE_AUTO_MS"), "3s 自动完成（原型演示节奏）");
ok(html.includes('if (kind !== "team") startComposing(composer, sendButton, target);'), "团队聊天不进生成中态（无生成概念）");
ok(html.includes("composer.dataset.busy) return; // busy：停止钮态不叠加发送"), "busy 中不叠加发送");
ok(html.includes("if (!composer?.dataset.busy) return;"), "finishComposing 幂等闸（双击/竞态不重复终态）");
ok(html.includes("// #79 生成中：按钮由停止态接管"), "syncComposerActionState 生成中不覆写按钮");
ok(html.includes('sendButton.closest("[data-composer]") || sendButton.parentElement?.querySelector("[data-composer]")'), "发送钮兄弟节点兜底定位（委托链修复锚点）");
ok(html.includes('data-composer="mobile"') && html.includes('data-composer="team"') && html.includes('data-composer="session"'), "三 composer 形态在场（#82 手机回归锚点）");

// ---- ④ token 纪律：新增 CSS 块零裸色值（005 既有 token 暗亮双主题） ----
{
  const a = html.indexOf(".composer-tray {");
  const bMark = html.indexOf(".stopped-mark::before");
  const b = html.indexOf("}", bMark);
  const block = a > 0 && b > a ? html.slice(a, b + 1) : "";
  ok(block !== "", "新增 CSS 块可定位（composer-tray → stopped-mark::before）");
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), "新增 CSS 块零裸 hex（全走 var(--token)）");
  ok(!/rgba?\(/.test(block), "新增 CSS 块零 rgb/rgba 字面量");
  const kf = cssBlock("@keyframes stream-bounce");
  ok(kf !== "" && !/#[0-9a-fA-F]{3,8}\b/.test(kf) && !/rgba?\(/.test(kf), "点动波 keyframes 走 token（opacity/transform only）");
}

console.log("== #79 behavior: pure fn + stubbed DOM ==");

// ---- ⑤ 行为直跑 ----
{
  // W3 验证过的稳定范式：形参进构造体、体内直接 return 调用结果（不回传函数再调）
  const src = fnOf("trayEsc", "text");
  const esc = new Function("text", src + "\nreturn trayEsc(text);") as (t: string) => string;
  ok(esc('a<b>"c"&d') === "a&lt;b&gt;&quot;c&quot;&amp;d", "behavior: trayEsc 转义 <>&\" 全集");
  ok(esc("普通名字.png") === "普通名字.png", "behavior: trayEsc 普通名直通");
}
{
  const src = fnOf("composerTargetOf", "kind");
  const docStub = { querySelector: (sel: string) => sel };
  const targetOf = new Function("document", "kind", src + "\nreturn composerTargetOf(kind);") as (d: unknown, k: string) => string;
  ok(targetOf(docStub, "session") === "#d-session .conversation-pane", "behavior: target session→会话 timeline");
  ok(targetOf(docStub, "mobile") === "#m-detail .mobile-content > .workspace-pane", "behavior: target mobile→手机 timeline");
  ok(targetOf(docStub, "team") === "#d-team .team-chat", "behavior: target team→团队聊天");
}
{
  const trayEscSrc = fnOf("trayEsc", "text");
  const stageSrc = fnOf("stageFiles", "composer, files");
  const renderSrc = fnOf("renderTray", "composer");
  ok(stageSrc !== "" && renderSrc !== "", "behavior: 附件链函数可提取");
  const toasts: string[] = [];
  const makeEl = () => ({ className: "", innerHTML: "", attrs: {} as Record<string, string>, removed: false, setAttribute(k: string, v: string) { this.attrs[k] = v; }, append() {}, remove() { this.removed = true; } });
  const documentStub = { createElement: () => makeEl(), body: { append() {} } };
  const urlStub = { createObjectURL: (f: { name: string }) => "blob:fake:" + f.name };
  const run = new Function("document", "URL", "showToast", trayEscSrc + "\n" + stageSrc + "\n" + renderSrc + "\nreturn { stageFiles, renderTray };")(
    documentStub, urlStub, (m: string) => toasts.push(m),
  ) as { stageFiles: (c: any, f: any[]) => void; renderTray: (c: any) => void };
  // 生成中拒绝
  const busyComposer: any = { dataset: { busy: "1" } };
  run.stageFiles(busyComposer, [{ name: "x.png", type: "image/png" }]);
  ok(!busyComposer._staged && toasts.includes("生成中 · 请先停止再补附件"), "behavior: 生成中补附件被拒 + toast");
  // 正常入架：图片 + 文件双件
  const composer: any = { dataset: {}, querySelector: () => null, append(el: any) { this._tray = el; } };
  run.stageFiles(composer, [{ name: "截图.png", type: "image/png" }, { name: "notes.md", type: "text/markdown" }]);
  ok(composer._staged.length === 2, "behavior: 两文件入同一暂存架");
  ok(composer._staged[0].isImg === true && composer._staged[0].url === "blob:fake:截图.png", "behavior: 图片标 isImg + objectURL");
  ok(composer._staged[1].isImg === false && composer._staged[1].url === "", "behavior: 非图片走 icon 芯片（url 空）");
  const tray = composer._tray;
  ok(!!tray && tray.className === "composer-tray" && tray.attrs.role === "list", "behavior: renderTray 挂 role=list 架");
  ok(tray.innerHTML.includes("composer-tray-thumb") && tray.innerHTML.includes('data-tray-remove="0"') && tray.innerHTML.includes('data-tray-remove="1"'), "behavior: 缩略图芯片 + 双件移除钮");
  // 移除单件后空架不渲染
  let removed = false;
  run.renderTray({ _staged: [], querySelector: () => ({ remove() { removed = true; } }) });
  ok(removed, "behavior: 空架 remove 节点不显示");
  // 文件名转义进 innerHTML
  const escComposer: any = { dataset: {}, _staged: [{ name: "a<b>.png", isImg: false, url: "" }], querySelector: () => null, append(el: any) { this._tray = el; } };
  run.renderTray(escComposer);
  ok(escComposer._tray.innerHTML.includes("a&lt;b&gt;.png") && !escComposer._tray.innerHTML.includes("a<b>"), "behavior: 文件名转义后入 innerHTML");
  // null 安全
  let threw = false;
  try { run.stageFiles(null, []); run.renderTray(null); } catch { threw = true; }
  ok(!threw, "behavior: null composer 静默安全（不抛错）");
}

// ---- ⑥ 结构闸 ----
const endIdx = html.indexOf("</html>");
ok(endIdx > 0 && html.slice(endIdx + 7).trim() === "", "结构闸：</html> 后零内容");
ok((html.match(/id="icon-stop"/g) || []).length === 1, "icon-stop sprite 全文件唯一");
const staticHtml = html.slice(html.indexOf("<body"), html.indexOf("<script", html.indexOf("<body")));
const ids = [...staticHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
ok(new Set(ids).size === ids.length && ids.length > 30, "静态 id 唯一（" + ids.length + "，005 原型规模）");

console.log(`\n79-input: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
