// #273 协议实测 harness：SDK 起 CLI 触发 AskUserQuestion，tee 裸 stdin/stdout 抓 control 协议报文对
// 运行：CCR_RELAY_CHILD=1 node /tmp/w273/capture.mjs <resultGuess>
//   resultGuess: allow（PermissionResult.allow+updatedInput）| answers（{answers:[...]}）| cancel（{behavior:"cancelled"}）
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { query } from "/Users/xdd/dev/cc-deck/relay/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

const guess = process.argv[2] || "allow";
mkdirSync("/tmp/w273/wire", { recursive: true });
const W = (name, obj) => appendFileSync(`/tmp/w273/wire/${name}.jsonl`, JSON.stringify(obj) + "\n");

const PROMPT = "请立刻调用 AskUserQuestion 工具问我一个问题：header 用「午餐」，question 用「今天吃什么？」，选项 label 为 饺子 / 面条（每个带一句 description）。拿到我的选择后，仅回复你选中的那个 label，不要做别的任何事。";

function answerFor(req) {
  if (guess === "cancel") return { behavior: "cancelled" };
  if (guess === "answers") return { behavior: "completed", result: { answers: ["饺子"] } };
  // guess === "allow"：PermissionResult 形态，updatedInput 带 choices
  const input = req.payload?.input ?? req.payload;
  const updated = { ...input, choices: undefined };
  delete updated.choices;
  return { behavior: "completed", result: { behavior: "allow", updatedInput: { ...input, _answers: ["饺子"] } } };
}

let dialogReq = null;
const timeout = setTimeout(() => {
  console.error("TIMEOUT_NO_DIALOG_90s");
  process.exit(3);
}, 90_000);

const q = query({
  prompt: PROMPT,
  options: {
    permissionMode: "bypassPermissions",
    maxTurns: 4,
    cwd: "/tmp/w273",
    supportedDialogKinds: ["permission_ask_user_question"],
    spawnClaudeCodeProcess: (o) => {
      const child = spawn(o.command, o.args, { stdio: ["pipe", "pipe", "pipe"], cwd: o.cwd, env: o.env, signal: o.signal });
      const origWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        for (const line of String(chunk).split("\n")) if (line.trim()) W("stdin", { at: Date.now(), line });
        return origWrite(chunk, ...rest);
      };
      child.stdout.setEncoding("utf8");
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) W("stdout", { at: Date.now(), line });
        }
      });
      console.error(`SPAWN pid=${child.pid} cmd=${o.command}`);
      return child;
    },
    onUserDialog: async (req, o) => {
      dialogReq = req;
      clearTimeout(timeout);
      W("dialog", { at: Date.now(), req, opts: { ...o } });
      console.error("DIALOG_REQ_KIND=" + req.dialogKind);
      console.error("DIALOG_PAYLOAD=" + JSON.stringify(req.payload));
      const ans = answerFor(req);
      W("dialog_answer", { at: Date.now(), guess, ans });
      return ans;
    },
  },
});

let sawResult = false;
for await (const msg of q) {
  W("stream", { at: Date.now(), type: msg.type, subtype: msg.subtype ?? null, preview: JSON.stringify(msg).slice(0, 400) });
  if (msg.type === "result") { sawResult = true; console.error("RESULT_SUBTYPE=" + (msg.subtype ?? "success")); }
}
console.error(`DONE sawResult=${sawResult} dialog=${dialogReq ? dialogReq.dialogKind : "none"}`);
