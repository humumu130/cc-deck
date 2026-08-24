// 会话自动命名：首条 prompt -> 一次轻量模型调用生成短标题
// （本机 CC 自己的 session name 生成在 GLM 环境基本不触发，Relay 兜底）
import { query } from "@anthropic-ai/claude-agent-sdk";

export async function generateTitle(task: string, model: string): Promise<string | null> {
  const trimmed = task.trim().slice(0, 600);
  if (!trimmed) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 20_000);
    timer.unref();
  });
  try {
    const run = async (): Promise<string | null> => {
      const q = query({
        prompt:
          "为下面的任务起一个简短的中文标题，不超过 12 个字，直接输出标题本身，不要引号和任何解释：\n\n" +
          trimmed,
        options: {
          model,
          cwd: process.cwd(),
          permissionMode: "bypassPermissions",
          maxTurns: 1,
        },
      });
      for await (const msg of q) {
        if (msg.type === "result" && !msg.is_error) {
          const raw = ((msg as { result?: string }).result ?? "").trim();
          const t = raw.replace(/^["'「『]|["'」』]$/g, "").split("\n")[0].trim();
          if (t) return [...t].slice(0, 16).join("");
        }
      }
      return null;
    };
    return await Promise.race([run(), timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
