// W-CONNV4E 探针：网页端 wb- 聚合行 + mobile 源列表 lane 五段序同步 + 连入台账只读。
// probe-connv4c2 手法（真 Chrome headless + CDP + file:// index-005 + fetch 拦截 mock）。
// mock 三口：/api/device-admin（批C1 形态）、/api/lan-peers 与 /api/lan-connect-send
//（批D connv4d ws-server 形状勘定：{ok,mdns,peers:[{dev,name,conn}]}——批D 未合入 dev，
// 本探针 mock 之=条件渲染「有则渲染」面的验证；404 相验证「旧版隐藏」面）。
// 直跑：cd relay && node scripts/probe-connv4e.mjs
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9990 + Math.floor(Math.random() * 60);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/connv4e-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await wait(2200);
for (let i = 0; i < 8; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/list`); break; } catch { await wait(1000); } }
const tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map(); const errs = [];
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; } if (m.method === "Runtime.exceptionThrown") errs.push(String(m.params.exceptionDetails?.text).slice(0, 120)); });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*"] }); // 隔离真 relay（单源注帧——connv4a 同款）
await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{ id: "srv-a", kind: "cloud", name: "公司中继", wsUrl: "wss://example-a.cc-deck.win/ws", token: "t1", cloud: { paired: true } }]))`);
await ev(`localStorage.setItem("cc-deck-005-token", "tok-probe")`);
await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ token: "atk-test", user: "xdd" }))`);
const now = Date.now();
const D = 3_600_000;
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [], logs: {}, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [],
  acct_relays: [ // 段2+3 夹具：在线 1（名字序单元素）+离线 1（带 ts）
    { dev: "rl-aabbcc01", name: "公司 Mac", online: true },
    { dev: "rl-aabbcc02", name: "家里 Win", online: false, ts: now - 3 * 3600_000 },
  ],
  relay_devices: [] } };
await send("Page.navigate", { url: "file:///private/tmp/cc-deck-w-connv4e/web-console/index-005.html" }); // reload 在 file:// headless 有半死上下文竞态（BOOT-FAIL 实锤）——navigate 全新导航稳定
let booted = false;
for (let i = 0; i < 10; i++) { await wait(800); booted = await ev(`!!document.querySelector("#stage-desktop")`); if (booted) break; }
if (!booted) { console.error("BOOT-FAIL：#stage-desktop 未建"); try { globalThis.__p.kill(); } catch {} process.exit(1); }
await wait(500);
// ---------- mock 三口（fetch 拦截——先于设置域首拉挂载） ----------
await ev(`(() => {
  window.__ccDeck005Token = "tok-probe";
  window.__devAdminCalls = [];
  window.__lanCalls = [];
  window.__toastLog = [];
  window.__mockDevAdmin = { mode: "404", devices: [
    { dev: "ph-aabb11", kind: "phone", name: "我的手机", paired_at: ${now - 3 * 24 * 3600_000}, last_seen: ${now - 30_000}, online: true, trust: "confirmed", cooldown_until: null, ignored_at: null, note: null },
    { dev: "wb-111aaa", kind: "web", name: "", paired_at: ${now - 40 * 60_000}, last_seen: ${now - 5000}, online: true, trust: "none", cooldown_until: null, ignored_at: null, note: null },
    { dev: "wb-222bbb", kind: "web", name: "", paired_at: ${now - 2 * 3600_000}, last_seen: ${now - 10_000}, online: true, trust: "none", cooldown_until: null, ignored_at: null, note: null },
    { dev: "wb-333ccc", kind: "web", name: "", paired_at: ${now - 24 * 3600_000}, last_seen: ${now - 8 * 3600_000}, online: false, trust: "none", cooldown_until: null, ignored_at: null, note: null },
    { dev: "wb-alpha111", kind: "web", name: "公司浏览器", paired_at: ${now - 2 * 24 * 3600_000}, last_seen: ${now - 5 * 3600_000}, online: false, trust: "confirmed", cooldown_until: ${now + 22 * D}, ignored_at: null, note: null },
  ] };
  window.__mockLan = { mode: "404", peers: [
    { dev: "rl-aabbccdd", name: "客厅小主机", conn: "none" },
    { dev: "rl-11223344", name: "书房 Mac", conn: "pending" },
  ] };
  window.__origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes("/api/device-admin")) {
      let body = {}; try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (_) {}
      window.__devAdminCalls.push({ action: body.action || "?", dev: body.dev || "" });
      const m = window.__mockDevAdmin;
      if (m.mode === "404") return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 404, headers: { "content-type": "application/json" } }));
      if (body.action === "list") return Promise.resolve(new Response(JSON.stringify({ ok: true, devices: JSON.parse(JSON.stringify(m.devices)) }), { status: 200, headers: { "content-type": "application/json" } }));
      const d = m.devices.find(x => x.dev === body.dev);
      if (d && body.action === "kick") { d.cooldown_until = Date.now() + 22 * 3600_000; d.online = false; } // 账号类 kick=断开+24h 冷却（批C1 语义）
      return Promise.resolve(new Response(JSON.stringify({ ok: true, action: body.action, dev: body.dev }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (u.includes("/api/lan-peers")) {
      const m = window.__mockLan;
      if (m.mode === "404") return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 404, headers: { "content-type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, mdns: true, peers: JSON.parse(JSON.stringify(m.peers)), self: "rl-self0001" }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (u.includes("/api/lan-connect-send")) {
      let body = {}; try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (_) {}
      window.__lanCalls.push({ dev: body.dev || "", op: body.op || "" });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "pending" }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return window.__origFetch(url, opts);
  };
  try { const b = window.__ccDeck005B4; if (b && b.toast) { const o = b.toast.bind(b); b.toast = (msg, kind) => { window.__toastLog.push(String(msg) + "|" + String(kind || "")); return o(msg, kind); }; } } catch (_) {}
  return true;
})()`);
await ev(`window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} };`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(700);
await ev(`(() => { const b = document.querySelector('.rail-btn[data-domain="settings"]'); if (b) b.click(); return !!b; })()`);
await wait(900);
await ev("window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()");
await wait(900);
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const png = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync("/tmp/connv4e-" + name + ".png", Buffer.from(r.result.data, "base64")); };
const devLiveInfo = () => ev(`(() => {
  const live = document.querySelector('[data-settings-live="devices"]');
  if (!live) return JSON.stringify({ none: 1 });
  const rows = [...live.querySelectorAll(".dev-row")];
  const agg = live.querySelector('[data-devadmin-row="__wb-agg__"]');
  return JSON.stringify({ none: 0, n: rows.length, txt: live.textContent,
    agg: agg ? { sub: (agg.querySelector(".v8-swd") || {}).textContent || "", wbkick: !!agg.querySelector("[data-devadmin-wbkick]"), tags: [...agg.querySelectorAll(".tag")].map(x => x.textContent) } : null,
    confirm: (live.querySelector(".devadmin-confirm") || {}).textContent || "" });
})()`);

// ---------- 相一：旧 relay 404（device-admin 缺席）→ 台账旧链 + 聚合不出现 ----------
let g = JSON.parse(await devLiveInfo());
ok(g.none === 0 && !g.agg && !g.txt.includes("网页 ×"), `①404 旧 relay=聚合行不出现（device-admin 能力缺席回落旧链——${g.n} 行旧形态）`);

// ---------- 相二：台账生效 → wb- 聚合行 + 有名行照旧 ----------
await ev(`window.__mockDevAdmin.mode = "ok"; window.__ccDeck005DevAdminRefresh && window.__ccDeck005DevAdminRefresh()`);
await wait(900);
g = JSON.parse(await devLiveInfo());
ok(g.agg && g.txt.includes("网页 ×3") && g.agg.sub.includes("在线 2 / 3"), `②无名 wb- 聚合一行「网页 ×3」+在线数/总数副行（sub=${g.agg ? g.agg.sub.slice(0, 30) : "无聚合行"}）`);
ok(g.agg && g.agg.wbkick && g.agg.tags.includes("网页") && g.agg.tags.includes("在线"), `③聚合行「断开」钮在场（R6 定案：仅断当前连接）+类型/在线小标`);
ok(!g.txt.includes("网页设备"), `④无名 wb- 不再逐行显示（「网页设备」占名行退役——聚合语义）`);
ok(g.txt.includes("公司浏览器") && g.txt.includes("冷却中"), `⑤带名字 wb- 行（配对过的网页源）不聚合照旧（公司浏览器+冷却中 tag）`);
await png("1-wb-agg-row");

// ---------- 相三：聚合断开确认+批量 kick ----------
await ev(`document.querySelector("[data-devadmin-wbkick]").click()`); await wait(400);
g = JSON.parse(await devLiveInfo());
ok(g.confirm.includes("断开全部 2 个网页连接") && g.confirm.includes("24 小时"), `⑥聚合确认条分型文案（${g.confirm.slice(0, 30)}）`);
await ev(`document.querySelector('[data-devadmin-go="__wb-agg__"]').click()`); await wait(1100);
let calls = await ev(`JSON.stringify(window.__devAdminCalls.filter(c => c.action === "kick"))`);
ok(calls.includes("wb-111aaa") && calls.includes("wb-222bbb") && !calls.includes("wb-333ccc") && !calls.includes("wb-alpha111") && (calls.match(/kick/g) || []).length === 2,
  `⑦确认→恰对 2 个在线无名 wb- 发 kick（离线/有名行不踢——${calls}）`);
let toasts = await ev(`JSON.stringify(window.__toastLog || [])`);
ok(toasts.includes("已断开 · 2 个网页连接 · 24 小时内不再自动重连"), `⑧批量断开成功 toast 计数句（${toasts.slice(-80)}）`);
g = JSON.parse(await devLiveInfo());
ok(g.agg && g.agg.sub.includes("全部离线") && !g.agg.wbkick, `⑨重拉后聚合行副行翻「全部离线」+断开钮退役（在线 0=无可断）`);
await png("2-wb-agg-after-kick");

// ---------- 相四：mobile 源列表 lane 五段序（非 cloud 分支真链路；LAN mock 先 404） ----------
await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
await wait(400);
await ev(`document.getElementById('stage-desktop').classList.remove('active'); document.getElementById('stage-mobile').classList.add('active')`);
await ev(`document.querySelector('.mobile-nav [data-mobile-root="settings"]')?.click()`); // 走移动导航真入口（直改 class 不换 active 独占态——probe-uiv3 同款坑：截图会捕到收件箱）
await wait(600);
const mobInfo = (render) => ev(`(() => {
  const content = document.querySelector("#m-settings .mobile-content");
  if (!content || typeof content._renderSettingsDetail !== "function") return JSON.stringify({ none: 1 });
  if (${render ? "true" : "false"}) { try { content._renderSettingsDetail("连接与设备"); } catch (e) { return JSON.stringify({ none: 3, err: String(e && e.message) }); } }
  const detail = content.querySelector(".mobile-settings-detail");
  if (!detail || detail.hidden) return JSON.stringify({ none: 2 });
  const lanes = [...detail.querySelectorAll(".mobile-lane")];
  const srcLane = lanes.find(l => (l.querySelector(".mobile-lane-head") || {}).textContent.includes("源列表"));
  const devLane = lanes.find(l => (l.querySelector(".mobile-lane-head") || {}).textContent.includes("连进来的设备"));
  const tasks = srcLane ? [...srcLane.querySelectorAll(".mobile-task")] : [];
  return JSON.stringify({ none: 0, srcTxt: srcLane ? srcLane.textContent : "",
    order: tasks.map(t => (t.querySelector("strong") || {}).textContent || t.textContent.slice(0, 12)),
    local: srcLane ? { goto: !!srcLane.querySelector("[data-src-goto-local]"), cur: !!srcLane.querySelector("[data-src-goto-local] .tag.done") } : null,
    acctOn: srcLane ? srcLane.querySelectorAll("[data-acct-relay-connect]").length : 0,
    acctOff: srcLane ? srcLane.querySelectorAll(".src-offline").length : 0,
    lanTag: srcLane ? [...srcLane.querySelectorAll(".tag")].filter(t => t.textContent === "局域网").length : 0,
    lanBtn: srcLane ? !!srcLane.querySelector("[data-lan-connect-m]") : false,
    addBtn: srcLane ? !!srcLane.querySelector("[data-settings-add]") : false,
    devTxt: devLane ? devLane.textContent : "", devAdminKeys: devLane ? devLane.querySelectorAll("[data-devadmin-kick],[data-devadmin-ignore],[data-devadmin-wbkick]").length : -1 });
})()`);
await wait(300);
g = JSON.parse(await mobInfo(true));
ok(g.none === 0, `⑩mobile 设置详情真链路渲染（_renderSettingsDetail 连接与设备）`);
ok(g.local && g.local.goto && g.local.cur, `⑪段1 本机行置顶在场（data-src-goto-local+「当前」tag——与桌面同锚）`);
ok(g.acctOn === 1 && g.acctOff === 1 && g.srcTxt.includes("3 小时前在线"), `⑫段2+3 同账号三态（在线 1「连接」钮+离线 1 灰显带上次在线）`);
ok(g.lanTag === 0 && !g.lanBtn, `⑬LAN 段条件渲染·404 面（批D 未合入现实：lan-peers 404=「局域网」标 0 处、无发起连接钮——段隐藏非报错）`);
ok(g.addBtn, `⑭「＋ 添加」钮在场（data-settings-add 文档级委托同款）`);
ok(g.order.length >= 4 && g.order[0] === "本机 relay" && g.order.indexOf("家里 Win") > g.order.indexOf("公司 Mac") && g.srcTxt.includes("公司中继"),
  `⑮段序与桌面同构（本机→acct 在线→acct 离线→配对码源——${g.order.join(" | ")}）`);
await png("3-mobile-lane-404");

// ---------- 相四b：LAN mock 生效（批D 合入后形态）→ 补拍重渲段出现 ----------
await ev(`window.__mockLan.mode = "ok"`);
await wait(5700); // 过 MOBILE_LAN 5s 节流窗（404 拍已记账 at——真实用户无此时序，探针 mock 切换的人为窗）
await mobInfo(true); // 渲染拍：fetchMobileLanPeers 重新发起（异步——本拍渲染仍无 LAN）
await wait(2100); // fetch 落定 + 补拍计时 1.6s 重渲吃数据（laneSig 串变触发）
g = JSON.parse(await mobInfo(false));
ok(g.lanTag >= 1 && g.lanBtn, `⑯LAN 段条件渲染·数据面（「局域网」标+发起连接钮——API 在场即通，批D 合入后免改）`);
ok(g.lanTag >= 1 && g.order.indexOf("客厅小主机") > g.order.indexOf("家里 Win") && g.order.indexOf("公司中继") > g.order.indexOf("客厅小主机"),
  `⑰五段全序落位（LAN 段在离线同账号之后、配对码源之前——1117 排序口径：${g.order.join(" | ")}）`);
await png("4-mobile-lane-lan");
// 发起连接点击（mobile 锚）→ POST lan-connect-send
await ev(`(() => { const b = document.querySelector("#m-settings [data-lan-connect-m]"); if (b) b.click(); return !!b; })()`);
await wait(700);
calls = await ev(`JSON.stringify(window.__lanCalls)`);
const toastTxt = await ev(`(() => { const t = document.getElementById("toast"); return t ? t.textContent : ""; })()`); // showToast=域内自绘 DOM toast（与批D lanConnectSend 同款），不走 B4.toast 记账
ok(calls.includes('"dev":"rl-aabbccdd"') && calls.includes('"op":"request"'), `⑱发起连接走 mobile 锚→POST lan-connect-send（${calls}）`);
ok(toastTxt.includes("已发起 · 等待对方确认"), `⑱b 发起 toast 分型句（pending 态——DOM toast：${toastTxt.slice(0, 20)}）`);

// ---------- 相五：连入台账只读（mobile 反向视图最小面——device-admin mock 仍是相二 kick 后态） ----------
g = JSON.parse(await mobInfo(false));
ok(g.devTxt.includes("网页 ×3") && g.devTxt.includes("共用主 token"), `⑲mobile 台账只读聚合行（网页 ×3——与桌面聚合判定同构）`);
ok(g.devTxt.includes("我的手机") && g.devTxt.includes("公司浏览器") && g.devTxt.includes("只读"), `⑳named 行照旧+「只读」标（mobile 管理面独立立项，本批只看）`);
ok(g.devAdminKeys === 0, `㉑零管理钮（data-devadmin-* 在 mobile 详情 0 处）`);
await ev(`(() => { const lane = [...document.querySelectorAll("#m-settings .mobile-lane")].find(l => (l.querySelector(".mobile-lane-head") || {}).textContent.includes("连进来的设备")); if (lane) lane.scrollIntoView({ block: "start" }); return !!lane; })()`); // 截图滚动到位（全页截图吃视口位）
await wait(300);
await png("5-mobile-devices-readonly");

// ---------- 相六：挂口与 cloudMobileLane 同源（cloud 分支渲染口零回归） ----------
const cloudLane = await ev(`(() => { try { return window.__ccDeck005CloudUI.mobileLane(); } catch (e) { return "ERR:" + e.message; } })()`);
ok(typeof cloudLane === "string" && cloudLane.includes("data-cloud-mobile-slot") && cloudLane.includes("data-src-goto-local") && cloudLane.includes("data-acct-relay-connect"),
  `㉒cloudMobileLane 同源重构（壳锚保留+本机行+acct 段在场——len=${typeof cloudLane === "string" ? cloudLane.length : cloudLane}）`);
const laneStr = await ev(`(() => { try { return window.__ccDeck005MobileSourceLane(); } catch (e) { return "ERR:" + e.message; } })()`);
ok(typeof laneStr === "string" && laneStr.includes("mobile-lane") && laneStr.includes("data-src-goto-local"), `㉓mobile 源列表挂口产出完整 lane（cloud 与非 cloud 分支同源单口——len=${typeof laneStr === "string" ? laneStr.length : laneStr}）`);

ok(errs.length === 0, `㉔console 零异常（${errs.length} 条${errs.length ? "：" + errs.slice(0, 2).join(" | ") : ""}）`);
console.log(`\nconnv4e probe：${pass} ok / ${fail} FAIL`);
try { globalThis.__p.kill(); } catch {}
process.exit(fail ? 1 : 0);
