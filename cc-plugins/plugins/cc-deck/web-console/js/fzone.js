// W-FZONE-B1（1111 拍板方案 B · 批一）：右侧文件工作区——tab 系统 + 容器（拖宽/收起/记忆）。
// 设计规格 = ~/.cc-deck/artifacts/fzone-mocks/b.html（ws/ws-tools/ws-tabs/wtab 形态权威）。
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
  const loadFn = () => (typeof window.__ccDeck005FzoneLoad === "function" ? window.__ccDeck005FzoneLoad : null);
  const iconHtml = (name) => (typeof window.__ccDeck005ArtIconHtml === "function" ? window.__ccDeck005ArtIconHtml(name) : "");

  // ---------- 宽度/收起（记忆：localStorage 持久——任务书「收起/展开记忆」） ----------
  function clampW(w) { return Math.max(280, Math.min(Math.round(window.innerWidth * 0.72), w)); }
  function applyW(w) { root.style.width = clampW(w) + "px"; }
  function readW() {
    const v = Number(localStorage.getItem(W_KEY));
    return Number.isFinite(v) && v >= 280 ? v : Math.round(window.innerWidth * 0.38); // 缺省 38%（任务书口径）
  }
  function setOpen(on, remember) {
    root.hidden = !on;
    root.classList.toggle("open", on);
    if (remember) { try { localStorage.setItem(OPEN_KEY, on ? "1" : "0"); } catch (_) {} }
    const main = document.querySelector("#d-session .workspace-main");
    if (main) main.classList.toggle("fz-on", on);
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
    if (state.active === id) state.active = state.tabs[Math.min(i, state.tabs.length - 1)]?.id ?? null;
    if (!state.tabs.length) { setOpen(false, true); state.active = null; renderAll(); return; }
    renderAll();
  }
  // 切会话清空（W-FZONE-B1-R1 P2-① 必修——双审路B B1：旧 tab 跨会话残留+retry 全局 sid 会静默
  // 载入错误会话的同名路径内容）。lastSid 幂等守卫：同 sid 重入零动作（选中链 MO/slimOpenSession
  // 双挂点安全）。开合态不动（OPEN_KEY 语义不变），清后面板留空态提示卡；按会话分组隔离=批二。
  function resetForSession(sid) {
    const s = String(sid || "");
    if (s === state.lastSid) return;
    state.lastSid = s;
    closeTree(); // 树抽屉随会话清空（数据源已随会话切换失效）
    [...bodyEl.querySelectorAll("[data-fz-pane]")].forEach(unloadPane);
    bodyEl.innerHTML = "";
    state.tabs = [];
    state.active = null;
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
  const rz = root.querySelector("[data-fz-resize]");
  if (rz) {
    rz.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const startX = ev.clientX, startW = root.getBoundingClientRect().width;
      rz.setPointerCapture(ev.pointerId);
      const move = (e2) => applyW(startW + (startX - e2.clientX));
      const up = () => {
        rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up);
        try { localStorage.setItem(W_KEY, String(clampW(root.getBoundingClientRect().width))); } catch (_) {}
      };
      rz.addEventListener("pointermove", move); rz.addEventListener("pointerup", up);
    });
  }

  // ---------- 启动：恢复上次开合（有 tab 才显——冷启零 tab 不占版面；OPEN_KEY 记忆上次主动开合） ----------
  applyW(readW());
  const remembered = (() => { try { return localStorage.getItem(OPEN_KEY) === "1"; } catch (_) { return false; } })();
  if (remembered) setOpen(true, false); // 恢复展开但零 tab=空态（批一无自动重开文件——内容 tab 不持久化）
  renderAll();

  window.ccDeckFzone = Object.freeze({ open, autoOpen, close, resetForSession, toggle: () => setOpen(root.hidden, true), isOpen: () => !root.hidden, tabs: () => state.tabs.map((t) => t.path) }); // B2：autoOpen 入 API（session-domain 差分挂点消费）
})();
