(function () {
  "use strict";
  // W-SCROLLBAR（1101 用户重提）：会话/项目列表滚动条微信式显隐。
  // 原生条常驻在暗色主题下泛白扎眼 → 隐藏原生条，自绘 overlay thumb：
  //   hover 进=显 / 离=隐 / 滚动中恒显（停 800ms 且鼠标已离再隐）/ thumb 可拖拽滚。
  // 挂载纪律（对齐 #281 bindListScrollKeep 先例）：监听器只挂常驻宿主
  //   （#d-session .session-list / #d-project .queue），scroll/wheel 走捕获代理——
  //   会话域滚动元素 .list-upper 每帧 reconcile 存在整节点重建路径
  //   （session-domain mountUpper 兜底 list.replaceChildren(upper)），listener/
  //   ResizeObserver 不落滚动元素身上；thumb track 同理挂宿主（常驻），被兜底
  //   路径清掉时 ensureOverlay 按 isConnected 自愈重挂。
  // 项目域实勘（本批探针）：[data-project-queue] 原本 overflow:visible 且
  //   .queue overflow:hidden——长内容直接裁切不能滚（sh>ch 且 scrollTop 恒 0）；
  //   本批 CSS 段先把它滚动化（flex 列 + min-height:0 + overflow-y:auto）再配显隐。
  // 双写隐藏原生条：scrollbar-width:none（FF/Chrome121+）+ ::-webkit-scrollbar 宽 0
  //   （Tauri WKWebView＝Safari<18.2 不认 scrollbar-width，WebKit 伪元素兜底）。

  var LINGER_MS = 800; // 滚动停止后保留时长（任务书口径）
  var MIN_THUMB_H = 28; // 比例极小时的保底可抓高度（微信同款）
  var INSTANCES = [];
  try { window.__wxSb = INSTANCES; } catch (_) {} // 探针/断言观察口（只读）

  function setup(cfg) {
    var host = document.querySelector(cfg.host);
    if (!host || host.dataset.wxSbBound) return;
    host.dataset.wxSbBound = "1";
    var st = { hover: false, scrolling: false, dragging: false, timer: 0, raf: 0, track: null, thumb: null, ro: null, lastScroller: null, metrics: null };
    INSTANCES.push({ host: cfg.host, scroller: cfg.scroller, track: function () { return st.track; }, state: st });

    function scroller() { return host.querySelector(cfg.scroller); }

    function ensureOverlay() {
      var sc = scroller();
      if (!sc) return null;
      if (st.ro && st.lastScroller !== sc) { try { st.ro.disconnect(); st.ro = null; } catch (_) {} } // 滚动元素被重建→换观察锚
      if (!st.ro && window.ResizeObserver) {
        st.ro = new ResizeObserver(function () { queueSync(); });
        st.ro.observe(sc);
        st.ro.observe(host);
        st.lastScroller = sc;
      }
      if (!st.track || !st.track.isConnected) { // mountUpper 兜底 replaceChildren 清宿主→自愈重挂
        var track = document.createElement("div");
        track.className = "wx-sb-track";
        var thumb = document.createElement("div");
        thumb.className = "wx-sb-thumb";
        thumb.setAttribute("aria-hidden", "true");
        track.appendChild(thumb);
        host.appendChild(track);
        st.track = track;
        st.thumb = thumb;
        bindDrag(thumb);
      }
      return st.track;
    }

    function sync() {
      var sc = scroller();
      var track = ensureOverlay();
      if (!sc || !track || !st.thumb) return;
      var sh = sc.scrollHeight, ch = sc.clientHeight;
      var overflow = sh > ch + 1;
      track.style.display = overflow ? "" : "none"; // 空态/未溢出=无条（.list-upper.is-empty 同兜住）
      if (!overflow) { st.metrics = null; return; }
      var trackH = host.clientHeight || ch; // track 铺宿主（top:0 bottom:0），比例按宿主高算
      var th = Math.max(MIN_THUMB_H, Math.min(trackH, Math.round(ch * ch / sh)));
      var span = Math.max(1, trackH - th);
      var y = Math.round((sc.scrollTop / Math.max(1, sh - ch)) * span);
      st.thumb.style.height = th + "px";
      st.thumb.style.transform = "translateY(" + y + "px)";
      st.metrics = { sh: sh, ch: ch, trackH: trackH, th: th };
    }

    function queueSync() { if (st.raf) return; st.raf = requestAnimationFrame(function () { st.raf = 0; sync(); }); }

    function show() { var t = ensureOverlay() || st.track; if (t) t.classList.add("is-on"); } // 先 ensure：冷启动未 hover 直滚轮时 track 尚未建，建后立即点亮
    function hide() { if (!st.hover && !st.scrolling && !st.dragging && st.track) st.track.classList.remove("is-on"); }

    function markScrolling() {
      st.scrolling = true;
      show();
      clearTimeout(st.timer);
      st.timer = setTimeout(function () { st.scrolling = false; hide(); }, LINGER_MS); // 停滚 800ms 后鼠标已离再隐
      queueSync();
    }

    function bindDrag(thumb) { // P2 加分项：thumb 拖拽映射 scrollTop
      thumb.addEventListener("pointerdown", function (e) {
        var sc = scroller();
        if (!sc || !st.metrics) return;
        e.preventDefault();
        e.stopPropagation();
        st.dragging = true;
        thumb.classList.add("is-drag");
        show();
        var m = st.metrics;
        var startY = e.clientY, startTop = sc.scrollTop;
        var ratio = (m.sh - m.ch) / Math.max(1, m.trackH - m.th); // 像素→滚动量的换算
        var move = function (ev) {
          sc.scrollTop = Math.max(0, Math.min(m.sh - m.ch, startTop + (ev.clientY - startY) * ratio));
          queueSync();
        };
        var up = function () {
          st.dragging = false;
          thumb.classList.remove("is-drag");
          thumb.removeEventListener("pointermove", move);
          hide(); // 拖完按 hover/scrolling 态收口
        };
        try { thumb.setPointerCapture(e.pointerId); } catch (_) {} // 出 thumb 追踪不丢
        thumb.addEventListener("pointermove", move);
        thumb.addEventListener("pointerup", up, { once: true });
        thumb.addEventListener("pointercancel", up, { once: true });
      });
    }

    host.addEventListener("mouseenter", function () { st.hover = true; sync(); show(); });
    host.addEventListener("mouseleave", function () { st.hover = false; hide(); });
    host.addEventListener("scroll", function (e) { // scroll 不冒泡但走捕获：.list-upper/[data-project-queue] 的滚动在宿主捕获面可见
      if (e.target !== host) markScrolling();
      queueSync();
    }, true);
    host.addEventListener("wheel", markScrolling, { passive: true, capture: true });
    host.addEventListener("touchmove", markScrolling, { passive: true, capture: true });
    if (window.MutationObserver) { // 宿主直接子级变动（.list-upper 首建/重建/track 被兜底清除）→ 同步量尺+自愈
      new MutationObserver(function () { queueSync(); }).observe(host, { childList: true });
    }
    sync(); // 首挂即量一次（未溢出时 track display:none 收纳）
  }

  function init() {
    setup({ host: "#d-session .session-list", scroller: ".list-upper" });
    setup({ host: "#d-project .queue", scroller: "[data-project-queue]" });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
