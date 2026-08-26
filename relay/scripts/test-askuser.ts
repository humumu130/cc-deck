// #55 端到端：托管会话 AskUserQuestion → questions 结构化下发 → COMMAND_ANSWER → 模型按答案继续。
// 用法: npx tsx scripts/test-askuser.ts          （脚本自动作答）
//       NO_ANSWER=1 npx tsx scripts/test-askuser.ts （等外部客户端作答，验证手机/手表 UI）
import WebSocket from "ws";

const NO_ANSWER = process.env.NO_ANSWER === "1";

const TOKEN = process.env.CCR_TOKEN ?? "devtoken";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${TOKEN}`);

let sid = "";
let fail = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail ? ` :: ${detail}` : ""}`);
  if (!cond) fail++;
};

let resolvedDecision = "";
let sawAnswerEcho = false;

ws.on("open", () => {
  console.log("[test] connected, CREATE（指示模型用 AskUserQuestion 提问）");
  ws.send(JSON.stringify({
    command_id: crypto.randomUUID(),
    type: "COMMAND_CREATE",
    ts: Date.now(),
    payload: {
      cwd: "D:\\dev\\cc-watch\\relay\\data",
      prompt: "请用 AskUserQuestion 工具问我：部署用哪个环境？选项：生产环境 / 预发环境 / 本地。header 用「部署环境」。问完停下等我选择。",
    },
  }));
});

ws.on("message", (d) => {
  const env = JSON.parse(String(d));
  if (env.type === "COMMAND_ACK") {
    console.log(`[ack] ok=${env.ok} sid=${env.session_id ?? "-"} ${env.error ?? ""}`);
    if (env.session_id) sid = env.session_id;
    return;
  }
  if (env.type === "SESSION_WAITING" && env.session_id === sid) {
    const p = env.payload;
    console.log(`[waiting] tool=${p.tool_name} questions=${JSON.stringify(p.questions ?? null)}`);
    ok("WAITING 携带 questions", Array.isArray(p.questions) && p.questions.length === 1, JSON.stringify(p.questions));
    if (Array.isArray(p.questions) && p.questions[0]) {
      ok("问题 header=部署环境", p.questions[0].header === "部署环境");
      ok("选项含 生产环境", p.questions[0].options.some((o: { label: string }) => o.label === "生产环境"));
    }
    console.log("[test] 发送 COMMAND_ANSWER: 生产环境");
    if (!NO_ANSWER) {
      ws.send(JSON.stringify({
        command_id: crypto.randomUUID(),
        type: "COMMAND_ANSWER",
        ts: Date.now(),
        payload: { session_id: sid, request_id: p.request_id, answers: ["生产环境"] },
      }));
    } else {
      console.log("[test] NO_ANSWER 模式：等待外部客户端作答…");
    }
    return;
  }
  if (env.type === "SESSION_WAITING_RESOLVED" && env.session_id === sid) {
    resolvedDecision = env.payload.decision;
    console.log(`[resolved] decision=${resolvedDecision} by=${env.payload.by}`);
    return;
  }
  if (env.type === "SESSION_LOG" && env.session_id === sid && env.payload.kind === "assistant_text") {
    if (String(env.payload.text).includes("生产")) sawAnswerEcho = true;
    return;
  }
  if (env.type === "SESSION_DONE" && env.session_id === sid) {
    console.log(`[done] ${env.payload.terminal_reason}`);
    ok("resolved decision=answer", resolvedDecision === "answer", resolvedDecision);
    ok("模型收到答案并继续（正文提及「生产」）", sawAnswerEcho);
    console.log(fail === 0 ? "\n[test-askuser] ALL PASS" : `\n[test-askuser] FAIL x${fail}`);
    ws.close();
    process.exit(fail === 0 ? 0 : 1);
  }
});

ws.on("error", (e) => {
  console.error("[test] ws error:", e.message);
  process.exit(2);
});
setTimeout(() => {
  console.error(`[test] timeout ${NO_ANSWER ? 300 : 180}s`);
  process.exit(3);
}, NO_ANSWER ? 300_000 : 180_000);
