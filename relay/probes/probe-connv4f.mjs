// W-CONNV4F 批F 源胶囊下拉多源化探针（1122 用户实锤：三台在线只显示 2 圆+聚合——第 3 台无处显示）。
// 四断言组：④单源简洁态（先跑——fresh 页零源）→①下拉行数=源数+五宿主同构→②点击切换（池化
// 不断后台+active 随视角）→③离线灰显（union 落 offline 仍可点）；附⑤trigger 文本回归+cloudRow 退役锚。
// 驱动：window.__ccDeck005Frames.emit 注入 lan SNAPSHOT（acct_relays union 合并——offline 由
// 第二帧丢弃法制造）+ DOM 断言（data-src-key 行锚）+window.__ccDeck005ConnPool 池快照。
import { spawn } from "node:child_process";
const WS = (await import("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js")).default;
const PORT = 9790 + Math.floor(Math.random() * 60); // 9790 段：与 connv4b(9700)/acctmulti(9930)/connv4a(9920)/connv4c2(9980) 错开防并行撞 tab
const p = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new","--disable-gpu","--disable-extensions",`--remote-debugging-port=${PORT}`,"--user-data-dir=/tmp/v4f-"+Date.now(),"--window-size=1440,940","file://"+decodeURIComponent(new URL("../../web-console/index-005.html", import.meta.url).pathname)],{stdio:"ignore"});
const wait = ms => new Promise(r=>setTimeout(r,ms));
await wait(6800); // file:// 初载（413KB settings-domain IIFE）完成后再 reload，抢跑 reload 会中断导航落 chrome-error
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
// hook-ready 轮询（时序稳定化——settings-domain IIFE 完成前注入会丢帧）
for (let i = 0; i < 40 && !(await ev(`typeof window.__ccDeck005ConnPool === "function"`)); i++) await wait(300);
if (!(await ev(`typeof window.__ccDeck005ConnPool === "function"`))) { console.log("FATAL: hook 未挂（IIFE 未完成）"); process.exit(1); }
const base = { relay_name:"本机 relay", token_valid:true, homedir:"/Users/u", sessions:[], logs:{}, notifications:[], pending_user_actions:[], org_confirms:[], acceptances:[], projects:[], receipts:[] };
const snap = (relays) => ev(`window.__ccDeck005Frames.emit({kind:"frame",source:"lan",frame:${JSON.stringify({type:"SNAPSHOT",payload:{...base,acct_relays:relays}})}})`);
const srcRows = () => ev(`JSON.stringify([...document.querySelectorAll(".queue-source [data-source-menu] .source-option[data-src-key]")].map(el=>({key:el.dataset.srcKey,choice:el.dataset.sourceChoice,name:el.querySelector("strong")?.textContent,sub:el.querySelector("small")?.textContent,off:el.classList.contains("src-off"),active:el.classList.contains("active"),tag:[...el.querySelectorAll(".tag")].map(t=>t.textContent)})))`);
const pool = () => ev(`JSON.stringify(window.__ccDeck005ConnPool())`);
const clickRow = (key) => ev(`(() => { const el = document.querySelector('.source-option[data-src-key="${key}"]'); if (el) el.click(); return String(!!el); })()`);

// ④ 单源简洁态（fresh 页：无登录/无云链/无配对——下拉=本机+添加，无聚合行无箭头无多源行）
{
  const rows = await srcRows();
  const simple = await ev(`JSON.stringify({ src: document.querySelectorAll(".source-option[data-src-key]").length, agg: !!document.querySelector('.source-option[data-source-choice="aggregate"]'), cloudRow: !!document.querySelector('.source-option[data-source-choice="cloud"]'), chev: !!document.querySelector(".queue-source .src-chev"), local: !!document.querySelector('.queue-source .source-option[data-source-choice="local"]'), add: !!document.querySelector(".queue-source [data-source-add]") })`);
  const s = JSON.parse(simple);
  ok(s.src === 0 && rows === "[]" && !s.agg && !s.chev && s.local && s.add, `④单源简洁态：零多源行+无聚合行+无箭头+本机行/添加钮在（${simple}）`);
  ok(!s.cloudRow, "④退役锚：data-source-choice=\"cloud\" 单行形态全 DOM 无残留");
}
// ① 三台同账号在线注入 → 行数=源数+排序+标签+五宿主同构+聚合行殿后+箭头
await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ user:"xdd", account_token:"tk" }))`);
await snap([{dev:"rl-c",name:"C机",rk:"rkC"},{dev:"rl-a",name:"A机",rk:"rkA"},{dev:"rl-b",name:"B机",rk:"rkB"}]); // 乱序注入——断言名字序自排
await wait(1000);
{
  const rows = JSON.parse(await srcRows());
  ok(rows.length === 3 && rows.map(r=>r.key).join(",") === "acct:rl-a,acct:rl-b,acct:rl-c" && rows.map(r=>r.name).join(",") === "A机,B机,C机", `①行数=源数+在线名字序（${rows.map(r=>r.name).join(",")}——乱序注入自排）`);
  ok(rows.every(r=>r.choice==="acct" && r.tag.includes("账号") && !r.off), "①行 anatomy：choice=acct+账号小标+在线态（无灰显）");
  const hosts = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll(".source-switcher [data-source-menu]")].map(m=>m.querySelectorAll(".source-option[data-src-key]").length))`));
  ok(hosts.length >= 5 && hosts.every(n=>n===3), `①五宿主同构（${hosts.length} 个 switcher 各 ${hosts.join("/")} 行——桌面 queue-source+mobile B7 全覆盖）`);
  const order = JSON.parse(await ev(`JSON.stringify([...document.querySelector(".queue-source [data-source-menu]").querySelectorAll(".source-option")].map(el=>el.dataset.srcKey||el.dataset.sourceChoice))`));
  ok(order[0]==="local" && order[order.length-1]==="aggregate" && order.filter(x=>x.startsWith("acct:")).length===3, `①落位：本机→三源行→聚合殿后（${order.join(" | ")}）`);
  ok(await ev(`!!document.querySelector(".queue-source .src-chev")`), "①纯 acct 场景箭头在场（批F 判据扩容——同账号在线源也是第二源）");
}
// ② 点击切换：fg 切池建+active 随视角+再切旧源留池（预热=不断后台）
{
  const c1 = await clickRow("acct:rl-b"); await wait(900);
  const s1 = JSON.parse(await pool());
  const rows1 = JSON.parse(await srcRows());
  ok(c1==="true" && s1.fg === "acct:rl-b" && s1.pool.includes("acct:rl-b"), `②点 B 行：fg=acct:rl-b+池建立（${JSON.stringify(s1)}）`);
  ok(rows1.find(r=>r.key==="acct:rl-b")?.active === true && rows1.filter(r=>r.key!=="acct:rl-b").every(r=>!r.active), "②active 随视角：B 行亮、其余行不亮");
  ok(await ev(`window.__ccDeck005SourceView() === "cloud"`), "②视角=cloud（activateAcctRelay 真切换）");
  const c2 = await clickRow("acct:rl-a"); await wait(900);
  const s2 = JSON.parse(await pool());
  const rows2 = JSON.parse(await srcRows());
  ok(s2.fg === "acct:rl-a" && s2.pool.includes("acct:rl-b") && s2.warm === "acct:rl-b", `②切 A：B 留池成预热位（${JSON.stringify(s2)}——池化切换不断后台）`);
  ok(rows2.find(r=>r.key==="acct:rl-a")?.active === true, "②active 跟手：A 行亮");
  const trig = await ev(`document.querySelector(".queue-source [data-current-source]")?.textContent || ""`);
  ok(!!trig && trig !== "本机" && trig !== "当前源", `⑤trigger 回归：视角源文本=「${trig}」（现逻辑——mock 无快照回落桥地址形态，非恒显本机）`);
}
// ③ 离线灰显：第二帧丢弃 rl-c → union 落 offline（灰显+上次在线副行+排序殿后）仍可点（冷连）
// 注：先回本机视角——lan 帧受 frameAllowed 门控（cloud 视角丢弃 lan 源；真实链路 ws 直达
// 不经总线门控，探针 emit 走总线才有此约束——connv4b ④c 同款处理）
await ev(`window.__ccDeck005SetSourceView ? window.__ccDeck005SetSourceView("local") : null`); await wait(400);
await snap([{dev:"rl-a",name:"A机",rk:"rkA"},{dev:"rl-b",name:"B机",rk:"rkB"}]); // rl-c 缺席=下线
await wait(1000);
{
  const rows = JSON.parse(await srcRows());
  const c = rows.find(r=>r.key==="acct:rl-c");
  ok(!!c && c.off === true && /在线$/.test(c.sub||""), `③离线灰显：rl-c 行在场+src-off+上次在线副行（${c?c.sub:"行消失"}）`);
  ok(rows.map(r=>r.key).join(",")==="acct:rl-a,acct:rl-b,acct:rl-c", "③排序：在线在前、离线殿后（设置页同口径）");
  const c3 = await clickRow("acct:rl-c"); await wait(900);
  const s3 = JSON.parse(await pool());
  ok(c3==="true" && s3.fg === "acct:rl-c" && s3.pool.includes("acct:rl-c"), `③离线行可点：fg=acct:rl-c+冷连池建（${JSON.stringify(s3)}——现行 ≤3s 冷连语义）`);
}
// ⑦ console 零真错（预期环境噪音滤除——mock 桥不可达的传输失败日志）
const realErrs = consoleErrs.filter(e => !/WebSocket|ERR_|net::|Failed to (load|connect)|192\.168|127\.0\.0\.1|localhost|nacl|通道启动异常/i.test(e));
ok(realErrs.length === 0, `⑦console 零真错（${realErrs.length} 条未滤错误）`);
console.log(`\n===== CONNV4F 探针：${PASS.length} ✓ / ${FAIL.length} ✗ =====`);
try { process.kill(p.pid, "SIGKILL"); } catch {}
process.exit(FAIL.length?1:0);
