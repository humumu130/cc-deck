import { randomUUID } from "node:crypto";

// 云桥无状态：token 应由部署环境固定（env），未设置则每次启动随机生成
// 并打印（仅本机试用——所有客户端都要带同一个 token 连接）。
export interface CloudConfig {
  port: number;
  token: string;
}

export function loadConfig(): CloudConfig {
  const port = Number(process.env.CLOUD_PORT ?? 8790) || 8790;
  let token = process.env.CLOUD_TOKEN ?? "";
  if (token.length < 8) {
    token = randomUUID().replace(/-/g, "");
    console.log(`[cloud-bridge] CLOUD_TOKEN 未设置或过短，本次随机生成: ${token}`);
  }
  return { port, token };
}
