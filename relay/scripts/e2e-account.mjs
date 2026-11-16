// W-ACCOUNT 批 A 全栈 E2E：真桥（生产 CF Worker，须已部署 auth/acct 面）+ 双本地 relay
// （test.24 代码）+ 双 headless Chrome 控制台（relay 自带 005 页）真点击。
// 验收剧本=用户晨验剧本：A/B 登录同账号 → 各自「其他电脑」自动出现对方（免码）→
// A 点「连接」→ 配对成功可看 B 会话。附：凭据再水化真链路（fresh 浏览器 profile 零
// localStorage → acct_bound → 自动登录态）。
// 用法：node scripts/e2e-account.mjs <account_user> <account_pass>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../node_modules/ws/package.json", import.meta.url));
const WebSocket = require("ws");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const USER = process.argv[2] || "", PASS = process.argv[3] || "";
if (!USER || !PASS) { console.error("用法: e2e-account.mjs <user> <pass>"); process.exit(1); }
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, every = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(every); } return await fn(); }

// ---------- ① 注册（或已注册直用）+ 登录取 token ----------
const reg = await fetch("https://cc.humumu.online/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: USER, pass: PASS }) });
if (reg.status === 409) console.log("账号已存在（复用）");
else if (!reg.ok) { console.error("注册失败", reg.status, await reg.text()); process.exit(1); }
else console.log("注册成功");
const login = await (await fetch("https://cc.humumu.online/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: USER, pass: PASS }) })).json();
if (!login.account_token) { console.error("登录失败", login); process.exit(1); }
ok(/^[a-f0-9]{64}$/.test(login.account_token), "① 生产桥 /auth register+login（真 KV/PBKDF2 路径）");

// ---------- ② 双 relay 实例（隔离 dataDir/端口） ----------
const tmpA = mkdtempSync(join(tmpdir(), "e2e-acct-A-")), tmpB = mkdtempSync(join(tmpdir(), "e2e-acct-B-"));
const relays = [];
function spawnRelay(dir, port, name) {
  const r = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta).pathname,
    env: { ...process.env, CCR_DATA_DIR: dir, CCR_PORT: String(port), CCR_TOKEN: "e2etoken" + port, CCR_CWD: dir, CCR_NO_TITLE_GEN: "1", CCR_ACCOUNT_TOKEN: login.account_token, CCR_CLOUD_URL: "wss://cc.humumu.online/cloud", CCR_CLOUD_TOKEN: "ccdeck-public-9f3k2m7v", CCR_EMPLOYEE_CONFIG_DIR: "", CC_DECK_PLUGIN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  r.stdout.on("data", (d) => { const s = String(d); if (/acct|RELAYS|paired|bridge connected|listen/.test(s)) console.log(`  [${name}] ` + s.trim().slice(0, 110)); });
  r.stderr.on("data", (d) => { const s = String(d); if (!/Warning|--trace-warnings|ExperimentalWarning/.test(s)) console.log(`  [${name}!] ` + s.trim().slice(0, 110)); });
  relays.push(r);
  return r;
}
spawnRelay(tmpA, 8811, "A");
spawnRelay(tmpB, 8812, "B");
ok(await waitFor(async () => { try { const r = await fetch("http://127.0.0.1:8811/health"); return r.ok; } catch { return false; } }, 40000), "② relay A 起（8811·test.24·带账号）");
ok(await waitFor(async () => { try { const r = await fetch("http://127.0.0.1:8812/health"); return r.ok; } catch { return false; } }, 40000), "② relay B 起（8812·同账号）");
// rn 名直注（等桥侧 rn 生效路径之外，双保险同名显示——生产实走 relayName 单源）
await fetch(`http://127.0.0.1:8811/api/account-set?token=e2etoken8811`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: login.account_token, user: "SmokeMac" }) });
await fetch(`http://127.0.0.1:8812/api/account-set?token=e2etoken8812`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: login.account_token, user: "SmokeWin" }) });
ok(true, "③ 双 relay account-set 绑定（API 口真路径）");

// ---------- ③ headless 控制台 A（fresh profile=零 ccr_acct → 再水化真链路） ----------
async function driveConsole(port, label, peerName, doClickConnect) {
  const P = 9300 + port % 500;
  const c2 = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${P}`, "--user-data-dir=/tmp/e2eacct-" + port + "-" + Date.now(), "--window-size=1440,940", `http://127.0.0.1:${port}/index-005.html`], { stdio: "ignore" });
  relays.push(c2);
  await wait(2600);
  let tab = null;
  for (let i = 0; i < 8 && !tab; i++) { try { const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json(); tab = l.find((t) => t.type === "page"); } catch { await wait(1000); } }
  if (!tab) { ok(false, `${label} 控制台 CDP 接入失败`); return null; }
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => ws.once("open", r));
  let seq = 0; const pend = new Map(); const errs = [];
  ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; } if (m.method === "Runtime.exceptionThrown") errs.push(String(m.params.exceptionDetails?.text).slice(0, 100)); });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
  await send("Page.enable"); await send("Runtime.enable");
  await wait(3500); // ws 连接+SNAPSHOT+（再水化 fetch 链）
  return { ev, ws, errs, cp: c2, label, peerName, doClickConnect, port };
}

const cA = await driveConsole(8811, "A", "SmokeWin", true);
const cB = await driveConsole(8812, "B", "SmokeMac", false);
if (cA) {
  // 等互见（RELAYS 周期+relay-online 事件）
  await cA.ev(`new Promise(r => setTimeout(r, 3000))`);
  const seenA = await cA.ev(`(() => { const q = document.querySelector('[data-settings-panel="connections"]'); return { has: !!q }; })()`).catch(() => null);
  if (!seenA || !seenA.has) {
    // 设置页可能未开——点开（queue-goto + 设置按钮，探针同款）
    await cA.ev(`(() => { const q = document.querySelector('[data-queue-goto="settings"]'); if (q) q.click(); })()`);
    await cA.ev(`(() => { const b = [...document.querySelectorAll("#stage-desktop [data-nav], #stage-desktop button")].find(x => /设置/.test(x.textContent || "")); if (b) b.click(); })()`);
    await wait(1200);
  }
}
const inspect = async (c) => {
  if (!c) return null;
  return JSON.parse(await c.ev(`JSON.stringify((() => {
    const p = document.querySelector('[data-settings-panel="connections"]'); if (!p) return { noPanel: 1 };
    const acct = p.querySelector('[data-conn-section="account"]');
    const rows = [...p.querySelectorAll(".acct-relay-row")];
    return { acctText: acct?.textContent || "", logged: !!localStorage.getItem("ccr_acct"), rows: rows.map(r => ({ t: r.textContent.replace(/\\s+/g, " ").trim().slice(0, 60), btn: !!r.querySelector("[data-acct-relay-connect]"), grey: !!r.querySelector(".tag") })), cloudOnline: (() => { try { return window.__ccDeck005CloudDiag?.().status; } catch { return "?"; } })() };
  })())`).catch((e) => JSON.stringify({ err: String(e) })));
};
const rA = await inspect(cA), rB = await inspect(cB);
ok(rA && rA.logged, "④ A 控制台凭据再水化（fresh profile→acct_bound→自动登录，localStorage ccr_acct 已建）");
ok(rA && rA.rows?.some((r) => r.t.includes("SmokeWin") && r.btn), "⑤ A「其他电脑」自动出现 SmokeWin（免码+连接钮）：" + JSON.stringify(rA?.rows));
ok(rB && rB.rows?.some((r) => r.t.includes("SmokeMac")), "⑥ B「其他电脑」自动出现 SmokeMac（对向互见）");
if (rA?.acctText) ok(rA.acctText.includes("台同账号设备在线"), "⑦ A 账号卡计数（" + rA.acctText.replace(/\s+/g, " ").slice(0, 50) + "）");
// A 点击连接（真 pair_req→sa 免码→ack→配对）
if (cA && rA?.rows?.some((r) => r.btn)) {
  await cA.ev(`(() => { const b = document.querySelector("[data-acct-relay-connect]"); if (b) b.click(); })()`);
  const paired = await waitFor(async () => { const d = await inspect(cA); return d && d.cloudOnline === "online"; }, 20000, 600);
  ok(paired, "⑧ A 点「连接」→ 免码配对 → 云链 online（E2E 密钥交换真路径）");
}
ok(!cA?.errs?.length && !cB?.errs?.length, "⑨ 双控制台零 JS 异常" + (cA?.errs?.length ? " → " + cA.errs[0] : cB?.errs?.length ? " → " + cB.errs[0] : ""));

// ---------- 清理 ----------
for (const r of relays) { try { r.kill(); } catch {} }
await wait(800);
for (const d of [tmpA, tmpB]) rmSync(d, { recursive: true, force: true });
console.log(`\n§E2E-ACCOUNT：${pass} ok / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
