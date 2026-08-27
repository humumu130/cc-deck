// #59 端到端：① 权限模式切换（acceptEdits 下 Write 不再进审批）② stop 后发消息自动 SDK resume（记忆保留）
// ③ / 斜杠命令直通（本地命令输出回时间线）。用法: npx tsx scripts/test-p3.ts
import WebSocket from "ws";

const TOKEN = process.env.CCR_TOKEN ?? "devtoken";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${TOKEN}`);

let sid = "";
let fail = 0;
let sdkId = "";
let permMode = "";
let waitingsThisTurn = 0;
let logs: { kind: string; tool?: string; text: string }[] = [];

const ok = (name: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail ? ` :: ${detail}` : ""}`);
  if (!cond) fail++;
};

const send = (type: string, payload: Record<string, unknown>) =>
  ws.send(JSON.stringify({ command_id: crypto.randomUUID(), type, ts: Date.now(), payload }));

const steps: { name: string; run: () => void }[] = [
  {
    name: "CREATE：记住 42（无工具，快速回合）",
    run: () => {
      send("COMMAND_CREATE", {
        cwd: "D:\\dev\\cc-watch\\relay\\data",
        prompt: "请记住数字 42。不要使用任何工具，只回复：OK",
      });
    },
  },
  {
    name: "COMMAND_PERM acceptEdits：状态 + 日志确认",
    run: () => {
      send("COMMAND_PERM", { session_id: sid, mode: "acceptEdits" });
    },
  },
  {
    name: "acceptEdits 生效验证：Write 不进审批直接执行",
    run: () => {
      waitingsThisTurn = 0;
      logs = [];
      send("COMMAND_MESSAGE", { session_id: sid, text: "用 Write 工具创建文件 p3-test.txt，内容一行：hello perm。完成后只回复：写入完成" });
    },
  },
  {
    name: "COMMAND_STOP：终止当前 agent",
    run: () => {
      send("COMMAND_STOP", { session_id: sid });
    },
  },
  {
    name: "死会话发消息：自动 SDK resume，验证记忆（42）",
    run: () => {
      logs = [];
      send("COMMAND_MESSAGE", { session_id: sid, text: "我最初让你记住的数字是多少？只回复数字本身。" });
    },
  },
  {
    name: "/斜杠命令直通（/usage 本地命令输出）",
    run: () => {
      logs = [];
      send("COMMAND_MESSAGE", { session_id: sid, text: "/usage" });
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
    console.log(fail === 0 ? "\n[test-p3] ALL PASS" : `\n[test-p3] FAIL x${fail}`);
    ws.close();
    process.exit(fail === 0 ? 0 : 1);
  }
};

ws.on("open", () => next());

let doneCount = 0;
let permAdvanced = false;
ws.on("message", (d) => {
  const env = JSON.parse(String(d));
  if (env.type === "COMMAND_ACK") {
    if (!env.ok) console.log(`  [ack-fail] ${env.error}`);
    if (env.session_id) sid = env.session_id;
    // STOP 在空闲会话上不产生 DONE（状态本就是终态）：ack 后直接进入下一步
    if (env.ok && stepIdx === 3) setTimeout(next, 2000);
    return;
  }
  if (env.session_id !== sid) return;

  if (env.type === "SESSION_UPDATED") {
    if (env.payload.relay_session_id) sdkId = env.payload.relay_session_id;
    if (env.payload.permission_mode) permMode = env.payload.permission_mode;
    return;
  }
  if (env.type === "SESSION_WAITING") {
    waitingsThisTurn++;
    console.log(`  [waiting] ${env.payload.tool_name}（本回合第 ${waitingsThisTurn} 次）`);
    send("COMMAND_CONTINUE", { session_id: sid, request_id: env.payload.request_id });
    return;
  }
  if (env.type === "SESSION_LOG") {
    const p = env.payload;
    logs.push({ kind: p.kind, tool: p.tool, text: p.text });
    if (stepIdx === 1 && !permAdvanced && String(p.text).includes("权限模式切换")) {
      permAdvanced = true;
      // SESSION_UPDATED 与日志几乎同时到达，稍等再断言
      setTimeout(() => {
        ok("权限模式状态下报", permMode === "acceptEdits", `permMode=${permMode}`);
        next();
      }, 600);
    }
    return;
  }
  if (env.type === "SESSION_DONE") {
    doneCount++;
    console.log(`  [done#${doneCount}] ${env.payload.terminal_reason}`);
    switch (stepIdx) {
      case 0:
        ok("回合完成且拿到 SDK 会话 id", !!sdkId, `sdkId=${sdkId}`);
        next();
        break;
      case 2:
        ok("acceptEdits 生效：Write 未进审批", waitingsThisTurn === 0, `waitings=${waitingsThisTurn}`);
        ok("文件已写入（tool_result 存在）", logs.some((l) => l.kind === "tool_result"));
        next();
        break;
      case 4: {
        const answer = logs.filter((l) => l.kind === "assistant_text").map((l) => l.text).join("");
        ok("resume 保留记忆（回答含 42）", answer.includes("42"), answer.slice(0, 120));
        next();
        break;
      }
      case 5: {
        const all = logs.map((l) => l.text).join("\n");
        console.log(`  [slash-output] ${all.slice(0, 200).replace(/\n/g, " | ")}`);
        ok("/命令有输出且非报错", logs.length > 0 && !all.includes("No such command") && !all.toLowerCase().includes("unknown command"));
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
