// W-NAVBAR（1112 用户拍板·期一）：历史提问索引轨——消息流右缘导航条。
// 逆向规格=~/.cc-deck/artifacts/w-fzone-nav.md（WorkBuddy ConversationHistoryNavigation
// 定谳：右缘 40px 短横线轨→hover 展开 96~320px 毛玻璃面板列用户提问文本→点击平滑跳转
// +滚动双向同步 active）。期一减配（调研 §五.2）：轨道+hover 展开+点击跳转+滚动同步，
// 开合 width/opacity 过渡——免 WorkBuddy 的 clip-path 双布局插值+scrollTop 补偿链（期二候选）。
// 交互参数照抄规格 §三：enter 防抖 60ms / leave 延迟 180ms / 行高 26 / 折叠线距 5px /
// 高上限 400+上下渐隐 mask / 文本截 160 字 / 门槛 ≥5 条用户消息 ∧ 视口 ≥880px /
// a11y（aria-label「历史提问」+展开 listbox/option+aria-selected+Escape 关）。
// 自治组件：数据源=DOM 扫描（.msg-user-row[data-x] 排除 .msg-echo 待发占位），MutationObserver
// 监听 #session-body 重建（切会话/新消息/回放自适应）+resize 门槛复检；零数据面零挂口依赖
//（session-domain 零改动——与 fzone 的挂口模式分立：本组件纯只读 DOM）。
(function () {
  "use strict";
  const MIN_ITEMS = 5, MIN_VW = 880, TEXT_MAX = 160, MAX_H = 400;
  const ENTER_MS = 60, LEAVE_MS = 180;
  let root = null, linesEl = null, panelEl = null;
  let items = [];            // [{ key, el, text }]
  let open = false, activeKey = null;
  let enterT = 0, leaveT = 0, raf = 0, mo = null, ro = null, buildT = 0;

  const bodyEl = () => document.getElementById("session-body");
  const hostEl = () => document.querySelector("#d-session .workspace");

  function collect() {
    const b = bodyEl();
    if (!b) return [];
    return [...b.querySelectorAll(".msg-user-row[data-x]")]
      .filter((r) => !r.classList.contains("msg-echo")) // 待发/失败回显占位不入索引（非真提问）
      .map((r) => {
        const ub = r.querySelector(".ub");
        return { key: r.dataset.x, el: r, text: String((ub && ub.textContent) || "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX) };
      })
      .filter((it) => it.key && it.text);
  }

  function eligible() {
    return items.length >= MIN_ITEMS && window.innerWidth >= MIN_VW;
  }

  function setActive(key) {
    if (key === activeKey) return;
    activeKey = key;
    root.querySelectorAll("[data-nav-key]").forEach((n) => {
      const on = n.dataset.navKey === key;
      n.classList.toggle("msg-navbar__item--active", on);
      n.classList.toggle("msg-navbar__line--active", on && n.classList.contains("msg-navbar__line"));
      n.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  // 滚动同步（rAF 节流·passive 监听）：可视区顶部最后一条已越过的用户消息=active
  //（对位 WorkBuddy visibleRequestId 语义的 DOM 版——非虚拟化全挂载直接量 rect）
  function syncActive() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const b = bodyEl();
      if (!b || !items.length) return;
      const bt = b.getBoundingClientRect().top;
      let hit = null;
      for (const it of items) {
        const r = it.el.getBoundingClientRect();
        if (r.top <= bt + 8) hit = it;
        else break;
      }
      setActive(hit ? hit.key : null);
    });
  }

  function jump(it) {
    // cc-deck 消息流非虚拟化全挂载——scrollIntoView 直达（调研定谳：WorkBuddy 的
    // ensureLoaded 虚拟加载链整层不需要）
    it.el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(it.key);
  }

  function schedule(on) {
    // enter 防抖 60ms / leave 延迟 180ms（规格 §三原参数）
    if (on) {
      if (leaveT) { clearTimeout(leaveT); leaveT = 0; }
      if (!open && !enterT) enterT = setTimeout(() => { enterT = 0; setOpen(true); }, ENTER_MS);
    } else {
      if (enterT) { clearTimeout(enterT); enterT = 0; }
      if (open && !leaveT) leaveT = setTimeout(() => { leaveT = 0; setOpen(false); }, LEAVE_MS);
    }
  }

  function setOpen(on) {
    open = on;
    root.classList.toggle("open", on);
    root.setAttribute("aria-expanded", on ? "true" : "false");
    panelEl.setAttribute("role", on ? "listbox" : "presentation");
    root.querySelectorAll("[data-nav-key].msg-navbar__item").forEach((n) => n.setAttribute("role", on ? "option" : "presentation"));
  }

  function build() {
    const host = hostEl();
    if (!host) return;
    items = collect();
    if (!root) {
      root = document.createElement("aside");
      root.className = "msg-navbar";
      root.setAttribute("aria-label", "历史提问");
      root.setAttribute("aria-expanded", "false");
      linesEl = document.createElement("div");
      linesEl.className = "msg-navbar__lines";
      linesEl.setAttribute("aria-hidden", "true");
      panelEl = document.createElement("div");
      panelEl.className = "msg-navbar__panel";
      root.append(panelEl, linesEl);
      root.addEventListener("mouseenter", () => schedule(true));
      root.addEventListener("mouseleave", () => schedule(false));
      root.addEventListener("keydown", (ev) => { if (ev.key === "Escape") setOpen(false); });
      host.appendChild(root);
    }
    const ok = eligible();
    root.hidden = !ok;
    if (!ok) { items = []; return; }
    // 双视图同构渲染：折叠轨（短横线列）+展开面板（文本行）——同 key 双份，active 双写
    linesEl.textContent = "";
    panelEl.textContent = "";
    for (const it of items) {
      const line = document.createElement("button");
      line.type = "button";
      line.className = "msg-navbar__line";
      line.dataset.navKey = it.key;
      line.title = it.text;
      line.tabIndex = -1; // 轨线不占 Tab 序（面板行是可聚焦主入口）
      line.addEventListener("click", () => jump(it));
      linesEl.appendChild(line);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "msg-navbar__item";
      row.dataset.navKey = it.key;
      row.title = it.text;
      row.setAttribute("aria-selected", "false");
      row.innerHTML = '<span class="txt"></span><span class="tick" aria-hidden="true"></span>';
      row.querySelector(".txt").textContent = it.text; // textContent 赋值——消息文本零 HTML 注入面
      row.addEventListener("click", () => jump(it));
      panelEl.appendChild(row);
    }
    root.style.setProperty("--msg-navbar-max-h", Math.min(MAX_H, items.length * 26 + 16) + "px");
    syncActive();
  }

  function scheduleBuild() {
    if (buildT) return;
    buildT = setTimeout(() => { buildT = 0; build(); }, 200); // 消息流渲染抖动去颤（回放/流式合并窗）
  }

  function boot() {
    const b = bodyEl();
    if (!b) return;
    if (typeof MutationObserver === "function") {
      mo = new MutationObserver(scheduleBuild);
      mo.observe(b, { childList: true, subtree: true });
    }
    window.addEventListener("resize", scheduleBuild, { passive: true });
    b.addEventListener("scroll", syncActive, { passive: true });
    build();
  }

  window.ccDeckNavbar = { rebuild: scheduleBuild, items: () => items.length, isOpen: () => open }; // 诊断/探针口
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
