                // W-CMDIMPL ③（#216，设计 §3.3）：发版独立一级页（发版是运营动作不是设置）。
                // 数据面=POST /api/release 三 action 轮询（config-get 5s 运行中/30s 空闲）；
                // RELEASE_* WS 事件已由 relay 出（节流段落级），HTTP 快照面走 progress 字段
                //（P2 可切帧订阅——本版轮询，零帧闸改动）。
                // 文案=设计 §10 表：页名「发版」；动作钮「出 test 包（安卓）/出 test 包（桌面）」；
                // 失败条「出包失败——日志尾部与配对闸原因见下」。
                (() => {
                  const root = document.querySelector("#d-release");
                  if (!root) return;
                  const query = (selector) => root.querySelector(selector);
                  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
                  const state = { cfg: null, online: false, armed: null, pollTimer: null, mounted: false };
                  const CHANNEL_LABEL = new Map([["apk-test", "出 test 包（安卓）"], ["desktop-test", "出 test 包（桌面）"]]);
                  const relayBase = () => `${location.protocol}//${location.host}`;
                  const tokenOf = () => window.__ccDeck005Token || "";

                  async function api(action, extra = {}) {
                    const res = await fetch(`/api/release?token=${encodeURIComponent(tokenOf())}`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ action, ...extra }),
                    });
                    return res.json();
                  }

                  function fmtTime(ts) {
                    const d = new Date(Number(ts) || 0);
                    if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "—";
                    const p = (n) => String(n).padStart(2, "0");
                    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
                  }

                  function markup() {
                    const c = state.cfg;
                    if (!state.online) return '<div class="readonly-banner">等待 relay 连接…<br><span style="opacity:.65">发版是仅本机操作（在公司网/云通道下不可用）——请回到家庭网直连本机后再打开此页</span></div>';
                    if (!c) return '<div class="readonly-banner">正在加载发版面板…</div>';
                    if (c.has_release_env === false) return '<div class="readonly-banner">此源没有发版环境（发版在本机进行）</div>';
                    const runningIds = new Set((c.running || []).map((j) => j.channel));
                    const progress = c.progress || {};
                    const channels = (c.channels || []).map((ch) => {
                      const running = runningIds.has(ch.id);
                      const runningRow = (c.running || []).find((j) => j.channel === ch.id);
                      return `<div class="inspector-block"><div class="inspector-title"><span><b>${escape(CHANNEL_LABEL.get(ch.id) || ch.id)}</b>${ch.note ? ` <span class="faint">${escape(ch.note)}</span>` : ""}</span>${running ? '<span class="tag action">进行中</span>' : `<span class="tag ${ch.enabled ? "done" : ""}">${ch.enabled ? "已启用" : "未启用"}</span>`}</div>`
                        + (running ? `<div class="readonly-banner" role="status">${escape(progress[ch.id] || "进行中…")}</div>` : (progress[ch.id] ? `<div class="inspector-copy">${escape(progress[ch.id])}</div>` : ""))
                        + (running
                          ? ""
                          : `<div class="identity-cluster"><button type="button" class="primary-btn" data-release-run="${escape(ch.id)}"${ch.enabled ? "" : " disabled"}>出包</button></div>`)
                        + (runningRow ? `<div class="inspector-copy">启动于 ${fmtTime(runningRow.started_at)}</div>` : "")
                        + `</div>`;
                    }).join("");
                    const hist = (c.latest || []).map((r) => {
                      const cls = r.status === "done" ? "done" : r.status === "failed" ? "failed" : "waiting";
                      const urls = (r.urls || []).map((u) => `<a class="tag" href="${escape(u)}" target="_blank" rel="noreferrer">直链</a>`).join(" ");
                      return `<div class="activity-row activity-${cls}"><time>${escape(fmtTime(r.started_at))}</time><i class="act-glyph" aria-hidden="true">${r.status === "done" ? "✓" : r.status === "failed" ? "⚠" : "●"}</i><span><b class="act-st">${escape(r.status === "done" ? "完成" : r.status === "failed" ? "失败" : r.status === "interrupted" ? "已中断" : "进行中")}</b> ${escape(CHANNEL_LABEL.get(r.channel) || r.channel)}${r.note ? ` <span class="act-note">· ${escape(r.note)}</span>` : ""} ${urls}</span></div>`;
                    }).join("");
                    return `<div class="pane-summary">当前版本 <b>${escape(c.version || "—")}</b> <span class="faint">· 主仓主干状态已核验后可出包</span></div>`
                      + `<div class="readonly-banner" data-release-msg hidden></div>`
                      + channels
                      + `<div class="pane-summary">出包历史</div>`
                      + (hist || '<div class="readonly-banner">暂无出包记录</div>');
                  }

                  function armMarkup() {
                    const a = state.armed;
                    if (!a) return "";
                    return `<div class="wait-card" data-release-arm><strong class="wait-title">确认出包 · ${escape(CHANNEL_LABEL.get(a.channel) || a.channel)}</strong><p class="wait-copy">出包为不可逆动作：包推上分发后，已更新设备无法撤回。确认后开始。</p><div class="wait-actions"><button type="button" data-release-cancel>再想想</button><button type="button" class="allow" data-release-confirm>确认出包</button></div></div>`;
                  }

                  function render() {
                    const body = query("[data-release-body]");
                    if (!body) return;
                    body.innerHTML = markup() + armMarkup();
                    const meta = query("[data-release-meta]");
                    if (meta) {
                      const c = state.cfg;
                      if (c && c.version) { meta.innerHTML = ["版本 " + escape(c.version), c.main_repo ? escape(String(c.main_repo)) : ""].filter(Boolean).join('<span class="meta-sep">·</span>'); meta.hidden = false; }
                      else meta.hidden = true;
                    }
                    const src = query("[data-release-source]");
                    if (src && state.cfg) src.textContent = state.cfg.relay_source || "本机";
                  }

                  async function poll() {
                    try {
                      const r = await api("config-get");
                      if (r && r.ok) { state.cfg = r.data; state.online = true; }
                      else { state.online = r && r.error === "no_release_env" ? true : state.online; if (r && r.error === "no_release_env") state.cfg = { has_release_env: false, channels: [], latest: [] }; }
                    } catch { state.online = false; }
                    render();
                    const running = (state.cfg && (state.cfg.running || []).length > 0) || false;
                    if (state.mounted) {
                      if (state.pollTimer) clearTimeout(state.pollTimer);
                      state.pollTimer = setTimeout(poll, running ? 5000 : 30000);
                    }
                  }

                  async function runChannel(channel) {
                    const c = state.cfg;
                    if (!c) return;
                    state.armed = { channel };
                    render();
                  }

                  async function doRun() {
                    const a = state.armed;
                    if (!a) return;
                    state.armed = null;
                    render();
                    try {
                      const r = await api("run", { channel: a.channel, note: a.note || "", confirm: true });
                      const msg = query("[data-release-msg]");
                      if (msg) {
                        msg.hidden = false;
                        msg.textContent = r && r.ok ? "已启动出包，进度见下方。" : `出包失败——${r && r.error === "需二次确认（confirm:true）——出包后已装设备无法撤回" ? "未带确认" : (r && r.error) || "未知错误"}`;
                      }
                    } catch (e) {
                      feedback("出包请求失败：" + String(e?.message || e));
                    }
                    poll();
                  }

                  function feedback(text) {
                    if (window.__ccDeck005B4 && typeof window.__ccDeck005B4.toast === "function") window.__ccDeck005B4.toast(text);
                    else console.info("[release] " + text);
                  }

                  root.addEventListener("click", (event) => {
                    const runBtn = event.target.closest("[data-release-run]");
                    if (runBtn) { event.stopPropagation(); void runChannel(runBtn.dataset.releaseRun); return; }
                    if (event.target.closest("[data-release-confirm]")) { event.stopPropagation(); void doRun(); return; }
                    if (event.target.closest("[data-release-cancel]")) { event.stopPropagation(); state.armed = null; render(); return; }
                  });

                  window.ccDeckRelease = Object.freeze({
                    mount() { if (!state.mounted) { state.mounted = true; void poll(); } },
                    unmount() { state.mounted = false; if (state.pollTimer) clearTimeout(state.pollTimer); },
                    onEvent() { return false; },
                  });
                  // rail 切到发版页即挂载轮询（域切换零 settings-domain 改动——setDesktopDomain 通用）
                  document.addEventListener("click", (ev) => {
                    const btn = ev.target.closest?.(".rail-btn[data-domain='release']");
                    if (btn) window.ccDeckRelease.mount();
                  });
                })();
