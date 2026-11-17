// W-ACCTMULTI 复现-修复探针：三台语义帧注入（Mac 本机=去自见；公司/家 Win 两行）
import { spawn } from "node:child_process";
const WS = (await import("/Users/xdd/dev/cc-deck/relay/node_modules/ws/index.js")).default;
const PORT = 9930 + Math.floor(Math.random()*40);
const p = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new","--disable-gpu","--disable-extensions",`--remote-debugging-port=${PORT}`,"--user-data-dir=/tmp/acctm-"+Date.now(),"--window-size=1440,940","file:///private/tmp/cc-deck-w-acctmulti/web-console/index-005.html"],{stdio:"ignore"});
const wait = ms => new Promise(r=>setTimeout(r,ms));
await wait(3400);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WS(list.find(t=>t.type==="page").webSocketDebuggerUrl,{maxPayload:64*1024*1024});
await new Promise(r=>ws.once("open",r));
let seq=0; const pend=new Map();
ws.on("message",d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(method,params={})=>new Promise(res=>{const id=++seq;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});
const ev=async(e)=>(await send("Runtime.evaluate",{expression:e,returnByValue:true})).result.result.value;
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setBlockedURLs",{urls:["*localhost:*8787*","*127.0.0.1:8787*","*cc.humumu.online*"]});
await send("Page.reload"); await wait(3000);
const PASS=[],FAIL=[]; const ok=(c,n)=>{(c?PASS:FAIL).push(n);console.log((c?"  ✓ ":"  ✗ ")+n);};
const frame = (source, f) => ev(`window.__ccDeck005Frames.emit({kind:"frame",source:"${source}",frame:${JSON.stringify(f)}})`);
const base = { relay_name:"本机 relay", token_valid:true, homedir:"/Users/u", sessions:[], logs:{}, notifications:[], pending_user_actions:[], org_confirms:[], acceptances:[], projects:[], receipts:[] };
// 登录态
await ev(`localStorage.setItem("ccr_acct", JSON.stringify({ user:"xdd", account_token:"tk" }))`);
const rows = () => ev(`(() => { const b = window.__ccDeck005B4; const rows = [...document.querySelectorAll(".acct-relay-row")]; return JSON.stringify({ snap: (b.snapshot.acct_relays||[]).map(r=>r.dev+":"+(r.online?"on":"off")), dom: rows.map(r=>({name:(r.querySelector("strong")||{}).textContent, offline: !!r.querySelector(".tag")||/离线/.test(r.textContent), btn: !!r.querySelector("[data-acct-relay-connect]")})), live: [...document.querySelectorAll("[data-settings-live]")].some(el=>el.innerHTML.includes("acct-relay-row")) }); })()`);
// ① 本机视角（LAN SNAPSHOT：公司+家 两行）
await frame("lan", { type:"SNAPSHOT", payload:{...base, acct_relays:[{dev:"rl-office",name:"公司Win",rk:"rkO"},{dev:"rl-home",name:"家里Win",rk:"rkH"}]} });
await wait(900); await ev(`window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()`); await wait(500);
const s1 = JSON.parse(await rows());
ok(s1.snap.length===2 && s1.dom.length===2, `①本机视角两行（snap=${JSON.stringify(s1.snap)} dom=${s1.dom.length}）`);
// ② 切云视角（公司 Win 视角的 SNAPSHOT：acct_relays=[Mac,家Win]——不含公司自己）→修后仍 2 行
await frame("cloud", { type:"SNAPSHOT", payload:{...base, relay_name:"公司Win", acct_relays:[{dev:"rl-mac",name:"MacBook",rk:"rkM"},{dev:"rl-home",name:"家里Win",rk:"rkH"}]} });
await wait(900); await ev(`window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()`); await wait(500);
const s2 = JSON.parse(await rows());
ok(s2.dom.length===2 && s2.dom.some(r=>r.name==="公司Win"), `②云视角（公司Win）后公司行仍在（dom=${JSON.stringify(s2.dom.map(d=>d.name))}——云键被本机缓存覆写=互踩根除）`);
// ③ 再切家 Win（ACCT_RELAYS 增量：家视角在线集=[公司]——家自见）→两行恒驻
await frame("cloud", { type:"SNAPSHOT", payload:{...base, relay_name:"家里Win", acct_relays:[{dev:"rl-mac",name:"MacBook",rk:"rkM"},{dev:"rl-office",name:"公司Win",rk:"rkO"}]} });
await wait(800);
const s3 = JSON.parse(await rows());
ok(s3.dom.length===2 && s3.dom.some(r=>r.name==="家里Win") && s3.dom.some(r=>r.name==="公司Win"), `③再切家里Win 视角后两行恒驻（dom=${JSON.stringify(s3.dom.map(d=>d.name))}——用户实锤场景闭环）`);
// ④ 下线态（LAN ACCT_RELAYS 帧=公司下线：帧表只家）→公司行灰显不删
await frame("lan", { type:"ACCT_RELAYS", payload:{ relays:[{dev:"rl-home",name:"家里Win",rk:"rkH"}] } });
await wait(900); await ev(`window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()`); await wait(500);
const s4 = JSON.parse(await rows());
ok(s4.dom.length===2 && s4.dom.find(r=>r.name==="公司Win")?.offline===true && s4.dom.find(r=>r.name==="家里Win")?.offline===false, `④公司下线=灰显常驻不删（dom=${JSON.stringify(s4.dom.map(d=>d.name+(d.offline?"(灰)":"(连)")))}）`);
// ⑤ 回本机视角（LAN SNAPSHOT 全集）→两行在线恢复
await frame("lan", { type:"SNAPSHOT", payload:{...base, acct_relays:[{dev:"rl-office",name:"公司Win",rk:"rkO"},{dev:"rl-home",name:"家里Win",rk:"rkH"}]} });
await wait(900);
const s5 = JSON.parse(await rows());
ok(s5.dom.every(r=>!r.offline) && s5.dom.length===2, `⑤切回本机视角两行在线（snap=${JSON.stringify(s5.snap)}）`);
// ⑦ 下线机在后续 LAN SNAPSHOT（不含它）后仍灰显保留（同源回写面——payload 原样会挤掉下线项）
await frame("lan", { type:"SNAPSHOT", payload:{...base, acct_relays:[{dev:"rl-home",name:"家里Win",rk:"rkH"}]} });
await wait(900); await ev(`window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()`); await wait(500);
const s7 = JSON.parse(await rows());
ok(s7.dom.length===2 && s7.dom.find(r=>r.name==="公司Win")?.offline===true, `⑦下线机在后续 LAN SNAPSHOT 后仍灰显保留（dom=${JSON.stringify(s7.dom.map(d=>d.name+(d.offline?"(灰)":"(连)")))}）`);
// ⑧ 旧病复现（单变量）：手动模拟旧代码云帧效果（snapshot 直写云视角差集表——修前语义）→公司行消失
await frame("lan", { type:"SNAPSHOT", payload:{...base, acct_relays:[{dev:"rl-office",name:"公司Win",rk:"rkO"},{dev:"rl-home",name:"家里Win",rk:"rkH"}]} });
await wait(700);
await ev(`(() => { const b = window.__ccDeck005B4; b.snapshot.acct_relays = [{ dev:"rl-mac", name:"MacBook", rk:"rkM", online:true },{ dev:"rl-home", name:"家里Win", rk:"rkH", online:true }]; })()`); // 修前：云 SNAPSHOT 的 p 原样落 snapshot（视角=公司Win 差集——无公司行）
await ev(`window.__ccDeck005RefreshSettingsLive && window.__ccDeck005RefreshSettingsLive()`); await wait(500);
const s8 = JSON.parse(await rows());
ok(!s8.dom.some(r=>r.name==="公司Win"), `⑧旧病复现（单变量实证）：snapshot 直写云差集表→公司行消失（dom=${JSON.stringify(s8.dom.map(d=>d.name))}——修前用户实锤形态；修后真实云帧走缓存覆写不再达此态）`);
await frame("lan", { type:"SNAPSHOT", payload:{...base, acct_relays:[{dev:"rl-office",name:"公司Win",rk:"rkO"},{dev:"rl-home",name:"家里Win",rk:"rkH"}]} });
await wait(700);
const errs = await ev(`window.__errs ? window.__errs.length : -1`);
ok(errs===0||errs===-1, `⑥console 零错（errs=${errs}）`);
console.log(`\n===== ACCTMULTI 探针：${PASS.length} ✓ / ${FAIL.length} ✗ =====`);
process.exit(FAIL.length?1:0);
