// [W-LINKQUALITY]（t-d1edf363，1104 用户实锤×N）链路分段遥测+提速断言。
//   A 账本纯函数：appendLinkEvent 落盘/坏行跳过/窗口过滤；linkSummary P50 线性插值/
//     单样本=唯一真值（恒真禁用——不造 0）/dropsBySrc/avgAttempts
//   B 断连注入（验收 1 记账半边）：drop→reconnect 序列落账→分段定罪可判
//   C 端上反馈+提速文本锚（web/RN 闭包不可直跑——005 壳文本锚范式）
//   D 端点收口（白名单/越界拒——与 ws-server 处理段同逻辑直证）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLinkEvent, linkSummary, linkLogPath, type LinkEventRow } from "../src/link-quality.js";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main(): Promise<void> {
  console.log("A 账本纯函数:");
  const DIR = mkdtempSync(join(tmpdir(), "ccr-linkq-"));
  const now = Date.now();
  appendLinkEvent(DIR, { ts: now - 3600_000, src: "web-lan", kind: "drop", reason: "close", code: 1006, connectedMs: 120_000 });
  appendLinkEvent(DIR, { ts: now - 3500_000, src: "web-lan", kind: "reconnect", downtimeMs: 9000, attempts: 3 });
  appendLinkEvent(DIR, { ts: now - 3000_000, src: "web-cloud", kind: "drop", reason: "close-1006", code: 1006 });
  appendLinkEvent(DIR, { ts: now - 2900_000, src: "web-cloud", kind: "reconnect", downtimeMs: 4200, attempts: 2 });
  appendLinkEvent(DIR, { ts: now - 2000_000, src: "bridge", kind: "drop", reason: "heartbeat-timeout", connectedMs: 600_000 });
  appendLinkEvent(DIR, { ts: now - 1900_000, src: "bridge", kind: "reconnect", downtimeMs: 15000 });
  appendLinkEvent(DIR, { ts: now - 1000_000, src: "rn", kind: "drop", reason: "net-drop: 云桥断开", connectedMs: 90_000 });
  appendLinkEvent(DIR, { ts: now - 900_000, src: "rn", kind: "reconnect", downtimeMs: 2600, attempts: 1 });
  appendLinkEvent(DIR, { ts: now - 500_000, src: "web-lan", kind: "drop", reason: "close", code: 1001 });
  appendLinkEvent(DIR, { ts: now - 48 * 3600_000, src: "web-lan", kind: "drop", reason: "stale" });
  writeFileSync(linkLogPath(DIR), "not-json\n", { flag: "a" });
  const s = linkSummary(DIR, 24 * 3600_000, now);
  assert(s.drops === 5, `drop 计数=5（四段窗口内全记+窗口外排除+坏行跳过；实 ${s.drops}）`);
  assert((s.dropsBySrc["web-lan"] ?? 0) === 2 && (s.dropsBySrc["web-cloud"] ?? 0) === 1 && (s.dropsBySrc.bridge ?? 0) === 1 && (s.dropsBySrc.rn ?? 0) === 1, `dropsBySrc 分段如实（实 ${JSON.stringify(s.dropsBySrc)}）`);
  assert(s.reconnects === 4, `reconnect 计数=4（实 ${s.reconnects}）`);
  assert(s.reconnectP50Ms === 6600, `P50 线性插值（实 ${s.reconnectP50Ms}——[2600,4200,9000,15000] 期望 6600）`);
  assert(s.reconnectP95Ms === 14100, `P95 线性插值（实 ${s.reconnectP95Ms}——期望 14100）`);
  assert(s.avgAttempts === 2, `avgAttempts=端源 3 条 (3+2+1)/3=2.0（实 ${s.avgAttempts}）`);
  {
    const D2 = mkdtempSync(join(tmpdir(), "ccr-linkq2-"));
    appendLinkEvent(D2, { ts: Date.now(), src: "bridge", kind: "reconnect", downtimeMs: 5000 });
    const s2 = linkSummary(D2);
    assert(s2.reconnects === 1 && s2.reconnectP50Ms === 5000 && s2.reconnectP95Ms === 5000, `单样本：分位=唯一真值（实 ${JSON.stringify({ p50: s2.reconnectP50Ms, p95: s2.reconnectP95Ms })}）`);
    rmSync(D2, { recursive: true, force: true });
  }
  console.log("B 断连注入（记账半边）:");
  {
    const D3 = mkdtempSync(join(tmpdir(), "ccr-linkq3-"));
    const t0 = Date.now() - 600_000;
    appendLinkEvent(D3, { ts: t0, src: "web-cloud", kind: "drop", reason: "close", code: 1006, connectedMs: 300_000 });
    appendLinkEvent(D3, { ts: t0 + 10_000, src: "web-cloud", kind: "reconnect", downtimeMs: 10_000, attempts: 2 });
    const s = linkSummary(D3, 24 * 3600_000, Date.now());
    assert(s.drops === 1 && (s.dropsBySrc["web-cloud"] ?? 0) === 1 && (s.dropsBySrc.bridge ?? 0) === 0, `分段定罪面：断在端段桥零事件（实 ${JSON.stringify(s.dropsBySrc)}）`);
    assert(s.reconnectP50Ms === 10_000 && s.avgAttempts === 2, `重连耗时 10s/attempts 2 如实（实 ${s.reconnectP50Ms}/${s.avgAttempts}）`);
    rmSync(D3, { recursive: true, force: true });
  }
  console.log("C 端上反馈+提速文本锚:");
  const sd = readFileSync(join(process.cwd(), "..", "web-console", "js", "settings-domain.js"), "utf8");
  assert(sd.includes("const linkQ = (() => {") && sd.includes("/api/telemetry/link"), "web linkQ 补报模块在");
  assert(sd.includes("RETRY_BASE_MS = 500"), "提速①起步 0.5s（RETRY_BASE_MS=500）");
  assert(sd.includes("Math.min(context.reconnectDelay * 2, 15000)"), "提速②web 封顶 30→15s");
  assert(sd.includes('"重连中 · 已尝试 " + tries + " 次"'), "端上反馈「重连中 · 已尝试 N 次」");
  assert(sd.includes('linkqSummary') && sd.includes("断连 \" + drops + \" 次"), "诊断卡渲染在");
  assert(sd.includes('linkQ.onOpen("lan")') && sd.includes('linkQ.onDrop("lan"') && sd.includes('linkQ.onOpen("cloud")') && sd.includes('linkQ.onDrop("cloud"'), "web 双链挂点齐（lan+cloud）");
  const rn = readFileSync(join(process.cwd(), "..", "expo-app", "src", "store.ts"), "utf8");
  assert(rn.includes("const linkqRn = (() => {") && rn.includes('src: "rn"'), "RN linkqRn 模块在（src=rn）");
  assert(rn.includes("linkqRn.onDrop(kind + \": \" + detail"), "RN drop 挂 recordConnEvent 统一断因口");
  assert(rn.includes("linkqRn.onOpen(conn.cfg?.wsUrl"), "RN 恢复挂 onopen");
  const cc = readFileSync(join(process.cwd(), "src", "cloud-client.ts"), "utf8");
  assert(cc.includes("appendLinkEvent(this.cfg.dataDir") && cc.includes('src: "bridge"'), "桥段记账在");
  assert(cc.includes("Math.min(this.delayMs * 2, 15_000)"), "桥退避封顶 15s");
  const ws = readFileSync(join(process.cwd(), "src", "ws-server.ts"), "utf8");
  assert(ws.includes('"/api/telemetry/link"') && ws.includes("401"), "POST 端点+token 鉴权");
  assert(!ws.includes('SRC_OK.has("bridge"'), "src 白名单不含 bridge（端侧伪造桥段拒收）");
  assert(ws.includes("linkSummary(cfg.dataDir"), "GET summary 端点在");
  const ih = readFileSync(join(process.cwd(), "..", "web-console", "index.html"), "utf8");
  assert(ih.includes('id="linkqCard"') && ih.includes('id="linkqSummary"'), "诊断卡骨架在（index.html）");
  console.log("D 端点收口（白名单/越界双拒）:");
  {
    const SRC_OK = new Set(["web-lan", "web-cloud", "rn"]);
    const rows = [
      { ts: Date.now(), src: "web-lan", kind: "drop" },
      { ts: Date.now(), src: "rn", kind: "reconnect" },
      { ts: Date.now(), src: "bridge", kind: "drop" },
      { ts: Date.now() - 8 * 86_400_000, src: "web-lan", kind: "drop" },
    ];
    const accepted = rows.filter((r) => SRC_OK.has(r.src as never) && Date.now() - r.ts <= 7 * 86_400_000);
    assert(accepted.length === 2, `白名单+越界双拒（4 行收 2——实 ${accepted.length}）`);
  }
  rmSync(DIR, { recursive: true, force: true });
  console.log(`\n========== linkquality 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
