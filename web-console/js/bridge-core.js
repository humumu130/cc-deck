              (() => {
                "use strict";
                // #143-B4 项目域（只读聚合）域内脚本：订阅地基帧总线（#150 R1 去 B4-D2 劫持，
                // R2 B2 并轨，全页唯一 WS）+ SNAPSHOT/增量帧本地聚合 + 只读渲染。边界：只操作
                // #d-project 内部 DOM 与共享桥全局；不改 <style>、不改底部地基脚本（偏差与契约见 specs/005-port-B4-report.md）。

                // #150 R1 帧总线：本 IIFE 是全页最早需要总线的脚本，在此幂等创建并挂 window——
                // 地基脚本（文件更靠后）持唯一主连接，经总线 fan-out 原始帧与 ws 事件；域脚本
                // 一律订阅总线取帧，不再劫持 window.WebSocket。B2 并轨（R2）时同样判空复用本实例。
                if (!window.__ccDeck005Frames) {
                  window.__ccDeck005Frames = (() => {
                    const subs = new Set();
                    return {
                      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
                      emit(ev) { for (const fn of subs) { try { fn(ev); } catch (_) {} } }, // ev = {kind:"frame", frame} | {kind:"ws", state:"connecting"|"open"|"close"}
                    };
                  })();
                }
                const section = document.getElementById("d-project");
                if (!section) return;

                // ---------- 通用工具（转义/相对时间/引擎徽标/toast 均按地基同款口径） ----------
                const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
                const relTime = (ts) => {
                  const t = Number(ts || 0);
                  if (!t) return "";
                  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
                  if (sec < 60) return "刚刚";
                  const min = Math.floor(sec / 60);
                  if (min < 60) return min + " 分钟前";
                  const hr = Math.floor(min / 60);
                  if (hr < 24) return hr + " 小时前";
                  const day = Math.floor(hr / 24);
                  if (day < 30) return day + " 天前";
                  const dt = new Date(t);
                  return String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
                };
                const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
                const ENGINES = { claude: ["Claude", "claude"], codex: ["Codex", "codex"], trae: ["Trae", "trae"], "qwen-code": ["Qwen Code", "qwen"], codebuddy: ["CodeBuddy", "codebuddy"], zcode: ["ZCode", "zcode"] };
                const engineIcon = (cls) => cls === "claude" ? "chat" : cls === "codex" ? "code" : cls === "trae" ? "sliders" : "server";
                const engineBadge = (engineKey) => {
                  const key = engineKey || "claude";
                  const pair = ENGINES[key] || [key, ""];
                  return '<span class="engine-badge ' + escapeHtml(pair[1]) + '"><svg class="engine-icon" aria-hidden="true"><use href="#icon-' + engineIcon(pair[1]) + '"></use></svg>' + escapeHtml(pair[0]) + "</span>";
                };
                const toast = (() => {
                  // W-PROJP1：node 惰性获取——#toast 节点在本域 script 块之后才入 DOM（:5988），
                  // 初始化时一次性 getElementById 恒为 null，域内 toast 全链哑火（含本批快捷钮容错提示）
                  let node = null;
                  let timer = null;
                  return (message) => {
                    node = node || document.getElementById("toast");
                    if (!node) return;
                    const host = document.querySelector("#stage-mobile.active") ? document.querySelector(".mobile-frame") : document.querySelector(".desktop-frame");
                    if (host && node.parentElement !== host) host.append(node);
                    node.textContent = message;
                    node.classList.add("show");
                    clearTimeout(timer);
                    timer = setTimeout(() => node.classList.remove("show"), 2200);
                  };
                })();

                // ---------- 帧总线订阅 + 共享桥（#d-notify 域脚本消费同一实例） ----------
                // #150 R1：#143 B4-D2 的 window.WebSocket 劫持面退役（分接类/sockets 集合/
                // activeSocket/原生构造捕获全删），桥改订阅地基帧总线取帧（订阅在本段文末），
                // 此处只留桥自身状态。sendCommand 收紧为仅走地基主连接（见下）。
                const subscribers = new Set();
                const ackWaiters = new Map();

                const doneOfNotification = (n) => !!(n && (n.resolved_at || n.handled_at || n.dismissed_at));
                const normalizeNotification = (item) => {
                  if (!item || typeof item !== "object" || typeof item.key !== "string" || !item.key) return null;
                  return {
                    key: item.key,
                    kind: typeof item.kind === "string" ? item.kind : "system",
                    group: item.group === "action" || item.group === "attention" || item.group === "activity" ? item.group : "activity",
                    severity: typeof item.severity === "string" ? item.severity : "info",
                    title: typeof item.title === "string" && item.title ? item.title : (item.kind || "通知"),
                    body: typeof item.body === "string" ? item.body : "",
                    sourceContext: item.sourceContext && typeof item.sourceContext === "object" ? item.sourceContext : {},
                    actionable: item.actionable === true,
                    created_at: Number(item.created_at) || 0,
                    resolved_at: item.resolved_at,
                    handled_at: item.handled_at,
                    dismissed_at: item.dismissed_at,
                  };
                };

                const bridge = {
                  hasSnapshot: false,
                  snapshot: null,
                  sessions: new Map(),
                  notifications: [],
                  notificationsSupported: false,
                  pendingConfirms: [],
                  accepts: [],
                  projects: [],
                  // W-SRCMENU2 ⑥：设计图纸目录（SNAPSHOT.design_docs——W-DESIGNHUB 契约；
                  // 缺键/空数组=旧 relay 或无 docs 部署，图纸 tab 自动隐藏）
                  designDocs: [],
                  designDocsSeen: false,
                  relayName: location.host || "relay",
                  homedir: "",
                  // P0 连接接线：http 页面统一 connecting 起步（无 token 时地基异步探测本机 relay，
                  // 探测全败由 bootstrapConnection 经 markUnconfigured 回落引导文案）
                  connection: location.protocol.startsWith("http") ? "connecting" : "unconfigured",
                  notifyAckUnsupported: false,
                  escapeHtml, relTime, toast, engineBadge, doneOfNotification,
                  waitingText() {
                    // 云形态占位走云链模块文案（未配对引导输码 / 云桥状态），B4 帧路由零改动
                    if (window.__ccDeck005CloudUI && window.__ccDeck005CloudUI.active()) { const t = window.__ccDeck005CloudUI.waitingText(); if (t) return t; }
                    if (this.connection === "unconfigured") return (window.__ccDeck005DesktopForm && window.__ccDeck005DesktopForm()) ? "正在连接本机 relay…（内置服务启动中，连接后自动同步）" : "未配置 · 请通过带 ?token= 的 relay 同源链接打开";
                    if (this.hasSnapshot) return "";
                    if (this.connection === "online") return "已连接 · 等待 relay SNAPSHOT…";
                    if (this.connection === "connecting") return "连接 relay 中…";
                    return "relay 已断开 · 等待地基重连后同步快照";
                  },
                  railJump(domain) {
                    const safe = String(domain || "").replace(/[^a-z-]/g, "");
                    const button = safe && document.querySelector('.rail-btn[data-domain="' + safe + '"]');
                    if (button) button.click();
                  },
                  clickTab(selector, label) {
                    const bar = document.querySelector(selector);
                    if (!bar) return;
                    [...bar.querySelectorAll("button")].find((button) => button.textContent.includes(label))?.click();
                  },
                  selectSessionCard(sessionId) {
                    const sid = String(sessionId || "");
                    if (!sid) return;
                    const card = document.querySelector('#d-session [data-session-card="' + (window.CSS && CSS.escape ? CSS.escape(sid) : sid.replace(/"/g, '\\"')) + '"]');
                    if (card) card.click();
                    else toast("来源会话不在当前列表");
                  },
                  openAcceptance(id) {
                    const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
                    if (!safe) return;
                    // #158-批4a：绝对地址基于 relay 实连信息推导（桌面形态 location 是 tauri.localhost、
                    // 云通道是 cc.humumu.online 代理——相对解析/硬编码端口在这些形态必断链）；
                    // 地基维护 __ccDeck005HttpOrigin()（wsUrl→http origin，推导不出回落 location.origin）
                    const origin = (typeof window.__ccDeck005HttpOrigin === "function" && window.__ccDeck005HttpOrigin()) || location.origin;
                    const url = String(origin).replace(/\/+$/, "") + "/acceptance/" + safe;
                    void window.__ccDeck005OpenUrl(url); // 统一 Promise 化打开链：桌面 openExternal / 浏览器被拦降级复制+toast
                  },
                  bannerOf(text) { return bannerNode(text); },
                  subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
                  // P0 连接接线：探测全败时由地基脚本回调——回落 unconfigured 并广播 connection 事件
                  markUnconfigured() { bridge.connection = "unconfigured"; for (const fn of subscribers) { try { fn("connection"); } catch (_) {} } },
                  sendCommand(type, payload, timeoutMs = 8000) {
                    return new Promise((resolve) => {
                      // #150 R1 收紧（承 #143 盲评A-1 口径）：劫持拆除后无 sockets 借道面，命令只走
                      // 地基主连接（window.__ccDeck005MainWs，readyState===1），ACK 经帧总线回本桥结算；
                      // 无可用连接 resolve(null)——消费域按未送达处理（B4/notify 同口径）；
                      // W-WINPAIR-R7①：带会话的命令按会话源路由（聚合下远程会话走云链）
                      const mainWs = window.__ccDeck005RouteWs ? window.__ccDeck005RouteWs(payload) : window.__ccDeck005MainWs;
                      const socket = mainWs && mainWs.readyState === 1 ? mainWs : null;
                      if (!socket) { resolve(null); return; }
                      const command_id = uuid();
                      const timer = setTimeout(() => { ackWaiters.delete(command_id); resolve(null); }, timeoutMs);
                      ackWaiters.set(command_id, { resolve, timer });
                      try { socket.send(JSON.stringify({ command_id, type, ts: Date.now(), payload })); }
                      catch (_) { clearTimeout(timer); ackWaiters.delete(command_id); resolve(null); }
                    });
                  },
                };
                window.__ccDeck005B4 = bridge;

                function applySnapshot(payload, evSource) {
                  const p = payload && typeof payload === "object" ? payload : {};
                  // T10 修复：快照会话打帧通道标（relay_channel）——RouteWs B4 兜底按真实归属路由，
                  // 不再盲投视角通道（地基 onEvent 只吃 SNAPSHOT、实时帧建的会话两源表恒 miss，
                  // 云视角下错投云 relay → 「会话不存在: <完整id>」——1015 用户实测实锤链）
                  const chan = evSource === "cloud" ? "cloud" : "lan";
                  bridge.sessions = new Map();
                  for (const session of Array.isArray(p.sessions) ? p.sessions : []) {
                    if (session && typeof session.session_id === "string") bridge.sessions.set(session.session_id, { ...session, relay_channel: chan }); // #150 R3：桥持会话浅拷贝，与 B2/地基切断共享别名（R3b P2——桥 merge 以信封 ts 覆写 updated_at 不得越权污染他域）
                  }
                  bridge.notifications = Array.isArray(p.notifications) ? p.notifications.map(normalizeNotification).filter(Boolean) : [];
                  bridge.notificationsSupported = Object.prototype.hasOwnProperty.call(p, "notifications");
                  bridge.pendingConfirms = Array.isArray(p.org_confirms) ? p.org_confirms.filter((c) => c && typeof c.id === "string") : [];
                  bridge.accepts = Array.isArray(p.acceptances) ? p.acceptances.filter((a) => a && typeof a.id === "string") : [];
                  bridge.projects = Array.isArray(p.projects) ? p.projects.filter((g) => g && typeof g.id === "string") : [];
                  // W-SRCMENU2 ⑥：图纸清单（鸭子校验——path 字符串在场才算；缺键维持 []，能力位由 seen 判）
                  const dd = Array.isArray(p.design_docs) ? p.design_docs.filter((d) => d && typeof d.path === "string" && typeof d.title === "string") : null;
                  if (dd) { bridge.designDocs = dd; bridge.designDocsSeen = true; }
                  bridge.relayName = typeof p.relay_name === "string" && p.relay_name ? p.relay_name : (location.host || "relay");
                  bridge.homedir = typeof p.homedir === "string" ? p.homedir : "";
                  bridge.snapshot = p;
                  bridge.hasSnapshot = true;
                  const version = typeof p.schema_version === "number" ? p.schema_version : 0;
                  if (version >= 1) bridge.notifyAckUnsupported = false;
                }

                const SESSION_MERGE_TYPES = new Set(["SESSION_UPDATED", "SESSION_HEARTBEAT", "SESSION_DONE", "SESSION_ERROR", "SESSION_WAITING", "SESSION_WAITING_RESOLVED"]);
                function handleFrame(frame, evSource) {
                  if (!frame || typeof frame.type !== "string") return;
                  if (frame.type === "COMMAND_ACK") {
                    const waiter = ackWaiters.get(frame.command_id);
                    if (waiter) { ackWaiters.delete(frame.command_id); clearTimeout(waiter.timer); waiter.resolve(frame); }
                    return;
                  }
                  let changed = false;
                  if (frame.type === "SNAPSHOT") {
                    // W-WINPAIR-R2：聚合视角 SNAPSHOT 不清场——两源会话并存（另一源的重连快照
                    // 不得把本源会话从聚合视图里抹掉）；W-WINPAIR-R4：org 面（projects/确认卡/
                    // 验收/通知）同口径按 id 并集——通知卡与项目卡聚合可见两源（用户实测空卡修复）
                    if ((window.__ccDeck005SourceView && window.__ccDeck005SourceView()) === "aggregate" && evSource) {
                      const keepSessions = new Map(bridge.sessions);
                      const keepLists = { projects: bridge.projects.slice(), pendingConfirms: bridge.pendingConfirms.slice(), accepts: bridge.accepts.slice(), notifications: bridge.notifications.slice(), designDocs: bridge.designDocs.slice() };
                      applySnapshot(frame.payload, evSource);
                      for (const [id, v] of keepSessions) if (!bridge.sessions.has(id)) bridge.sessions.set(id, v);
                      const byId = (keep, cur, idOf) => { const seen = new Set(cur.map((x) => x && idOf(x))); for (const x of keep) { const k = x && idOf(x); if (k !== undefined && k !== null && !seen.has(k)) { cur.push(x); seen.add(k); } } };
                      byId(keepLists.projects, bridge.projects, (x) => x.id);
                      byId(keepLists.pendingConfirms, bridge.pendingConfirms, (x) => x.id);
                      byId(keepLists.accepts, bridge.accepts, (x) => x.id);
                      byId(keepLists.notifications, bridge.notifications, (x) => x.key); // 通知归一化后判重键=key
                      byId(keepLists.designDocs, bridge.designDocs, (x) => x.path); // W-SRCMENU2 ⑥：图纸按 path 去重并集（聚合两源）
                    } else applySnapshot(frame.payload, evSource);
                    changed = true;
                  }
                  else if (frame.type === "COLLAB_MODE_UPDATED") {
                    // W-MODE：切换帧合并进快照缓存（设置域开关回显数据源；bridge.sessions
                    // 同步增删防锚卡残留——通知域跳转/selectSessionCard 消费桥缓存）
                    const cm = frame.payload || {};
                    const mode = cm.mode === "no-leader" ? "no-leader" : "leader";
                    if (bridge.snapshot && typeof bridge.snapshot === "object") bridge.snapshot.collab_mode = mode;
                    if (mode === "no-leader" && typeof cm.leader_session_id === "string") bridge.sessions.delete(cm.leader_session_id);
                    else if (mode === "leader" && cm.leader_session && typeof cm.leader_session.session_id === "string") bridge.sessions.set(cm.leader_session.session_id, { ...cm.leader_session });
                    changed = true;
                  }
                  else if (frame.type === "NOTIFICATIONS_UPDATED") {
                    const items = frame.payload && Array.isArray(frame.payload.items) ? frame.payload.items : [];
                    const next = items.map(normalizeNotification).filter(Boolean);
                    // W-WINPAIR-R4：聚合视角通知按 key 并集（全量形态不清另一源——通知卡聚合两源；归一化判重键=key）
                    if ((window.__ccDeck005SourceView && window.__ccDeck005SourceView()) === "aggregate" && evSource) {
                      const seen = new Set(next.map((n) => n && n.key));
                      for (const n of bridge.notifications) if (n && n.key && !seen.has(n.key)) { next.push(n); seen.add(n.key); }
                    }
                    bridge.notifications = next;
                    bridge.notificationsSupported = true;
                    changed = true;
                  } else if (frame.type === "ORG_CONFIRM_UPDATED") {
                    const pending = frame.payload && Array.isArray(frame.payload.pending) ? frame.payload.pending.filter((c) => c && typeof c.id === "string") : [];
                    // W-WINPAIR-R4：聚合视角确认卡同 id 并集
                    if ((window.__ccDeck005SourceView && window.__ccDeck005SourceView()) === "aggregate" && evSource) {
                      const seen = new Set(pending.map((c) => c.id));
                      for (const c of bridge.pendingConfirms) if (c && c.id !== undefined && !seen.has(c.id)) pending.push(c);
                    }
                    bridge.pendingConfirms = pending;
                    changed = true;
                  } else if (frame.type === "ACCEPTANCES_UPDATED") {
                    bridge.accepts = frame.payload && Array.isArray(frame.payload.acceptances) ? frame.payload.acceptances.filter((a) => a && typeof a.id === "string") : [];
                    changed = true;
                  } else if (frame.type === "AUTH_REQUIRED") {
                    // #102 批 B：登录流程帧 → 引导卡（二维码/浏览器引导/转绿收卡）
                    if (window.__ccDeck005LoginCard) window.__ccDeck005LoginCard.onFlow(frame.payload);
                    changed = true;
                  } else if (frame.type === "PROJECTS_UPDATED") {
                    bridge.projects = frame.payload && Array.isArray(frame.payload.groups) ? frame.payload.groups.filter((g) => g && typeof g.id === "string") : [];
                    changed = true;
                  } else if (frame.type === "SESSION_DELETED") {
                    if (typeof frame.session_id === "string" && bridge.sessions.delete(frame.session_id)) changed = true;
                  } else if (frame.type === "SESSION_CREATED") {
                    if (typeof frame.session_id === "string" && !bridge.sessions.has(frame.session_id) && frame.payload && typeof frame.payload === "object") {
                      // T10 修复：实时帧建卡打帧通道标（relay_channel）——RouteWs B4 兜底按真实
                      // 归属路由的锚（无此标时新会话在两源表恒 miss，兜底盲投视角通道错投云）
                      bridge.sessions.set(frame.session_id, { ...frame.payload, session_id: frame.session_id, started_at: frame.ts, updated_at: frame.ts, status: frame.payload.status || "WORKING", relay_channel: evSource === "cloud" ? "cloud" : "lan" });
                      changed = true;
                    }
                  } else if (SESSION_MERGE_TYPES.has(frame.type)) {
                    const session = typeof frame.session_id === "string" ? bridge.sessions.get(frame.session_id) : null;
                    if (session && frame.payload && typeof frame.payload === "object") {
                      Object.assign(session, frame.payload, { session_id: frame.session_id, updated_at: frame.ts || session.updated_at });
                      changed = true;
                    }
                  }
                  if (changed) for (const fn of subscribers) { try { fn(frame.type); } catch (_) {} }
                }

                // #150 R1：window.WebSocket 分接劫持退役，桥订阅地基帧总线——地基 connectLan 持唯一主
                // 连接，onmessage 已 parse，总线直传帧对象（本桥不再 JSON.parse）；ws 事件维持
                // connection 状态机（open→online / close→offline）并照旧 fan-out 订阅者。
                window.__ccDeck005Frames.subscribe((ev) => {
                  if (!ev || typeof ev !== "object") return;
                  if (ev.kind === "ws") {
                    bridge.connection = ev.state === "open" ? "online" : ev.state === "connecting" ? "connecting" : "offline"; // #150 R2：补 connecting 三态（R1 遗留修正——重连窗口曾显未连接）
                    for (const fn of subscribers) { try { fn("connection"); } catch (_) {} }
                    return;
                  }
                  if (ev.kind === "frame" && window.__ccDeck005FrameAllowed(ev)) handleFrame(ev.frame, ev.source); // W-WINPAIR-R2：按视角门控（aggregate 放行全部+merge）
                });

                // ---------- #102 批 B 引擎登录引导卡（把饭喂到嘴里——用户 1014 定调） ----------
                // AUTH_REQUIRED 瞬态事件驱动：relay 登录 pane 提取到授权 URL 即渲染二维码，
                // 扫码/点链接完成登录，「我已完成登录」触发 relay 直探（结果走事件回推）。
                // 覆盖三入口：创建拦截 ACK（needs_auth）/引擎菜单与设置区「立即登录」/
                // 事件直推（同 relay 其他端发起也能看到）。QR 渲染复用 FB3 配对同款
                // qr.js（QRCode 类 + canvas），不引外链。
                window.__ccDeck005LoginCard = (() => {
                  const ENGINE_NAME = { claude: "Claude", codex: "Codex", trae: "Trae", "qwen-code": "Qwen", codebuddy: "CodeBuddy", zcode: "ZCode" };
                  const oneLineLc = (t) => { const v = String(t ?? "").replace(/\s+/g, " ").trim(); return v.length > 120 ? v.slice(0, 120) + "…" : v; };
                  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
                  let flow = null;      // 当前流程（AUTH_REQUIRED payload 形状）
                  let verifying = false;
                  let card = null;
                  const ensureCard = () => {
                    if (card) return card;
                    card = document.createElement("div");
                    card.className = "englogin-card";
                    card.addEventListener("click", (ev) => {
                      const b = ev.target.closest("button[data-elc-act]");
                      if (!b) return;
                      const act = b.dataset.elcAct;
                      if (act === "verify" && flow) { verifying = true; render(); void bridge.sendCommand("COMMAND_ENGINE_LOGIN", { engine: flow.engine, action: "verify" }); }
                      else if (act === "cancel" && flow) { void bridge.sendCommand("COMMAND_ENGINE_LOGIN", { engine: flow.engine, action: "cancel" }).then(() => hide()); }
                      else if (act === "retry" && flow) { verifying = false; onFlow({ ...flow, state: "starting", url: undefined }); void bridge.sendCommand("COMMAND_ENGINE_LOGIN", { engine: flow.engine, action: "start" }); }
                      else if (act === "close") hide();
                    });
                    document.body.appendChild(card);
                    return card;
                  };
                  const hide = () => { flow = null; verifying = false; if (card) card.remove(); card = null; };
                  // state=ready → 本地 catalog patch（引擎目录黄点转绿无需重连；下次 SNAPSHOT 归真）
                  const patchCatalog = (engine) => {
                    const snap = bridge.snapshot;
                    const cat = snap && snap.source_capabilities && Array.isArray(snap.source_capabilities.engine_catalog) ? snap.source_capabilities.engine_catalog : null;
                    if (!cat) return;
                    const hit = cat.find((e) => e && e.id === engine);
                    if (hit && hit.state !== "ready") { hit.state = "ready"; if ("auth_hint" in hit) delete hit.auth_hint; for (const fn of subscribers) { try { fn("AUTH_REQUIRED"); } catch (_) {} } }
                  };
                  function drawQr(canvas, text) {
                    try {
                      const q = new QRCode(0, QRErrorCorrectLevel.M);
                      q.addData(text);
                      q.make();
                      const n = q.getModuleCount(), pad = 2, scale = 4;
                      canvas.width = canvas.height = (n + pad * 2) * scale;
                      const g = canvas.getContext("2d");
                      if (!g) return false;
                      g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height);
                      g.fillStyle = "#10151C";
                      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + pad) * scale, (r + pad) * scale, scale, scale);
                      return true;
                    } catch (_) { return false; }
                  }
                  function render() {
                    if (!flow) return hide();
                    const el = ensureCard();
                    const name = ENGINE_NAME[flow.engine] || flow.engine;
                    const stateText = flow.state === "ready" ? "已登录" : flow.state === "starting" ? "拉起登录面板…" : flow.state === "timeout" ? "等待超时" : flow.state === "error" ? "拉起失败" : flow.state === "cancelled" ? "已取消" : verifying ? "验证中…" : "等待登录";
                    el.classList.toggle("ready", flow.state === "ready");
                    let html = '<div class="elc-head"><span class="elc-title">🔑 ' + esc(name) + ' 登录</span><span class="elc-state">' + esc(stateText) + "</span></div>";
                    if (flow.state === "ready") {
                      html += '<p class="elc-note">' + esc(name) + " 已登录，引擎目录已点亮，现在可以用它创建会话了。</p>";
                      html += '<div class="elc-actions"><button class="primary" data-elc-act="close">好</button></div>';
                    } else if (flow.state === "timeout" || flow.state === "error" || flow.state === "cancelled") {
                      html += '<p class="elc-note">' + esc(oneLineLc(flow.hint || "登录未完成")) + "</p>";
                      html += '<div class="elc-actions"><button class="primary" data-elc-act="retry">重新发起</button><button data-elc-act="close">关闭</button></div>';
                    } else {
                      // starting/pending：QR 卡（mode=qr 有 url）→ 二维码字符画 → 浏览器卡 → hint 卡
                      if (flow.mode === "qr" && flow.url) {
                        html += '<div class="elc-qrwrap"><canvas class="elc-qr" role="img" aria-label="登录二维码"></canvas></div>';
                        html += '<a class="elc-link" href="' + esc(flow.url) + '" target="_blank" rel="noopener">或点此在浏览器打开授权页</a>';
                      } else if (flow.mode === "qr" && flow.qr_text) {
                        html += '<pre class="elc-art">' + esc(flow.qr_text) + "</pre>";
                        if (flow.url) html += '<a class="elc-link" href="' + esc(flow.url) + '" target="_blank" rel="noopener">或点此在浏览器打开授权页</a>';
                      } else if (flow.mode === "browser") {
                        html += '<p class="elc-note">已在这台电脑上为你打开浏览器完成授权；手机端看到本卡时，请回到这台电脑前完成。</p>';
                        if (flow.url) html += '<a class="elc-link" href="' + esc(flow.url) + '" target="_blank" rel="noopener">浏览器没打开？点此手动打开授权页</a>';
                      } else {
                        html += '<p class="elc-note">' + esc(oneLineLc(flow.hint || "请完成引擎登录")) + "</p>";
                      }
                      const busy = flow.state === "starting" || verifying;
                      html += '<div class="elc-actions"><button class="primary" data-elc-act="verify"' + (busy ? " disabled" : "") + '>我已完成登录</button><button data-elc-act="cancel"' + (busy ? " disabled" : "") + ">取消</button></div>";
                    }
                    el.innerHTML = html;
                    const cv = el.querySelector("canvas.elc-qr");
                    if (cv && flow.url) drawQr(cv, flow.url);
                  }
                  function onFlow(payload) {
                    if (!payload || typeof payload !== "object" || typeof payload.engine !== "string") return;
                    flow = payload;
                    if (payload.state !== "pending" && payload.state !== "starting") verifying = false;
                    render();
                    if (payload.state === "ready") {
                      patchCatalog(payload.engine);
                      setTimeout(() => { if (flow && flow.state === "ready") hide(); }, 2200);
                    }
                  }
                  return {
                    onFlow,
                    // 手动入口（设置区/创建弹窗/ACK 拦截）：幂等 start——relay 侧活流程复用，
                    // ACK data 即流程投影直接渲染（事件后至增量更新 url）
                    open(engine) {
                      if (typeof engine !== "string" || engine === "claude") return;
                      verifying = false;
                      void bridge.sendCommand("COMMAND_ENGINE_LOGIN", { engine, action: "start" }).then((ack) => {
                        if (ack && ack.ok && ack.data && typeof ack.data === "object" && ack.data.engine) onFlow(ack.data);
                      });
                    },
                  };
                })();

                // ---------- 项目域聚合与渲染 ----------
                const els = {
                  queue: section.querySelector("[data-project-queue]"),
                  name: section.querySelector("[data-project-name]"),
                  source: section.querySelector("[data-project-source]"),
                  body: section.querySelector("[data-project-body]"),
                  riskCount: section.querySelector("[data-project-risk-count]"),
                  riskCopy: section.querySelector("[data-project-risk-copy]"),
                  artifactCount: section.querySelector("[data-project-artifact-count]"),
                  artifactRows: section.querySelector("[data-project-artifact-rows]"),
                  waterline: section.querySelector("[data-project-waterline]"),
                };
                let selectedKey = "";

                // W-PROJP1 P1-2：「未立项」置底折叠组——纯端上视图态不上 relay（同键位自定义的存储层级），
                // localStorage 记忆折叠态；键 null/缺省=折叠（默认），"0"=展开（B11 collapsedGroups 同思路单键化）
                const PROJECT_UNFILED_KEY = "cc-deck-005-project-unfiled-collapsed";
                let unfiledCollapsed = (() => { try { return localStorage.getItem(PROJECT_UNFILED_KEY) !== "0"; } catch (_) { return true; } })();

                // #158-批4a：目录归一比较兼容 \ 分隔（Windows 数据 \ 与拼 / 不匹配会让项目前缀
                // 归组/子目录匹配失效）；展示输出统一 displayPath（桌面 Windows 形态反斜杠）
                const displayPath = window.__ccDeck005PathUi.displayPath;
                const normDir = (dir) => String(dir || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
                const underAnchor = (cwd, anchor) => { const c = normDir(cwd), a = normDir(anchor); return !!a && (c === a || c.startsWith(a + "/")); };
                const shortenDir = (dir) => {
                  const d = normDir(dir), h = normDir(bridge.homedir);
                  if (h && (d === h || d.startsWith(h + "/"))) return "~" + displayPath(d.slice(h.length));
                  return displayPath(d) || "/";
                };
                const basename = (path) => window.__ccDeck005PathUi.baseName(path);
                const STATUS_WORD = { WORKING: "运行中", WAITING: "待处理", ERROR: "错误", DONE: "完成" };
                const STATUS_DOT = { WORKING: "working", WAITING: "waiting", ERROR: "error", DONE: "done" };
                const STATUS_TAG = { WORKING: "info", WAITING: "action", ERROR: "danger", DONE: "done" };

                function deriveEntries() {
                  const sessions = [...bridge.sessions.values()].filter((s) => s && typeof s.session_id === "string" && typeof s.cwd === "string");
                  const entries = bridge.projects.map((group) => ({ key: "g:" + group.id, group, name: String(group.name || group.id), anchor: String(group.anchor_dir || ""), sessions: sessions.filter((s) => underAnchor(s.cwd, group.anchor_dir)) }));
                  const matched = new Set(sessions.filter((s) => entries.some((e) => underAnchor(s.cwd, e.anchor))).map((s) => s.session_id));
                  // W-PROJP1 P1-2：未立项分桶保留首个会话原始 cwd（nativeCwd）。路径三口径（设计 §0.5/1.4/附录 2）：
                  // dir(normDir 产物)=分桶 key 与比较口径；entry.anchor 沿用 dir 供展示/前缀逻辑；
                  // nativeCwd=壳桥调用口径——openPath/probePath 吃原生形态（Windows 反斜杠），不 display 化不归一化
                  const byCwd = new Map();
                  for (const session of sessions) {
                    if (matched.has(session.session_id)) continue;
                    const dir = normDir(session.cwd) || "/";
                    if (!byCwd.has(dir)) byCwd.set(dir, { list: [], nativeCwd: String(session.cwd || "") });
                    byCwd.get(dir).list.push(session);
                  }
                  for (const [dir, bucket] of byCwd) entries.push({ key: "c:" + dir, group: null, name: basename(dir) || dir, anchor: dir, nativeCwd: bucket.nativeCwd, sessions: bucket.list });
                  const latest = (entry) => Math.max(0, ...entry.sessions.map((s) => Number(s.updated_at) || 0));
                  return entries.sort((a, b) => latest(b) - latest(a) || (Number(b.group?.updated_at) || 0) - (Number(a.group?.updated_at) || 0));
                }

                function projectActionItems(entry) {
                  const items = [];
                  if (!entry) return items;
                  const sids = new Set(entry.sessions.map((s) => s.session_id));
                  for (const n of bridge.notifications) {
                    if (doneOfNotification(n) || n.actionable !== true) continue;
                    if (n.sourceContext && sids.has(n.sourceContext.sessionId)) items.push(n.title || n.kind);
                  }
                  if (entry.group) {
                    for (const confirm of bridge.pendingConfirms) {
                      if (!confirm.payload || confirm.payload.gid !== entry.group.id) continue;
                      const covered = bridge.notifications.some((n) => n.kind === "org-confirm" && !doneOfNotification(n) && n.sourceContext && n.sourceContext.entityId === confirm.id);
                      if (!covered) items.push(confirm.title || "组织确认单");
                    }
                  }
                  return items;
                }

                function artifactsOf(entry) {
                  if (!entry) return [];
                  const seen = new Map();
                  const ordered = [...entry.sessions].sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));
                  for (const session of ordered) {
                    for (const artifact of Array.isArray(session.artifacts) ? session.artifacts : []) {
                      if (!artifact || typeof artifact.path !== "string" || artifact.exists === false) continue;
                      if (!seen.has(artifact.path)) seen.set(artifact.path, { path: artifact.path, last_at: Number(artifact.last_at) || Number(artifact.first_at) || 0, session });
                    }
                  }
                  return [...seen.values()].sort((a, b) => b.last_at - a.last_at);
                }

                function bannerNode(text) {
                  const node = document.createElement("div");
                  node.className = "readonly-banner";
                  node.setAttribute("role", "status");
                  node.textContent = text;
                  return node;
                }
                function nodesFrom(markup) {
                  const template = document.createElement("template");
                  template.innerHTML = markup;
                  return template.content;
                }

                // #282 三批 N2（清单 §2.4）：项目域队列/长页/检查器签名跳帧——帧驱动 replaceChildren
                // 整树重建收口（队列折叠态/长页滚动位逐帧存活）；等待分支清签防陈旧跳帧（P1-2 同型防线）
                const bSigOf = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return "b" + (h >>> 0).toString(36); };
                function renderQueue(entries) {
                  // W-PROJP1 P1-2：未立项（group:null）从活跃项目拆出置底折叠组（设计 §3 方案 a），
                  // 组序：活跃项目 → 待确认立项 → 挂起/归档 → 未立项。降噪靠折叠不靠过滤，所有卡始终可回。
                  const activeList = entries.filter((e) => e.group && e.group.status === "active");
                  const pendingList = entries.filter((e) => e.group && e.group.status === "pending");
                  const parkedList = entries.filter((e) => e.group && (e.group.status === "parked" || e.group.status === "archived"));
                  const unfiledList = entries.filter((e) => !e.group);
                  const card = (entry) => {
                    const hot = entry.sessions.some((s) => s.status === "WAITING" || s.status === "ERROR");
                    const dot = entry.sessions.length === 0 ? "" : hot ? "waiting" : "done";
                    const actions = projectActionItems(entry).length;
                    // FB8 三行制（#248 收敛：行3 引擎徽章/行2 源胶囊退役——拥挤重叠根源，仅留进行中徽章）
                    const working = entry.sessions.filter((s) => s.status === "WORKING").length;
                    // W-PROJP1 P1-1：快捷链接（reveal 定位高亮）。openPath/probePath 吃原生路径（#158-批4a 口径）：
                    // 组卡 anchor 即 anchor_dir 原值；未立项卡 anchor 是 normDir 产物（分桶 key），必须取分桶保留的
                    // nativeCwd（设计 §1.4/附录 2 坑）。显隐沿 :3684 惯例——恒渲染按钮、无壳桥或无原生路径时
                    // display:none（浏览器端不动作），title 悬浮展示全路径（displayPath 原生形态）。
                    // svg 内联（同产物域 svgUse 输出形态）——本项目域 script 块与产物域不共顶层作用域，
                    // 借 svgUse 会 ReferenceError 且被订阅循环 try/catch 吞掉（render 整链静默死，实测踩坑）
                    const nativePath = entry.group ? String(entry.anchor || "") : String(entry.nativeCwd || "");
                    const shellOpen = !!(window.ccDeck && typeof window.ccDeck.openPath === "function");
                    const openBtn = '<button class="project-open-btn" type="button" data-project-open="' + escapeHtml(nativePath) + '" aria-label="在文件夹中定位" title="在文件夹中定位 · ' + escapeHtml(displayPath(nativePath)) + '"' + (nativePath && shellOpen ? "" : ' style="display:none"') + '><svg class="icon-inline" aria-hidden="true"><use href="#icon-folder"></use></svg></button>';
                    return '<div class="queue-card' + (entry.key === selectedKey ? " selected" : "") + '" data-project-key="' + escapeHtml(entry.key) + '" title="' + escapeHtml(shortenDir(entry.anchor)) + '"><div class="row"><i class="status-dot ' + dot + '"></i><strong>' + escapeHtml(entry.name) + "</strong>" + (actions > 0 ? '<span class="tag action">需行动 ' + actions + "</span>" : "") + '</div><p class="project-card-sub"><span class="project-card-path">' + escapeHtml(shortenDir(entry.anchor)) + " · " + entry.sessions.length + " 会话" + (entry.group ? " · 1 团队" : " · 未入项目") + "</span>" + openBtn + "</p>"
                      + (working ? '<div class="identity-cluster"><span class="source-badge">进行中 ' + working + "</span></div>" : "") + "</div>";
                  };
                  const group = (label, list) => list.length ? '<div class="queue-group">' + escapeHtml(label) + " · " + list.length + "</div>" + list.map(card).join("") : "";
                  // 未立项组头：折叠箭头 + 「未立项 · N」（贴卡副行既有徽标词汇，D2-2）+ hot 点——
                  // 折叠态下组内有 WAITING/ERROR 时亮「抽屉里有要处理的」，不强行展开（卡状态点同词汇）
                  const unfiledHot = unfiledList.some((entry) => entry.sessions.some((s) => s.status === "WAITING" || s.status === "ERROR"));
                  const unfiledMarkup = unfiledList.length
                    ? '<button class="queue-group project-unfiled-toggle" type="button" data-project-unfiled-toggle aria-expanded="' + (!unfiledCollapsed) + '"><span class="unfiled-chev">▸</span>未入项目 · ' + unfiledList.length + (unfiledCollapsed && unfiledHot ? '<i class="status-dot waiting"></i>' : "") + "</button>"
                      + (unfiledCollapsed ? "" : unfiledList.map(card).join(""))
                    : "";
                  const markup = group("活跃项目", activeList) + group("待确认新建项目", pendingList) + group("挂起/归档", parkedList) + unfiledMarkup;
                  const qSig = "q:" + bSigOf(markup); // #282 三批 N2：未变帧零重建（折叠态/hover 存活）
                  if (els.queue.dataset.b2qSig !== qSig || !els.queue.childElementCount) {
                    els.queue.dataset.b2qSig = qSig;
                    els.queue.replaceChildren(nodesFrom(markup));
                  }
                }

                function renderHead(entry) {
                  els.name.textContent = entry ? entry.name : "项目";
                  els.source.textContent = window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(bridge.relayName) : bridge.relayName; // 件十三：命名映射统一
                  // W-PROJIA 案C（v8 dhead 语言）：live 徽标 + meta 行——替代四大卡与两条蓝条
                  const liveNode = section.querySelector("[data-project-live]");
                  const metaNode = section.querySelector("[data-project-meta]");
                  if (entry) {
                    const hot = projectActionItems(entry).length;
                    const artifacts = artifactsOf(entry);
                    if (liveNode) {
                      liveNode.hidden = false;
                      liveNode.textContent = "● " + entry.sessions.length + " 会话 · " + (entry.group ? 1 : 0) + " 团队" + (hot ? " · " + hot + " 需行动" : "");
                    }
                    if (metaNode) {
                      const open = bridge.accepts.filter((a) => !a.submitted).length;
                      metaNode.hidden = false;
                      metaNode.innerHTML = '<span>只读聚合 · 目录 ' + escapeHtml(shortenDir(entry.anchor)) + '</span><span class="sep">·</span>'
                        + "<span>输出物 " + artifacts.length + "</span>" + '<span class="sep">·</span>'
                        + "<span>验收单 " + bridge.accepts.length + (open ? " · " + open + " 张未闭环" : "") + "（全局登记）</span>";
                    }
                    window.__ccDeck005SetWindowbarHint?.("project", "目录 " + shortenDir(entry.anchor) + " · realpath 已归一"); // ⑥a-5 终态：追加计数已收口进头部 meta 行
                  } else {
                    if (liveNode) liveNode.hidden = true;
                    if (metaNode) metaNode.hidden = true;
                    window.__ccDeck005SetWindowbarHint?.("project", "—");
                  }
                }

                // W-PROJIA 案C（2026-10-13 用户定版：v8 原型为桌面 UI 美学基准，
                // docs/mockups/v8-ui-interactive-v2.html「V8 项目域局部」）：主区 = v8 的
                // psec 分区 + vrow 代表条目语言——每分区默认 3 条代表，超量出「全部 N 条 ▾」
                // 就地展开（不跳页、不丢上下文）；条目点击跳来源域（v8 语义：项目域=只读
                // 观测面板，编辑回源域）。头部 live 徽标 + meta 行替代四大卡与两条蓝条（见
                // renderHead）；任务分区退役（原 tab 内容本就是「去团队域」跳转占位——正是
                // 用户判定重叠的复制品）；图纸分区能力位判 designDocsSeen。案A/案B 的
                // overviewMarkup 与六个 *TabMarkup 机制整体退役。
                const PSEC_TAKE = 3;
                const expandedSections = new Set(); // 分区展开态（域内会话态，切项目/刷新回落默认收起）
                const VROW_K = { WORKING: ["运行中", " run"], WAITING: ["待处理", " wait"], ERROR: ["错误", " err"], DONE: ["完成", ""] };
                const vrow = (attrs, title, sub, kText, kCls) =>
                  '<div class="vrow"' + (attrs ? " " + attrs : "") + '><div class="t"><b>' + escapeHtml(title) + "</b>" + (sub ? '<span class="s">' + escapeHtml(sub) + "</span>" : "") + '</div>' + (kText ? '<span class="k' + (kCls || "") + '">' + escapeHtml(kText) + "</span>" : "") + "</div>";
                function psecMarkup(id, icon, name, rows, emptyText, emptyAttrs) {
                  const expanded = expandedSections.has(id);
                  const shown = expanded ? rows : rows.slice(0, PSEC_TAKE);
                  const toggle = rows.length > PSEC_TAKE
                    ? '<button class="jump" type="button" data-psec-toggle="' + id + '">' + (expanded ? "收起 ▴" : "全部 " + rows.length + " 条 ▾") + "</button>"
                    : "";
                  const body = rows.length
                    ? shown.join("")
                    : '<div class="vrow" style="cursor:default"' + (emptyAttrs ? " " + emptyAttrs : "") + '><div class="t"><b style="color:var(--faint)">' + escapeHtml(emptyText) + "</b></div></div>";
                  return '<section class="proj-section psec" id="proj-sec-' + id + '" data-proj-section="' + id + '">'
                    + '<h5><svg class="icon-inline" aria-hidden="true"><use href="#icon-' + icon + '"></use></svg>' + escapeHtml(name) + ' <span class="cnt">' + rows.length + "</span>" + toggle + "</h5>"
                    + body + "</section>";
                }
                function sessionsRows(entry) {
                  const sessions = [...entry.sessions].sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));
                  return sessions.map((s) => {
                    const ctx = Number(s.context_limit) > 0 ? " · 上下文 " + Math.max(1, Math.min(999, Math.round((Number(s.context_usage) / Number(s.context_limit)) * 100))) + "%" : "";
                    const k = VROW_K[s.status] || ["完成", ""];
                    return vrow('data-domain-jump="session" data-jump-session="' + escapeHtml(s.session_id) + '" title="在会话域打开"', s.title || s.initial_prompt || s.session_id, relTime(s.updated_at) + ctx, k[0], k[1]);
                  });
                }
                function teamRows(entry) {
                  if (!entry.group) return [];
                  const g = entry.group;
                  const headcount = Array.isArray(g.headcount) ? g.headcount : [];
                  return headcount.map((m) => {
                    const sid = m && typeof m.session_id === "string" ? m.session_id : "";
                    const s = sid ? bridge.sessions.get(sid) : null;
                    const title = s ? (s.title || s.initial_prompt || sid) : sid || "空席位";
                    const sub = (m && m.role ? m.role : "角色未标注") + (m && m.model ? " · " + m.model : "");
                    const k = s ? (VROW_K[s.status] || ["完成", ""]) : ["离线", " wait"];
                    return vrow((sid ? 'data-domain-jump="session" data-jump-session="' + escapeHtml(sid) + '" title="在会话域打开该成员"' : 'style="cursor:default"'), title, sub, k[0], k[1]);
                  });
                }
                function artifactsRows(entry) {
                  const anchor = normDir(entry.anchor);
                  return artifactsOf(entry).map((a) => {
                    const pN = normDir(a.path);
                    const rel = pN !== anchor && pN.startsWith(anchor + "/") ? displayPath(pN.slice(anchor.length + 1)) : basename(a.path);
                    const eng = ENGINES[a.session && a.session.engine] ? ENGINES[a.session.engine][0] : "";
                    return vrow('data-domain-jump="session" data-jump-session="' + escapeHtml(a.session.session_id) + '" title="查看来源会话"', rel, relTime(a.last_at), eng, "");
                  });
                }
                function acceptsRows() {
                  return bridge.accepts.map((a) =>
                    vrow('data-open-acceptance="' + escapeHtml(a.id) + '" title="打开验收表单页"', a.title, "已回填 " + (Number(a.judged) || 0) + "/" + (Number(a.total) || 0) + " · " + relTime(a.created_at), a.submitted ? "已提交" : "待填", a.submitted ? "" : " wait"));
                }
                function designRows() {
                  return bridge.designDocs.map((d) =>
                    vrow('data-design-open="' + escapeHtml(d.path) + '" title="新窗打开"', d.title, (Array.isArray(d.tags) && d.tags.length ? d.tags.slice(0, 4).map((t) => "#" + t).join(" ") : ""), d.group, ""));
                }

                function renderInspector(entry) {
                  const actions = projectActionItems(entry);
                  if (actions.length) {
                    els.riskCount.style.display = "";
                    els.riskCount.textContent = "需行动 " + actions.length;
                    els.riskCopy.innerHTML = actions.slice(0, 3).map((line) => escapeHtml(line)).join("<br>");
                  } else {
                    els.riskCount.style.display = "none";
                    els.riskCopy.textContent = entry ? "无待行动项" : "—";
                  }
                  const artifacts = artifactsOf(entry);
                  els.artifactCount.textContent = String(artifacts.length);
                  const artRowsHtml = artifacts.slice(0, 4).map((a) => '<div class="artifact-row">' + escapeHtml(basename(a.path)) + "<span>" + escapeHtml(relTime(a.last_at)) + "</span></div>").join("");
                  const arSig = "ar:" + bSigOf(artRowsHtml); // #282 三批 N2：未变帧零重建（relTime 分钟粒度翻转才重建）
                  if (els.artifactRows.dataset.b2arSig !== arSig || !els.artifactRows.childElementCount) {
                    els.artifactRows.dataset.b2arSig = arSig;
                    els.artifactRows.innerHTML = artRowsHtml;
                  }
                  // ⑥a-4 最活跃会话水位块：项目内 context 用量占比最高会话（原型 data-context-waterline 终态）
                  if (els.waterline) {
                    const withCtx = (entry ? entry.sessions : []).filter((s) => Number(s && s.context_usage) > 0 && Number(s && s.context_limit) > 0);
                    const busiest = withCtx.sort((a, b) => Number(b.context_usage) / Number(b.context_limit) - Number(a.context_usage) / Number(a.context_limit))[0];
                    if (busiest) {
                      const pct = Math.max(1, Math.min(100, Math.round((Number(busiest.context_usage) / Number(busiest.context_limit)) * 100)));
                      els.waterline.hidden = false;
                      const wlHtml = '<div class="inspector-title"><span>最活跃会话水位</span><span>' + pct + "%</span></div>"
                        + '<div class="mini-context-meter"><i><b style="width:' + pct + '%"></b></i><span>聚合水位</span></div>'
                        + '<div class="inspector-copy">' + escapeHtml(busiest.title || busiest.initial_prompt || busiest.session_id) + " · 当前会话上下文</div>";
                      const wlSig = "wl:" + bSigOf(wlHtml); // #282 三批 N2：未变帧零重建
                      if (els.waterline.dataset.b2wlSig !== wlSig || !els.waterline.childElementCount) {
                        els.waterline.dataset.b2wlSig = wlSig;
                        els.waterline.innerHTML = wlHtml;
                      }
                    } else {
                      els.waterline.hidden = true;
                      els.waterline.textContent = "";
                    }
                  }
                }

                // W-PROJIA 案B：tab 栏移除后地基 setupStubTabs 不再为项目域建 pane——
                // workspace-body 退化为单一长页容器：总览摘要区 + 六分区（分区头带锚点，
                // 四卡点击 scrollIntoView 平滑滚动定位）。bodyPanes/setPaneContents 的
                // 多 pane 分发机制退役，统一走 renderLongPage。
                function renderLongPage(entry) {
                  if (!els.body) return;
                  // W-PROJIA 案C：v8 psec 分区长页（四区 + 图纸能力区）；任务分区退役（原 tab
                  // 内容即「去团队域」跳转占位，属用户判定的复制品）；头部摘要见 renderHead
                  let html = psecMarkup("sessions", "chat", "会话", sessionsRows(entry), "该项目目录暂无会话，新会话由会话域发起。");
                  html += psecMarkup("team", "users", "团队", teamRows(entry), entry.group ? "编制为空，成员在团队域维护。" : "该目录未入项目，新建项目确认在团队域发起。");
                  html += psecMarkup("artifacts", "package", "输出物", artifactsRows(entry), "暂无输出物登记，输出物由会话域实时产生。");
                  html += psecMarkup("accepts", "check", "验收单", acceptsRows(), "暂无验收单登记。");
                  if (bridge.designDocsSeen && bridge.designDocs.length > 0) html += psecMarkup("design", "layers", "图纸", designRows(), "图纸目录为空。");
                  const lSig = "lp:" + bSigOf(html); // #282 三批 N2：未变帧零重建（长页滚动位存活）
                  if (els.body.dataset.b2lSig !== lSig || !els.body.childElementCount) {
                    els.body.dataset.b2lSig = lSig;
                    els.body.replaceChildren(nodesFrom(html));
                  }
                }

                function render() {
                  const waiting = bridge.waitingText();
                  els.queue.dataset.relayState = bridge.hasSnapshot ? "snapshot" : bridge.connection;
                  if (waiting) {
                    els.queue.dataset.b2qSig = ""; // #282 三批 N2：降级分支清签（回数据态不误跳帧）
                    if (els.body) els.body.dataset.b2lSig = "";
                    els.queue.replaceChildren(bannerNode(waiting));
                    els.name.textContent = "项目";
                    els.source.textContent = window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(bridge.relayName) : bridge.relayName; // 件十三：命名映射统一
                    window.__ccDeck005SetWindowbarHint?.("project", waiting);
                    if (els.body) els.body.replaceChildren(nodesFrom('<div class="readonly-banner" role="status">' + escapeHtml(waiting) + "</div>"));
                    els.riskCount.style.display = "none";
                    els.riskCopy.textContent = waiting;
                    els.artifactCount.textContent = "0";
                    els.artifactRows.replaceChildren();
                    return;
                  }
                  const entries = deriveEntries();
                  if (!selectedKey || !entries.some((e) => e.key === selectedKey)) {
                    // W-PROJP1：默认选中优先有行动项 → 立项组卡（未立项卡默认收在折叠组里，选中看不见）
                    const hot = entries.find((e) => projectActionItems(e).length > 0) || entries.find((e) => e.group) || entries[0];
                    selectedKey = hot ? hot.key : "";
                  }
                  renderQueue(entries);
                  const entry = entries.find((e) => e.key === selectedKey) || null;
                  renderHead(entry);
                  if (!entry) {
                    if (els.body) {
                      els.body.dataset.b2lSig = ""; // #282 三批审查 P2（review-282c-a）：空聚合分支清签——防「非空→空→同形非空」残留陈旧横幅
                      els.body.replaceChildren(nodesFrom('<div class="readonly-banner">暂无项目可聚合：SNAPSHOT 无项目组，也无会话目录可归组。</div>'));
                    }
                    renderInspector(null);
                    return;
                  }
                  renderLongPage(entry); // W-PROJIA 案B：单长页（图纸分区能力位在函数内判）
                  renderInspector(entry);
                }

                section.addEventListener("click", (event) => {
                  const target = event.target;
                  if (target.closest("[data-project-create]")) {
                    bridge.railJump("team");
                    toast("新建项目确认在团队域发起 · 项目页只读聚合");
                    return;
                  }
                  // W-DESIGNHUB 项目图纸打开：HttpOrigin 拼绝对地址新窗直开（关于页同款口径）
                  const designOpen = target.closest("[data-design-doc]");
                  if (designOpen) {
                    const origin = (typeof window.__ccDeck005HttpOrigin === "function" && window.__ccDeck005HttpOrigin()) || location.origin;
                    void window.__ccDeck005OpenUrl(origin.replace(/\/+$/, "") + designOpen.dataset.designDoc);
                    return;
                  }
                  const open = target.closest("[data-open-acceptance]");
                  if (open) { bridge.openAcceptance(open.dataset.openAcceptance); return; }
                  // W-PROJP1 P1-2：未立项折叠组头开关——先于卡片选中分支（组头不是卡，stopPropagation 防外溢）
                  const unfiledToggle = target.closest("[data-project-unfiled-toggle]");
                  if (unfiledToggle) {
                    event.stopPropagation();
                    unfiledCollapsed = !unfiledCollapsed;
                    try { localStorage.setItem(PROJECT_UNFILED_KEY, unfiledCollapsed ? "1" : "0"); } catch (_) {}
                    render();
                    return;
                  }
                  // W-PROJP1 P1-1：快捷链接——先于卡片选中分支，点击不触发选卡（选卡会切第三列总览，误触代价高）
                  const openBtn = target.closest("[data-project-open]");
                  // W-SRCMENU2 ⑥：图纸行点击 → 新窗直开 relay /design/<rel>（W-DESIGNHUB 红线：
                  // 图纸自带主题与交互，无容器页）。地址=主连接源 origin+path
                  const designBtn = target.closest("[data-design-open]");
                  if (designBtn) {
                    event.stopPropagation();
                    const p = designBtn.dataset.designOpen || "";
                    if (p) window.open(p, "_blank", "noopener");
                    return;
                  }
                  if (openBtn) {
                    event.stopPropagation();
                    const native = openBtn.dataset.projectOpen || "";
                    if (!native) { toast("无目录可定位"); return; }
                    if (!window.ccDeck || typeof window.ccDeck.openPath !== "function") return; // 浏览器端按钮应已隐藏，兜底不动作
                    // #106 先探后开（产物域同款）：probePath 微秒级只读 stat——目录不在本机（已删/外置盘未挂载/
                    // 远程源）明确提示，不给 openPath 报错上屏；旧壳无 probePath（升级窗口期）按「在」回落 openPath
                    const probe = typeof window.ccDeck.probePath === "function" ? window.ccDeck.probePath(native).catch(() => true) : Promise.resolve(true);
                    probe.then((ok) => {
                      if (!ok) { toast("目录不存在（可能已删除或未挂载）"); return; }
                      window.ccDeck.openPath(native, true).catch((er) => toast(String((er && er.message) || er).slice(0, 80)));
                    });
                    return;
                  }
                  const queueCard = target.closest("[data-project-key]");
                  if (queueCard) { selectedKey = queueCard.dataset.projectKey || ""; render(); return; }
                  // W-PROJIA 案C：分区「全部 N 条 ▾」就地展开/收起（超量分区才有；
                  // 展开态域内会话态记忆，render 后滚动位置随内容自然保持）
                  const psecToggle = target.closest("[data-psec-toggle]");
                  if (psecToggle) {
                    const id = psecToggle.dataset.psecToggle || "";
                    if (expandedSections.has(id)) expandedSections.delete(id);
                    else expandedSections.add(id);
                    render();
                    return;
                  }
                  const jump = target.closest("[data-domain-jump]");
                  if (jump) {
                    bridge.railJump(jump.dataset.domainJump);
                    if (jump.dataset.jumpSession) bridge.selectSessionCard(jump.dataset.jumpSession);
                  }
                });

                bridge.subscribe(() => render());
                setTimeout(render, 0);
              })();
            
// ---------- #282 定向渲染共享单口：keyed 子项 reconcile ----------
// 渲染热点问题族（#281 附清单）根因=整容器重建（innerHTML/replaceChildren）→ 浏览器侧
// 一切瞬态（滚动位/焦点/选区/动画/输入草稿）归零。本单口按 key 对齐新旧子项：
//   · html 未变的子项 → 节点零触碰（身份保住 ⇒ 焦点/选区/输入草稿天然存活）
//   · 变化的子项 → 单节点替换；新增/删除 → 定点插删；乱序 → 就地搬移
// 节点上记 __rkHtml 缓存做 O(1) 等值比较。首次运行把容器内无 data-rk 的存量子节点
// 整体迁移为 keyed（旧全量渲染语义无痛过渡）。调用方负责容器本体复用（不重建容器
// ⇒ scrollTop 天然保持；#281 类 scrollTop 记录/恢复补丁继续作兜底）。
window.__ccDeck005Reconcile = function reconcileKeyed(container, desired) {
  if (!container) return { kept: 0, replaced: 0, added: 0, removed: 0 };
  const doc = container.ownerDocument || document;
  const parse = (html) => {
    const t = doc.createElement("template");
    t.innerHTML = html;
    return t.content.firstElementChild;
  };
  const existing = new Map();
  for (const el of Array.from(container.children)) {
    const k = el.getAttribute && el.getAttribute("data-rk");
    if (k != null) existing.set(k, el);
  }
  const stats = { kept: 0, replaced: 0, added: 0, removed: 0 };
  const seen = new Set();
  let prev = null;
  const place = (node) => container.insertBefore(node, prev ? prev.nextSibling : container.firstChild);
  for (const pair of desired) {
    const key = pair[0], html = pair[1];
    // 同键守卫（#282 四批审查 B3，review-282d-b 真浏览器坐实）：重复键 desired 后续跳过
    //（首键胜出）——无守卫时 existing Map 同键 last-wins → replaceChild 摘离节点 → 后续同
    // 键对以 __rkHtml 匹配走 kept 分支 place() 把离体节点再插回=每帧+1 无上界静默增殖。
    // 单口一处守卫，全部八个调用点免疫（比改各调用方键公式便宜）。
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = existing.get(key);
    if (cur && cur.__rkHtml === html) {
      const at = prev ? prev.nextSibling : container.firstChild;
      if (at !== cur) place(cur); // 乱序搬移（不重建节点）
      prev = cur; stats.kept++; continue;
    }
    const node = parse(html);
    if (!node) continue;
    node.setAttribute("data-rk", key);
    node.__rkHtml = html;
    if (cur) { container.replaceChild(node, cur); stats.replaced++; }
    else { place(node); stats.added++; }
    prev = node;
  }
  for (const [k, el] of existing) if (!seen.has(k)) { el.remove(); stats.removed++; }
  // 非 keyed 残留清场（首跑迁移/零散节点）——keyed 体系语义=容器子集完全由 desired 组成
  for (const el of Array.from(container.children)) if (!(el.getAttribute && el.getAttribute("data-rk"))) { el.remove(); stats.removed++; }
  return stats;
};
