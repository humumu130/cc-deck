// T1 条件唤醒基建最小版（DEV-43）——测试锚。任务书口径：「谓词器最小集带测试锚
// （事实成立触发/不成立不触发/expires 兜底三负向）」。分组：
//   E 组  评估器纯函数：三负向 + triggerAfter 窗 + 一次性 + 词表谓词族
//   S 组  存储：round-trip / 坏文件空表 / arm-cancel 生命周期
//   V 组  服务 tick：fire 外发一次 / 不满足零外发 / expires 兜底触达 / checks 计数
//   P 组  cloud-push 单元：端点推导 / fetch 桩断言（头/载荷/超时）/ 配对手机解析
//   H 组  HTTP 载荷校验（armWakeupFromHttp 词表闸）
//   M 组  装配面（DEV-54：wakeup 闸在顶层解耦 patrol——防意外耦合回潮）
//   X 组  手机端帧解析（expo-app/src/bridge-alert 纯函数——relay 侧代跑，node 直测面惯例）
//   A 组  桥侧共享单源（cloud-bridge/src/alert：parseAlertPayload/buildAlertFrame/limiter）
// 直跑：env -u CCR_ORG_DIR npx tsx tests/test-wakeup.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateWakeup, loadWakeupRules, saveWakeupRules, newWakeupRule, WakeupService,
  type WakeupFacts, type WakeupRule,
} from "../src/wakeup.js";
import { armWakeupFromHttp } from "../src/wakeup-api.js";
import { bridgeAlertEndpoint, pushBridgeAlert, pairedPhoneDevs } from "../src/cloud-push.js";
import { parseBridgeAlert } from "../../expo-app/src/bridge-alert.js";
import { parseAlertPayload, buildAlertFrame, createAlertLimiter } from "../../cloud-bridge/src/alert.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

const FACTS: WakeupFacts = {
  sessions: [
    { sessionId: "s-pm", status: "ERROR", external: true },
    { sessionId: "s-worker", status: "WORKING", external: true },
    { sessionId: "s-internal", status: "WORKING", external: false },
  ],
  boardEntries: [
    { text: "DEV-43 防线通电", status: "claimed" },
    { text: "DEV-42 别的单", status: "submitted" },
  ],
  notificationPending: 7,
};

const rule = (over: Partial<WakeupRule> = {}): WakeupRule => ({
  id: "wk-test", createdAt: 1_000_000, createdBy: "test",
  predicate: { kind: "session_status", status: "ERROR" },
  title: "PM 候命位死亡", body: "duty 会话转 ERROR",
  state: "armed", checks: 0, ...over,
});

console.log("E 组 评估器（三负向 + 窗 + 一次性）");
ok(evaluateWakeup(rule(), FACTS, 1_100_000).action === "fire", "E1 事实成立 → fire");
ok(evaluateWakeup(rule({ predicate: { kind: "session_status", status: "WAITING" } }), FACTS, 1_100_000).action === "wait", "E2 事实不成立 → wait（不触发）");
ok(evaluateWakeup(rule({ expiresAt: 1_050_000 }), FACTS, 1_100_000).action === "expire", "E3 expires 到期 → expire（兜底优先于事实——硬上限语义）");
ok(evaluateWakeup(rule({ expiresAt: 1_050_000 }), { sessions: [], boardEntries: [], notificationPending: 0 }, 1_100_000).action === "expire", "E4 expires 到期且事实不成立 → expire（兜底触达位）");
ok(evaluateWakeup(rule({ triggerAfterMs: 500_000 }), FACTS, 1_100_000).action === "wait", "E5 triggerAfter 窗内事实已成立 → wait（防创建即触发的自反噪声）");
ok(evaluateWakeup(rule({ triggerAfterMs: 500_000 }), FACTS, 1_600_000).action === "fire", "E6 triggerAfter 窗满后事实成立 → fire");
ok(evaluateWakeup(rule({ state: "fired" }), FACTS, 1_100_000).action === "noop", "E7 非 armed（已触发）→ noop（一次性）");
ok(evaluateWakeup(rule({ predicate: { kind: "session_status", status: "ERROR", sessionId: "s-worker" } }), FACTS, 1_100_000).action === "wait", "E8 sessionId 限定不匹配 → wait");
ok(evaluateWakeup(rule({ predicate: { kind: "session_status", status: "WORKING", external: true } }), FACTS, 1_100_000).action === "fire", "E9 external 过滤命中 external WORKING");
ok(evaluateWakeup(rule({ predicate: { kind: "board_entry_status", status: "submitted", textIncludes: "DEV-42" } }), FACTS, 1_100_000).action === "fire", "E10 板卡谓词：状态+文本包含 → fire");
ok(evaluateWakeup(rule({ predicate: { kind: "board_entry_status", status: "submitted", textIncludes: "DEV-99" } }), FACTS, 1_100_000).action === "wait", "E11 板卡谓词：文本不包含 → wait");
ok(evaluateWakeup(rule({ predicate: { kind: "notification_pending", minCount: 8 } }), FACTS, 1_100_000).action === "wait", "E12 通知积压未越线 → wait");
ok(evaluateWakeup(rule({ predicate: { kind: "notification_pending", minCount: 7 } }), FACTS, 1_100_000).action === "fire", "E13 通知积压越线（≥） → fire");

console.log("S 组 存储");
{
  const dir = mkdtempSync(join(tmpdir(), "wakeup-store-"));
  ok(loadWakeupRules(dir).length === 0, "S1 空目录 → 空表");
  const r = newWakeupRule({ predicate: { kind: "session_status", status: "DONE" }, title: "t", body: "b", createdBy: "x", expiresInMs: 60_000 }, 5_000);
  saveWakeupRules(dir, [r]);
  const back = loadWakeupRules(dir);
  ok(back.length === 1 && back[0].id === r.id && back[0].expiresAt === 65_000, "S2 round-trip 保真（含 expiresInMs→expiresAt 换算）");
  writeFileSync(join(dir, "wakeup-rules.json"), "{corrupt");
  ok(loadWakeupRules(dir).length === 0, "S3 坏文件 → 空表不炸");
  rmSync(dir, { recursive: true, force: true });
}

console.log("V 组 服务 tick（外发桩记账）");
{
  const dir = mkdtempSync(join(tmpdir(), "wakeup-svc-"));
  const pushed: Array<{ title: string; body: string; level?: string }> = [];
  let tick = 2_000_000;
  const svc = new WakeupService({
    dataDir: dir,
    push: async (title, body, level) => { pushed.push({ title, body, level }); },
    facts: () => FACTS,
    now: () => tick,
    report: () => {},
  });
  // fire：事实成立 + 无窗
  svc.arm({ predicate: { kind: "session_status", status: "ERROR" }, title: "PM 死亡", body: "duty ERROR", createdBy: "t" });
  // 不满足：状态词表外的等待
  svc.arm({ predicate: { kind: "session_status", status: "WAITING" }, title: "永不满足", body: "b", createdBy: "t", expiresInMs: 100_000 });
  let r = await svc.tick();
  ok(r.fired === 1 && r.expired === 0, `V1 事实成立外发一次（fired=${r.fired}）`);
  ok(pushed.length === 1 && pushed[0].title === "PM 死亡", "V2 外发内容=规则 title/body");
  r = await svc.tick();
  ok(r.fired === 0 && pushed.length === 1, "V3 一次性：二拍不再外发");
  // expires 兜底：时钟推过 100s 窗
  tick += 200_000;
  r = await svc.tick();
  ok(r.expired === 1, `V4 expires 到期 → expired（实得 ${r.expired}）`);
  ok(pushed.length === 2 && pushed[1].title.startsWith("⏰ 唤醒规则过期"), "V5 过期兜底也触达（⏰ 前缀低级别）——绝不静默死");
  const rules = loadWakeupRules(dir);
  ok(rules.every((x) => x.state !== "armed") && rules.every((x) => (x.checks ?? 0) >= 1), "V6 全规则离场 + checks 计数在案（谓词器活性可见位）");
  // cancel 生命周期
  const c = svc.arm({ predicate: { kind: "notification_pending", minCount: 1 }, title: "t3", body: "b3", createdBy: "t" });
  ok(svc.cancel(c.id) && !svc.list().some((x) => x.id === c.id), "V7 arm→cancel 生命周期");
  rmSync(dir, { recursive: true, force: true });
}

console.log("R 组 tick/arm 竞争回归（DEV-51 P2-1：状态先落盘再外发）");
{
  // R1：arm 落在 fire push-await 窗内 → 规则存活且下一拍可达 fired
  const dir = mkdtempSync(join(tmpdir(), "wakeup-race1-"));
  let tick = 2_000_000;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((res) => { release = res; });
  const svc = new WakeupService({
    dataDir: dir,
    push: async () => { await gate; }, // 可控 Promise 撑开竞争窗
    facts: () => FACTS,
    now: () => tick,
    report: () => {},
  });
  svc.arm({ predicate: { kind: "session_status", status: "ERROR" }, title: "规则A", body: "b", createdBy: "t" });
  const t1 = svc.tick(); // 同步段跑完即悬在 push await——窗开
  await Promise.resolve(); // 微任务让出，确保挂点已入窗
  // 窗内 HTTP 同步路径 arm（load→改→save，与 wakeup-api.ts 同款交错）
  const b = svc.arm({ predicate: { kind: "notification_pending", minCount: 7 }, title: "规则B", body: "b", createdBy: "t" });
  release!();
  await t1;
  ok(loadWakeupRules(dir).some((x) => x.id === b.id && x.state === "armed"), "R1 arm 落在 push-await 窗内 → 规则 B 存活（不被 tick 陈旧快照整表抹掉）");
  tick += 1;
  const r1b = await svc.tick();
  ok(r1b.fired === 1 && loadWakeupRules(dir).every((x) => x.id !== b.id || x.state === "fired"), "R1b 存活的规则 B 下一拍可达 fired（事实成立正常触发）");
  rmSync(dir, { recursive: true, force: true });
}
{
  // R2：cancel 落在 push-await 窗内 → 不复活回 armed
  const dir = mkdtempSync(join(tmpdir(), "wakeup-race2-"));
  let tick = 2_000_000;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((res) => { release = res; });
  const svc = new WakeupService({
    dataDir: dir,
    push: async () => { await gate; },
    facts: () => FACTS,
    now: () => tick,
    report: () => {},
  });
  // 规则A 本拍 fire（撑开 push 窗）；规则X 本拍 wait（陈旧快照里是 armed——复活面）
  svc.arm({ predicate: { kind: "session_status", status: "ERROR" }, title: "规则A", body: "b", createdBy: "t" });
  const x = svc.arm({ predicate: { kind: "session_status", status: "WAITING" }, title: "规则X", body: "b", createdBy: "t", expiresInMs: 10_000_000 });
  const t = svc.tick();
  await Promise.resolve();
  const cancelled = svc.cancel(x.id); // 窗内 HTTP 同步路径 cancel
  release!();
  await t;
  ok(cancelled && loadWakeupRules(dir).find((r) => r.id === x.id)?.state === "expired", "R2 cancel 落在窗内 → 终态 expired 不复活（tick 收尾不回写 armed）");
  rmSync(dir, { recursive: true, force: true });
}

console.log("P 组 cloud-push 单元");
ok(bridgeAlertEndpoint("wss://cc.humumu.online/cloud") === "https://cc.humumu.online/alert", "P1 wss→https /alert 端点推导");
ok(bridgeAlertEndpoint("ws://10.0.0.2:8790/cloud") === "http://10.0.0.2:8790/alert", "P2 ws→http 端点推导");
ok(bridgeAlertEndpoint("http://x") === null, "P3 非云桥形态 → null");
{
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, delivered: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const r = await pushBridgeAlert({ cloudUrl: "wss://cc.humumu.online/cloud", token: "tk", to: "ph-a", title: "T", body: "B", fetchImpl: fakeFetch });
  ok(r.ok && r.delivered === true, "P4 200 回执解析 ok+delivered");
  ok(calls[0]?.url === "https://cc.humumu.online/alert" && String(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>)["authorization"]) === "Bearer tk", "P5 请求落点+Bearer 头");
  const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  ok(sent.to === "ph-a" && sent.title === "T" && sent.body === "B" && sent.level === "warn", "P6 载荷四键（level 缺省 warn）");
  const r404 = await pushBridgeAlert({
    cloudUrl: "wss://cc.humumu.online/cloud", token: "tk", to: "ph-off", title: "T", body: "B",
    fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: "target offline" }), { status: 404 })) as typeof fetch,
  });
  ok(!r404.ok && r404.status === 404 && r404.error === "target offline", "P7 404 目标离线回执解析");
  const rThrow = await pushBridgeAlert({
    cloudUrl: "wss://cc.humumu.online/cloud", token: "tk", to: "ph-x", title: "T", body: "B",
    fetchImpl: (async () => { throw new Error("boom"); }) as unknown as typeof fetch,
  });
  ok(!rThrow.ok && !rThrow.status && rThrow.error === "boom", "P8 fetch 异常不炸调用方（ok:false 承载）");
}
{
  const dir = mkdtempSync(join(tmpdir(), "wakeup-peers-"));
  const prev = process.env.CCR_PUSH_TO;
  process.env.CCR_PUSH_TO = "ph-env1,ph-env2";
  ok(JSON.stringify(pairedPhoneDevs(dir)) === JSON.stringify(["ph-env1", "ph-env2"]), "P9 env 覆盖目标优先");
  delete process.env.CCR_PUSH_TO;
  writeFileSync(join(dir, "cloud-peers.json"), JSON.stringify({
    "wb-1": { last_seen: 99 }, "ph-old": { last_seen: 1 }, "ph-new": { last_seen: 50, name: "手机" },
  }));
  ok(JSON.stringify(pairedPhoneDevs(dir)) === JSON.stringify(["ph-new", "ph-old"]), "P10 ph-* 解析按 last_seen 排序（wb-* 排除）");
  if (prev === undefined) delete process.env.CCR_PUSH_TO; else process.env.CCR_PUSH_TO = prev;
  rmSync(dir, { recursive: true, force: true });
}

console.log("H 组 HTTP 载荷校验");
{
  const good = armWakeupFromHttp({ action: "arm", title: "t", body: "b", predicate: { kind: "board_entry_status", status: "submitted", textIncludes: "DEV-1" } });
  ok(good.ok && good.rule?.predicate.kind === "board_entry_status", "H1 合法 arm 通过");
  ok(!armWakeupFromHttp({ title: "t", body: "b", predicate: { kind: "session_status", status: "RUNNING" } }).ok, "H2 会话状态词表外拒（防幽灵键永不满足）");
  ok(!armWakeupFromHttp({ title: "t", body: "b", predicate: { kind: "board_entry_status", status: "archived" } }).ok, "H3 板卡状态词表外拒");
  ok(!armWakeupFromHttp({ title: "t", body: "b", predicate: { kind: "cron" } }).ok, "H4 未知谓词 kind 拒");
  ok(!armWakeupFromHttp({ title: "t", body: "b", predicate: { kind: "notification_pending", minCount: 0 } }).ok, "H5 minCount 下界拒");
  ok(!armWakeupFromHttp({ title: "", body: "b", predicate: { kind: "session_status", status: "DONE" } }).ok, "H6 空 title 拒");
}

console.log("M 组 装配面（DEV-54 解耦锚）");
{
  const idxSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf-8");
  // 列 0 命中 = 装配闸在顶层；若被挪回 patrol 闸内会带缩进、锚即红——防「应急停
  // 巡查连带哑掉 wakeup（已 armed 规则静默死）」的意外耦合回潮。
  ok(/^if \(process\.env\.CCR_WAKEUP !== "0"\) \{$/m.test(idxSrc), "M1 wakeup 装配闸在顶层（已解耦 patrol 闸）");
}

console.log("X 组 手机端帧解析（expo bridge-alert 纯函数）");
{
  const a = parseBridgeAlert({ type: "bridge_alert", title: "⚠️ relay 无响应", body: "HTTP=000 两拍", level: "critical", ts: 1 });
  ok(!!a && a.title === "⚠️ relay 无响应" && a.level === "critical", "X1 合法帧解析");
  ok(parseBridgeAlert({ type: "relay-online" }) === null, "X2 其他帧型不误吃");
  ok(parseBridgeAlert({ type: "bridge_alert", title: "", body: "b" }) === null, "X3 空 title 拒");
  ok(parseBridgeAlert({ type: "bridge_alert", title: "t", body: "b", level: undefined })?.level === "warn", "X4 level 缺省 warn");
}

console.log("A 组 桥侧共享单源（cloud-bridge/src/alert）");
{
  const p = parseAlertPayload({ to: "ph-a", title: "  T  ", body: "B".repeat(600) });
  ok(!!p && p.title === "T" && p.body.length === 500, "A1 归一：trim + 500 截断");
  ok(parseAlertPayload({ title: "t", body: "b" }) === null, "A2 缺 to 拒");
  ok(parseAlertPayload({ to: "x".repeat(65), title: "t", body: "b" }) === null, "A3 to 超长拒");
  const f = JSON.parse(buildAlertFrame({ to: "ph-a", title: "T", body: "B", level: "warn" })) as { type?: string; ts?: number };
  ok(f.type === "bridge_alert" && typeof f.ts === "number", "A4 帧构造：type=bridge_alert + ts");
  let t = 0;
  const lim = createAlertLimiter(3, 10_000, () => t);
  ok(lim.ok("ip") && lim.ok("ip") && lim.ok("ip") && !lim.ok("ip"), "A5 突发 3 耗尽即 429 位");
  t += 20_000;
  ok(lim.ok("ip") && lim.ok("ip") && !lim.ok("ip"), "A6 回填 2（20s/10s）后再耗尽");
  ok(lim.ok("other") , "A7 分 key 独立桶");
}

console.log(`\nwakeup: ${pass} ok / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
