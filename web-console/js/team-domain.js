              (() => {
                const root = document.querySelector("#d-team");
                const lanes = [["planned", "规划中"], ["backlog", "待认领"], ["claimed", "进行中"], ["submitted", "审查中"], ["ready_to_install", "待收单"], ["done", "完成"]]; /* 1014 用户定版词表；boardlife R2：submitted「待审查」→「审查中」（用户 1103 点名「甬道为什么叫待审查」——进行时态与卡面 chip「审查中 · PM」对齐）；planlane 批（1104 用户想法）加 planned 规划中最前——PM 轻量化/攒批类缓做想法的冰盒层，不可认领（dispatch 路由跳过）。【词表锚】泳道词表与 relay org-schema.ts BOARD_ENTRY_STATUSES 同源，加态先改 relay 单点再同步此处/RN OrgZone BOARD_LANES/session-domain TEAM_DRAWER_LANES/老壳 index.html BOARD_LANE 四处 */
                // #G3 板卡富模型：父子链折叠态（展开的父卡 id 集；模块级——render 重建存活）
                const boardExpanded = new Set(); // 1014 用户定版词表：待认领/进行中/审查中/待收单/完成（批4b 改向作废；boardlife R2 submitted 改词）
                // lanefold（1104 用户令三修·抽屉折叠）：可折叠泳道=规划中/完成两条（纯历史
                // 最低频+冰盒缓做层）；其余四核心泳道不加把手（避免过度设计）。fold 态
                // localStorage 按 (boardId, status) 键控记忆；首见默认=planned 展开（test.97
                // 刚上正在用）/done 收起（保 1440 档四核心列完整——硬指标 4）。laneLastCounts
                // 供计数徽章变化轻弹（render 间比对，键含 gid 防跨板串）。
                const LANE_FOLDABLE = new Set(["planned", "done"]);
                const laneFoldKey = (gid, status) => "lanefold:" + (gid || "?") + ":" + status;
                const laneFoldOpen = (gid, status) => { try { const v = localStorage.getItem(laneFoldKey(gid, status)); if (v === "1") return true; if (v === "0") return false; } catch {} return status === "planned"; };
                const laneFoldSet = (gid, status, open) => { try { localStorage.setItem(laneFoldKey(gid, status), open ? "1" : "0"); } catch {} };
                // lanehide（1105 用户拍板方案①「列隐藏+尾部停靠条」，Linear 同款——lanepatterns
                // 调研回执推荐①节）：低频列（done/planned）整列退出列序+四核心列吃回全宽；
                // 板尾常驻停靠条「⟨ 已隐藏：完成 N ▸」点击临时展开尾列（临时态=内存集
                // laneTempUnhide，刷新还原隐藏），列头 ⋯ 菜单「隐藏此列/收起（保持隐藏）」。
                // 记忆沿用 lanefold 的 (boardId,status) localStorage 键制（机制复用，键名
                // lanehide: 语义区分）；**替代**这两列的 lanefold 纵向折叠（用户否竖条后
                // 泳道形态定版：status 列不做折叠只做隐藏——Linear 同款）。旧 lanefold 键
                // 不迁移不读取（用户重藏一次，回执披露）。归档胶囊（方案②）不做，列头菜单
                // 结构即升级位（加项即得）。
                const LANE_HIDEABLE = new Set(["done", "planned"]);
                const laneHideKey = (gid, status) => "lanehide:" + (gid || "?") + ":" + status;
                const laneTempUnhide = new Set();
                const laneHiddenNow = (gid, status) => {
                  if (laneTempUnhide.has((gid || "?") + ":" + status)) return false;
                  try { return localStorage.getItem(laneHideKey(gid, status)) === "1"; } catch { return false; }
                };
                const laneHideSet = (gid, status, hide) => { try { localStorage.setItem(laneHideKey(gid, status), hide ? "1" : "0"); } catch {} };
                const laneLastCounts = new Map();
                const legacyStatuses = new Map([["todo", "backlog"], ["doing", "claimed"]]);
                const groupStatuses = new Map([["pending", "待确认"], ["active", "运行中"], ["parked", "已挂起"], ["archived", "已归档"]]); // W-V8 批2b：状态词表对齐 v8（在办/已结项→运行中/已归档，对照图 P3 词表统一项）
                const confirmKinds = new Map([["project-create", "正式项目"], ["tier-change", "升降级"], ["suggest-hold", "暂缓"], ["archive", "结项"], ["revive", "复活"], ["headcount-trim-first", "编制清理"], ["pm-appoint", "值守 PM 任命"], ["dispatch-closeout", "收口待办"]]); // [W-SEAT-SEMANTICS] 首裁确认卡标签（缺席时卡面裸显 kind 串）；[W-PMSEAT] 任命/收口两卡标签（1104 串台根治批）
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
                const state = { projects: null, confirms: [], boards: new Map(), receipts: new Map(), sessions: new Map(), selected: null, confirmSelected: null, source: "当前来源", command: null, online: false, mounted: false, epoch: 0, loads: new Map(), flights: new Set(), accepted: new Set(), unsupported: new Set(), experiences: null, experienceEnabled: undefined, expFilter: { scope: "all", status: "active" }, expArm: null, expFlights: new Set(), expForm: null, expArmTimer: null, expGcNote: null, expGcFlight: false, rules: null, rulesEnabled: undefined, rulesFilter: { status: "active", scope: "all" }, rulesArm: null, rulesArmTimer: null, rulesFlights: new Set(), rulesForm: null, rulesAddOpen: false, rulesImpOpen: false, rulesImpText: "", rulesImpPreview: null, rulesImpFlight: false, feedFilter: "all", feedSrc: "all", retiredEntries: undefined, boardFreshAt: new Map(), _freshLastAt: 0 }; /* boardfresh（1104 用户令·板面说谎第三现）：boardFreshAt=per-gid 板数据最近落地时刻（detail ack/SNAPSHOT.boards/BOARD_UPDATED 三写点）；_freshLastAt=强刷节流（5s） */ // feedFilter/feedSrc：活动页筛选双轴（类型=四态/源=引擎，Codex 轨拍板口径；纯前端过滤）
                const query = (selector) => root.querySelector(selector);
                const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
                const banner = (text) => '<div class="readonly-banner">' + escape(text) + "</div>";
                // W-NOVAFIX B5：空态分档——未连接「正在连接…」；已连接无团队数据「此 relay 无团队数据」
                const projectsEmpty = () => (state.projects === null ? (state.online ? "此 relay 无团队数据" : "正在连接…（团队数据待同步）") : "暂无项目组");
                const entities = (items) => [...new Map((Array.isArray(items) ? items : []).filter((item) => item && typeof item.id === "string" && item.id).map((item) => [item.id, item])).values()];
                // UIPOLISH3 件四②：底部常驻栏废除，反馈行走 toast（B4 在场）——原 [data-team-feedback]
                // 常驻 footer 随栏退役；toast() 原 fallback=feedback 会互递归，故 fallback 改 console
                const toast = (text, kind) => {
                  // web3p R2-P1（B 审）：转发 kind——:1188 详情失败 error 级曾在此被吞（⚠/红样式/可关闭全失效）
                  if (window.__ccDeck005B4 && typeof window.__ccDeck005B4.toast === "function") window.__ccDeck005B4.toast(text, kind);
                  else console.info("[team] " + text + (kind === "error" ? " [error]" : ""));
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
                const engineBadge = (key) => { const value = engine(key); return window.__ccDeck005EngineBadgeHtml // UI 精修二批：品牌单表借道（成员卡 identity-cluster 徽章补图标）
                    ? window.__ccDeck005EngineBadgeHtml(value[1] || key, escape(value[0]))
                    : '<span class="engine-badge ' + value[1] + '">' + escape(value[0]) + "</span>"; };
                // W-UIPOLISH ⑧：源名统一走 sourceDisplayName 映射（localhost→本机）——
                // 件十三只清了 9 处，团队域整域漏网（用户实锤团队名称旁仍挂 localhost）
                const srcName = (n) => (window.__ccDeck005SourceDisplayName ? window.__ccDeck005SourceDisplayName(n) : String(n || ""));
                const sourceBadge = () => '<span class="source-badge" data-src-slug="' + escape(window.__ccDeck005SrcSlug ? window.__ccDeck005SrcSlug(srcName(state.source)) : "") + '">' + escape(srcName(state.source)) + "</span>"; // 件E：slug 供徽章配色覆写定位
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
                  // W-BOARDFUSE（1104 用户令）：引擎标签与 worker 标签融合——独立 engine-badge
                  // 从 owner 行退役，引擎只保留品牌图标前置进 owner tchip 最前（名称/图标去重，
                  // 卡面一行更紧凑）。旧壳无 __ccDeck005EngineMarkHtml 时回落独立徽章（不丢引擎信息）。
                  const engVal = engine(info.engine);
                  const engIconHtml = engKnown && window.__ccDeck005EngineMarkHtml
                    ? '<span class="ow-eng" title="引擎 ' + escape(engVal[0]) + '">' + window.__ccDeck005EngineMarkHtml(engVal[1] || info.engine, engVal[0]) + "</span>"
                    : "";
                  if (engKnown && !engIconHtml) ownerBits.push(engineBadge(info.engine)); // 回落：旧壳图标助手缺席
                  // W-DISPVIS C2：看板卡执行者有已派单未消费（含换流窗口）→ owner chip 旁
                  // 轻量角标（同成员卡口径；q-run 是队列运行信号、本角标是消息级消费信号，
                  // 两者互补不互斥——q-run 由排队上下文驱动、本角标由 receipts.consumed 驱动）
                  if (task.owner_session && pendingDispatchSids(project.id).has(task.owner_session)) {
                    ownerBits.push('<span class="tchip disp-pend" title="派单已注入，worker 尚未消费（换流/启动窗口）">已派单 · 等待处理</span>');
                  }
                  // boardlife ②（用户口径「进行中的卡看得到谁在干、点了能跳到他」）：执行者
                  // chip 升可点——data-team-member-session 复用成员卡消息钮同一委托链（:1587
                  // closest→selectSessionCard），点 chip 直达执行者会话；无 owner_session（未指派）
                  // 不挂牌不炸（优雅降级）。有 owner 即可点（claimed 进行中为主用例，其余态跳
                  // 转同链无害——sid 兜底跳，退休/外部会话由会话域空态兜底）。
                  ownerBits.push('<span class="tchip owner' + (task.owner_session ? " owner-jump" : "") + '"' + (task.owner_session ? ' data-team-member-session="' + escape(task.owner_session) + '" role="button" tabindex="0" title="直达执行者会话 · ' + escape(dispName) + '"' : "") + '>' + engIconHtml + (hasOwner ? "<b>" + escape(dispName) + "</b>" + (info.role ? "<i>" + escape(info.role) + "</i>" : "") : task.owner_session ? "<b>" + escape(dispName) + "</b><i>失联</i>" : "<b>未指派</b>") + "</span>"); // W-BOARDFUSE：引擎图标前置最前
                  // boardlife ③（用户口径「审查中的卡看得到谁在审、点了能跳过去」）：submitted
                  // 态挂处理者 chip——数据源=组内 PM 席位行（members role=pm，建团自动补入
                  // 先例）；在岗显示「审查中 · PM（昵称/短 sid）」并同链可点跳 PM 会话；无在岗
                  // PM 灰牌「待指派审查」（不挂牌不炸——数据缺席优雅降级）。
                  if (laneKey === "submitted") {
                    const pmRow = members(project).find((m) => String(m && m.role || "").toLowerCase() === "pm" && m.session_id);
                    if (pmRow) {
                      const pmName = String(pmRow.nick || "") || shortSid(pmRow.session_id);
                      ownerBits.push('<span class="tchip reviewer" data-team-member-session="' + escape(pmRow.session_id) + '" role="button" tabindex="0" title="审查中 · 点按直达 PM 会话">审查中 · ' + escape(pmName) + "</span>");
                    } else {
                      ownerBits.push('<span class="tchip reviewer-none" title="组内无在岗 PM 席位——过审收割前请指派审查人">待指派审查</span>');
                    }
                  }
                  // [W-SEAT-SEMANTICS]（用户 1101 拍板）done 卡时间维度：owner 已离席 → 小灰徽章
                  // 「已离席」（title 带成因三拆详情）；在席不显示（降噪）；旧 relay 无
                  // retired_entries（undefined）同样不显示=等价在席降噪，零破坏
                  if (isDone && task.owner_session && state.retiredEntries) {
                    const oret = state.retiredEntries.get(task.owner_session);
                    if (oret) {
                      const causeTxt = oret.cause === "manual" ? "手动除名" : oret.cause === "group-disband" ? "随组归档（组挂起/结项）" : oret.cause === "idle-trim" ? "闲置超时出编" : "离席（成因无记录）";
                      ownerBits.push('<span class="tchip retired-badge" title="承接者已离席 · ' + escape(causeTxt + (oret.detail ? " · " + oret.detail : "")) + '">已离席</span>');
                    }
                  }
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
                  // claimed=working/backlog·planned=idle（未开始族灰系）/submitted·ready_to_install=blocked（等外部）/done=closed
                  const stripe = task.gate ? "error" : ({ planned: "idle", backlog: "idle", claimed: "working", submitted: "blocked", ready_to_install: "blocked", done: "closed" })[laneKey] || "idle";
                  // planlane 批（1104 用户想法）：planned 卡面操作行——排产（→backlog 进派单面，
                  // 单步直发：方向天然、误触后果=卡回待认领可重建）与废弃（→done 带 note 留痕，
                  // 两步武装同 exp-retire 惯例：破坏性动作不裸奔）。状态机出口收窄在 relay
                  // resolveStatusTransition R4 单点，端上只发意图不重复判定。
                  const planActs = laneKey === "planned"
                    ? '<div class="task-planacts"><span class="tag action" role="button" tabindex="0" data-board-schedule="' + escape(task.id) + '" title="排产：规划中 → 待认领（进入可派单面）">排产</span><span class="tag danger" role="button" tabindex="0" data-board-scrap="' + escape(task.id) + '" title="废弃：规划中 → 完成（记「规划终止」，transitions 留痕）">废弃</span></div>'
                    : "";
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
                  // prchip（1104 用户问「pr 审查在泳道里有体现吗」）：PR 徽章 chip——审查期
                  // PR 可见可直达。数据源=板卡 pr_url/pr_state（relay orgAction pr-report 落值，
                  // SNAPSHOT/BOARD_UPDATED 透传，快照值不查 GitHub）；CI 点绿=ci_green/红=
                  // ci_red/灰=其余（ci_unknown/open，状态未明不猜）；merged 加 ✓。点击走
                  // __ccDeck005OpenUrl 统一开链（桌面 openExternal/浏览器降级复制）直达
                  // GitHub。无 pr_url 的旧卡零渲染（降级零破坏）。色轴=既有变量（--done/
                  // --error/--faint，禁新色）；词表锚=relay org-schema PR_STATES。
                  const prChip = (() => {
                    const url = String(task.pr_url || "");
                    if (!url || !/^https:\/\//i.test(url)) return "";
                    const st = String(task.pr_state || "ci_unknown");
                    if (!/^(open|merged|ci_green|ci_red|ci_unknown)$/.test(st)) return ""; // 异常值零渲染（词表外宽容跳过）
                    const dot = st === "ci_green" ? "ok" : st === "ci_red" ? "bad" : "mid";
                    const prNo = (url.match(/\/pull\/(\d+)/) || [])[1] || "PR";
                    const stTxt = st === "merged" ? "已合并" : st === "ci_green" ? "CI 绿" : st === "ci_red" ? "CI 红" : st === "open" ? "PR 开着" : "CI 状态未知";
                    return '<button type="button" class="tchip pr-chip" data-board-pr="' + escape(url) + '" title="PR #' + escape(prNo) + " · " + stTxt + " · 点击直达 GitHub（状态=上报快照，非实时）" + '"><i class="pr-dot ' + dot + '"></i>PR#' + escape(prNo) + (st === "merged" ? " ✓" : "") + "</button>";
                  })();
                  return '<div class="task-card compact' + (isDone ? " task-done" : "") + '" data-team-task="' + escape(task.id) + '" data-stripe="' + stripe + '"' + (prio ? ' data-priority="' + prio + '"' : "") + ' title="' + escape(fullText) + '"><div class="task-title">' + (subCount ? '<button type="button" class="sub-toggle' + (task.__subRunning ? " sub-running" : "") + (subAllDone ? " sub-all" : "") + '" data-board-toggle="' + escape(task.id) + '" title="子任务折叠/展开（#G3 父子链' + (task.__subRunning ? "——内有运行中子任务" : "") + (subAllDone ? "——批次齐活（全部子卡 done）" : "") + '）">' + (subOpen ? "▾" : "▸") + " " + subDone + "/" + subCount + "</button>" : "") + '<strong>' + (isDone ? "✓ " : "") + escape(faceText) + '</strong>' + (prio ? '<span class="tchip prio-' + prio.toLowerCase() + '" title="优先级 ' + prio + '（#G3）">' + prio + "</span>" : "") + prChip + (subAllDone ? '<span class="tchip sub-all-chip" title="批次齐活：全部子任务已完成（M2b 父子联动）">批次齐活</span>' : "") + selfCheckHtml + '</div>' + (task.note ? "<p>" + escape(task.note) + "</p>" : "") + '<div class="task-owner' + (hasOwner ? "" : " unassigned") + '">' + ownerBits.join("") + "</div>" + '<div class="task-cline">' + clineBits.join(' <i class="cline-sep">·</i> ') + "</div>" + planActs + (task.gate ? '<div class="task-flag">阻塞：' + escape(task.gate.reason || "等待人工解除") + "</div>" : "") + '<div class="task-pop"><b>' + escape(fullText) + "</b>" + (task.note ? "<p>" + escape(task.note) + "</p>" : "") + "<span>执行者：" + (hasOwner ? escape(dispName) + " · " + escape(info.role || "") : task.owner_session ? escape(dispName) + " · 失联" : "未指派") + " · 创建 " + created + " · 更新 " + updated + "</span>" + timeline + "</div>" + (subCount && subOpen ? '<div class="subtasks">' + (task.__subs || []).map((sub) => taskMarkup(sub, project)).join("") + "</div>" : "") + "</div>";
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
                  // W3P-P2-4：加载/空态互斥——board 已载（含空）不再出顶部空态条（五泳道
                  // 「暂无任务」即空态唯一表达，废除同屏双信号）；loading/未取得才出条。
                  const empty = !project ? projectsEmpty() : board ? "" : loading === "loading" ? "正在加载任务板…" : loading && loading !== "ready" ? loading : "尚未取得任务板，请接入详情命令通道或点击刷新详情。";
                  const laneLoading = !board && loading === "loading"; // W3P-P2-4：loading 期泳道给骨架不显「暂无任务」（防「正在加载+已空」并存）
                  // 件八：派单回执收敛行（同 dispatch_id 取末行）→ claimed 卡运行中/排队区分
                  const dispatchStatus = new Map((state.receipts.get(project?.id) || []).map((r) => [r && r.id, r && r.status]).filter(([id, st]) => id && typeof st === "string"));
                  const boardCounts = new Map(lanes.map(([status]) => [status, tasks.filter((task) => (legacyStatuses.get(task.status) || task.status) === status).length]));
                  const total = tasks.length;
                  // V8R 总览区（原型 .ov）：prog 8px 矩形分段（段色 --p-* 同名类映射）+ 方 chip
                  // 图例——去「任务板总览」重头行（计数并入图例，实时口径入 boardfoot）
                  // boardpolish（1105 用户实测）：「完成」段剥离出比例条——done 量级（1100+）
                  // 碾压活跃态（个位数）致比例条全绿、活跃分布不可辨（用户原话「别的类型都看
                  // 不出来比例」）。修=条内只分布五活跃态（backlog/planned/claimed/submitted/
                  // ready，图例同步），完成计数移条尾独立「✓ N」徽章（绿=--p-done 同源，
                  // title 带全量口径）；每段 title 带该类计数（hover 可辨）。t25fix #7 的
                  // flex-grow 按任务数+0 宽段不渲染+min-width 2px 底可见语义全保持。
                  const doneN = boardCounts.get("done") || 0;
                  const segLanes = lanes.filter(([status]) => status !== "done");
                  const boardOverview = '<div class="board-overview"><div class="board-progress-row"><div class="board-progress" aria-label="活跃任务分布（完成已移出）">' + segLanes.filter(([status]) => boardCounts.get(status) > 0).map(([status]) => '<i class="' + status + '" style="flex-grow:' + boardCounts.get(status) + '" title="' + (lanes.find(([s]) => s === status) || [status, status])[1] + ' ' + boardCounts.get(status) + '"></i>').join("") + '</div><span class="ov-done" title="完成 ' + doneN + '（量级碾压活跃态，已移出比例条）">✓ ' + doneN + "</span></div>" + '<div class="board-legend">' + segLanes.map(([status, label]) => '<span style="--legend-color:var(--p-' + (status === "ready_to_install" ? "ready" : status) + ')"><i></i>' + label + ' <b>' + boardCounts.get(status) + '</b></span>').join("") + '</div></div>'; /* t25fix #7：0 宽段不渲染（空段+分隔线堆叠=「全灰/被遮挡」观感），段宽 flex-grow 按任务数比例（gap 布局下百分比宽会溢出）；boardpolish：done 段+图例行剥离（✓ N 徽章承载） */
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
                  const boardGid = project?.id || "";
                  // lanehide：隐藏列退出列序（临时展开列照常渲染——laneHiddenNow 已内含临时态）；
                  // 停靠条聚合「隐藏且未临时展开」的列（计数徽章带 unhide 直达）。
                  const hiddenLanes = lanes.filter(([s]) => LANE_HIDEABLE.has(s) && laneHiddenNow(boardGid, s));
                  const columns = lanes.filter(([s]) => !hiddenLanes.some(([hs]) => hs === s)).map(([status, label]) => {
                    const items = tasks.filter((task) => (legacyStatuses.get(task.status) || task.status) === status);
                    let laneRes = laneBody(status, items);
                    let body = laneRes.html;
                    let visibleN = laneRes.visibleN;
                    // [W-SEAT-SEMANTICS] 板卡时间维度：done 泳道 >7 天陈卡折叠「已完成（早期）」
                    // 组（<details> 默认收起——卡面降噪；时间基线=updated_at 回落 ts，0 值不折）。
                    // 计数改近期可见数（折叠数在 summary 行自显）；未拆分路径零变化
                    if (status === "done" && items.length > 1) {
                      const cut = Date.now() - 7 * 86_400_000;
                      const stale = items.filter((t) => { const last = Number(t.updated_at || t.ts || 0); return last > 0 && last < cut; });
                      const recent = items.filter((t) => !stale.includes(t));
                      if (stale.length && recent.length) {
                        body = laneBody(status, recent).html + '<details class="lane-stale"><summary>已完成（早期） · ' + stale.length + '</summary><div class="lane-stale-body">' + laneBody(status, stale).html + "</div></details>";
                        visibleN = recent.length;
                      }
                    }
                    // V8R：待收单列 = 原型 bcol.go（⚡ 行动列：琥珀描边+光环+渐变头+列头琥珀字）
                    const headLabel = status === "ready_to_install" ? "⚡ " + label : label;
                    const inner = body || (laneLoading ? '<div class="lane-skel" aria-hidden="true"><i></i><i></i><i></i></div>' : '<div class="lane-empty">' + (status === "planned" ? "暂无规划——缓做想法（攒批/待评估）记在这里，排产后进待认领" : "暂无任务") + "</div>");
                    const gid = boardGid;
                    const ck = gid + ":" + status;
                    // lanehide：可隐藏列头带 ⋯ 菜单（隐藏此列/收起保持隐藏——归档胶囊方案②
                    // 预留升级位=菜单加项即得）；lanefold 折叠把手对这两列退役（用户拍板
                    // 隐藏形态，Linear 同款「status 列不折叠只隐藏」）。pop 徽章语义随列
                    // 头保留（临时展开列也提醒增量）。
                    const hideable = LANE_HIDEABLE.has(status);
                    const tempShown = hideable && laneTempUnhide.has((gid || "?") + ":" + status);
                    const popCls = hideable && laneLastCounts.has(ck) && visibleN > laneLastCounts.get(ck) ? " pop" : "";
                    laneLastCounts.set(ck, visibleN);
                    const menuBtn = hideable
                      ? '<button type="button" class="lane-menu-btn" data-lane-menu="' + status + '" data-lane-gid="' + escape(gid) + '" aria-haspopup="true" aria-label="列操作菜单">⋯</button><div class="lane-menu" data-lane-menu-panel="' + status + '" hidden>' + (tempShown
                        ? '<button type="button" class="lane-menu-item" data-lane-collapse="' + status + '" data-lane-gid="' + escape(gid) + '">⟨ 收起（保持隐藏）</button>'
                        : '<button type="button" class="lane-menu-item" data-lane-hide="' + status + '" data-lane-gid="' + escape(gid) + '">隐藏此列（板尾停靠条可找回）</button>') + "</div>"
                      : "";
                    const lane = '<div class="lane lane-' + status + (tempShown ? " lane-temp-shown" : "") + '"><div class="lane-head"><span>' + headLabel + '</span>' + (hideable ? '<span class="lane-badge' + popCls + '">' + visibleN + "</span>" : "<span>" + visibleN + "</span>") + menuBtn + "</div>" + inner + "</div>"; /* #G3 审查 B-P2-3：计数=可见卡数；W3P-P2-4 loading 骨架；planlane 空态指引；lanehide：列头 ⋯ 菜单+隐藏滤列（lanefold 折叠把手退役——1105 拍板方案①） */
                    return lane;
                  }).join("");
                  // lanehide：板尾停靠条——「⟨ 已隐藏：完成 N ▸」聚合 chip 逐列一枚（点击临时
                  // 展开尾列，刷新还原隐藏——临时态不写记忆）。空态（无隐藏列）零渲染。
                  const dockHtml = hiddenLanes.length
                    ? '<div class="lane-dock" data-lane-dock="' + escape(boardGid) + '">' + hiddenLanes.map(([s, label]) => '<button type="button" class="dock-chip" data-lane-unhide="' + s + '" data-lane-gid="' + escape(boardGid) + '" title="点击临时展开' + label + '列（不改变隐藏记忆，刷新还原）">⟨ 已隐藏：' + label + " " + (boardCounts.get(s) || 0) + " ▸</button>").join("") + "</div>"
                    : "";
                  const unknown = tasks.filter((task) => !lanes.some((lane) => lane[0] === (legacyStatuses.get(task.status) || task.status)));
                  // V8R boardfoot（原型 .boardfoot）：口径脚注——自验点语义 + 操作指引
                  const boardFoot = '<div class="boardfoot">板面实时同步 · 断线自动补齐 · 卡面 ✓✗○ = AI 自验进度，最终验收以确认卡为准 · 新建任务走来源会话派单</div>';
                  // boardfresh（1104 用户令）：龄戳+离线横幅——「这数据是几点的」可感知
                  const fmtHM = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
                  const freshAt = state.boardFreshAt.get(project?.id) || 0;
                  const staleMs = Date.now() - freshAt;
                  const freshHtml = freshAt ? '<div class="board-fresh" data-board-fresh="' + escape(project?.id || "") + '">更新于 ' + fmtHM(freshAt) + (staleMs > 600_000 ? ' <span class="board-fresh-stale">· 数据可能过期</span>' : "") + "</div>" : "";
                  const offlineHtml = !state.online ? '<div class="board-offline">离线——显示的是 ' + (freshAt ? fmtHM(freshAt) + " 的快照" : "旧数据（无龄戳）") + "</div>" : "";
                  return (empty ? banner(empty) : "") + (board?.frozen ? banner("任务板已冻结，只读展示。") : "") + offlineHtml + boardOverview + freshHtml + '<div class="board">' + columns + "</div>" + dockHtml + boardFoot + (unknown.length ? banner("以下任务状态未识别，保留原值，不归入完成。") + unknown.map((task) => taskMarkup(task, project)).join("") : "");
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
                  const moHadTeamCards = !!projectsEl.querySelector("[data-team-project]"); // W-UI-MOTION-BATCH：首装 stagger 沿判（下方挂点消费）
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
                    // W-UI-MOTION-BATCH 首装 stagger（window.__ccDeck005MoStagger=session 域单口）：
                    // 仅「无团队卡→有」沿触发一次（keyed reconcile 后续逐卡替换不重排）
                    if (!moHadTeamCards && projectsEl.querySelector("[data-team-project]")) window.__ccDeck005MoStagger?.(projectsEl);
                  } else {
                    projectsEl.innerHTML = projectsHtml;
                    if (!moHadTeamCards && projectsEl.querySelector("[data-team-project]")) window.__ccDeck005MoStagger?.(projectsEl); // W-UI-MOTION-BATCH：无 reconcile 兜底路径同款首装 stagger
                  }
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
                    // W3P-P1-2（1104 视觉补审）：空值兜底——标题缺项不再悬空分隔点（parts 过滤后
                    // join）；reason/owner 双空不渲染空 <p>；payload 空对象/无键不渲染裸 {} 行
                    //（原始 JSON 序列化禁直入 DOM——有载荷时才显示摘要行）。
                    const cfTitle = [confirmKinds.get(confirm.kind) || confirm.kind, confirm.title].filter((x) => typeof x === "string" && x.trim()).map(escape).join(" · ");
                    const cfReason = typeof confirm.reason === "string" && confirm.reason.trim() ? escape(confirm.reason) : "";
                    const cfMeta = [cfReason, owner ? escape(owner.name || owner.id) : ""].filter(Boolean).join(" · ");
                    const cfPayloadKeys = confirm.payload && typeof confirm.payload === "object" ? Object.keys(confirm.payload).filter((k) => confirm.payload[k] !== undefined && confirm.payload[k] !== null && confirm.payload[k] !== "") : [];
                    const cfPayloadLine = cfPayloadKeys.length ? '<div class="inspector-copy">' + escape(JSON.stringify(confirm.payload)) + "</div>" : "";
                    return '<div class="task-card" data-team-confirm="' + escape(confirm.id) + '"><div class="inspector-title"><strong>' + cfTitle + '</strong><span class="tag action">' + (state.accepted.has(confirm.id) ? "等待权威更新" : state.flights.has(confirm.id) ? "提交中" : "待你确认") + "</span></div>" + (cfMeta ? "<p>" + cfMeta + "</p>" : "") + cfPayloadLine + decisionButtons(confirm) + "</div>";
                  }).join("") : "";
                  tSigWrite(query("[data-team-confirms]"), "cf:" + tSigOf(confirmCards), count ? confirmCards : banner("暂无待确认事项")); // #282 三批 M2
                  // ---------- [W-AWAITUSER]（1104 用户令）「等你拍板」聚合入口（待办分区） ----------
                  // 数据=bridge.pendingUserActions（relay pending_user_actions 单源权威——端上
                  // 不拼三源）；null=旧 relay 能力缺席或清单空 → 整块 hidden（能力位口径同
                  // deliverables）。行=三源计数+直达对应面（确认卡→本域看板/会话→会话域
                  // 浮顶区/验收单→最早一张待填单）；消费掉帧驱动即减项（onEvent 消费
                  // PENDING_USER_ACTIONS_UPDATED 触发 render）。
                  // 双落位：检查器栏（窄窗可折叠）+ 看板 pane 底部「待你确认」区上方（恒可见
                  // ——检查器折叠态入口不失踪；点击委托共用 root 一处，两落位同链）
                  let auBoardHtml = "";
                  {
                    const auBridge = window.__ccDeck005B4;
                    const auItems = Array.isArray(auBridge && auBridge.pendingUserActions) ? auBridge.pendingUserActions.filter((x) => x && typeof x.kind === "string") : null;
                    const auBlock = query("[data-awaituser-block]");
                    if (auBlock) {
                      if (!auItems || !auItems.length) auBlock.hidden = true;
                      else {
                        auBlock.hidden = false;
                        const byKind = (k) => auItems.filter((x) => x.kind === k);
                        const cfN = byKind("org-confirm").length, wN = byKind("waiting").length, accN = byKind("acceptance").length;
                        const auCount = query("[data-awaituser-count]");
                        if (auCount) { auCount.textContent = String(auItems.length); auCount.hidden = false; auCount.setAttribute("aria-label", "等你拍板 " + auItems.length + " 项"); }
                        const auRow = (label, n, jump, title, extra) => n
                          ? '<button type="button" class="awaitu-row" data-awaitu-jump="' + jump + '"' + (extra || "") + ' title="' + escape(title) + '"><strong>' + escape(label) + '</strong><span class="tag action">' + n + " 项</span><span class=\"chev\">›</span></button>"
                          : "";
                        // awaituser R1（A 审 P2②）：relay 清单 created_at 降序（最新在前），
                        // byKind[0] 实开最新而文案「最早一张」名实不符——取法修正为升序首张
                        //（挂得最久最该先回填，FIFO 合文案；不改 relay 总序——聚合清单
                        // 「最新优先」是展示语义）。二选一注明：弃文案改「最新」案。
                        const firstAcc = [...byKind("acceptance")].sort((a, b) => (a.created_at || 0) - (b.created_at || 0))[0];
                        const auRowsHtml = auRow("组织确认卡", cfN, "confirm", "去团队看板下的「待你确认」区决议")
                          + auRow("等你输入的会话", wN, "session", "去会话列表——等你拍板的会话已浮顶带角标")
                          + auRow("待回填验收单", accN, "acceptance", "打开最早一张待填验收单", firstAcc && typeof firstAcc.entity_id === "string" ? ' data-awaitu-acc="' + escape(firstAcc.entity_id) + '"' : "");
                        tSigWrite(query("[data-awaituser-rows]"), "au:" + tSigOf(auRowsHtml), auRowsHtml || banner("暂无待拍板事项"));
                        auBoardHtml = '<div class="inspector-block"><div class="inspector-title"><span>等你拍板 · ' + auItems.length + '</span><span class="tag action">' + auItems.length + "</span></div>" + auRowsHtml + "</div>";
                      }
                    }
                  }
                  // W-DESIGNHUB（用户澄清并入）：看板挂载——系统设计图纸区。图纸匹配同项目域
                  // 口径（name/锚点分词 ∩ tags 子串双向）。输出物原第二区已迁独立「输出」tab
                  // （W-OUTTAB，用户 1015 拍板：输出物不放看板里）
                  const boardFinal = boardMarkup(project)
                    + auBoardHtml // [W-AWAITUSER] 看板 pane 底部聚合入口（恒可见位；检查器折叠态不失踪）
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
                  state.boardFreshAt.set(gid, Date.now()); // boardfresh：detail ack 落地=龄戳写点①
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
                    if (epoch === state.epoch && state.projects?.some((item) => item.id === gid)) { const raw = String(error?.message || error); state.loads.set(gid, "详情加载失败：" + raw); console.warn("[team] 详情加载失败（原文）:", raw); feedback("详情加载失败，请重试", "error"); render(); } /* W3P-P2-5：人话文案+错误级样式（内部术语进 console 不上 UI） */
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
                  state.boardFreshAt.clear(); // boardfresh：换代清龄戳（旧板已无效——重拉后重记）
                  state._freshLastAt = 0; // boardfresh 时机②：SNAPSHOT 落地=重连成功确证（每次连接全量带板）——清节流让下方选中组重拉必发
                  state.source = context?.relayName || payload.relay_name || "当前来源";
                  state.sessions = new Map((Array.isArray(payload.sessions) ? payload.sessions : []).filter((session) => session && typeof session.session_id === "string").map((session) => [session.session_id, session]));
                  // [W-SEAT-SEMANTICS] 离席富化面锚定（能力位=Map 在场；缺席=旧 relay——板卡
                  // done 徽章不渲染=在席降噪语义，等价于「present 时不显示」）
                  state.retiredEntries = Array.isArray(payload.retired_entries) ? new Map(payload.retired_entries.filter((e) => e && typeof e.session_id === "string").map((e) => [e.session_id, e])) : undefined;
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
                  for (const board of Array.isArray(payload.boards) ? payload.boards : []) if (board && state.projects?.some((item) => item.id === board.gid) && Array.isArray(board.entries)) { state.boards.set(board.gid, board); state.boardFreshAt.set(board.gid, Date.now()); } // boardfresh：SNAPSHOT 板直落=龄戳写点②
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
                  if (message?.type === "BOARD_UPDATED" && typeof payload?.gid === "string" && payload.board?.gid === payload.gid && Array.isArray(payload.board.entries) && state.projects?.some((item) => item.id === payload.gid)) { state.boards.set(payload.gid, payload.board); state.boardFreshAt.set(payload.gid, Date.now()); render(); if (payload.gid === state.selected) void requestDetail(payload.gid, true); return true; }
                  // boardfresh 治本：板摘要对账（resume 快路径补发——瞬态板变更断连窗补不到的根治）。
                  // 失配 gid → requestDetail force 重拉（既有通道）；缺席 gid 本地保留（板组可能已删，
                  // 下次 SNAPSHOT 清）。公式=ws-server fnv1a 同式（`${id}:${status}` 有序 join 后 FNV-1a 32）
                  if (message?.type === "BOARDS_DIGEST" && Array.isArray(payload?.boards)) {
                    const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
                    let mismatch = [];
                    for (const d of payload.boards) {
                      if (!d || typeof d.gid !== "string") continue;
                      const local = state.boards.get(d.gid);
                      if (!local) continue; // 本地无板（未拉过）——不强行拉（进组时自然拉）
                      const rev = fnv((Array.isArray(local.entries) ? local.entries : []).map((e) => e.id + ":" + (e.status ?? "")).sort().join("|"));
                      if (rev !== d.rev || (local.entries?.length ?? 0) !== d.n) mismatch.push(d.gid);
                    }
                    if (mismatch.length) { console.info("[team] boardfresh 对账失配 " + mismatch.length + " 组，重拉：" + mismatch.join(",")); for (const gid of mismatch) void requestDetail(gid, true); }
                    return true;
                  } // boardfresh：帧落地=龄戳写点③
                  // W-EXPP2 经验域帧：帧双载恒带 entries 全量 → 覆盖式消费（未锚定=experiences
                  // null 时同帧即锚定——SNAPSHOT 先行兜底过，此处权威刷新）；expArm/expForm 保持
                  if (message?.type === "EXPERIENCE_UPDATED" && Array.isArray(payload?.entries)) { updateExperiences(payload.entries); render(); return true; }
                  // W-RULES2 铁律域帧（EXPERIENCE_UPDATED 同构）：覆盖式消费；rulesArm/rulesForm 保持
                  if (message?.type === "RULES_UPDATED" && Array.isArray(payload?.entries)) { updateRules(payload.entries); render(); return true; }
                  // [W-SEAT-SEMANTICS] 离席名单/成因增量帧（settings wrapper 透传）——板卡 done
                  // 徽章与组名三拆的实时刷新面；帧缺 entries 保旧值（relay 读账降级）
                  if (message?.type === "RETIRED_SESSIONS_UPDATED") {
                    if (Array.isArray(payload?.retired_entries)) state.retiredEntries = new Map(payload.retired_entries.filter((e) => e && typeof e.session_id === "string").map((e) => [e.session_id, e]));
                    else if (Array.isArray(payload?.retired_session_ids) && state.retiredEntries) { const live = new Set(payload.retired_session_ids.filter((x) => typeof x === "string")); for (const k of [...state.retiredEntries.keys()]) if (!live.has(k)) state.retiredEntries.delete(k); }
                    render();
                    return true;
                  }
                  // [W-AWAITUSER] 聚合清单帧（数据面在 bridge.pendingUserActions 由 B4 桥维护；
                  // 此处只触发本域 render——「等你拍板」入口/待你确认区随清单收敛，消费即减项）
                  if (message?.type === "PENDING_USER_ACTIONS_UPDATED") { render(); return true; }
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
                  // W-AGGREGATE-V1：放开 external 滤——野生 CLI 会话（用户自开窗口）是聚合
                  // 推荐的目标场景主体（PCS 多窗口），可勾入编；语义=只挂名观察（#279 纳管
                  // 不管制）：观察位以 pm 身份行挂名（PM 行不接派单+relay seatGate 对 pm 词表
                  // 角色豁免外部门禁——零 relay 改动的现成通道），不接派单不被打断；真要转正
                  // 接活须换 deck 托管会话补员（行内 title 注明）。候选排序托管优先（野生垫底
                  // 不挤占常规建团视野）。
                  // W-AGGREGATE-V1 配套：候选池兜底 B4 桥数据——聚合推荐条从**项目域**直开
                  // 建团弹窗（ccDeckTeam.openTeamCreate）时，本域可能尚未锚定快照（Team.onFrame
                  // 视角门——域激活补喂前的窗口），state.sessions 空=预勾全员落空；B4 桥
                  // sessions 全量双源持有（项目域桶卡同源——推荐链路数据一致性），空时回落。
                  let pool = state.sessions;
                  if (!pool || pool.size === 0) {
                    const b4 = window.__ccDeck005B4;
                    if (b4 && b4.sessions && typeof b4.sessions.values === "function") pool = b4.sessions;
                  }
                  return [...pool.values()]
                    .filter((x) => x && typeof x.session_id === "string")
                    .filter((x) => {
                      const src = String(x.relay_source || x.source || "");
                      // W-AGGREGATE-V1：lanName 空/未知（单源形态·探测未完成）=不按源滤
                      //（Team 链可能已给 sessions 打 relay_source 源标——无源名对照时全滤
                      // 会清空候选池，聚合推荐直开弹窗形态首当其冲）
                      if (which !== "cloud" && !lanName) return true;
                      return which === "cloud" ? src === cloudName : (!src || src === lanName);
                    })
                    .sort((a, b) => (Number(a.external === true) - Number(b.external === true)) || (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0))
                    .slice(0, 12);
                }
                // 候选行 v2（#277 美化）：去引擎徽标（引擎身份归成员卡头像，行内省空间防截断）
                function teamCandListHtml(cands) {
                  if (!cands.length) return '<div class="team-empty-row"><span>该源暂无可入编会话，可先建团稍后补员</span><button type="button" class="team-add-btn" data-team-add-member>＋ 添加</button></div>'; // W-TEAMPOPOLISH B4：空态一行紧凑（banner+添加钮合并）
                  return '<div class="team-cand-list" data-team-cands>' + cands.map((x) =>
                    '<label class="create-check team-cand' + (x.external ? " team-cand-ext" : "") + '" title="' + escape(x.external ? "野生会话 · 观察位入编（不接派单不被打断；转正接活须换 deck 托管会话补员）" : "") + '"><input type="checkbox" data-team-member="' + escape(x.session_id) + '"' + (x.external ? ' data-team-member-ext="1"' : "") + '>'
                    + '<span class="team-cand-name">' + escape(x.title || x.session_id.slice(0, 12)) + '</span>'
                    + (x.external ? '<span class="cand-ext-badge">野生·观察</span>' : "")
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
                // W-TEAMPOPOLISH B1（1105 用户令·三路审查）：loopback 分支——本机源可浏览时
                // 文案与浏览钮真值联动（消灭「非当前浏览器电脑」的自相矛盾）；A4+C4 文案
                // 全线砍短（≤32 字当量单行，word-break 兜底在 CSS）
                function teamAnchorHint(which) {
                  const plat = window.__ccDeck005PlatformFor ? window.__ccDeck005PlatformFor(which) : null;
                  const posix = "形如 /Users/名字/项目";
                  const win = "形如 C:\\Users\\名字\\项目";
                  if (which !== "cloud" && teamAnchorBrowseable(which)) return "路径在本机 relay 上，可点浏览直接选择";
                  if (which === "cloud") {
                    if (plat === "win32") return "路径在那台电脑（Windows）上——" + win;
                    if (plat) return "路径在那台电脑上——" + posix;
                    return "路径在那台电脑上——按它的系统填绝对路径";
                  }
                  if (plat === "win32") return "路径在 relay 宿主机（Windows）上——" + win;
                  if (plat) return "路径在 relay 宿主机上——" + posix;
                  return "路径在 relay 宿主机上——Mac/Linux " + posix + "，Windows " + win;
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
                  pop.querySelector("[data-team-cand-wrap] .team-empty-row")?.remove(); // W-TEAMPOPOLISH B4：首条手动行入列即撤空态行
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
                // W-TEAMPOPOLISH B2/P3（1105 三路审查）：立项档后果文案——决策点可见（动态 hint
                // 随选项切换），选项标签自身砍短去实现术语（「单卡简化态」→后果语言）
                const TEAM_TIER_HINTS = { "轻立项": "创建即生效，日常免确认", "正经立项": "提交后在确认卡上等你决议" };
                function teamTierHint(v) { return TEAM_TIER_HINTS[v] || ""; }
                // W-TEAMPOPOLISH B3：blur 内联校验——错误就近落字段（.create-err 描边+尾随一行
                // .create-err-note），提交前看得见；toast 只留传输层失败（submitTeamCreate 的
                // command/网络错误），前置格式/重名检查全走此处
                function teamFieldErr(pop, field, msg) {
                  const el = pop.querySelector("[data-team-field='" + field + "']");
                  if (!el) return;
                  let note = el.parentElement.querySelector(":scope > .create-err-note, :scope + .create-err-note") || pop.querySelector('.create-err-note[data-for="' + field + '"]');
                  if (!msg) {
                    el.classList.remove("create-err");
                    if (note) note.remove();
                    return;
                  }
                  el.classList.add("create-err");
                  if (!note) {
                    note = document.createElement("div");
                    note.className = "create-err-note";
                    note.dataset.for = field;
                    (el.closest(".create-inline") || el).after(note);
                  }
                  note.textContent = msg;
                }
                function teamNameValidate(pop) {
                  const name = String(pop.querySelector("[data-team-field='name']")?.value ?? "").trim();
                  if (!name) { teamFieldErr(pop, "name", "先填团队名"); return false; }
                  if ((state.projects || []).some((p) => p && p.name === name)) { teamFieldErr(pop, "name", "已有同名团队，换个名字"); return false; }
                  teamFieldErr(pop, "name", "");
                  return true;
                }
                function teamAnchorValidate(pop) {
                  const anchor = String(pop.querySelector("[data-team-field='anchor']")?.value ?? "").trim();
                  if (!anchorFormatOk(anchor)) { teamFieldErr(pop, "anchor", "需绝对路径：Mac/Linux 形如 /Users/…，Windows 形如 C:\\…"); return false; }
                  teamFieldErr(pop, "anchor", "");
                  return true;
                }
                // W-TEAMPOPOLISH ⑭（1105）：预填入参位——openTeamCreate(prefill)（name/anchor/
                // members/tier/origin）。本单只留参数位与「来自聚合推荐」溯源小注位（origin 一
                // 句话）；消费方（聚合推荐单）后续接入，缺省 null 行为与旧版逐字节一致
                function openTeamCreate(prefill = null) {
                  closeTeamCreate();
                  const pf = (prefill && typeof prefill === "object") ? prefill : null;
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
                  // W-AGGBUG（1109）：prefill.source 优先——聚合预填 8 会话全同源时弹窗源随成员源
                  // （消灭「云视角下 defSrc=cloud 而 8 成员全在本机」的错位面）；无 prefill/值非法时
                  // 维持视角判定（旧行为不变）
                  const pfSrc = pf && (pf.source === "local" || pf.source === "cloud") ? pf.source : null;
                  const defSrc = pfSrc || ((window.__ccDeck005SourceState && window.__ccDeck005SourceState())?.view === "cloud" ? "cloud" : "local");
                  const defCands = teamCandsForSource(defSrc, st);
                  // #277 ① 弹窗重设计 + W-TEAMPOPOLISH（1105 三路审查落地）：
                  // B2 头部副标题退役（答案在决策点：tier 动态 hint）；B4 团队名+立项档并排两列行；
                  // A4/C4 文案砍短+术语后果化（「一锚一团」「单卡简化态」退役）
                  let html = '<div class="create-head"><h3>新建团队</h3><button type="button" class="create-x" data-team-close aria-label="关闭" title="关闭">✕</button></div>';
                  if (pf && pf.origin) html += '<div class="create-hint" data-team-origin-note>来自聚合推荐：' + escape(String(pf.origin)) + "</div>";
                  if (st) {
                    html += '<div class="create-label">创建到</div><select class="create-field" data-team-field="source" aria-label="目标源">'
                      + '<option value="local"' + (defSrc === "local" ? " selected" : "") + '>本机 · ' + escape(String(st.lanRelayName || "本机")) + '</option>'
                      + '<option value="cloud"' + (defSrc === "cloud" ? " selected" : "") + '>远程 · ' + escape(String(st.cloudRelayName || st.cloudWsUrl || "远程源")) + '</option></select>';
                  }
                  const pfTier = pf && (pf.tier === "轻立项" || pf.tier === "正经立项") ? pf.tier : "轻立项";
                  html += '<div class="create-two"><div class="create-two-col"><div class="create-label">团队名</div><input class="create-field" data-team-field="name" placeholder="如：redbook 推广" aria-label="团队名" value="' + escape(pf && pf.name ? String(pf.name) : "") + '"></div>'
                    + '<div class="create-two-col"><div class="create-label">立项档</div><select class="create-field" data-team-field="tier" aria-label="立项档">'
                    + '<option value="轻立项"' + (pfTier === "轻立项" ? " selected" : "") + '>轻量项目（日常免确认）</option>'
                    + '<option value="正经立项"' + (pfTier === "正经立项" ? " selected" : "") + '>正式项目（需你确认）</option></select></div></div>';
                  html += '<div class="create-hint" data-team-tier-hint>' + escape(teamTierHint(pfTier)) + "</div>";
                  html += '<div class="create-label">锚点目录</div><div class="create-inline"><input class="create-field" data-team-field="anchor" placeholder="项目绝对路径（在 relay 宿主机上）" aria-label="锚点目录" value="' + escape(pf && pf.anchor ? String(pf.anchor) : teamCwdDefault()) + '">'
                    + '<button type="button" class="create-browse" data-team-anchor-browse title="从文件管理器选择目录" hidden>浏览</button></div>';
                  html += '<div class="create-hint" data-team-anchor-hint>路径在 relay 宿主机上，不是当前浏览器电脑</div>';
                  // W-AGGREGATE-V2 刀3：簇预填附锚列表（V1 五字段扩展——dirs 来自归一推荐卡；
                  // 主锚=锚字段，附锚只读注呈现+随创建提交 anchor_dirs；人工建团无 dirs 零变化）
                  const pfDirs = (pf && Array.isArray(pf.dirs) ? pf.dirs : []).filter((d) => typeof d === "string" && d && d !== (pf && pf.anchor));
                  if (pfDirs.length) html += '<div class="create-hint" data-team-anchor-dirs>附锚（同 origin clone 目录 ×' + pfDirs.length + '，随团多锚归一）：' + escape(pfDirs.join("；")) + "</div>";
                  // #277 ③：成员候选随源切换（relay_source 对位），切源即时重灌本容器
                  // W-TEAMPOPOLISH B4：空态 banner 与添加钮合并一行紧凑空态（非空时底部添加钮照旧）
                  html += '<div class="create-label">成员编制 · 最多 8 席</div><div data-team-cand-wrap>' + teamCandListHtml(defCands) + "</div>";
                  if (!state.online || !state.command) html += banner("命令通道未接入，无法提交创建。");
                  html += '<datalist id="team-role-list">' + TEAM_ROLE_PRESETS.map((r) => '<option value="' + escape(r) + '"></option>').join("") + "</datalist>";
                  if (defCands.length) html += '<button type="button" class="team-add-btn" data-team-add-member>＋ 添加成员</button>';
                  if (defCands.length) html += '<div class="create-label">角色模板</div><select class="create-field" data-team-field="template" aria-label="角色模板"><option value="pm-led">PM 带队（当前选中会话任 PM，勾选成员为 worker）</option><option value="worker">统一 worker（默认执行者）</option><option value="PM">统一 PM（项目管理）</option><option value="free">自由编制（逐人指定）</option></select>';
                  html += '<div class="create-actions"><button class="secondary-btn" type="button" data-team-cancel>取消</button><button class="primary-btn" type="button" data-team-submit>创建团队</button></div>';
                  pop.innerHTML = html;
                  if (pf && Array.isArray(pf.members)) {
                    // ⑭ 参数位：预勾选成员（sid 命中候选行；命中数留 console 审计面，消费方接入后可验）
                    let hit = 0;
                    for (const sid of pf.members) {
                      const box = pop.querySelector('[data-team-member="' + cssEscape(String(sid)) + '"]');
                      if (box && !box.checked) { box.checked = true; hit++; }
                    }
                    if (hit) console.log("[team-create] prefill members 命中 " + hit + "/" + pf.members.length);
                  }
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
                    const tierSel = ev.target.closest("[data-team-field='tier']"); // W-TEAMPOPOLISH B2：档位后果 hint 随选项切换
                    if (tierSel) {
                      const th = pop.querySelector("[data-team-tier-hint]");
                      if (th) th.textContent = teamTierHint(tierSel.value);
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
                  pop.addEventListener("focusout", (ev) => { // W-TEAMPOPOLISH B3：blur 内联校验（blur 不冒泡，focusout 对偶面）
                    if (ev.target.closest?.("[data-team-field='name']")) { teamNameValidate(pop); return; }
                    if (ev.target.closest?.("[data-team-field='anchor']")) teamAnchorValidate(pop);
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
                  // W-TEAMPOPOLISH B3：前置校验走内联（blur 同源函数——错误就近显示在字段上），
                  // toast 只留传输层失败（下方 command/catch 分支）；重名对照在 blur 已即时暴露，
                  // 提交时再核一次防串行窗口（列表在弹窗打开期间刷新）
                  if (!teamNameValidate(pop) || !teamAnchorValidate(pop)) return;
                  const headcount = [...pop.querySelectorAll("[data-team-member]")].filter((el) => el.checked).map((el) => {
                    const sid = el.dataset.teamMember;
                    const roleInput = pop.querySelector("[data-team-role='" + cssEscape(sid) + "']");
                    let role = template === "free" ? String(roleInput?.value ?? "").trim() : template === "pm-led" ? "worker" : template;
                    // W-AGGREGATE-V1：野生（external）勾选行角色强制 pm 身份行——观察位语义
                    //（#279 纳管不管制：挂名可见不接派单）。relay seatGate 对 worker 席拒
                    // external（整单拒连累其他成员）；pm 词表角色豁免外部门禁（PM 行不接
                    // 派单=现成观察通道）。用户改角色也拦回（free 模式手填无效——防误配
                    // 触发整单拒）。
                    if (el.dataset.teamMemberExt === "1") role = "pm";
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
                      // W-AGGBUG（1109 用户实锤）：out 从整单硬拦降级为不带 PM 行——PM 人选是
                      // 「会话列表残留选中」的隐式默认（用户未显式指定），源不匹配时缺席降级
                      // 与 absent 同质（先例：absent 分支早已降级）；原硬拦=8 本机成员无辜陪绑
                      // （用户被挡在建团外，文案不点名 sid 又归因成「成员不在本机源」）。跨源
                      // 防线不撤：成员面候选过滤（relay_source 对位）+relay seatGate 权威闸原样。
                      if (v.verdict === "out") {
                        feedback("当前选中会话（" + pmSid.slice(0, 6) + "…）不在" + srcLabel + "——本团未带 PM 行，可稍后在编制面板补任 PM");
                        pmSidOut.v = "";
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
                    // W-AGGREGATE-V2 刀3：附锚随创建提交（主锚=anchor_dir 恒首；簇预填外的手工建团无附锚零变化）
                    const extraDirsEl = pop.querySelector("[data-team-anchor-dirs]");
                    const extraDirs = extraDirsEl ? pfDirs.filter((d) => d !== anchor) : [];
                    const result = verdict(await state.command("COMMAND_ORG_ACTION", { action: "create", name, anchor_dir: anchor, tier, ...(headcount.length ? { headcount } : {}), ...(extraDirs.length ? { anchor_dirs: extraDirs } : {}), ...(pmSidOut.v ? { pm_session_id: pmSidOut.v } : {}) }, undefined, wsOverride));
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
                // planlane 批（1104 用户想法）：planned 卡操作单漏斗——排产（board move →backlog
                // 进派单面）/废弃（board upsert →done 带 note 留痕，transitions 由 relay 两写口
                // 统一追加）。状态机合法性（R4 出口收窄）在 relay 单点裁决，端上不重复判定；
                // BOARD_UPDATED 帧推送即时回渲。废弃 note 追加不覆写（卡自带 note 保留）。
                async function planLaneOp(entryId, to) {
                  const gid = state.selected;
                  if (!gid || !state.command || !state.online) { toast("未选中团队或离线——稍后再试"); return; }
                  const flight = "board-plan-" + entryId + "-" + to;
                  if (state.flights.has(flight)) return;
                  const board = state.boards.get(gid);
                  const card = board && Array.isArray(board.entries) ? board.entries.find((x) => x && x.id === entryId) : null;
                  if (!card) { toast("板数据未同步——刷新后重试"); return; }
                  state.flights.add(flight);
                  render();
                  try {
                    const result = to === "backlog"
                      ? verdict(await state.command("COMMAND_ORG_ACTION", { action: "board", op: "move", gid, entry_id: entryId, status: "backlog" }, undefined, undefined))
                      : verdict(await state.command("COMMAND_ORG_ACTION", { action: "board", op: "upsert", gid, entry_id: entryId, text: String(card.text || ""), status: "done", note: ((card.note ? String(card.note) + "\n" : "") + "[规划废弃 " + new Date().toLocaleDateString("zh-CN") + "] 规划终止（规划中泳道废弃钮）") }, undefined, undefined));
                    if (!result.ok) { rememberUnsupported("COMMAND_ORG_ACTION", result.error); feedback("操作失败：" + result.error); toast("操作失败：" + result.error); return; }
                    feedback(to === "backlog" ? "已排产：卡进入待认领（可派单面）。" : "已废弃：卡收口完成，卡面留痕。");
                  } catch (error) {
                    feedback("操作失败：" + String(error?.message || error));
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
                  // ---------- boardfresh（1104 用户令·板面说谎第三现）：三时机强刷+龄戳 ----------
                  // 服务端已验清白（板唯一事实源全终态+SNAPSHOT 全量带板+512KB 守卫未触发），
                  // 病灶=端上断连/云桥腿断时无感渲染旧缓存。三时机（回前台/重连落地/切看板 tab）
                  // 主动拉新——走既有 requestDetail force 通道（1013 件9 同口），禁新建旁路。
                  // 5s 节流：三时机与 BOARD_UPDATED 帧叠加防抖（帧本身即新鲜，强刷只为兜底）。
                  function refreshBoardFresh(reason) {
                    if (!state.command || !state.online) return; // 离线不空转（恢复连接走 SNAPSHOT 落地时机）
                    const now = Date.now();
                    if (now - state._freshLastAt < 5000) return;
                    state._freshLastAt = now;
                    if (state.selected) void requestDetail(state.selected, true);
                    console.info("[team] boardfresh 强刷：" + reason);
                  }
                  // 时机①web：visibilitychange visible（回前台——云桥僵死期间页面冻结无渲染，
                  // 回前台必查一次）
                  document.addEventListener("visibilitychange", () => {
                    if (document.visibilityState === "visible") refreshBoardFresh("visibility-visible");
                  });
                  // 龄戳自检（60s）：页面停在看板无渲染时「>10min 数据可能过期」灰字自己浮现——
                  // 不整板重渲（只改 .board-fresh 行文本），冻结态用户也能看到数据龄在涨
                  setInterval(() => {
                    const el = root.querySelector("[data-board-fresh]");
                    if (!el) return;
                    const gid = el.getAttribute("data-board-fresh");
                    const at = state.boardFreshAt.get(gid) || 0;
                    if (!at) return;
                    const d = new Date(at);
                    el.innerHTML = "更新于 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + (Date.now() - at > 600_000 ? ' <span class="board-fresh-stale">· 数据可能过期</span>' : "");
                  }, 60_000);
                  // 时机③：切看板 tab（segment-bar 第 2 钮=看板，地基管 active/pane，此处只挂强刷钩）
                  root.addEventListener("click", (event) => {
                    const segBtn = event.target && event.target.closest ? event.target.closest(".segment-bar button") : null;
                    if (segBtn && [...root.querySelectorAll(".segment-bar button")].indexOf(segBtn) === 1) refreshBoardFresh("tab-看板");
                  }, true);
                  // lanefold（1104）：泳道头=抽屉把手——点击/Enter/空格 开合；开=记忆+卡片轻上浮
                  // （just-opened 一次性类，260ms 后自摘——render 重建不重播）；合=记忆+焦点保留。
                  const laneFoldToggle = (head) => {
                    const lane = head.closest(".lane-fold");
                    if (!lane) return;
                    const status = head.dataset.laneFold, gid = head.dataset.laneGid || "";
                    const open = !lane.classList.contains("lane-open");
                    lane.classList.toggle("lane-open", open);
                    lane.classList.toggle("lane-closed", !open);
                    head.setAttribute("aria-expanded", String(open));
                    laneFoldSet(gid, status, open);
                    if (open) { const din = lane.querySelector(".lane-drawer-in"); if (din) { din.classList.add("just-opened"); setTimeout(() => din.classList.remove("just-opened"), 260); } }
                  };
                  root.addEventListener("click", (event) => {
                    const head = event.target && event.target.closest ? event.target.closest(".lane-fold-head") : null;
                    if (head) laneFoldToggle(head);
                  });
                  root.addEventListener("keydown", (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    const head = event.target && event.target.closest ? event.target.closest(".lane-fold-head") : null;
                    if (head) { event.preventDefault(); laneFoldToggle(head); }
                  });
                  // lanehide（1105 拍板方案①）：列头 ⋯ 菜单开合/隐藏/临时展开收起 + 板尾停靠条
                  // unhide。隐藏=记忆+列退出列序（四核心列吃回全宽）；临时展开=内存集（刷新还原）；
                  // 停靠条 chip 点击临时展开。列增删走 render() 全量重渲（结构变化无局部更新价值）。
                  root.addEventListener("click", (event) => {
                    const t = event.target;
                    if (!t || !t.closest) return;
                    const menuBtn = t.closest(".lane-menu-btn");
                    if (menuBtn) {
                      const panel = menuBtn.parentElement && menuBtn.parentElement.querySelector('.lane-menu[data-lane-menu-panel="' + menuBtn.dataset.laneMenu + '"]');
                      if (panel) {
                        const wasHidden = panel.hidden;
                        root.querySelectorAll(".lane-menu:not([hidden])").forEach((m) => { m.hidden = true; });
                        panel.hidden = !wasHidden;
                      }
                      return;
                    }
                    const hideItem = t.closest("[data-lane-hide]");
                    if (hideItem) {
                      laneHideSet(hideItem.dataset.laneGid || "", hideItem.dataset.laneHide, true);
                      render();
                      return;
                    }
                    const collapseItem = t.closest("[data-lane-collapse]");
                    if (collapseItem) {
                      laneTempUnhide.delete((collapseItem.dataset.laneGid || "?") + ":" + collapseItem.dataset.laneCollapse);
                      render();
                      return;
                    }
                    const unhideChip = t.closest("[data-lane-unhide]");
                    if (unhideChip) {
                      laneTempUnhide.add((unhideChip.dataset.laneGid || "?") + ":" + unhideChip.dataset.laneUnhide);
                      render();
                      return;
                    }
                    // 点外收起所有列菜单
                    if (!t.closest(".lane-menu")) root.querySelectorAll(".lane-menu:not([hidden])").forEach((m) => { m.hidden = true; });
                  });
                  root.addEventListener("click", (event) => {
                    // [W-AWAITUSER]「等你拍板」入口行：直达对应面（数据行由 render 写入，
                    // 点击只做跳转——确认卡→本域看板 tab（待你确认区随板）/会话→会话域
                    //（等你拍板会话已浮顶）/验收单→直接打开最早一张待填单）
                    const auJump = event.target.closest("[data-awaitu-jump]");
                    if (auJump) {
                      const kind = auJump.dataset.awaituJump;
                      const b4 = window.__ccDeck005B4;
                      if (kind === "confirm") {
                        b4?.clickTab?.("#d-team .segment-bar", "看板");
                        toast("已切到看板——待你确认区在本页下方");
                      } else if (kind === "session") {
                        b4?.railJump?.("session");
                      } else if (kind === "acceptance" && auJump.dataset.awaituAcc) {
                        b4?.openAcceptance?.(auJump.dataset.awaituAcc);
                      }
                      return;
                    }
                    // FB4 团域新建：真表单（团队名/锚点/档位/成员多选），不再代理会话域新建会话弹窗
                    const newSession = event.target.closest("[data-team-new-session]");
                    if (newSession) {
                      event.stopPropagation();
                      openTeamCreate();
                      return;
                    }
                    // X0 件3：复制入队指令（org join 当前选中组）——新会话可发现性主通道；
                    // 无选中组时提示先选（复制体走 clipboard API，降级 execCommand 兜底）
                    const copyJoin = event.target.closest("[data-team-copy-join]");
                    if (copyJoin) {
                      event.stopPropagation();
                      const g = group();
                      if (!g) { toast("先在左侧选中一个团队，再复制入队指令"); return; }
                      const cmd = `~/.cc-deck/bin/org join ${g.id}`;
                      const done = () => toast("已复制入队指令：" + cmd);
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(cmd).then(done, () => { try { window.prompt("手动复制入队指令：", cmd); } catch (_) {} });
                      } else { try { window.prompt("手动复制入队指令：", cmd); } catch (_) {} }
                      return;
                    }
                    const memberSession = event.target.closest("[data-team-member-session]");
                    if (memberSession) {
                      event.stopPropagation();
                      window.__ccDeck005B4?.railJump?.("session");
                      window.__ccDeck005B4?.selectSessionCard?.(memberSession.dataset.teamMemberSession);
                      return;
                    }
                    // prchip：PR 徽章直达——统一开链（桌面 openExternal/浏览器降级复制），
                    // stopPropagation 防误触选卡；URL 已在渲染层 https 白名单过闸
                    const prOpen = event.target.closest("[data-board-pr]");
                    if (prOpen) {
                      event.stopPropagation();
                      const prUrl = String(prOpen.dataset.boardPr || "");
                      if (prUrl && window.__ccDeck005OpenUrl) void window.__ccDeck005OpenUrl(prUrl);
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
                    // planlane：planned 卡操作——排产单步直发；废弃两步武装（首点变「确认废弃？」
                    // 再点才发，exp-retire 同惯例；dataset.arm 就地标记，任意重渲自然复位）
                    const boardSchedule = event.target.closest("[data-board-schedule]");
                    if (boardSchedule) {
                      event.stopPropagation();
                      void planLaneOp(boardSchedule.dataset.boardSchedule, "backlog");
                      return;
                    }
                    const boardScrap = event.target.closest("[data-board-scrap]");
                    if (boardScrap) {
                      event.stopPropagation();
                      if (boardScrap.dataset.arm === "1") { void planLaneOp(boardScrap.dataset.boardScrap, "done"); return; }
                      boardScrap.dataset.arm = "1";
                      boardScrap.textContent = "确认废弃？";
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
                window.ccDeckTeam = Object.freeze({ mount, bind, snapshot, onEvent, detail, select, openTeamCreate }); // W-AGGREGATE-V1：暴露 prefill 建团口（项目域推荐条消费）
                if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
                else mount();
              })();
            