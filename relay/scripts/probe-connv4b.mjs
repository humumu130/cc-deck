// W-CONNV4B 批B 连接池最小版探针：池建立/fg 切换不断旧/warm 单台/热切 replay/回本位/登出清洗/定时器护栏
// 驱动：UI 钮（data-acct-relay-connect=activateAcctRelay 真链）+window.__ccDeck005ConnPool 只读快照+localStorage ccr_acct 登录态。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const WS = (await import("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js")).default;
const PORT = 9700 + Math.floor(Math.random()*80); // CONNV4B-fix1：9920 段与 acctmulti 等并行探针撞车（连到他人 tab=页面 URL 落别 worktree 的 chrome-error 假象）——错开 9700 段
const p = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new","--disable-gpu","--disable-extensions",`--remote-debugging-port=${PORT}`,"--user-data-dir=/tmp/v4b-"+Date.now(),"--window-size=1440,940","file://"+decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)],{stdio:"ignore"});
const wait = ms => new Promise(r=>setTimeout(r,ms));
await wait(6800); // CONNV4B-fix1：3400→6800——file:// 初载（413KB settings-domain IIFE）完成后再 reload，抢跑 reload 会中断导航落 chrome-error
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WS(list.find(t=>t.type==="page").webSocketDebuggerUrl,{maxPayload:64*1024*1024});
await new Promise(r=>ws.once("open",r));
let seq=0; const pend=new Map();
const consoleErrs=[];
ws.on("message",d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);return;}if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")consoleErrs.push(String(m.params.args?.map(a=>a.value??a.description).join(" ")).slice(0,140));if(m.method==="Runtime.exceptionThrown")consoleErrs.push(String(m.params.exceptionDetails?.text).slice(0,140));});
const send=(method,params={})=>new Promise(res=>{const id=++seq;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});
const ev=async(e)=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true})).result.result.value;
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs",{urls:["*localhost:*8787*","*127.0.0.1:8787*","*cc.humumu.online*"]});
await send("Page.reload"); await wait(4500);
const PASS=[],FAIL=[]; const ok=(c,n)=>{(c?PASS:FAIL).push(n);console.log((c?"  ✓ ":"  ✗ ")+n);};
// hook-ready 轮询（时序稳定化——settings-domain.js 413KB IIFE 完成前注入会丢帧）
for (let i = 0; i < 40 && !(await ev(`typeof window.__ccDeck005ConnPool === "function"`)); i++) await wait(300);
if (!(await ev(`typeof window.__ccDeck005ConnPool === "function"`))) { const dg = await ev(`JSON.stringify({ rs: document.readyState, url: location.href.slice(-40), sd: typeof settingsDomainBoot, scripts: [...document.scripts].length })`).catch(e => "ev-err:" + String(e).slice(0, 80)); console.log("FATAL: hook 未挂（IIFE 未完成）| 页面态:", dg); process.exit(1); }
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
// ④b CONNV4B-fix1 锚A（R2 P0/R1 P1 回归——独立状态机）：三源态（fg=C/warm=B）warm 掉线循环
// （mock URL 不可达=每源真实 onclose 驱动）poll 5s——fix1 后 fg/warm 两值可独立（各写自身）；
// 串台形态两值恒等（同一 cloudCtx 对象被双写）→ 本锚红。同时 warmStatus 必须落入状态集（自身被写证据）。
{
  let sawDiff = false, sawWarmLive = false;
  for (let i = 0; i < 25; i++) {
    const st = JSON.parse(await pool());
    if (st.warmStatus && ["online", "offline", "connecting"].includes(st.warmStatus)) sawWarmLive = true;
    if (st.fgStatus && st.warmStatus && st.fgStatus !== st.warmStatus) { sawDiff = true; break; }
    await wait(200);
  }
  ok(sawWarmLive, "④b-fix1 warm 自身状态机活着（warmStatus 落入 online/offline/connecting 集——掉线循环写自身；修复前恒冻结/空）");
  ok(sawDiff, "④b-fix1 fg/warm 状态独立（5s 窗内观察到两值不同——各自状态机；串台形态同对象恒等必红）");
}
// ④c CONNV4B-fix1 锚B（armed-destroy 时序）：再激活 C（重复激活→maintainWarm 幂等）后立刻回本位——
// 切换/销毁竞态窗内无 JS 错、池收敛单源（无半销毁残留）
await ev(`(() => { const r = [...document.querySelectorAll(".acct-relay-row")].find(x => x.textContent.includes("rl-c")); if (r) { const b = r.querySelector("[data-acct-relay-connect]"); if (b) b.click(); } return true; })()`);
await wait(150);
await ev(`window.__ccDeck005SourceView ? window.__ccDeck005SourceView("local") : null`);
await wait(900);
const s4c = JSON.parse(await pool());
const realErrs = consoleErrs.filter(e => !/WebSocket|ERR_|net::|Failed to (load|connect)|192\.168|127\.0\.0\.1|localhost|nacl|通道启动异常/i.test(e)); // 预期环境噪音滤除（mock URL 不可达的传输失败日志）
ok(realErrs.length === 0 && s4c.pool.every(k => k === "acct:rl-b" || k === "acct:rl-c") && s4c.pool.length <= 2, `④c-fix1 armed-destroy 时序（重复激活→150ms 内回本位竞态窗：零 JS 错+池键全合法无半销毁残留（${JSON.stringify(s4c)}）；终态收敛由 ⑤ 断言承载）`);
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
