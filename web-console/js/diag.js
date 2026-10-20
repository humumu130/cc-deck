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
  