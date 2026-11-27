// offlineui（t-0b360983 刀1/刀2）行为探针——真连接链验证：
// 静态 http + mock relay 同端口 serve worktree web-console，页面走 bootstrap→probe→
// connectLan 全真链；kill=停 server+踢连接（模拟 relay 进程死），恢复=重新 listen。
// 验收映射：①10s 内会话卡失联横幅+降灰 ②发消息 10s watchdog→「⚠ 未送达：本机服务
// 未连接」+重发钮（60s 档内）③恢复→横幅消除+why-fail echo 自动补发 ④cloud 侧独立读数不误报。
// 跑法：node scripts/probe-offlineui.mjs（headless Chrome 随机端口）
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const here = dirname(fileURLToPath(import.meta.url));
const WEBROOT = join(here, "..", "..", "web-console");
const PORT = 9700 + Math.floor(Math.random() * 200);
const TOKEN = "probe-offlineui-token";
const SID = "sess-offlineui-a";

// ---------- mock relay：静态 http + /local-info + /ws ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
let killed = false;
const clients = new Set();
const received = []; // 恢复后收到的命令（自动补发验证锚）
const server = require("node:http").createServer((req, res) => {
  if (req.url.startsWith("/local-info")) {
    if (killed) { res.writeHead(502); res.end("killed"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, port: PORT, token: TOKEN, lan_ip: "127.0.0.1" }));
    return;
  }
  const p = req.url.split("?")[0] === "/" ? "/index-005.html" : req.url.split("?")[0];
  try {
    const body = readFileSync(join(WEBROOT, p));
    res.writeHead(200, { "content-type": MIME[p.slice(p.lastIndexOf("."))] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  if (!req.url.startsWith("/ws")) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => {
    if (killed) { try { ws.close(); } catch {} return; }
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (d) => {
      let m = null; try { m = JSON.parse(String(d)); } catch { return; }
      if (m.command_id && m.type) {
        if (killed) return;
        received.push({ type: m.type, text: m.payload && m.payload.text });
        try { ws.send(JSON.stringify({ type: "COMMAND_ACK", payload: { command_id: m.command_id, ok: true } })); } catch {}
      }
    });
    // SNAPSHOT：一枚 WORKING 会话（绿点降灰验证锚）
    ws.send(JSON.stringify({ type: "SNAPSHOT", payload: {
      relay_name: "probe-relay", token_valid: true, homedir: "/tmp", platform: "darwin",
      sessions: [
        { session_id: SID, title: "探针会话", status: "WORKING", engine: "", model: "x", updated_at: Date.now(), cwd: "/tmp/p" },
        { session_id: SID + "-b", title: "旁证会话（不选中）", status: "WORKING", engine: "", model: "x", updated_at: Date.now(), cwd: "/tmp/p" },
      ],
      logs: {},
    } }));
  });
});
const killRelay = () => { killed = true; for (const c of clients) { try { c.terminate(); } catch {} } clients.clear(); server.close(); };
const reviveRelay = () => new Promise((r) => { killed = false; received.length = 0; server.listen(PORT, "127.0.0.1", r); });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------- headless Chrome + CDP ----------
globalThis.__p = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=/tmp/oui-cdp-${Date.now()}`, "--window-size=1440,940", `http://127.0.0.1:${PORT}/index-005.html`], { stdio: ["ignore", "pipe", "pipe"] });
let cdpPort = "";
for (let i = 0; i < 60 && !cdpPort; i++) {
  const err = globalThis.__p.stderr.read();
  if (err) { const m = String(err).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) cdpPort = m[1]; }
  await new Promise(r => setTimeout(r, 200));
}
if (!cdpPort) { console.log("FAIL chrome CDP 未起"); process.exit(1); }
const list0 = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const tab = list0.find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.once("open", r));
let seq = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
await send("Page.enable"); await send("Runtime.enable");
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok " + n); } else { fail++; console.log("  FAIL " + n); } };

// ---------- ① 连接建立：health 在线、无横幅、会话卡在 ----------
await wait(3500);
const h1 = await ev("window.__ccDeck005SourceHealth ? JSON.stringify(window.__ccDeck005SourceHealth()) : 'NO-HOOK'");
ok(typeof h1 === "string" && h1.includes('"online":true'), `①a 观测口在场且本机源在线（${h1.slice(0, 80)}）`);
ok(h1.includes('"cloud":null'), "①b cloud 侧独立读数：未启用云时 null（不误报不混源）");
const card1 = await ev(`!!document.querySelector('[data-session-card="${SID}"]')`);
const bn1 = await ev(`!!document.querySelector('.src-stale-banner')`);
ok(card1 && !bn1, "①c 会话卡渲染+无失联横幅（在线不说谎的反向锚）");
await ev(`document.querySelector('[data-session-card="${SID}"]')?.click()`); // 选中会话：echo 渲染有 sidIsSelected 门，不选中不进 #session-body
await wait(600);

// ---------- ② kill relay：≤11s 横幅+data-src-stale+降灰 ----------
const tKill = Date.now();
killRelay();
await wait(11000);
const bn2 = await ev(`document.querySelector('.src-stale-banner') ? document.querySelector('.src-stale-banner').textContent : ''`);
ok(bn2.includes("本机服务未连接") && bn2.includes("列表为缓存数据"), `②a kill 后 11s 内失联横幅（实测 ${JSON.stringify(bn2)}）【验收1前半】`);
const stale2 = await ev(`document.querySelector('[data-session-list]').getAttribute('data-src-stale')`);
ok(stale2 === "lan", `②b data-src-stale=lan（CSS 降灰挂点，实测 ${stale2}）`);
const dot2 = await ev(`getComputedStyle(document.querySelector('.queue-card:not(.selected) .status-dot')).filter`);
ok(String(dot2).includes("grayscale"), `②c 状态灯降灰（未选中卡 computed filter=${dot2}；选中卡豁免=设计）`);
const selDot2 = await ev(`getComputedStyle(document.querySelector('.queue-card.selected .status-dot')).filter`);
ok(!String(selDot2).includes("grayscale"), `②c2 选中卡豁免不降灰（computed filter=${selDot2}——用户正盯的卡保持全权）`);
const card2 = await ev(`!!document.querySelector('[data-session-card="${SID}"]')`);
ok(card2, "②d 缓存卡保留（陈旧明示而非清场）");

// ---------- ③ 发送终态：10s watchdog → fail+源因+重发钮 ----------
const sent3 = await ev(`window.__ccDeck005B2 && window.__ccDeck005B2.sendPrompt ? JSON.stringify(window.__ccDeck005B2.sendPrompt("${SID}", "探针-未送达验证-①")) : 'NO-B2'`);
ok(typeof sent3 === "string" && sent3.includes('"sent":true'), `③a halfconn 受理（sendPrompt 返回 ${sent3}——toast 分流见 OU6 源码锚）`);
await wait(11000); // 10s watchdog + 渲染余量
const echo3 = await ev(`[...document.querySelectorAll('.msg-echo .echo-state')].map(x => x.textContent).join(' | ')`);
ok(echo3.includes("未送达：本机服务未连接"), `③b echo 终态带源因（实测 ${JSON.stringify(echo3)}）【验收1后半：60s 档内非永挂】`);
const retry3 = await ev(`!!document.querySelector('.msg-echo .echo-retry')`);
ok(retry3, "③c 重发钮在场（fail 态动作钮）");

// ---------- ④ 恢复：重连→横幅消除+自动补发 ----------
await reviveRelay();
await wait(22000); // 重连退避（1s 起抖动指数）+ SNAPSHOT + 秒拍
const bn4 = await ev(`!!document.querySelector('.src-stale-banner')`);
const stale4 = await ev(`document.querySelector('[data-session-list]').getAttribute('data-src-stale')`);
ok(!bn4 && !stale4, `④a 恢复后横幅/降灰摘除（banner=${bn4} stale=${stale4}）【验收2前半】`);
const h4 = await ev(`JSON.stringify(window.__ccDeck005SourceHealth())`);
ok(h4.includes('"online":true'), `④b health 回在线（${h4.slice(0, 60)}）`);
ok(received.some(r => r.type === "COMMAND_MESSAGE" && String(r.text).includes("未送达验证")), `④c why-fail echo 自动补发真到达（mock 收到 ${JSON.stringify(received)}）【验收2后半】`);
const echo4 = await ev(`[...document.querySelectorAll('.msg-echo .echo-state')].map(x => x.textContent).join(' | ')`);
ok(!echo4.includes("未送达"), `④d 补发后 fail 回显出清（实测 ${JSON.stringify(echo4)}）`);
console.log(`\nOFFLINEUI probe: ${pass} passed, ${fail} failed（kill→横幅耗时窗 11s/恢复窗 22s，阈值断言见源码锚 SRC_STALE_MS=10000）`);
try { ws.close(); } catch {}
try { globalThis.__p.kill(); } catch {}
try { server.close(); } catch {}
process.on("exit", () => { try { globalThis.__p.kill(); } catch {} });
process.exit(fail > 0 ? 1 : 0);
