// W-ACCOUNT 件三探针：账号卡（登录/注册弹窗+已登录态+acct 行+离线置灰+登出清理+空态双态）。
// 骨架复用 probe-connv3（headless Chrome + file:// index-005 + 夹具 SNAPSHOT；cc.humumu.online 出网口不挡——
// 但本探针不发真登录请求：凭据走 localStorage 直注 + 弹窗只验开合/校验，不点真提交）。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9660 + Math.floor(Math.random() * 200);
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/acct-" + Date.now(), "--window-size=1440,940", "file://" + decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)], { stdio: "ignore" });
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
await send("Network.setBlockedURLs", { urls: ["*localhost:*", "*127.0.0.1:*", "*tauri.localhost*", "*cc.humumu.online*"] });
await send("Page.reload"); await wait(3200);
const snap = { type: "SNAPSHOT", payload: { relay_name: "本机 relay", token_valid: true, homedir: "/Users/u", sessions: [], logs: {}, notifications: [], pending_user_actions: [], org_confirms: [], acceptances: [], projects: [], receipts: [] } };
await ev(`window.__ccDeck005RouteWs = null; window.__ccDeck005MainWs = { readyState: 1, send: () => {} };`);
await ev(`window.__ccDeck005Frames.emit({ kind: "ws", state: "open" })`);
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap)} })`);
await wait(600);
await ev(`localStorage.removeItem("ccr_acct")`);
await ev(`(() => { const q = document.querySelector('[data-queue-goto="settings"]'); if (q) q.click(); })()`);
await ev(`(() => { const b = [...document.querySelectorAll("#stage-desktop [data-nav], #stage-desktop button")].find(x => /设置/.test(x.textContent || "")); if (b) b.click(); })()`);
await wait(800);
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

// ① 未登录态：账号卡升顶 + 登录/注册双口 + 空态单路径（一切如旧）
const g1 = JSON.parse(await ev(`JSON.stringify((() => { const p = document.querySelector('[data-settings-panel="connections"]'); const a = p?.querySelector('[data-conn-section="account"]'); const first = p ? [...p.querySelectorAll(".v8-setcard")].find(c => c.dataset.connSection) : null; return { has: !!a, hidden: a?.hidden, top: first?.dataset.connSection || "", text: a?.textContent || "", loginBtn: !!a?.querySelector("[data-acct-login]"), regBtn: !!a?.querySelector("[data-acct-register]"), acctRows: p?.querySelectorAll(".acct-relay-row").length || 0, empty: p?.querySelector('[data-settings-live="remote-sources"]')?.textContent || "" }; })())`));
ok(g1.has && g1.hidden === false, "①a 账号卡存在且可见（升顶）");
ok(g1.top === "account", "①b 账号卡=连接页首卡（发现层插顶叙事）");
ok(g1.loginBtn && g1.regBtn, "①c 登录+注册双口在场");
ok(g1.text.includes("同一账号的电脑自动互联") && g1.text.includes("不用配对码"), "①d 未登录主行文案（" + g1.text.replace(/\s+/g, " ").slice(0, 60) + "…）");
ok(g1.acctRows === 0 && g1.empty.includes("还没有其他电脑"), "①e 未登录 acct 行零渲染 + 空态单路径（如旧）");

// ② 登录/注册弹窗（开合+字段+前置校验——不点真提交，出网已断）
await ev(`document.querySelector("[data-acct-login]").click()`);
await wait(300);
const g2 = JSON.parse(await ev(`JSON.stringify((() => { const pop = document.querySelector("[data-acct-pop]"); return { open: !!pop, title: pop?.querySelector("h3")?.textContent || "", user: !!pop?.querySelector("[data-acct-user]"), pass: !!pop?.querySelector("[data-acct-pass]"), submit: !!pop?.querySelector("[data-acct-submit]"), cancel: !!pop?.querySelector("[data-acct-close]") }; })())`));
ok(g2.open && g2.title === "登录" && g2.user && g2.pass && g2.submit, "②a 登录弹窗开（create-pop 形态两字段+提交）");
// ②a-2 注册弹窗三件修（视觉审查修批锚：确认密码/可见切换眼睛/按钮右簇）
await ev(`document.querySelector("[data-acct-close]")?.click(); document.querySelector("[data-acct-register]")?.click()`);
await wait(300);
const g2r = JSON.parse(await ev(`JSON.stringify((() => { const p = document.querySelector("[data-acct-pop]"); return { open: !!p, title: p?.querySelector("h3")?.textContent || "", pass2: !!p?.querySelector("[data-acct-pass2]"), eyes: p?.querySelectorAll("[data-acct-eye]").length || 0, cluster: !!p?.querySelector('span[style*="display:flex"]'), errNote: !!p?.querySelector(".create-err-note") }; })())`));
ok(g2r.open && g2r.title === "创建账号" && g2r.pass2, "②a-2 注册弹窗带确认密码字段（uxcopy P1-2 修锚）");
ok(g2r.eyes >= 2 && g2r.cluster && g2r.errNote, "②a-3 密码眼睛×2+按钮右簇+红警示 errNote（审美 P1-1/P2 修锚 eyes=" + g2r.eyes + "）");
await ev(`document.querySelector("[data-acct-close]")?.click(); document.querySelector("[data-acct-pop]")?.remove(); document.querySelector(".pair-pop-backdrop")?.remove()`);
await ev(`document.querySelector("[data-acct-login]")?.click()`); await wait(250); // 复开登录弹窗——后续 ②b 在登录态校验（原流程保持）
await ev(`pop = document.querySelector("[data-acct-pop]"); pop.querySelector("[data-acct-user]").value = "ab"; pop.querySelector("[data-acct-pass]").value = "12345678"; pop.querySelector("[data-acct-submit]").click()`);
await wait(400);
const g2b = await ev(`document.querySelector("[data-acct-err]")?.textContent || ""`);
ok(g2b.includes("用户名需"), "②b 前置校验（短用户名拒绝+红警示：" + g2b + "）");
await ev(`document.querySelector("[data-acct-close]")?.click(); document.querySelector("[data-acct-back]")?.click(); document.querySelector("[data-acct-pop]")?.remove(); document.querySelector("[data-acct-backdrop], .pair-pop-backdrop")?.remove()`);
await wait(200);
ok(!(await ev(`!!document.querySelector("[data-acct-pop]")`)), "②c 弹窗关净");

// ③ 已登录态（凭据直注+acct_relays 夹具）：用户名+计数+acct 行+离线置灰
await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ user: "nightowl", account_token: "tok-test" }))`);
const snap2 = { type: "SNAPSHOT", payload: Object.assign({}, snap.payload, { acct_relays: [ { dev: "rl-aaa111", name: "HomeWin", rk: "rkA", online: true }, { dev: "rl-bbb222", name: "OfficeMac", rk: "rkB", online: false } ] }) };
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap2)} })`);
await wait(700);
const g3 = JSON.parse(await ev(`JSON.stringify((() => { const p = document.querySelector('[data-settings-panel="connections"]'); const a = p?.querySelector('[data-conn-section="account"]'); const rows = [...(p?.querySelectorAll(".acct-relay-row") || [])]; return { text: a?.textContent || "", logout: !!a?.querySelector("[data-acct-logout]"), n: rows.length, first: rows[0]?.textContent || "", firstBtn: rows[0]?.querySelector("[data-acct-relay-connect]")?.getAttribute("data-acct-relay-connect") || "", firstInCard: !!(rows[0] && p.querySelector('[data-settings-live="remote-sources"]')?.contains(rows[0])), second: rows[1]?.textContent || "", secondBtn: !!rows[1]?.querySelector("[data-acct-relay-connect]"), secondGrey: rows[1]?.querySelector(".tag")?.textContent || "" }; })())`));
ok(g3.text.includes("nightowl") && g3.text.includes("另有 1 台同账号设备在线") && g3.logout, "③a 已登录态（用户名+另有 1 台在线=计数过滤离线行（一致性 P2-4）+退出登录）");
ok(g3.n === 2, "③b acct 行 2 条（SNAPSHOT acct_relays 驱动）");
ok(g3.firstInCard && g3.first.includes("HomeWin") && g3.firstBtn === "rl-aaa111", "③c 在线行渲染进「其他电脑」卡+点连钮锚 dev");
ok(g3.second.includes("OfficeMac") && !g3.secondBtn && g3.secondGrey.includes("离线"), "③d 离线行置灰无钮（tag=" + g3.secondGrey + "）");

// ④ 空态双态（登录+acct_relays 空→引导文案）
const snap3 = { type: "SNAPSHOT", payload: Object.assign({}, snap.payload, { acct_relays: [] }) };
await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap3)} })`);
await wait(700);
const g4 = JSON.parse(await ev(`JSON.stringify((() => { const p = document.querySelector('[data-settings-panel="connections"]'); return { text: p?.querySelector('[data-conn-section="account"]')?.textContent || "", rows: p?.querySelectorAll(".acct-relay-row").length || 0 }; })())`));
ok(g4.rows === 0 && g4.text.includes("对方电脑上线后会自动出现在"), "④ 登录+空→翻面引导文案");

// ⑧ 再水化（acct_bound 夹具 + stub GET 双分支）
{
  await ev(`localStorage.removeItem("ccr_acct"); window.__acctFetchLog = []; window.fetch = (u, o) => { window.__acctFetchLog.push(String(u)); return Promise.resolve(new Response(JSON.stringify({ ok: true, bound: true, token: "b".repeat(64), user: "rehydrated" }), { status: 200 })); };`);
  const snap4 = { type: "SNAPSHOT", payload: Object.assign({}, snap.payload, { acct_bound: true, acct_relays: [] }) };
  await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap4)} })`);
  await wait(700);
  const g8 = JSON.parse(await ev(`JSON.stringify({ calls: window.__acctFetchLog || [], cred: (() => { try { return JSON.parse(localStorage.getItem("ccr_acct") || "null"); } catch { return null; } })() })`));
  ok(g8.calls.some((u) => u.includes("/api/account-set")), "⑧a acct_bound∧无凭据→GET 拉取（" + (g8.calls[0] || "未发出").slice(0, 52) + "）");
  ok(g8.cred && g8.cred.account_token === "b".repeat(64) && g8.cred.user === "rehydrated", "⑧b ccr_acct 再水化重建（64hex+user）");
  await ev(`window.fetch = window.__origFetch;`);
}
// ⑤ 登出清理（点击→ccr_acct 清+回登录态+acct 行消失；/api 出网已断=解绑 toast 降级路径同测）
await ev(`document.querySelector("[data-acct-logout]").click()`);
await wait(900);
const g5 = JSON.parse(await ev(`JSON.stringify((() => { const p = document.querySelector('[data-settings-panel="connections"]'); const a = p?.querySelector('[data-conn-section="account"]'); return { ls: localStorage.getItem("ccr_acct"), login: !!a?.querySelector("[data-acct-login]"), rows: p?.querySelectorAll(".acct-relay-row").length || 0 }; })())`));
ok(g5.ls === null, "⑤a 登出→ccr_acct 清空");
// ⑧c 登出烧 flag：acct_bound 快照再来不再拉取复活（审查修 ux P2-6 的探针面）
{
  await ev(`window.__acctFetchLog = []; window.fetch = (u, o) => { window.__acctFetchLog.push(String(u)); return Promise.resolve(new Response(JSON.stringify({ ok: true, bound: true, token: "d".repeat(64), user: "ghost" }), { status: 200 })); };`);
  const snapX = { type: "SNAPSHOT", payload: Object.assign({}, snap.payload, { acct_bound: true, acct_relays: [] }) };
  await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snapX)} })`);
  await wait(600);
  const n = await ev(`(window.__acctFetchLog || []).length`);
  ok(n === 0 && (await ev(`localStorage.getItem("ccr_acct")`)) === null, "⑧c 登出后再水化不复活（flag 烧断+" + n + " 次拉取）");
  await ev(`window.fetch = window.__origFetch;`);
}
ok(g5.login && g5.rows === 0, "⑤b 回登录态+acct 行消失（换号残留根除）");

// ⑥ 零异常
ok(errs.length === 0, "⑥ 零 JS 异常" + (errs.length ? " → " + errs[0] : ""));

// ⑦ 提交全流程（审查修补盲区：stub fetch 抓 URL/参数——原转义 P0 藏身处）
{
  await ev(`localStorage.removeItem("ccr_acct")`);
  await ev(`(() => { const q = document.querySelector('[data-queue-goto="settings"]'); if (q) q.click(); })()`);
  await wait(300);
  await ev(`window.__acctFetchLog = []; window.__origFetch = window.fetch; window.fetch = (u, o) => { window.__acctFetchLog.push({ u: String(u), m: (o && o.method) || "GET", body: o && o.body ? String(o.body) : "" }); return Promise.resolve(new Response(JSON.stringify({ account_token: "a".repeat(64) }), { status: 200 })); };`);
  await ev(`document.querySelector("[data-acct-login]").click()`);
  await wait(250);
  await ev(`(() => { const p = document.querySelector("[data-acct-pop]"); p.querySelector("[data-acct-user]").value = "nightowl"; p.querySelector("[data-acct-pass]").value = "testpass123"; p.querySelector("[data-acct-submit]").click(); })()`);
  await wait(700);
  const g7 = JSON.parse(await ev(`JSON.stringify({ log: window.__acctFetchLog || [], cred: (() => { try { return JSON.parse(localStorage.getItem("ccr_acct") || "null"); } catch { return null; } })() })`));
  const auth = g7.log.find((x) => x.u.includes("/auth/login"));
  const set = g7.log.find((x) => x.u.includes("/api/account-set"));
  ok(!!auth && auth.u.startsWith("https://cc.humumu.online/auth/login"), "⑦a 登录 POST 发出且 URL 无转义残渣（" + (auth ? auth.u.slice(0, 46) : "未发出") + "）");
  ok(!!set && /account-set\?token=/.test(set.u) && !set.u.includes("${"), "⑦b account-set 下发 URL 插值真实（" + (set ? set.u.slice(0, 52) : "未发出") + "）");
  ok(!!set && set.m === "POST" && set.body.includes("nightowl"), "⑦c 下发 body 带 user 名");
  ok(g7.cred && g7.cred.account_token === "a".repeat(64) && g7.cred.user === "nightowl", "⑦d ccr_acct 写入（token+user）");
  await ev(`window.fetch = window.__origFetch;`);
}
// ⑨ 点连前置（activateAcctRelay 前段：不写 ACTIVE/共享库、toast、无异常）
{
  await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ user: "nightowl", account_token: "c".repeat(64) }))`);
  const snap5 = { type: "SNAPSHOT", payload: Object.assign({}, snap.payload, { acct_relays: [ { dev: "rl-ccc333", name: "ClickPC", rk: "rkC", online: true } ] }) };
  await ev(`window.__ccDeck005Frames.emit({ kind: "frame", source: "lan", frame: ${JSON.stringify(snap5)} })`);
  await wait(600);
  await ev(`window.__activeBefore = localStorage.getItem("cc-deck-005-active-cloud")`);
  await ev(`document.querySelector("[data-acct-relay-connect]")?.click()`);
  await wait(400);
  const g9 = await ev(`localStorage.getItem("cc-deck-005-active-cloud") === window.__activeBefore`);
  ok(g9 === true, "⑨a 点连不写 ACTIVE_CLOUD_KEY（ephemeral 视角）");
  ok(errs.length === 0, "⑨b 点连零异常（ws 出网被断是预期失败路径，前置段无炸）" + (errs.length ? " → " + errs[0] : ""));
}
console.log(`\n§ACCOUNT：${pass} ok / ${fail} FAIL`);
ws.close(); globalThis.__p.kill(); process.exit(fail ? 1 : 0);
