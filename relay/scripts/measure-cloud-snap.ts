// 只读测量（W-CLOUD①）：生产 events.ndjson 重放 → 云端 SNAPSHOT 载荷实际字节。
// 假设检验：重启后手机 hello(last_seq=0) → 全量 SNAPSHOT 超 CF 桥单帧限被丢 →
// 手机收不到 → 反复裸 hello 循环（relay-service.log 实锤 last_seq=0 连环）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEvents, compactEvents, reduceHistory } from "../src/history.js";
import { SessionManager } from "../src/session-manager.js";
import { EventBus } from "../src/event-bus.js";
import { loadConfig } from "../src/config.js";

const persistPath = join(homedir(), ".cc-deck", "data", "events.ndjson");
const prior = loadEvents(persistPath);
const kept = compactEvents(prior);
const bus = new EventBus();
const cfg = loadConfig();
const mgr = new SessionManager(bus, cfg);
mgr.adopt(reduceHistory(kept));

const snapLogs = mgr.buildSnapshotLogs(); // 云端默认（512KB/50）
const sessions = mgr.snapshot();
const payload = {
  sessions,
  logs: snapLogs.logs,
  ...(Object.keys(snapLogs.logs_truncated).length ? { logs_truncated: snapLogs.logs_truncated } : {}),
  server_time: Date.now(),
  homedir: homedir(),
  platform: process.platform,
};
const json = JSON.stringify({ seq: 1, session_id: "", ts: Date.now(), type: "SNAPSHOT", payload });
const sealed = Buffer.from(json, "utf-8").toString("base64"); // E2E 密封近似膨胀（+33%）
console.log(`sessions=${sessions.length} logs_total=${Object.values(snapLogs.logs).reduce((a, b) => a + b.length, 0)} truncated_sessions=${Object.keys(snapLogs.logs_truncated).length}`);
console.log(`plain JSON = ${(json.length / 1024).toFixed(0)} KB`);
console.log(`base64 sealed ≈ ${(sealed.length / 1024).toFixed(0)} KB  (CF 桥限 ~1MiB=1024KB)`);
console.log(`超限 = ${sealed.length > 1024 * 1024 ? "YES ← 手机收不到的根因" : "no"}`);
