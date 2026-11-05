              (() => {
                "use strict";
                // #119 通知 V3 弹窗形态（基准 v8-ui-interactive-v3.html 通知区）：原三列域退役，
                // rail 🔔 锚定浮层。数据链零改动（消费 #d-project 共享桥 window.__ccDeck005B4：
                // 通知账+确认单兜底+验收单端上合成）；三级分组=需你行动(r)/注意(y)/动态(n)；
                // 行内 act 钮直达来源域（jump 链复用）；badge 口径不变=全部需行动（含验收/确认）。
                const bridge = window.__ccDeck005B4;
                const section = document.getElementById("d-notify");
                if (!bridge || !section) return;
                const escapeHtml = bridge.escapeHtml;
                const relTime = bridge.relTime;
                const toast = bridge.toast;
                const doneOf = bridge.doneOfNotification;
                const panel = section.querySelector("[data-notify-panel]");
                const panelBody = section.querySelector("[data-notify-panel-body]");
                const headSub = section.querySelector("[data-notify-panel-sub]");
                const railBadge = document.querySelector('.rail-btn[data-domain="notify"] [data-notify-badge]');
                const flight = new Set();
                // FB18 通知清除：本页会话内已清除键（不落盘——通知账权威在 relay，落盘键集会随
                // relay 重启漂移成脏过滤；actionable 行清除时另发 ACK 同步权威账面）。
                // 挂 window 与移动端 renderNotify 共账（桌面/手机同一浏览器才共，跨设备各自清）
                const dismissedNotifyKeys = window.__ccDeck005DismissedNotifyKeys || (window.__ccDeck005DismissedNotifyKeys = new Set());
                let lastRows = [];
                let lastRenderSig = ""; // #282 签名跳帧（等待/降级分支置空防回跳脏数据） // FB18：清除动作要行信息（synth/actionable），渲染期留账
                // observe3（1104 用户令·注意力经济学）：动态组（已处理/已读=健康态）默认折叠
                // ——「健康态零占位」纪律；组头可点开合（会话内记忆，不持久化——重开面板回默认收起）。
                let dynamicCollapsed = true;
                // W-NOTIFYPOLISH ①B1：同质聚合展开态（aggKey 集合——入 render 签名，开合必重渲）
                const aggOpenKeys = new Set();
                // #B3-17 新通知入场动画：仅首见行挂 .enter（首帧存量不动画，防整列闪烁）
                const seenNotifyKeys = new Set();
                let notifySeenInit = false;

                const KIND_LABEL = { waiting: "待处理", "org-confirm": "确认", dispatch: "派单", acceptance: "验收", system: "系统" };
                // 件十二扩充 B2：通知类型枚举（icon+标签一体，全链统一语言）——类型盘点自
                // relay 通知产生源：acceptance=验收单（端上合成）、org-confirm=团队决议/编制
                // 确认、dispatch=派单/接替回执、waiting=会话待处理、system=系统/上下文告警。
                // 图标全部复用既有 sprite（accept 方框勾=验收单、users=团队、send=派单、
                // bell=待处理、info=系统），零新增 symbol
                const KIND_META = {
                  acceptance: { icon: "accept", label: "验收", badge: "acceptance" },
                  "org-confirm": { icon: "users", label: "确认", badge: "confirm" },
                  dispatch: { icon: "send", label: "派单", badge: "dispatch" },
                  waiting: { icon: "bell", label: "待办", badge: "waiting" },
                  system: { icon: "info", label: "系统", badge: "system" },
                };
                // p2-batch2 修（notify 审 A9/P2-7）：ID/哈希/版本号等宽渲染——hex≥6 位、
                // v?X.Y.Z 通道号、b3xxxx 短 id 模式包 <code class="nid">（mono+浅底），标题与摘要共用
                const monoWrap = (s) => String(s ?? "")
                  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                  .replace(/(\b[0-9a-f]{6,64}\b|\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b|\bw-[a-z0-9-]{2,24}\b)/g, '<code class="nid">$1</code>');
                // 1101 A2 时间单轨：统一 11px 相对时间（≤60min 分钟 / <24h 小时 / 更早 M月D日）
                // ——正文内联时间退役（旧 sub 拼 relTime 双轨）
                const notifyRelTime = window.__ccDeck005NotifyRelTime = (ts) => {
                  const n = Number(ts) || 0;
                  if (!n) return "";
                  const diff = Date.now() - n;
                  if (diff < 0) return "";
                  const min = Math.floor(diff / 60000);
                  if (min < 1) return "刚刚";
                  if (min <= 60) return min + " 分钟前";
                  const h = Math.floor(min / 60);
                  if (h < 24) return h + " 小时前";
                  const d = new Date(n);
                  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
                };
                const kindMetaOf = (kind) => KIND_META[kind] || KIND_META.system;
                const sessionOf = (item) => {
                  const sid = item.sourceContext && typeof item.sourceContext.sessionId === "string" ? item.sourceContext.sessionId : "";
                  return sid ? bridge.sessions.get(sid) || null : null;
                };

                // 行合成：通知账（权威）+ 待决确认单兜底（无在册通知的补行，按 entityId 去重）
                // + 验收单行（relay 暂无 acceptance 通知产生源 → 端上本地合成，契约请求 B4-C3）。
                // W-WINPAIR-R8②：时间戳单位归一——acceptance/confirm 的 created_at 是秒级
                // （bin/acceptance 契约，W-NQA F6 同族），按毫秒解析会显 1970-01-2x；<1e11 视作秒 ×1000
                const normTs = (v) => { const n = Number(v) || 0; return n > 0 && n < 1e11 ? n * 1000 : n; };
                // [W-AWAITUSER]（1104 用户令）待拍板匹配器：行是否在 relay 聚合清单
                //（pending_user_actions 单源权威——端上不拼三源）。null=旧 relay 能力缺席，
                // 恒 false=排序与 chip 降级为现状。waiting 按 sessionId 配对（聚合 entity_id
                // =会话 id）；confirm/acceptance 按 entityId/source.id
                function userPendingIndex() {
                  if (!Array.isArray(bridge.pendingUserActions)) return null;
                  const set = new Set();
                  for (const p of bridge.pendingUserActions) {
                    if (p && typeof p.kind === "string" && typeof p.entity_id === "string") set.add(p.kind + ":" + p.entity_id);
                  }
                  return set;
                }
                const isUserPending = (set, kind, entityId) => !!(set && kind && entityId && set.has(kind + ":" + entityId));
                // ── W-NOTIFYFIX（1105 用户实锤）：过时（stale）判定单点 ──
                // 用户口径三连：「843 项需行动」计数虚高（陈年通知全累计）+test.96/97 已作废
                // 版本验收单还挂着+同张 test.97 单重复 4 条（出单工具重跑=同 title 异 id 四张）。
                // 治理（全 web 面，不动 relay 生成逻辑）：
                //   ①版本退役：验收单 title 版号（v0.7.0-test.97 形态）≠ 当前装机版
                //    （window.__ccDeck005Version 壳烙印）→ 过时——出新版即退役旧版单；
                //   ②同 title 聚合：同 title 多张（异 id 重跑产物）只认 created_at 最新一张，
                //     其余过时（重复治理）；
                //   ③通用陈年：任何行 ts 距今 >7 天且非 userPending（等你拍板）→ 过时
                //    （10-19 的死 waiting/陈年 system 全归历史）。
                // 过时行：active/unresolved 双清（不进「需你行动」/「注意」组+不计数）→
                // 落「历史动态」折叠组可查，行内「过时」徽章自明。userPending 行永不过时
                //（W-AWAITUSER 语义：等用户拍板的行不因龄退役）。
                const STALE_MS = 7 * 86400000;
                const versionOfText = (t) => { const m = String(t || "").match(/v?(\d+\.\d+\.\d+)(?:-test\.(\d+))?/); return m ? { major: m[1], test: m[2] ? Number(m[2]) : null } : null; };
                // W-NOTIFYFIX-R1 P2-2：主三段数值化比较——字典序在 0.7.10 及以后失效
                //（"0.7.9"<"0.7.10"=false → 0.7.9 误判不退役）；本版已升段 0.7.10 必然到来。
                const verLt = (a, b) => { const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); } return false; };
                const currentVer = versionOfText(window.__ccDeck005Version || "");
                const verObsolete = (titleVer) => {
                  if (!titleVer || !currentVer) return false; // 提不出/无烙印（旧壳）不判——fail-open 保守
                  if (titleVer.major !== currentVer.major) return verLt(titleVer.major, currentVer.major); // 主三段数值序（0.7.9<0.7.10 正确）
                  if (currentVer.test === null) return titleVer.test !== null; // 当前正式版：一切 test 单过时
                  if (titleVer.test === null) return false; // 当前 test 版：无 test 序号的标题不比（罕见形态）
                  return titleVer.test < currentVer.test; // 同主段比 test 序号
                };
                // 验收单池预研（**buildRows 调用期惰性求值**——页面加载期 bridge.accepts 尚空
                //（SNAPSHOT 未达），IIFE 顶层级会固化空集=全员误判 dup）：同 title 最新一张
                // id=现行，其余异 id 重复。
                const acceptanceCurrentIdsOf = () => {
                  const map = new Map(); // title -> {id, ts}
                  for (const a of (bridge.accepts || [])) {
                    const t = String(a.title || "").replace(/（[^）]*）$/, "").trim(); // 去尾括号（日期戳不参与聚合键）
                    const ts = normTs(a.created_at);
                    const prev = map.get(t);
                    if (!prev || ts > prev.ts) map.set(t, { id: a.id, ts });
                  }
                  return new Set([...map.values()].map((x) => x.id));
                };
                const staleWhyOf = (row, now, currentIds) => {
                  if (row.userPending) return null;
                  if (row.kind === "acceptance" && row.source && row.source.id) {
                    const a = row.source;
                    if (!currentIds.has(a.id)) return "dup"; // 同 title 旧张（重复）
                    const tv = versionOfText(a.title);
                    if (tv && verObsolete(tv)) return "version"; // 版本退役
                  }
                  if (row.ts && now - row.ts > STALE_MS) return "aged"; // 通用陈年
                  return null;
                };
                function buildRows() {
                  const rows = [];
                  const pending = userPendingIndex();
                  const acceptanceCurrentIds = acceptanceCurrentIdsOf(); // 惰性：本帧 accepts 池聚合
                  for (const n of bridge.notifications) {
                    if (flight.has(n.key) || dismissedNotifyKeys.has(n.key)) continue;
                    const session = sessionOf(n);
                    const entityId = n.kind === "waiting"
                      ? (n.sourceContext && typeof n.sourceContext.sessionId === "string" ? n.sourceContext.sessionId : "")
                      : (n.sourceContext && typeof n.sourceContext.entityId === "string" ? n.sourceContext.entityId : "");
                    rows.push({
                      synth: false, kind: n.kind, key: n.key, title: n.title, body: n.body, ts: normTs(n.created_at),
                      unresolved: !doneOf(n), active: !doneOf(n) && n.actionable === true, actionable: n.actionable === true,
                      userPending: isUserPending(pending, n.kind, entityId) && !doneOf(n),
                      source: n, engine: session ? session.engine : "", sessionTitle: session ? (session.title || session.initial_prompt || "") : "",
                      sessionId: n.sourceContext && typeof n.sourceContext.sessionId === "string" ? n.sourceContext.sessionId : "",
                      segment: n.sourceContext && typeof n.sourceContext.segment === "string" ? n.sourceContext.segment : "",
                    });
                  }
                  for (const confirm of bridge.pendingConfirms) {
                    if (dismissedNotifyKeys.has("confirm:" + confirm.id)) continue;
                    const covered = bridge.notifications.some((n) => n.kind === "org-confirm" && !doneOf(n) && n.sourceContext && n.sourceContext.entityId === confirm.id);
                    if (covered) continue;
                    rows.push({ synth: true, kind: "org-confirm", key: "confirm:" + confirm.id, title: confirm.title || "组织确认单", body: confirm.reason || "", ts: normTs(confirm.created_at), unresolved: true, active: true, actionable: false, userPending: isUserPending(pending, "org-confirm", confirm.id), source: confirm, engine: "", sessionTitle: "", sessionId: "", segment: "" });
                  }
                  // W-AGGREGATE-V1 升级时机（决策表二阶）：散会话聚合建议 ≥3 天未交互且桶
                  // 仍达阈值 → 本组单条（注意=琥珀非红；active=false 恒不进需行动组/不计
                  // badge）。清单由项目域 renderQueue 刷新（window.__ccDeck005AggUpgrades，
                  // 已含阈值/冷却/静默名单闸）；行可 ✗（dismissedNotifyKeys 同账）。
                  for (const upg of (Array.isArray(window.__ccDeck005AggUpgrades) ? window.__ccDeck005AggUpgrades : [])) {
                    const key = "agg:" + String(upg.dir || "");
                    if (!upg || !upg.dir || dismissedNotifyKeys.has(key)) continue;
                    rows.push({ synth: true, kind: "system", key, title: "聚合建议：" + (upg.n || 0) + " 个散会话同目录 " + String(upg.name || ""), body: String(upg.evidence || "") + " · 点项目域「未入项目」桶卡的「聚合为团队 →」可一键预填建团", ts: Number(upg.ts) || Date.now(), unresolved: true, active: false, actionable: false, userPending: false, source: upg, engine: "", sessionTitle: "", sessionId: "", segment: "" });
                  }
                  const hasAcceptanceChannel = bridge.notifications.some((n) => n.kind === "acceptance" && !doneOf(n));
                  if (!hasAcceptanceChannel) {
                    for (const acceptance of bridge.accepts) {
                      if (dismissedNotifyKeys.has("acceptance:" + acceptance.id)) continue;
                      rows.push({ synth: true, kind: "acceptance", key: "acceptance:" + acceptance.id, title: (acceptance.submitted ? "验收单：" : "验收单待填：") + acceptance.title, body: "共 " + acceptance.total + " 项 · 已回填 " + acceptance.judged + (acceptance.submitted ? " · 已提交" : ""), ts: normTs(acceptance.created_at), unresolved: acceptance.submitted !== true, active: acceptance.submitted !== true, actionable: false, userPending: isUserPending(pending, "acceptance", acceptance.id), source: acceptance, engine: "", sessionTitle: "", sessionId: "", segment: "" }); // 件十二扩充 B3 + W-WINPAIR-R8② ts 秒级归一（1970-01-22 根修）
                    }
                  }
                  // [W-AWAITUSER] 待拍板顶格：扩同一排序器（需人优先 active 键之前加
                  // userPending 键——不造第二排序器、不改三分组结构，observe3
                  //「需你行动组首位」锚不动；组内待拍板行置顶，其余按原序）
                  rows.sort((a, b) => Number(b.userPending === true) - Number(a.userPending === true) || Number(b.active) - Number(a.active) || b.ts - a.ts);
                  // W-NOTIFYFIX：过时标注（排序后单遍）——active/unresolved 双清=不进
                  //「需你行动」/「注意」组、不计头部计数，落「历史动态」折叠组可查。
                  const nowMs = Date.now();
                  for (const r of rows) {
                    const why = staleWhyOf(r, nowMs, acceptanceCurrentIds);
                    if (why) { r.staleWhy = why; r.active = false; r.unresolved = false; }
                  }
                  return rows;
                }

                function jumpOf(row) {
                  if (!row.active) return null;
                  if (row.kind === "waiting") return row.sessionId ? { domain: "session", session: row.sessionId, segment: row.segment, label: "去会话处理" } : null;
                  if (row.kind === "dispatch") return row.sessionId ? { domain: "session", session: row.sessionId, segment: row.segment, label: "去会话查看" } : null;
                  if (row.kind === "org-confirm") return { domain: "team", teamAction: "confirm", label: "去团队确认" };
                  if (row.kind === "system") return row.sessionId ? { domain: "session", session: row.sessionId, segment: row.segment, label: "去会话查看" } : null;
                  if (row.kind === "acceptance") return { acceptance: row.source.id, label: "打开验收单" };
                  return null;
                }
                const jumpAttrs = (jump) => jump
                  ? (jump.acceptance
                    ? ' data-notify-open-acceptance="' + escapeHtml(jump.acceptance) + '"'
                    : ' data-notify-jump data-notify-domain="' + escapeHtml(jump.domain) + '"'
                      + (jump.session ? ' data-notify-session="' + escapeHtml(jump.session) + '"' : "")
                      + (jump.segment ? ' data-notify-segment="' + escapeHtml(jump.segment) + '"' : "")
                      + (jump.teamAction ? ' data-notify-team-action="' + escapeHtml(jump.teamAction) + '"' : ""))
                  : "";

                // #119 V3 行标记：标题（不硬裁）+ 一行摘要（body 首行 · 相对时间）+
                // act 行动钮（直达来源域；无跳转的 actionable 行给「知道了」轻动作）+ × 清除。
                // 组别类：alert=需你行动（红）/warn=注意（琥珀）/read=动态（已读降噪）。
                // W-NOTIFYPOLISH（1105 三路审查落地）：
                //   ④A1+B4 减熵——.ic 图标列退役（三套符号→两套，腾 26px 给标题）；
                //     userPending 行 kind 徽章不输出（「等你拍板」chip 独扛紧急度语义）。
                //   ①B1 同质聚合——同 kind+title 聚为代表行，aggN>1 时 L1 出 ×N 展开钮
                //     （点击展开其余子项 .nrow.sub；子项含独立 dismiss/act——逐条处置不拦）。
                //   ②B2 active 行整行可点=执行 jump（click 代理卡身分支；×/chip/agg 钮
                //     天然 stopPropagation——button 先命中）。
                function rowMarkup(row, isSub) {
                  const jump = jumpOf(row) || (row.kind === "acceptance" && row.source && row.source.id ? { acceptance: row.source.id, label: "打开验收单" } : null); /* W-NOTIFYFIX：过时验收单按钮保留——退役≠不可查（jumpOf 对非 active 恒 null 的旁路） */
                  const km = kindMetaOf(row.kind);
                  const cls = row.active ? "alert" : row.unresolved ? "warn" : "read";
                  const canAck = !row.synth && row.actionable && row.unresolved && !bridge.notifyAckUnsupported;
                  const sub = String(row.body || "").split("\n")[0]; // A2 时间单轨：正文只留摘要，时间归 L1 右贴
                  // A6 操作钮降权=文字链（12px/500 强调色 hover 下划线）
                  const act = jump
                    ? (jump.acceptance
                      ? '<button class="act" type="button" data-notify-open-acceptance="' + escapeHtml(jump.acceptance) + '">' + escapeHtml(jump.label) + '</button>'
                      : '<button class="act" type="button"' + jumpAttrs(jump) + ">" + escapeHtml(jump.label) + "</button>")
                    : canAck ? '<button class="act" type="button" data-notify-ack="' + escapeHtml(row.key) + '" title="标记已处理（handled）">知道了</button>' : "";
                  const x = '<button class="x" type="button" data-notify-dismiss="' + escapeHtml(row.key) + '" title="清除这条通知" aria-label="清除通知">×</button>';
                  const engMark = row.engine && window.__ccDeck005EngineMarkHtml
                    ? '<span class="nrow-eng" title="会话引擎">' + window.__ccDeck005EngineMarkHtml(row.engine) + "</span>"
                    : "";
                  const aggBtn = row.aggN > 1
                    ? '<button class="agg-n" type="button" data-notify-agg-toggle="' + escapeHtml(row.aggKey) + '" title="同款 ' + row.aggN + ' 条（重复生成）——展开逐条查看/处置">×' + row.aggN + "</button>"
                    : "";
                  // A6 行栅格 12px：内容列（L1 badge+agg+时间右贴 / L2 标题 clamp2+tooltip /
                  // L3 摘要+内联操作）+右侧 act/× 列
                  return '<div class="nrow ' + cls + (isSub ? " sub" : "") + (row.isNew ? " enter" : "") + '" data-notify-card data-notify-key="' + escapeHtml(row.key) + '" data-notify-active="' + (row.active ? "true" : "false") + '">'
                    + '<div class="t"><div class="l1">' + (row.userPending ? "" : '<span class="nbadge nbadge-' + km.badge + '">' + escapeHtml(km.label) + "</span>") + (row.staleWhy ? '<span class="nbadge stale-chip" title="' + (row.staleWhy === "version" ? "验收单对应版本已被新版取代——已退役归档，不计需行动" : row.staleWhy === "dup" ? "同名单的早期重复生成——已归档" : "超过 7 天未处理的陈年通知——已归档，不计需行动") + '">过时</span>' : "") + (row.userPending ? '<span class="nbadge awaitu-chip" title="在等你拍板——处理完自动消失"><i class="awaitu-dot" aria-hidden="true"></i>等你拍板</span>' : "") + engMark + aggBtn + '<span class="nrow-time">' + escapeHtml(notifyRelTime(row.ts)) + "</span></div>"
                    + '<b title="' + escapeHtml(row.title) + '">' + monoWrap(row.title) + '</b><div class="s">' + '<span class="s-txt">' + monoWrap(sub) + "</span>" + (act ? '<span class="act-slot">' + act + "</span>" : "") + "</div></div>" /* 复审P1-2：摘要包 s-txt（ellipsis 归位），act-slot 不再被整体裁剪 */
                    + x + "</div>";
                }

                function nodesFrom(markup) {
                  const template = document.createElement("template");
                  template.innerHTML = markup;
                  return template.content;
                }

                let lastCount = -1;
                function syncCounts(count, earliestTs) {
                  // W-NOTIFYPOLISH ③A3+B3：头部计数 pill 退役——843 双显口径不一（头部不封顶
                  // vs rail 99+）且与组头计数三处两零差；计数单源=组头 cnt+rail（99+ 封顶）。
                  // 头部腾位改增量信息：最早一条需行动距现在多久（「最早 16 小时前」——
                  // 用户不看数字也能感知积压深度）。
                  if (headSub) {
                    const next = earliestTs ? "最早需行动 " + notifyRelTime(earliestTs) : (count ? "" : "无待办");
                    if (headSub.textContent !== next) headSub.textContent = next;
                  }
                  if (railBadge) {
                    railBadge.textContent = count > 99 ? "99+" : String(count) /* visualfix（1104 V-P2-5）：659 直出=角标宽超铃铛本体遮挡——99+ 封顶（aria/title 保真全数） */;
                    railBadge.hidden = count === 0;
                    railBadge.setAttribute("aria-label", "通知有 " + count + " 项需行动");
                    railBadge.setAttribute("title", "通知 · " + count + " 项需行动");
                    if (lastCount >= 0 && count !== lastCount) { railBadge.classList.remove("notify-badge-pop"); void railBadge.offsetWidth; railBadge.classList.add("notify-badge-pop"); }
                  }
                  lastCount = count;
                }

                // ⑥a-4 来源会话水位块随三列检查器退役（V3 弹窗无检查器位；水位仍在会话域详情可见）

                function render() {
                  const waiting = bridge.waitingText();
                  if (waiting) {
                    lastRenderSig = ""; // #282 离开数据态清签名
                    panelBody.replaceChildren(bridge.bannerOf(waiting));
                    syncCounts(0);
                    return;
                  }
                  if (!bridge.notificationsSupported) {
                    // W-NOVAFIX B8a：降级分档——未连接给连接文案（等待重连），已连接才下「relay 不支持通知」结论
                    const online = bridge.connection === "online";
                    panelBody.replaceChildren(bridge.bannerOf(online ? "已连接 · 此 relay 不支持通知数据（旧版本）· 通知中心不可用" : "正在连接 relay · 连接后同步通知"));
                    syncCounts(0);
                    return;
                  }
                  const rows = buildRows();
                  lastRows = rows;
                  for (const r of rows) r.isNew = notifySeenInit && !seenNotifyKeys.has(r.key); // #B3-17
                  // #282 N1 ①签名跳帧（置于 FX 之前防重复响铃）：通知数据与 isNew/active/
                  // unresolved 态整列签名未变 → 零 DOM 零副作用直接返回——bridge 任何事件
                  // 都触发 render，多数与通知无关（每帧全量重渲+重复 FX 的双重根治）。
                  const actionRows0 = rows.filter((r) => r.active);
                  const attentionRows0 = rows.filter((r) => !r.active && r.unresolved);
                  const dynamicRows0 = rows.filter((r) => !r.unresolved);
                  const sig = rows.map((r) => r.key + ":" + (r.isNew ? 1 : 0) + ":" + (r.active ? 1 : 0) + ":" + (r.unresolved ? 1 : 0)).join("|")
                    + "#" + actionRows0.length + "," + attentionRows0.length + "," + dynamicRows0.length
                    + (dynamicCollapsed ? "#dyn-collapsed" : "#dyn-open") // observe3：折叠态入签名（切换必重渲）
                    // [W-AWAITUSER] userPending 位入签名（顶格/chip 变化必重渲）
                    + "#au:" + rows.filter((r) => r.userPending).map((r) => r.key).join(",")
                    // W-NOTIFYPOLISH ①：聚合态入签名（簇大小变化/开合切换必重渲）
                    + "#agg:" + [...aggOpenKeys].join(",") + "|" + rows.map((r) => r.kind + "`" + r.title).sort().join(";");
                  if (sig === lastRenderSig && panelBody.firstChild) return; // 数据未变跳帧（含 FX 不重放）
                  lastRenderSig = sig;
                  // FB9 反馈接线：首见且需行动的行——声音短滴 + 桌面通知（各自开关与权限双重门控）
                  if (notifySeenInit && window.__ccDeck005NotifyFx) {
                    const fresh = rows.filter((r) => r.isNew && r.active);
                    if (fresh.length) {
                      if (window.__ccDeck005NotifyFx.soundOn()) window.__ccDeck005NotifyFx.ding();
                      window.__ccDeck005NotifyFx.desktop(fresh[0].title, fresh[0].body);
                    }
                    // B5 铃铛摆动（一次性 420ms；仅面板关时——开着时由 stagger/pop 承担）
                    if (fresh.length && !isOpen()) {
                      const bell = document.querySelector('.rail-btn[data-domain="notify"]');
                      if (bell) { bell.classList.remove("bell-swing"); void bell.offsetWidth; bell.classList.add("bell-swing"); }
                    }
                  }
                  const actionRows = rows.filter((r) => r.active);
                  const attentionRows = rows.filter((r) => !r.active && r.unresolved);
                  const dynamicRows = rows.filter((r) => !r.unresolved);
                  // W-NOTIFYPOLISH ①B1+B6：组内同质聚合（kind+title 同簇——843 重复单实锤形态）。
                  // 代表行=簇内最新（rows 已 ts 降序，首见即最新）；aggN 入 L1 ×N 展开钮；
                  // 时间归聚=代表行时刻即簇最新（同簇同刻的逐行重复时间列随之消解）；
                  // 子项展开=其余 N-1 条缩进行（各自独立 dismiss/act——逐条处置不拦）。
                  const aggregate = (items) => {
                    const out = [];
                    const idx = new Map();
                    for (const r of items) {
                      // W-NOTIFYPOLISH-R1 P1-2（A 审+PM 拍板）：stale 行豁免聚合——过时
                      // 归档单要一眼看到总量、逐张可核销（notifyfix「过时可查」承诺不因
                      // 聚合静默改写）；聚合只用于活跃同题降噪。stale 行照原样逐行出。
                      if (r.staleWhy) { out.push(r); continue; }
                      const ak = r.kind + "`" + r.title;
                      const rep = idx.get(ak);
                      if (rep) { rep.aggN++; rep.aggChildren.push(r); }
                      else { const cp = { ...r, aggN: 1, aggKey: ak, aggChildren: [] }; idx.set(ak, cp); out.push(cp); }
                    }
                    return out;
                  };
                  const rowsOf = (agg) => agg.flatMap((rep) => (rep.aggN > 1 && aggOpenKeys.has(rep.aggKey) ? [rep, ...rep.aggChildren.map((c) => ({ ...c, isSub: true }))] : [rep]));
                  // V3 三级分组：ndot r/y/n = 需你行动/注意/动态（组头带计数）
                  // A7 组头 v2：11px/600/.05em+语义点+计数 badge+组级清空（hover 显）；
                  // 需你行动组红点带脉冲（B5 唯一脉冲位——面板开时 CSS 停）
                  // p2-batch2 修（notify 审 P2-组清空越组）：grpClear 带组别（y=注意/n=动态）
                  // ——旧版两组合用 "soft" 调 clearSoftNotifications（清全部非 active=点「注意」
                  // 把「动态」也清了）；本版按组精确清
                  // W-NOTIFYPOLISH-R1 P1-1（A 审实锤）：组头 cnt 单源=原始组行数（与 rail
                  // badge 同源 actionRows.length 口径）——旧 cnt 吃 rowsOf(aggregate()) 长度，
                  // 收起=簇数/展开=簇+子项，同屏与 rail 打架（收起「4」vs rail「7」、展开跳 7）。
                  // cnt 由调用方显式传原始长度；缺省回落 items.length（兼容旧口）。
                  const group = (label, dot, items, grpClear, collapsible, cnt) => items.length
                    ? '<div class="ngrp' + (collapsible ? " ngrp-fold" : "") + '"' + (collapsible ? ' data-notify-grp-toggle="1" role="button" tabindex="0" title="展开/收起已处理动态"' : "") + ' data-notify-grp="' + (dot === "r" ? "r" : dot) + '"><i class="ndot ' + dot + (dot === "r" ? " np-pulse" : "") + '"></i>' + escapeHtml(label)
                      + '<span class="caret">' + (collapsible ? (dynamicCollapsed ? "▸" : "▾") : "") + '</span>'
                      + '<span class="cnt">' + (cnt ?? items.length) + "</span>"
                      + (grpClear && (!collapsible || !dynamicCollapsed) ? '<button class="grp-clr" type="button" data-notify-grp-clear="' + grpClear + '" title="清空本组">清空</button>' : "")
                      + "</div>" + (collapsible && dynamicCollapsed ? "" : items.map((r) => rowMarkup(r, r.isSub === true)).join(""))
                    : "";
                  if (rows.length) {
                    // #282 N1 ②keyed reconcile：组头 grp:R/Y/N + 行 row:<key>，未变行零触碰
                    //（滚动位/入场动画不重放/hover 全保），变化行单节点替换。工具缺席回落旧全量写。
                    const flatHtml = group("需你行动", "r", rowsOf(aggregate(actionRows)), "", false, actionRows.length) /* R1 P1-1：cnt=原始组行数（rail 同源），不随聚合/开合变 */
                      + group("注意", "y", rowsOf(aggregate(attentionRows)), "y", false, attentionRows.length)
                      + group("动态", "n", rowsOf(aggregate(dynamicRows)), "n", true, dynamicRows.length); // observe3：健康态默认折叠零占位，组头点开
                    const rkN = window.__ccDeck005Reconcile;
                    if (rkN) {
                      const t = document.createElement("template");
                      t.innerHTML = flatHtml;
                      const desired = [];
                      let gN = 0;
                      for (const n of t.content.children) {
                        const nk = n.getAttribute("data-notify-key");
                        desired.push([nk ? "row:" + nk : "grp:" + (gN++), n.outerHTML]);
                      }
                      rkN(panelBody, desired);
                      // A1 计数单源根修（1101 审查「头部 0 与组头 5 打脸」真根因）：
                      // reconcile 快路径曾在此 return——跳过尾部 syncCounts/seen 维护，
                      // 头部计数恒停旧值。收口两分支共用尾部（counts/seen/首见标记）
                      for (const r of rows) seenNotifyKeys.add(r.key);
                      notifySeenInit = true;
                      syncCounts(actionRows.length, actionRows.reduce((m, r) => (r.ts && (!m || r.ts < m) ? r.ts : m), 0)); /* W-NOTIFYPOLISH ③：最早需行动时刻随行下发 */
                      return;
                    }
                    panelBody.replaceChildren(nodesFrom(flatHtml));
                  } else {
                    panelBody.replaceChildren(nodesFrom('<div class="readonly-banner">暂无需要你行动的通知 · 行动项到达时在此提示。</div>'));
                  }
                  for (const r of rows) seenNotifyKeys.add(r.key);
                  notifySeenInit = true;
                  syncCounts(actionRows.length, actionRows.reduce((m, r) => (r.ts && (!m || r.ts < m) ? r.ts : m), 0)); /* W-NOTIFYPOLISH ③：最早需行动时刻随行下发 */
                }

                // #018-W1b 轻动作：COMMAND_NOTIFICATION_ACK{notification_key, action:"handled"}。
                // 乐观行即刻消失（flight 过滤）→ ACK ok 等权威 NOTIFICATIONS_UPDATED 归位为
                // 历史动态；失败回滚（行回来+toast）；旧 relay 未知命令 → 能力位记忆隐藏动作位。
                const unknownCommandText = (err) => typeof err === "string" && /invalid command shape|^unsupported command|unsupported org action/.test(err);
                async function ackNotification(key) {
                  if (flight.has(key)) return;
                  flight.add(key);
                  render();
                  const ack = await bridge.sendCommand("COMMAND_NOTIFICATION_ACK", { notification_key: key, action: "handled" });
                  flight.delete(key);
                  if (ack && ack.ok === true) toast("已标记已读 · 权威账面同步中");
                  else if (ack && unknownCommandText(ack.error)) {
                    bridge.notifyAckUnsupported = true;
                    toast("该 relay 不支持通知已读命令 · 动作位已隐藏");
                  } else toast("通知处理失败" + (ack && ack.error ? "：" + ack.error : "（未连接或超时）") + " · 行已还原");
                  render();
                }

                // FB18 清除：行级 ✕ 与全部清除共用——本地即刻隐藏；actionable 行另发 ACK 同步
                // 权威账（失败不回滚——清除意图优先，relay 账面随后自愈）
                function dismissRow(row) {
                  dismissedNotifyKeys.add(row.key);
                  if (!row.synth && row.actionable && row.unresolved && !bridge.notifyAckUnsupported) {
                    void bridge.sendCommand("COMMAND_NOTIFICATION_ACK", { notification_key: row.key, action: "handled" });
                  }
                }
                function dismissRowByKey(key) {
                  const row = lastRows.find((r) => r.key === key);
                  if (!row || dismissedNotifyKeys.has(key)) return;
                  dismissRow(row);
                  // B5 单卡关闭塌缩：160ms ease-in 高度收束。p2-batch2 注释诚实化（notify 审
                  // P2-5）：旧行补位非真 FLIP（无 measure/invert）——塌缩后 reconcile 整段重排，
                  // 下方行瞬时上移；真 FLIP（measure-prepare-play）另批按需实现，此处不谎称
                  const el = panelBody.querySelector('[data-notify-key="' + CSS.escape(key) + '"]');
                  if (el && el.animate) {
                    el.classList.add("leaving");
                    setTimeout(render, 170);
                  } else render();
                }
                function clearAllNotifications() {
                  const rows = lastRows.filter((r) => !dismissedNotifyKeys.has(r.key));
                  if (!rows.length) { toast("没有可清除的通知"); return; }
                  for (const row of rows) dismissRow(row);
                  render();
                  toast("已清除 " + rows.length + " 条通知");
                }

                // p2-batch2：按组清空（notify 审 P2-组清空越组修）——只清指定组（y=注意/n=动态）
                function clearGroupNotifications(grp) {
                  const pool = grp === "y"
                    ? lastRows.filter((r) => !r.active && r.unresolved)
                    : lastRows.filter((r) => !r.unresolved);
                  const rows = pool.filter((r) => !dismissedNotifyKeys.has(r.key));
                  if (!rows.length) { toast(grp === "y" ? "注意组没有可清除的通知" : "动态组没有可清除的通知"); return; }
                  for (const row of rows) dismissRow(row);
                  render();
                  toast("已清空" + (grp === "y" ? "注意" : "动态") + "组 " + rows.length + " 条");
                }
                // W-V8 批5 温和清空（v8「清空 info/warn」语义）：只清注意+动态组，保留需你行动项
                function clearSoftNotifications() {
                  const rows = lastRows.filter((r) => !dismissedNotifyKeys.has(r.key) && !r.active);
                  if (!rows.length) { toast("没有可清除的注意/动态通知"); return; }
                  for (const row of rows) dismissRow(row);
                  render();
                  toast("已清空注意/动态 " + rows.length + " 条（需行动项保留）");
                }

                function focusSource(el) {
                  // #119：行内 act 直达来源域后收弹窗（V3「行动钮直达」语义——弹窗即走）
                  if (el.hasAttribute("data-notify-open-acceptance")) { bridge.openAcceptance(el.dataset.notifyOpenAcceptance); setOpen(false); return; }
                  const domain = el.dataset.notifyDomain;
                  if (domain === "session") {
                    bridge.railJump("session");
                    if (el.dataset.notifySession) bridge.selectSessionCard(el.dataset.notifySession);
                    if (el.dataset.notifySegment === "tasks") bridge.clickTab("#d-session .segment-bar", "任务");
                    toast("已定位来源会话 · 写操作在原域完成");
                  } else if (domain === "team") {
                    bridge.railJump("team");
                    bridge.clickTab("#d-team .segment-bar", el.dataset.notifyTeamAction === "confirm" ? "看板" : "成员");
                    toast("已定位来源团队 · 确认/接替在原域完成");
                  }
                  setOpen(false);
                }

                // #119 开合面：section.on 显隐 + aria 同步 + 焦点进出（开=进面板，关=还原触发钮）。
                // 铃铛 toggle 走地基点击链的 window.__ccDeck005NotifyPanel；Esc/切域/切形态由
                // closeTransientOverlays 统一收口；遮罩/× 在下方 section 点击代理处理。
                let lastFocus = null;
                // B4 行入场 stagger：面板开（或首帧渲染）后 +50ms 起每卡 +30ms；>6 张
                // data-stagger-cap=1 整体 60ms 淡入（长列表不拖沓）；reduced-motion 由
                // token 降级段统一清零。面板已开时的后续 render 不重放（签名跳帧+此处幂等）
                function playStagger() {
                  if (!isOpen()) return;
                  const body = panelBody;
                  const rows = [...body.querySelectorAll(".nrow")];
                  body.classList.remove("np-stagger");
                  body.removeAttribute("data-stagger-cap");
                  void body.offsetWidth;
                  if (!rows.length) return;
                  body.classList.add("np-stagger");
                  if (rows.length > 6) body.setAttribute("data-stagger-cap", "1");
                  rows.forEach((r, i) => r.style.setProperty("--st-i", String(Math.min(i, 12))));
                }
                // B3 三关闭路径共享退场：遮罩/×/ESC → closePanel()（.closing 播 130ms
                // ease-in 退场，animationend 真隐藏；退场期 pointer-events:none 由 CSS）
                function closePanel() {
                  if (!section.classList.contains("on") || section.classList.contains("closing")) return;
                  section.classList.add("closing");
                  const done = () => {
                    section.classList.remove("on", "closing");
                    section.removeEventListener("animationend", done);
                  };
                  panel.addEventListener("animationend", done, { once: true });
                  setTimeout(done, 260); // 兜底（reduced-motion 档 animation 可能 0 时长不触发 end）
                  setOpen(false, true);
                }
                function setOpen(open, keepVisual) {
                  const on = !!open;
                  if (!keepVisual) {
                    if (on) section.classList.add("on");
                    else if (!section.classList.contains("closing")) section.classList.remove("on");
                  }
                  section.setAttribute("aria-hidden", on ? "false" : "true");
                  const bell = document.querySelector('.rail-btn[data-domain="notify"]');
                  if (bell) bell.classList.toggle("active", on); // 弹窗开着=铃铛高亮（V3 bell.on 同语言）
                  if (on) {
                    // W-DESKNOTIFY 兜底：面板开=即有内容——门/rAF 合并后首渲可能还排在下一
                    // tick，空面板闪一帧不可接受（数据已到但从未渲过时同步补一次；已渲过
                    // 零成本跳过——render 签名跳帧保底）
                    if (!panelBody.firstElementChild) { try { render(); } catch (_) {} }
                    // 三刀：面板开让位——撤掉已排定的渲染分片让本帧画面板（点击→可见优先），
                    // 220ms 后恢复补渲（dirty 保留数据不丢）
                    const g = window.__ccDeck005DeskRender;
                    if (g && typeof g.yieldPaint === "function") { try { g.yieldPaint(220); } catch (_) {} }
                    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    panel.focus({ preventScroll: true });
                    setTimeout(playStagger, 30); // 面板 frame 起手后编排行入场
                  } else if (lastFocus && lastFocus.isConnected) {
                    try { lastFocus.focus({ preventScroll: true }); } catch (_) {}
                    lastFocus = null;
                  }
                }
                const isOpen = () => section.classList.contains("on");
                window.__ccDeck005NotifyPanel = { open: () => setOpen(true), close: () => closePanel(), toggle: () => (isOpen() ? closePanel() : setOpen(true)), isOpen };
                // B3 ESC + 焦点 Tab 锁（面板=模态 dialog：Tab 循环面板内；Esc 三关闭路径之三）
                document.addEventListener("keydown", (ev) => {
                  if (!isOpen() || section.classList.contains("closing")) return;
                  if (ev.key === "Escape") { ev.preventDefault(); closePanel(); return; }
                  if (ev.key === "Tab") {
                    const focusables = panel.querySelectorAll("button, [href], [tabindex]:not([tabindex=\"-1\"])");
                    if (!focusables.length) return;
                    const first = focusables[0], lastEl = focusables[focusables.length - 1];
                    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); lastEl.focus(); }
                    else if (!ev.shiftKey && document.activeElement === lastEl) { ev.preventDefault(); first.focus(); }
                  }
                }, true);

                section.addEventListener("click", (event) => {
                  const target = event.target;
                  if (target.closest("[data-notify-mask]")) { closePanel(); return; } // B2 点外收起（遮罩命中层；面板内 mousedown 不达遮罩=不穿透）
                  if (target.closest("[data-notify-close]")) { closePanel(); return; } // 头部 ×（三路径共享退场）
                  // observe3 R1 P1-2（A 审 DOM 探针实证）：清空钮判定必须**先于**折叠开合——
                  // 清空钮渲染在携带 data-notify-grp-toggle 的组头内，closest 沿祖先链上行
                  // 必先命中组头（「button 自带 target」是错误断言），先判 toggle=清空钮
                  // 永远走开合分支=死路。钮自带 data-notify-grp-clear 先命中即清空。
                  const grpClear = target.closest("[data-notify-grp-clear]");
                  if (grpClear) { clearGroupNotifications(grpClear.dataset.notifyGrpClear === "y" ? "y" : "n"); return; } // p2-batch2：按组精确清（y=注意/n=动态）
                  const grpToggle = target.closest("[data-notify-grp-toggle]");
                  if (grpToggle) { dynamicCollapsed = !dynamicCollapsed; render(); return; } // observe3：健康态折叠开合（组头空白区点击）
                  const aggBtn = target.closest("[data-notify-agg-toggle]"); // W-NOTIFYPOLISH ①：同质簇展开/收起（button 先命中=不与整行 jump 冲突）
                  if (aggBtn) {
                    const ak = aggBtn.dataset.notifyAggToggle;
                    if (aggOpenKeys.has(ak)) aggOpenKeys.delete(ak); else aggOpenKeys.add(ak);
                    render();
                    return;
                  }
                  const dismissButton = target.closest("[data-notify-dismiss]"); // FB18：行级 ✕ 先于跳转判定
                  if (dismissButton) { dismissRowByKey(dismissButton.dataset.notifyDismiss); return; }
                  const ackButton = target.closest("[data-notify-ack]");
                  if (ackButton) { ackNotification(ackButton.dataset.notifyAck); return; }
                  if (target.closest("[data-notify-clear-soft]")) { clearSoftNotifications(); return; }
                  if (target.closest("[data-notify-clear]")) { clearAllNotifications(); return; }
                  const open = target.closest("[data-notify-open-acceptance]");
                  if (open) {
                    // W-NOTIFYFIX（用户死钮实锤）：点击链兜底——openAcceptance/openUrl 任一环
                    // 同步抛错（如降级链依赖缺失形态）不得静默吞掉——toast 可见报错+console 留痕
                    try { bridge.openAcceptance(open.dataset.notifyOpenAcceptance); }
                    catch (e) { try { console.error("[notify] 打开验收单失败", e); } catch (_) {} if (bridge && typeof bridge.toast === "function") bridge.toast("打开验收单失败：" + (e && e.message ? String(e.message).slice(0, 60) : "?"), "error"); }
                    setOpen(false); return;
                  }
                  const jump = target.closest("[data-notify-jump]");
                  if (jump) { focusSource(jump); return; }
                  const card = target.closest("[data-notify-card]");
                  // W-NOTIFYPOLISH ②B2：active 行整行可点=执行 jump（act 链保留为键盘/读屏
                  // 焦点位——视觉不再是唯一可达面；×/chip/聚合钮皆 button 先命中不误触）
                  if (card && !target.closest("button") && card.dataset.notifyActive === "true") {
                    const act = card.querySelector(".act");
                    if (act) { act.click(); return; }
                  }
                  if (card && !target.closest("button") && card.dataset.notifyActive !== "true") toast("历史动态 · 已归档，无需处理");
                });
                // A8 底栏：面板过短时展开（70%↔90vh 一档 toggle，再点回落）。
                // W-NOTIFYPOLISH ①B5：标签诚实化——旧「查看全部通知」名实不符（只是
                // 高度切换非全量视图）；聚合后子项已可逐条展开，本钮只管高度
                section.addEventListener("click", (event) => {
                  if (!event.target.closest("[data-notify-expand]")) return;
                  // p2-batch2 修（notify 审 P2-10 死类）：np-full 类在 CSS 无定义（死类）——状态改 dataset 承载
                  const full = panel.dataset.full === "1";
                  panel.dataset.full = full ? "" : "1";
                  panel.style.maxHeight = full ? "" : "min(90vh, calc(100% - 72px))";
                  event.target.textContent = full ? "展开面板" : "收起面板";
                });

                bridge.subscribe(() => { const g = window.__ccDeck005DeskRender; if (g) g.run(render); else render(); }); // W-MOBILE-PERF：桌面台不在视跳渲记脏（回桌面 flush 补渲）
                setTimeout(() => { const g = window.__ccDeck005DeskRender; if (g) g.run(render); else render(); }, 0);
              })();
            