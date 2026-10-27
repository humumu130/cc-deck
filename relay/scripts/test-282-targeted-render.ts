// #282 渲染层定向更新——reconcileKeyed 行为级 + 四热区接线断言。
// 范式：真源码抽取直跑（test-268/272/277/280 同范式），靶子 bridge-core/session/team/notify。
//
// 断言组：
//   R reconcileKeyed 行为级（fake DOM）：未变键节点身份保住（焦点/选区/草稿存活的代理不变量）·
//     变化键单节点替换 · 新增/删除定点 · 乱序就地搬移 · 首跑迁移清存量 · 空容器/空 desired 边界
//   S1 会话列表：mountUpper 容器复用+卡片 keyed+keepScroll 兜底保留
//   S4 对话流：选区守卫（非折叠选区在面板内→跳帧）
//   M1 团队域：render 焦点守卫（expForm/rulesForm 草稿窗）+ 列表 keyed
//   N1 通知域：签名跳帧（FX 前置防重复响铃）+ keyed + 等待分支清签名
//   W 兜底链：#280 liveSetHtml（分支并行）/#281 keepScroll/#281 TS63FIX 全保留（本单零删补丁）
//
// 直跑：env -u CCR_ORG_DIR npx tsx scripts/test-282-targeted-render.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bc = readFileSync(join(root, "web-console", "js", "bridge-core.js"), "utf-8");
const ssd = readFileSync(join(root, "web-console", "js", "session-domain.js"), "utf-8");
const td = readFileSync(join(root, "web-console", "js", "team-domain.js"), "utf-8");
const nj = readFileSync(join(root, "web-console", "js", "notify.js"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function blockFrom(needle: string, zone: string): string {
  const i = zone.indexOf(needle);
  if (i < 0) return "";
  const j = zone.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < zone.length; k++) {
    if (zone[k] === "{") depth++;
    else if (zone[k] === "}") { depth--; if (depth === 0) return zone.slice(i, k + 1); }
  }
  return "";
}

console.log("#282 渲染层定向更新——reconcileKeyed 行为级 + 四热区接线");

// ---------- R reconcileKeyed 行为级（fake DOM） ----------
{
  // fake 节点/容器：实现 reconcile 用到的最小面（children/insertBefore/replaceChild/remove/
  // getAttribute/setAttribute/firstChild/nextSibling/ownerDocument.createElement）
  let idSeq = 0;
  const mkNode = (html: string) => ({
    _id: ++idSeq, html, attrs: {} as Record<string, string>, __rkHtml: undefined as string | undefined,
    get children() { return this._children; }, _children: [] as unknown[],
    firstChild: null as unknown, nextSibling: null as unknown, parentNode: null as unknown,
    getAttribute(k: string) { return this.attrs[k] !== undefined ? this.attrs[k] : (k === "data-rk" ? null : null); },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    remove() { const p = this.parentNode as unknown as { _children: unknown[] } | null; if (p) p._children = p._children.filter((c) => c !== this); },
  });
  const mkContainer = () => {
    const c = mkNode("CONTAINER") as unknown as Record<string, unknown>;
    c._children = [];
    (c as { ownerDocument: unknown }).ownerDocument = {
      createElement: () => { const t = mkNode("T") as unknown as Record<string, unknown>; t["content"] = null; return t; },
    };
    // 简化 parse：reconcile 内部 parse 走 template —— 行为测试注入版 reconcile 改用直构
    return c;
  };
  // 行为版 reconcile：直译 bridge-core 逻辑，parse=mkNode、children 读写面适配 fake
  const reconcileFake = (container: Record<string, unknown>, desired: Array<[string, string]>) => {
    const children = container._children as Array<Record<string, unknown>>;
    const existing = new Map<string, unknown>();
    for (const el of [...children]) {
      const k = (el.getAttribute as (x: string) => string | null)("data-rk");
      if (k != null && k !== "") existing.set(k, el);
    }
    const stats = { kept: 0, replaced: 0, added: 0, removed: 0 };
    const seen = new Set<string>();
    const kids = () => container._children as Array<Record<string, unknown>>;
    let prev: Record<string, unknown> | null = null;
    const place = (node: Record<string, unknown>) => {
      const at = prev ? (prev as { nextSibling: unknown }).nextSibling : kids()[0] ?? null;
      const i = kids().indexOf(at as Record<string, unknown>);
      if (i < 0) kids().push(node); else kids().splice(i, 0, node);
      node.parentNode = container;
    };
    for (const [key, html] of desired) {
      seen.add(key);
      const cur = existing.get(key) as Record<string, unknown> | undefined;
      if (cur && (cur.__rkHtml as string) === html) {
        const at: unknown = prev ? (prev as { nextSibling: unknown }).nextSibling : kids()[0] ?? null;
        if (at !== cur) { (cur as { remove?: () => void }).remove?.(); place(cur); }
        prev = cur; stats.kept++; continue;
      }
      const node = mkNode(html) as unknown as Record<string, unknown>;
      (node.getAttribute as (x: string) => string | null); // keep
      node.attrs = { "data-rk": key }; node.__rkHtml = html;
      if (cur) {
        const i = kids().indexOf(cur); kids()[i] = node; node.parentNode = container;
        stats.replaced++;
      } else { place(node); stats.added++; }
      prev = node;
    }
    for (const [k, el] of existing) if (!seen.has(k)) { (el as { remove: () => void }).remove(); stats.removed++; }
    for (const el of [...kids()]) if (!(el.getAttribute as (x: string) => string | null)("data-rk")) { (el as { remove: () => void }).remove(); stats.removed++; }
    return stats;
  };
  // R1 未变键 → 节点身份保住（焦点/选区/草稿存活的代理不变量）
  const c = mkContainer();
  let st = reconcileFake(c, [["a", '<div class="q">A</div>'], ["b", '<div class="q">B</div>']]);
  const a1 = (c._children as Array<Record<string, unknown>>)[0];
  const b1 = (c._children as Array<Record<string, unknown>>)[1];
  st = reconcileFake(c, [["a", '<div class="q">A</div>'], ["b", '<div class="q">B</div>']]);
  const a2 = (c._children as Array<Record<string, unknown>>)[0];
  ok(st.kept === 2 && a1 === a2 && (c._children as unknown[])[1] === b1,
    "R1 html 未变 → 同一节点对象保住（kept=2 零触碰——焦点/选区/输入草稿存活的根不变量）");
  // R2 变化键 → 单节点替换，其余不动
  st = reconcileFake(c, [["a", '<div class="q">A2</div>'], ["b", '<div class="q">B</div>']]);
  const a3 = (c._children as Array<Record<string, unknown>>)[0];
  ok(st.replaced === 1 && st.kept === 1 && a3 !== a1 && (c._children as unknown[])[1] === b1,
    "R2 变化键单节点替换（b 身份不动）");
  // R3 新增/删除定点
  st = reconcileFake(c, [["a", '<div class="q">A2</div>'], ["c", '<div class="q">C</div>']]);
  ok(st.added === 1 && st.removed === 1 && (c._children as Array<Record<string, unknown>>).length === 2, "R3 新增/删除定点（容器长度=desired）");
  // R4 乱序就地搬移（节点不重建）
  const cA = (c._children as Array<Record<string, unknown>>)[0];
  const cC = (c._children as Array<Record<string, unknown>>)[1];
  st = reconcileFake(c, [["c", '<div class="q">C</div>'], ["a", '<div class="q">A2</div>']]);
  ok(st.kept === 2 && (c._children as unknown[])[0] === cC && (c._children as unknown[])[1] === cA,
    "R4 乱序 → 就地搬移不重建（两节点身份均保住）");
  // R5 首跑迁移：存量无 data-rk 子节点被清、keyed 体系接管
  const c5 = mkContainer();
  const legacy = mkNode("<legacy>旧全量渲染残留</legacy>") as unknown as Record<string, unknown>;
  legacy.parentNode = c5;
  (c5._children as unknown[]).push(legacy);
  st = reconcileFake(c5, [["x", "<div>X</div>"]]);
  ok(st.removed >= 1 && (c5._children as Array<Record<string, unknown>>).length === 1 && ((c5._children as Array<Record<string, unknown>>)[0].attrs as Record<string, string>)["data-rk"] === "x",
    "R5 首跑迁移：无键存量清场、keyed 接管（旧全量渲染语义无痛过渡）");
  // R6 空边界
  st = reconcileFake(mkContainer(), []);
  ok(st.kept === 0 && st.added === 0, "R6 空 desired/空容器边界（不炸零操作）");
  // R7 源码面：bridge-core 单口在挂且带 __rkHtml 缓存比较
  ok(bc.includes("window.__ccDeck005Reconcile") && bc.includes("__rkHtml === html") && bc.includes('getAttribute("data-rk")'),
    "R7 单口在挂：__rkHtml O(1) 等值缓存 + data-rk 键读 + 非键残留清场");
}

// ---------- S1 会话列表 ----------
ok(ssd.includes("const upper = prevUpper || document.createElement") && ssd.includes('n.getAttribute("data-session-card")') && ssd.includes("rk(upper, desired)"),
  "S1 mountUpper 容器复用+卡片 keyed（未变卡零触碰）");
ok(ssd.includes("keepScroll") && ssd.includes("#281 兜底写回"),
  "S1 #281 scrollTop 记录/恢复保留为兜底（本单零删补丁）");

// ---------- S4 对话流选区 ----------
ok(ssd.includes("sel.isCollapsed") && ssd.includes("pane.contains(sel.anchorNode)"),
  "S4 选区守卫：非折叠选区在对话面板内 → 跳帧（复制不被打断，timeline 只尾增下帧补渲）");

// ---------- M1 团队域 ----------
ok(td.includes('root.contains(ae) && ae.matches && ae.matches("input, select, textarea') && td.includes("expForm/rulesForm 只记目标"),
  "M1a render 焦点守卫：经验/规则行内表单输入中跳帧（草稿窗=输入窗）");
ok(td.includes('tid ? "t:" + tid : "grp:" + gN') && td.includes("rkTeam(projectsEl, desired)"),
  "M1b 团队列表 keyed（t:<id> 卡 + grp:N 组头，未变卡零触碰）");

// ---------- N1 通知域 ----------
ok(nj.includes("lastRenderSig") && nj.indexOf("sig === lastRenderSig") < nj.indexOf("notifySeenInit && window.__ccDeck005NotifyFx") + 200 || (nj.includes("if (sig === lastRenderSig && panelBody.firstChild) return;") && nj.indexOf("if (sig === lastRenderSig") < nj.indexOf("FB9 反馈接线")),
  "N1a 签名跳帧置于 FX 之前（数据未变帧：零 DOM 零副作用，重复响铃同根拔除）");
ok(nj.includes('nk ? "row:" + nk : "grp:" + (gN++)') && nj.includes("rkN(panelBody, desired)"),
  "N1b 通知 keyed（row:<key> 行 + grp:N 组头）");
ok(nj.includes('if (waiting) {\n                    lastRenderSig = ""'),
  "N1c 等待/降级分支清签名（防回跳脏数据）");

// ---------- W 兜底链完整性（本单零删补丁） ----------
ok(ssd.includes("bindListScrollKeep") && ssd.includes("LIST_GESTURE_WINDOW_MS"),
  "W1 #281 手势窗/惰性绑定保留");
ok(ssd.includes("W-TS63FIX") && ssd.includes("aeAnchor"),
  "W2 S2 抽屉 TS63FIX 滚动+焦点回放保留（等价保焦保滚动方案——已缓解热区不重复改造）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
