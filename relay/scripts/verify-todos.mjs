// 一次性验证：turn_started_at（WORKING 时设置）+ SESSION_UPDATED 携带 todos
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:8787/ws?token=devtoken");
let sid = null;
let sawTurnStart = false;
let sawTodos = false;
const done = () => {
  console.log("RESULT turn_started_at:", sawTurnStart, "| todos in SESSION_UPDATED:", sawTodos);
  process.exit(sawTurnStart && sawTodos ? 0 : 1);
};
const timer = setTimeout(() => { console.log("timeout"); done(); }, 120000);

ws.on("open", () => {
  ws.send(JSON.stringify({
    command_id: `vt-${Date.now()}`,
    type: "COMMAND_CREATE",
    ts: Date.now(),
    payload: {
      cwd: "D:\\dev\\cc-watch\\relay\\data\\scratch",
      prompt: "Use TaskCreate to create exactly 2 tasks: 'alpha' and 'beta'. Then use TaskUpdate to mark task 1 in_progress, then completed. Then reply DONE.",
    },
  }));
});
ws.on("message", (m) => {
  const env = JSON.parse(String(m));
  if (env.type === "COMMAND_ACK" && env.ok) sid = env.session_id;
  if (env.type === "SESSION_UPDATED" && env.session_id === sid) {
    if (env.payload.turn_started_at !== undefined) { sawTurnStart = true; console.log("turn_started_at:", env.payload.turn_started_at); }
    if (env.payload.todos) { sawTodos = true; console.log("todos:", JSON.stringify(env.payload.todos)); }
  }
  if (env.type === "SESSION_DONE" && env.session_id === sid) { clearTimeout(timer); done(); }
});
ws.on("error", (e) => { console.error("WS error", e.message); process.exit(1); });
