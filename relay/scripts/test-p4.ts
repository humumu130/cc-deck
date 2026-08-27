// #61 端到端：① TodoWrite 工具的 todos 经 SESSION_UPDATED 下发 ② 图片消息（base64 → SDK image block）
// 模型正确描述图片内容（红底黄圆）即认为视觉链路通。用法: npx tsx scripts/test-p4.ts
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN = process.env.CCR_TOKEN ?? "devtoken";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${TOKEN}`);
const imgB64 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "p4-red.jpg")).toString("base64");

let sid = "";
let fail = 0;
let sdkId = "";
let waitingsThisTurn = 0;
let todos: unknown[] = [];
let logs: { kind: string; text: string }[] = [];

const ok = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail ? ` :: ${detail}` : ""}`);
  if (!cond) fail++;
};

const send = (type: string, payload: Record<string, unknown>) =>
  ws.send(JSON.stringify({ command_id: crypto.randomUUID(), type, ts: Date.now(), payload }));

const steps: { name: string; run: () => void }[] = [
  {
    name: "CREATE：让模型用 TodoWrite 建三任务",
    run: () => {
      send("COMMAND_CREATE", {
        cwd: "D:\\dev\\cc-watch\\relay\\data",
        prompt:
          "请用 TodoWrite 工具创建任务列表，恰好三项：①分析需求 ②编写代码 ③运行测试。第一项标记为 in_progress，其余 pending。创建完成后只回复：清单已建",
      });
    },
  },
  {
    name: "发图片（红底黄圆）：模型应描述出颜色",
    run: () => {
      waitingsThisTurn = 0;
      logs = [];
      send("COMMAND_MESSAGE", {
        session_id: sid,
        text: "我刚发给你一张图片。图片的背景是什么颜色？中间的圆形是什么颜色？只回答两个颜色名。",
        images: [imgB64],
      });
    },
  },
  {
    name: "COMMAND_STOP：终止当前 agent",
    run: () => {
      send("COMMAND_STOP", { session_id: sid });
    },
  },
  {
    name: "resume 场景图片：死会话带图发消息",
    run: () => {
      waitingsThisTurn = 0;
      logs = [];
      send("COMMAND_MESSAGE", {
        session_id: sid,
        text: "再看这张图片，它的整体色调偏暖还是偏冷？只回答两个字。",
        images: [imgB64],
      });
    },
  },
];

let stepIdx = -1;
const next = () => {
  stepIdx++;
  if (stepIdx < steps.length) {
    console.log(`\n[step ${stepIdx + 1}/${steps.length}] ${steps[stepIdx].name}`);
    steps[stepIdx].run();
  } else {
    console.log(fail === 0 ? "\n[test-p4] ALL PASS" : `\n[test-p4] FAIL x${fail}`);
    ws.close();
    process.exit(fail === 0 ? 0 : 1);
  }
};

ws.on("open", () => next());

let doneCount = 0;
let todoSeen3 = false;
ws.on("message", (d) => {
  const env = JSON.parse(String(d));
  if (env.type === "COMMAND_ACK") {
    if (!env.ok) console.log(`  [ack-fail] ${env.error}`);
    if (env.session_id) sid = env.session_id;
    // STOP 在空闲会话上不产生 DONE：ack 后稍等收尾再进下一步
    if (env.ok && stepIdx === 2) setTimeout(next, 2000);
    return;
  }
  if (env.session_id !== sid) return;

  if (env.type === "SESSION_UPDATED") {
    if (env.payload.relay_session_id) sdkId = env.payload.relay_session_id;
    if (Array.isArray(env.payload.todos) && env.payload.todos.length > 0) {
      todos = env.payload.todos;
      if (todos.length === 3) todoSeen3 = true;
    }
    return;
  }
  if (env.type === "SESSION_WAITING") {
    waitingsThisTurn++;
    console.log(`  [waiting] ${env.payload.tool_name}`);
    send("COMMAND_CONTINUE", { session_id: sid, request_id: env.payload.request_id });
    return;
  }
  if (env.type === "SESSION_LOG") {
    const p = env.payload;
    logs.push({ kind: p.kind, text: p.text });
    return;
  }
  if (env.type === "SESSION_DONE") {
    doneCount++;
    console.log(`  [done#${doneCount}] ${env.payload.terminal_reason}`);
    switch (stepIdx) {
      case 0: {
        ok("todos 下发（3 项）", todoSeen3, `todos=${JSON.stringify(todos).slice(0, 120)}`);
        const first = todos[0] as { status?: string; content?: string } | undefined;
        ok("第一项 in_progress", first?.status === "in_progress", `status=${first?.status}`);
        ok("拿到 SDK 会话 id", !!sdkId);
        next();
        break;
      }
      case 1: {
        const answer = logs.filter((l) => l.kind === "assistant_text").map((l) => l.text).join("");
        console.log(`  [answer] ${answer.slice(0, 120).replace(/\n/g, " ")}`);
        const hasRed = answer.includes("红");
        const hasYellow = answer.includes("黄") || answer.toLowerCase().includes("yellow");
        ok("模型识别出红色背景", hasRed, answer.slice(0, 160));
        ok("模型识别出黄色圆形", hasYellow, answer.slice(0, 160));
        next();
        break;
      }
      case 3: {
        const answer = logs.filter((l) => l.kind === "assistant_text").map((l) => l.text).join("");
        console.log(`  [answer] ${answer.slice(0, 120).replace(/\n/g, " ")}`);
        ok("resume 后图片仍可读（回答偏暖）", answer.includes("暖"), answer.slice(0, 160));
        next();
        break;
      }
      default:
        break;
    }
  }
});

ws.on("error", (e) => {
  console.error("[test] ws error:", e.message);
  process.exit(2);
});
setTimeout(() => {
  console.error(`[test] timeout 300s（step ${stepIdx + 1}）`);
  process.exit(3);
}, 300_000);
