import { randomUUID } from "node:crypto";

// 云桥无状态：token 应由部署环境固定（env），未设置则每次启动随机生成
// 并打印（仅本机试用——所有客户端都要带同一个 token 连接）。
export interface CloudConfig {
  port: number;
  extraPorts: number[]; // 附加监听端口。公司网络常只放行 80/443，可同时听多个（逗号分隔）
  token: string;
  // T1a 租户地基（PRD §4.4/§4.5）：CLOUD_ADMIN_KEY 在场=租户层开启（桥主面+登录
  // 流+过滤六触点）；缺省=纯配对模型现状零差异（渐进开关 §5）
  adminKey?: string;
  tenantDbPath?: string; // 名册文件（缺省 <cwd>/data/tenants.json）
}

export function loadConfig(): CloudConfig {
  const port = Number(process.env.CLOUD_PORT ?? 8790) || 8790;
  const extraPorts = (process.env.CLOUD_EXTRA_PORT ?? "")
    .split(",")
    .map((s) => Number(s.trim()) || 0)
    .filter((p) => p > 0);
  let token = process.env.CLOUD_TOKEN ?? "";
  if (token.length < 8) {
    token = randomUUID().replace(/-/g, "");
    console.log(`[cloud-bridge] CLOUD_TOKEN 未设置或过短，本次随机生成: ${token}`);
  }
  const adminKey = process.env.CLOUD_ADMIN_KEY && process.env.CLOUD_ADMIN_KEY.length >= 16 ? process.env.CLOUD_ADMIN_KEY : undefined;
  if (process.env.CLOUD_ADMIN_KEY && !adminKey) {
    console.log("[cloud-bridge] CLOUD_ADMIN_KEY 过短（<16），租户层未开启");
  }
  return {
    port, extraPorts, token,
    adminKey,
    tenantDbPath: process.env.CLOUD_TENANT_DB,
  };
}
