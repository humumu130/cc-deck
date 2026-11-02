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
  _raf: 0,
  active() { return !!document.querySelector("#stage-desktop.active"); },
  mark() { this._dirty = true; },
  flushers: new Set(),
  // W-DESKNOTIFY（1102 用户实锤：点击通知铃铛 2-3s 才见面板）：active 态从「每事件同步跑
  // fn」改为「记脏+rAF 合并」——relay 高载期 ws 帧积压时，旧路径每帧同步全量渲=主线程被
  // 连续长任务占满，点击事件排在积压后面（点击→handler 等待=积压渲总时长）。rAF 合并后：
  // 同一 tick 内到达的 N 帧只渲一次，状态合并不受影响（门只管 DOM 渲染，帧处理照常），
  // 输入事件在 task 间隙获得处理窗（点击→面板可见 ≤ 一个渲染单元+1 帧）。
  // rAF 暂停（窗隐藏）期事件照常记脏，回视后首个 rAF tick 一次补渲（比旧同步渲更省——
  // hidden 期零渲染浪费）。flush() 维持同步语义（台切换 MutationObserver 补渲路径）。
  run(fn) {
    this.flushers.add(fn);
    this._dirty = true;
    if (this.active()) { this._schedule(); return true; }
    return false;
  },
  // W-DESKNOTIFY 三刀（面板开让位）：通知面板打开的帧把已排定的渲染分片撤队——先画面板
  // （用户点击→可见的帧优先），ms 后恢复补渲（数据不丢，dirty 保留）。面板关/超时兜底
  // _schedule 幂等（_raf 在位即不重排）。
  yieldPaint(ms) {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    if (!this._pending || !this._pending.length) this._dirty = true; // 无分片在跑也标脏（让位帧后必有一渲）
    setTimeout(() => { try { this._schedule(); } catch (_) {} }, Math.max(0, ms | 0));
  },
  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.flush(); });
  },
  // W-DESKNOTIFY 二刀（逐 flusher 分帧）：单 flush 只跑一个渲染器，余下排下一 rAF tick——
  // 最重渲染器（实测会话列表单渲 400-600ms）不再联手成多秒长任务，输入事件在渲染器
  // 之间获得处理窗（点击→面板可见 ≤ 单渲染器耗时）。台切换 flush() 同步语义保留：
  // 无 pending 队列时整轮跑（visibility 补渲不能一滴一滴）；分帧中途台被切走则剩队
  // 转脏（active() 失败自然停，回视补渲）。
  _pending: null,
  flush() {
    if (!this.active()) { if (this._pending && this._pending.length) this._dirty = true; this._pending = null; return; }
    if (this._pending && this._pending.length) { // 分帧续排（同步调用方继续排队）
      const f = this._pending.shift();
      try { f(); } catch (_) {}
      if (this._pending.length) { this._schedule(); return; }
      this._pending = null;
      if (this._dirty) { this._dirty = false; this.flush(); }
      return;
    }
    if (!this._dirty) return;
    this._dirty = false;
    const fns = [...this.flushers];
    if (fns.length <= 1) { try { fns[0] && fns[0](); } catch (_) {} return; }
    this._pending = fns;
    const first = this._pending.shift();
    try { first(); } catch (_) {}
    if (this._pending.length) this._schedule();
    else this._pending = null;
  },
};
(() => {
  const el = document.getElementById("stage-desktop");
  if (!el) return;
  new MutationObserver(() => { window.__ccDeck005DeskRender && window.__ccDeck005DeskRender.flush(); }).observe(el, { attributes: true, attributeFilter: ["class"] });
})();
