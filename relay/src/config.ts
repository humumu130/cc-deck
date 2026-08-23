import { randomUUID } from "node:crypto";

export interface RelayConfig {
  port: number;
  token: string;
  tokenGenerated: boolean;   // true = 本次运行随机生成，启动时打印
  defaultCwd: string;
  model: string;
}

export function loadConfig(): RelayConfig {
  const port = Number(process.env.CCR_PORT ?? 8787);
  const envToken = process.env.CCR_TOKEN;
  const token = envToken && envToken.length >= 8 ? envToken : randomUUID().replace(/-/g, "");
  const defaultCwd = process.env.CCR_CWD ?? process.cwd();
  // spike 结论：必须显式指定 model，否则 CLI 会给默认模型名拼 [1m] 后缀
  const model =
    process.env.CCR_MODEL ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "glm-5.3";
  return { port, token, tokenGenerated: !envToken, defaultCwd, model };
}
