// #57 验证：创建会话请求长回复，观察 SESSION_LOG 是否携带 full 原文字段。
// 用法: npx tsx scripts/peek-full.ts
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8787/ws?token=devtoken");
let sid = "";

ws.on("open", () => {
  console.log("[peek] connected, sending CREATE");
  ws.send(JSON.stringify({
    command_id: crypto.randomUUID(),
    type: "COMMAND_CREATE",
    ts: Date.now(),
    payload: { cwd: "D:\\dev\\cc-watch\\relay\\data", prompt: "请写一段500字左右的关于WebSocket协议工作原理的介绍，直接输出正文，不要列表。" },
  }));
});

ws.on("message", (d) => {
  const env = JSON.parse(String(d));
  if (env.type === "COMMAND_ACK") {
    console.log(`[ack] ok=${env.ok} sid=${env.session_id ?? "-"} ${env.error ?? ""}`);
    if (env.session_id) sid = env.session_id;
    return;
  }
  if (env.type === "SESSION_LOG") {
    const p = env.payload;
    console.log(`[log] kind=${p.kind} text=${p.text.length}ch full=${p.full ? p.full.length + "ch" : "-"} :: ${p.text.slice(0, 60)}`);
    return;
  }
  if (env.type === "SESSION_UPDATED" && env.session_id === sid) {
    console.log(`[upd] status=${env.payload.status}`);
  }
  if (env.type === "SESSION_DONE" && env.session_id === sid) {
    console.log("[peek] DONE, exiting");
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (e) => { console.log("[err]", e.message); process.exit(1); });
setTimeout(() => { console.log("[peek] timeout 180s"); process.exit(2); }, 180_000);
