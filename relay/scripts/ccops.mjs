#!/usr/bin/env node
// cc-deck Leader 运维工具（2026-10-11 重建，常驻 ~/.cc-deck/bin 防 /tmp 清空；X1 起有仓内
// 正源 relay/scripts/ccops.mjs——部署位拷贝同步，改仓内后 cp 过去）。
// 用法：
//   ccops.mjs dispatch <任务书md> <cwd> [engine]        # 建 worker 会话（文件全文为首条 prompt）
//   ccops.mjs send <sessionId> <文本|md文件路径>         # 发消息（本机会话）
//   ccops.mjs send --dev <dev> [--session <sid>] <文本|md> # 跨机消息（X1 密封 xmsg；省略
//                                                         #  session=对端值班位；阻塞回显注入/被拒，≤30s）
//   ccops.mjs stop <sessionId> | delete <sessionId>
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
const require = createRequire("/Users/xdd/dev/cc-deck/relay/package.json");
const WebSocket = require("ws");

const TOKEN = readFileSync(process.env.HOME + "/.cc-deck/data/token", "utf8").trim();
const URL = `ws://127.0.0.1:8787/ws?token=${TOKEN}`;
const [, , op, ...args] = process.argv;
const cid = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ---- X1 跨机消息（COMMAND_XMSG 漏斗 + status 轮询阻塞回显） ----
function xmsgSend() {
  // args: --dev <dev> [--session <sid>] <text|md>
  let dev = "", session = "", rest = [...args];
  if (rest[0] !== "--dev") { console.error("用法: ccops send --dev <dev> [--session <sid>] <文本|md文件>"); process.exit(1); }
  dev = rest[1]; rest = rest.slice(2);
  if (rest[0] === "--session") { session = rest[1]; rest = rest.slice(2); }
  const textOrFile = rest.join(" ");
  if (!dev || !textOrFile) { console.error("用法: ccops send --dev <dev> [--session <sid>] <文本|md文件>"); process.exit(1); }
  const text = existsSync(textOrFile) && textOrFile.endsWith(".md") ? readFileSync(textOrFile, "utf-8") : textOrFile;
  const waitMs = Number(process.env.CCR_XMSG_WAIT ?? 30_000);
  const ws = new WebSocket(URL);
  const deadline = Date.now() + waitMs;
  let msgId = null;
  const finish = (state, detail) => {
    console.log(`xmsg ${state}${detail ? `（${detail}）` : ""}${msgId ? ` msg_id=${msgId}` : ""}`);
    ws.close();
    process.exit(/injected/.test(state) ? 0 : 3);
  };
  const killer = setTimeout(() => {
    if (msgId) console.log(`xmsg 在途（msg_id=${msgId}，${Math.round(waitMs / 1000)}s 窗口未到终态——relay 侧 outbox 会继续补发）`);
    else console.error("TIMEOUT: relay 无响应");
    process.exit(msgId ? 4 : 2);
  }, Math.max(waitMs + 10_000, 40_000));
  const pollOnce = () => {
    if (Date.now() > deadline) {
      console.log(`xmsg 在途（msg_id=${msgId}，${Math.round(waitMs / 1000)}s 窗口未到终态——relay 侧 outbox 会继续补发）`);
      clearTimeout(killer); ws.close(); process.exit(4);
    }
    ws.send(JSON.stringify({ command_id: `${cid}-p${Date.now()}`, type: "COMMAND_XMSG", payload: { op: "status", msg_id: msgId } }));
  };
  ws.on("open", () => {
    ws.send(JSON.stringify({ command_id: cid, type: "COMMAND_XMSG", payload: { op: "send", dev, ...(session ? { session } : {}), text } }));
  });
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== "COMMAND_ACK") return;
    if (!m.ok) { console.error(`xmsg 发送失败: ${m.error}`); clearTimeout(killer); ws.close(); process.exit(3); }
    msgId = m.data?.msg_id ?? msgId;
    const state = m.data?.state;
    if (state && /injected|rejected|failed/.test(state)) { clearTimeout(killer); finish(state, m.data?.detail); return; }
    setTimeout(pollOnce, 1000);
  });
  ws.on("error", (e) => { console.error("WS-ERR:", e.message); process.exit(2); });
}

if (op === "send" && args[0] === "--dev") { xmsgSend(); /* 不回落 */ }

const ws = new WebSocket(URL);
const timeout = setTimeout(() => { console.error("TIMEOUT: relay 无响应"); process.exit(2); }, 30000);

ws.on("open", () => {
  let frame;
  if (op === "dispatch") {
    // 机制强制（2026-10-12 用户拍板）：派单必须走 org dispatch 进看板，禁止绕行
    // COMMAND_CREATE 裸建（绕开=任务表失踪=追踪丢失根源）。GID 缺省=研发组。
    const [taskFile, cwd, engine] = args;
    const GID = process.env.CCOPS_GID || "pg-7cb58ab4";
    const TITLE = taskFile.split("/").pop().replace(/\.md$/, "");
    frame = { command_id: cid, type: "COMMAND_ORG_ACTION", payload: { action: "dispatch", anchor: cwd, task: { text: readFileSync(taskFile, "utf8") }, gid: GID, title: TITLE, ...(engine ? { engine } : {}) } };
  } else if (op === "send") {
    const [sid, textOrFile] = args;
    const text = existsSync(textOrFile) && textOrFile.endsWith(".md") ? readFileSync(textOrFile, "utf-8") : textOrFile;
    frame = { command_id: cid, type: "COMMAND_MESSAGE", payload: { session_id: sid, text } };
  } else if (op === "stop") frame = { command_id: cid, type: "COMMAND_STOP", payload: { session_id: args[0] } };
  else if (op === "delete") frame = { command_id: cid, type: "COMMAND_DELETE", payload: { session_id: args[0] } };
  else { console.error("未知操作:", op); process.exit(1); }
  ws.send(JSON.stringify(frame));
});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "COMMAND_ACK") {
    clearTimeout(timeout);
    console.log(JSON.stringify(m));
    if (m.session_id) console.log("SESSION_ID:" + m.session_id);
    ws.close(); process.exit(m.ok ? 0 : 3);
  }
});
ws.on("error", (e) => { console.error("WS-ERR:", e.message); process.exit(2); });
