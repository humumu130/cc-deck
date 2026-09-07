// 模拟浏览器：配对 → 存档 → 二次进程(=刷新)同密钥 hello，验证快照恢复
import WebSocket from "ws";
import nacl from "./node_modules/tweetnacl/nacl-fast.js";
import crypto from "node:crypto";
const b64=(u)=>Buffer.from(u).toString("base64");
const fromB64=(s)=>new Uint8Array(Buffer.from(s,"base64"));
const devId=(pk,pre)=>pre+"-"+[...pk.slice(0,8)].map(x=>x.toString(16).padStart(2,"0")).join("");
const phase=process.argv[2];
const RELAY_PK="OppoyRBPW0QTDZNuDoNnucqgIuPFaAG9YXuVMadJARw=";
const seed=Uint8Array.from({length:32},(_,i)=>i*3+1);
const kp=nacl.box.keyPair.fromSecretKey(seed);
const dev=devId(kp.publicKey,"wb");
const ws=new WebSocket(`wss://cc.humumu.online/cloud?token=ccdeck-public-9f3k2m7v&dev=${dev}`);
const send=(o)=>ws.send(JSON.stringify(o));
const seal=(o,tp,sk)=>{const n=nacl.randomBytes(nacl.box.nonceLength);const c=nacl.box(new TextEncoder().encode(JSON.stringify(o)),n,fromB64(tp),sk);return {n:b64(n),c:b64(c)};};
ws.on("open",async()=>{
  console.log(`[${phase}] ws open dev=${dev}`);
  if(phase==="pair"){
    const r=await fetch("http://127.0.0.1:8787/api/pair-code?token=devtoken",{method:"POST"});
    const {code}=await r.json();
    console.log(`[${phase}] code=${code}`);
    send({to:"rl-3a9a68c9104f5b44",data:{t:"pair_req",code,pubkey:b64(kp.publicKey),name:"t305"}});
  }else{
    send({to:"rl-3a9a68c9104f5b44",data:seal({t:"hello",last_seq:0},RELAY_PK,kp.secretKey)});
  }
});
ws.on("message",(m)=>{
  const f=JSON.parse(String(m));
  const d=f.data;
  if(d&&!d.n&&d.t==="pair_ack"||d&&!d.n&&d.type){ console.log(`[${phase}] ack:`,JSON.stringify(d).slice(0,120)); if(phase==="pair")process.exit(0); }
  else if(d&&d.n){ // sealed
    const open=nacl.box.open(fromB64(d.c),fromB64(d.n),fromB64(f.from===dev?RELAY_PK:RELAY_PK),kp.secretKey);
    if(open){ const o=JSON.parse(new TextDecoder().decode(open)); console.log(`[${phase}] SEALED ${o.t}:`,JSON.stringify(o).slice(0,140));
      if(o.t==="SNAPSHOT"){console.log(`[${phase}] ✅ REFRESH-RECOVER OK sessions=${(o.sessions||[]).length}`);process.exit(0);} }
    else console.log(`[${phase}] sealed-unopen from=${f.from}`);
  } else console.log(`[${phase}] frame:`,String(m).slice(0,100));
});
ws.on("close",(c)=>{console.log(`[${phase}] closed`,c);process.exit(1);});
setTimeout(()=>{console.log(`[${phase}] TIMEOUT 20s`);process.exit(2);},20000);
