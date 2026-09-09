// SNAPSHOT 帧大小实测（诊断脚本，只读）：连运行中的 relay（LAN 信道），测
// SNAPSHOT 单帧字节数与随后的帧分布。不发送任何命令。
// 用法: node scripts/measure-snapshot.mjs [token] [port]  （token 缺省读 data/token）
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const token = process.argv[2] || readFileSync(new URL("../data/token", import.meta.url), "utf-8").trim();
const port = process.argv[3] ?? "8787";

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}&last_seq=0`);
const t0 = Date.now();
let frames = 0;
let bytes = 0;
const sizes = [];
const byType = new Map();
let timer = null;

ws.on("open", () => console.log(`connected, measuring frames...`));
ws.on("message", (data) => {
  const s = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  frames++;
  bytes += s;
  let type = "?";
  try {
    const o = JSON.parse(String(data));
    type = o.type ?? "?";
  } catch {}
  const e = byType.get(type) ?? { n: 0, bytes: 0, max: 0 };
  e.n++; e.bytes += s; e.max = Math.max(e.max, s);
  byType.set(type, e);
  if (type === "SNAPSHOT") {
    console.log(`SNAPSHOT frame: ${s} bytes (${(s / 1024).toFixed(1)} KiB)`);
    const o = JSON.parse(String(data));
    const p = o.payload ?? {};
    const sessions = p.sessions ?? [];
    const logs = p.logs ?? {};
    const sessionsBytes = Buffer.byteLength(JSON.stringify(sessions));
    const logsBytes = Buffer.byteLength(JSON.stringify(logs));
    const logCounts = Object.entries(logs).map(([k, v]) => `${k.slice(0, 12)}:${v.length}`);
    console.log(`  sessions: ${sessions.length} 个, ${sessionsBytes} bytes (${(sessionsBytes / 1024).toFixed(1)} KiB)`);
    console.log(`  logs inline: ${Object.keys(logs).length} 会话, ${logsBytes} bytes (${(logsBytes / 1024).toFixed(1)} KiB)`);
    console.log(`  每会话日志条数: ${logCounts.join(" ")}`);
    const todos = sessions.map((x) => `${x.session_id.slice(0, 10)} todos=${x.todos?.length ?? 0} (${Buffer.byteLength(JSON.stringify(x.todos ?? []))}B)`);
    console.log(`  每会话 todos: ${todos.join(" | ")}`);
  }
  sizes.push(s);
  // 500ms 静默即收工
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`\n=== 汇总（${((Date.now() - t0) / 1000).toFixed(1)}s）===`);
    console.log(`frames=${frames} total=${(bytes / 1024).toFixed(1)} KiB max_frame=${Math.max(...sizes)} bytes`);
    for (const [t, e] of byType) console.log(`  ${t}: n=${e.n} total=${(e.bytes / 1024).toFixed(1)}KiB max=${e.max}B`);
    ws.close();
    process.exit(0);
  }, 500);
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
