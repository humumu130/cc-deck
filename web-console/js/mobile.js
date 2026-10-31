    (() => {
      // ---------- ⑥c-2 移动端 B7：四屏真数据 + 导航栈（原型 openMobileRoot/openMobileDetail/closeMobileDetail 同构） ----------
      const bridge = window.__ccDeck005B4;
      if (!bridge) return;
      // W-BLANKSET P0 根修：b2Api 访问器复活——#150 R2 B2 并轨时原定义被删而手机块 10 处
      // 调用未清（悬空 ReferenceError：setupMobileDetail→syncMobileComposer 首炸，同 IIFE
      // 后续 refreshMobile()+订阅全断→窄视口/DPI 缩放进手机模式后四屏动态内容全空，
      // 1016 用户 Windows test.31 实锤）。真身=window.__ccDeck005B2（6856 导出面注释
      // 明写「005-mobile IIFE 复用」）；全部调用点 api&& 防御式，缺桥返回 null 走各自 fallback。
      const b2Api = () => window.__ccDeck005B2 || null;
      // ⑥d：桌面壳版本优先（foundation invoke app_version 异步回填后才就位，改为读时取值）
      const VER_NOW = () => window.__shellVer || window.__ccDeck005Version || "";
      // #158-批3 状态遮蔽（R4 同款口径）：曾收 SNAPSHOT 但连接已 offline/unconfigured 时
      // 不再谎报「在线」，显示连接实际态
      const connStateText = () => {
        const c = bridge.connection;
        if (bridge.hasSnapshot && c !== "offline" && c !== "unconfigured") return "在线";
        return c === "connecting" ? "连接中" : c === "unconfigured" ? "未配置" : "未连接";
      };
      const connMaskedOk = () => bridge.hasSnapshot && bridge.connection !== "offline" && bridge.connection !== "unconfigured";
      // #158-⌘文案：与 foundation IIFE 作用域不通，独立定义同款常量
      const IS_MAC = /Mac/i.test(navigator.userAgent);
      const MOD_KEY = (k) => IS_MAC ? "⌘" + k : "Ctrl+" + k;
      // #158-批4a：B2 IIFE 挂的全页共享路径助手（展示 \ 化 / 归一比较 / 跨分隔符基名）
      const displayPath = window.__ccDeck005PathUi.displayPath;
      const baseName = window.__ccDeck005PathUi.baseName;
      const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      const oneLine = (t) => { const v = String(t ?? "").replace(/\s+/g, " ").trim(); return v.length > 60 ? v.slice(0, 60) + "…" : v; };
      const svg = (name) => `<svg class="icon-inline" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
      const ENGINE_SHORT = { claude: "Claude", codex: "Codex", trae: "Trae", "qwen-code": "Qwen", codebuddy: "CodeBuddy", zcode: "ZCode" };
      const ENGINE_BADGE = { claude: "claude", codex: "codex", trae: "trae", "qwen-code": "qwen", codebuddy: "codebuddy", zcode: "zcode" };
      const STATUS_TAG = { WORKING: ["运行中", "info"], WAITING: ["待处理", "action"], ERROR: ["错误", "danger"], DONE: ["完成", "done"] };
      // #291 帧分类判活：WORKING 过真判定（#d-session 域 session-domain 挂的全局；缺=老壳降级原样）——待命不占在跑计数
      const isRealW = (s) => (window.__ccDeck005IsRealWorking ? window.__ccDeck005IsRealWorking(s) : true);
      const stTag = (s) => (s.pm_standby && s.status !== "WORKING") ? ["待命", "waiting"] : (STATUS_TAG[s.status] || ["完成", "done"]); // #287 值守 PM 待命态替代 DONE 假死；UI 反馈批 1029 件A：桥缓存 pm_standby 只随快照派生，PM 开工翻 WORKING 后陈标残留=干活中显「待命」矛盾——非 WORKING 态才标（干活期走 STATUS_TAG 正常显示）
      const mToast = (msg) => { const t = document.getElementById("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(mToast._t); mToast._t = setTimeout(() => t.classList.remove("show"), 2400); };
      const allSessions = () => [...bridge.sessions.values()];
      const needAction = (s) => s.status === "WAITING" || s.status === "ERROR";
      const byPinnedUpdated = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated_at || 0) - (a.updated_at || 0);
      const sessionTitle = (s) => oneLine(s.title || s.initial_prompt || s.session_id);
      const engineBadge = (s) => s && s.engine ? (window.__ccDeck005EngineBadgeHtml ? window.__ccDeck005EngineBadgeHtml(ENGINE_BADGE[s.engine] || s.engine, esc(ENGINE_SHORT[s.engine] || s.engine)) : `<span class="engine-badge ${ENGINE_BADGE[s.engine] || ""}">${esc(ENGINE_SHORT[s.engine] || s.engine)}</span>`) : ""; // UI 精修二批：品牌单表借道（PM 收割织合：engine 取 round2 借道版）
      // W-SRC2 #134（本批①三端一致）：源徽章 per-session 化——relay SNAPSHOT 现随每卡下发
      // relay_source（wan resume 面本批补齐后三通道全覆盖），聚合双源下逐卡显真实归属名；
      // 无标卡回落本源名（单源观感不变）。无会话上下文的调用点（组织确认卡/引擎分组）不传参走回落。
      const sourceBadge = (s) => { const raw = (s && typeof s.relay_source === "string" && s.relay_source) || bridge.relayName || location.host; const n = window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(raw) : raw; return `<span class="source-badge">${esc(n)}</span>`; }; // 件十三：命名映射统一（PM 收割织合：source 保 W-SRC2 per-session 版）
      const catalog = () => { const snap = bridge.snapshot && typeof bridge.snapshot === "object" ? bridge.snapshot : {}; const caps = snap.source_capabilities || {}; return Array.isArray(caps.engine_catalog) ? caps.engine_catalog : null; };
      const getSessionProject = (s) => { // #158-批4a：前缀匹配归一化（与 B2 getSessionProject 同口径）
        const cwd = String((s && s.cwd) || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
        const projects = Array.isArray(bridge.projects) ? bridge.projects : [];
        if (cwd) {
          const hit = projects.find((p) => {
            if (!(p && typeof p.anchor_dir === "string" && p.anchor_dir)) return false;
            const a = p.anchor_dir.replace(/[\\/]/g, "/").replace(/\/+$/, "");
            return a === cwd || cwd.startsWith(a + "/");
          });
          if (hit && hit.name) return hit.name;
        }
        return cwd ? (cwd.split("/").filter(Boolean).pop() || cwd) : "未归属目录";
      };
      const mBgCount = (s) => (s.subagents ?? []).filter((a) => !a.ended_at).length; // #164 ⑂N 徽标数据
      const mobileCard = (s) => {
        const [w] = stTag(s); // w 仅作摘要兜底文案；状态文字标签退役（头像图标/角色已表达状态）
        const icon = s.status === "ERROR" ? "alert" : s.status === "WAITING" ? "clock" : "check";
        const ava = s.status === "ERROR" ? "status-alert" : s.status === "WAITING" ? "status-action" : "status-ok";
        const bg = mBgCount(s);
        return `<div class="mobile-card" data-open-detail="${esc(s.session_id)}"><div class="row"><span class="avatar ${ava}"><svg class="icon-status" aria-hidden="true"><use href="#icon-${icon}"></use></svg></span><strong>${esc(sessionTitle(s))}</strong></div><p>${esc(oneLine(s.action_summary) || oneLine(displayPath(s.cwd)) || w)}</p><div class="identity-cluster">${engineBadge(s)}${sourceBadge(s)}${bg ? `<span class="bg-badge" title="后台子 Agent 在跑">⑂${bg}</span>` : ""}</div></div>`;
      };

      // ---------- 导航栈 ----------
      let mobileReturn = "inbox";
      const screenOf = (root) => document.querySelector(`#m-${root}`);
      const setSingleActive = (el) => document.querySelectorAll(".mobile-screen").forEach((sc) => sc.classList.toggle("active", sc === el));
      function openMobileRoot(root) {
        const target = screenOf(root);
        if (!target) return;
        mobileReturn = root;
        setSingleActive(target);
        document.querySelectorAll(".mobile-nav [data-mobile-root]").forEach((b) => b.classList.toggle("active", b.dataset.mobileRoot === root));
        if (root === "inbox") { const list = target.querySelector(".mobile-content"); if (list) list.scrollTop = 0; }
      }
      function hideNotifyDetail() { const d = document.querySelector("[data-notify-source-detail]"); if (d) d.hidden = true; }
      function openMobileNotify() {
        const target = screenOf("notify");
        if (!target) return;
        const active = document.querySelector(".mobile-screen.active");
        if (active && active.id !== "m-notify" && active.id !== "m-detail") mobileReturn = ["inbox", "team", "project", "settings"].includes(active.id.replace("m-", "")) ? active.id.replace("m-", "") : "inbox";
        hideNotifyDetail();
        setSingleActive(target);
      }
      function openMobileDetail(sid) {
        const target = screenOf("detail");
        if (!target) return;
        const active = document.querySelector(".mobile-screen.active");
        if (active && active.id !== "m-detail") { const root = active.id.replace("m-", ""); mobileReturn = ["inbox", "team", "project", "settings", "notify"].includes(root) ? root : "inbox"; }
        detailSid = sid; // ⑥c-3：五 tab 真数据锚定
        const s = bridge.sessions.get(sid);
        const titleEl = document.querySelector("#mobile-detail-title");
        if (titleEl && titleEl.firstChild) titleEl.firstChild.textContent = s ? sessionTitle(s) : "会话详情";
        const sub = document.querySelector("#mobile-detail-sub");
        if (sub) sub.textContent = s ? (displayPath(s.cwd) || "目录未记录") : "";
        const idn = document.querySelector("#mobile-detail-identity");
        if (idn) idn.innerHTML = engineBadge(s || {}) + sourceBadge(s);
        const tag = target.querySelector(".mobile-head .tag.action");
        if (tag) { const [w] = s ? stTag(s) : ["详情", "info"]; tag.textContent = s && needAction(s) ? "待处理" : w; }
        setSingleActive(target);
        renderMobileDetail(sid); // ⑥c-3：五 pane + 状态坞真数据
        document.querySelector("#m-detail .mobile-detail-tabs button")?.click(); // 回到「对话」tab（原型开屏形态；tab wire 由地基持有）
        const back = document.querySelector("[data-mobile-back]");
        if (back) back.textContent = mobileReturn === "notify" ? "‹ 通知" : "‹";
      }
      function closeMobileDetail() {
        const detail = screenOf("detail");
        if (detail) detail.classList.remove("active");
        if (mobileReturn === "notify") { openMobileNotify(); const back = document.querySelector("[data-mobile-back]"); if (back) back.textContent = "‹"; return; }
        const home = screenOf(mobileReturn);
        if (home) home.classList.add("active");
      }
      function jumpDesktop(domain) {
        if (typeof bridge.jumpMode === "function") bridge.jumpMode("desktop");
        bridge.railJump(domain || "session");
        mToast("已切桌面 · 定位" + (domain === "team" ? "团队" : domain === "project" ? "项目" : "会话") + "域");
      }
      async function mobileAckNotify(key) {
        const ack = await bridge.sendCommand("COMMAND_NOTIFICATION_ACK", { notification_key: key, action: "handled" });
        if (ack && ack.ok === true) mToast("已标记已读 · 权威账面同步中");
        else mToast("通知处理失败" + (ack && ack.error ? "：" + ack.error : "（未连接或超时）"));
        refreshMobile();
      }

      // ---------- ⑥c-3 m-detail 五 tab 真数据（对话/任务/输出物/用量/⋯；B2 数据面 + 桌面口径复刻） ----------
      let detailSid = "";
      let detailBase = null; // { content, convHost, conv, tasks, arts, usage, more }
      // #124 tab 往返滚动保持（手机同桌面 S.tabChatMemo 口径）：手机形态 .mode-stage 无高度
      // 约束，真滚动容器是 document（window 滚动；.mobile-content 自身被内容撑高、scrollTop
      // 恒 0——CDP 实测）。切走对话 pane display:none → document scrollHeight 骤缩 → window
      // scrollY 被 clamp。离开瞬间（捕获阶段）记 memo，切回（activate 完成后）恢复，贴底态
      // 恢复贴底；换会话（sid 不匹配）不恢复。
      let mTabChatMemo = null;
      (() => {
        const bar = document.querySelector("#m-detail .mobile-detail-tabs");
        if (!bar) return;
        const se = () => document.scrollingElement || document.documentElement;
        const btns = [...bar.querySelectorAll("button")];
        bar.addEventListener("click", (ev) => {
          const btn = ev.target.closest("button");
          const idx = btn ? btns.indexOf(btn) : -1;
          if (idx < 0) return;
          if (idx !== 0 && btns[0]?.classList.contains("active")) { // 离开对话 tab：DOM 未变，真值
            if (detailSid) {
              const el = se();
              mTabChatMemo = { sid: detailSid, top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - window.innerHeight < 120 };
            }
          } else if (idx === 0) { // 回到对话 tab：activate 完成后恢复
            setTimeout(() => {
              const memo = mTabChatMemo;
              mTabChatMemo = null;
              if (!memo || memo.sid !== detailSid) return;
              const el = se();
              el.scrollTop = memo.bottom ? el.scrollHeight : Math.max(0, Math.min(memo.top, el.scrollHeight - window.innerHeight));
            }, 0);
          }
        }, true);
      })();
      // #169 手机详情当前会话暴露（桌面文档级拖放收件时借道定位 sid，替代桌面 S.selected）
      if (window.__ccDeck005B4) window.__ccDeck005B4.currentDetail = () => detailSid;
      const DETAIL_TL_MAX = 30;
      const VERIFY_RE_M = /[〔\[【]\s*待验证\s*[〕\]】]/; // 与 B2 任务 tab 四组制同口径（#85 待验证档）
      const M_DOCK_STATE = { WORKING: "running", WAITING: "waiting", ERROR: "suspended", DONE: "closing" }; // 态位与 CSS/B2 DOCK_STATE 同集（B21 态图标承态）
      const mTokStr = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M"; if (n >= 1e3) return Math.round(n / 1e3) + "k"; return String(n); };
      const mCtxPct = (s) => (!s || !s.context_usage) ? 0 : Math.min(100, Math.round((s.context_usage / (s.context_limit || 1e6)) * 100));
      const mCtxTone = (pct) => (pct >= 85 ? "critical" : pct >= 60 ? "attention" : "safe");
      const mRelTime = (ts) => {
        if (!ts) return "";
        const m = Math.floor((Date.now() - ts) / 60000);
        if (m <= 0) return "刚刚";
        if (m < 60) return m + " 分钟前";
        const h = Math.floor(m / 60);
        if (h < 24) return h + " 小时前";
        if (h < 48) return "昨天";
        const d = new Date(ts), now = new Date();
        const md = d.getMonth() + 1 + "月" + d.getDate() + "日";
        return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + "年" + md;
      };
      const mFmtHM = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
      const mDayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
      const mDayLabel = (ts) => {
        if (!ts) return "";
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if (ts >= start) return "今天";
        if (ts >= start - 86400e3) return "昨天";
        const t = new Date(ts);
        const md = t.getMonth() + 1 + "月" + t.getDate() + "日";
        return t.getFullYear() === now.getFullYear() ? md : t.getFullYear() + "年" + md;
      };
      const mNlBr = (t) => esc(t).replace(/\r?\n/g, "<br>");
      const mToolIcon = (t) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t || "") ? "✎" : t === "Bash" ? "❯_" : /^(Read|Glob|Grep|WebFetch|WebSearch)$/.test(t || "") ? "▤" : "⚙";
      function sliceTimeline(list, max) { // 对话只取最近 max 条（截断标记供顶部 timeline-note）
        const all = Array.isArray(list) ? list : [];
        const total = all.length;
        const items = total > max ? all.slice(total - max) : all.slice();
        return { items, total, truncated: total > items.length };
      }
      function groupTodos(todos, now) { // B2 renderTasks 四组制复刻：已完成 24h 窗口 + 最近 15 条 / 进行中 / 待验证(VERIFY_RE) / 待办
        now = now || Date.now();
        const doneAll = todos.filter((t) => t.status === "completed");
        const doneWindow = doneAll.length && doneAll.every((t) => typeof t.updated_at === "number") ? doneAll.filter((t) => (t.updated_at || 0) >= now - 86400e3) : doneAll;
        const doneList = doneWindow.slice(-15);
        const open = todos.filter((t) => t.status !== "completed");
        const ipAll = open.filter((t) => t.status === "in_progress");
        const verify = ipAll.filter((t) => VERIFY_RE_M.test(t.content || ""));
        const run = ipAll.filter((t) => !VERIFY_RE_M.test(t.content || ""));
        const pending = open.filter((t) => t.status === "pending");
        return { doneAll, doneList, run, verify, pending };
      }
      function mWaitCardHtml(w, s) { // #166 手机端仅浏览模式：按钮禁用态 + 引导文案
        // W-UI-ASKRENDER：ask 卡问卷化（与桌面等待卡/时间线展开态同源 askGroupsHtml）——
        // header/题干/选项描述次行/多选标/含预览标结构化呈现，替换「／」拼纯文本；B2 未就绪回落旧形态
        const api = b2Api();
        const isAsk = Array.isArray(w.questions) && w.questions.length > 0;
        const title = isAsk ? "等待你的回答 · " + (w.questions[0]?.header || w.tool_name || "提问") : "等待你的确认 · " + (w.tool_name || "工具调用");
        if (isAsk && api && typeof api.askGroupsHtml === "function") {
          const flags = typeof api.askPreviewFlagsFor === "function" ? api.askPreviewFlagsFor(s, w) : null;
          return '<div class="wait-card ask" data-wait-card><strong class="wait-title">' + esc(title) + '</strong><div class="wait-multi">' + api.askGroupsHtml(w.questions, flags, "static") + '</div><div class="wait-actions"><button type="button" disabled>取消提问</button></div><div class="wait-readonly-hint">手机端仅浏览 · 请在电脑上处理等待请求</div></div>';
        }
        const copy = isAsk ? w.questions.map((q) => q.question || "").join(" ／ ") : (w.input_summary || "");
        const actions = isAsk
          ? '<div class="wait-actions"><button type="button" disabled>取消提问</button></div>'
          : '<div class="wait-actions"><button type="button" disabled>拒绝并说明</button><button type="button" class="allow" disabled>允许一次</button></div>';
        return '<div class="wait-card' + (isAsk ? " ask" : "") + '" data-wait-card><strong class="wait-title">' + esc(title) + '</strong><p class="wait-copy">' + esc(copy) + "</p>" + actions + '<div class="wait-readonly-hint">手机端仅浏览 · 请在电脑上处理等待请求</div></div>';
      }
      function mEntryHtml(e, s) { // #164 与桌面 entryHtml 同一渲染路径（MD/思考卡/工具行/diff/折叠全量对齐）；B2 未就绪时回落 esc+br
        const api = b2Api();
        if (api && typeof api.entryHtml === "function") return api.entryHtml(e, s);
        if (e.kind === "user_message") return '<div class="bubble me">' + mNlBr(e.full ?? e.text) + "</div>";
        if (e.kind === "assistant_text") {
          const eng = ENGINE_SHORT[(s && s.engine) || "claude"] || (s && s.engine) || "Claude";
          return '<div class="message-ai"><div class="message-author">' + (window.__ccDeck005EngineMarkHtml ? window.__ccDeck005EngineMarkHtml((s && s.engine) || "claude", eng) + " " : "") + '<strong>' + esc(eng) + "</strong>" + (e.ts ? "<time>" + mFmtHM(e.ts) + "</time>" : "") + '</div><div class="message-body">' + mNlBr(e.text) + (e.streaming && s && s.status === "WORKING" ? '<span class="stream-dots" role="status" aria-label="生成中"><i></i><i></i><i></i></span>' : "") + "</div></div>";
        }
        if (e.kind === "thinking") return "";
        if (e.kind === "tool_use") {
          const tl = isTaskLifeTool(e.tool); // #47 移动端任务行：timeline-note 本就不进 proc 组（常显），只换任务图标
          return '<div class="timeline-note' + (tl ? " task-life" : "") + '">' + (tl ? taskLifeIcon() + " " : "") + esc((tl ? "" : mToolIcon(e.tool) + " ") + (e.tool || "tool") + " · " + oneLine(e.text)) + "</div>";
        }
        if (e.kind === "tool_result") return '<div class="timeline-note">↳ ' + esc(oneLine(e.text)) + "</div>";
        return '<div class="timeline-note">' + esc(oneLine(e.text)) + "</div>";
      }
      function mConvCtrlHtml() { // #164 手机对话顶部开关（与桌面共用 convCtl 状态与持久化键）
        const api = b2Api();
        const st = (n) => api && api.convCtl ? (n === "proc" ? api.convCtl.proc() : api.convCtl.think()) : n === "proc";
        const proc = st("proc"), think = st("think");
        return '<div class="conv-ctrl' + (proc ? "" : " proc-off") + '"><button type="button" class="conv-mini' + (proc ? " on" : "") + '" data-conv-toggle="proc">⚙ 过程 ·' + (proc ? "开" : "关") + '</button><button type="button" class="conv-mini' + (think ? " on" : "") + '" data-conv-toggle="think">✦ 思考 ·' + (think ? "开" : "关") + "</button></div>";
      }
      function mSubagentNoteHtml(s) { // B2 批2 A0-2b：有活跃子任务时顶部单行「⑂N 子任务运行中 · 最近工具」（最近 = 末位活跃条的 desc/kind）
        const act = (s && Array.isArray(s.subagents) ? s.subagents : []).filter((a) => a && !a.ended_at);
        if (!act.length) return "";
        const last = act[act.length - 1];
        return '<div class="timeline-note subagent-live">⑂' + act.length + " 子任务运行中 · " + esc(oneLine(last.desc || last.kind || "")) + "</div>";
      }
      // #282 四批：对话流 items 单源——keyed（未变条目零触碰）与整串（fallback/他处消费）同源产出
      function mConversationItems(sid, s) {
        const api = b2Api();
        let list = [];
        try { const tl = api && api.S && api.S.timelines ? api.S.timelines.get(sid) : null; if (Array.isArray(tl)) list = tl; } catch (_) {}
        const cut = sliceTimeline(list, DETAIL_TL_MAX);
        const items = [];
        if (s && s.waiting_request) items.push(["mw", mWaitCardHtml(s.waiting_request, s)]);
        const sub = mSubagentNoteHtml(s);
        if (sub) items.push(["msub", sub]);
        if (!cut.items.length) { items.push(["mempty", '<div class="readonly-banner">暂无对话记录</div>']); return items; }
        items.push(["mctrl", mConvCtrlHtml()]);
        if (cut.truncated) items.push(["mtrunc", '<div class="timeline-note">共 ' + cut.total + " 条 · 显示最近 " + DETAIL_TL_MAX + "</div>"]);
        let prevDay = "";
        let procBuf = null, procKey = ""; // #164 连续工具/结果行 → 过程组（与桌面 renderConversation 同口径）
        const flushProc = () => {
          if (procBuf && procBuf.length) {
            const open = !!(api && api.expanded && api.expanded.has("proc:" + procKey));
            items.push(["mpg:" + procKey, '<div class="procgrp' + (open ? " open" : "") + '" data-proc="' + esc(procKey) + '"><div class="proc-head" data-proc-toggle="' + esc(procKey) + '">' + (open ? "▾" : "▸") + " 过程 · " + procBuf.length + ' 步</div><div class="proc-body">' + procBuf.join("") + "</div></div>"]);
          }
          procBuf = null;
        };
        for (const e of cut.items) {
          const dk = e.ts ? mDayKey(e.ts) : "";
          if (dk && dk !== prevDay) { flushProc(); items.push(["md:" + dk, '<div class="timeline-note">── ' + mDayLabel(e.ts) + " ──</div>"]); prevDay = dk; }
          const eh = mEntryHtml(e, s);
          if (!eh) continue;
          // 审查 P1-1 同款（review-282d-a）：任务生命周期行（data-role="task"）不进过程组
          if (eh.startsWith('<div class="trow') && eh.indexOf('data-role="proc"') > -1) {
            if (!procBuf) { procBuf = []; procKey = api && api.eKey ? api.eKey(e) : String(e.ts || ""); }
            procBuf.push(eh);
          } else { flushProc(); items.push([api && api.eKey ? api.eKey(e) : "me:" + String(e.ts || "") + ":" + items.length, eh]); }
        }
        flushProc();
        return items;
      }
      function mConversationHtml(sid, s) { return mConversationItems(sid, s).map((x) => x[1]).join(""); }
      function mTasksHtml(s) {
        if (!s) return '<div class="readonly-banner">未选择会话</div>';
        const todos = Array.isArray(s.todos) ? s.todos.filter(Boolean) : [];
        if (!todos.length) return '<div class="pane-summary">任务清单</div><div class="readonly-banner">暂无任务清单</div>';
        const g = groupTodos(todos);
        // #169 追加令1：与桌面 renderTasks 同构——组标题 3px 状态色条 + 明细缩进一档（mobile-lane 盒状容器在此退役）
        const row = (sym, t) => '<div class="check-row">' + sym + "<span>" + esc((t.id != null ? "#" + t.id + " " : "") + (t.status === "in_progress" && t.active_form ? t.active_form : t.content || "")) + "</span></div>";
        const lane = (cls, label, items, sym) => items.length ? '<div class="queue-group' + (cls ? " " + cls : "") + '">' + label + " · " + items.length + "</div>" + items.map((t) => row(sym, t)).join("") : "";
        let html = '<div class="pane-summary">任务进度 ' + g.doneAll.length + "/" + todos.length + '</div><div class="detail-panel-list">';
        html += lane("group-done", "已完成", g.doneList, "<b>✓</b>");
        html += lane("group-working", "进行中", g.run, '<b class="run">◐</b>');
        html += lane("group-verify", "待验证", g.verify, '<b class="verify">◇</b>');
        html += lane("", "待办", g.pending, "<span>○</span>");
        html += "</div>";
        if (g.doneList.length < g.doneAll.length) html += '<div class="readonly-banner">已完成仅显示最近 15 条（共 ' + g.doneAll.length + " 条）</div>";
        return html;
      }
      // #168 手机输出物行同构（v3 原型 mobile 形态）：汇总条/文件夹行(×N 折叠)/行二层/六类 chip/死档态
      let mArtOpen = new Set(), mArtOpenSid = "", mArtOpenInit = false;
      const mSizeStr = (n) => { n = Number(n) || 0; if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB"; if (n >= 1024) return Math.round(n / 1024) + " KB"; return n + " B"; };
      const mRelDir = (dir, cwd) => {
        if (!dir) return "";
        const nz = (x) => String(x || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
        const d = nz(dir), c = nz(cwd);
        if (c && d.startsWith(c + "/")) return displayPath(dir.slice(c.length + 1));
        return displayPath(dir);
      };
      function mArtifactsHtml(s) {
        if (!s) return '<div class="readonly-banner">未选择会话</div>';
        const arts = Array.isArray(s.artifacts) ? s.artifacts.filter((a) => a && a.path) : [];
        if (!arts.length) return '<div class="readonly-banner">暂无输出物（会话写入文件后登记）</div>';
        const api = b2Api();
        const kindOf = api && typeof api.artifactKindFor === "function" ? api.artifactKindFor : () => "pkg"; // #B3-15 双端同判定（B2 未就绪回落中性档）
        const badgeOf = api && typeof api.artBadgeHtml === "function" ? api.artBadgeHtml : () => "";
        const lay = api && typeof api.artLayoutItems === "function" ? api.artLayoutItems(arts) : { groups: [], loose: arts.slice().sort((a, b) => (b.last_at || 0) - (a.last_at || 0)) };
        if (mArtOpenSid !== s.session_id) { mArtOpen = new Set(); mArtOpenSid = s.session_id; mArtOpenInit = false; }
        if (!mArtOpenInit && lay.groups.length) { mArtOpen.add(lay.groups[0].dir); mArtOpenInit = true; }
        let h = '<div class="m-sum"><span class="m-sum-n">' + arts.length + ' 个文件<small>· ' + lay.groups.length + " 个文件夹</small></span></div>" + (s.artifacts_truncated ? '<div class="m-trunc">清单曾被 relay 截断</div>' : "");
        const rowHtml = (a, inGroup) => {
          const name = baseName(a.path);
          const kind = kindOf(name);
          const nzp = (x) => String(x || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
          const rawDir = window.__ccDeck005PathUi.dirOf(a.path);
          const isRoot = !inGroup && nzp(rawDir) === nzp(s.cwd);
          const dir = inGroup ? "" : (isRoot || !mRelDir(rawDir, s.cwd) ? "工作目录" : mRelDir(rawDir, s.cwd));
          const meta = [dir, a.size != null ? mSizeStr(a.size) : "", mRelTime(a.last_at || a.first_at)].filter(Boolean).join(" · ");
          const chip = kind === "image" && a.thumb
            ? '<span class="m-thumb"><img src="' + esc(a.thumb) + '" alt=""></span>'
            : '<span class="m-chip k-' + kind + '">' + esc(String(name).toLowerCase().split(".").pop().slice(0, 4) || "·") + "</span>";
          return '<div class="m-row k-' + kind + (a.exists === false ? " dead" : "") + '" data-path="' + esc(a.path) + '">' + chip + '<span class="m-main"><span class="m-name-row"><span class="m-name">' + esc(name) + "</span>" + badgeOf(a, inGroup) + '</span><span class="m-meta">' + esc(meta) + "</span></span></div>";
        };
        for (const g of lay.groups) {
          const open = mArtOpen.has(g.dir);
          const dirDisp = mRelDir(g.dir, s.cwd) || "工作目录";
          const leaf = dirDisp.split(/[\\/]/).filter(Boolean).pop() || dirDisp;
          const total = mSizeStr(g.list.reduce((t, a) => t + (Number(a.size) || 0), 0));
          h += '<div class="art-group' + (open ? " open" : "") + '"><div class="m-frow">' +
            '<button class="m-row m-folder k-dir" type="button" data-af-toggle="' + esc(g.dir) + '" aria-expanded="' + open + '" aria-label="文件夹 ' + esc(leaf) + "，" + g.list.length + ' 个文件">' +
            '<span class="m-chev">▸</span><span class="m-chip k-dir">' + svg("folder") + '</span>' +
            '<span class="m-main"><span class="m-name-row"><span class="m-name">' + esc(leaf) + '</span><span class="art-badge b-cnt">×' + g.list.length + '</span></span>' +
            '<span class="m-meta">' + esc([dirDisp, total, mRelTime(Math.max(...g.list.map((a) => a.last_at || 0)))].filter(Boolean).join(" · ")) + "</span></span></button></div>" +
            '<div class="m-kids">' + g.list.map((a) => rowHtml(a, true)).join("") + "</div></div>";
        }
        if (lay.loose.length) h += '<div class="art-group open"><div class="m-kids m-kids-loose">' + lay.loose.map((a) => rowHtml(a, false)).join("") + "</div></div>";
        h += '<div class="m-foot">仅收录文档、表格、图片与安装包等交付物</div>';
        return h;
      }
      function mCtxMeterHtml(s) { // B2 ctxMeterHtml 同构（12 格 band + tone 分级），mobile 形态加 mobile-context-meter；#169 追加令3 起由 mMoreHtml 调用（原 mUsageHtml 用量 tab 退役）
        const pct = mCtxPct(s);
        const tone = mCtxTone(pct);
        const grade = { safe: "安全", attention: "注意", critical: "拥挤" }[tone];
        const note = { safe: "余量充足，可继续当前任务", attention: "上下文偏高，留意即将压缩", critical: "上下文接近上限，建议收口或压缩" }[tone];
        const lim = s.context_limit || 1e6;
        const on = Math.round((pct / 100) * 12);
        const eng = ENGINE_SHORT[s.engine || "claude"] || s.engine || "Claude";
        const model = s.model ? String(s.model).split(/[/:]/).pop() : mTokStr(lim) + " 上限";
        return '<div class="context-meter ' + tone + ' mobile-context-meter"><div class="context-meter-head"><div><span class="context-meter-kicker">Context window</span><strong class="context-meter-model">' + (window.__ccDeck005EngineMarkHtml ? window.__ccDeck005EngineMarkHtml(s.engine || "claude", eng) + " " : "") + esc(eng + " · " + model) + '</strong></div><span class="context-meter-grade">' + grade + '</span></div><div class="context-meter-band" aria-label="上下文已使用 ' + pct + '%">' + Array.from({ length: 12 }, (_, i) => "<i" + (i < on ? ' class="on"' : "") + "></i>").join("") + '</div><div class="context-meter-stats"><span><b class="context-meter-used">' + mTokStr(s.context_usage) + '</b> <span class="context-meter-limit">/ ' + mTokStr(lim) + ' tokens</span></span><strong class="context-meter-pct">' + pct + '%</strong></div><div class="context-meter-note">' + note + "</div></div>";
      }
      function mDurText(ms) { const m = Math.floor(ms / 60000); return m >= 60 ? Math.floor(m / 60) + "h" + (m % 60) + "m" : m > 0 ? m + "m" : Math.floor(ms / 1000) + "s"; }
      function mMoreHtml(s) { // #169 追加令3：手机「更多」合并用量+统计键值行（与桌面 renderMore 同构）
        if (!s) return '<div class="readonly-banner">未选择会话</div>';
        let html = "";
        // 上部：ctxMeter 水位计 + 本回合时长/tokens（原「用量」tab 迁入，.metric 左线形态退役改键值行）
        if (s.context_usage) html += mCtxMeterHtml(s);
        else html += '<div class="pane-summary">用量</div><div class="readonly-banner">用量未随该会话下发</div>';
        if (s.status === "WORKING" && !isRealW(s) ) html += '<div class="kv-row"><b style="color:var(--dim)">待开工</b><span>已接单未开工或挂起</span></div>'; /* #291 审查 B-P2-2：mobile 详情与卡同屏一致 */
        else if (s.status === "WORKING" && s.turn_started_at) html += '<div class="kv-row"><b data-mturn-elapsed>__MELAPSED__</b><span>本回合已运行</span></div>'; // #282 三批：秒级文本走占位符（不进签名）+调用点定点写——B 审查 P3（跳帧对活跃会话失效）收口
        const u = s.usage;
        if (u && (u.input_tokens || u.output_tokens)) html += '<div class="kv-row"><b>' + mTokStr((u.input_tokens || 0) + (u.output_tokens || 0)) + "</b><span>本回合 tokens（入 " + mTokStr(u.input_tokens || 0) + " · 出 " + mTokStr(u.output_tokens || 0) + "）</span></div>";
        // 下部：统计键值行全量（与桌面 renderMore 同字段；目录/引擎用手机作用域助手 displayPath/ENGINE_SHORT）
        html += '<div class="more-section"><h4 class="more-section-title">会话信息</h4>';
        const statusLabel = s.status === "WORKING" && !isRealW(s) ? "待开工" : { WORKING: "运行中", WAITING: "等待确认", DONE: "已完成", ERROR: "错误", CLOSING: "结束中" }[s.status] || s.status || "—"; /* #291 待命标签 */
        html += '<div class="kv-row"><b>' + esc(statusLabel) + "</b><span>状态</span></div>";
        html += '<div class="kv-row"><b>' + esc(oneLine(displayPath(s.cwd)) || "—") + "</b><span>目录</span></div>";
        html += '<div class="kv-row"><b>' + (window.__ccDeck005EngineMarkHtml ? window.__ccDeck005EngineMarkHtml(s.engine || "claude", ENGINE_SHORT[s.engine || "claude"] || s.engine) + " " : "") + esc(ENGINE_SHORT[s.engine || "claude"] || s.engine || "Claude") + (s.model ? " · " + esc(s.model) : "") + "</b><span>引擎·模型</span></div>";
        html += '<div class="kv-row"><b>' + esc(s.permission_mode || "—") + "</b><span>权限模式</span></div>";
        if (s.started_at) html += '<div class="kv-row"><b>' + mRelTime(s.started_at) + "</b><span>开始时间</span></div>";
        if (s.finished_at && s.started_at) html += '<div class="kv-row"><b>' + mDurText(s.finished_at - s.started_at) + "</b><span>用时</span></div>";
        html += "</div>"; // 关闭会话信息节
        html += '<div class="more-section"><h4 class="more-section-title">用量统计</h4>';
        const changes = s.file_changes || {};
        const fileCount = (changes.added || 0) + (changes.modified || 0);
        if (fileCount > 0) html += '<div class="kv-row"><b>' + fileCount + "</b><span>修改文件数</span></div>";
        const lineAdd = changes.lines_added || 0, lineDel = changes.lines_deleted || 0;
        if (lineAdd || lineDel) html += '<div class="kv-row"><b>+' + lineAdd + " / −" + lineDel + "</b><span>增删行数</span></div>";
        const todos = Array.isArray(s.todos) ? s.todos.filter(Boolean) : [];
        if (todos.length) html += '<div class="kv-row"><b>' + todos.length + " 项</b><span>任务清单</span></div>";
        if (u && (u.input_tokens || u.output_tokens)) {
          html += '<div class="kv-row"><b>' + mTokStr(u.input_tokens || 0) + " / " + mTokStr(u.output_tokens || 0) + "</b><span>输入 / 输出 token</span></div>";
          if (u.cache_read_tokens || u.cache_creation_tokens) html += '<div class="kv-row"><b>' + mTokStr(u.cache_read_tokens || 0) + " / " + mTokStr(u.cache_creation_tokens || 0) + "</b><span>缓存读 / 写</span></div>";
        }
        if (s.finish_reason) html += '<div class="kv-row"><b>' + esc(s.finish_reason) + "</b><span>结束原因</span></div>";
        html += "</div>"; // 关闭用量统计节
        html += '<div class="more-section"><h4 class="more-section-title">标识</h4>';
        html += '<div class="kv-row kv-row-copy" data-copy-session-id="' + esc(s.session_id) + '"><b>' + esc(String(s.session_id || "").slice(0, 24)) + '…</b><span>Session ID</span><button class="kv-copy-btn" type="button" title="复制 Session ID" aria-label="复制 Session ID">⧉</button></div>';
        if (s.relay_session_id) html += '<div class="kv-row kv-row-copy" data-copy-relay-session-id="' + esc(s.relay_session_id) + '"><b>' + esc(String(s.relay_session_id).slice(0, 24)) + '…</b><span>SDK 会话</span><button class="kv-copy-btn" type="button" title="复制 SDK 会话 ID" aria-label="复制 SDK 会话 ID">⧉</button></div>';
        html += "</div>"; // 关闭标识节
        return html;
      }
      function ensureDetailBase() {
        const content = document.querySelector("#m-detail .mobile-content");
        if (!content) return null;
        let panes = [...content.querySelectorAll(":scope > .workspace-pane")];
        let convHost = null;
        if (panes.length === 4) {
          // 地基 setupStubTabs 解析期已收编四 pane 并 wireSegmentTabs——同 B2 桌面 ready() 只清占位标记
          panes.forEach((p) => p.removeAttribute("data-stub"));
          convHost = panes[0].querySelector("[data-mobile-detail-content]");
          if (!convHost) { convHost = document.createElement("div"); convHost.dataset.mobileDetailContent = ""; panes[0].textContent = ""; panes[0].appendChild(convHost); }
        } else {
          // 兜底：地基未接管时自建四 pane + 简版 tab wire（⑥c-3 任务书授权）
          const keep = content.querySelector("[data-mobile-detail-content]");
          content.textContent = "";
          panes = Array.from({ length: 4 }, () => { const p = document.createElement("div"); p.className = "workspace-pane"; content.appendChild(p); return p; });
          convHost = keep || document.createElement("div");
          convHost.dataset.mobileDetailContent = "";
          panes[0].appendChild(convHost);
          const btns = [...document.querySelectorAll("#m-detail .mobile-detail-tabs button")];
          btns.forEach((b, i) => b.addEventListener("click", () => {
            btns.forEach((x, j) => x.classList.toggle("active", i === j));
            panes.forEach((p, j) => p.classList.toggle("active", i === j));
          }));
        }
        return { content, convHost, conv: panes[0], tasks: panes[1], arts: panes[2], more: panes[3] };
      }
      function updateMobileDetailDock(s) {
        const dock = document.querySelector("#mobile-detail-state-dock");
        if (!dock) return;
        const op = dock.querySelector("[data-session-state-operation]");
        const elapsed = dock.querySelector("[data-session-state-elapsed]");
        const tok = dock.querySelector("[data-session-state-tokens]");
        if (!s) {
          dock.dataset.sessionState = "waiting";
          if (op) op.textContent = "未选择";
          if (elapsed) elapsed.textContent = "";
          if (tok) tok.hidden = true;
          mDockTerminalWatch(dock, null);
          return;
        }
        const state = M_DOCK_STATE[s.status] || "closing";
        dock.dataset.sessionState = state;
        const live = !!s.action_summary && s.status === "WORKING" && String(s.action_summary).startsWith("\u200B"); // A0-1 终端实时行防双计（与桌面 dockLiveLine 同口径）
        if (live) dock.setAttribute("data-live-line", ""); else dock.removeAttribute("data-live-line");
        const w = s.waiting_request;
        const taskText = w ? "等待确认 · " + (w.tool_name || "工具调用") : (s.action_summary || s.last_error || "");
        if (op) op.textContent = String(taskText).replace(/^\u200B+/, "").slice(0, 60); // B21 摘要承任务流（终态符号在态图标）
        if (elapsed) elapsed.textContent = mRelTime(s.updated_at || s.started_at);
        if (tok) { const u = Number(s.context_usage) || 0; tok.hidden = live || !u; tok.textContent = u ? "· " + mTokStr(u) + "/" + mTokStr(s.context_limit || 1e6) : ""; }
        mDockTerminalWatch(dock, s);
      }
      // B#133 手机同口径：DONE ✓ 8s 淡出收起、ERROR ⚠ 常驻（键 = sid+status 防心跳重启）
      let mDockTermKey = "";
      let mDockTermT = 0;
      function mDockTerminalWatch(dock, s) {
        const key = s ? s.session_id + ":" + s.status : "";
        if (key === mDockTermKey) return;
        mDockTermKey = key;
        clearTimeout(mDockTermT);
        dock.classList.remove("terminal-fade");
        if (s && s.status === "DONE") mDockTermT = setTimeout(() => dock.classList.add("terminal-fade"), 8000);
      }
      // #282 MOB 双壳同族收敛（清单 §2.5）：sig 跳帧（html 未变零 DOM——移动壳各渲染面
      // 逐帧 innerHTML 全量的同族病在此批收口；列表类另走 keyed 单口见各写点）
      const mHtmlSig = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return "m" + (h >>> 0).toString(36); };
      function mSigWrite(el, sig, html) {
        if (el.dataset.mSig === sig && el.childElementCount) return false;
        el.dataset.mSig = sig;
        el.innerHTML = html;
        return true;
      }
      function renderMobileDetail(sid) {
        const base = detailBase || (detailBase = ensureDetailBase());
        if (!base) return;
        const s = bridge.sessions.get(sid) || null;
        const keepScroll = base.content.scrollTop;
        // #282 MOB：详情四 pane sig 跳帧（sid 进签名防跨会话同形误跳）——未变帧零重建，
        // 选区/折叠态/滚动逐帧存活；proc-off 类 toggle 照常（host 级，不依赖重建）
        { // #282 四批：对话流 keyed（未变条目零解析零触碰——与桌面 S4 同构）；rk 缺席回落 sig 跳帧
          const rkC = window.__ccDeck005Reconcile;
          if (rkC) rkC(base.convHost, mConversationItems(sid, s));
          else { const h = mConversationHtml(sid, s); mSigWrite(base.convHost, "conv:" + sid + ":" + mHtmlSig(h), h); } }
        { const api = b2Api(); base.convHost.classList.toggle("proc-off", !(api && api.convCtl && api.convCtl.proc())); } // #164 过程总开关（host 级类，innerHtml 重建不丢）
        { const h = mTasksHtml(s); mSigWrite(base.tasks, "t:" + sid + ":" + mHtmlSig(h), h); }
        { const h = mArtifactsHtml(s); mSigWrite(base.arts, "a:" + sid + ":" + mHtmlSig(h), h); }
        { const h = mMoreHtml(s); mSigWrite(base.more, "m:" + sid + ":" + mHtmlSig(h), h);
          const elapsedTxt = s && s.status === "WORKING" && s.turn_started_at ? mDurText(Math.max(0, Date.now() - s.turn_started_at)) : "";
          const el = base.more.querySelector("[data-mturn-elapsed]"); if (el && elapsedTxt) el.textContent = elapsedTxt; } // #282 三批：写/跳帧两路径同款定点写（与桌面 renderMore 对齐）
        updateMobileDetailDock(s);
        syncMobileComposer(); // #169 输入栏随会话态同步（停止钮可见性/发送禁用/提示小字）
        base.content.scrollTop = keepScroll;
      }
      function mobileSend() {
        if (!detailSid) { mToast("先从会话列表进入详情"); return; }
        const input = document.querySelector('#m-detail [data-composer="mobile"] .composer-input');
        const text = String((input && input.value) || "").trim();
        const api = b2Api();
        const staged = (api && api.S && api.S.staged) || [];
        if (!text && !staged.length) return; // 空输入且无附件忽略（#169 附件可单独发）
        if (!api || typeof api.sendPrompt !== "function") { mToast("发送链路未就绪"); return; }
        const s = bridge.sessions.get(detailSid) || (api.S && api.S.sessions ? api.S.sessions.get(detailSid) : null);
        if (s && typeof api.canCmd === "function" && !api.canCmd(s)) { mToast("历史会话只读"); return; }
        const r = api.sendPrompt(detailSid, text) || {};
        if (r.sent) { if (input) input.value = ""; if (api && api.slashClose) api.slashClose(); mToast("已发送"); }
        else mToast(String(r.error || "发送失败"));
        syncMobileComposer();
      }
      // #169 手机输入栏同步：发送常驻判空禁用 + 停止钮运行中出现 + 提示小字只读态隐藏
      function syncMobileComposer() {
        const send = document.querySelector('#m-detail [data-composer-send]');
        const stop = document.querySelector('#m-detail [data-composer-stop]');
        const input = document.querySelector('#m-detail [data-composer="mobile"] .composer-input');
        const api = b2Api();
        const s = detailSid ? (bridge.sessions.get(detailSid) || (api && api.S && api.S.sessions ? api.S.sessions.get(detailSid) : null)) : null;
        const editable = !!(s && (!api || !api.canCmd || api.canCmd(s)));
        const staged = (api && api.S && api.S.staged) || [];
        if (send) send.disabled = !editable || !((input && input.value.trim()) || staged.length);
        if (stop) stop.hidden = !(editable && s && (s.status === "WORKING" || s.status === "WAITING"));
      }
      function setupMobileDetail() {
        detailBase = ensureDetailBase();
        const send = document.querySelector('#m-detail [data-composer-send]');
        if (send) send.addEventListener("click", () => mobileSend());
        const stop = document.querySelector('#m-detail [data-composer-stop]');
        if (stop) stop.addEventListener("click", () => { // #169 手机停止（与桌面同命令面）
          if (!detailSid) { mToast("先从会话列表进入详情"); return; }
          const api = b2Api();
          if (api && typeof api.stopPrompt === "function") { api.stopPrompt(detailSid); mToast("已请求停止"); }
        });
        const input = document.querySelector('#m-detail [data-composer="mobile"] .composer-input');
        if (input) {
          input.addEventListener("keydown", (ev) => { if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return; ev.preventDefault(); mobileSend(); }); // IME 组词期 Enter 不发送
          input.addEventListener("input", () => { syncMobileComposer(); const api = b2Api(); if (api && api.slashFor) api.slashFor(input); }); // #169 发送禁用态随输入同步 + W-SLASH 联想浮层共用
        }
        // #169 图片/文件双入口（旧壳 imgBtn/fileBtn 语义；压缩/限额走 B2 stageFiles 不重写）
        const pickHost = '[data-composer="mobile"]';
        const wirePicker = (btnSel, accept) => {
          const btn = document.querySelector(btnSel);
          if (!btn) return;
          const inp = document.createElement("input");
          inp.type = "file";
          inp.multiple = true;
          if (accept) inp.accept = accept;
          inp.hidden = true;
          document.body.appendChild(inp);
          inp.addEventListener("change", () => { const api = b2Api(); if (api && typeof api.stageFiles === "function") api.stageFiles(inp.files, detailSid); inp.value = ""; }); // #169 带手机详情 sid 借道
          btn.addEventListener("click", (ev) => { ev.stopPropagation(); inp.click(); });
        };
        wirePicker('#m-detail ' + pickHost + ' .composer-img', "image/*");
        wirePicker('#m-detail ' + pickHost + ' .composer-clip', "");
        window.addEventListener("ccdeck:staged", () => syncMobileComposer()); // 暂存变化（含桌面拖入/粘贴）同步发送态
        syncMobileComposer();
      }

      // ---------- 四屏渲染 ----------
      const mobileProjOpen = new Set(); // FB16：手机闲置项目组手动展开账（会话内记忆）
      // #240 W-LEADERHIDE：Leader 卡不进手机壳收件箱（桌面 renderMyList 同批同口径）——
      // 锚 id（B2 S.leaderSessionId = SNAPSHOT.leader_session_id 透传）+ 编制 role 词表
      //（leader|领队）双口径，词表不含 pm（PM 会话照常直列，删的是 Leader 形制卡非 PM 卡）。
      // b2Api 缺席时词表段退化，锚 id 单口径仍兜底；词表匹配 S.projects（SNAPSHOT headcount）
      const mobileLeaderIds = () => {
        const ids = new Set();
        const api = b2Api();
        const S = api && api.S;
        if (S && S.leaderSessionIds && typeof S.leaderSessionIds.forEach === "function") S.leaderSessionIds.forEach((id) => ids.add(id)); // UI 反馈批 1029 件B：全源锚 id 并集（聚合远程源 Leader 卡同滤）
        if (S && typeof S.leaderSessionId === "string" && S.leaderSessionId) ids.add(S.leaderSessionId);
        const projects = S && Array.isArray(S.projects) ? S.projects : [];
        for (const p of projects) {
          const hc = Array.isArray(p && p.headcount) ? p.headcount : [];
          for (const m of hc) {
            if (m && /^(leader|领队)$/i.test(String(m.role || "")) && m.session_id) ids.add(String(m.session_id));
          }
        }
        return ids;
      };
      const mobileRetiredIds = () => { // [W-RETIRED] 退休成员会话（桌面归档组同批同口径）：B2 S.retiredIds 透传（SNAPSHOT.retired_session_ids / RETIRED_SESSIONS_UPDATED 帧维护；null=旧 relay 零过滤）
        const api = b2Api();
        const S = api && api.S;
        return S && S.retiredIds instanceof Set ? S.retiredIds : new Set();
      };
      let mobileRetiredOpen = false; // 归档组展开账（会话内记忆，mobileProjOpen 同款口径）
      function renderInbox() {
        const list = document.querySelector("#m-inbox [data-mobile-session-list]");
        if (!list) return;
        const leaderIds = mobileLeaderIds();
        const retiredIds = mobileRetiredIds();
        const sessions = allSessions().filter((s) => !leaderIds.has(s.session_id) && !retiredIds.has(s.session_id)).sort(byPinnedUpdated);
        // B18 活跃优先（手机同口径）：顶部「进行中」收全部活跃；闲置按项目分组
        // FB16：手机补折叠机制——闲置组默认折叠、组头可点展开（与桌面 B11 同语言）
        const pend = sessions.filter((s) => s.status === "WORKING" || s.status === "WAITING" || s.status === "ERROR");
        const pendIds = new Set(pend.map((s) => s.session_id));
        const other = sessions.filter((s) => !pendIds.has(s.session_id));
        const groups = [...new Set(other.map(getSessionProject))];
        // W-V8 批4（用户点名2）：移动端组头同步图标化——成员=users/进行中=activity 绿
        //（与桌面 grpHead 同族；12px 图标+数字，状态色只落图标）
        const grpIc = (icon, on) => `<svg class="icon-inline grp-ic${on ? " on" : ""}" aria-hidden="true"><use href="#icon-${icon}"></use></svg>`;
        const otherMarkup = groups.map((g) => {
          const items = other.filter((s) => getSessionProject(s) === g);
          const open = mobileProjOpen.has(g);
          const wN = items.filter((s) => s.status === "WORKING" && isRealW(s)).length; /* #291 真计数 */
          return `<div class="session-group${open ? "" : " collapsed"}" data-session-group="project"><div class="queue-group" data-mobile-group-toggle="${esc(g)}" role="button" tabindex="0" aria-expanded="${open}" title="展开/收起该组"><span class="grp-caret">${open ? "▾" : "▸"}</span><span class="grp-ava" aria-hidden="true">${esc(String(g).trim().slice(0, 1) || "团")}</span><span>${esc(g)}</span><span class="grp-count" data-session-group-count>${grpIc("users")}${items.length}${wN ? ` ${grpIc("activity", true)}${wN}` : ""}</span></div><div class="grp-body">${items.map(mobileCard).join("")}</div></div>`;
        }).join("");
        // #282 MOB keyed：组级身份对齐（a:active / p:<项目名>）——未变组零触碰（FB16 折叠
        // 态/组内滚动/长按菜单瞬态逐帧存活），变化组单点替换；rk 缺席回落旧整串（零删）
        const activeMarkup = pend.length ? `<div class="session-group" data-session-group="active"><div class="queue-group"><span>进行中</span><span class="grp-count" data-session-group-count>${grpIc("activity", true)}${pend.length}</span></div>${pend.map(mobileCard).join("")}</div>` : "";
        // [W-RETIRED] 尾部「已退休成员」折叠归档组（桌面 renderMyList 同批同口径：默认收起、
        // 组头点开展开、历史可查非删除）；退休卡不进进行中/闲置分组（sessions 已滤）
        const retiredSessions = allSessions().filter((s) => !leaderIds.has(s.session_id) && retiredIds.has(s.session_id)).sort(byPinnedUpdated);
        const retiredMarkup = retiredSessions.length
          ? `<div class="session-group${mobileRetiredOpen ? "" : " collapsed"}" data-session-group="retired"><div class="queue-group" data-retired-toggle role="button" tabindex="0" aria-expanded="${mobileRetiredOpen}" title="展开/收起已退休成员"><span class="grp-caret">${mobileRetiredOpen ? "▾" : "▸"}</span><span class="grp-ava" aria-hidden="true">退</span><span>已退休成员</span><span class="grp-count" data-session-group-count>${grpIc("users")}${retiredSessions.length}</span></div><div class="grp-body">${retiredSessions.map(mobileCard).join("")}</div></div>`
          : "";
        const rkM = window.__ccDeck005Reconcile;
        if (rkM) {
          const desired = [];
          if (pend.length) desired.push(["a:active", activeMarkup]);
          // 按组重建 desired（与 otherMarkup 同构逐组产串——keyed 身份粒度=项目组）
          groups.forEach((g) => {
            const items = other.filter((s) => getSessionProject(s) === g);
            const open = mobileProjOpen.has(g);
            const wN = items.filter((s) => s.status === "WORKING" && isRealW(s)).length; /* #291 真计数 */
            desired.push(["p:" + g, `<div class="session-group${open ? "" : " collapsed"}" data-session-group="project"><div class="queue-group" data-mobile-group-toggle="${esc(g)}" role="button" tabindex="0" aria-expanded="${open}" title="展开/收起该组"><span class="grp-caret">${open ? "▾" : "▸"}</span><span class="grp-ava" aria-hidden="true">${esc(String(g).trim().slice(0, 1) || "团")}</span><span>${esc(g)}</span><span class="grp-count" data-session-group-count>${grpIc("users")}${items.length}${wN ? ` ${grpIc("activity", true)}${wN}` : ""}</span></div><div class="grp-body">${items.map(mobileCard).join("")}</div></div>`]);
          });
          if (retiredMarkup) desired.push(["retired", retiredMarkup]);
          rkM(list, desired);
        } else list.innerHTML = activeMarkup + otherMarkup + retiredMarkup;
        const act = sessions.filter(needAction).length;
        const work = sessions.filter((s) => s.status === "WORKING").length;
        const done = sessions.filter((s) => s.status === "DONE").length;
        const sums = document.querySelectorAll("#m-inbox .mobile-summary > div > b");
        if (sums.length >= 3) { sums[0].textContent = String(act); sums[1].textContent = String(work); sums[2].textContent = String(done); }
        /* W-PILLFIX ⑦：四页铃铛同账（W-PILLFIX 前只有会话页铃铛吃刷新） */
        document.querySelectorAll(".mobile-head .mobile-notify").forEach((badge) => {
          badge.style.display = act ? "" : "none"; badge.title = act ? "通知 · " + act + " 个需行动项" : "通知";
          const n = badge.querySelector("span:not([class])") || badge.querySelector("span:last-child"); if (n) n.textContent = String(act);
        });
      }
      function renderNotify() {
        const dismissed = window.__ccDeck005DismissedNotifyKeys; // FB18：与桌面通知域共账
        const items = (Array.isArray(bridge.notifications) ? bridge.notifications : []).filter((n) => n && !(dismissed && dismissed.has(n.key)));
        const isDone = (n) => !!(n && (n.resolved_at || n.handled_at || n.dismissed_at));
        const activeN = items.filter((n) => !isDone(n)).length;
        const countEl = document.querySelector("#m-notify [data-notify-action-count]"); // F11 根修：作用域锁定手机壳——裸 [data-notify-action-count] 会命中桌面节点把 chip 覆盖成裸数字
        if (countEl) countEl.textContent = String(activeN);
        document.querySelectorAll("[data-notify-clear-all]").forEach((b) => { b.hidden = !items.length; }); // FB18：移动端批量清除钮
        const list = document.querySelector("#m-notify [data-mobile-notification-list]");
        if (!list) return;
        // #282 MOB keyed：通知行按 n.key 身份对齐（标记已读/清除后行级增删定点，列表滚动
        // 位逐帧存活）；rk 缺席回落旧整串（零删）
        const rowOf = (n) => {
          const act = !isDone(n);
          const sid = n.sourceContext && n.sourceContext.sessionId;
          const domain = n.sourceContext && n.sourceContext.domain;
          const mainBtn = !act ? "" : sid
            ? `<button class="primary-btn" type="button" data-notify-mobile-jump="${esc(sid)}">回会话处理</button>`
            : domain ? `<button class="primary-btn" type="button" data-notify-jump-domain="${esc(domain)}">回${domain === "team" ? "团队" : domain === "project" ? "项目" : "会话"}域处理</button>` : "";
          return `<article class="mobile-card mobile-notify-card" data-notify-card data-notify-active="${act}"><div class="row"><span class="avatar">${svg(act ? "alert" : "info")}</span><strong>${esc(n.title || n.kind || "通知")}</strong><span class="tag ${act ? "action" : ""}">${act ? (n.group === "action" ? "需行动" : "注意") : "历史"}</span></div><p>${esc(oneLine(n.body))}</p><div class="notify-actions">${act ? `<button class="notify-light-action" type="button" data-mobile-notify-ack="${esc(n.key)}">标记已读</button>` : ""}${mainBtn}<button class="notify-light-action" type="button" data-mobile-notify-dismiss="${esc(n.key)}" title="清除这条通知" aria-label="清除通知">✕</button></div></article>`;
        };
        const rkN = window.__ccDeck005Reconcile;
        if (rkN) rkN(list, items.length ? items.map((n) => ["n:" + n.key, rowOf(n)]) : [["n:empty", '<div class="readonly-banner">暂无通知 · 行动项到达时在此提示。</div>']]);
        else list.innerHTML = items.length ? items.map(rowOf).join("") : '<div class="readonly-banner">暂无通知 · 行动项到达时在此提示。</div>';
      }
      function renderTeam() {
        const screen = screenOf("team");
        if (!screen) return;
        const sessions = allSessions().filter((s) => !mobileLeaderIds().has(s.session_id) && !mobileRetiredIds().has(s.session_id)); // #240：泳道任务卡不吃 Leader 锚卡（同收件箱口径）；W-RETIRED：退休卡同滤（归档组只在收件箱呈现）
        const confirms = Array.isArray(bridge.pendingConfirms) ? bridge.pendingConfirms : [];
        const projects = Array.isArray(bridge.projects) ? bridge.projects : [];
        const head = screen.querySelector(".mobile-head h2 small");
        if (head) head.textContent = (projects[0] && projects[0].name) || "暂无团队编制";
        document.querySelectorAll(".mobile-nav .tag.action").forEach((tag) => { if (confirms.length) tag.textContent = String(confirms.length); else tag.remove(); });
        const slot = screen.querySelector("[data-team-confirm-slot]");
        if (slot) {
          // #282 MOB sig 跳帧：确认卡内容未变零重建
          if (confirms.length) { slot.hidden = false; mSigWrite(slot, "cf:" + confirms.length, `<div class="mobile-card primary"><div class="row"><span class="avatar">${svg("users")}</span><strong>组织确认待处理</strong><span class="tag action">确认</span></div><p>${confirms.length} 项待你确认 · 回桌面团队域处理</p><div class="identity-cluster">${sourceBadge()}</div></div>`); }
          else { slot.hidden = true; slot.textContent = ""; slot.dataset.mSig = ""; }
        }
        const taskRow = (s) => { const [w, cls] = stTag(s); return `<div class="mobile-task" data-open-detail="${esc(s.session_id)}"><b>${esc(sessionTitle(s))}</b><br><span class="muted">${esc(oneLine(s.action_summary) || oneLine(displayPath(s.cwd)) || w)}</span><div class="identity-cluster">${engineBadge(s)}${sourceBadge(s)}</div><br><span class="tag ${cls}">${w}</span></div>`; };
        const lane = (label, items, mapper) => `<div class="mobile-lane"><div class="mobile-lane-head"><span>${label}</span><span>${items.length}</span></div>${items.map(mapper).join("") || '<div class="mobile-task"><span class="muted">暂无</span></div>'}</div>`;
        const todo = screen.querySelector('[data-team-pane="todo"]');
        // #282 MOB sig 跳帧：三 pane 内容未变零重建（泳道滚动位/成员列表滚动逐帧存活）
        if (todo) { const h = lane("需行动", sessions.filter(needAction).sort(byPinnedUpdated), taskRow) + (confirms.length ? `<div class="mobile-lane"><div class="mobile-lane-head"><span>组织确认</span><span class="tag action">${confirms.length}</span></div><div class="mobile-task"><b>确认事项待处理</b><br><span class="muted">回桌面团队域确认</span></div></div>` : ""); mSigWrite(todo, "todo:" + mHtmlSig(h), h); }
        const board = screen.querySelector('[data-team-pane="board"]');
        if (board) { const h = `<div class="mobile-board">${lane("运行中", sessions.filter((s) => s.status === "WORKING" && isRealW(s)), taskRow)}${lane("需行动", sessions.filter(needAction), taskRow)}${lane("已完成", sessions.filter((s) => s.status === "DONE"), taskRow)}</div>`; mSigWrite(board, "board:" + mHtmlSig(h), h); }
        const members = screen.querySelector('[data-team-pane="members"]');
        if (members) {
          const engineMap = new Map();
          sessions.forEach((s) => { const eng = s.engine || "unknown"; if (!engineMap.has(eng)) engineMap.set(eng, []); engineMap.get(eng).push(s); });
          const h = `<div class="member-list">${[...engineMap.entries()].map(([eng, arr]) => `<div class="member-card"><span class="avatar">${window.__ccDeck005EngineMarkHtml ? window.__ccDeck005EngineMarkHtml(eng, ENGINE_SHORT[eng] || eng) : esc(String(ENGINE_SHORT[eng] || eng).charAt(0))}</span><div><strong>${esc(ENGINE_SHORT[eng] || eng)}</strong><p>${arr.length} 个会话</p><div class="identity-cluster">${window.__ccDeck005EngineBadgeHtml ? window.__ccDeck005EngineBadgeHtml(eng, esc(ENGINE_SHORT[eng] || eng)) : `<span class="engine-badge ${ENGINE_BADGE[eng] || ""}">${esc(ENGINE_SHORT[eng] || eng)}</span>`}${sourceBadge()}</div></div></div>` /* UI 精修二批：品牌头像+品牌徽章 */).join("") || '<div class="readonly-banner">暂无成员 · 会话接入后按引擎聚合。</div>'}</div>`;
          mSigWrite(members, "mem:" + mHtmlSig(h), h);
        }
      }
      function renderProject() {
        const screen = screenOf("project");
        if (!screen) return;
        const sessions = allSessions().filter((s) => !mobileLeaderIds().has(s.session_id) && !mobileRetiredIds().has(s.session_id)); // #240：项目聚合 lane/统计不吃 Leader 锚卡（同收件箱口径）；W-RETIRED：退休卡同滤
        const projects = Array.isArray(bridge.projects) ? bridge.projects : [];
        const actN = sessions.filter(needAction).length;
        const artifactsN = sessions.reduce((n, s) => n + (Array.isArray(s.artifacts) ? s.artifacts.length : 0), 0);
        const sums = screen.querySelectorAll(".mobile-project-summary > span");
        if (sums.length >= 4) {
          sums[0].innerHTML = `${svg("chat")} 会话 ${sessions.length}`;
          sums[1].innerHTML = `${svg("users")} 团队 ${projects.length}`;
          sums[2].innerHTML = `${svg("package")} 输出物 ${artifactsN}`;
          sums[3].textContent = `需行动 ${actN}`;
        }
        const headTag = screen.querySelector(".mobile-head .tag.action");
        if (headTag) { headTag.style.display = actN ? "" : "none"; const n = headTag.querySelector("span"); if (n) n.textContent = String(actN); }
        const cards = screen.querySelector("[data-mobile-project-cards]");
        // #282 MOB sig 跳帧：项目卡/聚合 lane 内容未变零重建
        if (cards) { const h = projects.length ? projects.map((p) => {
          const cnt = sessions.filter((s) => getSessionProject(s) === p.name).length;
          // W-UIV3 项目卡 v3 同步（桌面 pc3 同款语言）：统计去胶囊（「N 会话」纯文本元信息行，
          // 用户点名项）+非活跃态 cc-badge neutral 幽灵徽章（B2 透明底）；路径行 truncate 不变
          const st = p.status === "active" ? "" : p.status === "pending" ? '<span class="cc-badge is-neutral">待确认</span>' : p.status === "parked" ? '<span class="cc-badge is-neutral">已挂起</span>' : '<span class="cc-badge is-neutral">已归档</span>'; // W-UIV3：pending 三态漏支补齐（旧 ternary 把待确认组错标已归档，探针实锤）
          return `<div class="mobile-project-card pc2m"><div class="pc2m-r1"><strong class="pc2m-name">${esc(p.name)}</strong>${st}</div><div class="pc2m-r2"><span class="pc2-path">${esc(displayPath(p.anchor_dir || "") || "/")}</span><span class="pc3-meta">${cnt} 会话</span></div></div>`;
        }).join("") : '<div class="readonly-banner">暂无项目组 · 新建项目后在组织侧同步。</div>'; mSigWrite(cards, "pc:" + mHtmlSig(h), h); }
        const laneHost = screen.querySelector("[data-mobile-project-lane]");
        if (laneHost) { const h = `<div class="mobile-lane"><div class="mobile-lane-head"><span>项目聚合</span><span>只读</span></div>${sessions.sort(byPinnedUpdated).slice(0, 12).map((s) => { const [w] = stTag(s); return `<div class="mobile-task" data-open-detail="${esc(s.session_id)}">${svg("chat")} ${esc(sessionTitle(s))} · ${w}<br><span class="muted">在会话中查看 ›</span></div>`; }).join("") || '<div class="mobile-task"><span class="muted">暂无会话</span></div>'}</div>`; mSigWrite(laneHost, "pl:" + mHtmlSig(h), h); }
      }
      function renderSettingsRows() {
        const screen = screenOf("settings");
        if (!screen) return;
        const rows = [...screen.querySelectorAll(".mobile-settings .settings-row")];
        if (!rows.length) return;
        const cat = catalog();
        const stateText = connStateText();
        const byTitle = (t) => rows.find((r) => r.querySelector("strong")?.textContent.trim() === t);
        const setP = (title, text) => { const p = byTitle(title)?.querySelector("p"); if (p) p.textContent = text; };
        setP("连接与设备", (window.__ccDeck005CloudUI && window.__ccDeck005CloudUI.active()) ? `云桥 ${window.__ccDeck005CloudUI.stateLabel()} · 本页设备` : `relay ${stateText} · 本页设备`);
        const readyN = cat ? cat.filter((e) => e && e.state === "ready").length : 0;
        setP("Agent 引擎", cat ? `${readyN}/${cat.length} 引擎就绪 · 浏览态` : "引擎目录未下发 · 浏览态");
        const roleSet = new Set();
        (cat || []).forEach((e) => (Array.isArray(e && e.default_for_roles) ? e.default_for_roles : []).forEach((r) => roleSet.add(r)));
        setP("团队身份模板", `${roleSet.size} 个角色 · 开团时逐成员覆盖`);
        setP("关于", VER_NOW() ? `${VER_NOW()} 通道` : "版本待定");
        const connTag = byTitle("连接与设备")?.querySelector(".tag");
        const actN = allSessions().filter(needAction).length;
        if (connTag) { if (actN) connTag.textContent = String(actN); else connTag.remove(); }
        const chip = screen.querySelector(".connection-chip");
        if (chip) { const last = chip.lastChild; if (last && last.nodeType === 3) last.textContent = (window.__ccDeck005CloudUI && window.__ccDeck005CloudUI.active()) ? " 云桥 " + window.__ccDeck005CloudUI.stateLabel() : " relay " + stateText; }
      }
      // conn-page-v2 ⑧ 移动端客户端 lane：连接与设备详情的第三模块（已连终端清单，
      // SNAPSHOT.relay_devices 真实台账与桌面同源；旧 relay 无字段=本页设备单行兼容）
      function mobileDevicesLane() {
        const snap = bridge.snapshot && typeof bridge.snapshot === "object" ? bridge.snapshot : {};
        const devices = Array.isArray(snap.relay_devices) ? snap.relay_devices.filter((d) => d && typeof d.id === "string") : null;
        const relSeen = (ts) => { const m = Math.max(1, Math.round((Date.now() - Number(ts || 0)) / 60000)); return m < 60 ? m + " 分钟前在线" : m < 1440 ? Math.round(m / 60) + " 小时前在线" : Math.round(m / 1440) + " 天前在线"; };
        const ICO = { phone: "phone", desktop: "desktop", browser: "globe" }; // conn-page-v2 P2-4b：browser 独立 globe（与桌面同口径）
        const rows = devices && devices.length
          ? devices.slice(0, 6).map((d) => { const on = d.online === true; const rt = (ts) => { const m = Math.max(1, Math.round((Date.now() - Number(ts || 0)) / 60000)); return m < 60 ? m + " 分钟前" : m < 1440 ? Math.round(m / 60) + " 小时前" : Math.round(m / 1440) + " 天前"; }; const fs0 = Number(d.first_seen || 0); const sub = on ? (fs0 > 0 && Date.now() - fs0 < 3650 * 60000 * 1440 ? "首次连接 " + rt(fs0) : "当前在线") : relSeen(d.last_seen); return `<div class="mobile-task">${svg(ICO[d.kind] || "desktop")} ${esc(String(d.name || "未知设备"))} · ${sub}</div>`; }).join("")
          : devices
            ? '<div class="mobile-task"><span class="muted">暂无客户端连接记录 · 桌面端「＋ 配对新设备」可添加</span></div>'
            : `<div class="mobile-task">${svg("phone")} 本页设备（手机） · 当前在线</div><div class="mobile-task"><span class="muted">当前 relay 版本未下发客户端台账 · 升级后此处显示已连终端</span></div>`;
        return `<div class="mobile-lane"><div class="mobile-lane-head"><span>客户端 · 连到本机的终端</span></div>${rows}</div>`;
      }
      function setupMobileSettings() {
        const screen = screenOf("settings");
        const content = screen?.querySelector(".mobile-content");
        const list = content?.querySelector(".mobile-settings");
        if (!content || !list || content.dataset.settingsReady) return;
        list.insertAdjacentHTML("beforeend", '<div class="settings-row"><span class="setting-icon"><svg class="icon-inline" aria-hidden="true"><use href="#icon-sliders"></use></svg></span><div><strong>通用与快捷键</strong><p>快捷键、通知与卡片密度</p></div><span class="chev">›</span></div>');
        const detail = document.createElement("div");
        detail.className = "mobile-settings-detail";
        detail.hidden = true;
        content.append(detail);
        content._renderSettingsDetail = (name) => {
          if (!name || name === "主题") return;
          const cat = catalog();
          const stateText = connStateText();
          const roleSet = new Map();
          (cat || []).forEach((e) => (Array.isArray(e && e.default_for_roles) ? e.default_for_roles : []).forEach((r) => { if (r && !roleSet.has(r)) roleSet.set(r, e); }));
          const html = name === "关于" ? `<div class="readonly-banner">cc-deck ${VER_NOW() ? VER_NOW() + " 通道" : "版本待定"}<br>Command Bridge · 零外部资源</div><div class="mobile-task" role="button" tabindex="0" data-update-check>检查更新 · 当前已是最新版本</div>`
            : name === "连接与设备"
              ? (window.__ccDeck005CloudUI && window.__ccDeck005CloudUI.active())
                ? window.__ccDeck005CloudUI.mobileLane() // 云形态：动态云桥 lane（状态行/输码表单/重试钮，720px 视口可输入可提交）
                : `<div class="mobile-lane"><div class="mobile-lane-head"><span>本机 relay</span><span class="tag ${connMaskedOk() ? "done" : "action"}">${stateText}</span></div><div class="mobile-task">端口 ${location.port || "8787"} · ${esc(window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(bridge.relayName || "") : (bridge.relayName || ""))}</div></div><div class="mobile-lane"><div class="mobile-lane-head"><span>远程源</span></div><div class="mobile-task">未添加远程源 · 顶栏菜单「＋ 添加服务器」可连接其他电脑</div></div>` + mobileDevicesLane()
            : name === "Agent 引擎" ? (cat ? cat.map((e) => `<div class="mobile-task"${e.state === "needs_auth" ? ` data-engine-login="${esc(e.id)}" role="button" style="cursor:pointer"` : ""}>${window.__ccDeck005EngineMarkHtml ? window.__ccDeck005EngineMarkHtml(e.id, e.label) + " " : ""}${esc(e.label || ENGINE_SHORT[e.id] || e.id)} · ${e.state === "ready" ? "已接" : e.state === "needs_auth" ? "未登录 · 点此扫码登录" : e.state === "unsupported" ? "未接入" : "待装"}${Array.isArray(e.models) && e.models.length ? " · " + e.models.length + " 模型" : ""}</div>`).join("") : '<div class="mobile-task">引擎目录未随网页端下发</div>')
            : name === "通用与快捷键" ? `<div class="density-detail"><p>会话卡片信息密度，默认使用标准档。</p><div class="density-control" role="group" aria-label="卡片密度"><button type="button" data-card-density-option="compact">紧凑</button><button type="button" data-card-density-option="standard">标准</button><button type="button" data-card-density-option="relaxed">宽松</button></div></div><div class="mobile-task">${MOD_KEY("K")} 搜索 · ${MOD_KEY("N")} 新建会话</div><div class="mobile-task">通知声音与桌面通知 · 即将支持</div>`
            : name === "团队身份模板" ? (roleSet.size ? [...roleSet.entries()].map(([role, e]) => `<div class="mobile-task">${esc(role)} · ${esc(e.label || ENGINE_SHORT[e.id] || e.id)} · 缺省</div>`).join("") : '<div class="mobile-task">无预置角色模板 · 建团时在组织侧配置</div>')
            : name === "扩展" ? '<div class="mobile-task">验收 · 启用</div><div class="mobile-task">登记 · 启用</div><div class="mobile-task">产物 · 启用</div>'
            : `<div class="mobile-task">${MOD_KEY("K")} 搜索 · ${MOD_KEY("N")} 新建会话</div><div class="mobile-task">通知声音与桌面通知 · 即将支持</div>`;
          list.hidden = true;
          content.querySelector(".primary-btn")?.setAttribute("hidden", "true");
          detail.hidden = false;
          detail.innerHTML = `<button class="mobile-back settings-detail-back" data-settings-detail-back type="button">‹ 设置</button><h3>${esc(name)}</h3>${html}`;
          detail.querySelectorAll("[data-card-density-option]").forEach((btn) => btn.addEventListener("click", () => {
            const desktopBtn = document.querySelector(`#d-settings [data-settings-panel="general"] [data-card-density-option="${btn.dataset.cardDensityOption}"]`);
            if (desktopBtn) desktopBtn.click();
            else mToast("密度控制在桌面设置域");
          }));
        };
        content.dataset.settingsReady = "1";
      }

      // ---------- 事件分发（仅限移动端 stage 内） ----------
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!target.closest("#stage-mobile")) return;
        const kvCopyM = target.closest(".kv-copy-btn"); // #169 追加令2：手机「更多」Session ID / SDK 会话复制钮（B2 copyWithFallback 同链）
        if (kvCopyM) {
          const rowM = kvCopyM.closest("[data-copy-session-id], [data-copy-relay-session-id]");
          if (rowM) {
            const fn = window.__ccDeck005CopyUi && window.__ccDeck005CopyUi.copyWithFallback;
            if (fn) fn(rowM.dataset.copySessionId || rowM.dataset.copyRelaySessionId || "", "已复制");
            else mToast("复制组件未就绪");
          }
          return;
        }
        const navBtn = target.closest(".mobile-nav [data-mobile-root]");
        if (navBtn) { openMobileRoot(navBtn.dataset.mobileRoot); return; }
        const mEngLogin = target.closest("[data-engine-login]"); // #102 批 B：手机设置·引擎目录未登录行 → 登录卡
        if (mEngLogin) { const eng = mEngLogin.dataset.engineLogin || ""; if (eng && window.__ccDeck005LoginCard) window.__ccDeck005LoginCard.open(eng); return; }
        const mGrp = target.closest("[data-mobile-group-toggle]"); // FB16：手机闲置项目组折叠/展开
        if (mGrp) {
          const gname = mGrp.dataset.mobileGroupToggle;
          if (mobileProjOpen.has(gname)) mobileProjOpen.delete(gname); else mobileProjOpen.add(gname);
          renderInbox();
          return;
        }
        const rGrp = target.closest("[data-retired-toggle]"); // [W-RETIRED] 手机归档组折叠/展开（桌面同批同口径）
        if (rGrp) {
          mobileRetiredOpen = !mobileRetiredOpen;
          renderInbox();
          return;
        }
        if (target.closest("[data-mobile-back]")) { closeMobileDetail(); return; }
        if (target.closest(".mobile-notify")) { openMobileNotify(); return; }
        if (target.closest("[data-notify-center-close]")) { openMobileRoot(["team", "project", "settings"].includes(mobileReturn) ? mobileReturn : "inbox"); return; }
        if (target.closest("[data-notify-detail-back]")) { hideNotifyDetail(); return; }
        if (target.closest("[data-notify-detail-close]")) { hideNotifyDetail(); openMobileRoot("inbox"); return; }
        if (target.closest("[data-notify-detail-jump]")) { jumpDesktop("session"); return; }
        const ackBtn = target.closest("[data-mobile-notify-ack]");
        if (ackBtn) { mobileAckNotify(ackBtn.dataset.mobileNotifyAck); return; }
        // FB18 移动端清除：行级 ✕ / 全部清除（与桌面通知域同一 dismissed 账 + ACK 同步）
        const mobileDismiss = target.closest("[data-mobile-notify-dismiss]");
        if (mobileDismiss) {
          const dismissed = window.__ccDeck005DismissedNotifyKeys || (window.__ccDeck005DismissedNotifyKeys = new Set());
          const key = mobileDismiss.dataset.mobileNotifyDismiss;
          const n = (Array.isArray(bridge.notifications) ? bridge.notifications : []).find((x) => x && x.key === key);
          dismissed.add(key);
          if (n && !(n.resolved_at || n.handled_at || n.dismissed_at) && n.actionable === true) {
            void bridge.sendCommand("COMMAND_NOTIFICATION_ACK", { notification_key: key, action: "handled" });
          }
          renderNotify();
          return;
        }
        if (target.closest("[data-notify-clear-all]")) {
          const dismissed = window.__ccDeck005DismissedNotifyKeys || (window.__ccDeck005DismissedNotifyKeys = new Set());
          const isDoneM = (n) => !!(n && (n.resolved_at || n.handled_at || n.dismissed_at));
          const items = (Array.isArray(bridge.notifications) ? bridge.notifications : []).filter((n) => n && !dismissed.has(n.key));
          if (!items.length) { toast("没有可清除的通知"); return; }
          for (const n of items) {
            dismissed.add(n.key);
            if (!isDoneM(n) && n.actionable === true) void bridge.sendCommand("COMMAND_NOTIFICATION_ACK", { notification_key: n.key, action: "handled" });
          }
          renderNotify();
          toast("已清除 " + items.length + " 条通知");
          return;
        }
        const jumpSession = target.closest("[data-notify-mobile-jump]");
        if (jumpSession) { if (jumpSession.dataset.notifyMobileJump) openMobileDetail(jumpSession.dataset.notifyMobileJump); return; }
        const jumpDomain = target.closest("[data-notify-jump-domain]");
        if (jumpDomain) { jumpDesktop(jumpDomain.dataset.notifyJumpDomain); return; }
        const teamTab = target.closest("[data-team-tab]");
        if (teamTab) {
          document.querySelectorAll("[data-team-tab]").forEach((b) => b.classList.toggle("active", b === teamTab));
          document.querySelectorAll("#m-team [data-team-pane]").forEach((p) => { p.style.display = p.dataset.teamPane === teamTab.dataset.teamTab ? "block" : "none"; });
          return;
        }
        if (target.closest("[data-settings-detail-back]")) {
          const content = target.closest("#m-settings .mobile-content");
          const list = content?.querySelector(".mobile-settings");
          const detail = content?.querySelector(".mobile-settings-detail");
          if (content && list && detail) { detail.hidden = true; list.hidden = false; content.querySelector(".primary-btn")?.removeAttribute("hidden"); }
          return;
        }
        const settingsRow = target.closest("#m-settings .mobile-settings .settings-row");
        if (settingsRow && !settingsRow.matches("[data-theme-toggle]")) { settingsRow.closest(".mobile-content")?._renderSettingsDetail?.(settingsRow.querySelector("strong")?.textContent.trim()); return; }
        if (target.closest("[data-update-check]")) {
          // #158-批3：走 foundation 的真更新链（桌面/门控/超时口径与设置页一致）；浏览器形态保留原文案
          const upd = window.__ccDeck005Updater;
          if (!upd || !(window.__TAURI__ || window.ccDeck)) { mToast("当前已是最新版本 · 网页端随 relay 部署更新"); return; }
          const row = target.closest("[data-update-check]");
          row.style.opacity = ".6";
          void (async () => {
            try {
              const r = await upd.check();
              if (r && r.blocked) mToast("此版本请手动更新（Mac / 快照与开发通道不走在线升级）", 4000);
              else if (!r) mToast("当前已是最新版本 · 网页端随 relay 部署更新");
              else if (r.available) mToast("发现新版 v" + r.version + " · 请在「设置 → 关于」确认更新", 4000); // UIPOLISH2 件七：check 不再自动装，口径改引导
              else mToast("已是最新 v" + (r.version || "?"));
            } catch (e) {
              const msg = e && e.message ? e.message : String(e);
              if (/超时|timeout|network|fetch/i.test(msg)) {
                mToast("检查超时（网络受限），可手动下载新版本", 4000);
                void window.__ccDeck005OpenUrl("https://cc.humumu.online/dl/"); // #158-批4a：外链统一兜底链
              } else mToast("检查更新失败：" + msg, 4000);
            } finally { row.style.opacity = ""; }
          })();
          return;
        }
        if (target.closest("[data-mobile-wait-deny]") || target.closest("[data-mobile-wait-allow]")) { mToast("审批操作请在桌面会话域完成"); return; } // ⑥c-3 产品口径：移动端仅浏览验证
        // #164 手机对话域交互（与桌面同一 expanded/convCtl 状态面）：开关 / 组头 / 展开 / 复制 / 任务号
        const mConvTgl = target.closest("[data-conv-toggle]");
        if (mConvTgl) {
          const api = b2Api();
          if (api && api.convCtl) api.convCtl.toggle(mConvTgl.dataset.convToggle);
          if (detailSid) renderMobileDetail(detailSid);
          return;
        }
        const mProcTgl = target.closest("[data-proc-toggle]");
        if (mProcTgl) {
          const api = b2Api();
          const key = "proc:" + mProcTgl.dataset.procToggle;
          if (api && api.expanded) { if (api.expanded.has(key)) api.expanded.delete(key); else api.expanded.add(key); }
          const g = mProcTgl.closest(".procgrp");
          if (g) {
            g.classList.toggle("open");
            const head = g.querySelector(".proc-head");
            if (head) head.textContent = (g.classList.contains("open") ? "▾" : "▸") + " 过程 · " + g.querySelectorAll(".proc-body > .trow").length + " 步";
          }
          return;
        }
        const mX = target.closest(".x-full[data-x], .th-head[data-x]");
        if (mX) {
          const api = b2Api();
          const k = mX.dataset.x;
          if (api && api.expanded) { if (api.expanded.has(k)) api.expanded.delete(k); else api.expanded.add(k); }
          if (detailSid) renderMobileDetail(detailSid);
          return;
        }
        const mCopy = target.closest(".copy-btn");
        if (mCopy) { try { navigator.clipboard && navigator.clipboard.writeText(mCopy.dataset.copy || ""); } catch (_) {} mToast("已复制"); return; }
        const mFp = target.closest(".fpath");
        if (mFp) { try { navigator.clipboard && navigator.clipboard.writeText(mFp.dataset.p || ""); } catch (_) {} mToast("已复制路径 · " + (mFp.dataset.p || "")); return; }
        const mRef = target.closest("[data-task-ref]");
        if (mRef) { // 正文/工具行 #NNN：跳「任务」tab（桌面 jumpToTask 的手机形态）
          document.querySelectorAll("#m-detail .mobile-detail-tabs button")[1]?.click();
          return;
        }
        const mAfTgl = target.closest("#m-detail [data-af-toggle]"); // #168 手机文件夹行开合
        if (mAfTgl) {
          const dir = mAfTgl.dataset.afToggle;
          if (mArtOpen.has(dir)) mArtOpen.delete(dir); else mArtOpen.add(dir);
          if (detailSid) renderMobileDetail(detailSid);
          return;
        }
        const openDetail = target.closest("[data-open-detail]");
        if (openDetail) { openMobileDetail(openDetail.dataset.openDetail); return; }
      });

      function refreshMobile() {
        renderInbox(); renderNotify(); renderTeam(); renderProject(); renderSettingsRows();
        const detail = screenOf("detail"); // ⑥c-3：详情屏活跃时随桥事件刷新五 tab + 状态坞（保持滚动位）
        if (detail && detail.classList.contains("active") && detailSid) renderMobileDetail(detailSid);
      }
      // W-BLANKSET P0：初始化链逐段兜底——单点炸不断全链（此前 setupMobileDetail 内任何
      // 异常都会让 refreshMobile+订阅全断，手机四屏动态内容全空；1016 实锤）。safe 包裹
      // 后：炸段 console.warn 留痕，其余段照常起。
      const safeInit = (name, fn) => { try { fn(); } catch (err) { console.warn("[005-mobile] " + name + " 初始化失败", err); } };
      safeInit("setupMobileSettings", () => setupMobileSettings());
      safeInit("setupMobileDetail", () => setupMobileDetail()); // ⑥c-3：收编五 pane + composer 发送接线
      safeInit("refreshMobile", () => refreshMobile());
      safeInit("subscribe", () => bridge.subscribe(() => refreshMobile()));
      // #158-批3：桌面壳版本异步回填完成（app_version invoke）后刷「关于」版本行
      window.addEventListener("ccdeck:shellver", () => { try { refreshMobile(); } catch (err) { console.warn("[005-mobile] shellver 刷新失败", err); } });
    })();
  