// #62 验证：流式 SESSION_LOG（同 id 原地替换 + streaming 标记）。
// 用法: npx tsx scripts/peek-stream.ts
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8787/ws?token=devtoken");
let sid = "";
let count = 0;

ws.on("open", () => {
  console.log("[peek] connected, sending CREATE");
  ws.send(JSON.stringify({
    command_id: crypto.randomUUID(),
    type: "COMMAND_CREATE",
    ts: Date.now(),
    payload: { cwd: "D:\\dev\\cc-watch\\relay\\data", prompt: "请写一段400字左右的关于HTTP/3协议的介绍，直接输出正文，不要列表。" },
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
    if (p.kind === "assistant_text") {
      count++;
      console.log(`[str #${count}] id=${p.id ?? "-"} streaming=${p.streaming ?? false} text=${p.text.length}ch full=${p.full ? p.full.length + "ch" : "-"} :: ${p.text.slice(0, 40).replace(/\n/g, " ")}`);
    }
    return;
  }
  if (env.type === "SESSION_DONE" && env.session_id === sid) {
    console.log(`[peek] DONE, assistant_text envelopes=${count}`);
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (e) => { console.log("[err]", e.message); process.exit(1); });
setTimeout(() => { console.log(`[peek] timeout, assistant_text envelopes=${count}`); process.exit(2); }, 180_000);
