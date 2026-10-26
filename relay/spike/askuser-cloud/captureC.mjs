// #273 变体 C：验证「canUseTool deny-message 作答 → CLI 继续」在 CLI 2.1.241 + GLM 是否成立
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { query } from "/Users/xdd/dev/cc-deck/relay/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

mkdirSync("/tmp/w273/wireC", { recursive: true });
const W = (name, obj) => appendFileSync(`/tmp/w273/wireC/${name}.jsonl`, JSON.stringify(obj) + "\n");

const PROMPT = "请立刻调用 AskUserQuestion 工具问我一个问题：header 用「午餐」，question 用「今天吃什么？」，选项 label 为 饺子 / 面条（每个带一句 description）。拿到我的选择后，仅回复你选中的那个 label，不要做别的任何事。";

const timeout = setTimeout(() => { console.error("HARNESS_TIMEOUT_120s"); process.exit(3); }, 120_000);

const q = query({
  prompt: PROMPT,
  options: {
    permissionMode: "bypassPermissions",
    model: process.env.W273_MODEL,
    canUseTool: async (toolName, input, o) => {
      W("canusetool", { at: Date.now(), toolName, requestId: o?.requestId, toolUseID: o?.toolUseID });
      if (toolName === "AskUserQuestion") {
        return { behavior: "deny", message: "用户回答：「饺子」", interrupt: false };
      }
      return { behavior: "allow", updatedInput: input };
    },
    maxTurns: 4,
    cwd: "/tmp/w273",
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
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.trim()) W("stdout", { at: Date.now(), line });
        }
      });
      console.error(`SPAWN pid=${child.pid}`);
      return child;
    },
  },
});

let finalText = "";
for await (const msg of q) {
  W("stream", { at: Date.now(), type: msg.type, subtype: msg.subtype ?? null,
    preview: (msg.type === "assistant") ? JSON.stringify(msg).slice(0, 800) : JSON.stringify(msg).slice(0, 300) });
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) if (b.type === "text" && b.text) finalText = b.text;
  }
  if (msg.type === "result") {
    clearTimeout(timeout);
    console.error(`RESULT subtype=${msg.subtype} is_error=${msg.is_error} turns=${msg.num_turns}`);
    console.error(`FINAL_TEXT=${finalText.slice(0, 200)}`);
  }
}
console.error("DONE");
