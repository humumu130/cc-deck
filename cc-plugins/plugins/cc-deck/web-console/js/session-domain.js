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

                const ENGINES = { claude: ["Claude", "claude"], codex: ["Codex", "codex"], trae: ["Trae", "trae"], "qwen-code": ["Qwen Code", "qwen"], codebuddy: ["Codebuddy", "codebuddy"], zcode: ["ZCode", "zcode"] };
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
                        const srcName = String((m.payload && m.payload.relay_name) || (evSource && evSource.relayName) || "");
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
                  S.homedir = p.homedir || ""; S.platform = p.platform || "";
                  S.models = Array.isArray(p.models) ? p.models : [];
                  S.projects = Array.isArray(p.projects) ? p.projects : []; // 项目组索引：会话列表「其他会话」按项目子分组（⑥a-2）
                  S.experiences = Array.isArray(p.experience) ? p.experience.filter((e) => e && typeof e.id === "string" && typeof e.text === "string") : null; // W-EXPP2
                  const caps = p.source_capabilities;
                  S.engineCatalog = caps && Array.isArray(caps.engine_catalog) ? caps.engine_catalog : null;
                  if (!S.sessions.has(S.selected)) S.selected = "";
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
                // no-leader → 锚卡本地全套回收（复用 onDeleted：列表/转录/附图/草稿/选中态）；
                // leader → 锚卡 upsert 回列表（帧带完整卡）。设置页开关回显走桥缓存（bridge 侧同帧合并）
                function onCollabMode(p) {
                  if (!p || (p.mode !== "leader" && p.mode !== "no-leader")) return;
                  S.collabMode = p.mode;
                  if (p.mode === "no-leader") {
                    const lid = typeof p.leader_session_id === "string" ? p.leader_session_id : "";
                    if (lid && S.sessions.has(lid)) onDeleted(lid);
                  } else if (p.leader_session && typeof p.leader_session.session_id === "string" && !S.sessions.has(p.leader_session.session_id)) {
                    S.sessions.set(p.leader_session.session_id, p.leader_session);
                    renderMyList();
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
                  // W-PORT-A R-4 回显对账：本会话自己发出的 user 消息回显到达 → 撤最早同文 sending 态 echo
                  if (msgRoleOf(entry.kind) === "user") {
                    const eq = S.echo.get(sid);
                    if (eq && eq.length) {
                      const txt = String(entry.full ?? entry.text ?? "");
                      const i = eq.findIndex((x) => x.state === "sending" && x.text === txt);
                      if (i >= 0) { eq.splice(i, 1); if (!eq.length) S.echo.delete(sid); if (UI && sid === S.selected) renderConversation(); }
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
                // B11 分组折叠态：collapsedGroups 记「默认展开、点击收起」的组（active），
                // 持久 localStorage；observer 完整性检查据 _collapsedIdleIds 放行缺卡防重渲
                // 死循环（折叠未展开不进 DOM）。
                // W-NOVAUI ⑤：闲置会话铺平（用户实测按项目分组太乱）——项目组/折叠语义整链退役
                // UIPOLISH3 件二：团队组收纳（team:* 组 + expandedTeams 独立展开记账）——#103
                // 两段式重排（2026-10-14 用户拍板）整链退役：编制会话（PM/Leader/置顶 worker）
                // 一律直列平铺进上段，团队呈现收口到下段 dock 入口卡；team:* 前缀路由与
                // TEAM_EXPAND_KEY/expandedTeams 随组退役，折叠只剩 slim-teams dock 一处，
                // 走 collapsedGroups（默认展开，键在=折叠，与旧 slim-teams 态无缝续用）。
                const GRP_COLLAPSE_KEY = "cc-deck-005-grp-collapsed";
                let collapsedGroups = (() => { try { const v = JSON.parse(localStorage.getItem(GRP_COLLAPSE_KEY) || "[]"); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []); } catch (_) { return new Set(); } })();
                function persistCollapsedGroups() { try { localStorage.setItem(GRP_COLLAPSE_KEY, JSON.stringify([...collapsedGroups])); } catch (_) {} }
                function toggleGroupCollapse(key) {
                  if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
                  persistCollapsedGroups();
                  renderMyList();
                }
                const GRP_ACCENTS = ["var(--brand)", "var(--info)", "var(--done)", "var(--working)"]; // 件C③：团队色轮（组序注入，>4 组循环）；V8R+ 提升共享——PM 归属 chip 同轮取色
                // V8R+（Leader 1014 追加）：PM/Leader 直列卡的「所属团队」归属 chip 数据——
                // 编制内 role 命中 pm/leader 的会话返回 {name, accent}（团队名+色轮色，按 S.projects
                // 序取色=同团队恒同色）；无归属返回 null（不显示空标识）。worker/QA 会话已被
                // 团队收纳/入口卡聚合，不在直列面，天然不触发。
                function pmTeamChipOf(sid) {
                  if (!Array.isArray(S.projects)) return null;
                  for (let pi = 0; pi < S.projects.length; pi++) {
                    const p = S.projects[pi];
                    const hc = Array.isArray(p && p.headcount) ? p.headcount : [];
                    for (const m of hc) {
                      if (m && m.session_id === sid && /^(pm|leader|产品经理|项目经理|领队)$/i.test(String(m.role || ""))) {
                        return { name: String(p.name || p.id), accent: GRP_ACCENTS[pi % GRP_ACCENTS.length] };
                      }
                    }
                  }
                  return null;
                }
                function myCardItem(session) {
                  const status = ({ WORKING: "working", WAITING: "waiting", ERROR: "error", DONE: "done" })[session.status] || "done";
                  const engineKey = session.engine || "claude";
                  const engine = ENGINES[engineKey] || [engineKey, ""];
                  const activityTime = Number(session.updated_at || session.started_at || 0);
                  const turnStart = Number(session.turn_started_at || session.started_at || Date.now());
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
                    team: pmTeamChipOf(session.session_id), // V8R+：PM/Leader 所属团队归属（null=无归属不显）
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
                const b2EngineBadge = (item) => '<span class="engine-badge ' + item.engineClass + '"><svg class="engine-icon" aria-hidden="true"><use href="#icon-' + b2EngineIconFor(item.engineClass) + '"></use></svg>' + item.engine + "</span>";
                // FB19 源色块：源色不再「家里 iMac 二值」——按源名哈希取八色环，同名恒色异名易分
                const b2SourcePalette = ["#3E8E7E", "#5B8FA8", "#8A7AB5", "#A8763E", "#7D9A3C", "#B55F7A", "#4E85C0", "#9A8A4E"];
                const b2SourceColor = (source) => {
                  const s = String(source || "");
                  if (!s) return "var(--source)";
                  let h = 0;
                  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
                  return b2SourcePalette[h % b2SourcePalette.length];
                };
                // UIPOLISH2 件一：头像底色引擎品牌色淡彩——地基 sessionAvaColor 逐字节同构（myCardMarkup
                // 与地基 renderSessionCard 的 DOM 一致性是 observer 完整性检查的前提，两处必须同步改）
                const b2AvaColor = (item) => ({
                  claude: "var(--engine-claude)", codex: "var(--engine-codex)", trae: "var(--engine-trae)",
                  qwen: "var(--engine-qwen)", codebuddy: "var(--engine-codebuddy)", zcode: "var(--engine-zcode)",
                }[item.engineClass] || b2SourceColor(item.source));
                function myCardMarkup(item) {
                  // B2 批2 A#bg-live：⑂N 徽标从 r3 迁 r2 走秒行前（warn 呼吸点 + task-ref chip 形制 tag）；
                  // bgCount>0 恒显（任意状态、含 WORKING）；r3 回归置顶/引擎/来源
                  const b2SourceBadge = (item) => '<span class="source-badge" style="color:' + b2SourceColor(item.source) + ";border-color:" + b2SourceColor(item.source) + ";background:color-mix(in srgb, " + b2SourceColor(item.source) + ' 14%, transparent)">' + item.source + "</span>"; // W-WINPAIR-R6：八色环源色徽章（源色底块增强辨识）
                  return '<div class="queue-card' + (item.selected ? " selected" : "") + (item.idle ? " idle" : "") + '" data-session-card="' + item.id + '"><span class="srow-ava" style="--srow-ava-c:' + b2AvaColor(item) + '">' + (item.title || "·").trim().charAt(0).toUpperCase() + '<i class="status-dot ' + item.status + '"></i></span><span class="srow-main"><span class="srow-r1"><strong title="' + item.title + '">' + item.title + "</strong>" + (item.time ? '<time class="srow-time">' + item.time + "</time>" : "") + '<button type="button" class="srow-more" aria-label="会话操作菜单" title="更多操作">⋯</button><button type="button" class="srow-pin' + (item.pinned ? " on" : "") + '" aria-label="' + (item.pinned ? "取消置顶" : "置顶") + '" title="' + (item.pinned ? "取消置顶" : "置顶") + '"><svg class="icon-inline" aria-hidden="true"><use href="#icon-pin"></use></svg></button><button type="button" class="srow-close" aria-label="删除会话" title="删除会话"><svg class="icon-inline" aria-hidden="true"><use href="#icon-x"></use></svg></button></span><span class="srow-r2">' + (item.bg ? '<i class="srow-live-dot"></i><span class="tag bg-live-tag" title="后台子 Agent 在跑">⑂' + item.bg + "</span>" : "") + (item.status === "done" && item.queuedDispatch > 0 ? '<span class="tag dispatched-flag" title="该会话所属组有 ' + item.queuedDispatch + ' 个派单排队等待处理">已派单 · 等待处理</span>' : "") + '<span class="srow-r2-t">' + item.summary + "</span>" + (item.status === "working" ? '<span class="srow-sec" data-work-sec="' + (item.workSecs || 0) + '">' + (item.workSecs || 0) + "s</span>" : "") + "</span>" + (item.team || item.engine || item.source || item.pinned ? '<span class="srow-r3">' + (item.pinned ? '<span class="tag pin-flag">置顶</span>' : "") + (item.team ? '<span class="team-chip" title="所属团队：' + esc(item.team.name) + '" style="--team-accent:' + item.team.accent + '"><i aria-hidden="true"></i><span class="tc-name">' + esc(item.team.name) + "</span></span>" : "") + b2EngineBadge(item) + b2SourceBadge(item) + "</span>" : "") + "</span>" + (item.tagClass === "action" || item.tagClass === "danger" ? '<button type="button" class="srow-cta">处理</button>' : "") + "</div>";
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
                function slimTeamEntryMarkup(team, roster, sessionsMap, filterDef) {
                  const kept = [], hidden = [];
                  for (const m of team.members) {
                    const s = sessionsMap.get(m.session_id);
                    if (!s) continue; // 编制在、会话未同步（异源）不计（仅影响 mini 灯/命中，不再影响出卡）
                    (SLIM_KEEP_ROLE.test(String(m.role || "")) ? kept : hidden).push({ m, s });
                  }
                  // t25fix #4（验收 T2）：快照刚到的时序窗内，0 同步成员的团队卡先不出——
                  // 编制帧与会话帧到达有先后，首渲染易闪「0/0/0 无灯」残卡；1.2s 稳定窗后
                  // 恢复 #99件5 出卡口径（编制在场即出卡，异源团队不回归）
                  if (!kept.length && !hidden.length && S.snapshotAt && Date.now() - S.snapshotAt < 1200) return "";
                  const hit = hidden.filter((x) => !filterDef || filterDef.test(x.s));
                  // #99件5（Watchtower 等缺入口卡根修）：出卡前提从「有已同步收起会话」放宽为
                  // 「编制在场即出卡」——成员会话未同步（异源）或全 PM/Leader 的团队不再被
                  // continue 链路筛没（入口卡承担「点击去团队域」职能，与成员会话同步与否解耦）；
                  // 筛选语义保留：非「全部」档下该团队无命中状态仍不出卡（纯粹性不破）。注意
                  // sessionFilterOf 恒返回对象（全部档=test 恒真），「全部」判定必须走 id，不能
                  // 以 filterDef 真值为据（首版实错：Watchtower 恒被筛没）
                  const isAllFilter = !filterDef || filterDef.id === "all";
                  if (!hit.length && (!isAllFilter || !team.members.length)) return "";
                  // #99件6（口径归一）：计数从「已同步收起会话数」（hit.length）统一为编制
                  // roster 口径——rosterN=编制席全量（含 PM/Leader 与未同步成员，与团队域
                  // 「N 席」/检查器成员块同源）；running=编制内已同步且 WORKING 数（原含
                  // WAITING/ERROR 的「进行中」宽口径退役，与组头 workingN 同判）
                  const rosterN = team.members.length;
                  const running = team.members.filter((m) => { const s = sessionsMap.get(m.session_id); return s && s.status === "WORKING"; }).length;
                  const acceptance = Number.isFinite(Number(team.acceptance_count)) ? Math.max(0, Number(team.acceptance_count)) : 0;
                  // 1014 追加（用户：3 人在岗只见 1 颗队级绿点）：mini 行=每在岗成员一颗显性
                  // 心态灯（WORKING=绿呼吸/其余=灰；角色与状态词收进 title 悬停）——原 badge
                  // 字+6px 角点形态灯存在感为零；**在岗优先排序**（用户截图：绿点被折进
                  // +N 看不见）——running 稳定前置再截 5+N，绿点恒前排可见
                  const lampOrder = hit.slice().sort((a, b) => Number(b.s.status === "WORKING") - Number(a.s.status === "WORKING"));
                  const minis = lampOrder.slice(0, 5).map((x) => {
                    const stCls = ({ WORKING: "working", WAITING: "blocked", ERROR: "error", DONE: "idle" })[x.s.status] || "closed"; // 1014 五色词表
                    const stWord = ({ WORKING: "在跑", WAITING: "待确认", ERROR: "异常", DONE: "空闲" })[x.s.status] || "离线";
                    const who = (SLIM_KEEP_ROLE.test(String(x.m.role || "")) ? "✦" : /^(qa|reviewer|验收)$/i.test(String(x.m.role || "")) ? "QA" : "W") + " " + (x.s.title || x.m.session_id).slice(0, 24);
                    return '<span class="worker-mini lamp" title="' + esc(who + " · " + stWord) + '"><i class="lamp-dot ' + stCls + '"></i></span>';
                  }).join("") + (hit.length > 5 ? '<span class="worker-mini more" title="还有 ' + (hit.length - 5) + ' 个成员会话">+' + (hit.length - 5) + "</span>" : "");
                  const teamAria = team.name + " · " + rosterN + " 席编制 · " + running + " 个在跑 · " + acceptance + " 个待验收";
                  // t25fix #5：团队入口卡源徽章（成员已同步会话的源去重；单源模式由
                  // body[data-source-count="1"] CSS 隐藏，聚合模式恒显）
                  const teamSrcs = [...new Set([kept, hidden].flat().map((x) => String((x.s && x.s.relay_source) || "")).filter(Boolean))];
                  const teamSrcBadges = teamSrcs.slice(0, 2).map((src) => '<span class="source-badge" title="成员所属源" style="color:' + b2SourceColor(src) + ";border-color:" + b2SourceColor(src) + ';background:color-mix(in srgb, ' + b2SourceColor(src) + ' 14%, transparent)">' + esc(src) + "</span>").join("") + (teamSrcs.length > 2 ? '<span class="source-badge">' + teamSrcs.length + " 源</span>" : "");
                  const avatar = String(team.name || team.id || "团").trim().charAt(0).toUpperCase() || "团";
                  // 1014 追加：队级聚合灯语义明确化——头像角点=整队健康度（任一成员在跑=呼吸/
                  // 全闲=灰），与成员 mini 灯形成「队健康 × 人人灯」两级；title 明示语义；
                  // #99件6：判定同编制口径（running），未同步成员不算活
                  const teamAlive = running > 0;
                  return '<div class="team-entry" data-slim-team="' + esc(team.id) + '" role="button" tabindex="0" aria-label="' + esc(teamAria + "，点击去团队域") + '"><span class="t-ava" aria-hidden="true">' + esc(avatar) + '<i class="lamp-dot team-health ' + (teamAlive ? "working" : "idle") + '" title="整队健康度：' + running + ' 人在跑"></i></span><span class="t-main"><span class="t-name">' + esc(team.name) + teamSrcBadges + '</span><span class="t-counts" aria-label="' + esc(teamAria) + '"><span class="t-count" title="编制席位"><svg class="icon-inline" aria-hidden="true"><use href="#icon-user"></use></svg><b>' + rosterN + '</b></span><span class="t-count" title="在跑（工作中）"><svg class="icon-inline t-running-icon" aria-hidden="true"><use href="#icon-user"></use></svg><b>' + running + '</b></span><span class="t-count" title="待验收"><svg class="icon-inline t-accept-icon" aria-hidden="true"><use href="#icon-accept"></use></svg><b>' + acceptance + '</b></span></span><span class="worker-mini-row">' + minis + "</span></span>" + '<button type="button" class="t-expand" data-slim-drawer-toggle="' + esc(team.id) + '" title="展开该团队成员会话（第四列）" aria-label="展开 ' + esc(team.name) + ' 成员会话">⤢</button></div>';
                }
                function slimDrawerCardMarkup(item) {
                  return '<div class="queue-card" data-slim-open="' + item.id + '" role="button" tabindex="0" aria-label="打开 ' + item.title + '"><span class="srow-ava" style="--srow-ava-c:' + b2SourceColor(item.source) + '">' + (item.title || "·").trim().charAt(0).toUpperCase() + '<i class="status-dot ' + item.status + '"></i></span><span class="srow-main"><span class="srow-r1"><strong title="' + item.title + '">' + item.title + "</strong>" + (item.time ? '<time class="srow-time">' + item.time + "</time>" : "") + '</span><span class="srow-r2"><span class="srow-r2-t">' + item.summary + "</span>" + (item.status === "working" ? '<span class="srow-sec" data-work-sec="' + (item.workSecs || 0) + '">' + (item.workSecs || 0) + "s</span>" : "") + "</span>" + (item.engine || item.source ? '<span class="srow-r3">' + b2EngineBadge(item) + '<span class="source-badge">' + item.source + "</span></span>" : "") + "</span></div>";
                }
                function renderSlimDrawer() {
                  const el = document.querySelector("#d-session [data-slim-drawer]");
                  if (!el) return;
                  if (!S.drawerGid && el.hidden) return; // 收起态稳态早退（UPDATED 高频路径零 DOM 操作）
                  const team = S.drawerGid ? slimRosterOf(S.projects).teams.get(S.drawerGid) : null;
                  if (!team) { if (S.drawerGid) { S.drawerGid = ""; try { localStorage.setItem("cc-deck-005-slim-drawer", ""); } catch (_) {} } el.hidden = true; el.replaceChildren(); return; }
                  el.hidden = false;
                  const cards = team.members.filter((m) => !SLIM_KEEP_ROLE.test(String(m.role || "")) && S.sessions.has(m.session_id)).map((m) => ({ s: S.sessions.get(m.session_id), m })).sort((a, b) => Number(b.s.updated_at || 0) - Number(a.s.updated_at || 0));
                  const head = '<div class="drawer-head"><span class="d-name">' + esc(team.name) + " · 成员会话</span><span class=\"d-cnt\">" + cards.length + '</span><button type="button" class="t-expand" data-slim-drawer-toggle="' + esc(team.id) + '" title="收起成员会话" aria-label="收起成员会话">✕</button></div>';
                  const body = cards.length ? '<div class="drawer-body">' + cards.map((x) => slimDrawerCardMarkup(myCardItem(x.s))).join("") + "</div>" : '<div class="drawer-body"><div class="readonly-banner">该团队暂无成员会话 · 编制在团队域维护</div></div>';
                  el.innerHTML = head + body;
                }
                function slimMarkSeen(gid) {
                  if (!gid || !S.slimUnread.has(gid)) return;
                  S.slimUnread.delete(gid);
                  renderMyList();
                  if (UI && curSession()) renderInspector();
                }
                function slimToggleDrawer(gid) {
                  const want = String(gid || "");
                  S.drawerGid = S.drawerGid === want ? "" : want;
                  try { localStorage.setItem("cc-deck-005-slim-drawer", S.drawerGid); } catch (_) {}
                  if (S.drawerGid) slimMarkSeen(S.drawerGid); // 展开即清该团队未读（设计要点 1）
                  renderSlimDrawer();
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
                window.__ccDeck005SlimUi = Object.freeze({ open: slimOpenSession, markSeen: slimMarkSeen, toggleDrawer: slimToggleDrawer }); // 跨域面：团队域成员卡直开 / 团队 select 清未读（团队域侧调用）
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
                  // #103 两段式（用户提案+Leader 细化）：列表分上/下两块——上段=会话（.list-upper
                  // flex:1 滚动），下段=团队 dock（flex:none 常驻列表底；折叠后只剩顶栏吸附最底=
                  // IDE status-bar 形态，顶栏保留聚合健康灯+未读数+队数/在跑计数）。dock 构建
                  // 前置于两个空态分支：会话空态（SNAPSHOT 空或筛选空）团队区照常渲染——编制
                  // 在场即有入口（与件5 同源），上段空时 dock 自然上移。#99件4：标题「团队」→
                  // 「team」；计数=队数（双人图标=团队概念，与成员单人图标分工）。
                  const slimTeamsOpen = !collapsedGroups.has("slim-teams");
                  const slimEntries = [...slimRoster.teams.values()].map((t) => slimTeamEntryMarkup(t, slimRoster, S.sessions, filterDef)).filter(Boolean);
                  const dockRunning = [...slimRoster.teams.values()].reduce((n, t) => n + t.members.filter((m) => { const s = S.sessions.get(m.session_id); return s && s.status === "WORKING"; }).length, 0); // 编制口径在跑总数（与入口卡 running 同判）
                  const dockAlive = dockRunning > 0;
                  const unreadTeams = S.slimUnread.size;
                  const dockNode = (() => {
                    if (!slimEntries.length) return null;
                    const head = '<div class="queue-group" data-group-toggle="slim-teams" role="button" tabindex="0" aria-expanded="' + (slimTeamsOpen ? "true" : "false") + '" title="展开/收起团队区"><span class="grp-caret">▸</span><span class="grp-ava" aria-hidden="true">T</span><span>team</span><i class="dock-lamp' + (dockAlive ? " on" : "") + '" title="' + (dockAlive ? dockRunning + " 人在跑" : "全部空闲") + '"></i><span class="grp-count" data-session-group-count><svg class="icon-inline grp-ic" aria-hidden="true"><use href="#icon-users"></use></svg>' + slimEntries.length + (dockRunning ? ' <svg class="icon-inline grp-ic on" aria-hidden="true"><use href="#icon-user"></use></svg>' + dockRunning : "") + '</span>' + (unreadTeams ? '<span class="dock-unread" title="有团队新输出未在看">' + unreadTeams + "</span>" : "") + "</div>";
                    const tpl = document.createElement("template");
                    tpl.innerHTML = '<div class="session-group teams-dock' + (slimTeamsOpen ? "" : " collapsed") + '" data-session-group="slim-teams">' + head + '<div class="grp-body">' + slimEntries.join("") + "</div></div>";
                    return tpl.content.firstElementChild;
                  })();
                  const mountTwoPane = (upperContent) => { // 两段拼装单口：上段节点（会话卡/空态占位）+dock（编制空时不建）
                    const upper = document.createElement("div");
                    upper.className = "list-upper";
                    upper.append(upperContent);
                    if (upperContent instanceof Element && upperContent.dataset.sessionEmpty === "true") upper.classList.add("is-empty"); // #103-B3 空态：上段不撑满随内容收缩，dock 自然上移
                    if (dockNode) list.replaceChildren(upper, dockNode);
                    else list.replaceChildren(upper);
                  };
                  if (!S.sessions.size) {
                    const ph = document.createElement("div");
                    ph.className = "readonly-banner";
                    ph.dataset.sessionEmpty = "true";
                    ph.setAttribute("role", "status");
                    ph.textContent = "暂无会话 · relay SNAPSHOT 已同步";
                    mountTwoPane(ph);
                    return;
                  }
                  // 1015 置顶常驻（用户需求）：筛选档不隐藏置顶卡——pinned 豁免 filterDef.test 恒进
                  // 渲染集钉最顶（不因「进行中/已完成」等状态档不匹配而被筛掉）；搜索不豁免——
                  // sessionSearchTest 是用户显式找词，置顶卡不匹配搜索词照隐藏；slim 收起不豁免——
                  // slimIsHidden 本就置顶例外（:3709）。主过滤与 filterHidden 记账共用 pinnedKeep
                  // 谓词，记账恒等于真实隐藏集（mo 完整性检查口径不漂）。
                  const pinnedKeep = (x) => x.pinned === true;
                  const sessions = [...S.sessions.values()].filter((x) => (pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x) && slimVisible(x)).sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || Number(b.updated_at || 0) - Number(a.updated_at || 0));
                  // FB17：被筛掉的 sid 记账——观察者完整性检查据此放行，防「缺卡→重渲→仍缺」死循环（同 _collapsedIdleIds 口径）；件九搜索并入同一隐藏口径
                  const filterHidden = [...S.sessions.values()].filter((x) => !((pinnedKeep(x) || filterDef.test(x)) && sessionSearchTest(x))).map((x) => x.session_id);
                  S._filterHiddenIds = filterHidden.length ? new Set(filterHidden) : null;
                  // [t-7e0c6189] 被收起的 sid 记账——同 FB17 口径放行（否则 mo 完整性检查「缺卡」死循环）
                  const slimHiddenIds = [...S.sessions.values()].filter((x) => filterDef.test(x) && !slimVisible(x)).map((x) => x.session_id);
                  S._slimHiddenIds = slimHiddenIds.length ? new Set(slimHiddenIds) : null;
                  if (!sessions.length) {
                    const ph = document.createElement("div");
                    ph.className = "readonly-banner";
                    ph.dataset.sessionEmpty = "true";
                    ph.textContent = sessionSearchQuery
                      ? "搜索「" + sessionSearchQuery + "」下暂无会话 · 可换个词或清空搜索"
                      : "「" + filterDef.label + "」筛选下暂无会话 · 切回「全部」查看";
                    mountTwoPane(ph);
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
                  // #103 两段式拼装：上段=置顶+活跃+闲置平铺（.list-upper 滚动），下段=dock（前置
                  // 构建，编制空则不建）
                  const tpl = document.createElement("template");
                  tpl.innerHTML = pinnedMarkup + activeMarkup + idleMarkup;
                  mountTwoPane(tpl.content);
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
                function canCmd(s) { return !!s && (!s.historical || s.external === true); }
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
                  const eng = ENGINES[s.engine || "claude"] || [s.engine || "Claude", ""];
                  // W-TOPBAR ③ head 身份收敛：只剩 engine 徽章一颗；数据源归顶栏源胶囊、外部会话
                  // 「CLI」标从独立 tag 降为徽章内文字后缀（身份类三胶囊 → 一颗）。
                  // W-UIFB ③（合并裁决）：徽章加 sprite 图标（b2EngineIconFor，与第二列同款）；
                  // 模型胶囊维持 W-TOPBAR ③ 静态落 composer 位（U5 验收 pass 形态），不随 renderHeader 重建
                  UI.identity.innerHTML = '<span class="engine-badge ' + eng[1] + '"><svg class="engine-icon" aria-hidden="true"><use href="#icon-' + b2EngineIconFor(eng[1]) + '"></use></svg>' + esc(eng[0]) + (s.external ? " · CLI" : "") + "</span>";
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
                  { key: "default", zh: "标准（每次确认）" },
                  { key: "acceptEdits", zh: "自动接受编辑" },
                  { key: "plan", zh: "规划（只读）" },
                  { key: "bypassPermissions", zh: "跳过权限确认" },
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
                  const opText = w ? [w.tool_name, w.input_summary].filter(Boolean).join(" · ") : (s.action_summary || s.last_error || "");
                  op.textContent = opText ? String(opText).replace(/^\u200B+/, "").slice(0, 90) : "";
                  if (tok) { const u = Number(s.context_usage) || 0; tok.hidden = live || !u; tok.textContent = u ? tokStr(u) + "/" + tokStr(s.context_limit || 1e6) : ""; } // A0-1 token 内联「34k/200k」
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
                  const base = s.status === "WORKING" ? (s.turn_started_at || s.started_at) : (s.waiting_started_at || s.updated_at || s.started_at);
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
                  const eng = ENGINES[s.engine || "claude"] || ["Claude"];
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
                    const eng = ENGINES[s.engine || "claude"] || ["Claude"];
                    const st = STATUS_TAG[s.status] || ["完成", "done"];
                    const inspSrc = String(s.relay_source || S.relayName || ""); // t25fix #5：详情面板源徽章（单源模式 CSS 隐藏）
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
                        html += '<div class="inspector-block slim-team-block"><div class="inspector-title"><span>团队成员 · ' + esc(slimTeamObj.name) + "</span><span>" + slimTeamObj.members.length + ' 席</span></div><div class="member-chips">' + chips + '</div><button type="button" class="slim-drawer-link" data-slim-drawer-toggle="' + esc(slimMem.gid) + '">展开成员会话 ⤢</button></div>';
                      }
                    }
                    if (todos.length) html += '<div class="inspector-block"><div class="inspector-title"><span>任务清单</span><span>' + done + "/" + todos.length + '</span></div>' + open.map((t) => '<div class="check-row">' + (t.status === "in_progress" ? '<b class="run">◐</b>' : '<span>○</span>') + "<span>" + esc(t.status === "in_progress" && t.active_form ? t.active_form : t.content || "") + "</span></div>").join("") + "</div>";
                    if (s.context_usage) html += '<div class="inspector-block"><div class="inspector-title"><span>用量</span><span>' + ctxPct(s) + '%</span></div>' + ctxMeterHtml(s) + "</div>";
                    // W-CTXFIX B3：压缩前状态摘要（有摘要才渲染，原生 details 默认折叠）
                    if (s.pre_compact_summary) html += '<div class="inspector-block"><details class="pcsum"><summary>压缩前状态摘要<span>已自动注入恢复</span></summary><pre>' + esc(s.pre_compact_summary) + "</pre></details></div>";
                    const arts = Array.isArray(s.artifacts) ? s.artifacts.filter((a) => a && a.path) : [];
                    if (arts.length) {
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
                    const eng = ENGINES[(s && s.engine) || "claude"] || ["Claude"];
                    const full = e.full ? String(e.full) : "";
                    return '<div class="message-ai" data-x="' + ke + '"><button type="button" class="copy-btn msg-copy" data-x="' + ke + '" title="复制全文" aria-label="复制消息全文">⧉</button><div class="message-author"><span class="ai-ava">✻</span><strong>' + esc(eng[0]) + "</strong>" + (e.ts ? "<time>" + fmtHM(e.ts) + "</time>" : "") + '</div><div class="message-body">' +
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
                  if (passive) {
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
                    if (v.ok) { markWaitCardDone(card, kind === "deny"); if (kind === "deny") b2Toast("已拒绝 · 可在输入栏补充说明"); }
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
                  const eng = ENGINES[s.engine || "claude"] || ["Claude"];
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
                  const running = !!(editable && (s.status === "WORKING" || s.status === "WAITING"));
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
                  UI.section.addEventListener("keydown", (ev) => {
                    if (ev.key !== "Enter" && ev.key !== " ") return;
                    const t = ev.target.closest("[data-slim-team], [data-slim-open], [data-slim-drawer-toggle]");
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
                    const slimOpen = ev.target.closest("[data-slim-open]");
                    if (slimOpen) { ev.stopPropagation(); slimOpenSession(slimOpen.dataset.slimOpen); return; }
                    const slimTeam = ev.target.closest("[data-slim-team]");
                    if (slimTeam) {
                      ev.stopPropagation();
                      const gid = slimTeam.dataset.slimTeam;
                      slimMarkSeen(gid); // 进团队域即清未读（设计要点 1）
                      window.__ccDeck005B4?.railJump?.("team"); // 跳团队域（rail-btn 点击链）
                      window.ccDeckTeam?.select?.(gid);
                      return;
                    }
                    const grpTgl = ev.target.closest("[data-group-toggle]"); // B11 通用分组折叠（进行中组；W-NOVAUI ⑤ 项目组已退役）
                    if (grpTgl) { ev.stopPropagation(); toggleGroupCollapse(grpTgl.dataset.groupToggle); return; }
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
                    if (ev.key === "Escape") { closeCreatePop(); closeModelMenu(); closePermMenu(); window.__ccDeck005ClosePlusMenu && window.__ccDeck005ClosePlusMenu(); closeArtViewer(); slashHide(); document.querySelectorAll("#d-session .artifact-menu.open").forEach((x) => x.classList.remove("open")); }
                  });

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
                  if (plusBtn) {
                    const fileInput = document.createElement("input");
                    fileInput.type = "file";
                    fileInput.multiple = true; // 任意类型（旧壳 #92 文件入口口径）
                    fileInput.hidden = true;
                    document.body.appendChild(fileInput);
                    fileInput.addEventListener("change", () => { stageFiles(fileInput.files); fileInput.value = ""; });
                    const imgInput = document.createElement("input");
                    imgInput.type = "file";
                    imgInput.multiple = true;
                    imgInput.accept = "image/*"; // #169 图片入口（image/* 选择器，压缩/限额走既有 stageFiles）
                    imgInput.hidden = true;
                    document.body.appendChild(imgInput);
                    imgInput.addEventListener("change", () => { stageFiles(imgInput.files); imgInput.value = ""; });
                    window.__ccDeck005ClosePlusMenu = () => { const m = document.getElementById("b2-plus-menu"); if (m) m.remove(); };
                    plusBtn.addEventListener("click", (ev) => {
                      ev.stopPropagation();
                      window.__ccDeck005ClosePlusMenu();
                      const menu = document.createElement("div");
                      menu.id = "b2-plus-menu";
                      menu.className = "model-menu"; // 与 perm/model 菜单同壳样式
                      menu.setAttribute("role", "menu");
                      menu.innerHTML = '<div class="source-menu-head">添加附件</div>'
                        + '<button type="button" class="source-option" data-plus-img role="menuitem"><strong>添加图片</strong><small>最多 8 张 · 可 ⌘V 粘贴</small></button>'
                        + '<button type="button" class="source-option" data-plus-file role="menuitem"><strong>添加文件</strong><small>最多 5 个 · 单个 20MB</small></button>';
                      document.body.appendChild(menu);
                      menu.classList.add("open");
                      const r = plusBtn.getBoundingClientRect();
                      const mw = menu.offsetWidth, mh = menu.offsetHeight;
                      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
                      menu.style.top = Math.max(8, r.top - mh - 8) + "px"; // 输入框左下角 → 菜单向上弹
                      menu.addEventListener("click", (me) => {
                        const img = me.target.closest("[data-plus-img]");
                        const file = me.target.closest("[data-plus-file]");
                        if (img || file) { window.__ccDeck005ClosePlusMenu(); (img ? imgInput : fileInput).click(); UI.input.focus(); }
                      });
                    });
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
                  if (UI.sessionList) { // B11 组头键盘可达（role=button）
                    UI.sessionList.addEventListener("keydown", (ev) => {
                      if (ev.key !== "Enter" && ev.key !== " ") return;
                      const head = ev.target.closest("[data-group-toggle]");
                      if (!head) return;
                      ev.preventDefault();
                      toggleGroupCollapse(head.dataset.groupToggle);
                    });
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
            