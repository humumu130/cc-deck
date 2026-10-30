// relfix-s S4 uncertain 三分 e2e（multica MUL-4257 语义落地件）。
// 覆盖（验收点 4）：
//   失败分类：unsupported 命令 → 明确失败 ack（ok:false）——客户端换新 command_id 重试安全
//   成功未知不重放：同 command_id 重发 → duplicate:true 回放首回执 + 不重执行（会话数不动）
//   不确定入队待确认：ack 投递失败（sendSealed 拦截模拟桥断窄窗）→ pendingAcks 入队 →
//        手机 hello 恢复链 flush 重投确认 → 队清；同 id 再发仍 duplicate（双保险）
//   ws-server 面：LAN 直连重连后同 id 重发 → duplicate:true + 不重执行
// harness：真桥（cloud-bridge）+ CloudClient + 假手机（tweetnacl），test-cloud 同款。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startCloudServer } from "../../cloud-bridge/src/index.js";
import { loadConfig } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { SessionManager } from "../src/session-manager.js";
import { CloudClient } from "../src/cloud-client.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { createPairingCodes } from "../src/pairing.js";
import { devId, generateKeyPair, seal, unseal, type SealedBox } from "../src/e2e.js";
import type { CommandAckPayload, Envelope } from "../src/types.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(every); }
  return fn();
}

// 假 agent 工厂（COMMAND_CREATE 的 spawn 落点；回合不自动收口——本套件只测命令面）
const makeFakeFactory = () =>
  (_cwd: string, model: string, cb: AgentCallbacks, _prompt: string | undefined): AgentLike => {
    const a: AgentLike = {
      id: randomUUID(), startedAt: Date.now(), ended: false,
      sendMessage: () => {}, allow: () => false, deny: () => false, answer: () => false,
      stop: async () => { a.ended = true; cb.onSessionEnd("stopped"); },
      setPermissionMode: async () => {},
    };
    setTimeout(() => { if (!a.ended) cb.onInit("s4-" + a.id.slice(0, 8), model, "default"); }, 20);
    return a;
  };

// ---------- 环境 ----------
const BRIDGE_PORT = 8795;
const RELAY_PORT = 8796;
const BRIDGE_TOKEN = "s4-bridge-token";
const dataDir = mkdtempSync(join(tmpdir(), "cc-s4-test-"));
const oldCwd = process.cwd();
process.chdir(dataDir);
process.env.CCR_DATA_DIR = dataDir;
delete process.env.CC_DECK_PLUGIN;
delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
process.env.CCR_CLOUD_URL = `ws://127.0.0.1:${BRIDGE_PORT}/cloud`;
process.env.CCR_CLOUD_TOKEN = BRIDGE_TOKEN;
process.env.CCR_NO_TITLE_GEN = "1";
process.env.CCR_PORT = String(RELAY_PORT);
// 孤儿扫描隔离（test-ws 同款教训：防扫到真实 ~/.claude/projects）
process.env.CCR_PROJECTS_ROOT = join(dataDir, "test-projects/");

const bridge = startCloudServer(BRIDGE_PORT, BRIDGE_TOKEN);
const cfg = loadConfig();
const bus = new EventBus({ persistPath: join(dataDir, "events.ndjson") });
const mgr = new SessionManager(bus, cfg);
mgr.setAgentFactory(makeFakeFactory());
const identity = loadOrCreateIdentity(cfg.dataDir);
const pairCodes = createPairingCodes();
const cloud = new CloudClient(bus, mgr, cfg, identity, pairCodes);
mgr.setCloud(identity);
mgr.setPairIssuer((o) => pairCodes.issue(o));
mgr.setLoginGranter((dev, pk, name) => { cloud.grantLogin(dev, pk, name); return true; });
mgr.setPeerKicker((dev) => { identity.removePeer(dev); cloud.kickPeer(dev); });
mgr.setImportPusher((dev, pk, payload) => cloud.pushImportTo(dev, pk, payload));
cloud.start();
await wait(300);

// ---------- 1) 配对（LAN 面直调）+ 假手机连桥 ----------
const phoneKp = generateKeyPair();
const phoneDev = devId(phoneKp.publicKey, "ph");
const pairAck = mgr.handleCommand(
  { command_id: "s4-pair", type: "COMMAND_PAIR_START", payload: { pubkey: phoneKp.publicKey, name: "S4 手机" }, ts: Date.now() },
  "web-test",
) as CommandAckPayload;
assert(pairAck.ok === true && !!pairAck.cloud, "配对成功");
const relayPubkey = pairAck.cloud!.relay_pubkey;

const phoneWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=${BRIDGE_TOKEN}&dev=${phoneDev}`);
const inbox: Record<string, unknown>[] = [];
phoneWs.on("message", (raw) => {
  const f = JSON.parse(String(raw)) as { data?: SealedBox };
  if (f.data) {
    const inner = unseal<Record<string, unknown>>(f.data, relayPubkey, phoneKp.secretKey);
    if (inner) inbox.push(inner);
  }
});
phoneWs.on("error", () => undefined);
await new Promise<void>((r) => phoneWs.on("open", r));
const sendSealed = (obj: unknown) =>
  phoneWs.send(JSON.stringify({ to: identity.relayDev, data: seal(obj, relayPubkey, phoneKp.secretKey) }));
// 取该 command_id 的**末个** ack（同 id 重发场景首个是原回执、末个才是幂等重放）
const ackOf = (id: string) => {
  const hits = inbox.filter((m) => m.type === "COMMAND_ACK" && m.command_id === id) as (CommandAckPayload & { duplicate?: boolean })[];
  return hits[hits.length - 1];
};
const sessionCount = () => mgr.snapshot().length;

sendSealed({ t: "hello", last_seq: 0 });
assert(await waitFor(() => inbox.some((m) => m.type === "SNAPSHOT"), 15_000), "hello → SNAPSHOT（前置）");

// ---------- 2) 失败分类：明确失败 + 换新 id 重试安全 ----------
console.log("失败分类（明确失败→换新 id 可重试）:");
sendSealed({ command_id: "s4-bad", type: "COMMAND_WAT", payload: { x: 1 }, ts: Date.now() });
assert(await waitFor(() => ackOf("s4-bad")?.ok === false), "unsupported 命令 → 明确失败 ack（ok:false）");
const before0 = sessionCount();
sendSealed({ command_id: "s4-ok1", type: "COMMAND_CREATE", payload: { cwd: dataDir, prompt: "S4 失败后重试单" }, ts: Date.now() });
assert(await waitFor(() => ackOf("s4-ok1")?.ok === true), "失败后换新 command_id 重试 → 执行成功（失败可重试面）");
assert(await waitFor(() => sessionCount() === before0 + 1), "重试建会话到位（写真实执行）");

// ---------- 3) 成功未知不重放（同 command_id 重发 → 幂等重放，不重执行） ----------
console.log("成功未知不重放（幂等重放首回执）:");
const before1 = sessionCount();
sendSealed({ command_id: "s4-ok1", type: "COMMAND_CREATE", payload: { cwd: dataDir, prompt: "同 id 重发（不应再建）" }, ts: Date.now() });
assert(await waitFor(() => ackOf("s4-ok1")?.duplicate === true), "同 id 重发 → duplicate:true（回放首回执）");
assert(ackOf("s4-ok1")?.ok === true, "重放回执保持首次原样（ok 不变）");
await wait(150);
assert(sessionCount() === before1, "不重执行（会话数不动——成功未知绝不双写）");

// ---------- 4) 不确定入队待确认（ack 投递失败 → 入队 → hello 恢复链重投） ----------
console.log("不确定入队待确认:");
const cloudHack = cloud as unknown as {
  sendSealed: (dev: string, obj: unknown) => boolean;
  pendingAcks: Map<string, { dev: string; ack: CommandAckPayload }>;
};
const origSendSealed = cloudHack.sendSealed.bind(cloud);
// 模拟「命令已入、回执未出」的桥断窄窗：拦截 COMMAND_ACK 明文的 sendSealed 返回 false
cloudHack.sendSealed = (dev: string, obj: unknown) =>
  (obj as { type?: string } | null)?.type === "COMMAND_ACK" ? false : origSendSealed(dev, obj);
const before2 = sessionCount();
sendSealed({ command_id: "s4-unc", type: "COMMAND_CREATE", payload: { cwd: dataDir, prompt: "uncertain 单" }, ts: Date.now() });
assert(await waitFor(() => sessionCount() === before2 + 1), "写已执行（会话建立——服务侧成功）");
assert(await waitFor(() => cloudHack.pendingAcks.has("s4-unc")), "回执未达 → pendingAcks 入队待确认（uncertain 分类）");
await wait(300);
assert(ackOf("s4-unc") === undefined, "手机侧确实未收到回执（成功未知状态）");
// 恢复：解除拦截 + hello（resumePhone → flushUncertainAcks 重投）
cloudHack.sendSealed = origSendSealed;
sendSealed({ t: "hello", last_seq: 0 });
assert(await waitFor(() => ackOf("s4-unc")?.ok === true), "hello 恢复链 → 待确认回执重投送达");
assert(!cloudHack.pendingAcks.has("s4-unc"), "重投确认后出队（队清）");
// 双保险：恢复窗内客户端同 id 超时重发也只拿幂等重放
const before3 = sessionCount();
sendSealed({ command_id: "s4-unc", type: "COMMAND_CREATE", payload: { cwd: dataDir, prompt: "恢复窗重发" }, ts: Date.now() });
assert(await waitFor(() => {
  const acks = inbox.filter((m) => m.type === "COMMAND_ACK" && m.command_id === "s4-unc");
  return acks.some((a) => (a as CommandAckPayload & { duplicate?: boolean }).duplicate === true);
}), "同 id 重发在重投之后仍 duplicate:true（无双重执行面）");
await wait(150);
assert(sessionCount() === before3, "重投+重发并存 → 会话数不动（MUL-4257 防双执行）");

// ---------- 5) ws-server 面：LAN 直连 readyState 守卫 + 幂等重放 ----------
console.log("ws-server 回执路径:");
const { startServer } = await import("../src/ws-server.js");
const server = startServer(bus, mgr, cfg);
await wait(200);
const lanUrl = `ws://127.0.0.1:${cfg.port}/ws?token=${cfg.token}`;
const lanSend = (id: string, prompt: string) => new Promise<Record<string, unknown> | null>((resolve) => {
  const c = new WebSocket(lanUrl);
  c.on("error", () => resolve(null));
  c.on("open", () => {
    c.send(JSON.stringify({ command_id: id, type: "COMMAND_CREATE", payload: { cwd: dataDir, prompt }, ts: Date.now() }));
  });
  c.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    if (m.type === "COMMAND_ACK" && m.command_id === id) { resolve(m); setTimeout(() => c.close(), 50); }
  });
  setTimeout(() => { try { c.close(); } catch { /* 已关 */ } resolve(null); }, 5000);
});
const before4 = sessionCount();
const ackW1 = await lanSend("s4-w1", "LAN 直连写");
assert(ackW1?.ok === true, "LAN 命令 → 回执正常往返（成功分类）");
assert(await waitFor(() => sessionCount() === before4 + 1), "LAN 写执行到位");
// 客户端断线重连后同 id 重发（ack 丢失形态）：幂等重放，不重执行
const ackW2 = await lanSend("s4-w1", "LAN 同 id 重发");
assert(ackW2?.ok === true && ackW2?.duplicate === true, "重连同 id 重发 → duplicate:true（uncertain 不重放）");
await wait(150);
assert(sessionCount() === before4 + 1, "LAN 面会话数不动（成功未知不双写）");

// ---------- 清理 ----------
phoneWs.close();
cloud.close();
await bridge.close();
// server.close 等全部连接断开才回调——测试面 ws 客户端已 close 但 keep-alive 兜底
// 可能悬挂，限时 2s 强制走人
await Promise.race([new Promise<void>((r) => { server.close(() => r()); }), wait(2000).then(() => undefined)]);
process.chdir(oldCwd);
rmSync(dataDir, { recursive: true, force: true });
console.log(`\nS4 结果: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
