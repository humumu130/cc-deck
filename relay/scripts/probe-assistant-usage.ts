// #72 探针 v2：深挖 stream_event 与 assistant.context_management 里的可用水位信号
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, rmSync } from "node:fs";
import { resolveClaudeCliPath } from "../src/cli-path.js";

const CWD = "/tmp/probe-usage-dir";
rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

const cliPath = resolveClaudeCliPath();
if (!cliPath) {
  console.log("未找到 claude CLI");
  process.exit(1);
}

const q = query({
  prompt: "只回复两个字：收到",
  options: {
    model: "glm-5.3",
    cwd: CWD,
    pathToClaudeCodeExecutable: cliPath,
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
  },
});

for await (const msg of q) {
  const t = (msg as { type?: string }).type;
  if (t === "assistant") {
    const m = (msg as { message?: Record<string, unknown> }).message ?? {};
    const contentTypes = Array.isArray(m.content)
      ? (m.content as Record<string, unknown>[]).map((b) => b.type).join(",")
      : String(m.content).slice(0, 40);
    console.log(`[assistant] blocks=${contentTypes} stop=${m.stop_reason}`);
    console.log(`  usage=${JSON.stringify(m.usage)}`);
    console.log(`  context_management=${JSON.stringify(m.context_management)}`);
  } else if (t === "stream_event") {
    const ev = (msg as { event?: Record<string, unknown> }).event ?? {};
    const et = (ev.type as string) ?? "?";
    if (et === "message_start" || et === "message_delta" || et === "message_stop") {
      // 这三类最可能带 usage：打印整个事件（剔除超长 delta 文本）
      const clone: Record<string, unknown> = { ...ev };
      if (clone.delta && typeof clone.delta === "object") {
        clone.delta = { ...(clone.delta as object) };
        const d = clone.delta as Record<string, unknown>;
        if (typeof d.text === "string") d.text = `<${d.text.length}字>`;
        if (typeof d.thinking === "string") d.thinking = `<${d.thinking.length}字>`;
        if (typeof d.partial_json === "string") d.partial_json = `<json>`;
      }
      if (clone.message && typeof clone.message === "object") {
        clone.message = { ...(clone.message as object) };
        const mm = clone.message as Record<string, unknown>;
        if (Array.isArray(mm.content)) mm.content = `<blocks:${(mm.content as unknown[]).length}>`;
      }
      console.log(`[stream:${et}] ${JSON.stringify(clone)}`);
    }
  } else if (t === "result") {
    console.log(`[result] usage=${JSON.stringify((msg as { usage?: unknown }).usage)}`);
  }
}
rmSync(CWD, { recursive: true, force: true });
process.exit(0);
