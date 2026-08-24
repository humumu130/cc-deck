import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RelayConfig {
  port: number;
  token: string;
  tokenGenerated: boolean;   // true = 本次运行随机生成，启动时打印
  defaultCwd: string;
  model: string;
  bridgeToken: string;       // hooks 桥接令牌（data/bridge-token，首启生成后固定）
  dataDir: string;
  cloudUrl: string;          // 云桥地址（CCR_CLOUD_URL），空 = 云桥禁用
  cloudToken: string;        // 云桥层连接 token（CCR_CLOUD_TOKEN）
}

export function loadConfig(): RelayConfig {
  const port = Number(process.env.CCR_PORT ?? 8787);
  const envToken = process.env.CCR_TOKEN;
  const token = envToken && envToken.length >= 8 ? envToken : randomUUID().replace(/-/g, "");
  const defaultCwd = process.env.CCR_CWD ?? process.cwd();
  // spike 结论：必须显式指定 model，否则 CLI 会给默认模型名拼 [1m] 后缀
  const model =
    process.env.CCR_MODEL ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "glm-5.3";

  const dataDir = join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  let bridgeToken = process.env.CCR_BRIDGE_TOKEN ?? "";
  const bridgeTokenPath = join(dataDir, "bridge-token");
  if (!bridgeToken) {
    if (existsSync(bridgeTokenPath)) {
      bridgeToken = readFileSync(bridgeTokenPath, "utf-8").trim();
    } else {
      bridgeToken = randomUUID().replace(/-/g, "");
      writeFileSync(bridgeTokenPath, bridgeToken, "utf-8");
    }
  }

  const cloudUrl = process.env.CCR_CLOUD_URL ?? "";
  const cloudToken = process.env.CCR_CLOUD_TOKEN ?? "";

  return {
    port, token, tokenGenerated: !envToken, defaultCwd, model, bridgeToken, dataDir,
    cloudUrl, cloudToken,
  };
}
