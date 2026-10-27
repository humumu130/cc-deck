// #280-A 连接与设备页重设计——失焦根修（行为级）+ IA/视觉（静态锚）断言。
// 范式：真源码抽取直跑（test-268/272/277 同范式），靶子 web-console/js/settings-domain.js + css/base.css。
//
// 断言组：
//   F 失焦根修（硬要求 1，行为级）：liveSetHtml 输入中跳过重写（焦点/值保住）·
//     无焦点正常写 · 跳过后清焦点恢复写 · focusout 补刷委托在挂
//   I 信息架构（硬要求 2）：三卡结构（本机 relay/远程源/本设备与配对）·远程卡云形态隐藏·
//     桌面远程卡 withName=false · 源名编辑归本机 relay 卡
//   V 视觉（硬要求 3，5.3Flash 审查逐条对账）：当前值独立加重行 · ≤12 只出现一次（计数器）·
//     占位符去重复约束 · 保存钮紧邻 primary 档 · 规则一句自然语言 · 左对齐合一去图标
//   W 统一写口：五个 settings-live 容器全走 liveSetHtml（防回退锁）
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-280-conn-page.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sd = readFileSync(join(root, "web-console", "js", "settings-domain.js"), "utf-8");
const css = readFileSync(join(root, "web-console", "css", "base.css"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string): string {
  const i = sd.indexOf(needle);
  if (i < 0) return "";
  const j = sd.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < sd.length; k++) {
    if (sd[k] === "{") depth++;
    else if (sd[k] === "}") { depth--; if (depth === 0) return sd.slice(i, k + 1); }
  }
  return "";
}
function link(block: string, params: string[], deps: Record<string, unknown>): (...a: unknown[]) => unknown {
  const f = new Function(...params, "__D", "with (__D) {" + block.slice(block.indexOf("{") + 1, block.lastIndexOf("}")) + "}");
  return (...a: unknown[]) => { const p = [...a]; while (p.length < params.length) p.push(undefined); return f(...p, deps); };
}

console.log("#280-A 连接页重设计——失焦根修（行为级）+ IA/视觉断言");

// ---------- F 失焦根修（硬要求 1） ----------
{
  const calls: string[] = [];
  const fakeDoc = { activeElement: null as unknown };
  const skipped = new WeakSet<object>();
  const liveSet = link(blockFrom("function liveSetHtml(el, html)"), ["el", "html"], {
    document: fakeDoc,
    liveSkipped: skipped,
  });
  const el = { innerHTML: "OLD", contains: (x: unknown) => x === fakeDoc.activeElement };
  const input = { matches: (sel: string) => sel.includes("input") };
  // F1 无焦点：正常写
  liveSet(el, "NEW-1");
  ok(el.innerHTML === "NEW-1", "F1 无焦点 → 正常重写（live 渲染不因修复失效）");
  // F2 焦点在容器内输入框：跳过（焦点+值保住=用户实锤 bug 根治）
  fakeDoc.activeElement = input;
  liveSet(el, "NEW-2");
  ok(el.innerHTML === "NEW-1" && skipped.has(el), "F2 输入中 → 跳过本轮重写（innerHTML 不动，焦点/已输入值全保）");
  // F3 焦点移走后：恢复写（下一帧补上）
  fakeDoc.activeElement = null;
  liveSet(el, "NEW-3");
  ok(el.innerHTML === "NEW-3" && !skipped.has(el), "F3 焦点离开 → 恢复重写（跳过标记清除）");
  // F4 focusout 补刷委托在挂（容器内互切不触发由 relatedTarget 守卫）
  ok(sd.includes('document.addEventListener("focusout"') && sd.includes("ev.relatedTarget") && sd.includes("live.contains(next)"),
    "F4 focusout 补刷委托在挂（容器内互切不误触·真正离开即补刷一帧）");
  ok(sd.includes("a.matches(\"input, select, textarea, [contenteditable='true']\")"),
    "F4 守卫覆盖全部可编辑元素（不止源名输入框——配对码/未来输入同保护）");
}

// ---------- I 信息架构（硬要求 2） ----------
ok(sd.includes('data-settings-panel="connections"') && sd.includes("<h5>本机 relay</h5>") && sd.includes("<h5>远程源</h5>") && sd.includes("<h5>本设备与配对</h5>"),
  "I1 三卡 IA：本机 relay / 远程源 / 本设备与配对（原单列混排四类关注点拆分）");
ok(sd.includes('data-conn-remote-card') && sd.includes('data-settings-live="remote-sources"'),
  "I2 远程源独立容器+云形态整卡隐藏（云槽自渲染防双份）");
ok(sd.includes("liveSetHtml(remoteLive, cloudSettingsRows(false))"),
  "I3 桌面远程卡 withName=false（源名编辑归本机 relay 卡=同主体同卡）");
ok(sd.includes("function cloudSettingsRows(withName = true)") && sd.includes("if (withName) html += relayNameRowHtml(false)"),
  "I3 云形态槽内源名行保留（缺省 true，云源改名能力不变）");
ok(sd.includes("＋ 配对新设备") && sd.includes("本设备与配对"),
  "I4 配对按钮归入本设备卡（原孤立页脚 → 操作与对象同卡）");

// ---------- V 视觉（硬要求 3，5.3Flash 审查对账） ----------
{
  const rowBlock = blockFrom("function relayNameRowHtml(mobile)");
  ok(rowBlock.includes('rname-cur') && rowBlock.includes('rname-head'),
    "V1 当前值独立行加重（现状≠规则分层——审查·说明行混排三项）");
  ok(rowBlock.includes('data-relay-name-count') && rowBlock.includes('0/12'),
    "V2 实时字数计数器 n/12（审查·缺计数器+约束重复两修合一）");
  ok(rowBlock.includes('placeholder="新名称"') && !rowBlock.includes("≤12"),
    "V2 占位符去重复约束（「≤12」只在计数器出现一次）");
  const flat = rowBlock.replace(/\n/g, "");
  const iIn = flat.indexOf("data-relay-name-input"), iCnt = flat.indexOf("data-relay-name-count"), iSave = flat.indexOf("data-relay-name-save");
  ok(iIn >= 0 && iCnt > iIn && iSave > iCnt,
    "V3 动线顺序 输入→计数→保存 紧邻（审查·输入与确认被空档割裂修）");
  ok(rowBlock.includes("primary-btn rname-save"),
    "V3 保存=primary 主操作档（审查·弱样式橙字按钮层级不足）");
  ok(rowBlock.includes("留空保存则恢复主机名默认") && rowBlock.includes("回车也可提交"),
    "V4 规则压一句自然语言+回车提示（审查·「=」「回落」术语弃用）");
  ok(css.includes(".rname-block") && css.includes(".rname-count") && css.includes(".rname-cur") && css.includes(".rname-rowcard .avatar { display: none; }"),
    "V5 v8 语系样式落地（--fs-* 变量/density 对齐/去语义不明图标——审查·左对齐三线漂移）");
}

// ---------- W 统一写口（防回退锁） ----------
{
  const n = (sd.match(/liveSetHtml\(/g) || []).length;
  ok(n >= 9, "W1 liveSetHtml 调用 ≥9（定义+五容器全走统一写口，now=" + n + "）");
  ok(!/connLive\.innerHTML\s*=/.test(sd) && !/devLive\.innerHTML\s*=/.test(sd) && !/provLive\.innerHTML\s*=/.test(sd) && !/designLive\.innerHTML\s*=/.test(sd) && !/idLive\.innerHTML\s*=/.test(sd),
    "W2 五个 settings-live 容器零裸 innerHTML 残留（第四写口教训：单点声明必查全部搬卡入口）");
  ok(sd.includes("relayNameRowHtml(false)") && sd.includes("relayNameRowHtml(true)"),
    "W3 #272 兼容：桌面卡+移动 lane 双落点锚仍在（B8 回归不破）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
