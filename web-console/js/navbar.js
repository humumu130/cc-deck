// W-NAVBAR（1112 期一→1115 期二 t-f206eddc）：历史提问索引轨——消息流右缘导航条。
// 逆向规格=~/.cc-deck/artifacts/w-fzone-nav.md（WorkBuddy ConversationHistoryNavigation）。
// 期二四修（用户 #166 实锤）：
//   ①动效对标原版：呼出 .543s cubic-bezier(.16,1,.3,1)/收起 .343s cubic-bezier(.45,0,.3,1)
//    （规格 §三原参数）——形态改 **clip-path 裁剪展开**（原版机制：面板恒 max-content，
//    折叠态裁到只露右侧 44px 线区+卡面透明，展开=裁剪框左移擦显+卡面渐入）；期一的
//    opacity/translateX 过渡退役。reduced-motion 降级直切（CSS 段）。
//   ②悬浮窗融合：卡面走 cc-deck token（--surface1 实底/--line 描边/--radius-lg/轻阴影
//    ——fz 树抽屉同款卡面语言），去期一 blur+color-mix（丑源=与全站实底风格不融）。
//   ③加高：单套行 DOM 行高 26px（期一线列 gap 5px 双 DOM 退役——合并即原版「一套 DOM
//    双视图」）；>28 条均匀采样 28 行（原版 V=min(len,28) 同款）+采样必含首/尾/active。
//   ④避让：右移 right 34px 让开 inspector-expand 抽屉呼出钮（实测钮带 x[视口-20,视口]×
//    y[409,481] 与期一 right:10px 线区正撞——CDP 数字见回执）。
// 自治组件不变：DOM 扫描+MutationObserver 去颤重建+resize 门槛复检（期一架构）。
// W-NAVHIT（审一批）教训保留：命中层 ::before 必须 z-index:-1（定位伪元素默认绘于且
// hit-test 于内容之上——线中心真点击被吞，NAVHIT-R1 实锤）。
(function () {
  "use strict";
  const MIN_ITEMS = 5, MIN_VW = 880, TEXT_MAX = 160, MAX_H = 400;
  const ENTER_MS = 60, LEAVE_MS = 180, MAX_LINES = 28; // MAX_LINES=折叠轨显示上限（WorkBuddy V=min(len,28) 同款）
  let root = null, panelEl = null;
  let items = [];            // 全量 [{ key, el, text }]
  let shown = [];            // 采样后（≤28，必含首/尾/active）
  let open = false, activeKey = null;
  let enterT = 0, leaveT = 0, raf = 0, mo = null, buildT = 0;
  let fishY = 0, fishT = 0; // 期二 R1 fisheye：光标 Y+在飞 rAF 帧号（mouseleave 复位见 fishReset）

  // fisheye 鼠标跟随放大（W-UIP2 期三强化·1115 test.18 用户 #169「选中那条变长不明显」）：
  // 刻度 --fz = 1 + 2.2·exp(−d²/2σ²)（σ=40px，峰值 3.2×——期二 1.9× 观感不足）——命中行
  // tick 12×3.2≈38px ≥36px 要求；σ 46→40 邻域衰减更聚焦（命中突出=选中感）；亮度随 --fz
  // 插值在 CSS tick 行（color-mix calc）。rAF 合帧不变。
  function fishApply() {
    fishT = 0;
    if (!panelEl) return;
    for (const r of panelEl.querySelectorAll(".msg-navbar__item")) {
      const rc = r.getBoundingClientRect();
      if (!rc.height) continue;
      const d = fishY - (rc.top + rc.height / 2);
      const s = 1 + 2.2 * Math.exp(-(d * d) / 3200); // 2σ²=2·40²=3200（W-UIP2：峰值 1.9→3.2×，σ 46→40）
      r.style.setProperty("--fz", s.toFixed(3));
    }
  }
  function fishReset() {
    fishY = 0;
    if (fishT) { cancelAnimationFrame(fishT); fishT = 0; }
    if (panelEl) panelEl.querySelectorAll(".msg-navbar__item").forEach((r) => r.style.removeProperty("--fz"));
  }

  const bodyEl = () => document.getElementById("session-body");
  const hostEl = () => document.querySelector("#d-session .workspace");
  // UIP2-R1：可见条带门——光标 x 在（轨右缘-64px, 轨右缘] 内才算「直接放在导航条上」
  // （44px 折叠条带+20px 容差）；条带左边的隐形区（aside 整盒）一律不算
  const onStrip = (cx) => { if (!root) return false; const r = root.getBoundingClientRect(); return cx > r.right - 64 && cx <= r.right + 2; };

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

  // >28 条均匀采样至 28（原版窗口化的轻量替身——非虚拟化全挂载，跳转链不受采样影响：
  // 采样行点击跳本行；中间未采样行的跳转由滚动同步/面板滚动达成）。必含首/尾/active
  // （原版窗口化「保 active」同语义——active 恒可见=折叠轨的跟手锚）。
  function sample(list) {
    if (list.length <= MAX_LINES) return list.slice();
    const out = [];
    const step = (list.length - 1) / (MAX_LINES - 1);
    for (let i = 0; i < MAX_LINES; i++) out.push(list[Math.round(i * step)]);
    const dedup = out.filter((it, i) => i === 0 || it !== out[i - 1]);
    const active = list.find((it) => it.key === activeKey);
    if (active && !dedup.includes(active)) dedup[Math.max(1, Math.floor(dedup.length / 2))] = active;
    return dedup;
  }

  function eligible() {
    return items.length >= MIN_ITEMS && window.innerWidth >= MIN_VW;
  }

  function setActive(key) {
    if (key === activeKey) return;
    activeKey = key;
    // W-P3SWEEP（1115 审 P3）：>28 条时 sample 仅 build 时跑——滚动中 active 落到未采样行
    // （折叠轨无 active 锚=跟丢）。activeKey 先落账再检测：命中不在 shown → build() 重采样
    // （sample 读 activeKey 补位进 dedup 中位——首/尾保留不破；时序反了会补旧 active 白采）。
    if (key && !shown.some((it) => it.key === key) && items.length) build(); // 重采样后落入下方类循环（新建行上 --active 锚——return 会跳过=有行无锚）
    root.querySelectorAll("[data-nav-key]").forEach((n) => {
      const on = n.dataset.navKey === key;
      n.classList.toggle("msg-navbar__item--active", on);
      n.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  // 滚动同步（rAF 节流·passive 监听）：可视区顶部最后一条已越过的用户消息=active
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
    panelEl.querySelectorAll("[data-nav-key]").forEach((n) => n.setAttribute("role", on ? "option" : "presentation"));
    // NAVR4-②（1115 用户令「无法往上滚动，只能固定那些消息」）：展开态=全量行+真滚动，
    // 收起态=采样 28 概览轨——clip-path 动效元素不变，内容行集随态切换（行数几百级 DOM 可承受）
    renderRows(on ? items : shown);
    if (!on) panelEl.scrollTop = 0; // 收起归位（下次展开从顶部进）
    syncActive(); // NAVR4-R2 ③（审 P2）：renderRows 重建行后 active 高亮丢失——补同步
  }

  function renderRows(list) {
    panelEl.textContent = "";
    for (const it of list) {
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
    panelEl.querySelectorAll("[data-nav-key]").forEach((n) => n.setAttribute("role", open ? "option" : "presentation"));
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
      // 期二：单容器（panel 承载折叠轨+展开文本双视图——clip-path 裁剪切换，原版机制）；
      // ::before 命中层（W-NAVHIT）：z-index:-1 教训见文件头注
      panelEl = document.createElement("div");
      panelEl.className = "msg-navbar__panel";
      panelEl.setAttribute("aria-hidden", "false");
      root.appendChild(panelEl);
      // UIP2-R1（1115 用户令「鼠标在导航条左侧离得远也展开——只有直接放在导航条上才展开」）：
      // 根因=aside 按面板 max-content（≤320px）整盒接收 mouseenter，clip-path 只裁视觉不裁
      // 外层命中。双保险闸：①CSS 侧 .msg-navbar pointer-events:none+panel auto（命中面收
      // 敛到被裁剪的可见窄条）；②JS 侧 enter/move 均过「可见条带」门（右缘起 64px 内才认
      // hover——44px 条带+20px 容差），条带外一律按离开处理（开着的状态移出条带即收）
      root.addEventListener("mouseenter", (ev) => { if (open || onStrip(ev.clientX)) schedule(true); }); // UIP2-R2（审 P1-a）：open 态回入卡任意位=取消待收（条带门只在折叠态守）
      root.addEventListener("mouseleave", () => { schedule(false); fishReset(); });
      // 期二 R1（1115 用户令「跟随鼠标滚动的悬浮放大特效」）：fisheye——光标纵向扫过时
      // 刻度按距离高斯衰减放大（σ=46px 峰值 1.9×，WorkBuddy 原版 dock 放大同款观感），
      // 跟手走 rAF 合帧（mousemove 高频不逐帧写样式）；离场全复位。CSS 侧 --fz 因子消费
      // （tick 宽/高同乘，transition .12s 圆滑）；reduced-motion 由 CSS 降级闸兜底（直切）
      root.addEventListener("mousemove", (ev) => {
        if (!open && !onStrip(ev.clientX)) { schedule(false); return; } // UIP2-R2（审 P1-a）：条带门仅折叠态生效——展开态滑到卡中部读文不误收
        fishY = ev.clientY;
        if (!fishT) fishT = requestAnimationFrame(fishApply);
      });
      root.addEventListener("keydown", (ev) => { if (ev.key === "Escape") setOpen(false); });
      host.appendChild(root);
    }
    const ok = eligible();
    root.hidden = !ok;
    if (!ok) { items = []; return; }
    shown = sample(items);
    // NAVR4-①（1115 用户令「会和输入框有重叠」）：宿主 .workspace 含 workspace-footer（composer），
    // bottom:28px 落进输入区（实测压 92px）。NAVR4-R2（审 P1）：lift 改**底栈全距**测量式
    // （host 底 − 消息流底 = dock+agbox+footer 全家，基线 150 对上）——单量 footer 会漏
    // dock/agbox（agbox 展开 226px 时压 210px 实测）；三兄弟挂 ResizeObserver 任一变高即
    // scheduleBuild 去颤重建（MO 只盯 #session-body 看不见兄弟）
    const body = bodyEl();
    const lift = body ? Math.round(host.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom) + 16 : 144;
    root.style.setProperty("--msg-navbar-lift", lift + "px");
    // NAVR4-R2 ②：三兄弟（footer/agbox/dock）任一尺寸变 → scheduleBuild 去颤重建（lift 跟随）
    if (typeof ResizeObserver === "function") {
      root._ro = root._ro || new ResizeObserver(scheduleBuild);
      root._ro.disconnect();
      for (const sel of [".workspace-footer", ".agbox", ".session-state-dock"]) {
        const el = host.querySelector(":scope > " + sel);
        if (el) root._ro.observe(el);
      }
    }
    renderRows(open ? items : shown); // NAVR4-②：展开态保持全量（rebuild 不打断浏览）
    const rowsN = Math.min((open ? items : shown).length, Math.ceil(MAX_H / 22)); // W-P3SWEEP：26→22 对齐期三行高（MAX_H 预算按实际行距——高估致 max-height 恒过大无视觉病，档位对齐）
    root.style.setProperty("--msg-navbar-max-h", Math.min(MAX_H, rowsN * 22 + 12) + "px");
    root.style.setProperty("--msg-navbar-fold-h", Math.min(MAX_H, shown.length * 22 + 12) + "px");
    root.style.setProperty("--msg-navbar-open-h", Math.min(Math.round(window.innerHeight * 0.6), 520) + "px"); // 展开卡全量滚动上限（60vh/520 封顶）
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

  window.ccDeckNavbar = { rebuild: scheduleBuild, items: () => items.length, shown: () => shown.length, isOpen: () => open }; // 诊断/探针口
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
