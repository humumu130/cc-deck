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
                let lastRows = []; // FB18：清除动作要行信息（synth/actionable），渲染期留账
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
                  acceptance: { icon: "accept", label: "验收单" },
                  "org-confirm": { icon: "users", label: "团队确认" },
                  dispatch: { icon: "send", label: "派单" },
                  waiting: { icon: "bell", label: "待处理" },
                  system: { icon: "info", label: "系统" },
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
                function buildRows() {
                  const rows = [];
                  for (const n of bridge.notifications) {
                    if (flight.has(n.key) || dismissedNotifyKeys.has(n.key)) continue;
                    const session = sessionOf(n);
                    rows.push({
                      synth: false, kind: n.kind, key: n.key, title: n.title, body: n.body, ts: normTs(n.created_at),
                      unresolved: !doneOf(n), active: !doneOf(n) && n.actionable === true, actionable: n.actionable === true,
                      source: n, engine: session ? session.engine : "", sessionTitle: session ? (session.title || session.initial_prompt || "") : "",
                      sessionId: n.sourceContext && typeof n.sourceContext.sessionId === "string" ? n.sourceContext.sessionId : "",
                      segment: n.sourceContext && typeof n.sourceContext.segment === "string" ? n.sourceContext.segment : "",
                    });
                  }
                  for (const confirm of bridge.pendingConfirms) {
                    if (dismissedNotifyKeys.has("confirm:" + confirm.id)) continue;
                    const covered = bridge.notifications.some((n) => n.kind === "org-confirm" && !doneOf(n) && n.sourceContext && n.sourceContext.entityId === confirm.id);
                    if (covered) continue;
                    rows.push({ synth: true, kind: "org-confirm", key: "confirm:" + confirm.id, title: confirm.title || "组织确认单", body: confirm.reason || "", ts: normTs(confirm.created_at), unresolved: true, active: true, actionable: false, source: confirm, engine: "", sessionTitle: "", sessionId: "", segment: "" });
                  }
                  const hasAcceptanceChannel = bridge.notifications.some((n) => n.kind === "acceptance" && !doneOf(n));
                  if (!hasAcceptanceChannel) {
                    for (const acceptance of bridge.accepts) {
                      if (dismissedNotifyKeys.has("acceptance:" + acceptance.id)) continue;
                      rows.push({ synth: true, kind: "acceptance", key: "acceptance:" + acceptance.id, title: (acceptance.submitted ? "验收单：" : "验收单待填：") + acceptance.title, body: "共 " + acceptance.total + " 项 · 已回填 " + acceptance.judged + (acceptance.submitted ? " · 已提交" : ""), ts: normTs(acceptance.created_at), unresolved: acceptance.submitted !== true, active: acceptance.submitted !== true, actionable: false, source: acceptance, engine: "", sessionTitle: "", sessionId: "", segment: "" }); // 件十二扩充 B3 + W-WINPAIR-R8② ts 秒级归一（1970-01-22 根修）
                    }
                  }
                  rows.sort((a, b) => Number(b.active) - Number(a.active) || b.ts - a.ts);
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

                // #119 V3 行标记：icon + 标题（不硬裁）+ 一行摘要（body 首行 · 相对时间）+
                // act 行动钮（直达来源域；无跳转的 actionable 行给「知道了」轻动作）+ × 清除。
                // 组别类：alert=需你行动（红）/warn=注意（琥珀）/read=动态（已读降噪）。
                function rowMarkup(row) {
                  const jump = jumpOf(row);
                  const km = kindMetaOf(row.kind);
                  const cls = row.active ? "alert" : row.unresolved ? "warn" : "read";
                  const canAck = !row.synth && row.actionable && row.unresolved && !bridge.notifyAckUnsupported;
                  const sub = [String(row.body || "").split("\n")[0], relTime(row.ts)].filter(Boolean).join(" · ");
                  const act = jump
                    ? (jump.acceptance
                      ? '<button class="act" type="button" data-notify-open-acceptance="' + escapeHtml(jump.acceptance) + '">' + escapeHtml(jump.label) + ' ↗</button>'
                      : '<button class="act" type="button"' + jumpAttrs(jump) + ">" + escapeHtml(jump.label) + ' ↗</button>')
                    : canAck ? '<button class="act" type="button" data-notify-ack="' + escapeHtml(row.key) + '" title="标记已处理（handled）">知道了</button>' : "";
                  const x = '<button class="x' + (row.active ? "" : " ghost") + '" type="button" data-notify-dismiss="' + escapeHtml(row.key) + '" title="清除这条通知" aria-label="清除通知">×</button>';
                  return '<div class="nrow ' + cls + (row.isNew ? " enter" : "") + '" data-notify-card data-notify-key="' + escapeHtml(row.key) + '" data-notify-active="' + (row.active ? "true" : "false") + '">'
                    + '<span class="ic"><svg class="icon-inline" aria-hidden="true"><use href="#icon-' + km.icon + '"></use></svg></span>'
                    + '<div class="t"><b>' + escapeHtml(row.title) + '</b><div class="s">' + escapeHtml(sub) + "</div></div>"
                    + act + x + "</div>";
                }

                function nodesFrom(markup) {
                  const template = document.createElement("template");
                  template.innerHTML = markup;
                  return template.content;
                }

                function syncCounts(count) {
                  if (headSub) headSub.textContent = count + " 项需行动"; // 专属属性（data-notify-panel-sub）——与手机端 [data-notify-action-count] 断耦（W-NQA F11 防复发）
                  if (railBadge) {
                    railBadge.textContent = String(count);
                    railBadge.hidden = count === 0;
                    railBadge.setAttribute("aria-label", "通知有 " + count + " 项需行动");
                    railBadge.setAttribute("title", "通知 · " + count + " 项需行动");
                  }
                }

                // ⑥a-4 来源会话水位块随三列检查器退役（V3 弹窗无检查器位；水位仍在会话域详情可见）

                function render() {
                  const waiting = bridge.waitingText();
                  if (waiting) {
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
                  // FB9 反馈接线：首见且需行动的行——声音短滴 + 桌面通知（各自开关与权限双重门控）
                  if (notifySeenInit && window.__ccDeck005NotifyFx) {
                    const fresh = rows.filter((r) => r.isNew && r.active);
                    if (fresh.length) {
                      if (window.__ccDeck005NotifyFx.soundOn()) window.__ccDeck005NotifyFx.ding();
                      window.__ccDeck005NotifyFx.desktop(fresh[0].title, fresh[0].body);
                    }
                  }
                  const actionRows = rows.filter((r) => r.active);
                  const attentionRows = rows.filter((r) => !r.active && r.unresolved);
                  const dynamicRows = rows.filter((r) => !r.unresolved);
                  // V3 三级分组：ndot r/y/n = 需你行动/注意/动态（组头带计数）
                  const group = (label, dot, items) => items.length
                    ? '<div class="ngrp"><i class="ndot ' + dot + '"></i>' + escapeHtml(label) + '<span class="cnt">' + items.length + "</span></div>" + items.map(rowMarkup).join("")
                    : "";
                  if (rows.length) {
                    panelBody.replaceChildren(nodesFrom(
                      group("需你行动", "r", actionRows)
                      + group("注意", "y", attentionRows)
                      + group("动态", "n", dynamicRows)));
                  } else {
                    panelBody.replaceChildren(nodesFrom('<div class="readonly-banner">暂无需要你行动的通知 · 行动项到达时在此提示。</div>'));
                  }
                  for (const r of rows) seenNotifyKeys.add(r.key);
                  notifySeenInit = true;
                  syncCounts(actionRows.length);
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
                  render();
                }
                function clearAllNotifications() {
                  const rows = lastRows.filter((r) => !dismissedNotifyKeys.has(r.key));
                  if (!rows.length) { toast("没有可清除的通知"); return; }
                  for (const row of rows) dismissRow(row);
                  render();
                  toast("已清除 " + rows.length + " 条通知");
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
                function setOpen(open) {
                  const on = !!open;
                  section.classList.toggle("on", on);
                  section.setAttribute("aria-hidden", on ? "false" : "true");
                  const bell = document.querySelector('.rail-btn[data-domain="notify"]');
                  if (bell) bell.classList.toggle("active", on); // 弹窗开着=铃铛高亮（V3 bell.on 同语言）
                  if (on) {
                    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    panel.focus({ preventScroll: true });
                  } else if (lastFocus && lastFocus.isConnected) {
                    try { lastFocus.focus({ preventScroll: true }); } catch (_) {}
                    lastFocus = null;
                  }
                }
                const isOpen = () => section.classList.contains("on");
                window.__ccDeck005NotifyPanel = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!isOpen()), isOpen };

                section.addEventListener("click", (event) => {
                  const target = event.target;
                  if (target.closest("[data-notify-mask]")) { setOpen(false); return; } // 点外关闭（遮罩即外）
                  if (target.closest("[data-notify-close]")) { setOpen(false); return; } // 头部 ×
                  const dismissButton = target.closest("[data-notify-dismiss]"); // FB18：行级 ✕ 先于跳转判定
                  if (dismissButton) { dismissRowByKey(dismissButton.dataset.notifyDismiss); return; }
                  const ackButton = target.closest("[data-notify-ack]");
                  if (ackButton) { ackNotification(ackButton.dataset.notifyAck); return; }
                  if (target.closest("[data-notify-clear-soft]")) { clearSoftNotifications(); return; }
                  if (target.closest("[data-notify-clear]")) { clearAllNotifications(); return; }
                  const open = target.closest("[data-notify-open-acceptance]");
                  if (open) { bridge.openAcceptance(open.dataset.notifyOpenAcceptance); setOpen(false); return; }
                  const jump = target.closest("[data-notify-jump]");
                  if (jump) { focusSource(jump); return; }
                  const card = target.closest("[data-notify-card]");
                  if (card && !target.closest("button") && card.dataset.notifyActive !== "true") toast("历史动态 · 已归档，无需处理");
                });

                bridge.subscribe(() => render());
                setTimeout(render, 0);
              })();
            