// 会话自动命名：首条 prompt -> 一次轻量模型调用生成短标题
// （本机 CC 自己的 session name 生成在 GLM 环境基本不触发，Relay 兜底）
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCliPath } from "./cli-path.js";

// 返回 title + 本次一次性 SDK 会话的 session_id（其 transcript 须被孤儿扫描排除，防误收养）；
// onSid 在拿到首条消息（含 session_id）时立刻回调——不等 result，防 20s 超时把 sid 一起丢了
export async function generateTitle(
  task: string,
  model: string,
  onSid?: (sid: string) => void,
  cwd?: string,
  configHome?: string,
): Promise<{ title: string | null; sid?: string }> {
  const trimmed = task.trim().slice(0, 600);
  if (!trimmed) return { title: null };
  let timer: NodeJS.Timeout | undefined;
  let sidSeen = false;
  const timeout = new Promise<{ title: null }>((resolve) => {
    timer = setTimeout(() => resolve({ title: null }), 20_000);
    timer.unref();
  });
  try {
    const run = async (): Promise<{ title: string | null; sid?: string }> => {
      const q = query({
        prompt:
          "为下面的任务起一个简短的中文标题，不超过 12 个字，直接输出标题本身，不要引号和任何解释：\n\n" +
          trimmed,
        options: {
          model,
          // 专用 .tmp- 目录：transcript 不落用户项目区（.tmp- 前缀段被孤儿扫描/事件护栏
          // 排除，#283——此前 cwd=relay 进程目录，被收养成"relay"垃圾会话）
          cwd: cwd ?? process.cwd(),
          // bundle 部署下 SDK 找不到包内平台二进制——标题生成尽力而为，解析失败静默放弃
          ...(resolveClaudeCliPath() ? { pathToClaudeCodeExecutable: resolveClaudeCliPath()! } : {}),
          // 防止被全局 bridge hook 注册成外部会话；#17 开关开启时 titlegen 一次性
          // 会话落独立家（relay 内部工具会话，不区分归属——默认家不再冒 .tmp-titlegen 目录）
          env: {
            ...process.env,
            CCR_RELAY_CHILD: "1",
            ...(configHome ? { CLAUDE_CONFIG_DIR: configHome } : {}),
          },
          permissionMode: "bypassPermissions",
          maxTurns: 1,
        },
      });
      for await (const msg of q) {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && !sidSeen) {
          sidSeen = true;
          onSid?.(sid);
        }
        if (msg.type === "result" && !msg.is_error) {
          const raw = ((msg as { result?: string }).result ?? "").trim();
          const t = raw.replace(/^["'「『]|["'」』]$/g, "").split("\n")[0].trim();
          if (t) return { title: [...t].slice(0, 16).join(""), sid };
          if (sid) return { title: null, sid };
        }
      }
      return { title: null };
    };
    return await Promise.race([run(), timeout]);
  } catch {
    return { title: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
