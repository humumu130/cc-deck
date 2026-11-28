// DEV-43 演练见证客户端：以独立 dev 连生产 CF 桥，收 bridge_alert 帧并打时间戳
// （手机 App 0.6.3 无本帧处理器、且当前离线——见证端代收=协议层投递证据）。
// 用法：node drill-witness.mjs <dev-id> [seconds]
import WebSocket from "ws";

const dev = process.argv[2] || "ph-dev43drill01";
const secs = Number(process.argv[3] || 300);
const ws = new WebSocket(`wss://cc.humumu.online/cloud?token=ccdeck-public-9f3k2m7v&dev=${dev}`);
const t0 = Date.now();
ws.on("open", () => console.log(`[${new Date().toISOString()}] WITNESS-OPEN dev=${dev}`));
ws.on("error", (e) => console.log(`[${new Date().toISOString()}] WITNESS-ERROR ${e.message}`));
ws.on("close", (c, r) => console.log(`[${new Date().toISOString()}] WITNESS-CLOSE ${c} ${String(r)}`));
ws.on("message", (data) => {
  const s = String(data);
  try {
    const f = JSON.parse(s);
    if (f.type === "bridge_alert") {
      console.log(`[${new Date().toISOString()}] WITNESS-ALERT-RECEIVED +${Date.now() - t0}ms title="${f.title}" body="${f.body}" level=${f.level} ts=${f.ts} latency_since_frame_ts=${Date.now() - f.ts}ms`);
    } else {
      console.log(`[${new Date().toISOString()}] WITNESS-FRAME type=${f.type ?? "?"} (non-alert, ignored)`);
    }
  } catch {
    console.log(`[${new Date().toISOString()}] WITNESS-RAW ${s.slice(0, 80)}`);
  }
});
setTimeout(() => { ws.close(); process.exit(0); }, secs * 1000);
