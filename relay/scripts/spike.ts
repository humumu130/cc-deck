import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("[spike] parent env:", {
    base: process.env.ANTHROPIC_BASE_URL ?? "unset",
    sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "unset",
  });

  const explicitModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  console.log(`[spike] explicit model option: ${explicitModel}`);

  const q = query({
    prompt: "你好。请只回复一行文字：报告你当前使用的模型名称，不要做任何其他事。",
    options: {
      model: explicitModel,
      cwd: process.cwd(),
      permissionMode: "default",
      stderr: (s) => process.stderr.write(`[sdk-stderr] ${s}\n`),
    },
  });

  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      console.log(`[init] model=${msg.model} session_id=${msg.session_id}`);
    } else if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") console.log(`[assistant] ${block.text}`);
      }
    } else if (msg.type === "result") {
      console.log(`[result] subtype=${msg.subtype} duration=${msg.duration_ms}ms`);
      console.log(`[result] modelUsage=${JSON.stringify(msg.modelUsage)}`);
    }
  }
  console.log("[spike] PASS");
}

main().catch((e) => {
  console.error("[spike] FAILED:", e);
  process.exit(1);
});
