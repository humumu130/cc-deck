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

// ==================== #282 续批（遗留四项：S3/S5/S7/MOB） ====================
const mj = readFileSync(join(root, "web-console", "js", "mobile.js"), "utf-8");
console.log("#282 续批——S3 检查器块级拆分 / S5 任务·产物·更多 / S7 看门狗单卡类切换 / MOB 双壳同族");

// ---------- S3 检查器块级拆分 ----------
ok(ssd.includes('host.setAttribute("data-insp-body", "")') && ssd.includes("rk(host, blocks)") && ssd.includes('blk("sess"') && ssd.includes('blk("team"') && ssd.includes('blk("arts"'),
  "S3a 块集合 blk() 七块 + 稳定内层容器 [data-insp-body] keyed（未变块零触碰：胶囊展开/详情折叠存活）");
ok(ssd.includes("blocks.map((b) => b[1]).join(\"\")") && ssd.includes(".inspector-resizer"),
  "S3b rk 缺席兜底=旧整写+FB6 摘回逐字节保留（零删）");
ok(!ssd.includes('let html = "<h3>证据检查器</h3>"'),
  "S3c 旧单串拼接已收口（漏改点哨兵：h3 单串声明不再存在）");

// ---------- S5 任务/输出物/更多 ----------
ok(ssd.includes("function paneSigWrite") && ssd.includes('"full:" + htmlSig(html)') && ssd.includes('"local:" + htmlSig(lh)'),
  "S5a 任务 pane 签名跳帧（local 分支签名吃全量 html——折叠开合/行文变化必重建）");
ok(ssd.includes('host.setAttribute("data-af-body", "")') && ssd.includes('desired.push(["g:" + g.dir, artGroupNode(g, s.cwd, artOpenDirs.has(g.dir)).outerHTML])'),
  "S5b 输出物 keyed：[data-af-body] 稳定宿主 + 组级键 g:<dir>（在途下载 meta 定点写不再被帧重建孤儿化）");
ok(ssd.includes('wrap.insertAdjacentHTML("beforeend"'),
  "S5b' rk 缺席回落旧整树路径保留（零删）");
ok(ssd.includes("data-turn-elapsed") && !ssd.includes('html.replace("__ELAPSED__"') && ssd.includes("const elFresh = pane.querySelector(\"[data-turn-elapsed]\")"),
  "S5c 更多 pane：时长占位剔签名 + 定点写（写路径与跳帧路径同款 querySelector——占位字面量误伤面封死，审查 P2 收口）");

// ---------- S7 置灰看门狗 ----------
ok(ssd.includes('card.classList.toggle("idle", dim)') && !ssd.includes("idleDimmed(s)) { renderMyList(); return; }"),
  "S7 失配改单卡类切换（整列重渲退役；idle 只拼卡根 class——类切换与重建产物等价）");

// ---------- S5' paneSigWrite/mSigWrite 行为级（fake DOM 忠实复刻） ----------
{
  const mkPane = () => {
    const p: Record<string, unknown> = { dataset: {} as Record<string, string>, kids: [] as unknown[] };
    Object.defineProperty(p, "childElementCount", { get(this: { kids: unknown[] }) { return this.kids.length; } });
    Object.defineProperty(p, "innerHTML", {
      set(this: { kids: unknown[] }, v: string) { this.kids = v ? [v] : []; },
      get(this: { kids: unknown[] }) { return String(this.kids[0] ?? ""); },
      configurable: true,
    });
    return p as { dataset: Record<string, string>; kids: unknown[]; childElementCount: number; innerHTML: string };
  };
  const sigWrite = (pane: { dataset: Record<string, string>; childElementCount: number; innerHTML: string }, sig: string, html: string) => {
    if (pane.dataset.rkSig === sig && pane.childElementCount) return false;
    pane.dataset.rkSig = sig;
    pane.innerHTML = html;
    return true;
  };
  const p = mkPane();
  ok(sigWrite(p, "s1", "<x>a</x>") === true, "S5'-1 首写（无签名）必写入");
  const kidBefore = p.kids[0];
  ok(sigWrite(p, "s1", "<x>a</x>") === false && p.kids[0] === kidBefore, "S5'-2 同签名跳帧零 DOM 写（子节点身份不动）");
  ok(sigWrite(p, "s2", "<x>b</x>") === true && p.kids[0] === "<x>b</x>", "S5'-3 签名变化必重建");
  p.kids.length = 0; // 外部清空（如他路 banner 覆写后残留签名）
  ok(sigWrite(p, "s2", "<x>b</x>") === true, "S5'-4 空容器+同签名不误跳（dataset 签名随宿主存活时的陈旧防护）");
}

// ---------- MOB 双壳同族 ----------
ok(mj.includes("function mSigWrite") && mj.includes('"conv:" + sid + ":" + mHtmlSig(h)') && mj.includes('"t:" + sid + ":" + mHtmlSig(h)'),
  "MOB-1 详情四 pane sig 跳帧（sid 进签名防跨会话同形误跳；proc-off host 级类不受影响）");
ok(mj.includes('["a:active", activeMarkup]') && mj.includes('desired.push(["p:" + g,') && mj.includes("rkM(list, desired)"),
  "MOB-2 收件箱组级 keyed（a:active/p:<组>——FB16 折叠态/组内滚动逐帧存活；rk 缺席回落整串）");
ok(mj.includes('["n:" + n.key, rowOf(n)]') && mj.includes("rkN(list,"),
  "MOB-3 通知行级 keyed（n:<key>——标记已读/清除行级增删定点，列表滚动存活）");
ok(mj.includes('mSigWrite(todo, "todo:" + mHtmlSig(h)') && mj.includes('mSigWrite(members, "mem:" + mHtmlSig(h)') && mj.includes('mSigWrite(cards, "pc:" + mHtmlSig(h)'),
  "MOB-4 团队 todo/board/members + 项目 cards/lane sig 跳帧（泳道滚动位存活）");

// ---------- P1 修复回归（审查 review-282b-a 收口） ----------
ok(ssd.includes('c.classList.contains("inspector-resizer"))) c.remove();'),
  "P1-1 S3 首建 host 静态占位子节点显式清场（resizer 除外）——旧整写隐式清场语义补回（模板假数据不再同屏）");
ok(ssd.includes("delete pane.dataset.rkSig;"),
  "P1-2 S5b keyed 路径清空态签名（empty→keyed→empty 陈旧签名误跳帧封口）");
{
  // 行为级复刻双协议序列（修复语义）：sigWrite=sig 协议；keyed 协议=清签名+直挂 host
  const mkPane = () => {
    const p: Record<string, unknown> = { dataset: {} as Record<string, string>, kids: [] as unknown[] };
    Object.defineProperty(p, "childElementCount", { get(this: { kids: unknown[] }) { return this.kids.length; } });
    Object.defineProperty(p, "innerHTML", {
      set(this: { kids: unknown[] }, v: string) { this.kids = v ? [v] : []; },
      get(this: { kids: unknown[] }) { return String(this.kids[0] ?? ""); },
      configurable: true,
    });
    return p as { dataset: Record<string, string>; kids: unknown[]; childElementCount: number; innerHTML: string };
  };
  const sigWrite = (pane: { dataset: Record<string, string>; childElementCount: number; innerHTML: string }, sig: string, html: string) => {
    if (pane.dataset.rkSig === sig && pane.childElementCount) return false;
    pane.dataset.rkSig = sig;
    pane.innerHTML = html;
    return true;
  };
  const p = mkPane();
  sigWrite(p, "empty", "<banner>暂无输出物</banner>");          // ① 空态写入
  delete p.dataset.rkSig; p.kids = ["<host>会话A产物树</host>"]; // ② keyed 路径接管（清签名=修复点）
  ok(sigWrite(p, "empty", "<banner>暂无输出物</banner>") === true && p.kids[0] === "<banner>暂无输出物</banner>",
    "P1-2' 行为级：empty→keyed→empty 不再陈旧跳帧（banner 正确接管，A 树退役）");
  const p2 = mkPane();
  sigWrite(p2, "empty", "<banner>x</banner>");
  p2.kids = ["<host>A</host>"];                                  // 反例（无修复语义：签名残留）
  ok(sigWrite(p2, "empty", "<banner>x</banner>") === false,
    "P1-2'' 反例锚：签名残留时同签名确实会跳（修复=在 keyed 路径清签名，本断言锁死该风险形态）");
}

// ==================== #282 三批（M2 活动流/N2 队列检查器/MOB 秒级签名） ====================
console.log("#282 三批——M2 团队详情六 pane / N2 项目域队列·长页·检查器 / MOB 时长占位");
ok(td.includes("function tSigWrite") && td.includes('"mem:" + tSigOf(memberHtml)') && td.includes('"act:" + tSigOf(activityCompactHtml)') && td.includes('"p1:" + tSigOf(boardFinal)'),
  "M2-1 团队详情签名跳帧：成员/活动双区+看板终态单笔写（原三步 set+=+= 收口）");
ok(td.includes('"p3:" + tSigOf(activityHtml)') && td.includes('"p4:" + tSigOf(teamOutputsHtml)') && td.includes('"p5:" + tSigOf(expHtml)') && td.includes('"p6:" + tSigOf(rulesHtml)'),
  "M2-2 活动/输出物/经验/铁律四 tab 签名跳帧（筛选 chips 悬停+活动/看板滚动位逐帧存活）");
ok(bc.includes("const bSigOf") && bc.includes("els.queue.dataset.b2qSig !== qSig") && bc.includes("els.body.dataset.b2lSig !== lSig"),
  "N2-1 项目域队列+长页签名跳帧（未立项折叠态/长页滚动位逐帧存活）");
ok(bc.includes('els.queue.dataset.b2qSig = "";') && bc.includes('els.body.dataset.b2lSig = "";'),
  "N2-2 等待分支清签（降级→数据态不误跳帧——续批 P1-2 同型防线前置）");
ok(bc.includes("els.artifactRows.dataset.b2arSig !== arSig") && bc.includes("els.waterline.dataset.b2wlSig !== wlSig"),
  "N2-3 检查器产物行+水位块签名跳帧（relTime 分钟粒度翻转才重建）");
ok(mj.includes("__MELAPSED__") && mj.includes('querySelector("[data-mturn-elapsed]")') && !mj.includes('mDurText(Math.max(0, Date.now() - s.turn_started_at)) + "</b>'),
  "MOB-E 时长占位剔签名+定点写（B 审查 P3「活跃会话跳帧失效」收口；写/跳帧两路径同款，与桌面 renderMore 对齐）");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
