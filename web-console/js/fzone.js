// W-FZONE-B1（1111 拍板方案 B · 批一）：右侧文件工作区——tab 系统 + 容器（拖宽/收起/记忆）。
// W-FZONE-R4（1112 用户四轮打回·第四轮定谳「在外面，在右侧」）：工作区=app 内容区级右列——
// fzone+4px sash 与 session-detail 并列为 .session-shell 子级（不在会话面板内、head 不压工作区）；
// 窄窗禁浮层（<1200 覆盖媒体查询删除，任何宽度都是真实列）+冷启必收起（OPEN_KEY 读点退役）+
// 极窄 <1000 单向自动收起（NARROW_W）。宽度 440、clamp[340,800] 沿用；tab/内容链路不变。
// 内容加载委托 session-domain 注册的 window.__ccDeck005FzoneLoad(el, sid, path)（复用
// fetchArtifact/mdHtml/synHtml 闭包内管线——本文件零数据面）；图标委托 __ccDeck005ArtIconHtml。
// 批一范围：md/代码/图片三格式 + 点击入口闭环；批二（W-FZONE-B2）：格式矩阵（pdf 原生 viewer/
// 音频/视频——session-domain 侧）+ 产物自动推 tab（autoOpen 不抢焦点+「新」角标）+ ⌘1-8 直达
// + 工作空间树抽屉（降级形态：已登记产物按目录分组——relay 无列目录命令）；diff=无通道降级。
(function () {
  "use strict";
  const W_KEY = "ccd_fzone_w", OPEN_KEY = "ccd_fzone_open";
  const root = document.getElementById("fzone");
  if (!root) return;
  const toolsEl = root.querySelector("[data-fz-tools]");
  const tabsEl = root.querySelector("[data-fz-tabs]");
  const bodyEl = root.querySelector("[data-fz-body]");
  const state = { tabs: [], active: null, seq: 0, lastSid: null }; // W-FZONE-B1-R1 P2-①：sid 单值移除（tab 各带 sid），lastSid=切会话清空幂等守卫
  // W-FZONE-R2：per-sid 暂存表（切会话 tab 保留——见 resetForSession 注释块）+pane 跨会话保活表
  const stash = new Map(); // sid → { tabs, active }
  const panes = new Map(); // tabId → pane 元素（detach 不销毁；LRU 淘汰/close 时才 unload）
  const STASH_MAX = 8;
  const loadFn = () => (typeof window.__ccDeck005FzoneLoad === "function" ? window.__ccDeck005FzoneLoad : null);
  const iconHtml = (name) => (typeof window.__ccDeck005ArtIconHtml === "function" ? window.__ccDeck005ArtIconHtml(name) : "");

  // ---------- 宽度/收起（记忆：localStorage 持久——任务书「收起/展开记忆」） ----------
  // W-FZONE-R3：宽度策略照 WorkBuddy——默认 440（useState(440)）、clamp[340,800]
  // （Math.min(Math.max(w,340),800) 同构）；72vw 上位护栏为我方窄窗浮层配套（<1200 面板 absolute
  // 覆盖态防超窗——WorkBuddy 桌面窗最小宽足够无需此护栏，宽屏下 72vw≥864>800 零感知）。
  // W-FZONE-R4 P1-2 修（审 B）：浮层退役后 72vw 护栏在 <1111px 区间护不住（0.72*1111≈800>可用）——
  // 真实列时代并入可用空间上限 availMax（视口 − queue 右缘(含 rail 实算) − sash − 会话列保底储备）：
  // 极窄窗「头部钮可再开」与再开可用性自洽（会话列不被 flex-shrink:0 面板压到 0）。
  // W-FZONE-R4-R1 刀三（审二 P2-① 1000px 档对话列 215px+composer 按钮溢出实录）合流：保底储备取
  // 实测口径 CHAT_FIT=442——审 B 的 CHAT_MIN 360 是「列宽」口径，列内 chrome（padding/margin ≈68px）
  // 吃掉后 composer 实得 ~230px 仍溢出；CDP 逐宽实测 composer 按钮行最小内容宽 366px，全容纳需
  // cbW≥366 → 储备 360+68+14 余量。效果：≥1071px 窗宽面板全容纳按钮行；极窄（avail<340 面板下限）
  // 下限优先——939-1071 带手动再开 composer 仍挤（面板 340 下限语义保留，R4-R1 备案），<1200 跨入
  // 已自动收起（刀二）。
  const CHAT_FIT = 442; // 会话列保底储备（R4-R1 刀三实测口径：审 B CHAT_MIN 360 列宽保底+列内 chrome≈68+余量 14——超集覆盖）
  function availMax() {
    const q = document.querySelector("#d-session .queue");
    const qRight = q ? Math.round(q.getBoundingClientRect().right) : 297; // 缺省 62(rail)+235(queue)
    return Math.max(340, Math.floor(window.innerWidth - qRight - 4 - CHAT_FIT));
  }
  function clampW(w) { return Math.max(340, Math.min(800, availMax(), Math.round(window.innerWidth * 0.72), w)); }
  function applyW(w) { root.style.width = clampW(w) + "px"; }
  function readW() {
    const v = Number(localStorage.getItem(W_KEY));
    return Number.isFinite(v) && v >= 340 ? clampW(v) : 440; // 缺省 440（WorkBuddy 同构）；旧记忆 <340（38%/280 时代）归一
  }
  function setOpen(on, remember) {
    if (on) applyW(readW()); // R4 P1-2 修（审 B）+ R4-R1 刀三合流单点：展开时按当前视口重钳记忆宽（护栏保对话列/composer 全按钮——窄域手动再开不再 215px 细条；记忆 800 极窄再开被 avail 收紧）——open/toggle/autoOpen 全走本口
    root.hidden = !on;
    root.classList.toggle("open", on);
    const sash = document.querySelector("#d-session .fz-sash");
    if (sash) sash.hidden = !on; // sash 随面板开合（WorkBuddy：面板关=整组不渲染，我方 hidden 等价）
    if (remember) { try { localStorage.setItem(OPEN_KEY, on ? "1" : "0"); } catch (_) {} }
    // R4：旧 fz-on 类随 session-split 退役删除（CSS 全仓零消费=vestigial）
    // 头部常驻开关钮状态回显（面板收起后=唯一再展开入口——静态 conv-mini 钮，data-fzone-toggle 不随对话重建）
    document.querySelectorAll("[data-fzone-toggle]").forEach((b) => {
      b.classList.toggle("on", on);
      b.title = "文件工作区（" + (on ? "开 · 点击收起" : "关 · 点击展开") + "）";
    });
    renderTools();
  }
  // ---------- 工具行（收起/展开 + tab 计数状态；树/diff 钮=批二占位不渲染） ----------
  function renderTools() {
    if (!toolsEl) return;
    const n = state.tabs.length;
    const freshN = state.tabs.filter((t) => t.fresh).length;
    toolsEl.innerHTML = '<button type="button" class="fz-tool" data-fz-collapse title="' + (root.hidden ? "展开文件工作区" : "收起文件工作区（保留全部 tab）") + '">' + (root.hidden ? "⟨ 展开" : "收起 ⟩") + "</button>" +
      '<button type="button" class="fz-tool" data-fz-tree-btn title="工作空间树（本会话产物按目录分组）">▤ 树</button>' +
      '<span class="fz-spring"></span><span class="fz-state">' + (n ? n + " tab" + (n > 1 ? "s" : "") + (freshN ? ' · <b class="fz-freshn">' + freshN + " 新</b>" : "") : "空") + "</span>";
  }
  // ---------- tab 渲染 ----------
  function baseName(p) { return String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || ""); }
  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.innerHTML = state.tabs.map((t) =>
      '<button type="button" class="wtab' + (t.id === state.active ? " on" : "") + '" data-fz-tab="' + esc(t.id) + '" title="' + esc(t.path) + '" role="tab" aria-selected="' + (t.id === state.active ? "true" : "false") + '">' +
      '<span class="fic">' + iconHtml(baseName(t.path)) + "</span>" +
      '<span class="fname">' + esc(baseName(t.path)) + "</span>" +
      (t.fresh ? '<span class="fz-badge" title="本回合新增">新</span>' : "") +
      '<span class="x" data-fz-close="' + esc(t.id) + '" role="button" aria-label="关闭 ' + esc(baseName(t.path)) + '" title="关闭">✕</span>' +
      "</button>").join("") || '<span class="fz-tabs-empty">尚无打开的文件</span>';
  }
  function renderBodies() {
    if (!bodyEl) return;
    const hint = bodyEl.querySelector("[data-fz-empty]");
    if (!state.tabs.length) { // 空态（任务书三态齐）：单例提示卡（无 tab 才在场——CDP 截图实锤：fz-fb display:flex 压过 [hidden]，故提示卡走移除制不走隐藏制）
      if (!hint) { bodyEl.innerHTML = '<div class="fz-fb" data-fz-empty><span>空 · 点消息里的文件、产物行或头部「▤ 工作区」展开</span></div>'; }
      return;
    }
    if (hint) hint.remove();
    [...bodyEl.children].forEach((c) => { c.hidden = c.dataset.fzPane !== state.active; });
  }
  function renderAll() { renderTabs(); renderBodies(); renderTools(); }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]); }

  // ---------- 开 tab（同文件重开=聚焦不重复——任务书铁则；W-FZONE-B1-R1 P2-①：tab 挂会话作用域） ----------
  function tabId(sid, path) { return String(sid) + "\u0001" + String(path); } // 复合 id：跨会话同名路径=不同 tab（宁可开双 tab 不串内容——审修定谳口径）
  function open(sid, path) {
    const p = String(path || "");
    if (!p) return;
    state.lastSid = String(sid);
    const id = tabId(sid, p);
    const hit = state.tabs.find((t) => t.id === id);
    if (hit) { hit.fresh = false; state.active = id; renderAll(); return; } // 聚焦已有 tab（复合 id=同会话同路径才命中，跨会话串台不可能；聚焦即清「新」角标）
    const pane = document.createElement("div");
    pane.className = "fz-pane";
    pane.dataset.fzPane = id;
    pane.innerHTML = '<div class="fz-load">拉取中…</div>';
    bodyEl.appendChild(pane);
    panes.set(id, pane); // W-FZONE-R2：pane 登记入跨会话保活表（detach/stash 恢复链一致）
    state.tabs.push({ id, path: p, sid: String(sid) }); // P2-①：tab 自带 sid（retry 不再依赖全局单值）
    state.active = id;
    setOpen(true, false);
    renderAll();
    load(id, pane, sid, p);
  }
  // ---------- W-FZONE-B2 件②：产物自动推 tab（回合收口新增 artifacts——session-domain
  // fzAutoTabOnUpdate 差分调这里）：不抢焦点（state.active 不动——用户正在看的 tab 不切）+
  // 「新」角标（点击聚焦即清）。面板收起时不强行展开（不打扰）：tab 静默入列，工具行计数带
  // 「N 新」，用户展开即见。已开过的文件重复新增=只补角标不开新 tab。
  function autoOpen(sid, path) {
    const p = String(path || "");
    if (!p) return;
    state.lastSid = String(sid);
    const id = tabId(sid, p);
    const hit = state.tabs.find((t) => t.id === id);
    if (hit) { if (!hit.fresh) { hit.fresh = true; renderTabs(); renderTools(); } return; }
    const pane = document.createElement("div");
    pane.className = "fz-pane";
    pane.dataset.fzPane = id;
    pane.innerHTML = '<div class="fz-load">拉取中…</div>';
    bodyEl.appendChild(pane);
    panes.set(id, pane); // W-FZONE-R2：同 open——pane 保活登记
    state.tabs.push({ id, path: p, sid: String(sid), fresh: true });
    if (!state.active) state.active = id; // 面板空态首 tab：自然成为 active（无焦点可抢）
    renderAll(); // 面板收着也渲染（hidden 容器内零视觉；展开即见）
    load(id, pane, sid, p);
  }
  function load(id, pane, sid, path) { // path 独立参数（P2-① 复合 id 不再等价 path——挂口第三参须传真路径）
    const fn = loadFn();
    if (!fn) { pane.innerHTML = errCard("内容加载器未就绪（session 域未挂载）", id); return; }
    Promise.resolve().then(() => fn(pane, sid, path)).catch((e) => { pane.innerHTML = errCard(String((e && e.message) || e), id); });
  }
  function errCard(msg, id) {
    return '<div class="fz-fb"><span class="fz-fb-ico">✕</span><span>拉取失败：' + esc(String(msg).slice(0, 160)) + '</span><button type="button" class="secondary-btn" data-fz-retry="' + esc(id) + '">重试</button></div>';
  }
  // ---------- 关 tab（关最后一个=面板收起，状态记忆） ----------
  function unloadPane(pane) { // P2-②：pane 资源回收委托 session-domain 挂口（per-tab blob url revoke——本文件零数据面原则不变）
    const un = window.__ccDeck005FzoneUnload;
    if (pane && typeof un === "function") { try { un(pane); } catch (_) {} }
  }
  function close(id) {
    const i = state.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    state.tabs.splice(i, 1);
    const pane = bodyEl.querySelector('[data-fz-pane="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (pane) { unloadPane(pane); pane.remove(); }
    panes.delete(id); // W-FZONE-R2：关 tab 即真释放（保活表同步清——不占 stash 额度）
    if (state.active === id) state.active = state.tabs[Math.min(i, state.tabs.length - 1)]?.id ?? null;
    if (!state.tabs.length) { setOpen(false, true); state.active = null; renderAll(); return; }
    renderAll();
  }
  // 切会话暂存/恢复（W-FZONE-R2，1111 用户实锤「按 WorkBuddy 的开发」：右侧分栏常驻——
  // 切会话工作区不消失，tab 内容按会话隔离保留）。前身=B1-R1 P2-①「切会话清空」（防跨会话
  // 串台+retry 错拉）；R2 升格为 per-sid 暂存：切走=快照（tabs+active+pane DOM detach 保活——
  // blob/iframe 零重载），切回=原样恢复。防串台语义不降级：恢复的 tab 各带原 sid（retry 仍
  // 用 tab.sid——复合 id 天然不串）。lastSid 幂等守卫沿用（同 sid 重入零动作）。
  // stash LRU 上限 8 会话：超出淘汰最旧（unloadPane 释放 blob/iframe——防长会话漂移内存膨胀）。
  // 树抽屉不暂存（数据源随会话失效，切回按需重开）；开合态不动（OPEN_KEY 全局语义不变）。
  function detachPanes() { [...bodyEl.querySelectorAll("[data-fz-pane]")].forEach((p) => { panes.set(p.dataset.fzPane, p); p.remove(); }); }
  function restorePanes(sid) {
    const keep = new Set(state.tabs.map((t) => t.id));
    for (const t of state.tabs) {
      const p = panes.get(t.id);
      if (p) bodyEl.appendChild(p); // 原 pane 原样回挂（内容/blob 保活零重拉）
      else { // 兜底重建（stash 淘汰过的会话 tab 仍在 tabs 快照里=只重建壳重载内容）
        const np = document.createElement("div");
        np.className = "fz-pane";
        np.dataset.fzPane = t.id;
        np.innerHTML = '<div class="fz-load">拉取中…</div>';
        bodyEl.appendChild(np);
        load(t.id, np, t.sid, t.path);
      }
    }
    // R2-R1（双审 P2 定谳）：本函数零释放——panes=全 stash 会话 pane 池（目标会话不引用的
    // 他 sid pane 留池保活），释放归两路独占：closeTab（unloadPane+panes.delete）/stashEvict
    //（LRU 淘汰 unloadPane+delete 双连）。原「尾清理循环」裸 delete 绕过 unloadPane（图片
    // blob 不 revoke 泄漏）+他 sid pane 误删（B→A→B 切回必兜底重载=保活名存实亡）——已删。
  }
  function stashEvict() {
    while (stash.size > STASH_MAX) {
      const oldest = stash.keys().next().value; // Map 插入序=LRU（恢复命中时重插见下）
      const snap = stash.get(oldest);
      stash.delete(oldest);
      for (const t of snap.tabs) { const p = panes.get(t.id); if (p && !p.isConnected) { unloadPane(p); panes.delete(t.id); } } // 淘汰会话的离场 pane 真释放
    }
  }
  function resetForSession(sid) {
    const s = String(sid || "");
    if (s === state.lastSid) return;
    if (state.lastSid && state.tabs.length) {
      stash.delete(state.lastSid); // LRU 触顶：重插刷新热度
      stash.set(state.lastSid, { tabs: state.tabs, active: state.active });
      stashEvict();
    }
    state.lastSid = s;
    closeTree(); // 树抽屉随会话清空（数据源已随会话切换失效；不暂存）
    detachPanes();
    const snap = stash.get(s);
    if (snap) {
      state.tabs = snap.tabs;
      state.active = snap.active;
      restorePanes(s);
    } else {
      state.tabs = [];
      state.active = null;
    }
    renderAll();
  }
  function retry(id) {
    // 兼容两卡源：fzone errCard（加载器未就绪）带复合 id / session-domain fzFb（拉取失败）带纯 path
    const t = state.tabs.find((x) => x.id === id) || state.tabs.find((x) => x.path === id);
    if (!t) return;
    const pane = bodyEl.querySelector('[data-fz-pane="' + (window.CSS && CSS.escape ? CSS.escape(t.id) : t.id) + '"]');
    if (!pane) return; // P2-①：retry 取 tab 自带 sid（旧全局 state.sid 已除——跨会话错拉不可能）
    pane.innerHTML = '<div class="fz-load">拉取中…</div>';
    load(t.id, pane, t.sid, t.path);
  }

  // ---------- W-FZONE-B2 件③：工作空间树抽屉（降级形态：已登记产物按目录分组——relay 无
  // 列目录命令，任务书预判降级；数据源=window.__ccDeck005FzoneArts（session-domain 当前会话
  // artifacts 原文路径）；点击走 OpenByToken（原文 path 直命中 openFzoneTab）。懒加载口径：
  // 首次点击「▤ 树」才拉数据渲染（产物多时也只渲一屏列表+目录分组，无递归展开成本）。
  let treeEl = null;
  function dirOf(p) { const seg = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/); seg.pop(); return seg.join("/"); }
  function renderTree() {
    closeTree();
    const arts = (typeof window.__ccDeck005FzoneArts === "function" ? window.__ccDeck005FzoneArts() : null) || [];
    const groups = new Map(); // dir → [name]
    for (const a of arts) {
      const d = dirOf(a.path) || "（根）";
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(baseName(a.path));
    }
    const rows = [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([d, names]) =>
      '<div class="fz-tree-dir">' + esc(d) + "</div>" +
      names.sort().map((n) => '<button type="button" class="fz-tree-file" data-fz-tree-open="' + esc(d === "（根）" ? n : d + "/" + n) + '"><span class="fic">' + iconHtml(n) + "</span>" + esc(n) + "</button>").join("")
    ).join("");
    treeEl = document.createElement("div");
    treeEl.className = "fz-tree";
    treeEl.dataset.fzTree = "1";
    treeEl.innerHTML = '<div class="fz-tree-head"><span>工作空间 · ' + arts.length + " 件产物</span><button type=\"button\" class=\"fz-tool\" data-fz-tree-close title=\"关闭树\">✕</button></div>" +
      '<div class="fz-tree-list">' + (rows || '<div class="fz-tree-empty">本会话暂无登记产物——产物由 deliver/输出物链登记</div>') + "</div>" +
      '<div class="fz-tree-note">降级形态：按已登记产物目录分组（目录浏览需 relay 列目录通道，批三评估）</div>';
    bodyEl.appendChild(treeEl);
  }
  function closeTree() {
    if (treeEl && treeEl.isConnected) treeEl.remove();
    treeEl = null;
  }

  // ---------- 事件（tab 切换/关闭/中键关/重试/收起/拖宽/树/⌘1-8） ----------
  root.addEventListener("click", (ev) => {
    const x = ev.target.closest("[data-fz-close]");
    if (x) { ev.stopPropagation(); close(x.dataset.fzClose); return; }
    const tb = ev.target.closest("[data-fz-tab]");
    if (tb) {
      state.active = tb.dataset.fzTab;
      const cur = state.tabs.find((t) => t.id === state.active);
      if (cur && cur.fresh) cur.fresh = false; // 点击聚焦清「新」角标
      closeTree();
      renderAll();
      return;
    }
    const rt = ev.target.closest("[data-fz-retry]");
    if (rt) { retry(rt.dataset.fzRetry); return; }
    // md 预览体内的路径 token（mdHtml 同款 .fpath）→ 经 session-domain 登记面解析开新 tab
    const fp = ev.target.closest(".fpath[data-p]");
    if (fp && typeof window.__ccDeck005FzoneOpenByToken === "function") { window.__ccDeck005FzoneOpenByToken(fp.dataset.p); return; }
    const co = ev.target.closest("[data-fz-collapse]");
    if (co) { setOpen(root.hidden, true); return; }
    // W-FZONE-B2 件③：树抽屉（钮=开/关切换；树内文件=OpenByToken 路由开 tab；树外点击=收树）
    if (ev.target.closest("[data-fz-tree-close]")) { closeTree(); return; }
    const tf = ev.target.closest("[data-fz-tree-open]");
    if (tf) {
      if (typeof window.__ccDeck005FzoneOpenByToken === "function") window.__ccDeck005FzoneOpenByToken(tf.dataset.fzTreeOpen);
      closeTree();
      return;
    }
    if (ev.target.closest(".fz-tree")) return; // 树体内部其余点击不动作
    if (ev.target.closest("[data-fz-tree-btn]")) { if (treeEl) closeTree(); else renderTree(); return; }
    if (treeEl) closeTree(); // 树外点击收树
  });
  root.addEventListener("auxclick", (ev) => { // 中键关闭（spec 交互流）
    if (ev.button !== 1) return;
    const tb = ev.target.closest("[data-fz-tab]");
    if (tb) { ev.preventDefault(); close(tb.dataset.fzTab); }
  });
  // W-FZONE-B2 件⑤（批一 P3 随批）：⌘/Ctrl+1..8 直达第 N tab（Nova/WKWebView 壳内生效——
  // 桌面浏览器 ⌘1-8 系浏览器 tab 切换保留键，页面层 preventDefault 抢不到属预期，回执声明）
  document.addEventListener("keydown", (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
    const n = parseInt(ev.key, 10);
    if (!(n >= 1 && n <= 8) || !state.tabs.length || root.hidden) return;
    const t = state.tabs[n - 1];
    if (!t) return;
    ev.preventDefault();
    t.fresh = false;
    state.active = t.id;
    closeTree();
    renderAll();
  });

  // 头部常驻开关钮（会话 head-actions 静态位——面板收起后唯一再展开入口；委托监听不依赖面板可见）
  document.addEventListener("click", (ev) => {
    const tg = ev.target.closest("[data-fzone-toggle]");
    if (tg) { ev.preventDefault(); setOpen(root.hidden, true); }
  });
  // W-FZONE-R3：拖拽柄=会话面板外的窗口级 sash（.fz-sash——WorkBuddy __detail-sash 形态）；
  // 算法 WorkBuddy 同构：mousedown 记 startX/startWidth → move=startWidth+(startX-clientX)（右锚定，
  // 向左拖=加宽）→ clamp[340,800] → up 摘监听+解锁 body cursor/userSelect（拖拽全程全局锁
  // col-resize 光标+禁文本选择——WorkBuddy onMouseUp 同款）。pointer capture 版实现（ Nova/WKWebView
  // 兼容性优于 document mousemove 挂摘）。
  const rz = document.querySelector("#d-session .fz-sash[data-fz-resize]");
  if (rz) {
    rz.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const startX = ev.clientX, startW = root.getBoundingClientRect().width;
      rz.setPointerCapture(ev.pointerId);
      rz.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (e2) => applyW(startW + (startX - e2.clientX));
      const up = () => {
        rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up);
        rz.classList.remove("dragging");
        document.body.style.cursor = ""; document.body.style.userSelect = "";
        try { localStorage.setItem(W_KEY, String(clampW(root.getBoundingClientRect().width))); } catch (_) {}
      };
      rz.addEventListener("pointermove", move); rz.addEventListener("pointerup", up);
    });
  }

  // ---------- 启动：冷启必收起（W-FZONE-R4） ----------
  // R3 及以前：OPEN_KEY 记忆上次开合、冷启自动恢复展开——用户实锤「空面板每次冷启复活=切不掉」
  // 病灶根除：内容 tab 本就不跨启持久，空面板冷启零价值。OPEN_KEY 读点退役（写点保留：用户主动
  // 开合仍记忆，不回灌冷启）；用户开文件/点头部钮才展开。
  applyW(readW());
  renderAll();

  // ---------- W-FZONE-R4：极窄自动收起（NARROW_W 单向）；R4-R1 刀二/刀三增强 ----------
  // 跨入窄域边沿且面板开→收起（tab 保留不丢；remember=true 写 OPEN_KEY=0——注：跨出不回弹的实际
  // 保障=下方「跨出边沿无动作」分支，该写入无消费者（审二 P3-② 备案，写点暂留不扩改））；
  // 窄域内 resize 不动作（用户头部钮手动再开不抢）；冷启必收起故载入态无面板可收（wasNarrow
  // 初始化即载入判定）。窄窗任何宽度面板都是真实列（R4 浮层形态已删，永不盖对话/输入框）。
  // R4-R1 刀二（审二第五轮直答①/P2-②）：NARROW_W 1000→1200——1000-1199「细条可用」带（对话列
  // 191-291px+按钮溢出）正是用户主诉「工作区开着对话挤成缝」，跨入即收；自动收起复用 B4 toast
  // 通道示众（静默再收=审二实录病——「我自己开的拖下窗口就没了」），仅自动收起边沿弹（手动
  // 收/开、跨出窄域不弹）。
  const NARROW_W = 1200;
  let wasNarrow = window.innerWidth < NARROW_W;
  let rzTid = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rzTid);
    rzTid = setTimeout(() => {
      const narrow = window.innerWidth < NARROW_W;
      if (narrow && !wasNarrow && !root.hidden) {
        setOpen(false, true);
        try { if (window.__ccDeck005B4 && typeof window.__ccDeck005B4.toast === "function") window.__ccDeck005B4.toast("窗口过窄，文件工作区已收起（头部 ▤ 工作区 可再开）"); } catch (_) {}
      }
      wasNarrow = narrow;
      // R4 P1-2 修（审 B）+ R4-R1 刀三合流：面板开着时视口变化（不跨窄域如 1200→1100，或跨出变宽）
      // 同样重钳——变窄收进 avail 护栏（1200-1399 带 800px 面板挤对话同治），变宽回弹到记忆宽
      //（readW=拖柄存值即记忆，回弹与拖柄语义一致；「只收不放」改为「收进回弹」——P1-2 只收目标
      // 由 avail 钳承载，回弹不破坏其极窄自洽：极窄再开仍被 avail 压住）。
      if (!root.hidden) applyW(readW());
    }, 120);
  });

  window.ccDeckFzone = Object.freeze({ open, autoOpen, close, resetForSession, toggle: () => setOpen(root.hidden, true), isOpen: () => !root.hidden, tabs: () => state.tabs.map((t) => t.path) }); // B2：autoOpen 入 API（session-domain 差分挂点消费）
})();
