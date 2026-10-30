              (() => {
                const root = document.querySelector("#d-team");
                const lanes = [["backlog", "待认领"], ["claimed", "进行中"], ["submitted", "待审查"], ["ready_to_install", "待收单"], ["done", "完成"]]; /* 1014 用户定版词表 */
                // #G3 板卡富模型：父子链折叠态（展开的父卡 id 集；模块级——render 重建存活）
                const boardExpanded = new Set(); // 1014 用户定版词表：待认领/进行中/待审查/待收单/完成（批4b 改向作废）
                const legacyStatuses = new Map([["todo", "backlog"], ["doing", "claimed"]]);
                const groupStatuses = new Map([["pending", "待确认"], ["active", "运行中"], ["parked", "已挂起"], ["archived", "已归档"]]); // W-V8 批2b：状态词表对齐 v8（在办/已结项→运行中/已归档，对照图 P3 词表统一项）
                const confirmKinds = new Map([["project-create", "正式项目"], ["tier-change", "升降级"], ["suggest-hold", "暂缓"], ["archive", "结项"], ["revive", "复活"]]);
                // 件十（2026-10-11 用户实锤）：tier 措辞口语化——显示层映射「正经立项→正式项目 /
                // 轻立项→轻量项目」；存储值保持旧词（创建载荷 option value/relay 校验/org CLI 参数
                // 全不动，旧数据零迁移）。新增显示点一律走 tierDisplay()
                const TIER_DISPLAY = new Map([["正经立项", "正式项目"], ["轻立项", "轻量项目"]]);
                const tierDisplay = (t) => TIER_DISPLAY.get(t) || t || "";
                const engines = new Map([["claude", ["Claude", "claude"]], ["codex", ["Codex", "codex"]], ["trae", ["Trae", "trae"]], ["qwen-code", ["Qwen Code", "qwen"]], ["codebuddy", ["CodeBuddy", "codebuddy"]], ["zcode", ["ZCode", "zcode"]]]);
                // W-EXPP2 经验库域（SNAPSHOT.experience 覆盖式锚定 + EXPERIENCE_UPDATED 帧；
                // experiences=null=旧 relay/未锚定不渲染；experience_enabled=false=总开关关置灰）。
                // expFilter 双轴筛选（范围=项目组/global、状态=active/retired/all）；expArm=两步
                // 确认武装位（退役/恢复先点一次变「确认？」，再点才发命令——操作带确认不裸奔）；
                // expFlights 飞行中命令去重；expForm=改归组行内表单目标条目 id（null=收起）
                const state = { projects: null, confirms: [], boards: new Map(), receipts: new Map(), sessions: new Map(), selected: null, confirmSelected: null, source: "当前来源", command: null, online: false, mounted: false, epoch: 0, loads: new Map(), flights: new Set(), accepted: new Set(), unsupported: new Set(), experiences: null, experienceEnabled: undefined, expFilter: { scope: "all", status: "active" }, expArm: null, expFlights: new Set(), expForm: null, expArmTimer: null, expGcNote: null, expGcFlight: false, rules: null, rulesEnabled: undefined, rulesFilter: { status: "active", scope: "all" }, rulesArm: null, rulesArmTimer: null, rulesFlights: new Set(), rulesForm: null, rulesAddOpen: false, rulesImpOpen: false, rulesImpText: "", rulesImpPreview: null, rulesImpFlight: false, feedFilter: "all", feedSrc: "all" }; // feedFilter/feedSrc：活动页筛选双轴（类型=四态/源=引擎，Codex 轨拍板口径；纯前端过滤）
                const query = (selector) => root.querySelector(selector);
                const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
                const banner = (text) => '<div class="readonly-banner">' + escape(text) + "</div>";
                // W-NOVAFIX B5：空态分档——未连接「正在连接…」；已连接无团队数据「此 relay 无团队数据」
                const projectsEmpty = () => (state.projects === null ? (state.online ? "此 relay 无团队数据" : "正在连接…（团队数据待同步）") : "暂无项目组");
                const entities = (items) => [...new Map((Array.isArray(items) ? items : []).filter((item) => item && typeof item.id === "string" && item.id).map((item) => [item.id, item])).values()];
                // UIPOLISH3 件四②：底部常驻栏废除，反馈行走 toast（B4 在场）——原 [data-team-feedback]
                // 常驻 footer 随栏退役；toast() 原 fallback=feedback 会互递归，故 fallback 改 console
                const toast = (text) => {
                  if (window.__ccDeck005B4 && typeof window.__ccDeck005B4.toast === "function") window.__ccDeck005B4.toast(text);
                  else console.info("[team] " + text);
                };
                const feedback = toast;
                // #260 锚点格式闸（宽松）：/ 开头、Windows 盘符 [a-zA-Z]:[\\/]、UNC \\\\server\\share
                // 三形态均放行（win32.isAbsolute 认的三种绝对路径）——锚点是 relay 宿主机上
                // 的路径，浏览器操作端 OS 未必同宿主（公司 Windows 网页版连 mac 宿主是常态）；
                // 严格合法性由 relay 按宿主 OS 判定（projects.ts anchorPathError 单点），拒绝
                // 文案经 result.error 透传显示。挂 window 供 headless 断言复用同一实现。
                const anchorFormatOk = (v) => /^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(String(v ?? "").trim());
                window.__ccDeckAnchorFormatOk = anchorFormatOk;
                const group = () => state.projects?.find((item) => item.id === state.selected);
                const engine = (key) => engines.get(key) || [key || "引擎未知", ""];
                const engineBadge = (key) => { const value = engine(key); return '<span class="engine-badge ' + value[1] + '">' + escape(value[0]) + "</span>"; };
                // W-UIPOLISH ⑧：源名统一走 sourceDisplayName 映射（localhost→本机）——
                // 件十三只清了 9 处，团队域整域漏网（用户实锤团队名称旁仍挂 localhost）
                const srcName = (n) => (window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(n) : String(n || ""));
                const sourceBadge = () => '<span class="source-badge">' + escape(srcName(state.source)) + "</span>";
                // #245 A（W-SRCLABEL-MIG）：团队列表卡源胶囊——cardtags2 款（源色 E6 底/白字/
                // 圆角 4.5/电脑图标转白，会话列表 src-cap 同构）；源=组内成员会话 relay_source
                // 去重（state.sessions 为桥全量双源持有）；≤2 枚枚举、超出收「N 源」；
                // 显隐=body[data-source-count] 门控（单源隐藏/聚合显示，CSS 侧）
                const teamSrcCaps = (item) => {
                  const srcs = [...new Set(members(item).map((m) => {
                    const bs = state.sessions && state.sessions.get(m.session_id);
                    return String((bs && (bs.relay_source || bs.source)) || "");
                  }).filter(Boolean))];
                  // #277 ⑤ 兜底：成员会话已收摊/不在册（老团·远端团常态）时 srcs 恒空=用户
                  // 看不到标签的实锤形态——聚合并集时 settings-domain 已给 project 打
                  // __relay_source 源标（该团来自哪个源的真值），此处兜底读它，聚合恒显。
                  if (!srcs.length && item && item.__relay_source) srcs.push(String(item.__relay_source));
                  if (!srcs.length) return "";
                  const cap = (src) => '<span class="src-cap" title="来自 ' + escape(src) + '" style="background:' + (window.__ccDeck005SourceColor ? window.__ccDeck005SourceColor(src) : "#546784") + 'E6;border-radius:4.5px;padding:1px 5.5px;color:#fff;font-weight:700;letter-spacing:.3px"><svg width="9" height="9" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3.5" width="20" height="13.5" rx="2" fill="rgba(255,255,255,0.92)"/><path d="M8 21h8" stroke="rgba(255,255,255,0.92)" stroke-width="2.4" stroke-linecap="round"/></svg>' + escape(src) + "</span>";
                  return srcs.slice(0, 2).map(cap).join("") + (srcs.length > 2 ? '<span class="src-cap" style="background:#546784E6;border-radius:4.5px;padding:1px 5.5px;color:#fff;font-weight:700">' + srcs.length + " 源</span>" : "");
                };
                const members = (project) => (Array.isArray(project?.headcount) ? project.headcount : []).filter((member) => member && typeof member.session_id === "string");
                function memberInfo(member) {
                  const session = state.sessions.get(member.session_id) || {};
                  // 件十一：成员灯数据源=成员会话 run status（与会话卡 status-dot 唯一事实源同
                  // 语义）；查无会话数据=缺省灰（offline）。
                  // 件十⑤：别名解耦——显示名优先 nick（role 在 p 行小字自然弱化），无别名=现状
                  const status = session.status === "WORKING" && window.__ccDeck005IsRealWorking && !window.__ccDeck005IsRealWorking(session) ? "working-standby" : ({ WORKING: "working", WAITING: "waiting", ERROR: "error", DONE: "done" })[session.status] || ""; /* #291 审查 B-P2-4：成员灯过真判定（待命灰呼吸与列表卡同源；缺全局=老壳降级原样） */
                  const heartbeatAt = Number(member.last_heartbeat_at || session.activity?.updated_at || session.updated_at || 0);
                  const logAt = Number(member.last_business_log_at || session.activity?.activity?.observed_at || session.activity?.updated_at || session.updated_at || 0);
                  const signalTone = (at) => {
                    if (!at) return "off";
                    const age = Math.max(0, Date.now() - at);
                    return age <= 10 * 60 * 1000 ? "good" : age <= 30 * 60 * 1000 ? "warn" : "bad";
                  };
                  return { name: member.nick || session.title || member.session_id, role: member.role || "角色未标注", nick: member.nick || "", engine: member.engine || session.engine, model: member.model || session.model || "模型未标注", provider: member.provider || session.provider || "", context_usage: session.context_usage, context_limit: session.context_limit, status, heartbeat: signalTone(heartbeatAt), log: signalTone(logAt), summary: session.activity?.task_summary?.text || session.activity?.activity?.text || session.action_summary || "暂无最近活动" };
                }
                // V8R+（Leader 1014 追加，用户拍板）：成员卡动态排列——工作中（working/waiting）
                // 优先靠前、闲置靠后；同档内按最近活跃时间降序（越活跃越靠前）；tiebreak 保持
                // 编制序防抖动。W-POLISH #95（1016 派单口径）：WAITING 归入第 0 档（在动状态=
                // WORKING/WAITING 双态，原实现仅 working——两端待认领单/等输入也算活跃位）。
                // W-HYBRID #115④（1015 拍板）：PM/Leader 恒置首（pm 档 0——指挥位用户心智；
                // 工作档顺延 1，其余 2；同档内活跃倒序与编制序 tiebreak 不变，sortRoster WAITING
                // 档语义完全兼容——PM 也在动时仍在首，非 PM 在动时仍前于闲置）。
                // 行为逻辑非纯视觉：状态切换后顺序随每次渲染跟随变化（sortRoster 单口，
                // 成员页 pane 与侧栏 data-team-members 共用同一排序）。
                function sortRoster(list, project) {
                  // #264（1026 用户实锤）活跃置顶四档：WORKING(0) > WAITING(1) > 有排队派单(2)
                  // > idle/DONE/其余(3)；同级按最近活跃（updated_at）降序，编制序 tiebreak 防抖动。
                  // PM/Leader 恒首档保留（W-HYBRID #115④ 既有拍板+PM 补充指令重申：PM 恒第一位不受活跃态影响，
                  // 词表=SLIM_KEEP_ROLE 五词镜像；先于活跃四档）。
                  // 「有排队派单」= pendingDispatchSids（W-DISPVIS C2 同源：dispatched/queued/running
                  // 且未消费——正是「活要来了」的前奏位）。project 可缺省（旧调用/无 gid 场景退化
                  // 三档，排队档并入 idle 不误升）。
                  const queued = project ? pendingDispatchSids(project.id) : new Set();
                  const rank = (m) => {
                    const session = state.sessions.get(m.session_id) || {};
                    const status = session.status === "WORKING" && window.__ccDeck005IsRealWorking && !window.__ccDeck005IsRealWorking(session) ? "working-standby" : ({ WORKING: "working", WAITING: "waiting", ERROR: "error", DONE: "done" })[session.status] || ""; /* #291 待命 */
                    const lastAt = Number(session.activity?.updated_at || session.updated_at || session.started_at || 0);
                    const isPm = /^(pm|leader|产品经理|项目经理|领队)$/i.test(String(m.role || "")); // PM 补充指令：词表对齐 SLIM_KEEP_ROLE 五词（中文 PM 实况同收）
                    const active = status === "working" ? 0 : status === "waiting" ? 1 : queued.has(m.session_id) ? 2 : 3;
                    return { pm: isPm ? 0 : 1, active, lastAt };
                  };
                  return list
                    .map((m, i) => ({ m, r: rank(m), i }))
                    .sort((x, y) => x.r.pm - y.r.pm || x.r.active - y.r.active || y.r.lastAt - x.r.lastAt || x.i - y.i)
                    .map((x) => x.m);
                }
                // W-DISPVIS C2：组内「已派单未消费」会话集——detail receipts 已是同 id
                // 收敛视图（relay readDispatchLog 末行赢，每 id 一行），逐行判定即末行
                // 判定：停在 dispatched/queued/running 且 consumed!==true = 派单已注入、
                // CLI 尚未吃下（running 是承接成功——消息可能在注入队列/换流窗口/排队
                // 消息中，正是「等待处理」的可观测窗口）。旧 relay 无 consumed 字段时按
                // status 判定仍成立（兼容）。
                // 刷新链：派单建卡必发 BOARD_UPDATED → 7916 全量板帧触发 requestDetail
                // 重拉 → receipts/consumed 收敛 → render() 角标跟随（复用既有帧，零新帧）
                function pendingDispatchSids(gid) {
                  const rows = state.receipts.get(gid);
                  if (!Array.isArray(rows) || !rows.length) return new Set();
                  const sids = new Set();
                  for (const r of rows) {
                    if (r && (r.status === "dispatched" || r.status === "queued" || r.status === "running") && r.consumed !== true && r.session_id) sids.add(r.session_id);
                  }
                  return sids;
                }
                // W-SMIMPL ②：回执缺失单集（relay 收口边落 receipt_missing:true 的 done 单）——
                // 看板 done 卡「无回执」角标数据源。与 pendingDispatchSids 同构（receipts
                // 已是同 id 末行收敛视图，逐行判定即末行判定）；旧 relay 无此字段=空集零影响
                function missingReceiptIds(gid) {
                  const rows = state.receipts.get(gid);
                  if (!Array.isArray(rows) || !rows.length) return new Set();
                  const ids = new Set();
                  for (const r of rows) {
                    if (r && r.status === "done" && r.receipt_missing === true && r.id) ids.add(r.id);
                  }
                  return ids;
                }
                function memberCtxMeter(info) { // ⑥a-4 成员卡水位条：成员会话 context 用量（无数据不渲染）
                  const used = Number(info.context_usage) || 0;
                  const limit = Number(info.context_limit) || 0;
                  if (!used || !limit || limit <= 0) return "";
                  const pct = Math.max(1, Math.min(100, Math.round((used / limit) * 100)));
                  if (!Number.isFinite(pct)) return ""; // 件十六防护：脏数据（NaN 比例）宁缺毋滥——NaN% 内联失效会退化成全宽条（全员等长观感的候选根因）
                  // V8R：原型 ctxrow/.ctx/.ctxlabel——5px 渐变填充条 + tabular-nums 标签
                  //（原三色 tone 分段退役；title 带原值与档位信息补偿）
                  return '<div class="ctxrow" data-context-waterline title="上下文 ' + used + ' / ' + limit + ' tokens（' + (pct >= 85 ? "危险" : pct >= 60 ? "偏高" : "安全") + '）"><span class="ctx"><i style="width:' + pct + '%"></i></span><span class="ctxlabel">上下文 ' + pct + "%</span></div>";
                }
                // #264（1026 用户实锤）头像标准化：与会话列表同源体系（W-CRABINTEGRATE 手机端
                // 角色蟹移植桌面）——底色=引擎品牌色淡彩（session-domain b2AvaColor 同口径色轮）；
                // 主体：claude+PM/Leader=角色蟹整头（crab-pm 举旗/crab-leader 皇冠，expo 同资产
                // base64 内嵌——单文件口径+打包清单零改动），其他引擎=ENGINE_BRAND_SVG 品牌图标，
                // 无引擎=首字母；叠角：非 claude 的 PM/Leader=右上 -15° 金冠 12px（expo AvaBadge
                // 同规格），QA=QA 小角标（原 avatar.qa 底色语义转角标）；右下 status-dot 角灯保留。
                // #277 ⑥：CRAB_PM_B64/CRAB_LEADER_B64 已退役——角色蟹统一走 session-domain
                // ROLE_AVATAR_BRAND（__ccDeck005AvaOf 单口，与列表卡同图源同规格）
                // 引擎→头像淡彩底（session-domain b2AvaColor 同表镜像；缺省走源哈希不可得处用中性）
                const AVA_COLORS = { claude: "var(--engine-claude)", codex: "var(--engine-codex)", trae: "var(--engine-trae)", qwen: "var(--engine-qwen)", "qwen-code": "var(--engine-qwen)", codebuddy: "var(--engine-codebuddy)", zcode: "var(--engine-zcode)", glm: "var(--engine-glm)" };
                function memberAvatarHtml(info, roleClass) {
                  const eng = info.engine && engines.has(info.engine) ? info.engine : "";
                  const bg = eng ? AVA_COLORS[eng] || "var(--hover)" : "var(--hover)";
                  // #277 ⑥：头像同源单口——委派 session-domain avaBrandHtmlOf（列表卡同规格：
                  // 品牌 SVG 经 .ava-brand 包装受尺寸约束；PM/Leader 角色蟹/皇冠同表）。
                  // 旧实现裸注品牌 SVG（viewBox 无宽高）+ CSS .m-head 脱锚 = 大螃蟹实锤根因。
                  const core = window.__ccDeck005AvaOf
                    ? window.__ccDeck005AvaOf(eng || "claude", roleClass)
                    : escape((info.nick || info.name || "?").trim().charAt(0).toUpperCase());
                  const qatag = roleClass === "qa" ? '<i class="ava-qatag">QA</i>' : "";
                  return '<span class="avatar m-ava ' + roleClass + '" style="--ava-c:' + bg + '">' + core + qatag + '<i class="status-dot ' + (info.status || "") + '"></i></span>';
                }
                function memberMarkup(member, project) {
                  const info = memberInfo(member);
                  const roleClass = /^(pm|leader)$/i.test(info.role) ? "pm" : /^(qa|reviewer|验收)$/i.test(info.role) ? "qa" : "worker";
                  // 件六同源漏网：引擎词表外/缺失不渲染徽章（原兜底「引擎未知」上卡=噪音，与看板卡同口径）
                  const engBadgeHtml = info.engine && engines.has(info.engine) ? engineBadge(info.engine) : "";
                  // 件十一：头像角点=状态灯（status-dot 同源绘画卡，working 橘呼吸/waiting 黄/done 绿/
                  // 查无=缺省灰）——原 avatar-engine-dot 引擎色点（claude 橘）被误读为运行灯，空闲成员
                  // 也亮橘=「成员灯与绘画卡矛盾」根因；引擎语义已有 engine-badge 表达不丢失
                  const stateLabel = ({ working: "运行中", waiting: "待处理", error: "异常", done: "已完成" })[info.status] || "离线";
                  const signalLabel = (tone) => ({ good: "正常", warn: "滞后", bad: "失联", off: "无数据" })[tone] || "无数据";
                  // V8R 名册卡（原型 member/.mh/.mb/.ctxrow）：头行=头像+名/角色两行+模型 mono 虚线
                  // 胶囊+状态软底胶囊；引擎/源徽章收摘要下轻量行（owner 徽章保留）；五色叠角灯不变
                  const mdl = info.model && info.model !== "模型未标注" ? '<span class="member-mdl" title="模型">' + escape(info.model) + "</span>" : "";
                  // W-HYBRID #115④ 消息钮（1015 拍板·Codex 轨）：卡右下显式 💬 直达会话——复用
                  // data-team-member-session 跳转链（委托→selectSessionCard），触屏/键盘
                  // 可达性增强零新路由；状态标签=member-state 胶囊已落（文案贴会话语义）
                  const msgBtn = member.session_id ? '<span class="member-msg-btn" role="button" tabindex="0" title="直达成员会话" aria-label="直达 ' + escape(info.name) + ' 的会话"><svg class="icon-inline" aria-hidden="true"><use href="#icon-chat"></use></svg>消息</span>' : "";
                  // W-DISPVIS C2：成员有已派单未消费（含换流窗口）→ 轻量角标（identity-cluster
                  // 轻量行，working 黄系 pill；数据缺席/旧 relay 不渲染）
                  const dispPend = pendingDispatchSids(project.id).has(member.session_id)
                    ? '<span class="tag dispatch-pending" title="派单已注入，worker 尚未消费（换流/启动窗口）">已派单 · 等待处理</span>'
                    : "";
                  return '<div class="member-card" data-team-member-session="' + escape(member.session_id) + '" title="打开成员会话"><div class="member-head">' + memberAvatarHtml(info, roleClass) + '<div class="mh-id"><strong>' + escape(info.name) + '</strong><p class="member-role">' + escape(info.role) + (info.provider ? " · " + escape(info.provider) : "") + '</p></div>' + mdl + '<span class="member-state state-' + (info.status || "offline") + '"><i class="status-dot ' + (info.status || "") + '"></i>' + stateLabel + '</span></div><span class="member-summary" title="' + escape(info.summary) + '">' + escape(info.summary) + '</span><div class="identity-cluster">' + engBadgeHtml + dispPend + '</div><div class="watchdog-row"><span class="watchdog-signal ' + info.heartbeat + '" title="心跳 · ' + signalLabel(info.heartbeat) + '"><i></i>心跳</span><span class="watchdog-signal ' + info.log + '" title="日志 · ' + signalLabel(info.log) + '"><i></i>日志</span></div>' + memberCtxMeter(info) + msgBtn + "</div>";
                }
                // UIPOLISH3 件五/六/七/八 + 件四⑤ + 追加⑦⑧（2026-10-11 用户看板实测反馈）：
                // 紧凑双行卡——泳道已表达状态，卡上状态标签删除（件五）；引擎词表外不渲染
                // （件六：原 engine() 兜底「引擎未知」上卡=噪音）；执行者行=引擎点+成员名
                // （headcount 映射）；queueCtx=件八排队注入 {ordinal, running}。
                // 追加⑦a：无主卡文本前缀 [角色名]/[成员名] 解析映射 headcount（role 或名**唯一**
                // 命中才绑，歧义不绑保持未指派；显示剥前缀、浮层留全文；纯显示层不写回 relay）。
                // 追加⑧：紧凑卡信息补偿=hover 展开浮层（标题全文/描述全文/执行者/时间；向上弹
                // 防 workspace-body 底缘裁剪；定夺理由见回执——侧滑详情需新面板+路由态，浮层轻）
                function taskOwnerResolve(task, project) {
                  if (task.owner_session) {
                    const m = members(project).find((item) => item.session_id === task.owner_session);
                    return { member: m || null, text: String(task.text || task.id), resolved: Boolean(m) };
                  }
                  const pm2 = /^\[([^\[\]]{1,16})\]\s*/.exec(String(task.text || ""));
                  if (!pm2) return { member: null, text: String(task.text || task.id), resolved: false };
                  const key = pm2[1].trim().toLowerCase();
                  const hits = members(project).filter((item) => {
                    const info = memberInfo(item);
                    return (info.role || "").toLowerCase() === key || (info.name || "").toLowerCase() === key || (info.nick || "").toLowerCase() === key; // 件十⑤：别名也参与前缀定位
                  });
                  if (hits.length !== 1) return { member: null, text: String(task.text || task.id), resolved: false }; // 零命中/多命中（如同 role 多 worker）不绑
                  return { member: hits[0], text: String(task.text || task.id).slice(pm2[0].length), resolved: true };
                }
                function taskSelfCheck(task) {
                  const raw = task && (task.self_check ?? task.self_checks ?? task.verification);
                  const statusOf = (value) => {
                    if (value === true) return "pass";
                    if (value === false) return "fail";
                    if (value && typeof value === "object") {
                      if (value.passed === true || value.ok === true) return "pass";
                      if (value.failed === true || value.ok === false) return "fail";
                      value = value.status ?? value.state ?? value.result ?? "";
                    }
                    const token = String(value || "").toLowerCase();
                    if (/pass|ok|done|complete|success|通过/.test(token)) return "pass";
                    if (/fail|error|block|failed|未过|失败/.test(token)) return "fail";
                    return "pending";
                  };
                  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object"
                    ? (Array.isArray(raw.items) ? raw.items : Array.isArray(raw.checks) ? raw.checks : Array.isArray(raw.steps) ? raw.steps : null)
                    : null;
                  if (items && items.length) {
                    const dots = items.map(statusOf);
                    const passed = dots.filter((status) => status === "pass").length;
                    const failed = dots.filter((status) => status === "fail").length;
                    return { dots: dots.slice(0, 16), passed, failed, total: dots.length };
                  }
                  if (!raw || typeof raw !== "object") return null;
                  const passed = Math.max(0, Number(raw.passed ?? raw.pass ?? raw.ok_count ?? raw.completed) || 0);
                  const failed = Math.max(0, Number(raw.failed ?? raw.fail ?? raw.error_count) || 0);
                  const declaredTotal = Math.max(0, Number(raw.total ?? raw.count) || 0);
                  const total = Math.max(declaredTotal, passed + failed);
                  if (!total) return null;
                  const pending = Math.max(0, total - passed - failed);
                  return { dots: Array.from({ length: Math.min(total, 16) }, (_, index) => index < passed ? "pass" : index < passed + failed ? "fail" : "pending"), passed, failed, total, pending };
                }
                function taskMarkup(task, project, queueCtx) {
                  const r = taskOwnerResolve(task, project);
                  const hasOwner = r.resolved; // ⑦a：前缀映射命中视同有主
                  const info = memberInfo(r.member || (task.owner_session ? { session_id: task.owner_session, role: "执行者" } : { session_id: "", role: "" }));
                  // 1013 件6：卡面显示名走看板语境单口——nick 优先，缺席回短 sid（原 memberInfo
                  // 的 session.title 兜底会把派单 prompt 首行/全 UUID 顶上卡，蓝底大字元凶）
                  const shortSid = (sid) => String(sid || "").slice(0, 8);
                  const dispName = r.member ? (String(r.member.nick || "") || shortSid(r.member.session_id)) : shortSid(task.owner_session);
                  const engKnown = Boolean(info.engine && engines.has(info.engine)); // 件六：词表外/缺失不渲染引擎
                  const laneKey = legacyStatuses.get(task.status) || task.status;
                  const isDone = laneKey === "done";
                  // V8R 三段式卡（原型 tcard：.ct 标题 / .cm chip 行 / .cline meta 行）——
                  // 执行者行 chip 胶囊化（tchip：bg1 底+card-sub 字+radius 6），排队/运行
                  // 信号保留（q-run 点 + cline 排队号）；未指派/失联警示色语义不变
                  const ownerBits = [];
                  if (queueCtx && queueCtx.running) ownerBits.push('<i class="q-run" title="派单运行中"></i>');
                  if (engKnown) ownerBits.push(engineBadge(info.engine));
                  // W-DISPVIS C2：看板卡执行者有已派单未消费（含换流窗口）→ owner chip 旁
                  // 轻量角标（同成员卡口径；q-run 是队列运行信号、本角标是消息级消费信号，
                  // 两者互补不互斥——q-run 由排队上下文驱动、本角标由 receipts.consumed 驱动）
                  if (task.owner_session && pendingDispatchSids(project.id).has(task.owner_session)) {
                    ownerBits.push('<span class="tchip disp-pend" title="派单已注入，worker 尚未消费（换流/启动窗口）">已派单 · 等待处理</span>');
                  }
                  ownerBits.push('<span class="tchip owner">' + (hasOwner ? "<b>" + escape(dispName) + "</b>" + (info.role ? "<i>" + escape(info.role) + "</i>" : "") : task.owner_session ? "<b>" + escape(dispName) + "</b><i>失联</i>" : "<b>未指派</b>") + "</span>");
                  const fullText = String(task.text || task.id);
                  // 1013 件6：卡面标题渲染层 cap60 归一（relay 建卡已 cap，存量卡/owner 前缀回填
                  // 路径漏网在此兜底；title 属性与悬浮详情仍全文）
                  const faceText = (() => { const t = String(r.text || fullText).trim(); return t.length > 60 ? t.slice(0, 59) + "…" : t; })();
                  const created = expFmtTime(task.ts);
                  const updated = expFmtTime(task.updated_at);
                  // V8R cline meta 行：时间基线 + 排队号（原 claimed 分区头退役，排队信息落卡面）。
                  // 短时间格式（原型 cline「认领 10:02」口径）：今天=HH:MM，跨日=MM-DD HH:MM
                  const shortTime = (ts) => {
                    const d = new Date(Number(ts) || 0);
                    if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "—";
                    const pad = (n) => String(n).padStart(2, "0");
                    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
                    const now = new Date();
                    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
                    return sameDay ? hm : pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hm;
                  };
                  const clineBits = ["创建 " + shortTime(task.ts)];
                  if (updated && updated !== "—" && updated !== created) clineBits.push("更新 " + shortTime(task.updated_at));
                  if (queueCtx && queueCtx.ordinal) clineBits.push("排队 #" + queueCtx.ordinal);
                  if (queueCtx && queueCtx.running) clineBits.push('<span class="cline-run">▶ 运行中</span>');
                  // W-SMIMPL ②：done 卡「无回执」角标（worker 静默收工可见化——账面 done
                  // 内容空，Leader 不抽查不知情的三次实锤止痛件；done 泳道专用）
                  if (isDone && task.dispatch_id && missingReceiptIds(project.id).has(task.dispatch_id)) {
                    clineBits.push('<span class="cline-miss" title="收口 done 但回执无「结果：」行（worker 静默收工）——请抽查该单交付">⚠ 无回执</span>');
                  }
                  const selfCheck = taskSelfCheck(task);
                  const selfCheckLabel = selfCheck ? "AI 自验 " + selfCheck.passed + "/" + selfCheck.total + (selfCheck.failed ? " · " + selfCheck.failed + " 项未过" : selfCheck.passed === selfCheck.total ? " · 全过" : "") : "";
                  const selfCheckHtml = selfCheck ? '<span class="task-verify" title="' + escape(selfCheckLabel) + '" aria-label="' + escape(selfCheckLabel) + '">' + selfCheck.dots.map((status) => '<i class="task-verify-dot ' + status + '"></i>').join("") + "</span>" : "";
                  // 件十九：泳道迁移时间线（历史条目无 transitions=从当下起记，如实显示已有部分）
                  const laneName = (st) => (lanes.find((l) => l[0] === (legacyStatuses.get(st) || st)) || [])[1] || st;
                  const timeline = Array.isArray(task.transitions) && task.transitions.length
                    ? "<span>流转：" + task.transitions.map((tr) => laneName(tr.status) + " " + expFmtTime(tr.ts)).join(" → ") + "</span>"
                    : "";
                  // W-HYBRID #114① 五色条映射（Codex 轨）：gate 阻塞恒 error 覆盖 lane 色；
                  // claimed=working/backlog=idle/submitted·ready_to_install=blocked（等外部）/done=closed
                  const stripe = task.gate ? "error" : ({ backlog: "idle", claimed: "working", submitted: "blocked", ready_to_install: "blocked", done: "closed" })[laneKey] || "idle";
                  // #G3 子任务折叠：挂靠数与展开态（kidsByParent 由 boardMarkup laneBody 注入——
                  // 同泳道父子挂靠；跨泳道/坏引用=孤儿容错平铺，与 depends_on 同口径）
                  const subCount = task.__subCount || 0;
                  const subOpen = boardExpanded.has(task.id);
                  // M2b：折叠钮显子卡进度 x/y（done/total），齐活（全部子卡 done）钮加亮
                  // sub-all + 卡头「批次齐活」chip（父卡亮=批次收口一目了然，A4 增益）
                  const subDone = task.__subDone || 0;
                  const subAllDone = !!task.__subAllDone;
                  // #G3 板卡富模型：优先级 chip（P0 红/P1 琥珀；P2=默认档不显——显了反而噪音）+ data-priority 左缘色条（CSS）
                  const prio = /^(P0|P1)$/.test(String(task.priority || "")) ? String(task.priority) : "";
                  return '<div class="task-card compact' + (isDone ? " task-done" : "") + '" data-team-task="' + escape(task.id) + '" data-stripe="' + stripe + '"' + (prio ? ' data-priority="' + prio + '"' : "") + ' title="' + escape(fullText) + '"><div class="task-title">' + (subCount ? '<button type="button" class="sub-toggle' + (task.__subRunning ? " sub-running" : "") + (subAllDone ? " sub-all" : "") + '" data-board-toggle="' + escape(task.id) + '" title="子任务折叠/展开（#G3 父子链' + (task.__subRunning ? "——内有运行中子任务" : "") + (subAllDone ? "——批次齐活（全部子卡 done）" : "") + '）">' + (subOpen ? "▾" : "▸") + " " + subDone + "/" + subCount + "</button>" : "") + '<strong>' + (isDone ? "✓ " : "") + escape(faceText) + '</strong>' + (prio ? '<span class="tchip prio-' + prio.toLowerCase() + '" title="优先级 ' + prio + '（#G3）">' + prio + "</span>" : "") + (subAllDone ? '<span class="tchip sub-all-chip" title="批次齐活：全部子任务已完成（M2b 父子联动）">批次齐活</span>' : "") + selfCheckHtml + '</div>' + (task.note ? "<p>" + escape(task.note) + "</p>" : "") + '<div class="task-owner' + (hasOwner ? "" : " unassigned") + '">' + ownerBits.join("") + "</div>" + '<div class="task-cline">' + clineBits.join(' <i class="cline-sep">·</i> ') + "</div>" + (task.gate ? '<div class="task-flag">阻塞：' + escape(task.gate.reason || "等待人工解除") + "</div>" : "") + '<div class="task-pop"><b>' + escape(fullText) + "</b>" + (task.note ? "<p>" + escape(task.note) + "</p>" : "") + "<span>执行者：" + (hasOwner ? escape(dispName) + " · " + escape(info.role || "") : task.owner_session ? escape(dispName) + " · 失联" : "未指派") + " · 创建 " + created + " · 更新 " + updated + "</span>" + timeline + "</div>" + (subCount && subOpen ? '<div class="subtasks">' + (task.__subs || []).map((sub) => taskMarkup(sub, project)).join("") + "</div>" : "") + "</div>";
                }
                // W-DESIGNHUB 看板挂载图纸区（用户澄清并入）：当前组关联，匹配口径与
                // 项目域 designSectionMarkup 同构——分词 ∩ tags 子串双向，中文项目名无空格
                // 分词靠子串包含兜底。清单缺（旧 relay）整区不渲染；输出物第二区已迁
                // 独立「输出」tab（W-OUTTAB）
                function teamDesignSection(project) {
                  const docs = state.designDocs;
                  if (!Array.isArray(docs) || !docs.length) return "";
                  if (!project) return '<div class="inspector-block board-side-list"><div class="inspector-title"><span>系统设计图纸 · ' + docs.length + '</span></div>'
                    + docs.slice(0, 6).map((d) => '<div class="task-card compact"><strong>' + escape(d.title) + '</strong><p>' + escape(d.group) + " · " + escape(d.path) + '</p><button class="mini-list-link" type="button" data-design-doc="' + escape(d.path) + '">新窗打开 ↗</button></div>').join("")
                    + (docs.length > 6 ? '<div class="inspector-copy">共 ' + docs.length + " 张 · 全部清单见 设置 → 关于。</div>" : "") + "</div>";
                  const segs = [String(project.name || ""), String(project.anchor_dir || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || ""];
                  const toks = new Set();
                  for (const seg of segs) for (const tok of seg.toLowerCase().split(/[-_/.\s]+/)) if (tok && !/^\d+$/.test(tok)) toks.add(tok);
                  const tokArr = [...toks];
                  const hit = (tag) => tokArr.some((t) => t.includes(tag) || tag.includes(t));
                  const hits = docs.filter((d) => Array.isArray(d.tags) && d.tags.some(hit));
                  if (!hits.length) return '<div class="inspector-block board-side-list"><div class="inspector-title"><span>系统设计图纸</span></div><div class="inspector-copy">本团队暂无关联图纸 · 全部清单见 设置 → 关于 → 系统设计图纸。</div></div>';
                  return '<div class="inspector-block board-side-list"><div class="inspector-title"><span>系统设计图纸 · ' + hits.length + '</span></div>'
                    + hits.map((d) => '<div class="task-card compact"><strong>' + escape(d.title) + '</strong><p>' + escape(d.group) + " · " + escape(d.path) + '</p><button class="mini-list-link" type="button" data-design-doc="' + escape(d.path) + '">新窗打开 ↗</button></div>').join("") + "</div>";
                }
                function teamOutputsMarkup(project) {
                  // W-OUTTAB（用户 1015 拍板：输出物不放看板里）：原看板尾「团队输出物」侧块整体
                  // 迁独立「输出」tab。数据口径零改动（当前编制成员会话 artifacts 聚合、last_at 倒序），
                  // 侧块 8 条上限随迁移退役（专设 tab=全量面）；跳转链同源 data-team-artifact。
                  if (!project) return banner("尚未选定团队——左侧选择团队后展示编制输出物。");
                  const sidSet = new Set(members(project).map((m) => m.session_id));
                  const rows = [];
                  for (const [sid, s] of state.sessions) {
                    if (!sidSet.has(sid) || !Array.isArray(s?.artifacts)) continue;
                    for (const a of s.artifacts) if (a && typeof a.path === "string") rows.push({ sid, s, a });
                  }
                  rows.sort((x, y) => (Number(y.a.last_at) || 0) - (Number(x.a.last_at) || 0));
                  const head = '<div class="pane-summary">团队输出物 <span class="faint">共 ' + rows.length + " 件 · 按登记时间倒序</span></div>";
                  if (!rows.length) return head + banner("当前编制尚无输出物 · 会话产出实时登记。");
                  return head + rows.map((r) => '<div class="task-card compact" data-team-artifact="' + escape(r.sid) + '" title="在会话域查看输出物"><strong>' + escape((r.a.path || "").split(/[\\/]/).pop() || r.a.path) + '</strong><p>' + escape(r.s?.title || r.sid) + (r.a.last_at ? " · " + expFmtTime(r.a.last_at) : "") + "</p></div>").join("");
                }
                // #282 三批 M2（清单 §2.3）：团队详情六 pane+成员/活动/确认区签名跳帧——
                // 筛选切换+帧的整串 innerHTML 收口（活动/看板滚动位、筛选 chips 悬停逐帧存活）。
                // 行文时间为绝对 HH:MM / 分钟粒度相对文本——分钟翻转才触发重建（无秒级签名失效面）。
                const tSigOf = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return "t" + (h >>> 0).toString(36); };
                function tSigWrite(el, sig, html) {
                  if (!el) return false;
                  if (el.dataset.tSig === sig && el.childElementCount) return false;
                  el.dataset.tSig = sig;
                  el.innerHTML = html;
                  return true;
                }
                function boardMarkup(project) {
                  const board = state.boards.get(project?.id);
                  const tasks = entities(board?.entries);
                  const loading = state.loads.get(project?.id);
                  // W-NOVAFIX B5：空态分档——projectsEmpty 见域顶定义（render/boardMarkup 共用）
                  const empty = !project ? projectsEmpty() : board ? tasks.length ? "" : "任务板暂无任务" : loading === "loading" ? "正在加载任务板…" : loading && loading !== "ready" ? loading : "尚未取得任务板，请接入详情命令通道或点击刷新详情。";
                  // 件八：派单回执收敛行（同 dispatch_id 取末行）→ claimed 卡运行中/排队区分
                  const dispatchStatus = new Map((state.receipts.get(project?.id) || []).map((r) => [r && r.id, r && r.status]).filter(([id, st]) => id && typeof st === "string"));
                  const boardCounts = new Map(lanes.map(([status]) => [status, tasks.filter((task) => (legacyStatuses.get(task.status) || task.status) === status).length]));
                  const total = tasks.length;
                  // V8R 总览区（原型 .ov）：prog 8px 矩形分段（段色 --p-* 同名类映射）+ 方 chip
                  // 图例——去「任务板总览」重头行（计数并入图例，实时口径入 boardfoot）
                  const boardOverview = '<div class="board-overview"><div class="board-progress" aria-label="任务状态分布">' + lanes.filter(([status]) => boardCounts.get(status) > 0).map(([status]) => '<i class="' + status + '" style="flex-grow:' + boardCounts.get(status) + '"></i>').join("") + '</div><div class="board-legend">' + lanes.map(([status, label]) => '<span style="--legend-color:var(--p-' + (status === "ready_to_install" ? "ready" : status) + ')"><i></i>' + label + ' <b>' + boardCounts.get(status) + '</b></span>').join("") + '</div></div>'; /* t25fix #7：0 宽段不渲染（空段+分隔线堆叠=「全灰/被遮挡」观感），段宽 flex-grow 按任务数比例（gap 布局下百分比宽会溢出） */
                  const laneBody = (status, items) => {
                    // V8R：泳道内平铺（原型 bcol 无分区头概念）——claimed 全列统一「运行中置顶
                    // + ts 升序」=排队序，排队号 #n 与运行态落卡面 cline；backlog 同平铺。
                    // （原 per-worker 分区头与「未指派」组头退役；身份/失联/未指派警示全在卡 chip）
                    // #G3 父子链：同泳道子卡折叠挂靠根卡（默认折叠，钮在卡头）；只挂一层——
                    // parent_id 指向非根卡（孙链）/跨泳道/坏引用=孤儿容错平铺（不炸不丢）
                    const rootIds = new Set(items.filter((t) => !t.parent_id || !items.some((r) => r.id === t.parent_id && !r.parent_id)).map((t) => t.id));
                    const roots = items.filter((t) => rootIds.has(t.id));
                    const subs = items.filter((t) => !rootIds.has(t.id));
                    const kidsByParent = new Map();
                    for (const sub of subs) {
                      if (!rootIds.has(sub.parent_id)) continue; // 孤儿子卡（孙链）：平铺进根列
                      if (!kidsByParent.has(sub.parent_id)) kidsByParent.set(sub.parent_id, []);
                      kidsByParent.get(sub.parent_id).push(sub);
                    }
                    const orphanKids = subs.filter((sub) => !rootIds.has(sub.parent_id)); // 审查 B-P3：删恒假第二支（kidsByParent 收录判定已由 rootIds 蕴含）
                    const withSubs = [...roots, ...orphanKids].map((t) => {
                      t.__subs = kidsByParent.get(t.id) || [];
                      t.__subCount = t.__subs.length;
                      // 审查 B-P2-2：子卡有运行中派单→父卡折叠钮亮黄点（折叠不吞「里面有活跑」信号）
                      t.__subRunning = t.__subs.some((sub) => dispatchStatus.get(sub.dispatch_id) === "running");
                      // M2b 批次齐活（multica 借④补强）：子卡 done 计数 + 全终态标志——父卡
                      // 折叠钮显 x/y 进度，齐活加亮（父卡自身状态不动，纯呈现层联动）
                      t.__subDone = t.__subs.filter((sub) => (legacyStatuses.get(sub.status) || sub.status) === "done").length;
                      t.__subAllDone = t.__subCount > 0 && t.__subDone === t.__subCount;
                      return t;
                    });
                    const flatRender = (list, withOrdinals) => list.map((t, i) => taskMarkup(t, project, withOrdinals && list.length > 1 ? { ordinal: i + 1, running: dispatchStatus.get(t.dispatch_id) === "running" } : withOrdinals ? { running: dispatchStatus.get(t.dispatch_id) === "running" } : undefined)).join("");
                    const claimedBody = (() => {
                      const ordered = withSubs.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
                      const runningIdx = ordered.findIndex((t) => dispatchStatus.get(t.dispatch_id) === "running" || t.__subRunning);
                      if (runningIdx > 0) ordered.unshift(...ordered.splice(runningIdx, 1)); // 运行中置顶=当前活（审查 B-P2-2：子卡 running 的父卡同权置顶）
                      return flatRender(ordered, true);
                    })();
                    // 审查 B-P2-3：泳道计数=可见卡数（根+孤儿子卡）——原 items.length 含折叠子卡（显 8 见 2）
                    return { html: status === "claimed" ? claimedBody : flatRender(withSubs, false), visibleN: withSubs.length };
                  };
                  const columns = lanes.map(([status, label]) => {
                    const items = tasks.filter((task) => (legacyStatuses.get(task.status) || task.status) === status);
                    const laneRes = laneBody(status, items);
                    const body = laneRes.html;
                    // V8R：待收单列 = 原型 bcol.go（⚡ 行动列：琥珀描边+光环+渐变头+列头琥珀字）
                    const headLabel = status === "ready_to_install" ? "⚡ " + label : label;
                    const lane = '<div class="lane lane-' + status + '"><div class="lane-head"><span>' + headLabel + "</span><span>" + laneRes.visibleN + "</span></div>" + (body || '<div class="lane-empty">暂无任务</div>') + "</div>"; /* #G3 审查 B-P2-3：计数=可见卡数（折叠子卡不计数） */
                    // W-LANEFIX（用户 1024 装机实测）：完成泳道还原正常列——#236 D 的
                    // 「归档 · 完成 N 张（点击展开）」<details> 默认折叠特例退役（与另四条
                    // 泳道不统一）；标签回归词表定版「完成」（:3 1014 定版，图例同源）+
                    // 默认展开同款样式。数据零删除不变（板面照常全量展示已收割任务）
                    return lane;
                  }).join("");
                  const unknown = tasks.filter((task) => !lanes.some((lane) => lane[0] === (legacyStatuses.get(task.status) || task.status)));
                  // V8R boardfoot（原型 .boardfoot）：口径脚注——自验点语义 + 操作指引
                  const boardFoot = '<div class="boardfoot">板面实时同步 · 断线自动补齐 · 卡面 ✓✗○ = AI 自验进度，最终验收以确认卡为准 · 新建任务走来源会话派单</div>';
                  return (empty ? banner(empty) : "") + (board?.frozen ? banner("任务板已冻结，只读展示。") : "") + boardOverview + '<div class="board">' + columns + "</div>" + boardFoot + (unknown.length ? banner("以下任务状态未识别，保留原值，不归入完成。") + unknown.map((task) => taskMarkup(task, project)).join("") : "");
                }
                function activityMarkup(project, opts = {}) {
                  // W-ACTIVITY3（#116，1015 拍板）：视觉基准=v3 原型活动页（feedwrap/.fi 轻列表
                  // ——行=时间+glyph+状态词+标题，dashed 分隔，去卡片墙重徽章）；筛选语义=Codex
                  // 轨拍板（类型/源双轴——团队/项目轴在 per-team pane 内退化恒单值不单列）。
                  // 数据源沿用派单回执（dispatch-log 收敛末行）零 relay 改动：engine 为 M12-5
                  // 可选键（缺省=Claude 不写键），receipt 仅终态行携带。
                  // opts.compact=右侧栏「最近派单回执」复用行渲染（v3 dispfeed 同形态：
                  // 无头无 chips 纯行流）。
                  const receipts = state.receipts.get(project?.id);
                  const compact = Boolean(opts.compact);
                  if (!receipts) return banner("尚未取得派单回执，请加载项目详情。");
                  const head = '<div class="pane-summary">活动 <span class="faint">团队时间线 · 共 ' + receipts.length + " 条</span></div>";
                  if (!receipts.length) return (compact ? "" : head) + banner("暂无派单回执");
                  const statuses = new Map([["dispatched", "已派单"], ["running", "运行中"], ["done", "完成"], ["failed", "失败"]]);
                  // glyph 家族（v3 事件 glyph 语言）：▶ 派单 / ● 运行 / ✓ 完成 / ⚠ 失败；
                  // 色随 .activity-* 父类走五色词表（见 CSS 块注释）
                  const glyphs = new Map([["dispatched", "▶"], ["running", "●"], ["done", "✓"], ["failed", "⚠"]]);
                  // 源轴=引擎（entry.engine 缺省回会话引擎，再缺省 claude——与派单解析链缺省一致）
                  const engineOf = (entry) => entry.engine || state.sessions.get(entry.session_id)?.engine || "claude";
                  const srcCounts = new Map();
                  for (const r of receipts) { const e = engineOf(r); srcCounts.set(e, (srcCounts.get(e) || 0) + 1); }
                  const stCounts = new Map();
                  for (const r of receipts) stCounts.set(r.status, (stCounts.get(r.status) || 0) + 1);
                  const chip = (axis, key, label, n, on) => '<button type="button" class="fchip' + (on ? " on" : "") + '" data-feed-' + axis + '="' + escape(key) + '">' + escape(label) + " <b>" + n + "</b></button>";
                  // 防御：已选源在本组回执中不存在（换组后引擎集变化）→ 视同 all，不空转
                  const srcLive = state.feedSrc === "all" || srcCounts.has(state.feedSrc);
                  const chips = compact ? "" :
                    '<div class="feed-chips" role="group" aria-label="活动类型筛选"><span class="feed-axis">类型</span>'
                    + [["all", "全部", receipts.length], ["dispatched", "已派单", 0], ["running", "运行中", 0], ["done", "完成", 0], ["failed", "失败", 0]]
                      .map(([key, label]) => [key, label, key === "all" ? receipts.length : (stCounts.get(key) || 0)])
                      .filter(([key, , n]) => key === "all" || n)
                      .map(([key, label, n]) => chip("chip", key, label, n, state.feedFilter === key))
                      .join("")
                    + "</div>"
                    + '<div class="feed-chips" role="group" aria-label="活动来源筛选"><span class="feed-axis">源</span>'
                    + [["all", "全部源", receipts.length], ...[...srcCounts.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => [e, (engines.get(e)?.[0] || e), n])]
                      .filter(([key, , n]) => key === "all" || n)
                      .map(([key, label, n]) => chip("src", key, label, n, state.feedSrc === key || (key === "all" && !srcLive)))
                      .join("")
                    + "</div>";
                  const ordered = receipts.slice()
                    .filter((entry) => (state.feedFilter === "all" || entry.status === state.feedFilter) && (!srcLive || state.feedSrc === "all" || engineOf(entry) === state.feedSrc))
                    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
                  const rows = ordered.map((entry) => {
                    const timestamp = Number(entry.ts);
                    const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : null;
                    const validDate = date && Number.isFinite(date.getTime());
                    const time = validDate ? String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") : "时间未知";
                    const session = state.sessions.get(entry.session_id);
                    const note = String(entry.receipt || "").trim();
                    // v3 轻行正文：状态词（五色）+ 目标（承接人/会话）+ 收口回执（终态才有，
                    // 附注灰字）；tier/引擎徽章/来源徽章随卡片墙语汇退役（v3 .fi 无徽章位）
                    // W-DISPVIS B4：注入/消费两态小点（consumed 布尔由 relay 侧按同 id 收敛
                    // 末行拼好——queued/dispatched/running 停留=已注入未消费=灰点（running 是
                    // 承接成功，消息可能仍在注入队列/换流窗口）；done/failed 收口=已消费=绿点。
                    // 旧 relay 无此字段=灰点零副作用）
                    const consumeDot = entry.status === "dispatched" || entry.status === "queued" || entry.status === "running"
                      ? '<i class="act-consume' + (entry.consumed === true ? " consumed" : "") + '" title="' + (entry.consumed === true ? "已消费（worker 已真实吃下）" : "已注入（等待 worker 消费）") + '" aria-hidden="true"></i>'
                      : "";
                    // #G5 失败分类学：failed 行带 failure_reason 中文 chip（relay appendDispatch
                    // 咽喉自动分类）+ retry_of 自动重试标识（瞬态类 30s 一次）
                    const FAIL_ZH = new Map([["network_error", "网络错误"], ["timeout", "超时"], ["tool_crash", "工具崩溃"], ["model_overload", "模型过载"], ["logic_error", "逻辑错误"], ["cancelled", "已取消"]]);
                    const failChip = entry.status === "failed" && entry.failure_reason
                      ? ' <span class="act-freason" title="失败分类（#G5 失败分类学）">' + escape(FAIL_ZH.get(entry.failure_reason) || entry.failure_reason) + (entry.retry_of ? " · 自动重试" : "") + "</span>"
                      : "";
                    // W-CMDIMPL ①（#216）：终态条目带「收割检查」小钮——机器闸结果卡入口
                    //（§1.3：只读不执行，squash 永远 PM 在终端亲手跑）
                    const harvestBtn = !compact && (entry.status === "done" || entry.status === "failed") && entry.id
                      ? ' <span class="tag action" role="button" tabindex="0" data-harvest-check="' + escape(entry.id) + '" title="机器闸检查（只读）：回执/分支账/收口建议">收割检查</span>'
                      : "";
                    return '<div class="activity-row activity-' + escape(entry.status || "") + '"><time' + (validDate ? ' datetime="' + date.toISOString() + '" title="' + escape(date.toLocaleString()) + '"' : "") + ">" + time + '</time><i class="act-glyph" aria-hidden="true">' + (glyphs.get(entry.status) || "·") + '</i><span>' + consumeDot + '<b class="act-st">' + escape(statuses.get(entry.status) || entry.status || "状态未知") + "</b> " + escape(entry.target || session?.title || entry.session_id || "未知目标") + failChip + (note ? ' <span class="act-note">· ' + escape(note) + "</span>" : "") + harvestBtn + "</span></div>";
                  }).join("");
                  return '<div class="team-activity">' + (compact ? "" : head) + harvestResultMarkup() + chips + (rows || banner("当前筛选无条目")) + "</div>";
                }
                // ---------- W-CMDIMPL ①（#216）收割检查结果卡（§1.3 两段呈现）----------
                // 上半「机器闸 N 项」逐条 ✓/✗（warning 黄）；下半「需你判断（不自动化）」
                // 固定四项（SSOT 内核）；squash_plan 逐行「复制收口命令」（复制而非执行）。
                function harvestResultMarkup() {
                  const h = state.harvest;
                  if (!h) return "";
                  const body = h.loading
                    ? banner("检查中…")
                    : h.error
                      ? banner("检查失败：" + h.error)
                      : (() => {
                          const r = h.result || {};
                          const rows = (r.checks || []).map((c) => {
                            const mark = c.pass ? "✓" : c.severity === "warning" ? "△" : "✗";
                            const cls = c.pass ? "done" : c.severity === "warning" ? "waiting" : "failed";
                            return '<div class="activity-row activity-' + cls + '"><i class="act-glyph" aria-hidden="true">' + mark + '</i><span><b class="act-st">' + escape(({ receipt: "回执", sections: "必需节", tail: "结果摘要", commits: "新提交", dirty: "未提交改动", acceptance: "验收单" })[c.gate] || c.gate) + "</b> " + escape(c.detail || "") + ((c.log && c.log.length) ? '<span class="act-note"><br>' + c.log.map((l) => escape(l)).join("<br>") + "</span>" : "") + "</span></div>";
                          }).join("");
                          const fails = Number(r.fails) || 0;
                          const stages = (r.stages || []);
                          return '<div class="inspector-block"><div class="inspector-title"><span>收割检查 · ' + escape(String(r.dispatch_id || h.id || "").slice(0, 8)) + '</span><span class="tag ' + (fails ? "action" : "done") + '">' + (fails ? "机器闸 " + fails + " 项待处置" : "机器闸全绿") + '</span><span class="tag" role="button" tabindex="0" data-harvest-close title="收起">收起</span></div>'
                            + '<div class="inspector-copy"><b>机器闸 · ' + (r.checks || []).length + ' 项</b></div>' + rows
                            + (stages.length ? '<div class="inspector-copy"><b>阶段推进</b>：' + stages.map((st) => escape(st.stage + (st.detail ? "（" + st.detail + "）" : ""))).join(" → ") + "</div>" : "")
                            + '<div class="inspector-copy"><b>需你判断（不自动化）</b>：diff 抽查 ／ 自测证据 ／ 真机分级 ／ 是否收口合并</div>'
                            + '<div class="inspector-copy"><b>收口命令（复制后在终端亲手跑）</b></div>'
                            + (r.squash_plan || []).map((cmd, i) => '<div class="activity-row"><i class="act-glyph" aria-hidden="true">' + (i + 1) + '</i><span class="harvest-cmd"><code>' + escape(cmd) + '</code> <span class="tag action" role="button" tabindex="0" data-harvest-copy="' + escape(cmd) + '" title="复制到剪贴板">复制收口命令</span></span></div>').join("")
                            + "</div>";
                        })();
                  return '<div class="harvest-result">' + body + "</div>";
                }
                async function runHarvestCheck(id) {
                  if (!id || !state.command || !state.online) { feedback("检查不可用（命令通道未就绪）"); return; }
                  state.harvest = { id, loading: true };
                  render();
                  try {
                    const ack = await state.command("COMMAND_ORG_ACTION", { action: "harvest-check", dispatch_id: id });
                    const ok = ack && ack.ok === true;
                    if (state.harvest && state.harvest.id === id) {
                      state.harvest = ok ? { id, result: ack.data } : { id, error: String((ack && ack.error) || "未知错误") };
                    }
                  } catch (e) {
                    if (state.harvest && state.harvest.id === id) state.harvest = { id, error: String((e && e.message) || e) };
                  }
                  render();
                }
                // ---------- W-EXPP2 经验库 pane（团队域第五 tab；relay experience 域 P2 端面）----------
                // 数据源：SNAPSHOT.experience（覆盖式锚定）+ EXPERIENCE_UPDATED 帧（帧双载
                // 恒带 entries 全量，覆盖式消费——团队域对组织数据一贯吃全量，B3 口径）。
                // 操作=退役/恢复（两步武装确认）/补申报改归组（行内表单，D1-6 组合动作走
                // COMMAND_ORG_ACTION {action:"exp-regroup"}）。总开关关=整 pane 置灰说明。
                const EXP_KINDS = new Map([["pitfall", ["坑", "danger"]], ["practice", ["法", "done"]], ["preference", ["好", "info"]], ["fact", ["实", ""]]]);
                function updateExperiences(items) {
                  state.experiences = Array.isArray(items) ? entities(items).filter((e) => e && typeof e.id === "string" && typeof e.text === "string") : null;
                }
                function expProjectName(anchor) {
                  const norm = (v) => String(v || "").replace(/[\\/]/g, "/").replace(/\/+$/, "");
                  const hit = (state.projects ?? []).find((p) => norm(p.anchor_dir) === norm(anchor));
                  if (hit) return hit.name || hit.id;
                  return norm(anchor).split("/").filter(Boolean).pop() || "全局";
                }
                function expFmtTime(ts) {
                  const d = new Date(Number(ts) || 0);
                  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "—";
                  const p = (n) => String(n).padStart(2, "0");
                  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
                }
                function expFiltered() {
                  return (state.experiences ?? []).filter((e) => {
                    if (state.expFilter.status === "active" && e.status !== "active") return false;
                    if (state.expFilter.status === "retired" && e.status !== "retired") return false;
                    if (state.expFilter.scope === "global" && e.project_scope !== "global") return false;
                    if (state.expFilter.scope !== "all" && state.expFilter.scope !== "global" && String(e.project_scope || "").replace(/\/+$/, "") !== String(state.expFilter.scope).replace(/\/+$/, "")) return false;
                    return true;
                  }).sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));
                }
                function expCanOp() {
                  return Boolean(state.command && state.online && !state.unsupported.has("COMMAND_ORG_ACTION") && state.experienceEnabled !== false);
                }
                function expRow(e) {
                  const kind = EXP_KINDS.get(e.kind) || [e.kind, ""];
                  const armed = state.expArm === e.id;
                  const flight = state.expFlights.has(e.id);
                  const active = e.status === "active";
                  const formOpen = state.expForm === e.id;
                  const anchors = (state.projects ?? []).map((p) => '<option value="' + escape(p.anchor_dir || "") + '"' + (p.anchor_dir === e.project_scope ? " selected" : "") + ">" + escape(p.name || p.id) + "</option>").join("");
                  const merged = Array.isArray(e.merged_from) && e.merged_from.length ? '<span class="exp-badge" title="收编自 ' + escape(e.merged_from.join("、")) + '">并 ' + e.merged_from.length + "</span>" : "";
                  return '<div class="task-card exp-row" data-exp-id="' + escape(e.id) + '">' +
                    '<div class="inspector-title"><strong title="' + escape(e.id) + '">' + escape(e.text) + '</strong><span class="tag ' + kind[1] + '">' + escape(kind[0]) + "</span></div>" +
                    "<p>" + '<span class="exp-badge">' + escape(e.role_scope === "any" ? "通用" : e.role_scope || "any") + "</span>" +
                    '<span class="exp-badge">' + escape(e.project_scope === "global" ? "全局" : expProjectName(e.project_scope)) + "</span>" +
                    '<span class="exp-badge">用 ' + (Number(e.use_count) || 0) + " 次</span>" +
                    '<span class="exp-badge">' + expFmtTime(e.last_used_at || e.created_at) + "</span>" + merged +
                    '<span class="tag ' + (active ? "done" : "faint") + '">' + (active ? "在役" : "已退役") + "</span></p>" +
                    (expCanOp() ? '<div class="identity-cluster">' + (active
                      ? '<button type="button" class="danger-btn" data-exp-retire="' + escape(e.id) + '"' + (flight ? " disabled" : "") + ">" + (armed ? "确认退役？" : "退役") + "</button>"
                      : '<button type="button" class="secondary-btn" data-exp-restore="' + escape(e.id) + '"' + (flight ? " disabled" : "") + ">" + (armed ? "确认恢复？" : "恢复") + "</button>") +
                      '<button type="button" class="secondary-btn" data-exp-regroup="' + escape(e.id) + '">' + (formOpen ? "收起" : "补申报/改归组") + "</button></div>" : "") +
                    (formOpen ? '<div class="exp-form">' +
                      '<label>角色轴 <input data-exp-form-role value="' + escape(e.role_scope || "any") + '" list="exp-role-list" placeholder="any=跨角色" aria-label="角色轴"></label>' +
                      '<label>项目轴 <select data-exp-form-project aria-label="项目轴"><option value="global"' + (e.project_scope === "global" ? " selected" : "") + ">全局</option>" + anchors + "</select></label>" +
                      '<button type="button" class="primary-btn" data-exp-form-go="' + escape(e.id) + '"' + (flight ? " disabled" : "") + ">提交改归组</button>" +
                      '<span class="exp-hint">正文与类型继承原条；新条入库、旧条退役（可恢复）。</span></div>' : "") +
                    "</div>";
                }
                function experienceMarkup() {
                  if (state.experienceEnabled === false) return banner("经验库总开关已关闭（relay 设置）——注入与整理均已停，此面板暂不可用。");
                  if (state.experiences === null) return banner(state.online ? "此 relay 无经验库数据（旧版本 relay 或经验域未随快照下发）" : "正在连接…（经验库数据待同步）");
                  const head = '<div class="pane-summary">团队经验 <span class="faint">在役 ' + state.experiences.filter((e) => e.status === "active").length + " · 共 " + state.experiences.length + " 条</span></div>" +
                    '<div class="exp-filters">' +
                    '<select class="exp-filter" data-exp-filter-scope aria-label="范围筛选"><option value="all"' + (state.expFilter.scope === "all" ? " selected" : "") + ">全部范围</option>" +
                    '<option value="global"' + (state.expFilter.scope === "global" ? " selected" : "") + ">全局</option>" +
                    (state.projects ?? []).map((p) => '<option value="' + escape(p.anchor_dir || "") + '"' + (state.expFilter.scope === p.anchor_dir ? " selected" : "") + ">" + escape(p.name || p.id) + "</option>").join("") + "</select>" +
                    // 追加⑫：状态轴 chips 化（原生 select 观感退役；范围轴动态项目多保留胶囊 select）
                    '<div class="exp-chips" role="group" aria-label="状态筛选">' +
                    ["active", "retired", "all"].map((k) => '<button type="button" class="exp-chip' + (state.expFilter.status === k ? " on" : "") + '" data-exp-chip-status="' + k + '">' + ({ active: "在役", retired: "已退役", all: "全部" })[k] + "</button>").join("") + "</div>" +
                    // W-POLISH #96 手动整理：立即跑一轮机械档 GC（relay 定时档周跑/阈值触发之外
                    // 的人工入口）；结果一行反馈（清了几条，均可恢复）。飞行中禁用防连点
                    (expCanOp() ? '<button type="button" class="secondary-btn exp-gc-btn" data-exp-gc' + (state.expGcFlight ? " disabled" : "") + ">整理</button>" : "") +
                    '<datalist id="exp-role-list"><option value="any"></option><option value="worker"></option><option value="pm"></option><option value="reviewer"></option><option value="qa"></option></datalist></div>' +
                    (state.expGcNote ? '<div class="readonly-banner exp-gc-note">' + state.expGcNote + "</div>" : "");
                  if (!state.experiences.length) return head + banner("经验库为空——worker 回执「经验：<一句话>（#kind）」申报入库，或 CLI org exp append。");
                  const list = expFiltered();
                  if (!list.length) return head + banner("当前筛选无条目");
                  return head + list.map(expRow).join("");
                }
                function expOp(type, id) { // 退役/恢复：两步武装确认（不裸奔），飞行中去重
                  if (!expCanOp() || state.expFlights.has(id)) return;
                  if (state.expArm !== id) {
                    state.expArm = id;
                    clearTimeout(state.expArmTimer);
                    state.expArmTimer = setTimeout(() => { state.expArm = null; render(); }, 4000);
                    render();
                    return;
                  }
                  clearTimeout(state.expArmTimer);
                  state.expArm = null;
                  state.expFlights.add(id);
                  render();
                  state.command("COMMAND_ORG_ACTION", { action: type, id }).then((ack) => {
                    state.expFlights.delete(id);
                    const ok = ack && ack.ok === true && !(typeof ack.error === "string" && ack.error.trim());
                    if (!ok && /unknown.?command|unsupported|不支持/i.test(String(ack && ack.error))) state.unsupported.add("COMMAND_ORG_ACTION");
                    toast(ok ? (type === "exp-retire" ? "已退役（可恢复）" : "已恢复") : "操作失败：" + String((ack && ack.error) || "未收到回执"));
                    render(); // 权威收敛走 EXPERIENCE_UPDATED 帧，此处只清飞行态
                  }).catch(() => { state.expFlights.delete(id); render(); });
                }
                function expRegroupSubmit(id, role, project) { // D1-6 组合动作：relay 单漏斗 append+retire+merged_from
                  if (!expCanOp() || state.expFlights.has(id)) return;
                  state.expFlights.add(id);
                  render();
                  state.command("COMMAND_ORG_ACTION", { action: "exp-regroup", old_id: id, role_scope: role || undefined, project_scope: project || undefined }).then((ack) => {
                    state.expFlights.delete(id);
                    const ok = ack && ack.ok === true;
                    if (ok) { state.expForm = null; toast("已改归组：新条入库、旧条退役（可恢复）"); }
                    else toast("改归组失败：" + String((ack && ack.error) || "未收到回执"));
                    render();
                  }).catch(() => { state.expFlights.delete(id); render(); });
                }
                // ---------- W-RULES2 团队铁律 pane（团队域第六 tab；relay rules 域 P2 端面）----------
                // 数据源：SNAPSHOT.rules（覆盖式锚定）+ RULES_UPDATED 帧（帧双载恒带 entries
                // 全量，覆盖式消费——B3 吃全量口径）。操作=新增/退役（两步武装）/替代（旧指新，
                // 行内表单）+ markdown 批量导入（预览标红→确认批量直写）。写面 direct:true=
                // 面板用户主权面（org CLI direct 同信任级，表单/导入预览即用户审定）。P1 无
                // 恢复/删除语义（retired/superseded 终态 append-only）——「恢复」正解=重立新条。
                // leader 受众条目管理面全量可见，以徽章+图例说明注入面（置灰说明口径）。
                const RULE_ROLE_VOCAB = ["worker", "pm", "team_pm", "review", "review_pm"]; // BIZ_ROLE_VOCAB 镜像（fail-closed 词表）
                const RULES_IMPORT_TEMPLATE = ["# 团队铁律批量导入", "## 全员", "- （示例）交付前必须完成自测，缺项在回执写明", "## 角色：worker", "- （示例）动工前先认领任务单，不重复开工", "## Leader", "- （示例）派单必须附带验收点"].join("\n");
                function updateRules(items) {
                  state.rules = Array.isArray(items) ? entities(items).filter((e) => e && typeof e.id === "string" && typeof e.text === "string") : null;
                }
                function ruleAudLabel(aud) {
                  if (aud === "all") return "全员";
                  if (aud === "leader") return "Leader";
                  if (typeof aud === "string" && aud.startsWith("role:")) return "角色:" + aud.slice(5);
                  return aud || "?";
                }
                function ruleScopeName(scope) {
                  if (scope === "team") return "团队";
                  if (typeof scope === "string" && scope.startsWith("project:")) return expProjectName(scope.slice(8));
                  return scope || "?";
                }
                function ruleNormKey(text) { // team-rules.ts normRuleKey 客户端镜像（预览去重；权威在 relay store）
                  return String(text || "").trim().toLowerCase().normalize("NFKC")
                    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{L}\p{N}]/gu, "")
                    .slice(0, 64);
                }
                function parseRulesMarkdown(md) { // B 路格式宽容解析（旧壳同款）：任意级标题认节/列表符剥除/裸行也收
                  const out = [];
                  let aud = null;
                  for (const rawLine of String(md || "").split(/\r?\n/)) {
                    const line = rawLine.trim();
                    if (!line) continue;
                    const h = line.match(/^#{1,6}\s+(.+)$/);
                    if (h) {
                      const t = h[1].trim();
                      const roleM = t.match(/^角色[:：]\s*(.+)$/);
                      if (/^全员$/.test(t)) aud = "all";
                      else if (/^leader$/i.test(t)) aud = "leader";
                      else if (roleM) aud = "role:" + roleM[1].trim().toLowerCase();
                      else aud = null;
                      continue;
                    }
                    if (!aud) continue;
                    const text = line.replace(/^[-*•]\s*/, "").replace(/^\d+[.、)）]\s*/, "").trim();
                    if (text) out.push({ text, audience: aud });
                  }
                  return out;
                }
                function rulePreviewFlags(text, audience, scope) { // 导入预览标红（客户端预检；relay store 闸仍权威）
                  const flags = [];
                  if (text.length > 120) flags.push("超 120 字（" + text.length + "）——精简或拆条");
                  if (audience.startsWith("role:")) {
                    const role = audience.slice(5);
                    if (!RULE_ROLE_VOCAB.includes(role)) flags.push("角色词表外（" + role + "）——可用：" + RULE_ROLE_VOCAB.join("/"));
                  }
                  const all = state.rules ?? [];
                  const key = ruleNormKey(text);
                  const dup = all.find((e) => e.status === "active" && e.scope === scope && e.audience === audience && ruleNormKey(e.text) === key);
                  if (dup) flags.push("与在役规则重复（" + dup.id + "）——改规则用「替代」，或先退役旧条");
                  const bucket = all.filter((e) => e.status === "active" && e.scope === scope && (audience === "leader" ? false : e.audience === audience)).length;
                  const cap = scope === "team" ? (audience.startsWith("role:") ? 4 : 6) : 4;
                  if (!dup && bucket >= cap) flags.push("该范围在役规则已满 " + bucket + "/" + cap + " 条——先退役/替代精简再导入");
                  return flags;
                }
                function rulesCanOp() {
                  return Boolean(state.command && state.online && !state.unsupported.has("COMMAND_ORG_ACTION") && state.rulesEnabled !== false);
                }
                function rulesFiltered() {
                  return (state.rules ?? []).filter((e) => {
                    if (state.rulesFilter.status === "active" && e.status !== "active") return false;
                    if (state.rulesFilter.status === "archived" && e.status === "active") return false;
                    if (state.rulesFilter.scope === "team" && e.scope !== "team") return false;
                    if (state.rulesFilter.scope !== "all" && state.rulesFilter.scope !== "team" && String(e.scope || "").replace(/\/+$/, "") !== String(state.rulesFilter.scope).replace(/\/+$/, "")) return false;
                    return true;
                  }).sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0)); // active 按 created_at 升序（拍板口径）
                }
                function ruleRow(e) {
                  const armed = state.rulesArm === e.id;
                  const flight = state.rulesFlights.has(e.id);
                  const active = e.status === "active";
                  const formOpen = state.rulesForm === e.id;
                  const sup = e.status === "superseded" && e.superseded_by ? '<span class="exp-badge" title="替代链">→ ' + escape(e.superseded_by) + "</span>" : "";
                  return '<div class="task-card exp-row rule-row' + (active ? "" : " rd-off") + '" data-rule-id="' + escape(e.id) + '">' +
                    '<div class="inspector-title"><strong title="' + escape(e.id) + '">' + escape(e.text) + '</strong><span class="tag ' + (active ? "done" : "faint") + '">' + (active ? "在役" : e.status === "retired" ? "已退役" : "已替代") + "</span></div>" +
                    "<p>" + '<span class="exp-badge' + (e.audience === "leader" ? ' rd-aud-leader" title="仅注入 Leader 会话——worker 派单不可见' : "") + '">' + escape(ruleAudLabel(e.audience)) + "</span>" +
                    '<span class="exp-badge">' + escape(ruleScopeName(e.scope)) + "</span>" +
                    '<span class="exp-badge">' + expFmtTime(e.created_at) + "</span>" + sup + "</p>" +
                    (rulesCanOp() && active ? '<div class="identity-cluster">' +
                      '<button type="button" class="danger-btn" data-rule-retire="' + escape(e.id) + '"' + (flight ? " disabled" : "") + ">" + (armed ? "确认退役？" : "退役") + "</button>" +
                      '<button type="button" class="secondary-btn" data-rule-supersede="' + escape(e.id) + '">' + (formOpen ? "收起" : "替代（旧指新）") + "</button></div>" : "") +
                    (rulesCanOp() && active && formOpen ? '<div class="exp-form rule-form">' +
                      '<textarea data-rule-sp-text rows="2" placeholder="新规则文本（受众/范围缺省继承旧条，≤120 字）"></textarea>' +
                      '<span class="rule-count">0/120</span>' +
                      '<button type="button" class="primary-btn" data-rule-sp-go="' + escape(e.id) + '"' + (flight ? " disabled" : "") + ">提交替代</button>" +
                      '<span class="exp-hint">替代=新条入库 + 旧条停注并指向新条（替代链）。</span></div>' : "") +
                    (!active ? '<span class="exp-hint">终态条目（append-only 审计）——需恢复请以同义文本重立新条。</span>' : "") +
                    "</div>";
                }
                function rulesMarkup() {
                  if (state.rulesEnabled === false) return banner("团队规则总开关已关闭（relay 设置）——注入已停，此面板暂不可用。");
                  if (state.rules === null) return banner(state.online ? "此 relay 无规则库数据（旧版本 relay 或规则域未随快照下发）" : "正在连接…（团队铁律数据待同步）");
                  const head = '<div class="rule-toolbar">' +
                    '<button type="button" class="secondary-btn" data-rules-add-toggle' + (rulesCanOp() ? "" : " disabled") + ">＋ 新增</button>" +
                    '<button type="button" class="secondary-btn" data-rules-imp-toggle' + (rulesCanOp() ? "" : " disabled") + ">⇪ 批量导入</button>" +
                    '<span class="exp-badge">在役 ' + state.rules.filter((e) => e.status === "active").length + " · 团队全员 " + state.rules.filter((e) => e.status === "active" && e.scope === "team" && e.audience === "all").length + "/6 · 共 " + state.rules.length + " 条</span></div>";
                  const addForm = !state.rulesAddOpen ? "" : '<div class="exp-form rule-form">' +
                    '<textarea data-rules-add-text rows="2" placeholder="一句话红线（祈使句，≤120 字）"></textarea>' +
                    '<span class="rule-count">0/120</span>' +
                    '<label>受众 <select data-rules-add-aud><option value="all">全员</option><option value="leader">Leader</option>' +
                    RULE_ROLE_VOCAB.map((r) => '<option value="role:' + r + '">角色:' + r + "</option>").join("") + "</select></label>" +
                    '<label>范围 <select data-rules-add-scope><option value="team">团队</option>' +
                    (state.projects ?? []).map((p) => '<option value="project:' + escape(p.anchor_dir || "") + '">项目:' + escape(p.name || p.id) + "</option>").join("") + "</select></label>" +
                    '<button type="button" class="primary-btn" data-rules-add-go>入库</button>' +
                    '<span class="exp-hint">面板入库=用户直写（org CLI 同信任级）；同主题在役规则会拒收，改规则请用「替代」。</span></div>';
                  const impForm = !state.rulesImpOpen ? "" : '<div class="exp-form rule-form">' +
                    '<textarea data-rules-imp-text rows="6" placeholder="粘贴 markdown：&#10;## 全员&#10;- 条目…&#10;## 角色：worker&#10;- 条目…&#10;## Leader&#10;- 条目…"></textarea>' +
                    '<button type="button" class="primary-btn" data-rules-imp-parse>生成预览</button>' +
                    '<button type="button" class="secondary-btn" data-rules-imp-tpl>复制模板</button>' +
                    '<span class="exp-hint">格式：## 全员 / ## 角色：&lt;name&gt; / ## Leader 分节 + 列表项；导入均为团队范围，逐条过数值闸（超限/重复标红）。</span>' +
                    (state.rulesImpPreview ? (
                      state.rulesImpPreview.length
                        ? '<div class="rule-preview">' + state.rulesImpPreview.map((it, i) =>
                            '<div class="rule-prow' + (it.flags.length ? " rd-pbad" : "") + '">' +
                            '<span class="rule-pn">' + (i + 1) + "</span>" +
                            '<span class="rule-pt">' + escape(it.text) + "</span>" +
                            '<span class="exp-badge">' + escape(ruleAudLabel(it.audience)) + "</span>" +
                            (it.flags.length ? '<span class="rule-pflag">' + it.flags.map((f) => escape(f)).join("；") + "</span>" : "") +
                            "</div>").join("") + "</div>" +
                          '<button type="button" class="primary-btn" data-rules-imp-go>确认导入 ' + state.rulesImpPreview.filter((it) => !it.flags.length).length + "/" + state.rulesImpPreview.length + " 条</button>" +
                          '<span class="exp-hint">标红条目不会提交；导入走逐条数值闸，失败项逐条报出。</span>'
                        : banner("未解析出任何条目——检查分节头（## 全员 / ## 角色：x / ## Leader）与条目行。")
                    ) : "") + "</div>";
                  if (!state.rules.length) return head + addForm + impForm + banner("规则库为空——新增一条红线，或用「批量导入」粘贴 markdown。");
                  const list = rulesFiltered();
                  const hasLeader = state.rules.some((e) => e.status === "active" && e.audience === "leader");
                  const filters = '<div class="exp-filters">' +
                    // 追加⑫：铁律状态轴同款 chips 化（范围轴保留胶囊 select）
                    '<div class="exp-chips" role="group" aria-label="状态筛选">' +
                    ["active", "archived", "all"].map((k) => '<button type="button" class="exp-chip' + (state.rulesFilter.status === k ? " on" : "") + '" data-rules-chip-status="' + k + '">' + ({ active: "在役", archived: "归档", all: "全部" })[k] + "</button>").join("") + "</div>" +
                    '<select class="exp-filter" data-rules-filter-scope aria-label="范围筛选"><option value="all"' + (state.rulesFilter.scope === "all" ? " selected" : "") + ">全部范围</option>" +
                    '<option value="team"' + (state.rulesFilter.scope === "team" ? " selected" : "") + ">团队</option>" +
                    (state.projects ?? []).map((p) => {
                      const anchor = "project:" + String(p.anchor_dir || "").replace(/\/+$/, "");
                      return '<option value="' + escape(anchor) + '"' + (state.rulesFilter.scope === anchor ? " selected" : "") + ">项目:" + escape(p.name || p.id) + "</option>";
                    }).join("") + "</select></div>";
                  return head + addForm + impForm + filters +
                    (hasLeader ? banner("Leader 徽章条目仅注入 Leader 会话，worker 派单不可见（管理面全量可见不隐藏）。") : "") +
                    (list.length ? list.map(ruleRow).join("") : banner("当前筛选无条目"));
                }
                function ruleOp(type, id) { // 退役：两步武装确认（经验库 expOp 同款）+ 飞行去重
                  if (!rulesCanOp() || state.rulesFlights.has(id)) return;
                  if (state.rulesArm !== id) {
                    state.rulesArm = id;
                    clearTimeout(state.rulesArmTimer);
                    state.rulesArmTimer = setTimeout(() => { state.rulesArm = null; render(); }, 4000);
                    render();
                    return;
                  }
                  clearTimeout(state.rulesArmTimer);
                  state.rulesArm = null;
                  state.rulesFlights.add(id);
                  render();
                  state.command("COMMAND_ORG_ACTION", { action: type, id }).then((ack) => {
                    state.rulesFlights.delete(id);
                    const ok = ack && ack.ok === true && !(typeof ack.error === "string" && ack.error.trim());
                    if (!ok && /unknown.?command|unsupported|不支持/i.test(String(ack && ack.error))) state.unsupported.add("COMMAND_ORG_ACTION");
                    toast(ok ? "已退役（终态；恢复请重立新条）" : "操作失败：" + String((ack && ack.error) || "未收到回执"));
                    render(); // 权威收敛走 RULES_UPDATED 帧，此处只清飞行态
                  }).catch(() => { state.rulesFlights.delete(id); render(); });
                }
                function ruleSupersedeSubmit(id, text) { // 替代（旧指新）：relay 单漏斗原子落两变
                  if (!rulesCanOp() || state.rulesFlights.has(id)) return;
                  if (!text) { toast("新规则文本必填"); return; }
                  state.rulesFlights.add(id);
                  render();
                  state.command("COMMAND_ORG_ACTION", { action: "rule-supersede", id, text, created_by: "user" }).then((ack) => {
                    state.rulesFlights.delete(id);
                    const ok = ack && ack.ok === true;
                    if (!ok && /unknown.?command|unsupported|不支持/i.test(String(ack && ack.error))) state.unsupported.add("COMMAND_ORG_ACTION");
                    if (ok) { state.rulesForm = null; toast("已替代：新条入库、旧条停注指向新条"); }
                    else toast("替代失败：" + String((ack && ack.error) || "未收到回执"));
                    render();
                  }).catch(() => { state.rulesFlights.delete(id); render(); });
                }
                function ruleAddSubmit(text, audience, scope) { // 新增：面板用户直写（direct）
                  if (!rulesCanOp()) return;
                  if (!text) { toast("规则文本必填"); return; }
                  if (text.length > 120) { toast("超 120 字（" + text.length + "）——精简或拆条"); return; }
                  const fid = "add";
                  if (state.rulesFlights.has(fid)) return;
                  state.rulesFlights.add(fid);
                  render();
                  state.command("COMMAND_ORG_ACTION", { action: "rule-append", text, audience, scope, direct: true, created_by: "user" }).then((ack) => {
                    state.rulesFlights.delete(fid);
                    const ok = ack && ack.ok === true;
                    if (!ok && /unknown.?command|unsupported|不支持/i.test(String(ack && ack.error))) state.unsupported.add("COMMAND_ORG_ACTION");
                    if (ok) { state.rulesAddOpen = false; toast("规则已入库"); }
                    else toast("入库失败：" + String((ack && ack.error) || "未收到回执"));
                    render();
                  }).catch(() => { state.rulesFlights.delete(fid); render(); });
                }
                function rulesImportParse() { // 生成预览：逐条客户端预检标红（服务端闸仍权威）
                  const pane = query("[data-rules-imp-text]");
                  state.rulesImpText = pane ? pane.value : "";
                  state.rulesImpPreview = parseRulesMarkdown(state.rulesImpText).map((it) => ({ ...it, flags: rulePreviewFlags(it.text, it.audience, "team") }));
                  render();
                }
                function rulesImportConfirm() { // 批量导入：无旗标条目逐条 direct 入库
                  if (!rulesCanOp() || state.rulesImpFlight || !Array.isArray(state.rulesImpPreview)) return;
                  const items = state.rulesImpPreview.filter((it) => it && !it.flags.length);
                  if (!items.length) { toast("没有可导入的条目（全部标红）"); return; }
                  state.rulesImpFlight = true;
                  render();
                  let okN = 0;
                  const errs = [];
                  const run = (i) => {
                    if (i >= items.length) {
                      state.rulesImpFlight = false;
                      if (!errs.length) { state.rulesImpOpen = false; state.rulesImpPreview = null; state.rulesImpText = ""; toast("已导入 " + okN + " 条"); }
                      else toast("导入 " + okN + "/" + items.length + " 条；失败：" + errs.slice(0, 2).join("；") + (errs.length > 2 ? " 等 " + errs.length + " 项" : ""));
                      render();
                      return;
                    }
                    const it = items[i];
                    state.command("COMMAND_ORG_ACTION", { action: "rule-append", text: it.text, audience: it.audience, scope: "team", direct: true, created_by: "user" }).then((ack) => {
                      const ok = ack && ack.ok === true && !(typeof ack.error === "string" && ack.error.trim());
                      if (ok) okN += 1;
                      else errs.push("「" + (it.text.length > 16 ? it.text.slice(0, 16) + "…" : it.text) + "」：" + String((ack && ack.error) || "未收到回执"));
                      run(i + 1);
                    }).catch((e) => {
                      errs.push("「" + (it.text.length > 16 ? it.text.slice(0, 16) + "…" : it.text) + "」：" + String(e?.message || e));
                      run(i + 1);
                    });
                  };
                  run(0);
                }
                function render() {
                  if (!state.mounted) return;
                  // #282 M1 行内表单草稿守卫：经验/规则表单（expForm/rulesForm 只记目标 id 不记
                  // 草稿文本）输入中任何帧到达→整 pane 重建→草稿丢。焦点在本域可编辑元素上时
                  // 跳过本轮（下一帧重试——心跳/事件恒持续，选区/草稿存活窗口即用户输入窗口）。
                  try {
                    const ae = document.activeElement;
                    if (ae && root.contains(ae) && ae.matches && ae.matches("input, select, textarea, [contenteditable='true']")) return;
                  } catch (_) {}
                  if (!group()) state.selected = state.projects?.[0]?.id || null;
                  const project = group();
                  const count = state.confirms.length;
                  const badge = document.querySelector('[data-domain="team"] [data-team-badge]');
                  badge.textContent = String(count);
                  badge.hidden = count === 0;
                  badge.setAttribute("aria-label", "团队有 " + count + " 项需处理");
                  badge.setAttribute("title", "团队 · " + count + " 项需处理");
                  query("[data-team-count]").textContent = String(count);
                  // #282 M1b 团队列表 keyed：html 照旧拼装，解析成键序（组头 grp:N/团队卡 t:<id>）
                  // reconcile——未变卡零触碰（滚动/选中/hover/动画全保），变化单卡替换，容器不重建。
                  const projectsEl = query("[data-team-projects]");
                  const projectsHtml = state.projects?.length ? (() => {
                    // W-V8 批2 团队列表 v8 化（A 轨对照图①④）：进行中/已收团分组头 + 卡片
                    // 头像 tile + 点分多指标 meta（v8 scard 三行密度，含活跃时间）。
                    // 状态胶囊保留（UIPOLISH3 件九⑩ 用户拍板件不动）；分组只二分不改数据语义
                    const card = (item) => {
                      const pending = state.confirms.filter((confirm) => confirm.payload?.gid === item.id).length;
                      const mins = Math.max(0, Math.round((Date.now() - (item.updated_at || 0)) / 60000));
                      const activeAgo = mins <= 0 ? "刚刚活跃" : mins < 60 ? mins + " 分钟前活跃" : mins < 1440 ? Math.round(mins / 60) + " 小时前活跃" : Math.round(mins / 1440) + " 天前活跃";
                      return '<div role="button" tabindex="0" class="queue-card' + (state.selected === item.id ? " selected" : "") + '" data-team-project="' + escape(item.id) + '" aria-pressed="' + String(state.selected === item.id) + '"><div class="row"><span class="team-ava" aria-hidden="true">' + escape(String(item.name || item.id).trim().slice(0, 1) || "团") + '</span><strong>' + escape(item.name || item.id) + '</strong><span class="team-state-pill" data-state="' + escape(item.status || "") + '" title="团队状态：' + escape(groupStatuses.get(item.status) || item.status || "未知") + '"><i></i>' + escape(groupStatuses.get(item.status) || item.status || "未知") + '</span></div>'
                        + '<p class="team-meta" title="编制 ' + members(item).length + ' 席 · 待确认 ' + pending + ' 项"><svg class="icon-inline" aria-hidden="true"><use href="#icon-users"></use></svg> ' + members(item).length + ' 席 · 待确认 ' + pending + (item.status === "archived" ? "" : ' · <span class="team-ago">' + activeAgo + '</span>') + '</p>'
                        + '<div class="identity-cluster">' + teamSrcCaps(item) + "</div></div>";
                    };
                    const live = state.projects.filter((p) => p.status !== "archived");
                    const archived = state.projects.filter((p) => p.status === "archived");
                    const grp = (label, n) => '<div class="team-grp"><svg class="icon-inline" aria-hidden="true"><use href="#icon-chev-dn"></use></svg>' + label + ' <span class="team-grp-n">' + n + "</span></div>";
                    let html = "";
                    // #236 C（口径纠偏）：原「进行中 N」被用户读成「N 个成员在跑」（1023 实锤
                    // ——组卡统计误解源头）；N 实为非归档团队数，措辞点明
                    if (live.length) html += grp("进行中团队", live.length) + live.map(card).join("");
                    if (archived.length) html += grp("已收团", archived.length) + archived.map(card).join("");
                    return html;
                  })() : banner(projectsEmpty());
                  const rkTeam = window.__ccDeck005Reconcile;
                  if (rkTeam && state.projects?.length) {
                    const t = document.createElement("template");
                    t.innerHTML = projectsHtml;
                    const desired = [];
                    let gN = 0;
                    for (const n of t.content.children) {
                      const tid = n.getAttribute("data-team-project");
                      desired.push([tid ? "t:" + tid : "grp:" + gN++, n.outerHTML]);
                    }
                    rkTeam(projectsEl, desired);
                  } else projectsEl.innerHTML = projectsHtml;
                  query("[data-team-title]").textContent = project?.name || "团队";
                  // V8R head 第二行 meta（原型 dhead.row2 语言）：编制/任务卡/待确认/开团时间——
                  // 无团队选中（空态）整行隐藏；数据缺项跳过不占位
                  {
                    const meta = query("[data-team-meta]");
                    if (project) {
                      const boardTotal = state.boards.get(project.id)?.entries?.length;
                      const createdDay = Number(project.created_at) > 0 ? (() => { const d = new Date(Number(project.created_at)); const pad = (n) => String(n).padStart(2, "0"); return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); })() : "";
                      meta.innerHTML = [
                        // #236 C（编制对账·分档明示）：席数与成员卡数同源（members()=headcount
                        // 带 session_id 过滤，渲染两侧无二次过滤——19 vs 12-1 3 为网格滚动可见数
                        // 的误读面）；分档把「查无会话数据」的离线席显性化，对账不再靠数卡
                        (() => {
                          const roster = members(project);
                          const online = roster.filter((m) => state.sessions.get(m.session_id)).length;
                          return "编制 " + roster.length + " 席（会话在场 " + online + " · 离线 " + (roster.length - online) + "）";
                        })(),
                        Number.isFinite(boardTotal) ? "任务卡 " + boardTotal : "",
                        count ? "待确认 " + count + " 项" : "",
                        createdDay ? "开团 " + createdDay : "",
                      ].filter(Boolean).map((piece) => "<span>" + escape(piece) + "</span>").join('<span class="meta-sep">·</span>');
                      meta.hidden = false;
                    } else meta.hidden = true;
                  }
                  // 件十五（2026-10-11 用户拍板）：head「在办」文字标签删除——绿灯状态点已表达
                  // 活跃（与团队卡状态胶囊整合同族去重）；[data-team-status] 元素随标签退役
                  query("[data-team-status-dot]").className = "status-dot " + (project?.status === "pending" ? "waiting" : project?.status === "active" ? "done" : "");
                  // 1026 用户裁定：head 源徽标移除（列表卡 src-cap 已有源信息，head 冗余）——data-team-source 元素与填充一并退役
                  window.__ccDeck005SetWindowbarHint?.("team", project ? [tierDisplay(project.tier), window.__ccDeck005PathUi.displayPath(project.anchor_dir), members(project).length + " 个编制席位", "待确认 " + count + " 项"].filter(Boolean).join(" · ") : "确认单由用户决议，不自动执行。");
                  const memberHtml = sortRoster(members(project), project).map((m) => memberMarkup(m, project)).join("") || banner("暂无编制数据");
                  const activityHtml = activityMarkup(project);
                  const activityCompactHtml = activityMarkup(project, { compact: true });
                  query("[data-team-member-count]").textContent = String(members(project).length);
                  tSigWrite(query("[data-team-members]"), "mem:" + tSigOf(memberHtml), memberHtml); // #282 三批 M2 签名跳帧
                  tSigWrite(query("[data-team-activity]"), "act:" + tSigOf(activityCompactHtml), activityCompactHtml); // W-ACTIVITY3：右栏回执流=compact 态（v3 dispfeed 纯行形态，无头无 chips）
                  const panes = root.querySelectorAll(".workspace-body > .workspace-pane");
                  tSigWrite(panes[0], "p0", banner("团队对话请回到来源会话；此处不生成演示消息。")); // 常驻文案：签名恒定=首帧后零写
                  if (panes[1]) panes[1].classList.add("board-pane"); // 追加⑨：看板 pane flex 列布局（board flex:1 拉高的参照链）
                  // #282 三批 M2：panes[1] 原三步写（=board、+=确认卡、+=图纸区）收口为单笔终态写
                  //（终态在确认卡构建后落笔，见下方 boardFinal）；成员/经验/铁律/输出物 var 先算后签
                  const teamOutputsHtml = teamOutputsMarkup(project);
                  const expHtml = experienceMarkup();
                  const rulesHtml = rulesMarkup();
                  // V8R：成员页尾 crewfoot（原型 .crewfoot）——顺带承载五色灯词表图例（用户定版）
                  const crewFoot = '<div class="crewfoot"><span class="lamp-key"><i style="background:var(--st-working)"></i>黄闪=工作中</span><span class="lamp-key"><i style="background:var(--st-idle)"></i>绿=空闲</span><span class="lamp-key"><i style="background:var(--st-blocked)"></i>橙=阻塞</span><span class="lamp-key"><i style="background:var(--st-error)"></i>红=出错</span><span class="lamp-key"><i style="background:var(--st-closed)"></i>灰=关闭</span> · watchdog 双信号（心跳+日志） · 点卡片直开成员会话</div>';
                  tSigWrite(panes[2], "p2:" + tSigOf(memberHtml), '<div class="member-list">' + memberHtml + "</div>" + crewFoot); // #282 三批 M2
                  tSigWrite(panes[3], "p3:" + tSigOf(activityHtml), activityHtml);
                  tSigWrite(panes[4], "p4:" + tSigOf(teamOutputsHtml), teamOutputsHtml); // W-OUTTAB 团队输出物（活动后第五 tab，用户 1015 拍板独立于看板）
                  tSigWrite(panes[5], "p5:" + tSigOf(expHtml), expHtml); // W-EXPP2 经验库第六 tab
                  tSigWrite(panes[6], "p6:" + tSigOf(rulesHtml), rulesHtml); // W-RULES2 团队铁律第七 tab
                  const canDetail = Boolean(project && state.command && state.online && !state.unsupported.has("COMMAND_PROJECT_DETAIL"));
                  if (!state.confirms.some((confirm) => confirm.id === state.confirmSelected)) state.confirmSelected = state.confirms.find((confirm) => confirm.payload?.gid === project?.id)?.id || state.confirms[0]?.id || null;
                  // UIPOLISH3 件四②（2026-10-11 用户拍板）：底部常驻栏废除——决议钮下沉到每张
                  // 确认卡内联（待确认独立化，「查看并决议」中转钮随之退役：卡片本就全量展示
                  // payload）；刷新改 head 圆圈箭头小钮（data-team-refresh 属性复用，mount 委托
                  // 零改动）。feedback 反馈行走 toast（见域顶 feedback 重定义）。
                  const decisionButtons = (confirm) => {
                    const disabled = !state.command || !state.online || state.flights.has(confirm.id) || state.accepted.has(confirm.id) || state.unsupported.has("COMMAND_ORG_CONFIRM");
                    const why = !state.command || !state.online ? ' title="决议命令通道未接入或来源离线"' : state.unsupported.has("COMMAND_ORG_CONFIRM") ? ' title="当前来源不支持团队决议命令"' : "";
                    return '<div class="identity-cluster"><button type="button" class="primary-btn" data-team-decision="' + escape(confirm.id) + '" data-approve="true"' + (disabled ? " disabled" : "") + why + '>确认</button><button type="button" class="danger-btn" data-team-decision="' + escape(confirm.id) + '" data-approve="false"' + (disabled ? " disabled" : "") + why + ">否决</button></div>";
                  };
                  // UIPOLISH3 件四④：看板下方待确认区空间优化——无待确认整块不渲染（原恒渲染
                  // 「暂无待确认事项」banner 占一截），有单才出现
                  const confirmCards = count ? state.confirms.map((confirm) => {
                    const owner = state.projects?.find((item) => item.id === confirm.payload?.gid);
                    return '<div class="task-card" data-team-confirm="' + escape(confirm.id) + '"><div class="inspector-title"><strong>' + escape(confirmKinds.get(confirm.kind) || confirm.kind) + " · " + escape(confirm.title) + '</strong><span class="tag action">' + (state.accepted.has(confirm.id) ? "等待权威更新" : state.flights.has(confirm.id) ? "提交中" : "待你确认") + "</span></div><p>" + escape(confirm.reason) + (owner ? " · " + escape(owner.name || owner.id) : "") + '</p><div class="inspector-copy">' + escape(JSON.stringify(confirm.payload || {})) + "</div>" + decisionButtons(confirm) + "</div>";
                  }).join("") : "";
                  tSigWrite(query("[data-team-confirms]"), "cf:" + tSigOf(confirmCards), count ? confirmCards : banner("暂无待确认事项")); // #282 三批 M2
                  // W-DESIGNHUB（用户澄清并入）：看板挂载——系统设计图纸区。图纸匹配同项目域
                  // 口径（name/锚点分词 ∩ tags 子串双向）。输出物原第二区已迁独立「输出」tab
                  // （W-OUTTAB，用户 1015 拍板：输出物不放看板里）
                  const boardFinal = boardMarkup(project)
                    + (count ? '<div class="inspector-block"><div class="inspector-title"><span>待你确认 · ' + count + '</span></div>' + confirmCards + "</div>" : "")
                    + teamDesignSection(project);
                  tSigWrite(panes[1], "p1:" + tSigOf(boardFinal), boardFinal);
                  const headRefresh = query("[data-team-refresh]"); // 件四②：head 刷新钮禁用态随详情通道/加载中
                  if (headRefresh) headRefresh.disabled = !canDetail || Boolean(project && state.loads.get(project.id) === "loading");
                  root.dataset.teamState = state.projects === null ? "unavailable" : "snapshot";
                }
                function updateConfirms(items) {
                  state.confirms = entities(items).filter((confirm) => confirm.status === "pending");
                  for (const id of state.accepted) if (!state.confirms.some((confirm) => confirm.id === id)) state.accepted.delete(id);
                }
                // ---------- #283 org 域跨源聚合：分区合并 ----------
                // 病灶：聚合视角下 per-source 全量帧经 Team 中间层（settings-domain）到达本域，
                // 旧 case 整替换 state.projects/confirms → 并集被单源帧清掉（家 relay 重启
                // 首播 groups 无 delta 直达裸透传=「公司源团队卡聚合视图不可见」活跃形态）。
                // 修法：聚合视角=分区替换，他源分区原样保留；同 id 异源碰撞按帧源权威。
                // 输入两形态（审查 B-P1-1 回修）：
                //   · 裸透传（no-delta 帧）＝帧源自己的全量清单，条目无源标 → 盖帧源标；
                //   · 中间层投影（delta 帧经 wrapper 并集重合成）＝全并集，条目已带真源标
                //     （合成快照/槽缓存所盖）→ **保真不覆盖**，仅本帧新增条目（delta upsert
                //     的裸对象）落帧源标。无条件盖章会污染全并集源标+跨源删除留僵尸卡
                //     （污染后条目两过滤条件皆不命中，已删组滞留到下次快照）。
                // 单源视角=整替换不盖章，既有行为逐字不变（「单源视图不变」断言面）。
                const aggViewOn = () => !!(window.__ccDeck005SourceView && window.__ccDeck005SourceView() === "aggregate");
                function mergePartition(current, incoming, frameSrc, keyOf) {
                  if (!aggViewOn() || !frameSrc) return incoming.slice();
                  const src = String(frameSrc);
                  const stamped = incoming.map((x) => {
                    if (!(x && typeof x === "object")) return x;
                    return x.__relay_source === undefined ? Object.assign({}, x, { __relay_source: src }) : x; // 保真源标（投影路）；裸路条目无标→盖帧源
                  });
                  const stampIds = new Set(stamped.map(keyOf).filter((k) => k !== undefined));
                  const kept = (Array.isArray(current) ? current : []).filter((x) => {
                    if (!(x && typeof x === "object")) return false;
                    if (String(x.__relay_source || "") === src) return false; // 帧源分区：整替换（真源标=帧源的条目含已删组一并退场）
                    return !stampIds.has(keyOf(x)); // 同 id 碰撞：帧源/投影内版本权威，他源旧拷贝剔除
                  });
                  return kept.concat(stamped);
                }
                const groupKeyOf = (g) => (g && typeof g.id === "string" ? g.id : undefined);
                const confirmKeyOf = (c) => (c && typeof c.id === "string" ? c.id : undefined);
                function updateProjects(items) {
                  state.projects = Array.isArray(items) ? entities(items) : null;
                  if (!group()) state.selected = state.projects?.[0]?.id || null;
                  const ids = new Set(state.projects?.map((item) => item.id));
                  for (const cache of [state.boards, state.receipts, state.loads]) for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
                }
                function detail(gid, data) {
                  if (!state.projects?.some((item) => item.id === gid) || !data || data.group?.id !== gid || data.board?.gid !== gid || !Array.isArray(data.board.entries) || !Array.isArray(data.receipts)) return false;
                  // #283（审查 A-P2-1）：detail 回执整条替换时保真源标——data.group 来自
                  // relay 无 __relay_source，裸替换会让该组脱离分区身份（源标兜底链失效+
                  // 删除时走 kept 分支滞留成幽灵）
                  state.projects = state.projects.map((item) => item.id === gid
                    ? Object.assign({}, data.group, item.__relay_source !== undefined ? { __relay_source: item.__relay_source } : null)
                    : item);
                  state.boards.set(gid, data.board);
                  state.receipts.set(gid, entities(data.receipts).sort((first, second) => (Number(second.ts) || 0) - (Number(first.ts) || 0)).slice(0, 30));
                  // W-DISPVIS C2：组内排队单存本（dispatch_queue 能力位——旧 relay 缺省不
                  // 标角标，端上零副作用）。跨域借道：B2 会话域闭包读不到本域 state——挂
                  // window 键（__ccDeck005RefreshSettingsLive 同款 window 借道范式）
                  state.dispatchQueues = state.dispatchQueues || new Map();
                  state.dispatchQueues.set(gid, Array.isArray(data.dispatch_queue) ? data.dispatch_queue : []);
                  window.__ccDeck005DispatchQueues = state.dispatchQueues;
                  state.loads.set(gid, "ready");
                  render();
                  return true;
                }
                function verdict(ack) {
                  const error = typeof ack?.error === "string" ? ack.error.trim() : "";
                  return { ok: ack?.ok === true && !error, error: error || "未收到明确成功的命令回执" };
                }
                function rememberUnsupported(type, error) {
                  if (/invalid command shape|unknown.?command|unsupported|未知命令|不支持/i.test(error)) state.unsupported.add(type);
                }
                async function requestDetail(gid, force = false) {
                  if (!state.command || !state.online || state.unsupported.has("COMMAND_PROJECT_DETAIL") || !state.projects?.some((item) => item.id === gid) || state.loads.get(gid) === "loading" || (!force && state.loads.get(gid) === "ready")) return false;
                  const epoch = state.epoch;
                  const projectAtRequest = state.projects.find((item) => item.id === gid);
                  const boardAtRequest = state.boards.get(gid);
                  state.loads.set(gid, "loading");
                  render();
                  try {
                    const ack = await state.command("COMMAND_PROJECT_DETAIL", { gid });
                    if (epoch !== state.epoch || !state.projects?.some((item) => item.id === gid)) return false;
                    if (state.projects.find((item) => item.id === gid) !== projectAtRequest || state.boards.get(gid) !== boardAtRequest) { state.loads.delete(gid); void requestDetail(gid); return false; }
                    const result = verdict(ack);
                    if (!result.ok) { rememberUnsupported("COMMAND_PROJECT_DETAIL", result.error); throw new Error(result.error); }
                    if (!detail(gid, ack.data)) throw new Error("项目详情回执缺少匹配的 group / board / receipts");
                    return true;
                  } catch (error) {
                    if (epoch === state.epoch && state.projects?.some((item) => item.id === gid)) { state.loads.set(gid, "详情加载失败：" + String(error?.message || error)); feedback(state.loads.get(gid)); render(); }
                    return false;
                  }
                }
                async function decide(id, approve) {
                  if (typeof approve !== "boolean" || !state.confirms.some((confirm) => confirm.id === id) || !state.command || !state.online || state.flights.has(id) || state.accepted.has(id) || state.unsupported.has("COMMAND_ORG_CONFIRM")) return false;
                  const epoch = state.epoch;
                  state.flights.add(id);
                  render();
                  try {
                    // #288 审查 B-P1-2：远程确认卡「可见可决」——确认卡带 __relay_source 源标
                    //（mergePartition 保真），决议命令按源路由（原视角通道=local 时对远程卡
                    // 恒「确认单不存在」，远程正经立项/新 relay 首个轻立项永久 pending）。
                    // 源名→通道位（cloudRelayName=cloud / lanRelayName=local）→ WsFor 通道
                    const card = state.confirms.find((confirm) => confirm.id === id);
                    const cardSrc = String(card?.__relay_source || "");
                    let confirmWs = null;
                    if (cardSrc) {
                      const st = (window.__ccDeck005SourceState && window.__ccDeck005SourceState()) || null;
                      const lane = cardSrc && st && String(st.cloudRelayName || "") === cardSrc ? "cloud"
                        : cardSrc && st && String(st.lanRelayName || "") === cardSrc ? "local" : "";
                      confirmWs = lane && window.__ccDeck005WsFor ? window.__ccDeck005WsFor(lane) : null;
                    }
                    const result = verdict(await state.command("COMMAND_ORG_CONFIRM", { confirm_id: id, approve }, undefined, confirmWs || undefined));
                    if (epoch !== state.epoch) return false;
                    if (!result.ok) { rememberUnsupported("COMMAND_ORG_CONFIRM", result.error); throw new Error(result.error); }
                    if (state.confirms.some((confirm) => confirm.id === id)) state.accepted.add(id);
                    feedback(approve ? "已同意，等待来源权威更新。" : "已否决，等待来源权威更新。");
                    return true;
                  } catch (error) {
                    if (epoch === state.epoch) feedback("决议失败：" + String(error?.message || error));
                    return false;
                  } finally {
                    if (epoch === state.epoch) { state.flights.delete(id); render(); }
                  }
                }
                function snapshot(payload = {}, context = {}) {
                  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
                  state.epoch += 1;
                  state.boards.clear(); state.receipts.clear(); state.loads.clear(); state.flights.clear(); state.accepted.clear();
                  state.source = context?.relayName || payload.relay_name || "当前来源";
                  state.sessions = new Map((Array.isArray(payload.sessions) ? payload.sessions : []).filter((session) => session && typeof session.session_id === "string").map((session) => [session.session_id, session]));
                  // W-DESIGNHUB：图纸清单锚定（能力位=数组存在；缺=旧 relay 不挂区）
                  state.designDocs = Array.isArray(payload.design_docs) ? payload.design_docs.filter((d) => d && typeof d.path === "string" && typeof d.title === "string") : undefined;
                  updateProjects(payload.projects);
                  updateConfirms(payload.org_confirms);
                  // W-EXPP2 经验域锚定（字段存在=锚定，空数组也成立；缺席=旧 relay 不渲染）
                  updateExperiences(payload.experience);
                  state.experienceEnabled = payload.experience_enabled !== false;
                  // W-RULES2 铁律域锚定（experience 同款口径）
                  updateRules(payload.rules);
                  state.rulesEnabled = payload.rules_enabled !== false;
                  for (const board of Array.isArray(payload.boards) ? payload.boards : []) if (board && state.projects?.some((item) => item.id === board.gid) && Array.isArray(board.entries)) state.boards.set(board.gid, board);
                  // 件十八：receipts 过滤与 relay project-detail 同口径放宽——anchor 匹配 ∪ sid ∈ 编制
                  if (Array.isArray(payload.receipts)) for (const project of state.projects || []) {
                    const memberSids2 = new Set((Array.isArray(project.headcount) ? project.headcount : []).map((h) => h && h.session_id));
                    state.receipts.set(project.id, entities(payload.receipts.filter((entry) => {
                      if (!entry) return false;
                      const a = typeof entry.project_anchor === "string" ? entry.project_anchor.replace(/[\\/]/g, "/").replace(/\/+$/, "") : "";
                      if (a && a === String(project.anchor_dir || "").replace(/[\\/]/g, "/").replace(/\/+$/, "")) return true;
                      return memberSids2.has(entry.session_id);
                    })).sort((first, second) => (Number(second.ts) || 0) - (Number(first.ts) || 0)).slice(0, 30));
                  }
                  render();
                  if (state.selected) void requestDetail(state.selected);
                  return true;
                }
                function onEvent(context, message) {
                  const payload = message?.payload;
                  if (message?.type === "SNAPSHOT") return snapshot(payload, context);
                  // #283：groups 全量帧恒消费（delta 在场与否）。注：本域唯一喂入方是
                  // settings 层 wrapper（feed）——稳态 delta 帧在那侧已被剥 delta 重喂
                  // {groups}，旧 `delta === undefined` 守卫在该接线下恒通过（死条件，
                  // 行为中性），删除属防误接线的收紧而非修陈旧；聚合视角经 mergePartition
                  // 分区替换保并集（no-delta 裸透传=重启首播清并集的原始病灶路径），
                  // 单源视角整替换行为逐字不变
                  if (message?.type === "PROJECTS_UPDATED" && Array.isArray(payload?.groups)) { updateProjects(mergePartition(state.projects, payload.groups, context && context.relayName, groupKeyOf)); render(); if (state.selected) void requestDetail(state.selected, true); return true; }
                  if (message?.type === "ORG_CONFIRM_UPDATED" && Array.isArray(payload?.pending)) { updateConfirms(mergePartition(state.confirms, payload.pending, context && context.relayName, confirmKeyOf)); render(); return true; }
                  // #283 同理：board 全量形态（board.gid+entries 在场）即权威覆盖，delta
                  // 并载不影响（本 case 只取 board.entries 全量）；gid 门控=并集含该组
                  if (message?.type === "BOARD_UPDATED" && typeof payload?.gid === "string" && payload.board?.gid === payload.gid && Array.isArray(payload.board.entries) && state.projects?.some((item) => item.id === payload.gid)) { state.boards.set(payload.gid, payload.board); render(); if (payload.gid === state.selected) void requestDetail(payload.gid, true); return true; }
                  // W-EXPP2 经验域帧：帧双载恒带 entries 全量 → 覆盖式消费（未锚定=experiences
                  // null 时同帧即锚定——SNAPSHOT 先行兜底过，此处权威刷新）；expArm/expForm 保持
                  if (message?.type === "EXPERIENCE_UPDATED" && Array.isArray(payload?.entries)) { updateExperiences(payload.entries); render(); return true; }
                  // W-RULES2 铁律域帧（EXPERIENCE_UPDATED 同构）：覆盖式消费；rulesArm/rulesForm 保持
                  if (message?.type === "RULES_UPDATED" && Array.isArray(payload?.entries)) { updateRules(payload.entries); render(); return true; }
                  return false;
                }
                function bind({ command = null, online = false } = {}) {
                  state.epoch += 1;
                  state.command = typeof command === "function" ? command : null;
                  state.online = online === true;
                  state.flights.clear(); state.loads.clear(); state.accepted.clear(); state.unsupported.clear();
                  render();
                  if (state.selected) void requestDetail(state.selected);
                }
                function select(gid) {
                  if (!state.projects?.some((item) => item.id === gid)) return false;
                  state.selected = gid;
                  state.confirmSelected = state.confirms.find((confirm) => confirm.payload?.gid === gid)?.id || null;
                  window.__ccDeck005SlimUi?.markSeen?.(gid); // [t-7e0c6189] 进团队域选中该团队即清未读聚合（设计要点 1）
                  render();
                  void requestDetail(gid);
                  return true;
                }
                // ---------- FB4 团队创建表单 ----------
                // 真表单（团队名/锚点目录/立项档/成员多选+角色模板），提交走
                // COMMAND_ORG_ACTION create（relay 单漏斗 createGroup；headcount 随团种子
                // 编制，会话在册性由 relay 咽喉校验）。取代此前「代理会话域新建会话弹窗」
                // 的形态错位（FB 审计 4327/4563）。创建成功/确认卡落单后 PROJECTS_UPDATED
                // 帧自动刷新队列，无需手动重拉
                const TEAM_ROLE_PRESETS = ["worker", "PM", "reviewer", "qa"];
                // W-UIFB 追加⑮：手动成员行 agent 类型清单（与 sessionItem 引擎映射同六引擎口径）
                const TEAM_ENGINE_OPTIONS = [["claude", "Claude"], ["codex", "Codex"], ["trae", "Trae"], ["qwen-code", "Qwen Code"], ["codebuddy", "CodeBuddy"], ["zcode", "ZCode"]];
                const cssEscape = (value) => String(value).replace(/["\\]/g, "\\$&"); // 属性选择器内引号安全（B2 cssEsc 同款）
                function teamCandidates() {
                  return [...state.sessions.values()]
                    .filter((s) => s && typeof s.session_id === "string" && !s.external)
                    .sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0))
                    .slice(0, 12);
                }
                function teamCwdDefault() {
                  try { return localStorage.getItem("cc-deck-005-last-cwd") || ""; } catch (_) { return ""; }
                }
                // ---------- #277 建团多源化助手 ----------
                // ② 目标源信息（NewSessionModal「创建到」同闸：云已配对且在线才透出选择行）
                function teamSourceInfo() {
                  const st = (window.__ccDeck005SourceState && window.__ccDeck005SourceState()) || null;
                  if (!st || !st.cloudPaired || st.cloudStatus !== "online") return null;
                  return st;
                }
                // ③ 候选随源切换：relay_source 对位该源（本机源兜底无标记会话——旧 relay 快照缺源的按本机计）
                function teamCandsForSource(which, st) {
                  const lanName = String((st && st.lanRelayName) || "");
                  const cloudName = String((st && st.cloudRelayName) || "");
                  return [...state.sessions.values()]
                    .filter((x) => x && typeof x.session_id === "string" && !x.external)
                    .filter((x) => {
                      const src = String(x.relay_source || x.source || "");
                      return which === "cloud" ? src === cloudName : (!src || src === lanName);
                    })
                    .sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0))
                    .slice(0, 12);
                }
                // 候选行 v2（#277 美化）：去引擎徽标（引擎身份归成员卡头像，行内省空间防截断）
                function teamCandListHtml(cands) {
                  if (!cands.length) return banner("该源暂无可入编的托管会话。可先创建，稍后在编制面板补齐成员。");
                  return '<div class="team-cand-list" data-team-cands>' + cands.map((x) =>
                    '<label class="create-check team-cand"><input type="checkbox" data-team-member="' + escape(x.session_id) + '">'
                    + '<span class="team-cand-name">' + escape(x.title || x.session_id.slice(0, 12)) + '</span>'
                    + '<input class="create-field team-cand-role" data-team-role="' + escape(x.session_id) + '" list="team-role-list" placeholder="worker" aria-label="成员角色" hidden></label>').join("") + "</div>";
                }
                // ④ 本机目录选择器闸（#158-批3 createCwdBrowseable 同款：dialog 插件在场 + 本机 loopback 源）
                function teamAnchorBrowseable(which) {
                  return which === "local" && !!(window.__TAURI__ && window.__TAURI__.dialog
                    && typeof window.__ccDeck005LocalRelayLoopback === "function" && window.__ccDeck005LocalRelayLoopback());
                }
                async function pickTeamAnchor() {
                  if (!(window.__TAURI__ && window.__TAURI__.dialog)) return;
                  try {
                    const input = document.querySelector("#team-create-pop [data-team-field='anchor']");
                    const cur = input ? input.value.trim() : "";
                    const dir = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title: "选择锚点目录", ...(cur ? { defaultPath: cur } : {}) });
                    if (typeof dir === "string" && dir && input) input.value = dir;
                  } catch (e) { toast("打开目录选择器失败: " + ((e && e.message) || e)); }
                }
                // 源联动态：浏览钮显隐 + 锚点提示文案（远程源=那台电脑的路径）
                // #288③ 锚点提示按目标源宿主系统（用户 1028 拍板「选源=数据落点」的配套）：
                // 从所选源 SNAPSHOT.platform 读真实系统——darwin/linux→POSIX 路径示例、
                // win32→盘符示例；快照未达/旧 relay 无字段=未知回落通用文案（不猜）
                function teamAnchorHint(which) {
                  const plat = window.__ccDeck005PlatformFor ? window.__ccDeck005PlatformFor(which) : null;
                  const posix = "形如 /Users/名字/项目 或 /home/名字/项目";
                  const win = "形如 C:\\Users\\名字\\项目";
                  if (which === "cloud") {
                    if (plat === "win32") return "路径在那台电脑（远程 Windows 宿主机）上——" + win;
                    if (plat) return "路径在那台电脑（远程源宿主机）上——" + posix;
                    return "路径在那台电脑（远程源宿主机）上——请按它的文件系统填项目绝对路径";
                  }
                  if (plat === "win32") return "路径在 relay 宿主机（Windows）上——" + win;
                  if (plat) return "路径在 relay 宿主机上（非当前浏览器电脑）——" + posix;
                  return "路径在 relay 宿主机上（非当前浏览器电脑）——Mac/Linux " + posix + "，Windows " + win;
                }
                function syncTeamCreateSource(pop) {
                  const sel = pop.querySelector("[data-team-field='source']");
                  const which = sel ? sel.value : "local";
                  const browse = pop.querySelector("[data-team-anchor-browse]");
                  if (browse) browse.hidden = !teamAnchorBrowseable(which);
                  const hint = pop.querySelector("[data-team-anchor-hint]");
                  if (hint) hint.textContent = teamAnchorHint(which);
                }
                // W-UIFB 追加⑮：手动成员行——agent 类型 + 角色名，候选勾选与手动行合计 ≤8 席。
                // 接通现状（回执「追加批」详述）：relay sanitizeHeadcount 硬性要求 session_id 且
                // org adapter 不透传 role_defaults，手动席暂不进创建载荷，创建成功后明示用户。
                function teamSeatCount(pop) {
                  // W-TEAMSNC ①：PM 带队模板（pm-led，默认档）占 1 席——relay sanitizeHeadcount
                  // 的 8 席硬闸按行数计（PM 身份行也占），表单侧同步计数防提交才被拒
                  const pmLed = pop.querySelector("[data-team-field='template']")?.value === "pm-led";
                  return pop.querySelectorAll("[data-team-member]:checked").length + pop.querySelectorAll(".team-manual-row").length + (pmLed ? 1 : 0);
                }
                function addTeamManualRow(pop) {
                  if (teamSeatCount(pop) >= 8) { toast("编制最多 8 席"); return; }
                  const opts = TEAM_ENGINE_OPTIONS.map((e) => '<option value="' + escape(e[0]) + '">' + escape(e[1]) + "</option>").join("");
                  const row = document.createElement("div");
                  row.className = "team-manual-row";
                  row.innerHTML = '<select class="create-field team-manual-engine" data-manual-engine aria-label="agent 类型">' + opts + '</select>'
                    + '<input class="create-field" data-manual-role list="team-role-list" placeholder="角色名（默认 worker）" aria-label="成员角色">'
                    + '<button type="button" class="team-manual-x" data-manual-remove title="移除此行" aria-label="移除此行">✕</button>';
                  const addBtn = pop.querySelector("[data-team-add-member]");
                  if (addBtn) addBtn.before(row); else pop.querySelector("[data-team-cand-wrap]")?.append(row);
                  row.querySelector("select")?.focus();
                }
                function openTeamCreate() {
                  closeTeamCreate();
                  const back = document.createElement("div");
                  back.className = "pair-pop-backdrop";
                  back.dataset.teamCreateBack = "";
                  const pop = document.createElement("div");
                  pop.id = "team-create-pop";
                  pop.className = "create-pop";
                  pop.setAttribute("role", "dialog");
                  pop.setAttribute("aria-modal", "true");
                  pop.setAttribute("aria-label", "新建团队");
                  const st = teamSourceInfo(); // #277 ②：聚合/云在线透出「创建到」（NewSessionModal 同语义）
                  const defSrc = (window.__ccDeck005SourceState && window.__ccDeck005SourceState())?.view === "cloud" ? "cloud" : "local";
                  const defCands = teamCandsForSource(defSrc, st);
                  // #277 ① 弹窗重设计（PM 美化基调）：统一分段卡片流（灰盒 create-group 退役）、
                  // 头行 h3+✕（标题不截断）、成员行去引擎徽标、帮助文字压一行
                  let html = '<div class="create-head"><h3>新建团队</h3><button type="button" class="create-x" data-team-close aria-label="关闭" title="关闭">✕</button></div>'
                    + '<p class="create-sub">需确认的新建项目会在确认卡上请你决议</p>';
                  if (st) {
                    html += '<div class="create-label">创建到</div><select class="create-field" data-team-field="source" aria-label="目标源">'
                      + '<option value="local"' + (defSrc === "local" ? " selected" : "") + '>本机 · ' + escape(String(st.lanRelayName || "本机")) + '</option>'
                      + '<option value="cloud"' + (defSrc === "cloud" ? " selected" : "") + '>远程 · ' + escape(String(st.cloudRelayName || st.cloudWsUrl || "远程源")) + '</option></select>';
                  }
                  html += '<div class="create-label">团队名</div><input class="create-field" data-team-field="name" placeholder="如：redbook 推广" aria-label="团队名">';
                  html += '<div class="create-label">锚点目录</div><div class="create-inline"><input class="create-field" data-team-field="anchor" placeholder="relay 宿主机上的项目绝对路径 · 一锚一团" aria-label="锚点目录" value="' + escape(teamCwdDefault()) + '">'
                    + '<button type="button" class="secondary-btn create-browse" data-team-anchor-browse title="从文件管理器选择目录" hidden>浏览</button></div>';
                  html += '<div class="create-hint" data-team-anchor-hint>路径在 relay 宿主机上，不是当前浏览器电脑</div>';
                  html += '<div class="create-label">立项档</div><select class="create-field" data-team-field="tier" aria-label="立项档"><option value="轻立项">轻量项目（单卡简化态）</option><option value="正经立项">正式项目（每次创建都需确认）</option></select>';
                  // #277 ③：成员候选随源切换（relay_source 对位），切源即时重灌本容器
                  html += '<div class="create-label">成员编制 · 最多 8 席</div><div data-team-cand-wrap>' + teamCandListHtml(defCands) + "</div>";
                  if (!state.online || !state.command) html += banner("命令通道未接入，无法提交创建。");
                  html += '<datalist id="team-role-list">' + TEAM_ROLE_PRESETS.map((r) => '<option value="' + escape(r) + '"></option>').join("") + "</datalist>";
                  html += '<button type="button" class="team-add-btn" data-team-add-member>＋ 添加成员</button>';
                  if (defCands.length) html += '<div class="create-label">角色模板</div><select class="create-field" data-team-field="template" aria-label="角色模板"><option value="pm-led">PM 带队（当前选中会话任 PM，勾选成员为 worker）</option><option value="worker">统一 worker（默认执行者）</option><option value="PM">统一 PM（项目管理）</option><option value="free">自由编制（逐人指定）</option></select>';
                  html += '<div class="create-actions"><button class="secondary-btn" type="button" data-team-cancel>取消</button><button class="primary-btn" type="button" data-team-submit>创建团队</button></div>';
                  pop.innerHTML = html;
                  back.addEventListener("click", closeTeamCreate);
                  pop.addEventListener("click", (ev) => {
                    if (ev.target.closest("[data-team-cancel]") || ev.target.closest("[data-team-close]")) { closeTeamCreate(); return; }
                    if (ev.target.closest("[data-team-submit]")) { void submitTeamCreate(pop); return; }
                    if (ev.target.closest("[data-team-add-member]")) { addTeamManualRow(pop); return; }
                    if (ev.target.closest("[data-manual-remove]")) { ev.target.closest(".team-manual-row")?.remove(); return; }
                    if (ev.target.closest("[data-team-anchor-browse]")) { void pickTeamAnchor(); return; }
                  });
                  pop.addEventListener("change", (ev) => {
                    const tpl = ev.target.closest("[data-team-field='template']");
                    if (tpl) {
                      const free = tpl.value === "free";
                      pop.querySelectorAll(".team-cand-role").forEach((el) => { el.hidden = !free; });
                      return;
                    }
                    const srcSel = ev.target.closest("[data-team-field='source']"); // #277 ③ 切源：候选重灌+浏览钮/hint 联动
                    if (srcSel) {
                      const wrap = pop.querySelector("[data-team-cand-wrap]");
                      if (wrap) wrap.innerHTML = teamCandListHtml(teamCandsForSource(srcSel.value, teamSourceInfo()));
                      syncTeamCreateSource(pop);
                      return;
                    }
                  });
                  pop.addEventListener("keydown", (ev) => {
                    if (ev.key === "Escape") { ev.stopPropagation(); closeTeamCreate(); return; }
                    if (ev.key === "Enter" && ev.target.tagName === "INPUT" && ev.target.dataset.teamField) { ev.preventDefault(); void submitTeamCreate(pop); }
                  });
                  document.body.append(back, pop);
                  syncTeamCreateSource(pop); // #277 ④：初始浏览钮/hint 态
                  const name = pop.querySelector("[data-team-field='name']");
                  if (name) name.focus();
                }
                function closeTeamCreate() { document.querySelectorAll("#team-create-pop, [data-team-create-back]").forEach((el) => el.remove()); }
                async function submitTeamCreate(pop) {
                  const name = String(pop.querySelector("[data-team-field='name']")?.value ?? "").trim();
                  const anchor = String(pop.querySelector("[data-team-field='anchor']")?.value ?? "").trim();
                  const tier = String(pop.querySelector("[data-team-field='tier']")?.value ?? "轻立项");
                  const template = String(pop.querySelector("[data-team-field='template']")?.value ?? "worker");
                  if (!name) { toast("先填团队名"); return; }
                  if (!anchorFormatOk(anchor)) { toast("锚点目录需是绝对路径（relay 宿主机路径：Mac/Linux 形如 /Users/…，Windows 宿主形如 C:\\…）"); return; }
                  const headcount = [...pop.querySelectorAll("[data-team-member]")].filter((el) => el.checked).map((el) => {
                    const sid = el.dataset.teamMember;
                    const roleInput = pop.querySelector("[data-team-role='" + cssEscape(sid) + "']");
                    const role = template === "free" ? String(roleInput?.value ?? "").trim() : template === "pm-led" ? "worker" : template;
                    return { session_id: sid, role: role || "worker" };
                  });
                  // W-TEAMSNC ①：PM 带队默认档——pm_session_id=会话域当前选中会话（跨域取
                  // __ccDeck005SlimUi.selectedSid；relay orgCommand create 单点插 role="pm" 身份行）。
                  // #288② 按源在册闸（用户 1028 拍板「选源=数据落点」）——审查 A-P1 修正版：
                  // 专用谓词 pmInSource（不 slice 截断/不排 external——relay 侧 pm_session_id
                  // 校验口径「在册即可、外部允许」，生产 PM 主会话常为 ext- 外部会话，用展示用
                  // 候选列表当判据会把双源×PM 带队头条场景恒拦死且归因错误）；源离线先探
                  // WsFor 短路（离线时归因应为「源不在线」而非「PM 不在册」）；名册对不上
                  // 源名（未知态）降级放行+warning（与 relay 权威校验兜底分层）。
                  // 未选源（单源形态）行为不变：降级原口径（feedback 不拦）
                  const pmSidOut = { v: template === "pm-led" ? String(window.__ccDeck005SlimUi?.selectedSid?.() || "") : "" };
                  const pmSid = pmSidOut.v; // 读侧兼容（下方去重/splice 用）
                  const srcSelEarly = pop.querySelector("[data-team-field='source']"); // #288②：闸块先于下方 srcSel 声明，早取同节点
                  const pmInSource = (which, sid) => {
                    const st = teamSourceInfo();
                    const s = sid && state.sessions.get(sid);
                    if (!s) return { verdict: "absent" };
                    const src = String(s.relay_source || s.source || "");
                    if (which === "cloud") {
                      const cn = String((st && st.cloudRelayName) || "");
                      return cn && src ? (src === cn ? { verdict: "in" } : { verdict: "out" }) : { verdict: "unknown" };
                    }
                    const ln = String((st && st.lanRelayName) || "");
                    return (!src || (ln && src === ln)) ? { verdict: "in" } : (ln && src !== ln) ? { verdict: "out" } : { verdict: "unknown" };
                  };
                  if (template === "pm-led" && srcSelEarly) {
                    const srcLabel = srcSelEarly.value === "cloud" ? "远程源" : "本机源";
                    const online = window.__ccDeck005WsFor ? window.__ccDeck005WsFor(srcSelEarly.value) : null;
                    if (online && pmSid) {
                      const v = pmInSource(srcSelEarly.value, pmSid);
                      if (v.verdict === "out") {
                        feedback("PM 会话需属于所选源：当前选中会话不在" + srcLabel + "——请切换目标源或先在会话列表选中该源的 PM 会话");
                        return; // 审查 P2②：feedback 即 toast 别名，双响退役
                      }
                      if (v.verdict === "unknown") feedback("暂无法核对选中会话是否属于" + srcLabel + "（源名册未同步）——将以该源 relay 校验为准");
                      if (v.verdict === "absent") { feedback("未取到当前选中会话，本团未带 PM 行（可稍后编制面板补）"); pmSidOut.v = ""; } // 审查 B：让提示为真（payload 不带该行）
                    } else if (online && !pmSid) feedback("未取到当前选中会话，本团未带 PM 行（可稍后编制面板补）");
                  } else if (template === "pm-led" && !pmSid) feedback("未取到当前选中会话，本团未带 PM 行（可稍后编制面板补）");
                  if (pmSid) { const i = headcount.findIndex((h) => h.session_id === pmSid); if (i >= 0) headcount.splice(i, 1); } // PM 会话被同时勾选：让位 pm_session_id 身份行（同 sid 双行会被 relay 去重，先去保角色正确）
                  // W-UIFB 追加⑮：手动席（agent 类型+角色名）——relay sanitizeHeadcount 现版
                  // 硬性要求 session_id 且 adapter 不透传 role_defaults，入载会整单被拒；
                  // 故手动席暂不进创建载荷，创建成功后明示「待补齐」，接通条件见回执。
                  const manualSeats = [...pop.querySelectorAll(".team-manual-row")].map((row) => ({
                    engine: String(row.querySelector("[data-manual-engine]")?.value ?? "claude"),
                    role: String(row.querySelector("[data-manual-role]")?.value ?? "").trim() || "worker",
                  }));
                  // #277 ② 显式选源锁通道（新建会话 T10 同语义：选择优先级最高不随视角漂移；
                  // 未显式选源的单源形态维持 RouteWs 视角通道）
                  const srcSel = pop.querySelector("[data-team-field='source']");
                  let wsOverride = null;
                  if (srcSel) {
                    wsOverride = window.__ccDeck005WsFor ? window.__ccDeck005WsFor(srcSel.value) : null;
                    if (!wsOverride) { toast(srcSel.value === "cloud" ? "远程源不在线，无法在远程创建" : "本机源不在线，无法在本机创建"); return; }
                  }
                  const flight = "team-create";
                  if (state.flights.has(flight)) return;
                  state.flights.add(flight);
                  try {
                    const result = verdict(await state.command("COMMAND_ORG_ACTION", { action: "create", name, anchor_dir: anchor, tier, ...(headcount.length ? { headcount } : {}), ...(pmSidOut.v ? { pm_session_id: pmSidOut.v } : {}) }, undefined, wsOverride));
                    if (!result.ok) { rememberUnsupported("COMMAND_ORG_ACTION", result.error); feedback("创建失败：" + result.error); toast("创建团队失败：" + result.error); return; }
                    closeTeamCreate();
                    const manualNote = manualSeats.length ? "；" + manualSeats.length + " 个手动席位待后续版本入编" : "";
                    feedback(result.data?.needsConfirm ? "新建项目已提交，等你在确认卡上 ✓/✗。" + manualNote : "团队已创建。" + manualNote);
                    toast(result.data?.needsConfirm ? "新建项目已提交，待确认卡决议" : "团队已创建" + (manualSeats.length ? " · 手动席位 " + manualSeats.length + " 个待入编" : ""));
                  } catch (error) {
                    feedback("创建失败：" + String(error?.message || error));
                  } finally {
                    state.flights.delete(flight);
                    render();
                  }
                }
                function mount() {
                  if (state.mounted) return;
                  const panes = root.querySelectorAll(".workspace-body > .workspace-pane");
                  if (panes.length !== 7) return; // W-EXPP2+W-RULES2+W-OUTTAB：四 tab → 五（经验）→ 六（铁律）→ 七（输出，活动后）
                  panes.forEach((pane) => pane.removeAttribute("data-stub"));
                  root.removeAttribute("data-stub");
                  state.mounted = true;
                  // 1013 件8：悬浮详情卡侧方定位——CSS 默认右侧（.flip 翻左），JS 委托按视口
                  // 余量择侧 + 纵向钳制（贴底上移/贴顶下移，均留 12px 呼吸）；rAF 等 :hover
                  // 布局生效后量尺寸；重复触发幂等
                  root.addEventListener("mouseover", (event) => {
                    const card = event.target.closest(".task-card");
                    if (!card || !root.contains(card)) return;
                    const pop = card.querySelector(":scope > .task-pop");
                    if (!pop) return;
                    requestAnimationFrame(() => {
                      if (!pop.isConnected || !card.matches(":hover")) return;
                      const cr = card.getBoundingClientRect();
                      pop.classList.toggle("flip", cr.right + 416 > window.innerWidth - 8);
                      pop.style.top = "0px";
                      const pr = pop.getBoundingClientRect();
                      const wantTop = Math.min(cr.top, window.innerHeight - 12 - pr.height);
                      pop.style.top = Math.max(12, wantTop) - cr.top + "px";
                    });
                  });
                  // 1013 件9：顶栏刷新钮——板不随 SNAPSHOT 走（按需拉），且 Team.snapshot
                  // 落地时会清 boards/loads；事件在 SNAPSHOT 之后到：当前选中组立即 force
                  // 重拉（用户正在看的板即刻新鲜），其余组 loads 已清、切组时自然重拉
                  document.addEventListener("ccdeck-005-refresh", () => {
                    if (state.selected) void requestDetail(state.selected, true);
                  });
                  root.addEventListener("click", (event) => {
                    // FB4 团域新建：真表单（团队名/锚点/档位/成员多选），不再代理会话域新建会话弹窗
                    const newSession = event.target.closest("[data-team-new-session]");
                    if (newSession) {
                      event.stopPropagation();
                      openTeamCreate();
                      return;
                    }
                    const memberSession = event.target.closest("[data-team-member-session]");
                    if (memberSession) {
                      event.stopPropagation();
                      window.__ccDeck005B4?.railJump?.("session");
                      window.__ccDeck005B4?.selectSessionCard?.(memberSession.dataset.teamMemberSession);
                      return;
                    }
                    // W-DESIGNHUB 看板图纸打开（HttpOrigin 拼绝对地址新窗直开，同设置/项目域口径）
                    const designOpen = event.target.closest("[data-design-doc]");
                    if (designOpen) {
                      const origin = (typeof window.__ccDeck005HttpOrigin === "function" && window.__ccDeck005HttpOrigin()) || location.origin;
                      void window.__ccDeck005OpenUrl(origin.replace(/\/+$/, "") + designOpen.dataset.designDoc);
                      return;
                    }
                    // W-DESIGNHUB 输出物行 → 跳会话域对应会话（输出物全量在会话域输出物 tab）
                    const artifactRow = event.target.closest("[data-team-artifact]");
                    if (artifactRow) {
                      const sid = artifactRow.dataset.teamArtifact;
                      if (window.__ccDeck005B4 && typeof window.__ccDeck005B4.selectSessionCard === "function") window.__ccDeck005B4.selectSessionCard(sid);
                      return;
                    }
                    const decision = event.target.closest("[data-team-decision]");
                    if (decision) { event.preventDefault(); if (decision.dataset.approve === "true" || decision.dataset.approve === "false") void decide(decision.dataset.teamDecision, decision.dataset.approve === "true"); return; }
                    // #G3 父子链折叠钮：toggle 展开态（模块级 Set，render 重建存活）+重渲
                    const boardToggle = event.target.closest("[data-board-toggle]");
                    if (boardToggle) {
                      const pid = boardToggle.dataset.boardToggle;
                      if (boardExpanded.has(pid)) boardExpanded.delete(pid); else boardExpanded.add(pid);
                      render();
                      return;
                    }
                    // V8R 活动页筛选 chips（纯前端过滤，零链路）；W-ACTIVITY3 加源轴（Codex 轨双轴口径）
                    const feedChip = event.target.closest("[data-feed-chip]");
                    if (feedChip) { state.feedFilter = feedChip.dataset.feedChip || "all"; render(); return; }
                    const feedSrcChip = event.target.closest("[data-feed-src]");
                    if (feedSrcChip) { state.feedSrc = feedSrcChip.dataset.feedSrc || "all"; render(); return; }
                    const project = event.target.closest("[data-team-project]");
                    if (project) { select(project.dataset.teamProject); return; }
                    const confirm = event.target.closest("[data-team-pick-confirm]");
                    if (confirm) { state.confirmSelected = confirm.dataset.teamPickConfirm; render(); return; }
                    if (event.target.closest("[data-team-refresh]") && state.selected) void requestDetail(state.selected, true);
                    // W-EXPP2 经验库操作（两步武装 + 行内改归组表单）
                    const expRetire = event.target.closest("[data-exp-retire]");
                    if (expRetire) { expOp("exp-retire", expRetire.dataset.expRetire); return; }
                    const expRestore = event.target.closest("[data-exp-restore]");
                    if (expRestore) { expOp("exp-restore", expRestore.dataset.expRestore); return; }
                    const expRegroup = event.target.closest("[data-exp-regroup]");
                    if (expRegroup) { state.expForm = state.expForm === expRegroup.dataset.expRegroup ? null : expRegroup.dataset.expRegroup; state.expArm = null; render(); return; }
                    // 追加⑫：状态轴 chips 切换（经验/铁律；原 select change 链保留范围轴）
                    const expChip = event.target.closest("[data-exp-chip-status]");
                    if (expChip) { state.expFilter.status = expChip.dataset.expChipStatus; render(); return; }
                    // W-POLISH #96 手动整理（立即一轮 GC）：飞行禁用 + 结果一行反馈（清了几条）
                    const expGc = event.target.closest("[data-exp-gc]");
                    if (expGc) {
                      if (!expCanOp() || state.expGcFlight) return;
                      state.expGcFlight = true;
                      state.expGcNote = null;
                      render();
                      state.command("COMMAND_ORG_ACTION", { action: "exp-gc" }).then((ack) => {
                        state.expGcFlight = false;
                        if (ack && ack.ok) {
                          const d = ack.data || {};
                          if (!d.ran) state.expGcNote = "整理未执行：" + (d.reason || "未知原因");
                          else if (!d.retired && !d.merged && !d.demoted && !d.archived) state.expGcNote = "整理完成：无低值条目可清（库已干净；自动整理每周一轮+触顶即跑）";
                          else state.expGcNote = "整理完成：淘汰 " + (d.retired || 0) + " · 合并 " + (d.merged || 0) + " · 降权 " + (d.demoted || 0) + " · 归档 " + (d.archived || 0) + "（均可恢复/可回溯）";
                        } else {
                          state.expGcNote = "整理失败：" + ((ack && ack.error) || "relay 未确认");
                        }
                        render();
                      });
                      return;
                    }
                    const ruleChip = event.target.closest("[data-rules-chip-status]");
                    if (ruleChip) { state.rulesFilter.status = ruleChip.dataset.rulesChipStatus; render(); return; }
                    const expGo = event.target.closest("[data-exp-form-go]");
                    if (expGo) {
                      const row = expGo.closest(".exp-row");
                      const role = row?.querySelector("[data-exp-form-role]")?.value?.trim() ?? "";
                      const proj = row?.querySelector("[data-exp-form-project]")?.value ?? "";
                      expRegroupSubmit(expGo.dataset.expFormGo, role, proj);
                      return;
                    }
                    // W-RULES2 团队铁律操作（两步武装 + 替代行内表单 + 新增/导入面板）
                    const ruleRetire = event.target.closest("[data-rule-retire]");
                    if (ruleRetire) { ruleOp("rule-retire", ruleRetire.dataset.ruleRetire); return; }
                    const ruleSup = event.target.closest("[data-rule-supersede]");
                    if (ruleSup) { state.rulesForm = state.rulesForm === ruleSup.dataset.ruleSupersede ? null : ruleSup.dataset.ruleSupersede; state.rulesArm = null; render(); return; }
                    const ruleSpGo = event.target.closest("[data-rule-sp-go]");
                    if (ruleSpGo) {
                      const row = ruleSpGo.closest(".rule-row");
                      const text = row?.querySelector("[data-rule-sp-text]")?.value?.trim() ?? "";
                      ruleSupersedeSubmit(ruleSpGo.dataset.ruleSpGo, text);
                      return;
                    }
                    const addTg = event.target.closest("[data-rules-add-toggle]");
                    if (addTg) { state.rulesAddOpen = !state.rulesAddOpen; if (state.rulesAddOpen) state.rulesImpOpen = false; render(); return; }
                    const impTg = event.target.closest("[data-rules-imp-toggle]");
                    if (impTg) { state.rulesImpOpen = !state.rulesImpOpen; if (state.rulesImpOpen) { state.rulesAddOpen = false; state.rulesImpPreview = null; } render(); return; }
                    if (event.target.closest("[data-rules-add-go]")) {
                      const text = (query("[data-rules-add-text]")?.value || "").trim();
                      const aud = query("[data-rules-add-aud]")?.value || "all";
                      const scope = query("[data-rules-add-scope]")?.value || "team";
                      ruleAddSubmit(text, aud, scope);
                      return;
                    }
                    if (event.target.closest("[data-rules-imp-parse]")) { rulesImportParse(); return; }
                    if (event.target.closest("[data-rules-imp-go]")) { rulesImportConfirm(); return; }
                    const impTpl = event.target.closest("[data-rules-imp-tpl]");
                    if (impTpl) {
                      const done = () => { const old = impTpl.textContent; impTpl.textContent = "已复制"; setTimeout(() => { impTpl.textContent = old; }, 1500); };
                      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(RULES_IMPORT_TEMPLATE).then(done, () => {});
                      return;
                    }
                  });
                  root.addEventListener("change", (event) => {
                    const scope = event.target.closest("[data-exp-filter-scope]");
                    if (scope) { state.expFilter.scope = scope.value; render(); return; }
                    const status = event.target.closest("[data-exp-filter-status]");
                    if (status) { state.expFilter.status = status.value; render(); return; }
                    // W-RULES2 铁律筛选
                    const rScope = event.target.closest("[data-rules-filter-scope]");
                    if (rScope) { state.rulesFilter.scope = rScope.value; render(); return; }
                    const rStatus = event.target.closest("[data-rules-filter-status]");
                    if (rStatus) { state.rulesFilter.status = rStatus.value; render(); return; }
                  });
                  root.addEventListener("input", (event) => {
                    // W-RULES2 字数计数器（新增表单/替代表单实时 0/120）
                    const t = event.target.closest("[data-rules-add-text],[data-rule-sp-text]");
                    if (!t) return;
                    const counter = t.closest(".rule-form")?.querySelector(".rule-count");
                    if (counter) {
                      counter.textContent = t.value.length + "/120";
                      counter.classList.toggle("over", t.value.length > 120);
                    }
                  });
                  root.addEventListener("keydown", (event) => {
                    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-team-project]")) { event.preventDefault(); select(event.target.dataset.teamProject); }
                  });
                  render();
                }
                window.ccDeckTeam = Object.freeze({ mount, bind, snapshot, onEvent, detail, select });
                if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
                else mount();
              })();
            