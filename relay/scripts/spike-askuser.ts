// 实验：AskUserQuestion 在 headless SDK 下的作答机制验证（任务 #55 风险点）。
// 用法: npx tsx scripts/spike-askuser.ts <allow-plain|allow-answers|deny-msg|message>
// 观察点：① AskUserQuestion 是否触发 canUseTool ② 各机制下 tool_result 内容
// ③ 模型是否把"用户的选择"当成答案继续任务
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../src/agent-adapter.js";

const mechanism = process.argv[2] ?? "allow-plain";
const ANSWER = "炒面";

const queue = new AsyncQueue<Parameters<typeof query>[0] extends never ? never : any>();
queue.push({
  type: "user",
  message: { role: "user", content: "请用 AskUserQuestion 工具问我：今晚吃什么？给三个选项（火锅/炒面/沙拉），用中文 header。问完停下等我选。" },
  parent_tool_use_id: null,
  origin: { kind: "human" },
});

let pendingResolve: ((r: PermissionResult) => void) | null = null;
let askInput: Record<string, unknown> | null = null;

const q = query({
  prompt: queue.iterable as any,
  options: {
    model: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    cwd: process.cwd(),
    permissionMode: "default",
    canUseTool: (toolName, input, opts) => {
      console.log(`\n[canUseTool] tool=${toolName} requestId=${(opts as any).requestId}`);
      if (toolName !== "AskUserQuestion") {
        console.log("[canUseTool] 非 AskUserQuestion，直接 allow");
        return Promise.resolve({ behavior: "allow", updatedInput: input } as PermissionResult);
      }
      askInput = input;
      console.log(`[canUseTool] input=${JSON.stringify(input)}`);
      return new Promise<PermissionResult>((resolve) => {
        pendingResolve = resolve;
        setTimeout(() => {
          if (!pendingResolve) return;
          console.log(`\n=== 机制 ${mechanism}: 触发 ===`);
          const label = (i: number) => {
            const qs = (input as any).questions ?? [];
            return qs[0]?.options?.[i]?.label ?? ANSWER;
          };
          switch (mechanism) {
            case "allow-plain":
              resolve({ behavior: "allow", updatedInput: input });
              break;
            case "allow-answers": {
              // 猜测形状：input.questions[i].answers = [label]
              const modified = JSON.parse(JSON.stringify(input));
              modified.questions = modified.questions.map((qq: any) => ({ ...qq, answers: [ANSWER] }));
              resolve({ behavior: "allow", updatedInput: modified });
              break;
            }
            case "deny-msg":
              resolve({ behavior: "deny", message: `用户选择了「${ANSWER}」`, interrupt: false });
              break;
            case "message":
              // 不 resolve permission，改推一条用户消息
              queue.push({
                type: "user",
                message: { role: "user", content: `我选：${ANSWER}` },
                parent_tool_use_id: null,
                origin: { kind: "human" },
              });
              break;
          }
          pendingResolve = null;
        }, 1500);
      });
    },
    stderr: (s) => process.stderr.write(`[sdk-stderr] ${s}`),
  },
});

const timeout = setTimeout(() => {
  console.log("\n[timeout] 120s 到，强制结束");
  process.exit(2);
}, 120_000);

for await (const msg of q) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log(`[init] model=${msg.model}`);
  } else if (msg.type === "assistant") {
    for (const b of msg.message.content) {
      if (b.type === "text") console.log(`[assistant:text] ${b.text}`);
      else if (b.type === "tool_use") console.log(`[assistant:tool_use] ${b.name} input=${JSON.stringify(b.input).slice(0, 300)}`);
    }
  } else if (msg.type === "user") {
    const c = msg.message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "tool_result") {
          console.log(`[user:tool_result] is_error=${(b as any).is_error} content=${JSON.stringify((b as any).content).slice(0, 500)}`);
        }
      }
    }
  } else if (msg.type === "result") {
    console.log(`[result] subtype=${msg.subtype} is_error=${msg.is_error} result=${String((msg as any).result).slice(0, 200)}`);
  }
}
clearTimeout(timeout);
console.log("\n[spike-askuser] DONE");
process.exit(0);
