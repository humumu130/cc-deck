// 生成网页端（公司电脑）云桥配对链接：
//   npx tsx scripts/pair-web.ts
// 流程：向本机 relay POST /api/pair-code 领一次性码，读取 relay 云身份，
// 拼出 <云桥>/#bt=…&rd=…&rk=…&pc=… 的一键配对 URL（参数走 URL fragment，
// 不落服务器日志）。网页打开后自动完成配对并连接。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";

const cfg = loadConfig();
// 本脚本常在 relay 进程外运行（无 start-relay.bat 注入的环境变量），
// 云桥配置回退读 data/ 下由部署流程维护的两个文件
if (!cfg.cloudUrl && existsSync(join(cfg.dataDir, "cloud-url.txt"))) {
  cfg.cloudUrl = readFileSync(join(cfg.dataDir, "cloud-url.txt"), "utf-8").trim();
}
if (!cfg.cloudToken && existsSync(join(cfg.dataDir, "cloud-bridge-token.txt"))) {
  cfg.cloudToken = readFileSync(join(cfg.dataDir, "cloud-bridge-token.txt"), "utf-8").trim();
}
if (!cfg.cloudUrl || !cfg.cloudToken) {
  console.error("未启用云桥（CCR_CLOUD_URL / CCR_CLOUD_TOKEN 未设置，data/ 下也无回退文件）");
  process.exit(1);
}
if (cfg.tokenGenerated) {
  // relay 由 start-relay.bat 注入 CCR_TOKEN；脚本外跑时用已知默认值试一下
  cfg.token = process.env.CCR_TOKEN_HINT ?? "devtoken";
}

const res = await fetch(`http://127.0.0.1:${cfg.port}/api/pair-code?token=${encodeURIComponent(cfg.token)}`, {
  method: "POST",
});
if (!res.ok) {
  console.error(`领码失败: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { code, expires_in } = (await res.json()) as { code: string; expires_in: number };

const identity = loadOrCreateIdentity(cfg.dataDir);
const httpBase = cfg.cloudUrl.replace(/^ws/, "http").replace(/\/cloud$/, "");
const frag = [
  "bt=" + encodeURIComponent(cfg.cloudToken),
  "rd=" + encodeURIComponent(identity.relayDev),
  "rk=" + encodeURIComponent(identity.keypair.publicKey),
  "pc=" + encodeURIComponent(code),
].join("&");

console.log(`配对链接（${Math.floor(expires_in / 60)} 分钟内有效，一次性）：`);
console.log(`${httpBase}/#${frag}`);
