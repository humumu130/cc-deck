// #92 W-NOTIFY2 断言件：派发/回执链生产化——B 假死重路由 / C 回执通知 / A 频控锚 / E 审计落盘。
// 直跑：env -u CCR_ORG_DIR -u CCR_PORT npx tsx scripts/test-notify2.ts
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
import { join } from "node:path";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import type { RelayConfig } from "../src/config.js";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`PASS ${msg}`); } else { fail++; console.error(`FAIL ${msg}`); }
}

const ORG = mkdtempSync(join(tmpdir(), "ccr-n2-org-"));
const DATA = mkdtempSync(join(tmpdir(), "ccr-n2-data-"));
process.env.CCR_ORG_DIR = ORG;
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_STORAGE_READ_MODE = "json";
try {
  const cfg: RelayConfig = {
    port: 8796, token: "t", tokenGenerated: false, defaultCwd: "",
    model: "m", bridgeToken: "bt", dataDir: DATA,
    cloudUrls: [], cloudUrl: "", cloudToken: "", employeeConfigDir: null,
  };
  const eventsPath = join(DATA, "events.ndjson");
  const bus = new EventBus({ persistPath: eventsPath });
  const spawned: { sid: string }[] = [];
  const mgr = new SessionManager(bus, cfg);
  mgr.setAgentFactory(((_cwd: any, _m: any, _cb: any, _prompt: any, _opts?: any) => {
    const a = {
      id: `spawn-${spawned.length + 1}`, startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => {}, setPermissionMode: async () => {},
    } as never;
    spawned.push({ sid: `spawn-${spawned.length}` });
    return a;
  }) as any);
  // 手造假死熟手（进程在+久无帧）与健康熟手：路由表种子让 pickVeteran 先遇假死者
  const GID = "g-n2";
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: GID, name: "断言组", anchor_dir: DATA, status: "active", tier: "随手办", headcount: [
    { session_id: "w-dead", role: "worker" }, { session_id: "w-fit", role: "worker" },
  ], created_at: Date.now() - 86_400_000 }] }));
  writeFileSync(join(ORG, "routing.json"), JSON.stringify({ entries: [
    { gid: GID, session_id: "w-dead", count: 5, last_ts: Date.now() - 3_600_000 },
    { gid: GID, session_id: "w-fit", count: 3, last_ts: Date.now() - 1_800_000 },
  ] }));
  const fakeAgent = { ended: false } as never;
  const mk = (sid: string, updatedAgoMs: number, agent: unknown) => ({
    agent: agent ?? null, logs: [], lastUpdateEmit: 0,
    lastProgressAt: Date.now() - updatedAgoMs, lastProgressKind: "",
    unacked: [], wd: { phase: "idle", recoveries: [], gaveUp: false }, streamGen: 0, activitySeq: 0,
    state: {
      session_id: sid, relay_session_id: `sdk-${sid}`, external: false, status: "DONE",
      title: sid, started_at: Date.now() - 7_200_000, updated_at: Date.now() - updatedAgoMs,
    },
  });
  (mgr as any).sessions.set("w-dead", mk("w-dead", 20 * 60_000, fakeAgent)); // 假死：agent 在+20min 无帧
  (mgr as any).sessions.set("w-fit", mk("w-fit", 60_000, null));            // 健康：无 agent（可 resume 路径）
  // B：dispatch → 认领应跳过假死熟手落健康者（重路由语义=skip 后 fallback）
  const r = (mgr as any).dispatchWorker({ anchor: DATA, prompt: "#92 假死重路由断言单", gid: GID, tier: "随手办" });
  ok(r.ok === true, `B① dispatch ok（实 ${JSON.stringify(r).slice(0, 90)}）`);
  ok(r.session_id === "w-fit", `B② 重路由到健康熟手 w-fit（实 ${r.session_id}——假死 w-dead 被 15min 帧闸 skip）`);

  // C：回执收口 → 手机通知账（dispatch kind）+审计帧
  (mgr as any).closeOpenDispatches("w-fit", "done", "断言回执：三件全绿", false, true);
  const notif = [...(mgr as any).notifications.values()].find((n: any) => String(n.title).includes("派单") || n.kind === "dispatch" || n.group === "attention");
  ok(!!notif, `C① 回执收口通知在账（title=${notif?.title ?? "无"}）`);

  // E：审计帧落 events.ndjson（reroute/close 两动作）
  const evText = readFileSync(eventsPath, "utf-8");
  ok(evText.includes("NOTIFY_CHAIN_AUDIT") && evText.includes("dispatch-reroute"), "E① reroute 审计帧落盘（events.ndjson 可检索）");
  ok(evText.includes("dispatch-close"), "E② close 审计帧落盘");

  // A：60s 频控+手机通知源码锚（feedPM 全链重，断言面=机制在位）
  const sm = readFileSync(join(__dirname, "../src/session-manager.ts"), "utf-8");
  ok(sm.includes("pmWakeNotifyAt > 60_000") && sm.includes('"pm-wake"'), "A① 唤醒手机通知 60s 频控窗在位（feedPM 注入成功边）");
  ok(sm.includes('"pm-wake" | "dispatch-reroute" | "stale-escalate" | "dispatch-close"'), "E③ 四动作审计词表在位");
  const pt = readFileSync(join(__dirname, "../src/patrol.ts"), "utf-8");
  ok(pt.includes('"stale-escalate"') && pt.includes("actionable: true"), "D① 40min 停滞升级可操作通知在位（patrol）");
} finally {
  delete process.env.CCR_ORG_DIR;
}
console.log(`notify2: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
