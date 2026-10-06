// SNAPSHOT 三出口 parity 测试（M13-1，在 018-B0 协议冻结批测试上扩容）。
// 三出口：LAN（ws-server 直连）/ phone（cloud-client 密封云快照）/ WAN（/wan 手表明文快照）。
// 覆盖四件（派单文原文「比对 LAN/phone/WAN 同字段；旧端缺字段降级；实体引用不塞全量正文；
// last_seq 缺口按 SNAPSHOT 恢复」）：
//   ① key 级字段集 parity——同一 mgr 状态下三出口真 wire 捕获（LAN 明文 ws / phone 过真桥
//      密封 / WAN 过真桥明文），序列化后 Object.keys 逐键比对；LAN↔phone 要求全等（#117
//      教训锁：任何一端加字段忘同步另一端即红）；WAN 允许为「核心集+截断标记」的 deliberate
//      极简子集（手表窄屏，resumeWan 注释备案同构恢复语义）。
//   ② 旧端缺字段降级——旧快照 fixture（缺全部新字段）可读；现捕快照剥掉全部可选字段后核心
//      仍可读；未知新键（未来字段）序列化往返无损（JS 消费端忽略未知键=语言天然行为，
//      relay 侧锁「可选字段真可选+新键不破坏既有键」）。
//   ③ 实体引用裁定断言——boards 三出口都不进快照（一板一文件按需 COMMAND_PROJECT_DETAIL，
//      types.ts :410 备案）；acceptances 是汇总引用（无 rows 全量正文）；SessionState 无内嵌
//      转录（logs 走预算装配单独通道）。
//   ④ last_seq 缺口恢复三态——缓冲内小缺口=增量补发零快照；缺口超 200 帧=replay 超阈值退
//      SNAPSHOT 全量；last_seq 落到缓冲外=直接 SNAPSHOT。LAN/phone/WAN 三路各自实证。
// 隔离：真桥（cloud-bridge 本地件）+ 临时 dataDir，端口 8798/8799，不触生产 8787。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startCloudServer } from "../../cloud-bridge/src/index.js";
import { EventBus } from "../src/event-bus.js";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { CloudClient } from "../src/cloud-client.js";
import { startServer } from "../src/ws-server.js";
import { loadOrCreateIdentity } from "../src/cloud-identity.js";
import { createPairingCodes } from "../src/pairing.js";
import { devId, generateKeyPair, seal, unseal, type SealedBox } from "../src/e2e.js";
import type { AgentCallbacks, AgentLike } from "../src/agent-adapter.js";
import type { Command, Envelope, SnapshotPayload } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "cc-deck-b0-parity-"));
const oldDataDir = process.env.CCR_DATA_DIR;
const oldCloudUrl = process.env.CCR_CLOUD_URL;
const oldCloudToken = process.env.CCR_CLOUD_TOKEN;
const oldPort = process.env.CCR_PORT;
const oldNoTitle = process.env.CCR_NO_TITLE_GEN;
const oldWatchdog = process.env.CCR_WATCHDOG_DISABLE;
const oldEmployeeDir = process.env.CCR_EMPLOYEE_CONFIG_DIR;
let pass = 0;
let fail = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    pass++;
    console.log(`PASS ${message}`);
  } else {
    fail++;
    console.error(`FAIL ${message}`);
  }
}

function fixture(name: string): string {
  return join(process.cwd(), "tests", "fixtures", name);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(every);
  }
  return fn();
}

// fake agent 工厂（test-m12-commands 同款）：COMMAND_CREATE 经它落地一个可快照会话
type SpawnRec = { prompt: string | undefined; cb: AgentCallbacks };
const makeFakeFactory =
  (created: SpawnRec[]) =>
  (cwd: string, model: string, cb: AgentCallbacks, prompt: string | undefined): AgentLike => {
    void cwd;
    void model;
    created.push({ prompt, cb });
    const a: AgentLike = {
      id: randomUUID(),
      startedAt: Date.now(),
      ended: false,
      sendMessage: () => {},
      allow: () => false,
      deny: () => false,
      answer: () => false,
      stop: async () => {
        a.ended = true;
      },
      setPermissionMode: async () => {},
    };
    return a;
  };

try {
  process.env.CCR_DATA_DIR = join(root, "data");
  process.env.CCR_CLOUD_URL = "";
  process.env.CCR_NO_TITLE_GEN = "1";
  process.env.CCR_WATCHDOG_DISABLE = "1";

  // ---------- 第 1 段（018-B0 遗产，保留）：fixture 旧快照降级 + 类型冻结 + 源码装配锁 ----------
  const oldSnapshot = JSON.parse(readFileSync(fixture("snapshot-old.json"), "utf8")) as SnapshotPayload;
  const newSnapshot = JSON.parse(readFileSync(fixture("snapshot-new.json"), "utf8")) as SnapshotPayload;
  assert(oldSnapshot.notifications === undefined, "旧快照缺少新字段仍可读取");
  assert(newSnapshot.schema_version === 1 && newSnapshot.notifications?.length === 0, "新快照包含 schema/通知字段");
  assert(newSnapshot.sessions[0]?.activity?.state === "WORKING", "新快照 activity 镜像可读取");

  const parityFiles = [
    "snapshot-parity-lan.json",
    "snapshot-parity-cloud-phone.json",
    "snapshot-parity-wan.json",
  ];
  for (const name of parityFiles) {
    const snapshot = JSON.parse(readFileSync(fixture(name), "utf8")) as SnapshotPayload;
    assert(snapshot.schema_version === 1, `${name} 携带 schema_version=1`);
    assert(Array.isArray(snapshot.models), `${name} 携带 models`);
  }

  const relayTypes = readFileSync(join(process.cwd(), "src", "types.ts"), "utf8");
  const wsSource = readFileSync(join(process.cwd(), "src", "ws-server.ts"), "utf8");
  const cloudSource = readFileSync(join(process.cwd(), "src", "cloud-client.ts"), "utf8");
  assert(relayTypes.includes('"SESSION_ACTIVITY"') && relayTypes.includes('"NOTIFICATIONS_UPDATED"'), "relay EventType 已冻结");
  assert(relayTypes.includes('"COMMAND_ORG_ACTION"') && relayTypes.includes('"COMMAND_ARTIFACT_GROUP_FETCH"'), "relay 新命令类型已冻结");
  assert(/schema_version:\s*SNAPSHOT_SCHEMA_VERSION/.test(wsSource), "LAN 快照装配 schema_version");
  assert(wsSource.includes('error: "unsupported command"'), "LAN 未知命令返回统一错误 ACK");
  assert((cloudSource.match(/schema_version:\s*SNAPSHOT_SCHEMA_VERSION/g) ?? []).length === 2, "cloud phone/WAN 快照装配 schema_version");
  assert(/models:\s*listModels\(mgr\.cfg\.model\)/.test(wsSource), "LAN 快照装配 models");
  assert((cloudSource.match(/models:\s*listModels\(this\.mgr\.cfg\.model\)/g) ?? []).length === 2, "cloud phone/WAN 快照装配 models");

  const unknownEvent = JSON.parse(readFileSync(fixture("event-unknown.json"), "utf8")) as { type?: string };
  let ignored = true;
  switch (unknownEvent.type) {
    case "SESSION_ACTIVITY":
    case "NOTIFICATIONS_UPDATED":
      ignored = false;
      break;
    default:
      break;
  }
  assert(ignored, "旧端对未知 EventType 安全忽略");

  const cfg = loadConfig();
  const manager = new SessionManager(new EventBus(), cfg);
  const unknownCommand = JSON.parse(readFileSync(fixture("command-new-to-old.json"), "utf8")) as Command;
  const ack = manager.handleCommand(unknownCommand, "b0-test");
  assert(ack.command_id === "cmd-old-relay" && ack.ok === false && ack.error === "unsupported command", "未知命令返回统一错误 ACK");
  assert(existsSync(join(root, "data")), "测试数据目录隔离于临时目录");

  // ---------- 第 2 段（M13-1）：三出口 wire 级真捕获 + parity ----------
  const BRIDGE_PORT = 8798; // 假真桥（cloud-bridge 本地件）
  const RELAY_PORT = 8799; // LAN 出口（远隔生产 8787）
  const RELAY_NAME = "parity-relay";
  const LAN_HINT = `127.0.0.1:${RELAY_PORT}`;
  const m13Dir = mkdtempSync(join(tmpdir(), "cc-deck-m13-snap-"));
  process.env.CCR_DATA_DIR = m13Dir;
  process.env.CCR_CLOUD_URL = `ws://127.0.0.1:${BRIDGE_PORT}/cloud`;
  process.env.CCR_CLOUD_TOKEN = "m13-token";
  process.env.CCR_PORT = String(RELAY_PORT);
  delete process.env.CCR_EMPLOYEE_CONFIG_DIR;

  const bridge = startCloudServer(BRIDGE_PORT, "m13-token");
  const cfg2 = loadConfig();
  const bus2 = new EventBus();
  const mgr2 = new SessionManager(bus2, cfg2);
  const identity = loadOrCreateIdentity(m13Dir);
  mgr2.setCloud(identity);
  const pairCodes = createPairingCodes();
  mgr2.setPairIssuer((o) => pairCodes.issue(o));
  // LAN 出口：opts 镜像 index.ts 生产接线（cloud 启用时 relay_dev/wan_dev 随快照下发）
  const srv = await startServer(bus2, mgr2, cfg2, {
    cloudRelayDev: () => identity.relayDev,
    cloudWanDev: () => identity.wanDev,
    relayName: () => RELAY_NAME,
    lanHint: () => LAN_HINT,
  });
  assert(srv.port === RELAY_PORT, `LAN 出口绑定测试端口 ${RELAY_PORT}（远隔生产 8787）`);
  // 云出口：extra 镜像 index.ts（lan_hint/relay_name 与 LAN 同源函数，#117 同步口径）
  const cloud = new CloudClient(bus2, mgr2, cfg2, identity, pairCodes, undefined, {
    lanHint: () => LAN_HINT,
    relayName: () => RELAY_NAME,
  });
  cloud.start();
  await wait(300);

  // 种子态：一个真会话（fake factory 经 COMMAND_CREATE）+ 两条日志 + 一张验收单，
  // 三出口各自从这同一 mgr 状态出快照——值 parity 才有实质
  const created: SpawnRec[] = [];
  mgr2.setAgentFactory(makeFakeFactory(created));
  const createAck = mgr2.handleCommand(
    { command_id: "m13-create", type: "COMMAND_CREATE", payload: { cwd: m13Dir, prompt: "M13 parity 种子会话" }, ts: Date.now() },
    "web-m13",
  ) as { ok: boolean };
  assert(createAck.ok === true && created.length === 1, "COMMAND_CREATE 经 fake factory 落一个种子会话");
  const sid = mgr2.snapshot()[0]!.session_id;
  mgr2.pushExternalLog(sid, "user_message", "seed-hello");
  mgr2.pushExternalLog(sid, "assistant_text", "seed-world");
  mkdirSync(join(m13Dir, "acceptances"));
  const accId = randomUUID().replaceAll("-", "");
  writeFileSync(
    join(m13Dir, "acceptances", `${accId}.json`),
    JSON.stringify({ id: accId, title: "M13 parity 验收单", created_at: Date.now(), cwd: m13Dir, rows: [{ task: "M13-1", item: "三出口 parity", criteria: "字段集 diff 空" }] }),
  );

  // LAN 捕获：?last_seq=N 连接，收满 expect 帧或 2.5s 兜底
  function lanCapture(lastSeq: number, expect: number): Promise<{ frames: Envelope[]; snap?: SnapshotPayload }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws?token=${encodeURIComponent(cfg2.token)}&last_seq=${lastSeq}`);
      const frames: Envelope[] = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          ws.close();
        } catch {}
        resolve({ frames, snap: frames.find((f) => f.type === "SNAPSHOT")?.payload as SnapshotPayload | undefined });
      };
      ws.on("message", (raw) => {
        frames.push(JSON.parse(String(raw)) as Envelope);
        if (frames.length >= expect) setTimeout(finish, 50);
      });
      // 连接失败也要落袋（否则 open 永不触发、Promise 永悬挂）
      ws.on("error", () => setTimeout(finish, 100));
      ws.on("open", () => setTimeout(finish, 2500));
    });
  }

  // phone 捕获：配对 → 连真桥 → 密封 hello → 解密封收快照
  const phoneKp = generateKeyPair();
  const phoneDev = devId(phoneKp.publicKey, "ph");
  const pairAck = mgr2.handleCommand(
    { command_id: "m13-pair", type: "COMMAND_PAIR_START", payload: { pubkey: phoneKp.publicKey, name: "parity手机" }, ts: Date.now() },
    "web-m13",
  ) as { ok: boolean; cloud?: { relay_dev: string; relay_pubkey: string } };
  assert(pairAck.ok === true && !!pairAck.cloud, "手机配对成功并携带 relay 公钥");
  const relayPub = pairAck.cloud!.relay_pubkey;
  const phoneWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=m13-token&dev=${phoneDev}`);
  const phoneInbox: Envelope[] = [];
  phoneWs.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as { data?: SealedBox };
    if (f.data) {
      const inner = unseal<Envelope>(f.data, relayPub, phoneKp.secretKey);
      if (inner) phoneInbox.push(inner);
    }
  });
  phoneWs.on("error", () => undefined);
  await new Promise<void>((r) => phoneWs.on("open", r));
  const phoneSend = (obj: unknown) => phoneWs.send(JSON.stringify({ to: identity.relayDev, data: seal(obj, relayPub, phoneKp.secretKey) }));

  // WAN 捕获：手表凭据 dev（wt-+hash）明文透传，零密码学
  const watchWs = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/cloud?token=m13-token&dev=${identity.wanDev}`);
  const wanInbox: Envelope[] = [];
  watchWs.on("message", (raw) => {
    const f = JSON.parse(String(raw)) as { data?: { frame?: string } };
    if (f.data?.frame) wanInbox.push(JSON.parse(f.data.frame) as Envelope);
  });
  watchWs.on("error", () => undefined);
  await new Promise<void>((r) => watchWs.on("open", r));
  const wanSend = (obj: unknown) => watchWs.send(JSON.stringify({ to: identity.relayDev, data: { t: "wan", frame: JSON.stringify(obj) } }));
  const snapshotCount = (arr: Envelope[]) => arr.filter((m) => m.type === "SNAPSHOT").length;

  // ① 同一 mgr 状态，三出口各捕一份
  const lan1 = await lanCapture(0, 1);
  assert(!!lan1.snap, "LAN 出口 last_seq=0 收到 SNAPSHOT");
  phoneSend({ t: "hello", last_seq: 0 });
  assert(await waitFor(() => snapshotCount(phoneInbox) >= 1), "phone 出口 hello 后收到密封 SNAPSHOT");
  wanSend({ t: "hello", last_seq: 0 });
  assert(await waitFor(() => snapshotCount(wanInbox) >= 1), "WAN 出口 hello 后收到明文 SNAPSHOT");
  const lanP = lan1.snap!;
  const phoneP = phoneInbox.find((m) => m.type === "SNAPSHOT")!.payload as SnapshotPayload;
  const wanP = wanInbox.find((m) => m.type === "SNAPSHOT")!.payload as SnapshotPayload;

  // ② schema_version 一致（常量同源，wire 级复核）
  assert(lanP.schema_version === 1 && phoneP.schema_version === 1 && wanP.schema_version === 1, "三出口 schema_version 同值（=1）");

  // ③ key 级字段集 parity（本单核心断言）
  const CORE = ["logs", "models", "schema_version", "server_time", "sessions"];
  assert(CORE.every((k) => k in lanP) && CORE.every((k) => k in phoneP) && CORE.every((k) => k in wanP), "三出口核心五字段齐（sessions/logs/server_time/schema_version/models）");
  const keySet = (p: SnapshotPayload) => Object.keys(p).sort();
  const lanK = keySet(lanP);
  const phoneK = keySet(phoneP);
  const wanK = keySet(wanP);
  const diff = (a: string[], b: string[]) => a.filter((k) => !b.includes(k)).concat(b.filter((k) => !a.includes(k)));
  assert(lanK.length === phoneK.length && lanK.every((k, i) => k === phoneK[i]), `LAN↔phone 字段集逐键全等（#117 锁）diff=[${diff(lanK, phoneK).join(",")}]`);
  assert(wanK.every((k) => CORE.includes(k) || k === "logs_truncated"), `WAN ⊆ 核心+截断标记（手表 deliberate 极简集）实际=[${wanK.join(",")}]`);

  // ④ 值 parity：同 mgr 状态 → sessions/logs/models 三出口深等（快照间零事件，seq 也应同源）
  const lanSeq = lan1.frames.find((f) => f.type === "SNAPSHOT")!.seq;
  const phoneSeq = phoneInbox.find((m) => m.type === "SNAPSHOT")!.seq;
  const wanSeq = wanInbox.find((m) => m.type === "SNAPSHOT")!.seq;
  assert(lanSeq === phoneSeq && phoneSeq === wanSeq, `三出口快照 seq 同源（=${lanSeq}）`);
  assert(JSON.stringify(lanP.sessions) === JSON.stringify(phoneP.sessions) && JSON.stringify(phoneP.sessions) === JSON.stringify(wanP.sessions), "sessions 三出口深等");
  assert(JSON.stringify(lanP.logs) === JSON.stringify(phoneP.logs) && JSON.stringify(phoneP.logs) === JSON.stringify(wanP.logs), "logs 三出口深等（同一预算装配）");
  assert(JSON.stringify(lanP.models) === JSON.stringify(phoneP.models) && JSON.stringify(phoneP.models) === JSON.stringify(wanP.models), "models 三出口深等");
  assert(lanP.acceptances?.some((a) => a.id === accId) === true && phoneP.acceptances?.some((a) => a.id === accId) === true, "种子验收单 LAN/phone 同步携带（#117 同步面）");
  assert(lanP.relay_dev === identity.relayDev && phoneP.relay_dev === identity.relayDev, "relay_dev 双出口同源（LAN 经 opts 回调 / phone 经 identity）");
  // M13-2 v2 投影信号字段：LAN/phone 同发（#117），WAN 手表极简集不带
  assert(lanP.source_capabilities?.projection_v2 === true && phoneP.source_capabilities?.projection_v2 === true, "source_capabilities.projection_v2 双出口同发（v2 投影信号定案）");
  assert(!("source_capabilities" in wanP), "WAN 极简集不带 source_capabilities（手表无投影消费）");
  // #75 引擎目录：LAN/phone 双出口同发同源（#117 纪律——两处 inline 组装漂移即红）；
  // WAN 随 source_capabilities 整体不带（上一断言已锁，不另设）
  const lanCat = lanP.source_capabilities?.engine_catalog;
  const phoneCat = phoneP.source_capabilities?.engine_catalog;
  assert(Array.isArray(lanCat) && Array.isArray(phoneCat) && JSON.stringify(lanCat) === JSON.stringify(phoneCat), "#75 engine_catalog 双出口深等（同参 engineCatalogSummary 组装）");
  assert(Array.isArray(lanCat) && lanCat.length === 6 && JSON.stringify(lanCat.map((e: { id: string }) => e.id)) === JSON.stringify(["claude", "codex", "trae", "qwen-code", "codebuddy", "zcode"]), "#75 engine_catalog 六枚举全覆盖 id 序（真快照链路锚）");
  const cl0 = (lanCat as { id: string; state: string; capabilities: { resume: boolean; approval: boolean } }[] | undefined)?.find((e) => e.id === "claude");
  assert(cl0?.state === "ready" && cl0.capabilities.resume === true && cl0.capabilities.approval === true, "#75 claude 条目真快照投影 ready+resume/approval 真（非空壳）");

  // ⑤ 实体引用裁定断言：板不随快照；汇总引用不带全量正文；转录走预算装配
  assert(!("boards" in lanP) && !("boards" in phoneP) && !("boards" in wanP), "三出口零 boards 键（板不随快照，按需 COMMAND_PROJECT_DETAIL）");
  const accRow = lanP.acceptances![0]!;
  assert(Object.keys(accRow).every((k) => ["created_at", "done", "id", "judged", "key", "submitted", "title", "total"].includes(k)), "acceptances 是汇总引用（无 rows 全量正文）");
  assert(!("logs" in (lanP.sessions[0] as object)), "SessionState 无内嵌转录（logs 走预算装配独立通道）");

  // ⑥ 旧端缺字段降级：剥掉全部可选字段后核心仍可读；未来未知键往返无损
  const stripped = { ...phoneP } as Record<string, unknown>;
  for (const k of Object.keys(stripped)) if (!CORE.includes(k)) delete stripped[k];
  const strippedBack = JSON.parse(JSON.stringify(stripped)) as SnapshotPayload;
  assert(
    Array.isArray(strippedBack.sessions) && typeof strippedBack.logs === "object" && Object.keys(strippedBack.logs).length > 0 && typeof strippedBack.server_time === "number",
    "剥到核心五字段的旧形态快照仍可读（旧端降级面；logs 是按会话键的 Record）",
  );
  const forward = JSON.parse(JSON.stringify({ ...lanP, brand_new_future_field: { deep: [1, 2] } })) as SnapshotPayload;
  assert("brand_new_future_field" in (forward as object) && Array.isArray(forward.sessions) && forward.schema_version === 1, "未来未知键序列化往返无损、既有键不受损（端侧忽略=语言天然）");

  // ⑦ last_seq 缺口恢复三态（LAN 实证 + phone/WAN 缓冲外实证）
  const L0 = bus2.lastSeq();
  for (let i = 0; i < 3; i++) bus2.emit(sid, "SESSION_LOG", { kind: "system", text: `gap-${i}` });
  const replay3 = await lanCapture(L0, 3);
  assert(replay3.frames.length === 3 && !replay3.snap, `LAN 缓冲内小缺口=增量补发（${replay3.frames.length} 帧，零快照）`);
  for (let i = 0; i < 600; i++) bus2.emit(sid, "SESSION_LOG", { kind: "system", text: `flood-${i}` });
  const lanBig = await lanCapture(L0, 1);
  assert(!!lanBig.snap, "LAN 缺口超 200 帧=replay 超阈值退 SNAPSHOT 全量");
  const lanBeyond = await lanCapture(1, 1);
  assert(!!lanBeyond.snap, "LAN last_seq 落缓冲外=直接 SNAPSHOT 重建");
  const phoneSnapBase = snapshotCount(phoneInbox);
  phoneSend({ t: "hello", last_seq: 1 });
  assert(await waitFor(() => snapshotCount(phoneInbox) > phoneSnapBase), "phone last_seq 落缓冲外=SNAPSHOT 全量恢复（#408 预算单帧）");
  const wanSnapBase = snapshotCount(wanInbox);
  wanSend({ t: "hello", last_seq: 1 });
  assert(await waitFor(() => snapshotCount(wanInbox) > wanSnapBase), "WAN last_seq 落缓冲外=SNAPSHOT 全量恢复（与 resumePhone 同构）");

  // ⑧ logs_truncated 条件键两态 + 预算装配语义（#408：日志不全量内联）
  assert(!("logs_truncated" in lanP), "小态快照零截断=logs_truncated 条件键缺席（字段存在性=能力信号口径）");
  for (let i = 0; i < 60; i++) mgr2.pushExternalLog(sid, "system", `trunc-${i}`);
  const lanTrunc = await lanCapture(1, 1);
  const truncId = sid;
  const truncLogs = lanTrunc.snap?.logs[truncId]?.length ?? 0;
  const truncMark = lanTrunc.snap?.logs_truncated?.[truncId] ?? 0;
  assert(truncLogs > 0 && truncLogs <= 50 && truncMark > 0, `预算装配实证：单会话帽 50（实 ${truncLogs}）+截断标记 ${truncMark}`);
  const phoneSnapBase2 = snapshotCount(phoneInbox);
  phoneSend({ t: "hello", last_seq: 1 });
  assert(await waitFor(() => snapshotCount(phoneInbox) > phoneSnapBase2), "phone 再次快照（截断态）");
  const phoneTrunc = phoneInbox.filter((m) => m.type === "SNAPSHOT").at(-1)!.payload as SnapshotPayload;
  assert(
    JSON.stringify(lanTrunc.snap?.logs) === JSON.stringify(phoneTrunc.logs) &&
      JSON.stringify(lanTrunc.snap?.logs_truncated) === JSON.stringify(phoneTrunc.logs_truncated),
    "截断态 logs/logs_truncated LAN↔phone 深等（同一预算装配两端同步）",
  );

  // 收尾
  phoneWs.close();
  watchWs.close();
  cloud.close();
  await srv.close();
  await bridge.close();
  rmSync(m13Dir, { recursive: true, force: true });
} finally {
  if (oldDataDir === undefined) delete process.env.CCR_DATA_DIR;
  else process.env.CCR_DATA_DIR = oldDataDir;
  if (oldCloudUrl === undefined) delete process.env.CCR_CLOUD_URL;
  else process.env.CCR_CLOUD_URL = oldCloudUrl;
  if (oldCloudToken === undefined) delete process.env.CCR_CLOUD_TOKEN;
  else process.env.CCR_CLOUD_TOKEN = oldCloudToken;
  if (oldPort === undefined) delete process.env.CCR_PORT;
  else process.env.CCR_PORT = oldPort;
  if (oldNoTitle === undefined) delete process.env.CCR_NO_TITLE_GEN;
  else process.env.CCR_NO_TITLE_GEN = oldNoTitle;
  if (oldWatchdog === undefined) delete process.env.CCR_WATCHDOG_DISABLE;
  else process.env.CCR_WATCHDOG_DISABLE = oldWatchdog;
  if (oldEmployeeDir === undefined) delete process.env.CCR_EMPLOYEE_CONFIG_DIR;
  else process.env.CCR_EMPLOYEE_CONFIG_DIR = oldEmployeeDir;
  rmSync(root, { recursive: true, force: true });
}

console.log(`B0+M13 snapshot parity: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
// cloud-client 重连 timer / ws 心跳会挂住事件循环——显式退出（测试完即清）
process.exit(0);
