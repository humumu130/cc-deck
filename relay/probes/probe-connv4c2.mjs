// W-CONNV4C2 探针：连入设备台账+双键（web UI 面）——probe-connv4a 手法（真 Chrome headless
// + CDP + file:// index-005 + 夹具 SNAPSHOT）。API 面=window.fetch 拦截 mock /api/device-admin
//（桥侧 PR#145 形态：list/kick/ignore/unignore + 503 fail-closed + 404 旧 relay）——真桥未部署
//（PR#145 未合），mock 形态按本单 API 勘定（ws-server.ts da88f5b5）。
// 直跑：cd relay && node probes/probe-connv4c2.mjs
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9980 + Math.floor(Math.random() * 60);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/connv4c2-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
const SHELL_URL = "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname); // 主仓相对解析（原硬编码 /tmp 工区路径——树收割清扫后死路 BOOT-FAIL 实锤 1123）
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
// 壳装载前置：localStorage 源态（无 ccd_servers 壳不建 #stage-desktop——connv4a 同款前置，本探针首跑 0 行实锤补上）
await ev(`localStorage.setItem("ccd_servers", JSON.stringify([{ id: "srv-a", kind: "cloud", name: "公司中继", wsUrl: "wss://example-a.cc-deck.win/ws", token: "t1", cloud: { paired: true } }]))`);
await ev(`localStorage.setItem("cc-deck-005-token", "tok-probe")`);
await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ token: "atk-test", user: "xdd" }))`);
const now = Date.now();
const D = 3_600_000;
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [], logs: {}, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [],
  // 旧台账：wb-alpha111 与 mock admin 台账同键（合并去重锚）；wb-legacy99 纯旧侧（尾插锚）
  relay_devices: [
    { id: "wb-alpha111", kind: "browser", name: "公司浏览器", online: false, last_seen: now - 5 * 3600_000, first_seen: now - 2 * 24 * 3600_000 },
    { id: "wb-legacy99", kind: "browser", name: "纯旧行", online: true, last_seen: now, first_seen: now - 24 * 3600_000 },
  ] } };
await send("Page.navigate", { url: SHELL_URL }); // reload 在 file:// headless 有半死上下文竞态（BOOT-FAIL 实锤）——navigate 全新导航稳定
let booted = false;
for (let i = 0; i < 10; i++) { await wait(800); booted = await ev(`!!document.querySelector("#stage-desktop")`); if (booted) break; }
if (!booted) { console.error("BOOT-FAIL：#stage-desktop 未建（壳装载竞态——localStorage 源态/时序）"); try { globalThis.__p.kill(); } catch {} process.exit(1); }
await wait(500);
// ---------- mock /api/device-admin（fetch 拦截——先于设置域首拉挂载） ----------
await ev(`(() => {
  window.__ccDeck005Token = "tok-probe"; // token 链尾镜像（:1874 canonical——file:// 无 wsUrl 形态 ctx/闭包恒空，镜像口径同 acctLanToken :4384）
  window.__devAdminCalls = [];
  window.__toastLog = [];
  window.__mockDevAdmin = { mode: "404", devices: [
    { dev: "ph-aabb11", kind: "phone", name: "我的手机", paired_at: ${now - 3 * 24 * 3600_000}, last_seen: ${now - 30_000}, online: true, trust: "confirmed", cooldown_until: null, ignored_at: null, note: null },
    { dev: "wb-alpha111", kind: "web", name: "公司浏览器", paired_at: ${now - 2 * 24 * 3600_000}, last_seen: ${now - 5 * 3600_000}, online: false, trust: "confirmed", cooldown_until: ${now + 22 * D}, ignored_at: null, note: null },
    { dev: "wt-ccdd33", kind: "watch", name: "手表端", paired_at: ${now - 24 * 3600_000}, last_seen: ${now - 60_000}, online: true, trust: "confirmed", cooldown_until: null, ignored_at: null, note: null },
    { dev: "ph-eeff44", kind: "phone", name: "旧手机", paired_at: ${now - 10 * 24 * 3600_000}, last_seen: ${now - 3 * 24 * 3600_000}, online: false, trust: "revoked", cooldown_until: null, ignored_at: ${now - 24 * 3600_000}, note: null },
  ] };
  window.__origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (!u.includes("/api/device-admin")) return window.__origFetch(url, opts);
    let body = {}; try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (_) {}
    window.__devAdminCalls.push({ action: body.action || "?", dev: body.dev || "" });
    const m = window.__mockDevAdmin;
    if (m.mode === "404") return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "no api" }), { status: 404, headers: { "content-type": "application/json" } }));
    if (m.mode === "503") return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "存储不可用，管理数据写入失败（fail-closed）" }), { status: 503, headers: { "content-type": "application/json" } }));
    if (body.action === "list") return Promise.resolve(new Response(JSON.stringify({ ok: true, devices: JSON.parse(JSON.stringify(m.devices)) }), { status: 200, headers: { "content-type": "application/json" } }));
    const d = m.devices.find(x => x.dev === body.dev);
    if (d) {
      if (body.action === "kick") { if (d.kind === "phone") { d.trust = "revoked"; } else { d.cooldown_until = Date.now() + 22 * 3600_000; } d.online = false; }
      if (body.action === "ignore") { d.ignored_at = Date.now(); d.online = false; }
      if (body.action === "unignore") { d.ignored_at = null; d.cooldown_until = null; d.trust = "pending"; }
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true, action: body.action, dev: body.dev }), { status: 200, headers: { "content-type": "application/json" } }));
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
await wait(900); // 首拍 render（settingsReady 门）+首拉 404 落定
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const png = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync("/tmp/connv4c2-" + name + ".png", Buffer.from(r.result.data, "base64")); };
const devLiveInfo = () => ev(`(() => {
  const live = document.querySelector('[data-settings-live="devices"]');
  if (!live) return JSON.stringify({ none: 1 });
  const rows = [...live.querySelectorAll(".dev-row")];
  const byName = {};
  for (const r of rows) { const w = r.querySelector(".v8-swtxt"); let name = ""; if (w) { const f = [...w.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()); name = f ? f.textContent.trim() : w.textContent.trim().slice(0, 12); } byName[name] = { ignored: r.classList.contains("dev-ignored"), tags: [...r.querySelectorAll(".tag")].map(x => x.textContent), sub: (r.querySelector(".v8-swd") || {}).textContent || "", kick: !!r.querySelector("[data-devadmin-kick]"), ignore: !!r.querySelector("[data-devadmin-ignore]"), unignore: !!r.querySelector("[data-devadmin-unignore]"), dev: r.getAttribute("data-devadmin-row") || "" }; }
  return JSON.stringify({ none: 0, n: rows.length, order: rows.map(r => r.getAttribute("data-devadmin-row") || "(legacy)"), names: Object.keys(byName), byName, confirm: (live.querySelector(".devadmin-confirm") || {}).textContent || "", tagLens: [...live.querySelectorAll(".dev-row .tag")].map(x => x.textContent.length) });
})()`);

// ---------- 相一：旧 relay 404 → 回落旧台账链 ----------
let g = JSON.parse(await devLiveInfo());
ok(g.none === 0 && g.n === 2 && g.order.every(x => x === "(legacy)") && !JSON.stringify(g.byName).includes("data-devadmin") && !!g.byName["公司浏览器"] && !!g.byName["纯旧行"],
  `①旧 relay 404=能力位回落旧链（${g.n} 行全 legacy：公司浏览器+纯旧行，无管理钮——relay_devices 渲染零改）`);

// ---------- 相二：mock 台账生效 → 新链渲染 ----------
await ev(`window.__mockDevAdmin.mode = "ok"; window.__ccDeck005DevAdminRefresh && window.__ccDeck005DevAdminRefresh()`);
await wait(900);
g = JSON.parse(await devLiveInfo());
ok(g.n === 5, `②新链台账渲染 5 行（4 admin+1 纯旧侧尾插；同键 wb-alpha111 合并去重无重复——order=${g.order.join(",")}）`);
ok(g.byName["我的手机"] && g.byName["我的手机"].tags.includes("手机") && g.byName["手表端"].tags.includes("手表") && g.byName["公司浏览器"].tags.includes("网页") && g.byName["纯旧行"],
  `③类型标 ≤2 字（手机/手表/网页——手表无独立字形 tag 消歧）`);
ok(g.byName["我的手机"].tags.includes("在线") && g.byName["公司浏览器"].tags.includes("离线") && g.byName["公司浏览器"].tags.includes("冷却中") && g.byName["公司浏览器"].sub.includes("冷却剩"),
  `④在线态灯+管理态小标（在线/离线+冷却中 tag+sub 冷却剩 N 小时）`);
const names = g.names;
ok(g.order[3] === "ph-eeff44" && g.byName["旧手机"].ignored && g.byName["旧手机"].unignore && !g.byName["旧手机"].kick,
  `⑤忽略行沉底灰显（末位+dev-ignored+恢复钮替换双键）`);
ok(g.byName["我的手机"].kick && g.byName["我的手机"].ignore && g.byName["手表端"].kick, `⑥活动行双键在场（踢+忽略）`);
ok(g.tagLens.every(l => l <= 3), `⑦小标签军规 ≤3 字（实测长度集 ${[...new Set(g.tagLens)].join(",")}）`);
await png("1-ledger");

// ---------- 相三：双键分型确认+动作链 ----------
await ev(`document.querySelector('[data-devadmin-kick="ph-aabb11"]').click()`); await wait(400);
g = JSON.parse(await devLiveInfo());
ok(g.confirm.includes("踢出后需重新配对"), `⑧手机类踢=分型文案「踢出后需重新配对」（确认条=${g.confirm.slice(0, 24)}）`);
await ev(`document.querySelector("[data-devadmin-cancel]").click()`); await wait(300);
g = JSON.parse(await devLiveInfo());
ok(!g.confirm, "⑧b 取消钮收条（确认条消失）");
await ev(`document.querySelector('[data-devadmin-kick="ph-aabb11"]').click()`); await wait(300);
await ev(`document.querySelector('[data-devadmin-go="ph-aabb11"]').click()`); await wait(900);
let toasts = await ev(`JSON.stringify(window.__toastLog || [])`);
ok(toasts.includes("已踢出 · 对方需重新配对后才能再连"), `⑨手机类踢→成功 toast 分型句「已踢出 · 对方需重新配对后才能再连」（P1-A 两型锚·手机侧）`);
let calls = await ev(`JSON.stringify(window.__devAdminCalls.slice(-2))`);
ok(calls.includes('"action":"kick"') && calls.includes("ph-aabb11"), `⑨b 写口调用形态（POST body action=kick dev=ph-aabb11——${calls}）`);
g = JSON.parse(await devLiveInfo());
ok(g.byName["我的手机"].tags.includes("离线"), "⑨c 动作后 list 重拉回渲（手机行翻离线）");
await ev(`document.querySelector('[data-devadmin-ignore="wb-alpha111"]').click()`); await wait(300);
g = JSON.parse(await devLiveInfo());
ok(g.confirm.includes("永久忽略，可在下方恢复"), `⑩忽略=确认文案「永久忽略，可在下方恢复」（${g.confirm.slice(0, 24)}）`);
await ev(`document.querySelector('[data-devadmin-go="wb-alpha111"]').click()`); await wait(900);
g = JSON.parse(await devLiveInfo());
ok(g.byName["公司浏览器"].ignored && g.byName["公司浏览器"].unignore && g.order.indexOf("wb-alpha111") > g.order.indexOf("wt-ccdd33"), `⑩b 确认忽略→行沉底灰显+恢复钮（wb-alpha111 位=${g.order.indexOf("wb-alpha111")} 已沉到全部活动行之下）`);
await png("2-ignored-sunk");
await ev(`document.querySelector('[data-devadmin-unignore="ph-eeff44"]').click()`); await wait(900);
toasts = await ev(`JSON.stringify(window.__toastLog || [])`);
g = JSON.parse(await devLiveInfo());
ok(toasts.includes("已恢复 · 对方需重新配对/确认后再连") && !g.byName["旧手机"].ignored && g.byName["旧手机"].kick, `⑪恢复链（无确认直做→toast 回执文案+行回活动区双键回归）`);

// ---------- 相四：写面 503 诚实失败（不假成功） ----------
await ev(`window.__mockDevAdmin.mode = "503"`);
await ev(`document.querySelector('[data-devadmin-kick="wt-ccdd33"]').click()`); await wait(300);
await ev(`document.querySelector('[data-devadmin-go="wt-ccdd33"]').click()`); await wait(900);
toasts = await ev(`JSON.stringify(window.__toastLog || [])`);
g = JSON.parse(await devLiveInfo());
ok(toasts.includes("操作未生效：管理数据写入失败"), `⑫503 fail-closed=人话失败 toast（${toasts.slice(-90)}）`);
ok(g.byName["手表端"].tags.includes("在线") && g.byName["手表端"].kick, "⑫b 不假成功（行态不动、双键仍在——未把失败当成功渲染）");
await png("3-confirm-and-fail");

// ---------- 相四b（返修 fix1·P1-A）：账号类（手表）踢出成功 toast 分型——mock 写成功态 ----------
await ev(`window.__mockDevAdmin.mode = "ok"`);
await ev(`document.querySelector('[data-devadmin-kick="wt-ccdd33"]').click()`); await wait(300);
g = JSON.parse(await devLiveInfo());
ok(g.confirm.includes("断开并 24 小时内不再自动重连"), `⑨d 手表类踢=确认条分型「断开并 24 小时内不再自动重连」（${g.confirm.slice(0, 26)}）`);
await ev(`document.querySelector('[data-devadmin-go="wt-ccdd33"]').click()`); await wait(900);
const lastToast = await ev(`(window.__toastLog || []).slice(-1)[0] || ""`);
ok(lastToast.startsWith("已断开 · 24 小时内不再自动重连"), `⑨e 手表类踢→成功 toast 分型句「已断开 · 24 小时内不再自动重连」（P1-A 两型锚·账号侧，末条=${lastToast}——旧恒定文案「已踢出·需重新配对」不得出现于手表链）`);
g = JSON.parse(await devLiveInfo());
ok(g.byName["手表端"].tags.includes("离线") && g.byName["手表端"].tags.includes("冷却中"), `⑨f 手表类踢后重拉回渲（翻离线+冷却中 tag——账号类 kick=断开+24h 冷却，toast 与行态语义一致）`);

// ---------- 相五（返修 fix1·P2-a）：token 全空形态=诚实占位（非「正在读取」恒驻） ----------
// 二次导航=全新上下文：file:// 形态 URL 无 ?token=，域脚本装载即 __ccDeck005Token=""（:1892）——
// token 链三源（ctx.cfg/闭包 relayToken/尾镜像）全空=devAdminUrl null 连请求都不发的形态。
await send("Page.navigate", { url: SHELL_URL });
let booted2 = false;
for (let i = 0; i < 10; i++) { await wait(800); booted2 = await ev(`!!document.querySelector("#stage-desktop")`); if (booted2) break; }
if (!booted2) { console.error("BOOT-FAIL-2：二次导航 #stage-desktop 未建"); try { globalThis.__p.kill(); } catch {} process.exit(1); }
await wait(500);
await ev(`(() => { // mock 重挂（新上下文）——特意不设 window.__ccDeck005Token；此 mock 兼作探流器：若代码仍发起 list，__devAdminCalls 会记账且 cache 落地换渲染
  window.__devAdminCalls = []; window.__toastLog = [];
  window.__mockDevAdmin = { mode: "ok", devices: [] };
  window.__origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (!u.includes("/api/device-admin")) return window.__origFetch(url, opts);
    let body = {}; try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (_) {}
    window.__devAdminCalls.push({ action: body.action || "?" });
    const m = window.__mockDevAdmin;
    if (body.action === "list") return Promise.resolve(new Response(JSON.stringify({ ok: true, devices: m.devices }), { status: 200, headers: { "content-type": "application/json" } }));
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
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
const calls5 = await ev(`JSON.stringify(window.__devAdminCalls)`);
const esc5 = await ev(`(() => { const l = document.querySelector('[data-settings-live="devices"]'); return l ? l.textContent : "<none>"; })()`);
ok(esc5.includes("当前 relay 版本未下发客户端台账") && !esc5.includes("正在读取"), `⑭ token 全空=诚实占位（「当前 relay 版本未下发客户端台账」族在场、「正在读取」恒驻退役——P2-a 修复锚；devLive=${esc5.slice(0, 42)}…）`);
ok(calls5 === "[]", `⑭b 永不发起拉取（devAdminUrl null 连请求都不发——__devAdminCalls=${calls5}）`);
await png("4-no-token-honest");

ok(errs.length === 0, `⑬ console 零异常（${errs.length} 条${errs.length ? "：" + errs.slice(0, 2).join(" | ") : ""}）`);
console.log(`\nconnv4c2 probe：${pass} ok / ${fail} FAIL`);
try { globalThis.__p.kill(); } catch {}
process.exit(fail ? 1 : 0);
