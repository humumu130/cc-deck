import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RelayConfig {
  port: number;
  token: string;
  tokenGenerated: boolean;   // true = 本次运行随机生成，启动时打印
  defaultCwd: string;
  model: string;
  bridgeToken: string;       // hooks 桥接令牌（data/bridge-token，首启生成后固定）
  dataDir: string;
  cloudUrls: string[];       // 云桥地址列表（CCR_CLOUD_URL 逗号分隔），空 = 云桥禁用
  cloudUrl: string;          // 主桥（首地址）：PAIR_ACK 下发给新配对设备
  cloudToken: string;        // 云桥层连接 token（CCR_CLOUD_TOKEN，所有桥共用）
}

export function loadConfig(): RelayConfig {
  const port = Number(process.env.CCR_PORT ?? 8787);
  // 插件 bundle（CC_DECK_PLUGIN 由 esbuild define 注入）数据固定 ~/.cc-deck/data，
  // 与插件升级/卸载解耦；开发模式默认 relay/data
  const dataDir =
    process.env.CCR_DATA_DIR ??
    ((process.env.CC_DECK_PLUGIN as string | undefined)
      ? join(homedir(), ".cc-deck", "data")
      : join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });

  const envToken = process.env.CCR_TOKEN;
  // 插件/daemon 形态没有外部传 token：data/token 持久化（首启生成，重启不变，手机不用重配）
  const tokenFile = join(dataDir, "token");
  let token: string;
  if (envToken && envToken.length >= 8) {
    token = envToken;
  } else if (existsSync(tokenFile)) {
    token = readFileSync(tokenFile, "utf-8").trim();
  } else {
    token = randomUUID().replace(/-/g, "");
    writeFileSync(tokenFile, token, "utf-8");
  }
  const defaultCwd = process.env.CCR_CWD ?? process.cwd();
  // spike 结论：必须显式指定 model，否则 CLI 会给默认模型名拼 [1m] 后缀
  const model =
    process.env.CCR_MODEL ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "glm-5.3";

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

  // 多桥并行：逗号分隔多个地址（如 CF wss + ECS ws），每桥一个 CloudClient 实例；
  // 首地址为主桥（PAIR_ACK 下发给新配对手机的地址）
  const cloudUrls = (process.env.CCR_CLOUD_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cloudToken = process.env.CCR_CLOUD_TOKEN ?? "";

  return {
    port, token, tokenGenerated: !envToken, defaultCwd, model, bridgeToken, dataDir,
    cloudUrls, cloudUrl: cloudUrls[0] ?? "", cloudToken,
  };
}
