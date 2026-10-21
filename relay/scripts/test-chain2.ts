// #199 W-CHAIN2 断言件：A 钩子/B 补盲六件/C spool+镜像+端点/D 三账对账。
// 直跑：env -u CCR_ORG_DIR -u CCR_PORT npx tsx scripts/test-chain2.ts
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { RelayConfig } from "../src/config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`PASS ${msg}`); } else { fail++; console.error(`FAIL ${msg}`); }
}

// ---------- A：钩子面（源码锚+注册序） ----------
console.log("== A 钩子 ==");
const hookDir = join(__dirname, "../../scripts/hooks");
const tr = readFileSync(join(hookDir, "turn-report.mjs"), "utf-8");
ok(tr.includes("api/turn-report") && tr.includes("turn-spool"), "A① turn-report.mjs 外报+spool 在档");
ok(tr.includes("CCR_RELAY_CHILD") && tr.includes("60_000"), "A② CHILD 跳过+60s 幂等窗在");
ok(tr.includes("[0-9a-f]{8}-[0-9a-f]{4}") && tr.includes("fp-"), "A③ transcript uuid 幂等键（无 uuid 退化指纹）");
const ts = readFileSync(join(hookDir, "task-stop.mjs"), "utf-8");
ok(ts.indexOf("void reportTurn(input);") < ts.indexOf("if (await isRemoteActive"), "A④ P0-1：外报在 3min 豁免判定调用前（豁免只豁拦截）");
const settings = JSON.parse(readFileSync(join(process.env.HOME!, ".claude", "settings.json"), "utf-8"));
const stopCmds = (settings.hooks.Stop[0].hooks as { command: string }[]).map((h) => h.command);
ok(stopCmds.some((c) => c.includes("turn-report.mjs")) && stopCmds.findIndex((c) => c.includes("turn-report")) < stopCmds.findIndex((c) => c.includes("task-stop")), "A⑤ settings Stop：turn-report 在 task-stop 前（每次必报）");

// ---------- B/C/D：活 mgr ----------
console.log("== B/C/D relay 面 ==");
const ORG = mkdtempSync(join(tmpdir(), "ccr-c2-org-"));
const DATA = mkdtempSync(join(tmpdir(), "ccr-c2-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STORAGE_READ_MODE = "json";
try {
  const cfg: RelayConfig = { port: 8797, token: "t", tokenGenerated: false, defaultCwd: "", model: "m", bridgeToken: "bt", dataDir: DATA, cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null };
  const bus = new EventBus({ persistPath: join(DATA, "events.ndjson") });
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory((() => ({ id: "x", startedAt: 0, ended: false, sendMessage() {}, allow: () => false, deny: () => false, answer: () => false, stop: async () => {}, setPermissionMode: async () => {} })) as never);
  const sm = readFileSync(join(__dirname, "../src/session-manager.ts"), "utf-8");
  const pt = readFileSync(join(__dirname, "../src/patrol.ts"), "utf-8");
  const ws = readFileSync(join(__dirname, "../src/ws-server.ts"), "utf-8");

  // B1
  ok(pt.includes("retryExpiredBreaker") && pt.includes("patrol-retry"), "B1 熔断到期 patrol 补试在位");
  // B2（审计先于频控门）
  const iEmit = sm.indexOf('this.emitChainAudit("pm-wake", `trigger=${trigger}', sm.indexOf("result: \"continue\""));
  const iGate = sm.indexOf("this.pmWakeNotifyAt > 60_000");
  ok(iEmit > 0 && iGate > 0 && iEmit < iGate, "B2 审计移出频控门（emit 先于 60s if）");
  // B3
  ok(pt.includes("staleWaiting") && pt.includes("2 * 3600_000") && pt.includes("90 * 60_000"), "B3 stale 补 WAITING>2h+compacting>90min");
  // B4
  ok(sm.includes('"pm-no-target"') && sm.includes('"pm-breaker"') && sm.includes('"pm-parked"'), "B4 三支（no_target/breaker/parked）升级通知");
  // B5
  ok(pt.includes("ALERT-NO-TARGET"), "B5 patrol 无 target 落账");
  // C
  ok(sm.includes("chainAuditMirror") && sm.includes("chain-audit.jsonl"), "C① 审计镜像队列文件挂 emitChainAudit");
  ok(ws.includes('"/api/turn-report"') && ws.includes("handleTurnReport"), "C② /api/turn-report 端点在位");
  ok(sm.includes("drainTurnSpool") && readFileSync(join(__dirname, "../src/index.ts"), "utf-8").includes("drainTurnSpool"), "C③ 启动 drain 挂载");

  // D 活测：台账 running #998 + 任务面无单 → 缺角告警 + 心跳落盘
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g-c2", name: "对账组", anchor_dir: DATA, status: "active", tier: "随手办", headcount: [], created_at: Date.now() - 86_400_000 }] }));
  const { appendDispatch } = await import("../src/org.js");
  appendDispatch({ ts: Date.now(), id: "d-c2-1", tier: "随手办", target: "w1", status: "running", session_id: "w1", project_anchor: DATA, actor: "leader", title: "对账断言单 #998" });
  (mgr as any).runLedgerRecon("test");
  const heartbeat = readFileSync(join(DATA, "recon-heartbeat.json"), "utf-8");
  ok(heartbeat.includes('"trigger":"test"'), "D① 对账心跳文件落盘");
  const notif = [...(mgr as any).notifications.values()].find((n: any) => String(n.title).includes("三账对账"));
  ok(!!notif && String(notif.body).includes("#998"), `D② 台账 running 但任务面无单→缺角告警含 #998（body=${notif ? String(notif.body).slice(0, 60) : "无"}）`);
  const mirror = readFileSync(join(DATA, "chain-audit.jsonl"), "utf-8");
  ok(mirror.includes("recon(test)"), "D③ 对账审计入镜像队列（chain-audit.jsonl）");

  // handleTurnReport 活测（worker 分支 60s 去重）
  const r1 = (mgr as any).handleTurnReport("sid-c2", "key-a");
  const r2 = (mgr as any).handleTurnReport("sid-c2", "key-a");
  const r3 = (mgr as any).handleTurnReport("sid-c2", "key-b");
  ok(r1 === true && r2 === false && r3 === true, "D④ turn-report 60s 同键去重/新键放行");
} finally { delete process.env.CCR_ORG_DIR; }
console.log(`chain2: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
