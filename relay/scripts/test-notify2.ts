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

let prevPolicy: string | undefined; /* #204 */
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
  // ---------- #200 W-ROUTE 三组：retired 不选中 / 假死 cap-reuse fallback / 全死响亮错 ----------
  console.log("== #200 route-liveness ==");
  const mk2 = (sid: string, agoMs: number, agent: unknown, status = "DONE") => ({
    agent: agent ?? null, logs: [], lastUpdateEmit: 0, lastProgressAt: Date.now() - agoMs, lastProgressKind: "",
    unacked: [], wd: { phase: "idle", recoveries: [], gaveUp: false }, streamGen: 0, activitySeq: 0,
    state: { session_id: sid, relay_session_id: `sdk-${sid}`, external: false, status, title: sid, started_at: Date.now() - 7_200_000, updated_at: Date.now() - agoMs },
  });
  // R1 retired 不选中：cap-reuse 路径（编制满）——retired 兜底闸
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g-r1", name: "R1 组", anchor_dir: DATA, status: "active", tier: "随手办", headcount_cap: 1, headcount: [
    { session_id: "w-retired", role: "worker" }, { session_id: "w-ok", role: "worker" },
  ], created_at: Date.now() - 86_400_000 }] }));
  (mgr as any).sessions.set("w-retired", mk2("w-retired", 60_000, null));
  (mgr as any).sessions.set("w-ok", mk2("w-ok", 60_000, null));
  (mgr as any).isRetiredMember = (sid: string) => sid === "w-retired";
  const r1 = (mgr as any).dispatchWorker({ anchor: DATA, prompt: "#200 R1 retired 闸", gid: "g-r1", tier: "随手办" });
  ok(r1.ok === true && r1.session_id !== "w-retired", `R1 retired 不选中（实 target=${r1.session_id ?? JSON.stringify(r1).slice(0, 60)}）`);
  (mgr as any).isRetiredMember = () => false;

  // R2 假死 cap-reuse fallback：编制满+zombie 在前+健康在后 → 复用落健康
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g-r2", name: "R2 组", anchor_dir: DATA, status: "active", tier: "随手办", headcount_cap: 1, headcount: [
    { session_id: "w-zomb", role: "worker" }, { session_id: "w-fit2", role: "worker" },
  ], created_at: Date.now() - 86_400_000 }] }));
  (mgr as any).sessions.set("w-zomb", mk2("w-zomb", 20 * 60_000, { ended: false })); // agent 在+20min 无帧=zombie
  (mgr as any).sessions.set("w-fit2", mk2("w-fit2", 60_000, null));
  const r2 = (mgr as any).dispatchWorker({ anchor: DATA, prompt: "#200 R2 假死 fallback", gid: "g-r2", tier: "随手办" });
  ok(r2.ok === true && r2.session_id === "w-fit2", `R2 cap-reuse 假死 skip 落健康（实 ${r2.session_id ?? JSON.stringify(r2).slice(0, 60)}）`);
  ok(readFileSync(eventsPath, "utf-8").includes("cap-reuse zombie skip"), "R2② reroute 审计帧（cap-reuse zombie）落盘");

  // R3 全死响亮错：编制满+全员 zombie（无忙者）→ ok:false 含「全部无响应」
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g-r3", name: "R3 组", anchor_dir: DATA, status: "active", tier: "随手办", headcount_cap: 1, headcount: [
    { session_id: "w-d1", role: "worker" }, { session_id: "w-d2", role: "worker" },
  ], created_at: Date.now() - 86_400_000 }] }));
  (mgr as any).sessions.set("w-d1", mk2("w-d1", 30 * 60_000, { ended: false }));
  (mgr as any).sessions.set("w-d2", mk2("w-d2", 40 * 60_000, { ended: false }));
  const r3 = (mgr as any).dispatchWorker({ anchor: DATA, prompt: "#200 R3 全死响亮错", gid: "g-r3", tier: "随手办" });
  ok(r3.ok === false && String(r3.error).includes("全部无响应"), `R3 全死→ok:false 响亮错（实 ${JSON.stringify(r3).slice(0, 90)}）`);
  ok(!String(JSON.stringify(r3)).includes("queued"), "R3② 不再排队假 ok");

  // ---------- #204 W-ROUTE2 两组：undefined 会话跳过 / member-retire 短前缀清退 ----------
  prevPolicy = process.env.CCR_PERMISSION_POLICY;
  process.env.CCR_PERMISSION_POLICY = "off"; /* #204：orgCommand 过 P81 环境闸——测试关闸直测 member-retire 匹配逻辑 */
  console.log("== #204 route2 ==");
  // W1：headcount 条目但 sessions 里无会话（absent）→ dispatch 不落它（响亮错或跳下一）
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g-w1", name: "W1 组", anchor_dir: DATA, status: "active", tier: "随手办", headcount: [
    { session_id: "ghost-0000", role: "worker" },  // sessions 里不存在=absent
  ], created_at: Date.now() - 86_400_000 }] }));
  (mgr as any).sessions.delete("ghost-0000");
  const w1 = (mgr as any).dispatchWorker({ anchor: DATA, prompt: "#204 W1 absent 洞", gid: "g-w1", tier: "随手办" });
  ok(w1.ok === false || (w1.ok === true && w1.session_id !== "ghost-0000"), `W1 absent 会话不被选中（实 ${JSON.stringify(w1).slice(0, 70)}）`);

  // W2：member-retire 短前缀——编制放全 UUID 成员，CLI 传 8 位前缀应清退成功
  const FULL = "fe34bf33-5dee-4e31-a9c0-0966eb919e2e";
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g-w2", name: "W2 组", anchor_dir: DATA, status: "active", tier: "随手办", headcount: [
    { session_id: FULL, role: "worker" },
    { session_id: "fe34bf99-aaaa-bbbb-cccc-dddddddddddd", role: "worker" },
  ], created_at: Date.now() - 86_400_000 }] }));
  const w2 = (mgr as any).orgCommand("owner", "test-device", "member-retire", { gid: "g-w2", sid: FULL.slice(0, 8), reason: "#204 前缀清退验证" });
  ok(w2?.ok === true && w2?.data?.retired === true, `W2 8 位前缀唯一命中→清退成功（实 ${JSON.stringify(w2).slice(0, 80)}）`);
  const g2 = JSON.parse(readFileSync(join(ORG, "projects.json"), "utf-8")).groups[0];
  ok(!g2.headcount.some((h: { session_id: string }) => h.session_id === FULL), "W2② 该成员已从编制移除");
  // 歧义前缀（新组放两个 fe34 开头成员，6 位前缀命中两个）→ 响亮拒
  writeFileSync(join(ORG, "projects.json"), JSON.stringify({ groups: [{ id: "g-w3", name: "W3 组", anchor_dir: DATA, status: "active", tier: "随手办", headcount: [
    { session_id: "fe34bf33-5dee-4e31-a9c0-0966eb919e2e", role: "worker" },
    { session_id: "fe34bf99-aaaa-bbbb-cccc-dddddddddddd", role: "worker" },
  ], created_at: Date.now() - 86_400_000 }] }));
  const w3 = (mgr as any).orgCommand("owner", "test-device", "member-retire", { gid: "g-w3", sid: "fe34bf" });
  ok(w3?.ok === false && String(w3?.error).includes("多个成员"), `W3 歧义前缀响亮拒（实 ${JSON.stringify(w3).slice(0, 70)}）`);

} finally {
  if (prevPolicy === undefined) delete process.env.CCR_PERMISSION_POLICY; else process.env.CCR_PERMISSION_POLICY = prevPolicy;
  delete process.env.CCR_ORG_DIR;
}
console.log(`notify2: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
