// 冒烟用假 relay：只应答 /local-info（electron 主进程探测目标）。
// 端口被占（本机有真 relay 在跑）则静默退出——真 relay 接管探测，冒烟照常成立
import { createServer } from "node:http";

const srv = createServer((req, res) => {
  if (req.url?.startsWith("/local-info")) {
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": req.headers.origin ?? "*",
      "cache-control": "no-store",
    }).end(JSON.stringify({ ok: true, port: 8787, token: "smoke-token" }));
    return;
  }
  res.writeHead(404).end();
});
srv.on("error", () => process.exit(0));
srv.listen(8787, "127.0.0.1", () => console.log("[smoke-server] :8787"));
