// [W-LINKQUALITY]（t-d1edf363，1104 用户实锤×N）链路分段遥测+提速断言。
//   A 账本纯函数：appendLinkEvent 落盘/坏行跳过/窗口过滤；linkSummary P50 线性插值/
//     单样本=唯一真值（恒真禁用——不造 0）/dropsBySrc/avgAttempts
//   B 断连注入（验收 1 记账半边）：drop→reconnect 序列落账→分段定罪可判
//   C 端上反馈+提速文本锚（web/RN 闭包不可直跑——005 壳文本锚范式；R1 锚已随帧上行改型，
//     旧 HTTP/幽灵键链断言转「防回退死锚」——ccd_cfg 零代码引用/补报零 POST 依赖）
//   D 端点收口（白名单/越界拒——R1 起与帧命令共用 ingestLinkEvents 单口直证）
//   E ingest 单口单测（R1·P1-3）：校验（src/kind/ts 界/connect 收编）+指纹去重——
//     同批重放 N 次落账计数不变
//   F R1 结构锚：双白名单逐字一致（ws-server×cloud-client，m12 纪律）+RN 通道分键/
//     LAN onopen 挂点/周期拍；幽灵键与 HTTP 主链死亡锚
//   H 真链沙盒（R1·验收 1）：真 relay+真 ws——COMMAND_TELEMETRY_LINK 帧落账/去重/
//     summary 回读全链（web-lan 帧形；web-cloud 密封路=同命令面经 cloud-client 白名单，
//     F 组 mirror 锁死）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLinkEvent, linkSummary, linkLogPath, ingestLinkEvents, readLinkEvents, type LinkEventRow } from "../src/link-quality.js";
import { WebSocket } from "ws";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { startServer } from "../src/ws-server.js";
import type { RelayConfig } from "../src/config.js";

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
  assert(sd.includes("const linkQ = (() => {") && sd.includes("COMMAND_TELEMETRY_LINK"), "web linkQ 补报模块在（R1 帧上行）");
  assert(!sd.includes('localStorage.getItem("ccd_cfg")'), "R1 防回退死锚①：ccd_cfg 幽灵键零代码引用（残留仅注释——A审 P0 根因不复活）");
  assert(!/linkQ[\s\S]{0,2000}fetch\(/.test(sd), "R1 防回退死锚②：linkQ 补报不再走 HTTP fetch（帧通道唯一主链）");
  assert(sd.includes("RETRY_BASE_MS = 500"), "提速①起步 0.5s（RETRY_BASE_MS=500）");
  assert(sd.includes("Math.min(context.reconnectDelay * 2, 15000)"), "提速②web 封顶 30→15s");
  assert(sd.includes('"重连中 · 已尝试 " + tries + " 次"'), "端上反馈「重连中 · 已尝试 N 次」");
  assert(sd.includes('linkqSummary') && sd.includes("断连 \" + drops + \" 次"), "诊断卡渲染在");
  assert(sd.includes('linkQ.onOpen("lan")') && sd.includes('linkQ.onDrop("lan"') && sd.includes('linkQ.onOpen("cloud")') && sd.includes('linkQ.onDrop("cloud"'), "web 双链挂点齐（lan+cloud）");
  const rn = readFileSync(join(process.cwd(), "..", "expo-app", "src", "store.ts"), "utf8");
  assert(rn.includes("const linkqRn = (() => {") && rn.includes('src: "rn"'), "RN linkqRn 模块在（src=rn）");
  assert(rn.includes('linkqRn.onDrop(conn.channel === "cloud" ? "cloud" : "lan"'), "RN drop 挂 recordConnEvent 统一断因口（R1 按通道分键）");
  assert(rn.includes('linkqRn.onOpen("lan")') && rn.includes('linkqRn.onOpen("cloud")'), "RN 双通道 onopen 挂点齐（R1·P1-2：LAN 补 adoptLan+云保持）");
  assert(rn.includes("channel: \"lan\" | \"cloud\"") && !rn.includes('"/api/telemetry/link"'), "RN 通道分键类型在 + R1 防回退死锚：RN 补报零 HTTP /api 依赖（帧通道唯一）");
  const cc = readFileSync(join(process.cwd(), "src", "cloud-client.ts"), "utf8");
  assert(cc.includes("appendLinkEvent(this.cfg.dataDir") && cc.includes('src: "bridge"'), "桥段记账在");
  assert(cc.includes("Math.min(this.delayMs * 2, 15_000)"), "桥退避封顶 15s");
  const ws = readFileSync(join(process.cwd(), "src", "ws-server.ts"), "utf8");
  const io_lq = readFileSync(join(process.cwd(), "src", "link-quality.ts"), "utf8");
  assert(ws.includes('"/api/telemetry/link"') && ws.includes("401"), "POST 端点+token 鉴权（R1 起降级调试口——主链已改 ws 帧）");
  assert(ws.includes("ingestLinkEvents(cfg.dataDir"), "调试口与帧命令共用 ingestLinkEvents 单口（R1）");
  assert(ws.includes('"COMMAND_TELEMETRY_LINK"'), "ws-server COMMAND_TYPES 白名单含帧命令（R1）");
  assert(io_lq.includes('LINK_SRC_OK = new Set<LinkEventSrc>(["web-lan", "web-cloud", "rn"])'), "src 白名单不含 bridge（端侧伪造桥段拒收——R1 迁入 link-quality 单口 LINK_SRC_OK）");
  assert(ws.includes("linkSummary(cfg.dataDir"), "GET summary 端点在");
  const ih = readFileSync(join(process.cwd(), "..", "web-console", "index.html"), "utf8");
  assert(ih.includes('id="linkqCard"') && ih.includes('id="linkqSummary"'), "诊断卡骨架在（index.html）");
  console.log("D+E ingest 单口直证（白名单/越界/去重——R1 单口真函数非副本）:");
  const DIR2 = mkdtempSync(join(tmpdir(), "ccr-linkq-ing-"));
  {
    const t0 = Date.now();
    const r1 = ingestLinkEvents(DIR2, [
      { ts: t0 - 1000, src: "web-lan", kind: "drop", reason: "close" },
      { ts: t0 - 1000, src: "rn", kind: "reconnect", downtimeMs: 3000, channel: "lan" },
      { ts: t0 - 1000, src: "bridge", kind: "drop" },
      { ts: t0 - 8 * 86_400_000, src: "web-lan", kind: "drop" },
      { ts: t0 + 120_000, src: "web-lan", kind: "drop" },
      { ts: t0 - 1000, src: "web-cloud", kind: "connect", channel: "cloud" },
      "junk",
    ]);
    assert(r1.accepted === 3 && r1.rejected === 4, `D① 白名单+越界+畸形双拒（7 行收 3——实 acc ${r1.accepted}/rej ${r1.rejected}；connect 形态收编）`);
    // P1-3 核心：同批重放 N 次 → 落账计数不变（指纹 src|kind|ts 去重）
    const before = linkSummary(DIR2, 86_400_000, t0 + 60_000);
    for (let i = 0; i < 3; i += 1) {
      const rN = ingestLinkEvents(DIR2, [
        { ts: t0 - 1000, src: "web-lan", kind: "drop", reason: "close" },
        { ts: t0 - 1000, src: "rn", kind: "reconnect", downtimeMs: 3000, channel: "lan" },
        { ts: t0 - 1000, src: "web-cloud", kind: "connect", channel: "cloud" },
      ]);
      assert(rN.accepted === 0 && rN.deduped === 3, `E${i + 1} 同批重放第 ${i + 1} 次：零新落账+全指纹命中（acc ${rN.accepted}/dedup ${rN.deduped}）`);
    }
    const after = linkSummary(DIR2, 86_400_000, t0 + 60_000);
    assert(before.drops === after.drops && before.drops === 1, `E4 重放 N 次落账计数不变（drops ${before.drops}→${after.drops}——P1-3 契约）`);
    const rows2 = readLinkEvents(DIR2);
    assert(rows2.length === 3 && rows2.every((r) => r.src !== "bridge"), "E5 落账行数=3 且 bridge 零行（白名单在单口内生效）");
  }
  console.log("F R1 结构锚（双白名单 mirror+RN 挂点/周期拍+web 帧分流）:");
  {
    const parse = (src: string) => {
      const m = src.match(/export const COMMAND_TYPES = new Set\(([^)]+)\)/s);
      if (!m) return new Set<string>();
      return new Set([...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]));
    };
    const wsSet = parse(ws);
    const ccSet = parse(cc);
    const diff = [...wsSet].filter((x) => !ccSet.has(x)).concat([...ccSet].filter((x) => !wsSet.has(x)));
    assert(diff.length === 0 && wsSet.has("COMMAND_TELEMETRY_LINK"), `F① 双白名单逐字一致且含帧命令（diff=${JSON.stringify(diff)}——web-cloud 密封路入口即此清单，m12 纪律）`);
    assert(sd.includes("frameOf(dest)") && sd.includes("cloudCmdShim") && sd.includes("take(dest, 200)"), "F② web flush 按 src 分流（web-lan→ctx.ws / web-cloud→密封 shim）+整队分批");
    assert(sd.includes("visibilitychange") && sd.includes("30_000"), "F③ web flush 触发补（30s 周期拍+可见性拍——P2③）");
    assert(sd.includes('get: "summary"') && sd.includes("f.command_id !== cid"), "F④ 诊断卡取数改帧命令（ack 按 command_id 结算，4s 超时兜底）");
    assert(rn.includes("flushLinkq(conn)") && rn.includes("COMMAND_TELEMETRY_LINK") && rn.includes("startLinkqTick"), "F⑤ RN 帧上行 flush+30s 周期拍在（dispatchCmd 密封/超时同 id 重发同面）");
  }

  console.log("H 真链沙盒（真 relay+真 ws——web-lan 帧形全链）:");
  {
    const prev = { ...process.env };
    const DATA = mkdtempSync(join(tmpdir(), "ccr-linkq-ws-"));
    process.env.CCR_ORG_DIR = mkdtempSync(join(tmpdir(), "ccr-linkq-org-"));
    process.env.CCR_DATA_DIR = DATA;
    process.env.CCR_ACCEPTANCE_DIR = join(DATA, "acceptances");
    process.env.CCR_STORAGE_READ_MODE = "json";
    process.env.CCR_NO_TITLE_GEN = "1";
    process.env.CCR_CLOUD_URL = "";
    process.env.CCR_PROJECTS_ROOT = mkdtempSync(join(tmpdir(), "ccr-linkq-proj-"));
    delete process.env.CC_DECK_PLUGIN;
    delete process.env.CCR_PARENT_PID;
    delete process.env.CCR_RELAY_CHILD;
    delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
    try {
      const port = 18300 + Math.floor(Math.random() * 500);
      const cfg: RelayConfig = { port, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null };
      const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
      const mgr = new SessionManager(bus, cfg);
      const server = startServer(bus, mgr, cfg, {});
      await new Promise((r) => setTimeout(r, 300));
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent("t")}`);
      await new Promise<void>((res, rej) => { sock.once("open", () => res()); sock.once("error", (e: Error) => rej(e)); });
      const sendCmd = (payload: unknown) => new Promise<{ ok: boolean; error?: string; data?: { accepted?: number; deduped?: number; rejected?: number; drops?: number; dropsBySrc?: Record<string, number> } }>((resolve) => {
        const id = "lqh-" + Math.random().toString(36).slice(2, 8);
        const on = (raw: WebSocket.RawData) => {
          try {
            const m = JSON.parse(String(raw)) as { type?: string; command_id?: string; ok?: boolean; error?: string; data?: unknown };
            if (m.type === "COMMAND_ACK" && m.command_id === id) { sock.off("message", on); resolve(m as never); }
          } catch { /* 忽略坏帧 */ }
        };
        sock.on("message", on);
        sock.send(JSON.stringify({ command_id: id, type: "COMMAND_TELEMETRY_LINK", payload, ts: Date.now() }));
      });
      const t0 = Date.now();
      const batch = [
        { ts: t0 - 1000, src: "web-lan", kind: "drop", reason: "close", code: 1006, connectedMs: 60_000 },
        { ts: t0 - 900, src: "web-cloud", kind: "reconnect", downtimeMs: 4200, attempts: 2 },
        { ts: t0 - 800, src: "rn", kind: "drop", reason: "net-drop", channel: "lan" },
        { ts: t0 - 800, src: "rn", kind: "connect", channel: "cloud" },
        { ts: t0 - 800, src: "bridge", kind: "drop", reason: "forge" },
      ];
      const a1r = await sendCmd({ events: batch });
      assert(a1r.ok === true && a1r.data?.accepted === 4 && a1r.data?.rejected === 1, `H① 真链帧落账：4 收 1 拒（bridge 伪造拒——实 acc ${a1r.data?.accepted}/rej ${a1r.data?.rejected}/${a1r.error ?? ""}）`);
      const rep = await sendCmd({ events: batch });
      assert(rep.ok === true && rep.data?.accepted === 0 && rep.data?.deduped === 4 && rep.data?.rejected === 1, `H② 真链重放去重：零新落账+指纹全中（acc ${rep.data?.accepted}/ded ${rep.data?.deduped}——P1-3 真套接字面）`);
      const sum = await sendCmd({ get: "summary" });
      assert(sum.ok === true && sum.data?.drops === 2 && sum.data?.dropsBySrc?.["web-lan"] === 1 && sum.data?.dropsBySrc?.["rn"] === 1, `H③ summary 帧取数（drops ${sum.data?.drops}/web-lan ${sum.data?.dropsBySrc?.["web-lan"]}/rn ${sum.data?.dropsBySrc?.["rn"]}——诊断卡数据源同链）`);
      const rowsH = readLinkEvents(DATA);
      assert(rowsH.length === 4, `H④ 账本行数=4（重放后不变——实 ${rowsH.length}）`);
      sock.close();
      await server.close();
    } finally {
      const keep = new Set(Object.keys(prev));
      for (const k of Object.keys(process.env)) if (!keep.has(k) && k.startsWith("CCR_")) delete process.env[k];
      Object.assign(process.env, prev);
    }
  }

  rmSync(DIR, { recursive: true, force: true });
  console.log(`\n========== linkquality 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
