// 一次性工具：经 LAN ws 发 COMMAND_CREATE，建一个短命 managed 会话（用于手机端流式 UI 测试）
import WebSocket from "ws";

const prompt = process.argv[2] ?? "count from 1 to 30, one number per line";
const ws = new WebSocket("ws://localhost:8787/ws?token=devtoken");
const t0 = Date.now();
ws.on("open", () => {
  ws.send(JSON.stringify({
    command_id: `mk-${Date.now()}`,
    type: "COMMAND_CREATE",
    ts: Date.now(),
    payload: { cwd: "D:\\dev\\cc-watch\\relay\\data\\scratch", prompt },
  }));
});
ws.on("message", (m) => {
  const env = JSON.parse(String(m));
  if (env.type === "COMMAND_ACK") {
    console.log("ACK", JSON.stringify(env));
    if (!env.ok) process.exit(1);
  } else if (env.type === "SESSION_STATE" && env.payload?.s?.status === "WORKING") {
    console.log("WORKING id=", env.session_id);
    setTimeout(() => { ws.close(); process.exit(0); }, 1500);
  } else if (env.type === "SESSION_STATE") {
    console.log("STATE", env.payload?.s?.status, "elapsed", Date.now() - t0);
  }
});
ws.on("error", (e) => { console.error("WS error", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 60000);
