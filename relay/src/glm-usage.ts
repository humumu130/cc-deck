import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";

// GLM 用量看板（2026-09-26 手机端固化）：GET /glm-usage 出 ~/.cc-deck/tools/ 下的
// 自包含看板页（tools 版为单一事实源，桌面 glmusage / LAN 路由 / KV 云页共用）。
// token 每次请求实时读 ~/.claude/settings.json，以 window.__GLM_INJECT__ 烙进
// </head> 前——手机在家庭网零配置打开即查，token 轮换后刷新即是新值。页面自身
// 直连 open.bigmodel.cn monitor API（该 API 对任意 Origin 回显放行 CORS，已实证），
// 不经 relay 转发。外网场景走 KV 云页 cc.humumu.online/view/glm-usage.html（无
// token），由本页「外网版」按钮经 URL hash 单次授予到手机 localStorage。

const DASHBOARD_PATH = join(homedir(), ".cc-deck", "tools", "glm-usage-dashboard.html");

function readGlmCfg(): { host: string; token: string } | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"),
    ) as { env?: Record<string, unknown> };
    const env = raw.env ?? {};
    const token = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN : "";
    if (!token) return null;
    const base = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "";
    const host = base.includes("api.z.ai") ? "https://api.z.ai" : "https://open.bigmodel.cn";
    return { host, token };
  } catch {
    return null;
  }
}

export function serveGlmUsagePage(res: ServerResponse): boolean {
  let html: string;
  try {
    html = readFileSync(DASHBOARD_PATH, "utf8");
  } catch {
    return false;
  }
  const cfg = readGlmCfg();
  if (cfg) {
    // 置换首个 </head>（页面仅一处）；JSON.stringify 产出合法内联对象字面量
    html = html.replace(
      "</head>",
      `<script>window.__GLM_INJECT__=${JSON.stringify(cfg)};</script>\n</head>`,
    );
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
  return true;
}
