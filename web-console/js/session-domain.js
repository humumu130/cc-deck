              // #143-B2 会话域迁移：本块只存在于 #d-session 区间内，不触碰 <style> 与底部地基脚本。
              // 数据通道订阅地基帧总线（#150 R2 并轨：全页唯一 WS，SNAPSHOT+增量+COMMAND_ACK 同源）。
              (() => {
                "use strict";
                const b2Params = new URLSearchParams(location.search);
                const WS_BASE = location.protocol.startsWith("http") ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws" : "";
                let TOKEN = b2Params.get("token") || "";
                if (WS_BASE) { try { if (TOKEN) localStorage.setItem("cc-deck-005-token", TOKEN); else TOKEN = localStorage.getItem("cc-deck-005-token") || ""; } catch (_) {} }
                // B批补 DV6g-9：云形态借道（__ccDeck005CloudUI 挂钩）——云在线时凭证=配对身份而非
                // LAN token，空态措辞不得落「?token=」分支（pair_ack 后主区仍误导未连接，Playwright 实证）
                const cloudLaneOn = () => { try { const u = window.__ccDeck005CloudUI; return !!(u && u.stateLabel && /已连接/.test(u.stateLabel())); } catch (_) { return false; } };
                // W-NOVAFIX B2：桌面形态判定（Tauri 壳）+ token 活读。TOKEN 是解析期快照，桌面壳
                // 无 URL query 时恒空——地基 probe_local 探测命中后只写 localStorage/ctx，不同步本
                // 快照，四处空态文案因此永远落「?token=」分支。改为经 __ccDeck005Token 活读地基
                // 当前值；桌面形态（非浏览器）一律不显示「?token=」引导，改「正在连接本机 relay…」。
                if (typeof window.__ccDeck005DesktopForm !== "function") {
                  window.__ccDeck005DesktopForm = () => { try { return !!(window.ccDeck || window.__TAURI__ || /tauri\.localhost/i.test(location.host)); } catch (_) { return false; } };
                }
                const desktopForm = window.__ccDeck005DesktopForm;
                const tokenLive = () => { const v = window.__ccDeck005Token; return v === undefined ? TOKEN : String(v || ""); };

                // ---------- #158-批4a 路径展示/比较共享助手（本 IIFE 是文档序最早的内联脚本，在此幂等挂
                // window；后续 team/B4/notify/地基/mobile 各 IIFE 解析期就要取别名，不重复定义） ----------
                // Windows 桌面形态用户应看到 C:\Users\x 而非 C:/Users/x：displayPath 只管展示——桌面
                // Windows 形态（非 Mac UA 且壳桥在场）把 / 显示为 \；逻辑比较一律走 normPath
                // （两侧统一 / 再比，1:1 替换保序，切片索引天然对齐）
                if (!window.__ccDeck005PathUi) {
                  const winShellForm = () => {
                    try {
                      if (/Mac/i.test(navigator.userAgent)) return false;
                      if (window.__TAURI__ || window.ccDeck) return true;
                      return document.documentElement.classList.contains("win-tauri");
                    } catch (_) { return false; }
                  };
                  window.__ccDeck005PathUi = {
                    displayPath: (p) => { const v = String(p ?? ""); return v && winShellForm() ? v.replace(/\//g, "\\") : v; },
                    normPath: (p) => String(p ?? "").replace(/[\\/]/g, "/"),
                    baseName: (p) => { const n = String(p ?? "").replace(/[\\/]/g, "/").replace(/\/+$/, ""); const i = n.lastIndexOf("/"); return i >= 0 ? n.slice(i + 1) : (n || String(p ?? "")); },
                    dirOf: (p) => { const v = String(p ?? ""); const i = Math.max(v.lastIndexOf("/"), v.lastIndexOf("\\")); return i > 0 ? v.slice(0, i) : ""; },
                  };
                }
                const displayPath = window.__ccDeck005PathUi.displayPath;
                const baseName = window.__ccDeck005PathUi.baseName;

                const ENGINES = { claude: ["Claude", "claude"], codex: ["Codex", "codex"], trae: ["Trae", "trae"], "qwen-code": ["Qwen Code", "qwen"], codebuddy: ["Codebuddy", "codebuddy"], zcode: ["ZCode", "zcode"], glm: ["GLM", "glm"] };
                // W-ENGLM（#253）：model→engine 推断词表+共享解析——head/列表卡/消息流头像/
                // inspector/详情 kv 五链同源（原 MODEL_HINTS 只在 renderHeader 内联，列表卡与
                // 消息流对 engine 空会话各降级：head 错显 Claude、头像落 ✻）。词表序=匹配优先级。
                // W-ENGLM2 A（用户 1025 拍板）：引擎徽章=宿主 CLI 身份——Claude Code 会话不管
                // 挂什么模型（claude-*/glm-* 别名接 bigmodel）引擎恒=Claude。glm 不是注册引擎
                //（engine catalog 六引擎无 glm），推断词表去 ["glm","glm"]：model 含 glm 推断
                // 落空 → 兜底 claude → 螃蟹 Claude·CLI。ENGINES.glm 显示键保留（W-ENGLM C 纯
                // 防御：engine 字段真出现 "glm" 也体面显示，不再错显）。
                const MODEL_HINTS = [["claude", "claude"], ["codex", "codex"], ["codebuddy", "codebuddy"], ["qwen-code", "qwen-code"], ["qwen", "qwen-code"], ["trae", "trae"], ["zcode", "zcode"]];
                const inferEngineOf = (s) => (s && s.engine) || ((MODEL_HINTS.find(([n]) => String((s && s.model) || "").toLowerCase().includes(n)) || [])[1] || "");
                const engineMetaOf = (s) => {
                  const key = inferEngineOf(s) || "claude";
                  const meta = ENGINES[key];
                  if (meta) return [meta[0], key];
                  // W-ENGLM E：未收录引擎兜底不再错显 "Claude"——显示原引擎名（class 空=无 tint/品牌图，名实相符优先）
                  return [(s && s.engine) || key, key];
                };
                const VERIFY_RE = /[〔\[【]\s*待验证\s*[〕\]】]/;   // #85 待验证档：in_progress + 前缀约定独立分组
                const HIST_PREFIX = "cc.input.hist.";               // #95 按会话分桶的输入历史
                const HIST_MAX = 200;
                const IMG_MAX = 8, FILE_MAX = 5, FILE_SIZE_MAX = 20 * 1024 * 1024; // B20 附件上限提升（图 8 / 文件 5）
                const STATUS_TAG = { WORKING: ["运行中", "done"], WAITING: ["待处理", "action"], ERROR: ["错误", "danger"], DONE: ["完成", "done"] }; // W-V8 批2a：运行中绿系（v8 语义对调，info 蓝退役）
                const DOCK_STATE = { WORKING: "running", WAITING: "waiting", ERROR: "suspended", DONE: "closing" }; // B21 态图标承态，状态词退役

                const S = {
                  status: "offline",
                  hasSnapshot: false, relayName: location.host, homedir: "", platform: "",
                  sessions: new Map(), timelines: new Map(), logsTruncated: new Map(),
                  engineCatalog: null, models: [], projects: [],
                  collabMode: undefined, // W-MODE：SNAPSHOT.collab_mode（undefined=旧 relay 不渲染开关；"leader"|"no-leader"）
                  leaderSessionId: "", // #240 W-LEADERHIDE：SNAPSHOT.leader_session_id（组织锚 Leader 会话 id，空串=无锚/旧 relay）——列表滤 Leader 卡用
                  userPinnedBottom: true, scrollKeep: new Map(), scrollLock: false, // 件十九/二十滚动状态机 v3：用户贴底态 + 每会话 {top,bottom} 记录 + 程序写轻锁
                  tabChatMemo: null, // #124 tab 往返滚动保持：离开对话 tab 瞬间的 {sid, top, bottom} 真值（捕获阶段记，防 display:none clamp 污染）；切回对话 tab 恢复后即清
                  experiences: null, // W-EXPP2：SNAPSHOT.experience（null=旧 relay；会话「更多」tab 经验注入分节只读消费）
                  selected: "", staged: [], engineChoice: "", filter: "all",
                  ackWaiters: new Map(), artFetches: new Map(),
                  echo: new Map(), // W-PORT-A R-4 发送乐观回显：sid → [{key, text, ts, state:"sending"|"fail"}]（回显对账/超时自撤，见 renderConversation）
                  imgUrls: new Map(), // FB14 气泡附图缓存：key="sid/ref" → {state:"loading"|"ready"|"failed", url?}（url=Blob objectURL）
                  hist: { sid: null, list: [], idx: -1, draft: "" },
                  forceScroll: true,
                  slimUnread: new Map(), // [t-7e0c6189] 团队未读聚合：gid → Set<sid>（编制内 worker/QA 有新输出且未在看）；进团队域/展第四列/直开即清（内存态，重启随增量重建）
                  drawerGid: "", // [t-7e0c6189] 第四列展开的团队（""=收起；localStorage 记忆）
                  _drawerMutex: false, // W-TEAMCHIP2 ③：互斥收起标记——true=第三列收起由抽屉互斥链开的（关抽屉/切 overlay 要还原；用户既定收起不还原）
                  boards: new Map(), // W-TEAMSNC ④：gid → 板 entries（SNAPSHOT.boards 锚定 + BOARD_UPDATED 帧跟随；团队域 state.boards 同源数据）
                };
                let UI = null;
                // #B3-4 每会话输入草稿（旧壳 inputDrafts 同语义）：切走存 / 切回恢复 / 发送清，
                // 删除会话随 #B3-3 历史桶一并回收。005 单源——键直接用 sid。
                const inputDrafts = new Map();

                // ---------- 基础工具 ----------
                const $id = (id) => document.getElementById(id);
                const cssEsc = (v) => String(v).replace(/["\\]/g, "\\$&");
                function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
                function uuid() { return (crypto.randomUUID && crypto.randomUUID()) || ("c" + Date.now() + "-" + Math.random().toString(16).slice(2)); }
                function b2Toast(msg, ms) { const t = $id("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(b2Toast._t); b2Toast._t = setTimeout(() => t.classList.remove("show"), ms || 2400); }
                function svgUse(name) { return '<svg class="icon-inline" aria-hidden="true"><use href="#icon-' + name + '"></use></svg>'; }
                function msgRoleOf(kind) { return kind === "user_message" ? "user" : kind === "assistant_text" ? "ai-text" : kind === "thinking" ? "ai-think" : kind === "tool_use" ? "ai-tool" : kind === "tool_result" ? "ai-result" : "ai-sys"; }
                // W-AUTOMSG #194（用户 1021 反馈）：自动注入消息标记表——与 expo-app/src/auto-msg.ts
                // 同表副本（两端无共享机制，改清单两处同步）。「【cc-deck 巡检轮】」=用户自配
                // cron 巡检文案；「[值守喂活]」=relay feedPM 值守注入首行固定格式（同语义噪音面）
                const AUTO_MSG_PREFIXES = ["【cc-deck 巡检轮】", "[值守喂活]"];
                function isAutoInjected(text) { const t = String(text ?? "").trimStart(); return AUTO_MSG_PREFIXES.some((p) => t.startsWith(p)); }
                function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); }
                function dayLabel(ts) { // #162 微信式分级（今天/昨天/M月d日/yyyy年M月d日）
                  if (!ts) return "";
                  const now = new Date();
                  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                  if (ts >= startOfToday) return "今天";
                  if (ts >= startOfToday - 86400e3) return "昨天";
                  const t = new Date(ts);
                  const md = t.getMonth() + 1 + "月" + t.getDate() + "日";
                  return t.getFullYear() === now.getFullYear() ? md : t.getFullYear() + "年" + md;
                }
                function fmtHM(ts) { const d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
                // #B3-8 卡片时间 dayLabel 同族（旧壳 fmtLastActive 口径直搬）：今天 HH:mm / 昨天 /
                // 今年 M月d日 / 跨年带年份——自然日边界（非 24h 滚动窗）
                function fmtListTime(ts) {
                  if (!ts) return "";
                  const now = new Date();
                  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                  if (ts >= startOfToday) return fmtHM(ts);
                  if (ts >= startOfToday - 86400e3) return "昨天";
                  const t = new Date(ts);
                  const md = t.getMonth() + 1 + "月" + t.getDate() + "日";
                  return t.getFullYear() === now.getFullYear() ? md : t.getFullYear() + "年" + md;
                }
                function relTime(ts) {
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
                }
                function fmtDur(ms) { const s = Math.floor(ms / 1000); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; const h = Math.floor(m / 60); if (h < 24) return h + "h" + (m % 60) + "m"; return Math.floor(h / 24) + "d"; }
                // #224 任务时长（CLI h/m/s 全显）+ 累计输出紧凑（↓ 同款）
                function fmtTaskDur(sec) { const s2 = Math.max(0, Math.floor(sec)); const h2 = Math.floor(s2 / 3600); const m2 = Math.floor((s2 % 3600) / 60); if (h2 > 0) return h2 + "h" + m2 + "m" + (s2 % 60) + "s"; if (m2 > 0) return m2 + "m" + (s2 % 60) + "s"; return s2 + "s"; }
                function fmtDownTok(n) { if (n >= 1e6) return (n / 1e6).toFixed(1) + "m"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"; return String(n); }
                function tokStr(n) { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M"; if (n >= 1e3) return Math.round(n / 1e3) + "k"; return String(n); }
                function sizeStr(n) { n = Number(n) || 0; if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB"; if (n >= 1024) return Math.round(n / 1024) + " KB"; return n + " B"; }
                function ctxPct(s) { if (!s || !s.context_usage) return 0; return Math.min(100, Math.round((s.context_usage / (s.context_limit || 1e6)) * 100)); }
                function oneLine(t) { const v = String(t ?? "").replace(/\s+/g, " ").trim(); return v.length > 120 ? v.slice(0, 120) + "…" : v; }
                // #164 textBodyHtml（esc+br）退役：对话域正文一律走 mdHtml（任务 tab 的 taskRefHtml 保留 .tag 胶囊形态）
                function taskRefHtml(text) { return esc(text).replace(/#(\d{1,4})(?!\w)/g, '<span class="tag" data-task-ref="$1" style="cursor:pointer" title="定位任务清单">#$1</span>'); }
                function toolIcon(t) { return /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t || "") ? "✎" : t === "Bash" ? "❯_" : /^(Read|Glob|Grep|WebFetch|WebSearch)$/.test(t || "") ? "▤" : "⚙"; }
                // #47 任务生命周期行（2026-10-10）：TaskCreate=创建、TaskUpdate=状态变更/完成
                // （completed 即完成态）；TaskGet/TaskList 只读查询不算生命周期，仍归过程。
                // 图标选 sprite 的 icon-accept（方框勾）：任务卡+勾的复合形，创建到完成全周期
                // 语义都盖得住；齿轮（toolIcon 兜底 ⚙）退回纯工具行专用
                function isTaskLifeTool(t) { return t === "TaskCreate" || t === "TaskUpdate"; }
                function taskLifeIcon() { return '<svg class="icon-inline" aria-hidden="true"><use href="#icon-accept"></use></svg>'; }
                // ---------- #164 轻量 Markdown + 语法高亮 + 链接化（旧壳 :7548-7845 全量移植，escapeHtml→esc） ----------
                // 任务号口径与 005 既有 taskRefHtml 一致（#NNN 1~4 位），渲染成 .task-ref 可点段
                //（旧壳 .task-ref 形态；005 列表/任务 tab 的 .tag 胶囊不复用到正文行内）。
                const FPATH_RE = /\b[A-Za-z]:[\\/][\w.\-\\/]+|\/(?:home|Users|root|mnt|opt|tmp|var)\/[\w.\-\\/]+/g;
                function fpathHtml(t) {
                  const s = String(t ?? "");
                  let out = "", last = 0;
                  for (const m of s.matchAll(FPATH_RE)) {
                    const i = m.index ?? 0;
                    out += esc(s.slice(last, i));
                    const p = m[0].replace(/[.,;:!?'"）】》]+$/, ""); // 尾随标点不属路径
                    out += '<span class="fpath" data-p="' + esc(p) + '">' + esc(p) + "</span>";
                    if (p.length < m[0].length) out += esc(m[0].slice(p.length));
                    last = i + m[0].length;
                  }
                  return out + esc(s.slice(last));
                }
                function linkifyEscaped(escaped) {
                  return escaped.replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, (u) =>
                    '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>");
                }
                function userMsgHtml(t) {
                  const s = String(t ?? "");
                  if (!/#\d{1,4}(?!\w)/.test(s)) return linkifyEscaped(esc(s));
                  return s.split(/#(\d{1,4})(?!\w)/g).map((p, i) =>
                    i % 2 === 1 ? '<span class="task-ref" data-task-ref="' + p + '" title="定位任务清单">#' + p + "</span>" : linkifyEscaped(esc(p))
                  ).join("");
                }
                function taskRefRow(t) { // 工具/结果行文本：#NNN 可点 + 绝对路径可点（旧壳 taskRefHtml 口径）
                  const s = String(t ?? "");
                  if (!/#\d{1,4}(?!\w)/.test(s)) return fpathHtml(s);
                  return s.split(/#(\d{1,4})(?!\w)/g).map((p, i) =>
                    i % 2 === 1 ? '<span class="task-ref" data-task-ref="' + p + '" title="定位任务清单">#' + p + "</span>" : fpathHtml(p)
                  ).join("");
                }
                const MD_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
                const mdSplitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
                function mdBlocks(src) {
                  const out = [];
                  const lines = String(src).split(/\r?\n/);
                  let para = [], inCode = false, code = [], tableBuf = [], lang = "";
                  const flush = () => { if (para.length) { out.push({ t: "p", text: para.join("\n") }); para = []; } };
                  const flushTable = () => {
                    if (!tableBuf.length) return;
                    if (tableBuf.length >= 2 && MD_DELIM_RE.test(tableBuf[1])) {
                      out.push({ t: "table", head: mdSplitRow(tableBuf[0]), rows: tableBuf.slice(2).map(mdSplitRow) });
                    } else out.push({ t: "p", text: tableBuf.join("\n") });
                    tableBuf = [];
                  };
                  for (const raw of lines) {
                    if (inCode) {
                      if (/^\s*```/.test(raw)) { out.push({ t: "code", lang, text: code.join("\n") }); code = []; lang = ""; inCode = false; }
                      else code.push(raw);
                      continue;
                    }
                    const mdFence = /^\s*```([\w+#.-]*)/.exec(raw);
                    if (mdFence) { flush(); inCode = true; lang = mdFence[1].trim().toLowerCase(); continue; }
                    if (/^\s*\|/.test(raw)) { flush(); tableBuf.push(raw); continue; }
                    flushTable();
                    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
                    if (h) { flush(); out.push({ t: "h", level: h[1].length, text: h[2] }); continue; }
                    if (/^\s*([-*_]\s*){3,}$/.test(raw)) { flush(); out.push({ t: "hr" }); continue; }
                    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
                    if (li) { flush(); out.push({ t: "li", depth: Math.min(2, Math.floor(li[1].length / 2)), ord: /\d/.test(li[2]) ? li[2].replace(/[.)]/, "") : null, text: li[3] }); continue; }
                    const q = /^>\s?(.*)$/.exec(raw);
                    if (q) { flush(); out.push({ t: "quote", text: q[1] }); continue; }
                    if (!raw.trim()) flush();
                    else para.push(raw);
                  }
                  if (inCode && code.length) out.push({ t: "code", lang, text: code.join("\n") }); // 截断码块兜底
                  flushTable();
                  flush();
                  return out;
                }
                const MD_INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n\s]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|https?:\/\/[^\s（）【】，。；、！？：""''《》<>()\[\]{}一-鿿぀-ヿ]+|[A-Za-z]:[\\/][\w.\-\\/]+|\/(?:home|Users|root|mnt|opt|tmp|var)\/[\w.\-\\/]+|#\d{1,4}\b)/g;
                const URL_TRAIL_PUNCT = /[.,;:!?"']+$/;
                const HTTP_RE = /^https?:\/\//i;
                const FPATH_START_RE = /^(?:[A-Za-z]:[\\/]|\/(?:home|Users|root|mnt|opt|tmp|var)\/)/;
                function mdInline(text) {
                  let out = "", last = 0;
                  for (const m of String(text).matchAll(MD_INLINE_RE)) {
                    const tok = m[0], i = m.index ?? 0;
                    out += esc(text.slice(last, i));
                    if (tok.startsWith("**") || tok.startsWith("__")) out += "<b>" + esc(tok.slice(2, -2)) + "</b>";
                    else if (tok.startsWith("`")) out += "<code>" + esc(tok.slice(1, -1)) + "</code>";
                    else if (tok.startsWith("[")) {
                      // [标题](url)：仅 http(s) 可成为链接，防 javascript: 注入（旧壳口径）
                      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
                      out += mm && HTTP_RE.test(mm[2])
                        ? '<a href="' + esc(mm[2]) + '" target="_blank" rel="noopener noreferrer">' + esc(mm[1]) + "</a>"
                        : esc(tok);
                    } else if (tok.startsWith("http")) {
                      const url = tok.replace(URL_TRAIL_PUNCT, "");
                      out += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + "</a>";
                      if (url.length < tok.length) out += esc(tok.slice(url.length));
                    } else if (FPATH_START_RE.test(tok)) {
                      const p = tok.replace(/[.,;:!?'"）】》]+$/, "");
                      out += '<span class="fpath" data-p="' + esc(p) + '">' + esc(p) + "</span>";
                      if (p.length < tok.length) out += esc(tok.slice(p.length));
                    } else if (tok.charAt(0) === "#") {
                      out += '<span class="task-ref" data-task-ref="' + tok.slice(1) + '" title="定位任务清单">#' + tok.slice(1) + "</span>";
                    }
                    else out += "<i>" + esc(tok.slice(1, -1)) + "</i>";
                    last = i + tok.length;
                  }
                  return out + esc(text.slice(last));
                }
                // ---------- #141 语法高亮 tokenizer（旧壳 :7686-7823 原样移植：SYN_ALIAS 归一语言族 →
                // 规则集单趟 matchAll 收集候选 → 按区间吸收去重叠 → 分段转义包 span；>100KB 降级纯文本） ----------
                const SYN_ALIAS = {
                  xml: "xml", html: "xml", svg: "xml", vue: "xml", xsd: "xml", xsl: "xml", xslt: "xml", plist: "xml", axml: "xml",
                  json: "json", jsonc: "json", json5: "json",
                  py: "py", python: "py", python3: "py",
                  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", terminal: "sh",
                  sql: "sql", mysql: "sql", mariadb: "sql", plsql: "sql", psql: "sql", postgres: "sql", postgresql: "sql", sqlite: "sql",
                  js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
                  ts: "ts", typescript: "ts", tsx: "ts",
                  css: "css", scss: "css", sass: "css", less: "css",
                  yaml: "yaml", yml: "yaml",
                  diff: "diff", patch: "diff",
                  java: "clike", kotlin: "clike", kt: "clike", swift: "clike", objectivec: "clike", objc: "clike",
                  go: "clike", golang: "clike", rust: "clike", rs: "clike",
                  c: "clike", cpp: "clike", "c++": "clike", cc: "clike", cxx: "clike", h: "clike", hpp: "clike", hh: "clike",
                  cs: "clike", csharp: "clike", php: "clike", dart: "clike", scala: "clike",
                };
                function synLangOf(tag) {
                  const k = (tag || "").trim().toLowerCase();
                  return k && Object.prototype.hasOwnProperty.call(SYN_ALIAS, k) ? SYN_ALIAS[k] : null;
                }
                const synKwRe = (words, ci) => new RegExp("\\b(?:" + words + ")\\b", ci ? "gi" : "g");
                const SYN_SQL_KW = "select|from|where|insert|into|values|update|set|delete|create|drop|alter|rename|truncate|table|database|schema|view|index|key|join|left|right|full|inner|outer|cross|natural|straight_join|on|using|as|and|or|not|in|is|null|like|ilike|rlike|regexp|between|exists|union|all|distinct|case|when|then|else|end|primary|foreign|references|constraint|unique|check|default|auto_increment|on duplicate|engine|charset|character|collate|if|begin|commit|rollback|transaction|trigger|procedure|function|declare|return|call|grant|revoke|partition|over|window|order|group|by|having|limit|offset|asc|desc|with|recursive|interval|day|hour|minute|month|year|now|current_timestamp|count|sum|avg|min|max|cast|convert|dual";
                const SYN_JS_KW = "var|let|const|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|as|null|undefined|true|false|void|delete|static|get|set";
                const SYN_TS_KW = SYN_JS_KW + "|interface|type|enum|implements|private|public|protected|readonly|namespace|declare|abstract|keyof|infer|satisfies|is|string|number|boolean|any|unknown|never|symbol|bigint";
                const SYN_PY_KW = "def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|with|try|except|finally|raise|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self|cls";
                const SYN_SH_KW = "if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|exit|local|export|source|alias|shift|read|declare|unset|set|trap|exec|eval|echo|printf|cd|pushd|popd|sudo";
                const SYN_CLIKE_KW = "abstract|alias|and|as|assert|async|await|base|bool|boolean|break|byte|case|catch|chan|char|class|const|constructor|continue|crate|data|defer|default|delegate|delete|do|double|dyn|else|enum|event|explicit|extern|false|final|finally|fn|for|foreach|func|function|get|go|goto|if|impl|implements|import|in|include|init|inline|instanceof|int|interface|internal|is|let|lock|long|match|mod|module|mut|namespace|new|nil|null|nullptr|object|operator|or|override|package|private|protected|pub|public|raise|readonly|ref|register|require|return|sealed|self|set|short|signed|sizeof|static|str|string|struct|super|switch|synchronized|template|this|throw|throws|trait|transient|true|try|type|typedef|typename|typeof|union|unsafe|unsigned|use|using|val|var|virtual|void|volatile|when|where|while|with|yield";
                const SYN_RULES = {
                  xml: [
                    { c: "com", re: /<!--[\s\S]*?-->/g },
                    { c: "tag", re: /<(?:\?[\w.:-]+|![A-Z][\w.:-]*|\/?[\w.:-]+)/g },
                    { c: "attr", re: /[\w.:-]+(?==)/g },
                    { c: "str", re: /"[^"]*"|'[^']*'/g },
                  ],
                  sql: [
                    { c: "com", re: /--[^\n]*|\/\*[\s\S]*?\*\//g },
                    { c: "str", re: /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"|`[^`\n]*`/g },
                    { c: "kw", re: synKwRe(SYN_SQL_KW, true) },
                    { c: "num", re: /\b\d+(?:\.\d+)?\b/g },
                  ],
                  js: [
                    { c: "com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
                    { c: "str", re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g },
                    { c: "kw", re: synKwRe(SYN_JS_KW) },
                    { c: "num", re: /\b0[xXbB][0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g },
                  ],
                  ts: [
                    { c: "com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
                    { c: "str", re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g },
                    { c: "kw", re: synKwRe(SYN_TS_KW) },
                    { c: "num", re: /\b0[xXbB][0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g },
                  ],
                  json: [
                    { c: "attr", re: /"(?:[^"\\]|\\.)*"(?=\s*:)/g },
                    { c: "str", re: /"(?:[^"\\]|\\.)*"/g },
                    { c: "kw", re: /\b(?:true|false|null)\b/g },
                    { c: "num", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g },
                  ],
                  py: [
                    { c: "com", re: /#[^\n]*/g },
                    { c: "str", re: /[rRfFbB]{0,2}(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g },
                    { c: "kw", re: synKwRe(SYN_PY_KW) },
                    { c: "num", re: /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b/g },
                  ],
                  sh: [
                    { c: "com", re: /(?:^|\s)#[^\n]*/g },
                    { c: "str", re: /"(?:[^"\\]|\\.)*"|'[^']*'/g },
                    { c: "kw", re: synKwRe(SYN_SH_KW) },
                    { c: "attr", re: /\$\{[^}\n]*\}|\$[\w@#?*!-]+/g },
                    { c: "num", re: /\b\d+\b/g },
                  ],
                  clike: [
                    { c: "com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
                    { c: "str", re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'|`(?:[^`\\]|\\.)*`/g },
                    { c: "attr", re: /#\[[^\]\n]*\]|@\w+|#\w+(?=[^\w(])/g },
                    { c: "kw", re: synKwRe(SYN_CLIKE_KW) },
                    { c: "num", re: /\b0[xXbB][0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]{0,3}\b/g },
                  ],
                  css: [
                    { c: "com", re: /\/\*[\s\S]*?\*\//g },
                    { c: "str", re: /"[^"\n]*"|'[^'\n]*'/g },
                    { c: "kw", re: /@[\w-]+|!important\b/g },
                    { c: "tag", re: /[.#][\w-]+|::?[\w-]+(?=[\s,{):>+~[])/g },
                    { c: "attr", re: /[-a-zA-Z]+(?=[ \t]*:)/g },
                    { c: "num", re: /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|s|ms|fr|deg|ch|pt|%)?/g },
                  ],
                  yaml: [
                    { c: "com", re: /(?:^|\s)#[^\n]*/g },
                    { c: "attr", re: /^[ \t]*(?:- )?[ \t]*[\w.$-]+(?=[ \t]*:)/gm },
                    { c: "str", re: /"(?:[^"\\]|\\.)*"|'[^']*'/g },
                    { c: "kw", re: /\b(?:true|false|null|yes|no|on|off)\b/g },
                    { c: "num", re: /\b\d+(?:\.\d+)?\b/g },
                  ],
                  diff: [
                    { c: "add", re: /^\+[^\n]*/gm },
                    { c: "del", re: /^-[^\n]*/gm },
                    { c: "kw", re: /^@@[^\n]*/gm },
                    { c: "attr", re: /^(?:diff |index |new file mode|deleted file mode|rename )/gim },
                  ],
                };
                const SYN_MAX_BYTES = 100000;
                function synTokenize(code, fam) {
                  if (!code || code.length > SYN_MAX_BYTES) return null;
                  const rules = SYN_RULES[fam];
                  if (!rules) return null;
                  const cands = [];
                  for (let r = 0; r < rules.length; r++)
                    for (const m of String(code).matchAll(rules[r].re)) {
                      if (m[0]) cands.push({ s: m.index ?? 0, e: (m.index ?? 0) + m[0].length, c: rules[r].c, r });
                    }
                  cands.sort((a, b) => a.s - b.s || a.r - b.r);
                  const toks = [];
                  let pos = 0;
                  for (const t of cands) {
                    if (t.s < pos) continue; // 落在已消费区间内：丢弃（注释里的字符串不重复着色）
                    const last = toks[toks.length - 1];
                    if (last && last.c === t.c && last.e === t.s) last.e = t.e; // 相邻同类合并
                    else toks.push({ s: t.s, e: t.e, c: t.c });
                    pos = t.e;
                  }
                  return toks;
                }
                function synHtml(code, fam) {
                  const toks = synTokenize(code, fam);
                  if (!toks) return null;
                  let out = "", pos = 0;
                  for (const t of toks) {
                    if (t.s > pos) out += esc(code.slice(pos, t.s));
                    out += '<span class="s-' + t.c + '">' + esc(code.slice(t.s, t.e)) + "</span>";
                    pos = t.e;
                  }
                  if (pos < code.length) out += esc(code.slice(pos));
                  return out;
                }
                function mdHtml(src) {
                  let html = "";
                  for (const b of mdBlocks(src)) {
                    if (b.t === "h") html += '<div class="md-h' + b.level + '">' + mdInline(b.text) + "</div>";
                    else if (b.t === "code") {
                      const fam = synLangOf(b.lang);
                      const body = fam ? (synHtml(b.text, fam) ?? esc(b.text)) : esc(b.text);
                      html += '<div class="md-code-wrap"><span class="copy-btn" data-copy="' + esc(b.text) + '" title="复制代码">⧉ 复制</span><pre class="md-code">' + body +
                        (b.lang ? '<span class="md-lang">' + esc(b.lang) + "</span>" : "") + "</pre></div>";
                    }
                    else if (b.t === "li") html += '<div class="md-li" style="padding-left:' + (14 + b.depth * 14) + 'px"><span class="md-bul">' + (b.ord ? b.ord + "." : "•") + "</span> " + mdInline(b.text) + "</div>";
                    else if (b.t === "quote") html += '<div class="md-quote">' + mdInline(b.text) + "</div>";
                    else if (b.t === "table") html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
                      b.head.map((c) => "<th>" + mdInline(c) + "</th>").join("") + "</tr></thead><tbody>" +
                      b.rows.map((r) => "<tr>" + b.head.map((_, j) => "<td>" + mdInline(r[j] ?? "") + "</td>").join("") + "</tr>").join("") +
                      "</tbody></table></div>";
                    else if (b.t === "hr") html += '<div class="md-hr"></div>';
                    else html += '<div class="md-p">' + mdInline(b.text) + "</div>";
                  }
                  return html;
                }
                const diffLine = (l) => '<div class="' + (l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "c") + '">' + esc(l || " ") + "</div>";
                // 展开态（旧壳 expanded Set + eKey 兜底口径：无 id 条目用 ts|kind|len，跨重渲稳定）
                const expanded = new Set();
                const eKey = (e) => e.id || (e.ts + "|" + e.kind + "|" + (e.text || "").length);
                // #164 过程/思考开关：过程默认开、思考默认关；localStorage 持久化（ccd_proc_show /
                // ccd_think_show——旧壳思考开关不落盘，005 按任务书补持久化，偏差备案）
                let procShow = (() => { try { return localStorage.getItem("ccd_proc_show") !== "0"; } catch (_) { return true; } })();
                let thinkShown = (() => { try { return localStorage.getItem("ccd_think_show") === "1"; } catch (_) { return false; } })();
                // #168 图标随六类分型（sheet=table / accept=accept 不再落 gear/clip）；pkg 内安装包细分 package
                function artifactIconFor(name) {
                  const k = artifactKindFor(name);
                  if (k === "pkg") return ["apk", "ipa", "dmg", "exe", "msi"].includes(String(name || "").toLowerCase().split(".").pop()) ? "package" : "archive";
                  return ({ doc: "file-text", sheet: "table", code: "code", image: "image", accept: "accept" })[k] || "clip";
                }
                // #B3-15 输出物六类分色（#168 原型 token 落地）：doc 紫 / sheet 琥珀 / code=info /
                // image=done / pkg 中性 / accept=brand-hover。判定=文件名含验收语义优先，其次扩展名
                // 分桶，未知归中性档；着色集中在 <style> 的 .art-ico.k-*（桌面+手机共用一处）。
                const ART_KIND_EXT = {
                  doc: new Set(["md", "markdown", "txt", "text", "rst", "adoc", "asciidoc", "pdf", "doc", "docx", "rtf", "pages", "key", "keynote", "ppt", "pptx", "log"]),
                  sheet: new Set(["xlsx", "xls", "csv", "tsv", "numbers", "json", "jsonl", "jsonc", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "plist", "db", "sqlite"]),
                  code: new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "vue", "svelte", "sh", "zsh", "bash", "sql", "css", "scss", "less", "html", "htm", "xml"]),
                  image: new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "tif", "heic", "avif"]),
                  pkg: new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso", "jar", "war", "apk", "ipa", "exe", "msi"]),
                };
                function artifactKindFor(name) {
                  const n = String(name || "");
                  if (/验收|acceptance/i.test(n)) return "accept";
                  const ext = n.toLowerCase().split(".").pop();
                  for (const k of ["doc", "sheet", "code", "image", "pkg"]) if (ART_KIND_EXT[k].has(ext)) return k;
                  return "pkg";
                }
                function artIconHtml(name) { return '<span class="art-ico k-' + artifactKindFor(name) + '">' + svgUse(artifactIconFor(name)) + "</span>"; }
                function shortTitle(s) { return String(s.title || s.initial_prompt || s.session_id || "").slice(0, 24); }
                // #158-批4a：homedir 前缀归一比较（Windows 数据 \ 与代码拼 / 不匹配会让 ~ 缩短失效），
                // 输出走 displayPath（桌面 Windows 形态显示反斜杠）；1:1 替换保序，切片索引对齐
                function shortPath(p) {
                  const v = String(p || "");
                  if (!v || !S.homedir) return displayPath(v);
                  const n = (s) => s.replace(/[\\/]/g, "/").replace(/\/+$/, "");
                  const vN = n(v), hN = n(S.homedir);
                  if (hN && (vN === hN || vN.startsWith(hN + "/"))) return "~" + displayPath(v.slice(S.homedir.length));
                  return displayPath(v);
                }

                // ---------- B2 数据通道（#150 R2 并轨：退役自开 WS 与重连/握手超时，改订阅地基帧总线） ----------
                function failB2Flights() { // 原自持连接 onclose 的 fail-fast 逻辑提取（#143 盲评R-1 语义保持：断线飞行命令立即判未达，fail 不 toast，命令按未达处理）
                  for (const v of S.ackWaiters.values()) { clearTimeout(v.t); try { v.res(null); } catch {} }
                  S.ackWaiters.clear();
                }

                function sendCmd(type, payload, wsOverride) { // #150 R2 并轨：命令改走地基主连接（全页唯一 WS），ACK 经总线回 onAck 结算；W-WINPAIR-R7①：带会话的命令按会话源路由（聚合下远程会话走云链）；W-PORT-A R-2：wsOverride=新建弹窗显式目标源通道（云源创建走云 shim，最高优先）
                  const w = wsOverride || (window.__ccDeck005RouteWs ? window.__ccDeck005RouteWs(payload) : window.__ccDeck005MainWs);
                  if (!w || w.readyState !== 1) {
                    // T10：路由器显式拒发（null——两源表+桥都查不到该会话）≠ 连接断——分开设文案，
                    // 「会话不存在」类误导性错投报错从根上消除
                    const sidMiss = !wsOverride && w === null && payload && typeof payload.session_id === "string";
                    b2Toast(sidMiss ? "会话不在已连接的源上（可能已删除或所属源离线）" : "relay 未连接，命令未发送");
                    return null;
                  }
                  const cmd = { command_id: uuid(), type, payload, ts: Date.now() };
                  w.send(JSON.stringify(cmd));
                  return cmd.command_id;
                }
                function commandAck(type, payload, timeoutMs = 8000) {
                  return new Promise((resolve) => {
                    const id = sendCmd(type, payload);
                    if (!id) { resolve(null); return; }
                    const t = setTimeout(() => { S.ackWaiters.delete(id); resolve(null); }, timeoutMs);
                    S.ackWaiters.set(id, { res: resolve, t });
                  });
                }
                function ackVerdict(ack) { // #018-W1b 三态：ok===true 才算送达
                  if (ack == null) return { ok: false, error: "命令未确认（超时或源未连接），可重试" };
                  if (ack.ok === true) return { ok: true, error: "" };
                  return { ok: false, error: (typeof ack.error === "string" && ack.error) || "命令被拒绝" };
                }

                function handleFrame(m, evSource) {
                  if (!m || !m.type) return;
                  if (m.type === "COMMAND_ACK") { onAck(m.payload || m); return; }
                  if (m.type === "ARTIFACT_CHUNK") { onArtifactChunk(m.payload || {}); return; }
                  const sid = m.session_id || "";
                  switch (m.type) {
                    // W-WINPAIR-R2：聚合视角 SNAPSHOT merge——S.sessions 保留另一源会话（不清场）；
                    // W-WINPAIR-R4：projects 同 id 并集（项目列表聚合两源）
                    case "SNAPSHOT": {
                      const agg = (window.__ccDeck005SourceView && window.__ccDeck005SourceView()) === "aggregate" && evSource;
                      const keep = agg ? new Map(S.sessions) : null;
                      const keepProjects = agg ? (Array.isArray(S.projects) ? S.projects.slice() : []) : null;
                      onSnapshot(m.payload);
                      // t25fix #5：聚合视角下给本源会话打 per-session 源标（relay 不发 relay_source，
                      // 此前全部回退 S.relayName → srcSet 恒 1 → 源标签恒隐藏=用户实测「聚合模式
                      // 源标签缺失」根因）。keep 合回的另一源对象带旧标，两源齐后 srcSet>1 自动显形；
                      // 编制 session_id 的 running/PM 归属判定同链受益（#11/#12 的跨源失配面收敛）
                      // W-SRC2（#110 复发 1016 实锤）：打标与聚合视角解耦——快照到达时 sourceView
                      // 可能仍是 local（启动序：SNAPSHOT 先于视角恢复/先单源接入后加源），agg 门
                      // 挡住打标=本源存量卡永不带标（切聚合后 srcSet 缺角→源标签缺失/部分缺）。
                      // 恒打无副作用：单源视角下多打无害（srcSet=1 仍隐藏），对象随快照替换走
                      {
                        // W-SRCLABEL #134：通道兜底修活——evSource 是帧总线源标（"lan"/"cloud"
                        // 字符串），旧兜底 evSource.relayName 属性访问恒 undefined=死路 → relay 侧
                        // 无名（relay-name 文件未设/旧 bundle）时两源全不打标 → srcSet 塌 1 →
                        // CSS 门控隐藏全部源标签（1022 用户截图根因之二）。relay_name 在场优先
                        // 真名（relay 缺省名根修配套），缺席按通道显「本机/云桥」——聚合两源恒
                        // 得两个可辨源名；单源视角 srcSet=1 仍隐藏，观感不变
                        const srcName = String((m.payload && m.payload.relay_name)
                          || (evSource === "cloud" ? "云桥" : "本机"));
                        if (srcName) for (const x of (Array.isArray(m.payload && m.payload.sessions) ? m.payload.sessions : [])) {
                          if (!x || typeof x.session_id !== "string") continue;
                          const s = S.sessions.get(x.session_id);
                          if (s && !s.relay_source) s.relay_source = srcName;
                        }
                      }
                      if (keep) for (const [id, v] of keep) if (!S.sessions.has(id)) S.sessions.set(id, v);
                      if (keepProjects) {
                        const seen = new Set(S.projects.map((g) => g && g.id));
                        for (const g of keepProjects) if (g && g.id !== undefined && !seen.has(g.id)) S.projects.push(g);
                      }
                      // #241 A:聚合下合回后复验 selected+重渲列表——此前 renderMyList 跑在
                      // onSnapshot 内(本源集合上),keep 合回不重渲=列表恒缺后到帧的源(用户
                      // 实锤「他源运行中会话卡消失」根因)
                      if (agg) {
                        if (!S.sessions.has(S.selected)) S.selected = "";
                        renderMyList();
                      }
                      break;
                    }
                    case "PROJECTS_UPDATED": onProjectsUpdated(m.payload); break; // UIPOLISH3 件二：分组数据面与团队域同新鲜度
                    case "SESSION_CREATED": onSessionCreated(sid, m.payload, evSource); break; // #110：帧通道随行（建卡打源标的锚）
                    case "SESSION_UPDATED": onSessionUpdated(sid, m.payload); break;
                    case "SESSION_HEARTBEAT": onHeartbeat(sid, m.payload); break;
                    case "SESSION_WAITING": onWaiting(sid, m.payload); break;
                    case "SESSION_WAITING_RESOLVED": onWaitingResolved(sid); break;
                    case "SESSION_ERROR": onErrorEvt(sid, m.payload); break;
                    case "SESSION_DONE": onDoneEvt(sid, m.payload); break;
                    case "SESSION_DELETED": onDeleted(sid); break;
                    case "SESSION_LOG": onLog(sid, m.payload); break;
                    case "SESSION_LOG_PATCH": onLogRemove(sid, m.payload); break; // W-STREAMDELTA：终态撤流块
                    case "COLLAB_MODE_UPDATED": onCollabMode(m.payload); break; // W-MODE：协作模式切换（锚卡即时增删）
                    case "PROJECTS_UPDATED": onProjectsUpdated(m.payload || {}); break; // [t-7e0c6189] 编制增量（S.projects 原只吃 SNAPSHOT 全量，编制一变列表过滤就陈旧）
                    case "BOARD_UPDATED": { // W-TEAMSNC ④：板帧跟随（第四列抽屉在办概览 ≤1s 新鲜度）——会话域唯一新增消费点；守门三连（B 稿 R1）：gid 有效 + 抽屉开且同 gid 才重渲，稳态早退在 renderSlimDrawer
                      const bgid = m.payload && typeof m.payload.gid === "string" ? m.payload.gid : "";
                      const bents = m.payload && m.payload.board && Array.isArray(m.payload.board.entries) ? m.payload.board.entries : null;
                      if (bgid && bents) { if (!S.boards) S.boards = new Map(); S.boards.set(bgid, bents); if (S.drawerGid === bgid) renderSlimDrawer(); }
                      break;
                    }
                  }
                }
                function onProjectsUpdated(p) {
                  if (!S.hasSnapshot) return; // 锚定纪律同地基 Team 桥：未 SNAPSHOT 锚定前丢弃 delta，防空基线起底 merge（#143 盲评C-3 同源风险）
                  if (Array.isArray(p.groups)) { S.projects = p.groups.filter((g) => g && typeof g.id === "string"); }
                  else if (p && p.delta !== undefined) {
                    const byId = new Map(S.projects.map((g) => [g.id, g]));
                    for (const g of (Array.isArray(p.delta.upserts) ? p.delta.upserts : [])) if (g && typeof g.id === "string") byId.set(g.id, g);
                    for (const id of (Array.isArray(p.delta.removes) ? p.delta.removes : [])) byId.delete(String(id));
                    S.projects = [...byId.values()];
                  } else return;
                  renderMyList();
                  renderSlimDrawer();
                  if (UI && curSession()) renderInspector();
                }

                // #150 R2 并轨：B2 退役自持 ws，订阅地基帧总线（帧语义原样；断线 fail-fast 保持）。
                // 本 IIFE 早于桥（#d-project）解析——总线判空幂等创建，桥侧复用同一实例。
                if (!window.__ccDeck005Frames) {
                  window.__ccDeck005Frames = (() => {
                    const subs = new Set();
                    return {
                      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
                      emit(ev) { for (const fn of subs) { try { fn(ev); } catch (_) {} } }, // ev = {kind:"frame",frame} | {kind:"ws",state:"connecting"|"open"|"close"}
                    };
                  })();
                }
                window.__ccDeck005Frames.subscribe((ev) => {
                  if (ev.kind === "ws") {
                    S.status = ev.state === "open" ? "online" : "offline"; // 原 onopen/onclose 同款映射（列表 data-connection 语义不变；connecting 归 offline 同旧握手期）
                    if (ev.state === "close") failB2Flights();
                    return;
                  }
                  if (ev.kind === "frame" && window.__ccDeck005FrameAllowed(ev)) handleFrame(ev.frame, ev.source); // W-WINPAIR-R2：按视角门控（aggregate 放行全部+merge）
                });

                // ---------- 事件处理（v1 onEvent 的 B2 子集） ----------
                function onSnapshot(p) {
                  if (!p || !Array.isArray(p.sessions)) return;
                  S.sessions = new Map(p.sessions.filter((x) => x && typeof x.session_id === "string").map((x) => [x.session_id, x]));
                  S.snapshotAt = Date.now(); // t25fix #4：快照到达时戳（团队 dock 出卡时序门槛用——快照刚到时编制/会话未到齐，0 同步团队卡先不出防闪现残卡）
                  S.timelines = new Map(Object.entries(p.logs || {}).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : []]));
                  S.logsTruncated = new Map(Object.entries(p.logs_truncated || {}));
                  S.hasSnapshot = true;
                  S.relayName = p.relay_name || location.host;
                  S.collabMode = p.collab_mode === "no-leader" ? "no-leader" : p.collab_mode === "leader" ? "leader" : undefined; // W-MODE：能力位（undefined=旧 relay）
                  S.leaderSessionId = typeof p.leader_session_id === "string" ? p.leader_session_id : ""; // #240：锚 id（缺席重置空串——旧 relay/换源不残留陈旧锚 id 误滤）
                  S.homedir = p.homedir || ""; S.platform = p.platform || "";
                  S.models = Array.isArray(p.models) ? p.models : [];
                  S.projects = Array.isArray(p.projects) ? p.projects : []; // 项目组索引：会话列表「其他会话」按项目子分组（⑥a-2）
                  S.boards = new Map((Array.isArray(p.boards) ? p.boards : []).filter((b) => b && typeof b.gid === "string" && Array.isArray(b.entries)).map((b) => [b.gid, b.entries])); // W-TEAMSNC ④：板随快照（缺席=空 Map → 抽屉概览走降级文案，不伪造空板）
                  S.experiences = Array.isArray(p.experience) ? p.experience.filter((e) => e && typeof e.id === "string" && typeof e.text === "string") : null; // W-EXPP2
                  const caps = p.source_capabilities;
                  S.engineCatalog = caps && Array.isArray(caps.engine_catalog) ? caps.engine_catalog : null;
                  // #236 A（切源零副作用·P0）：快照替换会把异源已选会话挤掉（下方清 selected）——
                  // 清空前先把当前输入框活文本落草稿桶。此前切源路径无 inputDrafts.set，活文本
                  // 不落桶，回点会话时 selectSession 的桶恢复（:1107/:3592 `?? ""`）把半截输入
                  // 覆写成空=用户实测「切源丢半截消息」；落桶后切回同会话原样恢复。顺手覆盖
                  // 断线重连快照的同类清选。输入框物理值不清（纯显示切换，口径①）
                  if (S.selected && !S.sessions.has(S.selected) && UI && UI.input && UI.input.value) {
                    inputDrafts.set(S.selected, UI.input.value);
                  }
                  // #241 A:聚合视角下不在此清 selected——本源快照替换≠最终集合(外层
                  // SNAPSHOT case 会把上一轮并集合回,异源已选会话合回后仍在);清早了会把
                  // 用户正看着的会话丢选中(实锤「会话消失」的选中态面)。单源视角照旧清理
                  if (!(window.__ccDeck005SourceView && window.__ccDeck005SourceView() === "aggregate") && !S.sessions.has(S.selected)) S.selected = "";
                  S.slimUnread = new Map(); // [t-7e0c6189] 换源/重连全量回放：未读随增量重建（快照历史 log 不回灌未读）
                  try { S.drawerGid = localStorage.getItem("cc-deck-005-slim-drawer") || ""; } catch (_) {} // [t-7e0c6189] 第四列展开态记忆（gid 已不存在时 renderSlimDrawer 自动收起）
                  renderMyList();
                  renderAll();
                  renderSlimDrawer();
                }
                // UIPOLISH3 件二：项目组增量并入 S.projects（列表分组数据面与团队域同新鲜度）。
                // v2 投影 delta 形态（upserts/removes）与 legacy 全量 groups 双兼容，与地基
                // bridge PROJECTS_UPDATED 分支（:9362 同款判定）同口径
                function onProjectsUpdated(p) {
                  if (!p || typeof p !== "object") return;
                  const byId = new Map((Array.isArray(S.projects) ? S.projects : []).map((g) => [g && g.id, g]));
                  if (p.delta !== undefined) {
                    for (const g of (Array.isArray(p.delta && p.delta.upserts) ? p.delta.upserts : [])) if (g && typeof g.id === "string") byId.set(g.id, g);
                    for (const id of (Array.isArray(p.delta && p.delta.removes) ? p.delta.removes : [])) byId.delete(String(id));
                  } else if (Array.isArray(p.groups)) {
                    byId.clear();
                    for (const g of p.groups) if (g && typeof g.id === "string") byId.set(g.id, g);
                  } else return;
                  S.projects = [...byId.values()];
                  renderMyList();
                }
                function onSessionCreated(sid, p, evSource) {
                  if (!sid || S.sessions.has(sid)) return;
                  // #110 实时建卡打源标：SNAPSHOT merge（t25fix #5）与 B4 桥（T10 relay_channel）
                  // 都打标，唯 B2 实时 SESSION_CREATED 漏打——聚合视角下选「远程」创建的会话卡
                  // 回落显示名（会被后到的云快照覆写成云名）→「创建到选了远程/本机、卡/详情却挂
                  // 另一源」=用户实锤的选源不生效目视假象（会话实际落点正确，是标签说谎）。
                  // 源名一律走 __ccDeck005SourceState 走查钩子取链上真值（本 IIFE 跨 script 块
                  // 不可直引 ctx/cloudCtx——直引即 ReferenceError 且被总线 try/catch 静默吞），
                  // 与 SNAPSHOT merge 同锚 relay_name；p 将来若携带 relay_source 以 p 为准。
                  const srcState = (window.__ccDeck005SourceState && window.__ccDeck005SourceState()) || null;
                  const srcName = evSource === "cloud" ? String((srcState && srcState.cloudRelayName) || "") : String((srcState && srcState.lanRelayName) || S.relayName || "");
                  // W-P2FIX P2-2：帧通道（evSource）是内核级权威事实，同落 relay_channel（与 B4 桥
                  // T10 同锚同式）——聚合两源同名时 RouteWs 的名字比对兜底会被同名劫持（LAN 名=
                  // 云名 → bsCloud 误 true → LAN 新卡误投云 shim 报「会话不存在」，#110 镜像形态），
                  // 通道字段在场即以其为准（11985 消费端已改通道优先，名字比对降级为无字段兜底）。
                  const chanTag = { relay_channel: evSource === "cloud" ? "cloud" : "lan" };
                  S.sessions.set(sid, Object.assign({ session_id: sid, status: "WORKING", started_at: Date.now(), updated_at: Date.now(), todos: [], artifacts: [] }, srcName ? { relay_source: srcName } : {}, chanTag, p || {}));
                  renderMyList();
                  const card = UI && UI.sessionList.querySelector('[data-session-card="' + cssEsc(sid) + '"]');
                  if (card) { card.classList.add("enter"); S.forceScroll = true; card.click(); } // 复用地基选中链（选中态 + observer 同步）；#B3-17 新卡入场
                }
                const MERGE_KEYS = ["status", "action_summary", "cwd", "title", "title_locked", "model", "turn_started_at", "usage", "context_usage", "context_limit", "todos", "subagents", "permission_mode", "pending_inputs", "relay_session_id", "pinned", "saved", "historical", "external", "remote_mode", "artifacts", "artifacts_truncated", "engine", "updated_at", "started_at", "duration_ms", "waiting_started_at", "last_error", "pre_compact_summary", "auth_hint"];
                function onSessionUpdated(sid, p) {
                  const s = S.sessions.get(sid);
                  if (!s || !p || typeof p !== "object") return;
                  for (const k of MERGE_KEYS) if (p[k] !== undefined) s[k] = p[k];
                  if (Object.prototype.hasOwnProperty.call(p, "waiting_request")) s.waiting_request = p.waiting_request ?? null; // 权威自愈：null 即清
                  s.updated_at = p.updated_at || Date.now();
                  renderMyList();
                  renderSlimDrawer(); // [t-7e0c6189] 第四列成员卡状态/摘要随更新刷新（隐藏态零开销早退）
                  if (sid === S.selected) renderAll();
                }
                function onHeartbeat(sid, p) {
                  const s = S.sessions.get(sid);
                  if (!s) return;
                  s.updated_at = Date.now();
                  if (p && typeof p.action_summary === "string" && p.action_summary) s.action_summary = p.action_summary;
                  if (sid === S.selected) { renderDock(); renderHeader(); }
                }
                function onWaiting(sid, p) {
                  const s = S.sessions.get(sid);
                  if (!s || !p) return;
                  s.status = "WAITING"; s.waiting_request = p; s.waiting_started_at = Date.now(); s.updated_at = Date.now();
                  renderMyList();
                  if (sid === S.selected) renderAll();
                  if (sid !== S.selected) b2Toast("「" + shortTitle(s) + "」等待你的确认");
                }
                function onWaitingResolved(sid) {
                  const s = S.sessions.get(sid);
                  if (!s) return;
                  s.waiting_request = null;
                  if (s.status === "WAITING") s.status = "WORKING";
                  s.updated_at = Date.now();
                  renderMyList();
                  if (sid === S.selected) renderAll();
                }
                function onErrorEvt(sid, p) { const s = S.sessions.get(sid); if (!s) return; s.status = "ERROR"; s.waiting_request = null; s.last_error = (p && p.message) || ""; s.auth_hint = (p && p.auth_hint) || null; /* #102 批 A：登录态中途失效指引（非登录态故障为 null 清） */ s.updated_at = Date.now(); renderMyList(); if (sid === S.selected) renderAll(); }
                function onDoneEvt(sid, p) { const s = S.sessions.get(sid); if (!s) return; s.status = "DONE"; s.waiting_request = null; if (p) { if (typeof p.duration_ms === "number") s.duration_ms = p.duration_ms; s._terminal = p.terminal_reason || ""; } s.updated_at = Date.now(); renderMyList(); if (sid === S.selected) renderAll(); }
                // #B3-3 删会话连带清理输入历史桶（旧壳 #95 同口径）与草稿，防 localStorage 悬留
                // W-MODE 协作模式切换帧（relay orgAction collab-mode set 成功边广播）：
                // no-leader → 锚卡本地全套回收（复用 onDeleted：列表/转录/附图/草稿/选中态）。
                // #240 W-LEADERHIDE：leader 分支的锚卡 upsert 回列表退役——用户口径「会话列表
                // 不放 Leader 卡」（切回 leader 时锚卡仍随 SNAPSHOT 进 S.sessions，列表渲染集
                // 由 isLeaderSession 过滤；团队域/组织视图语义不受影响）
                function onCollabMode(p) {
                  if (!p || (p.mode !== "leader" && p.mode !== "no-leader")) return;
                  S.collabMode = p.mode;
                  if (p.mode === "no-leader") {
                    const lid = typeof p.leader_session_id === "string" ? p.leader_session_id : "";
                    if (lid && S.sessions.has(lid)) onDeleted(lid);
                  }
                }
                function onDeleted(sid) {
                  S.sessions.delete(sid); S.timelines.delete(sid);
                  for (const [key, c] of S.imgUrls) if (key.startsWith(sid + "/")) { if (c && c.url) { try { URL.revokeObjectURL(c.url); } catch (_) {} } S.imgUrls.delete(key); } // FB14 附图缓存随会话回收
                  try { localStorage.removeItem(HIST_PREFIX + sid); } catch (_) {} inputDrafts.delete(sid); if (S.selected === sid) S.selected = ""; renderMyList(); renderAll();
                }

                // 同 id 流式块原地替换（v1 pushLog/streamMergeDecide 口径）
                function streamMergeDecide(prev, next) {
                  if (next.streaming && !next.full && !prev.streaming && (prev.full || prev.text)) return "skip"; // 迟到残帧不回退
                  return "replace";
                }
                function pushLog(sid, entry) {
                  if (!S.timelines.has(sid)) S.timelines.set(sid, []);
                  const list = S.timelines.get(sid);
                  const e = { ts: entry.ts || Date.now(), kind: entry.kind || "system", text: entry.text || "", tool: entry.tool, id: entry.id, full: entry.full, streaming: entry.streaming, detail: entry.detail, diff: entry.diff, images: Array.isArray(entry.images) ? entry.images : undefined }; // FB14：随消息图片随行
                  if (e.id) {
                    const i = list.findIndex((x) => x.id === e.id);
                    if (i >= 0) { if (streamMergeDecide(list[i], e) === "skip") return "skip"; list[i] = e; return "replace"; }
                  }
                  list.push(e);
                  if (list.length > 400) list.splice(0, list.length - 400);
                  return "append";
                }
                // W-STREAMDELTA：流块撤除（relay removeExternalLog 的 PATCH）——timelines 删条+DOM 原位移除（终态正文以转录终条为准，防双条）
                function onLogRemove(sid, payload) {
                  const rid = payload && payload.remove_id;
                  if (typeof rid !== "string" || !rid) return;
                  const list = S.timelines.get(sid);
                  if (Array.isArray(list)) {
                    const i = list.findIndex((e) => e && e.id === rid);
                    if (i >= 0) list.splice(i, 1);
                  }
                  if (UI && sid === S.selected) {
                    const node = UI.convPane && UI.convPane.querySelector('[data-x="' + cssEsc(rid) + '"]');
                    if (node) node.remove();
                  }
                }
                function onLog(sid, entry) {
                  if (!sid || !entry || typeof entry !== "object") return;
                  const s = S.sessions.get(sid);
                  if (s) s.updated_at = entry.ts || Date.now();
                  // #221 同族①（W-INJECT3 扩展）：回显对账双兜底——原唯一路径「精确文本匹配」
                  // 对回显形态差异（空白规整/短回显变体）失配=「发送中…」气泡永挂（用户实锤：
                  // CLI 已回复后续内容气泡仍滞留）。a) 匹配放宽（trim+多空白折叠）b) 回合推进
                  // 兜底：assistant 帧到达=CLI 已消费更早消息在干活 → 撤所有早于该帧的 sending
                  // echo（秒级收敛，不待 30s 惰性窗/全量渲染）
                  const dropEchoKeys = (keys) => {
                    if (!keys.length) return;
                    const eq = S.echo.get(sid);
                    if (!eq) return;
                    const keep = eq.filter((x) => !keys.includes(x.key));
                    if (keep.length === eq.length) return;
                    if (keep.length) S.echo.set(sid, keep); else S.echo.delete(sid);
                    // 选中会话同步移除 DOM 行（增量日志路径不触发全量 render，气泡行须直删）
                    if (UI && sid === S.selected) document.querySelectorAll('.msg-echo[data-echo-key]').forEach((el) => { if (keys.includes(el.dataset.echoKey)) el.remove(); });
                  };
                  if (msgRoleOf(entry.kind) === "user") {
                    const eq = S.echo.get(sid);
                    if (eq && eq.length) {
                      const normTxt = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
                      const txt = normTxt(entry.full ?? entry.text ?? "");
                      const hit = eq.filter((x) => x.state === "sending" && (normTxt(x.text) === txt || txt.startsWith(normTxt(x.text)) || normTxt(x.text).startsWith(txt)));
                      dropEchoKeys(hit.map((x) => x.key));
                      if (UI && sid === S.selected && hit.length) renderConversation();
                    }
                  } else if (entry.kind === "assistant_text" || entry.kind === "thinking") {
                    // 回合推进兜底：模型已在输出=更早的 sending 消息必已被消费（CLI 不会
                    // 带着未消费输入开工）——早于此帧的 sending echo 全撤（fail 态保留展示窗）
                    const eq = S.echo.get(sid);
                    if (eq && eq.length) {
                      const frameTs = Number(entry.ts) || Date.now();
                      dropEchoKeys(eq.filter((x) => x.state === "sending" && x.ts <= frameTs + 500).map((x) => x.key));
                    }
                  }
                  const out = pushLog(sid, entry);
                  if (UI && sid === S.selected && out !== "skip") applyDomLog(sid, out, entry.id);
                  // [t-7e0c6189] 未读聚合：编制内 worker/QA 有新输出且未在看 → 记 gid/sid 并亮团队入口徽标
                  //（每 sid 只触发一次重渲；进团队域/展第四列/直开即清——slimMarkSeen）
                  if (S.hasSnapshot && UI && sid !== S.selected) {
                    const m = slimRosterOf(S.projects).bySid.get(sid);
                    if (m && !SLIM_KEEP_ROLE.test(m.role)) {
                      let set = S.slimUnread.get(m.gid);
                      if (!set) { set = new Set(); S.slimUnread.set(m.gid, set); }
                      if (!set.has(sid)) { set.add(sid); renderMyList(); if (curSession()) renderInspector(); }
                    }
                  }
                }

                // ---------- COMMAND_ACK / ARTIFACT_CHUNK ----------
                function onAck(ack) {
                  if (!ack || typeof ack.command_id !== "string") return;
                  const w = S.ackWaiters.get(ack.command_id);
                  if (w) { S.ackWaiters.delete(ack.command_id); clearTimeout(w.t); w.res(ack); return; }
                  const af = S.artFetches.get(ack.command_id);
                  if (af) {
                    if (ack.ok === false) { failArt(ack.command_id, new Error(ack.error || "拉取失败")); return; }
                    if (ack.artifact) { af.mime = ack.artifact.mime || af.mime; af.size = ack.artifact.size ?? af.size; }
                    af.ackSeen = true; maybeSettleArt(ack.command_id);
                    return;
                  }
                  // #150 R2 并轨：总线让 B2 看到全部 ACK（team-*/桥 uuid 等外来回执）——无主直接
                  // 静默（与地基 Team.onAck 同口径），不再 toast「命令失败」误报；有主结算见上两分支。
                }
                function onArtifactChunk(p) {
                  const st = S.artFetches.get(p.ref);
                  if (!st) return;
                  if (p.error) { failArt(p.ref, new Error(p.error)); return; }
                  if (typeof p.seq === "number" && typeof p.b64 === "string") st.parts[p.seq] = p.b64;
                  if (p.total) st.total = p.total;
                  if (p.done) { st.doneSeen = true; maybeSettleArt(p.ref); }
                }
                // #79 输出物拉取：ACK(ackSeen)+尾帧(doneSeen) 双条件收口，90s 兜底
                function fetchArtifact(sid, path) {
                  return new Promise((resolve, reject) => {
                    const id = sendCmd("COMMAND_ARTIFACT_FETCH", { session_id: sid, path });
                    if (!id) { reject(new Error("relay 未连接")); return; }
                    const st = { parts: [], total: 0, mime: "application/octet-stream", size: 0, ackSeen: false, doneSeen: false, resolve, reject, timer: 0 };
                    st.timer = setTimeout(() => { S.artFetches.delete(id); reject(new Error("拉取超时（连接可能中断），请重试")); }, 90000);
                    S.artFetches.set(id, st);
                  });
                }
                function maybeSettleArt(id) {
                  const st = S.artFetches.get(id);
                  if (!st || !st.ackSeen || !st.doneSeen) return;
                  clearTimeout(st.timer); S.artFetches.delete(id);
                  for (let i = 0; i < st.total; i++) if (st.parts[i] === undefined) { st.reject(new Error("传输不完整（缺块），请重试")); return; }
                  st.resolve({ parts: st.parts, mime: st.mime, size: st.size });
                }
                function failArt(id, err) { const st = S.artFetches.get(id); if (!st) return; clearTimeout(st.timer); S.artFetches.delete(id); st.reject(err); }
                function artifactBytes(res) { // res.parts b64 分块 → 单 Uint8Array（Blob 链与壳落盘链共用）
                  const chunks = res.parts.map((b) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; });
                  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
                  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
                  return out;
                }
                function downloadArtifact(path, res) { // 浏览器形态：Blob + a.download 原链（保留）
                  const url = URL.createObjectURL(new Blob([artifactBytes(res)], { type: res.mime }));
                  const a = document.createElement("a");
                  a.href = url; a.download = String(path).split(/[\\/]/).pop() || "artifact";
                  document.body.appendChild(a); a.click(); a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 4000);
                }
                // #158-批3 产物下载桌面链（旧壳 downloadAndOpenArtifact 10434-10470 范式）：mac 桌面
                // 点下载无反应的根因——WKWebView 对 Blob+a.download 支持不稳。桌面壳改 ccDeck.
                // saveArtifact 落系统「下载」目录（重名自增）→ ccDeck.openPath 系统默认应用打开；
                // 打开失败不算下载失败（路径已 toast，用户可自取）。busy 锁防 20MB 级拉取在途时
                // 连点并发第二份。分片 btoa 防 apply 栈溢出（旧壳 bytesToB64 同款）
                let shellArtBusy = false;
                function bytesToB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
                function saveArtifactViaShell(path, res) {
                  const name = String(path).split(/[\\/]/).pop() || "输出物";
                  return window.ccDeck.saveArtifact(name, bytesToB64(artifactBytes(res)));
                }
                // #106 先探后开范式（旧壳 shellHasLocal 10452）：probePath 微秒级 stat 判路径在不在
                // 本机；旧壳无 probePath（升级窗口期）按「在」处理回落 openPath→catch 链
                function shellHasLocal(p) {
                  if (window.ccDeck && typeof window.ccDeck.probePath === "function") return window.ccDeck.probePath(p).catch(() => true);
                  return Promise.resolve(true);
                }

                // ---------- 左列会话列表（地基 renderSessionList 同构；增量会话由本端补齐） ----------
                // #160 空闲置灰（旧壳 #96/#121 同口径移植）：DONE/ERROR 且静默超阈值分钟降透明度
                // 退后（CSS .queue-card.idle），刚完成的保持鲜亮；后台子 Agent 在跑豁免（旧 #100：
                // 等孩子 ≠ 死会话）。时长存 localStorage(ccd_idle_dim_min)——沿用旧壳键，跨壳迁移
                // 用户设置不丢；默认 30，负数 = 永不（Infinity 让 > 比较恒 false，判定零分支）。
                // 设置面板（地基段）改值走 __ccDeck005IdleDim 钩子回写本闭包并立即重渲。
                let idleDimMin = 30;
                // 缺失/空串回落默认 30（Number(null)=0 会把缺省吃成 0——立即置灰，与「默认
                // 30 分钟」意图相悖；旧壳 #121 直拷 Number(lsGet) 存在此暗坑，这里按文案口径修正）
                { let raw = null; try { raw = localStorage.getItem("ccd_idle_dim_min"); } catch (_) {} const v = raw === null || raw === "" ? NaN : Number(raw); if (Number.isFinite(v)) idleDimMin = v; }
                const idleDimMs = () => (idleDimMin < 0 ? Infinity : idleDimMin * 60000);
                const bgRunning = (s) => (s.subagents ?? []).some((a) => !a.ended_at);
                const bgCount = (s) => (s.subagents ?? []).filter((a) => !a.ended_at).length; // #164 ⑂N 徽标数据
                function idleDimmed(s) {
                  return (s.status === "DONE" || s.status === "ERROR") && !bgRunning(s)
                    && Date.now() - (s.updated_at ?? s.started_at) > idleDimMs();
                }
                window.__ccDeck005IdleDim = {
                  get: () => idleDimMin,
                  set: (v) => { idleDimMin = v; renderMyList(); },
                };
                // B11 分组折叠机制（collapsedGroups/toggleGroupCollapse）随 W-TEAMCHIP2 ②
                // teams-dock 退役整链删除——历史沿革：项目组（W-NOVAUI ⑤）→team:* 组
                //（UIPOLISH3 件二）→#103 两段式收口 slim-teams dock 唯一折叠面→dock 退役后
                // data-group-toggle 零生产者。旧 localStorage 键 cc-deck-005-grp-collapsed
                // 留存无害（不再读取）。
                const GRP_ACCENTS = ["var(--brand)", "var(--info)", "var(--done)", "var(--working)"]; // 件C③：团队色轮（组序注入，>4 组循环）；V8R+ 提升共享——PM 归属 chip 同轮取色
                // V8R+（Leader 1014 追加）：PM/Leader 直列卡的「所属团队」归属 chip 数据。
                // W-TEAMSNC ②⑤（2026-10-24）：单口升级——返回**团队数组** [{gid, name, accent, idle}]
                //（多团队归属=多枚 chip 平铺，C 稿 E1 口径；首枚=编制序首团）；边界态按 C 稿表：
                // archived 团队 chip 退役（E4：删除/归档，对齐手机端 active 过滤精神）；零成员团队
                // 天然无 sid 命中不出 chip（E2）；全闲团队 chip 置灰 idle（E5，title 补「团队空闲」）。
                // 词表不变（SLIM_KEEP_ROLE 同源）。调用方：卡 myCardItem / 详情 head renderHeader。
                function pmTeamChipOf(sid) {
                  if (!Array.isArray(S.projects)) return [];
                  const out = [];
                  for (let pi = 0; pi < S.projects.length; pi++) {
                    const p = S.projects[pi];
                    if (!p || typeof p.id !== "string") continue;
                    if (String(p.status || "") === "archived") continue; // E4：归档/结项团队 chip 不渲染
                    const hc = Array.isArray(p.headcount) ? p.headcount : [];
                    let hitRole = "";
                    for (const m of hc) {
                      const mr = String((m && m.role) || "");
                      if (m && m.session_id === sid && SLIM_KEEP_ROLE.test(mr)) { hitRole = /^(leader|领队)$/i.test(mr) ? "leader" : "pm"; break; }
                    }
                    if (!hitRole) continue;
                    // E5 离线判定：编制内已同步且 WORKING 计数=0 → idle 置灰（与 dock 整队健康灯同判）
                    const running = hc.reduce((n, m) => { const x = m && S.sessions.get(m.session_id); return n + (x && x.status === "WORKING" ? 1 : 0); }, 0);
                    out.push({ gid: p.id, name: String(p.name || p.id), accent: GRP_ACCENTS[pi % GRP_ACCENTS.length], idle: running === 0, running, kind: hitRole }); // W-CRABINTEGRATE：kind=pm|leader（头像变体判定源）；W-ENGLM2 F：running 随行下发（chip 数字位=活跃数）
                  }
                  return out;
                }
                function myCardItem(session) {
                  const status = ({ WORKING: "working", WAITING: "waiting", ERROR: "error", DONE: "done" })[session.status] || "done";
                  const engineKey = inferEngineOf(session) || "claude"; // W-ENGLM D：与 head 同链推断（engine 空按 model 子串）
                  const engine = ENGINES[engineKey] || [engineKey, ""];
                  const activityTime = Number(session.updated_at || session.started_at || 0);
                  const turnStart = Number(session.turn_started_at || session.started_at || Date.now());
                  const teamsOf = pmTeamChipOf(session.session_id);
                  const teamRole = teamsOf.some((t) => t.kind === "leader") ? "leader" : teamsOf.length ? "pm" : null; // W-CRABINTEGRATE：leader 优先（皇冠压举旗）
                  return {
                    id: esc(session.session_id),
                    title: esc(session.title || session.initial_prompt || session.session_id),
                    summary: esc(session.action_summary || session.last_error || displayPath(session.cwd) || "暂无活动摘要"),
                    status,
                    // #164 状态文字标签退役（头像角标状态点已表达状态）；tagClass 仅供 CTA 判定保留
                    // W-V8 批2a 状态语义对调：working 绿（v8 进行中=绿系；CTA 判定只认 action/danger 不受影响）
                    tagClass: ({ working: "done", waiting: "action", error: "danger", done: "done" })[status],
                    bg: bgCount(session), // #164 后台子 Agent 在跑数（⑂N 徽标）
                    // W-DISPVIS C2：已派单·等待处理角标数据——本会话所属组的排队单数
                    // （dispatchQueues 是 detail() 存的 gid→排队单表；组归属走
                    // getSessionProject 现成链。DONE 态+队列非空=「派了没人吃」可视）
                    queuedDispatch: (() => {
                      const proj = getSessionProject(session);
                      const gid = proj && proj.id;
                      const q = gid && window.__ccDeck005DispatchQueues ? window.__ccDeck005DispatchQueues.get(gid) : null;
                      return Array.isArray(q) ? q.length : 0;
                    })(),
                    teams: teamsOf, // W-TEAMSNC ②⑤：PM/Leader 所属团队数组（[]=无归属不显；多团队=多枚 chip）
                    teamRole, // W-CRABINTEGRATE：头像角色蟹判定（leader 压 pm）
                    cwdTail: session.cwd ? (() => { const n = String(session.cwd).replace(/[\\/]/g, "/").replace(/\/+$/, ""); return n.slice(n.lastIndexOf("/") + 1) || n; })() : "", // W-FB66ALL ⑧：尾段目录名（📁 chip 用；PM/Leader 卡不显）
                    engine: esc(engine[0]), engineClass: engine[1],
                    source: esc(window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(session.relay_source || S.relayName) : (session.relay_source || S.relayName)), // 件十三 + W-WINPAIR-R6：per-session 源标识优先（聚合两源各显其名）
                    time: activityTime ? fmtListTime(activityTime) : "",
                    selected: session.session_id === S.selected,
                    pinned: session.pinned === true,
                    workSecs: Math.max(0, Math.floor((Date.now() - turnStart) / 1000)),
                    idle: idleDimmed(session), // #160 置灰标志（markup 拼 class；判定见上）
                  };
                }
                // 与地基 renderSessionCard(desktop) 逐字节同构（含引擎小图标/来源配色/条件 r3），
                // 保证地基重渲与本端补渲的 DOM 一致，observer 完整性检查不误判。
                const b2EngineIconFor = (engineClass) => engineClass === "claude" ? "chat" : engineClass === "codex" ? "code" : engineClass === "trae" ? "sliders" : "server";
                // #231 纠错（W-CARDTAGS2）：用户点选图标源（#228 图集拍板，字节权威=expo
                // assets/engines/ 七资产本批直引生成）——前版手绘螃蟹/终端符/SI Trae/
                // SI Codebuddy 均为非点选素材，随本修退役；未知引擎回落 PH 字母占位
                const ENGINE_BRAND_SVG = {
                  "claude": "<img src=\"data:image/png;base64,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\" width=\"12\" height=\"12\" alt=\"\" style=\"border-radius:2px;display:block\">",
                  "codebuddy": "<svg width=\"40\" height=\"40\" viewBox=\"0 0 40 40\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<g clip-path=\"url(#clip0_5110_14771)\">\n<rect width=\"40\" height=\"40\" rx=\"20\" fill=\"url(#paint0_linear_5110_14771)\"/>\n<g filter=\"url(#filter0_f_5110_14771)\">\n<circle cx=\"12.6071\" cy=\"34.9794\" r=\"14.081\" fill=\"#32E6B9\" fill-opacity=\"0.4\"/>\n</g>\n<g filter=\"url(#filter1_f_5110_14771)\">\n<circle cx=\"33.3404\" cy=\"43.6185\" r=\"12.8704\" fill=\"#32E6B9\"/>\n</g>\n<path d=\"M27.6897 3.3426C28.057 3.01322 28.0795 2.99983 28.3485 2.98366C28.7851 2.95177 29.1858 3.16107 29.8664 3.78072C31.4566 5.22574 33.6703 8.19724 35.047 10.7343L35.5796 11.7191L36.3309 12.0927C37.0562 12.4593 38.2459 13.2111 38.7428 13.614C38.9673 13.7997 38.9992 13.8032 39.2326 13.7124C40.2872 13.3017 41.7982 13.846 43.1307 15.1244C44.3302 16.274 45.479 18.2384 45.9191 19.8778C45.9833 20.1417 46.0683 20.709 46.0994 21.1314C46.1997 22.6144 45.7243 23.7986 44.8085 24.3349C44.6213 24.443 44.6085 24.4725 44.6137 24.939C44.6559 27.1604 44.0571 29.3777 42.8543 31.54C41.4965 33.9678 39.0794 36.4798 35.8073 38.846C34.0502 40.1247 29.8918 42.5469 28.0122 43.3973C23.5096 45.4244 19.8999 46.2022 16.7645 45.8181C14.8943 45.5915 12.7771 44.8611 11.5246 44.0137C11.1951 43.786 11.1428 43.7719 10.8909 43.8439C9.55017 44.2289 7.79442 43.4374 6.30272 41.7817C5.70771 41.1197 4.74709 39.4939 4.43575 38.6241C3.71569 36.5887 3.85859 34.752 4.81783 33.6551C5.0657 33.3725 5.07387 33.3607 5.01972 32.8856C4.93033 32.1079 4.88982 30.9566 4.93066 30.2138L4.96343 29.5205L3.92091 27.6777C2.3078 24.8074 1.28326 22.3968 0.887982 20.5554C0.679402 19.546 0.692781 19.0981 0.949061 18.7667C1.10529 18.5666 1.61622 18.3594 2.23252 18.2455C3.78518 17.9729 7.17203 18.2198 10.9394 18.885L11.3303 18.9525L12.1903 18.1921C13.6179 16.9275 14.5665 16.2176 16.315 15.1274C18.1373 13.9872 20.1943 13.0498 22.5103 12.3071L23.2533 12.0687L23.6615 10.9964C25.1239 7.13587 26.6218 4.28969 27.6897 3.3426ZM15.4393 23.1261C13.7864 24.0804 12.9602 24.5582 12.3529 25.093C9.89364 27.2585 8.9738 30.6888 10.0208 33.7938C10.2794 34.5606 10.7568 35.387 11.7111 37.0398C12.6653 38.6926 13.1424 39.5194 13.6771 40.1267C15.8426 42.5859 19.2732 43.5045 22.3783 42.4574C23.145 42.1989 23.972 41.7223 25.6248 40.768L35.1333 35.2783C36.7862 34.324 37.6124 33.8462 38.2196 33.3114C40.6789 31.1459 41.5988 27.7156 40.5518 24.6105C40.2932 23.8438 39.8157 23.0174 38.8615 21.3646C37.9072 19.7117 37.4302 18.885 36.8955 18.2777C34.7299 15.8185 31.2993 14.8999 28.1943 15.947C27.4275 16.2055 26.6006 16.6821 24.9478 17.6364L15.4393 23.1261Z\" fill=\"url(#paint1_linear_5110_14771)\"/>\n<rect x=\"15.8816\" y=\"30.0273\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 15.8816 30.0273)\" fill=\"white\"/>\n<rect x=\"26.6978\" y=\"23.7812\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 26.6978 23.7812)\" fill=\"white\"/>\n</g>\n<defs>\n<filter id=\"filter0_f_5110_14771\" x=\"-14.9163\" y=\"7.45599\" width=\"55.0468\" height=\"55.047\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"6.72123\" result=\"effect1_foregroundBlur_5110_14771\"/>\n</filter>\n<filter id=\"filter1_f_5110_14771\" x=\"9.46959\" y=\"19.7477\" width=\"47.7417\" height=\"47.741\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"5.50019\" result=\"effect1_foregroundBlur_5110_14771\"/>\n</filter>\n<linearGradient id=\"paint0_linear_5110_14771\" x1=\"20\" y1=\"0\" x2=\"20\" y2=\"40\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"#6C4DFF\"/>\n<stop offset=\"1\" stop-color=\"#583ED3\"/>\n</linearGradient>\n<linearGradient id=\"paint1_linear_5110_14771\" x1=\"14.639\" y1=\"10.7917\" x2=\"32.1712\" y2=\"41.1585\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"white\" stop-opacity=\"0.8\"/>\n<stop offset=\"0.437689\" stop-color=\"white\"/>\n</linearGradient>\n<clipPath id=\"clip0_5110_14771\">\n<rect width=\"40\" height=\"40\" rx=\"20\" fill=\"white\"/>\n</clipPath>\n</defs>\n</svg>",
                  "codex": "<svg class=\"codex-brand\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\" fill=\"#10A37F\"><title>OpenAI</title><g transform=\"translate(1.2 1.2) scale(0.9)\"><path d=\"M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z\"/></g></svg>",
                  "glm": "<svg role=\"img\" viewBox=\"0 0 30 30\" xmlns=\"http://www.w3.org/2000/svg\"><title>Z.ai / GLM logo</title><path d=\"M24.51 28.51H5.49c-2.21 0-4-1.79-4-4V5.49c0-2.21 1.79-4 4-4h19.03c2.21 0 4 1.79 4 4v19.03c-.01 2.21-1.8 3.99-4.01 3.99z\" fill=\"#2D2D2D\"/><path d=\"M15.47 7.1l-1.3 1.85c-.2.29-.54.47-.9.47h-7.1V7.09h9.3z\" fill=\"#FFFFFF\"/><polygon points=\"24.3,7.1 13.14,22.91 5.7,22.91 16.86,7.1\" fill=\"#FFFFFF\"/><path d=\"M14.53 22.91l1.31-1.86c.2-.29.54-.47.9-.47h7.09v2.33h-9.3z\" fill=\"#FFFFFF\"/></svg>",
                  "qwen-code": "<svg role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>QWen</title><path d=\"M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z\"/></svg>",
                  "trae": "<img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAF9SURBVHgB7Zm9SsNQFMf/EYWiVB2KKGLBScHFN9BJurmoa0dn9QGqD1CdHbtWFzd10jfQQdBJqIgKGYw4VCR+nGD0ptqmsSectD0/CKXpbXJ+3HvOyYfVP5B+RxvTgzZHBaRRAWlUQBoVkEYFpOkNGzC0MgtJnPJZw99DBcZ2FiFJmIDmgDSdn8S1PB9d4aFwiDgY2cwhnZuK9J/IAq5TxevNI+Lg7amKqGgO/DrgYIplTNPnAyN9E8OYPF5FZmOu7hgKPrufZ+svkXOgHhR8di/vfWbW5719dvE0MMYPPjUz6m3E3doBWoFlBszgfUjCnAkzeB+6TGl1JuJNYuOJk/W1ccMiQGW1slwKlFe7eAJ7+2cJuZ8lsrJUwsvF/fc+us5JxBIiTIna4H1MCY7gCbYkJij464Xdhg3Jl3D/0bT+gj0HmummXMET2omlCc2By/GtwHeq3dO3BSQFXULSdN8dGdV6p3yOpGDpOzJhVEAaFZBGBaRRAWlUQJoPEeV5RYlN/QYAAAAASUVORK5CYII=\" width=\"12\" height=\"12\" alt=\"\" style=\"border-radius:2px;display:block\">",
                  "zcode": "<svg role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Z pixel outline</title><rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"5\" fill=\"#13272B\"/><g fill=\"#0F8A80\"><rect x=\"5\" y=\"5\" width=\"14\" height=\"2.6\"/><rect x=\"14.6\" y=\"7.6\" width=\"2.6\" height=\"2.6\"/><rect x=\"11.4\" y=\"10.7\" width=\"2.6\" height=\"2.6\"/><rect x=\"8.2\" y=\"13.8\" width=\"2.6\" height=\"2.6\"/><rect x=\"5\" y=\"16.4\" width=\"14\" height=\"2.6\"/></g></svg>",
                };
                // #227 件四：占位 getter——无品牌 SVG 引擎（zcode/glm/未知）=品牌色圆角字母
                // （与像素螃蟹同族谱；expo EngineIcon PLACEHOLDER 同源色）
                const engineBrandSvgOf = (item) => ENGINE_BRAND_SVG[item.engineClass] ?? (() => {
                  const PH = { zcode: ["#546784", "Z"], glm: ["#3E8EF7", "G"] }[item.engineClass] ?? ["#546784", (item.engine || "?").charAt(0).toUpperCase()];
                  return '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="5" fill="' + PH[0] + '"/><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">' + PH[1] + '</text></svg>';
                })();
                const b2EngineBadge = (item) => { const brand = engineBrandSvgOf(item); return '<span class="engine-badge ' + item.engineClass + '">' + (brand ? '<span class="badge-brand">' + brand + "</span>" : '<svg class="engine-icon" aria-hidden="true"><use href="#icon-' + b2EngineIconFor(item.engineClass) + '"></use></svg>') + item.engine + "</span>"; };
                // W-CRABINTEGRATE（用户 1025 图集点选）：角色蟹头像——PM=举旗蟹 D2 / Leader=皇冠蟹 A1
                //（claude 引擎替标准蟹；非 claude 保本引擎字形+右上皇冠角标 -15° 金色=通用角色层兜底）。
                // 角色判定=item.teamRole（pmTeamChipOf 词表单口扩展 kind），worker 卡零变化。
                const ROLE_AVATAR_BRAND = {
                  "pm": "<img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAL8AAACwCAYAAABevL/TAAAqh0lEQVR4nO19SZMkyXXe5x5LLlXdhR7sCwGwBwNQgMiBkQAFjQygoBspM9F00UXSL9AP0EFnmumgq2460nTRTQeZSeSBgmEzgARHAAFxMDM9gwGxcGY000tVZcbmIfvec48lK2vp6e7Kpf1ry46szIjICI/nz58/f+97QERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERMT2wmz6AiIizsMLtz/Wfu0rt+X9N757R7bfvvPLxyaz6eM6UUTEk8Z/uH0bfwK04e9H7QhR+CN2rgMEPGpHiMIfsXcd4aqdIQp/xN51hKuOClH4I55a8ygKf8RT2xGi8Ec8tR3BbvRKIiI2iCj8EU8tovBHPLWIwh/x1GKjE97Pf/RWi3vvIuf8my/Tb1unW/FL+c9lmj7YyleXLGXUte4TXtYO/rZA0+h+bdu/wt9XQZL4NyvXHf5u6vHfq1teQ7iPddfp3NnrG14j97sI4f4uvf5Ljl/XfrwHZ1bajJ/5z7k1CdBmGV66V21dHNlGhf8PXvhH+MPn/yFmroS1FsaYbktw2/qWHW6H77m/glt3ZkvhMaaFMUm31QfIp+7Q8Oma9ecO13ARrJxnjHDspcebFk1TwNheQsP9h5dz7sy9D6/zsvu3Nl37Ofx2eK3rwPYZPo/wjOR6bIYaCRwMrHRK/qe9lYLfmBQ1LN5+cILvvvij9n/+72/h9ePt6QQbFf7nPvUpHOXAYUMhpmCi22qDt/Lw1wlm//CHZ3RrttyB5+T+zp/XdX87XKIax6vmZ2CMG++9IkwXC3+DNmHvHN/DUNh4havnHneuoHZ5nvbM1pr1n8NvLxP+NukvTi+L+4fhoEVlKPxWhN9Sucjp2Oa8dqCdTIGyQl6XWyH4f3JHo0M3Lvx1tcQsPcSBoXbpH7rAa5Jes13y8DshvmxLO4So9FwivNpJ9FzrNeT67RqY8fWFznsespyjGzWwdkrZtmyLxAvo4PdM35nD73dt1vrvV7ZVWa39HH6biN1z/n0a23/ftvXo+8Y1SK3eH0U9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\" width=\"12\" height=\"12\" alt=\"\" style=\"border-radius:2px;display:block\">",
                  "leader": "<img src=\"data:image/png;base64,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\" width=\"12\" height=\"12\" alt=\"\" style=\"border-radius:2px;display:block\">",
                };
                const ROLE_CROWN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.5 L4.8 8 L9.4 12.8 L12 6 L14.6 12.8 L19.2 8 L21 17.5 Q12 20.5 3 17.5 Z" fill="#D4AF37" stroke="#8B6914" stroke-width="1.2" stroke-linejoin="round"/><circle cx="12" cy="4.6" r="1.4" fill="#D4AF37"/><circle cx="5.2" cy="6.9" r="1.1" fill="#D4AF37"/><circle cx="18.8" cy="6.9" r="1.1" fill="#D4AF37"/></svg>';
                const avaBrandHtmlOf = (item) => {
                  const role = item.teamRole;
                  const brand = engineBrandSvgOf(item);
                  if (role && ROLE_AVATAR_BRAND[role]) {
                    if ((item.engineClass || "claude") === "claude") return '<span class="ava-brand role-ava">' + ROLE_AVATAR_BRAND[role] + "</span>";
                    return '<span class="ava-brand role-badge-host">' + brand + '<span class="ava-crown" aria-hidden="true">' + ROLE_CROWN_SVG + "</span></span>";
                  }
                  return '<span class="ava-brand">' + brand + "</span>";
                };
                // FB19 源色块：源色不再「家里 iMac 二值」——按源名哈希取八色环，同名恒色异名易分
                const b2SourcePalette = ["#3E8E7E", "#5B8FA8", "#8A7AB5", "#A8763E", "#7D9A3C", "#B55F7A", "#4E85C0", "#9A8A4E"];
                const b2SourceColor = (source) => {
                  const s = String(source || "");
                  if (!s) return "var(--source)";
                  let h = 0;
                  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
                  return b2SourcePalette[h % b2SourcePalette.length];
                };
                window.__ccDeck005SourceColor = b2SourceColor; // #245 跨 IIFE 暴露(team/bridge 域源胶囊取源色)
                // UIPOLISH2 件一：头像底色引擎品牌色淡彩——地基 sessionAvaColor 逐字节同构（myCardMarkup
                // 与地基 renderSessionCard 的 DOM 一致性是 observer 完整性检查的前提，两处必须同步改）
                const b2AvaColor = (item) => ({
                  claude: "var(--engine-claude)", glm: "var(--engine-glm)", codex: "var(--engine-codex)", trae: "var(--engine-trae)",
                  qwen: "var(--engine-qwen)", codebuddy: "var(--engine-codebuddy)", zcode: "var(--engine-zcode)",
                }[item.engineClass] || b2SourceColor(item.source));
                // W-TEAMSNC ②③：团队 chip 单口 markup——button 化（data-team-chip 开第四列团队抽屉，
                // 委托链见 UI.section data-team-chip 分支）+ ✦ 前缀（复用 member-chip SLIM_KEEP_ROLE
                // 徽记符号=「编制特卡」语义）；卡 r3 与详情 head identity-cluster 同款同链。
                // idle=E5 全闲置灰；aria-expanded 随抽屉开合同 gid 置 true（入口态可视）。
                // W-TEAMCHIP2 ①（用户 1025 实锤「色块语义不明」）：左侧色块 i 换双人剪影内联 svg
                //（team 通用符号，两人重叠剪影——后人（右小）半身与前辈（左大）几何交叠约
                // 1.4px，同色 fill 融合成经典 people 形态），fill=currentColor 随 --team-accent 取色。
                // W-TEAMCHIP2 ②：teams-dock 退役后未读聚合唯一列表可视面=chip 角标 tc-unread
                //（slimUnread→chip，有未读显数防失焦；>9 收口 9+；title 带精确数）。
                const TEAM_CHIP_ICON = '<svg class="tc-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.2" cy="4.4" r="2.7"/><path d="M0.7 13.8v-.9c0-2.9 1.9-4.7 4.5-4.7s4.5 1.8 4.5 4.7v.9z"/><circle cx="11.5" cy="4.7" r="2.3"/><path d="M8.3 13.8v-.8c0-2.4 1.5-4.1 3.2-4.1s3.2 1.7 3.2 4.1v.8z"/></svg>';
                // W-ENGLM2 F（用户 1025 实锤）：chip 数字位=活跃成员数（编制内 WORKING 计数，
                // 0 不显；working 色小数字 tc-run）——未读不再占数字位，降级为不带数字的小圆点
                // tc-dot（保留注意力信号；slimUnread 基建改挂）。idle（全闲=running 0）自然无数字，
                // 与活跃数并存语义成立（E5 判定不动）。unread 数据链原样（点击开抽屉=清零不变）。
                const teamChipMarkup = (t) => {
                  const un = S.slimUnread.get(t.gid);
                  const hasUnread = un ? un.size > 0 : false;
                  return '<button type="button" class="team-chip' + (t.idle ? " idle" : "") + (hasUnread ? " has-unread" : "") + '" data-team-chip="' + esc(t.gid) + '" title="所属团队：' + esc(t.name) + (t.idle ? " · 团队空闲（无在跑成员）" : "") + (t.running > 0 ? " · " + t.running + " 人在跑" : "") + (hasUnread ? " · 有新输出未在看" : "") + ' · 点击展开团队抽屉" style="--team-accent:' + t.accent + '" aria-expanded="' + (S.drawerGid === t.gid ? "true" : "false") + '">' + TEAM_CHIP_ICON + '<span class="tc-name">' + esc(t.name) + "</span>" + (t.running > 0 ? '<span class="tc-run">' + t.running + "</span>" : "") + (hasUnread ? '<i class="tc-dot" aria-hidden="true"></i>' : "") + "</button>";
                };
                const teamChipsOf = (item) => (Array.isArray(item.teams) ? item.teams : []).map(teamChipMarkup).join("");
                function myCardMarkup(item) {
                  // B2 批2 A#bg-live：⑂N 徽标从 r3 迁 r2 走秒行前（warn 呼吸点 + task-ref chip 形制 tag）；
                  // bgCount>0 恒显（任意状态、含 WORKING）；r3 回归置顶/引擎/来源
                  // #227 三排定稿③：竖条退役——源信息回归第三排双胶囊（b2SrcCap=件A
                // 电脑图标前缀+源名，色=sourcePalette 同色）
                const b2SrcCap = (item) => item.source
                  ? '<span class="src-cap" title="来自 ' + item.source + '" style="background:' + b2SourceColor(item.source) + 'E6;border-radius:4.5px;padding:1px 5.5px;color:#fff;font-weight:700;letter-spacing:.3px"><svg width="9" height="9" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3.5" width="20" height="13.5" rx="2" fill="rgba(255,255,255,0.92)"/><path d="M8 21h8" stroke="rgba(255,255,255,0.92)" stroke-width="2.4" stroke-linecap="round"/></svg>' + item.source + "</span>"
                  : "";
                  return '<div class="queue-card' + (item.selected ? " selected" : "") + (item.idle ? " idle" : "") + '" data-session-card="' + item.id + '"><span class="srow-ava" style="--srow-ava-c:' + b2AvaColor(item) + '">' + avaBrandHtmlOf(item) + '<i class="status-dot ' + item.status + '"></i></span><span class="srow-main"><span class="srow-r1"><strong title="' + item.title + '">' + item.title + "</strong>" + (item.time ? '<time class="srow-time">' + item.time + "</time>" : "") + '<button type="button" class="srow-more" aria-label="会话操作菜单" title="更多操作">⋯</button><button type="button" class="srow-pin' + (item.pinned ? " on" : "") + '" aria-label="' + (item.pinned ? "取消置顶" : "置顶") + '" title="' + (item.pinned ? "取消置顶" : "置顶") + '"><svg class="icon-inline" aria-hidden="true"><use href="#icon-pin"></use></svg></button><button type="button" class="srow-close" aria-label="删除会话" title="删除会话"><svg class="icon-inline" aria-hidden="true"><use href="#icon-x"></use></svg></button></span><span class="srow-r2">' + (item.bg ? '<i class="srow-live-dot"></i><span class="tag bg-live-tag" title="后台子 Agent 在跑">⑂' + item.bg + "</span>" : "") + (item.status === "done" && item.queuedDispatch > 0 ? '<span class="tag dispatched-flag" title="该会话所属组有 ' + item.queuedDispatch + ' 个派单排队等待处理">已派单 · 等待处理</span>' : "") + '<span class="srow-r2-t">' + item.summary + "</span>" + (item.status === "working" ? '<span class="srow-sec" data-work-sec="' + (item.workSecs || 0) + '">' + (item.workSecs || 0) + "s</span>" : "") + "</span>" + ((item.teams && item.teams.length) || item.engine || item.source ? '<span class="srow-r3">' + b2SrcCap(item) + b2EngineBadge(item) + '<span class="r3-spring"></span>' + (item.cwdTail && !item.teamRole ? '<span class="cwd-cap">📁 ' + esc(item.cwdTail) + "</span>" : "") + teamChipsOf(item) + "</span>" : "") + "</span>" + (item.tagClass === "action" || item.tagClass === "danger" ? '<button type="button" class="srow-cta">处理</button>' : "") + "</div>";
                }
                function getSessionProject(session) { // ⑥a-2：会话→项目归属（SNAPSHOT projects.anchor_dir 优先，否则取 cwd 尾段目录名）
                  // #158-批4a：前缀匹配归一化（Windows 数据 \ 与拼 / 不匹配会让子目录会话落不进项目组）
                  const cwd = String(session.cwd || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
                  const projects = Array.isArray(S.projects) ? S.projects : [];
                  if (cwd) {
                    const hit = projects.find((p) => {
                      if (!(p && typeof p.anchor_dir === "string" && p.anchor_dir)) return false;
                      const a = p.anchor_dir.replace(/[\\/]/g, "/").replace(/\/+$/, "");
                      return a === cwd || cwd.startsWith(a + "/");
                    });
                    if (hit && hit.name) return String(hit.name);
                  }
                  return cwd ? (cwd.split("/").filter(Boolean).pop() || cwd) : "未归属目录";
                }
                // ---------- [t-7e0c6189] 会话列表瘦身：worker 会话收进团队域 ----------
                // 口径（对照图 docs/session-list-slim-mockup.html）：编制内 role 非 PM/Leader 的成员会话
                // 不逐张铺列表，聚合为每团队一张入口卡；PM/Leader/无编制直连/置顶照旧直列；正被选中
                // （直聊中）的 worker 会话临时出列，切走自动收回。slimRosterOf/slimIsHidden 为纯函数
                // （test-session-slim.ts 直跑锚）。
                const SLIM_KEEP_ROLE = /^(pm|leader|产品经理|项目经理|领队)$/i; // t25fix #11：词表补中文 PM 角色（编制实况 role 多中文，原只认 pm|leader 时中文 PM 全被当 worker 收卡/归属 chip 恒 null）；pmTeamChipOf 同词表同源
                function slimRosterOf(projects) {
                  const bySid = new Map(), teams = new Map();
                  for (const p of (Array.isArray(projects) ? projects : [])) {
                    if (!p || typeof p.id !== "string") continue;
                    // W-TS63FIX（review-tsync-web P2-1）：归档门控统一——archived 团队与 chip 侧
                    //（pmTeamChipOf E4 过滤）对齐：dock 入口/第四列抽屉/worker 收纳（slimIsHidden
                    // 经 bySid）四面同退役；已开归档团队抽屉在下次 renderSlimDrawer team-miss
                    // 路径自动收起（自愈链现成，S.boards 残帧随 teams 缺席自然失效）。
                    if (String(p.status || "") === "archived") continue;
                    const list = (Array.isArray(p.headcount) ? p.headcount : []).filter((m) => m && typeof m.session_id === "string");
                    if (!list.length) continue;
                    teams.set(p.id, { id: p.id, name: String(p.name || p.id), members: list });
                    for (const m of list) bySid.set(m.session_id, { gid: p.id, role: String(m.role || ""), gname: String(p.name || p.id) }); // 同 sid 跨团编制罕见，后者覆盖（团队域 memberInfo 同 find 口径）
                  }
                  return { bySid, teams };
                }
                function slimIsHidden(session, roster, selectedSid) {
                  if (!session || typeof session.session_id !== "string") return false;
                  if (session.pinned === true) return false; // 置顶例外：用户显式关注优先于 IA 规则
                  const m = roster.bySid.get(session.session_id);
                  if (!m || SLIM_KEEP_ROLE.test(m.role)) return false; // PM/Leader 与无编制（直连）照旧直列
                  return session.session_id !== selectedSid; // 直聊中（选中）临时出列
                }
                // slimTeamEntryMarkup（dock 入口卡）随 W-TEAMCHIP2 ② teams-dock 整体退役删除
                //（用户 1025 拍板：融合已成，列表下方团队卡组移除，C 稿 dock 退役项落地）——
                // 团队入口收口 chip（列表/详情 head）+抽屉 roster 行+团队域三链；收纳逻辑
                //（slimIsHidden/SLIM_KEEP_ROLE）保留，收起会话入口=抽屉 roster 行直开+chip。
                // slimDrawerCardMarkup（旧成员会话卡列）随 W-TEAMSNC ④ 厚抽屉退役——roster 行直开
                //（data-slim-open）吸收其职能（B 稿 D3/R5：YAGNI，Leader 拍板主战方案）
                // ---------- W-TEAMSNC ④ 第四列团队信息抽屉（B 稿主战方案定稿）----------
                // 原「成员会话卡列」原位升级为厚信息抽屉：四区=在办概览（板）/成员 roster（行直开）/
                // 输出物计数/跳团队域钮组；296px + .open class 滑入动效（替代 [hidden] 硬切）；开抽屉
                // 清未读（slimMarkSeen 现成）。数据面（B 稿 §3）：S.boards 吃 SNAPSHOT.boards +
                // BOARD_UPDATED 帧跟随（会话域唯一新增消费点）；板缺席=「板未同步」降级文案不伪造
                // 0/0/0；成员态/水位吃 S.sessions 现成字段。板新鲜度承诺=快照级+帧级跟随，深度实时
                // 去团队域（域职责不越界）。泳道词表与 team-domain lanes 同源（legacy 归并+五段条）。
                const TEAM_DRAWER_LANES = [["backlog", "待认领"], ["claimed", "进行中"], ["submitted", "待审查"], ["ready_to_install", "待收单"], ["done", "完成"]];
                const TEAM_DRAWER_LEGACY = { todo: "backlog", doing: "claimed" };
                /** 纯函数拼装模型（单测锚：relay/scripts/test-session-slim.ts 纯函数直跑同范式）。
                 * boardEntries=null=板未同步（旧 relay/未随快照）——概览区走降级，不伪造空板。 */
                function teamDrawerModelOf(team, boardEntries, sessionsMap) {
                  const members = (team && Array.isArray(team.members)) ? team.members : [];
                  const roster = members.map((m) => {
                    const s = sessionsMap.get(m.session_id);
                    const pct = s && Number(s.context_limit) ? Math.min(100, Math.round((Number(s.context_usage) || 0) / Number(s.context_limit) * 100)) : null;
                    return {
                      sid: m.session_id, role: String(m.role || ""), nick: String(m.nick || ""),
                      pm: SLIM_KEEP_ROLE.test(String(m.role || "")),
                      online: !!s, status: s ? s.status : null,
                      title: s ? String(s.title || s.session_id) : String(m.session_id).slice(0, 8),
                      pct,
                      arts: s && Array.isArray(s.artifacts) ? s.artifacts.filter((a) => a && a.path) : [],
                    };
                  });
                  const running = roster.filter((r) => r.status === "WORKING").length;
                  const laneOf = (e) => e && (TEAM_DRAWER_LEGACY[e.status] || e.status);
                  const entries = Array.isArray(boardEntries) ? boardEntries : null;
                  const lanes = entries ? TEAM_DRAWER_LANES.map(([k, label]) => ({ k, label, n: entries.filter((e) => laneOf(e) === k).length })) : null;
                  const activeN = lanes ? lanes.slice(0, 4).reduce((n, l) => n + l.n, 0) : null; // 在办=四未完泳道合计（done 除外）
                  const keyTasks = entries ? entries.filter((e) => e && e.gate && e.gate.reason).slice(0, 3) : [];
                  const arts = roster.flatMap((r) => r.arts.map((a) => ({ path: String(a.path || ""), last_at: Number(a.last_at || 0), sid: r.sid, who: r.nick || r.title.slice(0, 8) }))).sort((a, b) => b.last_at - a.last_at);
                  return { gid: team ? String(team.id || "") : "", name: team ? String(team.name || "") : "", rosterN: members.length, running, roster, lanes, activeN, keyTasks, artsCount: arts.length, recentArts: arts.slice(0, 3) };
                }
                // roster 行排序：PM/Leader 前置 → 在跑前置 → 编制序（B 稿 sortRoster 同口径）
                function teamDrawerRosterSort(a, b) {
                  return Number(b.pm) - Number(a.pm) || Number(b.status === "WORKING") - Number(a.status === "WORKING") || 0;
                }
                function teamDrawerMarkup(model) {
                  // 头：「名 · N 席 · 在办 M」（A 稿附计数带口径：M=成员 WORKING 计数，无板依赖）
                  const head = '<div class="drawer-head"><span class="d-name">' + esc(model.name) + " · " + model.rosterN + " 席 · 在办 " + model.running + '</span>' + (S.status !== "online" ? '<span class="d-stale" title="连接断开 · 板况与成员态可能陈旧（重连后随帧自愈）">离线·陈旧</span>' : "") + '<button type="button" class="d-close" data-slim-drawer-toggle="' + esc(model.gid) + '" title="收起团队抽屉" aria-label="收起团队抽屉">✕</button></div>';
                  // 区一：在办概览（板比例条+关键任务；板缺席=降级文案，入口钮兜底——B 稿 §3 降级口径）
                  let overview;
                  if (model.lanes) {
                    const segs = model.lanes.filter((l) => l.n > 0).map((l) => '<i class="' + l.k + '" style="flex-grow:' + l.n + '" title="' + l.label + " " + l.n + '"></i>').join("");
                    const legend = model.lanes.map((l) => '<span style="--legend-color:var(--p-' + (l.k === "ready_to_install" ? "ready" : l.k) + ')"><i></i>' + l.label + " <b>" + l.n + "</b></span>").join("");
                    const keys = model.keyTasks.length ? '<div class="key-task-head">⚠ 关键任务 ' + model.keyTasks.length + "</div>" + model.keyTasks.map((e) => '<div class="key-task" title="' + esc(String(e.text || "").slice(0, 80)) + '">⚠ ' + esc(String(e.text || "").slice(0, 26)) + " · 阻塞：" + esc(String((e.gate && e.gate.reason) || "").slice(0, 18)) + "</div>").join("") : "";
                    overview = '<div class="dr-sec"><span>在办 ' + (model.activeN || 0) + '</span><span class="dr-sub">板未完任务</span></div>'
                      + '<div class="lane-bar" role="img" aria-label="任务状态分布">' + segs + '</div><div class="lane-legend">' + legend + "</div>" + keys;
                  } else {
                    overview = '<div class="dr-sec"><span>在办 ' + model.running + '</span><span class="dr-sub">成员口径</span></div><div class="readonly-banner slim">板未同步 · 深度板况去团队域看板 ↓</div>';
                  }
                  // 区二：成员 roster（行点击=直开成员会话，data-slim-open 既有链；异源未同步=灰行不隐行 #99件5 口径）
                  const rosterRows = model.roster.slice().sort(teamDrawerRosterSort).map((r) => {
                    const st = ({ WORKING: "working", WAITING: "blocked", ERROR: "error", DONE: "idle" })[r.status] || "closed";
                    const stWord = ({ WORKING: "在跑", WAITING: "待确认", ERROR: "异常", DONE: "空闲" })[r.status] || "离线";
                    return '<div class="roster-row' + (r.online ? "" : " offline") + '" data-slim-open="' + esc(r.sid) + '" role="button" tabindex="0" title="' + esc((r.pm ? "✦ " : "") + r.title + " · " + (r.nick || r.role || "成员") + " · " + stWord + (r.online ? " · 点击直开" : " · 会话未同步")) + '"><i class="lamp-dot ' + st + '"></i><span class="rr-name">' + (r.pm ? "✦ " : "") + esc(r.nick || r.title.slice(0, 14)) + '</span><span class="rr-role">' + esc(r.role || "worker") + '</span><span class="rr-ctx">' + (r.pct !== null ? r.pct + "%" : "") + "</span></div>";
                  }).join("");
                  const rosterSec = '<div class="dr-sec"><span>成员 ' + model.rosterN + '</span><span class="dr-sub">在跑 ' + model.running + " · 点击行直开</span></div>"
                    + (rosterRows || '<div class="readonly-banner slim">编制为空 · 团队域维护</div>');
                  // 区三：输出物计数+最近 3 件（成员 artifacts 聚合，团队域 teamOutputsMarkup 同口径）
                  const artsHtml = model.artsCount
                    ? '<div class="dr-arts">' + model.recentArts.map((a) => '<div class="dr-art" title="' + esc(a.path) + " · " + esc(a.who) + '"><span class="da-name">' + esc(a.path.split(/[\\/]/).pop() || a.path) + "</span><span>" + esc(a.who) + "</span></div>").join("") + "</div>"
                    : '<div class="readonly-banner slim">尚无输出物登记</div>';
                  const artsSec = '<div class="dr-sec"><span>输出物 ' + model.artsCount + "</span></div>" + artsHtml;
                  // 区四：跳团队域钮组（railJump 三链：railJump→ccDeckTeam.select→clickTab，notify.js 先例）
                  const entrySec = '<div class="entry-btns">'
                    + ["看板", "成员", "输出"].map((lbl) => '<button type="button" class="dr-jump" data-team-jump="' + esc(model.gid) + '" data-team-jump-tab="' + esc(lbl) + '" title="团队域 · ' + esc(lbl) + '">' + esc(lbl) + " ↗</button>").join("")
                    + "</div>";
                  return head + '<div class="drawer-body">' + overview + rosterSec + artsSec + entrySec + "</div>";
                }
                // docked/overlay 双形态（B 稿 §1.4 共存矩阵）：≥1360px docked 贴检查器左缘无遮罩；
                // <1360px overlay 贴屏右缘盖检查器+半透明遮罩（点遮罩关）。类切换挂 #d-session
                //（.drawer-overlay），与检查器拖宽 --inspector-w 正交；遮罩仅 overlay+开态挂载。
                // W-TEAMCHIP2 ③：尾部串 syncDrawerMutex——本函数是抽屉形态/开合的唯一汇点
                //（renderSlimDrawer 开/收两路+mq resize 钩全走此），互斥随每次汇入对账。
                function syncDrawerOverlay() {
                  const screen = document.querySelector("#d-session");
                  const drawer = document.querySelector("#d-session [data-slim-drawer]");
                  if (!screen || !drawer) return;
                  const overlay = !window.matchMedia("(min-width: 1360px)").matches;
                  screen.classList.toggle("drawer-overlay", overlay);
                  let mask = screen.querySelector(".drawer-mask");
                  const needMask = overlay && !!S.drawerGid; // W-TEAMCHIP2 ③顺手根修：.open 由 rAF 下一帧落，读 class 会晚一拍才挂 mask（改读开合态，与滑入同步）
                  if (needMask && !mask) {
                    mask = document.createElement("div");
                    mask.className = "drawer-mask";
                    mask.addEventListener("click", () => { if (S.drawerGid) slimToggleDrawer(S.drawerGid); });
                    drawer.before(mask);
                  } else if (!needMask && mask) mask.remove();
                  syncDrawerMutex();
                }
                // W-TEAMCHIP2 ③：抽屉×第三列互斥（docked 形态）。重叠面实况——检查器「团队成员」
                // 块（成员胶囊行+直开）与抽屉 roster 区同源同职能，且两列全高并置挤占工作区
                //（296+320px）。方案=互斥而非内容差异化：复用既有 inspector-collapsed 基建
                //（W-TOPBAR ①收起整块 display:none + W-UIFIX E 贴边 ‹ 把手，抽屉 CSS 已适配
                // 收起锚位），检查器独有内容（会话任务/用量/输出物）在团队浏览场景非焦点，收起
                // 零信息损失，‹ 把手一键展开/关抽屉自动还原。S._drawerMutex 只记「互斥收起是
                // 本链开的」：用户既定收起态（默认收起/手动收起过）不碰不还原；overlay 态抽屉
                // 盖检查器无需收，切形态时还原。类直切不走 setInspectorCollapsed（settings 域
                // IIFE 内私有；两行类切换等价，且不触碰其 localStorage/manual 语义）。
                function syncDrawerMutex() {
                  const screen = document.querySelector("#d-session");
                  const inspector = screen && screen.querySelector(".inspector");
                  if (!screen || !inspector) return;
                  const docked = window.matchMedia("(min-width: 1360px)").matches;
                  const collapsedNow = screen.classList.contains("inspector-collapsed");
                  if (docked && S.drawerGid && !collapsedNow) {
                    S._drawerMutex = true;
                    screen.classList.add("inspector-collapsed");
                    inspector.classList.add("collapsed");
                  } else if (S._drawerMutex && (!S.drawerGid || !docked)) {
                    S._drawerMutex = false;
                    screen.classList.remove("inspector-collapsed");
                    inspector.classList.remove("collapsed");
                  }
                }
                function renderSlimDrawer() {
                  const el = document.querySelector("#d-session [data-slim-drawer]");
                  if (!el) return;
                  if (!S.drawerGid && !el.classList.contains("open")) return; // 收起态稳态早退（UPDATED 高频路径零 DOM 操作）
                  const team = S.drawerGid ? slimRosterOf(S.projects).teams.get(S.drawerGid) : null;
                  if (!team) { if (S.drawerGid) { S.drawerGid = ""; try { localStorage.setItem("cc-deck-005-slim-drawer", ""); } catch (_) {} } el.classList.remove("open"); el.replaceChildren(); syncDrawerOverlay(); return; }
                  el.hidden = false; // keep-mounted（首帧解除 hidden 兜底）；显隐交 .open class 过渡
                  // W-TS63FIX（review-tsync-web P3-1）：rAF 守卫——同帧开→关边界（程序性连击
                  // toggle）时，已入队回调不得给 team-miss 清空后的空抽屉补 .open（幽灵抽屉，
                  // 至下次 renderSlimDrawer 才自愈）；回调内复核 drawerGid 仍指向本团才加。
                  const gidForFrame = S.drawerGid;
                  requestAnimationFrame(() => { if (S.drawerGid && S.drawerGid === gidForFrame) el.classList.add("open"); }); // 下一帧加 class=首开也走滑入（同帧加无过渡）
                  // W-TS63FIX（review-tsync-web P2-2）：重渲保滚动位+保焦点——BOARD_UPDATED 同团
                  // 帧 innerHTML 整替换会丢 drawer-body 滚动与活动元素焦点（活跃团队 1-2s 一帧体感
                  // 明显）；先存后还：scrollTop 原位回放，焦点按 roster 行锚（data-slim-open=sid）
                  // 同位行复焦。
                  const bodyPrev = el.querySelector(".drawer-body");
                  const stPrev = bodyPrev ? bodyPrev.scrollTop : 0;
                  const aePrev = document.activeElement;
                  const aeAnchor = aePrev && el.contains(aePrev) && aePrev.closest ? (aePrev.closest("[data-slim-open]")?.getAttribute("data-slim-open") ?? null) : null;
                  el.innerHTML = teamDrawerMarkup(teamDrawerModelOf(team, S.boards ? S.boards.get(S.drawerGid) : null, S.sessions));
                  syncDrawerOverlay();
                  const bodyNext = el.querySelector(".drawer-body");
                  if (bodyNext) bodyNext.scrollTop = stPrev;
                  if (aeAnchor) {
                    const rowAgain = el.querySelector('[data-slim-open="' + cssEsc(aeAnchor) + '"]');
                    if (rowAgain && typeof rowAgain.focus === "function") rowAgain.focus();
                  }
                }
                function slimMarkSeen(gid) {
                  if (!gid || !S.slimUnread.has(gid)) return;
                  S.slimUnread.delete(gid);
                  renderMyList();
                  if (UI && curSession()) renderInspector();
                }
                function slimToggleDrawer(gid) {
                  const want = String(gid || "");
                  // W-TS63FIX（review-tsync-web P3-2）：键盘可达性——toggle 前 chip 若持焦点，
                  // renderMyList 重建列表节点会丢焦点（落 body，Tab 从头再来）；记 chip gid 重建后还焦。
                  const ae = document.activeElement;
                  const chipGid = ae && ae.matches && ae.matches("[data-team-chip]") ? ae.getAttribute("data-team-chip") : null;
                  S.drawerGid = S.drawerGid === want ? "" : want;
                  try { localStorage.setItem("cc-deck-005-slim-drawer", S.drawerGid); } catch (_) {}
                  if (S.drawerGid) slimMarkSeen(S.drawerGid); // 展开即清该团队未读（设计要点 1）
                  renderSlimDrawer();
                  renderMyList(); // W-TEAMSNC ②：chip aria-expanded 随抽屉开合同步（markSeen 无未读时不触发重渲，此处单口补齐）
                  renderHeader(); // W-TS63FIX（review-tsync-web P3-2）：head chip aria-expanded 同步（renderHeader 链不进 renderMyList，不补则停旧值）
                  if (chipGid) {
                    const chipAgain = document.querySelector('#d-session [data-team-chip="' + cssEsc(chipGid) + '"]');
                    if (chipAgain && typeof chipAgain.focus === "function") chipAgain.focus();
                  }
                }
                function slimOpenSession(sid) {
                  if (!UI) return;
                  const s = S.sessions.get(String(sid || ""));
                  if (!s) { b2Toast("成员会话不在当前来源"); return; }
                  const gid = slimRosterOf(S.projects).bySid.get(s.session_id)?.gid || "";
                  if (gid) slimMarkSeen(gid); // 直开即清该团队未读
                  if (S.selected === s.session_id) return;
                  if (S.selected) inputDrafts.set(S.selected, UI.input.value); // #B3-4 同款：切走存草稿
                  S.selected = s.session_id;
                  S.forceScroll = true;
                  UI.input.value = inputDrafts.get(s.session_id) ?? "";
                  S.staged = [];
                  histLoad(s.session_id);
                  renderTray();
                  renderMyList(); // 直聊中的 worker 会话临时出列并打标 selected（mo 读到幂等，不重复结算）
                  renderAll();
                }
                window.__ccDeck005SlimUi = Object.freeze({ open: slimOpenSession, markSeen: slimMarkSeen, toggleDrawer: slimToggleDrawer, selectedSid: () => S.selected }); // 跨域面：团队域成员卡直开 / 团队 select 清未读（团队域侧调用）；W-TEAMSNC ①：selectedSid=建团表单取「当前选中会话」任 PM（team-domain pm-led 模板消费）
                // FB17 标签筛选：会话列表工具行「全部」芯片从死控件接活——点出浮菜单按状态过滤
                // W-UIPOLISH4 件十三（2026-10-12 用户截图）：加「最近活跃」档（隐藏超时置灰的
                // 空闲僵尸卡=idleDimmed 同源判定，只显近期有活动的）+「非进行中」档；档位序=
                // 全部/最近活跃/进行中/需行动/非进行中/已完成（需行动为既有档保留，序插在
                // 进行中后不破坏用户给定相对序——严格五档可删一行）。计数徽章照旧（test 通用）。
                const SESSION_FILTERS = [
                  { id: "all", label: "全部", test: () => true },
                  { id: "recent", label: "最近活跃", test: (x) => !idleDimmed(x) },
                  { id: "working", label: "进行中", test: (x) => x.status === "WORKING" },
                  { id: "action", label: "需行动", test: (x) => x.status === "WAITING" || x.status === "ERROR" },
                  { id: "notworking", label: "非进行中", test: (x) => x.status !== "WORKING" },
                  { id: "done", label: "已完成", test: (x) => x.status === "DONE" },
                ];
                const sessionFilterOf = () => SESSION_FILTERS.find((f) => f.id === S.filter) || SESSION_FILTERS[0];
                // UIPOLISH2 件九（2026-10-11）：会话列表搜索——原输入框是死控件（listTools 挂 B2b stub
                // 无监听，aria-label 承诺「会话、项目或来源」却什么都搜不了）。按任务书「评估补齐」做
                // 最小实现：纯前端过滤，字段=名称(title/initial_prompt)+摘要(action_summary)+目录(cwd)
                // +会话 ID，多词 AND、大小写不敏感；消息正文搜索需 relay 全量 timeline，成本大列开放
                // 问题不擅扩。placeholder 已按实际能力标注
                let sessionSearchQuery = "";
                const sessionSearchTest = (x) => {
                  const q = sessionSearchQuery.toLowerCase();
                  if (!q) return true;
                  const hay = [x.title, x.initial_prompt, x.action_summary, x.cwd, x.session_id].map((v) => String(v || "").toLowerCase());
                  return q.split(/\s+/).filter(Boolean).every((t) => hay.some((h) => h.includes(t)));
                };
                function syncFilterChip() {
                  const btn = document.querySelector("#d-session [data-session-filter]");
                  if (!btn) return;
                  const def = sessionFilterOf();
                  const lbl = btn.querySelector("[data-filter-label]");
                  if (lbl) lbl.textContent = def.label; else btn.textContent = def.label; // 件八：图标+文字组合，label 收进子 span
                  btn.setAttribute("aria-label", "筛选会话 · 当前" + def.label);
                  btn.classList.toggle("active", def.id !== "all");
                }
                function openSessionFilterMenu(anchor) {
                  document.querySelectorAll("[data-filter-pop]").forEach((el) => el.remove());
                  const pop = document.createElement("div");
                  pop.className = "source-menu open"; // open 类管 display:block，定位由内联 fixed 接管
                  pop.dataset.filterPop = "";
                  pop.style.position = "fixed";
                  pop.style.zIndex = "96";
                  pop.innerHTML = '<div class="source-menu-head">筛选会话</div>' + SESSION_FILTERS.map((f) => {
                    const n = f.id === "all" ? S.sessions.size : [...S.sessions.values()].filter(f.test).length;
                    return '<button class="source-option' + (f.id === sessionFilterOf().id ? " active" : "") + '" type="button" data-filter-choice="' + esc(f.id) + '"><strong>' + esc(f.label) + '</strong><small>' + n + " 个</small></button>";
                  }).join("");
                  const rect = anchor.getBoundingClientRect();
                  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 220)) + "px";
                  pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - 200) + "px";
                  const closePop = () => { pop.remove(); document.removeEventListener("click", onDoc, true); };
                  const onDoc = (ev) => { if (!ev.target.closest("[data-filter-pop]") && !ev.target.closest("[data-session-filter]")) closePop(); };
                  pop.addEventListener("click", (ev) => {
                    const opt = ev.target.closest("[data-filter-choice]");
                    if (!opt) return;
                    S.filter = opt.dataset.filterChoice;
                    syncFilterChip();
                    renderMyList();
                    closePop();
                  });
                  document.body.append(pop);
                  setTimeout(() => document.addEventListener("click", onDoc, true), 0);
                }
                function renderMyList() {
                  if (!UI) return;
                  const list = UI.sessionList;
                  if (!S.hasSnapshot) return; // 连接中的占位由地基渲染，不抢
                  list.dataset.b2Owned = "1"; // #143 盲评A-1 止血：接管标记——地基据此让位列表渲染与走秒，防陈旧快照回盖
                  list.dataset.relayState = "snapshot";
                  list.dataset.connection = S.status;
                  list.dataset.sessionCount = String(S.sessions.size);
                  // W-UIFB ⑥（i=7）：源标签只在数据真有多源时显示——源数 = 会话数据出现过的去重源身份；
                  // 今日单一 relay 数据源恒 1 → body[data-source-count="1"]，CSS 据此隐藏第三行源标签；
                  // 多源链路（B7）落地后 per-session 源字段进来此集自然变大，标签自动回归
                  try {
                    const srcSet = new Set();
                    S.sessions.forEach((x) => srcSet.add(String((x && (x.relay_source || x.source)) || S.relayName || "")));
                    document.body.dataset.sourceCount = String(srcSet.size || 1);
                  } catch (_) {}
                  syncFilterChip();
                  const filterDef = sessionFilterOf();
                  // [t-7e0c6189] 瘦身过滤：编制内 worker/QA 会话收起（置顶/选中中/PM/Leader/无编制直列照旧）
                  const slimRoster = slimRosterOf(S.projects);
                  const slimVisible = (x) => !slimIsHidden(x, slimRoster, S.selected);
                  // W-TEAMCHIP2 ②（用户 1025 拍板，C 稿 dock 退役项落地）：#103 两段式的下段
                  // teams-dock 整链退役——列表回归单段（.list-upper 独占滚动），团队存在感全分布
                  // chip（列表 r3+详情 head，未读角标 tc-unread 唯一列表未读面）；收纳逻辑保留，
                  // 收起会话入口=抽屉 roster 行直开；队级聚合健康/队数一览走 chip idle 态+团队域。
                  const mountUpper = (upperContent) => { // 单段挂载单口（上段节点=会话卡/空态占位）
                    const upper = document.createElement("div");
                    upper.className = "list-upper";
                    upper.append(upperContent);
                    if (upperContent instanceof Element && upperContent.dataset.sessionEmpty === "true") upper.classList.add("is-empty"); // #103-B3 空态：上段不撑满随内容收缩
                    list.replaceChildren(upper);
                  };
                  if (!S.sessions.size) {
                    const ph = document.createElement("div");
                    ph.className = "readonly-banner";
                    ph.dataset.sessionEmpty = "true";
                    ph.setAttribute("role", "status");
                    ph.textContent = "暂无会话 · relay SNAPSHOT 已同步";
                    mountUpper(ph);
                    return;
                  }
                  // 1015 置顶常驻（用户需求）：筛选档不隐藏置顶卡——pinned 豁免 filterDef.test 恒进
                  // 渲染集钉最顶（不因「进行中/已完成」等状态档不匹配而被筛掉）；搜索不豁免——
                  // sessionSearchTest 是用户显式找词，置顶卡不匹配搜索词照隐藏；slim 收起不豁免——
                  // slimIsHidden 本就置顶例外（:3709）。主过滤与 filterHidden 记账共用 pinnedKeep
                  // 谓词，记账恒等于真实隐藏集（mo 完整性检查口径不漂）。
                  // #240 W-LEADERHIDE：Leader 卡不进列表——组织锚 id（SNAPSHOT.leader_session_id）
                  // + 编制 role 词表（leader|领队）双口径。词表不含 pm：PM 会话照常直列（口径②
                  // 语义判别：删的是 Leader 形制卡非 PM 会话卡）。锚不在任何团队编制 headcount
                  //（2026-10-23 生产 projects.json 实锤）——headcount 反查滤不到锚，锚 id 是
                  // 唯一可靠识别（relay SNAPSHOT 同批补发该字段）。leader 卡显式并入 filterHidden
                  // 记账（observer 遍历 S.sessions 全量，缺记账=「缺卡→重渲→仍缺」死循环，FB17）
                  const isLeaderSession = (x) => {
                    if (S.leaderSessionId && x.session_id === S.leaderSessionId) return true;
                    const m = slimRoster.bySid.get(x.session_id);
                    return !!(m && /^(leader|领队)$/i.test(String(m.role || "")));
                  };
                  const liveSessions = [...S.sessions.values()].filter((x) => !isLeaderSession(x));
                  const pinnedKeep = (x) => x.pinned === true;
                  const sessions = liveSessions.filter((x) => (pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x) && slimVisible(x)).sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || Number(b.updated_at || 0) - Number(a.updated_at || 0));
                  // FB17：被筛掉的 sid 记账——观察者完整性检查据此放行，防「缺卡→重渲→仍缺」死循环（同 _collapsedIdleIds 口径）；件九搜索并入同一隐藏口径；#240 leader 卡恒进记账
                  const filterHidden = [...S.sessions.values()].filter((x) => isLeaderSession(x) || !((pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x))).map((x) => x.session_id);
                  S._filterHiddenIds = filterHidden.length ? new Set(filterHidden) : null;
                  // [t-7e0c6189] 被收起的 sid 记账——同 FB17 口径放行（否则 mo 完整性检查「缺卡」死循环）
                  const slimHiddenIds = [...liveSessions].filter((x) => filterDef.test(x) && !slimVisible(x)).map((x) => x.session_id);
                  S._slimHiddenIds = slimHiddenIds.length ? new Set(slimHiddenIds) : null;
                  if (!sessions.length) {
                    const ph = document.createElement("div");
                    ph.className = "readonly-banner";
                    ph.dataset.sessionEmpty = "true";
                    ph.textContent = sessionSearchQuery
                      ? "搜索「" + sessionSearchQuery + "」下暂无会话 · 可换个词或清空搜索"
                      : "「" + filterDef.label + "」筛选下暂无会话 · 切回「全部」查看";
                    mountUpper(ph);
                    return;
                  }
                  // B18 活跃优先：顶部「进行中」组收全部活跃会话（WORKING/WAITING/ERROR，按置顶
                  // +recency 排）。W-NOVAUI ⑤：闲置会话不再按项目分组——铺平直排（用户实测项目
                  // 分组折叠太乱），置顶/时间序保持不变
                  // UIPOLISH2 件五（2026-10-11 用户实锤）：置顶=全局列表最顶，压过分组——原实现置顶
                  // 会话一旦空闲（DONE/ERROR 出活跃池）就落进闲置区排「进行中」组之下，用户心智里
                  // 置顶是「钉在列表最顶」不是「组内优先」。改两段式：先抽空 pinned 池平铺最顶（跨组、
                  // 恒展开不可折叠——钉选不该被组折叠藏掉），其余会话再走活跃/闲置两段。多置顶次序：
                  // relay 无 pinned_at 字段（MERGE_KEYS 仅 boolean），沿用 recency 序，真·置顶时间序
                  // 待 relay 加字段（开放问题见回执）。
                  // UIPOLISH3 件二（2026-10-11 用户拍板）：团队收纳——在办团队（status=active，与
                  // relay 现役判定 :6682 同口径）编制成员会话收进团队组：组头「团队名 · N」（N=该组
                  // 当前会话卡数，与「进行中」组计数同口径），默认折叠点开展开；顶部展开区只留置顶
                  // （恒顶跨区，先抽先赢）+非编制会话（PM/Leader 不可入编、外部会话不可入编=天然
                  // 留顶）。组内不按状态分子组（活跃前置+recency 平铺），组序=团队创建序（created_at，
                  // 同创按名稳定序）；无成员团队不出组（筛选/搜索滤空同口径——团队组跟随过滤，不绕过）。
                  // 地基 renderSessionList 不做团队分组（transient 首屏、ctx 无 projects 字段，见回执）
                  const isActive = (x) => x.status === "WORKING" || x.status === "WAITING" || x.status === "ERROR";
                  const pinnedPool = sessions.filter((x) => x.pinned === true); // 已按置顶+recency 排
                  const unpinned = sessions.filter((x) => x.pinned !== true);
                  // #103 两段式重排（2026-10-14 用户拍板）：UIPOLISH3 件二的 team:{gid} 成员
                  // 会话组整链退役——编制内直列会话（置顶/选中中的 worker、PM/Leader）与外部
                  // 会话一律平铺进上段「置顶+普通统一段」（团队组默认折叠反而藏卡；团队呈现
                  // 收口到下段 dock 入口卡，成员明细走 dock 卡 ⤢ 第四列/团队域）。
                  // teamOf/teamSections/GRP_ACCENTS 色轮/teamHidden 折叠记账随之退役——组折叠
                  // 不存在后 _collapsedIdleIds 恒 null（observer 完整性检查只剩 _filterHiddenIds/
                  // _slimHiddenIds 两记账，放行语义不变）。
                  const activeMarkup = unpinned.filter(isActive).map((x) => myCardMarkup(myCardItem(x))).join(""); // 不再按 reason 重排
                  const idleMarkup = unpinned.filter((x) => !isActive(x)).map((x) => myCardMarkup(myCardItem(x))).join("");
                  // 件五：置顶区平铺最顶、不带分组头（设计定夺见回执：置顶是跨组钉选非语义分组，
                  // 加头=降格成可折叠组）。恒在 DOM（不参与折叠记账）
                  const pinnedMarkup = pinnedPool.map((x) => myCardMarkup(myCardItem(x))).join("");
                  // 追加（2026-10-12 用户拍板，#103 延续）：取消「进行中」状态分组——状态过滤交给
                  // 筛选档（件十三「进行中」档）。活跃与闲置合流平铺（unpinned 本就按置顶+recency
                  // 序，活跃卡自然浮前）。
                  S._collapsedIdleIds = null; // 团队组退役：无折叠缺卡形态（slim 收起走 _slimHiddenIds）
                  // W-TEAMCHIP2 ②拼装：单段平铺（置顶+活跃+闲置，.list-upper 独占滚动）——
                  // #103 两段式下段 dock 已随本批退役
                  const tpl = document.createElement("template");
                  tpl.innerHTML = pinnedMarkup + activeMarkup + idleMarkup;
                  mountUpper(tpl.content);
                }

                // ---------- ⑥a-1 右键行菜单整链（置顶/重命名/复制ID/删除，走 B2 命令通道） ----------
                let rowMenu = null;
                function closeRowMenu() {
                  if (rowMenu) { rowMenu.remove(); rowMenu = null; }
                }
                function startRowRename(card, session) {
                  const titleEl = card.querySelector(".srow-r1 strong");
                  if (!titleEl || card.querySelector(".row-rename-input")) return;
                  const original = String(session.title || session.initial_prompt || session.session_id);
                  const input = document.createElement("input");
                  input.className = "row-rename-input";
                  input.type = "text";
                  input.value = original;
                  input.maxLength = 40;
                  input.setAttribute("aria-label", "会话重命名");
                  titleEl.replaceWith(input);
                  input.focus();
                  input.select();
                  let done = false;
                  const commit = async (submit) => {
                    if (done) return;
                    done = true;
                    const next = input.value.trim().slice(0, 40);
                    input.replaceWith(titleEl);
                    if (!submit || !next || next === original) return; // Escape/空值/未变更：还原不发送
                    const ack = await commandAck("COMMAND_RENAME", { session_id: session.session_id, title: next });
                    const v = ackVerdict(ack);
                    if (v.ok) {
                      session.title = next;
                      session.title_locked = true;
                      renderMyList();
                      b2Toast("已重命名");
                    } else b2Toast(v.error);
                  };
                  input.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") { e.preventDefault(); commit(true); }
                    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
                    e.stopPropagation(); // 不外泄给全局快捷键
                  });
                  input.addEventListener("blur", () => commit(true));
                }
                async function copyWithFallback(t, okMsg) { // #169 追加令2：copySessionId 兜底链抽公共——clipboard → textarea execCommand → 手动复制提示
                  try { await navigator.clipboard.writeText(t); b2Toast(okMsg); return true; }
                  catch { // 剪贴板 API 不可用（非安全上下文等）：textarea 兜底
                    const ta = document.createElement("textarea");
                    ta.value = t;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    let ok = false;
                    try { ok = document.execCommand("copy"); } catch { ok = false; }
                    ta.remove();
                    b2Toast(ok ? okMsg : "复制失败，请手动复制：" + t);
                    return ok;
                  }
                }
                async function copySessionId(sid) { return copyWithFallback(sid, "会话 ID 已复制"); }
                window.__ccDeck005CopyUi = { copyWithFallback }; // 跨 IIFE 共享（手机「更多」复制钮同链，同 __ccDeck005PathUi 口径）
                // 件五补（2026-10-10 用户补充意见）：置顶 toggle 提取共用——右键菜单 pin 项与
                // 行尾图钉微钮同链（COMMAND_PIN_SESSION + 乐观归位 + toast），零重复。
                // 翻转用发送时的意图值而非二次推导：relay 先 emit UPDATED 再回 ACK（:2785→:2792
                // 顺序保证），ack 处理时回显常已把 s.pinned 写成新值，基线原 `s.pinned !== true`
                // 再取反会读新值翻反（点「置顶」显示成取消——E2E 实锤的基线竞态，提取时修掉）
                async function doPinToggle(s) {
                  const next = s.pinned !== true;
                  const ack = await commandAck("COMMAND_PIN_SESSION", { session_id: s.session_id, pinned: next });
                  const v = ackVerdict(ack);
                  if (v.ok) {
                    s.pinned = next; // 与 UPDATED 回显同值幂等；回显未到则乐观归位防双帧间隙
                    renderMyList();
                    b2Toast(next ? "已置顶 · 排列表最顶" : "已取消置顶");
                  } else b2Toast(v.error);
                }
                // 件五补：删除确认浮层（row-menu 同壳浮层）——hover × 与右键菜单「删除」同走，
                // 不可裸删（任务书口径；菜单项曾裸删，一并收进确认）
                function openDeleteConfirm(card, s) {
                  closeRowMenu();
                  document.getElementById("row-del-confirm")?.remove();
                  const rect = card.getBoundingClientRect();
                  const pop = document.createElement("div");
                  pop.className = "row-menu";
                  pop.id = "row-del-confirm";
                  pop.setAttribute("role", "alertdialog");
                  pop.setAttribute("aria-label", "确认删除会话");
                  pop.innerHTML = '<div class="row-del-tip">删除会话「' + esc(String(s.title || s.session_id).slice(0, 18)) + '」？</div>'
                    + '<div class="row-del-actions"><button type="button" data-del-cancel>取消</button><button type="button" class="danger" data-del-ok>删除</button></div>';
                  pop.addEventListener("click", async (ev) => {
                    if (ev.target.closest("[data-del-cancel]")) { pop.remove(); return; }
                    if (!ev.target.closest("[data-del-ok]")) return;
                    pop.remove();
                    if (s.status === "WORKING" || s.status === "WAITING") { b2Toast("会话运行中，不能删除"); return; } // 前端预拦，relay 同规则
                    const ack = await commandAck("COMMAND_DELETE", { session_id: s.session_id });
                    const v = ackVerdict(ack);
                    if (v.ok) {
                      S.sessions.delete(s.session_id);
                      if (S.selected === s.session_id) S.selected = "";
                      renderMyList();
                      b2Toast("会话已删除");
                    } else b2Toast(v.error);
                  });
                  document.body.appendChild(pop);
                  const pr = pop.getBoundingClientRect();
                  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pr.width - 8)) + "px";
                  pop.style.top = Math.max(8, rect.top - pr.height - 6) + "px";
                  const dismiss = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("pointerdown", dismiss, true); } };
                  document.addEventListener("pointerdown", dismiss, true);
                }
                function setupRowMenu() {
                  if (!UI || !UI.sessionList || UI.sessionList.dataset.rowMenuBound) return;
                  UI.sessionList.dataset.rowMenuBound = "1";
                  // 件五（2026-10-10 test.10 反馈）：行尾「⋯」微钮点击等效右键——CDP 实测右键菜单
                  // 功能正常（绑定/卡片属性/弹出全通），用户反馈实为可发现性问题；派发 contextmenu
                  // 复用下方整套菜单构建/定位/项状态逻辑（零重复）。stopImmediatePropagation 防止
                  // 微钮点击同时走卡片选中链（同容器委托的前后注册顺序，immediate 才拦得住）。
                  // 件五补：行尾三钮各走各链——⋯=菜单、图钉=doPinToggle、×=openDeleteConfirm
                  UI.sessionList.addEventListener("click", (e) => {
                    const more = e.target.closest(".srow-more");
                    const pinBtn = e.target.closest(".srow-pin");
                    const closeBtn = e.target.closest(".srow-close");
                    if (!more && !pinBtn && !closeBtn) return;
                    e.stopImmediatePropagation();
                    const card = (more || pinBtn || closeBtn).closest("[data-session-card]");
                    if (!card) return;
                    const s = S.sessions.get(card.getAttribute("data-session-card"));
                    if (!s) return;
                    if (pinBtn) { doPinToggle(s); return; }
                    if (closeBtn) { openDeleteConfirm(card, s); return; }
                    const r = more.getBoundingClientRect();
                    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(r.left), clientY: Math.round(r.bottom + 2) }));
                  });
                  // 件五补：标题双击进行内编辑（startRowRename 既有链：Enter 确认/Esc 取消/
                  // COMMAND_RENAME→title-overrides.json 落盘）。relay RENAME 对 historical/ext
                  // 均放行（:2592 仅拦空题），与菜单「重命名」放开口径一致，双击不另设只读闸
                  UI.sessionList.addEventListener("dblclick", (e) => {
                    const strong = e.target.closest(".srow-r1 strong");
                    if (!strong) return;
                    const card = strong.closest("[data-session-card]");
                    const s = card && S.sessions.get(card.getAttribute("data-session-card"));
                    if (!s) return;
                    e.preventDefault();
                    startRowRename(card, s);
                  });
                  // 关闭五路：Escape / 外部 pointerdown（capture）/ 滚动（capture）/ 窗口失焦 / 尺寸变化
                  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRowMenu(); }, true);
                  document.addEventListener("pointerdown", (e) => { if (rowMenu && !rowMenu.contains(e.target)) closeRowMenu(); }, true);
                  window.addEventListener("scroll", closeRowMenu, true);
                  window.addEventListener("blur", closeRowMenu);
                  window.addEventListener("resize", closeRowMenu);
                  UI.sessionList.addEventListener("contextmenu", (e) => {
                    const card = e.target.closest("[data-session-card]");
                    if (!card) return;
                    e.preventDefault();
                    const sid = card.getAttribute("data-session-card");
                    const session = S.sessions.get(sid);
                    if (!session) return;
                    closeRowMenu();
                    const writable = canCmd(session); // 历史托管会话只读：命令项置灰（relay 侧亦拦，双保险）
                    const running = session.status === "WORKING" || session.status === "WAITING";
                    rowMenu = document.createElement("div");
                    rowMenu.className = "row-menu";
                    rowMenu.setAttribute("role", "menu");
                    rowMenu.dataset.targetCard = sid;
                    rowMenu.innerHTML =
                      // UIPOLISH3 件一（2026-10-11 用户拍板）：置顶全量解锁——原「ext 不渲染置顶项」
                      // 与 relay ext 拦截同批退役（置顶是纯列表整理：pinned 标记+文件写穿，与托管/
                      // 外部无关，无技术理由禁止）；行尾图钉微钮本就恒渲染（doPinToggle 直发命令），
                      // 菜单项从此与微钮同口径。pin/rename 对历史托管会话也恒可点：relay 只拦 ext
                      // 不拦 historical——置顶是列表整理（#49 写穿清单）、改名落 title-overrides.json
                      // 权威覆盖回放，canCmd 的只读置灰对两者过度收紧（historical 会话曾因此点不动
                      // ——E2E 实锤），与行尾图钉/双击改名入口同口径
                      '<button type="button" role="menuitem" data-row-action="pin">' + (session.pinned ? "取消置顶" : "置顶") + "</button>"
                      + '<button type="button" role="menuitem" data-row-action="rename">重命名</button>'
                      + '<button type="button" role="menuitem" data-row-action="copyid">复制 ID</button>'
                      + '<button type="button" role="menuitem" class="danger" data-row-action="del">删除</button>';
                    rowMenu.addEventListener("click", async (ev) => {
                      const btn = ev.target.closest("button[data-row-action]");
                      if (!btn) return;
                      const id = rowMenu.dataset.targetCard;
                      const s = S.sessions.get(id);
                      closeRowMenu();
                      if (!s) return;
                      const action = btn.dataset.rowAction;
                      if (action === "pin") {
                        await doPinToggle(s); // 件五补：与行尾图钉同链
                      } else if (action === "rename") {
                        const target = UI.sessionList.querySelector('[data-session-card="' + cssEsc(s.session_id) + '"]');
                        if (target) startRowRename(target, s);
                      } else if (action === "copyid") {
                        copySessionId(s.session_id);
                      } else if (action === "del") {
                        openDeleteConfirm(card, s); // 件五补：确认浮层统一（不可裸删，与 hover × 同链）
                      }
                    });
                    document.body.appendChild(rowMenu);
                    const rect = rowMenu.getBoundingClientRect();
                    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
                    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
                    rowMenu.style.left = Math.max(8, x) + "px";
                    rowMenu.style.top = Math.max(8, y) + "px";
                  });
                }

                // ---------- UIPOLISH2 件四：head mini 水位胶囊（2026-10-11 用户拍板放详情 head）----------
                // 数据源 SNAPSHOT context_usage/context_limit（EXPP1 B1 修正过 1M 口径）；分档阈值与
                // ctxMeterHtml 同源（85/60 → critical/attention/safe）；胶囊色态 token 与水位计同源。
                // 点击跳「更多」tab 水位计（ready 处绑定，jumpToTask 的 tabs.click 同款链）
                function updateCtxMeter(s) {
                  const el = UI && UI.ctxMeter;
                  if (!el) return;
                  const used = Number(s && s.context_usage) || 0;
                  if (!used) { el.hidden = true; return; } // 无数据不渲染（memberCtxMeter/dock token 同口径）
                  const lim = Number(s && s.context_limit) || 1e6;
                  const pct = Math.min(100, Math.round((used / lim) * 100));
                  const grade = pct >= 85 ? "critical" : pct >= 60 ? "attention" : "safe";
                  el.hidden = false;
                  el.className = "head-capsule head-ctx-meter " + grade;
                  const pctEl = el.querySelector("[data-ctx-mini-pct]");
                  if (pctEl) pctEl.textContent = pct + "%";
                  const onCount = Math.round((pct / 100) * 12);
                  el.querySelectorAll(".ctx-mini-band i").forEach((seg, i) => seg.classList.toggle("on", i < onCount));
                  el.title = "上下文已用 " + tokStr(used) + " / " + tokStr(lim) + " · " + { safe: "安全", attention: "注意", critical: "拥挤" }[grade] + " · 点击查看水位计";
                }
                // ---------- 渲染：头部 / dock / 检查器 ----------
                function curSession() { return S.selected ? (S.sessions.get(S.selected) || null) : null; }
                // #247 W-READONLY-KILL（用户铁口径 2026-10-24）：「历史会话只读」整体退役——
                // 所有会话一律可操作（发送即自动 resume/注入：managed 走 COMMAND_MESSAGE
                // →resumeAgent 拉起，external 走 COMMAND_EXT_INPUT →tmux 注入）。旧式
                // (!s.historical || s.external===true) 组合态把重启误标的用户本机活跃终端
                // 会话锁成只读（rea/修图两会话三次实锤），relay 侧收编也不再降级 historical
                function canCmd(s) { return !!s; }
                function renderHeader() {
                  const s = curSession();
                  const srcName = (n) => (window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(n) : String(n || ""));
                  if (!s) {
                    UI.title.textContent = "会话";
                    // W-TOPBAR ③（合并裁决保留）：head 身份收敛——数据源身份只在顶栏源胶囊；
                    // statusTag 引用随元素退役（W-UIFB ③）一并删除
                    UI.identity.innerHTML = "";
                    // 件八（2026-10-10）：不再置 null——胶囊已静态落 composer（ready 一次取定），
                    // 此处置 null 会永久断引用（updateModelCapsule 读 null 恒 return → 胶囊恒
                    // hidden，用户实测「模型切换缺失」根因）；无会话时 updateModelCapsule(null)
                    // 走 ok=false → hidden=true 的正常隐藏路径
                    UI.subHint(!WS_BASE && !desktopForm() ? "请通过 relay 同源 HTTP 页面连接" : (!tokenLive() && !cloudLaneOn()) ? (desktopForm() ? "正在连接本机 relay…" : "请通过带 ?token= 的 relay 链接连接") : S.hasSnapshot ? "从左侧选择一个会话" : "等待 relay 连接…");
                    updateModelCapsule(null);
                    updatePermCapsule(null); // UIPOLISH3 件三：无会话权限胶囊隐藏
                    updateCtxMeter(null); // UIPOLISH2 件四：无会话水位胶囊隐藏
                    return;
                  }
                  UI.title.textContent = s.title || s.initial_prompt || s.session_id;
                  // W-UIFB ③：「运行中」状态胶囊退役（i=3）——会话态由 dock 态图标单点表达（B21 语义，
                  // B13 DONE 隐藏口径的全量版）；外部会话仍标「CLI」（用户语言：本机 CLI 里开的会话）
                  // W-MOBLIST 双端同链：engine 缺失按 model 子串推断（PM/外部会话 engine 空=
                  // 「?」/错挂 Claude 根因；expo 镜像=src/engine-infer.ts，改链两处同步）
                  const effEngine = inferEngineOf(s) || "claude"; // W-ENGLM D：推断链共享化（原内联 MODEL_HINTS 退役）
                  const eng = engineMetaOf(s);
                  // W-TOPBAR ③ head 身份收敛：只剩 engine 徽章一颗；数据源归顶栏源胶囊、外部会话
                  // 「CLI」标从独立 tag 降为徽章内文字后缀（身份类三胶囊 → 一颗）。
                  // W-UIFB ③（合并裁决）：徽章加 sprite 图标（b2EngineIconFor，与第二列同款）；
                  // 模型胶囊维持 W-TOPBAR ③ 静态落 composer 位（U5 验收 pass 形态），不随 renderHeader 重建
                  // #239 W-DETAILAVATAR：徽章图标改接 ENGINE_BRAND_SVG 品牌源（列表卡 srow-ava
                  // 同源，claude=像素螃蟹七引擎同表）；未知引擎 PH 字母占位兜底（engineBrandSvgOf
                  // 内建），sprite 形态保留为结构回落——尺寸/圆角走 .badge-brand 约束跟随现行徽章
                  const brandIconHtml = engineBrandSvgOf({ engineClass: eng[1], engine: s.engine || "claude" });
                  // W-TEAMSNC ③：详情 head identity-cluster 团队 chip——置于引擎徽章前（团队归属>引擎
                  // 阅读序，B 稿态 B）；pmTeamChipOf 单口同源（命中才渲染，null 不占位），点击同卡上
                  // chip 开/收第四列抽屉（data-team-chip 同链同委托）
                  const headTeams = pmTeamChipOf(s.session_id);
                  UI.identity.innerHTML = (headTeams.length ? headTeams.map(teamChipMarkup).join("") : "")
                    + '<span class="engine-badge ' + eng[1] + '">' + (brandIconHtml
                    ? '<span class="badge-brand">' + brandIconHtml + "</span>"
                    : '<svg class="engine-icon" aria-hidden="true"><use href="#icon-' + b2EngineIconFor(eng[1]) + '"></use></svg>') + esc(eng[0]) + (s.external ? " · CLI" : "") + "</span>";
                  // 件十六：信息行序=工作目录→水位胶囊→活跃时间（胶囊居中夹段，updateCtxMeter 填充）
                  {
                    const el = UI.subDirEl && UI.subDirEl.isConnected ? UI.subDirEl : ($id("session-head-sub") || null);
                    const dir = el && el.querySelector("[data-sub-dir]");
                    const time = el && el.querySelector("[data-sub-time]");
                    if (dir) dir.textContent = s.cwd ? shortPath(s.cwd) : "";
                    if (time) time.textContent = s.cwd ? "活跃 " + relTime(s.updated_at || s.started_at) : "最近活动 " + relTime(s.updated_at || s.started_at);
                  }
                  updateModelCapsule(s);
                  updatePermCapsule(s); // UIPOLISH3 件三：随 head 同步权限胶囊（态回显主路径）
                  updateCtxMeter(s); // UIPOLISH2 件四：随 head 同步水位（renderAll 全量链 + SESSION_HEARTBEAT 也会进这里）
                }
                // ---------- B22 模型切换胶囊（engine-badge 旁）→ source-menu 同壳列表 → COMMAND_MODEL ----------
                // relay #388：托管 Claude/外部会话注入 /model 下一回合生效；codex 等他引擎拒绝（配置文件制）
                function capsuleModelsFor(s) {
                  return createModelsFor(s && s.external ? "claude" : (s && s.engine) || "claude"); // 模型源与 B10 弹窗同源
                }
                function capsuleSupported(s) {
                  if (!s || !canCmd(s)) return false;
                  if (s.external) return true; // 外部会话走 EXT_INPUT /model，relay 支持且无引擎限制判定
                  return !s.engine || s.engine === "claude";
                }
                function updateModelCapsule(s) {
                  const cap = UI.modelCapsule;
                  if (!cap) return;
                  const ok = capsuleSupported(s);
                  cap.hidden = !ok;
                  if (!ok) return;
                  const txt = cap.querySelector("[data-capsule-text]");
                  if (txt) txt.textContent = s.model ? String(s.model).split(/[/:]/).pop() : "默认模型";
                  cap.title = s.model ? "当前模型 " + s.model + " · 点击切换" : "使用引擎默认模型 · 点击切换";
                }
                function openModelMenu(anchor) {
                  closeModelMenu();
                  const s = curSession();
                  if (!anchor || !s || !capsuleSupported(s)) return;
                  const menu = document.createElement("div");
                  menu.id = "b2-model-menu";
                  menu.className = "model-menu"; // 与 source-menu 同壳样式（独立类，防被 .source-menu.open 全局收起误伤）
                  menu.setAttribute("role", "menu");
                  const cur = s.model || "";
                  const models = capsuleModelsFor(s);
                  let html = '<div class="source-menu-head">切换模型 · 下一回合生效</div>';
                  if (!models.length) html += '<div class="source-menu-head" style="text-transform:none;letter-spacing:0">未收到模型列表，可直接输入模型名</div>';
                  for (const m of models) {
                    html += '<button type="button" class="source-option' + (m === cur ? " active" : "") + '" data-model-pick="' + esc(m) + '" role="menuitem"><strong>' + esc(m) + "</strong>" + (m === cur ? "<small>当前</small>" : "") + "</button>";
                  }
                  html += '<div class="model-menu-custom"><input class="create-field" data-model-input placeholder="自定义模型名…" aria-label="自定义模型名" style="height:28px"><button class="create-browse" type="button" data-model-apply>应用</button></div>';
                  menu.innerHTML = html;
                  document.body.appendChild(menu);
                  const r = anchor.getBoundingClientRect();
                  menu.classList.add("open");
                  const mw = menu.offsetWidth, mh = menu.offsetHeight;
                  menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + "px";
                  menu.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - mh - 8)) + "px";
                  const input = menu.querySelector("[data-model-input]");
                  if (input && !models.length) input.focus();
                  menu.addEventListener("click", (ev) => {
                    const pick = ev.target.closest("[data-model-pick]");
                    if (pick) { applyModelSwitch(pick.dataset.modelPick); return; }
                    if (ev.target.closest("[data-model-apply]")) {
                      const v = input ? input.value.trim() : "";
                      if (v) applyModelSwitch(v);
                      else b2Toast("请输入模型名");
                    }
                  });
                  menu.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter" && ev.target === input) { ev.preventDefault(); const v = input.value.trim(); if (v) applyModelSwitch(v); }
                  });
                }
                function closeModelMenu() { const m = document.getElementById("b2-model-menu"); if (m) m.remove(); }
                // ---------- UIPOLISH3 件三（#67）：权限模式切换胶囊（head actions）→ COMMAND_PERM ----------
                // relay 词表四档（isManagedMode）：任务书写三档、词表以 relay 为准（#217：跳过档只能
                // 创建会话时开，运行时切 bypass SDK 拒——错误人话回显会话日志，ack 先行受理）。措辞
                // 与 relay PERM_MODE_ZH 逐字对齐。外部/CLI 会话 relay 硬拒（hooks 单向桥接）→ 胶囊
                // 置灰+tooltip 说明不硬闯；历史/无命令通道卡隐藏（模型胶囊同口径）。
                const PERM_MODES = [
                  /* #201④：照 Claude Code 原版权限菜单英文条目（弃中文模式名——用户拍板
                  原版化；zh 键名保留=PERM_MODE_ZH/胶囊 title 消费面零动） */
                  { key: "default", zh: "Ask before edits" },
                  { key: "acceptEdits", zh: "Accept edits" },
                  { key: "plan", zh: "Plan mode" },
                  { key: "bypassPermissions", zh: "Bypass permissions" },
                ];
                // #195 件五：远程审批开关随 WorkBuddy 化退役（head 胶囊+COMMAND_EXT_MODE 入口移除；
                // relay 命令面不动）。perm 胶囊已迁输入框左下角（件一），updatePermCapsule 保留 id 接线。
                function updatePermCapsule(s) {
                  const cap = UI.permCapsule;
                  if (!cap) return;
                  if (!s || !canCmd(s)) { cap.hidden = true; return; } // 无会话/历史只读卡：隐藏
                  const txt = cap.querySelector("[data-perm-text]");
                  if (s.external) {
                    // W-UIPOLISH4 件四（2026-10-12 用户实测「还是缺失」复核）：考古 2aeb130 ∈
                    // test.16+——按钮一直在包里，真因是外部/CLI 会话被整体隐藏（relay 硬拒运行时
                    // 切换 + 件十六c 去重拍板收走了置灰胶囊），而用户实测看的恰是 CLI 会话。入口
                    // 显性化：外部会话显示只读胶囊——当前模式回显（bridge.ts 会上报 external 的
                    // permission_mode，有真数据），点击人话说明，不开菜单不硬闯。件十六c 删除的是
                    // 「CLI 会话」身份置灰胶囊（与 engine 徽章重复），本胶囊是权限信息，不冲突。
                    cap.hidden = false;
                    cap.disabled = false;
                    const curX = s.permission_mode || "default";
                    const modeX = PERM_MODES.find((m) => m.key === curX);
                    if (txt) txt.textContent = modeX ? modeX.zh : curX;
                    cap.title = "CLI 会话的权限模式由本机 CLI 启动参数决定，不能从这里切换（点击查看说明）";
                    cap.dataset.permReadonly = "1";
                    return;
                  }
                  cap.hidden = false;
                  cap.disabled = false;
                  const cur = s.permission_mode || "default";
                  const mode = PERM_MODES.find((m) => m.key === cur);
                  if (txt) txt.textContent = mode ? mode.zh : cur;
                  cap.title = "当前权限模式：" + (mode ? mode.zh : cur) + " · 点击切换";
                  delete cap.dataset.permReadonly; // 件四：托管会话可切换，清只读态
                }
                function closePermMenu() { const m = document.getElementById("b2-perm-menu"); if (m) m.remove(); }
                function openPermMenu(anchor) {
                  closePermMenu();
                  const s = curSession();
                  if (!anchor || !s || !canCmd(s)) return;
                  if (s.external) { b2Toast("CLI 会话的权限模式在本机 CLI 里定（启动参数），这里不能切换"); return; } // W-UIPOLISH4 件四：只读胶囊点击给反馈，不静默
                  const menu = document.createElement("div");
                  menu.id = "b2-perm-menu";
                  menu.className = "model-menu"; // 与模型菜单同壳样式（独立 id 防互误伤）
                  menu.setAttribute("role", "menu");
                  const cur = s.permission_mode || "default";
                  let html = '<div class="source-menu-head">权限模式 · 切换即生效</div>';
                  for (const m of PERM_MODES) {
                    html += '<button type="button" class="source-option' + (m.key === cur ? " active" : "") + '" data-perm-pick="' + m.key + '" role="menuitem"><strong>' + m.zh + "</strong>" + (m.key === cur ? "<small>当前</small>" : "") + "</button>";
                  }
                  menu.innerHTML = html;
                  document.body.appendChild(menu);
                  const r = anchor.getBoundingClientRect();
                  menu.classList.add("open");
                  const mw = menu.offsetWidth, mh = menu.offsetHeight;
                  menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + "px";
                  menu.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - mh - 8)) + "px";
                  menu.addEventListener("click", async (ev) => {
                    const pick = ev.target.closest("[data-perm-pick]");
                    if (!pick) return;
                    closePermMenu();
                    const s2 = curSession();
                    if (!s2 || pick.dataset.permPick === (s2.permission_mode || "default")) return;
                    const ack = await commandAck("COMMAND_PERM", { session_id: s2.session_id, mode: pick.dataset.permPick });
                    const v = ackVerdict(ack);
                    if (v.ok) {
                      s2.permission_mode = pick.dataset.permPick; // 乐观回显；UPDATED 帧权威归位（SDK 异步失败仅落会话日志=relay 现行为）
                      renderHeader();
                      const zh = (PERM_MODES.find((m) => m.key === pick.dataset.permPick) || {}).zh || pick.dataset.permPick;
                      b2Toast("权限模式已切换：" + zh);
                    } else b2Toast("切换失败：" + v.error);
                  });
                }
                async function applyModelSwitch(model) {
                  const s = curSession();
                  if (!s || !capsuleSupported(s)) return;
                  closeModelMenu();
                  const ack = await commandAck("COMMAND_MODEL", { session_id: s.session_id, model });
                  const v = ackVerdict(ack);
                  if (v.ok) {
                    s.model = model; // 乐观回显；relay 已置 state.model，后续 UPDATED 帧权威归位
                    renderHeader();
                    b2Toast("已切换 · 下一回合生效"); // 新模型名由胶囊乐观回显，不重复播报
                  } else b2Toast("切换失败：" + v.error);
                }
                function renderDock() {
                  const dock = UI.dock;
                  if (!dock) return;
                  const s = curSession();
                  const op = dock.querySelector("[data-session-state-operation]");
                  const tok = dock.querySelector("[data-session-state-tokens]");
                  if (!s) {
                    dock.dataset.sessionState = "waiting";
                    op.textContent = "未选择";
                    dock.querySelector("[data-session-state-elapsed]").textContent = "";
                    if (tok) tok.hidden = true;
                    dockTerminalWatch(dock, null);
                    renderSubagents(null); // W-UIFB ⑧（自 TOPBAR 批移植+修正版）无会话撤面板
                    return;
                  }
                  // B21 一行流式：态图标（旋转/呼吸/✓/⚠，CSS 按 data-session-state 承载）+ 摘要 + 走秒 + token
                  const state = DOCK_STATE[s.status] || "closing";
                  dock.dataset.sessionState = state;
                  const live = dockLiveLine(s); // A0-1：终端实时行（relay ​ 零宽前缀约定）→ 隐藏自家走秒/token 防双计
                  if (live) dock.setAttribute("data-live-line", ""); else dock.removeAttribute("data-live-line");
                  const w = s.waiting_request;
                  // #224 两层信息架构（WORKING）：标题行=✻ {任务名}（时长/↓累计输出由
                  // tickDockElapsed 每秒续写 elapsed 段）；动作行=次行 ⚙ Running {命令} ·
                  // {回合走秒}（mono dim，title hover 全量）。命令动作从主行让位次行
                  let subEl = dock.querySelector("[data-dock-sub]");
                  if (s.status === "WORKING" && !live) {
                    op.textContent = s.title || "未命名任务";
                    if (tok) tok.hidden = true;
                    const act = String(s.action_summary || "").replace(/^\u200B+/, "");
                    if (!subEl) {
                      subEl = document.createElement("div");
                      subEl.setAttribute("data-dock-sub", "");
                      dock.appendChild(subEl);
                    }
                    subEl.dataset.act = act;
                    subEl.dataset.turnStarted = String(s.turn_started_at || s.updated_at || Date.now());
                    subEl.textContent = act ? "⚙ Running " + act.slice(0, 110) : "";
                    subEl.title = act; // 点按/hover 展开全量（单行截断不折叠）
                  } else {
                    if (subEl) subEl.remove();
                    const opText = w ? [w.tool_name, w.input_summary].filter(Boolean).join(" · ") : (s.action_summary || s.last_error || "");
                    op.textContent = opText ? String(opText).replace(/^\u200B+/, "").slice(0, 90) : "";
                    if (tok) { const u = Number(s.context_usage) || 0; tok.hidden = live || !u; tok.textContent = u ? tokStr(u) + "/" + tokStr(s.context_limit || 1e6) : ""; } // A0-1 token 内联「34k/200k」
                  }
                  tickDockElapsed();
                  dockTerminalWatch(dock, s);
                  renderSubagents(s); // W-UIFB ⑧ 子 Agent 活性面板（状态栏下续行）
                }
                // W-UIFB ⑧：子 Agent 活性面板（W-TOPBAR ⑥ test.8 同构移植 + i=10 修正入形）——
                // 防御同旧壳：ended_at>0 才算结束（ended_at:0 falsy 坑）；>4 条溢出提示；
                // 折叠态模块级记忆（renderDock 高频重建不丢态）
                let agCollapsed = false;
                function renderSubagents(s) {
                  const box = document.getElementById("session-agbox");
                  if (!box) return;
                  const subs = s && Array.isArray(s.subagents) ? s.subagents : [];
                  if (!subs.length) { box.hidden = true; box.textContent = ""; return; }
                  box.hidden = false;
                  const shown = subs.slice(-4);
                  const more = subs.length - shown.length;
                  box.innerHTML = '<span class="aghead" data-ag-toggle role="button" tabindex="0">subAgent ' + subs.length + ' <span class="caret">' + (agCollapsed ? "▸" : "▾") + "</span></span>" +
                    (agCollapsed ? "" : shown.map((a) => {
                      const run = !(a.ended_at > 0);
                      const dur = a.started_at > 0 ? fmtDur(Math.max(0, (a.ended_at > 0 ? a.ended_at : Date.now()) - a.started_at)) : "";
                      return '<div class="agrow' + (run ? "" : " done") + '">' + (run ? '<i class="agdot"></i>' : '<span class="ag-done-mark">✓</span>') +
                        '<span class="ad">' + esc(a.desc || a.kind || "子任务") + "</span>" +
                        (a.act && run ? '<span class="aa" title="当前动作">' + esc(a.act) + "</span>" : "") +
                        '<span class="at" data-ag-at data-started="' + (a.started_at || 0) + '" data-ended="' + (a.ended_at || 0) + '">' + dur + "</span></div>";
                    }).join("") + (more > 0 ? '<div class="agmore">… 更早 ' + more + " 条已收起</div>" : ""));
                }
                function toggleSubagents() { agCollapsed = !agCollapsed; renderSubagents(curSession()); }
                function dockLiveLine(s) { return !!s && s.status === "WORKING" && String(s.action_summary || "").startsWith("\u200B"); }
                // B#133 终态收口：DONE ✓ 停留 8s 后整条淡出收起（高度+透明动画）；ERROR ⚠ 常驻不收。
                // 键 = sid+status：同一终态的后续心跳/重渲不重启计时、不闪复原。
                let dockTermKey = "";
                let dockTermT = 0;
                function dockTerminalWatch(dock, s) {
                  const key = s ? s.session_id + ":" + s.status : "";
                  if (key === dockTermKey) return;
                  dockTermKey = key;
                  clearTimeout(dockTermT);
                  dock.classList.remove("terminal-fade");
                  if (s && s.status === "DONE") dockTermT = setTimeout(() => dock.classList.add("terminal-fade"), 8000);
                }
                function tickDockElapsed() {
                  // W-UIFB ⑧：子 Agent 面板走秒随 1s 心跳刷新（只改 .at 文本不重建面板；
                  // 置于 dock 早退之前——live-line/无会话态面板计时不冻结）
                  document.querySelectorAll("#session-agbox [data-ag-at]").forEach((at) => {
                    const st = Number(at.dataset.started) || 0, ed = Number(at.dataset.ended) || 0;
                    if (st > 0) at.textContent = fmtDur(Math.max(0, (ed > 0 ? ed : Date.now()) - st));
                  });
                  if (!UI || !UI.dock) return;
                  const el = UI.dock.querySelector("[data-session-state-elapsed]");
                  const s = curSession();
                  if (!el) return;
                  if (!s || UI.dock.hasAttribute("data-live-line")) { el.textContent = ""; return; }
                  if (s.status === "DONE" && s.duration_ms) { el.textContent = fmtDur(s.duration_ms); return; }
                  // #224 WORKING：标题行尾=（任务时长 · ↓累计输出）——任务级时长=会话级
                  // started_at 起跨回合累计（CLI 同语义），↓=usage.output_tokens（会话累计
                  // 输出，统计页同源）；同时续写动作行（次行）的回合走秒
                  if (s.status === "WORKING") {
                    const dur = fmtTaskDur(Math.max(0, Date.now() - Number(s.started_at || Date.now())) / 1000);
                    const out = s.usage && Number(s.usage.output_tokens) > 0 ? " · ↓" + fmtDownTok(Number(s.usage.output_tokens)) : "";
                    el.textContent = "(" + dur + out + ")";
                    const subEl = UI.dock.querySelector("[data-dock-sub]");
                    if (subEl && subEl.dataset.act) {
                      const runSec = Math.max(0, Math.floor((Date.now() - Number(subEl.dataset.turnStarted || Date.now())) / 1000));
                      subEl.textContent = "⚙ Running " + String(subEl.dataset.act).slice(0, 110) + " · " + runSec + "s";
                    }
                    return;
                  }
                  const base = s.waiting_started_at || s.updated_at || s.started_at;
                  el.textContent = base ? fmtDur(Math.max(0, Date.now() - base)) : "";
                  // W-TOPBAR ⑥：子 Agent 面板走秒随 1s 心跳刷新（只改 .at 文本，不重建面板）
                  document.querySelectorAll("#session-agbox [data-ag-at]").forEach((at) => {
                    const st = Number(at.dataset.started) || 0, ed = Number(at.dataset.ended) || 0;
                    if (st > 0) at.textContent = fmtDur(Math.max(0, (ed > 0 ? ed : Date.now()) - st));
                  });
                }
                function ctxMeterHtml(s) {
                  const pct = ctxPct(s);
                  const grade = pct >= 85 ? "critical" : pct >= 60 ? "attention" : "safe";
                  const gradeLabel = { safe: "安全", attention: "注意", critical: "拥挤" }[grade];
                  const lim = s.context_limit || 1e6;
                  const onCount = Math.round((pct / 100) * 12);
                  const eng = engineMetaOf(s); // W-ENGLM D/E：共享解析（glm 入表；未收录显示原名不错显 Claude）
                  const modelShort = s.model ? String(s.model).split(/[/:]/).pop() : tokStr(lim) + " 上限";
                  const note = { safe: "余量充足，可继续当前任务", attention: "上下文偏高，留意即将压缩", critical: "上下文接近上限，建议收口或压缩" }[grade];
                  return '<div class="context-meter ' + grade + '"><div class="context-meter-head"><div><span class="context-meter-kicker">Context window</span><strong class="context-meter-model">' + esc(eng[0] + " · " + modelShort) + '</strong></div><span class="context-meter-grade">' + gradeLabel + '</span></div><div class="context-meter-band" aria-label="上下文已使用 ' + pct + '%">' + Array.from({ length: 12 }, (_, i) => "<i" + (i < onCount ? ' class="on"' : "") + "></i>").join("") + '</div><div class="context-meter-stats"><span><b class="context-meter-used">' + tokStr(s.context_usage) + '</b> <span class="context-meter-limit">/ ' + tokStr(lim) + ' tokens</span></span><strong class="context-meter-pct">' + pct + '%</strong></div><div class="context-meter-note">' + note + '</div></div>';
                }
                function renderInspector() {
                  const s = curSession();
                  let html = "<h3>证据检查器</h3>";
                  if (!s) {
                    html += '<div class="readonly-banner">从左侧选择会话查看证据</div>';
                  } else {
                    const todos = Array.isArray(s.todos) ? s.todos.filter(Boolean) : [];
                    const done = todos.filter((t) => t.status === "completed").length;
                    const open = todos.filter((t) => t.status !== "completed").slice(0, 4);
                    const eng = engineMetaOf(s); // W-ENGLM D/E：共享解析（glm 入表；未收录显示原名不错显 Claude）
                    const st = STATUS_TAG[s.status] || ["完成", "done"];
                    const inspSrc = String(s.relay_source || S.relayName || ""); // t25fix #5：详情面板源徽章（单源模式 CSS 隐藏）
                    // W-DRAWMERGE（用户 1025 补充定稿）：PM 会话检查器瘦身——用量/输出物两块
                    // 在他 tab 已有（详情 tab/输出物看板），PM 检查器聚焦团队内容（团队成员块+
                    // 任务清单保留；审批/确认区本就在对话流 wait-banner 非本面板）。分支判据=
                    // pmTeamChipOf 词表单口命中（与 chip/头像角色蟹同源）；非 PM 检查器零变化
                    const pmInspectorFocus = pmTeamChipOf(s.session_id).length > 0;
                    html += '<div class="inspector-block"><div class="inspector-title"><span>会话</span><span class="tag ' + st[1] + '">' + st[0] + '</span></div><div class="inspector-copy">' + esc(shortTitle(s)) + "<br>" + esc(eng[0] + (s.model ? " · " + s.model : "")) + (inspSrc ? '<br><span class="source-badge insp-src">' + esc(inspSrc) + "</span>" : "") + "<br>" + esc(shortPath(s.cwd || "")) + '</div></div>';
                    // [t-7e0c6189] 团队成员块：选中会话属于某编制时，成员胶囊行（点头像=直开）+ 展开第四列
                    const slimMem = slimRosterOf(S.projects).bySid.get(s.session_id);
                    if (slimMem) {
                      const slimTeamObj = slimRosterOf(S.projects).teams.get(slimMem.gid);
                      const unreadSet = S.slimUnread.get(slimMem.gid);
                      if (slimTeamObj) {
                        const chips = slimTeamObj.members.map((m) => {
                          const ms = S.sessions.get(m.session_id);
                          if (!ms) return ""; // 编制在、会话未同步：不出胶囊
                          const mst = ({ WORKING: "working", WAITING: "waiting", ERROR: "error", DONE: "done" })[ms.status] || "done";
                          const badge = SLIM_KEEP_ROLE.test(String(m.role || "")) ? "✦" : /^(qa|reviewer|验收)$/i.test(String(m.role || "")) ? "QA" : "W";
                          const unread = unreadSet && unreadSet.has(m.session_id);
                          return '<span class="member-chip' + (unread ? " unread" : "") + '" data-slim-open="' + esc(m.session_id) + '" role="button" tabindex="0" title="直开 ' + esc(ms.title || m.session_id) + '"><span class="mc-ava">' + badge + '<i class="status-dot ' + mst + '"></i></span><span class="mc-name">' + esc(ms.title || m.session_id) + "</span></span>";
                        }).join("");
                        html += '<div class="inspector-block slim-team-block"><div class="inspector-title"><span>团队成员 · ' + esc(slimTeamObj.name) + "</span><span>" + slimTeamObj.members.length + ' 席</span></div><div class="member-chips">' + chips + '</div><button type="button" class="slim-drawer-link" data-slim-drawer-toggle="' + esc(slimMem.gid) + '">团队信息 ⤢</button></div>'; // W-TEAMSNC ④：链接文案随厚抽屉升级（属性/路由零改动）
                      }
                    }
                    if (todos.length) html += '<div class="inspector-block"><div class="inspector-title"><span>任务清单</span><span>' + done + "/" + todos.length + '</span></div>' + open.map((t) => '<div class="check-row">' + (t.status === "in_progress" ? '<b class="run">◐</b>' : '<span>○</span>') + "<span>" + esc(t.status === "in_progress" && t.active_form ? t.active_form : t.content || "") + "</span></div>").join("") + "</div>";
                    if (s.context_usage && !pmInspectorFocus) html += '<div class="inspector-block"><div class="inspector-title"><span>用量</span><span>' + ctxPct(s) + '%</span></div>' + ctxMeterHtml(s) + "</div>"; // W-DRAWMERGE：PM 瘦身去水位（他 tab 已有）
                    // W-CTXFIX B3：压缩前状态摘要（有摘要才渲染，原生 details 默认折叠）
                    if (s.pre_compact_summary) html += '<div class="inspector-block"><details class="pcsum"><summary>压缩前状态摘要<span>已自动注入恢复</span></summary><pre>' + esc(s.pre_compact_summary) + "</pre></details></div>";
                    const arts = Array.isArray(s.artifacts) ? s.artifacts.filter((a) => a && a.path) : [];
                    if (arts.length && !pmInspectorFocus) {
                      const top = arts.slice().sort((a, b) => (b.last_at || 0) - (a.last_at || 0)).slice(0, 4);
                      html += '<div class="inspector-block"><div class="inspector-title"><span>输出物</span><span>' + arts.length + "</span></div>" + top.map((a) => { const name = baseName(a.path); return '<div class="artifact-row">' + artIconHtml(name) + " " + esc(name) + " <span>" + relTime(a.last_at || a.first_at) + "</span></div>"; }).join("") + "</div>";
                    }
                  }
                  // FB6：innerHTML 会吞掉检查器拖宽条（地基 initInspectors 挂的）——摘下回填。
                  // 件六：收起钮已挂 screen（骑缝会被 overflow 裁 + 拖宽跟随），不在本面板内，
                  // 不再需要摘回
                  const inspectorCtrls = [...UI.inspector.querySelectorAll(".inspector-resizer")];
                  UI.inspector.innerHTML = html;
                  inspectorCtrls.forEach((ctrl) => UI.inspector.prepend(ctrl));
                }

                // ---------- 渲染：对话流 ----------
                function isStreaming(e, s) { return !!e.streaming && !!s && s.status === "WORKING"; }
                function daySepNode(ts) { const d = document.createElement("div"); d.className = "timeline-note day-sep"; d.textContent = "── " + dayLabel(ts) + " ──"; return d; } /* 件九：day-sep 独立类=分节呼吸 */
                function noteNode(text) { const d = document.createElement("div"); d.className = "timeline-note" + (/^\s*⚠/.test(String(text ?? "")) ? " warn" : ""); d.textContent = text; return d; } // #B3-13 ⚠ 行同款黄
                // ---------- FB14 气泡附图：引用 → 缩略（按需拉取 + 缓存） ----------
                // 引用拉取复用输出物 CHUNK 管线（COMMAND_ARTIFACT_FETCH 的 img 引用分支）：
                // 快照里只带 basename 引用（体积恒小），首次渲染时排队拉取，就位后原地换 img。
                // 失败（含 7 天清扫过期）缓存 failed 态不再重试——占位收敛隐藏，正文仍在
                function bubbleImgHtml(s, ref) {
                  if (ref.startsWith("data:")) return '<img class="ub-img" src="' + esc(ref) + '" alt="随消息发送的图片" title="点击放大/还原" loading="lazy">';
                  const sid = (s && s.session_id) || "";
                  if (!sid || !S.status || S.status !== "online") return ""; // 离线不排拉取（重连后全量重渲自然补）
                  const key = sid + "/" + ref;
                  const c = S.imgUrls.get(key);
                  if (c && c.state === "ready") return '<img class="ub-img" src="' + esc(c.url) + '" alt="随消息发送的图片" title="点击放大/还原" loading="lazy">';
                  if (c && c.state === "failed") return ""; // 过期/拉取失败：不占位（气泡正文有 [图片×N] 交代）
                  queueBubbleImg(sid, ref);
                  return '<span class="ub-img ub-img-wait" data-imgref="' + esc(key) + '" aria-label="图片加载中"></span>';
                }
                function queueBubbleImg(sid, ref) {
                  const key = sid + "/" + ref;
                  if (S.imgUrls.has(key)) return;
                  S.imgUrls.set(key, { state: "loading" });
                  fetchArtifact(sid, ref).then((res) => {
                    const url = URL.createObjectURL(new Blob([artifactBytes(res)], { type: res.mime || "image/jpeg" }));
                    S.imgUrls.set(key, { state: "ready", url });
                    settleBubbleImg(key);
                  }).catch(() => {
                    S.imgUrls.set(key, { state: "failed" });
                    settleBubbleImg(key);
                  });
                }
                function settleBubbleImg(key) {
                  const c = S.imgUrls.get(key);
                  document.querySelectorAll('[data-imgref="' + cssEsc(key) + '"]').forEach((el) => {
                    if (!c || c.state !== "ready") { el.remove(); return; } // failed：占位收敛隐藏
                    const img = document.createElement("img");
                    img.className = "ub-img";
                    img.src = c.url;
                    img.alt = "随消息发送的图片";
                    img.title = "点击放大/还原";
                    img.loading = "lazy";
                    el.replaceWith(img);
                  });
                }
                // #164 单条消息 HTML（桌面/手机同一渲染路径；返回 "" = 该类开关关闭不渲染）
                function entryHtml(e, s) {
                  const role = msgRoleOf(e.kind);
                  const k = eKey(e);
                  const ke = esc(k); // data-x 属性安全
                  const open = expanded.has(k);
                  if (role === "user") {
                    // 旧壳 #38/#149 口径：>100 字折 3 行 + 展开全文；任务号/裸 URL 链接化
                    const src = String(e.full ?? e.text ?? "");
                    // W-AUTOMSG #194：自动注入消息（cron 巡检/值守喂活）折叠——不渲染用户
                    // 气泡，收为一行小灰字「⏱ 定时巡检 · HH:MM」，点击展开/收起原文（默认收起；
                    // am-head 复用 expanded 切换链）。样式全 inline（不碰样式类文件——wxstyle
                    // 批并行面零冲突）
                    if (isAutoInjected(src)) {
                      // 居中精修（Leader 追加件）：完全居中系统提示形态——收起=水平居中
                      // 一行小灰字（微信时间戳行视觉）；展开=居中无底色弱化块（限宽 85%）
                      return '<div class="automsg-row" data-x="' + ke + '" style="margin:2px 0 6px;text-align:center">'
                        + '<span class="am-head" data-x="' + ke + '" role="button" tabindex="0" title="' + (open ? "收起" : "展开") + '自动注入消息原文" style="color:var(--faint);font-size:11px;line-height:16px;cursor:pointer;display:inline-block">'
                        + (open ? "▾ 定时巡检" : "⏱ 定时巡检") + (e.ts ? " · " + fmtHM(e.ts) : "") + "</span>"
                        + (open ? '<div style="color:var(--dim);font-size:11.5px;line-height:17px;margin:4px auto 0;max-width:85%;width:fit-content;text-align:left;white-space:pre-wrap;word-break:break-word">' + esc(src) + "</div>" : "")
                        + "</div>";
                    }
                    const long = src.length > 100;
                    // FB14：随消息发送的图片在气泡内缩略呈现（点击放大/还原），不再只发不显。
                    // 元素形态两种：data: URL（前缀直用）或 relay 落盘引用（img-* basename，
                    // 经 COMMAND_ARTIFACT_FETCH 按需拉取——快照里只有引用，体积恒小）
                    const imgs = Array.isArray(e.images) ? e.images.filter((x) => typeof x === "string" && x) : [];
                    const imgHtml = imgs.length
                      ? '<div class="ub-imgs">' + imgs.slice(0, 8).map((ref) => bubbleImgHtml(s, ref)).join("") + "</div>"
                      : "";
                    // W-TOPBAR ⑨①：包一层 .msg-user-row（column+右对齐，旧壳 .msg-user 同构），
                    // 时间戳沿用旧版位=气泡下方右对齐；data-x 随 wrapper 顶层（替换链不变）
                    return '<div class="msg-user-row" data-x="' + ke + '"><div class="bubble me"><div class="ub' + (long && !open ? " clamp" : "") + '">' + userMsgHtml(src) + "</div>" + imgHtml +
                      (long ? '<span class="x-full" data-x="' + ke + '">' + (open ? "收起 ▴" : "展开全文 " + src.length + " 字 ▾") + "</span>" : "") + "</div>" +
                      (e.ts ? '<div class="mt">' + fmtHM(e.ts) + "</div>" : "") + "</div>";
                  }
                  if (role === "ai-text") {
                    const eng = engineMetaOf(s); // W-ENGLM G：消息流头像同链（engine 空按 model 推断，glm 不再落 ✻）
                    // W-AVABG：消息流 AI 头像底色对齐列表引擎品牌色淡彩（UIPOLISH2 件一同纲）——
                    // eng[1] 与列表 engineClass 同源值（同出 ENGINES 表）；已知引擎走 --engine-* token，
                    // PM/未知引擎（ENGINES 未命中 eng[1]=undefined）回落列表同款源色哈希 b2SourceColor
                    // （输入对齐列表 source 口径=显示名）。CSS 端 16% 淡彩罩 surface2 公式同 .srow-ava
                    const avaSrcRaw = String((s && (s.relay_source || S.relayName)) || "");
                    // W-AVABG R2（审查 P2 修）：哈希输入对齐列表 item.source 口径=esc(显示名)——源名含 &<>"' 时与列表同源同色
                    const aiAvaColor = { claude: "var(--engine-claude)", glm: "var(--engine-glm)", codex: "var(--engine-codex)", trae: "var(--engine-trae)", qwen: "var(--engine-qwen)", codebuddy: "var(--engine-codebuddy)", zcode: "var(--engine-zcode)" }[eng[1]] || b2SourceColor(esc(window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(avaSrcRaw) : avaSrcRaw));
                    const full = e.full ? String(e.full) : "";
                    return '<div class="message-ai" data-x="' + ke + '"><button type="button" class="copy-btn msg-copy" data-x="' + ke + '" title="复制全文" aria-label="复制消息全文">⧉</button><div class="message-author"><span class="ai-ava" style="--ai-ava-c:' + aiAvaColor + '">' + (ENGINE_BRAND_SVG[eng[1]] ? '<span class="badge-brand">' + ENGINE_BRAND_SVG[eng[1]] + "</span>" : "✻") + '</span><strong>' + esc(eng[0]) + "</strong>" + (e.ts ? "<time>" + fmtHM(e.ts) + "</time>" : "") + '</div><div class="message-body">' +
                      mdHtml(open ? String(e.full ?? e.text ?? "") : String(e.text ?? "")) +
                      (isStreaming(e, s) ? '<span class="stream-dots" role="status" aria-label="生成中"><i></i><i></i><i></i></span>' : "") +
                      (full ? '<span class="x-full" data-x="' + ke + '">' + (open ? "收起 ▴" : "展开全文 " + full.length + " 字 ▾") + "</span>" : "") +
                      "</div></div>";
                  }
                  if (role === "ai-think") {
                    if (!thinkShown) return ""; // #164 思考折叠卡：默认收起，pane 顶部开关控制显隐（B2-D5 就此闭合）
                    const src = String(e.full ?? e.text ?? "");
                    return '<div class="think" data-x="' + ke + '"><div class="th-head" data-x="' + ke + '">' +
                      (open ? "▾ 思考过程" : "▸ 思考过程 · " + src.length + " 字") + (e.ts ? " · " + fmtHM(e.ts) : "") + "</div>" +
                      (open ? '<div class="th-body">' + mdHtml(src) + "</div>" : "") + "</div>";
                  }
                  if (role === "ai-tool") {
                    const t = e.tool || "";
                    const isTaskTool = /^Task/.test(t); // Task* 行：摘要单行省略 + 展开看任务描述（旧壳 #204 口径）
                    const taskLife = isTaskLifeTool(t); // #47 任务生命周期行：data-role=task 不进过程组，proc-off 不影响（常显）
                    return '<div class="trow' + (taskLife ? " task-life" : "") + '" data-role="' + (taskLife ? "task" : "proc") + '" data-x="' + ke + '"><div class="tline"><span class="tico">' + (taskLife ? taskLifeIcon() : toolIcon(t)) + '</span><span class="tname">' + esc(t || "tool") + '</span><span' + (isTaskTool ? ' class="tsum"' : "") + ">" + taskRefRow(e.text) + "</span>" +
                      (t === "Bash" || t === "Write" ? '<span class="copy-btn" data-copy="' + esc(e.text || "") + '" title="复制命令">⧉</span>' : "") +
                      (e.detail ? '<span class="x-full" data-x="' + ke + '">' + (open ? "收起 ▴" : "展开 ▾") + "</span>" : "") +
                      "</div>" + (open && e.detail ? '<div class="tdetail">' + esc(e.detail) + "</div>" : "") + "</div>";
                  }
                  if (role === "ai-result") {
                    if (e.diff && e.diff.length) { // 工具结果 diff：±计数折叠 + 行级着色（旧壳口径）
                      const plus = e.diff.filter((l) => String(l).startsWith("+")).length;
                      const minus = e.diff.filter((l) => String(l).startsWith("-")).length;
                      return '<div class="trow" data-role="proc" data-x="' + ke + '"><div class="tline"><span class="tico">✎</span><span class="tres x-full" data-x="' + ke + '">' +
                        (open ? "收起变更 ▴" : "变更 <span class='ds-add'>+" + plus + "</span> <span class='ds-del'>-" + minus + "</span> ▾") + "</span></div>" +
                        (open ? '<div class="diff">' + e.diff.map(diffLine).join("") + "</div>" : "") + "</div>";
                    }
                    if (e.detail) {
                      return '<div class="trow" data-role="proc" data-x="' + ke + '"><div class="tline"><span class="tico">↳</span><span class="tres">' + taskRefRow(e.text) + '</span> <span class="x-full" data-x="' + ke + '">' + (open ? "收起 ▴" : "展开 ▾") + "</span></div>" +
                        (open ? '<div class="tdetail">' + esc(e.detail) + "</div>" : "") + "</div>";
                    }
                    return '<div class="trow" data-role="proc" data-x="' + ke + '"><div class="tline"><span class="tico">↳</span><span class="tres">' + taskRefRow(e.text) + "</span></div></div>";
                  }
                  // #B3-13 ⚠ 开头系统/警告行着 --working（旧壳 .msg-sys.warn 口径：/^\s*⚠/）
                  // W-UIFB ⑦：relay 防抢发提示小字号呈现（i=9 附带；文本特征挂 note-xs）
                  return '<div class="timeline-note' + (/^\s*⚠/.test(String(e.text ?? "")) ? " warn" : "") + (/防抢发/.test(String(e.text ?? "")) ? " note-xs" : "") + '">' + esc(oneLine(e.text)) + "</div>";
                }
                function entryNode(e, s) {
                  const html = entryHtml(e, s);
                  if (!html) return null;
                  const t = document.createElement("template");
                  t.innerHTML = html;
                  return t.content.firstElementChild;
                }
                function copyText(t) { try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t); } catch (_) {} }
                // 展开/收起（旧壳事件委托口径：切 expanded Set 后原地重建该条目，组内/流内位置不变）
                function toggleExpand(k) {
                  if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
                  const s = curSession();
                  const list = s ? (S.timelines.get(s.session_id) || []) : [];
                  const e = list.find((x) => eKey(x) === k);
                  if (!e || !s || !UI || !UI.convPane) return;
                  const n = entryNode(e, s);
                  const old = UI.convPane.querySelector('[data-x="' + cssEsc(k) + '"]');
                  if (old && n) old.replaceWith(n);
                }
                // B12 过程/思考开关（W-UIFB 合并裁决：head-actions 静态钮，不再随对话重建；
                // 手机 m-detail 仍走自带 .conv-ctrl 行——手机 head 无动作位）
                function updateConvCtrl() {
                  const pane = UI.convPane;
                  if (pane) pane.classList.toggle("proc-off", !procShow);
                  const scope = UI.headActions || document;
                  scope.querySelectorAll(".conv-mini[data-conv-toggle]").forEach((x) => {
                    const isProc = x.dataset.convToggle === "proc";
                    const on = isProc ? procShow : thinkShown;
                    x.classList.toggle("on", on);
                    // W-UIFB ③：标签收敛「⚙ 过程/✦ 思考」，开关态改由 .on 绿态承载（原「·开/·关」
                    // 后缀退役——head 右簇少 4 字符宽度，不与胶囊打架；title 补足可读性）
                    x.textContent = isProc ? "⚙ 过程" : "✦ 思考";
                    x.title = (isProc ? "工具过程行" : "思考过程") + (on ? " · 已显示，点击隐藏" : " · 已隐藏，点击显示");
                  });
                }
                function toggleConv(name) {
                  if (name === "proc") {
                    procShow = !procShow;
                    try { localStorage.setItem("ccd_proc_show", procShow ? "1" : "0"); } catch (_) {}
                    updateConvCtrl(); // 组隐藏走 CSS（.proc-off），无重建
                  } else if (name === "think") {
                    thinkShown = !thinkShown;
                    try { localStorage.setItem("ccd_think_show", thinkShown ? "1" : "0"); } catch (_) {}
                    updateConvCtrl();
                    renderConversation(); // 思考卡增删需重建时间线
                  }
                }
                // #164 过程组：连续 tool/result 条目合并为一条可折叠组（组头「过程 · N 步」，
                // 默认收起；展开态记 expanded Set 的 "proc:"+eKey，跨重渲稳定）
                function procHeadUpdate(g) {
                  const head = g.querySelector(".proc-head");
                  if (head) head.textContent = (g.classList.contains("open") ? "▾" : "▸") + " 过程 · " + g.querySelectorAll(".proc-body > .trow").length + " 步";
                }
                function procGroupNode(key) {
                  const g = document.createElement("div");
                  g.className = "procgrp";
                  g.dataset.proc = key;
                  if (expanded.has("proc:" + key)) g.classList.add("open");
                  const head = document.createElement("div");
                  head.className = "proc-head";
                  head.dataset.procToggle = key;
                  const body = document.createElement("div");
                  body.className = "proc-body";
                  g.append(head, body);
                  procHeadUpdate(g);
                  return g;
                }
                let openProcGrp = null; // 增量追加时的活动过程组（renderConversation 重建清零）
                                function renderConversation() {
                  const pane = UI.convPane;
                  if (!pane) return;
                  // 件十九（2026-10-12 用户实测「发完消息墙跳到顶」根修）：全量重建（textContent=""）
                  // 会让滚动容器塌缩→scrollTop 归零。v3 用 top-anchor（距顶）：对话前缀稳定（历史只尾增），
                  // 距顶恢复天然免疫 bottom-anchor 的 clamp 折损（回涨高度把位置拖进贴底窗的链式失效）。
                  const scrollAnchor = UI.body ? { top: UI.body.scrollTop } : null;
                  openProcGrp = null;
                  pane.textContent = "";
                  const s = curSession();
                  if (!s) { pane.appendChild(noteNode(!WS_BASE && !desktopForm() ? "请通过 relay 同源 HTTP 页面连接" : (!tokenLive() && !cloudLaneOn()) ? (desktopForm() ? "正在连接本机 relay…" : "请通过带 ?token= 的 relay 链接连接") : "从左侧选择会话查看对话")); return; }
                  const trunc = S.logsTruncated.get(s.session_id) || 0;
                  if (trunc > 0) pane.appendChild(noteNode("更早的 " + trunc + " 条已截断 · 仅显示最近记录"));
                  const list = S.timelines.get(s.session_id) || [];
                  const frag = document.createDocumentFragment();
                  let prevDay = "";
                  let grp = null;
                  let lastAiNode = null, lastAiTs = 0; // 件九：连续 AI 正文去重署名链（间隔 >5min 断）
                  for (const e of list) {
                    const dk = e.ts ? dayKey(e.ts) : "";
                    if (dk && dk !== prevDay) { frag.appendChild(daySepNode(e.ts)); prevDay = dk; grp = null; lastAiNode = null; } // 日期分隔断组（件九：新分节重显署名行）
                    const n = entryNode(e, s);
                    if (!n) continue; // 开关关闭的条目（思考）不断组也不占位
                    if (n.dataset.role === "proc") {
                      if (!grp) { grp = procGroupNode(eKey(e)); frag.appendChild(grp); }
                      grp.querySelector(".proc-body").appendChild(n);
                      lastAiNode = null; // 件九：过程组是强分隔——组后新正文重显署名
                    } else {
                      // 件九（层级降噪）：连续 AI 正文消息去重署名行——同作者短间隔连发只留
                      // 首条头像（正文 37px 左基线不变，续条对齐前条正文）；过程组/气泡/分隔/
                      // 超 5 分钟间隔都断链（隔时段回来的消息无署名会迷失作者）
                      const gapBreak = lastAiTs && e.ts && e.ts - lastAiTs > 300_000;
                      if (n.classList.contains("message-ai") && lastAiNode && !gapBreak) n.classList.add("cont");
                      if (n.classList.contains("message-ai")) { lastAiNode = n; lastAiTs = e.ts || lastAiTs; } else { lastAiNode = null; lastAiTs = 0; }
                      frag.appendChild(n); grp = null; // 正文/气泡断组
                    }
                  }
                  frag.querySelectorAll(".procgrp").forEach(procHeadUpdate);
                  pane.appendChild(frag);
                  // W-PORT-A R-4：发送乐观回显气泡（时间线权威流之后、wait-card 之前；惰性超时清理同拍）
                  echoSweep(s.session_id);
                  const eqs = S.echo.get(s.session_id) || [];
                  for (const eq of eqs) {
                    const row = document.createElement("div");
                    row.className = "msg-user-row msg-echo" + (eq.state === "fail" ? " echo-fail" : "");
                    row.dataset.echoKey = eq.key;
                    row.innerHTML = '<div class="bubble me"><div class="ub">' + userMsgHtml(eq.text) + '</div><div class="echo-state">' + (eq.state === "fail" ? "⚠ 未送达" : "发送中…") + "</div></div>";
                    pane.appendChild(row);
                  }
                  if (s.status === "DONE" && s._terminal === "interrupted") pane.appendChild(noteNode("已停止 · 生成在此中断"));
                  if (s.status === "ERROR" && s.last_error) pane.appendChild(noteNode("⚠ " + oneLine(s.last_error)));
                  if (s.status === "ERROR" && s.auth_hint) pane.appendChild(noteNode("🔑 " + oneLine(s.auth_hint))); /* #102 批 A：引擎登录态失效指引行 */
                  syncWaitCard(true);
                  autoScroll(S.forceScroll, scrollAnchor, S.forceScroll ? (S.scrollKeep.get(s.session_id) || null) : null); // 件二十：切回恢复该会话记录位
                  S.forceScroll = false;
                }
                function autoScroll(force, anchor, saved) {
                  // 件十九+二十统一滚动状态机 v3（top-anchor）：
                  // ①saved（件二十）=切回会话的记录 {top, bottom}：在底→贴底（新消息照常跟随），离底→恢复距顶；
                  // ②anchor（件十九）=全量重建前的 scrollTop：距顶恢复（前缀稳定=精确，无 clamp 折损）；
                  // ③force/用户贴底态（S.userPinnedBottom）→贴底。near 只作无锚兜底。
                  const el = UI.body;
                  if (!el) return;
                  const restoreTop = (top) => { el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight)); };
                  if (saved && Number.isFinite(saved.top)) {
                    if (saved.bottom) { el.scrollTop = el.scrollHeight; return; }
                    restoreTop(saved.top); return;
                  }
                  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                  if (force || S.userPinnedBottom === true || (anchor ? false : near)) { el.scrollTop = el.scrollHeight; return; }
                  if (anchor) restoreTop(anchor.top);
                }
                // #166 等待行动卡（双态分离 + 三级按钮 + remember 范围选择 + elapsed 计时 + 焦点感提升）
                let waitElapsedTimer = null;
                function syncWaitCard(force) {
                  const pane = UI.convPane;
                  const s = curSession();
                  const has = !!(s && s.status === "WAITING" && s.waiting_request && !s.historical);
                  let card = pane.querySelector(".wait-card[data-b2-wait]");
                  if (!has) { if (card) { card.remove(); if (waitElapsedTimer) { clearInterval(waitElapsedTimer); waitElapsedTimer = null; } } return; }
                  if (card && !force) { pane.appendChild(card); return; } // 新日志到达时保持在末尾
                  if (card) card.remove();
                  const w = s.waiting_request;
                  const passive = w.decidable === false;
                  const isAsk = Array.isArray(w.questions) && w.questions.length > 0;
                  const single = isAsk && w.questions.length === 1 && !w.questions[0].multi;
                  const waitStart = w.request_started_at || Date.now();
                  let title, content = "", actions = "";
                  if (isAsk) {
                    title = "等待你的回答 · " + (w.questions[0].header || w.tool_name || "提问");
                    content = w.questions.map((q) => q.question || "").join(" ／ ");
                  } else {
                    title = "等待你的确认 · " + (w.tool_name || "工具调用");
                    // 审批态：命令全文走 wait-detail mono 块，input_summary 作补充描述
                    content = w.input_summary || "";
                    if (Array.isArray(w.suggestions) && w.suggestions.length) content += (content ? "\n" : "") + "建议：" + w.suggestions.join(" / ");
                  }
                  if (passive && !isAsk) {
                    // W-APPROVE #232：被动权限卡可决化——按钮点击仍走 COMMAND_CONTINUE/REJECT，
                    // relay 侧经按键注入应答 CLI 本地弹窗（tmux pane 直达数字键+capture 验证；
                    // 注入失败横幅保留可重试，toast 给失败原因）。无人值守的外部 CLI（无头
                    // PM/worker）不再「请在电脑上处理」干等到死
                    content += "\n（CLI 本地弹窗等待中——可远程批准，无需到电脑前）";
                    actions = '<div class="wait-actions"><button class="deny" data-wait-deny>✕ 拒绝</button>' +
                      '<button class="allow" data-wait-allow>✓ 允许</button></div>';
                  } else if (passive) {
                    content += "\n（CLI 正在本地等待确认，请在电脑上处理）";
                  } else if (isAsk && (w.received_at || w.request_started_at) && Date.now() - (w.received_at || w.request_started_at) > 90000) {
                    // W-DESKASK（W-ASKFIX 桌面同步）：ask 卡 90s 应答窗（relay
                    // QUESTION_HOLD_MS）——过期 CLI 已放本地选择器，手机/网页晚答注入
                    // 无门（CLI 已死/终态=死卡）——按钮全撤+置灰标注，对齐 expo
                    // AskBanner「已失效（超时）」口径；审批类 10min 治理（#159 件③）不动
                    content += "\n（已失效（超时）——CLI 已放行本地选择器，此处作答无法送达）";
                  } else if ((w.received_at || w.request_started_at) && Date.now() - (w.received_at || w.request_started_at) > 600000) {
                    // #159 件③ 过期治理：waiting_request 超 10min 视为已失效（CLI 多已越过，
                    // relay sweepStalePending 同语义）——按钮全撤防「点了没反应」假死
                    content += "\n（该请求已超过 10 分钟未处理，已失效——CLI 多已继续）";
                  } else if (isAsk) {
                    if (single) {
                      actions = '<div class="wait-actions">' + (w.questions[0].options || []).map((o, i) => '<button data-wait-answer="' + i + '">' + esc(o.label) + "</button>").join("") + '<button class="deny" data-wait-deny>取消提问</button></div>';
                    } else {
                      // W-ASKUSER-FIX（B2b 补齐，2026-10-20 用户实锤「多问题只显标题+取消」）：
                      // 多问题/多选=分组渲染（每题 header+题干+选项 chips），单选组点击即选中、
                      // 多选组（multi:true）toggle 勾选——「提交回答」统一收齐经 COMMAND_ANSWER
                      // 上送（answers 按题序，多选拼「、」——expo AskBanner 同交互模型移植）
                      const groups = w.questions.map((q, qi) => {
                        const chips = (q.options || []).map((o, oi) =>
                          '<button type="button" class="wait-chip' + (q.multi ? " toggle" : "") + '" data-wait-chip="' + qi + ":" + oi + '"' + (o.description ? ' title="' + esc(o.description) + '"' : "") + '><span class="wc-label">' + esc(o.label) + "</span>" + (q.multi ? '<span class="wc-check"></span>' : "") + "</button>").join("");
                        return '<div class="wait-qgroup" data-wait-qgroup="' + qi + '"' + (q.multi ? ' data-multi="1"' : "") + '><div class="wq-head">' + esc(q.header || ("问题 " + (qi + 1))) + (q.multi ? '<span class="wq-multi-tag">可多选</span>' : "") + '</div><div class="wq-question">' + esc(q.question || "") + '</div><div class="wq-chips">' + chips + "</div></div>";
                      }).join("");
                      actions = '<div class="wait-multi">' + groups + '</div><div class="wait-actions"><button class="deny" data-wait-deny>取消提问</button><button class="allow" data-wait-submit>提交回答</button></div>';
                    }
                  } else {
                    // 三级按钮：允许（主）、拒绝（次）、允许并记住（第三，点击展开范围选择）
                    actions = '<div class="wait-actions"><button class="deny" data-wait-deny>拒绝并说明</button>' +
                      (w.remember ? '<button class="remember" data-wait-remember>允许并记住</button>' : "") +
                      '<button class="allow" data-wait-allow>允许一次</button></div>';
                  }
                  card = document.createElement("div");
                  card.className = "wait-card" + (isAsk ? " ask" : "");
                  card.dataset.b2Wait = "1";
                  card.dataset.sid = s.session_id;
                  card.dataset.rid = w.request_id || "";
                  if (passive && !isAsk) card.dataset.passive = "1"; // W-APPROVE：受理≠生效，收卡等状态帧
                  card.dataset.waitStart = String(waitStart);
                  // 标题行：title + 呼吸点 + elapsed
                  const elapsed = Math.floor((Date.now() - waitStart) / 1000);
                  const titleHtml = '<strong class="wait-title">' + esc(title) + '<span class="wait-dot"></span><span class="wait-elapsed" data-wait-elapsed>' + elapsed + 's</span></strong>';
                  // 内容：审批态用 wait-detail mono 块展示命令全文，提问态用 p
                  let bodyHtml = "";
                  if (isAsk) {
                    bodyHtml = content ? '<p class="wait-copy">' + esc(content).replace(/\n/g, "<br>") + "</p>" : "";
                  } else {
                    const cmdFull = w.command_text || w.input_summary || "";
                    bodyHtml = (cmdFull ? '<div class="wait-detail">' + esc(cmdFull) + "</div>" : "") +
                      (content && content !== cmdFull ? '<p class="wait-copy">' + esc(content).replace(/\n/g, "<br>") + "</p>" : "");
                  }
                  card.innerHTML = titleHtml + bodyHtml + actions;
                  pane.appendChild(card);
                  // elapsed 走秒
                  if (waitElapsedTimer) clearInterval(waitElapsedTimer);
                  waitElapsedTimer = setInterval(() => {
                    const c = pane.querySelector(".wait-card[data-b2-wait]");
                    if (!c || !c.dataset.waitStart) { clearInterval(waitElapsedTimer); waitElapsedTimer = null; return; }
                    const el = c.querySelector("[data-wait-elapsed]");
                    if (el) el.textContent = Math.floor((Date.now() - Number(c.dataset.waitStart)) / 1000) + "s";
                  }, 1000);
                }
                function markWaitCardDone(card, denied) {
                  card.classList.add(denied ? "denied" : "allowed");
                  const t = card.querySelector(".wait-title");
                  if (t) t.textContent = denied ? "已拒绝 · 等待会话处理" : "已允许 · 会话继续中";
                  card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
                  if (waitElapsedTimer) { clearInterval(waitElapsedTimer); waitElapsedTimer = null; }
                }
                function handleWaitVerdict(btn, kind) {
                  const card = btn.closest("[data-b2-wait]");
                  if (!card || card.dataset.busy) return;
                  const sid = card.dataset.sid, rid = card.dataset.rid;
                  if (!sid || !rid) return;
                  // remember 点击：展开范围选择（本次会话 / 所有会话）
                  if (kind === "remember") {
                    const existing = card.querySelector(".remember-scope");
                    if (existing) { existing.remove(); return; } // 再次点击收起
                    const scope = document.createElement("div");
                    scope.className = "remember-scope";
                    scope.innerHTML = '<button data-remember-scope="session">本次会话</button><button data-remember-scope="global">所有会话</button>';
                    scope.addEventListener("click", (ev) => {
                      const s = ev.target.closest("[data-remember-scope]");
                      if (!s) return;
                      card.dataset.busy = "1";
                      const type = "COMMAND_CONTINUE";
                      const extra = { remember_scope: s.dataset.rememberScope };
                      commandAck(type, Object.assign({ session_id: sid, request_id: rid }, extra)).then((ack) => {
                        const v = ackVerdict(ack);
                        if (v.ok) markWaitCardDone(card, false);
                        else { delete card.dataset.busy; b2Toast("等待处理未确认：" + v.error); }
                      });
                    });
                    const actions = card.querySelector(".wait-actions");
                    if (actions) actions.parentNode.insertBefore(scope, actions.nextSibling);
                    return;
                  }
                  card.dataset.busy = "1";
                  const type = kind === "deny" ? "COMMAND_REJECT" : "COMMAND_CONTINUE";
                  const extra = {};
                  commandAck(type, Object.assign({ session_id: sid, request_id: rid }, extra)).then((ack) => {
                    const v = ackVerdict(ack);
                    if (v.ok) {
                      if (card.dataset.passive === "1") {
                        // W-APPROVE #232（审查 P1 修正）：被动卡 ACK ok=受理≠生效（relay 异步
                        // 注键验证）——不本地终态化，等状态帧收卡；8s 无帧=注入未生效，解 busy
                        // 可重试（时间线有失败留痕）。终态化会让失败后卡不可重试
                        b2Toast("已受理 · 等待注入结果…");
                        setTimeout(() => { if (card.isConnected) delete card.dataset.busy; }, 8000);
                      } else {
                        markWaitCardDone(card, kind === "deny");
                        if (kind === "deny") b2Toast("已拒绝 · 可在输入栏补充说明");
                      }
                    }
                    else { delete card.dataset.busy; b2Toast("等待处理未确认：" + v.error); }
                  });
                }
                // W-ASKUSER-FIX：多问题/多选交互——chip 点击（单选组=排他选中，多选组=toggle）
                function handleWaitChip(chip) {
                  const group = chip.closest("[data-wait-qgroup]");
                  if (!group) return;
                  if (group.dataset.multi === "1") chip.classList.toggle("on");
                  else {
                    group.querySelectorAll(".wait-chip").forEach((c) => c.classList.remove("on"));
                    chip.classList.add("on");
                  }
                }
                // 提交：按题序收集（单选=选中项 label；多选=所有 on 的 labels 拼「、」；未选题空串占位）
                function handleWaitSubmit(btn) {
                  const card = btn.closest("[data-b2-wait]");
                  if (!card || card.dataset.busy) return;
                  const sid = card.dataset.sid, rid = card.dataset.rid;
                  const s = S.sessions.get(sid);
                  const w = s && s.waiting_request;
                  if (!sid || !rid || !w || !Array.isArray(w.questions)) return;
                  const answers = w.questions.map((q, qi) => {
                    const on = [...card.querySelectorAll('.wait-qgroup[data-wait-qgroup="' + qi + '"] .wait-chip.on .wc-label')].map((el) => el.textContent);
                    return on.join("、");
                  });
                  if (answers.every((a) => !a)) { b2Toast("请先选择至少一项再提交"); return; }
                  card.dataset.busy = "1";
                  commandAck("COMMAND_ANSWER", { session_id: sid, request_id: rid, answers }).then((ack) => {
                    const v = ackVerdict(ack);
                    if (v.ok) markWaitCardDone(card, false);
                    else { delete card.dataset.busy; b2Toast("作答未确认：" + v.error); }
                  });
                }
                function handleWaitAnswer(btn) {
                  const card = btn.closest("[data-b2-wait]");
                  if (!card || card.dataset.busy) return;
                  const sid = card.dataset.sid, rid = card.dataset.rid;
                  const s = S.sessions.get(sid);
                  const w = s && s.waiting_request;
                  const opt = w && w.questions && w.questions[0] && (w.questions[0].options || [])[Number(btn.dataset.waitAnswer)];
                  if (!sid || !rid || !opt) return;
                  card.dataset.busy = "1";
                  commandAck("COMMAND_ANSWER", { session_id: sid, request_id: rid, answers: [opt.label] }).then((ack) => {
                    const v = ackVerdict(ack);
                    if (v.ok) markWaitCardDone(card, false);
                    else { delete card.dataset.busy; b2Toast("作答未确认：" + v.error); }
                  });
                }
                // #164 增量追加统一入口：过程条目续入活动组（组头步数递增）、非过程条目断组；
                // 插入位保持在 wait-card 之前（syncWaitCard 随后会把卡挪回末尾）
                function appendEntryNode(pane, n, dayNode) {
                  const wait = pane.querySelector(".wait-card[data-b2-wait]");
                  const ins = (node) => { if (wait && wait.parentNode === pane) pane.insertBefore(node, wait); else pane.appendChild(node); };
                  if (dayNode) { ins(dayNode); openProcGrp = null; } // 新的一天：断组
                  if (!n) return;
                  if (n.dataset.role === "proc") {
                    if (!(openProcGrp && openProcGrp.isConnected && openProcGrp.parentElement === pane)) {
                      openProcGrp = procGroupNode(n.dataset.x || "");
                      ins(openProcGrp);
                    }
                    openProcGrp.querySelector(".proc-body").appendChild(n);
                    procHeadUpdate(openProcGrp);
                  } else {
                    ins(n);
                    openProcGrp = null;
                  }
                }
                // 增量 LOG → DOM（同 id 原地替换 / 追加；天分隔与流式收口；过程条目归组）
                function applyDomLog(sid, outcome, entryId) {
                  const pane = UI.convPane;
                  const s = curSession();
                  if (!pane || !s) return;
                  const list = S.timelines.get(sid) || [];
                  if (outcome === "append") {
                    for (const p of list.slice(0, -1)) if (p.streaming) { p.streaming = false; if (p.id) { const old = pane.querySelector('[data-x="' + cssEsc(p.id) + '"]'); if (old) old.replaceWith(entryNode(p, s)); } }
                    const e = list[list.length - 1];
                    const prev = list[list.length - 2];
                    const n = entryNode(e, s);
                    if (n) n.classList.add("enter"); // #B3-17 新消息入场
                    appendEntryNode(pane, n, prev && dayKey(prev.ts) !== dayKey(e.ts) ? daySepNode(e.ts) : null);
                  } else {
                    if (!entryId) return;
                    const e = list.find((x) => x.id === entryId);
                    if (!e) return;
                    const old = pane.querySelector('[data-x="' + cssEsc(e.id) + '"]');
                    const n = entryNode(e, s);
                    if (old && n) {
                      old.replaceWith(n); // 组内条目原位更新（detail/diff 后到）
                      // #47 编号回填原位更新坑（2026-10-10）：无号 TaskCreate 行可能已续入过程组
                      // （增量追加按当时的 proc 角色归组），同 id 替换成生命周期行后若留组内，
                      // proc-off 会连组藏掉任务行、组头步数也虚计——非过程行一律迁出组体
                      if (n.dataset.role !== "proc" && n.parentElement && n.parentElement.classList.contains("proc-body")) {
                        const grp = n.parentElement.closest(".procgrp");
                        if (grp) {
                          grp.after(n);
                          procHeadUpdate(grp);
                          if (!grp.querySelector(".proc-body .trow")) grp.remove(); // 组被迁空即拆，防空「过程 · 0 步」壳
                        }
                      }
                    }
                    else if (n) {
                      const prev = list[list.indexOf(e) - 1];
                      appendEntryNode(pane, n, prev && dayKey(prev.ts) !== dayKey(e.ts) ? daySepNode(e.ts) : null);
                    }
                  }
                  syncWaitCard(false);
                  if (S.userPinnedBottom !== false) autoScroll(); // 件十九：跟底走用户贴底态（几何 near 被 SNAPSHOT 中间态污染=跳底真凶），离底绝不拉
                  // 件十一：新消息落地而用户离底超一屏（正读历史）→ FAB 点亮未读点
                  // （点击回底/滚近底由 btb 侧熄灭）；近底跟随场景不点
                  if (UI.body && UI.body.scrollHeight - UI.body.scrollTop - UI.body.clientHeight > UI.body.clientHeight) {
                    document.querySelector(".back-to-bottom")?.classList.add("has-unread");
                  }
                }

                // ---------- 渲染：任务 tab（todosTabHtml 四组制 + VERIFY_RE） ----------
                // #B3-9 任务行 ✕ 逐条隐藏：sid#tid 键本地记忆（仅本端视图层，不回写 relay）
                const hiddenTaskKeys = new Set();
                // W-P0-FIX P0-4 SSOT P2（task-lifecycle.md §7 切数据源）：当前会话存在看板镜像
                //（source="board"）时任务 tab 默认只显镜像（团队任务唯一事实源），本地自建条目
                // 降权折叠为「本地草稿」组（点按展开）；无镜像会话（非团队/无板）保持原四组视图
                const ssotBoardMode = () => {
                  const sc = curSession();
                  const ts = Array.isArray(sc && sc.todos) ? sc.todos : [];
                  return ts.some((t) => t && t.source === "board");
                };
                window.__ccDeck005SsotDraftOpen = window.__ccDeck005SsotDraftOpen || false;
                function renderTasks() {
                  const pane = UI.panes[1];
                  const s = curSession();
                  if (!s) { pane.innerHTML = '<div class="readonly-banner">未选择会话</div>'; return; }
                  const allTodos = Array.isArray(s.todos) ? s.todos.filter(Boolean) : [];
                  const visible0 = allTodos.filter((t) => !hiddenTaskKeys.has(s.session_id + "#" + t.id));
                  const ssot = ssotBoardMode();
                  // P2 切源：镜像主显；本地条目折叠组（本地草稿在镜像在场时非团队真相，降权）
                  const localTodos = ssot ? visible0.filter((t) => t.source !== "board") : [];
                  const todos = ssot ? visible0.filter((t) => t.source === "board") : visible0;
                  if (!todos.length && !localTodos.length) { pane.innerHTML = '<div class="pane-summary">任务清单</div><div class="readonly-banner">暂无任务清单</div>'; return; }
                  if (!todos.length && localTodos.length) { pane.innerHTML = '<div class="pane-summary">任务进度 · 团队看板</div><div class="readonly-banner">团队看板暂无任务 · 本地草稿 ' + localTodos.length + ' 条（见下方折叠组）</div>' + ssotDraftHtml(localTodos); wireSsotDraft(); return; }
                  const doneAll = todos.filter((t) => t.status === "completed");
                  const doneWindow = doneAll.length && doneAll.every((t) => typeof t.updated_at === "number") ? doneAll.filter((t) => (t.updated_at || 0) >= Date.now() - 86400e3) : doneAll;
                  const doneList = doneWindow.slice(-15);
                  const open = todos.filter((t) => t.status !== "completed");
                  const ipAll = open.filter((t) => t.status === "in_progress");
                  const vf = ipAll.filter((t) => VERIFY_RE.test(t.content || ""));
                  const ip = ipAll.filter((t) => !VERIFY_RE.test(t.content || ""));
                  const pd = open.filter((t) => t.status === "pending");
                  // #B3-11 分组跳转 chips：任务 tab 头四组直达（组空不亮＝disabled 态）
                  const chip = (key, label, n) => '<button type="button" class="task-jump-chip' + (n ? "" : " off") + '" data-task-jump="' + key + '"' + (n ? "" : " disabled") + ">" + label + (n ? " " + n : "") + "</button>";
                  let html = '<div class="pane-summary">任务进度 ' + doneAll.length + "/" + todos.length + '</div><div class="task-jump-chips">' + chip("done", "已完成", doneList.length) + chip("working", "进行中", ip.length) + chip("verify", "待验证", vf.length) + chip("pending", "待办", pd.length) + '</div><div class="detail-panel-list">';
                  const emit = (label, items, mk, groupClass, groupKey) => {
                    if (!items.length) return;
                    html += '<div class="queue-group' + (groupClass ? " " + groupClass : "") + '" data-task-group="' + groupKey + '">' + label + "</div>";
                    // W-TASKFLOW 看板镜像徽标：source="board" 条目=团队看板单向投影（唯一事实源），双跑期可辨
                    const srcChip = (t) => (t.source === "board" ? '<i style="font-style:normal;font-size:10px;line-height:1;padding:2px 5px;margin-right:6px;border-radius:4px;color:var(--brand);background:rgba(226,133,94,.12);border:1px solid rgba(226,133,94,.3);font-weight:600" title="团队看板镜像（以看板为准单向同步）">板</i>' : "");
                    for (const t of items) html += '<div class="check-row"' + (t.id != null ? ' data-tid="' + esc(String(t.id)) + '"' : "") + ">" + mk(t) + "<span>" + srcChip(t) + taskRefHtml((t.id != null ? "#" + t.id + " " : "") + (t.status === "in_progress" && t.active_form ? t.active_form : t.content || "")) + "</span>" + (t.id != null ? '<button type="button" class="task-x" data-task-hide="' + esc(String(t.id)) + '" title="隐藏此条" aria-label="隐藏任务 #' + esc(String(t.id)) + '">✕</button>' : "") + "</div>";
                  };
                  emit("已完成 · " + doneList.length + "/" + doneAll.length, doneList, () => "<b>✓</b>", "group-done", "done");
                  emit("进行中 · " + ip.length, ip, () => '<b class="run">◐</b>', "group-working", "working");
                  emit("待验证 · " + vf.length, vf, () => '<b class="verify">◇</b>', "group-verify", "verify");
                  emit("待办 · " + pd.length, pd, () => "<span>○</span>", "", "pending");
                  html += "</div>";
                  if (doneList.length < doneAll.length) html += '<div class="readonly-banner">已完成仅显示最近 15 条（共 ' + doneAll.length + " 条）</div>";
                  if (localTodos.length) html += ssotDraftHtml(localTodos);
                  pane.innerHTML = html;
                  if (localTodos.length) wireSsotDraft();
                }
                // P0-4 本地草稿折叠组（SSOT P2：默认收起、点按展开、行内 ✕ 照旧）
                function ssotDraftHtml(items) {
                  const open = !!window.__ccDeck005SsotDraftOpen;
                  let h = '<div class="queue-group" style="margin-top:10px"><button type="button" class="mini-list-link" data-ssot-draft-toggle style="width:100%;text-align:left">' + (open ? "▾" : "▸") + " 本地草稿 · " + items.length + '（PM 自建，非团队任务真相 · 团队任务以看板为准）</button></div>';
                  if (!open) return h;
                  h += '<div class="detail-panel-list">';
                  for (const t of items) {
                    h += '<div class="check-row"' + (t.id != null ? ' data-tid="' + esc(String(t.id)) + '"' : "") + "><span>" + taskRefHtml((t.id != null ? "#" + t.id + " " : "") + (t.status === "in_progress" && t.active_form ? t.active_form : t.content || "")) + "</span>" + (t.id != null ? '<button type="button" class="task-x" data-task-hide="' + esc(String(t.id)) + '" title="隐藏此条" aria-label="隐藏任务 #' + esc(String(t.id)) + '">✕</button>' : "") + "</div>";
                  }
                  return h + "</div>";
                }
                function wireSsotDraft() {
                  const tg = UI.panes[1] && UI.panes[1].querySelector("[data-ssot-draft-toggle]");
                  if (tg) tg.addEventListener("click", () => { window.__ccDeck005SsotDraftOpen = !window.__ccDeck005SsotDraftOpen; renderTasks(); });
                }
                function jumpToTask(n) { // #279④ #NNN → 任务 tab 定位（#B3-18 落点 jump-flash 闪高 1.5s）
                  if (UI.tabs[1]) UI.tabs[1].click();
                  setTimeout(() => {
                    const row = UI.panes[1] && UI.panes[1].querySelector('.check-row[data-tid="' + cssEsc(String(n)) + '"]');
                    if (!row) { b2Toast("任务 #" + n + " 不在当前清单"); return; }
                    row.scrollIntoView({ block: "center", behavior: "smooth" });
                    row.classList.add("jump-flash");
                    setTimeout(() => row.classList.remove("jump-flash"), 1500);
                  }, 60);
                }

                // ---------- 渲染：输出物 tab（目录分组 + 批量下载） ----------
                // #158-批4a：目录切分兼容 \ 分隔（Windows 原生路径 lastIndexOf("/") 为 -1 会让整串
                // 落散列/目录截尾错位）；relDir 前缀比较归一化（1:1 替换保序，切片索引对齐），输出走 displayPath
                function artDirOf(a) { return window.__ccDeck005PathUi.dirOf(a.path); }
                function relDir(dir, cwd) {
                  if (!dir) return "";
                  const n = (s) => String(s || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
                  const d = n(dir), c = n(cwd);
                  if (c && d.startsWith(c + "/")) return displayPath(dir.slice(c.length + 1));
                  return displayPath(dir);
                }
                function artLayoutItems(artifacts) { // v1 同款：同目录 ≥2 文件成组，其余散列
                  const items = (artifacts || []).filter((a) => a && a.path).slice().sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
                  const byDir = new Map();
                  for (const a of items) { const dir = artDirOf(a); if (!byDir.has(dir)) byDir.set(dir, []); byDir.get(dir).push(a); }
                  const groups = [], loose = [];
                  for (const [dir, list] of byDir) { if (list.length >= 2) groups.push({ dir, list }); else loose.push(list[0]); }
                  groups.sort((a, b) => Math.max(...b.list.map((x) => x.last_at || 0)) - Math.max(...a.list.map((x) => x.last_at || 0)));
                  return { groups, loose, files: items };
                }
                // #168 行徽章（至多一枚，优先级 死档 > cwd 外 > 组内新建/修改；分色只在瓦片，徽章走语义色）
                function artBadgeHtml(a, inGroup) {
                  if (a.exists === false) return '<span class="art-badge b-dead">已不在磁盘</span>';
                  if (a.origin === "outside") return '<span class="art-badge b-out">cwd 外</span>';
                  if (inGroup && a.op) return a.op === "create" ? '<span class="art-badge b-new">新建</span>' : '<span class="art-badge b-mod">修改</span>';
                  return "";
                }
                // #168 行二层：瓦片(26px 分色/图片缩略) + 名/徽章主行 + 「目录 · 尺寸 · 时间」灰字次行
                function artFileNode(a, cwd, inGroup) {
                  const name = baseName(a.path);
                  const kind = artifactKindFor(name);
                  // #168 目录显示：cwd 本体 →「（工作目录）」；cwd 外绝对路径 → rtl 截断保根
                  const nzp = (x) => String(x || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
                  const rawDir = artDirOf(a);
                  const isRoot = !inGroup && nzp(rawDir) === nzp(cwd);
                  const dir = inGroup ? "" : (isRoot || !relDir(rawDir, cwd) ? "（工作目录）" : relDir(rawDir, cwd));
                  const absDir = !inGroup && !isRoot && dir !== "（工作目录）" && (a.origin === "outside" || /^[~/]|^[A-Za-z]:[\\/]/.test(dir));
                  const metaParts = [];
                  if (dir) metaParts.push('<span class="dir' + (absDir ? " rtl" : "") + '">' + esc(dir) + "</span>");
                  if (a.size != null) metaParts.push("<span>" + sizeStr(a.size) + "</span>");
                  metaParts.push("<span>" + relTime(a.last_at || a.first_at) + "</span>");
                  const tile = kind === "image" && a.thumb
                    ? '<span class="art-thumb"><img src="' + esc(a.thumb) + '" alt=""></span>'
                    : '<span class="art-tile k-' + kind + '">' + svgUse(artifactIconFor(name)) + "</span>";
                  const div = document.createElement("div");
                  div.className = "art-row k-" + kind + (a.exists === false ? " dead" : "");
                  div.dataset.artifactFile = name;
                  div.dataset.path = a.path;
                  div.setAttribute("role", "button");
                  div.tabIndex = 0;
                  div.title = "预览 " + displayPath(a.path);
                  div.innerHTML = tile + '<span class="art-main"><span class="art-name-row"><span class="art-name">' + esc(name) + "</span>" + artBadgeHtml(a, inGroup) + '</span><span class="art-meta" data-artifact-meta>' + metaParts.join("") + "</span></span>" +
                    '<span class="art-acts"><button class="art-act" type="button" data-af-view="' + esc(a.path) + '" title="在线预览" aria-label="在线预览 ' + esc(name) + '">' + svgUse("eye") + '</button><button class="art-act" type="button" data-af-dl="' + esc(a.path) + '" title="下载" aria-label="下载 ' + esc(name) + '">' + svgUse("download") + "</button></span>";
                  return div;
                }
                // #168 文件夹行：折叠箭头 + 品牌瓦片 + ×N 计数；次行「目录 · 尺寸 · 最近」；批量下载与 ⋯ 菜单随行
                function artGroupNode(g, cwd, open) {
                  const sec = document.createElement("section");
                  sec.className = "art-group" + (open ? "" : " collapsed");
                  sec.dataset.artifactGroup = g.dir;
                  const total = sizeStr(g.list.reduce((t, a) => t + (Number(a.size) || 0), 0));
                  const recent = relTime(Math.max(...g.list.map((a) => a.last_at || 0)));
                  const dirDisp = relDir(g.dir, cwd) || "工作目录";
                  const leaf = dirDisp.split(/[\\/]/).filter(Boolean).pop() || dirDisp;
                  // #158-批3 桌面壳专属：先探后开（probePath）再「在文件夹中定位」（openPath reveal）
                  const shellReveal = !!(window.ccDeck && typeof window.ccDeck.openPath === "function");
                  sec.innerHTML = '<div class="af-frow"><button class="art-folder" type="button" data-af-toggle aria-expanded="' + open + '"><span class="art-chev">▸</span><span class="art-tile k-dir">' + svgUse("folder") + '</span><span class="art-main"><span class="art-name-row"><span class="art-name">' + esc(leaf) + '</span><span class="art-badge b-cnt">×' + g.list.length + '</span></span><span class="art-meta"><span class="dir">' + esc(dirDisp) + "</span><span>" + total + "</span><span>最近 " + recent + '</span></span></span></button><button class="secondary-btn artifact-group-action" type="button" data-artifact-batch>批量下载</button><div class="artifact-menu-wrap"><button class="artifact-menu-button" type="button" aria-label="更多操作" data-artifact-menu-button>⋯</button><div class="artifact-menu"><button type="button" data-artifact-action="toggle">' + (open ? "收起目录" : "展开目录") + '</button>' + (shellReveal ? '<button type="button" data-artifact-action="reveal">在文件夹中定位</button>' : "") + '<button type="button" data-artifact-action="copy-path">复制路径</button></div></div></div><div class="art-kids"></div><div class="art-batch"><div class="artifact-batch-state" data-artifact-batch-state>尚未下载 · 仅组内文件</div></div>';
                  const kids = sec.querySelector(".art-kids");
                  for (const a of g.list) kids.appendChild(artFileNode(a, cwd, true));
                  return sec;
                }
                // #168 组开合态跨重渲记忆（会话切换重置；首轮默认展开第一组）
                let artOpenDirs = new Set(), artOpenSid = "", artOpenInit = false;
                function toggleArtGroup(grp) {
                  grp.classList.toggle("collapsed");
                  const open = !grp.classList.contains("collapsed");
                  if (open) artOpenDirs.add(grp.dataset.artifactGroup); else artOpenDirs.delete(grp.dataset.artifactGroup);
                  const tgl = grp.querySelector("[data-af-toggle]");
                  if (tgl) tgl.setAttribute("aria-expanded", open);
                  const mi = grp.querySelector('[data-artifact-action="toggle"]');
                  if (mi) mi.textContent = open ? "收起目录" : "展开目录";
                }
                function renderArtifacts() {
                  const pane = UI.panes[2];
                  const s = curSession();
                  if (!s) { pane.innerHTML = '<div class="readonly-banner">未选择会话</div>'; return; }
                  const arts = Array.isArray(s.artifacts) ? s.artifacts : [];
                  if (!arts.length) { pane.innerHTML = '<div class="pane-summary">输出物</div><div class="readonly-banner">暂无输出物（会话写入文件后登记）</div>'; return; }
                  if (artOpenSid !== s.session_id) { artOpenDirs = new Set(); artOpenSid = s.session_id; artOpenInit = false; }
                  const layout = artLayoutItems(arts);
                  if (!artOpenInit && layout.groups.length) { artOpenDirs.add(layout.groups[0].dir); artOpenInit = true; }
                  const wrap = document.createElement("div");
                  wrap.className = "artifact-browser";
                  // #168 汇总条简化：N 文件 · M 文件夹 + 全部下载（cwd 已在 workspace 头，不再挂 chip）
                  wrap.innerHTML = '<div class="af-cap">会话写入的交付物自动登记 · 单击行在线预览 · 悬停行尾下载 · 可按目录批量下载</div>' +
                    '<div class="af-sum"><span class="af-sum-n">' + layout.files.length + " 个文件" + (layout.groups.length ? ' <small>· ' + layout.groups.length + " 个文件夹</small>" : "") + '</span><span class="af-sum-sp"></span><button class="secondary-btn" type="button" data-af-all-dl>' + svgUse("download") + " 全部下载</button></div>" +
                    (s.artifacts_truncated ? '<div class="af-trunc">清单曾被 relay 截断，仅显示最近条目</div>' : "");
                  layout.groups.forEach((g) => wrap.appendChild(artGroupNode(g, s.cwd, artOpenDirs.has(g.dir))));
                  if (layout.loose.length) {
                    const loose = document.createElement("div");
                    loose.className = "art-loose";
                    for (const a of layout.loose) loose.appendChild(artFileNode(a, s.cwd, false));
                    wrap.appendChild(loose);
                  }
                  wrap.insertAdjacentHTML("beforeend", '<div class="af-foot">仅收录文档、表格、图片与安装包等交付物 · ' + layout.files.length + " 项已登记 · 清单来自来源会话实时同步</div>");
                  pane.textContent = "";
                  pane.appendChild(wrap);
                }
                function setBatchState(group, state, progress, completed, total) {
                  const node = group.querySelector("[data-artifact-batch-state]");
                  if (!node) return;
                  node.className = "artifact-batch-state" + (state === "complete" ? " complete" : state === "partial" ? " partial" : "");
                  if (state === "queued") node.innerHTML = "<span>已排队 · " + total + " 个文件</span>";
                  if (state === "downloading") node.innerHTML = "<span>已下载 " + completed + "/" + total + ' · 进行中</span><span class="artifact-batch-progress"><i style="width:' + progress + '%"></i></span>';
                  if (state === "partial") node.innerHTML = "<span>已下载 " + completed + " 个 · 有失败项</span>";
                  if (state === "complete") node.innerHTML = "<span>已下载 " + total + " 个文件</span>";
                }
                function downloadNode(fileEl, sid) {
                  const path = fileEl.dataset.path || "";
                  // #158-批3 桌面/浏览器分支显式：壳桥在场走 saveArtifact→openPath 落盘链，
                  // 否则保留 Blob+a.download；busy 占用直接拒绝（不进 catch 的失败态标记）
                  const viaShell = !!(window.ccDeck && typeof window.ccDeck.saveArtifact === "function");
                  if (viaShell && shellArtBusy) { b2Toast("上一个输出物还在下载中…"); return Promise.resolve(); }
                  const meta = fileEl.querySelector("[data-artifact-meta]");
                  const prev = meta ? meta.innerHTML : ""; // #168 次行是复合 span 结构，innerHTML 保真还原
                  if (meta) meta.textContent = "下载中…";
                  if (viaShell) shellArtBusy = true;
                  return fetchArtifact(sid, path).then(async (res) => {
                    if (!viaShell) { downloadArtifact(path, res); if (meta) meta.textContent = "已下载"; return; }
                    try {
                      const saved = await saveArtifactViaShell(path, res);
                      try { await window.ccDeck.openPath(saved, false); } catch (_) {} // 打开失败不算下载失败——路径已 toast
                      b2Toast("已下载并打开：" + saved);
                      if (meta) meta.textContent = "已下载";
                    } finally { shellArtBusy = false; }
                  }).catch((err) => {
                    if (viaShell) shellArtBusy = false;
                    if (meta) meta.innerHTML = prev;
                    fileEl.classList.add("failed");
                    // #168 失败≠删除：只加错误项+重试，不套 dead 删除线（两态分离）
                    const old = fileEl.querySelector(".art-err");
                    if (!old) fileEl.querySelector(".art-acts").insertAdjacentHTML("beforebegin", '<span class="art-err" title="' + esc(String(err.message || err)) + '">拉取失败</span><button class="art-retry" type="button" data-artifact-file-retry>重试</button>');
                    throw err;
                  });
                }
                // #168 runBatch 返回 Promise（全部下载按组串接）；组开合与重渲后 DOM 失效由调用方兜
                function runBatch(group) {
                  if (!group || group.dataset.batchRunning === "1") return Promise.resolve();
                  group.classList.remove("collapsed");
                  group.dataset.batchRunning = "1";
                  const files = [...group.querySelectorAll(".art-row")];
                  const total = files.length;
                  const btn = group.querySelector("[data-artifact-batch]");
                  if (btn) { btn.disabled = true; btn.textContent = "下载中…"; }
                  files.forEach((f) => { f.classList.remove("failed"); const e = f.querySelector(".art-err"), r = f.querySelector(".art-retry"); if (e) e.remove(); if (r) r.remove(); });
                  setBatchState(group, "queued", 0, 0, total);
                  const sid = S.selected;
                  return new Promise((finish) => {
                    let idx = 0, done = 0;
                    const advance = () => {
                      if (idx >= files.length) {
                        const failed = group.querySelectorAll(".art-row.failed").length;
                        setBatchState(group, failed ? "partial" : "complete", 100, done, total);
                        group.dataset.batchRunning = "0";
                        if (btn) { btn.disabled = false; btn.textContent = "批量下载"; }
                        b2Toast(failed ? "已下载 " + done + " 个 · " + failed + " 个失败可重试" : "已下载 " + total + " 个文件");
                        finish();
                        return;
                      }
                      const f = files[idx];
                      f.classList.add("downloading");
                      setBatchState(group, "downloading", Math.round((idx / total) * 100), done, total);
                      downloadNode(f, sid).then(() => { done++; }).catch(() => {}).finally(() => { f.classList.remove("downloading"); idx++; advance(); });
                    };
                    advance();
                  });
                }
                // #168 全部下载：组按序批量 + 散件串行；心跳重渲换 DOM，每步从 pane 现查
                let artAllDlRunning = false;
                function runAllDownloads() {
                  const pane = UI.panes[2];
                  if (!pane || artAllDlRunning) return;
                  artAllDlRunning = true;
                  const btn = pane.querySelector("[data-af-all-dl]");
                  if (btn) btn.disabled = true;
                  const groupsStep = (i) => {
                    const gs = [...pane.querySelectorAll("[data-artifact-group]")];
                    if (i >= gs.length) { looseStep(0); return; }
                    runBatch(gs[i]).then(() => groupsStep(i + 1));
                  };
                  const looseStep = (j) => {
                    const loose = [...pane.querySelectorAll(".art-loose .art-row")];
                    if (j >= loose.length) {
                      artAllDlRunning = false;
                      const b2 = pane.querySelector("[data-af-all-dl]");
                      if (b2) b2.disabled = false;
                      b2Toast("全部下载完成");
                      return;
                    }
                    downloadNode(loose[j], S.selected).catch(() => {}).finally(() => looseStep(j + 1));
                  };
                  groupsStep(0);
                }

                // ---------- #168 artViewer 桌面在线预览浮层：点行打开；md/文本渲染、图片直显、其他落下载提示 ----------
                const AV_MD_EXT = new Set(["md", "markdown"]);
                const AV_TEXT_EXTRA = new Set(["txt", "text", "log", "rst", "adoc", "asciidoc"]);
                let avPath = "", avCur = null, avObjUrl = "";
                function ensureArtViewer() {
                  let bd = document.getElementById("av-backdrop");
                  if (bd) return bd;
                  bd = document.createElement("div");
                  bd.className = "av-backdrop";
                  bd.id = "av-backdrop";
                  bd.setAttribute("role", "dialog");
                  bd.setAttribute("aria-modal", "true");
                  bd.setAttribute("aria-label", "输出物预览");
                  bd.innerHTML = '<div class="av-panel"><div class="av-bar"><span class="art-tile" id="av-tile"></span><span class="av-name" id="av-name"></span><span class="av-sub" id="av-sub"></span><span style="flex:1"></span><button class="secondary-btn" type="button" data-av-act="locate">在文件夹中定位</button><button class="primary-btn" type="button" data-av-act="download">下载</button><button class="icon-btn" type="button" data-av-act="close" aria-label="关闭预览">' + svgUse("x") + '</button></div><div class="av-body" id="av-body"></div></div>';
                  bd.addEventListener("click", (ev) => {
                    if (ev.target === bd) { closeArtViewer(); return; }
                    const retry = ev.target.closest("[data-av-retry]");
                    if (retry) { ev.stopPropagation(); loadAvContent(avCur); return; }
                    const act = ev.target.closest("[data-av-act]");
                    if (!act) return;
                    ev.stopPropagation();
                    if (act.dataset.avAct === "close") closeArtViewer();
                    else if (act.dataset.avAct === "download") {
                      const row = UI.panes[2] && UI.panes[2].querySelector('.art-row[data-path="' + cssEsc(avPath) + '"]');
                      if (row) downloadNode(row, S.selected).catch(() => {});
                    } else if (act.dataset.avAct === "locate") {
                      const dir = window.__ccDeck005PathUi.dirOf(avPath) || avPath;
                      if (!dir) { b2Toast("无目录可定位"); return; }
                      shellHasLocal(dir).then((local) => {
                        if (!local) { b2Toast("目录不在本机（远程会话产物），无法定位", 3500); return; }
                        window.ccDeck.openPath(dir, true).catch((er) => b2Toast(String((er && er.message) || er).slice(0, 80), 3500));
                      });
                    }
                  });
                  UI.section.appendChild(bd);
                  return bd;
                }
                function closeArtViewer() {
                  const bd = document.getElementById("av-backdrop");
                  if (bd) bd.classList.remove("open");
                  avPath = ""; avCur = null;
                  if (avObjUrl) { URL.revokeObjectURL(avObjUrl); avObjUrl = ""; }
                }
                function openArtViewer(path) {
                  const s = curSession();
                  if (!s) return;
                  const a = (Array.isArray(s.artifacts) ? s.artifacts : []).find((x) => x && x.path === path);
                  if (!a) { b2Toast("文件不在当前清单"); return; }
                  const bd = ensureArtViewer();
                  const name = baseName(path);
                  const kind = artifactKindFor(name);
                  avPath = path; avCur = a;
                  const tile = bd.querySelector("#av-tile");
                  tile.className = "art-tile k-" + kind;
                  tile.innerHTML = svgUse(artifactIconFor(name));
                  bd.querySelector("#av-name").textContent = name;
                  bd.querySelector("#av-sub").textContent = (a.size != null ? sizeStr(a.size) + " · " : "") + relTime(a.last_at || a.first_at);
                  bd.querySelector('[data-av-act="locate"]').style.display = (window.ccDeck && typeof window.ccDeck.openPath === "function") ? "" : "none";
                  bd.querySelector("#av-body").innerHTML = '<div class="av-load">拉取中…</div>';
                  bd.classList.add("open");
                  loadAvContent(a);
                }
                function loadAvContent(a) {
                  if (!a || avPath !== a.path) return;
                  const body = document.getElementById("av-body");
                  const name = baseName(a.path);
                  const ext = String(name || "").toLowerCase().split(".").pop();
                  const kind = artifactKindFor(name);
                  const asMd = AV_MD_EXT.has(ext);
                  const asImg = kind === "image";
                  const asText = asMd || AV_TEXT_EXTRA.has(ext) || kind === "doc" || kind === "sheet" || kind === "code";
                  const fb = (msg, withDl) => '<div class="av-fb"><span class="ok">' + svgUse("download") + "</span><span>" + esc(msg) + "</span>" + (withDl ? '<button class="primary-btn" type="button" data-av-act="download">下载到本机查看</button>' : "") + "</div>";
                  if (!asImg && !asText) { body.innerHTML = fb("此格式暂不支持在线预览（" + (ext || "无扩展名") + "）", true); return; }
                  if (a.size != null && a.size > 20 * 1048576) { body.innerHTML = fb("文件较大（" + sizeStr(a.size) + "），请下载后查看", true); return; }
                  fetchArtifact(S.selected, a.path).then((res) => {
                    if (avPath !== a.path) return; // 已切文件/关闭，弃置本轮回包
                    const bytes = artifactBytes(res);
                    if (asImg) {
                      if (avObjUrl) URL.revokeObjectURL(avObjUrl);
                      avObjUrl = URL.createObjectURL(new Blob([bytes], { type: res.mime || "image/" + ext }));
                      body.innerHTML = '<div class="av-imgwrap"><img class="av-img" src="' + avObjUrl + '" alt="预览 ' + esc(name) + '"></div>';
                    } else {
                      let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
                      if (text.length > 200000) text = text.slice(0, 200000) + "\n…（预览截断，完整内容请下载）";
                      body.innerHTML = asMd ? '<div class="av-md">' + mdHtml(text) + "</div>" : '<pre class="av-pre">' + esc(text) + "</pre>";
                    }
                  }).catch((err) => {
                    if (avPath !== a.path) return;
                    body.innerHTML = '<div class="av-fb"><span class="ok err">✕</span><span>拉取失败：' + esc(String(err.message || err)).slice(0, 120) + '</span><button class="secondary-btn" type="button" data-av-retry>重试</button></div>';
                  });
                }

                // ---------- 渲染：更多 tab（用量 + 统计键值行，四 tab 制：追加令3 合并原用量/更多） ----------
                function renderMore() {
                  const pane = UI.panes[3];
                  const s = curSession();
                  if (!s) { pane.innerHTML = '<div class="readonly-banner">未选择会话</div>'; return; }
                  let html = '<div class="detail-panel-list">';
                  // 上部：ctxMeter 水位计
                  if (s.context_usage) html += ctxMeterHtml(s);
                  else html += '<div class="pane-summary">用量</div><div class="readonly-banner">用量未随该会话下发</div>';
                  // W-CTXFIX B3：压缩前状态摘要（有摘要才渲染，原生 details 默认折叠）
                  if (s.pre_compact_summary) html += '<details class="pcsum"><summary>压缩前状态摘要<span>已自动注入恢复</span></summary><pre>' + esc(s.pre_compact_summary) + "</pre></details>";
                  // 本回合时长 + 输入输出 tokens（原 .metric 改普通键值行）
                  if (s.status === "WORKING" && s.turn_started_at) html += '<div class="kv-row"><b>' + fmtDur(Math.max(0, Date.now() - s.turn_started_at)) + "</b><span>本回合已运行</span></div>";
                  const u = s.usage;
                  if (u && (u.input_tokens || u.output_tokens)) html += '<div class="kv-row"><b>' + tokStr((u.input_tokens || 0) + (u.output_tokens || 0)) + "</b><span>本回合 tokens（入 " + tokStr(u.input_tokens || 0) + " · 出 " + tokStr(u.output_tokens || 0) + "）</span></div>";
                  html += "</div>"; // 关闭 detail-panel-list
                  // 下部：统计键值行全量（追加令2 新增字段）
                  html += '<div class="more-section"><h4 class="more-section-title">会话信息</h4>';
                  const statusLabel = { WORKING: "运行中", WAITING: "等待确认", DONE: "已完成", ERROR: "错误", CLOSING: "结束中" }[s.status] || s.status || "—";
                  html += '<div class="kv-row"><b>' + esc(statusLabel) + "</b><span>状态</span></div>";
                  html += '<div class="kv-row"><b>' + esc(shortPath(s.cwd) || "—") + "</b><span>目录</span></div>";
                  const eng = engineMetaOf(s); // W-ENGLM D/E：共享解析（glm 入表；未收录显示原名不错显 Claude）
                  html += '<div class="kv-row"><b>' + esc(eng[0]) + (s.model ? " · " + esc(s.model) : "") + "</b><span>引擎·模型</span></div>";
                  const permMode = s.permission_mode || "—";
                  html += '<div class="kv-row"><b>' + esc(permMode) + "</b><span>权限模式</span></div>";
                  if (s.started_at) html += '<div class="kv-row"><b>' + relTime(s.started_at) + "</b><span>开始时间</span></div>";
                  if (s.finished_at && s.started_at) html += '<div class="kv-row"><b>' + fmtDur(s.finished_at - s.started_at) + "</b><span>用时</span></div>";
                  html += "</div>"; // 关闭会话信息节
                  // W-EXPP2 经验注入分节（设计 §7.1 两处详情视图之一）：该会话角色×项目
                  // 会注入的条目视图（与 relay matchPredicate 同源谓词：active + 角色轴
                  // any|engine_role + 项目轴 global|锚点）。派单承接会话才注入（engine_role
                  // 缺席=Leader/用户会话，设计开放问题 4 不喂）；经验域未随快照=旧 relay 隐节
                  if (Array.isArray(S.experiences)) {
                    html += '<div class="more-section"><h4 class="more-section-title">经验注入</h4>';
                    if (!s.engine_role) {
                      html += '<div class="kv-row"><b>—</b><span>非派单承接会话，不注入团队经验</span></div>';
                    } else {
                      const expAnchor = (() => {
                        const norm = (v) => String(v || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
                        const hit = (S.projects || []).find((p) => norm(p.anchor_dir) && s.cwd && norm(s.cwd).startsWith(norm(p.anchor_dir)));
                        return hit ? norm(hit.anchor_dir) : norm(s.cwd);
                      })();
                      const hits = S.experiences.filter((e) => e.status === "active"
                        && (e.role_scope === "any" || e.role_scope === String(s.engine_role).toLowerCase())
                        && (e.project_scope === "global" || e.project_scope.replace(/\/+$/, "") === expAnchor));
                      if (!hits.length) {
                        html += '<div class="kv-row"><b>0 条</b><span>当前角色×项目无可注入经验</span></div>';
                      } else {
                        const expKind = { pitfall: "坑", practice: "法", preference: "好", fact: "实" };
                        for (const e of hits.slice(0, 12)) {
                          html += '<div class="kv-row"><b><span class="tag ' + (e.kind === "pitfall" ? "danger" : e.kind === "practice" ? "done" : e.kind === "preference" ? "info" : "") + '" style="margin-right:5px">' + esc(expKind[e.kind] || e.kind) + "</span>" + esc(e.text) + "</b><span>" + esc((e.role_scope === "any" ? "通用" : e.role_scope) + " · " + (e.project_scope === "global" ? "全局" : "本项目") + " · 用 " + (Number(e.use_count) || 0) + " 次") + "</span></div>";
                        }
                        if (hits.length > 12) html += '<div class="kv-row"><b>…</b><span>其余 ' + (hits.length - 12) + " 条按权重择优注入</span></div>";
                      }
                    }
                    html += "</div>";
                  }
                  html += '<div class="more-section"><h4 class="more-section-title">用量统计</h4>';
                  const changes = s.file_changes || {};
                  const fileCount = (changes.added || 0) + (changes.modified || 0);
                  if (fileCount > 0) html += '<div class="kv-row"><b>' + fileCount + "</b><span>修改文件数</span></div>";
                  const lineAdd = changes.lines_added || 0, lineDel = changes.lines_deleted || 0;
                  if (lineAdd || lineDel) html += '<div class="kv-row"><b>+' + lineAdd + " / −" + lineDel + "</b><span>增删行数</span></div>";
                  const todos = Array.isArray(s.todos) ? s.todos.filter(Boolean) : [];
                  if (todos.length) html += '<div class="kv-row"><b>' + todos.length + " 项</b><span>任务清单</span></div>";
                  if (u && (u.input_tokens || u.output_tokens)) {
                    html += '<div class="kv-row"><b>' + tokStr(u.input_tokens || 0) + " / " + tokStr(u.output_tokens || 0) + "</b><span>输入 / 输出 token</span></div>";
                    if (u.cache_read_tokens || u.cache_creation_tokens) html += '<div class="kv-row"><b>' + tokStr(u.cache_read_tokens || 0) + " / " + tokStr(u.cache_creation_tokens || 0) + "</b><span>缓存读 / 写</span></div>";
                  }
                  if (s.finish_reason) html += '<div class="kv-row"><b>' + esc(s.finish_reason) + "</b><span>结束原因</span></div>";
                  html += "</div>"; // 关闭用量统计节
                  html += '<div class="more-section"><h4 class="more-section-title">标识</h4>';
                  html += '<div class="kv-row kv-row-copy" data-copy-session-id="' + esc(s.session_id) + '"><b>' + esc(String(s.session_id || "").slice(0, 16)) + '…</b><span>Session ID</span><button class="kv-copy-btn" type="button" title="复制 Session ID" aria-label="复制 Session ID">⧉</button></div>';
                  if (s.relay_session_id) html += '<div class="kv-row kv-row-copy" data-copy-relay-session-id="' + esc(s.relay_session_id) + '"><b>' + esc(String(s.relay_session_id).slice(0, 16)) + '…</b><span>SDK 会话</span><button class="kv-copy-btn" type="button" title="复制 SDK 会话 ID" aria-label="复制 SDK 会话 ID">⧉</button></div>';
                  html += "</div>"; // 关闭标识节
                  if (s.status === "DONE" || s.status === "ERROR") html += '<button class="danger-btn" type="button" data-session-delete style="margin-top:14px">删除会话</button>';
                  pane.innerHTML = html;
                }
                function confirmDelete() {
                  const s = curSession();
                  if (!s) return;
                  commandAck("COMMAND_DELETE", { session_id: s.session_id }).then((ack) => {
                    const v = ackVerdict(ack);
                    b2Toast(v.ok ? "已删除会话" : "删除失败：" + v.error);
                  });
                }

                function renderAll() {
                  if (!UI) return;
                  renderHeader();
                  renderDock();
                  renderConversation();
                  renderTasks();
                  renderArtifacts();
                  renderMore();
                  renderInspector();
                  syncComposerState();
                }

                // ---------- 输入栏（发送/停止/历史/附件）——#169：发送常驻+停止独立，WORKING 双钮并存 ----------
                function syncComposerState() {
                  const s = curSession();
                  const editable = !!(s && canCmd(s));
                  // #221 同族②（W-INJECT3 扩展）：running 加活性时限——status WORKING 停滞
                  // （外部会话 Stop 帧丢失时 relay status 滞留，与 enter/快照判定同族的回合
                  // 结束感知缺口）超过 3 分钟无任何日志帧 → 输入条按空闲显示（CLI 实态等待
                  // 输入，不吓用户「发送将排队」）；status 数据不动（其余面板仍显 relay 真值）
                  const staleWorking = s && s.status === "WORKING" && (Date.now() - Number(s.updated_at || 0) > 180_000);
                  const running = !!(editable && !staleWorking && (s.status === "WORKING" || s.status === "WAITING"));
                  if (UI.stopBtn) UI.stopBtn.hidden = !running; // 停止只在运行中出现（旧壳 #124 语义），不再占用发送钮
                  UI.sendBtn.disabled = !editable || !(UI.input.value.trim() || S.staged.length); // 常驻判空：运行中有内容仍可发（排队链）
                  UI.sendBtn.title = running ? "发送（运行中发送将排队，回合结束后自动发送）" : "发送（Enter）";
                  UI.input.disabled = !editable;
                  // B20 placeholder 承载附件/历史提示（hint 小字行退役）：按会话态给可用性指引
                  UI.input.placeholder = !editable ? (s ? "历史会话只读" : "先从左侧选择会话") : running ? "运行中 · 发送将排队，回合结束后自动发出" : "拖入/粘贴即附 · ↑↓ 翻阅 · Shift+Enter 换行";
                  autoGrowSessionInput(); // 件八：随内容长高（发送清空/历史翻阅/切会话草稿恢复后都经此收口）
                }
                function autoGrowSessionInput() { // 件八：textarea 自动长高（手机 input 宿主跳过）
                  const el = UI.input;
                  if (!el || el.tagName !== "TEXTAREA") return;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 132) + "px";
                }
                // W-PORT-A R-4：echo 三路生命周期 helper——选中判定 / 失败标记 / 惰性超时清理（渲染时顺带）
                function sidIsSelected(sid) { return UI && S.selected === sid; }
                function markEchoFail(sid, text) {
                  const eq = S.echo.get(sid);
                  if (!eq || !eq.length) return;
                  const i = eq.findIndex((x) => x.state === "sending" && x.text === text);
                  if (i >= 0) { eq[i].state = "fail"; eq[i].ts = Date.now(); if (sidIsSelected(sid)) renderConversation(); }
                }
                function echoSweep(sid) { // 惰性清理：sending 30s 无回显 / fail 15s 展示窗 → 自撤
                  const eq = S.echo.get(sid);
                  if (!eq) return false;
                  const now = Date.now();
                  const keep = eq.filter((x) => now - x.ts < (x.state === "fail" ? 15_000 : 30_000));
                  if (keep.length === eq.length) return false;
                  if (keep.length) S.echo.set(sid, keep); else S.echo.delete(sid);
                  return true;
                }
                function sendMessage() {
                  const s = curSession();
                  if (!s) { b2Toast("先从左侧选择会话"); return; }
                  if (!canCmd(s)) { b2Toast("历史会话只读"); return; }
                  const text = UI.input.value.trim();
                  const imgs = S.staged.filter((f) => f.isImg).map((f) => f.b64);
                  const files = S.staged.filter((f) => !f.isImg).map((f) => ({ name: f.name, b64: f.b64 }));
                  if (!text && !imgs.length && !files.length) return;
                  if (imgs.length > IMG_MAX || files.length > FILE_MAX) { b2Toast("附件超限（图 " + IMG_MAX + " / 文件 " + FILE_MAX + "）"); return; }
                  const payload = Object.assign({ session_id: s.session_id, text }, imgs.length ? { images: imgs } : {}, files.length ? { files } : {});
                  const id = sendCmd(s.external ? "COMMAND_EXT_INPUT" : "COMMAND_MESSAGE", payload);
                  if (id) {
                    // W-PORT-A R-4 发送乐观回显：0.5s 内本地气泡占位（手机件五同款语义，桌面简化为
                    // 回显对账+ACK 失败标记+超时自撤三路）——relay 回显到达即撤（onLog 对账），
                    // ACK 失败/超时转「未送达」红角标，15s 后自撤防永久假消息
                    if (text) {
                      const eq = S.echo.get(s.session_id) || [];
                      eq.push({ key: "echo-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), text, ts: Date.now(), state: "sending" });
                      S.echo.set(s.session_id, eq);
                      if (sidIsSelected(s.session_id)) renderConversation();
                    }
                    const sendFail = (ack) => { const v = ackVerdict(ack); if (!v.ok) { b2Toast("发送失败: " + v.error); markEchoFail(s.session_id, text); } }; // #150 R3：自发命令失败回执（R2 删无主 toast 后补漏——超时 null/ok:false 才 toast，成功静默；输入框清空维持现状不并入 waiter）+ R-4 失败转未送达
                    const wd = setTimeout(() => { if (S.ackWaiters.has(id)) { S.ackWaiters.delete(id); sendFail(null); } }, 10000);
                    S.ackWaiters.set(id, { res: sendFail, t: wd });
                    UI.input.value = "";
                    slashHide(); // W-SLASH：程序清空不发 input 事件，浮层显式收起
                    // 件十九修正：发消息不置 forceScroll——贴底/保位统一交 renderConversation 的
                    // bottom-anchor（用户在底→新消息跟随贴底；离底读历史→原位保持+回底 FAB 未亮点）
                    inputDrafts.delete(s.session_id); // #B3-4 已发出的不再算草稿
                    if (text) histPush(text);
                    S.hist.idx = -1;
                    S.staged = [];
                    renderTray();
                    if (s.external && s.status === "WAITING") b2Toast("已排队，回合结束后自动发送");
                  }
                  syncComposerState();
                  UI.input.focus();
                }
                function stopSession() {
                  const s = curSession();
                  if (!s) return;
                  commandAck(s.external ? "COMMAND_EXT_STOP" : "COMMAND_STOP", { session_id: s.session_id }).then((ack) => {
                    const v = ackVerdict(ack);
                    if (!v.ok) b2Toast("停止未确认：" + v.error);
                  });
                }
                // 输入历史（v1 readline 口径：起翻=空输入或光标在首；↓ 翻过最新还原草稿）
                function histLoad(sid) {
                  const h = S.hist;
                  if (h.sid === sid) return;
                  h.sid = sid; h.idx = -1; h.draft = ""; h.list = [];
                  if (!sid) return;
                  try { const raw = JSON.parse(localStorage.getItem(HIST_PREFIX + sid) || "[]"); if (Array.isArray(raw)) h.list = raw.filter((x) => typeof x === "string"); } catch (_) {}
                }
                function histPush(text) {
                  const h = S.hist;
                  h.idx = -1;
                  if (!text || h.list[h.list.length - 1] === text) return;
                  h.list.push(text);
                  if (h.list.length > HIST_MAX) h.list.shift();
                  if (h.sid) { try { localStorage.setItem(HIST_PREFIX + h.sid, JSON.stringify(h.list)); } catch (_) {} }
                }
                function histKeydown(ev) {
                  if (ev.isComposing || ev.keyCode === 229) return;
                  if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
                  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
                  const h = S.hist, el = ev.target;
                  if (ev.key === "ArrowUp") {
                    if (!h.list.length) return;
                    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
                    if (h.idx < 0 && el.value !== "" && !atStart) return;
                    ev.preventDefault();
                    if (h.idx < 0) { h.draft = el.value; h.idx = h.list.length - 1; }
                    else if (h.idx > 0) h.idx--;
                    el.value = h.list[h.idx];
                    el.setSelectionRange(el.value.length, el.value.length);
                  } else {
                    if (h.idx < 0) return;
                    ev.preventDefault();
                    h.idx++;
                    if (h.idx >= h.list.length) { h.idx = -1; el.value = h.draft; }
                    else el.value = h.list[h.idx];
                    el.setSelectionRange(el.value.length, el.value.length);
                  }
                  syncComposerState();
                }
                // 附件（#79 三入口：clip 选择 / paste / 拖入；图片 canvas 压缩 JPEG ≤1568 q0.82）
                function compressImageFile(file) {
                  return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(file);
                    const img = new Image();
                    const finish = (fn, arg) => { URL.revokeObjectURL(url); fn(arg); };
                    img.onload = () => {
                      try {
                        const long = Math.max(img.naturalWidth || 1, img.naturalHeight || 1);
                        const scale = long > 1568 ? 1568 / long : 1;
                        const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
                        const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
                        const cv = document.createElement("canvas");
                        cv.width = w; cv.height = h;
                        const cx = cv.getContext("2d");
                        if (!cx) throw new Error("no ctx");
                        cx.fillStyle = "#fff";
                        cx.fillRect(0, 0, w, h);
                        cx.drawImage(img, 0, 0, w, h);
                        const b64 = cv.toDataURL("image/jpeg", 0.82).split(",")[1];
                        if (!b64 || b64.length < 32) throw new Error("empty");
                        finish(resolve, b64);
                      } catch (e) { finish(reject, e); }
                    };
                    img.onerror = () => finish(reject, new Error("decode"));
                    img.src = url;
                  });
                }
                function readFileB64(file) {
                  return new Promise((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => { const raw = String(r.result || "").slice(String(r.result || "").indexOf(",") + 1); raw ? resolve(raw) : reject(new Error("0 字节")); };
                    r.onerror = () => reject(new Error("read fail"));
                    r.readAsDataURL(file);
                  });
                }
                async function stageFiles(files, sidHint) { // #169 sidHint：手机路径借道（桌面文档级拖放在手机态无 S.selected）
                  const s = (sidHint && S.sessions.get(sidHint)) || curSession();
                  if (!s || !canCmd(s)) { b2Toast("当前会话不支持附件"); return; }
                  for (const f of [...(files || [])].filter(Boolean)) {
                    const isImg = /^image\//.test(f.type || "");
                    if (isImg) {
                      if (S.staged.filter((x) => x.isImg).length >= IMG_MAX) { b2Toast("最多 " + IMG_MAX + " 张图片"); continue; }
                      try { const b64 = await compressImageFile(f); S.staged.push({ name: f.name || "图片", isImg: true, b64, url: "data:image/jpeg;base64," + b64 }); }
                      catch (_) { b2Toast("「" + String(f.name || "图片").slice(0, 24) + "」无法解码（HEIC 等格式浏览器不支持）"); }
                    } else {
                      if (S.staged.filter((x) => !x.isImg).length >= FILE_MAX) { b2Toast("最多同时带 " + FILE_MAX + " 个文件"); continue; }
                      if (f.size > FILE_SIZE_MAX) { b2Toast(String(f.name || "文件") + " 超过 20MB，未添加"); continue; }
                      try { const b64 = await readFileB64(f); S.staged.push({ name: f.name || "文件", isImg: false, b64, url: "" }); }
                      catch (_) { b2Toast("「" + String(f.name || "文件") + "」读取失败"); }
                    }
                  }
                  renderTray();
                  syncComposerState();
                  try { window.dispatchEvent(new Event("ccdeck:staged")); } catch (_) {} // #169 手机路径监听同步发送态
                }
                function renderTray() {
                  // #169 双宿主：桌面与手机 composer 各渲染一份暂存架（同一 S.staged 数据源）
                  const hosts = [UI.composer, document.querySelector('[data-composer="mobile"]')].filter(Boolean);
                  for (const composer of hosts) {
                    let tray = composer.querySelector(".composer-tray");
                    if (!S.staged.length) { tray && tray.remove(); continue; }
                    if (!tray) {
                      tray = document.createElement("div");
                      tray.className = "composer-tray";
                      tray.setAttribute("role", "list");
                      tray.setAttribute("aria-label", "待发送附件");
                      // W-UIPOLISH4 件二：session 宿主架子钉在输入框上方（.composer-top 之前，
                      // 消息流与输入框之间）；手机宿主维持尾部追加（行式布局自包裹不受影响）
                      const top = composer.querySelector(':scope > .composer-top');
                      if (top) composer.insertBefore(tray, top); else composer.appendChild(tray);
                    }
                    tray.innerHTML = S.staged.map((f, i) => '<span class="composer-tray-item" role="listitem">' + (f.isImg && f.url ? '<img class="composer-tray-thumb" src="' + f.url + '" alt="">' : svgUse("clip")) + '<span class="composer-tray-name">' + esc(f.name) + '</span><button class="composer-tray-x" type="button" data-tray-remove="' + i + '" title="移除附件" aria-label="移除附件 ' + esc(f.name) + '">×</button></span>').join("");
                  }
                }

                // ---------- 「+」新建：#75 引擎选择菜单 ----------
                function catalogEntries() {
                  if (S.engineCatalog && S.engineCatalog.length) return S.engineCatalog;
                  return [{ id: "claude", label: "Claude", state: "ready", preflight: { state: "pass", reason: "" }, models: S.models }];
                }
                function defaultEngineId() { const ready = catalogEntries().find((e) => e.state === "ready"); return ready ? ready.id : "claude"; }
                function engineStateText(e) {
                  if (e.state === "ready") return e.models && e.models.length ? e.models.length + " 个模型" : "已就绪 · 使用引擎默认";
                  if (e.state === "needs_auth") return "未登录 · " + oneLine(e.auth_hint || "请先完成引擎登录"); // #102 批 A：装了没登录——黄点+指引
                  if (e.state === "unsupported") return "不支持 · " + ((e.preflight && e.preflight.reason) || "占位");
                  return "不可用 · " + oneLine((e.preflight && e.preflight.reason) || "未探测到");
                }
                // #368（旧壳 8781-8794 口径）：cwd 预填「上次创建用的目录」优先，无记忆回落
                // 活动源用户根目录。005 单源——单键记忆（不与旧壳 ccr_cwd@id 多源键纠缠）
                const CWD_LAST_KEY = "cc-deck-005-last-cwd";
                function lastCreateCwd() { try { return localStorage.getItem(CWD_LAST_KEY) || ""; } catch (_) { return ""; } }
                // #158-批3 桌面壳原生目录选择（旧壳 8760-8778 范式）：dialog 插件在场且当前源
                // 是本机 loopback relay 才给浏览钮（远程源选本机目录无意义，隐藏）
                function createCwdBrowseable() {
                  return !!(window.__TAURI__ && window.__TAURI__.dialog
                    && typeof window.__ccDeck005LocalRelayLoopback === "function" && window.__ccDeck005LocalRelayLoopback());
                }
                async function pickCreateCwd() {
                  if (!(window.__TAURI__ && window.__TAURI__.dialog)) return;
                  if (!(typeof window.__ccDeck005LocalRelayLoopback === "function" && window.__ccDeck005LocalRelayLoopback())) {
                    b2Toast("当前新建目标是其他电脑的源，请直接输入那台电脑上的路径");
                    return;
                  }
                  try {
                    const pop = document.getElementById("b2-create-pop");
                    const input = pop && pop.querySelector("[data-create-field='cwd']");
                    const cur = input ? input.value.trim() : "";
                    const dir = await window.__TAURI__.dialog.open({
                      directory: true, multiple: false, title: "选择工作目录",
                      ...(cur ? { defaultPath: cur } : {}),
                    });
                    if (typeof dir === "string" && dir) {
                      if (input) input.value = dir;
                      const p = pop && pop.querySelector("[data-create-field='prompt']");
                      if (p) p.focus();
                    }
                  } catch (e) { b2Toast("打开目录选择器失败: " + ((e && e.message) || e)); }
                }
                // B10 历史目录：MRU 列表（≤8 去重），旧单键记忆（#368）并入首选项
                const CWD_HISTORY_KEY = "cc-deck-005-cwd-history";
                function createCwdHistory() {
                  let arr = [];
                  try {
                    const v = JSON.parse(localStorage.getItem(CWD_HISTORY_KEY) || "[]");
                    if (Array.isArray(v)) arr = v.filter((x) => typeof x === "string" && x);
                  } catch (_) {}
                  const last = lastCreateCwd();
                  if (last && !arr.includes(last)) arr.unshift(last);
                  return arr.slice(0, 8);
                }
                function pushCreateCwd(dir) {
                  const d = String(dir || "").trim();
                  if (!d) return;
                  try { localStorage.setItem(CWD_LAST_KEY, d); } catch (_) {}
                  try { localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify([d, ...createCwdHistory().filter((x) => x !== d)].slice(0, 8))); } catch (_) {}
                }
                // B10 模型二层：引擎目录 models 优先，claude 回落 SNAPSHOT S.models（与 B22 胶囊同源）
                function createModelsFor(eng) {
                  const entry = catalogEntries().find((e) => e.id === eng);
                  const list = entry && Array.isArray(entry.models) && entry.models.length ? entry.models : (eng === "claude" && Array.isArray(S.models) ? S.models : []);
                  return list.filter((m) => typeof m === "string" && m).slice(0, 24);
                }
                function buildCreateHtml() {
                  const chosen = S.engineChoice || defaultEngineId();
                  let html = '<h3>新建会话</h3><p class="create-sub">选择引擎与工作目录，创建新会话</p>';
                  // W-PORT-A R-2：聚合/云链在线时透出「创建到」目标源行（手机 NewSessionModal 批3 同语义——
                  // 聚合视角下新建不再只能落当前视角源，云源在线即可选云）
                  {
                    const st = (window.__ccDeck005SourceState && window.__ccDeck005SourceState()) || null;
                    if (st && st.cloudPaired && st.cloudStatus === "online") {
                      const lanName = String(S.relayName || location.host || "本机");
                      const cloudName = String(st.cloudRelayName || st.cloudWsUrl || "远程源");
                      html += '<div class="create-label">创建到</div><select class="create-field" data-create-field="source" aria-label="目标源">'
                        + '<option value="local">本机 · ' + esc(lanName) + "</option>"
                        + '<option value="cloud">远程 · ' + esc(cloudName) + "</option>"
                        + "</select>";
                    }
                  }
                  // 件九：引擎墙退役——收起态一枚胶囊（状态点·引擎徽章·可用性小字），
                  // 分组浮层走 openEngineMenu（可用置顶 / 不可用灰置+原因），引擎区六行 → 一行
                  {
                    // W-PORT-A R-7：auto 档（跟随源默认）——选中态收起胶囊显「自动」，与手机 75-E
                    // 「auto=不发 engine，relay 按 role/源默认」同口径；显式选引擎维持件九形态
                    const isAuto = chosen === "auto";
                    const entry = isAuto ? null : (catalogEntries().find((e) => e.id === chosen) || catalogEntries()[0] || null);
                    const meta = entry ? (ENGINES[entry.id] || [entry.label || entry.id, ""]) : ["自动", "claude"];
                    const readyCount = catalogEntries().filter((e) => e.state === "ready").length;
                    // #102 批 A：胶囊状态点三色——绿 ready / 黄 needs_auth（未登录）/ 灰 其余不可用
                    const dotCls = !isAuto && entry ? (entry.state === "needs_auth" ? " warn" : entry.state !== "ready" ? " na" : "") : "";
                    html += '<div class="create-label">引擎</div>'
                      + '<button type="button" class="engine-picker" data-engine-trigger aria-haspopup="menu" aria-expanded="false"><span class="ep-dot' + dotCls + '"></span><span class="engine-badge ' + meta[1] + '">' + esc(isAuto ? "自动" : meta[0]) + '</span><span class="ep-meta">' + esc(isAuto ? "跟随源默认 · " + readyCount + " 个引擎可用" : (entry ? engineStateText(entry) : "无引擎数据") + (readyCount > 1 ? ' · 另 ' + (readyCount - 1) + ' 个可用' : "")) + '</span><svg class="cap-chev" aria-hidden="true"><use href="#icon-chev-down"></use></svg></button>';
                  }
                  html += '<div class="create-label">模型</div><select class="create-field" data-create-field="model" aria-label="模型（缺省用引擎默认）"' + (createModelsFor(chosen).length ? "" : " disabled aria-disabled=\"true\"") + "><option value=\"\">默认模型</option>"
                    + (() => { // FB15：上次用的模型在同清单内则预选
                      let lastModel = null;
                      try { lastModel = localStorage.getItem("cc-deck-005-last-model"); } catch (_) {}
                      const models = createModelsFor(chosen);
                      if (lastModel && !models.includes(lastModel)) lastModel = null;
                      return models.map((m) => '<option value="' + esc(m) + '"' + (m === lastModel ? " selected" : "") + '>' + esc(m) + "</option>").join("");
                    })() + "</select>";
                  html += '<div class="create-label">初始指令</div><input class="create-field" data-create-field="prompt" placeholder="让新会话做的第一件事（必填）" aria-label="初始指令">';
                  // #368 预填优先级：上次创建用的目录 > 源用户根目录；桌面+本机源时附原生目录浏览钮；
                  // B10 历史目录走 datalist（输入即建议，不占常驻行）
                  html += '<div class="create-label">工作目录</div><div class="create-row"><input class="create-field" data-create-field="cwd" list="b2-create-cwd-list" placeholder="工作目录" aria-label="工作目录" value="' + esc(lastCreateCwd() || S.homedir || "") + '">'
                    + (createCwdBrowseable() ? '<button class="create-browse" type="button" data-create-browse>浏览…</button>' : "") + '</div>'
                    + '<datalist id="b2-create-cwd-list">' + createCwdHistory().map((d) => '<option value="' + esc(d) + '"></option>').join("") + "</datalist>";
                  html += '<div class="create-checks"><label class="create-check"><input type="checkbox" data-create-field="skipPerm">跳过权限确认</label><label class="create-check"><input type="checkbox" data-create-field="autoMkdir">目录不存在时自动创建</label></div>';
                  html += '<div class="create-actions"><button class="secondary-btn" type="button" data-create-cancel>取消</button><button class="primary-btn" type="button" data-create-submit>创建会话</button></div>';
                  return html;
                }
                // W-PERMERR：权限拒绝文案兜底——新 relay 返回中文+指引；旧 relay 仍回
                // `forbidden: <reason>` 英文码，此处翻译已知码（双端不同版本过渡期兼容）
                function permErrText(raw) {
                  const s = String(raw || "");
                  const T = {
                    "production_bypass_denied": "已按安全策略拒绝「跳过权限确认」——当前连接的是生产服务，取消勾选可直接创建；确需跳过，请在终端运行 org auth-bypass on 授权后重试",
                    "env_unknown_bypass_denied": "已按安全策略拒绝「跳过权限确认」——无法确认工作目录安全域，取消勾选可直接创建；确需跳过，请在终端运行 org auth-bypass on 授权后重试",
                    "above_role_tier_ceiling": "所选权限档位超出允许上限，请改选较低档位",
                  };
                  for (const k of Object.keys(T)) if (s.indexOf(k) >= 0) return T[k];
                  return s || "未知错误";
                }
                function openCreatePop() {
                  closeCreatePop();
                  // FB15 智能默认：上次创建用的引擎优先（仍 ready 才算数），否则首个 ready 引擎
                  if (!S.engineChoice) {
                    let lastEng = null;
                    try { lastEng = localStorage.getItem("cc-deck-005-last-engine"); } catch (_) {}
                    S.engineChoice = lastEng === "auto" ? "auto" : (lastEng && catalogEntries().some((e) => e.id === lastEng && e.state === "ready") ? lastEng : defaultEngineId()); // R-7：auto 记忆直取（不查 ready）
                  }
                  const back = document.createElement("div");
                  back.className = "pair-pop-backdrop";
                  back.dataset.createBack = "";
                  const pop = document.createElement("div");
                  pop.id = "b2-create-pop";
                  pop.className = "create-pop";
                  pop.setAttribute("role", "dialog");
                  pop.setAttribute("aria-modal", "true");
                  pop.setAttribute("aria-label", "新建会话");
                  pop.innerHTML = buildCreateHtml();
                  back.addEventListener("click", closeCreatePop);
                  pop.addEventListener("click", (ev) => {
                    const trig = ev.target.closest("[data-engine-trigger]"); // 件九：胶囊开合引擎浮层
                    if (trig) { const m = document.getElementById("b2-engine-menu"); if (m) closeEngineMenu(); else { openEngineMenu(trig); trig.setAttribute("aria-expanded", "true"); } return; }
                    const engine = ev.target.closest("[data-engine-choice]");
                    if (engine) { pickEngine(engine); return; }
                    const loginRow = ev.target.closest("[data-engine-login]"); // #102 批 B：未登录引擎行 → 弹登录卡
                    if (loginRow) { closeEngineMenu(); if (window.__ccDeck005LoginCard) window.__ccDeck005LoginCard.open(loginRow.dataset.engineLogin || ""); return; }
                    if (ev.target.closest("[data-create-browse]")) { void pickCreateCwd(); return; }
                    if (ev.target.closest("[data-create-cancel]")) { closeCreatePop(); return; }
                    if (ev.target.closest("[data-create-submit]")) { submitCreate(); return; }
                  });
                  pop.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter" && ev.target.tagName === "INPUT" && ev.target.dataset.createField) { ev.preventDefault(); submitCreate(); }
                  });
                  document.body.append(back, pop);
                  const prompt = pop.querySelector("[data-create-field='prompt']");
                  if (prompt) prompt.focus();
                  // W-PERMERR：勾选「跳过权限确认」即时预警——生产/云连接下此勾选会被
                  // relay 权限闸拒绝（1016 实锤），提前一行 hint 让用户知情（提交仍走
                  // relay 裁决，双保险）；非生产连接零打扰
                  const skipBox = pop.querySelector("[data-create-field='skipPerm']");
                  if (skipBox) skipBox.addEventListener("change", () => {
                    let hint = pop.querySelector("[data-perm-hint]");
                    const prodConn = location.port === "8787" || !!(window.__ccDeck005CloudUI && window.__ccDeck005CloudUI.active());
                    if (!(skipBox.checked && prodConn)) { if (hint) hint.remove(); return; }
                    if (!hint) {
                      hint = document.createElement("div");
                      hint.dataset.permHint = "";
                      hint.style.cssText = "margin:6px 0 0;font-size:var(--fs-C);color:var(--working);line-height:1.5";
                      hint.textContent = "当前连接的是生产服务，「跳过权限确认」需先授权，直接创建会被拒——可取消勾选，或终端运行 org auth-bypass on 授权";
                      pop.querySelector(".create-checks")?.after(hint);
                    }
                  });
                }
                function closeCreatePop() { closeEngineMenu(); document.querySelectorAll("#b2-create-pop, [data-create-back]").forEach((el) => el.remove()); } // 件九：浮层随弹窗同收
                // 件九：引擎分组浮层（可用置顶 / 不可用灰置+原因小字；壳复用 .model-menu）
                function closeEngineMenu() { const m = document.getElementById("b2-engine-menu"); if (m) m.remove(); }
                function openEngineMenu(anchor) {
                  closeEngineMenu();
                  const menu = document.createElement("div");
                  menu.id = "b2-engine-menu";
                  menu.className = "model-menu";
                  // W-ENGDROP（Windows WebView2 实锤）：宽度不再钉死 300px——弹窗窄于
                  // 触发器时 CJK 名称列被压到单字宽逐字竖排。改为 minWidth=max(300,
                  // 触发器宽)，并 clamp 到视口（min-width 优先级高于 max-width，
                  // 不 clamp 时窄视口下 CSS 收口失效必横溢）
                  menu.style.minWidth = Math.min(Math.max(300, anchor ? anchor.offsetWidth : 0), window.innerWidth - 32) + "px";
                  menu.style.width = "auto";
                  menu.setAttribute("role", "menu");
                  menu.setAttribute("aria-label", "选择引擎");
                  const chosen = S.engineChoice || defaultEngineId();
                  const ready = catalogEntries().filter((e) => e.state === "ready");
                  // #102 批 A：needs_auth 单列「未登录」组（黄点+登录指引小字）——与装都没装的
                  // 「不可用」分开（用户动作不同：登录 vs 安装），均灰置不可点（div 非 button）
                  const na = catalogEntries().filter((e) => e.state !== "ready" && e.state !== "needs_auth");
                  const needsAuth = catalogEntries().filter((e) => e.state === "needs_auth");
                  let html = "";
                  html += '<button type="button" class="source-option' + (chosen === "auto" ? " active" : "") + '" data-engine-choice="auto" role="menuitem"><span class="engine-badge claude">自动</span><strong>自动 · 跟随源默认</strong><small>由源端配置决定引擎（不携带 engine 字段）</small></button>'; // W-PORT-A R-7：auto 档置顶恒可选
                  if (ready.length) {
                    html += '<div class="source-menu-head">可用 · ' + ready.length + "</div>";
                    for (const e of ready) {
                      const meta = ENGINES[e.id] || [e.label || e.id, ""];
                      html += '<button type="button" class="source-option' + (e.id === chosen ? " active" : "") + '" data-engine-choice="' + esc(e.id) + '" role="menuitem"><span class="engine-badge ' + meta[1] + '">' + esc(meta[0]) + "</span><strong>" + esc(meta[0]) + "</strong><small>" + esc(e.models && e.models.length ? e.models.length + " 个模型" : "引擎默认") + "</small></button>";
                    }
                  }
                  if (needsAuth.length) {
                    html += '<div class="source-menu-head">未登录 · ' + needsAuth.length + "</div>";
                    for (const e of needsAuth) { // #102 批 B：从灰置升级为可点——点行直接弹登录卡（二维码扫码即登录）
                      const meta = ENGINES[e.id] || [e.label || e.id, ""];
                      html += '<button type="button" class="source-option" data-engine-login="' + esc(e.id) + '" title="' + esc(oneLine(e.auth_hint || "点此扫码登录")) + '"><span class="ep-dot"></span><span class="engine-badge ' + meta[1] + '">' + esc(meta[0]) + "</span><strong>" + esc(meta[0]) + "</strong><small>点此扫码登录</small></button>";
                    }
                  }
                  if (na.length) {
                    html += '<div class="source-menu-head">不可用 · ' + na.length + "</div>";
                    for (const e of na) { // 灰置不可点（div 非 button）：原因小字透出，不硬闯
                      const meta = ENGINES[e.id] || [e.label || e.id, ""];
                      html += '<div class="source-option" aria-disabled="true"><span class="engine-badge ' + meta[1] + '">' + esc(meta[0]) + "</span><strong>" + esc(meta[0]) + "</strong><small>" + esc(oneLine(engineStateText(e))) + "</small></div>";
                    }
                  }
                  menu.innerHTML = html;
                  // W-ENGDROP：名称/描述单行省略后 title 兜底看全文（悬停渐进增强）
                  menu.querySelectorAll(".source-option").forEach((o) => {
                    const st = o.querySelector("strong"); if (st) st.title = st.textContent;
                    const sm = o.querySelector("small"); if (sm) sm.title = sm.textContent;
                  });
                  menu.addEventListener("click", (ev) => { // 菜单挂 body，对话域大委托够不到——本层直连（b2-perm-menu 同款模式）
                    const pick = ev.target.closest("[data-engine-choice]");
                    if (pick) { pickEngine(pick); return; }
                    const loginRow = ev.target.closest("[data-engine-login]"); // #102 批 B：未登录行 → 登录卡
                    if (loginRow) { closeEngineMenu(); if (window.__ccDeck005LoginCard) window.__ccDeck005LoginCard.open(loginRow.dataset.engineLogin || ""); }
                  });
                  document.body.appendChild(menu);
                  const r = anchor.getBoundingClientRect();
                  menu.classList.add("open");
                  const mw = menu.offsetWidth, mh = menu.offsetHeight;
                  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
                  menu.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - mh - 8)) + "px";
                }
                function pickEngine(btnOrId) {
                  const id = typeof btnOrId === "string" ? btnOrId : btnOrId.dataset.engineChoice;
                  if (id === "auto") { // W-PORT-A R-7：auto 档特判——不查 catalog（恒可选），模型二层清空禁用
                    S.engineChoice = "auto";
                    closeEngineMenu();
                    const pop0 = document.getElementById("b2-create-pop");
                    if (pop0) {
                      const trig0 = pop0.querySelector("[data-engine-trigger]");
                      if (trig0) {
                        const badge0 = trig0.querySelector(".engine-badge");
                        if (badge0) { badge0.className = "engine-badge claude"; badge0.textContent = "自动"; }
                        const dot0 = trig0.querySelector(".ep-dot");
                        if (dot0) dot0.classList.remove("na");
                        const metaEl0 = trig0.querySelector(".ep-meta");
                        const rc = catalogEntries().filter((e) => e.state === "ready").length;
                        if (metaEl0) metaEl0.textContent = "跟随源默认 · " + rc + " 个引擎可用";
                      }
                      const selM = pop0.querySelector("[data-create-field='model']");
                      if (selM) { selM.value = ""; selM.disabled = true; selM.setAttribute("aria-disabled", "true"); }
                      const prompt0 = pop0.querySelector("[data-create-field='prompt']");
                      if (prompt0) prompt0.focus();
                    }
                    return;
                  }
                  const entry = catalogEntries().find((e) => e.id === id);
                  if (entry && entry.state !== "ready") { b2Toast("引擎不可用：" + engineStateText(entry)); return; }
                  S.engineChoice = id;
                  closeEngineMenu(); // 件九：选中即收浮层
                  const pop = document.getElementById("b2-create-pop");
                  if (!pop) return;
                  const selM2 = pop.querySelector("[data-create-field='model']"); // R-7：显式引擎恢复模型二层可选
                  if (selM2) { selM2.disabled = !createModelsFor(id).length; if (!selM2.disabled) selM2.removeAttribute("aria-disabled"); }
                  const trig = pop.querySelector("[data-engine-trigger]"); // 件九：收起态胶囊随选同步
                  if (trig && entry) {
                    const meta = ENGINES[entry.id] || [entry.label || entry.id, ""];
                    const badge = trig.querySelector(".engine-badge");
                    if (badge) { badge.className = "engine-badge " + meta[1]; badge.textContent = meta[0]; }
                    const dot = trig.querySelector(".ep-dot");
                    if (dot) { dot.classList.toggle("na", entry.state !== "ready" && entry.state !== "needs_auth"); dot.classList.toggle("warn", entry.state === "needs_auth"); }
                    const metaEl = trig.querySelector(".ep-meta");
                    const readyCount = catalogEntries().filter((e) => e.state === "ready").length;
                    if (metaEl) metaEl.textContent = engineStateText(entry) + (readyCount > 1 ? " · 另 " + (readyCount - 1) + " 个可用" : "");
                  }
                  const sel = pop.querySelector("[data-create-field='model']"); // B10 模型二层随引擎重灌（件九：联动保留）
                  if (sel) {
                    const models = createModelsFor(id);
                    const cur = sel.value;
                    sel.innerHTML = '<option value="">默认模型</option>' + models.map((m) => '<option value="' + esc(m) + '">' + esc(m) + "</option>").join("");
                    sel.value = models.includes(cur) ? cur : "";
                  }
                  const prompt = pop.querySelector("[data-create-field='prompt']");
                  if (prompt) prompt.focus();
                }
                function submitCreate() {
                  const pop = document.getElementById("b2-create-pop");
                  if (!pop) return;
                  const prompt = (pop.querySelector("[data-create-field='prompt']") || {}).value || "";
                  const cwd = ((pop.querySelector("[data-create-field='cwd']") || {}).value || "").trim();
                  const model = ((pop.querySelector("[data-create-field='model']") || {}).value || "").trim();
                  const skipPerm = !!(pop.querySelector("[data-create-field='skipPerm']") || {}).checked;
                  const autoMkdir = !!(pop.querySelector("[data-create-field='autoMkdir']") || {}).checked;
                  if (!prompt.trim()) { b2Toast("请输入初始指令"); return; }
                  const eng = S.engineChoice || defaultEngineId();
                  const isAutoEng = eng === "auto"; // W-PORT-A R-7：auto=跟随源默认，不携带 engine、跳过 ready 检查
                  const entry = isAutoEng ? null : catalogEntries().find((e) => e.id === eng);
                  if (entry && entry.state === "needs_auth") { b2Toast("引擎未登录，已为你拉起登录引导"); if (window.__ccDeck005LoginCard) window.__ccDeck005LoginCard.open(eng); return; } // #102 批 B：toast 升级——直接弹登录卡（把饭喂到嘴里）
                  if (entry && entry.state !== "ready") { b2Toast("引擎不可用：" + engineStateText(entry)); return; }
                  // W-PORT-A R-2：目标源路由——「创建到」选了云源时走云 shim（显式通道最高优先）；
                  // 本机/未显示该行时维持 sendCmd 视角通道（RouteWs/主连接既有语义）
                  let wsOverride = null;
                  const srcSel = pop.querySelector("[data-create-field='source']");
                  if (srcSel && srcSel.value === "cloud") {
                    wsOverride = window.__ccDeck005WsFor ? window.__ccDeck005WsFor("cloud") : null;
                    if (!wsOverride) { b2Toast("远程源不在线，无法在远程创建"); return; }
                  } else if (srcSel && srcSel.value === "local") {
                    // T10 同批（Leader 追加·聚合目标源不生效）：显式选本机也锁 LAN 通道——此前
                    // local 不设 override 落入 RouteWs 无 sid 兜底=视角通道，云视角下创建错投云
                    // （「选本机却落远程」实锤机制）；显式选择优先级最高，不随视角漂移
                    wsOverride = window.__ccDeck005WsFor ? window.__ccDeck005WsFor("local") : null;
                    if (!wsOverride) { b2Toast("本机源不在线，无法在本机创建"); return; }
                  }
                  const payload = { cwd: cwd || S.homedir || ".", prompt: prompt.trim() };
                  if (eng && eng !== "claude" && !isAutoEng) payload.engine = eng; // 显式选择才携带；claude=源缺省（v1 同口径）；auto=跟随源默认（R-7）
                  if (model) payload.model = model; // B10 模型二层
                  // FB15 智能默认：本次引擎/模型记忆为下次新建的预填（引擎须仍 ready 才回填）
                  try { localStorage.setItem("cc-deck-005-last-engine", eng || ""); localStorage.setItem("cc-deck-005-last-model", model || ""); } catch (_) {}
                  if (skipPerm) payload.permissionMode = "bypassPermissions"; // B10 跳权限（relay #217：非 skip 启动的会话后续不可切跳过，创建时定）
                  if (autoMkdir) payload.autoMkdir = true; // #208 目录不存在时 relay 侧 mkdir -p
                  const id = sendCmd("COMMAND_CREATE", payload, wsOverride); // R-2：目标源通道（本机=null 走既有路由）
                  if (!id) return;
                  // #368：创建已受理即记忆本次 cwd，下次新建预填；B10 历史目录列表同步 MRU
                  if (cwd) pushCreateCwd(cwd);
                  closeCreatePop();
                  const wd = setTimeout(() => { if (S.ackWaiters.has(id)) { S.ackWaiters.delete(id); b2Toast("新建会话 10s 无回执，可能未送达（目标源或已离线）"); } }, 10000);
                  S.ackWaiters.set(id, { res: (ack) => {
                    clearTimeout(wd);
                    if (ack && ack.ok === false && ack.needs_auth) { b2Toast("引擎未登录，未创建会话——登录引导已弹出", 5000); if (window.__ccDeck005LoginCard && eng && eng !== "auto") window.__ccDeck005LoginCard.open(eng); } // #102 批 B：fail-fast 拒绝自动弹登录卡（relay 拦截时已同步 kick，此处幂等兜底）
                    else if (ack && ack.ok === false) b2Toast("新建会话失败: " + permErrText(ack.error), 5200); // W-PERMERR：拒绝文案中文化+长显（旧 relay 英文 reason 码翻译兜底）
                    else if (ack && ack.ok === true && ack.degraded) b2Toast("已创建 · 引擎降级为 " + ((ENGINES[ack.engine] || [ack.engine || "claude"])[0]) + "：" + (ack.degraded_reason || ""));
                  }, t: wd });
                }

                // ---------- 事件绑定 ----------
                // ---------- W-SLASH 斜杠命令联想（透传方案，双端对齐 expo e810261 / 旧壳 #279B）----------
                // 输入 / 前缀（未到参数段=无空白）触发浮层；选中/回车=把命令补全进输入框
                // （尾随空格留参数位），发送走既有纯文本链路——CLI 自己解析执行，其他引擎
                // 收到当文本，relay/面板零命令解析逻辑。内置表四处同源维护：relay
                // ws-server.ts BUILTIN_COMMANDS（/api/commands 数据源）/ 旧壳 SLASH_BUILTIN /
                // expo slash.ts / 本表。LAN/桌面形态 fetch 用户/项目自定义命令（60s 缓存+
                // 单飞去重）；云形态 HTTP 到不了 relay、失败一律回落内置表。
                const SLASH_BUILTIN = [
                  ["compact", "压缩对话历史，释放上下文"],
                  ["clear", "清空当前会话历史"],
                  ["help", "查看帮助"],
                  ["model", "查看/切换模型"],
                  ["cost", "当前会话 token 用量"],
                  ["context", "上下文使用概况"],
                  ["memory", "编辑项目记忆 CLAUDE.md"],
                  ["init", "为当前项目初始化 CLAUDE.md"],
                  ["review", "审查 PR / 代码变更"],
                  ["resume", "恢复历史会话"],
                  ["rename", "重命名当前会话"],
                  ["export", "导出当前会话记录"],
                  ["todos", "查看当前任务清单"],
                  ["permissions", "权限规则管理"],
                  ["config", "打开配置面板"],
                  ["mcp", "MCP 服务器管理"],
                  ["statusline", "状态栏配置"],
                  ["output-style", "切换输出风格"],
                  ["add-dir", "添加额外工作目录"],
                  ["vim", "切换 vim 按键模式"],
                  ["doctor", "Claude Code 健康检查"],
                  ["login", "切换账号"],
                  ["bug", "报告问题"],
                  ["release-notes", "查看更新日志"],
                ].map(([name, desc]) => ({ name, desc, source: "builtin" }));
                let slashList = SLASH_BUILTIN;
                const slashCache = new Map();
                let slashPanel = null, slashHot = -1, slashInputEl = null, slashInflight = "";
                const slashQueryOf = (v) => (v.startsWith("/") && !/\s/.test(v) ? v.slice(1) : null);
                const slashMatches = (q) => {
                  const s = q.trim().toLowerCase();
                  if (!s) return slashList.slice(0, 8);
                  return slashList.filter((c2) => c2.name.toLowerCase().startsWith(s) || (c2.desc || "").toLowerCase().includes(s)).slice(0, 8);
                };
                function slashEnsure() {
                  const s = curSession();
                  if (!s) return;
                  const base = String((typeof window.__ccDeck005HttpOrigin === "function" && window.__ccDeck005HttpOrigin()) || location.origin || "");
                  const token = String(window.__ccDeck005Token || "");
                  const cwd = s.cwd ?? "";
                  const key = base + "|" + cwd;
                  const hit = slashCache.get(key);
                  if (hit && Date.now() - hit.ts < 60000) { slashList = hit.list; return; }
                  if (!base || !token || slashInflight) return;
                  slashInflight = key;
                  const wantCwd = cwd;
                  fetch(base + "/api/commands?token=" + encodeURIComponent(token) + "&cwd=" + encodeURIComponent(cwd), { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined })
                    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
                    .then((j) => {
                      if (!j || !j.ok || !Array.isArray(j.commands)) throw new Error("bad shape");
                      const list = j.commands.filter((c2) => c2 && typeof c2.name === "string");
                      slashCache.set(key, { ts: Date.now(), list });
                      slashList = list;
                    })
                    .catch(() => { slashList = SLASH_BUILTIN; })
                    .finally(() => {
                      slashInflight = "";
                      // 慢请求期间切了会话（cwd 变）：只入缓存不刷新当前面板，防旧 cwd 命令污染新会话联想
                      const cur = curSession();
                      if (cur && (cur.cwd ?? "") === wantCwd) slashRender();
                    });
                }
                function slashHide() {
                  if (slashPanel) slashPanel.classList.remove("open");
                  slashHot = -1;
                }
                function slashComplete(name) {
                  const el = slashInputEl;
                  if (!el) return;
                  el.value = "/" + name + " ";
                  el.dispatchEvent(new Event("input", { bubbles: false })); // 走既有 input 链：草稿/发送态/浮层重估
                  el.focus();
                  slashHide();
                }
                function slashRender() {
                  if (!slashPanel || !slashInputEl) return;
                  const q = slashQueryOf(slashInputEl.value);
                  if (q === null) { slashHide(); return; }
                  const ms = slashMatches(q);
                  slashPanel.innerHTML = (ms.length
                    ? ms.map((m, i) => '<div class="slash-row' + (i === slashHot ? " hot" : "") + '" data-n="' + esc(m.name) + '" data-i="' + i + '" role="option"><span class="slash-name">/' + esc(m.name) + "</span>" +
                      '<span class="slash-desc">' + esc(m.desc || "") + "</span>" +
                      (m.source && m.source !== "builtin" ? '<span class="slash-src">' + (m.source === "user" ? "用户" : "项目") + "</span>" : "") + "</div>").join("")
                    : '<div class="slash-empty">无匹配命令，Enter 原样发送</div>')
                    + '<div class="slash-foot">↑↓ 选择 · Enter 补全 · Esc 关闭 · 选中后作为文本发送</div>';
                  if (slashHot >= ms.length) slashHot = ms.length - 1;
                  const hot = slashPanel.querySelector(".slash-row.hot");
                  if (hot) hot.scrollIntoView({ block: "nearest" });
                }
                function slashUpdate(el) {
                  slashInputEl = el || null;
                  if (!slashInputEl) { slashHide(); return; }
                  const q = slashQueryOf(slashInputEl.value);
                  if (q === null || !curSession()) { slashHide(); return; }
                  if (!slashPanel) {
                    slashPanel = document.createElement("div");
                    slashPanel.className = "slash-box";
                    slashPanel.setAttribute("role", "listbox");
                    slashPanel.setAttribute("aria-label", "斜杠命令联想");
                    // mousedown 补全（preventDefault 防输入框失焦；touch 合成 click 由 click 兜底）
                    slashPanel.addEventListener("mousedown", (ev) => {
                      const row = ev.target.closest(".slash-row");
                      if (!row) return;
                      ev.preventDefault();
                      slashComplete(row.dataset.n);
                    });
                    slashPanel.addEventListener("click", (ev) => {
                      const row = ev.target.closest(".slash-row");
                      if (!row) return;
                      ev.preventDefault();
                      slashComplete(row.dataset.n);
                    });
                    document.body.appendChild(slashPanel);
                  }
                  // 锚定：浮在 composer 上方（锚 composer 边框盒——textarea 内框差 padding
                  // 会错位；rect 每次开面板重算，窗口缩放/折叠态换行自适应）
                  const host = slashInputEl.closest(".composer") || slashInputEl;
                  const r = host.getBoundingClientRect();
                  slashPanel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 488)) + "px";
                  slashPanel.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
                  slashHot = -1;
                  slashRender();
                  slashPanel.classList.add("open");
                  slashEnsure();
                }
                function slashKeydown(ev) {
                  if (!slashPanel || !slashPanel.classList.contains("open")) return false;
                  if (ev.key === "Escape") { slashHide(); return true; }
                  if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown" && ev.key !== "Enter" && ev.key !== "Tab") return false;
                  if (ev.altKey || ev.ctrlKey || ev.metaKey) return false;
                  const ms = slashMatches(slashQueryOf(slashInputEl ? slashInputEl.value : "") ?? "");
                  if (ev.key === "Tab") {
                    if (!ms.length) return false;
                    ev.preventDefault();
                    slashComplete(ms[0].name);
                    return true;
                  }
                  if (ev.key === "Enter") {
                    // 有 hot 补全选中项；无 hot（未用 ↑↓）不拦截——按原行为原样发送
                    if (slashHot >= 0 && ms[slashHot]) { ev.preventDefault(); slashComplete(ms[slashHot].name); return true; }
                    slashHide();
                    return false;
                  }
                  if (!ms.length) return false;
                  ev.preventDefault();
                  if (ev.key === "ArrowDown") slashHot = Math.min(slashHot + 1, ms.length - 1);
                  else slashHot = slashHot <= 0 ? 0 : slashHot - 1;
                  slashRender();
                  return true;
                }

                function bindEvents() {
                  // 选中链由地基驱动；本端只观察 DOM 变化同步 S.selected
                  const readSel = () => UI.sessionList.querySelector(".queue-card.selected");
                  const mo = new MutationObserver(() => {
                    const sid = readSel() ? readSel().dataset.sessionCard : "";
                    if (sid !== S.selected) {
                      if (S.selected) inputDrafts.set(S.selected, UI.input.value); // #B3-4 切走存草稿
                      S.selected = sid;
                      S.forceScroll = true;
                      histLoad(sid);
                      UI.input.value = inputDrafts.get(sid) ?? ""; // #B3-4 切回恢复（未输入过清空，防串会话）
                      S.staged = [];
                      renderTray();
                      renderMyList(); // [t-7e0c6189] 选中进出 worker 会话时出列/收回要跟着换（mo 再触发时 sid 已同，幂等）
                      renderAll();
                    }
                    if (S.hasSnapshot && S.sessions.size) {
                      const domIds = new Set([...UI.sessionList.querySelectorAll("[data-session-card]")].map((c) => c.dataset.sessionCard));
                      let miss = domIds.size === 0 && !(S._collapsedIdleIds && S._collapsedIdleIds.size > 0) && !(S._filterHiddenIds && S._filterHiddenIds.size > 0) && !(S._slimHiddenIds && S._slimHiddenIds.size > 0); // FB17：筛空态是合法形态（含瘦身收空）
                      for (const k of S.sessions.keys()) if (!domIds.has(k) && !(S._collapsedIdleIds && S._collapsedIdleIds.has(k)) && !(S._filterHiddenIds && S._filterHiddenIds.has(k)) && !(S._slimHiddenIds && S._slimHiddenIds.has(k))) { miss = true; break; } // FB17：被筛掉的卡不算缺失（t-7e0c6189：被收起的同口径）
                      if (miss) renderMyList();
                    }
                  });
                  // #143 盲评A-1 止血配套：补 attributes 监听——地基让位重渲后，选中改为地基点改 class，
                  // 无此监听则 S.selected 不再跟随（原只观察 childList）。走秒改 textContent 不触发。
                  mo.observe(UI.sessionList, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

                  // [t-7e0c6189] 键盘可达：团队入口卡/成员胶囊/第四列卡（role=button）Enter/Space 走点击链
                  // W-TEAMSNC ②④：团队 chip（button）原生键盘可达免委托；roster 行（role=button）+跳域钮并入本链
                  UI.section.addEventListener("keydown", (ev) => {
                    if (ev.key !== "Enter" && ev.key !== " ") return;
                    const t = ev.target.closest("[data-slim-open], [data-slim-drawer-toggle], [data-team-jump]");
                    if (!t) return;
                    ev.preventDefault();
                    t.click();
                  });

                  // 域内委托（在冒泡到地基 document 监听之前截住需要接管的面）
                  UI.section.addEventListener("click", (ev) => {
                    // #164 对话域交互：开关钮 / 过程组头 / 复制 / 路径 / 展开收起（旧壳事件委托口径）
                    const convTgl = ev.target.closest("[data-conv-toggle]");
                    if (convTgl) { ev.stopPropagation(); toggleConv(convTgl.dataset.convToggle); return; }
                    const procTgl = ev.target.closest("[data-proc-toggle]");
                    if (procTgl) {
                      ev.stopPropagation();
                      const key = "proc:" + procTgl.dataset.procToggle;
                      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
                      const g = procTgl.closest(".procgrp");
                      if (g) { g.classList.toggle("open", expanded.has(key)); procHeadUpdate(g); }
                      return;
                    }
                    const mc = ev.target.closest(".msg-copy"); // #B3-12 AI 消息复制（先于 .copy-btn 通用分支）
                    if (mc) {
                      ev.stopPropagation();
                      const cs = curSession();
                      const tl = cs ? (S.timelines.get(cs.session_id) || []) : [];
                      const en = tl.find((x) => eKey(x) === mc.dataset.x);
                      copyWithFallback(String((en && (en.full ?? en.text)) ?? ""), "已复制消息");
                      return;
                    }
                    const cpy = ev.target.closest(".copy-btn");
                    if (cpy) { ev.stopPropagation(); copyText(cpy.dataset.copy || ""); b2Toast("已复制"); return; }
                    const fp = ev.target.closest(".fpath");
                    if (fp) { ev.stopPropagation(); copyText(fp.dataset.p || ""); b2Toast("已复制路径 · " + (fp.dataset.p || "")); return; }
                    const xEl = ev.target.closest(".x-full[data-x], .th-head[data-x], .am-head[data-x]"); // W-AUTOMSG：am-head=自动注入折叠头（复用 expanded 切换链）
                    if (xEl) { ev.stopPropagation(); toggleExpand(xEl.dataset.x); return; }
                    const ubImg = ev.target.closest(".ub-img"); // FB14：缩略图点击放大/还原
                    if (ubImg) { ev.stopPropagation(); ubImg.classList.toggle("zoomed"); return; }
                    const cta = ev.target.closest(".srow-cta");
                    if (cta) {
                      ev.stopPropagation();
                      const card = cta.closest("[data-session-card]");
                      if (card) card.click(); // 复用地基选中链
                      if (UI.tabs[0]) UI.tabs[0].click();
                      setTimeout(() => {
                        const cardEl = UI.convPane && UI.convPane.querySelector("[data-b2-wait]");
                        if (cardEl) { // #B3-18 落点闪高改 jump-flash 工具类（与任务跳转同语汇）
                          cardEl.scrollIntoView({ block: "center", behavior: "smooth" });
                          cardEl.classList.add("jump-flash");
                          setTimeout(() => cardEl.classList.remove("jump-flash"), 1500);
                        }
                        else UI.input.focus();
                      }, 60);
                      return;
                    }
                    const filterBtn = ev.target.closest("#d-session [data-session-filter]"); // FB17：筛选芯片开浮菜单
                    if (filterBtn) { ev.stopPropagation(); openSessionFilterMenu(filterBtn); return; }
                    // [t-7e0c6189] 瘦身交互三口：第四列开关 / 直开成员会话 / 团队入口跳团队域
                    //（顺序敏感：按钮先于团队卡身，防 team 卡吞掉 ⤢/胶囊点击）
                    const slimTgl = ev.target.closest("[data-slim-drawer-toggle]");
                    if (slimTgl) { ev.stopPropagation(); slimToggleDrawer(slimTgl.dataset.slimDrawerToggle); return; }
                    // W-TEAMSNC ②：团队 chip 点击=开/收第四列团队抽屉（卡 r3 与详情 head 同链；
                    // stopPropagation 防冒泡到地基 document 卡选中链——srow-more 同款先例，chip 在
                    // 卡热区内必须隔离）
                    const teamChip = ev.target.closest("[data-team-chip]");
                    if (teamChip) { ev.stopPropagation(); slimToggleDrawer(teamChip.dataset.teamChip); return; }
                    // W-TEAMSNC ④：抽屉跳团队域钮组（railJump 三链：railJump→ccDeckTeam.select→
                    // clickTab，notify.js focusSource 同款先例；tab 文案值与 #d-team .segment-bar 对齐）
                    const teamJump = ev.target.closest("[data-team-jump]");
                    if (teamJump) {
                      ev.stopPropagation();
                      const jgid = teamJump.dataset.teamJump, jtab = teamJump.dataset.teamJumpTab || "看板";
                      window.__ccDeck005B4?.railJump?.("team");
                      if (window.ccDeckTeam?.select?.(jgid) === false) b2Toast("团队已不在编制");
                      window.__ccDeck005B4?.clickTab?.("#d-team .segment-bar", jtab);
                      return;
                    }
                    const slimOpen = ev.target.closest("[data-slim-open]");
                    if (slimOpen) { ev.stopPropagation(); slimOpenSession(slimOpen.dataset.slimOpen); return; }
                    // [data-slim-team] dock 入口卡点击链随 W-TEAMCHIP2 ② dock 退役删除
                    //（进团队域即清未读由团队域 select 侧 __ccDeck005SlimUi.markSeen 承接）；
                    // B11 data-group-toggle 折叠链同批退役（零生产者）。
                    const taskHide = ev.target.closest("[data-task-hide]");
                    if (taskHide) { ev.stopPropagation(); const cs = curSession(); if (cs) { hiddenTaskKeys.add(cs.session_id + "#" + taskHide.dataset.taskHide); renderTasks(); } return; } // #B3-9
                    const taskJump = ev.target.closest("[data-task-jump]");
                    if (taskJump) { // #B3-11 四组直达：滚动定位 + 落点闪高（复用 #B3-18 jump-flash）
                      ev.stopPropagation();
                      const pane = UI.panes[1];
                      const head = pane && pane.querySelector('[data-task-group="' + cssEsc(taskJump.dataset.taskJump) + '"]');
                      if (head) {
                        head.scrollIntoView({ block: "start", behavior: "smooth" });
                        head.classList.add("jump-flash");
                        setTimeout(() => head.classList.remove("jump-flash"), 1500);
                      }
                      return;
                    }
                    const taskRef = ev.target.closest("[data-task-ref]");
                    if (taskRef) { ev.stopPropagation(); jumpToTask(Number(taskRef.dataset.taskRef)); return; }
                    const allow = ev.target.closest("[data-wait-allow]");
                    if (allow) { ev.stopPropagation(); handleWaitVerdict(allow, "allow"); return; }
                    const remember = ev.target.closest("[data-wait-remember]");
                    if (remember) { ev.stopPropagation(); handleWaitVerdict(remember, "remember"); return; }
                    const deny = ev.target.closest("[data-wait-deny]");
                    if (deny) { ev.stopPropagation(); handleWaitVerdict(deny, "deny"); return; }
                    const answer = ev.target.closest("[data-wait-answer]");
                    if (answer) { ev.stopPropagation(); handleWaitAnswer(answer); return; }
                    const chipEl = ev.target.closest("[data-wait-chip]");
                    if (chipEl) { ev.stopPropagation(); handleWaitChip(chipEl); return; }
                    const submitEl = ev.target.closest("[data-wait-submit]");
                    if (submitEl) { ev.stopPropagation(); handleWaitSubmit(submitEl); return; }
                    const artRetry = ev.target.closest("[data-artifact-file-retry]");
                    if (artRetry) {
                      ev.stopPropagation();
                      const f = artRetry.closest(".art-row");
                      if (f) downloadNode(f, S.selected).catch(() => {});
                      return;
                    }
                    const afTgl = ev.target.closest("[data-af-toggle]"); // #168 文件夹行折叠箭头
                    if (afTgl) {
                      ev.stopPropagation();
                      const grp = afTgl.closest("[data-artifact-group]");
                      if (grp) toggleArtGroup(grp);
                      return;
                    }
                    const afView = ev.target.closest("[data-af-view]");
                    if (afView) { ev.stopPropagation(); openArtViewer(afView.dataset.afView); return; }
                    const afDl = ev.target.closest("[data-af-dl]");
                    if (afDl) { ev.stopPropagation(); const row = afDl.closest(".art-row"); if (row) downloadNode(row, S.selected).catch(() => {}); return; }
                    const afAll = ev.target.closest("[data-af-all-dl]");
                    if (afAll) { ev.stopPropagation(); runAllDownloads(); return; }
                    const menuBtn = ev.target.closest("[data-artifact-menu-button]");
                    if (menuBtn) {
                      ev.stopPropagation();
                      const menu = menuBtn.parentElement.querySelector(".artifact-menu");
                      document.querySelectorAll("#d-session .artifact-menu.open").forEach((x) => { if (x !== menu) x.classList.remove("open"); });
                      if (menu) menu.classList.toggle("open");
                      return;
                    }
                    const artAct = ev.target.closest("[data-artifact-action]");
                    if (artAct) {
                      ev.stopPropagation();
                      const group = artAct.closest("[data-artifact-group]");
                      const menu = artAct.closest(".artifact-menu");
                      if (menu) menu.classList.remove("open");
                      if (artAct.dataset.artifactAction === "toggle" && group) {
                        toggleArtGroup(group); // #168 与折叠箭头同源（开合态记忆+aria 同步）
                      } else if (artAct.dataset.artifactAction === "reveal" && group) {
                        // #158-批3 桌面壳「在文件夹中定位」：先探后开——不在本机（远程会话产物）
                        // 明确提示不给 openPath 弹「路径没有文件」报错（旧壳 11047-11051 口径）；
                        // #158-批4a 目录切分兼容 \（openPath/probePath 吃原生路径，不 display 化）
                        const first = group.querySelector(".art-row");
                        const p0 = first ? String(first.dataset.path || "") : "";
                        const dir = window.__ccDeck005PathUi.dirOf(p0) || p0;
                        if (!dir || !window.ccDeck || !window.ccDeck.openPath) { b2Toast("无目录可定位"); return; }
                        shellHasLocal(dir).then((local) => {
                          if (!local) { b2Toast("目录不在本机（远程会话产物），无法定位", 3500); return; }
                          window.ccDeck.openPath(dir, true).catch((er) => b2Toast(String((er && er.message) || er).slice(0, 80), 3500));
                        });
                      } else if (artAct.dataset.artifactAction === "copy-path" && group) {
                        const first = group.querySelector(".art-row");
                        const p = first ? String(first.dataset.path || "") : "";
                        const dir = window.__ccDeck005PathUi.dirOf(p) || p;
                        try { navigator.clipboard && navigator.clipboard.writeText(dir); } catch (_) {}
                        b2Toast("已复制路径 · " + displayPath(dir));
                      }
                      return;
                    }
                    const batch = ev.target.closest("[data-artifact-batch]");
                    if (batch) { ev.stopPropagation(); runBatch(batch.closest("[data-artifact-group]")); return; }
                    const artRow = ev.target.closest("#session-body .art-row"); // #168 点行=在线预览（下载走行尾钮/浮层）
                    if (artRow) { openArtViewer(String(artRow.dataset.path || "")); return; }
                    const del = ev.target.closest("[data-session-delete]");
                    if (del) { ev.stopPropagation(); confirmDelete(); return; }
                    const kvCopy = ev.target.closest(".kv-copy-btn");
                    if (kvCopy) {
                      ev.stopPropagation();
                      const row = kvCopy.closest("[data-copy-session-id], [data-copy-relay-session-id]");
                      if (row) copyWithFallback(row.dataset.copySessionId || row.dataset.copyRelaySessionId || "", "已复制");
                      return;
                    }
                    const trayX = ev.target.closest("[data-tray-remove]");
                    if (trayX) { ev.stopPropagation(); S.staged.splice(Number(trayX.dataset.trayRemove), 1); renderTray(); syncComposerState(); return; }
                    const engOpt = ev.target.closest("[data-engine-choice]");
                    if (engOpt) { ev.stopPropagation(); pickEngine(engOpt); return; }
                    const createSubmit = ev.target.closest("[data-create-submit]");
                    if (createSubmit) { ev.stopPropagation(); submitCreate(); return; }
                    // #B3-5 点击非输入区自动回焦（旧壳 #240 微信同款）：落到上面的分支都是已接管的
                    // 交互面；走到这里 = 时间线/卡片背景/空白处。选词中（selection 非空）与浮层
                    // 打开期间不打扰；输入控件与其内点击天然已被上面分支截住，双保险仍查一遍。
                    if (ev.target.closest("button, a, input, textarea, select, label, [contenteditable]")) return;
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed && sel.toString()) return;
                    if (document.getElementById("b2-create-pop")) return; // B10 弹窗开着不抢焦
                    if (S.selected && UI.input && !UI.input.disabled) { try { UI.input.focus({ preventScroll: true }); } catch (_) {} }
                  });

                  // #B3-6 详情 tab 裸 ←→ 切换（旧壳 #67/#190 键链直搬）：带修饰键不响应（Alt/Ctrl+←→
                  // 是切数据源）；输入控件聚焦不抢（方向键归 caret）；隐藏 tab 不进循环；焦点落在
                  // segment-bar 按钮上时让位 wireSegmentTabSemantics 的 roving ←→（防双切）。
                  document.addEventListener("keydown", (ev) => {
                    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
                    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
                    if (!document.querySelector("#stage-desktop.active #d-session.active")) return;
                    const ae = document.activeElement;
                    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
                    if (ae && ae.closest && ae.closest(".segment-bar")) return;
                    const tabs = UI.tabs.filter((b) => b.offsetParent !== null && b.getAttribute("aria-hidden") !== "true");
                    const i = tabs.findIndex((b) => b.classList.contains("active"));
                    if (i < 0) return;
                    const n = ev.key === "ArrowRight" ? i + 1 : i - 1;
                    if (n < 0 || n >= tabs.length) return;
                    ev.preventDefault();
                    tabs[n].click();
                    tabs[n].focus();
                  });

                  // 「+」新建入口（#75 引擎菜单）
                  const plus = UI.queueHead.querySelector("button.icon-btn");
                  if (plus) plus.addEventListener("click", (ev) => { ev.stopPropagation(); if (document.getElementById("b2-create-pop")) closeCreatePop(); else openCreatePop(); });

                  // 点击空白收浮层（document 级，兜在冒泡末端）
                  document.addEventListener("click", (ev) => {
                    if (!ev.target.closest("#b2-create-pop") && !ev.target.closest("#d-session .queue-head") && !ev.target.closest("#b2-engine-menu")) closeCreatePop(); // 件九：点引擎浮层不误关弹窗
                    if (!ev.target.closest("#b2-model-menu") && !ev.target.closest("#session-model-capsule")) closeModelMenu();
                    if (!ev.target.closest("#b2-perm-menu") && !ev.target.closest("#session-perm-capsule")) closePermMenu(); // UIPOLISH3 件三
                    if (!ev.target.closest("#b2-plus-menu") && !ev.target.closest("[data-composer-plus]")) window.__ccDeck005ClosePlusMenu && window.__ccDeck005ClosePlusMenu(); // #195 件二
                    if (!ev.target.closest(".artifact-menu-wrap")) document.querySelectorAll("#d-session .artifact-menu.open").forEach((x) => x.classList.remove("open"));
                    if (!ev.target.closest(".slash-box") && !ev.target.closest(".composer")) slashHide(); // W-SLASH：点浮层/输入区外收起
                  });
                  document.addEventListener("keydown", (ev) => {
                    if (ev.key === "Escape") { closeCreatePop(); closeModelMenu(); closePermMenu(); window.__ccDeck005ClosePlusMenu && window.__ccDeck005ClosePlusMenu(); closeArtViewer(); slashHide(); document.querySelectorAll("#d-session .artifact-menu.open").forEach((x) => x.classList.remove("open")); if (S.drawerGid) slimToggleDrawer(S.drawerGid); } // W-TEAMSNC ④：Esc 关抽屉（B 稿 1.3，通知弹窗同款收口习惯）
                  });
                  // W-TEAMSNC ④：docked/overlay 形态随视口切换（≥1360 docked / <1360 overlay+遮罩；
                  // 与检查器拖宽 --inspector-w 正交）；resize 兜底（matchMedia 无回调的老链不依赖）
                  if (window.matchMedia) {
                    const drawerMq = window.matchMedia("(min-width: 1360px)");
                    const onDrawerMq = () => syncDrawerOverlay();
                    // W-TEAMCHIP2 ③ 反向互斥：抽屉互斥收起了第三列后，用户点 ‹ 把手手动展开
                    // 检查器=明确要检查器 → 收抽屉让位（对称互斥；capture 先于地基 data-inspector-
                    // toggle 委托跑，抽屉关→syncDrawerMutex 还原分支与用户点击同向，幂等不冲突）。
                    // overlay 态检查器被盖本就点不到把手，不拦。
                    UI.section.addEventListener("click", (ev) => {
                      if (!S.drawerGid) return;
                      if (ev.target.closest(".inspector-expand") && !document.querySelector("#d-session").classList.contains("drawer-overlay")) setTimeout(() => slimToggleDrawer(S.drawerGid), 0); // 延迟一拍：地基 toggle 先按当前态完成展开翻转，本链再关抽屉（同步跑会先把互斥类还原，地基读到「已展开」反手收回去——E2E D7 实锤竞态）
                    }, true);
                    if (drawerMq.addEventListener) drawerMq.addEventListener("change", onDrawerMq);
                    else window.addEventListener("resize", onDrawerMq);
                  }

                  // composer：发送/停止/历史/IME
                  UI.sendBtn.addEventListener("click", sendMessage);
                  if (UI.stopBtn) UI.stopBtn.addEventListener("click", stopSession);
                  // #195 件三：单行/多行折叠开关退役（多行恒定，textarea 随内容自长高上限内滚）。
                  let composing = false, commitLockUntil = 0;
                  UI.input.addEventListener("compositionstart", () => { composing = true; });
                  UI.input.addEventListener("compositionend", () => { composing = false; commitLockUntil = Date.now() + 150; });
                  UI.input.addEventListener("keydown", (ev) => {
                    // W-SLASH：浮层开时 ↑↓/Enter/Tab/Esc 先归联想面板（IME 组词期不抢键）
                    if (!ev.isComposing && ev.keyCode !== 229 && slashKeydown(ev)) return;
                    if (ev.key === "Enter" && !ev.shiftKey) {
                      if (ev.isComposing || composing) return;                 // IME 组词期 Enter 不发送
                      if (ev.keyCode === 229 && Date.now() - commitLockUntil < 400) return;
                      ev.preventDefault();
                      sendMessage();
                      return;
                    }
                    histKeydown(ev);
                    slashUpdate(UI.input); // 历史翻阅换了值：浮层按新值重估（/ 前缀失守即收起）
                  });
                  UI.input.addEventListener("input", () => { if (S.hist.idx >= 0) S.hist.draft = UI.input.value; syncComposerState(); });
                  UI.input.addEventListener("paste", (ev) => {
                    const files = [...((ev.clipboardData && ev.clipboardData.files) || [])];
                    if (!files.length) return;
                    ev.preventDefault();
                    stageFiles(files);
                  });
                  const composer = UI.composer;
                  composer.addEventListener("dragover", (ev) => { ev.preventDefault(); composer.classList.add("dragover"); });
                  composer.addEventListener("dragleave", () => composer.classList.remove("dragover"));
                  composer.addEventListener("drop", (ev) => {
                    ev.preventDefault();
                    composer.classList.remove("dragover");
                    stageFiles(ev.dataTransfer && ev.dataTransfer.files);
                  });
                  // #195 件二：粘贴/拖入提示语退役，附件能力收进左下 [+] 单入口（WorkBuddy 同构）——
                  // 点开两项浮层（添加图片/添加文件），选择器各异走原 stageFiles 限额链；⌘V 粘贴与
                  // 拖入输入框两条免点路径不变（提示虽撤，能力在）。
                  const plusBtn = composer.querySelector("[data-composer-plus]");
                  const clipBtn = composer.querySelector("[data-composer-clip]");
                  const imgBtn = composer.querySelector("[data-composer-img]");
                  if (clipBtn || imgBtn) {
                    // #201 VISFIX⑤：两级菜单撤——双图标铺开直点（改造前形态：clip=任意文件、
                    // cam=图片；选择器限额链不变，⌘V/拖入免点路径不变）
                    const mkInput = (accept) => { const inp = document.createElement("input"); inp.type = "file"; inp.multiple = true; if (accept) inp.accept = accept; inp.hidden = true; document.body.appendChild(inp); inp.addEventListener("change", () => { stageFiles(inp.files); inp.value = ""; }); return inp; };
                    if (clipBtn) clipBtn.addEventListener("click", () => { mkInput().click(); });
                    if (imgBtn) imgBtn.addEventListener("click", () => { mkInput("image/*").click(); });
                  }

                  // 桌面会话输入框接线：input 触发重估 + keydown 先过浮层（↑↓/Enter/Tab/Esc），历史翻阅后同步重估
                  UI.input.addEventListener("input", () => slashUpdate(UI.input));

                  // 文档级拖入蒙层（#79：拖文件无反应的真因——depth 计数 + preventDefault）
                  let dragDepth = 0;
                  const hasFiles = (ev) => [...((ev.dataTransfer && ev.dataTransfer.types) || [])].some((t) => t === "Files" || t === "application/x-moz-file");
                  document.addEventListener("dragenter", (ev) => { if (!hasFiles(ev)) return; dragDepth += 1; document.body.classList.add("file-drag-over"); });
                  document.addEventListener("dragover", (ev) => ev.preventDefault());
                  document.addEventListener("dragleave", (ev) => { if (!hasFiles(ev)) return; dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) document.body.classList.remove("file-drag-over"); });
                  document.addEventListener("drop", (ev) => {
                    ev.preventDefault();
                    dragDepth = 0;
                    document.body.classList.remove("file-drag-over");
                    if (ev.target.closest && ev.target.closest("[data-composer]")) return; // composer 内已由专属 handler 接管
                    // #169 B#15：蒙层亮起时任意处松手即收件（旧壳 #179 全窗拖放语义，收窄回 toast 是回归）
                    const dt = ev.dataTransfer;
                    if (dt && dt.files && dt.files.length) {
                      const mobSid = document.querySelector("#stage-mobile.active") && window.__ccDeck005B4 && typeof window.__ccDeck005B4.currentDetail === "function" ? window.__ccDeck005B4.currentDetail() : null;
                      stageFiles(dt.files, mobSid);
                    }
                    else if (dt && (dt.getData("text/uri-list") || dt.getData("text/plain"))) b2Toast("网页内容请在输入栏粘贴发送");
                  });
                  window.addEventListener("blur", () => { dragDepth = 0; document.body.classList.remove("file-drag-over"); });

                  // 回到底部 FAB（件十一升级：40px 圆钮+icon+淡入淡出+未读点；离底 >80px
                  // 停 300ms 复核浮现——显隐走 .show 类不再用 hidden 硬切）
                  const btb = document.createElement("button");
                  btb.type = "button";
                  btb.className = "back-to-bottom";
                  btb.setAttribute("aria-label", "跳到最新消息");
                  btb.title = "跳到最新消息";
                  btb.innerHTML = '<svg class="icon-inline" aria-hidden="true"><use href="#icon-chev-down"></use></svg><span class="unread-dot" aria-hidden="true"></span>';
                  UI.workspace.appendChild(btb);
                  let settleTimer = 0;
                  const nearBottom = () => UI.body.scrollHeight - UI.body.scrollTop - UI.body.clientHeight < 80;
                  const sessionActive = () => !!document.querySelector("#stage-desktop.active #d-session.active");
                  const onScroll = () => {
                    // 件十九/二十状态机 v3：滚动即记账——{top（距顶）, bottom（贴底态）}；程序写锁
                    //（S.scrollLock）内跳过防反向污染（v3 程序写不设锁=生效值自然落账）
                    if (!S.scrollLock) {
                      const k = UI.body.scrollHeight - UI.body.scrollTop - UI.body.clientHeight;
                      if (S.selected) S.scrollKeep.set(S.selected, { top: UI.body.scrollTop, bottom: k < 120 });
                      S.userPinnedBottom = k < 120;
                    }
                    if (!sessionActive()) { btb.classList.remove("show", "has-unread"); return; }
                    btb.classList.remove("show");
                    clearTimeout(settleTimer);
                    if (!nearBottom()) settleTimer = setTimeout(() => { if (!nearBottom() && sessionActive()) btb.classList.add("show"); }, 300);
                    else btb.classList.remove("has-unread"); // 滚近底：未读点熄灭
                  };
                  UI.body.addEventListener("scroll", onScroll);
                  btb.addEventListener("click", () => { btb.classList.remove("show", "has-unread"); UI.body.scrollTo({ top: UI.body.scrollHeight, behavior: "smooth" }); });

                  // 1s 本地计时：dock 回合计时 + 自建列表卡的运行秒数
                  setInterval(() => {
                    tickDockElapsed();
                    if (!S.hasSnapshot) return;
                    UI.sessionList.querySelectorAll(".queue-card").forEach((card) => {
                      const s = S.sessions.get(card.dataset.sessionCard);
                      const el = card.querySelector(".srow-sec");
                      if (el && s && s.status === "WORKING") el.textContent = myCardItem(s).workSecs + "s";
                    });
                    const slimDrawerEl = document.querySelector("#d-session [data-slim-drawer]"); // [t-7e0c6189] 第四列走秒同链（data-slim-open 卡）
                    if (slimDrawerEl && !slimDrawerEl.hidden) slimDrawerEl.querySelectorAll(".queue-card[data-slim-open]").forEach((card) => {
                      const s = S.sessions.get(card.dataset.slimOpen);
                      const el = card.querySelector(".srow-sec");
                      if (el && s && s.status === "WORKING") el.textContent = myCardItem(s).workSecs + "s";
                    });
                  }, 1000);

                  // #160 置灰看门狗（旧壳 #96 同机制）：renderMyList 纯事件驱动——DONE/ERROR
                  // 会话静默超阈值后不再有事件触发重渲，idleDimmed 判定再对 .idle 也挂不上。
                  // 60s 逐行对账：DOM 行的 .idle 与重算结果不符才整列重渲——过滤/分组口径
                  // 天然对齐（不在 DOM 的行不参与），稳态零开销；跨过阈值的时刻本就无交互。
                  setInterval(() => {
                    if (!S.hasSnapshot) return;
                    for (const card of UI.sessionList.querySelectorAll(".queue-card[data-session-card]")) {
                      const s = S.sessions.get(card.dataset.sessionCard);
                      if (!s) continue; // 删除竞态中的孤儿行交给 onDeleted/observer 收口
                      if (card.classList.contains("idle") !== idleDimmed(s)) { renderMyList(); return; }
                    }
                  }, 60000);
                }

                // ---------- 启动（地基 setupStubTabs 已在解析期跑完 → 此处收编占位 pane） ----------
                function ready() {
                  const section = document.querySelector("#d-session");
                  if (!section) return;
                  const sessionList = section.querySelector("[data-session-list]");
                  const workspace = section.querySelector(".workspace");
                  const body = section.querySelector("#session-body");
                  if (!sessionList || !workspace || !body) return;
                  const panes = [...body.children];
                  UI = {
                    section, sessionList, workspace, body, panes,
                    tabs: [...section.querySelectorAll(".segment-bar button")],
                    title: $id("session-title"), statusTag: null, identity: $id("session-identity"), // W-UIFB ③：状态胶囊退役（i=3），statusTag 置空防旧引用
                    subHint: (text) => { // W-UIFB ③：会话域 sub 回归标题正下方 .head-sub（i=3），顶栏 hint 会话位清零防残留。
                      // 件十六：sub 行结构化（目录 span + 水位胶囊 + 活跃 span）——单文本入参落到目录段，
                      // 时间段清空（连接态文案整段落 dir 段）
                      const el = $id("session-head-sub");
                      if (el) {
                        const dir = el.querySelector("[data-sub-dir]");
                        const time = el.querySelector("[data-sub-time]");
                        if (dir) dir.textContent = String(text || "");
                        if (time) time.textContent = "";
                      }
                      window.__ccDeck005SetWindowbarHint?.("session", "");
                    },
                    headActions: $id("session-head-actions"), // W-UIFB（合并裁决）：开关随 i=3 定位 head 右侧
                    ctxMeter: $id("session-ctx-meter"), // UIPOLISH2 件四：head mini 水位胶囊（静态引用，同 modelCapsule 口径）
                    dock: $id("session-state-dock"),
                    composer: section.querySelector('[data-composer="session"]'),
                    sendBtn: section.querySelector("[data-composer-send]"),
                    stopBtn: section.querySelector("[data-composer-stop]"),
                    input: section.querySelector('[data-composer="session"] .composer-input'),
                    inspector: section.querySelector(".inspector"),
                    queueHead: section.querySelector(".queue-head"),
                    listTools: section.querySelector(".session-list-tools"),
                    convPane: null,
                  };
                  if (!UI.composer || !UI.sendBtn || !UI.input) return;
                  // 对话 pane：原型演示内容 → 真链路容器
                  if (panes[0]) {
                    panes[0].textContent = "";
                    const cp = document.createElement("div");
                    cp.className = "conversation-pane";
                    panes[0].appendChild(cp);
                    UI.convPane = cp;
                  }
                  // workspace 改 grid 三行两列——head 跨列/body+rail 同排/footer 跨列，禁 fixed）
                  for (let i = 1; i < panes.length; i++) { panes[i].removeAttribute("data-stub"); panes[i].textContent = ""; }
                  setupRowMenu(); // ⑥a-1 右键行菜单（容器级绑定，不随行重建销毁）
                  // B12 过程/思考开关：head-actions 点击由 #164 的 UI.section 域内委托统一接
                  // （4201 convTgl 分支，自带 stopPropagation）。本处曾再绑一层容器级委托——
                  // 双绑定点击翻两次=开关死钮（test.11 探针实锤：桌面 ⚙ 过程/✦ 思考点了没反应，
                  // 用户的 proc-off 态实来自手机端共用的 ccd_proc_show），2026-10-10 #47 批拆除
                  // 冗余层；B22 模型胶囊静态落 footer（composer 右侧）→ 直接绑
                  UI.modelCapsule = $id("session-model-capsule"); // W-TOPBAR ③：静态引用，ready 一次取定
                  if (UI.modelCapsule) {
                    UI.modelCapsule.addEventListener("click", () => {
                      const menu = document.getElementById("b2-model-menu");
                      if (menu) closeModelMenu(); else openModelMenu(UI.modelCapsule);
                    });
                  }
                  // UIPOLISH3 件三：权限胶囊静态接线（#195 件一：胶囊已迁 composer 左下角，id 不变引用直用）
                  UI.permCapsule = $id("session-perm-capsule");
                  if (UI.permCapsule) {
                    UI.permCapsule.addEventListener("click", () => {
                      const menu = document.getElementById("b2-perm-menu");
                      if (menu) closePermMenu(); else openPermMenu(UI.permCapsule);
                    });
                  }
                  // UIPOLISH2 件四：水位胶囊点击 → 「更多」tab 完整水位计（jumpToTask 的 tabs.click 同款链；
                  // renderMore 在 renderAll 已随会话渲染，切 tab 即见）
                  if (UI.ctxMeter) {
                    UI.ctxMeter.addEventListener("click", () => { if (UI.tabs[3]) UI.tabs[3].click(); });
                  }
                  // #124 tab 往返滚动保持：四 pane 共享 #session-body 滚动容器，切到任务/输出物/更多
                  // 时对话 pane display:none → scrollHeight 骤缩 → scrollTop 被 clamp（用户实锤「切回
                  // 跳到很上面」），clamp 派发的 scroll 事件还会把残值记回 S.scrollKeep。修复=离开对话
                  // tab 瞬间（捕获阶段，先于地基 wireSegmentTabs 冒泡 activate，display 未切、值未被
                  // clamp）记 memo 真值；切回后 activate 已完成（setTimeout 0），恢复位置——贴底态恢复
                  // 贴底。不碰 onScroll 记账/autoScroll/renderTasks：新消息贴底链与任务列表零回归。
                  section.querySelector(".segment-bar")?.addEventListener("click", (ev) => {
                    const btn = ev.target.closest("button");
                    const idx = btn ? UI.tabs.indexOf(btn) : -1;
                    if (idx < 0) return;
                    if (idx !== 0 && UI.tabs[0]?.classList.contains("active")) { // 离开对话 tab：此刻 DOM 未变，scrollTop 是真值
                      if (S.selected) {
                        const el = UI.body;
                        S.tabChatMemo = { sid: S.selected, top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 120 };
                      }
                    } else if (idx === 0) { // 回到对话 tab（含重复点击，幂等）：activate 完成后恢复
                      setTimeout(() => {
                        const memo = S.tabChatMemo;
                        S.tabChatMemo = null;
                        if (!memo || memo.sid !== S.selected) return; // 期间换过会话：不恢复（选中链自会定位）
                        const el = UI.body;
                        el.scrollTop = memo.bottom ? el.scrollHeight : Math.max(0, Math.min(memo.top, el.scrollHeight - el.clientHeight));
                      }, 0);
                    }
                  }, true); // 捕获阶段：先于 target/冒泡上的 activate
                  // UIPOLISH2 件九：会话列表搜索接线（原死控件激活）——150ms 防抖后重渲列表；
                  // 空态/隐藏记账（_filterHiddenIds）走 renderMyList 内的合并谓词
                  if (UI.listTools) {
                    const searchInput = UI.listTools.querySelector('input[type="search"]');
                    if (searchInput) {
                      let searchDebounce = 0;
                      searchInput.addEventListener("input", () => {
                        clearTimeout(searchDebounce);
                        searchDebounce = setTimeout(() => {
                          sessionSearchQuery = searchInput.value.trim();
                          renderMyList();
                        }, 150);
                      });
                    }
                  }
                  // 占位标记收编：已绑定面移除 data-stub；搜索/筛选拨给 B2b
                  UI.queueHead.removeAttribute("data-stub");
                  UI.workspace.removeAttribute("data-stub");
                  UI.inspector.removeAttribute("data-stub");
                  if (UI.listTools) UI.listTools.dataset.stub = "B2b";
                  bindEvents();
                  updateConvCtrl(); // B12 head 开关初值上色
                  // W-UIFB ⑧：子 Agent 面板折叠开关（标题行点击/键盘；agCollapsed 模块级记忆）
                  const agbox = document.getElementById("session-agbox");
                  if (agbox) {
                    agbox.addEventListener("click", (ev) => { if (ev.target.closest("[data-ag-toggle]")) toggleSubagents(); });
                    agbox.addEventListener("keydown", (ev) => {
                      if ((ev.key === "Enter" || ev.key === " ") && ev.target.closest("[data-ag-toggle]")) { ev.preventDefault(); toggleSubagents(); }
                    });
                  }
                  renderAll();
                }
                if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
                else ready();

                // ---------- 呼出/窗口焦点链 + IME（#240 旧壳 8356-8386 范式，桌面形态才挂） ----------
                // 窗口被全局呼出键/任务栏唤回时：60ms 后回焦 composer；mac 走原生合成点击
                // 激活输入法（ccDeck.imeClick），失败/被遮蔽回落 JS focus。
                if (window.ccDeck || window.__TAURI__) {
                  const IME_MAC = /Mac/i.test(navigator.userAgent);
                  const focusComposer = () => {
                    const el = UI && UI.input;
                    if (!el || el.disabled || !S.selected) return;
                    if (IME_MAC && window.ccDeck && typeof window.ccDeck.imeClick === "function") {
                      try {
                        const r = el.getBoundingClientRect();
                        const x = Math.max(4, Math.min(r.left + Math.min(r.width / 2, 60), window.innerWidth - 4));
                        const y = Math.max(4, Math.min(r.top + r.height / 2, window.innerHeight - 4));
                        if (document.elementFromPoint(x, y) === el) {
                          window.ccDeck.imeClick(x, y).catch(() => { try { el.focus({ preventScroll: true }); } catch (_) {} });
                          return;
                        }
                      } catch (_) { /* 坐标计算异常走 JS focus */ }
                    }
                    try { el.focus({ preventScroll: true }); } catch (_) {}
                  };
                  window.addEventListener("focus", () => setTimeout(focusComposer, 60));
                }

                // ⑥c-3 导出面：005-mobile IIFE 复用 B2 会话数据 / 历史只读判定 / 发送链（DV 备案预授权）
                // sendMessage 强耦合桌面 composer（读 UI.input 值），此处导出 sid+text 包装；
                // 命令类型与 sendMessage 同源：COMMAND_MESSAGE（托管）/ COMMAND_EXT_INPUT（external 会话）
                window.__ccDeck005B2 = {
                  S,
                  canCmd,
                  // #164 手机渲染路径同源复用：MD/消息 HTML/展开态/开关（桌面与手机同一渲染器）
                  mdHtml, userMsgHtml, taskRefRow, entryHtml, eKey, expanded,
                  artifactKindFor, // #B3-15 输出物六类分色（手机 mArtifactsHtml 同一判定）
                  artLayoutItems, relDir, artBadgeHtml, // #168 手机行同构复用（分组投影/目录缩略/徽章）
                  convCtl: { proc: () => procShow, think: () => thinkShown, toggle: toggleConv, refresh: updateConvCtrl },
                  sendPrompt(sid, text) {
                    const s = S.sessions.get(sid);
                    if (!s) return { sent: false, error: "会话不存在或未同步" };
                    if (!canCmd(s)) return { sent: false, error: "历史会话只读" };
                    const body = String(text ?? "").trim();
                    const imgs = S.staged.filter((f) => f.isImg).map((f) => f.b64); // #169 手机路径同样可带附件（与桌面 sendMessage 同构）
                    const files = S.staged.filter((f) => !f.isImg).map((f) => ({ name: f.name, b64: f.b64 }));
                    if (!body && !imgs.length && !files.length) return { sent: false, error: "空输入" };
                    if (imgs.length > IMG_MAX || files.length > FILE_MAX) return { sent: false, error: "附件超限（图 " + IMG_MAX + " / 文件 " + FILE_MAX + "）" };
                    const payload = Object.assign({ session_id: s.session_id, text: body }, imgs.length ? { images: imgs } : {}, files.length ? { files } : {});
                    const id = sendCmd(s.external ? "COMMAND_EXT_INPUT" : "COMMAND_MESSAGE", payload);
                    if (id) {
                      // W-PORT-A R-4：手机渲染路径同享乐观回显（与桌面 sendMessage 同构——echo push + ACK 失败标记）
                      if (body) {
                        const eq = S.echo.get(sid) || [];
                        eq.push({ key: "echo-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), text: body, ts: Date.now(), state: "sending" });
                        S.echo.set(sid, eq);
                        if (sidIsSelected(sid)) renderConversation();
                      }
                      const sf = (ack) => { const v = ackVerdict(ack); if (!v.ok) markEchoFail(sid, body); };
                      const wd2 = setTimeout(() => { if (S.ackWaiters.has(id)) { S.ackWaiters.delete(id); sf(null); } }, 10000);
                      S.ackWaiters.set(id, { res: sf, t: wd2 });
                      S.staged = []; renderTray(); return { sent: true };
                    }
                    return { sent: false, error: "relay 未连接，命令未发送" };
                  },
                  stopPrompt(sid) { // #169 手机停止钮（与桌面 stopSession 同命令面）
                    const s = S.sessions.get(sid);
                    if (!s) return false;
                    return commandAck(s.external ? "COMMAND_EXT_STOP" : "COMMAND_STOP", { session_id: s.session_id });
                  },
                  stageFiles, // #169 手机图片/附件入口复用（压缩/限额逻辑不重写）
                  slashFor(el) { slashUpdate(el); }, // W-SLASH：手机布局输入框共用联想浮层（透传补全）
                  slashClose() { slashHide(); },
                };
              })();
            