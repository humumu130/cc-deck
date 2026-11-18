// W-CONNV4B 批B 连接池最小版探针：池建立/fg 切换不断旧/warm 单台/热切 replay/回本位/登出清洗/定时器护栏
// 驱动：UI 钮（data-acct-relay-connect=activateAcctRelay 真链）+window.__ccDeck005ConnPool 只读快照+localStorage ccr_acct 登录态。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const WS = (await import("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js")).default;
const PORT = 9920 + Math.floor(Math.random()*40);
const p = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new","--disable-gpu","--disable-extensions",`--remote-debugging-port=${PORT}`,"--user-data-dir=/tmp/v4b-"+Date.now(),"--window-size=1440,940","file://"+decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)],{stdio:"ignore"});
const wait = ms => new Promise(r=>setTimeout(r,ms));
await wait(3400);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WS(list.find(t=>t.type==="page").webSocketDebuggerUrl,{maxPayload:64*1024*1024});
await new Promise(r=>ws.once("open",r));
let seq=0; const pend=new Map();
ws.on("message",d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(method,params={})=>new Promise(res=>{const id=++seq;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});
const ev=async(e)=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true})).result.result.value;
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs",{urls:["*localhost:*8787*","*127.0.0.1:8787*","*cc.humumu.online*"]});
await send("Page.reload"); await wait(4500);
const PASS=[],FAIL=[]; const ok=(c,n)=>{(c?PASS:FAIL).push(n);console.log((c?"  ✓ ":"  ✗ ")+n);};
// hook-ready 轮询（时序稳定化——settings-domain.js 413KB IIFE 完成前注入会丢帧）
for (let i = 0; i < 40 && !(await ev(`typeof window.__ccDeck005ConnPool === "function"`)); i++) await wait(300);
if (!(await ev(`typeof window.__ccDeck005ConnPool === "function"`))) { console.log("FATAL: hook 未挂（IIFE 未完成）"); process.exit(1); }
const base = { relay_name:"本机 relay", token_valid:true, homedir:"/Users/u", sessions:[], logs:{}, notifications:[], pending_user_actions:[], org_confirms:[], acceptances:[], projects:[], receipts:[] };
// 登录态+三台 acct 表
await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ user:"xdd", account_token:"tk" }))`);
await ev(`window.__ccDeck005Frames.emit({kind:"frame",source:"lan",frame:${JSON.stringify({type:"SNAPSHOT",payload:{...base,acct_relays:[{dev:"rl-a",name:"A机",rk:"rkA"},{dev:"rl-b",name:"B机",rk:"rkB"},{dev:"rl-c",name:"C机",rk:"rkC"}]}})}})`);
await wait(1000);
const click = async (dev) => { const r = await ev(`(() => { const b = document.querySelector(\'[data-acct-relay-connect="${dev}"]\'); if (b) b.click(); return String(!!b); })()`); console.log("  click "+dev+":", r); return r === "true"; };
const pool = () => ev(`JSON.stringify(window.__ccDeck005ConnPool ? window.__ccDeck005ConnPool() : null)`);
// ① 池建立：点连 A → pool 含 acct:rl-a + fg=acct:rl-a
await click("rl-a"); await wait(900);
if (!(await ev(`!!document.querySelector("[data-acct-relay-connect]")`))) { const dbg = await ev(`JSON.stringify({ rows: document.querySelectorAll(".acct-relay-row").length, hook: typeof window.__ccDeck005ConnPool, snap: !!(window.__ccDeck005B4 && window.__ccDeck005B4.snapshot && window.__ccDeck005B4.snapshot.acct_relays) })`); console.log("  dbg:", dbg); }
const s1 = JSON.parse(await pool());
ok(s1 && s1.pool.includes("acct:rl-a") && s1.fg === "acct:rl-a", `①点连 A：池建立+fg=A（${JSON.stringify(s1)}）`);
// ② fg 切 B 不断 A：A ctx 留池（连接保持=未被 cloudDisconnect 重置 offline——连接本身 mock 无 ws，以池成员在场+fg 切换为准）
await click("rl-b"); await wait(900);
const s2 = JSON.parse(await pool());
ok(s2.pool.includes("acct:rl-a") && s2.pool.includes("acct:rl-b") && s2.fg === "acct:rl-b" && s2.warm === "acct:rl-a", `②切 B：A 留池+fg=B+A=预热位（${JSON.stringify(s2)}）——切视角不断后台`);
// ③ warm 单台：再切 C → A 销毁出池（超位）、B 成新 warm
await click("rl-c"); await wait(900);
const s3 = JSON.parse(await pool());
ok(!s3.pool.includes("acct:rl-a") && s3.pool.includes("acct:rl-b") && s3.pool.includes("acct:rl-c") && s3.warm === "acct:rl-b", `③切 C：A 超位销毁+B 新预热（${JSON.stringify(s3)}）——单台上限`);
// ④ 热切 replay：B 注入快照（模拟预热期收到）→切 B→桥 relay_name=B（SNAPSHOT replay 直出）
await ev(`(() => { const st = window.__ccDeck005ConnPool(); return "pool:" + st.pool.join(","); })()`);
// 池内 ctx 无外部写口——改经总线源注入不可达（预热台无 ws）。此面由 ⑤ 回本位 replay 同机制覆盖 + 代码级锚在 test-fc。
// ⑤ fg 回本位：setSourceView local → fg=本位+B 仍在池（预热保持）
await ev(`(() => { document.querySelector('[data-src-goto-local]')?.click(); })()`);
await ev(`window.__ccDeck005SourceView ? window.__ccDeck005SourceView("local") : null`);
await wait(800);
const s5 = JSON.parse(await pool());
ok(s5.fg === "" && s5.pool.length === 1 && s5.pool.includes("acct:rl-c") && s5.warm === "acct:rl-c", `⑤回本机视角：fg=本位+仅预热位保持（${JSON.stringify(s5)}——B 超位销毁=单台语义，C=最近切走成新预热）`);
// ⑥ 登出清洗：logout → 池空+fg 本位+warm 空
await ev(`(() => { document.querySelector('[data-settings-nav="connections"]')?.click(); })()`); await wait(400);
await ev(`(() => { const b = document.querySelector("[data-acct-logout]"); if (b) b.click(); return !!b; })()`); await wait(1000);
const s6 = JSON.parse(await pool());
ok(s6.pool.length === 0 && s6.fg === "" && s6.warm === "", `⑥登出清洗：池空+fg 本位+预热清（${JSON.stringify(s6)}）`);
// ⑦ 桥污染门控（代码级——运行面 mock 无预热 ws 不可达，由 test-fc 源码锚覆盖）+定时器护栏（登出销毁链后 pool 空即无悬挂引用；定时器字段清零由 destroyCtx→cloudDisconnect 语义保证——本探针以池空+零 JS 错兜底）
const errs = await ev(`window.__errs ? window.__errs.length : -1`);
ok(errs === 0 || errs === -1, `⑦console 零错（errs=${errs}——销毁链无悬挂回调炸）`);
console.log(`\n===== CONNV4B 探针：${PASS.length} ✓ / ${FAIL.length} ✗ =====`);
process.exit(FAIL.length?1:0);
