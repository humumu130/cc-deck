    // 任何域炸了都能肉眼看到：错误文本（message+文件:行:列）渲染进当前激活域容器顶部。
    // 零外部 CSS 依赖（全内联样式）——样式系统塌陷时依然可见（这正是 Windows 现场的形态）
    (() => {
      const seen = [];
      const paint = () => {
        const host = document.querySelector(".desktop-screen.active .workspace") || document.querySelector(".desktop-screen.active") || document.body;
        if (!host) return;
        let bar = host.querySelector("[data-blankset2-diag]");
        if (!bar) {
          bar = document.createElement("div");
          bar.setAttribute("data-blankset2-diag", "1");
          bar.style.cssText = "position:sticky;top:0;left:0;right:0;z-index:99999;background:#3B0A0A;color:#FF9B9B;font:11px/1.5 Consolas,Menlo,monospace;padding:6px 10px;white-space:pre-wrap;word-break:break-all;border-bottom:2px solid #FF6B6B";
          host.insertBefore(bar, host.firstChild);
        }
        bar.textContent = "⚠ 诊断版捕获 " + seen.length + " 处错误（截图回传此区）：\n" + seen.slice(0, 8).join("\n");
      };
      const push = (tag, msg) => { seen.push(tag + " " + String(msg).slice(0, 220)); paint(); console.error("[diag]", tag, msg); };
      window.addEventListener("error", (e) => push("[JS]", (e.message || "Error") + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno + ":" + e.colno));
      window.addEventListener("unhandledrejection", (e) => push("[Promise]", (e.reason && (e.reason.message || e.reason.stack && e.reason.stack.split("\n")[0])) || e.reason || "unknown"));
      window.__blankset2Paint = paint; // 分段 try/catch 借道同一显形条
    })();
  // ===== W-MOBILE-PERF（1102 用户 P0）：桌面管线可见性门（手机 WebView 跑整页，桌面域
// hidden 时其渲染管线仍在每桥事件全量渲=主线程饱和真凶之一）。语义：桌面台不在视→
// 桌面渲染函数只记脏跳过；台激活（viewport 切回/类翻转）时一次性补渲（flushers 去重）。
// 状态合并（S.sessions 等）不在门内——帧处理照常，只门 DOM 渲染。=====
window.__ccDeck005DeskRender = {
  _dirty: false,
  active() { return !!document.querySelector("#stage-desktop.active"); },
  mark() { this._dirty = true; },
  flushers: new Set(),
  run(fn) { this.flushers.add(fn); if (this.active()) { try { fn(); } catch (_) {} return true; } this._dirty = true; return false; },
  flush() { if (!this._dirty || !this.active()) return; this._dirty = false; for (const f of this.flushers) { try { f(); } catch (_) {} } },
};
(() => {
  const el = document.getElementById("stage-desktop");
  if (!el) return;
  new MutationObserver(() => { window.__ccDeck005DeskRender && window.__ccDeck005DeskRender.flush(); }).observe(el, { attributes: true, attributeFilter: ["class"] });
})();
