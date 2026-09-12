// #75 快查：连本机 relay 拉 sessions 快照，hex dump 待确认 todo 的 content 字节
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8787/ws?token=" + process.env.TOKEN);
const seen = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "COMMAND_REFRESH_TODOS" })));
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    console.log("msg type:", m.type);
    const sessions = m.sessions ?? m.snapshot?.sessions ?? m.payload?.sessions;
    if (sessions) {
      for (const s of sessions) {
        for (const t of s.todos ?? []) {
          if ((t.content ?? "").includes("确认") || (t.content ?? "").includes("晨报")) {
            seen.push({ sid: s.session_id, content: t.content });
          }
        }
      }
      ws.close();
    }
  } catch {}
});
ws.on("close", () => {
  if (!seen.length) { console.log("快照未见待确认/晨报条目（可能事件名不符）"); return; }
  for (const { sid, content } of seen) {
    console.log("sid:", sid);
    console.log("text:", JSON.stringify(content));
    const i = content.indexOf("待确认");
    if (i >= 0) console.log("hex(待确认周边):", Buffer.from(content.slice(Math.max(0, i - 4), i + 7), "utf8").toString("hex"));
    const j = content.indexOf("晨报");
    if (j >= 0) console.log("hex(晨报周边):", Buffer.from(content.slice(Math.max(0, j - 4), j + 6), "utf8").toString("hex"));
  }
});
setTimeout(() => { console.log("超时，收到消息类型:", "（无）"); process.exit(1); }, 5000);
