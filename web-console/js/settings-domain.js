    (() => {
      const desktopScreens = [...document.querySelectorAll(".desktop-screen")];
      const railButtons = [...document.querySelectorAll(".rail-btn")];
      const stages = { desktop: document.querySelector("#stage-desktop"), mobile: document.querySelector("#stage-mobile") };
      const toast = document.querySelector("#toast");
      const connectionChips = [...document.querySelectorAll(".connection-chip")];
      const themeToggles = [...document.querySelectorAll("[data-theme-toggle]")];
      // #158-②③ 桌面壳平台化：class 供 mac 圆点让位/⌘文案/路径展示分支（浏览器不加 class）。
      // W15：Windows 标准壳走系统标题栏（自绘三钮退役，winbtns 常隐）；W-NOVAVAR B2：
      // nova 壳（decorations=false，壳侧 INIT_SCRIPT 注入 __CCDECK_NOVA，此脚本之前已就位）
      // 叠加 nova-tauri——自绘三钮等无框专属 UI 只认 .nova-tauri，标准 win-tauri 不再
      // 误开（P1-2 双标题栏根修）
      const IS_MAC = /Mac/i.test(navigator.userAgent);
      if (window.__TAURI__?.window) {
        const tauriClasses = [IS_MAC ? "mac-tauri" : "win-tauri"];
        if (window.__CCDECK_NOVA) tauriClasses.push("nova-tauri");
        document.documentElement.classList.add(...tauriClasses);
        // W-UIPOLISH ②：nova 圆角的全屏退直角——窗口盖满屏幕且无菜单栏偏移（screenY≤8，
        // 全屏态菜单栏隐藏窗口顶到 0；窗口态恒 y≥25 菜单栏高）才挂 is-native-fullscreen，
        // frame 圆角清零防四角透明缺角。仅比宽高会误伤「窗口恰好=逻辑分辨率」的机器
        //（1440×900 屏 + conf 默认 1440×900 窗口，真机实测误判）；resize 即判即切。
        // 8px 容差吸收系统菜单/坞隐显的像素差
        const fsSync = () => {
          const full = window.innerWidth >= screen.width - 8 && window.innerHeight >= screen.height - 8 && window.screenY <= 8;
          document.documentElement.classList.toggle("is-native-fullscreen", full);
        };
        window.addEventListener("resize", fsSync);
        fsSync();
      }
      const MOD_KEY = (k) => IS_MAC ? "⌘" + k : "Ctrl+" + k;
      let mobileReturn = "inbox";
      let toastTimer = null;
      // ⑥d 定版：005 壳出包版本（原 ⑥c-1 预发常量名退役，与全仓 VERSION 单一事实源统一）
      const CONSOLE_VERSION = "0.7.0-test.50";
      window.__ccDeck005Version = CONSOLE_VERSION; // ⑥c-2：移动端 IIFE 单一版本源
      // #158-批3 桌面壳版本（旧壳 8252-8266 范式）：INIT_SCRIPT 的 ccDeck 桥未暴露
      // appVersion——直接 __TAURI__.core.invoke("app_version")（返回壳 package.json 版本）。
      // 到位后刷新已渲染的消费点（关于面板 tag / 设置队列卡副行）；浏览器无壳 reject/无
      // core——回落 CONSOLE_VERSION（那才是它的身份）。移动端经 ccdeck:shellver 事件重渲
      if (!window.__shellVerTried) {
        window.__shellVerTried = true;
        try {
          const core = window.__TAURI__ && window.__TAURI__.core;
          if (core && typeof core.invoke === "function") {
            void core.invoke("app_version").then((v) => {
              if (typeof v !== "string" || !v.trim()) return;
              window.__shellVer = v;
              const tag = document.querySelector("[data-settings-version-tag]");
              if (tag) tag.textContent = v + " 通道";
              try { window.dispatchEvent(new CustomEvent("ccdeck:shellver")); } catch (_) {}
            }, () => {});
          }
        } catch (_) {}
      }
      // #158-⌘文案 Windows 显示 Ctrl+：启动时全树替换静态 ⌘ 文案（设置卡 ⌘K 搜索 · ⌘N 新建会话；
      // W-TOPBAR ②：windowbar ⌘K 教学提示已退役，walker 全树扫不受影响）；
      // 动态模板走 MOD_KEY 分支。只改命中 text node，禁对容器整体 textContent 赋值——会摧毁子树
      if (!IS_MAC) {
        const swap = (s) => s.replace(/⌘K/g, "Ctrl+K").replace(/⌘N/g, "Ctrl+N").replace(/⌘/g, "Ctrl+"); /* W-BLANKSET2：replaceAll→正则 g（WebView2<85 兼容） */
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent.includes("⌘")) n.textContent = swap(n.textContent);
        }
      }

      function ensureThemeSymbols() {
        const sprite = document.querySelector(".icon-sprite");
        // #143 盲评S-2：页面有两个 .icon-sprite，只查第一个会误判缺失重复注入同名 symbol（无效 HTML）；
        // 判重一律走 document.getElementById 全文档口径（<use href> 按文档序取第一个，行为不变）
        if (!sprite) return;
        if (!document.getElementById("#icon-sun")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-sun" viewBox="0 0 24 24"><path d="M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14Zm-1-5h2v3h-2Zm0 21h2v3h-2ZM0 11h3v2H0Zm21 0h3v2h-3ZM3.5 4.9l1.4-1.4L7 5.6 5.6 7Zm13.5 13.5 2.1 2.1-1.4 1.4-2.1-2.1ZM3.5 19.1l2.1-2.1L7 18.4l-2.1 2.1ZM17 5.6l2.1-2.1 1.4 1.4-2.1 2.1Z"></path></symbol>');
        if (!document.getElementById("#icon-moon")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-moon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></symbol>');
        if (!document.getElementById("#icon-server")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-server" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="1"></rect><rect x="3" y="14" width="18" height="6" rx="1"></rect><line x1="7" y1="7" x2="7.01" y2="7"></line><line x1="7" y1="17" x2="7.01" y2="17"></line></symbol>');
        if (!document.getElementById("#icon-layers")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-layers" viewBox="0 0 24 24"><polygon points="12 2 21 7 12 12 3 7 12 2"></polygon><polyline points="3 12 12 17 21 12"></polyline><polyline points="3 17 12 22 21 17"></polyline></symbol>');
        if (!document.getElementById("#icon-sliders")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-sliders" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line><circle cx="9" cy="6" r="2"></circle><circle cx="15" cy="12" r="2"></circle><circle cx="10" cy="18" r="2"></circle></symbol>');
        if (!document.getElementById("#icon-package")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-package" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line></symbol>');
        if (!document.getElementById("#icon-file-text")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-file-text" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line><line x1="8" y1="9" x2="10" y2="9"></line></symbol>');
        if (!document.getElementById("#icon-code")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-code" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline><line x1="14" y1="4" x2="10" y2="20"></line></symbol>');
        if (!document.getElementById("#icon-archive")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-archive" viewBox="0 0 24 24"><path d="M3 6h18v14H3Z"></path><path d="M3 6l2-3h14l2 3M8 10h8M10 14h4"></path></symbol>');
        if (!document.getElementById("#icon-keyboard")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-keyboard" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"></rect><line x1="6" y1="10" x2="6.01" y2="10"></line><line x1="10" y1="10" x2="10.01" y2="10"></line><line x1="14" y1="10" x2="14.01" y2="10"></line><line x1="18" y1="10" x2="18.01" y2="10"></line><line x1="6" y1="14" x2="6.01" y2="14"></line><line x1="10" y1="14" x2="10.01" y2="14"></line><line x1="14" y1="14" x2="14.01" y2="14"></line><line x1="18" y1="14" x2="18.01" y2="14"></line></symbol>');
        if (!document.getElementById("#icon-image")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></symbol>');
        if (!document.getElementById("#icon-clock")) sprite.insertAdjacentHTML("beforeend", '<symbol id="icon-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></symbol>');
        const info = document.getElementById("#icon-info");
        if (info) info.innerHTML = '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>';
      }

      function applyTheme(theme, announce = false) {
        const next = theme === "light" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("cc-deck-theme", next); } catch (_) {}
        // W-NOVAFIX B7：桌面壳同步 Tauri 窗口主题——Windows 系统标准标题栏（nova 变体
        // decorations=true）颜色随窗口主题而非页面 CSS；不同步则浅色模式下顶栏仍深色。
        // capabilities 已含 core:window:allow-set-theme；浏览器形态无 __TAURI__ 自动跳过。
        try { window.__TAURI__?.window?.getCurrentWindow()?.setTheme(next === "light" ? "light" : "dark"); } catch (_) {}
        // #B3-1 theme-color meta 随主题（PWA/移动端浏览器 chrome 底色）
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#F1F2F5" : "#04080E");
        themeToggles.forEach((toggle) => {
          const icon = toggle.querySelector(".theme-toggle-icon");
          const label = toggle.querySelector("[data-theme-label]");
          const value = toggle.querySelector("[data-theme-value]");
          const target = next === "light" ? "深色" : "浅色";
          if (icon) icon.innerHTML = `<use href="#icon-${next === "light" ? "moon" : "sun"}"></use>`;
          if (label) label.textContent = `${next === "light" ? "浅色" : "深色"}主题 · 点击切换${target}`;
          if (value) value.textContent = next === "light" ? "浅色" : "深色";
          toggle.title = `切换${target}主题`;
          toggle.setAttribute("aria-label", toggle.title);
        });
        if (announce) showToast(`已切换到${next === "light" ? "浅色" : "深色"}主题`);
      }

      function applyCardDensity(density, announce = false) {
        const next = ["compact", "standard", "relaxed"].includes(density) ? density : "standard";
        document.body.dataset.cardDensity = next;
        try { localStorage.setItem("cc-deck-card-density", next); } catch (_) {}
        document.querySelectorAll("[data-card-density-option]").forEach((button) => {
          button.classList.toggle("active", button.dataset.cardDensityOption === next);
          button.setAttribute("aria-pressed", String(button.dataset.cardDensityOption === next));
        });
        if (announce) showToast(`卡片密度：${({ compact: "紧凑", standard: "标准", relaxed: "宽松" })[next]}`);
      }

      function wireCardDensityControls(root = document) {
        root.querySelectorAll("[data-card-density-option]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.cardDensityOption === document.body.dataset.cardDensity));
        });
      }

      // ===== W-UIPOLISH4 件十六（2026-10-12 用户方案）：字号调试临时面板 =====
      // 5 滑杆按类 override --fs-* token：body inline style（压过密度档=调试语义可接受），
      // localStorage 持久（ccd-fs-debug），不进 token 源码；调参结果由 PM 固化回 token 后
      // 面板退役。默认值=回退后的原始档（与 token 源保持同步，见 --fs-* 定义处注释）。
      const FS_DEBUG = {
        msg:   { label: "消息内容", tokens: ["--fs-A"], def: 14 },
        title: { label: "卡片标题", tokens: ["--srow-name-size", "--fs-A-item"], def: 15 },
        desc:  { label: "卡片描述", tokens: ["--srow-sub-size", "--fs-B"], def: 12 },
        ui:    { label: "界面 UI",  tokens: ["--fs-C", "--fs-D", "--fs-E"], def: 11 },
        mono:  { label: "等宽代码", tokens: ["--fs-F"], def: 12 },
      };
      const FS_DEBUG_KEY = "cc-deck-005-fs-debug";
      function fsDebugStore() {
        try { const v = JSON.parse(localStorage.getItem(FS_DEBUG_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
      }
      function applyFsDebug() { // boot + 每次 input/reset 后调用；越界/缺省=清 inline 回 token 源
        const saved = fsDebugStore();
        for (const key of Object.keys(FS_DEBUG)) {
          const px = Number(saved[key]);
          const ok = Number.isFinite(px) && px >= 10 && px <= 22;
          for (const tok of FS_DEBUG[key].tokens) {
            if (ok) document.body.style.setProperty(tok, px + "px");
            else document.body.style.removeProperty(tok);
          }
        }
      }
      function wireFsDebugPanel(root = document) { // 面板（重）建后回填滑杆位
        const saved = fsDebugStore();
        for (const key of Object.keys(FS_DEBUG)) {
          const input = root.querySelector('[data-settings-panel="general"] [data-fs-slider="' + key + '"]');
          if (!input) continue;
          const val = root.querySelector('[data-settings-panel="general"] [data-fs-val="' + key + '"]');
          const px = Number(saved[key]);
          input.value = String(Number.isFinite(px) ? px : FS_DEBUG[key].def);
          if (val) val.textContent = input.value + "px";
        }
      }
      document.addEventListener("input", (ev) => { // 滑杆实时生效（range 拖动逐档回调）
        const input = ev.target && ev.target.closest ? ev.target.closest("[data-fs-slider]") : null;
        if (!input) return;
        const key = input.dataset.fsSlider;
        if (!FS_DEBUG[key]) return;
        const px = Math.max(10, Math.min(22, Math.round(Number(input.value) || FS_DEBUG[key].def)));
        const saved = fsDebugStore();
        if (px === FS_DEBUG[key].def) delete saved[key]; else saved[key] = px; // 回默认=不落 override
        try { localStorage.setItem(FS_DEBUG_KEY, JSON.stringify(saved)); } catch {}
        applyFsDebug();
        const val = document.querySelector('[data-fs-val="' + key + '"]');
        if (val) val.textContent = px + "px";
      });
      document.addEventListener("click", (ev) => { // 本项重置 / 全部重置
        const one = ev.target && ev.target.closest ? ev.target.closest("[data-fs-reset-one]") : null;
        if (one) {
          const key = one.dataset.fsResetOne;
          if (FS_DEBUG[key]) {
            const saved = fsDebugStore();
            delete saved[key];
            try { localStorage.setItem(FS_DEBUG_KEY, JSON.stringify(saved)); } catch {}
            applyFsDebug(); wireFsDebugPanel(document);
          }
          return;
        }
        if (ev.target && ev.target.closest && ev.target.closest("[data-fs-reset-all]")) {
          try { localStorage.removeItem(FS_DEBUG_KEY); } catch {}
          applyFsDebug(); wireFsDebugPanel(document);
        }
      });
      applyFsDebug(); // boot：恢复上次调试值（本脚本在 body 尾，document 已就绪）

      let tablistSequence = 0;

      function wireSegmentTabSemantics(buttons, panes) {
        const tablist = buttons[0]?.parentElement;
        if (!tablist || tablist.dataset.ariaTabsReady) return;
        tablist.dataset.ariaTabsReady = "1";
        tablist.setAttribute("role", "tablist");
        const prefix = `tablist-${++tablistSequence}`;
        buttons.forEach((button, index) => {
          const pane = panes[index];
          const tabId = button.id || `${prefix}-tab-${index + 1}`;
          const panelId = pane?.id || `panel-${prefix}-${index + 1}`;
          button.id = tabId;
          button.setAttribute("role", "tab");
          button.setAttribute("aria-controls", panelId);
          button.tabIndex = -1;
          if (pane) {
            pane.id = panelId;
            pane.setAttribute("role", "tabpanel");
            pane.setAttribute("aria-labelledby", tabId);
          }
        });
        buttons.forEach((button, index) => {
          button.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return; // #B3-6 修饰键组合让位全局键链（Alt/Ctrl+←→ 是切数据源，旧壳 #67 同口径）
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const nextIndex = (index + direction + buttons.length) % buttons.length;
            buttons[nextIndex].click();
            buttons[nextIndex].focus();
          });
        });
        function activateTab(index) {
          buttons.forEach((button, buttonIndex) => {
            const active = buttonIndex === index;
            button.setAttribute("aria-selected", String(active));
            button.tabIndex = active ? 0 : -1;
          });
          panes.forEach((pane, paneIndex) => pane?.setAttribute("aria-hidden", String(paneIndex !== index)));
        }
        return activateTab;
      }

      function wireSegmentTabs(buttons, panes, activeIndex = 0) {
        const activateAriaTab = wireSegmentTabSemantics(buttons, panes);
        const activate = (index) => {
          buttons.forEach((button, buttonIndex) => button.classList.toggle("active", buttonIndex === index));
          panes.forEach((pane, paneIndex) => pane.classList.toggle("active", paneIndex === index));
          activateAriaTab?.(index);
        };
        buttons.forEach((button, index) => button.addEventListener("click", () => activate(index)));
        activate(activeIndex);
      }

      // FB6 检查器恢复+外扩：折叠态与拖宽值按屏持久化（localStorage），载入即还原；
      // 左沿 resizer 拖拽调宽 260-640px。W-NOVAUI ③：宽度落点从 grid 内联列宽改 --inspector-w
      // 变量（浮层化后 screen 只有两列，inspector 宽由自身 width 承载；collapsed 类 42px 覆盖）
      function inspectorStateKey(screen) { return "cc-deck-005-inspector-" + (screen.id || "x"); }
      function inspectorWidthKey(screen) { return "cc-deck-005-inspector-w-" + (screen.id || "x"); }
      function applyInspectorWidth(screen) {
        let w = null;
        try { w = Number(localStorage.getItem(inspectorWidthKey(screen))); } catch (_) {}
        if (Number.isFinite(w) && w >= 260 && w <= 640) screen.style.setProperty("--inspector-w", Math.round(w) + "px");
        else screen.style.removeProperty("--inspector-w");
      }
      function setInspectorCollapsed(screen, collapsed) {
        const inspector = screen.querySelector(".inspector");
        if (!inspector) return;
        screen.classList.toggle("inspector-collapsed", collapsed);
        inspector.classList.toggle("collapsed", collapsed);
        if (!collapsed) applyInspectorWidth(screen); // 展开回放记忆宽；收起只切类（整块 display:none）
        // 件六：两态把手文案恒定（收起钮 ›/展开把手 ‹——箭头指向=面板移动方向），
        // 不再随态切换文案（两钮本就各自只在自己态显形）
      }

      function applyInspectorBreakpoint() {
        // 件六：默认语义反转——所有域第四列默认收起；localStorage 记过 "expanded"（用户
        // 展开过）才展开。旧键 "collapsed" 语义兼容（仍收起）
        desktopScreens.forEach((screen) => {
          setInspectorCollapsed(screen, screen.dataset.inspectorManual !== "expanded");
        });
      }

      function initInspectors() {
        desktopScreens.forEach((screen) => {
          const inspector = screen.querySelector(".inspector");
          if (!inspector) return;
          try { if (localStorage.getItem(inspectorStateKey(screen)) === "expanded") screen.dataset.inspectorManual = "expanded"; } catch (_) {} // 件六：只认展开记忆，默认收起
          // 件六：两态把手都挂 screen（inspector overflow:hidden 会裁骑缝负偏移）——
          // 收起钮经 --inspector-w 变量贴面板左缘（拖宽实时跟随），展开把手贴 screen 右缘
          const button = document.createElement("button");
          button.className = "inspector-toggle";
          button.type = "button";
          button.dataset.inspectorToggle = "true";
          button.textContent = "›"; // 面板将向右收起退出
          button.title = "收起证据检查器";
          button.setAttribute("aria-label", button.title);
          screen.appendChild(button);
          // 复用 [data-inspector-toggle] 地基全局委托（免新增监听），仅收起态由 CSS 显形
          const expand = document.createElement("button");
          expand.className = "inspector-expand";
          expand.type = "button";
          expand.dataset.inspectorToggle = "true";
          expand.textContent = "‹"; // 面板将向左展开进入
          expand.title = "展开证据检查器";
          expand.setAttribute("aria-label", expand.title);
          screen.appendChild(expand);
          const resizer = document.createElement("div"); // FB6 外扩
          resizer.className = "inspector-resizer";
          resizer.title = "拖动调整检查器宽度";
          resizer.addEventListener("pointerdown", (ev) => {
            if (inspector.classList.contains("collapsed")) return;
            ev.preventDefault();
            const startX = ev.clientX;
            const startW = inspector.getBoundingClientRect().width;
            try { resizer.setPointerCapture(ev.pointerId); } catch (_) {}
            const onMove = (e) => {
              const w = Math.max(260, Math.min(640, startW - (e.clientX - startX)));
              screen.style.setProperty("--inspector-w", Math.round(w) + "px");
            };
            const onUp = () => {
              resizer.removeEventListener("pointermove", onMove);
              resizer.removeEventListener("pointerup", onUp);
              try { localStorage.setItem(inspectorWidthKey(screen), String(Math.round(inspector.getBoundingClientRect().width))); } catch (_) {}
            };
            resizer.addEventListener("pointermove", onMove);
            resizer.addEventListener("pointerup", onUp);
          });
          inspector.prepend(resizer);
        });
        applyInspectorBreakpoint();
        window.addEventListener("resize", applyInspectorBreakpoint);
      }

      // W-TOPBAR ⑤：第二列拖宽——queue 右缘 7px 把手，横向拖实时调宽（钳 180-420px），
      // 宽度按屏记忆（localStorage），双击把手恢复默认 327px（W-TOPBAR ⑧：rail 62px 之半
      // +31px，用户拍板加宽）。有第二列的屏（会话/团队等
      // 带列表列的域）统一生效；落点与 inspector 拖宽同范式（屏级 CSS 变量 + pointer capture）
      function queueWidthKey(screen) { return "cc-deck-queue-w-shared"; } /* #201⑨：分域键→全域单键（一列宽调整全域生效；旧分域键自然废弃不迁移） */
      function applyQueueWidth(screen) {
        let w = null;
        try { w = Number(localStorage.getItem(queueWidthKey(screen))); } catch (_) {}
        if (Number.isFinite(w) && w >= 235 && w <= 420) screen.style.setProperty("--queue-w", Math.round(w) + "px"); // W-V8R 批7：下限 327→235（v8 列表栏 235px；旧记忆 <235 视为无效回默认 235）
        else screen.style.removeProperty("--queue-w");
      }
      function initQueueResizers() {
        document.querySelectorAll(".desktop-screen").forEach((screen) => {
          const queue = screen.querySelector(".queue");
          if (!queue) return;
          applyQueueWidth(screen);
          const resizer = document.createElement("div");
          resizer.className = "queue-resizer";
          resizer.title = "拖动调整列表宽度 · 双击恢复默认";
          resizer.addEventListener("pointerdown", (ev) => {
            ev.preventDefault();
            try { resizer.setPointerCapture(ev.pointerId); } catch (_) {}
            const onMove = (e) => {
              const w = Math.max(327, Math.min(420, e.clientX - screen.getBoundingClientRect().left)); // ⑧ 下限同步默认 327
              screen.style.setProperty("--queue-w", Math.round(w) + "px");
            };
            const onUp = () => {
              resizer.removeEventListener("pointermove", onMove);
              resizer.removeEventListener("pointerup", onUp);
              try { localStorage.setItem(queueWidthKey(screen), String(parseInt(getComputedStyle(screen).getPropertyValue("--queue-w")) || queue.getBoundingClientRect().width)); } catch (_) {}
            };
            resizer.addEventListener("pointermove", onMove);
            resizer.addEventListener("pointerup", onUp);
          });
          resizer.addEventListener("dblclick", () => {
            screen.style.removeProperty("--queue-w");
            try { localStorage.removeItem(queueWidthKey(screen)); } catch (_) {}
          });
          screen.append(resizer); // 挂 screen 层：域脚本 replaceChildren 重建 queue 不丢把手
        });
      }


      function showToast(message) {
        const mode = document.querySelector("#stage-mobile.active") ? "mobile" : "desktop";
        const host = document.querySelector(mode === "mobile" ? ".mobile-frame" : ".desktop-frame");
        if (host && toast.parentElement !== host) host.append(toast);
        toast.textContent = message;
        toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
      }

      function setMode(mode) {
        closeTransientOverlays();
        Object.entries(stages).forEach(([key, stage]) => stage.classList.toggle("active", key === mode));
        const host = document.querySelector(mode === "mobile" ? ".mobile-frame" : ".desktop-frame");
        if (host && toast.parentElement !== host) host.append(toast);
      }

      let lastNonSettingsDomain = "session"; // FB9：设置 queue × 的返程票
      function setDesktopDomain(domain) {
        closeTransientOverlays();
        // W-NOVAUI ④：FB20 隐藏期兜底随开关退役——rail 项目入口恒显，project 域直达不再改写
        if (domain !== "settings") lastNonSettingsDomain = domain;
        const screen = document.querySelector(`#d-${domain}`);
        if (!screen) return;
        desktopScreens.forEach((item) => item.classList.toggle("active", item === screen));
        railButtons.forEach((button) => button.classList.toggle("active", button.dataset.domain === domain));
        // B16 域切换 toast 退役：rail 高亮已是即时可瞥反馈，弹toast 反遮内容
        renderWindowbarHint();
      }

      // ---------- FB2：workspace-sub 出舱入顶栏——各域提示文字集中路由到 windowbar 右侧 ----------
      // 每域存自己的最新文案，展示活动域的那条；windowbar 全局唯一，避免后写覆盖前域。
      // 域各在独立 <script> 块（函数声明不跨块），写点经 window.__ccDeck005SetWindowbarHint 进来
      const windowbarHintStore = { session: "加载中…", team: "尚未收到团队快照", project: "等待 relay SNAPSHOT…", settings: "" }; /* #119：notify 域改弹窗，不再占域提示位 */
      function setWindowbarHint(domain, text) {
        if (!(domain in windowbarHintStore)) return;
        windowbarHintStore[domain] = String(text || "");
        renderWindowbarHint();
      }
      function renderWindowbarHint() {
        const el = document.getElementById("windowbar-hint");
        const active = document.querySelector(".desktop-screen.active")?.id.replace(/^d-/, "");
        const text = active ? (windowbarHintStore[active] || "") : "";
        // W-TOPBAR ②：会话域提示（工作目录/最近活动，随会话切换变来变去）改路由第三列 head
        // 的 .head-meta——顶栏源胶囊右侧不再抖动；其余域维持顶栏右簇静态摘要
        const meta = document.getElementById("session-head-meta");
        if (meta) meta.textContent = active === "session" ? text : "";
        if (el) el.textContent = active === "session" ? "" : text;
      }
      window.__ccDeck005SetWindowbarHint = setWindowbarHint;
      window.__ccDeck005SourceDisplayName = sourceDisplayName; // W-UIFB ①：跨块消费（head 源徽标「本机」同口径）

      function openMobileRoot(root) {
        const target = document.querySelector(`#m-${root}`);
        if (!target) return;
        mobileReturn = root;
        document.querySelectorAll(".mobile-screen").forEach((screen) => screen.classList.toggle("active", screen === target));
        document.querySelectorAll(".mobile-nav [data-mobile-root]").forEach((button) => button.classList.toggle("active", button.dataset.mobileRoot === root));
        if (root === "inbox") {
          const list = target.querySelector(".mobile-content");
          if (list) list.scrollTop = 0;
        }
      }

      const engineIconFor = (engineClass = "") => engineClass === "claude" ? "chat" : engineClass === "codex" ? "code" : engineClass === "trae" ? "sliders" : "server";
      const engineBadgeMarkup = (item) => `<span class="engine-badge ${item.engineClass}"><svg class="engine-icon" aria-hidden="true"><use href="#icon-${engineIconFor(item.engineClass)}"></use></svg>${item.engine}</span>`;

      // FB19 源色块（地基同款）：按源名哈希取色，与 B2 会话卡同一套八色环
      const sessionSourcePalette = ["#3E8E7E", "#5B8FA8", "#8A7AB5", "#A8763E", "#7D9A3C", "#B55F7A", "#4E85C0", "#9A8A4E"];
      const sessionSourceColor = (source) => {
        const s = String(source || "");
        if (!s) return "var(--source)";
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return sessionSourcePalette[h % sessionSourcePalette.length];
      };
      // UIPOLISH2 件一（2026-10-11 用户拍板）：会话卡头像底色改引擎品牌色淡彩（方圆打架根治的另一半——
      // 形状圆形化在 CSS，颜色在此）。engineClass → --engine-* token 直映；未知引擎回落源色八色环。
      // 与 B2 端 myCardMarkup 的 b2AvaColor 逐字节同构（两渲染路径 DOM 必须一致，observer 完整性检查依赖）
      const sessionAvaColor = (item) => ({
        claude: "var(--engine-claude)", codex: "var(--engine-codex)", trae: "var(--engine-trae)",
        qwen: "var(--engine-qwen)", codebuddy: "var(--engine-codebuddy)", zcode: "var(--engine-zcode)",
      }[item.engineClass] || sessionSourceColor(item.source));
      const sessionCtaMarkup = (item) => item.tagClass === "action" || item.tagClass === "danger" ? `<button type="button" class="srow-cta">处理</button>` : "";
      // W-WINPAIR-R6 件九：源徽章带 FB19 八色环源色（同名恒色——与头像回落色同环）；单源隐藏由
      // body[data-source-count="1"] CSS 管（B2 渲染拍维护，聚合两源自 >1 显形）
      const sourceBadgeMarkup = (item) => `<span class="source-badge" style="color:${sessionSourceColor(item.source)};border-color:${sessionSourceColor(item.source)};background:color-mix(in srgb, ${sessionSourceColor(item.source)} 14%, transparent)">${item.source}</span>`;
      const renderSessionCard = (item, variant) => variant === "mobile" ? `<div class="mobile-card${item.primary ? " primary" : ""}" data-open-detail="${item.id}"><div class="row"><span class="avatar ${item.avatar}"><svg class="icon-status" aria-hidden="true"><use href="#icon-${item.icon}"></use></svg></span><strong>${item.title}</strong></div><p>${item.summary}</p><div class="identity-cluster">${item.tag ? `<span class="tag ${item.tagClass}">${item.tag}</span>` : ""}${engineBadgeMarkup(item)}${sourceBadgeMarkup(item)}</div></div>` : `<div class="queue-card${item.selected ? " selected" : ""}" data-session-card="${item.id}"><span class="srow-ava" style="--srow-ava-c:${sessionAvaColor(item)}">${(item.title || "·").trim().charAt(0).toUpperCase()}<i class="status-dot ${item.status}"></i></span><span class="srow-main"><span class="srow-r1"><strong title="${item.title}">${item.title}</strong>${item.time ? `<time class="srow-time">${item.time}</time>` : ""}</span><span class="srow-r2"><span class="srow-r2-t">${item.summary}</span>${item.status === "working" ? `<span class="srow-sec" data-work-sec="${item.workSecs || 0}">${item.workSecs || 0}s</span>` : ""}</span>${item.tag || item.engine || item.source || item.pinned ? `<span class="srow-r3">${item.pinned ? `<span class="tag pin-flag">置顶</span>` : ""}${item.tag ? `<span class="tag ${item.tagClass}">${item.tag}</span>` : ""}${engineBadgeMarkup(item)}${sourceBadgeMarkup(item)}</span>` : ""}</span>${sessionCtaMarkup(item)}</div>`;

function connectLan(ctx) {
  const cfg = ctx.cfg;
  if (!cfg.wsUrl || !cfg.token) { ctx.status = "offline"; ctx.statusText = "未配置"; ctx.failKind = "none"; setConn(ctx, "offline", "未配置"); return; }
  clearTimeout(ctx.reconnectTimer);
  const url = cfg.wsUrl + "?token=" + encodeURIComponent(cfg.token);
  setConn(ctx, "connecting", "连接中");
  try { ctx.ws && ctx.ws.close(); } catch {}
  const w = new WebSocket(url);
  ctx.ws = w;
  if (viewSource() !== "cloud") window.__ccDeck005MainWs = w; // #143 盲评A-1 止血：主连接标记——B4 桥命令通道固定走此 socket（ACK 回主连接，不再借道 B2 串台弹错）；W-WINPAIR-R2：云视角时命令面归云 shim，本机建连不抢
  window.__ccDeck005Frames.emit({ kind: "ws", state: "connecting", source: "lan" }); // #150 R2：建连即广播 connecting（桥恢复 connecting/online/offline 三态，消除 R1 遗留重连窗口显未连接）
  clearTimeout(ctx.lanHsTimer);
  ctx.lanHsTimer = setTimeout(() => {
    ctx.lanHsTimer = 0;
    if (ctx.ws !== w || w.readyState !== WebSocket.CONNECTING) return;
    try { w.close(); } catch {}
    setConn(ctx, "offline", "连接超时", "transport");
    scheduleReconnect(ctx);
  }, 8000);
  w.onopen = () => {
    if (ctx.ws !== w) return;
    clearTimeout(ctx.lanHsTimer); ctx.lanHsTimer = 0;
    ctx.reconnectDelay = RETRY_BASE_MS; // #40web 连上即归零退避
    setConn(ctx, "online", "已连接");
    syncTeamBind(); // #143 Leader 接线（B3-C3）：注入命令 Promise 通道；W-WINPAIR-R2：并行多源下按视角源在线性统一绑定
    window.__ccDeck005Frames.emit({ kind: "ws", state: "open", source: "lan" }); // #150 R1：总线广播连接事件（桥 connection→online）
  };
  w.onclose = () => {
    if (ctx.ws !== w) return;
    clearTimeout(ctx.lanHsTimer); ctx.lanHsTimer = 0;
    setConn(ctx, "offline", "已断开", "transport");
    syncTeamBind(); // #143 Leader 接线：离线禁决议 + 飞行中命令判未达（可重试）；W-WINPAIR-R2 统一口径
    window.__ccDeck005Frames.emit({ kind: "ws", state: "close", source: "lan" }); // #150 R1：先广播断开（订阅者先结算飞行命令），再排重连
    scheduleReconnect(ctx);
  };
  w.onerror = () => {};
  w.onmessage = (ev) => {
    if (ctx.ws !== w) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "COMMAND_ACK") Team.onAck(msg.payload || msg); // #143 Leader 接线（B3-C4）：ACK 消费；#150 R1 不再 return——ACK 同帧进总线，桥侧 ackWaiters 在总线结算
    else {
      if (msg.seq !== undefined) ctx.lastSeq = Math.max(ctx.lastSeq, msg.seq);
      onEvent(ctx, msg);
    }
    window.__ccDeck005Frames.emit({ kind: "frame", frame: msg, source: "lan" }); // #150 R1 帧总线：地基唯一持连，原始帧（含 COMMAND_ACK）统一 fan-out，域脚本不再各自分接；W-WINPAIR-R2 带 source 标记（订阅方按视角门控）
  };
}


      function closeRowMenu() {
        document.querySelector("#row-menu")?.classList.remove("open");
      }

      function closeTransientOverlays() {
        closeRowMenu();
        document.querySelectorAll(".artifact-sheet-backdrop.open, .source-menu.open, .artifact-menu.open").forEach((overlay) => {
          overlay.classList.remove("open");
          overlay.closest(".source-switcher")?.querySelector("[data-source-trigger]")?.setAttribute("aria-expanded", "false");
        });
        document.querySelectorAll("[data-pair-pop], [data-pair-back]").forEach((el) => el.remove()); // W-NOVAFIX B1 配对弹窗随 Esc/切域收口
        document.querySelectorAll("[data-add-pop], [data-add-back]").forEach((el) => el.remove()); // W-WINPAIR 添加服务器弹窗同口径收口
        document.querySelectorAll("[data-filter-pop]").forEach((el) => el.remove()); // FB17 筛选浮菜单同口径收口
        document.querySelectorAll("#b2-create-pop, [data-create-back]").forEach((el) => el.remove()); // B10 新建弹窗同口径收口（B2 域 IIFE 内函数，地基直删 DOM 免耦合）
        document.querySelectorAll("[data-source-trigger][aria-expanded='true']").forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
        window.__ccDeck005NotifyPanel?.close(); // #119 通知弹窗随 Esc/切域/切形态统一收口
      }

      // ---------- W-NOVAFIX B3b/c：source-menu 接线（此前只有静态壳无开合） ----------
      // trigger 开合 / 选项切换 / 模式切换 / 管理入口跳设置；source-badge 胶囊与 Ctrl+K / ⌘K
      // 同入此浮层（快速切换）。活动舞台优先（桌面 windowbar / 各移动屏 sourcebar 各一份壳）。
      function activeSourceSwitcher() {
        const stage = document.querySelector(".mode-stage.active") || document;
        return stage.querySelector(".source-switcher [data-source-menu]")?.closest(".source-switcher")
          || document.querySelector(".desktop-frame .source-switcher [data-source-menu]")?.closest(".source-switcher")
          || null;
      }
      function openSourceMenu() {
        closeTransientOverlays();
        const switcher = activeSourceSwitcher();
        if (!switcher) return;
        switcher.querySelector("[data-source-menu]")?.classList.add("open");
        switcher.querySelector("[data-source-trigger]")?.setAttribute("aria-expanded", "true");
      }
      function closeSourceMenu(switcher) {
        switcher?.querySelector("[data-source-menu]")?.classList.remove("open");
        switcher?.querySelector("[data-source-trigger]")?.setAttribute("aria-expanded", "false");
      }

      // ---------- FB1 source-menu 浮窗完整性：真实源名/连接态/摘要从 B4 桥同步到全部壳 ----------
      // （windowbar + 四条移动 sourcebar；静态壳里的「当前源 / —」占位到此退役）
      // W-UIFB ①：trigger 胶囊重做——内容只留源名+连接图标（摘要/⌄ 退役），图标四态
      function sourceDotClass(state) {
        return state === "online" ? "status-connected" : state === "connecting" ? "status-reconnecting" : "status-disconnected";
      }
      function sourceConnClass(state) {
        return state === "online" ? "conn-on" : state === "connecting" ? "conn-wait" : state === "unconfigured" ? "conn-idle" : "conn-fail";
      }
      // W-UIFB ①：源名展示口径——桌面壳 location.host 即本机 relay（tauri.localhost 等），展示「本机」；
      // W-WINPAIR-R7②：源改名表（原始 relay_name→用户命名，localStorage 持久）全链跟随——
      // 顶栏胶囊/源列表/会话卡源徽章/设置页云桥行都经此映射，新名即显
      const SOURCE_NAMES_KEY = "cc-deck-005-source-names";
      function sourceNameOverrides() {
        try { return JSON.parse(localStorage.getItem(SOURCE_NAMES_KEY) || "{}") || {}; } catch { return {}; }
      }
      function setSourceNameOverride(rawName, displayName) {
        const map = sourceNameOverrides();
        const k = String(rawName || "");
        if (!k) return;
        if (displayName && String(displayName).trim()) map[k] = String(displayName).trim().slice(0, 40);
        else delete map[k];
        try { localStorage.setItem(SOURCE_NAMES_KEY, JSON.stringify(map)); } catch {}
      }
      function sourceDisplayName(name) {
        const n = String(name || "");
        if (/^(tauri\.localhost|localhost|127\.0\.0\.1)(:|$)/.test(n)) return "本机";
        const overrides = sourceNameOverrides();
        return (Object.prototype.hasOwnProperty.call(overrides, n) && overrides[n]) || n;
      }
      // W-UIFB ①：连接图标（旧版 connChip 线条电脑图标同形移植）注入全部 trigger 壳
      const SOURCE_CONN_SVG = '<svg viewBox="0 0 16 13" width="13" height="11" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.2" y="1.5" width="13.6" height="9" rx="1.6"/><path d="M5.5 12.5h5" stroke-linecap="round"/></svg>';
      document.querySelectorAll("[data-source-conn]").forEach((el) => { el.innerHTML = SOURCE_CONN_SVG; });
      function refreshSourceSwitchers() {
        const bridge = window.__ccDeck005B4;
        const state = bridge ? bridge.connection : "connecting";
        const online = !!bridge && state === "online" && bridge.hasSnapshot;
        const v = viewSource();
        const cloudLinked = cloudUIOn(); // 云链已激活（决定云桥行是否注入）
        const cloudActive = v === "cloud"; // 视角（决定哪行 active；aggregate 时两行皆非）
        const pairedCloud = (typeof cloudSharedCloudServers === "function" ? cloudSharedCloudServers() : []).filter((s) => s && s.cloud && s.cloud.paired);
        // W-WINPAIR-R5 件六①：trigger 文本=视角源名（不等快照——云快照滞后时不再恒显「本机」）：
        // cloud→云源名（快照 relay_name 优先，未达显桥地址）；aggregate→「聚合 · 全部源」；local→本机
        let name;
        if (!bridge || state === "unconfigured") name = "＋ 添加服务器";
        else if (v === "aggregate") name = "聚合"; /* W-PILL4 ② 文案简化 */
        else if (v === "cloud") name = (cloudCtx.hasSnapshot && cloudCtx.relayName)
          ? sourceDisplayName(String(cloudCtx.relayName))
          : ((cloudCtx.cfg && cloudCtx.cfg.wsUrl) ? hostOf(cloudCtx.cfg.wsUrl) : "云桥");
        else name = sourceDisplayName(String(bridge.relayName || "relay"));
        const count = bridge && bridge.sessions ? bridge.sessions.size : 0;
        const summary = !bridge || state === "unconfigured" ? "点开菜单连接其他电脑" : online ? String(count) + " 会话" : state === "connecting" ? "连接中…" : "已断开 · 自动重连中"; /* W-PILL4 ③：去「· 在线」状态词 */
        document.querySelectorAll(".source-switcher").forEach((switcher) => {
          switcher.querySelectorAll("[data-source-dot]").forEach((el) => { el.className = "source-dot " + sourceDotClass(state); });
          switcher.querySelectorAll("[data-source-conn]").forEach((el) => { el.className = "source-conn " + sourceConnClass(state); });
          switcher.querySelectorAll("[data-current-source]").forEach((el) => { el.textContent = name; });
          // W-WINPAIR：云桥源行——云链激活或共享库有已配对云源时注入（与静态本机行并列，点击真切换）
          const menu = switcher.querySelector("[data-source-menu]");
          if (menu) {
            const localRow = menu.querySelector('.source-option[data-source-choice="local"]');
            let cloudRow = menu.querySelector('.source-option[data-source-choice="cloud"]');
            if (cloudLinked || pairedCloud.length) {
              if (!cloudRow && localRow) {
                cloudRow = document.createElement("button");
                cloudRow.className = "source-option";
                cloudRow.type = "button";
                cloudRow.dataset.sourceChoice = "cloud";
                cloudRow.innerHTML = '<span class="source-dot status-disconnected"></span><strong>云桥</strong><small>—</small>';
                localRow.after(cloudRow);
              }
            } else if (cloudRow) { cloudRow.remove(); cloudRow = null; }
            // W-WINPAIR-R3：聚合=源列表特殊行（与其他源平级平权；test.20 ②——两钮并排退役）。
            // 有第二源（云链激活或共享库有已配对云源）才注入——单源聚合无意义
            let aggRow = menu.querySelector('.source-option[data-source-choice="aggregate"]');
            if (cloudLinked || pairedCloud.length) {
              if (!aggRow && localRow) {
                aggRow = document.createElement("button");
                aggRow.className = "source-option";
                aggRow.type = "button";
                aggRow.dataset.sourceChoice = "aggregate";
                aggRow.innerHTML = '<span class="source-dot status-disconnected"></span><strong>聚合</strong>'; /* W-PILL4 ②③：文案简化+small 副行退役 */
                (cloudRow || localRow).after(aggRow);
              }
            } else if (aggRow) { aggRow.remove(); aggRow = null; }
            if (aggRow) {
              const bothOn = ctx.status === "online" && (cloudCtx.status === "online" || !cloudLinked);
              /* W-PILL4 ③：small 三态副行退役（计数/「全部源合并展示」/等待提示全去）——只留状态灯 */
              aggRow.querySelector(".source-dot")?.setAttribute("class", "source-dot " + sourceDotClass(bothOn ? "online" : "connecting"));
              aggRow.classList.toggle("active", v === "aggregate");
            }
            if (cloudRow) {
              const cs = cloudCtx.status;
              // 在线显 relay 名（与顶栏 trigger 同源一致，走改名映射）；未连接显地址（激活前 cloudCtx.cfg 还没填则回落共享库）
              const cloudAddr = (cloudCtx.cfg && cloudCtx.cfg.wsUrl) || (pairedCloud[0] && pairedCloud[0].wsUrl) || "";
              const cloudLabel = (cs === "online" && cloudCtx.relayName && !/^(tauri\.localhost|localhost|127\.0\.0\.1)(:|$)/.test(String(cloudCtx.relayName))) ? sourceDisplayName(String(cloudCtx.relayName)) : (cloudAddr ? hostOf(cloudAddr) : "云桥");
              cloudRow.querySelector("strong").textContent = cloudLabel;
              // W-WINPAIR-R7②：在线云源行尾 ✎ 改名钮（hover 显现）
              let renameBtn = cloudRow.querySelector("[data-source-rename]");
              if (cs === "online" && cloudCtx.relayName && !renameBtn) {
                renameBtn = document.createElement("button");
                renameBtn.className = "source-rename";
                renameBtn.type = "button";
                renameBtn.title = "重命名此源";
                renameBtn.setAttribute("aria-label", "重命名此源");
                renameBtn.dataset.sourceRename = "";
                renameBtn.dataset.relayName = String(cloudCtx.relayName);
                renameBtn.textContent = "✎";
                cloudRow.appendChild(renameBtn);
              } else if (renameBtn && cs !== "online") { renameBtn.remove(); }
              else if (renameBtn) { renameBtn.dataset.relayName = String(cloudCtx.relayName); }
              cloudRow.querySelector("small").textContent = cs === "connecting" ? "连接中…" : cloudCtx.failKind === "unpaired" ? "未配对 · 输码" : (cloudAddr ? hostOf(cloudAddr) : "云桥"); /* W-PILL4 ③：去在线/离线文字（状态由连接灯承载） */
              cloudRow.querySelector(".source-dot")?.setAttribute("class", "source-dot " + sourceDotClass(cs === "online" ? "online" : cs === "connecting" ? "connecting" : "offline"));
              cloudRow.classList.toggle("active", cloudActive);
            }
            if (localRow) {
              // W-WINPAIR-R2：并行保活——本机行连接点显本机链自身状态（不再因视角切走显离线）
              localRow.classList.toggle("active", v === "local");
              localRow.querySelector("strong").textContent = "本机";
              localRow.querySelector("small").textContent = cloudActive ? "点击切回本机" : v === "aggregate" ? "聚合展示中 · 点击回单源" : summary;
              localRow.querySelector(".source-dot")?.setAttribute("class", "source-dot " + sourceDotClass(cloudLinked && cloudActive ? (ctx.status === "online" ? "online" : "offline") : state));
            }
          }
          switcher.querySelectorAll(".source-option[data-source-choice]").forEach((option) => {
            const choice = option.dataset.sourceChoice;
            if (choice === "cloud" || choice === "local" || choice === "aggregate") return; // 本机/云桥/聚合三行已分别渲染（W-WINPAIR-R3：聚合行不再被兜底循环覆盖文案）
            const strong = option.querySelector("strong");
            const small = option.querySelector("small");
            if (strong) strong.textContent = name;
            if (small) small.textContent = summary;
            option.querySelector(".source-dot")?.setAttribute("class", "source-dot " + sourceDotClass(state));
          });
        });
      }
      // FB1：源显示模式持久化——载入恢复 body 态 + 五壳按钮归位（此前仅点击壳内生效、刷新即丢）
      function initSourceModeState() {
        let saved = null;
        try { saved = localStorage.getItem("cc-deck-005-source-mode"); } catch (_) {}
        const mode = saved === "aggregate" ? "aggregate" : "single";
        document.body.dataset.sourceMode = mode;
        document.querySelectorAll(".source-switcher [data-source-mode]").forEach((el) => el.classList.toggle("active", el.dataset.sourceMode === mode));
      }

      // ---------- #158-批4a 外链兜底收口（改动 3）：全文件外链点击统一走此 helper ----------
      // 桌面→ccDeck.openExternal（失败 catch 降级复制）；浏览器→window.open 探路，被拦（返回 null）
      // 再合成 a[target=_blank noopener noreferrer] 点击并复制链接兜底——弹窗拦截器吞掉时用户至少
      // 拿到「链接已复制」反馈。幂等挂 window，消费点（B4 验收单/地基更新与诊断/mobile 下载）点击期解析。
      if (!window.__ccDeck005OpenUrl) {
        const sharedToast = (msg) => { const t = document.getElementById("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(sharedToast._t); sharedToast._t = setTimeout(() => t.classList.remove("show"), 2600); };
        const copyLink = async (url) => {
          try { await navigator.clipboard.writeText(url); sharedToast("链接已复制 · 可粘贴到浏览器打开"); return true; }
          catch (_) { sharedToast("打开被拦截 · 链接：" + url); return false; }
        };
        window.__ccDeck005OpenUrl = async function openExternalUrl(url) {
          const u = String(url || "");
          if (!/^https?:\/\//i.test(u)) { sharedToast("无效链接"); return false; }
          if (window.ccDeck && typeof window.ccDeck.openExternal === "function") {
            try { await window.ccDeck.openExternal(u); return true; }
            catch (_) { return copyLink(u); }
          }
          let opened = null;
          try { opened = window.open(u, "_blank", "noopener,noreferrer"); } catch (_) { opened = null; }
          if (opened) { try { opened.opener = null; } catch (_) {} return true; }
          // window.open 被拦：合成 a 点击（沙箱禁 window.open 但放行锚点导航的场景）+ 复制兜底
          const a = document.createElement("a");
          a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer";
          document.body.appendChild(a);
          try { a.click(); } catch (_) {}
          a.remove();
          return copyLink(u);
        };
      }

      function setupStubTabs() {
        document.querySelectorAll(".segment-bar, .mobile-detail-tabs, .mobile-team-tabs").forEach((bar) => {
          if (bar.closest(".settings-panel") || bar.closest("#d-settings")) return; // ⑥c-1：设置域已由 setupSettingsDomain 重建六面板，不让位 stub。件十四（2026-10-10）：原排除只查 .settings-panel——设置域 head 的「连接/设备/配对记录」segment-bar 在 workspace-head 不在 panel 内，漏网被 stub 包摄：六面板被裹进 originalPane + 建「×× · 此面板即将开放」占位 pane 与真面板争 body（切连接卡子 tab 再切设置卡 → 别卡第三列显示「即将开放」占位，用户实测复现）；排除补 #d-settings 根修
          const buttons = [...bar.querySelectorAll("button")];
          const host = bar.closest(".workspace, .mobile-screen");
          const body = host?.querySelector(".workspace-body, .mobile-content");
          if (!body || !buttons.length) return;
          const initialIndex = Math.max(0, buttons.findIndex((button) => button.classList.contains("active")));
          const originalPane = document.createElement("div");
          originalPane.className = "workspace-pane";
          originalPane.append(...body.childNodes);
          const panes = buttons.map((button, index) => {
            if (index === initialIndex) return originalPane;
            const pane = document.createElement("div");
            pane.className = "workspace-pane";
            pane.dataset.stub = host.closest("[data-stub]")?.dataset.stub || "B7";
            const placeholder = document.createElement("div");
            placeholder.className = "readonly-banner";
            placeholder.textContent = button.textContent.trim() + " · 此面板即将开放";
            pane.append(placeholder);
            return pane;
          });
          body.replaceChildren(...panes);
          wireSegmentTabs(buttons, panes, initialIndex);
        });
      }

      // ---------- ⑥c-1 设置域 B6：六面板装配（原型 setupSettingsContent 同构）+ 真数据经 B4 桥 ----------
      const SETTINGS_PANELS = ["general", "provider", "connections", "identity", "extensions", "about"];
      const SETTINGS_TITLES = ["通用", "Agent 引擎", "连接与设备", "团队身份模板", "扩展", "关于"];
      const SETTINGS_SUBS = {
        connections: "relay · 云桥 · 已配设备 · 异常项单独处理",
        provider: "六引擎接入 · 状态取自 relay 引擎目录",
        general: "通知 · 显示 · 密度与字号",
        shortcuts: "页面快捷键 · 全局呼出键",
        identity: "角色缺省引擎 · 开团时可逐成员覆盖",
        extensions: "验收 · 登记 · 产物",
        about: "版本 · 检查更新 · 手机 App",
      };
      // FB9：设置开关键统一账——slug 映射（W-NOVAUI ④：project-rail 键随开关退役删除，
      // rail 项目入口恒显不再可配置）
      const SETTINGS_TOGGLE_KEYS = { sound: "notify-sound", notify: "desktop-notify" };
      function settingsToggleState(key) {
        const slug = SETTINGS_TOGGLE_KEYS[key] || key;
        try { const v = localStorage.getItem("cc-deck-005-" + slug); return v === null ? true : v !== "0"; } catch (_) { return true; }
      }
      // FB9 通知反馈：短滴声（WebAudio 合成，零外部资源）+ 桌面通知（权限授予才弹，静音防与 OS 双响）
      let dingCtx = null;
      function playNotifyDing() {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          dingCtx = dingCtx || new AC();
          if (dingCtx.state === "suspended") void dingCtx.resume();
          const t0 = dingCtx.currentTime;
          const gain = dingCtx.createGain();
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
          gain.connect(dingCtx.destination);
          [880, 1174.66].forEach((freq, i) => {
            const osc = dingCtx.createOscillator();
            osc.type = "sine";
            osc.frequency.value = freq;
            osc.start(t0 + i * 0.12);
            osc.stop(t0 + 0.5);
            osc.connect(gain);
          });
        } catch (_) {}
      }
      async function ensureNotifyPermission() {
        if (!("Notification" in window)) { showToast("此环境不支持桌面通知"); return; }
        if (Notification.permission === "default") { try { await Notification.requestPermission(); } catch (_) {} }
        if (Notification.permission !== "granted") showToast("桌面通知权限未授予 · 可在浏览器站点权限里开启");
      }
      function desktopNotifyText(title, body) {
        if (!settingsToggleState("notify")) return;
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        try { new Notification(String(title || "CC Deck"), { body: String(body || "").slice(0, 120), silent: true, tag: "cc-deck-notify" }); } catch (_) {}
      }
      window.__ccDeck005NotifyFx = { ding: playNotifyDing, desktop: desktopNotifyText, soundOn: () => settingsToggleState("sound") };
      // FB10 界面字号：四档（小/标准/大/特大），body 属性 + CSS --ui-scale 落位（W-UIFIX C：
      // 纯排版缩放，zoom 整体缩放退役），localStorage 记忆
      function applyUiScale(scale, announce = false) {
        const v = ["90", "100", "110", "125"].includes(scale) ? scale : "100";
        document.body.dataset.uiScale = v;
        try { localStorage.setItem("cc-deck-005-ui-scale", v); } catch (_) {}
        document.querySelectorAll("[data-ui-scale-option]").forEach((button) => {
          button.classList.toggle("active", button.dataset.uiScaleOption === v);
          button.setAttribute("aria-pressed", String(button.dataset.uiScaleOption === v));
        });
        if (announce) showToast("界面字号：" + ({ "90": "小", "100": "标准", "110": "大", "125": "特大" })[v] + (v === "100" ? "" : " · 全界面等比缩放"));
      }
      // #158-批3 呼出/收起快捷键文案（改绑录制 UI 留 test.5）：桌面壳侧 setup 已注册默认
      // Alt+D（main.rs DEFAULT_TOGGLE_KEY）；localStorage ccd_toggle_key 记忆旧壳改绑值
      //（""=已注销）。浏览器无壳不注册——维持「未设置」不撒谎
      function toggleHotkeyDisplay() {
        if (!(window.__TAURI__ || window.ccDeck)) return "未设置";
        let saved = null;
        try { saved = localStorage.getItem("ccd_toggle_key"); } catch (_) { saved = null; }
        const combo = saved === null ? "alt+d" : saved;
        if (!combo) return "未设置";
        return combo.split("+").map((part) => part === "space" ? "Space" : part.charAt(0).toUpperCase() + part.slice(1)).join("+");
      }
      // ---------- #158-批3 检查更新真实现（旧壳 8597-8655 范式） ----------
      // 浏览器形态（无 __TAURI__.updater）返回 null——网页端确实随 relay 部署更新，假文案
      // 对该形态是正确的。Mac / snap / dev 通道门控（UPDATER_BLOCKED）：tauri-latest 清单
      // 无 mac 条目，check 判有更新而下载必炸；test 包 endpoint 构建期烙 test 清单可在线升
      const UPDATER_BLOCKED = /Mac/i.test(navigator.platform || navigator.userAgent)
        || /-(snap|dev)\./i.test(CONSOLE_VERSION);
      // UIPOLISH2 件七（2026-10-11 用户拍板）：检查与安装拆链——check 只查不装（原实现 available 即
      // downloadAndInstall 静默装，自动覆盖用户安装位；test.15 被降级覆盖事故同族风险）；安装收口
      // shellInstallUpdate，只被提醒对话框「立即更新」触发。pendingUpdateObj 是 tauri update 对象
      // （不可序列化），进程内缓存由 install 消费
      let pendingUpdateObj = null;
      async function shellCheckUpdate() {
        const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("网络超时")), ms))]);
        if (!(window.__TAURI__ && window.__TAURI__.updater)) return null; // 浏览器：无更新通道（随 relay 部署更新），先于门控判定
        if (UPDATER_BLOCKED) return { blocked: true };
        const u = await withTimeout(window.__TAURI__.updater.check(), 10000); // #385 网络黑洞：check 无内置超时，外层 race 兜底
        if (u && u.available) {
          pendingUpdateObj = u;
          return { available: true, version: u.version, current: u.currentVersion, notes: typeof u.body === "string" ? u.body : "" };
        }
        return { available: false, version: u && u.currentVersion };
      }
      async function shellInstallUpdate() { // 件七：仅对话框「立即更新」/导出对象消费；120s 超时沿用原口径
        const u = pendingUpdateObj;
        if (!u) return { ok: false, error: "没有待安装的更新" };
        const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("网络超时")), ms))]);
        try { await withTimeout(u.downloadAndInstall(), 120000); return { ok: true }; }
        catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
      }
      window.__ccDeck005Updater = { check: shellCheckUpdate, install: shellInstallUpdate, blocked: () => UPDATER_BLOCKED }; // 手机 IIFE 复用同一链（openDialog/ignoredVersion 在下方挂载）
      // ---------- 件七：更新提醒对话框（版本号 + notes + 立即更新/忽略此版本） ----------
      const UPDATE_IGNORE_KEY = "cc-deck-update-ignored";
      function updateIgnoredVersion() { try { return localStorage.getItem(UPDATE_IGNORE_KEY) || ""; } catch (_) { return ""; } }
      function openUpdateDialog(info) {
        document.getElementById("update-confirm-backdrop")?.remove();
        const bd = document.createElement("div");
        bd.id = "update-confirm-backdrop";
        bd.className = "update-dialog-backdrop";
        const notes = String(info.notes || "").trim();
        bd.innerHTML = '<div class="update-dialog" role="alertdialog" aria-label="发现新版本">'
          + '<h3>发现新版本 <span class="upd-ver">v' + escapeHtml(String(info.version || "")) + "</span></h3>"
          + '<div class="upd-cur">当前 v' + escapeHtml(String(info.current || CONSOLE_VERSION)) + " · 更新将在重启后生效</div>"
          + (notes ? '<div class="upd-notes">' + escapeHtml(notes) + "</div>" : "")
          + '<div class="upd-actions"><button type="button" class="secondary-btn" data-upd-ignore>忽略此版本</button><button type="button" class="primary-btn" data-upd-install>立即更新</button></div>';
        const closeBd = () => { bd.remove(); document.removeEventListener("keydown", onKey, true); };
        const onKey = (e) => { if (e.key === "Escape") closeBd(); };
        document.addEventListener("keydown", onKey, true);
        bd.addEventListener("click", async (ev) => {
          if (ev.target === bd) { closeBd(); return; } // 点背景=本次不更新（不记忽略）
          if (ev.target.closest("[data-upd-ignore]")) {
            try { localStorage.setItem(UPDATE_IGNORE_KEY, String(info.version || "")); } catch (_) {}
            closeBd();
            showToast("已忽略 v" + String(info.version || "") + " · 更新的版本号会再次提醒");
            const status = document.querySelector('[data-settings-panel="about"] [data-update-status]');
            if (status) status.textContent = "已忽略 v" + String(info.version || "") + "（手动检查仍可见）";
            return;
          }
          if (!ev.target.closest("[data-upd-install]")) return;
          const btn = bd.querySelector("[data-upd-install]");
          btn.disabled = true; btn.textContent = "下载安装中…";
          const r = await window.__ccDeck005Updater.install(); // 走导出对象便于测试桩替换
          if (r.ok) {
            bd.querySelector(".upd-actions").innerHTML = '<button type="button" class="primary-btn" data-upd-relaunch>重启应用</button>';
            const status = document.querySelector('[data-settings-panel="about"] [data-update-status]');
            if (status) status.textContent = "新版已下载 · 重启后生效";
            showToast("新版本已就绪，重启 CC Deck 后生效");
            bd.querySelector("[data-upd-relaunch]").addEventListener("click", () => {
              // 壳层暂无 process 插件（relaunch 需 L3 加 capability——回执备案另开小批）；Windows NSIS
              // 被动安装完成会自行拉起新版，此处 close 兜底 + 文案引导
              try { const t = window.__TAURI__; if (t && t.process && t.process.relaunch) { t.process.relaunch(); return; } } catch (_) {}
              try { window.close(); } catch (_) {}
              showToast("若窗口未自动重开，请手动重启 CC Deck", 5000);
            });
          } else {
            btn.disabled = false; btn.textContent = "立即更新";
            showToast("更新失败：" + r.error);
          }
        });
        document.body.appendChild(bd);
      }
      window.__ccDeck005Updater.openDialog = openUpdateDialog; // 桌面启动链/手动检查/手机域共用（headless 断言同入口）
      window.__ccDeck005Updater.ignoredVersion = updateIgnoredVersion;
      // 手动检查（设置页关于面板）：状态行驱动 + 超时给手动下载入口（exe 更新 endpoint 在
      // GitHub，国内/公司网常连不上）；浏览器形态保持原 toast 文案不动
      async function manualCheckUpdate() {
        const status = document.querySelector('[data-settings-panel="about"] [data-update-status]');
        const btn = document.querySelector('[data-settings-panel="about"] [data-update-check]');
        if (status) status.textContent = "检查中…";
        if (btn) btn.disabled = true;
        try {
          const r = await shellCheckUpdate();
          if (r && r.blocked) {
            if (status) status.textContent = "此版本请手动更新（Mac / 快照与开发通道不走在线升级）";
            showToast("此版本请手动更新（Mac / 快照与开发通道不走在线升级）", 5000);
          } else if (r === null) {
            if (status) status.textContent = "当前已是最新版本";
            showToast("当前已是最新版本 · 网页端随 relay 部署更新");
          } else if (r.available) {
            // UIPOLISH2 件七：手动检查同样弹提醒对话框（不再自动下载安装）；状态行提示发现新版
            if (status) status.textContent = "发现新版 → v" + r.version;
            openUpdateDialog(r);
          } else {
            if (status) status.textContent = "已是最新 v" + (r.version || "");
          }
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          if (status) status.textContent = "检查更新失败";
          if (/超时|timeout|network|fetch/i.test(msg)) {
            showToast("检查超时（网络受限），可手动下载新版本", 6000);
            void window.__ccDeck005OpenUrl("https://cc.humumu.online/dl/"); // #158-批4a：外链统一兜底链（被拦降级复制+toast）
          } else {
            showToast("检查更新失败：" + msg);
          }
        } finally {
          if (btn) btn.disabled = false;
        }
      }
      // ---------- W-MIG 设置导出/导入（设置迁移手动通道：换壳/换 identifier 分仓/换机）----------
      // 壳的影子备份（desktop-storage-shadow.json）只覆盖本机同 deck_root 的迁移；
      // 导出文件跨机可用。导出 = 全量 localStorage dump；壳形态走 saveArtifact 落
      // 「下载」目录（b64 通道，与产物下载同链），浏览器形态 Blob + a.download
      function exportSettings() {
        const o = {};
        try {
          for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
        } catch (e) { showToast("导出失败：localStorage 不可读"); return; }
        const json = JSON.stringify(o, null, 2);
        const name = "cc-deck-settings-" + new Date().toISOString().slice(0, 10) + ".json";
        if (window.ccDeck && typeof window.ccDeck.saveArtifact === "function") {
          try {
            const u8 = new TextEncoder().encode(json);
            let s = "";
            for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
            window.ccDeck.saveArtifact(name, btoa(s))
              .then((p) => showToast("已导出到 " + p))
              .catch((e) => showToast("导出失败：" + (e && e.message ? e.message : e)));
          } catch (e) { showToast("导出失败：" + e); }
        } else {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
          a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          showToast("已导出 " + name);
        }
      }
      // 导入 = 覆盖式恢复（导出文件即全量 dump）：清空 → 逐键写回 → 刷新生效；
      // 两段确认（导入钮武装 3s）防误触——覆盖现行设置不可逆
      function importSettingsFile(file) {
        file.text().then((txt) => {
          let obj;
          try { obj = JSON.parse(txt); } catch (e) { showToast("导入失败：文件不是合法 JSON"); return; }
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) { showToast("导入失败：内容须为设置导出的 JSON 对象"); return; }
          try {
            localStorage.clear();
            for (const k in obj) { try { localStorage.setItem(k, String(obj[k])); } catch (_) {} }
          } catch (e) { showToast("导入失败：" + e); return; }
          showToast("设置已导入 · 正在刷新…");
          setTimeout(() => { try { location.reload(); } catch (_) {} }, 600);
        }).catch(() => showToast("导入失败：文件读取失败"));
      }
      // ---------- #158-批3 连接诊断（桌面形态，旧壳 relayStatus 11917-11959 消费范式） ----------
      // relayStatus 透出 { port:端口在听, embedded, node, err }——err（Node 过旧/spawn 失败）
      // 优先直出；缺 node 给安装引导（点击 openExternal nodejs.org）；端口在听显示运行端口。
      // fetch 带 6s 陈旧窗（帧事件高频重渲不刷屏 invoke）；结果只进小字行不动主行
      let relayDiag = null, relayDiagAt = 0, relayDiagBusy = false;
      // #206：一键安装点击+进度事件（一次性文档级委托——按钮在诊断行内动态渲染）
      if (!window.__ccDeckNodeInstallWired) {
        window.__ccDeckNodeInstallWired = true;
        document.addEventListener("click", (ev) => {
          const btn = ev.target.closest("[data-node-install]");
          if (!btn || btn.disabled) return;
          const status = document.querySelector("[data-node-install-status]");
          const setSt = (t) => { if (status) status.textContent = t; };
          btn.disabled = true; btn.textContent = "安装中…";
          setSt("开始下载…");
          if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
            window.__TAURI__.core.invoke("node_install").catch((e) => { setSt("启动安装失败：" + e); btn.disabled = false; btn.textContent = "重试"; });
          } else { setSt("仅桌面 App 内可用——浏览器形态请用 nodejs.org 手动安装"); btn.disabled = false; btn.textContent = "一键安装"; }
        });
        if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
          window.__TAURI__.event.listen("node-install-progress", (ev) => {
            const p = ev && ev.payload || {};
            const status = document.querySelector("[data-node-install-status]");
            const btn = document.querySelector("[data-node-install]");
            if (status) status.textContent = String(p.detail || p.stage || "");
            if (btn && p.stage === "error") { btn.disabled = false; btn.textContent = "重试"; }
            if (btn && p.stage === "done") btn.textContent = "已安装";
          });
        }
      }
      function paintRelayDiagRow(host) {
        const d = relayDiag;
        if (!d) { if (host) host.textContent = ""; return; }
        if (d.err) {
          host.textContent = String(d.err).slice(0, 64) + " · 点击查看安装方法";
          host.title = String(d.err);
          host.dataset.diag = "err";
        } else if (d.node === false) {
          // #206（W-NODE 定稿）：一键安装框——应用内下载 Node 官方包到 CC Deck 数据目录
          //（不碰系统）+nodejs.org 手动备选；进度事件驱动；装完 relay 自动拉起无需重启
          host.dataset.diag = "node";
          host.innerHTML = '<span>缺少 Node.js 运行时</span>'
            + '<button class="secondary-btn" data-node-install type="button" style="margin:0 8px;padding:2px 10px">一键安装</button>'
            + '<a href="https://nodejs.org" target="_blank" rel="noreferrer" style="font-size:11px;color:var(--brand)">或到 nodejs.org 下载 LTS（装完重启 CC Deck）</a>'
            + '<span data-node-install-status style="display:block;font-size:11px;color:var(--dim);margin-top:2px"></span>';
        } else if (d.port) {
          host.textContent = "内置服务运行中 · 端口 " + ((localRelayInfo && localRelayInfo.port) || relayPortOfCfg());
          host.title = "";
          host.dataset.diag = "ok";
        } else {
          host.textContent = "未检测到本机 relay 服务";
          host.title = "";
          host.dataset.diag = "none";
        }
      }
      function paintRelayDiag() { document.querySelectorAll("[data-relay-diag]").forEach((el) => paintRelayDiagRow(el)); }
      async function refreshRelayDiag() {
        paintRelayDiag();
        if (relayDiagBusy) return;
        if (relayDiag && Date.now() - relayDiagAt < 6000) return;
        if (!(window.ccDeck && typeof window.ccDeck.relayStatus === "function")) return;
        relayDiagBusy = true;
        try {
          const st = await window.ccDeck.relayStatus();
          relayDiag = st && typeof st === "object" ? { port: st.port === true, node: st.node, err: typeof st.err === "string" ? st.err : "" } : null;
          relayDiagAt = Date.now();
        } catch (_) { /* 保留上次结果 */ }
        finally { relayDiagBusy = false; }
        paintRelayDiag();
      }
      function relayPortOfCfg() {
        try { return String(ctx.cfg.wsUrl || "").match(/:(\d+)\//)?.[1] || (location.port || "8787"); } catch (_) { return location.port || "8787"; }
      }
      // 自测/排障钩子：绕过 6s 陈旧窗强刷诊断行（正常运行不消费）
      window.__ccDeck005RelayDiag = { refresh: refreshRelayDiag, stale: () => { relayDiagAt = 0; } };
      function setupSettingsDomain() {
        const section = document.querySelector("#d-settings");
        const queue = section?.querySelector(".queue");
        const body = section?.querySelector(".workspace-body");
        if (!section || !queue || !body || body.dataset.settingsReady) return;
        queue.classList.add("settings-nav");
        // ===== W-BLANKSET2 诊断钩子·逐段包裹（test.33；摘除=去 safe() 包裹还原直呼）=====
        const segErrors = [];
        const safe = (name, fn) => {
          try { fn(); } catch (e) { segErrors.push(name + "：" + ((e && e.message) || e)); if (window.__blankset2Paint) window.__blankset2Paint(); }
        };
        const segBanner = () => segErrors.length
          ? '<div data-blankset2-seg style="background:#3B0A0A;color:#FF9B9B;font:11px/1.5 Consolas,Menlo,monospace;padding:6px 10px;white-space:pre-wrap;border-bottom:2px solid #FF6B6B">⚠ 设置初始化分段错误：\n' + segErrors.map((s) => "· " + s).join("\n") + "</div>"
          : "";

        const pairBanner = '<div class="v8-escape">设备身份 = 配对密钥（E2E）。踢出后需重新配对；手机端仅浏览、验证和换路由。</div>'; /* W-SETTINGS3 批2：组尾注释降回灰字内联（视觉清单：全宽橙描边提示框非 V3 语言） */
        safe("六面板静态段", () => {
        body.innerHTML = `
<div class="settings-panel workspace-pane" data-settings-panel="general"><div class="v8-sethead"><div class="t">通用</div><div class="s">外观 · 快捷键 · 通知——基座偏好（连接状态见连接与设备页）</div></div><div class="v8-setcard"><h5>外观</h5><div class="v8-swrow"><div class="v8-swtxt">界面字号<div class="v8-swd">只改文字大小，布局不变 · 立即生效</div></div><div class="density-control" role="group" aria-label="界面字号"><button type="button" data-ui-scale-option="90">小</button><button type="button" data-ui-scale-option="100">标准</button><button type="button" data-ui-scale-option="110">大</button><button type="button" data-ui-scale-option="125">特大</button></div></div><div class="v8-swrow"><div class="v8-swtxt">卡片密度<div class="v8-swd">会话卡片信息密度 · 紧凑=一屏多看两条</div></div><div class="density-control" role="group" aria-label="卡片密度"><button type="button" data-card-density-option="compact">紧凑</button><button type="button" data-card-density-option="standard">标准</button><button type="button" data-card-density-option="relaxed">宽松</button></div></div><div class="v8-swrow"><div class="v8-swtxt">设置密度<div class="v8-swd">本设置页行距与留白 · 舒适=呼吸感，紧凑=一屏多看几行</div></div><div class="density-control" role="group" aria-label="设置密度"><button type="button" data-settings-density-option="compact">紧凑</button><button type="button" data-settings-density-option="comfortable">舒适</button></div></div></div><div class="v8-setcard"><h5>快捷键</h5><div class="v8-swrow"><div class="v8-swtxt">全局搜索<span class="kbd-inline-chip">${escapeHtml(keyDisplay("search"))}</span><div class="v8-swd">跨会话 / 团队 / 任务的模糊搜索 · 点右侧自定义</div></div><button class="kbd-chip" type="button" data-keymap-chip="search" title="点击修改快捷键">修改</button></div><div class="v8-swrow"><div class="v8-swtxt">新建会话<span class="kbd-inline-chip">${escapeHtml(keyDisplay("new"))}</span><div class="v8-swd">普通会话 · 点右侧自定义</div></div><button class="kbd-chip" type="button" data-keymap-chip="new" title="点击修改快捷键">修改</button></div><div class="v8-swrow"><div class="v8-swtxt">呼出 / 收起面板<span class="kbd-inline-chip">${escapeHtml(toggleHotkeyDisplay())}</span><div class="v8-swd">全局快捷键 · 最小化时唤回窗口</div></div><button class="kbd-chip" type="button" data-keymap-chip="toggle" title="${window.ccDeck || window.__TAURI__ ? "点击修改全局快捷键" : "浏览器形态不支持全局快捷键"}">修改</button></div><div class="v8-swrow"><div class="v8-swtxt">切换会话<span class="kbd-inline-chip">${escapeHtml(kbmodDisplay("↑↓"))}</span><div class="v8-swd">会话列表内上下移动</div></div><button class="kbd-chip" type="button" data-kbmod-chip="session" title="点击切换 Alt/Ctrl 修饰键">修改</button></div><div class="v8-swrow"><div class="v8-swtxt">切换数据源<span class="kbd-inline-chip">${escapeHtml(kbmodDisplay("←→"))}</span><div class="v8-swd">多源间快速切换</div></div><button class="kbd-chip" type="button" data-kbmod-chip="source" title="点击切换 Alt/Ctrl 修饰键">修改</button></div><div class="v8-swrow"><div class="v8-swtxt">恢复默认键位<div class="v8-swd">清除全部自定义，回到出厂键位</div></div><button class="secondary-btn" type="button" data-keymap-reset>重置</button></div></div><div class="v8-setcard"><h5>通知</h5><div class="v8-swrow"><div class="v8-swtxt">通知声音<div class="v8-swd">行动项到达时提示</div></div><button class="toggle-switch${settingsToggleState("sound") ? " active" : ""}" data-settings-toggle="sound" type="button" aria-pressed="${settingsToggleState("sound")}" title="切换通知声音"></button></div><div class="v8-swrow"><div class="v8-swtxt">桌面通知<div class="v8-swd">后台 relay 有新行动时提示</div></div><button class="toggle-switch${settingsToggleState("notify") ? " active" : ""}" data-settings-toggle="notify" type="button" aria-pressed="${settingsToggleState("notify")}" title="切换桌面通知"></button></div></div><div class="v8-setcard"><h5>高级</h5><div class="v8-swrow"><div class="v8-swtxt">空闲置灰<div class="v8-swd">完成/出错会话静默超时后退后显示</div></div><label class="idle-dim-field"><input type="number" step="1" data-idle-dim-input aria-label="空闲置灰分钟数" /><span>分钟（负数=永不）</span></label></div><div class="v8-swrow fs-debug-row-wrap"><div class="fs-debug-body"><strong>字号调试</strong><p class="fs-debug-note">临时调试 · 调完截图给 PM 固化（不进正式配置）</p><div class="fs-debug-grid"><label class="fs-debug-item"><span>消息内容</span><input type="range" min="10" max="22" step="1" data-fs-slider="msg" aria-label="消息内容字号（px）" /><b data-fs-val="msg"></b><button type="button" class="fs-dbg-reset" data-fs-reset-one="msg" title="重置本项" aria-label="重置消息内容字号">↺</button></label><label class="fs-debug-item"><span>卡片标题</span><input type="range" min="10" max="22" step="1" data-fs-slider="title" aria-label="卡片标题字号（px）" /><b data-fs-val="title"></b><button type="button" class="fs-dbg-reset" data-fs-reset-one="title" title="重置本项" aria-label="重置卡片标题字号">↺</button></label><label class="fs-debug-item"><span>卡片描述</span><input type="range" min="10" max="22" step="1" data-fs-slider="desc" aria-label="卡片描述字号（px）" /><b data-fs-val="desc"></b><button type="button" class="fs-dbg-reset" data-fs-reset-one="desc" title="重置本项" aria-label="重置卡片描述字号">↺</button></label><label class="fs-debug-item"><span>界面 UI</span><input type="range" min="10" max="22" step="1" data-fs-slider="ui" aria-label="界面 UI 字号（px）" /><b data-fs-val="ui"></b><button type="button" class="fs-dbg-reset" data-fs-reset-one="ui" title="重置本项" aria-label="重置界面 UI 字号">↺</button></label><label class="fs-debug-item"><span>等宽代码</span><input type="range" min="10" max="22" step="1" data-fs-slider="mono" aria-label="等宽代码字号（px）" /><b data-fs-val="mono"></b><button type="button" class="fs-dbg-reset" data-fs-reset-one="mono" title="重置本项" aria-label="重置等宽代码字号">↺</button></label></div><button type="button" class="secondary-btn fs-dbg-reset-all" data-fs-reset-all>全部重置</button></div></div></div></div>
<div class="settings-panel workspace-pane" data-settings-panel="provider"><div class="v8-sethead"><div class="t">Agent 引擎</div><div class="s">引擎目录 · 登录态与模型——凭证只存引擎本机</div></div><div class="v8-setcard"><h5>已接入引擎</h5><div class="settings-list" data-settings-live="provider"></div></div><button class="primary-btn" data-settings-add-provider type="button">＋ 添加 provider</button></div>
<div class="settings-panel workspace-pane active" data-settings-panel="connections"><div class="v8-sethead"><div class="t">连接与设备</div><div class="s">relay · 远程源 · 本页设备——连接管理面</div></div><div class="v8-setcard"><h5>relay</h5><div class="settings-list" data-settings-live="connections"></div></div><div class="v8-setcard"><h5>已配设备</h5><div class="settings-list" data-settings-live="devices"></div><div class="v8-escape">设备身份 = 配对密钥（E2E）· 踢出后需重新配对；凭证与配对历史存于 relay 本机</div></div>${pairBanner}<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end"><button class="primary-btn" data-settings-pair type="button">＋ 配对新设备</button></div></div>
<div class="settings-panel workspace-pane" data-settings-panel="identity"><div class="v8-sethead"><div class="t">团队身份模板</div><div class="s">模型路由 · 系统提示 · 工具白名单都长在模板上——开团的初始编制</div></div><div class="v8-setcard"><h5>预置角色</h5><div class="settings-list" data-settings-live="identity"></div></div><div class="v8-escape">开团时可逐成员覆盖 · 模板只给初始值，不当牢笼。</div></div>
<div class="settings-panel workspace-pane" data-settings-panel="extensions"><div class="v8-sethead"><div class="t">扩展</div><div class="s">控制面能力扩展——内建三件随软件发行、免安装确认 · 统一鉴权无特权通道</div></div><div class="v8-setcard"><h5>内建扩展 · 随软件发行</h5><div class="v8-swrow"><span class="v8-swico ext-ico">✓</span><div class="v8-swtxt">acceptance · 验收体系<span class="kbd-inline-chip">内建</span><div class="v8-swd">出单 · 回填 · 收单闭环 · 验收单分发与提醒</div></div><span class="tag done">已启用</span></div><div class="v8-swrow"><span class="v8-swico ext-ico">↗</span><div class="v8-swtxt">deliver · 输出物登记<span class="kbd-inline-chip">内建</span><div class="v8-swd">意图声明制登记 · 输出物看板数据源</div></div><span class="tag done">已启用</span></div><div class="v8-swrow"><span class="v8-swico ext-ico">▧</span><div class="v8-swtxt">artifacts · 产物看板<span class="kbd-inline-chip">内建</span><div class="v8-swd">登记查询 · 产物打开与分享</div></div><span class="tag done">已启用</span></div><div class="v8-escape">内建不可卸载、可停用——停用即对应能力面下线；M1 骨架期三件恒启用，停用开关随注册表就绪后生效。</div></div><div class="v8-setcard"><h5>权限声明（只读）· 授权以命令面权限表为准</h5><div class="v8-swrow"><div class="v8-swtxt">acceptance<div class="v8-swd">读任务板 · 写验收单（出单 · 回填 · 收单）· 发重要提醒</div></div><span class="kbd-inline-chip">manifest v1</span></div><div class="v8-swrow"><div class="v8-swtxt">deliver<div class="v8-swd">写输出物登记 · 读项目</div></div><span class="kbd-inline-chip">manifest v1</span></div><div class="v8-swrow"><div class="v8-swtxt">artifacts<div class="v8-swd">读输出物 · 读项目</div></div><span class="kbd-inline-chip">manifest v1</span></div></div><div class="v8-setcard"><h5>第三方扩展</h5><div class="v8-escape">🧩 尚无第三方扩展——规范与市场 M2 开放，不预建目录。技能（skill）/ MCP 兼容投送是 Agent 侧资产（舰队配装），不在本页——本页只管控制面扩展。</div></div></div>
<div class="settings-panel workspace-pane" data-settings-panel="about"><div class="v8-sethead"><div class="t">关于</div><div class="s">版本 · 更新 · 诊断</div></div><div class="v8-setcard about-hero"><div class="logo">cc-<b>deck</b></div><div class="ver"><span data-settings-version-tag>${escapeHtml((window.__shellVer || CONSOLE_VERSION) + " 通道")}</span></div><div style="margin-top:12px"><button class="primary-btn" data-update-check type="button">检查更新</button></div><div class="v8-swd" style="margin-top:8px" data-update-status>当前已是最新版本</div></div><div class="v8-setcard"><h5>开源</h5><div class="v8-swrow"><div class="v8-swtxt">源码与发版记录<div class="v8-swd">GitHub Releases · tag 即档案（git tag + 提交信息 + Release 页）</div></div><a class="kbd-inline-chip" data-about-link="https://github.com/humumu130/cc-deck" style="text-decoration:none">github.com/humumu130/cc-deck</a></div><div class="v8-swrow"><div class="v8-swtxt">项目主页<div class="v8-swd">在线演示与文档入口</div></div><a class="kbd-inline-chip" data-about-link="https://cc.humumu.online" style="text-decoration:none">cc.humumu.online</a></div></div><div class="v8-setcard"><h5>手机端</h5><div class="v8-swrow"><div class="v8-swtxt">下载手机 App<div class="v8-swd">扫码安装 · 手机端仅浏览、验证和换路由</div></div><span class="qr-placeholder" aria-label="下载二维码占位">二维码占位</span></div></div><div class="v8-setcard"><h5>设置迁移</h5><div class="v8-swrow"><div class="v8-swtxt">导出设置<div class="v8-swd">全部本地设置存为 JSON 文件 · 换壳 / 换设备迁移用</div></div><button class="secondary-btn" data-settings-export type="button">导出</button></div><div class="v8-swrow"><div class="v8-swtxt">导入设置<div class="v8-swd">从导出的 JSON 恢复（覆盖现有设置）· 导入后自动刷新</div></div><button class="secondary-btn" data-settings-import type="button">导入</button></div><input type="file" accept="application/json,.json" data-settings-import-file hidden></div><div class="v8-setcard"><h5>系统设计图纸</h5><div class="settings-list" data-settings-live="design" hidden></div></div></div>`;
        });


        safe("控件接线段", () => {
        wireCardDensityControls(body);
        wireFsDebugPanel(body); // 件十六：字号调试面板回填已存值/默认值
        // W-MIG 设置导入文件选择（change 委排在设置 body 上——导入钮武装确认后触发选档）
        body.addEventListener("change", (event) => {
          const f = event.target.closest("[data-settings-import-file]");
          if (f && f.files && f.files[0]) { importSettingsFile(f.files[0]); f.value = ""; }
        });
        // W-SETTINGS3 批1：V3 setnav foot——版本与连接态常驻导航底（活读壳版本/桥连接态）
        const navFoot = queue.querySelector("[data-settings-nav-foot]");
        if (navFoot) navFoot.innerHTML = escapeHtml(String(window.__shellVer || CONSOLE_VERSION)) + "<br>本机 relay · 已连接";
        // W-SETTINGS3 批3：设置域密度双档——comfortable 默认；点击切档挂 #d-settings
        // data-settings-density（CSS 变量联动行距/卡留白）+ localStorage ccd_settings_density 持久
        });
        safe("密度与本地存储段", () => {
        const DENSITY_KEY = "ccd_settings_density";
        const applySettingsDensity = (mode) => {
          const m = mode === "compact" ? "compact" : "comfortable";
          section.dataset.settingsDensity = m;
          body.querySelectorAll("[data-settings-density-option]").forEach((b) => b.classList.toggle("active", b.dataset.settingsDensityOption === m));
        };
        applySettingsDensity((() => { try { return localStorage.getItem(DENSITY_KEY) || "comfortable"; } catch (_) { return "comfortable"; } })());
        body.addEventListener("click", (event) => {
          const btn = event.target.closest("[data-settings-density-option]");
          if (!btn) return;
          const m = btn.dataset.settingsDensityOption === "compact" ? "compact" : "comfortable";
          try { localStorage.setItem(DENSITY_KEY, m); } catch (_) {}
          applySettingsDensity(m);
        });
        // FB9 设置 queue 头 ×：返回进入设置前的域（设置无独立关闭语义，等价「关门走人」）
        queue.querySelector(".queue-head .icon-btn")?.addEventListener("click", () => setDesktopDomain(lastNonSettingsDomain));
        // FB9/FB3 移动设置「扫码添加新设备」与桌面同链（云形态输码 / LAN 弹配对四件套）
        document.querySelector("#m-settings")?.addEventListener("click", (event) => {
          if (!event.target.closest("[data-settings-pair]")) return;
          if (cloudMode) { openCloudPairUI(); showToast("输入 8 位配对码配对（电脑端 CC Deck 设置 → relay 页领取）"); return; }
          openLanPairDialog();
        });
        // #160 空闲置灰时长（旧壳 #121 口径）：change 提交（空/非法回落 30），存
        // ccd_idle_dim_min 后经 __ccDeck005IdleDim 钩子回写 B2 闭包并立即重渲生效；
        // Enter 直接 blur 走 change（旧壳 #121②：WebView 回车不触发 change 只失焦触发）
        const idleDimInput = body.querySelector("[data-idle-dim-input]");
        if (idleDimInput) {
          idleDimInput.value = String(window.__ccDeck005IdleDim ? window.__ccDeck005IdleDim.get() : 30);
          idleDimInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
          idleDimInput.addEventListener("change", () => {
            const raw = idleDimInput.value.trim();
            let v = raw === "" ? 30 : Math.trunc(Number(raw));
            if (!Number.isFinite(v)) v = 30;
            idleDimInput.value = String(v);
            try { localStorage.setItem("ccd_idle_dim_min", String(v)); } catch (_) {}
            if (window.__ccDeck005IdleDim) window.__ccDeck005IdleDim.set(v);
          });
        }
        });
        safe("面板切换装配段", () => {
        body.dataset.settingsReady = "1";
        const panels = [...body.querySelectorAll("[data-settings-panel]")];
        const cards = [...queue.querySelectorAll(".queue-card")];
        const title = section.querySelector(".workspace-head h2");
        const segmentBar = section.querySelector(".workspace-head .segment-bar");
        const activateSettings = (index) => {
          const key = SETTINGS_PANELS[index] || "connections";
          panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.settingsPanel === key));
          cards.forEach((card, cardIndex) => card.classList.toggle("selected", cardIndex === index));
          if (title) title.textContent = SETTINGS_TITLES[index] || "设置";
          setWindowbarHint("settings", ""); // 件十二-A：设置域顶栏不挂 hint（副题 mono 文本曾被误读为按钮点击无反应；面板语义由第二列卡承载，与其他域统一）
          if (segmentBar) segmentBar.style.display = key === "connections" ? "flex" : "none";
        };
        cards.forEach((card, index) => { card.dataset.settingsIndex = String(index); });
        queue.addEventListener("click", (event) => {
          const card = event.target.closest(".queue-card[data-settings-index]");
          if (card) activateSettings(Number(card.dataset.settingsIndex));
        });
        const connectionPanes = [...body.querySelectorAll('[data-settings-panel="connections"] > .settings-connection-tabs')];
        wireSegmentTabs([...section.querySelectorAll(".workspace-head .segment-bar button")], connectionPanes);
        body.addEventListener("click", (event) => {
          const toggle = event.target.closest("[data-settings-toggle]");
          if (toggle) {
            const key = toggle.dataset.settingsToggle;
            const next = !toggle.classList.contains("active");
            toggle.classList.toggle("active", next);
            toggle.setAttribute("aria-pressed", String(next));
            try { localStorage.setItem("cc-deck-005-" + (SETTINGS_TOGGLE_KEYS[key] || key), next ? "1" : "0"); } catch (_) {}
            if (key === "sound") {
              showToast("通知声音已" + (next ? "开启" : "关闭"));
              if (next) playNotifyDing();
            } else {
              showToast("桌面通知已" + (next ? "开启" : "关闭"));
              if (next) void ensureNotifyPermission();
            }
            return;
          }
          if (event.target.closest("[data-settings-pair]")) {
            // 云形态：配对=输 8 位码（码即信任锚）；LAN/桌面形态走 B1 弹窗（复制链接 / 转云配对）
            if (cloudMode) { openCloudPairUI(); showToast("输入 8 位配对码配对（电脑端 CC Deck 设置 → relay 页领取）"); return; }
            openLanPairDialog();
            return;
          }
          if (event.target.closest("[data-settings-share]")) {
            // #45 行级分享（2026-10-10）：与「＋ 配对新设备」同链——云形态输码 / LAN 弹 B1 四件套
            if (cloudMode) { openCloudPairUI(); return; }
            openLanPairDialog();
            return;
          }
          // #102 批 B：引擎目录未登录行/「立即登录」钮 → 弹登录卡（二维码扫码即登录）
          const engLoginRow = event.target.closest("[data-engine-login]");
          if (engLoginRow) {
            const eng = engLoginRow.dataset.engineLogin || "";
            if (eng && window.__ccDeck005LoginCard) window.__ccDeck005LoginCard.open(eng);
            return;
          }
          if (event.target.closest("[data-settings-add-provider]")) { showToast("provider 接入在 relay 侧配置 · 见组织角色缺省引擎"); return; }
          // 件十五：关于页项目主页/仓库链接——统一走 __ccDeck005OpenUrl（桌面 openExternal /
          // 浏览器直开，既有跨形态打开链）
          const aboutLink = event.target.closest("[data-about-link]");
          if (aboutLink) { void window.__ccDeck005OpenUrl(aboutLink.dataset.aboutLink); return; }
          // W-DESIGNHUB 图纸打开：relay 相对路径经 HttpOrigin 拼绝对地址（桌面形态
          // location 是 tauri.localhost，相对路径必断链——#158-批4a 验收单同款口径）
          const designBtn = event.target.closest("[data-design-doc]");
          if (designBtn) {
            const origin = (typeof window.__ccDeck005HttpOrigin === "function" && window.__ccDeck005HttpOrigin()) || location.origin;
            void window.__ccDeck005OpenUrl(origin.replace(/\/+$/, "") + designBtn.dataset.designDoc);
            return;
          }
          // FB9 footer 两钮接线：帮助走仓库 README 外链；验证按桥的实连态给结论（不伪造通过）
          if (event.target.closest("[data-settings-help]")) { void window.__ccDeck005OpenUrl("https://github.com/humumu130/cc-deck#readme"); return; }
          if (event.target.closest("[data-settings-verify]")) {
            const b = window.__ccDeck005B4;
            if (b && b.connection === "online" && b.hasSnapshot) showToast("验证完成 · " + (window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(b.relayName) : b.relayName) + " 在线 · " + (b.sessions ? b.sessions.size : 0) + " 会话在册");
            else if (b && b.connection === "connecting") showToast("验证中 · relay 连接建立中，快照到达后自动同步");
            else showToast("验证未通过 · relay 未连接（自动重连中）");
            return;
          }
          // #158-批3 连接诊断行：err / 缺 Node 态可点——跳 nodejs.org 安装引导（批4a 走统一外链兜底链）
          const diagRow = event.target.closest('[data-relay-diag][data-diag="err"], [data-relay-diag][data-diag="node"]');
          if (diagRow) { void window.__ccDeck005OpenUrl("https://nodejs.org/zh-cn"); return; }
          if (event.target.closest("[data-update-check]")) { void manualCheckUpdate(); return; }
          // W-MIG 设置导出/导入：导入两段确认（armed → 「确认导入？」3s 窗）防误触覆盖
          if (event.target.closest("[data-settings-export]")) { exportSettings(); return; }
          const importBtn = event.target.closest("[data-settings-import]");
          if (importBtn) {
            if (importBtn.dataset.armed) {
              importBtn.dataset.armed = ""; importBtn.textContent = "导入";
              const fileInput = document.querySelector('[data-settings-panel="about"] [data-settings-import-file]');
              if (fileInput) fileInput.click();
            } else {
              importBtn.dataset.armed = "1"; importBtn.textContent = "确认导入？";
              setTimeout(() => { importBtn.dataset.armed = ""; importBtn.textContent = "导入"; }, 3000);
            }
            return;
          }
          const uiScaleBtn = event.target.closest("[data-ui-scale-option]"); // FB10：字号档点击（委排在设置 body 上，与密度档分离——密度档另有全局委排）
          if (uiScaleBtn) { applyUiScale(uiScaleBtn.dataset.uiScaleOption, true); return; }
          // W-ICON② 快捷键自定义接线：单组合类点 chip 进捕获态；方向键档点 chip 循环 Alt/Ctrl
          const keyChip = event.target.closest("[data-keymap-chip]");
          if (keyChip) {
            if (keyChip.dataset.keymapChip === "toggle" && !(window.ccDeck || window.__TAURI__)) { showToast("浏览器形态不支持全局快捷键"); return; }
            startKeyCapture(keyChip.dataset.keymapChip, keyChip);
            return;
          }
          const kbmodChip = event.target.closest("[data-kbmod-chip]");
          if (kbmodChip) {
            const nextMod = kbMod() === "ctrl" ? "alt" : "ctrl";
            try { localStorage.setItem(KBMOD_STORE, nextMod); } catch (_) {}
            refreshKeyChips();
            showToast("方向键修饰键已切换为 " + (nextMod === "alt" ? "Alt" : "Ctrl"));
            return;
          }
          if (event.target.closest("[data-keymap-reset]")) { resetKeymap(); return; }
        });
        activateSettings(SETTINGS_PANELS.indexOf("connections")); // W-SETTINGS3 批1：面板序 V3 化后默认页仍=连接与设备（source-manage「管理与配对新源」跳入语义不变；旧序 0=connections）
        });
      }
      function initSettingsLiveData() {
        const bridge = window.__ccDeck005B4;
        if (!bridge) return;
        const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
        const oneLine = (t) => { const v = String(t ?? "").replace(/\s+/g, " ").trim(); return v.length > 160 ? v.slice(0, 160) + "…" : v; }; // #102 批 A：auth_hint 单行化（本块独立定义，不跨 script 块借对话域同名函数）
        const ENGINE_SHORT = { claude: "Claude", codex: "Codex", trae: "Trae", "qwen-code": "Qwen", codebuddy: "CodeBuddy", zcode: "ZCode" };
        const ENGINE_BADGE = { claude: "claude", codex: "codex", trae: "trae", "qwen-code": "qwen", codebuddy: "codebuddy", zcode: "zcode" };
        const render = () => {
          const section = document.querySelector("#d-settings");
          const bodyEl = section?.querySelector(".workspace-body");
          if (!section || !bodyEl?.dataset.settingsReady) return;
          const snap = bridge.snapshot && typeof bridge.snapshot === "object" ? bridge.snapshot : {};
          const caps = snap.source_capabilities || {};
          const catalog = Array.isArray(caps.engine_catalog) ? caps.engine_catalog : null;
          // #158-批3 状态遮蔽修复（审查 R4）：快照只在连接层仍在线/连接中时兜底「在线」——
          // WS 已断（offline/unconfigured）时曾收过 SNAPSHOT 也显示实际态，不再假「在线」
          const connState = bridge.hasSnapshot && bridge.connection !== "offline" && bridge.connection !== "unconfigured" ? "online" : bridge.connection;
          const stateText = connState === "online" ? "在线" : connState === "connecting" ? "连接中" : "未连接";
          const connLive = section.querySelector('[data-settings-live="connections"]');
          if (connLive) {
            if (cloudMode) {
              // 缝合点 d：云形态连接面板整块交给云链模块渲染（云桥状态行/本页设备行/输码表单/重试钮）
              connLive.innerHTML = '<div data-cloud-settings-slot></div>';
              renderCloudUI();
            } else {
              // #158-批3：桌面形态加 relay 诊断小字行（relayStatus 病因透出）；端口行优先取
              // 探测命中端口（tauri.localhost 的 location.port 是空，8787 硬编会误导多端口变体）
              const shellDiag = !!(window.ccDeck && typeof window.ccDeck.relayStatus === "function");
              const relayPort = (localRelayInfo && localRelayInfo.port) || location.port || "8787";
              const desktopForm = !!(window.__TAURI__ || window.ccDeck);
              // #45 行级分享钮（2026-10-10）：旧壳 srv-share 语义对位——恒渲染、未在线置灰，
              // 点击开 B1 配对弹窗（openLanPairDialog，QR/码/链接/设备四件套）；云形态行由
              // cloudSettingsRows 渲染（未配对时自带输码表单），不进此分支
              const shareOn = connState === "online";
              const shareBtn = '<button class="row-share" data-settings-share type="button"' + (shareOn ? "" : " disabled")
                + ' title="' + (shareOn ? "手机扫一下接入这台电脑（同网直连 · 跨网云桥，自动路由）" : "relay 未在线 · 连接后可分享") + '">分享</button>';
              // W-V8R 批6（连接与设备 v8 化）：relay 卡=relaystat 形态（v8 setpage-conn：
              // 绿点+主行+meta+动作钮右置），远程源/本页设备行=swrow 形态（v8 已配设备卡行）
              connLive.innerHTML =
                `<div class="v8-relaystat"><span class="v8-rdot2 ${connState === "online" ? "" : "off"}"></span><div><div class="st">本机 relay${esc(window.__ccDeck005SourceDisplayName && window.__ccDeck005SourceDisplayName(bridge.relayName) !== "本机" ? " · " + bridge.relayName : "")} · ${stateText}</div><div class="meta">端口 ${relayPort} · 事件流自动补发 · 断线自动重连</div>${shellDiag ? '<p class="relay-diag" data-relay-diag role="note"></p>' : ""}</div>${shareBtn}</div>` +
                // W-SDEL：远程源区=共享库条目列表（多条+连接/编辑/删除；云桥降级为条目之一）——
                // 桌面壳/浏览器 LAN 形态同样列出，死条目清理不依赖云链激活态（cloudSettingsRows
                // 空列表自给引导行；cloudUIOn 时附本页设备行与输码表单）
                cloudSettingsRows() +
                `<div class="v8-swrow"><span class="v8-swico">▣</span><div class="v8-swtxt">${desktopForm ? "桌面 App（" + (IS_MAC ? "macOS" : "Windows") + "）" : "浏览器 · 网页端"}<div class="v8-swd">${desktopForm ? "版本 " + esc(window.__shellVer || CONSOLE_VERSION) : "本页设备 · 配对 token " + (connState === "unconfigured" ? "未配置" : "已就绪")} <span style="color:var(--${connState === "unconfigured" ? "working" : "done"})">●</span></div></div><span class="v8-prbtn ${connState === "unconfigured" ? "go" : "ok"}">${connState === "unconfigured" ? "待配对" : "在线"}</span></div>`;
              if (shellDiag) void refreshRelayDiag();
            }
          }
          const devLive = section.querySelector('[data-settings-live="devices"]');
          if (devLive) devLive.innerHTML = '<div class="v8-escape">当前 relay 未下发已配设备清单 · 设备管理在桌面端完成。</div>';
          const provLive = section.querySelector('[data-settings-live="provider"]');
          if (provLive) {
            if (!catalog) provLive.innerHTML = '<div class="v8-escape">该 relay 未下发引擎目录（旧版本）· 引擎状态不可用。</div>'; /* W-SETTINGS3 批2：空态蓝描边 banner 退役，回 V3 灰字内联说明 */
            else provLive.innerHTML = catalog.map((e) => {
              if (!e || typeof e.id !== "string") return "";
              const ok = e.state === "ready";
              const na = e.state === "needs_auth"; // #102 批 A：装了未登录——黄点+登录指引（不混「待装」）
              const label = esc(e.label) || esc(ENGINE_SHORT[e.id]) || esc(e.id);
              const copy = ok
                ? (Array.isArray(e.models) && e.models.length ? `已接 · ${e.models.length} 个模型` : "已接 · 使用引擎默认模型")
                : na
                  ? esc(oneLine(e.auth_hint || "请先完成引擎登录"))
                  : esc(e.preflight && e.preflight.reason) || (e.state === "unsupported" ? "枚举占位 · 未接入编排" : "适配器待安装");
              const tag = ok ? '<span class="tag done">已接</span>' : na ? '<span class="tag authn">未登录</span>' : e.state === "unsupported" ? '<span class="tag">未接入</span>' : '<span class="tag">待装</span>';
              // #102 批 B：未登录行加「立即登录」钮（点行同效）——弹登录卡扫码即登录
              const loginBtn = na ? `<button class="row-share" data-engine-login="${esc(e.id)}" type="button" title="拉起登录面板，扫码完成登录">立即登录</button>` : "";
              // W-SETTINGS3 批2：引擎行 v8-swrow 行式化（V3 swrow：徽标左+label/描述+态右）
              return `<div class="v8-swrow engine-row${ok ? "" : " engine-off"}"${na ? ` data-engine-login="${esc(e.id)}" title="${esc(oneLine(e.auth_hint || "点此扫码登录"))}"` : ""}><span class="v8-swico engine-badge ${ENGINE_BADGE[e.id] || ""}">${esc(ENGINE_SHORT[e.id] || e.id)}</span><div class="v8-swtxt">${label}${na ? ' <span class="eng-auth-dot" aria-hidden="true"></span>' : ""}<div class="v8-swd">${copy}</div></div>${loginBtn || tag}</div>`;
            }).join("");
          }
          // W-DESIGNHUB 系统设计图纸区（关于页）：清单非空才显（能力位=SNAPSHOT.design_docs
          // 数组存在且非空——旧 relay/缺 docs 部署自动隐藏）。按 group 分组小标题 + 行；
          // 点击经 __ccDeck005HttpOrigin 拼绝对地址新窗直开（图纸 archify 自包含、自带
          // 深浅主题与交互，原样渲染不加工——无容器页）
          const designLive = section.querySelector('[data-settings-live="design"]');
          if (designLive) {
            const docs = Array.isArray(snap.design_docs) ? snap.design_docs.filter((d) => d && typeof d.path === "string" && typeof d.title === "string") : [];
            designLive.hidden = docs.length === 0;
            if (docs.length) {
              const groups = [];
              for (const d of docs) if (!groups.includes(d.group)) groups.push(d.group);
              designLive.innerHTML = groups.map((g) =>
                '<div class="queue-group">' + esc(g) + " · " + docs.filter((d) => d.group === g).length + "</div>"
                + docs.filter((d) => d.group === g).map((d) =>
                  '<div class="v8-swrow"><span class="v8-swico"><svg class="icon-inline" aria-hidden="true"><use href="#icon-layers"></use></svg></span><div class="v8-swtxt">' + esc(d.title) + '<div class="v8-swd">' + esc(d.path) + "</div></div>"
                  + '<button class="v8-prbtn" data-design-doc="' + esc(d.path) + '" type="button" title="新窗打开图纸">打开 ↗</button></div>').join("")
              ).join("");
            }
          }
          const idLive = section.querySelector('[data-settings-live="identity"]');
          if (idLive) {
            const roleMap = new Map();
            (catalog || []).forEach((e) => (Array.isArray(e && e.default_for_roles) ? e.default_for_roles : []).forEach((role) => { if (role && !roleMap.has(role)) roleMap.set(role, e); }));
            // W-MODE 协作模式段（团队域面板顶）：能力位=SNAPSHOT.collab_mode（undefined=
            // 旧 relay 不渲染，deliverables 同口径）。两态分段钮复用 density-control
            // 语言；点击走 COMMAND_ORG_ACTION（接线在下方独立委托，闭包内有 bridge）
            const cm = snap.collab_mode;
            // W-SETTINGS3 批2：协作模式行+角色行 v8 化（V3 tplrow：ico 左+名/描述+引擎 chip 右）
            const cmRow = (cm === "leader" || cm === "no-leader")
              ? '<div class="v8-swrow"><span class="v8-swico"><svg class="icon-inline" aria-hidden="true"><use href="#icon-users"></use></svg></span><div class="v8-swtxt">协作模式<div class="v8-swd">无 Leader 时隐藏常驻 Leader 卡（挂死恢复用）· 团队与看板照常</div></div><div class="density-control collab-mode-control" role="group" aria-label="协作模式"><button type="button" data-collab-mode-option="leader"' + (cm === "leader" ? ' class="active"' : "") + '>有 Leader</button><button type="button" data-collab-mode-option="no-leader"' + (cm === "no-leader" ? ' class="active"' : "") + '>无 Leader</button></div></div>'
              : "";
            idLive.innerHTML = cmRow + (roleMap.size
              ? [...roleMap.entries()].map(([role, e]) => `<div class="v8-swrow"><span class="v8-swico">${esc(String(role).trim().charAt(0).toUpperCase() || "·")}</span><div class="v8-swtxt">${esc(role)}<div class="v8-swd">开团初始编制 · 模板只给初始值不当牢笼</div></div><span class="kbd-inline-chip">${esc(e.label || ENGINE_SHORT[e.id] || e.id)}</span></div>`).join("")
              : '<div class="v8-escape">无预置角色模板 · 建团时在组织侧配置角色缺省引擎。</div>');
          }
          const cards = [...section.querySelectorAll(".queue .queue-card")];
          const setSub = (index, text) => { const p = cards[index]?.querySelector("p"); if (p) p.textContent = text; };
          setSub(0, cloudUIOn() ? "云桥 " + (window.__ccDeck005CloudUI ? window.__ccDeck005CloudUI.stateLabel() : "未连接") + " · 输码可配对" : "relay " + stateText + " · 本页即已配设备");
          const readyN = catalog ? catalog.filter((e) => e && e.state === "ready").length : 0;
          setSub(1, catalog ? readyN + " 引擎已接 · " + (catalog.length - readyN) + " 待装/未接入" : "引擎目录未下发");
          setSub(5, "v" + (window.__shellVer || CONSOLE_VERSION) + " · 通道");
        };
        bridge.subscribe(() => render());
        render();
        // W-SDEL 借道：服务器条目增删改后主动刷设置页实时区（bridge.subscribe 只随桥事件走，
        // 删本地条目无桥事件——不借道则 else 分支 DOM 停留旧列表）
        window.__ccDeck005RefreshSettingsLive = render;
        // W-MODE 协作模式分段钮：COMMAND_ORG_ACTION {action:"collab-mode"} → ACK ok 后
        // 乐观更新快照缓存并重渲（多端最终一致由 relay COLLAB_MODE_UPDATED 帧兜底；
        // 旧 relay orgAction default 拒 → toast 报错不切态）
        document.addEventListener("click", (event) => {
          const btn = event.target.closest("[data-collab-mode-option]");
          if (!btn) return;
          const mode = btn.dataset.collabModeOption === "no-leader" ? "no-leader" : "leader";
          if (bridge.snapshot && bridge.snapshot.collab_mode === mode) return; // 已在目标态（重渲染竞态防抖）
          btn.disabled = true;
          bridge.sendCommand("COMMAND_ORG_ACTION", { action: "collab-mode", mode }).then((ack) => {
            btn.disabled = false;
            if (ack && ack.ok) {
              if (bridge.snapshot && typeof bridge.snapshot === "object") bridge.snapshot.collab_mode = mode;
              render();
              showToast("协作模式已切换为「" + (mode === "no-leader" ? "无 Leader" : "有 Leader") + "」" + (mode === "no-leader" ? " · 常驻 Leader 卡已隐藏" : ""));
            } else {
              showToast("切换未生效：" + ((ack && ack.error) || "relay 未确认"));
            }
          });
        });
      }

      const params = new URLSearchParams(location.search);
      const isHttpPage = location.protocol.startsWith("http");
      const wsUrl = isHttpPage
        ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws"
        : "";
      let relayToken = params.get("token") || "";
      if (wsUrl) {
        try {
          if (relayToken) localStorage.setItem("cc-deck-005-token", relayToken);
          else relayToken = localStorage.getItem("cc-deck-005-token") || "";
        } catch (_) {}
      }
      window.__ccDeck005Token = relayToken; // W-NOVAFIX B2：域脚本空态文案活读当前 token（桌面壳探测命中后于此更新）
      if (params.get("token") && isHttpPage) {
        const cleanUrl = new URL(location.href);
        cleanUrl.searchParams.delete("token");
        history.replaceState(null, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      }
      // P0 连接接线（对齐旧壳探测链）：URL ?token= > localStorage > 桌面壳 invoke > loopback /local-info。
      // 桌面壳页面源是 http://tauri.localhost，裸 fetch /local-info 带 Origin 进不了 relay 白名单
      // （ws-server 只认 localhost/127.0.0.1/本机 LAN IP）——探测走壳侧 probe_local 命令（同进程
      // 无 Origin 头，与 Electron preload 同信任模型）；浏览器形态页面即 relay 同源服务，当前端口直探。
      const shellProbe = (() => {
        try {
          if (window.ccDeck && typeof window.ccDeck.probeLocal === "function") return () => window.ccDeck.probeLocal();
          const core = window.__TAURI__ && window.__TAURI__.core;
          if (core && typeof core.invoke === "function") return () => core.invoke("probe_local");
        } catch (_) {}
        return null;
      })();
      async function probeLocalRelay() {
        if (shellProbe) {
          try {
            const j = await shellProbe();
            return j && j.ok && j.port && j.token ? { port: Number(j.port), token: String(j.token), lanIp: String(j.lan_ip || "") } : null;
          } catch (_) { return null; }
        }
        if (!isHttpPage) return null;
        const port = location.port || (location.protocol === "https:" ? "443" : "80");
        try {
          const r = await fetch("http://127.0.0.1:" + port + "/local-info", { signal: AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined });
          if (!r.ok) return null;
          const j = await r.json().catch(() => null);
          return j && j.ok && j.token ? { port: Number(j.port) || Number(port), token: String(j.token), lanIp: String(j.lan_ip || "") } : null;
        } catch (_) { return null; }
      }
      // #158-批3 探测命中统一落库：token 无条件写最新（#21 教训：relay 换代/令牌轮换后旧
      // token 被 401 拒且永不自愈——不等缓存空）；探测结果留 localRelayInfo 供诊断行消费
      let localRelayInfo = null;
      function applyLocalProbe(probed) {
        localRelayInfo = { port: probed.port, token: probed.token, lanIp: probed.lanIp || "" };
        if (shellProbe) ctx.cfg.wsUrl = "ws://127.0.0.1:" + probed.port + "/ws";
        relayToken = probed.token;
        ctx.cfg.token = relayToken;
        window.__ccDeck005Token = relayToken; // W-NOVAFIX B2：域脚本活读点同步刷新
        try { localStorage.setItem("cc-deck-005-token", relayToken); } catch (_) {}
      }
      let bootProbeRetried = false; // 首探落空的 2.5s 补试只排一次（其后交给 6s 周期自愈）
      // W-NOVAFIX B1：LAN/桌面形态配对链接与弹窗。桌面壳 location 是 tauri.localhost 不可分享
      // ——用探测结果（local-info 的 lan_ip + port）拼 LAN 可达地址；浏览器形态页面即 relay，
      // location.origin 直用。云形态不走此链（openCloudPairUI 输码）。
      function lanShareLink() {
        const t = String((ctx.cfg && ctx.cfg.token) || relayToken || "");
        if (shellProbe && localRelayInfo) {
          const host = localRelayInfo.lanIp || "127.0.0.1";
          const port = localRelayInfo.port || 8787;
          return "http://" + host + ":" + port + "/app2?token=" + encodeURIComponent(t);
        }
        return location.origin + "/app2?token=" + encodeURIComponent(t);
      }
      // FB3 配对 UI 四件套（参照旧版 relay 页两栏制）：①二维码（手机扫码直入）②8 位配对码
      // （本机 relay 领码，手机 App「添加电脑 → 云桥」输入）③分享链接+复制钮 ④已连接设备列表。
      // 云形态不进此弹窗（openCloudPairUI 输码链）
      function drawPairQr(canvas, text) {
        try {
          const q = new QRCode(0, QRErrorCorrectLevel.M);
          q.addData(text);
          q.make();
          const n = q.getModuleCount(), pad = 2, scale = 4;
          canvas.width = canvas.height = (n + pad * 2) * scale;
          const g = canvas.getContext("2d");
          if (!g) return false;
          g.fillStyle = "#fff";
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.fillStyle = "#10151C";
          for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + pad) * scale, (r + pad) * scale, scale, scale);
          return true;
        } catch (_) { return false; }
      }
      async function fetchLanPairCode() {
        const t = String((ctx.cfg && ctx.cfg.token) || relayToken || "");
        if (!t) throw new Error("token 未就绪");
        const base = shellProbe && localRelayInfo ? "http://127.0.0.1:" + (localRelayInfo.port || 8787) : location.origin;
        const r = await fetch(base + "/api/pair-code?token=" + encodeURIComponent(t), { method: "POST", signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined });
        if (!r.ok) throw new Error("http " + r.status);
        const j = await r.json();
        if (!j || !j.code) throw new Error("响应缺码");
        return { code: String(j.code), ttlMs: Number(j.expires_in || 0) * 1000 }; // #FB3-TTL：relay expires_in 单位=秒（pairing.ts issue 返回 eff/1000），旧码当毫秒除 60000 恒显「1 分钟内有效」
      }
      function pairDeviceRows() {
        const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
        const bridge = window.__ccDeck005B4;
        const snapOk = !!(bridge && bridge.hasSnapshot && bridge.connection !== "offline" && bridge.connection !== "unconfigured");
        const relayPort = (localRelayInfo && localRelayInfo.port) || location.port || "8787";
        const relayNameRaw = bridge ? String(bridge.relayName || "relay") : "relay";
        const relayName = window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(relayNameRaw) : relayNameRaw; // 件十三：命名映射统一
        const desktopForm = !!(window.__TAURI__ || window.ccDeck);
        const dot = (on) => '<span class="source-dot' + (on ? "" : " status-disconnected") + '"></span>';
        return '<div class="pair-dev">' + dot(snapOk) + '<strong>本机 relay · ' + esc(relayName) + '</strong><small>端口 ' + esc(String(relayPort)) + '</small></div>'
          + '<div class="pair-dev">' + dot(true) + '<strong>' + (desktopForm ? "桌面 App（本机）" : "浏览器 · 本页设备") + '</strong><small>token 已就绪</small></div>'
          + '<div class="pair-dev"><span class="source-dot status-reconnecting"></span><strong>云桥</strong><small>跨网络中转 · 手机在外的接入通道</small></div>';
      }
      // 私网段 hostname 判定（LAN 分享路可信域；对齐旧壳 index.html PRIV_IP_RE 口径
      // ——回环/公网域名不进 LAN 路：手机够不着，交给云桥）
      const PRIV_IP_RE = /^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./;
      // 0.7 批1 件2：手机 App 扫码真因修复——配对 QR 换 v2 智能码。旧 QR 落 app2 网页
      // 链接，手机 parseScanPayload 只认 JSON 智能码 / ws 直连格式，必然解析失败。
      // 智能码 = ccdeck-add v2 {lan, cloud} 双路并存，手机扫码侧 probeLanWs 2.5s 真实
      // 握手探测自主择路（同网直连 / 跨网云桥）。构建口径对齐旧壳 buildSmartShareParts
      // （index.html :11696）：LAN 路取探测 lan_ip 组 ws 直连址（私网段 hostname 才可信
      // ——公网域名/回环手机够不着，交给云路）；云路仅 relay 接了云桥才有（CLOUD_INFO
      // 拿桥址+桥 token+relay 身份）。配对码一次性短时效——只领一枚，8 位码框与 QR
      // 云路共用（两处分领会互踢码）；弹层仍开则到期前 30s 重领重画。
      function buildSmartPairParts() {
        const t = String((ctx.cfg && ctx.cfg.token) || relayToken || "");
        let lan = null;
        try {
          let host = "", port = 0;
          if (shellProbe && localRelayInfo) { host = localRelayInfo.lanIp || ""; port = localRelayInfo.port || 8787; }
          else if (isHttpPage && location.hostname) { host = location.hostname; port = Number(location.port) || (location.protocol === "https:" ? 443 : 80); }
          if (host && t && PRIV_IP_RE.test(host)) lan = { url: "ws://" + host + ":" + port + "/ws", token: t };
        } catch (_) {}
        return fetchLanPairCode().then((pc) => {
          const code = pc.code;
          const b4 = window.__ccDeck005B4;
          const cloudQ = b4 && typeof b4.sendCommand === "function"
            ? b4.sendCommand("COMMAND_CLOUD_INFO", {}).then((ci) => {
                const info = ci && ci.ok && ci.cloudInfo;
                return info && info.cloud && info.bridge && info.rd && info.rk
                  ? { bridge: String(info.bridge), bt: String(info.bt || ""), rd: String(info.rd), rk: String(info.rk), code }
                  : null;
              })
            : Promise.resolve(null);
          return cloudQ.then((cloud) => ({ code, ttlMs: pc.ttlMs, lan, cloud }));
        });
      }
      // 智能码落 QR：lan/cloud 至少一路在场才调（全空维持 app2 链接兜底不动）
      function drawSmartPairQr(cv, parts) {
        const payload = JSON.stringify(Object.assign(
          { t: "ccdeck-add", v: 2 },
          parts.lan ? { lan: parts.lan } : {},
          parts.cloud ? { cloud: parts.cloud } : {},
        ));
        if (!drawPairQr(cv, payload)) return false;
        const col = cv.closest(".pair-qr-col");
        const small = col && col.querySelector("small");
        if (small) small.innerHTML = "手机扫码即连 · 同网直连<br>跨网走云桥自动择路"; // 1013 件4：一行太长是左栏被撑宽元凶之一，拆两行紧凑排
        return true;
      }
      function openLanPairDialog() {
        document.querySelectorAll("[data-pair-pop], [data-pair-back]").forEach((el) => el.remove());
        const back = document.createElement("div");
        back.className = "pair-pop-backdrop";
        back.dataset.pairBack = "";
        const pop = document.createElement("div");
        pop.className = "source-menu pair-pop";
        pop.dataset.pairPop = "";
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-modal", "true");
        pop.setAttribute("aria-label", "配对新设备");
        const link = lanShareLink();
        let smartTimer = null;
        pop.innerHTML = '<div class="source-menu-head">配对新设备</div>'
          + '<div class="pair-grid">'
          + '<div class="pair-qr-col"><canvas data-pair-qr width="10" height="10"></canvas><small>手机扫码直接加入</small></div>'
          + '<div class="pair-info">'
          + '<div class="pair-code-box"><div class="pair-code-digits" data-pair-code>····<br>····</div><span class="pair-code-note" data-pair-code-note>正在领取 8 位配对码…</span></div>'
          + '<div class="pair-link-row"><input readonly value="' + link.replace(/"/g, "&quot;") + '" aria-label="配对链接"><button class="secondary-btn" type="button" data-pair-copy>复制</button></div>'
          + '</div></div>'
          + '<div class="source-menu-head">已连接设备</div>'
          + '<div class="pair-devs">' + pairDeviceRows() + '</div>'
          + '<div class="pair-foot"><a class="pair-cloud-link" data-pair-cloud>云通道配对页 ↗</a><button class="primary-btn" type="button" data-pair-close>完成</button></div>';
        const close = () => { if (smartTimer) clearTimeout(smartTimer); pop.remove(); back.remove(); };
        back.addEventListener("click", close);
        pop.addEventListener("click", async (event) => {
          if (event.target.closest("[data-pair-copy]") || event.target.closest(".pair-link-row input")) {
            let ok = false;
            try { await navigator.clipboard.writeText(link); ok = true; } catch (_) {}
            showToast(ok ? "配对链接已复制 · 发给同网络的设备打开" : "复制失败 · 链接：" + link);
            return;
          }
          if (event.target.closest("[data-pair-cloud]")) {
            void window.__ccDeck005OpenUrl("https://cc.humumu.online/app2");
            showToast("云配对页已打开 · 在该页输入 8 位配对码");
            return;
          }
          if (event.target.closest("[data-pair-close]")) { close(); return; }
        });
        const host = document.querySelector(".mode-stage.active") || document.body;
        host.append(back, pop);
        // ①二维码：先落 app2 链接（即时兜底，浏览器打开配对页链路不变；qr.js 加载
        // 失败留白不阻断），智能码就绪后重画——手机 App 只认 ccdeck-add 智能码
        //（0.7 批1 件2 真因修复），两路全败维持链接并如实提示
        const cv = pop.querySelector("[data-pair-qr]");
        if (cv && !drawPairQr(cv, link)) cv.closest(".pair-qr-col")?.querySelector("small")?.replaceWith(Object.assign(document.createElement("small"), { textContent: "码图不可用 · 用下方链接" }));
        // ②8 位配对码 + 智能码同源同码（一次性码分领互踢）：领码成功即填码框，
        // lan/cloud 任一路就绪即重画 QR；弹层仍开则在到期前 30s 重领重画。
        // 领码失败（旧 relay 未开配对 / 桌面壳跨源被拦）降级提示
        const applySmart = () => {
          const digits = pop.querySelector("[data-pair-code]");
          const note = pop.querySelector("[data-pair-code-note]");
          return buildSmartPairParts().then((parts) => {
            if (!pop.isConnected) return;
            if (smartTimer) { clearTimeout(smartTimer); smartTimer = null; } // 重领前必清旧续期器（防 QR 画失败等分支双倍重领）
            if (digits) digits.replaceChildren(parts.code.slice(0, 4), document.createElement("br"), parts.code.slice(4)); // 1013 件1：两组四位分两行（原单行在右栏受压时折行贴边）
            const mins = Math.max(1, Math.round((parts.ttlMs || 300000) / 60000));
            if (note) note.innerHTML = "手机 App「添加电脑」输入 ·<br>" + mins + " 分钟内有效"; // 1013 件1 追补：右栏 200px 档自然断行会把「5」孤在行尾（mins 数字安全免转义），定死「·」后断行
            if (cv && (parts.lan || parts.cloud)) {
              drawSmartPairQr(cv, parts);
              const ttl = parts.ttlMs || 300000;
              if (ttl > 40000) smartTimer = setTimeout(() => { void applySmart().catch(() => {}); }, ttl - 30000);
            }
          });
        };
        void applySmart().catch(() => {
          if (!pop.isConnected) return;
          const note = pop.querySelector("[data-pair-code-note]");
          if (note) note.textContent = "领码失败 · 用二维码或链接配对";
          const col = cv && cv.closest(".pair-qr-col");
          const small = col && col.querySelector("small");
          if (small) small.textContent = "智能码未就绪 · 本码供浏览器打开配对页";
        });
      }
      async function bootstrapConnection() {
        // 缝合点 a：https 公网页面（/app2 经 CF Worker 出面）走云桥链——loopback ws:// 被混合
        // 内容策略掐死、桌面探测链不适配公网形态；tauri / http LAN 形态保持原探测链不动。
        if (cloudMode) { bootstrapCloud(); return; }
        // W-WINPAIR-R2 壳内持久回连（并行保活）：上次会话激活过云桥且共享库有已配对云源——
        // 云链与本机 LAN **并行**起（本机探测链继续走，不 return 不停链）；视角按持久偏好恢复。
        if (!cloudMode && shellProbe && !shellCloud && lsGet(SHELL_CLOUD_KEY) === "1"
            && cloudSharedCloudServers().some((s) => s.cloud && s.cloud.paired)) {
          shellCloud = true;
          bootstrapCloud(); // 并行起云；命令面由下方视角恢复/setSourceView 决定
          const saved = lsGet("cc-deck-005-source-view");
          const wasAggregate = lsGet("cc-deck-005-source-mode") === "aggregate"; // 先存：setSourceView 会写 mode 键
          setSourceView(saved === "cloud" ? "cloud" : "local");
          if (wasAggregate) setSourceView("aggregate"); // 上次聚合视图一并恢复
        }
        // 桌面壳：location.host 是 tauri.localhost（非 relay），ws 落探测回的回环端口；浏览器形态
        // 页面即 relay 同源服务，wsUrl 维持 location 推导不变。探测全败不炸——回落未配置引导。
        if (shellProbe || (isHttpPage && !relayToken)) {
          const probed = await probeLocalRelay();
          if (probed) applyLocalProbe(probed);
        }
        ctx.probing = false;
        connectLan(ctx);
        if (!ctx.cfg.wsUrl || !ctx.cfg.token) {
          // 桌面形态首探落空 2.5s 补试一次（旧壳 12316-12343 模式）：壳拉起内嵌 relay 有冷启动
          // 竞态（Defender 冷扫描可让 relay 起过壳的就绪窗口），补试命中即落库重走连接链
          if (shellProbe && !bootProbeRetried) {
            bootProbeRetried = true;
            setTimeout(async () => {
              if (ctx.stopped) return;
              const again = await probeLocalRelay();
              if (again) {
                applyLocalProbe(again);
                ctx.probing = false;
                connectLan(ctx);
                renderSessionList();
              }
            }, 2500);
          }
          const b4 = window.__ccDeck005B4;
          if (b4 && typeof b4.markUnconfigured === "function") b4.markUnconfigured();
          renderSessionList();
        }
      }
      const RETRY_BASE_MS = 1000;
      const sessionList = document.querySelector("#d-session [data-session-list]");
      const ctx = {
        cfg: { wsUrl, token: relayToken },
        ws: null,
        sessions: new Map(),
        lastSeq: 0,
        status: "offline",
        statusText: "未连接",
        probing: isHttpPage && !relayToken, // P0 连接接线：token 探测期占位（探测全败回落引导文案）
        reconnectDelay: RETRY_BASE_MS,
        reconnectTimer: null,
        lanHsTimer: null,
        stopped: false,
        hasSnapshot: false,
        selectedSessionId: null,
        relayName: location.host,
      };
      // #158-批3 B2 新建表单浏览钮判定（旧壳 activeIsLocalRelay 8748-8758 口径的 005 简化）：
      // 当前源 ws 指向回环——目录对话框选的是这台电脑的文件系统，远程源该路径不存在
      window.__ccDeck005LocalRelayLoopback = () => {
        try {
          const h = new URL(String(ctx.cfg.wsUrl || "").replace(/^ws/i, "http")).hostname;
          return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
        } catch (_) { return false; }
      };
      // #158-批4a：验收单等页内生成链接的绝对地址源——按当前实连 ws 地址换 http origin（云形态
      // wss://cc.humumu.online/cloud → https://cc.humumu.online；桌面 ws://127.0.0.1:port/ws →
      // http://127.0.0.1:port，替代 location 推导——桌面形态 location 是 tauri.localhost 必断链）。
      // 推导不出（file://、未配置）回落 location.origin（浏览器形态两者本就一致）
      window.__ccDeck005HttpOrigin = () => {
        try {
          const raw = String((typeof cloudUIOn !== "undefined" && cloudUIOn() ? cloudCtx.cfg.wsUrl : ctx.cfg.wsUrl) || "");
          const u = new URL(raw.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:"));
          if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
        } catch (_) {}
        return location.origin;
      };

      function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
      }

      // #B3-8 地基列表（B2 接管前的引导期渲染）同步 dayLabel 同族时间口径
      function fmtListTimeBase(ts) {
        if (!ts) return "";
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const t = new Date(ts);
        const p = (n) => String(n).padStart(2, "0");
        if (ts >= startOfToday) return p(t.getHours()) + ":" + p(t.getMinutes());
        if (ts >= startOfToday - 86400e3) return "昨天";
        const md = t.getMonth() + 1 + "月" + t.getDate() + "日";
        return t.getFullYear() === now.getFullYear() ? md : t.getFullYear() + "年" + md;
      }
      function sessionItem(session) {
        const status = ({ WORKING: "working", WAITING: "waiting", ERROR: "error", DONE: "done" })[session.status] || "done";
        const engineKey = session.engine || "claude";
        const engine = ({ claude: ["Claude", "claude"], codex: ["Codex", "codex"], trae: ["Trae", "trae"], "qwen-code": ["Qwen Code", "qwen"], codebuddy: ["CodeBuddy", "codebuddy"], zcode: ["ZCode", "zcode"] })[engineKey] || [engineKey, ""];
        const activityTime = Number(session.updated_at || session.started_at || 0);
        const turnStart = Number(session.turn_started_at || session.started_at || Date.now());
        return {
          id: escapeHtml(session.session_id),
          title: escapeHtml(session.title || session.initial_prompt || session.session_id),
          summary: escapeHtml(session.action_summary || session.last_error || window.__ccDeck005PathUi.displayPath(session.cwd) || "暂无活动摘要"),
          status,
          tag: ({ working: "运行中", waiting: "待处理", error: "错误", done: "完成" })[status],
          tagClass: ({ working: "info", waiting: "action", error: "danger", done: "done" })[status],
          engine: escapeHtml(engine[0]),
          engineClass: engine[1],
          source: escapeHtml(window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(session.relay_source || ctx.relayName) : (session.relay_source || ctx.relayName)), // W-UIPOLISH ⑧ + W-WINPAIR-R6：源名读 per-session 源标识（聚合两源各显其名），回落本机
          time: activityTime ? fmtListTimeBase(activityTime) : "",
          selected: session.session_id === ctx.selectedSessionId,
          pinned: session.pinned === true,
          workSecs: Math.max(0, Math.floor((Date.now() - turnStart) / 1000)),
        };
      }

      function renderSessionList() {
        // #143 盲评A-1 止血：B2 已接管会话列表（打 b2Owned 标）后地基让位——不再用陈旧快照
        // 覆盖 B2 的新鲜渲染（地基只吃 SNAPSHOT、增量全忽略，重连窗口内必陈旧）。dataset 同步归 B2。
        if (sessionList.dataset.b2Owned === "1") return;
        const v = viewSource();
        const c = v === "cloud" ? cloudCtx : ctx; // W-WINPAIR-R2：数据源跟视角（cloud=云上下文；local/aggregate 以本机为主视图）
        // W-WINPAIR-R2 聚合：全部已连接源的会话合并展示（本机 + 已激活云链；test.19 回归②真聚合）
        const aggOn = v === "aggregate";
        const aggList = aggOn ? [...ctx.sessions.values(), ...(shellCloud ? [...cloudCtx.sessions.values()] : [])] : null;
        const aggSnap = aggOn ? (ctx.hasSnapshot || (shellCloud && cloudCtx.hasSnapshot)) : false;
        sessionList.dataset.relayState = (aggOn ? aggSnap : c.hasSnapshot) ? "snapshot" : c.status;
        sessionList.dataset.connection = c.status;
        sessionList.dataset.sessionCount = String(aggOn ? aggList.length : c.sessions.size);
        if ((aggOn ? !aggSnap || !aggList.length : !c.hasSnapshot || !c.sessions.size)) {
          const label = c.cfg && c.cfg.kind === "cloud" ? "云桥" : "relay"; // 云链占位文案走云桥前缀（配对中/未配对等态直达用户）
          // W-NOVAFIX B2：桌面壳（shellProbe 在场）token 未就绪一律「正在连接本机 relay…」——
          // 冷启动/探测落空窗口不给「?token=」浏览器口径文案（桌面无 URL query 可用）
          const shellForm = !!(shellProbe || (window.__ccDeck005DesktopForm && window.__ccDeck005DesktopForm()));
          const message = !c.cfg.wsUrl ? (label === "云桥" ? "云桥未配置" : shellForm ? "正在连接本机 relay…" : "请通过 relay 同源 HTTP 页面连接") : !c.cfg.token ? (c.probing || shellForm ? "正在连接本机 relay…" : "请通过带 ?token= 的 relay 链接连接") : !c.hasSnapshot ? (c.status === "online" ? "等待 relay SNAPSHOT…" : label + " " + c.statusText) : (shellForm && !cloudUIOn() ? "暂无会话 · 连其他电脑点顶部菜单「＋ 添加服务器」" : "暂无会话 · relay SNAPSHOT 已同步");
          const placeholder = document.createElement("div");
          placeholder.className = "readonly-banner";
          placeholder.dataset.sessionEmpty = "true";
          placeholder.setAttribute("role", "status");
          placeholder.textContent = message;
          sessionList.replaceChildren(placeholder);
          return;
        }
        const sessions = (aggOn ? aggList : [...c.sessions.values()]).sort((first, second) => Number(second.pinned === true) - Number(first.pinned === true) || Number(second.updated_at || 0) - Number(first.updated_at || 0));
        // B18 口径同步（地基首屏占位；接管后由 B2 renderMyList 重渲）：
        // UIPOLISH2 件五：置顶全局最顶两段式（pinned 抽池平铺最顶不带分组头）
        // 追加（2026-10-12 用户拍板）：「进行中」状态分组取消（与 B2 主列表同步，防首帧闪
        // 组头）——其余会话合流平铺（recency 序），状态过滤交给筛选档
        const pinnedPool = sessions.filter((session) => session.pinned === true);
        const unpinned = sessions.filter((session) => session.pinned !== true);
        const template = document.createElement("template");
        template.innerHTML = pinnedPool.map((session) => renderSessionCard(sessionItem(session), "desktop")).join("")
          + unpinned.map((session) => renderSessionCard(sessionItem(session), "desktop")).join("");
        template.content.querySelectorAll(".srow-cta").forEach((button) => {
          button.dataset.stub = "B2";
          button.setAttribute("aria-label", "处理会话 · 待 B2 迁移");
        });
        sessionList.replaceChildren(template.content);
      }

      function setConn(context, status, text, failKind = "none") {
        context.status = status;
        context.statusText = text;
        context.failKind = failKind;
        const className = status === "online" ? "status-connected" : status === "connecting" ? "status-reconnecting" : "status-disconnected";
        connectionChips.forEach((chip) => {
          chip.classList.remove("status-connected", "status-reconnecting", "status-disconnected");
          chip.classList.add(className);
          chip.setAttribute("aria-label", "连接状态 · " + text);
          const textNode = [...chip.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
          if (textNode) textNode.nodeValue = (context.cfg && context.cfg.kind === "cloud" ? "云桥 " : "relay ") + text; // 云链徽标「本机 · 云桥」（旧壳 renderGpStatus 4399 口径）
        });
        document.querySelectorAll("[data-source-dot]").forEach((dot) => {
          dot.classList.remove("status-connected", "status-reconnecting", "status-disconnected");
          dot.classList.add(className);
        });
        // W-UIFB ①：trigger 连接图标同步四态（此链路无 unconfigured 概念，非连非通即红=失败）
        const connCls = status === "online" ? "conn-on" : status === "connecting" ? "conn-wait" : "conn-fail";
        document.querySelectorAll("[data-source-conn]").forEach((el) => { el.className = "source-conn " + connCls; });
        renderSessionList();
      }

      function scheduleReconnect(context) {
        if (context.stopped) return;
        clearTimeout(context.reconnectTimer);
        const jitter = context.reconnectDelay * (0.8 + Math.random() * 0.4); // #143 盲评A-3：±20% 抖动防多端同步重连风暴
        context.reconnectTimer = setTimeout(() => connectLan(context), jitter);
        context.reconnectDelay = Math.min(context.reconnectDelay * 2, 30000);
      }

      // ==================== 云桥链（B批移植，specs DV6g 备案） ====================
      // 适用形态：https 公网页面（/app2 经 CF Worker 出面，loopback ws:// 被混合内容策略掐死，
      // 云桥=公网形态唯一通路）。http LAN / tauri 桌面形态不走本链（bootstrapConnection 分流，
      // 现有探测链不动）。链路：浏览器 → 桥（wss /cloud；公司代理掐 WS 时降级 /cloud-poll 长轮询）
      // → 电脑端 relay，帧全部 tweetnacl box 密封（桥只见密文）。命令上行经 cloudCmdShim 借道
      // __ccDeck005MainWs（B2/B4/Team 命令面零改动），下行解密封后进帧总线（ACK 按 command_id
      // 结算，不锚具体 socket，防串台）。
      const cloudMode = location.protocol === "https:" && !shellProbe; // 缝合点 a：形态判定（https 非桌面壳）
      const CLOUD_RETRY_BASE_MS = 3000, CLOUD_RETRY_MAX_MS = 30000; // 旧壳云链节奏（地基 LAN 1s/30s，两链独立）
      const ACTIVE_CLOUD_KEY = "cc-deck-005-active-cloud"; // 005 自有偏好键：活动云源 id（不与旧壳 ccd_active 纠缠）
      // W-WINPAIR：壳内云源通路——桌面壳默认连本机内嵌 relay（cloudMode=false 把云链整体门控），
      // 用户「＋ 添加服务器」显式切到云桥后置 shellCloud 并持久化；重启时 bootstrapConnection
      // 凭标记+共享库已配对云源自动回云。cloudUIOn() 是云 UI/事件链的统一门（cloudMode 或壳内激活）
      const SHELL_CLOUD_KEY = "cc-deck-005-shell-cloud";
      let shellCloud = false;
      function cloudUIOn() { return cloudMode || shellCloud; }
      const CLOUD_LASTSEQ_KEY = "cc-deck-005-lastseq";     // last_seq 持久化（hello 补发语义仍按旧壳：内存无会话即 0 走全量）
      const SERVERS_KEY = "ccd_servers"; // 与旧壳同源共享（read-shared：读共享库免配对直连；写仅在配对成功后）
      // relay 换 data/cloud-keypair.json 后需同步更新烘焙值并重新部署（与旧壳同源同值）
      const BAKED_RELAY = { rd: "rl-3a9a68c9104f5b44", rk: "OppoyRBPW0QTDZNuDoNnucqgIuPFaAG9YXuVMadJARw=" };
      const BAKED_BRIDGE_TOKEN = "ccdeck-public-9f3k2m7v";
      const BAKED_BRIDGE_URL = "wss://cc.humumu.online/cloud";
      function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
      function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
      function cloudUuid() { return (crypto.randomUUID && crypto.randomUUID()) || ("c" + Date.now() + "-" + Math.random().toString(16).slice(2)); }
      function defaultCloudUrl() {
        // 005 云链仅在 https 形态激活，页面域名即桥域名；防御分支对齐旧壳（tauri/非 http 回落公共桥）
        if (window.__TAURI__ || /tauri\.localhost/i.test(location.host)) return BAKED_BRIDGE_URL;
        return location.protocol.startsWith("http")
          ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/cloud"
          : BAKED_BRIDGE_URL;
      }
      function hostOf(u) { try { return new URL(String(u).replace(/^ws/i, "http")).host; } catch { return u || ""; } }
      function serverBridgeToken(cfg) { return cfg.token || BAKED_BRIDGE_TOKEN; }

      // ---------- 云桥 E2E 密封层（与 relay/src/e2e.ts 同构；nacl 由 /nacl.js 提供；test-005-cloud 按标记抽取直跑） ----------
      const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      function toB64(b) {
        let s = "";
        for (let i = 0; i < b.length; i += 3) {
          const b1 = b[i], b2 = i + 1 < b.length ? b[i + 1] : null, b3 = i + 2 < b.length ? b[i + 2] : null;
          s += B64[b1 >> 2] + B64[((b1 & 3) << 4) | (b2 === null ? 0 : b2 >> 4)];
          s += b2 === null ? "=" : B64[((b2 & 15) << 2) | (b3 === null ? 0 : b3 >> 6)];
          s += b3 === null ? "=" : B64[b3 & 63];
        }
        return s;
      }
      function fromB64(st) {
        const out = []; let bits = 0, acc = 0;
        for (const ch of st.replace(/=+$/, "")) {
          const v = B64.indexOf(ch);
          if (v < 0) throw new Error("bad base64");
          acc = (acc << 6) | v; bits += 6;
          if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
        }
        return new Uint8Array(out);
      }
      function genKp() {
        const kp = nacl.box.keyPair();
        return { publicKey: toB64(kp.publicKey), secretKey: toB64(kp.secretKey) };
      }
      function devId(pk, prefix) {
        return prefix + "-" + [...fromB64(pk).slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
      }
      function seal(obj, theirPk, mySk) {
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const c = nacl.box(new TextEncoder().encode(JSON.stringify(obj)), nonce, fromB64(theirPk), fromB64(mySk));
        return { n: toB64(nonce), c: toB64(c) };
      }
      function unseal(box, theirPk, mySk) {
        const opened = nacl.box.open(fromB64(box.c), fromB64(box.n), fromB64(theirPk), fromB64(mySk));
        return opened ? JSON.parse(new TextDecoder().decode(opened)) : null;
      }
      // ---------- 云桥 E2E 密封层结束 ----------

      let ckp = null; // 本浏览器固定 box 密钥对（跨壳共用 ccr_cloud_kp：旧壳已配对 → 同一设备身份）
      function loadCloudIdentity() {
        try { ckp = JSON.parse(localStorage.getItem("ccr_cloud_kp") || sessionStorage.getItem("ccr_cloud_kp") || "null"); } catch { ckp = null; }
        if (!ckp || !ckp.publicKey || !ckp.secretKey) {
          ckp = genKp();
          try { sessionStorage.setItem("ccr_cloud_kp", JSON.stringify(ckp)); } catch {}
          lsSet("ccr_cloud_kp", JSON.stringify(ckp));
        }
      }

      // ---------- 共享身份 read-shared（决策 1：读 ccd_servers/ccr_cloud_kp 与旧壳互通；写仅配对成功后） ----------
      // 返回：数组（正常/无记录）或 null（有内容但损坏——宁可不写，绝不覆盖旧壳数据）
      function readSharedServersRaw() {
        const parse = (s) => { if (!s) return undefined; try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; } };
        let ls = undefined;
        try { ls = parse(localStorage.getItem(SERVERS_KEY)); } catch {}
        if (Array.isArray(ls)) return ls;
        let ss = undefined;
        try { ss = parse(sessionStorage.getItem(SERVERS_KEY)); } catch {}
        if (Array.isArray(ss)) return ss; // 硬刷新兜底：localStorage 被清时 sessionStorage 同源冗余恢复（旧壳同口径）
        try { if (localStorage.getItem(SERVERS_KEY)) return null; } catch {}
        return [];
      }
      function writeSharedServers(list) {
        try { localStorage.setItem(SERVERS_KEY, JSON.stringify(list)); } catch {}
        try { sessionStorage.setItem(SERVERS_KEY, JSON.stringify(list)); } catch {}
      }
      let cloudStoreWarned = false;
      // 配对成功落库：只 append/更新自己的云源条目（按 id+kind 匹配），绝不删条目、绝不碰 lan 源
      function cloudPersistPaired(cfg) {
        if (!cfg || cfg.kind !== "cloud" || !cfg.cloud || !cfg.cloud.paired) return;
        lsSet(ACTIVE_CLOUD_KEY, cfg.id);
        const list = readSharedServersRaw();
        if (list === null) {
          if (!cloudStoreWarned) { cloudStoreWarned = true; console.warn("[cloud] 共享源列表损坏，跳过写入（保护既有数据）"); }
          return;
        }
        const entry = { id: cfg.id, name: cfg.name || "云桥", kind: "cloud", wsUrl: cfg.wsUrl,
          token: cfg.token || BAKED_BRIDGE_TOKEN,
          cloud: { url: cfg.wsUrl, token: cfg.token || BAKED_BRIDGE_TOKEN, rd: cfg.cloud.rd, rk: cfg.cloud.rk, paired: true } };
        const i = list.findIndex((s) => s && s.id === entry.id && s.kind === "cloud");
        if (i >= 0) list[i] = entry; else list.push(entry);
        writeSharedServers(list);
      }
      function cloudSharedCloudServers() { return (readSharedServersRaw() || []).filter((s) => s && s.id && s.kind === "cloud"); }

      // ---------- W-SDEL 服务器条目管理（用户 1013 反馈：删掉失效服务器条目重连——旧壳 deleteServer 移植） ----------
      // cloudPersistPaired 只管配对落写（绝不删条目）；删除/编辑/激活切换在此补全——读写同库同键，
      // 损坏保护同口径（readSharedServersRaw 返回 null 绝不写）。纯逻辑内核拆 sdel* 无 DOM 函数（test-005-servers 直跑锚）。
      function sdelRemoveFromList(list, id) { return (list || []).filter((s) => !(s && s.id === id && s.kind === "cloud")); }
      function sdelPatchEntry(cur, patch) {
        const wsUrl = String(patch.wsUrl || cur.wsUrl || "").trim().replace(/\/+$/, "");
        const name = String(patch.name || "").trim() || cur.name || "云桥";
        const token = String(patch.token || "").trim();
        const addrChanged = !!wsUrl && !!cur.wsUrl && wsUrl !== cur.wsUrl;
        const cloud = cur.cloud && typeof cur.cloud === "object" ? Object.assign({}, cur.cloud) : null;
        if (cloud) {
          if (wsUrl) cloud.url = wsUrl;
          if (token) cloud.token = token;
          // 地址变更=换桥：配对身份重置（旧壳 saveSrvBtn 编辑分支同语义——保 rd/rk 仅限同地址）
          if (addrChanged) { cloud.rd = BAKED_RELAY.rd; cloud.rk = BAKED_RELAY.rk; cloud.paired = false; }
        }
        return { entry: { id: cur.id, name, kind: "cloud", wsUrl: wsUrl || cur.wsUrl || "", token: token || cur.token || "", cloud }, addrChanged };
      }
      function sharedCloudEntryOf(id) { return cloudSharedCloudServers().find((s) => s.id === id) || null; }
      // 删除语义=忘掉该源：共享库条目移除（凭据一并清）+ 配对挂起清 + 当前连接源断链防拉回。
      // 返回 true=已删；false=库损坏保护跳过。二次确认门在 UI 层（deleteCloudServerUI）。
      function removeSharedCloudServer(id) {
        const list = readSharedServersRaw();
        if (list === null) return null; // 共享源列表损坏：宁可不写（cloudPersistPaired 同口径）
        const next = sdelRemoveFromList(list, id);
        if (next.length === list.length) return next; // 无此条目：幂等
        writeSharedServers(next);
        return next;
      }
      function updateSharedCloudServer(id, patch) {
        const list = readSharedServersRaw();
        if (list === null) return null;
        const i = list.findIndex((s) => s && s.id === id && s.kind === "cloud");
        if (i < 0) return { list, entry: null, addrChanged: false };
        const r = sdelPatchEntry(list[i], patch || {});
        list[i] = r.entry;
        writeSharedServers(list);
        return { list, entry: r.entry, addrChanged: r.addrChanged };
      }
      // 删除的运行时收口：删的是当前连接源时——断链（cloudDisconnect 掐 pollGen/pairTimer/ping/
      // reconnect/hs/disc 全套定时器）+ 内存 cfg 重置/回退（防 cloudManualRetry 与 visibilitychange
      // 把已删地址拉回重连——拉活链第②④条的内存锚就在 cloudCtx.cfg）。
      function deleteCloudServer(id) {
        const relayName = String(cloudCtx.relayName || "");
        const wasOnline = cloudCtx.cfg && cloudCtx.cfg.id === id && cloudCtx.status === "online";
        const next = removeSharedCloudServer(id);
        if (next === null) { showToast("源列表数据损坏，已跳过写入（保护既有数据）"); return false; }
        setPendingPair(id, null); // 配对挂起一并清（旧壳 deleteServer 同口径）
        // 改名 override 清理：override 键=原始 relay_name，仅在线源可映射；离线死条目无映射，留档无害（显示层 map miss 不生效）
        if (wasOnline && relayName && !/^(tauri\.localhost|localhost|127\.0\.0\.1)(:|$)/.test(relayName)) setSourceNameOverride(relayName, "");
        if (cloudCtx.cfg && cloudCtx.cfg.id === id) {
          cloudDisconnect();
          cloudCtx.sessions.clear(); cloudCtx.hasSnapshot = false; cloudCtx.lastSeq = 0;
          const rest = (next || []).filter((s) => s && s.cloud && s.cloud.paired && s.cloud.rd && s.cloud.rk);
          if (rest.length) {
            // 回退下一条已配对源并自动重连（旧壳 deleteServer 回退 servers[0] 同语义）
            const hit = rest.find((s) => s.id === lsGet(ACTIVE_CLOUD_KEY)) || rest[0];
            lsSet(ACTIVE_CLOUD_KEY, hit.id);
            cloudCtx.cfg = { id: hit.id, name: hit.name || "云桥", kind: "cloud", wsUrl: hit.wsUrl || "", token: hit.token || BAKED_BRIDGE_TOKEN, cloud: Object.assign({}, hit.cloud) };
            if (cloudMode || shellCloud) bootstrapCloud(); // boot 内部按 ACTIVE 重选（=刚设的 hit，双保险同结果）并重连
          } else {
            // 删空：视角回本机；cfg 落空模板（源菜单回「＋ 添加服务器」兜底态；boot 回连条件
            //「共享库尚有 paired 云源」随删空自然失效，SHELL_CLOUD_KEY 不必强清）
            try { localStorage.removeItem(ACTIVE_CLOUD_KEY); } catch {}
            cloudCtx.cfg = { id: cloudUuid(), name: "云桥", kind: "cloud", wsUrl: "", token: "", cloud: null };
            if (!cloudMode && typeof setSourceView === "function") setSourceView("local");
          }
        }
        replaySnapshots(); renderSessionList(); renderCloudUI(); refreshSourceSwitchers();
        try { window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive(); } catch {}
        return true;
      }
      // 切换连接：选中哪条源就连哪台（旧壳点行设活动源语义）。ACTIVE_CLOUD_KEY 先行，再断当前
      // 云链换 cfg 重连——switchToCloudSource 仅首启 bootstrap，已激活态需显式换 cfg（见上删除链同款）。
      function activateCloudServer(id) {
        const hit = sharedCloudEntryOf(id);
        if (!hit) return;
        lsSet(ACTIVE_CLOUD_KEY, id);
        if (!(cloudCtx.cfg && cloudCtx.cfg.id === id && cloudCtx.status === "online")) {
          cloudDisconnect();
          cloudCtx.sessions.clear(); cloudCtx.hasSnapshot = false; cloudCtx.lastSeq = 0;
          cloudCtx.cfg = { id: hit.id, name: hit.name || "云桥", kind: "cloud", wsUrl: hit.wsUrl || "", token: hit.token || BAKED_BRIDGE_TOKEN, cloud: Object.assign({}, hit.cloud || {}) };
          if (cloudMode) connectCloudFor(cloudCtx, false);
          else if (shellCloud) bootstrapCloud();
          else { switchToCloudSource(false); } // 壳/LAN 形态首启云链（内部 bootstrap 按 ACTIVE 选中并切视角）
        }
        if (!cloudMode && typeof setSourceView === "function" && viewSource() !== "cloud") setSourceView("cloud");
        renderCloudUI(); refreshSourceSwitchers();
        try { window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive(); } catch {}
        showToast("已切换到 " + (hit.name || hostOf(hit.wsUrl) || "云桥"));
      }

      // ---------- 单活动云源运行时上下文（005 单源模型；字段口径=旧壳 ensureCtx 云链子集） ----------
      const cloudCtx = {
        cfg: { id: "", name: "云桥", kind: "cloud", wsUrl: "", token: "", cloud: null },
        status: "offline", statusText: "未连接", failKind: "", retryAt: 0, retryNote: "",
        sessions: new Map(), lastSeq: 0, hasSnapshot: false, relayName: location.host,
        ws: null, reconnectDelay: CLOUD_RETRY_BASE_MS, reconnectTimer: 0,
        pendingPair: null, pairTimer: 0, pingTimer: null, lastPong: 0,
        pairNextAt: 0, pairBackoffMs: 0, // 配对退避：看门狗耗尽后指数退避（30s 起 15min 封顶），输码/成功即清零
        transport: "ws", pollGen: 0, pollSid: "", pollBase: "",
        wsFails: 0, postFails: 0, hsTimer: 0, discTried: false, discTimer: 0, _everOnline: false,
      };
      function cloudPeerOf(cfg) {
        const c = cfg.cloud;
        return c && c.paired && c.rd && c.rk ? { relay_dev: c.rd, relay_pubkey: c.rk } : null;
      }
      // 配对中的一次性凭据（配对链接/输码落下的），按源隔离存 sessionStorage（键与旧壳同构）
      function pendingPairOf(id) { try { return JSON.parse(sessionStorage.getItem("ccd_pair_" + id) || "null"); } catch { return null; } }
      function setPendingPair(id, pair) {
        try {
          if (pair) sessionStorage.setItem("ccd_pair_" + id, JSON.stringify(pair));
          else sessionStorage.removeItem("ccd_pair_" + id);
        } catch {}
      }
      // 配对态被否定（nack/换代）：清记忆身份，rd/rk 回落烘焙值——005 仅改内存不回写共享库
      //（写纪律：共享库只在配对成功时落写；换代否定由下次成功配对覆盖，旧壳条目至多滞留旧身份）
      function resetCloudPairing(cfg) {
        cfg.cloud = { url: cfg.wsUrl, token: serverBridgeToken(cfg), rd: BAKED_RELAY.rd, rk: BAKED_RELAY.rk, paired: false };
      }

      // 云形态命令面 shim：伪装地基主连接的窄接口（readyState/send/close）。B2 sendCmd、B4
      // bridge.sendCommand、Team sendCommand 都按 __ccDeck005MainWs / ctx.ws 的 readyState===1
      // 判可用——shim 在云在线时动态回 1，send 走 sendCloud 密封上行；ACK 不锚本 socket，
      // 从帧总线按 command_id 回各表结算（缝合点 c：按源路由 + 防串台）
      const cloudCmdShim = {
        get readyState() { return cloudCtx.status === "online" ? 1 : 0; },
        onopen: null, onclose: null, onmessage: null, onerror: null,
        send(str) {
          let obj = null;
          try { obj = JSON.parse(str); } catch { return; }
          if (!obj || typeof obj !== "object") return;
          sendCloud(cloudCtx, obj);
        },
        close() {},
      };

      // 每源状态落点（旧壳 setConn 云链版）：状态/归因 + B3 通道开关 + 总线 ws 事件 + 地基徽标 + 云 UI
      function cloudSetConn(status, text, kind) {
        cloudCtx.status = status;
        cloudCtx.statusText = text;
        // 失败归因（仅 offline 携带）：transport（自动+手动重试，绝不引导输码）/ unpaired（真未配对，
        // 引导输码）/ pair（配对受挫，换码）/ bridge（桥不可达，诊断文案保留为重试前缀）/ none
        cloudCtx.failKind = status === "offline" ? (kind || classifyCloudFail(text)) : "";
        if (status !== "connecting") { cloudCtx.retryAt = 0; cloudCtx.retryNote = ""; }
        if (status === "online") {
          cloudCtx._everOnline = true;
          syncTeamBind(); // 云在线：B3 命令通道按视角统一绑定（W-WINPAIR-R2：云视角才真正放行）
        } else if (status === "offline") {
          syncTeamBind(); // 离线三态完备（对齐 connectLan onclose 口径）；W-WINPAIR-R2 统一按视角源
        }
        window.__ccDeck005Frames.emit({ kind: "ws", state: status === "online" ? "open" : status === "connecting" ? "connecting" : "close", source: "cloud" }); // 缝合点 b；W-WINPAIR-R2 带源标记
        setConn(cloudCtx, status, text, cloudCtx.failKind); // 地基三态徽标/chip/会话列表占位
        renderCloudUI();
      }

      function connectCloudFor(ctx, manual) { // ctx 恒为 cloudCtx（005 单源；参数保留旧壳签名）
        const cfg = ctx.cfg;
        const base = cfg.wsUrl;
        if (!base) { ctx.status = "offline"; ctx.statusText = "未配置"; ctx.failKind = "none"; renderCloudUI(); return; }
        loadCloudIdentity();
        const peer = cloudPeerOf(cfg);
        const pair = ctx.pendingPair || pendingPairOf(cfg.id);
        ctx.pendingPair = pair;
        if (!peer && !pair) {
          // 明确无身份（新装/被清）：未配对态出配对 UI（手动触发时引导输码）
          cloudSetConn("offline", "未配对", "unpaired");
          if (manual) { showToast("请输入配对码配对（电脑端 CC Deck 设置 → relay 页领取）"); openCloudPairUI(); }
          return;
        }
        const dev = devId(ckp.publicKey, "wb");
        ctx.pollGen++;                 // 掐掉旧轮询循环（若有）
        clearInterval(ctx.pairTimer);
        ctx.discTried = false;         // 发现帧预算按连接重置
        clearTimeout(ctx.discTimer); ctx.discTimer = 0;
        clearTimeout(ctx.reconnectTimer); ctx.reconnectTimer = 0;
        try { ctx.ws && ctx.ws.close(); } catch {}
        ctx.ws = null;
        cloudSetConn("connecting", peer && !pair ? "连接中" : "配对中");
        if (ctx.transport === "poll") { startPollTransport(ctx, base, serverBridgeToken(cfg), dev, pair); return; }
        // 手填 https://…/cloud 也能连：统一归一到 ws/wss scheme（https 页面恒 wss——混合内容硬约束）
        const wsBase = base.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
        const url = wsBase + (wsBase.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(serverBridgeToken(cfg)) +
          "&dev=" + encodeURIComponent(dev);
        let opened = false;
        const w = new WebSocket(url);
        ctx.ws = w;
        // 握手看门狗：公司代理可能把升级请求挂起不答（onopen/onclose 都不来），8s 强制降级长轮询
        let switched = false;
        const switchToPoll = (why) => {
          if (switched) return;
          if (ctx !== cloudCtx) return;
          switched = true;
          ctx.transport = "poll";
          console.log("[cloud:" + cfg.name + "] 切换 HTTP 轮询传输:", why);
          showToast("WebSocket 被网络拦截，已切换 HTTP 轮询");
          connectCloudFor(ctx, manual);
        };
        clearTimeout(ctx.hsTimer);
        ctx.hsTimer = setTimeout(() => {
          ctx.hsTimer = 0;
          if (!opened) {
            try { ctx.ws && ctx.ws.close(); } catch {}
            switchToPoll("握手 8s 无响应");
          }
        }, 8000);
        w.onopen = () => {
          if (ctx.ws !== w) return;
          opened = true;
          clearTimeout(ctx.hsTimer); ctx.hsTimer = 0;
          ctx.reconnectDelay = CLOUD_RETRY_BASE_MS; // 连上即归零退避
          if (!peer || pair) {
            if (pair && pair.pc === "" && !ctx.discTried) { ctx.discTried = true; discoverRelay(ctx); } // 空码信标态预取发现帧（路径保留，005 无 QR UI 不会走到）
            // 配对退避：窗内不发也不起看门狗（无尝试即无耗尽——否则每轮重连空转照样耗尽刷屏）
            if (pair.pc === "" || Date.now() >= (ctx.pairNextAt || 0)) {
              sendPairReq(ctx, pair, dev);
              startPairWatchdog(ctx);
            }
            return;
          }
          cloudSetConn("online", ctx.transport === "poll" ? "已连接（轮询）" : "已连接");
          // 刷新后内存无会话：last_seq=0 走全量 SNAPSHOT 重建（持久化旧 seq 只会造成空列表；
          // SNAPSHOT 单帧携带预算内日志，1MiB 帧限由 relay 侧有界化，页面不自建拉全量逻辑）
          sendCloud(ctx, { t: "hello", last_seq: ctx.sessions.size > 0 ? ctx.lastSeq : 0 });
          startCloudPing(ctx);
        };
        w.onclose = (ev) => {
          if (ctx.ws !== w) return;
          clearTimeout(ctx.hsTimer); ctx.hsTimer = 0;
          console.log("[cloud:" + cfg.name + "] ws 断开 code=" + ev.code);
          if (switched) return;
          if (!opened) { switchToPoll("握手被拒 code=" + ev.code); return; }
          ctx.wsFails++; // 连上又断且一帧未收 → 疑似代理放行握手后掐连接
          if (ctx.wsFails >= 2) { switchToPoll("ws 反复闪断 x" + ctx.wsFails); return; }
          cloudSetConn("offline", "已断开", "transport"); // 传输层失败，不引导配对码
          scheduleCloudReconnect(ctx);
        };
        w.onerror = () => {};
        w.onmessage = (ev) => onCloudText(ctx, ev.data);
      }

      // pair_req 明文帧（relay 校验 code 后回密封 pair_ack；已配对设备发错码也幂等补 ack）。
      // #29（C-P0-1）现行口径：带码帧携 pubkey（码即信任锚，relay 凭码采信随帧公钥密封 ack），
      // 空码信标绝不携带 pubkey。#42 web 侧自报 UA 摘要（relay 存信任清单，管理卡可辨）
      function sendPairReq(ctx, pair, dev) {
        const body = { t: "pair_req", code: pair.pc, name: "web-" + dev.slice(3, 11) };
        if (pair.pc) body.pubkey = ckp.publicKey;
        try {
          const ua = navigator.userAgent;
          const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "浏览器";
          const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
          const m = (br + " " + (ua.match(/(?:Edg|Chrome|Firefox)\/(\d+)/)?.[1] || "")).trim() + "·" + os;
          body.meta = { platform: m.slice(0, 120), ua: ua.slice(0, 120) };
        } catch {}
        sendCloudRaw(ctx, JSON.stringify({ to: pair.rd || "*", data: pair.rd ? body : Object.assign({ bc: true }, body) }));
      }
      // 发现帧：桥回 {type:"RELAYS", relays:[{dev,rk}]}（在线 relay 列表；relay 换 keypair 后自愈用）
      function discoverRelay(ctx) { sendCloudRaw(ctx, JSON.stringify({ to: "*", data: { t: "disc" } })); }
      // pair_ack 可能随桥连接闪断一起丢失（relay 侧已幂等补 ack）：8s 无应答重发。
      // 已配对身份存在不等于配对成功——可能是换代前的旧配对残留，必须对比 dev 号变化
      function startPairWatchdog(ctx) {
        clearInterval(ctx.pairTimer);
        let tries = 0;
        const peerBefore = cloudPeerOf(ctx.cfg)?.relay_dev || "";
        ctx.pairTimer = setInterval(() => {
          const peer = cloudPeerOf(ctx.cfg);
          if ((peer && peer.relay_dev !== peerBefore) || ++tries > 3) {
            clearInterval(ctx.pairTimer);
            if (peer && peer.relay_dev !== peerBefore) {
              // 配对成功（新身份到手）：清配对退避——下次配对满速开始
              ctx.pairNextAt = 0; ctx.pairBackoffMs = 0;
              return;
            }
            // 耗尽无新身份：offline + 退避重连，不能静默 return——否则状态永久卡「配对中」
            const bcMiss = ctx.pendingPair && !ctx.pendingPair.rd; // 广播态：码没找到持码者
            cloudSetConn("offline", bcMiss ? "未找到持码服务器" : "配对无应答", "pair");
            scheduleCloudReconnect(ctx);
            showToast("配对请求一直没回音：按 F12 看 Console 的 [cloud] 日志和 Network 里 cloud-poll 请求，截图备查");
            console.log("[cloud:" + ctx.cfg.name + "] 配对看门狗耗尽：pair_req 已重发 3 次无 pair_ack");
            // 配对退避推进：耗尽一轮指数退避一轮，封顶 15 分钟；relay 回线后最迟一个退避窗内自动续上
            ctx.pairBackoffMs = Math.min(ctx.pairBackoffMs ? ctx.pairBackoffMs * 2 : 30_000, 900_000);
            ctx.pairNextAt = Date.now() + ctx.pairBackoffMs;
            return;
          }
          const pair = ctx.pendingPair || pendingPairOf(ctx.cfg.id);
          if (!pair) { clearInterval(ctx.pairTimer); return; }
          if (pair.pc && Date.now() >= (ctx.pairNextAt || 0)) sendPairReq(ctx, pair, devId(ckp.publicKey, "wb"));
        }, 8000);
      }

      // HTTP 长轮询传输（公司代理掐 WS 的降级路）：POST /cloud-poll 上行，GET &wait=20 挂着收下行
      function startPollTransport(ctx, base, token, dev, pair) {
        clearTimeout(ctx.reconnectTimer); ctx.reconnectTimer = 0; // 挂起的重连定时器会二次 connect 踢掉新连接
        const httpBase = base.replace(/^ws:\/\//i, "http://").replace(/^wss:\/\//i, "https://").replace(/\/cloud\/?$/, "");
        ctx.pollSid = cloudUuid();
        ctx.pollBase = httpBase + "/cloud-poll?token=" + encodeURIComponent(token) +
          "&dev=" + encodeURIComponent(dev) + "&sid=" + ctx.pollSid;
        ctx.reconnectDelay = CLOUD_RETRY_BASE_MS; // 连上即归零退避
        const peer = cloudPeerOf(ctx.cfg);
        if (!peer || pair) {
          cloudSetConn("connecting", "配对中（轮询）");
          if (pair && pair.pc === "" && !ctx.discTried) { ctx.discTried = true; discoverRelay(ctx); }
          if (pair.pc === "" || Date.now() >= (ctx.pairNextAt || 0)) {
            sendPairReq(ctx, pair, dev);
            startPairWatchdog(ctx);
          }
        } else {
          cloudSetConn("online", "已连接（轮询）");
          sendCloud(ctx, { t: "hello", last_seq: ctx.sessions.size > 0 ? ctx.lastSeq : 0 });
          startCloudPing(ctx);
        }
        pollLoop(ctx); // 收包循环必须一直在跑：配对 ack / hello 回包都从它进
      }

      async function pollLoop(ctx) {
        const gen = ctx.pollGen;
        let netFails = 0;
        while (gen === ctx.pollGen) {
          let r;
          try { r = await fetch(ctx.pollBase + "&wait=20", { signal: AbortSignal.timeout?.(30000) }); }
          catch (e) {
            if (gen !== ctx.pollGen) return;
            if (++netFails >= 3) { cloudSetConn("connecting", "网络不通，重试中"); console.log("[cloud:" + ctx.cfg.name + "] 轮询 GET 失败 x" + netFails + ":", e && e.message); }
            await new Promise((res) => setTimeout(res, 4000));
            continue;
          }
          if (gen !== ctx.pollGen) return;
          if (!r.ok) {
            console.log("[cloud:" + ctx.cfg.name + "] 轮询 GET HTTP " + r.status);
            // 401 自愈一次：自定义桥 token 失效丢弃后回退烘焙值重建；烘焙值也被拒才是真换代
            if (r.status === 401) {
              if (ctx.cfg.token && ctx.cfg.token !== BAKED_BRIDGE_TOKEN) {
                console.log("[cloud:" + ctx.cfg.name + "] 401：丢弃本地桥 token，回退烘焙值重试");
                ctx.cfg.token = BAKED_BRIDGE_TOKEN;
                if (ctx.cfg.cloud) ctx.cfg.cloud.token = BAKED_BRIDGE_TOKEN;
                ctx.pollGen++;
                ctx.transport = "ws"; // 重走 WS 优先（之前可能因坏 token 降级过轮询）
                connectCloudFor(ctx, false);
                return;
              }
              cloudSetConn("offline", "云桥拒绝", "bridge"); showToast("云桥 token 无效（页面烘焙值也被拒）：桥已换代，需更新页面");
            }
            break; // 其余 401/400：回到重连流程重建会话
          }
          let out;
          try { out = await r.json(); } catch { break; }
          if (gen !== ctx.pollGen) return;
          netFails = 0;
          if (out.frames && out.frames.length) console.log("[cloud:" + ctx.cfg.name + "] 轮询收到", out.frames.length, "帧");
          for (const f of out.frames || []) onCloudText(ctx, f);
          if (out.closed) { console.log("[cloud:" + ctx.cfg.name + "] 轮询会话被关闭（顶替/超时），重建"); break; }
        }
        // 诊断态不覆写成通用断开文案：failKind=bridge 的重试带诊断前缀（病因+自愈节奏同屏）
        if (gen === ctx.pollGen) {
          if (ctx.status !== "offline" || ctx.failKind !== "bridge") cloudSetConn("offline", "已断开", "transport");
          scheduleCloudReconnect(ctx);
        }
      }

      // 下行帧统一入口（ws onmessage 与轮询 GET 共用）。帧级异常隔离：任一帧抛异常不杀死
      // pollLoop（async while 循环体抛出无人 catch 会拉取停止而状态仍显已连接）——跳过毒帧留日志
      function onCloudText(ctx, text) {
        try { onCloudTextRaw(ctx, text); }
        catch (e) { console.error("[cloud:" + ctx.cfg.name + "] 帧处理异常（已跳过该帧）:", e, String(text).slice(0, 300)); }
      }

      function onCloudTextRaw(ctx, text) {
        let f;
        try { f = JSON.parse(text); } catch { return; }
        const cfg = ctx.cfg;
        if (f.type === "ROUTE_MISS") {
          // 配对期 ROUTE_MISS：待配对 rd 不在线——本源记忆的 relay 身份失效（relay 换过密钥对）时
          // 清掉，换烘焙 rd/rk 携同一配对码重试（一次性自愈）。广播态（rd 空串）不适用
          const pair = ctx.pendingPair || pendingPairOf(cfg.id);
          if (pair && pair.pc === "") return; // 空码信标态对 ROUTE_MISS 一律静默
          if (pair && pair.rd && BAKED_RELAY.rd && BAKED_RELAY.rd !== pair.rd) {
            resetCloudPairing(cfg);
            ctx.pendingPair = { rd: BAKED_RELAY.rd, rk: BAKED_RELAY.rk, pc: pair.pc };
            setPendingPair(cfg.id, ctx.pendingPair);
            console.log("[cloud:" + cfg.name + "] 配对 ROUTE_MISS，改用烘焙 relay 身份重试");
            if (ctx.pendingPair.pc && Date.now() >= (ctx.pairNextAt || 0)) {
              sendPairReq(ctx, ctx.pendingPair, devId(ckp.publicKey, "wb"));
              startPairWatchdog(ctx); // 重置看门狗：换 rd 重试不与旧 rd 共享 3 次预算
            }
            return;
          }
          // 烘焙值也失配（relay 换 keypair 后 rd 全部过期）：发发现帧向桥要在线 relay 列表自愈
          if (!ctx.discTried) {
            ctx.discTried = true;
            cloudSetConn("connecting", "定位 relay…");
            console.log("[cloud:" + cfg.name + "] ROUTE_MISS，发送发现帧定位在线 relay");
            discoverRelay(ctx);
            clearTimeout(ctx.discTimer);
            ctx.discTimer = setTimeout(() => {
              ctx.discTimer = 0;
              if (ctx.status !== "connecting") return;
              clearInterval(ctx.pairTimer);
              cloudSetConn("offline", "电脑端 relay 离线", "bridge"); // 桥可达但 relay 不在：诊断态
              scheduleCloudReconnect(ctx);
            }, 6000);
            return;
          }
          clearInterval(ctx.pairTimer);
          cloudSetConn("offline", "电脑端 relay 离线", "bridge");
          scheduleCloudReconnect(ctx);
          return;
        }
        if (f.type === "RELAYS") {
          // 发现帧回包。公共桥上 rl- 注册无鉴权——假 relay 可混入列表截获 pair_req 里的明文码，
          // 只自动采用：① 可信命中（dev=记忆/烘焙/配对目标）② 列表唯一（无锚点的新配对）。
          // 上报 rk 的条目必须自洽（dev === devId(rk,"rl")，公钥前 8 字节派生）——顶替者冒真 dev
          // 上报假 rk 会在源头剔除；无 rk 条目=旧版 relay，rk 回落记忆真值
          clearTimeout(ctx.discTimer); ctx.discTimer = 0;
          const all = (Array.isArray(f.relays) ? f.relays : [])
            .filter((x) => x && typeof x.dev === "string" && x.dev.startsWith("rl-"))
            .filter((x) => !x.rk || (typeof x.rk === "string" && devId(x.rk, "rl") === x.dev));
          const pair = ctx.pendingPair || pendingPairOf(cfg.id);
          const peer = cloudPeerOf(cfg);
          const known = [pair && pair.rd, peer && peer.relay_dev, cfg.cloud && cfg.cloud.rd, BAKED_RELAY.rd]
            .filter((x) => x && typeof x === "string");
          const hit = all.find((x) => known.includes(x.dev));
          // 「列表唯一=换代新身份」只服务无锚点的新配对；流程携带 rd 锚（配对链接/输码携记忆身份）
          // 时禁止被唯一在线者覆盖——假 relay 注册成唯一在线即被当「换代」采信
          const anchored = !!(pair && pair.rd);
          const pick = hit || (!anchored && all.length === 1 ? all[0] : null);
          if (!pick) {
            // 输码态 + 多台在线且无可信锚点：配对码即定位凭据——改广播 pair_req，候选公钥逐个试解
            if (pair && pair.pc && all.length > 1) {
              ctx.pendingPair = { rd: "", rk: "", pc: pair.pc, bc: true, cands: all.filter((x) => x.rk) };
              setPendingPair(cfg.id, ctx.pendingPair);
              console.log("[cloud:" + cfg.name + "] 多 relay 无锚点，转配对码广播定位（候选 " + all.length + " 台）");
              cloudSetConn("connecting", "定位持码服务器…");
              if (Date.now() >= (ctx.pairNextAt || 0)) {
                sendPairReq(ctx, ctx.pendingPair, devId(ckp.publicKey, "wb"));
                startPairWatchdog(ctx);
              }
              return;
            }
            clearInterval(ctx.pairTimer);
            cloudSetConn("offline", all.length > 1 ? "发现多个 relay，请重新领码" : "电脑端 relay 离线", all.length > 1 ? "pair" : "bridge");
            scheduleCloudReconnect(ctx);
            return;
          }
          if (pair) {
            // 配对期：rk 空回落记忆值（旧 relay），dev/rk 有变即换代——换身份携同码重发
            const rk = pick.rk || pair.rk;
            if (pick.dev !== pair.rd || rk !== pair.rk) {
              ctx.pendingPair = { rd: pick.dev, rk, pc: pair.pc, fresh: true };
              setPendingPair(cfg.id, ctx.pendingPair);
              console.log("[cloud:" + cfg.name + "] 发现 relay 身份 " + pick.dev + "，重发配对请求");
            } else {
              console.log("[cloud:" + cfg.name + "] relay " + pick.dev + " 已回在线，重发配对请求");
            }
            cloudSetConn("connecting", "配对中");
            ctx.pairNextAt = 0; ctx.pairBackoffMs = 0; // relay 确认回在线：清退避满速重试
            if (ctx.pendingPair.pc) sendPairReq(ctx, ctx.pendingPair, devId(ckp.publicKey, "wb"));
            startPairWatchdog(ctx);
            return;
          }
          if (peer && peer.relay_dev === pick.dev) {
            // 已配对运行中吃 ROUTE_MISS 多为桥闪断竞态：relay 实际在线，重发 hello 恢复
            cloudSetConn("online", ctx.transport === "poll" ? "已连接（轮询）" : "已连接");
            sendCloud(ctx, { t: "hello", last_seq: ctx.sessions.size > 0 ? ctx.lastSeq : 0 });
            startCloudPing(ctx);
            return;
          }
          // 在线 relay 与已配对身份不符 = relay 换代：更新记忆身份（仅内存，等用户重新领码）
          cfg.cloud = { url: cfg.wsUrl, token: serverBridgeToken(cfg), rd: pick.dev, rk: pick.rk || BAKED_RELAY.rk, paired: false };
          clearInterval(ctx.pairTimer);
          cloudSetConn("offline", "未配对（relay 已换代）", "unpaired");
          return;
        }
        if (f.type === "ERROR") return;
        // 明文帧：relay 发现本设备未配对/密钥失效时回的 pair_nack（它不知道我方公钥、无法加密）
        if (f.data && !f.data.n) {
          if (f.data.t === "pair_nack") {
            clearInterval(ctx.pairTimer); ctx.pairTimer = 0;
            stopCloudPing(ctx);
            setPendingPair(cfg.id, null);
            ctx.pendingPair = null;
            resetCloudPairing(cfg);
            cloudSetConn("offline", "未配对", "unpaired"); // relay 明确否认身份：引导输码
            showToast("请输入配对码重新配对（电脑端 CC Deck 设置 → relay 页领取）");
            console.log("[cloud:" + cfg.name + "] relay 判定未配对:", f.data.error);
            discoverRelay(ctx); // relay 在线才回得出 nack：顺手刷新真实身份，输码直达省一轮往返
            openCloudPairUI();
          }
          return;
        }
        if (!f.data) return;
        // 配对期优先 pendingPair.rk：已配对身份可能是换代前旧公钥。广播态 rk 未知：拿发现候选逐个试解
        const target = ctx.pendingPair || pendingPairOf(cfg.id);
        const senderPk = target ? target.rk : (cloudPeerOf(cfg)?.relay_pubkey || "");
        let inner = null;
        if (senderPk) inner = unseal(f.data, senderPk, ckp.secretKey);
        if (!inner) {
          // 兜底试解：主锚解不开时依次尝试已配对身份与发现候选（回传由对端源 relay 密封，未必与出码锚一致）
          const alt = cloudPeerOf(cfg)?.relay_pubkey;
          if (alt && alt !== senderPk) inner = unseal(f.data, alt, ckp.secretKey);
          if (!inner && target && target.cands) {
            for (const cand of target.cands) {
              if (cand.rk === senderPk || cand.rk === alt) continue;
              inner = unseal(f.data, cand.rk, ckp.secretKey);
              if (inner) break;
            }
          }
        }
        if (!inner) return;
        ctx.wsFails = 0; // 收到有效密封帧 = 传输链路健康
        if (inner.t === "pair_ack") {
          clearInterval(ctx.pairTimer);
          // ack 身份必须对应当次请求目标（零裁剪安全校验）：公共桥上假 relay 可自演自唱（自有密钥
          // 解得开），采信错位身份会把后续 seal 永久指向攻击者公钥。输码态必比对 rd；广播态
          //（rd 空串）比对发现候选列表——候选外 ack=身份未锚定，丢弃
          if (target && target.rd && inner.relay_dev !== target.rd) {
            console.log("[cloud:" + cfg.name + "] pair_ack 身份错位（" + inner.relay_dev + " ≠ " + target.rd + "），丢弃");
            return;
          }
          if (target && !target.rd && target.cands && !target.cands.some((c) => c.dev === inner.relay_dev)) {
            console.log("[cloud:" + cfg.name + "] pair_ack 来自发现列表之外的 relay（" + inner.relay_dev + "），丢弃");
            return;
          }
          cfg.cloud = { url: cfg.wsUrl, token: serverBridgeToken(cfg), rd: inner.relay_dev, rk: inner.relay_pubkey, paired: true };
          cloudPersistPaired(cfg); // 决策 1：配对成功才落写共享库（旧壳 /app 免配对直连的锚点）
          setPendingPair(cfg.id, null);
          ctx.pendingPair = null;
          cloudSetConn("online", ctx.transport === "poll" ? "已连接（轮询）" : "已连接");
          showToast("配对成功");
          sendCloud(ctx, { t: "hello", last_seq: ctx.sessions.size > 0 ? ctx.lastSeq : 0 });
          startCloudPing(ctx);
          return;
        }
        if (inner.t === "pair_nack") {
          // 广播态的 nack 是噪音：码不归这台 relay 管 ≠ 错码，只有持码者/单播目标才作数
          if (target && !target.rd) return;
          clearInterval(ctx.pairTimer);
          // 码一次性：失败即作废，清掉避免刷新后拿废码反复重试
          setPendingPair(cfg.id, null);
          ctx.pendingPair = null;
          resetCloudPairing(cfg);
          cloudSetConn("offline", "未配对", "unpaired");
          showToast("配对失败：" + (inner.error || "码无效") + "，请重新领码输入");
          openCloudPairUI();
          return;
        }
        if (inner.t === "pong") { ctx.lastPong = Date.now(); return; }
        if (inner.type === "COMMAND_ACK") {
          Team.onAck(inner); // B3 团队域 ACK 结算（不订阅总线，与 connectLan 同口喂给）
          window.__ccDeck005Frames.emit({ kind: "frame", frame: inner, source: "cloud" }); // B2/B4 从总线按 command_id 结算；W-WINPAIR-R2 带源标记
          return;
        }
        if (inner.seq !== undefined) {
          ctx.lastSeq = Math.max(ctx.lastSeq, inner.seq);
          lsSet(CLOUD_LASTSEQ_KEY, String(ctx.lastSeq)); // 决策 3：last_seq 写自有键（hello 语义仍按旧壳）
        }
        onEvent(ctx, inner); // 地基会话聚合 + Team.onFrame（SNAPSHOT 团队字段锚定）
        window.__ccDeck005Frames.emit({ kind: "frame", frame: inner, source: "cloud" }); // 缝合点 b：内层帧进总线（SNAPSHOT/SESSION_*/增量）；W-WINPAIR-R2 带源标记
      }

      // 传输无关的上行：ws 模式直接发；轮询模式 POST（应答/事件走 GET 长轮询回来）
      function sendCloudRaw(ctx, str) {
        if (ctx.transport === "poll") {
          fetch(ctx.pollBase, { method: "POST", body: str, signal: AbortSignal.timeout?.(10000) })
            .then((r) => {
              if (r.ok) { ctx.postFails = 0; return; }
              ctx.postFails++;
              console.log("[cloud:" + ctx.cfg.name + "] 轮询 POST HTTP " + r.status);
              if (r.status === 401) {
                // 与 GET 路径同款自愈：丢弃自定义 token，回退烘焙值重建连接
                if (ctx.cfg.token && ctx.cfg.token !== BAKED_BRIDGE_TOKEN) {
                  console.log("[cloud:" + ctx.cfg.name + "] POST 401：丢弃本地桥 token，回退烘焙值重试");
                  ctx.cfg.token = BAKED_BRIDGE_TOKEN;
                  if (ctx.cfg.cloud) ctx.cfg.cloud.token = BAKED_BRIDGE_TOKEN;
                  ctx.transport = "ws";
                  ctx.pollGen++;
                  connectCloudFor(ctx, false);
                  return;
                }
                cloudSetConn("offline", "云桥拒绝", "bridge"); showToast("云桥 token 无效（页面烘焙值也被拒）：桥已换代，需更新页面"); return;
              }
              if (ctx.postFails >= 3) cloudSetConn("offline", "上行被拦 HTTP " + r.status, "transport");
            })
            .catch((e) => {
              ctx.postFails++;
              console.log("[cloud:" + ctx.cfg.name + "] 轮询 POST 失败 x" + ctx.postFails + ":", e && e.message);
              if (ctx.postFails >= 3) cloudSetConn("offline", "上行请求失败", "transport");
            });
          return true;
        }
        if (!ctx.ws || ctx.ws.readyState !== 1) return false;
        ctx.ws.send(str);
        return true;
      }

      function sendCloud(ctx, obj) {
        const peer = cloudPeerOf(ctx.cfg);
        if (!peer) return false;
        return sendCloudRaw(ctx, JSON.stringify({ to: peer.relay_dev, data: seal(obj, peer.relay_pubkey, ckp.secretKey) }));
      }

      // 应用层心跳：20s 密封 ping + 45s 无 pong 判死；兼作断线自愈（relay 侧 ping-resume 按 last_seq 补发）
      function startCloudPing(ctx) {
        stopCloudPing(ctx);
        ctx.lastPong = Date.now();
        ctx.pingTimer = setInterval(() => {
          if (ctx.status !== "online") return;
          if (Date.now() - ctx.lastPong > 45000) {
            if (ctx.transport === "poll") { ctx.pollGen++; cloudSetConn("offline", "已断开", "transport"); scheduleCloudReconnect(ctx); }
            else { try { ctx.ws && ctx.ws.close(); } catch {} }
            return;
          }
          sendCloud(ctx, { t: "ping", last_seq: ctx.lastSeq });
        }, 20000);
      }
      function stopCloudPing(ctx) { if (ctx.pingTimer) { clearInterval(ctx.pingTimer); ctx.pingTimer = null; } }

      // 回前台立即 resume：后台标签页定时器被节流甚至冻结，20s 心跳发不出去；visibilitychange
      // 不受节流影响——切回标签瞬间补一次 ping-resume（带 last_seq，relay 按需补发），顺带探测
      // 半开连接：8s 无回包即强制重连。断线退避中的源立即重连（退避计时早已失真）
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || !cloudUIOn()) return;
        if (cloudCtx.status === "offline") cloudManualRetry();
        if (cloudCtx.status !== "online") return;
        if (!cloudPeerOf(cloudCtx.cfg) || cloudCtx.pendingPair) return;
        const t0 = Date.now();
        sendCloud(cloudCtx, { t: "ping", last_seq: cloudCtx.sessions.size > 0 ? cloudCtx.lastSeq : 0 });
        setTimeout(() => {
          if (cloudCtx.status !== "online" || document.visibilityState !== "visible" || cloudCtx.lastPong >= t0) return;
          console.log("[cloud:" + cloudCtx.cfg.name + "] 回前台探测 8s 无回包，判定链路死，强制重连");
          if (cloudCtx.transport === "poll") { cloudCtx.pollGen++; cloudSetConn("offline", "已断开", "transport"); scheduleCloudReconnect(cloudCtx); }
          else { try { cloudCtx.ws && cloudCtx.ws.close(); } catch {} }
        }, 8000);
      });

      // 失败归因兜底：调用点漏传 kind 的离线态按文案关键词归类
      function classifyCloudFail(t) {
        const s = t || "";
        if (s.includes("未配置")) return "none";
        if (s.includes("配对") || s.includes("领码")) return "unpaired";
        if (s.includes("云桥") || s.includes("桥") || s.includes("relay")) return "bridge";
        return "transport";
      }
      // 自动重试：3s 起指数退避至 30s 封顶；真未配对不刷重试——5 分钟静默慢速重试（瞬时误判自愈，
      // nack 幂等限频无害），可见文案仍引导输码；桥不可达把诊断文案保留为前缀
      function scheduleCloudReconnect(ctx) {
        const cfg = ctx.cfg;
        if (!cfg.wsUrl) return;
        if (ctx.failKind === "unpaired") {
          if (!ctx.reconnectTimer) ctx.reconnectTimer = setTimeout(() => connectCloudFor(cloudCtx, false), 300_000);
          return;
        }
        const delay = ctx.reconnectDelay || CLOUD_RETRY_BASE_MS;
        ctx.reconnectDelay = Math.min(delay * 2, CLOUD_RETRY_MAX_MS);
        const note = ctx.failKind === "bridge" && ctx.statusText ? ctx.statusText + " · " : "";
        cloudSetConn("connecting", note + "重试中·下次 " + Math.round(delay / 1000) + "s");
        ctx.retryNote = note;
        ctx.retryAt = Date.now() + delay;
        clearTimeout(ctx.reconnectTimer);
        ctx.reconnectTimer = setTimeout(() => connectCloudFor(cloudCtx, false), delay);
      }
      // 手动重试：跳过退避等待立即重连（传输层/桥失败终态与重试等待期可用；真未配对不显示重试钮）
      function cloudManualRetry() {
        cloudCtx.reconnectDelay = CLOUD_RETRY_BASE_MS;
        cloudCtx.retryAt = 0; cloudCtx.retryNote = "";
        connectCloudFor(cloudCtx, false);
      }
      function isCloudRetryable() {
        if (cloudCtx.status === "connecting") return !!cloudCtx.retryAt;
        if (cloudCtx.status !== "offline") return false;
        return cloudCtx.failKind === "transport" || cloudCtx.failKind === "bridge";
      }
      // 重试等待期倒计时（1Hz）：只改文字（chip 文本节点 + 云 UI），不整块重建面板
      setInterval(() => {
        if (!cloudUIOn() || cloudCtx.status !== "connecting" || !cloudCtx.retryAt) return;
        const left = Math.ceil((cloudCtx.retryAt - Date.now()) / 1000);
        if (left <= 0) return; // 归零：重连定时器即将触发，等 connect 翻状态
        const text = (cloudCtx.retryNote || "") + "重试中·下次 " + left + "s";
        if (text === cloudCtx.statusText) return;
        cloudCtx.statusText = text;
        connectionChips.forEach((chip) => {
          const textNode = [...chip.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
          if (textNode) textNode.nodeValue = "云桥 " + text;
        });
        renderCloudUI();
      }, 1000);

      // ---------- 配对入口：8 位码手输 + 配对链接深链 ----------
      function submitPairCode() {
        const input = document.querySelector("[data-cloud-pair-input]");
        const code = String((input && input.value) || "").trim();
        if (input) input.value = "";
        submitPairCodeWith(code, input);
      }
      // W-WINPAIR 拆出带参内核：设置面板输码框与「添加服务器」弹窗同链（弹窗码作实参传入，
      // 不再依赖全局 querySelector——两输入框并存时读错第一个的坑）
      function submitPairCodeWith(code, input) {
        code = String(code || "").trim();
        // 2026-09-09 起签发 8 位码；6 位仍放行（管理员自定义 6 位码过渡兼容）
        if (!/^\d{6,8}$/.test(code)) { showToast("请输入 6-8 位数字配对码"); if (input) input.focus(); return; }
        if (!window.nacl) { showToast("加密组件未加载，请刷新页面重试"); return; }
        loadCloudIdentity();
        const cfg = cloudCtx.cfg;
        const c = cfg.cloud || (cfg.cloud = { url: cfg.wsUrl, token: serverBridgeToken(cfg), rd: BAKED_RELAY.rd, rk: BAKED_RELAY.rk, paired: false });
        // rd/rk 只要有就优先（发现帧刷新的新鲜身份 paired=false 也要用），烘焙值仅兜底
        const src = c.rd && c.rk ? { rd: c.rd, rk: c.rk } : BAKED_RELAY;
        if (!src.rd || !src.rk) { showToast("缺少 relay 信息，请使用配对链接"); return; }
        const pair = { rd: src.rd, rk: src.rk, pc: code };
        setPendingPair(cfg.id, pair);
        cloudCtx.pendingPair = pair;
        cloudCtx.pairNextAt = 0; cloudCtx.pairBackoffMs = 0; // 手动输码=用户意图：清配对退避满速
        if (input) input.value = "";
        connectCloudFor(cloudCtx, true);
      }

      // ---------- 云形态引导（缝合点 a：bootstrapConnection 分流入口） ----------
      function bootstrapCloud() {
        cloudCtx.cfg.wsUrl = cloudCtx.cfg.wsUrl || defaultCloudUrl();
        // nacl.js 加载失败降级（不白屏）：云链停在本态，其余 UI 照常
        if (!window.nacl) {
          cloudSetConn("offline", "加密组件未加载（/nacl.js 被网络拦截），请检查网络后刷新", "transport");
          return;
        }
        loadCloudIdentity();
        cloudCtx.lastSeq = Number(lsGet(CLOUD_LASTSEQ_KEY)) || 0;
        // 配对链接深链：#bt=<桥token>&rd=<relay dev>&rk=<relay 公钥>&pc=<一次性配对码>。参数走
        // fragment（不落服务器日志/Referer），捕获后立即抹掉；目标源仅在配对成功后落写共享库
        const h = new URLSearchParams(location.hash.slice(1));
        if (h.get("pc") && h.get("rd") && h.get("rk")) {
          const url = defaultCloudUrl();
          const bt = h.get("bt") || "";
          const hit = cloudSharedCloudServers().find((s) => !url || s.wsUrl === url);
          if (hit) {
            cloudCtx.cfg = { id: hit.id, name: hit.name || "云桥", kind: "cloud", wsUrl: hit.wsUrl || url,
              token: bt || hit.token || BAKED_BRIDGE_TOKEN,
              cloud: hit.cloud && typeof hit.cloud === "object" ? Object.assign({}, hit.cloud) : null };
          } else {
            cloudCtx.cfg = { id: cloudUuid(), name: "云桥", kind: "cloud", wsUrl: url, token: bt || BAKED_BRIDGE_TOKEN,
              cloud: { url, token: bt || BAKED_BRIDGE_TOKEN, rd: BAKED_RELAY.rd, rk: BAKED_RELAY.rk, paired: false } };
          }
          setPendingPair(cloudCtx.cfg.id, { rd: h.get("rd"), rk: h.get("rk"), pc: h.get("pc") });
          history.replaceState(null, "", location.pathname);
        } else {
          // 共享库找已配对云源（本批最大验收亮点：旧壳 /app 已配对 → /app2 免配对直连）
          const shared = cloudSharedCloudServers().filter((s) => s.cloud && s.cloud.paired && s.cloud.rd && s.cloud.rk);
          const savedId = lsGet(ACTIVE_CLOUD_KEY) || "";
          const hit = shared.find((s) => s.id === savedId) || shared.find((s) => s.wsUrl === defaultCloudUrl()) || shared[0];
          if (hit) {
            cloudCtx.cfg = { id: hit.id, name: hit.name || "云桥", kind: "cloud", wsUrl: hit.wsUrl || defaultCloudUrl(),
              token: hit.token || BAKED_BRIDGE_TOKEN, cloud: Object.assign({}, hit.cloud) };
          } else {
            cloudCtx.cfg = { id: cloudUuid(), name: "云桥", kind: "cloud", wsUrl: defaultCloudUrl(), token: BAKED_BRIDGE_TOKEN,
              cloud: { url: defaultCloudUrl(), token: BAKED_BRIDGE_TOKEN, rd: BAKED_RELAY.rd, rk: BAKED_RELAY.rk, paired: false } };
          }
        }
        ctx.probing = false;
        // 云形态命令面接管：B2/B4/Team 都读 __ccDeck005MainWs——指向云 shim。
        // W-WINPAIR-R2：壳内并行形态不在此接管（ctx.ws 恒为 LAN socket，帧守卫才成立）——
        // 命令面归 setSourceView 按视角切换
        if (cloudMode || viewSource() === "cloud") window.__ccDeck005MainWs = cloudCmdShim;
        connectCloudFor(cloudCtx, false);
      }
      // ---------- W-WINPAIR-R2：并行多源 + 视角切换（test.19 回归①②修正） ----------
      // 语义重定：连接一经建立持续保活（本机 LAN 与云桥并行，谁都不因切换断链）；「切换」只是
      // 换展示视角（local/cloud/aggregate），命令通道（__ccDeck005MainWs）随视角走。帧总线 emit
      // 带 source 标记，桥/B2 按视角门控，聚合视角 SNAPSHOT 走 merge（不清另一源的会话）。
      const SOURCE_VIEW_KEY = "cc-deck-005-source-view";
      let sourceView = "local"; // local | cloud | aggregate（cloudMode 形态恒 cloud 视角）
      function viewSource() { return cloudMode ? "cloud" : sourceView; }
      window.__ccDeck005SourceView = viewSource; // 域脚本（桥/B2 订阅门控）借道
      function setSourceView(next) {
        if (cloudMode) return; // 云形态单一云视角，无切换
        const v = next === "cloud" || next === "aggregate" ? next : "local";
        sourceView = v;
        // 持久化：SOURCE_VIEW_KEY 只记单源偏好（local/cloud，aggregate 走 source-mode 键）——
        // 从聚合切回单源时能回到上次的那个源
        try {
          if (v === "aggregate") localStorage.setItem("cc-deck-005-source-mode", "aggregate");
          else { localStorage.setItem(SOURCE_VIEW_KEY, v); localStorage.setItem("cc-deck-005-source-mode", "single"); }
        } catch {}
        document.body.dataset.sourceMode = v === "aggregate" ? "aggregate" : "single";
        document.querySelectorAll(".source-switcher [data-source-mode]").forEach((el) => el.classList.toggle("active", el.dataset.sourceMode === (v === "aggregate" ? "aggregate" : "single"))); // 五壳模式按钮归位
        // 命令通道随视角（Team.sendCommand/B2 sendCmd 都读 __ccDeck005MainWs；本机视角=LAN socket）
        window.__ccDeck005MainWs = v === "cloud" ? cloudCmdShim : ctx.ws;
        syncTeamBind();
        // W-WINPAIR-R3：目标源 SNAPSHOT 补喂 Team（视角错位期间到达的团队字段不丢——
        // 团队域不订阅总线，onEvent 门控跳过的帧在此按缓存 payload 重建）
        const teamSrc = v === "cloud" ? cloudCtx : ctx;
        if (teamSrc.hasSnapshot && teamSrc.lastSnapshotPayload) {
          try { Team.onFrame(teamSrc, { type: "SNAPSHOT", payload: teamSrc.lastSnapshotPayload }); } catch {}
        }
        replaySnapshots();
        renderSessionList();
        renderCloudUI();
        refreshSourceSwitchers();
      }
      window.__ccDeck005SetSourceView = setSourceView; // 走查/域脚本借道
      // 帧门控：视角源放行；aggregate 放行全部（SNAPSHOT 由桥 merge 承接）；无标记（兼容）视作 lan
      function frameAllowed(ev) {
        const src = ev && ev.source ? ev.source : "lan";
        const v = viewSource();
        return v === "aggregate" ? true : v === "cloud" ? src === "cloud" : src === "lan";
      }
      window.__ccDeck005FrameAllowed = frameAllowed;
      // 切视角时桥/B2 快照重建：从各链 context 缓存的完整 payload 合成 SNAPSHOT 帧重放总线
      // （W-WINPAIR-R3：全字段重放——projects/org_confirms/acceptances 等不随切换清空；test.20 ①修复）
      function replaySnapshots() {
        const mk = (c, src) => {
          if (!c || !c.hasSnapshot) return;
          const p = c.lastSnapshotPayload;
          // W-PILL4 ④：logs 融合——快照基线 + 视角切走期间的地基增量缓存（切回消息全量）
          const logsMerged = { ...((p && typeof p === "object" && p.logs) || {}) };
          if (c.logBuffer) for (const [sid, arr] of c.logBuffer) {
            const base = Array.isArray(logsMerged[sid]) ? logsMerged[sid] : [];
            const merged = [...base, ...arr].slice(-300);
            if (merged.length) logsMerged[sid] = merged;
          }
          const payload = (p && typeof p === "object")
            ? { ...p, sessions: [...c.sessions.values()], logs: logsMerged } // 缓存 payload 全字段 + 最新会话态 + 增量日志融合
            : { relay_name: c.relayName, schema_version: 1, sessions: [...c.sessions.values()], logs: logsMerged };
          window.__ccDeck005Frames.emit({ kind: "frame", source: src, frame: { type: "SNAPSHOT", payload } });
        };
        const v = viewSource();
        if (v === "local") mk(ctx, "lan");
        else if (v === "cloud") mk(cloudCtx, "cloud");
        else { mk(ctx, "lan"); mk(cloudCtx, "cloud"); } // aggregate：两源各一帧，桥按 merge upsert
      }
      // Team 通道绑定跟视角源在线性（并行后各链状态变化都可能 bind，最终以视角源为准）
      function syncTeamBind() {
        const v = viewSource();
        const on = v === "cloud" ? cloudCtx.status === "online" : ctx.status === "online";
        Team.bind(on);
        if (!on) Team.failFlights();
      }
      function switchToCloudSource(manual) {
        if (cloudMode) return; // 云形态本来就在云链上（设置面板输码即可）
        if (!shellCloud) {
          // 首次激活：起云链（本机 LAN 不停——并行保活，test.19 回归①修正）
          shellCloud = true;
          try { localStorage.setItem(SHELL_CLOUD_KEY, "1"); } catch {}
          bootstrapCloud();
        } else if (manual && cloudCtx.status !== "online") {
          cloudManualRetry();
        }
        setSourceView("cloud");
      }
      function switchToLocalSource() {
        if (cloudMode) return;
        setSourceView("local"); // 云链保持连接保活；仅切视角与命令通道（不再 cloudDisconnect）
      }
      // ---------- W-WINPAIR-R7②：源改名（多远程区分——键=原始 relay_name，全链经 sourceDisplayName 跟随） ----------
      function openRenameSourceUI(rawName) {
        closeTransientOverlays();
        if (document.querySelector("[data-rename-pop]")) return;
        const back = document.createElement("div");
        back.className = "pair-pop-backdrop";
        back.dataset.renameBack = "";
        const pop = document.createElement("div");
        pop.className = "create-pop";
        pop.dataset.renamePop = "";
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-modal", "true");
        pop.setAttribute("aria-label", "重命名源");
        pop.innerHTML = '<h3>重命名源</h3>'
          + '<p class="create-sub">给这台远程起个好认的名字 · 顶栏/源列表/会话徽章同步更新</p>'
          + '<div class="create-label">显示名</div>'
          + '<input class="create-field" data-rename-input type="text" maxlength="40" placeholder="' + String(sourceDisplayName(rawName)).replace(/"/g, "&quot;") + '" aria-label="源显示名">'
          + '<div class="pair-foot"><span class="add-hint">留空恢复默认名</span><span style="display:flex;gap:8px"><button class="secondary-btn" type="button" data-rename-close>取消</button><button class="primary-btn" type="button" data-rename-save>保存</button></span></div>';
        const close = () => { pop.remove(); back.remove(); };
        const save = () => {
          const val = String((pop.querySelector("[data-rename-input]") || {}).value || "").trim();
          setSourceNameOverride(rawName, val);
          close();
          showToast(val ? "已重命名 · " + val : "已恢复默认名");
          replaySnapshots();          // B2/桥重放快照 → 会话卡徽章按新名重渲
          renderSessionList();
          refreshSourceSwitchers();
        };
        back.addEventListener("click", close);
        pop.addEventListener("click", (e) => {
          if (e.target.closest("[data-rename-close]")) { close(); return; }
          if (e.target.closest("[data-rename-save]")) { save(); return; }
        });
        pop.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
          if (e.target.closest && e.target.closest("[data-rename-input]")) { e.preventDefault(); save(); }
        });
        document.body.appendChild(back);
        document.body.appendChild(pop);
        setTimeout(() => { const el = pop.querySelector("[data-rename-input]"); if (el) { try { el.focus(); el.select(); } catch {} } }, 60);
      }
      // 带改名入口的云桥源行小钮（菜单行/设置行共用标记 data-source-rename，dataset.relayName 带原始名）
      document.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-source-rename]");
        if (!btn) return;
        const raw = String(btn.dataset.relayName || "");
        if (raw) openRenameSourceUI(raw);
      });
      // W-WINPAIR 只读诊断锚（排障/走查共用）：源切换态一目了然（视角/云源/云态/LAN 连接态）
      window.__ccDeck005SourceState = () => ({ view: viewSource(), shellCloud: !!shellCloud, cloudMode: !!cloudMode,
        cloudWsUrl: String(cloudCtx.cfg.wsUrl || ""), cloudStatus: cloudCtx.status, cloudRelayName: String(cloudCtx.relayName || ""),
        cloudPaired: !!(cloudCtx.cfg.cloud && cloudCtx.cfg.cloud.paired), cloudSessions: cloudCtx.sessions.size,
        lanStatus: String(ctx.status || ""), lanSessions: ctx.sessions.size,
        lanRelayName: String(ctx.relayName || ""), // #110：B2 域建卡打源标读点（跨 script 块不可直引 ctx；S.relayName 会被后到云快照覆写，LAN 名必须取链上真值）
        lanWsReady: !!(ctx.ws && ctx.ws.readyState === 1), lanWsUrl: String(ctx.cfg.wsUrl || "") });
      // W-WINPAIR-R3：快照注入钩子（排障/走查共用）——帧喂进对应链 context（onEvent 全字段缓存）
      // + 总线 emit，等同真实链路到达。页面内 window 级调用者本具全权，不新增信任面
      window.__ccDeck005IngestSnapshot = (source, payload) => {
        const c = source === "cloud" ? cloudCtx : ctx;
        onEvent(c, { type: "SNAPSHOT", payload: payload && typeof payload === "object" ? payload : { sessions: [] } });
        window.__ccDeck005Frames.emit({ kind: "frame", source, frame: { type: "SNAPSHOT", payload } });
      };
      // W-WINPAIR-R7①：聚合发送按会话源路由（test.21 核心闭环）——命令 payload 带会话 id 时查
      // 所属源定通道：云源会话走云 shim 密封上行（本机 relay 查无此会话=「会话不存在」根修），
      // 本机会话走 LAN socket；不带会话的命令维持视角通道。ACK 按 command_id 从总线结算不锚 socket
      window.__ccDeck005RouteWs = (payload) => {
        const sid = payload && typeof payload === "object" ? String(payload.session_id || payload.sid || "") : "";
        if (!sid) return window.__ccDeck005MainWs || ctx.ws;
        if (cloudCtx.sessions.has(sid)) return cloudCtx.status === "online" ? cloudCmdShim : null;
        if (ctx.sessions.has(sid)) return ctx.ws && ctx.ws.readyState === 1 ? ctx.ws : null;
        // T10 根修：聚合视图桥兜底泛化——地基链 onEvent 只锚 SNAPSHOT（增量帧不进 ctx.sessions），
        // SNAPSHOT 之后新建的会话只有 B4 桥实时持有；旧版桥 SESSION_CREATED 建卡无源标 → 本分支
        // miss → 盲投视角通道（云视角=云 shim）→ 云 relay 查无此会话报「会话不存在: <完整id>」
        //（1015 用户实锤链：codebuddy 会话创建成功、发消息错投云报不存在，id 全长在窄 toast 被
        // 目视截断成「残缺 id」假象）。会话卡现带 relay_channel（实时帧建卡）或 relay_source
        //（SNAPSHOT 打的源名），按真实归属路由：
        const bs = window.__ccDeck005B4 && window.__ccDeck005B4.sessions.get(sid);
        // W-P2FIX P2-2：通道字段优先——relay_channel 在场即信它（内核级帧通道事实），名字比对只在
        // 无通道字段的卡上兜底。原 OR 结构下同名双源（LAN 名=云名）时 relay_source 比对会碾过
        // relay_channel（channel="lan" 的卡仍 bsCloud=true）——SNAPSHOT merge 的 relay_source 打标
        // 就地污染 payload 对象（onEvent 先于总线 emit），桥浅拷贝常态带入，同名即误投云 shim。
        const bsCloud = !!(bs && (bs.relay_channel ? bs.relay_channel === "cloud" : (bs.relay_source && cloudCtx.hasSnapshot && String(cloudCtx.relayName || "") === String(bs.relay_source))));
        if (bsCloud) return cloudCtx.status === "online" ? cloudCmdShim : null;
        if (bs && (bs.relay_channel === "lan" || bs.relay_source)) return ctx.ws && ctx.ws.readyState === 1 ? ctx.ws : null;
        // 两源表 + 桥都查不到：拒发——会话可能已删/所属源离线，盲投视角通道只会产出误导性的
        // 「会话不存在: <id>」（错投报错带完整 id，排查被带偏），明确拒发让端上给可操作提示
        return null;
      };
      // W-PORT-A R-2：目标源显式通道（新建弹窗「创建到」行消费）——cloud=云 shim（在线才有），
      // local=LAN socket。与 RouteWs（按会话归属路由）互补：CREATE 类无 session_id 的命令按显式选择走。
      window.__ccDeck005WsFor = (source) => {
        if (source === "cloud") return cloudCtx.status === "online" ? cloudCmdShim : null;
        return ctx.ws && ctx.ws.readyState === 1 ? ctx.ws : null;
      };
      // ---------- W-WINPAIR：「＋ 添加服务器」弹窗（client 侧连远程源，对齐手机 SetupScreen 语义） ----------
      // 8 位配对码为主路径（云桥默认地址），高级折叠可改地址/桥令牌。提交=激活云链（壳/LAN 形态
      // 先 switchToCloudSource）+ 覆盖 cfg + 走 submitPairCodeWith 配对链（pair_ack 后落共享库）。
      function openAddServerUI() {
        closeTransientOverlays();
        if (document.querySelector("[data-add-pop]")) return;
        const back = document.createElement("div");
        back.className = "pair-pop-backdrop";
        back.dataset.addBack = "";
        const pop = document.createElement("div");
        pop.className = "create-pop add-server-pop";
        pop.dataset.addPop = "";
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-modal", "true");
        pop.setAttribute("aria-label", "添加服务器");
        pop.innerHTML = '<h3>添加服务器</h3>'
          + '<p class="create-sub">连接其他电脑的 CC Deck · 在对方「设置 → 连接与设备」领 8 位码</p>'
          + '<div class="create-label">配对码</div>'
          + '<div class="pair-link-row"><input class="create-field" data-cloud-pair-input type="text" inputmode="numeric" maxlength="8" placeholder="8 位配对码" aria-label="8 位配对码"><button class="primary-btn" type="button" data-add-submit>连接</button></div>'
          + '<details class="add-adv"><summary>高级 · 服务器地址与令牌</summary>'
          + '<div class="create-label">服务器地址</div>'
          + '<input class="create-field" data-add-url type="text" placeholder="cc.humumu.online/cloud（默认云桥）" aria-label="服务器地址">'
          + '<div class="create-label">桥令牌</div>'
          + '<input class="create-field" data-add-token type="text" placeholder="留空用公共桥" aria-label="桥令牌">'
          + '</details>'
          + '<div class="pair-foot"><span class="add-hint">公司网络自动降级 HTTP 轮询</span><button class="secondary-btn" type="button" data-add-close>取消</button></div>';
        const closeAddServerUI = () => { pop.remove(); back.remove(); };
        back.addEventListener("click", closeAddServerUI);
        pop.addEventListener("click", (event) => {
          if (event.target.closest("[data-add-close]")) { closeAddServerUI(); return; }
          if (event.target.closest("[data-add-submit]")) { submitAddServer(); return; }
        });
        pop.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return; // IME 守卫
          if (event.target.closest && event.target.closest("[data-cloud-pair-input], [data-add-url], [data-add-token]")) { event.preventDefault(); submitAddServer(); }
        });
        document.body.appendChild(back);
        document.body.appendChild(pop);
        setTimeout(() => { const el = pop.querySelector("[data-cloud-pair-input]"); if (el) { try { el.focus(); } catch {} } }, 60);
      }
      function submitAddServer() {
        const pop = document.querySelector("[data-add-pop]");
        if (!pop) return;
        const codeEl = pop.querySelector("[data-cloud-pair-input]");
        const code = String((codeEl && codeEl.value) || "").trim();
        if (!/^\d{6,8}$/.test(code)) { showToast("请输入 6-8 位数字配对码"); if (codeEl) codeEl.focus(); return; }
        let wsUrl = String((pop.querySelector("[data-add-url]") || {}).value || "").trim().replace(/\/+$/, "");
        if (wsUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(wsUrl)) wsUrl = "wss://" + wsUrl; // 云桥语义：裸域名按 wss 补全
        const token = String((pop.querySelector("[data-add-token]") || {}).value || "").trim();
        if (!window.nacl) { showToast("加密组件未加载，请检查网络后刷新"); return; }
        // 激活云链（壳/LAN 形态先切源——bootstrapCloud 从共享库/默认建 cfg 并接管命令面）
        if (!cloudMode && !shellCloud) switchToCloudSource(false);
        // 用户显式地址 = 新源身份（id 换新，配对成功以新条目落共享库）；仅令牌则沿用当前源
        if (wsUrl && wsUrl !== cloudCtx.cfg.wsUrl) {
          cloudCtx.cfg = { id: cloudUuid(), name: hostOf(wsUrl) || "云桥", kind: "cloud", wsUrl,
            token: token || BAKED_BRIDGE_TOKEN, cloud: { url: wsUrl, token: token || BAKED_BRIDGE_TOKEN, rd: BAKED_RELAY.rd, rk: BAKED_RELAY.rk, paired: false } };
          cloudCtx.sessions.clear(); cloudCtx.hasSnapshot = false; cloudCtx.lastSeq = 0;
        } else if (token) {
          cloudCtx.cfg.token = token;
        }
        pop.remove();
        document.querySelector("[data-add-back]")?.remove();
        showToast("正在配对云桥…");
        submitPairCodeWith(code);
      }
      // W-SDEL 删除确认门：正在连接的源（在线/连接中）删除需二次确认（明示断连影响）；
      // 离线/未连接的死条目直接删——正是「删掉失效条目重新添加」的用户主路径，不设卡
      function deleteCloudServerUI(entry) {
        if (!entry || !entry.id) return;
        const isCur = cloudCtx.cfg && cloudCtx.cfg.id === entry.id;
        const live = isCur && (cloudCtx.status === "online" || cloudCtx.status === "connecting");
        const label = sdelDisplayName(entry, isCur);
        if (live && !confirm("正在连接「" + label + "」，删除将断开连接。确定删除？")) return;
        if (deleteCloudServer(entry.id)) showToast("已删除服务器「" + label + "」");
      }
      // W-SDEL 编辑弹窗（名称 / 服务器地址 / 桥令牌——旧壳 saveSrvBtn 编辑分支语义移植）：
      // 地址未变=保配对身份；地址变更=换桥，配对身份重置需重新输码（保存后明示）。
      // 编辑当前连接源且字段变更 → 断开重连（旧壳「改动连接相关字段即重连该源」）。
      function openEditServerUI(entry) {
        if (!entry || !entry.id) return;
        closeTransientOverlays();
        if (document.querySelector("[data-edit-pop]")) return;
        const back = document.createElement("div");
        back.className = "pair-pop-backdrop";
        back.dataset.editBack = "";
        const pop = document.createElement("div");
        pop.className = "create-pop add-server-pop";
        pop.dataset.editPop = "";
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-modal", "true");
        pop.setAttribute("aria-label", "编辑服务器");
        pop.innerHTML = '<h3>编辑服务器</h3>'
          + '<p class="create-sub">改动地址将重置配对（换桥需重新输码）· 改动连接字段即重连此源</p>'
          + '<div class="create-label">名称</div>'
          + '<input class="create-field" data-edit-name type="text" maxlength="40" placeholder="如：家里 Mac" aria-label="服务器名称" value="' + escapeHtml(String(entry.name || "")) + '">'
          + '<div class="create-label">服务器地址</div>'
          + '<input class="create-field" data-edit-url type="text" placeholder="cc.humumu.online/cloud" aria-label="服务器地址" value="' + escapeHtml(String(entry.wsUrl || "")) + '">'
          + '<div class="create-label">桥令牌</div>'
          + '<input class="create-field" data-edit-token type="text" placeholder="留空沿用当前令牌" aria-label="桥令牌" value="">'
          + '<div class="pair-foot"><span class="add-hint">删除源走列表行 ✕ 钮</span><span style="display:flex;gap:8px"><button class="secondary-btn" type="button" data-edit-close>取消</button><button class="primary-btn" type="button" data-edit-save>保存</button></span></div>';
        const close = () => { pop.remove(); back.remove(); };
        const save = () => {
          const rawUrl = String((pop.querySelector("[data-edit-url]") || {}).value || "").trim().replace(/\/+$/, "");
          let wsUrl = rawUrl;
          if (wsUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(wsUrl)) wsUrl = "wss://" + wsUrl; // 云桥语义：裸域名按 wss 补全（submitAddServer 同口径）
          const name = String((pop.querySelector("[data-edit-name]") || {}).value || "").trim();
          const token = String((pop.querySelector("[data-edit-token]") || {}).value || "").trim();
          const wasCur = cloudCtx.cfg && cloudCtx.cfg.id === entry.id;
          const relayName = String(cloudCtx.relayName || "");
          const r = updateSharedCloudServer(entry.id, { name, wsUrl, token });
          if (r === null) { showToast("源列表数据损坏，已跳过写入（保护既有数据）"); close(); return; }
          if (!r.entry) { showToast("该服务器已不存在"); close(); renderCloudUI(); return; }
          // 在线源改名同步 override（顶栏/会话徽章经 sourceDisplayName 跟随，与源菜单 ✎ 同效）
          if (wasCur && cloudCtx.status === "online" && relayName && !/^(tauri\.localhost|localhost|127\.0\.0\.1)(:|$)/.test(relayName)) setSourceNameOverride(relayName, name);
          if (wasCur) {
            // 当前连接源字段变更 → 断开重连（地址变了会重置配对，重连后走输码）
            const changed = r.addrChanged || !!token;
            cloudDisconnect();
            cloudCtx.cfg = { id: r.entry.id, name: r.entry.name, kind: "cloud", wsUrl: r.entry.wsUrl || "", token: r.entry.token || BAKED_BRIDGE_TOKEN, cloud: Object.assign({}, r.entry.cloud || null) };
            if (cloudMode || shellCloud) bootstrapCloud();
            showToast(r.addrChanged ? "地址已变更 · 需重新输码配对" : changed ? "已保存 · 正在重连" : "已保存");
          } else {
            showToast(r.addrChanged ? "已保存 · 地址变更，连接时需重新配对" : "已保存");
          }
          close();
          renderCloudUI(); refreshSourceSwitchers();
          try { window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive(); } catch {}
        };
        back.addEventListener("click", close);
        pop.addEventListener("click", (e) => {
          if (e.target.closest("[data-edit-close]")) { close(); return; }
          if (e.target.closest("[data-edit-save]")) { save(); return; }
        });
        pop.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // IME 守卫（005 既有军规）
          if (e.target.closest && e.target.closest("[data-edit-name], [data-edit-url], [data-edit-token]")) { e.preventDefault(); save(); }
        });
        document.body.appendChild(back);
        document.body.appendChild(pop);
        setTimeout(() => { const el = pop.querySelector("[data-edit-name]"); if (el) { try { el.focus(); el.select(); } catch {} } }, 60);
      }
      function cloudDisconnect() {
        cloudCtx.pollGen++; // 掐掉轮询循环
        clearInterval(cloudCtx.pairTimer); cloudCtx.pairTimer = 0;
        stopCloudPing(cloudCtx);
        clearTimeout(cloudCtx.reconnectTimer); cloudCtx.reconnectTimer = 0;
        clearTimeout(cloudCtx.hsTimer); cloudCtx.hsTimer = 0;
        clearTimeout(cloudCtx.discTimer); cloudCtx.discTimer = 0;
        try { cloudCtx.ws && cloudCtx.ws.close(); } catch {}
        cloudCtx.ws = null;
        cloudCtx.status = "offline";
        cloudCtx.statusText = "已断开";
        cloudCtx.failKind = ""; cloudCtx.retryAt = 0; cloudCtx.retryNote = "";
      }

      // ---------- 云桥 UI（缝合点 d：#d-settings 连接面板 + 移动端连接详情；复用 005 既有设计语言） ----------
      function cloudTagOf() {
        const s = cloudCtx.status;
        if (s === "online") return ["done", "已连接"];
        if (s === "connecting") return ["action", "连接中"];
        if (cloudCtx.failKind === "unpaired") return ["action", "未配对"];
        return ["danger", "离线"];
      }
      function cloudFormActive() { return cloudUIOn(); } // W-WINPAIR：壳内切云同口径（域脚本借道判定云 UI 激活）
      function cloudStatusLabel() { return cloudTagOf()[1]; }
      function cloudFormLabel() {
        return cloudUIOn() ? "本机 · 云桥 · " + (cloudCtx.statusText || "未连接") : "端口 " + (location.port || "8787") + " · 事件流自动补发";
      }
      function cloudRetryBtn() { return isCloudRetryable() ? '<button class="connection-reconnect" data-cloud-retry type="button">重试</button>' : ""; }
      // 桌面 connections 面板 slot 内容（W-SDEL 重做：服务器条目列表管理——多条+连接+编辑+删除；
      // 「云桥」从唯一固定项降级为其中一条默认条目）。空列表=引导行；云形态追加本页设备行与
      // （未配对时）输码表单。非云形态同样列条目——死条目清理入口不依赖云链激活态。
      function sdelDisplayName(entry, isCurrent) {
        if (isCurrent && cloudCtx.hasSnapshot && cloudCtx.relayName && !/^(tauri\.localhost|localhost|127\.0\.0\.1)(:|$)/.test(String(cloudCtx.relayName))) return sourceDisplayName(String(cloudCtx.relayName));
        const n = String((entry && entry.name) || "");
        return n && n !== "云桥" ? n : (hostOf(entry && entry.wsUrl) || "云桥");
      }
      function sdelSubLine(s, isCur, paired) {
        if (isCur) return (cloudCtx.statusText || "未连接") + (cloudCtx.transport === "poll" ? " · HTTP 轮询" : "");
        return s.wsUrl ? hostOf(s.wsUrl) : "未配置"; // 视觉审查①：副行只留地址，配对状态统一交给右侧 tag（不做双份）
      }
      function sdelServerRows(mobile) {
        const entries = cloudSharedCloudServers();
        const curId = cloudCtx.cfg && cloudCtx.cfg.id;
        return entries.map((s) => {
          const isCur = s.id === curId;
          const paired = !!(s.cloud && s.cloud.paired);
          const disp = sdelDisplayName(s, isCur);
          const sub = sdelSubLine(s, isCur, paired);
          if (mobile) {
            return '<div class="mobile-task"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><strong style="font-size:var(--fs-B)">' + escapeHtml(disp) + '</strong>'
              + (isCur ? "" : '<button class="primary-btn" data-srv-connect="' + s.id + '" type="button" style="font-size:var(--fs-A)">连接</button>')
              + (isCur ? cloudRetryBtn() : "")
              + '<button class="row-edit" data-srv-edit="' + s.id + '" type="button" title="编辑此服务器">✎</button>'
              + '<button class="row-del" data-srv-delete="' + s.id + '" type="button" title="删除此服务器">✕</button></div>'
              + '<p style="margin:4px 0 0;color:var(--dim)">' + escapeHtml(sub) + '</p></div>';
          }
          const [cls, label] = isCur ? cloudTagOf() : (paired ? ["info", "已保存"] : ["action", "待配对"]); // 视觉审查②：与既有行措辞统一（待配对）
          return '<div class="settings-row' + (isCur ? " cloud-cur" : "") + '"><span class="avatar">☁</span><div><strong>' + escapeHtml(disp) + '</strong><p>' + escapeHtml(sub) + '</p></div>'
            + (isCur ? "" : '<button class="row-share" data-srv-connect="' + s.id + '" type="button" title="连接此服务器">连接</button>')
            + (isCur ? cloudRetryBtn() : "")
            + '<button class="row-edit" data-srv-edit="' + s.id + '" type="button" title="编辑此服务器（名称 / 地址 / 令牌）">✎</button>'
            + '<button class="row-del" data-srv-delete="' + s.id + '" type="button" title="删除此服务器">✕</button>'
            + '<span class="tag ' + cls + '">' + label + '</span></div>';
        }).join("");
      }
      function cloudSettingsRows() {
        const entries = cloudSharedCloudServers();
        let html = "";
        if (!entries.length) {
          html += '<div class="settings-row"><span class="avatar">☁</span><div><strong>远程源</strong><p>未添加远程源 · 点「＋ 添加」连接其他电脑</p></div><button class="row-share" data-settings-add type="button" title="填服务器地址 + 8 位配对码，把其他电脑加为数据源">＋ 添加</button><span class="tag info">未添加</span></div>';
        } else {
          html += sdelServerRows(false);
          html += '<div class="settings-row"><span class="avatar">＋</span><div><strong>添加服务器</strong><p>8 位配对码连接其他电脑的 CC Deck</p></div><button class="row-share" data-settings-add type="button">＋ 添加</button></div>';
        }
        if (cloudUIOn()) {
          const peer = cloudPeerOf(cloudCtx.cfg);
          html += '<div class="settings-row"><span class="avatar">▣</span><div><strong>本页设备 · ' + (ckp ? escapeHtml(devId(ckp.publicKey, "wb")) : "—")
            + '</strong><p>' + (peer ? "已配对服务器 " + escapeHtml(peer.relay_dev) : cloudCtx.pendingPair ? "配对进行中" : "未配对 · 输码或打开配对链接")
            + '</p></div><span class="tag ' + (peer ? "done" : "action") + '">' + (peer ? "已配对" : "待配对") + '</span></div>';
          if (!peer) {
            html += '<div class="settings-row"><span class="avatar">◈</span><div style="flex:1;min-width:0"><strong>输入配对码</strong>'
              + '<p>电脑端 CC Deck 设置 → relay 页领取 8 位码</p>'
              + '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center">'
              + '<input class="composer-input" data-cloud-pair-input type="text" inputmode="numeric" placeholder="8 位配对码" aria-label="8 位配对码" style="border:1px solid var(--line);border-radius:6px;padding:6px 8px;width:9em">'
              + '<button class="primary-btn" data-cloud-pair-submit type="button">配对</button></div></div></div>';
          }
        }
        return html;
      }
      // 移动端「连接与设备」详情的远程源 lane（W-SDEL 同步列表化；720px 视口下表单可输入可提交——
      // 输入框显式 14px 防 iOS 聚焦缩放）。与桌面 sdelServerRows 共用 data-* 锚（文档级委托同一套）
      function cloudMobileLaneInner() {
        const entries = cloudSharedCloudServers();
        if (!entries.length) return '<div class="mobile-lane-head"><span>远程源</span><span class="tag info">未添加</span></div><div class="mobile-task">未添加远程源 · 顶栏菜单「＋ 添加服务器」可连接其他电脑</div>';
        let html = '<div class="mobile-lane-head"><span>远程源 · ' + entries.length + '</span></div>';
        html += sdelServerRows(true);
        html += '<div class="mobile-task"><button class="primary-btn" data-settings-add type="button" style="font-size:var(--fs-A)">＋ 添加服务器</button></div>';
        if (cloudUIOn()) {
          const peer = cloudPeerOf(cloudCtx.cfg);
          if (!peer) {
            html += '<div class="mobile-task"><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">'
              + '<input class="composer-input" data-cloud-pair-input type="text" inputmode="numeric" placeholder="8 位配对码" aria-label="8 位配对码" style="border:1px solid var(--line);border-radius:6px;padding:6px 8px;width:8em;font-size:var(--fs-A)">'
              + '<button class="primary-btn" data-cloud-pair-submit type="button">配对</button></div>'
              + '<p style="margin:6px 0 0;color:var(--dim)">电脑端 CC Deck 设置 → relay 页领取</p></div>';
          }
        }
        return html;
      }
      function cloudMobileLane() { return '<div class="mobile-lane" data-cloud-mobile-slot>' + cloudMobileLaneInner() + '</div>'; }
      // 云态刷新：输入框聚焦中跳过重渲（防打字被 innerHTML 清掉），状态文字下一拍再追
      function renderCloudUI() {
        const active = document.activeElement;
        const typing = !!(active && active.matches && active.matches("[data-cloud-pair-input]"));
        if (typing) return;
        document.querySelectorAll("[data-cloud-settings-slot]").forEach((slot) => { slot.innerHTML = cloudSettingsRows(); });
        document.querySelectorAll("[data-cloud-mobile-slot]").forEach((lane) => { lane.innerHTML = cloudMobileLaneInner(); });
      }
      function openCloudPairUI() {
        if (document.querySelector("#stage-desktop.active")) {
          setDesktopDomain("settings");
          const tab = document.querySelector('#d-settings .workspace-head .segment-bar button');
          if (tab) tab.click(); // 连接子面板置前（云行/表单所在）
        } else {
          openMobileRoot("settings");
          const content = document.querySelector("#m-settings .mobile-content");
          if (content && typeof content._renderSettingsDetail === "function") content._renderSettingsDetail("连接与设备");
        }
        setTimeout(() => { const el = document.querySelector("[data-cloud-pair-input]"); if (el) { try { el.focus(); } catch {} } }, 140);
      }
      // 配对表单/重试钮事件（文档级委托：桌面 #d-settings 与移动 #m-settings 同一套 data-* 锚）
      document.addEventListener("click", (event) => {
        if (!cloudUIOn()) return;
        if (event.target.closest("[data-cloud-pair-submit]")) { submitPairCode(); return; }
        if (event.target.closest("[data-cloud-retry]")) { cloudManualRetry(); showToast("正在重连云桥"); return; }
      });
      // W-WINPAIR：设置连接页「＋ 添加服务器」入口（client 侧连远程源，与配对新设备 server 侧并列）
      document.addEventListener("click", (event) => {
        if (!event.target.closest("[data-settings-add]")) return;
        openAddServerUI();
      });
      // W-SDEL 服务器条目三锚委托（桌面设置页与移动 lane 共用；不带 cloudUIOn 门——
      // 非云形态也要能清理死条目/连接已保存源，云链激活由 activateCloudServer 内部接管）
      document.addEventListener("click", (event) => {
        const conn = event.target.closest("[data-srv-connect]");
        if (conn) { activateCloudServer(String(conn.dataset.srvConnect || "")); return; }
        const del = event.target.closest("[data-srv-delete]");
        if (del) { deleteCloudServerUI(sharedCloudEntryOf(String(del.dataset.srvDelete || ""))); return; }
        const edit = event.target.closest("[data-srv-edit]");
        if (edit) { openEditServerUI(sharedCloudEntryOf(String(edit.dataset.srvEdit || ""))); return; }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return; // IME 守卫（005 既有军规）
        const t = event.target;
        if (t && t.closest && t.closest("[data-cloud-pair-input]")) { event.preventDefault(); submitPairCode(); }
      });
      // 域脚本只读挂钩（B4 桥 waitingText / 移动端 B7 lane 与列表副文案借道取云态；帧路由零改动）
      // W-WINPAIR-R4：云桥技术状态不再外泄到会话/项目/详情列横幅（用户实测「本机云桥已连接」
      // 无信息量占位）——只保留 unpaired 输码引导（行动引导），其余云态返回 null 落回通用
      // 等待文案；连接状态详情归设置 → 连接与设备页。listSub 同口径（在线不喊输码）
      window.__ccDeck005CloudUI = {
        active: cloudFormActive,
        stateLabel: cloudStatusLabel,
        listSub: () => (cloudUIOn() && cloudCtx.failKind === "unpaired" ? "云桥未配对 · 详情可输码配对" : ""),
        mobileLane: cloudMobileLane,
        waitingText: () => {
          if (!cloudUIOn()) return null;
          if (cloudCtx.failKind === "unpaired") return "云桥未配对 · 设置 → 连接与设备 输入配对码";
          return null; // 云桥技术状态不进列横幅（快照等待走 B4 通用「等待 relay SNAPSHOT」文案）
        },
      };

      // ---------- #143 Leader 合流接线：团队域通道（B3-C1~C4，B3 报告遗留项 1/2 的接线侧）----------
      // B3 团队域只吃覆盖式全量帧 + bind({command, online})；delta 投影与锚定纪律（M13-2：
      // 未锚定收到 delta=丢弃——PROJECTS 域随 SNAPSHOT 自愈、BOARD 域由 COMMAND_PROJECT_DETAIL
      // 按需重拉，绝不空集起底 merge）由本层承接。命令走 ctx.ws 的 COMMAND/COMMAND_ACK
      //（#018-W1b 三态：ok===true 才算送达；断线/超时 resolve(null) 由 B3 verdict 判可重试）。
      // W-VISFIX2 #215：会话帧放行集——团队域成员 tab 的灯/排序/统计消费实时会话状态，
      // 原帧闸只放五类型=会话帧全被闸（团队域 sessions 恒停上一张快照）
      const TEAM_SESSION_FRAME_TYPES = new Set(["SESSION_CREATED", "SESSION_UPDATED", "SESSION_WAITING", "SESSION_WAITING_RESOLVED", "SESSION_ERROR", "SESSION_DONE"]);
      const Team = {
        anchored: false, boardAnchored: new Set(), projects: [], boards: new Map(),
        ackWaiters: new Map(), cmdSeq: 0,
        api() { const api = window.ccDeckTeam; return api && typeof api.onEvent === "function" && typeof api.bind === "function" ? api : null; },
        ctxName(context) { return (context && context.relayName) || location.host; },
        bind(online) {
          const api = this.api(); if (!api) return;
          try { api.bind({ command: (type, payload, timeoutMs) => this.sendCommand(type, payload, timeoutMs), online: online === true }); } catch {}
        },
        sendCommand(type, payload, timeoutMs = 8000) {
          return new Promise((resolve) => {
            const ws = window.__ccDeck005RouteWs ? window.__ccDeck005RouteWs(payload) : (window.__ccDeck005MainWs || ctx.ws); // W-WINPAIR-R2 视角通道 + R7① 会话源路由（聚合下远程会话走云链）
            if (!ws || ws.readyState !== WebSocket.OPEN) { resolve(null); return; }
            const commandId = "team-" + Date.now().toString(36) + "-" + String(++this.cmdSeq);
            const timer = setTimeout(() => { this.ackWaiters.delete(commandId); resolve(null); }, timeoutMs);
            this.ackWaiters.set(commandId, { resolve, timer });
            try { ws.send(JSON.stringify({ command_id: commandId, type, payload, ts: Date.now() })); }
            catch { clearTimeout(timer); this.ackWaiters.delete(commandId); resolve(null); }
          });
        },
        onAck(ack) {
          if (!ack || typeof ack.command_id !== "string") return;
          // 详情 ACK 顺带锚定本层板投影：后续该 gid 的 BOARD delta 才可应用（M13-2 锚定纪律）
          if (ack.ok === true && ack.data && ack.data.board && typeof ack.data.board.gid === "string" && Array.isArray(ack.data.board.entries)) {
            this.boardAnchored.add(ack.data.board.gid); this.boards.set(ack.data.board.gid, ack.data.board);
          }
          const waiter = this.ackWaiters.get(ack.command_id);
          if (!waiter) return;
          this.ackWaiters.delete(ack.command_id); clearTimeout(waiter.timer); waiter.resolve(ack);
        },
        failFlights() { for (const waiter of this.ackWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve(null); } this.ackWaiters.clear(); },
        // W-VISFIX2 #215：转发带 session_id（会话帧的 sid 在信封上，团队域会话帧消费按它寻卡）
        feed(api, context, type, payload, sessionId) { try { api.onEvent(context, { type, payload, ...(sessionId ? { session_id: sessionId } : {}) }); } catch {} },
        onFrame(context, message) {
          if (!message || typeof message.type !== "string") return;
          if (message.type === "SNAPSHOT") {
            let p = message.payload || {};
            // W-WINPAIR-R4 聚合 org 合并：双槽缓存各源 payload，aggregate 视角喂给团队域的
            // 是两源合并帧（projects/org_confirms/boards/sessions 按 id 并集；其余字段 last-write）
            // ——团队域 snapshot 全量清场，合并必须在这一层做完（域脚本零改动）
            const agg = viewSource() === "aggregate";
            if (context === cloudCtx) this._aggCloud = p; else this._aggLan = p;
            if (agg) {
              const a = context === cloudCtx ? this._aggLan : this._aggCloud;
              if (a && a !== p) {
                const byId = (lists) => { const m = new Map(); for (const l of lists) for (const g of (Array.isArray(l) ? l : [])) if (g && typeof g.id === "string") m.set(g.id, g); return m; };
                p = {
                  ...p,
                  relay_name: "聚合 · 全部源",
                  projects: [...byId([a.projects, p.projects]).values()],
                  org_confirms: [...byId([a.org_confirms, p.org_confirms]).values()],
                  boards: [...(Array.isArray(a.boards) ? a.boards : []), ...(Array.isArray(p.boards) ? p.boards : [])].filter((b) => b && typeof b.gid === "string"),
                  sessions: [...(Array.isArray(a.sessions) ? a.sessions : []), ...(Array.isArray(p.sessions) ? p.sessions : [])],
                };
              } else if (a === p) { p = { ...p, relay_name: "聚合 · 全部源" }; }
            }
            // #143 盲评C-3：缺 projects = relay 不支持团队域（B3-C1），不锚定——后续 PROJECTS delta 丢弃，绝不空基线起底 merge
            this.anchored = Array.isArray(p.projects); this.boardAnchored = new Set();
            this.projects = this.anchored ? p.projects.slice() : [];
            this.boards = new Map((Array.isArray(p.boards) ? p.boards : []).filter((b) => b && typeof b.gid === "string").map((b) => [b.gid, b]));
            for (const gid of this.boards.keys()) this.boardAnchored.add(gid); // #143 盲评C-2：快照板登记锚定集，后续 BOARD delta 才可投影
            const api = this.api(); if (api) { try { api.snapshot(p, { relayName: agg ? "聚合 · 全部源" : this.ctxName(context) }); } catch {} }
            return;
          }
          if (message.type !== "PROJECTS_UPDATED" && message.type !== "BOARD_UPDATED" && message.type !== "ORG_CONFIRM_UPDATED" && message.type !== "EXPERIENCE_UPDATED" && message.type !== "RULES_UPDATED" && !TEAM_SESSION_FRAME_TYPES.has(message.type)) return; // W-EXPP2/W-RULES2：经验域+规则域帧放行（帧双载恒带 entries 全量，走下方覆盖式透传，B3 吃全量）；W-VISFIX2 #215：会话帧放行（成员 tab 灯/排序/统计的实时数据源，原被闸=派单后团队域恒停上一张快照）
          const api = this.api(); if (!api) return;
          const p = message.payload || {};
          const teamContext = { relayName: this.ctxName(context) };
          // W-VISFIX2 #215：会话帧直通团队域（sid 走信封随行），不落下方 delta 投影链
          if (TEAM_SESSION_FRAME_TYPES.has(message.type)) { this.feed(api, teamContext, message.type, p, message.session_id); return; }
          if (message.type === "PROJECTS_UPDATED" && p.delta !== undefined) {
            if (!this.anchored) return; // 未锚定丢弃：随下一帧 SNAPSHOT 自愈
            const byId = new Map(this.projects.map((group) => [group.id, group]));
            for (const group of (Array.isArray(p.delta.upserts) ? p.delta.upserts : [])) if (group && typeof group.id === "string") byId.set(group.id, group);
            for (const id of (Array.isArray(p.delta.removes) ? p.delta.removes : [])) byId.delete(String(id));
            this.projects = [...byId.values()];
            this.feed(api, teamContext, "PROJECTS_UPDATED", { groups: this.projects });
            return;
          }
          if (message.type === "BOARD_UPDATED" && p.delta !== undefined) {
            if (typeof p.gid !== "string" || !this.boardAnchored.has(p.gid) || !this.boards.has(p.gid)) return; // 未锚定丢弃：详情按需重拉
            const board = this.boards.get(p.gid);
            const entries = new Map((Array.isArray(board.entries) ? board.entries : []).map((entry) => [entry.id, entry]));
            const lessons = new Map((Array.isArray(board.lessons) ? board.lessons : []).map((lesson) => [lesson.id, lesson]));
            const entryDelta = p.delta.entries || {}, lessonDelta = p.delta.lessons || {};
            for (const entry of (Array.isArray(entryDelta.upserts) ? entryDelta.upserts : [])) if (entry && typeof entry.id === "string") entries.set(entry.id, entry);
            for (const id of (Array.isArray(entryDelta.removes) ? entryDelta.removes : [])) entries.delete(String(id));
            for (const lesson of (Array.isArray(lessonDelta.upserts) ? lessonDelta.upserts : [])) if (lesson && typeof lesson.id === "string") lessons.set(lesson.id, lesson);
            for (const id of (Array.isArray(lessonDelta.removes) ? lessonDelta.removes : [])) lessons.delete(String(id));
            const projected = Object.assign({}, board, p.delta.meta || {}, { entries: [...entries.values()], lessons: [...lessons.values()] });
            this.boards.set(p.gid, projected);
            this.feed(api, teamContext, "BOARD_UPDATED", { gid: p.gid, board: projected });
            return;
          }
          if (message.type === "BOARD_UPDATED" && p.delta === undefined && typeof p.gid === "string" && p.board && Array.isArray(p.board.entries)) {
            this.boardAnchored.add(p.gid); this.boards.set(p.gid, p.board); // 覆盖式=锚定帧
          }
          // ORG_CONFIRM_UPDATED 只有全量形态（types.ts OrgConfirmUpdatedPayload{pending}，无 delta 字段），透传原文即正确；
          // B3 侧对缺 pending 的帧返回 false 属防线而非缺陷（#143 盲评C-4 记档）
          // W-WINPAIR-R4：聚合视角下与另一源槽的 org_confirms 并集喂（全量形态会清另一源确认卡）
          if (message.type === "ORG_CONFIRM_UPDATED" && viewSource() === "aggregate") {
            const other = context === cloudCtx ? this._aggLan : this._aggCloud;
            if (other && Array.isArray(p.pending)) {
              const seen = new Set(p.pending.map((c) => c && c.id));
              const merged = p.pending.concat((Array.isArray(other.org_confirms) ? other.org_confirms : []).filter((c) => c && c.id !== undefined && !seen.has(c.id)));
              this.feed(api, teamContext, message.type, { pending: merged });
              return;
            }
          }
          this.feed(api, teamContext, message.type, p); // 覆盖式帧透传（B3 吃全量）
        },
      };

      function onEvent(context, message) {
        // #143 Leader 接线：团队域帧（SNAPSHOT 团队字段/三事件）；W-WINPAIR-R2：并行多源下团队域跟
        // 视角源走（cloud 视角吃云帧的团队字段，local/aggregate 吃本机——两源 SNAPSHOT 不互相覆盖团队域）。
        // W-WINPAIR-R3 补：视角错位的 SNAPSHOT 不丢——每源自存完整 payload，setSourceView 切换时
        // 对目标源补喂 Team.onFrame 重建团队域（SNAPSHOT 一次性，错过视角窗口≠永久丢数据）
        // W-PILL4 ④（1016 用户实锤 P1）：切走视角期间本源的 SESSION_LOG 增量被 B2 门控丢弃，
        // 切回后 replay 只补 sessions 不补 logs → 会话最后几条消息丢失。地基层（LAN/云两路共用
        // 本 onEvent）环形缓存每会话日志增量，replaySnapshots 融合下发——切回即全量新。
        if (message.type === "SESSION_LOG" && message.session_id) {
          const buf = context.logBuffer || (context.logBuffer = new Map());
          const arr = buf.get(message.session_id) || [];
          const items = Array.isArray(message.payload) ? message.payload : [];
          for (const l of items) if (l && typeof l === "object") arr.push(l);
          if (arr.length > 300) arr.splice(0, arr.length - 300);
          buf.set(message.session_id, arr);
        }
        if (context === (viewSource() === "cloud" ? cloudCtx : ctx)) Team.onFrame(context, message);
        if (message.type !== "SNAPSHOT" || !Array.isArray(message.payload?.sessions)) return;
        context.lastSnapshotPayload = message.payload; // W-WINPAIR-R3：全字段缓存（projects/org_confirms/acceptances/notifications…）
        // W-WINPAIR-R6 件九：每条会话挂源标识（relay_name）——聚合合并后徽章/色块按源渲染的锚
        const srcTag = message.payload.relay_name || context.relayName || "";
        context.sessions = new Map(message.payload.sessions.filter((session) => session && typeof session.session_id === "string").map((session) => [session.session_id, Object.assign(session, { relay_source: session.relay_source || srcTag })]));
        context.hasSnapshot = true;
        context.relayName = message.payload.relay_name || location.host;
        // W-PILL4 ① 加固：快照到达即刷源胶囊（云快照常滞后于视角切换——setSourceView 瞬间
        // cloudCtx.hasSnapshot 还是 false 显「云桥」，快照几秒后到不刷则胶囊恒停旧名）
        if (typeof refreshSourceSwitchers === "function") refreshSourceSwitchers();
        if (!context.sessions.has(context.selectedSessionId)) context.selectedSessionId = null;
        renderSessionList();
      }

      // 1013 件9（用户反馈：看板清了但页面没变化、找不到刷新入口）：顶栏页内刷新钮。
      // 临时 ws 不带 last_seq 重连一次 → relay 判新客户端推全量 SNAPSHOT → onEvent 幂等
      // 覆盖 + 帧总线 fan-out，各域自动重渲；DOM 不换页，tab/滚动天然保留。主连接
      // 零扰动（2026-09-16 手机下拉刷新教训：断开重连会干断在线源、清在途 ACK 追踪）。
      // 板不随快照走（COMMAND_PROJECT_DETAIL 按需拉）——ccdeck-005-refresh 事件让团队域
      // 对已锚定板 force 重拉；云视角全量重建必须断链重连，不值当——降级 ping-resume
      // 增量补发 + 板重拉。
      let refreshAllInFlight = false;
      // 滚动保持：SNAPSHOT 重走会 replaceChildren 重渲各域列表（session-list 的
      // scrollTop 会归零跳顶）——刷新前记各滚动口，落帧重渲后两拍恢复
      const REFRESH_SCROLL_SEL = [".session-list", "#d-team .workspace-body", "#d-team .team-chat", "#d-project .workspace-body", "#d-notify .notifpanel", "#d-settings .settings-body"]; /* #119：通知改弹窗，滚动位=面板本体 */
      function scrollMark() {
        return REFRESH_SCROLL_SEL.map((sel) => { const el = document.querySelector(sel); return el ? { el, top: el.scrollTop } : null; }).filter(Boolean);
      }
      function scrollRestore(marks) {
        for (const m of marks) { try { if (m.el.isConnected) m.el.scrollTop = m.top; } catch {} }
      }
      function refreshAllData() {
        if (refreshAllInFlight) return;
        const btn = document.querySelector("[data-refresh-all]");
        refreshAllInFlight = true;
        if (btn) btn.classList.add("busy");
        const marks = scrollMark();
        const done = (ok) => {
          requestAnimationFrame(() => requestAnimationFrame(() => scrollRestore(marks))); // 重渲落帧后恢复（rAF 两拍等 replaceChildren 后布局）
          refreshAllInFlight = false;
          if (btn) btn.classList.remove("busy");
          showToast(ok ? "数据已刷新" : "刷新未成功 · 请检查连接后重试");
        };
        const refreshBoards = () => document.dispatchEvent(new CustomEvent("ccdeck-005-refresh")); // 团队域当前组板 force 重拉
        if (viewSource() === "cloud") {
          try { sendCloud(cloudCtx, { t: "ping", last_seq: cloudCtx.sessions.size > 0 ? cloudCtx.lastSeq : 0 }); refreshBoards(); done(true); } catch { done(false); }
          return;
        }
        if (!ctx.cfg || !ctx.cfg.wsUrl || !ctx.cfg.token) { done(false); return; }
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; try { w.close(); } catch {} done(false); } }, 5000);
        let w;
        try {
          w = new WebSocket(ctx.cfg.wsUrl + "?token=" + encodeURIComponent(ctx.cfg.token));
          w.onmessage = (ev) => {
            if (settled) return;
            let msg; try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type !== "SNAPSHOT") return;
            settled = true; clearTimeout(timer);
            if (msg.seq !== undefined) ctx.lastSeq = Math.max(ctx.lastSeq, msg.seq);
            // 滚动快照：SNAPSHOT 重渲会瞬间清空列表内容，容器 scrollTop 被 clamp 归零——
            // 重建完成后同步还原（单据要求：保留当前 tab/滚动位置）
            const scrollKeep = [...document.querySelectorAll(".session-list, .desktop-screen.active .workspace-body, .desktop-screen.active .queue")]
              .map((el) => [el, el.scrollTop]).filter(([, top]) => top > 0);
            onEvent(ctx, msg);
            window.__ccDeck005Frames.emit({ kind: "frame", frame: msg, source: "lan" });
            for (const [el, top] of scrollKeep) el.scrollTop = top;
            try { w.close(); } catch {}
            refreshBoards(); // SNAPSHOT 落地后（Team.snapshot 已清板/loads）再触发板重拉
            done(true);
          };
          w.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); done(false); } };
        } catch { clearTimeout(timer); done(false); }
      }
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-refresh-all]")) refreshAllData();
      });

      document.addEventListener("click", (event) => {
        const target = event.target;
        // W-NOVAFIX B3b：source-menu 开合/选项/模式/管理入口接线；点浮层外一律收起
        const switcher = target.closest(".source-switcher");
        if (!switcher) {
          document.querySelectorAll(".source-menu.open").forEach((menu) => {
            menu.classList.remove("open");
            menu.closest(".source-switcher")?.querySelector("[data-source-trigger]")?.setAttribute("aria-expanded", "false");
          });
        } else {
          const trigger = target.closest("[data-source-trigger]");
          if (trigger) {
            const menu = switcher.querySelector("[data-source-menu]");
            if (menu) { const open = menu.classList.toggle("open"); trigger.setAttribute("aria-expanded", String(open)); }
            return;
          }
          const option = target.closest(".source-option[data-source-choice]");
          if (option) {
            const choice = String(option.dataset.sourceChoice || "");
            // W-WINPAIR-R2：真切换且幂等——cloud=云桥视角（未激活则先并行起云链），local=本机视角。
            // 连接保活不断链；active 态由 refreshSourceSwitchers 按 viewSource 驱动
            if (choice === "cloud") {
              closeSourceMenu(switcher);
              switchToCloudSource(false);
              showToast("视角：云桥 · 连接保持");
              return;
            }
            if (choice === "local") {
              closeSourceMenu(switcher);
              switchToLocalSource();
              showToast("视角：本机 relay · 连接保持");
              return;
            }
            if (choice === "aggregate") { // W-WINPAIR-R3：聚合特殊源行（平级平权，与其他源行同语言）
              closeSourceMenu(switcher);
              setSourceView("aggregate");
              showToast("多源聚合"); /* W-PILL4 ② */
              return;
            }
            const wasActive = option.classList.contains("active");
            switcher.querySelectorAll(".source-option").forEach((el) => el.classList.toggle("active", el === option));
            const name = option.querySelector("strong")?.textContent || "当前源";
            switcher.querySelectorAll("[data-current-source]").forEach((el) => { el.textContent = name; });
            closeSourceMenu(switcher);
            showToast(wasActive ? "当前源 · " + name + "（添加新源走下方 ＋ 入口）" : "已切换数据源 · " + name);
            return;
          }
          // W-WINPAIR：「＋ 添加服务器」恒显入口（client 侧连远程源——壳内云桥/浏览器任意形态）
          const addBtn = target.closest("[data-source-add]");
          if (addBtn) {
            closeSourceMenu(switcher);
            openAddServerUI();
            return;
          }
          // W-NOVAUI ①真因注释留档：source-mode 两钮区已随 W-WINPAIR-R3 退役（聚合入源列表行）；
          // 下方 modeBtn 分支保留作 data-source-mode 残留元素的兼容兜底（正常路径不再触达）
          const modeBtn = target.closest(".source-mode [data-source-mode]");
          if (modeBtn) {
            const nextMode = modeBtn.dataset.sourceMode === "aggregate" ? "aggregate" : "single";
            // W-WINPAIR-R2：模式按钮接真视角（test.19 回归②）——aggregate=全部源会话合并展示，
            // single=回上次单源视角；setSourceView 统一做 dataset/键/按钮五壳归位+数据重放
            if (typeof setSourceView === "function") {
              if (nextMode === "aggregate") setSourceView("aggregate");
              else { const prev = (() => { try { return localStorage.getItem("cc-deck-005-source-view"); } catch { return null; } })(); setSourceView(prev === "cloud" ? "cloud" : "local"); }
            } else {
              document.body.dataset.sourceMode = nextMode;
              try { localStorage.setItem("cc-deck-005-source-mode", nextMode); } catch (_) {} // FB1：模式记忆（setSourceView 不可用时的旧路径兜底）
              document.querySelectorAll(".source-switcher [data-source-mode]").forEach((el) => el.classList.toggle("active", el.dataset.sourceMode === nextMode));
            }
            showToast(nextMode === "aggregate" ? "多源聚合 · 全部源会话合并展示" : "单源视图");
            closeSourceMenu(switcher); // W-WINPAIR-R2：模式切换后收菜单（与源行点击同口径）
            return;
          }
          const manage = target.closest("[data-source-settings]");
          if (manage) {
            // W-NOVAUI ①：直落连接子面板（setDesktopDomain 只切域不置 tab，nova 实测点了没反应感）
            event.preventDefault();
            closeSourceMenu(switcher);
            openCloudPairUI();
            return;
          }
        }
        // W-NOVAUI ②：自绘三钮接 tauri v2 窗口 API（withGlobalTauri 已开；#365 权限已授权）
        const winBtn = target.closest("[data-w]");
        if (winBtn) {
          const tauriWin = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow ? window.__TAURI__.window.getCurrentWindow() : null;
          if (!tauriWin) return; // 浏览器态无壳 API：静默兜底
          if (winBtn.dataset.w === "min") void tauriWin.minimize();
          else if (winBtn.dataset.w === "max") void tauriWin.toggleMaximize();
          else if (winBtn.dataset.w === "close") void tauriWin.close();
          return;
        }
        const badge = target.closest(".source-badge");
        if (badge) { openSourceMenu(); return; }
        const railButton = target.closest(".rail-btn[data-domain]");
        if (railButton) {
          // #119 通知改 V3 弹窗形态：铃铛不再切域，开/关锚定浮层（Esc/遮罩/×/再点同关）
          if (railButton.dataset.domain === "notify") { window.__ccDeck005NotifyPanel?.toggle(); return; }
          setDesktopDomain(railButton.dataset.domain); return;
        }
        const themeToggle = target.closest("[data-theme-toggle]");
        if (themeToggle) { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", true); return; }
        const densityBtn = target.closest("[data-card-density-option]"); // FB9 补：密度档桌面侧曾无点击链（移动端借道点桌面钮也断在此）
        if (densityBtn) { applyCardDensity(densityBtn.dataset.cardDensityOption, true); return; }
        const mobileRoot = target.closest("[data-mobile-root]");
        if (mobileRoot) { openMobileRoot(mobileRoot.dataset.mobileRoot); return; }
        if (target.closest(".mobile-notify")) { openMobileRoot("notify"); return; }
        const inspectorToggle = target.closest("[data-inspector-toggle]");
        if (inspectorToggle) {
          // W-NOVAFIX B4：1279px 拦截退役——grid minmax(0,1fr) 自带弹性，窄窗直接展开/收起不限宽
          const screen = inspectorToggle.closest(".desktop-screen");
          const collapsed = screen.classList.contains("inspector-collapsed");
          const nextCollapsed = !collapsed;
          screen.dataset.inspectorManual = nextCollapsed ? "collapsed" : "expanded";
          try { localStorage.setItem(inspectorStateKey(screen), nextCollapsed ? "collapsed" : "expanded"); } catch (_) {} // FB6 恢复
          setInspectorCollapsed(screen, nextCollapsed);
          return;
        }
        const card = target.closest("#d-session [data-session-card]");
        if (card) {
          if (target.closest(".srow-cta")) { showToast("处理会话 · 待 B2 迁移"); return; }
          ctx.selectedSessionId = card.dataset.sessionCard;
          if (sessionList.dataset.b2Owned === "1") {
            // #143 盲评A-1 止血：B2 接管后地基不重渲列表，选中态由地基点改 class
            //（B2 的 MutationObserver 监听 class 变化同步工作区，renderMyList 同按 S.selected 打标，口径一致）
            sessionList.querySelectorAll(".queue-card.selected").forEach((el) => el.classList.remove("selected"));
            card.classList.add("selected");
            return;
          }
          renderSessionList();
          return;
        }
        const stubButton = target.closest("[data-stub] button, [data-stub] a");
        if (stubButton) {
          event.preventDefault();
          showToast("此功能即将开放");
        }
      });
      // ---------- W-ICON ⓪/②：快捷键统一键位系统（映射存储 + 平台归一匹配 + 捕获改键） ----------
      // 排查结论（新反馈⑭「5 个快捷键全失效」）：005 壳此前只接了 Ctrl+K（W-NOVAFIX B3c），
      // 设置面板展示的 Ctrl+N / Ctrl+↑↓ / Ctrl+←→ 三条键链从未落地（旧壳 #67 键链未移植，
      // 只有「让位全局键链」的让位侧）——「按了不生效」的真因是 handler 缺失，不是平台判断劈叉。
      // 本块补齐三条链，全部改走键位映射表，并为 ② 自定义捕获铺底。存储口径：
      //   cc-deck-005-keys   = {"search":"ctrl+k","new":"ctrl+n"}（单组合类；缺省读默认值）
      //   ccd_toggle_key     = 呼出/收起全局键（沿用旧壳 #8 键名；""=已注销、null=默认 Alt+D）
      //   cc-deck-005-kb-mod = 方向键修饰档（切会话/切源共用）：alt|ctrl，默认 ctrl
      // 组合串归一：修饰键 alt<ctrl<shift 升序 + 末位单键（字母/数字/F1-12/space）；
      // meta 录制即归一为 ctrl（Mac ⌘ 与 Win Ctrl 同一存储形），匹配时 ctrl 命中 ctrl||meta——
      // 双平台一套映射串。方向键档位不吃 meta（⌘±←→ 是 Mac 行首行尾，旧壳 kbModHit 同口径）
      const KEYMAP_STORE = "cc-deck-005-keys";
      const KBMOD_STORE = "cc-deck-005-kb-mod";
      const KEYMAP_DEFAULTS = { search: "ctrl+k", new: "ctrl+n" };
      const ACTION_NAMES = { search: "全局搜索", new: "新建会话", toggle: "呼出 / 收起面板" };
      function keymapLoad() {
        const out = {};
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(KEYMAP_STORE) || "{}"); } catch (_) { raw = {}; }
        for (const key of Object.keys(KEYMAP_DEFAULTS)) out[key] = raw && typeof raw[key] === "string" && raw[key] ? raw[key] : KEYMAP_DEFAULTS[key];
        return out;
      }
      function keymapSave(map) { try { localStorage.setItem(KEYMAP_STORE, JSON.stringify(map)); } catch (_) {} }
      function kbMod() {
        try { return localStorage.getItem(KBMOD_STORE) === "alt" ? "alt" : "ctrl"; } catch (_) { return "ctrl"; }
      }
      // 事件 → 归一组合串（含修饰键才收，防吞普通输入）；meta 计入 ctrl（Mac ⌘ 录制同形）
      function comboFromEvent(ev) {
        const mods = [];
        if (ev.altKey) mods.push("alt");
        if (ev.ctrlKey || ev.metaKey) mods.push("ctrl");
        if (ev.shiftKey) mods.push("shift");
        if (!mods.length) return null;
        if (["Alt", "Control", "Shift", "Meta"].includes(ev.key)) return null;
        let key = null;
        if (/^F([1-9]|1[0-2])$/.test(ev.key)) key = ev.key.toLowerCase();
        else if (ev.key === " ") key = "space";
        else if (ev.key.length === 1) key = ev.key.toLowerCase();
        if (!key) return null;
        return [...mods, key].join("+");
      }
      // 组合串命中：ctrl 档命中 ctrl||meta（Mac ⌘K 与 Win Ctrl+K 同串），其余修饰严格相等
      function comboHit(ev, combo) {
        if (!combo) return false;
        const parts = combo.split("+");
        const key = parts[parts.length - 1];
        if ((parts.includes("alt")) !== ev.altKey) return false;
        if ((parts.includes("shift")) !== ev.shiftKey) return false;
        if (parts.includes("ctrl") ? !(ev.ctrlKey || ev.metaKey) : (ev.ctrlKey || ev.metaKey)) return false;
        return ev.key.toLowerCase() === key || (key === "space" && ev.code === "Space");
      }
      // 展示形：Mac ⌘/⌥ 符号、Win Ctrl+/Alt+ 前缀；ctrl 存储串在 Mac 显示 ⌘（主修饰惯例）
      function comboDisplay(combo) {
        if (!combo) return "未设置";
        const parts = combo.split("+");
        const key = parts[parts.length - 1] === "space" ? "Space" : parts[parts.length - 1].toUpperCase();
        const modText = IS_MAC ? { alt: "⌥", ctrl: "⌘", shift: "⇧" } : { alt: "Alt+", ctrl: "Ctrl+", shift: "Shift+" };
        return parts.slice(0, -1).map((m) => modText[m] || m + "+").join("") + key;
      }
      function keyDisplay(action) { return comboDisplay(keymapLoad()[action]); }
      function kbmodDisplay(dirs) { return (kbMod() === "alt" ? "Alt" : "Ctrl") + " + " + dirs; } // 方向键档不吃 meta，双平台都直显 Ctrl/Alt
      // 捕获态（②）：capture 阶段拦键，Esc 取消、点外取消、Backspace 清空（呼出键=注销）
      let keyCapture = null;
      function refreshKeyChips() {
        const map = keymapLoad();
        document.querySelectorAll("[data-keymap-chip]").forEach((chip) => {
          if (chip.classList.contains("capturing")) return;
          const action = chip.dataset.keymapChip;
          chip.textContent = action === "toggle" ? toggleHotkeyDisplay() : comboDisplay(map[action]);
        });
        document.querySelectorAll("[data-kbmod-chip]").forEach((chip) => {
          chip.textContent = kbmodDisplay(chip.dataset.kbmodChip === "session" ? "↑↓" : "←→");
        });
      }
      function startKeyCapture(action, chip) {
        if (keyCapture) keyCapture.cleanup();
        chip.classList.add("capturing");
        chip.textContent = "按下新组合…";
        const cancelByPointer = (ev) => { if (ev.target.closest && ev.target.closest(".kbd-chip.capturing")) return; cleanup(); };
        const onKey = (ev) => {
          ev.preventDefault(); ev.stopImmediatePropagation();
          if (ev.key === "Escape") { cleanup(); return; }
          if (ev.key === "Backspace") {
            cleanup();
            if (action === "toggle") applyToggleKey("");
            else showToast("页面快捷键不可清空 · 已保留原键位");
            return;
          }
          const combo = comboFromEvent(ev);
          if (!combo) { chip.textContent = "需含修饰键（Alt/Ctrl/Shift + 字母/数字/F1-12）"; return; }
          cleanup();
          if (action === "toggle") { applyToggleKey(combo); return; }
          const map = keymapLoad();
          for (const other of Object.keys(KEYMAP_DEFAULTS)) {
            if (other !== action && map[other] === combo) { showToast("与「" + ACTION_NAMES[other] + "」键位冲突 · 未修改"); refreshKeyChips(); return; }
          }
          map[action] = combo;
          keymapSave(map);
          refreshKeyChips();
          showToast(ACTION_NAMES[action] + " 键位已改为 " + comboDisplay(combo));
        };
        const cleanup = () => {
          chip.classList.remove("capturing");
          if (keyCapture && keyCapture.chip === chip) keyCapture = null;
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("pointerdown", cancelByPointer, true);
          refreshKeyChips();
        };
        keyCapture = { action, chip, cleanup };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("pointerdown", cancelByPointer, true);
      }
      // 呼出/收起全局键改绑（旧壳 #8 通道）：桌面壳经 set_toggle_shortcut 重注册（先注销旧键）；
      // 注册失败（键位被占）不落库；浏览器无壳不可改
      function applyToggleKey(combo) {
        const core = window.__TAURI__ && window.__TAURI__.core;
        if (!(core && typeof core.invoke === "function")) { showToast("浏览器形态不支持全局快捷键"); refreshKeyChips(); return; }
        core.invoke("set_toggle_shortcut", { combo }).then(() => {
          try { localStorage.setItem("ccd_toggle_key", combo); } catch (_) {}
          refreshKeyChips();
          showToast(combo ? "呼出键已改为 " + comboDisplay(combo) : "已注销呼出快捷键");
        }, (e) => {
          showToast(String((e && e.message) || e || "注册失败（可能被其他应用占用）"), 5000);
          refreshKeyChips();
        });
      }
      function resetKeymap() {
        keymapSave({});
        try { localStorage.removeItem(KBMOD_STORE); } catch (_) {}
        const core = window.__TAURI__ && window.__TAURI__.core;
        if (core && typeof core.invoke === "function") {
          void core.invoke("set_toggle_shortcut", { combo: "alt+d" }).then(() => {
            try { localStorage.removeItem("ccd_toggle_key"); } catch (_) {} // null=默认值，展示层读默认
            refreshKeyChips();
          }, () => { refreshKeyChips(); });
        } else {
          try { localStorage.removeItem("ccd_toggle_key"); } catch (_) {}
          refreshKeyChips();
        }
        showToast("已恢复默认键位");
      }
      // 启动纠正（旧壳范式）：壳侧 setup 注册的默认键按 localStorage 记忆覆盖（含 ""=注销）
      if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
        let savedToggle = null;
        try { savedToggle = localStorage.getItem("ccd_toggle_key"); } catch (_) {}
        if (savedToggle !== null) void window.__TAURI__.core.invoke("set_toggle_shortcut", { combo: savedToggle }).catch(() => {});
      }
      // 键链动作（⓪ 补缺）：新建会话=跳会话域点「+」（B2 弹窗开合钮）；↑↓ 步进选中卡
      //（与点击选中同路径：B2 接管期只改 class 同步工作区，地基期全量重渲）；←→ 步进源选项
      function newSessionShortcut() {
        if (!document.querySelector("#stage-desktop.active")) return;
        if (!document.querySelector("#d-session.active")) setDesktopDomain("session");
        const plus = document.querySelector("#d-session .queue-head button.icon-btn");
        if (plus) plus.click();
      }
      function stepSession(dir) {
        const cards = [...sessionList.querySelectorAll(".queue-card[data-session-card]")].filter((c) => c.offsetParent !== null);
        if (!cards.length) return;
        const i = cards.findIndex((c) => c.classList.contains("selected"));
        const next = i < 0 ? (dir > 0 ? 0 : cards.length - 1) : (i + dir + cards.length) % cards.length;
        const card = cards[next];
        ctx.selectedSessionId = card.dataset.sessionCard;
        if (sessionList.dataset.b2Owned === "1") { // #143 盲评A-1 同口径：B2 接管期地基只改 class
          sessionList.querySelectorAll(".queue-card.selected").forEach((el) => el.classList.remove("selected"));
          card.classList.add("selected");
        } else renderSessionList();
        card.scrollIntoView({ block: "nearest" });
      }
      function stepSource(dir) {
        const options = [...(activeSourceSwitcher()?.querySelectorAll(".source-option[data-source-choice]") || [])];
        if (options.length < 2) return; // 单源无可切（静默，同旧壳 chips.length<2 口径）
        const i = options.findIndex((o) => o.classList.contains("active"));
        options[((i < 0 ? 0 : i + dir) + options.length) % options.length].click();
      }
      function typingInField(event) {
        const t = event.target;
        if (!(t && t.closest && t.closest("input, textarea, [contenteditable]"))) return false;
        return !t.closest('[data-composer="session"]'); // 消息输入框豁免（旧壳 #68：切完键链焦点就在输入框）
      }
      function transientOverlayOpen() {
        return !!document.querySelector(".source-menu.open, #b2-create-pop, #row-menu.open, [data-filter-pop], [data-pair-pop], .artifact-menu.open, .artifact-sheet-backdrop.open, #update-confirm-backdrop"); // UIPOLISH2 件七：更新对话框在场时全局键让位
      }
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeTransientOverlays();
        if (keyCapture) return; // 捕获态已在上游 capture 阶段拦截，此为双保险
        if (event.isComposing) return;
        const map = keymapLoad();
        if (comboHit(event, map.search)) { event.preventDefault(); openSourceMenu(); return; } // W-NOVAFIX B3c 语义入表
        if (comboHit(event, map.new)) { event.preventDefault(); newSessionShortcut(); return; }
        // 方向键族：Alt/Ctrl 档（不吃 meta 与 shift），输入控件不抢、浮层开着不抢
        if (!event.shiftKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
          const mod = kbMod();
          const modOk = mod === "alt" ? (event.altKey && !event.ctrlKey && !event.metaKey) : (event.ctrlKey && !event.altKey && !event.metaKey);
          if (modOk && !typingInField(event) && !transientOverlayOpen() && document.querySelector("#stage-desktop.active")) {
            if ((event.key === "ArrowUp" || event.key === "ArrowDown")) {
              if (document.querySelector("#d-session.active")) { event.preventDefault(); stepSession(event.key === "ArrowDown" ? 1 : -1); }
              return;
            }
            event.preventDefault();
            stepSource(event.key === "ArrowRight" ? 1 : -1);
          }
        }
      });
      window.addEventListener("pagehide", () => {
        if (cloudMode) cloudDisconnect(); // 云链卸载：掐轮询循环/看门狗/心跳/重连定时器，桥侧会话自然超时回收
        ctx.stopped = true;
        Team.bind(false); Team.failFlights(); // #143 盲评C-5：离线三态完备（onclose/pagehide 双口都告知 B3）
        clearTimeout(ctx.reconnectTimer);
        clearTimeout(ctx.lanHsTimer);
        if (ctx.ws) {
          ctx.ws.onclose = null;
          ctx.ws.close();
        }
      });
      // #B3-1/#B3-2 旧壳偏好一次性迁移：新键从未写过才读旧键（旧壳 ccr_theme 存 dark/light；
      // ccd_list_compact 存 1/0——紧凑映射 compact、其余 standard，005 三档无 cozy 档，偏差见回执）。
      // 新键已存在（本壳写过或迁移过）则原值不动。
      let savedTheme = "dark";
      try {
        savedTheme = localStorage.getItem("cc-deck-theme");
        if (savedTheme === null) {
          const legacyTheme = localStorage.getItem("ccr_theme");
          if (legacyTheme === "dark" || legacyTheme === "light") { savedTheme = legacyTheme; localStorage.setItem("cc-deck-theme", legacyTheme); }
          else savedTheme = "dark";
        }
      } catch (_) {}
      let savedCardDensity = "standard";
      try {
        savedCardDensity = localStorage.getItem("cc-deck-card-density");
        if (savedCardDensity === null) {
          const legacyCompact = localStorage.getItem("ccd_list_compact");
          if (legacyCompact !== null) { savedCardDensity = legacyCompact === "1" ? "compact" : "standard"; localStorage.setItem("cc-deck-card-density", savedCardDensity); }
          else savedCardDensity = "standard";
        }
      } catch (_) {}
      ensureThemeSymbols();
      setupSettingsDomain(); // ⑥c-1：先建六面板（含连接三子 tab），setupStubTabs 对 settings 域让位
      // W-NOVAUI ④：rail 项目入口恒显（FB20 显隐链全退役，无首帧即位调用）
      setupStubTabs();
      wireCardDensityControls();
      applyTheme(savedTheme);
      applyCardDensity(savedCardDensity);
      applyUiScale((() => { try { return localStorage.getItem("cc-deck-005-ui-scale") || "100"; } catch (_) { return "100"; } })()); // FB10：字号档恢复
      // P0 视觉接线：原型手动视口切换工具条退役——按视口宽度自动切桌面/手机形态（720px 分界，
      // 随窗口变化动态切；老 Safari 无 addEventListener 时退 addListener）
      const viewportQuery = window.matchMedia("(max-width: 720px)");
      const applyViewportMode = () => setMode(viewportQuery.matches ? "mobile" : "desktop");
      applyViewportMode();
      if (typeof viewportQuery.addEventListener === "function") viewportQuery.addEventListener("change", applyViewportMode);
      else if (typeof viewportQuery.addListener === "function") viewportQuery.addListener(applyViewportMode);
      if (window.__ccDeck005B4) window.__ccDeck005B4.jumpMode = setMode; // 手机脚本 jumpDesktop 借道
      initInspectors();
      initQueueResizers(); // W-TOPBAR ⑤ 第二列拖宽
      initSettingsLiveData();
      initSourceModeState(); // FB1：源显示模式恢复（body 态 + 五壳按钮）
      refreshSourceSwitchers(); // FB1：占位文案即刻退役
      window.__ccDeck005B4?.subscribe(() => refreshSourceSwitchers()); // 连接态/快照到达即同步全部壳
      renderSessionList();
      bootstrapConnection();
      // #158-批3 桌面壳周期自愈（旧壳 12400-12410 的 90s/6s 窗口，升级为真重连）：连接
      // offline/unconfigured 且桌面形态时每 6s 重探本机 relay——Defender 冷扫描让 relay 晚起、
      // 或 token 轮换后旧 token 401 永不自愈（#21），重探命中即刷 token 重走连接链。
      // online/connecting 不动作（ws 层自带退避重连）；15 次未果（约 90s）停表
      if (shellProbe) {
        let healTries = 0;
        const healTimer = setInterval(async () => {
          if (ctx.stopped) { clearInterval(healTimer); return; }
          const conn = ctx.status; // W-WINPAIR-R2：并行多源下 healTimer 只看本机链自身状态（桥 connection 会随视角在云态，不再当本机健康判据）
          if (conn === "online" || conn === "connecting") { clearInterval(healTimer); return; }
          if (++healTries > 15) { clearInterval(healTimer); return; }
          const again = await probeLocalRelay();
          if (ctx.stopped) { clearInterval(healTimer); return; } // W-WINPAIR：probe 等待期间切到云源——本机重连作废
          if (again) {
            applyLocalProbe(again);
            ctx.probing = false;
            connectLan(ctx);
            clearInterval(healTimer); // 连接链接管后续重试
          }
        }, 6000);
      }
      // #158-批3 桌面壳启动检查更新（旧壳 8643-8653 范式）→ UIPOLISH2 件七（2026-10-11 用户拍板）
      // 改提醒制：5s 后台查一次，命中新版**不再静默 downloadAndInstall**（自动覆盖用户安装位——
      // test.15 被降级覆盖同族风险），改弹提醒对话框（版本号+notes+立即更新/忽略此版本）；
      // 「忽略此版本」按版本号记 localStorage，同版本不再自动弹（手动检查仍弹）；门控保持
      setTimeout(() => {
        try {
          if (!UPDATER_BLOCKED && window.__TAURI__ && window.__TAURI__.updater) {
            shellCheckUpdate().then((r) => {
              if (r && r.available && r.version !== updateIgnoredVersion()) openUpdateDialog(r);
            }).catch(() => {});
          }
        } catch (_) {}
      }, 5000);
      setInterval(() => {
        if (sessionList.dataset.b2Owned === "1") return; // #143 盲评A-2：B2 自有走秒定时器，双写互覆盖让位
        sessionList.querySelectorAll(".queue-card").forEach((card) => {
          const session = ctx.sessions.get(card.dataset.sessionCard);
          const elapsed = card.querySelector(".srow-sec");
          if (elapsed && session) elapsed.textContent = sessionItem(session).workSecs + "s";
        });
      }, 1000);
    })();
  